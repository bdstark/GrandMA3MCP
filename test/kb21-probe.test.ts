import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { firstMissingPage, pickSequences, targetSummary } from "../scripts/kb21-probe.mjs";

/**
 * scripts/kb21-probe.mjs: `verify` must send nothing that queues, assigns or applies (its control.submit calls are
 * refusals by construction: a page-bound executor without target.page, a target on page 9999, or on the console
 * backend a page-bound down that the backend does not serve); `run` assigns and deletes executors in the free range
 * and must refuse an old bridge, old modules, a show whose name does not look disposable, control disabled or on
 * the console backend, Lua disabled and a busy bridge. The binding semantics themselves are covered by the Lua
 * harness and the live record.
 */

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "kb21-probe.mjs");

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

const modules = { hardkeys: { loaded: true, version: "0.10.0" }, feedback: { loaded: true, version: "0.5.0" }, control: { loaded: true, version: "0.4.0" } };
const limitations = ["an executor target is explicit (pool, page, executor, element; KB-21): ... a hold's release goes to the target its down resolved (frozen) ..."];
const ping = (extra: Record<string, unknown> = {}) => ({ bridgeVersion: "0.17.0", host: "127.0.0.1", port: 9800, showfile: "mcp-test-disposable", user: "Admin", lua: { enabled: true },
  input: { enabled: false, sessions: 0, holds: 0, busy: null }, control: { enabled: true, backend: "fake", sessions: 0, gestures: 0, queued: 0 }, modules, ...extra });

const target = (n: number, page: number | undefined, assigned: string | null, extra: Record<string, unknown> = {}) => ({
  available: true, params: { executor: n, page },
  value: assigned
    ? { executor: n, page: { no: page ?? 1, name: `Page ${page ?? 1}` }, pool: { name: "Default", no: 1 }, mode: page ? "page" : "current", width: 1, empty: false, playbackTarget: true, assigned: { addr: assigned, class: "Sequence", name: assigned }, functions: { keyPress: "Go+", fader: "Master" }, level: { token: "FaderMaster", value: 0 }, ...extra }
    : { executor: n, page: { no: page ?? 1, name: `Page ${page ?? 1}` }, pool: { name: "Default", no: 1 }, mode: page ? "page" : "current", empty: true, playbackTarget: false, reason: "the executor is empty", ...extra },
});
function snapshot(executors: number[], page: number | undefined, assignments: Record<number, string | null>, generation = 1, userPage = 1) {
  const key = `display=1;executors=${executors.join(",")}${page ? `;page=${page}` : ""}`;
  return {
    observedAt: 1, epoch: 1, atomic: false, cached: true, notObserved: 0, generation, generationChanged: false, bindingKey: key,
    identity: { showFile: "mcp-test-disposable", user: "Admin", profile: "Default", dataPool: { name: "Default", no: 1 } }, display: 1,
    executorPage: { name: `Page ${userPage}`, no: userPage }, executorMode: page ? "page" : "current", executorSpecPage: page,
    encoder: { available: true, value: { display: 1, bank: { index: 1, name: "Dimmer", pages: 1 }, page: { index: 1, name: "Dimmer", slots: 1 }, context: "Default", attributeEditing: true } },
    slots: { available: true, value: { selection: { count: 0, fixtures: [], identityComplete: true }, slots: [] } },
    executors: executors.map((n) => page === 9999 ? { available: true, params: { executor: n, page }, value: { executor: n, page: { no: page }, mode: "page", pageMissing: true, empty: true, playbackTarget: false, reason: "page 9999 does not exist" } } : target(n, page, assignments[n] ?? null)),
    limitations: [],
  };
}

test("the probe's own helpers", () => {
  assert.equal(firstMissingPage([1, 1, 0, 1]), 3);
  assert.equal(firstMissingPage([1, 1]), undefined, "every probed page exists");
  assert.equal(firstMissingPage([0, 0]), 2, "page 1 is never reported missing");
  assert.equal(firstMissingPage(undefined), undefined);
  const execs = [target(191, undefined, "Sequence 1"), target(192, undefined, null), { available: true, params: { executor: 193 }, value: { executor: 193, empty: false, playbackTarget: false, assigned: { addr: "Quickey 1", class: "Quickey" } } }, target(194, undefined, "Sequence 1"), target(195, undefined, "Sequence 2"), target(196, undefined, "Sequence 3")];
  assert.deepEqual(pickSequences(execs), ["Sequence 1", "Sequence 2"], "two distinct sequences, never a Quickey, never an empty executor");
  assert.deepEqual(pickSequences([target(191, undefined, "Sequence 1")]), ["Sequence 1"]);
  assert.deepEqual(targetSummary({ available: false, params: { executor: 5, page: 2 }, reason: "not observed" }), { executor: 5, page: 2, unavailable: "not observed" });
  assert.equal(targetSummary(target(201, 2, "Sequence 9")).mode, "page");
});

const mutating: string[] = [];
const refusingHandler = (p: unknown): Handler => (op) => {
  if (op === "ping") return p;
  if (op === "cmd" || op === "setfader" || op === "lua" || op === "set" || op.startsWith("input.") || op === "control.submit") mutating.push(op);
  throw new Error("unexpected " + op);
};

test("verify refuses an old bridge or old modules; run refuses a non-disposable show, control off or on the console backend, Lua off and a busy bridge", async () => {
  const cases: [string[], Record<string, unknown>, RegExp][] = [
    [["verify"], { bridgeVersion: "0.16.0" }, /0\.17\.0 or newer/],
    [["verify"], { modules: { ...modules, control: { loaded: true, version: "0.3.0" } } }, /0\.4\.0 or newer/],
    [["verify"], { modules: { ...modules, feedback: { loaded: true, version: "0.4.0" } } }, /0\.5\.0 or newer/],
    [["run"], { showfile: "MyRealShow" }, /does not look disposable/],
    [["run"], { control: { enabled: false } }, /control=fake/],
    [["run"], { control: { enabled: true, backend: "console" } }, /control=fake/],
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

test("verify on the fake backend queues nothing: every submitted event is a refusal by construction, no command, no Lua, nothing assigned", async () => {
  const ops: { op: string; args: any }[] = [];
  const assignments: Record<number, string | null> = { 191: "Sequence 1", 193: "Sequence 2" };
  const b = await startFakeBridge((op, args) => {
    ops.push({ op, args });
    if (op === "ping") return ping();
    if (op === "feedback.context") return snapshot(args.allExecutors ? [191, 192, 193] : args.executors ?? [], args.executorPage, assignments, 3);
    if (op === "feedback.watch") return { watched: 5 };
    if (op === "feedback.unwatch") return { watched: 0 };
    if (op === "control.bind") return { watched: 5, generation: 3, binding: 1, bindingKey: `display=1;executors=${(args.executors ?? []).join(",")};page=${args.executorPage}` };
    if (op === "control.status") return { version: "0.4.0", limitations, yourSession: ops.some((o) => o.op === "control.submit") ? "conn-1" : null, sessions: { "conn-1": { queued: 0, gestures: 0 } }, busy: null, unresolved: [], backend: "fake" };
    if (op === "control.submit") {
      const outcomes = (args.events as any[]).map((e) => {
        if (e.target?.page === 9999) return { refused: "target-unavailable", message: "executor 191 of page 9999 is not in the binding (bind it first)" };
        if (e.target?.executor !== undefined && e.target.page === undefined) return { refused: "target-unavailable", message: "executor 191 is not in the binding (bind it first; a page-bound executor needs target.page)" };
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
    assert.match(r.stdout, /PASS feedback.context bound to page 1 explicitly reads the same executors/);
    assert.match(r.stdout, /PASS feedback.context bound to page 9999 reports every target pageMissing/);
    assert.match(r.stdout, /PASS verify \(fake backend\): a page-bound executor without target.page and a target on page 9999/);
    assert.ok(!ops.some((o) => o.op === "cmd" || o.op === "lua"), "verify sends no command and runs no Lua");
    assert.ok(ops.some((o) => o.op === "control.close"), "the session is closed");
  } finally { b.close(); }
});

test("run: a failure after the assignments (the page change refused) runs every registered undo (the assignments are deleted, the page restored, the session closed)", async () => {
  const ops: { op: string; args: any }[] = [];
  const assignments: Record<number, string | null> = { 191: "Sequence 1", 193: "Sequence 2" };
  let macro: any = false;
  const b = await startFakeBridge((op, args) => {
    ops.push({ op, args });
    if (op === "ping") return ping();
    if (op === "feedback.context") return snapshot(args.allExecutors ? [191, 192, 193] : args.executors ?? [], args.executorPage, assignments, 3);
    if (op === "feedback.watch") return { watched: 5 };
    if (op === "feedback.unwatch") return { watched: 0 };
    if (op === "control.bind") return { watched: 5, generation: 3, binding: 1 };
    if (op === "control.status") return { version: "0.4.0", limitations, yourSession: null, sessions: {}, busy: null, unresolved: [], backend: "fake" };
    if (op === "control.submit") return { session: "conn-1", outcomes: (args.events as any[]).map((e) => e.down === false ? { accepted: true, noop: true } : { refused: "target-unavailable", message: "not in the binding (bind it first; a page-bound executor needs target.page)" }), accepted: 0, refused: args.events.length, lost: 0 };
    if (op === "control.close") return { session: "conn-1", dropped: 0 };
    if (op === "lua") {
      if (/Macro 116/.test(args.code)) {
        if (/return false end; local t/.test(args.code)) return { values: [macro] };
        if (/Store Macro 116 /.test(args.code)) { macro = { name: "MCP kb21 deferred", lines: [] }; return { values: [true] }; }
        if (/Delete Macro 116/.test(args.code)) { macro = false; return { values: [true] }; }
        const m = /b:Set\("Command", ("(?:[^"\\]|\\.)*")\)/.exec(args.code);
        macro = { name: "MCP kb21 deferred", lines: [{ cmd: "Echo kb21 deferred", wait: "1.5" }, { cmd: m ? JSON.parse(m[1]) : "?", wait: "Follow" }] };
        return { values: [2] };
      }
      return { values: [[1, 1, 0, 0]] };
    }
    if (op === "cmd") {
      const m = /^Assign (Sequence \d+) At Page 1\.(\d+)$/.exec(args.command);
      if (m) assignments[Number(m[2])] = m[1];
      if (/^Set Page /.test(args.command)) throw new Error("[refused] the Width form is not accepted (tolerated by the probe)");
      if (/^Go\+ Macro 116$/.test(args.command)) throw new Error("[refused] simulated failure after the assignments (the deferred macro could not be fired)");
      return { command: args.command, feedback: "OK" };
    }
    throw new Error("unexpected " + op);
  });
  try {
    const r = await run(["run"], { GMA3_BRIDGE_PORT: String(b.port) });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /PASS run: preflight: executors 180,181,182,183 of page 1 are empty/);
    assert.match(r.stdout, /FAIL run: the mutation phase failed; running the registered undos/);
    assert.match(r.stdout, /PASS run: cleanup ran every registered undo/);
    const cmds = ops.filter((o) => o.op === "cmd").map((o) => o.args.command);
    for (const e of [180, 182, 183]) assert.ok(cmds.includes(`Delete Page 1.${e} /NoConfirmation`), `the assignment at ${e} is deleted: ${cmds.join(" | ")}`);
    assert.ok(!cmds.some((c) => /Page 1\.181/.test(c)), "181 (left empty) is never touched");
    assert.equal(cmds[cmds.length - 1], "Page 1", "the page is restored last");
    const releases = ops.filter((o) => o.op === "control.submit").flatMap((o) => o.args.events as any[]).filter((e) => e.type === "button" && e.down === false);
    assert.ok(releases.length >= 7, "the cleanup releases every button it could have pressed");
    const releaseIdx = ops.findIndex((o) => o.op === "control.submit" && (o.args.events as any[]).some((e) => e.down === false));
    const deleteIdx = ops.findIndex((o) => o.op === "cmd" && /^Delete Page 1\.180/.test(o.args.command));
    assert.ok(releaseIdx >= 0 && releaseIdx < deleteIdx, "buttons are released before the assignments are deleted (a held button makes commands [busy])");
    assert.ok(ops.some((o) => o.op === "lua" && /Delete Macro 116/.test(o.args.code)), "the deferred macro is deleted by the cleanup");
    assert.equal(macro, false, "the deferred macro is gone");
    assert.ok(ops.some((o) => o.op === "control.close"), "the session is closed by the cleanup");
  } finally { b.close(); }
});
