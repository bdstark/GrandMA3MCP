/**
 * Live console test for the SU-06 cue-list tools (gma3_store_cues, gma3_edit_cues, gma3_build_chase).
 *
 * Runs only with GMA3_LIVE=1 against a disposable show (see README.md in this folder). Not part of `npm test`.
 * No bridge change; the preset read-back needs bridge 0.27.0.
 *
 * Show objects used:
 *   - Two top-level fixtures with Dimmer and ColorRGB_R/G/B, FIDs from GMA3_LIVE_CUELIST_FIDS (default "1,2").
 *   - Presets 4.941-4.943 (must be empty): stored from the first fixture for the run, deleted at the end.
 *   - Sequences 910-912 (must be empty or absent): built by the run, switched off and deleted at the end.
 *   - The Normal programmer: one operator value (the second fixture at 33 %) that the builds must leave alone;
 *     cleared (ClearAll) at the end. The chases PLAY for a few seconds (live output).
 */
import assert from "node:assert/strict";
import { after } from "node:test";
import { MutationLock } from "../../src/mutations.ts";
import { registerCueListTools } from "../../src/tools/cuelists.ts";
import type { ToolContext } from "../../src/tools/context.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { liveTest, liveEnabled, bridge } from "./live.ts";

const [A, B] = (process.env.GMA3_LIVE_CUELIST_FIDS ?? "1,2").split(",").map((s) => s.trim());
const PRESETS = ["4.941", "4.942", "4.943"];
const SEQS = [910, 911, 912];
const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 15000, luaToolAllowed: false };
const tools = captureTools(registerCueListTools, ctx);

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
const ok = (r: { result: any; isError: boolean; text: string }, what: string) => {
  assert.equal(r.isError, false, `${what}: ${r.text}`);
  assert.equal(r.result.outcome, "succeeded", what);
  assert.equal(r.result.verification.status, "matched", what);
  return r.result;
};
const cmd = async (command: string) => ((await bridge.request("cmd", { command })) as { feedback?: string }).feedback;
const total = async (ref: string) => ((await bridge.request("objects", { ref })) as { total?: number }).total ?? 0;
const normalDimmerOfB = async () => {
  const p = (await bridge.request("programmer", { scope: "fixtures", fixtures: `Fixture ${B}`, limit: 50 })) as { environment?: string; rows?: Array<{ attribute?: string; value?: number }> };
  return { environment: p.environment, value: p.rows?.find((r) => r.attribute === "Dimmer")?.value };
};

const cleanup = { presets: [] as string[], seqs: [] as number[] };
after(async () => {
  if (!liveEnabled) return;
  try {
    for (const s of cleanup.seqs) {
      await cmd(`Off Sequence ${s}`);
      await cmd(`Delete Sequence ${s} /NoConfirmation`);
    }
    for (const p of cleanup.presets) await cmd(`Delete Preset ${p} /NoConfirmation`);
    await cmd("ClearAll");
  } catch {
    // best effort
  }
});

liveTest("SU-06 cue lists: cues from looks built in Preview, a cue range edited, a chase watched for one cycle and its tail", async () => {
  for (const p of PRESETS) assert.equal(await total(`Preset ${p}`), 0, `Preset ${p} must be empty in the disposable show`);
  for (const s of SEQS) assert.equal(await total(`Sequence ${s}`), 0, `Sequence ${s} must not exist in the disposable show`);

  // Presets to recall: red, green, blue from the first fixture.
  const rgb = [[100, 0, 0], [0, 100, 0], [0, 0, 100]];
  for (let i = 0; i < 3; i++) {
    for (const c of ["ClearAll", `Fixture ${A}`, ...["ColorRGB_R", "ColorRGB_G", "ColorRGB_B"].map((a, k) => `Attribute "${a}" At Absolute Percent ${rgb[i][k]}`), `Store Preset ${PRESETS[i]} /Overwrite`]) assert.equal(await cmd(c), "OK", c);
    cleanup.presets.push(PRESETS[i]);
  }
  // The operator's own value in Normal, which no build may touch.
  for (const c of ["ClearAll", `Fixture ${B}`, "At 33", "ClearSelection"]) assert.equal(await cmd(c), "OK", c);
  cleanup.seqs.push(...SEQS);

  const [p1, p2, p3] = PRESETS.map((p) => ({ pool: 4, preset: Number(p.split(".")[1]) }));
  const stored = ok(
    await call("gma3_store_cues", {
      sequence: SEQS[0],
      sequence_name: "MCP live looks",
      mode: "create",
      fixtures: `${A} + ${B}`,
      exclusive: true,
      cues: [
        { cue: 1, name: "Red full", presets: [p1], intensity: 100, fade: 1 },
        { cue: 2, looks: [{ fixtures: A, presets: [p2] }, { fixtures: B, intensity: 50, values: [{ attribute: "ColorRGB_B", value: 80, unit: "percent" }] }], trigger: "follow" },
        { cue: 3, presets: [p3], trigger: "time", time: 2 },
      ],
    }),
    "store three cues",
  );
  assert.deepEqual(stored.cues.map((c: any) => c.status), ["stored", "stored", "stored"]);
  assert.equal(stored.normalProgrammer, "untouched");
  assert.equal(stored.cues[1].name, "[4.942]", "an unnamed cue takes the preset's name");
  const b = await normalDimmerOfB();
  assert.equal(b.environment, "Normal");
  assert.ok(Math.abs((b.value ?? NaN) - 33) < 0.01, `the operator's Normal value is still there (got ${b.value})`);

  const edited = ok(await call("gma3_edit_cues", { sequence: SEQS[0], from: 2, to: 3, trigger: "time", time: 3, fade: 0.5, names: ["Two", "Three"] }), "edit cues 2-3");
  assert.deepEqual(edited.cues.map((c: any) => c.name), ["Two", "Three"]);

  const chase = ok(await call("gma3_build_chase", { sequence: SEQS[1], name: "MCP live chase", fixtures: `${A} + ${B}`, presets: [p1, p2, p3], step_seconds: 0.5, exclusive: true }), "build a chase and watch one cycle");
  assert.equal(chase.cycle.mode, "full");
  assert.deepEqual(chase.cycle.observed.map((o: any) => o.cue), [1, 2, 3, 1, 2]);

  const tail = ok(await call("gma3_build_chase", { sequence: SEQS[2], fixtures: A, presets: [p1, p2, p3, p1, p2, p3], step_seconds: 1, observe_max_seconds: 5, exclusive: true }), "build a long chase and watch its tail");
  assert.equal(tail.cycle.mode, "tail");
  assert.deepEqual(tail.cycle.observed.map((o: any) => o.cue).slice(-2), [1, 2], "the wrap from the last cue to the first and on");

  const end = await normalDimmerOfB();
  assert.ok(Math.abs((end.value ?? NaN) - 33) < 0.01, "the operator's Normal value survived every build");
});
