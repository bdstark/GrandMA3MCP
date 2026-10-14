import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { registerTimecodeTools, parseTime, formatTime, toRaw, displaySeconds, orderEvents, pairProblems, parseTrack, tcSlotOf, matchEvents, RAW_PER_SECOND } from "../src/tools/timecode.ts";
import { ValidationError } from "../src/validate.ts";

// ---------------------------------------------------------------------------
// Time and event model
// ---------------------------------------------------------------------------

test("times: seconds, clock text, frames at a rate; rounding to 1/16777216 s", () => {
  assert.deepEqual(parseTime("t", 2.5), { seconds: 2.5, raw: 2.5 * RAW_PER_SECOND });
  assert.equal(parseTime("t", "1:02.5").seconds, 62.5);
  assert.equal(parseTime("t", "1:00:00.250").seconds, 3600.25);
  assert.equal(parseTime("t", "0:00:02:12", 25).seconds, 2.48);
  assert.equal(parseTime("t", { frames: 90, fps: 30 }).seconds, 3);
  assert.equal(parseTime("t", 1 / 3).raw, Math.round(RAW_PER_SECOND / 3), "rounded to the nearest console unit");
  for (const [v, re] of [["0:00:02:12", /give fps/], ["0:00:01:25", /frame 25 does not exist/], ["1:75", /above 59/], ["soon", /must be seconds/], [-1, />= 0/], [{ frames: 1, fps: 29.97 }, /fps must be one of/]] as const) {
    assert.throws(() => parseTime("t", v, String(v) === "0:00:01:25" ? 25 : undefined), (e: unknown) => e instanceof ValidationError && re.test(e.message), JSON.stringify(v));
  }
  assert.equal(formatTime(toRaw(62.5)), "0:01:02.500");
  assert.equal(formatTime(toRaw(2.48), 25), "0:00:02:12");
  assert.equal(displaySeconds("1.60"), 1.6);
  assert.equal(displaySeconds("1h00m00.00"), 3600);
  assert.equal(displaySeconds("x"), null);
  assert.deepEqual(tcSlotOf("-1"), { source: "internal" });
  assert.deepEqual(tcSlotOf("0"), { source: "slot", slot: 1 });
});

test("events: actions, cues, time order with the given order at the same time, press/release pairs", () => {
  const tr = parseTrack("t", { sequence: 9, events: [{ at: 2, action: "go" }, { at: 1, action: "goto", cue: 3 }, { at: 2, action: "off" }, { at: 1, action: "flash_press" }, { at: 1.5, action: "flash_release" }] }, undefined);
  assert.deepEqual(orderEvents(tr.events).map((e) => e.action), ["goto", "flash_press", "flash_release", "go", "off"]);
  assert.equal(tr.events[1].cue, "Sequence 9 Cue 3");
  assert.deepEqual(pairProblems(tr.events), []);
  assert.match(pairProblems(parseTrack("t", { sequence: 9, events: [{ at: 1, action: "temp_press" }] }, undefined).events).join(), /never released/);
  assert.match(pairProblems(parseTrack("t", { sequence: 9, events: [{ at: 1, action: "flash_release" }] }, undefined).events).join(), /without a press/);
  assert.throws(() => parseTrack("t", { sequence: 9, events: [{ at: 1, action: "goto" }] }, undefined), /needs a cue/);
  assert.throws(() => parseTrack("t", { sequence: 9, events: [{ at: 1, action: "go", cue: 2 }] }, undefined), /takes no cue/);
  assert.throws(() => parseTrack("t", { sequence: 9, events: [{ at: 1, action: "record" }] }, undefined), /action must be one of/);
  assert.throws(() => parseTrack("t", { preset: 4, events: [] }, undefined), /not a track field/);
});

// ---------------------------------------------------------------------------
// Fake console
// ---------------------------------------------------------------------------

interface FEvent { raw: number; token: string; status?: string; cue?: { seq: number; no: number } }
interface FTrack { target: number | null; events: FEvent[] }
interface FShow { name: string; groups: FTrack[][]; settings: Record<string, string>; cursor: number; playing?: { since: number; from: number }; applied: number }
interface FSeq { cues: number[]; cue: number | null; active: boolean }

class Console {
  shows = new Map<number, FShow>();
  seqs = new Map<number, FSeq>();
  commands: string[] = [];
  edits: string[] = [];
  /** A read that loses its events, and a set_target the console drops. */
  dropEvents = false;
  dropTarget = false;
  /** Fields the read leaves out. */
  omit = new Set<string>();

  seq(n: number, cues = [1, 2, 3]) {
    this.seqs.set(n, { cues, cue: null, active: false });
  }
  show(n: number): FShow {
    const s: FShow = { name: `Timecode ${n}`, groups: [], settings: { LoopMode: "Loop", TCSlot: "-1", SwitchOff: "Keep Playbacks", AssertPrevEvents: "Yes", Lock: "" }, cursor: 0, applied: 0 };
    this.shows.set(n, s);
    return s;
  }
  duration(s: FShow) {
    return Math.max(0, ...s.groups.flat().flatMap((t) => t.events.map((e) => e.raw / RAW_PER_SECOND)));
  }
  /** Advance a playing show: apply the events the cursor passed, in time order (storage order at the same time). */
  tick(s: FShow) {
    if (!s.playing) return;
    let cur = s.playing.from + (Date.now() - s.playing.since) / 1000;
    const end = this.duration(s);
    if (s.settings.LoopMode === "Off" && cur >= end) { cur = end; }
    const all = s.groups.flat().flatMap((t) => t.events.map((e, i) => ({ e, i, t }))).sort((a, b) => a.e.raw - b.e.raw || a.i - b.i);
    for (const { e, t } of all) {
      const at = e.raw / RAW_PER_SECOND;
      if (at <= s.cursor - 1e-9 || at > cur + 1e-9 || t.target === null) continue;
      const q = this.seqs.get(t.target);
      if (!q) continue;
      if (e.token === "Go+") { const i = q.cue === null || !q.active ? -1 : q.cues.indexOf(q.cue); q.cue = q.cues[Math.min(i + 1, q.cues.length - 1)]; q.active = true; }
      if (e.token === "Goto" && e.cue) { q.cue = e.cue.no; q.active = true; }
      if (e.token === "Off") q.active = false;
      if (e.token === "Flash") { if (e.status === "On") { q.active = true; q.cue ??= q.cues[0]; } else q.active = false; }
    }
    s.cursor = cur;
    s.playing = { since: Date.now(), from: cur };
    if (s.settings.LoopMode === "Off" && cur >= end) s.playing = undefined;
  }
  read(n: number) {
    const s = this.shows.get(n)!;
    this.tick(s);
    const tracks: unknown[] = [];
    const ranges: unknown[] = [];
    const subtracks: unknown[] = [];
    const events: unknown[] = [];
    s.groups.forEach((g, gi) => g.forEach((t, ti) => {
      tracks.push({ group: gi + 1, track: ti + 1, name: t.target ? `<Sequence ${t.target}>` : `Track ${ti + 1}`, target: t.target && this.seqs.has(t.target) ? { class: "Sequence", no: t.target, addr: `seq.${t.target}`, name: `Sequence ${t.target}` } : null });
      ranges.push({ group: gi + 1, track: ti + 1, range: 1, rawStart: 0 });
      if (t.events.length) subtracks.push({ group: gi + 1, track: ti + 1, range: 1, subtrack: 1, class: "CmdSubTrack", count: t.events.length });
      if (!this.dropEvents) t.events.forEach((e, ei) => events.push({ group: gi + 1, track: ti + 1, range: 1, subtrack: 1, index: ei + 1, raw: e.raw, token: e.token, name: e.status === "Off" ? `${e.token}(Release)` : e.token, ...(e.status ? { status: e.status } : {}), cue: e.cue ? { sequence: e.cue.seq, no: e.cue.no * 1000, addr: `cue.${e.cue.seq}.${e.cue.no}` } : null }));
    }));
    const settings: Record<string, unknown> = { Name: s.name, Cursor: s.cursor.toFixed(2), RawDuration: Math.round(this.duration(s) * RAW_PER_SECOND), ...s.settings };
    for (const k of this.omit) delete settings[k];
    return { no: n, settings, ...(this.omit.has("playing") ? {} : { playing: !!s.playing }), groups: s.groups.map((_, i) => ({ group: i + 1 })), tracks, ranges, subtracks, events, eventCount: events.length, truncated: false };
  }

  install(h: Harness): void {
    h.fake.on("timecode.read", (args) => {
      const n = Number(args.timecode);
      if (!this.shows.has(n)) throw new Error(`[not-found] Timecode ${n} does not exist`);
      return this.read(n);
    });
    h.fake.on("timecode.edit", (args) => {
      const s = this.shows.get(Number(args.timecode))!;
      this.edits.push(String(args.action));
      const g = s.groups[Number(args.group) - 1];
      if (args.action === "add_group") { s.groups.push([{ target: null, events: [] }]); return { groups: s.groups.length }; }
      if (args.action === "add_track") { g.push({ target: null, events: [] }); return { tracks: g.length }; }
      const t = g[Number(args.track) - 1];
      if (args.action === "set_target") { const m = String(args.target).match(/^Sequence (\d+)$/)!; if (!this.dropTarget) t.target = Number(m[1]); return { target: { class: "Sequence", no: Number(m[1]) } }; }
      if (args.action === "add_events") {
        for (const e of args.events as Array<{ raw: number; token: string; status?: string; cue?: string }>) {
          const m = e.cue?.match(/^Sequence (\d+) Cue ([\d.]+)$/);
          t.events.push({ raw: e.raw, token: e.token, ...(e.status ? { status: e.status } : {}), ...(m ? { cue: { seq: Number(m[1]), no: Number(m[2]) } } : {}) });
        }
        return { added: (args.events as unknown[]).length };
      }
      throw new Error("[bad-args] action");
    });
    h.fake.on("objects", (args) => {
      const ref = String(args.ref);
      let m: RegExpMatchArray | null;
      if ((m = ref.match(/^Timecode (\d+)$/))) {
        const s = this.shows.get(Number(m[1]));
        if (!s) return { items: [] };
        this.tick(s);
        return { items: [{ name: s.name, fields: { Cursor: s.cursor.toFixed(2) } }] };
      }
      if ((m = ref.match(/^Sequence (\d+)$/))) {
        const q = this.seqs.get(Number(m[1]));
        if (!q) return { items: [] };
        for (const s of this.shows.values()) this.tick(s);
        return { items: [{ name: ref, fields: { CurrentCue: q.cue !== null ? { addr: `cue.${m[1]}.${q.cue}` } : undefined } }] };
      }
      if ((m = ref.match(/^Sequence (\d+) Cue ([\d.]+)$/))) return { items: this.seqs.get(Number(m[1]))?.cues.includes(Number(m[2])) ? [{ name: ref }] : [] };
      return { items: [] };
    });
    h.fake.on("object", (args) => {
      const ref = String(args.ref);
      let m: RegExpMatchArray | null;
      if ((m = ref.match(/^Timecode (\d+)$/))) { const s = this.shows.get(Number(m[1]))!; this.tick(s); return { hasActivePlayback: !!s.playing }; }
      if ((m = ref.match(/^Sequence (\d+)$/))) return { hasActivePlayback: this.seqs.get(Number(m[1]))?.active ?? false };
      return {};
    });
    h.fake.on("children", (args) => {
      const m = String(args.ref).match(/^Sequence (\d+)$/);
      if (m) return { items: [{ fields: {} }, { fields: { No: 0 } }, ...this.seqs.get(Number(m[1]))!.cues.map((c) => ({ addr: `cue.${m[1]}.${c}`, fields: { No: c * 1000 } }))] };
      if (args.ref === "DataPool.Timecodes") return { items: [...this.shows].map(([n, s]) => ({ index: n, name: s.name, childCount: s.groups.length, fields: { Name: s.name } })) };
      return { items: [] };
    });
    h.fake.on("set", (args) => {
      const s = this.shows.get(Number(String(args.ref).replace("Timecode ", "")))!;
      const p = String(args.property);
      if (p === "Name") s.name = String(args.value);
      else if (p === "Cursor") { s.cursor = Number(args.value); if (s.playing) s.playing = { since: Date.now(), from: s.cursor }; }
      else s.settings[p] = String(args.value);
      return { value: p === "Name" ? s.name : p === "Cursor" ? s.cursor.toFixed(2) : s.settings[p] };
    });
    h.fake.on("cmd", (args) => {
      const c = String(args.command);
      this.commands.push(c);
      let m: RegExpMatchArray | null;
      if ((m = c.match(/^Store Timecode (\d+) \/NoConfirmation$/))) { this.show(Number(m[1])); return { feedback: "OK" }; }
      if ((m = c.match(/^Delete Timecode (\d+)\.(\d+) \/NoConfirmation$/))) { this.shows.get(Number(m[1]))!.groups.splice(Number(m[2]) - 1, 1); return { feedback: "OK" }; }
      if ((m = c.match(/^Go Timecode (\d+)$/))) { const s = this.shows.get(Number(m[1]))!; s.playing = { since: Date.now(), from: s.cursor }; return { feedback: "OK" }; }
      if ((m = c.match(/^Off Timecode (\d+)$/))) { const s = this.shows.get(Number(m[1]))!; this.tick(s); s.playing = undefined; return { feedback: "OK" }; }
      if ((m = c.match(/^Top Timecode (\d+)$/))) { const s = this.shows.get(Number(m[1]))!; s.cursor = 0; if (s.playing) s.playing = { since: Date.now(), from: 0 }; return { feedback: "OK" }; }
      throw new Error(`unexpected command ${c}`);
    });
  }
}

let h: Harness;
let con: Console;
before(async () => {
  h = await startHarness(registerTimecodeTools, { requestTimeoutMs: 2000 });
});
after(async () => {
  await h.close();
});
beforeEach(() => {
  h.fake.reset();
  con = new Console();
  con.install(h);
  con.seq(908);
  con.seq(909, [1]);
});
const stepError = (r: any, name: string) => r.steps?.find((s: { name: string }) => s.name === name)?.error ?? "";
const playing = () => con.commands.filter((c) => /^(Go|Record|Top|Off) Timecode/.test(c));
const SHOW = [
  { sequence: 908, events: [{ at: 0.3, action: "go" }, { at: 0.6, action: "go" }, { at: 0.8, action: "goto", cue: 1 }, { at: 1.0, action: "off" }] },
  { sequence: 909, events: [{ at: 0.2, action: "flash_press" }, { at: 0.7, action: "flash_release" }] },
];

// ---------------------------------------------------------------------------
// gma3_build_timecode
// ---------------------------------------------------------------------------

test("create builds the group, the tracks, targets and events in time order, verifies them and never plays", async () => {
  const { result, isError } = await h.callJson("gma3_build_timecode", { timecode: 901, mode: "create", name: "Opening", fps: 25, settings: { loop_mode: "off", tc_slot: "internal", switch_off: "off" }, tracks: SHOW });
  assert.equal(isError, false, JSON.stringify(result.steps.filter((s: any) => s.status !== "succeeded")));
  assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
  assert.deepEqual(playing(), [], "editing never plays or records");
  assert.equal(result.played, false);
  assert.deepEqual(con.edits, ["add_group", "add_track", "set_target", "set_target", "add_events", "add_events"]);
  const s = con.shows.get(901)!;
  assert.deepEqual(s.groups[0][0].events.map((e) => [e.raw, e.token]), [[toRaw(0.3), "Go+"], [toRaw(0.6), "Go+"], [toRaw(0.8), "Goto"], [toRaw(1), "Off"]]);
  assert.deepEqual(s.groups[0][1].events.map((e) => [e.token, e.status]), [["Flash", "On"], ["Flash", "Off"]]);
  assert.deepEqual([s.name, s.settings.LoopMode, s.settings.TCSlot, s.settings.SwitchOff], ["Opening", "Off", "-1", "Playbacks Off"]);
  assert.deepEqual(result.show.tracks[0].events.map((e: any) => e.time), ["0:00:00:08", "0:00:00:15", "0:00:00:20", "0:00:01:00"]);
});

test("targets and cues are checked first; modes, playing shows and unpaired presses are refused", async () => {
  const missing = await h.callJson("gma3_build_timecode", { timecode: 901, mode: "create", tracks: [{ sequence: 950, events: [{ at: 1, action: "go" }] }, { sequence: 908, events: [{ at: 1, action: "goto", cue: 7 }] }] });
  assert.match(stepError(missing.result, "check_targets"), /not in the show: Sequence 950, Sequence 908 Cue 7/);
  assert.equal(con.commands.length, 0);
  con.show(901);
  const exists = await h.callJson("gma3_build_timecode", { timecode: 901, mode: "create", tracks: SHOW });
  assert.match(stepError(exists.result, "read_timecode"), /already exists.*use mode replace or append/);
  const noShow = await h.callJson("gma3_build_timecode", { timecode: 902, mode: "append", tracks: SHOW });
  assert.match(stepError(noShow.result, "read_timecode"), /does not exist; use mode create/);
  con.shows.get(901)!.playing = { since: Date.now(), from: 0 };
  const busy = await h.callJson("gma3_build_timecode", { timecode: 901, mode: "replace", tracks: SHOW });
  assert.match(stepError(busy.result, "read_timecode"), /is playing; stop it first/);
  const unpaired = await h.callJson("gma3_build_timecode", { timecode: 903, mode: "create", tracks: [{ sequence: 909, events: [{ at: 1, action: "flash_press" }] }] });
  assert.match(unpaired.result.validationErrors.join(), /never released.*allow_unpaired/);
  assert.equal(con.commands.length, 0);
});

test("replace removes the groups and keeps the show; append keeps the earlier groups", async () => {
  await h.callJson("gma3_build_timecode", { timecode: 901, mode: "create", tracks: [SHOW[0]] });
  con.commands = [];
  const rep = await h.callJson("gma3_build_timecode", { timecode: 901, mode: "replace", tracks: [SHOW[1]] });
  assert.equal(rep.result.verification.status, "matched", JSON.stringify(rep.result.verification));
  assert.deepEqual(con.commands, ["Delete Timecode 901.1 /NoConfirmation"]);
  const app = await h.callJson("gma3_build_timecode", { timecode: 901, mode: "append", tracks: [SHOW[0]] });
  assert.equal(app.result.verification.status, "matched", JSON.stringify(app.result.verification));
  assert.equal(app.result.group, 2);
  assert.equal(con.shows.get(901)!.groups.length, 2);
});

test("a read-back that lost the target or the events is a mismatch", async () => {
  con.dropTarget = true;
  const t = await h.callJson("gma3_build_timecode", { timecode: 901, mode: "create", tracks: [SHOW[0]] });
  assert.equal(t.result.verification.status, "mismatched");
  assert.match(t.result.verification.detail, /track 1 targets nothing, not Sequence 908/);
  con.dropTarget = false;
  con.shows.clear();
  con.dropEvents = true;
  const e = await h.callJson("gma3_build_timecode", { timecode: 901, mode: "create", tracks: [SHOW[0]] });
  assert.match(e.result.verification.detail, /track 1 has 0 event\(s\), 4 expected/);
});

// ---------------------------------------------------------------------------
// gma3_timecodes and gma3_timecode_transport
// ---------------------------------------------------------------------------

test("read lists the pool and one show; a deleted target is a problem", async () => {
  await h.callJson("gma3_build_timecode", { timecode: 901, mode: "create", name: "Opening", tracks: SHOW });
  const pool = await h.callJson("gma3_timecodes", {});
  assert.deepEqual(pool.result.timecodes, [{ timecode: 901, name: "Opening", groups: 1 }]);
  con.seqs.delete(909);
  const one = await h.callJson("gma3_timecodes", { timecode: 901, fps: 30 });
  assert.equal(one.result.tracks[0].events[2].action, "goto");
  assert.deepEqual(one.result.tracks[0].events[2].cue, { sequence: 908, cue: 1 });
  assert.equal(one.result.tracks[0].events[1].time, "0:00:00:18");
  assert.match(one.result.problems.join(), /group 1 track 2 has no target .*its 2 event\(s\) do nothing/);
  assert.deepEqual(one.result.source.tcSlot, { source: "internal" });
  assert.match(one.result.recording.armed, /never record/);
});

test("play checks the crossed events against the observed cue changes in order; stop, rewind and seek are verified", async () => {
  await h.callJson("gma3_build_timecode", { timecode: 901, mode: "create", settings: { loop_mode: "off" }, tracks: SHOW });
  const play = await h.callJson("gma3_timecode_transport", { timecode: 901, action: "play", observe_seconds: 1.6, interval_ms: 20 });
  assert.equal(play.isError, false, JSON.stringify(play.result));
  assert.equal(play.result.verification.status, "matched", JSON.stringify(play.result.verification));
  assert.deepEqual(play.result.events.filter((e: any) => e.sequence === 908).map((e: any) => [e.action, e.expected?.cue, e.expected?.active, !!e.observed]), [["go", 1, true, true], ["go", 2, true, true], ["goto", 1, true, true], ["off", 1, false, true]]);
  assert.equal(play.result.execution.dispatched, true);
  assert.equal(play.result.execution.observed.playing, false, "LoopMode off stops at the end");
  // Repeated playback: rewind and play again.
  const top = await h.callJson("gma3_timecode_transport", { timecode: 901, action: "rewind" });
  assert.equal(top.result.verification.status, "matched", JSON.stringify(top.result.verification));
  con.seqs.get(908)!.active = false;
  const again = await h.callJson("gma3_timecode_transport", { timecode: 901, action: "play", observe_seconds: 1.6, interval_ms: 20 });
  assert.equal(again.result.verification.status, "matched");
  // Seek past the Go events, play: only the later events are crossed.
  const seek = await h.callJson("gma3_timecode_transport", { timecode: 901, action: "seek", to: 0.75 });
  assert.equal(seek.result.verification.status, "matched", JSON.stringify(seek.result.verification));
  const late = await h.callJson("gma3_timecode_transport", { timecode: 901, action: "play", observe_seconds: 1, interval_ms: 20 });
  assert.deepEqual(late.result.events.map((e: any) => e.action), ["goto", "off"]);
  const stop = await h.callJson("gma3_timecode_transport", { timecode: 901, action: "stop" });
  assert.equal(stop.result.verification.status, "matched");
  assert.ok(!con.commands.some((c) => c.startsWith("Record")), "recording is never sent");
});

test("a play whose events do not show up is a mismatch", async () => {
  await h.callJson("gma3_build_timecode", { timecode: 901, mode: "create", settings: { loop_mode: "off" }, tracks: [SHOW[0]] });
  con.seqs.get(908)!.cues = [1, 2, 3];
  // The sequence does not react: break the fake's playback for it.
  const q = con.seqs.get(908)!;
  Object.defineProperty(q, "cue", { get: () => null, set: () => {} });
  Object.defineProperty(q, "active", { get: () => false, set: () => {} });
  const play = await h.callJson("gma3_timecode_transport", { timecode: 901, action: "play", observe_seconds: 1.4, interval_ms: 20 });
  assert.equal(play.isError, true);
  assert.equal(play.result.verification.status, "mismatched");
});

// ---------------------------------------------------------------------------
// Review 1 regressions
// ---------------------------------------------------------------------------

test("an unknown lock or playback state refuses changing an existing show", async () => {
  await h.callJson("gma3_build_timecode", { timecode: 901, mode: "create", tracks: [SHOW[0]] });
  con.commands = [];
  con.shows.get(901)!.playing = { since: Date.now(), from: 0 };
  con.omit.add("playing");
  const p = await h.callJson("gma3_build_timecode", { timecode: 901, mode: "replace", tracks: [SHOW[1]] });
  assert.match(stepError(p.result, "read_timecode"), /whether Timecode 901 is playing could not be read/);
  con.omit = new Set(["Lock"]);
  con.shows.get(901)!.playing = undefined;
  const l = await h.callJson("gma3_build_timecode", { timecode: 901, mode: "append", tracks: [SHOW[1]] });
  assert.match(stepError(l.result, "read_timecode"), /the Lock of Timecode 901 could not be read/);
  assert.deepEqual(con.commands, [], "no group was deleted or added");
  assert.equal(con.shows.get(901)!.groups.length, 1);
});

const ev = (seconds: number, sequence: number, action: any, cue?: number) => ({ seconds, time: `${seconds}`, sequence, action, ...(cue !== undefined ? { cue } : {}) });
const initial = () => new Map([[1, { cue: null, active: false }], [2, { cue: null, active: false }]]);
const cues = new Map([[1, [1, 2, 3]], [2, [1, 2, 3]]]);

test("events on two sequences seen in the same sample both match; their order is reported as unresolved", () => {
  const m = matchEvents({
    events: [ev(0.02, 1, "goto", 2), ev(0.04, 2, "goto", 3)],
    // One sample saw both: sequence 2's read came after sequence 1's in that sample.
    changes: [{ ms: 100, cursor: 0.05, sequence: 1, cue: 2, active: true }, { ms: 100, cursor: 0.05, sequence: 2, cue: 3, active: true }],
    initial: initial(),
    cues,
    skew: 0.06,
  });
  assert.deepEqual(m.events.map((e) => e.result), ["matched", "matched"]);
  assert.equal(m.unresolved.length, 1);
  const v = m.verification("x");
  assert.equal(v.status, "matched", JSON.stringify(v));
  assert.match(v.detail!, /order of 1 pair.* not resolved by the sampling/);
  // Seen in the opposite order by a later sample of sequence 2: still resolved per sequence, not a cross-sequence inversion.
  const m2 = matchEvents({ events: [ev(0.02, 1, "goto", 2), ev(0.04, 2, "goto", 3)], changes: [{ ms: 90, cursor: 0.04, sequence: 2, cue: 3, active: true }, { ms: 110, cursor: 0.06, sequence: 1, cue: 2, active: true }], initial: initial(), cues, skew: 0.06 });
  assert.equal(m2.verification("x").status, "matched");
});

test("an earlier unrelated change cannot verify a later event", () => {
  const m = matchEvents({ events: [ev(0.3, 1, "goto", 2)], changes: [{ ms: 20, cursor: 0.02, sequence: 1, cue: 2, active: true }], initial: initial(), cues, skew: 0.06 });
  assert.equal(m.events[0].result, "missed");
  assert.equal(m.verification("x").status, "mismatched");
  const later = matchEvents({ events: [ev(0.3, 1, "goto", 2)], changes: [{ ms: 20, cursor: 0.02, sequence: 1, cue: 1, active: true }, { ms: 310, cursor: 0.31, sequence: 1, cue: 2, active: true }], initial: initial(), cues, skew: 0.06 });
  assert.equal(later.events[0].result, "matched");
  assert.equal(later.events[0].observed!.cursor, 0.31);
  // Within the read skew before the event (the cursor is read before the sequence): accepted.
  const skewed = matchEvents({ events: [ev(0.5, 1, "goto", 2)], changes: [{ ms: 500, cursor: 0.46, sequence: 1, cue: 2, active: true }], initial: initial(), cues, skew: 0.06 });
  assert.equal(skewed.events[0].result, "matched");
});

test("a change after the next event's window is not taken; resolvable cross-sequence inversions are mismatches", () => {
  // Sequence 1: goto 2 at 0.2, goto 3 at 1.0; only cue 2 is seen, at 1.5 (after the next event): goto 2 is missed.
  const m = matchEvents({ events: [ev(0.2, 1, "goto", 2), ev(1.0, 1, "goto", 3)], changes: [{ ms: 1500, cursor: 1.5, sequence: 1, cue: 2, active: true }], initial: initial(), cues, skew: 0.06 });
  assert.deepEqual(m.events.map((e) => e.result), ["missed", "missed"]);
  // Two sequences 1 s apart, observed the wrong way round (both inside their own windows): an inversion.
  const inv = matchEvents({ events: [ev(0.1, 1, "goto", 2), ev(1.1, 2, "goto", 3)], changes: [{ ms: 1200, cursor: 0.1, sequence: 1, cue: 2, active: true }, { ms: 1150, cursor: 1.1, sequence: 2, cue: 3, active: true }], initial: initial(), cues, skew: 0.06 });
  assert.equal(inv.inversions.length, 1);
  assert.equal(inv.verification("x").status, "mismatched");
  // An event whose sequence is already in the expected state is not observable, and alone is unavailable.
  const same = matchEvents({ events: [ev(0.2, 1, "off")], changes: [], initial: initial(), cues, skew: 0.06 });
  assert.equal(same.events[0].result, "unchanged");
  assert.equal(same.verification("x").status, "unavailable");
});
