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
}
export interface CueSpec {
  cue: string;
  name?: string;
  looks: LookSpec[];
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

/** A look: a target and what to give it. Presets first, then intensity, then values (later commands win). */
function validateLook(v: Validator, raw: unknown, path: string, defaultFixtures: string | undefined): LookSpec | undefined {
  const r = (raw ?? {}) as { fixtures?: unknown; presets?: unknown; intensity?: unknown; values?: unknown };
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
  if (presets.length === 0 && intensity === undefined && values.length === 0 && v.ok) v.fail(`${path}: give presets, intensity and/or values`);
  if (!fixtures) return undefined;
  return { fixtures, presets, intensity, values };
}

/** The looks of a cue: `looks`, or the shorthand fields (fixtures, presets, intensity, values) as one look. */
function validateLooks(v: Validator, raw: Record<string, unknown>, path: string, defaultFixtures: string | undefined): LookSpec[] {
  const shorthand = ["presets", "intensity", "values", "fixtures"].some((k) => raw[k] !== undefined);
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
    v.fail(`${path}: give its content (presets, intensity, values or looks)`);
    return [];
  }
  const look = validateLook(v, raw, path, defaultFixtures);
  return look ? [look] : [];
}

function validateTrigger(v: Validator, rawTrigger: unknown, rawTime: unknown, path: string): { trigger?: TriggerKey; time?: number } {
  const trigger = v.check(() => oneOf(`${path}trigger`, rawTrigger, TRIGGER_KEYS, { optional: true }));
  const time = v.check(() => timeSeconds(`${path}time`, rawTime, { optional: true }));
  if (time !== undefined && trigger === undefined) v.fail(`${path}time needs a trigger ("time" or "follow")`);
  if (trigger === "time" && time === undefined) v.fail(`${path}time (seconds) is required for trigger "time"`);
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
    const looks = validateLooks(v, r, path, defaultFixtures);
    const timing = validateTiming(v, r, `${path}.`);
    const trig = validateTrigger(v, r.trigger, r.time, `${path}.`);
    if (cue && out.some((x) => Number(x.cue) === Number(cue))) v.fail(`${path}: cue ${cue} appears twice`);
    if (cue) out.push({ cue, name, looks, timing, ...trig });
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

/** Environment and value count of the current programmer (one short read). */
async function environmentOf(bridge: Gma3Bridge, t: number): Promise<{ environment: string | null; values: number }> {
  const r = (await bridge.request("programmer", { scope: "all", limit: 1 }, t)) as { environment?: string; total?: number };
  return { environment: typeof r.environment === "string" ? r.environment : null, values: typeof r.total === "number" ? r.total : 0 };
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

/**
 * Inspect (read-only; nothing is sent when it fails), build every cue in Preview, leave Preview, check the Normal
 * programmer, then read every stored cue back. Runs inside the caller's mutation lock span.
 */
export async function buildCueBatch(ctx: ToolContext, b: Batch): Promise<BatchResult> {
  const { bridge } = ctx;
  const t = ctx.requestTimeoutMs;
  const warnings: string[] = [];
  const readBack: StepResult[] = [];
  const reports: CueReport[] = b.cues.map((c) => ({ cue: c.cue, status: "not_attempted", verification: unavailable("not attempted") }));
  const presets = new Map<string, { addrNative: string; label: string }>();
  let normalBefore: ProgrammerSnapshot | undefined;
  let existing: CueListEntry[] | null = null;

  // 1. Inspection: the sequence and its cues, every preset, attribute and fixture expression, the Normal programmer.
  const allLooks = b.cues.flatMap((c) => c.looks);
  const inspect = await runSteps([
    {
      name: "read_sequence",
      run: async () => {
        try {
          existing = await readCueList(bridge, b.sequence, t);
        } catch (err) {
          return asRead(stepFromError("read_sequence", err, { op: "children" }));
        }
        const have = new Set((existing ?? []).map((c) => c.no));
        const clash = b.cues.filter((c) => have.has(Number(c.cue))).map((c) => c.cue);
        if (b.mode === "create" && clash.length) return failedRead("read_sequence", `Sequence ${b.sequence} already has cue(s) ${clash.join(", ")}; nothing was sent. Use mode merge or overwrite, or other cue numbers`, { existing: clash });
        return asRead({ name: "read_sequence", status: "succeeded", op: "children", detail: { exists: existing !== null, cues: existing?.length ?? 0, ...(clash.length ? { replaced: clash } : {}) } });
      },
    },
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
      name: "read_normal_programmer",
      run: async () => {
        try {
          const env = await environmentOf(bridge, t);
          if (env.environment !== "Normal") return failedRead("read_normal_programmer", `the console is in the ${env.environment ?? "unknown"} environment; the cues are built in Preview and the build must start from Normal (gma3_phaser_release leaves Preview)`);
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
  const sequenceExisted = existing !== null;
  if (inspect.outcome !== "succeeded") {
    return { steps, readBack, warnings, cues: reports, sent: false, normalProgrammer: "not_entered", sequenceExisted, verification: unavailable("nothing was sent") };
  }

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
      else building = true;
    } else stopped = true;

    for (let i = 0; i < b.cues.length && !stopped; i++) {
      const c = b.cues[i];
      const report = reports[i];
      const pre = `cue ${c.cue}: `;
      const lookChecks: Verification[] = [];
      report.looks = [];
      const plan: Array<{ name: string; run: StepFn }> = [];
      if (i > 0) {
        // The programmer keeps the previous cue's values after its store. ClearAll only after Preview is confirmed.
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
      c.looks.forEach((look, j) => {
        const lp = `${pre}look ${j + 1} `;
        plan.push({ name: `${lp}clear_selection`, run: () => commandStep(bridge, `${lp}clear_selection`, "ClearSelection", t) });
        plan.push({ name: `${lp}select`, run: () => commandStep(bridge, `${lp}select`, look.fixtures, t) });
        look.presets.forEach((p) => plan.push({ name: `${lp}apply ${p.ref}`, run: () => commandStep(bridge, `${lp}apply ${p.ref}`, `At ${p.ref}`, t) }));
        if (look.intensity !== undefined) plan.push({ name: `${lp}intensity`, run: () => commandStep(bridge, `${lp}intensity`, `At ${formatValue(look.intensity as number)}`, t) });
        look.values.forEach((x) => plan.push({ name: `${lp}${x.attribute}`, run: () => commandStep(bridge, `${lp}${x.attribute}`, attributeCommand(x.attribute, x.value, x.unit ? ATTRIBUTE_UNITS[x.unit].keyword : undefined), t) }));
        if (b.verify) {
          plan.push({
            name: `${lp}check`,
            run: async () => {
              const parts: Verification[] = [];
              for (const p of look.presets) parts.push((await verifyPresetLink(bridge, presets.get(p.ref) as { addrNative: string; label: string }, readBack)).verification);
              const exp = expectationsOf(look);
              if (exp.length) parts.push((await verifyProgrammer(bridge, exp, readBack, warnings)).verification);
              const v = worst(parts, `look ${j + 1} on ${look.fixtures} in the programmer`);
              lookChecks.push(v);
              report.looks!.push({ fixtures: look.fixtures, presets: look.presets.map((p) => p.ref), verification: v.status, ...(v.detail ? { detail: v.detail } : {}) });
              if (v.status === "mismatched") return { name: `${lp}check`, kind: "read", status: "failed", op: "programmer", error: `the look did not apply, so cue ${c.cue} was not stored: ${v.detail}` };
              return asRead({ name: `${lp}check`, status: "succeeded", op: "programmer", detail: { verification: v.status } });
            },
          });
        }
      });
      plan.push({ name: `${pre}store`, run: () => commandStep(bridge, `${pre}store`, storeCommand(b.sequence, c.cue, b.mode), t) });
      const part0 = cueRef(b.sequence, c.cue, 0);
      const cueObj = cueRef(b.sequence, c.cue);
      if (c.name !== undefined) plan.push(setStep(bridge, `${pre}name`, part0, "Name", c.name, t));
      for (const [k, val] of Object.entries(c.timing) as Array<[keyof CueSpec["timing"], number]>) plan.push(setStep(bridge, `${pre}${k}`, part0, TIMING_PROPS[k], val, t));
      if (c.trigger) plan.push(setStep(bridge, `${pre}trigger`, cueObj, "TrigType", TRIGGERS[c.trigger], t));
      if (c.time !== undefined) plan.push(setStep(bridge, `${pre}trigger_time`, cueObj, "TrigTime", c.time, t));

      const run = await runSteps(plan);
      steps.push(...run.steps);
      const store = run.steps.find((s) => s.name === `${pre}store`);
      const bad = run.steps.find((s) => s.status !== "succeeded" && s.status !== "skipped");
      report.status = store?.status === "succeeded" ? (bad ? "failed" : "stored") : store?.status === "unknown" ? "unknown" : "failed";
      if (bad) report.error = `${bad.name}: ${bad.error ?? bad.status}`;
      report.verification = b.verify ? worst(lookChecks, "looks") : notRequested();
      if (bad) stopped = true;
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

  let normalProgrammer: BatchResult["normalProgrammer"] = entered ? "unknown" : "not_entered";
  if (entered && normalBefore) {
    try {
      const env = await environmentOf(bridge, t);
      const after = await snapshotProgrammer(bridge);
      if (env.environment === "Normal" && after.complete) normalProgrammer = sameProgrammer(normalBefore, after) ? "untouched" : "changed";
      steps.push(asRead({ name: "check_normal_programmer", status: normalProgrammer === "untouched" ? "succeeded" : "failed", op: "programmer", ...(normalProgrammer === "untouched" ? {} : { error: env.environment !== "Normal" ? `the console is in the ${env.environment ?? "unknown"} environment; run gma3_phaser_release` : !after.complete ? "the Normal programmer could not be read completely" : "the Normal programmer changed while the cues were built (another operator, or a command that reached Normal)" }) }));
    } catch (err) {
      steps.push(asRead(stepFromError("check_normal_programmer", err, { op: "programmer" })));
    }
  }

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
      if (r.status === "not_attempted" || (r.status === "failed" && !steps.some((s) => s.name === `cue ${c.cue}: store` && s.status === "succeeded"))) continue;
      const expected: Record<string, unknown> = { Name: c.name, ...(c.trigger ? { TrigType: TRIGGERS[c.trigger] } : {}), ...(c.time !== undefined ? { TrigTime: c.time } : {}) };
      const timingExpected: Record<string, unknown> = Object.fromEntries(Object.entries(c.timing).map(([k, val]) => [TIMING_PROPS[k as keyof CueSpec["timing"]], val]));
      const checked = `cue ${c.cue} exists${c.name !== undefined ? ", its name" : ""}${Object.keys(timingExpected).length ? ", its timing" : ""}${c.trigger ? ", its trigger" : ""}`;
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
  return { steps, readBack, warnings, cues: reports, sent: true, normalProgrammer, sequenceExisted, verification: overall };
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

export async function storeCues(ctx: ToolContext, raw: Record<string, unknown>): Promise<OperationResult> {
  const op = "store_cues";
  const v = new Validator();
  const sequence = v.check(() => objectNumber("sequence", raw.sequence));
  const mode = v.check(() => oneOf("mode", raw.mode, ["create", "merge", "overwrite"] as const));
  const sequenceName = v.check(() => objectName("sequence_name", raw.sequence_name, { optional: true }));
  const defaultFixtures = raw.fixtures === undefined ? undefined : v.check(() => fixtureSelection("fixtures", raw.fixtures));
  const cues = validateCues(v, raw.cues, defaultFixtures);
  if (raw.exclusive !== true) v.fail(EXCLUSIVE_REASON);
  const target = { sequence: raw.sequence, cues: cues.map((c) => c.cue), mode: raw.mode };
  if (!v.ok || sequence === undefined || !mode) return validationFailure(op, target, v.errors);
  return ctx.mutations.run(async () => {
    const r = await buildCueBatch(ctx, { sequence, sequenceName, mode, cues, verify: raw.verify !== false });
    return batchResult(op, { sequence, cues: cues.map((c) => c.cue), mode }, r, { sequenceExisted: r.sequenceExisted });
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
  const trig = validateTrigger(v, raw.trigger, raw.time, "");
  const timing: Partial<Record<TimingKey, number>> = validateTiming(v, raw, "");
  const snap = v.check(() => timeSeconds("snap_delay", raw.snap_delay, { optional: true }));
  if (snap !== undefined) timing.snap_delay = snap;
  let names: string[] | undefined;
  if (raw.names !== undefined) {
    if (!Array.isArray(raw.names) || raw.names.length === 0) v.fail("names must be a non-empty list (one per cue, in cue order)");
    else names = raw.names.map((n, i) => v.check(() => objectName(`names[${i}]`, n)) ?? "");
  }
  if (!trig.trigger && Object.keys(timing).length === 0 && !names) v.fail("give a trigger, timing (fade, delay, out_fade, out_delay, snap_delay) and/or names");
  const target = { sequence: raw.sequence, ...(cueList ? { cues: cueList } : raw.all ? { all: true } : { from: raw.from, to: raw.to }) };
  if (!v.ok || sequence === undefined) return validationFailure(op, target, v.errors);

  return ctx.mutations.run(async () => {
    let selected: CueListEntry[] = [];
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
            selected = pick.cues;
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
    if (inspect.outcome === "succeeded") {
      let stopped = false;
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
        if (trig.time !== undefined) plan.push(setStep(bridge, `${pre}trigger_time`, cueObj, "TrigTime", trig.time, t));
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
        const expected: Record<string, unknown> = { ...(names ? { Name: names[i] } : {}), ...(trig.trigger ? { TrigType: TRIGGERS[trig.trigger] } : {}), ...(trig.time !== undefined ? { TrigTime: trig.time } : {}) };
        const timingExpected = Object.fromEntries(Object.entries(timing).map(([k, val]) => [TIMING_PROPS[k as TimingKey], val]));
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
    const attempted = reports.filter((r) => r.status !== "not_attempted");
    const verification =
      raw.verify === false ? notRequested() : attempted.length === 0 ? unavailable("nothing was sent") : worst(attempted.map((r) => ({ ...r.verification, detail: r.verification.detail ? `cue ${r.cue}: ${r.verification.detail}` : undefined })), `${attempted.length} cue(s): the properties that were written`);
    const result = buildResult({ operation: op, target: { sequence, cues: selected.map((c) => fmtNo(c.no)) }, steps, verification, extra: { cues: reports, edited: reports.filter((r) => r.status === "stored").length } });
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
  if ((raw.steps === undefined) === (raw.presets === undefined)) v.fail("give exactly one of steps or presets");
  else if (raw.presets !== undefined) {
    if (!Array.isArray(raw.presets)) v.fail("presets must be a list");
    else rawSteps = raw.presets.map((p) => ({ presets: [p] }));
  } else if (!Array.isArray(raw.steps)) v.fail("steps must be a list");
  else rawSteps = raw.steps as Array<Record<string, unknown>>;
  if (rawSteps.length && (rawSteps.length < 2 || rawSteps.length > MAX_CUES)) v.fail(`a chase needs 2 to ${MAX_CUES} steps`);
  const stepS = v.check(() => finiteNumber("step_seconds", raw.step_seconds, { min: 0.2, max: 3600, optional: true }));
  const cycleS = v.check(() => finiteNumber("cycle_seconds", raw.cycle_seconds, { min: 0.4, max: 360000, optional: true }));
  if ((stepS === undefined) === (cycleS === undefined)) v.fail("give exactly one of step_seconds (time per cue) or cycle_seconds (time for the whole loop)");
  const fade = v.check(() => timeSeconds("fade", raw.fade, { optional: true }));
  const verify = raw.verify !== false;
  const observe = typeof raw.observe === "boolean" ? raw.observe : verify;
  const budget = v.check(() => finiteNumber("observe_max_seconds", raw.observe_max_seconds, { min: 5, max: OBSERVE_MAX_S, optional: true })) ?? OBSERVE_DEFAULT_S;
  const leaveRunning = raw.leave_running === true;
  if (raw.exclusive !== true) v.fail(EXCLUSIVE_REASON);
  const step = stepS ?? (cycleS !== undefined && rawSteps.length ? Number((cycleS / rawSteps.length).toFixed(3)) : 0);
  if (cycleS !== undefined && rawSteps.length && step < 0.2) v.fail(`cycle_seconds gives ${step} s per step; the minimum is 0.2 s`);
  const cues: CueSpec[] = [];
  rawSteps.forEach((s, i) => {
    const r = (s ?? {}) as Record<string, unknown>;
    const path = raw.presets !== undefined ? `presets[${i}]` : `steps[${i}]`;
    const looks = validateLooks(v, Object.fromEntries(Object.entries(r).filter(([k]) => k !== "name")), path, defaultFixtures);
    const stepName = v.check(() => objectName(`${path}.name`, r.name, { optional: true }));
    cues.push({ cue: String(i + 1), name: stepName, looks, timing: fade !== undefined ? { fade } : {}, trigger: "time", time: step });
  });
  const target = { sequence: raw.sequence, steps: rawSteps.length, stepSeconds: step };
  if (!v.ok || sequence === undefined) return validationFailure(op, target, v.errors);

  return ctx.mutations.run(async () => {
    // A chase is a whole sequence: refuse one that already has cues (stale cues past the last step would join the loop).
    const pre: StepResult[] = [];
    try {
      const list = await readCueList(bridge, sequence, t);
      if (list && list.length) {
        pre.push(failedRead("check_sequence_empty", `Sequence ${sequence} already has ${list.length} cue(s); a chase is built into an empty or new sequence (edit an existing one with gma3_store_cues mode overwrite and gma3_edit_cues). Nothing was sent`));
        return buildResult({ operation: op, target: { sequence }, steps: pre, verification: unavailable("nothing was sent") });
      }
      pre.push(asRead({ name: "check_sequence_empty", status: "succeeded", op: "children", detail: { exists: list !== null } }));
    } catch (err) {
      pre.push(asRead(stepFromError("check_sequence_empty", err, { op: "children" })));
      return buildResult({ operation: op, target: { sequence }, steps: pre, verification: unavailable("nothing was sent") });
    }
    const r = await buildCueBatch(ctx, { sequence, sequenceName: name, mode: "create", cues, verify });
    r.steps.unshift(...pre);
    const allStored = r.cues.every((c) => c.status === "stored");
    const extra: Record<string, unknown> = { stepSeconds: step, cycleSeconds: Number((step * cues.length).toFixed(3)) };
    if (!allStored) return batchResult(op, { sequence, steps: cues.length }, r, { ...extra, cycle: { watched: false, reason: "not every cue was stored" } });

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

const BUILD_NOTE =
  "Built in the console's Preview environment: its own programmer and selection, so nothing is output and the operator's Normal programmer is untouched (checked before and after). Each cue starts from an empty programmer (ClearAll, sent only in Preview), its looks are applied in order (presets, then intensity, then values; a later look wins on shared fixtures), each look is checked in the programmer (preset links, values per fixture and cell), then the cue is stored. " +
  "A look that did not apply stops the batch before that cue is stored; the cues already stored stay (nothing is undone or retried) and the result lists every cue with its status. A cue's stored values cannot be read back on 2.5.1; the cue's existence, name, timing and trigger are. A cue stored without a name takes the preset's name. Requires exclusive: true.";

export const registerCueListTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_store_cues",
    {
      title: "Store a list of cues from explicit content",
      description:
        "Store several cues of one sequence in one call, each from explicit content: a look (fixtures with presets, intensity and/or attribute values) or several looks, with an optional name, timing and trigger per cue. mode create refuses (nothing sent) when any of the cues exists; merge and overwrite store into existing cues. The store creates the sequence when it does not exist; sequence_name names it. " +
        BUILD_NOTE,
      inputSchema: {
        sequence: z.number().describe("Sequence number."),
        sequence_name: z.string().optional(),
        mode: z.enum(["create", "merge", "overwrite"]),
        fixtures: z.string().optional().describe("Default target for looks that do not name their own fixtures."),
        cues: z.array(z.object({ cue: z.union([z.number(), z.string()]), name: z.string().optional(), ...contentShape, ...timingShape, ...triggerShape })).describe(`1 to ${MAX_CUES} cues, stored in the order given.`),
        exclusive: z.boolean().optional().describe("Required (true)."),
        verify: z.boolean().optional(),
      },
    },
    (args) => operation(() => storeCues(ctx, args as Record<string, unknown>)),
  );

  server.registerTool(
    "gma3_edit_cues",
    {
      title: "Set trigger, timing and names on a range of cues",
      description:
        "Edit existing cues of a sequence in one call: the same trigger (TrigType/TrigTime), the same timing (Part 0 CueInFade, CueInDelay, CueOutFade, CueOutDelay, SnapDelay) and/or one name per cue. Choose the cues with exactly one of cues (a list), from/to (a range, either end optional) or all: true; names are given in cue order, one per cue. " +
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
        "Build a chase into an empty or new sequence: one cue per step (steps: each a look or looks with an optional name; or presets: one cue per preset on fixtures), every cue Time-triggered after step_seconds (or cycle_seconds / number of steps) with an optional crossfade, and Wrap Around on, so the last cue is followed by the first. " +
        BUILD_NOTE +
        " Then, unless observe: false, PLAYS the chase (Goto cue 1, live output) and samples its current cue to verify one cycle: the cue order through the wrap and each step against step_seconds / the sequence's rate. A cycle longer than observe_max_seconds (default 45, at most 120; keep it under your client's request timeout) is observed from a late cue through the wrap instead. The chase is switched off afterwards unless leave_running: true.",
      inputSchema: {
        sequence: z.number().describe("An empty or new sequence."),
        name: z.string().optional().describe("Sequence name."),
        fixtures: z.string().optional().describe("Target for every step that does not name its own fixtures."),
        presets: z.array(presetSchema).optional().describe("One cue per preset, on fixtures (instead of steps)."),
        steps: z.array(z.object({ name: z.string().optional(), ...contentShape })).optional().describe(`2 to ${MAX_CUES} steps, one cue each.`),
        step_seconds: z.number().optional().describe("Time per step (each cue's TrigTime), at least 0.2 s."),
        cycle_seconds: z.number().optional().describe("Time for the whole loop, divided over the steps (instead of step_seconds)."),
        fade: z.number().optional().describe("Crossfade per cue in seconds (CueInFade); it does not lengthen the step."),
        observe: z.boolean().optional().describe("Play the chase and verify one cycle (default: as verify, true)."),
        observe_max_seconds: z.number().optional(),
        leave_running: z.boolean().optional(),
        exclusive: z.boolean().optional().describe("Required (true)."),
        verify: z.boolean().optional(),
      },
    },
    (args) => operation(() => buildChase(ctx, args as Record<string, unknown>)),
  );
};
