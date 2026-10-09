import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

/**
 * scripts/kb03-probe.mjs against fake bridges: it must refuse to run when owned input is not enabled on
 * the fake backend or the bridge is too old, and it must FAIL (not pass) against a bridge that admits
 * conflicting owners. The real lifecycle is covered by test/lua/hardkeys_sessions_test.lua and the
 * bridge harness; this only guards the probe's own checks.
 */

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "kb03-probe.mjs");

type Handler = (op: string, args: any, sock: net.Socket) => unknown;

function startFakeBridge(handler: Handler): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf = "";
      sock.setEncoding("utf8");
      sock.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const req = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          try {
            sock.write(JSON.stringify({ id: req.id, ok: true, result: handler(req.op, req.args, sock) }) + "\n");
          } catch (e) {
            sock.write(JSON.stringify({ id: req.id, ok: false, error: String((e as Error).message) }) + "\n");
          }
        }
      });
      sock.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() }));
  });
}

function run(args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, env: { ...process.env, ...env } });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => { stdout += d; });
    child.stderr.setEncoding("utf8").on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const ping = (input: any, version = "0.5.0") => ({ bridgeVersion: version, host: "127.0.0.1", port: 9800, showfile: "mcp-test-disposable", input });

test("refuses to run when input is disabled or on another backend", async () => {
  const off = await startFakeBridge((op) => { if (op === "ping") return ping({ enabled: false, holds: 0, unresolved: 0, unresolvedFromPreviousRun: 0 }); throw new Error("unexpected " + op); });
  try {
    const r = await run(["run"], { GMA3_BRIDGE_PORT: String(off.port) });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /input=fake/);
  } finally { off.close(); }
});

test("refuses an old bridge without input sessions", async () => {
  const old = await startFakeBridge((op) => { if (op === "ping") return { bridgeVersion: "0.4.0", host: "127.0.0.1", port: 9800 }; throw new Error("unexpected " + op); });
  try {
    const r = await run(["run"], { GMA3_BRIDGE_PORT: String(old.port) });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /0\.5\.0/);
  } finally { old.close(); }
});

test("refuses when the bridge already has holds or unresolved records", async () => {
  const busy = await startFakeBridge((op) => { if (op === "ping") return ping({ enabled: true, backend: "fake", holds: 1, unresolved: 0, unresolvedFromPreviousRun: 0 }); throw new Error("unexpected " + op); });
  try {
    const r = await run(["run"], { GMA3_BRIDGE_PORT: String(busy.port) });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /resolve them first/);
  } finally { busy.close(); }
});

test("a bridge that admits conflicting owners and never releases makes the probe FAIL", async () => {
  // Every connection gets a session, every press succeeds, nothing is ever released: ownership is not
  // enforced, so the conflict, not-owner, tap-deadline and disconnect checks must all fail.
  let n = 0;
  const sessions = new WeakMap<net.Socket, string>();
  const permissive = await startFakeBridge((op, args, sock) => {
    if (op === "ping") return ping({ enabled: true, backend: "fake", holds: 0, unresolved: 0, unresolvedFromPreviousRun: 0 });
    if (op === "input.open") { const id = `conn-${++n}`; sessions.set(sock, id); return { session: { id, leaseMs: args.leaseMs ?? 15000, state: "active" } }; }
    if (op === "input.renew") return { session: { id: sessions.get(sock), state: "active", leaseMs: args.leaseMs } };
    if (op === "input.press" || op === "input.tap") return { hold: { id: `h${++n}`, pcKey: args.pcKey ?? "Enter", logical: args.key, tupleKey: `${args.pcKey ?? "Enter"}|s0c${args.ctrl ? 1 : 0}a0n0`, kind: op === "input.tap" ? "tap" : "hold", state: "held", session: sessions.get(sock), route: { source: "shortcut-table", shortcut: "Enter" } } };
    if (op === "input.release") return { hold: { state: "released" } };
    if (op === "input.status") return { policy: { holds: 1, unresolved: 0 }, status: { holds: [], sessions: {} } };
    if (op === "input.fake") return { down: [], events: [], counters: { press: 0 } };
    if (op === "input.recover") return { attempted: 0, released: [], unresolved: [] };
    if (op === "input.releaseAll") return { attempted: 0 };
    if (op === "input.close") return {};
    throw new Error("unexpected " + op);
  });
  try {
    const r = await run(["run"], { GMA3_BRIDGE_PORT: String(permissive.port) });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /FAIL  press without a session is refused/);
    assert.match(r.stdout, /FAIL  B cannot own PLEASE while A holds it/);
    assert.match(r.stdout, /FAIL  B cannot release A's hold/);
    assert.match(r.stdout, /FAIL  the loop released the tap at its deadline/);
    assert.match(r.stdout, /FAIL  a failed release is reported as unresolved/);
    assert.match(r.stdout, /PASS  A opens a 3 s session/);
  } finally { permissive.close(); }
});
