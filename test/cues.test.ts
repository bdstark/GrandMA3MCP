/**
 * FR-04 / FR-05 cue tools against an in-process FakeBridge.
 *
 * `FakeShow` is a tiny model of the console's cue data: a map of command-line references
 * ("Sequence 900 Cue 2", "Sequence 900 Cue 2 Part 0") to property records. It answers the `objects`,
 * `set`, `object` and `cmd` ops the way grandMA3 2.5.1 does (empty list for a missing object, display
 * text such as "2.50" / "CueTiming" for timing, "OK" / "Syntax Error" feedback) so the tools are exercised
 * through their real code paths. Individual tests override handlers to inject failures.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { registerCueTools } from "../src/tools/cues.ts";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { SILENT, type FakeBridge } from "./helpers/fake-bridge.ts";

type Props = Record<string, string>;

const norm = (ref: string) => ref.trim().replace(/\s+/g, " ").toLowerCase();
const fmtTime = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : String(v);
};

class FakeShow {
  objects = new Map<string, Props>();
  selected: number | null = 900;
  /** When true, a reference into a sequence that has no objects raises like ObjectList() returning nil. */
  missingThrows = false;
  /** When true, Delete answers OK but leaves the cue in place. */
  deleteIsNoop = false;

  cueKey(seq: number | string, cue: string, part?: number) {
    return norm(`Sequence ${seq} Cue ${cue}${part !== undefined ? ` Part ${part}` : ""}`);
  }

  addCue(seq: number | string, cue: string, props: Props = {}, parts: number[] = [0]) {
    const name = props.Name ?? "";
    this.objects.set(this.cueKey(seq, cue), { No: cue, Name: name, TrigType: "Go", TrigTime: "0.00", ...props });
    for (const p of parts) this.addPart(seq, cue, p, { Name: name });
  }

  addPart(seq: number | string, cue: string, part: number, props: Props = {}) {
    this.objects.set(this.cueKey(seq, cue, part), {
      Part: String(part),
      Name: "",
      CueInFade: "0.00",
      CueInDelay: "0.00",
      CueOutFade: "CueTiming",
      CueOutDelay: "CueTiming",
      SnapDelay: "0.00",
      ...props,
    });
  }

  has(ref: string) {
    return this.objects.has(norm(ref));
  }

  get(ref: string) {
    return this.objects.get(norm(ref));
  }

  install(fake: FakeBridge) {
    fake.on("objects", ({ ref, fields }) => {
      const key = norm(String(ref));
      const o = this.objects.get(key);
      if (!o) {
        const seq = key.match(/^sequence (\d+)/);
        const anyInSeq = seq && [...this.objects.keys()].some((k) => k.startsWith(`sequence ${seq[1]} `));
        if (this.missingThrows && !anyInSeq) throw new Error(`no objects found for '${ref}'`);
        return { total: 0, offset: 0, count: 0, items: [] };
      }
      const f: Record<string, unknown> = {};
      for (const name of (fields as string[] | undefined) ?? []) f[name] = o[name] ?? "";
      return { total: 1, offset: 0, count: 1, items: [{ name: o.Name, class: key.includes(" part ") ? "Part" : "Cue", fields: f }] };
    });
    fake.on("set", ({ ref, property, value }) => {
      const key = norm(String(ref));
      const o = this.objects.get(key);
      if (!o) throw new Error(`no object found for '${ref}'`);
      const prop = String(property);
      const isPart = key.includes(" part ");
      // Console behaviour (2.5.1): Set(Name) on a Cue and Set(CueFade/CueDelay) on a Part are silently ignored.
      if ((prop === "Name" && !isPart) || (isPart && /^Cue(Fade|Delay)$/.test(prop))) return { ref, property, value: o[prop] };
      o[prop] = /fade|delay|time$/i.test(prop) ? fmtTime(value) : String(value);
      // Part 0's name is the cue's name.
      if (prop === "Name" && isPart && o.Part === "0") {
        const cue = this.objects.get(key.replace(/ part \d+$/, ""));
        if (cue) cue.Name = o.Name;
      }
      return { ref, property, value: o[prop] };
    });
    fake.on("object", ({ ref }) => {
      if (norm(String(ref)) !== "selectedsequence") throw new Error(`no object found for '${ref}'`);
      if (this.selected === null) throw new Error("no object found for 'SelectedSequence'");
      return { name: `Seq ${this.selected}`, class: "Sequence", index: this.selected, addr: `14.14.1.7.${this.selected}` };
    });
    fake.onCommand((command) => this.exec(command));
  }

  exec(command: string): string | typeof SILENT {
    const store = command.match(/^Store Sequence (\d+) Cue ([\d.]+)(?: Part (\d+))?((?: \/\w+)*)$/);
    if (store) {
      const [, seq, cue, part, opts] = store;
      const options = opts.trim().split(/\s+/).filter(Boolean);
      if (!options.includes("/NoConfirmation")) return "Error: a store pop-up would have opened";
      if (!this.has(`Sequence ${seq} Cue ${cue}`)) this.addCue(seq, cue);
      if (part !== undefined && !this.has(`Sequence ${seq} Cue ${cue} Part ${part}`)) this.addPart(seq, cue, Number(part));
      return "OK";
    }
    const del = command.match(/^Delete Sequence (\d+) Cue ([\d.]+) \/NoConfirmation$/);
    if (del) {
      if (!this.deleteIsNoop) {
        const prefix = this.cueKey(del[1], del[2]);
        for (const k of [...this.objects.keys()]) if (k === prefix || k.startsWith(prefix + " ")) this.objects.delete(k);
      }
      return "OK";
    }
    if (/^Goto Sequence \d+ Cue [\d.]+( Fade [\d.]+)?$/.test(command)) return "OK";
    return "Syntax Error";
  }
}

let h: Harness;
let show: FakeShow;

before(async () => {
  h = await startHarness(registerCueTools);
});
after(() => h.close());
beforeEach(() => {
  h.fake.reset();
  show = new FakeShow();
  show.install(h.fake);
});

const setRequests = () => h.fake.requests.filter((r) => r.op === "set").map((r) => r.args as { ref: string; property: string; value: string });

// ---------------------------------------------------------------------------
// gma3_store_cue
// ---------------------------------------------------------------------------

test("store_cue create: refuses an existing cue and sends nothing", async () => {
  show.addCue(900, "1");
  const { result, isError } = await h.callJson("gma3_store_cue", { sequence: 900, cue: 1, mode: "create" });
  assert.equal(isError, true);
  assert.equal(result.outcome, "failed");
  assert.equal(result.steps[0].name, "check_existing");
  assert.equal(result.steps[0].status, "failed");
  assert.equal(result.steps[0].kind, "read");
  assert.match(result.steps[0].error, /already exists/);
  assert.match(result.steps[0].error, /not a transaction lock/);
  assert.equal(result.steps[1].status, "skipped");
  assert.deepEqual(h.fake.commands, []);
  assert.equal(setRequests().length, 0);
  assert.equal(result.verification.status, "unavailable");
});

test("store_cue create: stores a new cue with /NoConfirmation only and verifies existence", async () => {
  const { result, isError } = await h.callJson("gma3_store_cue", { sequence: 900, cue: 1, mode: "create" });
  assert.equal(isError, false, result.summary);
  assert.deepEqual(h.fake.commands, ["Store Sequence 900 Cue 1 /NoConfirmation"]);
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.verification.status, "matched");
  assert.deepEqual(result.target, { sequence: 900, sequenceSource: "explicit", cue: "1" });
  assert.match(result.summary, /fixture values.*NOT verified/i);
  assert.match(result.notVerified, /FR-10/);
  assert.equal(show.has("Sequence 900 Cue 1"), true);
});

test("store_cue: merge and overwrite send their option, never both, and an unknown mode is rejected by the schema", async () => {
  show.addCue(900, "1");
  const merge = await h.callJson("gma3_store_cue", { sequence: 900, cue: 1, mode: "merge" });
  assert.equal(merge.isError, false, merge.text);
  assert.deepEqual(h.fake.commands, ["Store Sequence 900 Cue 1 /Merge /NoConfirmation"]);
  const over = await h.callJson("gma3_store_cue", { sequence: 900, cue: 1, mode: "overwrite" });
  assert.equal(over.isError, false, over.text);
  assert.equal(h.fake.commands.at(-1), "Store Sequence 900 Cue 1 /Overwrite /NoConfirmation");
  for (const c of h.fake.commands) assert.ok(!(c.includes("/Merge") && c.includes("/Overwrite")), c);
  // No step checks existence in merge/overwrite mode.
  assert.ok(!merge.result.steps.some((s: { name: string }) => s.name === "check_existing"));

  const bad = await h.call("gma3_store_cue", { sequence: 900, cue: 1, mode: "merge overwrite" });
  assert.equal(bad.isError, true);
  const none = await h.call("gma3_store_cue", { sequence: 900, cue: 1 });
  assert.equal(none.isError, true);
  assert.equal(h.fake.commands.length, 2, "rejected requests send nothing");
});

test("store_cue: fractional cue numbers are passed through canonically; ranges are refused", async () => {
  const a = await h.callJson("gma3_store_cue", { sequence: 900, cue: 2.5, mode: "create" });
  assert.equal(a.isError, false, a.text);
  const b = await h.callJson("gma3_store_cue", { sequence: 900, cue: "10.001", mode: "create" });
  assert.equal(b.isError, false, b.text);
  const c = await h.callJson("gma3_store_cue", { sequence: 900, cue: "3.000", mode: "create" });
  assert.equal(c.isError, false, c.text);
  assert.deepEqual(h.fake.commands, [
    "Store Sequence 900 Cue 2.5 /NoConfirmation",
    "Store Sequence 900 Cue 10.001 /NoConfirmation",
    "Store Sequence 900 Cue 3 /NoConfirmation",
  ]);
  for (const cue of ["1 Thru 5", "1 + 2", "2.5555", "abc", 0, -1]) {
    const r = await h.callJson("gma3_store_cue", { sequence: 900, cue, mode: "create" });
    assert.equal(r.isError, true, String(cue));
    if (typeof r.result === "object") assert.equal(r.result.outcome, "failed");
  }
  assert.equal(h.fake.commands.length, 3);
});

test("store_cue: split timing goes to part 0 one Set per field, zero is a value, negatives are refused", async () => {
  const { result, isError } = await h.callJson("gma3_store_cue", { sequence: 900, cue: 1, mode: "create", fade: 3, out_fade: 0, out_delay: 1.5 });
  assert.equal(isError, false, result.summary);
  assert.deepEqual(h.fake.commands, ["Store Sequence 900 Cue 1 /NoConfirmation"]);
  assert.deepEqual(setRequests(), [
    { ref: "Sequence 900 Cue 1 Part 0", property: "CueInFade", value: "3" },
    { ref: "Sequence 900 Cue 1 Part 0", property: "CueOutFade", value: "0" },
    { ref: "Sequence 900 Cue 1 Part 0", property: "CueOutDelay", value: "1.5" },
  ]);
  assert.deepEqual(
    result.steps.map((s: { name: string; status: string }) => [s.name, s.status]),
    [
      ["check_existing", "succeeded"],
      ["store", "succeeded"],
      ["set_fade", "succeeded"],
      ["set_out_fade", "succeeded"],
      ["set_out_delay", "succeeded"],
    ],
  );
  assert.equal(result.verification.status, "matched");
  assert.equal(result.verification.actual.CueInFade, "3.00");
  assert.equal(result.verification.actual.CueOutFade, "0.00");
  assert.equal(result.verification.actual.CueOutDelay, "1.50");
  // The delay field was not given: not set, not part of the comparison.
  assert.equal(result.verification.expected.CueInDelay, undefined);
  assert.equal(show.get("Sequence 900 Cue 1 Part 0")?.CueInDelay, "0.00");

  for (const bad of [{ fade: -1 }, { delay: Number.NaN }, { out_fade: Number.POSITIVE_INFINITY }]) {
    const r = await h.callJson("gma3_store_cue", { sequence: 900, cue: 2, mode: "create", ...bad });
    assert.equal(r.isError, true);
    assert.equal(r.result.outcome ?? "failed", "failed");
  }
  assert.equal(h.fake.commands.length, 1);
});

test("store_cue: the name is set on part 0 (never inline, never on the cue object) and read back from the cue", async () => {
  const { result, isError } = await h.callJson("gma3_store_cue", { sequence: 900, cue: 1, mode: "create", name: "  Look 1 " });
  assert.equal(isError, false, result.summary);
  assert.deepEqual(h.fake.commands, ["Store Sequence 900 Cue 1 /NoConfirmation"]);
  assert.deepEqual(setRequests(), [{ ref: "Sequence 900 Cue 1 Part 0", property: "Name", value: "Look 1" }], "trimmed, on the part");
  assert.equal(result.verification.status, "matched");
  assert.equal(result.verification.actual.Name, "Look 1");
  assert.equal(show.get("Sequence 900 Cue 1")?.Name, "Look 1");
});

test("store_cue: names with characters the console strips are refused before anything is sent", async () => {
  for (const name of ['Say "hi"', "Look 2.5", "BO*", "a,b", "x;y", "back\\slash", "bad\nname", "   "]) {
    const r = await h.callJson("gma3_store_cue", { sequence: 900, cue: 2, mode: "create", name });
    assert.equal(r.isError, true, name);
    assert.equal(r.result.outcome, "failed", name);
    assert.ok(r.result.validationErrors?.length, name);
  }
  const r = await h.callJson("gma3_store_cue", { sequence: 900, cue: 2, mode: "create", name: "Look 2.5" });
  assert.match(r.result.validationErrors[0], /removes from names/);
  assert.deepEqual(h.fake.requests, []);
});

test("store_cue: a lost reply to Store is an unknown outcome, later steps are skipped and nothing is resent", async () => {
  h.fake.onCommand(() => SILENT);
  const { result, isError } = await h.callJson("gma3_store_cue", { sequence: 900, cue: 1, mode: "create", name: "x", fade: 2 });
  assert.equal(isError, true);
  assert.equal(result.outcome, "unknown");
  const store = result.steps.find((s: { name: string }) => s.name === "store");
  assert.equal(store.status, "unknown");
  assert.match(store.error, /not retried/);
  assert.deepEqual(
    result.steps.filter((s: { status: string }) => s.status === "skipped").map((s: { name: string }) => s.name),
    ["set_name", "set_fade"],
  );
  assert.equal(h.fake.commands.length, 1);
  assert.equal(setRequests().length, 0);
  // Read-back still runs so the client learns what the console did; the cue never appeared here.
  assert.equal(result.verification.status, "mismatched");
  assert.match(result.verification.detail, /does not exist after the store/);
});

test("store_cue: store succeeds but setting the name fails -> partial, remaining steps skipped, read-back mismatched", async () => {
  h.fake.on("set", ({ property }) => {
    if (property === "Name") throw new Error("Set failed: property is read-only");
    throw new Error("should not get here");
  });
  const { result, isError } = await h.callJson("gma3_store_cue", { sequence: 900, cue: 1, mode: "create", name: "Look 1", fade: 2 });
  assert.equal(isError, true);
  assert.equal(result.outcome, "partial");
  assert.deepEqual(
    result.steps.map((s: { name: string; status: string }) => [s.name, s.status]),
    [
      ["check_existing", "succeeded"],
      ["store", "succeeded"],
      ["set_name", "failed"],
      ["set_fade", "skipped"],
    ],
  );
  assert.equal(result.verification.status, "mismatched");
  assert.match(result.verification.detail, /Name/);
  assert.match(result.summary, /partially completed/);
});

test("store_cue: exactly one of sequence / use_selected_sequence; the selected sequence is resolved to its number first", async () => {
  const both = await h.callJson("gma3_store_cue", { sequence: 900, use_selected_sequence: true, cue: 1, mode: "create" });
  assert.equal(both.isError, true);
  assert.match(both.result.validationErrors[0], /mutually exclusive/);
  const neither = await h.callJson("gma3_store_cue", { cue: 1, mode: "create" });
  assert.equal(neither.isError, true);
  assert.match(neither.result.validationErrors[0], /one of sequence, use_selected_sequence is required/);
  assert.deepEqual(h.fake.requests, []);

  show.selected = 905;
  const sel = await h.callJson("gma3_store_cue", { use_selected_sequence: true, cue: 1, mode: "create" });
  assert.equal(sel.isError, false, sel.text);
  assert.equal(sel.result.steps[0].name, "resolve_sequence");
  assert.equal(sel.result.steps[0].op, "object");
  assert.equal(sel.result.steps[0].kind, "read");
  assert.deepEqual(h.fake.commands, ["Store Sequence 905 Cue 1 /NoConfirmation"]);
  assert.deepEqual(sel.result.target, { sequence: 905, sequenceSource: "selected", cue: "1" });

  show.selected = null;
  const none = await h.callJson("gma3_store_cue", { use_selected_sequence: true, cue: 1, mode: "create" });
  assert.equal(none.isError, true);
  assert.equal(none.result.outcome, "failed");
  assert.equal(none.result.steps[0].status, "failed");
  assert.equal(h.fake.commands.length, 1);
});

test("store_cue: a bridge that raises 'no objects found' for a missing sequence is treated as absent", async () => {
  show.missingThrows = true;
  const { result, isError } = await h.callJson("gma3_store_cue", { sequence: 901, cue: 1, mode: "create" });
  assert.equal(isError, false, result.summary);
  assert.equal(result.steps[0].name, "check_existing");
  assert.equal(result.steps[0].status, "succeeded");
  assert.deepEqual(h.fake.commands, ["Store Sequence 901 Cue 1 /NoConfirmation"]);
});

test("store_cue: console feedback that is a recognised error fails the store step and skips the rest", async () => {
  h.fake.onCommand(() => "Illegal Command");
  const { result, isError } = await h.callJson("gma3_store_cue", { sequence: 900, cue: 1, mode: "create", fade: 1 });
  assert.equal(isError, true);
  assert.equal(result.outcome, "failed");
  assert.equal(result.steps[1].status, "failed");
  assert.equal(result.steps[2].status, "skipped");
  assert.equal(setRequests().length, 0);
});

test("store_cue: verify=false reports not_requested and performs no read-back", async () => {
  const { result, isError } = await h.callJson("gma3_store_cue", { sequence: 900, cue: 1, mode: "create", verify: false });
  assert.equal(isError, false, result.summary);
  assert.equal(result.verification.status, "not_requested");
  assert.equal(h.fake.requests.filter((r) => r.op === "objects").length, 1, "only the create-mode existence check reads");
});

test("store tools hold the mutation lock for the whole operation including read-back", async () => {
  // A concurrent mutation must not run between the store command and its read-back: if the lock were
  // released in between, the read-back would verify the other call's work. The Store command is slowed
  // down so the second call is queued while the first is mid-way.
  const order: string[] = [];
  const origCmd = (c: string) => show.exec(c);
  h.fake.on("cmd", async (args) => {
    const c = String(args.command);
    order.push(`cmd:${c}`);
    if (c.startsWith("Store")) await new Promise((r) => setTimeout(r, 40));
    const fb = origCmd(c);
    return fb === SILENT ? SILENT : { command: c, feedback: fb };
  });
  const objectsHandler = h.fake.handlerFor("objects")!;
  const setHandler = h.fake.handlerFor("set")!;
  h.fake.on("objects", (args, req) => {
    order.push(`objects:${args.ref}`);
    return objectsHandler(args, req);
  });
  h.fake.on("set", (args, req) => {
    order.push(`set:${args.ref}:${args.property}`);
    return setHandler(args, req);
  });
  show.addCue(900, "7");
  const [stored, timed] = await Promise.all([
    h.callJson("gma3_store_cue", { sequence: 900, cue: 1, mode: "create", name: "First" }),
    h.callJson("gma3_set_cue_timing", { sequence: 900, cue: 7, fade: 2 }),
  ]);
  assert.equal(stored.result.outcome, "succeeded", stored.text);
  assert.equal(timed.result.outcome, "succeeded", timed.text);
  const firstOfSecond = order.findIndex((o) => o.includes("Cue 7"));
  const lastOfFirst = order.map((o, idx) => (o.includes("Cue 1") ? idx : -1)).filter((idx) => idx >= 0).at(-1)!;
  assert.ok(firstOfSecond > lastOfFirst, `the second call ran before the first call's read-back finished:\n${order.join("\n")}`);
  assert.ok(order.slice(0, firstOfSecond).some((o) => o.startsWith("objects:Sequence 900 Cue 1")), "the store's read-back is part of the first call");
});

// ---------------------------------------------------------------------------
// gma3_store_cue_part
// ---------------------------------------------------------------------------

test("store_cue_part: stores a part, applies name/timing to the part, documents part 0", async () => {
  show.addCue(900, "1");
  const { result, isError } = await h.callJson("gma3_store_cue_part", { sequence: 900, cue: 1, part: 1, mode: "create", name: "Movers", delay: 0 });
  assert.equal(isError, false, result.summary);
  assert.deepEqual(h.fake.commands, ["Store Sequence 900 Cue 1 Part 1 /NoConfirmation"]);
  assert.deepEqual(setRequests(), [
    { ref: "Sequence 900 Cue 1 Part 1", property: "Name", value: "Movers" },
    { ref: "Sequence 900 Cue 1 Part 1", property: "CueInDelay", value: "0" },
  ]);
  assert.equal(result.verification.status, "matched");
  assert.deepEqual(result.target, { sequence: 900, sequenceSource: "explicit", cue: "1", part: 1 });

  // Part 0 of an existing cue always exists, so create refuses it; merge works and the result explains part 0.
  const p0 = await h.callJson("gma3_store_cue_part", { sequence: 900, cue: 1, part: 0, mode: "create" });
  assert.equal(p0.isError, true);
  assert.equal(p0.result.steps[0].name, "check_existing");
  assert.equal(h.fake.commands.length, 1);
  const p0merge = await h.callJson("gma3_store_cue_part", { sequence: 900, cue: 1, part: 0, mode: "merge" });
  assert.equal(p0merge.isError, false, p0merge.text);
  assert.equal(h.fake.commands.at(-1), "Store Sequence 900 Cue 1 Part 0 /Merge /NoConfirmation");
  assert.match(p0merge.result.partZeroNote, /main part/);

  const tool = h.tools.get("gma3_store_cue_part")!;
  assert.match(tool.description ?? "", /Part 0 is the main part/);
  const badPart = await h.callJson("gma3_store_cue_part", { sequence: 900, cue: 1, part: 1.5, mode: "merge" });
  assert.equal(badPart.isError, true);
  const noPart = await h.call("gma3_store_cue_part", { sequence: 900, cue: 1, mode: "merge" });
  assert.equal(noPart.isError, true);
});

// ---------------------------------------------------------------------------
// gma3_set_cue_timing
// ---------------------------------------------------------------------------

test("set_cue_timing: only the given fields are set (zero included), on the given part, with read-back", async () => {
  // The fake, like the console, ignores Set() on the composite CueFade/CueDelay; the tools must never use them.
  show.addCue(900, "2", {}, [0, 3]);
  const { result, isError } = await h.callJson("gma3_set_cue_timing", { sequence: 900, cue: 2, part: 3, out_fade: 0, snap_delay: 0.25 });
  assert.equal(isError, false, result.summary);
  assert.deepEqual(h.fake.commands, [], "no command-line command is used");
  assert.deepEqual(setRequests(), [
    { ref: "Sequence 900 Cue 2 Part 3", property: "CueOutFade", value: "0" },
    { ref: "Sequence 900 Cue 2 Part 3", property: "SnapDelay", value: "0.25" },
  ]);
  assert.equal(result.verification.status, "matched");
  assert.deepEqual(result.changed, { CueOutFade: 0, SnapDelay: 0.25 });
  assert.ok(!h.fake.requests.some((r) => r.op === "set" && /^Cue(Fade|Delay)$/.test(String(r.args.property))), "composite properties are never written");
  assert.equal(result.target.part, 3);
  assert.equal(show.get("Sequence 900 Cue 2 Part 3")?.CueInFade, "0.00");
  assert.equal(show.get("Sequence 900 Cue 2 Part 0")?.CueOutFade, "CueTiming", "other parts untouched");
});

test("set_cue_timing: defaults to part 0, requires at least one field, refuses a missing cue without sending", async () => {
  show.addCue(900, "2");
  const ok = await h.callJson("gma3_set_cue_timing", { sequence: 900, cue: 2, fade: 4, delay: 0 });
  assert.equal(ok.isError, false, ok.text);
  assert.equal(setRequests()[0].ref, "Sequence 900 Cue 2 Part 0");
  assert.equal(ok.result.target.part, 0);

  const empty = await h.callJson("gma3_set_cue_timing", { sequence: 900, cue: 2 });
  assert.equal(empty.isError, true);
  assert.match(empty.result.validationErrors[0], /at least one of/);

  h.fake.requests.length = 0;
  const missing = await h.callJson("gma3_set_cue_timing", { sequence: 900, cue: 7, fade: 1 });
  assert.equal(missing.isError, true);
  assert.equal(missing.result.outcome, "failed");
  assert.equal(missing.result.steps[0].name, "check_target");
  assert.match(missing.result.steps[0].error, /does not exist; nothing was sent/);
  assert.equal(setRequests().length, 0);
  assert.equal(missing.result.verification.status, "unavailable");
});

test("set_cue_timing: read-back that disagrees with the request is mismatched and an MCP error", async () => {
  show.addCue(900, "2");
  h.fake.on("set", ({ ref, property }) => {
    show.get(String(ref))![String(property)] = "9.99"; // console clamped/ignored our value
    return { ref, property, value: "9.99" };
  });
  const { result, isError } = await h.callJson("gma3_set_cue_timing", { sequence: 900, cue: 2, fade: 2 });
  assert.equal(isError, true);
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.verification.status, "mismatched");
  assert.match(result.verification.detail, /CueInFade: expected 2, read "9.99"/);
});

test("set_cue_timing: a failed second Set leaves a partial outcome with the first field verified against read-back", async () => {
  show.addCue(900, "2");
  let n = 0;
  const base = show;
  h.fake.on("set", ({ ref, property, value }) => {
    n++;
    if (n === 2) throw new Error("Set failed: bad value");
    base.get(String(ref))![String(property)] = fmtTime(value);
    return { ref, property, value };
  });
  const { result } = await h.callJson("gma3_set_cue_timing", { sequence: 900, cue: 2, fade: 1, delay: 2, out_fade: 3 });
  assert.equal(result.outcome, "partial");
  assert.deepEqual(
    result.steps.map((s: { name: string; status: string }) => [s.name, s.status]),
    [
      ["check_target", "succeeded"],
      ["set_fade", "succeeded"],
      ["set_delay", "failed"],
      ["set_out_fade", "skipped"],
    ],
  );
  assert.equal(result.verification.status, "mismatched");
  assert.match(result.verification.detail, /CueInDelay/);
  assert.ok(!/CueInFade/.test(result.verification.detail));
});

// ---------------------------------------------------------------------------
// gma3_set_cue_trigger
// ---------------------------------------------------------------------------

test("set_cue_trigger: validates the enum and its time parameter before anything is sent", async () => {
  show.addCue(900, "2");
  const bad = await h.call("gma3_set_cue_trigger", { sequence: 900, cue: 2, trigger: "timecode" });
  assert.equal(bad.isError, true);
  const noTime = await h.callJson("gma3_set_cue_trigger", { sequence: 900, cue: 2, trigger: "time" });
  assert.equal(noTime.isError, true);
  assert.match(noTime.result.validationErrors[0], /time .* required/);
  const goWithTime = await h.callJson("gma3_set_cue_trigger", { sequence: 900, cue: 2, trigger: "go", time: 2 });
  assert.equal(goWithTime.isError, true);
  assert.match(goWithTime.result.validationErrors[0], /not applicable/);
  const negative = await h.callJson("gma3_set_cue_trigger", { sequence: 900, cue: 2, trigger: "time", time: -1 });
  assert.equal(negative.isError, true);
  assert.deepEqual(h.fake.requests, []);
});

test("set_cue_trigger: sets TrigType then TrigTime, zero accepted, follow without time allowed, read-back verified", async () => {
  show.addCue(900, "2");
  const t = await h.callJson("gma3_set_cue_trigger", { sequence: 900, cue: 2, trigger: "time", time: 0 });
  assert.equal(t.isError, false, t.text);
  assert.deepEqual(setRequests(), [
    { ref: "Sequence 900 Cue 2", property: "TrigType", value: "Time" },
    { ref: "Sequence 900 Cue 2", property: "TrigTime", value: "0" },
  ]);
  assert.equal(t.result.verification.status, "matched");
  assert.deepEqual(t.result.verification.expected, { TrigType: "Time", TrigTime: 0 });
  assert.equal(t.result.verification.actual.TrigType, "Time");

  h.fake.requests.length = 0;
  const f = await h.callJson("gma3_set_cue_trigger", { sequence: 900, cue: 2, trigger: "follow" });
  assert.equal(f.isError, false, f.text);
  assert.deepEqual(setRequests(), [{ ref: "Sequence 900 Cue 2", property: "TrigType", value: "Follow" }]);
  assert.equal(f.result.verification.expected.TrigTime, undefined, "TrigTime not given, not compared");

  h.fake.requests.length = 0;
  const b = await h.callJson("gma3_set_cue_trigger", { sequence: 900, cue: 2, trigger: "bpm" });
  assert.equal(b.isError, false, b.text);
  assert.equal(setRequests()[0].value, "BPM");
  assert.deepEqual(h.fake.commands, []);
});

test("set_cue_trigger: missing cue -> failed with nothing sent; lost reply -> unknown without resend", async () => {
  const missing = await h.callJson("gma3_set_cue_trigger", { sequence: 900, cue: 9, trigger: "follow" });
  assert.equal(missing.isError, true);
  assert.equal(missing.result.outcome, "failed");
  assert.equal(setRequests().length, 0);

  show.addCue(900, "2");
  h.fake.on("set", () => SILENT);
  const lost = await h.callJson("gma3_set_cue_trigger", { sequence: 900, cue: 2, trigger: "time", time: 3 });
  assert.equal(lost.isError, true);
  assert.equal(lost.result.outcome, "unknown");
  assert.equal(lost.result.steps[1].status, "unknown");
  assert.equal(lost.result.steps[2].status, "skipped");
  assert.equal(setRequests().length, 1);
  assert.equal(lost.result.verification.status, "mismatched", "read-back shows the console still has Go");
});

// ---------------------------------------------------------------------------
// gma3_goto_cue
// ---------------------------------------------------------------------------

test("goto_cue: sends Goto with optional Fade, verification not requested, wording says accepted not completed", async () => {
  show.addCue(900, "2");
  const plain = await h.callJson("gma3_goto_cue", { sequence: 900, cue: 2 });
  assert.equal(plain.isError, false, plain.text);
  assert.deepEqual(h.fake.commands, ["Goto Sequence 900 Cue 2"]);
  assert.equal(plain.result.verification.status, "not_requested");
  assert.match(plain.result.summary, /accepted/);
  assert.match(plain.result.summary, /not verified/);
  assert.ok(!/completed\b(?! when)/.test(plain.result.summary.replace("completion is not verified", "")), plain.result.summary);
  assert.match(plain.result.note, /playback mutation/i);

  const faded = await h.callJson("gma3_goto_cue", { sequence: 900, cue: 2, fade: 0 });
  assert.equal(faded.isError, false, faded.text);
  assert.equal(h.fake.commands.at(-1), "Goto Sequence 900 Cue 2 Fade 0");
  const faded2 = await h.callJson("gma3_goto_cue", { sequence: 900, cue: 2, fade: 2.5 });
  assert.equal(h.fake.commands.at(-1), "Goto Sequence 900 Cue 2 Fade 2.5");
  assert.equal(faded2.result.fade, 2.5);

  const tool = h.tools.get("gma3_goto_cue")!;
  assert.match(tool.description ?? "", /PLAYBACK MUTATION/);
});

test("goto_cue: missing cue is refused without sending; a lost reply is unknown and not resent", async () => {
  const missing = await h.callJson("gma3_goto_cue", { sequence: 900, cue: 5 });
  assert.equal(missing.isError, true);
  assert.equal(missing.result.outcome, "failed");
  assert.deepEqual(h.fake.commands, []);

  show.addCue(900, "5");
  h.fake.onCommand(() => SILENT);
  const lost = await h.callJson("gma3_goto_cue", { sequence: 900, cue: 5 });
  assert.equal(lost.isError, true);
  assert.equal(lost.result.outcome, "unknown");
  assert.equal(h.fake.commands.length, 1);
});

// ---------------------------------------------------------------------------
// gma3_delete_cue
// ---------------------------------------------------------------------------

test("delete_cue: missing cue -> failed, nothing sent", async () => {
  const { result, isError } = await h.callJson("gma3_delete_cue", { sequence: 900, cue: 3 });
  assert.equal(isError, true);
  assert.equal(result.outcome, "failed");
  assert.equal(result.steps[0].name, "check_target");
  assert.match(result.steps[0].error, /does not exist; nothing was sent/);
  assert.equal(result.steps[1].status, "skipped");
  assert.deepEqual(h.fake.commands, []);
});

test("delete_cue: deletes one explicit cue with /NoConfirmation and verifies it is gone", async () => {
  show.addCue(900, "3");
  const { result, isError } = await h.callJson("gma3_delete_cue", { sequence: 900, cue: "3" });
  assert.equal(isError, false, result.summary);
  assert.deepEqual(h.fake.commands, ["Delete Sequence 900 Cue 3 /NoConfirmation"]);
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.verification.status, "matched");
  assert.equal(show.has("Sequence 900 Cue 3"), false);
});

test("delete_cue: ranges are refused by validation", async () => {
  for (const cue of ["1 Thru 3", "1 + 2", "Thru"]) {
    const r = await h.callJson("gma3_delete_cue", { sequence: 900, cue });
    assert.equal(r.isError, true, cue);
    assert.equal(r.result.outcome, "failed");
    assert.ok(r.result.validationErrors?.length, cue);
  }
  assert.deepEqual(h.fake.requests, []);
});

test("delete_cue: verification is mismatched when the cue still exists, unavailable when unreadable, unknown on a lost reply", async () => {
  show.addCue(900, "3");
  show.deleteIsNoop = true;
  const still = await h.callJson("gma3_delete_cue", { sequence: 900, cue: 3 });
  assert.equal(still.isError, true);
  assert.equal(still.result.outcome, "succeeded");
  assert.equal(still.result.verification.status, "mismatched");
  assert.match(still.result.verification.detail, /still exists/);

  let reads = 0;
  h.fake.on("objects", (args) => {
    reads++;
    if (reads === 1) return { total: 1, offset: 0, count: 1, items: [{ name: "x", class: "Cue", fields: {} }] };
    throw new Error("bridge busy");
  });
  const unreadable = await h.callJson("gma3_delete_cue", { sequence: 900, cue: 3 });
  assert.equal(unreadable.result.outcome, "succeeded");
  assert.equal(unreadable.result.verification.status, "unavailable");
  assert.match(unreadable.result.verification.detail, /bridge busy/);
  // Under the shared result model only a mismatch is an error; an unreadable read-back is reported, not flagged.
  assert.equal(unreadable.isError, false);

  show.deleteIsNoop = false;
  show.install(h.fake);
  h.fake.requests.length = 0;
  h.fake.onCommand(() => SILENT);
  const lost = await h.callJson("gma3_delete_cue", { sequence: 900, cue: 3 });
  assert.equal(lost.result.outcome, "unknown");
  assert.equal(h.fake.commands.filter((c) => c.startsWith("Delete")).length, 1);
  // The cue is still there (the fake never executed), so read-back reports mismatched rather than guessing.
  assert.equal(lost.result.verification.status, "mismatched");
});

// ---------------------------------------------------------------------------
// Descriptions carry the essential facts
// ---------------------------------------------------------------------------

test("tool descriptions state selection/programmer impact, verification scope and the lock caveat", () => {
  for (const name of ["gma3_store_cue", "gma3_store_cue_part", "gma3_set_cue_timing", "gma3_set_cue_trigger", "gma3_goto_cue", "gma3_delete_cue"]) {
    const d = h.tools.get(name)?.description ?? "";
    assert.match(d, /selection/i, name);
    assert.match(d, /programmer/i, name);
    assert.match(d, /another console operator/, name);
  }
  for (const name of ["gma3_store_cue", "gma3_store_cue_part"]) {
    assert.match(h.tools.get(name)!.description!, /NOT verified/, name);
    assert.match(h.tools.get(name)!.description!, /not a transaction lock/, name);
  }
});
