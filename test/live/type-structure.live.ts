/**
 * Live console test for SU-07 (gma3_patch_type_structure, cells in gma3_patch_types / gma3_patch_list).
 *
 * Runs only with GMA3_LIVE=1 against a disposable show (see README.md in this folder). Not part of `npm test`.
 * Needs bridge 0.28.0. Read-only: nothing on the console is changed.
 *
 * Show objects used: every fixture type and patched fixture of the show, read. The checks are self-consistency
 * checks, so any show works; one with a fixture with cells (a pixel bar or a multi-cell wash) is needed for the cell
 * assertions (GMA3_LIVE_REQUIRE_CELLS=0 skips that requirement).
 */
import assert from "node:assert/strict";
import { MutationLock } from "../../src/mutations.ts";
import { registerPatchTools } from "../../src/tools/patch.ts";
import { registerTypeStructureTools } from "../../src/tools/typestructure.ts";
import type { ToolContext } from "../../src/tools/context.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { liveTest, bridge } from "./live.ts";

const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 15000, luaToolAllowed: false };
const tools = new Map([...captureTools(registerTypeStructureTools, ctx), ...captureTools(registerPatchTools, ctx)]);
const call = async (name: string, args: Record<string, unknown>) => {
  const res = await tools.get(name)!.call(args);
  assert.ok(!res.isError, `${name}: ${res.content.map((c) => c.text).join("")}`);
  return JSON.parse(res.content.map((c) => c.text).join(""));
};
const leadingNo = (text: unknown): number | null => {
  const m = String(text ?? "").match(/^\s*(\d+)\s/);
  return m ? Number(m[1]) : null;
};

liveTest("SU-07 fixture-type structure: every mode's channels cover its footprint, and every fixture's cells match its mode", async () => {
  const types = await call("gma3_patch_types", {});
  assert.ok(types.count > 0, "the show has fixture types");
  const cellsByMode = new Map<string, number>();
  for (const t of types.types) {
    const full = await call("gma3_patch_type_structure", { type: t.no, channels: true });
    assert.deepEqual(full.limitations, [], `${t.name}: no limitation`);
    for (const m of full.modes) {
      assert.equal(m.addressesUsed, m.footprint, `${t.name} / ${m.name}: the channels cover the footprint`);
      assert.ok(m.channels.every((c: any) => c.virtual || (typeof c.offset === "number" && c.offset >= 1 && c.offset <= m.footprint)), `${t.name} / ${m.name}: every addressed channel is inside the footprint`);
      assert.ok(m.channels.filter((c: any) => !c.virtual).every((c: any) => typeof c.attribute === "string"), `${t.name} / ${m.name}: every channel names its attribute`);
      const listed = t.modes.find((x: any) => x.no === m.no);
      assert.equal(listed?.cells, m.cells, `${t.name} / ${m.name}: gma3_patch_types reports the same cell count`);
      cellsByMode.set(`${t.no}/${m.no}`, m.cells);
    }
  }

  const list = await call("gma3_patch_list", { limit: 2000 });
  let withCells = 0;
  for (const f of list.fixtures) {
    const key = `${leadingNo(f.type)}/${leadingNo(f.mode)}`;
    if (!cellsByMode.has(key)) continue; // grouping fixtures and anything without a readable type and mode
    assert.equal(f.cells, cellsByMode.get(key), `Fixture ${f.fid} (${f.type}, ${f.mode}): its cells match its mode's`);
    if (f.cells > 0) withCells++;
  }
  if (process.env.GMA3_LIVE_REQUIRE_CELLS !== "0") assert.ok(withCells > 0, "the show has at least one fixture with cells (set GMA3_LIVE_REQUIRE_CELLS=0 to skip)");

  // One mode with cells, narrowed: its geometry is the root's tree and the cells' template, in the unit asked for.
  const withCellsType = types.types.find((t: any) => t.modes.some((m: any) => m.cells > 0));
  if (withCellsType) {
    const mode = withCellsType.modes.find((m: any) => m.cells > 0);
    const s = await call("gma3_patch_type_structure", { type: withCellsType.no, mode: mode.no, unit: "ft" });
    const m = s.modes[0];
    assert.equal(m.cellList.length, m.cells);
    assert.ok(s.geometry.some((n: any) => n.name === m.rootGeometry), "the mode's root geometry is listed");
    assert.ok(s.geometry.filter((n: any) => n.class === "GeometryReference").length >= m.cells, "its cells' references are listed");
    assert.equal(s.unit, "ft");
    if (m.size) assert.ok(m.size.length > 0, "the root model has a length");
  }
});
