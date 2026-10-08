/**
 * Live console test for the FR-04 / FR-05 cue tools (gma3_store_cue, gma3_store_cue_part,
 * gma3_set_cue_timing, gma3_set_cue_trigger, gma3_goto_cue, gma3_delete_cue).
 *
 * Runs only with GMA3_LIVE=1 against a disposable show (see README.md in this folder). Not part of
 * `npm test`.
 *
 * Show objects used — Sequence 900 ONLY:
 *   - Creates Sequence 900 (if absent) by storing Cue 1, Cue 2 and Cue 2.5 into it, plus Part 1 of Cue 2.
 *   - Edits timing of Cue 2 Part 0 and Part 1, the trigger of Cue 2.5, and sends Goto Sequence 900 Cue 2
 *     (a playback mutation: Sequence 900 is started as a playback; its output is whatever the programmer
 *     held when the cues were stored — the test stores with an empty programmer, so the cues are empty).
 *   - Deletes Cue 2.5 through the tool, then removes the whole sequence with
 *     `Delete Sequence 900 /NoConfirmation` and `Off Sequence 900` in cleanup.
 *   - Nothing else is touched. The programmer and selection are not changed by the tools; the test does
 *     not clear the programmer either (store with whatever the operator has active would put values in
 *     the disposable cues, which is harmless in a disposable show).
 *
 * Procedure (what a reviewer should see in the console):
 *   1. Sequence 900 appears with cues 1, 2 and 2.5; cue 2 is named "MCP live 2" (set on part 0), cue 2 part 0
 *      has CueInFade 3 / CueOutFade 1.5 / CueInDelay 0; cue 2 part 1 exists with CueInDelay 0.5. A name
 *      containing "." is refused by validation without touching the console.
 *   2. Cue 2.5 is set to TrigType Follow, then TrigType Time with TrigTime 4, then back to Go.
 *   3. Goto Sequence 900 Cue 2 is accepted (the sequence shows cue 2 as current).
 *   4. Cue 2.5 is deleted; cues 1 and 2 remain. Cleanup then deletes Sequence 900.
 */
import assert from "node:assert/strict";
import { after } from "node:test";
import { MutationLock } from "../../src/mutations.ts";
import { registerCueTools } from "../../src/tools/cues.ts";
import type { ToolContext } from "../../src/tools/context.ts";
import { exists, readFields } from "../../src/tools/common.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { liveTest, liveEnabled, cmd, bridge } from "./live.ts";

const SEQ = 900;
const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 15000, luaToolAllowed: false };
const tools = captureTools(registerCueTools, ctx);

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
  return r.result;
};

let created = false;

after(async () => {
  if (!liveEnabled || !created) return;
  try {
    await cmd(`Off Sequence ${SEQ}`);
    await cmd(`Delete Sequence ${SEQ} /NoConfirmation`);
  } catch {
    // cleanup is best effort; the sequence is in the reserved live-test range
  }
});

liveTest("cue tools: store, part, timing, trigger, goto and delete on Sequence 900", async (t, b) => {
  const pre = await exists(b, `Sequence ${SEQ}`);
  if (pre.exists === true) {
    t.skip(`Sequence ${SEQ} already exists in this show; remove it before running the cue live test`);
    return;
  }
  created = true;

  // --- FR-04 store ----------------------------------------------------------------------------
  const c1 = ok(await call("gma3_store_cue", { sequence: SEQ, cue: 1, mode: "create", name: "MCP live 1" }), "store cue 1");
  assert.equal(c1.verification.status, "matched", JSON.stringify(c1.verification));

  // Create mode must refuse the cue that now exists, without sending anything.
  const dup = await call("gma3_store_cue", { sequence: SEQ, cue: 1, mode: "create" });
  assert.equal(dup.isError, true);
  assert.equal(dup.result.steps[0].name, "check_existing");
  assert.equal(dup.result.steps[0].status, "failed");
  assert.ok(dup.result.steps.every((s: { op?: string }) => s.op !== "cmd"));

  // Names with characters the console strips are refused up front (nothing sent).
  const badName = await call("gma3_store_cue", { sequence: SEQ, cue: 2, mode: "create", name: "Look 2.5" });
  assert.equal(badName.isError, true);
  assert.match(badName.result.validationErrors[0], /removes from names/);
  assert.equal((await exists(b, `Sequence ${SEQ} Cue 2`)).exists, false);

  // Split timing: in-fade 3, out-fade 1.5, delay explicitly 0; the name goes to Part 0 and shows on the cue.
  const c2 = ok(await call("gma3_store_cue", { sequence: SEQ, cue: 2, mode: "create", name: "MCP live 2", fade: 3, out_fade: 1.5, delay: 0 }), "store cue 2");
  assert.equal(c2.verification.status, "matched", JSON.stringify(c2.verification));
  const cue2 = await readFields(b, `Sequence ${SEQ} Cue 2`, ["Name"]);
  assert.equal(cue2?.Name, "MCP live 2");
  const p0 = await readFields(b, `Sequence ${SEQ} Cue 2 Part 0`, ["CueInFade", "CueOutFade", "CueInDelay"]);
  assert.ok(p0);
  assert.match(String(p0.CueInFade), /^3(\.0+)?/);
  assert.match(String(p0.CueOutFade), /^1\.5/);
  assert.match(String(p0.CueInDelay), /^0(\.0+)?/);

  // Fractional cue number.
  const c25 = ok(await call("gma3_store_cue", { sequence: SEQ, cue: "2.5", mode: "create" }), "store cue 2.5");
  assert.equal(c25.verification.status, "matched");
  const e25 = await exists(b, `Sequence ${SEQ} Cue 2.5`);
  assert.equal(e25.exists, true);

  // Merge into an existing cue sends /Merge and no pop-up blocks the console (the reply comes back).
  ok(await call("gma3_store_cue", { sequence: SEQ, cue: 2, mode: "merge" }), "merge cue 2");

  // Cue part 1 with its own delay.
  const part = ok(await call("gma3_store_cue_part", { sequence: SEQ, cue: 2, part: 1, mode: "create", name: "MCP part 1", delay: 0.5 }), "store part 1");
  assert.equal(part.verification.status, "matched", JSON.stringify(part.verification));
  const p1 = await readFields(b, `Sequence ${SEQ} Cue 2 Part 1`, ["CueInDelay", "Name"]);
  assert.ok(p1);
  assert.match(String(p1.CueInDelay), /^0\.5/);
  assert.equal(p1.Name, "MCP part 1");

  // --- FR-05 timing ---------------------------------------------------------------------------
  const tm = ok(await call("gma3_set_cue_timing", { sequence: SEQ, cue: 2, fade: 0, out_delay: 2 }), "set timing part 0");
  assert.equal(tm.verification.status, "matched", JSON.stringify(tm.verification));
  const after0 = await readFields(b, `Sequence ${SEQ} Cue 2 Part 0`, ["CueInFade", "CueOutFade", "CueOutDelay"]);
  assert.ok(after0);
  assert.match(String(after0.CueInFade), /^0(\.0+)?/);
  assert.match(String(after0.CueOutFade), /^1\.5/, "out_fade was not given, so it must be unchanged");
  assert.match(String(after0.CueOutDelay), /^2(\.0+)?/);
  ok(await call("gma3_set_cue_timing", { sequence: SEQ, cue: 2, part: 1, snap_delay: 0.1 }), "set snap delay part 1");

  // --- FR-05 trigger --------------------------------------------------------------------------
  const follow = ok(await call("gma3_set_cue_trigger", { sequence: SEQ, cue: 2.5, trigger: "follow" }), "trigger follow");
  assert.equal(follow.verification.status, "matched", JSON.stringify(follow.verification));
  const timed = ok(await call("gma3_set_cue_trigger", { sequence: SEQ, cue: 2.5, trigger: "time", time: 4 }), "trigger time 4");
  assert.equal(timed.verification.status, "matched", JSON.stringify(timed.verification));
  const trig = await readFields(b, `Sequence ${SEQ} Cue 2.5`, ["TrigType", "TrigTime"]);
  assert.ok(trig);
  assert.equal(String(trig.TrigType).toLowerCase(), "time");
  assert.match(String(trig.TrigTime), /^4(\.0+)?/);
  ok(await call("gma3_set_cue_trigger", { sequence: SEQ, cue: 2.5, trigger: "go" }), "trigger go");

  // --- FR-05 goto (playback) ------------------------------------------------------------------
  const gt = ok(await call("gma3_goto_cue", { sequence: SEQ, cue: 2, fade: 0 }), "goto cue 2");
  assert.equal(gt.verification.status, "not_requested");
  assert.match(gt.summary, /accepted/);

  // --- FR-05 delete ---------------------------------------------------------------------------
  const missing = await call("gma3_delete_cue", { sequence: SEQ, cue: 77 });
  assert.equal(missing.isError, true);
  assert.equal(missing.result.outcome, "failed");
  const del = ok(await call("gma3_delete_cue", { sequence: SEQ, cue: 2.5 }), "delete cue 2.5");
  assert.equal(del.verification.status, "matched", JSON.stringify(del.verification));
  assert.equal((await exists(b, `Sequence ${SEQ} Cue 2.5`)).exists, false);
  assert.equal((await exists(b, `Sequence ${SEQ} Cue 2`)).exists, true);
  assert.equal((await exists(b, `Sequence ${SEQ} Cue 1`)).exists, true);
});
