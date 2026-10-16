import { test } from "node:test";
import assert from "node:assert/strict";
import { registerCueListTools, expectedOrder, judgeCycle, planObservation } from "../src/tools/cuelists.ts";
import { SILENT } from "./helpers/fake-bridge.ts";
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
  /** SU-14: a phaser's step values (step 1 first), and its layers. */
  steps?: number[];
  phase?: number;
  speed?: number;
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
  /** Other sequence properties (SU-14: Note, Priority, OffWhenOverridden, ...). */
  props?: Record<string, string>;
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
  /** set requests ("<ref> <Property>") that never get a reply, are refused, or are accepted and ignored. */
  silentSet?: RegExp;
  rejectSet?: RegExp;
  ignoreSet?: RegExp;
  playing: { seq: number; start: number; t0: number } | null = null;
  /** Sequences reported as playing (SU-14 override checks), besides the chase being watched. */
  running = new Set<number>();
  /** The programmer's current step (Step N). */
  step = 1;
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
    const c: Cue = { no, name: "", trigType: "Go", trigTime: 0, part0: { CueInFade: "0.00", CueInDelay: "0.00", CueOutFade: "CueTiming", CueOutDelay: "CueTiming", SnapDelay: "0.00", Command: "" }, data };
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
      this.step = 1;
    } else if ((m = cmd.match(/^Step (\d+)$/))) this.step = +m[1];
    else if ((m = cmd.match(/^At Phase (-?[\d.]+) Thru (-?[\d.]+)$/))) {
      const ids = [...sel];
      ids.forEach((f, k) => {
        for (const v of this.prog[this.env].get(f)?.values() ?? []) if (v.steps && v.steps.length > 1) v.phase = ids.length > 1 ? +m![1] + ((+m![2] - +m![1]) * k) / (ids.length - 1) : +m![1];
      });
    } else if ((m = cmd.match(/^At Speed ([\d.]+)$/))) {
      for (const f of sel) for (const v of this.prog[this.env].get(f)?.values() ?? []) if (v.steps && v.steps.length > 1) v.speed = +m[1] / 60;
    } else if ((m = cmd.match(/^Fixture (.+)$/))) {
      for (const part of m[1].split("+").map((x) => x.trim())) {
        const r = part.match(/^(\d+) Thru (\d+)$/);
        for (const id of r ? Object.keys(this.fixtures).filter((f) => +f >= +r[1] && +f <= +r[2]) : [part]) if (this.fixtures[id]) sel.add(id);
      }
    } else if ((m = cmd.match(/^At ([\d.]+)$/))) {
      for (const f of sel) if (this.fixtures[f].includes("Dimmer")) this.set(f, "Dimmer", { value: +m[1] });
    } else if ((m = cmd.match(/^Attribute "(.+)" At Absolute(?: Percent)? (-?[\d.]+)$/))) {
      for (const f of sel) {
        if (!this.fixtures[f].includes(m[1])) continue;
        const old = this.prog[this.env].get(f)?.get(m[1]);
        if (this.step > 1 || old?.steps) {
          const steps = [...(old?.steps ?? [old?.value ?? 0])];
          steps[this.step - 1] = +m[2];
          this.set(f, m[1], { value: steps[0], steps });
        } else this.set(f, m[1], { value: +m[2] });
      }
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
    } else if ((m = cmd.match(/^Delete Sequence (\d+) Cue ([\d.]+)( Thru)? \/NoConfirmation$/))) {
      // SU-14: deleting cues keeps the sequence object (live 2026-10-15).
      const seq = this.seqs.get(+m[1]);
      if (seq) seq.cues = seq.cues.filter((c) => (m![3] ? c.no < +m![2] : c.no !== +m![2]));
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
    const expr = (e: string) => e.replace(/^Fixture /, "").split("+").map((x) => x.trim()).flatMap((part) => {
      const r = part.match(/^(\d+) Thru (\d+)$/);
      return r ? Object.keys(this.fixtures).filter((f) => +f >= +r[1] && +f <= +r[2]) : [part];
    });
    const fids = scope === "selection" ? [...this.selected[this.env]] : scope === "fixtures" ? expr(String(args.fixtures)) : [...new Set([...Object.keys(this.fixtures).filter((f) => p.has(f))])];
    const order = [...this.selected[this.env]];
    const rows = fids.flatMap((fid) =>
      [...(p.get(fid) ?? new Map<string, Value>()).entries()].map(([attribute, v]) => ({
        fixture: `Fx ${fid}`,
        fid,
        subfixtureIndex: +fid,
        attribute,
        ...(v.steps && v.steps.length > 1 ? { steps: v.steps.map((x) => ({ absolute: x })), phaser: { gridPos: order.indexOf(fid), phase: v.phase ?? 0, speed: v.speed ?? 1 } } : { value: v.value }),
        stepCount: v.steps?.length ?? 1,
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
    if (ref === "Sequence Thru") {
      const items = [...this.seqs].map(([no, s]) => ({ name: s.name, class: "Sequence", fields: Object.fromEntries(fields.map((f) => [f, f === "No" ? `${no} (${s.cues.length})` : { Priority: "LTP", OffWhenOverridden: "Yes", ...(s.props ?? {}) }[f]])) }));
      return { total: items.length, items };
    }
    if ((m = ref.match(/^Preset (\d+)\.(\d+) Thru (\d+)$/))) {
      const items = Object.entries(this.presets)
        .filter(([k]) => k.split(".")[0] === m![1] && +k.split(".")[1] >= +m![2] && +k.split(".")[1] <= +m![3])
        .map(([k, p]) => ({ name: p.name, class: "Preset", fields: { No: k.split(".")[1], Name: p.name } }));
      if (!items.length) throw new Error(`no objects found for '${ref}'`);
      return { total: items.length, items };
    }
    if ((m = ref.match(/^Sequence (\d+)$/))) {
      const s = this.seqs.get(+m[1]);
      if (!s) return none;
      const idx = this.currentIndex(+m[1]);
      const all: Record<string, unknown> = { Priority: "LTP", OffWhenOverridden: "Yes", Note: "", Lock: "", StructureLocked: "No", SystemLocked: "No", ...(s.props ?? {}), Name: s.name, WrapAround: s.wrap ? "Yes" : "No", RateMaster: "None", SpeedMaster: "None", RateScale: "One", SpeedScale: "One", SpeedFromRate: "No", CurrentCue: idx === undefined ? null : { addr: `seq.${m[1]}.cue.${s.cues[idx].no}`, name: s.cues[idx].name } };
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

  applySet(ref: string, prop: string, value: string): void {
    let m: RegExpMatchArray | null;
    if ((m = ref.match(/^Sequence (\d+) Cue ([\d.]+) Part 0$/))) {
      const c = this.cue(+m[1], +m[2]);
      if (!c) throw new Error(`no object found for '${ref}'`);
      if (prop === "Name") c.name = value;
      else if (prop === "Command") c.part0.Command = value;
      else c.part0[prop] = Number(value).toFixed(2);
    } else if ((m = ref.match(/^Sequence (\d+) Cue ([\d.]+)$/))) {
      const c = this.cue(+m[1], +m[2]);
      if (!c) throw new Error(`no object found for '${ref}'`);
      if (prop === "TrigType") {
        c.trigType = value;
        // SU-14: a trigger other than Time sets TrigTime to 0, and a switch back keeps the 0 (live 2026-10-15).
        if (value !== "Time") c.trigTime = 0;
      } else if (prop === "TrigTime") c.trigTime = Number(value);
    } else if ((m = ref.match(/^Sequence (\d+)$/))) {
      const s = this.seqs.get(+m[1]);
      if (!s) throw new Error(`no object found for '${ref}'`);
      if (prop === "Name") s.name = value;
      else if (prop === "WrapAround") s.wrap = value === "Yes";
      else (s.props ??= {})[prop] = value;
    }
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
      const key = `${ref} ${prop}`;
      if (this.silentSet?.test(key)) {
        this.applySet(ref, prop, value);
        return SILENT;
      }
      if (this.rejectSet?.test(key)) throw new Error("Access denied");
      if (this.ignoreSet?.test(key)) return { ref, property: prop, value };
      this.applySet(ref, prop, value);
      return { ref, property: prop, value };
    });
    f.on("object", (args) => {
      const no = Number(String(args.ref).replace(/^Sequence /, ""));
      return { name: String(args.ref), hasActivePlayback: this.playing?.seq === no || this.running.has(no) };
    });
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
    assert.deepEqual(result.cues.map((x: any) => [x.cue, x.status, x.verification]), [["1", "stored", "matched"], ["2", "stored", "matched"], ["3", "stored", "matched"]], "compact: one line per cue");
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
    assert.equal(result.cues[1].verification, "mismatched");
    assert.ok(result.cues[1].detail && result.cues[1].looks?.length === 1, "a cue that did not match keeps its look details in the compact form");
    assert.ok(result.steps.some((x: any) => x.status === "failed"), "the failed step is listed");
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
    assert.deepEqual(result.cycle.observedCues, [1, 2, 3, 1, 2], "compact: the observed cue order");
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

test("SU-12: an 18-step chase result is compact by default (a few KB) and complete with detail: true", async () => {
  const { h, c } = await setup();
  try {
    const steps = Array.from({ length: 18 }, (_, i) => ({ name: `Step ${i + 1}`, intensity: (i + 1) * 5 }));
    const compact = await h.callJson("gma3_build_chase", { sequence: 971, fixtures: "101 + 102", steps, step_seconds: 0.2, exclusive: true });
    assert.equal(compact.isError, false, JSON.stringify(compact.result).slice(0, 2000));
    const size = JSON.stringify(compact.result).length;
    assert.ok(size < 4000, `compact result is ${size} bytes`);
    assert.equal(compact.result.cues.length, 18);
    assert.deepEqual(compact.result.cues[2], { cue: "3", status: "stored", verification: "matched", name: "Step 3" });
    assert.equal(compact.result.cycle.observed, undefined);
    assert.equal(compact.result.cycle.observedCues.length, compact.result.cycle.expected.length);
    assert.equal(compact.result.cycle.watched, true);
    assert.deepEqual(compact.result.steps, [], "only steps that did not succeed are listed");
    assert.ok(compact.result.stepCounts.succeeded > 100);
    assert.match(compact.result.detailHint, /detail: true/);

    c.seqs.delete(971);
    const full = await h.callJson("gma3_build_chase", { sequence: 971, fixtures: "101 + 102", steps, step_seconds: 0.2, exclusive: true, detail: true });
    assert.equal(full.isError, false);
    assert.equal(full.result.steps.length, compact.result.stepCounts.succeeded);
    assert.ok(JSON.stringify(full.result).length > 3 * size, "detail returns every step");
  } finally {
    await h.close();
  }
});

test("store_cues batch (SU-12): several sequences, each its own Preview build; one refused in create mode fails alone", async () => {
  const { h, c } = await setup();
  try {
    c.addCue(952, 1);
    const { result, isError } = await h.callJson("gma3_store_cues", {
      mode: "create",
      fixtures: "101",
      exclusive: true,
      sequences: [
        { sequence: 951, sequence_name: "A", cues: [{ cue: 1, intensity: 10 }, { cue: 2, intensity: 20 }] },
        { sequence: 952, cues: [{ cue: 1, intensity: 30 }] },
        { sequence: 953, fixtures: "102", cues: [{ cue: 1, presets: [{ pool: 4, preset: 2 }] }] },
      ],
    });
    assert.equal(isError, true);
    assert.equal(result.outcome, "partial");
    assert.deepEqual(result.items.map((i: any) => `${i.target}:${i.outcome}:${i.verification}`), ["Sequence 951:succeeded:matched", "Sequence 952:failed:unavailable", "Sequence 953:succeeded:matched"]);
    assert.match(result.items[1].summary, /already has cue\(s\) 1; nothing was sent/);
    assert.equal(c.seqs.get(951)!.name, "A");
    assert.deepEqual(c.seqs.get(953)!.cues[0].data, { "102": { ColorRGB_R: 0, ColorRGB_G: 100, ColorRGB_B: 0 } });
    assert.equal(c.seqs.get(952)!.cues.length, 1, "the refused sequence is untouched");
    normalUntouched(c);
    const dup = await h.callJson("gma3_store_cues", { mode: "create", exclusive: true, sequences: [{ sequence: 951, cues: [{ cue: 5, intensity: 1, fixtures: "101" }] }, { sequence: 951, cues: [{ cue: 6, intensity: 1, fixtures: "101" }] }] });
    assert.match(dup.result.validationErrors.join(" "), /Sequence 951 appears more than once/);
  } finally {
    await h.close();
  }
});

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

// ---------------------------------------------------------------------------
// SU-14: commands, preset ranges, replace, phasers in looks, sequence settings, trigger times
// ---------------------------------------------------------------------------

test("SU-14 store_cues: command-only cues and a cue with a look and a command; commands read back", async () => {
  const { h, c } = await setup();
  try {
    const { result, isError } = await h.callJson("gma3_store_cues", {
      sequence: 960,
      mode: "create",
      exclusive: true,
      cues: [
        { cue: 1, command: 'SetGlobalVariable "HexCol" "11"; Go+ Macro 20', trigger: "time", time: 2 },
        { cue: 2, command: "Go+ Macro 21", trigger: "time", time: 2 },
        { cue: 3, fixtures: "101", intensity: 40, command: "Go+ Sequence 12" },
      ],
    });
    assert.equal(isError, false, JSON.stringify(result).slice(0, 2000));
    assert.equal(result.verification.status, "matched");
    const seq = c.seqs.get(960)!;
    assert.deepEqual(seq.cues.map((x) => x.part0.Command), ['SetGlobalVariable "HexCol" "11"; Go+ Macro 20', "Go+ Macro 21", "Go+ Sequence 12"]);
    assert.deepEqual(seq.cues[0].data, {}, "a command-only cue is stored from an empty programmer");
    assert.deepEqual(seq.cues[2].data, { "101": { Dimmer: 40 } });
    normalUntouched(c);
    const bad = await h.callJson("gma3_store_cues", { sequence: 961, mode: "create", exclusive: true, cues: [{ cue: 1 }, { cue: 2, command: 'Echo "x' }] });
    assert.match(bad.result.validationErrors.join(" "), /cues\[0\]: give its content .* or a command/);
    assert.match(bad.result.validationErrors.join(" "), /cues\[1\]\.command has an unbalanced quote/);
  } finally {
    await h.close();
  }
});

test("SU-14 store_cues: one cue per existing preset of a range, named after the preset; build_chase takes a range too", async () => {
  const { h, c } = await setup();
  try {
    const { result, isError } = await h.callJson("gma3_store_cues", { sequence: 962, mode: "create", exclusive: true, fixtures: "101", presets: { pool: 4, from: 1, to: 5 }, fade: 1 });
    assert.equal(isError, false, JSON.stringify(result).slice(0, 2000));
    assert.deepEqual(c.seqs.get(962)!.cues.map((x) => [x.no, x.name, x.part0.CueInFade]), [[1, "Red", "1.00"], [2, "Green", "1.00"], [3, "Blue", "1.00"]]);
    assert.ok(result.warnings.some((w: string) => /2 number\(s\) in the range hold no preset/.test(w)));
    const chase = await h.callJson("gma3_build_chase", { sequence: 963, fixtures: "102", presets: { pool: 4, from: 1, to: 3 }, step_seconds: 0.25, exclusive: true, observe: false });
    assert.equal(chase.isError, false, JSON.stringify(chase.result).slice(0, 2000));
    assert.deepEqual(c.seqs.get(963)!.cues.map((x) => [x.name, x.trigType, x.trigTime]), [["Red", "Time", 0.25], ["Green", "Time", 0.25], ["Blue", "Time", 0.25]]);
    const none = await h.callJson("gma3_store_cues", { sequence: 964, mode: "create", exclusive: true, fixtures: "101", presets: { pool: 4, from: 50, to: 60 } });
    assert.match(none.result.summary + errors(none), /no preset exists in 4\.50 Thru 4\.60; nothing was sent/);
    const noFix = await h.callJson("gma3_store_cues", { sequence: 964, mode: "create", exclusive: true, presets: { pool: 4, from: 1, to: 3 } });
    assert.match(noFix.result.validationErrors.join(" "), /presets needs fixtures/);
  } finally {
    await h.close();
  }
});

test("SU-14 replace: the existing cues are deleted first and the sequence rebuilt; build_chase rebuilds a sequence with cues", async () => {
  const { h, c } = await setup();
  try {
    for (const n of [1, 2, 3, 4]) c.addCue(965, n, { "101": { Dimmer: n } });
    c.seqs.get(965)!.name = "Keep";
    const { result, isError } = await h.callJson("gma3_store_cues", { sequence: 965, replace: true, exclusive: true, cues: [{ cue: 1, fixtures: "101", intensity: 70 }, { cue: 2, fixtures: "101", intensity: 20 }] });
    assert.equal(isError, false, JSON.stringify(result).slice(0, 2000));
    // Review round 1: the old cues are deleted only once Preview is confirmed usable, right before the build.
    const del = c.commands.indexOf("[P] Delete Sequence 965 Cue 1 Thru /NoConfirmation");
    assert.ok(del > c.commands.indexOf("Preview On"), JSON.stringify(c.commands.slice(0, 6)));
    assert.deepEqual(c.seqs.get(965)!.cues.map((x) => [x.no, x.data["101"]?.Dimmer]), [[1, 70], [2, 20]]);
    assert.equal(c.seqs.get(965)!.name, "Keep", "the sequence object stays");
    // build_chase refuses a sequence with cues unless replace.
    const refused = await h.callJson("gma3_build_chase", { sequence: 965, fixtures: "101", steps: [{ intensity: 10 }, { intensity: 90 }], step_seconds: 0.25, exclusive: true, observe: false });
    assert.match(errors(refused), /pass replace: true/);
    const rebuilt = await h.callJson("gma3_build_chase", { sequence: 965, fixtures: "101", steps: [{ intensity: 10 }, { intensity: 90, command: "Go+ Macro 3" }], step_seconds: 0.25, exclusive: true, observe: false, replace: true });
    assert.equal(rebuilt.isError, false, JSON.stringify(rebuilt.result).slice(0, 2000));
    assert.deepEqual(c.seqs.get(965)!.cues.map((x) => [x.data["101"]?.Dimmer, x.part0.Command]), [[10, ""], [90, "Go+ Macro 3"]]);
    normalUntouched(c);
  } finally {
    await h.close();
  }
});

test("SU-14 a look with a phaser: built in Preview after the look's values, checked per fixture and step, then stored", async () => {
  const { h, c } = await setup();
  try {
    const { result, isError } = await h.callJson("gma3_store_cues", {
      sequence: 966,
      mode: "create",
      exclusive: true,
      cues: [{ cue: 1, fixtures: "101 + 102", intensity: 100, phaser: { steps: [{ values: { ColorRGB_R: 100 } }, { values: { ColorRGB_R: 0 } }], phaser: { speed_bpm: 120, phase: { from: 0, to: 180 } } } }],
    });
    assert.equal(isError, false, JSON.stringify(result).slice(0, 3000));
    assert.equal(result.cues[0].verification, "matched");
    const pre = c.commands.slice(c.commands.indexOf("[P] At 100") + 1);
    assert.deepEqual(pre.slice(0, 6), ["[P] Step 1", '[P] Attribute "ColorRGB_R" At Absolute 100', "[P] Step 2", '[P] Attribute "ColorRGB_R" At Absolute 0', "[P] At Speed 120", "[P] At Phase 0 Thru 180"]);
    // A phaser that does not take (the console refuses the phase) is a mismatch and the cue is not stored.
    c.reject = /^At Phase/;
    const bad = await h.callJson("gma3_store_cues", { sequence: 967, mode: "create", exclusive: true, cues: [{ cue: 1, fixtures: "101 + 102", phaser: { steps: [{ values: { ColorRGB_R: 100 } }, { values: { ColorRGB_R: 0 } }], phaser: { phase: { from: 0, to: 180 } } } }] });
    assert.equal(bad.isError, true);
    assert.equal(c.seqs.get(967), undefined, "nothing was stored");
    const both = await h.callJson("gma3_store_cues", { sequence: 968, mode: "create", exclusive: true, cues: [{ cue: 1, fixtures: "101", intensity: 50, phaser: { steps: [{ values: { Dimmer: 100 } }, { values: { Dimmer: 0 } }] } }] });
    assert.match(both.result.validationErrors.join(" "), /Dimmer is both a static value and a phaser attribute/);
  } finally {
    await h.close();
  }
});

test("SU-14 sequence settings in the same call; an override lists the running sequences it would switch off, protect_running turns that off", async () => {
  const { h, c } = await setup();
  try {
    c.addCue(5, 1);
    c.seqs.get(5)!.name = "Base";
    c.running.add(5);
    c.addCue(6, 1);
    c.seqs.get(6)!.props = { OffWhenOverridden: "No" };
    c.running.add(6);
    const warn = await h.callJson("gma3_store_cues", { sequence: 970, mode: "create", exclusive: true, cues: [{ cue: 1, fixtures: "101", intensity: 100 }], sequence_settings: { priority: "high" } });
    assert.equal(warn.isError, false, JSON.stringify(warn.result).slice(0, 3000));
    assert.equal(c.seqs.get(970)!.props?.Priority, "High");
    assert.deepEqual(warn.result.override.wouldSwitchOff.map((x: any) => x.sequence), [5], "Off When Overridden off (6) is not listed");
    assert.ok(warn.result.warnings.some((w: string) => /switches off Sequence 5 "Base".*protect_running/.test(w)));
    assert.equal(c.seqs.get(5)!.props?.OffWhenOverridden ?? "Yes", "Yes", "nothing changed on the running sequence without protect_running");
    const prot = await h.callJson("gma3_store_cues", { sequence: 971, mode: "create", exclusive: true, cues: [{ cue: 1, fixtures: "101", intensity: 100 }], sequence_settings: { priority: "high" }, protect_running: true });
    assert.equal(prot.isError, false, JSON.stringify(prot.result).slice(0, 3000));
    assert.equal(c.seqs.get(5)!.props?.OffWhenOverridden, "No");
    assert.deepEqual(prot.result.override.protected, [5]);
    const bad = await h.callJson("gma3_store_cues", { sequence: 972, mode: "create", exclusive: true, cues: [{ cue: 1, fixtures: "101", intensity: 1 }], sequence_settings: { colour: "red" }, protect_running: true });
    assert.match(bad.result.validationErrors.join(" "), /colour is not a sequence setting/);
    assert.match(bad.result.validationErrors.join(" "), /protect_running applies to an override/);
  } finally {
    await h.close();
  }
});

test("SU-14 edit_cues: a switch to Go reports the trigger times it wipes; keep_times saves them in the Note and restore_times brings them back", async () => {
  const { h, c } = await setup();
  try {
    for (const [n, t] of [[1, 2.5], [2, 4], [3, 0]] as const) Object.assign(c.addCue(20, n), { trigType: "Time", trigTime: t });
    c.seqs.get(20)!.props = { Note: "clock" };
    const plain = await h.callJson("gma3_edit_cues", { sequence: 20, all: true, trigger: "follow" });
    assert.deepEqual(plain.result.wipedTrigTimes, [{ cue: "1", time: 2.5 }, { cue: "2", time: 4 }]);
    assert.ok(plain.result.warnings.some((w: string) => /set the trigger time of 2 Time cue\(s\) to 0.*keep_times/.test(w)));
    for (const [n, t] of [[1, 2.5], [2, 4]] as const) Object.assign(c.cue(20, n)!, { trigType: "Time", trigTime: t });
    const kept = await h.callJson("gma3_edit_cues", { sequence: 20, all: true, trigger: "go", keep_times: true });
    assert.equal(kept.isError, false, JSON.stringify(kept.result).slice(0, 2000));
    assert.equal(c.seqs.get(20)!.props?.Note, "clock [gma3-mcp trigtimes 1=2.5 2=4]", "the rest of the note stays");
    assert.deepEqual(c.seqs.get(20)!.cues.map((x) => [x.trigType, x.trigTime]), [["Go", 0], ["Go", 0], ["Go", 0]]);
    const back = await h.callJson("gma3_edit_cues", { sequence: 20, all: true, trigger: "time", restore_times: true, time: 1 });
    assert.equal(back.isError, false, JSON.stringify(back.result).slice(0, 2000));
    assert.deepEqual(c.seqs.get(20)!.cues.map((x) => [x.trigType, x.trigTime]), [["Time", 2.5], ["Time", 4], ["Time", 1]], "cue 3 had no saved time: the given time is the fallback");
    assert.equal(c.seqs.get(20)!.props?.Note, "clock", "the marker is removed");
    const none = await h.callJson("gma3_edit_cues", { sequence: 20, cues: [1], trigger: "time", restore_times: true });
    assert.match(errors(none), /no saved trigger time for cue\(s\) 1/);
  } finally {
    await h.close();
  }
});

test("SU-14 edit_cues: one command per cue, read back; a count that differs is refused", async () => {
  const { h, c } = await setup();
  try {
    for (const n of [1, 2]) c.addCue(21, n);
    const r = await h.callJson("gma3_edit_cues", { sequence: 21, all: true, commands: ["Go+ Macro 1", "Go+ Macro 2"] });
    assert.equal(r.isError, false, JSON.stringify(r.result).slice(0, 2000));
    assert.equal(r.result.verification.status, "matched");
    assert.deepEqual(c.seqs.get(21)!.cues.map((x) => x.part0.Command), ["Go+ Macro 1", "Go+ Macro 2"]);
    const bad = await h.callJson("gma3_edit_cues", { sequence: 21, all: true, commands: ["Go+ Macro 1"] });
    assert.match(errors(bad), /1 command\(s\) for 2 cue\(s\)/);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// SU-14 review round 1
// ---------------------------------------------------------------------------

test("SU-14 review 1: replace deletes nothing when Preview is not usable (occupied, incomplete) or not entered", async () => {
  const { h, c } = await setup();
  try {
    c.addCue(975, 1, { "101": { Dimmer: 77 } });
    c.prog.Preview.set("102", new Map([["Dimmer", { value: 12 }]]));
    const occupied = await h.callJson("gma3_store_cues", { sequence: 975, replace: true, exclusive: true, cues: [{ cue: 1, fixtures: "101", intensity: 10 }] });
    assert.equal(occupied.isError, true);
    assert.match(errors(occupied), /Preview programmer is not empty/);
    assert.deepEqual(c.seqs.get(975)!.cues.map((x) => x.data["101"]?.Dimmer), [77], "the old cue is still there");
    assert.equal(c.prog.Preview.get("102")?.get("Dimmer")?.value, 12, "the operator's Preview value is kept");
    assert.ok(!c.commands.some((x) => /Delete Sequence/.test(x)));
    c.prog.Preview.clear();
    c.previewIncomplete = true;
    const incomplete = await h.callJson("gma3_store_cues", { sequence: 975, replace: true, exclusive: true, cues: [{ cue: 1, fixtures: "101", intensity: 10 }] });
    assert.equal(incomplete.isError, true);
    c.previewIncomplete = false;
    c.reject = /^Preview On$/;
    const notEntered = await h.callJson("gma3_store_cues", { sequence: 975, replace: true, exclusive: true, cues: [{ cue: 1, fixtures: "101", intensity: 10 }] });
    assert.equal(notEntered.isError, true);
    assert.ok(!c.commands.some((x) => /Delete Sequence/.test(x)), "nothing was ever deleted");
    assert.deepEqual(c.seqs.get(975)!.cues.map((x) => x.data["101"]?.Dimmer), [77]);
  } finally {
    await h.close();
  }
});

test("SU-14 review 1: sequence_settings values are validated before anything is sent, in both builders", async () => {
  const { h, c } = await setup();
  try {
    c.addCue(976, 1, { "101": { Dimmer: 77 } });
    for (const [tool, args] of [
      ["gma3_store_cues", { sequence: 976, replace: true, exclusive: true, cues: [{ cue: 1, command: "Go+ Macro 1" }], sequence_settings: { priority: "banana" } }],
      ["gma3_build_chase", { sequence: 976, replace: true, exclusive: true, fixtures: "101", steps: [{ intensity: 1 }, { intensity: 2 }], step_seconds: 1, observe: false, sequence_settings: { off_when_overridden: "no" } }],
      ["gma3_store_cues", { sequence: 976, mode: "merge", exclusive: true, cues: [{ cue: 2, command: "x" }], sequence_settings: {} }],
    ] as const) {
      const r = await h.callJson(tool, args as Record<string, unknown>);
      assert.equal(r.isError, true, tool);
      assert.match(r.result.validationErrors.join(" "), /sequence_settings(\.priority must be one of|\.off_when_overridden must be true or false| is empty)/);
    }
    assert.deepEqual(c.commands, [], "nothing was sent");
    assert.deepEqual(c.seqs.get(976)!.cues.map((x) => x.data["101"]?.Dimmer), [77]);
  } finally {
    await h.close();
  }
});

test("SU-14 review 1: after a step without a reply no later mutation is sent (settings after a build, the Note after a restore)", async () => {
  const { h, c } = await setup();
  try {
    c.silentSet = /^Sequence 977 Cue 2 Part 0 Command$/;
    const r = await h.callJson("gma3_store_cues", { sequence: 977, mode: "create", exclusive: true, cues: [{ cue: 1, command: "Go+ Macro 1" }, { cue: 2, command: "Go+ Macro 2" }], sequence_settings: { priority: "high" } });
    assert.equal(c.seqs.get(977)!.props?.Priority, undefined, "Priority was never written");
    assert.match(r.result.sequenceSettings.reason, /got no reply/);
    assert.ok(r.result.steps.some((st: any) => st.name === "sequence_settings" && st.status === "skipped"));
    c.silentSet = undefined;
    for (const n of [1, 2]) Object.assign(c.addCue(978, n), { trigType: "Go", trigTime: 0 });
    c.seqs.get(978)!.props = { Note: "[gma3-mcp trigtimes 1=2.5 2=4]" };
    c.silentSet = /^Sequence 978 Cue 2 TrigTime$/;
    await h.callJson("gma3_edit_cues", { sequence: 978, all: true, trigger: "time", restore_times: true });
    assert.equal(c.seqs.get(978)!.props?.Note, "[gma3-mcp trigtimes 1=2.5 2=4]", "the saved times stay after an unanswered restore");
  } finally {
    await h.close();
  }
});

test("SU-14 review 1: an override whose protection fails is neither configured nor played", async () => {
  const { h, c } = await setup();
  try {
    c.addCue(5, 1);
    c.running.add(5);
    c.rejectSet = /^Sequence 5 OffWhenOverridden$/;
    const sc = await h.callJson("gma3_store_cues", { sequence: 979, mode: "create", exclusive: true, cues: [{ cue: 1, fixtures: "101", intensity: 100 }], sequence_settings: { priority: "high" }, protect_running: true });
    assert.equal(sc.isError, true);
    assert.equal(c.seqs.get(979)!.props?.Priority, undefined, "the override's priority was not applied");
    assert.equal(sc.result.verification.status, "mismatched");
    const ch = await h.callJson("gma3_build_chase", { sequence: 980, exclusive: true, fixtures: "101", steps: [{ intensity: 10 }, { intensity: 90 }], step_seconds: 0.25, sequence_settings: { priority: "high" }, protect_running: true });
    assert.equal(ch.isError, true);
    assert.ok(!c.commands.some((x) => /^Goto Sequence 980/.test(x)), "the chase was not played");
    assert.match(ch.result.cycle.reason, /protection\) did not succeed/);
  } finally {
    await h.close();
  }
});

test("SU-14 review 1: keep_times reads the saved marker back before changing triggers; an ignored write changes nothing", async () => {
  const { h, c } = await setup();
  try {
    Object.assign(c.addCue(981, 1), { trigType: "Time", trigTime: 2.5 });
    c.seqs.get(981)!.props = { Note: "clock" };
    c.ignoreSet = /^Sequence 981 Note$/;
    const r = await h.callJson("gma3_edit_cues", { sequence: 981, all: true, trigger: "go", keep_times: true });
    assert.equal(r.isError, true);
    assert.match(errors(r), /the Note reads "clock", not the saved times; the triggers were not changed/);
    assert.deepEqual([c.cue(981, 1)!.trigType, c.cue(981, 1)!.trigTime], ["Time", 2.5], "the original time is untouched");
    assert.equal(r.result.trigTimesKept, false);
  } finally {
    await h.close();
  }
});

test("SU-14 review 1: a look's phaser on a fixture without its attributes is refused before anything is sent", async () => {
  const { h, c } = await setup();
  try {
    const r = await h.callJson("gma3_store_cues", { sequence: 982, mode: "create", exclusive: true, cues: [{ cue: 1, fixtures: "101 + 301", phaser: { steps: [{ values: { ColorRGB_R: 100 } }, { values: { ColorRGB_R: 0 } }] } }] });
    assert.equal(r.isError, true);
    assert.match(errors(r), /fixture\(s\) 301 of Fixture 101 \+ 301 have no ColorRGB_R/);
    assert.deepEqual(c.commands, [], "nothing was sent");
  } finally {
    await h.close();
  }
});

test("SU-14 review 1: each deletion is its own step; a refused one keeps the earlier ones in the result", async () => {
  const { h, c } = await setup();
  try {
    for (const n of [0.1, 0.2, 1]) c.addCue(983, n, { "101": { Dimmer: 5 } });
    c.reject = /^Delete Sequence 983 Cue 0\.2 /;
    const r = await h.callJson("gma3_store_cues", { sequence: 983, replace: true, exclusive: true, cues: [{ cue: 1, fixtures: "101", intensity: 10 }], detail: true });
    assert.equal(r.result.outcome, "partial");
    const st = (n: string) => r.result.steps.find((x: any) => x.name === n);
    assert.equal(st("delete_cue_0.1").status, "succeeded");
    assert.equal(st("delete_cue_0.2").status, "failed");
    assert.deepEqual(c.seqs.get(983)!.cues.map((x) => x.no), [0.2, 1], "cue 0.1 is gone, as the result says");
  } finally {
    await h.close();
  }
});

test("SU-14 after SU-13: a look's phaser refuses the count-dependent forms (phase step, spread, shuffle) instead of dropping them", async () => {
  const { h, c } = await setup();
  try {
    for (const phaser of [{ phase: { step: 90 } }, { phase: "spread" }, { phase: { from: 0, to: 90 }, shuffle: 3 }]) {
      const r = await h.callJson("gma3_store_cues", { sequence: 984, mode: "create", exclusive: true, cues: [{ cue: 1, fixtures: "101 + 102", phaser: { steps: [{ values: { Dimmer: 100 } }, { values: { Dimmer: 0 } }], phaser } }] });
      assert.match(r.result.validationErrors.join(" "), /a look's phaser takes phase \{from, to\}/, JSON.stringify(phaser));
    }
    assert.deepEqual(c.commands, []);
  } finally {
    await h.close();
  }
});
