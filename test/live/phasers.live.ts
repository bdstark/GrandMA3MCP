/**
 * Live console test for SB-04 (gma3_build_phaser, gma3_phaser_release; reads with gma3_preset).
 *
 * NOT run by `npm test`. Run on purpose against a disposable show with an EMPTY programmer in the Normal environment,
 * the operator's StoreLook preference off and bridge 0.23.0:
 *   GMA3_LIVE=1 node --import tsx --test test/live/phasers.live.ts
 *
 * Fixtures (defaults match mcp-test-disposable): RGB + Dimmer fixtures GMA3_LIVE_PHASER_PARS ("401,402,403,404"),
 * movers GMA3_LIVE_PHASER_MOVERS ("601,602,701,702,703,704"), a fixture for the unrelated Normal-programmer value
 * GMA3_LIVE_PHASER_OTHER ("702"), colour presets GMA3_LIVE_PHASER_COLORS ("4.4,4.6", must exist).
 *
 * Show objects this file creates and deletes (reserved ranges, see README.md):
 *   - Presets 23.911-23.916   stored by the tool; deleted at the end.
 *   - Group 907               stored with gma3_store_group for the group case; deleted at the end.
 *   - the programmer          the tool builds in the Preview environment; the test puts one unrelated value into the
 *                             Normal programmer (Dimmer of GMA3_LIVE_PHASER_OTHER) to prove it survives each build,
 *                             and clears it before the audition. ClearAll at the end.
 *   The test refuses to run when any of those objects exists. Nothing calls SaveShow.
 *
 * What it demonstrates (SB-04 acceptance criteria):
 *   1. The three templates (two-step dimmer chase, alternating colours, pan/tilt circle) stored and read back step by
 *      step: values, step timing, phase per fixture, speed.
 *   2. A custom phaser with every layer: sine steps with width, reverse phase, measure, speed master.
 *   3. Steps made of presets, stored as references.
 *   4. A distribution over a stored group's grid with mirrored (wings) phase.
 *   5. Unsupported attributes and an audition on a busy programmer refused before anything is sent.
 *   6. The unrelated Normal-programmer value is unchanged after every build; an explicit audition plays the effect and
 *      is released; gma3_phaser_release has nothing to do afterwards.
 */
import assert from "node:assert/strict";
import { liveTest, cmd } from "./live.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { MutationLock } from "../../src/mutations.ts";
import type { ToolContext } from "../../src/tools/context.ts";
import { registerPhaserTools } from "../../src/tools/phasers.ts";
import { registerPresetTools } from "../../src/tools/presets.ts";
import { registerGroupTools } from "../../src/tools/groups.ts";

const env = process.env;
const list = (v: string | undefined, d: string) => (v ?? d).split(",").map((s) => s.trim());
const PARS = list(env.GMA3_LIVE_PHASER_PARS, "401,402,403,404");
const MOVERS = list(env.GMA3_LIVE_PHASER_MOVERS, "601,602,701,702,703,704");
const OTHER = env.GMA3_LIVE_PHASER_OTHER ?? "702";
const COLORS = list(env.GMA3_LIVE_PHASER_COLORS, "4.4,4.6");
const P = { chase: "23.911", alt: "23.912", circle: "23.913", custom: "23.914", presets: "23.915", group: "23.916" };
const GROUP = 907;

liveTest("SB-04: phasers built in Preview, stored and read back (Presets 23.911-916, Group 907)", async (t, bridge) => {
  const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 15000, luaToolAllowed: false };
  const tools = new Map([...captureTools(registerPhaserTools, ctx), ...captureTools(registerPresetTools, ctx), ...captureTools(registerGroupTools, ctx)]);
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
  const build = (args: Record<string, unknown>) => call("gma3_build_phaser", { exclusive: true, ...args });
  const read = async (preset: string) => (await call("gma3_preset", { preset })).result;
  const rowsOf = (p: any, attr: string) => p.rows.filter((r: any) => r.attribute === attr);
  const prog = async () => (await bridge.request("programmer", {})) as { environment?: string; rows: Array<{ fid?: string; attribute?: string; value?: number }>; coverage?: { complete?: boolean } };
  const ok = (r: { result: any; isError: boolean }, what: string) => {
    assert.equal(r.isError, false, `${what}: ${JSON.stringify(r.result)}`);
    assert.equal(r.result.verification.status, "matched", `${what}: ${JSON.stringify(r.result.verification)}`);
    assert.equal(r.result.normalProgrammerUntouched, true, `${what}: the Normal programmer changed`);
  };

  for (const id of Object.values(P)) assert.equal((await read(id)).exists, false, `Preset ${id} already exists`);
  for (const c of COLORS) assert.equal((await read(c)).exists, true, `colour preset ${c} is needed`);
  assert.equal((await call("gma3_selection_grid", { group: GROUP })).result.exists, false, `Group ${GROUP} already exists`);
  const start = await prog();
  if (start.environment !== "Normal" || start.coverage?.complete !== true || start.rows.length) {
    t.skip(`the console must be in the Normal environment with an empty programmer (environment ${start.environment}, ${start.rows.length} values)`);
    return;
  }
  t.after(async () => {
    await call("gma3_phaser_release", { clear_normal: true, exclusive: true }).catch(() => {});
    for (const id of Object.values(P)) await cmd(`Delete Preset ${id} /NoConfirmation`).catch(() => {});
    await cmd(`Delete Group ${GROUP} /NoConfirmation`).catch(() => {});
    await cmd("ClearAll").catch(() => {});
  });

  // The unrelated value every build must leave alone.
  for (const c of ["ClearSelection", `Fixture ${OTHER}`, 'Attribute "Dimmer" At 30', "ClearSelection"]) assert.equal(await cmd(c), "OK", c);

  // 1. Templates.
  ok(await build({ preset: P.chase, fixtures: PARS, template: { type: "dimmer_chase" }, name: "SB04 chase" }), "dimmer chase");
  const chase = rowsOf(await read(P.chase), "Dimmer");
  t.diagnostic(`chase: ${chase.map((r: any) => `${r.fixture} ${r.steps.map((s: any) => `${s.absolute}/t${s.trans ?? 100}`).join(",")} phase ${r.phase ?? 0}`).join(" | ")}`);
  assert.equal(chase.length, PARS.length);
  assert.ok(chase.every((r: any) => r.steps.length === 2 && r.steps[0].trans === 0 && r.steps[1].trans === 0));
  assert.deepEqual(chase.map((r: any) => r.phase ?? 0).sort((a: number, b: number) => a - b), [0, 90, 180, 270]);
  assert.ok(chase.every((r: any) => r.speedBpm === 120));

  ok(await build({ preset: P.alt, fixtures: PARS, template: { type: "alternating_colors", colors: [{ red: 100 }, { blue: 100 }] } }), "alternating colours");
  const alt = rowsOf(await read(P.alt), "ColorRGB_R");
  assert.deepEqual(PARS.map((f) => alt.find((r: any) => r.fixture === f)?.phase ?? 0), [0, 180, 0, 180]);

  ok(await build({ preset: P.circle, fixtures: MOVERS, template: { type: "pan_tilt", pan: 30, tilt: 15, spread: true } }), "pan/tilt circle");
  const pans = rowsOf(await read(P.circle), "Pan");
  assert.equal(pans.length, MOVERS.length);
  assert.ok(pans.every((r: any) => r.steps.length === 4 && r.steps[0].accel < -99 && r.steps[1].relative === 0));

  // 2. Every layer.
  ok(await build({ preset: P.custom, fixtures: PARS, steps: [{ values: { Dimmer: 100 }, accel: -100, decel: -100 }, { values: { Dimmer: 10 }, accel: -100, decel: -100, width: 50 }], phaser: { speed_bpm: 90, phase: { from: 270, to: 0 }, measure: 2, speed_master: 3 } }), "custom");
  const custom = rowsOf(await read(P.custom), "Dimmer");
  const first = custom.find((r: any) => r.fixture === PARS[0]);
  t.diagnostic(`custom ${PARS[0]}: ${JSON.stringify(first)}`);
  assert.equal(first.phase, 270, "reverse phase starts at 270");
  assert.equal(first.steps[1].width, 50);
  assert.equal(first.speedBpm, 90);
  assert.equal(first.measure, 2);
  assert.equal(first.speedMaster, 3);

  // 3. Steps from presets, stored as references.
  ok(await build({ preset: P.presets, fixtures: PARS, template: { type: "alternating_colors", colors: COLORS.map((c) => ({ preset: c })), snap: true } }), "preset steps");
  const pr = await read(P.presets);
  assert.equal(pr.dependencyInspection.complete, true);
  assert.ok(pr.dependencies.length >= 2 && pr.dependencies.every((d: any) => d.valid));

  // 4. A stored group's grid with mirrored phase.
  const g = await call("gma3_store_group", { group: GROUP, arrangement: { type: "row", fixtures: PARS }, exclusive: true });
  assert.equal(g.result.verification.status, "matched", JSON.stringify(g.result));
  ok(await build({ preset: P.group, group: GROUP, steps: [{ values: { Dimmer: 100 } }, { values: { Dimmer: 0 } }], phaser: { phase: { from: 0, to: 90 }, repeat: { wings: 2 } } }), "group with wings");
  const wings = rowsOf(await read(P.group), "Dimmer");
  assert.deepEqual(PARS.map((f) => wings.find((r: any) => r.fixture === f)?.phase ?? 0), [0, 90, 90, 0]);

  // 5. Refusals before anything is sent.
  const unsup = await build({ preset: "23.917", fixtures: PARS, template: { type: "pan_tilt" } });
  assert.match(unsup.result.steps.find((s: any) => s.name === "resolve_fixtures").error, /has no Pan, Tilt/);
  const busy = await build({ preset: "23.917", fixtures: PARS, template: { type: "dimmer_chase" }, audition_ms: 500 });
  assert.match(busy.result.steps.find((s: any) => s.name === "read_normal_programmer").error, /needs an empty Normal programmer/);
  const other = (await prog()).rows.find((r) => r.fid === OTHER && r.attribute === "Dimmer");
  assert.ok(other && Math.abs((other.value ?? 0) - 30) < 0.5, "the unrelated Normal value survived every build");

  // 6. An explicit audition, then release.
  assert.equal(await cmd("ClearAll"), "OK");
  const aud = await build({ preset: P.chase, fixtures: PARS, template: { type: "dimmer_chase" }, existing: "overwrite", audition_ms: 1500 });
  ok(aud, "audition");
  assert.deepEqual(aud.result.audition, { ms: 1500, released: true });
  const rel = await call("gma3_phaser_release", {});
  assert.match(rel.result.summary, /nothing was sent/);
  assert.equal((await prog()).rows.length, 0);
});
