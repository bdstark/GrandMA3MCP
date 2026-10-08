/**
 * Live console test for the FR-03 fixture programming tools (not part of `npm test`; see README.md).
 *
 * Show objects used (all in the reserved ranges of test/live/README.md):
 *   - Fixtures 1 Thru 5 must be patched in the disposable show. Ideally fixture 1..5 have Dimmer,
 *     Pan, Tilt and ColorRGB_R/G/B (a moving head or LED wash); the test adapts to what is there.
 *   - The programmer and the selection of the current user profile are modified and emptied with
 *     ClearAll at the end (and at the start). Nothing is stored; no pool object is created or
 *     changed; SaveShow is never called.
 *
 * What it asserts:
 *   - gma3_select on "1 Thru 5" after ClearAll leaves Selection.CountTotalSelected == 5 (parents only).
 *   - A second select of "Fixture 1" WITHOUT clear_first records what the console does (add vs
 *     replace) in the test output, because the 2.5.1 manual says this depends on active values.
 *   - set_attribute (Dimmer 50 %), set_color (100/0/0) and set_position (pan 10°, tilt 20°) return
 *     outcome `succeeded` with verification `unavailable` (programmer values are not readable), and
 *     the console feedback for each command is OK. If the fixtures lack Pan/Tilt or ColorRGB the
 *     console's feedback is printed and the result is accepted as `failed`/`partial` but never `unknown`.
 *   - gma3_clear_programmer mode "all" leaves CountTotalSelected == 0 (verification matched).
 */
import assert from "node:assert/strict";
import { liveTest } from "./live.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { registerFixtureTools } from "../../src/tools/fixtures.ts";
import { MutationLock } from "../../src/mutations.ts";
import { readFields } from "../../src/tools/common.ts";
import type { Gma3Bridge } from "../../src/bridge.ts";
import type { OperationResult } from "../../src/results.ts";

async function selectionCount(bridge: Gma3Bridge): Promise<number | null> {
  const f = await readFields(bridge, "Selection", ["CountTotalSelected"]);
  const n = f ? Number(String(f.CountTotalSelected)) : NaN;
  return Number.isFinite(n) ? n : null;
}

liveTest("fixture tools: select, dimmer, colour, position, ClearAll on fixtures 1 Thru 5", async (t, bridge) => {
  const tools = captureTools(registerFixtureTools, { bridge, mutations: new MutationLock(), requestTimeoutMs: 15000, luaToolAllowed: false });
  const call = async (name: string, args: Record<string, unknown>): Promise<OperationResult> => {
    const res = await tools.get(name)!.call(args);
    const text = res.content.map((c) => c.text).join("\n");
    t.diagnostic(`${name} ${JSON.stringify(args)} -> ${text.slice(0, 400).replace(/\s+/g, " ")}`);
    return JSON.parse(text) as OperationResult;
  };

  const patched = (await bridge.request("objects", { ref: "Fixture 1 Thru 5", fields: ["FID", "FixtureType"], limit: 10 })) as { total: number };
  if (patched.total < 5) {
    t.skip(`only ${patched.total} of fixtures 1 Thru 5 are patched`);
    return;
  }

  // Start from an empty programmer so the selection count is deterministic.
  const clear0 = await call("gma3_clear_programmer", { mode: "all" });
  assert.equal(clear0.outcome, "succeeded");
  assert.equal(await selectionCount(bridge), 0);

  try {
    // 1. Selection by range.
    const sel = await call("gma3_select", { fixtures: "1 Thru 5" });
    assert.equal(sel.outcome, "succeeded", sel.summary);
    assert.equal(sel.verification.status, "matched", sel.summary);
    assert.equal(await selectionCount(bridge), 5, "Fixture 1 Thru 5 after ClearAll selects exactly five parents");

    // 2. Selecting again without clear_first: record add-vs-replace behaviour (no values are active yet).
    const again = await call("gma3_select", { fixtures: "Fixture 1" });
    assert.equal(again.outcome, "succeeded");
    const afterAgain = await selectionCount(bridge);
    t.diagnostic(`after a second plain 'Fixture 1' the selection count is ${afterAgain} (5 = added, 1 = replaced)`);

    // 3. Dimmer on an explicit target: ClearSelection is sent by default, so the selection must be exactly 1..5 again.
    const dim = await call("gma3_set_attribute", { fixtures: "1 Thru 5", attribute: "Dimmer", value: 50, unit: "percent" });
    assert.notEqual(dim.outcome, "unknown", dim.summary);
    assert.equal(dim.outcome, "succeeded", dim.summary);
    assert.equal(dim.verification.status, "unavailable");
    assert.equal(await selectionCount(bridge), 5);
    for (const s of dim.steps.filter((x) => x.op === "cmd")) assert.equal(s.feedback, "OK", `${s.command}: ${s.feedback}`);

    // 4. Colour on the current selection.
    const col = await call("gma3_set_color", { use_selection: true, red: 100, green: 0, blue: 0 });
    assert.notEqual(col.outcome, "unknown", col.summary);
    if (col.outcome !== "succeeded") t.diagnostic(`set_color did not fully succeed (fixtures may lack ColorRGB): ${col.summary}`);
    assert.equal(col.verification.status, "unavailable");

    // 5. Position in degrees on the current selection.
    const pos = await call("gma3_set_position", { use_selection: true, pan: 10, tilt: 20, unit: "degrees" });
    assert.notEqual(pos.outcome, "unknown", pos.summary);
    if (pos.outcome !== "succeeded") t.diagnostic(`set_position did not fully succeed (fixtures may lack Pan/Tilt): ${pos.summary}`);

    // 6. Selection must still be 1..5: no set tool clears it.
    assert.equal(await selectionCount(bridge), 5, "set tools must not clear the selection");

    // 7. Selecting with active values present: record whether the console now replaces.
    const withActive = await call("gma3_select", { fixtures: "Fixture 1" });
    assert.equal(withActive.outcome, "succeeded");
    t.diagnostic(`with active values, a plain 'Fixture 1' leaves the count at ${await selectionCount(bridge)} (manual: replaced -> 1)`);
  } finally {
    // 8. ClearAll empties selection and programmer.
    const clear = await call("gma3_clear_programmer", { mode: "all" });
    assert.equal(clear.outcome, "succeeded", clear.summary);
    assert.equal(clear.verification.status, "matched", clear.summary);
    assert.equal(await selectionCount(bridge), 0);
  }
});
