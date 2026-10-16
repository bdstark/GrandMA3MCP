/**
 * SB-02: groups with selection grids, and MAtricks objects.
 *
 *   gma3_selection_grid        read-only: the ordered fixtures and selection-grid coordinates of a stored group
 *                              (from its SelectionData, nothing is selected) or of the current selection
 *   gma3_store_group           create or overwrite a group from an ordered list with explicit X/Y/Z grid
 *                              coordinates, or from a row / rectangle / mirror helper that expands into that list
 *   gma3_matricks              read-only: a MAtricks object's per-axis settings
 *   gma3_configure_matricks    create or update a MAtricks object: wings, blocks, groups, width, shift, shuffle and
 *                              fade / delay / phase / speed distributions per axis
 *
 * Selection-grid coordinates are the console's selection grid (relative arrangement used by MAtricks, phasers and
 * selection order); they are not the fixtures' physical positions in the 3D stage, which these tools never read or
 * change.
 *
 * Console facts this module relies on (onPC 2.5.1, docs/probes/sb-02-groups-macos-2.5.1.md):
 *   - `Grid x/y/z` moves the grid cursor; the next `Fixture <id>` lands on the cursor. Each item therefore gets its
 *     own Grid command: a range selected at one cursor follows the user's Move Grid Cursor setting. Grid and Fixture
 *     must be separate commands (one line places nothing).
 *   - The live selection lists fixtures in the order they were selected, but Store Group keeps a group in patch
 *     (subfixture index) order and a recall returns that order. Distributions follow the grid cells (At 0 Thru 100
 *     ramps along grid X whatever the selection order), so in a stored group the grid IS the order: results are
 *     compared fixture by fixture, never by list position.
 *   - Selecting a fixture that is already selected is SILENTLY IGNORED (it keeps its first cell), so duplicate
 *     fixtures are refused. Two fixtures may share a cell; negative coordinates are accepted. A fixture's parent
 *     (501) and its cells (501.1) are separate selection items.
 *   - The group stores its selection in SelectionData; the bridge's group.read op (0.21.0) reads it. Recalling a
 *     group adds the grid cursor to the stored positions, so the recall check recalls at Grid 0/0/0. With
 *     PreserveGridPositions No, a recall at the origin removes gaps and offsets.
 *   - Store Group on an existing group overwrites it (with or without /Overwrite) and keeps its name; /Merge shifts
 *     and reorders, so the tools always store a complete list. A locked group answers "Object locked" and silently
 *     ignores Name writes. Active selection MAtricks were not stored into the group.
 *   - Store MAtricks copies the programmer's selection MAtricks, so a new MAtricks object gets every property
 *     written explicitly. MAtricks values the console does not accept are silently ignored (XWings -1, DelayToX
 *     "bogus"); 0 reads as None; phase reads "360°" up to 360 and "720.00" beyond (display role). Speed is written in
 *     BPM and read back in Hz in the edit role the set / objects ops use (60 BPM reads "1.000000").
 *   - Store MAtricks also copies the selection's SpeedMasterOverride; "0" clears it ("", "None", "Off" are ignored).
 *     Any override write while SpeedFromX is None (even "0" on a cleared override) sets SpeedFromX to 60 BPM, so the
 *     override is written first and every planned speed after it.
 *   - MAtricks distributions verified as values (Attribute At 0 Thru 100 with the MAtricks recalled): no MAtricks is
 *     a left-to-right ramp in grid X; XWings 2 mirrors it; XBlock / XGroup repeat it. Timing distributions are not
 *     baked into programmer values, so they are verified as the object's settings only.
 */
import { z } from "zod";
import { BridgeError, type Gma3Bridge } from "../bridge.js";
import { readObjects } from "./common.js";
import { BATCH_NOTE, batchOptionShape, duplicates, runBatchCall } from "../batch.js";
import { json, operation, type RegisterTools, type ToolContext } from "./context.js";
import {
  asRead,
  buildResult,
  commandStep,
  notRequested,
  requestStep,
  runSteps,
  stepFromError,
  timeToSeconds,
  unavailable,
  validationFailure,
  type OperationResult,
  type StepResult,
  type Verification,
} from "../results.js";
import { ValidationError, Validator, describe, finiteNumber, objectName, objectNumber } from "../validate.js";

// ---------------------------------------------------------------------------
// Fixture ids and grid items
// ---------------------------------------------------------------------------

export interface GridItem {
  fixture: string;
  x: number;
  y: number;
  z: number;
}

/** Requested fixture id -> the console address it resolved to (check_fixtures); the stable identity. */
export type AddrMap = ReadonlyMap<string, string>;

/** One entry of the bridge's group.read / selection.grid reply. */
export interface ReadItem {
  sfIndex?: number;
  fixture?: string | null;
  fid?: number | null;
  /** Dotted path from the nearest ancestor with a FID ("501.1"), also for a cell that has its own FID. */
  path?: string | null;
  /** Console address of the (sub)fixture. */
  addr?: string | null;
  name?: string;
  x?: number;
  y?: number;
  z?: number;
  unreadable?: boolean;
}

export const MAX_ITEMS = 512;
const MAX_COORD = 9999;
/** Largest FID (the patch tools' bound) and largest cell number in a dotted id; at most 8 levels. */
export const MAX_FID = 99_999_999;
export const MAX_CELL = 99_999;
const ID_RE = /^\d{1,9}(?:\.\d{1,9}){0,7}$/;

/** A fixture or subfixture id ("401", "501.1") from a number or a string, normalised ("0401" -> "401"); every part a bounded integer. */
export function fixtureId(field: string, value: unknown): string {
  const bad = () => new ValidationError(`${field} must be a fixture id such as 401 or "501.1": a FID 1-${MAX_FID}, then up to 7 cell numbers 1-${MAX_CELL} (got ${describe(value)})`, field);
  let parts: number[];
  if (typeof value === "number") parts = [value];
  else if (typeof value === "string" && ID_RE.test(value.trim())) parts = value.trim().split(".").map((p) => Number(p));
  else throw bad();
  parts.forEach((n, i) => {
    if (!Number.isSafeInteger(n) || n < 1 || n > (i === 0 ? MAX_FID : MAX_CELL)) throw bad();
  });
  return parts.join(".");
}

/**
 * The ids of one helper list entry: a single id, or "a Thru b" with ids of the same depth that differ only in the
 * last part ("401 Thru 404", "501.1 Thru 501.12"). A range runs in its own direction: "402.36 Thru 402.1" lists the
 * cells from 36 down to 1 (SU-12).
 */
export function expandFixtures(field: string, value: unknown): string[] {
  if (typeof value === "string") {
    const m = value.trim().match(/^(\S+)\s+thru\s+(\S+)$/i);
    if (m) {
      const a = fixtureId(field, m[1]).split(".");
      const b = fixtureId(field, m[2]).split(".");
      if (a.length !== b.length || a.slice(0, -1).join(".") !== b.slice(0, -1).join(".")) {
        throw new ValidationError(`${field}: a range must stay within one level ("401 Thru 404", "501.1 Thru 501.12"; got ${describe(value)})`, field);
      }
      const from = Number(a[a.length - 1]);
      const to = Number(b[b.length - 1]);
      if (Math.abs(to - from) + 1 > MAX_ITEMS) throw new ValidationError(`${field}: a range may hold at most ${MAX_ITEMS} ids`, field);
      const prefix = a.slice(0, -1);
      const dir = to < from ? -1 : 1;
      const out: string[] = [];
      // Bounded twice: the parts are validated safe integers, and the loop never runs past MAX_ITEMS.
      for (let n = from; dir > 0 ? n <= to : n >= to; n += dir) {
        if (out.length >= MAX_ITEMS) break;
        out.push([...prefix, String(n)].join("."));
      }
      return out;
    }
  }
  return [fixtureId(field, value)];
}

function fixtureList(field: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new ValidationError(`${field} must be a non-empty list of fixture ids or "a Thru b" ranges`, field);
  const out: string[] = [];
  value.forEach((v, i) => out.push(...expandFixtures(`${field}[${i}]`, v)));
  if (out.length > MAX_ITEMS) throw new ValidationError(`${field} expands to ${out.length} fixtures; at most ${MAX_ITEMS} per group`, field);
  return out;
}

function coord(field: string, value: unknown, fallback = 0): number {
  if (value === undefined || value === null) return fallback;
  return finiteNumber(field, value, { integer: true, min: -MAX_COORD, max: MAX_COORD })!;
}

function step(field: string, value: unknown, fallback = 1): number {
  if (value === undefined || value === null) return fallback;
  const n = finiteNumber(field, value, { integer: true, min: -100, max: 100 })!;
  if (n === 0) throw new ValidationError(`${field} must not be 0 (every fixture would share one cell)`, field);
  return n;
}

function origin(field: string, value: unknown): { x: number; y: number; z: number } {
  if (value === undefined || value === null) return { x: 0, y: 0, z: 0 };
  if (typeof value !== "object" || Array.isArray(value)) throw new ValidationError(`${field} must be {x, y, z}`, field);
  const o = value as Record<string, unknown>;
  return { x: coord(`${field}.x`, o.x), y: coord(`${field}.y`, o.y), z: coord(`${field}.z`, o.z) };
}

function checkBounds(field: string, items: GridItem[]): void {
  for (const it of items) {
    for (const a of ["x", "y", "z"] as const) {
      if (Math.abs(it[a]) > MAX_COORD) throw new ValidationError(`${field}: ${it.fixture} lands at ${a}=${it[a]}, outside -${MAX_COORD}..${MAX_COORD}`, field);
    }
  }
}

export type Arrangement =
  | { type: "row"; fixtures: unknown[]; origin?: unknown; step?: unknown; axis?: unknown }
  | { type: "rectangle"; fixtures: unknown[]; columns: unknown; origin?: unknown; step_x?: unknown; step_y?: unknown; serpentine?: unknown }
  | { type: "mirror"; left: unknown[]; right: unknown[]; origin?: unknown; center_gap?: unknown }
  | { type: "rows"; rows: unknown[]; width?: unknown; align?: unknown; origin?: unknown; step_y?: unknown };

/**
 * The x offsets of a row of `n` fixtures in `width` cells: spread (first and last at the edges, the rest as evenly
 * as whole cells allow), start (packed from the left) or center (packed in the middle, extra cell on the right).
 */
export function rowOffsets(n: number, width: number, align: "spread" | "start" | "center"): number[] {
  if (align === "start") return Array.from({ length: n }, (_, i) => i);
  if (align === "center") return Array.from({ length: n }, (_, i) => Math.floor((width - n) / 2) + i);
  if (n === 1) return [Math.floor((width - 1) / 2)];
  // The spacing is at least one cell (n <= width), so rounding never puts two fixtures in one cell.
  return Array.from({ length: n }, (_, i) => Math.round((i * (width - 1)) / (n - 1)));
}

/** Expand a helper into the explicit coordinate list it stands for. */
export function expandArrangement(a: Arrangement): GridItem[] {
  const field = "arrangement";
  if (!a || typeof a !== "object") throw new ValidationError(`${field} must be an object with a type (row, rectangle, mirror or rows)`, field);
  const o = origin(`${field}.origin`, a.origin);
  let items: GridItem[];
  switch (a.type) {
    case "row": {
      const ids = fixtureList(`${field}.fixtures`, a.fixtures);
      const s = step(`${field}.step`, a.step);
      const axis = a.axis ?? "x";
      if (axis !== "x" && axis !== "y" && axis !== "z") throw new ValidationError(`${field}.axis must be x, y or z`, field);
      items = ids.map((fixture, i) => ({ fixture, ...o, [axis]: o[axis] + i * s }));
      break;
    }
    case "rectangle": {
      const ids = fixtureList(`${field}.fixtures`, a.fixtures);
      const columns = finiteNumber(`${field}.columns`, a.columns, { integer: true, min: 1, max: MAX_ITEMS })!;
      const sx = step(`${field}.step_x`, a.step_x);
      const sy = step(`${field}.step_y`, a.step_y);
      if (a.serpentine !== undefined && typeof a.serpentine !== "boolean") throw new ValidationError(`${field}.serpentine must be true or false`, field);
      items = ids.map((fixture, i) => {
        const row = Math.floor(i / columns);
        let col = i % columns;
        if (a.serpentine === true && row % 2 === 1) col = columns - 1 - col;
        return { fixture, x: o.x + col * sx, y: o.y + row * sy, z: o.z };
      });
      break;
    }
    case "mirror": {
      const left = fixtureList(`${field}.left`, a.left);
      const right = fixtureList(`${field}.right`, a.right);
      if (left.length !== right.length) throw new ValidationError(`${field}: a mirrored arrangement needs the same number of fixtures on each side (left ${left.length}, right ${right.length})`, field);
      const gap = a.center_gap === undefined || a.center_gap === null ? 0 : finiteNumber(`${field}.center_gap`, a.center_gap, { integer: true, min: 0, max: 1000 })!;
      const width = 2 * left.length + gap;
      items = [
        ...left.map((fixture, i) => ({ fixture, x: o.x + i, y: o.y, z: o.z })),
        ...right.map((fixture, i) => ({ fixture, x: o.x + width - 1 - i, y: o.y, z: o.z })),
      ];
      break;
    }
    case "rows": {
      if (!Array.isArray(a.rows) || a.rows.length === 0) throw new ValidationError(`${field}.rows must be a non-empty list of rows, each a list of fixture ids or "a Thru b" ranges`, field);
      const rows = a.rows.map((r, i) => fixtureList(`${field}.rows[${i}]`, r));
      const longest = Math.max(...rows.map((r) => r.length));
      const width = a.width === undefined || a.width === null ? longest : finiteNumber(`${field}.width`, a.width, { integer: true, min: 1, max: MAX_ITEMS })!;
      const align = a.align ?? "spread";
      if (align !== "spread" && align !== "start" && align !== "center") throw new ValidationError(`${field}.align must be spread, start or center`, field);
      const sy = step(`${field}.step_y`, a.step_y);
      rows.forEach((r, i) => {
        if (r.length > width) throw new ValidationError(`${field}.rows[${i}] has ${r.length} fixtures, more than the width of ${width} cells`, field);
      });
      items = rows.flatMap((r, row) => {
        const xs = rowOffsets(r.length, width, align);
        return r.map((fixture, i) => ({ fixture, x: o.x + xs[i], y: o.y + row * sy, z: o.z }));
      });
      break;
    }
    default:
      throw new ValidationError(`${field}.type must be row, rectangle, mirror or rows (got ${describe((a as { type?: unknown }).type)})`, field);
  }
  if (items.length > MAX_ITEMS) throw new ValidationError(`${field} expands to ${items.length} fixtures; at most ${MAX_ITEMS} per group`, field);
  checkBounds(field, items);
  return items;
}

/** Explicit items: [{fixture, x, y, z?}]. */
export function explicitItems(value: unknown): GridItem[] {
  const field = "items";
  if (!Array.isArray(value) || value.length === 0) throw new ValidationError(`${field} must be a non-empty list of {fixture, x, y, z}`, field);
  if (value.length > MAX_ITEMS) throw new ValidationError(`${field} holds ${value.length} entries; at most ${MAX_ITEMS} per group`, field);
  return value.map((v, i) => {
    const f = `${field}[${i}]`;
    if (!v || typeof v !== "object") throw new ValidationError(`${f} must be {fixture, x, y, z}`, f);
    const o = v as Record<string, unknown>;
    if (o.x === undefined || o.y === undefined) throw new ValidationError(`${f} needs x and y (z defaults to 0)`, f);
    return { fixture: fixtureId(`${f}.fixture`, o.fixture), x: coord(`${f}.x`, o.x), y: coord(`${f}.y`, o.y), z: coord(`${f}.z`, o.z) };
  });
}

export interface GridAnalysis {
  count: number;
  duplicates: Array<{ fixture: string; positions: number[] }>;
  sharedCells: Array<{ cell: string; fixtures: string[] }>;
  /** Fixtures listed together with one of their own cells (501 and 501.1): separate items on the console. */
  parentAndCell: Array<{ parent: string; cells: string[] }>;
  bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null;
  /** Empty cells inside the bounding box (kept as gaps when PreserveGridPositions is on). */
  gaps: number;
  /** The smallest coordinates are not 0/0/0. */
  offsetFromOrigin: boolean;
}

export function analyzeGrid(items: GridItem[]): GridAnalysis {
  const byFixture = new Map<string, number[]>();
  const byCell = new Map<string, string[]>();
  items.forEach((it, i) => {
    byFixture.set(it.fixture, [...(byFixture.get(it.fixture) ?? []), i + 1]);
    const cell = `${it.x}/${it.y}/${it.z}`;
    byCell.set(cell, [...(byCell.get(cell) ?? []), it.fixture]);
  });
  const duplicates = [...byFixture].filter(([, p]) => p.length > 1).map(([fixture, positions]) => ({ fixture, positions }));
  const sharedCells = [...byCell].filter(([, f]) => f.length > 1).map(([cell, fixtures]) => ({ cell, fixtures }));
  const ids = new Set(byFixture.keys());
  const parentAndCell: GridAnalysis["parentAndCell"] = [];
  for (const id of ids) {
    const cells = [...ids].filter((c) => c.startsWith(`${id}.`));
    if (cells.length) parentAndCell.push({ parent: id, cells });
  }
  let bounds: GridAnalysis["bounds"] = null;
  let gaps = 0;
  if (items.length) {
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const it of items) for (const a of ["x", "y", "z"] as const) { min[a] = Math.min(min[a], it[a]); max[a] = Math.max(max[a], it[a]); }
    bounds = { min, max };
    gaps = (max.x - min.x + 1) * (max.y - min.y + 1) * (max.z - min.z + 1) - byCell.size;
  }
  return { count: items.length, duplicates, sharedCells, parentAndCell, bounds, gaps, offsetFromOrigin: !!bounds && (bounds.min.x !== 0 || bounds.min.y !== 0 || bounds.min.z !== 0) };
}

/**
 * Does a read item stand for the requested id? By console address when both sides have one (a cell with its own
 * FID is selected as "501.1" but reads back as FID 9001); otherwise by its id, dotted path or own FID.
 */
const sameFixture = (want: string, got: ReadItem, addrs?: AddrMap) => {
  const a = addrs?.get(want);
  if (a && got.addr) return got.addr === a;
  return got.fixture === want || got.path === want || (got.fid !== null && got.fid !== undefined && String(got.fid) === want);
};

/**
 * Differences between a planned list and a read one, matched by fixture (the console keeps a stored group in patch
 * order, not in the order the fixtures were selected); cells are compared only when `coords`.
 */
export function compareGrid(want: GridItem[], got: ReadItem[], coords: boolean, addrs?: AddrMap): string[] {
  const out: string[] = [];
  const unread = got.filter((g) => g.unreadable).length;
  if (unread) out.push(`${unread} item(s) could not be read`);
  const pool = got.filter((g) => !g.unreadable);
  const used = new Set<number>();
  for (const w of want) {
    const i = pool.findIndex((g, k) => !used.has(k) && sameFixture(w.fixture, g, addrs));
    if (i < 0) { out.push(`${w.fixture} is missing`); continue; }
    used.add(i);
    const g = pool[i];
    if (coords && (g.x !== w.x || g.y !== w.y || g.z !== w.z)) out.push(`${w.fixture}: expected cell ${w.x}/${w.y}/${w.z}, read ${g.x}/${g.y}/${g.z}`);
  }
  pool.forEach((g, k) => { if (!used.has(k)) out.push(`unexpected ${g.fixture ?? (g.fid ?? `subfixture index ${g.sfIndex}`)} at ${g.x}/${g.y}/${g.z}`); });
  return out.slice(0, 12);
}

// ---------------------------------------------------------------------------
// Bridge reads
// ---------------------------------------------------------------------------

interface GroupRead {
  ref: string;
  no?: number;
  name?: string;
  lock?: string | null;
  preserveGridPositions?: string | null;
  count: number;
  truncated?: boolean;
  unreadable?: number;
  items: ReadItem[];
}

interface SelectionRead {
  count?: number;
  truncated?: boolean;
  items: ReadItem[];
}

const NEEDS_BRIDGE = "the console runs an older bridge plugin without the selection-grid reads (bridge 0.21.0); update the plugin";
const unknownOp = (err: unknown) => err instanceof BridgeError && /unknown op/.test(err.message);

function readFailure(name: string, op: string, err: unknown): StepResult {
  const s = asRead(stepFromError(name, err, { op }));
  if (unknownOp(err)) s.error = `${s.error}: ${NEEDS_BRIDGE}`;
  return s;
}

const yesNo = (v: unknown): boolean | null => {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return s === "yes" ? true : s === "no" ? false : null;
};
/** Lock display value ("UL" locked, "" unlocked on 2.5.1); null when missing. */
const lockState = (v: unknown): boolean | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  return !(s === "" || s === "no" || s === "off" || s === "false");
};

function presentItems(items: ReadItem[]) {
  return items.map((it, i) => (it.unreadable ? { order: i + 1, unreadable: true } : { order: i + 1, fixture: it.fixture ?? null, ...(it.path && it.path !== it.fixture ? { path: it.path } : {}), name: it.name, x: it.x, y: it.y, z: it.z, ...(it.fixture ? {} : { sfIndex: it.sfIndex }) }));
}

function gridOf(items: ReadItem[]): GridItem[] {
  return items.filter((it) => !it.unreadable).map((it) => ({ fixture: it.fixture ?? `?${it.sfIndex}`, x: it.x ?? 0, y: it.y ?? 0, z: it.z ?? 0 }));
}

// ---------------------------------------------------------------------------
// gma3_selection_grid (read-only)
// ---------------------------------------------------------------------------

export async function selectionGrid(ctx: ToolContext, raw: { group?: number }): Promise<unknown> {
  const t = ctx.requestTimeoutMs;
  const note = "x/y/z are selection-grid coordinates (the arrangement MAtricks and phasers distribute over), not physical stage positions";
  try {
    if (raw.group !== undefined) {
      const group = objectNumber("group", raw.group)!;
      let res: GroupRead;
      try {
        res = (await ctx.bridge.request("group.read", { ref: `Group ${group}` }, t)) as GroupRead;
      } catch (err) {
        if (err instanceof BridgeError && /no objects? found/i.test(err.message)) return { group, exists: false, note: `Group ${group} does not exist` };
        throw err;
      }
      const a = analyzeGrid(gridOf(res.items));
      return {
        source: "group",
        group,
        exists: true,
        name: res.name,
        locked: lockState(res.lock),
        preserveGridPositions: yesNo(res.preserveGridPositions),
        count: res.count,
        ...(res.truncated ? { truncated: true } : {}),
        ...(res.unreadable ? { unreadable: res.unreadable } : {}),
        items: presentItems(res.items),
        sharedCells: a.sharedCells,
        bounds: a.bounds,
        gaps: a.gaps,
        note: `${note}. The console keeps a stored group in patch order; distributions follow the cells. Recalling the group adds the grid cursor to these positions${yesNo(res.preserveGridPositions) === false ? "; PreserveGridPositions is off, so a recall at the origin removes gaps and offsets" : ""}. Read from the stored group; nothing was selected.`,
      };
    }
    const res = (await ctx.bridge.request("selection.grid", {}, t)) as SelectionRead;
    const a = analyzeGrid(gridOf(res.items));
    return { source: "selection", count: res.count ?? res.items.length, ...(res.truncated ? { truncated: true } : {}), items: presentItems(res.items), sharedCells: a.sharedCells, bounds: a.bounds, gaps: a.gaps, note: `${note}. With MAtricks active on the selection these are the transformed positions.` };
  } catch (err) {
    if (unknownOp(err)) throw new Error(NEEDS_BRIDGE);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// gma3_store_group
// ---------------------------------------------------------------------------

interface StoreGroupArgs {
  group: number;
  name?: string;
  items?: unknown;
  arrangement?: Arrangement;
  overwrite?: boolean;
  preserve_grid_positions?: boolean;
  allow_shared_cells?: boolean;
  exclusive?: boolean;
  preview?: boolean;
  verify?: boolean;
}

/** Grid + Fixture per item, one command each, stopping at the first that is not a confirmed success. */
async function buildSelection(bridge: Gma3Bridge, items: GridItem[], t: number): Promise<StepResult> {
  let sent = 0;
  for (const it of items) {
    for (const command of [`Grid ${it.x}/${it.y}/${it.z}`, `Fixture ${it.fixture}`]) {
      const s = await commandStep(bridge, "build_selection", command, t);
      if (s.status !== "succeeded") {
        return { ...s, name: "build_selection", detail: { commandsSent: sent, commandsPlanned: items.length * 2, failedCommand: command }, error: `${command}: ${s.error}` };
      }
      sent++;
    }
  }
  return { name: "build_selection", status: "succeeded", op: "cmd", detail: { commandsSent: sent, items: items.length } };
}

function selectionCheck(name: string, bridge: Gma3Bridge, want: GridItem[], coords: boolean, t: number, addrs: AddrMap, onRead?: (items: ReadItem[]) => void): () => Promise<StepResult> {
  return async () => {
    try {
      const res = (await bridge.request("selection.grid", {}, t)) as SelectionRead;
      onRead?.(res.items);
      const diff = compareGrid(want, res.items, coords, addrs);
      if (diff.length) return asRead({ name, status: "failed", op: "selection.grid", detail: { read: presentItems(res.items).slice(0, 20) }, error: `the selection does not match the plan: ${diff.join("; ")}` });
      return asRead({ name, status: "succeeded", op: "selection.grid", detail: { items: res.items.length } });
    } catch (err) {
      return readFailure(name, "selection.grid", err);
    }
  };
}

function setStep(ctx: ToolContext, name: string, ref: string, property: string, value: string, expect: (v: unknown) => boolean): () => Promise<StepResult> {
  return () =>
    requestStep(ctx.bridge, name, "set", { ref, property, value }, (res) => {
      const got = (res as { value?: unknown } | null)?.value;
      if (got === undefined || got === null) return { name, status: "unknown", op: "set", detail: { ref, property, sent: value }, error: `${property} of ${ref} could not be read back after the write; whether the console applied ${JSON.stringify(value)} is unknown` };
      if (!expect(got)) return { name, status: "failed", op: "set", detail: { ref, property, sent: value, readBack: got }, error: `the console did not apply ${property}=${JSON.stringify(value)} on ${ref}: it reads ${JSON.stringify(got)} (the console silently keeps the previous value when it does not accept one)` };
      return { name, status: "succeeded", op: "set", detail: { ref, property, value: got } };
    }, ctx.requestTimeoutMs);
}

export async function storeGroup(ctx: ToolContext, raw: StoreGroupArgs): Promise<OperationResult> {
  const op = "store_group";
  const v = new Validator();
  const group = v.check(() => objectNumber("group", raw.group, { max: 9999 }));
  const name = v.check(() => objectName("name", raw.name, { optional: true }));
  let items: GridItem[] | undefined;
  if ((raw.items === undefined) === (raw.arrangement === undefined)) v.fail("give exactly one of items (explicit coordinates) or arrangement (row, rectangle, mirror or rows helper)");
  else items = v.check(() => (raw.items !== undefined ? explicitItems(raw.items) : expandArrangement(raw.arrangement!)));
  const preview = raw.preview === true;
  const verify = raw.verify !== false;
  const preserve = raw.preserve_grid_positions !== false;
  for (const k of ["overwrite", "preserve_grid_positions", "allow_shared_cells", "exclusive", "preview", "verify"] as const) {
    if (raw[k] !== undefined && typeof raw[k] !== "boolean") v.fail(`${k} must be true or false`);
  }
  const target: Record<string, unknown> = { group: raw.group };
  const analysis = items ? analyzeGrid(items) : undefined;
  if (analysis?.duplicates.length) {
    v.fail(`duplicate fixtures: ${analysis.duplicates.map((d) => `${d.fixture} (positions ${d.positions.join(", ")})`).join("; ")}. The console silently ignores selecting a fixture again, so a duplicate would be lost; list each fixture once`);
  }
  if (analysis?.sharedCells.length && raw.allow_shared_cells !== true) {
    v.fail(`fixtures share grid cells: ${analysis.sharedCells.map((c) => `${c.cell} (${c.fixtures.join(", ")})`).join("; ")}. The console allows it, but MAtricks then treats them as one position; pass allow_shared_cells: true to keep them`);
  }
  if (!preview && raw.exclusive !== true) {
    v.fail("exclusive must be true: storing a group clears and rebuilds the console's fixture selection (other programmer values are kept) and moves the grid cursor; nobody else may use the selection while the tool runs. preview: true needs no acknowledgement");
  }
  if (!v.ok || group === undefined || !items || !analysis) return validationFailure(op, target, v.errors);
  const ref = `Group ${group}`;
  target.groupRef = ref;
  const bridge = ctx.bridge;
  const t = ctx.requestTimeoutMs;
  const warnings: string[] = [];
  if (analysis.parentAndCell.length) warnings.push(`listed together with their own cells: ${analysis.parentAndCell.map((p) => `${p.parent} with ${p.cells.join(", ")}`).join("; ")}; the console keeps the fixture and its cells as separate selection items`);
  if (analysis.sharedCells.length) warnings.push(`shared cells kept (allow_shared_cells): ${analysis.sharedCells.map((c) => c.cell).join(", ")}`);
  if (!preserve && (analysis.gaps > 0 || analysis.offsetFromOrigin)) warnings.push("preserve_grid_positions is false: a recall at the grid origin removes the gaps and the offset from 0/0/0, so only the fixtures are checked on recall");
  const plan = { items, gaps: analysis.gaps, offsetFromOrigin: analysis.offsetFromOrigin, bounds: analysis.bounds, sharedCells: analysis.sharedCells, preserveGridPositions: preserve, note: "x/y/z are selection-grid coordinates, not physical stage positions" };

  const body = async (): Promise<OperationResult> => {
    let existing: { name?: string; locked: boolean } | null = null;
    let selectionBefore: number | null = null;
    const missing: string[] = [];
    const addrs = new Map<string, string>();
    const aliases: string[] = [];
    const inspect = await runSteps([
      {
        name: "check_group",
        run: async () => {
          try {
            const res = await readObjects(bridge, ref, ["Name", "Lock", "StructureLocked", "SystemLocked"], 1);
            const item = res?.items?.[0];
            if (!item || item.invalid) return asRead({ name: "check_group", status: "succeeded", op: "objects", detail: { exists: false } });
            const f = item.fields ?? {};
            const locked = lockState(f.Lock);
            if (locked === null) return asRead({ name: "check_group", status: "failed", op: "objects", error: `the Lock of ${ref} could not be read; nothing was sent` });
            existing = { name: typeof f.Name === "string" ? f.Name : item.name, locked };
            if (locked || yesNo(f.StructureLocked) || yesNo(f.SystemLocked)) return asRead({ name: "check_group", status: "failed", op: "objects", detail: existing, error: `${ref} is locked; Store answers "Object locked" and a rename is silently ignored. Unlock it first (Lock No) if it may be changed` });
            if (raw.overwrite !== true) return asRead({ name: "check_group", status: "failed", op: "objects", detail: existing, error: `${ref} ("${existing.name}") already exists; pass overwrite: true to replace its fixtures and grid (its name is kept unless name is given)` });
            return asRead({ name: "check_group", status: "succeeded", op: "objects", detail: { exists: true, ...existing } });
          } catch (err) {
            return readFailure("check_group", "objects", err);
          }
        },
      },
      {
        name: "check_fixtures",
        run: async () => {
          try {
            const byAddr = new Map<string, string>();
            for (const it of items) {
              const res = await readObjects(bridge, `Fixture ${it.fixture}`, [], 1);
              const item = res?.items?.[0];
              if (!item || item.invalid || (item.class !== "Fixture" && item.class !== "SubFixture")) { missing.push(it.fixture); continue; }
              if (!item.addr) continue;
              addrs.set(it.fixture, item.addr);
              // Two ids for one object ("501.1" and its own FID 9001): the console would ignore the second selection.
              const first = byAddr.get(item.addr);
              if (first !== undefined) aliases.push(`${first} and ${it.fixture}`);
              else byAddr.set(item.addr, it.fixture);
            }
          } catch (err) {
            return readFailure("check_fixtures", "objects", err);
          }
          if (missing.length) return asRead({ name: "check_fixtures", status: "failed", op: "objects", detail: { missing }, error: `not in the patch: ${missing.join(", ")}` });
          if (aliases.length) return asRead({ name: "check_fixtures", status: "failed", op: "objects", detail: { aliases }, error: `the same fixture is listed twice under different ids: ${aliases.join("; ")} (the console silently ignores selecting it again); list it once` });
          return asRead({ name: "check_fixtures", status: "succeeded", op: "objects", detail: { checked: items.length } });
        },
      },
      {
        name: "read_selection",
        run: async () => {
          try {
            const res = (await bridge.request("selection.grid", {}, t)) as SelectionRead;
            selectionBefore = res.count ?? res.items.length;
            return asRead({ name: "read_selection", status: "succeeded", op: "selection.grid", detail: { selected: selectionBefore } });
          } catch (err) {
            return readFailure("read_selection", "selection.grid", err);
          }
        },
      },
    ]);
    const ex = existing as { name?: string; locked: boolean } | null;
    const extra: Record<string, unknown> = { plan, existing: ex, selectionBefore };
    if (inspect.outcome !== "succeeded") {
      return buildResult({ operation: op, target, steps: inspect.steps, summary: `${op} was not performed; nothing was sent: ${inspect.steps.find((s) => s.status !== "succeeded")?.error ?? "inspection failed"}`, warnings, extra });
    }
    if (preview) {
      return buildResult({ operation: op, target, steps: inspect.steps, summary: `Preview only; nothing was sent. ${ex ? `${ref} would be overwritten` : `${ref} would be created`} with ${items.length} fixture(s); the current selection (${selectionBefore} selected) would be cleared.`, warnings, extra: { ...extra, preview: true } });
    }

    const storeCmd = ex ? `Store Group ${group} /Overwrite /NoConfirmation` : `Store Group ${group} /NoConfirmation`;
    const main = await runSteps([
      { name: "clear_selection", run: () => commandStep(bridge, "clear_selection", "ClearSelection", t) },
      { name: "build_selection", run: () => buildSelection(bridge, items, t) },
      // Nothing is stored unless the selection is exactly the plan (fixtures and cells).
      { name: "check_selection", run: selectionCheck("check_selection", bridge, items, true, t, addrs) },
      { name: "store", run: () => commandStep(bridge, "store", storeCmd, t) },
      { name: "set_preserve_grid_positions", run: setStep(ctx, "set_preserve_grid_positions", ref, "PreserveGridPositions", preserve ? "Yes" : "No", (got) => yesNo(got) === preserve) },
      ...(name !== undefined ? [{ name: "set_name", run: setStep(ctx, "set_name", ref, "Name", name, (got) => String(got).trim() === name) }] : []),
    ]);
    const steps = [...inspect.steps, ...main.steps];
    const stored = main.steps.find((s) => s.name === "store")?.status === "succeeded";

    let verification: Verification = notRequested();
    let resulting: unknown = null;
    if (verify && stored) {
      const checks: string[] = [];
      let readOk = false;
      try {
        const res = (await bridge.request("group.read", { ref }, t)) as GroupRead;
        resulting = { name: res.name, preserveGridPositions: yesNo(res.preserveGridPositions), count: res.count, items: presentItems(res.items) };
        const diff = compareGrid(items, res.items, true, addrs);
        if (yesNo(res.preserveGridPositions) !== preserve) diff.push(`PreserveGridPositions reads ${JSON.stringify(res.preserveGridPositions)}`);
        if (name !== undefined && String(res.name ?? "").trim() !== name) diff.push(`name reads ${JSON.stringify(res.name)}`);
        steps.push(asRead({ name: "read_back", status: "succeeded", op: "group.read", detail: { count: res.count } }));
        checks.push(...diff.map((d) => `stored: ${d}`));
        readOk = true;
      } catch (err) {
        steps.push(readFailure("read_back", "group.read", err));
      }
      // Recall at the grid origin: the same fixtures must come back (on the same cells, when preserved).
      const recall = await runSteps([
        { name: "recall_clear", run: () => commandStep(bridge, "recall_clear", "ClearSelection", t) },
        { name: "recall_cursor", run: () => commandStep(bridge, "recall_cursor", "Grid 0/0/0", t) },
        { name: "recall_group", run: () => commandStep(bridge, "recall_group", `Group ${group}`, t) },
        { name: "recall_check", run: selectionCheck("recall_check", bridge, items, preserve, t, addrs) },
      ]);
      steps.push(...recall.steps);
      const rc = recall.steps.find((s) => s.name === "recall_check");
      if (rc?.status === "failed" && rc.op === "selection.grid" && rc.error?.startsWith("the selection")) checks.push(`recalled: ${rc.error}`);
      const recallOk = rc?.status === "succeeded";
      if (checks.length) verification = { status: "mismatched", checked: `fixtures and grid cells of ${ref}, stored and recalled at 0/0/0`, detail: checks.join("; ") };
      else if (readOk && recallOk) verification = { status: "matched", checked: `fixtures and grid cells of ${ref} (stored SelectionData${name !== undefined ? ", name" : ""}, PreserveGridPositions) and the selection after recalling it at Grid 0/0/0${preserve ? "" : " (fixtures only: positions are not preserved)"}` };
      else verification = unavailable(`the stored group or its recall could not be read: ${[...steps].reverse().find((s) => s.status !== "succeeded")?.error ?? "unknown"}`, ref);
    }
    // Leave no selection behind and the cursor at the origin, after a failure too (once anything was sent).
    // The cleanup steps count towards the outcome: a selection left behind is not a success.
    const cleanup = [await commandStep(bridge, "cleanup_clear_selection", "ClearSelection", t), await commandStep(bridge, "cleanup_cursor", "Grid 0/0/0", t)];
    steps.push(...cleanup);
    const cleanupFailed = cleanup.filter((s) => s.status !== "succeeded");
    if (cleanupFailed.length) warnings.push(`cleanup did not complete (${cleanupFailed.map((s) => `${s.command}: ${s.error}`).join("; ")}); fixtures may still be selected`);
    if (!stored && main.steps.find((s) => s.name === "check_selection")?.status === "failed") warnings.push("nothing was stored: the selection built on the console did not match the plan");
    const result = buildResult({ operation: op, target, steps, verification, warnings, extra: { ...extra, resulting } });
    return result;
  };
  return preview ? body() : ctx.mutations.run(body);
}

// ---------------------------------------------------------------------------
// MAtricks
// ---------------------------------------------------------------------------

const AXES = ["x", "y", "z"] as const;
type Axis = (typeof AXES)[number];
/** Integer settings -> property suffix (XWings, XBlock, ...); null/None clears. */
export const MATRICKS_INTS = { wings: "Wings", blocks: "Block", groups: "Group", width: "Width", shift: "Shift", shuffle: "Shuffle" } as const;
/** From/To distributions -> property kind (FadeFromX / FadeToX, ...). */
export const MATRICKS_RANGES = { fade: "Fade", delay: "Delay", phase: "Phase", speed: "Speed" } as const;
type IntKey = keyof typeof MATRICKS_INTS;
type RangeKey = keyof typeof MATRICKS_RANGES;

/** Properties a new MAtricks gets reset to (the selection MAtricks after Reset on onPC 2.5.1). */
export const MATRICKS_OTHER_DEFAULTS: Record<string, string> = {
  X: "None", Y: "None", Z: "None",
  XInv: "No", XInvB: "No", XInvG: "No", XInvW: "No", YInv: "No", YInvB: "No", YInvG: "No", YInvW: "No", ZInv: "No", ZInvB: "No", ZInvG: "No", ZInvW: "No",
  InvertStyle: "Pan", InvertX: "No", InvertY: "No", InvertZ: "No", AlignRangeX: "No", AlignRangeY: "No", AlignRangeZ: "No",
  RelativeFade: "Yes", RelativeDelay: "Yes", RelativePhase: "Yes", RelativeSpeed: "No", PhaserTransform: "None", ShuffleMode: "Auto",
  // No speed-master override reads "" (it otherwise reads the master's name, "Beat").
  SpeedMasterOverride: "",
};
/**
 * The value written to reset a property when it differs from the value it reads. SpeedMasterOverride is cleared
 * with "0" (qualified on 2.5.1 from masters 1, 2, 15 and BPM); "", "None" and "Off" are silently ignored.
 */
export const MATRICKS_RESET_WRITE: Record<string, string> = { SpeedMasterOverride: "0" };
/**
 * Written before every other property: any SpeedMasterOverride write while SpeedFromX is None (also "0" on a cleared
 * override) sets SpeedFromX to 60 BPM (1 Hz) on 2.5.1, so a later override write would undo a requested or reset speed.
 */
const WRITE_FIRST = new Set(["SpeedMasterOverride"]);

const intProp = (axis: Axis, k: IntKey) => `${axis.toUpperCase()}${MATRICKS_INTS[k]}`;
const rangeProps = (axis: Axis, k: RangeKey) => [`${MATRICKS_RANGES[k]}From${axis.toUpperCase()}`, `${MATRICKS_RANGES[k]}To${axis.toUpperCase()}`] as const;

export function allMatricksProps(): string[] {
  const out: string[] = [];
  for (const a of AXES) {
    for (const k of Object.keys(MATRICKS_INTS) as IntKey[]) out.push(intProp(a, k));
    for (const k of Object.keys(MATRICKS_RANGES) as RangeKey[]) out.push(...rangeProps(a, k));
  }
  return out;
}

/** A display value as the number it means, null for None/empty, undefined when it cannot be interpreted. */
export function matricksValue(kind: "int" | RangeKey, v: unknown): number | null | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  if (s === "" || s.toLowerCase() === "none") return null;
  if (kind === "int") return /^-?\d+$/.test(s) ? Number(s) : undefined;
  if (kind === "phase") {
    const m = s.match(/^(-?\d+(?:\.\d+)?)\s*°?$/);
    return m ? Number(m[1]) : undefined;
  }
  if (kind === "speed") {
    // Written as BPM; the edit role (set replies, objects reads) answers in Hz ("1.000000" for 60 BPM) and the
    // display role in BPM ("60.00 BPM") on 2.5.1. Returned in BPM.
    const m = s.match(/^(-?\d+(?:\.\d+)?)\s*(BPM|Hz)?$/i);
    if (!m) return undefined;
    return m[2]?.toLowerCase() === "bpm" ? Number(m[1]) : Number(m[1]) * 60;
  }
  const secs = timeToSeconds(s);
  return secs === null ? undefined : secs;
}

const near = (a: number | null | undefined, b: number | null) => (a === null || b === null ? a === b : a !== undefined && Math.abs(a - b) < 1e-3);

/** Per-axis view of MAtricks properties read in the display role. */
export function readAxes(fields: Record<string, unknown>): Record<Axis, Record<string, unknown>> {
  const out = {} as Record<Axis, Record<string, unknown>>;
  for (const a of AXES) {
    const axis: Record<string, unknown> = {};
    for (const k of Object.keys(MATRICKS_INTS) as IntKey[]) {
      const raw = fields[intProp(a, k)];
      const v = matricksValue("int", raw);
      axis[k] = v === undefined ? (raw === undefined ? null : { unparsed: raw }) : v;
    }
    for (const k of Object.keys(MATRICKS_RANGES) as RangeKey[]) {
      const [pf, pt] = rangeProps(a, k);
      const f = matricksValue(k, fields[pf]);
      const t = matricksValue(k, fields[pt]);
      axis[k] = f === null && t === null ? null : { from: f === undefined ? fields[pf] ?? null : f, to: t === undefined ? fields[pt] ?? null : t };
    }
    out[a] = axis;
  }
  return out;
}

const UNITS = { fade: "seconds", delay: "seconds", phase: "degrees", speed: "BPM" };

export async function readMatricks(ctx: ToolContext, raw: { matricks: number }): Promise<unknown> {
  const matricks = objectNumber("matricks", raw.matricks)!;
  const ref = `MAtricks ${matricks}`;
  const fields = [...allMatricksProps(), ...Object.keys(MATRICKS_OTHER_DEFAULTS), "Name", "Lock"];
  const res = await readObjects(ctx.bridge, ref, fields, 1);
  const item = res?.items?.[0];
  if (!item || item.invalid) return { matricks, exists: false, note: `${ref} does not exist` };
  const f = item.fields ?? {};
  const other: Record<string, unknown> = {};
  for (const [p, d] of Object.entries(MATRICKS_OTHER_DEFAULTS)) if (f[p] !== undefined && String(f[p]).trim().toLowerCase() !== d.toLowerCase()) other[p] = f[p];
  const unread = fields.filter((p) => f[p] === undefined || f[p] === null);
  return {
    matricks,
    exists: true,
    name: f.Name ?? item.name,
    locked: lockState(f.Lock),
    axes: readAxes(f),
    units: UNITS,
    ...(Object.keys(other).length ? { otherSettings: other, otherNote: "settings outside the per-axis model that differ from a fresh MAtricks (inverts, align ranges, relative flags, ...); not qualified by SB-02" } : {}),
    ...(unread.length ? { unreadable: unread } : {}),
    note: "null = None. A distribution {from, to} spreads over the selection in grid order (with wings: from the outer edges to the centre). Recall it on a selection with 'Recall MAtricks <n>'.",
  };
}

interface AxisSpec {
  wings?: number | null;
  blocks?: number | null;
  groups?: number | null;
  width?: number | null;
  shift?: number | null;
  shuffle?: number | null;
  fade?: { from: number | null; to: number | null } | null;
  delay?: { from: number | null; to: number | null } | null;
  phase?: { from: number | null; to: number | null } | null;
  speed?: { from: number | null; to: number | null } | null;
}

interface ConfigureMatricksArgs {
  matricks: number;
  name?: string;
  create?: boolean;
  x?: AxisSpec;
  y?: AxisSpec;
  z?: AxisSpec;
  reset_unspecified?: boolean;
  preview?: boolean;
  verify?: boolean;
}

interface Wanted {
  property: string;
  kind: "int" | RangeKey;
  /** null = None. */
  value: number | null;
  key: string;
}

function intSetting(field: string, k: IntKey, v: unknown): number | null {
  if (v === null) return null;
  if (k === "shift") {
    const n = finiteNumber(field, v, { integer: true, min: -1000, max: 1000 })!;
    return n === 0 ? null : n;
  }
  const n = finiteNumber(field, v, { integer: true, min: 0, max: 10000 })!;
  return n === 0 ? null : n;
}

function rangeValue(field: string, k: RangeKey, v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (k === "phase") return finiteNumber(field, v, { min: -3600, max: 3600 })!;
  if (k === "speed") {
    const n = finiteNumber(field, v, { min: 0, max: 10000 })!;
    if (n === 0) throw new ValidationError(`${field} must be greater than 0 BPM (null for None)`, field);
    return n;
  }
  return finiteNumber(field, v, { min: 0, max: 3600 })!;
}

/** The property writes a spec asks for, validated. */
export function matricksWanted(raw: Partial<Record<Axis, unknown>>): Wanted[] {
  const out: Wanted[] = [];
  for (const a of AXES) {
    const spec = raw[a];
    if (spec === undefined) continue;
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new ValidationError(`${a} must be an object of axis settings`, a);
    const s = spec as Record<string, unknown>;
    for (const key of Object.keys(s)) if (!(key in MATRICKS_INTS) && !(key in MATRICKS_RANGES)) throw new ValidationError(`${a}.${key} is not a MAtricks axis setting (${[...Object.keys(MATRICKS_INTS), ...Object.keys(MATRICKS_RANGES)].join(", ")})`, a);
    for (const k of Object.keys(MATRICKS_INTS) as IntKey[]) {
      if (s[k] === undefined) continue;
      out.push({ property: intProp(a, k), kind: "int", value: intSetting(`${a}.${k}`, k, s[k]), key: `${a}.${k}` });
    }
    for (const k of Object.keys(MATRICKS_RANGES) as RangeKey[]) {
      if (s[k] === undefined) continue;
      const [pf, pt] = rangeProps(a, k);
      if (s[k] === null) {
        out.push({ property: pf, kind: k, value: null, key: `${a}.${k}.from` }, { property: pt, kind: k, value: null, key: `${a}.${k}.to` });
        continue;
      }
      const r = s[k] as Record<string, unknown>;
      if (typeof r !== "object" || Array.isArray(r) || !("from" in r) || !("to" in r)) throw new ValidationError(`${a}.${k} must be {from, to} (${UNITS[k]}; null for None) or null`, `${a}.${k}`);
      out.push({ property: pf, kind: k, value: rangeValue(`${a}.${k}.from`, k, r.from), key: `${a}.${k}.from` });
      out.push({ property: pt, kind: k, value: rangeValue(`${a}.${k}.to`, k, r.to), key: `${a}.${k}.to` });
    }
  }
  return out;
}

const sendValue = (w: { value: number | null }) => (w.value === null ? "None" : String(w.value));

function skippedSteps(names: string[], why: string): StepResult[] {
  return names.map((name) => ({ name, status: "skipped" as const, error: `not attempted: ${why}` }));
}

export async function configureMatricks(ctx: ToolContext, raw: ConfigureMatricksArgs): Promise<OperationResult> {
  const op = "configure_matricks";
  const v = new Validator();
  const matricks = v.check(() => objectNumber("matricks", raw.matricks, { max: 9999 }));
  const name = v.check(() => objectName("name", raw.name, { optional: true }));
  const wanted = v.check(() => matricksWanted({ x: raw.x, y: raw.y, z: raw.z })) ?? [];
  for (const k of ["create", "reset_unspecified", "preview", "verify"] as const) if (raw[k] !== undefined && typeof raw[k] !== "boolean") v.fail(`${k} must be true or false`);
  const preview = raw.preview === true;
  const verify = raw.verify !== false;
  const target: Record<string, unknown> = { matricks: raw.matricks };
  if (v.ok && wanted.length === 0 && name === undefined && raw.create !== true) v.fail("nothing to configure: give axis settings (x, y, z), a name, or create: true");
  if (!v.ok || matricks === undefined) return validationFailure(op, target, v.errors);
  const ref = `MAtricks ${matricks}`;
  target.matricksRef = ref;
  const bridge = ctx.bridge;
  const t = ctx.requestTimeoutMs;
  const fields = [...allMatricksProps(), ...Object.keys(MATRICKS_OTHER_DEFAULTS), "Name", "Lock", "StructureLocked", "SystemLocked"];

  const body = async (): Promise<OperationResult> => {
    let current: Record<string, unknown> | null = null;
    const inspect = await runSteps([
      {
        name: "read_matricks",
        run: async () => {
          try {
            const res = await readObjects(bridge, ref, fields, 1);
            const item = res?.items?.[0];
            if (!item || item.invalid) {
              if (raw.create !== true) return asRead({ name: "read_matricks", status: "failed", op: "objects", error: `${ref} does not exist; pass create: true to create it` });
              return asRead({ name: "read_matricks", status: "succeeded", op: "objects", detail: { exists: false } });
            }
            current = item.fields ?? {};
            const locked = lockState(current.Lock);
            if (locked === null) return asRead({ name: "read_matricks", status: "failed", op: "objects", error: `the Lock of ${ref} could not be read; nothing was sent` });
            if (locked || yesNo(current.StructureLocked) || yesNo(current.SystemLocked)) return asRead({ name: "read_matricks", status: "failed", op: "objects", error: `${ref} is locked; the console silently ignores changes to it. Unlock it first (Lock No) if it may be changed` });
            const unread = wanted.filter((w) => current![w.property] === undefined || current![w.property] === null).map((w) => w.property);
            if (unread.length) return asRead({ name: "read_matricks", status: "failed", op: "objects", error: `${unread.join(", ")} of ${ref} could not be read; nothing was sent because the current values are unknown` });
            return asRead({ name: "read_matricks", status: "succeeded", op: "objects", detail: { exists: true, name: current.Name } });
          } catch (err) {
            return readFailure("read_matricks", "objects", err);
          }
        },
      },
    ]);
    if (inspect.outcome !== "succeeded") {
      return buildResult({ operation: op, target, steps: inspect.steps, summary: `${op} was not performed; nothing was sent: ${inspect.steps[0]?.error ?? "inspection failed"}` });
    }
    const cur = current as Record<string, unknown> | null;
    const creating = cur === null;
    // A new MAtricks (or reset_unspecified) gets every modelled property: Store copies the selection MAtricks.
    const reset = creating || raw.reset_unspecified === true;
    const given = new Set(wanted.map((w) => w.property));
    const full: Wanted[] = [...wanted];
    if (reset) {
      for (const p of allMatricksProps()) {
        if (given.has(p)) continue;
        const rk = (Object.keys(MATRICKS_RANGES) as RangeKey[]).find((k) => p.startsWith(MATRICKS_RANGES[k])) ?? "int";
        full.push({ property: p, kind: rk, value: null, key: `reset ${p}` });
      }
    }
    type Write = { key: string; property: string; from: unknown; to: string; expect: (got: unknown) => boolean };
    /** The writes needed to bring `values` (null: nothing known yet) to the request; unchanged keys are listed. */
    const planWrites = (values: Record<string, unknown> | null) => {
      const writes: Write[] = [];
      const unchanged: string[] = [];
      // Any SpeedMasterOverride write (even "0" on a cleared one) can refill SpeedFromX, so the speeds are then
      // written after it whatever they read now.
      const overrideWritten = reset && !(values && values.SpeedMasterOverride !== undefined && values.SpeedMasterOverride !== null && String(values.SpeedMasterOverride).trim() === MATRICKS_OTHER_DEFAULTS.SpeedMasterOverride);
      for (const w of full) {
        const from = values ? values[w.property] : undefined;
        if (values && near(matricksValue(w.kind, from), w.value) && !(overrideWritten && w.kind === "speed")) {
          if (!w.key.startsWith("reset")) unchanged.push(w.key);
          continue;
        }
        writes.push({ key: w.key, property: w.property, from: from ?? null, to: sendValue(w), expect: (got) => near(matricksValue(w.kind, got), w.value) });
      }
      if (reset) {
        for (const [p, d] of Object.entries(MATRICKS_OTHER_DEFAULTS)) {
          const from = values ? values[p] : undefined;
          if (values && from !== undefined && from !== null && String(from).trim().toLowerCase() === d.toLowerCase()) continue;
          writes.push({ key: `reset ${p}`, property: p, from: from ?? null, to: MATRICKS_RESET_WRITE[p] ?? d, expect: (got) => String(got).trim().toLowerCase() === d.toLowerCase() });
        }
      }
      if (name !== undefined) {
        if (values && String(values.Name ?? "").trim() === name) unchanged.push("name");
        else writes.push({ key: "name", property: "Name", from: values?.Name ?? null, to: name, expect: (got) => String(got).trim() === name });
      }
      writes.sort((a, b) => Number(WRITE_FIRST.has(b.property)) - Number(WRITE_FIRST.has(a.property)));
      return { writes, unchanged };
    };
    const describePlan = (p: { writes: Write[]; unchanged: string[] }) => ({
      changes: p.writes.filter((w) => !w.key.startsWith("reset")).map(({ key, property, from, to }) => ({ key, property, from, to })),
      resets: p.writes.filter((w) => w.key.startsWith("reset")).map(({ property, from, to }) => ({ property, from, to })),
      unchanged: p.unchanged,
    });
    const first = planWrites(cur);
    const intended: Record<string, unknown> = creating
      ? { create: true, settings: wanted.map((w) => ({ key: w.key, property: w.property, to: sendValue(w) })), resetsEverythingElse: true, note: "a new MAtricks is created with Store MAtricks, which copies the programmer's selection MAtricks; the tool then reads the new object and writes every property that differs from the request (the selection MAtricks itself is not changed)" }
      : { create: false, ...describePlan(first) };
    if (preview || (!creating && first.writes.length === 0)) {
      return buildResult({ operation: op, target, steps: inspect.steps, summary: preview ? `Preview only; nothing was sent. ${creating ? `${ref} would be created` : `${first.writes.length} propert${first.writes.length === 1 ? "y" : "ies"} of ${ref} would change`}.` : `Every requested setting is already set on ${ref}; nothing was sent.`, extra: { intended, preview, noop: !preview } });
    }
    const main = { steps: [] as StepResult[] };
    let writes = first.writes;
    let ok = true;
    if (creating) {
      const store = await commandStep(bridge, "store", `Store MAtricks ${matricks} /NoConfirmation`, t);
      main.steps.push(store);
      ok = store.status === "succeeded";
      if (ok) {
        // What Store copied from the selection MAtricks decides which properties still need a write.
        try {
          const res = await readObjects(bridge, ref, fields, 1);
          const f = res?.items?.[0]?.fields;
          if (!f) throw new Error(`${ref} could not be read after Store`);
          const missing = [...full.map((w) => w.property), ...Object.keys(MATRICKS_OTHER_DEFAULTS)].filter((p) => f[p] === undefined || f[p] === null);
          const p = planWrites(missing.length ? null : f);
          writes = p.writes;
          intended.afterStore = describePlan(p);
          main.steps.push(asRead({ name: "read_new", status: "succeeded", op: "objects", detail: { writesNeeded: writes.length, ...(missing.length ? { unreadable: missing, note: "some properties could not be read, so every property is written" } : {}) } }));
        } catch (err) {
          main.steps.push(readFailure("read_new", "objects", err));
          ok = false;
        }
      }
    }
    if (ok) {
      const r = await runSteps(writes.map((w) => ({ name: `set_${w.property}`, run: setStep(ctx, `set_${w.property}`, ref, w.property, w.to, w.expect) })));
      main.steps.push(...r.steps);
    } else {
      main.steps.push(...skippedSteps(writes.map((w) => `set_${w.property}`), "an earlier step did not succeed"));
    }
    const steps = [...inspect.steps, ...main.steps];
    let verification: Verification = notRequested();
    let resulting: unknown = null;
    if (verify) {
      try {
        const res = await readObjects(bridge, ref, fields, 1);
        const f = res?.items?.[0]?.fields ?? null;
        steps.push(asRead({ name: "read_back", status: f ? "succeeded" : "failed", op: "objects", ...(f ? {} : { error: `${ref} could not be read back` }) }));
        if (f) {
          resulting = { name: f.Name, axes: readAxes(f) };
          const bad: string[] = [];
          for (const w of full) if (!near(matricksValue(w.kind, f[w.property]), w.value)) bad.push(`${w.property}: expected ${sendValue(w)}, read ${JSON.stringify(f[w.property] ?? null)}`);
          // A property missing from the read is unverified, never taken as its default ("" for SpeedMasterOverride).
          if (reset) for (const [p, d] of Object.entries(MATRICKS_OTHER_DEFAULTS)) if (f[p] === undefined || f[p] === null || String(f[p]).trim().toLowerCase() !== d.toLowerCase()) bad.push(`${p}: expected ${JSON.stringify(d)}, read ${JSON.stringify(f[p] ?? null)}`);
          if (name !== undefined && String(f.Name ?? "").trim() !== name) bad.push(`Name: expected ${JSON.stringify(name)}, read ${JSON.stringify(f.Name ?? null)}`);
          const checked = `${reset ? "every MAtricks property" : "the requested settings"} of ${ref}`;
          verification = bad.length ? { status: "mismatched", checked, detail: bad.slice(0, 10).join("; ") } : { status: "matched", checked };
        } else verification = unavailable(`${ref} could not be read back`, ref);
      } catch (err) {
        steps.push(readFailure("read_back", "objects", err));
        verification = unavailable(err instanceof Error ? err.message : String(err), ref);
      }
    }
    return buildResult({ operation: op, target, steps, verification, extra: { intended, resulting } });
  };
  return preview ? body() : ctx.mutations.run(body);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const fixtureEntry = z.union([z.string(), z.number()]);
const originSchema = z.object({ x: z.number().optional(), y: z.number().optional(), z: z.number().optional() }).optional().describe("Grid cell of the first fixture (default 0/0/0).");
const arrangementSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("row"),
      fixtures: z.array(fixtureEntry).describe('Fixture ids along the row; "a Thru b" ranges expand in their own direction ("401 Thru 404", "501.12 Thru 501.1").'),
      origin: originSchema,
      step: z.number().optional().describe("Cells between neighbours (default 1; negative runs backwards)."),
      axis: z.enum(["x", "y", "z"]).optional().describe("Axis of the row (default x)."),
    }),
    z.object({
      type: z.literal("rectangle"),
      fixtures: z.array(fixtureEntry).describe("Fixture ids, filled row by row."),
      columns: z.number().describe("Fixtures per row."),
      origin: originSchema,
      step_x: z.number().optional().describe("Cells between columns (default 1)."),
      step_y: z.number().optional().describe("Cells between rows (default 1)."),
      serpentine: z.boolean().optional().describe("Run every second row backwards (default false)."),
    }),
    z.object({
      type: z.literal("mirror"),
      left: z.array(fixtureEntry).describe("Left half, listed from the outer edge towards the centre."),
      right: z.array(fixtureEntry).describe("Right half, listed from the outer edge towards the centre (same count as left); right[i] mirrors left[i]."),
      origin: originSchema,
      center_gap: z.number().optional().describe("Empty cells between the two halves (default 0)."),
    }),
    z.object({
      type: z.literal("rows"),
      rows: z.array(z.array(fixtureEntry)).describe('Rows top to bottom, each a list of fixture ids or ranges ("402.36 Thru 402.1" runs downwards); rows may differ in length.'),
      width: z.number().optional().describe("Cells per row (default: the longest row)."),
      align: z.enum(["spread", "start", "center"]).optional().describe("spread (default): first and last fixture at the row's edges, the rest evenly; start: packed from the left; center: packed in the middle."),
      origin: originSchema,
      step_y: z.number().optional().describe("Cells between rows (default 1; negative runs upwards)."),
    }),
  ])
  .optional();

const rangeSchema = (unit: string) => z.object({ from: z.number().nullable(), to: z.number().nullable() }).nullable().optional().describe(`{from, to} in ${unit} (null = None); null clears both.`);
const axisSchema = z
  .object({
    wings: z.number().nullable().optional().describe("Wings (mirrored parts); null/0 = None."),
    blocks: z.number().nullable().optional().describe("Block size (neighbours that act as one); null/0 = None."),
    groups: z.number().nullable().optional().describe("Group count (repeat the distribution every n); null/0 = None."),
    width: z.number().nullable().optional().describe("Width; null/0 = None."),
    shift: z.number().nullable().optional().describe("Shift (may be negative); null/0 = None."),
    shuffle: z.number().nullable().optional().describe("Shuffle seed; null/0 = None."),
    fade: rangeSchema("seconds"),
    delay: rangeSchema("seconds"),
    phase: rangeSchema("degrees"),
    speed: rangeSchema("BPM"),
  })
  .optional();

export const registerGroupTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_selection_grid",
    {
      title: "Read a group's or the selection's grid",
      description:
        "Read-only. With group: the stored fixtures of Group <n> (in the console's stored order, which is patch order) with their selection-grid X/Y/Z cells, PreserveGridPositions, lock, shared cells, bounds and gap count, read from the group's stored data (nothing is selected). " +
        "Without group: the current selection in the order it was selected, with its grid cells (MAtricks-transformed when MAtricks is active). Distributions follow the cells, not the list order. Fixture ids are FIDs or dotted cell ids (\"501.1\"). " +
        "Grid cells are the selection grid MAtricks and phasers use, not physical stage positions. Needs bridge 0.21.0.",
      inputSchema: { group: z.number().optional().describe("Group number; omit to read the current selection.") },
    },
    async (args) => {
      try {
        return json(await selectionGrid(ctx, args as { group?: number }));
      } catch (err) {
        return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    "gma3_store_group",
    {
      title: "Store a group with an explicit selection grid",
      description:
        "Create or overwrite Group <n> from a fixture list with explicit selection-grid cells. The cells are the order: the console stores a group in patch order and MAtricks, phasers and At a Thru b distribute along the grid, not along the list. Give either items ([{fixture, x, y, z}]) or an arrangement helper that expands into such a list: " +
        "row (along one axis), rectangle (row by row, optional serpentine), mirror (left and right halves listed outside-in, right[i] mirrors left[i], optional centre gap), rows (one row per list, each spread over width cells). preview: true returns the expanded list, bounds, gaps and shared cells without sending anything. " +
        "Rules: duplicate fixtures are refused (the console silently ignores a second selection); shared cells are refused unless allow_shared_cells: true; gaps and offsets are kept (preserve_grid_positions, default true; false lets a recall at the origin compact them); a fixture and its own cells (501, 501.1) are separate items; missing fixtures are refused. An existing group needs overwrite: true (its name is kept unless name is given); a locked group is refused. " +
        "Requires exclusive: true (not for preview): the tool clears the console's fixture selection (programmer values are kept), selects each fixture after its own 'Grid x/y/z' command, checks that the selection is exactly the plan before 'Store Group', sets PreserveGridPositions and the name, " +
        "then (verify, default true) reads the stored group back and recalls it at Grid 0/0/0 to check order and cells, and finally clears the selection and returns the cursor to 0/0/0. Grid cells are not physical stage positions. Needs bridge 0.21.0. " +
        "rows: rows of different lengths spread over one width (align spread, start or center); ranges run in their own direction (\"402.36 Thru 402.1\"). " +
        BATCH_NOTE,
      inputSchema: {
        group: z.number().optional().describe("Group number (1-9999). Required unless groups is given."),
        name: z.string().optional().describe("Group name (a new group is otherwise named by the console)."),
        items: z.array(z.object({ fixture: fixtureEntry.describe('Fixture id: 401 or "501.1".'), x: z.number(), y: z.number(), z: z.number().optional() })).optional().describe("Explicit list; each fixture once. The cells define the order distributions follow (the console stores the group in patch order)."),
        arrangement: arrangementSchema.describe("Helper that expands into the explicit list (see preview)."),
        overwrite: z.boolean().optional().describe("Replace an existing group (default false: refuse)."),
        preserve_grid_positions: z.boolean().optional().describe("Store with PreserveGridPositions (default true)."),
        allow_shared_cells: z.boolean().optional().describe("Allow two fixtures in one cell (default false: refuse)."),
        exclusive: z.boolean().optional().describe("Required (true) unless preview: nobody else uses the console's selection while the tool runs."),
        preview: z.boolean().optional().describe("Only expand, analyse and check; send nothing (default false)."),
        verify: z.boolean().optional().describe("Read back and recall-check the stored group (default true)."),
        groups: z
          .array(z.object({ group: z.number(), name: z.string().optional(), items: z.array(z.object({ fixture: fixtureEntry, x: z.number(), y: z.number(), z: z.number().optional() })).optional(), arrangement: arrangementSchema, overwrite: z.boolean().optional(), preserve_grid_positions: z.boolean().optional(), allow_shared_cells: z.boolean().optional() }))
          .optional()
          .describe("Batch form: several groups, each {group, name, items | arrangement, overwrite, ...}, stored one after the other."),
        ...batchOptionShape,
      },
    },
    async (args) =>
      operation(() =>
        (args as Record<string, unknown>).groups !== undefined
          ? runBatchCall(args as Record<string, unknown>, {
              operation: "store_group",
              listKey: "groups",
              identityKeys: ["group", "items", "arrangement", "name"],
              label: (it) => `Group ${String(it.group)}`,
              key: (it) => `Group ${String(it.group)}`,
              check: (items) => duplicates(items.map((it) => String(it.group))).map((g) => `Group ${g} appears more than once in groups`),
              run: (it) => storeGroup(ctx, it as unknown as StoreGroupArgs),
            })
          : storeGroup(ctx, args as StoreGroupArgs),
      ),
  );

  server.registerTool(
    "gma3_matricks",
    {
      title: "Read a MAtricks object",
      description:
        "Read-only. The per-axis settings of MAtricks <n>: wings, blocks, groups, width, shift, shuffle, and the fade/delay (seconds), phase (degrees) and speed (BPM) distributions as {from, to}; null means None. Also lists other settings that differ from a fresh MAtricks. Sends no command.",
      inputSchema: { matricks: z.number().describe("MAtricks pool number.") },
    },
    async (args) => {
      try {
        return json(await readMatricks(ctx, args as { matricks: number }));
      } catch (err) {
        return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    "gma3_configure_matricks",
    {
      title: "Create or update a MAtricks object",
      description:
        "Set MAtricks <n> per axis (x, y, z): wings, blocks, groups, width, shift, shuffle (null or 0 = None) and fade/delay (seconds), phase (degrees), speed (BPM) distributions as {from, to}. With wings, a distribution runs from the outer edges (from) to the centre (to), so a centre-out delay is wings 2 with delay {from: <outer>, to: 0}. " +
        "create: true creates a missing object with 'Store MAtricks <n>' and then writes EVERY property (Store copies the programmer's selection MAtricks), so the new object holds exactly the request; reset_unspecified: true does the same for an existing one. Otherwise only the given settings change; values already set are not sent. " +
        "Each value is one 'set' whose reply must read back the requested value (the console silently ignores values it does not accept); the first failure stops the rest. A locked MAtricks is refused. Does not touch the selection or the programmer; apply it with 'Recall MAtricks <n>'. preview: true reports the planned changes.",
      inputSchema: {
        matricks: z.number().describe("MAtricks pool number (1-9999)."),
        name: z.string().optional().describe("MAtricks name."),
        create: z.boolean().optional().describe("Create the object when it does not exist (default false: refuse)."),
        x: axisSchema.describe("X-axis settings."),
        y: axisSchema.describe("Y-axis settings."),
        z: axisSchema.describe("Z-axis settings."),
        reset_unspecified: z.boolean().optional().describe("Reset every setting not given to None/default (always on for create)."),
        preview: z.boolean().optional().describe("Only read and report the planned changes (default false)."),
        verify: z.boolean().optional().describe("Read the object back and compare (default true)."),
      },
    },
    async (args) => operation(() => configureMatricks(ctx, args as ConfigureMatricksArgs)),
  );
};
