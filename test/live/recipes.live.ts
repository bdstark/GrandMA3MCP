/**
 * Live console test for SB-05 (gma3_recipes, gma3_edit_recipe, gma3_cook_recipes).
 *
 * NOT run by `npm test`. Run on purpose against a disposable show with an EMPTY programmer and bridge 0.24.0:
 *   GMA3_LIVE=1 node --import tsx --test test/live/recipes.live.ts
 *
 * Fixtures and presets (defaults match mcp-test-disposable): fixtures GMA3_LIVE_RECIPE_FIXTURES ("401,402,403,404";
 * RGB + Dimmer; the first two start in the group, the third joins it, the fourth carries the unrelated cue value), a
 * colour preset GMA3_LIVE_RECIPE_COLOR ("4.4") and a dimmer preset GMA3_LIVE_RECIPE_DIMMER ("1.11"), which must exist.
 *
 * Show objects this file creates and deletes (reserved ranges, see README.md):
 *   - Sequence 906 (cues 1 and 2), Groups 910 and 911, Presets 23.931 and 4.931   created by the test; deleted at the end.
 *   - the programmer   used to store the empty cues/presets and the unrelated cue value; ClearAll afterwards.
 *   The test refuses to run when any of those objects exists. Nothing calls SaveShow.
 *
 * What it demonstrates (SB-05 acceptance criteria):
 *   1. Multiple recipe lines (selection + values) added to a cue part and read back with their coverage.
 *   2. Changing group membership: the cook preview shows the affected target and the new members; merge_low_priority
 *      cooks the new coverage at once and leaves the unrelated cue value untouched. (The console also re-cooks the
 *      change by itself in the background; the test only reports what an immediate read shows.)
 *   3. merge and overwrite are refused while they would replace or delete that unrelated value.
 *   4. Lines reordered and removed; an empty group and a deleted values preset reported as problems.
 *   5. A preset recipe added and cooked.
 */
import assert from "node:assert/strict";
import { liveTest, cmd } from "./live.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { MutationLock } from "../../src/mutations.ts";
import type { ToolContext } from "../../src/tools/context.ts";
import { registerRecipeTools } from "../../src/tools/recipes.ts";
import { exists } from "../../src/tools/common.ts";

const env = process.env;
const FIX = (env.GMA3_LIVE_RECIPE_FIXTURES ?? "401,402,403,404").split(",").map((s) => s.trim());
const COLOR = env.GMA3_LIVE_RECIPE_COLOR ?? "4.4";
const DIMMER = env.GMA3_LIVE_RECIPE_DIMMER ?? "1.11";
const SEQ = 906;
const G = 910;
const G_EMPTY = 911;
const P_RECIPE = "23.931";
const P_GONE = "4.931";

liveTest("SB-05: recipe lines, cooking and coverage (Sequence 906, Groups 910-911, Presets 23.931, 4.931)", async (t, bridge) => {
  const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 15000, luaToolAllowed: false };
  const tools = captureTools(registerRecipeTools, ctx);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await tools.get(name)!.call(args);
    const text = res.content.map((c) => c.text).join("\n");
    let result: any;
    try {
      result = JSON.parse(text);
    } catch {
      result = text;
    }
    return { result, isError: Boolean(res.isError) };
  };
  const run = async (...commands: string[]) => {
    for (const c of commands) assert.equal(await cmd(c), "OK", c);
  };
  const CUE1 = { sequence: SEQ, cue: 1, part: 0 };
  const CUE2 = { sequence: SEQ, cue: 2, part: 0 };
  const edit = (target: unknown, args: Record<string, unknown>) => call("gma3_edit_recipe", { target, ...args });
  const ok = (r: { result: any; isError: boolean }, what: string) => {
    assert.equal(r.isError, false, `${what}: ${JSON.stringify(r.result)}`);
    assert.equal(r.result.verification.status, "matched", `${what}: ${JSON.stringify(r.result.verification)}`);
  };
  const cookedFixtures = (r: any) => (r.coverage ?? r).cooked.map((c: any) => c.fixture).sort();

  // Preconditions.
  for (const ref of [`Sequence ${SEQ}`, `Group ${G}`, `Group ${G_EMPTY}`, `Preset ${P_RECIPE}`, `Preset ${P_GONE}`]) {
    // A failed check is not "absent": the cleanup deletes these objects.
    const e = await exists(bridge, ref);
    assert.notEqual(e.exists, "unknown", `could not check ${ref}: ${"error" in e ? e.error : ""}`);
    assert.equal(e.exists, false, `${ref} already exists`);
  }
  const prog = (await bridge.request("programmer", {})) as { rows?: unknown[]; coverage?: { complete?: boolean } };
  if (prog.coverage?.complete !== true || (prog.rows ?? []).length) {
    t.skip("the programmer is not confirmed empty; clear it first");
    return;
  }
  t.after(async () => {
    for (const c of [`Delete Sequence ${SEQ} /NoConfirmation`, `Delete Preset ${P_RECIPE} /NoConfirmation`, `Delete Preset ${P_GONE} /NoConfirmation`, `Delete Group ${G} /NoConfirmation`, `Delete Group ${G_EMPTY} /NoConfirmation`, "ClearAll"]) await cmd(c).catch(() => {});
  });
  await run("ClearAll", `Fixture ${FIX[0]} + ${FIX[1]}`, `Store Group ${G} /NoConfirmation`, "ClearAll", `Store Group ${G_EMPTY} /NoConfirmation`, `Store Sequence ${SEQ} Cue 1 /NoConfirmation`, `Store Sequence ${SEQ} Cue 2 /NoConfirmation`);
  // The unrelated value in cue 1: a stored (uncooked) Dimmer on the fourth fixture.
  await run(`Fixture ${FIX[3]}`, 'Attribute "Dimmer" At 70', `Store Sequence ${SEQ} Cue 1 /Merge /NoConfirmation`, "ClearAll");

  // 1. Two lines.
  ok(await edit(CUE1, { action: "add", selection: G, values: COLOR, name: "colour" }), "add colour");
  ok(await edit(CUE1, { action: "add", selection: G, values: DIMMER }), "add dimmer");
  // Every requested field is verified per property (SelectionMode is compared as text, not as a truth value).
  ok(await edit(CUE1, { action: "set", line: 2, selection_mode: "normal" }), "selection mode normal");
  ok(await edit(CUE1, { action: "set", line: 2, selection_mode: "strict", enabled: true }), "selection mode strict");
  const r1 = (await call("gma3_recipes", { target: CUE1 })).result;
  t.diagnostic(`cue 1: ${r1.lines.length} lines; cooked ${cookedFixtures(r1).join(",")}; uncooked ${r1.coverage.uncooked.map((u: any) => `${u.fixture} ${u.attributes.join("+")}`).join(",")}`);
  assert.equal(r1.lines.length, 2);
  assert.deepEqual(cookedFixtures(r1), [FIX[0], FIX[1]]);
  assert.ok(r1.coverage.uncooked.some((u: any) => u.fixture === FIX[3] && u.attributes.includes("Dimmer")));

  // 2. Group membership change: the console re-cooks it in the background a moment later; the tool cooks it at once.
  await run(`Fixture ${FIX[0]} Thru ${FIX[2]}`, `Store Group ${G} /Overwrite /NoConfirmation`, "ClearAll");
  t.diagnostic(`right after the group change: cooked ${cookedFixtures((await call("gma3_recipes", { target: CUE1 })).result).join(",")} (the console's own cook is asynchronous)`);
  const pv = await call("gma3_cook_recipes", { target: { sequence: SEQ }, mode: "merge_low_priority", preview: true });
  assert.equal(pv.isError, false, JSON.stringify(pv.result));
  assert.deepEqual(pv.result.affected.map((a: any) => a.target), [`Sequence ${SEQ} Cue 1 Part 0`]);
  assert.deepEqual(pv.result.affected[0].lines[0].members, FIX.slice(0, 3));
  // 3. merge / overwrite would touch the unrelated value.
  const over = await call("gma3_cook_recipes", { target: CUE1, mode: "overwrite" });
  assert.match(over.result.steps.find((s: any) => s.name === "check_uncooked").error, /overwrite would delete uncooked values/);
  const cooked = await call("gma3_cook_recipes", { target: { sequence: SEQ }, mode: "merge_low_priority" });
  ok(cooked, "cook");
  const r2 = (await call("gma3_recipes", { target: CUE1 })).result;
  assert.deepEqual(cookedFixtures(r2), FIX.slice(0, 3));
  assert.ok(r2.coverage.uncooked.some((u: any) => u.fixture === FIX[3] && u.attributes.includes("Dimmer")), "the unrelated value survives the cook");

  // 4. Reorder, remove, empty group, deleted preset.
  ok(await edit(CUE1, { action: "move", line: 1, to: 2 }), "move");
  const moved = (await call("gma3_recipes", { target: CUE1 })).result.lines;
  assert.equal(moved[1].name, "colour");
  ok(await edit(CUE1, { action: "remove", line: 1 }), "remove");
  const afterRemove = (await call("gma3_recipes", { target: CUE1 })).result;
  assert.equal(afterRemove.lines.length, 1);
  ok(await edit(CUE2, { action: "add", selection: G_EMPTY, values: COLOR }), "empty group line");
  await run("ClearAll", `Fixture ${FIX[0]}`, 'Attribute "ColorRGB_R" At 50', `Store Preset ${P_GONE} /Selective /NoConfirmation`, "ClearAll");
  ok(await edit(CUE2, { action: "add", selection: G, values: P_GONE }), "line with the preset to delete");
  await run(`Delete Preset ${P_GONE} /NoConfirmation`);
  const r3 = (await call("gma3_recipes", { target: CUE2 })).result;
  t.diagnostic(`cue 2 problems: ${JSON.stringify(r3.lines.map((l: any) => l.problems))}`);
  assert.match(r3.lines[0].problems.join(), /Group 911 is empty/);
  assert.match(r3.lines[1].problems.join(), /no values/);

  // 5. A preset recipe.
  await run("ClearAll", `Store Preset ${P_RECIPE} /Selective /NoConfirmation`);
  ok(await edit({ preset: P_RECIPE }, { action: "add", selection: G, values: COLOR }), "preset recipe line");
  ok(await call("gma3_cook_recipes", { target: { preset: P_RECIPE }, mode: "merge_low_priority" }), "preset cook");
  assert.deepEqual(cookedFixtures((await call("gma3_recipes", { target: { preset: P_RECIPE } })).result), FIX.slice(0, 3));
});
