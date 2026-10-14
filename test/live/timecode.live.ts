/**
 * Live console test for SB-08 (gma3_timecodes, gma3_build_timecode, gma3_timecode_transport).
 *
 * NOT run by `npm test`. Run on purpose against a disposable show with an EMPTY programmer and bridge 0.25.0:
 *   GMA3_LIVE=1 node --import tsx --test test/live/timecode.live.ts
 *
 * Show objects this file creates and deletes (reserved ranges, see README.md):
 *   - Timecode 901            the timed show; deleted at the end.
 *   - Sequences 908 and 909   908 with three empty cues (the cue track), 909 with one (the Flash press/release track);
 *                             deleted at the end.
 *   The test refuses to run when any of them exists. Nothing calls SaveShow; nothing records.
 *
 * What it demonstrates (SB-08 acceptance criteria):
 *   1. A missing target is refused before anything is created.
 *   2. A short timed show (seconds and 25 fps frames, events given out of order) built, read back exactly in time order.
 *   3. Playback verified event by event against the sequences' observed cue changes; repeated playback after rewind;
 *      seeking past events; stopping; a Flash press/release pair.
 *   4. A deleted target reported (the console removes that track's events with it); replace mode rebuilds the show.
 */
import assert from "node:assert/strict";
import { liveTest, cmd } from "./live.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { MutationLock } from "../../src/mutations.ts";
import type { ToolContext } from "../../src/tools/context.ts";
import { registerTimecodeTools, toRaw } from "../../src/tools/timecode.ts";
import { exists } from "../../src/tools/common.ts";

const TC = 901;
const CUES = 908;
const FLASH = 909;

liveTest(`SB-08: a timed cue show built, read back and played (Timecode ${TC}, Sequences ${CUES}-${FLASH})`, async (t, bridge) => {
  const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 15000, luaToolAllowed: false };
  const tools = captureTools(registerTimecodeTools, ctx);
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
    assert.equal(r.isError, false, `${what}: ${JSON.stringify(r.result).slice(0, 2000)}`);
    assert.equal(r.result.verification.status, "matched", `${what}: ${JSON.stringify(r.result.verification)}`);
  };
  const run = async (...commands: string[]) => {
    for (const c of commands) assert.equal(await cmd(c), "OK", c);
  };
  // Only a confirmed empty read or not-found is "absent": the cleanup deletes these objects.
  const absent = async (ref: string) => {
    const e = await exists(bridge, ref);
    assert.notEqual(e.exists, "unknown", `could not check ${ref}: ${"error" in e ? e.error : ""}`);
    return e.exists === false;
  };
  const transport = (action: string, extra: Record<string, unknown> = {}) => call("gma3_timecode_transport", { timecode: TC, action, ...extra });
  const summary = (r: any) => (r.result.events ?? []).map((e: any) => `${e.time} ${e.action}${e.cue ? ` ${e.cue}` : ""} -> ${e.expected ? `${e.expected.active ? `cue ${e.expected.cue}` : "off"}` : "?"} ${e.observed ? `seen at ${e.observed.cursor ?? "(already)"}` : "NOT SEEN"}`).join("; ");

  for (const ref of [`Timecode ${TC}`, `Sequence ${CUES}`, `Sequence ${FLASH}`]) assert.ok(await absent(ref), `${ref} already exists`);
  const prog = (await bridge.request("programmer", {})) as { rows?: unknown[]; coverage?: { complete?: boolean } };
  if (prog.coverage?.complete !== true || (prog.rows ?? []).length) {
    t.skip("the programmer is not confirmed empty; clear it first");
    return;
  }
  t.after(async () => {
    for (const c of [`Off Timecode ${TC}`, `Off Sequence ${CUES}`, `Off Sequence ${FLASH}`, `Delete Timecode ${TC} /NoConfirmation`, `Delete Sequence ${CUES} /NoConfirmation`, `Delete Sequence ${FLASH} /NoConfirmation`, "ClearAll"]) await cmd(c).catch(() => {});
  });

  // 1. A missing target refuses the build.
  const missing = await call("gma3_build_timecode", { timecode: TC, mode: "create", tracks: [{ sequence: CUES, events: [{ at: 1, action: "go" }] }] });
  assert.match(missing.result.steps.find((s: any) => s.name === "check_targets").error, new RegExp(`Sequence ${CUES}`));
  assert.ok(await absent(`Timecode ${TC}`), "nothing was created");

  await run("ClearAll", ...[1, 2, 3].map((c) => `Store Sequence ${CUES} Cue ${c} /NoConfirmation`), `Store Sequence ${FLASH} Cue 1 /NoConfirmation`);

  // 2. Build: events given out of order, one in frames.
  const tracks = [
    { sequence: CUES, events: [{ at: 3.0, action: "go" }, { at: 1.0, action: "go" }, { at: "0:00:02:12", action: "goto", cue: 1 }, { at: 2.0, action: "go" }, { at: 3.5, action: "off" }] },
    { sequence: FLASH, events: [{ at: 0.5, action: "flash_press" }, { at: 1.5, action: "flash_release" }] },
  ];
  const built = await call("gma3_build_timecode", { timecode: TC, mode: "create", name: "SB08 Show", fps: 25, settings: { loop_mode: "off", switch_off: "off" }, tracks });
  ok(built, "build");
  assert.equal(built.result.played, false);
  const read = (await call("gma3_timecodes", { timecode: TC, fps: 25 })).result;
  t.diagnostic(`read: ${read.tracks.map((tr: any) => `${tr.sequence}: ${tr.events.map((e: any) => `${e.time} ${e.action}`).join(", ")}`).join(" | ")}`);
  assert.equal(read.playing, false, "building did not play");
  assert.deepEqual(read.tracks[0].events.map((e: any) => [e.raw, e.action]), [[toRaw(1), "go"], [toRaw(2), "go"], [toRaw(2.48), "goto"], [toRaw(3), "go"], [toRaw(3.5), "off"]]);
  assert.deepEqual(read.tracks[1].events.map((e: any) => e.action), ["flash_press", "flash_release"]);
  assert.deepEqual(read.source.tcSlot, { source: "internal" });
  assert.deepEqual(read.problems, []);

  // 3. Play, verified event by event; then the Flash track's sequence is off again.
  const play = await transport("play", { observe_seconds: 5 });
  t.diagnostic(`play: ${summary(play)}`);
  ok(play, "play");
  assert.deepEqual(play.result.events.filter((e: any) => e.sequence === CUES).map((e: any) => e.action), ["go", "go", "goto", "go", "off"]);
  assert.ok(play.result.events.filter((e: any) => e.sequence === CUES).every((e: any) => e.observed), "every cue event was seen in order");
  const flashSeen = play.result.execution.observed.changes.filter((c: any) => c.sequence === FLASH).map((c: any) => [c.active, c.cursor]);
  t.diagnostic(`flash track: ${JSON.stringify(flashSeen)}`);
  assert.equal(flashSeen[0]?.[0], true, "the press ran the sequence");
  assert.equal(flashSeen.at(-1)?.[0], false, "the release stopped it");
  // Each sample reads the cursor just before the sequences, so a change can carry a cursor slightly before its event.
  assert.ok(flashSeen[0][1] >= 0.4 && flashSeen.at(-1)[1] >= 1.4, `at the press and release times (${JSON.stringify(flashSeen)})`);
  assert.equal(play.result.execution.observed.playing, false, "LoopMode off stopped at the end");

  // Repeated playback.
  ok(await transport("rewind"), "rewind");
  const again = await transport("play", { observe_seconds: 5 });
  t.diagnostic(`again: ${summary(again)}`);
  ok(again, "repeated play");

  // Seek past the first events: only the later ones run.
  ok(await transport("seek", { to: 2.2 }), "seek");
  const late = await transport("play", { observe_seconds: 3 });
  t.diagnostic(`from 2.2 s: ${summary(late)}`);
  ok(late, "play from 2.2 s");
  assert.deepEqual(late.result.events.filter((e: any) => e.sequence === CUES).map((e: any) => e.action), ["goto", "go", "off"]);

  // Stop in the middle.
  ok(await transport("rewind"), "rewind 2");
  await transport("play", { observe_seconds: 1.2 });
  const stop = await transport("stop");
  ok(stop, "stop");
  const stopped = (await call("gma3_timecodes", { timecode: TC })).result;
  assert.equal(stopped.playing, false);
  assert.ok(stopped.cursorSeconds > 1 && stopped.cursorSeconds < 2.5, `the cursor stayed where it stopped (${stopped.cursorSeconds})`);

  // 4. A deleted target; replace mode.
  await run(`Off Sequence ${FLASH}`, `Delete Sequence ${FLASH} /NoConfirmation`);
  const orphan = (await call("gma3_timecodes", { timecode: TC })).result;
  t.diagnostic(`after deleting Sequence ${FLASH}: ${orphan.problems.join("; ")}`);
  // The console removes the track's events with its target: the track stays, empty and without a target.
  assert.match(orphan.problems.join(), /group 1 track 2 has no target/);
  assert.equal(orphan.tracks[1].events.length, 0);
  assert.equal(orphan.tracks[0].events.length, 5, "the other track is untouched");
  const rep = await call("gma3_build_timecode", { timecode: TC, mode: "replace", tracks: [{ sequence: CUES, events: [{ at: 0.5, action: "goto", cue: 3 }, { at: 1, action: "off" }] }] });
  ok(rep, "replace");
  const final = (await call("gma3_timecodes", { timecode: TC })).result;
  assert.equal(final.groups.length, 1);
  assert.equal(final.name, "SB08 Show", "replace keeps the show and its settings");
  assert.equal(final.playback.loopMode, "Off");
});
