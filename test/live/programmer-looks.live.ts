/**
 * Live console test for the SU-05 programmer tools (gma3_set_attributes, gma3_apply_preset, gma3_release_attributes).
 *
 * Runs only with GMA3_LIVE=1 against a disposable show (see README.md in this folder). Not part of `npm test`.
 * Needs bridge 0.27.0 (the programmer op's preset links).
 *
 * Show objects used:
 *   - Two top-level fixtures with Dimmer and ColorRGB_R/G/B, FIDs from GMA3_LIVE_LOOK_FIDS (default "1,2").
 *   - A colour preset slot from GMA3_LIVE_LOOK_PRESET (default "4.901"): it must be empty; the run stores a preset there
 *     from the first fixture and deletes it at the end.
 *   - The programmer: cleared (ClearAll) before and after the run.
 */
import assert from "node:assert/strict";
import { after } from "node:test";
import { MutationLock } from "../../src/mutations.ts";
import { registerFixtureTools } from "../../src/tools/fixtures.ts";
import type { ToolContext } from "../../src/tools/context.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { liveTest, liveEnabled, bridge } from "./live.ts";

const [A, B] = (process.env.GMA3_LIVE_LOOK_FIDS ?? "1,2").split(",").map((s) => s.trim());
const [POOL, SLOT] = (process.env.GMA3_LIVE_LOOK_PRESET ?? "4.901").split(".").map(Number);
const PRESET = `Preset ${POOL}.${SLOT}`;
const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 15000, luaToolAllowed: false };
const tools = captureTools(registerFixtureTools, ctx);

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
const rowsOf = async (fid: string) => ((await bridge.request("programmer", { scope: "fixtures", fixtures: `Fixture ${fid}`, limit: 500 })) as { rows?: Array<{ attribute?: string; value?: number }> }).rows ?? [];

const cleanup = { presetStored: false };
after(async () => {
  if (!liveEnabled) return;
  try {
    await cmd("ClearAll");
    if (cleanup.presetStored) await cmd(`Delete ${PRESET} /NoConfirmation`);
  } catch {
    // best effort
  }
});

liveTest("SU-05 programmer tools: a look in one call, preset recall with its link, release scoped to the target", async () => {
  const slot = (await bridge.request("objects", { ref: PRESET })) as { total?: number };
  assert.equal(slot.total ?? 0, 0, `${PRESET} must be empty in the disposable show`);
  await cmd("ClearAll");

  // A preset to recall, stored from the first fixture.
  for (const c of ["ClearAll", `Fixture ${A}`, 'Attribute "ColorRGB_R" At Absolute Percent 100', 'Attribute "ColorRGB_G" At Absolute Percent 0', 'Attribute "ColorRGB_B" At Absolute Percent 20', `Store ${PRESET} /Overwrite`, `Label ${PRESET} "MCP live look"`, "ClearAll"]) assert.equal(await cmd(c), "OK", c);
  cleanup.presetStored = true;

  const look = ok(await call("gma3_set_attributes", { fixtures: `${A} + ${B}`, intensity: 80, values: [{ attribute: "ColorRGB_R", value: 10, unit: "percent" }, { attribute: "ColorRGB_B", value: 90, unit: "percent" }] }), "set a look");
  assert.deepEqual(look.commands, ["At 80", 'Attribute "ColorRGB_R" At Absolute Percent 10', 'Attribute "ColorRGB_B" At Absolute Percent 90']);

  const recall = ok(await call("gma3_apply_preset", { fixtures: `${A} + ${B}`, pool: POOL, preset: SLOT }), "apply the preset");
  assert.equal(recall.presetLink.fixtures.length, 2, "both fixtures hold values linked to the preset");
  const bRows = await rowsOf(B);
  const blue = bRows.find((r) => r.attribute === "ColorRGB_B")?.value ?? NaN;
  assert.ok(Math.abs(blue - 20) < 0.01, `the preset's blue replaced the look's (got ${blue})`);

  const missing = await call("gma3_apply_preset", { fixtures: A, pool: POOL, preset: 99999 });
  assert.equal(missing.result.outcome, "failed");
  assert.match(missing.result.summary, /does not exist/);

  ok(await call("gma3_release_attributes", { fixtures: A, attributes: ["ColorRGB_R", "ColorRGB_G"] }), "release R and G from the first fixture");
  const aRows = await rowsOf(A);
  assert.ok(!aRows.some((r) => r.attribute === "ColorRGB_R" || r.attribute === "ColorRGB_G"), "released from the first");
  assert.ok((await rowsOf(B)).some((r) => r.attribute === "ColorRGB_R"), "the second keeps its values");

  ok(await call("gma3_release_attributes", { fixtures: B, all: true }), "release every value of the second fixture");
  assert.deepEqual(await rowsOf(B), []);
});
