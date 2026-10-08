import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { SILENT } from "./helpers/fake-bridge.ts";
import { registerExecutorTools, executorNumber } from "../src/tools/executors.ts";
import { ValidationError } from "../src/validate.ts";

/**
 * A tiny model of the show objects the executor tools touch, scripted into the FakeBridge:
 * sequences, pages and executors. `objects` answers by ref and `cmd` understands the exact Assign
 * and Label commands the tools send. As on the console (2.5.1), an executor has no name of its
 * own: its Name is the assigned object's name, and Label on an executor renames the assigned object.
 * Everything else (including the `set` op) is an error.
 */
interface Seq {
  index: number;
  name: string;
}
interface Exec {
  object: Seq | null;
}

class World {
  sequences = new Map<number, Seq>();
  pages = new Map<number, Map<number, Exec>>();
  assignFeedback: string | typeof SILENT = "OK";
  labelFeedback: string | typeof SILENT = "OK";
  /** Lose the reply to every objects request issued after the first command was processed. */
  silentReadsAfterCommand = false;
  private commandsSeen = 0;

  seq(n: number, name = `Seq ${n}`): this {
    this.sequences.set(n, { index: n, name });
    return this;
  }
  page(p: number): this {
    if (!this.pages.has(p)) this.pages.set(p, new Map());
    return this;
  }
  exec(p: number, e: number, seqNo: number | null): this {
    this.page(p);
    const object = seqNo === null ? null : this.sequences.get(seqNo) ?? null;
    this.pages.get(p)!.set(e, { object });
    return this;
  }

  private seqSummary(s: Seq) {
    return { name: s.name, class: "Sequence", addr: `14.14.1.7.${s.index}`, addrNative: `ShowData.DataPools.Default.Sequences.${s.name}`, index: s.index, childCount: 1 };
  }

  objects(args: Record<string, unknown>) {
    if (this.silentReadsAfterCommand && this.commandsSeen > 0) return SILENT;
    const ref = String(args.ref);
    const fields = (args.fields as string[]) ?? [];
    let item: Record<string, unknown> | null = null;
    let m: RegExpMatchArray | null;
    if ((m = ref.match(/^Sequence (\d+)$/))) {
      const s = this.sequences.get(Number(m[1]));
      if (s) item = { ...this.seqSummary(s), fields: pick({ Name: s.name, No: s.index }, fields) };
    } else if ((m = ref.match(/^Page (\d+)$/))) {
      const p = Number(m[1]);
      if (this.pages.has(p)) item = { name: `Page ${p}`, class: "Page", addr: `14.14.1.13.${p}`, index: p, fields: pick({ Name: `Page ${p}` }, fields) };
    } else if ((m = ref.match(/^Page (\d+)\.(\d+)$/))) {
      const ex = this.pages.get(Number(m[1]))?.get(Number(m[2]));
      if (ex) {
        const name = ex.object?.name ?? "";
        item = {
          name,
          class: "Executor",
          addr: `14.14.1.13.${m[1]}.${m[2]}`,
          index: Number(m[2]) - 100,
          fields: pick({ Object: ex.object ? this.seqSummary(ex.object) : "", Name: name }, fields),
        };
      }
    } else {
      throw new Error(`unexpected objects ref ${ref}`);
    }
    return { total: item ? 1 : 0, offset: 0, count: item ? 1 : 0, items: item ? [item] : [] };
  }

  cmd(args: Record<string, unknown>) {
    this.commandsSeen++;
    const command = String(args.command);
    let m: RegExpMatchArray | null;
    if ((m = command.match(/^Assign Sequence (\d+) At Page (\d+)\.(\d+)$/))) {
      if (this.assignFeedback === SILENT) return SILENT;
      if (this.assignFeedback === "OK") {
        const s = this.sequences.get(Number(m[1]));
        if (!s) return { command, feedback: "Illegal Object" };
        this.page(Number(m[2]));
        this.pages.get(Number(m[2]))!.set(Number(m[3]), { object: s });
      }
      return { command, feedback: this.assignFeedback };
    }
    if ((m = command.match(/^Label Page (\d+)\.(\d+) "([^"]*)"$/))) {
      if (this.labelFeedback === SILENT) return SILENT;
      if (this.labelFeedback === "OK") {
        const ex = this.pages.get(Number(m[1]))?.get(Number(m[2]));
        if (!ex?.object) return { command, feedback: "Illegal Object" };
        ex.object.name = m[3]; // Label on an executor renames the assigned object (2.5.1 behaviour).
      }
      return { command, feedback: this.labelFeedback };
    }
    return { command, feedback: "Syntax Error" };
  }

  install(h: Harness): void {
    h.fake.reset();
    h.fake.on("objects", (a) => this.objects(a));
    h.fake.on("cmd", (a) => this.cmd(a));
    h.fake.on("set", () => {
      throw new Error("the set op must not be used by the executor tools");
    });
  }
}

function pick(all: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = all[f] ?? null;
  return out;
}

const PLAYBACK = /\b(Go\+?|Go-|On|Off|Toggle|Flash|Pause|Top|Release|Load|Select)\b/i;
function assertNoPlayback(h: Harness): void {
  for (const c of h.fake.commands) assert.ok(!PLAYBACK.test(c), `playback keyword sent: ${c}`);
  for (const r of h.fake.requests) assert.ok(["objects", "cmd"].includes(r.op), `unexpected op ${r.op}`);
}
const stepNamed = (result: any, name: string) => result.steps.find((s: any) => s.name === name);

let h: Harness;
let world: World;

before(async () => {
  h = await startHarness(registerExecutorTools, { requestTimeoutMs: 300 });
});
after(async () => {
  await h.close();
});
beforeEach(() => {
  world = new World().seq(5, "Look").seq(7, "Other").page(1).page(2);
  world.install(h);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("executorNumber accepts the four rows and the Xkeys and rejects everything else", () => {
  for (const ok of [101, 190, 191, 198, 201, 290, 291, 298, 301, 390, 401, 490]) assert.equal(executorNumber("executor", ok), ok);
  for (const bad of [0, 1, 100, 191.5, 199, 200, 299, 391, 398, 491, 500, 1001, -201, NaN, Infinity]) {
    assert.throws(() => executorNumber("executor", bad), ValidationError, `expected ${bad} to be rejected`);
  }
});

test("invalid identifiers are refused before anything is sent", async () => {
  for (const args of [
    { sequence: 5, page: 1, executor: 0 },
    { sequence: 5, page: 0, executor: 201 },
    { sequence: 0, page: 1, executor: 201 },
    { sequence: 5, page: 1, executor: 199 },
    { sequence: 5, page: 1, executor: 201.5 },
    { sequence: 5, page: 1, executor: NaN },
    { sequence: NaN, page: 1, executor: 201 },
    { sequence: 5, page: 1, executor: 201, label: "bad\nname" },
  ]) {
    const { result, isError } = await h.callJson("gma3_assign_to_executor", args);
    assert.equal(isError, true, JSON.stringify(args));
    if (typeof result === "object") {
      assert.equal(result.outcome, "failed");
      assert.ok(result.validationErrors?.length, JSON.stringify(result));
      assert.deepEqual(result.steps, []);
    }
  }
  for (const args of [
    { page: 1, executor: 0, label: "x" },
    { page: 0, executor: 201, label: "x" },
    { page: 1, executor: 201 },
    { page: 1, executor: 201, label: "   " },
  ]) {
    const { isError } = await h.callJson("gma3_label_executor", args);
    assert.equal(isError, true, JSON.stringify(args));
  }
  assert.equal(h.fake.requests.length, 0, "nothing may reach the bridge");
});

test("labels with characters the console strips from names are refused before anything is sent", async () => {
  for (const label of ['Say "hi"', "v1.2", "A & B", "what?", "a;b", "{x}", "back\\slash", "tilde~"]) {
    const a = await h.callJson("gma3_assign_to_executor", { sequence: 5, page: 1, executor: 201, label });
    assert.equal(a.isError, true, label);
    assert.equal(a.result.outcome, "failed");
    assert.ok(a.result.validationErrors.some((e: string) => /removes from names/.test(e)), JSON.stringify(a.result.validationErrors));
    const l = await h.callJson("gma3_label_executor", { page: 1, executor: 201, label });
    assert.equal(l.isError, true, label);
    assert.ok(l.result.validationErrors.some((e: string) => /removes from names/.test(e)));
  }
  assert.equal(h.fake.requests.length, 0, "nothing may reach the bridge");
});

// ---------------------------------------------------------------------------
// gma3_assign_to_executor
// ---------------------------------------------------------------------------

test("empty executor: inspects, assigns, reads back and matches", async () => {
  const { result, isError } = await h.callJson("gma3_assign_to_executor", { sequence: 5, page: 1, executor: 201 });
  assert.equal(isError, false, result.summary);
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.verification.status, "matched");
  assert.deepEqual(h.fake.commands, ["Assign Sequence 5 At Page 1.201"]);
  assert.deepEqual(result.previous, { empty: true });
  assert.equal(result.resulting.object.name, "Look");
  assert.equal(result.resulting.object.class, "Sequence");
  assert.equal(result.resulting.name, "Look");
  assert.equal(result.alreadyAssigned, false);
  assert.deepEqual(
    result.steps.map((s: any) => [s.name, s.status]),
    [
      ["check_sequence", "succeeded"],
      ["check_page", "succeeded"],
      ["inspect_executor", "succeeded"],
      ["assign", "succeeded"],
      ["read_back", "succeeded"],
    ],
  );
  for (const name of ["check_sequence", "check_page", "inspect_executor", "read_back"]) assert.equal(stepNamed(result, name).kind, "read", name);
  assert.notEqual(stepNamed(result, "assign").kind, "read");
  // Inspection happens before the command is sent.
  const ops = h.fake.requests.map((r) => r.op);
  assert.deepEqual(ops, ["objects", "objects", "objects", "cmd", "objects"]);
  assertNoPlayback(h);
});

test("assign with label: labels after assigning, renames the sequence, verifies executor and sequence", async () => {
  const { result, isError } = await h.callJson("gma3_assign_to_executor", { sequence: 5, page: 1, executor: 201, label: "Front Look" });
  assert.equal(isError, false, result.summary);
  assert.equal(result.outcome, "succeeded");
  assert.deepEqual(h.fake.commands, ["Assign Sequence 5 At Page 1.201", 'Label Page 1.201 "Front Look"']);
  assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
  assert.equal(result.resulting.name, "Front Look");
  assert.equal(result.resulting.object.name, "Front Look");
  assert.equal(result.sequenceName, "Look");
  assert.equal(result.sequenceNameAfter, "Front Look");
  assert.equal(stepNamed(result, "read_back_object").status, "succeeded");
  assert.equal(stepNamed(result, "read_back_object").kind, "read");
  assert.ok(result.warnings.some((w: string) => /renames Sequence 5/.test(w)));
  const refs = h.fake.requests.filter((r) => r.op === "objects").map((r) => r.args.ref);
  assert.deepEqual(refs, ["Sequence 5", "Page 1", "Page 1.201", "Page 1.201", "Sequence 5"]);
  assertNoPlayback(h);
});

test("occupied executor without replace: failed, nothing sent, previous assignment reported", async () => {
  world.exec(1, 201, 7);
  const { result, isError } = await h.callJson("gma3_assign_to_executor", { sequence: 5, page: 1, executor: 201, label: "New" });
  assert.equal(isError, true);
  assert.equal(result.outcome, "failed");
  assert.deepEqual(h.fake.commands, []);
  assert.equal(h.fake.requests.filter((r) => r.op !== "objects").length, 0);
  assert.equal(result.previous.object.name, "Other");
  assert.equal(result.previous.object.class, "Sequence");
  assert.equal(result.previous.empty, false);
  assert.match(stepNamed(result, "assign").error, /replace: true/);
  assert.equal(stepNamed(result, "assign").status, "failed");
  assert.equal(stepNamed(result, "label").status, "skipped");
  assert.equal(stepNamed(result, "read_back").status, "skipped");
  assert.equal(stepNamed(result, "read_back_object").status, "skipped");
  assert.match(result.summary, /nothing was sent/i);
  assertNoPlayback(h);
});

test("occupied executor with replace: assigned, previous and resulting reported", async () => {
  world.exec(1, 201, 7);
  const { result, isError } = await h.callJson("gma3_assign_to_executor", { sequence: 5, page: 1, executor: 201, replace: true });
  assert.equal(isError, false, result.summary);
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.verification.status, "matched");
  assert.deepEqual(h.fake.commands, ["Assign Sequence 5 At Page 1.201"]);
  assert.equal(result.previous.object.name, "Other");
  assert.equal(result.resulting.object.name, "Look");
  assert.equal(result.replaced, true);
  assert.ok(result.warnings.some((w: string) => /replaced/.test(w)));
  assertNoPlayback(h);
});

test("executor already holding the sequence: no command sent, alreadyAssigned reported", async () => {
  world.exec(1, 201, 5);
  const { result, isError } = await h.callJson("gma3_assign_to_executor", { sequence: 5, page: 1, executor: 201 });
  assert.equal(isError, false, result.summary);
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.alreadyAssigned, true);
  assert.equal(result.command, null);
  assert.deepEqual(h.fake.commands, []);
  assert.equal(result.verification.status, "matched");
  assert.match(result.summary, /already assigned/);
});

test("already assigned with a label: only the label command is sent", async () => {
  world.exec(1, 201, 5);
  const { result, isError } = await h.callJson("gma3_assign_to_executor", { sequence: 5, page: 1, executor: 201, label: "Front Look" });
  assert.equal(isError, false, result.summary);
  assert.deepEqual(h.fake.commands, ['Label Page 1.201 "Front Look"']);
  assert.equal(result.alreadyAssigned, true);
  assert.equal(result.resulting.name, "Front Look");
  assert.equal(result.sequenceNameAfter, "Front Look");
  assert.equal(result.verification.status, "matched");
});

test("a sequence with the same name as the assigned one is not mistaken for it (identity by address)", async () => {
  world.seq(9, "Look"); // same name as sequence 5
  world.exec(1, 201, 9);
  const { result, isError } = await h.callJson("gma3_assign_to_executor", { sequence: 5, page: 1, executor: 201 });
  assert.equal(isError, true);
  assert.equal(result.outcome, "failed");
  assert.deepEqual(h.fake.commands, []);
  assert.equal(result.previous.object.index, 9);
});

test("missing sequence: failed before any command, only one bridge request", async () => {
  const { result, isError } = await h.callJson("gma3_assign_to_executor", { sequence: 42, page: 1, executor: 201, label: "x" });
  assert.equal(isError, true);
  assert.equal(result.outcome, "failed");
  assert.equal(h.fake.requests.length, 1);
  assert.equal(h.fake.requests[0].op, "objects");
  assert.equal(h.fake.requests[0].args.ref, "Sequence 42");
  assert.equal(stepNamed(result, "check_sequence").status, "failed");
  assert.match(stepNamed(result, "check_sequence").error, /Sequence 42 does not exist/);
  for (const name of ["check_page", "inspect_executor", "assign", "label", "read_back", "read_back_object"]) assert.equal(stepNamed(result, name).status, "skipped", name);
  assert.equal(result.verification.status, "unavailable");
});

test("missing page: failed before any command with a hint to create it", async () => {
  const { result, isError } = await h.callJson("gma3_assign_to_executor", { sequence: 5, page: 90, executor: 201 });
  assert.equal(isError, true);
  assert.equal(result.outcome, "failed");
  assert.deepEqual(h.fake.commands, []);
  assert.match(stepNamed(result, "check_page").error, /Page 90 does not exist.*Store Page 90/);
  assert.equal(stepNamed(result, "assign").status, "skipped");
});

test("non-current page: every reference and the command use Page <p>.<e>", async () => {
  world.exec(2, 305, 7);
  const { result, isError } = await h.callJson("gma3_assign_to_executor", { sequence: 5, page: 2, executor: 305, replace: true, label: "Knob" });
  assert.equal(isError, false, result.summary);
  assert.deepEqual(h.fake.commands, ["Assign Sequence 5 At Page 2.305", 'Label Page 2.305 "Knob"']);
  const refs = h.fake.requests.filter((r) => r.op === "objects").map((r) => r.args.ref);
  assert.deepEqual(refs, ["Sequence 5", "Page 2", "Page 2.305", "Page 2.305", "Sequence 5"]);
  assert.equal(result.target.executorRef, "Page 2.305");
  assert.equal(result.previous.object.name, "Other");
  assert.equal(result.resulting.name, "Knob");
  assert.equal(result.verification.status, "matched");
  // Nothing addressed the current page implicitly.
  for (const c of h.fake.commands) assert.match(c, /Page 2\.305/);
  assertNoPlayback(h);
});

test("partial: assign succeeds, label is rejected; read-back shows the assignment under its old name", async () => {
  world.labelFeedback = "Syntax Error";
  const { result, isError } = await h.callJson("gma3_assign_to_executor", { sequence: 5, page: 1, executor: 201, label: "Front" });
  assert.equal(isError, true);
  assert.equal(result.outcome, "partial");
  assert.deepEqual(h.fake.commands, ["Assign Sequence 5 At Page 1.201", 'Label Page 1.201 "Front"']);
  assert.equal(stepNamed(result, "assign").status, "succeeded");
  assert.equal(stepNamed(result, "label").status, "failed");
  assert.equal(stepNamed(result, "read_back").status, "succeeded");
  assert.equal(stepNamed(result, "read_back_object").status, "succeeded");
  // The label step was attempted, so the expected name is the label: mismatch tells the client the rename did not happen.
  assert.equal(result.verification.status, "mismatched");
  assert.match(result.verification.detail, /name: expected "Front"/);
  assert.equal(result.verification.actual.object, "Look");
  assert.equal(result.resulting.object.name, "Look");
  assert.equal(result.sequenceNameAfter, "Look");
  assert.match(result.summary, /partially completed/);
});

test("uncertain: no reply to the Assign command gives outcome unknown and the command is not resent", async () => {
  world.assignFeedback = SILENT;
  const { result, isError } = await h.callJson("gma3_assign_to_executor", { sequence: 5, page: 1, executor: 201, label: "x" });
  assert.equal(isError, true);
  assert.equal(result.outcome, "unknown");
  assert.deepEqual(h.fake.commands, ["Assign Sequence 5 At Page 1.201"], "exactly one attempt");
  assert.equal(stepNamed(result, "assign").status, "unknown");
  assert.match(stepNamed(result, "assign").error, /not retried/);
  assert.equal(stepNamed(result, "label").status, "skipped");
  // The read-back still runs so the client can see the resulting state; the fake never applied the command.
  assert.equal(stepNamed(result, "read_back").status, "succeeded");
  assert.equal(stepNamed(result, "read_back_object").status, "skipped", "the label never ran, so the sequence is not re-read");
  assert.equal(result.verification.status, "mismatched");
  assert.match(result.summary, /outcome unknown/);
});

test("unfamiliar console feedback is not treated as success", async () => {
  world.assignFeedback = "Something new";
  const { result } = await h.callJson("gma3_assign_to_executor", { sequence: 5, page: 1, executor: 201 });
  assert.equal(result.outcome, "unknown");
  assert.equal(stepNamed(result, "assign").status, "unknown");
  assert.deepEqual(h.fake.commands, ["Assign Sequence 5 At Page 1.201"]);
});

test("verify: false skips the read-back", async () => {
  const { result, isError } = await h.callJson("gma3_assign_to_executor", { sequence: 5, page: 1, executor: 201, verify: false });
  assert.equal(isError, false);
  assert.equal(result.verification.status, "not_requested");
  assert.equal(stepNamed(result, "read_back"), undefined);
  assert.equal(result.resulting, null);
  assert.deepEqual(h.fake.requests.map((r) => r.op), ["objects", "objects", "objects", "cmd"]);
});

test("a lost read-back after the assignment keeps the outcome succeeded with verification unavailable, nothing resent", async () => {
  world.silentReadsAfterCommand = true;
  const { result, isError } = await h.callJson("gma3_assign_to_executor", { sequence: 5, page: 1, executor: 201 });
  assert.equal(isError, false, "an unavailable read-back is not an execution failure");
  assert.equal(result.outcome, "succeeded");
  assert.equal(stepNamed(result, "assign").status, "succeeded");
  assert.equal(stepNamed(result, "read_back").status, "unknown");
  assert.equal(stepNamed(result, "read_back").kind, "read");
  assert.equal(result.verification.status, "unavailable");
  assert.deepEqual(h.fake.commands, ["Assign Sequence 5 At Page 1.201"]);
  assert.equal(h.fake.requests.filter((r) => r.op === "objects").length, 4, "one read-back attempt only");
});

// ---------------------------------------------------------------------------
// gma3_label_executor
// ---------------------------------------------------------------------------

test("label: sends Label Page <p>.<e> and verifies the executor view and the sequence's own Name", async () => {
  world.exec(2, 201, 5);
  const { result, isError } = await h.callJson("gma3_label_executor", { page: 2, executor: 201, label: "Front Look" });
  assert.equal(isError, false, result.summary);
  assert.equal(result.outcome, "succeeded");
  assert.deepEqual(h.fake.commands, ['Label Page 2.201 "Front Look"']);
  assert.equal(result.previous.name, "Look");
  assert.equal(result.previous.object.name, "Look");
  assert.equal(result.resulting.name, "Front Look");
  assert.equal(result.resulting.object.name, "Front Look");
  assert.equal(result.assignedObjectRef, "Sequence 5");
  assert.equal(result.assignedObjectName, "Front Look");
  assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
  assert.ok(result.warnings.some((w: string) => /renames its assigned object/.test(w)));
  assert.deepEqual(
    h.fake.requests.map((r) => [r.op, r.args.ref]),
    [
      ["objects", "Page 2"],
      ["objects", "Page 2.201"],
      ["cmd", undefined],
      ["objects", "Page 2.201"],
      ["objects", "Sequence 5"],
    ],
  );
  assertNoPlayback(h);
});

test("label: the label is trimmed before it is sent", async () => {
  world.exec(1, 201, 5);
  const { result, isError } = await h.callJson("gma3_label_executor", { page: 1, executor: 201, label: "  Padded  " });
  assert.equal(isError, false, result.summary);
  assert.deepEqual(h.fake.commands, ['Label Page 1.201 "Padded"']);
  assert.equal(result.verification.status, "matched");
});

test("label: empty executor fails before anything is sent", async () => {
  const { result, isError } = await h.callJson("gma3_label_executor", { page: 1, executor: 215, label: "x" });
  assert.equal(isError, true);
  assert.equal(result.outcome, "failed");
  assert.deepEqual(h.fake.commands, []);
  assert.equal(h.fake.requests.filter((r) => r.op !== "objects").length, 0);
  assert.match(stepNamed(result, "inspect_executor").error, /empty/);
  assert.equal(stepNamed(result, "label").status, "skipped");
  assert.equal(stepNamed(result, "read_back_object").status, "skipped");
});

test("label: executor that exists but holds no object is treated as empty", async () => {
  world.exec(1, 201, null);
  const { result, isError } = await h.callJson("gma3_label_executor", { page: 1, executor: 201, label: "x" });
  assert.equal(isError, true);
  assert.equal(result.outcome, "failed");
  assert.deepEqual(h.fake.commands, []);
  assert.equal(result.previous.empty, true);
});

test("label: missing page fails before anything is sent", async () => {
  const { result, isError } = await h.callJson("gma3_label_executor", { page: 77, executor: 201, label: "x" });
  assert.equal(isError, true);
  assert.equal(result.outcome, "failed");
  assert.equal(h.fake.requests.length, 1);
  assert.equal(stepNamed(result, "check_page").status, "failed");
});

test("label: rejected command is a failure with the console feedback", async () => {
  world.exec(1, 201, 5);
  world.labelFeedback = "Illegal Command";
  const { result, isError } = await h.callJson("gma3_label_executor", { page: 1, executor: 201, label: "x" });
  assert.equal(isError, true);
  assert.equal(result.outcome, "failed");
  assert.equal(stepNamed(result, "label").feedback, "Illegal Command");
  assert.equal(result.verification.status, "mismatched");
  assert.equal(result.resulting.name, "Look");
});

test("label: lost reply gives outcome unknown without a resend", async () => {
  world.exec(1, 201, 5);
  world.labelFeedback = SILENT;
  const { result, isError } = await h.callJson("gma3_label_executor", { page: 1, executor: 201, label: "x" });
  assert.equal(isError, true);
  assert.equal(result.outcome, "unknown");
  assert.deepEqual(h.fake.commands, ['Label Page 1.201 "x"']);
});

test("label: verify false sends only the inspection and the command", async () => {
  world.exec(1, 201, 5);
  const { result, isError } = await h.callJson("gma3_label_executor", { page: 1, executor: 201, label: "x", verify: false });
  assert.equal(isError, false);
  assert.equal(result.verification.status, "not_requested");
  assert.deepEqual(h.fake.requests.map((r) => r.op), ["objects", "objects", "cmd"]);
});

test("tool descriptions state selection, programmer, verification and the rename effect", () => {
  for (const name of ["gma3_assign_to_executor", "gma3_label_executor"]) {
    const d = h.tools.get(name)?.description ?? "";
    assert.match(d, /selection/);
    assert.match(d, /programmer/);
    assert.match(d, /verif/i);
    assert.match(d, /serialised/);
    assert.match(d, /RENAMES THE/);
  }
});
