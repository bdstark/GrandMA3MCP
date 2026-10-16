/**
 * SU-17: resync and the tempo-sync plugin (SETUP.md SU-17, docs/probes/su-17-resync-tempo-sync-macos-2.5.1.md).
 *
 *   resyncPlayback              gma3_playback action "resync": ReSync for sequences and ranges, each checked first and
 *                               read back a frame later
 *   gma3_tempo_sync_status      read-only: whether the tempo-sync plugin (bdstark/gma3-beat-sync) is imported and
 *                               running, and its published state (tempo, beat, peers, drift, problems)
 *   gma3_configure_tempo_sync   sets or clears the plugin's configuration variables, read back
 *
 * The plugin is a separate program (GPL, its own repository): these tools reach it only through the console, by its
 * global variables BeatSync.* (configuration it reads every 0.5 s; status it writes four times a second). No OSC and
 * no console network setting is touched; the multicast interfaces (BeatSync.Interfaces) are shown, never written.
 * Starting the plugin is left to the operator: `Plugin "gma3_beat_sync"` sent through the bridge's cmd would block in
 * the plugin's loop.
 */
import { z } from "zod";
import type { Gma3Bridge } from "../bridge.js";
import { asRead, buildResult, notRequested, stepFromError, unavailable, validationFailure, type OperationResult, type StepResult, type Verification } from "../results.js";
import { json, operation, type RegisterTools, type ToolContext } from "./context.js";
import { readTargetState, FRAME_DELAY_MS } from "./livestate.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const PLUGIN = "gma3_beat_sync";
export const PLUGIN_NAME = "the tempo-sync plugin (bdstark/gma3-beat-sync)";
export const START_HINT = `start it at the console with Plugin "${PLUGIN}" (from the command line or a macro; the bridge cannot start it: its command would block in the plugin's loop)`;
/** The plugin rewrites its status four times a second; an older Updated means it is not running (BS-02). */
export const STALE_S = 2;
const MAX_SEQUENCES = 100;

// ---------------------------------------------------------------------------
// ReSync
// ---------------------------------------------------------------------------

/**
 * The sequence numbers of a target such as "Sequence 1 + 11 Thru 19 + 31": null when the target is not a sequence list
 * (an executor, a page), and an error for a malformed list.
 */
export function sequenceList(target: string): number[] | null {
  const m = target.trim().match(/^Sequence\s+(.+)$/i);
  if (!m) return null;
  const out: number[] = [];
  for (const part of m[1].split(/\s*\+\s*/)) {
    const r = part.match(/^(\d+)(?:\s+Thru\s+(\d+))?$/i);
    if (!r) throw new Error(`"${part}" is not a sequence number or "a Thru b" range`);
    const a = Number(r[1]);
    const b = r[2] === undefined ? a : Number(r[2]);
    if (a < 1 || b < 1) throw new Error("sequence numbers start at 1");
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    if (hi - lo + 1 + out.length > MAX_SEQUENCES) throw new Error(`at most ${MAX_SEQUENCES} sequences per resync`);
    for (let n = lo; n <= hi; n++) if (!out.includes(n)) out.push(n);
  }
  return out;
}

export const RESYNC_NOTE =
  "ReSync gradually moves the start point of the phasers running in the sequences to the moment of the command (the console's manual: it synchronizes phasers gradually, it does not jump). It does not restart the sequence or change its cue.";

/** ReSync for sequences (single, lists, ranges) or another playback target; read back a frame later. */
export async function resyncPlayback(ctx: ToolContext, target: string): Promise<OperationResult> {
  const op = "resync";
  let seqs: number[] | null;
  try {
    seqs = sequenceList(target);
  } catch (err) {
    return validationFailure(op, { target }, [(err as Error).message]);
  }
  return ctx.mutations.run(async () => {
    const t = ctx.requestTimeoutMs;
    const steps: StepResult[] = [];
    // Every sequence must exist: ReSync of a range skips a missing one silently, which would hide a typo.
    if (seqs) {
      const missing: number[] = [];
      for (const n of seqs) {
        try {
          const r = (await ctx.bridge.request("objects", { ref: `Sequence ${n}`, limit: 1 }, t)) as { total?: number };
          if (!r.total) missing.push(n);
        } catch (err) {
          steps.push(asRead(stepFromError(`check Sequence ${n}`, err, { op: "objects" })));
          return buildResult({ operation: op, target: { target }, steps, verification: unavailable("ReSync was not sent") });
        }
      }
      steps.push(asRead({ name: "check_sequences", status: missing.length ? "failed" : "succeeded", op: "objects", ...(missing.length ? { error: `Sequence ${missing.join(", ")} does not exist; ReSync was not sent` } : {}), detail: { sequences: seqs.length } }));
      if (missing.length) return buildResult({ operation: op, target: { target, sequences: seqs }, steps, verification: unavailable("ReSync was not sent") });
    }
    const command = `ReSync ${target.trim()}`;
    try {
      const r = (await ctx.bridge.request("cmd", { command }, t)) as { feedback?: unknown };
      const fb = r?.feedback === undefined || r?.feedback === null ? null : String(r.feedback);
      const bad = fb !== null && /error|unknown|illegal|not found|syntax/i.test(fb);
      steps.push({ name: "resync", status: bad ? "failed" : "succeeded", op: "cmd", command, feedback: fb, ...(bad ? { error: `the console answered ${JSON.stringify(fb)}` } : {}) });
      if (bad) return buildResult({ operation: op, target: { target }, steps, verification: unavailable("the console refused ReSync") });
    } catch (err) {
      steps.push(stepFromError("resync", err, { op: "cmd", command }));
      return buildResult({ operation: op, target: { target }, steps, verification: unavailable("ReSync's reply was not received; it was not resent") });
    }
    // Read back each sequence a frame later: which ones play (ReSync acts on running phasers only) and their cue.
    await sleep(FRAME_DELAY_MS);
    let verification: Verification = notRequested();
    const states: unknown[] = [];
    if (seqs) {
      for (const n of seqs) {
        const s = await readTargetState(ctx.bridge, `Sequence ${n}`, t);
        states.push({ sequence: n, ...(s.notRead ? { notRead: s.notRead } : { active: s.active ?? null, currentCue: s.currentCue ?? null, ...(s.lastCue ? { lastCue: s.lastCue } : {}) }) });
      }
      const unread = states.filter((s) => (s as { notRead?: string }).notRead).length;
      const idle = states.filter((s) => (s as { active?: boolean }).active === false).map((s) => (s as { sequence: number }).sequence);
      verification = unread
        ? unavailable(`${unread} sequence state(s) could not be read`, "each sequence's playback state a frame after ReSync")
        : { status: "matched", checked: "each sequence's playback state a frame after ReSync (a phaser's realignment is gradual and its output is not observable over the bridge)", actual: { playing: states.length - idle.length, idle } };
    }
    const idleList = states.filter((s) => (s as { active?: boolean }).active === false).map((s) => (s as { sequence: number }).sequence);
    return buildResult({
      operation: op,
      target: { target, ...(seqs ? { sequences: seqs } : {}) },
      steps,
      verification,
      summary: `ReSync sent for ${seqs ? `${seqs.length} sequence(s)` : target}.${idleList.length ? ` Not playing (nothing to realign): Sequence ${idleList.join(", ")}.` : ""} ${RESYNC_NOTE}`,
      extra: { note: RESYNC_NOTE, ...(seqs ? { states } : { notReadBack: "the state is read back for Sequence targets only" }) },
    });
  });
}

// ---------------------------------------------------------------------------
// Plugin status and configuration
// ---------------------------------------------------------------------------

export const STATUS_KEYS = ["State", "Peers", "Session", "Tempo", "Beat", "Phase", "Playing", "LastAction", "DriftMsPerMin", "FrameMs", "FrameJitterMs", "DroppedFrames", "MissedBeats", "Problems", "Error", "Version", "Updated"] as const;
export const CONFIG_KEYS = ["Master", "Quantum", "StartStop", "Resync", "OnBar", "OnBeat", "OnStart", "OnStop", "OnJoin", "OnLeave", "TempoThreshold", "LeadMs", "Interfaces", ...Array.from({ length: 16 }, (_, i) => `Action${i + 1}`)] as const;
const DEFAULTS: Record<string, string> = { Quantum: "4", StartStop: "off", TempoThreshold: "0.01", LeadMs: "0", Interfaces: "127.0.0.1 0.0.0.0" };

type VarItem = { name?: string; exists?: boolean; value?: unknown };

async function readVars(bridge: Gma3Bridge, keys: readonly string[], t: number): Promise<Map<string, string | null>> {
  const r = (await bridge.request("vars.get", { scope: "global", names: keys.map((k) => `BeatSync.${k}`) }, t)) as { items?: VarItem[] };
  const out = new Map<string, string | null>();
  for (const k of keys) {
    const it = r.items?.find((x) => x.name === `BeatSync.${k}`);
    if (!it || typeof it.exists !== "boolean") throw new Error(`BeatSync.${k} could not be read`);
    out.set(k, it.exists && it.value !== undefined && it.value !== null && String(it.value) !== "" ? String(it.value) : null);
  }
  return out;
}

/** Whether the plugin is in the show's plugin pool: true, false, or null when the pool cannot be read. */
async function pluginInstalled(bridge: Gma3Bridge, t: number): Promise<{ installed: boolean | null; slot?: number; error?: string }> {
  try {
    const r = (await bridge.request("children", { ref: "DataPool.Plugins", fields: ["Name"], limit: 1000 }, t)) as { items?: Array<{ name?: string; index?: number }> };
    const hit = (r.items ?? []).find((i) => typeof i.name === "string" && i.name.toLowerCase() === PLUGIN);
    return hit ? { installed: true, slot: hit.index } : { installed: false };
  } catch (err) {
    return { installed: null, error: err instanceof Error ? err.message : String(err) };
  }
}

const num = (v: string | null | undefined) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** The console's clock (UTC epoch seconds) through show.files (bridge 0.35.0), or null. */
async function consoleNow(bridge: Gma3Bridge, t: number): Promise<number | null> {
  try {
    const r = (await bridge.request("show.files", {}, t)) as { now?: unknown };
    return typeof r.now === "number" ? r.now : null;
  } catch {
    return null;
  }
}

export interface TempoStatus {
  plugin: string;
  installed: boolean | null;
  slot?: number;
  running: boolean | null;
  explanation: string;
  [k: string]: unknown;
}

/** The plugin's status as one record: installed, running (by State and the age of Updated), and its readings. */
export function statusView(installed: { installed: boolean | null; slot?: number; error?: string }, vars: Map<string, string | null> | null, now: number | null, readError?: string): TempoStatus {
  const base = { plugin: PLUGIN_NAME, installed: installed.installed, ...(installed.slot !== undefined ? { slot: installed.slot } : {}) };
  if (!vars) return { ...base, running: null, explanation: `the plugin's status variables could not be read (${readError ?? "unknown"})` };
  const v = (k: string) => vars.get(k) ?? null;
  const state = v("State");
  const updated = v("Updated");
  const updatedMs = updated ? Date.parse(updated) : NaN;
  const age = now !== null && Number.isFinite(updatedMs) ? Math.round((now - updatedMs / 1000) * 10) / 10 : null;
  let running: boolean | null;
  let explanation: string;
  if (installed.installed === false) {
    running = false;
    explanation = `${PLUGIN_NAME} is not imported in this show${state ? " (its status variables are left from an earlier run)" : ""}. Import gma3_beat_sync.xml into an empty plugin slot, then ${START_HINT}`;
  } else if (!state || state === "not running") {
    running = false;
    explanation = `${PLUGIN_NAME} is not running${state ? "" : " (it has never published a status in this show)"}; ${START_HINT}. After a show load it is always stopped`;
  } else if (age === null) {
    running = null;
    explanation = `the plugin's state reads "${state}", but whether it is current cannot be told (${now === null ? "the console clock cannot be read (needs bridge 0.35.0)" : "BeatSync.Updated is not a time"})`;
  } else if (age > STALE_S) {
    running = false;
    explanation = `${PLUGIN_NAME} is not running: its status was last written ${age} s ago (it writes four times a second; the values are left from an earlier run, e.g. saved with the show); ${START_HINT}`;
  } else {
    running = true;
    explanation =
      state === "following"
        ? `${PLUGIN_NAME} is running and following a session at ${v("Tempo") ?? "?"} BPM with ${v("Peers") ?? "?"} peer(s)${v("Playing") === "yes" ? ", playing" : v("Playing") === "no" ? ", stopped" : ""}`
        : `${PLUGIN_NAME} is running; state "${state}"`;
  }
  const last = v("LastAction");
  const problems = v("Problems");
  return {
    ...base,
    running,
    explanation,
    state,
    updated,
    updatedAgeS: age,
    tempo: num(v("Tempo")),
    beat: num(v("Beat")),
    phase: num(v("Phase")),
    peers: num(v("Peers")),
    playing: v("Playing") === "yes" ? true : v("Playing") === "no" ? false : null,
    session: v("Session"),
    driftMsPerMin: num(v("DriftMsPerMin")),
    frameMs: num(v("FrameMs")),
    frameJitterMs: num(v("FrameJitterMs")),
    droppedFrames: num(v("DroppedFrames")),
    missedBeats: num(v("MissedBeats")),
    lastAction: last ? { text: last, result: /failed:/.test(last) ? "failed" : /uncertain:/.test(last) ? "uncertain" : "ok" } : null,
    problems: problems ? problems.split(/;\s*/).filter(Boolean) : [],
    error: v("Error"),
    version: v("Version"),
    ...(installed.error ? { installedNote: `the plugin pool could not be read: ${installed.error}` } : {}),
    ...(running === true ? {} : { valuesNote: "tempo, beat and the other readings are the last published values; they are not live while the plugin is not running" }),
  };
}

function configView(vars: Map<string, string | null>) {
  const out: Record<string, unknown> = {};
  for (const k of CONFIG_KEYS) {
    const v = vars.get(k) ?? null;
    if (v !== null || DEFAULTS[k] !== undefined || ["Master", "Resync"].includes(k)) out[k] = v === null ? { value: null, default: DEFAULTS[k] ?? null } : v;
  }
  return out;
}

// Configuration keys the tool writes, with validation. Interfaces is a console network setting: shown, never written.
const COMMAND = (field: string, v: unknown): string => {
  if (typeof v !== "string" || !v.trim() || v.length > 255 || /[\u0000-\u001f]/.test(v)) throw new Error(`${field} must be a console command of 1-255 characters without control characters (or null to clear)`);
  return v.trim();
};
const intIn = (field: string, v: unknown, lo: number, hi: number): string => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) throw new Error(`${field} must be an integer ${lo}-${hi} (or null to clear)`);
  return String(v);
};
const numIn = (field: string, v: unknown, lo: number, hi: number): string => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) throw new Error(`${field} must be a number ${lo}-${hi} (or null to clear)`);
  return String(v);
};

interface Write {
  key: string;
  value: string | null;
}

export function planConfig(raw: Record<string, unknown>): { writes: Write[]; errors: string[]; sequences: number[] } {
  const errors: string[] = [];
  const writes: Write[] = [];
  const sequences: number[] = [];
  const put = (key: string, rawValue: unknown, conv: (v: unknown) => string) => {
    if (rawValue === undefined) return;
    if (rawValue === null) return void writes.push({ key, value: null });
    try {
      writes.push({ key, value: conv(rawValue) });
    } catch (err) {
      errors.push((err as Error).message);
    }
  };
  put("Master", raw.master, (v) => intIn("master", v, 1, 16));
  put("Quantum", raw.quantum, (v) => intIn("quantum", v, 1, 64));
  put("StartStop", raw.start_stop, (v) => {
    if (v !== "on" && v !== "off") throw new Error('start_stop must be "on" or "off" (or null to clear)');
    return v;
  });
  put("Resync", raw.resync, (v) => {
    const list = Array.isArray(v) ? v : typeof v === "string" ? null : (() => { throw new Error("resync must be a list of sequence numbers or a sequence list such as \"1 + 11 Thru 19\" (or null to clear)"); })();
    const nums = list ? list.map((x) => {
      if (typeof x !== "number" || !Number.isInteger(x) || x < 1) throw new Error("resync lists sequence numbers (positive integers)");
      return x;
    }) : sequenceList(`Sequence ${v}`)!;
    if (!nums.length) throw new Error("resync must name at least one sequence (or null to clear)");
    sequences.push(...nums);
    // The plugin takes numbers separated by commas or spaces.
    return [...new Set(nums)].join(",");
  });
  for (const [k, field] of [["OnBar", "on_bar"], ["OnBeat", "on_beat"], ["OnStart", "on_start"], ["OnStop", "on_stop"], ["OnJoin", "on_join"], ["OnLeave", "on_leave"]] as const) put(k, raw[field], (v) => COMMAND(field, v));
  put("TempoThreshold", raw.tempo_threshold, (v) => numIn("tempo_threshold", v, 0, 10));
  put("LeadMs", raw.lead_ms, (v) => numIn("lead_ms", v, 0, 200));
  if (raw.actions !== undefined) {
    if (!Array.isArray(raw.actions)) errors.push("actions must be a list of {slot, every, phase, command} or {slot, clear: true}");
    else {
      const seen = new Set<number>();
      raw.actions.forEach((a: Record<string, unknown>, i: number) => {
        const p = `actions[${i}]`;
        if (!a || typeof a !== "object") return void errors.push(`${p} must be an object`);
        const slot = a.slot;
        if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 1 || slot > 16) return void errors.push(`${p}.slot must be 1-16`);
        if (seen.has(slot)) return void errors.push(`${p}: action slot ${slot} appears more than once`);
        seen.add(slot);
        if (a.clear === true) return void writes.push({ key: `Action${slot}`, value: null });
        try {
          const every = Number(intIn(`${p}.every`, a.every, 1, 64));
          const phase = Number(intIn(`${p}.phase`, a.phase ?? 0, 0, 63));
          if (phase >= every) throw new Error(`${p}.phase must be below every (${every})`);
          writes.push({ key: `Action${slot}`, value: `${every} ${phase} ${COMMAND(`${p}.command`, a.command)}` });
        } catch (err) {
          errors.push((err as Error).message);
        }
      });
    }
  }
  if (raw.interfaces !== undefined) errors.push("interfaces (the plugin's multicast memberships) is a console network setting and is not configured by these tools");
  return { writes, errors, sequences };
}

export async function configureTempoSync(ctx: ToolContext, raw: Record<string, unknown>): Promise<OperationResult> {
  const op = "configure_tempo_sync";
  const { writes, errors, sequences } = planConfig(raw);
  if (!writes.length && !errors.length) errors.push("nothing to change: give master, quantum, start_stop, resync, on_bar, on_beat, on_start, on_stop, on_join, on_leave, actions, tempo_threshold and/or lead_ms");
  const target = { keys: writes.map((w) => `BeatSync.${w.key}`) };
  if (errors.length) return validationFailure(op, target, errors);
  return ctx.mutations.run(async () => {
    const t = ctx.requestTimeoutMs;
    const steps: StepResult[] = [];
    let before: Map<string, string | null>;
    try {
      before = await readVars(ctx.bridge, writes.map((w) => w.key), t);
      steps.push(asRead({ name: "read_config", status: "succeeded", op: "vars.get" }));
    } catch (err) {
      const msg = err instanceof Error && /unknown op/i.test(err.message) ? "the console runs an older bridge plugin without the variable ops (bridge 0.31.0)" : undefined;
      steps.push(asRead(stepFromError("read_config", msg ? new Error(msg) : err, { op: "vars.get" })));
      return buildResult({ operation: op, target, steps, verification: unavailable("nothing was written") });
    }
    // The sequences ReSync is asked to realign must exist (the plugin would report them as a problem every bar).
    const missing: number[] = [];
    for (const n of [...new Set(sequences)]) {
      const r = (await ctx.bridge.request("objects", { ref: `Sequence ${n}`, limit: 1 }, t).catch(() => null)) as { total?: number } | null;
      if (!r) {
        steps.push(asRead({ name: "check_sequences", status: "failed", error: `Sequence ${n} could not be checked; nothing was written` }));
        return buildResult({ operation: op, target, steps, verification: unavailable("nothing was written") });
      }
      if (!r.total) missing.push(n);
    }
    if (missing.length) {
      steps.push(asRead({ name: "check_sequences", status: "failed", error: `Sequence ${missing.join(", ")} does not exist; nothing was written` }));
      return buildResult({ operation: op, target, steps, verification: unavailable("nothing was written") });
    }
    let stopped: string | undefined;
    for (const w of writes) {
      if (stopped) {
        steps.push({ name: `BeatSync.${w.key}`, status: "skipped", error: `not sent: the call stopped at ${stopped}` });
        continue;
      }
      if (w.value === (before.get(w.key) ?? null)) {
        steps.push({ name: `BeatSync.${w.key}`, status: "succeeded", detail: { unchanged: true } });
        continue;
      }
      try {
        if (w.value === null) await ctx.bridge.request("vars.delete", { scope: "global", name: `BeatSync.${w.key}` }, t);
        else await ctx.bridge.request("vars.set", { scope: "global", name: `BeatSync.${w.key}`, value: w.value, type: "text" }, t);
        steps.push({ name: `BeatSync.${w.key}`, status: "succeeded", op: w.value === null ? "vars.delete" : "vars.set", detail: { value: w.value } });
      } catch (err) {
        steps.push(stepFromError(`BeatSync.${w.key}`, err, { op: w.value === null ? "vars.delete" : "vars.set" }));
        stopped = `BeatSync.${w.key}`;
      }
    }
    let verification: Verification;
    let after: Map<string, string | null> | undefined;
    try {
      after = await readVars(ctx.bridge, writes.map((w) => w.key), t);
      steps.push(asRead({ name: "read_back", status: "succeeded", op: "vars.get" }));
      const mism = writes.filter((w) => (after!.get(w.key) ?? null) !== w.value).map((w) => `BeatSync.${w.key} reads ${JSON.stringify(after!.get(w.key) ?? null)}, expected ${JSON.stringify(w.value)}`);
      verification = mism.length ? { status: "mismatched", checked: "every written variable, read back", detail: mism.join("; ") } : { status: "matched", checked: "every written variable, read back" };
    } catch (err) {
      steps.push(asRead(stepFromError("read_back", err, { op: "vars.get" })));
      verification = unavailable("the configuration could not be read back");
    }
    // The plugin reads its configuration every 0.5 s: when it runs, its problems after that show what it made of it.
    const installed = await pluginInstalled(ctx.bridge, t);
    let pluginNote: Record<string, unknown> = {};
    try {
      await sleep(700);
      const s = statusView(installed, await readVars(ctx.bridge, STATUS_KEYS, t), await consoleNow(ctx.bridge, t));
      pluginNote = { plugin: { running: s.running, explanation: s.explanation, problems: s.problems } };
    } catch {
      pluginNote = { plugin: { running: null, explanation: "the plugin's status could not be read" } };
    }
    const problems = ((pluginNote.plugin as { problems?: string[] }).problems ?? []).filter((p) => writes.some((w) => p.toLowerCase().includes(w.key.toLowerCase())));
    return buildResult({
      operation: op,
      target,
      steps,
      verification,
      warnings: [
        ...((pluginNote.plugin as { running?: boolean | null }).running === true ? [] : [`${PLUGIN_NAME} is not running: the configuration is stored and takes effect when it runs (${START_HINT})`]),
        ...(problems.length ? [`the plugin reports: ${problems.join("; ")}`] : []),
        ...(writes.some((w) => ["OnBar", "OnBeat", "OnStart", "OnStop", "OnJoin", "OnLeave"].includes(w.key) || w.key.startsWith("Action")) ? ["commands in OnBar, OnBeat, Action1-16 and the event keys run on the console whenever the plugin fires them; a failed one shows in LastAction and Error"] : []),
      ],
      extra: { previous: Object.fromEntries(writes.map((w) => [`BeatSync.${w.key}`, before.get(w.key) ?? null])), ...(after ? { now: Object.fromEntries(writes.map((w) => [`BeatSync.${w.key}`, after!.get(w.key) ?? null])) } : {}), ...pluginNote },
    });
  });
}

export const registerTempoSyncTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_tempo_sync_status",
    {
      title: "Status of the tempo-sync plugin",
      description:
        "Read-only. Whether the tempo-sync plugin (bdstark/gma3-beat-sync, a separate console plugin that follows an external tempo source) is imported in this show and running, and what it publishes: state, tempo, beat, phase, peers, playing, drift, frame timing, the last action (ok / failed / uncertain), problems and errors; plus its configuration (master, quantum, actions, resync list, ...). " +
        "Running means its State is not \"not running\" and its status was written within 2 s by the console clock (after a show load it is stopped and its saved values are stale). It says plainly when the plugin is not imported or not running and how to start it. Needs bridge 0.31.0 (0.35.0 for the clock).",
      inputSchema: {},
    },
    async () => {
      const t = ctx.requestTimeoutMs;
      const installed = await pluginInstalled(ctx.bridge, t);
      let vars: Map<string, string | null> | null = null;
      let readError: string | undefined;
      try {
        vars = await readVars(ctx.bridge, [...STATUS_KEYS, ...CONFIG_KEYS], t);
      } catch (err) {
        readError = err instanceof Error ? err.message : String(err);
      }
      const status = statusView(installed, vars, await consoleNow(ctx.bridge, t), readError);
      return json({ tool: "gma3_tempo_sync_status", ...status, ...(vars ? { configuration: configView(vars) } : {}), notes: ["the tools reach the plugin only through the console's BeatSync.* variables; no OSC or network setting is involved", "BeatSync.Interfaces (multicast memberships) is a network setting: shown, never written by these tools"] });
    },
  );

  server.registerTool(
    "gma3_configure_tempo_sync",
    {
      title: "Configure the tempo-sync plugin",
      description:
        "Set or clear the tempo-sync plugin's configuration (bdstark/gma3-beat-sync; console global variables BeatSync.*, read by the plugin every 0.5 s and saved with the show), then read it back: master (speed master 1-16 the session tempo is written to), quantum (beats per bar 1-64), start_stop (on: beat actions only while the session plays), resync (sequences to ReSync on every bar; they must exist), on_bar / on_beat / on_start / on_stop / on_join / on_leave (console commands), actions ([{slot 1-16, every N beats, phase, command}] or {slot, clear: true}), tempo_threshold (BPM), lead_ms (0-200; ~17 puts the effect on the beat). null clears a key. " +
        "Interfaces (multicast) is a network setting and is refused. Works whether or not the plugin runs; when it runs, the problems it reports after reading the change are included. Needs bridge 0.31.0.",
      inputSchema: {
        master: z.number().nullable().optional(),
        quantum: z.number().nullable().optional(),
        start_stop: z.enum(["on", "off"]).nullable().optional(),
        resync: z.union([z.array(z.number()), z.string()]).nullable().optional().describe('Sequences: [1, 11, 12] or "1 + 11 Thru 19".'),
        on_bar: z.string().nullable().optional(),
        on_beat: z.string().nullable().optional(),
        on_start: z.string().nullable().optional(),
        on_stop: z.string().nullable().optional(),
        on_join: z.string().nullable().optional(),
        on_leave: z.string().nullable().optional(),
        actions: z.array(z.object({ slot: z.number(), every: z.number().optional(), phase: z.number().optional(), command: z.string().optional(), clear: z.boolean().optional() })).optional(),
        tempo_threshold: z.number().nullable().optional(),
        lead_ms: z.number().nullable().optional(),
      },
    },
    async (args) => operation(() => configureTempoSync(ctx, args)),
  );
};
