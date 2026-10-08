/**
 * Read helpers shared by workflow tools: existence checks and field read-back through the
 * existing `objects` bridge op. None of these mutate anything.
 */
import { BridgeError, type Gma3Bridge } from "../bridge.js";

export interface ObjectSummary {
  name?: string;
  class?: string;
  addr?: string;
  addrNative?: string;
  index?: number;
  childCount?: number;
  invalid?: boolean;
  fields?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface ObjectsResult {
  total: number;
  offset: number;
  count: number;
  items: ObjectSummary[];
}

export type Existence = { exists: true; object: ObjectSummary } | { exists: false } | { exists: "unknown"; error: string };

/** Is the "no objects found" error the bridge raises when ObjectList() resolves nothing. */
export function isNotFoundError(err: unknown): boolean {
  return err instanceof BridgeError && !err.dispatched && /no objects? found|no object at address|path not found/i.test(err.message);
}

/**
 * Read `fields` of the objects matched by a command-line reference ("Sequence 1 Cue 2").
 * Returns null when nothing matches. Throws on transport or other bridge errors.
 */
export async function readObjects(bridge: Gma3Bridge, ref: string, fields: string[] = [], limit = 50, opts: ReadOptions = {}): Promise<ObjectsResult | null> {
  try {
    return (await bridge.request("objects", { ref, fields, limit, ...(opts.asText === false ? { asText: false } : {}) })) as ObjectsResult;
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

export interface ReadOptions {
  /**
   * Default true: values come back as the editor's display text and handle-typed properties
   * (Object, FixtureType, Preset) as the referenced object's name. With false, handle properties
   * come back as {name, class, addr, index} summaries so callers can compare by address.
   */
  asText?: boolean;
}

/** Read `fields` of one object; null when it does not exist. */
export async function readFields(bridge: Gma3Bridge, ref: string, fields: string[], opts: ReadOptions = {}): Promise<Record<string, unknown> | null> {
  const res = await readObjects(bridge, ref, fields, 1, opts);
  const item = res?.items?.[0];
  if (!item || item.invalid) return null;
  return item.fields ?? {};
}

/** Check whether an object exists without changing anything. Transport trouble yields "unknown". */
export async function exists(bridge: Gma3Bridge, ref: string): Promise<Existence> {
  try {
    const res = await readObjects(bridge, ref, [], 1);
    const item = res?.items?.[0];
    if (!item || item.invalid) return { exists: false };
    return { exists: true, object: item };
  } catch (err) {
    return { exists: "unknown", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Command-line reference for a sequence given by number or name (names are quoted). */
export function sequenceRef(sequence: number | string): string {
  return typeof sequence === "number" ? `Sequence ${sequence}` : `Sequence "${sequence}"`;
}

/** Command-line reference for a cue, optionally a part. */
export function cueRef(sequence: number | string, cue: string, part?: number): string {
  const base = `${sequenceRef(sequence)} Cue ${cue}`;
  return part !== undefined ? `${base} Part ${part}` : base;
}
