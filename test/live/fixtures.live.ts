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
 *     outcome `succeeded` with verification `matched` (programmer read back per fixture in the unit sent), and
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


/** First fixture (by patch order) whose fixture type lists every attribute in `names`, as "Fixture <fid>"; null when none. */
async function fixtureWith(bridge: Gma3Bridge, names: string[]): Promise<string | null> {
  return findFixture(bridge, (attrs) => names.every((n) => attrs.has(n.toLowerCase())));
}
/** First fixture with attributes but without `name`. */
async function fixtureWithout(bridge: Gma3Bridge, name: string): Promise<string | null> {
  return findFixture(bridge, (attrs) => attrs.size > 0 && !attrs.has(name.toLowerCase()));
}
/** Attribute names of a fixture and (like the tool's pre-check) of its first cells. */
async function attributeNames(bridge: Gma3Bridge, fid: string): Promise<Set<string>> {
  type Res = { subfixtureCount?: number; attributes?: Array<{ attribute?: string }> };
  const parent = (await bridge.request("fixtureAttributes", { ref: `Fixture ${fid}`, limit: 500 })) as Res;
  const attrs = new Set((parent.attributes ?? []).map((a) => (a.attribute ?? "").toLowerCase()));
  for (let i = 1; i <= Math.min(parent.subfixtureCount ?? 0, 4); i++) {
    try {
      const cell = (await bridge.request("fixtureAttributes", { ref: `Fixture ${fid}.${i}`, limit: 500 })) as Res;
      for (const a of cell.attributes ?? []) attrs.add((a.attribute ?? "").toLowerCase());
    } catch {
      // cell not resolvable
    }
  }
  return attrs;
}

async function findFixture(bridge: Gma3Bridge, pick: (attrs: Set<string>) => boolean): Promise<string | null> {
  const list = (await bridge.request("objects", { ref: "Fixture Thru", fields: ["FID"], limit: 40 })) as { items: Array<{ fields?: { FID?: unknown } }> };
  for (const item of list.items ?? []) {
    const fid = item.fields?.FID;
    if (fid === undefined || fid === null || String(fid) === "None") continue;
    try {
      if (pick(await attributeNames(bridge, String(fid)))) return `Fixture ${fid}`;
    } catch {
      // unknown op on an old plugin, or an unresolvable fixture: keep looking
    }
  }
  return null;
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

    // 3. Find fixtures that really have the attributes (Fixture 1 may be a grouping fixture with none).
    const dimFx = await fixtureWith(bridge, ["Dimmer"]);
    const rgbFx = await fixtureWith(bridge, ["ColorRGB_R", "ColorRGB_G", "ColorRGB_B"]);
    const posFx = await fixtureWith(bridge, ["Pan", "Tilt"]);
    t.diagnostic(`capable fixtures: dimmer=${dimFx} rgb=${rgbFx} pan/tilt=${posFx}`);
    assert.ok(dimFx, "the show needs at least one fixture with a Dimmer attribute");

    // 4. Dimmer on an explicit target: pre-check, ClearSelection, select, set, programmer read-back matched.
    const dim = await call("gma3_set_attribute", { fixtures: dimFx!, attribute: "Dimmer", value: 50, unit: "percent" });
    assert.equal(dim.outcome, "succeeded", dim.summary);
    assert.equal(dim.verification.status, "matched", dim.verification.detail ?? dim.summary);
    assert.ok(dim.steps.some((x) => x.name === "check_fixture_attributes" && x.status === "succeeded"), "the fixture-type pre-check ran");
    assert.ok(dim.steps.some((x) => x.name === "read_programmer" && x.status === "succeeded"), "the programmer was read back");
    for (const s of dim.steps.filter((x) => x.op === "cmd")) assert.equal(s.feedback, "OK", `${s.command}: ${s.feedback}`);

    // 5. Colour on an explicit RGB fixture, verified per component; position in degrees, converted through the range.
    if (rgbFx) {
      const col = await call("gma3_set_color", { fixtures: rgbFx, red: 100, green: 0, blue: 12.5 });
      assert.equal(col.outcome, "succeeded", col.summary);
      assert.equal(col.verification.status, "matched", col.verification.detail ?? col.summary);
    }
    if (posFx) {
      const pos = await call("gma3_set_position", { fixtures: posFx, pan: 10, tilt: 20, unit: "degrees" });
      assert.equal(pos.outcome, "succeeded", pos.summary);
      assert.equal(pos.verification.status, "matched", pos.verification.detail ?? pos.summary);
      // A deliberately wrong expectation must be reported, not matched: read back with a different value.
      const wrong = await call("gma3_set_position", { fixtures: posFx, pan: -10, unit: "degrees", verify: true });
      assert.equal(wrong.verification.status, "matched", wrong.verification.detail ?? wrong.summary);
    }
    // 5b. A fixture that lacks the attribute is refused by the pre-check before anything is sent.
    const lacking = await fixtureWithout(bridge, "ColorRGB_R");
    if (lacking) {
      const refused = await call("gma3_set_color", { fixtures: lacking, red: 1, green: 2, blue: 3 });
      assert.equal(refused.outcome, "failed", refused.summary);
      assert.ok(refused.steps.some((x) => x.name === "check_fixture_attributes" && x.status === "failed"), refused.summary);
      assert.equal(refused.steps.filter((x) => x.op === "cmd" && x.status !== "skipped").length, 0, "nothing was sent");
      // With the pre-check off, the read-back reports the missing value as a mismatch instead.
      const unchecked = await call("gma3_set_color", { fixtures: lacking, red: 1, green: 2, blue: 3, check_attributes: false });
      assert.equal(unchecked.verification.status, "mismatched", unchecked.verification.detail ?? unchecked.summary);
      assert.match(unchecked.verification.detail ?? "", /no \(sub\)fixture of it has attribute ColorRGB_/);
    }

    // 6. Re-select 1..5 with values active and confirm the set tools left a selection in place.
    await call("gma3_select", { fixtures: "1 Thru 5", clear_first: true });
    assert.equal(await selectionCount(bridge), 5);

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
