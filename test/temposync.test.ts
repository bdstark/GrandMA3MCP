/**
 * SU-17: ReSync in gma3_playback, and the tempo-sync plugin's status and configuration tools, against an in-process
 * FakeBridge. The fake console holds global variables (BeatSync.*), a plugin pool, sequences with playback state, a
 * console clock (show.files) and the command line.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { registerTempoSyncTools, resyncPlayback, sequenceList, statusView, planConfig, PLUGIN_NAME } from "../src/tools/temposync.ts";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { SILENT } from "./helpers/fake-bridge.ts";

class Console {
  now = 1792180000;
  vars = new Map<string, string>();
  plugins = ["gma3_mcp_bridge", "gma3_beat_sync"];
  sequences = new Map<number, { active: boolean; cue?: number }>([[1, { active: true, cue: 2 }], [11, { active: true, cue: 1 }], [12, { active: false, cue: 3 }], [13, { active: true, cue: 1 }]]);
  commands: string[] = [];
  feedback = "OK";
  /** Variables the console keeps unchanged when written. */
  ignore = new Set<string>();
  install(h: Harness) {
    h.fake.on("children", (args) => {
      if (args.ref !== "DataPool.Plugins") throw new Error("unexpected");
      const all = this.plugins.map((name, i) => ({ name, index: i + 1 }));
      const offset = Number(args.offset ?? 0);
      const limit = Number(args.limit ?? 100);
      return { total: all.length, offset, count: Math.min(limit, Math.max(0, all.length - offset)), items: all.slice(offset, offset + limit) };
    });
    h.fake.on("vars.get", ({ names }) => ({ items: (names as string[]).map((n) => (this.vars.has(n) ? { name: n, exists: true, value: this.vars.get(n), type: "text" } : { name: n, exists: false })) }));
    // As the bridge answers: before and after reads of the variable.
    const read = (n: string) => (this.vars.has(n) ? { name: n, exists: true, value: this.vars.get(n), type: "text" } : { name: n, exists: false });
    h.fake.on("vars.set", ({ name, value, type }) => {
      assert.equal(type, "text");
      const before = read(String(name));
      if (!this.ignore.has(String(name))) this.vars.set(String(name), String(value));
      return { scope: "global", before, after: read(String(name)) };
    });
    h.fake.on("vars.delete", ({ name }) => {
      const before = read(String(name));
      if (!this.ignore.has(String(name))) this.vars.delete(String(name));
      return { scope: "global", before, after: read(String(name)) };
    });
    h.fake.on("show.files", () => ({ now: this.now, files: [], current: "x" }));
    h.fake.on("objects", (args) => {
      const m = String(args.ref).match(/^Sequence (\d+)$/);
      return { total: m && this.sequences.has(Number(m[1])) ? 1 : 0, items: [] };
    });
    h.fake.on("object", (args) => {
      const n = Number(String(args.ref).match(/^Sequence (\d+)$/)?.[1]);
      const s = this.sequences.get(n);
      if (!s) throw new Error("no object");
      return { name: `Seq ${n}`, class: "Sequence", hasActivePlayback: s.active, ...(s.cue ? { currentCue: { no: s.cue, name: `Cue ${s.cue}` } } : {}) };
    });
    h.fake.onCommand((command) => {
      this.commands.push(command);
      return this.feedback;
    });
  }
  following() {
    const iso = new Date(this.now * 1000 - 300).toISOString();
    for (const [k, v] of Object.entries({ State: "following", Peers: "2", Session: "0123456789abcdef", Tempo: "128.000", Beat: "37", Phase: "0.25", Playing: "yes", LastAction: "Go+ Sequence 1: OK", DriftMsPerMin: "0.4", FrameMs: "16.7", FrameJitterMs: "0.9", DroppedFrames: "0", MissedBeats: "0", Version: "0.1.0", Updated: iso })) this.vars.set(`BeatSync.${k}`, v);
  }
}

let h: Harness;
let con: Console;
before(async () => {
  h = await startHarness(registerTempoSyncTools, { requestTimeoutMs: 1500 });
});
after(() => h.close());
beforeEach(() => {
  h.fake.reset();
  con = new Console();
  con.install(h);
});

// ---------------------------------------------------------------------------
// ReSync
// ---------------------------------------------------------------------------

test("sequenceList: lists, ranges in either direction, no duplicates; other targets are not sequence lists", () => {
  assert.deepEqual(sequenceList("Sequence 1 + 11 Thru 13 + 31"), [1, 11, 12, 13, 31]);
  assert.deepEqual(sequenceList("sequence 5 thru 3 + 4"), [3, 4, 5]);
  assert.equal(sequenceList("Executor 201"), null);
  assert.throws(() => sequenceList("Sequence 1 + x"), /not a sequence number/);
  assert.throws(() => sequenceList("Sequence 1 Thru 500"), /at most 100/);
  assert.throws(() => sequenceList("Sequence 0"), /whole numbers 1-99999/);
});

test("resync: every sequence checked, ReSync sent once, each state read a frame later; the note says what it does", async () => {
  const r = await resyncPlayback(h.ctx, "Sequence 1 + 11 Thru 13");
  assert.equal(r.outcome, "succeeded", JSON.stringify(r.steps));
  assert.equal(r.verification.status, "matched");
  assert.deepEqual(con.commands, ["ReSync Sequence 1 + 11 Thru 13"]);
  assert.deepEqual((r.states as Array<{ sequence: number; active: boolean }>).map((s) => [s.sequence, s.active]), [[1, true], [11, true], [12, false], [13, true]]);
  assert.match(r.summary, /Not playing \(nothing to realign\): Sequence 12/);
  assert.match(String(r.note), /gradually moves the start point of the phasers/);
});

test("resync: a missing sequence refuses before anything is sent; a refused command and a lost reply are not resent", async () => {
  const missing = await resyncPlayback(h.ctx, "Sequence 1 + 99");
  assert.equal(missing.outcome, "failed");
  assert.match(String(missing.steps.at(-1)!.error), /Sequence 99 does not exist; ReSync was not sent/);
  assert.deepEqual(con.commands, []);
  const bad = await resyncPlayback(h.ctx, "Sequence x");
  assert.match((bad.validationErrors ?? []).join(" "), /not a sequence number/);
  con.feedback = "Error #72: Command not executed";
  const refused = await resyncPlayback(h.ctx, "Sequence 1");
  assert.equal(refused.outcome, "failed");
  assert.equal(refused.verification.status, "unavailable");
  h.fake.on("cmd", () => SILENT);
  const lost = await resyncPlayback(h.ctx, "Sequence 1");
  assert.equal(lost.verification.status, "unavailable");
  assert.match(String(lost.verification.detail), /not resent/);
  assert.equal(h.fake.requests.filter((x) => x.op === "cmd").length, 2, "one command per call");
});

test("resync: an executor target is sent without a sequence read-back", async () => {
  con.feedback = "OK";
  const r = await resyncPlayback(h.ctx, "Executor 201");
  assert.equal(r.outcome, "succeeded");
  assert.deepEqual(con.commands, ["ReSync Executor 201"]);
  assert.equal(r.verification.status, "not_requested");
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

test("statusView: not imported, never run, stopped, stale, unknown clock, running", () => {
  const vars = (o: Record<string, string>) => new Map(Object.entries(o));
  const now = 1792180000;
  const fresh = new Date(now * 1000 - 500).toISOString();
  assert.match(statusView({ installed: false }, vars({}), now).explanation, /not imported in this show.*Plugin "gma3_beat_sync"/);
  assert.match(statusView({ installed: true }, vars({}), now).explanation, /not running \(it has never published a status/);
  const stopped = statusView({ installed: true }, vars({ State: "not running", Updated: fresh }), now);
  assert.equal(stopped.running, false);
  assert.match(stopped.explanation, /After a show load it is always stopped/);
  const stale = statusView({ installed: true }, vars({ State: "following", Updated: new Date((now - 3600) * 1000).toISOString(), Tempo: "120" }), now);
  assert.equal(stale.running, false);
  assert.match(stale.explanation, /last written 3600 s ago/);
  assert.match(String(stale.valuesNote), /not live/);
  assert.equal(statusView({ installed: true }, vars({ State: "following", Updated: fresh }), null).running, null);
  const run = statusView({ installed: true, slot: 2 }, vars({ State: "following", Updated: fresh, Tempo: "128.000", Peers: "2", Playing: "yes", LastAction: "Go+ Macro 3: failed: Error #12", Problems: "Master 3.17 does not exist; Sequence 99 missing" }), now);
  assert.equal(run.running, true);
  assert.equal(run.tempo, 128);
  assert.equal(run.playing, true);
  assert.deepEqual(run.lastAction, { text: "Go+ Macro 3: failed: Error #12", result: "failed" });
  assert.deepEqual(run.problems, ["Master 3.17 does not exist", "Sequence 99 missing"]);
  assert.match(run.explanation, /following a session at 128.000 BPM with 2 peer\(s\), playing/);
  assert.match(statusView({ installed: true }, null, now, "boom").explanation, /could not be read \(boom\)/);
});

test("gma3_tempo_sync_status: plugin slot, live readings, configuration with defaults; plainly not running after a show load", async () => {
  con.following();
  con.vars.set("BeatSync.Master", "12");
  const r = await h.callJson("gma3_tempo_sync_status", {});
  assert.equal(r.isError, false, r.text);
  assert.equal(r.result.plugin, PLUGIN_NAME);
  assert.equal(r.result.installed, true);
  assert.equal(r.result.slot, 2);
  assert.equal(r.result.running, true);
  assert.equal(r.result.tempo, 128);
  assert.equal(r.result.configuration.Master, "12");
  assert.deepEqual(r.result.configuration.Quantum, { value: null, default: "4" });
  assert.deepEqual(r.result.configuration.Interfaces, { value: null, default: "127.0.0.1 0.0.0.0" });
  // After a show load: the saved status says "following", but it is an hour old.
  con.now += 3600;
  const loaded = await h.callJson("gma3_tempo_sync_status", {});
  assert.equal(loaded.result.running, false);
  assert.match(loaded.result.explanation, /not running: its status was last written/);
  con.plugins = ["gma3_mcp_bridge"];
  const gone = await h.callJson("gma3_tempo_sync_status", {});
  assert.equal(gone.result.installed, false);
  assert.match(gone.result.explanation, /not imported/);
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test("planConfig: validation, and Interfaces (a network setting) is refused", () => {
  const e = (raw: Record<string, unknown>) => planConfig(raw).errors.join(" | ");
  assert.match(e({ master: 17 }), /master must be an integer 1-16/);
  assert.match(e({ quantum: 0 }), /quantum must be an integer 1-64/);
  assert.match(e({ start_stop: "maybe" }), /start_stop/);
  assert.match(e({ actions: [{ slot: 1, every: 4, phase: 4, command: "Go+ Macro 1" }] }), /phase must be below every/);
  assert.match(e({ actions: [{ slot: 1, clear: true }, { slot: 1, clear: true }] }), /appears more than once/);
  assert.match(e({ actions: [{ slot: 17, clear: true }] }), /slot must be 1-16/);
  assert.match(e({ on_bar: "Go+\nMacro 1" }), /without control characters/);
  assert.match(e({ lead_ms: 500 }), /lead_ms must be a number 0-200/);
  assert.match(e({ interfaces: "0.0.0.0" }), /network setting/);
  assert.match(e({ resync: "1 + x" }), /not a sequence number/);
  const ok = planConfig({ master: 12, resync: "1 + 11 Thru 12", actions: [{ slot: 3, every: 8, phase: 4, command: "Go+ Macro 5" }], on_bar: null });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.writes, [{ key: "Master", value: "12" }, { key: "Resync", value: "1,11,12" }, { key: "OnBar", value: null }, { key: "Action3", value: "8 4 Go+ Macro 5" }]);
  assert.deepEqual(ok.sequences, [1, 11, 12]);
});

test("configure_tempo_sync: writes text variables, clears with null, skips unchanged, reads back; warns when the plugin is not running", async () => {
  con.vars.set("BeatSync.OnBar", "Go+ Macro 1");
  con.vars.set("BeatSync.Quantum", "4");
  const r = await h.callJson("gma3_configure_tempo_sync", { master: 12, quantum: 4, on_bar: null, resync: [1, 11], actions: [{ slot: 2, every: 4, phase: 0, command: "Go+ Sequence 13" }] });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.result.verification.status, "matched");
  assert.equal(con.vars.get("BeatSync.Master"), "12");
  assert.equal(con.vars.has("BeatSync.OnBar"), false);
  assert.equal(con.vars.get("BeatSync.Resync"), "1,11");
  assert.equal(con.vars.get("BeatSync.Action2"), "4 0 Go+ Sequence 13");
  assert.ok(!h.fake.requests.some((x) => x.op === "vars.set" && x.args.name === "BeatSync.Quantum"), "an unchanged value is not written");
  assert.equal(r.result.previous["BeatSync.OnBar"], "Go+ Macro 1");
  assert.ok(r.result.warnings.some((w: string) => /is not running: the configuration is stored/.test(w)));
  assert.ok(r.result.warnings.some((w: string) => /run on the console whenever the plugin fires them/.test(w)));
});

test("configure_tempo_sync: a missing resync sequence writes nothing; an ignored write is mismatched; a running plugin's problems are reported", async () => {
  const missing = await h.callJson("gma3_configure_tempo_sync", { master: 3, resync: [1, 99] });
  assert.equal(missing.result.outcome, "failed");
  assert.match(String(missing.result.steps.at(-1).error), /Sequence 99 does not exist; nothing was written/);
  assert.ok(!h.fake.requests.some((x) => x.op === "vars.set"));
  con.ignore.add("BeatSync.Master");
  const ignored = await h.callJson("gma3_configure_tempo_sync", { master: 5 });
  assert.equal(ignored.result.verification.status, "mismatched");
  con.ignore.clear();
  con.following();
  con.vars.set("BeatSync.Problems", "Master: speed master 3.16 is locked");
  const run = await h.callJson("gma3_configure_tempo_sync", { master: 16 });
  assert.equal(run.result.plugin.running, true);
  assert.ok(run.result.warnings.some((w: string) => /the plugin reports: Master: speed master 3.16 is locked/.test(w)), JSON.stringify(run.result.warnings));
  const none = await h.callJson("gma3_configure_tempo_sync", {});
  assert.match(none.result.validationErrors.join(" "), /nothing to change/);
});

// --- review of PR #67 -----------------------------------------------------------------------------

test("review 1: sequence numbers are bounded before any range loop (no hang at 2^53)", () => {
  assert.throws(() => sequenceList("Sequence 9007199254740992"), /whole numbers 1-99999/);
  assert.throws(() => sequenceList("Sequence 9007199254740991 Thru 9007199254740992"), /whole numbers/);
  assert.throws(() => sequenceList("Sequence 100000"), /whole numbers/);
  assert.match(planConfig({ resync: [9007199254740992] }).errors.join(" "), /whole numbers/);
  assert.match(planConfig({ resync: "9007199254740992" }).errors.join(" "), /whole numbers/);
  assert.match(planConfig({ resync: Array.from({ length: 101 }, (_, i) => i + 1) }).errors.join(" "), /at most 100/);
  assert.deepEqual(sequenceList("Sequence 99999"), [99999]);
});

test("review 1: an ignored write stops the call before later writes; an ignored delete too", async () => {
  con.ignore.add("BeatSync.Master");
  const r = await h.callJson("gma3_configure_tempo_sync", { master: 12, on_beat: "Go+ Macro 2" });
  assert.notEqual(r.result.outcome, "succeeded");
  assert.ok(r.result.steps.some((s: { name: string; status: string; error?: string }) => s.name === "BeatSync.Master" && s.status === "failed" && /kept BeatSync.Master null/.test(String(s.error))), r.text);
  assert.ok(r.result.steps.some((s: { name: string; status: string }) => s.name === "BeatSync.OnBeat" && s.status === "skipped"));
  assert.equal(con.vars.has("BeatSync.OnBeat"), false, "the later write was not sent");
  con.ignore.clear();
  con.vars.set("BeatSync.OnBar", "Go+ Macro 1");
  con.ignore.add("BeatSync.OnBar");
  // LeadMs comes after OnBar in the write order.
  const del = await h.callJson("gma3_configure_tempo_sync", { on_bar: null, lead_ms: 17 });
  assert.ok(del.result.steps.some((s: { name: string; status: string }) => s.name === "BeatSync.OnBar" && s.status === "failed"));
  assert.equal(con.vars.has("BeatSync.LeadMs"), false);
  // An answer without the variable's state is unknown and stops the call too.
  con.ignore.clear();
  h.fake.on("vars.set", () => ({ ok: true }));
  const odd = await h.callJson("gma3_configure_tempo_sync", { master: 4, quantum: 5 });
  assert.ok(odd.result.steps.some((s: { name: string; status: string }) => s.name === "BeatSync.Master" && s.status === "unknown"));
  assert.ok(odd.result.steps.some((s: { name: string; status: string }) => s.name === "BeatSync.Quantum" && s.status === "skipped"));
});

test("review 1: ReSync feedback uses the shared classification: refusals fail, missing or unfamiliar feedback is unknown", async () => {
  for (const [fb, status] of [["Access denied", "failed"], ["Error #72: Command not executed", "failed"], ["Hmm, something", "unknown"]] as const) {
    con.feedback = fb;
    const r = await resyncPlayback(h.ctx, "Sequence 1");
    assert.equal(r.steps.find((s) => s.name === "resync")!.status, status, fb);
    assert.notEqual(r.outcome, "succeeded", fb);
    assert.equal(r.verification.status, "unavailable", fb);
  }
  h.fake.on("cmd", () => ({ feedback: null }));
  const none = await resyncPlayback(h.ctx, "Sequence 1");
  assert.equal(none.steps.find((s) => s.name === "resync")!.status, "unknown");
  assert.match(String(none.verification.detail), /not resent/);
});

test("review 1: an unreadable activity flag is not counted as playing", async () => {
  h.fake.on("object", () => ({ class: "Sequence", name: "x" }));
  const r = await resyncPlayback(h.ctx, "Sequence 1 + 11");
  assert.equal(r.verification.status, "unavailable");
  assert.match(String(r.verification.detail), /could not be read \(0 playing, 0 idle of 2\)/);
});

test("review 1: a fresh 'stopped' or 'error' state is not running; a status stamped ahead of the console clock is not live", () => {
  const now = 1792180000;
  const fresh = new Date(now * 1000 - 300).toISOString();
  const s = (o: Record<string, string>) => statusView({ installed: true }, new Map(Object.entries(o)), now);
  assert.equal(s({ State: "stopped", Updated: fresh }).running, false);
  const err = s({ State: "error", Updated: fresh, Error: "socket bind failed" });
  assert.equal(err.running, false);
  assert.match(err.explanation, /stopped with an error: socket bind failed/);
  assert.equal(s({ State: "measuring", Updated: fresh }).running, true);
  const future = s({ State: "following", Updated: new Date((now + 3600) * 1000).toISOString(), Tempo: "120" });
  assert.equal(future.running, null);
  assert.match(future.explanation, /3600 s ahead of the console clock/);
  assert.equal(s({ State: "following", Updated: new Date((now + 1) * 1000).toISOString() }).running, true, "a second of clock skew is tolerated");
});

test("review 1: the plugin pool is read page by page; an incomplete read is not 'not imported'", async () => {
  con.following();
  con.plugins = [...Array.from({ length: 1000 }, (_, i) => `other ${i}`), "gma3_beat_sync"];
  const r = await h.callJson("gma3_tempo_sync_status", {});
  assert.equal(r.result.installed, true, r.text);
  assert.equal(r.result.slot, 1001);
  assert.equal(r.result.running, true);
  // The pool claims more entries than it gives.
  h.fake.on("children", (args) => (Number(args.offset ?? 0) === 0 ? { total: 300, items: Array.from({ length: 200 }, (_, i) => ({ name: `x${i}`, index: i + 1 })) } : { total: 300, items: [] }));
  const part = await h.callJson("gma3_tempo_sync_status", {});
  assert.equal(part.result.installed, null);
  assert.match(part.result.installedNote, /lists 300 entries but only 200 could be read/);
});
