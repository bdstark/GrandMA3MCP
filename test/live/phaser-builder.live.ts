/**
 * Live console test for SU-13: the phaser builder's whole-rig effects, variants, mirror, phase step, shuffle, shapes
 * and patterns (gma3_build_phaser).
 *
 * NOT run by `npm test`. Run on purpose against a disposable show in the Normal environment, with the operator's
 * StoreLook preference off and bridge 0.23.0 or newer:
 *   GMA3_LIVE=1 node --import tsx --test test/live/phaser-builder.live.ts
 *
 * Fixtures (environment variables; the defaults suit the SU-13 throwaway show):
 *   - GMA3_LIVE_SU13_MOVERS ("301,302"): two fixtures with Pan and Tilt.
 *   - GMA3_LIVE_SU13_CELLS ("401.1 Thru 401.40"): a row of cells with Dimmer.
 *   - GMA3_LIVE_SU13_RIG ("101 Thru 112,401.1 Thru 401.40,402.1 Thru 402.40,201.1 Thru 201.12,202.1 Thru 202.12,203.1 Thru 203.12,204.1 Thru 204.12"): fixtures
 *     and cells of several types with Dimmer, for a whole-rig chase (more than 128 if the show has them).
 *
 * Show objects: Presets 23.951-23.959 (must not exist; stored by the tool, deleted at the end). The programmer: the tool
 * builds in Preview; ClearAll at the end. Nothing calls SaveShow.
 *
 * What it asserts: a circle in three variants into consecutive named presets (the mirror variant with Pan inverted on
 * the second mover); a fan; on the cell row in one call, a runner with a phase step per cell, a comet and a shuffled
 * sparkle; a whole-rig chase over several fixture types. Every preset is checked in the programmer, stored and read
 * back, with a compact phase summary per preset.
 */
import assert from "node:assert/strict";
import { after } from "node:test";
import { liveTest, liveEnabled, bridge, cmd } from "./live.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { MutationLock } from "../../src/mutations.ts";
import type { ToolContext } from "../../src/tools/context.ts";
import { registerPhaserTools } from "../../src/tools/phasers.ts";

const env = process.env;
const list = (v: string | undefined, d: string) => (v ?? d).split(",").map((s) => s.trim()).filter(Boolean);
const MOVERS = list(env.GMA3_LIVE_SU13_MOVERS, "301,302");
const CELLS = list(env.GMA3_LIVE_SU13_CELLS, "401.1 Thru 401.40");
const RIG = list(env.GMA3_LIVE_SU13_RIG, "101 Thru 112,401.1 Thru 401.40,402.1 Thru 402.40,201.1 Thru 201.12,202.1 Thru 202.12,203.1 Thru 203.12,204.1 Thru 204.12");
const PRESETS = Array.from({ length: 9 }, (_, i) => `23.${951 + i}`);
const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 30000, luaToolAllowed: false };
const tools = captureTools(registerPhaserTools, ctx);

async function build(args: Record<string, unknown>) {
  const res = await tools.get("gma3_build_phaser")!.call({ exclusive: true, ...args });
  const text = res.content.map((c) => c.text).join("\n");
  return { result: JSON.parse(text), isError: Boolean(res.isError), text };
}
const total = async (ref: string) => ((await bridge.request("objects", { ref })) as { total?: number }).total ?? 0;

let started = false;
after(async () => {
  if (!liveEnabled || !started) return;
  try {
    await tools.get("gma3_phaser_release")!.call({});
    for (const p of PRESETS) await cmd(`Delete Preset ${p} /NoConfirmation`);
    await cmd("ClearAll");
  } catch {
    // best effort
  }
});

liveTest("SU-13 phaser builder: variants, mirror, shapes, patterns with a phase step and shuffle, a whole rig", async (t) => {
  for (const p of PRESETS) assert.equal(await total(`Preset ${p}`), 0, `Preset ${p} must not exist in the disposable show`);
  started = true;

  // 1. A circle in three variants on the movers: consecutive presets, named; mirror inverts Pan on the second mover.
  const circle = await build({ preset: "23.951", name: "MCP circle", fixtures: MOVERS, template: { type: "circle", size: 15, center: { pan: 0, tilt: 20 } }, variants: ["sync", "follow", "mirror"] });
  t.diagnostic(`circle variants: ${JSON.stringify(circle.result.items?.map((i: any) => [i.target, i.outcome, i.verification, i.phases]))}`);
  assert.equal(circle.isError, false, circle.text.slice(0, 3000));
  assert.deepEqual(circle.result.items.map((i: any) => i.verification), ["matched", "matched", "matched"]);
  assert.equal(circle.result.normalProgrammerUntouched, true);
  const names = await Promise.all(["23.951", "23.952", "23.953"].map(async (p) => ((await bridge.request("objects", { ref: `Preset ${p}`, fields: ["Name"] })) as { items?: Array<{ fields?: { Name?: string } }> }).items?.[0]?.fields?.Name));
  assert.deepEqual(names, ["MCP circle sync", "MCP circle follow", "MCP circle mirror"]);

  // 2. A fan: every mover on the centre, then spread over 60 degrees of pan.
  const fan = await build({ preset: "23.954", fixtures: MOVERS, template: { type: "fan", size: 60, center: { pan: 0, tilt: 20 } } });
  assert.equal(fan.isError, false, fan.text.slice(0, 3000));
  assert.equal(fan.result.verification.status, "matched");

  // 3. Patterns on the cell row in one call: a runner with 180 degrees between cells, a comet, a shuffled sparkle.
  const rows = await build({
    effects: [
      { preset: "23.955", name: "MCP runner", fixtures: CELLS, steps: [{ values: { Dimmer: 100 }, transition: 0 }, { values: { Dimmer: 0 }, transition: 0 }], phaser: { speed_bpm: 120, phase: { step: 180 } } },
      { preset: "23.956", name: "MCP comet", fixtures: CELLS, template: { type: "comet", tail: 4 } },
      { preset: "23.957", name: "MCP sparkle", fixtures: CELLS, template: { type: "sparkle", every: 5, seed: 3 } },
    ],
  });
  t.diagnostic(`cell patterns: ${JSON.stringify(rows.result.items?.map((i: any) => [i.target, i.outcome, i.verification, i.phases]))}`);
  assert.equal(rows.isError, false, rows.text.slice(0, 3000));
  assert.deepEqual(rows.result.items.map((i: any) => i.verification), ["matched", "matched", "matched"]);
  assert.ok(rows.text.length < 20000, `the three-effect result stays compact (${rows.text.length} bytes)`);

  // 4. A whole-rig chase over several fixture types.
  const rig = await build({ preset: "23.958", name: "MCP rig chase", fixtures: RIG, template: { type: "dimmer_chase" } });
  t.diagnostic(`rig: ${rig.result.fixtures?.length} fixtures, phases ${JSON.stringify(rig.result.phases)}, ${rig.text.length} bytes`);
  assert.equal(rig.isError, false, rig.text.slice(0, 3000));
  assert.equal(rig.result.verification.status, "matched");
  assert.ok(typeof rig.result.phases?.step === "number", "an even spread is summarised as first phase and step");
  assert.ok(rig.text.length < 10000, `a whole-rig result is compact by default (${rig.text.length} bytes)`);
  if ((rig.result.fixtures?.length ?? 0) <= 128) t.diagnostic("the rig list has 128 fixtures or fewer here: the old cap was not exceeded");
});
