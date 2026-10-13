/**
 * Live console test for the KB-26 patch tools (gma3_patch_types, gma3_patch_list, gma3_patch_add,
 * gma3_patch_set, gma3_patch_remove).
 *
 * Runs only with GMA3_LIVE=1 against a disposable show (see README.md in this folder), AND with
 * GMA3_LIVE_EXCLUSIVE=1: patch changes are committed with no undo and the tools require exclusive use
 * of the console (nobody else edits the show while this runs). Not part of `npm test`. Needs bridge 0.19.0.
 *
 * Show objects used — fixtures with FID 990–993 ONLY, patched in the first free block found from 3.001:
 *   - Adds two fixtures (FID 990, 991) of the first fixture type that has a single-break DMX mode with a
 *     footprint, named "MCP live patch", patched consecutively.
 *   - A second add at FID 990 is refused before anything is sent (taken FID).
 *   - Swaps the two fixtures' addresses and renames 990, then unpatches 991.
 *   - Removes both through the tool; cleanup removes any of 990–993 that is still there.
 *   - Every change runs one patch session through the patch edit copy and is committed (no dialog).
 *
 * Procedure (what a reviewer should see in the console): the Patch menu is never opened; fixtures 990
 * and 991 appear in the Fixture sheet / patch at the reported address, swap, 991 becomes unpatched, and
 * both disappear again. The command line prompt shows the patch path briefly during each session.
 */
import assert from "node:assert/strict";
import { after } from "node:test";
import { MutationLock } from "../../src/mutations.ts";
import { registerPatchTools } from "../../src/tools/patch.ts";
import type { ToolContext } from "../../src/tools/context.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { liveTest, liveEnabled, bridge } from "./live.ts";

const FID = 990;
const exclusive = process.env.GMA3_LIVE_EXCLUSIVE === "1";
const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 15000, luaToolAllowed: false };
const tools = captureTools(registerPatchTools, ctx);

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
  assert.equal(r.result.verification.status, "matched", what);
  return r.result;
};

async function present(): Promise<number[]> {
  const l = await call("gma3_patch_list", { fromFid: FID, toFid: FID + 3 });
  return (l.result.fixtures ?? []).map((f: { fid: number }) => f.fid);
}

after(async () => {
  if (!liveEnabled || !exclusive) return;
  try {
    const left = await present();
    if (left.length) await call("gma3_patch_remove", { fids: left, exclusive: true });
  } catch {
    // best effort; the test itself reports what failed
  }
});

liveTest("KB-26 patch tools: add, refuse a taken FID, swap + rename, unpatch, remove", async (t) => {
  if (!exclusive) {
    t.skip("set GMA3_LIVE_EXCLUSIVE=1 to confirm exclusive console use: patch changes are committed with no undo");
    return;
  }
  assert.deepEqual(await present(), [], `FIDs ${FID}..${FID + 3} must be free in the disposable show`);

  const types = await call("gma3_patch_types", {});
  let pick: { type: number; mode: number; name: string; footprint: number } | undefined;
  for (const tp of types.result.types) {
    for (const m of tp.modes) if (!pick && m.breaks === 1 && (m.footprint ?? 0) > 0 && (m.footprint ?? 0) <= 64) pick = { type: tp.no, mode: m.no, name: `${tp.name} / ${m.name}`, footprint: m.footprint };
  }
  assert.ok(pick, "the show needs a fixture type with a single-break DMX mode");

  const add = ok(await call("gma3_patch_add", { type: pick.type, mode: pick.mode, fid: FID, count: 2, name: "MCP live patch", findFreeFrom: "3.001", exclusive: true }), "add");
  assert.equal(add.committed, true);
  assert.deepEqual(add.fixtures.map((f: any) => f.fid), [FID, FID + 1]);
  const a0 = add.fixtures[0].patch as string;
  const a1 = add.fixtures[1].patch as string;

  const dup = await call("gma3_patch_add", { type: pick.type, mode: pick.mode, fid: FID, exclusive: true });
  assert.equal(dup.result.outcome, "failed");
  assert.match(dup.result.summary, /nothing was sent.*not free/);

  ok(await call("gma3_patch_set", { edits: [{ fid: FID, address: a1, name: "MCP live swapped" }, { fid: FID + 1, address: a0 }], exclusive: true }), "swap + rename");
  ok(await call("gma3_patch_set", { edits: [{ fid: FID + 1, unpatch: true }], exclusive: true }), "unpatch");
  const l = await call("gma3_patch_list", { fromFid: FID, toFid: FID + 1 });
  const by = Object.fromEntries(l.result.fixtures.map((f: any) => [f.fid, f]));
  assert.equal(by[FID].patch, a1);
  assert.equal(by[FID].name, "MCP live swapped");
  assert.equal(by[FID + 1].patch, "");

  ok(await call("gma3_patch_remove", { fids: [FID, FID + 1], exclusive: true }), "remove");
  assert.deepEqual(await present(), []);
  const state = (await bridge.request("patch.state", {})) as { atRoot: boolean; copyOpen: boolean };
  assert.equal(state.atRoot, true, "the command line is back at Root and the copy is closed");
});
