import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

/**
 * scripts/kb14-probe.mjs presses REAL console keys and toggles the operator's keyboard-shortcut mode, so its
 * preconditions matter more than its checks: both modes must refuse a show whose name does not look disposable,
 * Lua off (nothing can be verified or restored), existing holds, a busy bridge or a pending mode change, and a
 * console that is not idle; `run` must additionally refuse a bridge without the KB-14 ops (older than 0.11.0),
 * input disabled or on another backend, and an occupied deferred macro slot before any key is pressed. The
 * behaviour itself is covered by the Lua harnesses; this guards the gate.
 */

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "kb14-probe.mjs");

type Handler = (op: string, args: any) => unknown;

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
            sock.write(JSON.stringify({ id: req.id, ok: true, result: handler(req.op, req.args) }) + "\n");
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

const idle = { enabled: true, backend: "keyboard", holds: 0, unresolved: 0, unresolvedFromPreviousRun: 0, busy: null };
const idleState = { cmd: "", ma: false, sc: false, profile: "Default" };
const ping = (input: any, extra: Record<string, unknown> = {}) => ({ bridgeVersion: "0.11.0", host: "127.0.0.1", port: 9800, showfile: "mcp-test-disposable", lua: { enabled: true }, input, modules: { hardkeys: { loaded: true, version: "0.9.0" } }, ...extra });
const dispatched: string[] = [];
const refusing = (p: unknown, state: unknown = idleState, macro: unknown = null): Handler => (op, args) => {
  if (op === "ping") return p;
  if (op === "lua") {
    if (/Macro 116/.test(args.code)) return { values: [macro] };
    if (/profile = CurrentProfile/.test(args.code)) return { values: [state] };
    return { values: [""] };
  }
  dispatched.push(op);
  throw new Error("no input op must reach the bridge when a precondition fails");
};

async function expectRefusal(mode: string, handler: Handler, pattern: RegExp, extraArgs: string[] = []) {
  const bridge = await startFakeBridge(handler);
  try {
    const r = await run([mode, ...extraArgs], { GMA3_BRIDGE_PORT: String(bridge.port) });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, pattern);
    assert.deepEqual(dispatched, []);
  } finally {
    bridge.close();
  }
}

test("run refuses an old bridge without the KB-14 routing ops, input disabled or on another backend", async () => {
  await expectRefusal("run", refusing(ping(idle, { bridgeVersion: "0.10.0" })), /0\.11\.0 or newer/);
  await expectRefusal("run", refusing(ping({ ...idle, enabled: false })), /keyboard backend/);
  await expectRefusal("run", refusing(ping({ ...idle, backend: "quickey" })), /keyboard backend/);
});

test("both modes refuse a show that does not look disposable and Lua off", async () => {
  for (const mode of ["timing", "run"]) {
    await expectRefusal(mode, refusing(ping(idle, { showfile: "Festival Main" })), /does not look disposable/);
    await expectRefusal(mode, refusing(ping(idle, { lua: { enabled: false } })), /Lua execution is off/);
  }
});

test("both modes refuse existing holds, a busy bridge, a pending mode change and a console that is not idle", async () => {
  for (const mode of ["timing", "run"]) {
    await expectRefusal(mode, refusing(ping({ ...idle, holds: 1 })), /holds, unresolved records or a pending mode change/);
    await expectRefusal(mode, refusing(ping({ ...idle, busy: { reason: "interaction", owner: "conn-3" } })), /holds, unresolved records or a pending mode change/);
    await expectRefusal(mode, refusing(ping({ ...idle, modeChange: { id: "m1", state: "active" } })), /holds, unresolved records or a pending mode change/);
    await expectRefusal(mode, refusing(ping(idle), { ...idleState, cmd: "Store " }), /console not idle/);
    await expectRefusal(mode, refusing(ping(idle), { ...idleState, ma: true }), /console not idle/);
    await expectRefusal(mode, refusing(ping(idle), { ...idleState, sc: null }), /console not idle/);
  }
});

test("run refuses an occupied deferred macro slot before any input op", async () => {
  await expectRefusal("run", refusing(ping(idle), idleState, { name: "Operator thing", lines: [{ cmd: "Go+ Sequence 5", wait: "Follow" }] }), /Macro 116 is occupied/);
  await expectRefusal("run", refusing(ping(idle), idleState, { name: "MCP kb14 deferred", lines: [] }), /Macro 116 is occupied/);
});

test("usage errors", async () => {
  const r = await run([], {});
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: node scripts\/kb14-probe\.mjs timing\|run/);
  const bad = await run(["run", "--deferred-macro", "0"], {});
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /positive macro number/);
});
