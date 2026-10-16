/**
 * SU-16: live playback and value reads. The playback state helpers, the compact programmer read and
 * gma3_observe_values against an in-process FakeBridge; the index.ts reads (gma3_sequences, gma3_cues,
 * gma3_executors, gma3_playback) through the real server over stdio.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { annotatePlayback, playbackState, registerLiveStateTools } from "../src/tools/livestate.ts";
import { compactProgrammer, registerInspectionTools } from "../src/tools/inspection.ts";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { FakeBridge } from "./helpers/fake-bridge.ts";
import { mcpIsError, mcpText, startMcpServer } from "./helpers/mcp-server.ts";

// ---------------------------------------------------------------------------
// Playback state
// ---------------------------------------------------------------------------

test("playbackState: a cue is current only while the sequence plays; after Off it is the last cue", () => {
  assert.deepEqual(playbackState({ hasActivePlayback: true, currentCue: { no: 7, name: "Cone" } }), { active: true, currentCue: { no: 7, name: "Cone" } });
  assert.deepEqual(playbackState({ hasActivePlayback: false, currentCue: { no: 7, name: "Cone" } }), { active: false, currentCue: null, lastCue: { no: 7, name: "Cone" } });
  assert.deepEqual(playbackState({ hasActivePlayback: false }), { active: false, currentCue: null });
  // Bridge before 0.32.0: activity only.
  assert.deepEqual(playbackState({ hasActivePlayback: true }), { active: true, currentCue: null });
  assert.deepEqual(playbackState({}), { active: null, currentCue: null });
  // Fractional cues keep their number (the bridge divides Cue.no by 1000).
  assert.deepEqual(playbackState({ hasActivePlayback: true, currentCue: { no: 2.5, name: "" } }).currentCue, { no: 2.5, name: "" });
});

test("annotatePlayback: rewrites sequence summaries in place and leaves other objects alone", () => {
  const off = annotatePlayback({ name: "S", hasActivePlayback: false, currentCue: { no: 3, name: "x" } }) as Record<string, unknown>;
  assert.equal(off.currentCue, null);
  assert.deepEqual(off.lastCue, { no: 3, name: "x" });
  const on = annotatePlayback({ name: "S", hasActivePlayback: true, currentCue: { no: 3, name: "x" } }) as Record<string, unknown>;
  assert.deepEqual(on.currentCue, { no: 3, name: "x" });
  assert.equal("lastCue" in on, false);
  const macro = { name: "M", class: "Macro" };
  assert.deepEqual(annotatePlayback(macro), { name: "M", class: "Macro" });
  assert.equal(annotatePlayback(undefined), undefined);
});

test("review round 1: without a readable activity flag a cue is observed, never current", () => {
  // The bridge reads HasActivePlayback in a pcall: a failed read omits the flag while CurrentCue (sticky) still reads.
  for (const flag of [undefined, null, "maybe", 1]) {
    const s = playbackState({ ...(flag === undefined ? {} : { hasActivePlayback: flag }), currentCue: { no: 7, name: "sticky" } });
    assert.deepEqual(s, { active: null, currentCue: null, observedCue: { no: 7, name: "sticky" } }, `flag ${String(flag)}`);
  }
  const seq = annotatePlayback({ name: "S", class: "Sequence", currentCue: { no: 7, name: "sticky" } }) as Record<string, unknown>;
  assert.equal(seq.currentCue, null, "a known Sequence is annotated even when the activity read is missing");
  assert.deepEqual(seq.observedCue, { no: 7, name: "sticky" });
  const on = annotatePlayback({ class: "Sequence", hasActivePlayback: true, currentCue: { no: 7, name: "x" }, observedCue: { no: 1, name: "old" } }) as Record<string, unknown>;
  assert.equal("observedCue" in on, false);
});

// ---------------------------------------------------------------------------
// Compact programmer
// ---------------------------------------------------------------------------

const progRows = [
  { fixture: "Hex 1", fid: 101, subfixtureIndex: 0, attribute: "Dimmer", value: 100, valueRaw: 16777215, present: true },
  { fixture: "Hex 1", fid: 101, subfixtureIndex: 0, attribute: "ColorRGB_R", value: 50, valueRaw: 8388607, present: true },
  { fixture: "Hex 2", fid: 102, subfixtureIndex: 1, attribute: "Dimmer", value: null, steps: [{ value: 0 }, { value: 100 }], present: true },
];

test("compactProgrammer: fields keep the channel identity; by_fixture folds rows per fixture", () => {
  const picked = compactProgrammer(progRows, { fields: ["value"] });
  assert.deepEqual(picked.rows![0], { fid: 101, subfixtureIndex: 0, attribute: "Dimmer", value: 100 });
  const folded = compactProgrammer(progRows, { byFixture: true });
  assert.equal(folded.rows, undefined);
  assert.deepEqual(folded.perFixture, [
    { fid: 101, fixture: "Hex 1", subfixtureIndex: 0, channels: 2, values: { Dimmer: 100, ColorRGB_R: 50 } },
    { fid: 102, fixture: "Hex 2", subfixtureIndex: 1, channels: 1, values: { Dimmer: "phaser (2 steps)" } },
  ]);
  const both = compactProgrammer(progRows, { byFixture: true, fields: ["valueRaw"] });
  assert.deepEqual(both.perFixture![0].values, { Dimmer: { valueRaw: 16777215 }, ColorRGB_R: { valueRaw: 8388607 } });
});

let h: Harness;
before(async () => {
  h = await startHarness((server, ctx) => {
    registerInspectionTools(server, ctx);
    registerLiveStateTools(server, ctx);
  });
});
after(() => h.close());
beforeEach(() => h.fake.reset());

test("gma3_programmer by_fixture: no raw rows in the result, and a whole scan per page by default", async () => {
  h.fake.on("programmer", () => ({ rows: progRows, coverage: { complete: true }, source: "programmer" }));
  const res = await h.callJson("gma3_programmer", { scope: "fixtures", fixtures: "101 Thru 102", by_fixture: true });
  assert.equal(res.isError, false, res.text);
  assert.equal(res.result.rows, undefined, "the folded form replaces the rows");
  assert.equal(res.result.perFixture.length, 2);
  assert.equal((h.fake.requests.at(-1)!.args as { limit: number }).limit, 5000);
  const bad = await h.callJson("gma3_programmer", { scope: "all", fields: ["nope"] });
  assert.equal(bad.isError, true);
});

// ---------------------------------------------------------------------------
// gma3_observe_values
// ---------------------------------------------------------------------------

test("observe_values (programmer): reports timed changes, releases and unchanged channels", async () => {
  let n = 0;
  h.fake.on("programmer", (args) => {
    assert.equal(args.fixtures, "Fixture 101 Thru 102");
    n++;
    const dim = n < 3 ? 0 : 100;
    const rows: Record<string, unknown>[] = [
      { fid: 101, subfixtureIndex: 0, attribute: "Dimmer", value: dim, present: true },
      { fid: 102, subfixtureIndex: 1, attribute: "Dimmer", value: 40, present: true },
    ];
    if (n < 4) rows.push({ fid: 101, subfixtureIndex: 0, attribute: "ColorRGB_R", value: 10, present: true });
    return { rows, coverage: { complete: true } };
  });
  const res = await h.callJson("gma3_observe_values", { fixtures: "101 Thru 102", seconds: 1, interval_ms: 50 });
  assert.equal(res.isError, false, res.text);
  const r = res.result;
  assert.equal(r.observed, true);
  assert.ok(r.samples >= 4, `samples ${r.samples}`);
  const dim = r.changed.find((c: { fid: number; attribute: string }) => c.fid === 101 && c.attribute === "Dimmer");
  assert.equal(dim.first, 0);
  assert.equal(dim.last, 100);
  assert.equal(dim.changeCount, 1);
  assert.deepEqual([dim.min, dim.max], [0, 100]);
  assert.equal(dim.changes[0].from, 0);
  assert.ok(dim.changes[0].ms > 0);
  const red = r.changed.find((c: { attribute: string }) => c.attribute === "ColorRGB_R");
  assert.equal(red.last, null, "a channel that left the programmer was released");
  assert.deepEqual(r.unchanged, [{ fid: 102, subfixtureIndex: 1, attribute: "Dimmer", value: 40 }]);
});

test("observe_values (programmer): a failed read is a gap, not a value; attributes filter the channels", async () => {
  let n = 0;
  h.fake.on("programmer", () => {
    n++;
    if (n === 2) throw new Error("busy");
    return { rows: [{ fid: 101, subfixtureIndex: 0, attribute: "Dimmer", value: 50, present: true }, { fid: 101, subfixtureIndex: 0, attribute: "Pan", value: 1, present: true }], coverage: { complete: true } };
  });
  const res = await h.callJson("gma3_observe_values", { fixtures: [101], attributes: ["dimmer"], seconds: 1, interval_ms: 100 });
  assert.equal(res.isError, false, res.text);
  assert.equal(res.result.unreadSamples, 1);
  assert.equal(res.result.changedChannels, 0, "the failed read did not count as a release");
  assert.deepEqual(res.result.unchanged, [{ fid: 101, subfixtureIndex: 0, attribute: "Dimmer", value: 50 }]);
});

test("observe_values (output): says up front that ungranted output cannot be read and samples nothing", async () => {
  h.fake.on("fixtureOutput", () => ({ channels: [{ rtIndex: 1, channel: "Dim", attribute: "Dimmer", universe: 1, address: 1, value: null }] }));
  h.fake.on("dmxState", () => {
    throw new Error("unknown op 'dmxState'");
  });
  const res = await h.callJson("gma3_observe_values", { fixtures: 101, source: "output", seconds: 5 });
  assert.equal(res.isError, false, res.text);
  assert.equal(res.result.observed, false);
  assert.match(res.result.reason, /output cannot be read/);
  assert.match(res.result.reason, /universe 1/);
  assert.ok(res.result.outputState, "the universes' state is explained");
  assert.equal(h.fake.requests.filter((r) => r.op === "fixtureOutput").length, 1, "nothing was sampled after the check");
});

test("observe_values (output): samples raw DMX per fixture and caps the fixture count", async () => {
  let n = 0;
  h.fake.on("fixtureOutput", (args) => {
    if (args.ref === "Fixture 101") n++;
    return { channels: [{ rtIndex: 1, channel: "Dim", attribute: "Dimmer", universe: 1, address: 1, value: args.ref === "Fixture 101" && n > 2 ? 255 : 0 }] };
  });
  const res = await h.callJson("gma3_observe_values", { fixtures: [101, 102], source: "output", seconds: 1, interval_ms: 100 });
  assert.equal(res.isError, false, res.text);
  assert.equal(res.result.changedChannels, 1);
  assert.equal(res.result.changed[0].fixture, "Fixture 101");
  assert.equal(res.result.changed[0].last, 255);
  const many = await h.callJson("gma3_observe_values", { fixtures: [1, 2, 3, 4, 5, 6, 7, 8, 9], source: "output" });
  assert.equal(many.isError, true);
  assert.match(many.text, /at most 8 fixtures/);
});

test("observe_values: an empty programmer is reported, not watched", async () => {
  h.fake.on("programmer", () => ({ rows: [], coverage: { complete: true } }));
  const res = await h.callJson("gma3_observe_values", { fixtures: "101", seconds: 5 });
  assert.equal(res.result.observed, false);
  assert.match(res.result.reason, /no values/);
  assert.equal(h.fake.requests.filter((r) => r.op === "programmer").length, 1);
});

// --- review round 1: coverage and availability --------------------------------------------------

const dimRow = (value: number) => ({ fid: 101, subfixtureIndex: 0, attribute: "Dimmer", value, present: true });

test("review round 1: an incomplete programmer read is a gap, never a release", async () => {
  let n = 0;
  h.fake.on("programmer", () => (++n === 2 ? { rows: [], coverage: { complete: false } } : { rows: [dimRow(50)], coverage: { complete: true }, total: 1 }));
  const res = await h.callJson("gma3_observe_values", { fixtures: [101], seconds: 1, interval_ms: 100 });
  assert.equal(res.isError, false, res.text);
  assert.equal(res.result.changedChannels, 0, res.text);
  assert.equal(res.result.unreadSamples, 1);
  assert.match(res.result.gapReasons[0], /coverage/);
  assert.deepEqual(res.result.unchanged, [{ fid: 101, subfixtureIndex: 0, attribute: "Dimmer", value: 50 }]);
});

test("review round 1: an incomplete or truncated first read is not called an empty programmer", async () => {
  h.fake.on("programmer", () => ({ rows: [], coverage: { complete: false } }));
  const empty = await h.callJson("gma3_observe_values", { fixtures: "101", seconds: 5 });
  assert.equal(empty.result.observed, false);
  assert.match(empty.result.reason, /first read was incomplete/);
  assert.doesNotMatch(empty.result.reason, /holds no values/);
  h.fake.on("programmer", () => ({ rows: [dimRow(50)], coverage: { complete: true }, total: 6000, count: 1 }));
  const capped = await h.callJson("gma3_observe_values", { fixtures: "101", seconds: 5 });
  assert.equal(capped.result.observed, false);
  assert.match(capped.result.reason, /1 of 6000 rows/);
});

test("review round 1: a truncated later page is a gap (programmer and output)", async () => {
  let n = 0;
  h.fake.on("programmer", () => (++n === 2 ? { rows: [], coverage: { complete: true }, total: 1 } : { rows: [dimRow(50)], coverage: { complete: true }, total: 1 }));
  const prog = await h.callJson("gma3_observe_values", { fixtures: [101], seconds: 1, interval_ms: 100 });
  assert.equal(prog.result.changedChannels, 0, prog.text);
  assert.equal(prog.result.unreadSamples, 1);
  let m = 0;
  h.fake.on("fixtureOutput", () => ({ total: ++m === 2 ? 2 : 1, channels: [{ rtIndex: 1, channel: "Dim", attribute: "Dimmer", universe: 1, address: 1, value: 255 }] }));
  const out = await h.callJson("gma3_observe_values", { fixtures: 101, source: "output", seconds: 1, interval_ms: 100 });
  assert.equal(out.result.unreadSamples, 1, out.text);
  assert.match(out.result.gapReasons[0], /1 of 2 channels/);
});

test("review round 1: an unreadable output sample is a gap that keeps the last level, not a change", async () => {
  let n = 0;
  h.fake.on("fixtureOutput", () => ({ total: 1, channels: [{ rtIndex: 1, channel: "Dim", attribute: "Dimmer", universe: 1, address: 1, value: ++n === 2 ? null : 255 }] }));
  const res = await h.callJson("gma3_observe_values", { fixtures: 101, source: "output", seconds: 1, interval_ms: 100 });
  assert.equal(res.isError, false, res.text);
  assert.equal(res.result.changedChannels, 0, res.text);
  assert.equal(res.result.unchanged[0].value, 255);
  assert.equal(res.result.unchanged[0].unreadSamples, 1);
  const gap = res.result.unchanged[0].unreadable[0];
  assert.ok(gap.fromMs > 0 && gap.toMs > gap.fromMs, JSON.stringify(gap));
  assert.equal(res.result.unreadableChannels.length, 1);
  assert.ok(res.result.outputState, "unreadable channels are explained");
});

test("review round 1: partially readable output, and a channel that becomes unreadable mid-window", async () => {
  let n = 0;
  h.fake.on("fixtureOutput", () => {
    n++;
    return {
      total: 2,
      channels: [
        { rtIndex: 1, channel: "Dim", attribute: "Dimmer", universe: 1, address: 1, value: n > 3 ? null : 100 },
        { rtIndex: 2, channel: "Red", attribute: "ColorRGB_R", universe: 2, address: 1, value: null },
      ],
    };
  });
  const res = await h.callJson("gma3_observe_values", { fixtures: 101, source: "output", seconds: 1, interval_ms: 100 });
  assert.equal(res.result.observed, true, res.text);
  assert.equal(res.result.changedChannels, 0, res.text);
  const dim = res.result.unchanged.find((c: { attribute: string }) => c.attribute === "Dimmer");
  assert.equal(dim.value, 100, "the last level is kept");
  assert.equal(dim.unreadable.at(-1).toMs, null, "still unreadable at the end");
  const red = res.result.unreadableChannels.find((c: { attribute: string }) => c.attribute === "ColorRGB_R");
  assert.equal(red.everRead, false);
  assert.equal(res.result.unchanged.some((c: { attribute: string }) => c.attribute === "ColorRGB_R"), false, "never read is not a value");
});

// ---------------------------------------------------------------------------
// index.ts reads through the real server
// ---------------------------------------------------------------------------

const fake = new FakeBridge();
let client: Client;
let playing: Record<number, { hasActivePlayback: boolean; currentCue?: { no: number; name: string } }> = {};

before(async () => {
  const port = await fake.listen();
  client = await startMcpServer({ GMA3_BRIDGE_HOST: "127.0.0.1", GMA3_BRIDGE_PORT: String(port), GMA3_BRIDGE_TIMEOUT_MS: "2000", GMA3_OSC_PORT: "1" });
});
after(async () => {
  await client.close().catch(() => {});
  await fake.close();
});
beforeEach(() => {
  fake.reset();
  playing = { 1: { hasActivePlayback: true, currentCue: { no: 2, name: "Two" } }, 2: { hasActivePlayback: false, currentCue: { no: 5, name: "Five" } } };
  fake.on("object", (args) => {
    if (args.ref === 'Sequence "Clock"') return { name: "Clock", class: "Sequence", hasActivePlayback: true, currentCue: { no: 4, name: "Four" } };
    const m = String(args.ref).match(/^Sequence (\d+)$/);
    if (!m) throw new Error(`no object found for '${args.ref}'`);
    if (Number(m[1]) === 404) throw new Error(`no object found for '${args.ref}'`);
    return { name: `Seq ${m[1]}`, class: "Sequence", ...(playing[Number(m[1])] ?? { hasActivePlayback: false }) };
  });
});

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = mcpText(res);
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { isError: mcpIsError(res), text, json };
}

test("gma3_sequences: currentCue only for a playing sequence, lastCue after Off", async () => {
  fake.on("children", () => ({ total: 2, offset: 0, count: 2, items: [{ name: "A", class: "Sequence", ...playing[1] }, { name: "B", class: "Sequence", ...playing[2] }] }));
  const res = await call("gma3_sequences", {});
  assert.equal(res.isError, false, res.text);
  assert.deepEqual(res.json.items[0].currentCue, { no: 2, name: "Two" });
  assert.equal(res.json.items[1].currentCue, null);
  assert.deepEqual(res.json.items[1].lastCue, { no: 5, name: "Five" });
  assert.equal((fake.requests.at(-1)!.args as { playback: boolean }).playback, true);
});

test("gma3_executors: an assigned sequence's cue is annotated the same way", async () => {
  fake.on("executors", () => ({ count: 2, executors: [{ number: 201, assigned: { name: "A", class: "Sequence", ...playing[1] } }, { number: 202, assigned: { name: "B", class: "Sequence", ...playing[2] } }] }));
  const res = await call("gma3_executors", {});
  assert.equal(res.isError, false, res.text);
  assert.deepEqual(res.json.executors[0].assigned.currentCue, { no: 2, name: "Two" });
  assert.deepEqual(res.json.executors[1].assigned.lastCue, { no: 5, name: "Five" });
});

test("gma3_cues: several sequences in one read, each with its playback state; a missing one is its own row", async () => {
  fake.on("children", (args) => {
    if (args.ref === "Sequence 404") throw new Error("no object found for 'Sequence 404'");
    return { total: 1, offset: 0, count: 1, items: [{ name: "Cue", fields: { No: "1", TrigType: "Time", TrigTime: "2.00" } }] };
  });
  const res = await call("gma3_cues", { sequences: [1, 2, 404] });
  assert.equal(res.isError, false, res.text);
  assert.equal(res.json.count, 3);
  assert.deepEqual(res.json.sequences[0].playback, { active: true, currentCue: { no: 2, name: "Two" } });
  assert.deepEqual(res.json.sequences[1].playback, { active: false, currentCue: null, lastCue: { no: 5, name: "Five" } });
  assert.equal(res.json.sequences[0].items[0].fields.TrigType, "Time");
  assert.match(res.json.sequences[2].error, /no object found/);
  // The single form keeps its shape and gains the state.
  const one = await call("gma3_cues", { sequence: 1 });
  assert.equal(one.json.items.length, 1);
  assert.equal(one.json.playback.active, true);
  const both = await call("gma3_cues", { sequence: 1, sequences: [2] });
  assert.equal(both.isError, true);
});

test("review round 1: gma3_cues reads the playback state of a named sequence (single and several)", async () => {
  fake.on("children", () => ({ total: 1, offset: 0, count: 1, items: [{ name: "Cue", fields: { No: "1" } }] }));
  const one = await call("gma3_cues", { sequence: "Clock" });
  assert.equal(one.isError, false, one.text);
  assert.deepEqual(one.json.playback, { active: true, currentCue: { no: 4, name: "Four" } });
  const many = await call("gma3_cues", { sequences: ["Clock", 1] });
  assert.deepEqual(many.json.sequences[0].playback, { active: true, currentCue: { no: 4, name: "Four" } });
  assert.deepEqual(many.json.sequences[1].playback, { active: true, currentCue: { no: 2, name: "Two" } });
  assert.ok(fake.requests.some((r) => r.op === "object" && r.args.ref === 'Sequence "Clock"'));
});

test("review round 1: gma3_sequences does not call a sticky cue current when the activity read failed", async () => {
  fake.on("children", () => ({ total: 1, offset: 0, count: 1, items: [{ name: "A", class: "Sequence", currentCue: { no: 7, name: "sticky" } }] }));
  const res = await call("gma3_sequences", {});
  assert.equal(res.json.items[0].currentCue, null);
  assert.deepEqual(res.json.items[0].observedCue, { no: 7, name: "sticky" });
});

test("gma3_playback: reads the sequence state a frame after the command", async () => {
  fake.onCommand((command) => {
    if (command === "Off Sequence 1") playing[1] = { hasActivePlayback: false, currentCue: { no: 2, name: "Two" } };
    return "OK";
  });
  const res = await call("gma3_playback", { action: "off", target: "Sequence 1" });
  assert.equal(res.isError, false, res.text);
  assert.deepEqual(res.json.playbackState, { target: "Sequence 1", active: false, currentCue: null, lastCue: { no: 2, name: "Two" }, sequence: { name: "Seq 1" }, readAfterMs: 100 });
  const ops = fake.requests.map((r) => r.op);
  assert.ok(ops.lastIndexOf("object") > ops.lastIndexOf("cmd"));

  fake.on("executor", () => ({ number: 201, assigned: { name: "A", class: "Sequence", hasActivePlayback: true, currentCue: { no: 1, name: "One" } } }));
  const ex = await call("gma3_playback", { action: "go", target: "Executor 201" });
  assert.deepEqual(ex.json.playbackState.currentCue, { no: 1, name: "One" });

  const macro = await call("gma3_playback", { action: "go", target: "Macro 5" });
  assert.match(macro.json.playbackState.notRead, /Sequence n, Sequence "name" and Executor n/);
});
