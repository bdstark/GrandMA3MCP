/**
 * Live console test for SU-14: cue commands, command-only cues, a preset range, replace with the executor assignment
 * kept, a phaser in a cue look, sequence settings with an override report, and trigger times kept and restored.
 *
 * Runs only with GMA3_LIVE=1 against a disposable show (see README.md in this folder). Not part of `npm test`.
 * No bridge change.
 *
 * Show objects used (each must be empty or absent; everything is deleted at the end):
 *   - Two fixtures with Dimmer from GMA3_LIVE_CUE_FIDS (default "101,102").
 *   - A preset range that exists, GMA3_LIVE_CUE_PRESETS (default "21.11-21.14"), recalled only.
 *   - Sequences 940-943; Page 90 (created when missing, then deleted), executor 90.220.
 *   - The Normal programmer is left alone (the cues are built in Preview); ClearAll at the end.
 */
import assert from "node:assert/strict";
import { after } from "node:test";
import { MutationLock } from "../../src/mutations.ts";
import { registerCueListTools } from "../../src/tools/cuelists.ts";
import type { ToolContext } from "../../src/tools/context.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { liveTest, liveEnabled, bridge } from "./live.ts";

const [A, B] = (process.env.GMA3_LIVE_CUE_FIDS ?? "101,102").split(",").map((s) => s.trim());
const [rangePool, rangeFrom, rangeTo] = (process.env.GMA3_LIVE_CUE_PRESETS ?? "21.11-21.14").match(/^(\d+)\.(\d+)-\d+\.(\d+)$/)!.slice(1).map(Number);
const SEQS = [940, 941, 942, 943];
const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 20000, luaToolAllowed: false };
const tools = captureTools(registerCueListTools, ctx);

async function call(name: string, args: Record<string, unknown>) {
  const res = await tools.get(name)!.call(args);
  const text = res.content.map((c) => c.text).join("\n");
  return { result: JSON.parse(text), isError: Boolean(res.isError), text };
}
const ok = (r: { result: any; isError: boolean; text: string }, what: string) => {
  assert.equal(r.isError, false, `${what}: ${r.text.slice(0, 3000)}`);
  assert.equal(r.result.outcome, "succeeded", what);
  assert.equal(r.result.verification.status, "matched", what);
  return r.result;
};
const cmd = async (command: string) => ((await bridge.request("cmd", { command })) as { feedback?: string }).feedback;
const total = async (ref: string) => ((await bridge.request("objects", { ref })) as { total?: number }).total ?? 0;
const fields = async (ref: string, f: string[]) => ((await bridge.request("objects", { ref, fields: f, limit: 1 })) as { items?: Array<{ fields?: Record<string, unknown> }> }).items?.[0]?.fields ?? {};

const cleanup = { started: false, pageCreated: false };
after(async () => {
  if (!liveEnabled || !cleanup.started) return;
  try {
    await cmd("Delete Page 90.220 /NoConfirmation");
    if (cleanup.pageCreated) await cmd("Delete Page 90 /NoConfirmation");
    for (const s of SEQS) {
      await cmd(`Off Sequence ${s}`);
      await cmd(`Delete Sequence ${s} /NoConfirmation`);
    }
    await cmd("ClearAll");
  } catch {
    // best effort
  }
});

liveTest("SU-14 cue contents: commands, a preset range, replace keeping the assignment, a phaser look, settings, trigger times", async (t) => {
  for (const s of SEQS) assert.equal(await total(`Sequence ${s}`), 0, `Sequence ${s} must not exist in the disposable show`);
  const pageExists = (await total("Page 90")) > 0;
  if (pageExists) assert.equal(await total("Page 90.220"), 0, "Page 90.220 must be empty");
  cleanup.started = true;

  // 1. Command-only cues (a clock) and a look with a command; commands read back.
  ok(
    await call("gma3_store_cues", {
      sequence: 940,
      sequence_name: "MCP clock",
      mode: "create",
      exclusive: true,
      cues: [
        { cue: 1, command: 'SetGlobalVariable "McpLiveClock" "1"', trigger: "time", time: 2.5 },
        { cue: 2, command: 'SetGlobalVariable "McpLiveClock" "2"', trigger: "time", time: 4 },
        { cue: 3, fixtures: `${A} + ${B}`, intensity: 30, command: "Off Sequence 940" },
      ],
    }),
    "command cues",
  );
  assert.equal((await fields("Sequence 940 Cue 2 Part 0", ["Command"])).Command, 'SetGlobalVariable "McpLiveClock" "2"');

  // 2. Trigger times: a switch to Go wipes them; keep_times saves them in the Note; restore_times brings them back.
  const go = ok(await call("gma3_edit_cues", { sequence: 940, cues: [1, 2], trigger: "go", keep_times: true }), "switch to go");
  assert.deepEqual(go.wipedTrigTimes, [{ cue: "1", time: 2.5 }, { cue: "2", time: 4 }]);
  assert.match(String((await fields("Sequence 940", ["Note"])).Note), /\[gma3-mcp trigtimes 1=2\.5 2=4\]/);
  assert.equal(String((await fields("Sequence 940 Cue 1", ["TrigTime"])).TrigTime), "0.00", "the console set TrigTime to 0");
  ok(await call("gma3_edit_cues", { sequence: 940, cues: [1, 2], trigger: "time", restore_times: true }), "restore times");
  assert.equal(String((await fields("Sequence 940 Cue 2", ["TrigTime"])).TrigTime), "4.00");
  assert.doesNotMatch(String((await fields("Sequence 940", ["Note"])).Note ?? ""), /gma3-mcp trigtimes/);

  // 3. A preset range: one cue per existing preset, named after it; assigned; then rebuilt with replace.
  const range = ok(await call("gma3_store_cues", { sequence: 941, mode: "create", exclusive: true, fixtures: `${A} + ${B}`, presets: { pool: rangePool, from: rangeFrom, to: rangeTo }, fade: 1 }), "preset range");
  t.diagnostic(`preset range cues: ${JSON.stringify(range.cues.map((c: any) => [c.cue, c.name]))}`);
  if (!pageExists) {
    assert.equal(await cmd("Store Page 90 /NoConfirmation"), "OK");
    cleanup.pageCreated = true;
  }
  assert.equal(await cmd("Assign Sequence 941 At Page 90.220"), "OK");
  const rebuilt = ok(await call("gma3_store_cues", { sequence: 941, replace: true, exclusive: true, fixtures: A, cues: [{ cue: 1, intensity: 60 }, { cue: 2, intensity: 10 }] }), "replace");
  t.diagnostic(`replace assignments: ${JSON.stringify(rebuilt.assignments)}`);
  assert.equal(rebuilt.assignments.kept, true, "the executor assignment stays");
  assert.match(String((await fields("Page 90.220", ["Object"])).Object), /941|Sequence/);

  // 4. A phaser in a cue look, built in Preview and checked per fixture and step.
  ok(await call("gma3_store_cues", { sequence: 942, mode: "create", exclusive: true, cues: [{ cue: 1, fixtures: `${A} + ${B}`, phaser: { steps: [{ values: { Dimmer: 100 }, transition: 0 }, { values: { Dimmer: 0 }, transition: 0 }], phaser: { speed_bpm: 120, phase: { from: 0, to: 180 } } } }] }), "phaser look");

  // 5. Sequence settings in the same call: an override reports the running sequences it would switch off.
  const ov = ok(await call("gma3_store_cues", { sequence: 943, mode: "create", exclusive: true, cues: [{ cue: 1, fixtures: A, intensity: 100 }], sequence_settings: { priority: "high", off_when_overridden: false } }), "override settings");
  t.diagnostic(`override: ${JSON.stringify(ov.override)}`);
  assert.equal(String((await fields("Sequence 943", ["Priority"])).Priority), "High");
  assert.ok(Array.isArray(ov.override?.wouldSwitchOff));
});
