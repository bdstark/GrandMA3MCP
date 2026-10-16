import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_BATCH_ITEMS, batchItems, compactResult, runBatch, runBatchCall, summarizeBatch } from "../src/batch.ts";
import { BridgeError } from "../src/bridge.ts";
import type { OperationResult, VerificationOutcome } from "../src/results.ts";

const result = (outcome: OperationResult["outcome"], verification: VerificationOutcome = "matched", extra: Partial<OperationResult> = {}): OperationResult => ({
  operation: "op",
  target: {},
  outcome,
  verification: { status: verification, ...(verification === "mismatched" ? { detail: "Name: expected A, read B" } : {}) },
  steps: [{ name: "store", status: outcome === "succeeded" ? "succeeded" : outcome === "unknown" ? "unknown" : "failed", detail: { big: "x".repeat(50) } }],
  summary: `op ${outcome}`,
  ...extra,
});

test("batchItems: the list is split, other arguments are defaults, an item's own field wins", () => {
  const r = batchItems({ macros: [{ macro: 1 }, { macro: 2, mode: "append" }], mode: "create", verify: false, detail: true, stop_on_failure: true }, "macros", ["macro"]);
  assert.ok("items" in r);
  assert.deepEqual(r.items, [{ macro: 1, mode: "create", verify: false }, { macro: 2, mode: "append", verify: false }]);
});

test("batchItems: an empty, oversized or misused list is refused", () => {
  assert.deepEqual(batchItems({ macros: [] }, "macros", ["macro"]), { errors: ["macros must be a non-empty list"] });
  const big = batchItems({ macros: Array.from({ length: MAX_BATCH_ITEMS + 1 }, (_, i) => ({ macro: i + 1 })) }, "macros", ["macro"]);
  assert.ok("errors" in big && /at most 100 items per call/.test(big.errors[0]));
  const top = batchItems({ macros: [{ macro: 1 }], macro: 5 }, "macros", ["macro"]);
  assert.ok("errors" in top && /give macro in each item/.test(top.errors[0]));
});

test("runBatch: every item succeeding and matching is a succeeded, matched batch with one line per item", async () => {
  const r = await runBatch("store_group", [
    { label: "Group 1", run: async () => result("succeeded") },
    { label: "Group 2", run: async () => result("succeeded") },
  ]);
  assert.equal(r.outcome, "succeeded");
  assert.equal(r.verification.status, "matched");
  assert.deepEqual((r.items as Array<{ target: string; outcome: string }>).map((i) => `${i.target}:${i.outcome}`), ["Group 1:succeeded", "Group 2:succeeded"]);
  assert.deepEqual(r.steps.map((s) => s.status), ["succeeded", "succeeded"]);
  assert.match(r.summary, /2 item\(s\): 2 succeeded \(2 read back matched\)/);
  assert.equal((r.items as Array<{ result?: unknown }>)[0].result, undefined, "compact by default");
});

test("runBatch: a failed item does not stop independent items; the batch is partial and names the item", async () => {
  const r = await runBatch("store_macro", [
    { label: "Macro 1", run: async () => result("succeeded") },
    { label: "Macro 2", run: async () => result("failed", "not_requested") },
    { label: "Macro 3", run: async () => result("succeeded") },
  ]);
  assert.equal(r.outcome, "partial");
  assert.equal(r.verification.status, "unavailable");
  assert.match(r.verification.detail!, /item 2 \(Macro 2\): not_requested/);
  assert.match(r.summary, /1 did not succeed\. First problem, item 2 \(Macro 2\): op failed/);
  assert.deepEqual(r.steps.map((s) => s.status), ["succeeded", "failed", "succeeded"]);
});

test("runBatch: nothing succeeding is failed; a mismatched read-back makes the batch mismatched", async () => {
  const none = await runBatch("op", [{ label: "a", run: async () => result("failed", "not_requested") }]);
  assert.equal(none.outcome, "failed");
  const mism = await runBatch("op", [
    { label: "a", run: async () => result("succeeded") },
    { label: "b", run: async () => result("succeeded", "mismatched") },
  ]);
  assert.equal(mism.outcome, "succeeded");
  assert.equal(mism.verification.status, "mismatched");
  assert.match(mism.verification.detail!, /item 2 \(b\): Name: expected A, read B/);
});

test("runBatch: an unknown outcome stops the rest, which are not attempted", async () => {
  let ran = 0;
  const r = await runBatch("op", [
    { label: "a", run: async () => (ran++, result("succeeded")) },
    { label: "b", run: async () => (ran++, result("unknown", "unavailable")) },
    { label: "c", run: async () => (ran++, result("succeeded")) },
  ]);
  assert.equal(ran, 2);
  assert.equal(r.outcome, "partial");
  const items = r.items as Array<{ outcome: string; summary: string }>;
  assert.equal(items[2].outcome, "not_attempted");
  assert.match(items[2].summary, /item 2 \(b\) has a step without a reply that may have changed the console/);
  assert.equal(r.steps[2].status, "skipped");
});

test("runBatch: later items on an object an earlier item failed on are skipped; stop_on_failure stops everything", async () => {
  const r = await runBatch("edit_macro_line", [
    { label: "Macro 1 line 2", key: "Macro 1", run: async () => result("failed", "not_requested") },
    { label: "Macro 2 line 1", key: "Macro 2", run: async () => result("succeeded") },
    { label: "Macro 1 line 3", key: "Macro 1", run: async () => result("succeeded") },
  ]);
  const items = r.items as Array<{ outcome: string; summary: string }>;
  assert.deepEqual(items.map((i) => i.outcome), ["failed", "succeeded", "not_attempted"]);
  assert.match(items[2].summary, /item 1 on Macro 1 did not succeed/);
  const stopped = await runBatch("op", [{ label: "a", run: async () => result("failed") }, { label: "b", run: async () => result("succeeded") }], { stopOnFailure: true });
  assert.equal((stopped.items as Array<{ outcome: string }>)[1].outcome, "not_attempted");
});

test("runBatch: a thrown error becomes that item's failed or unknown result, never a lost batch", async () => {
  const r = await runBatch("op", [
    { label: "a", run: async () => { throw new Error("boom"); } },
    { label: "b", run: async () => { throw new BridgeError("timeout", "cmd", true); } },
    { label: "c", run: async () => result("succeeded") },
  ]);
  const items = r.items as Array<{ outcome: string }>;
  assert.equal(items[0].outcome, "failed");
  assert.equal(items[1].outcome, "unknown");
  assert.equal(items[2].outcome, "not_attempted");
});

test("runBatch: detail returns each item's full result; item warnings carry the item number", async () => {
  const r = await runBatch("op", [{ label: "a", run: async () => result("succeeded", "matched", { warnings: ["shared cells kept"] }) }], { detail: true });
  assert.equal((r.items as Array<{ result?: OperationResult }>)[0].result?.steps.length, 1);
  assert.deepEqual(r.warnings, ["item 1: shared cells kept"]);
  assert.equal(r.detailHint, undefined);
});

test("summarizeBatch: not_requested everywhere stays not_requested", () => {
  const r = summarizeBatch("op", [{ label: "a", result: result("succeeded", "not_requested") }]);
  assert.equal(r.verification.status, "not_requested");
});

test("runBatchCall: cross-item checks refuse the call before any item runs", async () => {
  let ran = 0;
  const r = await runBatchCall({ groups: [{ group: 1 }, { group: 1 }] }, {
    operation: "store_group",
    listKey: "groups",
    identityKeys: ["group"],
    label: (it) => `Group ${String(it.group)}`,
    check: () => ["Group 1 appears more than once in groups"],
    run: async () => (ran++, result("succeeded")),
  });
  assert.equal(ran, 0);
  assert.equal(r.outcome, "failed");
  assert.deepEqual(r.validationErrors, ["Group 1 appears more than once in groups"]);
});

test("compactResult: only steps that did not succeed, a count by status, no read-back dumps; detail keeps all", () => {
  const full: OperationResult = {
    ...result("partial", "mismatched"),
    verification: { status: "mismatched", detail: "cue 3", actual: { observed: Array(500).fill({ cue: 1, ms: 0 }) } },
    steps: [
      { name: "a", status: "succeeded", detail: { rows: Array(1000).fill(1) } },
      { name: "b", status: "failed", error: "rejected", detail: { rows: [1] } },
      { name: "c", status: "skipped" },
    ],
    cues: [{ cue: "1", status: "stored" }],
  };
  const c = compactResult(full, false);
  assert.deepEqual(c.steps, [{ name: "b", status: "failed", error: "rejected" }, { name: "c", status: "skipped" }]);
  assert.deepEqual(c.stepCounts, { succeeded: 1, failed: 1, skipped: 1 });
  assert.equal(c.verification.actual, undefined);
  assert.equal(c.verification.detail, "cue 3");
  assert.deepEqual(c.cues, full.cues);
  assert.ok(JSON.stringify(c).length < 1000);
  assert.equal(compactResult(full, true), full);
});
