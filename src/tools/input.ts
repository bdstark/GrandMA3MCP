/**
 * KB-05: gated structured input tools.
 *
 *   gma3_input_interaction   acquire / renew / end a leased interaction (explicit ownership across calls)
 *   gma3_hardkey             logical MA key (PLEASE, STORE, MA, NUM5, EXEC ...): tap, press, release; combos
 *   gma3_keyboard            raw PC key with explicit per-event modifiers: tap, press, release
 *   gma3_type                Unicode text into an explicit context; never presses Enter
 *   gma3_input_sequence      bounded ordered taps, presses, releases, combos, text and waits
 *   gma3_hardkeys_status     read-only capability, enablement, owners, holds, interactions, sequences
 *   gma3_hardkeys_release_all  release this server's keys (and optionally recover unresolved records)
 *
 * The TypeScript side is a thin wrapper: every key event, text chunk, ownership record, lease,
 * deadline, admission decision and recovery lives in the Lua bridge (plugin/gma3_mcp_hardkeys.lua
 * through plugin/gma3_mcp_bridge.lua, ops input.*). Nothing here dispatches, retries or replays.
 *
 * Contracts the tools expose (see KEYBOARD.md "KB-05", docs/tools/input.md):
 *   - Input is OFF on the console until the operator starts or toggles the bridge with
 *     `Plugin "gma3_mcp_bridge" "input=keyboard"`. Status, releases and recovery work while it is off.
 *   - Bounded taps, chord taps, text and sequences own a bridge-side interaction for their duration.
 *     A standalone hold (press, combo hold) needs an interaction acquired first and its id on every
 *     call; the id is bound to this server's bridge connection and is never resumed after a reconnect.
 *   - While an interaction is open, a sequence runs or any key is held, the bridge refuses commands,
 *     property changes, playback, faders and Lua from EVERY connection with [busy]; reads stay available.
 *   - A tap is reported after its release was attempted (the tool waits for the sequence); the
 *     response never claims a UI effect. Verification is `matched` only when a readable observable
 *     (aggregate MASTATE for MA, the command line for command-line text) showed the expected value,
 *     otherwise `unavailable`. A step whose dispatch raised or whose release stayed unresolved is
 *     `unknown`; a timeout leaves the sequence running on the console and reports what was observed.
 */
import { z } from "zod";
import { BridgeError, type Gma3Bridge } from "../bridge.js";
import { json, operation, type RegisterTools, type ToolContext } from "./context.js";
import {
  buildResult,
  notRequested,
  stepFromError,
  unavailable,
  validationFailure,
  type OperationResult,
  type StepResult,
  type Verification,
} from "../results.js";

// ---------------------------------------------------------------------------
// Shared schema pieces
// ---------------------------------------------------------------------------

export const LOGICAL_KEYS = ["PLEASE", "STORE", "ESC", "CLEAR", "OOPS", "NUM0", "NUM1", "NUM2", "NUM3", "NUM4", "NUM5", "NUM6", "NUM7", "NUM8", "NUM9", "EXEC", "MA"] as const;
export type LogicalKey = (typeof LOGICAL_KEYS)[number];
export const TEXT_CONTEXTS = ["command-line", "text-field"] as const;

/** Mirrors the bridge's text policy so a refused text costs no round trip: UTF-8 by code point, no control characters. */
export const MAX_TEXT_CHARS = 256;
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u;

/** Why `text` is refused by the text policy, or null when it is acceptable. */
export function textPolicyError(text: string): string | null {
  if (text.length === 0) return "text is empty";
  const chars = Array.from(text);
  if (chars.length > MAX_TEXT_CHARS) return `text has ${chars.length} characters; at most ${MAX_TEXT_CHARS} are accepted per call`;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (CONTROL_CHARS.test(ch)) {
      const cp = ch.codePointAt(0)!;
      const what = cp === 10 || cp === 13 ? "newline" : cp === 9 ? "tab" : cp === 0x2028 || cp === 0x2029 ? "line/paragraph separator" : "control character";
      return `character ${i + 1} is a ${what} (U+${cp.toString(16).toUpperCase().padStart(4, "0")}); execution and control characters are refused: commit text with an explicit PLEASE key event (gma3_hardkey), never through the text`;
    }
    if (/^[\uD800-\uDFFF]$/.test(ch)) return `character ${i + 1} is an unpaired surrogate; text must be valid Unicode`;
  }
  return null;
}

const SESSION_LEASE_MS = 60000;
const POLL_MS = 50;
const MAX_WAIT_MS = 60000;

const logicalKeySchema = z.enum(LOGICAL_KEYS).describe("Logical MA key resolved through the operator's live shortcut table (MA = LeftShift natively, PLEASE = the native Enter redirect). MA1/MA2 are unsupported.");
const pcKeySchema = z.string().min(1).describe("Case-sensitive Enums.KeyboardCodes name as the console spells it (Enter, Escape, LeftShift, F1, 5, A). Validated on the console before dispatch.");
const modifierDoc = "PC modifier passed explicitly on the press and the release (one event with the flag; no modifier key is pressed separately). Only with pc_key.";
const interactionDoc = "Id from gma3_input_interaction acquire. Required for a standalone hold (press). A bounded tap, chord tap, text or sequence may run without one (it owns an interaction for its duration) but must pass the id while this server has one open.";
const displayDoc = "Display index passed to the console as API context only. It must exist; input is NOT display-scoped on onPC 2.5.1 (no routing, focus or pop-up placement is promised).";

const keyFields = {
  key: logicalKeySchema.optional(),
  pc_key: pcKeySchema.optional(),
  shift: z.boolean().optional().describe(modifierDoc),
  ctrl: z.boolean().optional().describe(modifierDoc),
  alt: z.boolean().optional().describe(modifierDoc),
  numlock: z.boolean().optional().describe("Numlock flag passed explicitly on both events. Only with pc_key."),
  executor: z.number().int().positive().optional().describe("ExecutorIndex of a mapped executor shortcut; required with key EXEC, refused otherwise."),
  display: z.number().int().positive().optional().describe(displayDoc),
};

interface KeyArgs {
  key?: LogicalKey;
  pc_key?: string;
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  numlock?: boolean;
  executor?: number;
  display?: number;
  exclusive?: boolean;
}

/** Bridge key spec (camelCase) from tool arguments; throws a ValidationError-like message string on misuse. */
export function keySpec(a: KeyArgs, what = "key"): Record<string, unknown> {
  const errors: string[] = [];
  if (a.key !== undefined && a.pc_key !== undefined) errors.push(`${what}: give either key (logical) or pc_key (raw), not both`);
  if (a.key === undefined && a.pc_key === undefined) errors.push(`${what}: key (logical) or pc_key (raw) is required`);
  if (a.key !== undefined && (a.shift || a.ctrl || a.alt)) errors.push(`${what}: modifiers of a logical key come from its shortcut mapping; pass them only with pc_key`);
  if (a.key === "EXEC" && a.executor === undefined) errors.push(`${what}: EXEC needs executor (the ExecutorIndex of a mapped executor shortcut)`);
  if (a.key !== "EXEC" && a.executor !== undefined) errors.push(`${what}: executor is only valid with key EXEC`);
  if (errors.length) throw new InputValidationError(errors);
  const spec: Record<string, unknown> = {};
  if (a.key !== undefined) spec.key = a.key;
  if (a.pc_key !== undefined) spec.pcKey = a.pc_key;
  for (const f of ["shift", "ctrl", "alt", "numlock"] as const) if (a[f] !== undefined) spec[f] = a[f];
  if (a.executor !== undefined) spec.executor = a.executor;
  if (a.display !== undefined) spec.display = a.display;
  if (a.exclusive !== undefined) spec.exclusive = a.exclusive;
  return spec;
}

export class InputValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(errors.join("; "));
    this.name = "InputValidationError";
  }
}

export const keyLabel = (a: KeyArgs): string => a.key ?? `${[a.ctrl && "Ctrl", a.alt && "Alt", a.shift && "Shift"].filter(Boolean).join("+")}${a.ctrl || a.alt || a.shift ? "+" : ""}${a.pc_key ?? "?"}`;

// ---------------------------------------------------------------------------
// Bridge plumbing: sessions, errors, sequence polling
// ---------------------------------------------------------------------------

/**
 * The bridge binds one input session to this server's TCP connection. Renew it (the lease only moves a
 * deadline, nothing is injected); after a reconnect the bridge knows no session, so open one. An
 * interaction id from before the reconnect is then refused by the bridge: nothing is resumed.
 */
async function ensureSession(bridge: Gma3Bridge): Promise<void> {
  try {
    await bridge.request("input.renew", { leaseMs: SESSION_LEASE_MS });
  } catch (err) {
    if (err instanceof BridgeError && !err.dispatched && err.code === "no-session") {
      await bridge.request("input.open", { leaseMs: SESSION_LEASE_MS, label: "gma3-mcp" });
      return;
    }
    throw err;
  }
}

/**
 * A bridge refusal as a step. Refused before dispatch -> failed. Uncertain (the request may have
 * reached the console: timeout, a press that raised and left an unresolved record, a combo that
 * pressed keys before failing) -> unknown. The structured detail travels with the step.
 */
export function inputStepFromError(name: string, op: string, err: unknown): StepResult {
  if (err instanceof BridgeError && (err.code !== undefined || err.detail !== undefined) && !err.dispatched) {
    const d = err.detail ?? {};
    const pressed = Array.isArray(d.pressed) ? (d.pressed as unknown[]).length : 0;
    const uncertain = d.unresolved === true || pressed > 0 || (d.rollback !== undefined && Array.isArray((d.rollback as { unresolved?: unknown[] }).unresolved) && ((d.rollback as { unresolved: unknown[] }).unresolved.length > 0));
    const detail: Record<string, unknown> = { code: err.code, ...d };
    delete detail.message;
    return {
      name,
      status: uncertain ? "unknown" : "failed",
      op,
      error: uncertain ? `${err.message}. Input may have reached the console (${pressed ? `${pressed} key(s) were pressed before the failure` : "the record is unresolved"}); nothing was retried.` : err.message,
      detail,
    };
  }
  return stepFromError(name, err, { op });
}

interface SequenceEvent {
  index: number;
  kind: string;
  state: string;
  key?: string;
  pcKey?: string;
  keys?: string[];
  hold?: string;
  holds?: string[];
  pressOutcome?: string;
  releaseOutcome?: string;
  code?: string;
  error?: string;
  chars?: number;
  typed?: number;
  remaining?: number;
  readback?: { outcome?: string; source?: string; expected?: unknown; actual?: unknown; value?: unknown; reason?: string; note?: string; phase?: string };
  [k: string]: unknown;
}

interface SequenceReport {
  id: string;
  state: string;
  session?: string;
  interaction?: string;
  autoInteraction?: boolean;
  steps: number;
  index?: number;
  failedStep?: number;
  counts?: Record<string, number>;
  error?: string;
  events: SequenceEvent[];
  cleanup?: Record<string, unknown>;
  estimateMs?: number;
  elapsedMs?: number;
  [k: string]: unknown;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Start a sequence and poll it until it is no longer running or `waitMs` elapsed. A timeout does not
 * abort or replay anything: the sequence keeps running (bounded) on the console and the last report
 * is returned with state "running".
 */
async function runSequence(bridge: Gma3Bridge, args: Record<string, unknown>, waitMs: number): Promise<SequenceReport> {
  let rep = (await bridge.request("input.sequence", args)) as SequenceReport;
  const deadline = Date.now() + waitMs;
  while (rep.state === "running" && Date.now() < deadline) {
    await sleep(POLL_MS);
    rep = (await bridge.request("input.sequence.status", { sequence: rep.id })) as SequenceReport;
  }
  return rep;
}

const eventName = (ev: SequenceEvent): string => {
  const what = ev.key ?? ev.pcKey ?? (ev.keys ? ev.keys.join("+") : ev.kind === "text" ? `${ev.chars ?? "?"} chars` : ev.kind === "wait" ? `${ev.ms ?? "?"} ms` : "");
  return `${ev.index}:${ev.kind}${what ? ` ${what}` : ""}`;
};

/** Events of a sequence report as steps; completed -> succeeded, failed -> failed, unattempted -> skipped, anything else (uncertain, aborted, still running) -> unknown. */
export function sequenceSteps(rep: SequenceReport): StepResult[] {
  return (rep.events ?? []).map((ev) => {
    let status: StepResult["status"];
    let error = ev.error;
    switch (ev.state) {
      case "completed":
        status = "succeeded";
        break;
      case "failed":
        status = "failed";
        break;
      case "unattempted":
        status = "skipped";
        error = ev.error ?? "not attempted";
        break;
      case "uncertain":
        status = "unknown";
        break;
      case "aborted":
        status = "unknown";
        error = ev.error ?? "aborted while in progress";
        break;
      default:
        status = "unknown";
        error = `still ${ev.state} on the console when this tool stopped waiting${ev.typed !== undefined ? ` (${ev.typed} of ${ev.chars} characters typed)` : ""}; not retried`;
    }
    return { name: eventName(ev), status, op: "input.sequence", error, detail: ev };
  });
}

/** Verification across the readbacks of a sequence: observed values match, anything else is unavailable. */
export function sequenceVerification(rep: SequenceReport): Verification {
  const rbs = (rep.events ?? []).filter((ev) => ev.readback && ev.state !== "unattempted").map((ev) => ({ ev, rb: ev.readback! }));
  if (rbs.length === 0) return unavailable("no observable exists for these events; the UI effect was not verified", "none");
  const observed = rbs.filter(({ rb }) => rb.outcome === "observed");
  const others = rbs.filter(({ rb }) => rb.outcome !== "observed");
  const checked = rbs.map(({ ev, rb }) => `${eventName(ev)}: ${rb.source ?? "readback"}`).join("; ");
  if (others.length === 0) {
    return {
      status: "matched",
      checked,
      expected: rbs.map(({ rb }) => rb.expected ?? rb.value),
      actual: rbs.map(({ rb }) => rb.actual ?? rb.value),
      detail: rbs.map(({ rb }) => rb.note).filter(Boolean).join("; ") || undefined,
    };
  }
  const detail = others.map(({ ev, rb }) => `${eventName(ev)}: ${rb.outcome}${rb.reason ? ` (${rb.reason})` : ""}`).join("; ");
  return { status: "unavailable", checked, detail: `${detail}${observed.length ? `; observed: ${observed.map(({ ev }) => eventName(ev)).join(", ")}` : ""}` };
}

export function sequenceResult(op: string, target: Record<string, unknown>, rep: SequenceReport, extra: Record<string, unknown> = {}): OperationResult {
  const steps = sequenceSteps(rep);
  const warnings: string[] = [];
  if (rep.state === "running") {
    warnings.push(`sequence ${rep.id} was still running when the tool stopped waiting; it continues on the console (bounded by its lease) and is never replayed. Read gma3_hardkeys_status or sequence ${rep.id} later; do not resend it.`);
  }
  if (rep.state === "aborted") warnings.push(`sequence ${rep.id} was aborted: ${rep.error ?? "unknown reason"}`);
  const cleanup = rep.cleanup as { unresolved?: number; released?: number } | undefined;
  if (cleanup?.unresolved) warnings.push(`${cleanup.unresolved} key(s) pressed by the sequence could not be released and stay as unresolved records: see gma3_hardkeys_status; the operator may need "input recover"`);
  if (cleanup?.released) warnings.push(`${cleanup.released} key(s) still held at the end of the sequence were released (newest first)`);
  return buildResult({
    operation: op,
    target,
    steps,
    verification: sequenceVerification(rep),
    warnings,
    extra: { sequence: { id: rep.id, state: rep.state, interaction: rep.interaction, autoInteraction: rep.autoInteraction, counts: rep.counts, error: rep.error, cleanup: rep.cleanup, estimateMs: rep.estimateMs, elapsedMs: rep.elapsedMs }, ...extra },
  });
}

function estimateMs(steps: Array<Record<string, unknown>>): number {
  let ms = 0;
  for (const s of steps) {
    if (s.kind === "tap" || s.kind === "combo") ms += Number(s.holdMs ?? 50);
    else if (s.kind === "wait") ms += Number(s.ms ?? 0);
    else if (s.kind === "text") ms += Math.ceil(Array.from(String(s.text ?? "")).length / 8) * 40 + 1000; // chunks + readback window
    else ms += 20;
  }
  return ms;
}

/** Hold report returned by input.press / input.release. */
interface HoldReport {
  id: string;
  state: string;
  logical?: string;
  pcKey?: string;
  tupleKey?: string;
  interaction?: string;
  pressOutcome?: string;
  releaseOutcome?: string;
  alreadyReleased?: boolean;
  unresolved?: { reason?: string };
  readback?: { outcome?: string; value?: unknown; reason?: string; note?: string };
  [k: string]: unknown;
}

const holdVerification = (): Verification => unavailable("no per-key readback exists; the console's reaction to a held key is not verified (MA readback appears in gma3_hardkeys_status once serviced)", "none");

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const registerInputTools: RegisterTools = (server, ctx) => {
  const { bridge, mutations } = ctx;

  const mutate = <T>(fn: () => Promise<T>) => mutations.run(fn);

  // --- interaction ---------------------------------------------------------
  server.registerTool(
    "gma3_input_interaction",
    {
      title: "Acquire, renew or end an input interaction",
      description:
        "Explicit ownership for console key input across several calls (KB-05). acquire returns a leased interaction id bound to this server's bridge connection; " +
        "pass it to gma3_hardkey/gma3_keyboard press and release, gma3_type and gma3_input_sequence. While it is open the bridge refuses commands, property changes, playback, faders and Lua " +
        "from EVERY client with [busy] (reads stay available), so end it as soon as the interaction is done. renew moves the lease deadline (default 15 s, max 120 s; nothing is pressed). " +
        "end releases every key the interaction holds (newest first), aborts its sequence and reports what stayed unresolved. An interaction is never resumed: after a lease expiry, a bridge reconnect or end, acquire a new one. " +
        'Needs input enabled on the console (Plugin "gma3_mcp_bridge" "input=keyboard"); end works while input is disabled. Nothing here presses a key.',
      inputSchema: {
        action: z.enum(["acquire", "renew", "end"]),
        lease_ms: z.number().int().positive().max(120000).optional().describe("Lease in ms for acquire/renew (default 15000, max 120000). Expiry releases the interaction's keys."),
        label: z.string().max(80).optional().describe("Free label shown in status (acquire)."),
        interaction: z.string().optional().describe("The interaction id (renew, end)."),
      },
    },
    async ({ action, lease_ms, label, interaction }) => {
      if (action === "acquire") {
        try {
          const r = (await bridge.request("input.begin", { leaseMs: lease_ms, label })) as Record<string, unknown>;
          return json({ ...r, note: "pass interaction.id on every input call of this interaction and end it when done; commands from every client are [busy] meanwhile" });
        } catch (err) {
          return errorJson(err);
        }
      }
      if (interaction === undefined) return errorJson(new Error(`${action} needs the interaction id`));
      if (action === "renew") {
        try {
          return json(await bridge.request("input.extend", { interaction, leaseMs: lease_ms }));
        } catch (err) {
          return errorJson(err);
        }
      }
      return operation(() =>
        mutate(async () => {
          const target = { interaction };
          let r: Record<string, unknown>;
          try {
            r = (await bridge.request("input.end", { interaction })) as Record<string, unknown>;
          } catch (err) {
            return buildResult({ operation: "input_interaction_end", target, steps: [inputStepFromError("end", "input.end", err)] });
          }
          const steps = releaseSteps(r);
          if (steps.length === 0) steps.push({ name: "end", status: "succeeded", op: "input.end", detail: r });
          const warnings: string[] = [];
          if (r.alreadyEnded) warnings.push("the interaction had already ended (expired, disconnected or ended before); nothing was held by it");
          return buildResult({ operation: "input_interaction_end", target, steps, verification: notRequested(), warnings, extra: { interaction: r } });
        }),
      );
    },
  );

  // --- hardkey ---------------------------------------------------------------
  server.registerTool(
    "gma3_hardkey",
    {
      title: "Press a logical MA key",
      description:
        "Press, release or tap a logical MA hardkey (PLEASE, STORE, ESC, CLEAR, OOPS, NUM0-9, EXEC with executor, MA) on the console through the bridge's keyboard backend: REAL console keys are pressed " +
        "through the operator's shortcut table or a verified native route (MA = LeftShift, PLEASE = Enter redirect); unmapped, ambiguous or colliding routes are refused before dispatch. " +
        "tap presses and releases with hold_ms (default 50, max 5000) and returns once the release was attempted; exclusive: true is the intended long-press (every other input is refused meanwhile). " +
        "keys (2-4 logical keys) presses a combination in order and releases newest first (chord tap with action tap; a hold with action press). " +
        "press holds the key until release or the interaction/lease ends and REQUIRES an interaction id (gma3_input_interaction acquire). " +
        "While any key is held or an interaction is open, the bridge refuses commands/property/playback/fader/Lua from every client with [busy]. " +
        'Input is OFF until the operator runs  Plugin "gma3_mcp_bridge" "input=keyboard"  (release works while off). Input is not display-scoped. ' +
        "The result never claims a UI effect: verification is unavailable unless an observable (aggregate MASTATE for MA) showed the expected value; a release on this backend is 'dispatched', never 'confirmed'. Nothing is retried or replayed; an uncertain dispatch is reported as unknown.",
      inputSchema: {
        action: z.enum(["tap", "press", "release"]),
        key: logicalKeySchema.optional(),
        keys: z.array(logicalKeySchema).min(2).max(4).optional().describe("A combination pressed in order (e.g. [MA, STORE]) and released newest first. Instead of key."),
        executor: keyFields.executor,
        hold_ms: z.number().int().positive().max(5000).optional().describe("tap only: how long the key (or chord) stays down before the scheduled release (default 50)."),
        exclusive: z.boolean().optional().describe("tap/press of a single key only: the intended long-press; refused while anything else is held, and refuses every other input until released."),
        display: keyFields.display,
        interaction: z.string().optional().describe(interactionDoc),
      },
    },
    async ({ action, key, keys, executor, hold_ms, exclusive, display, interaction }) =>
      operation(() =>
        mutate(() =>
          keyAction(ctx, "hardkey", action, {
            single: key !== undefined ? { key, executor, display } : undefined,
            combo: keys?.map((k) => ({ key: k, display })),
            holdMs: hold_ms,
            exclusive,
            interaction,
          }),
        ),
      ),
  );

  // --- keyboard ----------------------------------------------------------------
  server.registerTool(
    "gma3_keyboard",
    {
      title: "Press a PC key with explicit modifiers",
      description:
        "Press, release or tap a raw PC key (case-sensitive Enums.KeyboardCodes name: Enter, Escape, F1, 5, A, LeftShift ...) with shift/ctrl/alt/numlock passed explicitly on the press AND the release, through the console's Keyboard() emulation. " +
        "What the key does depends on the operator's user profile, keyboard shortcut enablement and the focused UI element (a mapped key may edit a focused field instead of acting as a hardkey); nothing is substituted or resolved for you, " +
        "prefer gma3_hardkey for MA keys. tap returns after the release was attempted; press REQUIRES an interaction id; release uses the stored press tuple. " +
        "Same gate, ownership, busy and verification rules as gma3_hardkey: real keys, input OFF until the operator runs  Plugin \"gma3_mcp_bridge\" \"input=keyboard\", not display-scoped, commands from every client are [busy] while a key is held, UI effect unverified, nothing retried or replayed.",
      inputSchema: {
        action: z.enum(["tap", "press", "release"]),
        pc_key: pcKeySchema,
        shift: keyFields.shift,
        ctrl: keyFields.ctrl,
        alt: keyFields.alt,
        numlock: keyFields.numlock,
        hold_ms: z.number().int().positive().max(5000).optional().describe("tap only (default 50)."),
        exclusive: z.boolean().optional().describe("The intended long-press (see gma3_hardkey)."),
        display: keyFields.display,
        interaction: z.string().optional().describe(interactionDoc),
      },
    },
    async ({ action, pc_key, shift, ctrl, alt, numlock, hold_ms, exclusive, display, interaction }) =>
      operation(() =>
        mutate(() =>
          keyAction(ctx, "keyboard", action, {
            single: { pc_key, shift, ctrl, alt, numlock, display },
            holdMs: hold_ms,
            exclusive,
            interaction,
          }),
        ),
      ),
  );

  // --- type --------------------------------------------------------------------
  server.registerTool(
    "gma3_type",
    {
      title: "Type text into the console",
      description:
        "Type Unicode text as one character event per code point into an EXPLICIT context: 'command-line' is admitted only while the operator has disabled keyboard shortcuts (F10; with shortcuts enabled, characters never reach the command line and nothing is substituted) " +
        "and is read back from the command line (matched when it shows the text, otherwise unavailable); 'text-field' means a text field is focused, which cannot be observed from Lua, so acknowledge_focus: true is required and verification is unavailable. " +
        "Text is typed in chunks by the bridge loop with the context rechecked between chunks; it stops with its progress when shortcuts are toggled meanwhile. " +
        "Newlines, tabs and other control characters are refused (up to 256 characters); text NEVER presses Enter, changes focus, opens an editor or toggles shortcuts: commit it with a separate gma3_hardkey PLEASE tap. " +
        "Same gate and busy rules as gma3_hardkey (input OFF until the operator runs  Plugin \"gma3_mcp_bridge\" \"input=keyboard\"; commands from every client are [busy] while it types). Nothing is retried or replayed; a character whose dispatch raised is reported as unknown at that position.",
      inputSchema: {
        text: z.string().min(1).max(MAX_TEXT_CHARS * 4).describe("The text (UTF-8, no control characters, at most 256 characters)."),
        context: z.enum(TEXT_CONTEXTS).describe("Where the characters are meant to go; validated and read back where possible."),
        acknowledge_focus: z.boolean().optional().describe("Required true for context text-field: you state that a text field is focused (unverifiable)."),
        display: keyFields.display,
        interaction: z.string().optional().describe(interactionDoc),
      },
    },
    async ({ text, context, acknowledge_focus, display, interaction }) =>
      operation(() =>
        mutate(async () => {
          const target = { context, chars: Array.from(text).length };
          const policy = textPolicyError(text);
          if (policy) return validationFailure("type", target, [policy]);
          if (context === "text-field" && acknowledge_focus !== true) {
            return validationFailure("type", target, ["context text-field needs acknowledge_focus: true (focus on a text field cannot be observed; you state it is focused and UI verification is reported unavailable)"]);
          }
          const step: Record<string, unknown> = { kind: "text", text, context };
          if (acknowledge_focus !== undefined) step.acknowledgeFocus = acknowledge_focus;
          if (display !== undefined) step.display = display;
          return runBridgeSequence("type", target, ctx, [step], { interaction, label: "type" });
        }),
      ),
  );

  // --- sequence --------------------------------------------------------------------
  const stepKey = {
    key: keyFields.key,
    pc_key: keyFields.pc_key,
    shift: keyFields.shift,
    ctrl: keyFields.ctrl,
    alt: keyFields.alt,
    numlock: keyFields.numlock,
    executor: keyFields.executor,
    display: keyFields.display,
  };
  const stepSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("tap"), ...stepKey, hold_ms: z.number().int().positive().max(5000).optional(), exclusive: z.boolean().optional() }),
    z.object({ kind: z.literal("press"), ...stepKey, exclusive: z.boolean().optional() }).describe("Held until a later release step or the end of the sequence (then released newest first)."),
    z.object({ kind: z.literal("release"), ...stepKey }).describe("Releases a key an earlier step pressed (stored tuple)."),
    z.object({ kind: z.literal("combo"), keys: z.array(z.object(stepKey)).min(2).max(4), hold_ms: z.number().int().positive().max(5000).optional() }).describe("Keys pressed in order, released newest first; a chord tap with hold_ms, otherwise a hold."),
    z.object({ kind: z.literal("text"), text: z.string().min(1), context: z.enum(TEXT_CONTEXTS), acknowledge_focus: z.boolean().optional(), display: keyFields.display }).describe("Same rules as gma3_type; never presses Enter."),
    z.object({ kind: z.literal("wait"), ms: z.number().int().positive().max(2000) }),
  ]);

  server.registerTool(
    "gma3_input_sequence",
    {
      title: "Run a bounded input sequence",
      description:
        "Run an ordered, bounded sequence of console input under one interaction owner: taps, presses, releases, combinations, text and waits (at most 16 steps, about 30 s of holds/waits/typing). " +
        "The bridge validates EVERY step (routes, keys, text policy, context) before the first event; one invalid step means nothing is dispatched. Steps are then serviced one after another by the plugin loop " +
        "(a tap waits for its release, text goes out in chunks with its context rechecked), and a failure stops the sequence: later steps are reported as skipped, keys the sequence still holds are released newest first, nothing is replayed. " +
        "Each step ends succeeded, failed (nothing of it dispatched), unknown (a dispatch raised or a release stayed unresolved: the console may have received it) or skipped. " +
        "A tap is complete only after its release was attempted; completed never means a UI effect was verified (see verification/readback). Pass interaction to run inside an acquired interaction, otherwise one is begun and ended for the sequence. " +
        'Commands from every client are [busy] while it runs. Input is OFF until the operator runs  Plugin "gma3_mcp_bridge" "input=keyboard". Real console keys are pressed.',
      inputSchema: {
        steps: z.array(stepSchema).min(1).max(16),
        interaction: z.string().optional().describe(interactionDoc),
        lease_ms: z.number().int().positive().max(120000).optional().describe("Lease of the interaction begun for this sequence (default: twice its estimated duration + 2 s)."),
        label: z.string().max(80).optional(),
      },
    },
    async ({ steps, interaction, lease_ms, label }) =>
      operation(() =>
        mutate(async () => {
          const target = { steps: steps.length };
          let bridgeSteps: Array<Record<string, unknown>>;
          try {
            bridgeSteps = steps.map((s, i) => toBridgeStep(s, i + 1));
          } catch (err) {
            return validationFailure("input_sequence", target, err instanceof InputValidationError ? err.errors : [String(err)]);
          }
          return runBridgeSequence("input_sequence", target, ctx, bridgeSteps, { interaction, leaseMs: lease_ms, label });
        }),
      ),
  );

  // --- status ---------------------------------------------------------------------
  server.registerTool(
    "gma3_hardkeys_status",
    {
      title: "Input capability and ownership status",
      description:
        "Read-only: whether console input is enabled and on which backend (keyboard = real keys, fake = nothing reaches the console), the backend's limitations, this server's session, every ownership record " +
        "(owner, logical key, stored PC tuple, state, lease and deadline, dispatch outcomes, aggregate MASTATE readback, unresolved cleanup failures), open interactions, the running or last sequence, capacity, " +
        "and the busy descriptor the bridge applies to commands. Ownership records are responsibility for recovery, not physical key state (injected and physical input share one key state). Works while input is disabled; releases nothing.",
      inputSchema: {},
    },
    async () => {
      try {
        return json(await bridge.request("input.status", {}));
      } catch (err) {
        return errorJson(err);
      }
    },
  );

  // --- release all ---------------------------------------------------------------------
  server.registerTool(
    "gma3_hardkeys_release_all",
    {
      title: "Release every key this server holds",
      description:
        "Release every key held by this server's bridge session, newest first, with the stored press tuples (never re-resolved), and with recover: true also re-attempt the releases that stayed unresolved (a remapped or disabled shortcut, a release that raised). " +
        "Works while input is disabled: this is the recovery path. A release on the keyboard backend is 'dispatched' (no per-key readback), an unresolved one is reported as unknown and stays as a record until it succeeds or the operator runs  Plugin \"gma3_mcp_bridge\" \"input recover\". " +
        "Only this server's keys are affected; another client's or a physical operator's keys are not.",
      inputSchema: {
        recover: z.boolean().optional().describe("Also re-attempt this server's unresolved releases (after the operator restored a remapped route or re-enabled shortcuts)."),
      },
    },
    async ({ recover }) =>
      operation(() =>
        mutate(async () => {
          const target = { scope: "this server's session", recover: recover ?? false };
          const steps: StepResult[] = [];
          let extra: Record<string, unknown> = {};
          try {
            await ensureSession(bridge);
            const r = (await bridge.request("input.releaseAll", {})) as Record<string, unknown>;
            extra.releaseAll = r;
            steps.push(...releaseSteps(r));
            if (recover) {
              const rec = (await bridge.request("input.recover", {})) as Record<string, unknown>;
              extra.recover = rec;
              steps.push(...releaseSteps(rec, "recover"));
            }
          } catch (err) {
            steps.push(inputStepFromError(steps.length ? "recover" : "releaseAll", recover ? "input.recover" : "input.releaseAll", err));
          }
          if (steps.length === 0) steps.push({ name: "releaseAll", status: "succeeded", op: "input.releaseAll", detail: "nothing was held by this session" });
          return buildResult({ operation: "hardkeys_release_all", target, steps, verification: notRequested(), extra });
        }),
      ),
  );
};

// ---------------------------------------------------------------------------
// Helpers used by several tools
// ---------------------------------------------------------------------------

function errorJson(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const detail = err instanceof BridgeError ? { code: err.code, dispatched: err.dispatched, detail: err.detail } : undefined;
  return { content: [{ type: "text" as const, text: detail ? JSON.stringify({ error: message, ...detail }, null, 2) : message }], isError: true };
}

/** Release attempts of a bridge release report (releaseAll, recover, end) as steps. */
function releaseSteps(r: Record<string, unknown>, prefix = "release"): StepResult[] {
  const steps: StepResult[] = [];
  for (const a of (r.released as Array<Record<string, unknown>>) ?? []) {
    steps.push({ name: `${prefix} ${String(a.logical ?? a.tupleKey ?? a.hold)}`, status: "succeeded", op: "input.release", detail: a });
  }
  for (const a of (r.unresolved as Array<Record<string, unknown>>) ?? []) {
    steps.push({ name: `${prefix} ${String(a.logical ?? a.tupleKey ?? a.hold)}`, status: "unknown", op: "input.release", error: `release unresolved: ${String(a.error ?? "unconfirmed")}; the record is kept for recovery`, detail: a });
  }
  return steps;
}

function toBridgeStep(s: Record<string, unknown>, index: number): Record<string, unknown> {
  const what = `step ${index}`;
  switch (s.kind) {
    case "tap":
    case "press": {
      const spec = keySpec(s as KeyArgs, what);
      if (s.kind === "tap" && s.hold_ms !== undefined) spec.holdMs = s.hold_ms;
      return { kind: s.kind, ...spec };
    }
    case "release":
      return { kind: "release", ...keySpec(s as KeyArgs, what) };
    case "combo": {
      const keys = (s.keys as KeyArgs[]).map((k, i) => keySpec(k, `${what} key ${i + 1}`));
      const step: Record<string, unknown> = { kind: "combo", keys };
      if (s.hold_ms !== undefined) step.holdMs = s.hold_ms;
      return step;
    }
    case "text": {
      const policy = textPolicyError(String(s.text));
      if (policy) throw new InputValidationError([`${what}: ${policy}`]);
      if (s.context === "text-field" && s.acknowledge_focus !== true) throw new InputValidationError([`${what}: context text-field needs acknowledge_focus: true`]);
      const step: Record<string, unknown> = { kind: "text", text: s.text, context: s.context };
      if (s.acknowledge_focus !== undefined) step.acknowledgeFocus = s.acknowledge_focus;
      if (s.display !== undefined) step.display = s.display;
      return step;
    }
    case "wait":
      return { kind: "wait", ms: s.ms };
    default:
      throw new InputValidationError([`${what}: unknown kind ${String(s.kind)}`]);
  }
}

/** Start a sequence (session ensured first) and report it; a refusal before dispatch is a failed first step. */
async function runBridgeSequence(op: string, target: Record<string, unknown>, ctx: ToolContext, steps: Array<Record<string, unknown>>, opts: { interaction?: string; leaseMs?: number; label?: string }): Promise<OperationResult> {
  const { bridge } = ctx;
  const args: Record<string, unknown> = { steps };
  if (opts.interaction !== undefined) args.interaction = opts.interaction;
  if (opts.leaseMs !== undefined) args.leaseMs = opts.leaseMs;
  if (opts.label !== undefined) args.label = opts.label;
  // How long to wait for the sequence: its estimate plus a margin, never longer than twice the
  // configured request timeout. A sequence that outlives the wait keeps running on the console.
  const waitMs = Math.min(estimateMs(steps) + 3000, Math.max(ctx.requestTimeoutMs * 2, 200), MAX_WAIT_MS);
  try {
    await ensureSession(bridge);
    const rep = await runSequence(bridge, args, waitMs);
    return sequenceResult(op, target, rep);
  } catch (err) {
    return buildResult({ operation: op, target, steps: [inputStepFromError("sequence", "input.sequence", err)], verification: notRequested() });
  }
}

interface KeyActionArgs {
  single?: KeyArgs;
  combo?: KeyArgs[];
  holdMs?: number;
  exclusive?: boolean;
  interaction?: string;
}

async function keyAction(ctx: ToolContext, op: string, action: "tap" | "press" | "release", a: KeyActionArgs): Promise<OperationResult> {
  const { bridge } = ctx;
  const label = a.combo ? a.combo.map(keyLabel).join("+") : a.single ? keyLabel(a.single) : "?";
  const target: Record<string, unknown> = { action, key: label };
  const errors: string[] = [];
  if (!a.single && !a.combo) errors.push("key or keys is required");
  if (a.single && a.combo) errors.push("give either key or keys, not both");
  if (a.combo && a.exclusive) errors.push("exclusive applies to a single key only (a combination is never a long-press)");
  if (action === "release" && a.exclusive) errors.push("exclusive applies to tap and press only");
  if (action !== "tap" && a.holdMs !== undefined) errors.push("hold_ms applies to tap only");
  if (a.single && a.exclusive !== undefined) a.single = { ...a.single, exclusive: a.exclusive };
  if (action === "press" && a.interaction === undefined) {
    errors.push("a standalone hold needs an interaction: acquire one with gma3_input_interaction and pass its id, or use a bounded tap / gma3_input_sequence");
  }
  let specs: Record<string, unknown>[] = [];
  try {
    specs = a.combo ? a.combo.map((k, i) => keySpec(k, `key ${i + 1}`)) : a.single ? [keySpec(a.single)] : [];
  } catch (err) {
    if (err instanceof InputValidationError) errors.push(...err.errors);
    else throw err;
  }
  if (errors.length) return validationFailure(op, target, errors);

  if (action === "tap") {
    const step: Record<string, unknown> = a.combo ? { kind: "combo", keys: specs } : { kind: "tap", ...specs[0] };
    if (a.holdMs !== undefined) step.holdMs = a.holdMs;
    return runBridgeSequence(op, target, ctx, [step], { interaction: a.interaction, label: `${op} ${label}` });
  }

  const steps: StepResult[] = [];
  let extra: Record<string, unknown> = {};
  try {
    await ensureSession(bridge);
    if (action === "press") {
      if (a.combo) {
        const r = (await bridge.request("input.combo", { keys: specs, interaction: a.interaction })) as { holds: HoldReport[]; group?: string };
        for (const h of r.holds) steps.push({ name: `press ${h.logical ?? h.pcKey}`, status: "succeeded", op: "input.combo", detail: h });
        extra = { group: r.group, holds: r.holds.map((h) => h.id), interaction: a.interaction };
      } else {
        const r = (await bridge.request("input.press", { ...specs[0], interaction: a.interaction })) as { hold: HoldReport };
        const h = r.hold;
        steps.push({ name: `press ${label}`, status: "succeeded", op: "input.press", detail: h });
        extra = { hold: h.id, interaction: h.interaction, duplicate: h.duplicate === true || undefined };
      }
      return buildResult({
        operation: op,
        target,
        steps,
        verification: holdVerification(),
        warnings: [`the key stays down until gma3_hardkey/gma3_keyboard release, gma3_hardkeys_release_all, or the interaction ends; commands from every client are [busy] meanwhile`],
        extra,
      });
    }
    // release: each key of a combo newest first, the stored tuple is used by the bridge
    const order = a.combo ? [...specs].reverse() : specs;
    const holds: HoldReport[] = [];
    for (const spec of order) {
      const r = (await bridge.request("input.release", spec)) as { hold: HoldReport };
      const h = r.hold;
      holds.push(h);
      const name = `release ${h.logical ?? h.pcKey ?? label}`;
      if (h.alreadyReleased) steps.push({ name, status: "succeeded", op: "input.release", detail: { ...h, note: "already released (harmless)" } });
      else if (h.state === "released") steps.push({ name, status: "succeeded", op: "input.release", detail: h });
      else steps.push({ name, status: "unknown", op: "input.release", error: `release ${h.releaseOutcome ?? h.state}: ${h.unresolved?.reason ?? "unconfirmed"}; the record is kept, recover with gma3_hardkeys_release_all recover: true once the route is restored`, detail: h });
      if (h.state !== "released") break;
    }
    const released = holds.filter((h) => h.state === "released");
    const rb = released.map((h) => h.readback).find((r) => r && r.outcome);
    const verification: Verification = rb
      ? rb.outcome === "observed"
        ? { status: "matched", checked: "aggregate MASTATE after the release (not a per-key confirmation)", expected: false, actual: rb.value, detail: rb.note }
        : unavailable(rb.reason ?? `MASTATE readback ${rb.outcome}`, "aggregate MASTATE")
      : unavailable("no per-key readback exists on this backend; the release was dispatched, not confirmed", "none");
    return buildResult({ operation: op, target, steps, verification, extra: { holds: holds.map((h) => ({ id: h.id, state: h.state, releaseOutcome: h.releaseOutcome })) } });
  } catch (err) {
    steps.push(inputStepFromError(`${action} ${label}`, action === "press" ? (a.combo ? "input.combo" : "input.press") : "input.release", err));
    return buildResult({ operation: op, target, steps, verification: notRequested(), extra });
  }
}
