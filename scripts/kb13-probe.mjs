#!/usr/bin/env node
// KB-13 owned-Quickey backend probe against a RUNNING bridge started with  Plugin "gma3_mcp_bridge" "lua input=quickey"
// and a provisioned bank (bank=900/1.180-187, see KEYBOARD.md "KB-13", docs/setup/bridge.md). Console keys ARE
// pressed through the bank's Quickeys on the reserved executors: run it only on a disposable show.
//
//   node scripts/kb13-probe.mjs run [--out report.json] [--restart-macro 115] [--teardown-macro 113] [--deferred-macro 116]
//
// Over one real TCP connection it exercises taps (NUM5, OOPS), a hold (MA1 with MASTATE readback), duplicate
// suppression, the MA1+STORE chord (Record), the Fixture 1 Thru 5 Please sequence with CLEAR, capability and
// discovered-code refusals, an executor reassigned by the operator during a hold (release refused, recovery after
// the operator restores it), a bridge restart with such a stuck hold (the record and its executor target survive,
// operator recovery releases it), and the teardown refusal while a hold is live. Operator-side actions that must
// happen while the bridge is [busy] (a hold, an unresolved record) cannot be issued through the bridge, so the
// probe writes them into the DEFERRED macro (default Macro 116) with Wait times and fires it through "lua" before
// the hold starts: the console executes the lines on its own while the bridge is busy. The deferred slot must be
// EMPTY: the probe creates the macro ("MCP kb13 deferred"), verifies its name and exact contents before every rewrite
// and before deleting it at the end, and leaves it in place if anything changed meanwhile; an occupied slot (a macro
// of that name from an earlier run included) refuses the run before any key is pressed, and the slot may not be the
// restart or teardown macro. The restart macro (default 115: stop + "lua
// input=quickey") and the teardown macro (default 113: "bank teardown") must exist in the show. Reads happen through the unguarded feedback.read op during interactions and through
// "lua" otherwise. Nothing is retried or replayed.
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
const RESTART_MACRO = Number(opt("--restart-macro", 115));
const TEARDOWN_MACRO = Number(opt("--teardown-macro", 113));
const DEFERRED_MACRO = Number(opt("--deferred-macro", 116));
const DEFERRED_NAME = "MCP kb13 deferred";
let deferredCreated = false;  // whether this run created the deferred macro (then it is deleted at the end)
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
  destroy() { this.sock?.destroy(); }
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
const codeIs = (r, code) => !r.ok && (r.code === code || r.error.includes(`[${code}]`));

async function lua(conn, code) {
  const r = await conn.request("lua", { code });
  if (!r.ok) throw new Error(`lua failed: ${r.error}`);
  return r.result?.values?.[0];
}
const readCmd = (conn) => lua(conn, "return CmdObj().cmdtext");
const readMa = (conn) => lua(conn, "return Root():Get('MAState')");
const readSel = (conn) => lua(conn, "return SelectionCount()");
const readExec = (conn, n) => lua(conn, `local h = ObjectList('Page 1.${n}')[1]; if not h then return 'empty' end local o = h:Get('Object'); return o and tostring(o.name) or 'noobj'`);
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
    await sleep(60);
  }
}
async function pollStatus(conn, predicate, timeoutMs) {
  const untilT = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await conn.request("input.status");
    if (last.ok && predicate(last.result)) return last.result;
    if (Date.now() > untilT) return last.ok ? last.result : null;
    await sleep(100);
  }
}
async function waitSequence(conn, id, timeoutMs) {
  const untilT = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await conn.request("input.sequence.status", { sequence: id });
    if (!last.ok) return last;
    if (last.result.state !== "running" || Date.now() > untilT) return last;
    await sleep(60);
  }
}
/**
 * Deferred operator actions: writes the lines into the deferred macro (command + Wait seconds before the NEXT
 * line) and fires it. Called only while the bridge is idle; the console runs the lines while the bridge is busy.
 */
const macroName = (conn, n) => lua(conn, `local m = ObjectList('Macro ${n}')[1]; return m and tostring(m.name) or false`);
/** Name and every line (command + wait) of a macro as the console reads them back, or false when the slot is empty. */
const readMacro = (conn, n) => lua(conn, `local m = ObjectList('Macro ${n}')[1]; if not m then return false end local lines = {} for i = 1, m:Count() do local l = m:Ptr(i); lines[#lines + 1] = { cmd = tostring(l:Get('Command')), wait = tostring(l:Get('Wait')) } end return { name = tostring(m.name), lines = lines }`);
let expectedDeferred = null;  // the deferred macro exactly as this run last wrote and read it back; nothing else is ever rewritten or deleted
/**
 * Identity check of the deferred macro against what this run last wrote: same name and the same lines (command and
 * wait, as read back). Pure, so it can be tested. Returns { ok: true } or { ok: false, reason }.
 */
export function verifyDeferredMacro(expected, actual) {
  if (!expected) return { ok: false, reason: "this run has not created the deferred macro" };
  if (actual === false || actual == null) return { ok: false, reason: "the macro no longer exists" };
  if (actual.name !== expected.name) return { ok: false, reason: `name is now ${JSON.stringify(actual.name)}, expected ${JSON.stringify(expected.name)}` };
  const a = actual.lines || [], e = expected.lines || [];
  if (a.length !== e.length) return { ok: false, reason: `${a.length} line(s) instead of ${e.length}` };
  for (let i = 0; i < e.length; i++) {
    if (a[i].cmd !== e[i].cmd || String(a[i].wait) !== String(e[i].wait)) {
      return { ok: false, reason: `line ${i + 1} is ${JSON.stringify(a[i])}, expected ${JSON.stringify(e[i])}` };
    }
  }
  return { ok: true };
}
/**
 * Claims the deferred slot before any key is pressed: it must be EMPTY. The probe creates the macro, names it and
 * records its contents; from then on every rewrite and the final deletion first verify that name and contents are
 * exactly what the probe last wrote, so an operator's edit (or any other macro, however it is named) is never
 * overwritten or deleted. A disposable show name says nothing about who owns a macro.
 */
async function claimDeferredMacro(conn) {
  const existing = await readMacro(conn, DEFERRED_MACRO);
  if (existing !== false) {
    console.error(`Macro ${DEFERRED_MACRO} is occupied by "${existing.name}" (${(existing.lines || []).length} line(s)); the probe needs an EMPTY slot it can create and remove itself${existing.name === DEFERRED_NAME ? " (a macro of the probe's own name left by an earlier run is not reused: remove it yourself if it is yours)" : ""}. Pass --deferred-macro <free slot>.`);
    process.exit(2);
  }
  const created = await lua(conn, `Cmd('Store Macro ${DEFERRED_MACRO} /NoConfirmation'); local m = ObjectList('Macro ${DEFERRED_MACRO}')[1]; if not m then return false end m:Set('Name', '${DEFERRED_NAME}'); return true`);
  const read = await readMacro(conn, DEFERRED_MACRO);
  if (created !== true || read === false || read.name !== DEFERRED_NAME) { console.error(`could not create the deferred Macro ${DEFERRED_MACRO} (read back ${JSON.stringify(read)})`); process.exit(2); }
  expectedDeferred = read;
  note("deferred macro", `Macro ${DEFERRED_MACRO} created as "${DEFERRED_NAME}" with ${read.lines.length} line(s); verified by contents before every rewrite and deleted at the end of the run`);
  for (const [label, n] of [["restart", RESTART_MACRO], ["teardown", TEARDOWN_MACRO]]) {
    const nm = await macroName(conn, n);
    if (nm === false) { console.error(`the ${label} macro (Macro ${n}) does not exist in this show`); process.exit(2); }
    note(`${label} macro`, `Macro ${n} "${nm}"`);
  }
}
/** Deletes the deferred macro only when this run created it and it still reads back exactly as last written. */
async function releaseDeferredMacro(conn) {
  if (!expectedDeferred) return { skipped: true, reason: "not created by this run" };
  const actual = await readMacro(conn, DEFERRED_MACRO);
  const v = verifyDeferredMacro(expectedDeferred, actual);
  if (!v.ok) return { skipped: true, preserved: true, reason: `Macro ${DEFERRED_MACRO} differs from what the probe last wrote (${v.reason}); left in place for the operator` };
  await lua(conn, `Cmd('Delete Macro ${DEFERRED_MACRO} /NoConfirmation'); return true`);
  return { deleted: (await readMacro(conn, DEFERRED_MACRO)) === false };
}
async function deferred(conn, lines) {
  const actual = await readMacro(conn, DEFERRED_MACRO);
  const v = verifyDeferredMacro(expectedDeferred, actual);
  if (!v.ok) throw new Error(`Macro ${DEFERRED_MACRO} differs from what the probe last wrote (${v.reason}); not rewritten, left in place`);
  const luaList = "{ " + lines.map((l) => `{ cmd = [==[${l.cmd}]==], wait = [==[${l.wait == null ? "Follow" : String(l.wait)}]==] }`).join(", ") + " }";
  const code = `
    local list = ${luaList}
    local m = ObjectList('Macro ${DEFERRED_MACRO}')[1]
    if not m or tostring(m.name) ~= '${DEFERRED_NAME}' then error('Macro ${DEFERRED_MACRO} is no longer the deferred macro of this probe (' .. tostring(m and m.name) .. '); refusing to write it', 0) end
    for i = m:Count() + 1, #list do Cmd(string.format('Store Macro %d.%d /NoConfirmation', ${DEFERRED_MACRO}, i)) end
    for i = 1, m:Count() do
      local l = m:Ptr(i)
      if list[i] then l:Set('Command', list[i].cmd); l:Set('Wait', list[i].wait) else l:Set('Command', 'Echo kb13 noop'); l:Set('Wait', 'Follow') end
    end
    local lines = {}
    for i = 1, m:Count() do local l = m:Ptr(i); lines[#lines + 1] = { cmd = tostring(l:Get('Command')), wait = tostring(l:Get('Wait')) } end
    Cmd('Go+ Macro ${DEFERRED_MACRO}')
    return { name = tostring(m.name), lines = lines }`;
  const written = await lua(conn, code);
  expectedDeferred = written;  // what the console read back after the write is the identity the next check expects
  note(`deferred macro ${DEFERRED_MACRO} fired`, written.lines.map((l) => `${l.cmd} | ${l.wait}`));
  return Date.now();
}
/** Escape through Keyboard() (an ESC Quickey never touches the command line, KB-10). Explicit, never implicit. */
async function clearLine(conn) {
  await lua(conn, "Keyboard(1, 'press', 'Escape'); Keyboard(1, 'release', 'Escape'); return true");
  return until(() => readCmd(conn), (v) => v === "", 1500);
}
const liveHold = (st) => (st.status.holds || []).find((h) => h.state !== "released");

async function preflight(A) {
  const pingR = await A.request("ping");
  if (!pingR.ok) throw new Error(`ping failed: ${pingR.error}`);
  const ping = pingR.result;
  console.log(`bridge ${ping.bridgeVersion} on ${ping.host}:${ping.port}; show "${ping.showfile ?? ""}"; input ${ping.input ? (ping.input.enabled ? `enabled (${ping.input.backend})` : "disabled") : "not reported"}; bank ${JSON.stringify(ping.input?.bank)}; lua ${ping.lua?.enabled ? "on" : "off"}`);
  const [maj, min] = String(ping.bridgeVersion ?? "0.0").split(".").map(Number);
  if (!ping.input || maj < 0 || (maj === 0 && min < 10)) { console.error(`bridge ${ping.bridgeVersion} has no Quickey backend; update the plugin to 0.10.0 or newer (docs/setup/bridge.md)`); process.exit(2); }
  if (!SHOW_GUARD.test(String(ping.showfile ?? ""))) { console.error(`show "${ping.showfile}" does not look disposable; refusing to press console keys`); process.exit(2); }
  if (!ping.lua?.enabled) { console.error('Lua execution is off on the bridge; the probe verifies through CmdObj()/MASTATE and needs  Plugin "gma3_mcp_bridge" "lua on"'); process.exit(2); }
  if (!ping.input.enabled || ping.input.backend !== "quickey") { console.error('input is not enabled on the quickey backend:  Plugin "gma3_mcp_bridge" "input=quickey"  (with a provisioned bank). Console keys WILL be pressed.'); process.exit(2); }
  if (!ping.input.bank?.provisioned || ping.input.bank.state !== "ready") { console.error(`no ready Quickey bank (${JSON.stringify(ping.input.bank)}); provision it with  Plugin "gma3_mcp_bridge" "bank=900/1.180-187"`); process.exit(2); }
  if (ping.input.holds > 0 || ping.input.unresolved > 0 || ping.input.unresolvedFromPreviousRun > 0 || ping.input.busy) { console.error(`the bridge already has holds or unresolved records; resolve them first (input status / input recover)`); process.exit(2); }
  const cmd = await readCmd(A);
  const ma = await readMa(A);
  if (cmd !== "" || ma !== false) { console.error(`console not idle: cmdtext=${JSON.stringify(cmd)} MASTATE=${ma}`); process.exit(2); }
  return ping;
}

async function run() {
  let A = new Conn("A");
  await A.connect();
  const ping = await preflight(A);
  await claimDeferredMacro(A);
  let r = await A.request("input.status");
  const bank = r.result.status.bank;
  const codeIndex = Object.fromEntries((bank.codes || []).map((c) => [c.name, c.index]));
  const EX = bank.spec.executors.first;
  note("bank", { id: bank.id, state: bank.state, codes: bank.codeCount, qualified: bank.qualifiedCount, executors: bank.spec.executors, MA1: codeIndex.MA1, NUM5: codeIndex.NUM5, THRU: codeIndex.THRU });
  record("status reports the quickey backend with its limitations and the quickkey routing default", r.result.status.backend.name === "quickey" && r.result.status.backend.capabilities.keyboard === false && r.result.status.routing.default === "quickkey" && (r.result.status.backend.limitations || []).length >= 6, r.result.status.backend.capabilities);
  r = await A.request("input.open", { leaseMs: 60000, label: "kb13-probe" });
  record("session opened", r.ok, errorOf(r));

  // 1. Taps through executors.
  r = await A.request("input.tap", { key: "NUM5", holdMs: 60 });
  record("NUM5 tap dispatched through the bank: target is the first reserved executor", r.ok && r.result.hold.backend === "quickey" && r.result.hold.target?.executor === EX && r.result.hold.target.quickeyIndex === codeIndex.NUM5 && r.result.hold.pressOutcome === "dispatched", r.ok ? r.result.hold.target : r.error);
  let st = await pollStatus(A, (s) => s.policy.holds === 0, 2000);
  record("the loop released the tap (dispatched)", st?.policy?.holds === 0 && (st.status.holds || []).some((h) => h.state === "released" && h.releaseOutcome === "dispatched"), st?.policy);
  let obs = await until(() => readCmd(A), (v) => v === "5");
  record("console shows 5 on the command line", obs.ok, `cmdtext=${JSON.stringify(obs.value)} after ${obs.ms} ms`);
  record(`executor ${EX} now holds the NUM5 Quickey (assignment stays after the release)`, (await readExec(A, EX)) === "MCP NUM5", await readExec(A, EX));
  r = await A.request("input.tap", { key: "UNDO", holdMs: 60 });
  record("UNDO tap routes to the OOPS Quickey (alias folded; executor tap of OOPS)", r.ok && r.result.hold.target?.code === "OOPS" && r.result.hold.target.quickeyIndex === codeIndex.OOPS, r.ok ? r.result.hold.target : r.error);
  await pollStatus(A, (s) => s.policy.holds === 0, 2000);
  obs = await until(() => readCmd(A), (v) => v === "");
  record("OOPS removed the 5 (executor tap of OOPS works like the direct tap)", obs.ok, JSON.stringify(obs.value));

  // 2. Hold MA1 with the MASTATE readback; duplicate suppression.
  r = await A.request("input.begin", { leaseMs: 60000, label: "kb13 hold" });
  const IA = r.result?.interaction?.id;
  record("interaction acquired", r.ok && IA, errorOf(r));
  r = await A.request("input.press", { key: "MA1", interaction: IA });
  const H1 = r.result?.hold?.id;
  record("MA1 hold dispatched on an executor", r.ok && r.result.hold.state === "held" && r.result.hold.target?.code === "MA1", r.ok ? r.result.hold.target : r.error);
  obs = await until(() => fb(A, "maState"), (v) => v === true);
  record("MASTATE true while MA1 is held (feedback.read during the interaction)", obs.ok, `maState=${obs.value} after ${obs.ms} ms`);
  r = await A.request("input.press", { key: "MA1", interaction: IA });
  record("a repeated down report of MA1 is the same record (duplicate), nothing re-dispatched", r.ok && r.result.hold.duplicate === true && r.result.hold.id === H1, r.ok ? r.result.hold.id : r.error);
  r = await A.request("input.press", { key: "THRU", interaction: IA });
  record("THRU next to the held MA1 is refused (chord not qualified for THRU), nothing issued", codeIs(r, "unsupported") && /chord/.test(r.error), errorOf(r));
  r = await A.request("input.release", { hold: H1 });
  record("MA1 release dispatched on the recorded executor", r.ok && r.result.hold.state === "released" && r.result.hold.releaseOutcome === "dispatched" && r.result.hold.target?.executor === EX, r.ok ? r.result.hold.attempt : r.error);
  obs = await until(() => fb(A, "maState"), (v) => v === false);
  record("MASTATE false after the release", obs.ok, `maState=${obs.value}`);
  r = await A.request("input.end", { interaction: IA });
  record("interaction ended", r.ok, errorOf(r));

  // 3. Chord MA1 + STORE.
  r = await A.request("input.combo", { keys: [{ key: "MA1" }, { key: "STORE" }], holdMs: 200 });
  record("MA1+STORE chord accepted on two executors", r.ok && r.result.count === 2 && r.result.holds[0].target.executor !== r.result.holds[1].target.executor, r.ok ? r.result.holds.map((h) => h.target) : r.error);
  await pollStatus(A, (s) => s.policy.holds === 0, 2500);
  obs = await until(() => readCmd(A), (v) => /record/i.test(v));
  record("console shows Record (MA1 + STORE through the bank)", obs.ok, `cmdtext=${JSON.stringify(obs.value)} after ${obs.ms} ms`);
  obs = await until(() => readMa(A), (v) => v === false);
  record("MASTATE false after the chord", obs.ok, obs.value);
  await clearLine(A);

  // 4. Sequence: Fixture 1 Thru 5 Please, then Clear.
  const sel0 = await readSel(A);
  r = await A.request("input.sequence", { steps: [{ kind: "tap", key: "FIXTURE" }, { kind: "tap", key: "NUM1" }, { kind: "tap", key: "THRU" }, { kind: "tap", key: "NUM5" }, { kind: "tap", key: "PLEASE" }], label: "fixture 1 thru 5" });
  record("Fixture 1 Thru 5 Please sequence accepted", r.ok && r.result.state === "running", errorOf(r));
  let seq = await waitSequence(A, r.result?.id, 6000);
  record("the sequence completed with every tap released", seq.ok && seq.result.state === "completed" && seq.result.counts.completed === 5, seq.ok ? seq.result.counts : seq.error);
  obs = await until(() => readSel(A), (v) => v === 5, 2000);
  record("5 fixtures selected, command line empty", obs.ok && (await readCmd(A)) === "", { selection: obs.value, before: sel0 });
  r = await A.request("input.tap", { key: "CLEAR", holdMs: 60 });
  await pollStatus(A, (s) => s.policy.holds === 0, 2000);
  obs = await until(() => readSel(A), (v) => v === 0, 2000);
  record("CLEAR tap cleared the selection", r.ok && obs.ok, obs.value);

  // 5. Refusals before dispatch.
  r = await A.request("input.tap", { key: "ESC", holdMs: 40 });
  record("ESC (discovered only) is refused as unavailable", codeIs(r, "unavailable") && /discovered only/.test(r.error), errorOf(r));
  r = await A.request("input.tap", { key: "GO", holdMs: 40 });
  record("GO (discovered only) is refused as unavailable", codeIs(r, "unavailable"), errorOf(r));
  r = await A.request("input.tap", { pcKey: "Enter", holdMs: 40 });
  record("a raw PC key is refused by the Quickey backend", codeIs(r, "unsupported") && /no PC keys/.test(r.error), errorOf(r));
  r = await A.request("input.tap", { key: "MA", holdMs: 40 });
  record("MA (a Keyboard() logical key, not a Quickey code) is refused", codeIs(r, "unsupported"), errorOf(r));
  r = await A.request("input.combo", { keys: [{ key: "NUM1" }, { key: "NUM5" }], holdMs: 100 });
  record("a chord whose first key lacks the chord flag is refused, nothing issued", codeIs(r, "unsupported") && r.detail?.missing?.includes("chord") && (await readCmd(A)) === "", errorOf(r));

  // 6. Executor reassigned by the operator during a hold: release refused, recovery after the restore.
  // Operator actions while the bridge is busy: reassign the executor 3 s from now, restore it 10 s from now.
  const t6 = await deferred(A, [{ cmd: "Echo kb13 deferred start", wait: 3 }, { cmd: `Assign Quickey ${codeIndex.THRU} At Page 1.${EX}`, wait: 7 }, { cmd: `Assign Quickey ${codeIndex.MA1} At Page 1.${EX}` }]);
  r = await A.request("input.begin", { leaseMs: 90000, label: "kb13 stuck" });
  const IB = r.result?.interaction?.id;
  r = await A.request("input.press", { key: "MA1", interaction: IB });
  const H2 = r.result?.hold;
  record("MA1 held for the interruption test", r.ok && H2?.target?.executor === EX, r.ok ? H2.target : r.error);
  await sleep(3200);  // the deferred macro reassigns the executor 3 s after it was fired (see below)
  r = await A.request("input.release", { hold: H2.id });
  record("executor reassigned mid-hold: the release is refused, nothing issued, the record is unresolved", r.ok && r.result.hold.state === "unresolved" && /holds the bank's THRU/.test(r.result.hold.unresolved?.reason || ""), r.ok ? r.result.hold.unresolved : r.error);
  obs = await until(() => fb(A, "maState"), (v) => v === true, 500);
  record("the console key is still down (MASTATE true) and nothing pretended otherwise", obs.ok, obs.value);
  r = await A.request("input.recover");
  record("recover with the executor still reassigned: still unresolved, nothing issued", r.ok && r.result.unresolved?.length === 1, r.ok ? r.result.unresolved?.[0]?.error : r.error);
  r = await A.request("input.press", { key: "NUM5", interaction: IB });
  record("a new press avoids the unresolved record's executor", r.ok && r.result.hold.target.executor === EX + 1, r.ok ? r.result.hold.target : r.error);
  await A.request("input.release", { hold: r.result?.hold?.id });
  await sleep(Math.max(0, t6 + 11000 - Date.now()));  // the restore line ran 10 s after the macro was fired
  r = await A.request("input.recover");
  record("operator restored the assignment: recover releases through the recorded executor", r.ok && r.result.released?.length === 1 && r.result.released[0].outcome === "dispatched", r.ok ? r.result.released?.[0] : r.error);
  obs = await until(() => fb(A, "maState"), (v) => v === false);
  record("MASTATE false after the recovery", obs.ok, obs.value);
  r = await A.request("input.end", { interaction: IB });
  await clearLine(A);

  // 7. Restart with a stuck hold: the record and its target survive, operator recovery releases it.
  // Chain: reassign the executor at +3 s, restart the bridge at +4 s (its stop cannot release the stuck key),
  // restore the assignment at +18 s and run the operator's "input recover" at +19 s.
  const t7 = await deferred(A, [
    { cmd: "Echo kb13 restart chain", wait: 3 },
    { cmd: `Assign Quickey ${codeIndex.THRU} At Page 1.${EX}`, wait: 1 },
    { cmd: `Go+ Macro ${RESTART_MACRO}`, wait: 14 },
    { cmd: `Assign Quickey ${codeIndex.MA1} At Page 1.${EX}`, wait: 1 },
    { cmd: 'Plugin "gma3_mcp_bridge" "input recover"' },
  ]);
  r = await A.request("input.begin", { leaseMs: 90000, label: "kb13 restart" });
  const IC = r.result?.interaction?.id;
  r = await A.request("input.press", { key: "MA1", interaction: IC });
  record("MA1 held before the restart", r.ok && r.result.hold.target?.executor === EX, errorOf(r));
  await sleep(Math.max(0, t7 + 6000 - Date.now()));
  A.destroy();
  let up = null;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(500);
    try { const C = new Conn("C"); await C.connect(); const p = await C.request("ping"); if (p.ok && p.result.input?.backend === "quickey") { up = p.result; A = C; } else { C.destroy(); } } catch { /* not up yet */ }
  }
  record("the bridge is back on the quickey backend", !!up, up?.input);
  if (!up) throw new Error("bridge did not come back");
  st = await A.request("input.status");
  const kept = liveHold(st.result);
  record("the stuck MA1 record was adopted with its executor target, unresolved, backend quickey", kept && kept.state === "unresolved" && kept.backend === "quickey" && kept.target?.executor === EX && kept.quickkey === "MA1", kept ? { id: kept.id, target: kept.target, reason: kept.unresolved?.reason } : st.result.policy);
  record("the bank was adopted and is ready", st.result.status.bank?.state === "ready" && st.result.status.bank.id === bank.id, st.result.status.bank?.state);
  record("MASTATE still true across the restart (the console key stayed down)", (await fb(A, "maState")) === true);
  r = await A.request("input.open", { leaseMs: 60000, label: "kb13-probe after restart" });
  r = await A.request("input.tap", { key: "NUM5", holdMs: 60 });
  record("new input after the restart is [busy] until the adopted record is recovered (conflicting input blocked)", codeIs(r, "busy") && r.detail?.reason === "unresolved" && r.detail?.owner === "previous-run", errorOf(r));
  st = await pollStatus(A, (s) => s.policy.unresolved === 0 && s.policy.holds === 0, Math.max(3000, t7 + 24000 - Date.now()));
  record('operator "input recover" (deferred macro line) released the adopted record through its recorded executor', st?.policy?.unresolved === 0 && st?.policy?.holds === 0, st?.policy);
  obs = await until(() => readMa(A), (v) => v === false, 2000);
  record("MASTATE false after the operator recovery", obs.ok, obs.value);
  await clearLine(A);

  // 8. Teardown refused while a hold is live.
  await deferred(A, [{ cmd: "Echo kb13 teardown attempt", wait: 3 }, { cmd: `Go+ Macro ${TEARDOWN_MACRO}` }]);
  r = await A.request("input.begin", { leaseMs: 60000, label: "kb13 teardown" });
  const ID = r.result?.interaction?.id;
  r = await A.request("input.press", { key: "MA1", interaction: ID });
  await sleep(4500);
  st = await A.request("input.status");
  record(`"bank teardown" (Macro ${TEARDOWN_MACRO}) while MA1 is held left the bank in place (refused as bank-in-use; see the bridge log)`, st.ok && st.result.status.bank?.provisioned === true && st.result.status.bank.state === "ready" && liveHold(st.result)?.state === "held", st.result?.status?.bank?.state);
  r = await A.request("input.end", { interaction: ID });
  record("interaction ended, MA1 released", r.ok && r.result.released?.length === 1, errorOf(r));
  obs = await until(() => readMa(A), (v) => v === false);

  // 9. Clean up.
  r = await A.request("input.releaseAll");
  r = await A.request("input.close");
  const finalPing = (await A.request("ping")).result;
  const finalCmd = await readCmd(A);
  const finalMa = await readMa(A);
  record("console and bridge left clean: no holds, nothing unresolved, bank ready, empty command line, MASTATE false", finalPing?.input?.holds === 0 && finalPing?.input?.unresolved === 0 && !finalPing?.input?.busy && finalPing?.input?.bank?.state === "ready" && finalCmd === "" && finalMa === false, { input: finalPing?.input, cmd: finalCmd, ma: finalMa });
  const rel = await releaseDeferredMacro(A);
  record("the deferred macro this run created is verified by contents and removed (an edited one would be preserved)", rel.deleted === true, rel);
  await A.end();
  return { ping, finalPing };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  if (mode !== "run") {
    console.error("usage: node scripts/kb13-probe.mjs run [--out report.json] [--restart-macro N] [--teardown-macro N] [--deferred-macro N]");
    process.exit(2);
  }
  for (const [label, n] of [["--restart-macro", RESTART_MACRO], ["--teardown-macro", TEARDOWN_MACRO], ["--deferred-macro", DEFERRED_MACRO]]) {
    if (!Number.isInteger(n) || n < 1) { console.error(`${label} must be a positive macro number`); process.exit(2); }
  }
  if (DEFERRED_MACRO === RESTART_MACRO || DEFERRED_MACRO === TEARDOWN_MACRO || RESTART_MACRO === TEARDOWN_MACRO) {
    console.error("the deferred, restart and teardown macros must be three distinct slots (the deferred macro is rewritten by the probe)");
    process.exit(2);
  }
  run().then(({ ping, finalPing }) => {
    const report = { probe: "kb-13-run", date: new Date().toISOString(), bridge: { version: ping.bridgeVersion, host: ping.host, port: ping.port, build: ping.build, hostname: ping.hostname, showfile: ping.showfile, input: ping.input }, passed: steps.filter((s) => s.pass === true).length, failed, steps, finalInput: finalPing?.input };
    if (outFile) { fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + "\n"); console.log(`report written to ${outFile}`); }
    console.log(`${report.passed}/${steps.filter((s) => s.pass !== null).length} passed`);
    process.exit(failed ? 1 : 0);
  }).catch((e) => { console.error(`probe aborted: ${e.message}`); process.exit(2); });
}
