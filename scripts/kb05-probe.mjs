#!/usr/bin/env node
// KB-05 structured-input probe against a RUNNING bridge started with  Plugin "gma3_mcp_bridge" "lua input=keyboard"
// (see KEYBOARD.md "KB-05", docs/tools/input.md). Console keys ARE pressed and text IS typed: run it only on a
// disposable show.
//
//   node scripts/kb05-probe.mjs run [--out report.json]
//
// Over two real TCP connections it exercises: an explicit interaction (acquire, hold with/without the id, busy
// refusals of commands and of the other connection, end), a tap sequence, the MA+STORE chord with MASTATE
// readback, command-line text with shortcuts disabled by the operator (simulated through Lua, as in the KB-04
// probe) and read back from CmdObj().cmdtext, the refusal of command-line text while shortcuts are enabled,
// and a disconnect in the middle of a sequence. Verification reads the command line, MASTATE and the shortcut
// enablement through the "lua" op, polling across frames; the bridge must have Lua enabled. Because the bridge
// refuses "lua" (like every mutating op) while input is owned, every read happens after the interaction or
// sequence under test has ended; what a held key put on the command line stays there until Escape. Nothing is retried.
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

/** Console readers through the lua op (Lua must be enabled on the bridge). */
async function lua(conn, code) {
  const r = await conn.request("lua", { code });
  if (!r.ok) throw new Error(`lua failed: ${r.error}`);
  return r.result?.values?.[0];
}
const readCmd = (conn) => lua(conn, "return CmdObj().cmdtext");
const readLast = (conn) => lua(conn, "return tostring(CmdObj().lastcommand)");
const readMa = (conn) => lua(conn, "return Root():Get('MAState')");
const readShortcuts = (conn) => lua(conn, "return CurrentProfile().KeyboardShortCuts:Get('KeyboardShortcutsActive')");
const setShortcuts = (conn, on) => lua(conn, `CurrentProfile().KeyboardShortCuts:Set('KeyboardShortcutsActive', ${on ? "true" : "false"}) return true`);
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
/** Polls a sequence until it is no longer running (never aborts or resends it). */
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

/** Escape until the command line is empty. Explicit, never implicit. */
async function clearLine(conn, times = 1) {
  for (let i = 0; i < times; i++) {
    const r = await conn.request("input.tap", { key: "ESC", holdMs: 40 });
    if (!r.ok) return r;
    await sleep(150);
  }
  return { ok: true };
}

async function preflight(A) {
  const pingR = await A.request("ping");
  if (!pingR.ok) throw new Error(`ping failed: ${pingR.error}`);
  const ping = pingR.result;
  console.log(`bridge ${ping.bridgeVersion} on ${ping.host}:${ping.port}; show "${ping.showfile ?? ""}"; input ${ping.input ? (ping.input.enabled ? `enabled (${ping.input.backend})` : "disabled") : "not reported"}; lua ${ping.lua?.enabled ? "on" : "off"}`);
  const [maj, min] = String(ping.bridgeVersion ?? "0.0").split(".").map(Number);
  if (!ping.input || maj < 0 || (maj === 0 && min < 7)) { console.error(`bridge ${ping.bridgeVersion} has no interactions/sequences; update the plugin to 0.7.0 or newer (docs/setup/bridge.md)`); process.exit(2); }
  if (!SHOW_GUARD.test(String(ping.showfile ?? ""))) { console.error(`show "${ping.showfile}" does not look disposable (expected a name containing disposable, mcp-test or scratch); refusing to press console keys`); process.exit(2); }
  if (!ping.lua?.enabled) { console.error('Lua execution is off on the bridge; the probe verifies through CmdObj()/MASTATE and needs  Plugin "gma3_mcp_bridge" "lua on"'); process.exit(2); }
  if (!ping.input.enabled || ping.input.backend !== "keyboard") { console.error('input is not enabled on the keyboard backend. The console operator enables it with:  Plugin "gma3_mcp_bridge" "input=keyboard"  (or starts the bridge with "lua input=keyboard"). Console keys WILL be pressed.'); process.exit(2); }
  if (ping.input.holds > 0 || ping.input.unresolved > 0 || ping.input.unresolvedFromPreviousRun > 0 || ping.input.busy) { console.error(`the bridge already has ${ping.input.holds} hold(s), ${ping.input.unresolved} unresolved, ${ping.input.unresolvedFromPreviousRun} kept record(s)${ping.input.busy ? ` and is busy (${ping.input.busy.reason})` : ""}; resolve them first (input status / input recover)`); process.exit(2); }
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
  const B = new Conn("B");
  await B.connect();
  let r = await B.request("input.open", { leaseMs: 60000, label: "kb05-probe B" });
  record("B opens a session", r.ok, errorOf(r));

  // 1. Explicit interaction: acquire, busy for everyone else, hold needs the id, end releases.
  r = await A.request("input.begin", { leaseMs: 30000, label: "kb05-probe" });
  record("A acquires an interaction (session opened on demand)", r.ok && r.result.interaction?.state === "open" && r.result.session, r.ok ? r.result.interaction?.id : r.error);
  const IA = r.result?.interaction?.id;
  r = await B.request("cmd", { command: "Echo kb05-probe" });
  record("a command from B is [busy] while A's interaction is open", codeIs(r, "busy") && r.detail?.interaction === IA, errorOf(r));
  r = await A.request("cmd", { command: "Echo kb05-probe" });
  record("a command from A (the owner) is [busy] too", codeIs(r, "busy"), errorOf(r));
  r = await B.request("input.tap", { key: "NUM5", holdMs: 40 });
  record("B's tap is [busy] naming A's interaction", codeIs(r, "busy") && r.detail?.reason === "interaction", errorOf(r));
  r = await A.request("input.press", { key: "STORE" });
  record("A's press without the interaction id is [busy] (callers sharing a connection must name it)", codeIs(r, "busy"), errorOf(r));
  r = await A.request("input.press", { key: "STORE", interaction: IA });
  record("A's press with the id is admitted and tagged", r.ok && r.result.hold.interaction === IA && r.result.hold.state === "held", errorOf(r));
  r = await A.request("lua", { code: "return CmdObj().cmdtext" });
  record("reading through the lua op is [busy] while the interaction is open (the guard covers Lua)", codeIs(r, "busy"), errorOf(r));
  r = await A.request("input.status");
  record("status reports the active interaction and the busy descriptor", r.ok && r.result.status.activeInteraction === IA && r.result.policy.busy?.reason === "interaction", r.ok ? r.result.policy.busy : r.error);
  r = await A.request("input.extend", { interaction: IA, leaseMs: 20000 });
  record("the owner can extend the lease", r.ok && r.result.interaction.renewals === 1, errorOf(r));
  r = await B.request("input.end", { interaction: IA });
  record("B cannot end A's interaction", !r.ok, errorOf(r));
  r = await A.request("input.end", { interaction: IA });
  record("A ends the interaction: STORE released (dispatched)", r.ok && r.result.state === "ended" && r.result.released?.length === 1 && r.result.released[0].outcome === "dispatched", r.ok ? r.result.released : r.error);
  let obs = await until(A, readCmd, (v) => /store/i.test(v));
  record("the held STORE reached the console: Store on the command line (read after the end; the hold's effect persists until Escape)", obs.ok, `cmdtext=${JSON.stringify(obs.value)} after ${obs.ms} ms`);
  r = await B.request("cmd", { command: "Echo kb05-probe" });
  record("commands are admitted again after the end", r.ok, errorOf(r));
  r = await A.request("input.press", { key: "STORE", interaction: IA });
  record("the ended interaction is never resumed", codeIs(r, "no-interaction"), errorOf(r));
  r = await A.request("input.press", { key: "STORE" });
  record("a standalone hold without an interaction is [interaction-required]", codeIs(r, "interaction-required"), errorOf(r));
  await clearLine(A, 1);
  obs = await until(A, readCmd, (v) => v === "");
  record("ESC clears the command line", obs.ok, JSON.stringify(obs.value));

  // 2. A tap sequence serviced by the loop.
  r = await A.request("input.sequence", { steps: [{ kind: "tap", key: "NUM5", holdMs: 60 }, { kind: "tap", key: "NUM1", holdMs: 60 }], label: "digits" });
  record("a two-tap sequence starts (state running, step 1 waiting for its release)", r.ok && r.result.state === "running" && r.result.events[0].state === "waiting", errorOf(r));
  let Q = r.result?.id;
  let seq = await waitSequence(A, Q, 3000);
  record("the sequence completed: both taps released by the loop", seq.ok && seq.result.state === "completed" && seq.result.events.every((e) => e.state === "completed" && e.releaseOutcome === "dispatched"), seq.ok ? seq.result.counts : seq.error);
  obs = await until(A, readCmd, (v) => v === "51");
  record("console shows 51 on the command line", obs.ok, `cmdtext=${JSON.stringify(obs.value)} after ${obs.ms} ms`);
  await clearLine(A, 1);
  await until(A, readCmd, (v) => v === "");

  // 3. Chord sequence with the aggregate MASTATE readback.
  r = await A.request("input.sequence", { steps: [{ kind: "combo", keys: [{ key: "MA" }, { key: "STORE" }], holdMs: 150 }] });
  Q = r.result?.id;
  record("MA+STORE chord sequence accepted", r.ok, errorOf(r));
  seq = await waitSequence(A, Q, 3000);
  obs = await until(A, readCmd, (v) => /record/i.test(v));
  record("console shows Record (MA + Store), read after the chord was released", obs.ok, `cmdtext=${JSON.stringify(obs.value)} after ${obs.ms} ms`);
  record("the chord was released newest first and the step reports the MASTATE readback separately", seq.ok && seq.result.state === "completed" && seq.result.events[0].readback?.source === "MASTATE", seq.ok ? seq.result.events[0].readback : seq.error);
  obs = await until(A, readMa, (v) => v === false);
  record("console MASTATE false again", obs.ok, obs.value);
  await clearLine(A, 1);
  await until(A, readCmd, (v) => v === "");

  // 4. Text: refused while shortcuts are enabled; typed and read back once the operator disabled them.
  r = await A.request("input.sequence", { steps: [{ kind: "text", text: "Fixture 5", context: "command-line" }] });
  record("command-line text is refused while shortcuts are enabled (nothing typed, nothing toggled)", codeIs(r, "unsupported") && (await readCmd(A)) === "" && (await readShortcuts(A)) === true, errorOf(r));
  r = await A.request("input.sequence", { steps: [{ kind: "text", text: "Fixture 5\n", context: "command-line" }] });
  record("text with a newline is refused by the policy", codeIs(r, "bad-argument") && /newline/.test(r.error), errorOf(r));
  const lastBefore = await readLast(A);
  await setShortcuts(A, false);
  obs = await until(A, readShortcuts, (v) => v === false);
  record("operator disables shortcuts (property set through Lua, standing in for F10)", obs.ok, `shortcutsActive=${obs.value}`);
  r = await A.request("input.sequence", { steps: [{ kind: "text", text: "Fixture 5", context: "command-line" }] });
  Q = r.result?.id;
  record("command-line text sequence accepted (typing in chunks)", r.ok && r.result.events[0].state !== "failed", errorOf(r));
  seq = await waitSequence(A, Q, 4000);
  record("text completed with the command line read back as expected", seq.ok && seq.result.state === "completed" && seq.result.events[0].typed === 9 && seq.result.events[0].readback?.outcome === "observed", seq.ok ? seq.result.events[0].readback : seq.error);
  obs = await until(A, readCmd, (v) => v === "Fixture 5");
  const lastAfter = await readLast(A);
  record("the text was NOT executed: cmdtext shows it, lastcommand unchanged", obs.ok && lastAfter === lastBefore, { cmdtext: obs.value, lastBefore, lastAfter });
  r = await A.request("input.sequence", { steps: [{ kind: "text", text: "abü€😀", context: "command-line" }] });
  Q = r.result?.id;
  seq = await waitSequence(A, Q, 4000);
  obs = await until(A, readCmd, (v) => v === "Fixture 5abü€😀", 2000);
  record("Unicode text goes out one code point per event and lands on the command line", seq.ok && seq.result.state === "completed" && seq.result.events[0].chars === 5, { readback: seq.result?.events?.[0]?.readback, cmdtext: obs.value });
  await setShortcuts(A, true);
  obs = await until(A, readShortcuts, (v) => v === true);
  record("operator re-enables shortcuts", obs.ok, `shortcutsActive=${obs.value}`);
  await clearLine(A, 1);
  obs = await until(A, readCmd, (v) => v === "");
  record("ESC clears the typed text without executing it", obs.ok, JSON.stringify(obs.value));

  // 5. Disconnect in the middle of a sequence.
  r = await B.request("input.sequence", { steps: [{ kind: "tap", key: "STORE", holdMs: 3000 }, { kind: "tap", key: "NUM5" }] });
  record("B starts a sequence with a 3 s STORE tap", r.ok && r.result.state === "running", errorOf(r));
  Q = r.result?.id;
  r = await A.request("cmd", { command: "Echo kb05-probe" });
  record("A's command is [busy] while B's sequence runs", codeIs(r, "busy") && r.detail?.owner !== undefined, errorOf(r));
  await sleep(300);
  B.destroy();
  let st = await pollStatus(A, (s) => s.policy.holds === 0 && !s.policy.busy, 3000);
  record("B's disconnect released the in-flight tap and cleared the busy state", st?.policy?.holds === 0 && !st?.policy?.busy, st?.policy);
  seq = await A.request("input.sequence.status", { sequence: Q });
  record("the sequence is aborted: step 1 aborted, step 2 unattempted, nothing resumed", seq.ok && seq.result.state === "aborted" && seq.result.events[0].state === "aborted" && seq.result.events[1].state === "unattempted", seq.ok ? seq.result.counts : seq.error);
  obs = await until(A, readCmd, (v) => /store/i.test(v), 500);
  record("the interrupted STORE tap reached the console before the disconnect", obs.ok, JSON.stringify(obs.value));
  await clearLine(A, 1);
  obs = await until(A, readCmd, (v) => v === "");
  record("command line clear after the disconnect test", obs.ok, JSON.stringify(obs.value));

  // 6. Clean up.
  r = await A.request("input.releaseAll");
  record("A releaseAll (nothing left)", r.ok && r.result.attempted === 0, errorOf(r));
  r = await A.request("input.close");
  record("A closes its session", r.ok, errorOf(r));
  const finalPing = (await A.request("ping")).result;
  const finalCmd = await readCmd(A);
  const finalMa = await readMa(A);
  const finalSc = await readShortcuts(A);
  record("console and bridge left clean: no holds, nothing unresolved, not busy, empty command line, MASTATE false, shortcuts active", finalPing?.input?.holds === 0 && finalPing?.input?.unresolved === 0 && !finalPing?.input?.busy && finalCmd === "" && finalMa === false && finalSc === true, { input: finalPing?.input, cmd: finalCmd, ma: finalMa, shortcuts: finalSc });
  await A.end();
  return { ping, finalPing };
}

if (mode !== "run") {
  console.error("usage: node scripts/kb05-probe.mjs run [--out report.json]");
  process.exit(2);
}
run().then(({ ping, finalPing }) => {
  const report = { probe: "kb-05-run", date: new Date().toISOString(), bridge: { version: ping.bridgeVersion, host: ping.host, port: ping.port, build: ping.build, hostname: ping.hostname, showfile: ping.showfile, input: ping.input }, passed: steps.filter((s) => s.pass === true).length, failed, steps, finalInput: finalPing?.input };
  if (outFile) { fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + "\n"); console.log(`report written to ${outFile}`); }
  console.log(`${report.passed}/${steps.filter((s) => s.pass !== null).length} passed`);
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.error(`probe aborted: ${e.message}`); process.exit(2); });
