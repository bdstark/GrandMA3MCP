/**
 * SU-16: live playback and value reads.
 *
 *   playbackState / annotatePlayback   a sequence's state as { active, currentCue, lastCue } from the bridge's
 *                                      hasActivePlayback and currentCue (bridge 0.32.0)
 *   readTargetState                    the state of a Sequence or Executor a frame after a playback command
 *   gma3_observe_values                samples programmer or output values for a few seconds (server side)
 *
 * Console facts (live, 2026-10-16): Sequence.CurrentCue is a Cue handle whose `no` is the cue number x 1000. It keeps
 * naming the last cue after Off, so a cue is "current" only while the sequence has active playback; otherwise it is
 * reported as lastCue. A playback command takes effect on the console's next frame, so the state is read
 * FRAME_DELAY_MS after the command.
 */
import { z } from "zod";
import type { Gma3Bridge } from "../bridge.js";
import { json, type RegisterTools, type ToolContext } from "./context.js";
import { Validator, ValidationError, finiteNumber, oneOf } from "../validate.js";
import { explainUniverses } from "./dmxoutput.js";
import { fixtureRange, fixtureRef } from "./inspection.js";

/** Time between a playback command and the state read-back: a console frame plus the bridge's turn. */
export const FRAME_DELAY_MS = 100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface CueRef {
  no: number | null;
  name: string | null;
}

export interface PlaybackState {
  /** hasActivePlayback; null when the console did not report it. */
  active: boolean | null;
  /** The cue the sequence is in while it plays; null when it is off or has no cue. */
  currentCue: CueRef | null;
  /** The cue the console still names after Off (CurrentCue is sticky); only when the sequence is not active. */
  lastCue?: CueRef;
}

function cueRefOf(v: unknown): CueRef | null {
  if (!v || typeof v !== "object") return null;
  const c = v as { no?: unknown; name?: unknown };
  const no = typeof c.no === "number" && Number.isFinite(c.no) ? Math.round(c.no * 1000) / 1000 : null;
  const name = typeof c.name === "string" ? c.name : null;
  return no === null && name === null ? null : { no, name };
}

/** A sequence's playback state from a bridge summary ({ hasActivePlayback, currentCue }). */
export function playbackState(raw: unknown): PlaybackState {
  const r = raw && typeof raw === "object" ? (raw as { hasActivePlayback?: unknown; currentCue?: unknown }) : {};
  const active = typeof r.hasActivePlayback === "boolean" ? r.hasActivePlayback : null;
  const cue = cueRefOf(r.currentCue);
  if (active === false) return cue ? { active, currentCue: null, lastCue: cue } : { active, currentCue: null };
  return { active, currentCue: cue };
}

/**
 * Rewrite a sequence summary in place: currentCue only while the sequence plays, lastCue after Off. Objects without
 * hasActivePlayback (not a playback object) are left alone.
 */
export function annotatePlayback<T>(item: T): T {
  if (!item || typeof item !== "object" || !("hasActivePlayback" in (item as object))) return item;
  const o = item as Record<string, unknown>;
  const s = playbackState(o);
  o.currentCue = s.currentCue;
  if (s.lastCue) o.lastCue = s.lastCue;
  else delete o.lastCue;
  return item;
}

export interface TargetState extends Partial<PlaybackState> {
  target: string;
  readAfterMs?: number;
  /** The sequence read (an executor's assigned sequence). */
  sequence?: { name?: unknown; addr?: unknown };
  /** Why the state was not read. */
  notRead?: string;
}

/** The playback state of "Sequence n [Cue c]" or "Executor n" (current page); other targets are not read. */
export async function readTargetState(bridge: Gma3Bridge, target: string, t?: number): Promise<TargetState> {
  const seq = target.match(/^\s*Sequence\s+(\d+)(?:\s+Cue\s+[\d.]+)?\s*$/i);
  const exec = target.match(/^\s*Executor\s+(\d+)\s*$/i);
  try {
    if (seq) {
      const o = (await bridge.request("object", { ref: `Sequence ${seq[1]}`, properties: false }, t)) as Record<string, unknown>;
      return { target, ...playbackState(o), sequence: { name: o.name, addr: o.addr } };
    }
    if (exec) {
      const e = (await bridge.request("executor", { number: Number(exec[1]) }, t)) as { empty?: boolean; assigned?: Record<string, unknown> };
      if (e.empty || !e.assigned) return { target, notRead: `${target} is empty` };
      if (e.assigned.class !== "Sequence") return { target, notRead: `${target} holds a ${String(e.assigned.class)}, not a sequence` };
      return { target, ...playbackState(e.assigned), sequence: { name: e.assigned.name, addr: e.assigned.addr } };
    }
  } catch (err) {
    return { target, notRead: `the state read failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { target, notRead: "the state is read for Sequence n and Executor n targets only" };
}

/** Wait a frame, then read the target's state (for a command that was sent). */
export async function stateAfterFrame(bridge: Gma3Bridge, target: string, t?: number): Promise<TargetState> {
  await sleep(FRAME_DELAY_MS);
  const s = await readTargetState(bridge, target, t);
  return s.notRead ? s : { ...s, readAfterMs: FRAME_DELAY_MS };
}

// ---------------------------------------------------------------------------
// gma3_observe_values
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Sample = number | string | null;

interface Track {
  id: Record<string, unknown>;
  first: Sample;
  last: Sample;
  min: number | null;
  max: number | null;
  changes: Array<{ ms: number; from: Sample; to: Sample }>;
  changeCount: number;
}

const MAX_OUTPUT_FIXTURES = 8;
const CHANGES_PER_CHANNEL = 20;

/** A programmer row's value: percent, "phaser (n steps)", or null when the row is absent (released). */
function programmerSample(r: Row): Sample {
  if (r.present === false) return null;
  if (Array.isArray(r.steps) && r.steps.length > 1) return `phaser (${r.steps.length} steps)`;
  return typeof r.value === "number" ? Math.round(r.value * 1000) / 1000 : r.value === undefined || r.value === null ? null : String(r.value);
}

export async function observeValues(
  ctx: ToolContext,
  raw: { fixtures?: unknown; source?: unknown; attributes?: unknown; seconds?: unknown; interval_ms?: unknown },
): Promise<unknown> {
  const v = new Validator();
  const source = v.check(() => oneOf("source", raw.source, ["programmer", "output"] as const, { optional: true })) ?? "programmer";
  const secs = v.check(() => finiteNumber("seconds", raw.seconds, { min: 1, max: 30, optional: true })) ?? 5;
  const intervalMs = v.check(() => finiteNumber("interval_ms", raw.interval_ms, { min: 50, max: 2000, optional: true })) ?? 200;
  const attrs = raw.attributes === undefined ? undefined : Array.isArray(raw.attributes) && raw.attributes.length && raw.attributes.every((a) => typeof a === "string" && a.trim())
    ? new Set((raw.attributes as string[]).map((a) => a.trim().toLowerCase()))
    : (v.fail("attributes must be a non-empty list of attribute names"), undefined);
  // programmer: one range ("101 Thru 112"), or a list joined with +; output: 1-8 single fixtures.
  let range: string | undefined;
  let singles: string[] = [];
  const fixtures = typeof raw.fixtures === "number" ? [raw.fixtures] : raw.fixtures;
  if (Array.isArray(fixtures)) {
    if (!fixtures.length) v.fail("fixtures must name at least one fixture");
    singles = fixtures.map((f, i) => v.check(() => fixtureRef(`fixtures[${i}]`, f))).filter((x): x is string => !!x);
    range = singles.length ? `Fixture ${singles.map((s) => s.replace(/^(Sub)?fixture\s+/i, "")).join(" + ")}` : undefined;
  } else if (source === "output") {
    const one = v.check(() => fixtureRef("fixtures", fixtures));
    if (one) singles = [one];
  } else {
    range = v.check(() => fixtureRange("fixtures", fixtures));
  }
  if (source === "output" && singles.length > MAX_OUTPUT_FIXTURES) v.fail(`output is sampled per fixture: give at most ${MAX_OUTPUT_FIXTURES} fixtures (got ${singles.length})`);
  if (!v.ok) throw new ValidationError(v.errors.join("; "));
  const bridge = ctx.bridge;
  const t = ctx.requestTimeoutMs;
  const keep = (attribute: unknown) => !attrs || (typeof attribute === "string" && attrs.has(attribute.toLowerCase()));

  // One sample: key -> value, or null when the read failed (a gap, never a state).
  type Read = Map<string, { id: Record<string, unknown>; value: Sample }>;
  const readProgrammer = async (): Promise<Read> => {
    const res = (await bridge.request("programmer", { scope: "fixtures", fixtures: range, limit: 5000, offset: 0, maxChannels: 5000 }, t)) as { rows?: Row[]; coverage?: { complete?: boolean } };
    const out: Read = new Map();
    for (const r of res.rows ?? []) {
      if (!keep(r.attribute)) continue;
      const id = { fid: r.fid ?? null, subfixtureIndex: r.subfixtureIndex ?? null, attribute: r.attribute ?? null };
      out.set(`${id.fid}|${id.subfixtureIndex}|${id.attribute}`, { id, value: programmerSample(r) });
    }
    return out;
  };
  const readOutput = async (): Promise<Read> => {
    const out: Read = new Map();
    for (const ref of singles) {
      const res = (await bridge.request("fixtureOutput", { ref, nonzeroOnly: false, limit: 2000, offset: 0 }, t)) as { channels?: Row[] };
      for (const c of res.channels ?? []) {
        if (!keep(c.attribute)) continue;
        const id = { fixture: ref, channel: c.channel ?? null, attribute: c.attribute ?? null, universe: c.universe ?? null, address: c.address ?? null };
        out.set(`${ref}|${c.rtIndex ?? c.channel}`, { id, value: typeof c.value === "number" ? c.value : null });
      }
    }
    return out;
  };
  const read = source === "programmer" ? readProgrammer : readOutput;

  // Output is checked up front: a universe that is not granted has no readable values, so there is nothing to watch.
  const first = await read();
  let outputState: unknown;
  let unreadable: string[] = [];
  if (source === "output") {
    const blind = [...first.values()].filter((e) => e.value === null);
    const universes = [...new Set(blind.map((e) => Number(e.id.universe)).filter((u) => Number.isInteger(u) && u > 0))];
    if (blind.length) outputState = (await explainUniverses(bridge, universes, t)) ?? "the universes' state could not be read (needs bridge 0.30.0; see gma3_dmx_output)";
    if (first.size && blind.length === first.size) {
      return {
        tool: "gma3_observe_values",
        source,
        fixtures: singles,
        observed: false,
        reason: `output cannot be read: none of the ${first.size} channel(s) has a readable value${universes.length ? ` (universe ${universes.join(", ")}: see outputState)` : ""}. Nothing was sampled; use source "programmer", or grant the universes (gma3_dmx_output).`,
        outputState,
      };
    }
    unreadable = blind.map((e) => `${e.id.fixture} ${e.id.channel}`);
  }
  if (!first.size) {
    return {
      tool: "gma3_observe_values",
      source,
      ...(range ? { fixtures: range } : { fixtures: singles }),
      observed: false,
      reason: source === "programmer" ? "the programmer holds no values for these fixtures" + (attrs ? " and attributes" : "") + "; nothing was sampled" : "no output channel matched; nothing was sampled",
    };
  }

  const tracks = new Map<string, Track>();
  const note = (key: string, id: Record<string, unknown>, value: Sample, ms: number) => {
    let tr = tracks.get(key);
    if (!tr) {
      tr = { id, first: ms === 0 ? value : null, last: ms === 0 ? value : null, min: null, max: null, changes: [], changeCount: 0 };
      tracks.set(key, tr);
      if (ms !== 0) {
        // A channel that appears mid-window was absent (released) before.
        tr.changeCount++;
        tr.changes.push({ ms, from: null, to: value });
        tr.last = value;
      }
    } else if (tr.last !== value) {
      tr.changeCount++;
      if (tr.changes.length < CHANGES_PER_CHANNEL) tr.changes.push({ ms, from: tr.last, to: value });
      tr.last = value;
    }
    if (typeof value === "number") {
      tr.min = tr.min === null ? value : Math.min(tr.min, value);
      tr.max = tr.max === null ? value : Math.max(tr.max, value);
    }
  };
  for (const [k, e] of first) note(k, e.id, e.value, 0);

  const t0 = Date.now();
  let samples = 1;
  let unread = 0;
  let maxReadMs = 0;
  while (Date.now() - t0 < secs * 1000) {
    await sleep(intervalMs);
    const r0 = Date.now();
    const s = await read().catch(() => null);
    maxReadMs = Math.max(maxReadMs, Date.now() - r0);
    if (!s) {
      unread++;
      continue;
    }
    samples++;
    const ms = Date.now() - t0;
    for (const [k, e] of s) note(k, e.id, e.value, ms);
    // A programmer channel that disappears was released.
    if (source === "programmer") for (const [k, tr] of tracks) if (!s.has(k) && tr.last !== null) note(k, tr.id, null, ms);
  }
  const all = [...tracks.values()];
  const changed = all.filter((tr) => tr.changeCount > 0);
  return {
    tool: "gma3_observe_values",
    source,
    ...(range && source === "programmer" ? { fixtures: range } : { fixtures: singles }),
    observed: true,
    seconds: Math.round((Date.now() - t0) / 10) / 100,
    samples,
    unreadSamples: unread,
    resolutionMs: Math.round(intervalMs + maxReadMs),
    channels: all.length,
    changedChannels: changed.length,
    changed: changed.map((tr) => ({
      ...tr.id,
      first: tr.first,
      last: tr.last,
      ...(tr.min !== null ? { min: tr.min, max: tr.max } : {}),
      changeCount: tr.changeCount,
      changes: tr.changes,
      ...(tr.changeCount > tr.changes.length ? { changesNote: `first ${tr.changes.length} of ${tr.changeCount} changes listed` } : {}),
    })),
    unchanged: all.filter((tr) => tr.changeCount === 0).map((tr) => ({ ...tr.id, value: tr.last })),
    ...(unreadable.length ? { unreadableChannels: unreadable, outputState } : {}),
    notes: [
      source === "programmer"
        ? "programmer values (percent of the channel function's range; a multi-step phaser reads as its step count: the programmer holds steps, not a running value); null means the channel has no programmer value (released)"
        : "raw DMX output per channel (8/16/24-bit as the channel is patched); these are output levels, not programmer values",
      `sampled every ${intervalMs} ms over the bridge; a change faster than resolutionMs can be missed, and an unread sample is a gap, never a value`,
      "selection, programmer and playback were not changed",
    ],
  };
}

export const registerLiveStateTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_observe_values",
    {
      title: "Watch fixture values change",
      description:
        "OBSERVES OVER TIME on the server side (use it instead of a Lua polling loop). Read-only. Samples the programmer values (source programmer, default) or the DMX output (source output) of fixtures for `seconds` (1-30, default 5) every interval_ms (50-2000, default 200) and reports which channels changed: first and last value, min/max and the timed changes. " +
        "Programmer: fixtures is a range (\"101 Thru 112\") or a list. Output: 1-8 fixtures; output on a universe that is not granted cannot be read, and the tool says so up front (outputState) and samples nothing. " +
        "attributes limits the channels (Dimmer, ColorRGB_R, ...). It starts nothing: run the playback or phaser first. A running phaser in the programmer reads as its steps (not a moving value); watch its output instead.",
      inputSchema: {
        fixtures: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]).describe('Fixture range ("101 Thru 112"), one fixture (101) or a list of fixtures ([101, "201.3"]).'),
        source: z.enum(["programmer", "output"]).optional(),
        attributes: z.array(z.string()).optional().describe("Only these attributes (case-insensitive)."),
        seconds: z.number().optional(),
        interval_ms: z.number().optional(),
      },
    },
    async (args) => {
      try {
        return json(await observeValues(ctx, args));
      } catch (err) {
        return { content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    },
  );
};
