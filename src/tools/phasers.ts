/**
 * SB-04: phasers and effect distributions.
 *
 *   gma3_build_phaser     build a phaser from structured steps (or a template), check it, store it as a preset and
 *                         read every step back; optionally audition it
 *   gma3_phaser_release   the stop/release path: leave an interrupted build (Preview) or stop an audition (Normal)
 *
 * The phaser is built in the console's Preview environment, which has its own programmer and selection, so the operator's
 * Normal programmer is never touched (it is fingerprinted before and after) and nothing is output while the effect is
 * built. Playback happens only with an explicit audition, in the Normal programmer, which must then be empty.
 *
 * Three different things are configured and kept apart in the request and the result:
 *   - step timing: per step width, transition, acceleration, deceleration (how a step moves to the next);
 *   - fixture distribution: the phase offset per fixture (phase from -> to over the selection grid, from > to runs the
 *     other way; repeat: groups / wings / blocks repeat the distribution along X, applied as selection MAtricks while the
 *     phase is set);
 *   - playback speed: speed (BPM), measure (beats per cycle), speed master.
 *
 * Console facts this module relies on (onPC 2.5.1, docs/probes/sb-04-phasers-macos-2.5.1.md):
 *   - `Step <n>` selects the step the next `At` writes; `At Width|Transition|Acceleration|Deceleration <v>` set the step
 *     layers of the current step, but only once the programmer has more than one step (a step layer set on the only
 *     step is ignored), so the steps are created first and their timing set afterwards; `At Speed <bpm>`, `At Phase <a> Thru <b>`, `At Measure <beats>`, `At SpeedMaster <n>`
 *     set the phaser layers of every active attribute (an `Attribute "X"` prefix would leave the rest of an activation
 *     group out of phase). GetProgPhaser reads speed in Hz, measure x100, the speed master 0-based, phase in degrees per
 *     fixture spread over the MAtricks-transformed grid position.
 *   - `At Relative|Absolute Physical <v>` take physical units (degrees); the programmer reads percent of the range.
 *   - A preset called into a step is that step's `integrated` reference; it is stored as a reference with /Embed "Yes".
 *   - `Attribute "Pan" At 50` on a fixture without Pan answers "OK" and does nothing: attributes are checked against every
 *     fixture before anything is sent.
 *   - `Preview On` switches to the Preview environment (own programmer and selection, empty); `ClearAll` there clears only
 *     that programmer; `Preview Off` returns to Normal with its programmer as it was. Blind keeps the Normal programmer
 *     and its state cannot be read, so it is not used.
 */
import { z } from "zod";
import { BridgeError, type Gma3Bridge } from "../bridge.js";
import { operation, type RegisterTools, type ToolContext } from "./context.js";
import { expandFixtures } from "./groups.js";
import { prepareStorePreset, presetId, ALL_POOLS, STEP_DEFAULTS, type ProgrammerRow, type PresetContext, type PresetRead } from "./presets.js";
import { formatValue } from "./fixtures.js";
import {
  asRead,
  buildResult,
  commandStep,
  notRequested,
  runSteps,
  stepFromError,
  validationFailure,
  type OperationResult,
  type StepResult,
  type Verification,
} from "../results.js";
import { ValidationError, Validator, attributeName, describe, finiteNumber, objectName, objectNumber } from "../validate.js";

// ---------------------------------------------------------------------------
// Request model
// ---------------------------------------------------------------------------

export type Unit = "percent" | "physical";

export interface StepValue {
  absolute?: number;
  relative?: number;
}

export interface Step {
  values: Record<string, StepValue>;
  preset?: { pool: number; number: number };
  width?: number;
  transition?: number;
  accel?: number;
  decel?: number;
}

export interface PhaserLayers {
  speedBpm?: number;
  phase?: { from: number; to: number };
  measure?: number;
  speedMaster?: number;
  repeat?: { kind: "groups" | "wings" | "blocks"; count: number };
}

export interface Effect {
  steps: Step[];
  phaser: PhaserLayers;
  unit: Unit;
}

const MAX_STEPS = 16;
const MAX_FIXTURES = 128;
const VALUE_TOLERANCE = 0.5;
const LAYER_TOLERANCE = 0.05;
const REPEAT_PROPERTY = { groups: "XGroup", wings: "XWings", blocks: "XBlock" } as const;

function num(field: string, v: unknown, min: number, max: number): number | undefined {
  if (v === undefined || v === null) return undefined;
  return finiteNumber(field, v, { min, max })!;
}

/** One step from the request: values per attribute (a number is absolute) and/or a preset, plus step timing. */
export function parseStep(field: string, raw: unknown, unit: Unit): Step {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError(`${field} must be an object with values and/or preset`, field);
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!["values", "preset", "width", "transition", "accel", "decel"].includes(k)) throw new ValidationError(`${field}.${k} is not a step setting (values, preset, width, transition, accel, decel)`, field);
  const values: Record<string, StepValue> = {};
  if (r.values !== undefined) {
    if (!r.values || typeof r.values !== "object" || Array.isArray(r.values)) throw new ValidationError(`${field}.values must map attribute names to a value or {absolute, relative}`, field);
    for (const [name, v] of Object.entries(r.values as Record<string, unknown>)) {
      const attr = attributeName(`${field}.values`, name);
      const lim = unit === "percent" ? { abs: [0, 100], rel: [-100, 100] } : { abs: [-1e6, 1e6], rel: [-1e6, 1e6] };
      if (typeof v === "number") values[attr] = { absolute: num(`${field}.values.${attr}`, v, lim.abs[0], lim.abs[1]) };
      else if (v && typeof v === "object" && !Array.isArray(v)) {
        const o = v as Record<string, unknown>;
        for (const k of Object.keys(o)) if (k !== "absolute" && k !== "relative") throw new ValidationError(`${field}.values.${attr}.${k}: only absolute and relative`, field);
        const sv: StepValue = { absolute: num(`${field}.values.${attr}.absolute`, o.absolute, lim.abs[0], lim.abs[1]), relative: num(`${field}.values.${attr}.relative`, o.relative, lim.rel[0], lim.rel[1]) };
        if (sv.absolute === undefined && sv.relative === undefined) throw new ValidationError(`${field}.values.${attr} needs absolute and/or relative`, field);
        values[attr] = sv;
      } else throw new ValidationError(`${field}.values.${attr} must be a number or {absolute, relative} (got ${describe(v)})`, field);
    }
  }
  const preset = r.preset === undefined ? undefined : presetId(`${field}.preset`, r.preset);
  if (!Object.keys(values).length && !preset) throw new ValidationError(`${field} needs values or a preset`, field);
  return {
    values,
    preset,
    width: num(`${field}.width`, r.width, 0, 10000),
    transition: num(`${field}.transition`, r.transition, 0, 100),
    accel: num(`${field}.accel`, r.accel, -1000, 1000),
    decel: num(`${field}.decel`, r.decel, -1000, 1000),
  };
}

export function parsePhaser(raw: unknown): PhaserLayers {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError("phaser must be an object", "phaser");
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!["speed_bpm", "phase", "measure", "speed_master", "repeat"].includes(k)) throw new ValidationError(`phaser.${k} is not a phaser setting (speed_bpm, phase, measure, speed_master, repeat)`, "phaser");
  const out: PhaserLayers = {
    speedBpm: num("phaser.speed_bpm", r.speed_bpm, 0.01, 6000),
    measure: num("phaser.measure", r.measure, 1, 1000),
    speedMaster: r.speed_master === undefined ? undefined : finiteNumber("phaser.speed_master", r.speed_master, { integer: true, min: 1, max: 16 }),
  };
  if (r.phase !== undefined) {
    const p = r.phase as Record<string, unknown>;
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new ValidationError("phaser.phase must be {from, to} in degrees", "phaser.phase");
    out.phase = { from: num("phaser.phase.from", p.from, -3600, 3600)!, to: num("phaser.phase.to", p.to, -3600, 3600)! };
    if (out.phase.from === undefined || out.phase.to === undefined) throw new ValidationError("phaser.phase needs from and to", "phaser.phase");
  }
  if (r.repeat !== undefined) {
    const rp = r.repeat as Record<string, unknown>;
    const keys = rp && typeof rp === "object" ? Object.keys(rp) : [];
    if (keys.length !== 1 || !["groups", "wings", "blocks"].includes(keys[0])) throw new ValidationError("phaser.repeat must be exactly one of {groups: n}, {wings: n}, {blocks: n}", "phaser.repeat");
    out.repeat = { kind: keys[0] as "groups" | "wings" | "blocks", count: finiteNumber(`phaser.repeat.${keys[0]}`, rp[keys[0]], { integer: true, min: 2, max: 64 })! };
    if (!out.phase) throw new ValidationError("phaser.repeat distributes the phase: give phaser.phase too", "phaser.repeat");
  }
  return out;
}

/** The three templates the acceptance criteria name, expanded into a reviewable effect. */
export function expandTemplate(raw: unknown, fixtureCount: number): Effect {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError("template must be an object with a type", "template");
  const t = raw as Record<string, unknown>;
  const spread = (on: unknown) => (on === false || fixtureCount < 2 ? undefined : { from: 0, to: Math.round((360 * (fixtureCount - 1)) / fixtureCount * 1000) / 1000 });
  switch (t.type) {
    case "dimmer_chase": {
      const on = num("template.on", t.on, 0, 100) ?? 100;
      const off = num("template.off", t.off, 0, 100) ?? 0;
      return {
        unit: "percent",
        steps: [{ values: { Dimmer: { absolute: on } }, transition: 0 }, { values: { Dimmer: { absolute: off } }, transition: 0 }],
        phaser: { speedBpm: num("template.speed_bpm", t.speed_bpm, 0.01, 6000) ?? 120, phase: spread(t.spread) },
      };
    }
    case "alternating_colors": {
      if (!Array.isArray(t.colors) || t.colors.length !== 2) throw new ValidationError("template.colors must be two colours, each {red, green, blue} in percent or {preset: \"4.n\"}", "template.colors");
      if (fixtureCount < 2) throw new ValidationError("alternating colours need at least two fixtures", "template");
      const steps = (t.colors as unknown[]).map((c, i): Step => {
        const o = c as Record<string, unknown>;
        if (o && typeof o === "object" && "preset" in o) return { values: {}, preset: presetId(`template.colors[${i}].preset`, o.preset), transition: t.snap === true ? 0 : undefined };
        if (!o || typeof o !== "object") throw new ValidationError(`template.colors[${i}] must be {red, green, blue} or {preset}`, "template.colors");
        return {
          values: { ColorRGB_R: { absolute: num(`template.colors[${i}].red`, o.red, 0, 100) ?? 0 }, ColorRGB_G: { absolute: num(`template.colors[${i}].green`, o.green, 0, 100) ?? 0 }, ColorRGB_B: { absolute: num(`template.colors[${i}].blue`, o.blue, 0, 100) ?? 0 } },
          transition: t.snap === true ? 0 : undefined,
        };
      });
      return { unit: "percent", steps, phaser: { speedBpm: num("template.speed_bpm", t.speed_bpm, 0.01, 6000) ?? 60, phase: { from: 0, to: 180 }, repeat: { kind: "groups", count: 2 } } };
    }
    case "pan_tilt": {
      const pan = num("template.pan", t.pan, -540, 540) ?? 20;
      const tilt = num("template.tilt", t.tilt, -270, 270) ?? 20;
      const smooth = { accel: -100, decel: -100 };
      return {
        unit: "physical",
        steps: [
          { values: { Pan: { relative: pan }, Tilt: { relative: 0 } }, ...smooth },
          { values: { Pan: { relative: 0 }, Tilt: { relative: tilt } }, ...smooth },
          { values: { Pan: { relative: -pan }, Tilt: { relative: 0 } }, ...smooth },
          { values: { Pan: { relative: 0 }, Tilt: { relative: -tilt } }, ...smooth },
        ],
        phaser: { speedBpm: num("template.speed_bpm", t.speed_bpm, 0.01, 6000) ?? 20, phase: t.spread === true ? spread(true) : undefined },
      };
    }
    default:
      throw new ValidationError(`template.type must be dimmer_chase, alternating_colors or pan_tilt (got ${describe(t.type)})`, "template");
  }
}

/** Every attribute the effect writes. */
export const effectAttributes = (e: Effect) => [...new Set(e.steps.flatMap((s) => Object.keys(s.values)))];

/** The console commands that build the effect on a selection, in order. */
export function effectCommands(e: Effect): string[] {
  const out: string[] = [];
  const kw = e.unit === "physical" ? " Physical" : "";
  e.steps.forEach((s, i) => {
    out.push(`Step ${i + 1}`);
    if (s.preset) out.push(`At Preset ${s.preset.pool}.${s.preset.number}`);
    for (const [attr, v] of Object.entries(s.values)) {
      if (v.absolute !== undefined) out.push(`Attribute "${attr}" At Absolute${kw} ${formatValue(v.absolute)}`);
      if (v.relative !== undefined) out.push(`Attribute "${attr}" At Relative${kw} ${formatValue(v.relative)}`);
    }
  });
  // Step timing only after every step exists: a step layer set while the programmer has a single step is ignored.
  e.steps.forEach((s, i) => {
    const layers: string[] = [];
    if (s.width !== undefined) layers.push(`At Width ${formatValue(s.width)}`);
    if (s.transition !== undefined) layers.push(`At Transition ${formatValue(s.transition)}`);
    if (s.accel !== undefined) layers.push(`At Acceleration ${formatValue(s.accel)}`);
    if (s.decel !== undefined) layers.push(`At Deceleration ${formatValue(s.decel)}`);
    if (layers.length) out.push(`Step ${i + 1}`, ...layers);
  });
  const p = e.phaser;
  if (p.repeat) out.push(`Set Selection MAtricks "${REPEAT_PROPERTY[p.repeat.kind]}" ${p.repeat.count}`);
  if (p.speedBpm !== undefined) out.push(`At Speed ${formatValue(p.speedBpm)}`);
  if (p.phase) out.push(`At Phase ${formatValue(p.phase.from)} Thru ${formatValue(p.phase.to)}`);
  if (p.measure !== undefined) out.push(`At Measure ${formatValue(p.measure)}`);
  if (p.speedMaster !== undefined) out.push(`At SpeedMaster ${p.speedMaster}`);
  if (p.repeat) out.push("Reset Selection MAtricks");
  out.push("Step 1");
  return out;
}

// ---------------------------------------------------------------------------
// Verification of the built programmer (pure, unit-tested)
// ---------------------------------------------------------------------------

interface BuildRow extends ProgrammerRow {
  physicalFrom?: number | null;
  physicalTo?: number | null;
  readout?: string | null;
  phaser?: ProgrammerRow["phaser"] & { gridPosMatricks?: number | null; gridPos?: number | null };
}

function expectedPercent(v: number, kind: "absolute" | "relative", unit: Unit, row: BuildRow): number | string {
  if (unit === "percent") return v;
  const from = row.physicalFrom;
  const to = row.physicalTo;
  if (typeof from !== "number" || typeof to !== "number" || to === from) return `the physical range of ${row.attribute} is unknown`;
  // A relative value is a share of the range's size: a fixture with a reversed range (from > to) still reads +30° as
  // a positive percentage (Thrill Mini Profile Pan, SB-04 probe).
  return kind === "absolute" ? ((v - from) / (to - from)) * 100 : (v / Math.abs(to - from)) * 100;
}

const near = (a: unknown, b: unknown, tol: number) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= tol;

/**
 * The phase a fixture gets: from -> to over its position k of n along grid X, with the repetition applied as the
 * selection MAtricks does it (SB-02: groups repeat every g, wings mirror within each wing, blocks hold b together).
 */
export function expectedPhase(phase: { from: number; to: number }, k: number, n: number, repeat?: PhaserLayers["repeat"]): number {
  let idx = k;
  let span = n;
  if (repeat?.kind === "groups") { idx = k % repeat.count; span = Math.min(repeat.count, n); }
  else if (repeat?.kind === "wings") {
    const size = Math.ceil(n / repeat.count);
    const pos = k % size;
    idx = Math.floor(k / size) % 2 === 1 ? size - 1 - pos : pos;
    span = size;
  } else if (repeat?.kind === "blocks") { idx = Math.floor(k / repeat.count); span = Math.ceil(n / repeat.count); }
  return span > 1 ? phase.from + ((phase.to - phase.from) * idx) / (span - 1) : phase.from;
}

/**
 * Compare the programmer the build produced with the effect: every scope fixture has every requested attribute with
 * the right number of steps, values, step layers, step presets and phaser layers; the phase spreads from -> to over the
 * transformed grid positions. `implied` attributes (activation-group siblings) may be present; anything else may not.
 */
export function verifyBuild(input: { effect: Effect; rows: BuildRow[]; scope: Map<number, string>; implied: Set<string>; stepPresets: Array<string | undefined> }): { problems: string[]; implied: string[] } {
  const { effect } = input;
  const problems: string[] = [];
  const attrs = effectAttributes(effect);
  const n = effect.steps.length;
  const implied = new Set<string>();
  for (const r of input.rows) {
    const a = String(r.attribute);
    if (!input.scope.has(r.subfixtureIndex)) { problems.push(`unexpected programmer value on subfixture ${r.subfixtureIndex} ${a}`); continue; }
    if (!attrs.includes(a)) {
      if (input.implied.has(a) || effect.steps.some((s) => s.preset)) implied.add(a);
      else problems.push(`unexpected attribute ${a} on ${input.scope.get(r.subfixtureIndex)}`);
    }
  }
  const bySf = new Map<number, BuildRow[]>();
  for (const r of input.rows) bySf.set(r.subfixtureIndex, [...(bySf.get(r.subfixtureIndex) ?? []), r]);
  // Grid X positions of the scope (the raw position: the MAtricks used while the phase was set is reset by then).
  const posOf = new Map<number, number>();
  for (const r of input.rows) if (input.scope.has(r.subfixtureIndex) && typeof r.phaser?.gridPos === "number") posOf.set(r.subfixtureIndex, r.phaser.gridPos);
  const positions = [...posOf.values()];
  const minPos = positions.length ? Math.min(...positions) : 0;
  const span = positions.length ? Math.max(...positions) - minPos + 1 : 1;
  for (const [sf, id] of input.scope) {
    const rows = bySf.get(sf) ?? [];
    if (!rows.length) { problems.push(`${id}: no programmer value (the effect was not applied)`); continue; }
    // Every attribute of the effect on this fixture: the explicit ones and those that came with a step preset or an
    // activation group. All of them carry the step timing and phaser layers; values are checked where they were given.
    for (const attr of [...new Set([...attrs, ...rows.map((x) => String(x.attribute))])]) {
      const r = rows.find((x) => x.attribute === attr);
      const where = `${id} ${attr}`;
      if (!r) { problems.push(`${where}: no programmer value (the attribute was not applied)`); continue; }
      if ((r.stepCount ?? 1) !== n) { problems.push(`${where}: ${r.stepCount ?? 1} steps, ${n} expected`); continue; }
      effect.steps.forEach((s, i) => {
        const st = r.steps?.[i];
        if (!st) { problems.push(`${where}: step ${i + 1} not read`); return; }
        const v = s.values[attr];
        for (const kind of ["absolute", "relative"] as const) {
          if (v?.[kind] === undefined) continue;
          const want = expectedPercent(v[kind]!, kind, effect.unit, r);
          if (typeof want === "string") problems.push(`${where} step ${i + 1}: ${want}`);
          else if (!near(st[kind], want, VALUE_TOLERANCE)) problems.push(`${where} step ${i + 1}: ${kind} ${formatValue(want)} % expected, ${st[kind] ?? "none"} read`);
        }
        for (const [k, layer] of [["width", "width"], ["transition", "trans"], ["accel", "accel"], ["decel", "decel"]] as const) {
          const want = s[k] ?? STEP_DEFAULTS[layer];
          const got = st[layer] ?? STEP_DEFAULTS[layer];
          if (!near(got, want, LAYER_TOLERANCE + Math.abs(want) * 1e-6)) problems.push(`${where} step ${i + 1}: ${k} ${want} expected, ${got} read`);
        }
      });
      const ph = effect.phaser;
      if (ph.speedBpm !== undefined && !near((r.phaser?.speed ?? NaN) * 60, ph.speedBpm, 0.05)) problems.push(`${where}: speed ${ph.speedBpm} BPM expected, ${r.phaser?.speed === undefined || r.phaser?.speed === null ? "none" : `${formatValue(r.phaser.speed * 60)} BPM`} read`);
      if (ph.measure !== undefined && !near((r.phaser?.measure ?? NaN) / 100, ph.measure, 0.01)) problems.push(`${where}: measure ${ph.measure} expected, ${r.phaser?.measure ?? "none"} read`);
      if (ph.speedMaster !== undefined && (r.phaser?.speedMaster ?? -1) + 1 !== ph.speedMaster) problems.push(`${where}: speed master ${ph.speedMaster} expected, ${(r.phaser?.speedMaster ?? null) === null ? "none" : (r.phaser!.speedMaster as number) + 1} read`);
      if (ph.phase) {
        const pos = posOf.get(sf);
        if (pos === undefined) { problems.push(`${where}: the grid position was not read, so the phase cannot be checked`); continue; }
        const want = expectedPhase(ph.phase, pos - minPos, span, ph.repeat);
        if (!near(r.phaser?.phase, want, 0.05)) problems.push(`${where}: phase ${formatValue(want)}° expected (grid position ${pos - minPos} of ${span}${ph.repeat ? `, ${ph.repeat.kind} ${ph.repeat.count}` : ""}), ${r.phaser?.phase ?? "none"} read`);
      }
    }
  }
  // A step that calls a preset: every fixture references it in that step (on the preset's attributes), none another.
  input.stepPresets.forEach((sp, i) => {
    if (!sp) return;
    for (const [sf, id] of input.scope) {
      const refs = (bySf.get(sf) ?? []).map((r) => r.steps?.[i]?.integratedPreset?.addrNative).filter((x): x is string => !!x);
      if (!refs.includes(sp)) problems.push(`${id} step ${i + 1}: the preset reference ${sp} is missing (${refs.length ? refs.join(", ") : "none"})`);
      const other = refs.filter((x) => x !== sp);
      if (other.length) problems.push(`${id} step ${i + 1}: references ${[...new Set(other)].join(", ")} instead of ${sp}`);
    }
  });
  return { problems: problems.slice(0, 20), implied: [...implied] };
}

// ---------------------------------------------------------------------------
// Bridge helpers
// ---------------------------------------------------------------------------

interface Scan {
  environment?: string;
  rows: BuildRow[];
  total: number;
  coverage?: { complete?: boolean };
  stats?: { channelErrors?: number };
  limitations?: string[];
}

const NEEDS_BRIDGE = "the console runs an older bridge plugin (bridge 0.23.0 reports the programmer's environment and phaser step layers); update the plugin";

async function scan(bridge: Gma3Bridge, t: number): Promise<Scan> {
  const s = (await bridge.request("programmer", { scope: "all", limit: 5000, maxChannels: 50000 }, t)) as Scan;
  if (s.environment === undefined) throw new Error(NEEDS_BRIDGE);
  const limits = (s.limitations ?? []).filter((l) => !/activity masks zero/.test(String(l)));
  if (s.coverage?.complete !== true || (s.stats?.channelErrors ?? 0) > 0 || limits.length || s.total > s.rows.length) throw new Error("the programmer scan was incomplete");
  return s;
}

/** A comparable fingerprint of programmer content (row identity, values, steps, layers). */
export function fingerprint(rows: ProgrammerRow[]): string {
  return rows
    .map((r) =>
      JSON.stringify([
        r.subfixtureIndex, r.attribute, r.value ?? null, r.relative ?? null, r.stepCount ?? 1,
        (r.steps ?? []).map((s) => [s.absolute ?? null, s.relative ?? null, s.accel ?? null, s.decel ?? null, s.trans ?? null, s.width ?? null, s.integratedPreset?.addrNative ?? s.integratedPreset?.name ?? null]),
        r.phaser?.speed ?? null, r.phaser?.phase ?? null, r.phaser?.measure ?? null, r.phaser?.speedMaster ?? null, r.phaser?.fade ?? null, r.phaser?.delay ?? null,
        r.absPreset?.addrNative ?? r.absPreset?.name ?? null, r.relPreset?.addrNative ?? r.relPreset?.name ?? null,
      ]),
    )
    .sort()
    .join("\n");
}

function failed(name: string, error: string, detail?: unknown): StepResult {
  return asRead({ name, status: "failed", error, ...(detail !== undefined ? { detail } : {}) });
}

function readStepFromError(name: string, op: string, err: unknown): StepResult {
  const s = asRead(stepFromError(name, err, { op }));
  if (err instanceof BridgeError && /unknown op/.test(err.message)) s.error = `${s.error}: ${NEEDS_BRIDGE}`;
  return s;
}

/** Run commands in order as one step; the first answer that is not OK stops it. */
async function commandsStep(bridge: Gma3Bridge, name: string, commands: string[], t: number): Promise<StepResult> {
  let sent = 0;
  for (const c of commands) {
    const s = await commandStep(bridge, name, c, t);
    if (s.status !== "succeeded") return { ...s, name, detail: { commandsSent: sent, commands: commands.length, failedCommand: c }, error: `${c}: ${s.error}` };
    sent++;
  }
  return { name, status: "succeeded", op: "cmd", detail: { commands } };
}

// ---------------------------------------------------------------------------
// gma3_build_phaser
// ---------------------------------------------------------------------------

interface BuildArgs {
  preset: string;
  fixtures?: unknown[];
  group?: number;
  steps?: unknown[];
  phaser?: unknown;
  template?: unknown;
  unit?: Unit;
  mode?: "selective" | "global";
  existing?: "refuse" | "merge" | "overwrite";
  name?: string;
  audition_ms?: number;
  exclusive?: boolean;
  preview?: boolean;
  verify?: boolean;
}

interface Member {
  id: string;
  sfIndex: number;
  ref: string;
  x: number;
}

export async function buildPhaser(ctx: ToolContext, raw: BuildArgs): Promise<OperationResult> {
  const op = "build_phaser";
  const v = new Validator();
  const target: Record<string, unknown> = { preset: raw.preset };
  const id = v.check(() => presetId("preset", raw.preset));
  let ids: string[] = [];
  if ((raw.fixtures === undefined) === (raw.group === undefined)) v.fail("give exactly one of fixtures (ids or ranges, distributed in list order) or group (a stored group, distributed over its grid)");
  else if (raw.fixtures !== undefined) {
    if (!Array.isArray(raw.fixtures) || raw.fixtures.length === 0) v.fail("fixtures must be a non-empty list");
    else raw.fixtures.forEach((f, i) => { const x = v.check(() => expandFixtures(`fixtures[${i}]`, f)); if (x) ids.push(...x); });
    ids = [...new Set(ids)];
    if (ids.length > MAX_FIXTURES) v.fail(`at most ${MAX_FIXTURES} fixtures`);
  }
  const group = raw.group === undefined ? undefined : v.check(() => objectNumber("group", raw.group, { max: 9999 }));
  const unit: Unit = raw.unit ?? "percent";
  if (unit !== "percent" && unit !== "physical") v.fail("unit must be percent or physical");
  const mode = raw.mode ?? "selective";
  if (mode !== "selective" && mode !== "global") v.fail("mode must be selective or global (universal data keeps one value per attribute and cannot hold per-fixture phase)");
  const existing = raw.existing ?? "refuse";
  if (!["refuse", "merge", "overwrite"].includes(existing)) v.fail("existing must be refuse, merge or overwrite");
  const name = v.check(() => objectName("name", raw.name, { optional: true }));
  const audition = raw.audition_ms === undefined ? 0 : v.check(() => finiteNumber("audition_ms", raw.audition_ms, { integer: true, min: 0, max: 30000 })) ?? 0;
  const preview = raw.preview === true;
  const verify = raw.verify !== false;
  if (audition > 0 && !verify) v.fail("audition_ms needs verify: only an effect whose read-back matched is played");
  if (!preview && raw.exclusive !== true) v.fail("exclusive must be true: the tool switches the console to its Preview environment to build the effect and stores a preset; nobody else may use the console while it runs. preview: true needs no acknowledgement");
  let effect: Effect | undefined;
  if ((raw.template === undefined) === (raw.steps === undefined)) v.fail("give exactly one of steps (with phaser) or template");
  else if (raw.template !== undefined) {
    if (raw.phaser !== undefined || raw.unit !== undefined) v.fail("a template sets its own phaser and unit; to change them, expand it with preview and pass steps and phaser");
    if (group !== undefined) v.fail("templates take fixtures (their spread depends on the fixture count); for a group pass steps and phaser");
    effect = v.check(() => expandTemplate(raw.template, ids.length));
  } else {
    if (!Array.isArray(raw.steps) || raw.steps.length < 2 || raw.steps.length > MAX_STEPS) v.fail(`steps must hold 2-${MAX_STEPS} steps (a phaser has at least two)`);
    else {
      const steps = raw.steps.map((s, i) => v.check(() => parseStep(`steps[${i}]`, s, unit)));
      const phaser = v.check(() => parsePhaser(raw.phaser));
      if (steps.every((s): s is Step => !!s) && phaser) effect = { steps, phaser, unit };
    }
  }
  if (!v.ok || !id || !effect) return validationFailure(op, target, v.errors);
  const ref = `Preset ${id.pool}.${id.number}`;
  target.presetRef = ref;
  const bridge = ctx.bridge;
  const t = ctx.requestTimeoutMs;
  const attrs = effectAttributes(effect);
  const commands = effectCommands(effect);
  const plan = {
    steps: effect.steps.map((s, i) => ({ step: i + 1, values: s.values, ...(s.preset ? { preset: `${s.preset.pool}.${s.preset.number}` } : {}), stepTiming: { width: s.width ?? STEP_DEFAULTS.width, transition: s.transition ?? STEP_DEFAULTS.trans, accel: s.accel ?? STEP_DEFAULTS.accel, decel: s.decel ?? STEP_DEFAULTS.decel } })),
    distribution: effect.phaser.phase ? { phase: effect.phaser.phase, direction: effect.phaser.phase.to >= effect.phaser.phase.from ? "forward" : "reverse", ...(effect.phaser.repeat ? { repeat: effect.phaser.repeat } : {}) } : null,
    playbackSpeed: { speedBpm: effect.phaser.speedBpm ?? null, measure: effect.phaser.measure ?? null, speedMaster: effect.phaser.speedMaster ?? null },
    unit: effect.unit,
    commands,
  };

  const body = async (): Promise<OperationResult> => {
    const members: Member[] = [];
    let normalBefore: Scan | null = null;
    const stepPresets: Array<string | undefined> = [];
    const implied = new Set<string>();
    const warnings: string[] = [];
    const inspect = await runSteps([
      {
        name: "read_context",
        run: async () => {
          try {
            const c = (await bridge.request("preset.context", { pool: id.pool }, t)) as PresetContext;
            if (!c.pool?.exists) return failed("read_context", `preset pool ${id.pool} does not exist`);
            const look = String(c.preferences?.StoreLook ?? "").trim().toLowerCase();
            if (look !== "no" && look !== "off") return failed("read_context", `the operator's StoreLook store preference is ${JSON.stringify(c.preferences?.StoreLook)}; a store would take every fixture with an open dimmer`);
            if (!ALL_POOLS.includes(id.pool) && String(c.preferences?.PresetInputFilter ?? "").toLowerCase() === "yes") warnings.push(`Preset pool ${id.pool} is a feature-group pool with the input filter on: attributes of other feature groups would be refused by the store; an All pool (21-25) takes any effect`);
            const p = await bridge.request("preset.read", { ref }, t).catch((err: unknown) => (err instanceof BridgeError && /no objects? found/i.test(err.message) ? null : Promise.reject(err)));
            const pr = p as PresetRead | null;
            if (pr) {
              if (String(pr.lock ?? "").trim() !== "") return failed("read_context", `${ref} is locked`);
              if (existing === "refuse") return failed("read_context", `${ref} already exists; pass existing: "merge" or "overwrite"`);
            }
            return asRead({ name: "read_context", status: "succeeded", op: "preset.context", detail: { exists: !!pr } });
          } catch (err) {
            return readStepFromError("read_context", "preset.context", err);
          }
        },
      },
      {
        name: "resolve_fixtures",
        run: async () => {
          try {
            if (group !== undefined) {
              let g: { items: Array<{ fixture?: string | null; addr?: string | null; sfIndex?: number; x?: number; unreadable?: boolean }> };
              try {
                g = (await bridge.request("group.read", { ref: `Group ${group}` }, t)) as typeof g;
              } catch (err) {
                if (err instanceof BridgeError && /no objects? found/i.test(err.message)) return failed("resolve_fixtures", `Group ${group} does not exist`);
                throw err;
              }
              for (const it of g.items) {
                // Members are resolved by fixture id: a numeric Addr() path does not resolve back through FromAddr.
                if (it.unreadable || !it.fixture || typeof it.sfIndex !== "number") return failed("resolve_fixtures", `Group ${group} holds an item without a fixture id; it cannot be checked`);
                members.push({ id: it.fixture, sfIndex: it.sfIndex, ref: `Fixture ${it.fixture}`, x: it.x ?? 0 });
              }
              if (members.length === 0) return failed("resolve_fixtures", `Group ${group} is empty`);
            } else {
              for (const [i, fid] of ids.entries()) members.push({ id: fid, sfIndex: -1, ref: `Fixture ${fid}`, x: i });
            }
            if (effect.steps.some((s) => s.preset) === false && members.length > MAX_FIXTURES) return failed("resolve_fixtures", `at most ${MAX_FIXTURES} fixtures`);
            const missing: string[] = [];
            const unsupported: string[] = [];
            for (const m of members) {
              let fa: { subfixtureIndex?: number; attributes?: Array<{ attribute?: string; activationGroup?: string }> };
              try {
                fa = (await bridge.request("fixtureAttributes", { ref: m.ref, limit: 500 }, t)) as typeof fa;
              } catch (err) {
                if (err instanceof BridgeError && /no objects? found|no object at address/i.test(err.message)) { missing.push(m.id); continue; }
                throw err;
              }
              if (typeof fa.subfixtureIndex === "number") m.sfIndex = fa.subfixtureIndex;
              const have = new Map((fa.attributes ?? []).map((a) => [String(a.attribute), a.activationGroup]));
              const lacking = attrs.filter((a) => !have.has(a));
              if (lacking.length) unsupported.push(`${m.id} has no ${lacking.join(", ")}`);
              for (const a of attrs) {
                const ag = have.get(a);
                if (ag) for (const [other, og] of have) if (og === ag && other !== a) implied.add(other);
              }
            }
            if (missing.length) return failed("resolve_fixtures", `not in the patch: ${missing.join(", ")}`);
            if (unsupported.length) return failed("resolve_fixtures", `unsupported attributes for this selection (the console would answer OK and ignore them): ${unsupported.join("; ")}`, { unsupported });
            return asRead({ name: "resolve_fixtures", status: "succeeded", op: "fixtureAttributes", detail: { fixtures: members.length, implied: [...implied] } });
          } catch (err) {
            return readStepFromError("resolve_fixtures", "fixtureAttributes", err);
          }
        },
      },
      {
        name: "check_step_presets",
        run: async () => {
          try {
            for (const s of effect.steps) {
              if (!s.preset) { stepPresets.push(undefined); continue; }
              const r = `Preset ${s.preset.pool}.${s.preset.number}`;
              const p = await bridge.request("preset.read", { ref: r }, t).catch((err: unknown) => (err instanceof BridgeError && /no objects? found/i.test(err.message) ? null : Promise.reject(err)));
              if (!p) return failed("check_step_presets", `${r} (a step preset) does not exist`);
              stepPresets.push((p as PresetRead).addrNative);
            }
            return asRead({ name: "check_step_presets", status: "succeeded", op: "preset.read" });
          } catch (err) {
            return readStepFromError("check_step_presets", "preset.read", err);
          }
        },
      },
      {
        name: "read_normal_programmer",
        run: async () => {
          try {
            normalBefore = await scan(bridge, t);
          } catch (err) {
            return readStepFromError("read_normal_programmer", "programmer", err);
          }
          const nb = normalBefore as Scan;
          if (nb.environment !== "Normal") return failed("read_normal_programmer", `the console is in the ${nb.environment} environment; the tool builds in Preview and must start from Normal (gma3_phaser_release leaves Preview)`);
          if (audition > 0 && nb.rows.length) return failed("read_normal_programmer", `audition_ms needs an empty Normal programmer (it holds ${nb.rows.length} value(s)); clear it or omit audition_ms`);
          return asRead({ name: "read_normal_programmer", status: "succeeded", op: "programmer", detail: { environment: nb.environment, values: nb.rows.length } });
        },
      },
    ]);
    const extra: Record<string, unknown> = { plan, fixtures: members.map((m) => m.id) };
    if (inspect.outcome !== "succeeded") {
      return buildResult({ operation: op, target, steps: inspect.steps, summary: `${op} was not performed; nothing was sent: ${inspect.steps.find((s) => s.status !== "succeeded")?.error ?? "inspection failed"}`, warnings, extra });
    }
    if (preview) {
      return buildResult({ operation: op, target, steps: inspect.steps, summary: `Preview only; nothing was sent. ${effect.steps.length} steps on ${members.length} fixture(s) would be built in the Preview environment and stored into ${ref}.`, warnings, extra: { ...extra, preview: true } });
    }

    const steps: StepResult[] = [...inspect.steps];
    const scope = new Map(members.map((m) => [m.sfIndex, m.id]));
    let entered = false;
    let built: { problems: string[]; implied: string[] } | null = null;
    let storeResult: OperationResult | null = null;
    try {
      const enter = await commandStep(bridge, "preview_on", "Preview On", t);
      steps.push(enter);
      entered = enter.status === "succeeded" || enter.status === "unknown";
      if (enter.status === "succeeded") {
        const main = await runSteps([
          {
            name: "check_preview",
            run: async () => {
              try {
                const s = await scan(bridge, t);
                if (s.environment !== "Preview") return failed("check_preview", `the console reports the ${s.environment} environment after Preview On`);
                if (s.rows.length) return failed("check_preview", `the Preview programmer is not empty (${s.rows.length} value(s)); nothing was built`);
                return asRead({ name: "check_preview", status: "succeeded", op: "programmer" });
              } catch (err) {
                return readStepFromError("check_preview", "programmer", err);
              }
            },
          },
          {
            name: "select",
            run: () => commandsStep(bridge, "select", group !== undefined ? ["ClearSelection", "Grid 0/0/0", `Group ${group}`] : ["ClearSelection", ...members.flatMap((m) => [`Grid ${m.x}/0/0`, m.ref])], t),
          },
          { name: "build", run: () => commandsStep(bridge, "build", commands, t) },
          {
            name: "check_build",
            run: async () => {
              try {
                const s = await scan(bridge, t);
                built = verifyBuild({ effect, rows: s.rows, scope, implied, stepPresets });
                if (built.problems.length) return failed("check_build", `the built phaser does not match the request: ${built.problems.join("; ")}`, { problems: built.problems });
                return asRead({ name: "check_build", status: "succeeded", op: "programmer", detail: { values: s.rows.length, implied: built.implied } });
              } catch (err) {
                return readStepFromError("check_build", "programmer", err);
              }
            },
          },
          {
            name: "store",
            run: async () => {
              const p = prepareStorePreset(ctx, {
                preset: `${id.pool}.${id.number}`,
                fixtures: members.map((m) => m.id),
                mode,
                existing,
                layers: ["absolute", "relative", "phaser"],
                embed: stepPresets.some((x) => x),
                name,
                exclusive: true,
                verify,
                environment: "Preview",
              });
              storeResult = "operation" in p ? p : await p.body();
              const r = storeResult as OperationResult;
              const ok = r.outcome === "succeeded" && r.verification.status !== "mismatched";
              return { name: "store", status: ok ? "succeeded" : r.outcome === "unknown" ? "unknown" : "failed", op: "gma3_store_preset", detail: { outcome: r.outcome, verification: r.verification.status }, ...(ok ? {} : { error: r.summary }) };
            },
          },
        ]);
        steps.push(...main.steps);
      }
    } finally {
      // Leave the Preview environment whatever happened, once it may have been entered. ClearAll is sent only after
      // the console confirms it is in Preview: in Normal it would discard the operator's programmer.
      if (entered) {
        let env: string | undefined;
        try {
          env = (await scan(bridge, t)).environment;
        } catch {
          env = undefined;
        }
        steps.push(asRead({ name: "confirm_preview", status: env === undefined ? "unknown" : "succeeded", op: "programmer", detail: { environment: env ?? null }, ...(env === undefined ? { error: "the environment could not be read, so nothing was cleared; run gma3_phaser_release" } : {}) }));
        if (env === "Preview") {
          steps.push(await commandStep(bridge, "release_preview_programmer", "ClearAll", t));
          steps.push(await commandStep(bridge, "preview_off", "Preview Off", t));
        } else if (env === undefined) {
          warnings.push("the console's environment after the build could not be read; nothing was cleared. Run gma3_phaser_release, which clears only after confirming Preview");
        }
      }
    }
    // The Normal programmer must be exactly as before.
    let untouched: boolean | null = null;
    if (entered) {
      try {
        const after = await scan(bridge, t);
        untouched = after.environment === "Normal" && fingerprint(after.rows) === fingerprint((normalBefore as Scan | null)?.rows ?? []);
        steps.push(asRead({ name: "check_normal_programmer", status: untouched ? "succeeded" : "failed", op: "programmer", ...(untouched ? {} : { error: after.environment !== "Normal" ? `the console is still in the ${after.environment} environment; run gma3_phaser_release` : "the Normal programmer changed while the effect was built" }) }));
      } catch (err) {
        steps.push(readStepFromError("check_normal_programmer", "programmer", err));
      }
    }
    const stored = storeResult as OperationResult | null;
    // Only a stored and verified effect is played.
    const storedOk = !!stored && stored.outcome === "succeeded" && stored.verification.status === "matched";
    // Audition: explicit only, in the (empty) Normal programmer, always released.
    let auditioned: unknown = null;
    if (audition > 0 && storedOk && untouched) {
      const sel = group !== undefined ? ["ClearSelection", "Grid 0/0/0", `Group ${group}`] : ["ClearSelection", ...members.flatMap((m) => [`Grid ${m.x}/0/0`, m.ref])];
      try {
        const a = await commandsStep(bridge, "audition", [...sel, `At Preset ${id.pool}.${id.number}`], t);
        steps.push(a);
        if (a.status === "succeeded") await new Promise((r) => setTimeout(r, audition));
      } finally {
        steps.push(await commandStep(bridge, "audition_release", "ClearAll", t));
      }
      try {
        const after = await scan(bridge, t);
        const clear = after.rows.length === 0;
        steps.push(asRead({ name: "check_audition_released", status: clear ? "succeeded" : "failed", op: "programmer", ...(clear ? {} : { error: `the Normal programmer still holds ${after.rows.length} value(s) after the audition; run gma3_phaser_release with clear_normal` }) }));
        auditioned = { ms: audition, released: clear };
      } catch (err) {
        steps.push(readStepFromError("check_audition_released", "programmer", err));
      }
    } else if (audition > 0) warnings.push("the audition was skipped: it needs a stored effect whose read-back matched, and an untouched Normal programmer");

    let verification: Verification = notRequested();
    if (stored) {
      verification = stored.verification;
      if (untouched === false) verification = { status: "mismatched", checked: `${verification.checked ?? "the stored preset"} and the Normal programmer`, detail: "the Normal programmer is not as it was before the build" };
    }
    if (stored?.warnings) warnings.push(...stored.warnings);
    const b = built as { problems: string[]; implied: string[] } | null;
    if (b?.implied.length) warnings.push(`stored with the effect (the rest of an activation group, or attributes of a step preset): ${b.implied.join(", ")}`);
    return buildResult({ operation: op, target, steps, verification, warnings, extra: { ...extra, normalProgrammerUntouched: untouched, stored: stored ? { outcome: stored.outcome, verification: stored.verification, resulting: (stored as Record<string, unknown>).resulting ?? null } : null, audition: auditioned } });
  };
  return preview ? body() : ctx.mutations.run(body);
}

// ---------------------------------------------------------------------------
// gma3_phaser_release
// ---------------------------------------------------------------------------

export async function releasePhaser(ctx: ToolContext, raw: { clear_normal?: boolean; exclusive?: boolean }): Promise<OperationResult> {
  const op = "phaser_release";
  if (raw.clear_normal === true && raw.exclusive !== true) return validationFailure(op, {}, ["clear_normal discards every value in the Normal programmer (ClearAll): pass exclusive: true to confirm"]);
  return ctx.mutations.run(async () => {
    const bridge = ctx.bridge;
    const t = ctx.requestTimeoutMs;
    const steps: StepResult[] = [];
    let env: string | undefined;
    try {
      env = (await scan(bridge, t)).environment;
      steps.push(asRead({ name: "read_environment", status: "succeeded", op: "programmer", detail: { environment: env } }));
    } catch (err) {
      steps.push(readStepFromError("read_environment", "programmer", err));
      return buildResult({ operation: op, target: {}, steps });
    }
    if (env === "Preview") {
      steps.push(await commandStep(bridge, "release_preview_programmer", "ClearAll", t));
      steps.push(await commandStep(bridge, "preview_off", "Preview Off", t));
    }
    if (raw.clear_normal === true) steps.push(await commandStep(bridge, "clear_normal", "ClearAll", t));
    try {
      const after = await scan(bridge, t);
      const ok = after.environment === "Normal" && (raw.clear_normal !== true || after.rows.length === 0);
      steps.push(asRead({ name: "check", status: ok ? "succeeded" : "failed", op: "programmer", detail: { environment: after.environment, normalValues: after.rows.length }, ...(ok ? {} : { error: after.environment !== "Normal" ? `still in ${after.environment}` : "the Normal programmer is not empty" }) }));
    } catch (err) {
      steps.push(readStepFromError("check", "programmer", err));
    }
    const nothing = env === "Normal" && raw.clear_normal !== true;
    return buildResult({ operation: op, target: {}, steps, summary: nothing ? "The console is in the Normal environment and clear_normal was not requested; nothing was sent." : undefined });
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const stepValue = z.union([z.number(), z.object({ absolute: z.number().optional(), relative: z.number().optional() })]);
const stepSchema = z.object({
  values: z.record(z.string(), stepValue).optional().describe("Attribute -> value: a number (absolute) or {absolute, relative}, in the effect's unit."),
  preset: z.string().optional().describe('A preset called into this step ("4.4"); stored as a reference.'),
  width: z.number().optional().describe("Step timing: width, percent of a beat (default 100)."),
  transition: z.number().optional().describe("Step timing: transition, percent of the width spent moving (default 100; 0 snaps)."),
  accel: z.number().optional().describe("Step timing: acceleration (default 0; -100 with decel -100 is a sine)."),
  decel: z.number().optional().describe("Step timing: deceleration (default 0)."),
});

export const registerPhaserTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_build_phaser",
    {
      title: "Build a phaser and store it as a preset",
      description:
        "Build a repeatable effect from structured steps and store it into Preset <pool>.<number>, reading every step back. Steps: per attribute an absolute and/or relative value (unit percent, or physical: degrees for Pan/Tilt) or a preset called into the step, plus step timing (width, transition, accel, decel). " +
        "phaser: fixture distribution (phase {from, to} in degrees over the selection grid; from > to runs the other way; repeat {groups|wings|blocks: n} repeats it along X) and playback speed (speed_bpm, measure in beats, speed_master 1-16). These three are kept apart in the plan and the result. " +
        "Templates (instead of steps): dimmer_chase {on, off, speed_bpm, spread}, alternating_colors {colors: [{red, green, blue} or {preset}], x2, speed_bpm, snap}, pan_tilt {pan, tilt (degrees), speed_bpm, spread}: a relative circle around the current position. preview: true returns the expanded steps and the console commands. " +
        "fixtures are selected in list order on grid X (or group: a stored group with its grid). Every attribute is checked against every fixture before anything is sent (the console ignores unsupported attributes silently). " +
        "The effect is built in the console's Preview environment (its own empty programmer; nothing is output) and the operator's Normal programmer is fingerprinted before and after: it is never touched. The built programmer is checked per fixture, step and layer, including the phase per fixture, then stored with the gma3_store_preset rules (mode selective or global, existing refuse|merge|overwrite, step presets embedded) and verified step by step; the Preview programmer is cleared and Preview left in every case. " +
        "audition_ms (default 0: no playback) calls the stored preset on the fixtures in the Normal programmer, which must be empty, for that long and releases it with ClearAll. Requires exclusive: true (not for preview). If a build is interrupted, gma3_phaser_release leaves Preview. Needs bridge 0.23.0.",
      inputSchema: {
        preset: z.string().describe('Target preset "<pool>.<number>"; an All pool (21-25) takes any attributes.'),
        fixtures: z.array(z.union([z.string(), z.number()])).optional().describe("Fixture ids or ranges, distributed in list order."),
        group: z.number().optional().describe("A stored group instead of fixtures; its grid sets the distribution order."),
        steps: z.array(stepSchema).optional().describe("2-16 steps."),
        phaser: z
          .object({
            speed_bpm: z.number().optional(),
            phase: z.object({ from: z.number(), to: z.number() }).optional(),
            measure: z.number().optional(),
            speed_master: z.number().optional(),
            repeat: z.object({ groups: z.number().optional(), wings: z.number().optional(), blocks: z.number().optional() }).optional(),
          })
          .optional()
          .describe("Phaser layers: playback speed, phase distribution, measure, speed master, repetition."),
        template: z.object({ type: z.enum(["dimmer_chase", "alternating_colors", "pan_tilt"]) }).passthrough().optional().describe("A template instead of steps; see the description for its options."),
        unit: z.enum(["percent", "physical"]).optional().describe("Unit of the step values (default percent)."),
        mode: z.enum(["selective", "global"]).optional().describe("Preset mode (default selective)."),
        existing: z.enum(["refuse", "merge", "overwrite"]).optional().describe("When the preset exists (default refuse)."),
        name: z.string().optional().describe("Preset name."),
        audition_ms: z.number().optional().describe("Play the stored effect for this long in the empty Normal programmer, then release it (default 0: no playback; max 30000)."),
        exclusive: z.boolean().optional().describe("Required (true) unless preview."),
        preview: z.boolean().optional().describe("Only check and return the plan and commands (default false)."),
        verify: z.boolean().optional().describe("Read the stored preset back step by step (default true)."),
      },
    },
    async (args) => operation(() => buildPhaser(ctx, args as BuildArgs)),
  );

  server.registerTool(
    "gma3_phaser_release",
    {
      title: "Release a phaser build or audition",
      description:
        "The stop/release path for gma3_build_phaser: when the console is in the Preview environment (an interrupted build), clears the Preview programmer and leaves Preview. clear_normal: true (with exclusive: true) also clears the Normal programmer (ClearAll), which stops an effect called there. Reports the environment and what is left.",
      inputSchema: {
        clear_normal: z.boolean().optional().describe("Also ClearAll the Normal programmer (default false)."),
        exclusive: z.boolean().optional().describe("Required with clear_normal."),
      },
    },
    async (args) => operation(() => releasePhaser(ctx, args as { clear_normal?: boolean; exclusive?: boolean })),
  );
};

