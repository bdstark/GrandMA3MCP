/**
 * SB-07: macros as reusable show actions.
 *
 *   gma3_macros           read-only: the macro pool, or one macro with its lines exactly as stored, its run state and,
 *                         on request, the objects its lines refer to
 *   gma3_store_macro      create a macro, replace its lines, or append lines, with explicit mode; never runs it
 *   gma3_edit_macro_line  insert, change, move or remove one line; never runs the macro
 *   gma3_run_macro        Go+ (start or continue) or Off, then observe the run state; the result says what was
 *                         dispatched and what was observed, never that every line succeeded
 *
 * Everything uses the existing ops (`children`, `objects`, `object`, `set`, `cmd`). Console facts this module relies on
 * (onPC 2.5.1, docs/probes/sb-07-macros-macos-2.5.1.md):
 *   - Lines are MacroLine children (`Macro N.L`): Name ("MacroLine L" when unnamed, following the position), Note, Command,
 *     Wait (Follow, Go or seconds; an invalid value silently becomes Follow), Enabled, AddToCmdline, Execute.
 *   - `Store Macro N` creates an empty macro; `Store Macro N.L` past the end appends (no gap) and does nothing on an
 *     existing line; `Insert Macro N.L` inserts; `Delete Macro N.L /NoConfirmation` removes; `Move a At b` inserts (an
 *     upward move lands at b, a downward one at b-1, so only upward moves are sent).
 *   - The console rewrites command text outside quotes: it trims the ends, collapses runs of spaces and expands an
 *     abbreviated keyword ("seq" -> "Sequence", "a" -> "At", "world" -> "World"). Quoted text is kept exactly.
 *   - Lock: writes are silently ignored, Store does nothing, Delete answers "Object locked".
 *   - The macro's LineNo / LineName / LineCommand show the running line; LineNo "" when idle. A failing line does not
 *     stop the macro, and nothing shows that it failed. A disabled line is skipped with its wait. `Off Macro N` stops it.
 */
import { z } from "zod";
import type { Gma3Bridge } from "../bridge.js";
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
// Model
// ---------------------------------------------------------------------------

export type Wait = { kind: "follow" } | { kind: "go" } | { kind: "seconds"; seconds: number };

export interface MacroLine {
  line: number;
  /** null when the line carries its default name "MacroLine <line>". */
  name: string | null;
  /** Exactly as stored. */
  command: string;
  wait: Wait;
  enabled: boolean | null;
  addToCmdline: boolean | null;
  execute: boolean | null;
  note: string;
}

export interface MacroRead {
  macro: number;
  ref: string;
  exists: boolean;
  name?: string;
  note?: string;
  locked?: boolean | null;
  cli?: boolean | null;
  /** idle only when LineNo was read and empty; unknown when it is missing or malformed (never taken as idle). */
  runState?: "idle" | "running" | "unknown";
  running?: { line: number; name: string | null; command: string } | null;
  lastUser?: string | null;
  lines?: MacroLine[];
  /** Lines the read did not return (a macro with more lines than the bound). */
  incomplete?: string;
}

export const MAX_LINES = 1000;
export const MAX_COMMAND_LENGTH = 2048;
const LINE_FIELDS = ["Name", "Note", "Command", "Wait", "Enabled", "AddToCmdline", "Execute"];
const MACRO_FIELDS = ["Name", "Note", "Lock", "CLI", "LineNo", "LineName", "LineCommand", "User"];

export const macroRef = (n: number) => `Macro ${n}`;

/** The run state in a macro's fields: LineNo "" is idle, a positive integer is the running line, anything else unknown. */
export function runStateOf(f: Record<string, unknown> | undefined): { state: "idle" } | { state: "running"; line: number } | { state: "unknown" } {
  const v = f?.LineNo;
  if (typeof v === "number") return Number.isInteger(v) && v > 0 ? { state: "running", line: v } : { state: "unknown" };
  if (typeof v !== "string") return { state: "unknown" };
  const s = v.trim();
  if (s === "") return { state: "idle" };
  return /^\d+$/.test(s) && Number(s) > 0 ? { state: "running", line: Number(s) } : { state: "unknown" };
}
export const lineRef = (n: number, l: number) => `Macro ${n}.${l}`;

const yesNo = (v: unknown): boolean | null =>
  v === true || /^(yes|on|true)$/i.test(String(v ?? "").trim()) ? true : v === false || /^(no|off|false)$/i.test(String(v ?? "").trim()) ? false : null;
const text = (v: unknown) => (v === null || v === undefined ? "" : String(v));

/** The console's duration text: "2.00", "1h00m00.00", "1d03h46m40.00", "5m30.00" -> seconds; null when it is not one. */
export function displaySeconds(s: string): number | null {
  const m = s.trim().match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)?s?$/);
  if (!m || !s.trim() || (m[4] === undefined && !m[1] && !m[2] && !m[3])) return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

/**
 * A Wait as read: seconds (asText: false), "Go", "Follow", or the display text of a duration. Anything else is a
 * wait of NaN seconds, which matches nothing: an unreadable wait is never taken as Follow.
 */
export function readWait(v: unknown): Wait {
  if (typeof v === "number" && Number.isFinite(v)) return v > 0 ? { kind: "seconds", seconds: v } : { kind: "follow" };
  const s = text(v).trim();
  if (/^go$/i.test(s)) return { kind: "go" };
  if (/^follow$/i.test(s)) return { kind: "follow" };
  const n = displaySeconds(s);
  if (n !== null) return n > 0 ? { kind: "seconds", seconds: n } : { kind: "follow" };
  return { kind: "seconds", seconds: NaN };
}

/** A requested wait: "follow", "go" or seconds (0 = follow). */
export function parseWait(field: string, v: unknown): Wait | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") {
    if (/^follow$/i.test(v.trim())) return { kind: "follow" };
    if (/^go$/i.test(v.trim())) return { kind: "go" };
    throw new ValidationError(`${field} must be "follow", "go" or a number of seconds (got ${JSON.stringify(v)})`, field);
  }
  const n = finiteNumber(field, v, { min: 0, max: 360000 })!;
  if (n > 0 && n < 0.001) throw new ValidationError(`${field} below 1 ms cannot be stored (got ${n})`, field);
  return n === 0 ? { kind: "follow" } : { kind: "seconds", seconds: n };
}

export const waitValue = (w: Wait) => (w.kind === "follow" ? "Follow" : w.kind === "go" ? "Go" : String(Math.round(w.seconds * 1000) / 1000));
export const sameWait = (a: Wait, b: Wait) => a.kind === b.kind && (a.kind !== "seconds" || Math.abs(a.seconds - (b as { seconds: number }).seconds) < 0.0005);
export const describeWait = (w: Wait) => (w.kind === "seconds" ? w.seconds : w.kind);

interface Listing {
  total?: number;
  offset?: number;
  count?: number;
  items?: Array<{ name?: string; index?: number; class?: string; childCount?: number; fields?: Record<string, unknown> }>;
}

/** One macro with its lines. Missing macro -> exists: false; a line list cut at the bound is reported as incomplete. */
export async function readMacro(bridge: Gma3Bridge, n: number, t: number): Promise<MacroRead> {
  const ref = macroRef(n);
  const o = (await bridge.request("objects", { ref, fields: MACRO_FIELDS, limit: 1 }, t).catch((err: unknown) => {
    if (err instanceof Error && /no objects? found|no object at address|path not found/i.test(err.message)) return { items: [] };
    throw err;
  })) as Listing;
  const it = o.items?.[0];
  if (!it || it.class && it.class !== "Macro") return { macro: n, ref, exists: false };
  const f = it.fields ?? {};
  const kids = (await bridge.request("children", { ref, fields: LINE_FIELDS, asText: false, limit: MAX_LINES }, t)) as Listing;
  const items = (kids.items ?? []).filter((x) => !x.class || x.class === "MacroLine");
  const lines: MacroLine[] = items.map((x, i) => {
    const line = typeof x.index === "number" ? x.index : i + 1;
    const lf = x.fields ?? {};
    const name = text(lf.Name ?? x.name);
    return {
      line,
      name: !name || name === `MacroLine ${line}` ? null : name,
      command: text(lf.Command),
      wait: readWait(lf.Wait),
      enabled: yesNo(lf.Enabled),
      addToCmdline: yesNo(lf.AddToCmdline),
      execute: yesNo(lf.Execute),
      note: text(lf.Note),
    };
  });
  const total = typeof kids.total === "number" ? kids.total : items.length;
  const rs = runStateOf(f);
  const name = text(f.Name);
  return {
    macro: n,
    ref,
    exists: true,
    name,
    note: text(f.Note),
    locked: f.Lock === undefined ? null : text(f.Lock).trim() !== "" && !/^no$/i.test(text(f.Lock)),
    cli: yesNo(f.CLI),
    runState: rs.state,
    running: rs.state === "running" ? { line: rs.line, name: text(f.LineName) || null, command: text(f.LineCommand) } : null,
    lastUser: text(f.User) || null,
    lines,
    ...((kids.offset ?? 0) + (kids.items?.length ?? 0) < total ? { incomplete: `only ${items.length} of ${total} lines were read` } : {}),
  };
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/** Statements of a command line: split at ";" outside quotes, each a list of tokens (quoted tokens keep their quotes). */
export function tokenize(command: string): string[][] {
  const statements: string[][] = [];
  let cur: string[] = [];
  let tok = "";
  let quote: string | null = null;
  const push = () => {
    if (tok) cur.push(tok);
    tok = "";
  };
  for (const ch of command) {
    if (quote) {
      tok += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      tok += ch;
    } else if (ch === ";") {
      push();
      if (cur.length) statements.push(cur);
      cur = [];
    } else if (/\s/.test(ch)) push();
    else tok += ch;
  }
  push();
  if (cur.length) statements.push(cur);
  return statements;
}

/** Pool keywords whose single references are checked (full names only: the console expands abbreviations itself). */
const CHECKED = new Set(["sequence", "macro", "group", "preset", "matricks", "page", "timecode", "appearance", "master", "plugin", "quickey", "view"]);
const spelling: Record<string, string> = { sequence: "Sequence", macro: "Macro", group: "Group", preset: "Preset", matricks: "MAtricks", page: "Page", timecode: "Timecode", appearance: "Appearance", master: "Master", plugin: "Plugin", quickey: "Quickey", view: "View", cue: "Cue", part: "Part" };
const isId = (t: string | undefined) => !!t && (/^\d+(\.\d+)*$/.test(t) || /^"[^"]*"$/.test(t) || /^'[^']*'$/.test(t));
const RANGE = new Set(["thru", "+", "-", "if", "*"]);

export interface Reference {
  ref: string;
  /** Statement index within the line. */
  statement: number;
  stores: boolean;
}

/** The single object references of a command line: `<Keyword> <id>` (Sequence n [Cue c [Part p]]); ranges are skipped. */
export function references(command: string): { refs: Reference[]; skipped: string[] } {
  const refs: Reference[] = [];
  const skipped: string[] = [];
  tokenize(command).forEach((toks, si) => {
    const stores = /^store$/i.test(toks[0] ?? "");
    for (let i = 0; i < toks.length; i++) {
      const kw = toks[i].toLowerCase();
      if (!CHECKED.has(kw) || !isId(toks[i + 1])) continue;
      let ref = `${spelling[kw]} ${toks[i + 1]}`;
      let j = i + 2;
      if (kw === "sequence") {
        while (/^(cue|part)$/i.test(toks[j] ?? "") && isId(toks[j + 1])) {
          ref += ` ${spelling[toks[j].toLowerCase()]} ${toks[j + 1]}`;
          j += 2;
        }
      }
      if (RANGE.has((toks[j] ?? "").toLowerCase()) || /[*?]/.test(toks[i + 1])) {
        skipped.push(`${ref} ${toks[j] ?? ""}`.trim());
        i = j;
        continue;
      }
      // An executor range read can freeze onPC; only single executors are read (Page P or Page P.E).
      refs.push({ ref, statement: si, stores: stores && refs.every((r) => r.statement !== si) });
      i = j - 1;
    }
  });
  return { refs, skipped };
}

export interface LineCheck {
  line: number;
  raw: boolean;
  refs: Array<{ ref: string; status: "exists" | "missing" | "stored_here" | "created_earlier" | "this_macro" | "unknown"; error?: string }>;
  skipped: string[];
}

export interface RefLine {
  command: string;
  raw?: boolean;
  enabled?: boolean | null;
  execute?: boolean | null;
}

/** Only a line that runs creates anything: enabled and executed (not merely placed on the command line). */
export const executes = (l: RefLine) => l.enabled !== false && l.execute !== false;

/** The keys a stored reference creates: storing a cue (or part) creates its sequence (and cue) too. */
function createdKeys(key: string): string[] {
  const parts = key.split(/ (?=cue |part )/);
  return parts.map((_, k) => parts.slice(0, k + 1).join(" "));
}

/** The objects the executable Store statements of `lines` create, in order. */
export function storedBy(lines: RefLine[]): Set<string> {
  const created = new Set<string>();
  for (const l of lines) if (executes(l)) for (const r of references(l.command).refs) if (r.stores) for (const k of createdKeys(r.ref.toLowerCase())) created.add(k);
  return created;
}

/**
 * Checks every non-raw line's references in order. Objects stored by an executable line, among `prior` (the macro's
 * lines before these) or earlier among `lines`, count as created; a disabled or non-executing Store creates nothing.
 */
export async function checkReferences(bridge: Gma3Bridge, n: number, lines: RefLine[], firstLine: number, prior: RefLine[] = []): Promise<LineCheck[]> {
  const cache = new Map<string, Awaited<ReturnType<typeof exists>>>();
  const created = storedBy(prior);
  const out: LineCheck[] = [];
  for (const [i, l] of lines.entries()) {
    const { refs, skipped } = references(l.command);
    const check: LineCheck = { line: firstLine + i, raw: !!l.raw, refs: [], skipped };
    for (const r of refs) {
      const key = r.ref.toLowerCase();
      if (!l.raw) {
        if (key === `macro ${n}` || key.startsWith(`macro ${n}.`)) check.refs.push({ ref: r.ref, status: "this_macro" });
        else if (r.stores) check.refs.push({ ref: r.ref, status: "stored_here" });
        else if (created.has(key)) check.refs.push({ ref: r.ref, status: "created_earlier" });
        else {
          if (!cache.has(key)) cache.set(key, await exists(bridge, r.ref));
          const e = cache.get(key)!;
          check.refs.push(e.exists === true ? { ref: r.ref, status: "exists" } : e.exists === false ? { ref: r.ref, status: "missing" } : { ref: r.ref, status: "unknown", error: e.error });
        }
      }
      // A raw line still creates what it stores, when it runs.
      if (r.stores && executes(l)) for (const k of createdKeys(key)) created.add(k);
    }
    out.push(check);
  }
  return out;
}

/** What is stored before reference `k` of line `j` runs: earlier lines' Stores, then earlier statements of the line. */
function availableAt(lines: RefLine[], j: number, k: number): Set<string> {
  const out = storedBy(lines.slice(0, j));
  if (executes(lines[j])) for (const r of references(lines[j].command).refs.slice(0, k)) if (r.stores) for (const key of createdKeys(r.ref.toLowerCase())) out.add(key);
  return out;
}

/** A line after an edit: `origin` is its index before the edit (absent for an inserted line), `written` when its command was changed. */
export type EditedLine = RefLine & { origin?: number; written?: boolean };

/**
 * Lines of the macro after an edit whose references were satisfied by a Store before the edit (an earlier line, or an
 * earlier statement of the same line) and no longer are (removed, moved below them, disabled or rewritten), for objects
 * that do not exist in the show either. Lines keep their identity through `origin`, never matched by text.
 */
export async function brokenDependents(bridge: Gma3Bridge, n: number, beforeLines: RefLine[], afterLines: EditedLine[]): Promise<string[]> {
  const out: string[] = [];
  const cache = new Map<string, Awaited<ReturnType<typeof exists>>>();
  for (let j = 0; j < afterLines.length; j++) {
    const l = afterLines[j];
    // An inserted or rewritten line: its own references were checked against the lines before it.
    if (l.origin === undefined || l.written) continue;
    const refs = references(l.command).refs;
    for (const [k, r] of refs.entries()) {
      const key = r.ref.toLowerCase();
      if (r.stores || key === `macro ${n}` || key.startsWith(`macro ${n}.`)) continue;
      if (!availableAt(beforeLines, l.origin, k).has(key) || availableAt(afterLines, j, k).has(key)) continue;
      if (!cache.has(key)) cache.set(key, await exists(bridge, r.ref));
      const e = cache.get(key)!;
      if (e.exists !== true) out.push(`line ${j + 1} uses ${r.ref}, which no earlier line stores any more and which ${e.exists === false ? "does not exist" : `could not be checked (${e.error})`}`);
    }
  }
  return out;
}

const refProblems = (checks: LineCheck[]) =>
  checks.flatMap((c) => c.refs.filter((r) => r.status === "missing" || r.status === "unknown").map((r) => `line ${c.line}: ${r.ref} ${r.status === "missing" ? "does not exist" : `could not be checked (${r.error})`}`));

// ---------------------------------------------------------------------------
// Line specs
// ---------------------------------------------------------------------------

export interface LineSpec {
  command: string;
  wait: Wait;
  enabled: boolean;
  addToCmdline: boolean;
  execute: boolean;
  name?: string;
  note?: string;
  raw: boolean;
}

const BOOL = (field: string, v: unknown, dflt: boolean) => {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "boolean") throw new ValidationError(`${field} must be true or false`, field);
  return v;
};

export function commandText(field: string, v: unknown): string {
  if (typeof v !== "string") throw new ValidationError(`${field} must be a string (use "" for an empty line)`, field);
  if (/[\r\n]/.test(v)) throw new ValidationError(`${field} must be one line (a macro line holds one command line; separate commands with ";")`, field);
  if (v.length > MAX_COMMAND_LENGTH) throw new ValidationError(`${field} is longer than ${MAX_COMMAND_LENGTH} characters`, field);
  return v;
}

function lineName(field: string, v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || /[\r\n]/.test(v)) throw new ValidationError(`${field} must be a one-line string`, field);
  return v;
}

export function parseLine(field: string, raw: unknown): LineSpec {
  if (!raw || typeof raw !== "object") throw new ValidationError(`${field} must be an object with a command`, field);
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!["command", "wait", "enabled", "add_to_cmdline", "execute", "name", "note", "raw"].includes(k)) throw new ValidationError(`${field}.${k} is not a line field`, `${field}.${k}`);
  return {
    command: commandText(`${field}.command`, r.command),
    wait: parseWait(`${field}.wait`, r.wait) ?? { kind: "follow" },
    enabled: BOOL(`${field}.enabled`, r.enabled, true),
    addToCmdline: BOOL(`${field}.add_to_cmdline`, r.add_to_cmdline, false),
    execute: BOOL(`${field}.execute`, r.execute, true),
    name: lineName(`${field}.name`, r.name),
    note: lineName(`${field}.note`, r.note),
    raw: BOOL(`${field}.raw`, r.raw, false),
  };
}

/** The console's stored form of the commands this call wrote, keyed by line number. */
type Stored = Map<number, string>;

/** A `set` of one line property, compared with what the console reads back. Command text may come back rewritten. */
function setLine(ctx: ToolContext, name: string, ref: string, line: number, property: string, value: string, stored: Stored): { name: string; run: () => Promise<StepResult> } {
  // The set reply is display text ("1h00m00.00"); a wait is checked against a numeric read instead.
  if (property === "Wait") return { name, run: () => setWait(ctx, name, ref, value) };
  return {
    name,
    run: () =>
      requestStep(ctx.bridge, name, "set", { ref, property, value }, (res) => {
        const got = (res as { value?: unknown } | null)?.value;
        if (got === undefined) return { name, status: "unknown", op: "set", detail: { ref, property, sent: value }, error: `${property} of ${ref} could not be read back after the write` };
        if (property === "Command") {
          stored.set(line, text(got));
          return { name, status: "succeeded", op: "set", detail: { ref, property, sent: value, stored: text(got), ...(text(got) !== value ? { rewritten: true } : {}) } };
        }
        const ok =
          ["Enabled", "AddToCmdline", "Execute"].includes(property)
              ? yesNo(got) === yesNo(value)
            : property === "Name" && value === ""
              ? true
              : text(got) === value;
        return ok
          ? { name, status: "succeeded", op: "set", detail: { ref, property, value: got } }
          : { name, status: "failed", op: "set", detail: { ref, property, sent: value, readBack: got }, error: `the console did not apply ${property}=${JSON.stringify(value)} on ${ref}: it reads ${JSON.stringify(got)}` };
      }, ctx.requestTimeoutMs),
  };
}

async function setWait(ctx: ToolContext, name: string, ref: string, value: string): Promise<StepResult> {
  try {
    await ctx.bridge.request("set", { ref, property: "Wait", value }, ctx.requestTimeoutMs);
  } catch (err) {
    return stepFromError(name, err, { op: "set" });
  }
  let got: unknown;
  try {
    const r = (await ctx.bridge.request("objects", { ref, fields: ["Wait"], asText: false, limit: 1 }, ctx.requestTimeoutMs)) as Listing;
    got = r.items?.[0]?.fields?.Wait;
  } catch (err) {
    return { name, status: "unknown", op: "set", detail: { ref, property: "Wait", sent: value }, error: `the wait was written but could not be read back: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (got === undefined) return { name, status: "unknown", op: "set", detail: { ref, property: "Wait", sent: value }, error: "the wait was written but could not be read back" };
  return sameWait(readWait(got), readWait(value))
    ? { name, status: "succeeded", op: "set", detail: { ref, property: "Wait", value: got } }
    : { name, status: "failed", op: "set", detail: { ref, property: "Wait", sent: value, readBack: got }, error: `the console did not apply Wait=${JSON.stringify(value)} on ${ref}: it reads ${JSON.stringify(got)} (an invalid wait silently becomes Follow)` };
}

function lineSteps(ctx: ToolContext, n: number, line: number, spec: Partial<LineSpec>, stored: Stored) {
  const ref = lineRef(n, line);
  const out: Array<{ name: string; run: () => Promise<StepResult> }> = [];
  const p = `line_${line}`;
  if (spec.command !== undefined) out.push(setLine(ctx, `${p}_command`, ref, line, "Command", spec.command, stored));
  if (spec.wait !== undefined) out.push(setLine(ctx, `${p}_wait`, ref, line, "Wait", waitValue(spec.wait), stored));
  if (spec.enabled !== undefined) out.push(setLine(ctx, `${p}_enabled`, ref, line, "Enabled", spec.enabled ? "Yes" : "No", stored));
  if (spec.addToCmdline !== undefined) out.push(setLine(ctx, `${p}_add_to_cmdline`, ref, line, "AddToCmdline", spec.addToCmdline ? "Yes" : "No", stored));
  if (spec.execute !== undefined) out.push(setLine(ctx, `${p}_execute`, ref, line, "Execute", spec.execute ? "Yes" : "No", stored));
  if (spec.name !== undefined) out.push(setLine(ctx, `${p}_name`, ref, line, "Name", spec.name, stored));
  if (spec.note !== undefined) out.push(setLine(ctx, `${p}_note`, ref, line, "Note", spec.note, stored));
  return out;
}

/** Differences between a read line and what it should hold; command text through `stored` when accepted. */
function lineDiff(got: MacroLine | undefined, want: Partial<LineSpec>, line: number, acceptStored: string | undefined): string[] {
  if (!got) return [`line ${line} is missing`];
  const out: string[] = [];
  const L = `line ${got.line}`;
  if (want.command !== undefined && got.command !== want.command && got.command !== acceptStored) out.push(`${L} command reads ${JSON.stringify(got.command)}, not ${JSON.stringify(want.command)}`);
  if (want.wait !== undefined && !sameWait(got.wait, want.wait)) out.push(`${L} wait reads ${describeWait(got.wait)}, not ${describeWait(want.wait)}`);
  if (want.enabled !== undefined && got.enabled !== want.enabled) out.push(`${L} enabled reads ${got.enabled}`);
  if (want.addToCmdline !== undefined && got.addToCmdline !== want.addToCmdline) out.push(`${L} add_to_cmdline reads ${got.addToCmdline}`);
  if (want.execute !== undefined && got.execute !== want.execute) out.push(`${L} execute reads ${got.execute}`);
  if (want.name !== undefined && (got.name ?? "") !== want.name && !(want.name === "" && got.name === null)) out.push(`${L} name reads ${JSON.stringify(got.name)}`);
  if (want.note !== undefined && got.note !== want.note) out.push(`${L} note reads ${JSON.stringify(got.note)}`);
  return out;
}

const sameLine = (a: MacroLine, b: MacroLine) =>
  a.command === b.command && sameWait(a.wait, b.wait) && a.enabled === b.enabled && a.addToCmdline === b.addToCmdline && a.execute === b.execute && (a.name ?? "") === (b.name ?? "") && a.note === b.note;

const asSpec = (l: MacroLine): Partial<LineSpec> => ({ command: l.command, wait: l.wait, enabled: l.enabled ?? undefined, addToCmdline: l.addToCmdline ?? undefined, execute: l.execute ?? undefined, name: l.name ?? "", note: l.note });

export function presentLine(l: MacroLine) {
  return { ...l, wait: describeWait(l.wait) };
}

const REWRITE_NOTE = "the console rewrites command text outside quotes: it trims the ends, collapses runs of spaces and expands abbreviated keywords; write full keyword names with single spaces and quote literal text to round-trip exactly";

/** Rewritten commands as {line, sent, stored}; accepted ones are reported but do not fail the verification. */
function rewrites(stored: Stored, sent: Map<number, string>) {
  return [...sent].filter(([l, s]) => stored.has(l) && stored.get(l) !== s).map(([line, s]) => ({ line, sent: s, stored: stored.get(line)! }));
}

// ---------------------------------------------------------------------------
// gma3_macros
// ---------------------------------------------------------------------------

export async function readMacros(ctx: ToolContext, raw: { macro?: unknown; offset?: unknown; limit?: unknown; check_references?: boolean }): Promise<unknown> {
  const bridge = ctx.bridge;
  const t = ctx.requestTimeoutMs;
  if (raw.macro === undefined || raw.macro === null) {
    const v = new Validator();
    const offset = v.check(() => finiteNumber("offset", raw.offset, { integer: true, min: 0, optional: true })) ?? 0;
    const limit = v.check(() => finiteNumber("limit", raw.limit, { integer: true, min: 1, max: 1000, optional: true })) ?? 100;
    if (!v.ok) throw new ValidationError(v.errors.join("; "));
    const r = (await bridge.request("children", { ref: "DataPool.Macros", fields: ["Name"], limit, offset }, t)) as Listing;
    return {
      total: r.total ?? null,
      offset,
      macros: (r.items ?? []).map((i) => ({ macro: i.index, name: text(i.fields?.Name ?? i.name), lines: i.childCount ?? null })),
      ...(typeof r.total === "number" && offset + (r.items?.length ?? 0) < r.total ? { next: offset + (r.items?.length ?? 0) } : {}),
    };
  }
  const n = finiteNumber("macro", raw.macro, { integer: true, min: 1, max: 99999 })!;
  const m = await readMacro(bridge, n, t);
  if (!m.exists) return { macro: n, exists: false };
  const out: Record<string, unknown> = { ...m, lines: m.lines!.map(presentLine) };
  if (raw.check_references) out.references = await checkReferences(bridge, n, m.lines!, 1);
  out.about = "commands are exactly as stored; a name of null is the default \"MacroLine <n>\". running is the line the macro is on now (null when idle).";
  return out;
}

// ---------------------------------------------------------------------------
// gma3_store_macro
// ---------------------------------------------------------------------------

type StoreMode = "create" | "replace" | "append";

interface StoreArgs {
  macro: unknown;
  mode: unknown;
  lines: unknown;
  name?: unknown;
  note?: unknown;
  cli?: unknown;
  accept_console_form?: boolean;
  preview?: boolean;
  verify?: boolean;
}

/** The checks shared by every mutation: the macro exists as needed, is complete, unlocked and not running. */
function stateProblem(m: MacroRead, need: "absent" | "present"): string | undefined {
  if (need === "absent" && m.exists) return `${m.ref} already exists (${JSON.stringify(m.name)}, ${m.lines?.length ?? 0} lines); use mode replace or append`;
  if (need === "present" && !m.exists) return `${m.ref} does not exist; use mode create`;
  if (!m.exists) return undefined;
  if (m.incomplete) return `${m.ref}: ${m.incomplete}; nothing is changed on a macro that was not read completely`;
  if (m.locked !== false) return m.locked ? `${m.ref} is locked: the console silently ignores edits to it; unlock it first` : `the Lock of ${m.ref} could not be read`;
  if (m.running) return `${m.ref} is running (line ${m.running.line}); stop it first (gma3_run_macro off)`;
  if (m.runState !== "idle") return `whether ${m.ref} is running could not be read (LineNo missing or malformed); nothing is changed on a macro that may be running`;
  return undefined;
}

export async function storeMacro(ctx: ToolContext, raw: StoreArgs): Promise<OperationResult> {
  const op = "store_macro";
  const v = new Validator();
  const n = v.check(() => finiteNumber("macro", raw.macro, { integer: true, min: 1, max: 99999 }));
  const mode = (["create", "replace", "append"] as const).find((m) => m === raw.mode);
  if (!mode) v.fail("mode must be create, replace or append (explicit: create refuses an existing macro, replace removes its lines first, append adds after them)");
  const specs = Array.isArray(raw.lines) ? raw.lines.map((l, i) => v.check(() => parseLine(`lines[${i}]`, l))).filter((x): x is LineSpec => !!x) : (v.fail("lines must be a list"), []);
  if (Array.isArray(raw.lines) && raw.lines.length > MAX_LINES) v.fail(`at most ${MAX_LINES} lines`);
  if (Array.isArray(raw.lines) && !raw.lines.length && mode !== "replace") v.fail("lines must not be empty (replace with no lines clears the macro)");
  const name = v.check(() => lineName("name", raw.name));
  const note = v.check(() => lineName("note", raw.note));
  const cli = raw.cli === undefined ? undefined : typeof raw.cli === "boolean" ? raw.cli : (v.fail("cli must be true or false"), undefined);
  const target: Record<string, unknown> = { macro: raw.macro, mode: raw.mode };
  if (!v.ok || n === undefined || !mode) return validationFailure(op, target, v.errors);
  const ref = macroRef(n);
  target.ref = ref;
  const bridge = ctx.bridge;
  const t = ctx.requestTimeoutMs;
  const preview = raw.preview === true;

  const body = async (): Promise<OperationResult> => {
    let before: MacroRead | undefined;
    let checks: LineCheck[] = [];
    const base = () => (mode === "append" ? before?.lines?.length ?? 0 : 0);
    const inspect = await runSteps([
      {
        name: "read_macro",
        run: async () => {
          try {
            before = await readMacro(bridge, n, t);
          } catch (err) {
            return asRead(stepFromError("read_macro", err, { op: "objects" }));
          }
          const p = stateProblem(before, mode === "create" ? "absent" : "present");
          return asRead(p ? { name: "read_macro", status: "failed", op: "objects", error: p } : { name: "read_macro", status: "succeeded", op: "objects", detail: { exists: before.exists, lines: before.lines?.length ?? 0 } });
        },
      },
      {
        name: "check_references",
        run: async () => {
          checks = await checkReferences(bridge, n, specs, base() + 1, mode === "append" ? before!.lines : []);
          const problems = refProblems(checks);
          return asRead(problems.length ? { name: "check_references", status: "failed", detail: checks, error: `${problems.join("; ")}. Mark a line raw: true to store it unchecked` } : { name: "check_references", status: "succeeded", detail: checks });
        },
      },
    ]);
    const extra: Record<string, unknown> = { references: checks };
    if (inspect.outcome !== "succeeded" || !before) return buildResult({ operation: op, target, steps: inspect.steps, summary: `${op} was not performed; nothing was sent: ${inspect.steps.find((s) => s.status !== "succeeded")?.error}`, extra });
    const b = before;
    const stored: Stored = new Map();
    const sent = new Map<number, string>();
    const plan: Array<{ name: string; run: () => Promise<StepResult> }> = [];
    if (mode === "create") plan.push({ name: "create", run: () => commandStep(bridge, "create", `Store ${ref} /NoConfirmation`, t) });
    if (mode === "replace") for (let l = b.lines!.length; l >= 1; l--) plan.push({ name: `remove_line_${l}`, run: () => commandStep(bridge, `remove_line_${l}`, `Delete ${lineRef(n, l)} /NoConfirmation`, t) });
    specs.forEach((s, i) => {
      const line = base() + i + 1;
      sent.set(line, s.command);
      // Store past the end appends the line; its properties are then written one by one.
      plan.push({ name: `line_${line}`, run: () => commandStep(bridge, `line_${line}`, `Store ${lineRef(n, line)} /NoConfirmation`, t) });
      plan.push(...lineSteps(ctx, n, line, { ...s, name: s.name }, stored));
    });
    if (name !== undefined) plan.push({ name: "name", run: macroSet(ctx, "name", ref, "Name", name) });
    if (note !== undefined) plan.push({ name: "note", run: macroSet(ctx, "note", ref, "Note", note) });
    if (cli !== undefined) plan.push({ name: "cli", run: macroSet(ctx, "cli", ref, "CLI", cli ? "Yes" : "No") });
    const summaryOf = { mode, linesBefore: b.lines?.length ?? 0, linesAfter: base() + specs.length, commands: plan.filter((p) => !/_(command|wait|enabled|add_to_cmdline|execute|name|note)$/.test(p.name)).length };
    if (preview) return buildResult({ operation: op, target, steps: inspect.steps, summary: `Preview only; nothing was sent (${plan.length} requests planned; the macro is never run).`, extra: { ...extra, preview: true, plan: summaryOf, linesBefore: b.lines?.map(presentLine) ?? [] } });
    const run = await runSteps(plan);
    const steps = [...inspect.steps, ...run.steps];
    const rw = rewrites(stored, sent);
    const warnings: string[] = [];
    if (rw.length) warnings.push(`${rw.length} command(s) were stored in the console's form (${REWRITE_NOTE})`);
    let verification: Verification = notRequested();
    let after: MacroRead | undefined;
    if (raw.verify !== false && run.outcome !== "failed") {
      try {
        after = await readMacro(bridge, n, t);
        steps.push(asRead({ name: "read_back", status: "succeeded", op: "children" }));
        const problems: string[] = [];
        const lines = after.lines ?? [];
        if (!after.exists) problems.push(`${ref} does not exist after the store`);
        if (after.incomplete) problems.push(after.incomplete);
        if (lines.length !== base() + specs.length) problems.push(`${lines.length} line(s), ${base() + specs.length} expected`);
        if (mode === "append") b.lines!.forEach((l, i) => { if (!lines[i] || !sameLine(lines[i], l)) problems.push(`line ${l.line}, which existed before, changed`); });
        specs.forEach((s, i) => {
          const line = base() + i + 1;
          problems.push(...lineDiff(lines[line - 1], s, line, raw.accept_console_form ? stored.get(line) : undefined));
        });
        if (name !== undefined && after.name !== name) problems.push(`the macro is named ${JSON.stringify(after.name)}`);
        if (note !== undefined && after.note !== note) problems.push(`the macro note reads ${JSON.stringify(after.note)}`);
        if (cli !== undefined && after.cli !== cli) problems.push(`CLI reads ${after.cli}`);
        const checked = `the ${lines.length} line(s) of ${ref} in order (command text exactly${raw.accept_console_form ? ", or the console's stored form" : ""}, wait, enabled, add_to_cmdline, execute, name, note)`;
        verification = problems.length ? { status: "mismatched", checked, detail: problems.slice(0, 12).join("; ") + (rw.length && !raw.accept_console_form ? `. ${REWRITE_NOTE}, or pass accept_console_form: true` : "") } : { status: "matched", checked };
      } catch (err) {
        steps.push(asRead(stepFromError("read_back", err, { op: "children" })));
        verification = unavailable("the macro could not be read back");
      }
    }
    return buildResult({ operation: op, target, steps, verification, warnings, extra: { ...extra, executed: false, ...(rw.length ? { rewritten: rw } : {}), ...(after?.lines ? { lines: after.lines.map(presentLine) } : {}) } });
  };
  return preview ? body() : ctx.mutations.run(body);
}

function macroSet(ctx: ToolContext, name: string, ref: string, property: string, value: string): () => Promise<StepResult> {
  return () =>
    requestStep(ctx.bridge, name, "set", { ref, property, value }, (res) => {
      const got = (res as { value?: unknown } | null)?.value;
      const ok = property === "CLI" ? yesNo(got) === yesNo(value) : text(got) === value;
      return ok ? { name, status: "succeeded", op: "set", detail: { ref, property, value: got } } : { name, status: "failed", op: "set", detail: { ref, property, sent: value, readBack: got ?? null }, error: `the console did not apply ${property}=${JSON.stringify(value)} on ${ref}: it reads ${JSON.stringify(got ?? null)}` };
    }, ctx.requestTimeoutMs);
}

// ---------------------------------------------------------------------------
// gma3_edit_macro_line
// ---------------------------------------------------------------------------

interface EditArgs {
  macro: unknown;
  action: unknown;
  line: unknown;
  to?: unknown;
  command?: unknown;
  wait?: unknown;
  enabled?: unknown;
  add_to_cmdline?: unknown;
  execute?: unknown;
  name?: unknown;
  note?: unknown;
  raw?: unknown;
  accept_console_form?: boolean;
  allow_unresolved_dependents?: boolean;
  preview?: boolean;
  verify?: boolean;
}

export async function editMacroLine(ctx: ToolContext, raw: EditArgs): Promise<OperationResult> {
  const op = "edit_macro_line";
  const v = new Validator();
  const n = v.check(() => finiteNumber("macro", raw.macro, { integer: true, min: 1, max: 99999 }));
  const action = (["insert", "set", "move", "remove"] as const).find((a) => a === raw.action);
  if (!action) v.fail("action must be insert, set, move or remove");
  const line = v.check(() => finiteNumber("line", raw.line, { integer: true, min: 1, max: MAX_LINES }));
  const to = v.check(() => finiteNumber("to", raw.to, { integer: true, min: 1, max: MAX_LINES, optional: true }));
  const fields: Partial<LineSpec> = {};
  if (raw.command !== undefined) fields.command = v.check(() => commandText("command", raw.command));
  if (raw.wait !== undefined) fields.wait = v.check(() => parseWait("wait", raw.wait));
  for (const [k, f] of [["enabled", "enabled"], ["add_to_cmdline", "addToCmdline"], ["execute", "execute"]] as const) {
    const val = raw[k];
    if (val !== undefined) typeof val === "boolean" ? (fields[f] = val) : v.fail(`${k} must be true or false`);
  }
  if (raw.name !== undefined) fields.name = v.check(() => lineName("name", raw.name ?? ""));
  if (raw.note !== undefined) fields.note = v.check(() => lineName("note", raw.note ?? ""));
  const rawLine = raw.raw === true;
  const hasFields = Object.values(fields).some((x) => x !== undefined);
  if (action === "insert" && fields.command === undefined) v.fail("insert needs a command");
  if (action === "set" && !hasFields) v.fail("set needs at least one of command, wait, enabled, add_to_cmdline, execute, name, note");
  if ((action === "move" || action === "remove") && hasFields) v.fail(`${action} takes no line fields`);
  if (action === "move" && to === undefined) v.fail("move needs to");
  const target: Record<string, unknown> = { macro: raw.macro, action: raw.action, line: raw.line };
  if (!v.ok || n === undefined || !action || line === undefined) return validationFailure(op, target, v.errors);
  const ref = macroRef(n);
  target.ref = lineRef(n, line);
  const bridge = ctx.bridge;
  const t = ctx.requestTimeoutMs;
  const preview = raw.preview === true;
  if (action === "insert") {
    fields.wait ??= { kind: "follow" };
    fields.enabled ??= true;
    fields.addToCmdline ??= false;
    fields.execute ??= true;
  }

  const body = async (): Promise<OperationResult> => {
    let before: MacroRead | undefined;
    let checks: LineCheck[] = [];
    const inspect = await runSteps([
      {
        name: "read_macro",
        run: async () => {
          try {
            before = await readMacro(bridge, n, t);
          } catch (err) {
            return asRead(stepFromError("read_macro", err, { op: "objects" }));
          }
          const p = stateProblem(before, "present");
          if (p) return asRead({ name: "read_macro", status: "failed", op: "objects", error: p });
          const count = before.lines!.length;
          const max = action === "insert" ? count + 1 : count;
          if (line > max) return asRead({ name: "read_macro", status: "failed", op: "children", error: `${ref} has ${count} line(s); line must be 1-${max}` });
          if (action === "move" && to! > count) return asRead({ name: "read_macro", status: "failed", op: "children", error: `to must be 1-${count}` });
          return asRead({ name: "read_macro", status: "succeeded", op: "children", detail: { lines: count } });
        },
      },
      {
        name: "check_references",
        run: async () => {
          if (fields.command === undefined) return asRead({ name: "check_references", status: "succeeded", detail: "no command written" });
          // The lines before this one may store what it uses; it runs enabled / executed as it will be after the edit.
          const old = action === "set" ? before!.lines![line - 1] : undefined;
          checks = await checkReferences(bridge, n, [{ command: fields.command, raw: rawLine, enabled: fields.enabled ?? old?.enabled, execute: fields.execute ?? old?.execute }], line, before!.lines!.slice(0, line - 1));
          const problems = refProblems(checks);
          return asRead(problems.length ? { name: "check_references", status: "failed", detail: checks, error: `${problems.join("; ")}. Pass raw: true to store it unchecked` } : { name: "check_references", status: "succeeded", detail: checks });
        },
      },
    ]);
    const extra: Record<string, unknown> = { references: checks };
    if (inspect.outcome !== "succeeded" || !before) return buildResult({ operation: op, target, steps: inspect.steps, summary: `${op} was not performed; nothing was sent: ${inspect.steps.find((s) => s.status !== "succeeded")?.error}`, extra });
    const b = before.lines!;
    const stored: Stored = new Map();
    const plan: Array<{ name: string; run: () => Promise<StepResult> }> = [];
    // The expected lines afterwards, as specs.
    // Each expected line keeps its index before the edit (origin), so identical commands stay distinct.
    const expected: Array<Partial<LineSpec> & { origin?: number; written?: boolean }> = b.map((l, i) => ({ ...asSpec(l), origin: i }));
    let edited: number | undefined;
    if (action === "insert") {
      plan.push(line === b.length + 1
        ? { name: "insert", run: () => commandStep(bridge, "insert", `Store ${lineRef(n, line)} /NoConfirmation`, t) }
        : { name: "insert", run: () => commandStep(bridge, "insert", `Insert ${lineRef(n, line)}`, t) });
      plan.push(...lineSteps(ctx, n, line, fields, stored));
      expected.splice(line - 1, 0, { ...fields, name: fields.name ?? "", note: fields.note ?? "" });
      edited = line;
    } else if (action === "set") {
      plan.push(...lineSteps(ctx, n, line, fields, stored));
      expected[line - 1] = { ...expected[line - 1], ...Object.fromEntries(Object.entries(fields).filter(([, x]) => x !== undefined)), ...(fields.command !== undefined && fields.command !== b[line - 1].command ? { written: true } : {}) };
      edited = line;
    } else if (action === "move") {
      const moves: Array<[number, number]> = [];
      if (to! < line) moves.push([line, to!]);
      else for (let j = line + 1; j <= to!; j++) moves.push([j, j - 1]);
      for (const [a, c] of moves) plan.push({ name: `move_${a}_${c}`, run: () => commandStep(bridge, `move_${a}_${c}`, `Move ${lineRef(n, a)} At ${lineRef(n, c)}`, t) });
      const [x] = expected.splice(line - 1, 1);
      expected.splice(to! - 1, 0, x);
    } else {
      plan.push({ name: "remove", run: () => commandStep(bridge, "remove", `Delete ${lineRef(n, line)} /NoConfirmation`, t) });
      expected.splice(line - 1, 1);
    }
    // The other lines may depend on what this one stored.
    const toRef = (x: Partial<LineSpec> | MacroLine): RefLine => ({ command: x.command ?? "", enabled: x.enabled, execute: x.execute });
    const broken = await brokenDependents(bridge, n, b.map(toRef), expected.map((x) => ({ ...toRef(x), origin: x.origin, written: x.written })));
    if (broken.length) {
      extra.unresolvedDependents = broken;
      if (raw.allow_unresolved_dependents !== true) {
        const s: StepResult = asRead({ name: "check_dependents", status: "failed", error: `${broken.join("; ")}. Pass allow_unresolved_dependents: true to edit anyway` });
        return buildResult({ operation: op, target, steps: [...inspect.steps, s], summary: `${op} refused, nothing was sent: ${s.error}`, extra });
      }
    }
    if (preview) return buildResult({ operation: op, target, steps: inspect.steps, summary: `Preview only; nothing was sent (${plan.length} requests planned; the macro is never run).`, extra: { ...extra, preview: true, linesBefore: b.map(presentLine) } });
    const run = await runSteps(plan);
    const steps = [...inspect.steps, ...run.steps];
    const rw = edited !== undefined && fields.command !== undefined ? rewrites(stored, new Map([[edited, fields.command]])) : [];
    const warnings = rw.length ? [`the command was stored in the console's form (${REWRITE_NOTE})`] : [];
    let verification: Verification = notRequested();
    let after: MacroRead | undefined;
    if (raw.verify !== false && run.outcome !== "failed") {
      try {
        after = await readMacro(bridge, n, t);
        steps.push(asRead({ name: "read_back", status: "succeeded", op: "children" }));
        const lines = after.lines ?? [];
        const problems: string[] = [];
        if (lines.length !== expected.length) problems.push(`${lines.length} line(s), ${expected.length} expected`);
        expected.forEach((want, i) => {
          const accept = raw.accept_console_form && i + 1 === edited ? stored.get(edited) : undefined;
          problems.push(...lineDiff(lines[i], want, i + 1, accept));
        });
        const checked = `every line of ${ref} in order against the expected result of the ${action}`;
        verification = problems.length ? { status: "mismatched", checked, detail: problems.slice(0, 12).join("; ") + (rw.length && !raw.accept_console_form ? `. ${REWRITE_NOTE}, or pass accept_console_form: true` : "") } : { status: "matched", checked };
      } catch (err) {
        steps.push(asRead(stepFromError("read_back", err, { op: "children" })));
        verification = unavailable("the macro could not be read back");
      }
    }
    return buildResult({ operation: op, target, steps, verification, warnings, extra: { ...extra, executed: false, ...(rw.length ? { rewritten: rw } : {}), ...(after?.lines ? { lines: after.lines.map(presentLine) } : {}) } });
  };
  return preview ? body() : ctx.mutations.run(body);
}

// ---------------------------------------------------------------------------
// gma3_run_macro
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Observation {
  /**
   * finished: seen running (or running before the command), then idle; paused_at_go: on a line whose wait is Go;
   * running: still running when observing ended; not_observed: never seen running (it finished before the first sample
   * or did not start: the two cannot be told apart); stopped: idle after Off, read; unknown: no sample could be read.
   */
  state: "finished" | "paused_at_go" | "running" | "not_observed" | "stopped" | "unknown";
  /** A sample that read LineNo "" (idle) was seen. */
  confirmedIdle: boolean;
  linesSeen: Array<{ ms: number; line: number; name: string | null; command: string }>;
  pausedAt?: number;
  samples: number;
  unreadSamples: number;
  seconds: number;
}

export async function observeRun(bridge: Gma3Bridge, n: number, lines: MacroLine[], seconds: number, intervalMs: number, t: number, wasRunning: boolean): Promise<Observation> {
  const t0 = Date.now();
  const linesSeen: Observation["linesSeen"] = [];
  let samples = 0;
  let unread = 0;
  let current: number | null = null;
  let sawRunning = wasRunning;
  let idleAfterRun = false;
  let confirmedIdle = false;
  let readOk = 0;
  let sameSince = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    samples++;
    const r = (await bridge.request("objects", { ref: macroRef(n), fields: ["LineNo", "LineName", "LineCommand"], limit: 1 }, t).catch(() => null)) as Listing | null;
    const f = r?.items?.[0]?.fields;
    const rs = runStateOf(f);
    // A failed read or a missing / malformed LineNo is a gap, never "idle".
    if (!f || rs.state === "unknown") {
      unread++;
      await sleep(intervalMs);
      continue;
    }
    readOk++;
    const no = rs.state === "running" ? rs.line : null;
    if (no === null) confirmedIdle = true;
    if (no !== current) {
      sameSince = Date.now();
      if (no !== null) linesSeen.push({ ms: Date.now() - t0, line: no, name: text(f.LineName) || null, command: text(f.LineCommand) });
      current = no;
    }
    if (no !== null) sawRunning = true;
    if (no === null && sawRunning) {
      idleAfterRun = true;
      break;
    }
    // Paused on a Go wait: the same line for half a second.
    if (no !== null && lines[no - 1]?.wait.kind === "go" && Date.now() - sameSince >= 500) break;
    await sleep(intervalMs);
  }
  const state: Observation["state"] = !readOk ? "unknown" : idleAfterRun ? "finished" : current !== null && lines[current - 1]?.wait.kind === "go" ? "paused_at_go" : current !== null ? "running" : "not_observed";
  return { state, confirmedIdle, linesSeen, ...(state === "paused_at_go" ? { pausedAt: current! } : {}), samples, unreadSamples: unread, seconds: Math.round((Date.now() - t0) / 100) / 10 };
}

interface RunArgs {
  macro: unknown;
  action: unknown;
  observe_seconds?: unknown;
  interval_ms?: unknown;
}

export async function runMacro(ctx: ToolContext, raw: RunArgs): Promise<OperationResult> {
  const op = "run_macro";
  const v = new Validator();
  const n = v.check(() => finiteNumber("macro", raw.macro, { integer: true, min: 1, max: 99999 }));
  const action = (["go", "off"] as const).find((a) => a === raw.action);
  if (!action) v.fail("action must be go (start, or continue after a Go wait) or off (stop)");
  const seconds = v.check(() => finiteNumber("observe_seconds", raw.observe_seconds, { min: 0, max: 60, optional: true })) ?? 3;
  const intervalMs = v.check(() => finiteNumber("interval_ms", raw.interval_ms, { min: 50, max: 1000, optional: true })) ?? 100;
  const target: Record<string, unknown> = { macro: raw.macro, action: raw.action };
  if (!v.ok || n === undefined || !action) return validationFailure(op, target, v.errors);
  const ref = macroRef(n);
  target.ref = ref;
  const bridge = ctx.bridge;
  const t = ctx.requestTimeoutMs;

  return ctx.mutations.run(async () => {
    let before: MacroRead | undefined;
    const inspect = await runSteps([
      {
        name: "read_macro",
        run: async () => {
          try {
            before = await readMacro(bridge, n, t);
          } catch (err) {
            return asRead(stepFromError("read_macro", err, { op: "objects" }));
          }
          if (!before.exists) return asRead({ name: "read_macro", status: "failed", op: "objects", error: `${ref} does not exist` });
          if (action === "go" && !before.lines!.length) return asRead({ name: "read_macro", status: "failed", op: "children", error: `${ref} has no lines` });
          return asRead({ name: "read_macro", status: "succeeded", op: "objects", detail: { lines: before.lines!.length, running: before.running } });
        },
      },
    ]);
    if (inspect.outcome !== "succeeded" || !before) return buildResult({ operation: op, target, steps: inspect.steps, summary: `${op} was not performed; nothing was sent: ${inspect.steps[0].error}` });
    const b = before;
    const command = action === "go" ? `Go+ ${ref}` : `Off ${ref}`;
    const s = await commandStep(bridge, action, command, t);
    const steps = [...inspect.steps, s];
    const warnings: string[] = [];
    if (b.runState === "unknown") warnings.push(`whether ${ref} was running before could not be read, so a later idle state is not taken as its end`);
    const disabled = b.lines!.filter((l) => l.enabled === false).map((l) => l.line);
    if (disabled.length) warnings.push(`line(s) ${disabled.join(", ")} are disabled and are skipped with their waits`);
    const prompts = b.lines!.filter((l) => l.enabled !== false && /\([^)]*\)/.test(l.command.replace(/"[^"]*"/g, ""))).map((l) => l.line);
    if (action === "go" && prompts.length) warnings.push(`line(s) ${prompts.join(", ")} contain a (prompt): the console asks the operator for a value when they run`);
    let observation: Observation | undefined;
    if (s.status === "succeeded" && seconds > 0) {
      // Continuing a paused macro: idle afterwards means it ran to its end.
      observation = await observeRun(bridge, n, b.lines!, seconds, intervalMs, t, action === "off" || b.runState === "running");
      // Stopped only on a successfully read idle state.
      if (action === "off" && observation.confirmedIdle && (observation.state === "not_observed" || observation.state === "finished")) observation.state = "stopped";
    }
    const execution = {
      dispatched: s.status === "succeeded",
      command,
      runningBefore: b.runState === "unknown" ? "unknown" : b.running,
      ...(observation ? { observed: observation } : { observed: null }),
    };
    const verification: Verification =
      action === "off"
        ? observation?.state === "stopped"
          ? { status: "matched", checked: `${ref} is idle after Off` }
          : observation?.state === "unknown"
            ? unavailable(`no sample of ${ref}'s run state could be read after Off (${observation.unreadSamples} unread)`, `${ref} is idle after Off`)
            : observation
              ? { status: "mismatched", checked: `${ref} is idle after Off`, detail: `it is ${observation.state}` }
              : notRequested()
        : unavailable(
            "a dispatched Go+ and the observed run state do not show that every line succeeded: a failing line does not stop a macro and nothing reports it; check the lines' effects",
            `the run state of ${ref} (observed: ${observation?.state ?? "not observed"})`,
          );
    const summary =
      s.status !== "succeeded"
        ? `${command} was not accepted: ${s.error}`
        : `${command} dispatched${observation ? `; observed: ${observation.state}${observation.pausedAt ? ` at line ${observation.pausedAt} (wait Go: send go again to continue)` : ""}${observation.linesSeen.length ? `, lines seen ${observation.linesSeen.map((l) => l.line).join(", ")}` : ""}` : ""}. Completion of every line is not inferred.`;
    return buildResult({ operation: op, target, steps, verification, warnings, summary, extra: { execution } });
  });
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

const waitSchema = z.union([z.number(), z.enum(["follow", "go"])]).optional();
const lineSchema = z.object({
  command: z.string(),
  wait: waitSchema,
  enabled: z.boolean().optional(),
  add_to_cmdline: z.boolean().optional(),
  execute: z.boolean().optional(),
  name: z.string().optional(),
  note: z.string().optional(),
  raw: z.boolean().optional(),
});

export const registerMacroTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_macros",
    {
      title: "Read the macro pool or one macro",
      description:
        "Read-only. Without macro: the macro pool (number, name, line count; offset/limit, default 100). With macro: its name, note, lock, CLI, the line it is running now (null when idle) and every line exactly as stored (command, wait as seconds / \"follow\" / \"go\", enabled, add_to_cmdline, execute, name, note; a name of null is the default). " +
        "check_references: true also lists the objects each line refers to (Sequence, Cue, Macro, Group, Preset, MAtricks, Page, Master, ...) and whether they exist.",
      inputSchema: { macro: z.number().optional(), offset: z.number().optional(), limit: z.number().optional(), check_references: z.boolean().optional() },
    },
    async (args) => readOnly(() => readMacros(ctx, args)),
  );

  server.registerTool(
    "gma3_store_macro",
    {
      title: "Create a macro or replace or append its lines (never runs it)",
      description:
        "mode (required): create (refuses an existing macro), replace (removes the existing lines first, keeping the macro, its appearance and its executor assignments) or append (adds after the existing lines). lines: [{command, wait (seconds, \"follow\" or \"go\" = a manual wait until the next Go+), enabled, add_to_cmdline, execute, name, note, raw}]; name, note, cli of the macro. " +
        "Before anything is sent the references in each line are checked (single objects named with full keywords; a Store earlier in the macro counts as creating its object); raw: true stores a line unchecked. Refuses a locked or running macro. Sends Store Macro N, Delete/Store Macro N.L and one set per property; NEVER runs the macro. " +
        "The console rewrites command text outside quotes (trims, collapses spaces, expands abbreviated keywords): every line is read back and compared exactly; a rewritten line is a mismatch unless accept_console_form: true (it is reported in rewritten either way).",
      inputSchema: {
        macro: z.number(),
        mode: z.enum(["create", "replace", "append"]),
        lines: z.array(lineSchema),
        name: z.string().optional(),
        note: z.string().optional(),
        cli: z.boolean().optional(),
        accept_console_form: z.boolean().optional(),
        preview: z.boolean().optional(),
        verify: z.boolean().optional(),
      },
    },
    async (args) => operation(() => storeMacro(ctx, args)),
  );

  server.registerTool(
    "gma3_edit_macro_line",
    {
      title: "Insert, change, move or remove one macro line (never runs it)",
      description:
        "action insert (line 1..count+1, needs command), set (any of command, wait, enabled, add_to_cmdline, execute, name, note), move (line -> to; sent as upward moves only, because a downward Move lands one place short), remove. References in a written command are checked unless raw: true. Refuses a locked or running macro. Every line is read back and compared with the expected order and content; accept_console_form as in gma3_store_macro. Never runs the macro.",
      inputSchema: {
        macro: z.number(),
        action: z.enum(["insert", "set", "move", "remove"]),
        line: z.number(),
        to: z.number().optional(),
        command: z.string().optional(),
        wait: waitSchema,
        enabled: z.boolean().optional(),
        add_to_cmdline: z.boolean().optional(),
        execute: z.boolean().optional(),
        name: z.string().optional(),
        note: z.string().optional(),
        raw: z.boolean().optional(),
        accept_console_form: z.boolean().optional(),
        allow_unresolved_dependents: z.boolean().optional().describe("Edit even when a later line uses an object this edit stops an earlier line from storing (default false: refuse)."),
        preview: z.boolean().optional(),
        verify: z.boolean().optional(),
      },
    },
    async (args) => operation(() => editMacroLine(ctx, args)),
  );

  server.registerTool(
    "gma3_run_macro",
    {
      title: "Run (Go+) or stop (Off) a macro and observe it",
      description:
        "EXECUTES: action go sends Go+ Macro N (starts it, or continues it after a Go wait); off sends Off Macro N. Then observes the macro's running line for observe_seconds (default 3, max 60): finished, paused_at_go (a manual wait), running, idle. The result separates dispatched (the command was accepted) from observed (the run state seen); it never claims that every line succeeded, because a failing line does not stop a macro. Lines with a (prompt) ask the operator for input.",
      inputSchema: { macro: z.number(), action: z.enum(["go", "off"]), observe_seconds: z.number().optional(), interval_ms: z.number().optional() },
    },
    async (args) => operation(() => runMacro(ctx, args)),
  );
};
