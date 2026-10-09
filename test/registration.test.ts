import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { FakeBridge } from "./helpers/fake-bridge.ts";
import { startMcpServer } from "./helpers/mcp-server.ts";

/**
 * End-to-end over stdio: every tool module registers, the existing tool names are unchanged, and
 * mutations issued through existing tools are serialised by the shared lock.
 */

const fake = new FakeBridge();
let client: Client;

before(async () => {
  const port = await fake.listen();
  client = await startMcpServer({ GMA3_BRIDGE_PORT: String(port), GMA3_BRIDGE_TIMEOUT_MS: "2000", GMA3_OSC_PORT: "1" });
});
after(async () => {
  await client.close().catch(() => {});
  await fake.close();
});

const EXISTING_TOOLS = [
  "gma3_status",
  "gma3_start_bridge",
  "gma3_command",
  "gma3_lua",
  "gma3_lua_api",
  "gma3_get_object",
  "gma3_list_children",
  "gma3_objects",
  "gma3_dump",
  "gma3_set_property",
  "gma3_playback",
  "gma3_set_fader",
  "gma3_get_fader",
  "gma3_sequences",
  "gma3_cues",
  "gma3_executors",
  "gma3_fixtures",
  "gma3_pool",
  "gma3_help",
];

const WORKFLOW_TOOLS = [
  "gma3_select",
  "gma3_set_attribute",
  "gma3_set_color",
  "gma3_set_position",
  "gma3_clear_programmer",
  "gma3_store_cue",
  "gma3_store_cue_part",
  "gma3_set_cue_timing",
  "gma3_set_cue_trigger",
  "gma3_goto_cue",
  "gma3_delete_cue",
  "gma3_assign_to_executor",
  "gma3_label_executor",
  "gma3_fixture_attributes",
  "gma3_programmer",
  "gma3_fixture_output",
  "gma3_dmx",
  "gma3_cue_contents",
  // KB-05 structured input
  "gma3_input_interaction",
  "gma3_hardkey",
  "gma3_keyboard",
  "gma3_type",
  "gma3_input_sequence",
  "gma3_hardkeys_status",
  "gma3_hardkeys_release_all",
];

test("all pre-existing tools are still registered under their original names", async () => {
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const n of EXISTING_TOOLS) assert.ok(names.includes(n), `missing ${n}`);
});

test("every workflow and inspection tool is registered, also with gma3_lua hidden", async () => {
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const n of WORKFLOW_TOOLS) assert.ok(names.includes(n), `missing ${n}`);
  const restricted = await startMcpServer({ GMA3_BRIDGE_PORT: String(fake.port), GMA3_ALLOW_LUA: "0", GMA3_OSC_PORT: "1" });
  try {
    const restrictedNames = (await restricted.listTools()).tools.map((t) => t.name);
    assert.ok(!restrictedNames.includes("gma3_lua"));
    for (const n of WORKFLOW_TOOLS) assert.ok(restrictedNames.includes(n), `${n} must not depend on gma3_lua`);
  } finally {
    await restricted.close().catch(() => {});
  }
});

test("gma3_lua is serialised with the other mutations", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const slow = async (result: unknown) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 40));
    inFlight--;
    return result;
  };
  fake.on("lua", (args) => slow({ values: [String(args.code).length] }));
  fake.on("cmd", (args) => slow({ command: args.command, feedback: "OK" }));
  const results = await Promise.all([
    client.callTool({ name: "gma3_lua", arguments: { code: "Cmd('Store Cue 1')" } }),
    client.callTool({ name: "gma3_command", arguments: { command: "Go+ Sequence 9", via: "bridge" } }),
    client.callTool({ name: "gma3_lua", arguments: { code: "return 1" } }),
  ]);
  for (const r of results) assert.equal(Boolean((r as { isError?: boolean }).isError), false);
  assert.equal(maxInFlight, 1, "a Lua request must not overlap another mutation");
  assert.deepEqual(
    fake.requests.filter((r) => r.op === "lua" || r.op === "cmd").map((r) => r.op),
    ["lua", "cmd", "lua"],
    "requests are handled in call order",
  );
});

test("existing mutation tools do not interleave: concurrent commands reach the bridge one after another", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  fake.on("cmd", async (args) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 40));
    inFlight--;
    return { command: args.command, feedback: "OK" };
  });
  fake.on("set", async (args) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 40));
    inFlight--;
    return { ref: args.ref, property: args.property, value: args.value };
  });
  const results = await Promise.all([
    client.callTool({ name: "gma3_command", arguments: { command: "Go+ Sequence 1", via: "bridge" } }),
    client.callTool({ name: "gma3_playback", arguments: { action: "go", target: "Sequence 2" } }),
    client.callTool({ name: "gma3_set_property", arguments: { ref: "Sequence 1", property: "Name", value: "x" } }),
  ]);
  for (const r of results) assert.equal(Boolean((r as { isError?: boolean }).isError), false);
  assert.equal(maxInFlight, 1, "mutations must be serialised");
  assert.deepEqual(fake.commands.slice(-2), ["Go+ Sequence 1", "Go+ Sequence 2"]);
});
