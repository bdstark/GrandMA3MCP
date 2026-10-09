import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

/**
 * scripts/kb04-probe.mjs presses REAL console keys, so its preconditions matter more than its checks: it
 * must refuse to run against a bridge without the keyboard backend, with input disabled or on the fake
 * backend, with Lua off (no verification possible), on a show whose name does not look disposable, or
 * with holds already present. The lifecycle itself is covered by the Lua harnesses; this guards the gate.
 */

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "kb04-probe.mjs");

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

const idle = { enabled: true, backend: "keyboard", holds: 0, unresolved: 0, unresolvedFromPreviousRun: 0 };
const ping = (input: any, extra: Record<string, unknown> = {}) => ({ bridgeVersion: "0.6.0", host: "127.0.0.1", port: 9800, showfile: "mcp-test-disposable", lua: { enabled: true }, input, ...extra });
const pressed: string[] = [];
const refusing = (p: unknown): Handler => (op, args) => {
  if (op === "ping") return p;
  if (op === "lua") return { values: [""] };
  if (op === "input.press" || op === "input.tap" || op === "input.combo") pressed.push(JSON.stringify(args));
  throw new Error("unexpected " + op);
};

test("refuses an old bridge without the keyboard backend", async () => {
  const b = await startFakeBridge(refusing({ ...ping(idle), bridgeVersion: "0.5.0" }));
  try {
    const r = await run(["run"], { GMA3_BRIDGE_PORT: String(b.port) });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /0\.6\.0 or newer/);
  } finally { b.close(); }
});

test("refuses when input is disabled or on the fake backend, and when Lua is off", async () => {
  for (const [input, extra, pattern] of [
    [{ ...idle, enabled: false }, {}, /input=keyboard/],
    [{ ...idle, backend: "fake" }, {}, /input=keyboard/],
    [idle, { lua: { enabled: false } }, /lua on/],
  ] as const) {
    const b = await startFakeBridge(refusing(ping(input, extra)));
    try {
      const r = await run(["run"], { GMA3_BRIDGE_PORT: String(b.port) });
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, pattern);
    } finally { b.close(); }
  }
});

test("refuses a show that does not look disposable and a bridge with existing holds", async () => {
  const b1 = await startFakeBridge(refusing({ ...ping(idle), showfile: "Festival_Main" }));
  try {
    const r = await run(["run"], { GMA3_BRIDGE_PORT: String(b1.port) });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /disposable/);
  } finally { b1.close(); }
  const b2 = await startFakeBridge(refusing(ping({ ...idle, holds: 1 })));
  try {
    const r = await run(["run"], { GMA3_BRIDGE_PORT: String(b2.port) });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /already has 1 hold/);
  } finally { b2.close(); }
  assert.equal(pressed.length, 0, "no key was pressed on any refused precondition");
});

test("refuses when the console is not idle (command line, MASTATE or shortcuts)", async () => {
  const b = await startFakeBridge((op, args) => {
    if (op === "ping") return ping(idle);
    if (op === "lua") return { values: [/MAState/.test(args.code) ? true : /KeyboardShortcutsActive/.test(args.code) ? true : ""] };
    if (op === "input.press" || op === "input.tap" || op === "input.combo") pressed.push(JSON.stringify(args));
    throw new Error("unexpected " + op);
  });
  try {
    const r = await run(["run"], { GMA3_BRIDGE_PORT: String(b.port) });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /MASTATE=true/);
    assert.equal(pressed.length, 0);
  } finally { b.close(); }
});

test("usage error without a mode", async () => {
  const r = await run([], {});
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});
