import { test } from "node:test";
import assert from "node:assert/strict";
import { registerCellLayoutTools, layoutPositions, planCells, pathAxes, type PathSpec } from "../src/tools/celllayout.ts";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { BridgeReplyError } from "./helpers/fake-bridge.ts";

/**
 * SU-08: gma3_layout_cells and gma3_assign_cell_layout against a fake bridge whose patch ops behave like the
 * bridge's 0.29.0 ops (test/lua/cell_layout_test.lua covers the ops themselves): a type's cell layout is shared by
 * every fixture of the type; patch.layoutCopy appends a copy in the patch copy and moves fixtures to it; the copy
 * opens and commits on the next patch.state poll.
 */

const FT = 0.3048;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// ---------------------------------------------------------------------------
// Paths (pure)
// ---------------------------------------------------------------------------

test("square wave: the field test's Festoon layout (legs of 10 ft, bulbs 2 ft apart, stepping 2 ft)", () => {
  const p: PathSpec = { shape: "square_wave", spacing: 2, legLength: 10, legDirection: "-y", advance: "+x", origin: { x: 1 } };
  const pos = layoutPositions(p, 36);
  const at = (i: number) => [Math.round(pos[i].x! * 1e6) / 1e6, Math.round(pos[i].y! * 1e6) / 1e6];
  assert.deepEqual([at(0), at(5), at(6), at(11), at(12), at(35)], [[1, 0], [1, -10], [3, -10], [3, 0], [5, 0], [11, 0]]);
  assert.deepEqual([...pathAxes(p)].sort(), ["x", "y"]);
});

test("zigzag, line and points", () => {
  const z = layoutPositions({ shape: "zigzag", spacing: Math.hypot(1, 2), legLength: 2, legDirection: "-y", advance: "+x", legStep: 1, origin: {} }, 3);
  assert.ok(near(z[1].x!, 1) && near(z[1].y!, -2) && near(z[2].x!, 2) && near(z[2].y!, 0), JSON.stringify(z));
  const l = layoutPositions({ shape: "line", spacing: 0.5, direction: "-z", origin: { z: 1 } }, 3);
  assert.deepEqual(l.map((p) => p.z), [1, 0.5, 0]);
  const pts = layoutPositions({ shape: "points", origin: {}, points: [{ x: 1 }, { x: 2, y: 3 }] }, 5);
  assert.deepEqual(pts, [{ x: 1 }, { x: 2, y: 3 }]);
});

test("planCells: axes the path does not use keep each cell's value unless the origin sets them; rest last stacks the remainder", () => {
  const read = { cells: [1, 2, 3].map((i) => ({ index: i, posX: 0, posY: 0, posZ: -0.2 })) } as any;
  const plan = planCells(read, { shape: "line", spacing: 1, direction: "+x", origin: {} }, 2, "keep");
  assert.deepEqual(plan, [{ index: 1, x: 0 }, { index: 2, x: 1 }], "z is not written: the cells keep theirs; cell 3 is untouched");
  const plan2 = planCells(read, { shape: "line", spacing: 1, direction: "+x", origin: { z: 0 } }, 2, "last");
  assert.deepEqual(plan2, [{ index: 1, x: 0, z: 0 }, { index: 2, x: 1, z: 0 }, { index: 3, x: 1, z: 0 }]);
});

// ---------------------------------------------------------------------------
// The tools against a fake patch
// ---------------------------------------------------------------------------

interface Type {
  no: number;
  name: string;
  guid: string;
  cells: Array<{ index: number; name: string; posX: number; posY: number; posZ: number }>;
}
interface Fx {
  fid: number;
  type: number;
}

class World {
  types: Type[] = [{ no: 2, name: "Festoon 2 RGB", guid: "2E E3 8A D1 1A 91", cells: [1, 2, 3, 4].map((i) => ({ index: i, name: `I${i}`, posX: 0, posY: 0, posZ: -0.24 })) }];
  live: Fx[] = [{ fid: 401, type: 2 }, { fid: 402, type: 2 }, { fid: 403, type: 2 }];
  copy: { fx: Fx[]; types: Type[] } | null = null;
  pending: string[] = [];
  dest = "Root";
  /** The GUID a committed copy gets: its own (default), all zeros, or the source's. */
  copyGuid: "own" | "zero" | "source" = "own";
  /** The write leaves this cell index unchanged (a write the console ignores). */
  ignoreCell?: number;
  writes: unknown[] = [];

  frame() {
    for (const c of this.pending) {
      if (c === "enter") {
        this.copy = { fx: this.live.map((f) => ({ ...f })), types: this.types.map((t) => ({ ...t, cells: t.cells.map((c) => ({ ...c })) })) };
        this.dest = "Stage 1.Fixtures";
      } else if (c === "root" && this.copy) {
        this.live = this.copy.fx;
        this.types = this.copy.types;
        this.copy = null;
        this.dest = "Root";
      }
    }
    this.pending = [];
  }
  typeOf(no: number, types = this.types) {
    return types.find((t) => t.no === no)!;
  }
  layout(fid: number) {
    const f = this.live.find((x) => x.fid === fid);
    if (!f) throw new BridgeReplyError(`[no-fixture] no fixture with FID ${fid}`, "no-fixture");
    const t = this.typeOf(f.type);
    return { type: { no: t.no, name: t.name, guid: t.guid }, mode: { no: 5, name: "Pixel Mode - 2 string" }, rootGeometry: "Body#4", cells: t.cells.map((c) => ({ ...c, parent: "Body#4" })), affected: this.live.filter((x) => x.type === t.no).map((x) => ({ fid: x.fid, name: "Festoon", mode: "Pixel Mode - 2 string" })), copyOpen: this.copy !== null };
  }
  install(h: Harness) {
    const f = h.fake;
    f.reset();
    f.on("patch.state", () => {
      this.frame();
      return { destination: this.dest, copyOpen: this.copy !== null, modal: false, atRoot: this.dest === "Root" && !this.copy, stages: ["Stage 1"] };
    });
    f.on("patch.enter", () => {
      if (this.copy) throw new BridgeReplyError("[copy-open] open", "copy-open");
      this.pending.push("enter");
      return { queued: true, stage: "Stage 1", expectDestination: "Stage 1.Fixtures" };
    });
    f.on("patch.commit", () => {
      this.pending.push("root");
      return { queued: true };
    });
    f.on("patch.collections", () => ({ copyOpen: this.copy !== null, live: ["Stages"], copy: this.copy ? ["Stages"] : false }));
    f.on("patch.fingerprint", (args) => {
      const ex = (args.excludeFids as number[]) ?? [];
      const list = (args.side === "copy" ? this.copy?.fx ?? [] : this.live).filter((x) => !ex.includes(x.fid));
      return { objects: list.length, hash: JSON.stringify(list), complete: true };
    });
    f.on("patch.list", (args) => {
      const rows = this.live.filter((x) => (args.fromFid === undefined || x.fid >= (args.fromFid as number)) && (args.toFid === undefined || x.fid <= (args.toFid as number))).map((x) => ({ fid: x.fid, name: "Festoon", type: `${x.type} ${this.typeOf(x.type).name}`, mode: "5 Pixel Mode - 2 string", patch: `2.${x.fid}`, cells: 4, subfixtures: 0 }));
      return { total: rows.length, offset: 0, count: rows.length, fixtures: rows };
    });
    f.on("patch.types", () => ({ count: this.types.length, types: this.types.map((t) => ({ no: t.no, name: t.name, modes: [] })) }));
    f.on("patch.cellLayout", (args) => this.layout(args.fid as number));
    f.on("patch.cellLayoutWrite", (args) => {
      this.writes.push(args);
      if (this.copy) throw new BridgeReplyError("[copy-open] open", "copy-open");
      const l = this.layout(args.fid as number);
      const want = (args.expectAffected as number[]).slice().sort().join(",");
      if (l.affected.map((a) => a.fid).sort().join(",") !== want) throw new BridgeReplyError("[affected-mismatch] differs", "affected-mismatch");
      const t = this.typeOf(l.type.no);
      const previous = t.cells.map((c) => ({ ...c }));
      for (const c of args.cells as Array<{ index: number; x?: number; y?: number; z?: number }>) {
        const cell = t.cells.find((x) => x.index === c.index)!;
        if (c.index === this.ignoreCell) continue;
        if (c.x !== undefined) cell.posX = c.x;
        if (c.y !== undefined) cell.posY = c.y;
        if (c.z !== undefined) cell.posZ = c.z;
      }
      return { previous, cells: t.cells };
    });
    f.on("patch.layoutCopy", (args) => {
      if (!this.copy) throw new BridgeReplyError("[copy-closed] closed", "copy-closed");
      const src = this.typeOf(args.type as number, this.copy.types);
      const no = this.copy.types.length + 10;
      const guid = this.copyGuid === "own" ? `2E E3 8A D1 00 ${no}` : this.copyGuid === "zero" ? "00 00 00 00 00 00" : src.guid;
      const nt: Type = { no, name: args.name as string, guid, cells: src.cells.map((c) => ({ ...c })) };
      this.copy.types.push(nt);
      for (const fid of args.fids as number[]) this.copy.fx.find((x) => x.fid === fid)!.type = nt.no;
      return { type: { no: nt.no, name: nt.name }, retyped: (args.fids as number[]).map((fid) => ({ fid })) };
    });
    f.on("patch.retype", (args) => {
      if (!this.copy) throw new BridgeReplyError("[copy-closed] closed", "copy-closed");
      const to = this.copy.types.find((t) => t.no === args.type || t.name === args.type);
      if (!to) throw new BridgeReplyError("[no-type] none", "no-type");
      for (const fid of args.fids as number[]) this.copy.fx.find((x) => x.fid === fid)!.type = to.no;
      return { type: { no: to.no, name: to.name }, retyped: [] };
    });
  }
}

async function setup() {
  const h = await startHarness(registerCellLayoutTools);
  const w = new World();
  w.install(h);
  return { h, w, ops: () => h.fake.requests.map((r) => r.op) };
}
const square = { shape: "square_wave", spacing: 2, leg_length: 10, origin: { x: 1 } };

test("layout_cells shared: preview names every fixture that moves; a wrong affects is refused before anything is written", async () => {
  const { h, w } = await setup();
  try {
    let r = await h.callJson("gma3_layout_cells", { fixture: 401, path: square, unit: "ft", preview: true });
    assert.deepEqual(r.result.affected.map((a: any) => a.fid), [401, 402, 403]);
    assert.match(r.result.summary, /shared by 3 fixture\(s\) \(401, 402, 403\): all of them would move/);
    assert.deepEqual(r.result.plan[1], { index: 2, x: 1, y: -2 });
    r = await h.callJson("gma3_layout_cells", { fixture: 401, path: square, unit: "ft", affects: [401], exclusive: true });
    assert.equal(r.result.outcome, "failed");
    assert.match(r.result.steps.map((s: any) => s.error ?? "").join(" "), /shared by FIDs 401, 402, 403, and affects lists 401/);
    r = await h.callJson("gma3_layout_cells", { fixture: 401, path: square, unit: "ft", exclusive: true });
    assert.match(r.result.validationErrors.join(" "), /affects is required for a shared layout/);
    assert.equal(w.writes.length, 0);
  } finally {
    await h.close();
  }
});

test("layout_cells shared: metres to the bridge, the guard passed along, read back per cell, previous positions in the unit", async () => {
  const { h, w } = await setup();
  try {
    const { result, isError } = await h.callJson("gma3_layout_cells", { fixture: 402, path: square, unit: "ft", affects: [403, 401, 402], exclusive: true });
    assert.equal(isError, false, JSON.stringify(result, null, 2));
    assert.equal(result.verification.status, "matched");
    const sent = w.writes[0] as any;
    assert.deepEqual(sent.expectAffected, [403, 401, 402]);
    assert.ok(near(sent.cells[1].x, 1 * FT) && near(sent.cells[1].y, -2 * FT) && sent.cells[1].z === undefined, JSON.stringify(sent.cells[1]));
    assert.deepEqual(result.previous[0], { index: 1, name: "I1", x: 0, y: 0, z: -0.7874 });
    assert.match(result.warnings.join(" "), /FIDs 403, 401, 402/);
    w.ignoreCell = 3;
    const r2 = await h.callJson("gma3_layout_cells", { fixture: 402, path: { shape: "line", spacing: 1, origin: { x: 5 } }, unit: "m", affects: [401, 402, 403], exclusive: true });
    assert.equal(r2.result.verification.status, "mismatched");
    assert.match(r2.result.verification.detail, /cell 3 x reads/);
  } finally {
    await h.close();
  }
});

test("layout_cells: refused while the patch copy is open", async () => {
  const { h, w } = await setup();
  try {
    w.copy = { fx: [], types: [] };
    const { result } = await h.callJson("gma3_layout_cells", { fixture: 401, path: square, unit: "ft", affects: [401, 402, 403], exclusive: true });
    assert.equal(result.outcome, "failed");
    assert.match(result.steps.map((s: any) => s.error ?? "").join(" "), /the patch copy is open/);
    assert.equal(w.writes.length, 0);
  } finally {
    await h.close();
  }
});

test("layout_cells own: a copy of the type for the named fixtures in one isolated session, then its cells; the others keep theirs", async () => {
  const { h, w, ops } = await setup();
  try {
    const { result, isError } = await h.callJson("gma3_layout_cells", { fixture: 402, scope: "own", own: { name: "Festoon left", fixtures: [402, 403] }, path: square, unit: "ft", exclusive: true });
    assert.equal(isError, false, JSON.stringify(result, null, 2));
    assert.equal(result.verification.status, "matched");
    assert.equal(result.type.name, "Festoon left");
    assert.deepEqual(result.affected, [402, 403]);
    assert.deepEqual(w.live.map((f) => [f.fid, w.typeOf(f.type).name]), [[401, "Festoon 2 RGB"], [402, "Festoon left"], [403, "Festoon left"]]);
    assert.ok(w.typeOf(2).cells.every((c) => c.posX === 0), "the original type's layout is unchanged");
    const seq = ops();
    assert.ok(seq.indexOf("patch.layoutCopy") > seq.indexOf("patch.enter") && seq.indexOf("patch.commit") > seq.lastIndexOf("patch.fingerprint") && seq.indexOf("patch.cellLayoutWrite") > seq.indexOf("patch.commit"), seq.join(" "));
    const fp = h.fake.requests.find((r) => r.op === "patch.fingerprint")!;
    assert.deepEqual(fp.args.excludeFids, [402, 403]);
    // Already the only users: own is pointless.
    const r = await h.callJson("gma3_layout_cells", { fixture: 402, scope: "own", own: { name: "Again", fixtures: [402, 403] }, path: square, unit: "ft", exclusive: true });
    assert.match(r.result.steps.map((s: any) => s.error ?? "").join(" "), /already the only users of Festoon left/);
  } finally {
    await h.close();
  }
});

test("assign_cell_layout: moves fixtures to another layout type in a session and reads their type back", async () => {
  const { h, w } = await setup();
  try {
    await h.callJson("gma3_layout_cells", { fixture: 403, scope: "own", own: { name: "Festoon right" }, path: square, unit: "ft", exclusive: true });
    const { result, isError } = await h.callJson("gma3_assign_cell_layout", { fixtures: [401], type: "Festoon right", exclusive: true });
    assert.equal(isError, false, JSON.stringify(result, null, 2));
    assert.equal(result.verification.status, "matched");
    assert.deepEqual(w.live.map((f) => w.typeOf(f.type).name), ["Festoon right", "Festoon 2 RGB", "Festoon right"]);
    const r = await h.callJson("gma3_assign_cell_layout", { fixtures: [401], type: "Nope", exclusive: true });
    assert.match(r.result.steps.map((s: any) => s.error ?? "").join(" "), /no fixture type "Nope"/);
  } finally {
    await h.close();
  }
});

test("layout_cells own: a copy without a GUID of its own after the commit stops before any cell is moved", async () => {
  for (const kind of ["zero", "source"] as const) {
    const { h, w } = await setup();
    try {
      w.copyGuid = kind;
      const { result, isError } = await h.callJson("gma3_layout_cells", { fixture: 402, scope: "own", own: { name: `Festoon ${kind}` }, path: square, unit: "ft", exclusive: true });
      assert.equal(isError, true);
      assert.equal(result.verification.status, "mismatched");
      assert.match(result.verification.detail, kind === "zero" ? /has no GUID of its own after the commit/ : /has the same GUID as Festoon 2 RGB/);
      assert.match(result.steps.map((s: any) => s.error ?? "").join(" "), /move them back with gma3_assign_cell_layout/);
      assert.equal(w.writes.length, 0, "no cell was written");
    } finally {
      await h.close();
    }
  }
});
