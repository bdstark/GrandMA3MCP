/**
 * SB-03: reusable presets with explicit storage rules.
 *
 *   gma3_preset         read-only: a preset's stored content (per fixture and attribute: mode, value, fade/delay,
 *                       embedded source), its dependencies checked recursively, or a pool's defaults and the
 *                       operator's store preferences
 *   gma3_store_preset   store the current programmer content into a preset with every storage option explicit,
 *                       after proving the programmer holds only the requested content, then verify what was stored
 *
 * Console facts this module relies on (onPC 2.5.1, docs/probes/sb-03-presets-macos-2.5.1.md):
 *   - A store without a mode follows the pool's default, and with /NoConfirmation it resolves a mode conflict silently:
 *     divergent per-fixture values stored into a Universal pool keep ONE fixture's values. Without /NoConfirmation a
 *     blocking "Preset Mode Conflict" message box opens. The tool always sends an explicit mode and /NoConfirmation,
 *     and reads the stored rows back: a requested mode is never taken as proof.
 *   - Per channel GetPresetData reports preset_store_mode (1 selective, 2 global, 3 universal). Global data sits on the
 *     lowest FID of each fixture type, plus selective rows for fixtures that differ; universal data on one holder.
 *   - A default store takes every ACTIVE value (CHANNELFILTER Active), not the selection, and an empty programmer
 *     stores an empty preset with feedback "OK". So the programmer is scanned first and anything outside the requested
 *     fixtures, attributes and layers is refused; /Programmer and /Active pin the data source and channel filter (they
 *     override StoreSource Output and ChannelFilter All). Look cannot be switched off per store: /Look "No" (and any
 *     /Look) turns it on, so the tool refuses while the operator's StoreLook preference is on.
 *   - Feature-group pools (1-20) drop attributes of other feature groups silently while the input filter is on (store
 *     preference PresetInputFilter, or /InputFilter "Yes"/"No"); the All pools (21-25) have no filter. The tool predicts
 *     the drop from each attribute's feature group and refuses it.
 *   - The STOREMODE preference decides merge/overwrite onto an existing preset; the tool always sends /Merge or
 *     /Overwrite. StoreEmbedded, StoreMAtricks and KeepActivation are overridden per store with /Embed, /MAtricks and
 *     /KeepActivation "Yes"/"No". None of these options changes the StorePreferences object (read before and after).
 *   - /Embed keeps a reference to the preset that is active in the programmer (abs_preset per channel, a Dependencies
 *     entry with a content checksum); the embedded preset follows its source one frame after the source changes. A
 *     deleted source leaves an invalid handle. /ForceGlobal and /ForceUniversal (with /Merge) remove the existing
 *     selective (and global) data.
 *   - A locked preset answers "Object locked".
 */
import { z } from "zod";
import { BridgeError, type Gma3Bridge } from "../bridge.js";
import { json, operation, type RegisterTools, type ToolContext } from "./context.js";
import { expandFixtures } from "./groups.js";
import {
  asRead,
  buildResult,
  commandStep,
  notRequested,
  requestStep,
  runSteps,
  stepFromError,
  unavailable,
  validationFailure,
  type OperationResult,
  type StepResult,
  type Verification,
} from "../results.js";
import { ValidationError, Validator, attributeName, describe, finiteNumber, objectName } from "../validate.js";

// ---------------------------------------------------------------------------
// Shapes the bridge returns
// ---------------------------------------------------------------------------

export interface ObjectRefInfo {
  valid: boolean;
  addr?: string;
  addrNative?: string;
  name?: string;
  no?: number;
  pool?: number;
  poolName?: string;
}

export interface PresetRow {
  fixture: string;
  attribute: string;
  sfIndex?: number;
  fixtureType?: string;
  mode?: string;
  hasAbsolute?: boolean;
  hasRelative?: boolean;
  value?: number | null;
  relative?: number | null;
  fade?: number | null;
  delay?: number | null;
  stepCount?: number;
  steps?: Array<{ step: number; absolute?: number; relative?: number }>;
  absPreset?: ObjectRefInfo | null;
  relPreset?: ObjectRefInfo | null;
}

export interface PresetRead {
  ref: string;
  addr?: string;
  addrNative?: string;
  no?: number;
  name?: string;
  pool?: { no?: number; name?: string };
  presetMode?: string;
  storedData?: string;
  featureGroup?: string;
  lock?: string | null;
  maxDepth?: string | number;
  hasMAtricks?: string;
  inputFilter?: string;
  referencedBy?: number;
  dependencies: Array<ObjectRefInfo & { contentCrc?: string }>;
  dependenciesReadable?: boolean;
  rows: PresetRow[];
  truncated?: boolean;
  count?: number;
  types?: Record<string, string>;
}

export interface PresetContext {
  preferences: Record<string, unknown>;
  preferencesReadable: boolean;
  pool?: { no: number; exists: boolean; name?: string; presetMode?: string; inputFilter?: string };
}

/** A row of the bridge's `programmer` op (the fields this module uses). */
export interface ProgrammerRow {
  fixture?: string;
  fid?: string | null;
  subfixtureIndex: number;
  attribute?: string;
  value?: number | null;
  relative?: number | null;
  stepCount?: number;
  phaser?: { fade?: number | null; delay?: number | null };
  absPreset?: { name?: string; addrNative?: string } | null;
  relPreset?: { name?: string; addrNative?: string } | null;
}

interface ProgrammerScan {
  rows: ProgrammerRow[];
  total: number;
  count: number;
  coverage?: { complete?: boolean };
  stats?: { channelErrors?: number };
  limitations?: string[];
}

interface FixtureAttributes {
  subfixtureIndex?: number;
  fixtureType?: string;
  fid?: string;
  name?: string;
  attributes?: Array<{ attribute?: string; featureGroup?: string; activationGroup?: string }>;
  subfixtures?: Array<{ name?: string; addr?: string; subfixtureIndex?: number; childCount?: number }>;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** The five "All" preset pools have no feature-group input filter (manual: Preset Pools). */
export const ALL_POOLS = [21, 22, 23, 24, 25];
export const LAYERS = ["absolute", "relative", "fade", "delay", "phaser"] as const;
export type Layer = (typeof LAYERS)[number];
export const MODES = ["selective", "global", "universal"] as const;
export type Mode = (typeof MODES)[number];
const MODE_OPTION: Record<Mode, string> = { selective: "/Selective", global: "/Global", universal: "/Universal" };
const FORCE_OPTION = { global: "/ForceGlobal", universal: "/ForceUniversal" } as const;
const MAX_SCOPE = 256;
/** Percent tolerance when comparing stored and programmer values. */
const TOLERANCE = 0.05;

/** "4.12" -> {pool: 4, number: 12}. */
export function presetId(field: string, value: unknown): { pool: number; number: number } {
  const m = typeof value === "string" ? value.trim().match(/^(\d{1,3})\.(\d{1,4})$/) : null;
  const pool = m ? Number(m[1]) : NaN;
  const number = m ? Number(m[2]) : NaN;
  if (!m || pool < 1 || pool > 999 || number < 1 || number > 9999) throw new ValidationError(`${field} must be "<pool>.<number>" such as "4.12" (pools 1-999, presets 1-9999; got ${describe(value)})`, field);
  return { pool, number };
}

function boolOpt(v: Validator, field: string, value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    v.fail(`${field} must be true or false`);
    return undefined;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Analysis (pure, unit-tested)
// ---------------------------------------------------------------------------

/** The data layers a programmer row carries. */
export function rowLayers(r: ProgrammerRow): Layer[] {
  const out: Layer[] = [];
  if ((r.stepCount ?? 1) > 1) out.push("phaser");
  else if (r.value !== null && r.value !== undefined) out.push("absolute");
  if (r.relative !== null && r.relative !== undefined && r.relative !== 0) out.push("relative");
  if (r.phaser?.fade !== null && r.phaser?.fade !== undefined) out.push("fade");
  if (r.phaser?.delay !== null && r.phaser?.delay !== undefined) out.push("delay");
  return out;
}

const near = (a: unknown, b: unknown) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= TOLERANCE;
const label = (r: ProgrammerRow) => `${r.fid ?? r.fixture ?? `#${r.subfixtureIndex}`} ${r.attribute}`;

export interface ContentPlan {
  rows: ProgrammerRow[];
  problems: string[];
  warnings: string[];
  embeddedSources: string[];
}

/**
 * Check the programmer rows against the request: every row inside the scope, the attribute filter and the layers;
 * every scope fixture and requested attribute present; universal mode without divergent values; embedding only when
 * a preset reference is in the programmer; nothing the pool's input filter would drop.
 */
export function analyzeContent(input: {
  rows: ProgrammerRow[];
  scope: Map<number, string>;
  scopeFixtures: Map<string, number[]>;
  attributes?: string[];
  layers: Layer[];
  mode?: Mode;
  force?: "global" | "universal";
  embed: boolean;
  /** Attribute -> feature group, for the input-filter prediction; undefined when the filter does not apply. */
  filterGroup?: { pool: string; groups: Map<string, string> };
}): ContentPlan {
  const problems: string[] = [];
  const warnings: string[] = [];
  const outside = input.rows.filter((r) => !input.scope.has(r.subfixtureIndex));
  if (outside.length) problems.push(`the programmer holds values outside the requested fixtures: ${summarize(outside)}; clear them or widen the scope (the store would include every active value)`);
  const inScope = input.rows.filter((r) => input.scope.has(r.subfixtureIndex));
  if (input.rows.length === 0) problems.push("the programmer holds no values; the console would store an empty preset");
  if (input.attributes) {
    const allowed = new Set(input.attributes.map((a) => a.toLowerCase()));
    const extra = inScope.filter((r) => !allowed.has(String(r.attribute).toLowerCase()));
    if (extra.length) problems.push(`the programmer holds attributes that were not requested: ${summarize(extra)} (setting one attribute of an activation group, e.g. ColorRGB_R, activates the whole group; list those attributes too)`);
    const present = new Set(inScope.map((r) => String(r.attribute).toLowerCase()));
    const missing = input.attributes.filter((a) => !present.has(a.toLowerCase()));
    if (missing.length) problems.push(`requested attributes without a programmer value: ${missing.join(", ")}`);
  }
  const layerSet = new Set(input.layers);
  const badLayer = inScope.filter((r) => rowLayers(r).some((l) => !layerSet.has(l)));
  if (badLayer.length) problems.push(`programmer values carry layers that were not requested (${[...new Set(badLayer.flatMap(rowLayers).filter((l) => !layerSet.has(l)))].join(", ")}): ${summarize(badLayer)}; pass layers to include them`);
  for (const [id, sfs] of input.scopeFixtures) {
    if (!inScope.some((r) => sfs.includes(r.subfixtureIndex))) problems.push(`fixture ${id} has no programmer value`);
  }
  if (input.mode === "universal" || input.force === "universal") {
    const byAttr = new Map<string, ProgrammerRow[]>();
    for (const r of inScope) byAttr.set(String(r.attribute), [...(byAttr.get(String(r.attribute)) ?? []), r]);
    const divergent = [...byAttr].filter(([, rs]) => rs.some((r) => !sameValue(r, rs[0])));
    if (divergent.length) problems.push(`universal data keeps one value per attribute, but these differ between fixtures: ${divergent.map(([a]) => a).join(", ")}; use selective or global, or give every fixture the same value`);
  }
  const refs = inScope.filter((r) => r.absPreset || r.relPreset);
  const embeddedSources = [...new Set(refs.map((r) => (r.absPreset ?? r.relPreset)!.addrNative ?? (r.absPreset ?? r.relPreset)!.name ?? "?"))];
  if (input.embed && refs.length === 0) problems.push("embed is true but no programmer value references a preset (call a preset with At Preset first)");
  if (!input.embed && refs.length) warnings.push(`programmer values reference ${embeddedSources.join(", ")}; with embed false they are stored as plain values, not references`);
  if (input.filterGroup) {
    const pool = input.filterGroup.pool.toLowerCase();
    const dropped = inScope.filter((r) => {
      const g = input.filterGroup!.groups.get(String(r.attribute));
      return g !== undefined && g.toLowerCase() !== pool;
    });
    if (dropped.length) problems.push(`the ${input.filterGroup.pool} pool's input filter would silently drop attributes of other feature groups: ${summarize(dropped)}; store into an All pool (21-25), or pass input_filter: false`);
    const unknown = inScope.filter((r) => !input.filterGroup!.groups.has(String(r.attribute)));
    if (unknown.length) warnings.push(`the feature group of ${[...new Set(unknown.map((r) => r.attribute))].join(", ")} is unknown, so whether the input filter keeps it is checked only after the store`);
  }
  return { rows: inScope, problems, warnings, embeddedSources };
}

function sameValue(a: ProgrammerRow, b: ProgrammerRow): boolean {
  const eq = (x: unknown, y: unknown) => (x === null || x === undefined ? y === null || y === undefined : near(x, y));
  return eq(a.value, b.value) && eq(a.relative, b.relative) && eq(a.phaser?.fade, b.phaser?.fade) && eq(a.phaser?.delay, b.phaser?.delay) && (a.absPreset?.addrNative ?? null) === (b.absPreset?.addrNative ?? null);
}

function summarize(rows: ProgrammerRow[]): string {
  const shown = rows.slice(0, 8).map(label).join(", ");
  return rows.length > 8 ? `${shown} and ${rows.length - 8} more` : shown;
}

/**
 * Compare what was stored with the programmer rows it came from. `mode` is the requested mode (forced modes check as
 * their target mode). Returns the differences; empty means verified.
 */
export function verifyStored(input: {
  rows: ProgrammerRow[];
  stored: PresetRow[];
  mode: Mode;
  forced: boolean;
  merge: boolean;
  embed: boolean;
  /** Fixture type per subfixture index, as preset.read computes it. */
  types: Record<string, string>;
  storedData?: string;
}): string[] {
  const out: string[] = [];
  const bySf = new Map<string, PresetRow>();
  for (const s of input.stored) bySf.set(`${s.sfIndex}|${s.attribute}`, s);
  const used = new Set<PresetRow>();
  for (const r of input.rows) {
    const attr = String(r.attribute);
    let match: PresetRow | undefined;
    if (input.mode === "universal") {
      match = input.stored.find((s) => s.attribute === attr && s.mode === "universal");
      if (!match) { out.push(`${label(r)}: no universal data stored`); continue; }
    } else {
      const own = bySf.get(`${r.subfixtureIndex}|${attr}`);
      if (input.mode === "selective") {
        if (!own) { out.push(`${label(r)}: not stored`); continue; }
        if (own.mode !== "selective") { out.push(`${label(r)}: stored as ${own.mode ?? "unknown"} data, not selective`); continue; }
        match = own;
      } else {
        const type = input.types[String(r.subfixtureIndex)];
        // Global: the fixture's own row (the global holder or selective data for a divergent fixture), else the
        // global row of its fixture type.
        match = own ?? input.stored.find((s) => s.attribute === attr && s.mode === "global" && type !== undefined && s.fixtureType === type);
        if (!match) { out.push(`${label(r)}: neither own nor global data of its fixture type (${type ?? "type unknown"}) stored`); continue; }
        if (match.mode === "universal") { out.push(`${label(r)}: stored as universal data, not global`); continue; }
      }
    }
    used.add(match);
    const diffs = compareRow(r, match, input.embed);
    if (diffs.length) out.push(`${label(r)}: ${diffs.join(", ")}`);
  }
  if (!input.merge) {
    // A new or overwritten preset holds only what was stored now.
    const expected = new Set(input.rows.map((r) => (input.mode === "universal" ? `u|${r.attribute}` : `${r.subfixtureIndex}|${r.attribute}`)));
    const extra = input.stored.filter((s) => !used.has(s) && !(input.mode === "universal" ? expected.has(`u|${s.attribute}`) : expected.has(`${s.sfIndex}|${s.attribute}`)) && !(input.mode === "global" && s.mode === "global"));
    if (extra.length) out.push(`unexpected stored content: ${extra.slice(0, 6).map((s) => `${s.fixture} ${s.attribute}`).join(", ")}${extra.length > 6 ? ` and ${extra.length - 6} more` : ""}`);
  }
  if (input.forced) {
    const want = input.mode === "universal" ? "Universal" : "Global";
    if (input.storedData !== undefined && input.storedData.trim() !== want) out.push(`after the forced conversion the preset holds ${JSON.stringify(input.storedData)}, not only ${want} data`);
  }
  return out.slice(0, 20);
}

function compareRow(r: ProgrammerRow, s: PresetRow, embed: boolean): string[] {
  const d: string[] = [];
  if ((r.stepCount ?? 1) > 1) {
    if ((s.stepCount ?? 1) !== r.stepCount) d.push(`${r.stepCount} steps expected, ${s.stepCount ?? 1} stored`);
  } else if (r.value !== null && r.value !== undefined && !near(r.value, s.value)) d.push(`value ${r.value} expected, ${s.value ?? "none"} stored`);
  if (r.relative && !near(r.relative, s.relative)) d.push(`relative ${r.relative} expected, ${s.relative ?? "none"} stored`);
  if (r.phaser?.fade !== null && r.phaser?.fade !== undefined && !near(r.phaser.fade, s.fade)) d.push(`fade ${r.phaser.fade} expected, ${s.fade ?? "none"} stored`);
  if (r.phaser?.delay !== null && r.phaser?.delay !== undefined && !near(r.phaser.delay, s.delay)) d.push(`delay ${r.phaser.delay} expected, ${s.delay ?? "none"} stored`);
  const src = r.absPreset?.addrNative;
  if (embed && src) {
    if (!s.absPreset) d.push(`reference to ${src} expected, a plain value stored`);
    else if (!s.absPreset.valid) d.push(`the stored reference is invalid`);
    else if (s.absPreset.addrNative !== src) d.push(`reference to ${src} expected, ${s.absPreset.addrNative} stored`);
  }
  if (!embed && s.absPreset) d.push(`a reference to ${s.absPreset.addrNative ?? "a preset"} was stored although embed is false`);
  return d;
}

// ---------------------------------------------------------------------------
// Bridge reads
// ---------------------------------------------------------------------------

const NEEDS_BRIDGE = "the console runs an older bridge plugin without the preset reads (bridge 0.22.0); update the plugin";
const unknownOp = (err: unknown) => err instanceof BridgeError && /unknown op/.test(err.message);
const notFound = (err: unknown) => err instanceof BridgeError && /no objects? found|no object at address/i.test(err.message);

function readFailure(name: string, op: string, err: unknown): StepResult {
  const s = asRead(stepFromError(name, err, { op }));
  if (unknownOp(err)) s.error = `${s.error}: ${NEEDS_BRIDGE}`;
  return s;
}

async function readPreset(bridge: Gma3Bridge, ref: string, t: number, typesFor?: number[]): Promise<PresetRead | null> {
  try {
    return (await bridge.request("preset.read", { ref, ...(typesFor ? { typesFor } : {}) }, t)) as PresetRead;
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
}

export interface DependencyInspection {
  complete: boolean;
  depthRead: number;
  invalid: Array<{ from: string; dependency: string }>;
  unreadable: string[];
  tree: Array<{ preset: string; dependsOn: string[] }>;
}

/** Follow embedded sources (by address) up to `maxDepth` levels; anything not followed makes it incomplete. */
export async function inspectDependencies(bridge: Gma3Bridge, root: PresetRead, t: number, maxDepth = 4): Promise<DependencyInspection> {
  const out: DependencyInspection = { complete: true, depthRead: 0, invalid: [], unreadable: [], tree: [] };
  const seen = new Set<string>([root.addr ?? root.ref]);
  let level: PresetRead[] = [root];
  for (let depth = 1; level.length; depth++) {
    const next: PresetRead[] = [];
    for (const p of level) {
      const name = presetLabel(p);
      if (p.dependenciesReadable === false) { out.complete = false; out.unreadable.push(`${name} (dependencies not readable)`); }
      out.tree.push({ preset: name, dependsOn: p.dependencies.map((d) => (d.valid ? depLabel(d) : "invalid")) });
      for (const d of p.dependencies) {
        if (!d.valid) { out.invalid.push({ from: name, dependency: "a deleted or invalid preset" }); continue; }
        if (!d.addr || seen.has(d.addr)) continue;
        seen.add(d.addr);
        if (depth > maxDepth) { out.complete = false; out.unreadable.push(`${depLabel(d)} (beyond depth ${maxDepth})`); continue; }
        try {
          const child = await readPreset(bridge, d.addr, t);
          if (child) next.push(child);
          else { out.complete = false; out.unreadable.push(`${depLabel(d)} (not found)`); }
        } catch (err) {
          out.complete = false;
          out.unreadable.push(`${depLabel(d)} (${err instanceof Error ? err.message : String(err)})`);
        }
      }
    }
    if (next.length) out.depthRead = depth;
    level = next;
  }
  return out;
}

const presetLabel = (p: PresetRead) => (p.pool?.no !== undefined && p.no !== undefined ? `Preset ${p.pool.no}.${p.no}` : p.addr ?? p.ref);
const depLabel = (d: ObjectRefInfo) => (d.pool !== undefined && d.no !== undefined ? `Preset ${d.pool}.${d.no}${d.name ? ` "${d.name}"` : ""}` : d.addr ?? "?");

function presentRows(rows: PresetRow[]) {
  return rows.map((r) => ({
    fixture: r.fixture,
    attribute: r.attribute,
    mode: r.mode ?? null,
    ...(r.value !== undefined && r.value !== null ? { value: r.value } : {}),
    ...(r.steps ? { steps: r.steps } : {}),
    ...(r.relative ? { relative: r.relative } : {}),
    ...(r.fade !== undefined && r.fade !== null ? { fade: r.fade } : {}),
    ...(r.delay !== undefined && r.delay !== null ? { delay: r.delay } : {}),
    ...(r.absPreset ? { embeddedFrom: r.absPreset.valid ? depLabel(r.absPreset) : "invalid reference" } : {}),
    ...(r.fixtureType ? { fixtureType: r.fixtureType } : {}),
  }));
}

// ---------------------------------------------------------------------------
// gma3_preset (read-only)
// ---------------------------------------------------------------------------

export async function presetInfo(ctx: ToolContext, raw: { preset?: string; pool?: number }): Promise<unknown> {
  const t = ctx.requestTimeoutMs;
  if ((raw.preset === undefined) === (raw.pool === undefined)) throw new ValidationError("give exactly one of preset (\"4.12\") or pool (4)");
  try {
    if (raw.pool !== undefined) {
      const pool = finiteNumber("pool", raw.pool, { integer: true, min: 1, max: 999 })!;
      const c = (await ctx.bridge.request("preset.context", { pool }, t)) as PresetContext;
      return { pool: c.pool, allPool: ALL_POOLS.includes(pool), storePreferences: c.preferencesReadable ? c.preferences : null, note: "storePreferences are the operator's defaults; gma3_store_preset overrides the ones that decide content with explicit options for each store and never changes them" };
    }
    const id = presetId("preset", raw.preset);
    const p = await readPreset(ctx.bridge, `Preset ${id.pool}.${id.number}`, t);
    if (!p) return { preset: raw.preset, exists: false };
    const deps = await inspectDependencies(ctx.bridge, p, t);
    return {
      preset: `${id.pool}.${id.number}`,
      exists: true,
      name: p.name,
      pool: p.pool,
      featureGroup: p.featureGroup || null,
      presetMode: p.presetMode,
      storedData: p.storedData || "",
      locked: p.lock === null || p.lock === undefined ? null : String(p.lock).trim() !== "" && String(p.lock).trim().toLowerCase() !== "no",
      hasMAtricks: p.hasMAtricks,
      referencedBy: p.referencedBy ?? null,
      count: p.count ?? p.rows.length,
      ...(p.truncated ? { truncated: true } : {}),
      rows: presentRows(p.rows),
      dependencies: p.dependencies.map((d) => ({ ...(d.valid ? { preset: depLabel(d) } : { preset: null }), valid: d.valid })),
      dependencyInspection: deps,
      note: "rows are what the preset stores (mode per row: selective, global on the lowest FID of a fixture type, universal on one holder), read with GetPresetData; values are percent. dependencyInspection follows embedded sources recursively and says when that was incomplete.",
    };
  } catch (err) {
    if (unknownOp(err)) throw new Error(NEEDS_BRIDGE);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// gma3_store_preset
// ---------------------------------------------------------------------------

interface StorePresetArgs {
  preset: string;
  fixtures: unknown;
  mode?: Mode;
  force?: "global" | "universal";
  existing?: "refuse" | "merge" | "overwrite";
  attributes?: unknown;
  layers?: unknown;
  embed?: boolean;
  input_filter?: boolean;
  matricks?: boolean;
  keep_activation?: boolean;
  name?: string;
  exclusive?: boolean;
  preview?: boolean;
  verify?: boolean;
}

const yn = (b: boolean) => (b ? '"Yes"' : '"No"');

/** The command for a store; every option that decides content is explicit. */
export function storeCommand(o: { pool: number; number: number; mode?: Mode; force?: "global" | "universal"; exists: boolean; existing: "refuse" | "merge" | "overwrite"; embed: boolean; matricks: boolean; keepActivation: boolean; inputFilter?: boolean }): string {
  // No /Look: every form of it (also /Look "No") turns Look on; the operator's StoreLook must be off instead.
  const parts = [`Store Preset ${o.pool}.${o.number}`, "/Programmer", "/Active"];
  if (o.force) parts.push(FORCE_OPTION[o.force], "/Merge");
  else {
    parts.push(MODE_OPTION[o.mode!]);
    if (o.exists) parts.push(o.existing === "merge" ? "/Merge" : "/Overwrite");
  }
  parts.push(`/Embed ${yn(o.embed)}`, `/MAtricks ${yn(o.matricks)}`, `/KeepActivation ${yn(o.keepActivation)}`);
  if (o.inputFilter !== undefined) parts.push(`/InputFilter ${yn(o.inputFilter)}`);
  parts.push("/NoConfirmation");
  return parts.join(" ");
}

export async function storePreset(ctx: ToolContext, raw: StorePresetArgs): Promise<OperationResult> {
  const op = "store_preset";
  const v = new Validator();
  const id = v.check(() => presetId("preset", raw.preset));
  let scopeIds: string[] = [];
  if (!Array.isArray(raw.fixtures) || raw.fixtures.length === 0) v.fail("fixtures must be a non-empty list of fixture ids (the scope every programmer value must belong to)");
  else (raw.fixtures as unknown[]).forEach((f, i) => { const ids = v.check(() => expandFixtures(`fixtures[${i}]`, f)); if (ids) scopeIds.push(...ids); });
  scopeIds = [...new Set(scopeIds)];
  if (scopeIds.length > MAX_SCOPE) v.fail(`fixtures expands to ${scopeIds.length} fixtures; at most ${MAX_SCOPE}`);
  const mode = raw.mode;
  const force = raw.force;
  if (mode !== undefined && !(MODES as readonly string[]).includes(mode)) v.fail(`mode must be one of ${MODES.join(", ")}`);
  if (force !== undefined && force !== "global" && force !== "universal") v.fail("force must be global or universal");
  if ((mode === undefined) === (force === undefined)) v.fail("give exactly one of mode (selective, global, universal) or force (global, universal: a forced conversion of an existing preset)");
  const existing = raw.existing ?? "refuse";
  if (!["refuse", "merge", "overwrite"].includes(existing)) v.fail("existing must be refuse, merge or overwrite");
  if (force !== undefined && existing !== "merge") v.fail("a forced conversion merges into the existing preset: pass existing: \"merge\" to acknowledge it");
  let attributes: string[] | undefined;
  if (raw.attributes !== undefined) {
    if (!Array.isArray(raw.attributes) || raw.attributes.length === 0) v.fail("attributes must be a non-empty list of attribute names");
    else attributes = (raw.attributes as unknown[]).map((a, i) => v.check(() => attributeName(`attributes[${i}]`, a))).filter((a): a is string => !!a);
  }
  let layers: Layer[] = ["absolute"];
  if (raw.layers !== undefined) {
    if (!Array.isArray(raw.layers) || raw.layers.length === 0 || raw.layers.some((l) => !(LAYERS as readonly string[]).includes(l as string))) v.fail(`layers must be a non-empty list of ${LAYERS.join(", ")}`);
    else layers = [...new Set(raw.layers as Layer[])];
  }
  const embed = boolOpt(v, "embed", raw.embed) ?? false;
  const inputFilter = boolOpt(v, "input_filter", raw.input_filter);
  const matricks = boolOpt(v, "matricks", raw.matricks) ?? false;
  const keepActivation = boolOpt(v, "keep_activation", raw.keep_activation) ?? false;
  const preview = boolOpt(v, "preview", raw.preview) ?? false;
  const verify = boolOpt(v, "verify", raw.verify) ?? true;
  const name = v.check(() => objectName("name", raw.name, { optional: true }));
  if (!preview && raw.exclusive !== true) v.fail("exclusive must be true: storing a preset reads the whole programmer, stores it and (unless keep_activation) deactivates the stored values; nobody else may change the programmer while the tool runs. preview: true needs no acknowledgement");
  const target: Record<string, unknown> = { preset: raw.preset };
  if (!v.ok || !id) return validationFailure(op, target, v.errors);
  const ref = `Preset ${id.pool}.${id.number}`;
  target.presetRef = ref;
  const bridge = ctx.bridge;
  const t = ctx.requestTimeoutMs;
  const targetMode: Mode = (force ?? mode)!;

  const body = async (): Promise<OperationResult> => {
    let context: PresetContext | null = null;
    let current: PresetRead | null = null;
    let scan: ProgrammerScan | null = null;
    const scope = new Map<number, string>();
    const scopeFixtures = new Map<string, number[]>();
    const groups = new Map<string, string>();
    const subAddrs = new Map<number, string>();
    const inspect = await runSteps([
      {
        name: "read_context",
        run: async () => {
          try {
            context = (await bridge.request("preset.context", { pool: id.pool }, t)) as PresetContext;
            if (!context.pool?.exists) return asRead({ name: "read_context", status: "failed", op: "preset.context", error: `preset pool ${id.pool} does not exist` });
            if (!context.preferencesReadable) return asRead({ name: "read_context", status: "failed", op: "preset.context", error: "the store preferences could not be read, so the operator defaults cannot be shown unchanged; nothing was sent" });
            const look = String(context.preferences.StoreLook ?? "").trim().toLowerCase();
            if (look !== "no" && look !== "off") {
              return asRead({ name: "read_context", status: "failed", op: "preset.context", detail: { StoreLook: context.preferences.StoreLook }, error: `the operator's StoreLook store preference is ${JSON.stringify(context.preferences.StoreLook)}: a store would also take every fixture with an open dimmer, and no store option turns Look off (/Look "No" turns it on). Ask the operator to set Look off in the store preferences; nothing was sent` });
            }
            return asRead({ name: "read_context", status: "succeeded", op: "preset.context", detail: { pool: context.pool } });
          } catch (err) {
            return readFailure("read_context", "preset.context", err);
          }
        },
      },
      {
        name: "check_preset",
        run: async () => {
          try {
            current = await readPreset(bridge, ref, t);
          } catch (err) {
            return readFailure("check_preset", "preset.read", err);
          }
          const c = current as PresetRead | null;
          if (!c) {
            if (force) return asRead({ name: "check_preset", status: "failed", op: "preset.read", error: `${ref} does not exist; a forced conversion needs an existing preset` });
            return asRead({ name: "check_preset", status: "succeeded", op: "preset.read", detail: { exists: false } });
          }
          const lock = c.lock === null || c.lock === undefined ? null : String(c.lock).trim();
          if (lock === null) return asRead({ name: "check_preset", status: "failed", op: "preset.read", error: `the Lock of ${ref} could not be read; nothing was sent` });
          if (lock !== "" && lock.toLowerCase() !== "no") return asRead({ name: "check_preset", status: "failed", op: "preset.read", error: `${ref} is locked; Store answers "Object locked"` });
          if (existing === "refuse") return asRead({ name: "check_preset", status: "failed", op: "preset.read", detail: { storedData: c.storedData, count: c.count }, error: `${ref} ("${c.name}") already exists (${c.count ?? c.rows.length} rows, ${c.storedData || "empty"}); pass existing: "merge" or "overwrite"` });
          return asRead({ name: "check_preset", status: "succeeded", op: "preset.read", detail: { exists: true, name: c.name, storedData: c.storedData, count: c.count } });
        },
      },
      {
        name: "resolve_fixtures",
        run: async () => {
          const missing: string[] = [];
          try {
            for (const fid of scopeIds) {
              let fa: FixtureAttributes;
              try {
                fa = (await bridge.request("fixtureAttributes", { ref: `Fixture ${fid}`, limit: 500 }, t)) as FixtureAttributes;
              } catch (err) {
                if (notFound(err)) { missing.push(fid); continue; }
                throw err;
              }
              const sfs: number[] = [];
              const add = (sf: number | undefined) => { if (typeof sf === "number") { sfs.push(sf); scope.set(sf, fid); } };
              add(fa.subfixtureIndex);
              for (const a of fa.attributes ?? []) if (a.attribute && a.featureGroup) groups.set(a.attribute, a.featureGroup);
              // A fixture's cells belong to its scope (and theirs, two levels down).
              let level = fa.subfixtures ?? [];
              for (let depth = 0; depth < 3 && level.length; depth++) {
                const nextLevel: NonNullable<FixtureAttributes["subfixtures"]> = [];
                for (const s of level) {
                  add(s.subfixtureIndex);
                  if (s.addr && typeof s.subfixtureIndex === "number") subAddrs.set(s.subfixtureIndex, s.addr);
                  if ((s.childCount ?? 0) > 0 && s.addr) {
                    const sub = (await bridge.request("fixtureAttributes", { ref: s.addr, limit: 500 }, t)) as FixtureAttributes;
                    nextLevel.push(...(sub.subfixtures ?? []));
                  }
                }
                level = nextLevel;
              }
              scopeFixtures.set(fid, sfs);
            }
          } catch (err) {
            return readFailure("resolve_fixtures", "fixtureAttributes", err);
          }
          if (missing.length) return asRead({ name: "resolve_fixtures", status: "failed", op: "fixtureAttributes", detail: { missing }, error: `not in the patch: ${missing.join(", ")}` });
          return asRead({ name: "resolve_fixtures", status: "succeeded", op: "fixtureAttributes", detail: { fixtures: scopeIds.length, subfixtures: scope.size } });
        },
      },
      {
        name: "read_programmer",
        run: async () => {
          try {
            scan = (await bridge.request("programmer", { scope: "all", limit: 5000, maxChannels: 50000 }, t)) as ProgrammerScan;
          } catch (err) {
            return readFailure("read_programmer", "programmer", err);
          }
          const s = scan as ProgrammerScan;
          // Deactivated values (e.g. after an earlier store) are reported as a limitation; /Active does not store them.
          const limits = (s.limitations ?? []).filter((l) => !/activity masks zero/.test(String(l)));
          if (s.coverage?.complete !== true || (s.stats?.channelErrors ?? 0) > 0 || limits.length || s.total > s.rows.length) {
            return asRead({ name: "read_programmer", status: "failed", op: "programmer", detail: { coverage: s.coverage, total: s.total, limitations: s.limitations }, error: "the programmer scan was incomplete, so content the store would include cannot be ruled out; nothing was sent" });
          }
          return asRead({ name: "read_programmer", status: "succeeded", op: "programmer", detail: { rows: s.rows.length } });
        },
      },
    ]);
    const ctxPrefs = (context as PresetContext | null)?.preferences ?? {};
    const cur = current as PresetRead | null;
    const extra: Record<string, unknown> = { existing: cur ? { name: cur.name, storedData: cur.storedData, count: cur.count ?? cur.rows.length } : null, storePreferences: ctxPrefs };
    if (inspect.outcome !== "succeeded") {
      return buildResult({ operation: op, target, steps: inspect.steps, summary: `${op} was not performed; nothing was sent: ${inspect.steps.find((s) => s.status !== "succeeded")?.error ?? "inspection failed"}`, extra });
    }
    const effectiveFilter = inputFilter ?? String(ctxPrefs.PresetInputFilter ?? "").toLowerCase() === "yes";
    const filterApplies = effectiveFilter && !ALL_POOLS.includes(id.pool);
    if (filterApplies) {
      // Attributes that only cells have (a cell's Dimmer, RGB): read the feature group from one such cell.
      for (const r of (scan as ProgrammerScan | null)?.rows ?? []) {
        const addr = subAddrs.get(r.subfixtureIndex);
        if (!r.attribute || groups.has(r.attribute) || !addr) continue;
        try {
          const fa = (await bridge.request("fixtureAttributes", { ref: addr, limit: 500 }, t)) as FixtureAttributes;
          for (const a of fa.attributes ?? []) if (a.attribute && a.featureGroup) groups.set(a.attribute, a.featureGroup);
        } catch {
          // left unknown: analyzeContent warns and the read-back decides
        }
      }
    }
    const poolName = (context as PresetContext | null)?.pool?.name ?? String(id.pool);
    const plan = analyzeContent({
      rows: (scan as ProgrammerScan | null)?.rows ?? [],
      scope,
      scopeFixtures,
      attributes,
      layers,
      mode,
      force,
      embed,
      filterGroup: filterApplies ? { pool: poolName, groups } : undefined,
    });
    const warnings = [...plan.warnings];
    const poolFilter = (context as PresetContext | null)?.pool?.inputFilter;
    if (effectiveFilter && poolFilter) warnings.push(`the pool has its own input filter (${poolFilter}); its effect is not predicted and is checked after the store`);
    if (force) warnings.push(`force ${force}: the existing ${force === "global" ? "selective data of the fixture types stored" : "selective and global data"} of ${ref} is removed`);
    const command = storeCommand({ pool: id.pool, number: id.number, mode, force, exists: !!cur, existing, embed, matricks, keepActivation, inputFilter });
    const intended = {
      command,
      mode: targetMode,
      forced: !!force,
      existing: cur ? existing : "new",
      rows: plan.rows.length,
      fixtures: scopeIds,
      layers,
      embed,
      embeddedSources: plan.embeddedSources,
      inputFilter: { effective: effectiveFilter, explicit: inputFilter !== undefined, appliesToPool: !ALL_POOLS.includes(id.pool) },
      matricks,
      keepActivation,
      operatorDefaultsKept: "the options are sent with this store only; the StorePreferences object is read before and after",
    };
    extra.intended = intended;
    if (plan.problems.length) {
      const s: StepResult = asRead({ name: "check_content", status: "failed", detail: { problems: plan.problems }, error: plan.problems.join("; ") });
      return buildResult({ operation: op, target, steps: [...inspect.steps, s], summary: `${op} refused, nothing was sent: ${plan.problems.join("; ")}`, warnings, extra });
    }
    inspect.steps.push(asRead({ name: "check_content", status: "succeeded", detail: { rows: plan.rows.length } }));
    if (preview) {
      return buildResult({ operation: op, target, steps: inspect.steps, summary: `Preview only; nothing was sent. ${plan.rows.length} programmer value(s) of ${scopeIds.length} fixture(s) would be stored into ${ref} (${cur ? existing : "new"}, ${force ? `forced ${force}` : targetMode}) with: ${command}`, warnings, extra: { ...extra, preview: true } });
    }

    const main = await runSteps([
      { name: "store", run: () => commandStep(bridge, "store", command, t) },
      ...(name !== undefined
        ? [{ name: "set_name", run: () => requestStep(bridge, "set_name", "set", { ref, property: "Name", value: name }, (res) => {
            const got = (res as { value?: unknown } | null)?.value;
            if (got === undefined || got === null) return { name: "set_name", status: "unknown", op: "set", error: `the name of ${ref} could not be read back` };
            return String(got).trim() === name ? { name: "set_name", status: "succeeded", op: "set" } : { name: "set_name", status: "failed", op: "set", detail: { readBack: got }, error: `the console did not apply the name: it reads ${JSON.stringify(got)}` };
          }, t) }]
        : []),
    ]);
    const steps = [...inspect.steps, ...main.steps];
    const stored = main.steps[0]?.status === "succeeded";
    let verification: Verification = notRequested();
    let resulting: unknown = null;
    if (verify && stored) {
      const checks: string[] = [];
      let ok = true;
      try {
        const sfs = [...new Set(plan.rows.map((r) => r.subfixtureIndex))];
        const after = await readPreset(bridge, ref, t, sfs);
        if (!after) throw new Error(`${ref} does not exist after the store`);
        const deps = await inspectDependencies(bridge, after, t);
        resulting = { name: after.name, presetMode: after.presetMode, storedData: after.storedData, count: after.count, rows: presentRows(after.rows), dependencies: after.dependencies.map((d) => ({ preset: d.valid ? depLabel(d) : null, valid: d.valid })), dependencyInspection: deps };
        steps.push(asRead({ name: "read_back", status: "succeeded", op: "preset.read", detail: { rows: after.rows.length, storedData: after.storedData } }));
        checks.push(...verifyStored({ rows: plan.rows, stored: after.rows, mode: targetMode, forced: !!force, merge: !!cur && (existing === "merge" || !!force), embed, types: after.types ?? {}, storedData: after.storedData }));
        if (!force && !cur && String(after.presetMode ?? "").toLowerCase() !== targetMode) checks.push(`the preset's mode reads ${JSON.stringify(after.presetMode)}, not ${targetMode}`);
        if (after.truncated) checks.push("the read-back was truncated");
        if (name !== undefined && String(after.name ?? "").trim() !== name) checks.push(`name reads ${JSON.stringify(after.name)}`);
        if (embed && deps.invalid.length) checks.push(`invalid dependencies: ${deps.invalid.map((d) => d.from).join(", ")}`);
        if (deps.invalid.length && !embed) warnings.push("the preset has invalid dependencies from earlier content");
        if (!deps.complete) warnings.push(`dependency inspection incomplete: ${deps.unreadable.join("; ")}`);
      } catch (err) {
        ok = false;
        steps.push(readFailure("read_back", "preset.read", err));
      }
      try {
        const c2 = (await bridge.request("preset.context", {}, t)) as PresetContext;
        const changed = Object.keys(ctxPrefs).filter((k) => String(c2.preferences?.[k] ?? "") !== String(ctxPrefs[k] ?? ""));
        if (changed.length) checks.push(`operator store preferences changed: ${changed.map((k) => `${k} ${JSON.stringify(ctxPrefs[k])} -> ${JSON.stringify(c2.preferences?.[k])}`).join(", ")}`);
        steps.push(asRead({ name: "check_preferences", status: "succeeded", op: "preset.context", detail: { unchanged: changed.length === 0 } }));
      } catch (err) {
        ok = false;
        steps.push(readFailure("check_preferences", "preset.context", err));
      }
      const checked = `the stored rows of ${ref} against the ${plan.rows.length} programmer value(s) (${force ? `forced ${force}` : targetMode}, ${embed ? "references" : "plain values"}), the preset's mode${name !== undefined ? ", name" : ""} and the operator store preferences`;
      if (checks.length) verification = { status: "mismatched", checked, detail: checks.join("; ") };
      else if (ok) verification = { status: "matched", checked };
      else verification = unavailable(`the preset or the preferences could not be read back: ${[...steps].reverse().find((s) => s.status !== "succeeded")?.error ?? "unknown"}`, ref);
    }
    return buildResult({ operation: op, target, steps, verification, warnings, extra: { ...extra, resulting } });
  };
  return preview ? body() : ctx.mutations.run(body);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const registerPresetTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_preset",
    {
      title: "Read a preset's stored content and references, or a pool's storage defaults",
      description:
        "Read-only. preset: \"<pool>.<number>\" returns what the preset actually stores: per fixture and attribute the mode the value was stored in (selective; global, held by the lowest FID of a fixture type; universal, one holder), value (percent) or steps, fade/delay, and the source preset of an embedded value; plus PresetMode, StoredData, lock, how many objects reference it, " +
        "and its dependencies (embedded sources) followed recursively with validity (a deleted source is an invalid dependency) and whether that inspection was complete. pool: <n> returns the pool's default mode and input filter and the operator's store preferences (the defaults a store would otherwise use). Needs bridge 0.22.0.",
      inputSchema: {
        preset: z.string().optional().describe('Preset as "<pool>.<number>", e.g. "4.12".'),
        pool: z.number().optional().describe("Preset pool number (1-9 feature groups, 21-25 All pools)."),
      },
    },
    async (args) => {
      try {
        return json(await presetInfo(ctx, args as { preset?: string; pool?: number }));
      } catch (err) {
        return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    "gma3_store_preset",
    {
      title: "Store the programmer into a preset with explicit storage rules",
      description:
        "Store the current programmer content into Preset <pool>.<number>. Prepare the programmer first (gma3_select, gma3_set_attribute/color/position, At Preset ... for embedding); this tool only stores. " +
        "Explicit rules: mode selective | global | universal (never the pool default: a default store resolves a mode conflict silently and can keep one fixture's values), or force global | universal for a forced conversion of an existing preset (removes its selective, or selective and global, data; needs existing: \"merge\"). " +
        "existing: refuse (default) | merge | overwrite. fixtures: the scope; every active programmer value must belong to these fixtures (a fixture includes its cells) and each must have one; attributes (optional): exact attribute filter (an activation group, e.g. all ColorRGB_*, is activated as a whole); layers (default [absolute]; also relative, fade, delay, phaser) must cover every value's layers. " +
        "Anything else in the programmer is refused, because the console stores every active value regardless of the selection. Also refused: universal mode with values that differ between fixtures, embed without a preset reference in the programmer, attributes a feature-group pool's input filter would drop (store into an All pool 21-25 or pass input_filter: false), a locked preset. " +
        "embed (default false) stores references to the presets active in the programmer; matricks (default false) the selection MAtricks; keep_activation (default false); input_filter overrides the operator default for this store only. The command always carries /Programmer /Active, the mode, /Merge or /Overwrite, /Embed, /MAtricks, /KeepActivation and /NoConfirmation, so the operator's store preferences decide nothing and are not changed (read before and after); Look cannot be overridden per store, so the tool refuses while the operator's StoreLook preference is on. " +
        "Requires exclusive: true (not for preview). verify (default true) reads the stored rows back and checks each programmer value by mode, value, layers and reference, unexpected content, the preset's mode, dependencies (recursively; incomplete inspection is reported) and that the store preferences are unchanged. Needs bridge 0.22.0.",
      inputSchema: {
        preset: z.string().describe('Target preset "<pool>.<number>", e.g. "4.12" or "23.1".'),
        fixtures: z.array(z.union([z.string(), z.number()])).describe('Scope: fixture ids or "a Thru b" ranges; every programmer value must belong to them.'),
        mode: z.enum(MODES).optional().describe("Preset mode the data is stored in."),
        force: z.enum(["global", "universal"]).optional().describe("Forced conversion of an existing preset instead of mode (needs existing: merge)."),
        existing: z.enum(["refuse", "merge", "overwrite"]).optional().describe("What to do when the preset exists (default refuse)."),
        attributes: z.array(z.string()).optional().describe("Exact attribute filter: the programmer may hold only these attributes, and each must be present."),
        layers: z.array(z.enum(LAYERS)).optional().describe("Data layers the values may carry (default [absolute])."),
        embed: z.boolean().optional().describe("Store references to the presets active in the programmer (default false: plain values)."),
        input_filter: z.boolean().optional().describe("Override the operator's preset input-filter default for this store only."),
        matricks: z.boolean().optional().describe("Store the selection MAtricks into the preset (default false)."),
        keep_activation: z.boolean().optional().describe("Keep the stored values active in the programmer (default false)."),
        name: z.string().optional().describe("Preset name."),
        exclusive: z.boolean().optional().describe("Required (true) unless preview: nobody else changes the programmer while the tool runs."),
        preview: z.boolean().optional().describe("Only read, check and return the planned command (default false)."),
        verify: z.boolean().optional().describe("Read back and check the stored content (default true)."),
      },
    },
    async (args) => operation(() => storePreset(ctx, args as StorePresetArgs)),
  );
};
