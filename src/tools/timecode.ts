/**
 * SB-08: timecode shows from structured timestamps.
 *
 *   gma3_timecodes           read-only: the timecode pool, or one show (settings, source, track groups, tracks with
 *                            their targets, time ranges, events with exact times, actions and cues) and its problems;
 *                            optionally the 16 timecode slots
 *   gma3_build_timecode      create a show, replace its tracks or append tracks: sequence tracks of cue events at
 *                            explicit times; never plays or records
 *   gma3_timecode_transport  play (Go), stop (Off), rewind (Top) or seek (Cursor), then observe the cursor and the target
 *                            sequences and check the events crossed against what they should have done
 *
 * Bridge 0.25.0 adds `timecode.read` and `timecode.edit` (events have no command-line address). Console facts this module
 * relies on (onPC 2.5.1, docs/probes/sb-08-timecode-macos-2.5.1.md):
 *   - Show > TrackGroup (with a MarkerTrack and Tracks) > Track (Target) > TimeRange > CmdSubTrack > CmdEvent. A new
 *     TrackGroup brings one Track, a new Track one TimeRange, a frame later; a subtrack needs a target set a frame earlier.
 *   - An event's time is RawTime = seconds * 2^24 (1/16777216 s). Events keep their storage order, not time order; the show
 *     runs them by time, and events at the same time in storage order.
 *   - Token: Go+, Go-, Goto (CueDestination), On, Off, Toggle, Top, Pause, Kill, Flash / Temp with Status On (press) and Off
 *     (release, named "Flash(Release)"). An unknown token is silently ignored.
 *   - `Go Timecode N` plays from the cursor, `Off` stops (by default keeping the playbacks it started), `Top` rewinds;
 *     writing Cursor seeks. LoopMode Loop (the default) repeats, Off stops at the end. TCSlot -1 is internal, 0..15 slots 1-16.
 *   - Deleting a track's target removes the track's command subtrack with its events; the track stays, without a target.
 */
import { z } from "zod";
import { BridgeError, type Gma3Bridge } from "../bridge.js";
import { exists } from "./common.js";
import { json, operation, type RegisterTools, type ToolContext } from "./context.js";
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
// Time
// ---------------------------------------------------------------------------

export const RAW_PER_SECOND = 16777216;
export const FRAME_RATES = [24, 25, 30, 60] as const;
export type Fps = (typeof FRAME_RATES)[number];
/** 255h59m59 (the console's duration limit). */
export const MAX_SECONDS = 255 * 3600 + 59 * 60 + 59;

export const toRaw = (seconds: number) => Math.round(seconds * RAW_PER_SECOND);
export const fromRaw = (raw: number) => raw / RAW_PER_SECOND;

export function fpsOf(field: string, v: unknown): Fps | undefined {
  if (v === undefined || v === null) return undefined;
  if (!FRAME_RATES.includes(v as Fps)) throw new ValidationError(`${field} must be one of ${FRAME_RATES.join(", ")} frames per second (got ${JSON.stringify(v)})`, field);
  return v as Fps;
}

/**
 * A time as seconds: a number of seconds; "SS.sss", "M:SS.sss", "H:MM:SS.sss" (fractions of a second after a dot);
 * "H:MM:SS:FF" (frames, needs fps); or {frames, fps}. Rounded to the console's resolution (1/16777216 s).
 */
export function parseTime(field: string, v: unknown, fps?: Fps): { seconds: number; raw: number } {
  let seconds: number;
  if (typeof v === "number") seconds = finiteNumber(field, v, { min: 0 })!;
  else if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const f = fpsOf(`${field}.fps`, o.fps);
    if (!f) throw new ValidationError(`${field}.fps is required with frames`, field);
    const frames = finiteNumber(`${field}.frames`, o.frames, { min: 0, integer: true })!;
    seconds = frames / f;
  } else if (typeof v === "string") {
    const s = v.trim();
    const frames = s.match(/^(\d+):(\d{1,2}):(\d{1,2}):(\d{1,2})$/);
    const clock = s.match(/^(?:(?:(\d+):)?(\d{1,2}):)?(\d+(?:\.\d+)?)$/);
    if (frames) {
      if (!fps) throw new ValidationError(`${field} ${JSON.stringify(v)} has frames: give fps (${FRAME_RATES.join(", ")})`, field);
      const [h, m, sec, ff] = frames.slice(1).map(Number);
      if (m > 59 || sec > 59) throw new ValidationError(`${field} ${JSON.stringify(v)} has minutes or seconds above 59`, field);
      if (ff >= fps) throw new ValidationError(`${field} ${JSON.stringify(v)}: frame ${ff} does not exist at ${fps} fps`, field);
      seconds = h * 3600 + m * 60 + sec + ff / fps;
    } else if (clock) {
      const h = Number(clock[1] ?? 0);
      const m = Number(clock[2] ?? 0);
      const sec = Number(clock[3]);
      if ((clock[2] !== undefined && sec >= 60) || (clock[1] !== undefined && m > 59)) throw new ValidationError(`${field} ${JSON.stringify(v)} has minutes or seconds above 59`, field);
      seconds = h * 3600 + m * 60 + sec;
    } else throw new ValidationError(`${field} must be seconds, "H:MM:SS.sss", "H:MM:SS:FF" (with fps) or {frames, fps} (got ${JSON.stringify(v)})`, field);
  } else throw new ValidationError(`${field} is required`, field);
  if (seconds > MAX_SECONDS) throw new ValidationError(`${field} is beyond 255h59m59s`, field);
  return { seconds, raw: toRaw(seconds) };
}

/** "H:MM:SS:FF" at fps (frames rounded), or "H:MM:SS.sss". */
export function formatTime(raw: number, fps?: Fps): string {
  const total = fromRaw(raw);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  if (fps) {
    const frames = Math.round(total * fps);
    const ff = frames % fps;
    const s = Math.floor(frames / fps);
    return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}:${pad(ff)}`;
  }
  const ms = Math.round(total * 1000);
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}.${pad(ms % 1000, 3)}`;
}

/** The console's time text ("1.60", "1m30.00", "1h00m00.00") as seconds; null when it is not one. */
export function displaySeconds(s: unknown): number | null {
  const t = String(s ?? "").trim();
  const m = t.match(/^(-)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)?s?$/);
  if (!t || !m || (m[5] === undefined && !m[2] && !m[3] && !m[4])) return null;
  const v = Number(m[2] ?? 0) * 86400 + Number(m[3] ?? 0) * 3600 + Number(m[4] ?? 0) * 60 + Number(m[5] ?? 0);
  return m[1] ? -v : v;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Event actions -> console token and status. */
export const ACTIONS = {
  go: { token: "Go+" },
  go_back: { token: "Go-" },
  goto: { token: "Goto", cue: true },
  on: { token: "On" },
  off: { token: "Off" },
  toggle: { token: "Toggle" },
  top: { token: "Top" },
  pause: { token: "Pause" },
  kill: { token: "Kill" },
  flash_press: { token: "Flash", status: "On" },
  flash_release: { token: "Flash", status: "Off" },
  temp_press: { token: "Temp", status: "On" },
  temp_release: { token: "Temp", status: "Off" },
} as const satisfies Record<string, { token: string; status?: "On" | "Off"; cue?: boolean }>;
export type Action = keyof typeof ACTIONS;

/** The action of a read event (token name and status). */
export function actionOf(token: unknown, status: unknown): Action | null {
  const t = String(token ?? "").trim();
  const st = String(status ?? "").trim();
  const hit = (Object.entries(ACTIONS) as Array<[Action, { token: string; status?: string }]>).find(([, a]) => a.token.toLowerCase() === t.toLowerCase() && (a.status === undefined || a.status.toLowerCase() === st.toLowerCase()));
  return hit ? hit[0] : null;
}

export interface EventSpec {
  action: Action;
  raw: number;
  seconds: number;
  /** "Sequence S Cue C". */
  cue?: string;
  cueNo?: number;
  /** Position in the request, which orders events at the same time. */
  order: number;
}

export interface TrackSpec {
  sequence: number;
  events: EventSpec[];
}

function cueNumber(field: string, v: unknown): number {
  const n = typeof v === "string" && /^\d+(\.\d{1,3})?$/.test(v.trim()) ? Number(v) : v;
  return finiteNumber(field, n, { min: 0.001, max: 9999.999 })!;
}

export function parseTrack(field: string, raw: unknown, fps: Fps | undefined): TrackSpec {
  if (!raw || typeof raw !== "object") throw new ValidationError(`${field} must be {sequence, events}`, field);
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!["sequence", "events"].includes(k)) throw new ValidationError(`${field}.${k} is not a track field (sequence tracks only in this release)`, `${field}.${k}`);
  const sequence = finiteNumber(`${field}.sequence`, r.sequence, { integer: true, min: 1, max: 99999 })!;
  if (!Array.isArray(r.events) || !r.events.length) throw new ValidationError(`${field}.events must be a non-empty list`, field);
  const events = r.events.map((e, i): EventSpec => {
    const f = `${field}.events[${i}]`;
    if (!e || typeof e !== "object") throw new ValidationError(`${f} must be {at, action, cue?}`, f);
    const o = e as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!["at", "action", "cue"].includes(k)) throw new ValidationError(`${f}.${k} is not an event field`, `${f}.${k}`);
    if (typeof o.action !== "string" || !(o.action in ACTIONS)) throw new ValidationError(`${f}.action must be one of ${Object.keys(ACTIONS).join(", ")}`, `${f}.action`);
    const action = o.action as Action;
    const t = parseTime(`${f}.at`, o.at, fps);
    const needsCue = "cue" in ACTIONS[action];
    if (needsCue && (o.cue === undefined || o.cue === null)) throw new ValidationError(`${f}: ${action} needs a cue`, f);
    if (!needsCue && o.cue !== undefined) throw new ValidationError(`${f}: ${action} takes no cue`, f);
    const cueNo = needsCue ? cueNumber(`${f}.cue`, o.cue) : undefined;
    return { action, raw: t.raw, seconds: t.seconds, ...(cueNo !== undefined ? { cue: `Sequence ${sequence} Cue ${cueNo}`, cueNo } : {}), order: i };
  });
  return { sequence, events };
}

/** Time order; events at the same time keep the order they were given in (the console runs them in storage order). */
export const orderEvents = (events: EventSpec[]) => [...events].sort((a, b) => a.raw - b.raw || a.order - b.order);

/** Press/release pairs per kind: a release needs an open press, and every press is released. */
export function pairProblems(events: EventSpec[]): string[] {
  const out: string[] = [];
  for (const kind of ["flash", "temp"] as const) {
    let open: EventSpec | null = null;
    for (const e of orderEvents(events)) {
      if (e.action === `${kind}_press`) {
        if (open) out.push(`${kind}_press at ${formatTime(e.raw)} while the press at ${formatTime(open.raw)} is not released`);
        open = e;
      } else if (e.action === `${kind}_release`) {
        if (!open) out.push(`${kind}_release at ${formatTime(e.raw)} without a press before it`);
        open = null;
      }
    }
    if (open) out.push(`${kind}_press at ${formatTime(open.raw)} is never released`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface RawEvent {
  group: number;
  track: number;
  range: number;
  subtrack: number;
  index: number;
  raw: number | null;
  time?: string;
  name?: string;
  token?: string;
  status?: string;
  cue?: { addr?: string; name?: string; no?: number; sequence?: number; invalid?: boolean } | null;
  executeCommand?: string;
}

export interface TimecodeRead {
  no: number;
  addr?: string;
  settings: Record<string, unknown>;
  playing?: boolean;
  groups: Array<{ group: number; name?: string; markers?: number }>;
  tracks: Array<{ group: number; track: number; name?: string; target?: { class?: string; addr?: string; name?: string; no?: number; invalid?: boolean } | null; play?: string; rec?: string }>;
  ranges: Array<{ group: number; track: number; range: number; rawStart?: number | null; duration?: string }>;
  subtracks: Array<{ group: number; track: number; range: number; subtrack: number; class?: string; count?: number }>;
  events: RawEvent[];
  eventCount: number;
  truncated: boolean;
}

const NEEDS_BRIDGE = "the console runs an older bridge plugin (bridge 0.25.0 reads and edits timecode shows); update the plugin";
const notFound = (err: unknown) => err instanceof BridgeError && /not-found|no objects? found/i.test(err.message);
const unknownOp = (err: unknown) => err instanceof BridgeError && /unknown op|not supported|no such op/i.test(err.message);

/** One show through `timecode.read`; null when it does not exist. */
export async function readTimecode(bridge: Gma3Bridge, n: number, t: number): Promise<TimecodeRead | null> {
  try {
    return (await bridge.request("timecode.read", { timecode: n }, t)) as TimecodeRead;
  } catch (err) {
    if (unknownOp(err)) throw new Error(NEEDS_BRIDGE);
    if (notFound(err)) return null;
    throw err;
  }
}

export function tcSlotOf(v: unknown): { source: "internal" | "selected" | "slot"; slot?: number } | null {
  const n = Number(String(v ?? "").trim());
  if (!Number.isInteger(n)) return null;
  if (n === -1) return { source: "internal" };
  if (n === -2) return { source: "selected" };
  if (n >= 0 && n <= 15) return { source: "slot", slot: n + 1 };
  return null;
}

/** The show as a tool presents it: times in seconds and as timecode, actions by name, problems named. */
export function presentShow(r: TimecodeRead, fps?: Fps) {
  const problems: string[] = [];
  const tracks = r.tracks.map((tr) => {
    const evs = r.events.filter((e) => e.group === tr.group && e.track === tr.track);
    if (!tr.target) problems.push(`group ${tr.group} track ${tr.track} has no target (none assigned, or it was deleted)${evs.length ? `; its ${evs.length} event(s) do nothing` : ""}`);
    else if (tr.target.invalid) problems.push(`group ${tr.group} track ${tr.track}: its target no longer exists`);
    else if (tr.target.class !== "Sequence") problems.push(`group ${tr.group} track ${tr.track}: target ${tr.target.name} is a ${tr.target.class}, which this release does not model`);
    const events = evs
      .map((e) => {
        const action = actionOf(e.token ?? e.name, e.status);
        if (!action) problems.push(`group ${tr.group} track ${tr.track} event ${e.index}: token ${JSON.stringify(e.token ?? e.name)} is not modelled`);
        if (action === "goto" && (!e.cue || e.cue.invalid)) problems.push(`group ${tr.group} track ${tr.track} event ${e.index}: Goto without a ${e.cue?.invalid ? "valid " : ""}cue`);
        return {
          range: e.range,
          subtrack: e.subtrack,
          index: e.index,
          seconds: e.raw === null ? null : fromRaw(e.raw),
          time: e.raw === null ? null : formatTime(e.raw, fps),
          raw: e.raw,
          action,
          token: e.token ?? e.name,
          ...(e.status ? { status: e.status } : {}),
          ...(e.cue ? { cue: e.cue.invalid ? { invalid: true } : { sequence: e.cue.sequence, cue: typeof e.cue.no === "number" ? e.cue.no / 1000 : null, name: e.cue.name } } : {}),
          ...(e.executeCommand && /^no$/i.test(e.executeCommand) ? { executeCommand: false } : {}),
        };
      })
      .sort((a, b) => (a.raw ?? 0) - (b.raw ?? 0) || a.subtrack - b.subtrack || a.index - b.index);
    return { group: tr.group, track: tr.track, name: tr.name, target: tr.target ?? null, sequence: tr.target?.class === "Sequence" ? tr.target.no ?? null : null, ranges: r.ranges.filter((x) => x.group === tr.group && x.track === tr.track).length, events };
  });
  if (r.truncated) problems.push(`only ${r.events.length} of ${r.eventCount} events were read`);
  const s = r.settings;
  return {
    timecode: r.no,
    name: s.Name ?? null,
    playing: r.playing ?? null,
    cursorSeconds: displaySeconds(s.Cursor),
    durationSeconds: typeof s.RawDuration === "number" ? fromRaw(s.RawDuration) : displaySeconds(s.Duration),
    source: { tcSlot: tcSlotOf(s.TCSlot), offsetTcSlot: s.OffsetTCSlot ?? null, autoStart: s.AutoStart ?? null, autoStop: s.AutoStop ?? null },
    playback: { loopMode: s.LoopMode ?? null, loopCount: s.LoopCount ?? null, switchOff: s.SwitchOff ?? null, assertPreviousEvents: s.AssertPrevEvents ?? null, restartOption: s.RestartOption ?? null },
    recording: { playbackAndRecord: s.PlaybackAndRecord ?? null, armed: "unavailable: the recording state is a console method the bridge does not call; these tools never record" },
    frameReadout: s.FrameReadout ?? null,
    locked: s.Lock === undefined ? null : String(s.Lock ?? "").trim() !== "" && !/^no$/i.test(String(s.Lock)),
    groups: r.groups,
    tracks,
    eventCount: r.eventCount,
    problems,
  };
}

interface Listing {
  total?: number;
  offset?: number;
  items?: Array<{ name?: string; index?: number; childCount?: number; fields?: Record<string, unknown> }>;
}

export async function readTimecodes(ctx: ToolContext, raw: { timecode?: unknown; fps?: unknown; slots?: boolean }): Promise<unknown> {
  const bridge = ctx.bridge;
  const t = ctx.requestTimeoutMs;
  const fps = fpsOf("fps", raw.fps);
  const out: Record<string, unknown> = {};
  if (raw.timecode === undefined || raw.timecode === null) {
    const r = (await bridge.request("children", { ref: "DataPool.Timecodes", fields: ["Name"], limit: 1000 }, t)) as Listing;
    out.timecodes = (r.items ?? []).map((i) => ({ timecode: i.index, name: String(i.fields?.Name ?? i.name ?? ""), groups: i.childCount ?? null }));
  } else {
    const n = finiteNumber("timecode", raw.timecode, { integer: true, min: 1, max: 99999 })!;
    const r = await readTimecode(bridge, n, t);
    if (!r) return { timecode: n, exists: false };
    Object.assign(out, presentShow(r, fps));
  }
  if (raw.slots) {
    const s = (await bridge.request("children", { ref: "Root.TimecodeSlots", fields: ["Name", "TimeString"], limit: 32 }, t)) as Listing;
    out.slots = (s.items ?? []).map((i) => ({ slot: i.index, name: String(i.fields?.Name ?? i.name ?? ""), time: i.fields?.TimeString ?? null }));
    out.slotsNote = "a slot shows its current time only; whether external timecode (SMPTE, MIDI, Art-Net) is being received is not readable on 2.5.1";
  }
  return out;
}

// ---------------------------------------------------------------------------
// gma3_build_timecode
// ---------------------------------------------------------------------------

const LOOP_MODES = { loop: "Loop", pause: "Pause", off: "Off" } as const;
const SWITCH_OFF = { keep: "Keep Playbacks", off: "Playbacks Off" } as const;

interface Settings {
  LoopMode?: string;
  LoopCount?: string;
  TCSlot?: string;
  SwitchOff?: string;
  AssertPrevEvents?: string;
}

export function parseSettings(raw: unknown): Settings {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object") throw new ValidationError("settings must be an object", "settings");
  const r = raw as Record<string, unknown>;
  const out: Settings = {};
  for (const k of Object.keys(r)) if (!["loop_mode", "loop_count", "tc_slot", "switch_off", "assert_previous_events"].includes(k)) throw new ValidationError(`settings.${k} is not a setting`, `settings.${k}`);
  if (r.loop_mode !== undefined) {
    if (!(String(r.loop_mode) in LOOP_MODES)) throw new ValidationError("settings.loop_mode must be loop, pause or off", "settings.loop_mode");
    out.LoopMode = LOOP_MODES[r.loop_mode as keyof typeof LOOP_MODES];
  }
  if (r.loop_count !== undefined) out.LoopCount = String(finiteNumber("settings.loop_count", r.loop_count, { integer: true, min: 0, max: 1000 }));
  if (r.tc_slot !== undefined) {
    if (r.tc_slot === "internal") out.TCSlot = "-1";
    else out.TCSlot = String(finiteNumber("settings.tc_slot", r.tc_slot, { integer: true, min: 1, max: 16 })! - 1);
  }
  if (r.switch_off !== undefined) {
    if (!(String(r.switch_off) in SWITCH_OFF)) throw new ValidationError("settings.switch_off must be keep or off", "settings.switch_off");
    out.SwitchOff = SWITCH_OFF[r.switch_off as keyof typeof SWITCH_OFF];
  }
  if (r.assert_previous_events !== undefined) {
    if (typeof r.assert_previous_events !== "boolean") throw new ValidationError("settings.assert_previous_events must be true or false", "settings.assert_previous_events");
    out.AssertPrevEvents = r.assert_previous_events ? "Yes" : "No";
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs `timecode.edit`, retrying a not-ready step (the console builds children on the next frame). */
async function edit(bridge: Gma3Bridge, args: Record<string, unknown>, t: number, name: string): Promise<StepResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await bridge.request("timecode.edit", args, t);
      return { name, status: "succeeded", op: "timecode.edit", detail: res };
    } catch (err) {
      if (err instanceof BridgeError && /not-ready|does not exist \(there are/.test(err.message) && attempt < 6) {
        await sleep(80 * (attempt + 1));
        continue;
      }
      if (unknownOp(err)) return { name, status: "failed", op: "timecode.edit", error: NEEDS_BRIDGE };
      return stepFromError(name, err, { op: "timecode.edit" });
    }
  }
}

/** Waits until the read shows `ok` (children appear a frame later). */
async function waitFor(bridge: Gma3Bridge, n: number, t: number, ok: (r: TimecodeRead) => boolean): Promise<TimecodeRead | null> {
  let r: TimecodeRead | null = null;
  for (let i = 0; i < 8; i++) {
    r = await readTimecode(bridge, n, t);
    if (r && ok(r)) return r;
    await sleep(60 * (i + 1));
  }
  return r;
}

interface BuildArgs {
  timecode: unknown;
  mode: unknown;
  name?: unknown;
  fps?: unknown;
  settings?: unknown;
  tracks: unknown;
  allow_unpaired?: boolean;
  preview?: boolean;
  verify?: boolean;
}

export async function buildTimecode(ctx: ToolContext, raw: BuildArgs): Promise<OperationResult> {
  const op = "build_timecode";
  const v = new Validator();
  const n = v.check(() => finiteNumber("timecode", raw.timecode, { integer: true, min: 1, max: 99999 }));
  const mode = (["create", "replace", "append"] as const).find((m) => m === raw.mode);
  if (!mode) v.fail("mode must be create (refuses an existing show), replace (removes its track groups first) or append (adds a track group)");
  const fps = v.check(() => fpsOf("fps", raw.fps));
  const settings = v.check(() => parseSettings(raw.settings)) ?? {};
  const name = raw.name === undefined ? undefined : typeof raw.name === "string" && raw.name.trim() && !/["\r\n]/.test(raw.name) ? raw.name : (v.fail("name must be a one-line string without quotes"), undefined);
  const tracks = Array.isArray(raw.tracks) && raw.tracks.length ? raw.tracks.map((tr, i) => v.check(() => parseTrack(`tracks[${i}]`, tr, fps))).filter((x): x is TrackSpec => !!x) : (v.fail("tracks must be a non-empty list"), []);
  if (Array.isArray(raw.tracks) && raw.tracks.length > 32) v.fail("at most 32 tracks per call");
  const unpaired = tracks.flatMap((tr, i) => pairProblems(tr.events).map((p) => `tracks[${i}]: ${p}`));
  if (unpaired.length && raw.allow_unpaired !== true) v.fail(`${unpaired.join("; ")} (pass allow_unpaired: true to store it anyway)`);
  const target: Record<string, unknown> = { timecode: raw.timecode, mode: raw.mode };
  if (!v.ok || n === undefined || !mode) return validationFailure(op, target, v.errors);
  const ref = `Timecode ${n}`;
  target.ref = ref;
  const bridge = ctx.bridge;
  const t = ctx.requestTimeoutMs;
  const preview = raw.preview === true;
  const ordered = tracks.map((tr) => ({ ...tr, events: orderEvents(tr.events) }));

  const body = async (): Promise<OperationResult> => {
    let before: TimecodeRead | null = null;
    const missing: string[] = [];
    const inspect = await runSteps([
      {
        name: "read_timecode",
        run: async () => {
          try {
            before = await readTimecode(bridge, n, t);
          } catch (err) {
            return asRead(err instanceof Error && err.message === NEEDS_BRIDGE ? { name: "read_timecode", status: "failed", error: NEEDS_BRIDGE } : stepFromError("read_timecode", err, { op: "timecode.read" }));
          }
          const b = before as TimecodeRead | null;
          if (mode === "create" && b) return asRead({ name: "read_timecode", status: "failed", error: `${ref} already exists (${b.groups.length} track group(s), ${b.eventCount} event(s)); use mode replace or append` });
          if (mode !== "create" && !b) return asRead({ name: "read_timecode", status: "failed", error: `${ref} does not exist; use mode create` });
          if (b?.truncated) return asRead({ name: "read_timecode", status: "failed", error: `${ref} was not read completely; nothing is changed` });
          // An existing show is changed only when it was read as unlocked and stopped: unknown is never taken as safe.
          if (b) {
            const lock = b.settings.Lock;
            if (typeof lock !== "string") return asRead({ name: "read_timecode", status: "failed", error: `the Lock of ${ref} could not be read; nothing is changed on a show that may be locked` });
            if (!/^(no)?$/i.test(lock.trim())) return asRead({ name: "read_timecode", status: "failed", error: `${ref} is locked` });
            if (typeof b.playing !== "boolean") return asRead({ name: "read_timecode", status: "failed", error: `whether ${ref} is playing could not be read; nothing is changed on a show that may be playing` });
            if (b.playing) return asRead({ name: "read_timecode", status: "failed", error: `${ref} is playing; stop it first (gma3_timecode_transport stop)` });
          }
          return asRead({ name: "read_timecode", status: "succeeded", op: "timecode.read", detail: b ? { groups: b.groups.length, events: b.eventCount } : { exists: false } });
        },
      },
      {
        name: "check_targets",
        run: async () => {
          const refs = new Set<string>();
          for (const tr of ordered) {
            refs.add(`Sequence ${tr.sequence}`);
            for (const e of tr.events) if (e.cue) refs.add(e.cue);
          }
          for (const r of refs) {
            const e = await exists(bridge, r);
            if (e.exists === "unknown") return asRead({ name: "check_targets", status: "failed", error: `${r} could not be checked: ${e.error}` });
            if (!e.exists) missing.push(r);
          }
          return asRead(missing.length ? { name: "check_targets", status: "failed", error: `not in the show: ${missing.join(", ")}` } : { name: "check_targets", status: "succeeded", detail: [...refs] });
        },
      },
    ]);
    const plan = ordered.map((tr, i) => ({ track: i + 1, sequence: tr.sequence, events: tr.events.map((e) => ({ at: formatTime(e.raw, fps), seconds: fromRaw(e.raw), action: e.action, ...(e.cueNo !== undefined ? { cue: e.cueNo } : {}) })) }));
    const shared = sameTimeAcrossTracks(ordered);
    const warnings: string[] = [];
    if (shared.length) warnings.push(`events of different tracks share a time (${shared.slice(0, 4).join("; ")}): the console's order across tracks is not defined by this tool`);
    if (unpaired.length) warnings.push(`unpaired press/release accepted: ${unpaired.join("; ")}`);
    const extra: Record<string, unknown> = { plan, rounding: "times are rounded to the console's resolution, 1/16777216 s; events at the same time keep the order given" };
    if (inspect.outcome !== "succeeded") return buildResult({ operation: op, target, steps: inspect.steps, warnings, summary: `${op} was not performed; nothing was sent: ${inspect.steps.find((s) => s.status !== "succeeded")?.error}`, extra });
    const b = before as TimecodeRead | null;
    const base = mode === "append" ? b!.groups.length : 0;
    const group = base + 1;
    if (preview) return buildResult({ operation: op, target, steps: inspect.steps, warnings, summary: `Preview only; nothing was sent. ${mode} ${ref}: track group ${group} with ${ordered.length} track(s); the show is never played or recorded.`, extra: { ...extra, preview: true } });

    const steps: StepResult[] = [...inspect.steps];
    const push = (s: StepResult) => (steps.push(s), s.status === "succeeded");
    let ok = true;
    if (mode === "create") ok = push(await commandStep(bridge, "create", `Store ${ref} /NoConfirmation`, t));
    if (ok && mode === "replace") for (let g = b!.groups.length; g >= 1 && ok; g--) ok = push(await commandStep(bridge, `remove_group_${g}`, `Delete ${ref}.${g} /NoConfirmation`, t));
    if (ok && mode === "replace") {
      const cleared = await waitFor(bridge, n, t, (r) => r.groups.length === 0);
      ok = push(cleared && cleared.groups.length === 0 ? asRead({ name: "check_cleared", status: "succeeded" }) : asRead({ name: "check_cleared", status: "failed", error: `${ref} still has ${cleared?.groups.length ?? "?"} track group(s) after removing them` }));
    }
    if (ok && name !== undefined) ok = push(await setStep(ctx, "name", ref, "Name", name));
    for (const [prop, value] of Object.entries(settings)) if (ok) ok = push(await setStep(ctx, `setting_${prop}`, ref, prop, value));
    if (ok) ok = push(await edit(bridge, { timecode: n, action: "add_group" }, t, "add_group"));
    if (ok) {
      const r = await waitFor(bridge, n, t, (x) => x.tracks.filter((tr) => tr.group === group).length >= 1);
      ok = push(r && r.tracks.some((tr) => tr.group === group) ? asRead({ name: "wait_group", status: "succeeded" }) : asRead({ name: "wait_group", status: "failed", error: `track group ${group} did not appear with its first track` }));
    }
    for (let i = 2; i <= ordered.length && ok; i++) {
      ok = push(await edit(bridge, { timecode: n, action: "add_track", group }, t, `add_track_${i}`));
      if (ok) {
        const r = await waitFor(bridge, n, t, (x) => x.ranges.some((rg) => rg.group === group && rg.track === i));
        ok = push(r && r.ranges.some((rg) => rg.group === group && rg.track === i) ? asRead({ name: `wait_track_${i}`, status: "succeeded" }) : asRead({ name: `wait_track_${i}`, status: "failed", error: `track ${i} did not appear with its time range` }));
      }
    }
    for (const [i, tr] of ordered.entries()) if (ok) ok = push(await edit(bridge, { timecode: n, action: "set_target", group, track: i + 1, target: `Sequence ${tr.sequence}` }, t, `target_${i + 1}`));
    for (const [i, tr] of ordered.entries()) {
      if (!ok) break;
      const events = tr.events.map((e) => ({ raw: e.raw, token: ACTIONS[e.action].token, ...("status" in ACTIONS[e.action] ? { status: (ACTIONS[e.action] as { status: string }).status } : {}), ...(e.cue ? { cue: e.cue } : {}) }));
      ok = push(await edit(bridge, { timecode: n, action: "add_events", group, track: i + 1, range: 1, events }, t, `events_${i + 1}`));
    }

    let verification: Verification = notRequested();
    let after: TimecodeRead | null = null;
    if (raw.verify !== false && ok) {
      try {
        after = await readTimecode(bridge, n, t);
        steps.push(asRead({ name: "read_back", status: "succeeded", op: "timecode.read" }));
        const problems = after ? compareShow(after, b, mode, group, ordered) : [`${ref} does not exist after the build`];
        if (name !== undefined && after && after.settings.Name !== name) problems.push(`the show is named ${JSON.stringify(after.settings.Name)}`);
        const checked = `track group ${group} of ${ref}: every track's target and every event's time (exact), action, press/release state and cue, in time order${mode === "append" ? ", and the earlier groups unchanged" : ""}`;
        verification = problems.length ? { status: "mismatched", checked, detail: problems.slice(0, 12).join("; ") } : { status: "matched", checked };
      } catch (err) {
        steps.push(asRead(stepFromError("read_back", err, { op: "timecode.read" })));
        verification = unavailable("the show could not be read back");
      }
    }
    return buildResult({ operation: op, target, steps, verification, warnings, extra: { ...extra, played: false, recorded: false, group, ...(after ? { show: presentShow(after, fps) } : {}) } });
  };
  return preview ? body() : ctx.mutations.run(body);
}

function sameTimeAcrossTracks(tracks: TrackSpec[]): string[] {
  const at = new Map<number, Set<number>>();
  tracks.forEach((tr, i) => tr.events.forEach((e) => at.set(e.raw, (at.get(e.raw) ?? new Set()).add(i))));
  return [...at].filter(([, s]) => s.size > 1).map(([raw, s]) => `${formatTime(raw)} on tracks ${[...s].map((i) => i + 1).join(", ")}`);
}

/** The built group against the request; earlier groups against the read before (append). */
export function compareShow(after: TimecodeRead, before: TimecodeRead | null, mode: string, group: number, tracks: TrackSpec[]): string[] {
  const out: string[] = [];
  if (after.truncated) out.push(`only ${after.events.length} of ${after.eventCount} events were read back`);
  if (after.groups.length !== group) out.push(`${after.groups.length} track group(s), ${group} expected`);
  const built = after.tracks.filter((tr) => tr.group === group);
  if (built.length !== tracks.length) out.push(`track group ${group} has ${built.length} track(s), ${tracks.length} expected`);
  tracks.forEach((want, i) => {
    const tr = built.find((x) => x.track === i + 1);
    if (!tr) return;
    if (tr.target?.class !== "Sequence" || tr.target.no !== want.sequence) out.push(`track ${i + 1} targets ${tr.target ? `${tr.target.class} ${tr.target.no}` : "nothing"}, not Sequence ${want.sequence}`);
    const got = after.events.filter((e) => e.group === group && e.track === i + 1).sort((a, b) => a.subtrack - b.subtrack || a.index - b.index);
    if (got.length !== want.events.length) out.push(`track ${i + 1} has ${got.length} event(s), ${want.events.length} expected`);
    want.events.forEach((w, k) => {
      const g = got[k];
      if (!g) return;
      const a = actionOf(g.token ?? g.name, g.status);
      const L = `track ${i + 1} event ${k + 1}`;
      if (g.raw !== w.raw) out.push(`${L} is at ${g.raw === null ? "?" : formatTime(g.raw)}, not ${formatTime(w.raw)}`);
      if (a !== w.action) out.push(`${L} is ${a ?? JSON.stringify(g.token ?? g.name)}, not ${w.action}`);
      if (w.cueNo !== undefined && (!g.cue || g.cue.invalid || g.cue.sequence !== want.sequence || g.cue.no !== Math.round(w.cueNo * 1000))) out.push(`${L} goes to ${g.cue?.no !== undefined ? `cue ${g.cue.no / 1000} of sequence ${g.cue.sequence}` : "no cue"}, not cue ${w.cueNo}`);
    });
  });
  if (mode === "append" && before) {
    const sig = (r: TimecodeRead, g: number) => JSON.stringify({ t: r.tracks.filter((x) => x.group === g).map((x) => [x.track, x.target?.addr ?? null]), e: r.events.filter((x) => x.group === g).map((x) => [x.track, x.range, x.subtrack, x.index, x.raw, x.token, x.status ?? null, x.cue?.addr ?? null]) });
    for (const g of before.groups) if (sig(after, g.group) !== sig(before, g.group)) out.push(`track group ${g.group}, which existed before, changed`);
  }
  return out;
}

async function setStep(ctx: ToolContext, name: string, ref: string, property: string, value: string): Promise<StepResult> {
  return requestStep(ctx.bridge, name, "set", { ref, property, value }, (res) => {
    const got = String((res as { value?: unknown } | null)?.value ?? "").trim();
    // Times read back as text with two decimals ("2.20"): compared as seconds.
    const same = property === "Cursor" ? Math.abs((displaySeconds(got) ?? NaN) - Number(value)) <= 0.006 : got.toLowerCase() === value.toLowerCase();
    return same
      ? { name, status: "succeeded", op: "set", detail: { ref, property, value: got } }
      : { name, status: "failed", op: "set", detail: { ref, property, sent: value, readBack: got }, error: `the console did not apply ${property}=${JSON.stringify(value)} on ${ref}: it reads ${JSON.stringify(got)}` };
  }, ctx.requestTimeoutMs);
}

// ---------------------------------------------------------------------------
// gma3_timecode_transport
// ---------------------------------------------------------------------------

interface SeqState {
  cue: number | null;
  active: boolean | null;
}

interface Sample {
  ms: number;
  /** How long the sample's reads took: the cursor is read first, so a change can carry a cursor up to this much early. */
  durMs?: number;
  cursor: number | null;
  playing: boolean | null;
  sequences: Record<number, SeqState>;
}

/** The predicted effect of an event on its sequence, where it is predictable. */
function predict(action: Action | null, cue: number | null, state: SeqState, cues: number[]): SeqState | null {
  if (action === "goto" && cue !== null) return { cue, active: true };
  if (action === "off") return { cue: state.cue, active: false };
  if (action === "go") {
    if (!state.active) return { cue: cues[0] ?? null, active: true };
    const i = state.cue === null ? -1 : cues.indexOf(state.cue);
    return i >= 0 && i + 1 < cues.length ? { cue: cues[i + 1], active: true } : null; // the end of a sequence depends on Wrap Around
  }
  if (action === "flash_press" || action === "temp_press") return { cue: state.active ? state.cue : cues[0] ?? null, active: true };
  if (action === "flash_release" || action === "temp_release") return null; // depends on whether it ran before the press
  return null;
}

interface TransportArgs {
  timecode: unknown;
  action: unknown;
  to?: unknown;
  fps?: unknown;
  observe_seconds?: unknown;
  interval_ms?: unknown;
}

export async function timecodeTransport(ctx: ToolContext, raw: TransportArgs): Promise<OperationResult> {
  const op = "timecode_transport";
  const v = new Validator();
  const n = v.check(() => finiteNumber("timecode", raw.timecode, { integer: true, min: 1, max: 99999 }));
  const action = (["play", "stop", "rewind", "seek"] as const).find((a) => a === raw.action);
  if (!action) v.fail("action must be play (Go), stop (Off), rewind (Top) or seek (to a time); recording is not offered");
  const fps = v.check(() => fpsOf("fps", raw.fps));
  const to = action === "seek" ? v.check(() => parseTime("to", raw.to, fps)) : undefined;
  if (action !== "seek" && raw.to !== undefined) v.fail("to is for seek only");
  const seconds = v.check(() => finiteNumber("observe_seconds", raw.observe_seconds, { min: 0, max: 60, optional: true })) ?? (action === "play" ? 5 : 0.5);
  const intervalMs = v.check(() => finiteNumber("interval_ms", raw.interval_ms, { min: 20, max: 1000, optional: true })) ?? 40;
  const target: Record<string, unknown> = { timecode: raw.timecode, action: raw.action };
  if (!v.ok || n === undefined || !action) return validationFailure(op, target, v.errors);
  const ref = `Timecode ${n}`;
  target.ref = ref;
  const bridge = ctx.bridge;
  const t = ctx.requestTimeoutMs;

  return ctx.mutations.run(async () => {
    let show: TimecodeRead | null = null;
    const inspect = await runSteps([
      {
        name: "read_timecode",
        run: async () => {
          try {
            show = await readTimecode(bridge, n, t);
          } catch (err) {
            return asRead(err instanceof Error && err.message === NEEDS_BRIDGE ? { name: "read_timecode", status: "failed", error: NEEDS_BRIDGE } : stepFromError("read_timecode", err, { op: "timecode.read" }));
          }
          return asRead(show ? { name: "read_timecode", status: "succeeded", op: "timecode.read", detail: { playing: (show as TimecodeRead).playing, events: (show as TimecodeRead).eventCount } } : { name: "read_timecode", status: "failed", error: `${ref} does not exist` });
        },
      },
    ]);
    if (inspect.outcome !== "succeeded" || !show) return buildResult({ operation: op, target, steps: inspect.steps, summary: `${op} was not performed; nothing was sent: ${inspect.steps[0].error}` });
    const sh = show as TimecodeRead;
    const presented = presentShow(sh, fps);
    const warnings = [...presented.problems];
    const seqs = [...new Set(presented.tracks.map((tr) => tr.sequence).filter((x): x is number => typeof x === "number"))];
    // Each target's cue list maps the CurrentCue handle to its number.
    const cueLists = new Map<number, Array<{ addr?: string; no: number }>>();
    for (const s of seqs) {
      const k = (await bridge.request("children", { ref: `Sequence ${s}`, fields: ["No"], asText: false, limit: 10000 }, t).catch(() => null)) as { items?: Array<{ addr?: string; fields?: Record<string, unknown> }> } | null;
      cueLists.set(s, (k?.items ?? []).map((c) => ({ addr: c.addr, no: typeof c.fields?.No === "number" ? (c.fields.No as number) / 1000 : NaN })).filter((c) => c.no > 0));
    }
    const sample = async (t0: number): Promise<Sample> => {
      // Timed from before the cursor request: the skew is everything between reading the cursor and the last sequence.
      const start = Date.now();
      const o = (await bridge.request("objects", { ref, fields: ["Cursor"], limit: 1 }, t).catch(() => null)) as Listing | null;
      const p = (await bridge.request("object", { ref, properties: false }, t).catch(() => null)) as { hasActivePlayback?: boolean } | null;
      const out: Sample = { ms: start - t0, cursor: displaySeconds(o?.items?.[0]?.fields?.Cursor), playing: typeof p?.hasActivePlayback === "boolean" ? p.hasActivePlayback : null, sequences: {} };
      for (const s of seqs) {
        const r = (await bridge.request("objects", { ref: `Sequence ${s}`, fields: ["CurrentCue"], asText: false, limit: 1 }, t).catch(() => null)) as Listing | null;
        const q = (await bridge.request("object", { ref: `Sequence ${s}`, properties: false }, t).catch(() => null)) as { hasActivePlayback?: boolean } | null;
        const item = r?.items?.[0];
        const cur = item?.fields && !Array.isArray(item.fields) ? (item.fields.CurrentCue as { addr?: string } | undefined) : undefined;
        out.sequences[s] = { cue: !item ? null : cur?.addr ? cueLists.get(s)?.find((c) => c.addr === cur.addr)?.no ?? null : null, active: typeof q?.hasActivePlayback === "boolean" ? q.hasActivePlayback : null };
      }
      out.durMs = Date.now() - start;
      return out;
    };
    const t0 = Date.now();
    const first = await sample(t0);
    const command = action === "play" ? `Go ${ref}` : action === "stop" ? `Off ${ref}` : action === "rewind" ? `Top ${ref}` : undefined;
    const s = command ? await commandStep(bridge, action, command, t) : await setStep(ctx, "seek", ref, "Cursor", String(Math.round(to!.seconds * 1000) / 1000));
    const steps = [...inspect.steps, s];
    const samples: Sample[] = [first];
    let unread = 0;
    if (s.status === "succeeded" && seconds > 0) {
      while (Date.now() - t0 < seconds * 1000) {
        const x = await sample(t0);
        if (x.cursor === null) unread++;
        samples.push(x);
        if (action === "play" && x.playing === false && samples.length > 3) break; // the show stopped (LoopMode Off)
        await sleep(intervalMs);
      }
    }
    // The cue changes seen, per sequence.
    const changes: Change[] = [];
    for (const sq of seqs) {
      let prev = first.sequences[sq];
      for (const x of samples.slice(1)) {
        const st = x.sequences[sq];
        if (st && (st.cue !== prev?.cue || st.active !== prev?.active)) changes.push({ ms: x.ms, cursor: x.cursor, sequence: sq, ...st });
        if (st) prev = st;
      }
    }
    changes.sort((a, b) => a.ms - b.ms);
    // The events the cursor crossed, in time order, with what each should have done.
    const startCursor = samples.find((x) => x.cursor !== null)?.cursor ?? null;
    const endCursor = [...samples].reverse().find((x) => x.cursor !== null)?.cursor ?? null;
    let crossed: CrossedEvent[] = [];
    let verification: Verification = notRequested();
    if (action === "play" && startCursor !== null && endCursor !== null && endCursor >= startCursor) {
      const evs = presented.tracks
        .flatMap((tr) => tr.events.map((e) => ({ seconds: e.seconds!, time: e.time!, sequence: tr.sequence, action: e.action, cue: (e.cue as { cue?: number } | undefined)?.cue ?? null })))
        .filter((e) => e.seconds !== null && e.seconds > startCursor - 1e-6 && e.seconds <= endCursor + 1e-6);
      // The read skew: the slowest sample, plus a frame and the cursor's two-decimal text.
      const skew = Math.max(0, ...samples.map((x) => x.durMs ?? 0)) / 1000 + 0.05;
      const m = matchEvents({ events: evs, changes, initial: new Map(seqs.map((sq) => [sq, first.sequences[sq]])), cues: new Map([...cueLists].map(([k, v]) => [k, v.map((c) => c.no)])), skew });
      crossed = m.events;
      const checked = `the ${evs.length} event(s) between cursor ${startCursor.toFixed(2)} s and ${endCursor.toFixed(2)} s against each target sequence's observed changes in that event's window (its time - ${skew.toFixed(2)} s read skew, up to the sequence's next event), in order per sequence`;
      verification = m.verification(checked);
    } else if (action === "stop" || action === "rewind" || action === "seek") {
      const last = samples.at(-1)!;
      if (action === "stop") verification = last.playing === false ? { status: "matched", checked: `${ref} is not playing` } : last.playing === null ? unavailable(`the playback state of ${ref} could not be read`) : { status: "mismatched", checked: `${ref} is not playing`, detail: "it is still playing" };
      else {
        const goal = action === "rewind" ? 0 : to!.seconds;
        const cur = last.cursor;
        verification = cur === null ? unavailable(`the cursor of ${ref} could not be read`) : Math.abs(cur - goal) <= 0.02 || (last.playing && cur >= goal && cur - goal < seconds + 0.5) ? { status: "matched", checked: `the cursor of ${ref} is at ${goal} s`, actual: cur } : { status: "mismatched", checked: `the cursor of ${ref} is at ${goal} s`, actual: cur };
      }
    }
    if (unread) warnings.push(`${unread} sample(s) of the cursor could not be read`);
    if (action === "play" && sh.settings.LoopMode === "Loop") warnings.push(`${ref} loops (LoopMode Loop): it keeps running until stopped`);
    if (action === "stop" && sh.settings.SwitchOff !== "Playbacks Off") warnings.push(`SwitchOff is ${sh.settings.SwitchOff ?? "unknown"}: the playbacks the show started keep running after it stops`);
    const execution = { dispatched: s.status === "succeeded", command: command ?? `set Cursor ${to?.seconds}`, observed: { samples: samples.length, unreadSamples: unread, startCursor, endCursor, playing: samples.at(-1)?.playing ?? null, changes } };
    return buildResult({ operation: op, target, steps, verification, warnings, extra: { execution, ...(crossed.length ? { events: crossed } : {}), recorded: false } });
  });
}

const sameState = (a: SeqState, b: SeqState) => a.cue === b.cue && a.active === b.active;

export interface Change {
  ms: number;
  cursor: number | null;
  sequence: number;
  cue: number | null;
  active: boolean | null;
}

export interface CrossedEvent {
  seconds: number;
  time: string;
  sequence: number | null;
  action: Action | null;
  cue?: number | null;
  expected: SeqState | null;
  /**
   * matched: the expected change was seen in the event's window; unchanged: the sequence was already in that state (not
   * observable); unpredictable: no predicted effect; superseded: the next event on the sequence followed within the read
   * skew, so its effect may hide this one's; missed: no matching change in the window.
   */
  result: "matched" | "unchanged" | "unpredictable" | "superseded" | "missed";
  observed: { ms: number; cursor: number | null } | null;
}

/**
 * Checks crossed events against the observed changes, per sequence: an event's expected state must appear in a change of
 * its own sequence whose cursor lies in [event time - skew, next event of that sequence + skew). Across sequences only
 * the order the samples can resolve is checked: two events seen in the same sample, or less than the skew apart, are
 * listed as unresolved, never as wrong.
 */
export function matchEvents(input: { events: Array<{ seconds: number; time: string; sequence: number | null; action: Action | null; cue?: number | null }>; changes: Change[]; initial: Map<number, SeqState>; cues: Map<number, number[]>; skew: number }) {
  const { changes, skew } = input;
  const out: CrossedEvent[] = [];
  const bySeq = new Map<number | null, typeof input.events>();
  for (const e of [...input.events].sort((a, b) => a.seconds - b.seconds)) bySeq.set(e.sequence, [...(bySeq.get(e.sequence) ?? []), e]);
  for (const [seq, evs] of bySeq) {
    let state: SeqState = seq !== null ? { ...(input.initial.get(seq) ?? { cue: null, active: null }) } : { cue: null, active: null };
    const own = changes.filter((c) => c.sequence === seq);
    let idx = 0;
    evs.forEach((e, i) => {
      const next = evs[i + 1]?.seconds ?? Infinity;
      const inWindow = (c: Change) => c.cursor !== null && c.cursor >= e.seconds - skew && c.cursor < next + skew;
      const expected = seq === null ? null : predict(e.action, e.cue ?? null, state, input.cues.get(seq) ?? []);
      const base = { seconds: e.seconds, time: e.time, sequence: seq, action: e.action, ...(e.cue !== undefined && e.cue !== null ? { cue: e.cue } : {}), expected };
      if (!expected) {
        const seen = own.findIndex((c, k) => k >= idx && inWindow(c));
        if (seen >= 0) { state = { cue: own[seen].cue, active: own[seen].active }; idx = seen + 1; }
        out.push({ ...base, result: "unpredictable", observed: seen >= 0 ? { ms: own[seen].ms, cursor: own[seen].cursor } : null });
        return;
      }
      if (sameState(state, expected)) {
        out.push({ ...base, result: "unchanged", observed: null });
        return;
      }
      // Changes before the window cannot be this event's: skip them.
      while (idx < own.length && own[idx].cursor !== null && own[idx].cursor! < e.seconds - skew) idx++;
      const k = own.findIndex((c, j) => j >= idx && inWindow(c) && c.cue === expected.cue && c.active === expected.active);
      if (k >= 0) {
        idx = k + 1;
        state = expected;
        out.push({ ...base, result: "matched", observed: { ms: own[k].ms, cursor: own[k].cursor } });
      } else {
        out.push({ ...base, result: next - e.seconds <= skew ? "superseded" : "missed", observed: null });
        state = expected;
      }
    });
  }
  out.sort((a, b) => a.seconds - b.seconds || (a.sequence ?? 0) - (b.sequence ?? 0));
  // Order across sequences: only where the samples resolve it.
  const matched = out.filter((e) => e.result === "matched");
  const inversions: string[] = [];
  const unresolved: string[] = [];
  for (let i = 0; i < matched.length; i++)
    for (let j = i + 1; j < matched.length; j++) {
      const a = matched[i];
      const b = matched[j];
      if (a.sequence === b.sequence) continue;
      const label = `${a.time} (sequence ${a.sequence}) / ${b.time} (sequence ${b.sequence})`;
      if (a.observed!.ms === b.observed!.ms || b.seconds - a.seconds < skew) unresolved.push(label);
      else if (a.observed!.ms > b.observed!.ms) inversions.push(label);
    }
  const count = (r: CrossedEvent["result"]) => out.filter((e) => e.result === r).length;
  const verification = (checked: string): Verification => {
    const notes = [
      count("unchanged") ? `${count("unchanged")} event(s) left their sequence in the state it was in (not observable)` : "",
      count("unpredictable") ? `${count("unpredictable")} event(s) have no predictable effect` : "",
      count("superseded") ? `${count("superseded")} event(s) were followed within the read skew by the next event on their sequence` : "",
      unresolved.length ? `the order of ${unresolved.length} pair(s) of events on different sequences is not resolved by the sampling (${unresolved.slice(0, 3).join("; ")})` : "",
    ].filter(Boolean);
    if (!out.length) return unavailable("no event was crossed while observing", checked);
    if (count("missed") || inversions.length) return { status: "mismatched", checked, detail: [count("missed") ? `${count("missed")} event(s) had no matching change in their window` : "", inversions.length ? `observed out of order: ${inversions.slice(0, 3).join("; ")}` : "", ...notes].filter(Boolean).join("; ") };
    if (!matched.length) return unavailable(notes.join("; ") || "no crossed event had an observable effect", checked);
    return { status: "matched", checked, ...(notes.length ? { detail: notes.join("; ") } : {}) };
  };
  return { events: out, inversions, unresolved, verification };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

async function readOnly(fn: () => Promise<unknown>) {
  try {
    return json(await fn());
  } catch (err) {
    return { content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}

const timeSchema = z.union([z.number(), z.string(), z.object({ frames: z.number(), fps: z.number() })]);

export const registerTimecodeTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_timecodes",
    {
      title: "Read the timecode pool or one timecode show",
      description:
        "Read-only. Without timecode: the timecode pool. With timecode: name, playing, cursor and duration (seconds), the source (tc_slot internal / slot N, offset, auto start/stop), playback settings (loop mode and count, switch off, assert previous events), recording settings (the armed state is not readable; these tools never record), and every track group, track (its target) and event: time in seconds and as H:MM:SS.sss (or H:MM:SS:FF with fps 24/25/30/60), exact raw time, action (go, goto, off, flash_press, ...), cue. problems names tracks without a target, Goto events without a cue and unmodelled tokens. slots: true lists the 16 timecode slots (their time only: external reception is not readable). Needs bridge 0.25.0.",
      inputSchema: { timecode: z.number().optional(), fps: z.number().optional(), slots: z.boolean().optional() },
    },
    async (args) => readOnly(() => readTimecodes(ctx, args)),
  );

  server.registerTool(
    "gma3_build_timecode",
    {
      title: "Build a timecode show from timed cue events (never plays or records)",
      description:
        "mode (required): create (refuses an existing show), replace (removes its track groups, keeps the show) or append (adds a track group). tracks: [{sequence, events: [{at, action, cue?}]}]: at is seconds, \"H:MM:SS.sss\", \"H:MM:SS:FF\" (with fps 24, 25, 30 or 60) or {frames, fps}, rounded to the console's 1/16777216 s; action is go (Go+), go_back, goto (needs cue), on, off, toggle, top, pause, kill, flash_press / flash_release, temp_press / temp_release (pairs are checked: allow_unpaired to override). " +
        "Events are stored in time order; events at the same time keep the order given (the console runs them in storage order). settings: loop_mode (loop, pause, off), loop_count, tc_slot (\"internal\" or 1-16: configures the source only), switch_off (keep, off), assert_previous_events. Sequences and cues are checked before anything is sent; a playing or locked show is refused. Every event is read back and compared exactly. Never sends Go, Record or anything that plays. Needs bridge 0.25.0.",
      inputSchema: {
        timecode: z.number(),
        mode: z.enum(["create", "replace", "append"]),
        name: z.string().optional(),
        fps: z.number().optional(),
        settings: z.object({ loop_mode: z.enum(["loop", "pause", "off"]).optional(), loop_count: z.number().optional(), tc_slot: z.union([z.literal("internal"), z.number()]).optional(), switch_off: z.enum(["keep", "off"]).optional(), assert_previous_events: z.boolean().optional() }).optional(),
        tracks: z.array(z.object({ sequence: z.number(), events: z.array(z.object({ at: timeSchema, action: z.enum(Object.keys(ACTIONS) as [Action, ...Action[]]), cue: z.union([z.number(), z.string()]).optional() })) })),
        allow_unpaired: z.boolean().optional(),
        preview: z.boolean().optional(),
        verify: z.boolean().optional(),
      },
    },
    async (args) => operation(() => buildTimecode(ctx, args)),
  );

  server.registerTool(
    "gma3_timecode_transport",
    {
      title: "Play, stop, rewind or seek a timecode show and observe it",
      description:
        "PLAYS when asked and OBSERVES OVER TIME on the server side (no Lua loop needed): play sends Go Timecode N (from the cursor, internal time; with a timecode slot the time comes from the slot), stop sends Off (playbacks it started keep running unless switch_off is off), rewind sends Top, seek writes the cursor (to: a time as in gma3_build_timecode). Recording is not offered. " +
        "Then samples the cursor and the target sequences for observe_seconds (play: default 5) and, for play, checks every event the cursor crossed against the sequences' observed cue changes in order (goto -> that cue, go -> the next cue, off -> off, presses -> running; others are listed as not predictable). The result separates dispatched from observed.",
      inputSchema: { timecode: z.number(), action: z.enum(["play", "stop", "rewind", "seek"]), to: timeSchema.optional(), fps: z.number().optional(), observe_seconds: z.number().optional(), interval_ms: z.number().optional() },
    },
    async (args) => operation(() => timecodeTransport(ctx, args)),
  );
};
