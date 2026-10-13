/**
 * SB-06: speed masters, rate links and tempo.
 *
 *   gma3_speed_masters           read-only: the 16 speed masters (base and effective tempo, scale, learn mode, lock),
 *                                what follows each (sequences by speed and by rate, executors), the sound input and,
 *                                on request, how the masters move over a few seconds
 *   gma3_configure_speed_master  tempo (BPM, Hz or a period), speed scale and learn mode of one master
 *   gma3_speed_master_action     learn (tap), double, half, reset (Speed1) on one master
 *   gma3_observe_tempo           read-only: samples the current cue of running sequences and compares the step interval
 *                                with the one their timing and rate configuration predict
 *
 * Linking sequences to a master is gma3_configure_sequence (speed_master, rate_master, speed_scale, rate_scale,
 * speed_from_rate). Everything uses the existing ops (`children`, `objects`, `object`, `getfader`, `set`, `cmd`).
 *
 * Console facts this module relies on (onPC 2.5.1, docs/probes/sb-06-speed-macos-2.5.1.md):
 *   - Speed masters are ShowData.Masters.Speed (pool 3), `Master 3.N`; master 16 "BPM" follows the sound input.
 *   - The fader (0-100) is the base tempo: BPM = 225 * (fader/100)^log2(3.75) (50 = 60 BPM). The fader text is whole BPM,
 *     the effective tempo with "*" when scaled ("200 *B"). Effective = base * 2^SpeedScale.
 *   - `Master 3.N At BPM <x>` (also `At Hz`, `At Seconds`) sets the EFFECTIVE tempo, clamped silently to 0..225 * factor;
 *     DoubleSpeed / HalfSpeed step SpeedScale; Speed1 sets 60 BPM and scale One; `Learn Master 3.N` is one tap (the
 *     console times the taps). Commands land a frame later.
 *   - `set` writes SpeedScale and LearnMode; invalid values are silently ignored. Lock blocks those writes but not the
 *     commands; this module changes no locked master.
 *   - Sequences reference masters by name (SpeedMaster: phasers; RateMaster: cue timing, 60 BPM = 1:1, effective tempo
 *     times 2^RateScale). A linked sequence's rate fader is the master itself.
 *   - No input level or beat lock is readable for the sound input; phaser output is not readable on this onPC.
 */
import { z } from "zod";
import type { Gma3Bridge } from "../bridge.js";
import { json, operation, type RegisterTools, type ToolContext } from "./context.js";
import { findReferencesWhere, type References } from "./playback.js";
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
import { ValidationError, Validator, finiteNumber } from "../validate.js";

// ---------------------------------------------------------------------------
// Tempo model
// ---------------------------------------------------------------------------

export const SPEED_POOL = 3;
export const MASTER_COUNT = 16;
/** Master 16 follows the sound input. */
export const BPM_MASTER = 16;
export const MAX_BASE_BPM = 225;
const EXPONENT = Math.log2(3.75);

/** Base tempo of a speed-master (or rate) fader position 0-100. */
export function faderToBpm(fader: number): number {
  if (!(fader > 0)) return 0;
  return MAX_BASE_BPM * Math.pow(Math.min(fader, 100) / 100, EXPONENT);
}

export function bpmToFader(bpm: number): number {
  if (!(bpm > 0)) return 0;
  return 100 * Math.pow(Math.min(bpm, MAX_BASE_BPM) / MAX_BASE_BPM, 1 / EXPONENT);
}

/** SpeedScale (and RateScale) names -> power of two (Enums.SpeedScale on 2.5.1). */
export const SCALES: Record<string, number> = Object.fromEntries([
  ...[8, 7, 6, 5, 4, 3, 2, 1].map((e) => [`Div${2 ** e}`, -e]),
  ["One", 0],
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((e) => [`Mul${2 ** e}`, e]),
]);
const SCALE_BY_EXP = new Map(Object.entries(SCALES).map(([k, v]) => [v, k]));
export const scaleName = (exp: number): string | undefined => SCALE_BY_EXP.get(exp);
/** The exponent of a scale name as the console spells it (case-insensitive); undefined when unknown. */
export function scaleExponent(name: unknown): number | undefined {
  const n = typeof name === "string" ? name.trim().toLowerCase() : "";
  const hit = Object.keys(SCALES).find((k) => k.toLowerCase() === n);
  return hit === undefined ? undefined : SCALES[hit];
}

/** A requested scale: a console name ("Mul2", "div4", "one") or a power-of-two factor (2, 0.25, 1). */
export function parseScale(field: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") {
    const exp = value > 0 ? Math.log2(value) : NaN;
    const name = Number.isInteger(exp) ? scaleName(exp) : undefined;
    if (!name) throw new ValidationError(`${field} must be a power of two from 1/256 to 256 (got ${value})`, field);
    return name;
  }
  const exp = scaleExponent(value);
  if (exp === undefined) throw new ValidationError(`${field} must be one of ${Object.keys(SCALES).join(", ")} or a power-of-two factor (got ${JSON.stringify(value)})`, field);
  return scaleName(exp);
}

export const LEARN_MODES = {
  ignore_scale: "Learn Ignores Speed Scale",
  respect_scale: "Learn Respects Speed Scale",
  auto_increase_scale: "Auto Increase Speed Scale",
} as const;
type LearnKey = keyof typeof LEARN_MODES;
const learnKeyOf = (v: unknown): LearnKey | null =>
  (Object.entries(LEARN_MODES).find(([, s]) => s.toLowerCase() === String(v ?? "").trim().toLowerCase())?.[0] as LearnKey | undefined) ?? null;

/** "120 B", "200 *B", "1.0 B", "Stop" -> the tempo the console displays. */
export function parseFaderText(text: unknown): { bpm: number | null; scaled: boolean } {
  const s = typeof text === "string" ? text.trim() : "";
  if (/^stop$/i.test(s)) return { bpm: 0, scaled: false };
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(\*)?\s*B/i);
  return m ? { bpm: Number(m[1]), scaled: Boolean(m[2]) } : { bpm: null, scaled: false };
}

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const fmt = (x: number) => String(round(x, 3));
export const masterRef = (n: number) => `Master ${SPEED_POOL}.${n}`;

export function masterNumber(field: string, value: unknown): number {
  return finiteNumber(field, value, { integer: true, min: 1, max: MASTER_COUNT })!;
}

/** The tempo asked for as BPM, Hz or a period in seconds (at most one). */
export function tempoBpm(raw: { bpm?: unknown; hz?: unknown; seconds?: unknown }): number | undefined {
  const given = (["bpm", "hz", "seconds"] as const).filter((k) => raw[k] !== undefined && raw[k] !== null);
  if (given.length > 1) throw new ValidationError(`give one of bpm, hz and seconds (got ${given.join(", ")})`, given[1]);
  if (raw.bpm !== undefined && raw.bpm !== null) return finiteNumber("bpm", raw.bpm, { min: 0 });
  if (raw.hz !== undefined && raw.hz !== null) return finiteNumber("hz", raw.hz, { min: 0 })! * 60;
  if (raw.seconds !== undefined && raw.seconds !== null) return 60 / finiteNumber("seconds", raw.seconds, { min: 0.001 })!;
  return undefined;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface MasterState {
  master: number;
  ref: string;
  name: string;
  addr?: string;
  kind: "speed" | "bpm";
  /** Fader position 0-100 (the base tempo). */
  fader: number | null;
  baseBpm: number | null;
  speedScale: { name: string; factor: number | null };
  /** base * scale factor: the tempo that sequences and phasers follow. */
  effectiveBpm: number | null;
  /** The console's own tempo text and the tempo it shows (whole BPM). */
  consoleText: string | null;
  learnMode: LearnKey | string | null;
  faderEnable: string | null;
  locked: boolean | null;
  problems: string[];
}

interface Listing {
  total?: number;
  offset?: number;
  count?: number;
  items?: Array<{ name?: string; addr?: string; index?: number; class?: string; fields?: Record<string, unknown> }>;
}

const MASTER_FIELDS = ["Name", "SpeedScale", "LearnMode", "FaderEnable", "Lock"];

/** The speed pool's settings (one request) and each wanted master's fader (one request each). */
export async function readMasters(bridge: Gma3Bridge, numbers: number[], t: number): Promise<{ masters: MasterState[]; names: Map<number, string> }> {
  const pool = (await bridge.request("children", { ref: "ShowData.Masters.Speed", fields: MASTER_FIELDS, limit: 50 }, t)) as Listing;
  const byNo = new Map<number, NonNullable<Listing["items"]>[number]>();
  for (const it of pool.items ?? []) if (typeof it.index === "number") byNo.set(it.index, it);
  const names = new Map<number, string>();
  for (const [n, it] of byNo) names.set(n, String(it.fields?.Name ?? it.name ?? ""));
  const masters: MasterState[] = [];
  for (const n of numbers) {
    const it = byNo.get(n);
    const problems: string[] = [];
    const f = it?.fields ?? {};
    let fader: number | null = null;
    let text: string | null = null;
    try {
      const g = (await bridge.request("getfader", { ref: masterRef(n) }, t)) as { faders?: Record<string, { value?: unknown; text?: unknown }> };
      const fm = g.faders?.FaderMaster;
      fader = typeof fm?.value === "number" ? fm.value : null;
      text = typeof fm?.text === "string" ? fm.text : null;
    } catch (err) {
      problems.push(`the fader could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (fader === null && !problems.length) problems.push("the fader could not be read");
    const exp = scaleExponent(f.SpeedScale);
    if (exp === undefined) problems.push(`SpeedScale ${JSON.stringify(f.SpeedScale ?? null)} is not a known scale`);
    const base = fader === null ? null : faderToBpm(fader);
    const effective = base === null || exp === undefined ? null : base * 2 ** exp;
    const shown = parseFaderText(text);
    // The console's whole-BPM text is a cross-check of the model, not a second source.
    if (effective !== null && shown.bpm !== null && Math.abs(shown.bpm - effective) > Math.max(1, effective * 0.01)) problems.push(`the console shows ${text} but the fader and scale give ${round(effective)} BPM`);
    const lock = f.Lock === undefined ? null : String(f.Lock ?? "").trim() !== "" && !/^no$/i.test(String(f.Lock));
    masters.push({
      master: n,
      ref: masterRef(n),
      name: names.get(n) ?? "",
      addr: it?.addr,
      kind: n === BPM_MASTER ? "bpm" : "speed",
      fader: fader === null ? null : round(fader, 4),
      baseBpm: base === null ? null : round(base),
      speedScale: { name: exp === undefined ? String(f.SpeedScale ?? "") : scaleName(exp)!, factor: exp === undefined ? null : 2 ** exp },
      effectiveBpm: effective === null ? null : round(effective),
      consoleText: text,
      learnMode: learnKeyOf(f.LearnMode) ?? (f.LearnMode === undefined ? null : String(f.LearnMode)),
      faderEnable: f.FaderEnable === undefined ? null : String(f.FaderEnable),
      locked: lock,
      problems: it ? problems : [`${masterRef(n)} is not in ShowData.Masters.Speed`, ...problems],
    });
  }
  return { masters, names };
}

/** The master numbers carrying a name; more than one means the name (how sequences refer to it) is ambiguous. */
export function numbersByName(names: Map<number, string>): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const [n, name] of names) {
    const k = name.trim().toLowerCase();
    if (!k) continue;
    out.set(k, [...(out.get(k) ?? []), n]);
  }
  return out;
}

export interface SequenceLink {
  sequence: number;
  name: string;
  speedMaster: string | null;
  rateMaster: string | null;
  speedScale: string | null;
  rateScale: string | null;
  speedFromRate: boolean | null;
}

const SEQUENCE_LINK_FIELDS = ["SpeedMaster", "RateMaster", "SpeedScale", "RateScale", "SpeedFromRate"];
const noneOr = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return !s || /^none$/i.test(s) ? null : s;
};
const yes = (v: unknown): boolean | null => (v === true || /^(yes|on|true)$/i.test(String(v ?? "")) ? true : v === false || /^(no|off|false)$/i.test(String(v ?? "")) ? false : null);

/** Every sequence of the current data pool with its speed and rate links (one request). */
export async function readSequenceLinks(bridge: Gma3Bridge, t: number): Promise<{ sequences: SequenceLink[]; complete: boolean; total: number }> {
  const r = (await bridge.request("children", { ref: "DataPool.Sequences", fields: SEQUENCE_LINK_FIELDS, limit: 10000 }, t)) as Listing;
  const items = r.items ?? [];
  const sequences = items
    .filter((i) => typeof i.index === "number")
    .map((i) => ({
      sequence: i.index!,
      name: String(i.name ?? ""),
      speedMaster: noneOr(i.fields?.SpeedMaster),
      rateMaster: noneOr(i.fields?.RateMaster),
      speedScale: i.fields?.SpeedScale === undefined ? null : String(i.fields.SpeedScale),
      rateScale: i.fields?.RateScale === undefined ? null : String(i.fields.RateScale),
      speedFromRate: yes(i.fields?.SpeedFromRate),
    }));
  const total = typeof r.total === "number" ? r.total : items.length;
  return { sequences, complete: (r.offset ?? 0) + items.length >= total, total };
}

/** The sequence's rate relative to 1:1 when linked to a master of that effective tempo: (bpm / 60) * 2^RateScale. */
export function linkedRate(masterEffectiveBpm: number, rateScale: string | null): number | null {
  const exp = scaleExponent(rateScale ?? "One");
  return exp === undefined ? null : (masterEffectiveBpm / 60) * 2 ** exp;
}

export interface SoundStatus {
  inputDevice: string | null;
  deviceListed: boolean | null;
  devices: string[] | null;
  soundInLevel: number | null;
  bpmMaster: { master: number; effectiveBpm: number | null };
  beatDetection: "unavailable";
  notes: string[];
}

/** What the console exposes about the sound input. Never throws; each unreadable part is named. */
export async function readSound(bridge: Gma3Bridge, bpm16: number | null, t: number): Promise<SoundStatus> {
  const notes: string[] = [];
  let inputDevice: string | null = null;
  let devices: string[] | null = null;
  let level: number | null = null;
  try {
    const o = (await bridge.request("object", { ref: "Root.StationSettings.LocalSettings" }, t)) as { properties?: Record<string, unknown> };
    const key = Object.keys(o.properties ?? {}).find((k) => k.toLowerCase() === "onpcaudioindevicename");
    inputDevice = key ? String(o.properties![key] ?? "").trim() || null : null;
    if (!key) notes.push("no onPC audio input setting (OnPCAudioInDeviceName) on this station: the input device is unknown");
  } catch (err) {
    notes.push(`the audio input setting could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const d = (await bridge.request("children", { ref: "Root.Temp.AudioInDescriptions", fields: [], limit: 100 }, t)) as Listing;
    devices = (d.items ?? []).map((i) => String(i.name ?? ""));
  } catch (err) {
    notes.push(`the audio devices could not be listed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const g = (await bridge.request("getfader", { ref: "Master 2.SoundIn" }, t)) as { faders?: Record<string, { value?: unknown }> };
    const v = g.faders?.FaderMaster?.value;
    level = typeof v === "number" ? round(v) : null;
  } catch (err) {
    notes.push(`the SoundIn master could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const listed = inputDevice === null || devices === null ? null : devices.some((d) => d === inputDevice || d.includes(`<${inputDevice}>`));
  if (listed === false) notes.push(`the configured input "${inputDevice}" is not among the available devices`);
  if (level === 0) notes.push("the SoundIn master is at 0: the input is muted");
  notes.push("2.5.1 exposes no input level, beat detection or beat-lock state: whether master 16 is synchronised to the music cannot be read; its movement only shows activity (an operator or a surface moves it too)");
  return { inputDevice, deviceListed: listed, devices, soundInLevel: level, bpmMaster: { master: BPM_MASTER, effectiveBpm: bpm16 }, beatDetection: "unavailable", notes };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Samples the masters' faders for `seconds` and summarises how each moved. */
export async function observeMasters(bridge: Gma3Bridge, numbers: number[], seconds: number, intervalMs: number, t: number) {
  const series = new Map<number, number[]>(numbers.map((n) => [n, []]));
  const t0 = Date.now();
  let samples = 0;
  while (Date.now() - t0 < seconds * 1000) {
    for (const n of numbers) {
      const g = (await bridge.request("getfader", { ref: masterRef(n) }, t).catch(() => null)) as { faders?: Record<string, { value?: unknown }> } | null;
      const v = g?.faders?.FaderMaster?.value;
      if (typeof v === "number") series.get(n)!.push(v);
    }
    samples++;
    await sleep(intervalMs);
  }
  return numbers.map((n) => {
    const s = series.get(n)!;
    const bpm = s.map(faderToBpm);
    const changes = s.slice(1).filter((v, i) => Math.abs(v - s[i]) > 1e-4).length;
    return {
      master: n,
      samples: s.length,
      seconds: round((Date.now() - t0) / 1000, 1),
      baseBpm: bpm.length ? { first: round(bpm[0]), last: round(bpm.at(-1)!), min: round(Math.min(...bpm)), max: round(Math.max(...bpm)) } : null,
      moves: changes,
      note: changes ? "the base tempo moved without a command from this tool (sound input, an operator or a surface)" : "the base tempo did not move",
      ...(samples > s.length ? { unreadSamples: samples - s.length } : {}),
    };
  });
}

export async function speedMasters(ctx: ToolContext, raw: { masters?: unknown; usage?: boolean; sound?: boolean; observe_seconds?: unknown }): Promise<unknown> {
  const v = new Validator();
  const numbers =
    raw.masters === undefined || raw.masters === null
      ? Array.from({ length: MASTER_COUNT }, (_, i) => i + 1)
      : Array.isArray(raw.masters) && raw.masters.length
        ? [...new Set(raw.masters.map((m, i) => v.check(() => masterNumber(`masters[${i}]`, m))).filter((x): x is number => x !== undefined))]
        : (v.fail("masters must be a non-empty list of 1-16"), []);
  const observe = v.check(() => finiteNumber("observe_seconds", raw.observe_seconds, { min: 0, max: 10, optional: true })) ?? 0;
  if (!v.ok) throw new ValidationError(v.errors.join("; "));
  const bridge = ctx.bridge;
  const t = ctx.requestTimeoutMs;
  const { masters, names } = await readMasters(bridge, numbers, t);
  const byName = numbersByName(names);
  const out: Record<string, unknown> = {};
  for (const m of masters) {
    const dup = byName.get(m.name.trim().toLowerCase()) ?? [];
    if (dup.length > 1) m.problems.push(`its name "${m.name}" is shared with master(s) ${dup.filter((x) => x !== m.master).join(", ")}: sequences refer to masters by name, so links to it are ambiguous`);
    if (!m.name.trim()) m.problems.push("it has no name, so no sequence can be linked to it");
  }
  const warnings: string[] = [];
  if (raw.usage !== false) {
    const links = await readSequenceLinks(bridge, t).catch((err: unknown) => {
      warnings.push(`the sequences could not be read: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    const isSpeedAddr = (addr: string) => masters.some((m) => m.addr === addr);
    const execs: References | null = await findReferencesWhere(bridge, isSpeedAddr, t);
    if (links && !links.complete) warnings.push(`only ${links.sequences.length} of ${links.total} sequences were read: the usage lists are incomplete`);
    if (execs && !execs.complete) warnings.push(`the executor scan was incomplete: ${execs.error ?? "unknown reason"}`);
    const unresolved = new Set<string>();
    out.usage = masters.map((m) => {
      const key = m.name.trim().toLowerCase();
      const speed = (links?.sequences ?? []).filter((s) => s.speedMaster?.toLowerCase() === key);
      const rate = (links?.sequences ?? []).filter((s) => s.rateMaster?.toLowerCase() === key);
      return {
        master: m.master,
        name: m.name,
        // Phasers in these sequences' cues follow the master (unless a cue part or attribute names another).
        speedOf: speed.map((s) => ({ sequence: s.sequence, name: s.name, speedScale: s.speedScale })),
        // Cue timing (fades, delays, trigger times) of these sequences runs at the master's tempo / 60.
        rateOf: rate.map((s) => ({ sequence: s.sequence, name: s.name, rateScale: s.rateScale, rate: m.effectiveBpm === null ? null : round(linkedRate(m.effectiveBpm, s.rateScale) ?? NaN, 4), speedFromRate: s.speedFromRate })),
        executors: (execs?.executors ?? []).filter((e) => e.addr === m.addr).map((e) => e.ref),
      };
    });
    for (const s of links?.sequences ?? []) for (const name of [s.speedMaster, s.rateMaster]) if (name && !byName.has(name.toLowerCase())) unresolved.add(name);
    if (unresolved.size) warnings.push(`sequences name masters that are not speed masters of this show: ${[...unresolved].join(", ")}`);
  }
  const m16 = masters.find((m) => m.master === BPM_MASTER);
  if (raw.sound !== false) out.sound = await readSound(bridge, m16?.effectiveBpm ?? null, t);
  if (observe > 0) out.observed = await observeMasters(bridge, raw.masters === undefined ? [BPM_MASTER] : numbers, observe, 100, t);
  return {
    masters: masters.map((m) => ({
      ...m,
      capabilities: {
        manual_tempo: "gma3_configure_speed_master (bpm, hz or seconds)",
        tap_tempo: "gma3_speed_master_action learn: the console times the taps",
        sound: m.master === BPM_MASTER ? "follows the sound input (see sound); a manual tempo snaps to a multiple of the detected BPM" : "none: only master 16 follows the sound input",
      },
    })),
    ...out,
    ...(warnings.length ? { warnings } : {}),
    note: "baseBpm is the fader; effectiveBpm = base * speed scale is what follows the master. Configured values only: the tempo actually playing is measured by gma3_observe_tempo for timed chases; phaser output is not observable over the bridge.",
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Reads a master again until `ok` holds (commands land a frame later), at most ~1 s. */
async function readBack(bridge: Gma3Bridge, n: number, t: number, ok: (m: MasterState) => boolean): Promise<MasterState> {
  let last: MasterState | undefined;
  for (let i = 0; i < 8; i++) {
    if (i) await sleep(i < 3 ? 60 : 150);
    last = (await readMasters(bridge, [n], t)).masters[0];
    if (ok(last)) break;
  }
  return last!;
}

const within = (a: number | null, b: number, tol: number) => a !== null && Math.abs(a - b) <= tol;
const bpmTolerance = (bpm: number) => Math.max(0.05, bpm * 0.0005);

/** The followers of a master, for the warnings of a change. */
async function followers(bridge: Gma3Bridge, name: string, t: number): Promise<string | null> {
  const links = await readSequenceLinks(bridge, t).catch(() => null);
  if (!links) return "the sequences that follow this master could not be read";
  const key = name.trim().toLowerCase();
  const speed = links.sequences.filter((s) => s.speedMaster?.toLowerCase() === key).map((s) => s.sequence);
  const rate = links.sequences.filter((s) => s.rateMaster?.toLowerCase() === key).map((s) => s.sequence);
  if (!speed.length && !rate.length) return null;
  return `this changes every sequence that follows ${name}: ${[rate.length ? `rate (cue timing) of Sequence ${rate.join(", ")}` : "", speed.length ? `phaser speed of Sequence ${speed.join(", ")}` : ""].filter(Boolean).join("; ")}`;
}

function setStep(ctx: ToolContext, name: string, ref: string, property: string, value: string): () => Promise<StepResult> {
  return () =>
    requestStep(ctx.bridge, name, "set", { ref, property, value }, (res) => {
      const got = (res as { value?: unknown } | null)?.value;
      if (got === undefined || got === null) return { name, status: "unknown", op: "set", detail: { ref, property, sent: value }, error: `${property} could not be read back after the write` };
      if (String(got).trim().toLowerCase() !== value.toLowerCase()) return { name, status: "failed", op: "set", detail: { ref, property, sent: value, readBack: got }, error: `the console did not apply ${property}=${value}: it reads ${JSON.stringify(got)} (the console silently keeps the previous value when it does not accept one)` };
      return { name, status: "succeeded", op: "set", detail: { ref, property, value: got } };
    }, ctx.requestTimeoutMs);
}

function describeMaster(m: MasterState) {
  const { master, name, fader, baseBpm, speedScale, effectiveBpm, consoleText, learnMode, locked } = m;
  return { master, name, fader, baseBpm, speedScale, effectiveBpm, consoleText, learnMode, locked };
}

interface ConfigureArgs {
  master: unknown;
  bpm?: unknown;
  hz?: unknown;
  seconds?: unknown;
  speed_scale?: unknown;
  learn_mode?: unknown;
  preview?: boolean;
  verify?: boolean;
}

export async function configureSpeedMaster(ctx: ToolContext, raw: ConfigureArgs): Promise<OperationResult> {
  const op = "configure_speed_master";
  const v = new Validator();
  const n = v.check(() => masterNumber("master", raw.master));
  const bpm = v.check(() => tempoBpm(raw));
  const scale = v.check(() => parseScale("speed_scale", raw.speed_scale));
  let learn: LearnKey | undefined;
  if (raw.learn_mode !== undefined && raw.learn_mode !== null) {
    if (typeof raw.learn_mode === "string" && raw.learn_mode in LEARN_MODES) learn = raw.learn_mode as LearnKey;
    else v.fail(`learn_mode must be one of ${Object.keys(LEARN_MODES).join(", ")}`);
  }
  const target: Record<string, unknown> = { master: raw.master };
  if (v.ok && bpm === undefined && scale === undefined && learn === undefined) v.fail("nothing to configure: give bpm, hz or seconds, speed_scale or learn_mode");
  if (v.ok && bpm !== undefined) {
    const factor = 2 ** SCALES[scale ?? "One"];
    // Only checkable against the final scale once the current one is known (below) when speed_scale is not given.
    if (scale !== undefined && bpm > MAX_BASE_BPM * factor) v.fail(`bpm ${round(bpm)} is above ${MAX_BASE_BPM * factor} BPM, the most a master can reach with SpeedScale ${scale}; the console would clamp it silently`);
  }
  if (!v.ok || n === undefined) return validationFailure(op, target, v.errors);
  const ref = masterRef(n);
  target.ref = ref;
  const bridge = ctx.bridge;
  const t = ctx.requestTimeoutMs;

  const body = async (): Promise<OperationResult> => {
    let before: MasterState | undefined;
    const inspect = await runSteps([
      {
        name: "read_master",
        run: async () => {
          try {
            before = (await readMasters(bridge, [n], t)).masters[0];
          } catch (err) {
            return asRead(stepFromError("read_master", err, { op: "children" }));
          }
          if (before.problems.length) return asRead({ name: "read_master", status: "failed", op: "getfader", detail: describeMaster(before), error: `${ref} could not be read completely: ${before.problems.join("; ")}` });
          if (before.locked !== false) return asRead({ name: "read_master", status: "failed", op: "children", detail: describeMaster(before), error: before.locked ? `${ref} is locked: the console ignores its settings (and the tool changes no locked master); unlock it first` : `the Lock of ${ref} could not be read` });
          const exp = SCALES[scale ?? before.speedScale.name];
          if (bpm !== undefined && bpm > MAX_BASE_BPM * 2 ** exp) return asRead({ name: "read_master", status: "failed", detail: describeMaster(before), error: `bpm ${round(bpm)} is above ${MAX_BASE_BPM * 2 ** exp} BPM, the most ${ref} reaches with SpeedScale ${scaleName(exp)}; the console would clamp it silently. Raise speed_scale too` });
          return asRead({ name: "read_master", status: "succeeded", op: "getfader", detail: describeMaster(before) });
        },
      },
    ]);
    if (inspect.outcome !== "succeeded" || !before) return buildResult({ operation: op, target, steps: inspect.steps, summary: `${op} was not performed; nothing was sent: ${inspect.steps[0].error}` });
    const b = before;
    const warnings: string[] = [];
    if (n === BPM_MASTER) warnings.push("master 16 follows the sound input: a manual tempo snaps to a multiple of the detected BPM and moves with the music");
    const f = await followers(bridge, b.name, t);
    if (f) warnings.push(f);
    const plan: Array<{ name: string; run: () => Promise<StepResult> }> = [];
    if (learn && learnKeyOf(LEARN_MODES[learn]) !== b.learnMode) plan.push({ name: "set_learn_mode", run: setStep(ctx, "set_learn_mode", ref, "LearnMode", LEARN_MODES[learn]) });
    // The scale before the tempo: `At BPM` sets the effective tempo under the scale it finds.
    if (scale && scale !== b.speedScale.name) plan.push({ name: "set_speed_scale", run: setStep(ctx, "set_speed_scale", ref, "SpeedScale", scale) });
    const command = bpm === undefined ? undefined : `${ref} At BPM ${fmt(bpm)}`;
    if (command) plan.push({ name: "set_tempo", run: () => commandStep(bridge, "set_tempo", command, t) });
    const finalExp = SCALES[scale ?? b.speedScale.name];
    const expected = {
      speedScale: scaleName(finalExp),
      effectiveBpm: bpm !== undefined ? round(bpm, 3) : b.baseBpm === null ? null : round(b.baseBpm * 2 ** finalExp, 3),
      ...(learn ? { learnMode: learn } : {}),
    };
    const extra = { before: describeMaster(b), expected, ...(command ? { command } : {}) };
    if (raw.preview === true) return buildResult({ operation: op, target, steps: inspect.steps, summary: `Preview only; nothing was sent. ${plan.map((p) => p.name).join(", ") || "nothing to change"}.`, warnings, extra: { ...extra, preview: true } });
    if (!plan.length) return buildResult({ operation: op, target, steps: inspect.steps, summary: `${ref} already has the requested settings; nothing was sent.`, warnings, extra: { ...extra, noop: true } });
    const run = await runSteps(plan);
    const steps = [...inspect.steps, ...run.steps];
    let verification: Verification = notRequested();
    let after: MasterState | undefined;
    if (raw.verify !== false && run.outcome !== "failed") {
      const ok = (m: MasterState) =>
        m.speedScale.name === expected.speedScale && (expected.effectiveBpm === null || within(m.fader === null || m.speedScale.factor === null ? null : faderToBpm(m.fader) * m.speedScale.factor, expected.effectiveBpm, bpmTolerance(expected.effectiveBpm))) && (!learn || m.learnMode === learn);
      try {
        after = await readBack(bridge, n, t, ok);
        steps.push(asRead({ name: "read_back", status: "succeeded", op: "getfader", detail: describeMaster(after) }));
        const checked = `the SpeedScale, effective tempo (fader and scale)${learn ? " and LearnMode" : ""} of ${ref}`;
        verification = ok(after)
          ? { status: "matched", checked, expected, actual: describeMaster(after) }
          : { status: "mismatched", checked, expected, actual: describeMaster(after), detail: n === BPM_MASTER ? "master 16 follows the sound input, which may have moved it" : "the console did not end up with the requested settings" };
      } catch (err) {
        steps.push(asRead(stepFromError("read_back", err, { op: "getfader" })));
        verification = unavailable("the master could not be read back");
      }
    }
    return buildResult({ operation: op, target, steps, verification, warnings, extra: { ...extra, ...(after ? { after: describeMaster(after) } : {}) } });
  };
  return raw.preview === true ? body() : ctx.mutations.run(body);
}

const ACTIONS = { learn: "Learn", double: "DoubleSpeed", half: "HalfSpeed", reset: "Speed1" } as const;
type Action = keyof typeof ACTIONS;

interface ActionArgs {
  master: unknown;
  action: unknown;
  taps?: unknown;
  interval_ms?: unknown;
  preview?: boolean;
  verify?: boolean;
}

export async function speedMasterAction(ctx: ToolContext, raw: ActionArgs): Promise<OperationResult> {
  const op = "speed_master_action";
  const v = new Validator();
  const n = v.check(() => masterNumber("master", raw.master));
  const action = typeof raw.action === "string" && raw.action in ACTIONS ? (raw.action as Action) : (v.fail(`action must be one of ${Object.keys(ACTIONS).join(", ")}`), undefined);
  const taps = v.check(() => finiteNumber("taps", raw.taps, { integer: true, min: 1, max: 16, optional: true })) ?? 1;
  const interval = v.check(() => finiteNumber("interval_ms", raw.interval_ms, { min: 100, max: 10000, optional: true }));
  if (action && action !== "learn" && (raw.taps !== undefined || raw.interval_ms !== undefined)) v.fail("taps and interval_ms are for action learn only");
  if (action === "learn" && taps > 1 && interval === undefined) v.fail("several taps need interval_ms, the time between them");
  const target: Record<string, unknown> = { master: raw.master, action: raw.action };
  if (!v.ok || n === undefined || !action) return validationFailure(op, target, v.errors);
  const ref = masterRef(n);
  target.ref = ref;
  const bridge = ctx.bridge;
  const t = ctx.requestTimeoutMs;
  const command = `${ACTIONS[action]} ${ref}`;

  const body = async (): Promise<OperationResult> => {
    let before: MasterState | undefined;
    const inspect = await runSteps([
      {
        name: "read_master",
        run: async () => {
          try {
            before = (await readMasters(bridge, [n], t)).masters[0];
          } catch (err) {
            return asRead(stepFromError("read_master", err, { op: "children" }));
          }
          if (before.problems.length) return asRead({ name: "read_master", status: "failed", detail: describeMaster(before), error: `${ref} could not be read completely: ${before.problems.join("; ")}` });
          if (before.locked !== false) return asRead({ name: "read_master", status: "failed", detail: describeMaster(before), error: before.locked ? `${ref} is locked; the tool changes no locked master (the console would still take the command)` : `the Lock of ${ref} could not be read` });
          const exp = SCALES[before.speedScale.name];
          if (action === "double" && exp >= 8) return asRead({ name: "read_master", status: "failed", detail: describeMaster(before), error: `${ref} is at Mul256, the highest scale` });
          if (action === "half" && exp <= -8) return asRead({ name: "read_master", status: "failed", detail: describeMaster(before), error: `${ref} is at Div256, the lowest scale` });
          return asRead({ name: "read_master", status: "succeeded", detail: describeMaster(before) });
        },
      },
    ]);
    if (inspect.outcome !== "succeeded" || !before) return buildResult({ operation: op, target, steps: inspect.steps, summary: `${op} was not performed; nothing was sent: ${inspect.steps[0].error}` });
    const b = before;
    const warnings: string[] = [];
    const f = await followers(bridge, b.name, t);
    if (f) warnings.push(f);
    if (n === BPM_MASTER) warnings.push("master 16 follows the sound input and may move again at any time");
    const exp = SCALES[b.speedScale.name];
    // What the console should hold afterwards, where it is predictable.
    let expectation: { check: (m: MasterState) => boolean; describe: Record<string, unknown> } | null = null;
    if (action === "double" || action === "half") {
      const e = scaleName(exp + (action === "double" ? 1 : -1))!;
      expectation = { check: (m) => m.speedScale.name === e && within(m.fader, b.fader!, 0.01), describe: { speedScale: e, baseBpm: b.baseBpm } };
    } else if (action === "reset") {
      expectation = { check: (m) => m.speedScale.name === "One" && within(m.baseBpm, 60, 0.05), describe: { speedScale: "One", baseBpm: 60 } };
    }
    const extra: Record<string, unknown> = { before: describeMaster(b), command, ...(action === "learn" ? { taps, ...(interval !== undefined ? { intervalMs: interval } : {}) } : {}) };
    if (raw.preview === true) return buildResult({ operation: op, target, steps: inspect.steps, summary: `Preview only; nothing was sent. ${command}${taps > 1 ? ` x${taps}, ${interval} ms apart` : ""}.`, warnings, extra: { ...extra, preview: true } });

    const steps = [...inspect.steps];
    const sent: number[] = [];
    for (let i = 0; i < (action === "learn" ? taps : 1); i++) {
      const t0 = Date.now();
      const s = await commandStep(bridge, action === "learn" ? `tap_${i + 1}` : action, command, t);
      sent.push(Date.now());
      steps.push(s);
      if (s.status !== "succeeded") break;
      if (action === "learn" && i < taps - 1) await sleep(Math.max(0, interval! - (Date.now() - t0)));
    }
    if (action === "learn" && sent.length > 1) {
      const gaps = sent.slice(1).map((x, i) => x - sent[i]);
      const mean = gaps.reduce((a, c) => a + c, 0) / gaps.length;
      const tapped = 60000 / mean;
      extra.tapped = { meanIntervalMs: round(mean, 1), bpm: round(tapped), note: "measured where the taps were sent; the console times them on arrival, so network jitter shifts the learned tempo" };
      // Ignores / Auto Increase: the effective tempo is the tapped one; Respects: the base is.
      expectation = b.learnMode === "respect_scale"
        ? { check: (m) => within(m.baseBpm, tapped, tapped * 0.05), describe: { baseBpm: round(tapped), tolerance: "5%" } }
        : { check: (m) => within(m.effectiveBpm, tapped, tapped * 0.05), describe: { effectiveBpm: round(tapped), tolerance: "5%" } };
    }
    let verification: Verification = notRequested();
    let after: MasterState | undefined;
    const failed = steps.some((s) => s.status !== "succeeded");
    if (raw.verify !== false && !failed) {
      try {
        after = await readBack(bridge, n, t, expectation?.check ?? (() => false));
        steps.push(asRead({ name: "read_back", status: "succeeded", op: "getfader", detail: describeMaster(after) }));
        if (!expectation) verification = unavailable("one tap gives the console no interval: the tempo is learned from the time between taps (tap again, or pass taps and interval_ms)", `the tempo of ${ref}`);
        else {
          const checked = `the tempo and SpeedScale of ${ref}`;
          verification = expectation.check(after) ? { status: "matched", checked, expected: expectation.describe, actual: describeMaster(after) } : { status: "mismatched", checked, expected: expectation.describe, actual: describeMaster(after) };
        }
      } catch (err) {
        steps.push(asRead(stepFromError("read_back", err, { op: "getfader" })));
        verification = unavailable("the master could not be read back");
      }
    }
    return buildResult({ operation: op, target, steps, verification, warnings, extra: { ...extra, ...(after ? { after: describeMaster(after) } : {}) } });
  };
  return raw.preview === true ? body() : ctx.mutations.run(body);
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

interface CueInfo {
  no: number;
  addr?: string;
  name?: string;
  trigType: string | null;
  trigTime: number | null;
}

/** Cue number from a sequence child read with asText: false (No is x1000; OffCue has none, CueZero is 0). */
function cueNo(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v / 1000;
  const m = typeof v === "string" ? v.trim().match(/^(\d+(?:\.\d+)?)/) : null;
  return m ? Number(m[1]) : null;
}

const seconds = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const m = typeof v === "string" ? v.trim().match(/^(\d+(?:\.\d+)?)/) : null;
  return m ? Number(m[1]) : null;
};

/** The step interval a sequence's configuration predicts: every cue Time-triggered with one TrigTime, divided by the rate. */
export function predictedStep(cues: CueInfo[], rate: number | null): { ms: number | null; reason?: string } {
  if (rate === null) return { ms: null, reason: "the rate is unknown" };
  if (rate <= 0) return { ms: null, reason: "the rate is 0: the chase does not advance" };
  if (cues.length < 2) return { ms: null, reason: "fewer than two cues" };
  if (!cues.every((c) => c.trigType?.toLowerCase() === "time")) return { ms: null, reason: "not every cue is Time-triggered, so the step interval also depends on fades, follows or operators" };
  const times = new Set(cues.map((c) => c.trigTime));
  if (times.size !== 1 || cues[0].trigTime === null) return { ms: null, reason: "the cues have different trigger times" };
  return { ms: round((cues[0].trigTime * 1000) / rate, 1) };
}

export async function observeTempo(ctx: ToolContext, raw: { sequences: unknown; seconds?: unknown; interval_ms?: unknown }): Promise<unknown> {
  const v = new Validator();
  const seqs = Array.isArray(raw.sequences) && raw.sequences.length && raw.sequences.length <= 8
    ? [...new Set(raw.sequences.map((s, i) => v.check(() => finiteNumber(`sequences[${i}]`, s, { integer: true, min: 1, max: 99999 }))).filter((x): x is number => x !== undefined))]
    : (v.fail("sequences must list 1 to 8 sequence numbers"), []);
  const secs = v.check(() => finiteNumber("seconds", raw.seconds, { min: 1, max: 30, optional: true })) ?? 6;
  const intervalMs = v.check(() => finiteNumber("interval_ms", raw.interval_ms, { min: 20, max: 1000, optional: true })) ?? 40;
  if (!v.ok) throw new ValidationError(v.errors.join("; "));
  const bridge = ctx.bridge;
  const t = ctx.requestTimeoutMs;
  const { masters: allMasters, names } = await readMasters(bridge, Array.from({ length: MASTER_COUNT }, (_, i) => i + 1), t);
  const byName = numbersByName(names);
  const masterOf = (name: string | null) => {
    if (!name) return null;
    const hits = byName.get(name.toLowerCase()) ?? [];
    return hits.length === 1 ? allMasters.find((m) => m.master === hits[0]) ?? null : null;
  };

  interface Watched { sequence: number; ref: string; config: Record<string, unknown>; cues: CueInfo[]; predicted: { ms: number | null; reason?: string }; notes: string[] }
  const watched: Watched[] = [];
  for (const s of seqs) {
    const ref = `Sequence ${s}`;
    const notes: string[] = [];
    const o = (await bridge.request("objects", { ref, fields: ["Name", ...SEQUENCE_LINK_FIELDS, "WrapAround"], limit: 1 }, t)) as Listing;
    const it = o.items?.[0];
    if (!it) throw new ValidationError(`${ref} does not exist`);
    const f = it.fields ?? {};
    const rateMaster = noneOr(f.RateMaster);
    const speedMaster = noneOr(f.SpeedMaster);
    const rm = masterOf(rateMaster);
    let rate: number | null = null;
    let rateSource: Record<string, unknown>;
    if (rateMaster) {
      if (!rm) notes.push(`its rate master "${rateMaster}" does not resolve to exactly one speed master`);
      rate = rm?.effectiveBpm === null || !rm ? null : linkedRate(rm.effectiveBpm, String(f.RateScale ?? "One"));
      rateSource = { kind: "speed master", master: rm?.master ?? null, name: rateMaster, effectiveBpm: rm?.effectiveBpm ?? null };
    } else {
      const g = (await bridge.request("getfader", { ref, tokens: ["FaderRate"] }, t).catch(() => null)) as { faders?: Record<string, { value?: unknown }> } | null;
      const fv = g?.faders?.FaderRate?.value;
      const exp = scaleExponent(String(f.RateScale ?? "One"));
      rate = typeof fv === "number" && exp !== undefined ? (faderToBpm(fv) / 60) * 2 ** exp : null;
      rateSource = { kind: "own rate fader", fader: typeof fv === "number" ? round(fv, 3) : null };
    }
    const sm = masterOf(speedMaster);
    const kids = (await bridge.request("children", { ref, fields: ["No", "TrigType", "TrigTime"], asText: false, limit: 1000 }, t)) as Listing;
    const cues: CueInfo[] = (kids.items ?? [])
      .map((c) => ({ no: cueNo(c.fields?.No) ?? -1, addr: c.addr, name: c.name, trigType: c.fields?.TrigType === undefined ? null : String(c.fields.TrigType), trigTime: seconds(c.fields?.TrigTime) }))
      .filter((c) => c.no > 0);
    watched.push({
      sequence: s,
      ref,
      cues,
      notes,
      predicted: predictedStep(cues, rate),
      config: {
        name: it.name,
        rate: rate === null ? null : round(rate, 4),
        rateSource,
        rateScale: f.RateScale ?? null,
        speedMaster: speedMaster ? { name: speedMaster, master: sm?.master ?? null, effectiveBpm: sm?.effectiveBpm ?? null, observable: false, note: "phasers in its cues follow this master; their output is not observable over the bridge" } : null,
        speedFromRate: yes(f.SpeedFromRate),
      },
    });
  }

  // Sampling: the current cue of each sequence, one request per sequence per tick.
  const changes = new Map<number, Array<{ ms: number; cue: number | string | null }>>(seqs.map((s) => [s, []]));
  const last = new Map<number, string>();
  const t0 = Date.now();
  let ticks = 0;
  let maxTickMs = 0;
  while (Date.now() - t0 < secs * 1000) {
    const tick0 = Date.now();
    for (const w of watched) {
      const r = (await bridge.request("objects", { ref: w.ref, fields: ["CurrentCue"], asText: false, limit: 1 }, t).catch(() => null)) as Listing | null;
      const cur = r?.items?.[0]?.fields?.CurrentCue as { addr?: string; name?: string } | undefined;
      const key = cur && typeof cur === "object" ? `${cur.addr ?? ""}|${cur.name ?? ""}` : "none";
      if (last.has(w.sequence) && last.get(w.sequence) !== key) {
        const cue = cur && typeof cur === "object" ? w.cues.find((c) => c.addr === cur.addr)?.no ?? cur.name ?? null : null;
        changes.get(w.sequence)!.push({ ms: Date.now() - t0, cue });
      }
      last.set(w.sequence, key);
    }
    ticks++;
    maxTickMs = Math.max(maxTickMs, Date.now() - tick0);
    await sleep(intervalMs);
  }
  const elapsed = Date.now() - t0;
  return {
    seconds: round(elapsed / 1000, 2),
    samplesPerSequence: ticks,
    resolutionMs: round(intervalMs + maxTickMs, 0),
    sequences: watched.map((w) => {
      const c = changes.get(w.sequence)!;
      const gaps = c.slice(1).map((x, i) => x.ms - c[i].ms);
      const mean = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
      const deviation = mean !== null && w.predicted.ms !== null ? round(mean / w.predicted.ms - 1, 3) : null;
      return {
        sequence: w.sequence,
        configured: { ...w.config, predictedStepMs: w.predicted.ms, ...(w.predicted.reason ? { notPredicted: w.predicted.reason } : {}) },
        observed: {
          cueChanges: c.length,
          meanStepMs: mean === null ? null : round(mean, 1),
          stepsPerMinute: mean ? round(60000 / mean, 2) : null,
          ...(deviation !== null ? { deviationFromPredicted: deviation } : {}),
          changes: c.slice(0, 40),
          ...(c.length === 0 ? { note: "no cue change was seen: the sequence is not running, not advancing, or slower than the window" } : c.length === 1 ? { note: "one cue change: an interval needs at least two" } : {}),
        },
        ...(w.notes.length ? { notes: w.notes } : {}),
      };
    }),
    note: "observed = when the sequence's current cue changed, sampled over the bridge (resolutionMs is the sampling granularity); configured = the trigger times and the rate from the rate master or the sequence's own rate fader. Phaser tempo is configured only: it is not observable here.",
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const scaleSchema = z.union([z.string(), z.number()]).optional();

/** A read-only tool's JSON, or its error as a tool error. */
async function readOnly(fn: () => Promise<unknown>) {
  try {
    return json(await fn());
  } catch (err) {
    return { content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}

export const registerSpeedTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_speed_masters",
    {
      title: "Read the speed masters, what follows them, and the sound input",
      description:
        "Read-only. The 16 speed masters (Master 3.N): name, fader, base BPM (from the fader: 50 = 60 BPM), speed scale, effective BPM (base x scale, what followers use), the console's own tempo text, learn mode, lock and problems (duplicate names make links ambiguous). " +
        "usage (default true): per master the sequences that follow it by speed (phasers in their cues) and by rate (cue timing; the rate is effective BPM / 60 x RateScale) and the executors holding it. " +
        "sound (default true): the onPC audio input device, the available devices, the SoundIn level and master 16 (the BPM master, driven by the input); beat detection and lock are not readable on 2.5.1, so synchronisation is never claimed. " +
        "observe_seconds (0-10): samples the masters (master 16 when masters is not given) and reports how they moved. Distinct from timing masters (pool 5, fixed seconds) and cue timing.",
      inputSchema: {
        masters: z.array(z.number()).optional().describe("Master numbers 1-16 (default all)."),
        usage: z.boolean().optional(),
        sound: z.boolean().optional(),
        observe_seconds: z.number().optional(),
      },
    },
    async (args) => readOnly(() => speedMasters(ctx, args)),
  );

  server.registerTool(
    "gma3_configure_speed_master",
    {
      title: "Set a speed master's tempo, scale and learn mode",
      description:
        "Sets one speed master (1-16): the tempo as bpm, hz or seconds (one of them; it is the EFFECTIVE tempo under the final speed scale, 0 stops the master, at most 225 x the scale factor), speed_scale (One, Mul2..Mul256, Div2..Div256 or a power-of-two factor) and learn_mode (ignore_scale, respect_scale, auto_increase_scale: how taps treat the scale). " +
        "Sends `set LearnMode`, `set SpeedScale` and `Master 3.N At BPM x`, in that order. Refuses a locked master. Every sequence linked to the master follows the change (named in warnings). Master 16 follows the sound input and may move again. Reads the fader and scale back (verify, default true); preview: true sends nothing.",
      inputSchema: {
        master: z.number(),
        bpm: z.number().optional(),
        hz: z.number().optional(),
        seconds: z.number().optional().describe("Period of one beat in seconds."),
        speed_scale: scaleSchema,
        learn_mode: z.enum(["ignore_scale", "respect_scale", "auto_increase_scale"]).optional(),
        preview: z.boolean().optional(),
        verify: z.boolean().optional(),
      },
    },
    async (args) => operation(() => configureSpeedMaster(ctx, args)),
  );

  server.registerTool(
    "gma3_speed_master_action",
    {
      title: "Tap, double, halve or reset a speed master",
      description:
        "action learn: `Learn Master 3.N`, one tap (the console times the taps itself; taps with interval_ms send several, with the network's jitter); double / half: DoubleSpeed / HalfSpeed (the speed scale one step up or down, the fader stays); reset: Speed1 (60 BPM, scale One). " +
        "Refuses a locked master. Verifies the scale and tempo afterwards; a single tap cannot be verified (the console needs an interval).",
      inputSchema: {
        master: z.number(),
        action: z.enum(["learn", "double", "half", "reset"]),
        taps: z.number().optional().describe("learn only: taps to send (1-16, default 1)."),
        interval_ms: z.number().optional().describe("learn only: time between taps (100-10000 ms)."),
        preview: z.boolean().optional(),
        verify: z.boolean().optional(),
      },
    },
    async (args) => operation(() => speedMasterAction(ctx, args)),
  );

  server.registerTool(
    "gma3_observe_tempo",
    {
      title: "Measure how fast running sequences advance",
      description:
        "Read-only. Samples the current cue of 1-8 running sequences for `seconds` (1-30, default 6) every interval_ms (default 40) and reports the observed step interval next to the configured one: the rate (rate master's effective BPM / 60 x RateScale, or the sequence's own rate fader) and, for chases whose cues are all Time-triggered with one trigger time, the predicted step interval. " +
        "It starts nothing: run the sequences first. The phaser tempo (speed master) is reported as configured only; phaser output is not observable over the bridge.",
      inputSchema: {
        sequences: z.array(z.number()),
        seconds: z.number().optional(),
        interval_ms: z.number().optional(),
      },
    },
    async (args) => readOnly(() => observeTempo(ctx, args)),
  );
};
