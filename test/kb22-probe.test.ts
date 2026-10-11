import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { QUALIFIED, isQualified, pickByFunction, pickSequences, sequenceRef, targetSummary } from "../scripts/kb22-probe.mjs";

/**
 * scripts/kb22-probe.mjs: `verify` must send nothing that presses, places, assigns or applies (its control.submit
 * calls are refusals by construction: an executor encoder element, a key whose function is not qualified, or on the
 * fake backend a target on page 9999); `run` presses the probe's own assignments and the operator's momentary
 * executors and must refuse an old bridge, old modules, a show whose name does not look disposable, control disabled
 * or on the fake backend, Lua disabled and a busy bridge. The operations themselves are covered by the Lua harness
 * and the live record.
 */

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "kb22-probe.mjs");

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

const modules = { hardkeys: { loaded: true, version: "0.10.0" }, feedback: { loaded: true, version: "0.5.0" }, control: { loaded: true, version: "0.5.0" } };
const limitations = ["executor operations on the console backend (KB-22): a key is Press/Unpress Page <p>.<e> ..."];
const ping = (extra: Record<string, unknown> = {}) => ({ bridgeVersion: "0.18.0", host: "127.0.0.1", port: 9800, showfile: "mcp-test-disposable", user: "Admin", lua: { enabled: true },
  input: { enabled: false, sessions: 0, holds: 0, busy: null }, control: { enabled: true, backend: "console", sessions: 0, gestures: 0, queued: 0 }, modules, ...extra });

const target = (n: number, page: number | undefined, assigned: string | null, extra: Record<string, unknown> = {}) => ({
  available: true, params: { executor: n, page },
  value: assigned
    ? { executor: n, page: { no: page ?? 1, name: `Page ${page ?? 1}` }, pool: { name: "Default", no: 1 }, mode: page ? "page" : "current", width: 1, empty: false, playbackTarget: true, assigned: { addr: assigned, class: "Sequence", name: assigned }, functions: { keyPress: "Go+", keyUnpress: "", fader: "Master", encoder: "Master" }, level: { token: "FaderMaster", value: 100 }, active: false, ...extra }
    : { executor: n, page: { no: page ?? 1, name: `Page ${page ?? 1}` }, pool: { name: "Default", no: 1 }, mode: page ? "page" : "current", empty: true, playbackTarget: false, reason: "the executor is empty", ...extra },
});
function snapshot(executors: number[], page: number | undefined, assignments: Record<number, string | null>, generation = 1, userPage = 1, extras: Record<number, Record<string, unknown>> = {}) {
  const key = `display=1;executors=${executors.join(",")}${page ? `;page=${page}` : ""}`;
  return {
    observedAt: 1, epoch: 1, atomic: false, cached: true, notObserved: 0, generation, generationChanged: false, bindingKey: key,
    identity: { showFile: "mcp-test-disposable", user: "Admin", profile: "Default", dataPool: { name: "Default", no: 1 } }, display: 1,
    executorPage: { name: `Page ${userPage}`, no: userPage }, executorMode: page ? "page" : "current", executorSpecPage: page,
    executors: executors.map((n) => target(n, page, assignments[n] ?? null, extras[n] ?? {})),
    limitations: [],
  };
}
const consoleStatus = (extra: Record<string, unknown> = {}) => ({ version: "0.5.0", limitations, yourSession: "conn-1", sessions: {}, busy: null, unresolved: [], backend: "console",
  capabilities: { relative: true, absolute: true, touch: true, button: true, targets: { slot: true, executor: true }, executorElements: { fader: true, key: true, encoder: false } },
  backendStatus: { name: "console", counters: { applied: 0, refused: 0, raised: 0, noop: 0 }, executorFunctions: { keys: QUALIFIED.keys, faders: QUALIFIED.faders } }, binding: { revision: 1 }, ...extra });

test("the probe's own helpers", () => {
  assert.ok(isQualified("Go+", QUALIFIED.keys) && isQualified("Master", QUALIFIED.faders) && isQualified("temp", QUALIFIED.faders));
  assert.ok(!isQualified("LearnSpeed", QUALIFIED.keys) && !isQualified("", QUALIFIED.keys) && !isQualified(undefined, QUALIFIED.keys) && !isQualified("Rate", QUALIFIED.faders));
  const execs = [target(191, undefined, "Sequence 1"), target(192, undefined, null), target(193, undefined, "Sequence 5", { functions: { keyPress: "Temp", fader: "Master" } }), target(194, undefined, "Sequence 6", { functions: { keyPress: "Temp", fader: "Temp" }, active: true }), target(195, undefined, "Sequence 2")];
  assert.deepEqual(pickByFunction(execs, "key", "Temp").map((x) => x.value.executor), [193], "inactive executors with the key function only");
  assert.deepEqual(pickByFunction(execs, "key", "Temp", { inactive: false }).map((x) => x.value.executor), [193, 194]);
  assert.deepEqual(pickByFunction(execs, "fader", "Master", { exclude: [191] }).map((x) => x.value.executor), [193, 195]);
  assert.deepEqual(pickSequences(execs), ["Sequence 1", "Sequence 5"], "two distinct inactive sequences, never an empty executor");
  assert.equal(sequenceRef({ class: "Sequence", addr: "14.14.1.7.5527", no: 5527 }), "Sequence 5527", "the command-line form, never the numeric path");
  assert.equal(sequenceRef({ class: "Sequence", addr: "14.14.1.7.5527" }), "Sequence 5527");
  assert.equal(sequenceRef({ class: "Quickey", addr: "Quickey 1" }), undefined);
  assert.equal(targetSummary(execs[2]).keyPress, "Temp");
  assert.deepEqual(targetSummary({ available: false, params: { executor: 5, page: 2 }, reason: "not observed" }), { executor: 5, page: 2, unavailable: "not observed" });
});

const mutating: string[] = [];
const refusingHandler = (p: unknown): Handler => (op) => {
  if (op === "ping") return p;
  if (op === "cmd" || op === "setfader" || op === "lua" || op === "set" || op.startsWith("input.") || op === "control.submit") mutating.push(op);
  throw new Error("unexpected " + op);
};

test("verify refuses an old bridge or old modules; run refuses a non-disposable show, control off or on the fake backend, Lua off and a busy bridge", async () => {
  const cases: [string[], Record<string, unknown>, RegExp][] = [
    [["verify"], { bridgeVersion: "0.17.0" }, /0\.18\.0 or newer/],
    [["verify"], { modules: { ...modules, control: { loaded: true, version: "0.4.0" } } }, /0\.5\.0 or newer/],
    [["verify"], { modules: { ...modules, feedback: { loaded: true, version: "0.4.0" } } }, /0\.5\.0 or newer/],
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

test("verify on the console backend presses nothing: the submitted events are an encoder element and an unqualified key, both refusals by construction; no command, no Lua", async () => {
  const ops: { op: string; args: any }[] = [];
  const assignments: Record<number, string | null> = { 191: "Sequence 1", 192: "Sequence 2" };
  const extras = { 192: { functions: { keyPress: "LearnSpeed", fader: "Master" } } };
  const b = await startFakeBridge((op, args) => {
    ops.push({ op, args });
    if (op === "ping") return ping();
    if (op === "feedback.context") return snapshot(args.allExecutors ? [191, 192] : args.executors ?? [], args.executorPage, assignments, 3, 1, extras);
    if (op === "feedback.unwatch") return { watched: 0 };
    if (op === "control.bind") return { watched: 5, generation: 3, binding: 1, bindingKey: `display=1;executors=${(args.executors ?? []).join(",")};page=${args.executorPage}` };
    if (op === "control.status") return consoleStatus({ sessions: { "conn-1": { queued: 0, gestures: 0 } } });
    if (op === "control.submit") {
      const outcomes = (args.events as any[]).map((e) => {
        if (e.target?.element === "encoder") return { refused: "unsupported", reason: "executor encoders are not served by the console backend (not qualified)", message: "button on exec... is not served" };
        if (e.target?.executor === 192) return { refused: "unsupported", reason: "the configured key function 'LearnSpeed' is not qualified (served: Flash, Go+, Temp, Toggle, Top)", message: "button on exec... is not served" };
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
    assert.match(r.stdout, /PASS the console backend declares executor keys and faders/);
    assert.match(r.stdout, /PASS verify \(console backend\): an executor ENCODER element is refused unsupported and a key whose configured function \(LearnSpeed\)/);
    assert.ok(!ops.some((o) => o.op === "cmd" || o.op === "lua"), "verify sends no command and runs no Lua");
    assert.ok(ops.some((o) => o.op === "control.close"), "the session is closed");
  } finally { b.close(); }
});

test("run: a failure after the assignments (the key down refused by the bridge) runs every registered undo: the assignments are deleted, the Off and Unpress of the guarded key issued, the page restored, the macro deleted", async () => {
  const ops: { op: string; args: any }[] = [];
  const assignments: Record<number, string | null> = { 191: "Sequence 1", 193: "Sequence 2" };
  let macro: any = false;
  const b = await startFakeBridge((op, args) => {
    ops.push({ op, args });
    if (op === "ping") return ping();
    if (op === "feedback.context") return snapshot(args.allExecutors ? [191, 192, 193] : args.executors ?? [], args.executorPage, assignments, 3);
    if (op === "feedback.unwatch") return { watched: 0 };
    if (op === "control.bind") return { watched: 5, generation: 3, binding: 1 };
    if (op === "control.status") return consoleStatus({ yourSession: null });
    if (op === "control.submit") {
      if ((args.events as any[]).some((e) => e.down === true && e.target?.element === "key")) throw new Error("[refused] simulated failure after the assignments (the down could not be submitted)");
      return { session: "conn-1", outcomes: (args.events as any[]).map((e) => e.down === false ? { accepted: true, noop: true } : { refused: "target-unavailable", message: "not in the binding" }), accepted: 0, refused: args.events.length, lost: 0 };
    }
    if (op === "control.close") return { session: "conn-1", dropped: 0 };
    if (op === "lua") {
      if (/Macro 116/.test(args.code)) {
        if (/return false end; local t/.test(args.code)) return { values: [macro] };
        if (/Store Macro 116 /.test(args.code)) { macro = { name: "MCP kb22 deferred", lines: [] }; return { values: [true] }; }
        if (/Delete Macro 116/.test(args.code)) { macro = false; return { values: [true] }; }
        return { values: [2] };
      }
      return { values: [null] };
    }
    if (op === "cmd") {
      const m = /^Assign (Sequence \d+) At Page 1\.(\d+)$/.exec(args.command);
      if (m) assignments[Number(m[2])] = m[1];
      if (/^Delete Page 1\.(\d+)/.test(args.command)) assignments[Number(/^Delete Page 1\.(\d+)/.exec(args.command)![1])] = null;
      return { command: args.command, feedback: "OK" };
    }
    throw new Error("unexpected " + op);
  });
  try {
    const r = await run(["run"], { GMA3_BRIDGE_PORT: String(b.port) });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /PASS run: preflight: executors 180,181 of page 1 are empty/);
    assert.match(r.stdout, /FAIL run: the mutation phase failed; running the registered undos/);
    assert.match(r.stdout, /PASS run: cleanup ran every registered undo/);
    const cmds = ops.filter((o) => o.op === "cmd").map((o) => o.args.command);
    for (const e of [180, 181]) assert.ok(cmds.includes(`Delete Page 1.${e} /NoConfirmation`), `the assignment at ${e} is deleted: ${cmds.join(" | ")}`);
    assert.ok(cmds.includes("Unpress Page 1.180") && cmds.includes("Off Sequence 1"), `the guarded key's release and Off are issued: ${cmds.join(" | ")}`);
    assert.equal(cmds[cmds.length - 1], "Page 1", "the page is restored last");
    assert.equal(macro, false, "the deferred macro is deleted");
    assert.match(r.stdout, /PASS run: executors 180,181 are empty again/);
  } finally { b.close(); }
});
