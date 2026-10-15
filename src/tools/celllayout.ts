/**
 * SU-08: lay out a fixture's cells (SETUP.md SU-08, docs/probes/su-08-cell-layout-macos-2.5.1.md).
 *
 *   gma3_layout_cells         positions the cells of a fixture along a path (line, square wave, zigzag, points):
 *                             shared (the fixture type's layout, every fixture using it moves; `affects` must name
 *                             them) or own (a copy of the type for the given fixtures, which are moved to it first)
 *   gma3_assign_cell_layout   moves fixtures to another layout type of the same fixture (a copy, or back to the original)
 *
 * Bridge ops patch.cellLayout / patch.cellLayoutWrite / patch.layoutCopy / patch.retype (0.29.0). Console facts
 * (onPC 2.5.1, live 2026-10-15):
 *   - A cell (SubFixture) has no position of its own. Its place is its GeometryReference in the fixture type, under
 *     the DMX mode's root geometry, so a layout belongs to every fixture whose mode uses that root.
 *   - A type copied in the patch copy (Append + Copy) is independent of the original; a patched fixture moved to it
 *     (ModeDirect) keeps its FID, address, cells, group membership and selective preset values; the copy gets its
 *     own GUID on the commit.
 *   - Cell positions are written in the live patch (metres, relative to the cell's parent geometry), with no undo:
 *     the result carries the previous positions. An open patch copy would overwrite them on its commit.
 */
import { z } from "zod";
import { BridgeError } from "../bridge.js";
import { asRead, buildResult, notRequested, stepFromError, unavailable, validationFailure, type OperationResult, type StepResult, type Verification } from "../results.js";
import { Validator, finiteNumber, objectName } from "../validate.js";
import { operation, type RegisterTools, type ToolContext } from "./context.js";
import { listFids, runSession, runSessionLocked } from "./patch.js";
import { UNITS } from "./positions.js";

type Unit = keyof typeof UNITS;
const UNIT_NAMES = Object.keys(UNITS) as Unit[];
const AXES = ["+x", "-x", "+y", "-y", "+z", "-z"] as const;
type Axis = (typeof AXES)[number];
const SHAPES = ["line", "square_wave", "zigzag", "points"] as const;
type Shape = (typeof SHAPES)[number];
/** Read-back tolerance in metres (positions are stored as floats). */
const TOLERANCE_M = 0.0001;

type Vec = { x: number; y: number; z: number };
const vec = (a: Axis): Vec => ({ x: a[1] === "x" ? (a[0] === "+" ? 1 : -1) : 0, y: a[1] === "y" ? (a[0] === "+" ? 1 : -1) : 0, z: a[1] === "z" ? (a[0] === "+" ? 1 : -1) : 0 });
const add = (a: Vec, b: Vec, k = 1): Vec => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k });

export interface PathSpec {
  shape: Shape;
  /** Distance between neighbouring cells along the path (metres). */
  spacing?: number;
  origin: Partial<Vec>;
  direction?: Axis;
  /** square_wave / zigzag: the leg (metres) and its direction; advance: where the path moves on between legs. */
  legLength?: number;
  legDirection?: Axis;
  advance?: Axis;
  /** square_wave: the step between legs (default spacing); zigzag: the advance per leg. */
  legStep?: number;
  points?: Array<Partial<Vec>>;
}

/** The axes a path moves along: the cells keep their own value on the others unless the origin sets it. */
export function pathAxes(p: PathSpec): Set<"x" | "y" | "z"> {
  if (p.shape === "points") return new Set(["x", "y", "z"].filter((k) => (p.points ?? []).some((pt) => pt[k as "x"] !== undefined)) as Array<"x" | "y" | "z">);
  const used = [p.direction, p.legDirection, p.advance].filter(Boolean).map((a) => (a as Axis)[1] as "x" | "y" | "z");
  return new Set(used);
}

/**
 * The positions of `count` cells along the path, at arc length 0, spacing, 2 x spacing, ... from the origin
 * (metres). A square wave runs a leg along legDirection, steps legStep along advance, runs back, and so on; a
 * zigzag goes diagonally, advancing legStep per leg while alternating between the origin line and legLength.
 */
export function layoutPositions(p: PathSpec, count: number): Array<Partial<Vec>> {
  const o: Vec = { x: p.origin.x ?? 0, y: p.origin.y ?? 0, z: p.origin.z ?? 0 };
  if (p.shape === "points") return (p.points ?? []).slice(0, count).map((pt) => ({ ...pt }));
  const spacing = p.spacing as number;
  // Each cell's position is computed from its arc length alone: O(count), whatever the legs (a path of many tiny
  // legs between widely spaced cells must not be walked leg by leg).
  if (p.shape === "line") {
    const d = vec(p.direction ?? "+x");
    return Array.from({ length: count }, (_, i) => add(o, d, i * spacing));
  }
  const leg = vec(p.legDirection ?? "-y");
  const adv = vec(p.advance ?? "+x");
  const L = p.legLength as number;
  const step = p.legStep ?? spacing;
  return Array.from({ length: count }, (_, i) => {
    const s = i * spacing;
    if (p.shape === "square_wave") {
      // Unit j: leg j (length L, down on even j, back up on odd j), then a step of `step` along advance.
      const unit = L + step;
      const j = Math.floor(s / unit);
      const r = s - j * unit;
      const onLeg = r <= L;
      const along = onLeg ? (j % 2 === 0 ? r : L - r) : j % 2 === 0 ? L : 0;
      const a = j * step + (onLeg ? 0 : r - L);
      return add(add(o, adv, a), leg, along);
    }
    // zigzag: leg j runs diagonally from (j x step, 0 or L) to ((j + 1) x step, L or 0).
    const d = Math.hypot(step, L);
    const j = Math.floor(s / d);
    const f = (s - j * d) / d;
    const along = j % 2 === 0 ? f * L : (1 - f) * L;
    return add(add(o, adv, (j + f) * step), leg, along);
  });
}

interface CellRow {
  index: number;
  name?: string;
  parent?: string;
  posX?: number | null;
  posY?: number | null;
  posZ?: number | null;
}
interface LayoutRead {
  type: { no: number; name: string; guid?: string };
  mode: { no: number; name: string };
  rootGeometry: string;
  cells: CellRow[];
  affected: Array<{ fid: number | string; name: string; mode: string }>;
  copyOpen: boolean;
}

const round = (m: number, unit: Unit) => Math.round((m / UNITS[unit]) * 1e4) / 1e4;
const inUnit = (c: CellRow, unit: Unit) => ({ index: c.index, name: c.name, x: c.posX == null ? null : round(c.posX, unit), y: c.posY == null ? null : round(c.posY, unit), z: c.posZ == null ? null : round(c.posZ, unit) });
const fidList = (a: LayoutRead["affected"]) => a.map((x) => Number(x.fid)).sort((p, q) => p - q);
const sameSet = (a: number[], b: number[]) => a.length === b.length && [...a].sort((p, q) => p - q).every((x, i) => x === [...b].sort((p, q) => p - q)[i]);

function validatePath(v: Validator, raw: unknown, unit: Unit): PathSpec | undefined {
  const r = (raw ?? {}) as Record<string, unknown>;
  const shape = SHAPES.includes(r.shape as Shape) ? (r.shape as Shape) : (v.fail(`path.shape must be one of ${SHAPES.join(", ")}`), undefined);
  const len = (k: string, opts: { min?: number; optional?: boolean } = {}) => {
    const x = v.check(() => finiteNumber(`path.${k}`, r[k], { min: opts.min, max: 1000 / UNITS[unit], optional: opts.optional }));
    return x === undefined ? undefined : x * UNITS[unit];
  };
  const axis = (k: string): Axis | undefined => {
    if (r[k] === undefined) return undefined;
    if (!AXES.includes(r[k] as Axis)) return (v.fail(`path.${k} must be one of ${AXES.join(", ")}`), undefined);
    return r[k] as Axis;
  };
  const o = (r.origin ?? {}) as Record<string, unknown>;
  const origin: Partial<Vec> = {};
  for (const k of ["x", "y", "z"] as const) if (o[k] !== undefined) origin[k] = (v.check(() => finiteNumber(`path.origin.${k}`, o[k], { min: -1000 / UNITS[unit], max: 1000 / UNITS[unit] })) ?? 0) * UNITS[unit];
  if (!shape) return undefined;
  const p: PathSpec = { shape, origin };
  if (shape === "points") {
    if (!Array.isArray(r.points) || r.points.length === 0) v.fail("path.points must be a non-empty list of { x, y, z }");
    else
      p.points = r.points.map((pt, i) => {
        const q = (pt ?? {}) as Record<string, unknown>;
        const out: Partial<Vec> = {};
        for (const k of ["x", "y", "z"] as const) if (q[k] !== undefined) out[k] = (v.check(() => finiteNumber(`path.points[${i}].${k}`, q[k], { min: -1000 / UNITS[unit], max: 1000 / UNITS[unit] })) ?? 0) * UNITS[unit];
        if (Object.keys(out).length === 0) v.fail(`path.points[${i}] needs at least one of x, y, z`);
        return out;
      });
    return p;
  }
  p.spacing = len("spacing", { min: 0.0001 / UNITS[unit] });
  if (shape === "line") p.direction = axis("direction") ?? "+x";
  else {
    p.legLength = len("leg_length", { min: 0.0001 / UNITS[unit] });
    p.legDirection = axis("leg_direction") ?? "-y";
    p.advance = axis("advance") ?? "+x";
    p.legStep = len("leg_step", { min: 0, optional: true });
    if (p.legDirection && p.advance && p.legDirection[1] === p.advance[1]) v.fail("path.leg_direction and path.advance must be different axes");
  }
  return p;
}

/** What to write: the path's positions on its own axes, each cell's current value (or the origin's) on the rest. */
export function planCells(read: LayoutRead, path: PathSpec, count: number, rest: "keep" | "last"): Array<{ index: number; x?: number; y?: number; z?: number }> {
  const axes = pathAxes(path);
  const pos = layoutPositions(path, count);
  const cells = read.cells;
  const plan: Array<{ index: number; x?: number; y?: number; z?: number }> = [];
  for (let i = 0; i < cells.length; i++) {
    const p = i < pos.length ? pos[i] : rest === "last" && pos.length ? pos[pos.length - 1] : undefined;
    if (!p) continue;
    const row: { index: number; x?: number; y?: number; z?: number } = { index: cells[i].index };
    for (const k of ["x", "y", "z"] as const) {
      if (axes.has(k) && p[k] !== undefined) row[k] = p[k];
      else if (path.origin[k] !== undefined) row[k] = path.origin[k];
    }
    plan.push(row);
  }
  return plan;
}

async function readLayout(ctx: ToolContext, fid: number): Promise<LayoutRead> {
  try {
    return (await ctx.bridge.request("patch.cellLayout", { fid }, ctx.requestTimeoutMs)) as LayoutRead;
  } catch (err) {
    if (err instanceof BridgeError && /unknown op/.test(err.message)) throw new Error("the console runs an older bridge plugin without patch.cellLayout (needs bridge 0.29.0); update the plugin");
    throw err;
  }
}

/** Compare the cells read back with the plan, within TOLERANCE_M. */
function judge(plan: Array<{ index: number; x?: number; y?: number; z?: number }>, after: LayoutRead, unit: Unit): Verification {
  const checked = `${plan.length} cell position(s) read back from the fixture type, within ${TOLERANCE_M * 1000} mm`;
  const problems: string[] = [];
  for (const w of plan) {
    const c = after.cells.find((x) => x.index === w.index);
    if (!c) {
      problems.push(`cell ${w.index} is missing`);
      continue;
    }
    for (const [k, prop] of [["x", "posX"], ["y", "posY"], ["z", "posZ"]] as const) {
      const want = w[k];
      const got = c[prop];
      if (want !== undefined && (typeof got !== "number" || Math.abs(got - want) > TOLERANCE_M)) problems.push(`cell ${w.index} ${k} reads ${got == null ? "nothing" : round(got, unit)} ${unit}, expected ${round(want, unit)} ${unit}`);
    }
  }
  return problems.length ? { status: "mismatched", checked, detail: problems.slice(0, 20).join("; ") + (problems.length > 20 ? `; ... ${problems.length - 20} more` : "") } : { status: "matched", checked };
}

export async function layoutCells(ctx: ToolContext, raw: Record<string, unknown>): Promise<OperationResult> {
  const op = "layout_cells";
  const v = new Validator();
  const fid = v.check(() => finiteNumber("fixture", raw.fixture, { integer: true, min: 1 }));
  const unit: Unit = UNIT_NAMES.includes(raw.unit as Unit) ? (raw.unit as Unit) : raw.unit === undefined ? "m" : (v.fail(`unit must be one of ${UNIT_NAMES.join(", ")}`), "m");
  const path = validatePath(v, raw.path, unit);
  const scope = raw.scope === undefined ? "shared" : raw.scope === "shared" || raw.scope === "own" ? (raw.scope as "shared" | "own") : (v.fail('scope must be "shared" or "own"'), "shared");
  const count = raw.count === undefined ? undefined : v.check(() => finiteNumber("count", raw.count, { integer: true, min: 1, max: 10000 }));
  const rest = raw.rest === undefined ? "keep" : raw.rest === "keep" || raw.rest === "last" ? (raw.rest as "keep" | "last") : (v.fail('rest must be "keep" or "last"'), "keep");
  const preview = raw.preview === true;
  if (!preview && raw.exclusive !== true) v.fail("exclusive must be true: a cell layout is written into the fixture type with no undo (the result carries the previous positions), and an own layout runs a patch session; nobody else may use the console while it runs. preview: true needs no acknowledgement");
  let affects: number[] | undefined;
  if (raw.affects !== undefined) {
    if (!Array.isArray(raw.affects) || raw.affects.length === 0) v.fail("affects must list FIDs");
    else affects = raw.affects.map((x, i) => v.check(() => finiteNumber(`affects[${i}]`, x, { integer: true, min: 1 })) ?? 0);
  }
  let ownFids: number[] = [];
  let ownName: string | undefined;
  if (scope === "own") {
    const own = (raw.own ?? {}) as Record<string, unknown>;
    ownName = v.check(() => objectName("own.name", own.name));
    ownFids = Array.isArray(own.fixtures) && own.fixtures.length ? own.fixtures.map((x, i) => v.check(() => finiteNumber(`own.fixtures[${i}]`, x, { integer: true, min: 1 })) ?? 0) : fid !== undefined ? [fid] : [];
    if (fid !== undefined && !ownFids.includes(fid)) v.fail("own.fixtures must include fixture");
  } else if (raw.own !== undefined) v.fail('own applies to scope "own" only');
  if (scope === "shared" && !preview && affects === undefined) v.fail("affects is required for a shared layout: list every FID that uses this layout (preview: true lists them); all of them move");
  const target = { fixture: raw.fixture, scope, path: raw.path, unit };
  if (!v.ok || fid === undefined || !path) return validationFailure(op, target, v.errors);
  // One lock span from the first read to the read-back: a queued mutation (a retype, another layout) cannot land
  // between the plan and the write. The patch session runs inside it (runSessionLocked: the lock is not reentrant).
  return ctx.mutations.run(() => layoutCellsLocked(ctx, { op, target, fid, unit, path, scope, count, rest, preview, affects, ownFids, ownName, verify: raw.verify !== false }));
}

interface LayoutJob {
  op: string;
  target: Record<string, unknown>;
  fid: number;
  unit: Unit;
  path: PathSpec;
  scope: "shared" | "own";
  count: number | undefined;
  rest: "keep" | "last";
  preview: boolean;
  affects: number[] | undefined;
  ownFids: number[];
  ownName: string | undefined;
  verify: boolean;
}

async function layoutCellsLocked(ctx: ToolContext, job: LayoutJob): Promise<OperationResult> {
  const { op, target, fid, unit, path, scope, count, rest, preview, affects, ownFids, ownName } = job;
  const steps: StepResult[] = [];
  const t = ctx.requestTimeoutMs;
  let before: LayoutRead;
  try {
    before = await readLayout(ctx, fid);
    steps.push(asRead({ name: "read_layout", status: "succeeded", op: "patch.cellLayout", detail: { type: before.type, mode: before.mode, cells: before.cells.length, affected: fidList(before.affected) } }));
  } catch (err) {
    steps.push(asRead(stepFromError("read_layout", err, { op: "patch.cellLayout" })));
    return buildResult({ operation: op, target, steps, verification: unavailable("nothing was sent") });
  }
  const fail = (why: string, extra: Record<string, unknown> = {}) => {
    steps.push(asRead({ name: "check", status: "failed", error: `${why}; nothing was changed` }));
    return buildResult({ operation: op, target, steps, verification: unavailable("nothing was changed"), extra: { affected: before.affected, ...extra } });
  };
  if (before.cells.length === 0) return fail(`Fixture ${fid} (${before.type.name}, ${before.mode.name}) has no cells`);
  if (before.copyOpen) return fail("the patch copy is open (the Patch menu or an unfinished session); its commit would overwrite the positions. Close it at the console first");
  const n = Math.min(count ?? before.cells.length, before.cells.length);
  if (path.shape === "points" && (path.points?.length ?? 0) < n && rest === "keep" && count !== undefined && (path.points?.length ?? 0) < count) return fail(`path.points has ${path.points?.length} point(s) for count ${count}`);
  const plan = planCells(before, path, path.shape === "points" ? Math.min(n, path.points?.length ?? 0) : n, rest);
  const affectedFids = fidList(before.affected);
  const previewOut = {
    type: before.type,
    mode: before.mode,
    cells: before.cells.length,
    placed: plan.length,
    affected: before.affected,
    plan: plan.map((p) => ({ index: p.index, ...(p.x !== undefined ? { x: round(p.x, unit) } : {}), ...(p.y !== undefined ? { y: round(p.y, unit) } : {}), ...(p.z !== undefined ? { z: round(p.z, unit) } : {}) })),
    unit,
    frame: `positions are relative to each cell's parent geometry (${before.cells[0].parent ?? before.rootGeometry}) of the fixture type; the fixture's own position and rotation then apply`,
  };
  if (scope === "shared") {
    if (preview) return buildResult({ operation: op, target, steps, verification: notRequested(), summary: `Preview only; nothing was sent. The layout of ${before.type.name} / ${before.mode.name} is shared by ${affectedFids.length} fixture(s) (${affectedFids.join(", ")}): all of them would move. To lay out only some of them, use scope "own".`, extra: previewOut });
    if (!sameSet(affects as number[], affectedFids)) return fail(`the layout of ${before.type.name} / ${before.mode.name} is shared by FIDs ${affectedFids.join(", ")}, and affects lists ${(affects as number[]).join(", ")}: name exactly the fixtures that move, or use scope "own" for a layout of their own`, previewOut);
  } else {
    if (sameSet(ownFids, affectedFids)) return fail(`FIDs ${ownFids.join(", ")} are already the only users of ${before.type.name} / ${before.mode.name}: use scope "shared" with affects [${affectedFids.join(", ")}]`);
    if (preview) return buildResult({ operation: op, target, steps, verification: notRequested(), summary: `Preview only; nothing was sent. A copy of ${before.type.name} named "${ownName}" would be created, FIDs ${ownFids.join(", ")} moved to it, and its cells laid out; the other fixtures of ${before.type.name} keep their layout.`, extra: { ...previewOut, own: { name: ownName, fixtures: ownFids } } });
  }

  // Own: copy the type and move the fixtures to it in one patch session, then lay out the copy.
  let session: OperationResult | undefined;
  let layoutType = before.type;
  const sourceGuid = before.type.guid;
  if (scope === "own") {
    session = await runSessionLocked(ctx, {
      operation: "layout_copy",
      target: { type: before.type.name, name: ownName, fixtures: ownFids },
      touchedFids: ownFids,
      verify: true,
      preflight: async () => {
        try {
          const rows = await listFids(ctx.bridge, ownFids, t);
          const missing = ownFids.filter((f) => !rows.has(f));
          const other = ownFids.filter((f) => rows.has(f) && !String(rows.get(f)?.type ?? "").endsWith(before.type.name));
          if (missing.length || other.length) return asRead({ name: "check_fixtures", status: "failed", op: "patch.list", error: `${missing.length ? `not in the patch: ${missing.join(", ")}` : ""}${missing.length && other.length ? "; " : ""}${other.length ? `not of type ${before.type.name}: ${other.join(", ")}` : ""}` });
          const types = (await ctx.bridge.request("patch.types", {}, t)) as { types: Array<{ name: string }> };
          if (types.types.some((x) => x.name === ownName)) return asRead({ name: "check_fixtures", status: "failed", op: "patch.types", error: `the show already has a fixture type named ${ownName}` });
          return asRead({ name: "check_fixtures", status: "succeeded", op: "patch.list", detail: { fixtures: ownFids } });
        } catch (err) {
          return asRead(stepFromError("check_fixtures", err, { op: "patch.list" }));
        }
      },
      editName: "copy_and_retype",
      edit: () => ({ op: "patch.layoutCopy", args: { type: before.type.no, name: ownName, fids: ownFids } }),
      // The appended type is left out of the copy's FixtureTypes; the retyped fixtures are left out as touched FIDs.
      isolation: () => ({ prefixOfLive: true }),
      readBack: async () => {
        try {
          const rows = await listFids(ctx.bridge, ownFids, t);
          const wrong = ownFids.filter((f) => !String(rows.get(f)?.type ?? "").endsWith(ownName as string));
          const step = asRead({ name: "read_back_types", status: "succeeded", op: "patch.list", detail: [...rows.values()] });
          return { steps: [step], verification: wrong.length ? { status: "mismatched", checked: "the fixtures' type", detail: `FIDs ${wrong.join(", ")} are not of type ${ownName}` } : { status: "matched", checked: "the fixtures' type" } };
        } catch (err) {
          return { steps: [asRead(stepFromError("read_back_types", err, { op: "patch.list" }))], verification: unavailable("the fixtures could not be read back") };
        }
      },
    });
    steps.push(...session.steps.map((s) => ({ ...s, name: `own: ${s.name}` })));
    if (session.outcome !== "succeeded" || session.verification.status === "mismatched") {
      return buildResult({ operation: op, target, steps, verification: session.verification, summary: `The own layout type was not set up: ${session.summary} No cell was moved.`, extra: { own: { name: ownName, fixtures: ownFids }, copyLeftOpen: (session as unknown as { copyLeftOpen?: unknown }).copyLeftOpen } });
    }
    try {
      before = await readLayout(ctx, fid);
      steps.push(asRead({ name: "read_own_layout", status: "succeeded", op: "patch.cellLayout", detail: { type: before.type, affected: fidList(before.affected) } }));
    } catch (err) {
      steps.push(asRead(stepFromError("read_own_layout", err, { op: "patch.cellLayout" })));
      return buildResult({ operation: op, target, steps, verification: unavailable("the new type was created but its layout could not be read; no cell was moved") });
    }
    if (!sameSet(fidList(before.affected), ownFids)) {
      steps.push(asRead({ name: "check_own", status: "failed", error: `the new type is used by FIDs ${fidList(before.affected).join(", ")}, expected ${ownFids.join(", ")}; no cell was moved` }));
      return buildResult({ operation: op, target, steps, verification: unavailable("no cell was moved") });
    }
    // The console gives a copied type its own GUID on the commit (a copy reads all zeros before it, live 2026-10-15).
    // Types are told apart by GUID (fixture-type identity, gma3_patch_remove_type), so a copy without its own stops here.
    const guid = before.type.guid ?? "";
    const guidProblem = !guid || /^[0\s]+$/.test(guid) ? `the new type ${before.type.name} has no GUID of its own after the commit (${guid ? `"${guid}"` : "none"})` : guid === sourceGuid ? `the new type ${before.type.name} has the same GUID as ${layoutType.name} (${guid})` : undefined;
    if (guidProblem) {
      steps.push(asRead({ name: "check_own_guid", status: "failed", error: `${guidProblem}; no cell was moved. The fixtures are on the new type: move them back with gma3_assign_cell_layout and remove it with gma3_patch_remove_type` }));
      return buildResult({ operation: op, target, steps, verification: { status: "mismatched", checked: "the new type's GUID is its own after the commit", detail: guidProblem }, extra: { own: { name: ownName, fixtures: ownFids }, type: before.type, sourceType: layoutType } });
    }
    steps.push(asRead({ name: "check_own_guid", status: "succeeded", detail: { guid, source: sourceGuid } }));
    layoutType = before.type;
  }

  const expect = scope === "own" ? ownFids : (affects as number[]);
  let written: { previous: CellRow[]; cells: CellRow[] } | undefined;
  let failedDetail: { previous?: CellRow[] } | undefined;
  let writeStatus: "succeeded" | "failed" | "unknown";
  try {
    // The bridge re-checks the affected set and that the layout still belongs to the planned type (GUID, cells).
    written = (await ctx.bridge.request("patch.cellLayoutWrite", { fid, cells: plan, expectAffected: expect, expectType: before.type.guid, expectCells: before.cells.length, exclusive: true }, t)) as { previous: CellRow[]; cells: CellRow[] };
    steps.push({ name: "write_cells", status: "succeeded", op: "patch.cellLayoutWrite", detail: { cells: plan.length } });
    writeStatus = "succeeded";
  } catch (err) {
    const s = stepFromError("write_cells", err, { op: "patch.cellLayoutWrite" });
    if (err instanceof BridgeError && err.detail !== undefined) {
      s.detail = err.detail;
      failedDetail = err.detail as { previous?: CellRow[] };
    }
    steps.push(s);
    writeStatus = s.status === "unknown" ? "unknown" : "failed";
  }
  // The positions before the write: the bridge's, or this call's own read (taken under the same lock).
  const planned = new Set(plan.map((p) => p.index));
  const previousRows = written?.previous ?? before.cells.filter((c) => planned.has(c.index));
  // A refused write that names written cells (write-failed) stopped part-way: the cells before the last one were
  // written, the last one may be partly written. A lost reply leaves every planned cell uncertain.
  const reported = failedDetail?.previous ?? [];
  const writeState =
    writeStatus === "succeeded"
      ? { written: plan.map((p) => p.index), uncertain: [] as number[] }
      : writeStatus === "unknown"
        ? { written: [] as number[], uncertain: plan.map((p) => p.index) }
        : { written: reported.slice(0, -1).map((c) => c.index), uncertain: reported.slice(-1).map((c) => c.index) };

  let verification: Verification = notRequested();
  let changed: number[] | undefined;
  if (job.verify || writeStatus !== "succeeded") {
    try {
      const after = await readLayout(ctx, fid);
      steps.push(asRead({ name: "read_back", status: "succeeded", op: "patch.cellLayout" }));
      verification = judge(plan, after, unit);
      const moved = (c: CellRow) => {
        const b = before.cells.find((x) => x.index === c.index);
        return !b || ["posX", "posY", "posZ"].some((k) => Math.abs(((c as unknown as Record<string, number>)[k] ?? 0) - ((b as unknown as Record<string, number>)[k] ?? 0)) > TOLERANCE_M);
      };
      changed = after.cells.filter((c) => planned.has(c.index) && moved(c)).map((c) => c.index);
    } catch (err) {
      steps.push(asRead(stepFromError("read_back", err, { op: "patch.cellLayout" })));
      verification = unavailable("the cell positions could not be read back");
    }
  }
  const result = buildResult({
    operation: op,
    target,
    steps,
    verification,
    warnings: [`the cells of every fixture using ${layoutType.name} / ${before.mode.name} moved: FIDs ${expect.join(", ")}`, "a cell layout has no undo; previous holds the positions before this call (pass them as path points to restore)"],
    extra: {
      ...previewOut,
      type: layoutType,
      scope,
      ...(scope === "own" ? { own: { name: ownName, fixtures: ownFids, from: session?.target } } : {}),
      affected: expect,
      previous: previousRows.map((c) => inUnit(c, unit)),
      ...(writeStatus !== "succeeded" ? { writeState: { ...writeState, ...(changed ? { changedAfter: changed } : {}) } } : {}),
    },
  });
  // A write that stopped part-way changed some cells: the read-back decides between partial and failed.
  if (writeStatus === "failed") {
    const some = (changed?.length ?? 0) > 0 || writeState.written.length > 0;
    // Cells moved (read back, or reported written): partial. None reported and the read-back failed with a cell
    // that may be partly written: unknown. Otherwise nothing of the layout changed: failed, or partial after an own
    // layout's session (the type copy and the retype were committed).
    if (some) result.outcome = "partial";
    else if (changed === undefined && writeState.uncertain.length > 0) result.outcome = "unknown";
    else result.outcome = scope === "own" ? "partial" : "failed";
    result.summary = `${op}: the cell write stopped part-way (${steps.find((x) => x.name === "write_cells")?.error ?? "refused"}). ${some ? `Cells ${(changed ?? writeState.written).join(", ")} moved` : changed === undefined ? "Which cells moved is unknown (the read-back failed)" : "No cell moved"}${writeState.uncertain.length ? `; cell ${writeState.uncertain.join(", ")} may be partly written` : ""}. previous holds every planned cell's position before the call, to restore with path points.`;
  } else if (writeStatus === "unknown") {
    result.summary = `${op}: the cell write got no reply; ${changed === undefined ? "whether any cell moved is unknown" : changed.length ? `cells ${changed.join(", ")} moved` : "no cell moved"}. previous holds the positions before the call.`;
  }
  return result;
}

export async function assignCellLayout(ctx: ToolContext, raw: Record<string, unknown>): Promise<OperationResult> {
  const op = "assign_cell_layout";
  const v = new Validator();
  const fids = Array.isArray(raw.fixtures) && raw.fixtures.length ? raw.fixtures.map((x, i) => v.check(() => finiteNumber(`fixtures[${i}]`, x, { integer: true, min: 1 })) ?? 0) : (v.fail("fixtures must list FIDs"), []);
  const type = typeof raw.type === "number" || (typeof raw.type === "string" && raw.type.trim()) ? raw.type : (v.fail("type (number or name) is required"), undefined);
  if (raw.exclusive !== true) v.fail("exclusive must be true: the fixtures are moved to another fixture type in a patch session, committed with no undo");
  const target = { fixtures: raw.fixtures, type: raw.type };
  if (!v.ok || type === undefined) return validationFailure(op, target, v.errors);
  const t = ctx.requestTimeoutMs;
  let toName = "";
  return runSession(ctx, {
    operation: op,
    target,
    touchedFids: fids,
    verify: raw.verify !== false,
    preflight: async () => {
      try {
        const types = (await ctx.bridge.request("patch.types", {}, t)) as { types: Array<{ no: number; name: string }> };
        const to = types.types.find((x) => x.no === type || x.name === type);
        if (!to) return asRead({ name: "check_type", status: "failed", op: "patch.types", error: `no fixture type ${JSON.stringify(type)} in the show` });
        toName = to.name;
        const rows = await listFids(ctx.bridge, fids, t);
        const missing = fids.filter((f) => !rows.has(f));
        if (missing.length) return asRead({ name: "check_type", status: "failed", op: "patch.list", error: `not in the patch: ${missing.join(", ")}` });
        return asRead({ name: "check_type", status: "succeeded", op: "patch.types", detail: { type: to } });
      } catch (err) {
        return asRead(stepFromError("check_type", err, { op: "patch.types" }));
      }
    },
    editName: "retype",
    edit: () => ({ op: "patch.retype", args: { type, fids } }),
    readBack: async () => {
      try {
        const rows = await listFids(ctx.bridge, fids, t);
        const wrong = fids.filter((f) => !String(rows.get(f)?.type ?? "").endsWith(toName));
        return {
          steps: [asRead({ name: "read_back", status: "succeeded", op: "patch.list", detail: [...rows.values()] })],
          verification: wrong.length ? { status: "mismatched", checked: "the fixtures' type", detail: `FIDs ${wrong.join(", ")} are not of type ${toName}` } : { status: "matched", checked: "the fixtures' type, address and mode (the bridge refuses a change of either)" },
        };
      } catch (err) {
        return { steps: [asRead(stepFromError("read_back", err, { op: "patch.list" }))], verification: unavailable("the fixtures could not be read back") };
      }
    },
  });
}

export const registerCellLayoutTools: RegisterTools = (server, ctx) => {
  const axis = z.enum(AXES);
  server.registerTool(
    "gma3_layout_cells",
    {
      title: "Lay out a fixture's cells (string lights, pixel strands)",
      description:
        "Positions the cells of a multi-cell fixture along a path. A cell has no position of its own: its place is in the fixture type, shared by every fixture whose DMX mode uses that layout. " +
        'scope "shared" (default) writes the type\'s layout: every fixture using it moves, and affects must list exactly those FIDs (preview: true lists them). scope "own" first copies the type for own.fixtures (default: the fixture) under own.name, moves them to the copy in a patch session (FIDs, addresses, cells, groups and preset values are kept), then lays out the copy; the other fixtures keep theirs. ' +
        "path: shape line (direction), square_wave (legs of leg_length along leg_direction, stepping leg_step along advance between them), zigzag (diagonal legs, advancing leg_step per leg) or points; cells are placed every spacing along the path from origin; axes the path does not use keep each cell's value unless origin sets them. count places only the first cells; rest keep|last. " +
        "Lengths in unit (m, cm, mm, ft, in), relative to the cells' parent geometry (the fixture's own position, rotation and mirroring then apply: place the fixture with gma3_place_fixtures). Refused while the patch copy is open. No undo: previous holds the positions before the call. Read back per cell. Needs bridge 0.29.0.",
      inputSchema: {
        fixture: z.number().describe("FID of a fixture with cells; its type and mode define the layout."),
        path: z.object({
          shape: z.enum(SHAPES),
          spacing: z.number().optional().describe("Distance between neighbouring cells along the path."),
          origin: z.object({ x: z.number().optional(), y: z.number().optional(), z: z.number().optional() }).optional(),
          direction: axis.optional().describe("line: the direction (default +x)."),
          leg_length: z.number().optional().describe("square_wave / zigzag: the length of a leg along leg_direction."),
          leg_direction: axis.optional().describe("default -y"),
          advance: axis.optional().describe("default +x"),
          leg_step: z.number().optional().describe("square_wave: the step between legs (default spacing); zigzag: the advance per leg (default spacing)."),
          points: z.array(z.object({ x: z.number().optional(), y: z.number().optional(), z: z.number().optional() })).optional(),
        }),
        unit: z.enum(UNIT_NAMES as [Unit, ...Unit[]]).optional(),
        count: z.number().optional().describe("Place only the first count cells."),
        rest: z.enum(["keep", "last"]).optional().describe("The cells after count: keep their positions (default) or stack at the last placed one."),
        scope: z.enum(["shared", "own"]).optional(),
        affects: z.array(z.number()).optional().describe("shared: every FID that uses this layout (all of them move)."),
        own: z.object({ name: z.string(), fixtures: z.array(z.number()).optional() }).optional().describe("own: the new type's name and the fixtures that get it."),
        preview: z.boolean().optional(),
        exclusive: z.boolean().optional(),
        verify: z.boolean().optional(),
      },
    },
    (args) => operation(() => layoutCells(ctx, args as Record<string, unknown>)),
  );

  server.registerTool(
    "gma3_assign_cell_layout",
    {
      title: "Move fixtures to another layout of their fixture type",
      description:
        "Moves fixtures to another fixture type that is a layout copy of theirs (as gma3_layout_cells scope own creates) or back to the original, so several fixtures share one layout. The target type must have a DMX mode of the same name with the same channels and footprint (refused otherwise). " +
        "Runs one patch session (isolation-checked, committed with no undo); FIDs, addresses, cells, groups and preset values are kept. Requires exclusive: true. Needs bridge 0.29.0.",
      inputSchema: {
        fixtures: z.array(z.number()),
        type: z.union([z.number(), z.string()]).describe("The layout type (number or name)."),
        exclusive: z.boolean().optional(),
        verify: z.boolean().optional(),
      },
    },
    (args) => operation(() => assignCellLayout(ctx, args as Record<string, unknown>)),
  );
};
