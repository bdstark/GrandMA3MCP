import { test } from "node:test";
import assert from "node:assert/strict";
import { registerFixtureTools } from "../src/tools/fixtures.ts";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";

/**
 * SU-05: gma3_set_attributes, gma3_apply_preset, gma3_release_attributes against a stateful fake console that
 * behaves as onPC 2.5.1 did in docs/probes/su-05-programmer-macos-2.5.1.md:
 *   - `At <v>` is intensity (Dimmer) on the selection; `Attribute "X" At Absolute ...` sets X on selected fixtures
 *     that have it; every command answers OK.
 *   - `At Preset P.N` applies the preset's values to selected fixtures that have the attributes and links the
 *     channels to it (abs_preset); a missing preset or an empty selection answers OK and changes nothing.
 *   - `Off Attribute ...` removes the attributes from the SELECTED fixtures, and from EVERY fixture when nothing is
 *     selected; `Off Attribute Thru` removes every value of the selected fixtures and their cells. `Off Selection`
 *     releases a top-level fixture and deselects, but releases nothing from a compound fixture's cells.
 *   - A compound fixture (201) holds its values on its cells (FID "None"). Selecting it selects the parent; the
 *     programmer op's scope "all" does not name a cell's parent, scope "fixtures" expands to the cells with rootFid.
 */

interface Value {
  value: number;
  preset?: string;
  /** A multi-step phaser: the row has no single value, only steps. */
  steps?: number[];
  phaser?: { speed: number };
}

class Console {
  fixtures: Record<string, string[]> = {
    "101": ["Dimmer", "ColorRGB_R", "ColorRGB_G", "ColorRGB_B", "ColorRGB_W"],
    "102": ["Dimmer", "ColorRGB_R", "ColorRGB_G", "ColorRGB_B", "ColorRGB_W"],
    "301": ["Dimmer", "Pan", "Tilt"],
    "201": [],
  };
  /** Compound fixtures: the parent has no channels of its own, its cells do. */
  cells: Record<string, Record<string, string[]>> = { "201": { "201.1": ["Dimmer", "ColorRGB_R", "ColorRGB_G", "ColorRGB_B"], "201.2": ["Dimmer", "ColorRGB_R", "ColorRGB_G", "ColorRGB_B"] } };
  /** Runs after each Off command (another change landing at the same time). */
  afterOff?: () => void;
  /** The scope "fixtures" programmer scan reports incomplete coverage. */
  fixturesScanIncomplete = false;
  selected = new Set<string>();
  prog = new Map<string, Map<string, Value>>();
  presets: Record<string, { name: string; values: Record<string, number> }> = { "4.901": { name: "Red", values: { ColorRGB_R: 100, ColorRGB_G: 0, ColorRGB_B: 20 } } };
  /** Pretend Off Attribute ignores the selection (a console that released everyone's values). */
  offHitsEveryone = false;
  /** A command the console rejects. */
  reject?: RegExp;
  commands: string[] = [];

  /** The fixture itself, or its cells: where its programmer values live. */
  units(fid: string): string[] {
    return this.cells[fid] ? Object.keys(this.cells[fid]) : [fid];
  }
  attrsOf(unit: string): string[] {
    for (const c of Object.values(this.cells)) if (c[unit]) return c[unit];
    return this.fixtures[unit] ?? [];
  }
  index(unit: string): number {
    return Number(unit.replace(".", ""));
  }

  set(fid: string, attr: string, v: Value) {
    if (!this.prog.has(fid)) this.prog.set(fid, new Map());
    this.prog.get(fid)!.set(attr, v);
  }

  apply(cmd: string): string {
    this.commands.push(cmd);
    if (this.reject?.test(cmd)) return "Illegal Command";
    let m: RegExpMatchArray | null;
    if (cmd === "ClearSelection") this.selected.clear();
    else if (cmd === "ClearAll") {
      this.selected.clear();
      this.prog.clear();
    } else if ((m = cmd.match(/^Fixture (.+)$/))) {
      for (const part of m[1].split("+").map((s) => s.trim())) {
        const r = part.match(/^(\d+) Thru (\d+)$/);
        const ids = r ? Object.keys(this.fixtures).filter((f) => +f >= +r[1] && +f <= +r[2]) : [part];
        for (const id of ids) if (this.fixtures[id]) this.selected.add(id);
      }
    } else if ((m = cmd.match(/^At ([\d.]+)$/))) {
      for (const f of this.selected) for (const u of this.units(f)) if (this.attrsOf(u).includes("Dimmer")) this.set(u, "Dimmer", { value: +m[1] });
    } else if ((m = cmd.match(/^Attribute "(.+)" At Absolute(?: Percent| Physical)? (-?[\d.]+)$/))) {
      for (const f of this.selected) for (const u of this.units(f)) if (this.attrsOf(u).includes(m[1])) this.set(u, m[1], { value: +m[2] });
    } else if ((m = cmd.match(/^At Preset (\d+)\.(?:(\d+)|"(.+)")$/))) {
      const key = m[2] ? `${m[1]}.${m[2]}` : Object.keys(this.presets).find((k) => k.startsWith(`${m![1]}.`) && this.presets[k].name === m![3]);
      const p = key ? this.presets[key] : undefined;
      if (p) for (const f of this.selected) for (const u of this.units(f)) for (const [a, v] of Object.entries(p.values)) if (this.attrsOf(u).includes(a)) this.set(u, a, { value: v, preset: key });
    } else if ((m = cmd.match(/^Off Attribute (.+)$/))) {
      const attrs = m[1] === "Thru" ? null : [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
      const targets = this.selected.size && !this.offHitsEveryone ? [...this.selected] : Object.keys(this.fixtures);
      for (const f of targets)
        for (const u of this.units(f)) {
          if (attrs) for (const a of attrs) this.prog.get(u)?.delete(a);
          else this.prog.delete(u);
        }
      this.afterOff?.();
    } else if (cmd === "Off Selection") {
      for (const f of this.selected) this.prog.delete(f);
      this.selected.clear();
      this.afterOff?.();
    }
    return "OK";
  }

  presetRef(ref: string) {
    const m = ref.match(/^Preset (\d+)\.(?:(\d+)|"(.+)")$/);
    if (!m) return undefined;
    const key = m[2] ? `${m[1]}.${m[2]}` : Object.keys(this.presets).find((k) => k.startsWith(`${m[1]}.`) && this.presets[k].name === m[3]);
    return key && this.presets[key] ? { key, ...this.presets[key] } : undefined;
  }

  install(h: Harness) {
    const f = h.fake;
    f.reset();
    f.onCommand((cmd) => this.apply(cmd));
    f.on("objects", (args) => {
      const ref = String(args.ref);
      if (ref === "Selection") return { total: 1, items: [{ name: "Selection", class: "Selection", fields: { CountTotalSelected: String(this.selected.size), CountFullySelected: String(this.selected.size) } }] };
      const attr = ref.match(/^Attribute "(.+)"$/);
      if (attr) {
        if (!Object.values(this.fixtures).some((a) => a.includes(attr[1]))) throw new Error(`no object found for '${ref}'`);
        return { total: 1, items: [{ name: attr[1], class: "Attribute" }] };
      }
      if (ref.startsWith("Preset ")) {
        const p = this.presetRef(ref);
        if (!p) return { total: 0, items: [] };
        return { total: 1, items: [{ name: p.name, class: "Preset", addrNative: `ShowData.DataPools.Default.PresetPools.Color.${p.name}`, fields: { Name: p.name } }] };
      }
      const ids = ref.replace(/^Fixture /, "");
      const r = ids.match(/^(\d+) Thru (\d+)$/);
      const fids = r ? Object.keys(this.fixtures).filter((x) => +x >= +r[1] && +x <= +r[2]) : ids.split("+").map((s) => s.trim()).filter((x) => this.fixtures[x]);
      if (!fids.length) throw new Error(`no objects found for '${ref}'`);
      return { total: fids.length, items: fids.map((fid) => ({ name: `Fx ${fid}`, class: "Fixture", fields: { FID: fid, Name: `Fx ${fid}`, FixtureType: `Type ${fid}` } })) };
    });
    f.on("fixtureAttributes", (args) => {
      const fid = String(args.ref).replace(/^Fixture /, "");
      const names = this.fixtures[fid];
      if (!names) throw new Error(`no object found for '${args.ref}'`);
      return { name: `Fx ${fid}`, fid, fixtureType: `Type ${fid}`, total: names.length, count: names.length, offset: 0, subfixtureCount: 0, attributes: names.map((a) => ({ attribute: a })), limitations: [] };
    });
    f.on("programmer", (args) => {
      const scope = String(args.scope);
      // Scanned entries: [unit id, its fid as reported, its rootFid as reported].
      type Entry = [string, string, string];
      const top = (fid: string): Entry[] => [[fid, fid, fid]];
      const expanded = (fid: string, withRoot: boolean): Entry[] => [...top(fid), ...(this.cells[fid] ? Object.keys(this.cells[fid]).map((u): Entry => [u, "None", withRoot ? fid : "None"]) : [])];
      const entries: Entry[] =
        scope === "selection"
          ? [...this.selected].flatMap(top)
          : scope === "fixtures"
            ? String(args.fixtures).replace(/^Fixture /, "").split("+").map((x) => x.trim()).flatMap((fid) => expanded(fid, true))
            : Object.keys(this.fixtures).flatMap((fid) => expanded(fid, false));
      const rows = entries.flatMap(([unit, fid]) =>
        [...(this.prog.get(unit) ?? new Map<string, Value>()).entries()].map(([attribute, v]) => ({
          fixture: `Fx ${unit}`,
          fid,
          subfixtureIndex: this.index(unit),
          attribute,
          ...(v.steps ? { stepCount: v.steps.length, steps: v.steps.map((value, i) => ({ step: i + 1, value })), phaser: v.phaser ?? null } : { value: v.value, stepCount: 1 }),
          physicalFrom: 0,
          physicalTo: 1,
          readout: "Percent",
          absPreset: v.preset ? { name: this.presets[v.preset].name, addrNative: `ShowData.DataPools.Default.PresetPools.Color.${this.presets[v.preset].name}` } : null,
        })),
      );
      return {
        scope,
        coverage: { complete: !(scope === "fixtures" && this.fixturesScanIncomplete), scannedFixtures: entries.length, totalFixtures: entries.length, scannedChannels: rows.length },
        scannedFixtures: entries.map(([unit, fid, rootFid]) => ({ subfixtureIndex: this.index(unit), fid, name: `Fx ${unit}`, rootFid, attributes: this.attrsOf(unit) })),
        fixturesTruncated: false,
        total: rows.length,
        count: rows.length,
        offset: 0,
        rows,
        limitations: [],
      };
    });
  }
}

async function setup() {
  const h = await startHarness(registerFixtureTools);
  const c = new Console();
  c.install(h);
  return { h, c, cmds: () => c.commands };
}

// ---------------------------------------------------------------------------
// gma3_set_attributes
// ---------------------------------------------------------------------------

test("set_attributes: intensity and several attributes in one call, in order, verified per fixture", async () => {
  const { h, c, cmds } = await setup();
  try {
    const { result, isError } = await h.callJson("gma3_set_attributes", { fixtures: "101 Thru 102", intensity: 80, values: [{ attribute: "ColorRGB_R", value: 100, unit: "percent" }, { attribute: "ColorRGB_W", value: 0, unit: "percent" }] });
    assert.equal(isError, false, JSON.stringify(result, null, 2));
    assert.equal(result.verification.status, "matched");
    assert.deepEqual(cmds(), ["ClearSelection", "Fixture 101 Thru 102", "At 80", 'Attribute "ColorRGB_R" At Absolute Percent 100', 'Attribute "ColorRGB_W" At Absolute Percent 0']);
    assert.equal(c.prog.get("102")?.get("Dimmer")?.value, 80);
  } finally {
    await h.close();
  }
});

test("set_attributes: a rejected command stops the rest (partial); Dimmer with intensity, duplicates and an empty call are refused", async () => {
  const { h, c, cmds } = await setup();
  try {
    c.reject = /ColorRGB_W/;
    const { result } = await h.callJson("gma3_set_attributes", { fixtures: "101", values: [{ attribute: "ColorRGB_R", value: 50, unit: "percent" }, { attribute: "ColorRGB_W", value: 10, unit: "percent" }, { attribute: "ColorRGB_B", value: 10, unit: "percent" }] });
    assert.equal(result.outcome, "partial");
    assert.ok(!cmds().some((x) => x.includes("ColorRGB_B")), "nothing after the rejected command");
    let r = await h.callJson("gma3_set_attributes", { fixtures: "101", intensity: 50, values: [{ attribute: "Dimmer", value: 50 }] });
    assert.match(r.result.validationErrors.join(" "), /Dimmer and intensity are the same attribute/);
    r = await h.callJson("gma3_set_attributes", { fixtures: "101", values: [{ attribute: "Pan", value: 1 }, { attribute: "pan", value: 2 }] });
    assert.match(r.result.validationErrors.join(" "), /appears twice/);
    r = await h.callJson("gma3_set_attributes", { fixtures: "101" });
    assert.match(r.result.validationErrors.join(" "), /give intensity and\/or values/);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// gma3_apply_preset
// ---------------------------------------------------------------------------

test("apply_preset: At Preset on the target, verified by the programmer's preset link", async () => {
  const { h, c, cmds } = await setup();
  try {
    const { result, isError } = await h.callJson("gma3_apply_preset", { fixtures: "101 + 102", pool: 4, preset: 901 });
    assert.equal(isError, false, JSON.stringify(result, null, 2));
    assert.equal(result.verification.status, "matched");
    assert.equal(cmds().at(-1), "At Preset 4.901");
    assert.deepEqual(result.presetLink.fixtures.map((x: any) => x.linkedValues), [3, 3]);
    assert.equal(c.prog.get("101")?.get("ColorRGB_B")?.value, 20);
    const byName = await h.callJson("gma3_apply_preset", { fixtures: "101", pool: 4, preset: "Red" });
    assert.equal(byName.result.verification.status, "matched");
    assert.equal(cmds().at(-1), 'At Preset 4."Red"');
  } finally {
    await h.close();
  }
});

test("apply_preset: a missing preset and an empty selection are refused before sending (the console would answer OK and do nothing)", async () => {
  const { h, cmds } = await setup();
  try {
    let r = await h.callJson("gma3_apply_preset", { fixtures: "101", pool: 4, preset: 999 });
    assert.equal(r.result.outcome, "failed");
    assert.match(r.result.summary, /Preset 4\.999 does not exist/);
    r = await h.callJson("gma3_apply_preset", { use_selection: true, pool: 4, preset: 901 });
    assert.equal(r.result.outcome, "failed");
    assert.match(r.result.summary, /nothing is selected/);
    assert.ok(!cmds().some((x) => x.startsWith("At Preset")));
  } finally {
    await h.close();
  }
});

test("apply_preset: a fixture the preset holds nothing for is a mismatch", async () => {
  const { h } = await setup();
  try {
    const { result, isError } = await h.callJson("gma3_apply_preset", { fixtures: "101 + 301", pool: 4, preset: 901 });
    assert.equal(isError, true);
    assert.equal(result.verification.status, "mismatched");
    assert.match(result.verification.detail, /Fixture 301\): no programmer value is linked to Preset 4\.901/);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// gma3_release_attributes
// ---------------------------------------------------------------------------

test("release_attributes: Off Attribute on the target only; the other fixture's values stay", async () => {
  const { h, c, cmds } = await setup();
  try {
    for (const f of ["101", "102"]) for (const a of ["ColorRGB_R", "ColorRGB_G", "Dimmer"]) c.set(f, a, { value: 50 });
    const { result, isError } = await h.callJson("gma3_release_attributes", { fixtures: "101", attributes: ["ColorRGB_R", "ColorRGB_G"] });
    assert.equal(isError, false, JSON.stringify(result, null, 2));
    assert.equal(result.verification.status, "matched");
    assert.equal(cmds().at(-1), 'Off Attribute "ColorRGB_R" + "ColorRGB_G"');
    assert.equal(result.release.valuesReleased, 2);
    assert.deepEqual([...c.prog.get("101")!.keys()], ["Dimmer"]);
    assert.equal(c.prog.get("102")!.size, 3);
  } finally {
    await h.close();
  }
});

test("release_attributes: all releases every value of the target with Off Attribute Thru", async () => {
  const { h, c, cmds } = await setup();
  try {
    for (const f of ["101", "102"]) c.set(f, "Dimmer", { value: 40 });
    const { result } = await h.callJson("gma3_release_attributes", { fixtures: "102", all: true });
    assert.equal(result.verification.status, "matched");
    assert.equal(cmds().at(-1), "Off Attribute Thru");
    assert.equal(c.prog.has("102"), false);
    assert.equal(c.prog.get("101")?.get("Dimmer")?.value, 40);
  } finally {
    await h.close();
  }
});

test("release_attributes: values released from other fixtures are a mismatch (collateral is checked, not assumed)", async () => {
  const { h, c } = await setup();
  try {
    for (const f of ["101", "102"]) c.set(f, "ColorRGB_R", { value: 70 });
    c.offHitsEveryone = true;
    const { result, isError } = await h.callJson("gma3_release_attributes", { fixtures: "101", attributes: ["ColorRGB_R"] });
    assert.equal(isError, true);
    assert.equal(result.verification.status, "mismatched");
    assert.match(result.verification.detail, /Fixture 102\) ColorRGB_R was removed/);
  } finally {
    await h.close();
  }
});

test("release_attributes: with nothing selected it is refused (the console would release from every fixture)", async () => {
  const { h, cmds } = await setup();
  try {
    const { result } = await h.callJson("gma3_release_attributes", { use_selection: true, attributes: ["ColorRGB_R"] });
    assert.equal(result.outcome, "failed");
    assert.match(result.summary, /nothing is selected/);
    assert.ok(!cmds().some((x) => x.startsWith("Off")));
    const r = await h.callJson("gma3_release_attributes", { fixtures: "101", attributes: ["ColorRGB_R"], all: true });
    assert.match(r.result.validationErrors.join(" "), /attributes or all, not both/);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Review round 1 (PR #50 at 823f453)
// ---------------------------------------------------------------------------

test("release_attributes: a compound fixture's cells are part of the target (their own FID is None)", async () => {
  const { h, c } = await setup();
  try {
    for (const u of ["201.1", "201.2"]) for (const a of ["Dimmer", "ColorRGB_R"]) c.set(u, a, { value: 60 });
    c.set("101", "Dimmer", { value: 30 });
    let r = await h.callJson("gma3_release_attributes", { fixtures: "201", attributes: ["ColorRGB_R"] });
    assert.equal(r.result.verification.status, "matched", JSON.stringify(r.result, null, 2));
    assert.equal(r.result.release.valuesReleased, 2);
    r = await h.callJson("gma3_release_attributes", { fixtures: "201", all: true });
    assert.equal(r.result.verification.status, "matched", JSON.stringify(r.result, null, 2));
    assert.equal(c.prog.get("101")?.get("Dimmer")?.value, 30);
  } finally {
    await h.close();
  }
});

test("release_attributes: a changed or added phaser on another fixture is a mismatch (rows without a single value)", async () => {
  const { h, c } = await setup();
  try {
    c.set("101", "ColorRGB_R", { value: 50 });
    c.set("102", "ColorRGB_G", { value: 0, steps: [0, 100], phaser: { speed: 1 } });
    c.afterOff = () => c.set("102", "ColorRGB_G", { value: 0, steps: [0, 50], phaser: { speed: 1 } });
    let r = await h.callJson("gma3_release_attributes", { fixtures: "101", attributes: ["ColorRGB_R"] });
    assert.equal(r.result.verification.status, "mismatched");
    assert.match(r.result.verification.detail, /Fixture 102\) ColorRGB_G changed/);

    c.set("101", "ColorRGB_R", { value: 50 });
    c.afterOff = () => c.set("102", "Dimmer", { value: 0, steps: [0, 100] });
    r = await h.callJson("gma3_release_attributes", { fixtures: "101", attributes: ["ColorRGB_R"] });
    assert.equal(r.result.verification.status, "mismatched");
    assert.match(r.result.verification.detail, /Fixture 102\) Dimmer was added/);
  } finally {
    await h.close();
  }
});

test("apply_preset: an incomplete follow-up scan of a compound fixture is unavailable, not matched", async () => {
  const { h, c } = await setup();
  try {
    let r = await h.callJson("gma3_apply_preset", { fixtures: "201", pool: 4, preset: 901 });
    assert.equal(r.result.verification.status, "matched", JSON.stringify(r.result, null, 2));
    c.fixturesScanIncomplete = true;
    r = await h.callJson("gma3_apply_preset", { fixtures: "201", pool: 4, preset: 901 });
    assert.equal(r.result.verification.status, "unavailable");
    assert.match(r.result.verification.detail, /incomplete/);
  } finally {
    await h.close();
  }
});
