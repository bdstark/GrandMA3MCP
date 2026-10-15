import { test } from "node:test";
import assert from "node:assert/strict";
import { registerCueListTools, expectedOrder, judgeCycle, planObservation } from "../src/tools/cuelists.ts";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";

/**
 * SU-06: gma3_store_cues, gma3_edit_cues, gma3_build_chase against a stateful fake console that behaves as onPC
 * 2.5.1 did in docs/probes/su-06-cuelists-macos-2.5.1.md:
 *   - Preview On / Off switch between two environments, each with its own programmer and selection; Store stores the
 *     current environment's programmer, which keeps its values after the store.
 *   - `At Preset` links the channels to the preset (abs_preset); a cue stored without a name takes "[pool.no]".
 *   - Name on Part 0 names the cue; TrigType/TrigTime on the cue; WrapAround on the sequence.
 *   - Goto starts the sequence at a cue; Time triggers advance it every TrigTime / rate; with WrapAround the last
 *     cue is followed by cue 1; CurrentCue keeps the last cue after Off.
 */

type Env = "Normal" | "Preview";
interface Value {
  value: number;
  preset?: string;
}
interface Cue {
  no: number;
  name: string;
  trigType: string;
  trigTime: number;
  part0: Record<string, string>;
  /** fid -> attribute -> value, what was stored. */
  data: Record<string, Record<string, number>>;
}
interface Seq {
  name: string;
  wrap: boolean;
  cues: Cue[];
}

class Console {
  fixtures: Record<string, string[]> = {
    "101": ["Dimmer", "ColorRGB_R", "ColorRGB_G", "ColorRGB_B"],
    "102": ["Dimmer", "ColorRGB_R", "ColorRGB_G", "ColorRGB_B"],
    "301": ["Dimmer", "Pan", "Tilt"],
  };
  presets: Record<string, { name: string; values: Record<string, number> }> = {
    "4.1": { name: "Red", values: { ColorRGB_R: 100, ColorRGB_G: 0, ColorRGB_B: 0 } },
    "4.2": { name: "Green", values: { ColorRGB_R: 0, ColorRGB_G: 100, ColorRGB_B: 0 } },
    "4.3": { name: "Blue", values: { ColorRGB_R: 0, ColorRGB_G: 0, ColorRGB_B: 100 } },
  };
  env: Env = "Normal";
  selected: Record<Env, Set<string>> = { Normal: new Set(), Preview: new Set() };
  prog: Record<Env, Map<string, Map<string, Value>>> = { Normal: new Map(), Preview: new Map() };
  seqs = new Map<number, Seq>();
  rateFader = 50;
  /** The console ignores WrapAround (a chase that stops at its last cue). */
  ignoreWrap = false;
  /** Something changes the Normal programmer while the build runs. */
  normalChangesOnStore = false;
  /** The programmer op's scan of the Preview programmer is incomplete (coverage.complete false, no total). */
  previewIncomplete = false;
  /** Commands the console rejects (and does not perform). */
  reject?: RegExp;
  playing: { seq: number; start: number; t0: number } | null = null;
  current = new Map<number, number>();
  commands: string[] = [];

  set(fid: string, attr: string, v: Value) {
    const p = this.prog[this.env];
    if (!p.has(fid)) p.set(fid, new Map());
    p.get(fid)!.set(attr, v);
  }
  cue(s: number, no: number): Cue | undefined {
    return this.seqs.get(s)?.cues.find((c) => c.no === no);
  }
  addCue(s: number, no: number, data: Cue["data"] = {}) {
    if (!this.seqs.has(s)) this.seqs.set(s, { name: `Sequence ${s}`, wrap: true, cues: [] });
    const seq = this.seqs.get(s)!;
    const c: Cue = { no, name: "", trigType: "Go", trigTime: 0, part0: { CueInFade: "0.00", CueInDelay: "0.00", CueOutFade: "CueTiming", CueOutDelay: "CueTiming", SnapDelay: "0.00" }, data };
    seq.cues = [...seq.cues.filter((x) => x.no !== no), c].sort((a, b) => a.no - b.no);
    return c;
  }

  apply(cmd: string): string {
    this.commands.push(`${this.env === "Preview" ? "[P] " : ""}${cmd}`);
    if (this.reject?.test(cmd)) return "Illegal Command";
    let m: RegExpMatchArray | null;
    const sel = this.selected[this.env];
    if (cmd === "Preview On") this.env = "Preview";
    else if (cmd === "Preview Off") this.env = "Normal";
    else if (cmd === "ClearSelection") sel.clear();
    else if (cmd === "ClearAll") {
      sel.clear();
      this.prog[this.env].clear();
    } else if ((m = cmd.match(/^Fixture (.+)$/))) {
      for (const part of m[1].split("+").map((x) => x.trim())) {
        const r = part.match(/^(\d+) Thru (\d+)$/);
        for (const id of r ? Object.keys(this.fixtures).filter((f) => +f >= +r[1] && +f <= +r[2]) : [part]) if (this.fixtures[id]) sel.add(id);
      }
    } else if ((m = cmd.match(/^At ([\d.]+)$/))) {
      for (const f of sel) if (this.fixtures[f].includes("Dimmer")) this.set(f, "Dimmer", { value: +m[1] });
    } else if ((m = cmd.match(/^Attribute "(.+)" At Absolute(?: Percent)? (-?[\d.]+)$/))) {
      for (const f of sel) if (this.fixtures[f].includes(m[1])) this.set(f, m[1], { value: +m[2] });
    } else if ((m = cmd.match(/^At Preset (\d+)\.(\d+)$/))) {
      const key = `${m[1]}.${m[2]}`;
      const p = this.presets[key];
      if (p) for (const f of sel) for (const [a, v] of Object.entries(p.values)) if (this.fixtures[f].includes(a)) this.set(f, a, { value: v, preset: key });
    } else if ((m = cmd.match(/^Store Sequence (\d+) Cue ([\d.]+)(?: \/(Merge|Overwrite))? \/NoConfirmation$/))) {
      const data: Cue["data"] = {};
      let preset: string | undefined;
      for (const [f, attrs] of this.prog[this.env]) for (const [a, v] of attrs) ((data[f] ??= {})[a] = v.value), (preset ??= v.preset);
      const c = this.addCue(+m[1], +m[2], data);
      c.name = preset ? `[${preset}]` : `Cue ${m[2]}`;
      if (this.normalChangesOnStore) this.prog.Normal.set("301", new Map([["Dimmer", { value: 1 }]]));
    } else if ((m = cmd.match(/^Goto Sequence (\d+) Cue ([\d.]+)$/))) {
      const seq = this.seqs.get(+m[1]);
      const idx = seq?.cues.findIndex((c) => c.no === +m[2]) ?? -1;
      if (seq && idx >= 0) this.playing = { seq: +m[1], start: idx, t0: Date.now() };
    } else if ((m = cmd.match(/^Off Sequence (\d+)$/))) {
      if (this.playing?.seq === +m[1]) {
        this.current.set(+m[1], this.currentIndex(+m[1]) ?? 0);
        this.playing = null;
      }
    }
    return "OK";
  }

  /** The playing cue index: Time triggers every TrigTime / rate from the start cue. */
  currentIndex(s: number): number | undefined {
    const seq = this.seqs.get(s);
    if (!seq) return undefined;
    if (!this.playing || this.playing.seq !== s) return this.current.get(s);
    const rate = (225 * Math.pow(this.rateFader / 100, Math.log2(3.75))) / 60;
    const stepMs = (seq.cues[0].trigTime * 1000) / rate;
    const steps = Math.floor((Date.now() - this.playing.t0) / stepMs);
    const idx = this.playing.start + steps;
    return seq.wrap && !this.ignoreWrap ? idx % seq.cues.length : Math.min(idx, seq.cues.length - 1);
  }

  programmer(args: Record<string, unknown>) {
    const scope = String(args.scope);
    const p = this.prog[this.env];
    const fids = scope === "selection" ? [...this.selected[this.env]] : scope === "fixtures" ? [String(args.fixtures).replace(/^Fixture /, "")] : [...new Set([...Object.keys(this.fixtures).filter((f) => p.has(f))])];
    const rows = fids.flatMap((fid) =>
      [...(p.get(fid) ?? new Map<string, Value>()).entries()].map(([attribute, v]) => ({
        fixture: `Fx ${fid}`,
        fid,
        subfixtureIndex: +fid,
        attribute,
        value: v.value,
        stepCount: 1,
        physicalFrom: 0,
        physicalTo: 1,
        readout: "Percent",
        absPreset: v.preset ? { name: this.presets[v.preset].name, addrNative: `ShowData.DataPools.Default.PresetPools.Color.${this.presets[v.preset].name}` } : null,
      })),
    );
    const limit = typeof args.limit === "number" ? args.limit : 500;
    if (this.env === "Preview" && this.previewIncomplete) return { scope, environment: this.env, coverage: { complete: false }, scannedFixtures: [], fixturesTruncated: false, rows: [], limitations: ["scan aborted"] };
    return {
      scope,
      environment: this.env,
      coverage: { complete: true, scannedFixtures: fids.length, totalFixtures: fids.length, scannedChannels: rows.length },
      scannedFixtures: fids.map((fid) => ({ subfixtureIndex: +fid, fid, name: `Fx ${fid}`, rootFid: fid, attributes: this.fixtures[fid] })),
      fixturesTruncated: false,
      total: rows.length,
      count: Math.min(rows.length, limit),
      offset: 0,
      rows: rows.slice(0, limit),
      limitations: [],
    };
  }

  objects(ref: string, fields: string[]) {
    const none = { total: 0, items: [] };
    let m: RegExpMatchArray | null;
    if ((m = ref.match(/^Sequence (\d+) Cue ([\d.]+)(?: Part 0)?$/))) {
      const c = this.cue(+m[1], +m[2]);
      if (!c) return none;
      const all: Record<string, unknown> = ref.endsWith("Part 0") ? { ...c.part0, Name: c.name } : { Name: c.name, TrigType: c.trigType, TrigTime: c.trigTime.toFixed(2), No: String(c.no) };
      return { total: 1, items: [{ name: c.name, class: ref.endsWith("Part 0") ? "Part" : "Cue", fields: Object.fromEntries(fields.map((f) => [f, all[f]])) }] };
    }
    if ((m = ref.match(/^Sequence (\d+)$/))) {
      const s = this.seqs.get(+m[1]);
      if (!s) return none;
      const idx = this.currentIndex(+m[1]);
      const all: Record<string, unknown> = { Name: s.name, WrapAround: s.wrap ? "Yes" : "No", RateMaster: "None", SpeedMaster: "None", RateScale: "One", SpeedScale: "One", SpeedFromRate: "No", CurrentCue: idx === undefined ? null : { addr: `seq.${m[1]}.cue.${s.cues[idx].no}`, name: s.cues[idx].name } };
      return { total: 1, items: [{ name: s.name, class: "Sequence", fields: Object.fromEntries(fields.map((f) => [f, all[f]])) }] };
    }
    if ((m = ref.match(/^Preset (\d+)\.(\d+)$/))) {
      const p = this.presets[`${m[1]}.${m[2]}`];
      return p ? { total: 1, items: [{ name: p.name, class: "Preset", addrNative: `ShowData.DataPools.Default.PresetPools.Color.${p.name}`, fields: { Name: p.name } }] } : none;
    }
    if ((m = ref.match(/^Attribute "(.+)"$/))) return Object.values(this.fixtures).some((a) => a.includes(m![1])) ? { total: 1, items: [{ name: m[1], class: "Attribute" }] } : none;
    const ids = ref.replace(/^Fixture /, "").split("+").map((x) => x.trim()).filter((x) => this.fixtures[x]);
    return ids.length ? { total: ids.length, items: ids.map((fid) => ({ name: `Fx ${fid}`, class: "Fixture", fields: { FID: fid } })) } : none;
  }

  install(h: Harness) {
    const f = h.fake;
    f.reset();
    f.onCommand((cmd) => this.apply(cmd));
    f.on("programmer", (args) => this.programmer(args));
    f.on("objects", (args) => this.objects(String(args.ref), Array.isArray(args.fields) ? (args.fields as string[]) : []));
    f.on("children", (args) => {
      if (args.ref === "ShowData.Masters.Speed") return { items: [] };
      const s = this.seqs.get(Number(String(args.ref).replace(/^Sequence /, "")));
      if (!s) throw new Error(`no objects found for '${args.ref}'`);
      return { items: s.cues.map((c) => ({ name: c.name, class: "Cue", addr: `seq.${String(args.ref).replace(/^Sequence /, "")}.cue.${c.no}`, fields: { No: c.no * 1000, Name: c.name } })) };
    });
    f.on("set", (args) => {
      const ref = String(args.ref);
      const prop = String(args.property);
      const value = String(args.value);
      let m: RegExpMatchArray | null;
      if ((m = ref.match(/^Sequence (\d+) Cue ([\d.]+) Part 0$/))) {
        const c = this.cue(+m[1], +m[2]);
        if (!c) throw new Error(`no object found for '${ref}'`);
        if (prop === "Name") c.name = value;
        else c.part0[prop] = Number(value).toFixed(2);
      } else if ((m = ref.match(/^Sequence (\d+) Cue ([\d.]+)$/))) {
        const c = this.cue(+m[1], +m[2]);
        if (!c) throw new Error(`no object found for '${ref}'`);
        if (prop === "TrigType") c.trigType = value;
        else if (prop === "TrigTime") c.trigTime = Number(value);
      } else if ((m = ref.match(/^Sequence (\d+)$/))) {
        const s = this.seqs.get(+m[1]);
        if (!s) throw new Error(`no object found for '${ref}'`);
        if (prop === "Name") s.name = value;
        if (prop === "WrapAround") s.wrap = value === "Yes";
      }
      return { ref, property: prop, value };
    });
    f.on("object", (args) => ({ name: String(args.ref), hasActivePlayback: this.playing?.seq === Number(String(args.ref).replace(/^Sequence /, "")) }));
    f.on("getfader", (args) => {
      if (String(args.ref).startsWith("Sequence ")) return { faders: { FaderRate: { value: this.rateFader, text: `${this.rateFader}%` } } };
      throw new Error("no such master");
    });
  }
}

async function setup() {
  const h = await startHarness(registerCueListTools);
  const c = new Console();
  c.install(h);
  // The operator's own work in the Normal programmer: it must survive every build.
  c.prog.Normal.set("301", new Map([["Dimmer", { value: 33 }]]));
  return { h, c };
}

/** Every step error of a result, for matching. */
const errors = (r: { result: any }): string => (r.result.steps ?? []).map((s: any) => s.error ?? "").join(" | ");

const normalUntouched = (c: Console) => {
  assert.equal(c.prog.Normal.get("301")?.get("Dimmer")?.value, 33, "the operator's Normal programmer value survives");
  assert.ok(!c.commands.includes("ClearAll"), "ClearAll is never sent in Normal");
  assert.equal(c.env, "Normal", "the console is back in Normal");
};

// ---------------------------------------------------------------------------
// gma3_store_cues
// ---------------------------------------------------------------------------

test("store_cues: three cues built in Preview, each from its looks, named, timed and triggered; Normal untouched", async () => {
  const { h, c } = await setup();
  try {
    const { result, isError } = await h.callJson("gma3_store_cues", {
      sequence: 951,
      sequence_name: "Looks",
      mode: "create",
      fixtures: "101 + 102",
      exclusive: true,
      cues: [
        { cue: 1, name: "Red full", presets: [{ pool: 4, preset: 1 }], intensity: 100, fade: 1 },
        { cue: 2, looks: [{ fixtures: "101", presets: [{ pool: 4, preset: 2 }] }, { fixtures: "102", intensity: 50, values: [{ attribute: "ColorRGB_B", value: 80, unit: "percent" }] }], trigger: "follow" },
        { cue: 3, presets: [{ pool: 4, preset: 3 }], trigger: "time", time: 2 },
      ],
    });
    assert.equal(isError, false, JSON.stringify(result, null, 2));
    assert.equal(result.verification.status, "matched");
    assert.deepEqual(result.cues.map((x: any) => [x.cue, x.status, x.verification.status]), [["1", "stored", "matched"], ["2", "stored", "matched"], ["3", "stored", "matched"]]);
    assert.equal(result.normalProgrammer, "untouched");
    normalUntouched(c);
    const seq = c.seqs.get(951)!;
    assert.equal(seq.name, "Looks");
    assert.deepEqual(seq.cues.map((x) => x.name), ["Red full", "[4.2]", "[4.3]"]);
    assert.deepEqual(seq.cues[0].data["102"], { ColorRGB_R: 100, ColorRGB_G: 0, ColorRGB_B: 0, Dimmer: 100 });
    assert.deepEqual(seq.cues[1].data, { "101": { ColorRGB_R: 0, ColorRGB_G: 100, ColorRGB_B: 0 }, "102": { Dimmer: 50, ColorRGB_B: 80 } }, "cue 2 holds only its own looks: the programmer was cleared after cue 1");
    assert.equal(seq.cues[0].part0.CueInFade, "1.00");
    assert.deepEqual([seq.cues[1].trigType, seq.cues[2].trigType, seq.cues[2].trigTime], ["Follow", "Time", 2]);
    assert.deepEqual(c.commands.slice(0, 6), ["Preview On", "[P] ClearSelection", "[P] Fixture 101 + 102", "[P] At Preset 4.1", "[P] At 100", "[P] Store Sequence 951 Cue 1 /NoConfirmation"]);
    assert.deepEqual(c.commands.slice(-2), ["[P] ClearAll", "[P] Preview Off"]);
  } finally {
    await h.close();
  }
});

test("store_cues: nothing is sent for an existing cue in create mode, a missing preset, an unknown attribute or a build started in Preview", async () => {
  const { h, c } = await setup();
  try {
    c.addCue(951, 2);
    let r = await h.callJson("gma3_store_cues", { sequence: 951, mode: "create", fixtures: "101", exclusive: true, cues: [{ cue: 1, intensity: 10 }, { cue: 2, intensity: 20 }] });
    assert.equal(r.result.outcome, "failed");
    assert.match(errors(r), /already has cue\(s\) 2/);
    r = await h.callJson("gma3_store_cues", { sequence: 952, mode: "create", fixtures: "101", exclusive: true, cues: [{ cue: 1, presets: [{ pool: 4, preset: 99 }] }] });
    assert.match(errors(r), /Preset 4\.99 does not exist/);
    r = await h.callJson("gma3_store_cues", { sequence: 952, mode: "create", fixtures: "101", exclusive: true, cues: [{ cue: 1, values: [{ attribute: "Gobo1", value: 10 }] }] });
    assert.match(errors(r), /attribute "Gobo1" is not defined/);
    assert.deepEqual(c.commands, [], "nothing was sent");
    c.env = "Preview";
    r = await h.callJson("gma3_store_cues", { sequence: 952, mode: "create", fixtures: "101", exclusive: true, cues: [{ cue: 1, intensity: 10 }] });
    assert.match(errors(r), /in the Preview environment; the cues are built in Preview and the build must start from Normal/);
    assert.deepEqual(c.commands, []);
    const v = await h.callJson("gma3_store_cues", { sequence: 952, mode: "create", fixtures: "101", cues: [{ cue: 1, intensity: 10 }] });
    assert.match(v.result.validationErrors.join(" "), /exclusive must be true/);
  } finally {
    await h.close();
  }
});

test("store_cues: a look that does not apply stops the batch before its cue is stored; earlier cues stay (partial)", async () => {
  const { h, c } = await setup();
  try {
    const { result, isError } = await h.callJson("gma3_store_cues", {
      sequence: 951,
      mode: "create",
      exclusive: true,
      cues: [
        { cue: 1, fixtures: "101", presets: [{ pool: 4, preset: 1 }] },
        { cue: 2, fixtures: "301", presets: [{ pool: 4, preset: 2 }] },
        { cue: 3, fixtures: "102", presets: [{ pool: 4, preset: 3 }] },
      ],
    });
    assert.equal(isError, true);
    assert.equal(result.outcome, "partial");
    assert.deepEqual(result.cues.map((x: any) => x.status), ["stored", "failed", "not_attempted"]);
    assert.match(result.cues[1].error, /Preset 4\.2 did not apply, so cue 2 was not stored/);
    assert.deepEqual(c.seqs.get(951)!.cues.map((x) => x.no), [1]);
    normalUntouched(c);
    assert.ok(!c.commands.some((x) => x.includes("Cue 2 ")), "cue 2 was never stored");
  } finally {
    await h.close();
  }
});

test("store_cues: a Preview programmer that is not empty is left alone (only Preview Off), and a Normal programmer changed during the build is a mismatch", async () => {
  const { h, c } = await setup();
  try {
    c.prog.Preview.set("102", new Map([["Dimmer", { value: 5 }]]));
    let r = await h.callJson("gma3_store_cues", { sequence: 951, mode: "create", fixtures: "101", exclusive: true, cues: [{ cue: 1, intensity: 10 }] });
    // Preview On succeeded before the check (a mutation, undone by Preview Off): partial, with nothing stored.
    assert.equal(r.result.outcome, "partial");
    assert.equal(r.result.stored, 0);
    assert.match(errors(r), /the Preview programmer is not empty \(1 value\(s\)\); nothing was built/);
    assert.deepEqual(c.commands, ["Preview On", "[P] Preview Off"]);
    assert.equal(c.prog.Preview.get("102")?.get("Dimmer")?.value, 5);

    c.prog.Preview.clear();
    c.normalChangesOnStore = true;
    r = await h.callJson("gma3_store_cues", { sequence: 951, mode: "create", fixtures: "101", exclusive: true, cues: [{ cue: 1, intensity: 10 }] });
    assert.equal(r.result.normalProgrammer, "changed");
    assert.equal(r.result.verification.status, "mismatched");
    assert.match(r.result.verification.detail, /the Normal programmer changed during the build/);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// gma3_edit_cues
// ---------------------------------------------------------------------------

test("edit_cues: trigger, timing and names on a range, read back per cue; refusals send nothing", async () => {
  const { h, c } = await setup();
  try {
    for (const n of [1, 2, 3, 4]) c.addCue(960, n);
    const { result, isError } = await h.callJson("gma3_edit_cues", { sequence: 960, from: 2, to: 3, trigger: "time", time: 4, fade: 0.5, names: ["Two", "Three"] });
    assert.equal(isError, false, JSON.stringify(result, null, 2));
    assert.equal(result.verification.status, "matched");
    assert.deepEqual(result.cues.map((x: any) => [x.cue, x.name]), [["2", "Two"], ["3", "Three"]]);
    assert.deepEqual(c.seqs.get(960)!.cues.map((x) => [x.no, x.trigType, x.part0.CueInFade]), [[1, "Go", "0.00"], [2, "Time", "0.50"], [3, "Time", "0.50"], [4, "Go", "0.00"]]);

    let r = await h.callJson("gma3_edit_cues", { sequence: 960, all: true, names: ["a", "b"] });
    assert.match(errors(r), /2 name\(s\) for 4 cue\(s\)/);
    r = await h.callJson("gma3_edit_cues", { sequence: 960, cues: [1, 7], trigger: "go" });
    assert.match(errors(r), /cue\(s\) 7 do not exist/);
    r = await h.callJson("gma3_edit_cues", { sequence: 960, cues: [1], from: 1, trigger: "go" });
    assert.match(r.result.validationErrors.join(" "), /exactly one of cues/);
    r = await h.callJson("gma3_edit_cues", { sequence: 960, all: true, trigger: "time" });
    assert.match(r.result.validationErrors.join(" "), /time \(seconds\) is required/);
    assert.deepEqual(c.seqs.get(960)!.cues.map((x) => x.name), ["", "Two", "Three", ""]);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// gma3_build_chase
// ---------------------------------------------------------------------------

test("build_chase: one cue per preset, every cue Time-triggered, Wrap Around on, one cycle observed through the wrap, then off", async () => {
  const { h, c } = await setup();
  try {
    const { result, isError } = await h.callJson("gma3_build_chase", { sequence: 970, name: "Colours", fixtures: "101 + 102", presets: [{ pool: 4, preset: 1 }, { pool: 4, preset: 2 }, { pool: 4, preset: 3 }], step_seconds: 0.25, exclusive: true });
    assert.equal(isError, false, JSON.stringify(result, null, 2));
    assert.equal(result.verification.status, "matched");
    const seq = c.seqs.get(970)!;
    assert.equal(seq.name, "Colours");
    assert.equal(seq.wrap, true);
    assert.deepEqual(seq.cues.map((x) => [x.no, x.trigType, x.trigTime]), [[1, "Time", 0.25], [2, "Time", 0.25], [3, "Time", 0.25]]);
    assert.equal(result.cycle.mode, "full");
    assert.deepEqual(result.cycle.expected, [1, 2, 3, 1, 2]);
    assert.deepEqual(result.cycle.observed.map((o: any) => o.cue), [1, 2, 3, 1, 2]);
    assert.equal(c.playing, null, "switched off afterwards");
    assert.deepEqual(c.commands.slice(-2), ["Goto Sequence 970 Cue 1", "Off Sequence 970"]);
    normalUntouched(c);
  } finally {
    await h.close();
  }
});

test("build_chase: a chase that stops at its last cue is a mismatch; a sequence with cues is refused; cycle_seconds divides the loop", async () => {
  const { h, c } = await setup();
  try {
    c.ignoreWrap = true;
    const { result, isError } = await h.callJson("gma3_build_chase", { sequence: 971, fixtures: "101", presets: [{ pool: 4, preset: 1 }, { pool: 4, preset: 2 }], cycle_seconds: 0.5, exclusive: true });
    assert.equal(isError, true);
    assert.equal(result.verification.status, "mismatched");
    assert.match(result.verification.detail, /expected cue 1 next \(after cue 2\)/);
    assert.equal(result.stepSeconds, 0.25);

    const r = await h.callJson("gma3_build_chase", { sequence: 971, fixtures: "101", presets: [{ pool: 4, preset: 1 }, { pool: 4, preset: 2 }], step_seconds: 1, exclusive: true });
    assert.equal(r.result.outcome, "failed");
    assert.match(errors(r), /already has 2 cue\(s\); a chase is built into an empty or new sequence/);
  } finally {
    await h.close();
  }
});

test("build_chase: a sequence running at another rate is judged against step / rate", async () => {
  const { h, c } = await setup();
  try {
    c.rateFader = 100 * Math.pow(120 / 225, 1 / Math.log2(3.75)); // 120 BPM: rate 2
    const { result } = await h.callJson("gma3_build_chase", { sequence: 972, fixtures: "101", presets: [{ pool: 4, preset: 1 }, { pool: 4, preset: 2 }], step_seconds: 0.5, exclusive: true });
    assert.equal(result.verification.status, "matched", JSON.stringify(result.cycle, null, 2));
    assert.ok(result.cycle.predictedStepMs < 300, `predicted ${result.cycle.predictedStepMs}`);
    assert.match(result.cycle.notes.join(" "), /runs at rate (2|1\.999)/);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Observation planning (pure)
// ---------------------------------------------------------------------------

test("planObservation: the full cycle when it fits, otherwise the tail through the wrap", () => {
  assert.deepEqual(planObservation(3, 1000, 45000), { mode: "full", start: 0, transitions: 4 });
  assert.deepEqual(planObservation(12, 7000, 45000), { mode: "tail", start: 8, transitions: 5 });
  assert.deepEqual(expectedOrder([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 8, 5), [9, 10, 11, 12, 1, 2]);
  assert.equal(planObservation(4, 30000, 45000), null);
  assert.deepEqual(judgeCycle([1, 2, 1], [{ ms: 0, cue: 1 }, { ms: 1000, cue: 2 }, { ms: 2600, cue: 1 }], 1000, 200), ["the step to cue 1 took 1600 ms, expected 1000 ms (± 200 ms)"]);
  assert.match(judgeCycle([1, 2, 3], [{ ms: 0, cue: 1 }, { ms: 1000, cue: 3 }], null, null)[0], /expected cue 2 as change 2, saw cue 3/);
});

// ---------------------------------------------------------------------------
// Review round 1 (PR #51 at e2c8306)
// ---------------------------------------------------------------------------

test("store_cues: an incomplete Preview scan is not an empty Preview programmer: nothing is built and nothing in Preview is cleared", async () => {
  const { h, c } = await setup();
  try {
    c.prog.Preview.set("102", new Map([["Dimmer", { value: 5 }]]));
    c.previewIncomplete = true;
    const { result } = await h.callJson("gma3_store_cues", { sequence: 951, mode: "create", fixtures: "101", exclusive: true, verify: false, cues: [{ cue: 1, intensity: 10 }] });
    assert.equal(result.stored, 0);
    assert.match(result.steps.map((x: any) => x.error ?? "").join(" | "), /could not be read completely, so it is not known to be empty; nothing was built/);
    assert.ok(!c.commands.includes("[P] ClearAll"), "ClearAll is never sent in Preview");
    assert.equal(c.prog.Preview.get("102")?.get("Dimmer")?.value, 5, "the existing Preview value survives");
    assert.equal(c.env, "Normal");
  } finally {
    await h.close();
  }
});

test("store_cues: a later preset in a look that takes over an earlier one's channels is the recall order asked for, not a mismatch", async () => {
  const { h, c } = await setup();
  try {
    const { result, isError } = await h.callJson("gma3_store_cues", { sequence: 951, mode: "create", exclusive: true, cues: [{ cue: 1, fixtures: "101", presets: [{ pool: 4, preset: 1 }, { pool: 4, preset: 2 }] }] });
    assert.equal(isError, false, JSON.stringify(result, null, 2));
    assert.equal(result.verification.status, "matched");
    assert.deepEqual(c.seqs.get(951)!.cues[0].data["101"], { ColorRGB_R: 0, ColorRGB_G: 100, ColorRGB_B: 0 }, "the later preset wins");
  } finally {
    await h.close();
  }
});

test("build_chase: when Preview Off fails, nothing more is sent: no Wrap Around, no playback", async () => {
  const { h, c } = await setup();
  try {
    c.reject = /^Preview Off$/;
    const { result, isError } = await h.callJson("gma3_build_chase", { sequence: 973, fixtures: "101", presets: [{ pool: 4, preset: 1 }, { pool: 4, preset: 2 }], step_seconds: 0.25, exclusive: true });
    assert.equal(isError, true);
    assert.equal(result.cycle.watched, false);
    assert.match(result.cycle.reason, /not confirmed back in the Normal environment/);
    assert.ok(!c.commands.some((x) => x.includes("Goto")), "the chase was not played");
    assert.ok(!result.steps.some((x: any) => x.name === "wrap_around"), "Wrap Around was not set");
    assert.equal(c.playing, null);
  } finally {
    await h.close();
  }
});
