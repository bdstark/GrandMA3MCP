/**
 * Live console test for SU-20: saving the show (gma3_show_files, gma3_save_show).
 *
 * Runs only with GMA3_LIVE=1, GMA3_LIVE_EXCLUSIVE=1 and GMA3_LIVE_SAVE=1 against a disposable show (see README.md in
 * this folder). Not part of `npm test`. Needs bridge 0.35.0.
 *
 * Show files written: mcp-save-live-1.show (GMA3_LIVE_SAVE_SCRATCH; must not exist; left in the shows folder: nothing
 * deletes show files),
 * and, at the end, the show the console started on (or GMA3_LIVE_SAVE_RESTORE), replaced with the current state so the
 * console ends on that name again. The current show name changes during the test.
 */
import assert from "node:assert/strict";
import { MutationLock } from "../../src/mutations.ts";
import { registerShowTools } from "../../src/tools/show.ts";
import type { ToolContext } from "../../src/tools/context.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { liveTest, bridge } from "./live.ts";

const enabled = process.env.GMA3_LIVE_EXCLUSIVE === "1" && process.env.GMA3_LIVE_SAVE === "1";
const SCRATCH = process.env.GMA3_LIVE_SAVE_SCRATCH ?? "mcp-save-live-1";
const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 20000, luaToolAllowed: false };
const tools = captureTools(registerShowTools, ctx);
async function call(name: string, args: Record<string, unknown>) {
  const res = await tools.get(name)!.call(args);
  const text = res.content.map((c) => c.text).join("\n");
  return { result: JSON.parse(text) as any, isError: Boolean(res.isError), text };
}

liveTest("SU-20 save the show: list, save as a new name, save under the current name, refuse another show's file, save back", async (t) => {
  if (!enabled) {
    t.skip("set GMA3_LIVE_EXCLUSIVE=1 and GMA3_LIVE_SAVE=1: the test writes show files and changes the current show name");
    return;
  }
  const files = await call("gma3_show_files", {});
  assert.equal(files.isError, false, files.text);
  const start = files.result.current as string;
  const restore = process.env.GMA3_LIVE_SAVE_RESTORE ?? start;
  assert.ok(!files.result.files.some((f: { name: string }) => f.name.toLowerCase() === SCRATCH), `${SCRATCH}.show must not exist`);
  t.diagnostic(`starting on ${start}; ${files.result.count} show files; will end on ${restore}`);

  try {
    await t.test("save under a new name: the rename dialog is answered, the file reported, the name current", async () => {
      const r = await call("gma3_save_show", { name: SCRATCH, exclusive: true });
      assert.equal(r.result.verification.status, "matched", r.text);
      assert.deepEqual(r.result.dialog, { expected: "Change show file name?", answered: true });
      assert.equal(r.result.current, SCRATCH);
      assert.ok(r.result.file.size > 0);
      t.diagnostic(r.result.summary);
    });

    await t.test("save under the current name: no dialog, a newer file", async () => {
      const before = (await call("gma3_show_files", {})).result.currentFile;
      await new Promise((res) => setTimeout(res, 1100)); // file times have whole seconds
      const r = await call("gma3_save_show", { exclusive: true });
      assert.equal(r.result.verification.status, "matched", r.text);
      assert.match(r.result.dialog, /none/);
      assert.ok(r.result.file.time > before.time, `${r.result.file.time} > ${before.time}`);
    });

    await t.test("another show's file is refused without overwrite; nothing is written", async () => {
      const before = (await call("gma3_show_files", {})).result.files.find((f: { name: string }) => f.name === restore);
      assert.ok(before, `${restore}.show exists`);
      const r = await call("gma3_save_show", { name: restore, exclusive: true });
      assert.equal(r.result.outcome, "failed");
      assert.match(r.text, /another show's file/);
      const now = await call("gma3_show_files", {});
      assert.equal(now.result.current, SCRATCH);
      assert.equal(now.result.files.find((f: { name: string }) => f.name === restore).time, before.time);
    });
  } finally {
    // Back to the show the test started on (or the requested one): its file is replaced with the current state.
    const back = await call("gma3_save_show", { name: restore, overwrite: true, exclusive: true });
    t.diagnostic(`save back: ${back.result.summary ?? back.text.slice(0, 300)}`);
    assert.equal(back.result.verification.status, "matched", back.text);
    assert.equal(back.result.current, restore);
  }
});
