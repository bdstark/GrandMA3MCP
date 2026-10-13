import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import {
  registerGroupTools,
  expandArrangement,
  expandFixtures,
  explicitItems,
  analyzeGrid,
  compareGrid,
  matricksValue,
  matricksWanted,
  allMatricksProps,
  MATRICKS_OTHER_DEFAULTS,
  type GridItem,
} from "../src/tools/groups.ts";
import { ValidationError } from "../src/validate.ts";

/**
 * A model of the console objects SB-02 touches, with the onPC 2.5.1 behaviour the probe established
 * (docs/probes/sb-02-groups-macos-2.5.1.md):
 *   - `Grid x/y/z` moves the cursor; `Fixture <id>` selects at the cursor; selecting a selected fixture is ignored;
 *   - Store Group keeps the selection in PATCH order (subfixture index), overwrites an existing group and keeps its
 *     name; a locked group answers "Object locked";
 *   - recalling `Group n` adds the cursor to the stored cells (with PreserveGridPositions);
 *   - Store MAtricks copies the selection MAtricks; MAtricks values the console does not accept are silently
 *     ignored; speed is read back in Hz in the edit role.
 */
interface Cell {
  id: string;
  x: number;
  y: number;
  z: number;
}

const PATCH: Record<string, number> = { "401": 63, "402": 64, "403": 65, "404": 66, "701": 5, "702": 6, "501": 10, "501.1": 11, "501.2": 12 };
const MTX_PROPS = [...allMatricksProps(), ...Object.keys(MATRICKS_OTHER_DEFAULTS)];
const freshMatricks = (): Record<string, string> => {
  const m: Record<string, string> = {};
  for (const p of allMatricksProps()) m[p] = "None";
  Object.assign(m, MATRICKS_OTHER_DEFAULTS);
  return m;
};

class Console {
  groups = new Map<number, { name: string; lock: string; preserve: string; cells: Cell[] }>();
  matricks = new Map<number, Record<string, string>>();
  selection: Cell[] = [];
  cursor = { x: 0, y: 0, z: 0 };
  selMtx = freshMatricks();
  /** Fixture ids whose Fixture command is answered OK but selects nothing. */
  ignoreSelect = new Set<string>();
  /** Answer the selection.grid / group.read ops as an old bridge would (unknown op). */
  oldBridge = false;
  /** Cells to shift after Store (simulating a console that stores something else). */
  corruptStore = false;
  /** MAtricks values the console refuses (silently kept). */
  refuse = new Set<string>();

  private read(c: Cell) {
    return { sfIndex: PATCH[c.id], fixture: c.id, fid: c.id.includes(".") ? null : Number(c.id), name: `fx ${c.id}`, x: c.x, y: c.y, z: c.z };
  }

  install(h: Harness): void {
    h.fake.on("objects", (args) => {
      const ref = String(args.ref);
      const fields = (args.fields as string[]) ?? [];
      let m: RegExpMatchArray | null;
      if ((m = ref.match(/^Fixture (\S+)$/))) {
        if (!(m[1] in PATCH)) throw new Error(`no objects found for '${ref}'`);
        return { total: 1, offset: 0, count: 1, items: [{ name: `fx ${m[1]}`, class: m[1].includes(".") ? "SubFixture" : "Fixture", fields: {} }] };
      }
      if ((m = ref.match(/^Group (\d+)$/))) {
        const g = this.groups.get(Number(m[1]));
        if (!g) throw new Error(`no objects found for '${ref}'`);
        return { total: 1, offset: 0, count: 1, items: [{ name: g.name, class: "Group", fields: pick({ Name: g.name, Lock: g.lock, StructureLocked: "No", SystemLocked: "No" }, fields) }] };
      }
      if ((m = ref.match(/^MAtricks (\d+)$/))) {
        const mt = this.matricks.get(Number(m[1]));
        if (!mt) throw new Error(`no objects found for '${ref}'`);
        return { total: 1, offset: 0, count: 1, items: [{ name: mt.Name, class: "MAtrick", fields: pick({ ...this.editRole(mt), StructureLocked: "No", SystemLocked: "No" }, fields) }] };
      }
      throw new Error(`unexpected objects ref ${ref}`);
    });
    h.fake.on("selection.grid", () => {
      if (this.oldBridge) throw new Error("unknown op 'selection.grid'");
      return { count: this.selection.length, items: this.selection.map((c) => this.read(c)) };
    });
    h.fake.on("group.read", (args) => {
      if (this.oldBridge) throw new Error("unknown op 'group.read'");
      const n = Number(String(args.ref).replace("Group ", ""));
      const g = this.groups.get(n);
      if (!g) throw new Error(`no object found for '${args.ref}'`);
      return { ref: args.ref, no: n, name: g.name, lock: g.lock, preserveGridPositions: g.preserve, count: g.cells.length, unreadable: 0, items: g.cells.map((c) => this.read(c)) };
    });
    h.fake.on("set", (args) => {
      const ref = String(args.ref);
      const property = String(args.property);
      const value = String(args.value);
      let m: RegExpMatchArray | null;
      if ((m = ref.match(/^Group (\d+)$/))) {
        const g = this.groups.get(Number(m[1]))!;
        if (g.lock === "") {
          if (property === "Name") g.name = value;
          if (property === "PreserveGridPositions") g.preserve = value;
        }
        return { ref, property, value: property === "Name" ? g.name : g.preserve };
      }
      if ((m = ref.match(/^MAtricks (\d+)$/))) {
        const mt = this.matricks.get(Number(m[1]))!;
        if (!this.refuse.has(`${property}=${value}`) && mt.Lock === "") mt[property] = value;
        return { ref, property, value: this.editRole(mt)[property] };
      }
      throw new Error(`unexpected set ref ${ref}`);
    });
    h.fake.on("cmd", (args) => {
      const c = String(args.command);
      let m: RegExpMatchArray | null;
      if (c === "ClearSelection") { this.selection = []; return { feedback: "OK" }; }
      if ((m = c.match(/^Grid (-?\d+)\/(-?\d+)\/(-?\d+)$/))) { this.cursor = { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) }; return { feedback: "OK" }; }
      if ((m = c.match(/^Fixture (\S+)$/))) {
        if (!(m[1] in PATCH)) return { feedback: "Object not found" };
        if (!this.ignoreSelect.has(m[1]) && !this.selection.some((s) => s.id === m![1])) this.selection.push({ id: m[1], ...this.cursor });
        return { feedback: "OK" };
      }
      if ((m = c.match(/^Store Group (\d+)( \/Overwrite)? \/NoConfirmation$/))) {
        const n = Number(m[1]);
        const old = this.groups.get(n);
        if (old?.lock) return { feedback: "Object locked" };
        const cells = [...this.selection].sort((a, b) => PATCH[a.id] - PATCH[b.id]).map((s) => ({ ...s }));
        if (this.corruptStore) cells[0].x += 1;
        this.groups.set(n, { name: old?.name ?? `Group ${n}`, lock: "", preserve: "Yes", cells });
        return { feedback: "OK" };
      }
      if ((m = c.match(/^Group (\d+)$/))) {
        const g = this.groups.get(Number(m[1]));
        if (!g) return { feedback: "Object not found" };
        for (const s of g.cells) if (!this.selection.some((x) => x.id === s.id)) this.selection.push({ id: s.id, x: s.x + this.cursor.x, y: s.y + this.cursor.y, z: s.z + this.cursor.z });
        return { feedback: "OK" };
      }
      if ((m = c.match(/^Store MAtricks (\d+) \/NoConfirmation$/))) {
        this.matricks.set(Number(m[1]), { ...this.selMtx, Name: `MAtrick ${m[1]}`, Lock: "" });
        return { feedback: "OK" };
      }
      throw new Error(`unexpected command ${c}`);
    });
  }

  /** Edit-role display: times "2.00", phase "360°" (up to 360) or "720.00", speed in Hz, "None". */
  editRole(mt: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(mt)) {
      if (v === "None" || !/^-?\d+(\.\d+)?$/.test(v)) { out[k] = v; continue; }
      if (k.startsWith("Speed")) out[k] = (Number(v) / 60).toFixed(6);
      else if (k.startsWith("Phase")) out[k] = Math.abs(Number(v)) <= 360 ? `${Number(v)}°` : Number(v).toFixed(2);
      else if (k.startsWith("Fade") || k.startsWith("Delay")) out[k] = Number(v).toFixed(2);
      else out[k] = Number(v) === 0 ? "None" : String(Number(v));
    }
    return out;
  }
}

function pick(all: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f in all) out[f] = all[f];
  return out;
}

let h: Harness;
let con: Console;
before(async () => {
  h = await startHarness(registerGroupTools);
});
after(async () => {
  await h.close();
});
beforeEach(() => {
  h.fake.reset();
  con = new Console();
  con.install(h);
});

const commands = () => h.fake.requests.filter((r) => r.op === "cmd").map((r) => String(r.args.command));
const mutations = () => h.fake.requests.filter((r) => r.op === "cmd" || r.op === "set");
const cells = (items: GridItem[]) => items.map((i) => `${i.fixture}@${i.x}/${i.y}/${i.z}`);

// ---------------------------------------------------------------------------
// Expansion, analysis, comparison
// ---------------------------------------------------------------------------

test("fixture ids and ranges expand and normalise; bad ids and ranges are refused", () => {
  assert.deepEqual(expandFixtures("f", "401 Thru 404"), ["401", "402", "403", "404"]);
  assert.deepEqual(expandFixtures("f", "501.1 thru 501.3"), ["501.1", "501.2", "501.3"]);
  assert.deepEqual(expandFixtures("f", 401), ["401"]);
  assert.deepEqual(expandFixtures("f", "0401"), ["401"]);
  for (const bad of ["404 Thru 401", "501.1 Thru 502.2", "501 Thru 501.3", "Group 3", "4a", "", 0, 1.5, "1 Thru 9999"]) {
    assert.throws(() => expandFixtures("f", bad), ValidationError, String(bad));
  }
});

test("row, rectangle and mirror helpers expand into explicit cells", () => {
  assert.deepEqual(cells(expandArrangement({ type: "row", fixtures: ["401 Thru 403"], origin: { x: 2, y: 1 }, step: 2 })), ["401@2/1/0", "402@4/1/0", "403@6/1/0"]);
  assert.deepEqual(cells(expandArrangement({ type: "row", fixtures: [401, 402], axis: "z", step: -1 })), ["401@0/0/0", "402@0/0/-1"]);
  assert.deepEqual(cells(expandArrangement({ type: "rectangle", fixtures: ["401 Thru 404", 701], columns: 2 })), ["401@0/0/0", "402@1/0/0", "403@0/1/0", "404@1/1/0", "701@0/2/0"]);
  assert.deepEqual(cells(expandArrangement({ type: "rectangle", fixtures: ["401 Thru 404"], columns: 2, serpentine: true, step_y: -1 })), ["401@0/0/0", "402@1/0/0", "403@1/-1/0", "404@0/-1/0"]);
  assert.deepEqual(cells(expandArrangement({ type: "mirror", left: [401, 402], right: [702, 701] })), ["401@0/0/0", "402@1/0/0", "702@3/0/0", "701@2/0/0"]);
  assert.deepEqual(cells(expandArrangement({ type: "mirror", left: [401], right: [701], center_gap: 2, origin: { x: -1 } })), ["401@-1/0/0", "701@2/0/0"]);
  for (const bad of [
    { type: "mirror", left: [401, 402], right: [701] },
    { type: "row", fixtures: [] },
    { type: "row", fixtures: [401], step: 0 },
    { type: "rectangle", fixtures: [401], columns: 0 },
    { type: "row", fixtures: ["401 Thru 402"], origin: { x: 9999 } },
    { type: "spiral", fixtures: [401] },
  ]) {
    assert.throws(() => expandArrangement(bad as never), ValidationError, JSON.stringify(bad));
  }
  assert.deepEqual(cells(explicitItems([{ fixture: "501.1", x: -1, y: 2, z: 1 }])), ["501.1@-1/2/1"]);
  for (const bad of [[], [{ fixture: 401, x: 0 }], [{ fixture: 401, x: 0.5, y: 0 }], [{ fixture: "x", x: 0, y: 0 }]]) assert.throws(() => explicitItems(bad), ValidationError, JSON.stringify(bad));
});

test("analysis reports duplicates, shared cells, a fixture with its cells, bounds, gaps and an offset", () => {
  const a = analyzeGrid(explicitItems([{ fixture: 401, x: 0, y: 0 }, { fixture: 402, x: 0, y: 0 }, { fixture: 401, x: 3, y: 0 }, { fixture: 501, x: 2, y: 1 }, { fixture: "501.1", x: 1, y: 1 }]));
  assert.deepEqual(a.duplicates, [{ fixture: "401", positions: [1, 3] }]);
  assert.deepEqual(a.sharedCells, [{ cell: "0/0/0", fixtures: ["401", "402"] }]);
  assert.deepEqual(a.parentAndCell, [{ parent: "501", cells: ["501.1"] }]);
  assert.deepEqual(a.bounds, { min: { x: 0, y: 0, z: 0 }, max: { x: 3, y: 1, z: 0 } });
  assert.equal(a.gaps, 8 - 4);
  assert.equal(a.offsetFromOrigin, false);
  assert.equal(analyzeGrid(explicitItems([{ fixture: 401, x: 2, y: 2 }])).offsetFromOrigin, true);
});

test("grid comparison matches by fixture, not by list position", () => {
  const want = explicitItems([{ fixture: 401, x: 0, y: 0 }, { fixture: 701, x: 1, y: 0 }]);
  const read = [{ fixture: "701", fid: 701, x: 1, y: 0, z: 0 }, { fixture: "401", fid: 401, x: 0, y: 0, z: 0 }];
  assert.deepEqual(compareGrid(want, read, true), []);
  assert.deepEqual(compareGrid(want, [{ fixture: "401", x: 0, y: 0, z: 0 }, { fixture: "702", x: 1, y: 0, z: 0 }], true), ["701 is missing", "unexpected 702 at 1/0/0"]);
  assert.deepEqual(compareGrid(want, [{ fixture: "401", x: 0, y: 0, z: 0 }, { fixture: "701", x: 2, y: 0, z: 0 }], true), ["701: expected cell 1/0/0, read 2/0/0"]);
  assert.deepEqual(compareGrid(want, [{ fixture: "401", x: 5, y: 0, z: 0 }, { fixture: "701", x: 9, y: 0, z: 0 }], false), []);
  assert.deepEqual(compareGrid(want, [{ fixture: "401", x: 0, y: 0, z: 0 }, { unreadable: true }], true), ["1 item(s) could not be read", "701 is missing"]);
  // A cell that has its own FID matches by that FID too.
  assert.deepEqual(compareGrid(explicitItems([{ fixture: 9001, x: 0, y: 0 }]), [{ fixture: "9001", fid: 9001, x: 0, y: 0, z: 0 }], true), []);
});

// ---------------------------------------------------------------------------
// gma3_store_group
// ---------------------------------------------------------------------------

test("store_group refuses duplicates, unacknowledged shared cells and a missing exclusive before sending anything", async () => {
  for (const [args, re] of [
    [{ group: 905, items: [{ fixture: 401, x: 0, y: 0 }, { fixture: 401, x: 1, y: 0 }], exclusive: true }, /duplicate fixtures: 401 \(positions 1, 2\).*silently ignores/],
    [{ group: 905, items: [{ fixture: 401, x: 0, y: 0 }, { fixture: 402, x: 0, y: 0 }], exclusive: true }, /share grid cells: 0\/0\/0 \(401, 402\)/],
    [{ group: 905, arrangement: { type: "row", fixtures: [401] } }, /exclusive must be true/],
    [{ group: 905, exclusive: true }, /exactly one of items .* or arrangement/],
    [{ group: 905, items: [{ fixture: 401, x: 0, y: 0 }], arrangement: { type: "row", fixtures: [401] }, exclusive: true }, /exactly one/],
    [{ group: 0, items: [{ fixture: 401, x: 0, y: 0 }], exclusive: true }, /group must be >= 1/],
    [{ group: 905, name: "a.b", items: [{ fixture: 401, x: 0, y: 0 }], exclusive: true }, /removes from names/],
  ] as const) {
    const { result, isError } = await h.callJson("gma3_store_group", args as unknown as Record<string, unknown>);
    assert.equal(isError, true, JSON.stringify(args));
    assert.match(result.validationErrors.join("; "), re, JSON.stringify(result.validationErrors));
  }
  assert.equal(h.fake.requests.length, 0, "nothing may reach the bridge");
});

test("store_group preview expands the plan and reads only", async () => {
  con.selection = [{ id: "702", x: 0, y: 0, z: 0 }];
  const { result, isError } = await h.callJson("gma3_store_group", { group: 905, arrangement: { type: "mirror", left: ["401 Thru 402"], right: [702, 701], center_gap: 1 }, preview: true });
  assert.equal(isError, false, JSON.stringify(result));
  assert.deepEqual(cells(result.plan.items), ["401@0/0/0", "402@1/0/0", "702@4/0/0", "701@3/0/0"]);
  assert.equal(result.plan.gaps, 1);
  assert.equal(result.selectionBefore, 1);
  assert.equal(result.preview, true);
  assert.match(result.summary, /would be created with 4 fixture\(s\); the current selection \(1 selected\) would be cleared/);
  assert.equal(mutations().length, 0);
  assert.equal(con.groups.size, 0);
});

test("store_group builds the selection cell by cell, stores, verifies the stored data and the recall, and cleans up", async () => {
  con.selection = [{ id: "403", x: 0, y: 0, z: 0 }];
  const items = [{ fixture: 402, x: 3, y: 0 }, { fixture: 401, x: 0, y: 0 }, { fixture: "501.1", x: -1, y: 2, z: 1 }, { fixture: 501, x: 5, y: 5 }];
  const { result, isError } = await h.callJson("gma3_store_group", { group: 905, name: "Front", items, exclusive: true });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
  assert.deepEqual(commands(), [
    "ClearSelection",
    "Grid 3/0/0", "Fixture 402", "Grid 0/0/0", "Fixture 401", "Grid -1/2/1", "Fixture 501.1", "Grid 5/5/0", "Fixture 501",
    "Store Group 905 /NoConfirmation",
    "ClearSelection", "Grid 0/0/0", "Group 905",
    "ClearSelection", "Grid 0/0/0",
  ]);
  // The console stores the group in patch order; the tool compares by fixture.
  const g = con.groups.get(905)!;
  assert.deepEqual(g.cells.map((c) => c.id), ["501", "501.1", "401", "402"]);
  assert.equal(g.name, "Front");
  assert.equal(g.preserve, "Yes");
  assert.equal(con.selection.length, 0, "no selection is left behind");
  assert.ok(result.warnings.some((w: string) => /501 with 501\.1/.test(w)), JSON.stringify(result.warnings));
  assert.equal(result.selectionBefore, 1);
  assert.deepEqual(result.resulting.items.map((i: { fixture: string }) => i.fixture), ["501", "501.1", "401", "402"]);
});

test("store_group keeps shared cells when allowed and preserve_grid_positions false checks fixtures only on recall", async () => {
  const shared = await h.callJson("gma3_store_group", { group: 905, items: [{ fixture: 401, x: 0, y: 0 }, { fixture: 402, x: 0, y: 0 }], allow_shared_cells: true, exclusive: true });
  assert.equal(shared.isError, false, JSON.stringify(shared.result));
  assert.ok(shared.result.warnings.some((w: string) => w.includes("shared cells kept")));
  h.fake.reset();
  con.install(h);
  const np = await h.callJson("gma3_store_group", { group: 906, items: [{ fixture: 401, x: 2, y: 2 }], preserve_grid_positions: false, exclusive: true });
  assert.equal(np.isError, false, JSON.stringify(np.result));
  assert.equal(con.groups.get(906)!.preserve, "No");
  assert.match(np.result.verification.checked, /fixtures only/);
  assert.ok(np.result.warnings.some((w: string) => /removes the gaps/.test(w)));
});

test("store_group refuses an existing group without overwrite, overwrites with /Overwrite and keeps the name, and refuses a locked group", async () => {
  con.groups.set(905, { name: "Keep", lock: "", preserve: "Yes", cells: [{ id: "701", x: 0, y: 0, z: 0 }] });
  const refused = await h.callJson("gma3_store_group", { group: 905, items: [{ fixture: 401, x: 0, y: 0 }], exclusive: true });
  assert.equal(refused.isError, true);
  assert.match(refused.result.steps[0].error, /already exists; pass overwrite: true/);
  assert.equal(mutations().length, 0);
  const over = await h.callJson("gma3_store_group", { group: 905, items: [{ fixture: 401, x: 0, y: 0 }], overwrite: true, exclusive: true });
  assert.equal(over.isError, false, JSON.stringify(over.result));
  assert.ok(commands().includes("Store Group 905 /Overwrite /NoConfirmation"));
  assert.equal(con.groups.get(905)!.name, "Keep");
  assert.deepEqual(con.groups.get(905)!.cells.map((c) => c.id), ["401"]);
  h.fake.reset();
  con.install(h);
  con.groups.get(905)!.lock = "UL";
  const locked = await h.callJson("gma3_store_group", { group: 905, items: [{ fixture: 402, x: 0, y: 0 }], overwrite: true, exclusive: true });
  assert.equal(locked.isError, true);
  assert.match(locked.result.steps[0].error, /is locked/);
  assert.equal(mutations().length, 0);
});

test("store_group refuses fixtures that are not patched, before anything is sent", async () => {
  const { result, isError } = await h.callJson("gma3_store_group", { group: 905, items: [{ fixture: 401, x: 0, y: 0 }, { fixture: 999, x: 1, y: 0 }], exclusive: true });
  assert.equal(isError, true);
  assert.equal(result.outcome, "failed");
  assert.deepEqual(result.steps.find((s: { name: string }) => s.name === "check_fixtures").detail.missing, ["999"]);
  assert.equal(mutations().length, 0);
});

test("store_group stores nothing when the built selection is not the plan, and still cleans up", async () => {
  con.ignoreSelect.add("402");
  const { result, isError } = await h.callJson("gma3_store_group", { group: 905, items: [{ fixture: 401, x: 0, y: 0 }, { fixture: 402, x: 1, y: 0 }], exclusive: true });
  assert.equal(isError, true);
  assert.equal(result.outcome, "partial");
  const check = result.steps.find((s: { name: string }) => s.name === "check_selection");
  assert.equal(check.status, "failed");
  assert.match(check.error, /402 is missing/);
  assert.equal(result.steps.find((s: { name: string }) => s.name === "store").status, "skipped");
  assert.equal(con.groups.size, 0);
  assert.ok(result.warnings.some((w: string) => /nothing was stored/.test(w)));
  assert.deepEqual(commands().slice(-2), ["ClearSelection", "Grid 0/0/0"]);
});

test("store_group reports a mismatch when the stored group differs from the plan", async () => {
  con.corruptStore = true;
  const { result, isError } = await h.callJson("gma3_store_group", { group: 905, items: [{ fixture: 401, x: 0, y: 0 }, { fixture: 402, x: 1, y: 0 }], exclusive: true });
  assert.equal(isError, true);
  assert.equal(result.verification.status, "mismatched");
  assert.match(result.verification.detail, /stored: 401: expected cell 0\/0\/0, read 1\/0\/0/);
  assert.match(result.verification.detail, /recalled: /);
});

test("store_group on an old bridge stops in the read phase with an update hint", async () => {
  con.oldBridge = true;
  const { result, isError } = await h.callJson("gma3_store_group", { group: 905, items: [{ fixture: 401, x: 0, y: 0 }], exclusive: true });
  assert.equal(isError, true);
  assert.match(result.steps.find((s: { name: string }) => s.name === "read_selection").error, /bridge 0\.21\.0/);
  assert.equal(mutations().length, 0);
});

// ---------------------------------------------------------------------------
// gma3_selection_grid
// ---------------------------------------------------------------------------

test("selection_grid reads a stored group without selecting, and the current selection", async () => {
  con.groups.set(7, { name: "Grid", lock: "UL", preserve: "No", cells: [{ id: "501.1", x: -1, y: 2, z: 1 }, { id: "401", x: 0, y: 0, z: 0 }, { id: "402", x: 0, y: 0, z: 0 }] });
  const g = await h.callJson("gma3_selection_grid", { group: 7 });
  assert.equal(g.isError, false, g.text);
  assert.equal(g.result.locked, true);
  assert.equal(g.result.preserveGridPositions, false);
  assert.deepEqual(g.result.items.map((i: { fixture: string; x: number }) => `${i.fixture}@${i.x}`), ["501.1@-1", "401@0", "402@0"]);
  assert.deepEqual(g.result.sharedCells, [{ cell: "0/0/0", fixtures: ["401", "402"] }]);
  assert.match(g.result.note, /not physical stage positions.*PreserveGridPositions is off/);
  assert.equal(mutations().length, 0);
  const missing = await h.callJson("gma3_selection_grid", { group: 8 });
  assert.equal(missing.result.exists, false);
  con.selection = [{ id: "402", x: 3, y: 0, z: 0 }];
  const s = await h.callJson("gma3_selection_grid", {});
  assert.equal(s.result.source, "selection");
  assert.equal(s.result.items[0].fixture, "402");
  con.oldBridge = true;
  const old = await h.callJson("gma3_selection_grid", {});
  assert.equal(old.isError, true);
  assert.match(old.text, /bridge 0\.21\.0/);
});

// ---------------------------------------------------------------------------
// MAtricks
// ---------------------------------------------------------------------------

test("MAtricks display values are interpreted per kind", () => {
  assert.equal(matricksValue("int", "None"), null);
  assert.equal(matricksValue("int", "2"), 2);
  assert.equal(matricksValue("int", "-1"), -1);
  assert.equal(matricksValue("int", "x"), undefined);
  assert.equal(matricksValue("fade", "2.50"), 2.5);
  assert.equal(matricksValue("phase", "360°"), 360);
  assert.equal(matricksValue("phase", "720.00"), 720);
  assert.equal(matricksValue("phase", "-90.00"), -90);
  assert.equal(matricksValue("speed", "1.000000"), 60, "edit role: Hz");
  assert.equal(matricksValue("speed", "60.00 BPM"), 60, "display role: BPM");
  assert.equal(matricksValue("speed", "2 Hz"), 120);
  assert.equal(matricksValue("fade", undefined), undefined);
});

test("MAtricks specs validate per setting", () => {
  const w = matricksWanted({ x: { wings: 2, shift: -1, delay: { from: 1, to: 0 } }, y: { blocks: 0, speed: null } });
  assert.deepEqual(w.map((x) => `${x.property}=${x.value}`), ["XWings=2", "XShift=-1", "DelayFromX=1", "DelayToX=0", "YBlock=null", "SpeedFromY=null", "SpeedToY=null"]);
  for (const bad of [{ x: { wings: -1 } }, { x: { wings: 1.5 } }, { x: { delay: { from: -1, to: 0 } } }, { x: { delay: 2 } }, { x: { speed: { from: 0, to: 60 } } }, { x: { bogus: 1 } }, { x: 5 }]) {
    assert.throws(() => matricksWanted(bad as never), ValidationError, JSON.stringify(bad));
  }
});

test("configure_matricks creates an object holding exactly the request although Store copied a dirty selection MAtricks", async () => {
  con.selMtx.XGroup = "3";
  con.selMtx.FadeToY = "2";
  con.selMtx.InvertStyle = "All";
  const { result, isError } = await h.callJson("gma3_configure_matricks", { matricks: 905, name: "Centre out", create: true, x: { wings: 2, delay: { from: 1, to: 0 }, speed: { from: 60, to: 120 } } });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
  const m = con.matricks.get(905)!;
  assert.equal(m.XWings, "2");
  assert.equal(m.DelayFromX, "1");
  assert.equal(m.DelayToX, "0");
  assert.equal(m.SpeedToX, "120");
  assert.equal(m.XGroup, "None");
  assert.equal(m.FadeToY, "None");
  assert.equal(m.InvertStyle, "Pan");
  assert.equal(m.Name, "Centre out");
  assert.deepEqual(result.intended.afterStore.resets.map((r: { property: string }) => r.property).sort(), ["FadeToY", "InvertStyle", "XGroup"]);
  assert.equal(con.selMtx.XGroup, "3", "the selection MAtricks is not changed");
  // Only what differs after Store is written.
  assert.equal(h.fake.requests.filter((r) => r.op === "set").length, 5 + 3 + 1);
  const read = await h.callJson("gma3_matricks", { matricks: 905 });
  assert.deepEqual(read.result.axes.x.delay, { from: 1, to: 0 });
  assert.deepEqual(read.result.axes.x.speed, { from: 60, to: 120 });
  assert.equal(read.result.axes.x.wings, 2);
  assert.equal(read.result.axes.y.fade, null);
});

test("configure_matricks updates only changed settings, stops at a value the console ignores, and refuses missing or locked objects", async () => {
  con.matricks.set(5, { ...freshMatricks(), XWings: "2", Name: "M5", Lock: "" });
  const noop = await h.callJson("gma3_configure_matricks", { matricks: 5, x: { wings: 2 } });
  assert.equal(noop.isError, false);
  assert.equal(noop.result.noop, true);
  assert.equal(mutations().length, 0);
  const pv = await h.callJson("gma3_configure_matricks", { matricks: 5, x: { wings: null, phase: { from: 0, to: 720 } }, preview: true });
  assert.deepEqual(pv.result.intended.changes.map((c: { property: string; to: string }) => `${c.property}=${c.to}`), ["XWings=None", "PhaseFromX=0", "PhaseToX=720"]);
  assert.equal(mutations().length, 0);
  con.refuse.add("PhaseFromX=0");
  const bad = await h.callJson("gma3_configure_matricks", { matricks: 5, x: { wings: null, phase: { from: 0, to: 720 } } });
  assert.equal(bad.isError, true);
  assert.equal(bad.result.outcome, "partial");
  assert.match(bad.result.steps.find((s: { name: string }) => s.name === "set_PhaseFromX").error, /silently keeps the previous value/);
  assert.equal(bad.result.steps.find((s: { name: string }) => s.name === "set_PhaseToX").status, "skipped");
  const missing = await h.callJson("gma3_configure_matricks", { matricks: 6, x: { wings: 2 } });
  assert.equal(missing.isError, true);
  assert.match(missing.result.steps[0].error, /does not exist; pass create: true/);
  con.matricks.get(5)!.Lock = "UL";
  const locked = await h.callJson("gma3_configure_matricks", { matricks: 5, x: { wings: 4 } });
  assert.equal(locked.isError, true);
  assert.match(locked.result.steps[0].error, /is locked/);
  const nothing = await h.callJson("gma3_configure_matricks", { matricks: 5 });
  assert.match(nothing.result.validationErrors.join(" "), /nothing to configure/);
});

test("reset_unspecified clears an existing object's other settings", async () => {
  con.matricks.set(5, { ...freshMatricks(), XWings: "2", YGroup: "4", AlignRangeX: "Yes", Name: "M5", Lock: "" });
  const { result, isError } = await h.callJson("gma3_configure_matricks", { matricks: 5, x: { wings: 2 }, reset_unspecified: true });
  assert.equal(isError, false, JSON.stringify(result));
  assert.deepEqual(result.intended.resets.map((r: { property: string }) => r.property).sort(), ["AlignRangeX", "YGroup"]);
  assert.equal(con.matricks.get(5)!.YGroup, "None");
  assert.equal(result.verification.checked, "every MAtricks property of MAtricks 5");
  void MTX_PROPS;
});
