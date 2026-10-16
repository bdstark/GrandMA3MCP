/**
 * Live console test for SU-15: console variables (gma3_variables, gma3_set_variable), $variables in a macro line and a
 * cue command, and $variable expansion through the bridge's cmd.
 *
 * Runs only with GMA3_LIVE=1 against a disposable show (see README.md in this folder). Not part of `npm test`.
 * Needs bridge 0.31.0.
 *
 * Show objects used (each must be absent; everything is deleted at the end):
 *   - Global variables McpLiveA, McpLiveB, McpLiveSeq and the bridge user's variable McpLiveU.
 *   - Macro 930 and Sequence 944.
 */
import assert from "node:assert/strict";
import { after } from "node:test";
import { MutationLock } from "../../src/mutations.ts";
import { registerVariableTools } from "../../src/tools/variables.ts";
import { registerMacroTools } from "../../src/tools/macros.ts";
import { registerCueListTools } from "../../src/tools/cuelists.ts";
import type { RegisterTools, ToolContext } from "../../src/tools/context.ts";
import { captureTools, type CapturedTool } from "../helpers/tool-harness.ts";
import { liveTest, liveEnabled, bridge } from "./live.ts";

const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 20000, luaToolAllowed: false };
const tools = new Map<string, CapturedTool>();
for (const r of [registerVariableTools, registerMacroTools, registerCueListTools] as RegisterTools[]) for (const [k, v] of captureTools(r, ctx)) tools.set(k, v);
async function call(name: string, args: Record<string, unknown>) {
  const res = await tools.get(name)!.call(args);
  const text = res.content.map((c) => c.text).join("\n");
  let result: any;
  try {
    result = JSON.parse(text);
  } catch {
    result = text;
  }
  return { result, isError: Boolean(res.isError), text };
}
const cmd = async (command: string) => ((await bridge.request("cmd", { command })) as { feedback?: string }).feedback;
const total = async (ref: string) => ((await bridge.request("objects", { ref })) as { total?: number }).total ?? 0;
const GLOBALS = ["McpLiveA", "McpLiveB", "McpLiveSeq"];

let started = false;
after(async () => {
  if (!liveEnabled || !started) return;
  try {
    for (const n of GLOBALS) await bridge.request("vars.delete", { scope: "global", name: n });
    await bridge.request("vars.delete", { scope: "user", name: "McpLiveU" });
    await cmd("Delete Macro 930 /NoConfirmation");
    await cmd("Delete Sequence 944 /NoConfirmation");
    await cmd("ClearAll");
  } catch {
    // best effort
  }
});

liveTest("SU-15 console variables: set, read, types, delete; $variables in a macro line and a cue command", async (t) => {
  const pre = (await call("gma3_variables", { names: [...GLOBALS, "McpLiveU"], referenced: false })).result;
  for (const v of pre.variables) assert.ok(!v.global?.exists && !v.user?.exists, `${v.name} must not exist`);
  assert.equal(await total("Macro 930"), 0, "Macro 930 must be empty");
  assert.equal(await total("Sequence 944"), 0, "Sequence 944 must not exist");
  started = true;

  // Set with types, read back.
  const set = await call("gma3_set_variable", { scope: "global", variables: [{ name: "McpLiveA", value: 11 }, { name: "McpLiveB", value: 2.5 }, { name: "McpLiveSeq", value: "944" }, { name: "McpLiveU", value: 'say "hi"', scope: "user" }] });
  assert.equal(set.isError, false, set.text.slice(0, 2000));
  const read = (await call("gma3_variables", { names: ["McpLiveA", "McpLiveB", "McpLiveSeq", "McpLiveU"], referenced: false })).result;
  t.diagnostic(`read: ${JSON.stringify(read.variables)} user ${read.user}`);
  const by = Object.fromEntries(read.variables.map((x: any) => [x.name, x]));
  assert.deepEqual(by.McpLiveA.global, { exists: true, value: 11, type: "integer" });
  assert.deepEqual(by.McpLiveB.global, { exists: true, value: 2.5, type: "double" });
  assert.deepEqual(by.McpLiveSeq.global, { exists: true, value: "944", type: "text" });
  assert.deepEqual(by.McpLiveU.user, { exists: true, value: 'say "hi"', type: "text" });

  // $variable expansion through the bridge's cmd (read back a frame later).
  assert.equal(await cmd("Store Sequence $McpLiveSeq Cue 1 /NoConfirmation"), "OK");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await total("Sequence 944"), 1, "the command used $McpLiveSeq");

  // A macro line with a $variable: a missing one is refused, an existing one passes and is referenced.
  const missing = await call("gma3_store_macro", { macro: 930, mode: "create", lines: [{ command: "Goto Sequence $McpLiveSeq Cue $McpLiveNope" }] });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /\$McpLiveNope does not exist/);
  const ok = await call("gma3_store_macro", { macro: 930, mode: "create", name: "MCP vars", lines: [{ command: "Goto Sequence $McpLiveSeq Cue 1" }] });
  assert.equal(ok.isError, false, ok.text.slice(0, 2000));
  const refs = (await call("gma3_variables", {})).result;
  assert.ok(refs.variables.some((x: any) => x.name === "McpLiveSeq" && x.usedBy?.includes("Macro 930 line 1")), JSON.stringify(refs.variables).slice(0, 1500));

  // A cue command with a missing $variable is refused before anything is sent.
  const cue = await call("gma3_store_cues", { sequence: 944, mode: "merge", exclusive: true, cues: [{ cue: 2, command: "Go+ Macro $McpLiveNope" }] });
  assert.equal(cue.isError, true);
  assert.match(cue.text, /\$McpLiveNope \(cue 2\) do not exist/);

  // Delete, read back missing.
  const del = await call("gma3_set_variable", { scope: "global", name: "McpLiveA", delete: true });
  assert.equal(del.result.verification.status, "matched", del.text.slice(0, 1500));
});
