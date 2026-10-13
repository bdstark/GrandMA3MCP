/**
 * Live console test for SB-02 (gma3_store_group, gma3_selection_grid, gma3_configure_matricks, gma3_matricks).
 *
 * NOT run by `npm test`. Run on purpose against a disposable show with an EMPTY programmer and bridge 0.21.0:
 *   GMA3_LIVE=1 node --import tsx --test test/live/groups.live.ts
 *
 * Fixtures: eight fixtures with a Dimmer for the row (GMA3_LIVE_GRID_ROW, default "401,402,403,404,701,702,703,704")
 * and a multi-instance fixture with two cells (GMA3_LIVE_GRID_CELLS, default "501,501.1,501.2": parent, cell, cell).
 *
 * Show objects this file creates, changes and deletes (reserved ranges, see README.md):
 *   - Group 905, 906     created and overwritten by the tools; deleted at the end.
 *   - MAtricks 905, 906  created by the tools; deleted at the end.
 *   - the programmer     the tools clear and rebuild the selection; the distribution checks recall the groups and
 *                        MAtricks and set Dimmer values with Attribute "Dimmer" At a Thru b; ClearAll, Reset Selection
 *                        MAtricks and Grid 0/0/0 at the end.
 *   The test refuses to run when any of those objects exists and skips unless a complete programmer scan finds no
 *   values, so it never deletes anything it did not create. Nothing calls SaveShow.
 *
 * What it demonstrates (SB-02 acceptance criteria):
 *   1. Helpers expand into a reviewable coordinate list (preview sends nothing); duplicates, shared cells and a missing
 *      exclusive acknowledgement are refused before anything is sent.
 *   2. A mirrored row and an explicit grid with gaps, a negative cell, a Z layer and a fixture with its own cells are
 *      stored, read back from the group and recalled at Grid 0/0/0 with the same fixtures on the same cells.
 *   3. An existing group needs overwrite: true and keeps its name when overwritten.
 *   4. MAtricks objects are created with exactly the requested settings, also when the selection MAtricks is dirty.
 *   5. Left-to-right: the row recalled without wings ramps 0 -> 100 along grid X.
 *   6. Centre-out: with wings 2 the transformed positions mirror around the centre (0 1 2 3 3 2 1 0), so a delay
 *      {from: 1, to: 0} reaches the centre first; the same mapping spreads At 100 Thru 0 symmetrically with the
 *      centre lowest.
 */
import assert from "node:assert/strict";
import { liveTest, cmd } from "./live.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { MutationLock } from "../../src/mutations.ts";
import type { ToolContext } from "../../src/tools/context.ts";
import { registerGroupTools } from "../../src/tools/groups.ts";
import { exists } from "../../src/tools/common.ts";

const env = process.env;
const ROW = (env.GMA3_LIVE_GRID_ROW ?? "401,402,403,404,701,702,703,704").split(",").map((s) => s.trim());
const [PARENT, CELL1, CELL2] = (env.GMA3_LIVE_GRID_CELLS ?? "501,501.1,501.2").split(",").map((s) => s.trim());
const G_MIRROR = 905;
const G_GRID = 906;
const M_CENTRE = 905;
const M_LTR = 906;

interface ProgRow {
  fid?: string;
  attribute?: string;
  value?: number | null;
}

liveTest("SB-02: groups with selection grids, MAtricks and two distributions (Group/MAtricks 905-906)", async (t, bridge) => {
  const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 15000, luaToolAllowed: false };
  const tools = captureTools(registerGroupTools, ctx);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await tools.get(name)!.call(args);
    const text = res.content.map((c) => c.text).join("\n");
    let result: any;
    try {
      result = JSON.parse(text);
    } catch {
      result = text;
    }
    return { result, isError: Boolean(res.isError) };
  };
  assert.equal(ROW.length, 8, "GMA3_LIVE_GRID_ROW needs eight fixtures");

  // Preconditions: never touch anything this test did not create.
  for (const ref of [`Group ${G_MIRROR}`, `Group ${G_GRID}`, `MAtricks ${M_CENTRE}`, `MAtricks ${M_LTR}`]) {
    const e = await exists(bridge, ref);
    assert.notEqual(e.exists, "unknown", `could not check ${ref}`);
    assert.equal(e.exists, false, `${ref} already exists; remove it or pick another show`);
  }
  const ping = (await bridge.request("ping", {})) as { bridgeVersion?: string };
  assert.ok(ping.bridgeVersion && ping.bridgeVersion >= "0.21.0", `bridge ${ping.bridgeVersion} has no selection-grid reads; install 0.21.0`);
  const prog = (await bridge.request("programmer", {})) as { rows?: unknown[]; coverage?: { complete?: boolean }; stats?: { channelErrors?: number; channelsWithData?: number }; limitations?: unknown[] };
  const progEmpty = prog.coverage?.complete === true && Array.isArray(prog.rows) && prog.rows.length === 0 && prog.stats?.channelErrors === 0 && prog.stats?.channelsWithData === 0 && (prog.limitations ?? []).length === 0;
  if (!progEmpty) {
    t.skip(`the programmer is not confirmed empty (complete: ${prog.coverage?.complete}, rows: ${prog.rows?.length}); clear it first`);
    return;
  }

  t.after(async () => {
    for (const c of ["ClearAll", "Reset Selection MAtricks", "Grid 0/0/0", `Delete Group ${G_MIRROR} /NoConfirmation`, `Delete Group ${G_GRID} /NoConfirmation`, `Delete MAtricks ${M_CENTRE} /NoConfirmation`, `Delete MAtricks ${M_LTR} /NoConfirmation`]) {
      await cmd(c).catch(() => {});
    }
  });

  // 1. Helpers, preview and refusals.
  const mirror = { type: "mirror", left: ROW.slice(0, 4), right: ROW.slice(4).reverse() };
  const pv = await call("gma3_store_group", { group: G_MIRROR, arrangement: mirror, preview: true });
  assert.equal(pv.isError, false, JSON.stringify(pv.result));
  assert.deepEqual(pv.result.plan.items.map((i: { fixture: string; x: number }) => `${i.fixture}@${i.x}`), [...ROW.slice(0, 4).map((f, i) => `${f}@${i}`), ...ROW.slice(4).reverse().map((f, i) => `${f}@${7 - i}`)]);
  assert.equal((await exists(bridge, `Group ${G_MIRROR}`)).exists, false, "preview must not store");
  const dup = await call("gma3_store_group", { group: G_MIRROR, items: [{ fixture: ROW[0], x: 0, y: 0 }, { fixture: ROW[0], x: 1, y: 0 }], exclusive: true });
  assert.equal(dup.isError, true);
  assert.match(dup.result.validationErrors.join(" "), /duplicate fixtures/);
  const shared = await call("gma3_store_group", { group: G_MIRROR, items: [{ fixture: ROW[0], x: 0, y: 0 }, { fixture: ROW[1], x: 0, y: 0 }], exclusive: true });
  assert.match(shared.result.validationErrors.join(" "), /share grid cells/);
  const noExcl = await call("gma3_store_group", { group: G_MIRROR, arrangement: mirror });
  assert.match(noExcl.result.validationErrors.join(" "), /exclusive must be true/);
  assert.equal((await exists(bridge, `Group ${G_MIRROR}`)).exists, false, "refusals must not store");

  // 2. Store and verify: a mirrored row and an explicit grid.
  const sm = await call("gma3_store_group", { group: G_MIRROR, name: "SB02 mirror", arrangement: mirror, exclusive: true });
  assert.equal(sm.isError, false, JSON.stringify(sm.result));
  assert.equal(sm.result.verification.status, "matched", JSON.stringify(sm.result.verification));
  const grid = [
    { fixture: ROW[1], x: 3, y: 0 },
    { fixture: ROW[0], x: 0, y: 0 },
    { fixture: CELL1, x: -1, y: 2, z: 1 },
    { fixture: CELL2, x: 0, y: 2 },
    { fixture: PARENT, x: 5, y: 5 },
  ];
  const sg = await call("gma3_store_group", { group: G_GRID, name: "SB02 grid", items: grid, exclusive: true });
  assert.equal(sg.isError, false, JSON.stringify(sg.result));
  assert.equal(sg.result.verification.status, "matched", JSON.stringify(sg.result.verification));
  assert.ok(sg.result.warnings?.some((w: string) => w.includes(`${PARENT} with ${CELL1}`)), JSON.stringify(sg.result.warnings));
  const rg = await call("gma3_selection_grid", { group: G_GRID });
  assert.equal(rg.isError, false, JSON.stringify(rg.result));
  t.diagnostic(`Group ${G_GRID}: ${rg.result.items.map((i: any) => `${i.fixture}@${i.x}/${i.y}/${i.z}`).join(" ")} (gaps ${rg.result.gaps})`);
  const cellOf = (f: string) => rg.result.items.find((i: any) => i.fixture === f);
  for (const g of grid) assert.deepEqual([cellOf(g.fixture)?.x, cellOf(g.fixture)?.y, cellOf(g.fixture)?.z], [g.x, g.y, g.z ?? 0], g.fixture);
  assert.equal(rg.result.preserveGridPositions, true);
  assert.ok(rg.result.gaps > 0);
  const sel = await call("gma3_selection_grid", {});
  assert.equal(sel.result.count, 0, "the tool leaves no selection behind");

  // 3. Overwrite rules.
  const again = await call("gma3_store_group", { group: G_GRID, arrangement: { type: "row", fixtures: ROW.slice(0, 4) }, exclusive: true });
  assert.equal(again.isError, true);
  assert.match(again.result.steps.find((s: any) => s.name === "check_group").error, /already exists/);
  const over = await call("gma3_store_group", { group: G_GRID, arrangement: { type: "row", fixtures: ROW.slice(0, 4) }, overwrite: true, exclusive: true });
  assert.equal(over.isError, false, JSON.stringify(over.result));
  assert.equal(over.result.verification.status, "matched");
  const rg2 = await call("gma3_selection_grid", { group: G_GRID });
  assert.equal(rg2.result.name, "SB02 grid", "overwrite keeps the name");
  assert.deepEqual(rg2.result.items.map((i: any) => i.fixture).sort(), ROW.slice(0, 4).sort());

  // 4. MAtricks objects: exactly the requested settings, even with a dirty selection MAtricks.
  assert.equal(await cmd('Set Selection MAtricks "XGroup" 3'), "OK");
  const mc = await call("gma3_configure_matricks", { matricks: M_CENTRE, name: "SB02 centre out", create: true, x: { wings: 2, delay: { from: 1, to: 0 } } });
  assert.equal(mc.isError, false, JSON.stringify(mc.result));
  assert.equal(mc.result.verification.status, "matched", JSON.stringify(mc.result.verification));
  assert.ok(mc.result.intended.afterStore.resets.some((r: any) => r.property === "XGroup"), "the copied XGroup is reset");
  assert.equal(await cmd("Reset Selection MAtricks"), "OK");
  const ml = await call("gma3_configure_matricks", { matricks: M_LTR, name: "SB02 left to right", create: true, x: { fade: { from: 0, to: 2 } } });
  assert.equal(ml.isError, false, JSON.stringify(ml.result));
  const rm = await call("gma3_matricks", { matricks: M_CENTRE });
  assert.deepEqual(rm.result.axes.x.delay, { from: 1, to: 0 });
  assert.equal(rm.result.axes.x.wings, 2);
  assert.equal(rm.result.axes.x.groups, null);

  // Distributions: recall a group at the origin and a MAtricks, spread Dimmer, read the selection and the programmer.
  const spread = async (group: number, matricks: number, at: string) => {
    for (const c of ["ClearAll", "Reset Selection MAtricks", "Grid 0/0/0", `Group ${group}`, `Recall MAtricks ${matricks}`, `Attribute "Dimmer" At ${at}`]) assert.equal(await cmd(c), "OK", c);
    const s = (await call("gma3_selection_grid", {})).result;
    const p = (await bridge.request("programmer", { scope: "selection" })) as { rows: ProgRow[] };
    const value = new Map(p.rows.filter((r) => r.attribute === "Dimmer").map((r) => [String(r.fid), r.value ?? null]));
    return { transformed: new Map<string, number>(s.items.map((i: any) => [i.fixture, i.x])), value };
  };
  const cellX = new Map<string, number>(pv.result.plan.items.map((i: { fixture: string; x: number }) => [i.fixture, i.x]));
  const byX = (m: Map<string, number | null>) => [...cellX].sort((a, b) => a[1] - b[1]).map(([f]) => m.get(f) ?? null);

  // 5. Left to right: no wings, the ramp follows grid X.
  const ltr = await spread(G_MIRROR, M_LTR, "0 Thru 100");
  const ltrValues = byX(ltr.value);
  t.diagnostic(`left to right (by grid X): ${ltrValues.map((v) => v?.toFixed(1)).join(" ")}`);
  assert.equal(ltrValues[0], 0);
  assert.equal(ltrValues[7], 100);
  for (let i = 1; i < 8; i++) assert.ok((ltrValues[i] ?? -1) > (ltrValues[i - 1] ?? 0), `ramp must rise along X: ${ltrValues.join(", ")}`);

  // 6. Centre out: wings 2 mirrors the positions; the centre takes the `to` end of a distribution.
  const co = await spread(G_MIRROR, M_CENTRE, "100 Thru 0");
  const pos = [...cellX].sort((a, b) => a[1] - b[1]).map(([f]) => co.transformed.get(f));
  const coValues = byX(co.value);
  t.diagnostic(`centre out: transformed X ${pos.join(" ")}; At 100 Thru 0 by grid X: ${coValues.map((v) => v?.toFixed(1)).join(" ")}`);
  assert.deepEqual(pos, [0, 1, 2, 3, 3, 2, 1, 0]);
  for (let i = 0; i < 4; i++) assert.ok(Math.abs((coValues[i] ?? -1) - (coValues[7 - i] ?? -2)) < 0.01, `symmetric: ${coValues.join(", ")}`);
  assert.equal(coValues[0], 100);
  assert.equal(coValues[3], 0);
  for (let i = 1; i < 4; i++) assert.ok((coValues[i] ?? 101) < (coValues[i - 1] ?? 0), `edges to centre must fall: ${coValues.join(", ")}`);
});
