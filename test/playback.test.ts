import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { SILENT } from "./helpers/fake-bridge.ts";
import { registerPlaybackTools, functionName, lockState, EXECUTOR_FUNCTIONS } from "../src/tools/playback.ts";
import { ValidationError } from "../src/validate.ts";

/**
 * A model of the console objects SB-01 touches, with the 2.5.1 behaviour the probe established:
 *   - `set` writes a property and answers with the edit-role value read back;
 *   - a value the console does not accept is SILENTLY IGNORED (the old value stays);
 *   - Lock reads "UL" when locked and "" when not; writes to a locked executor, to any executor of a locked page and
 *     to a locked sequence are silently ignored (Lock itself stays writable on the locked object, except an
 *     executor's Lock while its page is locked);
 *   - "Empty" clears a function (reads "").
 */
interface Exec {
  seq: number | null;
  /** Data pool of the assigned sequence (default 1, the current one). */
  pool?: number;
  other?: { class: string; index: number; name: string };
  props: Record<string, string>;
}
interface Seq {
  name: string;
  props: Record<string, string>;
  active: boolean;
}

const CONSOLE_KEY_VALUES = new Set(["go+", "go-", "<<<", ">>>", "on", "off", "toggle", "top", "kill", "pause", "goto", "load", "select", "selectfixtures", "rate1", "speed1", "learn", "learnspeed", "halfspeed", "doublespeed", "resync", "fastsync", "flash", "temp", "swap", "black", "time", "call", "login", "at"]);
const CONSOLE_FADER_VALUES = new Set(["master", "x", "xa", "xb", "temp", "rate", "speed", "time"]);
const CANON: Record<string, string> = {};
for (const def of Object.values(EXECUTOR_FUNCTIONS)) for (const a of def.allowed) CANON[a.toLowerCase()] = a;

class Console {
  pages = new Map<number, { lock: string; execs: Map<number, Exec> }>();
  seqs = new Map<number, Seq>();
  /** Values the console refuses for a property (silently kept), e.g. { KeyPress: ["Black"] }. */
  refuse: Record<string, string[]> = {};
  /** set requests (by "ref property=value") that never get a reply. */
  silentSets = new Set<string>();
  /** Fail the reference scan. */
  childrenError = false;
  /** Sequences of other data pools (pool number -> sequences); pool 1 is `seqs`, the current one. */
  pools = new Map<number, Map<number, Seq>>();
  /** "<ref> <Property>" pairs an objects read leaves out (the bridge could not read them). */
  unreadable = new Set<string>();
  /** "<ref> <Property>=<value>" set requests whose reply carries no value. */
  noValueSets = new Set<string>();

  seq(n: number, name = `Seq ${n}`, props: Record<string, string> = {}, pool = 1): this {
    if (pool !== 1 && !this.pools.has(pool)) this.pools.set(pool, new Map());
    (pool === 1 ? this.seqs : this.pools.get(pool)!).set(n, {
      name,
      active: false,
      props: { WrapAround: "Yes", Priority: "LTP", RestartMode: "First Cue", ReleaseFirstCue: "Yes", AutoStart: "Yes", AutoStop: "Yes", MasterGoMode: "None", AutoFix: "No", AutoStomp: "No", Tracking: "Yes", SoftLTP: "Yes", OffWhenOverridden: "Yes", KillProtect: "No", SwapProtect: "No", UseExecutorTime: "Yes", IncludeLinkLastGo: "Yes", XFadeMode: "AB", XFadeReload: "No", Lock: "", StructureLocked: "No", SystemLocked: "No", ...props },
    });
    return this;
  }
  page(p: number, lock = ""): this {
    if (!this.pages.has(p)) this.pages.set(p, { lock, execs: new Map() });
    else this.pages.get(p)!.lock = lock;
    return this;
  }
  exec(p: number, e: number, seq: number | null, props: Record<string, string> = {}, pool = 1): this {
    this.page(p);
    this.pages.get(p)!.execs.set(e, { seq, pool, props: { KeyPress: "Go+", KeyUnpress: "", MAKeyPress: "", MAKeyUnpress: "", Fader: "Master", Encoder: "Master", EncoderLeft: "", EncoderRight: "", Fix: "No", Lock: "", StructureLocked: "No", SystemLocked: "No", ...props } });
    return this;
  }

  private poolSeqs(pool = 1) {
    return pool === 1 ? this.seqs : this.pools.get(pool)!;
  }
  private seqHandle(n: number, pool = 1) {
    const s = this.poolSeqs(pool).get(n)!;
    return { name: s.name, class: "Sequence", index: n, addr: `14.14.${pool}.7.${n}` };
  }
  private resolve(ref: string): { kind: "page"; p: number } | { kind: "exec"; p: number; e: number; x: Exec } | { kind: "seq"; n: number; s: Seq } | null {
    let m: RegExpMatchArray | null;
    if ((m = ref.match(/^Page (\d+)$/))) return this.pages.has(Number(m[1])) ? { kind: "page", p: Number(m[1]) } : null;
    if ((m = ref.match(/^Page (\d+)\.(\d+)$/))) {
      const x = this.pages.get(Number(m[1]))?.execs.get(Number(m[2]));
      return x ? { kind: "exec", p: Number(m[1]), e: Number(m[2]), x } : null;
    }
    if ((m = ref.match(/^Sequence (\d+)$/))) {
      const s = this.seqs.get(Number(m[1]));
      return s ? { kind: "seq", n: Number(m[1]), s } : null;
    }
    if ((m = ref.match(/^14\.14\.(\d+)\.7\.(\d+)$/))) {
      const s = this.pools.get(Number(m[1]))?.get(Number(m[2])) ?? (Number(m[1]) === 1 ? this.seqs.get(Number(m[2])) : undefined);
      return s ? { kind: "seq", n: Number(m[2]), s } : null;
    }
    throw new Error(`unexpected ref ${ref}`);
  }

  install(h: Harness): void {
    h.fake.on("objects", (args) => {
      const r = this.resolve(String(args.ref));
      const fields = (args.fields as string[]) ?? [];
      const asText = args.asText !== false;
      if (!r) throw new Error(`no objects found for '${args.ref}'`);
      const ref = String(args.ref);
      const readable = (all: Record<string, unknown>) => pick(Object.fromEntries(Object.entries(all).filter(([k]) => !this.unreadable.has(`${ref} ${k}`))), fields);
      let item: Record<string, unknown>;
      if (r.kind === "page") item = { name: `Page ${r.p}`, class: "Page", addr: `14.14.1.13.${r.p}`, index: r.p, fields: readable({ Lock: this.pages.get(r.p)!.lock, Name: `Page ${r.p}` }) };
      else if (r.kind === "exec") {
        const obj = r.x.other ? (asText ? r.x.other.name : r.x.other) : r.x.seq === null ? "" : asText ? this.poolSeqs(r.x.pool).get(r.x.seq)!.name : this.seqHandle(r.x.seq, r.x.pool);
        item = { name: "x", class: "Executor", addr: `14.14.1.13.${r.p}.${r.e}`, index: r.e - 100, fields: readable({ ...r.x.props, Object: obj }) };
      } else item = { name: r.s.name, class: "Sequence", addr: `14.14.1.7.${r.n}`, index: r.n, fields: readable({ ...r.s.props, Name: r.s.name }) };
      return { total: 1, offset: 0, count: 1, items: [item] };
    });
    h.fake.on("object", (args) => {
      if (args.ref === "DataPool") return { name: "Default", class: "DataPool", addr: "14.14.1" };
      const r = this.resolve(String(args.ref));
      if (!r) throw new Error(`no object found for '${args.ref}'`);
      return r.kind === "seq" ? { name: r.s.name, class: "Sequence", hasActivePlayback: r.s.active } : { name: "x" };
    });
    h.fake.on("children", (args) => {
      if (this.childrenError) throw new Error("children failed");
      const ref = String(args.ref);
      if (ref === "DataPool.Pages") {
        const items = [...this.pages.keys()].map((p) => ({ name: `Page ${p}`, class: "Page", addr: `14.14.1.13.${p}`, index: p, fields: { No: p } }));
        return { total: items.length, offset: 0, count: items.length, items };
      }
      const m = ref.match(/^14\.14\.1\.13\.(\d+)$/);
      if (!m) throw new Error(`unexpected children ref ${ref}`);
      const items = [...this.pages.get(Number(m[1]))!.execs.entries()].map(([e, x]) => ({ name: "x", class: "Executor", fields: { No: e, Object: x.seq === null ? "" : this.seqHandle(x.seq, x.pool) } }));
      return { total: items.length, offset: 0, count: items.length, items };
    });
    h.fake.on("set", (args) => {
      const ref = String(args.ref);
      const property = String(args.property);
      const value = String(args.value);
      if (this.silentSets.has(`${ref} ${property}=${value}`)) return SILENT;
      const noValue = this.noValueSets.has(`${ref} ${property}=${value}`);
      const r = this.resolve(ref);
      if (!r) throw new Error(`no object found for '${ref}'`);
      const accept = (bag: Record<string, string>, blocked: boolean) => {
        if (blocked || this.refuse[property]?.includes(value)) return;
        if (property === "Lock") {
          bag.Lock = value === "Yes" ? "UL" : value === "No" ? "" : bag.Lock;
          return;
        }
        if (property === "Fix" || (bag.WrapAround !== undefined && /^(Yes|No)$/.test(bag[property] ?? ""))) {
          if (value === "Yes" || value === "No") bag[property] = value;
          return;
        }
        const low = value.toLowerCase();
        if (low === "empty") bag[property] = "";
        else if (/Fader|^Encoder$/.test(property) ? CONSOLE_FADER_VALUES.has(low) : CONSOLE_KEY_VALUES.has(low) || property in (this.seqs.values().next().value?.props ?? {})) bag[property] = CANON[low] ?? value;
      };
      if (r.kind === "page") {
        const pg = this.pages.get(r.p)!;
        const bag = { Lock: pg.lock };
        accept(bag, false);
        pg.lock = bag.Lock;
        return noValue ? { ref, property } : { ref, property, value: pg.lock };
      }
      if (r.kind === "exec") {
        const pageLocked = this.pages.get(r.p)!.lock !== "";
        accept(r.x.props, pageLocked || (property !== "Lock" && r.x.props.Lock !== ""));
        return noValue ? { ref, property } : { ref, property, value: r.x.props[property] };
      }
      accept(r.s.props, property !== "Lock" && r.s.props.Lock !== "");
      return noValue ? { ref, property } : { ref, property, value: r.s.props[property] };
    });
    h.fake.on("cmd", () => {
      throw new Error("SB-01 tools must not send commands");
    });
  }
}

function pick(all: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f in all) out[f] = all[f];
  return out;
}

let h: Harness;
let con: Console;
before(async () => {
  h = await startHarness(registerPlaybackTools);
});
after(async () => {
  await h.close();
});
beforeEach(() => {
  h.fake.reset();
  con = new Console().seq(5, "Chase").seq(7, "Other").page(1).page(2).exec(1, 201, 5).exec(2, 305, 5).exec(1, 202, 7);
  con.install(h);
});

const sets = () => h.fake.requests.filter((r) => r.op === "set").map((r) => `${r.args.ref} ${r.args.property}=${r.args.value}`);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("functionName matches case-insensitively and refuses functions that do not apply to the element", () => {
  assert.equal(functionName("key_press", "temp", EXECUTOR_FUNCTIONS.key_press.allowed), "Temp");
  assert.equal(functionName("fader", "XA", EXECUTOR_FUNCTIONS.fader.allowed), "XA");
  assert.equal(functionName("key_press", undefined, EXECUTOR_FUNCTIONS.key_press.allowed), undefined);
  for (const [k, bad] of [["key_press", "Call"], ["key_press", "LogIn"], ["key_press", "At"], ["key_unpress", "Flash"], ["encoder_left", "Temp"], ["fader", "Highlight"], ["fader", "Go+"], ["encoder", "Toggle"]] as const) {
    assert.throws(() => functionName(k, bad, EXECUTOR_FUNCTIONS[k].allowed), ValidationError, `${k}=${bad}`);
  }
});

test("lockState reads the console's lock display values and keeps a missing value unknown", () => {
  assert.equal(lockState("UL"), true);
  assert.equal(lockState("Yes"), true);
  for (const v of ["", "No", false]) assert.equal(lockState(v), false, String(v));
  assert.equal(lockState(undefined), null);
  assert.equal(lockState(null), null);
});

test("invalid requests are refused before anything is sent", async () => {
  for (const args of [
    { page: 1, executor: 201 },
    { page: 1, executor: 201, key_press: "Bogus" },
    { page: 1, executor: 201, fader: "Highlight" },
    { page: 1, executor: 201, encoder_left: "Flash" },
    { page: 1, executor: 199, key_press: "Temp" },
    { page: 0, executor: 201, key_press: "Temp" },
  ]) {
    const { result, isError } = await h.callJson("gma3_configure_executor", args);
    assert.equal(isError, true, JSON.stringify(args));
    assert.equal(result.outcome, "failed");
    assert.ok(result.validationErrors?.length, JSON.stringify(result));
  }
  for (const args of [{ sequence: 5 }, { sequence: 5, priority: "loud" }, { sequence: 5, restart_mode: "Current Cue" }, { sequence: 0, wrap_around: true }]) {
    const { result, isError } = await h.callJson("gma3_configure_sequence", args);
    assert.equal(isError, true, JSON.stringify(args));
    assert.ok(result.validationErrors?.length, JSON.stringify(result));
  }
  const bad = await h.callJson("gma3_configure_sequence", { sequence: 5, wrap_around: "yes" });
  assert.equal(bad.isError, true);
  assert.equal(h.fake.requests.length, 0, "nothing may reach the bridge");
});

// ---------------------------------------------------------------------------
// gma3_configure_executor
// ---------------------------------------------------------------------------

test("configure_executor writes only the changed functions, reads them back and never starts playback", async () => {
  const { result, isError } = await h.callJson("gma3_configure_executor", { page: 1, executor: 201, key_press: "temp", key_unpress: "Empty", fader: "Temp", encoder: "Master" });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.verification.status, "matched");
  assert.deepEqual(sets(), ["Page 1.201 KeyPress=Temp", "Page 1.201 Fader=Temp"]);
  assert.deepEqual(result.intended.unchanged.sort(), ["encoder", "key_unpress"]);
  assert.deepEqual(result.intended.changes.map((c: { key: string; from: string; to: string }) => `${c.key}:${c.from}->${c.to}`), ["key_press:Go+->Temp", "fader:Master->Temp"]);
  assert.deepEqual(result.playback, { activeBefore: false, activeAfter: false });
  assert.equal(result.sequence, "Sequence 5 (14.14.1.7.5)");
  assert.equal(result.sequenceAddr, "14.14.1.7.5");
  assert.equal(con.pages.get(1)!.execs.get(201)!.props.KeyPress, "Temp");
  assert.equal(h.fake.commands.length, 0);
});

test("configure_executor clears a function with Empty and sets MA and encoder functions", async () => {
  con.pages.get(1)!.execs.get(201)!.props.KeyUnpress = "Off";
  const { result, isError } = await h.callJson("gma3_configure_executor", { page: 1, executor: 201, key_unpress: "Empty", ma_key_press: "Goto", encoder_left: "Go-", encoder_right: "Go+", fix: true });
  assert.equal(isError, false, JSON.stringify(result));
  assert.deepEqual(sets(), ["Page 1.201 KeyUnpress=Empty", "Page 1.201 MAKeyPress=Goto", "Page 1.201 EncoderLeft=Go-", "Page 1.201 EncoderRight=Go+", "Page 1.201 Fix=Yes"]);
  assert.equal(result.verification.status, "matched");
  assert.equal(con.pages.get(1)!.execs.get(201)!.props.KeyUnpress, "");
});

test("configure_executor with every value already set sends nothing", async () => {
  const { result, isError } = await h.callJson("gma3_configure_executor", { page: 1, executor: 201, key_press: "Go+", fader: "master", fix: false, lock: false });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.noop, true);
  assert.deepEqual(sets(), []);
  assert.match(result.summary, /already set/);
});

test("configure_executor preview reports the plan and sends nothing", async () => {
  const { result, isError } = await h.callJson("gma3_configure_executor", { page: 1, executor: 201, key_press: "Flash", preview: true });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.preview, true);
  assert.deepEqual(result.intended.changes, [{ key: "key_press", property: "KeyPress", from: "Go+", to: "Flash" }]);
  assert.deepEqual(sets(), []);
  assert.match(result.summary, /Preview only/);
});

test("configure_executor refuses an empty executor, a missing page and a non-sequence assignment", async () => {
  con.exec(1, 203, null);
  const empty = await h.callJson("gma3_configure_executor", { page: 1, executor: 203, key_press: "Temp" });
  assert.equal(empty.isError, true);
  assert.match(empty.result.summary, /empty/);
  const missing = await h.callJson("gma3_configure_executor", { page: 9, executor: 201, key_press: "Temp" });
  assert.equal(missing.isError, true);
  assert.match(missing.result.summary, /Page 9 does not exist/);
  con.exec(1, 204, null);
  con.pages.get(1)!.execs.get(204)!.other = { class: "Macro", index: 3, name: "M" };
  const macro = await h.callJson("gma3_configure_executor", { page: 1, executor: 204, key_press: "Go+" });
  assert.equal(macro.isError, true);
  assert.match(macro.result.summary, /Macro object; only sequence executors/);
  assert.deepEqual(sets(), []);
});

test("a locked executor is refused before anything is sent and names the lock owner", async () => {
  con.pages.get(1)!.execs.get(201)!.props.Lock = "UL";
  const { result, isError } = await h.callJson("gma3_configure_executor", { page: 1, executor: 201, key_press: "Temp" });
  assert.equal(isError, true);
  assert.equal(result.outcome, "failed");
  assert.match(result.summary, /executor \(Page 1\.201\).*unlock: true/);
  assert.deepEqual(sets(), []);
  assert.ok(result.steps.some((s: { name: string; status: string }) => s.name === "set_key_press" && s.status === "skipped"));
});

test("unlock: true unlocks the executor, applies and locks it again", async () => {
  con.pages.get(1)!.execs.get(201)!.props.Lock = "UL";
  const { result, isError } = await h.callJson("gma3_configure_executor", { page: 1, executor: 201, key_press: "Temp", unlock: true });
  assert.equal(isError, false, JSON.stringify(result));
  assert.deepEqual(sets(), ["Page 1.201 Lock=No", "Page 1.201 KeyPress=Temp", "Page 1.201 Lock=Yes"]);
  assert.equal(result.verification.status, "matched");
  assert.equal(con.pages.get(1)!.execs.get(201)!.props.Lock, "UL");
});

test("a locked page blocks executor changes; unlock: true unlocks the page first and relocks it last", async () => {
  con.pages.get(1)!.lock = "UL";
  con.pages.get(1)!.execs.get(201)!.props.Lock = "UL";
  const refused = await h.callJson("gma3_configure_executor", { page: 1, executor: 201, fader: "Temp" });
  assert.equal(refused.isError, true);
  assert.match(refused.result.summary, /page \(Page 1\) and executor \(Page 1\.201\)/);
  assert.deepEqual(sets(), []);
  const { result, isError } = await h.callJson("gma3_configure_executor", { page: 1, executor: 201, fader: "Temp", unlock: true });
  assert.equal(isError, false, JSON.stringify(result));
  assert.deepEqual(sets(), ["Page 1 Lock=No", "Page 1.201 Lock=No", "Page 1.201 Fader=Temp", "Page 1.201 Lock=Yes", "Page 1 Lock=Yes"]);
  assert.equal(con.pages.get(1)!.lock, "UL");
  assert.equal(con.pages.get(1)!.execs.get(201)!.props.Lock, "UL");
});

test("lock: false removes the executor lock explicitly and does not relock", async () => {
  con.pages.get(1)!.execs.get(201)!.props.Lock = "UL";
  const { result, isError } = await h.callJson("gma3_configure_executor", { page: 1, executor: 201, key_press: "Toggle", lock: false });
  assert.equal(isError, false, JSON.stringify(result));
  assert.deepEqual(sets(), ["Page 1.201 Lock=No", "Page 1.201 KeyPress=Toggle"]);
  assert.equal(con.pages.get(1)!.execs.get(201)!.props.Lock, "");
});

test("lock: true locks the executor after the changes", async () => {
  const { result, isError } = await h.callJson("gma3_configure_executor", { page: 1, executor: 201, key_press: "Toggle", lock: true });
  assert.equal(isError, false, JSON.stringify(result));
  assert.deepEqual(sets(), ["Page 1.201 KeyPress=Toggle", "Page 1.201 Lock=Yes"]);
  assert.equal(result.verification.status, "matched");
});

test("a value the console silently keeps fails the step, stops the rest and is reported", async () => {
  con.refuse.KeyPress = ["Black"];
  con.refuse.MAKeyPress = ["Black"];
  // Changes are written in parameter order (key_press before fader): the refused first write fails the call.
  const first = await h.callJson("gma3_configure_executor", { page: 1, executor: 201, fader: "Temp", key_press: "Black", encoder: "Rate" });
  assert.equal(first.isError, true);
  assert.equal(first.result.outcome, "failed");
  const failed = first.result.steps.find((s: { name: string }) => s.name === "set_key_press");
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /did not apply KeyPress="Black".*reads "Go\+"/);
  assert.equal(first.result.steps.find((s: { name: string }) => s.name === "set_fader").status, "skipped");
  assert.equal(first.result.verification.status, "mismatched");
  // A refusal after a confirmed write is partial.
  h.fake.requests.length = 0;
  const { result, isError } = await h.callJson("gma3_configure_executor", { page: 1, executor: 201, key_press: "Toggle", fader: "Temp", encoder: "Rate", ma_key_press: "Black" });
  assert.equal(isError, true);
  assert.deepEqual(sets(), ["Page 1.201 KeyPress=Toggle", "Page 1.201 MAKeyPress=Black"]);
  assert.equal(result.outcome, "partial");
  assert.equal(result.steps.find((s: { name: string }) => s.name === "set_fader").status, "skipped");
});

test("after a failed change the removed lock is still restored", async () => {
  con.pages.get(1)!.execs.get(201)!.props.Lock = "UL";
  con.refuse.KeyPress = ["Swap"];
  const { result, isError } = await h.callJson("gma3_configure_executor", { page: 1, executor: 201, key_press: "Swap", unlock: true });
  assert.equal(isError, true);
  assert.deepEqual(sets(), ["Page 1.201 Lock=No", "Page 1.201 KeyPress=Swap", "Page 1.201 Lock=Yes"]);
  assert.equal(result.outcome, "partial");
  assert.equal(con.pages.get(1)!.execs.get(201)!.props.Lock, "UL");
});

test("a lost reply makes the outcome unknown, is never resent, and the lock is still restored", async () => {
  con.pages.get(1)!.execs.get(201)!.props.Lock = "UL";
  con.silentSets.add("Page 1.201 KeyPress=Temp");
  const { result, isError } = await h.callJson("gma3_configure_executor", { page: 1, executor: 201, key_press: "Temp", fader: "Temp", unlock: true });
  assert.equal(isError, true);
  assert.equal(result.outcome, "partial");
  assert.equal(result.steps.find((s: { name: string }) => s.name === "set_key_press").status, "unknown");
  assert.deepEqual(sets(), ["Page 1.201 Lock=No", "Page 1.201 KeyPress=Temp", "Page 1.201 Lock=Yes"]);
});

test("a failed relock is reported as a warning", async () => {
  con.pages.get(1)!.execs.get(201)!.props.Lock = "UL";
  con.silentSets.add("Page 1.201 Lock=Yes");
  const { result, isError } = await h.callJson("gma3_configure_executor", { page: 1, executor: 201, key_press: "Temp", unlock: true });
  assert.equal(isError, true);
  assert.ok(result.warnings.some((w: string) => /could not be restored.*UNLOCKED/.test(w)), JSON.stringify(result.warnings));
});

// ---------------------------------------------------------------------------
// gma3_configure_sequence
// ---------------------------------------------------------------------------

test("configure_sequence writes settings, reads them back and lists every executor sharing the sequence", async () => {
  const { result, isError } = await h.callJson("gma3_configure_sequence", { sequence: 5, wrap_around: false, priority: "high", restart_mode: "next_cue", tracking: true });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.verification.status, "matched");
  assert.deepEqual(sets(), ["Sequence 5 WrapAround=No", "Sequence 5 Priority=High", "Sequence 5 RestartMode=Next Cue"]);
  assert.deepEqual(result.intended.unchanged, ["tracking"]);
  assert.deepEqual(result.references.executors.map((r: { ref: string }) => r.ref).sort(), ["Page 1.201", "Page 2.305"]);
  assert.equal(result.references.complete, true);
  assert.ok(result.warnings.some((w: string) => /also apply to .*Page 1\.201.*Page 2\.305|also apply to .*Page 2\.305.*Page 1\.201/.test(w)), JSON.stringify(result.warnings));
  assert.deepEqual(result.playback, { activeBefore: false, activeAfter: false });
  assert.equal(con.seqs.get(5)!.props.WrapAround, "No");
});

test("configure_sequence on a sequence used by one executor does not warn about sharing", async () => {
  const { result, isError } = await h.callJson("gma3_configure_sequence", { sequence: 7, wrap_around: false });
  assert.equal(isError, false, JSON.stringify(result));
  assert.deepEqual(result.references.executors.map((r: { ref: string }) => r.ref), ["Page 1.202"]);
  assert.equal(result.warnings, undefined);
});

test("configure_sequence reports an incomplete reference scan without blocking the change", async () => {
  con.childrenError = true;
  const { result, isError } = await h.callJson("gma3_configure_sequence", { sequence: 5, wrap_around: false });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.references.complete, false);
  assert.ok(result.warnings.some((w: string) => /could not all be determined/.test(w)));
});

test("a locked sequence is refused, unlock: true relocks it, lock: false unlocks it for good", async () => {
  con.seqs.get(5)!.props.Lock = "UL";
  const refused = await h.callJson("gma3_configure_sequence", { sequence: 5, wrap_around: false });
  assert.equal(refused.isError, true);
  assert.match(refused.result.summary, /locked.*unlock: true/);
  assert.deepEqual(sets(), []);
  const ok = await h.callJson("gma3_configure_sequence", { sequence: 5, wrap_around: false, unlock: true });
  assert.equal(ok.isError, false, JSON.stringify(ok.result));
  assert.deepEqual(sets(), ["Sequence 5 Lock=No", "Sequence 5 WrapAround=No", "Sequence 5 Lock=Yes"]);
  assert.equal(con.seqs.get(5)!.props.Lock, "UL");
  h.fake.requests.length = 0;
  const open = await h.callJson("gma3_configure_sequence", { sequence: 5, priority: "htp", lock: false });
  assert.equal(open.isError, false, JSON.stringify(open.result));
  assert.deepEqual(sets(), ["Sequence 5 Lock=No", "Sequence 5 Priority=HTP"]);
  assert.equal(con.seqs.get(5)!.props.Lock, "");
});

test("configure_sequence lock: true locks a sequence and a missing sequence is refused", async () => {
  const ok = await h.callJson("gma3_configure_sequence", { sequence: 5, lock: true });
  assert.equal(ok.isError, false, JSON.stringify(ok.result));
  assert.deepEqual(sets(), ["Sequence 5 Lock=Yes"]);
  const missing = await h.callJson("gma3_configure_sequence", { sequence: 42, wrap_around: true });
  assert.equal(missing.isError, true);
  assert.match(missing.result.summary, /Sequence 42 does not exist/);
});

test("configure_sequence preview sends nothing; a structure-locked sequence is refused", async () => {
  const pv = await h.callJson("gma3_configure_sequence", { sequence: 5, kill_protect: true, xfade_mode: "split", preview: true });
  assert.equal(pv.isError, false);
  assert.deepEqual(pv.result.intended.changes.map((c: { property: string; to: string }) => `${c.property}=${c.to}`), ["KillProtect=Yes", "XFadeMode=Split"]);
  assert.deepEqual(sets(), []);
  con.seqs.get(5)!.props.StructureLocked = "Yes";
  const hard = await h.callJson("gma3_configure_sequence", { sequence: 5, kill_protect: true, unlock: true });
  assert.equal(hard.isError, true);
  assert.match(hard.result.summary, /structure- or system-locked/);
  assert.deepEqual(sets(), []);
});

test("an operator starting playback during configuration is reported, not hidden", async () => {
  const orig = h.fake.handlerFor("set")!;
  h.fake.on("set", (args, req) => {
    con.seqs.get(5)!.active = true;
    return orig(args, req);
  });
  const { result } = await h.callJson("gma3_configure_sequence", { sequence: 5, wrap_around: false });
  assert.deepEqual(result.playback, { activeBefore: false, activeAfter: true });
  assert.ok(result.warnings.some((w: string) => /active playback after the configuration/.test(w)));
});

// ---------------------------------------------------------------------------
// gma3_executor_settings
// ---------------------------------------------------------------------------

test("executor_settings reports functions, locks by owner, allowed choices, sequence settings and sharing executors", async () => {
  con.seqs.get(5)!.props.KillProtect = "Yes";
  con.pages.get(1)!.execs.get(201)!.props.KeyUnpressCombined = "";
  const { result, isError } = await h.callJson("gma3_executor_settings", { page: 1, executor: 201 });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.empty, false);
  assert.equal(result.executorSettings.functions.key_press, "Go+");
  assert.equal(result.executorSettings.functions.key_unpress, "Empty");
  assert.equal(result.executorSettings.locked, false);
  assert.ok(result.allowedFunctions.key_press.includes("Flash"));
  assert.ok(!result.allowedFunctions.encoder_left.includes("Flash"));
  assert.equal(result.sequence.ref, "Sequence 5");
  assert.equal(result.sequence.settings.wrap_around, true);
  assert.equal(result.sequence.settings.priority, "ltp");
  assert.equal(result.sequence.settings.restart_mode, "first_cue");
  assert.equal(result.sequence.active, false);
  assert.equal(result.protection.sequence.killProtect, true);
  assert.equal(result.protection.page.locked, false);
  assert.deepEqual(result.references.executors.map((r: { ref: string }) => r.ref).sort(), ["Page 1.201", "Page 2.305"]);
  assert.ok(result.warnings.some((w: string) => /also apply to Page 2\.305/.test(w)));
  assert.deepEqual(sets(), []);
});

test("executor_settings on an empty executor or a missing page says so", async () => {
  con.exec(1, 210, null);
  const empty = await h.callJson("gma3_executor_settings", { page: 1, executor: 210 });
  assert.equal(empty.isError, false);
  assert.equal(empty.result.empty, true);
  const missing = await h.callJson("gma3_executor_settings", { page: 8, executor: 201 });
  assert.equal(missing.result.pageExists, false);
  const bad = await h.callJson("gma3_executor_settings", { page: 1, executor: 99 });
  assert.equal(bad.isError, true);
});

// ---------------------------------------------------------------------------
// Review round 1: values that could not be read are unknown, never "unlocked", "Empty" or "unchanged"
// ---------------------------------------------------------------------------

test("an executor Lock that could not be read refuses the change; lock: false is not a no-op", async () => {
  con.pages.get(1)!.execs.get(201)!.props.Lock = "UL";
  con.unreadable.add("Page 1.201 Lock");
  for (const args of [{ key_press: "Temp" }, { lock: false }, { lock: false, unlock: true }]) {
    const { result, isError } = await h.callJson("gma3_configure_executor", { page: 1, executor: 201, ...args });
    assert.equal(isError, true, JSON.stringify(args));
    assert.equal(result.outcome, "failed");
    assert.notEqual(result.noop, true);
    assert.match(result.summary, /Lock of Page 1\.201 could not be read/);
  }
  assert.deepEqual(sets(), []);
  assert.equal(con.pages.get(1)!.execs.get(201)!.props.Lock, "UL");
});

test("a page Lock or a requested function that could not be read refuses the change", async () => {
  con.unreadable.add("Page 1 Lock");
  const page = await h.callJson("gma3_configure_executor", { page: 1, executor: 201, key_press: "Temp" });
  assert.equal(page.isError, true);
  assert.match(page.result.summary, /Lock of Page 1 could not be read/);
  con.unreadable.clear();
  con.unreadable.add("Page 1.201 KeyUnpress");
  const fn = await h.callJson("gma3_configure_executor", { page: 1, executor: 201, key_unpress: "Empty" });
  assert.equal(fn.isError, true);
  assert.match(fn.result.summary, /KeyUnpress of Page 1\.201 could not be read/);
  assert.deepEqual(sets(), []);
});

test("a sequence Lock that could not be read refuses the change; lock: false is not a no-op", async () => {
  con.seqs.get(5)!.props.Lock = "UL";
  con.unreadable.add("Sequence 5 Lock");
  for (const args of [{ wrap_around: false }, { lock: false }]) {
    const { result, isError } = await h.callJson("gma3_configure_sequence", { sequence: 5, ...args });
    assert.equal(isError, true, JSON.stringify(args));
    assert.notEqual(result.noop, true);
    assert.match(result.summary, /Lock of Sequence 5 could not be read/);
  }
  con.unreadable.clear();
  con.unreadable.add("Sequence 5 WrapAround");
  const setting = await h.callJson("gma3_configure_sequence", { sequence: 5, wrap_around: true });
  assert.equal(setting.isError, true);
  assert.match(setting.result.summary, /WrapAround of Sequence 5 could not be read/);
  assert.deepEqual(sets(), []);
});

test("a set reply without a value is unknown: it neither confirms an unlock nor an Empty function", async () => {
  con.pages.get(1)!.execs.get(201)!.props.Lock = "UL";
  con.noValueSets.add("Page 1.201 Lock=No");
  const unlock = await h.callJson("gma3_configure_executor", { page: 1, executor: 201, lock: false });
  assert.equal(unlock.isError, true);
  assert.equal(unlock.result.outcome, "unknown");
  assert.equal(unlock.result.steps.find((s: { name: string }) => s.name === "unlock").status, "unknown");

  h.fake.requests.length = 0;
  con.pages.get(1)!.execs.get(201)!.props.Lock = "";
  con.pages.get(1)!.execs.get(201)!.props.KeyUnpress = "Off";
  con.noValueSets.add("Page 1.201 KeyUnpress=Empty");
  const empty = await h.callJson("gma3_configure_executor", { page: 1, executor: 201, key_unpress: "Empty", fader: "Temp" });
  assert.equal(empty.isError, true);
  assert.equal(empty.result.outcome, "unknown");
  assert.match(empty.result.steps.find((s: { name: string }) => s.name === "set_key_unpress").error, /could not be read back/);
  assert.equal(empty.result.steps.find((s: { name: string }) => s.name === "set_fader").status, "skipped");
});

test("an unconfirmed unlock is still followed by a relock attempt", async () => {
  con.pages.get(1)!.execs.get(201)!.props.Lock = "UL";
  con.noValueSets.add("Page 1.201 Lock=No");
  const { result, isError } = await h.callJson("gma3_configure_executor", { page: 1, executor: 201, key_press: "Temp", unlock: true });
  assert.equal(isError, true);
  assert.deepEqual(sets(), ["Page 1.201 Lock=No", "Page 1.201 Lock=Yes"]);
  assert.equal(result.steps.find((s: { name: string }) => s.name === "relock_executor").status, "succeeded");
});

test("a read-back missing the Lock or a function does not verify", async () => {
  const orig = h.fake.handlerFor("objects")!;
  let reads = 0;
  h.fake.on("objects", (args, req) => {
    // Reads of Page 1.201 that include Lock: read_executor first, then the read-back, which loses Lock and KeyPress.
    if (args.ref === "Page 1.201" && (args.fields as string[]).includes("Lock") && ++reads === 2) {
      const res = orig(args, req) as { items: Array<{ fields: Record<string, unknown> }> };
      delete res.items[0].fields.Lock;
      delete res.items[0].fields.KeyPress;
      return res;
    }
    return orig(args, req);
  });
  const { result, isError } = await h.callJson("gma3_configure_executor", { page: 1, executor: 201, key_press: "Temp" });
  assert.equal(isError, true);
  assert.equal(result.verification.status, "mismatched");
  assert.match(result.verification.detail, /KeyPress.*Lock|Lock.*KeyPress/);
});

test("executor_settings reports a value that could not be read as null and lists it", async () => {
  con.unreadable.add("Page 1.201 Lock");
  con.unreadable.add("Page 1.201 Fader");
  con.unreadable.add("Page 1 Lock");
  const { result } = await h.callJson("gma3_executor_settings", { page: 1, executor: 201, references: false });
  assert.equal(result.executorSettings.locked, null);
  assert.equal(result.executorSettings.functions.fader, null);
  assert.equal(result.executorSettings.functions.key_press, "Go+");
  assert.equal(result.pageInfo.locked, null);
  assert.deepEqual(result.unreadable.sort(), ["Fader", "Lock"]);
});

// ---------------------------------------------------------------------------
// Review round 1: an executor holding a sequence from another data pool
// ---------------------------------------------------------------------------

test("a sequence from another data pool is read by its address, not as the local sequence of the same number", async () => {
  con.seq(5, "Remote", { WrapAround: "No", Priority: "High", Lock: "UL" }, 2);
  con.exec(1, 220, 5, {}, 2);
  con.pools.get(2)!.get(5)!.active = true;
  const { result, isError } = await h.callJson("gma3_executor_settings", { page: 1, executor: 220 });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.sequence.addr, "14.14.2.7.5");
  assert.equal(result.sequence.dataPool, "other");
  assert.equal(result.sequence.ref, null);
  assert.equal(result.sequence.name, "Remote");
  assert.equal(result.sequence.settings.wrap_around, false);
  assert.equal(result.sequence.settings.priority, "high");
  assert.equal(result.sequence.locked, true);
  assert.equal(result.sequence.active, true);
  assert.match(result.sequence.note, /another data pool/);
  assert.deepEqual(result.references.executors.map((r: { ref: string }) => r.ref), ["Page 1.220"]);

  const local = await h.callJson("gma3_executor_settings", { page: 1, executor: 201, references: false });
  assert.equal(local.result.sequence.dataPool, "current");
  assert.equal(local.result.sequence.ref, "Sequence 5");
  assert.equal(local.result.sequence.settings.wrap_around, true);
});

test("configure_executor watches the playback of the sequence the executor actually holds", async () => {
  con.seq(5, "Remote", {}, 2);
  con.exec(1, 220, 5, {}, 2);
  con.pools.get(2)!.get(5)!.active = true;
  const { result, isError } = await h.callJson("gma3_configure_executor", { page: 1, executor: 220, key_press: "Temp" });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.sequenceAddr, "14.14.2.7.5");
  assert.deepEqual(result.playback, { activeBefore: true, activeAfter: true });
  const playbackReads = h.fake.requests.filter((r) => r.op === "object").map((r) => r.args.ref);
  assert.deepEqual(playbackReads, ["14.14.2.7.5", "14.14.2.7.5"]);
});
