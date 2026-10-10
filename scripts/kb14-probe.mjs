#!/usr/bin/env node
// KB-14 probe: scoped keyboard-shortcut mode changes and text routes (KEYBOARD.md "KB-14") against a RUNNING
// bridge with Lua enabled. Console keys ARE pressed and the operator's keyboard-shortcut mode IS toggled (and
// restored): run it only on a disposable show.
//
//   node scripts/kb14-probe.mjs timing [--out report.json]
//       The consumption-order probe behind the module's restore delay: through the "lua" op it sends character
//       and key events and changes the shortcut mode in the SAME Lua chunk, reading the command line and MASTATE
//       in the chunk and one request later. Needs Lua on; input may be on any backend as long as nothing is held.
//
//   node scripts/kb14-probe.mjs run [--out report.json] [--deferred-macro 116]
//       The module paths over one TCP connection on the keyboard backend (bridge 0.11.0 / hardkeys 0.9.0):
//       input.routing / input.route, a type tap with shortcuts on (temporary disable, insertion, delayed
//       restore), text with shortcuts off (no change), shortcutOrType on both sides, a shortcut-table hold with
//       shortcuts off (temporary enable kept through the hold, restored after the release), consecutive text
//       taps sharing one change, the conflict refusals, and the operator disabling shortcuts during a temporarily
//       enabled hold (route change, release unresolved, recovery after the operator restores it). Operator
//       actions during a hold are written into the DEFERRED macro (default Macro 116, must be EMPTY; created,
//       verified by contents before every rewrite and before deletion, left in place if edited) and fired
//       through "lua" before the hold starts, as in the KB-13 probe. The shortcut mode is read at the start and
//       restored to that state at the end; the routing policy is put back to the module default.
//
// Reads happen through "lua" (CmdObj().cmdtext, Root().MASTATE, the profile's KEYBOARDSHORTCUTSACTIVE) outside
// interactions and through the unguarded input.status / feedback.read ops during them. Nothing is retried or replayed.
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const host = process.env.GMA3_BRIDGE_HOST ?? "127.0.0.1";
const port = Number(process.env.GMA3_BRIDGE_PORT ?? 9800);
const argv = process.argv.slice(2);
const mode = argv[0];
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const outFile = opt("--out", null);
const DEFERRED_MACRO = Number(opt("--deferred-macro", 116));
const DEFERRED_NAME = "MCP kb14 deferred";
let deferredCreated = false;
const SHOW_GUARD = /disposable|mcp-test|scratch/i;
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
      sock.on("error", (e) => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); } this.pending.clear(); if (!this.sock) reject(e); });
      sock.on("close", () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("connection closed")); } this.pending.clear(); });
      this.sock = sock;
    });
  }
  request(op, args = {}) {
    const id = `${this.name}-${this.seq++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout waiting for ${op}`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.write(JSON.stringify({ id, op, args }) + "\n");
    });
  }
  end() { return new Promise((r) => { this.sock.end(r); }); }
}

const steps = [];
let failed = 0;
function record(name, pass, detail) {
  steps.push({ name, pass: !!pass, detail });
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}
function note(name, detail) {
  steps.push({ name, pass: null, detail });
  console.log(`NOTE  ${name}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}
const errorOf = (r) => (r.ok ? "" : r.error);

async function lua(conn, code) {
  const r = await conn.request("lua", { code });
  if (!r.ok) throw new Error(`lua failed: ${r.error}`);
  return r.result?.values?.[0];
}
const readCmd = (conn) => lua(conn, "return CmdObj().cmdtext");
const readMa = (conn) => lua(conn, "return Root():Get('MAState')");
const readShortcuts = (conn) => lua(conn, "return CurrentProfile().KeyboardShortCuts.KEYBOARDSHORTCUTSACTIVE");
const setShortcuts = (conn, on) => lua(conn, `CurrentProfile().KeyboardShortCuts:Set('KeyboardShortcutsActive', ${on ? "true" : "false"}); return CurrentProfile().KeyboardShortCuts.KEYBOARDSHORTCUTSACTIVE`);
const readState = (conn) => lua(conn, "return { cmd = CmdObj().cmdtext, ma = Root():Get('MAState'), sc = CurrentProfile().KeyboardShortCuts.KEYBOARDSHORTCUTSACTIVE, profile = CurrentProfile().name }");
/** feedback.read is never [busy]: reads during an interaction go through it. */
async function fb(conn, reader) {
  const r = await conn.request("feedback.read", { readers: [reader] });
  if (!r.ok) throw new Error(`feedback.read failed: ${r.error}`);
  const it = (r.result.items || []).find((i) => i.name === reader);
  return it?.available ? it.value : undefined;
}
async function until(reader, pred, timeoutMs = 1500) {
  const t0 = Date.now();
  let v;
  for (;;) {
    v = await reader();
    if (pred(v)) return { ok: true, value: v, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { ok: false, value: v, ms: Date.now() - t0 };
    await sleep(40);
  }
}
async function pollStatus(conn, predicate, timeoutMs) {
  const untilT = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await conn.request("input.status");
    if (last.ok && predicate(last.result)) return last.result;
    if (Date.now() > untilT) return last.ok ? last.result : null;
    await sleep(50);
  }
}
const holdIn = (st, id) => (st.status.holds || []).find((h) => h.id === id);
/** Escape clears the command line (synchronous with shortcuts off, next frame with shortcuts on). */
async function clearLine(conn) {
  await lua(conn, "Keyboard(1, 'press', 'Escape', false, false, false, false); Keyboard(1, 'release', 'Escape', false, false, false, false); return true");
  return until(() => readCmd(conn), (v) => v === "", 1500);
}

// --- deferred macro (operator actions while the bridge is busy), as in scripts/kb13-probe.mjs --------------
const macroName = (n) => `Macro ${n}`;
async function readMacro(conn, n) {
  return lua(conn, `local m = ObjectList("${macroName(n)}")[1]; if not m then return false end
    local lines = {}
    for i = 1, m:Count() do local l = m:Ptr(i); lines[#lines + 1] = { cmd = tostring(l:Get("Command")), wait = tostring(l:Get("Wait")) } end
    return { name = tostring(m.name), lines = lines }`);
}
let deferredExpected = null;
export function verifyDeferredMacro(expected, actual) {
  if (!expected) return { ok: false, reason: "no expectation recorded" };
  if (!actual) return { ok: false, reason: "the macro is gone" };
  if (actual.name !== expected.name) return { ok: false, reason: `name is "${actual.name}" (expected "${expected.name}")` };
  const a = actual.lines || [], e = expected.lines || [];
  if (a.length !== e.length) return { ok: false, reason: `${a.length} line(s) (expected ${e.length})` };
  for (let i = 0; i < e.length; i++) {
    if (a[i].cmd !== e[i].cmd || a[i].wait !== e[i].wait) return { ok: false, reason: `line ${i + 1} is ${JSON.stringify(a[i])} (expected ${JSON.stringify(e[i])})` };
  }
  return { ok: true };
}
async function claimDeferredMacro(conn) {
  const existing = await readMacro(conn, DEFERRED_MACRO);
  if (existing) { console.error(`Macro ${DEFERRED_MACRO} is occupied ("${existing.name}", ${(existing.lines || []).length} line(s)); the deferred slot must be empty (pass --deferred-macro N)`); process.exit(2); }
  await lua(conn, `Cmd('Store Macro ${DEFERRED_MACRO} /NoConfirmation'); local m = ObjectList("${macroName(DEFERRED_MACRO)}")[1]; m:Set("Name", "${DEFERRED_NAME}"); return true`);
  deferredCreated = true;
  deferredExpected = await readMacro(conn, DEFERRED_MACRO);
  if (!deferredExpected || deferredExpected.name !== DEFERRED_NAME) { console.error(`creating Macro ${DEFERRED_MACRO} did not read back as "${DEFERRED_NAME}"`); process.exit(2); }
  note("deferred macro claimed", { macro: DEFERRED_MACRO, name: deferredExpected.name, lines: deferredExpected.lines.length });
}
async function releaseDeferredMacro(conn) {
  if (!deferredCreated) return { deleted: false, reason: "not created by this run" };
  const v = verifyDeferredMacro(deferredExpected, await readMacro(conn, DEFERRED_MACRO));
  if (!v.ok) return { deleted: false, reason: `left in place: ${v.reason}` };
  await lua(conn, `Cmd('Delete Macro ${DEFERRED_MACRO} /NoConfirmation'); return true`);
  return { deleted: !(await readMacro(conn, DEFERRED_MACRO)) };
}
async function deferred(conn, lines) {
  // The console reads a numeric Wait back as "2.0": write it that way so the readback comparison is exact.
  lines = lines.map((l) => ({ cmd: l.cmd, wait: l.wait == null ? "Follow" : typeof l.wait === "number" ? l.wait.toFixed(1) : String(l.wait) }));
  const v = verifyDeferredMacro(deferredExpected, await readMacro(conn, DEFERRED_MACRO));
  if (!v.ok) throw new Error(`deferred macro ${DEFERRED_MACRO} changed since the probe last wrote it (${v.reason}); not rewritten`);
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  await lua(conn, `local m = ObjectList("${macroName(DEFERRED_MACRO)}")[1]
    while m:Count() > 0 do Cmd('Delete ${macroName(DEFERRED_MACRO)}.1 /NoConfirmation') end
    ${lines.map((l, i) => `Cmd('Store ${macroName(DEFERRED_MACRO)}.${i + 1} /NoConfirmation'); do local l = m:Ptr(${i + 1}); l:Set("Command", "${esc(l.cmd)}"); l:Set("Wait", "${esc(String(l.wait))}") end`).join("\n")}
    return true`);
  deferredExpected = await readMacro(conn, DEFERRED_MACRO);
  const check = verifyDeferredMacro({ name: DEFERRED_NAME, lines: lines.map((l) => ({ cmd: l.cmd, wait: String(l.wait) })) }, deferredExpected);
  if (!check.ok) throw new Error(`deferred macro ${DEFERRED_MACRO} did not read back as written (${check.reason})`);
  await lua(conn, `Cmd('Go+ ${macroName(DEFERRED_MACRO)}'); return true`);
  return Date.now();
}
// The operator's own toggle, as a command line usable from a macro: the profile's KeyboardShortCuts object
// address is read from the console (UserProfile N.M) so the probe never guesses an index.
async function shortcutsSetCommand(conn, on) {
  const addr = await lua(conn, "return CurrentProfile().KeyboardShortCuts:ToAddr()");
  if (typeof addr !== "string" || !/^UserProfile \d+\.\d+$/.test(addr)) throw new Error(`unexpected KeyboardShortCuts address ${JSON.stringify(addr)}`);
  return `Set ${addr} Property "KeyboardShortcutsActive" "${on ? "true" : "false"}"`;
}

async function preflight(A, needInput) {
  const pingR = await A.request("ping");
  if (!pingR.ok) throw new Error(`ping failed: ${pingR.error}`);
  const ping = pingR.result;
  console.log(`bridge ${ping.bridgeVersion} on ${ping.host}:${ping.port}; show "${ping.showfile ?? ""}"; input ${ping.input ? (ping.input.enabled ? `enabled (${ping.input.backend})` : "disabled") : "not reported"}; lua ${ping.lua?.enabled ? "on" : "off"}; modules ${JSON.stringify(ping.modules?.hardkeys)}`);
  if (!SHOW_GUARD.test(String(ping.showfile ?? ""))) { console.error(`show "${ping.showfile}" does not look disposable; refusing to press console keys or toggle the shortcut mode`); process.exit(2); }
  if (!ping.lua?.enabled) { console.error('Lua execution is off on the bridge; the probe verifies through CmdObj()/MASTATE/the profile and needs  Plugin "gma3_mcp_bridge" "lua on"'); process.exit(2); }
  if (needInput) {
    const [maj, min] = String(ping.bridgeVersion ?? "0.0").split(".").map(Number);
    if (!ping.input || maj < 0 || (maj === 0 && min < 11)) { console.error(`bridge ${ping.bridgeVersion} has no KB-14 routing ops; update the plugin to 0.11.0 or newer (docs/setup/bridge.md)`); process.exit(2); }
    if (!ping.input.enabled || ping.input.backend !== "keyboard") { console.error('input is not enabled on the keyboard backend:  Plugin "gma3_mcp_bridge" "input=keyboard"  (console keys WILL be pressed)'); process.exit(2); }
  }
  if (ping.input && (ping.input.holds > 0 || ping.input.unresolved > 0 || ping.input.unresolvedFromPreviousRun > 0 || ping.input.busy || ping.input.modeChange)) {
    console.error(`the bridge already has holds, unresolved records or a pending mode change; resolve them first (input status / input recover): ${JSON.stringify(ping.input)}`); process.exit(2);
  }
  const st = await readState(A);
  if (st.cmd !== "" || st.ma !== false || typeof st.sc !== "boolean") { console.error(`console not idle: ${JSON.stringify(st)}`); process.exit(2); }
  note("initial console state", st);
  return { ping, initial: st };
}

// --- timing ---------------------------------------------------------------------------------------------------
async function timing() {
  const A = new Conn("A");
  await A.connect();
  const { ping, initial } = await preflight(A, false);
  const sc0 = initial.sc;
  const restore = async () => { await setShortcuts(A, sc0); await clearLine(A); };
  try {
    // 1. Baselines: char events with shortcuts ON are dropped; the char argument is a string, not a code point.
    await setShortcuts(A, true);
    let r = await lua(A, "Keyboard(1, 'char', 's'); Keyboard(1, 'char', '5'); return CmdObj().cmdtext");
    await sleep(80);
    let after = await readCmd(A);
    record("char events while shortcuts are ON reach neither the command line nor the shortcut table (dropped)", r === "" && after === "", { sameChunk: r, nextRequest: after });
    await setShortcuts(A, false);
    r = await lua(A, "Keyboard(1, 'char', 115); local a = CmdObj().cmdtext; Keyboard(1, 'press', 'Escape', false, false, false, false); Keyboard(1, 'release', 'Escape', false, false, false, false); return a");
    record("a numeric char argument is stringified (115 -> '1'): the backend must pass one character, never a code point number", r === "1", { sameChunk: r });
    await clearLine(A);
    // 2. Character events are consumed synchronously; Escape with shortcuts OFF too.
    r = await lua(A, "Keyboard(1, 'char', 's'); Keyboard(1, 'char', utf8.char(0x20AC)); local a = CmdObj().cmdtext; Keyboard(1, 'press', 'Escape', false, false, false, false); Keyboard(1, 'release', 'Escape', false, false, false, false); return { typed = a, afterEscape = CmdObj().cmdtext }");
    record("with shortcuts OFF, char events land in the same chunk (one character per call, UTF-8) and Escape clears in the same chunk", r.typed === "s€" && r.afterEscape === "", r);
    // 3. T1: disable, type, re-enable in ONE chunk -> the text is there (consumed before the restore).
    await setShortcuts(A, true);
    r = await lua(A, "local sc = CurrentProfile().KeyboardShortCuts; sc:Set('KeyboardShortcutsActive', false); Keyboard(1, 'char', 'x'); Keyboard(1, 'char', '5'); local a = CmdObj().cmdtext; sc:Set('KeyboardShortcutsActive', true); return { typed = a, restored = sc.KEYBOARDSHORTCUTSACTIVE }");
    await sleep(80);
    after = await readCmd(A);
    record("T1: disable -> chars -> re-enable in one chunk: the characters were consumed before the restore", r.typed === "x5" && r.restored === true && after === "x5", { ...r, nextRequest: after });
    // Escape with shortcuts ON is consumed on the NEXT frame (not in the chunk).
    r = await lua(A, "Keyboard(1, 'press', 'Escape', false, false, false, false); Keyboard(1, 'release', 'Escape', false, false, false, false); return CmdObj().cmdtext");
    let obs = await until(() => readCmd(A), (v) => v === "", 1500);
    record("Escape with shortcuts ON is consumed on a later frame (line unchanged in the chunk, cleared afterwards)", r === "x5" && obs.ok, { sameChunk: r, clearedAfterMs: obs.ms });
    // 4. S1: enable, tap S (shortcut row STORE), disable in ONE chunk -> "Store " (consumed in the chunk).
    await setShortcuts(A, false);
    r = await lua(A, "local sc = CurrentProfile().KeyboardShortCuts; sc:Set('KeyboardShortcutsActive', true); Keyboard(1, 'press', 'S', false, false, false, false); Keyboard(1, 'release', 'S', false, false, false, false); local a = CmdObj().cmdtext; sc:Set('KeyboardShortcutsActive', false); return { afterTap = a, restored = sc.KEYBOARDSHORTCUTSACTIVE == false }");
    await sleep(80);
    after = await readCmd(A);
    record("S1: enable -> tap S -> disable in one chunk: the shortcut STORE was consumed in the chunk and survives the restore", r.afterTap === "Store " && r.restored && after === "Store ", { ...r, nextRequest: after });
    await clearLine(A);
    // 5. H1: enable, press LeftShift (MA), disable in ONE chunk -> MA never registers (consumed next frame, under OFF).
    // The modifier press is the unstable case: the first (manual) run of this sequence saw MA never register
    // (consumed after the same-chunk restore, under OFF); the scripted runs saw it register. Both are recorded;
    // the module relies on neither (it keeps the mode until the release and restores one delay later).
    r = await lua(A, "local sc = CurrentProfile().KeyboardShortCuts; sc:Set('KeyboardShortcutsActive', true); Keyboard(1, 'press', 'LeftShift', true, false, false, false); local a = Root():Get('MAState'); sc:Set('KeyboardShortcutsActive', false); return { maSameChunk = a, maAfterDisable = Root():Get('MAState') }");
    await sleep(120);
    let ma = await readMa(A);
    note("H1: enable -> press LeftShift -> disable in one chunk (observation; unstable across runs)", { ...r, nextRequest: ma });
    if (ma === true) {
      // A modifier that registered under the temporary mode: releasing it under the restored (OFF) mode did NOT
      // lift it in an earlier run (MASTATE stayed true). The release must happen in the mode of the press.
      r = await lua(A, "Keyboard(1, 'release', 'LeftShift', false, false, false, false); return Root():Get('MAState')");
      obs = await until(() => readMa(A), (v) => v === false, 800);
      note("H1: a release under the restored OFF mode", { sameChunk: r, liftedWithinMs: obs.ok ? obs.ms : null, stillDown: !obs.ok });
      r = await lua(A, "local sc = CurrentProfile().KeyboardShortCuts; sc:Set('KeyboardShortcutsActive', true); Keyboard(1, 'press', 'LeftShift', true, false, false, false); Keyboard(1, 'release', 'LeftShift', false, false, false, false); local a = Root():Get('MAState'); sc:Set('KeyboardShortcutsActive', false); return a");
      obs = await until(() => readMa(A), (v) => v === false, 1500);
      record("H1: the key is lifted by a press/release pair in the mode it was pressed in (shortcuts ON); the module keeps the mode through the release for this reason", obs.ok, { sameChunk: r, falseAfterMs: obs.ms });
    } else {
      r = await lua(A, "Keyboard(1, 'release', 'LeftShift', false, false, false, false); return Root():Get('MAState')");
      obs = await until(() => readMa(A), (v) => v === false, 1500);
      record("H1: the press never registered; the release under OFF leaves MASTATE false", obs.ok, { sameChunk: r, falseAfterMs: obs.ms });
    }
    // 6. H0: enable, press LeftShift, keep ON -> MA registers (in the chunk or on a later frame); disabling while held drops MA.
    r = await lua(A, "CurrentProfile().KeyboardShortCuts:Set('KeyboardShortcutsActive', true); Keyboard(1, 'press', 'LeftShift', true, false, false, false); return Root():Get('MAState')");
    obs = await until(() => readMa(A), (v) => v === true, 1500);
    record("H0: with the mode kept ON the MA press registers (in the chunk or on a later frame)", obs.ok, { sameChunk: r, trueAfterMs: obs.ms });
    r = await lua(A, "CurrentProfile().KeyboardShortCuts:Set('KeyboardShortcutsActive', false); return Root():Get('MAState')");
    obs = await until(() => readMa(A), (v) => v === false, 1500);
    record("disabling shortcuts while MA is held drops MA by itself (restoring the mode ends a modifier hold)", r === true && obs.ok, { sameChunk: r, falseAfterMs: obs.ms });
    r = await lua(A, "Keyboard(1, 'release', 'LeftShift', false, false, false, false); return Root():Get('MAState')");
    record("the release under OFF leaves MASTATE false", r === false);
  } finally {
    await restore();
  }
  const final = await readState(A);
  record("console left as found: shortcut mode restored, command line empty, MASTATE false", final.sc === sc0 && final.cmd === "" && final.ma === false, final);
  await A.end();
  return { ping, final };
}

// --- run ------------------------------------------------------------------------------------------------------
const POLICY = { keys: { NUM5: { method: "type", text: "5" }, THRU: { method: "type", text: "Thru " }, FIXTURE: { method: "shortcutOrType", text: "Fixture " }, STORE: { method: "shortcut" } } };

async function run() {
  const A = new Conn("A");
  await A.connect();
  const { ping, initial } = await preflight(A, true);
  const sc0 = initial.sc;
  await claimDeferredMacro(A);
  let r = await A.request("input.open", { leaseMs: 60000, label: "kb14-probe" });
  record("session opened", r.ok, errorOf(r));
  try {
    // 1. Routing ops.
    r = await A.request("input.routing");
    record("input.routing reports the module default with type available on the keyboard backend", r.ok && r.result.routing.default === "shortcut" && r.result.routing.methods.type.available === true && r.result.routing.capabilities.modeChange === true, r.ok ? r.result.routing.methods : r.error);
    r = await A.request("input.routing", { policy: POLICY });
    record("the KB-14 policy is accepted (NUM5/THRU type, FIXTURE shortcutOrType, STORE shortcut)", r.ok && r.result.routing.overrideCount === 4, errorOf(r));
    await setShortcuts(A, true);
    r = await A.request("input.route", { key: "NUM5" });
    record("input.route NUM5 with shortcuts on: text route, mode change to off, dispatchable", r.ok && r.result.route.effective === "text" && r.result.route.modeChange?.target === false && r.result.route.dispatchable === true, r.ok ? r.result.route : r.error);
    r = await A.request("input.route", { key: "STORE" });
    record("input.route STORE with shortcuts on: shortcut-table route, no mode change", r.ok && r.result.route.effective === "shortcut-table" && !r.result.route.modeChange, r.ok ? r.result.route.effective : r.error);
    // 2. type with shortcuts ON: temporary disable, insertion, delayed restore.
    r = await A.request("input.tap", { key: "NUM5" });
    const t5 = r.result?.hold;
    record("type NUM5 (shortcuts on): the mode was changed, '5' inserted, record retained", r.ok && t5.kind === "text" && t5.state === "retained" && t5.text.typed === 1 && t5.modeOp, r.ok ? { state: t5.state, modeOp: t5.modeOp, text: t5.text } : r.error);
    let st = await A.request("input.status");
    record("input.status reports the active mode change (profile, original on -> target off, dependents)", st.ok && st.result.status.modeChange?.state === "active" && st.result.status.modeChange.original === true && st.result.status.modeChange.target === false && st.result.status.modeChange.dependents?.[0]?.hold === t5.id, st.result?.status?.modeChange);
    st = await pollStatus(A, (s) => s.status.modeChange == null, 2000);
    const t5after = holdIn(st, t5.id);
    let cs = await readState(A);
    record("the loop restored the mode after the delay; the record is released; shortcuts read on again; '5' is on the command line", st.status.lastModeChange?.restoredBy === "service" && t5after?.state === "released" && cs.sc === true && cs.cmd === "5", { lastModeChange: st.status.lastModeChange?.state, hold: t5after?.state, console: cs });
    record("the text readback observed the command line", t5after?.text?.readback?.outcome === "observed", t5after?.text?.readback);
    // consecutive text taps share one change
    r = await A.request("input.tap", { key: "THRU" });
    const tThru = r.result?.hold;
    const r2 = await A.request("input.tap", { key: "NUM5" });
    record("two consecutive text taps each get a mode operation (joined when the second arrives within the restore delay, sequential otherwise)", r.ok && r2.ok && tThru.modeOp && r2.result.hold.modeOp, { first: tThru?.modeOp, second: r2.result?.hold?.modeOp, joined: r2.result?.hold?.modeOp === tThru?.modeOp, err: errorOf(r) || errorOf(r2) });
    st = await pollStatus(A, (s) => s.status.modeChange == null, 2000);
    cs = await readState(A);
    record("after the restore the command line holds the whole insertion and shortcuts are on", cs.cmd === "5Thru 5" && cs.sc === true, cs);
    await clearLine(A);
    // 3. shortcutOrType with shortcuts ON and a row: the shortcut side, no mode change.
    r = await A.request("input.tap", { key: "FIXTURE" });
    let obs = await until(() => fb(A, "commandText"), (v) => v === "Fixture ", 1500);  // feedback.read: never busy
    record("shortcutOrType FIXTURE with shortcuts on: shortcut route (F), no mode change, 'Fixture ' on the line", r.ok && r.result.hold.route.source === "shortcut-table" && !r.result.hold.modeOp && obs.ok, { route: r.result?.hold?.route?.source, cmdAfterMs: obs.ms, err: errorOf(r) });
    await pollStatus(A, (s) => (s.status.holds || []).every((h) => h.state === "released"), 2000);
    await clearLine(A);
    // 4. Shortcuts OFF: text without a change; shortcutOrType takes its text side; STORE enables temporarily.
    await setShortcuts(A, false);
    r = await A.request("input.tap", { key: "NUM5" });
    record("type NUM5 with shortcuts off: inserted without a mode change, released at once", r.ok && r.result.hold.state === "released" && !r.result.hold.modeOp, r.ok ? r.result.hold.state : r.error);
    r = await A.request("input.tap", { key: "FIXTURE" });
    record("shortcutOrType FIXTURE with shortcuts off: the text side ('Fixture '), no mode change", r.ok && r.result.hold.kind === "text" && r.result.hold.route.textSelectedBecause?.includes("off") && !r.result.hold.modeOp, r.ok ? r.result.hold.route : r.error);
    cs = await readState(A);
    record("the command line shows '5Fixture ' and shortcuts stayed off", cs.cmd === "5Fixture " && cs.sc === false, cs);
    await clearLine(A);
    r = await A.request("input.tap", { key: "STORE", holdMs: 60 });
    const tS = r.result?.hold;
    record("shortcut STORE with shortcuts off: temporarily enabled, pressed through the row, held", r.ok && tS.route.source === "shortcut-table" && tS.route.modeChange?.target === true && tS.modeOp, r.ok ? { modeOp: tS.modeOp, route: tS.route.source } : r.error);
    st = await pollStatus(A, (s) => s.status.modeChange == null, 2500);
    cs = await readState(A);
    record("the tap released, the mode was restored to off afterwards, 'Store ' is on the line", holdIn(st, tS.id)?.state === "released" && cs.sc === false && cs.cmd === "Store ", { hold: holdIn(st, tS.id)?.state, console: cs });
    await clearLine(A);
    // 5. A held shortcut with the mode retained through the hold, restored after the release.
    r = await A.request("input.begin", { leaseMs: 30000, label: "kb14 hold" });
    const IA = r.result?.interaction?.id;
    r = await A.request("input.press", { key: "STORE", interaction: IA });
    const hS = r.result?.hold;
    record("STORE held with shortcuts off: the mode is enabled for the hold", r.ok && hS.state === "held" && hS.modeOp, r.ok ? hS.modeOp : r.error);
    await sleep(600);
    st = await A.request("input.status");
    let cmd = await fb(A, "commandText");
    record("600 ms into the hold the mode change is still active (kept through the hold) and 'Store ' is on the line", st.result.status.modeChange?.state === "active" && holdIn(st.result, hS.id)?.state === "held" && cmd === "Store ", { mode: st.result.status.modeChange?.state, cmd });
    r = await A.request("input.press", { key: "THRU", interaction: IA });
    record("a text route (needs off) during the enabled hold is refused as mode-conflict, nothing typed", !r.ok && r.code === "mode-conflict", r.error);
    r = await A.request("input.release", { hold: hS.id });
    record("released: dispatched, record retained for the restoration", r.ok && r.result.hold.state === "retained" && r.result.hold.releaseOutcome === "dispatched", r.ok ? r.result.hold.state : r.error);
    r = await A.request("input.end", { interaction: IA });
    st = await pollStatus(A, (s) => s.status.modeChange == null, 2000);
    cs = await readState(A);
    record("after the release the mode was restored to off and the record released", holdIn(st, hS.id)?.state === "released" && cs.sc === false, { hold: holdIn(st, hS.id)?.state, console: cs });
    await clearLine(A);
    // 6. Interference: the operator disables shortcuts (F10 stand-in) during a temporarily enabled hold.
    const offCmd = await shortcutsSetCommand(A, false);
    const onCmd = await shortcutsSetCommand(A, true);
    // A line's Wait is the delay AFTER it (before the next line), so the first delay rides on an Echo line:
    // shortcuts off at +2 s, on again at +7 s.
    const t0 = await deferred(A, [{ cmd: "Echo kb14 deferred start", wait: 2 }, { cmd: offCmd, wait: 5 }, { cmd: onCmd }]);
    r = await A.request("input.begin", { leaseMs: 30000, label: "kb14 interference" });
    const IB = r.result?.interaction?.id;
    r = await A.request("input.press", { key: "STORE", interaction: IB });
    const hI = r.result?.hold;
    record("STORE held with the mode enabled; the operator will disable shortcuts in 2 s", r.ok && hI.modeOp, errorOf(r));
    st = await pollStatus(A, (s) => s.status.modeChange == null, 4000);
    record("the operator's disable is seen by the loop: the mode operation resolves to the operator's state (nothing written), the hold stays held", st.status.modeChange == null && st.status.lastModeChange?.restoredBy === "operator" && st.status.lastModeChange?.interference != null && holdIn(st, hI.id)?.state === "held", { last: st.status.lastModeChange?.restoredBy, interference: st.status.lastModeChange?.interference?.note, after: Date.now() - t0 });
    r = await A.request("input.release", { hold: hI.id });
    record("the release under the changed route is a route change (shortcuts now inactive) and stays unresolved: the console did not lift the key", r.ok && r.result.hold.state === "unresolved" && r.result.hold.routeMismatch?.reason?.includes("inactive"), r.ok ? { reason: r.result.hold.unresolved?.reason, mismatch: r.result.hold.routeMismatch?.reason } : r.error);
    r = await A.request("input.press", { key: "NUM5", interaction: IB });
    record("new input is refused while the record is unresolved", !r.ok && (r.code === "route-changed" || r.code === "busy" || r.code === "conflict"), r.error);
    await sleep(Math.max(0, t0 + 7000 + 300 - Date.now()));
    r = await A.request("input.recover");
    record("after the operator restores shortcuts, owner recover releases the record through the stored tuple (route restored)", r.ok && r.result.released?.length === 1, r.ok ? r.result : r.error);
    st = await A.request("input.status");
    record("the record reports the route as restored and is released", holdIn(st.result, hI.id)?.state === "released" && holdIn(st.result, hI.id)?.routeRestored != null, holdIn(st.result, hI.id)?.routeRestored);
    await A.request("input.end", { interaction: IB });
    cs = await readState(A);
    record("shortcuts are left in the operator's state (on); the module did not overwrite it", cs.sc === true, cs);
    await clearLine(A);
    await setShortcuts(A, false);
    // 7. Clean up.
    r = await A.request("input.routing", { policy: {} });
    record("routing policy back to the module default", r.ok && r.result.routing.overrideCount === 0, errorOf(r));
  } finally {
    await A.request("input.releaseAll");
    await A.request("input.close");
    await pollStatus(A, (s) => s.status.modeChange == null && (s.status.holds || []).every((h) => h.state === "released"), 3000);
    await setShortcuts(A, sc0);
    await clearLine(A);
  }
  const finalPing = (await A.request("ping")).result;
  const final = await readState(A);
  record("console and bridge left clean: no holds, nothing unresolved, no mode change, shortcut mode as found, empty command line, MASTATE false", finalPing?.input?.holds === 0 && finalPing?.input?.unresolved === 0 && !finalPing?.input?.busy && !finalPing?.input?.modeChange && final.sc === sc0 && final.cmd === "" && final.ma === false, { input: finalPing?.input, console: final });
  const rel = await releaseDeferredMacro(A);
  record("the deferred macro this run created is verified by contents and removed (an edited one would be preserved)", rel.deleted === true, rel);
  await A.end();
  return { ping, finalPing, final };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  if (mode !== "timing" && mode !== "run") {
    console.error("usage: node scripts/kb14-probe.mjs timing|run [--out report.json] [--deferred-macro N]");
    process.exit(2);
  }
  if (!Number.isInteger(DEFERRED_MACRO) || DEFERRED_MACRO < 1) { console.error("--deferred-macro must be a positive macro number"); process.exit(2); }
  (mode === "timing" ? timing() : run()).then((res) => {
    const report = { probe: `kb-14-${mode}`, date: new Date().toISOString(), bridge: { version: res.ping.bridgeVersion, host: res.ping.host, port: res.ping.port, build: res.ping.build, hostname: res.ping.hostname, showfile: res.ping.showfile, input: res.ping.input, modules: res.ping.modules }, passed: steps.filter((s) => s.pass === true).length, failed, steps, final: res.final, finalInput: res.finalPing?.input };
    if (outFile) { fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + "\n"); console.log(`report written to ${outFile}`); }
    console.log(`${report.passed}/${steps.filter((s) => s.pass !== null).length} passed`);
    process.exit(failed ? 1 : 0);
  }).catch(async (e) => {
    console.error(`probe aborted: ${e.message}`);
    // Leave nothing behind that a rerun would refuse: the deferred macro is removed only if it still reads back
    // exactly as this run last wrote it (an edited one is preserved and reported).
    if (deferredCreated) {
      try { const B = new Conn("cleanup"); await B.connect(); console.error(`deferred macro: ${JSON.stringify(await releaseDeferredMacro(B))}`); await B.end(); } catch (e2) { console.error(`deferred macro left in place: ${e2.message}`); }
    }
    process.exit(2);
  });
}
