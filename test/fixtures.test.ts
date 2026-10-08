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
}

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
  return st;
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
  assert.match(result.verification.detail, /gma3_programmer \(FR-08\)/);
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

test("set_color: an unsupported fixture that silently accepts the command is not claimed as verified", async () => {
  script({ selectionCount: 1 });
  const { result } = await h.callJson("gma3_set_color", { use_selection: true, red: 10, green: 20, blue: 30 });
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.verification.status, "unavailable");
  assert.match(result.summary, /read-back unavailable/);
  assert.match(result.verification.detail, /not readable/);
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
