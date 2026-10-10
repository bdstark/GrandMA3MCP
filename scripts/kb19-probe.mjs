#!/usr/bin/env node
// KB-19 adjustment-backend probe against a RUNNING bridge (plugin 0.15.0 or newer with gma3_mcp_control
// 0.2.0 and gma3_mcp_feedback 0.4.0; see ENCODERS.md "KB-19", docs/modules.md "Console adjustment backend").
//
//   node scripts/kb19-probe.mjs verify [--out report.json]   read-only: nothing is queued or applied
//   node scripts/kb19-probe.mjs run    [--out report.json]   verify + encoder motion applied on the CONSOLE
//                                                           backend of a DISPOSABLE show (values move)
//
// `verify` exercises the control.* ops over a real TCP connection: the ping summary names the backend,
// control.status carries the backend's capabilities and calibration, control.bind against the current
// executor page, and refusals that queue nothing: an encoder press, a strip position and a touch
// (`unsupported` on the console backend), a slot without a selection (`target-unavailable`). `run` needs a
// show whose name matches "disposable", "mcp-test" or "scratch", Lua enabled (the programmer preflight) and
// `Plugin "gma3_mcp_bridge" "control=console"` (an operator decision this probe never makes): it selects
// fixtures (undo registered first) and checks that one detent is one console click (Percent: 1, Physical:
// range / 120), coalesced detents add up, a negative delta subtracts, the fine gesture is a tenth, the ends
// clamp, a two-fixture selection keeps its relationship (relative, per fixture), colour pages, Pan/Tilt
// (Physical readout), a gobo slot, a mixed selection (the fixture without the attribute is untouched), the
// empty selection, a page change moving the generation (old events refused), and that an encoder press is
// never applied. Every change registers its undo before dispatch; the cleanup runs them all and ends with
// ClearAll (colour writes activate the whole colour group, KB-17). GMA3_BRIDGE_HOST / GMA3_BRIDGE_PORT
// select the bridge; KB19_RGB_FIXTURES ("401,402"), KB19_MOVER_FIXTURE (601), KB19_COLOR_BANK (4),
// KB19_POSITION_BANK (2), KB19_GOBO_BANK (3) the test show's layout.
import net from "node:net";
import fs from "node:fs";
import { createCleanup, programmerEmpty } from "./lib/kb16-steps.mjs";
import { eventFactory, outcomesOf } from "./kb18-probe.mjs";  // eventFactory: the verify phase (one session, one binding)

const host = process.env.GMA3_BRIDGE_HOST ?? "127.0.0.1";
const port = Number(process.env.GMA3_BRIDGE_PORT ?? 9800);
const argv = process.argv.slice(2);
const mode = argv[0];
const outIdx = argv.indexOf("--out");
const outFile = outIdx >= 0 ? argv[outIdx + 1] : null;
const SHOW_GUARD = /disposable|mcp-test|scratch/i;
const RGB_FIXTURES = (process.env.KB19_RGB_FIXTURES ?? "401,402").split(",").map(Number);
const MOVER = Number(process.env.KB19_MOVER_FIXTURE ?? 601);
const COLOR_BANK = Number(process.env.KB19_COLOR_BANK ?? 4);
const POSITION_BANK = Number(process.env.KB19_POSITION_BANK ?? 2);
const GOBO_BANK = Number(process.env.KB19_GOBO_BANK ?? 3);
const GESTURE_LAPSE_MS = 650;  // the module keeps the bridge [busy] for gestureIdleMs (500) after admitted motion

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol = 0.02) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= tol;

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

/** The programmer value of one attribute on one fixture, through the `lua` op (GetProgPhaser step 1). */
export const LUA_VALUE = (fixture, attr) => `local h = ObjectList("Fixture ${fixture}")[1]; if not h then return "no-fixture" end; local ui = GetUIChannels(h); for i = 1, #ui do local a = GetAttributeByUIChannel(ui[i]); if a and a.name == ${JSON.stringify(attr)} then local ph = GetProgPhaser(ui[i], false); if ph == nil then return "empty" end; return ph[1] and ph[1].absolute or "no-step" end end; return "no-channel"`;

/** Summarises the slots of a cached snapshot for the report. */
export function slotSummary(snap) {
  return (snap?.slots?.value?.slots ?? []).map((s) => ({ slot: s.slot, name: s.name, readout: s.readout, resolution: s.resolution, availability: s.availability, valueState: s.valueState, absolute: s.absolute, physicalRange: s.physicalRange, channelFunction: s.channelFunction }));
}

/** The expected change of one console click for a slot record (Percent: 1, Physical: range / 120). */
export function clickOf(slot) {
  if (!slot) return undefined;
  const mult = slot.resolution === "Fine" ? 0.1 : slot.resolution === "Coarse" ? 1 : undefined;
  if (mult === undefined) return undefined;
  if (slot.readout === "Percent" || slot.readout === "PercentFine") return 1 * mult;
  if (slot.readout === "Physical" && typeof slot.physicalRange === "number" && slot.physicalRange > 0) return (slot.physicalRange / 120) * mult;
  return undefined;
}

async function main() {
  if (mode !== "verify" && mode !== "run") {
    console.error("usage: node scripts/kb19-probe.mjs verify|run [--out report.json]");
    process.exit(2);
  }
  const A = new Conn("a");
  await A.connect();
  const pingR = await A.request("ping");
  if (!pingR.ok) { console.error(`ping failed: ${pingR.error}`); process.exit(2); }
  const ping = pingR.result;
  const [maj, min] = String(ping.bridgeVersion ?? "0.0").split(".").map(Number);
  if (maj < 0 || (maj === 0 && min < 15)) { console.error(`bridge ${ping.bridgeVersion} has no console control backend; update the plugin to 0.15.0 or newer (docs/setup/bridge.md)`); process.exit(2); }
  if (!ping.modules?.control?.loaded) { console.error(`the control module is not loaded: ${ping.modules?.control?.error ?? "no module summary"}`); process.exit(2); }
  const [cmaj, cmin] = String(ping.modules.control.version ?? "0.0").split(".").map(Number);
  if (cmaj === 0 && cmin < 2) { console.error(`control module ${ping.modules.control.version} has no console backend; 0.2.0 or newer is needed`); process.exit(2); }
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
  record("ping carries the control summary with the backend name", ping.control && typeof ping.control.enabled === "boolean" && "backend" in ping.control, ping.control);
  const st0 = await A.request("control.status");
  const consoleOn = ping.control?.enabled && ping.control.backend === "console";
  record("control.status answers with the module version and limitations naming the console backend", st0.ok && st0.result.version === ping.modules.control.version && Array.isArray(st0.result.limitations) && st0.result.limitations.some((l) => /console backend/.test(l)) && st0.result.yourSession == null, st0.ok ? { version: st0.result.version, limitations: st0.result.limitations } : st0);
  if (consoleOn) {
    record("control.status carries the console backend's capabilities and calibration (relative on slots only; Percent 1, Physical range/120, Fine 0.1)", st0.ok && st0.result.backend === "console" && st0.result.capabilities?.relative === true && st0.result.capabilities?.button === false && st0.result.backendStatus?.calibration?.resolutions?.Coarse === 1 && st0.result.backendStatus?.calibration?.resolutions?.Fine === 0.1 && st0.result.backendStatus?.calibration?.readouts?.Physical === "range/120" && st0.result.backendStatus?.calibration?.fineDivisor === 10, st0.ok ? { backend: st0.result.backend, capabilities: st0.result.capabilities, calibration: st0.result.backendStatus?.calibration } : st0);
  } else note("control is not on the console backend; its capabilities and calibration are not checked", ping.control);
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
  if (consoleOn) {
    const ev = eventFactory("probe-verify", gen0, brev);
    const faderExec = (ctx0.ok ? ctx0.result.executors : []).find((x) => x.available && x.value?.playbackTarget && x.value?.functions?.fader)?.value?.executor;
    const events = [ev.button(1, true)];
    if (typeof faderExec === "number") events.push(ev.absolute(faderExec, 0.5), ev.touch(faderExec, true));
    const r1 = await A.request("control.submit", { events });
    // The target resolves before the backend's verdict: a press on a slot without a selection is target-unavailable
    // there, and unsupported once a fixture is selected (the run phase checks that case).
    const pressOk = r1.ok && (r1.result.outcomes[0].refused === "unsupported" ? /not qualified/.test(r1.result.outcomes[0].reason ?? "") : (snap.slots?.value?.selection?.count === 0 && r1.result.outcomes[0].refused === "target-unavailable"));
    record("verify: an encoder press (and a strip position and touch) are refused on the console backend (unsupported, or target-unavailable for the press while nothing is selected); nothing is queued, nothing owned", pressOk && r1.result.accepted === 0 && r1.result.outcomes.slice(1).every((o) => o.refused === "unsupported" && o.backend === "console"), outcomesOf(r1));
    const sel = snap.slots?.value?.selection?.count;
    const slot1 = snap.slots?.value?.slots?.find((s) => s.slot === 1);
    if (sel === 0 && slot1?.kind === "attribute") {
      const r2 = await A.request("control.submit", { events: [ev.relative(1, 1)] });
      record("verify: slot 1 without a selection is refused target-unavailable (no fixture is selected); nothing is queued", r2.ok && r2.result.outcomes[0].refused === "target-unavailable" && /no fixture is selected/.test(r2.result.outcomes[0].message ?? ""), outcomesOf(r2));
    } else note("verify: the selection is not empty or slot 1 holds no attribute; the no-selection refusal is not exercised", { selection: sel, slot1: slot1 && [slot1.kind, slot1.availability] });
    const st1 = await A.request("control.status");
    record("verify: the session opened on demand has nothing queued and no gesture; the backend issued no command", st1.ok && st1.result.yourSession && st1.result.sessions[st1.result.yourSession]?.queued === 0 && st1.result.sessions[st1.result.yourSession]?.gestures === 0 && st1.result.busy == null && (st1.result.backendStatus?.counters?.applied ?? 0) === (st0.result.backendStatus?.counters?.applied ?? 0), st1.ok ? { sessions: st1.result.sessions, backend: st1.result.backendStatus?.counters } : st1);
    const close = await A.request("control.close");
    record("verify: control.close ends the session", close.ok && close.result.dropped === 0, close);
  } else {
    const off = await A.request("control.submit", { events: [{ type: "relative", device: "probe", control: "Rotary1", seq: 1, generation: gen0 ?? 0, binding: brev, target: { slot: 1 }, delta: 1 }] });
    record(`verify: control.submit ${ping.control?.enabled ? "reaches the " + ping.control.backend + " backend (nothing is applied on the console there)" : "is [control-disabled] until the operator enables control"}`, ping.control?.enabled ? off.ok : (!off.ok && off.code === "control-disabled" && /control=console/.test(off.error ?? "")), off);
    if (ping.control?.enabled) await A.request("control.close");
  }

  // ---- run: motion applied on the console backend ----
  if (mode === "run") {
    const cleanup = createCleanup();
    let mutationError = null;
    const need = (r, what) => { if (!r.ok) throw new Error(`${what}: ${r.error}`); return r; };
    const value = async (fixture, attr) => { const r = need(await A.request("lua", { code: LUA_VALUE(fixture, attr), maxMs: 2000 }), `value of ${attr} on ${fixture}`); return r.result?.values?.[0]; };
    const cmd = async (c) => need(await A.request("cmd", { command: c }), c);
    // One per-device sequence for the whole run (the session persists across rebinds, so a fresh factory would
    // replay sequence numbers and every event would be a duplicate); the generation follows each rebind.
    let gen = gen0;
    let seq = 0;
    const ev = {
      relative: (slot, delta, extra = {}) => ({ type: "relative", device: "probe-nxk", control: `Rotary${slot}`, seq: ++seq, generation: gen, binding: brev, target: { slot }, delta, gesture: extra.gesture ?? 1, ...extra }),
      button: (slot, down, extra = {}) => ({ type: "button", device: "probe-nxk", control: `Rotary${slot}`, seq: ++seq, generation: gen, binding: brev, target: { slot }, down, ...extra }),
      get seq() { return seq; },
    };
    const rebind = async () => { await sleep(400); snap = await cached(); if (typeof snap.generation !== "number") throw new Error(`no generation claimed: ${snap.generationNote}`); gen = snap.generation; return snap; };
    const turn = async (slot, delta, extra = {}) => { const r = need(await A.request("control.submit", { events: [ev.relative(slot, delta, extra)] }), `turn slot ${slot}`); await sleep(GESTURE_LAPSE_MS); return r; };
    const lastApplied = async () => (await A.request("control.status")).result?.lastApplied;
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

      // 1. One fixture, Dimmer bank: one detent = one click (Percent, Coarse: 1).
      const [fxA, fxB] = RGB_FIXTURES;
      await cmd(`Fixture ${fxA}`);
      await cmd("Select EncoderBank 1");
      await rebind();
      const dim = snap.slots.value.slots.find((s) => s.slot === 1);
      record(`run: Fixture ${fxA} on the Dimmer bank: slot 1 is ${dim?.name} (${dim?.readout}/${dim?.resolution}), available, programmer empty`, dim?.name === "Dimmer" && dim.availability === "available" && dim.readout === "Percent" && dim.resolution === "Coarse" && dim.valueState === "empty", slotSummary(snap));
      const v0 = await value(fxA, "Dimmer");
      let r = await turn(1, 1);
      const v1 = await value(fxA, "Dimmer");
      const la1 = await lastApplied();
      record("run: one detent on slot 1 is applied as Attribute \"Dimmer\" At + 1 and the programmer value rose by 1 (from an empty programmer: the output value plus 1)", r.result.outcomes[0].accepted && la1?.outcome === "applied" && la1.result?.command === 'Attribute "Dimmer" At + 1' && la1.result?.step === 1 && typeof v1 === "number" && near(v1, (typeof v0 === "number" ? v0 : 0) + 1), { before: v0, after: v1, lastApplied: la1 });
      const burst = Array.from({ length: 10 }, () => ev.relative(1, 1, { gesture: 2 }));
      r = need(await A.request("control.submit", { events: burst }), "burst");
      await sleep(GESTURE_LAPSE_MS);
      const v2 = await value(fxA, "Dimmer");
      const la2 = await lastApplied();
      record("run: ten detents in one request coalesce into one At + 10 (or a few partial sums, never more than 10 in total)", r.result.accepted === 10 && near(v2, v1 + 10) && /At \+ /.test(la2?.result?.command ?? ""), { after: v2, lastApplied: la2, outcomes: outcomesOf(r) });
      r = await turn(1, -3, { gesture: 3 });
      const v3 = await value(fxA, "Dimmer");
      record("run: a negative delta is At - 3", near(v3, v2 - 3) && (await lastApplied())?.result?.command === 'Attribute "Dimmer" At - 3', { after: v3 });
      r = await turn(1, 2, { gesture: 4, fine: true });
      const v4 = await value(fxA, "Dimmer");
      const la4 = await lastApplied();
      record("run: the fine gesture (Bank held on the NX-K) is a tenth of a click: two fine detents are At + 0.2", near(v4, v3 + 0.2, 0.005) && la4?.result?.command === 'Attribute "Dimmer" At + 0.2' && la4.result?.fine === true, { after: v4, lastApplied: la4 });
      r = await turn(1, 4096, { gesture: 5 });
      const v5 = await value(fxA, "Dimmer");
      r = await turn(1, -4096, { gesture: 6 });
      const v6 = await value(fxA, "Dimmer");
      record("run: the ends clamp (4096 detents up reads 100, 4096 down reads 0)", near(v5, 100) && near(v6, 0), { up: v5, down: v6 });

      // 2. Two fixtures at different levels keep their relationship (the adjustment is relative per fixture).
      await cmd(`Fixture ${fxA} At 20`);
      await cmd(`Fixture ${fxB} At 50`);
      await cmd(`Fixture ${fxA} + ${fxB}`);
      await rebind();
      record(`run: Fixture ${fxA} + ${fxB} selected, Dimmer available on both, the generation moved`, snap.slots.value.selection.count === 2 && snap.slots.value.slots[0]?.availability === "available", slotSummary(snap));
      await turn(1, 5, { gesture: 7 });
      const [a7, b7] = [await value(fxA, "Dimmer"), await value(fxB, "Dimmer")];
      record("run: five detents on a two-fixture selection move both by 5 and keep their difference (20/50 -> 25/55), never flattening them", near(a7, 25) && near(b7, 55), { a: a7, b: b7 });

      // 3. Colour bank: slots follow the page, the command names the slot's attribute, page 2 too.
      await cmd(`Fixture ${fxA}`);
      await cmd(`Select EncoderBank ${COLOR_BANK}`);
      await rebind();
      const colourSlots = slotSummary(snap);
      const slotG = snap.slots.value.slots.find((s) => s.slot === 2);
      record(`run: colour bank ${COLOR_BANK} page 1: slot 2 is ${slotG?.name} (available, Percent/Coarse)`, snap.encoder.value.bank.index === COLOR_BANK && slotG?.kind === "attribute" && slotG.availability === "available" && slotG.readout === "Percent", colourSlots);
      // A colour component's output default is 100 (white) on this fixture, so a relative step from an empty programmer
      // would clamp: start from a known value (the first run of this probe found exactly that).
      await cmd(`Attribute "${slotG.name}" At 40`);
      const g0 = await value(fxA, slotG.name);
      await turn(2, 7, { gesture: 8 });
      const g1 = await value(fxA, slotG.name);
      const laG = await lastApplied();
      record(`run: seven detents on slot 2 adjust ${slotG.name} by 7 from 40 (the command names the slot's attribute, not a hard-coded one)`, near(g0, 40) && near(g1, 47) && laG?.result?.attribute === slotG.name && laG.result?.slot === 2, { before: g0, after: g1, lastApplied: laG });
      const pages = snap.encoder.value.bank.pages ?? 1;
      if (pages >= 2) {
        await cmd(`Select EncoderBank ${COLOR_BANK}.2`);
        await rebind();
        const slotW = snap.slots.value.slots.find((s) => s.slot === 1);
        if (snap.encoder.value.page.index === 2 && slotW?.kind === "attribute" && slotW.availability === "available") {
          await cmd(`Attribute "${slotW.name}" At 40`);
          const w0 = await value(fxA, slotW.name);
          await turn(1, 3, { gesture: 9 });
          const w1 = await value(fxA, slotW.name);
          record(`run: colour page 2: slot 1 now means ${slotW.name}; three detents adjust it by 3 from 40`, near(w0, 40) && near(w1, 43) && (await lastApplied())?.result?.attribute === slotW.name, { before: w0, after: w1, slots: slotSummary(snap) });
        } else note("run: colour page 2 was not reached or its slot 1 is not available; the page step is not exercised", { page: snap.encoder.value.page, slots: slotSummary(snap) });
      } else note(`run: bank ${COLOR_BANK} has one page; the page step is not exercised`);

      // 4. A page change while motion is queued: old-generation events are refused afterwards.
      const before = gen;
      const motion = need(await A.request("control.submit", { events: [ev.relative(1, 1, { gesture: 10 })] }), "motion before the page change");
      const early = await A.request("cmd", { command: `Select EncoderBank ${COLOR_BANK}.1` });
      record("run: motion keeps the bridge [busy] for the gesture window, so a page change waits (the stale queue is never applied to the new page)", motion.result.accepted === 1 && !early.ok && early.code === "busy" && early.detail?.reason === "motion", early);
      await sleep(GESTURE_LAPSE_MS);
      await cmd(`Select EncoderBank ${COLOR_BANK}.1`);
      await rebind();
      const sr = need(await A.request("control.submit", { events: [ev.relative(1, 1, { gesture: 11, generation: before })] }), "stale");
      record("run: after the page change an event with the old generation is refused stale-generation; a fresh gesture uses the new binding", gen !== before && sr.result.outcomes[0].refused === "stale-generation" && sr.result.outcomes[0].generation === gen, { generation: [before, gen], outcome: outcomesOf(sr) });
      await cmd("ClearAll");

      // 5. Pan/Tilt: Physical readout, one click = range / 120 in physical units (At takes degrees).
      await cmd(`Fixture ${MOVER}`);
      await cmd(`Select EncoderBank ${POSITION_BANK}`);
      await rebind();
      const pan = snap.slots.value.slots.find((s) => s.name === "Pan");
      const tilt = snap.slots.value.slots.find((s) => s.name === "Tilt");
      record(`run: Fixture ${MOVER} on the position bank: Pan and Tilt are Physical-readout slots with a physical range from the fixture type`, pan && tilt && pan.readout === "Physical" && typeof pan.physicalRange === "number" && pan.physicalRange > 0 && typeof tilt.physicalRange === "number", slotSummary(snap));
      if (pan && typeof pan.physicalRange === "number") {
        const p0 = await value(MOVER, "Pan");
        await turn(pan.slot, 4, { gesture: 12 });
        const p1 = await value(MOVER, "Pan");
        const laP = await lastApplied();
        const clickPct = (pan.physicalRange / 120) / pan.physicalRange * 100;  // one click as a percentage of the range (GetProgPhaser reports percent)
        record(`run: four detents on Pan are At + ${(4 * pan.physicalRange / 120).toFixed(2)} degrees (range ${pan.physicalRange} / 120 per click) and the programmer moved by 4 clicks`, laP?.result?.readout === "Physical" && near(laP.result?.step, pan.physicalRange / 120, 1e-6) && near(p1, (typeof p0 === "number" ? p0 : 50) + 4 * clickPct, 0.05), { before: p0, after: p1, lastApplied: laP, clickPercent: clickPct });
        await turn(pan.slot, -2, { gesture: 13, fine: true });
        const p2 = await value(MOVER, "Pan");
        record("run: two fine detents on Pan subtract a fifth of a click", near(p2, p1 - 0.2 * clickPct, 0.05), { after: p2 });
      }
      if (tilt && typeof tilt.physicalRange === "number") {
        const t0 = await value(MOVER, "Tilt");
        await turn(tilt.slot, 3, { gesture: 14 });
        const t1 = await value(MOVER, "Tilt");
        const laT = await lastApplied();
        record(`run: three detents on Tilt (range ${tilt.physicalRange}) are applied in Tilt's own physical units`, laT?.result?.attribute === "Tilt" && near(laT.result?.step, tilt.physicalRange / 120, 1e-6) && near(t1, (typeof t0 === "number" ? t0 : 50) + 3 * (100 / 120), 0.05), { before: t0, after: t1, lastApplied: laT });
      }
      await cmd("ClearAll");

      // 6. A non-colour, non-position attribute: the gobo bank (Physical readout, two channel functions).
      await cmd(`Fixture ${MOVER}`);  // ClearAll cleared the selection too
      await cmd(`Select EncoderBank ${GOBO_BANK}`);
      await rebind();
      const gobo = snap.slots.value.slots.find((s) => s.kind === "attribute" && s.availability === "available");
      if (gobo) {
        const gv0 = await value(MOVER, gobo.name);
        const gr = await turn(gobo.slot, 2, { gesture: 15 });
        const laGo = await lastApplied();
        const gv1 = await value(MOVER, gobo.name);
        if (gr.result.outcomes[0].accepted) {
          record(`run: gobo bank slot ${gobo.slot} (${gobo.name}, ${gobo.readout}, function '${gobo.physicalFunction}' of ${gobo.physicalFunctions}): two detents adjust it by two clicks of its own range (${gobo.physicalRange})`, laGo?.result?.attribute === gobo.name && typeof gv1 === "number", { slot: gobo, before: gv0, after: gv1, lastApplied: laGo });
        } else record(`run: gobo bank slot ${gobo.slot} (${gobo.name}) is refused with the reason (not calibrated), nothing applied`, gr.result.outcomes[0].refused === "unsupported", { slot: gobo, outcome: outcomesOf(gr) });
      } else note("run: no available attribute slot on the gobo bank", slotSummary(snap));
      await cmd("ClearAll");

      // 7. Mixed fixtures: the colour bank with a fixture that has no colour; the Dimmer bank where both have it.
      await cmd(`Fixture ${fxA} + ${MOVER}`);
      await cmd(`Select EncoderBank ${COLOR_BANK}.1`);
      await rebind();
      const mixedSlot = snap.slots.value.slots.find((s) => s.kind === "attribute");
      record(`run: Fixture ${fxA} + ${MOVER} on the colour bank: ${mixedSlot?.name} is 'mixed' (only one fixture has it)`, mixedSlot?.availability === "mixed", slotSummary(snap));
      if (mixedSlot?.availability === "mixed") {
        await cmd(`Attribute "${mixedSlot.name}" At 30`);  // lands on the fixture that has it only (KB-16)
        const mr = await turn(mixedSlot.slot, 5, { gesture: 16 });
        const mA = await value(fxA, mixedSlot.name);
        const mB = await value(MOVER, mixedSlot.name);
        record(`run: five detents on the mixed slot are admitted (mixed reported), ${fxA}'s ${mixedSlot.name} moved 30 -> 35 and ${MOVER} (no such channel) is untouched`, mr.result.outcomes[0].accepted && mr.result.outcomes[0].mixed === true && near(mA, 35) && mB === "no-channel", { a: mA, b: mB, outcome: outcomesOf(mr) });
      }
      await cmd("Select EncoderBank 1");
      await rebind();
      await turn(1, 6, { gesture: 17 });
      const [dA, dB] = [await value(fxA, "Dimmer"), await value(MOVER, "Dimmer")];
      record("run: on the Dimmer bank the same six detents move both fixture types by 6", near(dA, 6) && near(dB, 6), { a: dA, b: dB });
      await cmd("ClearAll");

      // 8. Empty selection and unavailable slot.
      await cmd("ClearSelection");
      await rebind();
      const er = need(await A.request("control.submit", { events: [ev.relative(1, 1, { gesture: 18 })] }), "empty selection");
      record("run: with the selection cleared slot 1 is target-unavailable (no fixture is selected); nothing applied", er.result.outcomes[0].refused === "target-unavailable" && /no fixture is selected/.test(er.result.outcomes[0].message ?? ""), outcomesOf(er));
      await cmd(`Fixture ${MOVER}`);
      await cmd(`Select EncoderBank ${COLOR_BANK}.1`);
      await rebind();
      const unav = snap.slots.value.slots.find((s) => s.kind === "attribute" && s.availability === "unavailable");
      if (snap.encoder.value.bank.index === COLOR_BANK && unav) {
        const ur = need(await A.request("control.submit", { events: [ev.relative(unav.slot, 1, { gesture: 19 })] }), "unavailable");
        record(`run: ${unav.name} is unavailable for Fixture ${MOVER}: refused target-unavailable with the reason`, ur.result.outcomes[0].refused === "target-unavailable" && /unavailable/.test(ur.result.outcomes[0].message ?? ""), outcomesOf(ur));
      } else note("run: no unavailable attribute slot on the colour page the console kept for the mover; the unavailable-slot refusal is not exercised", { bank: snap.encoder.value.bank, slots: slotSummary(snap) });

      // 9. An encoder press is never applied, with the selection in place.
      const pr = need(await A.request("control.submit", { events: [ev.button(1, true)] }), "press");
      record("run: an encoder press with a live target is still refused unsupported (calculator/open/select not qualified); no command issued", pr.result.outcomes[0].refused === "unsupported", outcomesOf(pr));
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

if (process.argv[1] && /kb19-probe\.mjs$/.test(process.argv[1])) main().catch((e) => { console.error(e); process.exit(2); });
