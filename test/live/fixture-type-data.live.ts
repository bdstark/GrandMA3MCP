/**
 * Live console test for SU-19: fixture-type data. The cells' DMX (physical) order in gma3_patch_type_structure, used
 * by gma3_layout_cells (order: "dmx") and group lists ({cells_of}); the wheels with slot DMX ranges and unset colours.
 *
 * Runs only with GMA3_LIVE=1 against a disposable show (see README.md in this folder). Not part of `npm test`.
 * Needs bridge 0.34.0. Read-only: the layout and the group are previews; nothing is written.
 *
 * Show objects used: a fixture with cells (GMA3_LIVE_SU19_STRING, default 401: the Festoon in "Pixel Mode - 2
 * string") and a fixture whose type has a colour wheel (GMA3_LIVE_SU19_WHEEL, default 301: the 180W beam).
 */
import assert from "node:assert/strict";
import { MutationLock } from "../../src/mutations.ts";
import { registerTypeStructureTools } from "../../src/tools/typestructure.ts";
import { registerCellLayoutTools } from "../../src/tools/celllayout.ts";
import { registerGroupTools } from "../../src/tools/groups.ts";
import type { RegisterTools, ToolContext } from "../../src/tools/context.ts";
import { captureTools, type CapturedTool } from "../helpers/tool-harness.ts";
import { liveTest, bridge } from "./live.ts";

const STRING = Number(process.env.GMA3_LIVE_SU19_STRING ?? 401);
const WHEEL = Number(process.env.GMA3_LIVE_SU19_WHEEL ?? 301);
const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 20000, luaToolAllowed: false };
const tools = new Map<string, CapturedTool>();
for (const r of [registerTypeStructureTools, registerCellLayoutTools, registerGroupTools] as RegisterTools[]) for (const [k, v] of captureTools(r, ctx)) tools.set(k, v);
async function call(name: string, args: Record<string, unknown>) {
  const res = await tools.get(name)!.call(args);
  const text = res.content.map((c) => c.text).join("\n");
  return { result: JSON.parse(text) as any, isError: Boolean(res.isError), text };
}
const layoutOf = async (fid: number) => (await bridge.request("patch.cellLayout", { fid })) as { type: { no: number; name: string }; mode: { no: number; name: string }; cells: unknown[] };

liveTest("SU-19 fixture-type data: cell DMX order (type structure, layout, group lists) and wheels", async (t) => {
  const lay = await layoutOf(STRING);
  assert.ok(lay.cells.length > 1, `fixture ${STRING} must have cells`);
  t.diagnostic(`${STRING}: ${lay.type.name} / ${lay.mode.name}, ${lay.cells.length} cells`);

  await t.test("gma3_patch_type_structure gives the DMX order and checks it against the positions", async () => {
    const r = await call("gma3_patch_type_structure", { type: lay.type.no, mode: lay.mode.no, channels: false, geometry: false });
    assert.equal(r.isError, false, r.text);
    const co = r.result.modes[0].cellOrder;
    assert.ok(co && Array.isArray(co.dmx) && co.dmx.length === lay.cells.length, r.text);
    t.diagnostic(`DMX order: ${co.dmxRuns}; steps in DMX order ${JSON.stringify(co.stepsInDmxOrder)}, in cell-number order ${JSON.stringify(co.stepsInCellNumberOrder)}`);
    if (lay.mode.name === "Pixel Mode - 2 string") {
      assert.equal(co.dmxRuns, "1-9, 19-29, 10-18, 30-40");
      assert.equal(co.differsFromCellNumbers, true);
      // The DMX order walks the bulbs one pitch at a time; the cell numbers jump.
      assert.ok(co.stepsInCellNumberOrder.max > co.stepsInDmxOrder.mean * 1.5, JSON.stringify(co));
    }
  });

  await t.test("gma3_layout_cells order dmx (preview) walks the path in that order", async (st) => {
    const r = await call("gma3_layout_cells", { fixture: STRING, path: { shape: "line", spacing: 0.5 }, order: "dmx", preview: true });
    // The tool refuses even a preview while the patch copy is open (someone in the Patch menu); that is not ours to close.
    if (/the patch copy is open/.test(r.text)) {
      st.skip("the console's patch copy is open (the Patch menu or a dialog); close it to run this check");
      return;
    }
    assert.equal(r.isError, false, r.text);
    const ts = await call("gma3_patch_type_structure", { type: lay.type.no, mode: lay.mode.no, channels: false, geometry: false });
    assert.deepEqual(r.result.plan.map((p: { index: number }) => p.index), ts.result.modes[0].cellOrder.dmx);
    assert.match(r.result.cellOrder, /DMX order/);
  });

  await t.test("gma3_store_group preview expands {cells_of, order: dmx}", async () => {
    const r = await call("gma3_store_group", { group: 9999, arrangement: { type: "row", fixtures: [{ cells_of: STRING, order: "dmx" }] }, preview: true });
    assert.equal(r.isError, false, r.text);
    const ts = await call("gma3_patch_type_structure", { type: lay.type.no, mode: lay.mode.no, channels: false, geometry: false });
    assert.deepEqual(r.result.plan.items.map((i: { fixture: string }) => i.fixture), ts.result.modes[0].cellOrder.dmx.map((k: number) => `${STRING}.${k}`));
    assert.equal(r.result.cellLists[0].order, "dmx");
  });

  await t.test("wheels: slots with the DMX range that selects them; unset colours said so", async () => {
    const wl = await layoutOf(WHEEL).catch(() => null);
    const typeNo = wl?.type.no ?? (((await bridge.request("patch.list", { fids: [WHEEL] })) as any).fixtures?.[0]?.typeNo as number);
    const r = await call("gma3_patch_type_structure", { type: typeNo ?? 3, mode: 1, channels: false, geometry: false });
    assert.equal(r.isError, false, r.text);
    const wheels = r.result.wheels as any[];
    assert.ok(wheels.length > 0, "the type has wheels");
    const color = wheels.find((w) => w.kind === "color");
    assert.ok(color, JSON.stringify(wheels.map((w) => w.name)));
    const sel = color.slots.find((s: any) => s.selectedBy.length);
    assert.ok(sel, "a colour slot is selected by a channel set");
    assert.equal(typeof sel.selectedBy[0].dmxFrom, "number");
    t.diagnostic(`${color.name}: ${color.slots.length} slots, colours ${color.slotColors}; ${color.slots.slice(0, 3).map((s: any) => `${s.name} ${s.selectedBy[0]?.dmxFrom}-${s.selectedBy[0]?.dmxTo}`).join(", ")}`);
    if (color.slotColors === "unset") assert.match(color.note, /no slot colours/);
    const gobo = wheels.find((w) => w.slots.some((s: any) => s.media));
    if (gobo) t.diagnostic(`media on ${gobo.name}: ${gobo.slots.filter((s: any) => s.media).map((s: any) => s.media).join(", ")}`);
  });
});
