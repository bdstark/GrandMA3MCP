/**
 * Batch forms of the structured tools (SU-12).
 *
 * A batch is a list of items, each run through the tool's single form, so every item gets that form's checks
 * before anything is sent and its own read-back. The rules:
 *   - Items run in order. An item that fails does not stop the others, except an item on the same object
 *     (its `key`): once an item on that object did not succeed, the later ones on it are not attempted, because
 *     they were planned against a state that did not happen. `stop_on_failure: true` stops at the first item that
 *     did not succeed.
 *   - An item with an uncertain step stops the batch: a mutation request that reached the bridge without an answer
 *     (status unknown), whether the item's outcome is `unknown` or `partial` (an earlier step of it succeeded). The
 *     console's state is not known, so nothing more is sent. Nothing is retried.
 *   - The whole batch runs in one span of this server's mutation lock: no other mutation from this server runs
 *     between two items (each item's single form runs with a held view of the lock).
 *   - The result is per item: `items` has one line each (outcome, verification, summary). `detail: true` adds each
 *     item's full result with its steps. The batch outcome is `succeeded` only when every item succeeded,
 *     `partial` when some work was done, and the verification is `matched` only when every item matched.
 */
import { z } from "zod";
import { HeldLock } from "./mutations.js";
import type { ToolContext } from "./tools/context.js";
import type { ExecutionOutcome, OperationResult, StepResult, StepStatus, Verification, VerificationOutcome } from "./results.js";
import { stepFromError, validationFailure } from "./results.js";

/** The batch options every batch form takes. */
export const batchOptionShape = {
  stop_on_failure: z.boolean().optional().describe("Batch form: stop at the first item that does not succeed (default false: independent items go on; an item on an object an earlier item failed on is skipped either way)."),
  detail: z.boolean().optional().describe("Return every item's full result with its steps (default false: one line per item)."),
};

/** The sentence every batch-form description ends with. */
export const BATCH_NOTE =
  "Batch form: give the list instead of the single object's fields; the other arguments are defaults for every item (an item's own fields win). Each item gets the single form's checks and read-back, and its own outcome; items run in order, nothing is retried, an unknown outcome stops the rest, and the result has one line per item (detail: true for every step).";

/** Items per call; a larger job is several calls. */
export const MAX_BATCH_ITEMS = 100;

/** Characters of one item's summary kept in a compact line. */
const LINE_SUMMARY_CHARS = 400;

export interface BatchItem {
  /** What the item acts on, for its line ("Group 5", "Page 1.201"). */
  label: string;
  /** The object the item changes; later items on the same object are skipped once one did not succeed. */
  key?: string;
  run: () => Promise<OperationResult>;
}

export interface BatchOptions {
  stopOnFailure?: boolean;
  detail?: boolean;
  /** Extra top-level fields for the result. */
  extra?: Record<string, unknown>;
  warnings?: string[];
}

export interface BatchEntry {
  label: string;
  result?: OperationResult;
  /** Why the item was not attempted. */
  skipped?: string;
}

export interface BatchLine {
  item: number;
  target: string;
  outcome: ExecutionOutcome | "not_attempted";
  verification: VerificationOutcome | "not_attempted";
  summary: string;
  result?: OperationResult;
}

/** An item succeeded and its read-back did not contradict it. */
export const itemOk = (r: OperationResult): boolean => r.outcome === "succeeded" && r.verification.status !== "mismatched";

/**
 * A result whose console effect is not known: its outcome is unknown, or one of its mutation steps got no reply (a
 * partial result can hold one after earlier steps succeeded). Read steps change nothing and do not count.
 */
export const hasUncertainStep = (r: OperationResult): boolean => r.outcome === "unknown" || r.steps.some((s) => s.status === "unknown" && s.kind !== "read");

/**
 * Split a batch call into its items: `args[listKey]` is the list, and every other argument except the batch
 * options is a default for each item (an item's own fields win). Identity fields (the object an item acts on)
 * must be given per item. Returns the merged items, or the reasons the call is refused.
 */
export function batchItems(args: Record<string, unknown>, listKey: string, identityKeys: string[]): { items: Array<Record<string, unknown>> } | { errors: string[] } {
  const list = args[listKey];
  const errors: string[] = [];
  if (!Array.isArray(list) || list.length === 0) errors.push(`${listKey} must be a non-empty list`);
  else if (list.length > MAX_BATCH_ITEMS) errors.push(`${listKey}: at most ${MAX_BATCH_ITEMS} items per call (got ${list.length}); split the job into several calls`);
  const atTop = identityKeys.filter((k) => args[k] !== undefined);
  if (atTop.length) errors.push(`with ${listKey}, give ${atTop.join(", ")} in each item, not for the whole call`);
  if (errors.length) return { errors };
  const defaults = Object.fromEntries(Object.entries(args).filter(([k]) => k !== listKey && k !== "detail" && k !== "stop_on_failure"));
  return {
    items: (list as unknown[]).map((raw) => ({ ...defaults, ...(raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}) })),
  };
}

/** A refused batch call: nothing was sent. */
export function batchRefused(operation: string, listKey: string, errors: string[]): OperationResult {
  return validationFailure(operation, { [listKey]: "refused" }, errors);
}

export interface BatchCall {
  /** The tool's context: the batch takes its mutation lock once, and each item runs with a held view of it. */
  ctx: ToolContext;
  operation: string;
  listKey: string;
  identityKeys: string[];
  label: (item: Record<string, unknown>, index: number) => string;
  key?: (item: Record<string, unknown>) => string | undefined;
  /** One item through the single form, with the context to use (its lock is the batch's held span). */
  run: (item: Record<string, unknown>, ctx: ToolContext) => Promise<OperationResult>;
  /** Checks across items (duplicates); any reason refuses the whole call before anything is sent. */
  check?: (items: Array<Record<string, unknown>>) => string[];
}

/** A tool's batch form: split, check across items, then run each item through the single form. */
export async function runBatchCall(args: Record<string, unknown>, c: BatchCall): Promise<OperationResult> {
  const split = batchItems(args, c.listKey, c.identityKeys);
  if ("errors" in split) return batchRefused(c.operation, c.listKey, split.errors);
  const errors = c.check?.(split.items) ?? [];
  if (errors.length) return batchRefused(c.operation, c.listKey, errors);
  const held: ToolContext = { ...c.ctx, mutations: new HeldLock() };
  return c.ctx.mutations.run(() =>
    runBatch(
      c.operation,
      split.items.map((item, i) => ({ label: c.label(item, i), key: c.key?.(item), run: () => c.run(item, held) })),
      { stopOnFailure: args.stop_on_failure === true, detail: args.detail === true },
    ),
  );
}

/** Names of values that appear more than once, for duplicate checks across items. */
export function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const v of values) (seen.has(v) ? dup : seen).add(v);
  return [...dup];
}

/** Run the items in order under the rules above and summarise them. */
export async function runBatch(operation: string, items: BatchItem[], o: BatchOptions = {}): Promise<OperationResult> {
  const entries: BatchEntry[] = [];
  const failedKeys = new Map<string, number>();
  let halted: string | null = null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (halted) {
      entries.push({ label: item.label, skipped: halted });
      continue;
    }
    if (item.key !== undefined && failedKeys.has(item.key)) {
      entries.push({ label: item.label, skipped: `not attempted: item ${failedKeys.get(item.key)} on ${item.key} did not succeed` });
      continue;
    }
    let result: OperationResult;
    try {
      result = await item.run();
    } catch (err) {
      const step: StepResult = stepFromError("item", err);
      result = { operation, target: { item: item.label }, outcome: step.status === "unknown" ? "unknown" : "failed", verification: { status: "not_requested" }, steps: [step], summary: `${item.label}: ${step.error ?? "failed"}` };
    }
    entries.push({ label: item.label, result });
    if (hasUncertainStep(result)) halted = `not attempted: item ${i + 1} (${item.label}) has a step without a reply that may have changed the console, so its state is not known`;
    else if (!itemOk(result)) {
      if (item.key !== undefined) failedKeys.set(item.key, i + 1);
      if (o.stopOnFailure) halted = `not attempted: item ${i + 1} (${item.label}) did not succeed and stop_on_failure is set`;
    }
  }
  return summarizeBatch(operation, entries, o);
}

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function stepStatusOf(e: BatchEntry): StepStatus {
  if (!e.result) return "skipped";
  if (hasUncertainStep(e.result)) return "unknown";
  switch (e.result.outcome) {
    case "succeeded":
      return "succeeded";
    case "unknown":
      return "unknown";
    default:
      return "failed";
  }
}

/** The batch result: outcome and verification over all items, one line and one step per item. */
export function summarizeBatch(operation: string, entries: BatchEntry[], o: BatchOptions = {}): OperationResult {
  const results = entries.flatMap((e) => (e.result ? [e.result] : []));
  const skipped = entries.filter((e) => !e.result).length;
  const count = (f: (r: OperationResult) => boolean) => results.filter(f).length;
  const succeeded = count((r) => r.outcome === "succeeded");
  const worked = count((r) => r.outcome === "succeeded" || r.outcome === "partial");
  let outcome: ExecutionOutcome;
  if (results.length === 0) outcome = "failed";
  else if (succeeded === entries.length) outcome = "succeeded";
  else if (worked > 0) outcome = "partial";
  else outcome = results.some((r) => r.outcome === "unknown") ? "unknown" : "failed";

  const label = (i: number) => `item ${i + 1} (${entries[i].label})`;
  const mismatched: string[] = [];
  const unverified: string[] = [];
  entries.forEach((e, i) => {
    const v = e.result?.verification;
    if (!v) unverified.push(`${label(i)}: ${e.skipped}`);
    else if (v.status === "mismatched") mismatched.push(`${label(i)}: ${v.detail ?? "mismatched"}`);
    else if (v.status !== "matched") unverified.push(`${label(i)}: ${v.status}${v.detail ? ` (${v.detail})` : ""}`);
  });
  const checked = "each item's own read-back";
  let verification: Verification;
  if (mismatched.length) verification = { status: "mismatched", checked, detail: mismatched.join("; ") };
  else if (results.length && results.every((r) => r.verification.status === "not_requested") && skipped === 0) verification = { status: "not_requested" };
  else if (unverified.length) verification = { status: "unavailable", checked, detail: unverified.join("; ") };
  else verification = { status: "matched", checked };

  const items: BatchLine[] = entries.map((e, i) => ({
    item: i + 1,
    target: e.label,
    outcome: e.result?.outcome ?? "not_attempted",
    verification: e.result?.verification.status ?? "not_attempted",
    summary: truncate(e.result?.summary ?? e.skipped ?? "", LINE_SUMMARY_CHARS),
    ...(o.detail && e.result ? { result: e.result } : {}),
  }));
  const steps: StepResult[] = entries.map((e, i) => {
    const status = stepStatusOf(e);
    return { name: `item ${i + 1}: ${e.label}`, status, ...(status === "succeeded" ? {} : { error: e.skipped ?? truncate(e.result?.summary ?? "", LINE_SUMMARY_CHARS) }) };
  });
  const warnings = [...(o.warnings ?? []), ...entries.flatMap((e, i) => (e.result?.warnings ?? []).map((w) => `item ${i + 1}: ${w}`))];
  const matched = count((r) => r.verification.status === "matched");
  const failed = results.length - succeeded;
  const firstProblem = entries.findIndex((e) => !e.result || !itemOk(e.result));
  const summary =
    `${operation}: ${entries.length} item(s): ${succeeded} succeeded (${matched} read back matched)` +
    (failed ? `, ${failed} did not succeed` : "") +
    (skipped ? `, ${skipped} not attempted` : "") +
    (firstProblem >= 0 ? `. First problem, ${label(firstProblem)}: ${truncate(entries[firstProblem].result?.summary ?? entries[firstProblem].skipped ?? "", LINE_SUMMARY_CHARS)}` : "") +
    ".";
  return {
    operation,
    target: { items: entries.length },
    outcome,
    verification,
    steps,
    summary,
    ...(warnings.length ? { warnings } : {}),
    items,
    ...(o.detail ? {} : { detailHint: "detail: true returns every item's full result with its steps" }),
    ...(o.extra ?? {}),
  };
}

/**
 * A compact form of a large single result (many cues, an observed cycle): every top-level field, but only the
 * steps that did not succeed, a count of the steps by status, and no read-back value dumps. `detail: true` keeps
 * the full result.
 */
export function compactResult(result: OperationResult, detail: boolean): OperationResult {
  if (detail) return result;
  const stepCounts: Record<string, number> = {};
  for (const s of result.steps) stepCounts[s.status] = (stepCounts[s.status] ?? 0) + 1;
  const steps = result.steps.filter((s) => s.status !== "succeeded").map(({ detail: _d, ...rest }) => rest);
  const { actual: _a, expected: _e, ...verification } = result.verification;
  return { ...result, verification, steps, stepCounts, detailHint: "detail: true returns every step with its details and the read-back values" };
}
