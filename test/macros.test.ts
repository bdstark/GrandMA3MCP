import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { registerMacroTools, tokenize, references, parseWait, readWait, commandText, waitValue } from "../src/tools/macros.ts";
import { ValidationError } from "../src/validate.ts";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("statements and references: quotes, semicolons, cues, ranges", () => {
  assert.deepEqual(tokenize('Echo "a;b c"; Go+ Sequence 1'), [["Echo", '"a;b c"'], ["Go+", "Sequence", "1"]]);
  assert.deepEqual(references('Go+ Sequence 5 Cue 2; Label Macro "Intro" "x"').refs.map((r) => r.ref), ["Sequence 5 Cue 2", 'Macro "Intro"']);
  assert.deepEqual(references("Store Sequence 950 Cue 1 /NoConfirmation; Go+ Sequence 950").refs.map((r) => [r.ref, r.stores]), [["Sequence 950 Cue 1", true], ["Sequence 950", false]]);
  const ranged = references("Off Page 1.201 Thru 1.205; Group 3 + Group 4; Preset 4.4");
  assert.deepEqual(ranged.refs.map((r) => r.ref), ["Group 4", "Preset 4.4"]);
  assert.deepEqual(ranged.skipped, ["Page 1.201 Thru", "Group 3 +"]);
  assert.deepEqual(references("Fixture 1 Thru 5 At 50; Echo sequence").refs, [], "fixtures are not checked; a keyword without an id is no reference");
  assert.deepEqual(references("Master 3.14 At BPM 120").refs.map((r) => r.ref), ["Master 3.14"]);
  assert.deepEqual(references('Echo "Sequence 7"').refs, [], "quoted text is no reference");
});

test("waits and command text", () => {
  assert.deepEqual(parseWait("w", "go"), { kind: "go" });
  assert.deepEqual(parseWait("w", "Follow"), { kind: "follow" });
  assert.deepEqual(parseWait("w", 0), { kind: "follow" });
  assert.deepEqual(parseWait("w", 2.5), { kind: "seconds", seconds: 2.5 });
  for (const bad of ["soon", -1, 0.0001]) assert.throws(() => parseWait("w", bad), ValidationError, String(bad));
  assert.deepEqual(readWait(2), { kind: "seconds", seconds: 2 });
  assert.deepEqual(readWait("Go"), { kind: "go" });
  assert.deepEqual(readWait("Follow"), { kind: "follow" });
  assert.equal(waitValue({ kind: "seconds", seconds: 0.0333 }), "0.033");
  assert.throws(() => commandText("c", "a\nb"), /one line/);
  assert.throws(() => commandText("c", 5), /string/);
  assert.equal(commandText("c", ""), "");
});

// ---------------------------------------------------------------------------
// Fake console
// ---------------------------------------------------------------------------

interface FLine { name: string; note: string; command: string; wait: number | "Go" | "Follow"; enabled: boolean; add: boolean; exec: boolean }
interface FMacro { name: string; note: string; lock: boolean; cli: boolean; lines: FLine[]; run?: { line: number; since: number } }

const KEYWORDS = ["Sequence", "At", "World", "Store", "Go+", "Thru", "Fixture"];
/** The console's rewrite outside quotes: trim, collapse spaces, expand keyword abbreviations (3+ letters or exact). */
function consoleForm(cmd: string): string {
  return cmd
    .trim()
    .split(/("[^"]*")/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(/ {2,}/g, " ").replace(/[A-Za-z+]+/g, (w) => KEYWORDS.find((k) => k.toLowerCase() === w.toLowerCase() || (w.length >= 3 && k.toLowerCase().startsWith(w.toLowerCase()))) ?? w),
    )
    .join("");
}

class Console {
  macros = new Map<number, FMacro>();
  objects = new Set<string>(["Sequence 1", "Sequence 1 Cue 2", "Group 3", "Preset 4.4"]);
  commands: string[] = [];
  /** Properties whose writes the console ignores. */
  ignore = new Set<string>();
  /** References whose existence check fails. */
  unreadable = new Set<string>();
  lineMs = 40;
  /** Run-state reads that fail, and macros whose LineNo the read omits. */
  failRunReads = false;
  omitLineNo = false;

  macro(n: number, lines: Array<Partial<FLine>> = [], name = `Macro ${n}`): FMacro {
    const m: FMacro = { name, note: "", lock: false, cli: true, lines: lines.map((l) => ({ name: "", note: "", command: "", wait: "Follow", enabled: true, add: false, exec: true, ...l })) };
    this.macros.set(n, m);
    return m;
  }
  /** The running line now (advancing by time: lineMs per line, a timed wait in seconds, a Go wait holds). */
  tick(m: FMacro): void {
    if (!m.run) return;
    for (;;) {
      const l = m.lines[m.run.line - 1];
      if (!l) { m.run = undefined; return; }
      if (!l.enabled) { m.run = { line: m.run.line + 1, since: m.run.since }; continue; }
      if (l.wait === "Go") return;
      const dur = this.lineMs + (typeof l.wait === "number" ? l.wait * 1000 : 0);
      if (Date.now() - m.run.since < dur) return;
      m.run = { line: m.run.line + 1, since: m.run.since + dur };
    }
  }

  install(h: Harness): void {
    const find = (ref: string) => {
      const mm = ref.match(/^Macro (\d+)(?:\.(\d+))?$/);
      if (!mm) return null;
      const m = this.macros.get(Number(mm[1]));
      return m ? { m, line: mm[2] ? Number(mm[2]) : undefined } : null;
    };
    h.fake.on("children", (args) => {
      const ref = String(args.ref);
      if (ref === "DataPool.Macros") {
        const all = [...this.macros].sort(([a], [b]) => a - b);
        const off = Number(args.offset ?? 0);
        const lim = Number(args.limit ?? 100);
        return { total: all.length, offset: off, items: all.slice(off, off + lim).map(([n, m]) => ({ index: n, name: m.name, childCount: m.lines.length, fields: { Name: m.name } })) };
      }
      const f = find(ref);
      if (!f) throw new Error(`no object found for '${ref}'`);
      return {
        total: f.m.lines.length,
        offset: 0,
        items: f.m.lines.map((l, i) => ({ index: i + 1, class: "MacroLine", name: l.name || `MacroLine ${i + 1}`, fields: { Name: l.name || `MacroLine ${i + 1}`, Note: l.note, Command: l.command, Wait: l.wait, Enabled: l.enabled, AddToCmdline: l.add, Execute: l.exec } })),
      };
    });
    h.fake.on("objects", (args) => {
      const ref = String(args.ref);
      if (this.unreadable.has(ref)) throw new Error("read timed out");
      const f = find(ref);
      if (f && f.line !== undefined) {
        const l = f.m.lines[f.line - 1];
        return { items: l ? [{ class: "MacroLine", fields: { Wait: args.asText === false ? l.wait : String(l.wait) } }] : [] };
      }
      if (f && f.line === undefined) {
        if (this.failRunReads && ((args.fields as string[]) ?? []).includes("LineNo") && !((args.fields as string[]) ?? []).includes("Lock")) throw new Error("read timed out");
        this.tick(f.m);
        const r = f.m.run;
        const l = r ? f.m.lines[r.line - 1] : undefined;
        return { items: [{ class: "Macro", name: f.m.name, fields: { Name: f.m.name, Note: f.m.note, Lock: f.m.lock ? "UL" : "", CLI: f.m.cli ? "Yes" : "No", ...(this.omitLineNo ? {} : { LineNo: r ? String(r.line) : "" }), LineName: l ? l.name || `MacroLine ${r!.line}` : "", LineCommand: l?.command ?? "", User: "Admin" } }] };
      }
      if (/^Macro \d+$/.test(ref)) throw new Error(`no object found for '${ref}'`);
      return { items: this.objects.has(ref) ? [{ name: ref, fields: {} }] : [] };
    });
    h.fake.on("set", (args) => {
      const ref = String(args.ref);
      const prop = String(args.property);
      const value = String(args.value);
      const f = find(ref)!;
      if (f.line === undefined) {
        if (!f.m.lock && !this.ignore.has(prop)) {
          if (prop === "Name") f.m.name = value;
          if (prop === "Note") f.m.note = value;
          if (prop === "CLI") f.m.cli = value === "Yes";
        }
        return { ref, property: prop, value: prop === "Name" ? f.m.name : prop === "Note" ? f.m.note : f.m.cli ? "Yes" : "No" };
      }
      const l = f.m.lines[f.line - 1];
      if (!f.m.lock && !this.ignore.has(prop)) {
        if (prop === "Command") l.command = consoleForm(value);
        if (prop === "Wait") l.wait = value === "Go" ? "Go" : Number(value) > 0 ? Number(value) : "Follow";
        if (prop === "Enabled") l.enabled = value === "Yes";
        if (prop === "AddToCmdline") l.add = value === "Yes";
        if (prop === "Execute") l.exec = value === "Yes";
        if (prop === "Name") l.name = value;
        if (prop === "Note") l.note = value;
      }
      const display = (w: FLine["wait"]) => (typeof w !== "number" ? w : w >= 3600 ? `${Math.floor(w / 3600)}h${String(Math.floor((w % 3600) / 60)).padStart(2, "0")}m${(w % 60).toFixed(2).padStart(5, "0")}` : w.toFixed(2));
      const shown: Record<string, unknown> = { Command: l.command, Wait: display(l.wait), Enabled: l.enabled ? "Yes" : "No", AddToCmdline: l.add ? "Yes" : "No", Execute: l.exec ? "Yes" : "No", Name: l.name || `MacroLine ${f.line}`, Note: l.note };
      return { ref, property: prop, value: shown[prop] };
    });
    h.fake.on("cmd", (args) => {
      const c = String(args.command);
      this.commands.push(c);
      let mm: RegExpMatchArray | null;
      const blank = (): FLine => ({ name: "", note: "", command: "", wait: "Follow", enabled: true, add: false, exec: true });
      if ((mm = c.match(/^Store Macro (\d+) \/NoConfirmation$/))) {
        if (!this.macros.has(Number(mm[1]))) this.macro(Number(mm[1]));
        return { feedback: "OK" };
      }
      if ((mm = c.match(/^Store Macro (\d+)\.(\d+) \/NoConfirmation$/))) {
        const m = this.macros.get(Number(mm[1]))!;
        if (!m.lock && Number(mm[2]) > m.lines.length) m.lines.push(blank());
        return { feedback: "OK" };
      }
      if ((mm = c.match(/^Insert Macro (\d+)\.(\d+)$/))) {
        this.macros.get(Number(mm[1]))!.lines.splice(Number(mm[2]) - 1, 0, blank());
        return { feedback: "OK" };
      }
      if ((mm = c.match(/^Delete Macro (\d+)\.(\d+) \/NoConfirmation$/))) {
        const m = this.macros.get(Number(mm[1]))!;
        if (m.lock) return { feedback: "Object locked" };
        m.lines.splice(Number(mm[2]) - 1, 1);
        return { feedback: "OK" };
      }
      if ((mm = c.match(/^Move Macro (\d+)\.(\d+) At Macro \d+\.(\d+)$/))) {
        const m = this.macros.get(Number(mm[1]))!;
        const a = Number(mm[2]);
        const b = Number(mm[3]);
        const [l] = m.lines.splice(a - 1, 1);
        m.lines.splice(b > a ? b - 2 : b - 1, 0, l); // insert semantics: a downward move lands one short
        return { feedback: "OK" };
      }
      if ((mm = c.match(/^Go\+ Macro (\d+)$/))) {
        const m = this.macros.get(Number(mm[1]))!;
        this.tick(m);
        if (m.run && m.lines[m.run.line - 1]?.wait === "Go") m.run = { line: m.run.line + 1, since: Date.now() };
        else if (!m.run) m.run = { line: 1, since: Date.now() };
        return { feedback: "OK" };
      }
      if ((mm = c.match(/^Off Macro (\d+)$/))) {
        this.macros.get(Number(mm[1]))!.run = undefined;
        return { feedback: "OK" };
      }
      throw new Error(`unexpected command ${c}`);
    });
  }
}

let h: Harness;
let con: Console;
before(async () => {
  h = await startHarness(registerMacroTools, { requestTimeoutMs: 2000 });
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
const store = (args: Record<string, unknown>) => h.callJson("gma3_store_macro", { macro: 901, ...args });
const runs = () => con.commands.filter((c) => /^(Go\+|Go|Call|Off|Toggle) Macro/.test(c));

// ---------------------------------------------------------------------------
// gma3_store_macro
// ---------------------------------------------------------------------------

test("create stores every line exactly, in order, verifies it and never runs the macro", async () => {
  const lines = [
    { command: 'Store Sequence 950 Cue 1 /NoConfirmation; Label Sequence 950 "Intro"' },
    { command: "Go+ Sequence 950", wait: 2 },
    { command: 'Echo "manual step"', wait: "go", name: "hold", note: "operator continues" },
    { command: 'Echo "  spaced  in quotes  "', enabled: false, execute: false, add_to_cmdline: true },
  ];
  const { result, isError } = await store({ mode: "create", name: "Setup", note: "SB-07", cli: false, lines });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
  assert.equal(result.executed, false);
  assert.deepEqual(runs(), [], "creation never runs it");
  assert.deepEqual(con.commands, ["Store Macro 901 /NoConfirmation", ...[1, 2, 3, 4].map((l) => `Store Macro 901.${l} /NoConfirmation`)]);
  const m = con.macros.get(901)!;
  assert.deepEqual(m.lines.map((l) => l.command), lines.map((l) => l.command));
  assert.deepEqual(m.lines.map((l) => l.wait), ["Follow", 2, "Go", "Follow"]);
  assert.deepEqual([m.lines[2].name, m.lines[2].note, m.lines[3].enabled, m.lines[3].exec, m.lines[3].add], ["hold", "operator continues", false, false, true]);
  assert.deepEqual([m.name, m.note, m.cli], ["Setup", "SB-07", false]);
  assert.deepEqual(result.references[0].refs.map((r: any) => r.status), ["stored_here", "created_earlier"], "the stored cue creates its sequence");
  assert.deepEqual(result.references[1].refs, [{ ref: "Sequence 950", status: "created_earlier" }]);
  assert.deepEqual(result.lines.map((l: any) => l.wait), ["follow", 2, "go", "follow"]);
});

test("modes are explicit: create refuses an existing macro, replace and append need one", async () => {
  con.macro(901, [{ command: "Echo old" }], "Old");
  const c = await store({ mode: "create", lines: [{ command: "Echo new" }] });
  assert.match(stepError(c.result, "read_macro"), /already exists \("Old", 1 lines\); use mode replace or append/);
  const r = await h.callJson("gma3_store_macro", { macro: 902, mode: "replace", lines: [{ command: "Echo x" }] });
  assert.match(stepError(r.result, "read_macro"), /does not exist; use mode create/);
  const bad = await store({ lines: [{ command: "x" }] });
  assert.equal(bad.isError, true);
  assert.equal(con.commands.length, 0);
});

test("replace removes the lines from the last and keeps the macro; append keeps the earlier lines", async () => {
  con.macro(901, [{ command: "Echo a" }, { command: "Echo b" }, { command: "Echo c" }], "Keep");
  const r = await store({ mode: "replace", lines: [{ command: "Echo x" }] });
  assert.equal(r.result.verification.status, "matched", JSON.stringify(r.result.verification));
  assert.deepEqual(con.commands.slice(0, 3), ["Delete Macro 901.3 /NoConfirmation", "Delete Macro 901.2 /NoConfirmation", "Delete Macro 901.1 /NoConfirmation"]);
  assert.ok(!con.commands.includes("Delete Macro 901 /NoConfirmation"), "the macro itself is kept");
  assert.equal(con.macros.get(901)!.name, "Keep");
  const a = await store({ mode: "append", lines: [{ command: "Echo y" }, { command: "Echo z" }] });
  assert.equal(a.result.verification.status, "matched", JSON.stringify(a.result.verification));
  assert.deepEqual(con.macros.get(901)!.lines.map((l) => l.command), ["Echo x", "Echo y", "Echo z"]);
  const clear = await store({ mode: "replace", lines: [] });
  assert.equal(clear.result.verification.status, "matched");
  assert.equal(con.macros.get(901)!.lines.length, 0);
});

test("references are checked before anything is sent; raw lines and earlier Stores pass", async () => {
  const missing = await store({ mode: "create", lines: [{ command: "Go+ Sequence 2; Group 3 At 50" }, { command: "Call Preset 9.9" }] });
  assert.match(stepError(missing.result, "check_references"), /line 1: Sequence 2 does not exist; line 2: Preset 9\.9 does not exist\. Mark a line raw: true/);
  assert.equal(con.commands.length, 0);
  con.unreadable.add("Sequence 1");
  const unknown = await store({ mode: "create", lines: [{ command: "Go+ Sequence 1" }] });
  assert.match(stepError(unknown.result, "check_references"), /Sequence 1 could not be checked/, "an unreadable reference fails closed");
  assert.equal(con.commands.length, 0);
  const ok = await store({ mode: "create", lines: [{ command: "Go+ Sequence 2", raw: true }, { command: "Store Group 77 /NoConfirmation" }, { command: "Group 77 At 50" }, { command: 'Set Macro 901 Property "Note" "x"' }] });
  assert.equal(ok.result.verification.status, "matched", JSON.stringify(ok.result));
  assert.deepEqual(ok.result.references.map((c: any) => c.refs.map((r: any) => r.status)), [[], ["stored_here"], ["created_earlier"], ["this_macro"]]);
});

test("a command the console rewrites is a mismatch unless its form is accepted; either way it is reported", async () => {
  const r = await store({ mode: "create", lines: [{ command: "go+ seq  1", raw: true }, { command: 'Echo "kept  exactly"' }] });
  assert.equal(r.isError, true);
  assert.equal(r.result.verification.status, "mismatched");
  assert.match(r.result.verification.detail, /line 1 command reads "Go\+ Sequence 1", not "go\+ seq {2}1".*accept_console_form/);
  assert.deepEqual(r.result.rewritten, [{ line: 1, sent: "go+ seq  1", stored: "Go+ Sequence 1" }]);
  con.macros.clear();
  const ok = await store({ mode: "create", accept_console_form: true, lines: [{ command: "go+ seq  1", raw: true }] });
  assert.equal(ok.result.verification.status, "matched");
  assert.equal(ok.result.rewritten.length, 1);
  assert.match(ok.result.warnings.join(), /stored in the console's form/);
});

test("locked or running macros and ignored writes", async () => {
  const m = con.macro(901, [{ command: "Echo a" }]);
  m.lock = true;
  const locked = await store({ mode: "append", lines: [{ command: "Echo b" }] });
  assert.match(stepError(locked.result, "read_macro"), /is locked/);
  m.lock = false;
  m.lines[0].wait = "Go";
  m.run = { line: 1, since: Date.now() };
  const running = await store({ mode: "append", lines: [{ command: "Echo b" }] });
  assert.match(stepError(running.result, "read_macro"), /is running \(line 1\)/);
  m.run = undefined;
  assert.equal(con.commands.length, 0);
  con.ignore.add("Wait");
  const w = await store({ mode: "append", lines: [{ command: "Echo b", wait: 3 }] });
  assert.equal(w.isError, true);
  assert.match(stepError(w.result, "line_2_wait"), /did not apply Wait="3".*silently becomes Follow/);
});

// ---------------------------------------------------------------------------
// gma3_edit_macro_line
// ---------------------------------------------------------------------------

test("insert, set, move (upward moves only) and remove, each verified against the whole macro", async () => {
  con.macro(901, ["a", "b", "c"].map((x) => ({ command: `Echo ${x}` })));
  const edit = (args: Record<string, unknown>) => h.callJson("gma3_edit_macro_line", { macro: 901, ...args });
  const ins = await edit({ action: "insert", line: 2, command: "Echo new", wait: "go" });
  assert.equal(ins.result.verification.status, "matched", JSON.stringify(ins.result.verification));
  assert.equal(con.commands.at(0), "Insert Macro 901.2");
  const end = await edit({ action: "insert", line: 5, command: "Echo end" });
  assert.equal(end.result.verification.status, "matched");
  assert.equal(con.commands.filter((c) => c.startsWith("Store Macro 901.5")).length, 1, "insert past the end appends");
  const set = await edit({ action: "set", line: 1, wait: 1.5, name: "first", enabled: false });
  assert.equal(set.result.verification.status, "matched", JSON.stringify(set.result.verification));
  con.commands = [];
  const down = await edit({ action: "move", line: 1, to: 3 });
  assert.equal(down.result.verification.status, "matched", JSON.stringify(down.result.verification));
  assert.deepEqual(con.commands, ["Move Macro 901.2 At Macro 901.1", "Move Macro 901.3 At Macro 901.2"]);
  assert.deepEqual(con.macros.get(901)!.lines.map((l) => l.command), ["Echo new", "Echo b", "Echo a", "Echo c", "Echo end"]);
  const up = await edit({ action: "move", line: 5, to: 1 });
  assert.equal(up.result.verification.status, "matched");
  const rm = await edit({ action: "remove", line: 1 });
  assert.equal(rm.result.verification.status, "matched");
  assert.deepEqual(con.macros.get(901)!.lines.map((l) => l.command), ["Echo new", "Echo b", "Echo a", "Echo c"]);
  for (const [args, re] of [[{ action: "insert", line: 9, command: "x" }, /line must be 1-5/], [{ action: "set", line: 1, command: "Go+ Sequence 404" }, /Sequence 404 does not exist/]] as const) {
    const r = await edit(args as Record<string, unknown>);
    assert.match(JSON.stringify(r.result.steps), re);
  }
  assert.equal(runs().length, 0);
});

// ---------------------------------------------------------------------------
// gma3_run_macro and gma3_macros
// ---------------------------------------------------------------------------

test("run: dispatched and observed are separate; a manual wait is observed and continued; Off stops", async () => {
  con.macro(901, [{ command: "Echo 1", wait: 0.1 }, { command: "Echo 2", wait: "Go" }, { command: "Echo 3" }]);
  const go = await h.callJson("gma3_run_macro", { macro: 901, action: "go", observe_seconds: 2, interval_ms: 50 });
  assert.equal(go.isError, false, JSON.stringify(go.result));
  assert.equal(go.result.execution.dispatched, true);
  assert.equal(go.result.execution.observed.state, "paused_at_go");
  assert.equal(go.result.execution.observed.pausedAt, 2);
  assert.deepEqual(go.result.execution.observed.linesSeen.map((l: any) => l.line), [1, 2]);
  assert.equal(go.result.verification.status, "unavailable");
  assert.match(go.result.verification.detail, /do not show that every line succeeded/);
  assert.match(go.result.summary, /Completion of every line is not inferred/);
  const cont = await h.callJson("gma3_run_macro", { macro: 901, action: "go", observe_seconds: 2, interval_ms: 50 });
  assert.equal(cont.result.execution.observed.state, "finished");
  await h.callJson("gma3_run_macro", { macro: 901, action: "go", observe_seconds: 0.3, interval_ms: 50 });
  const off = await h.callJson("gma3_run_macro", { macro: 901, action: "off", observe_seconds: 1 });
  assert.equal(off.result.verification.status, "matched", JSON.stringify(off.result));
  assert.equal(off.result.execution.observed.state, "stopped");
});

test("a macro that ends before the first sample is not_observed, never claimed finished", async () => {
  con.lineMs = 0;
  con.macro(901, [{ command: "Echo quick" }]);
  const go = await h.callJson("gma3_run_macro", { macro: 901, action: "go", observe_seconds: 0.3, interval_ms: 50 });
  assert.equal(go.result.execution.observed.state, "not_observed");
  const none = await h.callJson("gma3_run_macro", { macro: 999, action: "go" });
  assert.match(stepError(none.result, "read_macro"), /does not exist/);
});

test("gma3_macros lists the pool and reads one macro exactly, with its references on request", async () => {
  con.macro(5, [{ command: 'Go+ Sequence 1 Cue 2; Echo "x  y"', wait: "Go", name: "MacroLine 1" }, { command: "Group 9 At 50", name: "custom", note: "n" }], "Five");
  con.macro(7);
  const list = await h.callJson("gma3_macros", { limit: 1 });
  assert.deepEqual(list.result.macros, [{ macro: 5, name: "Five", lines: 2 }]);
  assert.equal(list.result.next, 1);
  const one = await h.callJson("gma3_macros", { macro: 5, check_references: true });
  assert.equal(one.result.lines[0].command, 'Go+ Sequence 1 Cue 2; Echo "x  y"');
  assert.equal(one.result.lines[0].name, null, "the default name reads as null");
  assert.equal(one.result.lines[0].wait, "go");
  assert.equal(one.result.lines[1].name, "custom");
  assert.deepEqual(one.result.references.map((c: any) => c.refs), [[{ ref: "Sequence 1 Cue 2", status: "exists" }], [{ ref: "Group 9", status: "missing" }]]);
  assert.equal(one.result.running, null);
  const missing = await h.callJson("gma3_macros", { macro: 99 });
  assert.equal(missing.result.exists, false);
});

// ---------------------------------------------------------------------------
// Review 1 regressions
// ---------------------------------------------------------------------------

test("Off with every run-state read failing is not a confirmed stop", async () => {
  con.macro(901, [{ command: "Echo 1", wait: "Go" }]);
  con.failRunReads = true;
  const off = await h.callJson("gma3_run_macro", { macro: 901, action: "off", observe_seconds: 0.4, interval_ms: 50 });
  assert.equal(off.result.execution.observed.state, "unknown", JSON.stringify(off.result.execution));
  assert.equal(off.result.execution.observed.confirmedIdle, false);
  assert.equal(off.result.verification.status, "unavailable");
  assert.match(off.result.verification.detail, /no sample .* could be read/);
});

test("a missing or malformed LineNo is an unknown run state: authoring is refused", async () => {
  con.macro(901, [{ command: "Echo a" }]);
  con.omitLineNo = true;
  const r = await h.callJson("gma3_store_macro", { macro: 901, mode: "replace", lines: [{ command: "Echo b" }] });
  assert.match(stepError(r.result, "read_macro"), /whether Macro 901 is running could not be read/);
  const e = await h.callJson("gma3_edit_macro_line", { macro: 901, action: "remove", line: 1 });
  assert.match(stepError(e.result, "read_macro"), /could not be read/);
  assert.equal(con.commands.length, 0);
  assert.equal(con.macros.get(901)!.lines[0].command, "Echo a");
  const read = await h.callJson("gma3_macros", { macro: 901 });
  assert.equal(read.result.runState, "unknown");
});

test("a valid long wait whose reply is display text is verified numerically and the rest is written", async () => {
  const r = await store({ mode: "create", lines: [{ command: "Echo a", wait: 3600 }, { command: "Echo b", wait: 100000 }, { command: "Echo c" }] });
  assert.equal(r.isError, false, JSON.stringify(r.result.steps.filter((x: any) => x.status !== "succeeded")));
  assert.equal(r.result.verification.status, "matched");
  assert.deepEqual(con.macros.get(901)!.lines.map((l) => l.wait), [3600, 100000, "Follow"]);
  assert.deepEqual(r.result.lines.map((l: any) => l.wait), [3600, 100000, "follow"]);
});

test("append and edit see the macro's earlier executable Store lines", async () => {
  con.macro(901, [{ command: "Store Sequence 950 Cue 1 /NoConfirmation" }, { command: "Echo x" }]);
  const a = await store({ mode: "append", lines: [{ command: "Go+ Sequence 950" }] });
  assert.equal(a.result.verification.status, "matched", JSON.stringify(a.result.steps));
  assert.deepEqual(a.result.references[0].refs, [{ ref: "Sequence 950", status: "created_earlier" }]);
  const e = await h.callJson("gma3_edit_macro_line", { macro: 901, action: "set", line: 2, command: "Go+ Sequence 950 Cue 1" });
  assert.equal(e.result.verification.status, "matched", JSON.stringify(e.result.steps));
  const before = await h.callJson("gma3_edit_macro_line", { macro: 901, action: "insert", line: 1, command: "Go+ Sequence 950" });
  assert.match(stepError(before.result, "check_references"), /Sequence 950 does not exist/, "a Store after the line does not help it");
});

test("a disabled or non-executing Store creates nothing", async () => {
  for (const off of [{ enabled: false }, { execute: false }]) {
    con.macros.clear();
    con.commands = [];
    const r = await store({ mode: "create", lines: [{ command: "Store Sequence 950 /NoConfirmation", ...off }, { command: "Go+ Sequence 950" }] });
    assert.match(stepError(r.result, "check_references"), /line 2: Sequence 950 does not exist/, JSON.stringify(off));
    assert.equal(con.commands.length, 0);
  }
  con.macro(901, [{ command: "Store Sequence 950 /NoConfirmation", enabled: false }]);
  const app = await store({ mode: "append", lines: [{ command: "Go+ Sequence 950" }] });
  assert.match(stepError(app.result, "check_references"), /Sequence 950 does not exist/);
  const raw = await h.callJson("gma3_store_macro", { macro: 902, mode: "create", lines: [{ command: "Store Sequence 951 /NoConfirmation", raw: true }, { command: "Go+ Sequence 951" }] });
  assert.equal(raw.result.verification.status, "matched", "a raw Store that runs still creates its object");
});

test("an edit that takes away a later line's stored object is refused unless allowed", async () => {
  con.macro(901, [{ command: "Store Sequence 950 /NoConfirmation" }, { command: "Go+ Sequence 950" }]);
  const edit = (args: Record<string, unknown>) => h.callJson("gma3_edit_macro_line", { macro: 901, ...args });
  for (const args of [{ action: "remove", line: 1 }, { action: "move", line: 1, to: 2 }, { action: "set", line: 1, enabled: false }, { action: "set", line: 1, command: "Echo gone" }]) {
    const r = await edit(args);
    assert.match(stepError(r.result, "check_dependents"), /line \d uses Sequence 950, which no earlier line stores any more and which does not exist/, JSON.stringify(args));
  }
  assert.equal(con.commands.length, 0);
  con.objects.add("Sequence 950");
  const exists = await edit({ action: "remove", line: 1 });
  assert.equal(exists.result.verification.status, "matched", "no refusal when the object exists anyway");
  con.objects.delete("Sequence 950");
  con.macro(901, [{ command: "Store Sequence 950 /NoConfirmation" }, { command: "Go+ Sequence 950" }]);
  const allowed = await edit({ action: "remove", line: 1, allow_unresolved_dependents: true });
  assert.equal(allowed.result.verification.status, "matched");
  assert.equal(allowed.result.unresolvedDependents.length, 1);
});
