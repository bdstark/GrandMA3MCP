/**
 * SU-19: cell order from DMX addresses, the wheels view of gma3_patch_type_structure, and {cells_of} group lists.
 * The Festoon data is the live "Pixel Mode - 2 string" mode (probe 2026-10-16): cell index, position (ft-based
 * metres) and break offset.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cellOrderView, dmxOrder, pathSteps, resolveCellLists, runs, type OrderCell } from "../src/tools/cellorder.ts";
import { dmxAt, registerTypeStructureTools, wheelsView, type TypeStructure } from "../src/tools/typestructure.ts";
import { startHarness } from "./helpers/tool-harness.ts";

const F = 0.3048; // one foot in metres: the festoon's pitch is 2 ft
// [index, x (ft), y (ft), DMX offset]
const FESTOON: Array<[number, number, number, number]> = [
  [1, 1, 0, 1], [2, 1, -2, 4], [3, 1, -4, 7], [4, 1, -6, 10], [5, 1, -8, 13], [6, 1, -10, 16], [7, 3, -10, 19], [8, 3, -8, 22], [9, 3, -6, 25],
  [10, 7, -6, 61], [11, 7, -4, 64], [12, 7, -2, 67], [13, 7, 0, 70], [14, 9, 0, 73], [15, 9, -2, 76], [16, 9, -4, 79], [17, 9, -6, 82], [18, 9, -8, 85],
  [19, 3, -4, 28], [20, 3, -2, 31], [21, 3, 0, 34], [22, 5, 0, 37], [23, 5, -2, 40], [24, 5, -4, 43], [25, 5, -6, 46], [26, 5, -8, 49], [27, 5, -10, 52], [28, 7, -10, 55], [29, 7, -8, 58],
  [30, 9, -10, 88], [31, 11, -10, 91], [32, 11, -8, 94], [33, 11, -6, 97], [34, 11, -4, 100], [35, 11, -2, 103], [36, 11, 0, 106], [37, 11, 1, 109], [38, 11, 1, 112], [39, 11, 1, 115], [40, 11, 1, 118],
];
const festoon: OrderCell[] = FESTOON.map(([index, x, y, off]) => ({ index, name: `Instance${index}`, posX: x * F, posY: y * F, posZ: 0, breakOffsets: `1:${off}` }));

test("dmxOrder: the Festoon's 2-string mode runs 1-9, 19-29, 10-18, 30-40 (the field test's interleave)", () => {
  const o = dmxOrder(festoon)!;
  assert.equal(runs(o), "1-9, 19-29, 10-18, 30-40");
  // In DMX order every neighbour is one 2 ft pitch (the last four bulbs are bunched at the end of the string).
  const steps = pathSteps(festoon, o.slice(0, 36))!;
  assert.ok(Math.abs(steps.min - 0.6096) < 1e-3 && Math.abs(steps.max - 0.6096) < 1e-3, JSON.stringify(steps));
  // In cell-number order cell 9 -> 10 jumps 4 ft.
  assert.ok(pathSteps(festoon, festoon.map((c) => c.index))!.max > 1.2);
  const v = cellOrderView(festoon, true)!;
  assert.equal(v.differsFromCellNumbers, true);
  assert.equal(v.dmx!.length, 40);
  assert.match(v.note, /order: "dmx"/);
});

test("dmxOrder: breaks sort first, ties by cell number, an unreadable address gives no order", () => {
  const cells = [{ index: 1, breakOffsets: "2:1" }, { index: 2, breakOffsets: "1:4,2:7" }, { index: 3, breakOffsets: "1:1" }];
  assert.deepEqual(dmxOrder(cells), [3, 2, 1]);
  assert.equal(dmxOrder([{ index: 1, breakOffsets: "1:1" }, { index: 2, breakOffsets: "" }]), null);
  assert.equal(cellOrderView([{ index: 1, breakOffsets: "1:1" }, { index: 2 }], true)!.dmx, null);
  assert.equal(cellOrderView([{ index: 1, breakOffsets: "1:1" }, { index: 2, breakOffsets: "1:4" }], true)!.differsFromCellNumbers, false);
  assert.equal(cellOrderView([{ index: 1, breakOffsets: "1:1" }], true), undefined, "one cell has no order to speak of");
  assert.equal(runs([5, 4, 3, 7, 1, 2]), "5-3, 7, 1-2");
});

// ---------------------------------------------------------------------------
// Wheels
// ---------------------------------------------------------------------------

const white = { r: 1, g: 1, b: 1, a: 1 };
const beam: TypeStructure = {
  type: { no: 3, name: "180W Beam Moving Head" },
  modes: [{ name: "Mode 0", cellList: [] }],
  wheels: [
    { index: 1, name: "C1", slots: [{ index: 1, name: "open", color: white }, { index: 2, name: "colour 1", color: white }, { index: 3, name: "colour 2", color: white }] },
    { index: 2, name: "E", slots: [{ index: 1, name: "open", color: white }, { index: 2, name: "18 facet prism", color: white, media: "GOBO/SHEHDS/SHEHDS@000900014.png", appearance: "Gobos.GoboImage 5" }] },
    { index: 3, name: "C2", slots: [{ index: 1, name: "open", color: white }, { index: 2, name: "red", color: { r: 1, g: 0, b: 0, a: 1 } }] },
  ],
  wheelFunctions: [
    { mode: "Mode 0", channel: "Main Module_Color1", attribute: "Color1", channelFunction: "Color1 1", wheel: "C1", bits: 8, dmxFrom: "000000", dmxTo: "7F7F7F", channelSets: [{ name: "open", slot: 1, dmxFrom: "000000", dmxTo: "0A0A0A" }, { name: "colour 1", slot: 2, dmxFrom: "0B0B0B", dmxTo: "151515" }] },
    { mode: "Mode 0", channel: "Main Module_Color1", attribute: "Color1WheelSpin", channelFunction: "Color1WheelSpin 2", wheel: "C1", bits: 8, dmxFrom: "800000", dmxTo: "FFFFFF", channelSets: [{ name: "stop", dmxFrom: "C0C0C0", dmxTo: "C0C0C0" }] },
    { mode: "Mode 0", channel: "Main Module_EFFECTWHEEL", attribute: "EFFECTWHEELSELECT", channelFunction: "EFFECTWHEELSELECT 1", wheel: "E", bits: 16, dmxFrom: "000000", dmxTo: "7F7F7F", channelSets: [{ name: "prism", slot: 2, dmxFrom: "080808", dmxTo: "7F7F7F" }] },
  ],
};

test("wheelsView: slots with the DMX range that selects them; an all-white colour wheel says its colours are unset", () => {
  const [c1, e, c2] = wheelsView(beam);
  assert.equal(c1.kind, "color");
  assert.equal(c1.slotColors, "unset");
  assert.match(String(c1.note), /carries no slot colours.*Ask what colour each slot is/);
  assert.deepEqual(c1.slots[1].selectedBy, [{ mode: "Mode 0", channel: "Main Module_Color1", attribute: "Color1", channelSet: "colour 1", bits: 8, dmxFrom: 11, dmxTo: 21 }]);
  assert.deepEqual(c1.unselectedSlots, [3], "a slot no channel set selects is listed");
  assert.equal(c1.functions.length, 2);
  assert.equal(e.kind, "other");
  assert.equal(e.note, undefined, "a white prism wheel is not a missing colour");
  assert.equal(e.slots[1].media, "GOBO/SHEHDS/SHEHDS@000900014.png");
  assert.equal(e.slots[1].selectedBy[0].dmxFrom, dmxAt("080808", 16));
  assert.equal(c2.slotColors, "set");
  assert.equal(c2.note, undefined);
  assert.equal(dmxAt("FFFFFF", 8), 255);
  assert.equal(dmxAt("800000", 16), 32768);
  assert.equal(dmxAt("zz", 8), null);
  assert.equal(wheelsView({ wheels: [{ index: 1, name: "C1", slots: [{ index: 1, name: "a" }, { index: 2, name: "b", color: white }] }] })[0].slotColors, "unreadable");
});

test("gma3_patch_type_structure: cellOrder per mode and wheels in the result", async () => {
  const h = await startHarness(registerTypeStructureTools);
  try {
    h.fake.on("patch.typeStructure", (args) => (args.type === 3 ? beam : { type: { no: 4, name: "Festoon 2 RGB" }, modes: [{ name: "Pixel Mode - 2 string", cells: 40, cellList: festoon }], wheels: [], wheelFunctions: [] }));
    const f = await h.callJson("gma3_patch_type_structure", { type: 4, mode: "Pixel Mode - 2 string", unit: "ft" });
    assert.equal(f.isError, false, f.text);
    const co = f.result.modes[0].cellOrder;
    assert.equal(co.dmxRuns, "1-9, 19-29, 10-18, 30-40");
    assert.equal(co.dmx.length, 40);
    assert.equal(co.stepsInDmxOrder.mean > 0 && co.stepsInDmxOrder.max, 2, "steps in the requested unit (ft)");
    const b = await h.callJson("gma3_patch_type_structure", { type: 3 });
    assert.equal(b.result.wheels[0].slotColors, "unset");
    assert.equal(b.result.modes[0].cellOrder, undefined);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// {cells_of} lists
// ---------------------------------------------------------------------------

test("resolveCellLists: {cells_of} becomes the fixture's cell ids in DMX order (or cell order, or reversed); other entries stay", async () => {
  const h = await startHarness(registerTypeStructureTools);
  try {
    h.fake.on("patch.cellLayout", (args) => ({ type: { no: 4, name: "Festoon 2 RGB" }, mode: { no: 5, name: "Pixel Mode - 2 string" }, cells: festoon.map((c) => ({ index: c.index })), fid: args.fid }));
    h.fake.on("patch.typeStructure", () => ({ modes: [{ cellList: festoon }] }));
    const r = await resolveCellLists(h.ctx, { type: "rows", rows: [[{ cells_of: 401 }], [{ cells_of: 402, order: "index", reverse: true }, 701]] });
    const a = r.arrangement as { rows: string[][] };
    assert.deepEqual(a.rows[0].slice(8, 12), ["401.9", "401.19", "401.20", "401.21"]);
    assert.equal(a.rows[0].length, 40);
    assert.deepEqual(a.rows[1].slice(0, 2), ["402.40", "402.39"]);
    assert.equal(a.rows[1].at(-1), 701);
    assert.equal(r.resolved[0].ids, "401.1-401.9, 401.19-401.29, 401.10-401.18, 401.30-401.40");
    assert.equal(h.fake.requests.filter((x) => x.op === "patch.cellLayout").length, 2, "one read per fixture");
    h.fake.on("patch.typeStructure", () => ({ modes: [{ cellList: festoon.slice(0, 10) }] }));
    await assert.rejects(resolveCellLists(h.ctx, { type: "row", fixtures: [{ cells_of: 403 }] }), /lists 10 cells, the fixture has 40/);
    await assert.rejects(resolveCellLists(h.ctx, { type: "row", fixtures: [{ cells_of: 403, order: "x" }] }), /order must be/);
  } finally {
    await h.close();
  }
});
