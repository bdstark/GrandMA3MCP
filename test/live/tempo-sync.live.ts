/**
 * Live console test for SU-17: ReSync in gma3_playback, and the tempo-sync plugin's status and configuration tools.
 *
 * Runs only with GMA3_LIVE=1 against a disposable show (see README.md in this folder). Not part of `npm test`.
 * Needs bridge 0.35.0 (0.31.0's variable ops, 0.32.0's current cue, 0.35.0's console clock).
 *
 * Show objects used: Sequence 946 (must not exist; a three-cue chase on GMA3_LIVE_SU17_FID, default 101, that plays
 * for a few seconds; deleted at the end) and the global variables BeatSync.Quantum and BeatSync.Action16 (restored).
 * The plugin itself is only read: it is neither imported, started nor stopped.
 */
import assert from "node:assert/strict";
import { after } from "node:test";
import { MutationLock } from "../../src/mutations.ts";
import { registerTempoSyncTools, resyncPlayback } from "../../src/tools/temposync.ts";
import type { ToolContext } from "../../src/tools/context.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { liveTest, liveEnabled, bridge, cmd } from "./live.ts";

const FID = Number(process.env.GMA3_LIVE_SU17_FID ?? 101);
const SEQ = 946;
const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 20000, luaToolAllowed: false };
const tools = captureTools(registerTempoSyncTools, ctx);
async function call(name: string, args: Record<string, unknown>) {
  const res = await tools.get(name)!.call(args);
  const text = res.content.map((c) => c.text).join("\n");
  return { result: JSON.parse(text) as any, isError: Boolean(res.isError), text };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const currentCue = async () => ((await bridge.request("object", { ref: `Sequence ${SEQ}`, properties: false })) as { currentCue?: { no?: number } }).currentCue?.no ?? null;
/** When the chase's cue changes over `ms`, sampled every 40 ms: [{ms, cue}]. */
async function watch(ms: number) {
  const t0 = Date.now();
  const out: Array<{ ms: number; cue: number | null }> = [];
  let last: number | null | undefined;
  while (Date.now() - t0 < ms) {
    const c = await currentCue();
    if (c !== last) out.push({ ms: Date.now() - t0, cue: c });
    last = c;
    await sleep(40);
  }
  return out;
}

let started = false;
let savedVars: Record<string, unknown> | undefined;
after(async () => {
  if (!liveEnabled || !started) return;
  try {
    await cmd(`Off Sequence ${SEQ}`);
    await cmd(`Delete Sequence ${SEQ} /NoConfirmation`);
    await cmd("ClearAll");
    if (savedVars) {
      for (const [k, v] of Object.entries(savedVars)) {
        if (v === null) await bridge.request("vars.delete", { scope: "global", name: k });
        else await bridge.request("vars.set", { scope: "global", name: k, value: String(v), type: "text" });
      }
    }
  } catch {
    // best effort
  }
});

liveTest("SU-17 ReSync on a running chase, tempo-sync plugin status and configuration", async (t) => {
  assert.equal(((await bridge.request("objects", { ref: `Sequence ${SEQ}` })) as { total?: number }).total ?? 0, 0, `Sequence ${SEQ} must not exist`);
  started = true;
  await cmd("ClearAll");
  for (const [i, v] of [[1, 20], [2, 60], [3, 100]] as const) {
    await cmd(`Fixture ${FID} At ${v}`);
    await cmd(`Store Sequence ${SEQ} Cue ${i} /NoConfirmation`);
  }
  await cmd("ClearAll");
  // A chase: every cue steps on after 1 s, and the sequence wraps.
  await cmd(`Set Sequence ${SEQ} Cue 1 Thru 3 Property "TrigType" "Time"`);
  await cmd(`Set Sequence ${SEQ} Cue 1 Thru 3 Property "TrigTime" "1"`);
  await cmd(`Set Sequence ${SEQ} Property "WrapAround" "Yes"`);

  await t.test("ReSync of a running chase: the cue is read back, and the step timing before and after is recorded", async () => {
    await cmd(`Go+ Sequence ${SEQ}`);
    const beforeSteps = await watch(2600);
    const r = await resyncPlayback(ctx, `Sequence ${SEQ}`);
    const afterSteps = await watch(2600);
    assert.equal(r.outcome, "succeeded", JSON.stringify(r.steps));
    assert.equal(r.verification.status, "matched");
    const st = (r.states as Array<{ active: boolean; currentCue: { no: number } | null }>)[0];
    assert.equal(st.active, true);
    t.diagnostic(`before ReSync: ${JSON.stringify(beforeSteps)}; state after: cue ${st.currentCue?.no}; after ReSync: ${JSON.stringify(afterSteps)}`);
    // The chase keeps stepping after ReSync.
    assert.ok(afterSteps.length >= 2, JSON.stringify(afterSteps));
  });

  await t.test("ReSync of a range reports which sequences play", async () => {
    const r = await resyncPlayback(ctx, `Sequence ${SEQ} + 1`);
    assert.notEqual(r.outcome, "failed", JSON.stringify(r.steps));
    t.diagnostic(String(r.summary));
    await cmd(`Off Sequence ${SEQ}`);
  });

  await t.test("gma3_tempo_sync_status says plainly whether the plugin is imported and running", async () => {
    const r = await call("gma3_tempo_sync_status", {});
    assert.equal(r.isError, false, r.text);
    assert.equal(typeof r.result.explanation, "string");
    if (r.result.installed === false) assert.match(r.result.explanation, /not imported/);
    if (r.result.running === false) assert.match(r.result.explanation, /Plugin "gma3_beat_sync"/);
    t.diagnostic(`installed ${r.result.installed}, running ${r.result.running}: ${r.result.explanation}`);
  });

  await t.test("gma3_configure_tempo_sync writes, reads back and clears", async () => {
    const pre = (await bridge.request("vars.get", { scope: "global", names: ["BeatSync.Quantum", "BeatSync.Action16"] })) as { items: Array<{ name: string; exists: boolean; value?: unknown }> };
    savedVars = Object.fromEntries(pre.items.map((i) => [i.name, i.exists ? i.value : null]));
    const r = await call("gma3_configure_tempo_sync", { quantum: 3, actions: [{ slot: 16, every: 4, phase: 1, command: `Go+ Sequence ${SEQ}` }] });
    assert.equal(r.result.verification.status, "matched", r.text);
    const v = (await bridge.request("vars.get", { scope: "global", names: ["BeatSync.Quantum", "BeatSync.Action16"] })) as { items: Array<{ value?: unknown }> };
    assert.deepEqual(v.items.map((i) => i.value), ["3", `4 1 Go+ Sequence ${SEQ}`]);
    const clear = await call("gma3_configure_tempo_sync", { quantum: null, actions: [{ slot: 16, clear: true }] });
    assert.equal(clear.result.verification.status, "matched", clear.text);
  });
});
