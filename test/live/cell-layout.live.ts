/**
 * Live console test for SU-08 (gma3_layout_cells, gma3_assign_cell_layout). Needs bridge 0.29.0.
 *
 * Runs only with GMA3_LIVE=1 against a disposable show (see README.md in this folder), and with
 * GMA3_LIVE_EXCLUSIVE=1: the own layout runs a patch session committed with no undo, and cell positions are written
 * into a fixture type with no undo (the test restores them).
 *
 * Show objects used:
 *   - Two fixtures with cells of one type and mode, FIDs from GMA3_LIVE_CELL_FIDS (default "1,2"); every fixture
 *     sharing their layout (read from the console) moves in the shared step, and is put back.
 *   - A fixture type "MCP live layout" (must not exist): created as the second fixture's own layout, then the fixture
 *     is moved back and the type removed.
 */
import assert from "node:assert/strict";
import { after } from "node:test";
import { MutationLock } from "../../src/mutations.ts";
import { registerCellLayoutTools } from "../../src/tools/celllayout.ts";
import { registerPatchTools } from "../../src/tools/patch.ts";
import type { ToolContext } from "../../src/tools/context.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { liveTest, liveEnabled, bridge } from "./live.ts";

const [A, B] = (process.env.GMA3_LIVE_CELL_FIDS ?? "1,2").split(",").map((s) => Number(s.trim()));
const OWN = "MCP live layout";
const exclusive = process.env.GMA3_LIVE_EXCLUSIVE === "1";
const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 15000, luaToolAllowed: false };
const tools = new Map([...captureTools(registerCellLayoutTools, ctx), ...captureTools(registerPatchTools, ctx)]);

async function call(name: string, args: Record<string, unknown>) {
  const res = await tools.get(name)!.call(args);
  const text = res.content.map((c) => c.text).join("\n");
  return { result: JSON.parse(text), isError: Boolean(res.isError), text };
}
const ok = (r: { result: any; isError: boolean; text: string }, what: string) => {
  assert.equal(r.isError, false, `${what}: ${r.text}`);
  assert.equal(r.result.outcome, "succeeded", what);
  assert.equal(r.result.verification.status, "matched", what);
  return r.result;
};
interface Layout {
  type: { no: number; name: string; guid?: string };
  cells: Array<{ index: number; posX: number; posY: number; posZ: number }>;
  affected: Array<{ fid: number }>;
}
const layout = async (fid: number) => (await bridge.request("patch.cellLayout", { fid })) as Layout;
const asPoints = (l: Layout) => l.cells.map((c) => ({ x: c.posX, y: c.posY, z: c.posZ }));

const cleanup: { original?: Layout; originalType?: string; ownCreated: boolean } = { ownCreated: false };
after(async () => {
  if (!liveEnabled || !exclusive) return;
  try {
    if (cleanup.ownCreated) {
      const own = await layout(B).catch(() => null);
      if (own && own.type.name === OWN && cleanup.originalType) await call("gma3_assign_cell_layout", { fixtures: own.affected.map((a) => a.fid), type: cleanup.originalType, exclusive: true });
      await call("gma3_patch_remove_type", { type: OWN, exclusive: true });
    }
    if (cleanup.original) {
      const now = await layout(A);
      if (JSON.stringify(asPoints(now)) !== JSON.stringify(asPoints(cleanup.original))) await call("gma3_layout_cells", { fixture: A, path: { shape: "points", points: asPoints(cleanup.original) }, affects: now.affected.map((a) => a.fid), exclusive: true });
    }
  } catch {
    // best effort
  }
});

liveTest("SU-08 cell layouts: shared (guarded, restored), own (a type copy for one fixture), assigned back", async (t) => {
  if (!exclusive) {
    t.skip("set GMA3_LIVE_EXCLUSIVE=1 to confirm exclusive console use: a layout type is created and removed with patch sessions committed with no undo");
    return;
  }
  const types = (await bridge.request("patch.types", {})) as { types: Array<{ name: string }> };
  assert.ok(!types.types.some((x) => x.name === OWN), `the show must not have a fixture type named ${OWN}`);
  const before = await layout(A);
  assert.ok(before.cells.length >= 2, `Fixture ${A} has cells`);
  const sharing = before.affected.map((a) => a.fid);
  assert.ok(sharing.includes(B), `Fixtures ${A} and ${B} share one layout`);
  cleanup.original = before;
  cleanup.originalType = before.type.name;

  // Shared: refused without every sharing fixture; laid out with them; restored from the previous positions.
  const refused = await call("gma3_layout_cells", { fixture: A, path: { shape: "line", spacing: 5, direction: "+x", origin: { x: -30 } }, unit: "cm", affects: [A], exclusive: true });
  assert.equal(refused.result.outcome, "failed");
  assert.deepEqual(asPoints(await layout(A)), asPoints(before), "nothing moved");
  const shared = ok(await call("gma3_layout_cells", { fixture: A, path: { shape: "line", spacing: 5, direction: "+x", origin: { x: -30 } }, unit: "cm", affects: sharing, exclusive: true }), "shared line layout");
  assert.equal(shared.previous.length, before.cells.length);
  const lined = await layout(B);
  assert.ok(Math.abs(lined.cells[1].posX - lined.cells[0].posX - 0.05) < 1e-4, "the second fixture moved with the shared layout");
  ok(await call("gma3_layout_cells", { fixture: A, path: { shape: "points", points: asPoints(before) }, affects: sharing, exclusive: true }), "restore the shared layout");
  const restored = await layout(A);
  restored.cells.forEach((c, i) => assert.ok(Math.abs(c.posX - before.cells[i].posX) < 1e-4 && Math.abs(c.posY - before.cells[i].posY) < 1e-4 && Math.abs(c.posZ - before.cells[i].posZ) < 1e-4, `cell ${i + 1} restored`));

  // Own: a copy of the type for B only, laid out as a square wave; A keeps the original.
  cleanup.ownCreated = true;
  const own = ok(await call("gma3_layout_cells", { fixture: B, scope: "own", own: { name: OWN }, path: { shape: "square_wave", spacing: 2, leg_length: 6, origin: { x: 1, z: 0 } }, unit: "ft", exclusive: true }), "own layout");
  assert.equal(own.type.name, OWN);
  assert.deepEqual(own.affected, [B]);
  assert.ok(own.type.guid && !/^[0\s]+$/.test(own.type.guid) && own.type.guid !== before.type.guid, `the copy has a GUID of its own after the commit (${own.type.guid}, source ${before.type.guid})`);
  const bOwn = await layout(B);
  assert.equal(bOwn.type.name, OWN);
  assert.ok(Math.abs(bOwn.cells[3].posY - -6 * 0.3048) < 1e-4, "the fourth cell ends the first leg at -6 ft");
  assert.deepEqual(asPoints(await layout(A)), asPoints(restored), "the first fixture's layout did not change");

  // Assign back, remove the copy.
  ok(await call("gma3_assign_cell_layout", { fixtures: [B], type: before.type.name, exclusive: true }), "assign back");
  assert.equal((await layout(B)).type.name, before.type.name);
  ok(await call("gma3_patch_remove_type", { type: OWN, exclusive: true }), "remove the layout copy");
  cleanup.ownCreated = false;
});
