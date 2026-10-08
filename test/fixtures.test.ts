import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { registerFixtureTools, attributeCommand, formatValue } from "../src/tools/fixtures.ts";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { SILENT } from "./helpers/fake-bridge.ts";

/**
 * FR-03: fixture programming tools against the FakeBridge.
 *
 * The fake scripts three ops: `cmd` (console feedback per command), `objects` (target resolution,
 * Selection counts, attribute definitions) and `children` (selected members).
 */

let h: Harness;

before(async () => {
  h = await startHarness(registerFixtureTools);
});
after(async () => {
  await h.close();
});

interface ConsoleState {
  /** Selection.CountTotalSelected returned by `objects` on "Selection". */
  selectionCount: number;
  /** Fixture IDs returned as selected members. */
  selected: string[];
  /** Total returned for a fixture/group range (0 = nothing matches). */
  rangeTotal: number;
  /** Attribute names the show knows. */
  attributes: string[];
  /** Programmer rows returned for scope "selection" (undefined = the plugin has no programmer op). */
  programmer?: FakeProgrammer;
  /** Attributes per fixture id for the fixtureAttributes op (undefined = op unknown). */
  fixtureAttributes?: Record<string, string[]>;
}

interface FakeRow {
  fixture: string;
  fid: string | null;
  subfixtureIndex: number;
  attribute: string;
  value?: number;
  stepCount?: number;
  physicalFrom?: number | null;
  physicalTo?: number | null;
  readout?: string | null;
  physicalUnit?: string | null;
}
interface FakeScanned {
  subfixtureIndex: number;
  fid: string | null;
  name: string;
  rootFid?: string | null;
  /** Attributes the (sub)fixture has; defaults to the attributes of its rows. `null` = omit (old plugin). */
  attributes?: string[] | null;
}
interface FakeProgrammer {
  scanned: FakeScanned[];
  rows: FakeRow[];
  complete?: boolean;
  /** Pretend the op reports more rows than it returns (pagination). */
  pageSize?: number;
  /** Rows returned for a follow-up scope "fixtures" scan, keyed by "Fixture <fid>". */
  byFixture?: Record<string, { scanned: FakeScanned[]; rows: FakeRow[]; complete?: boolean; pageSize?: number }>;
}

/** A single-step static row with the metadata the real op emits. */
const row = (fid: string, sf: number, attribute: string, value: number, meta: Partial<FakeRow> = {}): FakeRow => ({
  fixture: `Fx ${fid}`,
  fid,
  subfixtureIndex: sf,
  attribute,
  value,
  stepCount: 1,
  physicalFrom: attribute === "Pan" ? -225 : attribute === "Tilt" ? -135 : 0,
  physicalTo: attribute === "Pan" ? 225 : attribute === "Tilt" ? 135 : 1,
  readout: attribute === "Pan" || attribute === "Tilt" ? "Physical" : "Percent",
  physicalUnit: attribute === "Pan" || attribute === "Tilt" ? "Angle" : "LuminousIntensity",
  ...meta,
});

function script(state: Partial<ConsoleState> = {}, feedback: (command: string) => string | typeof SILENT = () => "OK") {
  const st: ConsoleState = { selectionCount: 0, selected: [], rangeTotal: 5, attributes: ["Dimmer", "Pan", "Tilt", "ColorRGB_R", "ColorRGB_G", "ColorRGB_B"], ...state };
  h.fake.reset();
  h.fake.onCommand(feedback);
  h.fake.on("objects", (args) => {
    const ref = String(args.ref);
    if (ref === "Selection") {
      return { total: 1, offset: 0, count: 1, items: [{ name: "Selection", class: "Selection", fields: { CountTotalSelected: String(st.selectionCount), CountFullySelected: String(st.selectionCount) } }] };
    }
    const attr = ref.match(/^Attribute "(.+)"$/);
    if (attr) {
      if (!st.attributes.includes(attr[1])) throw new Error(`no object found for '${ref}'`);
      return { total: 1, offset: 0, count: 1, items: [{ name: attr[1], class: "Attribute" }] };
    }
    if (st.rangeTotal < 1) throw new Error(`no objects found for '${ref}'`);
    return { total: st.rangeTotal, offset: 0, count: 1, items: [{ name: "Fixture", class: "Fixture" }] };
  });
  h.fake.on("children", (args) => {
    assert.equal(args.ref, "Selection");
    return { total: st.selected.length, offset: 0, count: st.selected.length, items: st.selected.map((n) => ({ name: n, class: "Fixture" })) };
  });
  if (st.programmer) {
    const prog = st.programmer;
    const withAttributes = (e: FakeScanned, rows: FakeRow[]) => {
      if (e.attributes === null) {
        const { attributes: _omit, ...rest } = e;
        return rest;
      }
      return { ...e, attributes: e.attributes ?? [...new Set(rows.filter((r) => r.subfixtureIndex === e.subfixtureIndex).map((r) => r.attribute))] };
    };
    const page = (p: { scanned: FakeScanned[]; rows: FakeRow[]; complete?: boolean; pageSize?: number }, args: Record<string, unknown>) => {
      const offset = Number(args.offset ?? 0);
      const limit = Math.min(Number(args.limit ?? 5000), p.pageSize ?? 5000);
      const slice = p.rows.slice(offset, offset + limit);
      return {
        scope: "selection",
        source: "programmer",
        coverage: { complete: p.complete !== false, scannedFixtures: p.scanned.length, totalFixtures: p.scanned.length, scannedChannels: p.rows.length },
        scannedFixtures: p.scanned.map((e) => withAttributes(e, p.rows)),
        fixturesTruncated: false,
        total: p.rows.length,
        count: slice.length,
        offset,
        rows: slice,
        limitations: p.complete === false ? ["channel budget (5000) reached"] : [],
      };
    };
    h.fake.on("programmer", (args) => {
      if (args.scope === "fixtures") {
        const sub = prog.byFixture?.[String(args.fixtures)];
        if (!sub) return page({ scanned: [], rows: [] }, args);
        return { ...page(sub, args), scope: "fixtures" };
      }
      assert.equal(args.scope, "selection");
      return page(prog, args);
    });
  }
  if (st.fixtureAttributes) {
    const fa = st.fixtureAttributes;
    h.fake.on("fixtureAttributes", (args) => {
      const m = String(args.ref).match(/^Fixture (\S+)$/);
      const names = m ? fa[m[1]] : undefined;
      if (!names) throw new Error(`no object found for '${args.ref}'`);
      // "<fid>.<n>" keys describe cells; the parent reports how many cells it has.
      const cells = (st as ConsoleState & { cellCounts?: Record<string, number> }).cellCounts?.[m![1]] ?? Object.keys(fa).filter((k) => k.startsWith(`${m![1]}.`)).length;
      const total = (st as ConsoleState & { attributeTotals?: Record<string, number> }).attributeTotals?.[m![1]] ?? names.length;
      return { name: `Fx ${m![1]}`, fid: m![1], fixtureType: `Type of ${m![1]}`, total, count: names.length, offset: 0, subfixtureCount: cells, attributes: names.map((a) => ({ attribute: a })), limitations: [] };
    });
  }
  return st;
}

/** objects handler variant that resolves a range to real fixture items with FIDs. */
function resolveTo(st: ConsoleState, fixtures: Array<{ fid: string; name?: string; fixtureType?: string }>) {
  const prev = h.fake.handlerFor("objects")!;
  st.rangeTotal = fixtures.length;
  h.fake.on("objects", (args, req) => {
    const ref = String(args.ref);
    if (ref === "Selection" || /^Attribute "/.test(ref)) return prev(args, req);
    return {
      total: fixtures.length,
      offset: 0,
      count: Math.min(fixtures.length, Number(args.limit ?? 50)),
      items: fixtures.slice(0, Number(args.limit ?? 50)).map((f) => ({ name: f.name ?? `Fx ${f.fid}`, class: "Fixture", fields: { FID: f.fid, Name: f.name ?? `Fx ${f.fid}`, FixtureType: f.fixtureType ?? `Type of ${f.fid}` } })),
    };
  });
}

beforeEach(() => script());

const clearCommands = (cmds: string[]) => cmds.filter((c) => /^Clear/i.test(c));

// ---------------------------------------------------------------------------
// gma3_select
// ---------------------------------------------------------------------------

test("select: a bare range becomes a Fixture command and the selection count is read back", async () => {
  const st = script({ selected: ["Fixture 1", "Fixture 2", "Fixture 3", "Fixture 4", "Fixture 5"] });
  h.fake.on("cmd", (args) => {
    st.selectionCount = 5;
    return { command: args.command, feedback: "OK" };
  });
  const { result, isError } = await h.callJson("gma3_select", { fixtures: "1 Thru 5" });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.outcome, "succeeded");
  assert.deepEqual(h.fake.commands, ["Fixture 1 Thru 5"]);
  assert.equal(result.verification.status, "matched");
  assert.equal(result.selectionCount, 5);
  assert.deepEqual(result.selected, ["Fixture 1", "Fixture 2", "Fixture 3", "Fixture 4", "Fixture 5"]);
  assert.equal(result.selectionChanged, true);
  assert.equal(result.programmerValuesChanged, false);
  assert.deepEqual(
    result.steps.map((s: { name: string; status: string }) => [s.name, s.status]),
    [
      ["resolve_target", "succeeded"],
      ["select", "succeeded"],
      ["read_selection", "succeeded"],
      ["read_selected", "succeeded"],
    ],
  );
  assert.ok(result.warnings.some((w: string) => /added to the existing selection/.test(w)));
  assert.ok(result.warnings.some((w: string) => /another console operator/.test(w)));
});

test("select: group references are normalised and sent as Group <n>", async () => {
  script({ selectionCount: 12 });
  const { result } = await h.callJson("gma3_select", { fixtures: "group 7" });
  assert.equal(result.outcome, "succeeded");
  assert.deepEqual(h.fake.commands, ["Group 7"]);
  assert.equal(result.target.fixtures, "Group 7");
});

test("select: clear_first sends ClearSelection before the selection, nothing else does", async () => {
  script({ selectionCount: 3 });
  const { result } = await h.callJson("gma3_select", { fixtures: "Fixture 1 + 3 + 5", clear_first: true });
  assert.equal(result.outcome, "succeeded");
  assert.deepEqual(h.fake.commands, ["ClearSelection", "Fixture 1 + 3 + 5"]);
  script({ selectionCount: 3 });
  await h.callJson("gma3_select", { fixtures: "Fixture 1 + 3 + 5" });
  assert.deepEqual(clearCommands(h.fake.commands), []);
});

test("select: quotes, names and other unsupported tokens are refused before anything is sent", async () => {
  for (const bad of ['Group "Front Wash"', "Fixture 1; ClearAll", "Fixture 1 Thru 5 At 100", "Preset 4.1"]) {
    const { result, isError } = await h.callJson("gma3_select", { fixtures: bad });
    assert.equal(isError, true);
    assert.equal(result.outcome, "failed");
    assert.ok(result.validationErrors.length > 0, bad);
    assert.deepEqual(h.fake.commands, [], bad);
  }
});

test("select: a range that resolves to nothing fails without sending a command", async () => {
  script({ rangeTotal: 0 });
  const { result, isError } = await h.callJson("gma3_select", { fixtures: "900 Thru 950" });
  assert.equal(isError, true);
  assert.equal(result.outcome, "failed");
  assert.equal(result.steps[0].name, "resolve_target");
  assert.match(result.steps[0].error, /no objects match/);
  assert.equal(result.steps[1].status, "skipped");
  assert.deepEqual(h.fake.commands, []);
});

test("select: a select that leaves nothing selected is a verification mismatch", async () => {
  script({ selectionCount: 0 });
  const { result, isError } = await h.callJson("gma3_select", { fixtures: "1 Thru 5" });
  assert.equal(isError, true);
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.verification.status, "mismatched");
});

test("select: a lost reply is an unknown outcome and is not retried", async () => {
  script({}, () => SILENT);
  const { result, isError } = await h.callJson("gma3_select", { fixtures: "1 Thru 5" });
  assert.equal(isError, true);
  assert.equal(result.outcome, "unknown");
  assert.deepEqual(h.fake.commands, ["Fixture 1 Thru 5"]);
  assert.equal(result.verification.status, "not_requested");
});

// ---------------------------------------------------------------------------
// gma3_set_attribute
// ---------------------------------------------------------------------------

test("set_attribute: explicit fixtures are selected first, then the documented Attribute ... At Absolute command", async () => {
  const { result, isError } = await h.callJson("gma3_set_attribute", { fixtures: "1 Thru 5", attribute: "Dimmer", value: 75, unit: "percent" });
  assert.equal(isError, false, "a succeeded outcome with unavailable verification is not an MCP error");
  assert.equal(result.outcome, "succeeded");
  assert.deepEqual(h.fake.commands, ["ClearSelection", "Fixture 1 Thru 5", 'Attribute "Dimmer" At Absolute Percent 75']);
  assert.equal(result.verification.status, "unavailable");
  assert.match(result.verification.detail, /predates the programmer op/, "without the programmer op on the plugin, values cannot be verified");
  assert.equal(result.selectionChanged, true);
  assert.equal(result.programmerValuesChanged, true);
  assert.deepEqual(result.target, { fixtures: "Fixture 1 Thru 5", attribute: "Dimmer", value: 75, unit: "percent" });
  assert.equal(result.steps[0].name, "check_attribute");
  assert.equal(result.steps[0].op, "objects");
});

test("set_attribute: use_selection sends only the attribute command and does not touch the selection", async () => {
  script({ selectionCount: 4 });
  const { result } = await h.callJson("gma3_set_attribute", { use_selection: true, attribute: "Pan", value: -45.5, unit: "physical" });
  assert.equal(result.outcome, "succeeded");
  assert.deepEqual(h.fake.commands, ['Attribute "Pan" At Absolute Physical -45.5']);
  assert.equal(result.selectionChanged, false);
  assert.deepEqual(result.target, { selection: "current", attribute: "Pan", value: -45.5, unit: "physical" });
});

test("set_attribute: use_selection with nothing selected fails before sending", async () => {
  script({ selectionCount: 0 });
  const { result, isError } = await h.callJson("gma3_set_attribute", { use_selection: true, attribute: "Dimmer", value: 50 });
  assert.equal(isError, true);
  assert.equal(result.outcome, "failed");
  assert.match(result.summary, /nothing is selected/);
  assert.deepEqual(h.fake.commands, []);
});

test("set_attribute: fixtures and use_selection are mutually exclusive and one is required", async () => {
  let r = await h.callJson("gma3_set_attribute", { fixtures: "1", use_selection: true, attribute: "Dimmer", value: 50 });
  assert.equal(r.result.outcome, "failed");
  assert.match(r.result.validationErrors.join(), /mutually exclusive/);
  r = await h.callJson("gma3_set_attribute", { attribute: "Dimmer", value: 50 });
  assert.match(r.result.validationErrors.join(), /one of fixtures, use_selection is required/);
  r = await h.callJson("gma3_set_attribute", { use_selection: true, add_to_selection: true, attribute: "Dimmer", value: 50 });
  assert.match(r.result.validationErrors.join(), /add_to_selection only applies/);
  assert.deepEqual(h.fake.commands, []);
});

test("set_attribute: an explicit fixtures target replaces the selection (ClearSelection first) by default", async () => {
  const { result } = await h.callJson("gma3_set_attribute", { fixtures: "Group 2", attribute: "Dimmer", value: 100, unit: "percent" });
  assert.deepEqual(h.fake.commands, ["ClearSelection", "Group 2", 'Attribute "Dimmer" At Absolute Percent 100']);
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.selectionChanged, true);
  assert.ok(!result.warnings.some((w: string) => /added to the current selection/.test(w)));
});

test("set_attribute: add_to_selection keeps the existing selection, skips ClearSelection and warns", async () => {
  const { result } = await h.callJson("gma3_set_attribute", { fixtures: "2", attribute: "Dimmer", value: 100, unit: "percent", add_to_selection: true });
  assert.deepEqual(h.fake.commands, ["Fixture 2", 'Attribute "Dimmer" At Absolute Percent 100']);
  assert.equal(result.target.addToSelection, true);
  assert.ok(result.warnings.some((w: string) => /add_to_selection: Fixture 2 was added to the current selection/.test(w)));
});

test("set_attribute: without a unit the console readout applies and a warning says so", async () => {
  const { result } = await h.callJson("gma3_set_attribute", { fixtures: "1", attribute: "Zoom", value: 0, unit: undefined });
  script({ attributes: ["Zoom"] });
  const r2 = await h.callJson("gma3_set_attribute", { fixtures: "1", attribute: "Zoom", value: 0 });
  assert.deepEqual(h.fake.commands, ["ClearSelection", "Fixture 1", 'Attribute "Zoom" At Absolute 0']);
  assert.equal(r2.result.target.unit, "readout");
  assert.ok(r2.result.warnings.some((w: string) => /readout/.test(w)));
  assert.equal(result.outcome, "failed", "Zoom was not a known attribute in the first script");
});

test("set_attribute: invalid values and names are refused before anything is sent", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ fixtures: "1", attribute: "Dimmer", value: Number.NaN }, /validation|finite|nan/i],
    [{ fixtures: "1", attribute: "Dimmer", value: Number.POSITIVE_INFINITY }, /validation|finite|infinity/i],
    [{ fixtures: "1", attribute: "Dimmer", value: -1, unit: "percent" }, />= 0/],
    [{ fixtures: "1", attribute: "Dimmer", value: 101, unit: "percent" }, /<= 100/],
    [{ fixtures: "1", attribute: "Dimmer", value: 300, unit: "decimal8" }, /<= 255/],
    [{ fixtures: "1", attribute: "Dimmer", value: 12.5, unit: "decimal8" }, /integer/],
    [{ fixtures: "1", attribute: "Dimmer", value: -5 }, /negative/],
    [{ fixtures: "1", attribute: 'Pan" At 100; ClearAll', value: 50 }, /attribute name/],
    [{ fixtures: "1", attribute: "Color RGB R", value: 50 }, /attribute name/],
    [{ fixtures: "1", attribute: "", value: 50 }, /required/],
    [{ fixtures: "1", attribute: "Dimmer", value: 50, unit: "furlongs" }, /validation|unit/i],
    [{ fixtures: "1", attribute: "Dimmer", value: "50" }, /validation/i],
  ];
  for (const [args, re] of cases) {
    const { text, isError } = await h.callJson("gma3_set_attribute", args);
    assert.equal(isError, true, JSON.stringify(args));
    assert.match(text, re, JSON.stringify(args));
    assert.deepEqual(h.fake.commands, [], JSON.stringify(args));
  }
});

test("set_attribute: an attribute the show does not define fails before sending", async () => {
  const { result, isError } = await h.callJson("gma3_set_attribute", { fixtures: "1 Thru 5", attribute: "ColorAdd_R", value: 50, unit: "percent" });
  assert.equal(isError, true);
  assert.equal(result.outcome, "failed");
  assert.equal(result.steps[0].name, "check_attribute");
  assert.match(result.steps[0].error, /not defined in this show/);
  assert.deepEqual(h.fake.commands, []);
});

test("set_attribute: a console refusal of the attribute command is a partial result after a successful select", async () => {
  script({}, (c) => (c.startsWith("Attribute") ? "Illegal Command" : "OK"));
  const { result, isError } = await h.callJson("gma3_set_attribute", { fixtures: "1 Thru 5", attribute: "Pan", value: 50, unit: "percent" });
  assert.equal(isError, true);
  assert.equal(result.outcome, "partial");
  assert.equal(result.selectionChanged, true);
  assert.equal(result.programmerValuesChanged, false);
  const set = result.steps.find((s: { name: string }) => s.name === "set_attribute");
  assert.equal(set.status, "failed");
  assert.equal(set.feedback, "Illegal Command");
});

test("set_attribute: a console refusal with use_selection is a plain failure (nothing was changed)", async () => {
  script({ selectionCount: 2 }, () => "Illegal Command");
  const { result } = await h.callJson("gma3_set_attribute", { use_selection: true, attribute: "Pan", value: 50, unit: "percent" });
  assert.equal(result.outcome, "failed");
  assert.equal(result.programmerValuesChanged, false);
});

test("set_attribute: unfamiliar feedback and lost replies are unknown, never success", async () => {
  script({ selectionCount: 2 }, () => "Hmm, maybe");
  let r = await h.callJson("gma3_set_attribute", { use_selection: true, attribute: "Pan", value: 50, unit: "percent" });
  assert.equal(r.result.outcome, "unknown");
  script({ selectionCount: 2 }, () => SILENT);
  r = await h.callJson("gma3_set_attribute", { use_selection: true, attribute: "Pan", value: 50, unit: "percent" });
  assert.equal(r.result.outcome, "unknown");
  assert.equal(h.fake.commands.length, 1, "not retried");
});

// ---------------------------------------------------------------------------
// gma3_set_color
// ---------------------------------------------------------------------------

test("set_color: three ColorRGB commands in R, G, B order with explicit Percent", async () => {
  const { result } = await h.callJson("gma3_set_color", { fixtures: "1 Thru 5", red: 100, green: 0, blue: 12.5 });
  assert.equal(result.outcome, "succeeded");
  assert.deepEqual(h.fake.commands, [
    "ClearSelection",
    "Fixture 1 Thru 5",
    'Attribute "ColorRGB_R" At Absolute Percent 100',
    'Attribute "ColorRGB_G" At Absolute Percent 0',
    'Attribute "ColorRGB_B" At Absolute Percent 12.5',
  ]);
  assert.equal(result.verification.status, "unavailable");
  assert.deepEqual(result.attributes, ["ColorRGB_R", "ColorRGB_G", "ColorRGB_B"]);
  assert.deepEqual(clearCommands(h.fake.commands), ["ClearSelection"], "only the selection is cleared, never the programmer");
});

test("set_color: zero is a value and out-of-range or non-finite components are refused", async () => {
  script({ selectionCount: 1 });
  await h.callJson("gma3_set_color", { use_selection: true, red: 0, green: 0, blue: 0 });
  assert.equal(h.fake.commands.length, 3);
  for (const bad of [
    { red: -1, green: 0, blue: 0 },
    { red: 0, green: 100.1, blue: 0 },
    { red: 0, green: 0, blue: Number.NaN },
    { red: 0, green: 0 },
  ]) {
    script({ selectionCount: 1 });
    const { isError } = await h.callJson("gma3_set_color", { use_selection: true, ...bad });
    assert.equal(isError, true, JSON.stringify(bad));
    assert.deepEqual(h.fake.commands, [], JSON.stringify(bad));
  }
});

test("set_color: a failure between steps stops the sequence and reports the rest as skipped", async () => {
  script({ selectionCount: 1 }, (c) => (c.includes("ColorRGB_G") ? "Illegal Command" : "OK"));
  const { result, isError } = await h.callJson("gma3_set_color", { use_selection: true, red: 50, green: 50, blue: 50 });
  assert.equal(isError, true);
  assert.equal(result.outcome, "partial");
  assert.deepEqual(h.fake.commands, ['Attribute "ColorRGB_R" At Absolute Percent 50', 'Attribute "ColorRGB_G" At Absolute Percent 50']);
  const byName = Object.fromEntries(result.steps.map((s: { name: string; status: string }) => [s.name, s.status]));
  assert.equal(byName.set_red, "succeeded");
  assert.equal(byName.set_green, "failed");
  assert.equal(byName.set_blue, "skipped");
  assert.match(result.summary, /not attempted: set_blue/);
  assert.equal(result.programmerValuesChanged, true);
});

test("set_color: on a plugin without the programmer op, an accepted command is not claimed as verified", async () => {
  script({ selectionCount: 1 });
  const { result } = await h.callJson("gma3_set_color", { use_selection: true, red: 10, green: 20, blue: 30 });
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.verification.status, "unavailable");
  assert.match(result.summary, /read-back unavailable/);
  assert.match(result.verification.detail, /predates the programmer op/);
});

// ---------------------------------------------------------------------------
// gma3_set_position
// ---------------------------------------------------------------------------

test("set_position: degrees use Physical, percent uses Percent, pan before tilt", async () => {
  let r = await h.callJson("gma3_set_position", { fixtures: "Group 1", pan: -90, tilt: 45.25, unit: "degrees" });
  assert.equal(r.result.outcome, "succeeded");
  assert.deepEqual(h.fake.commands, ["ClearSelection", "Group 1", 'Attribute "Pan" At Absolute Physical -90', 'Attribute "Tilt" At Absolute Physical 45.25']);
  assert.equal(r.result.valueType, "Physical");
  script({ selectionCount: 2 });
  r = await h.callJson("gma3_set_position", { use_selection: true, tilt: 0, unit: "percent" });
  assert.deepEqual(h.fake.commands, ['Attribute "Tilt" At Absolute Percent 0']);
  assert.equal(r.result.target.pan, undefined);
  assert.equal(r.result.target.tilt, 0);
  assert.equal(r.result.verification.status, "unavailable");
});

test("set_position: units are mandatory, at least one axis is required, and percent must be 0..100", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ fixtures: "1", pan: 10 }, /validation|unit/i],
    [{ fixtures: "1", unit: "degrees" }, /at least one of pan, tilt/],
    [{ fixtures: "1", pan: -5, unit: "percent" }, />= 0/],
    [{ fixtures: "1", tilt: 150, unit: "percent" }, /<= 100/],
    [{ fixtures: "1", pan: 1000, unit: "degrees" }, /<= 720/],
    [{ fixtures: "1", pan: 10, unit: "radians" }, /validation|unit/i],
    [{ fixtures: "1", use_selection: true, pan: 10, unit: "degrees" }, /mutually exclusive/],
  ];
  for (const [args, re] of cases) {
    const { text, isError } = await h.callJson("gma3_set_position", args);
    assert.equal(isError, true, JSON.stringify(args));
    assert.match(text, re, JSON.stringify(args));
    assert.deepEqual(h.fake.commands, [], JSON.stringify(args));
  }
});

test("set_position: tilt rejected after pan accepted is partial with tilt failed", async () => {
  script({ selectionCount: 1 }, (c) => (c.includes("Tilt") ? "Illegal Command" : "OK"));
  const { result } = await h.callJson("gma3_set_position", { use_selection: true, pan: 10, tilt: 20, unit: "degrees" });
  assert.equal(result.outcome, "partial");
  assert.equal(result.steps.find((s: { name: string }) => s.name === "set_tilt").status, "failed");
});

// ---------------------------------------------------------------------------
// gma3_clear_programmer
// ---------------------------------------------------------------------------

test("clear_programmer: each mode maps to exactly one documented command", async () => {
  for (const [mode, command] of [
    ["selection", "ClearSelection"],
    ["active", "ClearActive"],
    ["all", "ClearAll"],
  ] as const) {
    script({ selectionCount: 0 });
    const { result } = await h.callJson("gma3_clear_programmer", { mode });
    assert.deepEqual(h.fake.commands, [command], mode);
    assert.equal(result.outcome, "succeeded", mode);
    assert.equal(result.target.command, command);
  }
});

test("clear_programmer: selection/all verify the selection count, active cannot be verified", async () => {
  script({ selectionCount: 0 });
  let r = await h.callJson("gma3_clear_programmer", { mode: "all" });
  assert.equal(r.result.verification.status, "matched");
  assert.equal(r.isError, false);
  assert.equal(r.result.programmerValuesChanged, true);
  assert.equal(r.result.selectionChanged, true);
  script({ selectionCount: 2 });
  r = await h.callJson("gma3_clear_programmer", { mode: "selection" });
  assert.equal(r.result.verification.status, "mismatched");
  assert.equal(r.isError, true);
  assert.equal(r.result.programmerValuesChanged, false);
  script({ selectionCount: 2 });
  r = await h.callJson("gma3_clear_programmer", { mode: "active" });
  assert.equal(r.result.verification.status, "unavailable");
  assert.equal(r.result.selectionChanged, false);
  assert.equal(r.result.programmerValuesChanged, true);
});

test("clear_programmer: mode is required and must be one of the three", async () => {
  for (const args of [{}, { mode: "everything" }, { mode: "" }]) {
    const { isError } = await h.callJson("gma3_clear_programmer", args);
    assert.equal(isError, true);
  }
  assert.deepEqual(h.fake.commands, []);
});

test("clear_programmer: a rejected clear reports failure and does not verify", async () => {
  script({ selectionCount: 2 }, () => "Illegal Command");
  const { result } = await h.callJson("gma3_clear_programmer", { mode: "all" });
  assert.equal(result.outcome, "failed");
  assert.equal(result.verification.status, "not_requested");
  assert.equal(result.selectionChanged, false);
});

// ---------------------------------------------------------------------------
// Programmer read-back (FR-08 feeding FR-03) and fixture-type pre-check (FR-07)
// ---------------------------------------------------------------------------

const twoFixtures = { scanned: [{ subfixtureIndex: 11, fid: "1", name: "Fx 1" }, { subfixtureIndex: 12, fid: "2", name: "Fx 2" }] };

test("read-back: percent values on every selected fixture match within tolerance", async () => {
  script({ selectionCount: 2, programmer: { ...twoFixtures, rows: [row("1", 11, "Dimmer", 50), row("2", 12, "Dimmer", 50.39)] } });
  const { result, isError } = await h.callJson("gma3_set_attribute", { use_selection: true, attribute: "Dimmer", value: 50, unit: "percent" });
  assert.equal(isError, false, result.summary);
  assert.equal(result.verification.status, "matched");
  assert.match(result.verification.checked, /Dimmer = 50 percent/);
  assert.deepEqual(result.programmerReadBack, { performed: true, fixturesChecked: 2, cellsJudged: 2, rowsChecked: 2, followUpScans: 0, tolerancePercentOfRange: 0.5 });
  const readBack = result.steps.find((s: any) => s.name === "read_programmer");
  assert.equal(readBack.kind, "read");
  assert.equal(h.fake.requests.filter((r) => r.op === "programmer").length, 1);
  // The read-back runs inside the same lock span as the command.
  assert.ok(h.fake.requests.findIndex((r) => r.op === "programmer") > h.fake.requests.findIndex((r) => r.op === "cmd"));
});

test("read-back: a wrong value is a mismatch that names the fixture, the reading and the expectation", async () => {
  script({ selectionCount: 2, programmer: { ...twoFixtures, rows: [row("1", 11, "Dimmer", 50), row("2", 12, "Dimmer", 80)] } });
  const { result, isError } = await h.callJson("gma3_set_attribute", { use_selection: true, attribute: "Dimmer", value: 50, unit: "percent" });
  assert.equal(isError, true);
  assert.equal(result.outcome, "succeeded", "the command itself was accepted");
  assert.equal(result.verification.status, "mismatched");
  assert.match(result.verification.detail, /Fx 2 \(Fixture 2\): Dimmer reads 80 % of range = 0.8 LuminousIntensity, expected 50 % \(50 percent\)/);
  assert.doesNotMatch(result.verification.detail, /Fx 1/);
});

test("read-back: a fixture without the attribute has no row and is reported, not claimed", async () => {
  script({ selectionCount: 2, programmer: { ...twoFixtures, rows: [row("2", 12, "ColorRGB_R", 30), row("2", 12, "ColorRGB_G", 0), row("2", 12, "ColorRGB_B", 0)] } });
  const { result, isError } = await h.callJson("gma3_set_color", { use_selection: true, red: 30, green: 0, blue: 0 });
  assert.equal(isError, true);
  assert.equal(result.verification.status, "mismatched");
  assert.match(result.verification.detail, /Fx 1 \(Fixture 1\): no \(sub\)fixture of it has attribute ColorRGB_R/);
  // The follow-up scan of Fixture 1 was attempted (it could be compound) and found no cell with RGB either.
  assert.equal(result.programmerReadBack.followUpScans, 1);
});

test("read-back: degrees are converted through each fixture's physical range", async () => {
  // Pan -225..225: 10 deg = 52.22 %. Tilt -135..135: 20 deg = 57.41 %.
  script({ selectionCount: 1, programmer: { scanned: [twoFixtures.scanned[0]], rows: [row("1", 11, "Pan", 52.2222), row("1", 11, "Tilt", 57.4074)] } });
  let r = await h.callJson("gma3_set_position", { use_selection: true, pan: 10, tilt: 20, unit: "degrees" });
  assert.equal(r.result.verification.status, "matched", r.result.verification.detail);
  // A fixture with a different pan range reads a different percentage for the same angle: mismatch is explained in degrees.
  script({ selectionCount: 1, programmer: { scanned: [twoFixtures.scanned[0]], rows: [row("1", 11, "Pan", 52.2222, { physicalFrom: -540, physicalTo: 540 })] } });
  r = await h.callJson("gma3_set_position", { use_selection: true, pan: 10, unit: "degrees" });
  assert.equal(r.result.verification.status, "mismatched");
  assert.match(r.result.verification.detail, /Pan reads 52.2222 % of range = 23.9998 Angle, expected 50.9259 % \(10 physical\)/);
  // Without a range the comparison is unavailable, never a false match.
  script({ selectionCount: 1, programmer: { scanned: [twoFixtures.scanned[0]], rows: [row("1", 11, "Pan", 52.2222, { physicalFrom: null, physicalTo: null })] } });
  r = await h.callJson("gma3_set_position", { use_selection: true, pan: 10, unit: "degrees" });
  assert.equal(r.result.verification.status, "unavailable");
  assert.match(r.result.verification.detail, /physical range of Pan is not available/);
});

test("read-back: decimal and readout units are interpreted; an unknown readout is unavailable", async () => {
  script({ selectionCount: 1, programmer: { scanned: [twoFixtures.scanned[0]], rows: [row("1", 11, "Dimmer", 50.196)] } });
  let r = await h.callJson("gma3_set_attribute", { use_selection: true, attribute: "Dimmer", value: 128, unit: "decimal8" });
  assert.equal(r.result.verification.status, "matched", r.result.verification.detail);
  r = await h.callJson("gma3_set_attribute", { use_selection: true, attribute: "Dimmer", value: 50.2 });
  assert.equal(r.result.verification.status, "matched", "no unit: the attribute's Percent readout applies");
  assert.ok(r.result.warnings.some((w: string) => /assumed the user profile's readout is Natural/.test(w)));
  script({ selectionCount: 1, attributes: ["Gobo1"], programmer: { scanned: [twoFixtures.scanned[0]], rows: [row("1", 11, "Gobo1", 20, { readout: null })] } });
  r = await h.callJson("gma3_set_attribute", { use_selection: true, attribute: "Gobo1", value: 20 });
  assert.equal(r.result.verification.status, "unavailable");
  assert.match(r.result.verification.detail, /readout null of Gobo1 cannot be interpreted/);
});

test("read-back: a multi-step phaser is never reduced to a matching static value", async () => {
  script({ selectionCount: 1, programmer: { scanned: [twoFixtures.scanned[0]], rows: [row("1", 11, "Dimmer", 50, { value: undefined, stepCount: 2 })] } });
  const { result } = await h.callJson("gma3_set_attribute", { use_selection: true, attribute: "Dimmer", value: 50, unit: "percent" });
  assert.equal(result.verification.status, "mismatched");
  assert.match(result.verification.detail, /holds a 2-step phaser, not the static value 50/);
});

test("read-back: a compound fixture is verified through its cells with one follow-up scan", async () => {
  const cells = [row("None", 21, "Dimmer", 40, { fixture: "[Instance1]" }), row("None", 22, "Dimmer", 40, { fixture: "[Instance2]" })];
  script({
    selectionCount: 1,
    programmer: {
      scanned: [{ subfixtureIndex: 20, fid: "501", name: "Wash 1" }],
      rows: [],
      byFixture: { "Fixture 501": { scanned: [{ subfixtureIndex: 20, fid: "501", name: "Wash 1", rootFid: "501" }, { subfixtureIndex: 21, fid: "None", name: "[Instance1]", rootFid: "501" }, { subfixtureIndex: 22, fid: "None", name: "[Instance2]", rootFid: "501" }], rows: cells } },
    },
  });
  const { result, isError } = await h.callJson("gma3_set_attribute", { use_selection: true, attribute: "Dimmer", value: 40, unit: "percent" });
  assert.equal(isError, false, result.verification.detail);
  assert.equal(result.verification.status, "matched");
  assert.equal(result.programmerReadBack.followUpScans, 1);
  assert.equal(result.programmerReadBack.rowsChecked, 2);
  const followUp = h.fake.requests.find((r) => r.op === "programmer" && r.args.scope === "fixtures");
  assert.equal(followUp?.args.fixtures, "Fixture 501");
  // One wrong cell is a mismatch naming the cell.
  cells[1].value = 10;
  const r2 = await h.callJson("gma3_set_attribute", { use_selection: true, attribute: "Dimmer", value: 40, unit: "percent" });
  assert.equal(r2.result.verification.status, "mismatched");
  assert.match(r2.result.verification.detail, /Wash 1 \(Fixture 501\) cell \[Instance2\]: Dimmer reads 10 %/);
});

test("read-back: a cell that has the attribute but no value is a mismatch; a matching sibling never covers it", async () => {
  script({
    selectionCount: 1,
    programmer: {
      scanned: [{ subfixtureIndex: 20, fid: "501", name: "Wash 1", attributes: ["Shutter1"] }],
      rows: [],
      byFixture: {
        "Fixture 501": {
          scanned: [
            { subfixtureIndex: 20, fid: "501", name: "Wash 1", rootFid: "501", attributes: ["Shutter1"] },
            { subfixtureIndex: 21, fid: "None", name: "[Instance1]", rootFid: "501", attributes: ["Dimmer", "ColorRGB_R"] },
            { subfixtureIndex: 22, fid: "None", name: "[Instance2]", rootFid: "501", attributes: ["Dimmer", "ColorRGB_R"] },
            { subfixtureIndex: 23, fid: "None", name: "[Strobe]", rootFid: "501", attributes: ["Shutter1"] },
          ],
          rows: [row("None", 21, "Dimmer", 40, { fixture: "[Instance1]" })],
        },
      },
    },
  });
  const { result, isError } = await h.callJson("gma3_set_attribute", { use_selection: true, attribute: "Dimmer", value: 40, unit: "percent" });
  assert.equal(isError, true);
  assert.equal(result.verification.status, "mismatched");
  assert.match(result.verification.detail, /Wash 1 \(Fixture 501\) cell \[Instance2\]: no programmer value for Dimmer/);
  assert.doesNotMatch(result.verification.detail, /Instance1|Strobe|cell Wash/, "cells with the value, and cells without the attribute, are not reported");
  assert.equal(result.programmerReadBack.cellsJudged, 2, "only the two cells that have Dimmer were judged");
});

test("read-back: every page of a paginated scan is fetched before judging; an unfinished scan is unavailable", async () => {
  const rows = ["1", "2", "3", "4", "5"].map((f, i) => row(f, 10 + i, "Dimmer", f === "5" ? 10 : 50));
  const scanned = ["1", "2", "3", "4", "5"].map((f, i) => ({ subfixtureIndex: 10 + i, fid: f, name: `Fx ${f}` }));
  script({ selectionCount: 5, programmer: { scanned, rows, pageSize: 2 } });
  let r = await h.callJson("gma3_set_attribute", { use_selection: true, attribute: "Dimmer", value: 50, unit: "percent" });
  assert.equal(r.result.verification.status, "mismatched", "the wrong value on the last page is seen");
  assert.match(r.result.verification.detail, /Fx 5 \(Fixture 5\): Dimmer reads 10 %/);
  const pages = h.fake.requests.filter((q) => q.op === "programmer").map((q) => q.args.offset);
  assert.deepEqual(pages, [0, 2, 4], "pages are fetched until total is reached");
  // A scan that reports more rows than it ever returns cannot be verified.
  script({ selectionCount: 5, programmer: { scanned, rows, pageSize: 2 } });
  const real = h.fake.handlerFor("programmer")!;
  h.fake.on("programmer", (args, req) => {
    const res = real(args, req) as { rows: unknown[]; total: number };
    return Number(args.offset ?? 0) > 0 ? { ...res, rows: [] } : res;
  });
  r = await h.callJson("gma3_set_attribute", { use_selection: true, attribute: "Dimmer", value: 50, unit: "percent" });
  assert.equal(r.result.verification.status, "unavailable");
  assert.match(r.result.verification.detail, /reported 5 rows but page 2 was empty/);
});

test("read-back: coverage and truncation flags are checked on every page, not just the first", async () => {
  const rows = ["1", "2", "3", "4"].map((f, i) => row(f, 10 + i, "Dimmer", 50));
  const scanned = ["1", "2", "3", "4"].map((f, i) => ({ subfixtureIndex: 10 + i, fid: f, name: `Fx ${f}` }));
  for (const flaw of ["coverage", "truncated"] as const) {
    script({ selectionCount: 4, programmer: { scanned, rows, pageSize: 2 } });
    const real = h.fake.handlerFor("programmer")!;
    h.fake.on("programmer", (args, req) => {
      const res = real(args, req) as { coverage: { complete: boolean }; fixturesTruncated: boolean; limitations: string[] };
      if (Number(args.offset ?? 0) === 0) return res;
      return flaw === "coverage"
        ? { ...res, coverage: { ...res.coverage, complete: false }, limitations: ["channel budget (5000) reached"] }
        : { ...res, fixturesTruncated: true };
    });
    const { result } = await h.callJson("gma3_set_attribute", { use_selection: true, attribute: "Dimmer", value: 50, unit: "percent" });
    assert.equal(result.verification.status, "unavailable", `${flaw}: ${result.verification.detail}`);
    assert.match(result.verification.detail, flaw === "coverage" ? /page 2 of the programmer scan reported incomplete coverage: channel budget/ : /page 2 of the programmer scan reported a truncated fixture list/);
  }
});

test("read-back: a plugin that does not list per-subfixture attributes yields unavailable, not a pooled match", async () => {
  script({ selectionCount: 1, programmer: { scanned: [{ subfixtureIndex: 11, fid: "1", name: "Fx 1", attributes: null }], rows: [row("1", 11, "Dimmer", 50)] } });
  const { result } = await h.callJson("gma3_set_attribute", { use_selection: true, attribute: "Dimmer", value: 50, unit: "percent" });
  assert.equal(result.verification.status, "unavailable");
  assert.match(result.verification.detail, /did not report which \(sub\)fixtures have the attribute \(needs plugin 0.3.4/);
});

test("read-back: incomplete coverage or a failed read is unavailable, and verify:false skips it", async () => {
  script({ selectionCount: 2, programmer: { ...twoFixtures, rows: [row("1", 11, "Dimmer", 50), row("2", 12, "Dimmer", 50)], complete: false } });
  let r = await h.callJson("gma3_set_attribute", { use_selection: true, attribute: "Dimmer", value: 50, unit: "percent" });
  assert.equal(r.result.verification.status, "unavailable");
  assert.match(r.result.verification.detail, /scan of the selection was incomplete/);
  script({ selectionCount: 1 });
  h.fake.on("programmer", () => {
    throw new Error("Lua error: GetProgPhaser failed");
  });
  r = await h.callJson("gma3_set_attribute", { use_selection: true, attribute: "Dimmer", value: 50, unit: "percent" });
  assert.equal(r.result.outcome, "succeeded");
  assert.equal(r.result.verification.status, "unavailable");
  assert.match(r.result.verification.detail, /programmer read-back failed: Lua error/);
  script({ selectionCount: 1, programmer: { scanned: [twoFixtures.scanned[0]], rows: [row("1", 11, "Dimmer", 99)] } });
  r = await h.callJson("gma3_set_attribute", { use_selection: true, attribute: "Dimmer", value: 50, unit: "percent", verify: false });
  assert.equal(r.result.verification.status, "not_requested");
  assert.equal(h.fake.requests.filter((q) => q.op === "programmer").length, 0);
});

test("read-back: nothing is read when no set command was sent, and an unknown command still gets a read-back", async () => {
  script({ selectionCount: 0, programmer: { scanned: [], rows: [] } });
  let r = await h.callJson("gma3_set_attribute", { use_selection: true, attribute: "Dimmer", value: 50, unit: "percent" });
  assert.equal(r.result.outcome, "failed");
  assert.equal(h.fake.requests.filter((q) => q.op === "programmer").length, 0);
  const st = script({ selectionCount: 1, programmer: { scanned: [twoFixtures.scanned[0]], rows: [row("1", 11, "Dimmer", 50)] } }, () => SILENT);
  void st;
  r = await h.callJson("gma3_set_attribute", { use_selection: true, attribute: "Dimmer", value: 50, unit: "percent" });
  assert.equal(r.result.outcome, "unknown", "a lost reply keeps the outcome unknown even when the read-back matches");
  assert.equal(r.result.verification.status, "matched");
  assert.equal(r.isError, true);
});

test("pre-check: a small explicit target whose fixture lacks the attribute fails before anything is sent", async () => {
  const st = script({ fixtureAttributes: { "1": ["Dimmer", "Pan", "Tilt"], "2": ["Dimmer"] } });
  resolveTo(st, [{ fid: "1" }, { fid: "2" }]);
  const { result, isError } = await h.callJson("gma3_set_position", { fixtures: "1 Thru 2", pan: 10, unit: "degrees" });
  assert.equal(isError, true);
  assert.equal(result.outcome, "failed");
  assert.deepEqual(h.fake.commands, [], "nothing was sent");
  const step = result.steps.find((s: any) => s.name === "check_fixture_attributes");
  assert.equal(step.status, "failed");
  assert.equal(step.kind, "read");
  assert.match(step.error, /Fixture 2 \(Type of 2\) has no attribute Pan; nothing was sent/);
  assert.equal(h.fake.requests.filter((q) => q.op === "fixtureAttributes").length, 2);
});

test("pre-check: a compound fixture passes when its cells carry the attribute, and fails when neither does", async () => {
  const st = script({
    fixtureAttributes: { "501": ["Dimmer", "Shutter1"], "501.1": ["Dimmer", "ColorRGB_R", "ColorRGB_G", "ColorRGB_B"], "501.2": ["Dimmer", "ColorRGB_R", "ColorRGB_G", "ColorRGB_B"] },
    programmer: { scanned: [{ subfixtureIndex: 20, fid: "501", name: "Wash" }], rows: [], byFixture: { "Fixture 501": { scanned: [], rows: [row("None", 21, "ColorRGB_R", 1), row("None", 21, "ColorRGB_G", 2), row("None", 21, "ColorRGB_B", 3)] } } },
  });
  resolveTo(st, [{ fid: "501" }]);
  let r = await h.callJson("gma3_set_color", { fixtures: "501", red: 1, green: 2, blue: 3 });
  assert.equal(r.result.outcome, "succeeded", r.result.summary);
  const step = r.result.steps.find((s: any) => s.name === "check_fixture_attributes");
  assert.deepEqual(step.detail.checked, [{ fixture: "Fixture 501", attributes: 5, cellsChecked: 2, complete: true }]);
  assert.equal(h.fake.requests.filter((q) => q.op === "fixtureAttributes").length, 3, "parent plus two cells");
  r = await h.callJson("gma3_set_attribute", { fixtures: "501", attribute: "Pan", value: 0, unit: "percent" });
  assert.equal(r.result.outcome, "failed");
  assert.match(r.result.steps.find((s: any) => s.name === "check_fixture_attributes").error, /Fixture 501 \(Type of 501\) has no attribute Pan \(nor do its cells\); nothing was sent/);
});

test("pre-check: partial discovery does not establish absence; the call proceeds with a warning", async () => {
  // A 12-cell fixture: only 4 cells are sampled, none of them has Pan.
  const st = script({ fixtureAttributes: { "501": ["Dimmer"], "501.1": ["Dimmer"], "501.2": ["Dimmer"], "501.3": ["Dimmer"], "501.4": ["Dimmer"] }, programmer: { scanned: [{ subfixtureIndex: 20, fid: "501", name: "Wash", attributes: ["Dimmer", "Pan"] }], rows: [row("501", 20, "Pan", 50)] } }) as ConsoleState & { cellCounts?: Record<string, number> };
  st.cellCounts = { "501": 12 };
  resolveTo(st, [{ fid: "501" }]);
  let r = await h.callJson("gma3_set_attribute", { fixtures: "501", attribute: "Pan", value: 0, unit: "physical" });
  assert.equal(r.result.outcome, "succeeded", r.result.summary);
  assert.ok(h.fake.commands.includes('Attribute "Pan" At Absolute Physical 0'), "the command was sent");
  assert.ok(r.result.warnings.some((w: string) => /not established: Fixture 501 \(Type of 501\): attribute Pan was not found but discovery was partial \(only 4 of 12 cells were read\)/.test(w)), JSON.stringify(r.result.warnings));
  const step = r.result.steps.find((s: any) => s.name === "check_fixture_attributes");
  assert.equal(step.status, "succeeded");
  assert.equal(step.detail.checked[0].complete, false);
  // More than 500 attributes reported: absence is not established either.
  const st2 = script({ attributes: ["Dimmer", "Zoom"], fixtureAttributes: { "7": ["Dimmer"] }, programmer: { scanned: [{ subfixtureIndex: 7, fid: "7", name: "Big", attributes: ["Dimmer", "Zoom"] }], rows: [row("7", 7, "Zoom", 50)] } }) as ConsoleState & { attributeTotals?: Record<string, number> };
  st2.attributeTotals = { "7": 600 };
  resolveTo(st2, [{ fid: "7" }]);
  r = await h.callJson("gma3_set_attribute", { fixtures: "7", attribute: "Zoom", value: 50, unit: "percent" });
  assert.equal(r.result.outcome, "succeeded", r.result.summary);
  assert.ok(r.result.warnings.some((w: string) => /only the first 500 of 600 attributes were read/.test(w)));
});

test("pre-check: passes when every fixture has the attributes, then the commands and read-back run", async () => {
  const st = script({
    fixtureAttributes: { "1": ["Dimmer", "ColorRGB_R", "ColorRGB_G", "ColorRGB_B"], "2": ["Dimmer", "ColorRGB_R", "ColorRGB_G", "ColorRGB_B"] },
    programmer: { ...twoFixtures, rows: ["1", "2"].flatMap((f, i) => [row(f, 11 + i, "ColorRGB_R", 100), row(f, 11 + i, "ColorRGB_G", 0), row(f, 11 + i, "ColorRGB_B", 12.5)]) },
  });
  resolveTo(st, [{ fid: "1" }, { fid: "2" }]);
  const { result, isError } = await h.callJson("gma3_set_color", { fixtures: "1 Thru 2", red: 100, green: 0, blue: 12.5 });
  assert.equal(isError, false, result.verification.detail);
  assert.equal(result.verification.status, "matched");
  assert.deepEqual(
    result.steps.map((s: any) => s.name),
    ["resolve_target", "check_fixture_attributes", "clear_selection", "select", "set_red", "set_green", "set_blue", "read_programmer"],
  );
});

test("pre-check: skipped with a warning for groups, large targets, old plugins and check_attributes:false", async () => {
  let st = script({ fixtureAttributes: { "1": ["Dimmer"] } });
  h.fake.on("objects", (args) => {
    const ref = String(args.ref);
    if (/^Attribute "/.test(ref)) return { total: 1, offset: 0, count: 1, items: [{ name: "Dimmer", class: "Attribute" }] };
    if (ref === "Selection") return { total: 1, offset: 0, count: 1, items: [{ name: "Selection", class: "Selection", fields: { CountTotalSelected: "3" } }] };
    return { total: 1, offset: 0, count: 1, items: [{ name: "Front", class: "Group" }] };
  });
  let r = await h.callJson("gma3_set_attribute", { fixtures: "Group 5", attribute: "Dimmer", value: 50, unit: "percent" });
  assert.ok(r.result.warnings.some((w: string) => /pre-check skipped: the target did not resolve to fixtures/.test(w)));
  assert.equal(h.fake.requests.filter((q) => q.op === "fixtureAttributes").length, 0);
  assert.ok(h.fake.commands.includes('Attribute "Dimmer" At Absolute Percent 50'));

  st = script({ fixtureAttributes: { "1": ["Dimmer"] } });
  resolveTo(st, Array.from({ length: 12 }, (_, i) => ({ fid: String(i + 1) })));
  r = await h.callJson("gma3_set_attribute", { fixtures: "1 Thru 12", attribute: "Dimmer", value: 50, unit: "percent" });
  assert.ok(r.result.warnings.some((w: string) => /resolves to 12 objects \(more than 8\)/.test(w)));
  assert.equal(h.fake.requests.filter((q) => q.op === "fixtureAttributes").length, 0);

  st = script();
  resolveTo(st, [{ fid: "1" }]);
  r = await h.callJson("gma3_set_attribute", { fixtures: "1", attribute: "Dimmer", value: 50, unit: "percent" });
  assert.ok(r.result.warnings.some((w: string) => /predates the fixtureAttributes op/.test(w)));
  assert.ok(h.fake.commands.includes('Attribute "Dimmer" At Absolute Percent 50'), "the command is still sent");

  st = script({ fixtureAttributes: { "1": [] } });
  resolveTo(st, [{ fid: "1" }]);
  r = await h.callJson("gma3_set_attribute", { fixtures: "1", attribute: "Dimmer", value: 50, unit: "percent", check_attributes: false });
  assert.equal(h.fake.requests.filter((q) => q.op === "fixtureAttributes").length, 0);
  assert.equal(r.result.steps.some((s: any) => s.name === "check_fixture_attributes"), false);
});

// ---------------------------------------------------------------------------
// Cross-cutting
// ---------------------------------------------------------------------------

test("set tools send only ClearSelection, only for an explicit fixtures target, and never ClearActive/ClearAll", async () => {
  script({ selectionCount: 3 });
  await h.callJson("gma3_set_attribute", { fixtures: "1 Thru 3", attribute: "Dimmer", value: 50, unit: "percent" });
  await h.callJson("gma3_set_color", { fixtures: "1 Thru 3", red: 1, green: 2, blue: 3 });
  await h.callJson("gma3_set_position", { fixtures: "1 Thru 3", pan: 1, tilt: 2, unit: "degrees" });
  assert.deepEqual(clearCommands(h.fake.commands), ["ClearSelection", "ClearSelection", "ClearSelection"], "one ClearSelection per explicit target, nothing else");
  h.fake.requests.length = 0;
  await h.callJson("gma3_set_attribute", { fixtures: "1 Thru 3", attribute: "Dimmer", value: 50, unit: "percent", add_to_selection: true });
  await h.callJson("gma3_set_color", { fixtures: "1 Thru 3", red: 1, green: 2, blue: 3, add_to_selection: true });
  await h.callJson("gma3_set_position", { fixtures: "1 Thru 3", pan: 1, tilt: 2, unit: "degrees", add_to_selection: true });
  await h.callJson("gma3_set_attribute", { use_selection: true, attribute: "Dimmer", value: 50, unit: "percent" });
  await h.callJson("gma3_set_color", { use_selection: true, red: 1, green: 2, blue: 3 });
  await h.callJson("gma3_set_position", { use_selection: true, pan: 1, unit: "percent" });
  await h.callJson("gma3_select", { fixtures: "4 Thru 6" });
  assert.deepEqual(clearCommands(h.fake.commands), [], "additive targets, use_selection and gma3_select never clear anything");
  assert.ok(h.fake.commands.length >= 12);
});

test("concurrent tool calls are serialised: their command sequences do not interleave", async () => {
  script({ selectionCount: 1 });
  h.fake.on("cmd", async (args) => {
    await new Promise((r) => setTimeout(r, 15));
    return { command: args.command, feedback: "OK" };
  });
  const [a, b, c] = await Promise.all([
    h.callJson("gma3_set_color", { fixtures: "1 Thru 2", red: 1, green: 1, blue: 1 }),
    h.callJson("gma3_set_position", { fixtures: "3 Thru 4", pan: 10, tilt: 20, unit: "degrees" }),
    h.callJson("gma3_select", { fixtures: "5", clear_first: true }),
  ]);
  for (const r of [a, b, c]) assert.equal(r.result.outcome, "succeeded", r.text);
  assert.deepEqual(h.fake.commands, [
    "ClearSelection",
    "Fixture 1 Thru 2",
    'Attribute "ColorRGB_R" At Absolute Percent 1',
    'Attribute "ColorRGB_G" At Absolute Percent 1',
    'Attribute "ColorRGB_B" At Absolute Percent 1',
    "ClearSelection",
    "Fixture 3 Thru 4",
    'Attribute "Pan" At Absolute Physical 10',
    'Attribute "Tilt" At Absolute Physical 20',
    "ClearSelection",
    "Fixture 5",
  ]);
  // Read-only requests of a later call must not slip in between an earlier call's commands either.
  const ops = h.fake.requests.map((r) => `${r.op}:${r.op === "cmd" ? r.args.command : r.args.ref}`);
  const firstColor = ops.indexOf('cmd:Attribute "ColorRGB_R" At Absolute Percent 1');
  const lastColor = ops.indexOf('cmd:Attribute "ColorRGB_B" At Absolute Percent 1');
  assert.ok(ops.slice(firstColor, lastColor).every((o) => o.startsWith("cmd:Attribute \"ColorRGB")));
});

test("read-only steps are marked kind=read and a failed read-back never changes a succeeded outcome", async () => {
  const st = script({ selectionCount: 3 });
  h.fake.on("children", () => {
    throw new Error("children unavailable");
  });
  const { result, isError } = await h.callJson("gma3_select", { fixtures: "1 Thru 3" });
  assert.equal(result.outcome, "succeeded");
  assert.equal(isError, false);
  assert.equal(result.verification.status, "matched");
  const kinds = Object.fromEntries(result.steps.map((s: { name: string; kind?: string }) => [s.name, s.kind]));
  assert.deepEqual(kinds, { resolve_target: "read", select: undefined, read_selection: "read", read_selected: "read" });
  assert.equal(result.steps.find((s: { name: string }) => s.name === "read_selected").status, "failed");
  void st;
  // A read step that cannot be answered makes the operation failed (nothing was sent), not unknown/partial.
  script({ selectionCount: 3 });
  h.fake.on("objects", () => SILENT);
  const r2 = await h.callJson("gma3_set_attribute", { fixtures: "1", attribute: "Dimmer", value: 1, unit: "percent" });
  assert.equal(r2.result.outcome, "failed");
  assert.deepEqual(h.fake.commands, []);
});

test("tool descriptions state selection change, programmer impact and verification scope", () => {
  for (const name of ["gma3_select", "gma3_set_attribute", "gma3_set_color", "gma3_set_position", "gma3_clear_programmer"]) {
    const d = h.tools.get(name)?.description ?? "";
    assert.match(d, /selection/i, name);
    assert.match(d, /programmer values/i, name);
    assert.match(d, /verif/i, name);
    assert.match(d, /serialised against this server/i, name);
  }
});

test("command formatting never emits exponent notation or stray decimals", () => {
  assert.equal(formatValue(50), "50");
  assert.equal(formatValue(12.5), "12.5");
  assert.equal(formatValue(0.00001), "0");
  assert.equal(formatValue(1e21), "1000000000000000000000");
  assert.equal(formatValue(-45.5), "-45.5");
  assert.equal(attributeCommand("Pan", 30, "Physical"), 'Attribute "Pan" At Absolute Physical 30');
  assert.equal(attributeCommand("Dimmer", 100), 'Attribute "Dimmer" At Absolute 100');
});
