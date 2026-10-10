import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

/**
 * scripts/kb06-probe.mjs: `verify` is read-only and must send nothing but reads; `run` changes console state
 * (Blind, a fader, playback) and must refuse an old bridge, a missing feedback module, a show whose name does
 * not look disposable, Lua off and a busy bridge. The reader behaviour itself is covered by the Lua harnesses.
 */

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "kb06-probe.mjs");

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
            sock.write(JSON.stringify({ id: req.id, ok: false, error: String((e as Error).message), code: /^\[([\w-]+)\]/.exec((e as Error).message)?.[1] }) + "\n");
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

const modules = { hardkeys: { loaded: true, version: "0.4.0" }, feedback: { loaded: true, version: "0.2.0" } };
const ping = (extra: Record<string, unknown> = {}) => ({ bridgeVersion: "0.9.0", host: "127.0.0.1", port: 9800, showfile: "mcp-test-disposable", user: "Admin", lua: { enabled: true }, input: { enabled: false, sessions: 0, holds: 0, busy: null }, modules, ...extra });
const mutating: string[] = [];
const refusing = (p: unknown): Handler => (op) => {
  if (op === "ping") return p;
  if (op === "cmd" || op === "setfader" || op === "lua" || op.startsWith("input.")) mutating.push(op);
  throw new Error("unexpected " + op);
};

test("refuses an old bridge without the feedback ops, and a bridge whose feedback module did not load", async () => {
  const b1 = await startFakeBridge(refusing(ping({ bridgeVersion: "0.7.0" })));
  try {
    const r = await run(["verify"], { GMA3_BRIDGE_PORT: String(b1.port) });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /0\.8\.0 or newer/);
  } finally { b1.close(); }
  const b2 = await startFakeBridge(refusing(ping({ modules: { ...modules, feedback: { loaded: false, error: "simulated" } } })));
  try {
    const r = await run(["verify"], { GMA3_BRIDGE_PORT: String(b2.port) });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /feedback module is not loaded: simulated/);
  } finally { b2.close(); }
});

test("run refuses a show that does not look disposable, Lua off and a busy bridge", async () => {
  for (const [extra, pattern] of [
    [{ showfile: "Festival_Main" }, /disposable/],
    [{ lua: { enabled: false } }, /lua on/],
    [{ input: { enabled: true, busy: { reason: "interaction", owner: "conn-4" } } }, /is busy/],
  ] as const) {
    const b = await startFakeBridge(refusing(ping(extra)));
    try {
      const r = await run(["run"], { GMA3_BRIDGE_PORT: String(b.port) });
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, pattern);
    } finally { b.close(); }
  }
  assert.equal(mutating.length, 0, "nothing mutating was sent on any refused precondition");
});

test("verify sends only reads and reports the contract checks", async () => {
  const ops: string[] = [];
  const item = (name: string, key: string, value: unknown, extra: Record<string, unknown> = {}) => ({ name, key, scope: "show", source: "s", available: value !== undefined, value, observedAt: 1.5, epoch: 1, ...extra });
  const b = await startFakeBridge((op, args) => {
    ops.push(op);
    if (op === "ping") return ping();
    if (op === "feedback.describe") return { version: "0.2.0", readers: Array.from({ length: 16 }, (_, i) => ({ name: `r${i}` })) };
    if (op === "executors") return { executors: [] };
    if (op === "feedback.read") {
      if (args.readers?.length === 1 && args.readers[0] === "sequenceActive") throw new Error("[no-items] nothing to read");
      if (args.items) return { atomic: false, epoch: 1, count: 1, items: [item("executorActive", "executorActive[sequence=1]", false, { alias: "sequenceActive", note: "deprecated alias" })], limitations: [] };
      if (args.executors?.length === 40) return { atomic: false, epoch: 1, count: 64, items: [], limitations: ["executors truncated to 32 of 40"] };
      const items = [
        item("blind", "blind", true), item("highlight", "highlight", false), item("solo", "solo", false), item("shortcutsActive", "shortcutsActive", true), item("maState", "maState", false),
        item("commandText", "commandText", ""), item("lastCommand", "lastCommand", "OK"), item("previewMode", "previewMode", "Normal"), item("page", "page", { name: "Page 1", no: 1 }),
        item("selectedSequence", "selectedSequence", { selected: false }), item("freeze", "freeze", undefined, { reason: "no readable Freeze state was found in KB-01" }),
        item("previewBar", "previewBar[display=1]", false, { params: { display: 1 } }), item("previewBar", "previewBar[display=2]", undefined, { reason: "display 2 does not exist" }), item("previewBar", "previewBar[display=9]", undefined, { reason: "display 9 does not exist" }),
        item("executor", "executor[executor=101]", { executor: 101, empty: true }), item("executor", "executor[executor=190]", { executor: 190, empty: true }), item("fader", "fader[executor=190]", undefined, { reason: "executor 190 is empty" }),
        item("sequenceActive", "sequenceActive[sequence=1]", false), item("sequenceActive", "sequenceActive[sequence=999999]", undefined, { reason: "sequence 999999 not found" }),
      ];
      return { atomic: false, epoch: 1, identity: { showFile: "mcp-test-disposable" }, count: items.length, items, limitations: [] };
    }
    throw new Error("unexpected " + op);
  });
  try {
    const r = await run(["verify"], { GMA3_BRIDGE_PORT: String(b.port) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /PASS {2}freeze is unavailable/);
    assert.match(r.stdout, /PASS {2}40 executors are bounded/);
    assert.match(r.stdout, /NOTE {2}input disabled/);
    assert.ok(ops.every((o) => ["ping", "feedback.describe", "feedback.read", "executors"].includes(o)), `only reads: ${ops.join(",")}`);
  } finally { b.close(); }
});

test("usage error without a mode", async () => {
  const r = await run([], {});
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});
