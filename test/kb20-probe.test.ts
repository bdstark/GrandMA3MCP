import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { placedValue, expectedAbsolute } from "../scripts/kb20-probe.mjs";

/**
 * scripts/kb20-probe.mjs: `verify` must send nothing that queues or applies an event (its control.submit calls
 * are refusals by construction: a press, a touch and a position on an executor fader, a touch and a position on
 * a slot without a selection); `run` moves programmer values and must refuse an old bridge, old modules, a show
 * whose name does not look disposable, control disabled or on another backend, Lua disabled and a busy bridge.
 * The strip semantics themselves are covered by the Lua harness and the live record.
 */

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "kb20-probe.mjs");

type Handler = (op: string, args: any, conn: number) => unknown;

function startFakeBridge(handler: Handler): Promise<{ port: number; close: () => void }> {
  let conns = 0;
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      const conn = ++conns;
      let buf = "";
      sock.setEncoding("utf8");
      sock.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const req = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          try {
            const result = handler(req.op, req.args, conn);
            sock.write(JSON.stringify({ id: req.id, ok: true, result }) + "\n");
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

const modules = { hardkeys: { loaded: true, version: "0.10.0" }, feedback: { loaded: true, version: "0.4.0" }, control: { loaded: true, version: "0.3.0" } };
const capabilities = { relative: true, absolute: true, touch: true, button: false, targets: { slot: true, executor: false } };
const limitations = ["the console backend serves attribute slots only: ... a strip touch (KB-20) ... refused mixed-values while the selection's values disagree unless the event says takeover"];
const ping = (extra: Record<string, unknown> = {}) => ({ bridgeVersion: "0.16.0", host: "127.0.0.1", port: 9800, showfile: "mcp-test-disposable", user: "Admin", lua: { enabled: true },
  input: { enabled: false, sessions: 0, holds: 0, busy: null }, control: { enabled: true, backend: "console", sessions: 0, gestures: 0, queued: 0 }, modules, ...extra });

const slot = (n: number, name: string, availability: string) => ({ slot: n, kind: "attribute", ref: `Attribute 1 '${name}'`, name, readout: "Percent", resolution: "Coarse", layer: "Absolute", channelFunction: "", availability, valueState: "none", physicalRange: 1 });
function snapshot(executors: number[], generation = 1, selection = 0) {
  return {
    observedAt: 1, epoch: 1, atomic: false, cached: true, notObserved: 0, generation, generationChanged: false, bindingKey: `display=1;executors=${executors.join(",")}`,
    identity: { showFile: "mcp-test-disposable", user: "Admin", profile: "Default", dataPool: { name: "Default", no: 1 } }, display: 1, executorPage: { name: "Page 1", no: 1 },
    encoder: { available: true, value: { display: 1, bank: { index: 1, name: "Dimmer", pages: 1 }, page: { index: 1, name: "Dimmer", slots: 1 }, context: "Default", attributeEditing: true } },
    slots: { available: true, value: { selection: { count: selection, fixtures: selection ? [401] : [], identityComplete: true }, slots: [slot(1, "Dimmer", selection ? "available" : "no-selection")] } },
    executors: executors.map((n) => ({ available: true, value: { executor: n, page: 1, empty: false, playbackTarget: true, assigned: { addr: "Sequence 1" }, functions: { keyPress: "Go+", fader: "Master" }, level: { token: "FaderMaster", value: 0 } } })),
    limitations: [],
  };
}

test("placedValue and expectedAbsolute: the probe's own expectations", () => {
  assert.equal(placedValue({ readout: "Percent" }, 0.25), 25);
  assert.equal(placedValue({ readout: "PercentFine" }, 1), 100);
  assert.equal(placedValue({ readout: "Physical", physicalFrom: -225, physicalTo: 225 }, 0.5), 0);
  assert.equal(placedValue({ readout: "Physical", physicalFrom: -225, physicalTo: 225 }, 0.1), -180);
  assert.equal(placedValue({ readout: "Physical", physicalFrom: -225, physicalTo: 225, physicalMixed: true }, 0.5), undefined, "a mixed physical range places nothing");
  assert.equal(placedValue({ readout: "Physical" }, 0.5), undefined);
  assert.equal(placedValue({ readout: "Dec8" }, 0.5), undefined);
  assert.equal(placedValue({ readout: "Percent" }, 1.5), undefined);
  assert.equal(expectedAbsolute({ readout: "Physical", physicalFrom: -225, physicalTo: 225 }, 0.1), 10, "the programmer reads a percentage of the range");
  assert.equal(expectedAbsolute({ readout: "Dec8" }, 0.1), undefined);
});

const mutating: string[] = [];
const refusingHandler = (p: unknown): Handler => (op) => {
  if (op === "ping") return p;
  if (op === "cmd" || op === "setfader" || op === "lua" || op === "set" || op.startsWith("input.") || op === "control.submit") mutating.push(op);
  throw new Error("unexpected " + op);
};

test("verify refuses an old bridge or old modules; run refuses a non-disposable show, control off or on the fake backend, Lua off and a busy bridge", async () => {
  const cases: [string[], Record<string, unknown>, RegExp][] = [
    [["verify"], { bridgeVersion: "0.15.0" }, /0\.16\.0 or newer/],
    [["verify"], { modules: { ...modules, control: { loaded: true, version: "0.2.0" } } }, /0\.3\.0 or newer/],
    [["verify"], { modules: { ...modules, feedback: { loaded: true, version: "0.3.0" } } }, /0\.4\.0 or newer/],
    [["run"], { showfile: "MyRealShow" }, /does not look disposable/],
    [["run"], { control: { enabled: false } }, /control=console/],
    [["run"], { control: { enabled: true, backend: "fake" } }, /control=console/],
    [["run"], { lua: { enabled: false } }, /Lua enabled/],
    [["run"], { input: { busy: { reason: "interaction" } } }, /busy/],
  ];
  for (const [args, extra, re] of cases) {
    const b = await startFakeBridge(refusingHandler(ping(extra)));
    try {
      const r = await run(args, { GMA3_BRIDGE_PORT: String(b.port) });
      assert.equal(r.status, 2, `${args.join(" ")} ${JSON.stringify(extra)}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, re);
    } finally { b.close(); }
  }
  assert.deepEqual(mutating, [], "no mutating op reached the bridge");
});

test("verify queues nothing on the console backend: every submitted event is a refusal by construction and no command is sent", async () => {
  const ops: { op: string; args: any }[] = [];
  const b = await startFakeBridge((op, args) => {
    ops.push({ op, args });
    if (op === "ping") return ping();
    if (op === "feedback.context") return snapshot(args.allExecutors ? [191] : args.executors ?? [], 3, 0);
    if (op === "feedback.watch") return { watched: 5 };
    if (op === "feedback.unwatch") return { watched: 0 };
    if (op === "control.bind") return { watched: 5, generation: 3, binding: 1 };
    if (op === "control.status") return { version: "0.3.0", limitations, yourSession: ops.some((o) => o.op === "control.submit") ? "conn-1" : null, sessions: { "conn-1": { queued: 0, gestures: 0 } }, busy: null, unresolved: [], backend: "console", capabilities, backendStatus: { counters: { applied: 0 } } };
    if (op === "control.submit") {
      const outcomes = (args.events as any[]).map((e) => {
        if (e.type === "button") return { refused: "unsupported", backend: "console", reason: "an encoder press is not served by the console backend: calculator/open/select behaviour is not qualified (nothing is pressed)" };
        if (e.target?.executor !== undefined) return { refused: "unsupported", backend: "console", reason: "executor faders are not served by the console backend (KB-21/KB-22); strips are served on encoder slots" };
        if (e.target?.slot !== undefined) return { refused: "target-unavailable", message: "slot 1 (Dimmer): no fixture is selected" };
        throw new Error("the probe submitted an event that would be admitted: " + JSON.stringify(e));
      });
      return { session: "conn-1", outcomes, accepted: 0, refused: outcomes.length, lost: 0 };
    }
    if (op === "control.close") return { session: "conn-1", dropped: 0 };
    throw new Error("unexpected " + op);
  });
  try {
    const r = await run(["verify"], { GMA3_BRIDGE_PORT: String(b.port) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /PASS control.status: the console backend declares touch and absolute on slots/);
    assert.match(r.stdout, /PASS verify: a press is refused; a touch and a position on an executor fader are unsupported/);
    assert.match(r.stdout, /PASS verify: control.close ends the session/);
    const submitted = ops.filter((o) => o.op === "control.submit").flatMap((o) => o.args.events as any[]);
    assert.ok(submitted.some((e) => e.type === "touch" && e.target.slot === 1) && submitted.some((e) => e.type === "absolute" && e.target.executor === 191), "verify exercises a slot touch and an executor position");
    assert.ok(!ops.some((o) => o.op === "cmd" || o.op === "lua"), "verify sends no command and runs no Lua");
  } finally { b.close(); }
});

test("run: a failure after the first selection runs every registered undo, releasing the strips and ending with ClearAll", async () => {
  const ops: { op: string; args: any }[] = [];
  let selection = 0;
  let gen = 3;
  const b = await startFakeBridge((op, args) => {
    ops.push({ op, args });
    if (op === "ping") return ping();
    if (op === "feedback.context") return snapshot(args.allExecutors ? [191] : args.executors ?? [], gen, selection);
    if (op === "feedback.watch") return { watched: 5 };
    if (op === "feedback.unwatch") return { watched: 0 };
    if (op === "control.bind") return { watched: 5, generation: gen, binding: 1 };
    if (op === "programmer") return { coverage: { complete: true, scannedFixtures: 2, totalFixtures: 2, scannedChannels: 10 }, stats: { channelsWithData: 0, channelErrors: 0 }, total: 0 };
    if (op === "control.status") return { version: "0.3.0", limitations, yourSession: null, sessions: {}, busy: null, unresolved: [], backend: "console", capabilities, backendStatus: { counters: { applied: 0 } } };
    if (op === "control.submit") return { session: "conn-1", outcomes: (args.events as any[]).map((e) => e.down === false ? { accepted: true, noop: true } : { refused: "target-unavailable", message: "slot 1 (Dimmer): no fixture is selected" }), accepted: 0, refused: args.events.length, lost: 0 };
    if (op === "control.close") return { session: "conn-1", dropped: 0 };
    if (op === "cmd") {
      if (/^Fixture /.test(args.command)) { selection = 1; gen += 1; }
      if (args.command === "ClearSelection" || args.command === "ClearAll") { selection = 0; gen += 1; }
      return { command: args.command, feedback: "OK" };
    }
    if (op === "lua") throw new Error("[lua-disabled] simulated failure after the selection");
    throw new Error("unexpected " + op);
  });
  try {
    const r = await run(["run"], { GMA3_BRIDGE_PORT: String(b.port) });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /FAIL run: the mutation phase failed; running the registered undos/);
    assert.match(r.stdout, /PASS run: cleanup ran every registered undo/);
    const cmds = ops.filter((o) => o.op === "cmd").map((o) => o.args.command);
    assert.ok(cmds.includes("ClearSelection") && cmds[cmds.length - 1] === "ClearAll", `undo order: ${cmds.join(" | ")}`);
    assert.ok(cmds.some((c) => /^Select EncoderBank 1\.1$/.test(c)), "the original bank/page is restored");
    const releases = ops.filter((o) => o.op === "control.submit").flatMap((o) => o.args.events as any[]).filter((e) => e.type === "touch" && e.down === false);
    assert.equal(releases.length, 4, "the cleanup releases the four strips");
    assert.ok(ops.some((o) => o.op === "control.close"), "the session is closed by the cleanup");
  } finally { b.close(); }
});
