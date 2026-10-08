/**
 * Shared result model for workflow tools (FR-02).
 *
 * Every workflow tool reports the same shape so a client can decide whether to continue,
 * inspect console state, or stop:
 *
 *   - `outcome`      what the console did:        succeeded | failed | partial | unknown
 *   - `verification` what read-back showed:       matched | mismatched | unavailable | not_requested
 *   - `steps`        each bridge operation issued, in order, with its own status
 *
 * The rules encoded here:
 *   - Recognised negative command-line feedback is a failure. Unfamiliar feedback is `unknown`,
 *     never silently a success.
 *   - A transport error after a request was dispatched is `unknown`: the command may have run.
 *     Nothing here retries.
 *   - A multi-step operation stops at the first failed or unknown step; later steps are reported
 *     as `skipped` (unattempted).
 *   - Any outcome other than `succeeded`, and any `mismatched` verification, is surfaced as an MCP
 *     tool error. The full result stays in the error text.
 */
import { BridgeError, BridgeUnreachableError, type Gma3Bridge } from "./bridge.js";

export type ExecutionOutcome = "succeeded" | "failed" | "partial" | "unknown";
export type VerificationOutcome = "matched" | "mismatched" | "unavailable" | "not_requested";
export type StepStatus = "succeeded" | "failed" | "unknown" | "skipped";
export type FeedbackClass = "ok" | "error" | "unknown";

export interface StepResult {
  /** Short step name, e.g. "store", "label", "verify". */
  name: string;
  status: StepStatus;
  /**
   * "read" marks a step that cannot change anything (existence check, pre-flight read). Read steps
   * never count as completed work for `partial`, and a read step that fails or gets no reply makes
   * the operation `failed` rather than `unknown`, because nothing was mutated. Default: "mutation".
   */
  kind?: "read" | "mutation";
  /** Bridge op used ("cmd", "set", "objects", ...). */
  op?: string;
  /** Console command sent, for "cmd" steps. */
  command?: string;
  /** Raw command-line feedback for "cmd" steps (null when the console returned none). */
  feedback?: string | null;
  /** Why the step failed or is uncertain. */
  error?: string;
  /** Anything else worth keeping (bridge result, read-back values). */
  detail?: unknown;
}

export interface Verification {
  status: VerificationOutcome;
  /** What was checked, in words. */
  checked?: string;
  expected?: unknown;
  actual?: unknown;
  /** Why verification was unavailable or what mismatched. */
  detail?: string;
}

export interface OperationResult {
  /** The tool-level operation, e.g. "store_cue". */
  operation: string;
  /** The object(s) acted on, as the tool resolved them ({sequence: 1, cue: "2.5"}). */
  target: Record<string, unknown>;
  outcome: ExecutionOutcome;
  verification: Verification;
  steps: StepResult[];
  /** One-sentence summary for humans. */
  summary: string;
  warnings?: string[];
  /** Validation errors when the request was refused before anything was sent. */
  validationErrors?: string[];
  /** Tool-specific extras (previous assignment, resolved fixtures, ...). */
  [extra: string]: unknown;
}

// ---------------------------------------------------------------------------
// Console feedback classification
// ---------------------------------------------------------------------------

/** Feedback strings the console returns for an accepted command. */
export const POSITIVE_FEEDBACK = [/^ok\b/i];

/**
 * Feedback the console is known to return for a rejected command. Anything that is not in this
 * list and not positive is `unknown`: a new console version may word a refusal differently, and
 * treating it as success would be the worse mistake.
 */
export const NEGATIVE_FEEDBACK = [
  /syntax error/i,
  /illegal command/i,
  /illegal object/i,
  /illegal (value|argument|parameter|keyword|range)/i,
  /unknown (command|keyword|object|property|attribute)/i,
  /not allowed/i,
  /no (such|valid)\b/i,
  /does not exist/i,
  /doesn'?t exist/i,
  /not found/i,
  /invalid\b/i,
  /\bfailed\b/i,
  /\berror\b/i,
  /access denied/i,
  /insufficient (rights|permissions)/i,
  /read[- ]only/i,
  /out of range/i,
  /nothing (to|selected)/i,
  /cannot\b/i,
  /can'?t\b/i,
  /empty selection/i,
];

export function classifyFeedback(feedback: unknown): FeedbackClass {
  if (feedback === null || feedback === undefined) return "unknown";
  if (feedback === true) return "ok";
  if (feedback === false) return "error";
  const text = String(feedback).trim();
  if (text === "") return "unknown";
  for (const re of NEGATIVE_FEEDBACK) if (re.test(text)) return "error";
  for (const re of POSITIVE_FEEDBACK) if (re.test(text)) return "ok";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

/** Convert a thrown error from a bridge request into a step status. */
export function stepFromError(name: string, err: unknown, extra: Partial<StepResult> = {}): StepResult {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof BridgeUnreachableError) {
    return { name, status: "failed", error: `bridge unreachable, nothing was sent: ${message}`, ...extra };
  }
  if (err instanceof BridgeError && err.dispatched) {
    return {
      name,
      status: "unknown",
      error: `${message}. The request reached the bridge but no reply came back; it may have executed. It was not retried.`,
      ...extra,
    };
  }
  return { name, status: "failed", error: message, ...extra };
}

/**
 * Send one command-line command through the bridge and classify the console's feedback.
 * Never retries. A dispatched transport failure is an `unknown` step.
 */
export async function commandStep(bridge: Gma3Bridge, name: string, command: string, timeoutMs?: number): Promise<StepResult> {
  try {
    const res = (await bridge.request("cmd", { command }, timeoutMs)) as { feedback?: unknown } | null;
    const feedback = res && typeof res === "object" && "feedback" in res ? res.feedback : res;
    const cls = classifyFeedback(feedback);
    const fb = feedback === undefined || feedback === null ? null : String(feedback);
    if (cls === "ok") return { name, status: "succeeded", op: "cmd", command, feedback: fb };
    if (cls === "error") return { name, status: "failed", op: "cmd", command, feedback: fb, error: `console rejected the command: ${fb}` };
    return {
      name,
      status: "unknown",
      op: "cmd",
      command,
      feedback: fb,
      error: fb === null ? "the console returned no feedback for the command" : `unrecognised console feedback: ${fb}`,
    };
  } catch (err) {
    return stepFromError(name, err, { op: "cmd", command });
  }
}

/**
 * Run a generic bridge request as a step. `interpret` turns the bridge result into the step
 * (default: succeeded with the result as detail). A thrown bridge error becomes failed/unknown.
 */
export async function requestStep(
  bridge: Gma3Bridge,
  name: string,
  op: string,
  args: Record<string, unknown>,
  interpret?: (result: unknown) => StepResult,
  timeoutMs?: number,
): Promise<StepResult> {
  try {
    const result = await bridge.request(op, args, timeoutMs);
    return interpret ? interpret(result) : { name, status: "succeeded", op, detail: result };
  } catch (err) {
    return stepFromError(name, err, { op });
  }
}

/** Mark a step (or a step-producing function's result) as read-only; see StepResult.kind. */
export function asRead(step: StepResult): StepResult {
  return { ...step, kind: "read" };
}

/** A read-only step: existence check or pre-flight read. Failures make the operation `failed`, never `partial`/`unknown`. */
export async function readStep(
  bridge: Gma3Bridge,
  name: string,
  op: string,
  args: Record<string, unknown>,
  interpret?: (result: unknown) => StepResult,
  timeoutMs?: number,
): Promise<StepResult> {
  return asRead(await requestStep(bridge, name, op, args, interpret, timeoutMs));
}

export type StepFn = () => Promise<StepResult>;

/**
 * Run steps in order and stop at the first that is not `succeeded`. Unattempted steps are
 * reported as `skipped` so the caller can see exactly how far the operation got.
 */
export async function runSteps(plan: Array<{ name: string; run: StepFn }>): Promise<{ steps: StepResult[]; outcome: ExecutionOutcome }> {
  const steps: StepResult[] = [];
  let stopped: StepStatus | null = null;
  for (const item of plan) {
    if (stopped) {
      steps.push({ name: item.name, status: "skipped", error: `not attempted: an earlier step was ${stopped}` });
      continue;
    }
    let step: StepResult;
    try {
      step = await item.run();
    } catch (err) {
      step = stepFromError(item.name, err);
    }
    if (step.name !== item.name) step = { ...step, name: item.name };
    steps.push(step);
    if (step.status !== "succeeded") stopped = step.status;
  }
  return { steps, outcome: outcomeOf(steps) };
}

/**
 * Aggregate step statuses into the operation outcome. Only mutation steps count as completed work:
 * a read-only pre-check followed by a rejected first command is `failed`, not `partial`, and a
 * read step without a reply is `failed` (nothing was changed), not `unknown`.
 */
export function outcomeOf(steps: StepResult[]): ExecutionOutcome {
  const attempted = steps.filter((s) => s.status !== "skipped");
  if (attempted.length === 0) return "failed";
  const badIndex = attempted.findIndex((s) => s.status === "failed" || s.status === "unknown");
  if (badIndex < 0) return "succeeded";
  const bad = attempted[badIndex];
  const mutationsDone = attempted.slice(0, badIndex).filter((s) => s.status === "succeeded" && s.kind !== "read").length;
  if (mutationsDone > 0) return "partial";
  if (bad.kind === "read") return "failed";
  return bad.status === "unknown" ? "unknown" : "failed";
}

// ---------------------------------------------------------------------------
// Verification helpers
// ---------------------------------------------------------------------------

export const notRequested = (): Verification => ({ status: "not_requested" });
export const unavailable = (detail: string, checked?: string): Verification => ({ status: "unavailable", checked, detail });

/** Compare read-back values field by field. `expected` values of undefined are not checked. */
export function compareFields(checked: string, expected: Record<string, unknown>, actual: Record<string, unknown> | null | undefined): Verification {
  if (!actual) return unavailable("no values could be read back", checked);
  const mismatches: string[] = [];
  for (const [key, want] of Object.entries(expected)) {
    if (want === undefined) continue;
    const got = actual[key];
    if (!valuesEqual(want, got)) mismatches.push(`${key}: expected ${JSON.stringify(want)}, read ${JSON.stringify(got ?? null)}`);
  }
  if (mismatches.length) return { status: "mismatched", checked, expected, actual, detail: mismatches.join("; ") };
  return { status: "matched", checked, expected, actual };
}

/**
 * Loose equality for console display text: numbers compare numerically ("2.50" == 2.5, "3s" == 3),
 * strings compare trimmed and case-insensitively.
 */
export function valuesEqual(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true;
  if (actual === null || actual === undefined) return false;
  const a = String(actual).trim();
  if (typeof expected === "number") {
    const n = parseLeadingNumber(a);
    return n !== null && Math.abs(n - expected) < 1e-6;
  }
  if (typeof expected === "boolean") {
    return /^(yes|true|on|1)$/i.test(a) === expected;
  }
  const e = String(expected).trim();
  if (e.toLowerCase() === a.toLowerCase()) return true;
  const en = parseLeadingNumber(e);
  const an = parseLeadingNumber(a);
  return en !== null && an !== null && /^[-+]?\d*\.?\d+\s*[a-z%]*$/i.test(e) && /^[-+]?\d*\.?\d+\s*[a-z%]*$/i.test(a) && Math.abs(en - an) < 1e-6;
}

export function parseLeadingNumber(text: string): number | null {
  const m = text.match(/^[-+]?\d*\.?\d+(?:e[-+]?\d+)?/i);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Result assembly and MCP surfacing
// ---------------------------------------------------------------------------

export interface BuildResultOptions {
  operation: string;
  target: Record<string, unknown>;
  steps: StepResult[];
  verification?: Verification;
  summary?: string;
  warnings?: string[];
  extra?: Record<string, unknown>;
}

export function buildResult(o: BuildResultOptions): OperationResult {
  const outcome = outcomeOf(o.steps);
  const verification = o.verification ?? notRequested();
  const summary = o.summary ?? defaultSummary(o.operation, outcome, verification, o.steps);
  return { operation: o.operation, target: o.target, outcome, verification, steps: o.steps, summary, ...(o.warnings?.length ? { warnings: o.warnings } : {}), ...(o.extra ?? {}) };
}

export function validationFailure(operation: string, target: Record<string, unknown>, errors: string[]): OperationResult {
  return {
    operation,
    target,
    outcome: "failed",
    verification: notRequested(),
    steps: [],
    summary: `${operation} was not attempted: ${errors.join("; ")}`,
    validationErrors: errors,
  };
}

export function defaultSummary(operation: string, outcome: ExecutionOutcome, verification: Verification, steps: StepResult[]): string {
  const done = steps.filter((s) => s.status === "succeeded").map((s) => s.name);
  const bad = steps.find((s) => s.status === "failed" || s.status === "unknown");
  const skipped = steps.filter((s) => s.status === "skipped").map((s) => s.name);
  const parts: string[] = [];
  switch (outcome) {
    case "succeeded":
      parts.push(`${operation} succeeded`);
      break;
    case "failed":
      parts.push(`${operation} failed${bad ? ` at step '${bad.name}': ${bad.error ?? ""}` : ""}`);
      break;
    case "partial":
      parts.push(`${operation} partially completed: ${done.join(", ")} done; step '${bad?.name}' ${bad?.status}${bad?.error ? ` (${bad.error})` : ""}`);
      break;
    case "unknown":
      parts.push(`${operation} outcome unknown${bad ? ` at step '${bad.name}': ${bad.error ?? ""}` : ""}`);
      break;
  }
  if (skipped.length) parts.push(`not attempted: ${skipped.join(", ")}`);
  switch (verification.status) {
    case "matched":
      parts.push("read-back matched");
      break;
    case "mismatched":
      parts.push(`read-back MISMATCHED${verification.detail ? `: ${verification.detail}` : ""}`);
      break;
    case "unavailable":
      parts.push(`read-back unavailable${verification.detail ? `: ${verification.detail}` : ""}`);
      break;
  }
  return parts.join(". ") + ".";
}

/** True when the result must be surfaced as an MCP tool error. */
export function isErrorResult(result: OperationResult): boolean {
  return result.outcome !== "succeeded" || result.verification.status === "mismatched";
}

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** Render an OperationResult as an MCP tool result, flagging anything but a verified success. */
export function toToolResult(result: OperationResult): ToolResult {
  const text = JSON.stringify(result, null, 2);
  return isErrorResult(result) ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}
