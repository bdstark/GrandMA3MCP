/**
 * SU-06: cue lists and chases in batches (SETUP.md SU-06, docs/probes/su-06-cuelists-macos-2.5.1.md).
 *
 *   gma3_store_cues   a list of cues, each from explicit looks (fixtures + presets, intensity, attribute values)
 *   gma3_edit_cues    trigger, timing and names on a cue range of an existing sequence
 *   gma3_build_chase  a chase: one cue per look or preset, a Time trigger on every cue, Wrap Around, one observed cycle
 *
 * No bridge change: the looks use the SU-05 commands and read-back, the properties the FR-04/FR-05 `set` writes.
 *
 * Console facts (onPC 2.5.1, probed 2026-10-15):
 *   - The cues are built in the Preview environment, which has its own programmer and selection: nothing is output
 *     while a look is built, the operator's Normal programmer is not touched, and `Store Sequence N Cue C` stores the
 *     Preview programmer. Preset links (abs_preset) read back there as in Normal.
 *   - The programmer keeps its values after a Store, so each cue starts from ClearAll (sent only after the console
 *     confirms Preview: in Normal it would discard the operator's programmer).
 *   - A cue's stored values cannot be read back (no GetCueData on 2.5.1), so each look is checked in the programmer
 *     right before its store; a look that did not apply stops the batch before that cue is stored.
 *   - A cue stored without a name is named after the preset it holds ("[4.901]").
 *   - A Time trigger counts from the previous cue's start (a fade does not lengthen the step); with Wrap Around the
 *     last cue is followed by cue 1 only when cue 1 has a trigger too. `Goto Sequence N Cue C` from off starts the
 *     chase at C. CurrentCue keeps naming the last cue after Off; HasActivePlayback turns true a frame after a Go.
 */
import { z } from "zod";
import type { Gma3Bridge } from "../bridge.js";
import {
  asRead,
  buildResult,
  commandStep,
  compareFields,
  notRequested,
  outcomeOf,
  requestStep,
  runSteps,
  stepFromError,
  timeToSeconds,
  unavailable,
  validationFailure,
  type OperationResult,
  type StepFn,
  type StepResult,
  type Verification,
} from "../results.js";
import { Validator, ValidationError, attributeName, cueNumber, finiteNumber, fixtureSelection, objectName, objectNumber, oneOf, percent, timeSeconds } from "../validate.js";
import { cueRef, exists } from "./common.js";
import { operation, type RegisterTools, type ToolContext } from "./context.js";
import { BATCH_NOTE, batchOptionShape, compactResult, duplicates, runBatchCall } from "../batch.js";
import { TIME_NORMALIZERS, TIMING_PROPS, TRIGGERS, TRIGGER_KEYS, type TimingKey, type TriggerKey } from "./cues.js";
import {
  ATTRIBUTE_UNITS,
  ATTRIBUTE_UNIT_NAMES,
  MAX_ATTRIBUTES,
  attributeCommand,
  formatValue,
  presetRef,
  snapshotProgrammer,
  verifyPresetLink,
  verifyProgrammer,
  type AttributeUnit,
  type Expectation,
  type ProgrammerSnapshot,
} from "./fixtures.js";
import { cueNo, readSequenceRate } from "./speed.js";
import { effectAttributes, effectCommands, parsePhaser, parseStep, verifyBuild, type Effect, type Unit } from "./phasers.js";
import { SEQUENCE_SETTINGS, configureSequence, findReferences, settingValue, type ConfigureSequenceArgs } from "./playback.js";
import { HeldLock } from "../mutations.js";

export const MAX_CUES = 100;
export const MAX_LOOKS = 16;
export const MAX_PRESETS_PER_LOOK = 8;
const OBSERVE_DEFAULT_S = 45;
const OBSERVE_MAX_S = 120;
const SAMPLE_MS = 40;

const NOT_READABLE =
  "A cue's stored values cannot be read back on 2.5.1 (no GetCueData); each look was checked in the Preview programmer right before its cue was stored.";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface PresetSpec {
  pool: number;
  preset: number | string;
  ref: string;
}
interface ValueSpec {
  attribute: string;
  value: number;
  unit?: AttributeUnit;
}
export interface LookSpec {
  fixtures: string;
  presets: PresetSpec[];
  intensity?: number;
  values: ValueSpec[];
  /** SU-14: a phaser built on the look's fixtures (steps and phaser layers, as gma3_build_phaser takes them). */
  phaser?: Effect;
}
export interface CueSpec {
  cue: string;
  name?: string;
  looks: LookSpec[];
  /** SU-14: the cue's command (Part 0 Command), run when the cue is called. */
  command?: string;
  timing: Partial<Record<Exclude<TimingKey, "snap_delay">, number>>;
  trigger?: TriggerKey;
  time?: number;
}

function validatePreset(v: Validator, raw: unknown, path: string): PresetSpec | undefined {
  const r = (raw ?? {}) as { pool?: unknown; preset?: unknown };
  const pool = v.check(() => finiteNumber(`${path}.pool`, r.pool, { integer: true, min: 1, max: 9999 }));
  let preset: number | string | undefined;
  if (typeof r.preset === "number") preset = v.check(() => finiteNumber(`${path}.preset`, r.preset, { integer: true, min: 1, max: 99999 }));
  else if (typeof r.preset === "string" && r.preset.trim() !== "" && !/["\u0000-\u001f]/.test(r.preset)) preset = r.preset.trim();
  else v.fail(`${path}.preset must be a number or a name without quotes`);
  if (pool === undefined || preset === undefined) return undefined;
  return { pool, preset, ref: presetRef(pool, preset) };
}

/** SU-14: a cue command: one command line (several statements separated by ;), no quotes problems, no control characters. */
export function cueCommand(field: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ValidationError(`${field} must be a command line (a string)`, field);
  const c = value.trim();
  if (/[\u0000-\u001f\u007f]/.test(c)) throw new ValidationError(`${field} must be one line without control characters`, field);
  if (c.length > 1024) throw new ValidationError(`${field} is longer than 1024 characters`, field);
  if ((c.match(/"/g) ?? []).length % 2 === 1) throw new ValidationError(`${field} has an unbalanced quote`, field);
  return c;
}

/** SU-14: a look's phaser: steps (2-16) and phaser layers, in percent or physical units (gma3_build_phaser's step form). */
function validateLookPhaser(v: Validator, raw: unknown, path: string): Effect | undefined {
  if (raw === undefined) return undefined;
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.template !== undefined) {
    v.fail(`${path}: a look's phaser takes steps and phaser (templates are built with gma3_build_phaser into a preset, which the look can then recall)`);
    return undefined;
  }
  const unit = (r.unit ?? "percent") as Unit;
  if (unit !== "percent" && unit !== "physical") v.fail(`${path}.unit must be percent or physical`);
  if (!Array.isArray(r.steps) || r.steps.length < 2 || r.steps.length > 16) {
    v.fail(`${path}.steps must hold 2-16 steps (a phaser has at least two)`);
    return undefined;
  }
  const steps = r.steps.map((st, i) => v.check(() => parseStep(`${path}.steps[${i}]`, st, unit)));
  if (steps.some((st) => st?.preset)) v.fail(`${path}: a look's phaser steps take values, not presets`);
  const phaser = v.check(() => parsePhaser(r.phaser));
  // The forms that depend on the fixture count and order (SU-13) are built by gma3_build_phaser into a preset.
  if (phaser && (phaser.phaseStep || phaser.phaseSpread || phaser.shuffle !== undefined)) v.fail(`${path}.phaser: a look's phaser takes phase {from, to}; a phase step, "spread" or shuffle is built with gma3_build_phaser into a preset, which the look can recall`);
  if (!phaser || !steps.every((st): st is NonNullable<typeof st> => !!st)) return undefined;
  return { steps, phaser, unit };
}

/** A look: a target and what to give it. Presets first, then intensity, then values (later commands win), then a phaser. */
function validateLook(v: Validator, raw: unknown, path: string, defaultFixtures: string | undefined): LookSpec | undefined {
  const r = (raw ?? {}) as { fixtures?: unknown; presets?: unknown; intensity?: unknown; values?: unknown; phaser?: unknown };
  let fixtures: string | undefined;
  if (r.fixtures !== undefined) fixtures = v.check(() => fixtureSelection(`${path}.fixtures`, r.fixtures));
  else if (defaultFixtures) fixtures = defaultFixtures;
  else v.fail(`${path}.fixtures is required (or give fixtures for the whole call)`);
  const presets: PresetSpec[] = [];
  if (r.presets !== undefined) {
    if (!Array.isArray(r.presets)) v.fail(`${path}.presets must be a list`);
    else if (r.presets.length > MAX_PRESETS_PER_LOOK) v.fail(`${path}: at most ${MAX_PRESETS_PER_LOOK} presets per look`);
    else r.presets.forEach((p, i) => { const x = validatePreset(v, p, `${path}.presets[${i}]`); if (x) presets.push(x); });
  }
  const intensity = r.intensity === undefined ? undefined : v.check(() => percent(`${path}.intensity`, r.intensity));
  const values: ValueSpec[] = [];
  if (r.values !== undefined) {
    if (!Array.isArray(r.values)) v.fail(`${path}.values must be a list`);
    else if (r.values.length > MAX_ATTRIBUTES) v.fail(`${path}: at most ${MAX_ATTRIBUTES} values per look`);
    else
      r.values.forEach((e, i) => {
        const x = (e ?? {}) as { attribute?: unknown; value?: unknown; unit?: unknown };
        const attribute = v.check(() => attributeName(`${path}.values[${i}].attribute`, x.attribute));
        const unit = v.check(() => oneOf(`${path}.values[${i}].unit`, x.unit, ATTRIBUTE_UNIT_NAMES, { optional: true }));
        const rule = unit ? ATTRIBUTE_UNITS[unit] : { min: undefined, max: undefined, integer: false };
        const value = v.check(() => finiteNumber(`${path}.values[${i}].value`, x.value, { min: rule.min, max: rule.max, integer: rule.integer }));
        if (value !== undefined && value < 0 && !(unit === "physical" || unit === "natural")) v.fail(`${path}.values[${i}].value must not be negative for unit ${unit ?? "readout"}`);
        if (attribute && values.some((y) => y.attribute.toLowerCase() === attribute.toLowerCase())) v.fail(`${path}: attribute ${attribute} appears twice`);
        if (attribute && intensity !== undefined && attribute.toLowerCase() === "dimmer") v.fail(`${path}: Dimmer and intensity are the same attribute: give one of them`);
        if (attribute && value !== undefined) values.push({ attribute, value, ...(unit ? { unit } : {}) });
      });
  }
  const phaser = validateLookPhaser(v, r.phaser, `${path}.phaser`);
  if (phaser) for (const a of Object.keys(phaser.steps.flatMap((st) => Object.keys(st.values)).reduce((m, k) => ({ ...m, [k]: 1 }), {} as Record<string, number>))) {
    if (values.some((x) => x.attribute.toLowerCase() === a.toLowerCase()) || (a.toLowerCase() === "dimmer" && intensity !== undefined)) v.fail(`${path}: ${a} is both a static value and a phaser attribute: give it once`);
  }
  if (presets.length === 0 && intensity === undefined && values.length === 0 && !phaser && v.ok) v.fail(`${path}: give presets, intensity, values and/or a phaser`);
  if (!fixtures) return undefined;
  return { fixtures, presets, intensity, values, ...(phaser ? { phaser } : {}) };
}

/**
 * The looks of a cue: `looks`, or the shorthand fields (fixtures, presets, intensity, values, phaser) as one look.
 * `allowEmpty`: a cue with a command may have no look at all (a command-only cue, stored from an empty programmer).
 */
export function validateLooks(v: Validator, raw: Record<string, unknown>, path: string, defaultFixtures: string | undefined, allowEmpty = false): LookSpec[] {
  const shorthand = ["presets", "intensity", "values", "phaser"].some((k) => raw[k] !== undefined) || (raw.fixtures !== undefined && !allowEmpty);
  if (raw.looks !== undefined) {
    if (shorthand) v.fail(`${path}: give looks, or fixtures/presets/intensity/values, not both`);
    if (!Array.isArray(raw.looks) || raw.looks.length === 0) {
      v.fail(`${path}.looks must be a non-empty list`);
      return [];
    }
    if (raw.looks.length > MAX_LOOKS) v.fail(`${path}: at most ${MAX_LOOKS} looks per cue`);
    return raw.looks.slice(0, MAX_LOOKS).flatMap((l, i) => validateLook(v, l, `${path}.looks[${i}]`, defaultFixtures) ?? []);
  }
  if (!shorthand) {
    if (allowEmpty) return [];
    v.fail(`${path}: give its content (presets, intensity, values, phaser or looks), or a command`);
    return [];
  }
  const look = validateLook(v, raw, path, defaultFixtures);
  return look ? [look] : [];
}

function validateTrigger(v: Validator, rawTrigger: unknown, rawTime: unknown, path: string, timeFromSaved = false): { trigger?: TriggerKey; time?: number } {
  const trigger = v.check(() => oneOf(`${path}trigger`, rawTrigger, TRIGGER_KEYS, { optional: true }));
  const time = v.check(() => timeSeconds(`${path}time`, rawTime, { optional: true }));
  if (time !== undefined && trigger === undefined) v.fail(`${path}time needs a trigger ("time" or "follow")`);
  if (trigger === "time" && time === undefined && !timeFromSaved) v.fail(`${path}time (seconds) is required for trigger "time" (or restore_times: true to set the saved ones)`);
  if ((trigger === "go" || trigger === "sound" || trigger === "bpm") && time !== undefined) v.fail(`${path}time is not applicable to trigger "${trigger}"`);
  return { trigger, time };
}

function validateTiming(v: Validator, raw: Record<string, unknown>, path: string): CueSpec["timing"] {
  const timing: CueSpec["timing"] = {};
  for (const k of ["fade", "delay", "out_fade", "out_delay"] as const) {
    const x = v.check(() => timeSeconds(`${path}${k}`, raw[k], { optional: true }));
    if (x !== undefined) timing[k] = x;
  }
  return timing;
}

function validateCues(v: Validator, raw: unknown, defaultFixtures: string | undefined): CueSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    v.fail("cues must be a non-empty list");
    return [];
  }
  if (raw.length > MAX_CUES) {
    v.fail(`at most ${MAX_CUES} cues per call`);
    return [];
  }
  const out: CueSpec[] = [];
  raw.forEach((c, i) => {
    const r = (c ?? {}) as Record<string, unknown>;
    const path = `cues[${i}]`;
    const cue = v.check(() => cueNumber(`${path}.cue`, r.cue));
    const name = v.check(() => objectName(`${path}.name`, r.name, { optional: true }));
    const command = v.check(() => cueCommand(`${path}.command`, r.command));
    const looks = validateLooks(v, r, path, defaultFixtures, command !== undefined);
    const timing = validateTiming(v, r, `${path}.`);
    const trig = validateTrigger(v, r.trigger, r.time, `${path}.`);
    if (cue && out.some((x) => Number(x.cue) === Number(cue))) v.fail(`${path}: cue ${cue} appears twice`);
    if (cue) out.push({ cue, name, looks, ...(command !== undefined ? { command } : {}), timing, ...trig });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Console reads
// ---------------------------------------------------------------------------

interface CueListEntry {
  no: number;
  addr?: string;
  name?: string;
}

/** The cues of a sequence (numbers > 0, in order), or null when the sequence does not exist. */
async function readCueList(bridge: Gma3Bridge, sequence: number, t: number): Promise<CueListEntry[] | null> {
  const ref = `Sequence ${sequence}`;
  const e = await exists(bridge, ref);
  if (e.exists === "unknown") throw new Error(`could not read ${ref}: ${e.error}`);
  if (!e.exists) return null;
  const kids = (await bridge.request("children", { ref, fields: ["No", "Name"], asText: false, limit: 10000 }, t)) as { items?: Array<{ addr?: string; name?: string; class?: string; fields?: Record<string, unknown> }> };
  return (kids.items ?? [])
    .filter((c) => c.class === undefined || c.class === "Cue")
    .map((c) => ({ no: cueNo(c.fields?.No) ?? -1, addr: c.addr, name: c.name }))
    .filter((c) => c.no > 0)
    .sort((a, b) => a.no - b.no);
}

/**
 * Environment and value count of the current programmer (one short read). `values` is null unless the scan was
 * complete and reported a count: an incomplete scan says nothing about whether the programmer is empty.
 */
async function environmentOf(bridge: Gma3Bridge, t: number): Promise<{ environment: string | null; values: number | null }> {
  const r = (await bridge.request("programmer", { scope: "all", limit: 1 }, t)) as { environment?: string; total?: number; coverage?: { complete?: boolean }; fixturesTruncated?: boolean };
  const valid = r.coverage?.complete === true && r.fixturesTruncated !== true && typeof r.total === "number";
  return { environment: typeof r.environment === "string" ? r.environment : null, values: valid ? (r.total as number) : null };
}

const sameProgrammer = (a: ProgrammerSnapshot, b: ProgrammerSnapshot): boolean => a.values.size === b.values.size && [...a.values].every(([k, v]) => b.values.get(k) === v);

const failedRead = (name: string, error: string, detail?: unknown): StepResult => ({ name, kind: "read", status: "failed", op: "objects", error, ...(detail === undefined ? {} : { detail }) });

// ---------------------------------------------------------------------------
// The batch builder shared by gma3_store_cues and gma3_build_chase
// ---------------------------------------------------------------------------

type StoreMode = "create" | "merge" | "overwrite";

interface Batch {
  sequence: number;
  sequenceName?: string;
  mode: StoreMode;
  cues: CueSpec[];
  verify: boolean;
  /** SU-14: delete every existing cue first (the sequence object, and so its executor assignments, stay). */
  replace?: boolean;
}

type CueStatus = "stored" | "failed" | "unknown" | "not_attempted";

interface CueReport {
  cue: string;
  status: CueStatus;
  /** The cue's look check (before the store) and property read-back (after), combined. */
  verification: Verification;
  name?: string | null;
  looks?: Array<{ fixtures: string; presets: string[]; verification: string; detail?: string }>;
  error?: string;
}

interface BatchResult {
  steps: StepResult[];
  readBack: StepResult[];
  warnings: string[];
  cues: CueReport[];
  /** Did the build get past the read-only inspection (something was sent)? */
  sent: boolean;
  /** Preview was left cleanly (every cleanup step succeeded) and the console was then read in Normal. */
  backInNormal: boolean;
  normalProgrammer: "untouched" | "changed" | "unknown" | "not_entered";
  sequenceExisted: boolean;
  verification: Verification;
}

function storeCommand(sequence: number, cue: string, mode: StoreMode): string {
  return `Store ${cueRef(sequence, cue)}${mode === "merge" ? " /Merge" : mode === "overwrite" ? " /Overwrite" : ""} /NoConfirmation`;
}

function setStep(bridge: Gma3Bridge, name: string, ref: string, property: string, value: string | number, t: number): { name: string; run: StepFn } {
  const args = { ref, property, value: typeof value === "number" ? String(value) : value };
  return { name, run: () => requestStep(bridge, name, "set", args, (res) => ({ name, status: "succeeded", op: "set", detail: { ...args, result: res } }), t) };
}

/**
 * SU-14: check a look's phaser in the programmer: every (sub)fixture of the look that has the phaser's attributes holds
 * them with the requested steps, step timing and phaser layers, the phase spread over the selection grid (as
 * gma3_build_phaser checks it). Other attributes of the cue (a look's intensity or values) are not judged here; the
 * activation-group siblings that came with the phaser (same step count) are.
 */
/** A look's fixtures (top level, by their root FID) and which of them have every phaser attribute on themselves or a cell. */
async function phaserCoverage(bridge: Gma3Bridge, fixtures: string, attrs: string[], t: number): Promise<{ supported: Map<number, string>; unsupported: string[]; complete: boolean }> {
  const scan = (await bridge.request("programmer", { scope: "fixtures", fixtures, limit: 1, maxChannels: 50000 }, t)) as {
    scannedFixtures?: Array<{ subfixtureIndex?: number; fid?: string | null; name?: string | null; rootFid?: string | null; attributes?: string[] }>;
    coverage?: { complete?: boolean };
    fixturesTruncated?: boolean;
  };
  const supported = new Map<number, string>();
  const roots = new Map<string, boolean>();
  for (const e of scan.scannedFixtures ?? []) {
    const root = e.rootFid && e.rootFid !== "None" ? e.rootFid : e.fid && e.fid !== "None" ? e.fid : (e.name ?? "?");
    const has = attrs.every((a) => (e.attributes ?? []).includes(a));
    roots.set(root, (roots.get(root) ?? false) || has);
    if (has && typeof e.subfixtureIndex === "number") supported.set(e.subfixtureIndex, e.fid && e.fid !== "None" ? e.fid : e.name ?? String(e.subfixtureIndex));
  }
  return { supported, unsupported: [...roots].filter(([, ok]) => !ok).map(([r]) => r), complete: scan.coverage?.complete !== false && scan.fixturesTruncated !== true };
}

async function checkLookPhaser(bridge: Gma3Bridge, fixtures: string, effect: Effect, t: number): Promise<Verification> {
  const checked = `the phaser on ${fixtures} in the programmer (steps, step timing, phaser layers, phase per fixture)`;
  try {
    const scan = (await bridge.request("programmer", { scope: "fixtures", fixtures, limit: 5000, maxChannels: 50000 }, t)) as {
      rows?: Array<Record<string, unknown> & { subfixtureIndex: number; attribute?: string; stepCount?: number }>;
      scannedFixtures?: Array<{ subfixtureIndex?: number; fid?: string | null; name?: string | null; attributes?: string[] }>;
      coverage?: { complete?: boolean };
    };
    if (scan.coverage?.complete === false) return unavailable("the programmer scan of the look's fixtures was incomplete", checked);
    const attrs = effectAttributes(effect);
    // Every fixture of the look must be covered (review round 1): one without the attributes is a mismatch, not left out.
    const cov = await phaserCoverage(bridge, fixtures, attrs, t);
    const scope = cov.supported;
    if (cov.unsupported.length) return { status: "mismatched", checked, detail: `fixture(s) ${cov.unsupported.join(", ")} of ${fixtures} have no ${attrs.join(", ")}, so they hold no phaser` };
    if (scope.size === 0) return { status: "mismatched", checked, detail: `no fixture of ${fixtures} has ${attrs.join(", ")}` };
    const n = effect.steps.length;
    const rows = (scan.rows ?? []).filter((r) => scope.has(r.subfixtureIndex) && (attrs.includes(String(r.attribute)) || (r.stepCount ?? 1) === n));
    const implied = new Set(rows.map((r) => String(r.attribute)).filter((a) => !attrs.includes(a)));
    const b = verifyBuild({ effect, rows: rows as never, scope, implied, stepPresets: [] });
    return b.problems.length ? { status: "mismatched", checked, detail: b.problems.join("; ") } : { status: "matched", checked };
  } catch (err) {
    return unavailable(`the phaser could not be read back: ${err instanceof Error ? err.message : String(err)}`, checked);
  }
}

/** The expectations of a look's attribute values (intensity is Dimmer in percent), for verifyProgrammer. */
const expectationsOf = (look: LookSpec): Expectation[] => [
  ...(look.intensity !== undefined ? [{ attribute: "Dimmer", value: look.intensity, unit: "percent" as const }] : []),
  ...look.values.map((x) => ({ attribute: x.attribute, value: x.value, unit: x.unit ?? ("readout" as const) })),
];

const worst = (list: Verification[], checked: string): Verification => {
  const mism = list.filter((v) => v.status === "mismatched");
  if (mism.length) return { status: "mismatched", checked, detail: mism.map((v) => v.detail).filter(Boolean).join("; ") };
  const unav = list.filter((v) => v.status === "unavailable" || v.status === "not_requested");
  if (unav.length) return unavailable(unav.map((v) => v.detail).filter(Boolean).join("; ") || "not verified", checked);
  return { status: "matched", checked };
};

/** One object built in Preview: its looks, then the steps that store it (run only after every look applied). */
export interface PreviewItem {
  /** Step-name prefix, "cue 3: " or "preset 4.12: ". */
  prefix: string;
  looks: LookSpec[];
  /** The store and what follows it (name, timing). The first step is the store: its status is the item's. */
  store: Array<{ name: string; run: StepFn }>;
}

export type PreviewItemStatus = "stored" | "failed" | "unknown" | "not_attempted";

export interface PreviewItemReport {
  status: PreviewItemStatus;
  /** The look checks in the programmer before the store (not_requested without verify). */
  verification: Verification;
  looks?: Array<{ fixtures: string; presets: string[]; verification: string; detail?: string }>;
  error?: string;
  /** This item's steps (looks, store), in order. */
  steps: StepResult[];
  /** The store step itself succeeded (the object exists even when a later step of the item failed). */
  storeSucceeded: boolean;
}

export interface PreviewBuild {
  /** Every step: inspection, the items' steps, leaving Preview and the Normal programmer check. */
  steps: StepResult[];
  readBack: StepResult[];
  warnings: string[];
  items: PreviewItemReport[];
  /** Did the build get past the read-only inspection (something was sent)? */
  sent: boolean;
  /** Preview was left cleanly (every cleanup step succeeded) and the console was then read in Normal. */
  backInNormal: boolean;
  normalProgrammer: "untouched" | "changed" | "unknown" | "not_entered";
}

/**
 * Inspect (read-only; nothing is sent when it fails), then build every item in the Preview environment: from an empty
 * Preview programmer, its looks in order with a programmer check after each command, then its store steps. Preview is
 * left whatever happened, and the Normal programmer is checked to be untouched. Runs inside the caller's mutation lock
 * span. `inspect` puts the caller's own read-only checks first.
 *
 * An item whose look did not apply, or whose store steps did not all succeed, stops the build (the items already stored
 * stay), unless `continueAfterFailure`: then the next item starts again from a confirmed, cleared Preview programmer.
 * An item with an unknown step stops the build either way.
 */
export async function buildInPreview(ctx: ToolContext, o: { items: PreviewItem[]; verify: boolean; noun: string; inspect?: Array<{ name: string; run: StepFn }>; prepare?: () => Array<{ name: string; run: StepFn }>; continueAfterFailure?: boolean }): Promise<PreviewBuild> {
  const { bridge } = ctx;
  const t = ctx.requestTimeoutMs;
  const warnings: string[] = [];
  const readBack: StepResult[] = [];
  const reports: PreviewItemReport[] = o.items.map(() => ({ status: "not_attempted", verification: unavailable("not attempted"), steps: [], storeSucceeded: false }));
  const presets = new Map<string, { addrNative: string; label: string }>();
  let normalBefore: ProgrammerSnapshot | undefined;

  // 1. Inspection: the caller's checks, every preset, attribute and fixture expression, the Normal programmer.
  const allLooks = o.items.flatMap((c) => c.looks);
  const inspect = await runSteps([
    ...(o.inspect ?? []),
    {
      name: "check_presets",
      run: async () => {
        for (const ref of new Set(allLooks.flatMap((l) => l.presets.map((p) => p.ref)))) {
          try {
            const res = (await bridge.request("objects", { ref, fields: ["Name"] }, t)) as { total?: number; items?: Array<{ name?: string; addrNative?: string }> };
            const item = res.items?.[0];
            if (!res.total || !item) return failedRead("check_presets", `${ref} does not exist (the console would answer OK and change nothing); nothing was sent`);
            if (res.total > 1) return failedRead("check_presets", `${ref} resolves to ${res.total} objects; name one preset`);
            if (!item.addrNative) return failedRead("check_presets", `${ref} has no readable address`);
            presets.set(ref, { addrNative: item.addrNative, label: `${ref} "${item.name ?? ""}"` });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return failedRead("check_presets", /no objects? found|not found/i.test(message) ? `${ref} does not exist; nothing was sent` : message);
          }
        }
        return asRead({ name: "check_presets", status: "succeeded", op: "objects", detail: { presets: presets.size } });
      },
    },
    {
      name: "check_attributes",
      run: async () => {
        const names = new Set(allLooks.flatMap((l) => l.values.map((x) => x.attribute)));
        for (const a of names) {
          const e = await exists(bridge, `Attribute "${a}"`);
          if (e.exists === false) return failedRead("check_attributes", `attribute ${JSON.stringify(a)} is not defined in this show; nothing was sent`);
          if (e.exists === "unknown") warnings.push(`could not confirm that attribute ${JSON.stringify(a)} exists (${e.error}); the read-back of its look decides`);
        }
        return asRead({ name: "check_attributes", status: "succeeded", op: "objects", detail: { attributes: names.size } });
      },
    },
    {
      name: "check_fixtures",
      run: async () => {
        for (const sel of new Set(allLooks.map((l) => l.fixtures))) {
          const e = await exists(bridge, sel);
          if (e.exists === "unknown") return failedRead("check_fixtures", `could not read ${sel}: ${e.error}; nothing was sent`);
          if (!e.exists) return failedRead("check_fixtures", `no objects match ${JSON.stringify(sel)}; nothing was sent`);
        }
        return asRead({ name: "check_fixtures", status: "succeeded", op: "objects" });
      },
    },
    {
      // SU-14 review round 1: every fixture of a look with a phaser (or one of its cells) has the phaser's attributes;
      // otherwise the console would answer OK and leave it out. Checked before anything is sent.
      name: "check_phaser_fixtures",
      run: async () => {
        try {
          for (const look of allLooks.filter((l) => l.phaser)) {
            const attrs = effectAttributes(look.phaser as Effect);
            const cov = await phaserCoverage(bridge, look.fixtures, attrs, t);
            if (!cov.complete) return failedRead("check_phaser_fixtures", `the fixtures of ${look.fixtures} could not all be read; nothing was sent`);
            if (cov.unsupported.length) return failedRead("check_phaser_fixtures", `fixture(s) ${cov.unsupported.join(", ")} of ${look.fixtures} have no ${attrs.join(", ")} (nor any cell with them), so the phaser would leave them out; nothing was sent`, { unsupported: cov.unsupported });
          }
          return asRead({ name: "check_phaser_fixtures", status: "succeeded", op: "programmer" });
        } catch (err) {
          return asRead(stepFromError("check_phaser_fixtures", err, { op: "programmer" }));
        }
      },
    },
    {
      name: "read_normal_programmer",
      run: async () => {
        try {
          const env = await environmentOf(bridge, t);
          if (env.environment !== "Normal") return failedRead("read_normal_programmer", `the console is in the ${env.environment ?? "unknown"} environment; the ${o.noun} are built in Preview and the build must start from Normal (gma3_phaser_release leaves Preview)`);
          normalBefore = await snapshotProgrammer(bridge);
          if (!normalBefore.complete) return failedRead("read_normal_programmer", `the Normal programmer could not be read completely (${normalBefore.reason}), so it could not be checked afterwards; nothing was sent`);
          return asRead({ name: "read_normal_programmer", status: "succeeded", op: "programmer", detail: { environment: env.environment, values: normalBefore.values.size } });
        } catch (err) {
          return asRead(stepFromError("read_normal_programmer", err, { op: "programmer" }));
        }
      },
    },
  ]);
  const steps: StepResult[] = [...inspect.steps];
  if (inspect.outcome !== "succeeded") return { steps, readBack, warnings, items: reports, sent: false, backInNormal: true, normalProgrammer: "not_entered" };

  // 2. Build in Preview.
  let entered = false;
  /** Preview was confirmed empty and the build started: from here the Preview programmer holds only our values. */
  let building = false;
  let stopped = false;
  try {
    const enter = await commandStep(bridge, "preview_on", "Preview On", t);
    steps.push(enter);
    entered = enter.status === "succeeded" || enter.status === "unknown";
    if (enter.status === "succeeded") {
      const check = await runSteps([
        {
          name: "check_preview",
          run: async () => {
            try {
              const env = await environmentOf(bridge, t);
              if (env.environment !== "Preview") return failedRead("check_preview", `the console reports the ${env.environment ?? "unknown"} environment after Preview On; nothing was built`);
              // Only a complete scan proves the Preview programmer empty; otherwise its content may be someone's, and the
              // cleanup would clear it.
              if (env.values === null) return failedRead("check_preview", "the Preview programmer could not be read completely, so it is not known to be empty; nothing was built");
              if (env.values) return failedRead("check_preview", `the Preview programmer is not empty (${env.values} value(s)); nothing was built`);
              return asRead({ name: "check_preview", status: "succeeded", op: "programmer" });
            } catch (err) {
              return asRead(stepFromError("check_preview", err, { op: "programmer" }));
            }
          },
        },
      ]);
      steps.push(...check.steps);
      if (check.outcome !== "succeeded") stopped = true;
      else {
        // From here the Preview programmer is confirmed empty and holds only our values: it is released at the end.
        building = true;
        if (o.prepare) {
          // The caller's destructive preparation (replace: delete the old cues) runs only once Preview is confirmed
          // usable and empty, right before the first item is built (review round 1); a refusal leaves Preview untouched.
          const prep = await runSteps(o.prepare());
          steps.push(...prep.steps);
          if (prep.outcome !== "succeeded") stopped = true;
        }
      }
    } else stopped = true;

    for (let i = 0; i < o.items.length && !stopped; i++) {
      const item = o.items[i];
      const report = reports[i];
      const pre = item.prefix;
      const lookChecks: Verification[] = [];
      report.looks = [];
      const plan: Array<{ name: string; run: StepFn }> = [];
      if (i > 0) {
        // The programmer keeps the previous item's values after its store. ClearAll only after Preview is confirmed.
        plan.push({
          name: `${pre}confirm_preview`,
          run: async () => {
            try {
              const env = await environmentOf(bridge, t);
              if (env.environment !== "Preview") return failedRead(`${pre}confirm_preview`, `the console left the Preview environment (now ${env.environment ?? "unknown"}); nothing more was built`);
              return asRead({ name: `${pre}confirm_preview`, status: "succeeded", op: "programmer" });
            } catch (err) {
              return asRead(stepFromError(`${pre}confirm_preview`, err, { op: "programmer" }));
            }
          },
        });
        plan.push({ name: `${pre}clear`, run: () => commandStep(bridge, `${pre}clear`, "ClearAll", t) });
      }
      item.looks.forEach((look, j) => {
        const lp = `${pre}look ${j + 1} `;
        plan.push({ name: `${lp}clear_selection`, run: () => commandStep(bridge, `${lp}clear_selection`, "ClearSelection", t) });
        plan.push({ name: `${lp}select`, run: () => commandStep(bridge, `${lp}select`, look.fixtures, t) });
        const entry: NonNullable<PreviewItemReport["looks"]>[number] = { fixtures: look.fixtures, presets: look.presets.map((p) => p.ref), verification: o.verify ? "matched" : "not_requested" };
        report.looks!.push(entry);
        const parts: Verification[] = [];
        // A check right after the command it verifies: a later preset in the same look may take over an earlier one's
        // channels (and their links), which is the recall order asked for, not a failure.
        const check = (name: string, what: string, verifyIt: () => Promise<Verification>): { name: string; run: StepFn } => ({
          name,
          run: async () => {
            const v = await verifyIt();
            parts.push(v);
            lookChecks.push(v);
            const all = worst(parts, `look ${j + 1} on ${look.fixtures} in the programmer`);
            entry.verification = all.status;
            if (all.detail) entry.detail = all.detail;
            if (v.status === "mismatched") return { name, kind: "read", status: "failed", op: "programmer", error: `${what} did not apply, so ${pre.replace(/: $/, "")} was not stored: ${v.detail}` };
            return asRead({ name, status: "succeeded", op: "programmer", detail: { verification: v.status } });
          },
        });
        for (const p of look.presets) {
          plan.push({ name: `${lp}apply ${p.ref}`, run: () => commandStep(bridge, `${lp}apply ${p.ref}`, `At ${p.ref}`, t) });
          if (o.verify) plan.push(check(`${lp}check ${p.ref}`, p.ref, async () => (await verifyPresetLink(bridge, presets.get(p.ref) as { addrNative: string; label: string }, readBack)).verification));
        }
        if (look.intensity !== undefined) plan.push({ name: `${lp}intensity`, run: () => commandStep(bridge, `${lp}intensity`, `At ${formatValue(look.intensity as number)}`, t) });
        look.values.forEach((x) => plan.push({ name: `${lp}${x.attribute}`, run: () => commandStep(bridge, `${lp}${x.attribute}`, attributeCommand(x.attribute, x.value, x.unit ? ATTRIBUTE_UNITS[x.unit].keyword : undefined), t) }));
        const exp = expectationsOf(look);
        if (o.verify && exp.length) plan.push(check(`${lp}check values`, "the look's values", async () => (await verifyProgrammer(bridge, exp, readBack, warnings)).verification));
        if (look.phaser) {
          const effect = look.phaser;
          const commands = effectCommands(effect);
          plan.push({
            name: `${lp}phaser`,
            run: async () => {
              for (const c of commands) {
                const st = await commandStep(bridge, `${lp}phaser`, c, t);
                if (st.status !== "succeeded") return { ...st, error: `${c}: ${st.error}` };
              }
              return { name: `${lp}phaser`, status: "succeeded", op: "cmd", detail: { commands: commands.length } };
            },
          });
          if (o.verify) plan.push(check(`${lp}check phaser`, "the look's phaser", () => checkLookPhaser(bridge, look.fixtures, effect, t)));
        }
      });
      plan.push(...item.store);

      const run = await runSteps(plan);
      steps.push(...run.steps);
      report.steps = run.steps;
      const store = run.steps.find((s) => s.name === item.store[0]?.name);
      const bad = run.steps.find((s) => s.status !== "succeeded" && s.status !== "skipped");
      report.storeSucceeded = store?.status === "succeeded";
      report.status = store?.status === "succeeded" ? (bad ? "failed" : "stored") : store?.status === "unknown" ? "unknown" : "failed";
      if (bad) report.error = `${bad.name}: ${bad.error ?? bad.status}`;
      report.verification = o.verify ? worst(lookChecks, "looks") : notRequested();
      if (bad && (!o.continueAfterFailure || bad.status === "unknown")) stopped = true;
    }
  } finally {
    // Leave Preview whatever happened, once it may have been entered.
    if (entered) {
      let env: string | null | undefined;
      try {
        env = (await environmentOf(bridge, t)).environment;
      } catch {
        env = undefined;
      }
      steps.push(asRead({ name: "confirm_preview_end", status: env === undefined ? "unknown" : "succeeded", op: "programmer", detail: { environment: env ?? null }, ...(env === undefined ? { error: "the environment could not be read, so nothing was cleared; run gma3_phaser_release" } : {}) }));
      if (env === "Preview") {
        // A Preview programmer that was not empty before the build is someone else's: it is left as it was.
        if (building) steps.push(await commandStep(bridge, "release_preview_programmer", "ClearAll", t));
        steps.push(await commandStep(bridge, "preview_off", "Preview Off", t));
      } else if (env === undefined) warnings.push("the console's environment after the build could not be read; nothing was cleared. Run gma3_phaser_release, which clears only after confirming Preview");
    }
  }

  let normalProgrammer: PreviewBuild["normalProgrammer"] = entered ? "unknown" : "not_entered";
  const cleanupSteps = steps.filter((x) => ["confirm_preview_end", "release_preview_programmer", "preview_off"].includes(x.name));
  let backInNormal = !entered;
  if (entered && normalBefore) {
    try {
      const env = await environmentOf(bridge, t);
      backInNormal = env.environment === "Normal" && cleanupSteps.every((x) => x.status === "succeeded");
      const after = await snapshotProgrammer(bridge);
      if (env.environment === "Normal" && after.complete) normalProgrammer = sameProgrammer(normalBefore, after) ? "untouched" : "changed";
      steps.push(asRead({ name: "check_normal_programmer", status: normalProgrammer === "untouched" ? "succeeded" : "failed", op: "programmer", ...(normalProgrammer === "untouched" ? {} : { error: env.environment !== "Normal" ? `the console is in the ${env.environment ?? "unknown"} environment; run gma3_phaser_release` : !after.complete ? "the Normal programmer could not be read completely" : `the Normal programmer changed while the ${o.noun} were built (another operator, or a command that reached Normal)` }) }));
    } catch (err) {
      steps.push(asRead(stepFromError("check_normal_programmer", err, { op: "programmer" })));
    }
  }
  return { steps, readBack, warnings, items: reports, sent: true, backInNormal, normalProgrammer };
}

/**
 * Inspect (read-only; nothing is sent when it fails), build every cue in Preview, leave Preview, check the Normal
 * programmer, then read every stored cue back. Runs inside the caller's mutation lock span.
 */
export async function buildCueBatch(ctx: ToolContext, b: Batch): Promise<BatchResult> {
  const { bridge } = ctx;
  const t = ctx.requestTimeoutMs;
  let existing: CueListEntry[] | null = null;
  const readSequence = {
    name: "read_sequence",
    run: async (): Promise<StepResult> => {
      try {
        existing = await readCueList(bridge, b.sequence, t);
      } catch (err) {
        return asRead(stepFromError("read_sequence", err, { op: "children" }));
      }
      const list = existing as CueListEntry[] | null;
      const have = new Set((list ?? []).map((c) => c.no));
      const clash = b.replace ? [] : b.cues.filter((c) => have.has(Number(c.cue))).map((c) => c.cue);
      if (b.mode === "create" && clash.length) return failedRead("read_sequence", `Sequence ${b.sequence} already has cue(s) ${clash.join(", ")}; nothing was sent. Use mode merge or overwrite, or other cue numbers`, { existing: clash });
      return asRead({ name: "read_sequence", status: "succeeded", op: "children", detail: { exists: list !== null, cues: list?.length ?? 0, ...(clash.length ? { replaced: clash } : {}) } });
    },
  };
  const items: PreviewItem[] = b.cues.map((c) => {
    const pre = `cue ${c.cue}: `;
    const part0 = cueRef(b.sequence, c.cue, 0);
    const cueObj = cueRef(b.sequence, c.cue);
    const store: Array<{ name: string; run: StepFn }> = [{ name: `${pre}store`, run: () => commandStep(bridge, `${pre}store`, storeCommand(b.sequence, c.cue, b.mode), t) }];
    if (c.name !== undefined) store.push(setStep(bridge, `${pre}name`, part0, "Name", c.name, t));
    for (const [k, val] of Object.entries(c.timing) as Array<[keyof CueSpec["timing"], number]>) store.push(setStep(bridge, `${pre}${k}`, part0, TIMING_PROPS[k], val, t));
    if (c.trigger) store.push(setStep(bridge, `${pre}trigger`, cueObj, "TrigType", TRIGGERS[c.trigger], t));
    if (c.time !== undefined) store.push(setStep(bridge, `${pre}trigger_time`, cueObj, "TrigTime", c.time, t));
    if (c.command !== undefined) store.push(setStep(bridge, `${pre}command`, part0, "Command", c.command, t));
    return { prefix: pre, looks: c.looks, store };
  });
  // replace: every existing cue is deleted once everything was checked (Delete ... Cue 1 Thru keeps the sequence object,
  // its settings and its executor assignments: live 2026-10-15), and the sequence must read empty before the build.
  const deleteSteps = (): Array<{ name: string; run: StepFn }> => {
    const list = (existing as CueListEntry[] | null) ?? [];
    if (!list.length) return [];
    // One step per request, so a refusal after earlier deletions keeps them in the result (review round 1).
    const out: Array<{ name: string; run: StepFn }> = list
      .filter((c) => c.no < 1)
      .map((c) => {
        const name = `delete_cue_${fmtNo(c.no)}`;
        return { name, run: () => commandStep(bridge, name, `Delete ${cueRef(b.sequence, fmtNo(c.no))} /NoConfirmation`, t) };
      });
    if (list.some((c) => c.no >= 1)) out.push({ name: "delete_cues_from_1", run: () => commandStep(bridge, "delete_cues_from_1", `Delete Sequence ${b.sequence} Cue 1 Thru /NoConfirmation`, t) });
    out.push({
      name: "check_cues_deleted",
      run: async () => {
        try {
          const after = await readCueList(bridge, b.sequence, t);
          if (after === null) return failedRead("check_cues_deleted", `Sequence ${b.sequence} is gone after deleting its cues; nothing was built`);
          if (after.length) return failedRead("check_cues_deleted", `Sequence ${b.sequence} still has cue(s) ${after.map((c) => fmtNo(c.no)).join(", ")} after the delete; nothing was built`, { remaining: after.map((c) => fmtNo(c.no)) });
          return asRead({ name: "check_cues_deleted", status: "succeeded", op: "children", detail: { deleted: list.map((c) => fmtNo(c.no)) } });
        } catch (err) {
          return asRead(stepFromError("check_cues_deleted", err, { op: "children" }));
        }
      },
    });
    return out;
  };
  // replace: every existing cue is deleted once everything was checked and Preview is confirmed usable (Delete ... Cue 1
  // Thru keeps the sequence object, its settings and its executor assignments: live 2026-10-15).
  const built = await buildInPreview(ctx, { items, verify: b.verify, noun: "cues", inspect: [readSequence], ...(b.replace ? { prepare: deleteSteps } : {}) });
  const { steps, readBack, warnings, normalProgrammer } = built;
  const reports: CueReport[] = b.cues.map((c, i) => {
    const r = built.items[i];
    return { cue: c.cue, status: r.status, verification: r.verification, ...(r.looks ? { looks: r.looks } : {}), ...(r.error ? { error: r.error } : {}) };
  });
  const sequenceExisted = existing !== null;
  if (!built.sent) return { steps, readBack, warnings, cues: reports, sent: false, backInNormal: true, normalProgrammer: "not_entered", sequenceExisted, verification: unavailable("nothing was sent") };

  // 3. The sequence name, once a cue was stored (the store creates the sequence).
  if (b.sequenceName !== undefined && reports.some((r) => r.status === "stored" || r.status === "unknown")) {
    const named = await runSteps([setStep(bridge, "sequence_name", `Sequence ${b.sequence}`, "Name", b.sequenceName, t)]);
    steps.push(...named.steps);
  }

  // 4. Read back every cue that was (or may have been) stored.
  if (b.verify) {
    for (let i = 0; i < b.cues.length; i++) {
      const c = b.cues[i];
      const r = reports[i];
      if (r.status === "not_attempted" || (r.status === "failed" && !built.items[i].storeSucceeded)) continue;
      const expected: Record<string, unknown> = { Name: c.name, ...(c.trigger ? { TrigType: TRIGGERS[c.trigger] } : {}), ...(c.time !== undefined ? { TrigTime: c.time } : {}) };
      const timingExpected: Record<string, unknown> = {
        ...Object.fromEntries(Object.entries(c.timing).map(([k, val]) => [TIMING_PROPS[k as keyof CueSpec["timing"]], val])),
        ...(c.command !== undefined ? { Command: c.command } : {}),
      };
      const checked = `cue ${c.cue} exists${c.name !== undefined ? ", its name" : ""}${Object.keys(c.timing).length ? ", its timing" : ""}${c.trigger ? ", its trigger" : ""}${c.command !== undefined ? ", its command" : ""}`;
      let props: Verification;
      try {
        const cueRes = (await bridge.request("objects", { ref: cueRef(b.sequence, c.cue), fields: ["Name", "TrigType", "TrigTime"], limit: 1 }, t)) as { items?: Array<{ fields?: Record<string, unknown> }> };
        const cf = cueRes.items?.[0]?.fields;
        if (!cf) props = { status: "mismatched", checked, detail: `cue ${c.cue} does not exist after the store` };
        else {
          r.name = typeof cf.Name === "string" ? cf.Name : null;
          let actual: Record<string, unknown> = { ...cf };
          if (Object.keys(timingExpected).length) {
            const pr = (await bridge.request("objects", { ref: cueRef(b.sequence, c.cue, 0), fields: Object.keys(timingExpected), limit: 1 }, t)) as { items?: Array<{ fields?: Record<string, unknown> }> };
            actual = { ...actual, ...(pr.items?.[0]?.fields ?? {}) };
          }
          props = compareFields(checked, { ...expected, ...timingExpected }, actual, { normalize: TIME_NORMALIZERS });
        }
        readBack.push(asRead({ name: `cue ${c.cue}: read_back`, status: "succeeded", op: "objects", detail: { verification: props.status } }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        readBack.push(asRead({ name: `cue ${c.cue}: read_back`, status: "failed", op: "objects", error: message }));
        props = unavailable(`read-back failed: ${message}`, checked);
      }
      r.verification = worst([r.verification, props], `cue ${c.cue}: looks in the programmer before the store; ${checked}`);
    }
  }

  const attempted = reports.filter((r) => r.status !== "not_attempted");
  const overall = !b.verify
    ? notRequested()
    : attempted.length === 0
      ? unavailable("no cue was stored")
      : worst(
          [...attempted.map((r) => ({ ...r.verification, detail: r.verification.detail ? `cue ${r.cue}: ${r.verification.detail}` : undefined })), ...(normalProgrammer === "changed" ? [{ status: "mismatched" as const, detail: "the Normal programmer changed during the build" }] : [])],
          `${attempted.length} cue(s): each look in the Preview programmer before its store, then the cue's existence, name, timing and trigger`,
        );
  return { steps, readBack, warnings, cues: reports, sent: true, backInNormal: built.backInNormal, normalProgrammer, sequenceExisted, verification: overall };
}

// ---------------------------------------------------------------------------
// Chase observation
// ---------------------------------------------------------------------------

export interface CycleObservation {
  mode: "full" | "tail";
  startCue: number;
  expected: number[];
  observed: Array<{ ms: number; cue: number | string | null }>;
  intervalsMs: number[];
  predictedStepMs: number | null;
  toleranceMs: number | null;
  problems: string[];
  notes: string[];
}

/**
 * The cue order a chase of `cues` must show, starting at `start` (an index): start..last, then the wrap to the
 * first cue and the one after it (which proves the first cue's own trigger fires). `transitions` caps the length.
 */
export function expectedOrder(cues: number[], start: number, transitions: number): number[] {
  const out: number[] = [cues[start]];
  for (let i = 1; i <= transitions; i++) out.push(cues[(start + i) % cues.length]);
  return out;
}

/**
 * Plan an observation within `budgetMs`: the full cycle (first cue to first cue again) when it fits, otherwise its
 * tail (a start cue late enough that the wrap and the step after it fit). Null when not even the wrap fits.
 */
export function planObservation(count: number, stepMs: number, budgetMs: number): { mode: "full" | "tail"; start: number; transitions: number } | null {
  const fit = Math.floor((budgetMs - stepMs * 0.5) / stepMs); // transitions that fit, with half a step of margin
  if (fit >= count + 1) return { mode: "full", start: 0, transitions: count + 1 };
  if (fit >= count) return { mode: "full", start: 0, transitions: count };
  if (fit < 2) return null;
  // Tail: from cue index s to the last cue, the wrap, and the step after it: (count - 1 - s) + 2 transitions.
  const s = count + 1 - fit;
  return { mode: "tail", start: s, transitions: fit };
}

/** Judge the observed cue changes against the expected order and step interval. */
export function judgeCycle(expected: number[], observed: Array<{ ms: number; cue: number | string | null }>, predictedStepMs: number | null, toleranceMs: number | null): string[] {
  const problems: string[] = [];
  const seen = observed.map((o) => o.cue);
  for (let i = 0; i < expected.length; i++) {
    if (i >= seen.length) {
      problems.push(`expected cue ${expected[i]} next (after ${seen.length ? `cue ${seen[seen.length - 1]}` : "the start"}), but no further cue change was seen in time`);
      break;
    }
    if (seen[i] !== expected[i]) {
      problems.push(`expected cue ${expected[i]} as change ${i + 1}, saw ${seen[i] === null ? "no current cue" : `cue ${seen[i]}`} (order seen: ${seen.join(" -> ")})`);
      break;
    }
  }
  if (predictedStepMs !== null && toleranceMs !== null) {
    for (let i = 1; i < Math.min(observed.length, expected.length); i++) {
      const d = observed[i].ms - observed[i - 1].ms;
      if (Math.abs(d - predictedStepMs) > toleranceMs) problems.push(`the step to cue ${observed[i].cue} took ${d} ms, expected ${Math.round(predictedStepMs)} ms (± ${Math.round(toleranceMs)} ms)`);
    }
  }
  return problems;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Start the chase at its start cue with Goto, sample CurrentCue until the expected changes were seen or time ran out. */
async function observeChase(
  ctx: ToolContext,
  sequence: number,
  plan: { mode: "full" | "tail"; start: number; transitions: number },
  cues: CueListEntry[],
  predictedStepMs: number | null,
  nominalStepMs: number,
  steps: StepResult[],
): Promise<CycleObservation> {
  const { bridge } = ctx;
  const t = ctx.requestTimeoutMs;
  const numbers = cues.map((c) => c.no);
  const expected = expectedOrder(numbers, plan.start, plan.transitions);
  const notes: string[] = [];
  const byAddr = new Map(cues.filter((c) => c.addr).map((c) => [c.addr as string, c.no]));
  const step = predictedStepMs ?? nominalStepMs;
  const toleranceMs = predictedStepMs === null ? null : Math.max(150, predictedStepMs * 0.1) + SAMPLE_MS * 2;
  const deadline = plan.transitions * step + step * 0.5 + 1000;
  const go = await commandStep(bridge, "start_chase", `Goto ${cueRef(sequence, String(numbers[plan.start]))}`, t);
  steps.push(go);
  const observed: Array<{ ms: number; cue: number | string | null }> = [];
  if (go.status !== "succeeded") return { mode: plan.mode, startCue: numbers[plan.start], expected, observed, intervalsMs: [], predictedStepMs, toleranceMs, problems: ["the chase could not be started"], notes };
  const t0 = Date.now();
  let last: string | undefined;
  let unread = 0;
  // The first sample may still name the cue from before the Goto (CurrentCue keeps the last cue after Off): changes
  // are counted only from the start cue on.
  let started = false;
  while (Date.now() - t0 < deadline && observed.length < expected.length) {
    const r = (await bridge.request("objects", { ref: `Sequence ${sequence}`, fields: ["CurrentCue"], asText: false, limit: 1 }, t).catch(() => null)) as { items?: Array<{ fields?: Record<string, unknown> }> } | null;
    const item = r?.items?.[0];
    if (!item) unread++;
    else {
      const cur = item.fields?.CurrentCue as { addr?: string; name?: string } | null | undefined;
      const no = cur && typeof cur === "object" ? (byAddr.get(cur.addr ?? "") ?? cur.name ?? null) : null;
      const key = String(no);
      if (key !== last) {
        if (!started && no === numbers[plan.start]) started = true;
        if (started) observed.push({ ms: Date.now() - t0, cue: no });
        last = key;
      }
    }
    await sleep(SAMPLE_MS);
  }
  if (unread) notes.push(`${unread} sample(s) could not be read`);
  // The first change is the Goto itself: its time is the start, not a step.
  const intervalsMs = observed.slice(1).map((o, i) => o.ms - observed[i].ms);
  const problems = judgeCycle(expected, observed, predictedStepMs, toleranceMs);
  steps.push(asRead({ name: "observe_cycle", status: "succeeded", op: "objects", detail: { samples: observed.length, unread } }));
  return { mode: plan.mode, startCue: numbers[plan.start], expected, observed, intervalsMs, predictedStepMs, toleranceMs, problems, notes };
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

const EXCLUSIVE_REASON =
  "exclusive must be true: the cues are built in the console's Preview environment (its own programmer and selection; the operator's Normal programmer and the output are not touched), and nobody else may use the console while the build runs";

function batchResult(op: string, target: Record<string, unknown>, r: BatchResult, extra: Record<string, unknown>, verification?: Verification): OperationResult {
  const result = buildResult({
    operation: op,
    target,
    steps: r.steps,
    verification: verification ?? r.verification,
    warnings: r.warnings,
    extra: {
      cues: r.cues,
      stored: r.cues.filter((c) => c.status === "stored").length,
      normalProgrammer: r.normalProgrammer,
      notVerified: NOT_READABLE,
      ...extra,
    },
  });
  result.steps.push(...r.readBack);
  return result;
}

// ---------------------------------------------------------------------------
// SU-14: preset ranges, replace, sequence settings and overrides
// ---------------------------------------------------------------------------

interface PresetRange {
  pool: number;
  from: number;
  to: number;
}

/** `{pool, from, to}`: a range of presets in one pool (at most MAX_CUES numbers). */
export function validatePresetRange(v: Validator, raw: unknown, path: string): PresetRange | undefined {
  const r = (raw ?? {}) as Record<string, unknown>;
  const pool = v.check(() => finiteNumber(`${path}.pool`, r.pool, { integer: true, min: 1, max: 9999 }));
  const from = v.check(() => finiteNumber(`${path}.from`, r.from, { integer: true, min: 1, max: 99999 }));
  const to = v.check(() => finiteNumber(`${path}.to`, r.to, { integer: true, min: 1, max: 99999 }));
  if (from !== undefined && to !== undefined && to < from) v.fail(`${path}: to must not be below from`);
  if (from !== undefined && to !== undefined && to - from + 1 > MAX_CUES) v.fail(`${path}: at most ${MAX_CUES} presets`);
  return pool !== undefined && from !== undefined && to !== undefined ? { pool, from, to } : undefined;
}

/**
 * The presets of a range that exist, in number order, with their names (one objects read). The console takes the
 * range as `Preset 21.11 Thru 14` (live 2026-10-15): `Thru 21.14` resolves nothing and `Thru Preset 21.14` runs on
 * past the end, so the numbers are also filtered here.
 */
async function readPresetRange(bridge: Gma3Bridge, r: PresetRange, t: number): Promise<Array<{ no: number; name: string }>> {
  const res = (await bridge.request("objects", { ref: `Preset ${r.pool}.${r.from} Thru ${r.to}`, fields: ["No", "Name"], limit: MAX_CUES + 1 }, t).catch((err: unknown) => {
    if (/no objects? found|not found/i.test(err instanceof Error ? err.message : String(err))) return { items: [] };
    throw err;
  })) as { items?: Array<{ name?: string; index?: number; fields?: Record<string, unknown> }> };
  const out: Array<{ no: number; name: string }> = [];
  for (const it of res.items ?? []) {
    const no = Number(String(it.fields?.No ?? it.index ?? "").match(/^\d+/)?.[0]);
    if (Number.isInteger(no) && no >= r.from && no <= r.to) out.push({ no, name: String(it.fields?.Name ?? it.name ?? "") });
  }
  return out.sort((a, b) => a.no - b.no);
}

/** Cues for a preset range: one per existing preset, numbered from `first`, named after the preset. */
function presetCues(found: Array<{ no: number; name: string }>, r: PresetRange, fixtures: string, first: number, extra: (k: number) => Partial<CueSpec>): CueSpec[] {
  return found.map((p, k) => ({
    cue: String(first + k),
    ...(p.name ? { name: p.name } : {}),
    looks: [{ fixtures, presets: [{ pool: r.pool, preset: p.no, ref: presetRef(r.pool, p.no) }], values: [] }],
    timing: {},
    ...extra(k),
  }));
}

/** The executors a sequence is assigned to (by address); null when it cannot be read. */
async function assignmentsOf(bridge: Gma3Bridge, sequence: number, t: number): Promise<string[] | null> {
  try {
    const o = (await bridge.request("objects", { ref: `Sequence ${sequence}`, fields: ["Name"], limit: 1 }, t)) as { items?: Array<{ addr?: string }> };
    const addr = o.items?.[0]?.addr;
    if (!addr) return [];
    const refs = await findReferences(bridge, addr, t);
    return refs.complete ? refs.executors.map((e) => e.ref).sort() : null;
  } catch {
    return null;
  }
}

const PRIORITY_RANK: Record<string, number> = { lowest: 0, low: 1, ltp: 2, high: 3, highest: 4, htp: 5, swap: 6, super: 7 };
const rankOf = (p: unknown) => PRIORITY_RANK[String(p ?? "").trim().toLowerCase()] ?? 2;

/**
 * The running sequences an override would switch off: playing (HasActivePlayback), lower priority than `priority`,
 * Off When Overridden on, not the sequence itself. They switch off only where the override plays on the same fixtures;
 * cue contents cannot be read on 2.5.1, so every candidate is listed.
 */
async function overrideCandidates(bridge: Gma3Bridge, sequence: number, priority: string, t: number): Promise<{ sequences: Array<{ sequence: number; name: string; priority: string }>; complete: boolean }> {
  const res = (await bridge.request("objects", { ref: "Sequence Thru", fields: ["No", "Priority", "OffWhenOverridden"], limit: 500 }, t)) as { total?: number; items?: Array<{ name?: string; fields?: Record<string, unknown> }> };
  const out: Array<{ sequence: number; name: string; priority: string }> = [];
  let complete = (res.total ?? 0) <= (res.items?.length ?? 0);
  for (const it of res.items ?? []) {
    const no = Number(String(it.fields?.No ?? "").match(/^\d+/)?.[0]);
    if (!Number.isInteger(no) || no === sequence) continue;
    if (rankOf(it.fields?.Priority) >= rankOf(priority) || String(it.fields?.OffWhenOverridden ?? "").toLowerCase() !== "yes") continue;
    try {
      const o = (await bridge.request("object", { ref: `Sequence ${no}`, properties: false }, t)) as { hasActivePlayback?: unknown };
      if (o?.hasActivePlayback === true) out.push({ sequence: no, name: String(it.name ?? ""), priority: String(it.fields?.Priority ?? "") });
    } catch {
      complete = false;
    }
  }
  return { sequences: out, complete };
}

/**
 * After a build: the sequence's settings (gma3_configure_sequence, in the same lock span) and, for a priority above
 * LTP, the running sequences it would switch off, with Off When Overridden turned off on them when `protect`.
 */
async function sequenceExtras(ctx: ToolContext, sequence: number, settings: Record<string, unknown> | undefined, protect: boolean, steps: StepResult[], warnings: string[]): Promise<{ extra: Record<string, unknown>; verifications: Verification[]; ready: boolean }> {
  const held: ToolContext = { ...ctx, mutations: new HeldLock() };
  const extra: Record<string, unknown> = {};
  const verifications: Verification[] = [];
  if (!settings) return { extra, verifications, ready: true };
  /** Not ready: the requested protection did not fully succeed, so the override is neither configured nor played. */
  const notReady = (reason: string) => {
    steps.push({ name: "sequence_settings", status: "skipped", error: `not attempted: ${reason}` });
    verifications.push({ status: "mismatched", checked: "the running sequences' protection", detail: reason });
    extra.sequenceSettings = { outcome: "not_attempted", reason };
    return { extra, verifications, ready: false };
  };
  const priority = typeof settings.priority === "string" ? settings.priority : undefined;
  if (priority && rankOf(priority) > PRIORITY_RANK.ltp) {
    try {
      const c = await overrideCandidates(ctx.bridge, sequence, priority, ctx.requestTimeoutMs);
      steps.push(asRead({ name: "read_running_sequences", status: "succeeded", op: "objects", detail: { candidates: c.sequences.length, complete: c.complete } }));
      const protectedOnes: number[] = [];
      extra.override = { priority, wouldSwitchOff: c.sequences, complete: c.complete, protected: protectedOnes };
      if (protect) {
        // Protection must be complete and confirmed before the override is configured or played (review round 1).
        if (!c.complete) return notReady("the running sequences could not all be read, so their protection is not complete");
        for (const r of c.sequences) {
          const res = await configureSequence(held, { sequence: r.sequence, off_when_overridden: false } as ConfigureSequenceArgs);
          const ok = res.outcome === "succeeded" && res.verification.status === "matched";
          steps.push({ name: `protect_sequence_${r.sequence}`, status: ok ? "succeeded" : res.outcome === "unknown" || res.steps.some((st) => st.status === "unknown" && st.kind !== "read") ? "unknown" : "failed", op: "gma3_configure_sequence", ...(ok ? {} : { error: res.summary }) });
          verifications.push(res.verification);
          if (!ok) return notReady(`Off When Overridden could not be confirmed off on Sequence ${r.sequence} (${res.outcome}, read-back ${res.verification.status})`);
          protectedOnes.push(r.sequence);
        }
      } else if (c.sequences.length) {
        warnings.push(`Sequence ${sequence} plays at priority ${priority}: where it plays on the same fixtures it switches off ${c.sequences.map((r) => `Sequence ${r.sequence} "${r.name}"`).join(", ")} (Off When Overridden is on); pass protect_running: true to turn Off When Overridden off on them`);
      }
      extra.override = { priority, wouldSwitchOff: c.sequences, complete: c.complete, protected: protectedOnes, note: "a running sequence of lower priority with Off When Overridden on is switched off where the override plays on the same fixtures; cue contents cannot be read on 2.5.1, so every playing candidate is listed" };
    } catch (err) {
      steps.push(asRead(stepFromError("read_running_sequences", err, { op: "objects" })));
      if (protect) return notReady("the running sequences could not be read, so they could not be protected");
      warnings.push("the running sequences could not be read, so the override's effect on them is not known");
    }
  }
  const res = await configureSequence(held, { sequence, ...settings } as ConfigureSequenceArgs);
  steps.push({ name: "sequence_settings", status: res.outcome === "succeeded" ? "succeeded" : res.outcome === "unknown" ? "unknown" : "failed", op: "gma3_configure_sequence", detail: { verification: res.verification.status }, ...(res.outcome === "succeeded" ? {} : { error: res.summary }) });
  verifications.push(res.verification);
  if (res.warnings?.length) warnings.push(...res.warnings);
  extra.sequenceSettings = { outcome: res.outcome, verification: res.verification.status, ...(res.intended ? { intended: res.intended } : {}) };
  return { extra, verifications, ready: res.outcome === "succeeded" && res.verification.status !== "mismatched" };
}

/** A mutation step without a reply (its effect on the console is not known). */
const uncertainStep = (steps: StepResult[]) => steps.find((st) => st.status === "unknown" && st.kind !== "read");

/**
 * Before a destructive replace: the settings would be accepted by gma3_configure_sequence (its preview: sequence,
 * locks, master names), read-only. A new sequence has nothing to check yet.
 */
async function settingsPreflight(ctx: ToolContext, sequence: number, settings: Record<string, unknown>): Promise<StepResult> {
  const held: ToolContext = { ...ctx, mutations: new HeldLock() };
  const res = await configureSequence(held, { sequence, ...settings, preview: true } as ConfigureSequenceArgs);
  return res.outcome === "succeeded" ? asRead({ name: "check_sequence_settings", status: "succeeded", op: "gma3_configure_sequence" }) : failedRead("check_sequence_settings", `the sequence settings would not apply (${res.summary}); nothing was sent`);
}

/** Validate sequence_settings: the gma3_configure_sequence settings (lock and preview are not taken here). */
function validateSequenceSettings(v: Validator, raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    v.fail("sequence_settings must be an object of gma3_configure_sequence settings");
    return undefined;
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (!entries.length) v.fail("sequence_settings is empty: give at least one setting, or leave it out");
  const bad = entries.map(([k]) => k).filter((k) => !(k in SEQUENCE_SETTINGS));
  if (bad.length) v.fail(`sequence_settings: ${bad.join(", ")} ${bad.length === 1 ? "is" : "are"} not a sequence setting (${Object.keys(SEQUENCE_SETTINGS).join(", ")})`);
  // Every value is checked before anything is sent (review round 1): a bad value must not surface after a rebuild.
  for (const [k, value] of entries) {
    if (!(k in SEQUENCE_SETTINGS)) continue;
    if (value === undefined || value === null) v.fail(`sequence_settings.${k} has no value`);
    else v.check(() => settingValue(`sequence_settings.${k}`, SEQUENCE_SETTINGS[k], value));
  }
  return raw as Record<string, unknown>;
}

export async function storeCues(ctx: ToolContext, raw: Record<string, unknown>): Promise<OperationResult> {
  const op = "store_cues";
  const { bridge } = ctx;
  const t = ctx.requestTimeoutMs;
  const v = new Validator();
  const sequence = v.check(() => objectNumber("sequence", raw.sequence));
  const replace = raw.replace === true;
  const mode = replace && raw.mode === undefined ? "create" : v.check(() => oneOf("mode", raw.mode, ["create", "merge", "overwrite"] as const));
  if (replace && mode !== "create") v.fail("replace rebuilds the sequence from its cues: mode is create (or leave it out)");
  const sequenceName = v.check(() => objectName("sequence_name", raw.sequence_name, { optional: true }));
  const defaultFixtures = raw.fixtures === undefined ? undefined : v.check(() => fixtureSelection("fixtures", raw.fixtures));
  let cues: CueSpec[] = [];
  let range: PresetRange | undefined;
  let firstCue = 1;
  if ((raw.cues === undefined) === (raw.presets === undefined)) v.fail("give exactly one of cues (a list) or presets ({pool, from, to}: one cue per preset)");
  else if (raw.presets !== undefined) {
    range = validatePresetRange(v, raw.presets, "presets");
    firstCue = v.check(() => finiteNumber("first_cue", raw.first_cue, { integer: true, min: 1, max: 9999, optional: true })) ?? 1;
    if (!defaultFixtures) v.fail("presets needs fixtures (the target every preset is recalled on)");
  } else cues = validateCues(v, raw.cues, defaultFixtures);
  const timing = range ? validateTiming(v, raw, "") : {};
  const trig = range ? validateTrigger(v, raw.trigger, raw.time, "") : {};
  const settings = validateSequenceSettings(v, raw.sequence_settings);
  const protect = raw.protect_running === true;
  if (protect && !settings?.priority) v.fail("protect_running applies to an override: give sequence_settings.priority above ltp");
  if (raw.exclusive !== true) v.fail(EXCLUSIVE_REASON);
  const target: Record<string, unknown> = { sequence: raw.sequence, ...(range ? { presets: `${range.pool}.${range.from} Thru ${range.pool}.${range.to}` } : { cues: cues.map((c) => c.cue) }), mode: mode ?? raw.mode, ...(replace ? { replace } : {}) };
  if (!v.ok || sequence === undefined || !mode) return validationFailure(op, target, v.errors);
  return ctx.mutations.run(async () => {
    const pre: StepResult[] = [];
    const warnings: string[] = [];
    if (range) {
      try {
        const found = await readPresetRange(bridge, range, t);
        pre.push(asRead({ name: "read_preset_range", status: found.length ? "succeeded" : "failed", op: "objects", detail: { found: found.map((p) => p.no) }, ...(found.length ? {} : { error: `no preset exists in ${range.pool}.${range.from} Thru ${range.pool}.${range.to}; nothing was sent` }) }));
        if (!found.length) return buildResult({ operation: op, target, steps: pre, verification: unavailable("nothing was sent") });
        const missing = range.to - range.from + 1 - found.length;
        if (missing) warnings.push(`${missing} number(s) in the range hold no preset and get no cue`);
        cues = presetCues(found, range, defaultFixtures as string, firstCue, () => ({ timing, ...trig }));
      } catch (err) {
        pre.push(asRead(stepFromError("read_preset_range", err, { op: "objects" })));
        return buildResult({ operation: op, target, steps: pre, verification: unavailable("nothing was sent") });
      }
    }
    if (replace && settings && (await readCueList(bridge, sequence, t).catch(() => null)) !== null) {
      const chk = await settingsPreflight(ctx, sequence, settings);
      pre.push(chk);
      if (chk.status !== "succeeded") return buildResult({ operation: op, target, steps: pre, verification: unavailable("nothing was sent") });
    }
    const before = replace ? await assignmentsOf(bridge, sequence, t) : null;
    const r = await buildCueBatch(ctx, { sequence, sequenceName, mode, cues, verify: raw.verify !== false, replace });
    r.steps.unshift(...pre);
    r.warnings.push(...warnings);
    const extra: Record<string, unknown> = { sequenceExisted: r.sequenceExisted };
    let verification = r.verification;
    if (replace && r.sent) {
      const after = await assignmentsOf(bridge, sequence, t);
      const kept = before !== null && after !== null && before.every((x) => after.includes(x));
      extra.assignments = { before, after, kept: before === null || after === null ? null : kept };
      if (before !== null && after !== null && !kept) verification = worst([verification, { status: "mismatched", detail: `the executor assignments changed: ${before.join(", ") || "none"} before, ${after.join(", ") || "none"} after` }], "cues and executor assignments");
    }
    // The settings only after a complete build with no uncertain step (review round 1): later mutations are not sent
    // after a step whose effect is unknown, or onto a sequence whose build failed.
    const uncertain = uncertainStep(r.steps);
    if (settings && r.cues.every((c) => c.status === "stored") && !uncertain) {
      const s2 = await sequenceExtras(ctx, sequence, settings, protect, r.steps, r.warnings);
      Object.assign(extra, s2.extra);
      verification = worst([verification, ...s2.verifications], `${verification.checked ?? "the cues"} and the sequence settings`);
    } else if (settings) {
      const reason = uncertain ? `step '${uncertain.name}' got no reply, so the console's state is not known` : "not every cue was stored";
      r.steps.push({ name: "sequence_settings", status: "skipped", error: `not attempted: ${reason}` });
      extra.sequenceSettings = { outcome: "not_attempted", reason };
    }
    return batchResult(op, { sequence, cues: cues.map((c) => c.cue), mode, ...(replace ? { replace } : {}) }, r, extra, verification);
  });
}

/** Resolve which existing cues an edit applies to: a list, a from/to range, or every cue. */
function selectCues(list: CueListEntry[], pick: { cues?: string[]; from?: string; to?: string; all?: boolean }): { cues: CueListEntry[] } | { error: string } {
  if (pick.cues) {
    const missing = pick.cues.filter((c) => !list.some((x) => x.no === Number(c)));
    if (missing.length) return { error: `cue(s) ${missing.join(", ")} do not exist` };
    return { cues: pick.cues.map((c) => list.find((x) => x.no === Number(c)) as CueListEntry) };
  }
  if (pick.all) return list.length ? { cues: list } : { error: "the sequence has no cues" };
  const from = pick.from === undefined ? -Infinity : Number(pick.from);
  const to = pick.to === undefined ? Infinity : Number(pick.to);
  const hit = list.filter((x) => x.no >= from && x.no <= to);
  return hit.length ? { cues: hit } : { error: `no cue between ${pick.from ?? "the first"} and ${pick.to ?? "the last"}` };
}

const fmtNo = (n: number): string => String(Number(n.toFixed(3)));

/** SU-14: trigger times saved in the sequence's Note while its cues trigger otherwise: `[gma3-mcp trigtimes 1=2.5 2=4]`. */
const TRIG_MARKER = /\s*\[gma3-mcp trigtimes([^\]]*)\]/;

export function parseTrigMarker(note: unknown): Map<string, number> {
  const m = String(note ?? "").match(TRIG_MARKER);
  const out = new Map<string, number>();
  for (const part of (m?.[1] ?? "").trim().split(/\s+/).filter(Boolean)) {
    const [cue, time] = part.split("=");
    const n = Number(time);
    if (cue && Number.isFinite(n)) out.set(fmtNo(Number(cue)), n);
  }
  return out;
}

/** The Note with the marker replaced (or appended, or removed when the map is empty); the rest of the note is kept. */
export function writeTrigMarker(note: unknown, times: Map<string, number>): string {
  const rest = String(note ?? "").replace(TRIG_MARKER, "").trim();
  if (!times.size) return rest;
  const marker = `[gma3-mcp trigtimes ${[...times].sort((a, b) => Number(a[0]) - Number(b[0])).map(([c, t2]) => `${c}=${formatValue(t2)}`).join(" ")}]`;
  return rest ? `${rest} ${marker}` : marker;
}

export async function editCues(ctx: ToolContext, raw: Record<string, unknown>): Promise<OperationResult> {
  const op = "edit_cues";
  const { bridge } = ctx;
  const t = ctx.requestTimeoutMs;
  const v = new Validator();
  const sequence = v.check(() => objectNumber("sequence", raw.sequence));
  const picks = [raw.cues !== undefined, raw.from !== undefined || raw.to !== undefined, raw.all === true].filter(Boolean).length;
  if (picks !== 1) v.fail("give exactly one of cues (a list), from/to (a range) or all: true");
  let cueList: string[] | undefined;
  if (raw.cues !== undefined) {
    if (!Array.isArray(raw.cues) || raw.cues.length === 0 || raw.cues.length > MAX_CUES) v.fail(`cues must list 1 to ${MAX_CUES} cue numbers`);
    else cueList = raw.cues.map((c, i) => v.check(() => cueNumber(`cues[${i}]`, c)) ?? "");
  }
  const from = v.check(() => cueNumber("from", raw.from, { optional: true }));
  const to = v.check(() => cueNumber("to", raw.to, { optional: true }));
  if (from !== undefined && to !== undefined && Number(from) > Number(to)) v.fail("from must not be after to");
  const trig = validateTrigger(v, raw.trigger, raw.time, "", raw.restore_times === true);
  const timing: Partial<Record<TimingKey, number>> = validateTiming(v, raw, "");
  const snap = v.check(() => timeSeconds("snap_delay", raw.snap_delay, { optional: true }));
  if (snap !== undefined) timing.snap_delay = snap;
  let names: string[] | undefined;
  if (raw.names !== undefined) {
    if (!Array.isArray(raw.names) || raw.names.length === 0) v.fail("names must be a non-empty list (one per cue, in cue order)");
    else names = raw.names.map((n, i) => v.check(() => objectName(`names[${i}]`, n)) ?? "");
  }
  // SU-14: a command for every selected cue, or one per cue (in cue order).
  const command = v.check(() => cueCommand("command", raw.command));
  let commands: string[] | undefined;
  if (raw.commands !== undefined) {
    if (command !== undefined) v.fail("give command (the same for every cue) or commands (one per cue), not both");
    if (!Array.isArray(raw.commands) || raw.commands.length === 0) v.fail("commands must be a non-empty list (one per cue, in cue order)");
    else commands = raw.commands.map((c, i) => v.check(() => cueCommand(`commands[${i}]`, c)) ?? "");
  }
  const keepTimes = raw.keep_times === true;
  const restoreTimes = raw.restore_times === true;
  if (keepTimes && (!trig.trigger || trig.trigger === "time")) v.fail("keep_times saves the trigger times that a switch away from Time sets to 0: give trigger go, follow, sound or bpm");
  if (restoreTimes && trig.trigger !== "time") v.fail('restore_times brings the saved trigger times back: give trigger "time" (time is the fallback for cues without a saved time)');
  if (!trig.trigger && Object.keys(timing).length === 0 && !names && command === undefined && !commands) v.fail("give a trigger, timing (fade, delay, out_fade, out_delay, snap_delay), names and/or a command");
  const target = { sequence: raw.sequence, ...(cueList ? { cues: cueList } : raw.all ? { all: true } : { from: raw.from, to: raw.to }) };
  if (!v.ok || sequence === undefined) return validationFailure(op, target, v.errors);

  return ctx.mutations.run(async () => {
    let selected: CueListEntry[] = [];
    /** Each selected cue's trigger before the edit (read when the trigger changes). */
    const before = new Map<string, { type: string; time: number | null }>();
    let note = "";
    const restored = new Map<string, number>();
    const inspect = await runSteps([
      {
        name: "read_cues",
        run: async () => {
          try {
            const list = await readCueList(bridge, sequence, t);
            if (list === null) return failedRead("read_cues", `Sequence ${sequence} does not exist; nothing was sent`);
            const pick = selectCues(list, { cues: cueList, from, to, all: raw.all === true });
            if ("error" in pick) return failedRead("read_cues", `${pick.error}; nothing was sent`);
            if (pick.cues.length > MAX_CUES) return failedRead("read_cues", `${pick.cues.length} cues selected; at most ${MAX_CUES} per call`);
            if (names && names.length !== pick.cues.length) return failedRead("read_cues", `${names.length} name(s) for ${pick.cues.length} cue(s) (${pick.cues.map((c) => fmtNo(c.no)).join(", ")}); give one name per cue`);
            if (commands && commands.length !== pick.cues.length) return failedRead("read_cues", `${commands.length} command(s) for ${pick.cues.length} cue(s) (${pick.cues.map((c) => fmtNo(c.no)).join(", ")}); give one command per cue`);
            selected = pick.cues;
            if (trig.trigger) {
              for (const c of selected) {
                const r = (await bridge.request("objects", { ref: cueRef(sequence, fmtNo(c.no)), fields: ["TrigType", "TrigTime"], limit: 1 }, t)) as { items?: Array<{ fields?: Record<string, unknown> }> };
                const f = r.items?.[0]?.fields ?? {};
                const type = String(f.TrigType ?? "");
                const time = timeToSeconds(f.TrigTime);
                // keep_times saves what it reads: an unreadable trigger is refused, never taken as nothing to keep.
                if (keepTimes && (!type || (type.toLowerCase() === "time" && time === null))) return failedRead("read_cues", `the trigger of cue ${fmtNo(c.no)} could not be read (${JSON.stringify(f.TrigType ?? null)} / ${JSON.stringify(f.TrigTime ?? null)}), so its time cannot be kept; nothing was sent`);
                before.set(fmtNo(c.no), { type, time });
              }
            }
            if (keepTimes || restoreTimes) {
              const sq = (await bridge.request("objects", { ref: `Sequence ${sequence}`, fields: ["Note"], limit: 1 }, t)) as { items?: Array<{ fields?: Record<string, unknown> }> };
              const raw2 = sq.items?.[0]?.fields?.Note;
              if (raw2 === undefined || raw2 === null) return failedRead("read_cues", `the Note of Sequence ${sequence} could not be read, so saved trigger times cannot be kept or found; nothing was sent`);
              note = String(raw2);
            }
            if (restoreTimes) {
              const saved = parseTrigMarker(note);
              const missing: string[] = [];
              for (const c of selected) {
                const no = fmtNo(c.no);
                const time = saved.get(no) ?? trig.time;
                if (time === undefined) missing.push(no);
                else restored.set(no, time);
              }
              if (missing.length) return failedRead("read_cues", `no saved trigger time for cue(s) ${missing.join(", ")} in Sequence ${sequence}'s Note and no time given; nothing was sent`);
            }
            return asRead({ name: "read_cues", status: "succeeded", op: "children", detail: { cues: selected.map((c) => fmtNo(c.no)) } });
          } catch (err) {
            return asRead(stepFromError("read_cues", err, { op: "children" }));
          }
        },
      },
    ]);
    const steps = [...inspect.steps];
    const reports: CueReport[] = [];
    const readBack: StepResult[] = [];
    // SU-14: a switch away from Time sets TrigTime to 0 (live 2026-10-15), and a switch back keeps the 0: report what is
    // wiped and, with keep_times, save it in the sequence's Note first.
    const wiped = trig.trigger && trig.trigger !== "time" ? [...before].filter(([, b]) => b.type.toLowerCase() === "time" && (b.time ?? 0) > 0).map(([cue, b]) => ({ cue, time: b.time as number })) : [];
    let stopAll = false;
    if (inspect.outcome === "succeeded" && keepTimes && wiped.length) {
      const saved = parseTrigMarker(note);
      for (const w of wiped) saved.set(w.cue, w.time);
      const wanted = writeTrigMarker(note, saved);
      const kept = await runSteps([
        setStep(bridge, "keep_trig_times", `Sequence ${sequence}`, "Note", wanted, t),
        {
          // The saved times are the only copy once the trigger changes: they are read back before anything else
          // (review round 1). A console that ignores or rewrites the write stops the edit here.
          name: "check_trig_times_kept",
          run: async () => {
            try {
              const sq = (await bridge.request("objects", { ref: `Sequence ${sequence}`, fields: ["Note"], limit: 1 }, t)) as { items?: Array<{ fields?: Record<string, unknown> }> };
              const got = sq.items?.[0]?.fields?.Note;
              if (got === undefined || got === null) return failedRead("check_trig_times_kept", "the Note could not be read back; the triggers were not changed");
              const back = parseTrigMarker(got);
              const same = String(got).trim() === wanted.trim() && wiped.every((w) => back.get(w.cue) === w.time);
              return same ? asRead({ name: "check_trig_times_kept", status: "succeeded", op: "objects" }) : failedRead("check_trig_times_kept", `the Note reads ${JSON.stringify(got)}, not the saved times; the triggers were not changed`);
            } catch (err) {
              return asRead(stepFromError("check_trig_times_kept", err, { op: "objects" }));
            }
          },
        },
      ]);
      steps.push(...kept.steps);
      if (kept.outcome !== "succeeded") stopAll = true;
      else note = wanted;
    }
    if (inspect.outcome === "succeeded") {
      let stopped = stopAll;
      for (let i = 0; i < selected.length; i++) {
        const no = fmtNo(selected[i].no);
        const report: CueReport = { cue: no, status: "not_attempted", verification: unavailable("not attempted") };
        reports.push(report);
        if (stopped) continue;
        const pre = `cue ${no}: `;
        const part0 = cueRef(sequence, no, 0);
        const cueObj = cueRef(sequence, no);
        const plan: Array<{ name: string; run: StepFn }> = [];
        if (names) plan.push(setStep(bridge, `${pre}name`, part0, "Name", names[i], t));
        for (const [k, val] of Object.entries(timing) as Array<[TimingKey, number]>) plan.push(setStep(bridge, `${pre}${k}`, part0, TIMING_PROPS[k], val, t));
        if (trig.trigger) plan.push(setStep(bridge, `${pre}trigger`, cueObj, "TrigType", TRIGGERS[trig.trigger], t));
        const cueTime = restored.get(no) ?? trig.time;
        if (cueTime !== undefined) plan.push(setStep(bridge, `${pre}trigger_time`, cueObj, "TrigTime", cueTime, t));
        const cueCommandText = commands?.[i] ?? command;
        if (cueCommandText !== undefined) plan.push(setStep(bridge, `${pre}command`, part0, "Command", cueCommandText, t));
        const run = await runSteps(plan);
        steps.push(...run.steps);
        const bad = run.steps.find((s) => s.status !== "succeeded" && s.status !== "skipped");
        report.status = bad ? (bad.status === "unknown" ? "unknown" : "failed") : "stored";
        if (bad) {
          report.error = `${bad.name}: ${bad.error ?? bad.status}`;
          stopped = true;
        }
        if (raw.verify === false || !run.steps.some((s) => s.status === "succeeded" || s.status === "unknown")) {
          report.verification = raw.verify === false ? notRequested() : unavailable("nothing was sent for this cue");
          continue;
        }
        const expected: Record<string, unknown> = { ...(names ? { Name: names[i] } : {}), ...(trig.trigger ? { TrigType: TRIGGERS[trig.trigger] } : {}), ...(cueTime !== undefined ? { TrigTime: cueTime } : {}) };
        const timingExpected: Record<string, unknown> = { ...Object.fromEntries(Object.entries(timing).map(([k, val]) => [TIMING_PROPS[k as TimingKey], val])), ...(cueCommandText !== undefined ? { Command: cueCommandText } : {}) };
        const checked = `cue ${no}: ${[...Object.keys(expected), ...Object.keys(timingExpected)].join(", ")}`;
        try {
          const c = (await bridge.request("objects", { ref: cueObj, fields: ["Name", "TrigType", "TrigTime"], limit: 1 }, t)) as { items?: Array<{ fields?: Record<string, unknown> }> };
          let actual: Record<string, unknown> | null = c.items?.[0]?.fields ?? null;
          if (actual && Object.keys(timingExpected).length) {
            const p = (await bridge.request("objects", { ref: part0, fields: Object.keys(timingExpected), limit: 1 }, t)) as { items?: Array<{ fields?: Record<string, unknown> }> };
            actual = { ...actual, ...(p.items?.[0]?.fields ?? {}) };
          }
          report.name = actual && typeof actual.Name === "string" ? actual.Name : null;
          report.verification = actual ? compareFields(checked, { ...expected, ...timingExpected }, actual, { normalize: TIME_NORMALIZERS }) : { status: "mismatched", checked, detail: `cue ${no} no longer exists` };
          readBack.push(asRead({ name: `${pre}read_back`, status: "succeeded", op: "objects", detail: { verification: report.verification.status } }));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          readBack.push(asRead({ name: `${pre}read_back`, status: "failed", op: "objects", error: message }));
          report.verification = unavailable(`read-back failed: ${message}`, checked);
        }
      }
    }
    // restore_times: only the cues whose restored time was read back leave the Note's marker (the rest of the note
    // and every unconfirmed entry stay, as recovery data), and nothing is written after a step without a reply.
    const confirmed = reports.filter((r) => r.status === "stored" && r.verification.status === "matched").map((r) => r.cue);
    const unsure = steps.find((st) => st.status === "unknown" && st.kind !== "read");
    if (restoreTimes && confirmed.length && !unsure) {
      const saved = parseTrigMarker(note);
      for (const c of confirmed) saved.delete(c);
      const cleaned = await runSteps([setStep(bridge, "clear_saved_trig_times", `Sequence ${sequence}`, "Note", writeTrigMarker(note, saved), t)]);
      steps.push(...cleaned.steps);
    } else if (restoreTimes && unsure) steps.push({ name: "clear_saved_trig_times", status: "skipped", error: `not attempted: step '${unsure.name}' got no reply; the saved times stay in the Note` });
    const attempted = reports.filter((r) => r.status !== "not_attempted");
    const verification =
      raw.verify === false ? notRequested() : attempted.length === 0 ? unavailable("nothing was sent") : worst(attempted.map((r) => ({ ...r.verification, detail: r.verification.detail ? `cue ${r.cue}: ${r.verification.detail}` : undefined })), `${attempted.length} cue(s): the properties that were written`);
    const warnings = wiped.length && !keepTimes ? [`switching to ${TRIGGERS[trig.trigger as TriggerKey]} set the trigger time of ${wiped.length} Time cue(s) to 0 (${wiped.map((w) => `${w.cue}: ${formatValue(w.time)} s`).join(", ")}); a switch back to Time keeps the 0. Pass keep_times: true to save them in the sequence's Note, and restore_times: true on the way back`] : [];
    const result = buildResult({ operation: op, target: { sequence, cues: selected.map((c) => fmtNo(c.no)) }, steps, verification, warnings, extra: { cues: reports, edited: reports.filter((r) => r.status === "stored").length, ...(wiped.length ? { wipedTrigTimes: wiped, trigTimesKept: keepTimes && !stopAll } : {}), ...(restoreTimes ? { restoredTrigTimes: Object.fromEntries(restored) } : {}) } });
    result.steps.push(...readBack);
    return result;
  });
}

export async function buildChase(ctx: ToolContext, raw: Record<string, unknown>): Promise<OperationResult> {
  const op = "build_chase";
  const { bridge } = ctx;
  const t = ctx.requestTimeoutMs;
  const v = new Validator();
  const sequence = v.check(() => objectNumber("sequence", raw.sequence));
  const name = v.check(() => objectName("name", raw.name, { optional: true }));
  const defaultFixtures = raw.fixtures === undefined ? undefined : v.check(() => fixtureSelection("fixtures", raw.fixtures));
  // Steps: `steps` (each a look, or looks, with an optional name), or `presets` (one cue per preset on `fixtures`).
  let rawSteps: Array<Record<string, unknown>> = [];
  let range: PresetRange | undefined;
  if ((raw.steps === undefined) === (raw.presets === undefined)) v.fail("give exactly one of steps or presets");
  else if (raw.presets !== undefined && !Array.isArray(raw.presets)) {
    // SU-14: a preset range {pool, from, to}: one step per existing preset, resolved once the lock is held.
    range = validatePresetRange(v, raw.presets, "presets");
    if (!defaultFixtures) v.fail("presets needs fixtures (the target every preset is recalled on)");
  } else if (raw.presets !== undefined) rawSteps = (raw.presets as unknown[]).map((p) => ({ presets: [p] }));
  else if (!Array.isArray(raw.steps)) v.fail("steps must be a list");
  else rawSteps = raw.steps as Array<Record<string, unknown>>;
  if (rawSteps.length && (rawSteps.length < 2 || rawSteps.length > MAX_CUES)) v.fail(`a chase needs 2 to ${MAX_CUES} steps`);
  const replace = raw.replace === true;
  const settings = validateSequenceSettings(v, raw.sequence_settings);
  const protect = raw.protect_running === true;
  if (protect && !settings?.priority) v.fail("protect_running applies to an override: give sequence_settings.priority above ltp");
  const stepS = v.check(() => finiteNumber("step_seconds", raw.step_seconds, { min: 0.2, max: 3600, optional: true }));
  const cycleS = v.check(() => finiteNumber("cycle_seconds", raw.cycle_seconds, { min: 0.4, max: 360000, optional: true }));
  if ((stepS === undefined) === (cycleS === undefined)) v.fail("give exactly one of step_seconds (time per cue) or cycle_seconds (time for the whole loop)");
  const fade = v.check(() => timeSeconds("fade", raw.fade, { optional: true }));
  const verify = raw.verify !== false;
  const observe = typeof raw.observe === "boolean" ? raw.observe : verify;
  const budget = v.check(() => finiteNumber("observe_max_seconds", raw.observe_max_seconds, { min: 5, max: OBSERVE_MAX_S, optional: true })) ?? OBSERVE_DEFAULT_S;
  const leaveRunning = raw.leave_running === true;
  if (raw.exclusive !== true) v.fail(EXCLUSIVE_REASON);
  let step = stepS ?? (cycleS !== undefined && rawSteps.length ? Number((cycleS / rawSteps.length).toFixed(3)) : 0);
  if (cycleS !== undefined && rawSteps.length && step < 0.2) v.fail(`cycle_seconds gives ${step} s per step; the minimum is 0.2 s`);
  let cues: CueSpec[] = [];
  rawSteps.forEach((s, i) => {
    const r = (s ?? {}) as Record<string, unknown>;
    const path = raw.presets !== undefined ? `presets[${i}]` : `steps[${i}]`;
    const command = v.check(() => cueCommand(`${path}.command`, r.command));
    const looks = validateLooks(v, Object.fromEntries(Object.entries(r).filter(([k]) => k !== "name" && k !== "command")), path, defaultFixtures, command !== undefined);
    const stepName = v.check(() => objectName(`${path}.name`, r.name, { optional: true }));
    cues.push({ cue: String(i + 1), name: stepName, looks, ...(command !== undefined ? { command } : {}), timing: fade !== undefined ? { fade } : {}, trigger: "time", time: step });
  });
  const target: Record<string, unknown> = { sequence: raw.sequence, ...(range ? { presets: `${range.pool}.${range.from} Thru ${range.pool}.${range.to}` } : { steps: rawSteps.length }), stepSeconds: step, ...(replace ? { replace } : {}) };
  if (!v.ok || sequence === undefined) return validationFailure(op, target, v.errors);

  return ctx.mutations.run(async () => {
    const pre: StepResult[] = [];
    if (range) {
      try {
        const found = await readPresetRange(bridge, range, t);
        const ok = found.length >= 2;
        pre.push(asRead({ name: "read_preset_range", status: ok ? "succeeded" : "failed", op: "objects", detail: { found: found.map((p) => p.no) }, ...(ok ? {} : { error: `${found.length} preset(s) exist in ${range.pool}.${range.from} Thru ${range.pool}.${range.to}; a chase needs at least two; nothing was sent` }) }));
        if (!ok) return buildResult({ operation: op, target: { sequence }, steps: pre, verification: unavailable("nothing was sent") });
        if (cycleS !== undefined) step = Number((cycleS / found.length).toFixed(3));
        if (step < 0.2) {
          pre.push(asRead({ name: "check_step_time", status: "failed", op: "objects", error: `cycle_seconds gives ${step} s per step for ${found.length} presets; the minimum is 0.2 s; nothing was sent` }));
          return buildResult({ operation: op, target: { sequence }, steps: pre, verification: unavailable("nothing was sent") });
        }
        cues = presetCues(found, range, defaultFixtures as string, 1, () => ({ timing: fade !== undefined ? { fade } : {}, trigger: "time", time: step }));
      } catch (err) {
        pre.push(asRead(stepFromError("read_preset_range", err, { op: "objects" })));
        return buildResult({ operation: op, target: { sequence }, steps: pre, verification: unavailable("nothing was sent") });
      }
    }
    // A chase is a whole sequence: refuse one that already has cues (stale cues past the last step would join the loop),
    // unless replace: then they are deleted first and the sequence (and its executor assignments) stays.
    try {
      const list = await readCueList(bridge, sequence, t);
      if (list && list.length && !replace) {
        pre.push(failedRead("check_sequence_empty", `Sequence ${sequence} already has ${list.length} cue(s); a chase is built into an empty or new sequence, or pass replace: true to delete its cues first (the sequence and its executor assignments stay). Nothing was sent`));
        return buildResult({ operation: op, target: { sequence }, steps: pre, verification: unavailable("nothing was sent") });
      }
      pre.push(asRead({ name: "check_sequence_empty", status: "succeeded", op: "children", detail: { exists: list !== null } }));
    } catch (err) {
      pre.push(asRead(stepFromError("check_sequence_empty", err, { op: "children" })));
      return buildResult({ operation: op, target: { sequence }, steps: pre, verification: unavailable("nothing was sent") });
    }
    if (replace && settings && (await readCueList(bridge, sequence, t).catch(() => null)) !== null) {
      const chk = await settingsPreflight(ctx, sequence, settings);
      pre.push(chk);
      if (chk.status !== "succeeded") return buildResult({ operation: op, target: { sequence }, steps: pre, verification: unavailable("nothing was sent") });
    }
    const assignedBefore = replace ? await assignmentsOf(bridge, sequence, t) : null;
    const r = await buildCueBatch(ctx, { sequence, sequenceName: name, mode: "create", cues, verify, replace });
    r.steps.unshift(...pre);
    const allStored = r.cues.every((c) => c.status === "stored");
    const extra: Record<string, unknown> = { stepSeconds: step, cycleSeconds: Number((step * cues.length).toFixed(3)) };
    if (!allStored) return batchResult(op, { sequence, steps: cues.length }, r, { ...extra, cycle: { watched: false, reason: "not every cue was stored" } });
    const unsure = uncertainStep(r.steps);
    if (unsure) return batchResult(op, { sequence, steps: cues.length }, r, { ...extra, cycle: { watched: false, reason: `step '${unsure.name}' got no reply; nothing more was sent` } });
    // Nothing more is sent unless Preview was left cleanly and the console is confirmed back in Normal: a Goto from
    // anywhere else would play the chase on a console in an unknown state.
    if (!r.backInNormal) return batchResult(op, { sequence, steps: cues.length }, r, { ...extra, cycle: { watched: false, reason: "the console was not confirmed back in the Normal environment after the build (run gma3_phaser_release); Wrap Around was not set and the chase was not played" } });

    // Wrap Around: the last cue is followed by cue 1 (cue 1 carries a Time trigger too, so the loop continues).
    const wrap = await runSteps([setStep(bridge, "wrap_around", `Sequence ${sequence}`, "WrapAround", "Yes", t)]);
    r.steps.push(...wrap.steps);
    let configVerification: Verification = { status: "matched", checked: "WrapAround" };
    try {
      const w = (await bridge.request("objects", { ref: `Sequence ${sequence}`, fields: ["WrapAround", "Name"], limit: 1 }, t)) as { items?: Array<{ fields?: Record<string, unknown> }> };
      const f = w.items?.[0]?.fields ?? {};
      configVerification = compareFields("the sequence's WrapAround (and name)", { WrapAround: "Yes", ...(name !== undefined ? { Name: name } : {}) }, f);
    } catch (err) {
      configVerification = unavailable(`WrapAround read-back failed: ${err instanceof Error ? err.message : String(err)}`, "WrapAround");
    }
    if (wrap.outcome !== "succeeded") return batchResult(op, { sequence, steps: cues.length }, r, { ...extra, cycle: { watched: false, reason: "Wrap Around could not be set" } }, worst([r.verification, configVerification], "cues and Wrap Around"));
    // SU-14: replace keeps the executor assignments; the sequence settings (and an override's effect) in the same span.
    if (replace) {
      const after = await assignmentsOf(bridge, sequence, t);
      const kept = assignedBefore !== null && after !== null && assignedBefore.every((x) => after.includes(x));
      extra.assignments = { before: assignedBefore, after, kept: assignedBefore === null || after === null ? null : kept };
      if (assignedBefore !== null && after !== null && !kept) configVerification = worst([configVerification, { status: "mismatched", detail: `the executor assignments changed: ${assignedBefore.join(", ") || "none"} before, ${after.join(", ") || "none"} after` }], "Wrap Around and executor assignments");
    }
    if (settings) {
      const s2 = await sequenceExtras(ctx, sequence, settings, protect, r.steps, r.warnings);
      Object.assign(extra, s2.extra);
      configVerification = worst([configVerification, ...s2.verifications], "Wrap Around and the sequence settings");
      // An override whose protection or settings did not succeed is not played (review round 1).
      if (!s2.ready) return batchResult(op, { sequence, steps: cues.length }, r, { ...extra, cycle: { watched: false, reason: "the sequence settings (or the running sequences' protection) did not succeed, so the chase was not played" } }, worst([r.verification, configVerification], "cues, Wrap Around and the sequence settings"));
    }

    // One observed cycle (a playback: Goto, sample, Off).
    let cycleVerification: Verification = notRequested();
    let cycle: Record<string, unknown> = { watched: false, reason: "observe: false" };
    if (observe) {
      try {
        const active = (await bridge.request("object", { ref: `Sequence ${sequence}`, properties: false }, t)) as { hasActivePlayback?: unknown };
        if (active?.hasActivePlayback === true) throw new Error("the sequence is already running; it was not restarted");
        const rate = await readSequenceRate(bridge, sequence, t);
        const list = (await readCueList(bridge, sequence, t)) ?? [];
        if (list.length !== cues.length) throw new Error(`the sequence has ${list.length} cue(s) after the build, expected ${cues.length}`);
        if (rate.rate === 0) throw new Error("the sequence's rate is 0: the chase does not advance");
        const predicted = rate.rate === null ? null : (step * 1000) / rate.rate;
        const planned = planObservation(list.length, predicted ?? step * 1000, budget * 1000);
        if (!planned) throw new Error(`one step (${Math.round(predicted ?? step * 1000)} ms) is too long to observe the wrap within observe_max_seconds (${budget} s)`);
        const obs = await observeChase(ctx, sequence, planned, list, predicted, step * 1000, r.steps);
        if (!leaveRunning) r.steps.push(await commandStep(bridge, "stop_chase", `Off Sequence ${sequence}`, t));
        const notes = [...obs.notes, ...rate.notes];
        if (predicted === null) notes.push("the sequence's rate could not be read, so the step intervals were not judged");
        if (rate.rate !== null && Math.abs(rate.rate - 1) > 1e-6) notes.push(`the sequence runs at rate ${Number(rate.rate.toFixed(4))} (${JSON.stringify(rate.rateSource)}), so a step takes ${Math.round(predicted as number)} ms, not ${Math.round(step * 1000)} ms`);
        if (obs.mode === "tail") notes.push(`the full cycle (${(list.length * (predicted ?? step * 1000) / 1000).toFixed(1)} s) is longer than observe_max_seconds (${budget} s): observed from cue ${obs.startCue} through the wrap; every cue's trigger was read back`);
        cycle = { watched: true, ...obs, notes, rate: rate.rate, rateSource: rate.rateSource, leftRunning: leaveRunning };
        const checked = `${obs.mode === "full" ? "one full cycle" : `the cycle from cue ${obs.startCue} through the wrap`}: cue order ${obs.expected.join(" -> ")}${predicted !== null ? `, each step ${Math.round(predicted)} ms ± ${Math.round(obs.toleranceMs as number)} ms` : ""}`;
        cycleVerification = obs.problems.length ? { status: "mismatched", checked, detail: obs.problems.join("; ") } : { status: "matched", checked, actual: { observed: obs.observed } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        cycle = { watched: false, reason: message };
        cycleVerification = unavailable(`the cycle was not observed: ${message}`, "one observed cycle");
      }
    }
    const verification =
      !verify && !observe ? notRequested() : worst([...(verify ? [r.verification, configVerification] : []), ...(observe ? [cycleVerification] : [])], `${verify ? "the cues (looks before each store, names, triggers), Wrap Around" : ""}${verify && observe ? ", and " : ""}${observe ? "one observed cycle" : ""}`);
    return batchResult(op, { sequence, steps: cues.length }, r, { ...extra, wrapAround: configVerification.status, cycle }, verification);
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const presetSchema = z.object({ pool: z.number().describe("Preset pool: 1 Dimmer, 2 Position, 3 Gobo, 4 Color, 5 Beam, 6 Focus, 7 Control, 8 Shapers, 9 Video, 21.. All."), preset: z.union([z.number(), z.string()]).describe("Preset number in the pool, or its name.") });
const valueSchema = z.object({
  attribute: z.string().describe('Attribute name, e.g. "Pan", "ColorRGB_W".'),
  value: z.number(),
  unit: z.enum(ATTRIBUTE_UNIT_NAMES as [AttributeUnit, ...AttributeUnit[]]).optional().describe("percent, percent_fine, physical, natural, decimal8/16/24; omit for the console's readout."),
});
const lookShape = {
  fixtures: z.string().optional().describe('Target, e.g. "101 Thru 112", "Group 3" (default: the call\'s fixtures).'),
  presets: z.array(presetSchema).optional().describe(`Presets applied in order (At Preset), up to ${MAX_PRESETS_PER_LOOK}.`),
  intensity: z.number().optional().describe("Intensity 0..100 percent (At <value>)."),
  values: z.array(valueSchema).optional().describe(`Attribute values (Attribute ... At Absolute), up to ${MAX_ATTRIBUTES}; applied after the presets.`),
  phaser: z
    .object({
      steps: z.array(z.object({ values: z.record(z.string(), z.union([z.number(), z.object({ absolute: z.number().optional(), relative: z.number().optional() })])), width: z.number().optional(), transition: z.number().optional(), accel: z.number().optional(), decel: z.number().optional() })).describe("2-16 steps: attribute -> value (absolute) or {absolute, relative}, plus step timing."),
      phaser: z.object({ speed_bpm: z.number().optional(), phase: z.union([z.object({ from: z.number(), to: z.number() }), z.object({ from: z.number().optional(), step: z.number() }), z.literal("spread")]).optional(), measure: z.number().optional(), speed_master: z.number().optional(), repeat: z.object({ groups: z.number().optional(), wings: z.number().optional(), blocks: z.number().optional() }).optional(), shuffle: z.number().optional() }).optional(),
      unit: z.enum(["percent", "physical"]).optional(),
    })
    .optional()
    .describe("A phaser on the look's fixtures, as gma3_build_phaser takes steps and phaser (measure = beats per cycle); built after the look's other values and checked per fixture, step and layer."),
};
const lookSchema = z.object(lookShape);
const contentShape = { ...lookShape, looks: z.array(lookSchema).optional().describe(`Several looks (each its own fixtures) in one cue, up to ${MAX_LOOKS}, applied in order; instead of the shorthand fields.`) };
const timingShape = {
  fade: z.number().optional().describe("Cue in fade, seconds (Part 0 CueInFade)."),
  delay: z.number().optional().describe("Cue in delay, seconds."),
  out_fade: z.number().optional().describe("Out fade, seconds."),
  out_delay: z.number().optional().describe("Out delay, seconds."),
};
const triggerShape = {
  trigger: z.enum(TRIGGER_KEYS as [TriggerKey, ...TriggerKey[]]).optional().describe("go, time (needs time), follow (optional time), sound, bpm."),
  time: z.number().optional().describe("Trigger time in seconds (TrigTime)."),
};

/**
 * The compact form of a store_cues / build_chase result (SU-12): compactResult's step filtering, one line per cue
 * (its status and verification; the look details only for a cue that did not match), and the observed cycle as its
 * cue order and step intervals instead of every sample.
 */
export function compactCueResult(r: OperationResult, detail: boolean): OperationResult {
  if (detail) return r;
  const out = compactResult(r, false);
  if (Array.isArray(out.cues)) {
    out.cues = (out.cues as CueReport[]).map((c) => {
      const ok = c.verification.status === "matched" || c.verification.status === "not_requested";
      return {
        cue: c.cue,
        status: c.status,
        verification: c.verification.status,
        ...(c.name !== undefined && c.name !== null ? { name: c.name } : {}),
        ...(c.error ? { error: c.error } : {}),
        ...(ok ? {} : { detail: c.verification.detail, looks: c.looks }),
      };
    });
  }
  const cycle = out.cycle as (Record<string, unknown> & { observed?: Array<{ cue: number }> }) | undefined;
  if (cycle?.observed) {
    const { observed, ...rest } = cycle;
    out.cycle = { ...rest, observedCues: observed.map((o) => o.cue) };
  }
  return out;
}

const commandSchema = z.string().optional().describe('The cue\'s command (Part 0 Command), run when the cue is called, e.g. "Go+ Macro 20". A cue with a command needs no look.');
const cueSchema = z.object({ cue: z.union([z.number(), z.string()]), name: z.string().optional(), command: commandSchema, ...contentShape, ...timingShape, ...triggerShape });
const presetRangeSchema = z.object({ pool: z.number(), from: z.number(), to: z.number() });
const sequenceSettingsShape = {
  sequence_settings: z.record(z.string(), z.unknown()).optional().describe("Sequence settings applied after the build, as gma3_configure_sequence takes them (priority, off_when_overridden, wrap_around, ...)."),
  protect_running: z.boolean().optional().describe("With a priority above ltp: turn Off When Overridden off on the running sequences the override would switch off (default false: they are listed in a warning)."),
};

const COMPACT_NOTE =
  "The result is compact by default: outcome, verification, one line per cue (look details only for a cue that did not match), the observed cycle as its cue order and step intervals, and only the steps that did not succeed (with a count of the rest); detail: true returns every step, every look and every sample.";

const BUILD_NOTE =
  "Built in the console's Preview environment: its own programmer and selection, so nothing is output and the operator's Normal programmer is untouched (checked before and after). Each cue starts from an empty programmer (ClearAll, sent only in Preview), its looks are applied in order (presets, then intensity, then values; a later look wins on shared fixtures), each look is checked in the programmer (preset links, values per fixture and cell), then the cue is stored. " +
  "A look that did not apply stops the batch before that cue is stored; the cues already stored stay (nothing is undone or retried) and the result lists every cue with its status. A cue's stored values cannot be read back on 2.5.1; the cue's existence, name, timing and trigger are. A cue stored without a name takes the preset's name. Requires exclusive: true.";

export const registerCueListTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_store_cues",
    {
      title: "Store a list of cues from explicit content",
      description:
        "Store several cues of one sequence in one call, each from explicit content: a look (fixtures with presets, intensity, attribute values and/or a phaser) or several looks, with an optional name, timing, trigger and command per cue; a cue with a command needs no look (stored empty). mode create refuses (nothing sent) when any of the cues exists; merge and overwrite store into existing cues. The store creates the sequence when it does not exist; sequence_name names it. " +
        "presets {pool, from, to} (instead of cues): one cue per existing preset of the range on fixtures, named after it, with the call's timing and trigger. replace: true deletes the existing cues first (the sequence object, its settings and executor assignments stay, checked). sequence_settings (as gma3_configure_sequence) are applied after the build in the same call; a priority above ltp lists the running sequences it would switch off (Off When Overridden on), and protect_running: true turns that off on them. " +
        BUILD_NOTE +
        " " +
        COMPACT_NOTE +
        " Batch form (sequences): several sequences, each {sequence, sequence_name, mode, fixtures, cues}, each built in its own Preview session with these checks. " +
        BATCH_NOTE,
      inputSchema: {
        sequence: z.number().optional().describe("Sequence number. Required unless sequences is given."),
        sequence_name: z.string().optional(),
        mode: z.enum(["create", "merge", "overwrite"]).optional().describe("Required (per sequence or for the whole batch)."),
        fixtures: z.string().optional().describe("Default target for looks that do not name their own fixtures."),
        cues: z.array(cueSchema).optional().describe(`1 to ${MAX_CUES} cues, stored in the order given. Required unless sequences or presets is given.`),
        presets: presetRangeSchema.optional().describe("One cue per existing preset of the range on fixtures, numbered from first_cue, named after the preset (instead of cues)."),
        first_cue: z.number().optional().describe("With presets: the first cue number (default 1)."),
        ...timingShape,
        ...triggerShape,
        replace: z.boolean().optional().describe("Delete every existing cue first, then store (mode create); the sequence and its executor assignments stay."),
        ...sequenceSettingsShape,
        exclusive: z.boolean().optional().describe("Required (true)."),
        verify: z.boolean().optional(),
        sequences: z
          .array(z.object({ sequence: z.number(), sequence_name: z.string().optional(), mode: z.enum(["create", "merge", "overwrite"]).optional(), fixtures: z.string().optional(), cues: z.array(cueSchema) }))
          .optional()
          .describe("Batch form: several sequences, each {sequence, sequence_name, mode, fixtures, cues}."),
        ...batchOptionShape,
      },
    },
    (args) =>
      operation(() => {
        const a = args as Record<string, unknown>;
        if (a.sequences === undefined) return storeCues(ctx, a).then((r) => compactCueResult(r, a.detail === true));
        return runBatchCall(a, {
          ctx,
          operation: "store_cues",
          listKey: "sequences",
          identityKeys: ["sequence", "sequence_name", "cues"],
          label: (it) => `Sequence ${String(it.sequence)}`,
          key: (it) => `Sequence ${String(it.sequence)}`,
          check: (items) => duplicates(items.map((it) => String(it.sequence))).map((n) => `Sequence ${n} appears more than once in sequences`),
          run: (it, c) => storeCues(c, it),
        });
      }),
  );

  server.registerTool(
    "gma3_edit_cues",
    {
      title: "Set trigger, timing and names on a range of cues",
      description:
        "Edit existing cues of a sequence in one call: the same trigger (TrigType/TrigTime), the same timing (Part 0 CueInFade, CueInDelay, CueOutFade, CueOutDelay, SnapDelay), one name per cue, and/or a command (command for all, commands one per cue). " +
        "A switch from Time to another trigger sets each cue's TrigTime to 0 on the console, and a switch back keeps the 0: the result lists the wiped times (wipedTrigTimes); keep_times: true saves them in the sequence's Note first ([gma3-mcp trigtimes 1=2.5 ...]), and trigger time with restore_times: true sets them back and removes them from the note. " +
        "Choose the cues with exactly one of cues (a list), from/to (a range, either end optional) or all: true; names are given in cue order, one per cue. " +
        "Refuses (nothing sent) when the sequence or a listed cue does not exist, or the number of names differs. One Set() per property, cue by cue; stops at the first failure and reports every cue. Reads the written properties back per cue. Stored values and the programmer are not touched.",
      inputSchema: {
        sequence: z.number(),
        cues: z.array(z.union([z.number(), z.string()])).optional(),
        from: z.union([z.number(), z.string()]).optional(),
        to: z.union([z.number(), z.string()]).optional(),
        all: z.boolean().optional(),
        ...triggerShape,
        ...timingShape,
        snap_delay: z.number().optional(),
        names: z.array(z.string()).optional().describe("One name per selected cue, in cue order."),
        command: z.string().optional().describe("The same command (Part 0 Command) on every selected cue."),
        commands: z.array(z.string()).optional().describe("One command per selected cue, in cue order."),
        keep_times: z.boolean().optional().describe("With a trigger other than time: save the trigger times the switch sets to 0 in the sequence's Note."),
        restore_times: z.boolean().optional().describe("With trigger time: set each cue's saved trigger time from the sequence's Note (time is the fallback) and remove them from it."),
        verify: z.boolean().optional(),
      },
    },
    (args) => operation(() => editCues(ctx, args as Record<string, unknown>)),
  );

  server.registerTool(
    "gma3_build_chase",
    {
      title: "Build a looping chase and watch one cycle",
      description:
        "Build a chase into an empty or new sequence (or replace: true to rebuild one, keeping its executor assignments): one cue per step (steps: each a look or looks, a phaser in a look, an optional name and command; or presets: one cue per preset on fixtures, a list or a range {pool, from, to}), every cue Time-triggered after step_seconds (or cycle_seconds / number of steps) with an optional crossfade, and Wrap Around on, so the last cue is followed by the first. " +
        BUILD_NOTE +
        " sequence_settings and protect_running as in gma3_store_cues. Then, unless observe: false, PLAYS the chase (Goto cue 1, live output) and OBSERVES it over time on the server side (no Lua loop needed), sampling its current cue to verify one cycle: the cue order through the wrap and each step against step_seconds / the sequence's rate. A cycle longer than observe_max_seconds (default 45, at most 120; keep it under your client's request timeout) is observed from a late cue through the wrap instead. The chase is switched off afterwards unless leave_running: true. " +
        COMPACT_NOTE,
      inputSchema: {
        sequence: z.number().describe("An empty or new sequence."),
        name: z.string().optional().describe("Sequence name."),
        fixtures: z.string().optional().describe("Target for every step that does not name its own fixtures."),
        presets: z.union([z.array(presetSchema), presetRangeSchema]).optional().describe("One cue per preset on fixtures (instead of steps): a list, or a range {pool, from, to} of the presets that exist, each cue named after its preset."),
        steps: z.array(z.object({ name: z.string().optional(), command: commandSchema, ...contentShape })).optional().describe(`2 to ${MAX_CUES} steps, one cue each; a step with a command needs no look.`),
        replace: z.boolean().optional().describe("Rebuild a sequence that has cues: delete them first (the sequence and its executor assignments stay, checked). Default false: such a sequence is refused."),
        ...sequenceSettingsShape,
        step_seconds: z.number().optional().describe("Time per step (each cue's TrigTime), at least 0.2 s."),
        cycle_seconds: z.number().optional().describe("Time for the whole loop, divided over the steps (instead of step_seconds)."),
        fade: z.number().optional().describe("Crossfade per cue in seconds (CueInFade); it does not lengthen the step."),
        observe: z.boolean().optional().describe("Play the chase and verify one cycle (default: as verify, true)."),
        observe_max_seconds: z.number().optional(),
        leave_running: z.boolean().optional(),
        exclusive: z.boolean().optional().describe("Required (true)."),
        verify: z.boolean().optional(),
        detail: batchOptionShape.detail,
      },
    },
    (args) => operation(() => buildChase(ctx, args as Record<string, unknown>).then((r) => compactCueResult(r, (args as Record<string, unknown>).detail === true))),
  );
};
