/**
 * Live console test for SB-07 (gma3_macros, gma3_store_macro, gma3_edit_macro_line, gma3_run_macro).
 *
 * NOT run by `npm test`. Run on purpose against a disposable show with an EMPTY programmer and bridge 0.24.0:
 *   GMA3_LIVE=1 node --import tsx --test test/live/macros.live.ts
 *
 * Show objects this file creates and deletes (reserved ranges, see README.md):
 *   - Macros 901, 902, 903   the setup, playback and manual-wait macros; deleted at the end.
 *   - Sequence 907           created by the setup macro (an empty cue); deleted at the end.
 *   The test refuses to run when any of them exists, and never touches other macros. Nothing calls SaveShow.
 *
 * What it demonstrates (SB-07 acceptance criteria):
 *   1. Creating never runs a macro; every line reads back with its exact text and order.
 *   2. A missing reference is refused before anything is sent; a Store earlier in the macro counts as creating its object.
 *   3. A setup macro (creates and labels a sequence), a playback macro (Go+ / timed wait / Off) and a macro with a manual
 *      (Go) wait, each run with dispatched and observed reported separately and their effects checked by the test.
 *   4. Lines are inserted, moved and removed; a command the console rewrites is reported.
 */
import assert from "node:assert/strict";
import { liveTest, cmd } from "./live.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { MutationLock } from "../../src/mutations.ts";
import type { ToolContext } from "../../src/tools/context.ts";
import { registerMacroTools } from "../../src/tools/macros.ts";
import { exists, readFields } from "../../src/tools/common.ts";

const SETUP = 901;
const PLAY = 902;
const HOLD = 903;
const SEQ = 907;

liveTest("SB-07: setup, playback and manual-wait macros created, inspected, edited and run (Macros 901-903, Sequence 907)", async (t, bridge) => {
  const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 15000, luaToolAllowed: false };
  const tools = captureTools(registerMacroTools, ctx);
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
    assert.equal(r.result.verification.status, "matched", `${what}: ${JSON.stringify(r.result.verification)}`);
  };
  // Only a confirmed empty read or not-found is "absent": the cleanup deletes these objects.
  const absent = async (ref: string) => {
    const e = await exists(bridge, ref);
    assert.notEqual(e.exists, "unknown", `could not check ${ref}: ${"error" in e ? e.error : ""}`);
    return e.exists === false;
  };
  const note = async (n: number) => (await readFields(bridge, `Macro ${n}`, ["Note"]))?.Note;

  for (const ref of [`Macro ${SETUP}`, `Macro ${PLAY}`, `Macro ${HOLD}`, `Sequence ${SEQ}`]) assert.ok(await absent(ref), `${ref} already exists`);
  const prog = (await bridge.request("programmer", {})) as { rows?: unknown[]; coverage?: { complete?: boolean } };
  if (prog.coverage?.complete !== true || (prog.rows ?? []).length) {
    t.skip("the programmer is not confirmed empty; clear it first");
    return;
  }
  t.after(async () => {
    for (const n of [SETUP, PLAY, HOLD]) await cmd(`Off Macro ${n}`).catch(() => {});
    await cmd(`Off Sequence ${SEQ}`).catch(() => {});
    for (const n of [SETUP, PLAY, HOLD]) await cmd(`Delete Macro ${n} /NoConfirmation`).catch(() => {});
    await cmd(`Delete Sequence ${SEQ} /NoConfirmation`).catch(() => {});
  });

  // 2. A missing reference refuses the store; nothing is created.
  const refused = await call("gma3_store_macro", { macro: PLAY, mode: "create", lines: [{ command: `Go+ Sequence ${SEQ}` }] });
  assert.match(refused.result.steps.find((s: any) => s.name === "check_references").error, new RegExp(`Sequence ${SEQ} does not exist`));
  assert.ok(await absent(`Macro ${PLAY}`), "nothing was created");

  // 1 + 3a. The setup macro: its Store counts as creating the sequence that the next lines use.
  const setupLines = [
    { command: `Store Sequence ${SEQ} Cue 1 /NoConfirmation`, name: "store" },
    { command: `Label Sequence ${SEQ} "SB07 Chase"` },
    { command: `Set Sequence ${SEQ} Property "WrapAround" "Yes"`, note: "loop" },
  ];
  const setup = await call("gma3_store_macro", { macro: SETUP, mode: "create", name: "SB07 Setup", lines: setupLines });
  ok(setup, "setup macro");
  assert.equal(setup.result.executed, false);
  assert.ok(await absent(`Sequence ${SEQ}`), "creating the macro did not run it");
  const read = (await call("gma3_macros", { macro: SETUP })).result;
  assert.deepEqual(read.lines.map((l: any) => l.command), setupLines.map((l) => l.command), "exact text and order");
  assert.deepEqual(read.lines.map((l: any) => [l.name, l.note]), [["store", ""], [null, ""], [null, "loop"]]);
  const runSetup = await call("gma3_run_macro", { macro: SETUP, action: "go", observe_seconds: 3 });
  t.diagnostic(`setup run: ${runSetup.result.summary}`);
  assert.equal(runSetup.result.execution.dispatched, true);
  assert.ok(["finished", "not_observed"].includes(runSetup.result.execution.observed.state), JSON.stringify(runSetup.result.execution));
  assert.equal(runSetup.result.verification.status, "unavailable", "launch success is never taken as every line succeeding");
  await new Promise((r) => setTimeout(r, 300));
  const seq = await readFields(bridge, `Sequence ${SEQ}`, ["Name", "WrapAround"]);
  assert.equal(seq?.Name, "SB07 Chase", "the setup lines took effect (checked by the test)");
  assert.equal(seq?.WrapAround, "Yes");

  // 3b. The playback macro: Go+, a timed wait, Off.
  ok(await call("gma3_store_macro", { macro: PLAY, mode: "create", name: "SB07 Playback", lines: [{ command: `Go+ Sequence ${SEQ}`, wait: 1.5 }, { command: `Off Sequence ${SEQ}` }] }), "playback macro");
  const started = Date.now();
  const playRun = call("gma3_run_macro", { macro: PLAY, action: "go", observe_seconds: 4 });
  await new Promise((r) => setTimeout(r, 700));
  const midway = (await bridge.request("object", { ref: `Sequence ${SEQ}`, properties: false })) as { hasActivePlayback?: boolean };
  const play = await playRun;
  t.diagnostic(`playback run: ${play.result.summary}; sequence active at 0.7 s: ${midway.hasActivePlayback}`);
  assert.equal(midway.hasActivePlayback, true, "the sequence ran during the wait");
  assert.equal(play.result.execution.observed.state, "finished");
  // A line shorter than the sampling interval (the Off line) may not be seen; the run ending after the wait is.
  assert.equal(play.result.execution.observed.linesSeen[0].line, 1);
  assert.ok(play.result.execution.observed.seconds >= 1.4, `the macro ended after the 1.5 s wait (${play.result.execution.observed.seconds} s)`);
  assert.ok(Date.now() - started >= 1500);
  const after = (await bridge.request("object", { ref: `Sequence ${SEQ}`, properties: false })) as { hasActivePlayback?: boolean };
  assert.equal(after.hasActivePlayback, false, "the Off line took effect");

  // 3c. The manual wait.
  ok(await call("gma3_store_macro", { macro: HOLD, mode: "create", name: "SB07 Manual", lines: [
    { command: `Set Macro ${HOLD} Property "Note" "before"`, wait: "go" },
    { command: `Set Macro ${HOLD} Property "Note" "after"` },
  ] }), "manual-wait macro");
  const hold = await call("gma3_run_macro", { macro: HOLD, action: "go", observe_seconds: 3 });
  t.diagnostic(`manual wait: ${hold.result.summary}`);
  assert.equal(hold.result.execution.observed.state, "paused_at_go");
  assert.equal(hold.result.execution.observed.pausedAt, 1);
  assert.equal(await note(HOLD), "before");
  const busy = await call("gma3_edit_macro_line", { macro: HOLD, action: "set", line: 2, command: "Echo x" });
  assert.match(JSON.stringify(busy.result.steps), /is running \(line 1\)/, "a running macro is not edited");
  const cont = await call("gma3_run_macro", { macro: HOLD, action: "go", observe_seconds: 3 });
  assert.equal(cont.result.execution.observed.state, "finished");
  assert.equal(await note(HOLD), "after");

  // 4. Edits and a rewritten command.
  const edit = (args: Record<string, unknown>) => call("gma3_edit_macro_line", { macro: SETUP, ...args });
  ok(await edit({ action: "insert", line: 2, command: 'Echo "inserted"', wait: 0.5 }), "insert");
  ok(await edit({ action: "move", line: 1, to: 3 }), "move down");
  ok(await edit({ action: "move", line: 3, to: 1 }), "move up");
  ok(await edit({ action: "remove", line: 2 }), "remove");
  const lines = (await call("gma3_macros", { macro: SETUP })).result.lines;
  assert.deepEqual(lines.map((l: any) => l.command), setupLines.map((l) => l.command));
  const rewritten = await edit({ action: "set", line: 3, command: "echo  done", raw: true });
  t.diagnostic(`rewritten: ${JSON.stringify(rewritten.result.rewritten)}`);
  assert.equal(rewritten.result.verification.status, "mismatched");
  assert.equal(rewritten.result.rewritten[0].stored, "Echo done");
  ok(await edit({ action: "set", line: 3, command: "echo  done", raw: true, accept_console_form: true }), "accepted console form");
  const off = await call("gma3_run_macro", { macro: HOLD, action: "off", observe_seconds: 1 });
  ok(off, "off on an idle macro");
});
