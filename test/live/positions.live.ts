/**
 * Live console test for the SU-04 position tools (gma3_fixture_positions, gma3_place_fixtures).
 *
 * Runs only with GMA3_LIVE=1 against a disposable show (see README.md in this folder). Not part of `npm test`.
 * No bridge change (bridge 0.19.0 for the patch-copy check).
 *
 * Show objects used: two top-level fixtures, FIDs from GMA3_LIVE_POSITION_FIDS (default "1,2"). Their position,
 * rotation and mesh mirroring are changed and then restored from the tool's own restore list (positions have no
 * undo); the after hook restores them too when the run stops early.
 *   - A line in feet with a full rotation (30, 100, 20), which the console renormalizes, and mirror_mesh on.
 *   - A mirror pair: the second fixture at the first's pose mirrored across the stage centre line.
 *   - An arc that follows the angle.
 *   - Restore, then a read-back equal to the starting poses.
 */
import assert from "node:assert/strict";
import { after } from "node:test";
import { MutationLock } from "../../src/mutations.ts";
import { registerPositionTools } from "../../src/tools/positions.ts";
import type { ToolContext } from "../../src/tools/context.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { liveTest, liveEnabled, bridge } from "./live.ts";

const FIDS = (process.env.GMA3_LIVE_POSITION_FIDS ?? "1,2").split(",").map((s) => Number(s.trim()));
const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 15000, luaToolAllowed: false };
const tools = captureTools(registerPositionTools, ctx);

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

const read = (r: { result: any; isError: boolean; text: string }, what: string) => {
  assert.equal(r.isError, false, `${what}: ${r.text}`);
  assert.equal(r.result.outcome, "succeeded", what);
  return r.result;
};

const original = { saved: false, placements: [] as unknown[] };

after(async () => {
  if (!liveEnabled || !original.saved) return;
  try {
    await call("gma3_place_fixtures", { placements: original.placements });
  } catch {
    // best effort; the test reports what failed
  }
});

liveTest("SU-04 position tools: line in feet, renormalized rotation, mesh mirror, mirror pair, arc, restore", async () => {
  assert.equal(FIDS.length, 2, "GMA3_LIVE_POSITION_FIDS needs two FIDs");
  const start = read(await call("gma3_fixture_positions", { fids: FIDS }), "read the starting poses");
  assert.equal(start.fixtures.length, 2);
  original.placements = start.fixtures.map((f: any) => ({ fid: f.fid, position: f.position, rotation: f.rotation, mirror_mesh: f.mirror_mesh }));
  original.saved = true;

  const line = ok(
    await call("gma3_place_fixtures", {
      unit: "ft",
      layouts: [{ kind: "line", fids: FIDS, from: { x: -5, y: -10, z: 7 }, to: { x: 5, y: -10, z: 7 }, rotation: { x: 30, y: 100, z: 20 } }],
      placements: [],
    }),
    "line in feet with a rotation the console renormalizes",
  );
  const a = line.fixtures.find((f: any) => f.fid === FIDS[0]).after;
  assert.deepEqual(a.position, { x: -5, y: -10, z: 7 }, "7 ft read raw is 7 ft, not the display's millimetres");
  assert.ok(Math.abs(a.rotation.y - 80) < 0.01, `the console renormalized Y to 80 (got ${JSON.stringify(a.rotation)})`);

  ok(await call("gma3_place_fixtures", { placements: [{ fid: FIDS[0], mirror_mesh: true }] }), "mirror_mesh on");
  const mirrored = ok(await call("gma3_place_fixtures", { layouts: [{ kind: "mirror", pairs: [[FIDS[0], FIDS[1]]] }] }), "mirror pair");
  const m = mirrored.fixtures.find((f: any) => f.fid === FIDS[1]).after;
  assert.ok(Math.abs(m.position.x - 1.524) < 1e-4 && Math.abs(m.position.y + 3.048) < 1e-4, `mirrored to +5 ft (got ${JSON.stringify(m.position)})`);

  const arc = ok(await call("gma3_place_fixtures", { layouts: [{ kind: "arc", fids: FIDS, center: { x: 0, y: 2, z: 4 }, radius: 3, start_deg: 0, end_deg: 90, follow: true }] }), "arc");
  const arcEnd = arc.fixtures.find((f: any) => f.fid === FIDS[1]).after;
  assert.ok(Math.abs(arcEnd.position.x) < 1e-4 && Math.abs(arcEnd.position.y - 5) < 1e-4, `the arc's end is upstage of the centre (got ${JSON.stringify(arcEnd.position)})`);

  const copyTest = await bridge.request("patch.state", {});
  assert.equal((copyTest as { copyOpen: boolean }).copyOpen, false, "the patch copy stays closed throughout");

  ok(await call("gma3_place_fixtures", { placements: original.placements }), "restore");
  const end = read(await call("gma3_fixture_positions", { fids: FIDS }), "read after the restore");
  for (const f of end.fixtures) {
    const s = start.fixtures.find((x: any) => x.fid === f.fid);
    for (const k of ["x", "y", "z"]) assert.ok(Math.abs(f.position[k] - s.position[k]) < 1e-4, `FID ${f.fid} position ${k} restored`);
    assert.equal(f.mirror_mesh, s.mirror_mesh, `FID ${f.fid} mirror restored`);
    assert.deepEqual(f.quaternion.map((n: number) => Math.round(Math.abs(n) * 1e4)), s.quaternion.map((n: number) => Math.round(Math.abs(n) * 1e4)), `FID ${f.fid} rotation restored`);
  }
  original.saved = false;
});
