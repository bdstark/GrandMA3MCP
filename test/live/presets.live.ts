/**
 * Live console test for SB-03 (gma3_store_preset, gma3_preset).
 *
 * NOT run by `npm test`. Run on purpose against a disposable show with an EMPTY programmer, the operator's StoreLook
 * preference off and bridge 0.22.0:
 *   GMA3_LIVE=1 node --import tsx --test test/live/presets.live.ts
 *
 * Fixtures (defaults match mcp-test-disposable): colour fixtures of one type GMA3_LIVE_PRESET_PARS
 * ("401,402,403,404", RGB + Dimmer), cells of a second type GMA3_LIVE_PRESET_CELLS ("501.1,501.2"), movers of two
 * types GMA3_LIVE_PRESET_MOVERS ("601,602,701,702,703,704", Pan/Tilt).
 *
 * Show objects this file creates, changes and deletes (reserved ranges, see README.md):
 *   - Presets 2.901, 4.901-4.904, 23.901-23.903   created and overwritten by the tool; deleted at the end.
 *   - the programmer                               values are set with Attribute ... At, At Preset ...; ClearAll at
 *                                                  the start of each case and at the end.
 *   The test refuses to run when any of those presets exists and skips unless a complete programmer scan finds no
 *   values. Nothing calls SaveShow; the operator's store preferences are only read.
 *
 * What it demonstrates (SB-03 acceptance criteria):
 *   1. A reusable colour stored global across two fixture types: one global row per type, read back by mode.
 *   2. Selective positions on two mover types: one selective row per fixture.
 *   3. Refusals before anything is sent: unrequested programmer content, divergent values in universal mode, an
 *      attribute the Color pool's input filter would drop, an existing preset without existing, an empty programmer,
 *      an unrequested fade layer. input_filter: false and layers [absolute, fade] then store them, verified.
 *   4. An embedded preset follows its source when the source is updated; a copied one does not.
 *   5. A forced conversion turns a Selective/Global preset into Global data only.
 *   6. Every store leaves the operator's store preferences unchanged (part of each verification).
 */
import assert from "node:assert/strict";
import { liveTest, cmd } from "./live.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { MutationLock } from "../../src/mutations.ts";
import type { ToolContext } from "../../src/tools/context.ts";
import { registerPresetTools } from "../../src/tools/presets.ts";

const env = process.env;
const list = (v: string | undefined, d: string) => (v ?? d).split(",").map((s) => s.trim());
const PARS = list(env.GMA3_LIVE_PRESET_PARS, "401,402,403,404");
const CELLS = list(env.GMA3_LIVE_PRESET_CELLS, "501.1,501.2");
const MOVERS = list(env.GMA3_LIVE_PRESET_MOVERS, "601,602,701,702,703,704");
const P = { blue: "4.901", filtered: "4.902", convert: "4.903", red: "4.904", positions: "2.901", embedded: "23.901", copied: "23.902", fade: "23.903" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

liveTest("SB-03: presets with explicit storage rules (Presets 2.901, 4.901-904, 23.901-903)", async (t, bridge) => {
  const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 15000, luaToolAllowed: false };
  const tools = captureTools(registerPresetTools, ctx);
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
  const store = (args: Record<string, unknown>) => call("gma3_store_preset", { exclusive: true, ...args });
  const read = async (preset: string) => (await call("gma3_preset", { preset })).result;
  const run = async (...commands: string[]) => {
    for (const c of commands) assert.equal(await cmd(c), "OK", c);
  };
  const sel = (ids: string[]) => ids.map((id) => `Fixture ${id}`);

  // Preconditions: never touch anything this test did not create.
  for (const id of Object.values(P)) {
    const r = await read(id);
    assert.equal(r.exists, false, `Preset ${id} already exists; remove it or pick another show`);
  }
  const ctxRead = (await call("gma3_preset", { pool: 4 })).result;
  if (!/^(no|off)$/i.test(String(ctxRead.storePreferences?.StoreLook ?? ""))) {
    t.skip(`the operator's StoreLook preference is ${ctxRead.storePreferences?.StoreLook}; set Look off first`);
    return;
  }
  const prog = (await bridge.request("programmer", {})) as { rows?: unknown[]; coverage?: { complete?: boolean } };
  if (prog.coverage?.complete !== true || (prog.rows ?? []).length !== 0) {
    t.skip("the programmer is not confirmed empty; clear it first");
    return;
  }
  t.after(async () => {
    await cmd("ClearAll").catch(() => {});
    for (const id of [P.embedded, P.copied, P.fade, P.blue, P.filtered, P.convert, P.red, P.positions]) await cmd(`Delete Preset ${id} /NoConfirmation`).catch(() => {});
  });

  // 1. A reusable colour, global across two fixture types.
  await run("ClearAll", ...sel([...PARS, ...CELLS]), 'Attribute "ColorRGB_R" At 0', 'Attribute "ColorRGB_G" At 0', 'Attribute "ColorRGB_B" At 100');
  const blue = await store({ preset: P.blue, fixtures: [...PARS, ...CELLS], mode: "global", name: "SB03 Blue" });
  assert.equal(blue.isError, false, JSON.stringify(blue.result));
  assert.equal(blue.result.verification.status, "matched", JSON.stringify(blue.result.verification));
  const blueRead = await read(P.blue);
  const globals = blueRead.rows.filter((r: any) => r.attribute === "ColorRGB_B" && r.mode === "global");
  t.diagnostic(`global blue: ${globals.map((r: any) => `${r.fixture} (${r.fixtureType})`).join(", ")}; StoredData ${blueRead.storedData}`);
  assert.equal(new Set(globals.map((r: any) => r.fixtureType)).size, 2, "one global row per fixture type");
  assert.equal(blueRead.storedData, "Global");

  // 2. Selective positions on two mover types.
  await run("ClearAll");
  for (const [i, id] of MOVERS.entries()) await run("ClearSelection", `Fixture ${id}`, `Attribute "Pan" At ${-50 + i * 20}`, 'Attribute "Tilt" At 30');
  const pos = await store({ preset: P.positions, fixtures: MOVERS, mode: "selective", attributes: ["Pan", "Tilt"] });
  assert.equal(pos.isError, false, JSON.stringify(pos.result));
  assert.equal(pos.result.verification.status, "matched", JSON.stringify(pos.result.verification));
  const posRead = await read(P.positions);
  const pans = posRead.rows.filter((r: any) => r.attribute === "Pan");
  assert.equal(pans.length, MOVERS.length);
  assert.ok(pans.every((r: any) => r.mode === "selective"));
  assert.equal(new Set(pans.map((r: any) => r.value.toFixed(2))).size, MOVERS.length, "every mover keeps its own pan");

  // 3. Refusals, then the qualified options.
  await run("ClearAll", ...sel(PARS.slice(0, 2)), 'Attribute "ColorRGB_R" At 100', "ClearSelection", `Fixture ${PARS[2]}`, 'Attribute "Dimmer" At 50');
  const unrequested = await store({ preset: P.filtered, fixtures: PARS.slice(0, 2), mode: "selective" });
  assert.match(unrequested.result.steps.find((s: any) => s.name === "check_content").error, /outside the requested fixtures/);
  await run("ClearAll", ...sel(PARS.slice(0, 2)), 'Attribute "ColorRGB_R" At 100', "ClearSelection", `Fixture ${PARS[1]}`, 'Attribute "ColorRGB_R" At 40');
  const divergent = await store({ preset: P.filtered, fixtures: PARS.slice(0, 2), mode: "universal" });
  assert.match(divergent.result.steps.find((s: any) => s.name === "check_content").error, /universal data keeps one value/);
  await run("ClearAll", `Fixture ${PARS[0]}`, 'Attribute "ColorRGB_R" At 100', 'Attribute "Dimmer" At 80');
  const dropped = await store({ preset: P.filtered, fixtures: [PARS[0]], mode: "selective" });
  assert.match(dropped.result.steps.find((s: any) => s.name === "check_content").error, /input filter would silently drop.*Dimmer/);
  const kept = await store({ preset: P.filtered, fixtures: [PARS[0]], mode: "selective", input_filter: false });
  assert.equal(kept.isError, false, JSON.stringify(kept.result));
  assert.equal(kept.result.verification.status, "matched", JSON.stringify(kept.result.verification));
  assert.ok((await read(P.filtered)).rows.some((r: any) => r.attribute === "Dimmer"), "the Dimmer is stored in the Color pool");
  await run(`Fixture ${PARS[0]}`, 'Attribute "ColorRGB_R" At 10');
  const exists = await store({ preset: P.filtered, fixtures: [PARS[0]], mode: "selective", input_filter: false });
  assert.match(exists.result.steps.find((s: any) => s.name === "check_preset").error, /already exists/);
  await run("ClearAll");
  const empty = await store({ preset: P.fade, fixtures: [PARS[0]], mode: "selective" });
  assert.match(empty.result.steps.find((s: any) => s.name === "check_content").error, /holds no values/);
  await run(`Fixture ${PARS[0]}`, 'Attribute "Dimmer" At 60 Fade 2');
  const noFade = await store({ preset: P.fade, fixtures: [PARS[0]], mode: "selective" });
  assert.match(noFade.result.steps.find((s: any) => s.name === "check_content").error, /layers that were not requested \(fade\)/);
  const withFade = await store({ preset: P.fade, fixtures: [PARS[0]], mode: "selective", layers: ["absolute", "fade"] });
  assert.equal(withFade.result.verification.status, "matched", JSON.stringify(withFade.result.verification));
  assert.equal((await read(P.fade)).rows.find((r: any) => r.attribute === "Dimmer").fade, 2);
  for (const r of [unrequested, divergent, dropped, exists, empty, noFade]) assert.equal(r.result.steps.some((s: any) => s.name === "store"), false, "refusals send nothing");

  // 4. An embedded preset follows its source; a copied one keeps the values.
  await run("ClearAll", ...sel(PARS.slice(0, 2)), `At Preset ${P.blue}`);
  const emb = await store({ preset: P.embedded, fixtures: PARS.slice(0, 2), mode: "selective", embed: true, keep_activation: true });
  assert.equal(emb.isError, false, JSON.stringify(emb.result));
  assert.equal(emb.result.verification.status, "matched", JSON.stringify(emb.result.verification));
  const copy = await store({ preset: P.copied, fixtures: PARS.slice(0, 2), mode: "selective", embed: false, existing: "refuse" });
  assert.equal(copy.result.verification.status, "matched", JSON.stringify(copy.result.verification));
  assert.ok(copy.result.warnings?.some((w: string) => /stored as plain values/.test(w)), JSON.stringify(copy.result.warnings));
  const before = await read(P.embedded);
  assert.equal(before.dependencies.length, 1);
  assert.equal(before.dependencies[0].valid, true);
  // Update the source: blue -> red, overwrite.
  await run("ClearAll", ...sel([...PARS, ...CELLS]), 'Attribute "ColorRGB_R" At 100', 'Attribute "ColorRGB_G" At 0', 'Attribute "ColorRGB_B" At 0');
  const upd = await store({ preset: P.blue, fixtures: [...PARS, ...CELLS], mode: "global", existing: "overwrite" });
  assert.equal(upd.result.verification.status, "matched", JSON.stringify(upd.result.verification));
  await sleep(300);
  const embAfter = await read(P.embedded);
  const copyAfter = await read(P.copied);
  const valueOf = (p: any, attr: string) => p.rows.find((r: any) => r.fixture === PARS[0] && r.attribute === attr)?.value;
  t.diagnostic(`after the source update: embedded R=${valueOf(embAfter, "ColorRGB_R")} B=${valueOf(embAfter, "ColorRGB_B")}, copied R=${valueOf(copyAfter, "ColorRGB_R")} B=${valueOf(copyAfter, "ColorRGB_B")}`);
  assert.equal(valueOf(embAfter, "ColorRGB_R"), 100, "the embedded preset follows its source");
  assert.equal(valueOf(embAfter, "ColorRGB_B"), 0);
  assert.equal(valueOf(copyAfter, "ColorRGB_B"), 100, "the copied preset keeps the old values");
  assert.equal(embAfter.dependencyInspection.complete, true);
  assert.equal(embAfter.rows.find((r: any) => r.fixture === PARS[0] && r.attribute === "ColorRGB_R").embeddedFrom.startsWith(`Preset ${P.blue}`), true);

  // 5. Forced conversion: Selective/Global -> Global.
  await run("ClearAll", ...sel(PARS), 'Attribute "ColorRGB_R" At 100', 'Attribute "ColorRGB_G" At 0', "ClearSelection", `Fixture ${PARS[1]}`, 'Attribute "ColorRGB_G" At 50');
  const mixed = await store({ preset: P.convert, fixtures: PARS, mode: "global" });
  assert.equal(mixed.result.verification.status, "matched", JSON.stringify(mixed.result.verification));
  assert.equal((await read(P.convert)).storedData, "Selective/Global");
  await run("ClearAll", ...sel(PARS), 'Attribute "ColorRGB_R" At 100', 'Attribute "ColorRGB_G" At 20');
  const forced = await store({ preset: P.convert, fixtures: PARS, force: "global", existing: "merge" });
  assert.equal(forced.isError, false, JSON.stringify(forced.result));
  assert.equal(forced.result.verification.status, "matched", JSON.stringify(forced.result.verification));
  const convRead = await read(P.convert);
  assert.equal(convRead.storedData, "Global");
  assert.ok(convRead.rows.every((r: any) => r.mode === "global"), "no selective data is left");
});
