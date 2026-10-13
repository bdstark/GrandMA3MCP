import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { registerPhaserTools, parseStep, parsePhaser, expandTemplate, effectCommands, expectedPhase, verifyBuild, fingerprint, type Effect } from "../src/tools/phasers.ts";
import type { ProgrammerRow } from "../src/tools/presets.ts";
import { ValidationError } from "../src/validate.ts";

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
  assert.match(p(ok.slice(0, 3)), /404 Dimmer: no programmer value/);
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

  install(h: Harness): void {
    h.fake.on("preset.context", () => ({ preferences: { StoreLook: "No", PresetInputFilter: "Yes", StoreMode: "Ask" }, preferencesReadable: true, pool: { no: 23, exists: true, name: "All 3", presetMode: "Selective" } }));
    h.fake.on("preset.read", (args) => {
      const key = String(args.ref).replace("Preset ", "");
      if (key === "4.4") return { ref: args.ref, addrNative: "P.4.4", rows: [], dependencies: [] };
      const stored = this.presets.get(key) as Row[] | undefined;
      if (!stored) throw new Error(`no object found for '${args.ref}'`);
      const types: Record<string, string> = {};
      for (const sf of (args.typesFor as number[]) ?? []) types[String(sf)] = "T";
      return { ref: args.ref, no: 1, name: "x", pool: { no: 23 }, presetMode: "Selective", storedData: "Selective", lock: "", dependencies: [], dependenciesReadable: true, types,
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
      if ((m = c.match(/^Store Preset (\d+\.\d+) /))) { this.presets.set(m[1], this.prog().map((r) => ({ ...r }))); for (const r of this.prog()) r.stepCount = 0; return { feedback: "OK" }; }
      if (/^Grid /.test(c) || /MAtricks/.test(c)) return { feedback: "OK" };
      if (c === "Preview On") { this.env = "Preview"; this.selection = []; return { feedback: "OK" }; }
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
        for (const r of this.prog()) { const k = this.selection.indexOf(r.subfixtureIndex); r.phaser!.phase = n > 1 ? from + ((to - from) * k) / (n - 1) : from; }
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
