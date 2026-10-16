/**
 * SU-19: a fixture's physical cell order (SETUP.md SU-19, docs/probes/su-19-fixture-type-data-macos-2.5.1.md).
 *
 * The cells of a mode are numbered in geometry-tree order (the patched fixture's 401.1, 401.2, ...), which need not be
 * the order the bulbs sit along the string. The DMX addresses follow the wiring: data runs along the string, so the
 * physical order is the cells sorted by DMX address (break, then the cell's offset in it). Live: the Festoon's "Pixel
 * Mode - 2 string" has its cells in DMX order 1-9, 19-29, 10-18, 30-40, the interleave the field test found by hand,
 * and in that order every step between neighbouring cells is one 0.61 m pitch of the type's own positions.
 */
import type { ToolContext } from "./context.js";

export interface OrderCell {
  index: number;
  name?: string;
  breakOffsets?: string;
  posX?: number | null;
  posY?: number | null;
  posZ?: number | null;
}

/** The first (lowest) break and that break's offset of a cell ("1:61,2:1" -> [1, 61]); null when unreadable. */
function firstAddress(c: OrderCell): [number, number] | null {
  const pairs = String(c.breakOffsets ?? "")
    .split(",")
    .map((p) => p.split(":").map(Number))
    .filter((p) => p.length === 2 && p.every((x) => Number.isFinite(x)))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return pairs.length ? [pairs[0][0], pairs[0][1]] : null;
}

/** Cell indices in DMX order, or null when a cell's address cannot be read (no order is guessed). */
export function dmxOrder(cells: OrderCell[]): number[] | null {
  const keyed = cells.map((c) => ({ c, a: firstAddress(c) }));
  if (keyed.some((k) => !k.a)) return null;
  return keyed.sort((x, y) => x.a![0] - y.a![0] || x.a![1] - y.a![1] || x.c.index - y.c.index).map((k) => k.c.index);
}

/** [1,2,3,19,20,10] -> "1-3, 19-20, 10" (runs of +1 or -1). */
export function runs(order: number[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < order.length) {
    let j = i;
    const dir = order[i + 1] !== undefined && Math.abs(order[i + 1] - order[i]) === 1 ? order[i + 1] - order[i] : 0;
    if (dir) while (j + 1 < order.length && order[j + 1] - order[j] === dir) j++;
    out.push(i === j ? String(order[i]) : `${order[i]}-${order[j]}`);
    i = j + 1;
  }
  return out.join(", ");
}

/** The distances between neighbouring cells of an order, from the type's positions (metres); null without positions. */
export function pathSteps(cells: OrderCell[], order: number[]): { min: number; max: number; mean: number } | null {
  const by = new Map(cells.map((c) => [c.index, c]));
  const d: number[] = [];
  for (let i = 1; i < order.length; i++) {
    const a = by.get(order[i - 1]);
    const b = by.get(order[i]);
    if (!a || !b || [a.posX, a.posY, b.posX, b.posY].some((x) => typeof x !== "number")) return null;
    d.push(Math.hypot((b.posX as number) - (a.posX as number), (b.posY as number) - (a.posY as number), ((b.posZ ?? 0) as number) - ((a.posZ ?? 0) as number)));
  }
  if (!d.length) return null;
  const r = (x: number) => Math.round(x * 1e4) / 1e4;
  return { min: r(Math.min(...d)), max: r(Math.max(...d)), mean: r(d.reduce((s, x) => s + x, 0) / d.length) };
}

/** A mode's cell order as gma3_patch_type_structure reports it. */
export function cellOrderView(cells: OrderCell[], full: boolean) {
  if (cells.length < 2) return undefined;
  const dmx = dmxOrder(cells);
  if (!dmx) return { dmx: null, note: "a cell's DMX address could not be read: no order is given" };
  const index = cells.map((c) => c.index);
  const differs = dmx.some((x, i) => x !== index[i]);
  const steps = pathSteps(cells, dmx);
  const indexSteps = differs ? pathSteps(cells, index) : null;
  return {
    differsFromCellNumbers: differs,
    dmxRuns: runs(dmx),
    ...(full ? { dmx } : {}),
    ...(steps ? { stepsInDmxOrder: steps } : {}),
    ...(indexSteps ? { stepsInCellNumberOrder: indexSteps } : {}),
    note: differs
      ? `the cells sit along the string in DMX order (${runs(dmx)}), not in cell-number order: lay them out and list them in that order (gma3_layout_cells order: "dmx"; group lists {cells_of: <fid>, order: "dmx"})`
      : "the DMX order is the cell-number order",
  };
}

interface LayoutRead {
  type: { no: number; name: string };
  mode: { no: number; name: string };
  cells: Array<{ index: number }>;
}

/** A fixture's cells in DMX order: the cell indices (1-based, as 401.k) from its type and mode. */
export async function fixtureCellOrder(ctx: ToolContext, fid: number): Promise<{ type: string; mode: string; cells: number; order: number[] }> {
  const lay = (await ctx.bridge.request("patch.cellLayout", { fid }, ctx.requestTimeoutMs)) as LayoutRead;
  if (!lay.cells?.length) throw new Error(`Fixture ${fid} has no cells`);
  const res = (await ctx.bridge.request("patch.typeStructure", { type: lay.type.no, mode: lay.mode.no, geometry: false, channelLimit: 1 }, ctx.requestTimeoutMs)) as { modes?: Array<{ cellList?: OrderCell[] }> };
  const cells = res.modes?.[0]?.cellList ?? [];
  if (cells.length !== lay.cells.length) throw new Error(`Fixture ${fid}: the type lists ${cells.length} cells, the fixture has ${lay.cells.length}`);
  const order = dmxOrder(cells);
  if (!order) throw new Error(`Fixture ${fid}: a cell's DMX address could not be read, so no DMX order can be given`);
  return { type: lay.type.name, mode: lay.mode.name, cells: cells.length, order };
}

/** A fixture-list entry that stands for a fixture's cells: {cells_of: 401, order?: "dmx" | "index", reverse?}. */
export interface CellsOf {
  cells_of: number;
  order?: "dmx" | "index";
  reverse?: boolean;
}
const isCellsOf = (v: unknown): v is CellsOf => !!v && typeof v === "object" && !Array.isArray(v) && "cells_of" in (v as object);

/**
 * Replace every {cells_of} entry in the fixture lists of a group arrangement (fixtures, left, right, rows[i]) with the
 * cell ids it stands for ("401.1", ...), in DMX order (default) or cell-number order. Returns the rewritten
 * arrangement and what each entry resolved to.
 */
export async function resolveCellLists(ctx: ToolContext, arrangement: unknown): Promise<{ arrangement: unknown; resolved: Array<{ cells_of: number; order: string; ids: string }> }> {
  const resolved: Array<{ cells_of: number; order: string; ids: string }> = [];
  if (!arrangement || typeof arrangement !== "object") return { arrangement, resolved };
  const cache = new Map<number, number[]>();
  const expand = async (list: unknown): Promise<unknown> => {
    if (!Array.isArray(list) || !list.some(isCellsOf)) return list;
    const out: unknown[] = [];
    for (const e of list) {
      if (!isCellsOf(e)) {
        out.push(e);
        continue;
      }
      const fid = e.cells_of;
      if (!Number.isInteger(fid) || fid < 1) throw new Error(`cells_of must be a fixture id (got ${JSON.stringify(fid)})`);
      if (e.order !== undefined && e.order !== "dmx" && e.order !== "index") throw new Error(`cells_of ${fid}: order must be "dmx" or "index"`);
      const order = e.order ?? "dmx";
      if (!cache.has(fid)) cache.set(fid, (await fixtureCellOrder(ctx, fid)).order);
      let idx = order === "dmx" ? cache.get(fid)! : [...cache.get(fid)!].sort((a, b) => a - b);
      if (e.reverse === true) idx = [...idx].reverse();
      const ids = idx.map((i) => `${fid}.${i}`);
      resolved.push({ cells_of: fid, order: `${order}${e.reverse ? " reversed" : ""}`, ids: runs(idx).replace(/(\d+)/g, `${fid}.$1`) });
      out.push(...ids);
    }
    return out;
  };
  const a = { ...(arrangement as Record<string, unknown>) };
  for (const k of ["fixtures", "left", "right"]) if (k in a) a[k] = await expand(a[k]);
  if (Array.isArray(a.rows)) a.rows = await Promise.all(a.rows.map((r) => expand(r)));
  return { arrangement: a, resolved };
}
