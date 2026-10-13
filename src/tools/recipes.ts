/**
 * SB-05: recipe lines in presets and cue parts, and cooking.
 *
 *   gma3_recipes        read-only: the recipe lines of a preset or cue part (selection, values, MAtricks, filter, state,
 *                       dangling references) and what the target holds cooked and uncooked per fixture
 *   gma3_edit_recipe    add, set, move or remove one standard recipe line (the definition)
 *   gma3_cook_recipes   cook a preset, a cue part, a cue or a whole sequence with an explicit option, after showing every
 *                       affected target, the coverage it should get and what happens to uncooked data
 *
 * Editing and cooking are separate tools, but the console cooks by itself (onPC 2.5.1): every Assign or property
 * write on a line cooks that line into its target at once (MergeLowPriority), disabling a line removes its output, and
 * a change of an ingredient (group membership, preset content) is re-cooked into the dependent targets a moment later
 * (asynchronously: not yet on an immediate read, done within 3 s). gma3_edit_recipe therefore reports the target's
 * coverage before and after the edit (`autoCooked`). What gma3_cook_recipes adds: an immediate, verified cook of a
 * preset, cue part, cue or whole sequence that does not depend on that background cook, the Merge, Overwrite and
 * Remove options, and the list of affected targets beforehand.
 *
 * First release: standard recipe lines with a group selection, a preset as values, a MAtricks reference, Enabled, Name and
 * SelectionMode. Phaser recipe lines, filters, worlds, shapes, SelectionFromValue and the per-line timing columns are
 * listed and kept but not edited, and their coverage is not predicted (reported as not predicted).
 *
 * Console facts this module relies on (onPC 2.5.1, docs/probes/sb-05-recipes-macos-2.5.1.md):
 *   - Lines are StandardRecipe children of a cue part or preset, addressed `Sequence S Cue C Part P.L` / `Preset N.M.L`;
 *     the object ops read them (references as handles with asText false) and `set` writes them.
 *   - `Assign Group|Preset|MAtricks <n> At <line>` sets a reference; at an index past the end it appends (no gap). A
 *     failed Assign may still leave an empty line, so the line count is checked after every edit.
 *   - `Move <line a> At <line b>` inserts: moving up lands at b, moving down lands at b-1. Only upward moves are used.
 *   - `Delete <line> /NoConfirmation` removes a line and re-cooks the rest.
 *   - Cook options: MergeLowPriority keeps every uncooked value; Merge replaces uncooked values on the recipe's own
 *     fixtures and attributes; Remove removes all cooked data; Overwrite deletes all uncooked data. A cook without an
 *     option opens a pop-up, so an option is always sent.
 *   - A deleted group or preset leaves the line with an empty Selection or Values; an empty group cooks nothing
 *     (FailedCookedPart "Group", EmptyLastCooking Yes).
 */
import { z } from "zod";
import { BridgeError, type Gma3Bridge } from "../bridge.js";
import { json, operation, type RegisterTools, type ToolContext } from "./context.js";
import { presetId, type PresetRead, type PresetRow } from "./presets.js";
import {
  asRead,
  buildResult,
  commandStep,
  notRequested,
  requestStep,
  runSteps,
  stepFromError,
  validationFailure,
  type OperationResult,
  type StepResult,
  type Verification,
} from "../results.js";
import { ValidationError, Validator, describe, finiteNumber, objectName, objectNumber, cueNumber } from "../validate.js";

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export type Target = { kind: "preset"; pool: number; number: number } | { kind: "part"; sequence: number; cue: string; part: number };
export type Scope = Target | { kind: "cue"; sequence: number; cue: string } | { kind: "sequence"; sequence: number };

export const targetRef = (t: Scope): string => {
  switch (t.kind) {
    case "preset": return `Preset ${t.pool}.${t.number}`;
    case "part": return `Sequence ${t.sequence} Cue ${t.cue} Part ${t.part}`;
    case "cue": return `Sequence ${t.sequence} Cue ${t.cue}`;
    case "sequence": return `Sequence ${t.sequence}`;
  }
};
export const lineRef = (t: Target, line: number) => `${targetRef(t)}${t.kind === "preset" ? "." : "."}${line}`;
const label = (t: Scope) => targetRef(t);

/** A preset or a single cue part (edit / read). */
export function parseTarget(raw: unknown): Target {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError('target must be {preset: "N.M"} or {sequence, cue, part?}', "target");
  const r = raw as Record<string, unknown>;
  if (r.preset !== undefined) {
    if (r.sequence !== undefined || r.cue !== undefined) throw new ValidationError("target: give a preset or a sequence cue, not both", "target");
    const p = presetId("target.preset", r.preset);
    return { kind: "preset", pool: p.pool, number: p.number };
  }
  const sequence = objectNumber("target.sequence", r.sequence)!;
  const cue = cueNumber("target.cue", r.cue)!;
  const part = r.part === undefined ? 0 : finiteNumber("target.part", r.part, { integer: true, min: 0, max: 999 })!;
  return { kind: "part", sequence, cue, part };
}

/** Cook scope: a preset, or a sequence with an optional cue and part. */
export function parseScope(raw: unknown): Scope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError('target must be {preset: "N.M"} or {sequence, cue?, part?}', "target");
  const r = raw as Record<string, unknown>;
  if (r.preset !== undefined) return parseTarget(raw);
  const sequence = objectNumber("target.sequence", r.sequence)!;
  if (r.cue === undefined) {
    if (r.part !== undefined) throw new ValidationError("target.part needs target.cue", "target");
    return { kind: "sequence", sequence };
  }
  const cue = cueNumber("target.cue", r.cue)!;
  if (r.part === undefined) return { kind: "cue", sequence, cue };
  return parseTarget(raw);
}

// ---------------------------------------------------------------------------
// Reading lines
// ---------------------------------------------------------------------------

interface Handle {
  name?: string;
  class?: string;
  addr?: string;
  index?: number;
  addrNative?: string;
}

export interface Line {
  line: number;
  class: string;
  name?: string;
  enabled: boolean | null;
  selection: { group: number; name?: string } | null;
  values: { addr?: string; name?: string; preset?: string } | null;
  matricks: { no?: number; name?: string } | null;
  filter: string | null;
  selectionMode?: string;
  selectionFromValue?: boolean | null;
  status: { failedCookedPart?: string; emptyLastCooking?: boolean | null };
}

const LINE_FIELDS = ["Name", "Enabled", "Selection", "Values", "MAtricks", "Filter", "SelectionMode", "SelectionFromValue", "FailedCookedPart", "EmptyLastCooking"];

const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : typeof v === "string" ? (/^(yes|true|on)$/i.test(v) ? true : /^(no|false|off)$/i.test(v) ? false : null) : null);
const handle = (v: unknown): Handle | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Handle) : null);

const NEEDS_BRIDGE = "the console runs an older bridge plugin (bridge 0.24.0 reads the cooked state of a cue part); update the plugin";
const notFound = (err: unknown) => err instanceof BridgeError && /no objects? found|no object at address|path not found/i.test(err.message);

export async function readLines(bridge: Gma3Bridge, t: Target, timeout: number): Promise<Line[] | null> {
  let res: { items?: Array<{ class?: string; index?: number; name?: string; fields?: Record<string, unknown> }> };
  try {
    res = (await bridge.request("children", { ref: targetRef(t), fields: LINE_FIELDS, asText: false, limit: 1000 }, timeout)) as typeof res;
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
  const lines: Line[] = [];
  (res.items ?? []).forEach((it, i) => {
    if (it.class !== "StandardRecipe" && it.class !== "PhaserRecipe") return;
    const f = it.fields ?? {};
    const sel = handle(f.Selection);
    const val = handle(f.Values);
    const mtx = handle(f.MAtricks);
    const flt = handle(f.Filter);
    lines.push({
      line: typeof it.index === "number" ? it.index : i + 1,
      class: String(it.class),
      name: typeof f.Name === "string" ? f.Name : it.name,
      enabled: bool(f.Enabled),
      selection: sel && sel.class === "Group" && typeof sel.index === "number" ? { group: sel.index, name: sel.name } : null,
      values: val && val.class === "Preset" ? { addr: val.addr, name: val.name } : null,
      matricks: mtx && mtx.class === "MAtrick" ? { no: mtx.index, name: mtx.name } : null,
      filter: flt ? flt.name ?? "?" : null,
      selectionMode: typeof f.SelectionMode === "string" ? f.SelectionMode : undefined,
      selectionFromValue: bool(f.SelectionFromValue),
      status: { failedCookedPart: typeof f.FailedCookedPart === "string" ? f.FailedCookedPart : undefined, emptyLastCooking: bool(f.EmptyLastCooking) },
    });
  });
  return lines;
}

interface GroupInfo {
  exists: boolean;
  members: Array<{ fixture: string; sfIndex: number }>;
  unreadable: number;
}

async function readGroup(bridge: Gma3Bridge, n: number, t: number, cache: Map<number, GroupInfo>): Promise<GroupInfo> {
  const hit = cache.get(n);
  if (hit) return hit;
  let info: GroupInfo;
  try {
    const g = (await bridge.request("group.read", { ref: `Group ${n}` }, t)) as { items: Array<{ fixture?: string | null; sfIndex?: number; unreadable?: boolean }> };
    info = { exists: true, members: g.items.filter((x) => !x.unreadable && typeof x.sfIndex === "number").map((x) => ({ fixture: x.fixture ?? `#${x.sfIndex}`, sfIndex: x.sfIndex! })), unreadable: g.items.filter((x) => x.unreadable).length };
  } catch (err) {
    if (!notFound(err)) throw err;
    info = { exists: false, members: [], unreadable: 0 };
  }
  cache.set(n, info);
  return info;
}

async function readData(bridge: Gma3Bridge, ref: string, t: number, typesFor?: number[]): Promise<PresetRead | null> {
  try {
    return (await bridge.request("preset.read", { ref, ...(typesFor ? { typesFor } : {}) }, t)) as PresetRead;
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
}

/** What a target holds per fixture: cooked and uncooked attributes. */
export function coverageOf(rows: Array<PresetRow & { cooked?: boolean }>) {
  const by = (cooked: boolean) => {
    const m = new Map<string, string[]>();
    for (const r of rows) if (!!r.cooked === cooked) m.set(r.fixture, [...(m.get(r.fixture) ?? []), r.attribute]);
    return [...m].map(([fixture, attributes]) => ({ fixture, attributes: attributes.sort() }));
  };
  return { cooked: by(true), uncooked: by(false), cookedCount: rows.filter((r) => r.cooked).length, uncookedCount: rows.filter((r) => !r.cooked).length };
}

// ---------------------------------------------------------------------------
// Line analysis and expected coverage
// ---------------------------------------------------------------------------

export interface LineReport extends Line {
  problems: string[];
  /** Why the coverage of this line is not predicted (phaser recipe, filter, MAtricks...). */
  notPredicted?: string;
  members?: string[];
}

interface Expected {
  /** "sfIndex|attribute" pairs the cook should produce (from the predicted lines). */
  pairs: Set<string>;
  /** Subfixtures any line may touch, predicted or not (cooked rows outside them are unexpected). */
  touched: Set<number>;
  unpredicted: number;
  /** Subfixtures lines with unpredicted coverage may write to; `unknownReach` when even that is not known. */
  uncertain: Set<number>;
  unknownReach: boolean;
}

/**
 * Check every line's references and predict the coverage: each enabled standard line with a group and a preset gives its
 * group's fixtures the preset's attributes (a selective row for that fixture, a global row of its type, or a universal
 * row). Lines with a filter or a phaser recipe are not predicted.
 */
export async function analyzeLines(bridge: Gma3Bridge, lines: Line[], t: number, groups: Map<number, GroupInfo>, presetCache: Map<string, PresetRead | null>): Promise<{ reports: LineReport[]; expected: Expected; dependencyNotes: string[] }> {
  const expected: Expected = { pairs: new Set(), touched: new Set(), unpredicted: 0, uncertain: new Set(), unknownReach: false };
  const dependencyNotes: string[] = [];
  const reports: LineReport[] = [];
  for (const l of lines) {
    const rep: LineReport = { ...l, problems: [] };
    reports.push(rep);
    if (l.enabled === false) { rep.problems.push("disabled: cooks nothing"); continue; }
    // A line whose output is not predicted may still write: what it may reach counts as uncertain (never as safe).
    const unpredictable = (why: string, g: GroupInfo | null) => {
      rep.notPredicted = why;
      expected.unpredicted++;
      if (g?.exists) for (const m of g.members) expected.uncertain.add(m.sfIndex);
      else expected.unknownReach = true;
    };
    let g: GroupInfo | null = null;
    if (!l.selection) {
      if (l.selectionFromValue || l.class !== "StandardRecipe") { unpredictable(l.class !== "StandardRecipe" ? `${l.class} lines are listed and kept, not modelled by this release` : "the selection comes from the values (SelectionFromValue), which is not predicted", null); continue; }
      rep.problems.push("no selection: the group is missing (deleted?) or was never assigned");
    } else {
      g = await readGroup(bridge, l.selection.group, t, groups);
      if (!g.exists) rep.problems.push(`Group ${l.selection.group} does not exist`);
      else if (g.members.length === 0) rep.problems.push(`Group ${l.selection.group} is empty: the line cooks nothing`);
      if (g.unreadable) rep.problems.push(`Group ${l.selection.group} has ${g.unreadable} unreadable item(s)`);
      rep.members = g.members.map((m) => m.fixture);
      for (const m of g.members) expected.touched.add(m.sfIndex);
    }
    if (l.class !== "StandardRecipe") { unpredictable(`${l.class} lines are listed and kept, not modelled by this release`, g); continue; }
    if (!l.values) { rep.problems.push("no values: the preset is missing (deleted?) or was never assigned"); continue; }
    if (l.filter) { unpredictable(`a filter (${l.filter}) limits the attributes; coverage not predicted`, g); continue; }
    if (!g || !g.exists || !g.members.length) continue;
    // The fixture types come with the read, for this group's members: the cache key includes them.
    const key = `${l.values.addr ?? l.values.name ?? "?"}|${g.members.map((m) => m.sfIndex).sort((a, b) => a - b).join(",")}`;
    let p = presetCache.get(key);
    if (p === undefined) {
      p = l.values.addr ? await readData(bridge, l.values.addr, t, g.members.map((m) => m.sfIndex)) : null;
      presetCache.set(key, p);
    }
    if (!p) { rep.problems.push(`the values preset ${l.values.name ?? ""} could not be read`); continue; }
    rep.values = { ...l.values, preset: p.pool?.no !== undefined && p.no !== undefined ? `${p.pool.no}.${p.no}` : undefined };
    if (p.rows.length === 0) rep.problems.push(`the values preset ${rep.values.preset ?? ""} is empty`);
    if ((p.dependencies ?? []).length) dependencyNotes.push(`line ${l.line}: Preset ${rep.values.preset} embeds other presets; their own recipes are not re-cooked here`);
    if (l.matricks) rep.notPredicted = undefined; // MAtricks spreads values and timing; the fixtures and attributes covered do not change
    const types = p.types ?? {};
    for (const m of g.members) {
      const own = p.rows.filter((r) => r.sfIndex === m.sfIndex);
      const type = types[String(m.sfIndex)];
      const global = p.rows.filter((r) => r.mode === "global" && type !== undefined && r.fixtureType === type);
      const universal = p.rows.filter((r) => r.mode === "universal");
      const attrs = new Set([...own, ...global].map((r) => r.attribute));
      // Universal data reaches every fixture that has the attribute; the fixture's own attribute list decides.
      if (universal.length) {
        const fa = (await bridge.request("fixtureAttributes", { ref: `Fixture ${m.fixture}`, limit: 500 }, t).catch(() => null)) as { attributes?: Array<{ attribute?: string }> } | null;
        const has = new Set((fa?.attributes ?? []).map((a) => String(a.attribute)));
        for (const r of universal) if (has.has(r.attribute)) attrs.add(r.attribute);
        if (!fa) dependencyNotes.push(`line ${l.line}: the attributes of ${m.fixture} could not be read, so universal values were not predicted for it`);
      }
      for (const a of attrs) expected.pairs.add(`${m.sfIndex}|${a}`);
    }
  }
  return { reports, expected, dependencyNotes };
}

/** Everything a row stores that the read reports: value, relative, steps with their layers, phaser layers, references. */
export function rowContent(r: PresetRow): string {
  return JSON.stringify([
    r.value ?? null, r.relative ?? null, r.stepCount ?? 1, r.fade ?? null, r.delay ?? null, r.speed ?? null, r.phase ?? null, r.measure ?? null, r.speedMaster ?? null,
    (r.steps ?? []).map((st) => [st.absolute ?? null, st.relative ?? null, st.accel ?? null, st.decel ?? null, st.trans ?? null, st.width ?? null, st.integrated?.addrNative ?? null]),
    r.absPreset?.addrNative ?? null, r.relPreset?.addrNative ?? null, r.mode ?? null,
  ]);
}

/** The difference between the expected coverage and a target's cooked rows. */
export function verifyCoverage(input: { rows: Array<PresetRow & { cooked?: boolean }>; expected: Expected; mode: CookMode; before: Array<PresetRow & { cooked?: boolean }> }): string[] {
  const out: string[] = [];
  const cooked = input.rows.filter((r) => r.cooked);
  const key = (r: PresetRow) => `${r.sfIndex}|${r.attribute}`;
  if (input.mode === "remove") {
    if (cooked.length) out.push(`${cooked.length} cooked value(s) remain after Remove`);
  } else {
    const have = new Set(cooked.map(key));
    const missing = [...input.expected.pairs].filter((k) => !have.has(k));
    // Merge low priority keeps an uncooked value on the recipe's own fixture and attribute: not a gap.
    const uncookedKeys = new Set(input.rows.filter((r) => !r.cooked).map(key));
    const realMissing = missing.filter((k) => !(input.mode === "merge_low_priority" && uncookedKeys.has(k)));
    if (realMissing.length) out.push(`expected cooked values missing: ${realMissing.slice(0, 8).join(", ")}${realMissing.length > 8 ? ` and ${realMissing.length - 8} more` : ""} (subfixture|attribute)`);
    const stray = input.expected.unknownReach ? [] : cooked.filter((r) => typeof r.sfIndex === "number" && !input.expected.touched.has(r.sfIndex));
    if (stray.length) out.push(`cooked values on fixtures no line selects: ${[...new Set(stray.map((r) => r.fixture))].join(", ")}`);
  }
  // Uncooked data: kept by merge_low_priority and remove; merge may replace it only where the recipe writes; overwrite deletes it.
  const uncookedBefore = input.before.filter((r) => !r.cooked);
  const afterBy = new Map(input.rows.map((r) => [key(r), r]));
  if (input.mode !== "overwrite") {
    for (const r of uncookedBefore) {
      // Merge may replace the recipes' own pairs and (acknowledged) anything an unpredicted line may reach.
      if (input.mode === "merge" && (input.expected.pairs.has(key(r)) || input.expected.unknownReach || (typeof r.sfIndex === "number" && input.expected.uncertain.has(r.sfIndex)))) continue;
      const a = afterBy.get(key(r));
      if (!a) out.push(`uncooked ${r.fixture} ${r.attribute} disappeared`);
      else if (a.cooked) out.push(`uncooked ${r.fixture} ${r.attribute} was replaced by cooked data`);
      else if (rowContent(a) !== rowContent(r)) out.push(`uncooked ${r.fixture} ${r.attribute} changed by the cook`);
    }
  }
  return out.slice(0, 20);
}

// ---------------------------------------------------------------------------
// gma3_recipes (read-only)
// ---------------------------------------------------------------------------

export async function readRecipes(ctx: ToolContext, raw: { target: unknown }): Promise<unknown> {
  const t = parseTarget(raw.target);
  const bridge = ctx.bridge;
  const lines = await readLines(bridge, t, ctx.requestTimeoutMs);
  if (!lines) return { target: label(t), exists: false };
  const a = await analyzeLines(bridge, lines, ctx.requestTimeoutMs, new Map(), new Map());
  let data: PresetRead | null;
  try {
    data = await readData(bridge, targetRef(t), ctx.requestTimeoutMs);
  } catch (err) {
    if (err instanceof BridgeError && /not-preset|not a preset/.test(err.message)) throw new Error(NEEDS_BRIDGE);
    throw err;
  }
  return {
    target: label(t),
    exists: true,
    lines: a.reports,
    coverage: data ? coverageOf(data.rows) : null,
    expectedPairs: a.expected.pairs.size,
    ...(a.expected.unpredicted ? { unpredictedLines: a.expected.unpredicted } : {}),
    ...(a.dependencyNotes.length ? { dependencyNotes: a.dependencyNotes } : {}),
    note: "coverage is what the target holds now: cooked (from recipes) and uncooked (stored directly) attributes per fixture. The console re-cooks a group or preset change in the background a moment later, so right after such a change the coverage may still be the old one; gma3_cook_recipes cooks it at once and verifies it.",
  };
}

// ---------------------------------------------------------------------------
// gma3_edit_recipe
// ---------------------------------------------------------------------------

interface EditArgs {
  target: unknown;
  action: "add" | "set" | "move" | "remove";
  line?: number;
  to?: number;
  selection?: number;
  values?: string | null;
  matricks?: number;
  enabled?: boolean;
  name?: string;
  selection_mode?: "strict" | "normal";
  preview?: boolean;
}

const SELECTION_MODES = { strict: "Strict", normal: "Normal" } as const;

function sameLine(a: Line, b: Line): boolean {
  return a.class === b.class && (a.selection?.group ?? null) === (b.selection?.group ?? null) && (a.values?.addr ?? null) === (b.values?.addr ?? null) && (a.matricks?.no ?? null) === (b.matricks?.no ?? null) && a.enabled === b.enabled && (a.name ?? "") === (b.name ?? "") && (a.selectionMode ?? "").toLowerCase() === (b.selectionMode ?? "").toLowerCase() && (a.filter ?? null) === (b.filter ?? null);
}

/** Every requested field of a line, compared per property. */
export function checkLineFields(l: Line, n: number, f: { selection?: number; valuesAddr?: string | null; matricks?: number; enabled?: boolean; name?: string; selectionMode?: string }): string[] {
  const out: string[] = [];
  if (f.selection !== undefined && l.selection?.group !== f.selection) out.push(`line ${n} selection reads ${l.selection ? `Group ${l.selection.group}` : "none"}`);
  if (f.valuesAddr === null && l.values) out.push(`line ${n} still has values`);
  if (typeof f.valuesAddr === "string" && l.values?.addr !== f.valuesAddr) out.push(`line ${n} values read ${l.values?.name ?? "none"}`);
  if (f.matricks !== undefined && l.matricks?.no !== f.matricks) out.push(`line ${n} MAtricks reads ${l.matricks?.no ?? "none"}`);
  if (f.enabled !== undefined && l.enabled !== f.enabled) out.push(`line ${n} enabled reads ${l.enabled}`);
  if (f.name !== undefined && (l.name ?? "") !== f.name) out.push(`line ${n} name reads ${JSON.stringify(l.name ?? null)}`);
  if (f.selectionMode !== undefined && (l.selectionMode ?? "").toLowerCase() !== f.selectionMode.toLowerCase()) out.push(`line ${n} selection mode reads ${JSON.stringify(l.selectionMode ?? null)}`);
  return out;
}

/** A set reply compared per property (a boolean property by its truth value, others as text). */
export function setReplyMatches(property: string, sent: string, got: unknown): boolean {
  if (property === "Enabled") return bool(got) !== null && bool(got) === bool(sent);
  if (sent === "") return got === "" || got === null || got === undefined || (typeof got === "object" && !got);
  return String(got ?? "").trim().toLowerCase() === sent.toLowerCase();
}

export async function editRecipe(ctx: ToolContext, raw: EditArgs): Promise<OperationResult> {
  const op = "edit_recipe";
  const v = new Validator();
  const t = v.check(() => parseTarget(raw.target));
  const action = raw.action;
  if (!["add", "set", "move", "remove"].includes(action)) v.fail("action must be add, set, move or remove");
  const line = raw.line === undefined ? undefined : v.check(() => finiteNumber("line", raw.line, { integer: true, min: 1, max: 1000 }));
  const to = raw.to === undefined ? undefined : v.check(() => finiteNumber("to", raw.to, { integer: true, min: 1, max: 1000 }));
  const selection = raw.selection === undefined ? undefined : v.check(() => objectNumber("selection", raw.selection, { max: 9999 }));
  const values = raw.values === undefined || raw.values === null ? raw.values : v.check(() => presetId("values", raw.values));
  const matricks = raw.matricks === undefined ? undefined : v.check(() => objectNumber("matricks", raw.matricks, { max: 9999 }));
  const name = v.check(() => objectName("name", raw.name, { optional: true }));
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") v.fail("enabled must be true or false");
  if (raw.selection_mode !== undefined && !(raw.selection_mode in SELECTION_MODES)) v.fail("selection_mode must be strict or normal");
  const fields = { selection, values, matricks, enabled: raw.enabled, name, selection_mode: raw.selection_mode };
  const anyField = Object.values(fields).some((x) => x !== undefined);
  if (action === "add" && (selection === undefined || values === undefined || values === null)) v.fail("add needs selection (a group) and values (a preset): a line without both cooks nothing");
  if ((action === "set" || action === "move" || action === "remove") && line === undefined) v.fail(`${action} needs line`);
  if (action === "set" && !anyField) v.fail("set needs at least one of selection, values, matricks, enabled, name, selection_mode");
  if (action === "move" && to === undefined) v.fail("move needs to");
  if ((action === "move" || action === "remove") && anyField) v.fail(`${action} takes no line fields`);
  const target: Record<string, unknown> = { target: raw.target, action };
  if (!v.ok || !t) return validationFailure(op, target, v.errors);
  target.ref = label(t);
  const bridge = ctx.bridge;
  const tm = ctx.requestTimeoutMs;
  const preview = raw.preview === true;

  const body = async (): Promise<OperationResult> => {
    let before: Line[] | null = null;
    let dataBefore: PresetRead | null = null;
    const inspect = await runSteps([
      {
        name: "read_lines",
        run: async () => {
          try {
            before = await readLines(bridge, t, tm);
          } catch (err) {
            return asRead(stepFromError("read_lines", err, { op: "children" }));
          }
          const b = before as Line[] | null;
          if (!b) return asRead({ name: "read_lines", status: "failed", op: "children", error: `${label(t)} does not exist (store the ${t.kind === "preset" ? "preset" : "cue"} first)` });
          if (line !== undefined && !b.some((l) => l.line === line)) return asRead({ name: "read_lines", status: "failed", op: "children", error: `${label(t)} has no recipe line ${line} (it has ${b.length})` });
          const l = b.find((x) => x.line === line);
          if (l && l.class !== "StandardRecipe" && action !== "move" && action !== "remove") return asRead({ name: "read_lines", status: "failed", op: "children", error: `line ${line} is a ${l.class}; only standard recipe lines are edited by this release` });
          if (action === "move" && (to! > b.length)) return asRead({ name: "read_lines", status: "failed", op: "children", error: `to must be 1-${b.length}` });
          return asRead({ name: "read_lines", status: "succeeded", op: "children", detail: { lines: b.length } });
        },
      },
      {
        name: "check_references",
        run: async () => {
          const missing: string[] = [];
          try {
            if (selection !== undefined && !(await readGroup(bridge, selection, tm, new Map())).exists) missing.push(`Group ${selection}`);
            if (values) {
              const p = await readData(bridge, `Preset ${values.pool}.${values.number}`, tm);
              if (!p) missing.push(`Preset ${values.pool}.${values.number}`);
            }
            if (matricks !== undefined) {
              const m = (await bridge.request("objects", { ref: `MAtricks ${matricks}`, fields: [], limit: 1 }, tm).catch((err: unknown) => (notFound(err) ? null : Promise.reject(err)))) as { items?: unknown[] } | null;
              if (!m?.items?.length) missing.push(`MAtricks ${matricks}`);
            }
          } catch (err) {
            return asRead(stepFromError("check_references", err, { op: "objects" }));
          }
          if (missing.length) return asRead({ name: "check_references", status: "failed", error: `not in the show: ${missing.join(", ")}` });
          return asRead({ name: "check_references", status: "succeeded" });
        },
      },
      {
        name: "read_coverage",
        run: async () => {
          try {
            dataBefore = await readData(bridge, targetRef(t), tm);
            return asRead({ name: "read_coverage", status: "succeeded", op: "preset.read" });
          } catch (err) {
            const s = asRead(stepFromError("read_coverage", err, { op: "preset.read" }));
            if (err instanceof BridgeError && /not-preset|not a preset/.test(err.message)) s.error = NEEDS_BRIDGE;
            return s;
          }
        },
      },
    ]);
    const b = (before as Line[] | null) ?? [];
    const extra: Record<string, unknown> = { linesBefore: b };
    if (inspect.outcome !== "succeeded") return buildResult({ operation: op, target, steps: inspect.steps, summary: `${op} was not performed; nothing was sent: ${inspect.steps.find((s) => s.status !== "succeeded")?.error ?? "inspection failed"}`, extra });

    // Plan the commands.
    const commands: Array<{ name: string; command?: string; set?: { property: string; value: string } }> = [];
    const n = action === "add" ? b.length + 1 : line!;
    const ref = lineRef(t, n);
    if (action === "add" || action === "set") {
      if (selection !== undefined) commands.push({ name: "assign_selection", command: `Assign Group ${selection} At ${ref}` });
      // A disabled line is switched off before its values, so it never cooks.
      if (raw.enabled === false) commands.push({ name: "set_enabled", set: { property: "Enabled", value: "No" } });
      if (values) commands.push({ name: "assign_values", command: `Assign Preset ${values.pool}.${values.number} At ${ref}` });
      if (values === null) commands.push({ name: "clear_values", set: { property: "Values", value: "" } });
      if (matricks !== undefined) commands.push({ name: "assign_matricks", command: `Assign MAtricks ${matricks} At ${ref}` });
      if (raw.selection_mode) commands.push({ name: "set_selection_mode", set: { property: "SelectionMode", value: SELECTION_MODES[raw.selection_mode] } });
      if (name !== undefined) commands.push({ name: "set_name", set: { property: "Name", value: name } });
      if (raw.enabled === true) commands.push({ name: "set_enabled", set: { property: "Enabled", value: "Yes" } });
    } else if (action === "move") {
      // Only upward moves (they land where asked): down by k is k single moves of the lines below it.
      if (to! < line!) commands.push({ name: "move", command: `Move ${lineRef(t, line!)} At ${lineRef(t, to!)}` });
      else for (let k = line! + 1; k <= to!; k++) commands.push({ name: "move", command: `Move ${lineRef(t, k)} At ${lineRef(t, k - 1)}` });
    } else commands.push({ name: "remove", command: `Delete ${ref} /NoConfirmation` });
    // Expected definition after the edit.
    const expected = b.map((l) => ({ ...l }));
    if (action === "move") {
      const [m] = expected.splice(line! - 1, 1);
      expected.splice(to! - 1, 0, m);
    } else if (action === "remove") expected.splice(line! - 1, 1);
    extra.intended = { commands: commands.map((c) => c.command ?? `set ${ref} ${c.set!.property}=${c.set!.value}`), line: n, autoCook: action === "move" ? "none expected" : "the console re-cooks the edited line (MergeLowPriority)" };
    if (preview) return buildResult({ operation: op, target, steps: inspect.steps, summary: `Preview only; nothing was sent.`, extra: { ...extra, preview: true } });

    const main = await runSteps(
      commands.map((c) => ({
        name: c.name,
        run: () =>
          c.command
            ? commandStep(bridge, c.name, c.command, tm)
            : requestStep(bridge, c.name, "set", { ref, property: c.set!.property, value: c.set!.value }, (res) => {
                const got = (res as { value?: unknown } | null)?.value;
                const ok = setReplyMatches(c.set!.property, c.set!.value, got);
                return ok ? { name: c.name, status: "succeeded", op: "set" } : { name: c.name, status: "failed", op: "set", detail: { readBack: got }, error: `${c.set!.property} reads ${JSON.stringify(got)} after the write` };
              }, tm),
      })),
    );
    const steps = [...inspect.steps, ...main.steps];
    let verification: Verification = notRequested();
    let after: Line[] | null = null;
    let dataAfter: PresetRead | null = null;
    try {
      after = await readLines(bridge, t, tm);
      dataAfter = await readData(bridge, targetRef(t), tm);
      steps.push(asRead({ name: "read_back", status: "succeeded", op: "children" }));
      const a = after ?? [];
      const problems: string[] = [];
      const valuesAddr = values ? (await readData(bridge, `Preset ${values.pool}.${values.number}`, tm))?.addr ?? "?" : values === null ? null : undefined;
      const want = { selection, valuesAddr, matricks, enabled: raw.enabled, name, selectionMode: raw.selection_mode ? SELECTION_MODES[raw.selection_mode] : undefined };
      if (action === "add") {
        if (a.length !== b.length + 1) problems.push(`${a.length} line(s) after adding to ${b.length}`);
        const l = a[n - 1];
        if (!l) problems.push(`line ${n} was not created`);
        else problems.push(...checkLineFields(l, n, want));
        for (let i = 0; i < b.length; i++) if (!a[i] || !sameLine(a[i], b[i])) problems.push(`line ${i + 1} changed`);
      } else if (action === "set") {
        if (a.length !== b.length) problems.push(`${a.length} line(s) after the edit, ${b.length} before`);
        const l = a[n - 1];
        if (!l) problems.push(`line ${n} is gone`);
        else problems.push(...checkLineFields(l, n, want));
        for (let i = 0; i < b.length; i++) if (i !== n - 1 && (!a[i] || !sameLine(a[i], b[i]))) problems.push(`line ${i + 1} changed`);
      } else {
        if (a.length !== expected.length) problems.push(`${a.length} line(s), ${expected.length} expected`);
        for (let i = 0; i < expected.length; i++) if (!a[i] || !sameLine(a[i], expected[i])) problems.push(`line ${i + 1} is not the expected one`);
      }
      verification = problems.length ? { status: "mismatched", checked: `the recipe lines of ${label(t)}`, detail: problems.slice(0, 10).join("; ") } : { status: "matched", checked: `the recipe lines of ${label(t)} (the edited line and that the others are unchanged)` };
    } catch (err) {
      steps.push(asRead(stepFromError("read_back", err, { op: "children" })));
    }
    const cb = dataBefore ? coverageOf((dataBefore as PresetRead).rows) : null;
    const ca = dataAfter ? coverageOf((dataAfter as PresetRead).rows) : null;
    const warnings: string[] = [];
    const changed = cb && ca && JSON.stringify(cb) !== JSON.stringify(ca);
    if (changed) warnings.push("the console re-cooked the target when the line changed (MergeLowPriority); see coverage.before / coverage.after. Use gma3_cook_recipes for another cook option");
    return buildResult({ operation: op, target, steps, verification, warnings, extra: { ...extra, linesAfter: after, coverage: { before: cb, after: ca }, autoCooked: !!changed } });
  };
  return preview ? body() : ctx.mutations.run(body);
}

// ---------------------------------------------------------------------------
// gma3_cook_recipes
// ---------------------------------------------------------------------------

export type CookMode = "merge_low_priority" | "merge" | "overwrite" | "remove";
const COOK_OPTION: Record<CookMode, string> = { merge_low_priority: "/MergeLowPriority", merge: "/Merge", overwrite: "/Overwrite", remove: "/Remove" };
const MAX_TARGETS = 200;

interface CookArgs {
  target: unknown;
  mode: CookMode;
  replace_uncooked?: boolean;
  preview?: boolean;
  verify?: boolean;
}

/** The presets / cue parts a cook scope reaches that hold recipe lines. */
async function affectedTargets(bridge: Gma3Bridge, scope: Scope, t: number): Promise<{ targets: Target[]; truncated: boolean }> {
  if (scope.kind === "preset" || scope.kind === "part") return { targets: [scope], truncated: false };
  const out: Target[] = [];
  const cues: string[] = [];
  if (scope.kind === "cue") cues.push(scope.cue);
  else {
    const res = (await bridge.request("children", { ref: `Sequence ${scope.sequence}`, fields: ["No"], limit: 10000 }, t)) as { items?: Array<{ fields?: Record<string, unknown> }> };
    for (const it of res.items ?? []) {
      const no = String(it.fields?.No ?? "").trim();
      if (/^\d+(\.\d+)?$/.test(no) && Number(no) > 0) cues.push(String(Number(no)));
    }
  }
  for (const cue of cues) {
    const parts = (await bridge.request("children", { ref: `Sequence ${scope.sequence} Cue ${cue}`, fields: ["Part"], limit: 1000 }, t)) as { items?: Array<{ childCount?: number; fields?: Record<string, unknown> }> };
    for (const p of parts.items ?? []) {
      const part = Number(String(p.fields?.Part ?? "").trim());
      if (!Number.isInteger(part) || (p.childCount ?? 0) === 0) continue;
      out.push({ kind: "part", sequence: scope.sequence, cue, part });
      if (out.length >= MAX_TARGETS) return { targets: out, truncated: true };
    }
  }
  return { targets: out, truncated: false };
}

export async function cookRecipes(ctx: ToolContext, raw: CookArgs): Promise<OperationResult> {
  const op = "cook_recipes";
  const v = new Validator();
  const scope = v.check(() => parseScope(raw.target));
  if (!(raw.mode in COOK_OPTION)) v.fail("mode must be merge_low_priority, merge, overwrite or remove (a cook without an option opens a pop-up on the console)");
  const target: Record<string, unknown> = { target: raw.target, mode: raw.mode };
  if (!v.ok || !scope) return validationFailure(op, target, v.errors);
  const mode = raw.mode;
  target.ref = label(scope);
  const bridge = ctx.bridge;
  const t = ctx.requestTimeoutMs;
  const preview = raw.preview === true;
  const verify = raw.verify !== false;

  const body = async (): Promise<OperationResult> => {
    const groups = new Map<number, GroupInfo>();
    const presets = new Map<string, PresetRead | null>();
    type Plan = { target: Target; lines: LineReport[]; expected: Expected; before: PresetRead | null; conflicts: string[]; losses: string[]; notes: string[] };
    const plans: Plan[] = [];
    let truncated = false;
    const inspect = await runSteps([
      {
        name: "find_targets",
        run: async () => {
          try {
            const a = await affectedTargets(bridge, scope, t);
            truncated = a.truncated;
            for (const tg of a.targets) {
              const lines = await readLines(bridge, tg, t);
              if (!lines) {
                if (tg === scope) return asRead({ name: "find_targets", status: "failed", error: `${label(tg)} does not exist` });
                continue;
              }
              if (!lines.length) continue;
              const an = await analyzeLines(bridge, lines, t, groups, presets);
              let before: PresetRead | null;
              try {
                before = await readData(bridge, targetRef(tg), t);
              } catch (err) {
                if (err instanceof BridgeError && /not-preset|not a preset/.test(err.message)) return asRead({ name: "find_targets", status: "failed", error: NEEDS_BRIDGE });
                throw err;
              }
              const rows = before?.rows ?? [];
              // Merge replaces uncooked values on the recipes' pairs; what unpredicted lines reach is a possible conflict.
              const conflicts = rows
                .filter((r) => !(r as { cooked?: boolean }).cooked && (an.expected.pairs.has(`${r.sfIndex}|${r.attribute}`) || an.expected.unknownReach || (typeof r.sfIndex === "number" && an.expected.uncertain.has(r.sfIndex))))
                .map((r) => `${r.fixture} ${r.attribute}${an.expected.pairs.has(`${r.sfIndex}|${r.attribute}`) ? "" : " (possibly: a line's coverage is not predicted)"}`);
              const losses = rows.filter((r) => !(r as { cooked?: boolean }).cooked).map((r) => `${r.fixture} ${r.attribute}`);
              plans.push({ target: tg, lines: an.reports, expected: an.expected, before, conflicts, losses, notes: an.dependencyNotes });
            }
          } catch (err) {
            return asRead(stepFromError("find_targets", err, { op: "children" }));
          }
          if (!plans.length && !truncated) return asRead({ name: "find_targets", status: "failed", error: `no recipe lines in ${label(scope)}; nothing to cook` });
          return asRead({ name: "find_targets", status: "succeeded", detail: { targets: plans.length, truncated } });
        },
      },
    ]);
    const describePlan = (p: Plan) => ({
      target: label(p.target),
      lines: p.lines.map((l) => ({ line: l.line, class: l.class, enabled: l.enabled, selection: l.selection ? `Group ${l.selection.group}` : null, members: l.members, values: l.values?.preset ? `Preset ${l.values.preset}` : l.values?.name ?? null, matricks: l.matricks?.no ?? null, problems: l.problems, ...(l.notPredicted ? { notPredicted: l.notPredicted } : {}) })),
      coverageBefore: p.before ? coverageOf(p.before.rows) : null,
      expectedCooked: p.expected.pairs.size,
      ...(mode === "merge" && p.conflicts.length ? { replacedUncooked: p.conflicts } : {}),
      ...(mode === "overwrite" && p.losses.length ? { deletedUncooked: p.losses } : {}),
      ...(p.notes.length ? { dependencyNotes: p.notes } : {}),
    });
    const extra: Record<string, unknown> = {
      affected: plans.map(describePlan),
      behaviour: {
        merge_low_priority: "replaces cooked data with the recipes' output and keeps every uncooked value",
        merge: "replaces cooked data and uncooked values on the recipes' own fixtures and attributes",
        overwrite: "deletes all data of the target, uncooked included, and cooks the recipes",
        remove: "removes the cooked data and keeps uncooked values",
      }[mode],
      ...(truncated ? { truncated: `only the first ${MAX_TARGETS} cue parts were inspected` } : {}),
    };
    if (inspect.outcome !== "succeeded") return buildResult({ operation: op, target, steps: inspect.steps, summary: `${op} was not performed; nothing was sent: ${inspect.steps.find((s) => s.status !== "succeeded")?.error ?? "inspection failed"}`, extra });
    if (truncated && !preview) {
      // The command would cook targets that were not inspected: refuse rather than cook beyond what was checked.
      const s: StepResult = asRead({ name: "check_scope", status: "failed", error: `${label(scope)} holds more than ${MAX_TARGETS} cue parts with recipes; only ${MAX_TARGETS} were inspected, so the cook would reach unchecked targets. Cook cue by cue` });
      return buildResult({ operation: op, target, steps: [...inspect.steps, s], summary: `${op} refused, nothing was sent: ${s.error}`, extra });
    }
    const warnings: string[] = [];
    for (const p of plans) for (const l of p.lines) for (const pr of l.problems) warnings.push(`${label(p.target)} line ${l.line}: ${pr}`);
    for (const p of plans) for (const l of p.lines) if (l.notPredicted) warnings.push(`${label(p.target)} line ${l.line}: ${l.notPredicted}`);
    for (const p of plans) warnings.push(...p.notes.map((n) => `${label(p.target)} ${n}`));
    const needsAck = plans.filter((p) => (mode === "merge" && p.conflicts.length) || (mode === "overwrite" && p.losses.length));
    if (needsAck.length && raw.replace_uncooked !== true) {
      const s: StepResult = asRead({ name: "check_uncooked", status: "failed", error: `${mode} would ${mode === "merge" ? "replace" : "delete"} uncooked values in ${needsAck.map((p) => `${label(p.target)} (${(mode === "merge" ? p.conflicts : p.losses).slice(0, 4).join(", ")}${(mode === "merge" ? p.conflicts : p.losses).length > 4 ? ", ..." : ""})`).join("; ")}; pass replace_uncooked: true to accept, or cook with merge_low_priority` });
      return buildResult({ operation: op, target, steps: [...inspect.steps, s], summary: `${op} refused, nothing was sent: ${s.error}`, warnings, extra });
    }
    if (preview) return buildResult({ operation: op, target, steps: inspect.steps, summary: `Preview only; nothing was sent. Cook ${label(scope)} ${COOK_OPTION[mode]} would reach ${plans.length} target(s).`, warnings, extra: { ...extra, preview: true } });

    const command = `Cook ${targetRef(scope)} ${COOK_OPTION[mode]}`;
    const steps = [...inspect.steps, await commandStep(bridge, "cook", command, t)];
    let verification: Verification = notRequested();
    const results: unknown[] = [];
    if (verify && steps.at(-1)!.status === "succeeded") {
      const problems: string[] = [];
      try {
        for (const p of plans) {
          const after = await readData(bridge, targetRef(p.target), t);
          if (!after) { problems.push(`${label(p.target)} could not be read after the cook`); continue; }
          const diff = verifyCoverage({ rows: after.rows, expected: p.expected, mode, before: p.before?.rows ?? [] });
          problems.push(...diff.map((d) => `${label(p.target)}: ${d}`));
          results.push({ target: label(p.target), coverage: coverageOf(after.rows) });
        }
        steps.push(asRead({ name: "read_back", status: "succeeded", op: "preset.read" }));
        const unpredicted = plans.reduce((n, p) => n + p.expected.unpredicted, 0);
        const checked = `the cooked and uncooked data of ${plans.length} target(s) against the predicted coverage${unpredicted ? ` (${unpredicted} line(s) not predicted)` : ""}`;
        verification = problems.length ? { status: "mismatched", checked, detail: problems.slice(0, 12).join("; ") } : { status: "matched", checked };
      } catch (err) {
        steps.push(asRead(stepFromError("read_back", err, { op: "preset.read" })));
      }
    }
    return buildResult({ operation: op, target, steps, verification, warnings, extra: { ...extra, command, results } });
  };
  return preview ? body() : ctx.mutations.run(body);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const targetSchema = z.object({ preset: z.string().optional(), sequence: z.number().optional(), cue: z.union([z.number(), z.string()]).optional(), part: z.number().optional() });

export const registerRecipeTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_recipes",
    {
      title: "Read the recipe lines of a preset or cue part",
      description:
        "Read-only. target: {preset: \"N.M\"} or {sequence, cue, part?} (part 0 by default). Returns every recipe line (standard and phaser) with its selection (group and its members), values (preset), MAtricks, filter, Enabled, SelectionMode, the console's last cooking state, and problems (missing or empty group, missing preset, disabled), " +
        "plus the target's coverage: per fixture which attributes are cooked (from recipes) and which are stored directly. Lines whose coverage is not predicted (phaser recipes, filters) are flagged; presets that embed others are noted. Needs bridge 0.24.0.",
      inputSchema: { target: targetSchema.describe("Preset or cue part.") },
    },
    async (args) => {
      try {
        return json(await readRecipes(ctx, args as { target: unknown }));
      } catch (err) {
        return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    "gma3_edit_recipe",
    {
      title: "Add, change, move or remove a recipe line",
      description:
        "Edit one standard recipe line of a preset or cue part (the target must exist). action add {selection: group, values: \"N.M\" preset, matricks?, name?, enabled?, selection_mode?} appends a line; set {line, ...fields} changes it (values: null clears the values); move {line, to} reorders; remove {line} deletes it. " +
        "References are checked first; the result reads every line back (the edited one and that the others are unchanged or moved as asked). The console re-cooks an edited line by itself (MergeLowPriority) and a removed line's output disappears: the result shows the target's coverage before and after (autoCooked). " +
        "The console also re-cooks a group or preset change by itself a moment later (in the background); gma3_cook_recipes cooks at once, verifies, and offers Merge, Overwrite and Remove. enabled: false switches a new line off before it gets values, so it never cooks. Phaser lines, filters and timing columns are not edited by this release. preview: true returns the planned commands.",
      inputSchema: {
        target: targetSchema.describe("Preset or cue part."),
        action: z.enum(["add", "set", "move", "remove"]),
        line: z.number().optional().describe("Line number (set, move, remove)."),
        to: z.number().optional().describe("New position (move)."),
        selection: z.number().optional().describe("Group number."),
        values: z.string().nullable().optional().describe('Preset "N.M"; null clears it.'),
        matricks: z.number().optional().describe("MAtricks pool number."),
        enabled: z.boolean().optional(),
        name: z.string().optional(),
        selection_mode: z.enum(["strict", "normal"]).optional().describe("Strict: values only on the selected fixtures; Normal: passed down to sub-fixtures."),
        preview: z.boolean().optional(),
      },
    },
    async (args) => operation(() => editRecipe(ctx, args as EditArgs)),
  );

  server.registerTool(
    "gma3_cook_recipes",
    {
      title: "Cook recipes with an explicit option",
      description:
        "Cook the recipes of a preset, a cue part, a cue (all its parts) or a whole sequence, at once and verified (the console also re-cooks group and preset changes by itself in the background a moment later, with merge low priority). mode is required: merge_low_priority (replaces cooked data, keeps every uncooked value), merge (also replaces uncooked values on the recipes' own fixtures and attributes), overwrite (deletes every uncooked value), remove (removes cooked data). " +
        "First every affected target is listed with its lines, their problems (missing or empty group, missing preset), the coverage before and the cooked coverage the lines should give; merge and overwrite are refused while they would replace or delete uncooked values unless replace_uncooked: true. preview: true stops there. " +
        "After `Cook <target> /<Option>` (verify, default true) each target is read back: every predicted fixture and attribute cooked, no cooked values on fixtures no line selects, uncooked values unchanged (merge_low_priority, remove) or changed only where allowed. Lines that are not predicted (phaser recipes, filters) are named; presets that embed other presets are noted (their recipes are not re-cooked). Needs bridge 0.24.0.",
      inputSchema: {
        target: targetSchema.describe("Preset, or sequence with optional cue and part."),
        mode: z.enum(["merge_low_priority", "merge", "overwrite", "remove"]),
        replace_uncooked: z.boolean().optional().describe("Allow merge/overwrite to replace or delete uncooked values (default false: refuse)."),
        preview: z.boolean().optional(),
        verify: z.boolean().optional(),
      },
    },
    async (args) => operation(() => cookRecipes(ctx, args as CookArgs)),
  );
};
