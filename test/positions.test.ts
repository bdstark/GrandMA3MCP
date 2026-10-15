import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.js";
import { BridgeReplyError } from "./helpers/fake-bridge.js";
import { registerPositionTools, quatFromEuler, quatEquivalent, mirrorAcrossCentre, expandPlan, type Quat, type Vec3 } from "../src/tools/positions.js";
import { Validator } from "../src/validate.js";

/**
 * SU-04 position tools. The rotation maths is checked against the quaternions onPC 2.5.1 reported
 * (docs/probes/su-04-positions-macos-2.5.1.md); the tools run against a fake bridge whose fixtures renormalize
 * their angles on read, as the console does a frame later.
 */

// ---------------------------------------------------------------------------
// Rotation maths against the console
// ---------------------------------------------------------------------------

test("quatFromEuler reproduces the console's quaternions (q = qZ · qY · qX)", () => {
  const cases: Array<[Vec3, Quat]> = [
    [{ x: 30, y: 100, z: 20 }, [0.035349, 0.75759, -0.087439, 0.645881]],
    [{ x: 10, y: -95, z: 170 }, [0.736809, -0.005356, 0.676059, -0.005356]],
    [{ x: -45, y: 0, z: 30 }, [-0.369644, -0.099046, 0.239118, 0.892399]],
    [{ x: 0, y: 180, z: 0 }, [0, 1, 0, 0]],
  ];
  for (const [e, q] of cases) assert.ok(quatEquivalent(quatFromEuler(e), q, 1e-5), `${JSON.stringify(e)} -> ${quatFromEuler(e)}`);
});

test("the console's renormalized angles are the same rotation", () => {
  const pairs: Array<[Vec3, Vec3]> = [
    [{ x: 0, y: 180, z: 0 }, { x: 180, y: 0, z: 180 }],
    [{ x: 30, y: 100, z: 20 }, { x: -150, y: 80, z: -160 }],
    [{ x: 10, y: -95, z: 170 }, { x: -170, y: -85, z: -10 }],
  ];
  for (const [a, b] of pairs) assert.ok(quatEquivalent(quatFromEuler(a), quatFromEuler(b)), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  assert.ok(!quatEquivalent(quatFromEuler({ x: 0, y: 0, z: 10 }), quatFromEuler({ x: 0, y: 0, z: 11 })), "a 1° difference is a difference");
});

/** Rotation matrix of q (x, y, z, w). */
function matrix([x, y, z, w]: Quat): number[][] {
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

test("mirrorAcrossCentre negates x and gives the mirrored rotation M·R·M", () => {
  const r: Vec3 = { x: 25, y: -40, z: 70 };
  const m = mirrorAcrossCentre({ x: 1.5, y: -2, z: 3 }, r);
  assert.deepEqual(m.position, { x: -1.5, y: -2, z: 3 });
  const R = matrix(quatFromEuler(r));
  const MRM = R.map((row, i) => row.map((v, j) => ((i === 0) !== (j === 0) ? -v : v)));
  const got = matrix(quatFromEuler(m.rotation));
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) assert.ok(Math.abs(got[i][j] - MRM[i][j]) < 1e-9);
});

// ---------------------------------------------------------------------------
// Plan expansion
// ---------------------------------------------------------------------------

test("expandPlan: a line in feet is spaced evenly and converted to metres", () => {
  const v = new Validator();
  const plan = expandPlan({ layouts: [{ kind: "line", fids: [101, 102, 103], from: { x: -10, y: 0, z: 7 }, to: { x: 10, y: 0, z: 7 }, rotation: { x: 0, y: 0, z: 90 } }] }, "ft", v);
  assert.ok(v.ok, v.errors.join("; "));
  assert.deepEqual(plan.map((p) => p.fid), [101, 102, 103]);
  assert.ok(Math.abs((plan[0].position?.x ?? 0) + 3.048) < 1e-9);
  assert.equal(plan[1].position?.x, 0);
  assert.ok(Math.abs((plan[2].position?.z ?? 0) - 2.1336) < 1e-9);
  assert.deepEqual(plan[1].rotation, { x: 0, y: 0, z: 90 });
});

test("expandPlan: an arc runs counter-clockwise from stage left, follow adds the angle to rotation z", () => {
  const v = new Validator();
  const plan = expandPlan({ layouts: [{ kind: "arc", fids: [1, 2, 3], center: { x: 0, y: 0, z: 5 }, radius: 4, start_deg: 0, end_deg: 180, follow: true }] }, "m", v);
  assert.ok(v.ok, v.errors.join("; "));
  const pos = plan.map((p) => [Math.round((p.position?.x ?? 0) * 1e6) / 1e6, Math.round((p.position?.y ?? 0) * 1e6) / 1e6, p.position?.z]);
  assert.deepEqual(pos, [[4, 0, 5], [0, 4, 5], [-4, 0, 5]]);
  assert.deepEqual(plan.map((p) => p.rotation?.z), [0, 90, 180]);
});

test("expandPlan refuses a FID placed twice, a partial rotation, an empty request and an unknown layout", () => {
  let v = new Validator();
  expandPlan({ placements: [{ fid: 1, position: { x: 1 } }], layouts: [{ kind: "line", fids: [1], from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 0 } }] }, "m", v);
  assert.match(v.errors.join(" "), /FID 1 is placed twice/);
  v = new Validator();
  expandPlan({ placements: [{ fid: 1, rotation: { z: 90 } as any }] }, "m", v);
  assert.match(v.errors.join(" "), /a rotation is always all three angles/);
  v = new Validator();
  expandPlan({}, "m", v);
  assert.match(v.errors.join(" "), /nothing to place/);
  v = new Validator();
  expandPlan({ layouts: [{ kind: "spiral" } as any] }, "m", v);
  assert.match(v.errors.join(" "), /kind must be line, arc or mirror/);
  v = new Validator();
  expandPlan({ layouts: [{ kind: "mirror", pairs: [[5, 5]] }] }, "m", v);
  assert.match(v.errors.join(" "), /onto itself/);
});

// ---------------------------------------------------------------------------
// The tools against a fake console
// ---------------------------------------------------------------------------

interface Fx {
  fid: number;
  name: string;
  depth: number;
  pos: Vec3;
  q: Quat;
  rot: Vec3;
  mirror: boolean;
}

function eulerFromQuat([x, y, z, w]: Quat): Vec3 {
  const deg = (r: number) => (r * 180) / Math.PI;
  const sinp = Math.max(-1, Math.min(1, 2 * (w * y - z * x)));
  return { x: deg(Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y))), y: deg(Math.asin(sinp)), z: deg(Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))) };
}

class Stage {
  fixtures = new Map<number, Fx>();
  copyOpen = false;
  /** Properties whose writes the console ignores. */
  ignore = new Set<string>();
  /** A property whose write the bridge refuses. */
  failSet?: string;
  /** Fixtures whose POSX reads as garbage (raw). */
  garbled = new Set<number>();
  /** Garble every written fixture's POSX from the next read on. */
  garbleWritten = false;
  constructor() {
    for (const [fid, depth] of [[101, 0], [102, 0], [103, 0], [4, 0], [401, 1]] as const) this.fixtures.set(fid, { fid, name: `Fx ${fid}`, depth, pos: { x: 0, y: 0, z: 0 }, q: [0, 0, 0, 1], rot: { x: 0, y: 0, z: 0 }, mirror: false });
  }
  install(h: Harness) {
    const f = h.fake;
    f.on("patch.state", () => ({ copyOpen: this.copyOpen, destination: this.copyOpen ? "Stage 1.Fixtures" : "Root", atRoot: !this.copyOpen }));
    f.on("patch.list", (args) => {
      const rows = [...this.fixtures.values()].filter((x) => x.fid >= (args.fromFid as number) && x.fid <= (args.toFid as number)).map((x) => ({ fid: x.fid, name: x.name, depth: x.depth, ...(x.depth ? { parentFid: 4 } : {}) }));
      return { total: rows.length, offset: 0, count: rows.length, fixtures: rows };
    });
    f.on("objects", (args) => {
      const fids = String(args.ref).replace(/^Fixture /, "").split("+").map((s) => Number(s.trim()));
      const items = fids.map((fid) => this.fixtures.get(fid)).filter((x): x is Fx => !!x).map((x) => {
        // A later read: the console renormalizes the angles from the quaternion.
        const e = eulerFromQuat(x.q);
        // asText: false reads raw numbers (no ROTDIRECT: it has no raw value); the display role rounds.
        if (args.asText === false) return { class: "Fixture", name: x.name, fields: { FID: x.fid, Name: x.name, POSX: this.garbled.has(x.fid) ? "garbage" : x.pos.x, POSY: x.pos.y, POSZ: x.pos.z, ROTX: e.x, ROTY: e.y, ROTZ: e.z, MESHMIRRORX: x.mirror } };
        return { class: "Fixture", name: x.name, fields: { FID: String(x.fid), Name: x.name, POSX: x.pos.x.toFixed(3), POSY: x.pos.y.toFixed(3), POSZ: x.pos.z.toFixed(3), ROTX: e.x.toFixed(2), ROTY: e.y.toFixed(2), ROTZ: e.z.toFixed(2), ROTDIRECT: x.q.map((n) => n.toFixed(6)).join(","), MESHMIRRORX: x.mirror ? "Yes" : "" } };
      });
      return { items, total: items.length };
    });
    f.on("set", (args) => {
      const x = this.fixtures.get(Number(String(args.ref).replace(/^Fixture /, "")))!;
      const p = String(args.property);
      if (p === this.failSet) throw new BridgeReplyError(`[set-failed] ${p} refused`, "set-failed");
      if (this.garbleWritten) this.garbled.add(x.fid);
      if (!this.ignore.has(p)) {
        if (p.startsWith("POS")) x.pos[p.slice(3).toLowerCase() as "x"] = Number(args.value);
        if (p === "ROTDIRECT") {
          x.q = String(args.value).split(",").map(Number) as Quat;
          x.rot = eulerFromQuat(x.q);
        } else if (p.startsWith("ROT")) {
          // A separate request: the console has renormalized the angles since the last one (live 2026-10-15).
          x.rot = eulerFromQuat(x.q);
          x.rot[p.slice(3).toLowerCase() as "x"] = Number(args.value);
          x.q = quatFromEuler(x.rot);
        }
        if (p === "MESHMIRRORX") x.mirror = args.value === "1";
      }
      return { ref: args.ref, property: p, value: "ok" };
    });
  }
}

async function setup() {
  const h = await startHarness(registerPositionTools);
  const s = new Stage();
  s.install(h);
  return { h, s, sets: () => h.fake.requests.filter((r) => r.op === "set").map((r) => `${r.args.ref}.${r.args.property}=${r.args.value}`) };
}

test("gma3_place_fixtures: positions in feet, a full rotation and mirroring, read back by quaternion after renormalization", async () => {
  const { h, s, sets } = await setup();
  try {
    const { result, isError } = await h.callJson("gma3_place_fixtures", { unit: "ft", placements: [{ fid: 101, position: { x: 10, z: 7 }, rotation: { x: 30, y: 100, z: 20 }, mirror_mesh: true }] });
    assert.equal(isError, false, JSON.stringify(result, null, 2));
    assert.equal(result.verification.status, "matched");
    const q = quatFromEuler({ x: 30, y: 100, z: 20 }).map((n) => Math.round(n * 1e9) / 1e9).join(",");
    assert.deepEqual(sets(), ["Fixture 101.POSX=3.048", "Fixture 101.POSZ=2.1336", `Fixture 101.ROTDIRECT=${q}`, "Fixture 101.MESHMIRRORX=1"], "the rotation is one quaternion write");
    const fx = result.fixtures[0];
    assert.deepEqual(fx.after.rotation, { x: -150, y: 80, z: -160 }, "the console's renormalized angles are reported as they are");
    assert.deepEqual(fx.after.position, { x: 10, y: 0, z: 7 });
    assert.deepEqual(result.restore, [{ fid: 101, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, mirror_mesh: false }]);
    assert.match(result.summary, /no undo/);
    assert.equal(result.axes.x, "X: positive is stage left");
    assert.equal(s.fixtures.get(101)!.mirror, true);
  } finally {
    await h.close();
  }
});

test("gma3_place_fixtures: preview sends nothing; a mirror pair uses the source's planned pose", async () => {
  const { h, sets } = await setup();
  try {
    const { result } = await h.callJson("gma3_place_fixtures", { placements: [{ fid: 101, position: { x: 2, y: 1, z: 3 }, rotation: { x: 10, y: 20, z: 30 } }], layouts: [{ kind: "mirror", pairs: [[101, 102]] }], preview: true });
    assert.equal(result.preview, true);
    assert.deepEqual(sets(), []);
    const m = result.plan.find((p: any) => p.fid === 102);
    assert.deepEqual(m.position, { x: -2, y: 1, z: 3 });
    assert.deepEqual(m.rotation, { x: 10, y: -20, z: -30 });
    assert.match(m.from, /mirror of FID 101/);
  } finally {
    await h.close();
  }
});

test("gma3_place_fixtures: refused with the patch copy open, for a missing FID and for a fixture inside a grouping fixture", async () => {
  const { h, s, sets } = await setup();
  try {
    s.copyOpen = true;
    let r = await h.callJson("gma3_place_fixtures", { placements: [{ fid: 101, position: { x: 1 } }] });
    assert.equal(r.result.outcome, "failed");
    assert.match(r.result.summary, /patch copy is open.*overwrite/);
    s.copyOpen = false;
    r = await h.callJson("gma3_place_fixtures", { placements: [{ fid: 999, position: { x: 1 } }] });
    assert.match(r.result.summary, /no fixture with FID 999/);
    r = await h.callJson("gma3_place_fixtures", { placements: [{ fid: 401, position: { x: 1 } }] });
    assert.match(r.result.summary, /inside a grouping fixture/);
    r = await h.callJson("gma3_place_fixtures", { unit: "yards", placements: [{ fid: 101, position: { x: 1 } }] });
    assert.equal(r.isError, true);
    assert.deepEqual(sets(), []);
  } finally {
    await h.close();
  }
});

test("gma3_place_fixtures: a write the console ignores is a mismatch, not a success", async () => {
  const { h, s } = await setup();
  try {
    s.ignore.add("MESHMIRRORX");
    const { result, isError } = await h.callJson("gma3_place_fixtures", { placements: [{ fid: 103, position: { y: -2 }, mirror_mesh: true }] });
    assert.equal(isError, true);
    assert.equal(result.verification.status, "mismatched");
    assert.match(result.verification.detail, /mirror_mesh: false, expected true \(the console ignored the write\)/);
  } finally {
    await h.close();
  }
});

test("gma3_fixture_positions: positions in the requested unit with the axes", async () => {
  const { h, s } = await setup();
  try {
    s.fixtures.get(102)!.pos = { x: 0.3048, y: -3.048, z: 2.1336 };
    const { result } = await h.callJson("gma3_fixture_positions", { fids: [102], unit: "ft" });
    assert.deepEqual(result.fixtures[0].position, { x: 1, y: -10, z: 7 });
    assert.match(result.axes.y, /upstage/);
    const r = await h.callJson("gma3_fixture_positions", { fids: [555] });
    assert.equal(r.result.outcome, "failed");
  } finally {
    await h.close();
  }
});

test("(the fake console reproduces why angles are not written one by one: (30, 100, 20) becomes another rotation)", () => {
  // As onPC did live: X and Y written, renormalized before Z is written.
  let rot: Vec3 = { x: 30, y: 100, z: 0 };
  rot = eulerFromQuat(quatFromEuler(rot));
  rot.z = 20;
  assert.ok(!quatEquivalent(quatFromEuler(rot), quatFromEuler({ x: 30, y: 100, z: 20 })));
});

// ---------------------------------------------------------------------------
// Review of PR #49
// ---------------------------------------------------------------------------

test("review P1: the checks and the restore values are read inside the mutation lock", async () => {
  const { h, s, sets } = await setup();
  try {
    // An operation already holding the lock opens the patch copy before releasing it.
    const holder = h.ctx.mutations.run(async () => {
      await new Promise((r) => setTimeout(r, 50));
      s.copyOpen = true;
    });
    const r = await h.callJson("gma3_place_fixtures", { placements: [{ fid: 101, position: { x: 1 } }] });
    await holder;
    assert.equal(r.result.outcome, "failed");
    assert.match(r.result.summary, /patch copy is open/);
    assert.deepEqual(sets(), [], "nothing is written after a stale check");
    // An operation holding the lock moves the fixture: the restore list has the pose it left, not the earlier one.
    s.copyOpen = false;
    const mover = h.ctx.mutations.run(async () => {
      await new Promise((r) => setTimeout(r, 50));
      s.fixtures.get(101)!.pos.x = 5;
    });
    const r2 = await h.callJson("gma3_place_fixtures", { placements: [{ fid: 101, position: { y: 1 } }] });
    await mover;
    assert.equal(r2.result.outcome, "succeeded", JSON.stringify(r2.result, null, 2));
    assert.deepEqual(r2.result.restore[0].position, { x: 5, y: 0, z: 0 });
    assert.deepEqual(r2.result.fixtures[0].after.position, { x: 5, y: 1, z: 0 });
  } finally {
    await h.close();
  }
});

test("review P2: an unreadable pose is refused before writing and never verifies as matched", async () => {
  const { h, s, sets } = await setup();
  try {
    s.garbled.add(103);
    let r = await h.callJson("gma3_place_fixtures", { placements: [{ fid: 103, position: { y: 1 } }] });
    assert.equal(r.result.outcome, "failed");
    assert.match(r.result.summary, /FID 103: POSX could not be read as numbers/);
    assert.deepEqual(sets(), []);
    s.garbled.clear();
    s.garbleWritten = true;
    r = await h.callJson("gma3_place_fixtures", { placements: [{ fid: 102, position: { x: 1 } }] });
    assert.equal(r.result.verification.status, "unavailable", "an unreadable value is not a match");
    assert.match(r.result.verification.detail, /FID 102 POSX/);
    assert.match(r.result.summary, /Read-back unavailable/);
  } finally {
    await h.close();
  }
});

test("review P2: a fixture changed only in part is partial, with every property step reported", async () => {
  const { h, s } = await setup();
  try {
    s.failSet = "POSY";
    const { result, isError } = await h.callJson("gma3_place_fixtures", { placements: [{ fid: 101, position: { x: 1, y: 2, z: 3 } }, { fid: 102, position: { x: 4 } }] });
    assert.equal(isError, true);
    assert.equal(result.outcome, "partial");
    assert.deepEqual(result.steps.filter((x: any) => x.op === "set").map((x: any) => `${x.name}:${x.status}`), ["101.POSX:succeeded", "101.POSY:failed", "101.POSZ:skipped", "102.POSX:skipped"]);
    assert.match(result.summary, /0 of 2 fixture\(s\) placed; changed only in part: FID 101 \(written: POSX\); 1 not changed; stopped at 101.POSY failed/);
    assert.equal(result.verification.status, "matched", "the value that was written is verified");
    assert.match(result.summary, /Read-back of the written values matched/);
    assert.equal(s.fixtures.get(101)!.pos.x, 1);
  } finally {
    await h.close();
  }
});

test("review P2: chained mirror pairs resolve in dependency order; a cycle is refused", async () => {
  const { h } = await setup();
  try {
    const { result } = await h.callJson("gma3_place_fixtures", { placements: [{ fid: 101, position: { x: 2, y: 1, z: 3 } }], layouts: [{ kind: "mirror", pairs: [[102, 103], [101, 102]] }], preview: true });
    const by = Object.fromEntries(result.plan.map((p: any) => [p.fid, p.position]));
    assert.deepEqual(by[102], { x: -2, y: 1, z: 3 });
    assert.deepEqual(by[103], { x: 2, y: 1, z: 3 }, "103 mirrors 102's final pose, whatever the order of the pairs");
    const r = await h.callJson("gma3_place_fixtures", { layouts: [{ kind: "mirror", pairs: [[101, 102], [102, 101]] }] });
    assert.equal(r.result.outcome, "failed");
    assert.match(r.result.validationErrors.join(" "), /mirror pairs form a cycle \(FID (101 -> 102 -> 101|102 -> 101 -> 102)\)/);
  } finally {
    await h.close();
  }
});
