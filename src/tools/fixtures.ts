/**
 * FR-03: dedicated fixture programming tools.
 *
 *   gma3_select            select fixtures by range or group
 *   gma3_set_attribute     set one attribute on an explicit target
 *   gma3_set_color         set ColorRGB_R/G/B (0..100 %) on an explicit target
 *   gma3_set_position      set Pan/Tilt in explicit units on an explicit target
 *   gma3_clear_programmer  ClearSelection / ClearActive / ClearAll, explicitly
 *
 * Only the existing bridge ops are used: `cmd` for every mutation and `objects` for read-only
 * checks and read-back. No Lua is generated.
 *
 * Console facts these tools rely on (grandMA3 manual 2.5.1, keyword pages Fixture, Group,
 * SelectFixtures, At, Attribute, Absolute, Percent, PercentFine, Physical, Natural, Decimal8/16/24,
 * ClearSelection, ClearActive, ClearAll):
 *
 *   - `Fixture 1 Thru 5` / `Group 3` use the SelectFixtures default function. When the current
 *     selection has no active programmer values the new fixtures are ADDED to it; when the selected
 *     fixtures have active values the selection is REPLACED. Only `ClearSelection` first makes the
 *     result independent of prior state, which is why the set_* tools send it by default for an
 *     explicit `fixtures` target (add_to_selection: true keeps the existing selection).
 *   - `Attribute "<name>" At Absolute <ValueType> <value>` applies a value to the current selection
 *     in the programmer. Without a value type the user profile's readout decides what the number
 *     means, so the tools always send an explicit value-type keyword when the caller names a unit.
 *   - `ClearSelection` deselects, `ClearActive` deactivates values, `ClearAll` empties the programmer.
 *
 * Programmer values cannot be read back through the structured ops, so value verification is
 * reported as `unavailable`; selection read-back uses Selection.CountTotalSelected via `objects`.
 */
import { z } from "zod";
import type { Gma3Bridge } from "../bridge.js";
import { operation, type RegisterTools, type ToolContext } from "./context.js";
import {
  buildResult,
  commandStep,
  parsePlainNumber,
  readStep,
  runSteps,
  unavailable,
  validationFailure,
  type OperationResult,
  type StepFn,
  type StepResult,
  type Verification,
} from "../results.js";
import { Validator, attributeName, exactlyOne, finiteNumber, fixtureSelection, oneOf, percent } from "../validate.js";
import { exists, readFields } from "./common.js";

// ---------------------------------------------------------------------------
// Constants and local helpers
// ---------------------------------------------------------------------------

const SERIALISATION_NOTE =
  "Commands are serialised against other mutations from this MCP server only; another console operator or client can still change the selection or programmer between steps.";

const VALUE_UNAVAILABLE =
  "programmer values are not readable through the structured ops; use gma3_programmer (FR-08) when available";

/** Value-type keywords accepted by gma3_set_attribute, with their validation rules. */
const ATTRIBUTE_UNITS = {
  percent: { keyword: "Percent", min: 0, max: 100, integer: false },
  percent_fine: { keyword: "PercentFine", min: 0, max: 100, integer: false },
  physical: { keyword: "Physical", min: undefined, max: undefined, integer: false },
  natural: { keyword: "Natural", min: undefined, max: undefined, integer: false },
  decimal8: { keyword: "Decimal8", min: 0, max: 255, integer: true },
  decimal16: { keyword: "Decimal16", min: 0, max: 65535, integer: true },
  decimal24: { keyword: "Decimal24", min: 0, max: 16777215, integer: true },
} as const;
type AttributeUnit = keyof typeof ATTRIBUTE_UNITS;
const ATTRIBUTE_UNIT_NAMES = Object.keys(ATTRIBUTE_UNITS) as AttributeUnit[];

const POSITION_UNITS = ["degrees", "percent"] as const;
type PositionUnit = (typeof POSITION_UNITS)[number];

const CLEAR_MODES = {
  selection: { command: "ClearSelection", effect: "deselects all fixtures; programmer values stay" },
  active: { command: "ClearActive", effect: "deactivates all programmer values; selection and values stay" },
  all: { command: "ClearAll", effect: "clears the selection and discards every programmer value" },
} as const;
type ClearMode = keyof typeof CLEAR_MODES;
const CLEAR_MODE_NAMES = Object.keys(CLEAR_MODES) as ClearMode[];

/** Render a validated finite number for a command line without exponent notation. */
export function formatValue(n: number): string {
  return n.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 4 });
}

/** Build the documented `Attribute "<name>" At Absolute [<ValueType>] <value>` command. */
export function attributeCommand(attribute: string, value: number, valueType?: string): string {
  return `Attribute "${attribute}" At Absolute${valueType ? ` ${valueType}` : ""} ${formatValue(value)}`;
}

interface SelectionCount {
  total: number | null;
  fully: number | null;
}

/** Read Selection.CountTotalSelected / CountFullySelected through the `objects` op. Null when unreadable. */
async function readSelectionCount(bridge: Gma3Bridge): Promise<SelectionCount | null> {
  const fields = await readFields(bridge, "Selection", ["CountTotalSelected", "CountFullySelected"]);
  if (!fields) return null;
  const num = (v: unknown): number | null => (v === undefined || v === null ? null : parsePlainNumber(String(v)));
  const total = num(fields.CountTotalSelected);
  const fully = num(fields.CountFullySelected);
  if (total === null && fully === null) return null;
  return { total, fully };
}

/** Read-only step: the target expression must resolve to at least one object before anything is sent. */
function resolveTargetStep(bridge: Gma3Bridge, selection: string): StepFn {
  return () =>
    readStep(bridge, "resolve_target", "objects", { ref: selection, fields: [], limit: 1 }, (result) => {
      const res = result as { total?: number } | null;
      const total = res && typeof res.total === "number" ? res.total : 0;
      if (total < 1) return { name: "resolve_target", kind: "read", status: "failed", op: "objects", error: `no objects match ${JSON.stringify(selection)}; nothing was sent`, detail: { total } };
      return { name: "resolve_target", kind: "read", status: "succeeded", op: "objects", detail: { ref: selection, total } };
    }).then((step) => {
      // The bridge raises "no objects found" as an error for an empty ObjectList; report it as a plain failure.
      if (step.status === "failed" && /no objects? found|no object at address|path not found/i.test(step.error ?? "")) {
        return { ...step, error: `no objects match ${JSON.stringify(selection)}; nothing was sent` };
      }
      return step;
    });
}

/**
 * Read-only step: `Attribute "<name>"` must resolve in the show's attribute definitions. This only
 * proves the name is known to the show, not that the targeted fixtures have the attribute.
 */
function checkAttributeStep(bridge: Gma3Bridge, attribute: string, warnings: string[]): StepFn {
  return async () => {
    const ref = `Attribute "${attribute}"`;
    const found = await exists(bridge, ref);
    if (found.exists === false) {
      return { name: "check_attribute", kind: "read", status: "failed", op: "objects", error: `attribute ${JSON.stringify(attribute)} is not defined in this show; nothing was sent`, detail: { ref } };
    }
    if (found.exists === "unknown") {
      warnings.push(`could not confirm that attribute ${JSON.stringify(attribute)} exists (${found.error}); the command was sent anyway`);
      return { name: "check_attribute", kind: "read", status: "succeeded", op: "objects", detail: { ref, exists: "unknown" } };
    }
    return { name: "check_attribute", kind: "read", status: "succeeded", op: "objects", detail: { ref, exists: true } };
  };
}

/** Read-only step for use_selection: refuse to send when nothing is selected. */
function checkSelectionStep(bridge: Gma3Bridge, warnings: string[]): StepFn {
  return async () => {
    try {
      const count = await readSelectionCount(bridge);
      if (!count) {
        warnings.push("the selection count could not be read before sending; the console applied the values to whatever was selected");
        return { name: "check_selection", kind: "read", status: "succeeded", op: "objects", detail: { selectionCount: null } };
      }
      if (count.total !== null && count.total < 1) {
        return { name: "check_selection", kind: "read", status: "failed", op: "objects", error: "nothing is selected; select fixtures first or pass `fixtures`", detail: count };
      }
      return { name: "check_selection", kind: "read", status: "succeeded", op: "objects", detail: count };
    } catch (err) {
      return { name: "check_selection", kind: "read", status: "failed", op: "objects", error: `could not read the selection: ${err instanceof Error ? err.message : String(err)}` };
    }
  };
}

/** Names of the selected (sub)fixtures: the children of the Selection object. Bounded; null when unreadable. */
async function readSelectedNames(bridge: Gma3Bridge, limit: number): Promise<{ names: string[]; total: number } | null> {
  try {
    const res = (await bridge.request("children", { ref: "Selection", fields: [], limit })) as { total?: number; items?: Array<{ name?: string }> } | null;
    if (!res || !Array.isArray(res.items)) return null;
    return { names: res.items.map((i) => i.name ?? "?"), total: typeof res.total === "number" ? res.total : res.items.length };
  } catch {
    return null;
  }
}

/**
 * Read-back after a selection change. The read-back steps are appended to `steps` for the record,
 * but the caller builds the outcome before appending them: a failed read-back leaves the outcome
 * of the mutation alone and only makes the verification `unavailable`.
 */
async function verifySelection(bridge: Gma3Bridge, expectEmpty: boolean, steps: StepResult[]): Promise<{ verification: Verification; count: SelectionCount | null; selected: string[] | null }> {
  let selected: string[] | null = null;
  try {
    const count = await readSelectionCount(bridge);
    steps.push({ name: "read_selection", kind: "read", status: "succeeded", op: "objects", detail: count });
    if (!expectEmpty && count && count.total !== null && count.total > 0) {
      const members = await readSelectedNames(bridge, 50);
      steps.push(members ? { name: "read_selected", kind: "read", status: "succeeded", op: "children", detail: members } : { name: "read_selected", kind: "read", status: "failed", op: "children", error: "selected members could not be listed" });
      selected = members?.names ?? null;
    }
    if (!count || count.total === null) return { verification: unavailable("Selection.CountTotalSelected could not be read", "selection count"), count, selected };
    const checked = expectEmpty ? "Selection.CountTotalSelected is 0" : "Selection.CountTotalSelected is at least 1 (membership is not verifiable without Lua)";
    const ok = expectEmpty ? count.total === 0 : count.total >= 1;
    return {
      verification: ok
        ? { status: "matched", checked, expected: expectEmpty ? 0 : ">= 1", actual: count.total }
        : { status: "mismatched", checked, expected: expectEmpty ? 0 : ">= 1", actual: count.total, detail: expectEmpty ? `${count.total} fixture(s) are still selected` : "no fixtures are selected after the select command" },
      count,
      selected,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    steps.push({ name: "read_selection", kind: "read", status: "failed", op: "objects", error: message });
    return { verification: unavailable(`selection read-back failed: ${message}`, "selection count"), count: null, selected };
  }
}

// ---------------------------------------------------------------------------
// Target resolution shared by the set_* tools
// ---------------------------------------------------------------------------

interface TargetArgs {
  fixtures?: string;
  use_selection?: boolean;
  add_to_selection?: boolean;
}

interface ResolvedTarget {
  /** Normalised selection expression, or null when the current selection is used. */
  selection: string | null;
  /** Keep the existing selection and add `selection` to it (explicit opt-in). Default: replace it. */
  additive: boolean;
  target: Record<string, unknown>;
}

function validateTarget(v: Validator, args: TargetArgs): ResolvedTarget | undefined {
  const which = v.check(() => exactlyOne({ fixtures: args.fixtures, use_selection: args.use_selection }, "target options"));
  let selection: string | null = null;
  if (args.fixtures !== undefined) selection = v.check(() => fixtureSelection("fixtures", args.fixtures)) ?? null;
  if (args.add_to_selection && which === "use_selection") v.fail("add_to_selection only applies with `fixtures`; it cannot be combined with use_selection");
  if (!v.ok) return undefined;
  return {
    selection,
    additive: Boolean(args.add_to_selection),
    target: selection ? { fixtures: selection, ...(args.add_to_selection ? { addToSelection: true } : {}) } : { selection: "current" },
  };
}

/**
 * Steps that establish the target selection: read-only check, ClearSelection (unless additive),
 * select. An explicit `fixtures` target means exactly those fixtures: without ClearSelection the
 * console would ADD them to a selection that has no active values, and the values would also land
 * on fixtures the caller never named. ClearSelection only deselects; programmer values are kept.
 */
function targetSteps(bridge: Gma3Bridge, t: ResolvedTarget, warnings: string[]): Array<{ name: string; run: StepFn }> {
  if (t.selection === null) {
    return [{ name: "check_selection", run: checkSelectionStep(bridge, warnings) }];
  }
  const plan: Array<{ name: string; run: StepFn }> = [{ name: "resolve_target", run: resolveTargetStep(bridge, t.selection) }];
  if (t.additive) {
    warnings.push(
      `add_to_selection: ${t.selection} was added to the current selection (grandMA3 adds when the selection has no active values and replaces when it does); fixtures that were already selected also received the values.`,
    );
  } else {
    plan.push({ name: "clear_selection", run: () => commandStep(bridge, "clear_selection", "ClearSelection") });
  }
  plan.push({ name: "select", run: () => commandStep(bridge, "select", t.selection as string) });
  return plan;
}

function finish(
  o: { operation: string; target: Record<string, unknown>; steps: StepResult[]; warnings: string[]; selectionChanged: boolean; programmerValuesChanged: boolean; extra?: Record<string, unknown> },
): OperationResult {
  return buildResult({
    operation: o.operation,
    target: o.target,
    steps: o.steps,
    verification: unavailable(VALUE_UNAVAILABLE, "programmer values"),
    warnings: [...o.warnings, SERIALISATION_NOTE],
    extra: { selectionChanged: o.selectionChanged, programmerValuesChanged: o.programmerValuesChanged, ...(o.extra ?? {}) },
  });
}

/** Did any mutation (cmd step) actually succeed? */
const anySucceeded = (steps: StepResult[], names: string[]): boolean => steps.some((s) => names.includes(s.name) && s.status === "succeeded");

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const targetShape = {
  fixtures: z
    .string()
    .optional()
    .describe('Explicit target: fixture IDs/ranges ("1 Thru 5", "1 + 3 + 5 Thru 8", "Fixture 101.1") or a group ("Group 5"). Exactly one of fixtures / use_selection is required.'),
  use_selection: z.boolean().optional().describe("Apply to the fixtures currently selected on the console (explicit opt-in). Fails before sending when nothing is selected."),
  add_to_selection: z
    .boolean()
    .optional()
    .describe(
      "With `fixtures`: keep the fixtures already selected and add the target to them, so previously selected fixtures ALSO receive the values (explicit opt-in). " +
        "Default false: ClearSelection is sent first so exactly the named fixtures are targeted. ClearSelection only deselects; programmer values are never cleared.",
    ),
};

export const registerFixtureTools: RegisterTools = (server, ctx: ToolContext) => {
  const { bridge } = ctx;

  // -------------------------------------------------------------------------
  server.registerTool(
    "gma3_select",
    {
      title: "Select fixtures",
      description:
        "Select fixtures by range or group in the programmer. Sends the selection expression as a command (e.g. `Fixture 1 Thru 5`, `Group 3`). " +
        "CHANGES THE SELECTION: grandMA3 adds to the current selection when it has no active values and replaces it when values are active; " +
        "set clear_first to send ClearSelection first for a deterministic result. Does NOT clear programmer values (ClearSelection only deselects). " +
        "Verifies that Selection.CountTotalSelected is >= 1 afterwards and lists the selected members (first 50) for information; it does not assert exact membership. " +
        "Serialised against this server's other mutations only, not against other operators or clients.",
      inputSchema: {
        fixtures: z.string().describe('Fixture IDs/ranges ("1 Thru 5", "1 + 3", "Fixture 101 Thru 110", "Fixture 1.1") or a group ("Group 5").'),
        clear_first: z.boolean().optional().describe("Send ClearSelection before selecting (default false). Deselects only; programmer values are kept."),
      },
    },
    async (args) =>
      operation(async () => {
        const op = "select";
        const v = new Validator();
        const selection = v.check(() => fixtureSelection("fixtures", args.fixtures));
        if (!v.ok || !selection) return validationFailure(op, { fixtures: args.fixtures }, v.errors);
        const target = { fixtures: selection };
        const clearFirst = args.clear_first === true;
        return ctx.mutations.run(async () => {
          const warnings: string[] = [];
          const plan: Array<{ name: string; run: StepFn }> = [{ name: "resolve_target", run: resolveTargetStep(bridge, selection) }];
          if (clearFirst) plan.push({ name: "clear_selection", run: () => commandStep(bridge, "clear_selection", "ClearSelection") });
          else warnings.push("clear_first is false: the fixtures were added to the existing selection unless that selection had active values (then it was replaced).");
          plan.push({ name: "select", run: () => commandStep(bridge, "select", selection) });
          const { steps } = await runSteps(plan);
          const readBack: StepResult[] = [];
          let verification: Verification = { status: "not_requested" };
          let count: SelectionCount | null = null;
          let selected: string[] | null = null;
          if (anySucceeded(steps, ["select"])) {
            ({ verification, count, selected } = await verifySelection(bridge, false, readBack));
          } else if (anySucceeded(steps, ["clear_selection"])) {
            verification = unavailable("the select step did not succeed; the selection was cleared but nothing was selected", "selection count");
          }
          const result = buildResult({
            operation: op,
            target,
            steps,
            verification,
            warnings: [...warnings, SERIALISATION_NOTE],
            extra: {
              selectionChanged: anySucceeded(steps, ["select", "clear_selection"]),
              programmerValuesChanged: false,
              selectionCount: count?.total ?? null,
              selectionCountFullySelected: count?.fully ?? null,
              selected,
            },
          });
          result.steps.push(...readBack);
          return result;
        });
      }),
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    "gma3_set_attribute",
    {
      title: "Set a fixture attribute",
      description:
        'Set one attribute (Dimmer, Pan, Zoom, ColorRGB_R, ...) to an absolute value in the programmer. Sends `Attribute "<name>" At Absolute [<unit keyword>] <value>` after establishing the target. ' +
        "Target is explicit: `fixtures` (range/group) OR `use_selection: true`. With `fixtures` the tool sends ClearSelection and then SELECTS exactly those fixtures (the selection changes; previously selected fixtures are not affected unless add_to_selection is true). " +
        "Never clears programmer values. Without `unit` the number is interpreted by the user profile's readout. " +
        "Programmer values cannot be read back (verification unavailable); the console's command feedback is the only check, and a fixture without the attribute is not detected. " +
        "Serialised against this server's other mutations only.",
      inputSchema: {
        ...targetShape,
        attribute: z.string().describe('Attribute name as grandMA3 shows it, e.g. "Dimmer", "Pan", "Tilt", "Zoom", "ColorRGB_R" (letters, digits, _ and . only).'),
        value: z.number().describe("Absolute value. Range depends on unit: percent/percent_fine 0..100, decimal8 0..255, decimal16 0..65535, decimal24 0..16777215, physical/natural any finite number."),
        unit: z
          .enum(ATTRIBUTE_UNIT_NAMES as [AttributeUnit, ...AttributeUnit[]])
          .optional()
          .describe("Value-type keyword sent with At: percent, percent_fine, physical (degrees/Hz/rpm), natural (attribute's natural readout), decimal8/16/24. Omit to use the console's current readout."),
      },
    },
    async (args) =>
      operation(async () => {
        const op = "set_attribute";
        const v = new Validator();
        const t = validateTarget(v, args);
        const attribute = v.check(() => attributeName("attribute", args.attribute));
        const unit = v.check(() => oneOf("unit", args.unit, ATTRIBUTE_UNIT_NAMES, { optional: true }));
        const rule = unit ? ATTRIBUTE_UNITS[unit] : { keyword: undefined, min: undefined, max: undefined, integer: false };
        const value = v.check(() => finiteNumber("value", args.value, { min: rule.min, max: rule.max, integer: rule.integer }));
        // A leading "-" in "At Absolute 5" territory is the Minus keyword; only the physical/natural
        // readouts legitimately take negative values (e.g. pan in degrees).
        if (value !== undefined && value < 0 && !(unit === "physical" || unit === "natural")) {
          v.fail(`value must not be negative for unit ${unit ?? "readout"} (got ${value}); use unit "physical" or "natural" for signed values`);
        }
        const baseTarget = { fixtures: args.fixtures, use_selection: args.use_selection, attribute: args.attribute, value: args.value, unit: args.unit };
        if (!v.ok || !t || !attribute || value === undefined) return validationFailure(op, baseTarget, v.errors);
        const command = attributeCommand(attribute, value, rule.keyword);
        const target = { ...t.target, attribute, value, unit: unit ?? "readout" };
        return ctx.mutations.run(async () => {
          const warnings: string[] = [];
          if (!unit) warnings.push("no unit given: the console interpreted the value with the user profile's current readout for this attribute");
          const plan: Array<{ name: string; run: StepFn }> = [{ name: "check_attribute", run: checkAttributeStep(bridge, attribute, warnings) }, ...targetSteps(bridge, t, warnings)];
          plan.push({ name: "set_attribute", run: () => commandStep(bridge, "set_attribute", command) });
          const { steps } = await runSteps(plan);
          return finish({
            operation: op,
            target,
            steps,
            warnings,
            selectionChanged: anySucceeded(steps, ["select", "clear_selection"]),
            programmerValuesChanged: anySucceeded(steps, ["set_attribute"]),
            extra: { command },
          });
        });
      }),
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    "gma3_set_color",
    {
      title: "Set RGB colour",
      description:
        'Set ColorRGB_R, ColorRGB_G and ColorRGB_B (each 0..100 %) in the programmer: three commands `Attribute "ColorRGB_R" At Absolute Percent <r>` etc., stopping at the first the console rejects (partial result). ' +
        "Target is explicit: `fixtures` OR `use_selection: true`. With `fixtures` the tool sends ClearSelection and then SELECTS exactly those fixtures (the selection changes; previously selected fixtures are not affected unless add_to_selection is true). Never clears programmer values. " +
        "Only the documented ColorRGB_* attributes are supported; fixtures without them are NOT detected before sending, the console's feedback is the only check and values cannot be read back (verification unavailable). " +
        "Serialised against this server's other mutations only.",
      inputSchema: {
        ...targetShape,
        red: z.number().describe("Red 0..100 (percent)"),
        green: z.number().describe("Green 0..100 (percent)"),
        blue: z.number().describe("Blue 0..100 (percent)"),
      },
    },
    async (args) =>
      operation(async () => {
        const op = "set_color";
        const v = new Validator();
        const t = validateTarget(v, args);
        const red = v.check(() => percent("red", args.red));
        const green = v.check(() => percent("green", args.green));
        const blue = v.check(() => percent("blue", args.blue));
        const baseTarget = { fixtures: args.fixtures, use_selection: args.use_selection, red: args.red, green: args.green, blue: args.blue };
        if (!v.ok || !t || red === undefined || green === undefined || blue === undefined) return validationFailure(op, baseTarget, v.errors);
        const channels: Array<[string, string, number]> = [
          ["set_red", "ColorRGB_R", red],
          ["set_green", "ColorRGB_G", green],
          ["set_blue", "ColorRGB_B", blue],
        ];
        const target = { ...t.target, red, green, blue, unit: "percent" };
        return ctx.mutations.run(async () => {
          const warnings: string[] = [];
          const plan = targetSteps(bridge, t, warnings);
          for (const [name, attr, val] of channels) plan.push({ name, run: () => commandStep(bridge, name, attributeCommand(attr, val, "Percent")) });
          const { steps } = await runSteps(plan);
          return finish({
            operation: op,
            target,
            steps,
            warnings,
            selectionChanged: anySucceeded(steps, ["select", "clear_selection"]),
            programmerValuesChanged: anySucceeded(steps, ["set_red", "set_green", "set_blue"]),
            extra: { attributes: ["ColorRGB_R", "ColorRGB_G", "ColorRGB_B"] },
          });
        });
      }),
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    "gma3_set_position",
    {
      title: "Set Pan/Tilt",
      description:
        'Set Pan and/or Tilt in the programmer with explicit units: unit "degrees" sends `Attribute "Pan" At Absolute Physical <v>`, unit "percent" sends `... At Absolute Percent <v>` (0..100). Pan first, then Tilt; stops at the first rejected command. ' +
        "Target is explicit: `fixtures` OR `use_selection: true`. With `fixtures` the tool sends ClearSelection and then SELECTS exactly those fixtures (the selection changes; previously selected fixtures are not affected unless add_to_selection is true). Never clears programmer values. " +
        "Values cannot be read back (verification unavailable); fixtures without Pan/Tilt are only detected if the console rejects the command. Serialised against this server's other mutations only.",
      inputSchema: {
        ...targetShape,
        pan: z.number().optional().describe("Pan value in `unit`. At least one of pan/tilt is required."),
        tilt: z.number().optional().describe("Tilt value in `unit`."),
        unit: z.enum(POSITION_UNITS).describe('"degrees" (Physical readout, negative values allowed) or "percent" (0..100). Required.'),
      },
    },
    async (args) =>
      operation(async () => {
        const op = "set_position";
        const v = new Validator();
        const t = validateTarget(v, args);
        const unit = v.check(() => oneOf("unit", args.unit, POSITION_UNITS));
        const range = unit === "percent" ? { min: 0, max: 100 } : { min: -720, max: 720 };
        const pan = v.check(() => finiteNumber("pan", args.pan, { ...range, optional: true }));
        const tilt = v.check(() => finiteNumber("tilt", args.tilt, { ...range, optional: true }));
        if (args.pan === undefined && args.tilt === undefined) v.fail("at least one of pan, tilt is required");
        const baseTarget = { fixtures: args.fixtures, use_selection: args.use_selection, pan: args.pan, tilt: args.tilt, unit: args.unit };
        if (!v.ok || !t || !unit) return validationFailure(op, baseTarget, v.errors);
        const keyword = unit === "degrees" ? "Physical" : "Percent";
        const target: Record<string, unknown> = { ...t.target, unit };
        if (pan !== undefined) target.pan = pan;
        if (tilt !== undefined) target.tilt = tilt;
        return ctx.mutations.run(async () => {
          const warnings: string[] = [];
          const plan = targetSteps(bridge, t, warnings);
          if (pan !== undefined) plan.push({ name: "set_pan", run: () => commandStep(bridge, "set_pan", attributeCommand("Pan", pan, keyword)) });
          if (tilt !== undefined) plan.push({ name: "set_tilt", run: () => commandStep(bridge, "set_tilt", attributeCommand("Tilt", tilt, keyword)) });
          const { steps } = await runSteps(plan);
          return finish({
            operation: op,
            target,
            steps,
            warnings,
            selectionChanged: anySucceeded(steps, ["select", "clear_selection"]),
            programmerValuesChanged: anySucceeded(steps, ["set_pan", "set_tilt"]),
            extra: { valueType: keyword },
          });
        });
      }),
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    "gma3_clear_programmer",
    {
      title: "Clear selection / programmer",
      description:
        'Explicit clear with a required mode: "selection" sends ClearSelection (deselects fixtures, keeps all programmer values); "active" sends ClearActive (deactivates values, keeps selection and values); ' +
        '"all" sends ClearAll (clears the selection AND discards every programmer value). Nothing is implied: one command per call. ' +
        "Verifies Selection.CountTotalSelected == 0 for selection/all; programmer values cannot be read back (unavailable for active). Serialised against this server's other mutations only.",
      inputSchema: {
        mode: z.enum(CLEAR_MODE_NAMES as [ClearMode, ...ClearMode[]]).describe("selection = ClearSelection, active = ClearActive, all = ClearAll"),
      },
    },
    async (args) =>
      operation(async () => {
        const op = "clear_programmer";
        const v = new Validator();
        const mode = v.check(() => oneOf("mode", args.mode, CLEAR_MODE_NAMES));
        if (!v.ok || !mode) return validationFailure(op, { mode: args.mode }, v.errors);
        const spec = CLEAR_MODES[mode];
        return ctx.mutations.run(async () => {
          const { steps } = await runSteps([{ name: "clear", run: () => commandStep(bridge, "clear", spec.command) }]);
          const readBack: StepResult[] = [];
          let verification: Verification = { status: "not_requested" };
          let count: SelectionCount | null = null;
          if (steps[0].status === "succeeded") {
            if (mode === "active") verification = unavailable(VALUE_UNAVAILABLE, "programmer values");
            else ({ verification, count } = await verifySelection(bridge, true, readBack));
          }
          const result = buildResult({
            operation: op,
            target: { mode, command: spec.command },
            steps,
            verification,
            warnings: [SERIALISATION_NOTE],
            extra: {
              effect: spec.effect,
              selectionChanged: steps[0].status === "succeeded" && mode !== "active",
              programmerValuesChanged: steps[0].status === "succeeded" && mode !== "selection",
              selectionCount: count?.total ?? null,
            },
          });
          result.steps.push(...readBack);
          return result;
        });
      }),
  );
};
