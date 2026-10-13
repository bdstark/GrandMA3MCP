import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { registerSpeedTools, faderToBpm, bpmToFader, parseScale, parseFaderText, tempoBpm, predictedStep, linkedRate, SCALES } from "../src/tools/speed.ts";
import { registerPlaybackTools } from "../src/tools/playback.ts";
import { ValidationError } from "../src/validate.ts";

// ---------------------------------------------------------------------------
// Tempo model
// ---------------------------------------------------------------------------

test("the fader curve matches the console: 50 = 60 BPM, 100 = 225, measured points", () => {
  assert.equal(faderToBpm(50), 60);
  assert.equal(faderToBpm(100), 225);
  assert.equal(faderToBpm(0), 0);
  // Written BPM -> fader read back on onPC 2.5.1.
  for (const [bpm, fader] of [[0.1, 1.7441], [1, 5.8407], [30, 34.7621], [120, 71.9174], [180, 88.9567], [224, 99.7666]]) {
    // Within 0.5% of the tempo (the lowest point, 0.1 BPM, is 0.2% off: the console rounds there).
    assert.ok(Math.abs(faderToBpm(fader) / bpm - 1) < 0.005, `${fader} -> ${faderToBpm(fader)}`);
    assert.ok(Math.abs(bpmToFader(bpm) - fader) < 0.003, `${bpm} BPM -> ${bpmToFader(bpm)}`);
  }
  assert.ok(Math.abs(faderToBpm(75) - 130) < 0.7, "At 75 read 130 B");
});

test("scales, fader text, tempo arguments, predicted steps", () => {
  assert.equal(SCALES.Mul2, 1);
  assert.equal(SCALES.Div256, -8);
  assert.equal(parseScale("s", "mul4"), "Mul4");
  assert.equal(parseScale("s", 0.5), "Div2");
  assert.equal(parseScale("s", 1), "One");
  for (const bad of ["x2", 3, 512, 0, -2]) assert.throws(() => parseScale("s", bad), ValidationError, String(bad));
  assert.deepEqual(parseFaderText("200 *B"), { bpm: 200, scaled: true });
  assert.deepEqual(parseFaderText("1.0 B"), { bpm: 1, scaled: false });
  assert.deepEqual(parseFaderText("Stop"), { bpm: 0, scaled: false });
  assert.equal(parseFaderText("50%").bpm, null);
  assert.equal(tempoBpm({ hz: 2 }), 120);
  assert.equal(tempoBpm({ seconds: 0.5 }), 120);
  assert.equal(tempoBpm({ bpm: 0 }), 0);
  assert.throws(() => tempoBpm({ bpm: 60, hz: 1 }), /one of bpm, hz and seconds/);
  assert.throws(() => tempoBpm({ bpm: -1 }), ValidationError);
  assert.equal(linkedRate(120, "One"), 2);
  assert.equal(linkedRate(60, "Mul2"), 2);
  assert.equal(linkedRate(60, "Bogus"), null);
  const chase = [1, 2, 3, 4].map((no) => ({ no, trigType: "Time", trigTime: 1 }));
  assert.deepEqual(predictedStep(chase, 2), { ms: 500 });
  assert.match(predictedStep([...chase.slice(0, 3), { no: 4, trigType: "Go", trigTime: null }], 1).reason!, /not every cue is Time-triggered/);
  assert.match(predictedStep([...chase.slice(0, 3), { no: 4, trigType: "Time", trigTime: 2 }], 1).reason!, /different trigger times/);
  assert.match(predictedStep(chase, 0).reason!, /rate is 0/);
});

// ---------------------------------------------------------------------------
// Fake console
// ---------------------------------------------------------------------------

const ENUM_SCALES = Object.keys(SCALES);

interface FMaster { name: string; fader: number; scale: number; learn: string; lock: boolean }
interface FSeq { name: string; speedMaster: string; rateMaster: string; speedScale: string; rateScale: string; speedFromRate: boolean; cues: Array<{ trigType: string; trigTime: number }>; startedAt?: number; lock?: boolean }

class Console {
  masters: FMaster[] = Array.from({ length: 16 }, (_, i) => ({ name: i === 0 ? "Beat" : i === 15 ? "BPM" : `Speed${i + 1}`, fader: 50, scale: 0, learn: "Learn Ignores Speed Scale", lock: false }));
  seqs = new Map<number, FSeq>();
  commands: string[] = [];
  taps: number[] = [];
  /** Property writes the console ignores. */
  ignore = new Set<string>();
  audio = { device: "Mic", devices: ["Default <Mic>", "Mic"], soundIn: 100 };
  executors: Array<{ page: number; no: number; master: number }> = [];

  master(n: number) {
    return this.masters[n - 1];
  }
  effective(m: FMaster) {
    return faderToBpm(m.fader) * 2 ** m.scale;
  }
  seq(n: number, cues = 4, trigTime = 1): FSeq {
    const s: FSeq = { name: `Seq ${n}`, speedMaster: "None", rateMaster: "None", speedScale: "One", rateScale: "One", speedFromRate: false, cues: Array.from({ length: cues }, () => ({ trigType: "Time", trigTime })) };
    this.seqs.set(n, s);
    return s;
  }
  /** Current cue of a running chase: rate from the rate master (or 1:1) and RateScale, wrapping. */
  currentCue(s: FSeq): number {
    if (s.startedAt === undefined) return 1;
    const m = this.masters.find((x) => x.name === s.rateMaster);
    const rate = (m ? this.effective(m) / 60 : 1) * 2 ** SCALES[s.rateScale];
    const step = (s.cues[0].trigTime * 1000) / rate;
    return (Math.floor((Date.now() - s.startedAt) / step) % s.cues.length) + 1;
  }
  fmtText(m: FMaster) {
    const e = this.effective(m);
    return e === 0 ? "Stop" : `${e < 10 ? e.toFixed(1) : Math.round(e)} ${m.scale ? "*" : ""}B`;
  }

  install(h: Harness): void {
    const masterOf = (ref: string) => {
      const mm = ref.match(/^Master 3\.(\d+)$/);
      return mm ? this.master(Number(mm[1])) : undefined;
    };
    h.fake.on("children", (args) => {
      const ref = String(args.ref);
      if (ref === "ShowData.Masters.Speed")
        return { total: 16, offset: 0, count: 16, items: this.masters.map((m, i) => ({ name: m.name, index: i + 1, addr: `14.13.3.${i + 1}`, fields: { Name: m.name, SpeedScale: ENUM_SCALES.find((k) => SCALES[k] === m.scale), LearnMode: m.learn, FaderEnable: "AlwaysOn", Lock: m.lock ? "Yes" : "" } })) };
      if (ref === "DataPool.Sequences")
        return { total: this.seqs.size, offset: 0, count: this.seqs.size, items: [...this.seqs].map(([n, s]) => ({ name: s.name, index: n, fields: { SpeedMaster: s.speedMaster, RateMaster: s.rateMaster, SpeedScale: s.speedScale, RateScale: s.rateScale, SpeedFromRate: s.speedFromRate ? "Yes" : "No" } })) };
      if (ref === "DataPool.Pages") return { total: 1, items: [{ addr: "page.1", index: 1, fields: { No: 1 } }] };
      if (ref === "page.1") return { items: this.executors.map((e) => ({ fields: { No: e.no, Object: { class: "MasterSpeed", name: this.master(e.master).name, addr: `14.13.3.${e.master}` } } })) };
      if (ref === "Root.Temp.AudioInDescriptions") return { total: this.audio.devices.length, items: this.audio.devices.map((d) => ({ name: d })) };
      const sm = ref.match(/^Sequence (\d+)$/);
      if (sm && this.seqs.has(Number(sm[1]))) {
        const s = this.seqs.get(Number(sm[1]))!;
        return { items: [{ name: "OffCue", fields: { No: 0 } }, ...s.cues.map((c, i) => ({ name: `Cue ${i + 1}`, addr: `${sm[1]}.cue.${i + 1}`, fields: { No: (i + 1) * 1000, TrigType: c.trigType, TrigTime: c.trigTime } }))] };
      }
      throw new Error(`no object found for '${ref}'`);
    });
    h.fake.on("getfader", (args) => {
      const ref = String(args.ref);
      const m = masterOf(ref);
      if (m) return { ref, faders: { FaderMaster: { value: m.fader, text: this.fmtText(m) } } };
      if (ref === "Master 2.SoundIn") return { ref, faders: { FaderMaster: { value: this.audio.soundIn, text: `${this.audio.soundIn}%` } } };
      const sm = ref.match(/^Sequence (\d+)$/);
      if (sm) return { ref, faders: { FaderRate: { value: 50, text: "50%" } } };
      throw new Error(`no object found for '${ref}'`);
    });
    h.fake.on("object", (args) => {
      if (args.ref === "Root.StationSettings.LocalSettings") return { properties: { ONPCAUDIOINDEVICENAME: this.audio.device } };
      return { hasActivePlayback: false };
    });
    h.fake.on("objects", (args) => {
      const ref = String(args.ref);
      const sm = ref.match(/^Sequence (\d+)$/);
      const s = sm ? this.seqs.get(Number(sm[1])) : undefined;
      if (!s) return { items: [] };
      const cur = this.currentCue(s);
      const fields: Record<string, unknown> = {
        Name: s.name, SpeedMaster: s.speedMaster, RateMaster: s.rateMaster, SpeedScale: s.speedScale, RateScale: s.rateScale, SpeedFromRate: s.speedFromRate ? "Yes" : "No", WrapAround: "Yes",
        CurrentCue: args.asText === false ? { name: `Cue ${cur}`, addr: `${sm![1]}.cue.${cur}` } : `Cue ${cur}`,
        Lock: s.lock ? "UL" : "", StructureLocked: "No", SystemLocked: "No",
        Priority: "LTP", RestartMode: "First Cue", MasterGoMode: "None", XFadeMode: "AB",
      };
      for (const f of (args.fields as string[]) ?? []) if (!(f in fields)) fields[f] = "No";
      return { items: [{ name: s.name, index: Number(sm![1]), addr: `seq.${sm![1]}`, class: "Sequence", fields: Object.fromEntries(((args.fields as string[]) ?? []).map((f) => [f, fields[f]])) }] };
    });
    h.fake.on("set", (args) => {
      const ref = String(args.ref);
      const prop = String(args.property);
      const value = String(args.value);
      const m = masterOf(ref);
      if (m) {
        if (!m.lock && !this.ignore.has(prop)) {
          if (prop === "SpeedScale" && value in SCALES) m.scale = SCALES[value];
          if (prop === "LearnMode") m.learn = value;
        }
        return { ref, property: prop, value: prop === "SpeedScale" ? ENUM_SCALES.find((k) => SCALES[k] === m.scale) : m.learn };
      }
      const sm = ref.match(/^Sequence (\d+)$/);
      const s = this.seqs.get(Number(sm?.[1]))!;
      const key = ({ SpeedMaster: "speedMaster", RateMaster: "rateMaster", SpeedScale: "speedScale", RateScale: "rateScale" } as const)[prop as "SpeedMaster"];
      if (key && !this.ignore.has(prop)) {
        // Masters by name only, as on 2.5.1.
        if (prop.endsWith("Master") && value !== "None" && !this.masters.some((x) => x.name === value)) return { ref, property: prop, value: s[key] };
        s[key] = value;
      }
      return { ref, property: prop, value: key ? s[key] : value };
    });
    h.fake.on("cmd", (args) => {
      const c = String(args.command);
      this.commands.push(c);
      let mm: RegExpMatchArray | null;
      if ((mm = c.match(/^Master 3\.(\d+) At BPM ([\d.]+)$/))) {
        const m = this.master(Number(mm[1]));
        const base = Math.min(Number(mm[2]) / 2 ** m.scale, 225);
        m.fader = bpmToFader(base);
        return { feedback: "OK" };
      }
      if ((mm = c.match(/^(DoubleSpeed|HalfSpeed|Speed1|Learn) Master 3\.(\d+)$/))) {
        const m = this.master(Number(mm[2]));
        if (mm[1] === "DoubleSpeed") m.scale++;
        if (mm[1] === "HalfSpeed") m.scale--;
        if (mm[1] === "Speed1") { m.fader = 50; m.scale = 0; }
        if (mm[1] === "Learn") {
          this.taps.push(Date.now());
          if (this.taps.length > 1) {
            const gaps = this.taps.slice(1).map((x, i) => x - this.taps[i]);
            const tapped = 60000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length);
            m.fader = bpmToFader(m.learn === "Learn Respects Speed Scale" ? tapped : tapped / 2 ** m.scale);
          }
        }
        return { feedback: "OK" };
      }
      throw new Error(`unexpected command ${c}`);
    });
  }
}

let h: Harness;
let con: Console;
before(async () => {
  h = await startHarness((s, c) => { registerSpeedTools(s, c); registerPlaybackTools(s, c); }, { requestTimeoutMs: 2000 });
});
after(async () => {
  await h.close();
});
beforeEach(() => {
  h.fake.reset();
  con = new Console();
  con.install(h);
});
const stepError = (r: any, name: string) => r.steps?.find((s: { name: string }) => s.name === name)?.error ?? "";
const sets = () => h.fake.requests.filter((r) => r.op === "set").map((r) => `${r.args.ref} ${r.args.property}=${r.args.value}`);

// ---------------------------------------------------------------------------
// gma3_speed_masters
// ---------------------------------------------------------------------------

test("masters read with base and effective tempo, followers by speed and by rate, executors and sound", async () => {
  con.master(14).fader = bpmToFader(100);
  con.master(14).scale = 1;
  Object.assign(con.seq(907), { rateMaster: "Speed14" });
  Object.assign(con.seq(908), { rateMaster: "Speed14", rateScale: "Mul2" });
  Object.assign(con.seq(5455), { speedMaster: "Beat" });
  con.executors.push({ page: 1, no: 401, master: 1 });
  const { result, isError } = await h.callJson("gma3_speed_masters", { masters: [1, 14, 16] });
  assert.equal(isError, false);
  const m14 = result.masters.find((m: any) => m.master === 14);
  assert.equal(m14.baseBpm, 100);
  assert.equal(m14.effectiveBpm, 200);
  assert.deepEqual(m14.speedScale, { name: "Mul2", factor: 2 });
  assert.equal(m14.consoleText, "200 *B");
  assert.deepEqual(m14.problems, []);
  const u14 = result.usage.find((u: any) => u.master === 14);
  assert.deepEqual(u14.rateOf.map((r: any) => [r.sequence, r.rate]), [[907, 3.3333], [908, 6.6667]]);
  assert.deepEqual(result.usage.find((u: any) => u.master === 1).speedOf.map((s: any) => s.sequence), [5455]);
  assert.deepEqual(result.usage.find((u: any) => u.master === 1).executors, ["Page 1.401"]);
  assert.equal(result.sound.inputDevice, "Mic");
  assert.equal(result.sound.deviceListed, true);
  assert.equal(result.sound.beatDetection, "unavailable");
  assert.match(result.sound.notes.join(), /synchronised to the music cannot be read/);
  assert.match(result.masters.find((m: any) => m.master === 16).capabilities.sound, /follows the sound input/);
  assert.match(m14.capabilities.sound, /none/);
});

test("ambiguous names, unknown links, a muted or missing input are reported", async () => {
  con.master(3).name = "Beat";
  Object.assign(con.seq(1), { speedMaster: "Timing1" });
  con.audio = { device: "Gone", devices: ["Mic"], soundIn: 0 };
  const { result } = await h.callJson("gma3_speed_masters", { masters: [1, 3], usage: true });
  assert.match(result.masters[0].problems.join(), /shared with master\(s\) 3/);
  assert.match(result.warnings.join(), /not speed masters of this show: Timing1/);
  assert.equal(result.sound.deviceListed, false);
  assert.match(result.sound.notes.join(" | "), /"Gone" is not among the available devices.*SoundIn master is at 0/);
});

test("observe_seconds reports how a master moved without commands", async () => {
  let n = 0;
  h.fake.on("getfader", (args) => ({ ref: args.ref, faders: { FaderMaster: { value: 50 + (n++ % 2) * 10, text: "60 B" } } }));
  const { result } = await h.callJson("gma3_speed_masters", { observe_seconds: 0.4, usage: false, sound: false });
  assert.equal(result.observed.length, 1);
  assert.equal(result.observed[0].master, 16);
  assert.ok(result.observed[0].moves > 0);
  assert.match(result.observed[0].note, /moved without a command/);
});

// ---------------------------------------------------------------------------
// gma3_configure_speed_master
// ---------------------------------------------------------------------------

test("scale before tempo; the tempo is the effective one; followers are named; read back", async () => {
  Object.assign(con.seq(907), { rateMaster: "Speed14" });
  const { result, isError } = await h.callJson("gma3_configure_speed_master", { master: 14, bpm: 300, speed_scale: "mul2", learn_mode: "respect_scale" });
  assert.equal(isError, false, JSON.stringify(result));
  assert.deepEqual(sets(), ["Master 3.14 LearnMode=Learn Respects Speed Scale", "Master 3.14 SpeedScale=Mul2"]);
  assert.deepEqual(con.commands, ["Master 3.14 At BPM 300"]);
  assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
  assert.equal(result.after.baseBpm, 150);
  assert.equal(result.after.effectiveBpm, 300);
  assert.match(result.warnings.join(), /rate \(cue timing\) of Sequence 907/);
  const hz = await h.callJson("gma3_configure_speed_master", { master: 14, hz: 1 });
  assert.equal(hz.result.verification.status, "matched");
  assert.equal(con.commands.at(-1), "Master 3.14 At BPM 60");
});

test("tempo out of reach, locked masters, nothing to do and preview send nothing", async () => {
  const high = await h.callJson("gma3_configure_speed_master", { master: 14, bpm: 300 });
  assert.match(stepError(high.result, "read_master"), /above 225 BPM.*SpeedScale One.*clamp/);
  const highScaled = await h.callJson("gma3_configure_speed_master", { master: 14, bpm: 500, speed_scale: 2 });
  assert.match(highScaled.result.validationErrors.join(), /above 450 BPM/);
  con.master(14).lock = true;
  const locked = await h.callJson("gma3_configure_speed_master", { master: 14, bpm: 90 });
  assert.match(stepError(locked.result, "read_master"), /is locked/);
  con.master(14).lock = false;
  const noop = await h.callJson("gma3_configure_speed_master", { master: 14, speed_scale: "One" });
  assert.equal(noop.result.noop, true);
  const pv = await h.callJson("gma3_configure_speed_master", { master: 14, bpm: 90, preview: true });
  assert.equal(pv.result.preview, true);
  assert.equal(con.commands.length, 0);
  assert.equal(sets().length, 0);
  for (const [args, re] of [[{ master: 17, bpm: 60 }, /master must be <= 16/], [{ master: 1 }, /nothing to configure/], [{ master: 1, bpm: 60, seconds: 1 }, /one of bpm, hz and seconds/], [{ master: 1, speed_scale: "x3" }, /speed_scale must be one of/]] as const) {
    const r = await h.callJson("gma3_configure_speed_master", args as Record<string, unknown>);
    assert.match(r.result.validationErrors.join(), re, JSON.stringify(args));
  }
});

test("an ignored scale write fails the step; master 16 carries the sound warning", async () => {
  con.ignore.add("SpeedScale");
  const r = await h.callJson("gma3_configure_speed_master", { master: 14, speed_scale: "Mul4", bpm: 120 });
  assert.equal(r.isError, true);
  assert.match(stepError(r.result, "set_speed_scale"), /did not apply SpeedScale=Mul4/);
  assert.equal(con.commands.length, 0, "the tempo is not sent after a failed scale");
  con.ignore.clear();
  const bpm = await h.callJson("gma3_configure_speed_master", { master: 16, bpm: 128 });
  assert.match(bpm.result.warnings.join(), /master 16 follows the sound input/);
});

// ---------------------------------------------------------------------------
// gma3_speed_master_action
// ---------------------------------------------------------------------------

test("double, half and reset are verified; the scale ends are refused", async () => {
  con.master(14).fader = bpmToFader(100);
  const d = await h.callJson("gma3_speed_master_action", { master: 14, action: "double" });
  assert.equal(d.result.verification.status, "matched", JSON.stringify(d.result.verification));
  assert.equal(d.result.after.effectiveBpm, 200);
  const half = await h.callJson("gma3_speed_master_action", { master: 14, action: "half" });
  assert.equal(half.result.after.speedScale.name, "One");
  const reset = await h.callJson("gma3_speed_master_action", { master: 14, action: "reset" });
  assert.equal(reset.result.after.baseBpm, 60);
  assert.deepEqual(con.commands, ["DoubleSpeed Master 3.14", "HalfSpeed Master 3.14", "Speed1 Master 3.14"]);
  con.master(14).scale = 8;
  const top = await h.callJson("gma3_speed_master_action", { master: 14, action: "double" });
  assert.match(stepError(top.result, "read_master"), /Mul256/);
  const bad = await h.callJson("gma3_speed_master_action", { master: 14, action: "double", taps: 2 });
  assert.match(bad.result.validationErrors.join(), /for action learn only/);
});

test("learn: one tap cannot be verified; timed taps are compared with the learn mode", async () => {
  const one = await h.callJson("gma3_speed_master_action", { master: 14, action: "learn" });
  assert.equal(one.result.verification.status, "unavailable");
  assert.match(one.result.verification.detail, /one tap gives the console no interval/);
  con.taps = [];
  con.master(14).scale = 1; // Mul2, Learn Ignores Speed Scale: the effective tempo is the tapped one.
  const four = await h.callJson("gma3_speed_master_action", { master: 14, action: "learn", taps: 4, interval_ms: 250 });
  assert.equal(four.isError, false, JSON.stringify(four.result));
  assert.equal(four.result.verification.status, "matched", JSON.stringify(four.result.verification));
  assert.ok(Math.abs(four.result.after.effectiveBpm - 240) < 12, String(four.result.after.effectiveBpm));
  assert.ok(Math.abs(four.result.tapped.bpm - 240) < 12);
  const missing = await h.callJson("gma3_speed_master_action", { master: 14, action: "learn", taps: 3 });
  assert.match(missing.result.validationErrors.join(), /interval_ms/);
});

// ---------------------------------------------------------------------------
// gma3_configure_sequence links and gma3_observe_tempo
// ---------------------------------------------------------------------------

test("sequences link to masters by name; ambiguous or missing names are refused", async () => {
  con.seq(907);
  const { result, isError } = await h.callJson("gma3_configure_sequence", { sequence: 907, rate_master: 14, rate_scale: "mul2", speed_master: 1 });
  assert.equal(isError, false, JSON.stringify(result));
  assert.deepEqual(sets().sort(), ["Sequence 907 RateMaster=Speed14", "Sequence 907 RateScale=Mul2", "Sequence 907 SpeedMaster=Beat"]);
  assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
  const none = await h.callJson("gma3_configure_sequence", { sequence: 907, rate_master: "none" });
  assert.equal(none.result.verification.status, "matched", JSON.stringify(none.result));
  assert.equal(con.seqs.get(907)!.rateMaster, "None");
  con.master(3).name = "Speed14";
  const dup = await h.callJson("gma3_configure_sequence", { sequence: 907, rate_master: 14 });
  assert.match(stepError(dup.result, "resolve_masters"), /shares its name "Speed14" with master\(s\) 3/);
  con.master(5).name = "";
  const unnamed = await h.callJson("gma3_configure_sequence", { sequence: 907, speed_master: 5 });
  assert.match(stepError(unnamed.result, "resolve_masters"), /has no name/);
  const bad = await h.callJson("gma3_configure_sequence", { sequence: 907, rate_master: 17 });
  assert.equal(bad.isError, true);
});

test("observe_tempo measures linked and independent chases against their prediction", async () => {
  con.master(14).fader = bpmToFader(120);
  const a = Object.assign(con.seq(907, 4, 0.4), { rateMaster: "Speed14" });
  const b = Object.assign(con.seq(908, 4, 0.4), { rateMaster: "Speed14", speedMaster: "Beat" });
  const c = con.seq(909, 4, 0.2);
  const now = Date.now();
  for (const s of [a, b, c]) s.startedAt = now;
  const { result, isError } = await h.callJson("gma3_observe_tempo", { sequences: [907, 908, 909], seconds: 1.2, interval_ms: 20 });
  assert.equal(isError, false, JSON.stringify(result));
  const by = (n: number) => result.sequences.find((s: any) => s.sequence === n);
  for (const n of [907, 908, 909]) {
    assert.equal(by(n).configured.predictedStepMs, 200, String(n));
    assert.ok(by(n).observed.cueChanges >= 4, `${n}: ${JSON.stringify(by(n).observed)}`);
    assert.ok(Math.abs(by(n).observed.meanStepMs - 200) < 40, `${n}: ${by(n).observed.meanStepMs}`);
  }
  assert.equal(by(907).configured.rate, 2);
  assert.deepEqual(by(907).configured.rateSource, { kind: "speed master", master: 14, name: "Speed14", effectiveBpm: 120 });
  assert.equal(by(909).configured.rateSource.kind, "own rate fader");
  assert.equal(by(908).configured.speedMaster.observable, false);
  assert.ok(by(907).observed.changes.every((x: any) => typeof x.cue === "number"));
  const missing = await h.callJson("gma3_observe_tempo", { sequences: [999], seconds: 1 });
  assert.match(missing.text, /Sequence 999 does not exist/);
});
