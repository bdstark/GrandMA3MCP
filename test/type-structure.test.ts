import { test } from "node:test";
import assert from "node:assert/strict";
import { registerTypeStructureTools, modeGeometry, structureView, type TypeStructure } from "../src/tools/typestructure.ts";
import { startHarness } from "./helpers/tool-harness.ts";

/** A bridge reply shaped as patch.typeStructure answered for the 52-channel wall washer (bridge 0.28.0, live). */
function washer(): TypeStructure {
  return {
    type: { no: 1, name: "36PCS 4in1 LED Wall Washer" },
    modes: [
      {
        no: 1,
        name: "52 channel",
        footprint: 52,
        cells: 2,
        rootGeometry: "Body",
        size: { name: "Body", length: 1.04, width: 0.16, height: 0.055 },
        addressesUsed: 52,
        cellList: [
          { index: 1, name: "Instance2", template: "RGBW", posX: -0.44, posY: 0, posZ: -0.0262, rotX: 0, rotY: 0, rotZ: 0, breakOffsets: "1:1" },
          { index: 2, name: "Instance3", template: "RGBW", posX: -0.36, posY: 0, posZ: -0.0262, rotX: 0, rotY: 0, rotZ: 0, breakOffsets: "1:5" },
        ],
        channels: [{ channel: "RGBW_ColorRGB_R", attribute: "ColorRGB_R", break: 1, offset: 1, cell: "Instance2" }],
      },
    ],
    geometry: [
      { index: 1, name: "RGBW", class: "Beam", depth: 0, model: "ModelRef", posX: 0 },
      { index: 2, name: "Body", class: "Geometry", depth: 0, model: "Body", posX: 0 },
      { index: 3, name: "Main Module", class: "Beam", depth: 1, parent: "Body" },
      { index: 4, name: "Instance2", class: "GeometryReference", depth: 2, parent: "Main Module", references: "RGBW", posX: -0.44 },
      { index: 5, name: "Body#2", class: "Geometry", depth: 0, model: "Body#2" },
      { index: 6, name: "Main Module#2", class: "Beam", depth: 1, parent: "Body#2" },
    ],
    models: [
      { name: "Body", length: 1.04, width: 0.16, height: 0.055 },
      { name: "Body#2", length: 1.04, width: 0.16, height: 0.05 },
      { name: "ModelRef", length: 0.08, width: 0.08, height: 0.005 },
    ],
    limitations: [],
  };
}

test("modeGeometry: the mode's root tree and the templates its cells reference, nothing of other modes", () => {
  const names = modeGeometry(washer().geometry!, washer().modes![0]).map((n) => n.name);
  assert.deepEqual(names, ["RGBW", "Body", "Main Module", "Instance2"]);
});

test("structureView: lengths in the unit asked for, angles in degrees, models the mode uses; a summary drops channels and cells", () => {
  const v = structureView(washer(), { unit: "ft", channels: true, geometry: "mode" }) as any;
  assert.equal(v.unit, "ft");
  assert.equal(v.modes[0].size.length, 3.4121, "1.04 m in feet");
  assert.equal(v.modes[0].cellList[0].posX, -1.4436);
  assert.equal(v.modes[0].channels.length, 1);
  assert.deepEqual(v.geometry.map((n: any) => n.name), ["RGBW", "Body", "Main Module", "Instance2"]);
  assert.deepEqual(v.models.map((m: any) => m.name), ["Body", "ModelRef"]);
  const summary = structureView(washer(), { unit: "m", channels: false, geometry: "none" }) as any;
  assert.equal(summary.modes[0].cells, 2);
  assert.equal("channels" in summary.modes[0], false);
  assert.equal("cellList" in summary.modes[0], false);
  assert.equal("geometry" in summary, false);
});

test("gma3_patch_type_structure: channels and geometry by default only with a mode; an old bridge is named", async () => {
  const h = await startHarness(registerTypeStructureTools);
  try {
    const seen: any[] = [];
    h.fake.on("patch.typeStructure", (args) => {
      seen.push(args);
      return washer();
    });
    let r = await h.callJson("gma3_patch_type_structure", { type: 1, mode: 1 });
    assert.equal(r.isError, false);
    assert.deepEqual(seen[0], { type: 1, mode: 1, geometry: true });
    assert.equal(r.result.modes[0].channels.length, 1);
    assert.equal(r.result.geometry.length, 4);
    r = await h.callJson("gma3_patch_type_structure", { type: "36PCS 4in1 LED Wall Washer" });
    assert.deepEqual(seen[1], { type: "36PCS 4in1 LED Wall Washer", geometry: false });
    assert.equal("channels" in r.result.modes[0], false);
    h.fake.on("patch.typeStructure", () => {
      throw new Error("unknown op 'patch.typeStructure'");
    });
    r = await h.callJson("gma3_patch_type_structure", { type: 1 });
    assert.equal(r.isError, true);
    assert.match(r.text, /needs bridge 0\.28\.0/);
  } finally {
    await h.close();
  }
});
