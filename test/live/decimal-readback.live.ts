/**
 * Live console test for SU-11: decimal read-back on channels with several channel functions (not part of `npm test`;
 * see README.md).
 *
 * Show objects used (see the table in test/live/README.md):
 *   - One patched fixture with an attribute whose DMX channel has several channel functions and whose first function
 *     ends below DMX 255 (a colour wheel with a spin range, a shutter with a strobe range). `GMA3_LIVE_DECIMAL_TARGET`
 *     names it as "<fid>:<attribute>" (for example "301:Color1"); without it the first such fixture in patch order
 *     is used, skipping Pan and Tilt (a running position phaser would take over the programmer value).
 *   - The programmer and the selection are cleared with ClearAll at the start and at the end. Nothing is stored and
 *     no pool object is created or changed; SaveShow is never called.
 *
 * What it asserts: Decimal8, Decimal16 and Decimal24 values inside the first channel function and inside a later
 * one are verified `matched` by gma3_set_attribute and gma3_set_attributes, although the programmer's percent is a
 * share of the attribute's function range (it reads above 100 % in the later function).
 */
import assert from "node:assert/strict";
import { liveTest } from "./live.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { registerFixtureTools } from "../../src/tools/fixtures.ts";
import { MutationLock } from "../../src/mutations.ts";
import type { Gma3Bridge } from "../../src/bridge.ts";
import type { OperationResult } from "../../src/results.ts";

interface AttrRow { attribute?: string; dmxFrom?: string | null; dmxTo?: string | null; channelFunctions?: string[] }

async function target(bridge: Gma3Bridge): Promise<{ fid: string; attribute: string; firstTo8: number } | null> {
  const wanted = process.env.GMA3_LIVE_DECIMAL_TARGET?.match(/^(\d+):(\w+)$/);
  const list = (await bridge.request("objects", { ref: "Fixture Thru", fields: ["FID"], limit: 200 })) as { items: Array<{ fields?: { FID?: unknown } }> };
  const fids = wanted ? [wanted[1]] : (list.items ?? []).map((i) => String(i.fields?.FID ?? "None")).filter((f) => f !== "None");
  for (const fid of fids) {
    let attrs: AttrRow[];
    try {
      attrs = ((await bridge.request("fixtureAttributes", { ref: `Fixture ${fid}`, limit: 500 })) as { attributes?: AttrRow[] }).attributes ?? [];
    } catch {
      continue;
    }
    for (const a of attrs) {
      if (!a.attribute || /^(Pan|Tilt)$/i.test(a.attribute)) continue;
      if (wanted && a.attribute.toLowerCase() !== wanted[2].toLowerCase()) continue;
      const to = parseInt(a.dmxTo ?? "", 16);
      if ((a.channelFunctions?.length ?? 0) < 2 || a.dmxFrom !== "000000" || !Number.isFinite(to)) continue;
      const firstTo8 = Math.floor(to / 0x10000);
      if (firstTo8 >= 2 && firstTo8 <= 250) return { fid, attribute: a.attribute, firstTo8 };
    }
  }
  return null;
}

liveTest("SU-11: decimal values on a multi-function channel verify as DMX values in both setters", async (t, bridge) => {
  const tools = captureTools(registerFixtureTools, { bridge, mutations: new MutationLock(), requestTimeoutMs: 15000, luaToolAllowed: false });
  const call = async (name: string, args: Record<string, unknown>): Promise<OperationResult> => {
    const res = await tools.get(name)!.call(args);
    const text = res.content.map((c) => c.text).join("\n");
    t.diagnostic(`${name} ${JSON.stringify(args)} -> ${text.slice(0, 300).replace(/\s+/g, " ")}`);
    return JSON.parse(text) as OperationResult;
  };

  const tgt = await target(bridge);
  if (!tgt) {
    t.skip("no patched fixture has a multi-function channel whose first function ends below DMX 255 (set GMA3_LIVE_DECIMAL_TARGET)");
    return;
  }
  t.diagnostic(`target: Fixture ${tgt.fid} ${tgt.attribute}, first channel function ends at DMX ${tgt.firstTo8}`);
  const lower = Math.max(1, Math.floor(tgt.firstTo8 * 0.8));
  const upper = tgt.firstTo8 + Math.ceil((255 - tgt.firstTo8) / 2);
  const cases: Array<[number, string]> = [
    [lower, "decimal8"],
    [upper, "decimal8"],
    [lower * 256 + 0x4c, "decimal16"],
    [upper * 256 + 0x12, "decimal16"],
    [lower * 65536 + 0x1234, "decimal24"],
    [upper * 65536 + 0xabcd, "decimal24"],
  ];

  assert.equal((await call("gma3_clear_programmer", { mode: "all" })).outcome, "succeeded");
  try {
    for (const [value, unit] of cases) {
      const one = await call("gma3_set_attribute", { fixtures: tgt.fid, attribute: tgt.attribute, value, unit });
      assert.equal(one.outcome, "succeeded", one.summary);
      assert.equal(one.verification.status, "matched", one.verification.detail ?? one.summary);
      const look = await call("gma3_set_attributes", { fixtures: tgt.fid, values: [{ attribute: tgt.attribute, value, unit }] });
      assert.equal(look.outcome, "succeeded", look.summary);
      assert.equal(look.verification.status, "matched", look.verification.detail ?? look.summary);
    }
    // The console's own percent for the upper value is past 100 % of the attribute's function: the case SU-11 fixed.
    await call("gma3_set_attribute", { fixtures: tgt.fid, attribute: tgt.attribute, value: upper, unit: "decimal8" });
    const prog = (await bridge.request("programmer", { scope: "selection", limit: 500 })) as { rows?: Array<{ attribute?: string; value?: number; valueRaw?: number }> };
    const row = (prog.rows ?? []).find((r) => r.attribute?.toLowerCase() === tgt.attribute.toLowerCase());
    t.diagnostic(`programmer row for Decimal8 ${upper}: value ${row?.value} %, valueRaw ${row?.valueRaw}`);
    assert.ok(row && typeof row.value === "number" && row.value > 100, "the row's percent is a share of the first function's range");
    assert.equal(row!.valueRaw, upper * 0x10101);
  } finally {
    await call("gma3_clear_programmer", { mode: "all" });
  }
});
