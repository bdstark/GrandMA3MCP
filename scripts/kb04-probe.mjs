#!/usr/bin/env node
// KB-04 keyboard-backend probe against a RUNNING bridge with  Plugin "gma3_mcp_bridge" "lua input=keyboard"
// (see KEYBOARD.md "KB-04", docs/modules.md). Console keys ARE pressed: run it only on a disposable show.
//
//   node scripts/kb04-probe.mjs run     [--out report.json]   taps, native PLEASE, MA combo, exclusive long-press,
//                                                             remap / shortcut-disable during a hold, disconnect
//   node scripts/kb04-probe.mjs restart [--out report.json]   a remapped hold kept across a bridge restart and
//                                                             recovered by the operator path (fires Macros 106/102
//                                                             through the bridge; see docs/probes/README.md)
//
// Verification reads the command line (CmdObj().cmdtext) and Root().MASTATE through the "lua" op, polling
// across frames because effects land in the same call or one frame later; the bridge must have Lua enabled.
// Every step records what was dispatched and what was observed separately. A pop-up (Store Settings after
// the long-press) cannot be read back and is left to the operator's eyes; Escape closes it.
// GMA3_BRIDGE_HOST / GMA3_BRIDGE_PORT select the bridge.
import net from "node:net";
import fs from "node:fs";

const host = process.env.GMA3_BRIDGE_HOST ?? "127.0.0.1";
const port = Number(process.env.GMA3_BRIDGE_PORT ?? 9800);
const argv = process.argv.slice(2);
const mode = argv[0];
const outIdx = argv.indexOf("--out");
const outFile = outIdx >= 0 ? argv[outIdx + 1] : null;
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
          else p.resolve({ ok: false, error: typeof m.error === "string" ? m.error : JSON.stringify(m.error) });
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
const codeIs = (r, code) => !r.ok && r.error.includes(`[${code}]`);

/** Console readers through the lua op (Lua must be enabled on the bridge). */
async function lua(conn, code) {
  const r = await conn.request("lua", { code });
  if (!r.ok) throw new Error(`lua failed: ${r.error}`);
  return r.result?.values?.[0];
}
const readCmd = (conn) => lua(conn, "return CmdObj().cmdtext");
const readMa = (conn) => lua(conn, "return Root():Get('MAState')");
const readShortcuts = (conn) => lua(conn, "return CurrentProfile().KeyboardShortCuts:Get('KeyboardShortcutsActive')");
/** Polls a console reader across frames (effects land in the same call or one frame later). */
async function until(conn, reader, pred, timeoutMs = 1500) {
  const t0 = Date.now();
  let v;
  for (;;) {
    v = await reader(conn);
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
const holdOf = (status, pred) => (status?.status?.holds ?? []).find(pred);

/** Escape until the command line is empty (closes a pop-up first if one is open). Explicit, never implicit. */
async function clearLine(conn, times = 2) {
  for (let i = 0; i < times; i++) {
    const r = await conn.request("input.tap", { key: "ESC", holdMs: 40 });
    if (!r.ok) return r;
    await sleep(120);
  }
  return { ok: true };
}

async function preflight(A, wantInput = true) {
  const pingR = await A.request("ping");
  if (!pingR.ok) throw new Error(`ping failed: ${pingR.error}`);
  const ping = pingR.result;
  console.log(`bridge ${ping.bridgeVersion} on ${ping.host}:${ping.port}; show "${ping.showfile ?? ""}"; input ${ping.input ? (ping.input.enabled ? `enabled (${ping.input.backend})` : "disabled") : "not reported"}; lua ${ping.lua?.enabled ? "on" : "off"}`);
  const [maj, min] = String(ping.bridgeVersion ?? "0.0").split(".").map(Number);
  if (!ping.input || maj < 0 || (maj === 0 && min < 6)) { console.error(`bridge ${ping.bridgeVersion} has no keyboard backend; update the plugin to 0.6.0 or newer (docs/setup/bridge.md)`); process.exit(2); }
  if (!SHOW_GUARD.test(String(ping.showfile ?? ""))) { console.error(`show "${ping.showfile}" does not look disposable (expected a name containing disposable, mcp-test or scratch); refusing to press console keys`); process.exit(2); }
  if (!ping.lua?.enabled) { console.error('Lua execution is off on the bridge; the probe verifies through CmdObj()/MASTATE and needs  Plugin "gma3_mcp_bridge" "lua on"'); process.exit(2); }
  if (wantInput && (!ping.input.enabled || ping.input.backend !== "keyboard")) { console.error('input is not enabled on the keyboard backend. The console operator enables it with:  Plugin "gma3_mcp_bridge" "input=keyboard"  (or starts the bridge with "lua input=keyboard"). Console keys WILL be pressed.'); process.exit(2); }
  if (ping.input.holds > 0 || ping.input.unresolved > 0 || ping.input.unresolvedFromPreviousRun > 0) { console.error(`the bridge already has ${ping.input.holds} hold(s), ${ping.input.unresolved} unresolved and ${ping.input.unresolvedFromPreviousRun} kept record(s); resolve them first (input status / input recover)`); process.exit(2); }
  const cmd = await readCmd(A);
  const ma = await readMa(A);
  const sc = await readShortcuts(A);
  if (cmd !== "" || ma !== false || sc !== true) { console.error(`console not in the expected idle state: cmdtext=${JSON.stringify(cmd)} MASTATE=${ma} shortcutsActive=${sc}; clear the command line, release Shift, enable shortcuts (F10)`); process.exit(2); }
  return ping;
}

async function run() {
  const A = new Conn("A");
  await A.connect();
  const ping = await preflight(A);
  let r = await A.request("input.open", { leaseMs: 60000, label: "kb04-probe A" });
  record("A opens a session", r.ok, errorOf(r));
  const B = new Conn("B");
  await B.connect();
  r = await B.request("input.open", { leaseMs: 60000, label: "kb04-probe B" });
  record("B opens a session", r.ok, errorOf(r));
  const sessA = (await A.request("input.status")).result?.session;
  r = await A.request("input.status");
  record("status names the keyboard backend, dispatching, not display-scoped, with limitations", r.ok && r.result.status.backend.name === "keyboard" && r.result.status.backend.dispatches && r.result.status.backend.displayScoped === false && Array.isArray(r.result.status.backend.limitations), r.ok ? r.result.status.backend.name : r.error);

  // 1. Simple tap: NUM5 -> "5" on the command line; ESC clears it.
  r = await A.request("input.tap", { key: "NUM5", holdMs: 60 });
  record("tap NUM5 accepted: press dispatched, release scheduled", r.ok && r.result.hold.pressOutcome === "dispatched" && r.result.hold.releaseOutcome === "scheduled" && r.result.hold.backend === "keyboard", r.ok ? `${r.result.hold.tupleKey} via ${r.result.hold.route.source} "${r.result.hold.route.shortcut}"` : r.error);
  const tapId = r.result?.hold?.id;
  let obs = await until(A, readCmd, (v) => v === "5");
  record("console shows 5 on the command line", obs.ok, `cmdtext=${JSON.stringify(obs.value)} after ${obs.ms} ms`);
  let st = await pollStatus(A, (s) => holdOf(s, (h) => h.id === tapId)?.state === "released", 2000);
  let h = holdOf(st, (h) => h.id === tapId);
  record("the loop released the tap: outcome 'dispatched' (not confirmed: no per-key readback)", h?.state === "released" && h.releaseOutcome === "dispatched" && h.dispatch?.release?.confirmed === undefined, h ? `${h.state}/${h.releaseOutcome} after ${h.heldMs} ms` : "hold not reported");
  r = await A.request("input.tap", { key: "ESC", holdMs: 40 });
  obs = await until(A, readCmd, (v) => v === "");
  record("tap ESC clears the command line", r.ok && obs.ok, `cmdtext=${JSON.stringify(obs.value)}`);

  // 2. Native PLEASE route (empty command line: nothing executes).
  r = await A.request("input.press", { key: "PLEASE" });
  record("PLEASE admitted through the native Enter route with the redirect checked", r.ok && r.result.hold.route.source === "native" && r.result.hold.route.redirectChecked === true && r.result.hold.pcKey === "Enter", r.ok ? r.result.hold.route : r.error);
  r = await A.request("input.release", { key: "PLEASE" });
  record("PLEASE released with the stored Enter tuple", r.ok && r.result.hold.state === "released" && r.result.hold.releaseOutcome === "dispatched", errorOf(r));
  obs = await until(A, readCmd, (v) => v === "", 500);
  record("empty command line unchanged by PLEASE", obs.ok, JSON.stringify(obs.value));

  // 3. MA combination: MA + STORE -> "Record" with MASTATE readback.
  r = await A.request("input.combo", { keys: [{ key: "MA" }, { key: "STORE" }], holdMs: 150 });
  record("combo MA+STORE accepted: LeftShift then S in one group", r.ok && r.result.count === 2 && r.result.holds[0].pcKey === "LeftShift" && r.result.holds[1].pcKey === "S" && r.result.holds[0].readback?.outcome === "pending", r.ok ? r.result.releaseOrder : r.error);
  const maId = r.result?.holds?.[0]?.id;
  obs = await until(A, readCmd, (v) => /record/i.test(v));
  record("console shows Record (MA + Store) on the command line", obs.ok, `cmdtext=${JSON.stringify(obs.value)} after ${obs.ms} ms`);
  st = await pollStatus(A, (s) => holdOf(s, (h) => h.id === maId)?.state === "released" && holdOf(s, (h) => h.id === maId)?.readback?.outcome !== "pending", 3000);
  h = holdOf(st, (h) => h.id === maId);
  record("MA released at the deadline, newest first (S before LeftShift)", h?.state === "released" && h.releaseOutcome === "dispatched" && h.dispatch?.release?.reason === "combo", h ? `${h.state} (${h.dispatch?.release?.reason})` : "hold not reported");
  record("MASTATE readback after the MA release: observed false (aggregate), reported separately from the dispatch", h?.readback?.phase === "release" && h.readback.outcome === "observed" && h.readback.value === false, h?.readback);
  record("MASTATE readback after the MA press was observed true", h?.pressReadback?.outcome === "observed" && h.pressReadback.value === true, h?.pressReadback);
  const maNow = await readMa(A);
  record("console MASTATE is false again", maNow === false, maNow);
  r = await clearLine(A, 1);
  obs = await until(A, readCmd, (v) => v === "");
  record("ESC clears Record", r.ok && obs.ok, JSON.stringify(obs.value));

  // 4. Exclusive long-press: STORE held 1.2 s; everything else is rejected meanwhile.
  r = await A.request("input.tap", { key: "STORE", holdMs: 1200, exclusive: true });
  record("exclusive STORE long-press accepted", r.ok && r.result.hold.exclusive === true, errorOf(r));
  const lpId = r.result?.hold?.id;
  r = await B.request("input.press", { key: "MA" });
  record("B's press rejected during the long-press (exclusive-hold naming A)", codeIs(r, "exclusive-hold") && r.error.includes(sessA), errorOf(r));
  r = await A.request("input.press", { key: "STORE" });
  record("A's duplicate STORE rejected during the long-press", codeIs(r, "exclusive-hold"), errorOf(r));
  r = await B.request("input.combo", { keys: [{ key: "MA" }, { key: "PLEASE" }] });
  record("a combo is rejected during the long-press", codeIs(r, "exclusive-hold"), errorOf(r));
  st = await pollStatus(A, (s) => holdOf(s, (h) => h.id === lpId)?.state === "released", 3000);
  h = holdOf(st, (h) => h.id === lpId);
  record("the long-press was released by the loop after about 1.2 s", h?.state === "released" && h.heldMs >= 1150 && h.heldMs < 1700, h ? `${h.heldMs} ms` : "hold not reported");
  note("Store Settings pop-up", "expected to have opened on Display 1 during the long-press (KB-01); not readable from Lua, operator verifies by eye; Escape closes it next");
  obs = { value: await readCmd(A) };
  note("command line after the long-press", JSON.stringify(obs.value));
  r = await clearLine(A, 2);
  obs = await until(A, readCmd, (v) => v === "");
  record("ESC x2 closes the pop-up and clears the command line", r.ok && obs.ok, JSON.stringify(obs.value));
  r = await B.request("input.press", { key: "MA" });
  record("B can press again after the long-press ended", r.ok, errorOf(r));
  await B.request("input.release", { key: "MA" });
  await until(A, readMa, (v) => v === false);

  // 5. Remap during a hold: STORE held, the S row remapped to T, stored-tuple release unconfirmable until restored.
  const rowS = await lua(A, "local sc=CurrentProfile().KeyboardShortCuts for i=1,sc:Count() do local s=sc:Ptr(i) if s and tostring(s:Get('Shortcut'))=='S' and tonumber(s:Get('KeyCode'))==66 then return i end end return nil");
  if (typeof rowS !== "number") {
    note("remap test skipped", `no KeyboardShortcut row with Shortcut S -> STORE found (got ${JSON.stringify(rowS)})`);
  } else {
    r = await A.request("input.press", { key: "STORE" });
    record("STORE held (S down)", r.ok && r.result.hold.pcKey === "S", errorOf(r));
    const storeId = r.result?.hold?.id;
    obs = await until(A, readCmd, (v) => /store/i.test(v));
    note("command line while S is held", JSON.stringify(obs.value));
    let c = await A.request("cmd", { command: `Set KeyboardShortcut ${rowS} Property "Shortcut" "T"` });
    record(`operator remaps KeyboardShortcut ${rowS} S -> T while held (via cmd)`, c.ok, errorOf(c));
    r = await B.request("input.press", { pcKey: "Q" });
    record("new input stops for every session: route-changed naming the original route and the mismatch", codeIs(r, "route-changed") && /T\|s0c0a0n0/.test(r.error), errorOf(r));
    r = await A.request("input.release", { key: "STORE" });
    record("stored-tuple release (S) dispatched but unresolved while the route differs", r.ok && r.result.hold.state === "unresolved" && /route changed/.test(r.result.hold.unresolved?.reason ?? "") && r.result.hold.dispatch?.release?.ok === true, r.ok ? r.result.hold.unresolved?.reason : r.error);
    const cmdWhileUnresolved = await readCmd(A);
    note("command line after the unconfirmable release (KB-01: the console does not lift a remapped hold)", JSON.stringify(cmdWhileUnresolved));
    c = await A.request("cmd", { command: `Set KeyboardShortcut ${rowS} Property "Shortcut" "S"` });
    record(`operator restores KeyboardShortcut ${rowS} to S`, c.ok, errorOf(c));
    r = await A.request("input.recover");
    record("owner recover after the restore releases with the stored tuple", r.ok && r.result.released?.length === 1 && r.result.released[0].hold === storeId && r.result.released[0].outcome === "dispatched", r.ok ? r.result : r.error);
    await sleep(200);
    r = await clearLine(A, 2);
    obs = await until(A, readCmd, (v) => v === "");
    record("command line clear after the remap test", obs.ok, JSON.stringify(obs.value));
    r = await B.request("input.press", { pcKey: "Q" });
    record("input admitted again after recovery", r.ok, errorOf(r));
    await B.request("input.release", { pcKey: "Q" });
  }

  // 6. Shortcuts disabled during a hold (F10), native PLEASE still admitted, shortcut keys not.
  r = await A.request("input.press", { key: "STORE" });
  record("STORE held before F10", r.ok, errorOf(r));
  r = await A.request("input.tap", { pcKey: "F10", holdMs: 40 });
  obs = await until(A, readShortcuts, (v) => v === false);
  record("raw F10 tap disables keyboard shortcuts (operator action simulated; never done implicitly)", r.ok && obs.ok, `shortcutsActive=${obs.value}`);
  r = await B.request("input.press", { key: "MA" });
  record("new input stops: route-changed 'inactive' for the STORE hold", codeIs(r, "route-changed") && /inactive/.test(r.error), errorOf(r));
  r = await A.request("input.release", { key: "STORE" });
  record("release with shortcuts disabled is unresolved (unconfirmable), record kept", r.ok && r.result.hold.state === "unresolved", r.ok ? r.result.hold.unresolved?.reason : r.error);
  r = await A.request("input.tap", { pcKey: "F10", holdMs: 40 });
  record("an injected F10 to re-enable is refused while the route mismatch is pending (new input stops; the operator restores the route)", codeIs(r, "route-changed"), errorOf(r));
  await lua(A, "CurrentProfile().KeyboardShortCuts:Set('KeyboardShortcutsActive', true) return true");
  obs = await until(A, readShortcuts, (v) => v === true);
  record("operator re-enables shortcuts (property set through Lua, standing in for the console's F10)", obs.ok, `shortcutsActive=${obs.value}`);
  r = await A.request("input.recover");
  record("recover after re-enabling releases the STORE record", r.ok && r.result.released?.length === 1, r.ok ? r.result : r.error);
  await sleep(200);
  await clearLine(A, 2);
  obs = await until(A, readCmd, (v) => v === "");
  record("command line clear after the F10 test", obs.ok, JSON.stringify(obs.value));
  r = await A.request("input.press", { key: "PLEASE" });
  const beforeSc = await readShortcuts(A);
  note("native PLEASE while shortcuts active", r.ok ? `admitted (${r.result.hold.route.source})` : r.error);
  await A.request("input.release", { key: "PLEASE" });
  record("shortcuts still active", beforeSc === true, beforeSc);

  // 7. Disconnect releases B's hold through Keyboard().
  const countersBefore = (await A.request("input.status")).result?.status?.backend?.counters;
  r = await B.request("input.press", { key: "MA" });
  record("B holds MA", r.ok, errorOf(r));
  obs = await until(A, readMa, (v) => v === true);
  record("console MASTATE true while B holds MA", obs.ok, obs.value);
  B.destroy();
  st = await pollStatus(A, (s) => s.policy.holds === 0, 3000);
  const countersAfter = st?.status?.backend?.counters;
  obs = await until(A, readMa, (v) => v === false);
  record("B's disconnect released MA: no holds, one more Keyboard() release, MASTATE false", st?.policy?.holds === 0 && countersAfter?.release === (countersBefore?.release ?? 0) + 1 && obs.ok, { before: countersBefore?.release, after: countersAfter?.release, ma: obs.value });

  // 8. Clean up.
  r = await A.request("input.releaseAll");
  record("A releaseAll (nothing left)", r.ok && r.result.attempted === 0, errorOf(r));
  r = await A.request("input.close");
  record("A closes its session", r.ok, errorOf(r));
  const finalPing = (await A.request("ping")).result;
  const finalCmd = await readCmd(A);
  const finalMa = await readMa(A);
  const finalSc = await readShortcuts(A);
  record("console and bridge left clean: no holds, nothing unresolved, empty command line, MASTATE false, shortcuts active", finalPing?.input?.holds === 0 && finalPing?.input?.unresolved === 0 && finalCmd === "" && finalMa === false && finalSc === true, { input: finalPing?.input, cmd: finalCmd, ma: finalMa, shortcuts: finalSc });
  await A.end();
  return { ping, finalPing };
}

/** A remapped hold kept across a restart (input disabled at the next start) and recovered by the operator path. */
async function restart() {
  let A = new Conn("A");
  await A.connect();
  const ping = await preflight(A);
  const macroCheck = await lua(A, "local m106=ObjectList('Macro 106')[1] local m102=ObjectList('Macro 102')[1] return { m106 = m106 and m106:Ptr(m106:Count()):Get('Command') or nil, m102 = m102 and m102:Ptr(1):Get('Command') or nil }");
  if (!/^Plugin "gma3_mcp_bridge" "lua"$/.test(String(macroCheck?.m106 ?? "")) || !/input recover/.test(String(macroCheck?.m102 ?? ""))) {
    console.error(`Macros 106 (stop + restart with "lua" only) and 102 ("input recover") are required; found ${JSON.stringify(macroCheck)}`);
    process.exit(2);
  }
  let r = await A.request("input.open", { leaseMs: 120000, label: "kb04-probe restart" });
  record("session opened", r.ok, errorOf(r));
  const rowS = await lua(A, "local sc=CurrentProfile().KeyboardShortCuts for i=1,sc:Count() do local s=sc:Ptr(i) if s and tostring(s:Get('Shortcut'))=='S' and tonumber(s:Get('KeyCode'))==66 then return i end end return nil");
  if (typeof rowS !== "number") { console.error("no S -> STORE shortcut row"); process.exit(2); }
  r = await A.request("input.press", { key: "STORE" });
  record("STORE held", r.ok, errorOf(r));
  let c = await A.request("cmd", { command: `Set KeyboardShortcut ${rowS} Property "Shortcut" "T"` });
  record("S row remapped to T while held", c.ok, errorOf(c));
  // Restart with input disabled (Macro 106). The stop attempts the release: unconfirmable -> kept.
  c = await A.request("cmd", { command: "Go+ Macro 106" });
  record("Macro 106 fired (stop + restart with lua only)", c.ok, errorOf(c));
  A.destroy();
  await sleep(6000);
  A = new Conn("A2");
  let back = false;
  for (let i = 0; i < 20 && !back; i++) { try { await A.connect(); back = true; } catch { await sleep(1000); } }
  record("bridge back after the restart", back);
  if (!back) { process.exit(1); }
  let p = (await A.request("ping")).result;
  record("input disabled after the restart; the kept STORE record is adopted and reserved", p?.input?.enabled === false && p?.input?.unresolved === 1 && p?.input?.holds === 1, p?.input);
  let s = (await A.request("input.status")).result;
  let kept = (s?.status?.holds ?? []).find((h) => h.state === "unresolved");
  record("the kept record is a keyboard record of the previous run with the stored S tuple", kept?.backend === "keyboard" && kept.session === "previous-run" && kept.tupleKey === "S|s0c0a0n0", kept);
  // Operator recovery while the route is still wrong: attaches the keyboard backend for cleanup, stays unresolved.
  c = await A.request("cmd", { command: "Go+ Macro 102" });
  await sleep(1500);
  s = (await A.request("input.status")).result;
  kept = (s?.status?.holds ?? []).find((h) => h.tupleKey === "S|s0c0a0n0");
  record("input recover with the route still remapped: keyboard backend attached for cleanup, input still disabled, record still unresolved", s?.status?.backend?.attached === true && s?.status?.backend?.name === "keyboard" && s?.policy?.enabled === false && kept?.state === "unresolved", { backend: s?.status?.backend?.name, enabled: s?.policy?.enabled, state: kept?.state, reason: kept?.unresolved?.reason });
  r = await A.request("input.open", {});
  r = await A.request("input.press", { pcKey: "A" });
  record("new input is still refused (input disabled) although a backend is attached for cleanup", codeIs(r, "input-disabled"), errorOf(r));
  c = await A.request("cmd", { command: `Set KeyboardShortcut ${rowS} Property "Shortcut" "S"` });
  record("S row restored", c.ok, errorOf(c));
  c = await A.request("cmd", { command: "Go+ Macro 102" });
  await sleep(1500);
  p = (await A.request("ping")).result;
  record("input recover after the restore releases the kept record through Keyboard()", p?.input?.unresolved === 0 && p?.input?.holds === 0 && p?.input?.enabled === false, p?.input);
  const cmd = await readCmd(A);
  note("command line after recovery", JSON.stringify(cmd));
  await A.request("input.close", {});
  record("console idle: MASTATE false, shortcuts active", (await readMa(A)) === false && (await readShortcuts(A)) === true);
  note("operator follow-up", 'the bridge is running with input disabled; re-enable with  Plugin "gma3_mcp_bridge" "input=keyboard"  (Macro 107 on the test console) and clear the command line with Escape if needed');
  await A.end();
  return { ping, finalPing: p };
}

if (mode !== "run" && mode !== "restart") {
  console.error("usage: node scripts/kb04-probe.mjs run|restart [--out report.json]");
  process.exit(2);
}
(mode === "run" ? run() : restart()).then(({ ping, finalPing }) => {
  const report = { probe: `kb-04-${mode}`, date: new Date().toISOString(), bridge: { version: ping.bridgeVersion, host: ping.host, port: ping.port, build: ping.build, hostname: ping.hostname, showfile: ping.showfile, input: ping.input }, passed: steps.filter((s) => s.pass === true).length, failed, steps, finalInput: finalPing?.input };
  if (outFile) { fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + "\n"); console.log(`report written to ${outFile}`); }
  console.log(`${report.passed}/${steps.filter((s) => s.pass !== null).length} passed`);
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.error(`probe aborted: ${e.message}`); process.exit(2); });
