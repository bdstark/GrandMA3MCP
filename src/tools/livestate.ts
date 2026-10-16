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
  /** The cue the console names when activity could not be read: it may be current or a sticky last cue. */
  observedCue?: CueRef;
}

function cueRefOf(v: unknown): CueRef | null {
  if (!v || typeof v !== "object") return null;
  const c = v as { no?: unknown; name?: unknown };
  const no = typeof c.no === "number" && Number.isFinite(c.no) ? Math.round(c.no * 1000) / 1000 : null;
  const name = typeof c.name === "string" ? c.name : null;
  return no === null && name === null ? null : { no, name };
}

/**
 * A sequence's playback state from a bridge summary ({ hasActivePlayback, currentCue }). A cue is current only with
 * hasActivePlayback true; without a readable activity flag the console's cue is reported as observedCue (it may be a
 * sticky last cue), never as current.
 */
export function playbackState(raw: unknown): PlaybackState {
  const r = raw && typeof raw === "object" ? (raw as { hasActivePlayback?: unknown; currentCue?: unknown }) : {};
  const active = typeof r.hasActivePlayback === "boolean" ? r.hasActivePlayback : null;
  const cue = cueRefOf(r.currentCue);
  if (active === true) return { active, currentCue: cue };
  if (!cue) return { active, currentCue: null };
  return active === false ? { active, currentCue: null, lastCue: cue } : { active, currentCue: null, observedCue: cue };
}

/**
 * Rewrite a sequence summary in place: currentCue only while the sequence plays, lastCue after Off, observedCue when
 * activity is unknown. A sequence is recognised by its class or by the activity flag; other objects are left alone.
 */
export function annotatePlayback<T>(item: T): T {
  if (!item || typeof item !== "object") return item;
  const o = item as Record<string, unknown>;
  if (o.class !== "Sequence" && !("hasActivePlayback" in o)) return item;
  const s = playbackState(o);
  o.currentCue = s.currentCue;
  for (const k of ["lastCue", "observedCue"] as const) {
    if (s[k]) o[k] = s[k];
    else delete o[k];
  }
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

/**
 * The playback state of `Sequence n [Cue c]`, `Sequence "name" [Cue c]` or `Executor n` (current page); other targets
 * are not read. A name may not contain a double quote.
 */
export async function readTargetState(bridge: Gma3Bridge, target: string, t?: number): Promise<TargetState> {
  const seq = target.match(/^\s*Sequence\s+(\d+|"[^"]+")(?:\s+Cue\s+[\d.]+)?\s*$/i);
  const exec = target.match(/^\s*Executor\s+(\d+)\s*$/i);
  try {
    if (seq) {
      const o = (await bridge.request("object", { ref: `Sequence ${seq[1]}`, properties: false }, t)) as Record<string, unknown>;
      if (o.class !== undefined && o.class !== "Sequence") return { target, notRead: `${target} resolved to a ${String(o.class)}, not a sequence` };
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
  return { target, notRead: 'the state is read for Sequence n, Sequence "name" and Executor n targets only' };
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
  /** undefined until the channel's first readable sample. */
  first: Sample | undefined;
  last: Sample | undefined;
  min: number | null;
  max: number | null;
  changes: Array<{ ms: number; from: Sample; to: Sample }>;
  changeCount: number;
  /** Samples in which the console gave no value for this channel (availability, never a value). */
  unread: number;
  unreadable: Array<{ fromMs: number; toMs: number | null }>;
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

  // One sample: key -> entry. `readable: false` is a channel the console gave no value for (output on a universe that
  // is not granted): availability, never a value. A read that does not cover the whole scope throws Incomplete and
  // the sample is a gap: absence is inferred only from a complete read.
  type Entry = { id: Record<string, unknown>; value: Sample; readable: boolean };
  type Read = Map<string, Entry>;
  class Incomplete extends Error {}
  const readProgrammer = async (): Promise<Read> => {
    const res = (await bridge.request("programmer", { scope: "fixtures", fixtures: range, limit: 5000, offset: 0, maxChannels: 5000 }, t)) as { rows?: Row[]; coverage?: { complete?: boolean }; total?: unknown };
    const rows = res.rows ?? [];
    if (res.coverage?.complete !== true) throw new Incomplete("the programmer scan was incomplete (coverage.complete is not true)");
    if (typeof res.total === "number" && res.total > rows.length) throw new Incomplete(`the programmer read returned ${rows.length} of ${res.total} rows`);
    const out: Read = new Map();
    for (const r of rows) {
      if (!keep(r.attribute)) continue;
      const id = { fid: r.fid ?? null, subfixtureIndex: r.subfixtureIndex ?? null, attribute: r.attribute ?? null };
      out.set(`${id.fid}|${id.subfixtureIndex}|${id.attribute}`, { id, value: programmerSample(r), readable: true });
    }
    return out;
  };
  const readOutput = async (): Promise<Read> => {
    const out: Read = new Map();
    for (const ref of singles) {
      const res = (await bridge.request("fixtureOutput", { ref, nonzeroOnly: false, limit: 2000, offset: 0 }, t)) as { channels?: Row[]; total?: unknown };
      const channels = res.channels ?? [];
      if (typeof res.total === "number" && res.total > channels.length) throw new Incomplete(`${ref}: the output read returned ${channels.length} of ${res.total} channels`);
      for (const c of channels) {
        if (!keep(c.attribute)) continue;
        const id = { fixture: ref, channel: c.channel ?? null, attribute: c.attribute ?? null, universe: c.universe ?? null, address: c.address ?? null };
        const readable = typeof c.value === "number";
        out.set(`${ref}|${c.rtIndex ?? c.channel}`, { id, value: readable ? (c.value as number) : null, readable });
      }
    }
    return out;
  };
  const read = source === "programmer" ? readProgrammer : readOutput;
  const scope = range && source === "programmer" ? { fixtures: range } : { fixtures: singles };

  let first: Read;
  try {
    first = await read();
  } catch (err) {
    if (!(err instanceof Incomplete)) throw err;
    return { tool: "gma3_observe_values", source, ...scope, observed: false, reason: `the first read was incomplete: ${err.message}. Nothing was sampled; narrow fixtures or attributes.` };
  }
  // Output is checked up front: when no channel has a readable value (a universe that is not granted) there is nothing to watch.
  const universesOf = (entries: Iterable<{ id: Record<string, unknown> }>) => [...new Set([...entries].map((e) => Number(e.id.universe)).filter((u) => Number.isInteger(u) && u > 0))];
  if (source === "output" && first.size && [...first.values()].every((e) => !e.readable)) {
    const universes = universesOf(first.values());
    return {
      tool: "gma3_observe_values",
      source,
      ...scope,
      observed: false,
      reason: `output cannot be read: none of the ${first.size} channel(s) has a readable value${universes.length ? ` (universe ${universes.join(", ")}: see outputState)` : ""}. Nothing was sampled; use source "programmer", or grant the universes (gma3_dmx_output).`,
      outputState: (await explainUniverses(bridge, universes, t)) ?? "the universes' state could not be read (needs bridge 0.30.0; see gma3_dmx_output)",
    };
  }
  if (!first.size) {
    return {
      tool: "gma3_observe_values",
      source,
      ...scope,
      observed: false,
      reason: source === "programmer" ? "the programmer holds no values for these fixtures" + (attrs ? " and attributes" : "") + " (complete read); nothing was sampled" : "no output channel matched; nothing was sampled",
    };
  }

  const tracks = new Map<string, Track>();
  const observe = (key: string, e: Entry, ms: number) => {
    let tr = tracks.get(key);
    if (!tr) {
      tr = { id: e.id, first: undefined, last: undefined, min: null, max: null, changes: [], changeCount: 0, unread: 0, unreadable: [] };
      tracks.set(key, tr);
      // A programmer channel that appears mid-window was absent (released) in the complete reads before.
      if (ms !== 0 && source === "programmer") tr.first = tr.last = null;
    }
    const gap = tr.unreadable.at(-1);
    if (!e.readable) {
      tr.unread++;
      if (!gap || gap.toMs !== null) tr.unreadable.push({ fromMs: ms, toMs: null });
      return;
    }
    if (gap && gap.toMs === null) gap.toMs = ms;
    if (tr.last === undefined) tr.first = tr.last = e.value;
    else if (tr.last !== e.value) {
      tr.changeCount++;
      if (tr.changes.length < CHANGES_PER_CHANNEL) tr.changes.push({ ms, from: tr.last, to: e.value });
      tr.last = e.value;
    }
    if (typeof e.value === "number") {
      tr.min = tr.min === null ? e.value : Math.min(tr.min, e.value);
      tr.max = tr.max === null ? e.value : Math.max(tr.max, e.value);
    }
  };
  for (const [k, e] of first) observe(k, e, 0);

  const t0 = Date.now();
  let samples = 1;
  let unread = 0;
  const gapReasons = new Set<string>();
  let maxReadMs = 0;
  while (Date.now() - t0 < secs * 1000) {
    await sleep(intervalMs);
    const r0 = Date.now();
    const s = await read().catch((err: unknown) => {
      gapReasons.add(err instanceof Error ? err.message : String(err));
      return null;
    });
    maxReadMs = Math.max(maxReadMs, Date.now() - r0);
    if (!s) {
      unread++;
      continue;
    }
    samples++;
    const ms = Date.now() - t0;
    for (const [k, e] of s) observe(k, e, ms);
    for (const [k, tr] of tracks) {
      if (s.has(k)) continue;
      // Missing from a complete programmer read: released. Missing from an output read: not readable this time.
      if (source === "programmer") {
        if (tr.last !== null) observe(k, { id: tr.id, value: null, readable: true }, ms);
      } else observe(k, { id: tr.id, value: null, readable: false }, ms);
    }
  }
  const all = [...tracks.values()];
  const gapInfo = (tr: Track) => (tr.unread ? { unreadSamples: tr.unread, unreadable: tr.unreadable } : {});
  const blind = all.filter((tr) => tr.unread > 0);
  const outputState = source === "output" && blind.length ? ((await explainUniverses(bridge, universesOf(blind), t)) ?? "the universes' state could not be read (see gma3_dmx_output)") : undefined;
  return {
    tool: "gma3_observe_values",
    source,
    ...scope,
    observed: true,
    seconds: Math.round((Date.now() - t0) / 10) / 100,
    samples,
    unreadSamples: unread,
    ...(gapReasons.size ? { gapReasons: [...gapReasons].slice(0, 5) } : {}),
    resolutionMs: Math.round(intervalMs + maxReadMs),
    channels: all.length,
    changedChannels: all.filter((tr) => tr.changeCount > 0).length,
    changed: all
      .filter((tr) => tr.changeCount > 0)
      .map((tr) => ({
        ...tr.id,
        first: tr.first ?? null,
        last: tr.last ?? null,
        ...(tr.min !== null ? { min: tr.min, max: tr.max } : {}),
        changeCount: tr.changeCount,
        changes: tr.changes,
        ...(tr.changeCount > tr.changes.length ? { changesNote: `first ${tr.changes.length} of ${tr.changeCount} changes listed` } : {}),
        ...gapInfo(tr),
      })),
    unchanged: all.filter((tr) => tr.changeCount === 0 && tr.last !== undefined).map((tr) => ({ ...tr.id, value: tr.last, ...gapInfo(tr) })),
    ...(blind.length ? { unreadableChannels: blind.map((tr) => ({ ...tr.id, everRead: tr.last !== undefined, unreadSamples: tr.unread, unreadable: tr.unreadable })) } : {}),
    ...(outputState ? { outputState } : {}),
    notes: [
      source === "programmer"
        ? "programmer values (percent of the channel function's range; a multi-step phaser reads as its step count: the programmer holds steps, not a running value); null means the channel left the programmer (released), inferred only from complete reads"
        : "raw DMX output per channel (8/16/24-bit as the channel is patched); these are output levels, not programmer values. A channel without a readable value is a gap (unreadable, with its intervals), never a change; the last level is kept across it",
      `sampled every ${intervalMs} ms over the bridge; a change faster than resolutionMs can be missed, and an unread or incomplete sample is a gap, never a value`,
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
