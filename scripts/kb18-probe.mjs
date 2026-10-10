#!/usr/bin/env node
// KB-18 continuous-control admission probe against a RUNNING bridge (plugin 0.14.0 or newer with the
// gma3_mcp_control module; see ENCODERS.md "KB-18", docs/modules.md "Continuous-control admission").
//
//   node scripts/kb18-probe.mjs verify [--out report.json]   read-only: nothing is queued or applied
//   node scripts/kb18-probe.mjs run    [--out report.json]   verify + admitted events on a DISPOSABLE show
//                                                           with control=fake enabled (the fake backend
//                                                           records intents; nothing moves on the console)
//
// `verify` exercises the control.* ops over a real TCP connection: control.status, the ping summary,
// control.bind against the current executor page, and refusals that queue nothing: a malformed event, a
// stale generation, a slot without a selection, an executor outside the binding, and [control-disabled]
// while the operator has not enabled control. `run` needs a show whose name matches "disposable",
// "mcp-test" or "scratch" and `Plugin "gma3_mcp_bridge" "control=fake"` (an operator decision this
// probe never makes): it selects a fixture (undo registered first), binds, and checks a coalesced burst,
// duplicates, loss reporting, out-of-order refusal, the [busy] guard on `cmd` from a second connection
// while a touch is down, a conflict between connections, a selection change moving the generation (an
// event with the old generation refused, queued motion dropped), and a disconnect ending a button
// through the backend. Every change registers its undo before dispatch; the cleanup runs them all.
// GMA3_BRIDGE_HOST / GMA3_BRIDGE_PORT select the bridge.
import net from "node:net";
import fs from "node:fs";
import { createCleanup } from "./lib/kb16-steps.mjs";

const host = process.env.GMA3_BRIDGE_HOST ?? "127.0.0.1";
const port = Number(process.env.GMA3_BRIDGE_PORT ?? 9800);
const argv = process.argv.slice(2);
const mode = argv[0];
const outIdx = argv.indexOf("--out");
const outFile = outIdx >= 0 ? argv[outIdx + 1] : null;
const SHOW_GUARD = /disposable|mcp-test|scratch/i;
const RGB_FIXTURE = Number(process.env.KB18_RGB_FIXTURE ?? 401);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Conn {
  constructor(name) { this.name = name; this.seq = 0; this.pending = new Map(); this.buf = ""; this.sock = null; }
  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.connect(port, host, () => resolve());
      sock.setEncoding("utf8");
      sock.setNoDelay(true);
      sock.on("data", (d) => {
        this.buf += d;
        let i;
        while ((i = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          let m;
          try { m = JSON.parse(line); } catch { continue; }
          const p = this.pending.get(m.id);
          if (!p) continue;
          this.pending.delete(m.id);
          clearTimeout(p.timer);
          if (m.ok) p.resolve({ ok: true, result: m.result });
          else p.resolve({ ok: false, error: typeof m.error === "string" ? m.error : JSON.stringify(m.error), code: m.code, detail: m.detail });
        }
      });
      sock.on("error", (e) => { reject(e); for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve({ ok: false, error: String(e) }); } this.pending.clear(); });
      sock.on("close", () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve({ ok: false, error: "connection closed" }); } this.pending.clear(); });
      this.sock = sock;
    });
  }
  request(op, args = {}, timeoutMs = 15000) {
    const id = `${this.name}-${++this.seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, error: `timeout after ${timeoutMs} ms`, code: "timeout" }); }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.sock.write(JSON.stringify({ id, op, args }) + "\n");
    });
  }
  end() { return new Promise((r) => { if (!this.sock) return r(); this.sock.once("close", () => r()); this.sock.end(); }); }
  destroy() { if (this.sock) this.sock.destroy(); }
}

const steps = [];
let failed = 0;
function record(name, pass, detail) {
  steps.push({ name, pass: !!pass, detail });
  if (!pass) failed += 1;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail !== undefined && !pass ? ` ${JSON.stringify(detail)}` : ""}`);
}
function note(name, detail) { steps.push({ name, note: true, detail }); console.log(`NOTE ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`); }

/** Builds the per-device event sequence for a probe device. */
export function eventFactory(device, generation) {
  let seq = 0;
  return {
    relative: (slot, delta, extra = {}) => ({ type: "relative", device, control: `Rotary${slot}`, seq: ++seq, generation, target: { slot }, delta, gesture: extra.gesture ?? 1, ...extra }),
    absolute: (executor, value, extra = {}) => ({ type: "absolute", device, control: `Strip${executor}`, seq: ++seq, generation, target: { executor, element: "fader" }, value, gesture: extra.gesture ?? 1, ...extra }),
    touch: (executor, down, extra = {}) => ({ type: "touch", device, control: `Strip${executor}`, seq: ++seq, generation, target: { executor, element: "fader" }, down, gesture: extra.gesture ?? 1, ...extra }),
    button: (slot, down, extra = {}) => ({ type: "button", device, control: `Rotary${slot}`, seq: ++seq, generation, target: { slot }, down, ...extra }),
    skip: (n = 1) => { seq += n; },
    get seq() { return seq; },
  };
}

/** Summarises a control.submit result for the report. */
export function outcomesOf(r) {
  if (!r?.ok) return { error: r?.error, code: r?.code };
  return { accepted: r.result.accepted, refused: r.result.refused, lost: r.result.lost, outcomes: (r.result.outcomes ?? []).map((o) => o.refused ?? (o.coalesced ? "coalesced" : o.noop ? "noop" : o.superseded ? `superseded:${o.superseded}` : "queued")) };
}

async function main() {
  if (mode !== "verify" && mode !== "run") {
    console.error("usage: node scripts/kb18-probe.mjs verify|run [--out report.json]");
    process.exit(2);
  }
  const A = new Conn("a");
  await A.connect();
  const pingR = await A.request("ping");
  if (!pingR.ok) { console.error(`ping failed: ${pingR.error}`); process.exit(2); }
  const ping = pingR.result;
  const [maj, min] = String(ping.bridgeVersion ?? "0.0").split(".").map(Number);
  if (maj < 0 || (maj === 0 && min < 14)) { console.error(`bridge ${ping.bridgeVersion} has no control.* ops; update the plugin to 0.14.0 or newer (docs/setup/bridge.md)`); process.exit(2); }
  if (!ping.modules?.control?.loaded) { console.error(`the control module is not loaded: ${ping.modules?.control?.error ?? "no module summary"}`); process.exit(2); }
  if (!ping.modules?.feedback?.loaded) { console.error(`the feedback module is not loaded: ${ping.modules?.feedback?.error ?? "no module summary"}`); process.exit(2); }
  if (mode === "run") {
    if (!SHOW_GUARD.test(String(ping.showfile ?? ""))) { console.error(`show "${ping.showfile}" does not look disposable (expected a name matching ${SHOW_GUARD}); refusing to change state`); process.exit(2); }
    if (!ping.control?.enabled) { console.error('run needs continuous control enabled on the fake backend by the operator:  Plugin "gma3_mcp_bridge" "control=fake"'); process.exit(2); }
    if (ping.control.backend !== "fake") { console.error(`run only works on the fake backend (the bridge reports ${ping.control.backend}); nothing may move on the console in KB-18`); process.exit(2); }
    if (ping.input?.busy) { console.error(`the bridge is busy (${JSON.stringify(ping.input.busy)}); wait for the owner to finish`); process.exit(2); }
  }
  const report = { mode, host, port, startedAt: new Date().toISOString(), ping: { bridgeVersion: ping.bridgeVersion, build: ping.build, hostname: ping.hostname, showfile: ping.showfile, user: ping.user, modules: ping.modules, input: ping.input, control: ping.control, lua: { enabled: ping.lua?.enabled } }, steps };
  note("console", report.ping);

  // ---- verify: read-only, nothing queued ----
  record("ping carries the control summary (enabled, backend, sessions, queued, spec)", ping.control && typeof ping.control.enabled === "boolean" && "sessions" in ping.control && "queued" in ping.control, ping.control);
  const st0 = await A.request("control.status");
  record("control.status answers with the module version, limitations and no session for this connection", st0.ok && st0.result.version === ping.modules.control.version && Array.isArray(st0.result.limitations) && st0.result.limitations.length >= 1 && st0.result.yourSession == null, st0.ok ? { version: st0.result.version, limitations: st0.result.limitations } : st0);
  const ctx0 = await A.request("feedback.context", { allExecutors: true });
  record("feedback.context lists the executors of the current page", ctx0.ok && Array.isArray(ctx0.result.executors), ctx0.ok ? ctx0.result.executors?.length : ctx0);
  // Playback targets first (the KB-12 bank's Quickeys are never ones), at most 8 so the watch stays bounded.
  const execNumbers = ctx0.ok ? ctx0.result.executors.filter((x) => x.available && !x.value.empty).sort((a, b) => (b.value.playbackTarget ? 1 : 0) - (a.value.playbackTarget ? 1 : 0)).map((x) => x.value.executor).slice(0, 8) : [];
  const bind = await A.request("control.bind", { executors: execNumbers });
  record("control.bind watches the context and reports a generation or why none is claimed", bind.ok && bind.result.watched >= 4 && (typeof bind.result.generation === "number" || bind.result.generationUnknown === true), bind.ok ? { generation: bind.result.generation, generationUnknown: bind.result.generationUnknown, note: bind.result.generationNote, watched: bind.result.watched } : bind);
  await sleep(400);  // the loop observes the watched items (8 reads per iteration)
  const cached = await A.request("feedback.context", { executors: execNumbers, cached: true });
  record("the cached snapshot claims a generation once the loop observed every part", cached.ok && typeof cached.result.generation === "number" && cached.result.notObserved === 0, cached.ok ? { generation: cached.result.generation, notObserved: cached.result.notObserved, note: cached.result.generationNote } : cached);
  const gen = cached.ok ? cached.result.generation : undefined;
  const bad = await A.request("control.bind", { display: 0 });
  record("control.bind refuses malformed arguments [bad-args]", !bad.ok && bad.code === "bad-args", bad);
  const B = new Conn("b");
  await B.connect();
  if (!ping.control?.enabled) {
    const off = await A.request("control.submit", { events: [{ type: "relative", device: "probe", control: "Rotary1", seq: 1, generation: gen ?? 0, target: { slot: 1 }, delta: 1 }] });
    record("control.submit is [control-disabled] until the operator enables control (nothing was queued)", !off.ok && off.code === "control-disabled" && /control=fake/.test(off.error ?? ""), off);
  } else {
    const ev = eventFactory("probe-verify", gen);
    const r1 = await A.request("control.submit", { events: [{ type: "wheel", device: "probe-verify", control: "x", seq: 1 }, ev.relative(1, 1, { generation: (gen ?? 0) + 1000 }), { ...ev.relative(99, 1), target: { executor: 999999, element: "fader" }, control: "Strip999999" }] });
    record("verify: a malformed event, a stale generation and an unbound executor are refused in place; nothing is queued", r1.ok && r1.result.refused === 3 && r1.result.accepted === 0 && r1.result.outcomes[0].refused === "bad-event" && r1.result.outcomes[1].refused === "stale-generation" && r1.result.outcomes[1].generation === gen && r1.result.outcomes[2].refused === "target-unavailable", outcomesOf(r1));
    const sel = cached.ok ? cached.result.slots?.value?.selection?.count : undefined;
    const slot1 = cached.ok ? cached.result.slots?.value?.slots?.find((s) => s.slot === 1) : undefined;
    if (sel === 0 && slot1?.kind === "attribute") {
      const r2 = await A.request("control.submit", { events: [ev.relative(1, 1)] });
      record("verify: slot 1 without a selection is refused target-unavailable (no fixture is selected); nothing is queued", r2.ok && r2.result.outcomes[0].refused === "target-unavailable" && /no fixture is selected/.test(r2.result.outcomes[0].message ?? ""), outcomesOf(r2));
    } else note("verify: the selection is not empty or slot 1 holds no attribute; the no-selection refusal is not exercised", { selection: sel, slot1: slot1 && [slot1.kind, slot1.availability] });
    const st1 = await A.request("control.status");
    record("verify: the session opened on demand has nothing queued and no gesture", st1.ok && st1.result.yourSession && st1.result.sessions[st1.result.yourSession]?.queued === 0 && st1.result.sessions[st1.result.yourSession]?.gestures === 0 && st1.result.busy == null, st1.ok ? st1.result.sessions : st1);
    const close = await A.request("control.close");
    record("verify: control.close ends the session", close.ok && close.result.dropped === 0, close);
  }

  // ---- run: admitted events on the fake backend ----
  if (mode === "run") {
    const cleanup = createCleanup();
    let mutationError = null;
    const need = (r, what) => { if (!r.ok) throw new Error(`${what}: ${r.error}`); return r; };
    try {
      cleanup.add("ClearSelection", () => A.request("cmd", { command: "ClearSelection" }));
      const selR = await A.request("cmd", { command: `Fixture ${RGB_FIXTURE}` });
      await sleep(400);
      const c1 = need(await A.request("feedback.context", { executors: execNumbers, cached: true }), "feedback.context after the selection");
      const g1 = c1.ok ? c1.result.generation : undefined;
      const slot1 = c1.ok ? c1.result.slots?.value?.slots?.find((s) => s.slot === 1) : undefined;
      record(`run: Fixture ${RGB_FIXTURE} selected; the cached generation moved and slot 1 is available`, selR.ok && typeof g1 === "number" && g1 !== gen && slot1?.availability === "available", { generation: [gen, g1], slot1: slot1 && [slot1.name, slot1.availability, slot1.resolution] });
      const ev = eventFactory("probe-nxk", g1);
      const burst = Array.from({ length: 10 }, (_, i) => ev.relative(1, i % 3 === 2 ? -1 : 1));
      const b1 = await A.request("control.submit", { events: burst });
      record("run: a burst of 10 relative events on slot 1 is admitted and coalesced into one queued intent", b1.ok && b1.result.accepted === 10 && b1.result.refused === 0 && b1.result.outcomes.filter((o) => o.coalesced).length === 9 && b1.result.outcomes[9].queued === 1, outcomesOf(b1));
      const dup = await A.request("control.submit", { events: [{ ...burst[9] }] });
      record("run: a resent event (same seq) is a duplicate, never applied twice", dup.ok && dup.result.outcomes[0].refused === "duplicate", outcomesOf(dup));
      ev.skip(3);
      const gapEv = ev.relative(1, 1);
      const gap = await A.request("control.submit", { events: [gapEv] });
      record("run: a sequence gap is accepted and reported as loss (3 lost), never replayed", gap.ok && gap.result.outcomes[0].accepted && gap.result.outcomes[0].lost === 3 && gap.result.lost === 3, outcomesOf(gap));
      const old = await A.request("control.submit", { events: [{ ...gapEv, seq: gapEv.seq - 2 }] });  // inside the gap: unseen, older than the newest
      record("run: an older event after a newer one is out-of-order (dropped, not applied late)", old.ok && old.result.outcomes[0].refused === "out-of-order", outcomesOf(old));
      await sleep(250);
      const st2 = await A.request("control.status");
      const mine = st2.ok ? st2.result.sessions[st2.result.yourSession] : undefined;
      record("run: the plugin loop applied the queued intents through the fake backend (coalesced delta, loss carried)", st2.ok && mine && mine.queued === 0 && mine.counters.applied >= 1 && st2.result.lastApplied?.outcome === "applied" && st2.result.lastApplied?.kind === "relative", st2.ok ? { counters: mine?.counters, lastApplied: st2.result.lastApplied } : st2);
      // A touch on an executor fader makes the bridge busy for other writers.
      const faderExec = (c1.ok ? c1.result.executors : []).find((x) => x.available && x.value?.playbackTarget && x.value?.functions?.fader)?.value?.executor;
      if (typeof faderExec === "number") {
        cleanup.add("control.close A", () => A.request("control.close"));
        const td = await A.request("control.submit", { events: [ev.touch(faderExec, true, { gesture: 7 })] });
        record(`run: a touch down on executor ${faderExec} (fader) is admitted`, td.ok && td.result.outcomes[0].accepted, outcomesOf(td));
        const busy = await B.request("cmd", { command: "Echo kb18-probe" });
        record("run: a command from another connection is [busy] while the touch is down (the control module's gesture: touch-down or the motion just before it)", !busy.ok && busy.code === "busy" && ["touch-down", "motion"].includes(busy.detail?.reason) && busy.detail?.module === "control" && busy.detail?.owner === st2.result.yourSession, busy);
        const evB = eventFactory("probe-mtouch-b", g1);
        const conflict = await B.request("control.submit", { events: [evB.absolute(faderExec, 0.5)] });
        record("run: another connection's position for the touched target is a conflict with the owner", conflict.ok && conflict.result.outcomes[0].refused === "conflict" && conflict.result.outcomes[0].owner === st2.result.yourSession, outcomesOf(conflict));
        const pos = await A.request("control.submit", { events: [ev.absolute(faderExec, 0.2, { gesture: 7 }), ev.absolute(faderExec, 0.4, { gesture: 7 }), ev.absolute(faderExec, 0.6, { gesture: 7 })] });
        const fn = (c1.result.executors.find((x) => x.value?.executor === faderExec)?.value?.level?.token ?? "").replace(/^Fader/, "").toLowerCase();
        const stateful = ["x", "xa", "xb", "temp", "crossfade"].includes(fn);
        record(`run: three positions of the touched ${fn || "fader"} ${stateful ? "are all kept in order (stateful function)" : "supersede each other (newest kept)"}`, pos.ok && pos.result.accepted === 3 && (stateful ? pos.result.outcomes.every((o) => !o.superseded) : pos.result.outcomes[2].superseded === 2), outcomesOf(pos));
        const tu = await A.request("control.submit", { events: [ev.touch(faderExec, false, { gesture: 7 })] });
        record("run: the touch release is admitted as a boundary", tu.ok && tu.result.outcomes[0].accepted && tu.result.outcomes[0].boundary, outcomesOf(tu));
        await sleep(250);
        const free = await B.request("cmd", { command: "Echo kb18-probe" });
        record("run: after the release and the loop applying it, commands are admitted again", free.ok, free);
        await B.request("control.close");
      } else note("run: no playback-target executor with a fader function on the page; the touch/busy/conflict steps are not exercised");
      // A selection change moves the generation: events still carrying the old one are refused. (A delta queued
      // in the very iteration the change lands is dropped by the loop; the harness proves that, live the probe's
      // own motion keeps the bridge [busy] for 500 ms, so its ClearSelection has to wait for the gesture to lapse.)
      const motion = await A.request("control.submit", { events: [ev.relative(1, 1, { gesture: 11 })] });
      const early = await A.request("cmd", { command: "ClearSelection" });
      record("run: the probe's own motion makes its command [busy] (motion within gestureIdleMs); nothing fights the gesture", motion.ok && motion.result.accepted === 1 && !early.ok && early.code === "busy" && early.detail?.reason === "motion", early);
      await sleep(650);
      const clr = await A.request("cmd", { command: "ClearSelection" });
      await sleep(400);
      const c2 = need(await A.request("feedback.context", { executors: execNumbers, cached: true }), "feedback.context after ClearSelection");
      const g2 = c2.ok ? c2.result.generation : undefined;
      const st3 = await A.request("control.status");
      record("run: once the gesture lapsed ClearSelection is admitted and moves the generation; the applied motion stayed applied", clr.ok && typeof g2 === "number" && g2 !== g1 && st3.ok && st3.result.counters.applied >= 1, { generation: [g1, g2], counters: st3.ok ? st3.result.counters : st3 });
      const stale = await A.request("control.submit", { events: [ev.relative(1, 1, { gesture: 12 })] });
      record("run: an event with the old generation is refused stale-generation with the current one", stale.ok && stale.result.outcomes[0].refused === "stale-generation" && stale.result.outcomes[0].generation === g2, outcomesOf(stale));
      // A disconnect with a button down ends it through the backend.
      const sel2 = await A.request("cmd", { command: `Fixture ${RGB_FIXTURE}` });
      await sleep(400);
      const c3 = need(await A.request("feedback.context", { executors: execNumbers, cached: true }), "feedback.context after the second selection");
      const g3 = c3.ok ? c3.result.generation : undefined;
      const evC = eventFactory("probe-nxk-c", g3);
      await sleep(650);  // A's last motion on slot 1 keeps the target for gestureIdleMs
      const C = new Conn("c");
      await C.connect();
      const bd = await C.request("control.submit", { events: [evC.button(1, true)] });
      const stC = await C.request("control.status");
      const sidC = stC.ok ? stC.result.yourSession : undefined;
      record("run: a third connection's button down on slot 1 is admitted and reported as its gesture", sel2.ok && bd.ok && bd.result.outcomes[0].accepted && stC.ok && stC.result.sessions[sidC]?.gestures === 1, outcomesOf(bd));
      await sleep(150);
      C.destroy();
      await sleep(400);
      const st4 = await A.request("control.status");
      record("run: the disconnect ended the button through the backend and forgot the session (lastApplied: button up, reason disconnect)", st4.ok && !st4.result.sessions[sidC] && st4.result.lastApplied?.kind === "button" && st4.result.lastApplied?.down === false, st4.ok ? { lastApplied: st4.result.lastApplied, sessions: Object.keys(st4.result.sessions) } : st4);
    } catch (e) {
      mutationError = e;
      record("run: the mutation phase failed; running the registered undos", false, { error: String(e?.message ?? e), pending: cleanup.pending() });
    } finally {
      const outcomes = await cleanup.run();
      record("run: cleanup ran every registered undo", outcomes.every((o) => o.ok), outcomes);
    }
    await sleep(400);
    const fin = await A.request("feedback.context", { executors: execNumbers, cached: true });
    record("run: the selection is empty again", fin.ok && fin.result.slots?.value?.selection?.count === 0, fin.ok ? fin.result.slots?.value?.selection : fin);
    const stF = await A.request("control.status");
    record("run: no session, gesture or queued intent is left; nothing is unresolved", stF.ok && Object.keys(stF.result.sessions).length === 0 && stF.result.unresolved.length === 0 && stF.result.busy == null, stF.ok ? { sessions: Object.keys(stF.result.sessions), unresolved: stF.result.unresolved } : stF);
    if (mutationError) failed = Math.max(failed, 1);
  }
  await A.request("feedback.unwatch").catch(() => {});
  await B.end().catch(() => {});
  await A.end();
  report.finishedAt = new Date().toISOString();
  report.passed = steps.filter((s) => s.pass === true).length;
  report.failed = failed;
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`\n${report.passed} passed, ${failed} failed${outFile ? ` (report: ${outFile})` : ""}`);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && /kb18-probe\.mjs$/.test(process.argv[1])) main().catch((e) => { console.error(e); process.exit(1); });
