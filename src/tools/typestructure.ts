/**
 * SU-07: fixture-type structure read-back (SETUP.md SU-07, docs/probes/su-07-type-structure-macos-2.5.1.md).
 *
 *   gma3_patch_type_structure   read-only: per DMX mode the footprint, breaks, cells and every DMX channel (expanded
 *                               per cell, with its attribute); the geometry tree with positions; model dimensions
 *
 * Bridge op `patch.typeStructure` (0.28.0). Console facts (onPC 2.5.1, live 2026-10-15):
 *   - A DMX mode names its root geometry (GeometryDirect). Its cells are the GeometryReference nodes under that root;
 *     they become the patched fixture's SubFixture children (12 on the 52-channel wall washer, 40 on the Festoon's
 *     two-string pixel mode).
 *   - A mode's DMXChannels are templates: a channel on a referenced geometry repeats in every cell, at the cell's
 *     Break DMXPatch offset + its own Coarse - 1; a channel on a geometry inside the root is at its own offset;
 *     Coarse "None" is a virtual channel (an RGB fixture's dimmer). The expansion covers every DMX address of every
 *     mode of the show's five types.
 *   - Positions are metres (raw), rotations degrees; models carry Length / Width / Height in metres.
 */
import { z } from "zod";
import { BridgeError } from "../bridge.js";
import { json, type RegisterTools } from "./context.js";
import { UNITS } from "./positions.js";
import { cellOrderView, type OrderCell } from "./cellorder.js";

type Unit = keyof typeof UNITS;
const UNIT_NAMES = Object.keys(UNITS) as Unit[];

interface GeometryNode {
  index?: number;
  name?: string;
  class?: string;
  depth?: number;
  parent?: string;
  model?: string;
  references?: string;
  [k: string]: unknown;
}
interface ModeStructure {
  name?: string;
  rootGeometry?: string;
  cellList?: Array<Record<string, unknown> & { template?: string }>;
  channels?: Array<Record<string, unknown>>;
  size?: Record<string, unknown>;
  [k: string]: unknown;
}
export interface WheelSlot {
  index: number;
  name?: string;
  color?: { r?: number; g?: number; b?: number; a?: number } | null;
  media?: string;
  appearance?: string;
}
export interface Wheel {
  index: number;
  name?: string;
  slots?: WheelSlot[];
}
export interface WheelFunction {
  mode?: string;
  channel?: string;
  attribute?: string;
  channelFunction?: string;
  logicalChannel?: string;
  wheel?: string;
  /** 8, 16 or 24; null when the bridge could not tell whether the channel has a Fine / Ultra address. */
  bits?: number | null;
  dmxFrom?: string;
  dmxTo?: string;
  channelSets?: Array<{ name?: string; slot?: number | null; dmxFrom?: string; dmxTo?: string }>;
}
export interface TypeStructure {
  type?: Record<string, unknown>;
  modes?: ModeStructure[];
  geometry?: GeometryNode[];
  models?: Array<Record<string, unknown>>;
  wheels?: Wheel[];
  wheelFunctions?: WheelFunction[];
  limitations?: string[];
}

/** A 24-bit hex DMX value as displayed ("0B0B0B") in the channel's resolution (8-bit: 11); null when either is unknown. */
export function dmxAt(hex: string | undefined, bits: number | null | undefined): number | null {
  if (bits !== 8 && bits !== 16 && bits !== 24) return null;
  if (typeof hex !== "string" || !/^[0-9a-f]{1,6}$/i.test(hex.trim())) return null;
  const raw = parseInt(hex.trim(), 16);
  return Math.round((raw * (2 ** bits - 1)) / 16777215);
}

const isWhite = (c: WheelSlot["color"]) => !!c && c.r === 1 && c.g === 1 && c.b === 1;

/**
 * The wheels with each slot's name, colour, media and the channel sets that select it (per mode: channel, attribute,
 * DMX range in the channel's resolution). A colour wheel whose slots all read white has no colours in the type: the
 * note says so, so the slot colours are asked for, not guessed.
 */
export function wheelsView(res: TypeStructure) {
  const fns = res.wheelFunctions ?? [];
  return (res.wheels ?? []).map((w) => {
    const mine = fns.filter((f) => f.wheel === w.name);
    const colorWheel = mine.some((f) => /^color/i.test(f.attribute ?? "")) || /^c\d*$|colou?r/i.test(w.name ?? "");
    const slots = (w.slots ?? []).map((sl) => ({
      index: sl.index,
      name: sl.name,
      color: sl.color ?? null,
      ...(sl.media ? { media: sl.media } : {}),
      ...(sl.appearance ? { appearance: sl.appearance } : {}),
      selectedBy: mine.flatMap((f) =>
        (f.channelSets ?? [])
          .filter((cs) => cs.slot === sl.index)
          .map((cs) => ({ mode: f.mode, channel: f.channel, attribute: f.attribute, channelSet: cs.name, bits: f.bits ?? null, dmxFrom: dmxAt(cs.dmxFrom, f.bits), dmxTo: dmxAt(cs.dmxTo, f.bits) })),
      ),
    }));
    const allWhite = slots.length > 1 && slots.every((sl) => isWhite(sl.color));
    const unreadable = slots.filter((sl) => !sl.color).length;
    const unselected = mine.length ? slots.filter((sl) => !sl.selectedBy.length).map((sl) => sl.index) : [];
    return {
      index: w.index,
      name: w.name,
      kind: colorWheel ? "color" : mine.some((f) => /^gobo/i.test(f.attribute ?? "")) ? "gobo" : "other",
      // Function names are scoped to their logical channel: two channels can each have a "Color1 1" on one wheel.
      functions: [...new Map(mine.map((f) => [`${f.mode}|${f.channel}|${f.logicalChannel ?? ""}|${f.channelFunction}`, { mode: f.mode, channel: f.channel, attribute: f.attribute, channelFunction: f.channelFunction, bits: f.bits ?? null, dmxFrom: dmxAt(f.dmxFrom, f.bits), dmxTo: dmxAt(f.dmxTo, f.bits) }])).values()],
      slotColors: unreadable ? "unreadable" : allWhite ? "unset" : "set",
      slots,
      ...(colorWheel && allWhite ? { note: "every slot reads white: the fixture type carries no slot colours (common in converted grandMA2-library types). Ask what colour each slot is instead of guessing from its name" } : {}),
      ...(unselected.length ? { unselectedSlots: unselected } : {}),
    };
  });
}

const LENGTH_KEYS = ["posX", "posY", "posZ", "length", "width", "height"];
const round = (x: number) => Math.round(x * 1e4) / 1e4;

/** Lengths (metres from the bridge) in `unit`, rounded to 0.1 mm-ish precision in that unit. */
function inUnit<T extends Record<string, unknown>>(row: T, unit: Unit): T {
  const out: Record<string, unknown> = { ...row };
  for (const k of LENGTH_KEYS) if (typeof out[k] === "number") out[k] = round((out[k] as number) / UNITS[unit]);
  for (const k of ["rotX", "rotY", "rotZ"]) if (typeof out[k] === "number") out[k] = round(out[k] as number);
  return out as T;
}

/**
 * The geometry a mode uses: its root and everything below it, plus the templates its cells reference and what is
 * below them. Nodes are matched by name and parent name (geometry names are unique within a type on 2.5.1).
 */
export function modeGeometry(nodes: GeometryNode[], mode: ModeStructure): GeometryNode[] {
  const keep = new Set<string>();
  const children = new Map<string, GeometryNode[]>();
  for (const n of nodes) if (n.parent) children.set(n.parent, [...(children.get(n.parent) ?? []), n]);
  const addTree = (name: string | undefined) => {
    if (!name || keep.has(name)) return;
    keep.add(name);
    for (const c of children.get(name) ?? []) addTree(c.name);
  };
  addTree(mode.rootGeometry);
  for (const c of mode.cellList ?? []) addTree(c.template);
  for (const n of nodes) if (n.class === "GeometryReference" && n.name && keep.has(n.name)) addTree(n.references);
  return nodes.filter((n) => n.name && keep.has(n.name));
}

/** The tool's view of a bridge reply: lengths in `unit`, channels and geometry as requested. */
export function structureView(res: TypeStructure, opts: { unit: Unit; channels: boolean; geometry: "mode" | "all" | "none" }): Record<string, unknown> {
  const modes = (res.modes ?? []).map((m) => {
    const { channels, cellList, size, ...rest } = m;
    return {
      ...rest,
      ...(size ? { size: inUnit(size, opts.unit) } : {}),
      // The per-cell list only with channels or geometry: a summary of a pixel fixture's modes stays small.
      ...(opts.channels || opts.geometry !== "none" ? { cellList: (cellList ?? []).map((c) => inUnit(c, opts.unit)) } : {}),
      ...(opts.channels ? { channels } : {}),
      // SU-19: the physical (DMX) order of the cells; the full list with a mode, the runs in a summary.
      ...(() => {
        const order = cellOrderView((cellList ?? []) as unknown as OrderCell[], (res.modes?.length ?? 0) === 1);
        if (!order) return {};
        const conv = (st: { min: number; max: number; mean: number } | undefined) => (st ? { min: round(st.min / UNITS[opts.unit]), max: round(st.max / UNITS[opts.unit]), mean: round(st.mean / UNITS[opts.unit]) } : undefined);
        const o = order as Record<string, unknown>;
        return { cellOrder: { ...o, ...(o.stepsInDmxOrder ? { stepsInDmxOrder: conv(o.stepsInDmxOrder as never) } : {}), ...(o.stepsInCellNumberOrder ? { stepsInCellNumberOrder: conv(o.stepsInCellNumberOrder as never) } : {}) } };
      })(),
    };
  });
  const out: Record<string, unknown> = { type: res.type, unit: opts.unit, angles: "degrees", modes };
  if (res.wheels) out.wheels = wheelsView(res);
  if (opts.geometry !== "none" && res.geometry) {
    const nodes = opts.geometry === "mode" && res.modes?.length === 1 ? modeGeometry(res.geometry, res.modes[0]) : res.geometry;
    out.geometry = nodes.map((n) => inUnit(n, opts.unit));
    const used = new Set(nodes.map((n) => n.model).filter(Boolean));
    out.models = (res.models ?? []).filter((md) => opts.geometry === "all" || used.has(md.name as string) || modes.some((m) => (m.size as Record<string, unknown> | undefined)?.name === md.name)).map((md) => inUnit(md, opts.unit));
  }
  out.limitations = res.limitations ?? [];
  return out;
}

export const registerTypeStructureTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_patch_type_structure",
    {
      title: "Read a fixture type's structure: modes, cells, channels, geometry, size",
      description:
        "Read-only. One fixture type of the show (number or name, as gma3_patch_types lists it). Per DMX mode: footprint, breaks, the root geometry and its size (the model's length, width, height), the cells (the geometry references a patched fixture's cells come from: name, position, break offset) and, with channels, every DMX channel expanded per cell: break, offset (1-based within the break), fine/ultra offsets, attribute(s), cell, virtual (no DMX address, e.g. an RGB fixture's dimmer). " +
        "addressesUsed counts the footprint's addresses the channels cover; limitations say what could not be established. geometry: the tree as flat nodes (name, class, parent, depth, position, rotation, model, the template a reference points to); with a mode, only the geometry that mode uses. " +
        "Without a mode, every mode is summarised (cells, footprint) and channels and geometry are left out unless asked for (a pixel fixture's full listing is large). Lengths in unit (m default; cm, mm, ft, in), angles in degrees. Needs bridge 0.28.0. " +
        "cellOrder (SU-19): the cells' physical order along the string is their DMX order, which can differ from the cell numbers (the Festoon's 2-string mode: 1-9, 19-29, 10-18, 30-40); stepsInDmxOrder checks it against the type's positions. Use it with gma3_layout_cells order: \"dmx\" and group lists {cells_of: <fid>, order: \"dmx\"}. " +
        "wheels (bridge 0.34.0): each wheel's slots with name, colour, media and the channel sets that select them (mode, channel, attribute, DMX range in the channel's resolution; null when the resolution is unknown); slotColors says set, unset (every slot white: ask, do not guess) or unreadable. No cell order is given from an incompletely readable address.",
      inputSchema: {
        type: z.union([z.number(), z.string()]).describe("Fixture type number or name in the show."),
        mode: z.union([z.number(), z.string()]).optional().describe("DMX mode number or name (default: every mode, summarised)."),
        channels: z.boolean().optional().describe("List the DMX channels (default: true with a mode, false without)."),
        geometry: z.boolean().optional().describe("Include the geometry tree and models (default: true with a mode, false without)."),
        unit: z.enum(UNIT_NAMES as [Unit, ...Unit[]]).optional().describe("Length unit for positions and sizes (default m)."),
        channel_limit: z.number().optional().describe("Most channel rows per mode (default 2000)."),
      },
    },
    async (args) => {
      const withMode = args.mode !== undefined;
      const channels = args.channels ?? withMode;
      const geometry = args.geometry ?? withMode;
      try {
        const res = (await ctx.bridge.request(
          "patch.typeStructure",
          { type: args.type, ...(withMode ? { mode: args.mode } : {}), geometry, ...(args.channel_limit !== undefined ? { channelLimit: args.channel_limit } : {}) },
          ctx.requestTimeoutMs,
        )) as TypeStructure;
        return json(structureView(res, { unit: args.unit ?? "m", channels, geometry: !geometry ? "none" : withMode ? "mode" : "all" }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const old = err instanceof BridgeError && /unknown op/.test(message);
        return { content: [{ type: "text" as const, text: old ? "the console runs an older bridge plugin without patch.typeStructure (needs bridge 0.28.0); update the plugin" : message }], isError: true };
      }
    },
  );
};
