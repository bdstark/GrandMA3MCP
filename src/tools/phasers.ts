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
  /** SU-13: a phase step per fixture (to = from + step x (n - 1)), resolved once the fixture count is known. */
  phaseStep?: { from: number; step: number };
  /** SU-13: an even spread over the fixtures (0 -> 360 x (n - 1) / n), resolved once the fixture count is known. */
  phaseSpread?: boolean;
  measure?: number;
  speedMaster?: number;
  repeat?: { kind: "groups" | "wings" | "blocks"; count: number };
  /** SU-13: XShuffle seed applied (as selection MAtricks) while the phase is set: the phases are permuted. */
  shuffle?: number;
}

/** SU-13: invert attributes on every second wing of the fixtures (grid order): the mirrored half of a rig. */
export interface Mirror {
  attributes: string[];
  wings: number;
}

/** SU-13: one step's value of an attribute spread over the fixtures in grid order (a fan): from on the first, to on the last. */
export interface Spread {
  attribute: string;
  step: number;
  from: number;
  to: number;
}

export interface Effect {
  steps: Step[];
  phaser: PhaserLayers;
  unit: Unit;
  mirror?: Mirror;
  spreads?: Spread[];
}

/** A per-fixture step value that differs from the step's own value (mirror inversion, spreads). */
export interface Override {
  /** Index of the fixture in grid order (0-based). */
  member: number;
  step: number;
  attribute: string;
  value: StepValue;
}

const MAX_STEPS = 16;
/** The largest step width the console keeps (percent of a beat); larger values are clamped silently. */
export const MAX_WIDTH = 3200;
/** SU-13: no tool-side cap below what a preset holds; the console builds and stores this many without trouble. */
export const MAX_FIXTURES = 1024;
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
    // The console clamps a step width above 3200 % silently and keeps it to 0.1 % (live 2026-10-15).
    width: num(`${field}.width`, r.width, 0, MAX_WIDTH),
    transition: num(`${field}.transition`, r.transition, 0, 100),
    accel: num(`${field}.accel`, r.accel, -1000, 1000),
    decel: num(`${field}.decel`, r.decel, -1000, 1000),
  };
}

export function parsePhaser(raw: unknown): PhaserLayers {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError("phaser must be an object", "phaser");
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!["speed_bpm", "phase", "measure", "speed_master", "repeat", "shuffle"].includes(k)) throw new ValidationError(`phaser.${k} is not a phaser setting (speed_bpm, phase, measure, speed_master, repeat, shuffle)`, "phaser");
  const out: PhaserLayers = {
    speedBpm: num("phaser.speed_bpm", r.speed_bpm, 0.01, 6000),
    measure: num("phaser.measure", r.measure, 1, 1000),
    speedMaster: r.speed_master === undefined ? undefined : finiteNumber("phaser.speed_master", r.speed_master, { integer: true, min: 1, max: 16 }),
  };
  if (r.phase !== undefined) {
    const p = r.phase as Record<string, unknown>;
    if (p === ("spread" as unknown)) out.phaseSpread = true;
    else if (!p || typeof p !== "object" || Array.isArray(p)) throw new ValidationError('phaser.phase must be {from, to} or {from?, step} in degrees, or "spread"', "phaser.phase");
    else if (p.step !== undefined) {
      if (p.to !== undefined) throw new ValidationError("phaser.phase: give to or step, not both", "phaser.phase");
      out.phaseStep = { from: num("phaser.phase.from", p.from, -3600, 3600) ?? 0, step: num("phaser.phase.step", p.step, -3600, 3600)! };
    } else {
      out.phase = { from: num("phaser.phase.from", p.from, -3600, 3600)!, to: num("phaser.phase.to", p.to, -3600, 3600)! };
      if (out.phase.from === undefined || out.phase.to === undefined) throw new ValidationError("phaser.phase needs from and to (or step)", "phaser.phase");
    }
  }
  if (r.shuffle !== undefined) out.shuffle = finiteNumber("phaser.shuffle", r.shuffle, { integer: true, min: 1, max: 9999 });
  if (r.repeat !== undefined) {
    const rp = r.repeat as Record<string, unknown>;
    const keys = rp && typeof rp === "object" ? Object.keys(rp) : [];
    if (keys.length !== 1 || !["groups", "wings", "blocks"].includes(keys[0])) throw new ValidationError("phaser.repeat must be exactly one of {groups: n}, {wings: n}, {blocks: n}", "phaser.repeat");
    out.repeat = { kind: keys[0] as "groups" | "wings" | "blocks", count: finiteNumber(`phaser.repeat.${keys[0]}`, rp[keys[0]], { integer: true, min: 2, max: 64 })! };
    if (!out.phase && !out.phaseStep && !out.phaseSpread) throw new ValidationError("phaser.repeat distributes the phase: give phaser.phase too", "phaser.repeat");
  }
  if (out.shuffle !== undefined && !out.phase && !out.phaseStep && !out.phaseSpread) throw new ValidationError("phaser.shuffle permutes the phase distribution: give phaser.phase too", "phaser.shuffle");
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
    case "circle":
    case "figure8":
    case "cone":
    case "fan":
    case "bounce":
      return shapeTemplate(t);
    case "runner":
    case "comet":
    case "alternate":
    case "thirds":
    case "fill":
    case "sparkle":
      return patternTemplate(t, fixtureCount);
    default:
      throw new ValidationError(`template.type must be one of ${TEMPLATE_TYPES.join(", ")} (got ${describe(t.type)})`, "template");
  }
}

export const SHAPE_TYPES = ["circle", "figure8", "cone", "fan", "bounce"] as const;
export const PATTERN_TYPES = ["runner", "comet", "alternate", "thirds", "fill", "sparkle"] as const;
export const TEMPLATE_TYPES = ["dimmer_chase", "alternating_colors", "pan_tilt", ...SHAPE_TYPES, ...PATTERN_TYPES] as const;

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * SU-13 position shapes in physical degrees, absolute around a centre {pan, tilt}: circle and figure8 (size = radius),
 * cone (tilt held at `tilt`, pan sweeping a full turn and back), fan (the fixtures close on the centre, then open
 * over `size` degrees of pan, first fixture to last), bounce (tilt up and down by `size`).
 */
function shapeTemplate(t: Record<string, unknown>): Effect {
  const c = (t.center ?? {}) as Record<string, unknown>;
  if (typeof c !== "object" || Array.isArray(c)) throw new ValidationError("template.center must be {pan, tilt} in degrees", "template.center");
  const cx = num("template.center.pan", c.pan, -540, 540) ?? 0;
  const cy = num("template.center.tilt", c.tilt, -270, 270) ?? 0;
  const size = num("template.size", t.size, 0, 540) ?? 20;
  const speedBpm = num("template.speed_bpm", t.speed_bpm, 0.01, 6000) ?? 20;
  const smooth = { accel: -100, decel: -100 };
  const pt = (pan: number | undefined, tilt: number | undefined, extra: Partial<Step> = {}): Step => ({
    values: { ...(pan !== undefined ? { Pan: { absolute: round3(pan) } } : {}), ...(tilt !== undefined ? { Tilt: { absolute: round3(tilt) } } : {}) },
    ...extra,
  });
  const out = (steps: Step[], spreads?: Spread[]): Effect => ({ unit: "physical", steps, phaser: { speedBpm }, ...(spreads ? { spreads } : {}) });
  switch (t.type) {
    case "circle":
      return out([pt(cx + size, cy, smooth), pt(cx, cy + size, smooth), pt(cx - size, cy, smooth), pt(cx, cy - size, smooth)]);
    case "figure8": {
      // Pan at the base frequency, tilt at twice it: a lemniscate in eight points.
      const steps = Array.from({ length: 8 }, (_, k) => {
        const a = (k * Math.PI) / 4;
        return pt(cx + size * Math.sin(a), cy + (size / 2) * Math.sin(2 * a));
      });
      return out(steps);
    }
    case "cone": {
      const tilt = num("template.tilt", t.tilt, -270, 270) ?? cy;
      return out([pt(cx - 180, tilt, smooth), pt(cx, tilt, smooth), pt(cx + 180, tilt, smooth), pt(cx, tilt, smooth)]);
    }
    case "fan":
      return out([pt(cx, cy, smooth), pt(cx, cy, smooth)], [{ attribute: "Pan", step: 2, from: round3(cx - size / 2), to: round3(cx + size / 2) }]);
    default:
      return out([pt(undefined, cy + size, smooth), pt(undefined, cy - size, smooth)]);
  }
}

/**
 * SU-13 dimmer patterns for a row of fixtures or cells (in grid order): runner (one on at a time), comet (on, then a
 * tail of `tail` cells fading out), alternate (odd and even), thirds (every third in turn), fill (fill up, then
 * empty in the same direction), sparkle (one in `every` on at a time, shuffled). Step widths are percent of a beat:
 * the cycle lasts (sum of widths) / 100 beats at the speed.
 */
function patternTemplate(t: Record<string, unknown>, n: number): Effect {
  if (n < 2) throw new ValidationError(`template ${String(t.type)} needs at least two fixtures or cells`, "template");
  const on = num("template.on", t.on, 0, 100) ?? 100;
  const speedBpm = num("template.speed_bpm", t.speed_bpm, 0.01, 6000) ?? 120;
  const snap = { transition: 0 };
  const d = (v: number, extra: Partial<Step> = {}): Step => ({ values: { Dimmer: { absolute: v } }, ...snap, ...extra });
  const spread = { from: 0, to: round3((360 * (n - 1)) / n) };
  // A width is at most 3200 % of a beat and kept to 0.1 % by the console: long rows scale both widths down, keeping
  // the ratio as far as 0.1 % allows.
  const widths = (a: number, b: number): [number, number] => {
    const k = Math.min(1, MAX_WIDTH / Math.max(a, b));
    const tenth = (x: number) => Math.round(x * k * 10) / 10;
    return [tenth(a), tenth(b)];
  };
  switch (t.type) {
    case "runner": {
      const [w1, w2] = widths(100, 100 * (n - 1));
      return { unit: "percent", steps: [d(on, { width: w1 }), d(0, { width: w2 })], phaser: { speedBpm, phase: spread } };
    }
    case "comet": {
      const tail = num("template.tail", t.tail, 1, 1000) ?? 3;
      if (tail >= n) throw new ValidationError(`template.tail must be shorter than the row (${n})`, "template.tail");
      const [w1, w2] = widths(100 * tail, 100 * (n - tail));
      return { unit: "percent", steps: [d(on, { width: w1, transition: 100 }), d(0, { width: w2 })], phaser: { speedBpm, phase: spread } };
    }
    case "alternate":
      return { unit: "percent", steps: [d(on), d(0)], phaser: { speedBpm, phase: { from: 0, to: 180 }, repeat: { kind: "groups", count: 2 } } };
    case "thirds":
      if (n < 3) throw new ValidationError("template thirds needs at least three fixtures or cells", "template");
      return { unit: "percent", steps: [d(on, { width: 100 }), d(0, { width: 200 })], phaser: { speedBpm, phase: { from: 0, to: 240 }, repeat: { kind: "groups", count: 3 } } };
    case "fill":
      return { unit: "percent", steps: [d(0), d(on)], phaser: { speedBpm, phase: { from: 0, to: round3((180 * (n - 1)) / n) } } };
    default: {
      const every = num("template.every", t.every, 2, 1000) ?? 4;
      const seed = t.seed === undefined ? 1 : finiteNumber("template.seed", t.seed, { integer: true, min: 1, max: 9999 })!;
      const [w1, w2] = widths(100, 100 * (every - 1));
      return { unit: "percent", steps: [d(on, { width: w1 }), d(0, { width: w2 })], phaser: { speedBpm, phase: spread, shuffle: seed } };
    }
  }
}

/** The inverse of a step value for a mirrored fixture: relative and physical values change sign, percent becomes 100 - v. */
export function invertValue(v: StepValue, unit: Unit): StepValue {
  return {
    ...(v.absolute !== undefined ? { absolute: unit === "physical" ? -v.absolute : round3(100 - v.absolute) } : {}),
    ...(v.relative !== undefined ? { relative: -v.relative } : {}),
  };
}

/**
 * Resolve what depends on the fixture count n (fixtures in grid order): phase step and spread become from/to, spreads
 * and the mirror become per-fixture overrides. Mirror: the fixtures are cut into `wings` equal parts in grid order and
 * every second part gets the chosen attributes inverted (relative and physical values negated, percent 100 - v).
 */
export function planEffect(e: Effect, n: number): { effect: Effect; overrides: Override[] } {
  const phaser: PhaserLayers = { ...e.phaser };
  if (phaser.phaseStep) {
    phaser.phase = { from: phaser.phaseStep.from, to: round3(phaser.phaseStep.from + phaser.phaseStep.step * Math.max(0, n - 1)) };
    delete phaser.phaseStep;
  }
  if (phaser.phaseSpread) {
    if (n > 1) phaser.phase = { from: 0, to: round3((360 * (n - 1)) / n) };
    delete phaser.phaseSpread;
  }
  const values = new Map<string, StepValue>();
  const key = (m: number, step: number, a: string) => `${m}|${step}|${a}`;
  for (const sp of e.spreads ?? []) {
    for (let m = 0; m < n; m++) values.set(key(m, sp.step, sp.attribute), { absolute: round3(n > 1 ? sp.from + ((sp.to - sp.from) * m) / (n - 1) : sp.from) });
  }
  if (e.mirror) {
    const size = Math.ceil(n / e.mirror.wings);
    for (let m = 0; m < n; m++) {
      if (Math.floor(m / size) % 2 !== 1) continue;
      e.steps.forEach((st, i) => {
        for (const a of e.mirror!.attributes) {
          const own = values.get(key(m, i + 1, a)) ?? st.values[a];
          if (own) values.set(key(m, i + 1, a), invertValue(own, e.unit));
        }
      });
    }
  }
  const overrides: Override[] = [...values].map(([k, value]) => {
    const [m, step, attribute] = k.split("|");
    return { member: Number(m), step: Number(step), attribute, value };
  });
  return { effect: { ...e, phaser }, overrides };
}

/** Every attribute the effect writes. */
export const effectAttributes = (e: Effect) => [...new Set(e.steps.flatMap((s) => Object.keys(s.values)))];

/** How the commands select fixtures for per-fixture overrides: the whole selection again, or some fixtures (grid order). */
export interface Selector {
  all: string[];
  some: (members: number[]) => string[];
}

/**
 * The console commands that build the effect on a selection, in order. Overrides (mirror, spreads) are written once
 * every step exists, on the fixtures they belong to (fixtures with the same overrides together), and the whole selection
 * is restored before the step timing and the phaser layers, which apply to the selection.
 */
export function effectCommands(e: Effect, overrides: Override[] = [], select?: Selector): string[] {
  const out: string[] = [];
  const kw = e.unit === "physical" ? " Physical" : "";
  const write = (attr: string, v: StepValue) => {
    if (v.absolute !== undefined) out.push(`Attribute "${attr}" At Absolute${kw} ${formatValue(v.absolute)}`);
    if (v.relative !== undefined) out.push(`Attribute "${attr}" At Relative${kw} ${formatValue(v.relative)}`);
  };
  e.steps.forEach((s, i) => {
    out.push(`Step ${i + 1}`);
    if (s.preset) out.push(`At Preset ${s.preset.pool}.${s.preset.number}`);
    for (const [attr, v] of Object.entries(s.values)) write(attr, v);
  });
  if (overrides.length) {
    if (!select) throw new Error("overrides need a selector");
    const byMember = new Map<number, Override[]>();
    for (const o of overrides) byMember.set(o.member, [...(byMember.get(o.member) ?? []), o]);
    const groups = new Map<string, { members: number[]; list: Override[] }>();
    for (const [m, list] of byMember) {
      const sorted = [...list].sort((a, b) => a.step - b.step || a.attribute.localeCompare(b.attribute));
      const k = JSON.stringify(sorted.map((o) => [o.step, o.attribute, o.value]));
      const g = groups.get(k) ?? { members: [], list: sorted };
      g.members.push(m);
      groups.set(k, g);
    }
    for (const g of groups.values()) {
      out.push(...select.some(g.members.sort((a, b) => a - b)));
      let step = -1;
      for (const o of g.list) {
        if (o.step !== step) { out.push(`Step ${o.step}`); step = o.step; }
        write(o.attribute, o.value);
      }
    }
    out.push(...select.all);
  }
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
  if (p.shuffle !== undefined) out.push(`Set Selection MAtricks "XShuffle" ${p.shuffle}`);
  if (p.speedBpm !== undefined) out.push(`At Speed ${formatValue(p.speedBpm)}`);
  if (p.phase) out.push(`At Phase ${formatValue(p.phase.from)} Thru ${formatValue(p.phase.to)}`);
  if (p.measure !== undefined) out.push(`At Measure ${formatValue(p.measure)}`);
  if (p.speedMaster !== undefined) out.push(`At SpeedMaster ${p.speedMaster}`);
  if (p.repeat || p.shuffle !== undefined) out.push("Reset Selection MAtricks");
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

/** Two phases are the same angle (modulo 360: a spread of 0 -> 12780 may read back wrapped). */
export const sameAngle = (a: unknown, b: unknown, tol = 0.05): boolean => {
  if (typeof a !== "number" || typeof b !== "number") return false;
  const d = ((((a - b) % 360) + 540) % 360) - 180;
  return Math.abs(d) <= tol;
};
const norm360 = (x: number) => Math.round((((x % 360) + 360) % 360) * 100) / 100;

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
    // A wing of one fixture gets the centre end of the distribution (live 2026-10-15: wings 2 on two movers read 180 for
    // phase 0 Thru 180 on both).
    if (size === 1) return phase.to;
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
export function verifyBuild(input: {
  effect: Effect;
  rows: BuildRow[];
  scope: Map<number, string>;
  implied: Set<string>;
  stepPresets: Array<string | undefined>;
  /** Per-fixture step values (mirror, spreads) by subfixture index, step (1-based) and attribute. */
  overrideOf?: (sf: number, step: number, attr: string) => StepValue | undefined;
}): { problems: string[]; implied: string[] } {
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
        const v = input.overrideOf?.(sf, i + 1, attr) ?? s.values[attr];
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
        if (ph.shuffle !== undefined) continue; // a shuffled distribution is checked as a whole below
        if (!sameAngle(r.phaser?.phase, want)) problems.push(`${where}: phase ${formatValue(want)}° expected (grid position ${pos - minPos} of ${span}${ph.repeat ? `, ${ph.repeat.kind} ${ph.repeat.count}` : ""}), ${r.phaser?.phase ?? "none"} read`);
      }
    }
  }
  // Shuffle permutes which fixture gets which phase:
  //   - every attribute of one fixture shares that fixture's phase (one At Phase command sets every active attribute,
  //     activated siblings and step-preset channels included; review round 1);
  //   - over the whole selection, the fixtures' phases are the unshuffled set (modulo 360). An attribute that only part
  //     of a mixed rig has (RGBW's W next to RGB fixtures) takes whatever phase its fixture drew from the whole set, so
  //     it is checked against its fixture, not against a subset of the distribution (review round 2).
  const ph = effect.phaser;
  if (ph.phase && ph.shuffle !== undefined) {
    const want: number[] = [];
    const got: number[] = [];
    for (const [sf, id] of input.scope) {
      const pos = posOf.get(sf);
      if (pos !== undefined) want.push(norm360(expectedPhase(ph.phase, pos - minPos, span, ph.repeat)));
      const rows = (bySf.get(sf) ?? []).filter((r) => typeof r.phaser?.phase === "number");
      if (!rows.length) continue;
      // The fixture's phase: from an attribute the effect writes, else its first phased row.
      const own = rows.find((r) => attrs.includes(String(r.attribute))) ?? rows[0];
      const phase = own.phaser!.phase as number;
      got.push(norm360(phase));
      const off = rows.filter((r) => !sameAngle(r.phaser!.phase, phase));
      if (off.length) problems.push(`${id}: its attributes are out of phase (${rows.map((r) => `${r.attribute} ${norm360(r.phaser!.phase as number)}`).join(", ")})`);
    }
    want.sort((x, y) => x - y);
    got.sort((x, y) => x - y);
    const same = want.length === got.length && want.every((w, i) => sameAngle(w, got[i]));
    if (!same) problems.push(`shuffled phases: expected the set ${want.join(", ")} over the fixtures, read ${got.join(", ")}`);
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

/**
 * The phase of every fixture in grid order, compactly (SU-13): an arithmetic run as {first, step}, otherwise the list of
 * values (modulo 360, two decimals). Read from the build check's own programmer scan, so no client-side programmer read
 * is needed.
 */
export function summarizePhases(rows: BuildRow[], order: Array<{ sf: number; id: string }>): Record<string, unknown> | null {
  const values: Array<number | null> = order.map(({ sf }) => {
    const r = rows.find((x) => x.subfixtureIndex === sf && typeof x.phaser?.phase === "number");
    return r ? (r.phaser!.phase as number) : null;
  });
  if (!values.some((v) => v !== null)) return null;
  const head = { fixtures: order.length, first: order[0]?.id, last: order[order.length - 1]?.id };
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length === values.length && nums.length > 1) {
    // The step from the whole run (unrounded), so 360/116 does not drift; the console keeps phases within ±720
    // (a 180 step reads 0, 180, 360, 540, 720, -540, ...), so the run is compared modulo 360.
    const first = nums[0];
    const d = ((((nums[1] - first) % 360) + 540) % 360) - 180;
    const step = Math.abs(d) < 1e-9 ? 0 : nums[1] - first;
    if (nums.every((v, i) => sameAngle(v, first + step * i))) return { ...head, first_phase: Math.round(first * 100) / 100, step: Math.round(step * 10000) / 10000 };
  }
  return { ...head, phases: values.map((v) => (v === null ? null : norm360(v))) };
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

interface EffectArgs {
  preset?: string;
  fixtures?: unknown[];
  group?: number;
  steps?: unknown[];
  phaser?: unknown;
  template?: unknown;
  unit?: Unit;
  mirror?: unknown;
  variants?: unknown;
  mode?: "selective" | "global";
  existing?: "refuse" | "merge" | "overwrite";
  name?: string;
  verify?: boolean;
}

interface BuildArgs extends EffectArgs {
  effects?: Array<Record<string, unknown>>;
  audition_ms?: number;
  exclusive?: boolean;
  preview?: boolean;
  detail?: boolean;
}

interface Member {
  id: string;
  sfIndex: number;
  ref: string;
  x: number;
}

/** One preset to build: an effect (a variant is its own job) on its fixtures. */
interface Job {
  id: { pool: number; number: number };
  ref: string;
  variant?: Variant;
  effect: Effect;
  ids: string[];
  group?: number;
  mode: "selective" | "global";
  existing: "refuse" | "merge" | "overwrite";
  name?: string;
  verify: boolean;
}

export const VARIANTS = ["sync", "follow", "mirror"] as const;
export type Variant = (typeof VARIANTS)[number];
/** Presets per call (effects x variants). */
export const MAX_JOBS = 64;

function parseMirror(raw: unknown, path: string): Mirror | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError(`${path} must be {attributes, wings?}`, path);
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.attributes) || r.attributes.length === 0) throw new ValidationError(`${path}.attributes must name the attributes to invert, e.g. ["Pan"]`, path);
  return { attributes: r.attributes.map((a, i) => attributeName(`${path}.attributes[${i}]`, a)), wings: r.wings === undefined ? 2 : finiteNumber(`${path}.wings`, r.wings, { integer: true, min: 2, max: 64 })! };
}

/**
 * The versions of one effect (SU-13): sync (every fixture in phase), follow (the phase spread over the fixtures: the
 * request's phase, or 0 -> 360 x (n - 1) / n), mirror (the follow spread mirrored about the centre with wings 2, and the
 * mirror attributes, Pan by default for a position effect, inverted on the second half).
 */
export function variantOf(e: Effect, variant: Variant, mirror?: Mirror): Effect {
  const {
    phase: _p, phaseStep: _s, phaseSpread: _sp, repeat: _r, shuffle: _sh, ...still
  } = e.phaser;
  const distributed = e.phaser.phase || e.phaser.phaseStep || e.phaser.phaseSpread ? { phase: e.phaser.phase, phaseStep: e.phaser.phaseStep, phaseSpread: e.phaser.phaseSpread } : { phaseSpread: true };
  const clean = (p: PhaserLayers): PhaserLayers => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) as PhaserLayers;
  if (variant === "sync") return { ...e, phaser: clean(still), mirror: undefined };
  if (variant === "follow") return { ...e, phaser: clean({ ...still, ...distributed, repeat: e.phaser.repeat, shuffle: e.phaser.shuffle }), mirror: undefined };
  const attrs = mirror?.attributes ?? (effectAttributes(e).includes("Pan") ? ["Pan"] : []);
  return { ...e, phaser: clean({ ...still, ...distributed, repeat: { kind: "wings", count: mirror?.wings ?? 2 } }), mirror: attrs.length ? { attributes: attrs, wings: mirror?.wings ?? 2 } : undefined };
}

/** Validate one effect request into its jobs (one per variant, on consecutive presets). Errors go to `v` with `path`. */
function effectJobs(v: Validator, raw: EffectArgs, path: string): Job[] {
  const p = (f: string) => (path ? `${path}.${f}` : f);
  const id = v.check(() => presetId(p("preset"), raw.preset));
  let ids: string[] = [];
  if ((raw.fixtures === undefined) === (raw.group === undefined)) v.fail(`${path ? `${path}: ` : ""}give exactly one of fixtures (ids or ranges, distributed in list order) or group (a stored group, distributed over its grid)`);
  else if (raw.fixtures !== undefined) {
    if (!Array.isArray(raw.fixtures) || raw.fixtures.length === 0) v.fail(`${p("fixtures")} must be a non-empty list`);
    else raw.fixtures.forEach((f, i) => { const x = v.check(() => expandFixtures(`${p("fixtures")}[${i}]`, f)); if (x) ids.push(...x); });
    ids = [...new Set(ids)];
    if (ids.length > MAX_FIXTURES) v.fail(`${p("fixtures")}: at most ${MAX_FIXTURES} fixtures`);
  }
  const group = raw.group === undefined ? undefined : v.check(() => objectNumber(p("group"), raw.group, { max: 9999 }));
  const unit: Unit = raw.unit ?? "percent";
  if (unit !== "percent" && unit !== "physical") v.fail(`${p("unit")} must be percent or physical`);
  const mode = raw.mode ?? "selective";
  if (mode !== "selective" && mode !== "global") v.fail(`${p("mode")} must be selective or global (universal data keeps one value per attribute and cannot hold per-fixture phase)`);
  const existing = raw.existing ?? "refuse";
  if (!["refuse", "merge", "overwrite"].includes(existing)) v.fail(`${p("existing")} must be refuse, merge or overwrite`);
  const name = v.check(() => objectName(p("name"), raw.name, { optional: true }));
  let effect: Effect | undefined;
  if ((raw.template === undefined) === (raw.steps === undefined)) v.fail(`${path ? `${path}: ` : ""}give exactly one of steps (with phaser) or template`);
  else if (raw.template !== undefined) {
    if (raw.phaser !== undefined || raw.unit !== undefined) v.fail(`${path ? `${path}: ` : ""}a template sets its own phaser and unit; to change them, expand it with preview and pass steps and phaser`);
    const type = (raw.template as { type?: unknown } | null)?.type;
    if (group !== undefined && !(SHAPE_TYPES as readonly unknown[]).includes(type)) v.fail(`${path ? `${path}: ` : ""}this template takes fixtures (its spread depends on the fixture count); a position shape (${SHAPE_TYPES.join(", ")}) also takes a group`);
    effect = v.check(() => expandTemplate(raw.template, ids.length));
  } else {
    if (!Array.isArray(raw.steps) || raw.steps.length < 2 || raw.steps.length > MAX_STEPS) v.fail(`${p("steps")} must hold 2-${MAX_STEPS} steps (a phaser has at least two)`);
    else {
      const steps = raw.steps.map((s, i) => v.check(() => parseStep(`${p("steps")}[${i}]`, s, unit)));
      const phaser = v.check(() => parsePhaser(raw.phaser));
      if (steps.every((s): s is Step => !!s) && phaser) effect = { steps, phaser, unit };
    }
  }
  const mirror = v.check(() => parseMirror(raw.mirror, p("mirror")));
  if (mirror && effect) for (const a of mirror.attributes) if (!effectAttributes(effect).includes(a)) v.fail(`${p("mirror")}: the effect does not write ${a}`);
  let variants: Variant[] | undefined;
  if (raw.variants !== undefined) {
    if (!Array.isArray(raw.variants) || raw.variants.length === 0 || raw.variants.some((x) => !(VARIANTS as readonly unknown[]).includes(x)) || new Set(raw.variants).size !== raw.variants.length) {
      v.fail(`${p("variants")} must list distinct variants from ${VARIANTS.join(", ")}`);
    } else variants = raw.variants as Variant[];
  }
  if (!id || !effect) return [];
  const base = { ids, group, mode, existing, verify: raw.verify !== false } as const;
  if (!variants) return [{ ...base, id, ref: `Preset ${id.pool}.${id.number}`, effect: mirror ? { ...effect, mirror } : effect, name }];
  const label = name ?? (typeof (raw.template as { type?: unknown } | undefined)?.type === "string" ? String((raw.template as { type: string }).type) : "Effect");
  return variants.map((variant, i) => {
    const n = { pool: id.pool, number: id.number + i };
    return { ...base, id: n, ref: `Preset ${n.pool}.${n.number}`, variant, effect: variantOf(effect, variant, mirror), name: `${label} ${variant}` };
  });
}

/** One job's line in a multi-effect result. */
interface JobReport {
  job: Job;
  steps: StepResult[];
  members: Member[];
  stored: OperationResult | null;
  problems: string[];
  implied: string[];
  phases: Record<string, unknown> | null;
  plan: Record<string, unknown>;
  status: "not_attempted" | "refused" | "built";
}

/**
 * The compact form of a single effect's result (SU-13; a whole-rig result was 80 KB with every step): the steps that
 * did not succeed with a count of the rest, the command count instead of the commands, the stored preset's outcome and
 * verification without its rows. detail: true returns the full result.
 */
export function compactPhaserResult(r: OperationResult): OperationResult {
  const stepCounts: Record<string, number> = {};
  for (const st of r.steps) stepCounts[st.status] = (stepCounts[st.status] ?? 0) + 1;
  const plan = r.plan as Record<string, unknown> | undefined;
  const stored = r.stored as Record<string, unknown> | null | undefined;
  const { actual: _a, expected: _e, ...verification } = r.verification;
  return {
    ...r,
    verification,
    steps: r.steps.filter((st) => st.status !== "succeeded").map(({ detail: _d, ...rest }) => rest),
    stepCounts,
    ...(plan ? { plan: { ...plan, commands: undefined, commandCount: Array.isArray(plan.commands) ? plan.commands.length : undefined } } : {}),
    ...(stored ? { stored: { outcome: stored.outcome, verification: (stored.verification as Verification | undefined)?.status } } : {}),
    detailHint: "detail: true returns every step, the console commands and the stored rows",
  };
}

export async function buildPhaser(ctx: ToolContext, raw: BuildArgs): Promise<OperationResult> {
  const op = "build_phaser";
  const v = new Validator();
  const multi = raw.effects !== undefined;
  let jobs: Job[] = [];
  if (multi) {
    const own = ["preset", "fixtures", "group", "steps", "template", "phaser", "mirror", "variants", "name"].filter((k) => (raw as Record<string, unknown>)[k] !== undefined);
    if (own.length) v.fail(`with effects, give ${own.join(", ")} in each effect, not for the whole call (unit, mode, existing and verify may be defaults)`);
    if (!Array.isArray(raw.effects) || raw.effects.length === 0) v.fail("effects must be a non-empty list");
    else raw.effects.forEach((e, i) => jobs.push(...effectJobs(v, { unit: raw.unit, mode: raw.mode, existing: raw.existing, verify: raw.verify, ...(e as EffectArgs) }, `effects[${i}]`)));
  } else jobs = effectJobs(v, raw, "");
  const dupes = jobs.map((j) => j.ref).filter((r, i, a) => a.indexOf(r) !== i);
  if (dupes.length) v.fail(`presets built twice in one call: ${[...new Set(dupes)].join(", ")}`);
  if (jobs.length > MAX_JOBS) v.fail(`at most ${MAX_JOBS} presets per call (effects x variants); got ${jobs.length}`);
  const audition = raw.audition_ms === undefined ? 0 : v.check(() => finiteNumber("audition_ms", raw.audition_ms, { integer: true, min: 0, max: 30000 })) ?? 0;
  const preview = raw.preview === true;
  if (audition > 0 && jobs.length > 1) v.fail("audition_ms plays one effect: build several (effects, variants) without it");
  if (audition > 0 && jobs.some((j) => !j.verify)) v.fail("audition_ms needs verify: only an effect whose read-back matched is played");
  if (!preview && raw.exclusive !== true) v.fail("exclusive must be true: the tool switches the console to its Preview environment to build the effect and stores a preset; nobody else may use the console while it runs. preview: true needs no acknowledgement");
  const target: Record<string, unknown> = multi || jobs.length > 1 ? { presets: jobs.map((j) => `${j.id.pool}.${j.id.number}`) } : { preset: raw.preset };
  if (!v.ok || jobs.length === 0) return validationFailure(op, target, v.errors);
  if (!multi && jobs.length === 1) target.presetRef = jobs[0].ref;
  const bridge = ctx.bridge;
  const t = ctx.requestTimeoutMs;
  const single = jobs.length === 1;
  const pre = (j: Job) => (single ? "" : `preset ${j.id.pool}.${j.id.number}: `);

  const body = async (): Promise<OperationResult> => {
    let normalBefore: Scan | null = null;
    const warnings: string[] = [];
    const reports: JobReport[] = jobs.map((job) => ({ job, steps: [], members: [], stored: null, problems: [], implied: [], phases: null, plan: {}, status: "not_attempted" }));
    const plans = new Map<Job, { effect: Effect; overrides: Override[]; commands: string[]; select: string[]; stepPresets: Array<string | undefined>; implied: Set<string>; members: Member[] }>();

    // 1. Inspection per job (nothing is sent when any fails), then the Normal programmer once.
    const inspectPlan: Array<{ name: string; run: () => Promise<StepResult> }> = [];
    for (const job of jobs) {
      const { effect, id, ref, group, ids, existing } = job;
      const members: Member[] = [];
      const stepPresets: Array<string | undefined> = [];
      const implied = new Set<string>();
      const attrs = effectAttributes(effect);
      const P = pre(job);
      inspectPlan.push(
        {
          name: `${P}read_context`,
          run: async () => {
            const name = `${P}read_context`;
            try {
              const c = (await bridge.request("preset.context", { pool: id.pool }, t)) as PresetContext;
              if (!c.pool?.exists) return failed(name, `preset pool ${id.pool} does not exist`);
              const look = String(c.preferences?.StoreLook ?? "").trim().toLowerCase();
              if (look !== "no" && look !== "off") return failed(name, `the operator's StoreLook store preference is ${JSON.stringify(c.preferences?.StoreLook)}; a store would take every fixture with an open dimmer`);
              if (!ALL_POOLS.includes(id.pool) && String(c.preferences?.PresetInputFilter ?? "").toLowerCase() === "yes") warnings.push(`Preset pool ${id.pool} is a feature-group pool with the input filter on: attributes of other feature groups would be refused by the store; an All pool (21-25) takes any effect`);
              const pr = (await bridge.request("preset.read", { ref }, t).catch((err: unknown) => (err instanceof BridgeError && /no objects? found/i.test(err.message) ? null : Promise.reject(err)))) as PresetRead | null;
              if (pr) {
                if (String(pr.lock ?? "").trim() !== "") return failed(name, `${ref} is locked`);
                if (existing === "refuse") return failed(name, `${ref} already exists; pass existing: "merge" or "overwrite"`);
              }
              return asRead({ name, status: "succeeded", op: "preset.context", detail: { exists: !!pr } });
            } catch (err) {
              return readStepFromError(name, "preset.context", err);
            }
          },
        },
        {
          name: `${P}resolve_fixtures`,
          run: async () => {
            const name = `${P}resolve_fixtures`;
            try {
              if (group !== undefined) {
                let g: { items: Array<{ fixture?: string | null; addr?: string | null; sfIndex?: number; x?: number; unreadable?: boolean }> };
                try {
                  g = (await bridge.request("group.read", { ref: `Group ${group}` }, t)) as typeof g;
                } catch (err) {
                  if (err instanceof BridgeError && /no objects? found/i.test(err.message)) return failed(name, `Group ${group} does not exist`);
                  throw err;
                }
                for (const it of g.items) {
                  // Members are resolved by fixture id: a numeric Addr() path does not resolve back through FromAddr.
                  if (it.unreadable || !it.fixture || typeof it.sfIndex !== "number") return failed(name, `Group ${group} holds an item without a fixture id; it cannot be checked`);
                  members.push({ id: it.fixture, sfIndex: it.sfIndex, ref: `Fixture ${it.fixture}`, x: it.x ?? 0 });
                }
                if (members.length === 0) return failed(name, `Group ${group} is empty`);
                if (members.length > MAX_FIXTURES) return failed(name, `Group ${group} holds ${members.length} items; at most ${MAX_FIXTURES}`);
              } else {
                for (const [i, fid] of ids.entries()) members.push({ id: fid, sfIndex: -1, ref: `Fixture ${fid}`, x: i });
              }
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
              if (missing.length) return failed(name, `not in the patch: ${missing.join(", ")}`);
              if (unsupported.length) return failed(name, `unsupported attributes for this selection (the console would answer OK and ignore them): ${unsupported.slice(0, 20).join("; ")}${unsupported.length > 20 ? ` and ${unsupported.length - 20} more` : ""}`, { unsupported: unsupported.slice(0, 50) });
              return asRead({ name, status: "succeeded", op: "fixtureAttributes", detail: { fixtures: members.length, implied: [...implied] } });
            } catch (err) {
              return readStepFromError(name, "fixtureAttributes", err);
            }
          },
        },
        {
          name: `${P}check_step_presets`,
          run: async () => {
            const name = `${P}check_step_presets`;
            try {
              for (const s of effect.steps) {
                if (!s.preset) { stepPresets.push(undefined); continue; }
                const r = `Preset ${s.preset.pool}.${s.preset.number}`;
                const p = await bridge.request("preset.read", { ref: r }, t).catch((err: unknown) => (err instanceof BridgeError && /no objects? found/i.test(err.message) ? null : Promise.reject(err)));
                if (!p) return failed(name, `${r} (a step preset) does not exist`);
                stepPresets.push((p as PresetRead).addrNative);
              }
              // Everything that depends on the fixture count and order: phase step and spread, mirror, spreads.
              const order = [...members].map((m, i) => ({ m, i })).sort((a, b) => a.m.x - b.m.x || a.i - b.i).map((x) => x.m);
              const planned = planEffect(effect, order.length);
              const select = group !== undefined ? ["ClearSelection", "Grid 0/0/0", `Group ${group}`] : ["ClearSelection", ...members.flatMap((m) => [`Grid ${m.x}/0/0`, m.ref])];
              const commands = effectCommands(planned.effect, planned.overrides, { all: select, some: (ms) => ["ClearSelection", ...ms.map((k) => order[k].ref)] });
              plans.set(job, { ...planned, commands, select, stepPresets, implied, members: order });
              return asRead({ name, status: "succeeded", op: "preset.read" });
            } catch (err) {
              return readStepFromError(name, "preset.read", err);
            }
          },
        },
      );
    }
    inspectPlan.push({
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
    });
    const inspect = await runSteps(inspectPlan);
    const planOf = (job: Job): Record<string, unknown> => {
      const pl = plans.get(job);
      const e = pl?.effect ?? job.effect;
      return {
        ...(job.variant ? { variant: job.variant } : {}),
        steps: e.steps.map((s, i) => ({ step: i + 1, values: s.values, ...(s.preset ? { preset: `${s.preset.pool}.${s.preset.number}` } : {}), stepTiming: { width: s.width ?? STEP_DEFAULTS.width, transition: s.transition ?? STEP_DEFAULTS.trans, accel: s.accel ?? STEP_DEFAULTS.accel, decel: s.decel ?? STEP_DEFAULTS.decel } })),
        distribution: e.phaser.phase ? { phase: e.phaser.phase, direction: e.phaser.phase.to >= e.phaser.phase.from ? "forward" : "reverse", ...(e.phaser.repeat ? { repeat: e.phaser.repeat } : {}), ...(e.phaser.shuffle !== undefined ? { shuffle: e.phaser.shuffle } : {}) } : null,
        ...(e.mirror ? { mirror: e.mirror } : {}),
        ...(pl?.overrides.length ? { perFixtureValues: pl.overrides.length } : {}),
        playbackSpeed: { speedBpm: e.phaser.speedBpm ?? null, measure: e.phaser.measure ?? null, speedMaster: e.phaser.speedMaster ?? null },
        unit: e.unit,
        commands: pl?.commands ?? effectCommands(e),
      };
    };
    const singleExtra = (): Record<string, unknown> => ({ plan: planOf(jobs[0]), fixtures: (plans.get(jobs[0])?.members ?? []).map((m) => m.id) });
    if (inspect.outcome !== "succeeded") {
      return buildResult({ operation: op, target, steps: inspect.steps, summary: `${op} was not performed; nothing was sent: ${inspect.steps.find((s) => s.status !== "succeeded")?.error ?? "inspection failed"}`, warnings, extra: single ? singleExtra() : { plans: jobs.map((j) => ({ preset: `${j.id.pool}.${j.id.number}`, ...planOf(j) })) } });
    }
    if (preview) {
      const sum = jobs.map((j) => `${j.effect.steps.length} steps on ${plans.get(j)?.members.length ?? 0} fixture(s) into ${j.ref}${j.variant ? ` (${j.variant})` : ""}`).join("; ");
      return buildResult({ operation: op, target, steps: inspect.steps, summary: `Preview only; nothing was sent. In the Preview environment: ${sum}.`, warnings, extra: single ? { ...singleExtra(), preview: true } : { plans: jobs.map((j) => ({ preset: `${j.id.pool}.${j.id.number}`, ...planOf(j) })), preview: true } });
    }

    // 2. Build every job in one Preview session.
    const steps: StepResult[] = [...inspect.steps];
    let entered = false;
    try {
      const enter = await commandStep(bridge, "preview_on", "Preview On", t);
      steps.push(enter);
      entered = enter.status === "succeeded" || enter.status === "unknown";
      let ready = false;
      if (enter.status === "succeeded") {
        const chk = await runSteps([
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
        ]);
        steps.push(...chk.steps);
        ready = chk.outcome === "succeeded";
      }
      for (let i = 0; i < reports.length && ready; i++) {
        const rep = reports[i];
        const job = rep.job;
        const pl = plans.get(job)!;
        const P = pre(job);
        rep.members = pl.members;
        rep.plan = planOf(job);
        const scope = new Map(pl.members.map((m) => [m.sfIndex, m.id]));
        const overrideMap = new Map(pl.overrides.map((o) => [`${pl.members[o.member].sfIndex}|${o.step}|${o.attribute}`, o.value]));
        const jobPlan: Array<{ name: string; run: () => Promise<StepResult> }> = [];
        if (i > 0) {
          // The previous preset's values stay in the Preview programmer: ClearAll only after Preview is confirmed.
          jobPlan.push({
            name: `${P}confirm_preview`,
            run: async () => {
              try {
                const s = await scan(bridge, t);
                if (s.environment !== "Preview") return failed(`${P}confirm_preview`, `the console left the Preview environment (now ${s.environment}); nothing more was built`);
                return asRead({ name: `${P}confirm_preview`, status: "succeeded", op: "programmer" });
              } catch (err) {
                return readStepFromError(`${P}confirm_preview`, "programmer", err);
              }
            },
          });
          jobPlan.push({ name: `${P}clear`, run: () => commandStep(bridge, `${P}clear`, "ClearAll", t) });
        }
        jobPlan.push(
          { name: `${P}select`, run: () => commandsStep(bridge, `${P}select`, pl.select, t) },
          { name: `${P}build`, run: () => commandsStep(bridge, `${P}build`, pl.commands, t) },
          {
            name: `${P}check_build`,
            run: async () => {
              const name = `${P}check_build`;
              try {
                const s = await scan(bridge, t);
                const b = verifyBuild({ effect: pl.effect, rows: s.rows, scope, implied: pl.implied, stepPresets: pl.stepPresets, overrideOf: (sf, step, attr) => overrideMap.get(`${sf}|${step}|${attr}`) });
                rep.problems = b.problems;
                rep.implied = b.implied;
                rep.phases = pl.effect.phaser.phase ? summarizePhases(s.rows, pl.members.map((m) => ({ sf: m.sfIndex, id: m.id }))) : null;
                if (b.problems.length) return failed(name, `the built phaser does not match the request: ${b.problems.join("; ")}`, { problems: b.problems });
                return asRead({ name, status: "succeeded", op: "programmer", detail: { values: s.rows.length, implied: b.implied } });
              } catch (err) {
                return readStepFromError(name, "programmer", err);
              }
            },
          },
          {
            name: `${P}store`,
            run: async () => {
              const p = prepareStorePreset(ctx, {
                preset: `${job.id.pool}.${job.id.number}`,
                fixtures: pl.members.map((m) => m.id),
                mode: job.mode,
                existing: job.existing,
                layers: ["absolute", "relative", "phaser"],
                embed: pl.stepPresets.some((x) => x),
                name: job.name,
                exclusive: true,
                verify: job.verify,
                environment: "Preview",
              });
              const r = "operation" in p ? p : await p.body();
              rep.stored = r;
              const ok = r.outcome === "succeeded" && r.verification.status !== "mismatched";
              // A store with a step that got no reply (its name write after the store, say) is uncertain, not failed:
              // the build stops there instead of going on to the next preset.
              const uncertain = r.outcome === "unknown" || r.steps.some((st) => st.status === "unknown" && st.kind !== "read");
              const status = uncertain ? "unknown" : ok ? "succeeded" : "failed";
              return { name: `${P}store`, status, op: "gma3_store_preset", detail: { outcome: r.outcome, verification: r.verification.status }, ...(status === "succeeded" ? {} : { error: r.summary }) };
            },
          },
        );
        const run = await runSteps(jobPlan);
        steps.push(...run.steps);
        rep.steps = run.steps;
        rep.status = "built";
        // A failed effect does not stop the others; an unknown step (or leaving Preview) stops the build.
        const bad = run.steps.find((s) => s.status === "unknown" || (s.name === `${P}confirm_preview` && s.status !== "succeeded"));
        if (bad) ready = false;
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

    if (single) {
      const rep = reports[0];
      const job = rep.job;
      const stored = rep.stored;
      // Only a stored and verified effect is played.
      const storedOk = !!stored && stored.outcome === "succeeded" && stored.verification.status === "matched";
      // Audition: explicit only, in the (empty) Normal programmer, always released.
      let auditioned: unknown = null;
      if (audition > 0 && storedOk && untouched) {
        const sel = plans.get(job)!.select;
        try {
          const a = await commandsStep(bridge, "audition", [...sel, `At Preset ${job.id.pool}.${job.id.number}`], t);
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
      if (rep.implied.length) warnings.push(`stored with the effect (the rest of an activation group, or attributes of a step preset): ${rep.implied.join(", ")}`);
      const full = buildResult({ operation: op, target, steps, verification, warnings, extra: { ...singleExtra(), phases: rep.phases, normalProgrammerUntouched: untouched, stored: stored ? { outcome: stored.outcome, verification: stored.verification, resulting: (stored as Record<string, unknown>).resulting ?? null } : null, audition: auditioned } });
      return raw.detail === true ? full : compactPhaserResult(full);
    }

    // Several presets: one line per preset, the shared steps, and every step with detail: true.
    const lines = reports.map((rep, i) => {
      const j = rep.job;
      const stored = rep.stored;
      const bad = rep.steps.find((s) => s.status === "failed" || s.status === "unknown");
      const outcome = rep.status === "not_attempted" ? "not_attempted" : stored ? stored.outcome : bad?.status === "unknown" ? "unknown" : "failed";
      const verification = stored ? (untouched === false ? "mismatched" : stored.verification.status) : rep.status === "not_attempted" ? "not_attempted" : "not_requested";
      const summary = rep.status === "not_attempted" ? "not attempted: the build stopped before this preset" : stored && !bad ? stored.summary : `${bad?.name ?? "build"}: ${bad?.error ?? "failed"}`;
      // A step that got no reply, here or inside the store, keeps the preset's state unknown (review round 1).
      const uncertain = rep.steps.some((st) => st.status === "unknown" && st.kind !== "read") || (!!stored && (stored.outcome === "unknown" || stored.steps.some((st) => st.status === "unknown" && st.kind !== "read")));
      const problemSteps = [...rep.steps, ...(stored?.steps ?? [])].filter((st) => st.status === "failed" || st.status === "unknown").map((st) => ({ name: st.name, status: st.status, ...(st.error ? { error: st.error.length > 300 ? `${st.error.slice(0, 299)}…` : st.error } : {}) }));
      return {
        item: i + 1,
        target: `${j.ref}${j.variant ? ` (${j.variant})` : ""}${j.name ? ` "${j.name}"` : ""}`,
        outcome,
        verification,
        summary: summary.length > 400 ? `${summary.slice(0, 399)}…` : summary,
        ...(uncertain ? { uncertain: true } : {}),
        ...(rep.phases ? { phases: rep.phases } : {}),
        ...(raw.detail === true ? { plan: rep.plan, steps: rep.steps, stored } : problemSteps.length ? { steps: problemSteps } : {}),
      };
    });
    const ok = lines.filter((l) => l.outcome === "succeeded").length;
    // Persistent work: a preset that was stored, even when a later step of it failed or got no reply (outcome partial).
    const worked = lines.filter((l) => l.outcome === "succeeded" || l.outcome === "partial").length;
    const common = steps.filter((s) => !jobs.some((j) => s.name.startsWith(pre(j))));
    const commonBad = common.find((s) => s.status === "failed" || s.status === "unknown");
    const outcome = ok === lines.length && !commonBad ? "succeeded" : worked > 0 ? "partial" : lines.some((l) => l.outcome === "unknown" || l.uncertain) ? "unknown" : "failed";
    const mism = lines.filter((l) => l.verification === "mismatched");
    const verification: Verification =
      mism.length || untouched === false
        ? { status: "mismatched", checked: "each preset's build check and read-back, and the Normal programmer", detail: [...mism.map((l) => `item ${l.item} (${l.target}): ${l.summary}`), ...(untouched === false ? ["the Normal programmer is not as it was before the build"] : [])].join("; ") }
        : lines.every((l) => l.verification === "matched")
          ? { status: "matched", checked: "each preset's build check and read-back, and the Normal programmer" }
          : { status: "unavailable", checked: "each preset's build check and read-back", detail: lines.filter((l) => l.verification !== "matched").map((l) => `item ${l.item} (${l.target}): ${l.verification}`).join("; ") };
    for (const rep of reports) if (rep.stored?.warnings) warnings.push(...rep.stored.warnings.map((w) => `${rep.job.ref}: ${w}`));
    const first = lines.find((l) => l.outcome !== "succeeded");
    return {
      operation: op,
      target,
      outcome,
      verification,
      steps: raw.detail === true ? steps : common.map((s) => ({ name: s.name, status: s.status, ...(s.error ? { error: s.error } : {}) })),
      summary: `build_phaser: ${lines.length} preset(s): ${ok} succeeded${worked > ok ? `, ${worked - ok} stored with a later step that did not succeed` : ""}${lines.some((l) => l.uncertain) ? "; a step got no reply, so the console's state is not known" : ""}${first ? `. First problem, item ${first.item} (${first.target}): ${first.summary}` : ""}.`,
      ...(warnings.length ? { warnings } : {}),
      items: lines,
      normalProgrammerUntouched: untouched,
      ...(raw.detail === true ? {} : { detailHint: "detail: true returns every preset's plan, steps and store result" }),
    };
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

const phaserSchema = z
  .object({
    speed_bpm: z.number().optional().describe("Playback speed in BPM."),
    phase: z.union([z.object({ from: z.number(), to: z.number() }), z.object({ from: z.number().optional(), step: z.number() }), z.literal("spread")]).optional().describe('{from, to}, {from, step} (degrees per fixture) or "spread".'),
    measure: z.number().optional().describe("Beats one phaser cycle lasts at the speed."),
    speed_master: z.number().optional(),
    repeat: z.object({ groups: z.number().optional(), wings: z.number().optional(), blocks: z.number().optional() }).optional(),
    shuffle: z.number().optional().describe("XShuffle seed: permutes the phase distribution."),
  })
  .optional()
  .describe("Phaser layers: playback speed, phase distribution, measure, speed master, repetition, shuffle.");
const templateSchema = z.object({ type: z.enum(TEMPLATE_TYPES as unknown as [string, ...string[]]) }).passthrough().optional().describe("A template instead of steps; see the description for its options.");
const mirrorSchema = z.object({ attributes: z.array(z.string()), wings: z.number().optional() }).optional().describe("Invert these attributes on every second wing (default 2 wings: the second half).");
const variantsSchema = z.array(z.enum(VARIANTS)).optional().describe("Build these versions into consecutive presets from preset: sync, follow, mirror.");

export const registerPhaserTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_build_phaser",
    {
      title: "Build a phaser and store it as a preset",
      description:
        "Build a repeatable effect from structured steps and store it into Preset <pool>.<number>, reading every step back. Steps: per attribute an absolute and/or relative value (unit percent, or physical: degrees for Pan/Tilt) or a preset called into the step, plus step timing (width, transition, accel, decel). " +
        "phaser: fixture distribution (phase {from, to} in degrees over the selection grid, from > to runs the other way; {from, step}: a phase step per fixture, e.g. step 180 between neighbours; \"spread\": 0 -> 360 x (n-1)/n; repeat {groups|wings|blocks: n} repeats it along X; shuffle: an XShuffle seed that permutes the phases) and playback speed (speed_bpm; measure = the number of beats one phaser cycle lasts at that speed, so the step widths, in percent of a beat, should add up to measure x 100; speed_master 1-16). These three are kept apart in the plan and the result. " +
        "mirror {attributes, wings (default 2)}: the fixtures (grid order) are cut into wings and every second wing gets those attributes inverted (relative and physical values negated, percent 100 - v), e.g. the second beam's Pan. variants [sync, follow, mirror] build the versions of one effect into consecutive presets from preset, named \"<name> sync|follow|mirror\": sync without a phase spread, follow with the phase (default spread), mirror with the spread mirrored about the centre (wings 2) and Pan (or mirror.attributes) inverted on the second half. " +
        "Templates (instead of steps): dimmer_chase {on, off, speed_bpm, spread}, alternating_colors {colors: [{red, green, blue} or {preset}], x2, speed_bpm, snap}, pan_tilt {pan, tilt (degrees), speed_bpm, spread}: a relative circle around the current position. " +
        "Position shapes in physical degrees around center {pan, tilt}: circle and figure8 (size = radius), cone (tilt held at tilt, pan sweeping a full turn and back), fan (closed on the centre, then open over size degrees of pan from the first fixture to the last), bounce (tilt up and down by size); default 20 BPM. " +
        "Dimmer patterns for rows of fixtures or cells (grid order): runner (one on at a time), comet {tail: cells}, alternate, thirds, fill (fill up, then empty), sparkle {every, seed}; default 120 BPM. preview: true returns the expanded steps and the console commands. " +
        "fixtures are selected in list order on grid X (or group: a stored group with its grid); up to 1024. Every attribute is checked against every fixture before anything is sent (the console ignores unsupported attributes silently). " +
        "effects: several effects (each with its own preset, fixtures or group, steps or template, phaser, mirror, variants, name) built in one Preview session, one result line per preset with a compact phase summary (detail: true for every step); a failed effect does not stop the others. " +
        "The effect is built in the console's Preview environment (its own empty programmer; nothing is output) and the operator's Normal programmer is fingerprinted before and after: it is never touched. The built programmer is checked per fixture, step and layer, including the phase per fixture, then stored with the gma3_store_preset rules (mode selective or global, existing refuse|merge|overwrite, step presets embedded) and verified step by step; the Preview programmer is cleared and Preview left in every case. " +
        "audition_ms (default 0: no playback) calls the stored preset on the fixtures in the Normal programmer, which must be empty, for that long and releases it with ClearAll. Requires exclusive: true (not for preview). If a build is interrupted, gma3_phaser_release leaves Preview. Needs bridge 0.23.0.",
      inputSchema: {
        preset: z.string().optional().describe('Target preset "<pool>.<number>" (the first of the variants); an All pool (21-25) takes any attributes. Required unless effects is given.'),
        fixtures: z.array(z.union([z.string(), z.number()])).optional().describe("Fixture ids or ranges, distributed in list order."),
        group: z.number().optional().describe("A stored group instead of fixtures; its grid sets the distribution order."),
        steps: z.array(stepSchema).optional().describe("2-16 steps."),
        phaser: phaserSchema,
        template: templateSchema,
        mirror: mirrorSchema,
        variants: variantsSchema,
        effects: z
          .array(z.object({ preset: z.string(), fixtures: z.array(z.union([z.string(), z.number()])).optional(), group: z.number().optional(), steps: z.array(stepSchema).optional(), phaser: phaserSchema, template: templateSchema, unit: z.enum(["percent", "physical"]).optional(), mirror: mirrorSchema, variants: variantsSchema, mode: z.enum(["selective", "global"]).optional(), existing: z.enum(["refuse", "merge", "overwrite"]).optional(), name: z.string().optional() }))
          .optional()
          .describe("Several effects in one call (instead of preset/fixtures/steps/template): built in one Preview session; unit, mode, existing and verify given for the call are defaults."),
        detail: z.boolean().optional().describe("Return every step, the console commands and the stored rows (default false: a compact result; with several presets one line each)."),
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

