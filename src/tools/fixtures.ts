/**
 * FR-03: dedicated fixture programming tools.
 *
 *   gma3_select            select fixtures by range or group
 *   gma3_set_attribute     set one attribute on an explicit target
 *   gma3_set_color         set ColorRGB_R/G/B (0..100 %) on an explicit target
 *   gma3_set_position      set Pan/Tilt in explicit units on an explicit target
 *   gma3_clear_programmer  ClearSelection / ClearActive / ClearAll, explicitly
 *   gma3_set_attributes    several attributes and/or intensity on one target in one call (SU-05)
 *   gma3_apply_preset      At Preset on an explicit target, verified by the programmer's preset link (SU-05)
 *   gma3_release_attributes  Off Attribute on an explicit target, verified for collateral (SU-05)
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
 * Value verification reads the programmer back through the `programmer` op (FR-08) and compares
 * per fixture in the unit that was sent, using each row's channel-function range and readout; small
 * explicit targets are pre-checked against the fixture type's attribute list (`fixtureAttributes`,
 * FR-07). Selection read-back uses Selection.CountTotalSelected via `objects`.
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

const VALUE_UNAVAILABLE = "programmer read-back was not performed";

/** Tolerance for programmer read-back, in percent of the attribute range (8-bit DMX quantisation is 0.39 %). */
const VERIFY_TOLERANCE_PERCENT = 0.5;
/** Follow-up programmer scans per call for fixtures whose values live on their cells (compound fixtures). */
const MAX_FOLLOWUP_SCANS = 8;
/** Explicit targets with at most this many fixtures are pre-checked against the fixture-type attributes. */
const MAX_PRECHECK_FIXTURES = 8;

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
function resolveTargetStep(bridge: Gma3Bridge, selection: string, resolved?: { fixtures: ResolvedFixture[]; total: number }): StepFn {
  return () =>
    readStep(bridge, "resolve_target", "objects", { ref: selection, fields: ["FID", "Name", "FixtureType"], limit: MAX_PRECHECK_FIXTURES + 1 }, (result) => {
      const res = result as { total?: number; items?: Array<{ name?: string; class?: string; fields?: Record<string, unknown> }> } | null;
      const total = res && typeof res.total === "number" ? res.total : 0;
      if (total < 1) return { name: "resolve_target", kind: "read", status: "failed", op: "objects", error: `no objects match ${JSON.stringify(selection)}; nothing was sent`, detail: { total } };
      if (resolved) {
        resolved.total = total;
        resolved.fixtures = (res?.items ?? []).map((i) => ({
          name: i.name ?? null,
          class: i.class ?? null,
          fid: i.fields?.FID === undefined || i.fields?.FID === null ? null : String(i.fields.FID),
          fixtureType: i.fields?.FixtureType === undefined || i.fields?.FixtureType === null ? null : String(i.fields.FixtureType),
        }));
      }
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
function targetSteps(bridge: Gma3Bridge, t: ResolvedTarget, warnings: string[], resolved?: { fixtures: ResolvedFixture[]; total: number }): Array<{ name: string; run: StepFn }> {
  if (t.selection === null) {
    return [{ name: "check_selection", run: checkSelectionStep(bridge, warnings) }];
  }
  const plan: Array<{ name: string; run: StepFn }> = [{ name: "resolve_target", run: resolveTargetStep(bridge, t.selection, resolved) }];
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

function finish(o: {
  operation: string;
  target: Record<string, unknown>;
  steps: StepResult[];
  warnings: string[];
  selectionChanged: boolean;
  programmerValuesChanged: boolean;
  verification?: Verification;
  /** Read-back steps, appended after the outcome is computed so they never change it. */
  readBackSteps?: StepResult[];
  extra?: Record<string, unknown>;
}): OperationResult {
  const result = buildResult({
    operation: o.operation,
    target: o.target,
    steps: o.steps,
    verification: o.verification ?? unavailable(VALUE_UNAVAILABLE, "programmer values"),
    warnings: [...o.warnings, SERIALISATION_NOTE],
    extra: { selectionChanged: o.selectionChanged, programmerValuesChanged: o.programmerValuesChanged, ...(o.extra ?? {}) },
  });
  if (o.readBackSteps?.length) result.steps.push(...o.readBackSteps);
  return result;
}

// ---------------------------------------------------------------------------
// Programmer read-back and fixture-type pre-check (FR-07 / FR-08 feeding FR-03)
// ---------------------------------------------------------------------------

interface ResolvedFixture {
  name: string | null;
  class: string | null;
  fid: string | null;
  fixtureType: string | null;
}

/** One value the setter asked the console to apply. */
interface Expectation {
  attribute: string;
  value: number;
  /** Unit the value was sent in. "readout" = no value-type keyword (the user profile's readout applies). */
  unit: AttributeUnit | "readout";
}

interface ProgrammerRow {
  fixture?: string | null;
  fid?: string | null;
  subfixtureIndex?: number;
  attribute?: string | null;
  value?: number;
  valueRaw?: number;
  stepCount?: number;
  physicalFrom?: number | null;
  physicalTo?: number | null;
  readout?: string | null;
  physicalUnit?: string | null;
  /** The preset a recall linked the channel to (bridge 0.27.0). */
  absPreset?: { name?: string | null; addrNative?: string | null } | null;
}

interface ProgrammerResult {
  rows?: ProgrammerRow[];
  total?: number;
  count?: number;
  coverage?: { complete?: boolean; scannedFixtures?: number; totalFixtures?: number; scannedChannels?: number };
  scannedFixtures?: ScannedFixture[];
  fixturesTruncated?: boolean;
  limitations?: string[];
}

interface ScannedFixture {
  subfixtureIndex?: number;
  fid?: string | null;
  name?: string | null;
  rootFid?: string | null;
  /** Attribute names this (sub)fixture has (plugin 0.3.4+). Absent on older plugins. */
  attributes?: string[];
}

/** Rows per request page and the hard cap on pages fetched before giving up on completeness. */
const PROGRAMMER_PAGE = 5000;
const PROGRAMMER_MAX_PAGES = 10;

/**
 * Read a programmer scan completely: the op paginates `rows`, so every page is fetched until the
 * returned rows reach `total`. Returns the merged result, or a reason when it could not be completed.
 */
async function readProgrammerPages(bridge: Gma3Bridge, args: Record<string, unknown>): Promise<{ result: ProgrammerResult } | { reason: string; partial?: ProgrammerResult }> {
  // Every page is a fresh scan on the console, so each one reports its own coverage and fixture
  // list. A page that is incomplete or truncated makes the whole read unavailable, whatever the
  // first page said; the merged result carries the strictest flags and every limitation seen.
  const first = (await bridge.request("programmer", { ...args, limit: PROGRAMMER_PAGE, offset: 0 })) as ProgrammerResult;
  const rows = [...(first.rows ?? [])];
  const total = typeof first.total === "number" ? first.total : rows.length;
  const limitations = [...(first.limitations ?? [])];
  let complete = first.coverage?.complete !== false;
  let truncated = first.fixturesTruncated === true;
  const merged = (): ProgrammerResult => ({
    ...first,
    rows,
    count: rows.length,
    coverage: { ...(first.coverage ?? {}), complete },
    fixturesTruncated: truncated,
    limitations: [...new Set(limitations)],
  });
  let pages = 1;
  while (rows.length < total) {
    if (pages >= PROGRAMMER_MAX_PAGES) {
      return { reason: `the programmer scan returned ${total} rows but only ${rows.length} were fetched within ${PROGRAMMER_MAX_PAGES} pages`, partial: merged() };
    }
    const page = (await bridge.request("programmer", { ...args, limit: PROGRAMMER_PAGE, offset: rows.length })) as ProgrammerResult;
    pages++;
    limitations.push(...(page.limitations ?? []));
    if (page.coverage?.complete === false) {
      complete = false;
      return { reason: `page ${pages} of the programmer scan reported incomplete coverage: ${(page.limitations ?? []).join("; ") || "coverage not complete"}`, partial: merged() };
    }
    if (page.fixturesTruncated === true) {
      truncated = true;
      return { reason: `page ${pages} of the programmer scan reported a truncated fixture list`, partial: merged() };
    }
    const got = page.rows ?? [];
    if (got.length === 0) return { reason: `the programmer scan reported ${total} rows but page ${pages} was empty after ${rows.length}`, partial: merged() };
    rows.push(...got);
    if (typeof page.total === "number" && page.total !== total) return { reason: `the programmer changed while it was being read (${total} rows, then ${page.total})`, partial: merged() };
  }
  return { result: merged() };
}

/** Is this the bridge's "unknown op" error, i.e. the plugin predates the inspection ops? */
const isUnknownOp = (err: unknown): boolean => err instanceof Error && /unknown op/i.test(err.message);

/**
 * Translate an expected value into percent of the attribute range, using the row's channel
 * function range and readout when the unit needs them. Returns a reason when it cannot.
 */
export function expectedPercent(exp: Expectation, row: ProgrammerRow): { percent: number } | { reason: string } {
  const physical = (): { percent: number } | { reason: string } => {
    const from = row.physicalFrom;
    const to = row.physicalTo;
    if (typeof from !== "number" || typeof to !== "number") return { reason: `the physical range of ${exp.attribute} is not available for this fixture` };
    if (to === from) return { reason: `the physical range of ${exp.attribute} is empty (${from}..${to})` };
    return { percent: ((exp.value - from) / (to - from)) * 100 };
  };
  switch (exp.unit) {
    case "percent":
    case "percent_fine":
      return { percent: exp.value };
    case "decimal8":
      return { percent: (exp.value / 255) * 100 };
    case "decimal16":
      return { percent: (exp.value / 65535) * 100 };
    case "decimal24":
      return { percent: (exp.value / 16777215) * 100 };
    case "physical":
      return physical();
    case "natural":
    case "readout": {
      const readout = (row.readout ?? "").toLowerCase();
      if (readout === "percent" || readout === "percentfine") return { percent: exp.value };
      if (readout === "physical") return physical();
      return { reason: `readout ${JSON.stringify(row.readout ?? null)} of ${exp.attribute} cannot be interpreted; pass an explicit unit` };
    }
  }
}

interface FixtureVerdict {
  key: string;
  label: string;
  problems: string[];
  unavailable: string[];
  rowsChecked: number;
  /** Subfixtures that have the attribute(s) and were therefore judged. */
  cellsJudged: number;
}

const hasAttribute = (entry: ScannedFixture, attribute: string): boolean => (entry.attributes ?? []).some((a) => a.toLowerCase() === attribute.toLowerCase());

/**
 * Judge one top-level fixture: every scanned (sub)fixture that HAS an expected attribute must hold a
 * matching row for it. A sibling cell's value never satisfies another cell, cells that do not have
 * the attribute are not judged, and a fixture none of whose (sub)fixtures has the attribute is a
 * mismatch. `entries` are the scanned (sub)fixtures of this fixture; `rowsByIndex` their rows.
 */
function judgeFixture(label: string, key: string, entries: ScannedFixture[], rowsByIndex: Map<number, ProgrammerRow[]>, expectations: Expectation[]): FixtureVerdict {
  const verdict: FixtureVerdict = { key, label, problems: [], unavailable: [], rowsChecked: 0, cellsJudged: 0 };
  if (entries.some((e) => e.attributes === undefined)) {
    verdict.unavailable.push(`${label}: the plugin did not report which (sub)fixtures have the attribute (needs plugin 0.3.4 or newer)`);
    return verdict;
  }
  const judged = new Set<number>();
  for (const exp of expectations) {
    const applicable = entries.filter((e) => typeof e.subfixtureIndex === "number" && hasAttribute(e, exp.attribute));
    if (applicable.length === 0) {
      verdict.problems.push(`${label}: no (sub)fixture of it has attribute ${exp.attribute}`);
      continue;
    }
    for (const e of applicable) {
      judged.add(e.subfixtureIndex as number);
      const cell = entries.length > 1 ? ` cell ${e.name ?? e.subfixtureIndex}` : "";
      const matching = (rowsByIndex.get(e.subfixtureIndex as number) ?? []).filter((r) => (r.attribute ?? "").toLowerCase() === exp.attribute.toLowerCase());
      if (matching.length === 0) {
        verdict.problems.push(`${label}${cell}: no programmer value for ${exp.attribute} (the command did not apply to it)`);
        continue;
      }
      for (const row of matching) {
        verdict.rowsChecked++;
        if (typeof row.value !== "number") {
          verdict.problems.push(`${label}${cell}: ${exp.attribute} holds a ${row.stepCount ?? "multi"}-step phaser, not the static value ${exp.value}`);
          continue;
        }
        const want = expectedPercent(exp, row);
        if ("reason" in want) {
          verdict.unavailable.push(`${label}${cell}: ${want.reason}`);
          continue;
        }
        if (Math.abs(row.value - want.percent) > VERIFY_TOLERANCE_PERCENT) {
          const physical = typeof row.physicalFrom === "number" && typeof row.physicalTo === "number" ? ` = ${formatValue(row.physicalFrom + (row.value / 100) * (row.physicalTo - row.physicalFrom))} ${row.physicalUnit ?? ""}`.trimEnd() : "";
          verdict.problems.push(`${label}${cell}: ${exp.attribute} reads ${formatValue(row.value)} % of range${physical}, expected ${formatValue(want.percent)} % (${formatValue(exp.value)} ${exp.unit})`);
        }
      }
    }
  }
  verdict.cellsJudged = judged.size;
  return verdict;
}

/**
 * Read the programmer for the current selection (which, after the target steps, is exactly the
 * target) and compare every selected fixture's values with what was sent, in the unit it was sent
 * in. Every (sub)fixture that has an expected attribute is judged on its own rows. A compound
 * fixture appears in the selection only as its parent while the values live on its cells, so a
 * fixture whose scanned entry lacks the attribute gets one follow-up scan of itself and its cells.
 *
 * Verification is `matched` only when every applicable (sub)fixture holds a matching row and every
 * scan was complete and fully paginated; `mismatched` on any wrong or missing value or a fixture
 * without the attribute; `unavailable` when a read could not be completed or interpreted.
 */
async function verifyProgrammer(bridge: Gma3Bridge, expectations: Expectation[], steps: StepResult[], warnings: string[]): Promise<{ verification: Verification; summary: Record<string, unknown> }> {
  const checked = `programmer values of the selected fixtures (${expectations.map((e) => `${e.attribute} = ${formatValue(e.value)} ${e.unit}`).join(", ")}), tolerance ${VERIFY_TOLERANCE_PERCENT} % of range`;
  const unavailableReasons: string[] = [];
  let primary: ProgrammerResult;
  try {
    const read = await readProgrammerPages(bridge, { scope: "selection" });
    if ("reason" in read) {
      steps.push({ name: "read_programmer", kind: "read", status: "failed", op: "programmer", error: read.reason });
      return { verification: unavailable(read.reason, checked), summary: { performed: true, complete: false } };
    }
    primary = read.result;
    steps.push({ name: "read_programmer", kind: "read", status: "succeeded", op: "programmer", detail: { rows: primary.total, coverage: primary.coverage } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    steps.push({ name: "read_programmer", kind: "read", status: "failed", op: "programmer", error: message });
    if (isUnknownOp(err)) {
      return { verification: unavailable("the bridge plugin predates the programmer op (needs plugin 0.3.4 or newer); re-import it to enable value read-back", checked), summary: { performed: false } };
    }
    return { verification: unavailable(`programmer read-back failed: ${message}`, checked), summary: { performed: false } };
  }
  const limitations = [...(primary.limitations ?? [])];
  const indexRows = (rows: ProgrammerRow[]): Map<number, ProgrammerRow[]> => {
    const m = new Map<number, ProgrammerRow[]>();
    for (const r of rows) {
      if (typeof r.subfixtureIndex !== "number") continue;
      const list = m.get(r.subfixtureIndex) ?? [];
      list.push(r);
      m.set(r.subfixtureIndex, list);
    }
    return m;
  };
  const primaryRows = indexRows(primary.rows ?? []);
  const scanned = primary.scannedFixtures ?? [];
  if (primary.coverage && primary.coverage.complete === false) unavailableReasons.push(`the programmer scan of the selection was incomplete: ${(primary.limitations ?? []).join("; ") || "coverage not complete"}`);
  if (primary.fixturesTruncated) unavailableReasons.push("more selected fixtures than the programmer op lists per request; the values of the unlisted fixtures were not checked");
  if (scanned.length === 0 && unavailableReasons.length === 0) unavailableReasons.push("the selection was empty when the programmer was read");

  const verdicts: FixtureVerdict[] = [];
  const needFollowUp: ScannedFixture[] = [];
  for (const f of scanned) {
    if (typeof f.subfixtureIndex !== "number") continue;
    const label = `${f.name ?? "fixture"}${f.fid && f.fid !== "None" ? ` (Fixture ${f.fid})` : ""}`;
    // A parent that lacks an attribute may carry it on its cells: scan the fixture tree.
    if (f.attributes !== undefined && f.fid && f.fid !== "None" && !expectations.every((e) => hasAttribute(f, e.attribute))) {
      needFollowUp.push(f);
      continue;
    }
    verdicts.push(judgeFixture(label, String(f.subfixtureIndex), [f], primaryRows, expectations));
  }

  let followUps = 0;
  for (const f of needFollowUp) {
    const label = `${f.name ?? "fixture"} (Fixture ${f.fid})`;
    const key = String(f.subfixtureIndex);
    if (followUps >= MAX_FOLLOWUP_SCANS) {
      verdicts.push({ key, label, problems: [], unavailable: [`${label}: not re-scanned (more than ${MAX_FOLLOWUP_SCANS} fixtures needed a follow-up scan)`], rowsChecked: 0, cellsJudged: 0 });
      continue;
    }
    followUps++;
    try {
      const read = await readProgrammerPages(bridge, { scope: "fixtures", fixtures: `Fixture ${f.fid}` });
      if ("reason" in read) {
        steps.push({ name: "read_programmer_fixture", kind: "read", status: "failed", op: "programmer", error: read.reason });
        verdicts.push({ key, label, problems: [], unavailable: [`${label}: ${read.reason}`], rowsChecked: 0, cellsJudged: 0 });
        continue;
      }
      const sub = read.result;
      steps.push({ name: "read_programmer_fixture", kind: "read", status: "succeeded", op: "programmer", detail: { fixture: f.fid, rows: sub.total, coverage: sub.coverage } });
      limitations.push(...(sub.limitations ?? []));
      if ((sub.coverage && sub.coverage.complete === false) || sub.fixturesTruncated) {
        verdicts.push({ key, label, problems: [], unavailable: [`${label}: the programmer scan of the fixture and its cells was incomplete`], rowsChecked: 0, cellsJudged: 0 });
        continue;
      }
      verdicts.push(judgeFixture(label, key, sub.scannedFixtures ?? [], indexRows(sub.rows ?? []), expectations));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      steps.push({ name: "read_programmer_fixture", kind: "read", status: "failed", op: "programmer", error: message });
      verdicts.push({ key, label, problems: [], unavailable: [`${label}: follow-up programmer scan failed: ${message}`], rowsChecked: 0, cellsJudged: 0 });
    }
  }

  const problems = verdicts.flatMap((v) => v.problems);
  unavailableReasons.push(...verdicts.flatMap((v) => v.unavailable));
  const summary: Record<string, unknown> = {
    performed: true,
    fixturesChecked: verdicts.length,
    cellsJudged: verdicts.reduce((n, v) => n + v.cellsJudged, 0),
    rowsChecked: verdicts.reduce((n, v) => n + v.rowsChecked, 0),
    followUpScans: followUps,
    tolerancePercentOfRange: VERIFY_TOLERANCE_PERCENT,
    ...(limitations.length ? { limitations } : {}),
  };
  if (expectations.some((e) => e.unit === "readout")) {
    warnings.push("no unit was given, so the read-back assumed the user profile's readout is Natural (percent for Dimmer and colour, physical units for Pan/Tilt); if the profile uses another readout the comparison may mismatch");
  }
  const actual = { rows: (primary.rows ?? []).map((r) => ({ fixture: r.fixture, fid: r.fid, attribute: r.attribute, value: r.value, physicalFrom: r.physicalFrom, physicalTo: r.physicalTo, readout: r.readout })) };
  if (problems.length) {
    return { verification: { status: "mismatched", checked, expected: expectations, actual, detail: problems.join("; ") }, summary };
  }
  if (unavailableReasons.length) {
    return { verification: unavailable(unavailableReasons.join("; "), checked), summary };
  }
  return { verification: { status: "matched", checked, expected: expectations, actual }, summary };
}

interface FixtureAttributesResult {
  name?: string;
  fid?: string;
  fixtureType?: string | null;
  total?: number;
  subfixtureCount?: number;
  attributes?: Array<{ attribute?: string | null }>;
  limitations?: string[];
}

/** Cells of a compound fixture inspected by the pre-check when the parent itself lacks an attribute. */
const MAX_PRECHECK_CELLS = 4;

/**
 * Attribute names of a fixture for the pre-check: the parent's own attributes plus, for a compound
 * fixture, those of its first cells (a 12-cell washer carries ColorRGB_* on the cells, not the parent).
 * Returns null when the plugin has no fixtureAttributes op.
 */
async function fixtureAttributeNames(bridge: Gma3Bridge, fid: string): Promise<{ names: Set<string>; fixtureType: string | null; cellsChecked: number; complete: boolean; gaps: string[] } | null> {
  const read = async (ref: string): Promise<FixtureAttributesResult> => (await bridge.request("fixtureAttributes", { ref, limit: 500 })) as FixtureAttributesResult;
  let parent: FixtureAttributesResult;
  try {
    parent = await read(`Fixture ${fid}`);
  } catch (err) {
    if (isUnknownOp(err)) return null;
    throw err;
  }
  const gaps: string[] = [];
  const names = new Set((parent.attributes ?? []).map((a) => (a.attribute ?? "").toLowerCase()));
  if ((parent.total ?? 0) > 500) gaps.push(`only the first 500 of ${parent.total} attributes were read`);
  const cells = parent.subfixtureCount ?? 0;
  let cellsChecked = 0;
  for (let i = 1; i <= Math.min(cells, MAX_PRECHECK_CELLS); i++) {
    try {
      const cell = await read(`Fixture ${fid}.${i}`);
      cellsChecked++;
      if ((cell.total ?? 0) > 500) gaps.push(`cell ${i}: only the first 500 of ${cell.total} attributes were read`);
      for (const a of cell.attributes ?? []) names.add((a.attribute ?? "").toLowerCase());
    } catch (err) {
      gaps.push(`cell ${i} could not be read (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (cells > MAX_PRECHECK_CELLS) gaps.push(`only ${MAX_PRECHECK_CELLS} of ${cells} cells were read`);
  return { names, fixtureType: parent.fixtureType ?? null, cellsChecked, complete: gaps.length === 0, gaps };
}

/**
 * Read-only pre-check for small explicit targets: every resolved fixture must list each attribute in
 * its fixture type (fixtureAttributes op). Fails before anything is sent when one does not. Skipped,
 * with a warning, for groups, for targets larger than MAX_PRECHECK_FIXTURES, and on an old plugin.
 */
function checkFixtureAttributesStep(bridge: Gma3Bridge, resolved: { fixtures: ResolvedFixture[]; total: number }, attributes: string[], warnings: string[]): StepFn {
  return async () => {
    const name = "check_fixture_attributes";
    const fixtures = resolved.fixtures.filter((f) => f.class === "Fixture" || f.class === "SubFixture");
    if (resolved.total > MAX_PRECHECK_FIXTURES) {
      warnings.push(`attribute pre-check skipped: the target resolves to ${resolved.total} objects (more than ${MAX_PRECHECK_FIXTURES}); unsupported fixtures are detected by the read-back instead`);
      return { name, kind: "read", status: "succeeded", op: "fixtureAttributes", detail: { skipped: "too many fixtures", total: resolved.total } };
    }
    if (fixtures.length === 0) {
      warnings.push("attribute pre-check skipped: the target did not resolve to fixtures (a group resolves to the group object); unsupported fixtures are detected by the read-back instead");
      return { name, kind: "read", status: "succeeded", op: "fixtureAttributes", detail: { skipped: "not fixtures" } };
    }
    const missing: string[] = [];
    const notEstablished: string[] = [];
    const checked: Array<{ fixture: string; attributes: number; cellsChecked: number; complete: boolean }> = [];
    for (const f of fixtures) {
      const ref = f.fid && f.fid !== "None" ? `Fixture ${f.fid}` : null;
      if (!ref) continue;
      let info: Awaited<ReturnType<typeof fixtureAttributeNames>>;
      try {
        info = await fixtureAttributeNames(bridge, f.fid as string);
      } catch (err) {
        return { name, kind: "read", status: "failed", op: "fixtureAttributes", error: `could not read the attributes of ${ref}: ${err instanceof Error ? err.message : String(err)}; nothing was sent` };
      }
      if (!info) {
        warnings.push("attribute pre-check skipped: the bridge plugin predates the fixtureAttributes op (needs plugin 0.3.0 or newer)");
        return { name, kind: "read", status: "succeeded", op: "fixtureAttributes", detail: { skipped: "old plugin" } };
      }
      checked.push({ fixture: ref, attributes: info.names.size, cellsChecked: info.cellsChecked, complete: info.complete });
      for (const a of attributes) {
        if (info.names.has(a.toLowerCase())) continue;
        const where = `${ref}${info.fixtureType ? ` (${info.fixtureType})` : ""}`;
        // Only a complete discovery can establish absence; a sampled one leaves it to the read-back.
        if (info.complete) missing.push(`${where} has no attribute ${a}${info.cellsChecked ? " (nor do its cells)" : ""}`);
        else notEstablished.push(`${where}: attribute ${a} was not found but discovery was partial (${info.gaps.join(", ")})`);
      }
    }
    if (missing.length) {
      return { name, kind: "read", status: "failed", op: "fixtureAttributes", error: `${missing.join("; ")}; nothing was sent`, detail: { checked, missing } };
    }
    if (notEstablished.length) {
      warnings.push(`attribute pre-check not established: ${notEstablished.join("; ")}; the command was sent and the read-back decides`);
    }
    return { name, kind: "read", status: "succeeded", op: "fixtureAttributes", detail: { checked, ...(notEstablished.length ? { notEstablished } : {}) } };
  };
}

/** Shared tail of the three setters: optional programmer read-back inside the lock span. */
async function readBackValues(bridge: Gma3Bridge, verify: boolean, steps: StepResult[], expectations: Expectation[], mutated: boolean, warnings: string[]): Promise<{ verification: Verification; readBackSteps: StepResult[]; extra: Record<string, unknown> }> {
  const readBackSteps: StepResult[] = [];
  if (!verify) return { verification: { status: "not_requested" }, readBackSteps, extra: { programmerReadBack: { performed: false, reason: "verify: false" } } };
  if (!mutated) return { verification: unavailable("no set command was sent, so there is nothing to read back", "programmer values"), readBackSteps, extra: { programmerReadBack: { performed: false, reason: "no command sent" } } };
  if (steps.some((s) => s.status === "unknown")) warnings.push("a command's outcome was unknown; the read-back shows the console state afterwards but the outcome stays unknown");
  const { verification, summary } = await verifyProgrammer(bridge, expectations, readBackSteps, warnings);
  return { verification, readBackSteps, extra: { programmerReadBack: summary } };
}

/** Did any mutation (cmd step) actually succeed? */
const anySucceeded = (steps: StepResult[], names: string[]): boolean => steps.some((s) => names.includes(s.name) && s.status === "succeeded");


// ---------------------------------------------------------------------------
// SU-05: preset links and release read-back (docs/probes/su-05-programmer-macos-2.5.1.md)
// ---------------------------------------------------------------------------

/**
 * After `At Preset`: every selected fixture, or its cells, must hold at least one programmer value linked to the
 * preset (the channel's abs_preset, bridge 0.27.0). A fixture whose scanned entry holds none gets one follow-up scan of
 * itself and its cells (a compound fixture's values live on its cells). The link proves the recall reached the
 * channel; it also survives a later manual value, so the check belongs right after the recall.
 */
async function verifyPresetLink(bridge: Gma3Bridge, preset: { addrNative: string; label: string }, steps: StepResult[]): Promise<{ verification: Verification; summary: Record<string, unknown> }> {
  const checked = `every selected fixture (or its cells) holds programmer values linked to ${preset.label}`;
  const linkedRows = (rows: ProgrammerRow[]) => rows.filter((r) => r.absPreset?.addrNative === preset.addrNative);
  let primary: ProgrammerResult;
  try {
    const read = await readProgrammerPages(bridge, { scope: "selection" });
    if ("reason" in read) {
      steps.push({ name: "read_programmer", kind: "read", status: "failed", op: "programmer", error: read.reason });
      return { verification: unavailable(read.reason, checked), summary: { performed: true, complete: false } };
    }
    primary = read.result;
    steps.push({ name: "read_programmer", kind: "read", status: "succeeded", op: "programmer", detail: { rows: primary.total, coverage: primary.coverage } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    steps.push({ name: "read_programmer", kind: "read", status: "failed", op: "programmer", error: message });
    return { verification: unavailable(`programmer read-back failed: ${message}`, checked), summary: { performed: false } };
  }
  const rows = primary.rows ?? [];
  if (rows.length && rows.every((r) => r.absPreset === undefined)) {
    return { verification: unavailable("the bridge plugin does not report preset links (needs bridge 0.27.0); re-import it to verify a recall", checked), summary: { performed: true } };
  }
  const problems: string[] = [];
  const unavailableReasons: string[] = [];
  const perFixture: Array<{ fixture: string; linkedValues: number; attributes: string[] }> = [];
  if (primary.coverage?.complete === false || primary.fixturesTruncated) unavailableReasons.push("the programmer scan of the selection was incomplete");
  const scanned = primary.scannedFixtures ?? [];
  if (scanned.length === 0) unavailableReasons.push("the selection was empty when the programmer was read");
  let followUps = 0;
  for (const f of scanned) {
    if (typeof f.subfixtureIndex !== "number") continue;
    const label = `${f.name ?? "fixture"}${f.fid && f.fid !== "None" ? ` (Fixture ${f.fid})` : ""}`;
    let linked = linkedRows(rows.filter((r) => r.subfixtureIndex === f.subfixtureIndex));
    if (linked.length === 0 && f.fid && f.fid !== "None") {
      if (followUps >= MAX_FOLLOWUP_SCANS) {
        unavailableReasons.push(`${label}: not re-scanned (more than ${MAX_FOLLOWUP_SCANS} fixtures needed a follow-up scan)`);
        continue;
      }
      followUps++;
      const sub = await readProgrammerPages(bridge, { scope: "fixtures", fixtures: `Fixture ${f.fid}` }).catch((err: unknown) => ({ reason: err instanceof Error ? err.message : String(err) }));
      if ("reason" in sub) {
        unavailableReasons.push(`${label}: ${sub.reason}`);
        continue;
      }
      // An incomplete or truncated follow-up scan proves nothing, even when it holds a linked row.
      if (sub.result.coverage?.complete === false || sub.result.fixturesTruncated) {
        steps.push({ name: "read_programmer_fixture", kind: "read", status: "failed", op: "programmer", error: "the scan of the fixture and its cells was incomplete", detail: { fixture: f.fid } });
        unavailableReasons.push(`${label}: the programmer scan of the fixture and its cells was incomplete`);
        continue;
      }
      steps.push({ name: "read_programmer_fixture", kind: "read", status: "succeeded", op: "programmer", detail: { fixture: f.fid, rows: sub.result.total } });
      linked = linkedRows(sub.result.rows ?? []);
    }
    if (linked.length === 0) problems.push(`${label}: no programmer value is linked to ${preset.label} (the preset holds no value this fixture takes, or the recall did not reach it)`);
    else perFixture.push({ fixture: label, linkedValues: linked.length, attributes: [...new Set(linked.map((r) => r.attribute ?? "?"))] });
  }
  const summary = { performed: true, fixturesChecked: perFixture.length + problems.length, followUpScans: followUps, fixtures: perFixture };
  if (problems.length) return { verification: { status: "mismatched", checked, detail: problems.join("; ") }, summary };
  if (unavailableReasons.length) return { verification: unavailable(unavailableReasons.join("; "), checked), summary };
  return { verification: { status: "matched", checked, actual: perFixture }, summary };
}

interface ProgrammerSnapshot {
  /** A label per (sub)fixture index, for messages. */
  labelByIndex: Map<number, string>;
  /**
   * "index|attribute" -> the row's whole programmer content: value, raw value, relative, step count, masks, every
   * step (values, layers, integrated preset), phaser timing and the preset links. A multi-step phaser has no single
   * value, so comparing `value` alone would miss a changed phaser.
   */
  values: Map<string, string>;
  complete: boolean;
  reason?: string;
}

/** The parts of a programmer row that make up its content (the op's metadata, e.g. ranges, is left out). */
function rowContent(row: Record<string, unknown>): string {
  const pick = (k: string) => (row[k] === undefined ? null : row[k]);
  return JSON.stringify({ value: pick("value"), valueRaw: pick("valueRaw"), relative: pick("relative"), stepCount: pick("stepCount"), masks: pick("masks"), steps: pick("steps"), phaser: pick("phaser"), absPreset: pick("absPreset"), relPreset: pick("relPreset") });
}

async function snapshotProgrammer(bridge: Gma3Bridge): Promise<ProgrammerSnapshot> {
  const read = await readProgrammerPages(bridge, { scope: "all" });
  if ("reason" in read) return { labelByIndex: new Map(), values: new Map(), complete: false, reason: read.reason };
  const r = read.result;
  const labelByIndex = new Map<number, string>();
  for (const e of r.scannedFixtures ?? []) if (typeof e.subfixtureIndex === "number") labelByIndex.set(e.subfixtureIndex, `${e.name ?? "?"}${e.fid && e.fid !== "None" ? ` (Fixture ${e.fid})` : ""}`);
  const values = new Map<string, string>();
  for (const row of r.rows ?? []) if (typeof row.subfixtureIndex === "number") values.set(`${row.subfixtureIndex}|${row.attribute ?? "?"}`, rowContent(row as unknown as Record<string, unknown>));
  const complete = r.coverage?.complete !== false && !r.fixturesTruncated;
  return { labelByIndex, values, complete, ...(complete ? {} : { reason: "the programmer scan was incomplete" }) };
}

/**
 * The (sub)fixture indices of the current selection (after the target steps: exactly the target) and of everything
 * below them. A compound fixture is selected as its parent while its values live on its cells, whose own FID is
 * "None"; the scope "all" scan does not say which fixture such a cell belongs to, so the descendants come from a scope
 * "fixtures" scan of the selected FIDs (the bridge expands those to every cell).
 */
async function selectedTarget(bridge: Gma3Bridge): Promise<{ indices: Set<number>; fids: string[] } | { reason: string }> {
  const read = await readProgrammerPages(bridge, { scope: "selection" });
  if ("reason" in read) return { reason: read.reason };
  if (read.result.coverage?.complete === false || read.result.fixturesTruncated) return { reason: "the programmer scan of the selection was incomplete" };
  const indices = new Set<number>();
  const fids = new Set<string>();
  for (const e of read.result.scannedFixtures ?? []) {
    if (typeof e.subfixtureIndex === "number") indices.add(e.subfixtureIndex);
    if (e.fid && e.fid !== "None") fids.add(e.fid);
  }
  if (indices.size === 0) return { reason: "the selection is empty" };
  const list = [...fids];
  for (let i = 0; i < list.length; i += 50) {
    const sub = await readProgrammerPages(bridge, { scope: "fixtures", fixtures: `Fixture ${list.slice(i, i + 50).join(" + ")}` });
    if ("reason" in sub) return { reason: `the target's cells could not be listed: ${sub.reason}` };
    if (sub.result.coverage?.complete === false || sub.result.fixturesTruncated) return { reason: "the scan of the target's cells was incomplete" };
    for (const e of sub.result.scannedFixtures ?? []) if (typeof e.subfixtureIndex === "number") indices.add(e.subfixtureIndex);
  }
  return { indices, fids: list };
}

/**
 * After a release: no value of the released attributes (every value, for all) remains on the target (sub)fixtures,
 * the target's other values are unchanged, and every other fixture's programmer content is unchanged, with no row
 * removed or added (Off Attribute with an empty selection would hit every fixture, so collateral is checked).
 */
function judgeRelease(before: ProgrammerSnapshot, after: ProgrammerSnapshot, target: Set<number>, attributes: string[] | null): { verification: Verification; summary: Record<string, unknown> } {
  const checked = `${attributes ? attributes.join(", ") : "every value"} removed from the target fixtures (and their cells); every other programmer value, including phaser steps and timing, unchanged`;
  if (!before.complete || !after.complete) return { verification: unavailable(before.reason ?? after.reason ?? "incomplete programmer scan", checked), summary: { performed: true } };
  const wanted = attributes ? new Set(attributes.map((a) => a.toLowerCase())) : null;
  const label = (idx: number) => before.labelByIndex.get(idx) ?? after.labelByIndex.get(idx) ?? `index ${idx}`;
  const remaining: string[] = [];
  const collateral: string[] = [];
  let released = 0;
  for (const key of new Set([...before.values.keys(), ...after.values.keys()])) {
    const [idxText, attr] = key.split("|");
    const idx = Number(idxText);
    const was = before.values.get(key);
    const now = after.values.get(key);
    const how = was === undefined ? "was added" : now === undefined ? "was removed" : "changed";
    if (target.has(idx) && (wanted === null || wanted.has(attr.toLowerCase()))) {
      if (now !== undefined) remaining.push(`${label(idx)} ${attr}`);
      else if (was !== undefined) released++;
    } else if (was !== now) {
      collateral.push(`${label(idx)} ${attr} ${how}${target.has(idx) ? " (a target value that was not released)" : ""}`);
    }
  }
  const summary = { performed: true, valuesReleased: released, targetIndices: target.size };
  const problems = [...remaining.map((r) => `${r} is still in the programmer`), ...collateral];
  if (problems.length) return { verification: { status: "mismatched", checked, detail: problems.slice(0, 20).join("; ") + (problems.length > 20 ? `; ... ${problems.length - 20} more` : "") }, summary };
  return { verification: { status: "matched", checked, actual: summary }, summary };
}

/** `Preset 4.12` / `Preset 4."Name"` from a pool number and a preset number or name. */
export function presetRef(pool: number, preset: number | string): string {
  return typeof preset === "number" ? `Preset ${pool}.${preset}` : `Preset ${pool}."${preset}"`;
}

const MAX_ATTRIBUTES = 32;

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

const setterShape = {
  ...targetShape,
  verify: z
    .boolean()
    .optional()
    .describe(
      "Read the programmer back after setting (default true): every targeted fixture must hold the value, compared in the unit it was sent in (percent of the attribute range, tolerance 0.5 %). A fixture without the attribute is reported as a mismatch. Needs plugin 0.3.2 or newer; older plugins yield verification 'unavailable'.",
    ),
  check_attributes: z
    .boolean()
    .optional()
    .describe(
      `With \`fixtures\` resolving to at most ${MAX_PRECHECK_FIXTURES} fixtures (default true): check each fixture type's attribute list first and fail before sending when a fixture lacks the attribute. Skipped for groups and larger targets.`,
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
        "Small explicit targets are pre-checked against the fixture type's attribute list (check_attributes), and after setting, the programmer is read back and compared per fixture in the unit sent (verify); a fixture without the attribute is a mismatch, not a success. " +
        "Serialised against this server's other mutations only.",
      inputSchema: {
        ...setterShape,
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
        const verify = args.verify !== false;
        const preCheck = args.check_attributes !== false;
        return ctx.mutations.run(async () => {
          const warnings: string[] = [];
          if (!unit) warnings.push("no unit given: the console interpreted the value with the user profile's current readout for this attribute");
          const resolved = { fixtures: [] as ResolvedFixture[], total: 0 };
          const plan: Array<{ name: string; run: StepFn }> = [{ name: "check_attribute", run: checkAttributeStep(bridge, attribute, warnings) }, ...targetSteps(bridge, t, warnings, resolved)];
          if (preCheck && t.selection !== null) plan.splice(2, 0, { name: "check_fixture_attributes", run: checkFixtureAttributesStep(bridge, resolved, [attribute], warnings) });
          plan.push({ name: "set_attribute", run: () => commandStep(bridge, "set_attribute", command) });
          const { steps } = await runSteps(plan);
          const mutated = anySucceeded(steps, ["set_attribute"]) || steps.some((s) => s.name === "set_attribute" && s.status === "unknown");
          const rb = await readBackValues(bridge, verify, steps, [{ attribute, value, unit: unit ?? "readout" }], mutated, warnings);
          return finish({
            operation: op,
            target,
            steps,
            warnings,
            selectionChanged: anySucceeded(steps, ["select", "clear_selection"]),
            programmerValuesChanged: anySucceeded(steps, ["set_attribute"]),
            verification: rb.verification,
            readBackSteps: rb.readBackSteps,
            extra: { command, ...rb.extra },
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
        "Only the documented ColorRGB_* attributes are supported. Small explicit targets are pre-checked against the fixture type's attributes (check_attributes); after setting, the programmer is read back and each fixture's R, G and B are compared in percent (verify), so a fixture without RGB is a mismatch, not a success. " +
        "Serialised against this server's other mutations only.",
      inputSchema: {
        ...setterShape,
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
        const verify = args.verify !== false;
        const preCheck = args.check_attributes !== false;
        return ctx.mutations.run(async () => {
          const warnings: string[] = [];
          const resolved = { fixtures: [] as ResolvedFixture[], total: 0 };
          const plan = targetSteps(bridge, t, warnings, resolved);
          if (preCheck && t.selection !== null) plan.splice(1, 0, { name: "check_fixture_attributes", run: checkFixtureAttributesStep(bridge, resolved, channels.map((c) => c[1]), warnings) });
          for (const [name, attr, val] of channels) plan.push({ name, run: () => commandStep(bridge, name, attributeCommand(attr, val, "Percent")) });
          const { steps } = await runSteps(plan);
          const setNames = ["set_red", "set_green", "set_blue"];
          const mutated = steps.some((s) => setNames.includes(s.name) && (s.status === "succeeded" || s.status === "unknown"));
          // Verify only the components whose command was sent (succeeded or unknown).
          const expectations: Expectation[] = channels
            .filter(([name]) => steps.some((s) => s.name === name && (s.status === "succeeded" || s.status === "unknown")))
            .map(([, attr, val]) => ({ attribute: attr, value: val, unit: "percent" as const }));
          const rb = await readBackValues(bridge, verify, steps, expectations, mutated, warnings);
          return finish({
            operation: op,
            target,
            steps,
            warnings,
            selectionChanged: anySucceeded(steps, ["select", "clear_selection"]),
            programmerValuesChanged: anySucceeded(steps, setNames),
            verification: rb.verification,
            readBackSteps: rb.readBackSteps,
            extra: { attributes: ["ColorRGB_R", "ColorRGB_G", "ColorRGB_B"], ...rb.extra },
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
        "Small explicit targets are pre-checked against the fixture type's attributes (check_attributes); after setting, the programmer is read back and Pan/Tilt are compared per fixture in the unit sent, converting degrees through each fixture's physical range (verify). A fixture without Pan/Tilt is a mismatch, not a success. Serialised against this server's other mutations only.",
      inputSchema: {
        ...setterShape,
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
        const verify = args.verify !== false;
        const preCheck = args.check_attributes !== false;
        const axes: Array<[string, string, number | undefined]> = [
          ["set_pan", "Pan", pan],
          ["set_tilt", "Tilt", tilt],
        ];
        return ctx.mutations.run(async () => {
          const warnings: string[] = [];
          const resolved = { fixtures: [] as ResolvedFixture[], total: 0 };
          const plan = targetSteps(bridge, t, warnings, resolved);
          const wanted = axes.filter((a) => a[2] !== undefined);
          if (preCheck && t.selection !== null) plan.splice(1, 0, { name: "check_fixture_attributes", run: checkFixtureAttributesStep(bridge, resolved, wanted.map((a) => a[1]), warnings) });
          for (const [name, attr, val] of wanted) plan.push({ name, run: () => commandStep(bridge, name, attributeCommand(attr, val as number, keyword)) });
          const { steps } = await runSteps(plan);
          const setNames = ["set_pan", "set_tilt"];
          const mutated = steps.some((s) => setNames.includes(s.name) && (s.status === "succeeded" || s.status === "unknown"));
          const expectations: Expectation[] = wanted
            .filter(([name]) => steps.some((s) => s.name === name && (s.status === "succeeded" || s.status === "unknown")))
            .map(([, attr, val]) => ({ attribute: attr, value: val as number, unit: unit === "degrees" ? ("physical" as const) : ("percent" as const) }));
          const rb = await readBackValues(bridge, verify, steps, expectations, mutated, warnings);
          return finish({
            operation: op,
            target,
            steps,
            warnings,
            selectionChanged: anySucceeded(steps, ["select", "clear_selection"]),
            programmerValuesChanged: anySucceeded(steps, setNames),
            verification: rb.verification,
            readBackSteps: rb.readBackSteps,
            extra: { valueType: keyword, ...rb.extra },
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
  // -------------------------------------------------------------------------
  // SU-05
  // -------------------------------------------------------------------------
  server.registerTool(
    "gma3_set_attributes",
    {
      title: "Set several attributes (a look) in one call",
      description:
        'Set a whole look on one target in one call: intensity (`At <value>`, percent) and/or several attributes, each `Attribute "<name>" At Absolute [<unit keyword>] <value>`, in the order given. Stops at the first command the console rejects (partial result). ' +
        "Target is explicit: `fixtures` OR `use_selection: true`; with `fixtures`, ClearSelection and then a select (see gma3_set_attribute). Never clears programmer values. " +
        "Note: setting one colour attribute activates the fixture's whole colour group in the programmer (the other mix channels at their defaults), so the programmer can hold more rows than attributes sent. " +
        "Small explicit targets are pre-checked against the fixture types' attributes (check_attributes); the programmer is read back and every targeted fixture (and cell) is compared per attribute in the unit sent (verify), as gma3_set_attribute does. Serialised against this server's other mutations only.",
      inputSchema: {
        ...setterShape,
        intensity: z.number().optional().describe("Intensity 0..100 percent, sent as `At <value>` (the Dimmer attribute)."),
        values: z
          .array(
            z.object({
              attribute: z.string().describe('Attribute name, e.g. "Pan", "ColorRGB_W", "Gobo1", "Shutter1".'),
              value: z.number().describe("Absolute value in unit."),
              unit: z.enum(ATTRIBUTE_UNIT_NAMES as [AttributeUnit, ...AttributeUnit[]]).optional().describe("percent, percent_fine, physical, natural, decimal8/16/24; omit for the console's readout."),
            }),
          )
          .optional()
          .describe(`Attributes to set (up to ${MAX_ATTRIBUTES}), each once.`),
      },
    },
    async (args) =>
      operation(async () => {
        const op = "set_attributes";
        const v = new Validator();
        const t = validateTarget(v, args);
        const intensity = args.intensity === undefined ? undefined : v.check(() => percent("intensity", args.intensity));
        const values: Array<{ attribute: string; value: number; unit?: AttributeUnit }> = [];
        const list = Array.isArray(args.values) ? args.values : [];
        if (args.values !== undefined && !Array.isArray(args.values)) v.fail("values must be a list");
        if (list.length > MAX_ATTRIBUTES) v.fail(`at most ${MAX_ATTRIBUTES} attributes per call`);
        list.forEach((e, i) => {
          const attribute = v.check(() => attributeName(`values[${i}].attribute`, e?.attribute));
          const unit = v.check(() => oneOf(`values[${i}].unit`, e?.unit, ATTRIBUTE_UNIT_NAMES, { optional: true }));
          const rule = unit ? ATTRIBUTE_UNITS[unit] : { min: undefined, max: undefined, integer: false };
          const value = v.check(() => finiteNumber(`values[${i}].value`, e?.value, { min: rule.min, max: rule.max, integer: rule.integer }));
          if (value !== undefined && value < 0 && !(unit === "physical" || unit === "natural")) v.fail(`values[${i}].value must not be negative for unit ${unit ?? "readout"}; use physical or natural for signed values`);
          if (attribute && values.some((x) => x.attribute.toLowerCase() === attribute.toLowerCase())) v.fail(`attribute ${attribute} appears twice`);
          if (attribute && intensity !== undefined && attribute.toLowerCase() === "dimmer") v.fail("Dimmer and intensity are the same attribute: give one of them");
          if (attribute && value !== undefined) values.push({ attribute, value, ...(unit ? { unit } : {}) });
        });
        if (intensity === undefined && list.length === 0) v.fail("give intensity and/or values");
        const baseTarget = { fixtures: args.fixtures, use_selection: args.use_selection, intensity: args.intensity, values: args.values };
        if (!v.ok || !t) return validationFailure(op, baseTarget, v.errors);
        const commands: Array<{ name: string; attribute: string; value: number; unit: AttributeUnit | "readout"; command: string }> = [];
        if (intensity !== undefined) commands.push({ name: "set_intensity", attribute: "Dimmer", value: intensity, unit: "percent", command: `At ${formatValue(intensity)}` });
        values.forEach((x, i) => commands.push({ name: `set_${i + 1}_${x.attribute}`, attribute: x.attribute, value: x.value, unit: x.unit ?? "readout", command: attributeCommand(x.attribute, x.value, x.unit ? ATTRIBUTE_UNITS[x.unit].keyword : undefined) }));
        const target = { ...t.target, values: commands.map(({ attribute, value, unit }) => ({ attribute, value, unit })) };
        const verify = args.verify !== false;
        const preCheck = args.check_attributes !== false;
        return ctx.mutations.run(async () => {
          const warnings: string[] = [];
          if (values.some((x) => !x.unit)) warnings.push("a value without unit was interpreted with the user profile's current readout for its attribute");
          const resolved = { fixtures: [] as ResolvedFixture[], total: 0 };
          const plan: Array<{ name: string; run: StepFn }> = values.map((x) => ({ name: `check_attribute_${x.attribute}`, run: checkAttributeStep(bridge, x.attribute, warnings) }));
          const targetPlan = targetSteps(bridge, t, warnings, resolved);
          plan.push(...targetPlan);
          if (preCheck && t.selection !== null) plan.splice(values.length + 1, 0, { name: "check_fixture_attributes", run: checkFixtureAttributesStep(bridge, resolved, commands.map((c) => c.attribute), warnings) });
          for (const c of commands) plan.push({ name: c.name, run: () => commandStep(bridge, c.name, c.command) });
          const { steps } = await runSteps(plan);
          const sent = commands.filter((c) => steps.some((s) => s.name === c.name && (s.status === "succeeded" || s.status === "unknown")));
          const rb = await readBackValues(bridge, verify, steps, sent.map(({ attribute, value, unit }) => ({ attribute, value, unit })), sent.length > 0, warnings);
          return finish({
            operation: op,
            target,
            steps,
            warnings,
            selectionChanged: anySucceeded(steps, ["select", "clear_selection"]),
            programmerValuesChanged: anySucceeded(steps, commands.map((c) => c.name)),
            verification: rb.verification,
            readBackSteps: rb.readBackSteps,
            extra: { commands: commands.map((c) => c.command), ...rb.extra },
          });
        });
      }),
  );

  server.registerTool(
    "gma3_apply_preset",
    {
      title: "Apply a preset to fixtures",
      description:
        "Recall a stored preset into the programmer for an explicit target: `At Preset <pool>.<number>` (or a preset by name). Target: `fixtures` OR `use_selection: true` (with `fixtures`, ClearSelection and a select first). " +
        "Pre-checks (nothing sent on failure): the preset exists, and the target is not empty. Both matter: the console answers OK and changes nothing for a missing preset or an empty selection. " +
        "A preset applies to every fixture that has its attributes, whatever type it was stored from. Read-back: every selected fixture (or its cells) must hold programmer values linked to the preset (the channel's preset link; needs bridge 0.27.0); a fixture the preset holds nothing for is a mismatch. Never clears programmer values.",
      inputSchema: {
        ...targetShape,
        pool: z.number().describe("Preset pool number: 1 Dimmer, 2 Position, 3 Gobo, 4 Color, 5 Beam, 6 Focus, 7 Control, 8 Shapers, 9 Video, 21.. All."),
        preset: z.union([z.number(), z.string()]).describe("Preset number in the pool, or its name."),
        verify: z.boolean().optional().describe("Read the programmer back and check the preset links (default true)."),
      },
    },
    async (args) =>
      operation(async () => {
        const op = "apply_preset";
        const v = new Validator();
        const t = validateTarget(v, args);
        const pool = v.check(() => finiteNumber("pool", args.pool, { integer: true, min: 1, max: 9999 }));
        let preset: number | string | undefined;
        if (typeof args.preset === "number") preset = v.check(() => finiteNumber("preset", args.preset, { integer: true, min: 1, max: 99999 }));
        else if (typeof args.preset === "string" && args.preset.trim() !== "" && !/["\u0000-\u001f]/.test(args.preset)) preset = args.preset.trim();
        else v.fail("preset must be a number or a name without quotes");
        if (!v.ok || !t || pool === undefined || preset === undefined) return validationFailure(op, { fixtures: args.fixtures, use_selection: args.use_selection, pool: args.pool, preset: args.preset }, v.errors);
        const ref = presetRef(pool, preset);
        const command = `At ${ref}`;
        const target = { ...t.target, preset: ref };
        const verify = args.verify !== false;
        return ctx.mutations.run(async () => {
          const warnings: string[] = [];
          let found: { addrNative: string; label: string } | undefined;
          const checkPreset: StepFn = async () => {
            try {
              const res = (await bridge.request("objects", { ref, fields: ["Name"] })) as { total?: number; items?: Array<{ name?: string; addrNative?: string; class?: string }> };
              const item = res.items?.[0];
              if (!res.total || !item) return { name: "check_preset", kind: "read", status: "failed", op: "objects", error: `${ref} does not exist (the console would answer OK and change nothing); nothing was sent` };
              if (res.total > 1) return { name: "check_preset", kind: "read", status: "failed", op: "objects", error: `${ref} resolves to ${res.total} objects; name one preset` };
              if (!item.addrNative) return { name: "check_preset", kind: "read", status: "failed", op: "objects", error: `${ref} has no readable address` };
              found = { addrNative: item.addrNative, label: `${ref} "${item.name ?? ""}"` };
              return { name: "check_preset", kind: "read", status: "succeeded", op: "objects", detail: { name: item.name, addrNative: item.addrNative } };
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              if (/no objects? found|not found/i.test(message)) return { name: "check_preset", kind: "read", status: "failed", op: "objects", error: `${ref} does not exist; nothing was sent` };
              return { name: "check_preset", kind: "read", status: "failed", op: "objects", error: message };
            }
          };
          const plan: Array<{ name: string; run: StepFn }> = [{ name: "check_preset", run: checkPreset }, ...targetSteps(bridge, t, warnings)];
          if (t.selection !== null) plan.push({ name: "check_selection", run: checkSelectionStep(bridge, warnings) });
          plan.push({ name: "apply_preset", run: () => commandStep(bridge, "apply_preset", command) });
          const { steps } = await runSteps(plan);
          const sent = steps.some((s) => s.name === "apply_preset" && (s.status === "succeeded" || s.status === "unknown"));
          let verification: Verification = { status: "not_requested" };
          let summary: Record<string, unknown> = { performed: false };
          const readBack: StepResult[] = [];
          if (verify && sent && found) ({ verification, summary } = await verifyPresetLink(bridge, found, readBack));
          return finish({
            operation: op,
            target,
            steps,
            warnings,
            selectionChanged: anySucceeded(steps, ["select", "clear_selection"]),
            programmerValuesChanged: anySucceeded(steps, ["apply_preset"]),
            verification,
            readBackSteps: readBack,
            extra: { command, presetLink: summary },
          });
        });
      }),
  );

  server.registerTool(
    "gma3_release_attributes",
    {
      title: "Release attributes from the programmer",
      description:
        'Remove values from the programmer for an explicit target: `attributes` sends `Off Attribute "A" + "B"`; `all: true` sends `Off Attribute Thru` (every value of the target, the cells of a compound fixture included; the target stays selected). ' +
        "Target: `fixtures` OR `use_selection: true` (with `fixtures`, ClearSelection and a select first). The release is scoped to the selection, and with nothing selected the console would release the attributes from EVERY fixture, so the tool refuses unless the target is selected. " +
        "Read-back compares the whole programmer before and after: the released values must be gone from the target fixtures and their cells, and every other fixture's values must be unchanged.",
      inputSchema: {
        ...targetShape,
        attributes: z.array(z.string()).optional().describe(`Attribute names to release (up to ${MAX_ATTRIBUTES}).`),
        all: z.boolean().optional().describe("Release every value of the target instead of named attributes."),
        verify: z.boolean().optional().describe("Compare the programmer before and after (default true)."),
      },
    },
    async (args) =>
      operation(async () => {
        const op = "release_attributes";
        const v = new Validator();
        const t = validateTarget(v, args);
        const attrs: string[] = [];
        if (args.all === true && args.attributes !== undefined) v.fail("give attributes or all, not both");
        else if (args.all !== true) {
          if (!Array.isArray(args.attributes) || args.attributes.length === 0) v.fail("give attributes (a non-empty list) or all: true");
          else if (args.attributes.length > MAX_ATTRIBUTES) v.fail(`at most ${MAX_ATTRIBUTES} attributes per call`);
          else
            args.attributes.forEach((a, i) => {
              const n = v.check(() => attributeName(`attributes[${i}]`, a));
              if (n && attrs.some((x) => x.toLowerCase() === n.toLowerCase())) v.fail(`attribute ${n} appears twice`);
              else if (n) attrs.push(n);
            });
        }
        if (!v.ok || !t) return validationFailure(op, { fixtures: args.fixtures, use_selection: args.use_selection, attributes: args.attributes, all: args.all }, v.errors);
        const all = args.all === true;
        // Off Selection / Off Fixture N release nothing from a compound fixture selected as its parent (its values live on
        // its cells); Off Attribute Thru follows the selection down to the cells (docs/probes/su-05-programmer-macos-2.5.1.md).
        const command = all ? "Off Attribute Thru" : `Off Attribute ${attrs.map((a) => `"${a}"`).join(" + ")}`;
        const target = { ...t.target, ...(all ? { all: true } : { attributes: attrs }) };
        const verify = args.verify !== false;
        return ctx.mutations.run(async () => {
          const warnings: string[] = [];
          let targetIdx: Set<number> | undefined;
          let before: ProgrammerSnapshot | undefined;
          const plan: Array<{ name: string; run: StepFn }> = [...attrs.map((a) => ({ name: `check_attribute_${a}`, run: checkAttributeStep(bridge, a, warnings) })), ...targetSteps(bridge, t, warnings)];
          if (t.selection !== null) plan.push({ name: "check_selection", run: checkSelectionStep(bridge, warnings) });
          plan.push({
            name: "read_before",
            run: async () => {
              const sel = await selectedTarget(bridge);
              if ("reason" in sel) return { name: "read_before", kind: "read", status: "failed", op: "programmer", error: `the target could not be established (${sel.reason}); nothing was released` };
              targetIdx = sel.indices;
              if (verify) before = await snapshotProgrammer(bridge);
              return { name: "read_before", kind: "read", status: "succeeded", op: "programmer", detail: { fixtures: sel.fids, indices: sel.indices.size, values: before?.values.size } };
            },
          });
          plan.push({ name: "release", run: () => commandStep(bridge, "release", command) });
          const { steps } = await runSteps(plan);
          const sent = steps.some((s) => s.name === "release" && (s.status === "succeeded" || s.status === "unknown"));
          let verification: Verification = { status: "not_requested" };
          let summary: Record<string, unknown> = { performed: false };
          const readBack: StepResult[] = [];
          if (verify && sent && before && targetIdx) {
            const after = await snapshotProgrammer(bridge).catch((err: unknown) => ({ labelByIndex: new Map(), values: new Map(), complete: false, reason: err instanceof Error ? err.message : String(err) }) as ProgrammerSnapshot);
            readBack.push({ name: "read_after", kind: "read", status: after.complete ? "succeeded" : "failed", op: "programmer", ...(after.complete ? { detail: { values: after.values.size } } : { error: after.reason }) });
            ({ verification, summary } = judgeRelease(before, after, targetIdx, all ? null : attrs));
          }
          return finish({
            operation: op,
            target,
            steps,
            warnings,
            selectionChanged: anySucceeded(steps, ["select", "clear_selection"]),
            programmerValuesChanged: anySucceeded(steps, ["release"]),
            verification,
            readBackSteps: readBack,
            extra: { command, release: summary },
          });
        });
      }),
  );
};
