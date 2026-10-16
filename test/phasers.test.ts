import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { registerPhaserTools, parseStep, parsePhaser, expandTemplate, effectCommands, expectedPhase, verifyBuild, fingerprint, planEffect, invertValue, summarizePhases, variantOf, sameAngle, type Effect } from "../src/tools/phasers.ts";
import type { ProgrammerRow } from "../src/tools/presets.ts";
import { ValidationError } from "../src/validate.ts";
import { SILENT } from "./helpers/fake-bridge.ts";

// ---------------------------------------------------------------------------
// Request parsing, templates, commands
// ---------------------------------------------------------------------------

test("steps and phaser layers are validated", () => {
  assert.deepEqual(parseStep("s", { values: { Dimmer: 100, Pan: { relative: -5 } }, transition: 0, accel: -100 }, "percent"), { values: { Dimmer: { absolute: 100 }, Pan: { relative: -5, absolute: undefined } }, preset: undefined, width: undefined, transition: 0, accel: -100, decel: undefined });
  assert.deepEqual(parseStep("s", { preset: "4.4" }, "percent").preset, { pool: 4, number: 4 });
  assert.equal(parseStep("s", { values: { Pan: -45 } }, "physical").values.Pan.absolute, -45);
  for (const [bad, unit] of [
    [{}, "percent"], [{ values: { Dimmer: 150 } }, "percent"], [{ values: { Dimmer: -1 } }, "percent"], [{ values: { "Dim mer": 1 } }, "percent"],
    [{ values: { Dimmer: { fade: 2 } } }, "percent"], [{ values: { Dimmer: {} } }, "percent"], [{ values: { Dimmer: 1 }, transition: 101 }, "percent"], [{ values: { Dimmer: 1 }, speed: 2 }, "percent"], [{ preset: "4" }, "percent"],
  ] as const) assert.throws(() => parseStep("s", bad, unit), ValidationError, JSON.stringify(bad));
  assert.deepEqual(parsePhaser({ speed_bpm: 90, phase: { from: 360, to: 0 }, measure: 2, speed_master: 3, repeat: { wings: 2 } }), { speedBpm: 90, phase: { from: 360, to: 0 }, measure: 2, speedMaster: 3, repeat: { kind: "wings", count: 2 } });
  for (const bad of [{ speed: 1 }, { speed_bpm: 0 }, { speed_master: 17 }, { phase: { from: 0 } }, { repeat: { groups: 2 } }, { phase: { from: 0, to: 90 }, repeat: { groups: 2, wings: 2 } }, { phase: { from: 0, to: 90 }, repeat: { groups: 1 } }]) {
    assert.throws(() => parsePhaser(bad), ValidationError, JSON.stringify(bad));
  }
});

test("templates expand into reviewable steps, distribution and speed", () => {
  const chase = expandTemplate({ type: "dimmer_chase" }, 4);
  assert.deepEqual(chase.steps.map((s) => [s.values.Dimmer.absolute, s.transition]), [[100, 0], [0, 0]]);
  assert.deepEqual(chase.phaser, { speedBpm: 120, phase: { from: 0, to: 270 } });
  assert.equal(expandTemplate({ type: "dimmer_chase", spread: false }, 4).phaser.phase, undefined);
  const alt = expandTemplate({ type: "alternating_colors", colors: [{ red: 100 }, { preset: "4.6" }], snap: true }, 4);
  assert.deepEqual(alt.steps[0].values, { ColorRGB_R: { absolute: 100 }, ColorRGB_G: { absolute: 0 }, ColorRGB_B: { absolute: 0 } });
  assert.deepEqual(alt.steps[1].preset, { pool: 4, number: 6 });
  assert.deepEqual(alt.phaser.repeat, { kind: "groups", count: 2 });
  assert.equal(alt.steps[0].transition, 0);
  assert.throws(() => expandTemplate({ type: "alternating_colors", colors: [{ red: 100 }] }, 4), ValidationError);
  assert.throws(() => expandTemplate({ type: "alternating_colors", colors: [{ red: 1 }, { blue: 1 }] }, 1), ValidationError);
  const pt = expandTemplate({ type: "pan_tilt", pan: 30, tilt: 10, spread: true }, 6);
  assert.equal(pt.unit, "physical");
  assert.deepEqual(pt.steps.map((s) => [s.values.Pan.relative, s.values.Tilt.relative, s.accel]), [[30, 0, -100], [0, 10, -100], [-30, 0, -100], [0, -10, -100]]);
  assert.deepEqual(pt.phaser, { speedBpm: 20, phase: { from: 0, to: 300 } });
  assert.throws(() => expandTemplate({ type: "strobe" }, 4), ValidationError);
});

test("commands create every step first, then step timing, then phaser layers with the repetition MAtricks around them", () => {
  const e: Effect = { unit: "physical", steps: [{ values: { Pan: { relative: 20 } }, accel: -100 }, { values: { Pan: { absolute: -45 } }, preset: { pool: 4, number: 4 }, transition: 0 }], phaser: { speedBpm: 30, phase: { from: 0, to: 180 }, measure: 4, speedMaster: 2, repeat: { kind: "groups", count: 2 } } };
  assert.deepEqual(effectCommands(e), [
    "Step 1", 'Attribute "Pan" At Relative Physical 20',
    "Step 2", "At Preset 4.4", 'Attribute "Pan" At Absolute Physical -45',
    "Step 1", "At Acceleration -100", "Step 2", "At Transition 0",
    'Set Selection MAtricks "XGroup" 2', "At Speed 30", "At Phase 0 Thru 180", "At Measure 4", "At SpeedMaster 2", "Reset Selection MAtricks", "Step 1",
  ]);
});

test("the expected phase follows the grid position and the repetition", () => {
  const at = (n: number, repeat?: Parameters<typeof expectedPhase>[3]) => Array.from({ length: n }, (_, k) => expectedPhase({ from: 0, to: 270 }, k, n, repeat));
  assert.deepEqual(at(4), [0, 90, 180, 270]);
  assert.deepEqual(Array.from({ length: 4 }, (_, k) => expectedPhase({ from: 360, to: 0 }, k, 4)), [360, 240, 120, 0], "reverse direction");
  assert.deepEqual([0, 1].map((k) => expectedPhase({ from: 0, to: 180 }, k, 2, { kind: "wings", count: 2 })), [180, 180], "a one-fixture wing gets the centre end (live)");
  assert.deepEqual(at(4, { kind: "groups", count: 2 }), [0, 270, 0, 270]);
  assert.deepEqual(at(8, { kind: "wings", count: 2 }), [0, 90, 180, 270, 270, 180, 90, 0]);
  assert.deepEqual(at(8, { kind: "blocks", count: 2 }), [0, 0, 90, 90, 180, 180, 270, 270]);
  assert.deepEqual(at(1), [0]);
});

// ---------------------------------------------------------------------------
// Build verification
// ---------------------------------------------------------------------------

type Row = ProgrammerRow & { physicalFrom?: number; physicalTo?: number; phaser?: ProgrammerRow["phaser"] & { gridPos?: number } };
const chaseEffect = (): Effect => ({ unit: "percent", steps: [{ values: { Dimmer: { absolute: 100 } }, transition: 0 }, { values: { Dimmer: { absolute: 0 } }, transition: 0 }], phaser: { speedBpm: 120, phase: { from: 0, to: 270 } } });
const chaseRow = (sf: number, pos: number, over: Partial<Row> = {}): Row => ({
  subfixtureIndex: sf, fid: String(sf), attribute: "Dimmer", stepCount: 2,
  steps: [{ absolute: 100, trans: 0 }, { absolute: 0, trans: 0 }],
  phaser: { speed: 2, phase: pos * 90, gridPos: pos },
  ...over,
});
const scope = new Map([[63, "401"], [64, "402"], [65, "403"], [66, "404"]]);

test("a correct build verifies; each kind of deviation is named", () => {
  const ok = [chaseRow(63, 0), chaseRow(64, 1), chaseRow(65, 2), chaseRow(66, 3)];
  assert.deepEqual(verifyBuild({ effect: chaseEffect(), rows: ok, scope, implied: new Set(), stepPresets: [] }).problems, []);
  const p = (rows: Row[], extra: Partial<Parameters<typeof verifyBuild>[0]> = {}) => verifyBuild({ effect: chaseEffect(), rows, scope, implied: new Set(), stepPresets: [], ...extra }).problems.join(" | ");
  assert.match(p(ok.slice(0, 3)), /404: no programmer value \(the effect was not applied\)/);
  assert.match(p([...ok.slice(0, 3), chaseRow(66, 3, { stepCount: 1 })]), /404 Dimmer: 1 steps, 2 expected/);
  assert.match(p([...ok.slice(0, 3), chaseRow(66, 3, { steps: [{ absolute: 100, trans: 100 }, { absolute: 0, trans: 0 }] })]), /404 Dimmer step 1: transition 0 expected, 100 read/);
  assert.match(p([...ok.slice(0, 3), chaseRow(66, 3, { steps: [{ absolute: 90, trans: 0 }, { absolute: 0, trans: 0 }] })]), /404 Dimmer step 1: absolute 100 % expected, 90 read/);
  assert.match(p([...ok.slice(0, 3), chaseRow(66, 3, { phaser: { speed: 1, phase: 270, gridPos: 3 } })]), /404 Dimmer: speed 120 BPM expected, 60 BPM read/);
  assert.match(p([...ok.slice(0, 3), chaseRow(66, 3, { phaser: { speed: 2, phase: 0, gridPos: 3 } })]), /404 Dimmer: phase 270° expected \(grid position 3 of 4\), 0 read/);
  assert.match(p([...ok, { subfixtureIndex: 5, fid: "701", attribute: "Dimmer", stepCount: 1, value: 30 }]), /unexpected programmer value on subfixture 5/);
  assert.match(p([...ok, { ...chaseRow(63, 0), attribute: "Shutter1" }]), /unexpected attribute Shutter1 on 401/);
  const implied = verifyBuild({ effect: chaseEffect(), rows: [...ok, { ...chaseRow(63, 0), attribute: "ColorRGB_W" }], scope, implied: new Set(["ColorRGB_W"]), stepPresets: [] });
  assert.deepEqual(implied.problems, []);
  assert.deepEqual(implied.implied, ["ColorRGB_W"]);
});

test("physical values convert through the range, relative values through its size (reversed ranges too)", () => {
  const e: Effect = { unit: "physical", steps: [{ values: { Pan: { relative: 30 } } }, { values: { Pan: { absolute: -45 } } }], phaser: {} };
  const row = (from: number, to: number, rel: number, abs: number): Row => ({ subfixtureIndex: 2, fid: "601", attribute: "Pan", stepCount: 2, physicalFrom: from, physicalTo: to, steps: [{ relative: rel }, { absolute: abs }], phaser: { gridPos: 0 } });
  const s = new Map([[2, "601"]]);
  assert.deepEqual(verifyBuild({ effect: e, rows: [row(-225, 225, 6.667, 40)], scope: s, implied: new Set(), stepPresets: [] }).problems, []);
  assert.deepEqual(verifyBuild({ effect: e, rows: [row(270, -270, 5.556, 58.333)], scope: s, implied: new Set(), stepPresets: [] }).problems, [], "reversed range: relative stays positive");
  assert.match(verifyBuild({ effect: e, rows: [{ ...row(-225, 225, 6.667, 40), physicalFrom: undefined }], scope: s, implied: new Set(), stepPresets: [] }).problems.join(), /physical range of Pan is unknown/);
});

test("step presets must be referenced by their step", () => {
  const e: Effect = { unit: "percent", steps: [{ values: {}, preset: { pool: 4, number: 4 } }, { values: {}, preset: { pool: 4, number: 6 } }], phaser: {} };
  const rows: Row[] = [{ subfixtureIndex: 63, fid: "401", attribute: "ColorRGB_R", stepCount: 2, steps: [{ absolute: 100, integratedPreset: { addrNative: "P.4.4" } }, { absolute: 80, integratedPreset: { addrNative: "P.4.5" } }], phaser: { gridPos: 0 } }];
  const r = verifyBuild({ effect: e, rows, scope: new Map([[63, "401"]]), implied: new Set(), stepPresets: ["P.4.4", "P.4.6"] });
  assert.match(r.problems.join(), /401 step 2: the preset reference P\.4\.6 is missing \(P\.4\.5\)/);
  assert.match(r.problems.join(), /401 step 2: references P\.4\.5 instead of P\.4\.6/);
  assert.deepEqual(verifyBuild({ effect: e, rows: [{ ...rows[0], steps: [rows[0].steps![0], { absolute: 80, integratedPreset: { addrNative: "P.4.6" } }] }], scope: new Map([[63, "401"]]), implied: new Set(), stepPresets: ["P.4.4", "P.4.6"] }).problems, []);
  assert.deepEqual(r.implied, ["ColorRGB_R"], "a step preset's attributes are part of the effect");
});

test("the programmer fingerprint ignores order and catches any change", () => {
  const a: ProgrammerRow = { subfixtureIndex: 5, attribute: "Dimmer", value: 30, stepCount: 1 };
  const b: ProgrammerRow = { subfixtureIndex: 6, attribute: "Dimmer", value: 40, stepCount: 1 };
  assert.equal(fingerprint([a, b]), fingerprint([b, a]));
  assert.notEqual(fingerprint([a, b]), fingerprint([a, { ...b, value: 41 }]));
  assert.notEqual(fingerprint([a]), fingerprint([a, b]));
});

// ---------------------------------------------------------------------------
// The tool against a fake console (Preview environment, programmer, store)
// ---------------------------------------------------------------------------

class Console {
  env = "Normal";
  programmers: Record<string, Row[]> = { Normal: [], Preview: [] };
  selection: number[] = [];
  step = 1;
  commands: string[] = [];
  presets = new Map<string, unknown>();
  /** A step layer the console does not apply (e.g. on the first step). */
  dropFirstStepTransition = false;
  /** Preview On answers OK but the console stays in Normal. */
  previewIgnored = false;
  /** Corrupt the stored copy of step 2 (a store the read-back must catch). */
  corruptStore = false;
  failPreviewOff = false;
  fixtures: Record<string, { sf: number; attrs: string[] }> = { "401": { sf: 63, attrs: ["Dimmer", "ColorRGB_R"] }, "402": { sf: 64, attrs: ["Dimmer", "ColorRGB_R"] }, "601": { sf: 2, attrs: ["Pan", "Tilt"] } };

  private prog(): Row[] {
    return this.programmers[this.env];
  }
  private row(sf: number, attr: string): Row {
    let r = this.prog().find((x) => x.subfixtureIndex === sf && x.attribute === attr);
    if (!r) {
      r = { subfixtureIndex: sf, fid: String(Object.entries(this.fixtures).find(([, f]) => f.sf === sf)![0]), attribute: attr, stepCount: 0, steps: [], phaser: { gridPos: this.selection.indexOf(sf) } };
      this.prog().push(r);
    }
    return r;
  }

  names = new Map<string, string>();
  /** Never answer a Name write (a lost reply after the store went through). */
  silentNameSet = false;
  /** Refuse every Name write (the store went through, the name did not). */
  rejectNameSet = false;
  matricks: { kind: "groups" | "wings" | "blocks"; count: number } | undefined;

  install(h: Harness): void {
    h.fake.on("set", (args) => {
      if (this.silentNameSet) return SILENT;
      if (this.rejectNameSet) throw new Error("Illegal value");
      const key = String(args.ref).replace("Preset ", "");
      this.names.set(key, String(args.value));
      return { ref: args.ref, property: args.property, value: args.value };
    });
    h.fake.on("preset.context", () => ({ preferences: { StoreLook: "No", PresetInputFilter: "Yes", StoreMode: "Ask" }, preferencesReadable: true, pool: { no: 23, exists: true, name: "All 3", presetMode: "Selective" } }));
    h.fake.on("preset.read", (args) => {
      const key = String(args.ref).replace("Preset ", "");
      if (key === "4.4") return { ref: args.ref, addrNative: "P.4.4", rows: [], dependencies: [] };
      const stored = this.presets.get(key) as Row[] | undefined;
      if (!stored) throw new Error(`no object found for '${args.ref}'`);
      const types: Record<string, string> = {};
      for (const sf of (args.typesFor as number[]) ?? []) types[String(sf)] = "T";
      return { ref: args.ref, no: 1, name: this.names.get(key) ?? "x", pool: { no: 23 }, presetMode: "Selective", storedData: "Selective", lock: "", dependencies: [], dependenciesReadable: true, types,
        rows: stored.map((r) => ({ fixture: r.fid, attribute: r.attribute, sfIndex: r.subfixtureIndex, fixtureType: "T", mode: "selective", stepCount: r.stepCount, steps: r.steps!.map((s, i) => ({ step: i + 1, absolute: s.absolute ?? undefined, relative: s.relative ?? undefined, trans: s.trans ?? undefined, accel: s.accel ?? undefined, decel: s.decel ?? undefined, width: s.width ?? undefined })), speed: r.phaser?.speed === 1 ? undefined : r.phaser?.speed, phase: r.phaser?.phase === 0 ? undefined : r.phaser?.phase })) };
    });
    h.fake.on("fixtureAttributes", (args) => {
      const id = String(args.ref).replace("Fixture ", "");
      const f = this.fixtures[id];
      if (!f) throw new Error(`no object found for '${args.ref}'`);
      return { subfixtureIndex: f.sf, attributes: f.attrs.map((a) => ({ attribute: a, featureGroup: "Dimmer" })), subfixtures: [] };
    });
    h.fake.on("programmer", () => {
      const rows = this.prog().filter((r) => (r.stepCount ?? 0) > 0).map((r) => ({ ...r, steps: r.steps?.map((s) => ({ ...s })), phaser: { ...r.phaser } }));
      return { environment: this.env, rows, total: rows.length, count: rows.length, coverage: { complete: true }, stats: { channelErrors: 0 }, limitations: [] };
    });
    h.fake.on("cmd", (args) => {
      const c = String(args.command);
      this.commands.push(c);
      let m: RegExpMatchArray | null;
      if ((m = c.match(/^Store Preset (\d+\.\d+) /))) {
        this.presets.set(m[1], this.prog().map((r) => ({ ...r, steps: r.steps!.map((st, i) => (this.corruptStore && i === 1 ? { ...st, absolute: 55 } : { ...st })) })));
        for (const r of this.prog()) r.stepCount = 0;
        return { feedback: "OK" };
      }
      // Selection MAtricks while the phase is set: groups / wings / blocks change the distribution (shuffle is ignored).
      const mat = c.match(/^Set Selection MAtricks "X(Group|Wings|Block)" (\d+)$/);
      if (mat) { this.matricks = { kind: ({ Group: "groups", Wings: "wings", Block: "blocks" } as const)[mat[1] as "Group"], count: Number(mat[2]) }; return { feedback: "OK" }; }
      if (c === "Reset Selection MAtricks") { this.matricks = undefined; return { feedback: "OK" }; }
      if (/^Grid /.test(c) || /MAtricks/.test(c)) return { feedback: "OK" };
      if (c === "Preview On") { if (!this.previewIgnored) { this.env = "Preview"; this.selection = []; } return { feedback: "OK" }; }
      if (c === "Preview Off") { if (this.failPreviewOff) return { feedback: "Error" }; this.env = "Normal"; return { feedback: "OK" }; }
      if (c === "ClearAll") { this.programmers[this.env] = []; this.selection = []; return { feedback: "OK" }; }
      if (c === "ClearSelection") { this.selection = []; return { feedback: "OK" }; }

      if ((m = c.match(/^Fixture (\S+)$/))) { this.selection.push(this.fixtures[m[1]].sf); return { feedback: "OK" }; }
      if ((m = c.match(/^Step (\d+)$/))) { this.step = Number(m[1]); return { feedback: "OK" }; }
      if ((m = c.match(/^Attribute "(\w+)" At Absolute (-?[\d.]+)$/))) {
        for (const sf of this.selection) { const r = this.row(sf, m[1]); r.steps![this.step - 1] = { ...(r.steps![this.step - 1] ?? {}), absolute: Number(m[2]) }; r.stepCount = r.steps!.length; }
        return { feedback: "OK" };
      }
      if ((m = c.match(/^At (Transition|Width|Acceleration|Deceleration) (-?[\d.]+)$/))) {
        const key = { Transition: "trans", Width: "width", Acceleration: "accel", Deceleration: "decel" }[m[1]] as "trans";
        if (!(this.dropFirstStepTransition && this.step === 1 && key === "trans")) for (const r of this.prog()) if (r.steps![this.step - 1]) r.steps![this.step - 1][key] = Number(m[2]);
        return { feedback: "OK" };
      }
      if ((m = c.match(/^At Speed ([\d.]+)$/))) { for (const r of this.prog()) r.phaser!.speed = Number(m[1]) / 60; return { feedback: "OK" }; }
      if ((m = c.match(/^At Phase (-?[\d.]+) Thru (-?[\d.]+)$/))) {
        const [from, to] = [Number(m[1]), Number(m[2])];
        const n = this.selection.length;
        for (const r of this.prog()) { const k = this.selection.indexOf(r.subfixtureIndex); r.phaser!.phase = expectedPhase({ from, to }, k, n, this.matricks); }
        return { feedback: "OK" };
      }
      if ((m = c.match(/^Store Preset (\d+\.\d+) /))) { this.presets.set(m[1], this.prog().map((r) => ({ ...r }))); for (const r of this.prog()) r.stepCount = 0; return { feedback: "OK" }; }
      if ((m = c.match(/^At Preset (\d+\.\d+)$/))) { for (const sf of this.selection) { const r = this.row(sf, "Dimmer"); r.steps = [{ absolute: 100 }, { absolute: 0 }]; r.stepCount = 2; } return { feedback: "OK" }; }
      throw new Error(`unexpected command ${c}`);
    });
  }
}

let h: Harness;
let con: Console;
before(async () => {
  h = await startHarness(registerPhaserTools);
});
after(async () => {
  await h.close();
});
beforeEach(() => {
  h.fake.reset();
  con = new Console();
  con.install(h);
});

const build = (args: Record<string, unknown>) => h.callJson("gma3_build_phaser", { exclusive: true, ...args });
const errorOf = (r: any, name: string) => r.steps.find((s: { name: string }) => s.name === name)?.error ?? "";

test("a dimmer chase is built in Preview, checked, stored, Preview left, and the Normal programmer is untouched", async () => {
  con.programmers.Normal.push({ subfixtureIndex: 5, fid: "701", attribute: "Dimmer", stepCount: 1, value: 30, steps: [{ absolute: 30 }], phaser: {} });
  const { result, isError } = await build({ preset: "23.1", fixtures: [401, 402], template: { type: "dimmer_chase" } });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
  assert.equal(result.normalProgrammerUntouched, true);
  assert.equal(con.env, "Normal");
  assert.deepEqual(con.commands.slice(0, 6), ["Preview On", "ClearSelection", "Grid 0/0/0", "Fixture 401", "Grid 1/0/0", "Fixture 402"]);
  assert.deepEqual(con.commands.slice(-2), ["ClearAll", "Preview Off"]);
  assert.equal(con.programmers.Normal.length, 1, "the Normal programmer keeps its value");
  assert.equal(con.programmers.Preview.length, 0);
  assert.equal(result.plan.distribution.direction, "forward");
  assert.deepEqual(result.plan.playbackSpeed, { speedBpm: 120, measure: null, speedMaster: null });
});

test("a build that does not match is not stored, and Preview is left", async () => {
  con.dropFirstStepTransition = true;
  const { result, isError } = await build({ preset: "23.1", fixtures: [401, 402], template: { type: "dimmer_chase" } });
  assert.equal(isError, true);
  assert.match(errorOf(result, "check_build"), /step 1: transition 0 expected, 100 read/);
  assert.equal(result.steps.find((s: { name: string }) => s.name === "store").status, "skipped");
  assert.equal(con.presets.size, 0);
  assert.equal(con.env, "Normal");
  assert.deepEqual(con.commands.slice(-2), ["ClearAll", "Preview Off"]);
});

test("unsupported attributes, a missing step preset, an audition on a busy programmer and a Preview start are refused before anything is sent", async () => {
  const pt = await build({ preset: "23.1", fixtures: [401], template: { type: "pan_tilt" } });
  assert.match(errorOf(pt.result, "resolve_fixtures"), /401 has no Pan, Tilt/);
  const preset = await build({ preset: "23.1", fixtures: [401, 402], steps: [{ preset: "4.9" }, { values: { Dimmer: 0 } }] });
  assert.match(errorOf(preset.result, "check_step_presets"), /Preset 4\.9 \(a step preset\) does not exist/);
  con.programmers.Normal.push({ subfixtureIndex: 5, fid: "701", attribute: "Dimmer", stepCount: 1, value: 30, steps: [{ absolute: 30 }], phaser: {} });
  const aud = await build({ preset: "23.1", fixtures: [401, 402], template: { type: "dimmer_chase" }, audition_ms: 500 });
  assert.match(errorOf(aud.result, "read_normal_programmer"), /audition_ms needs an empty Normal programmer/);
  con.env = "Preview";
  const inPreview = await build({ preset: "23.1", fixtures: [401, 402], template: { type: "dimmer_chase" } });
  assert.match(errorOf(inPreview.result, "read_normal_programmer"), /in the Preview environment/);
  assert.deepEqual(con.commands, []);
});

test("an audition plays the stored preset in the Normal programmer and always releases it", async () => {
  const { result } = await build({ preset: "23.1", fixtures: [401, 402], template: { type: "dimmer_chase" }, audition_ms: 50 });
  assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
  assert.deepEqual(result.audition, { ms: 50, released: true });
  const tail = con.commands.slice(con.commands.indexOf("Preview Off") + 1);
  assert.deepEqual(tail, ["ClearSelection", "Grid 0/0/0", "Fixture 401", "Grid 1/0/0", "Fixture 402", "At Preset 23.1", "ClearAll"]);
});

test("validation: one of fixtures/group, one of steps/template, exclusive, mode and audition bounds", async () => {
  for (const [args, re] of [
    [{ preset: "23.1", template: { type: "dimmer_chase" } }, /exactly one of fixtures .* or group/],
    [{ preset: "23.1", fixtures: [401], steps: [{ values: { Dimmer: 1 } }, { values: { Dimmer: 0 } }], template: { type: "dimmer_chase" } }, /exactly one of steps .* or template/],
    [{ preset: "23.1", fixtures: [401], steps: [{ values: { Dimmer: 1 } }] }, /2-16 steps/],
    [{ preset: "23.1", fixtures: [401], template: { type: "dimmer_chase" }, phaser: { speed_bpm: 30 } }, /a template sets its own phaser/],
    [{ preset: "23.1", fixtures: [401], template: { type: "dimmer_chase" }, mode: "universal" }, /mode must be selective or global|"selective"\|"global"|Invalid option/],
    [{ preset: "23.1", fixtures: [401], template: { type: "dimmer_chase" }, audition_ms: 60000 }, /audition_ms must be <= 30000/],
    [{ preset: "23.1", fixtures: [401], template: { type: "dimmer_chase" }, exclusive: false }, /exclusive must be true/],
  ] as const) {
    const { result, isError } = await h.callJson("gma3_build_phaser", { exclusive: true, ...args } as Record<string, unknown>);
    assert.equal(isError, true, JSON.stringify(args));
    // A value outside a schema enum is refused by the input schema before the tool runs.
    assert.match(Array.isArray(result.validationErrors) ? result.validationErrors.join("; ") : String(result), re, JSON.stringify(result));
  }
  assert.equal(h.fake.requests.length, 0);
});

test("preview returns the plan and commands without sending anything", async () => {
  const { result, isError } = await h.callJson("gma3_build_phaser", { preset: "23.1", fixtures: [401, 402], template: { type: "dimmer_chase" }, preview: true });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.preview, true);
  assert.ok(result.plan.commands.includes("At Phase 0 Thru 180"));
  assert.deepEqual(con.commands, []);
});

test("gma3_phaser_release leaves Preview, clears Normal only on request, and is idempotent", async () => {
  con.env = "Preview";
  con.programmers.Preview.push({ subfixtureIndex: 63, attribute: "Dimmer", stepCount: 1, steps: [{ absolute: 50 }], phaser: {} });
  const r = await h.callJson("gma3_phaser_release", {});
  assert.equal(r.isError, false, JSON.stringify(r.result));
  assert.deepEqual(con.commands, ["ClearAll", "Preview Off"]);
  assert.equal(con.env, "Normal");
  const again = await h.callJson("gma3_phaser_release", {});
  assert.match(again.result.summary, /nothing was sent/);
  assert.equal((await h.callJson("gma3_phaser_release", { clear_normal: true })).isError, true, "clear_normal needs exclusive");
  con.programmers.Normal.push({ subfixtureIndex: 63, attribute: "Dimmer", stepCount: 1, steps: [{ absolute: 50 }], phaser: {} });
  const clear = await h.callJson("gma3_phaser_release", { clear_normal: true, exclusive: true });
  assert.equal(clear.isError, false);
  assert.equal(con.programmers.Normal.length, 0);
});

// ---------------------------------------------------------------------------
// Review round 1
// ---------------------------------------------------------------------------

test("cleanup clears only after the console confirms Preview: a Preview On that did not take leaves Normal alone", async () => {
  con.previewIgnored = true;
  con.programmers.Normal.push({ subfixtureIndex: 5, fid: "701", attribute: "Dimmer", stepCount: 1, value: 30, steps: [{ absolute: 30 }], phaser: {} });
  const { result, isError } = await build({ preset: "23.1", fixtures: [401, 402], template: { type: "dimmer_chase" }, detail: true });
  assert.equal(isError, true);
  assert.match(errorOf(result, "check_preview"), /reports the Normal environment after Preview On/);
  assert.equal(con.commands.includes("ClearAll"), false, "no ClearAll in Normal");
  assert.equal(con.commands.includes("Preview Off"), false);
  assert.equal(result.steps.find((s: { name: string }) => s.name === "confirm_preview").detail.environment, "Normal");
  assert.equal(con.programmers.Normal.length, 1, "the operator's value survives");
  assert.equal(result.normalProgrammerUntouched, true);
});

test("an effect whose read-back mismatched is not auditioned; audition_ms needs verify", async () => {
  con.corruptStore = true;
  const { result, isError } = await build({ preset: "23.1", fixtures: [401, 402], template: { type: "dimmer_chase" }, audition_ms: 50 });
  assert.equal(isError, true);
  assert.equal(result.verification.status, "mismatched");
  assert.equal(con.commands.some((c) => c.startsWith("At Preset")), false, "nothing is played");
  assert.ok(result.warnings.some((w: string) => /audition was skipped/.test(w)));
  const noVerify = await h.callJson("gma3_build_phaser", { preset: "23.1", fixtures: [401], template: { type: "dimmer_chase" }, audition_ms: 50, verify: false, exclusive: true });
  assert.match(noVerify.result.validationErrors.join(), /audition_ms needs verify/);
});

test("preset-only steps and activation-group siblings get the timing and distribution checks too", () => {
  const e: Effect = { unit: "percent", steps: [{ values: {}, preset: { pool: 4, number: 4 }, transition: 0 }, { values: {}, preset: { pool: 4, number: 6 } }], phaser: { speedBpm: 120, phase: { from: 0, to: 90 }, measure: 2, speedMaster: 3 } };
  const row = (sf: number, pos: number, over: Partial<Row> = {}): Row => ({
    subfixtureIndex: sf, fid: String(sf), attribute: "ColorRGB_R", stepCount: 2,
    steps: [{ absolute: 100, trans: 0, integratedPreset: { addrNative: "P.4.4" } }, { absolute: 80, integratedPreset: { addrNative: "P.4.6" } }],
    phaser: { speed: 2, phase: pos * 90, measure: 200, speedMaster: 2, gridPos: pos },
    ...over,
  });
  const sc = new Map([[63, "401"], [64, "402"]]);
  const v = (rows: Row[]) => verifyBuild({ effect: e, rows, scope: sc, implied: new Set(), stepPresets: ["P.4.4", "P.4.6"] }).problems.join(" | ");
  assert.equal(v([row(63, 0), row(64, 1)]), "");
  const bad = row(64, 1, { steps: [{ absolute: 100, trans: 100, integratedPreset: { addrNative: "P.4.4" } }, { absolute: 80, integratedPreset: { addrNative: "P.4.6" } }], phaser: { speed: 1, phase: 0, measure: 400, speedMaster: 0, gridPos: 1 } });
  const out = v([row(63, 0), bad]);
  for (const re of [/402 ColorRGB_R step 1: transition 0 expected, 100 read/, /402 ColorRGB_R: speed 120 BPM expected, 60 BPM read/, /402 ColorRGB_R: measure 2 expected, 400 read/, /402 ColorRGB_R: speed master 3 expected, 1 read/, /402 ColorRGB_R: phase 90° expected/]) assert.match(out, re);
  // An activation-group sibling of an explicit attribute is checked as well.
  const sib = verifyBuild({ effect: chaseEffect(), rows: [chaseRow(63, 0), chaseRow(64, 1), chaseRow(65, 2), chaseRow(66, 3), { ...chaseRow(63, 0), attribute: "ColorRGB_W", phaser: { speed: 1, phase: 0, gridPos: 0 } }], scope, implied: new Set(["ColorRGB_W"]), stepPresets: [] });
  assert.match(sib.problems.join(), /401 ColorRGB_W: speed 120 BPM expected, 60 BPM read/);
  assert.match(v([row(63, 0)]), /402: no programmer value/);
});

test("the fingerprint includes measure, speed master, relative and per-step references", () => {
  const base: ProgrammerRow = { subfixtureIndex: 5, attribute: "Dimmer", stepCount: 2, steps: [{ absolute: 100 }, { absolute: 0 }], phaser: { speed: 1, phase: 0, measure: 200, speedMaster: 1 } };
  const fp = fingerprint([base]);
  for (const changed of [
    { ...base, phaser: { ...base.phaser, measure: 400 } },
    { ...base, phaser: { ...base.phaser, speedMaster: 2 } },
    { ...base, relPreset: { addrNative: "P.2.1" } },
    { ...base, steps: [{ absolute: 100, integratedPreset: { addrNative: "P.4.4" } }, { absolute: 0 }] },
    { ...base, absPreset: { addrNative: "P.4.4" } },
  ]) assert.notEqual(fingerprint([changed as ProgrammerRow]), fp, JSON.stringify(changed));
});

// ---------------------------------------------------------------------------
// SU-13: whole rig, variants, mirror, phase step, shuffle, shapes and patterns
// ---------------------------------------------------------------------------

test("SU-13 phaser forms: a phase step per fixture, an even spread and a shuffle seed", () => {
  assert.deepEqual(parsePhaser({ phase: { step: 180 } }).phaseStep, { from: 0, step: 180 });
  assert.equal(parsePhaser({ phase: "spread" }).phaseSpread, true);
  assert.equal(parsePhaser({ phase: { from: 0, to: 90 }, shuffle: 7 }).shuffle, 7);
  for (const bad of [{ phase: { step: 10, to: 20 } }, { shuffle: 3 }, { phase: { from: 0, to: 1 }, shuffle: 0 }, { phase: "even" }]) assert.throws(() => parsePhaser(bad), ValidationError, JSON.stringify(bad));
  const base: Effect = { unit: "percent", steps: [{ values: { Dimmer: { absolute: 100 } } }, { values: { Dimmer: { absolute: 0 } } }], phaser: { phaseStep: { from: 0, step: 180 } } };
  assert.deepEqual(planEffect(base, 72).effect.phaser.phase, { from: 0, to: 12780 }, "the field test's 180 degrees between neighbours");
  assert.deepEqual(planEffect({ ...base, phaser: { phaseSpread: true } }, 4).effect.phaser.phase, { from: 0, to: 270 });
  assert.ok(sameAngle(12780, 180) && sameAngle(360, 0) && !sameAngle(90, 270), "phases compare modulo 360");
});

test("SU-13 mirror: every second wing inverted (relative and physical negated, percent 100 - v); spreads give per-fixture values", () => {
  assert.deepEqual(invertValue({ relative: 20 }, "physical"), { relative: -20 });
  assert.deepEqual(invertValue({ absolute: -45 }, "physical"), { absolute: 45 });
  assert.deepEqual(invertValue({ absolute: 30 }, "percent"), { absolute: 70 });
  const circle = expandTemplate({ type: "circle", size: 30, center: { pan: 10, tilt: 0 } }, 4);
  const { overrides } = planEffect({ ...circle, mirror: { attributes: ["Pan"], wings: 2 } }, 4);
  assert.deepEqual([...new Set(overrides.map((o) => o.member))], [2, 3], "the second half of four fixtures");
  assert.deepEqual(overrides.filter((o) => o.member === 2).map((o) => o.value.absolute), [-40, -10, 20, -10], "Pan negated per step");
  const fan = expandTemplate({ type: "fan", size: 60, center: { pan: 0, tilt: 10 } }, 0);
  const fo = planEffect(fan, 4).overrides;
  assert.deepEqual(fo.map((o) => [o.member, o.step, o.value.absolute]), [[0, 2, -30], [1, 2, -10], [2, 2, 10], [3, 2, 30]]);
  const mirroredFan = planEffect({ ...fan, mirror: { attributes: ["Pan"], wings: 2 } }, 4).overrides;
  assert.deepEqual(mirroredFan.filter((o) => o.step === 2).map((o) => o.value.absolute), [-30, -10, -10, -30], "a mirrored spread inverts the spread value");
});

test("SU-13 commands: overrides after every step exists, on the fixtures they belong to (same overrides together), then the whole selection again; shuffle as selection MAtricks", () => {
  const e: Effect = { unit: "percent", steps: [{ values: { Dimmer: { absolute: 100 } } }, { values: { Dimmer: { absolute: 0 } } }], phaser: { phase: { from: 0, to: 270 }, shuffle: 5 }, mirror: { attributes: ["Dimmer"], wings: 2 } };
  const planned = planEffect(e, 4);
  const cmds = effectCommands(planned.effect, planned.overrides, { all: ["ClearSelection", "Fixture 1 Thru 4"], some: (ms) => ["ClearSelection", ...ms.map((m) => `Fixture ${m + 1}`)] });
  assert.deepEqual(cmds, [
    "Step 1", 'Attribute "Dimmer" At Absolute 100', "Step 2", 'Attribute "Dimmer" At Absolute 0',
    "ClearSelection", "Fixture 3", "Fixture 4", "Step 1", 'Attribute "Dimmer" At Absolute 0', "Step 2", 'Attribute "Dimmer" At Absolute 100',
    "ClearSelection", "Fixture 1 Thru 4",
    'Set Selection MAtricks "XShuffle" 5', "At Phase 0 Thru 270", "Reset Selection MAtricks", "Step 1",
  ]);
});

test("SU-13 verification: per-fixture values from overrides, a shuffled distribution as a set, a compact phase summary", () => {
  const e: Effect = { unit: "percent", steps: [{ values: { Dimmer: { absolute: 100 } } }, { values: { Dimmer: { absolute: 0 } } }], phaser: { phase: { from: 0, to: 270 }, shuffle: 5 } };
  const mk = (sf: number, pos: number, phase: number, a: number, b: number) => ({ subfixtureIndex: sf, attribute: "Dimmer", stepCount: 2, steps: [{ absolute: a }, { absolute: b }], phaser: { gridPos: pos, phase } });
  const scope = new Map([[1, "1"], [2, "2"], [3, "3"], [4, "4"]]);
  const shuffled = [mk(1, 0, 180, 100, 0), mk(2, 1, 0, 100, 0), mk(3, 2, 270, 100, 0), mk(4, 3, 90, 100, 0)];
  assert.deepEqual(verifyBuild({ effect: e, rows: shuffled, scope, implied: new Set(), stepPresets: [] }).problems, []);
  const wrongSet = [...shuffled.slice(0, 3), mk(4, 3, 180, 100, 0)];
  assert.match(verifyBuild({ effect: e, rows: wrongSet, scope, implied: new Set(), stepPresets: [] }).problems.join(), /shuffled phases: expected the set 0, 90, 180, 270/);
  const mirrored = { ...e, phaser: { phase: { from: 0, to: 270 } } };
  const over = new Map([["3|1|Dimmer", { absolute: 0 }], ["3|2|Dimmer", { absolute: 100 }]]);
  const rows = [mk(1, 0, 0, 100, 0), mk(2, 1, 90, 100, 0), mk(3, 2, 180, 0, 100), mk(4, 3, 270, 100, 0)];
  const overrideOf = (sf: number, step: number, a: string) => over.get(`${sf}|${step}|${a}`);
  assert.deepEqual(verifyBuild({ effect: mirrored, rows, scope, implied: new Set(), stepPresets: [], overrideOf }).problems, []);
  assert.match(verifyBuild({ effect: mirrored, rows, scope, implied: new Set(), stepPresets: [] }).problems.join(), /3 Dimmer step 1: absolute 100 % expected, 0 read/, "without the override the inverted fixture is a mismatch");
  const order = [1, 2, 3, 4].map((sf) => ({ sf, id: String(sf) }));
  assert.deepEqual(summarizePhases(rows, order), { fixtures: 4, first: "1", last: "4", first_phase: 0, step: 90 });
  assert.deepEqual(summarizePhases(shuffled, order), { fixtures: 4, first: "1", last: "4", phases: [180, 0, 270, 90] });
  // 72 cells, 180 degrees apart: a few dozen characters instead of a programmer dump.
  const long = Array.from({ length: 72 }, (_, k) => mk(k + 10, k, k * 180, 100, 0));
  const sum = summarizePhases(long, long.map((r) => ({ sf: r.subfixtureIndex, id: `401.${r.subfixtureIndex - 9}` })));
  assert.deepEqual(sum, { fixtures: 72, first: "401.1", last: "401.72", first_phase: 0, step: 180 });
  // 116 fixtures spread over 360: the step 3.1034 does not drift over the run.
  const spread = Array.from({ length: 116 }, (_, k) => mk(k + 10, k, (360 * k) / 116, 100, 0));
  assert.deepEqual(summarizePhases(spread, spread.map((r) => ({ sf: r.subfixtureIndex, id: String(r.subfixtureIndex) }))), { fixtures: 116, first: "10", last: "125", first_phase: 0, step: 3.1034 });
  // As the console reads it back (live 2026-10-15): kept within ±720, with float noise.
  const wrapped = [0, 180, 360, 540, 720, -539.99997854233, -359.99997854233, -179.99997854233].map((ph, k) => mk(k + 10, k, ph, 100, 0));
  assert.deepEqual(summarizePhases(wrapped, wrapped.map((r) => ({ sf: r.subfixtureIndex, id: String(r.subfixtureIndex) }))), { fixtures: 8, first: "10", last: "17", first_phase: 0, step: 180 });
});

test("SU-13 templates: position shapes in degrees and dimmer patterns for rows", () => {
  const c = expandTemplate({ type: "circle", size: 20, center: { pan: 5, tilt: -10 } }, 0);
  assert.equal(c.unit, "physical");
  assert.deepEqual(c.steps.map((s) => [s.values.Pan.absolute, s.values.Tilt.absolute]), [[25, -10], [5, 10], [-15, -10], [5, -30]]);
  assert.equal(expandTemplate({ type: "figure8", size: 20 }, 0).steps.length, 8);
  assert.deepEqual(expandTemplate({ type: "bounce", size: 15, center: { tilt: 30 } }, 0).steps.map((s) => s.values.Tilt.absolute), [45, 15]);
  assert.deepEqual(expandTemplate({ type: "cone", tilt: 40 }, 0).steps.map((s) => s.values.Pan.absolute), [-180, 0, 180, 0]);
  const runner = expandTemplate({ type: "runner" }, 8);
  assert.deepEqual(runner.steps.map((s) => [s.values.Dimmer.absolute, s.width, s.transition]), [[100, 100, 0], [0, 700, 0]]);
  assert.deepEqual(runner.phaser.phase, { from: 0, to: 315 });
  const comet = expandTemplate({ type: "comet", tail: 3 }, 10);
  assert.deepEqual(comet.steps.map((s) => [s.width, s.transition]), [[300, 100], [700, 0]]);
  assert.deepEqual(expandTemplate({ type: "alternate" }, 6).phaser.repeat, { kind: "groups", count: 2 });
  assert.deepEqual(expandTemplate({ type: "thirds" }, 6).phaser, { speedBpm: 120, phase: { from: 0, to: 240 }, repeat: { kind: "groups", count: 3 } });
  assert.deepEqual(expandTemplate({ type: "fill" }, 4).phaser.phase, { from: 0, to: 135 });
  assert.equal(expandTemplate({ type: "sparkle", seed: 9 }, 12).phaser.shuffle, 9);
  const long = expandTemplate({ type: "runner" }, 300);
  assert.ok(long.steps.every((s) => (s.width ?? 0) <= 3200), "widths stay within the console's 3200 % on long rows");
  assert.deepEqual(expandTemplate({ type: "comet", tail: 4 }, 40).steps.map((s) => s.width), [355.6, 3200], "scaled and kept to 0.1 % (live: 3600 read back as 3200)");
  assert.throws(() => parseStep("s", { values: { Dimmer: 1 }, width: 3600 }, "percent"), /<= 3200/);
  assert.throws(() => expandTemplate({ type: "comet", tail: 5 }, 5), /tail must be shorter/);
  assert.throws(() => expandTemplate({ type: "runner" }, 1), /at least two/);
});

test("SU-13 variants: sync without a spread, follow with it, mirror with wings 2 and Pan inverted", () => {
  const pt = expandTemplate({ type: "circle", size: 20 }, 0);
  assert.equal(variantOf(pt, "sync").phaser.phaseSpread, undefined);
  assert.equal(variantOf(pt, "follow").phaser.phaseSpread, true);
  const m = variantOf(pt, "mirror");
  assert.deepEqual(m.phaser.repeat, { kind: "wings", count: 2 });
  assert.deepEqual(m.mirror, { attributes: ["Pan"], wings: 2 });
  const chase: Effect = { unit: "percent", steps: [{ values: { Dimmer: { absolute: 100 } } }, { values: { Dimmer: { absolute: 0 } } }], phaser: { phase: { from: 0, to: 90 } } };
  assert.equal(variantOf(chase, "mirror").mirror, undefined, "no Pan, no mirror attributes given: only the mirrored spread");
  assert.deepEqual(variantOf(chase, "follow").phaser.phase, { from: 0, to: 90 }, "follow keeps the request's phase");
});

test("SU-13 tool: variants go into consecutive presets with names, built in one Preview session", async () => {
  const { result, isError } = await build({ preset: "23.5", name: "Chase", fixtures: [401, 402], steps: [{ values: { Dimmer: 100 }, transition: 0 }, { values: { Dimmer: 0 }, transition: 0 }], variants: ["sync", "follow", "mirror"], phaser: { speed_bpm: 120 } });
  assert.equal(isError, false, JSON.stringify(result, null, 2).slice(0, 3000));
  assert.deepEqual(result.items.map((i: any) => `${i.target}:${i.outcome}:${i.verification}`), ['Preset 23.5 (sync) "Chase sync":succeeded:matched', 'Preset 23.6 (follow) "Chase follow":succeeded:matched', 'Preset 23.7 (mirror) "Chase mirror":succeeded:matched']);
  assert.deepEqual([...con.names], [["23.5", "Chase sync"], ["23.6", "Chase follow"], ["23.7", "Chase mirror"]]);
  assert.equal(result.items[0].phases, undefined, "sync has no phase spread");
  assert.deepEqual(result.items[1].phases, { fixtures: 2, first: "401", last: "402", first_phase: 0, step: 180 });
  assert.equal(con.commands.filter((c) => c === "Preview On").length, 1, "one Preview session");
  assert.equal(con.commands.filter((c) => c === "ClearAll").length, 3, "cleared between presets and at the end");
  assert.equal(con.env, "Normal");
  assert.equal(result.normalProgrammerUntouched, true);
});

test("SU-13 tool: mirror inverts the chosen attribute on the second half; a whole rig over 128 fixtures in one call", async () => {
  const mir = await build({ preset: "23.8", fixtures: [401, 402], steps: [{ values: { Dimmer: 100 }, transition: 0 }, { values: { Dimmer: 20 }, transition: 0 }], mirror: { attributes: ["Dimmer"] } });
  assert.equal(mir.isError, false, JSON.stringify(mir.result).slice(0, 2000));
  const stored = con.presets.get("23.8") as Array<{ fid: string; steps: Array<{ absolute: number }> }>;
  assert.deepEqual(stored.map((r) => [r.fid, r.steps.map((x) => x.absolute)]), [["401", [100, 20]], ["402", [0, 80]]]);
  assert.equal(mir.result.plan.perFixtureValues, 2);

  for (let i = 1; i <= 132; i++) con.fixtures[String(2000 + i)] = { sf: 1000 + i, attrs: ["Dimmer"] };
  const rig = await build({ preset: "23.9", fixtures: ["2001 Thru 2132"], steps: [{ values: { Dimmer: 100 }, transition: 0 }, { values: { Dimmer: 0 }, transition: 0 }], phaser: { phase: { step: 180 } } });
  assert.equal(rig.isError, false, JSON.stringify(rig.result).slice(0, 2000));
  assert.deepEqual(rig.result.phases, { fixtures: 132, first: "2001", last: "2132", first_phase: 0, step: 180 });
  assert.equal(rig.result.plan.distribution.phase.to, 23580);
  assert.ok(JSON.stringify(rig.result).length < 6000, `a whole-rig result is compact by default (${JSON.stringify(rig.result).length} bytes)`);
  assert.deepEqual(rig.result.steps, [], "only steps that did not succeed are listed");
  assert.ok(rig.result.plan.commandCount > 0 && rig.result.plan.commands === undefined, "the command count instead of the commands");
});

test("SU-13 tool: several effects in one call; one refused does not stop the rest; duplicates and audition are refused", async () => {
  con.presets.set("23.11", []);
  const { result, isError } = await build({
    effects: [
      { preset: "23.10", fixtures: [401, 402], template: { type: "alternate" } },
      { preset: "23.11", fixtures: [401], template: { type: "dimmer_chase" } },
      { preset: "23.12", fixtures: [401, 402], template: { type: "runner" } },
    ],
  });
  // 23.11 exists: the inspection refuses the whole call before anything is sent.
  assert.equal(isError, true);
  assert.match(errorOf(result, "preset 23.11: read_context"), /already exists/);
  assert.deepEqual(con.commands, []);
  con.presets.delete("23.11");
  const ok = await build({ effects: [{ preset: "23.10", fixtures: [401, 402], template: { type: "alternate" } }, { preset: "23.12", fixtures: [401, 402], template: { type: "runner" } }] });
  assert.equal(ok.isError, false, JSON.stringify(ok.result).slice(0, 2000));
  assert.deepEqual(ok.result.items.map((i: any) => i.outcome), ["succeeded", "succeeded"]);
  assert.ok(ok.result.steps.every((s: any) => !s.name.startsWith("preset ")), "compact: only the shared steps");
  for (const [args, re] of [
    [{ effects: [{ preset: "23.1", fixtures: [401], template: { type: "dimmer_chase" } }, { preset: "23.1", fixtures: [402], template: { type: "dimmer_chase" } }] }, /presets built twice in one call: Preset 23\.1/],
    [{ preset: "23.1", fixtures: [401, 402], template: { type: "dimmer_chase" }, variants: ["sync", "follow"], audition_ms: 100 }, /audition_ms plays one effect/],
    [{ preset: "23.1", effects: [{ preset: "23.2", fixtures: [401], template: { type: "dimmer_chase" } }] }, /with effects, give preset in each effect/],
    [{ preset: "23.1", fixtures: [401, 402], template: { type: "runner" }, mirror: { attributes: ["Pan"] } }, /does not write Pan/],
  ] as const) {
    const r = await build(args as Record<string, unknown>);
    assert.match((r.result.validationErrors ?? []).join(" "), re, JSON.stringify(r.result).slice(0, 500));
  }
});

test("SU-13 tool: a store whose name write got no reply stops the build; the next variant is not stored", async () => {
  con.silentNameSet = true;
  const { result } = await build({ preset: "23.20", name: "Chase", fixtures: [401, 402], steps: [{ values: { Dimmer: 100 }, transition: 0 }, { values: { Dimmer: 0 }, transition: 0 }], variants: ["sync", "follow"] });
  assert.deepEqual(result.items.map((i: any) => i.outcome), ["partial", "not_attempted"], JSON.stringify(result.items).slice(0, 1500));
  // Review round 1: a stored preset is persistent work, and the unanswered step stays visible in the compact result.
  assert.equal(result.outcome, "partial");
  assert.equal(result.items[0].uncertain, true);
  assert.ok(result.items[0].steps.some((st: any) => st.status === "unknown"), JSON.stringify(result.items[0]));
  assert.match(result.summary, /a step got no reply/);
  assert.equal(con.presets.has("23.20"), true);
  assert.equal(con.presets.has("23.21"), false, "nothing more is stored after an uncertain step");
  assert.equal(con.env, "Normal", "Preview is still left");
});

test("SU-13 review round 1: with shuffle every attribute's phases are checked and a fixture's attributes share one phase", () => {
  const e: Effect = { unit: "percent", steps: [{ values: { Dimmer: { absolute: 100 }, ColorRGB_R: { absolute: 100 } } }, { values: { Dimmer: { absolute: 0 }, ColorRGB_R: { absolute: 0 } } }], phaser: { phase: { from: 0, to: 180 }, shuffle: 7 } };
  const row = (sf: number, attribute: string, pos: number, phase: number) => ({ subfixtureIndex: sf, attribute, stepCount: 2, steps: [{ absolute: 100 }, { absolute: 0 }], phaser: { gridPos: pos, phase } });
  const scope = new Map([[1, "1"], [2, "2"]]);
  const good = [row(1, "Dimmer", 0, 180), row(1, "ColorRGB_R", 0, 180), row(2, "Dimmer", 1, 0), row(2, "ColorRGB_R", 1, 0)];
  assert.deepEqual(verifyBuild({ effect: e, rows: good, scope, implied: new Set(), stepPresets: [] }).problems, []);
  // The reviewer's case: Dimmer 0/180 but ColorRGB_R 90/90 was reported as matched.
  const bad = [row(1, "Dimmer", 0, 0), row(1, "ColorRGB_R", 0, 90), row(2, "Dimmer", 1, 180), row(2, "ColorRGB_R", 1, 90)];
  const problems = verifyBuild({ effect: e, rows: bad, scope, implied: new Set(), stepPresets: [] }).problems.join(" | ");
  assert.match(problems, /1: its attributes are out of phase \(Dimmer 0, ColorRGB_R 90\)/);
  assert.match(problems, /2: its attributes are out of phase \(Dimmer 180, ColorRGB_R 90\)/);
  // Every attribute in step but the distribution wrong over the fixtures: the full-set check.
  const allWrong = [row(1, "Dimmer", 0, 90), row(1, "ColorRGB_R", 0, 90), row(2, "Dimmer", 1, 90), row(2, "ColorRGB_R", 1, 90)];
  assert.match(verifyBuild({ effect: e, rows: allWrong, scope, implied: new Set(), stepPresets: [] }).problems.join(), /shuffled phases: expected the set 0, 180 over the fixtures, read 90, 90/);
});

test("SU-13 review round 2: a channel only part of a mixed rig has (RGBW's W) follows its fixture's shuffled phase", () => {
  // One RGB and one RGBW fixture; ColorRGB_R explicit, ColorRGB_W an activated sibling on the RGBW fixture only.
  const e: Effect = { unit: "percent", steps: [{ values: { ColorRGB_R: { absolute: 100 } } }, { values: { ColorRGB_R: { absolute: 0 } } }], phaser: { phase: { from: 0, to: 180 }, shuffle: 7 } };
  const row = (sf: number, attribute: string, pos: number, phase: number) => ({ subfixtureIndex: sf, attribute, stepCount: 2, steps: [{ absolute: attribute === "ColorRGB_R" ? 100 : 0 }, { absolute: 0 }], phaser: { gridPos: pos, phase } });
  const scope = new Map([[1, "rgb"], [2, "rgbw"]]);
  // Shuffle gave the RGB fixture 180 and the RGBW fixture 0; W reads 0 with its fixture's R: valid.
  const valid = [row(1, "ColorRGB_R", 0, 180), row(2, "ColorRGB_R", 1, 0), row(2, "ColorRGB_W", 1, 0)];
  assert.deepEqual(verifyBuild({ effect: e, rows: valid, scope, implied: new Set(["ColorRGB_W"]), stepPresets: [] }).problems, []);
  // W out of step with its own fixture is still caught.
  const off = [row(1, "ColorRGB_R", 0, 180), row(2, "ColorRGB_R", 1, 0), row(2, "ColorRGB_W", 1, 180)];
  assert.match(verifyBuild({ effect: e, rows: off, scope, implied: new Set(["ColorRGB_W"]), stepPresets: [] }).problems.join(), /rgbw: its attributes are out of phase \(ColorRGB_R 0, ColorRGB_W 180\)/);
});

test("SU-13 review round 1: presets stored with a rejected name write are partial work, so the call is partial, not failed", async () => {
  con.rejectNameSet = true;
  const { result } = await build({ effects: [{ preset: "23.30", name: "A", fixtures: [401, 402], template: { type: "alternate" } }, { preset: "23.31", name: "B", fixtures: [401, 402], template: { type: "runner" } }] });
  assert.deepEqual(result.items.map((i: any) => i.outcome), ["partial", "partial"], JSON.stringify(result.items).slice(0, 1500));
  assert.equal(result.outcome, "partial");
  assert.equal(con.presets.has("23.30") && con.presets.has("23.31"), true, "both presets exist");
  assert.match(result.summary, /2 stored with a later step that did not succeed/);
  assert.ok(result.items[0].steps.some((st: any) => st.status === "failed"), "the failed name step is listed in the compact line");
});

test("SU-13 review round 3: with shuffle a participating channel without a phase read is a problem, never left out", () => {
  const e: Effect = { unit: "percent", steps: [{ values: { Dimmer: { absolute: 100 }, ColorRGB_R: { absolute: 100 } } }, { values: { Dimmer: { absolute: 0 }, ColorRGB_R: { absolute: 0 } } }], phaser: { phase: { from: 0, to: 180 }, shuffle: 7 } };
  const row = (sf: number, attribute: string, pos: number, phase: number | null | undefined) => ({ subfixtureIndex: sf, attribute, stepCount: 2, steps: [{ absolute: 100 }, { absolute: 0 }], phaser: { gridPos: pos, ...(phase === undefined ? {} : { phase }) } });
  const scope = new Map([[1, "1"], [2, "2"]]);
  // The reviewer's case: Dimmer 0/180, both ColorRGB_R rows without a phase field.
  const missing = [row(1, "Dimmer", 0, 0), row(1, "ColorRGB_R", 0, undefined), row(2, "Dimmer", 1, 180), row(2, "ColorRGB_R", 1, undefined)];
  const p1 = verifyBuild({ effect: e, rows: missing as never, scope, implied: new Set(), stepPresets: [] }).problems.join(" | ");
  assert.match(p1, /1 ColorRGB_R: no phase read/);
  assert.match(p1, /2 ColorRGB_R: no phase read/);
  // A null phase is not a phase either; a numeric mismatch is still out of phase.
  const nul = [row(1, "Dimmer", 0, 0), row(1, "ColorRGB_R", 0, null), row(2, "Dimmer", 1, 180), row(2, "ColorRGB_R", 1, 270)];
  const p2 = verifyBuild({ effect: e, rows: nul as never, scope, implied: new Set(), stepPresets: [] }).problems.join(" | ");
  assert.match(p2, /1 ColorRGB_R: no phase read/);
  assert.match(p2, /2: its attributes are out of phase \(Dimmer 180, ColorRGB_R 270\)/);
});
