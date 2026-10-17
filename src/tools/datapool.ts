/**
 * Explicit data pool for the pool-object tools (sequences, cues, macros, groups, presets).
 *
 * Without `data_pool` nothing changes: the tools address the current data pool, as before. With it,
 * the tool runs against a bridge that writes `DataPool n` before every pool-object keyword of the
 * references and command lines it sends ("Sequence 5 Cue 1" -> "DataPool 2 Sequence 5 Cue 1"),
 * and resolves the "DataPool.<Pool>" listing paths inside that data pool. The tool code itself is
 * unchanged; only the bridge it is handed differs.
 */
import { z } from "zod";
import type { Gma3Bridge } from "../bridge.js";
import type { ToolContext } from "./context.js";

export const dataPoolShape = {
  data_pool: z
    .number()
    .int()
    .min(1)
    .max(9999)
    .optional()
    .describe("Data pool number (DataPool n). Default: the current data pool, as without this parameter."),
};

/** Keywords of objects that live in a data pool; a reference to one is scoped to the chosen data pool. */
const POOL_KEYWORDS = new Set(["sequence", "macro", "group", "preset", "matricks", "page", "timecode", "world", "filter", "layout", "plugin", "quickey"]);

/**
 * Write `DataPool n` before every data-pool object keyword of a reference or command line, outside
 * quotes, unless it already follows an explicit `DataPool <id>`.
 */
export function scopeText(text: string, dataPool: number): string {
  const tokens = text.match(/"[^"]*"?|'[^']*'?|\s+|[^\s"']+/g) ?? [];
  const words: number[] = [];
  tokens.forEach((t, i) => {
    if (!/^\s/.test(t)) words.push(i);
  });
  for (const [w, i] of words.entries()) {
    if (!POOL_KEYWORDS.has(tokens[i].toLowerCase())) continue;
    const prev = words[w - 1] !== undefined ? tokens[words[w - 1]] : undefined;
    const prev2 = words[w - 2] !== undefined ? tokens[words[w - 2]] : undefined;
    if (prev2 !== undefined && /^datapools?$/i.test(prev2) && prev !== undefined && /^\d+$|^"/.test(prev)) continue;
    tokens[i] = `DataPool ${dataPool} ${tokens[i]}`;
  }
  return tokens.join("");
}

/** Is the bridge one returned by scopedBridge (then: its data pool and the unscoped bridge). */
const SCOPE = Symbol("dataPoolScope");
type Scoped = Gma3Bridge & { [SCOPE]?: { dataPool: number; base: Gma3Bridge } };

/** The bridge that addresses the current data pool (the given one when it is not scoped). */
export function currentPoolBridge(bridge: Gma3Bridge): Gma3Bridge {
  return (bridge as Scoped)[SCOPE]?.base ?? bridge;
}

/** A bridge whose requests address data pool `dataPool`; the given bridge when `dataPool` is undefined. */
export function scopedBridge(bridge: Gma3Bridge, dataPool: number | undefined): Gma3Bridge {
  if (dataPool === undefined) return bridge;
  const base = currentPoolBridge(bridge);
  const poolAddr = new Map<string, Promise<string>>();
  // "DataPool.Sequences" names a child of the current data pool; find the same child of DataPool n by name.
  const childAddr = (name: string, timeoutMs?: number) => {
    const key = name.toLowerCase();
    if (!poolAddr.has(key)) {
      poolAddr.set(
        key,
        (async () => {
          const res = (await base.request("children", { ref: `DataPool ${dataPool}`, fields: [], limit: 100 }, timeoutMs)) as { items?: Array<{ name?: string; addr?: string }> };
          const hit = res?.items?.find((it) => String(it.name ?? "").toLowerCase() === key);
          if (!hit?.addr) throw new Error(`path not found: DataPool ${dataPool} has no ${name}`);
          return hit.addr;
        })(),
      );
      poolAddr.get(key)!.catch(() => poolAddr.delete(key));
    }
    return poolAddr.get(key)!;
  };

  const scopeRef = async (ref: string, timeoutMs?: number): Promise<string> => {
    const dotted = ref.match(/^datapool\.([^.]+)((?:\.\d+)*)$/i);
    if (dotted) return (await childAddr(dotted[1], timeoutMs)) + dotted[2];
    if (/^datapool\./i.test(ref)) throw new Error(`'${ref}' cannot be read in DataPool ${dataPool}; only DataPool.<Pool> paths are scoped`);
    if (/^\d+[\d.]*$/.test(ref) || /^[a-z]+$/i.test(ref) || /^[a-z]+\./i.test(ref)) return ref;
    return scopeText(ref, dataPool);
  };

  const scoped = Object.create(base) as Scoped;
  scoped[SCOPE] = { dataPool, base };
  scoped.request = async function <T = unknown>(op: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    const a: Record<string, unknown> = { ...args };
    if (typeof a.ref === "string") a.ref = await scopeRef(a.ref, timeoutMs);
    if (op === "cmd" && typeof a.command === "string") a.command = scopeText(a.command, dataPool);
    if (op === "preset.context" && a.pool !== undefined) return presetContext(base, dataPool, a, timeoutMs) as Promise<T>;
    return base.request<T>(op, a, timeoutMs);
  } as Gma3Bridge["request"];
  return scoped;
}

/**
 * preset.context reads the preset pool of the current data pool; for another data pool the store
 * preferences come from the bridge op and the pool from an objects read of `DataPool n Preset p`.
 */
async function presetContext(base: Gma3Bridge, dataPool: number, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
  const { pool, ...rest } = args;
  const out = (await base.request("preset.context", rest, timeoutMs)) as Record<string, unknown>;
  const no = Number(pool);
  const res = (await base
    .request("objects", { ref: `DataPool ${dataPool} Preset ${Math.floor(no)}`, fields: ["No", "Name", "PresetMode", "InputFilter"], limit: 1 }, timeoutMs)
    .catch(() => null)) as { items?: Array<{ class?: string; name?: string; index?: number; invalid?: boolean; fields?: Record<string, unknown> }> } | null;
  const h = res?.items?.[0];
  out.pool =
    h && !h.invalid && h.class === "Presets"
      ? { no: Number(h.fields?.No ?? no), exists: true, name: h.fields?.Name ?? h.name, presetMode: h.fields?.PresetMode, inputFilter: h.fields?.InputFilter }
      : { no, exists: false };
  return out;
}

/** The tool context for a call: its bridge addresses `data_pool` when the call gives one. */
export function inDataPool(ctx: ToolContext, args: { data_pool?: unknown }): ToolContext {
  const n = args.data_pool;
  if (n === undefined || n === null) return ctx;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) throw new Error(`data_pool must be a positive integer (got ${JSON.stringify(n)})`);
  return { ...ctx, bridge: scopedBridge(ctx.bridge, n) };
}
