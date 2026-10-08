#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Gma3Bridge, BridgeError, BridgeUnreachableError } from "./bridge.js";
import { OscSender } from "./osc.js";
import { helpDir, helpVersion, listHelpPages, lookupHelp } from "./help.js";
import { CHEATSHEET } from "./cheatsheet.js";
import { MutationLock } from "./mutations.js";
import type { ToolContext } from "./tools/context.js";
import { registerFixtureTools } from "./tools/fixtures.js";
import { registerCueTools } from "./tools/cues.js";
import { registerExecutorTools } from "./tools/executors.js";
import { registerInspectionTools } from "./tools/inspection.js";

const env = process.env;
const bridge = new Gma3Bridge({
  host: env.GMA3_BRIDGE_HOST ?? "127.0.0.1",
  port: Number(env.GMA3_BRIDGE_PORT ?? 9800),
  requestTimeoutMs: Number(env.GMA3_BRIDGE_TIMEOUT_MS ?? 15000),
});
const osc = new OscSender({
  host: env.GMA3_OSC_HOST ?? "127.0.0.1",
  port: Number(env.GMA3_OSC_PORT ?? 8000),
  prefix: env.GMA3_OSC_PREFIX?.replace(/^\/+|\/+$/g, "") || undefined,
});

const server = new McpServer({ name: "gma3-mcp", version: "0.1.0" });

// Arbitrary Lua execution is a separately gated capability. The console-side switch (the plugin's
// "lua" start argument, off by default) is the enforcement point; GMA3_ALLOW_LUA=0 additionally hides
// the gma3_lua tool from this server so a deployment can rule it out regardless of console state.
const allowLuaTool = !/^(0|false|no|off)$/i.test((env.GMA3_ALLOW_LUA ?? "1").trim());

// Mutations issued by this server are serialised (FR-03): a multi-command workflow such as
// select -> set attribute -> store must not interleave with another tool call's command. The
// existing single-command mutation tools and gma3_lua (arbitrary code cannot be classified as
// read-only) take the same lock so a workflow is never split by them. This orders only this
// process's own requests; it does not isolate anything from another console operator or client.
const mutations = new MutationLock();
const toolContext: ToolContext = {
  bridge,
  mutations,
  requestTimeoutMs: Number(env.GMA3_BRIDGE_TIMEOUT_MS ?? 15000),
  luaToolAllowed: allowLuaTool,
};

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function text(value: unknown): ToolResult {
  const t = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text: t }] };
}

function errorResult(err: unknown): ToolResult {
  let msg = err instanceof Error ? err.message : String(err);
  if (err instanceof BridgeError && !bridge.connected) {
    msg +=
      `\n\nThe gma3_mcp_bridge plugin does not seem to be running in grandMA3 onPC (${bridge.description}). ` +
      `Start it in the onPC command line with:  Plugin "gma3_mcp_bridge"  ` +
      `(or call gma3_start_bridge if OSC input is enabled). Use gma3_status to check.`;
  }
  return { content: [{ type: "text", text: msg }], isError: true };
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return text(await fn());
  } catch (err) {
    return errorResult(err);
  }
}

const refSchema = z
  .string()
  .describe(
    'Object reference. Either command-line object syntax ("Sequence 1", "Sequence 1 Cue 3", "Fixture 101", "Group 5", "Macro 2", "Page 1.201"), ' +
      'a dotted show-data path from a root ("DataPool.Sequences", "Root.ShowData", "Patch.Fixtures"), ' +
      'a numeric address like "14.14.1.6.1", or one of: Root, ShowData, DataPool, SelectedSequence, CurrentCue, Patch, Programmer, Selection, CurrentExecPage.',
  );

// ---------------------------------------------------------------------------
// Connection / status
// ---------------------------------------------------------------------------

server.registerTool(
  "gma3_status",
  {
    title: "grandMA3 connection status",
    description:
      "Check whether the gma3_mcp_bridge plugin inside grandMA3 onPC is reachable and report software version, show file, user, " +
      "the Lua execution policy (whether gma3_lua is enabled on the console and its per-request time/instruction budget), and the configured OSC fallback.",
    inputSchema: {},
  },
  async () => {
    const result: Record<string, unknown> = {
      bridge: { address: bridge.description, connected: false },
      osc: { address: osc.description },
      help: { dir: helpDir(), version: helpVersion() },
    };
    try {
      const ping = await bridge.request("ping", {}, 4000);
      result.bridge = { address: bridge.description, connected: true, ...(ping as object) };
    } catch (err) {
      result.bridge = {
        address: bridge.description,
        connected: false,
        error: err instanceof Error ? err.message : String(err),
        hint: 'In grandMA3 onPC run:  Plugin "gma3_mcp_bridge"   (install first with scripts/install-plugin.sh and Import Plugin Library "gma3_mcp_bridge.xml")',
      };
    }
    return text(result);
  },
);

server.registerTool(
  "gma3_start_bridge",
  {
    title: "Start the bridge plugin via OSC",
    description:
      'Fallback for when the bridge is not running: sends the command  Plugin "gma3_mcp_bridge"  to onPC over OSC (/cmd). ' +
      "Requires the OSC configuration in onPC (Menu > In & Out > OSC) to have Enable Input on and Receive Command = Yes on a line matching GMA3_OSC_PORT. " +
      "Then waits briefly and pings the bridge.",
    inputSchema: {},
  },
  async () =>
    run(async () => {
      await osc.sendCommand('Plugin "gma3_mcp_bridge"');
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const ping = await bridge.request("ping", {}, 4000);
        return { started: true, ping };
      } catch (err) {
        return {
          started: false,
          sentVia: osc.description,
          error: err instanceof Error ? err.message : String(err),
          hint: "If this keeps failing, OSC input is probably not enabled; start the plugin manually in onPC.",
        };
      }
    }),
);

// ---------------------------------------------------------------------------
// Command line and Lua
// ---------------------------------------------------------------------------

server.registerTool(
  "gma3_command",
  {
    title: "Execute a grandMA3 command",
    description:
      "Execute a grandMA3 command-line command exactly as it would be typed (without Please/Enter). " +
      'Examples: "Go+ Sequence 1", "Fixture 1 Thru 10 At 50", "Store Cue 2 /Merge /NoConfirmation", "ClearAll", "FaderMaster Page 1.201 At 75 Fade 2". ' +
      "Returns the command line feedback (OK, Syntax Error, Illegal Command). Commands that produce output (List, etc.) print to the console history, not here; use gma3_get_object / gma3_list_children to read data. " +
      'Via "osc" the command is sent fire-and-forget over OSC and no feedback is available.',
    inputSchema: {
      command: z.string().describe("The command, e.g. 'Go+ Sequence 1'"),
      via: z
        .enum(["auto", "bridge", "osc"])
        .optional()
        .describe(
          "Transport. auto (default) uses the bridge and falls back to OSC only if the bridge cannot be reached before the command is sent. " +
            "If the bridge accepted the command but no reply came back, the command is NOT resent (it may already have executed); the error says so.",
        ),
    },
  },
  async ({ command, via }) =>
    run(() => mutations.run(async () => {
      const mode = via ?? "auto";
      if (mode !== "osc") {
        try {
          return await bridge.request("cmd", { command });
        } catch (err) {
          if (mode === "bridge") throw err;
          if (err instanceof BridgeError && err.dispatched) {
            // The command reached the bridge (or may have). Re-sending it over OSC could
            // execute it twice (e.g. Go+ advancing two cues), so report instead of retrying.
            throw new BridgeError(
              `${err.message}. The command was sent to the bridge but its outcome is unknown; it was NOT resent over OSC to avoid executing it twice. ` +
                `Inspect the console state with a read-only query (gma3_sequences, gma3_get_object) before resending, or call again with via "osc" if you are sure it did not run.`,
              err.op,
              true,
            );
          }
          if (!(err instanceof BridgeUnreachableError)) throw err;
          // Nothing was sent to the bridge: safe to fall back to OSC.
          await osc.sendCommand(command);
          return { command, sentVia: `osc ${osc.description}`, feedback: null, note: "bridge unreachable, sent over OSC without feedback" };
        }
      }
      await osc.sendCommand(command);
      return { command, sentVia: `osc ${osc.description}`, feedback: null };
    })),
);

if (allowLuaTool) {
  server.registerTool(
    "gma3_lua",
    {
      title: "Run Lua inside grandMA3",
      description:
        "Evaluate Lua 5.4 code inside the grandMA3 Lua engine and return the result(s) as JSON. The code is first compiled as an expression ('return <code>'), then as a statement block. " +
        "All grandMA3 Lua API functions are available (Cmd, ObjectList, DataPool, Root, ShowData, Patch, Programmer, SelectedSequence, GetCurrentCue, GetExecutor, GetVar/SetVar, Printf, Echo, Enums, ...). " +
        "Object handles are returned as {name, class, addr, addrNative, index, childCount}; use handle:Get('Prop') to read properties, :Children(), :Count(), :Ptr(i). " +
        "Examples: 'SelectedSequence().name', 'GetCurrentCue():Get(\"No\")', 'DataPool().Sequences:Count()', " +
        "'local t={} for i,c in ipairs(ObjectList(\"Fixture Thru\")) do t[#t+1]=c.name end return t'. Use gma3_lua_api to look up function signatures. " +
        "This capability is OFF by default on the console: the operator enables it by starting the bridge with  Plugin \"gma3_mcp_bridge\" \"lua\"  or running  Plugin \"gma3_mcp_bridge\" \"lua on\"  (gma3_status shows the policy). " +
        "Each request runs under the console's execution budget (default 5 s wall-clock / 20 M VM instructions, operator-configurable) and is aborted with an error when it exceeds it, so keep scripts short and prefer the structured tools (gma3_get_object, gma3_list_children, gma3_objects) for bulk reads. " +
        "By default the console's own hook on the plugin thread is preserved, which means the instruction budget is NOT enforced and the deadline is only checked when the script yields or returns: a script that loops without yielding cannot be stopped (gma3_status shows lua.bounded; the result's budget.instructionHookEnforced says what applied). The operator can start the bridge with luahook=replace to enforce hard quotas. " +
        "Because a script may call Cmd() or Set(), every gma3_lua request is serialised with this server's other mutations (it waits for a running workflow and blocks later ones while it runs).",
      inputSchema: {
        code: z.string().describe("Lua code to evaluate"),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Request timeout (default 15000). Also passed to the console as the wall-clock execution budget, capped by the console's own limit, so the code stops when the client stops waiting."),
      },
    },
    async ({ code, timeout_ms }) => {
      const timeout = timeout_ms ?? Number(env.GMA3_BRIDGE_TIMEOUT_MS ?? 15000);
      // The console aborts the script at `timeout` and then has to encode and send the error; wait a
      // little longer than that so the budget message reaches the client instead of a bare timeout.
      // Arbitrary Lua may call Cmd() or Set(); it cannot be classified as read-only, so the whole
      // request is serialised with this server's other mutations.
      return run(() => mutations.run(() => bridge.request("lua", { code, maxMs: timeout }, timeout + 1000)));
    },
  );
}

server.registerTool(
  "gma3_lua_api",
  {
    title: "Search the grandMA3 Lua API",
    description:
      "Search the live grandMA3 Lua API descriptor (function name, arguments, return values) for both object-free functions (Cmd, ObjectList, …) and object methods (Get, Children, SetFader, …). " +
      "Leave query empty to list everything.",
    inputSchema: {
      query: z.string().optional().describe("Case-insensitive substring to match against names, arguments and returns"),
      kind: z.enum(["all", "free", "object"]).optional(),
    },
  },
  async ({ query, kind }) =>
    run(async () => {
      const api = await getApi();
      const q = (query ?? "").toLowerCase();
      const pick = (list: ApiEntry[]) => (q ? list.filter((e) => JSON.stringify(e).toLowerCase().includes(q)) : list);
      const out: Record<string, unknown> = {};
      if (kind !== "object") out.objectFree = pick(api.free);
      if (kind !== "free") out.objectMethods = pick(api.object);
      return out;
    }),
);

type ApiEntry = { function_name?: string; arguments?: string; return_values?: string } | unknown[];
let apiCache: { free: ApiEntry[]; object: ApiEntry[] } | null = null;
async function getApi() {
  if (apiCache) return apiCache;
  const raw = (await bridge.request("api", {}, 20000)) as { free: unknown; object: unknown };
  const norm = (v: unknown): ApiEntry[] => {
    if (!Array.isArray(v)) return [];
    return v.map((e) => {
      if (Array.isArray(e)) return { function_name: String(e[0] ?? ""), arguments: String(e[1] ?? ""), return_values: String(e[2] ?? "") };
      return e as ApiEntry;
    });
  };
  apiCache = { free: norm(raw.free), object: norm(raw.object) };
  return apiCache;
}

// ---------------------------------------------------------------------------
// Generic object access
// ---------------------------------------------------------------------------

server.registerTool(
  "gma3_get_object",
  {
    title: "Read a show object",
    description:
      "Read an object from the show data: name, class, address, all properties (as display text), optionally the property schema and a listing of its children. " +
      "Use this to inspect sequences, cues, executors, fixtures, presets, groups, macros, pages, settings, etc.",
    inputSchema: {
      ref: refSchema,
      children: z.boolean().optional().describe("Include a listing of child objects (default false)"),
      child_fields: z.array(z.string()).optional().describe("Property names to include for each child"),
      child_limit: z.number().int().positive().optional(),
      child_offset: z.number().int().nonnegative().optional(),
      schema: z.boolean().optional().describe("Include property schema (name, type, readOnly, enum)"),
      properties: z.boolean().optional().describe("Include property values (default true)"),
    },
  },
  async ({ ref, children, child_fields, child_limit, child_offset, schema, properties }) =>
    run(() =>
      bridge.request("object", {
        ref,
        children: children ?? false,
        childFields: child_fields,
        childLimit: child_limit,
        childOffset: child_offset,
        schema: schema ?? false,
        properties: properties ?? true,
      }),
    ),
);

server.registerTool(
  "gma3_list_children",
  {
    title: "List child objects",
    description:
      "List the children of an object (e.g. cues of a sequence, items of a pool, executors of a page) with name, class, address and index, plus optional property values per child. Paginated.",
    inputSchema: {
      ref: refSchema,
      fields: z.array(z.string()).optional().describe("Property names to read for each child, e.g. ['No','Name','TrigType','TrigTime']"),
      limit: z.number().int().positive().optional().describe("Max items (default 200)"),
      offset: z.number().int().nonnegative().optional(),
    },
  },
  async ({ ref, fields, limit, offset }) => run(() => bridge.request("children", { ref, fields, limit, offset })),
);

server.registerTool(
  "gma3_objects",
  {
    title: "Resolve an object range",
    description:
      "Resolve a command-line object range to a list of objects with optional property values. " +
      'Examples: "Fixture 1 Thru 20", "Fixture Thru" (all fixtures), "Group Thru", "Sequence 1 Thru 10", "Preset 4.1 Thru 4.20", "Page 1.201 Thru 1.215".',
    inputSchema: {
      ref: z.string().describe("Command-line object range"),
      fields: z.array(z.string()).optional().describe("Property names to read for each object"),
      limit: z.number().int().positive().optional().describe("Max items (default 500)"),
      offset: z.number().int().nonnegative().optional(),
    },
  },
  async ({ ref, fields, limit, offset }) => run(() => bridge.request("objects", { ref, fields, limit, offset }, 30000)),
);

server.registerTool(
  "gma3_dump",
  {
    title: "Dump an object",
    description: "Return the raw grandMA3 Dump() text for an object: class, path, every property and child. Verbose; prefer gma3_get_object for structured data.",
    inputSchema: { ref: refSchema },
  },
  async ({ ref }) => run(() => bridge.request("dump", { ref })),
);

server.registerTool(
  "gma3_set_property",
  {
    title: "Set an object property",
    description:
      "Set a property of a show object via the Lua Set() API, e.g. ref 'Sequence 1', property 'Name' or 'Tracking'; ref 'Sequence 1 Cue 2', property 'TrigTime'. " +
      "Values are passed as text the way they would be typed in the editor (e.g. 'Yes', 'No', '2.5', 'Follow'). This modifies the show file.",
    inputSchema: {
      ref: refSchema,
      property: z.string(),
      value: z.union([z.string(), z.number(), z.boolean()]),
    },
  },
  async ({ ref, property, value }) => run(() => mutations.run(() => bridge.request("set", { ref, property, value }))),
);

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

const playbackActions = {
  go: "Go+",
  goback: "Go-",
  pause: "Pause",
  off: "Off",
  on: "On",
  toggle: "Toggle",
  top: "Top",
  flash: "Flash",
  load: "Load",
  select: "Select",
  release: "Release",
  learn: "Learn",
  rate1: "Rate1",
  speed1: "Speed1",
} as const;

server.registerTool(
  "gma3_playback",
  {
    title: "Playback control",
    description:
      "Trigger a playback function on a sequence or executor. Equivalent to commands like 'Go+ Sequence 1', 'Off Executor 201', 'Load Sequence 1 Cue 5'. " +
      "Targets: 'Sequence 3', 'Executor 201', 'Page 2.201', 'Sequence 1 Cue 4' (for load/go to a cue), 'Master 3.1', 'Macro 5', 'Group 2'.",
    inputSchema: {
      action: z.enum(Object.keys(playbackActions) as [keyof typeof playbackActions, ...(keyof typeof playbackActions)[]]),
      target: z.string().describe("Object the action applies to, e.g. 'Sequence 1' or 'Executor 201'"),
      fade: z.number().nonnegative().optional().describe("Optional fade time in seconds (appends 'Fade <s>')"),
    },
  },
  async ({ action, target, fade }) =>
    run(() =>
      mutations.run(() => {
        const cmd = `${playbackActions[action]} ${target}${fade !== undefined ? ` Fade ${fade}` : ""}`;
        return bridge.request("cmd", { command: cmd });
      }),
    ),
);

server.registerTool(
  "gma3_set_fader",
  {
    title: "Set a fader",
    description:
      "Set a fader of a playback object (sequence, executor's assigned object, master) to a value 0..100 via the Lua SetFader API. " +
      "Tokens: FaderMaster (default), FaderX, FaderXA, FaderXB, FaderTemp, FaderRate, FaderSpeed, FaderHighlight, FaderLowlight, FaderTime, FaderSolo. " +
      "For a timed fade use gma3_command with e.g. 'FaderMaster Sequence 1 At 50 Fade 3'.",
    inputSchema: {
      ref: refSchema,
      value: z.number().min(0).max(100),
      token: z.string().optional(),
      enabled: z.boolean().optional().describe("Enable/disable a toggleable fader (e.g. FaderTime)"),
    },
  },
  async ({ ref, value, token, enabled }) => run(() => mutations.run(() => bridge.request("setfader", { ref, value, token, enabled }))),
);

server.registerTool(
  "gma3_get_fader",
  {
    title: "Read fader values",
    description: "Read fader values and display text of a playback object (sequence, master, executor's object).",
    inputSchema: {
      ref: refSchema,
      tokens: z.array(z.string()).optional().describe("Fader tokens (default ['FaderMaster'])"),
    },
  },
  async ({ ref, tokens }) => run(() => bridge.request("getfader", { ref, tokens })),
);

// ---------------------------------------------------------------------------
// Convenience views
// ---------------------------------------------------------------------------

server.registerTool(
  "gma3_sequences",
  {
    title: "List sequences",
    description: "List all sequences in the selected data pool with cue count and whether they have active playback.",
    inputSchema: {
      fields: z.array(z.string()).optional().describe("Extra property names to include per sequence"),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
    },
  },
  async ({ fields, limit, offset }) =>
    run(async () => {
      const res = (await bridge.request("children", { ref: "DataPool.Sequences", fields, limit, offset, playback: true })) as any;
      return res;
    }),
);

server.registerTool(
  "gma3_cues",
  {
    title: "List cues of a sequence",
    description: "List the cues of a sequence with cue number, name, trigger and timing properties.",
    inputSchema: {
      sequence: z.union([z.number(), z.string()]).describe("Sequence number or name"),
      fields: z.array(z.string()).optional().describe("Property names per cue (default: No, Name, TrigType, TrigTime, Command, Note)"),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
    },
  },
  async ({ sequence, fields, limit, offset }) =>
    run(() =>
      bridge.request("children", {
        ref: typeof sequence === "number" ? `Sequence ${sequence}` : `Sequence "${sequence}"`,
        fields: fields ?? ["No", "Name", "TrigType", "TrigTime", "Command", "Note"],
        limit,
        offset,
      }),
    ),
);

server.registerTool(
  "gma3_executors",
  {
    title: "List executors",
    description:
      "List executors on the current executor page with their assigned object, key/fader functions and master fader level. Executor numbers: 101-115 top row, 201-215 faders, 301-315 etc.",
    inputSchema: {
      from: z.number().int().positive().optional().describe("First executor number (default 101)"),
      to: z.number().int().positive().optional().describe("Last executor number (default 315)"),
      only_assigned: z.boolean().optional().describe("Skip empty executors (default true)"),
    },
  },
  async ({ from, to, only_assigned }) =>
    run(() => bridge.request("executors", { from: from ?? 101, to: to ?? 315, onlyAssigned: only_assigned ?? true }, 30000)),
);

server.registerTool(
  "gma3_fixtures",
  {
    title: "List patched fixtures",
    description: "List fixtures in the patch with ID, name, fixture type and DMX patch. Paginated; use filter to restrict (e.g. 'Fixture 1 Thru 50').",
    inputSchema: {
      filter: z.string().optional().describe("Command-line fixture range (default 'Fixture Thru' = all)"),
      fields: z.array(z.string()).optional().describe("Property names per fixture (default: FID, CID, Name, FixtureType, Mode, Patch)"),
      limit: z.number().int().positive().optional().describe("Max items (default 200)"),
      offset: z.number().int().nonnegative().optional(),
    },
  },
  async ({ filter, fields, limit, offset }) =>
    run(() =>
      bridge.request(
        "objects",
        { ref: filter ?? "Fixture Thru", fields: fields ?? ["FID", "CID", "Name", "FixtureType", "Mode", "Patch"], limit: limit ?? 200, offset },
        30000,
      ),
    ),
);

server.registerTool(
  "gma3_pool",
  {
    title: "List a pool",
    description:
      "List the objects of a pool in the selected data pool: Sequences, Groups, Presets (pool name like 'Presets' lists preset pools; use 'Preset 4' style ref via gma3_list_children for one pool), Macros, Pages, Worlds, Filters, Timecodes, Timers, Layouts, Views, Appearances, MAtricks, Plugins, Cameras, Sounds, ScreenConfigurations, Agendas, Images, Videos, Scribbles, Gels, Datapools.",
    inputSchema: {
      pool: z.string().describe("Pool child name of the data pool, e.g. 'Groups', 'Macros', 'PresetPools', 'Sequences', 'Pages'"),
      fields: z.array(z.string()).optional(),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
    },
  },
  async ({ pool, fields, limit, offset }) => run(() => bridge.request("children", { ref: `DataPool.${pool}`, fields, limit, offset })),
);

// ---------------------------------------------------------------------------
// Documentation
// ---------------------------------------------------------------------------

server.registerTool(
  "gma3_help",
  {
    title: "grandMA3 manual lookup",
    description:
      "Look up a topic in the grandMA3 user manual shipped with onPC. Pass a command keyword (e.g. 'Go', 'Store', 'Assign', 'SendOSC', 'Lua', 'At', 'Fade') " +
      "or a topic phrase (e.g. 'osc', 'cue timing', 'phaser'). Returns the page text, or a list of matching pages to choose from.",
    inputSchema: {
      topic: z.string(),
      max_chars: z.number().int().positive().optional(),
    },
  },
  async ({ topic, max_chars }) =>
    run(async () => {
      const res = lookupHelp(topic, max_chars);
      if (res.error) throw new Error(res.error);
      if (res.text) return `# ${res.page} (grandMA3 ${helpVersion() ?? ""})\n\n${res.text}`;
      if (res.matches && res.matches.length) return { matches: res.matches, hint: "Call again with one of the file names or a more specific topic." };
      return { matches: [], hint: `No page found for '${topic}'. Try a keyword like 'Store' or a topic word; there are ${listHelpPages().length} pages.` };
    }),
);

// ---------------------------------------------------------------------------
// Workflow and inspection tools (FR-03 .. FR-10). Each module lives in src/tools/ and reports
// through the shared result model in results.ts.
// ---------------------------------------------------------------------------

registerFixtureTools(server, toolContext);
registerCueTools(server, toolContext);
registerExecutorTools(server, toolContext);
registerInspectionTools(server, toolContext);

server.registerResource(
  "cheatsheet",
  "gma3://cheatsheet",
  {
    title: "grandMA3 command line cheat sheet",
    description: "Compact reference of grandMA3 command syntax and object model for use with gma3_command and gma3_lua.",
    mimeType: "text/markdown",
  },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: CHEATSHEET }] }),
);

// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`gma3-mcp started (bridge ${bridge.description}, osc ${osc.description}, gma3_lua tool ${allowLuaTool ? "registered" : "disabled by GMA3_ALLOW_LUA"})`);
}

main().catch((err) => {
  console.error("gma3-mcp failed to start:", err);
  process.exit(1);
});
