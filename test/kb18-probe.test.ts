import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { eventFactory, outcomesOf } from "../scripts/kb18-probe.mjs";

/**
 * scripts/kb18-probe.mjs: `verify` must send nothing that queues or applies an event (its control.submit
 * calls are refusals by construction: malformed, stale, unbound, no selection, or [control-disabled]);
 * `run` changes the selection and must refuse an old bridge, a missing control module, a show whose name
 * does not look disposable, control disabled or on another backend, and a busy bridge. The admission
 * itself is covered by the Lua harnesses.
 */

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "kb18-probe.mjs");

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
            const e = result as any;
            if (e && e.__error) { sock.write(JSON.stringify({ id: req.id, ok: false, error: e.__error, code: e.code, detail: e.detail }) + "\n"); continue; }
            sock.write(JSON.stringify({ id: req.id, ok: true, result }) + "\n");
          } catch (e) {
            sock.write(JSON.stringify({ id: req.id, ok: false, error: String((e as Error).message), code: /^\[([\w-]+)\]/.exec((e as Error).message)?.[1] }) + "\n");
          }
        }
      });
      sock.on("close", () => { try { handler("__close", {}, conn); } catch {} });
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

const modules = { hardkeys: { loaded: true, version: "0.10.0" }, feedback: { loaded: true, version: "0.3.0" }, control: { loaded: true, version: "0.1.0" } };
const ping = (extra: Record<string, unknown> = {}) => ({ bridgeVersion: "0.14.0", host: "127.0.0.1", port: 9800, showfile: "mcp-test-disposable", user: "Admin", lua: { enabled: true },
  input: { enabled: false, sessions: 0, holds: 0, busy: null }, control: { enabled: true, backend: "fake", sessions: 0, gestures: 0, queued: 0 }, modules, ...extra });

const slot = (n: number, name: string, availability: string) => ({ slot: n, kind: "attribute", ref: `Attribute 1 '${name}'`, name, label: name, unit: "%", readout: "Percent", resolution: "Coarse", layer: "Absolute", channelFunction: name, availability, valueState: "none" });
function snapshot(executors: number[], generation = 1, selection = 0, extra: Record<string, unknown> = {}) {
  return {
    observedAt: 1, epoch: 1, atomic: false, cached: true, notObserved: 0, generation, generationChanged: false, bindingKey: `display=1;executors=${executors.join(",")}`,
    identity: { showFile: "mcp-test-disposable", user: "Admin", profile: "Default", dataPool: { name: "Default", no: 1 } }, display: 1, executorPage: { name: "Page 1", no: 1 },
    encoder: { available: true, value: { display: 1, bank: { index: 1, name: "Dimmer", pages: 1 }, page: { index: 1, name: "Dimmer", slots: 1 }, context: "Default", attributeEditing: true } },
    slots: { available: true, value: { selection: { count: selection, fixtures: selection ? [401] : [], identityComplete: true }, slots: [slot(1, "Dimmer", selection ? "available" : "no-selection")] } },
    executors: executors.map((n) => ({ available: true, value: { executor: n, page: 1, empty: false, playbackTarget: true, assigned: { addr: "Sequence 1" }, functions: { keyPress: "Go+", fader: "Master" }, level: { token: "FaderMaster", value: 0 } } })),
    pageExecutors: { page: { no: 1 }, executors: executors.map((n) => ({ index: n, name: "Seq", class: "Sequence" })) }, limitations: [], ...extra,
  };
}

/** A tiny admission model: enough for the probe's contract, not the module's. */
function fakeControl(ref: { gen: number; selection: number }) {
  type S = { queued: any[]; gestures: number; devices: Record<string, { last: number; seen: Set<number> }>; counters: { applied: number } };
  const sessions: Record<string, S> = {};
  let lastApplied: any = null;
  const counters = { applied: 0, staleDropped: 0, expired: 0 };
  const busy = () => { for (const [id, s] of Object.entries(sessions)) if (s.gestures > 0) return { reason: "touch-down", owner: id, module: "control" }; return null; };
  let lastMotionAt = 0;
  const motionBusy = () => Date.now() - lastMotionAt < 500;
  const apply = (sid: string) => { const s = sessions[sid]; if (!s) return; for (const q of s.queued) { if (q.kind !== "boundary" && q.generation !== ref.gen) { counters.staleDropped += 1; continue; } s.counters.applied += 1; counters.applied += 1; lastApplied = { outcome: "applied", kind: q.kind === "boundary" ? q.type : q.type, down: q.down }; } s.queued = []; };
  const api = (sid: string, op: string, args: any): unknown => {
    if (op === "__close") { const s = sessions[sid]; if (s) { if (s.gestures > 0) lastApplied = { outcome: "applied", kind: "button", down: false }; delete sessions[sid]; } return null; }
    if (op === "control.status") { for (const id of Object.keys(sessions)) apply(id); const view: any = {}; for (const [id, s] of Object.entries(sessions)) view[id] = { queued: s.queued.length, gestures: s.gestures, counters: s.counters }; return { version: "0.1.0", limitations: ["fake backend only"], yourSession: sessions[sid] ? sid : null, sessions: view, busy: busy(), lastApplied, counters, unresolved: [] }; }
    if (op === "control.close") { delete sessions[sid]; return { session: sid, dropped: 0 }; }
    if (op === "control.submit") {
      const s = (sessions[sid] ??= { queued: [], gestures: 0, devices: {}, counters: { applied: 0 } });
      const outcomes = (args.events as any[]).map((e) => {
        if (!["relative", "absolute", "touch", "button"].includes(e.type)) return { refused: "bad-event" };
        if (!((e.type === "touch" || e.type === "button") && e.down === false) && e.target?.executor !== 999999 && e.generation === ref.gen) {
          if (e.binding === undefined) return { refused: "binding-required", binding: 1 };
          if (e.binding !== 1) return { refused: "stale-binding", binding: 1 };
        }
        const d = (s.devices[e.device] ??= { last: 0, seen: new Set<number>() });
        if (e.seq <= d.last) return d.seen.has(e.seq) ? { refused: "duplicate" } : { refused: "out-of-order" };
        const lost = d.last === 0 ? 0 : e.seq - d.last - 1;
        const commit = () => { d.last = e.seq; d.seen.add(e.seq); };
        if ((e.type === "touch" || e.type === "button") && e.down === false) { commit(); s.gestures = Math.max(0, s.gestures - 1); s.queued.push({ kind: "boundary", type: e.type, down: false, generation: e.generation }); return { accepted: true, boundary: true, lost }; }
        if (e.generation !== ref.gen) return { refused: "stale-generation", generation: ref.gen };
        if (e.target?.executor !== undefined && ![191].includes(e.target.executor)) return { refused: "target-unavailable", message: "bind it first" };
        if (e.target?.slot !== undefined && ref.selection === 0) return { refused: "target-unavailable", message: "slot 1 (Dimmer): no fixture is selected" };
        for (const [other, os] of Object.entries(sessions)) if (other !== sid && os.gestures > 0) return { refused: "conflict", owner: other };
        commit();
        if (e.type === "touch" || e.type === "button") { s.gestures += 1; s.queued.push({ kind: "boundary", type: e.type, down: true, generation: e.generation }); return { accepted: true, lost }; }
        const tail = s.queued[s.queued.length - 1];
        if (e.type === "absolute") { if (tail && tail.type === "absolute" && tail.control === e.control) { tail.superseded = (tail.superseded ?? 0) + 1; return { accepted: true, lost, superseded: tail.superseded }; } s.queued.push({ kind: "motion", type: "absolute", control: e.control, generation: e.generation }); return { accepted: true, lost }; }
        if (tail && tail.type === "relative" && tail.control === e.control && tail.gesture === e.gesture) { lastMotionAt = Date.now(); return { accepted: true, coalesced: true, lost, queued: s.queued.length }; }
        lastMotionAt = Date.now();
        s.queued.push({ kind: "motion", type: "relative", control: e.control, gesture: e.gesture, generation: e.generation });
        return { accepted: true, queued: s.queued.length, lost };
      });
      return { session: sid, outcomes, accepted: outcomes.filter((o: any) => o.accepted).length, refused: outcomes.filter((o: any) => o.refused).length, lost: outcomes.reduce((a: number, o: any) => a + (o.lost ?? 0), 0) };
    }
    throw new Error("unexpected " + op);
  };
  return Object.assign(api, { busy, apply, motionBusy });
}

test("verify refuses an old bridge, a missing control module, and run refuses a non-disposable show, control off or another backend, and a busy bridge", async () => {
  const cases: [string[], Record<string, unknown>, RegExp][] = [
    [["verify"], { bridgeVersion: "0.13.0" }, /0\.14\.0 or newer/],
    [["verify"], { modules: { ...modules, control: { loaded: false, error: "not registered" } } }, /control module is not loaded/],
    [["run"], { showfile: "MyRealShow" }, /does not look disposable/],
    [["run"], { control: { enabled: false } }, /control=fake/],
    [["run"], { control: { enabled: true, backend: "console" } }, /fake backend/],
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

const mutating: string[] = [];
const refusingHandler = (p: unknown): Handler => (op) => {
  if (op === "ping") return p;
  if (op === "cmd" || op === "setfader" || op === "lua" || op === "set" || op.startsWith("input.") || op === "control.submit") mutating.push(op);
  throw new Error("unexpected " + op);
};

test("verify queues nothing: only refusals reach control.submit, and control is reported disabled when it is", async () => {
  const ops: { op: string; args: any }[] = [];
  const ref = { gen: 3, selection: 0 };
  const ctl = fakeControl(ref);
  const b = await startFakeBridge((op, args, conn) => {
    if (op === "__close") return ctl(`conn-${conn}`, op, args);
    ops.push({ op, args });
    if (op === "ping") return ping();
    if (op === "feedback.context") return snapshot(args.allExecutors ? [191] : args.executors ?? [], ref.gen, ref.selection);
    if (op === "feedback.watch") return { watched: 4 + args.executors.length };
    if (op === "feedback.unwatch") return { watched: 0 };
    if (op === "control.bind") { if (args.display === 0) throw new Error("[bad-args] args.display must be a positive integer"); return { watched: 5, generation: ref.gen, binding: 1 }; }
    if (op.startsWith("control.") || op === "__close") return ctl(`conn-${conn}`, op, args);
    throw new Error("unexpected " + op);
  });
  try {
    const r = await run(["verify"], { GMA3_BRIDGE_PORT: String(b.port) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /PASS verify: a malformed event, a stale generation, an unbound executor, a missing and a wrong binding revision are refused in place/);
    assert.match(r.stdout, /PASS verify: slot 1 without a selection is refused target-unavailable/);
    assert.match(r.stdout, /PASS verify: control.close ends the session/);
    const submits = ops.filter((o) => o.op === "control.submit");
    assert.ok(submits.length >= 1 && submits.every((o) => (o.args.events as any[]).every((e) => e.type !== "relative" || e.generation !== ref.gen || e.target?.slot === 1 || e.target?.executor === 999999)), "every submitted event is a refusal by construction");
    assert.ok(!ops.some((o) => o.op === "cmd"), "verify sends no command");
  } finally { b.close(); }
  const b2 = await startFakeBridge((op, args) => {
    if (op === "ping") return ping({ control: { enabled: false, backend: null, sessions: 0, queued: 0 } });
    if (op === "feedback.context") return snapshot([], 1);
    if (op === "feedback.watch") return { watched: 4 };
    if (op === "feedback.unwatch") return { watched: 0 };
    if (op === "control.bind") { if (args.display === 0) throw new Error("[bad-args] args.display must be a positive integer"); return { watched: 4, generation: 1, binding: 1 }; }
    if (op === "control.status") return { version: "0.1.0", limitations: ["fake only"], yourSession: null, sessions: {}, busy: null, unresolved: [] };
    if (op === "control.submit") throw new Error('[control-disabled] continuous control is disabled on the console. The console operator can enable it with:  Plugin "gma3_mcp_bridge" "control=fake"');
    throw new Error("unexpected " + op);
  });
  try {
    const r = await run(["verify"], { GMA3_BRIDGE_PORT: String(b2.port) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /PASS control.submit is \[control-disabled\]/);
  } finally { b2.close(); }
});

test("run: the selection is undone after a failure mid-way, and the happy path reports the admission checks", async () => {
  const ref = { gen: 3, selection: 0 };
  const ctl = fakeControl(ref);
  const ops: { op: string; args: any }[] = [];
  let failAfterSelect = true;
  const handler: Handler = (op, args, conn) => {
    if (op === "__close") return ctl(`conn-${conn}`, op, args);
    ops.push({ op, args });
    if (op === "ping") return ping();
    if (op === "feedback.context") { if (failAfterSelect && ref.selection === 1) throw new Error("[not-running] simulated failure"); return snapshot(args.allExecutors ? [191] : args.executors ?? [], ref.gen, ref.selection); }
    if (op === "feedback.watch") return { watched: 5 };
    if (op === "feedback.unwatch") return { watched: 0 };
    if (op === "control.bind") { if (args.display === 0) throw new Error("[bad-args] args.display must be a positive integer"); return { watched: 5, generation: ref.gen, binding: 1 }; }
    if (op === "cmd") {
      if (/^Fixture /.test(args.command)) { ref.selection = 1; ref.gen += 1; }
      if (args.command === "ClearSelection") { ref.selection = 0; ref.gen += 1; }
      const bz = ctl.busy();
      if (/^Echo/.test(args.command) && bz) return { __error: "[busy] a command is refused while input ownership is active", code: "busy", detail: bz };
      if (args.command === "ClearSelection" && ctl.motionBusy()) return { __error: "[busy] motion", code: "busy", detail: { reason: "motion", module: "control" } };
      return { command: args.command, feedback: "OK" };
    }
    if (op.startsWith("control.")) return ctl(`conn-${conn}`, op, args);
    throw new Error("unexpected " + op);
  };
  let b = await startFakeBridge(handler);
  try {
    const r = await run(["run"], { GMA3_BRIDGE_PORT: String(b.port) });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /FAIL run: the mutation phase failed; running the registered undos/);
    assert.match(r.stdout, /PASS run: cleanup ran every registered undo/);
    const cmds = ops.filter((o) => o.op === "cmd").map((o) => o.args.command);
    assert.deepEqual(cmds, ["Fixture 401", "ClearSelection"], cmds.join(" | "));
  } finally { b.close(); }
  failAfterSelect = false;
  ops.length = 0;
  ref.gen = 3; ref.selection = 0;
  b = await startFakeBridge(handler);
  try {
    const r = await run(["run"], { GMA3_BRIDGE_PORT: String(b.port) });
    assert.match(r.stdout, /PASS run: a burst of 10 relative events on slot 1 is admitted and coalesced/, r.stdout + r.stderr);
    assert.match(r.stdout, /PASS run: a resent event \(same seq\) is a duplicate/);
    assert.match(r.stdout, /PASS run: a sequence gap is accepted and reported as loss/);
    assert.match(r.stdout, /PASS run: an older event after a newer one is out-of-order/);
    assert.match(r.stdout, /PASS run: an event with the old generation is refused stale-generation/);
    const cmds = ops.filter((o) => o.op === "cmd").map((o) => o.args.command);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /PASS run: a command from another connection is \[busy\]/);
    assert.match(r.stdout, /PASS run: the disconnect ended the button/);
    assert.equal(cmds[cmds.length - 1], "ClearSelection", cmds.join(" | "));
  } finally { b.close(); }
});

test("eventFactory numbers events per device and outcomesOf compresses a result", () => {
  const ev = eventFactory("d", 4, 2);
  const a = ev.relative(1, 2);
  const t = ev.touch(201, true);
  ev.skip(2);
  const c = ev.button(1, false);
  assert.deepEqual([a.seq, t.seq, c.seq], [1, 2, 5]);
  assert.equal(a.generation, 4);
  assert.equal(a.binding, 2);
  assert.deepEqual(a.target, { slot: 1 });
  assert.deepEqual(t.target, { executor: 201, element: "fader" });
  assert.deepEqual(outcomesOf({ ok: true, result: { accepted: 2, refused: 1, lost: 0, outcomes: [{ accepted: true, queued: 1 }, { accepted: true, coalesced: true }, { refused: "duplicate" }] } }), { accepted: 2, refused: 1, lost: 0, outcomes: ["queued", "coalesced", "duplicate"] });
  assert.deepEqual(outcomesOf({ ok: false, error: "x", code: "y" }), { error: "x", code: "y" });
});

test("usage error without a mode", async () => {
  const r = await run([], {});
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});
