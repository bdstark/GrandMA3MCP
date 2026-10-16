import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { FakeBridge } from "./helpers/fake-bridge.ts";
import { startMcpServer } from "./helpers/mcp-server.ts";
import { BATCH_TOOLS, COMMAND_FALLBACK_NOTE, LUA_FALLBACK_NOTE, OBSERVING_TOOLS, TASK_TOOLS, serverInstructions } from "../src/discovery.ts";

/**
 * SU-10: the server instructions map tasks to the structured tools, gma3_lua and gma3_command point at them, and the
 * observing tools say they watch over time. Every tool named must exist; every tool must be mapped or listed here as
 * deliberately left out of the map.
 */

/** Registered tools the task map leaves out on purpose: infrastructure, low-level reads, console input, fallbacks. */
const NOT_MAPPED = new Set([
  "gma3_status", "gma3_start_bridge", "gma3_command", "gma3_lua", "gma3_lua_api", "gma3_help", "gma3_dump", "gma3_set_property",
  "gma3_pool", "gma3_fixtures", "gma3_executors", "gma3_executor_settings", "gma3_get_fader", "gma3_label_executor", "gma3_store_cue_part",
  "gma3_input_interaction", "gma3_hardkey", "gma3_keyboard", "gma3_type", "gma3_input_sequence", "gma3_hardkeys_status", "gma3_hardkeys_release_all", "gma3_feedback",
]);

const fake = new FakeBridge();
let client: Client;
let tools: Array<{ name: string; description?: string }>;

before(async () => {
  const port = await fake.listen();
  client = await startMcpServer({ GMA3_BRIDGE_PORT: String(port), GMA3_BRIDGE_TIMEOUT_MS: "2000", GMA3_OSC_PORT: "1" });
  tools = (await client.listTools()).tools;
});
after(async () => {
  await client.close().catch(() => {});
  await fake.close();
});

const named = (text: string) => [...new Set(text.match(/gma3_[a-z0-9_]+/g) ?? [])];

test("every tool the instructions and the fallback notes name is registered", () => {
  const names = new Set(tools.map((t) => t.name));
  const mentioned = new Set([...TASK_TOOLS.flatMap((t) => t.tools), ...OBSERVING_TOOLS.map((o) => o.tool), ...named(serverInstructions()), ...named(LUA_FALLBACK_NOTE), ...named(COMMAND_FALLBACK_NOTE)]);
  for (const n of mentioned) assert.ok(names.has(n), `${n} is named but not registered`);
});

test("every registered tool is in the task map, or deliberately left out", () => {
  const mapped = new Set([...TASK_TOOLS.flatMap((t) => t.tools), ...OBSERVING_TOOLS.map((o) => o.tool)]);
  const missing = tools.map((t) => t.name).filter((n) => !mapped.has(n) && !NOT_MAPPED.has(n));
  assert.deepEqual(missing, [], "add new tools to TASK_TOOLS in src/discovery.ts (or to NOT_MAPPED here)");
});

test("the server sends the task map on every start, with gma3_lua as the fallback and the observing tools named", () => {
  const text = client.getInstructions() ?? "";
  for (const t of TASK_TOOLS) assert.ok(text.includes(t.task), `instructions name the task "${t.task}"`);
  assert.match(text, /gma3_observe_tempo \(how fast running sequences \(chases\) advance\)/);
  assert.match(text, /never write a Lua waiting or polling loop/);
  assert.match(text, /Fallbacks, only for what no structured tool covers: gma3_command .* and gma3_lua/);
  assert.ok(text.length < 4000, `instructions stay short (${text.length} characters)`);
});

test("gma3_lua and gma3_command start by pointing at the structured tools; the observing tools say they watch over time", () => {
  const desc = (n: string) => tools.find((t) => t.name === n)?.description ?? "";
  assert.match(desc("gma3_lua"), /^FALLBACK: use a structured tool/);
  for (const area of ["gma3_patch_add", "gma3_store_group", "gma3_apply_preset", "gma3_build_phaser", "gma3_store_cues", "gma3_configure_sequence", "gma3_observe_tempo"]) assert.ok(desc("gma3_lua").includes(area), `gma3_lua names ${area}`);
  assert.match(desc("gma3_command"), /^FALLBACK for a command no structured tool covers/);
  for (const n of ["gma3_observe_tempo", "gma3_run_macro", "gma3_timecode_transport", "gma3_build_chase"]) assert.match(desc(n), /OBSERVES/, `${n} says it observes over time`);
});

test("SU-12: the instructions and gma3_lua name every batch form, and each of those tools describes its list", () => {
  const text = client.getInstructions() ?? "";
  const desc = (n: string) => tools.find((t) => t.name === n)?.description ?? "";
  const schema = (n: string) => JSON.stringify((tools.find((t) => t.name === n) as { inputSchema?: unknown })?.inputSchema ?? {});
  assert.match(text, /Many objects at once: .*never loop over them in Lua/);
  for (const b of BATCH_TOOLS) {
    assert.ok(text.includes(`${b.tool} (${b.list})`), `instructions name ${b.tool}`);
    assert.ok(desc("gma3_lua").includes(b.tool), `gma3_lua names ${b.tool}`);
    assert.match(desc(b.tool), /Batch form/, `${b.tool} describes its batch form`);
    const key = b.list.split(/[ ,]/)[0];
    assert.ok(schema(b.tool).includes(`"${key}"`), `${b.tool} has a ${key} list`);
    assert.ok(schema(b.tool).includes('"detail"'), `${b.tool} takes detail`);
  }
});

test("a stale build's warning comes before the map", () => {
  const text = serverInstructions("WARNING: stale");
  assert.ok(text.startsWith("WARNING: stale\n"));
  assert.match(text, /Map from task to tools/);
});
