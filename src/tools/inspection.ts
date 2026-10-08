/**
 * FR-07 .. FR-10: structured, read-only inspection tools.
 *
 *   gma3_fixture_attributes   attribute discovery for one (sub)fixture        (bridge op `fixtureAttributes`)
 *   gma3_programmer           active programmer content per UI channel        (bridge op `programmer`)
 *   gma3_fixture_output       DMX output per RT channel of one (sub)fixture   (bridge op `fixtureOutput`)
 *   gma3_dmx                  raw universe read over an explicit channel range (bridge op `dmx`)
 *   gma3_cue_contents         stored cue content the 2.5.1 API exposes         (bridge op `cueContents`)
 *
 * Every op is a structured op on the plugin thread: it works with the `lua` op disabled, it only
 * reads, and it never takes the mutation lock. Each result keeps the op's `source`, `limitations`
 * and (where the op scans) `coverage` fields. The console's JSON library cannot carry nil inside a
 * table, so the bridge omits metadata it could not read; this module fills the documented keys of
 * every row with explicit `null` so "unavailable" is visible rather than inferred.
 *
 * Bridge protocol for the five ops is documented in docs/tools/inspection.md ("Bridge protocol
 * additions"). The ops exist from bridge version 0.3.0; an older plugin answers "unknown op".
 */
import { z } from "zod";
import type { Gma3Bridge } from "../bridge.js";
import { BridgeError } from "../bridge.js";
import { json, type RegisterTools, type ToolContext } from "./context.js";
import type { ToolResult } from "../results.js";
import { Validator, ValidationError, cueNumber, describe, finiteNumber, objectNumber, oneOf, partNumber, safeRef } from "../validate.js";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

const WORKS_WITHOUT_LUA = "Works with gma3_lua disabled (structured bridge op, plugin >= 0.3.0). Read-only: never changes selection, programmer or playback. ";

const NULL_NOTE = "fields that are null were not supplied by the console API (explicitly unavailable, not inferred)";

/** Keys every attribute row carries (null when the console did not supply them). */
export const ATTRIBUTE_ROW_KEYS = [
  "uiChannel", "attribute", "attributeIndex", "pretty", "feature", "featureGroup", "activationGroup", "physicalUnit", "readout", "color",
  "channelFunction", "channelFunctions", "dmxFrom", "dmxTo", "default", "physicalFrom", "physicalTo", "realFade", "dmx", "dmxChannel",
] as const;

export const PROGRAMMER_ROW_KEYS = [
  "fixture", "fid", "subfixtureIndex", "uiChannel", "attribute", "attributeIndex", "present", "value", "valueRaw", "relative", "masks", "stepCount", "steps", "phaser", "absPreset", "relPreset",
] as const;

export const OUTPUT_ROW_KEYS = [
  "rtIndex", "channel", "attribute", "attributeIndex", "universe", "address", "coarse", "fine", "ultra", "bits", "patched", "value", "unit", "percent",
  "coarseValue", "fineValue", "ultraValue", "channelFunction", "channelSet", "physical", "physicalFrom", "physicalTo", "physicalUnit", "conversion", "default",
] as const;

export const CUE_KEYS = ["no", "name", "trigType", "trigTime", "trigSound", "release", "assert", "allowDuplicates", "mibPreference", "break", "note", "partCount"] as const;
export const PART_KEYS = ["part", "name", "cuePart", "timing", "command", "mib", "ownDataPresent", "ownNonCookedDataPresent", "memoryType", "recipes", "otherChildren", "storedValues"] as const;
export const PART_TIMING_KEYS = ["cueFade", "cueDelay", "cueInFade", "cueInDelay", "cueOutFade", "cueOutDelay", "snapDelay", "duration", "indivFade", "indivDelay", "transition", "trackingDistance"] as const;
export const RECIPE_KEYS = ["index", "name", "enabled", "selection", "selectionMode", "preset", "presetRef", "presetResolved", "presetDataKey", "values", "fadeX", "delayX", "speedX", "phaseX", "matricks", "filter", "generator"] as const;

type Row = Record<string, unknown>;

/** Return a copy of `row` in which every listed key exists (missing ones as null). */
export function withNulls(row: unknown, keys: readonly string[]): Row {
  const out: Row = {};
  const src = row && typeof row === "object" ? (row as Row) : {};
  for (const k of keys) out[k] = k in src && src[k] !== undefined ? src[k] : null;
  for (const [k, v] of Object.entries(src)) if (!(k in out)) out[k] = v;
  return out;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function stringList(v: unknown): string[] {
  return asArray(v).map((x) => String(x));
}

function isToolResult(v: unknown): v is ToolResult {
  return !!v && typeof v === "object" && Array.isArray((v as ToolResult).content);
}

/** Render a validation failure as an MCP tool error with the collected messages. */
function validationError(tool: string, errors: string[]): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ tool, error: "validation failed", validationErrors: errors }, null, 2) }], isError: true };
}

/** Run a read-only inspection: a thrown bridge error (op error, transport, unknown op) is an MCP tool error. */
async function inspection(tool: string, fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const value = await fn();
    if (isToolResult(value)) return value;
    return json(value);
  } catch (err) {
    let message = err instanceof Error ? err.message : String(err);
    if (err instanceof BridgeError && /unknown op/i.test(message)) {
      message += ". The bridge plugin running in onPC predates the inspection ops (needs gma3_mcp_bridge 0.3.0 or later); re-import and restart the plugin (see docs/tools/inspection.md).";
    }
    return { content: [{ type: "text", text: JSON.stringify({ tool, error: message }, null, 2) }], isError: true };
  }
}

/**
 * A single (sub)fixture reference: a number (fixture ID), "101", "501.3", "Fixture 101" or "Fixture 501.3".
 * Resolved by the console through ObjectList, i.e. by fixture ID, never by patch index.
 */
export function fixtureRef(field: string, value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1) throw new ValidationError(`${field} must be a positive integer fixture ID (got ${describe(value)})`, field);
    return `Fixture ${value}`;
  }
  const v = safeRef(field, value);
  if (/^\d+(\.\d+)*$/.test(v)) return `Fixture ${v}`;
  const m = v.match(/^(fixture|subfixture)\s+(\d+(?:\.\d+)*)$/i);
  if (!m) throw new ValidationError(`${field} must be one fixture such as 101, "501.3" or "Fixture 501.3" (got ${JSON.stringify(v)})`, field);
  return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}`;
}

/**
 * A fixture range in command syntax without groups: "1 Thru 5", "1 + 3", "Fixture 101 Thru 110", "Fixture 4.1".
 * Groups are refused because ObjectList("Group n") yields the group object, not its members.
 */
export function fixtureRange(field: string, value: unknown): string {
  const v = safeRef(field, value).replace(/\s+/g, " ");
  const token = /^(?:Fixture|Thru|\+|-|\d+(?:\.\d+)*)$/i;
  for (const t of v.split(" ")) {
    if (!token.test(t)) throw new ValidationError(`${field} contains an unsupported token ${JSON.stringify(t)}; use fixture IDs with Thru, + and - (groups are not expanded)`, field);
  }
  if (!/\d/.test(v)) throw new ValidationError(`${field} must name at least one fixture ID`, field);
  const body = v.replace(/^Fixture\s+/i, "");
  if (/\bFixture\b/i.test(body)) throw new ValidationError(`${field} may use the Fixture keyword only once, at the start`, field);
  return `Fixture ${body}`;
}

function pageShape(defaultLimit: number, maxLimit: number) {
  return {
    limit: z.number().int().min(1).max(maxLimit).optional().describe(`Maximum rows to return (default ${defaultLimit}, max ${maxLimit}).`),
    offset: z.number().int().min(0).optional().describe("Rows to skip (pagination)."),
  };
}

function pageArgs(v: Validator, args: { limit?: unknown; offset?: unknown }, defaultLimit: number, maxLimit: number) {
  const limit = v.check(() => finiteNumber("limit", args.limit, { integer: true, min: 1, max: maxLimit, optional: true })) ?? defaultLimit;
  const offset = v.check(() => finiteNumber("offset", args.offset, { integer: true, min: 0, optional: true })) ?? 0;
  return { limit, offset };
}

async function op<T = Row>(bridge: Gma3Bridge, name: string, args: Record<string, unknown>, timeoutMs: number): Promise<T> {
  const res = await bridge.request(name, args, timeoutMs);
  if (!res || typeof res !== "object") throw new Error(`bridge op ${name} returned ${describe(res)} instead of an object`);
  return res as T;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const registerInspectionTools: RegisterTools = (server, ctx: ToolContext) => {
  const { bridge } = ctx;
  // Inspection scans can take longer than a single command; give them headroom.
  const timeoutMs = Math.max(ctx.requestTimeoutMs, Math.min(ctx.requestTimeoutMs * 3, 60000));

  // -------------------------------------------------------------------------
  server.registerTool(
    "gma3_fixture_attributes",
    {
      title: "Discover a fixture's attributes",
      description:
        "List the attributes of one fixture or subfixture with stable identifiers (attribute name, attributeIndex, uiChannel), pretty name, feature/feature group, activation group, " +
        "physical unit, natural readout, the channel function's DMX and physical ranges, defaults, optional channel sets, and the DMX address mapping (coarse/fine/ultra as universe.address) from the RT channels. " +
        "Subfixtures of a compound fixture are listed explicitly (`subfixtures[]`, with their patch index); pass `Fixture 501.3` to inspect one. " +
        WORKS_WITHOUT_LUA +
        "The fixture is resolved by fixture ID through the console (patch index is reported separately as subfixtureIndex, never assumed equal). " +
        "`source` says whether rows came from the UI channel API (\"uiChannels\") or the static fixture-type walk (\"fixtureTypeWalk\", no uiChannel). " +
        "Null fields were not supplied by the console (explicitly unavailable, never inferred). Results are paginated. Not available: current values (use gma3_programmer / gma3_fixture_output).",
      inputSchema: {
        fixture: z.union([z.number(), z.string()]).describe('Fixture ID (101), subfixture ("501.3") or command reference ("Fixture 501.3"). One (sub)fixture only.'),
        include_channel_sets: z.boolean().optional().describe("Include each channel function's ChannelSets (named ranges such as gobo slots). Default false."),
        ...pageShape(100, 500),
      },
    },
    async (args) =>
      inspection("gma3_fixture_attributes", async () => {
        const v = new Validator();
        const ref = v.check(() => fixtureRef("fixture", args.fixture));
        const { limit, offset } = pageArgs(v, args, 100, 500);
        if (!v.ok || !ref) return validationError("gma3_fixture_attributes", v.errors);
        const includeSets = args.include_channel_sets === true;
        const res = await op(bridge, "fixtureAttributes", { ref, limit, offset, includeChannelSets: includeSets }, timeoutMs);
        const keys = includeSets ? [...ATTRIBUTE_ROW_KEYS, "channelSets"] : [...ATTRIBUTE_ROW_KEYS];
        return {
          tool: "gma3_fixture_attributes",
          ref,
          ...res,
          attributes: asArray(res.attributes).map((row) => withNulls(row, keys)),
          subfixtures: asArray(res.subfixtures),
          channels: asArray(res.channels),
          source: res.source ?? null,
          limitations: stringList(res.limitations),
          notes: [NULL_NOTE, "programmer and output values are not part of discovery; use gma3_programmer and gma3_fixture_output", "selection and programmer were not changed"],
        };
      }),
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    "gma3_programmer",
    {
      title: "Inspect the programmer",
      description:
        "Structured view of active programmer values per UI channel (fixture, subfixture patch index, attribute, value, timing, phaser steps). Scope is explicit: `all` (every patched (sub)fixture, including unselected ones), " +
        "`selection` (SelectionTable) or `fixtures` (an explicit range). " +
        WORKS_WITHOUT_LUA +
        "ROWS ARE PROGRAMMER CONTENT, NOT OUTPUT VALUES (source \"programmer\"; use gma3_fixture_output/gma3_dmx for output). " +
        "A row is emitted only when the console's activity masks show programmer data; `value: 0` with `present: true` is a real zero, an absent row means no programmer value. " +
        "Multi-step phasers keep every step in `steps[]` (value is null) with phaser-level fade/delay/speed/phase; `phaser.supported` is false with a reason when the API shape was unusable. " +
        "`coverage` reports whether the scan was complete; when it is not (budget reached, API unavailable) the programmer is NOT claimed empty. Paginated. `value` is percent, `valueRaw` the 24-bit integer.",
      inputSchema: {
        scope: z.enum(["all", "selection", "fixtures"]).describe("all = every patched (sub)fixture; selection = current selection; fixtures = the `fixtures` range."),
        fixtures: z.string().optional().describe('Required for scope "fixtures": fixture IDs/ranges such as "1 Thru 5", "101 + 103", "Fixture 501.3". Groups are not expanded.'),
        max_channels: z.number().int().min(1).max(50000).optional().describe("Scan budget in UI channels per request (default 5000). The scan stops when reached and coverage.complete is false."),
        ...pageShape(200, 5000),
      },
    },
    async (args) =>
      inspection("gma3_programmer", async () => {
        const v = new Validator();
        const scope = v.check(() => oneOf("scope", args.scope, ["all", "selection", "fixtures"] as const));
        let fixtures: string | undefined;
        if (scope === "fixtures") {
          if (args.fixtures === undefined || args.fixtures === null || args.fixtures === "") v.fail('fixtures is required when scope is "fixtures"');
          else fixtures = v.check(() => fixtureRange("fixtures", args.fixtures));
        } else if (args.fixtures !== undefined && args.fixtures !== null && args.fixtures !== "") {
          v.fail(`fixtures is only accepted with scope "fixtures" (scope is ${JSON.stringify(scope)})`);
        }
        const maxChannels = v.check(() => finiteNumber("max_channels", args.max_channels, { integer: true, min: 1, max: 50000, optional: true })) ?? 5000;
        const { limit, offset } = pageArgs(v, args, 200, 5000);
        if (!v.ok || !scope) return validationError("gma3_programmer", v.errors);
        const res = await op(bridge, "programmer", { scope, fixtures, limit, offset, maxChannels }, timeoutMs);
        const coverage = (res.coverage && typeof res.coverage === "object" ? res.coverage : { complete: false }) as Row;
        const limitations = stringList(res.limitations);
        if (coverage.complete !== true && !limitations.some((l) => /coverage|budget|enumerat|failed/i.test(l))) {
          limitations.push("coverage is incomplete: the result does not prove the programmer is empty for the unscanned part of the scope");
        }
        return {
          tool: "gma3_programmer",
          ...res,
          source: res.source ?? "programmer",
          coverage: { complete: coverage.complete === true, ...coverage },
          rows: asArray(res.rows).map((row) => withNulls(row, PROGRAMMER_ROW_KEYS)),
          limitations,
          notes: [
            "rows are programmer values, not output; output is read with gma3_fixture_output or gma3_dmx",
            "value is percent (absolute), valueRaw the console's 24-bit integer; multi-step phasers have value null and all steps in steps[]",
            NULL_NOTE,
            "selection, programmer and playback were not changed",
          ],
        };
      }),
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    "gma3_fixture_output",
    {
      title: "Inspect a fixture's DMX output",
      description:
        "Current DMX output of one fixture or subfixture per RT channel: channel name, attribute, universe.address, raw value (8-bit per address, combined to 16/24-bit when fine/ultra addresses exist; `bits` and `unit` say which), " +
        "derived percent, and where the fixture type's channel function is known a physical value (`conversion: \"linear from channel function\"`) and the active channel set. " +
        WORKS_WITHOUT_LUA +
        "Source is \"dmx output\": these are output levels, NOT programmer values. Not available: per-attribute cooked output (the API has none), " +
        "values on a universe that is not granted on this onPC (value null plus a limitation). `nonzero_only` is an explicit filter (default false). Paginated.",
      inputSchema: {
        fixture: z.union([z.number(), z.string()]).describe('Fixture ID (101), subfixture ("501.3") or command reference ("Fixture 501.3").'),
        nonzero_only: z.boolean().optional().describe("Only return channels whose raw value is not zero (default false; channels with unknown value are kept)."),
        ...pageShape(200, 2000),
      },
    },
    async (args) =>
      inspection("gma3_fixture_output", async () => {
        const v = new Validator();
        const ref = v.check(() => fixtureRef("fixture", args.fixture));
        const { limit, offset } = pageArgs(v, args, 200, 2000);
        if (!v.ok || !ref) return validationError("gma3_fixture_output", v.errors);
        const nonzeroOnly = args.nonzero_only === true;
        const res = await op(bridge, "fixtureOutput", { ref, nonzeroOnly, limit, offset }, timeoutMs);
        return {
          tool: "gma3_fixture_output",
          ref,
          ...res,
          source: res.source ?? "dmx output",
          nonzeroOnly,
          channels: asArray(res.channels).map((row) => withNulls(row, OUTPUT_ROW_KEYS)),
          limitations: stringList(res.limitations),
          notes: [
            "value is the raw DMX output of the RT channel (unit raw8/raw16/raw24 per row); percent is derived; physical is a linear conversion over the channel function range",
            "these are output values, not programmer values (use gma3_programmer for the programmer)",
            NULL_NOTE,
            "selection, programmer and playback were not changed",
          ],
        };
      }),
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    "gma3_dmx",
    {
      title: "Read DMX output of a universe",
      description:
        "Raw DMX output for an explicit universe and channel range (channels 1..512; universe 1..1024, further bounded by the console's universe count). `unit` is explicit: \"raw8\" (0..255 per address) or \"percent\" (0..100 as the console converts it). " +
        WORKS_WITHOUT_LUA +
        "Source is \"dmx output\": output levels, NOT programmer values. A universe that is not granted on this onPC returns no values with `granted: false` and a limitation (never zeros). " +
        "`nonzero_only` is an explicit filter. `patched: true` additionally maps each returned address to its fixture/channel through the RT channels (bounded; stated in limitations when skipped). 16-bit attributes appear as two separate 8-bit addresses.",
      inputSchema: {
        universe: z.number().int().describe("DMX universe number (1..1024)."),
        from: z.number().int().describe("First channel (1..512)."),
        to: z.number().int().optional().describe("Last channel (1..512, >= from). Default: same as from."),
        nonzero_only: z.boolean().optional().describe("Only return addresses whose value is not zero (default false)."),
        unit: z.enum(["raw8", "percent"]).optional().describe("raw8 (default): 0..255 per address. percent: 0..100 as converted by the console."),
        patched: z.boolean().optional().describe("Map each returned address to fixture ID / channel name via the RT channels (default false)."),
      },
    },
    async (args) =>
      inspection("gma3_dmx", async () => {
        const v = new Validator();
        const universe = v.check(() => finiteNumber("universe", args.universe, { integer: true, min: 1, max: 1024 }));
        const from = v.check(() => finiteNumber("from", args.from, { integer: true, min: 1, max: 512 }));
        const to = v.check(() => finiteNumber("to", args.to, { integer: true, min: 1, max: 512, optional: true })) ?? from;
        if (from !== undefined && to !== undefined && to < from) v.fail(`to must be >= from (got from ${from}, to ${to})`);
        const unit = v.check(() => oneOf("unit", args.unit, ["raw8", "percent"] as const, { optional: true })) ?? "raw8";
        if (!v.ok || universe === undefined || from === undefined || to === undefined) return validationError("gma3_dmx", v.errors);
        const nonzeroOnly = args.nonzero_only === true;
        const patched = args.patched === true;
        const res = await op(bridge, "dmx", { universe, from, to, nonzeroOnly, percent: unit === "percent", patched }, timeoutMs);
        return {
          tool: "gma3_dmx",
          ...res,
          source: res.source ?? "dmx output",
          unit: res.unit ?? unit,
          granted: res.granted === undefined ? null : res.granted,
          patched: res.patched === undefined ? null : res.patched,
          nonzeroOnly,
          values: asArray(res.values),
          limitations: stringList(res.limitations),
          notes: [
            unit === "percent" ? "values are percent 0..100 as converted by the console (8-bit precision per address)" : "values are raw 8-bit DMX 0..255 per address",
            "these are output values, not programmer values",
            "selection, programmer and playback were not changed",
          ],
        };
      }),
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    "gma3_cue_contents",
    {
      title: "Inspect stored cue content",
      description:
        "Read what a cue stores without playing it back or loading it: cue properties (No, Name, TrigType, TrigTime, TrigSound, Release, Assert, Note), per part the timing (CueFade, CueDelay, CueInFade, CueInDelay, CueOutFade, CueOutDelay, SnapDelay), command, MIB settings, " +
        "OwnDataPresent, and the recipes (selection, preset text plus the resolved preset reference or an explicit unresolved marker, values, FadeX/DelayX/SpeedX/PhaseX, enabled). `expand_presets: true` adds the referenced presets' data (GetPresetData) keyed by preset address. " +
        WORKS_WITHOUT_LUA +
        "SUPPORTED MODE (onPC 2.5.1): recipe- and preset-based content only. NOT AVAILABLE: hard (non-recipe) fixture values stored in a part (`storedValues` is always null; a limitation is added when OwnDataPresent is Yes) and tracked/effective values (`trackedValues: \"not_reconstructed\"`; a part lists only what it stores). " +
        "The `fixtures` filter applies to expanded preset data only (stated in limitations). Never sends Goto, Load or any playback command.",
      inputSchema: {
        sequence: z.union([z.number(), z.string()]).describe("Sequence number (or exact name)."),
        cue: z.union([z.number(), z.string()]).describe("Cue number, e.g. 1, 2.5 or \"10.001\"."),
        part: z.number().int().optional().describe("Only this part (0..999). Default: all parts."),
        fixtures: z.string().optional().describe('Fixture IDs/ranges ("1 Thru 5") to filter expanded preset data by fixture ID. Recipe selections are not expanded.'),
        expand_presets: z.boolean().optional().describe("Read referenced presets with GetPresetData and include their flattened rows (default false)."),
      },
    },
    async (args) =>
      inspection("gma3_cue_contents", async () => {
        const v = new Validator();
        let sequence: number | string | undefined;
        if (typeof args.sequence === "number") sequence = v.check(() => objectNumber("sequence", args.sequence));
        else if (typeof args.sequence === "string" && /^\s*\d+\s*$/.test(args.sequence)) sequence = v.check(() => objectNumber("sequence", Number(args.sequence)));
        else sequence = v.check(() => safeRef("sequence", args.sequence));
        const cue = v.check(() => cueNumber("cue", args.cue, { allowZero: true }));
        const part = v.check(() => partNumber("part", args.part, { optional: true }));
        const fixtures = args.fixtures === undefined || args.fixtures === null || args.fixtures === "" ? undefined : v.check(() => fixtureRange("fixtures", args.fixtures));
        if (!v.ok || sequence === undefined || cue === undefined) return validationError("gma3_cue_contents", v.errors);
        const expandPresets = args.expand_presets === true;
        const res = await op(bridge, "cueContents", { sequence, cue, part, fixtures, expandPresets }, timeoutMs);
        const parts = asArray(res.parts).map((p) => {
          const row = withNulls(p, PART_KEYS);
          row.timing = withNulls(row.timing, PART_TIMING_KEYS);
          row.command = withNulls(row.command, ["text", "delay", "enabled"]);
          row.mib = withNulls(row.mib, ["mode", "target", "fade", "delay"]);
          row.recipes = asArray(row.recipes).map((r) => withNulls(r, RECIPE_KEYS));
          row.otherChildren = asArray(row.otherChildren);
          row.storedValues = null;
          return row;
        });
        return {
          tool: "gma3_cue_contents",
          target: { sequence, cue, part: part ?? null, fixtures: fixtures ?? null },
          supportedMode: "recipes and preset references (onPC 2.5.1); hard stored values and tracked values are not readable",
          ...res,
          source: res.source ?? "cue object tree",
          cue: withNulls(res.cue, CUE_KEYS),
          parts,
          presets: expandPresets ? (res.presets && typeof res.presets === "object" ? res.presets : {}) : null,
          trackedValues: "not_reconstructed",
          limitations: stringList(res.limitations),
          notes: [
            "storedValues is always null: hard (non-recipe) values in a cue part are not exposed by the 2.5.1 Lua API",
            "trackedValues is not_reconstructed: a part lists only what it stores; tracked values from earlier cues are absent",
            NULL_NOTE,
            "no Goto, Load or playback command was sent; selection and programmer were not changed",
          ],
        };
      }),
  );
};
