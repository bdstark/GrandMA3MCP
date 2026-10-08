import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { registerInspectionTools, fixtureRef, fixtureRange, withNulls } from "../src/tools/inspection.ts";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { SILENT } from "./helpers/fake-bridge.ts";

/**
 * FR-07 .. FR-10: the inspection tools against the FakeBridge. The bridge ops themselves are
 * exercised by the Lua harness (test/lua/bridge_plugin_test.lua); here we check validation,
 * argument forwarding, pagination, null-filling, limitation/coverage pass-through and error
 * surfacing on the TypeScript side.
 */

let h: Harness;

before(async () => {
  h = await startHarness(registerInspectionTools, { requestTimeoutMs: 400 });
});
after(async () => {
  await h.close();
});
beforeEach(() => h.fake.reset());

const lastArgs = (op: string) => h.fake.requests.filter((r) => r.op === op).at(-1)?.args;

// ---------------------------------------------------------------------------
test("the five inspection tools are registered and none take the mutation lock", () => {
  for (const n of ["gma3_fixture_attributes", "gma3_programmer", "gma3_fixture_output", "gma3_dmx", "gma3_cue_contents"]) assert.ok(h.tools.has(n), n);
  for (const t of h.tools.values()) {
    assert.match(t.description ?? "", /Works with gma3_lua disabled/);
    assert.match(t.description ?? "", /Read-only/);
  }
  assert.equal(h.ctx.mutations.busy, false);
});

test("tool descriptions state the essential facts", () => {
  assert.match(h.tools.get("gma3_programmer")!.description!, /NOT OUTPUT VALUES/);
  assert.match(h.tools.get("gma3_dmx")!.description!, /raw8.*percent/);
  assert.match(h.tools.get("gma3_fixture_output")!.description!, /per-attribute cooked output/);
  assert.match(h.tools.get("gma3_cue_contents")!.description!, /hard \(non-recipe\) fixture values/);
  assert.match(h.tools.get("gma3_cue_contents")!.description!, /Never sends Goto/);
});

// ---------------------------------------------------------------------------
test("fixtureRef normalises fixture references and refuses anything else", () => {
  assert.equal(fixtureRef("f", 101), "Fixture 101");
  assert.equal(fixtureRef("f", "501.3"), "Fixture 501.3");
  assert.equal(fixtureRef("f", "fixture 7"), "Fixture 7");
  assert.equal(fixtureRef("f", "SubFixture 501.3"), "Subfixture 501.3");
  assert.throws(() => fixtureRef("f", "Group 5"), /must be one fixture/);
  assert.throws(() => fixtureRef("f", 'Fixture "x"'), /quotes/);
  assert.throws(() => fixtureRef("f", 0), /positive integer/);
  assert.throws(() => fixtureRef("f", "1 Thru 5"), /must be one fixture/);
});

test("fixtureRange accepts ranges and refuses groups", () => {
  assert.equal(fixtureRange("f", "1 Thru 5"), "Fixture 1 Thru 5");
  assert.equal(fixtureRange("f", "Fixture 101 + 103"), "Fixture 101 + 103");
  assert.equal(fixtureRange("f", "4.1"), "Fixture 4.1");
  assert.throws(() => fixtureRange("f", "Group 3"), /unsupported token/);
  assert.throws(() => fixtureRange("f", "Fixture"), /at least one fixture ID/);
});

test("withNulls makes every documented key present and keeps extras", () => {
  assert.deepEqual(withNulls({ a: 1, extra: "x" }, ["a", "b"]), { a: 1, b: null, extra: "x" });
  assert.deepEqual(withNulls({ a: 0, b: false }, ["a", "b"]), { a: 0, b: false });
  assert.deepEqual(withNulls(undefined, ["a"]), { a: null });
});

// ---------------------------------------------------------------------------
test("gma3_fixture_attributes forwards ref, pagination and channel-set flag, and fills missing metadata with null", async () => {
  h.fake.on("fixtureAttributes", (args) => ({
    name: "Spot 1", fid: "601", subfixtureIndex: 2, source: "uiChannels", total: 3, offset: Number(args.offset), count: 1,
    attributes: [{ uiChannel: 4, attribute: "Pan", attributeIndex: 1, physicalFrom: -270, physicalTo: 270, dmx: { coarse: "2.001", fine: "2.002", bits: 16 } }],
    subfixtures: [], channels: [], limitations: ["example limitation"],
  }));
  const { result, isError } = await h.callJson("gma3_fixture_attributes", { fixture: 601, limit: 1, offset: 1, include_channel_sets: true });
  assert.equal(isError, false);
  assert.deepEqual(lastArgs("fixtureAttributes"), { ref: "Fixture 601", limit: 1, offset: 1, includeChannelSets: true });
  assert.equal(result.source, "uiChannels");
  assert.deepEqual(result.limitations, ["example limitation"]);
  assert.equal(result.total, 3);
  assert.equal(result.count, 1);
  const row = result.attributes[0];
  assert.equal(row.attribute, "Pan");
  assert.equal(row.physicalFrom, -270);
  assert.equal(row.pretty, null);
  assert.equal(row.activationGroup, null);
  assert.equal(row.channelSets, null);
  assert.equal(row.dmx.bits, 16);
  assert.ok(result.notes.some((n: string) => /null/.test(n)));
});

test("gma3_fixture_attributes uses defaults and refuses a group or a range", async () => {
  h.fake.on("fixtureAttributes", () => ({ attributes: [], subfixtures: [], channels: [], limitations: [], source: "fixtureTypeWalk", total: 0, offset: 0, count: 0 }));
  const ok = await h.callJson("gma3_fixture_attributes", { fixture: "501.3" });
  assert.equal(ok.isError, false);
  assert.deepEqual(lastArgs("fixtureAttributes"), { ref: "Fixture 501.3", limit: 100, offset: 0, includeChannelSets: false });
  assert.equal(ok.result.source, "fixtureTypeWalk");
  h.fake.requests.length = 0;
  const bad = await h.callJson("gma3_fixture_attributes", { fixture: "Group 5" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /must be one fixture/);
  assert.equal(h.fake.requests.length, 0, "nothing sent on validation failure");
  const range = await h.callJson("gma3_fixture_attributes", { fixture: "1 Thru 5" });
  assert.equal(range.isError, true);
});

test("an op error becomes a tool error with the bridge message", async () => {
  h.fake.on("fixtureAttributes", () => {
    throw new Error("'Fixture 999' resolved to a nil, not a Fixture or SubFixture");
  });
  const res = await h.callJson("gma3_fixture_attributes", { fixture: 999 });
  assert.equal(res.isError, true);
  assert.match(res.text, /not a Fixture or SubFixture/);
});

test("an unknown op (old plugin) is explained as a re-import problem", async () => {
  // No handler registered: the fake answers "unknown op".
  const res = await h.callJson("gma3_programmer", { scope: "all" });
  assert.equal(res.isError, true);
  assert.match(res.text, /unknown op/);
  assert.match(res.text, /0\.3\.0/);
});

test("a lost reply is a tool error, and nothing is retried", async () => {
  h.fake.on("dmx", () => SILENT);
  const res = await h.callJson("gma3_dmx", { universe: 1, from: 1, to: 4 });
  assert.equal(res.isError, true);
  assert.match(res.text, /timed out|timeout/i);
  assert.equal(h.fake.requests.filter((r) => r.op === "dmx").length, 1);
});

// ---------------------------------------------------------------------------
test("gma3_programmer validates scope/fixtures combinations before sending anything", async () => {
  h.fake.on("programmer", () => ({ rows: [], coverage: { complete: true }, limitations: [] }));
  let res = await h.callJson("gma3_programmer", { scope: "fixtures" });
  assert.equal(res.isError, true);
  assert.match(res.text, /fixtures is required/);
  res = await h.callJson("gma3_programmer", { scope: "all", fixtures: "1 Thru 5" });
  assert.equal(res.isError, true);
  assert.match(res.text, /only accepted with scope/);
  res = await h.callJson("gma3_programmer", { scope: "fixtures", fixtures: "Group 3" });
  assert.equal(res.isError, true);
  assert.match(res.text, /groups are not expanded/);
  res = await h.callJson("gma3_programmer", { scope: "bogus" });
  assert.equal(res.isError, true);
  assert.equal(h.fake.requests.length, 0);
});

test("gma3_programmer forwards scope, range, budget and pagination and preserves zero values and phaser steps", async () => {
  h.fake.on("programmer", (args) => ({
    scope: args.scope, source: "programmer", coverage: { complete: true, scannedFixtures: 2, totalFixtures: 2, scannedChannels: 20 }, total: 2, offset: 0, count: 2,
    rows: [
      { fid: "1", uiChannel: 0, attribute: "Dimmer", present: true, value: 0, valueRaw: 0, masks: { activeValue: 1, activePhaser: 0, individual: 0 }, stepCount: 1, steps: [{ step: 1, absolute: 0 }], phaser: { supported: true, multiStep: false } },
      { fid: "3", uiChannel: 6, attribute: "Dimmer", present: true, masks: { activeValue: 1, activePhaser: 2, individual: 0 }, stepCount: 2, steps: [{ step: 1, absolute: 0 }, { step: 2, absolute: 100 }], phaser: { supported: true, multiStep: true, speed: 60 } },
    ],
    limitations: [],
  }));
  const { result, isError } = await h.callJson("gma3_programmer", { scope: "fixtures", fixtures: "1 + 3", max_channels: 100, limit: 10, offset: 0 });
  assert.equal(isError, false);
  assert.deepEqual(lastArgs("programmer"), { scope: "fixtures", fixtures: "Fixture 1 + 3", limit: 10, offset: 0, maxChannels: 100 });
  assert.equal(result.source, "programmer");
  assert.equal(result.coverage.complete, true);
  assert.equal(result.rows[0].value, 0, "zero is a value");
  assert.equal(result.rows[0].present, true);
  assert.equal(result.rows[0].fixture, null, "missing metadata is null");
  assert.equal(result.rows[1].value, null, "multi-step phaser is not collapsed");
  assert.equal(result.rows[1].steps.length, 2);
  assert.equal(result.rows[1].phaser.speed, 60);
  assert.ok(result.notes.some((n: string) => /not output/.test(n)));
});

test("gma3_programmer never claims an empty programmer when coverage is incomplete", async () => {
  h.fake.on("programmer", () => ({ source: "programmer", coverage: { complete: false, scannedFixtures: 0, totalFixtures: 0 }, total: 0, count: 0, rows: [], limitations: ["the patch could not be enumerated: GetSubfixtureCount unavailable"] }));
  const { result, isError } = await h.callJson("gma3_programmer", { scope: "all" });
  assert.equal(isError, false);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.rows.length, 0);
  assert.ok(result.limitations.some((l: string) => /could not be enumerated/.test(l)));
  assert.deepEqual(lastArgs("programmer"), { scope: "all", limit: 200, offset: 0, maxChannels: 5000 });
});

test("gma3_programmer adds an incompleteness limitation when the op gave none", async () => {
  h.fake.on("programmer", () => ({ source: "programmer", coverage: { complete: false }, rows: [], limitations: [] }));
  const { result } = await h.callJson("gma3_programmer", { scope: "selection" });
  assert.ok(result.limitations.some((l: string) => /coverage is incomplete/.test(l)));
});

// ---------------------------------------------------------------------------
test("gma3_fixture_output passes nonzero_only explicitly and keeps null values with their limitation", async () => {
  h.fake.on("fixtureOutput", (args) => ({
    source: "dmx output", total: 2, offset: 0, count: 2, nonzeroOnly: args.nonzeroOnly, channelsSource: "parent", metaSource: "uiChannels+fixtureTypeWalk",
    channels: [
      { rtIndex: 0, channel: "Main Module_Dimmer", universe: 1, address: 1, bits: 8, patched: true, value: 255, unit: "raw8", percent: 100, physical: 1, conversion: "linear from channel function" },
      { rtIndex: 1, channel: "Main Module_Pan", universe: 3, address: 1, bits: 16, patched: true },
    ],
    limitations: ["universe 3 not granted: GetDMXValue returned nil"],
  }));
  let res = await h.callJson("gma3_fixture_output", { fixture: "Fixture 601" });
  assert.equal(res.isError, false);
  assert.deepEqual(lastArgs("fixtureOutput"), { ref: "Fixture 601", nonzeroOnly: false, limit: 200, offset: 0 });
  assert.equal(res.result.nonzeroOnly, false);
  assert.equal(res.result.source, "dmx output");
  assert.equal(res.result.channels[0].value, 255);
  assert.equal(res.result.channels[0].conversion, "linear from channel function");
  assert.equal(res.result.channels[1].value, null, "not granted -> null, never 0");
  assert.equal(res.result.channelsSource, "parent", "RT channel origin is passed through");
  assert.equal(res.result.metaSource, "uiChannels+fixtureTypeWalk", "metadata origin is passed through");
  assert.equal(res.result.channels[1].physical, null);
  assert.deepEqual(res.result.limitations, ["universe 3 not granted: GetDMXValue returned nil"]);

  res = await h.callJson("gma3_fixture_output", { fixture: 601, nonzero_only: true, limit: 5, offset: 2 });
  assert.deepEqual(lastArgs("fixtureOutput"), { ref: "Fixture 601", nonzeroOnly: true, limit: 5, offset: 2 });
});

test("gma3_fixture_output rejects a bad reference without sending", async () => {
  const res = await h.callJson("gma3_fixture_output", { fixture: "Sequence 1" });
  assert.equal(res.isError, true);
  assert.equal(h.fake.requests.length, 0);
});

// ---------------------------------------------------------------------------
test("gma3_dmx validates universe and channel ranges before sending", async () => {
  h.fake.on("dmx", () => ({ values: [], limitations: [] }));
  const bad = async (args: Record<string, unknown>, re: RegExp) => {
    const res = await h.callJson("gma3_dmx", args);
    assert.equal(res.isError, true, JSON.stringify(args));
    assert.match(res.text, re);
  };
  await bad({ universe: 0, from: 1 }, /universe must be >= 1/);
  await bad({ universe: 1025, from: 1 }, /universe must be <= 1024/);
  await bad({ universe: 1, from: 0 }, /from must be >= 1/);
  await bad({ universe: 1, from: 1, to: 513 }, /to must be <= 512/);
  await bad({ universe: 1, from: 10, to: 5 }, /to must be >= from/);
  await bad({ universe: 1.5, from: 1 }, /validation failed/);
  await bad({ universe: 1, from: 1, unit: "raw16" }, /validation failed/);
  assert.equal(h.fake.requests.length, 0, "nothing sent for invalid input");
});

test("gma3_dmx forwards range, unit, nonzero filter and patch flag and labels units", async () => {
  h.fake.on("dmx", (args) => ({
    universe: args.universe, granted: true, from: args.from, to: args.to, unit: args.percent ? "percent" : "raw8", nonzeroOnly: args.nonzeroOnly, readVia: "GetDMXUniverse",
    count: 2, values: [{ channel: 1, value: 0 }, { channel: 2, value: 128 }], source: "dmx output", limitations: ["patch lookup not performed (set patched: true to map addresses to fixtures through the RT channels)"],
  }));
  let res = await h.callJson("gma3_dmx", { universe: 2, from: 1, to: 2 });
  assert.equal(res.isError, false);
  assert.deepEqual(lastArgs("dmx"), { universe: 2, from: 1, to: 2, nonzeroOnly: false, percent: false, patched: false });
  assert.equal(res.result.unit, "raw8");
  assert.equal(res.result.granted, true);
  assert.equal(res.result.patched, null);
  assert.equal(res.result.values[0].value, 0, "zero output is a value");
  assert.ok(res.result.limitations.some((l: string) => /patch lookup not performed/.test(l)));

  res = await h.callJson("gma3_dmx", { universe: 2, from: 7, nonzero_only: true, unit: "percent", patched: true });
  assert.deepEqual(lastArgs("dmx"), { universe: 2, from: 7, to: 7, nonzeroOnly: true, percent: true, patched: true });
  assert.equal(res.result.unit, "percent");
  assert.ok(res.result.notes.some((n: string) => /percent 0\.\.100/.test(n)));
});

test("gma3_dmx reports a universe that is not granted without inventing zeros", async () => {
  h.fake.on("dmx", () => ({ universe: 1, granted: false, from: 1, to: 8, unit: "raw8", count: 0, values: [], source: "dmx output", limitations: ["universe 1 not granted: the console returned nil for every address (DmxUniverse Granted = false)"] }));
  const { result } = await h.callJson("gma3_dmx", { universe: 1, from: 1, to: 8 });
  assert.equal(result.granted, false);
  assert.deepEqual(result.values, []);
  assert.match(result.limitations[0], /not granted/);
});

// ---------------------------------------------------------------------------
test("gma3_cue_contents validates sequence, cue and part", async () => {
  h.fake.on("cueContents", () => ({ cue: {}, parts: [], limitations: [] }));
  let res = await h.callJson("gma3_cue_contents", { sequence: 0, cue: 1 });
  assert.equal(res.isError, true);
  assert.match(res.text, /sequence must be >= 1/);
  res = await h.callJson("gma3_cue_contents", { sequence: 1, cue: "abc" });
  assert.equal(res.isError, true);
  assert.match(res.text, /cue number like/);
  res = await h.callJson("gma3_cue_contents", { sequence: 1, cue: 1, part: -1 });
  assert.equal(res.isError, true);
  assert.match(res.text, /part must be >= 0/);
  res = await h.callJson("gma3_cue_contents", { sequence: 1, cue: 1, fixtures: "Group 1" });
  assert.equal(res.isError, true);
  assert.equal(h.fake.requests.length, 0);
});

test("gma3_cue_contents forwards the target and marks unavailable data explicitly", async () => {
  h.fake.on("cueContents", () => ({
    ref: "Sequence 900 Cue 2.5", source: "cue object tree (recipes and preset references only)", trackedValues: "not_reconstructed", expandPresets: false,
    cue: { no: "2.5", name: "Look", trigType: "Go", trigTime: "0.00" },
    parts: [
      { part: 0, name: "0 'Look'", timing: { cueFade: "3.00" }, command: {}, mib: {}, ownDataPresent: true, recipes: [{ index: 1, selection: "1 'All'", preset: "4 'Color'.1 'Red'", presetResolved: true, presetRef: { name: "Red" } }, { index: 2, preset: "4 'Color'.99", presetResolved: false }], otherChildren: [] },
    ],
    limitations: ["hard (non-recipe) fixture values stored in a cue part are not exposed by the 2.5.1 Lua API (no GetCueData); only recipe and preset references are readable"],
  }));
  const { result, isError } = await h.callJson("gma3_cue_contents", { sequence: 900, cue: 2.5 });
  assert.equal(isError, false);
  assert.deepEqual(lastArgs("cueContents"), { sequence: 900, cue: "2.5", expandPresets: false });
  assert.equal(result.cue.no, "2.5");
  assert.equal(result.cue.trigSound, null);
  assert.equal(result.cue.note, null);
  const part = result.parts[0];
  assert.equal(part.ownDataPresent, true);
  assert.equal(part.storedValues, null);
  assert.equal(part.timing.cueFade, "3.00");
  assert.equal(part.timing.cueOutFade, null);
  assert.equal(part.command.text, null);
  assert.equal(part.recipes[0].presetResolved, true);
  assert.equal(part.recipes[1].presetResolved, false);
  assert.equal(part.recipes[1].presetRef, null);
  assert.equal(result.presets, null, "presets not expanded");
  assert.equal(result.trackedValues, "not_reconstructed");
  assert.match(result.limitations[0], /hard \(non-recipe\)/);
  assert.match(result.supportedMode, /recipes and preset references/);
});

test("gma3_cue_contents forwards part, fixtures and expand_presets and keeps the preset data", async () => {
  h.fake.on("cueContents", (args) => ({ cue: {}, parts: [{ part: 1 }], expandPresets: args.expandPresets, presets: { "ShowData.X": { available: true, rows: [{ fid: "2", step: 1, absolute: 100 }] } }, limitations: ["fixtures filter applied to expanded preset data (by_fixtures) only; recipe selections (groups/ranges) were not expanded"] }));
  const { result } = await h.callJson("gma3_cue_contents", { sequence: "Main", cue: "10.001", part: 1, fixtures: "1 Thru 5", expand_presets: true });
  assert.deepEqual(lastArgs("cueContents"), { sequence: "Main", cue: "10.001", part: 1, fixtures: "Fixture 1 Thru 5", expandPresets: true });
  assert.equal(result.presets["ShowData.X"].rows[0].absolute, 100);
  assert.deepEqual(result.target, { sequence: "Main", cue: "10.001", part: 1, fixtures: "Fixture 1 Thru 5" });
  assert.match(result.limitations[0], /fixtures filter applied/);
});

test("gma3_cue_contents treats a numeric string sequence as a number", async () => {
  h.fake.on("cueContents", () => ({ cue: {}, parts: [], limitations: [] }));
  await h.callJson("gma3_cue_contents", { sequence: "12", cue: 1 });
  assert.equal(lastArgs("cueContents")?.sequence, 12);
});

test("inspection tools never send commands or take the mutation lock", async () => {
  h.fake.on("*", () => ({ rows: [], values: [], channels: [], attributes: [], parts: [], cue: {}, limitations: [] }));
  await h.callJson("gma3_fixture_attributes", { fixture: 1 });
  await h.callJson("gma3_programmer", { scope: "all" });
  await h.callJson("gma3_fixture_output", { fixture: 1 });
  await h.callJson("gma3_dmx", { universe: 1, from: 1 });
  await h.callJson("gma3_cue_contents", { sequence: 1, cue: 1 });
  assert.deepEqual(h.fake.commands, []);
  assert.deepEqual(
    h.fake.requests.map((r) => r.op),
    ["fixtureAttributes", "programmer", "fixtureOutput", "dmx", "cueContents"],
  );
  assert.equal(h.ctx.mutations.busy, false);
});
