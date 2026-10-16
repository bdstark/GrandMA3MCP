/**
 * Live console test for SU-16: live playback and value reads. The current cue in gma3_sequences, gma3_cues (several
 * sequences) and gma3_executors; gma3_goto_cue and gma3_playback reading the state back a frame later; the compact
 * programmer read; gma3_observe_values on the programmer and on the output.
 *
 * Runs only with GMA3_LIVE=1 against a disposable show (see README.md in this folder). Not part of `npm test`.
 * Needs bridge 0.32.0.
 *
 * Show objects used: Sequence 945 (must not exist; deleted at the end), one fixture with Dimmer from
 * GMA3_LIVE_READS_FID (default 101; programmer values set, then ClearAll). Sequence 945 plays for a few seconds.
 */
import assert from "node:assert/strict";
import { after } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MutationLock } from "../../src/mutations.ts";
import { registerCueTools } from "../../src/tools/cues.ts";
import { registerInspectionTools } from "../../src/tools/inspection.ts";
import { registerLiveStateTools } from "../../src/tools/livestate.ts";
import type { RegisterTools, ToolContext } from "../../src/tools/context.ts";
import { captureTools, type CapturedTool } from "../helpers/tool-harness.ts";
import { mcpIsError, mcpText, startMcpServer } from "../helpers/mcp-server.ts";
import { liveTest, liveEnabled, bridge, cmd } from "./live.ts";

const FID = Number(process.env.GMA3_LIVE_READS_FID ?? 101);
const SEQ = 945;

const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 20000, luaToolAllowed: false };
const tools = new Map<string, CapturedTool>();
for (const r of [registerCueTools, registerInspectionTools, registerLiveStateTools] as RegisterTools[]) for (const [k, v] of captureTools(r, ctx)) tools.set(k, v);
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
// The index.ts reads (gma3_sequences, gma3_cues, gma3_executors, gma3_playback) through the real server.
let client: Client | undefined;
async function serverCall(name: string, args: Record<string, unknown>) {
  client ??= await startMcpServer({ GMA3_BRIDGE_PORT: process.env.GMA3_BRIDGE_PORT ?? "9800" });
  const res = await client.callTool({ name, arguments: args });
  const text = mcpText(res);
  return { isError: mcpIsError(res), text, result: JSON.parse(text) as any };
}
const total = async (ref: string) => ((await bridge.request("objects", { ref })) as { total?: number }).total ?? 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let started = false;
after(async () => {
  await client?.close().catch(() => {});
  if (!liveEnabled || !started) return;
  try {
    await cmd(`Off Sequence ${SEQ}`);
    await cmd(`Delete Sequence ${SEQ} /NoConfirmation`);
    await cmd("ClearAll");
  } catch {
    // best effort
  }
});

liveTest("SU-16 live reads: current cue, goto/playback read-back, compact programmer, value observer", async (t) => {
  assert.equal(await total(`Sequence ${SEQ}`), 0, `Sequence ${SEQ} must not exist`);
  started = true;
  await cmd("ClearAll");
  await cmd(`Fixture ${FID} At 30`);
  await cmd(`Store Sequence ${SEQ} Cue 1 /NoConfirmation`);
  await cmd(`Fixture ${FID} At 60`);
  await cmd(`Store Sequence ${SEQ} Cue 2 /NoConfirmation`);
  await cmd(`Label Sequence ${SEQ} "McpLiveReads"`);
  await cmd(`Label Sequence ${SEQ} Cue 2 "Blue"`);
  await cmd("ClearAll");

  await t.test("gma3_goto_cue reads the current cue back a frame later", async () => {
    const r = await call("gma3_goto_cue", { sequence: SEQ, cue: 2 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.result.verification.status, "matched", r.text);
    assert.deepEqual(r.result.playbackState.currentCue, { no: 2, name: "Blue" });
    assert.equal(r.result.playbackState.active, true);
  });

  await t.test("gma3_sequences and gma3_cues report the current cue", async () => {
    const seqs = await serverCall("gma3_sequences", { limit: 2000 });
    assert.equal(seqs.isError, false, seqs.text);
    const mine = seqs.result.items.find((i: { name: string }) => i.name === "McpLiveReads");
    assert.ok(mine, "Sequence 945 is listed");
    assert.equal(mine.hasActivePlayback, true);
    assert.deepEqual(mine.currentCue, { no: 2, name: "Blue" });

    const cues = await serverCall("gma3_cues", { sequences: [SEQ, 999999] });
    assert.equal(cues.isError, false, cues.text);
    assert.equal(cues.result.count, 2);
    assert.deepEqual(cues.result.sequences[0].playback, { active: true, currentCue: { no: 2, name: "Blue" } });
    assert.ok(cues.result.sequences[0].items.some((c: { fields: { TrigType?: string } }) => typeof c.fields.TrigType === "string"), "cue fields include the trigger");
    assert.ok(cues.result.sequences[1].error || cues.result.sequences[1].items?.length === 0, JSON.stringify(cues.result.sequences[1]));
  });

  await t.test("gma3_executors: every assigned sequence says whether a cue is current or last", async () => {
    const ex = await serverCall("gma3_executors", {});
    assert.equal(ex.isError, false, ex.text);
    for (const e of ex.result.executors) {
      if (e.assigned?.class !== "Sequence") continue;
      assert.ok("currentCue" in e.assigned, JSON.stringify(e.assigned));
      if (e.assigned.hasActivePlayback === false) assert.equal(e.assigned.currentCue, null);
    }
  });

  await t.test("gma3_playback reads the state back: Off leaves the cue as lastCue", async () => {
    const off = await serverCall("gma3_playback", { action: "off", target: `Sequence ${SEQ}` });
    assert.equal(off.isError, false, off.text);
    assert.equal(off.result.playbackState.active, false, off.text);
    assert.equal(off.result.playbackState.currentCue, null);
    assert.deepEqual(off.result.playbackState.lastCue, { no: 2, name: "Blue" });
    const go = await serverCall("gma3_playback", { action: "go", target: `Sequence ${SEQ}` });
    assert.equal(go.result.playbackState.active, true, go.text);
    assert.equal(typeof go.result.playbackState.currentCue?.no, "number", go.text);
    await cmd(`Off Sequence ${SEQ}`);
  });

  await t.test("gma3_programmer compact form: one entry per fixture", async () => {
    await cmd(`Fixture ${FID} At 70`);
    const r = await call("gma3_programmer", { scope: "fixtures", fixtures: String(FID), by_fixture: true });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.result.rows, undefined);
    const f = r.result.perFixture.find((x: { fid: unknown }) => String(x.fid) === String(FID));
    assert.ok(f, r.text);
    assert.ok(Math.abs(Number(f.values.Dimmer) - 70) < 0.5, JSON.stringify(f.values));
    const picked = await call("gma3_programmer", { scope: "fixtures", fixtures: String(FID), fields: ["valueRaw"] });
    assert.deepEqual(Object.keys(picked.result.rows[0]).sort(), ["attribute", "fid", "subfixtureIndex", "valueRaw"]);
  });

  await t.test("gma3_observe_values (programmer) sees a change made while it watches", async () => {
    const watching = call("gma3_observe_values", { fixtures: [FID], attributes: ["Dimmer"], seconds: 2, interval_ms: 100 });
    await sleep(700);
    await cmd(`Fixture ${FID} At 20`);
    const r = await watching;
    assert.equal(r.isError, false, r.text);
    assert.equal(r.result.observed, true, r.text);
    const dim = r.result.changed.find((c: { fid: unknown; attribute: string }) => String(c.fid) === String(FID) && c.attribute === "Dimmer");
    assert.ok(dim, r.text);
    assert.ok(Math.abs(dim.first - 70) < 0.5 && Math.abs(dim.last - 20) < 0.5, JSON.stringify(dim));
    assert.ok(dim.changes[0].ms >= 300, JSON.stringify(dim.changes));
  });

  await t.test("gma3_observe_values (output) says up front when output cannot be read", async () => {
    const r = await call("gma3_observe_values", { fixtures: FID, source: "output", seconds: 1 });
    assert.equal(r.isError, false, r.text);
    if (r.result.observed === false) {
      assert.match(r.result.reason, /output cannot be read/);
      assert.ok(r.result.outputState, r.text);
    } else {
      assert.ok(r.result.channels > 0, r.text);
    }
    t.diagnostic(`output observer: ${r.result.observed ? "observed" : r.result.reason}`);
  });
  await cmd("ClearAll");
});
