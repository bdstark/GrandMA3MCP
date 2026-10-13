/**
 * Live console test for SB-06 (gma3_speed_masters, gma3_configure_speed_master, gma3_speed_master_action,
 * gma3_observe_tempo, and the tempo links of gma3_configure_sequence).
 *
 * NOT run by `npm test`. Run on purpose against a disposable show with an EMPTY programmer and bridge 0.24.0:
 *   GMA3_LIVE=1 node --import tsx --test test/live/speed.live.ts
 *
 * Fixtures (defaults match mcp-test-disposable): GMA3_LIVE_SPEED_FIXTURES ("401,402,403", one per chase, with Dimmer).
 * Speed master GMA3_LIVE_SPEED_MASTER (14) must not be locked and no sequence may follow it.
 *
 * Show objects this file creates, changes and deletes (reserved ranges, see README.md):
 *   - Sequences 907, 908, 909      four-cue chases (Time 0.5 s, Wrap Around) created by the test; deleted at the end.
 *   - Page 90 / 90.212             the master on an executor (Page 90 created when missing); removed at the end.
 *   - Speed master 14              tempo, scale and learn mode changed; restored at the end to what they were.
 *   - the programmer               used to store the cues; ClearAll afterwards.
 *   The test refuses to run when any of the sequences or the executor exists. Nothing calls SaveShow.
 *
 * What it demonstrates (SB-06 acceptance criteria):
 *   1. Two chases follow the master by rate while a third, independent chase is unaffected: the step intervals are
 *      measured (observed) and compared with the configured prediction at 60 and 120 BPM.
 *   2. Manual tempo (BPM and Hz), double/half/reset and tap tempo (Learn) as separate verified actions.
 *   3. The master's followers and executor are reported; the executor fader moves the master (the control path a
 *      surface uses); the sound input is reported without claiming synchronisation.
 */
import assert from "node:assert/strict";
import { liveTest, cmd } from "./live.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { MutationLock } from "../../src/mutations.ts";
import type { ToolContext } from "../../src/tools/context.ts";
import { registerSpeedTools } from "../../src/tools/speed.ts";
import { registerPlaybackTools } from "../../src/tools/playback.ts";

const env = process.env;
const FIX = (env.GMA3_LIVE_SPEED_FIXTURES ?? "401,402,403").split(",").map((s) => s.trim());
const M = Number(env.GMA3_LIVE_SPEED_MASTER ?? 14);
const SEQS = [907, 908, 909];
const PAGE = 90;
const EXEC = 212;

liveTest(`SB-06: two chases follow speed master ${M} by rate, a third does not (Sequences 907-909, Page 90.212)`, async (t, bridge) => {
  const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 15000, luaToolAllowed: false };
  const tools = captureTools((s, c) => { registerSpeedTools(s, c); registerPlaybackTools(s, c); }, ctx);
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
  const ok = (r: { result: any; isError: boolean }, what: string) => {
    assert.equal(r.isError, false, `${what}: ${JSON.stringify(r.result)}`);
    assert.equal(r.result.verification.status, "matched", `${what}: ${JSON.stringify(r.result.verification)} ${JSON.stringify(r.result.steps?.filter((s: any) => s.status !== "succeeded"))}`);
  };
  const run = async (...commands: string[]) => {
    for (const c of commands) assert.equal(await cmd(c), "OK", c);
  };
  const absent = async (ref: string) => {
    const r = (await bridge.request("objects", { ref, fields: [], limit: 1 }).catch(() => null)) as { items?: unknown[] } | null;
    return !r?.items?.length;
  };

  // Preconditions.
  for (const s of SEQS) assert.ok(await absent(`Sequence ${s}`), `Sequence ${s} already exists`);
  const pageExisted = !(await absent(`Page ${PAGE}`));
  if (pageExisted) assert.ok(await absent(`Page ${PAGE}.${EXEC}`), `Page ${PAGE}.${EXEC} is not empty`);
  const prog = (await bridge.request("programmer", {})) as { rows?: unknown[]; coverage?: { complete?: boolean } };
  if (prog.coverage?.complete !== true || (prog.rows ?? []).length) {
    t.skip("the programmer is not confirmed empty; clear it first");
    return;
  }
  const first = (await call("gma3_speed_masters", { masters: [M], sound: false })).result;
  const saved = first.masters[0];
  assert.equal(saved.locked, false, `speed master ${M} is locked`);
  assert.deepEqual([...first.usage[0].speedOf, ...first.usage[0].rateOf], [], `sequences already follow speed master ${M}`);
  t.diagnostic(`master ${M} before: ${saved.name} ${saved.baseBpm} BPM x${saved.speedScale.factor}, learn ${saved.learnMode}`);

  let createdPage = false;
  t.after(async () => {
    for (const s of SEQS) await cmd(`Off Sequence ${s}`).catch(() => {});
    await cmd(`Delete Page ${PAGE}.${EXEC} /NoConfirmation`).catch(() => {});
    if (createdPage) await cmd(`Delete Page ${PAGE} /NoConfirmation`).catch(() => {});
    for (const s of SEQS) await cmd(`Delete Sequence ${s} /NoConfirmation`).catch(() => {});
    await cmd("ClearAll").catch(() => {});
    // Restore the master: scale first, then the tempo (effective under that scale), then the learn mode.
    await bridge.request("set", { ref: `Master 3.${M}`, property: "SpeedScale", value: saved.speedScale.name }).catch(() => {});
    await cmd(`Master 3.${M} At BPM ${saved.effectiveBpm}`).catch(() => {});
    const lm = { ignore_scale: "Learn Ignores Speed Scale", respect_scale: "Learn Respects Speed Scale", auto_increase_scale: "Auto Increase Speed Scale" }[saved.learnMode as string];
    if (lm) await bridge.request("set", { ref: `Master 3.${M}`, property: "LearnMode", value: lm }).catch(() => {});
  });

  // Three four-cue chases, 0.5 s per cue, looping.
  for (const [i, s] of SEQS.entries()) {
    for (let c = 1; c <= 4; c++) await run("ClearAll", `Fixture ${FIX[i]} At ${c * 25}`, `Store Sequence ${s} Cue ${c} /NoConfirmation`);
    await bridge.request("set", { ref: `Sequence ${s}`, property: "WrapAround", value: "Yes" });
    for (let c = 1; c <= 4; c++) {
      await bridge.request("set", { ref: `Sequence ${s} Cue ${c}`, property: "TrigType", value: "Time" });
      await bridge.request("set", { ref: `Sequence ${s} Cue ${c}`, property: "TrigTime", value: "0.5" });
    }
  }
  await run("ClearAll");

  // 1. Link two of them by rate.
  for (const s of SEQS.slice(0, 2)) ok(await call("gma3_configure_sequence", { sequence: s, rate_master: M }), `link Sequence ${s}`);
  ok(await call("gma3_configure_speed_master", { master: M, bpm: 60, speed_scale: "One", learn_mode: "ignore_scale" }), "60 BPM");
  await run(...SEQS.map((s) => `Go+ Sequence ${s}`));
  const measure = async (label: string) => {
    const r = (await call("gma3_observe_tempo", { sequences: SEQS, seconds: 4 })).result;
    t.diagnostic(`${label}: ${r.sequences.map((s: any) => `${s.sequence} observed ${s.observed.meanStepMs} ms (predicted ${s.configured.predictedStepMs}, rate ${s.configured.rate})`).join("; ")}`);
    return Object.fromEntries(r.sequences.map((s: any) => [s.sequence, s]));
  };
  const near = (s: any, ms: number, what: string) => {
    assert.equal(s.configured.predictedStepMs, ms, `${what}: predicted`);
    assert.ok(s.observed.cueChanges >= 3, `${what}: ${JSON.stringify(s.observed)}`);
    assert.ok(Math.abs(s.observed.meanStepMs / ms - 1) < 0.15, `${what}: observed ${s.observed.meanStepMs} ms, expected ${ms}`);
  };
  const at60 = await measure("60 BPM");
  for (const s of SEQS) near(at60[s], 500, `Sequence ${s} at 60 BPM`);

  ok(await call("gma3_configure_speed_master", { master: M, hz: 2 }), "120 BPM");
  const at120 = await measure("120 BPM");
  near(at120[907], 250, "Sequence 907 follows");
  near(at120[908], 250, "Sequence 908 follows");
  near(at120[909], 500, "Sequence 909 is independent");

  // 2. Double, half, reset, tap.
  const dbl = await call("gma3_speed_master_action", { master: M, action: "double" });
  ok(dbl, "double");
  assert.equal(dbl.result.after.effectiveBpm, 240);
  ok(await call("gma3_speed_master_action", { master: M, action: "half" }), "half");
  ok(await call("gma3_speed_master_action", { master: M, action: "reset" }), "reset");
  const tap = await call("gma3_speed_master_action", { master: M, action: "learn", taps: 4, interval_ms: 500 });
  ok(tap, "tap");
  t.diagnostic(`tapped ${JSON.stringify(tap.result.tapped)} -> ${tap.result.after.effectiveBpm} BPM`);

  // 3. Followers, the executor and the sound input.
  if (!pageExisted) {
    await run(`Store Page ${PAGE} /NoConfirmation`);
    createdPage = true;
  }
  await run(`Assign Master 3.${M} At Page ${PAGE}.${EXEC}`);
  await run(`FaderMaster Page ${PAGE}.${EXEC} At 75`);
  await new Promise((r) => setTimeout(r, 200));
  const read = (await call("gma3_speed_masters", { masters: [M, 16] })).result;
  const m = read.masters.find((x: any) => x.master === M);
  const u = read.usage.find((x: any) => x.master === M);
  t.diagnostic(`after the executor fader: ${m.baseBpm} BPM (${m.consoleText}); followers ${JSON.stringify(u.rateOf)}; executors ${u.executors}; sound ${JSON.stringify({ device: read.sound.inputDevice, listed: read.sound.deviceListed, level: read.sound.soundInLevel, bpm: read.sound.bpmMaster })}`);
  assert.ok(Math.abs(m.fader - 75) < 0.01, "the executor fader moved the master");
  assert.ok(Math.abs(m.baseBpm - 130) < 1);
  assert.deepEqual(u.rateOf.map((r: any) => r.sequence), [907, 908]);
  assert.deepEqual(u.executors, [`Page ${PAGE}.${EXEC}`]);
  assert.equal(read.sound.beatDetection, "unavailable");
});
