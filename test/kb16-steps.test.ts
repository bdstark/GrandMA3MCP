import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore plain ES module without types
import { createCleanup, execRef, probeExecutorButton, probeFader, programmerEmpty, TargetRefused } from "../scripts/lib/kb16-steps.mjs";

/**
 * scripts/lib/kb16-steps.mjs with injected failures: an intermediate error must never skip an executor
 * release or a fader restoration, cleanup must keep going after one undo fails, targets must be
 * page-qualified, and the programmer gate must refuse whenever emptiness cannot be established.
 */

type Call = { kind: string; args: any[] };

function fakeIo(opts: { failActivityAt?: number; failCmd?: RegExp; refuseCmd?: RegExp; faderValues?: number[]; activity?: boolean[]; failFaderRead?: boolean } = {}) {
  const calls: Call[] = [];
  let activityCalls = 0;
  let faderReads = 0;
  const activity = opts.activity ?? [false, true, false, false];
  const faderValues = opts.faderValues ?? [100, 25, 100];
  const io = {
    calls,
    async cmd(command: string) {
      calls.push({ kind: "cmd", args: [command] });
      if (opts.failCmd?.test(command)) throw new Error(`socket closed during ${command}`);
      if (opts.refuseCmd?.test(command)) return { ok: false, error: "refused" };
      return { ok: true, feedback: "OK" };
    },
    async activity(index: number) {
      calls.push({ kind: "activity", args: [index] });
      activityCalls++;
      if (opts.failActivityAt === activityCalls) throw new Error("lua timeout");
      return { active: activity[Math.min(activityCalls - 1, activity.length - 1)], line: "" };
    },
    async faderValue(index: number, token: string) {
      calls.push({ kind: "faderValue", args: [index, token] });
      if (opts.failFaderRead && faderReads > 0) throw new Error("lua timeout");
      return faderValues[Math.min(faderReads++, faderValues.length - 1)];
    },
    async setfader(ref: string, value: number) {
      calls.push({ kind: "setfader", args: [ref, value] });
      return { ok: true };
    },
    async sleep() {},
  };
  return io;
}

const temp = { index: 193, name: "LOS2 Odd", keyPress: "Temp", keyUnpress: "", klass: "Sequence" };
const cmds = (io: any) => io.calls.filter((c: Call) => c.kind === "cmd").map((c: Call) => c.args[0]);

test("a successful press/release leaves no pending undo and uses page-qualified targets", async () => {
  const io = fakeIo();
  const cleanup = createCleanup();
  const obs = await probeExecutorButton({ io, cleanup, pageNo: 1, exec: temp, holdMs: 1 });
  assert.deepEqual(cmds(io), ["Press Page 1.193", "Unpress Page 1.193"]);
  assert.equal(obs.during, true);
  assert.equal(obs.after, false);
  assert.deepEqual(cleanup.pending(), []);
  assert.deepEqual(await cleanup.run(), []);
});

test("an activity read that throws after the Press still releases the executor through cleanup", async () => {
  const io = fakeIo({ failActivityAt: 2 });
  const cleanup = createCleanup();
  await assert.rejects(() => probeExecutorButton({ io, cleanup, pageNo: 1, exec: temp, holdMs: 1 }), /activity during hold: lua timeout/);
  assert.deepEqual(cmds(io), ["Press Page 1.193"], "the step itself did not get to the Unpress");
  assert.deepEqual(cleanup.pending(), ["Unpress Page 1.193 (LOS2 Odd)"]);
  const out = await cleanup.run();
  assert.deepEqual(cmds(io), ["Press Page 1.193", "Unpress Page 1.193"]);
  assert.deepEqual(out.map((o) => [o.label, o.ok]), [["Unpress Page 1.193 (LOS2 Odd)", true]]);
});

test("a latching function registers Off before the Press and keeps it when the Unpress read fails", async () => {
  const io = fakeIo({ failActivityAt: 3, activity: [false, true, true, false] });
  const cleanup = createCleanup();
  const toggle = { ...temp, index: 195, name: "LOS2 Chase", keyPress: "Toggle" };
  await assert.rejects(() => probeExecutorButton({ io, cleanup, pageNo: 2, exec: toggle, holdMs: 1, off: 'Off Sequence "LOS2 Chase"' }), /activity after release/);
  assert.deepEqual(cleanup.pending(), ['Off Sequence "LOS2 Chase" (LOS2 Chase)'], "the Unpress was answered OK, only the Off remains");
  await cleanup.run();
  assert.deepEqual(cmds(io), ["Press Page 2.195", "Unpress Page 2.195", 'Off Sequence "LOS2 Chase"']);
});

test("an already-active target is refused before any dispatch and nothing is registered", async () => {
  const io = fakeIo({ activity: [true] });
  const cleanup = createCleanup();
  await assert.rejects(() => probeExecutorButton({ io, cleanup, pageNo: 1, exec: temp, holdMs: 1, off: 'Off Sequence "x"' }), (e: any) => e instanceof TargetRefused && e.detail.reason === "active");
  assert.deepEqual(cmds(io), [], "no Press, no Unpress, no Off");
  assert.deepEqual(cleanup.pending(), []);
  const io2 = fakeIo({ activity: [true], faderValues: [100] });
  const cleanup2 = createCleanup();
  await assert.rejects(() => probeFader({ io: io2, cleanup: cleanup2, pageNo: 1, exec: temp, token: "FaderTemp", target: 60, set: io2.setfader }), (e: any) => e instanceof TargetRefused);
  assert.equal(io2.calls.filter((c: Call) => c.kind === "setfader" || c.kind === "faderValue").length, 0, "neither read nor moved");
  assert.deepEqual(cleanup2.pending(), []);
});

test("an unreadable activity before dispatch is refused with nothing registered", async () => {
  const io = fakeIo({ failActivityAt: 1 });
  const cleanup = createCleanup();
  await assert.rejects(() => probeExecutorButton({ io, cleanup, pageNo: 1, exec: temp, holdMs: 1 }), (e: any) => e instanceof TargetRefused && e.detail.reason === "unreadable");
  assert.deepEqual(cmds(io), []);
  assert.deepEqual(cleanup.pending(), []);
});

test("a refused Press registers nothing to undo", async () => {
  const io = fakeIo({ refuseCmd: /^Press/ });
  const cleanup = createCleanup();
  await assert.rejects(() => probeExecutorButton({ io, cleanup, pageNo: 1, exec: temp, holdMs: 1 }), /press refused/);
  assert.deepEqual(cleanup.pending(), []);
});

test("cleanup attempts every remaining undo even when one fails, newest first", async () => {
  const cleanup = createCleanup();
  const order: string[] = [];
  cleanup.add("first", async () => { order.push("first"); return { ok: true }; });
  cleanup.add("second", async () => { order.push("second"); throw new Error("socket closed"); });
  cleanup.add("third", async () => { order.push("third"); return { ok: false, error: "refused" }; });
  const done = cleanup.add("done already", async () => { order.push("never"); });
  done.done();
  const out = await cleanup.run();
  assert.deepEqual(order, ["third", "second", "first"]);
  assert.deepEqual(out.map((o) => [o.label, o.ok, o.error]), [["third", false, "refused"], ["second", false, "socket closed"], ["first", true, undefined]]);
  assert.deepEqual(cleanup.pending(), []);
});

test("a fader move reads the original first, restores it, and a failed read-back keeps the restoration pending", async () => {
  const io = fakeIo({ faderValues: [100, 25, 100] });
  const cleanup = createCleanup();
  const master = { ...temp, index: 191, name: "LOS2 All DelayA", fader: "Master" };
  const obs = await probeFader({ io, cleanup, pageNo: 1, exec: master, token: "FaderMaster", target: 25, set: io.setfader, settleMs: 0 });
  assert.equal(obs.original, 100);
  assert.equal(obs.moved, 25);
  assert.equal(obs.restored, 100);
  assert.deepEqual(io.calls.filter((c: Call) => c.kind === "setfader").map((c: Call) => c.args), [["Page 1.191", 25], ["Page 1.191", 100]]);
  assert.deepEqual(cleanup.pending(), []);

  const io2 = fakeIo({ faderValues: [60, 25], failFaderRead: true });
  const cleanup2 = createCleanup();
  await assert.rejects(() => probeFader({ io: io2, cleanup: cleanup2, pageNo: 3, exec: master, token: "FaderMaster", target: 25, set: io2.setfader, settleMs: 0 }), /read after move: lua timeout/);
  assert.deepEqual(cleanup2.pending(), ["FaderMaster Page 3.191 back to 60 (LOS2 All DelayA)"]);
  await cleanup2.run();
  const sets = io2.calls.filter((c: Call) => c.kind === "setfader").map((c: Call) => c.args);
  assert.deepEqual(sets, [["Page 3.191", 25], ["Page 3.191", 60]], "the restoration uses the value read before the move");
});

test("a fader whose original cannot be read is not moved", async () => {
  const io = fakeIo({ faderValues: [NaN] });
  const cleanup = createCleanup();
  await assert.rejects(() => probeFader({ io, cleanup, pageNo: 1, exec: temp, token: "FaderTemp", target: 60, set: io.setfader }), /cannot be read before the move/);
  assert.equal(io.calls.filter((c: Call) => c.kind === "setfader").length, 0);
  assert.deepEqual(cleanup.pending(), []);
});

test("the programmer gate accepts only a complete scan with no data", () => {
  const empty = { result: { coverage: { complete: true, scannedFixtures: 9, totalFixtures: 9, scannedChannels: 71 }, stats: { channelsWithData: 0, channelsWithStepsButInactiveMask: 0, channelErrors: 0 }, total: 0, rows: [], limitations: [] } };
  assert.equal(programmerEmpty(empty).ok, true);
  assert.match(programmerEmpty({ result: { ...empty.result, coverage: { ...empty.result.coverage, complete: false, scannedFixtures: 3 }, limitations: ["truncated"] } }).reason, /incomplete.*3\/9.*truncated/);
  assert.match(programmerEmpty({ result: { ...empty.result, stats: { ...empty.result.stats, channelsWithData: 2 }, total: 2 } }).reason, /holds values.*2 channel/);
  assert.match(programmerEmpty({ result: { ...empty.result, stats: { ...empty.result.stats, channelErrors: 1 } } }).reason, /could not be read/);
  assert.match(programmerEmpty({ ok: false, error: "busy" }).reason, /programmer op failed: busy/);
  assert.match(programmerEmpty({ result: { note: "x" } }).reason, /cannot be established/);
  assert.match(programmerEmpty(undefined).reason, /no result/);
});

test("execRef is page-qualified", () => {
  assert.equal(execRef(4, 210), "Page 4.210");
});
