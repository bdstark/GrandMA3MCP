/**
 * SU-04: fixture positions in 3D (SETUP.md SU-04, docs/probes/su-04-positions-macos-2.5.1.md).
 *
 * Read: gma3_fixture_positions. Change: gma3_place_fixtures. No bridge change: positions and rotations are
 * properties of the live patch's fixtures, written with the bridge's `set` op (no Lua) and read with `objects`.
 *
 * Console facts (onPC 2.5.1, live 2026-10-15):
 *   - POSX/POSY/POSZ in metres (display: millimetres), ROTX/ROTY/ROTZ in degrees (display: 0.01°). X positive is
 *     stage left, Y positive upstage, Z positive up.
 *   - ROTDIRECT displays the rotation as a quaternion "x,y,z,w"; it is q = qZ·qY·qX of the three angles.
 *   - The console renormalizes the angles a frame later (Y within ±90°) and keeps the quaternion, so a rotation is
 *     verified by quaternion, and is always given as all three angles. Writing the three angles in separate
 *     requests is wrong: the renormalization between them combines a new angle with already-rewritten ones
 *     ((30, 100, 20) became (-150, 80, 20), live). A rotation is written as one ROTDIRECT quaternion instead.
 *   - SCALEX/Y/Z ignore writes (no error): not offered. MESHMIRRORX takes the text "1" / "0" only.
 *   - An open patch copy overwrites position writes when it is committed: refused while the copy is open.
 *   - No undo (Oops fails): the result carries every fixture's previous values for a manual restore.
 */
import { z } from "zod";
import type { Gma3Bridge } from "../bridge.js";
import { asRead, buildResult, notRequested, stepFromError, unavailable, validationFailure, type OperationResult, type StepResult, type Verification } from "../results.js";
import { Validator, ValidationError, describe, finiteNumber } from "../validate.js";
import { operation, type RegisterTools, type ToolContext } from "./context.js";
import { listFids } from "./patch.js";

// ---------------------------------------------------------------------------
// Units, rotations, layouts (pure)
// ---------------------------------------------------------------------------

export const UNITS = { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048, in: 0.0254 } as const;
export type Unit = keyof typeof UNITS;
const UNIT_NAMES = Object.keys(UNITS) as Unit[];

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
/** Quaternion as the console displays it: x, y, z, w. */
export type Quat = [number, number, number, number];

export const AXES = {
  x: "X: positive is stage left",
  y: "Y: positive is upstage (negative is downstage, towards the audience)",
  z: "Z: positive is up (height above the stage)",
  rot_x: "rotation X, about the fixture's own X axis: positive tilts its top downstage",
  rot_y: "rotation Y, about its own Y axis: positive tilts its top stage left",
  rot_z: "rotation Z, about its own Z axis: positive is counter-clockwise seen from above",
  units: "the console stores metres and degrees; positions here are in the requested unit",
} as const;

const rad = (deg: number) => (deg * Math.PI) / 180;

function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

/** The console's rotation for angles in degrees: q = qZ · qY · qX (probe 2026-10-15). */
export function quatFromEuler(r: Vec3): Quat {
  const ax = (deg: number, i: 0 | 1 | 2): Quat => {
    const h = rad(deg) / 2;
    const q: Quat = [0, 0, 0, Math.cos(h)];
    q[i] = Math.sin(h);
    return q;
  };
  return quatMul(quatMul(ax(r.z, 2), ax(r.y, 1)), ax(r.x, 0));
}

/** Same rotation (q and -q are the same rotation), within the display's 6 decimals. */
export function quatEquivalent(a: Quat, b: Quat, tol = 2e-4): boolean {
  const same = a.every((v, i) => Math.abs(v - b[i]) <= tol);
  const opposite = a.every((v, i) => Math.abs(v + b[i]) <= tol);
  return same || opposite;
}

export function parseQuat(text: unknown): Quat | null {
  if (typeof text !== "string") return null;
  const parts = text.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts as Quat;
}

/** Mirror across the stage centre line (the X = 0 plane): x is negated; the rotation M·R·M is (rx, -ry, -rz). */
export function mirrorAcrossCentre(p: Vec3, r: Vec3): { position: Vec3; rotation: Vec3 } {
  return { position: { x: -p.x, y: p.y, z: p.z }, rotation: { x: r.x, y: -r.y, z: -r.z } };
}

const round = (v: number, digits: number) => {
  const f = 10 ** digits;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

interface PartialVec {
  x?: number;
  y?: number;
  z?: number;
}

interface PlacementInput {
  fid: number;
  position?: PartialVec;
  rotation?: Vec3;
  mirror_mesh?: boolean;
}

type LayoutInput =
  | { kind: "line"; fids: number[]; from: Vec3; to: Vec3; rotation?: Vec3 }
  | { kind: "arc"; fids: number[]; center: Vec3; radius: number; start_deg: number; end_deg: number; rotation?: Vec3; follow?: boolean }
  | { kind: "mirror"; pairs: Array<[number, number]> };

interface PlaceArgs {
  unit?: string;
  placements?: PlacementInput[];
  layouts?: LayoutInput[];
  preview?: boolean;
  verify?: boolean;
}

/** A planned change for one fixture, in metres and degrees. `from` names the request entry it came from. */
export interface Planned {
  fid: number;
  position?: PartialVec;
  rotation?: Vec3;
  mirrorMesh?: boolean;
  from: string;
  /** Set for a mirror target: its values come from the source's final placement. */
  mirrorOf?: number;
}

const MAX_FIXTURES = 256;

function fidOf(field: string, v: unknown): number {
  const n = finiteNumber(field, v, { integer: true, min: 1, max: 99_999_999 });
  return n as number;
}

function vec(field: string, v: unknown, scale: number, partial: true): PartialVec;
function vec(field: string, v: unknown, scale: number, partial: false): Vec3;
function vec(field: string, v: unknown, scale: number, partial: boolean): PartialVec | Vec3 {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ValidationError(`${field} must be an object {x, y, z} (got ${describe(v)})`, field);
  const o = v as Record<string, unknown>;
  const out: PartialVec = {};
  for (const k of ["x", "y", "z"] as const) {
    const n = finiteNumber(`${field}.${k}`, o[k], { optional: partial, min: -1e5, max: 1e5 });
    if (n !== undefined) out[k] = n * scale;
  }
  for (const k of Object.keys(o)) if (!["x", "y", "z"].includes(k)) throw new ValidationError(`${field} has an unknown key ${k} (x, y, z only)`, field);
  if (partial && out.x === undefined && out.y === undefined && out.z === undefined) throw new ValidationError(`${field} needs at least one of x, y, z`, field);
  return out;
}

const rotation = (field: string, v: unknown): Vec3 => {
  try {
    return vec(field, v, 1, false);
  } catch (err) {
    if (err instanceof ValidationError) throw new ValidationError(`${err.message} (a rotation is always all three angles: the console renormalizes them, so one axis cannot be changed on its own)`, field);
    throw err;
  }
};

/** Expand placements and layouts into one plan; errors collect in v. Mirror targets are resolved later. */
export function expandPlan(raw: PlaceArgs, unit: Unit, v: Validator): Planned[] {
  const s = UNITS[unit];
  const plan: Planned[] = [];
  (raw.placements ?? []).forEach((p, i) => {
    const f = `placements[${i}]`;
    const fid = v.check(() => fidOf(`${f}.fid`, p?.fid));
    const position = p?.position !== undefined ? v.check(() => vec(`${f}.position`, p.position, s, true)) : undefined;
    const rot = p?.rotation !== undefined ? v.check(() => rotation(`${f}.rotation`, p.rotation)) : undefined;
    if (p?.mirror_mesh !== undefined && typeof p.mirror_mesh !== "boolean") v.fail(`${f}.mirror_mesh must be true or false`);
    if (p && p.position === undefined && p.rotation === undefined && p.mirror_mesh === undefined) v.fail(`${f} changes nothing (give position, rotation and/or mirror_mesh)`);
    if (fid !== undefined) plan.push({ fid, ...(position ? { position } : {}), ...(rot ? { rotation: rot } : {}), ...(typeof p.mirror_mesh === "boolean" ? { mirrorMesh: p.mirror_mesh } : {}), from: f });
  });
  (raw.layouts ?? []).forEach((l, i) => {
    const f = `layouts[${i}]`;
    if (!l || typeof l !== "object") return v.fail(`${f} must be an object`);
    if (l.kind === "mirror") {
      if (!Array.isArray(l.pairs) || l.pairs.length === 0) return v.fail(`${f}.pairs must be a non-empty list of [source_fid, target_fid]`);
      l.pairs.forEach((pair, j) => {
        if (!Array.isArray(pair) || pair.length !== 2) return v.fail(`${f}.pairs[${j}] must be [source_fid, target_fid]`);
        const src = v.check(() => fidOf(`${f}.pairs[${j}][0]`, pair[0]));
        const dst = v.check(() => fidOf(`${f}.pairs[${j}][1]`, pair[1]));
        if (src !== undefined && dst !== undefined) {
          if (src === dst) v.fail(`${f}.pairs[${j}] mirrors FID ${src} onto itself`);
          else plan.push({ fid: dst, mirrorOf: src, from: `${f}.pairs[${j}]` });
        }
      });
      return;
    }
    if (l.kind !== "line" && l.kind !== "arc") return v.fail(`${f}.kind must be line, arc or mirror (got ${describe((l as { kind?: unknown }).kind)})`);
    if (!Array.isArray(l.fids) || l.fids.length === 0) return v.fail(`${f}.fids must be a non-empty list of FIDs`);
    const fids = l.fids.map((x, j) => v.check(() => fidOf(`${f}.fids[${j}]`, x)));
    const rot = l.rotation !== undefined ? v.check(() => rotation(`${f}.rotation`, l.rotation)) : undefined;
    const n = fids.length;
    if (l.kind === "line") {
      const from = v.check(() => vec(`${f}.from`, l.from, s, false));
      const to = v.check(() => vec(`${f}.to`, l.to, s, false));
      if (!from || !to) return;
      fids.forEach((fid, k) => {
        if (fid === undefined) return;
        const t = n === 1 ? 0 : k / (n - 1);
        plan.push({ fid, position: { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t }, ...(rot ? { rotation: rot } : {}), from: `${f} (line, fixture ${k + 1} of ${n})` });
      });
    } else {
      const center = v.check(() => vec(`${f}.center`, l.center, s, false));
      const radius = v.check(() => finiteNumber(`${f}.radius`, l.radius, { min: 0, max: 1e5 }));
      const a0 = v.check(() => finiteNumber(`${f}.start_deg`, l.start_deg, { min: -3600, max: 3600 }));
      const a1 = v.check(() => finiteNumber(`${f}.end_deg`, l.end_deg, { min: -3600, max: 3600 }));
      if (l.follow !== undefined && typeof l.follow !== "boolean") v.fail(`${f}.follow must be true or false`);
      if (!center || radius === undefined || a0 === undefined || a1 === undefined) return;
      const r = radius * s;
      fids.forEach((fid, k) => {
        if (fid === undefined) return;
        const a = n === 1 ? a0 : a0 + ((a1 - a0) * k) / (n - 1);
        const base = rot ?? { x: 0, y: 0, z: 0 };
        const rotationK = l.follow ? { ...base, z: base.z + a } : rot;
        plan.push({ fid, position: { x: center.x + r * Math.cos(rad(a)), y: center.y + r * Math.sin(rad(a)), z: center.z }, ...(rotationK ? { rotation: rotationK } : {}), from: `${f} (arc, ${round(a, 3)}°)` });
      });
    }
  });
  const seen = new Map<number, string>();
  for (const p of plan) {
    const prev = seen.get(p.fid);
    if (prev) v.fail(`FID ${p.fid} is placed twice (${prev} and ${p.from})`);
    else seen.set(p.fid, p.from);
  }
  // Mirror pairs may chain (A -> B, B -> C: C mirrors B's final pose); a cycle has no final pose.
  const mirrorOf = new Map(plan.filter((p) => p.mirrorOf !== undefined).map((p) => [p.fid, p.mirrorOf as number]));
  const reported = new Set<number>();
  for (const start of mirrorOf.keys()) {
    const path: number[] = [start];
    let cur = mirrorOf.get(start);
    while (cur !== undefined && !path.includes(cur)) {
      path.push(cur);
      cur = mirrorOf.get(cur);
    }
    if (cur !== undefined && !reported.has(cur)) {
      const cycle = path.slice(path.indexOf(cur));
      cycle.forEach((f) => reported.add(f));
      v.fail(`mirror pairs form a cycle (FID ${[...cycle, cur].join(" -> ")}): no fixture in it has a pose to mirror`);
    }
  }
  if (plan.length === 0) v.fail("nothing to place: give placements and/or layouts");
  if (plan.length > MAX_FIXTURES) v.fail(`at most ${MAX_FIXTURES} fixtures per call`);
  return plan;
}

// ---------------------------------------------------------------------------
// Console reads
// ---------------------------------------------------------------------------

// Read raw (asText: false: full-precision metres and degrees, a boolean mirror flag); the display role has only
// millimetres. ROTDIRECT has no raw value, so the quaternion is a second, display-role read.
const RAW_FIELDS = ["FID", "Name", "POSX", "POSY", "POSZ", "ROTX", "ROTY", "ROTZ", "MESHMIRRORX"];
const QUAT_FIELDS = ["FID", "ROTDIRECT"];

export interface FixturePose {
  fid: number;
  name: string;
  position: Vec3;
  rotation: Vec3;
  quaternion: Quat | null;
  mirrorMesh: boolean;
  /** Fields that were missing or not a number (never read as 0). */
  unreadable: string[];
}

type Item = { name?: string; class?: string; fields?: Record<string, unknown> };

/** A number from a raw (or display) value; missing, empty or non-numeric values are NaN, never 0. */
function num(v: unknown): number {
  if (v === undefined || v === null) return NaN;
  const text = typeof v === "number" ? null : String(v).replace(/[°\s]/g, "");
  if (text === "") return NaN;
  const n = text === null ? (v as number) : Number(text);
  if (!Number.isFinite(n)) return NaN;
  return Math.abs(n) < 1e-9 ? 0 : n; // the console keeps float noise such as 1.48e-32
}

function poseOf(item: Item, quat?: unknown): FixturePose | null {
  const f = item.fields ?? {};
  const fid = Number(f.FID);
  if (!Number.isInteger(fid)) return null;
  const mirror = f.MESHMIRRORX;
  const pose: FixturePose = {
    fid,
    name: String(f.Name ?? item.name ?? ""),
    position: { x: num(f.POSX), y: num(f.POSY), z: num(f.POSZ) },
    rotation: { x: num(f.ROTX), y: num(f.ROTY), z: num(f.ROTZ) },
    quaternion: parseQuat(quat),
    mirrorMesh: mirror === true || String(mirror ?? "").trim().toLowerCase() === "yes",
    unreadable: [],
  };
  for (const k of ["x", "y", "z"] as const) {
    if (!Number.isFinite(pose.position[k])) pose.unreadable.push(`POS${k.toUpperCase()}`);
    if (!Number.isFinite(pose.rotation[k])) pose.unreadable.push(`ROT${k.toUpperCase()}`);
  }
  if (!pose.quaternion) pose.unreadable.push("ROTDIRECT");
  if (typeof mirror !== "boolean" && typeof mirror !== "string") pose.unreadable.push("MESHMIRRORX");
  return pose;
}

/** Poses of the fixtures `ref` resolves to: raw values and, in a second read, the quaternion. */
async function readPosesOf(bridge: Gma3Bridge, ref: string, t: number, limit: number): Promise<FixturePose[]> {
  const tt = Math.max(t, 30_000);
  const raw = (await bridge.request("objects", { ref, fields: RAW_FIELDS, limit, asText: false }, tt)) as { items?: Item[] };
  const disp = (await bridge.request("objects", { ref, fields: QUAT_FIELDS, limit }, tt)) as { items?: Item[] };
  const quats = new Map<number, unknown>();
  for (const d of disp.items ?? []) if (d.class === "Fixture") quats.set(Number(d.fields?.FID), d.fields?.ROTDIRECT);
  const out: FixturePose[] = [];
  for (const item of raw.items ?? []) {
    if (item.class !== "Fixture") continue;
    const p = poseOf(item, quats.get(Number(item.fields?.FID)));
    if (p) out.push(p);
  }
  return out;
}

/** Poses of the given FIDs, read with `objects` in chunks ("Fixture a + b + ..."). */
export async function readPoses(bridge: Gma3Bridge, fids: number[], t: number): Promise<Map<number, FixturePose>> {
  const out = new Map<number, FixturePose>();
  for (let i = 0; i < fids.length; i += 50) {
    const chunk = fids.slice(i, i + 50);
    for (const p of await readPosesOf(bridge, `Fixture ${chunk.join(" + ")}`, t, 500)) if (chunk.includes(p.fid)) out.set(p.fid, p);
  }
  return out;
}

function poseOut(p: FixturePose, unit: Unit) {
  const s = UNITS[unit];
  return {
    fid: p.fid,
    name: p.name,
    position: { x: round(p.position.x / s, 4), y: round(p.position.y / s, 4), z: round(p.position.z / s, 4) },
    rotation: { x: round(p.rotation.x, 4), y: round(p.rotation.y, 4), z: round(p.rotation.z, 4) },
    quaternion: p.quaternion,
    mirror_mesh: p.mirrorMesh,
    ...(p.unreadable.length ? { unreadable: p.unreadable } : {}),
  };
}

// ---------------------------------------------------------------------------
// gma3_place_fixtures
// ---------------------------------------------------------------------------

const POS_TOL_M = 0.0001; // read raw: full precision
const FRAME_WAIT_MS = 150; // the console renormalizes rotations a frame later
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Final {
  fid: number;
  position: Vec3;
  rotation: Vec3;
  /** Rotation to write (all three angles), or undefined to leave it. */
  writeRotation?: Vec3;
  writePosition: PartialVec;
  mirrorMesh?: boolean;
  from: string;
}

export async function placeFixtures(ctx: ToolContext, raw: PlaceArgs): Promise<OperationResult> {
  const op = "place_fixtures";
  const v = new Validator();
  const unit = (raw.unit ?? "m") as Unit;
  if (!UNIT_NAMES.includes(unit)) v.fail(`unit must be one of ${UNIT_NAMES.join(", ")} (got ${describe(raw.unit)})`);
  const plan = UNIT_NAMES.includes(unit) ? expandPlan(raw, unit, v) : [];
  const target: Record<string, unknown> = { fids: plan.map((p) => p.fid), unit };
  if (!v.ok) return validationFailure(op, target, v.errors);
  const t = ctx.requestTimeoutMs;
  const bridge = ctx.bridge;
  const verify = raw.verify !== false;
  const preview = raw.preview === true;
  const sources = [...new Set(plan.filter((p) => p.mirrorOf !== undefined).map((p) => p.mirrorOf as number))];
  const allFids = [...new Set([...plan.map((p) => p.fid), ...sources])];
  const steps: StepResult[] = [];
  const done = (summary: string, verification: Verification, extra: Record<string, unknown> = {}) => buildResult({ operation: op, target, steps, verification, summary, extra: { unit, axes: AXES, ...extra } });

  // Everything from the first read to the read-back holds the mutation lock: another queued operation cannot change
  // the poses or open the patch copy between the checks, the restore values and the writes.
  return ctx.mutations.run(async () => {
    // Read-only pre-flight: the patch copy, the fixtures, their current poses.
    try {
      const st = (await bridge.request("patch.state", {}, t)) as { copyOpen?: boolean };
      if (st.copyOpen) {
        steps.push(asRead({ name: "check_patch", status: "failed", op: "patch.state", error: "the patch copy is open (the Patch menu, or a patch session): committing it would overwrite these positions. Close it at the console first (Menu > Patch, Save and Exit or Discard and Exit)" }));
        return done(`${op} was not performed; nothing was sent: ${steps[0].error}.`, notRequested());
      }
      steps.push(asRead({ name: "check_patch", status: "succeeded", op: "patch.state", detail: "the patch copy is closed" }));
    } catch (err) {
      steps.push(asRead(stepFromError("check_patch", err, { op: "patch.state" })));
      return done(`${op} was not performed; the patch state could not be read.`, notRequested());
    }
    let before: Map<number, FixturePose>;
    try {
      const rows = await listFids(bridge, allFids, t);
      const problems: string[] = [];
      for (const fid of allFids) {
        const r = rows.get(fid);
        if (!r) problems.push(`no fixture with FID ${fid}`);
        else if (typeof r.depth === "number" && r.depth > 0) problems.push(`FID ${fid} is inside a grouping fixture (FID ${r.parentFid}): whether its position is relative to the parent is not established`);
      }
      before = await readPoses(bridge, allFids, t);
      for (const fid of allFids) {
        const b = before.get(fid);
        if (rows.has(fid) && !b) problems.push(`the position of FID ${fid} could not be read`);
        // The current pose is needed for axes not given, mirror sources and the restore list.
        const bad = b?.unreadable.filter((k) => k !== "ROTDIRECT" && k !== "MESHMIRRORX") ?? [];
        if (bad.length) problems.push(`FID ${fid}: ${bad.join(", ")} could not be read as numbers`);
      }
      if (problems.length) {
        steps.push(asRead({ name: "check_fixtures", status: "failed", op: "patch.list", error: problems.join("; ") }));
        return done(`${op} was not performed; nothing was sent: ${problems.join("; ")}.`, notRequested());
      }
      steps.push(asRead({ name: "check_fixtures", status: "succeeded", op: "objects", detail: { fixtures: allFids.length } }));
    } catch (err) {
      steps.push(asRead(stepFromError("check_fixtures", err, { op: "objects" })));
      return done(`${op} was not performed; the fixtures could not be read.`, notRequested());
    }

    // Final poses. A mirror target takes its source's final pose, resolved in dependency order, so chained pairs do
    // not depend on the order they were given in (cycles were refused by expandPlan).
    const planned = new Map(plan.map((p) => [p.fid, p]));
    const finals = new Map<number, Final>();
    const finalFor = (fid: number): Final => {
      const known = finals.get(fid);
      if (known) return known;
      const p = planned.get(fid) ?? { fid, from: "current" };
      const b = before.get(fid) as FixturePose;
      let f: Final;
      if (p.mirrorOf !== undefined) {
        const src = finalFor(p.mirrorOf);
        const m = mirrorAcrossCentre(src.position, src.rotation);
        f = { fid, position: m.position, rotation: m.rotation, writePosition: m.position, writeRotation: m.rotation, from: `${p.from} (mirror of FID ${p.mirrorOf} across the stage centre line)` };
      } else {
        f = { fid, position: { ...b.position, ...(p.position ?? {}) }, rotation: p.rotation ?? b.rotation, writePosition: p.position ?? {}, ...(p.rotation ? { writeRotation: p.rotation } : {}), ...(p.mirrorMesh !== undefined ? { mirrorMesh: p.mirrorMesh } : {}), from: p.from };
      }
      if (planned.has(fid)) finals.set(fid, f);
      return f;
    };
    for (const p of plan) finalFor(p.fid);
    const ordered = plan.map((p) => finals.get(p.fid) as Final);
    const s = UNITS[unit];
    const planOut = ordered.map((f) => ({
      fid: f.fid,
      name: before.get(f.fid)?.name,
      from: f.from,
      position: { x: round(f.position.x / s, 4), y: round(f.position.y / s, 4), z: round(f.position.z / s, 4) },
      rotation: { x: round(f.rotation.x, 3), y: round(f.rotation.y, 3), z: round(f.rotation.z, 3) },
      ...(f.mirrorMesh !== undefined ? { mirror_mesh: f.mirrorMesh } : {}),
      before: poseOut(before.get(f.fid) as FixturePose, unit),
    }));
    const restore = ordered.map((f) => {
      const b = poseOut(before.get(f.fid) as FixturePose, unit);
      return { fid: f.fid, position: b.position, rotation: b.rotation, mirror_mesh: b.mirror_mesh };
    });
    if (preview) return done(`Preview only; nothing was sent (${ordered.length} fixture(s)).`, notRequested(), { preview: true, plan: planOut });

    // Writes: one step per property, so a fixture changed only in part is reported as such; stop at the first failure.
    const writes = ordered.map((f) => {
      const sets: Array<[string, number | string]> = [];
      for (const k of ["x", "y", "z"] as const) if (f.writePosition[k] !== undefined) sets.push([`POS${k.toUpperCase()}`, round(f.writePosition[k] as number, 5)]);
      // One write: per-axis writes are renormalized between requests (see the header).
      if (f.writeRotation) sets.push(["ROTDIRECT", quatFromEuler(f.writeRotation).map((n) => round(n, 9)).join(",")]);
      if (f.mirrorMesh !== undefined) sets.push(["MESHMIRRORX", f.mirrorMesh ? "1" : "0"]);
      return { f, sets };
    });
    const written = new Map<number, Set<string>>();
    // A write whose reply was lost may have executed: its fixture's state is unknown, never "not changed".
    const uncertain = new Map<number, string>();
    let stopped: string | undefined;
    for (const { f, sets } of writes) {
      for (const [property, value] of sets) {
        const name = `${f.fid}.${property}`;
        if (stopped) {
          steps.push({ name, status: "skipped", op: "set", error: `not attempted: ${stopped}` });
          continue;
        }
        try {
          const reply = await bridge.request("set", { ref: `Fixture ${f.fid}`, property, value }, t);
          steps.push({ name, status: "succeeded", op: "set", detail: { value, reply: (reply as { value?: unknown })?.value } });
          if (!written.has(f.fid)) written.set(f.fid, new Set());
          written.get(f.fid)?.add(property);
        } catch (err) {
          const st = stepFromError(name, err, { op: "set", detail: { value } });
          steps.push(st);
          if (st.status === "unknown") uncertain.set(f.fid, property);
          stopped = `${name} ${st.status === "unknown" ? "got no reply (it may have been written)" : "failed"}`;
        }
      }
    }

    // Read-back of exactly what was written, including a fixture changed only in part; a write without a reply is
    // read back too, to report what the console holds now (it does not count towards the verification).
    let verification: Verification = notRequested();
    let after: Map<number, FixturePose> | undefined;
    const uncertainWrites: Array<{ fid: number; property: string; applied: boolean | null; observed: unknown }> = [];
    if (verify && (written.size || uncertain.size)) {
      await sleep(FRAME_WAIT_MS);
      try {
        after = await readPoses(bridge, [...new Set([...written.keys(), ...uncertain.keys()])], t);
        for (const [fid, property] of uncertain) {
          const f = finals.get(fid) as Final;
          const a = after.get(fid);
          let applied: boolean | null = null;
          let observed: unknown = null;
          if (a && property.startsWith("POS")) {
            const k = property.slice(3).toLowerCase() as "x" | "y" | "z";
            observed = Number.isFinite(a.position[k]) ? round(a.position[k] / s, 4) : null;
            if (observed !== null) applied = Math.abs(a.position[k] - f.position[k]) <= POS_TOL_M;
          } else if (a && property === "ROTDIRECT" && f.writeRotation) {
            observed = a.quaternion;
            if (a.quaternion) applied = quatEquivalent(quatFromEuler(f.writeRotation), a.quaternion);
          } else if (a && property === "MESHMIRRORX" && f.mirrorMesh !== undefined && !a.unreadable.includes("MESHMIRRORX")) {
            observed = a.mirrorMesh;
            applied = a.mirrorMesh === f.mirrorMesh;
          }
          uncertainWrites.push({ fid, property, applied, observed });
        }
        const mismatches: string[] = [];
        const unreadable: string[] = [];
        const actual: unknown[] = [];
        for (const [fid, props] of written) {
          const f = finals.get(fid) as Final;
          const a = after.get(fid);
          if (!a) {
            unreadable.push(`FID ${fid}: not read back`);
            continue;
          }
          actual.push(poseOut(a, unit));
          for (const k of ["x", "y", "z"] as const) {
            if (!props.has(`POS${k.toUpperCase()}`)) continue;
            if (!Number.isFinite(a.position[k])) unreadable.push(`FID ${fid} POS${k.toUpperCase()}`);
            else if (Math.abs(a.position[k] - f.position[k]) > POS_TOL_M) mismatches.push(`FID ${fid} ${k}: ${round(a.position[k] / s, 4)} ${unit}, expected ${round(f.position[k] / s, 4)}`);
          }
          if (props.has("ROTDIRECT") && f.writeRotation) {
            if (!a.quaternion) unreadable.push(`FID ${fid} ROTDIRECT`);
            else if (!quatEquivalent(quatFromEuler(f.writeRotation), a.quaternion)) mismatches.push(`FID ${fid} rotation: the console reports ${JSON.stringify(a.rotation)} (quaternion ${a.quaternion.join(",")}), which is not ${JSON.stringify(f.writeRotation)}`);
          }
          if (props.has("MESHMIRRORX") && f.mirrorMesh !== undefined) {
            if (a.unreadable.includes("MESHMIRRORX")) unreadable.push(`FID ${fid} MESHMIRRORX`);
            else if (a.mirrorMesh !== f.mirrorMesh) mismatches.push(`FID ${fid} mirror_mesh: ${a.mirrorMesh}, expected ${f.mirrorMesh} (the console ignored the write)`);
          }
        }
        const checked = `the properties that were written: positions within ${POS_TOL_M * 1000} mm, rotations by quaternion (the console renormalizes the angles), mirror_mesh; read a frame after the writes`;
        if (written.size === 0) verification = unavailable("no write was confirmed (see uncertainWrites for what the console holds now)", checked);
        else if (mismatches.length) verification = { status: "mismatched", checked, actual, detail: [...mismatches, ...unreadable.map((u) => `${u} unreadable`)].join("; ") };
        else if (unreadable.length) verification = unavailable(`could not be read back as values: ${unreadable.join("; ")}`, checked);
        else verification = { status: "matched", checked, actual };
      } catch (err) {
        steps.push(asRead(stepFromError("read_back", err, { op: "objects" })));
        verification = unavailable("the positions could not be read back");
      }
    }

    const writtenList = (fid: number) => [...(written.get(fid) ?? [])].join(", ");
    const isComplete = ({ f, sets }: (typeof writes)[number]) => !uncertain.has(f.fid) && sets.every(([p]) => written.get(f.fid)?.has(p));
    const complete = writes.filter(isComplete).length;
    const unknownState = writes
      .filter(({ f }) => uncertain.has(f.fid))
      .map(({ f }) => {
        const prop = uncertain.get(f.fid) as string;
        const seen = uncertainWrites.find((u) => u.fid === f.fid);
        const readBack = !seen ? "not read back" : seen.applied === true ? "read back: applied" : seen.applied === false ? "read back: not applied" : "read back: unreadable";
        return `FID ${f.fid} (${prop} got no reply; ${readBack}${written.get(f.fid)?.size ? `; written before it: ${writtenList(f.fid)}` : ""})`;
      });
    const partly = writes.filter((w) => !isComplete(w) && !uncertain.has(w.f.fid) && (written.get(w.f.fid)?.size ?? 0) > 0).map(({ f }) => `FID ${f.fid} (written: ${writtenList(f.fid)})`);
    const untouched = writes.length - complete - unknownState.length - partly.length;
    const what = verification.status === "matched" ? " Read-back of the written values matched." : verification.status === "mismatched" ? ` Read-back MISMATCHED: ${verification.detail}` : verification.status === "unavailable" ? ` Read-back unavailable: ${verification.detail}` : "";
    const summary =
      `${complete} of ${writes.length} fixture(s) placed` +
      (unknownState.length ? `; state unknown: ${unknownState.join("; ")}` : "") +
      (partly.length ? `; changed only in part: ${partly.join("; ")}` : "") +
      (untouched ? `; ${untouched} not changed` : "") +
      (stopped ? `; stopped at ${stopped}` : "") +
      `.${what} There is no undo (Oops does not revert positions): \`restore\` holds the previous values.`;
    return done(summary, verification, {
      fixtures: planOut.map((p) => ({ ...p, ...(after?.get(p.fid) ? { after: poseOut(after.get(p.fid) as FixturePose, unit) } : {}) })),
      restore,
      ...(uncertain.size ? { uncertainWrites: uncertainWrites.length ? uncertainWrites : [...uncertain].map(([fid, property]) => ({ fid, property, applied: null, observed: null })) } : {}),
    });
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const vec3 = (what: string) => z.object({ x: z.number(), y: z.number(), z: z.number() }).describe(what);
const vec3Partial = z.object({ x: z.number().optional(), y: z.number().optional(), z: z.number().optional() });
const UNIT_DESC = 'Unit for positions and radii: m (default), cm, mm, ft or in. The console stores metres; rotations are always degrees.';

export const registerPositionTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_fixture_positions",
    {
      title: "Read fixture positions in 3D",
      description:
        "Read-only. Position, rotation and mesh mirroring of fixtures in the 3D stage, with the axes' meaning: X positive is stage left, Y positive is upstage, Z positive is up. " +
        "Rotations are degrees as the console reports them (it renormalizes them, e.g. 0/180/0 reads 180/0/180), plus the quaternion (x,y,z,w) that identifies the rotation exactly. Positions in the requested unit.",
      inputSchema: {
        fids: z.array(z.number()).optional().describe("Fixture IDs (up to 256)."),
        fixtures: z.string().optional().describe('Instead of fids: a command-line fixture range, e.g. "Fixture 101 Thru 112".'),
        unit: z.enum(UNIT_NAMES as [Unit, ...Unit[]]).optional().describe(UNIT_DESC),
      },
    },
    async (args) =>
      operation(async () => {
        const unit = (args.unit ?? "m") as Unit;
        const t = ctx.requestTimeoutMs;
        let poses: FixturePose[];
        if (args.fixtures !== undefined) {
          if (!/^[\w .+-]+$/.test(args.fixtures) || !/^fixture\b/i.test(args.fixtures.trim())) return validationFailure("fixture_positions", { fixtures: args.fixtures }, ['fixtures must be a command-line fixture range such as "Fixture 101 Thru 112"']);
          poses = await readPosesOf(ctx.bridge, args.fixtures, t, 2000);
        } else {
          const fids = Array.isArray(args.fids) ? args.fids : [];
          if (fids.length === 0 || fids.length > MAX_FIXTURES || fids.some((f) => !Number.isInteger(f) || f < 1)) return validationFailure("fixture_positions", { fids }, [`give fids (1-${MAX_FIXTURES} positive integers) or fixtures`]);
          const m = await readPoses(ctx.bridge, fids, t);
          poses = fids.map((f) => m.get(f)).filter((p): p is FixturePose => p !== undefined);
          const missing = fids.filter((f) => !m.has(f));
          if (missing.length) return { ...buildResult({ operation: "fixture_positions", target: { fids }, steps: [asRead({ name: "read", status: "failed", op: "objects", error: `no fixture with FID ${missing.join(", ")}` })] }) };
        }
        return buildResult({ operation: "fixture_positions", target: { unit }, steps: [asRead({ name: "read", status: "succeeded", op: "objects", detail: { count: poses.length } })], verification: notRequested(), summary: `${poses.length} fixture(s).`, extra: { unit, axes: AXES, fixtures: poses.map((p) => poseOut(p, unit)) } });
      }),
  );

  server.registerTool(
    "gma3_place_fixtures",
    {
      title: "Place fixtures in 3D",
      description:
        "Set fixtures' position, rotation and mesh mirroring in the 3D stage (X positive stage left, Y positive upstage, Z positive up). Positions in unit (m, cm, mm, ft, in); rotations in degrees, always all three angles " +
        "(the console renormalizes them, so one axis cannot be changed on its own; read the current rotation with gma3_fixture_positions). " +
        "placements: [{fid, position?: {x?, y?, z?}, rotation?: {x, y, z}, mirror_mesh?}] (position axes not given stay). layouts expand into placements: " +
        "line {kind: 'line', fids, from, to, rotation?} spaces fixtures evenly from..to (inclusive); " +
        "arc {kind: 'arc', fids, center, radius, start_deg, end_deg, rotation?, follow?} spaces them on a horizontal arc (0° = stage left of the centre, 90° = upstage; follow adds the arc angle to rotation z); " +
        "mirror {kind: 'mirror', pairs: [[source_fid, target_fid]]} puts each target at its source's final pose mirrored across the stage centre line (x negated, rotation y and z negated). " +
        "preview: true returns the expanded plan with every fixture's current values and sends nothing. Refused while the patch copy is open (committing it would overwrite the positions). " +
        "Scale is not offered: the console ignores scale writes. mirror_mesh is the fixture's MeshMirrorX flag (its 3D model mirrored). Read back a frame later: positions within 0.1 mm, rotations by quaternion. " +
        "NO UNDO (Oops does not revert positions): the result's restore list holds every fixture's previous values in the same format.",
      inputSchema: {
        unit: z.enum(UNIT_NAMES as [Unit, ...Unit[]]).optional().describe(UNIT_DESC),
        placements: z
          .array(
            z.object({
              fid: z.number().describe("Fixture ID (a top-level fixture; cells have no position of their own)."),
              position: vec3Partial.optional().describe("Position in unit; axes not given stay."),
              rotation: vec3("Rotation in degrees, all three angles.").optional(),
              mirror_mesh: z.boolean().optional().describe("Mirror the fixture's 3D model (MeshMirrorX)."),
            }),
          )
          .optional(),
        layouts: z
          .array(
            z.union([
              z.object({ kind: z.literal("line"), fids: z.array(z.number()), from: vec3("Start position in unit."), to: vec3("End position in unit."), rotation: vec3("Rotation for every fixture, degrees.").optional() }),
              z.object({
                kind: z.literal("arc"),
                fids: z.array(z.number()),
                center: vec3("Centre of the arc in unit; the arc is horizontal at center.z."),
                radius: z.number().describe("Radius in unit."),
                start_deg: z.number().describe("Angle of the first fixture: 0 = stage left of the centre, 90 = upstage, 180 = stage right, 270 = downstage."),
                end_deg: z.number().describe("Angle of the last fixture."),
                rotation: vec3("Rotation for every fixture, degrees.").optional(),
                follow: z.boolean().optional().describe("Add each fixture's arc angle to its rotation z."),
              }),
              z.object({ kind: z.literal("mirror"), pairs: z.array(z.tuple([z.number(), z.number()])).describe("[source_fid, target_fid] pairs.") }),
            ]),
          )
          .optional(),
        preview: z.boolean().optional().describe("Return the plan without sending anything."),
        verify: z.boolean().optional().describe("Read back and compare (default true)."),
      },
    },
    async (args) => operation(() => placeFixtures(ctx, args as PlaceArgs)),
  );
};

