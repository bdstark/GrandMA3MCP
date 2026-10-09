import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * scripts/kb02-probe.mjs against a fake bridge: the verifier must fail when the live readers do not
 * produce the expected successful values, and the probe must never overwrite or delete files it did
 * not create.
 */

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "kb02-probe.mjs");

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
    });
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() }));
  });
}

// Asynchronous on purpose: the fake bridge runs in this process, so a blocking spawnSync would starve it.
function run(args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, env: { ...process.env, ...env } });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => { stdout += d; });
    child.stderr.setEncoding("utf8").on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const ping = (lua = true) => ({ bridgeVersion: "0.4.0", host: "127.0.0.1", port: 9800, showfile: "mcp-test-disposable", hostname: "elsewhere", lua: { enabled: lua } });
const modulesOk = { apiVersion: 1, modules: { hardkeys: { loaded: true, version: "0.1.0", status: { state: "ready" } }, feedback: { loaded: true, version: "0.1.0", status: { state: "ready" } } } };

test("verify fails when Blind is unavailable or PLEASE is unsupported", async () => {
  const bad = await startFakeBridge((op) => {
    if (op === "ping") return ping();
    if (op === "modules") return modulesOk;
    if (op === "lua") return { values: [{ blind: { available: false, error: "boom" }, freeze: { available: false }, please: { supported: false, reason: "unmapped" }, ma1: { supported: false } }] };
    throw new Error("unexpected op " + op);
  });
  try {
    const r = await run(["verify"], { GMA3_BRIDGE_PORT: String(bad.port), GMA3_LIBRARY: os.tmpdir() });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /FAIL {2}live readers: blind=UNAVAILABLE/);
    assert.match(r.stdout, /PLEASE=UNSUPPORTED/);
    assert.match(r.stdout, /VERIFY FAILED/);
    assert.match(r.stdout, /INFO {2}loose plugin files/);
    assert.doesNotMatch(r.stdout, /PASS {2}loose/);
  } finally { bad.close(); }
});

test("verify passes only with successful reader and resolution values", async () => {
  const good = await startFakeBridge((op) => {
    if (op === "ping") return ping();
    if (op === "modules") return modulesOk;
    if (op === "lua") return { values: [{ blind: { available: true, value: false }, freeze: { available: false }, please: { supported: true, pcKey: "Enter" }, ma1: { supported: false } }] };
    throw new Error("unexpected op " + op);
  });
  try {
    const r = await run(["verify"], { GMA3_BRIDGE_PORT: String(good.port), GMA3_LIBRARY: os.tmpdir() });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /PASS {2}live readers: blind=false .*PLEASE=-> Enter/);
    assert.match(r.stdout, /says nothing about the console/);
  } finally { good.close(); }
});

test("probe refuses to overwrite an existing file and leaves it intact", async () => {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), "kb02-lib-"));
  const dir = path.join(lib, "datapools", "plugins");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "kb02_probe.lua"), "-- operator's own file\n");
  const calls: string[] = [];
  const bridge = await startFakeBridge((op, args) => {
    calls.push(op);
    if (op === "ping") return ping();
    if (op === "lua") return { values: [false] };  // slot free
    throw new Error("unexpected op " + op);
  });
  try {
    const r = await run(["probe", "--slot", "7"], { GMA3_BRIDGE_PORT: String(bridge.port), GMA3_LIBRARY: lib });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /refusing to overwrite existing file\(s\)/);
    assert.equal(fs.readFileSync(path.join(dir, "kb02_probe.lua"), "utf8"), "-- operator's own file\n");
    assert.deepEqual(fs.readdirSync(dir), ["kb02_probe.lua"], "nothing else was written");
    assert.ok(!calls.some((op, i) => op === "lua" && i > 1), "no import or delete was attempted");
  } finally { bridge.close(); fs.rmSync(lib, { recursive: true, force: true }); }
});

test("probe removes only the files it created, even when the console fails", async () => {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), "kb02-lib-"));
  const dir = path.join(lib, "datapools", "plugins");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "other_plugin.lua"), "keep me\n");
  let luaCalls = 0;
  const bridge = await startFakeBridge((op) => {
    if (op === "ping") return ping();
    if (op === "lua") { luaCalls++; if (luaCalls === 1) return { values: [false] }; throw new Error("console exploded"); }
    throw new Error("unexpected op " + op);
  });
  try {
    const r = await run(["probe", "--slot", "7"], { GMA3_BRIDGE_PORT: String(bridge.port), GMA3_LIBRARY: lib });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.deepEqual(fs.readdirSync(dir), ["other_plugin.lua"], "probe files cleaned up, unrelated file kept");
  } finally { bridge.close(); fs.rmSync(lib, { recursive: true, force: true }); }
});
