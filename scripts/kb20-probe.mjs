#!/usr/bin/env node
// KB-20 parameter-strip probe against a RUNNING bridge (plugin 0.16.0 or newer with gma3_mcp_control 0.3.0
// and gma3_mcp_feedback 0.4.0; see ENCODERS.md "KB-20", docs/modules.md "Console adjustment backend").
//
//   node scripts/kb20-probe.mjs verify [--out report.json]   read-only: nothing is queued or applied
//   node scripts/kb20-probe.mjs run    [--out report.json]   verify + strip gestures applied on the CONSOLE
//                                                           backend of a DISPOSABLE show (values move)
//
// The strip gesture itself (anchoring, re-anchoring, sensitivity, pickup) is the surface service's; what the
// console half serves is what this probe checks: a TOUCH on an attribute slot is a hold (the bridge is [busy]
// with it, the slot is the session's, nothing moves, the release is a noop boundary), the drag inside it is the
// KB-19 relative adjustment, a POSITION is Attribute "<name>" At <value> over the verified travel (Percent 0..100,
// Physical PhysicalFrom..PhysicalTo in physical units), MIXED VALUES refuse a position until the event says
// takeover (relative motion still keeps the relationship), and executor faders, presses stay refused.
// `verify` submits only refusals by construction (a touch and a position on an executor fader: unsupported; a
// touch on a slot while nothing is selected: target-unavailable). `run` needs a show whose name matches
// "disposable", "mcp-test" or "scratch", Lua enabled (programmer preflight and value reads) and
// `Plugin "gma3_mcp_bridge" "control=console"` (an operator decision this probe never makes). Every change
// registers its undo before dispatch; the cleanup runs them all and ends with ClearAll. GMA3_BRIDGE_HOST /
// GMA3_BRIDGE_PORT select the bridge; KB20_RGB_FIXTURES ("401,402"), KB20_MOVER_FIXTURE (601),
// KB20_POSITION_BANK (2) the test show's layout.
import net from "node:net";
import fs from "node:fs";
import { createCleanup, programmerEmpty } from "./lib/kb16-steps.mjs";
import { outcomesOf } from "./kb18-probe.mjs";
import { LUA_VALUE, slotSummary } from "./kb19-probe.mjs";

const host = process.env.GMA3_BRIDGE_HOST ?? "127.0.0.1";
const port = Number(process.env.GMA3_BRIDGE_PORT ?? 9800);
const argv = process.argv.slice(2);
const mode = argv[0];
const outIdx = argv.indexOf("--out");
const outFile = outIdx >= 0 ? argv[outIdx + 1] : null;
const SHOW_GUARD = /disposable|mcp-test|scratch/i;
const RGB_FIXTURES = (process.env.KB20_RGB_FIXTURES ?? "401,402").split(",").map(Number);
const MOVER = Number(process.env.KB20_MOVER_FIXTURE ?? 601);
const POSITION_BANK = Number(process.env.KB20_POSITION_BANK ?? 2);
const GESTURE_LAPSE_MS = 650;  // the module keeps the bridge [busy] for gestureIdleMs (500) after admitted motion

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol = 0.02) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= tol;

/** The value `Attribute "<name>" At <v>` places for a strip position (0..1) on a slot record: Percent 0..100, Physical From..To. */
export function placedValue(slot, v) {
  if (!slot || typeof v !== "number" || v < 0 || v > 1) return undefined;
  if (slot.readout === "Percent" || slot.readout === "PercentFine") return v * 100;
  if (slot.readout === "Physical" && typeof slot.physicalFrom === "number" && typeof slot.physicalTo === "number" && !slot.physicalMixed) return slot.physicalFrom + v * (slot.physicalTo - slot.physicalFrom);
  return undefined;
}

/** What GetProgPhaser().absolute (a percentage of the range, even at the Physical readout) reads after a position v. */
export function expectedAbsolute(slot, v) {
  if (placedValue(slot, v) === undefined) return undefined;
  return v * 100;
}

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
}

const steps = [];
let failed = 0;
function record(name, pass, detail) {
  steps.push({ name, pass: !!pass, detail });
  if (!pass) failed += 1;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail !== undefined && !pass ? ` ${JSON.stringify(detail)}` : ""}`);
}
function note(name, detail) { steps.push({ name, note: true, detail }); console.log(`NOTE ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`); }

async function main() {
  if (mode !== "verify" && mode !== "run") {
    console.error("usage: node scripts/kb20-probe.mjs verify|run [--out report.json]");
    process.exit(2);
  }
  const A = new Conn("a");
  await A.connect();
  const pingR = await A.request("ping");
  if (!pingR.ok) { console.error(`ping failed: ${pingR.error}`); process.exit(2); }
  const ping = pingR.result;
  const [maj, min] = String(ping.bridgeVersion ?? "0.0").split(".").map(Number);
  if (maj < 0 || (maj === 0 && min < 16)) { console.error(`bridge ${ping.bridgeVersion} predates the strip-capable console backend; update the plugin to 0.16.0 or newer (docs/setup/bridge.md)`); process.exit(2); }
  if (!ping.modules?.control?.loaded) { console.error(`the control module is not loaded: ${ping.modules?.control?.error ?? "no module summary"}`); process.exit(2); }
  const [cmaj, cmin] = String(ping.modules.control.version ?? "0.0").split(".").map(Number);
  if (cmaj === 0 && cmin < 3) { console.error(`control module ${ping.modules.control.version} serves no touches or positions on the console backend; 0.3.0 or newer is needed`); process.exit(2); }
  if (!ping.modules?.feedback?.loaded) { console.error(`the feedback module is not loaded: ${ping.modules?.feedback?.error ?? "no module summary"}`); process.exit(2); }
  const [fmaj, fmin] = String(ping.modules.feedback.version ?? "0.0").split(".").map(Number);
  if (fmaj === 0 && fmin < 4) { console.error(`feedback module ${ping.modules.feedback.version} reports no physical ranges; 0.4.0 or newer is needed`); process.exit(2); }
  if (mode === "run") {
    if (!SHOW_GUARD.test(String(ping.showfile ?? ""))) { console.error(`show "${ping.showfile}" does not look disposable (expected a name matching ${SHOW_GUARD}); refusing to change state`); process.exit(2); }
    if (!ping.control?.enabled || ping.control.backend !== "console") { console.error('run needs continuous control enabled on the console backend by the operator:  Plugin "gma3_mcp_bridge" "control=console"'); process.exit(2); }
    if (!ping.lua?.enabled) { console.error('run needs Lua enabled on the bridge (Plugin "gma3_mcp_bridge" "lua on") for the programmer preflight and the per-fixture value reads'); process.exit(2); }
    if (ping.input?.busy) { console.error(`the bridge is busy (${JSON.stringify(ping.input.busy)}); wait for the owner to finish`); process.exit(2); }
  }
  const report = { mode, host, port, startedAt: new Date().toISOString(), ping: { bridgeVersion: ping.bridgeVersion, build: ping.build, hostname: ping.hostname, showfile: ping.showfile, user: ping.user, modules: ping.modules, input: ping.input, control: ping.control, lua: { enabled: ping.lua?.enabled } }, steps };
  note("console", report.ping);

  // ---- verify: read-only, nothing queued ----
  const st0 = await A.request("control.status");
  const consoleOn = ping.control?.enabled && ping.control.backend === "console";
  record("control.status answers with the module version and limitations naming strips (KB-20) and the mixed-values rule", st0.ok && st0.result.version === ping.modules.control.version && Array.isArray(st0.result.limitations) && st0.result.limitations.some((l) => /KB-20/.test(l) && /mixed-values/.test(l)) && st0.result.yourSession == null, st0.ok ? { version: st0.result.version, limitations: st0.result.limitations } : st0);
  if (consoleOn) {
    record("control.status: the console backend declares touch and absolute on slots, no presses, no executors", st0.ok && st0.result.backend === "console" && st0.result.capabilities?.touch === true && st0.result.capabilities?.absolute === true && st0.result.capabilities?.relative === true && st0.result.capabilities?.button === false && st0.result.capabilities?.targets?.executor === false, st0.ok ? { backend: st0.result.backend, capabilities: st0.result.capabilities } : st0);
  } else note("control is not on the console backend; its capabilities are not checked", ping.control);
  const ctx0 = await A.request("feedback.context", { allExecutors: true });
  record("feedback.context lists the executors of the current page", ctx0.ok && Array.isArray(ctx0.result.executors), ctx0.ok ? ctx0.result.executors?.length : ctx0);
  const execNumbers = ctx0.ok ? ctx0.result.executors.filter((x) => x.available && !x.value.empty).sort((a, b) => (b.value.playbackTarget ? 1 : 0) - (a.value.playbackTarget ? 1 : 0)).map((x) => x.value.executor).slice(0, 4) : [];
  const bind = await A.request("control.bind", { executors: execNumbers });
  record("control.bind watches the context and reports the binding revision", bind.ok && bind.result.watched >= 4 && typeof bind.result.binding === "number", bind.ok ? { generation: bind.result.generation, watched: bind.result.watched, binding: bind.result.binding } : bind);
  const brev = bind.ok ? bind.result.binding : undefined;
  await sleep(400);
  const cached = async () => { const c = await A.request("feedback.context", { executors: execNumbers, cached: true }); if (!c.ok) throw new Error(`feedback.context: ${c.error}`); return c.result; };
  let snap = await cached();
  record("the cached snapshot claims a generation once the loop observed every part", typeof snap.generation === "number" && snap.notObserved === 0, { generation: snap.generation, notObserved: snap.notObserved, note: snap.generationNote });
  const gen0 = snap.generation;
  // One per-device sequence for the whole probe: the session persists across rebinds (KB-19: a fresh factory
  // would replay sequence numbers and every event would be a duplicate); the generation follows each rebind.
  let gen = gen0;
  let seq = 0;
  const ev = {
    touch: (slot, down, extra = {}) => ({ type: "touch", device: "probe-mtouch", control: `Strip${slot}`, seq: ++seq, generation: gen, binding: brev, target: { slot }, down, gesture: extra.gesture ?? 1, ...extra }),
    relative: (slot, delta, extra = {}) => ({ type: "relative", device: "probe-mtouch", control: `Strip${slot}`, seq: ++seq, generation: gen, binding: brev, target: { slot }, delta, gesture: extra.gesture ?? 1, ...extra }),
    absolute: (slot, value, extra = {}) => ({ type: "absolute", device: "probe-mtouch", control: `Strip${slot}`, seq: ++seq, generation: gen, binding: brev, target: { slot }, value, gesture: extra.gesture ?? 1, ...extra }),
    execTouch: (executor, down) => ({ type: "touch", device: "probe-mtouch", control: `Fader${executor}`, seq: ++seq, generation: gen, binding: brev, target: { executor, element: "fader" }, down, gesture: 1 }),
    execAbs: (executor, value) => ({ type: "absolute", device: "probe-mtouch", control: `Fader${executor}`, seq: ++seq, generation: gen, binding: brev, target: { executor, element: "fader" }, value, gesture: 1 }),
    button: (slot, down) => ({ type: "button", device: "probe-nxk", control: `Rotary${slot}`, seq: ++seq, generation: gen, binding: brev, target: { slot }, down }),
  };
  if (consoleOn) {
    const faderExec = (ctx0.ok ? ctx0.result.executors : []).find((x) => x.available && x.value?.playbackTarget && x.value?.functions?.fader)?.value?.executor;
    const sel = snap.slots?.value?.selection?.count;
    const slot1 = snap.slots?.value?.slots?.find((s) => s.slot === 1);
    const events = [ev.button(1, true)];
    if (typeof faderExec === "number") events.push(ev.execTouch(faderExec, true), ev.execAbs(faderExec, 0.5));
    if (sel === 0 && slot1?.kind === "attribute") events.push(ev.touch(1, true), ev.absolute(1, 0.5));
    const r1 = await A.request("control.submit", { events });
    const o = r1.ok ? r1.result.outcomes : [];
    const pressOk = r1.ok && (o[0].refused === "unsupported" ? /not qualified/.test(o[0].reason ?? "") : (sel === 0 && o[0].refused === "target-unavailable"));
    const execOk = typeof faderExec !== "number" || (o[1]?.refused === "unsupported" && /executor faders/.test(o[1].reason ?? "") && o[2]?.refused === "unsupported");
    const slotOk = !(sel === 0 && slot1?.kind === "attribute") || o.slice(typeof faderExec === "number" ? 3 : 1).every((x) => x.refused === "target-unavailable" && /no fixture is selected/.test(x.message ?? ""));
    record("verify: a press is refused; a touch and a position on an executor fader are unsupported (KB-21/22); a touch and a position on slot 1 while nothing is selected are target-unavailable (the target resolves before the backend): nothing is queued, nothing owned", pressOk && execOk && slotOk && r1.result.accepted === 0, outcomesOf(r1));
    if (typeof faderExec !== "number") note("verify: no playback executor with a fader on the page; the executor-fader refusal is not exercised");
    if (!(sel === 0 && slot1?.kind === "attribute")) note("verify: the selection is not empty or slot 1 holds no attribute; the no-selection refusal is not exercised", { selection: sel, slot1: slot1 && [slot1.kind, slot1.availability] });
    const st1 = await A.request("control.status");
    record("verify: the session opened on demand has nothing queued and no gesture; the backend issued no command", st1.ok && st1.result.yourSession && st1.result.sessions[st1.result.yourSession]?.queued === 0 && st1.result.sessions[st1.result.yourSession]?.gestures === 0 && st1.result.busy == null && (st1.result.backendStatus?.counters?.applied ?? 0) === (st0.result.backendStatus?.counters?.applied ?? 0), st1.ok ? { sessions: st1.result.sessions, backend: st1.result.backendStatus?.counters } : st1);
    if (mode !== "run") {
      const close = await A.request("control.close");
      record("verify: control.close ends the session", close.ok && close.result.dropped === 0, close);
    }
  } else {
    const off = await A.request("control.submit", { events: [ev.touch(1, true)] });
    record(`verify: control.submit ${ping.control?.enabled ? "reaches the " + ping.control.backend + " backend (nothing is applied on the console there)" : "is [control-disabled] until the operator enables control"}`, ping.control?.enabled ? off.ok : (!off.ok && off.code === "control-disabled" && /control=console/.test(off.error ?? "")), off);
    if (ping.control?.enabled) { await A.request("control.submit", { events: [ev.touch(1, false)] }); await A.request("control.close"); }
  }

  // ---- run: strip gestures applied on the console backend ----
  if (mode === "run") {
    const cleanup = createCleanup();
    let mutationError = null;
    const need = (r, what) => { if (!r.ok) throw new Error(`${what}: ${r.error}`); return r; };
    const value = async (fixture, attr) => { const r = need(await A.request("lua", { code: LUA_VALUE(fixture, attr), maxMs: 2000 }), `value of ${attr} on ${fixture}`); return r.result?.values?.[0]; };
    const cmd = async (c) => need(await A.request("cmd", { command: c }), c);
    const rebind = async () => { await sleep(400); snap = await cached(); if (typeof snap.generation !== "number") throw new Error(`no generation claimed: ${snap.generationNote}`); gen = snap.generation; return snap; };
    const submit = async (events, what) => need(await A.request("control.submit", { events }), what);
    const lastApplied = async () => (await A.request("control.status")).result?.lastApplied;
    // A request that bundles touch, position and lift leaves the lift as lastApplied; the backend's last command is the placement.
    const lastCommand = async () => (await A.request("control.status")).result?.backendStatus?.lastCommand;
    const settle = () => sleep(GESTURE_LAPSE_MS);
    let gesture = 100;
    try {
      const sel0 = snap.slots?.value?.selection?.count;
      if (sel0 !== 0) throw new Error(`the selection must be empty before the run (${sel0} selected)`);
      const pe = programmerEmpty(await A.request("programmer", { scope: "all" }));
      record("run: preflight gate (programmer provably empty through the programmer op)", pe.ok, pe.ok ? pe.detail : pe.reason);
      if (!pe.ok) throw new Error("programmer not provably empty");
      const bank0 = snap.encoder.value.bank.index, page0 = snap.encoder.value.page.index;
      cleanup.add("ClearAll", () => A.request("cmd", { command: "ClearAll" }));
      cleanup.add("ClearSelection", () => A.request("cmd", { command: "ClearSelection" }));
      cleanup.add(`Select EncoderBank ${bank0}.${page0}`, () => A.request("cmd", { command: `Select EncoderBank ${bank0}.${page0}` }));
      cleanup.add("control.close A", () => A.request("control.close"));
      cleanup.add("release strips", async () => { for (const s of [1, 2, 3, 4]) await A.request("control.submit", { events: [ev.touch(s, false)] }); await sleep(200); });

      // 1. A touch on the Dimmer slot is a hold: busy, owned, nothing moves; the drag inside it is the KB-19 adjustment.
      const [fxA, fxB] = RGB_FIXTURES;
      await cmd(`Fixture ${fxA}`);
      await cmd("Select EncoderBank 1");
      await rebind();
      const dim = snap.slots.value.slots.find((s) => s.slot === 1);
      record(`run: Fixture ${fxA} on the Dimmer bank: slot 1 is ${dim?.name} (${dim?.readout}/${dim?.resolution}), available, programmer empty`, dim?.name === "Dimmer" && dim.availability === "available" && dim.readout === "Percent" && dim.valueState === "empty", slotSummary(snap));
      await cmd(`Attribute "Dimmer" At 40`);
      const v0 = await value(fxA, "Dimmer");
      const applied0 = (await A.request("control.status")).result?.backendStatus?.counters?.applied ?? 0;
      let g = ++gesture;
      let r = await submit([ev.touch(1, true, { gesture: g })], "touch down");
      await sleep(150);
      const stT = await A.request("control.status");
      const busyCmd = await A.request("cmd", { command: "ClearSelection" });
      const la0 = await lastApplied();
      // The busy guard also refuses `lua` while the strip is touched (KB-05/KB-18), so values are read after the lift.
      record("run: a touch down on slot 1 is admitted as a hold: the bridge is [busy] with it (a console command is refused busy, reason touch-down), the touch applied as a noop, no command issued", r.result.outcomes[0].accepted && stT.ok && stT.result.busy?.reason === "touch-down" && !busyCmd.ok && busyCmd.code === "busy" && la0?.outcome === "applied" && la0.result?.noop === true && /reserved its slot/.test(la0.result?.note ?? "") && ((await A.request("control.status")).result?.backendStatus?.counters?.applied ?? 0) === applied0, { outcome: outcomesOf(r), busy: stT.result?.busy, cmd: busyCmd, lastApplied: la0 });
      r = await submit([ev.relative(1, 1, { gesture: g }), ev.relative(1, 1, { gesture: g }), ev.relative(1, 1, { gesture: g }), ev.relative(1, -1, { gesture: g })], "drag");
      await settle();
      const la1 = await lastApplied();
      const rL = await submit([ev.touch(1, false)], "lift");
      await settle();
      const stU = await A.request("control.status");
      const freeCmd = await A.request("cmd", { command: `Fixture ${fxA}` });
      const v1 = await value(fxA, "Dimmer");
      record("run: the drag inside the touch (three detents up, one back) coalesces into the KB-19 adjustment At + 2: 40 -> 42", r.result.accepted === 4 && near(v1, v0 + 2) && /At \+ /.test(la1?.result?.command ?? ""), { before: v0, after: v1, lastApplied: la1, outcomes: outcomesOf(r) });
      record("run: the lift is a boundary (noop end): the hold is gone, the bridge is free again (a console command and a Lua read are accepted)", rL.result.outcomes[0].boundary === true && stU.ok && stU.result.busy == null && stU.result.sessions[stU.result.yourSession]?.gestures === 0 && freeCmd.ok, { outcome: outcomesOf(rL), busy: stU.result?.busy, cmd: freeCmd });
      // Re-touch: a new gesture re-anchors (the anchor is the surface's; here a new gesture on the same slot).
      g = ++gesture;
      await submit([ev.touch(1, true, { gesture: g }), ev.relative(1, -5, { gesture: g }), ev.touch(1, false)], "retouch");
      await settle();
      const v2 = await value(fxA, "Dimmer");
      record("run: lift and re-touch: a new gesture on the same slot drags five detents back (42 -> 37); touch, motion and lift in one request keep their order", near(v2, v1 - 5), { after: v2 });

      // 2. Positions: Attribute "Dimmer" At <value> over 0..100; the newest queued position supersedes.
      g = ++gesture;
      r = await submit([ev.touch(1, true, { gesture: g }), ev.absolute(1, 0.1, { gesture: g }), ev.absolute(1, 0.25, { gesture: g })], "positions");
      await settle();
      const la3 = await lastApplied();
      await submit([ev.touch(1, false)], "lift"); await settle();
      const v3 = await value(fxA, "Dimmer");
      record("run: two positions in one request: the newer superseded the older, Attribute \"Dimmer\" At 25 was placed (the programmer reads 25 after the lift) and lastApplied carries the travel", r.result.outcomes[2].superseded && near(v3, 25) && la3?.result?.command === 'Attribute "Dimmer" At 25' && la3.result?.from === 0 && la3.result?.to === 100 && la3.result?.value === 0.25, { after: v3, lastApplied: la3, outcomes: outcomesOf(r) });
      g = ++gesture;
      await submit([ev.touch(1, true, { gesture: g }), ev.absolute(1, 1, { gesture: g }), ev.touch(1, false)], "top"); await settle();
      const vTop = await value(fxA, "Dimmer");
      g = ++gesture;
      await submit([ev.touch(1, true, { gesture: g }), ev.absolute(1, 0, { gesture: g }), ev.touch(1, false)], "bottom"); await settle();
      const vBot = await value(fxA, "Dimmer");
      record("run: the ends of the travel place 100 and 0 (touch, position and lift in one request each)", near(vTop, 100) && near(vBot, 0), { top: vTop, bottom: vBot });

      // 3. Mixed values stay mixed: a position is refused until takeover; relative motion keeps the relationship.
      await cmd(`Fixture ${fxA} At 20`);
      await cmd(`Fixture ${fxB} At 50`);
      await cmd(`Fixture ${fxA} + ${fxB}`);
      await rebind();
      const dimM = snap.slots.value.slots.find((s) => s.slot === 1);
      record(`run: Fixture ${fxA} + ${fxB} at 20/50: the binding reports slot 1's values as mixed`, snap.slots.value.selection.count === 2 && dimM?.valueState === "mixed", slotSummary(snap));
      g = ++gesture;
      r = await submit([ev.touch(1, true, { gesture: g }), ev.absolute(1, 0.5, { gesture: g }), ev.touch(1, false)], "mixed position");
      await settle();
      const [mA, mB] = [await value(fxA, "Dimmer"), await value(fxB, "Dimmer")];
      record("run: a position on the mixed slot is refused mixed-values (the message names takeover); both fixtures keep 20/50", r.result.outcomes[1].refused === "mixed-values" && /takeover = true/.test(r.result.outcomes[1].message ?? "") && near(mA, 20) && near(mB, 50), { a: mA, b: mB, outcome: outcomesOf(r) });
      g = ++gesture;
      r = await submit([ev.touch(1, true, { gesture: g }), ev.relative(1, 5, { gesture: g }), ev.touch(1, false)], "mixed relative");
      await settle();
      const [rA, rB] = [await value(fxA, "Dimmer"), await value(fxB, "Dimmer")];
      record("run: relative motion on the mixed slot is served and keeps the relationship (20/50 -> 25/55)", r.result.outcomes[1].accepted && near(rA, 25) && near(rB, 55), { a: rA, b: rB, outcome: outcomesOf(r) });
      g = ++gesture;
      r = await submit([ev.touch(1, true, { gesture: g }), ev.absolute(1, 0.6, { gesture: g, takeover: true }), ev.touch(1, false)], "takeover");
      await settle();
      const [tA, tB] = [await value(fxA, "Dimmer"), await value(fxB, "Dimmer")];
      const laK = await lastCommand();
      record("run: with takeover = true the position is placed on both: Attribute \"Dimmer\" At 60, 60/60, the backend's record says takeover", r.result.outcomes[1].accepted && near(tA, 60) && near(tB, 60) && laK?.command === 'Attribute "Dimmer" At 60' && laK?.takeover === true && laK?.outcome === "applied", { a: tA, b: tB, lastCommand: laK });
      await cmd("ClearAll");

      // 4. Physical readout: positions are placed in physical units (Pan From..To), the programmer reads percent.
      await cmd(`Fixture ${MOVER}`);
      await cmd(`Select EncoderBank ${POSITION_BANK}`);
      await rebind();
      const pan = snap.slots.value.slots.find((s) => s.name === "Pan");
      record(`run: Fixture ${MOVER} on the position bank: Pan is a Physical-readout slot with PhysicalFrom/To from the fixture type`, pan && pan.readout === "Physical" && typeof pan.physicalFrom === "number" && typeof pan.physicalTo === "number" && !pan.physicalMixed, slotSummary(snap));
      if (pan && typeof pan.physicalFrom === "number" && typeof pan.physicalTo === "number") {
        g = ++gesture;
        await submit([ev.touch(pan.slot, true, { gesture: g }), ev.absolute(pan.slot, 0.5, { gesture: g }), ev.touch(pan.slot, false)], "pan centre"); await settle();
        const p1 = await value(MOVER, "Pan");
        const laP = await lastCommand();
        const centre = placedValue(pan, 0.5);
        record(`run: position 0.5 on Pan is Attribute "Pan" At ${centre} (physical units: the middle of ${pan.physicalFrom}..${pan.physicalTo}) and the programmer reads 50 percent`, laP?.amount === centre && laP?.readout === "Physical" && laP?.outcome === "applied" && near(p1, 50, 0.05), { after: p1, lastCommand: laP });
        g = ++gesture;
        await submit([ev.touch(pan.slot, true, { gesture: g }), ev.absolute(pan.slot, 0.1, { gesture: g }), ev.touch(pan.slot, false)], "pan low"); await settle();
        const p2 = await value(MOVER, "Pan");
        const laP2 = await lastCommand();
        record(`run: position 0.1 on Pan is At ${placedValue(pan, 0.1)} and reads 10 percent`, near(laP2?.amount, placedValue(pan, 0.1), 1e-6) && laP2?.outcome === "applied" && near(p2, 10, 0.05), { after: p2, lastCommand: laP2 });
      }
      await cmd("ClearAll");

      // 5. Empty selection: a touch resolves its target first (target-unavailable, no hold).
      await cmd("ClearSelection");
      await rebind();
      const er = await submit([ev.touch(1, true, { gesture: ++gesture })], "empty touch");
      const stE = await A.request("control.status");
      record("run: with the selection cleared a touch on slot 1 is target-unavailable (no fixture is selected): no hold, the bridge is not busy", er.result.outcomes[0].refused === "target-unavailable" && stE.ok && stE.result.busy == null, outcomesOf(er));
      // 6. A press stays refused with a live target.
      await cmd(`Fixture ${fxA}`);
      await cmd("Select EncoderBank 1");
      await rebind();
      const pr = await submit([ev.button(1, true)], "press");
      record("run: an encoder press with a live target is still refused unsupported (calculator/open/select not qualified)", pr.result.outcomes[0].refused === "unsupported", outcomesOf(pr));
    } catch (e) {
      mutationError = e;
      record("run: the mutation phase failed; running the registered undos", false, { error: String(e?.message ?? e), pending: cleanup.pending() });
    } finally {
      await sleep(GESTURE_LAPSE_MS);
      const outcomes = await cleanup.run();
      record("run: cleanup ran every registered undo", outcomes.every((o) => o.ok), outcomes);
    }
    await sleep(400);
    const fin = await A.request("feedback.context", { executors: execNumbers, cached: true });
    record("run: the selection is empty again and the bank is back", fin.ok && fin.result.slots?.value?.selection?.count === 0, fin.ok ? { selection: fin.result.slots?.value?.selection, bank: fin.result.encoder?.value?.bank } : fin);
    const progEnd = programmerEmpty(await A.request("programmer", { scope: "all" }));
    record("run: the programmer is empty again (provably, through the programmer op)", progEnd.ok, progEnd.ok ? progEnd.detail : progEnd.reason);
    const stF = await A.request("control.status");
    record("run: no session, gesture or queued intent is left; nothing is unresolved", stF.ok && Object.keys(stF.result.sessions).length === 0 && stF.result.unresolved.length === 0 && stF.result.busy == null, stF.ok ? { sessions: Object.keys(stF.result.sessions), unresolved: stF.result.unresolved, backend: stF.result.backendStatus?.counters } : stF);
    if (mutationError) failed = Math.max(failed, 1);
  }
  await A.request("feedback.unwatch").catch(() => {});
  await A.end();
  report.finishedAt = new Date().toISOString();
  report.passed = steps.filter((s) => s.pass === true).length;
  report.failed = failed;
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`\n${report.passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

if (process.argv[1] && /kb20-probe\.mjs$/.test(process.argv[1])) main().catch((e) => { console.error(e); process.exit(2); });
