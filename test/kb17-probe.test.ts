import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { summarize, generationMoved } from "../scripts/kb17-probe.mjs";

/**
 * scripts/kb17-probe.mjs: `verify` is read-only and must send nothing but reads (feedback.context,
 * feedback.watch/unwatch, feedback.read, ping); `run` changes console state and must refuse an old bridge, an
 * old feedback module, a show whose name does not look disposable, Lua off and a busy bridge. The reader
 * behaviour itself is covered by the Lua harnesses.
 */

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "kb17-probe.mjs");

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

const modules = { hardkeys: { loaded: true, version: "0.10.0" }, feedback: { loaded: true, version: "0.3.0" } };
const ping = (extra: Record<string, unknown> = {}) => ({ bridgeVersion: "0.13.0", host: "127.0.0.1", port: 9800, showfile: "mcp-test-disposable", user: "Admin", lua: { enabled: true }, input: { enabled: false, sessions: 0, holds: 0, busy: null }, modules, ...extra });
const mutating: string[] = [];
const refusing = (p: unknown): Handler => (op) => {
  if (op === "ping") return p;
  if (op === "cmd" || op === "setfader" || op === "lua" || op === "set" || op.startsWith("input.")) mutating.push(op);
  throw new Error("unexpected " + op);
};

test("refuses an old bridge, an old feedback module and a module that did not load", async () => {
  for (const [extra, pattern] of [
    [{ bridgeVersion: "0.12.0" }, /0\.13\.0 or newer/],
    [{ modules: { ...modules, feedback: { loaded: true, version: "0.2.0" } } }, /0\.3\.0 or newer/],
    [{ modules: { ...modules, feedback: { loaded: false, error: "simulated" } } }, /feedback module is not loaded: simulated/],
  ] as const) {
    const b = await startFakeBridge(refusing(ping(extra)));
    try {
      const r = await run(["verify"], { GMA3_BRIDGE_PORT: String(b.port) });
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, pattern);
    } finally { b.close(); }
  }
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

function snapshot(executors: number[], generation = 1, extra: Record<string, unknown> = {}) {
  const slot = (n: number, name: string, label: string) => ({ slot: n, kind: "attribute", name, label, unit: "None", readout: "Percent", resolution: "Coarse", layer: "Absolute", availability: "no-selection", valueState: "none" });
  const exec = (n: number, cls: string, keyPress: string) => ({ available: true, name: "executorTarget", key: `executorTarget[executor=${n}]`, value: { executor: n, empty: false, assigned: { name: `Obj ${n}`, class: cls, no: n }, functions: { keyPress, keyUnpress: "", fader: "Master" }, level: { token: "FaderMaster", value: 100 }, active: false, appearance: { backRGBA: "0,0,0,1" }, playbackTarget: cls !== "Quickey", reason: cls === "Quickey" ? "a Quickey object is never a playback target" : undefined } });
  return {
    observedAt: 1, epoch: 1, atomic: false, generation, generationChanged: false, module: { component: "gma3_mcp_feedback", version: "0.3.0" }, bridgeVersion: "0.13.0",
    identity: { showFile: "mcp-test-disposable", user: "Admin", profile: "Default", dataPool: { name: "Default", no: 1 } },
    authoritativeDisplay: { display: 1, rule: "configured" }, executorPage: { name: "Page 1", no: 1 },
    encoder: { available: true, value: { display: 1, bank: { index: 1, name: "Dimmer", pages: 1 }, page: { index: 1, name: "Dimmer", slots: 1 }, context: "Default", attributeEditing: true } },
    slots: { available: true, value: { selection: { count: 0, scanned: 0, partial: false, limitations: [] }, slots: [slot(1, "Dimmer", "Dim")] } },
    executors: executors.map((n) => (n === 999 ? { available: true, value: { executor: 999, empty: true, playbackTarget: false, reason: "the executor is empty" } } : exec(n, n === 178 ? "Quickey" : "Sequence", "Temp"))),
    limitations: [], ...extra,
  };
}

test("verify sends only reads and reports the contract checks", async () => {
  const ops: string[] = [];
  let watched = 0;
  const b = await startFakeBridge((op, args) => {
    ops.push(op);
    if (op === "ping") return ping();
    if (op === "feedback.context") {
      if (args.executors === "x") throw new Error("[bad-args] args.executors must be a list");
      if (args.display === 2) return snapshot([], 1, { authoritativeDisplay: { display: 2, rule: "requested" }, encoder: { available: false, reason: "display 2 has no encoder bar (no EncoderBarContainer); no other display is substituted" } });
      if (args.display === 9) return snapshot([], 1, { authoritativeDisplay: { display: 9, rule: "requested" }, encoder: { available: false, reason: "display 9 does not exist on this console" } });
      if (args.allExecutors) return snapshot([178, 191, 193]);
      return snapshot(args.executors ?? [], 1, args.cached ? { cached: true, notObserved: 0, encoder: { available: true, ageMs: 40, value: snapshot([]).encoder.value }, slots: { available: true, ageMs: 40, value: snapshot([]).slots.value } } : {});
    }
    if (op === "feedback.watch") { watched = 4 + args.executors.length; return { watched }; }
    if (op === "feedback.unwatch") return { watched: 0 };
    if (op === "feedback.read") return { items: [{ name: "commandText", available: true, value: "" }] };
    throw new Error("unexpected " + op);
  });
  try {
    const r = await run(["verify"], { GMA3_BRIDGE_PORT: String(b.port) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /PASS {2}Quickey-bank executors are never playback targets/);
    assert.match(r.stdout, /PASS {2}display 2: requested rule/);
    assert.match(r.stdout, /PASS {2}a cached snapshot is served/);
    assert.match(r.stdout, /PASS {2}an executor that does not exist is an explicit empty target/);
    assert.ok(ops.every((o) => ["ping", "feedback.context", "feedback.watch", "feedback.unwatch", "feedback.read"].includes(o)), `only reads: ${ops.join(",")}`);
  } finally { b.close(); }
});

test("summarize keeps the parts that matter and generationMoved needs a higher, changed generation", () => {
  const s = summarize(snapshot([191, 178]) as any);
  assert.equal(s!.encoder.bank.name, "Dimmer");
  assert.equal(s!.slots[0].name, "Dimmer");
  assert.equal(s!.executors[1].playbackTarget, false);
  assert.equal(summarize(null), null);
  assert.equal(generationMoved({ generation: 1 }, { generation: 2, generationChanged: true }), true);
  assert.equal(generationMoved({ generation: 1 }, { generation: 2, generationChanged: false }), false);
  assert.equal(generationMoved({ generation: 2 }, { generation: 1, generationChanged: true }), false);
  assert.equal(generationMoved({ generation: undefined }, { generation: 2, generationChanged: true }), false);
});

test("usage error without a mode", async () => {
  const r = await run([], {});
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});
