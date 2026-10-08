import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyFeedback,
  commandStep,
  runSteps,
  outcomeOf,
  compareFields,
  valuesEqual,
  buildResult,
  toToolResult,
  validationFailure,
  isErrorResult,
  stepFromError,
  type StepResult,
} from "../src/results.ts";
import { Gma3Bridge, BridgeError, BridgeUnreachableError } from "../src/bridge.ts";
import { FakeBridge, SILENT } from "./helpers/fake-bridge.ts";

/**
 * FR-02: the shared result model. Negative console feedback is a failure, unfamiliar feedback is
 * unknown (never success), dispatched transport errors are unknown and never retried, and a
 * multi-step operation stops at the first non-success and reports the rest as skipped.
 */

test("feedback classification: OK is success, known refusals fail, anything else is unknown", () => {
  assert.equal(classifyFeedback("OK"), "ok");
  assert.equal(classifyFeedback("Ok"), "ok");
  assert.equal(classifyFeedback("Syntax Error"), "error");
  assert.equal(classifyFeedback("Illegal Command"), "error");
  assert.equal(classifyFeedback("Illegal Object"), "error");
  assert.equal(classifyFeedback("Sequence 99 does not exist"), "error");
  assert.equal(classifyFeedback("Store failed: nothing selected"), "error");
  assert.equal(classifyFeedback("Executor 201 is read-only"), "error");
  assert.equal(classifyFeedback("Something completely new"), "unknown");
  assert.equal(classifyFeedback(""), "unknown");
  assert.equal(classifyFeedback(null), "unknown");
  assert.equal(classifyFeedback(undefined), "unknown");
  assert.equal(classifyFeedback(true), "ok");
  assert.equal(classifyFeedback(false), "error");
});

test("commandStep maps console feedback and transport errors onto step statuses", async () => {
  const fake = new FakeBridge();
  const port = await fake.listen();
  const bridge = new Gma3Bridge({ host: "127.0.0.1", port, requestTimeoutMs: 200 });
  fake.onCommand((c) => (c.startsWith("Good") ? "OK" : c.startsWith("Bad") ? "Illegal Command" : c.startsWith("Odd") ? "Hmm" : SILENT));
  try {
    const good = await commandStep(bridge, "s", "Good 1");
    assert.equal(good.status, "succeeded");
    assert.equal(good.feedback, "OK");
    assert.equal(good.command, "Good 1");
    const bad = await commandStep(bridge, "s", "Bad 1");
    assert.equal(bad.status, "failed");
    assert.match(bad.error ?? "", /rejected/);
    const odd = await commandStep(bridge, "s", "Odd 1");
    assert.equal(odd.status, "unknown");
    assert.match(odd.error ?? "", /unrecognised console feedback: Hmm/);
    const lost = await commandStep(bridge, "s", "Silent 1");
    assert.equal(lost.status, "unknown");
    assert.match(lost.error ?? "", /may have executed/);
    assert.match(lost.error ?? "", /not retried/);
    assert.equal(fake.commands.filter((c) => c === "Silent 1").length, 1, "a lost reply is never resent");
  } finally {
    bridge.close();
    await fake.close();
  }
});

test("commandStep with the bridge unreachable is a failure, not unknown", async () => {
  const fake = new FakeBridge();
  const port = await fake.listen();
  await fake.close();
  const bridge = new Gma3Bridge({ host: "127.0.0.1", port, requestTimeoutMs: 200 });
  const step = await commandStep(bridge, "s", "Go+ Sequence 1");
  assert.equal(step.status, "failed");
  assert.match(step.error ?? "", /nothing was sent/);
});

test("stepFromError distinguishes dispatched from non-dispatched bridge errors", () => {
  assert.equal(stepFromError("x", new BridgeError("timeout", "cmd", true)).status, "unknown");
  assert.equal(stepFromError("x", new BridgeError("Set failed: bad property", "set", false)).status, "failed");
  assert.equal(stepFromError("x", new BridgeUnreachableError("refused")).status, "failed");
  assert.equal(stepFromError("x", new Error("boom")).status, "failed");
});

test("runSteps stops at the first non-success and marks the rest skipped", async () => {
  const calls: string[] = [];
  const mk = (name: string, status: StepResult["status"]) => ({
    name,
    run: async () => {
      calls.push(name);
      return { name, status } as StepResult;
    },
  });
  const r = await runSteps([mk("a", "succeeded"), mk("b", "failed"), mk("c", "succeeded")]);
  assert.deepEqual(calls, ["a", "b"]);
  assert.equal(r.outcome, "partial");
  assert.deepEqual(
    r.steps.map((s) => [s.name, s.status]),
    [
      ["a", "succeeded"],
      ["b", "failed"],
      ["c", "skipped"],
    ],
  );
  assert.match(r.steps[2].error ?? "", /earlier step was failed/);
});

test("outcome aggregation: failed, unknown, partial, succeeded", () => {
  const s = (status: StepResult["status"]): StepResult => ({ name: "s", status });
  assert.equal(outcomeOf([s("succeeded"), s("succeeded")]), "succeeded");
  assert.equal(outcomeOf([s("failed"), s("skipped")]), "failed");
  assert.equal(outcomeOf([s("unknown"), s("skipped")]), "unknown");
  assert.equal(outcomeOf([s("succeeded"), s("unknown")]), "partial");
  assert.equal(outcomeOf([s("succeeded"), s("failed")]), "partial");
  assert.equal(outcomeOf([]), "failed");
});

test("read-only steps never count as completed work", () => {
  const read = (status: StepResult["status"]): StepResult => ({ name: "check", status, kind: "read" });
  const mut = (status: StepResult["status"]): StepResult => ({ name: "store", status });
  assert.equal(outcomeOf([read("succeeded"), mut("failed")]), "failed", "a pre-check followed by a rejected command is not partial");
  assert.equal(outcomeOf([read("succeeded"), mut("unknown")]), "unknown");
  assert.equal(outcomeOf([read("unknown"), mut("skipped")]), "failed", "a read that got no reply changed nothing");
  assert.equal(outcomeOf([read("failed"), mut("skipped")]), "failed");
  assert.equal(outcomeOf([read("succeeded"), mut("succeeded"), mut("failed")]), "partial");
  assert.equal(outcomeOf([read("succeeded"), mut("succeeded")]), "succeeded");
  assert.equal(outcomeOf([mut("succeeded"), read("failed")]), "partial", "a failed read after a mutation still leaves the mutation done");
});

test("runSteps turns a thrown error inside a step into a failed step", async () => {
  const r = await runSteps([
    {
      name: "boom",
      run: async () => {
        throw new BridgeError("timeout", "cmd", true);
      },
    },
    { name: "after", run: async () => ({ name: "after", status: "succeeded" }) },
  ]);
  assert.equal(r.outcome, "unknown");
  assert.equal(r.steps[0].status, "unknown");
  assert.equal(r.steps[1].status, "skipped");
});

test("compareFields: numeric display text matches numbers, mismatches are itemised", () => {
  const v = compareFields("cue", { Name: "Look 1", CueFade: 2.5, Tracking: true }, { Name: "look 1", CueFade: "2.50", Tracking: "Yes" });
  assert.equal(v.status, "matched");
  const m = compareFields("cue", { Name: "A", CueFade: 3 }, { Name: "B", CueFade: "3" });
  assert.equal(m.status, "mismatched");
  assert.match(m.detail ?? "", /Name: expected "A", read "B"/);
  assert.doesNotMatch(m.detail ?? "", /CueFade/);
  assert.equal(compareFields("cue", { Name: "A" }, null).status, "unavailable");
  assert.equal(compareFields("cue", { Name: undefined }, { Name: "whatever" }).status, "matched", "undefined expectations are not checked");
});

test("valuesEqual: zero is a value, missing is not", () => {
  assert.equal(valuesEqual(0, "0"), true);
  assert.equal(valuesEqual(0, "0.00"), true);
  assert.equal(valuesEqual(0, null), false);
  assert.equal(valuesEqual(0, ""), false);
  assert.equal(valuesEqual(3, "3s"), true);
  assert.equal(valuesEqual("Follow", "follow"), true);
  assert.equal(valuesEqual("2.5", "2.50"), true);
  assert.equal(valuesEqual("abc", "abd"), false);
});

test("buildResult / toToolResult: only a verified success is a non-error tool result", () => {
  const ok = buildResult({ operation: "store_cue", target: { sequence: 1, cue: "2" }, steps: [{ name: "store", status: "succeeded" }], verification: { status: "matched" } });
  assert.equal(ok.outcome, "succeeded");
  assert.equal(isErrorResult(ok), false);
  assert.equal(toToolResult(ok).isError, undefined);
  assert.match(ok.summary, /store_cue succeeded/);

  const mismatch = buildResult({ operation: "store_cue", target: {}, steps: [{ name: "store", status: "succeeded" }], verification: { status: "mismatched", detail: "Name differs" } });
  assert.equal(toToolResult(mismatch).isError, true);
  assert.match(mismatch.summary, /MISMATCHED/);

  const partial = buildResult({ operation: "assign", target: {}, steps: [{ name: "assign", status: "succeeded" }, { name: "label", status: "failed", error: "nope" }] });
  assert.equal(partial.outcome, "partial");
  const rendered = toToolResult(partial);
  assert.equal(rendered.isError, true);
  const body = JSON.parse(rendered.content[0].text);
  assert.equal(body.outcome, "partial");
  assert.equal(body.steps.length, 2, "details are retained in the error result");
  assert.equal(body.verification.status, "not_requested");

  const unknown = buildResult({ operation: "goto", target: {}, steps: [{ name: "goto", status: "unknown", error: "timeout" }] });
  assert.equal(unknown.outcome, "unknown");
  assert.equal(toToolResult(unknown).isError, true);
});

test("validationFailure reports every problem and no steps", () => {
  const r = validationFailure("store_cue", { sequence: 1 }, ["cue is required", "fade must be >= 0"]);
  assert.equal(r.outcome, "failed");
  assert.deepEqual(r.steps, []);
  assert.deepEqual(r.validationErrors, ["cue is required", "fade must be >= 0"]);
  assert.equal(toToolResult(r).isError, true);
});
