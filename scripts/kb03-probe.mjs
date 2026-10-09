#!/usr/bin/env node
// KB-03 owned-input-session probe against a RUNNING bridge on the fake backend (see docs/modules.md,
// KEYBOARD.md "KB-03").
//
//   node scripts/kb03-probe.mjs run [--out report.json]
//
// Exercises the connection-bound session lifecycle end to end over real TCP connections: open/renew,
// ownership conflicts across two connections, raw/logical aliases, duplicate presses, tap deadlines
// serviced by the plugin loop, failed releases kept as unresolved records and recovered, lease expiry,
// an observed "physical" release that is never compensated, and cleanup on an abrupt disconnect.
// Nothing reaches a console key: the fake backend only records events. The bridge must have been
// started (or toggled) with  Plugin "gma3_mcp_bridge" "input=fake". Lua execution is NOT required.
// GMA3_BRIDGE_HOST / GMA3_BRIDGE_PORT select the bridge.
import net from "node:net";
import fs from "node:fs";

const host = process.env.GMA3_BRIDGE_HOST ?? "127.0.0.1";
const port = Number(process.env.GMA3_BRIDGE_PORT ?? 9800);
const argv = process.argv.slice(2);
const mode = argv[0];
const outIdx = argv.indexOf("--out");
const outFile = outIdx >= 0 ? argv[outIdx + 1] : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One persistent JSON-lines connection; the bridge binds an input session to it. */
class Conn {
  constructor(name) {
    this.name = name;
    this.seq = 0;
    this.pending = new Map();
    this.buf = "";
    this.sock = null;
  }
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
  /** Resolves to { ok, result } or { ok:false, error } (bridge-level errors never throw). */
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
const errorOf = (r) => (r.ok ? "" : r.error);
const codeIs = (r, code) => !r.ok && r.error.includes(`[${code}]`);

async function pollStatus(conn, predicate, timeoutMs) {
  const until = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await conn.request("input.status");
    if (last.ok && predicate(last.result)) return last.result;
    if (Date.now() > until) return last.ok ? last.result : null;
    await sleep(100);
  }
}
const holdOf = (status, pred) => (status?.status?.holds ?? []).find(pred);

async function run() {
  const A = new Conn("A");
  await A.connect();
  const pingR = await A.request("ping");
  if (!pingR.ok) throw new Error(`ping failed: ${pingR.error}`);
  const ping = pingR.result;
  console.log(`bridge ${ping.bridgeVersion} on ${ping.host}:${ping.port}; show "${ping.showfile ?? ""}"; input ${ping.input ? (ping.input.enabled ? `enabled (${ping.input.backend})` : "disabled") : "not reported"}`);
  const [maj, min] = String(ping.bridgeVersion ?? "0.0").split(".").map(Number);
  if (!ping.input || maj < 0 || (maj === 0 && min < 5)) {
    console.error(`bridge ${ping.bridgeVersion} has no owned input sessions; update the plugin to 0.5.0 or newer (docs/setup/bridge.md)`);
    A.destroy();
    process.exit(2);
  }
  if (!ping.input.enabled || ping.input.backend !== "fake") {
    console.error('input is not enabled on the fake backend. The console operator enables it with:  Plugin "gma3_mcp_bridge" "input=fake"  (or starts the bridge with that argument). Nothing reaches a console key on the fake backend.');
    A.destroy();
    process.exit(2);
  }
  if (ping.input.holds > 0 || ping.input.unresolved > 0 || ping.input.unresolvedFromPreviousRun > 0) {
    console.error(`the bridge already has ${ping.input.holds} hold(s), ${ping.input.unresolved} unresolved and ${ping.input.unresolvedFromPreviousRun} kept record(s); resolve them first (input status / input recover)`);
    A.destroy();
    process.exit(2);
  }

  // 1. Sessions are bound to connections.
  let r = await A.request("input.press", { key: "PLEASE" });
  record("press without a session is refused", codeIs(r, "no-session"), errorOf(r));
  r = await A.request("input.open", { leaseMs: 3000, label: "kb03-probe A" });
  record("A opens a 3 s session bound to its connection", r.ok && typeof r.result.session?.id === "string" && r.result.session.leaseMs === 3000, r.ok ? r.result.session.id : r.error);
  const sessA = r.result?.session?.id;
  const B = new Conn("B");
  await B.connect();
  r = await B.request("input.open", { leaseMs: 60000, label: "kb03-probe B" });
  record("B opens its own session", r.ok && r.result.session?.id && r.result.session.id !== sessA, r.ok ? r.result.session.id : r.error);
  const sessB = r.result?.session?.id;
  r = await B.request("input.renew", { leaseMs: 50000, session: sessA });
  record("a session id in args is ignored (B cannot renew A's session)", r.ok && r.result.session.id === sessB, r.ok ? r.result.session.id : r.error);

  // 2. Press, duplicates, conflicts, aliases.
  r = await A.request("input.press", { key: "PLEASE", display: 1 });
  const please = r.result?.hold;
  record("A presses PLEASE: stored tuple and route", r.ok && please.pcKey && please.route?.source && please.session === sessA, r.ok ? `${please.logical} -> ${please.tupleKey} via ${please.route.source}${please.route.shortcut ? ` "${please.route.shortcut}"` : ""} profile ${please.route.profile ?? "?"}` : r.error);
  r = await A.request("input.press", { key: "PLEASE" });
  record("A's second PLEASE is a harmless duplicate", r.ok && r.result.hold.duplicate === true && r.result.hold.id === please?.id, errorOf(r));
  r = await B.request("input.press", { key: "PLEASE" });
  record("B cannot own PLEASE while A holds it", codeIs(r, "conflict"), errorOf(r));
  r = await B.request("input.press", { pcKey: please?.pcKey ?? "Enter", display: 2 });
  record("B's raw alias of the held key (other display) is rejected", codeIs(r, "conflict") || codeIs(r, "bad-argument"), errorOf(r));
  r = await B.request("input.release", { key: "PLEASE" });
  record("B cannot release A's hold", codeIs(r, "not-owner"), errorOf(r));
  r = await B.request("input.status");
  record("status from B shows A as owner with remaining lease, releases nothing", r.ok && holdOf(r.result, (h) => h.id === please?.id)?.state === "held" && r.result.status.sessions[sessA]?.remainingMs !== undefined && r.result.policy.holds === 1, r.ok ? r.result.policy : r.error);

  // 3. Tap deadline serviced by the plugin loop.
  r = await A.request("input.tap", { key: "STORE", holdMs: 200 });
  record("A taps STORE for 200 ms", r.ok && r.result.hold.kind === "tap", errorOf(r));
  const tapId = r.result?.hold?.id;
  let st = await pollStatus(A, (s) => holdOf(s, (h) => h.id === tapId)?.state === "released", 3000);
  const tapHold = holdOf(st, (h) => h.id === tapId);
  record("the loop released the tap at its deadline", tapHold?.state === "released" && tapHold.dispatch?.release?.reason === "tap", tapHold ? `${tapHold.state} after ${tapHold.heldMs} ms (${tapHold.dispatch?.release?.reason})` : "hold not reported");

  // 4. Failed release -> unresolved record -> recover.
  r = await A.request("input.fake", { action: "failRelease", pcKey: please?.pcKey, sticky: true, error: "probe: host blocked" });
  record("fake backend set to fail the PLEASE release", r.ok, errorOf(r));
  r = await A.request("input.release", { key: "PLEASE" });
  record("a failed release is reported as unresolved and the record kept", r.ok && r.result.hold.state === "unresolved" && /host blocked/.test(r.result.hold.unresolved?.reason ?? ""), r.ok ? r.result.hold.unresolved?.reason : r.error);
  r = await B.request("input.press", { pcKey: please?.pcKey });
  record("the unresolved tuple is still blocked for B", codeIs(r, "conflict"), errorOf(r));
  r = await B.request("input.recover");
  record("B's recover is owner-scoped (nothing of B's to recover)", r.ok && r.result.attempted === 0, r.ok ? r.result : r.error);
  r = await A.request("input.recover");
  record("A's recover while the fault persists stays unresolved", r.ok && r.result.unresolved?.length === 1 && r.result.released?.length === 0, r.ok ? `${r.result.released.length} released, ${r.result.unresolved.length} unresolved` : r.error);
  await A.request("input.fake", { action: "clearFailures" });
  r = await A.request("input.recover");
  record("A's recover after the fault clears releases with the stored tuple", r.ok && r.result.released?.length === 1 && r.result.released[0].tupleKey === please?.tupleKey, r.ok ? r.result.released[0]?.tupleKey : r.error);
  st = await pollStatus(A, (s) => s.policy.unresolved === 0, 1000);
  record("no unresolved record remains", st?.policy?.unresolved === 0, st?.policy);

  // 5. Lease expiry releases A's holds; A must renew before new input.
  r = await A.request("input.press", { key: "MA" });
  record("A presses MA (LeftShift fixed route)", r.ok && r.result.hold.pcKey === "LeftShift", errorOf(r));
  const maId = r.result?.hold?.id;
  st = await pollStatus(A, (s) => s.status.sessions[sessA]?.state === "expired", 4500);
  record("A's 3 s lease expired on the loop", st?.status?.sessions?.[sessA]?.state === "expired", st?.status?.sessions?.[sessA]?.state);
  st = await pollStatus(A, (s) => holdOf(s, (h) => h.id === maId)?.state === "released", 1500);
  const maHold = holdOf(st, (h) => h.id === maId);
  record("lease expiry released the MA hold (reason lease-expired)", maHold?.state === "released" && maHold.dispatch?.release?.reason === "lease-expired", maHold ? `${maHold.state} (${maHold.dispatch?.release?.reason})` : "hold not reported");
  r = await A.request("input.press", { key: "MA" });
  record("press after expiry refused until renewal", codeIs(r, "lease-expired"), errorOf(r));
  r = await A.request("input.renew", { leaseMs: 60000 });
  record("renewal reactivates the session without a press", r.ok && r.result.session.state === "active", errorOf(r));

  // 6. Shared console state: a "physical" release is observed, never compensated.
  r = await A.request("input.press", { key: "MA" });
  const ma2 = r.result?.hold?.id;
  let fakeBefore = (await A.request("input.fake", { action: "events" })).result;
  r = await A.request("input.fake", { action: "physicalRelease", pcKey: "LeftShift" });
  record("fake backend simulates a physical LeftShift release", r.ok && !r.result.down.includes("LeftShift|s0c0a0n0"), r.ok ? r.result.down : r.error);
  st = await pollStatus(A, (s) => holdOf(s, (h) => h.id === ma2)?.observed?.down === false, 1500);
  const obs = holdOf(st, (h) => h.id === ma2);
  const fakeAfter = (await A.request("input.fake", { action: "events" })).result;
  record("ownership record stays held while the console no longer reports the key down", obs?.state === "held" && obs.observed?.down === false, obs ? { state: obs.state, observed: obs.observed } : "hold not reported");
  record("no automatic re-press to compensate", fakeAfter?.counters?.press === fakeBefore?.counters?.press, { before: fakeBefore?.counters?.press, after: fakeAfter?.counters?.press });
  r = await A.request("input.release", { key: "MA" });
  record("A's own release resolves the record", r.ok && r.result.hold.state === "released", errorOf(r));

  // 7. Abrupt disconnect releases the connection's holds.
  r = await B.request("input.press", { pcKey: "Q", ctrl: true });
  record("B holds Ctrl+Q", r.ok && r.result.hold.tupleKey === "Q|s0c1a0n0", errorOf(r));
  B.destroy();
  st = await pollStatus(A, (s) => s.status.sessions[sessB] === undefined && s.policy.holds === 0, 3000);
  const fakeEvents = (await A.request("input.fake", { action: "events" })).result;
  const lastQ = [...(fakeEvents?.events ?? [])].reverse().find((e) => e.pcKey === "Q");
  record("B's disconnect released its hold and dropped its session", st?.status?.sessions?.[sessB] === undefined && st?.policy?.holds === 0 && lastQ?.kind === "release", { session: st?.status?.sessions?.[sessB]?.state ?? "gone", lastQEvent: lastQ?.kind });

  // 8. Clean up A.
  r = await A.request("input.releaseAll");
  record("A releaseAll (nothing left)", r.ok && r.result.attempted === 0, errorOf(r));
  r = await A.request("input.close");
  record("A closes its session", r.ok, errorOf(r));
  const finalFake = (await A.request("input.fake", { action: "events" })).result;
  const finalPing = (await A.request("ping")).result;
  record("bridge left clean: no holds, nothing down on the fake backend, nothing unresolved", finalPing?.input?.holds === 0 && finalPing?.input?.unresolved === 0 && finalFake?.down?.length === 0, finalPing?.input);
  await A.end();

  const report = { probe: "kb-03", date: new Date().toISOString(), bridge: { version: ping.bridgeVersion, host: ping.host, port: ping.port, build: ping.build, hostname: ping.hostname, showfile: ping.showfile, input: ping.input }, passed: steps.length - failed, failed, steps, fakeEvents: finalFake?.events };
  if (outFile) { fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + "\n"); console.log(`report written to ${outFile}`); }
  console.log(`${steps.length - failed}/${steps.length} passed`);
  process.exit(failed ? 1 : 0);
}

if (mode !== "run") {
  console.error("usage: node scripts/kb03-probe.mjs run [--out report.json]");
  process.exit(2);
}
run().catch((e) => { console.error(`probe aborted: ${e.message}`); process.exit(2); });
