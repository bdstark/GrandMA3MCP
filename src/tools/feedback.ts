/**
 * KB-06: read-only console feedback.
 *
 *   gma3_feedback   observe command text, last command, Blind/Highlight/Solo, Preview mode, a display's
 *                   Preview bar, shortcut enablement, aggregate MA state, current page, selected sequence,
 *                   executor assignment, fader level and sequence activity (bridge op `feedback.read`)
 *
 * The TypeScript side is a wrapper: every reader, its capability check, value normalisation, the request
 * expansion (displays, executors, sequences) and the per-request bounds live in the Lua feedback module
 * (plugin/gma3_mcp_feedback.lua 0.2.0 through plugin/gma3_mcp_bridge.lua 0.8.0). Nothing here reads
 * console state on its own or fills in a value the console did not supply.
 *
 * Contract (KEYBOARD.md "KB-06", docs/tools/feedback.md):
 *   - Works with gma3_lua disabled, with console input disabled, and while another client owns an input
 *     interaction (the op is never guarded). Reading acquires no interaction and changes no console state.
 *   - Every item carries `available`; an unavailable item has `value: null` and a `reason` (nothing usable
 *     from the console: nil, an unrecognised value, a missing display/sequence/executor, an unimplemented
 *     reader) or an `error` (the reader raised). A `false` value is always an available observation.
 *   - Items are read one after another: a result is not an atomic snapshot of the console. Each item carries
 *     `observedAt` (bridge clock, seconds) and the instance `epoch`; the bridge bumps the epoch when the show
 *     file, user or profile changed since the previous read, and at every bridge start.
 *   - `lastCommand` and `maState` are observations of shared console state, not confirmation of a particular
 *     request, client or key source. `sequenceActive` is sequence playback activity, not executor button state.
 */
import { z } from "zod";
import { BridgeError } from "../bridge.js";
import { json, type RegisterTools, type ToolContext } from "./context.js";
import type { ToolResult } from "../results.js";

/** Reader names the module offers (documented; the bridge's `feedback.describe` is authoritative). */
export const FEEDBACK_READERS = [
  "commandText", "lastCommand", "blind", "highlight", "solo", "previewMode", "previewBar", "shortcutsActive", "maState",
  "page", "selectedSequence", "sequenceActive", "executor", "fader", "freeze",
] as const;

/** Mirrors the module's default per-request bounds so an oversized request costs no round trip. */
export const MAX_TARGETS = 32;
export const MAX_DISPLAYS = 8;

export interface FeedbackItem {
  name: string;
  key: string;
  scope?: string;
  source?: string;
  params?: Record<string, unknown>;
  available: boolean;
  value: unknown;
  reason?: string;
  error?: string;
  observedAt?: number;
  epoch?: number;
  note?: string;
  alias?: string;
}

export interface FeedbackResult {
  context: {
    observedAt: number | null;
    epoch: number | null;
    atomic: false;
    identity: Record<string, unknown> | null;
    /** Identity keys (showFile, user, profile) whose value is the last known one because the current read failed; null when verified. */
    identityUncertain: string[] | null;
    invalidated: string | null;
    bridgeVersion: string | null;
    module: Record<string, unknown> | null;
    count: number;
    truncated: number;
  };
  items: FeedbackItem[];
  byKey: Record<string, FeedbackItem>;
  limitations: string[];
  note: string;
}

const NOTE =
  "Read-only observations, read one after another (not an atomic snapshot). An unavailable item has value null and a reason or error; false is an observed value. " +
  "lastCommand and maState are shared console observations, not confirmation of a request or key owner; sequenceActive is playback activity, not a button state. " +
  "Cached values are never served: every item was read for this call at its observedAt; the epoch changes after a bridge start or a show/user/profile change. " +
  "context.identityUncertain lists identity keys whose value is only the last known one (unreadable on this call); treat the identity as unverified while it is set.";

/** Normalise one bridge item: the console's JSON drops nil, so `value` is made an explicit null when unavailable. */
export function normaliseItem(raw: unknown): FeedbackItem {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const available = src.available === true;
  const item: FeedbackItem = {
    name: String(src.name ?? "?"),
    key: String(src.key ?? src.name ?? "?"),
    scope: typeof src.scope === "string" ? src.scope : undefined,
    source: typeof src.source === "string" ? src.source : undefined,
    params: src.params && typeof src.params === "object" ? (src.params as Record<string, unknown>) : undefined,
    available,
    value: available && "value" in src ? src.value : null,
    reason: typeof src.reason === "string" ? src.reason : undefined,
    error: typeof src.error === "string" ? src.error : undefined,
    observedAt: typeof src.observedAt === "number" ? src.observedAt : undefined,
    epoch: typeof src.epoch === "number" ? src.epoch : undefined,
    note: typeof src.note === "string" ? src.note : undefined,
    alias: typeof src.alias === "string" ? src.alias : undefined,
  };
  if (!available && item.reason === undefined && item.error === undefined) item.reason = "the bridge reported the item unavailable without a reason";
  return item;
}

export function normaliseResult(raw: unknown): FeedbackResult {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const items = (Array.isArray(src.items) ? src.items : []).map(normaliseItem);
  const byKey: Record<string, FeedbackItem> = {};
  for (const it of items) byKey[it.key] = it;
  const limitations = (Array.isArray(src.limitations) ? src.limitations : []).map((l) => String(l));
  const uncertain = Array.isArray(src.identityUncertain) && src.identityUncertain.length > 0 ? src.identityUncertain.map((k) => String(k)) : null;
  if (uncertain) limitations.push(`identity unverified: ${uncertain.join(", ")} could not be read on this call; context.identity shows the last known value and may not be current`);
  return {
    context: {
      observedAt: typeof src.observedAt === "number" ? src.observedAt : null,
      epoch: typeof src.epoch === "number" ? src.epoch : null,
      atomic: false,
      identity: src.identity && typeof src.identity === "object" ? (src.identity as Record<string, unknown>) : null,
      identityUncertain: Array.isArray(src.identityUncertain) && src.identityUncertain.length > 0 ? src.identityUncertain.map((k) => String(k)) : null,
      invalidated: typeof src.invalidated === "string" ? src.invalidated : null,
      bridgeVersion: typeof src.bridgeVersion === "string" ? src.bridgeVersion : null,
      module: src.module && typeof src.module === "object" ? (src.module as Record<string, unknown>) : null,
      count: items.length,
      truncated: typeof src.truncated === "number" ? src.truncated : 0,
    },
    items,
    byKey,
    limitations,
    note: NOTE,
  };
}

function validationError(errors: string[]): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ tool: "gma3_feedback", error: "validation failed", validationErrors: errors }, null, 2) }], isError: true };
}

function bridgeFailure(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  let text = message;
  if (err instanceof BridgeError && /unknown op 'feedback\./.test(message)) {
    text = `${message}. The feedback ops need bridge plugin 0.8.0 or newer (KB-06); update the plugin (docs/setup/bridge.md). Nothing was read.`;
  } else if (err instanceof BridgeError && err.code === "no-feedback") {
    text = `${message}. The feedback module did not load in the running bridge (see gma3_status modules); nothing was read.`;
  }
  return { content: [{ type: "text", text }], isError: true };
}

const intList = (what: string, max: number) =>
  z.array(z.number().int().positive()).max(max).optional().describe(`${what} (at most ${max} per call; a longer list is refused up front)`);

export const registerFeedbackTools: RegisterTools = (server, ctx: ToolContext) => {
  const { bridge } = ctx;

  server.registerTool(
    "gma3_feedback",
    {
      title: "Read console feedback state",
      description:
        "Read-only console state for feedback (KB-06): command-line text, last command feedback, Blind/Highlight/Solo, Preview mode, a display's Preview bar, keyboard-shortcut enablement, aggregate MA state, current executor page, selected sequence, and per executor the assignment and fader level, per sequence its playback activity. " +
        "Works with gma3_lua disabled, with console input disabled and while another client holds an input interaction; it acquires nothing and changes no console state (selection, command line, programmer, playback, focus). " +
        "Every item carries available, value (null when unavailable, with a reason or error; false is an observed value), scope, source, observedAt and epoch. Items are read one after another, not as an atomic snapshot. " +
        "lastCommand and maState are shared observations, not confirmation of a request or key owner; sequenceActive is playback activity, not executor button state; Freeze has no readable state and is always unavailable. " +
        "With no arguments every parameterless reader is read (previewBar on display 1). Bridge op feedback.read (plugin >= 0.8.0).",
      inputSchema: {
        readers: z.array(z.enum(FEEDBACK_READERS)).optional().describe("Readers to include. Parameterised readers (executor, fader, sequenceActive) come from executors/sequences instead. Omit everything to read all parameterless readers."),
        displays: intList("Display indexes for previewBar (one item per display; a missing display is reported unavailable)", MAX_DISPLAYS),
        executors: intList("Executor numbers on the user's current page: assignment (executor) and master level (fader) per number", MAX_TARGETS),
        sequences: intList("Sequence numbers: playback activity (sequenceActive) per number", MAX_TARGETS),
        fader_tokens: z.array(z.string().min(1)).max(4).optional().describe("Fader tokens read per executor (default ['FaderMaster'])"),
      },
    },
    async ({ readers, displays, executors, sequences, fader_tokens }) => {
      const errors: string[] = [];
      const dup = (what: string, list?: number[]) => {
        if (list && new Set(list).size !== list.length) errors.push(`${what} contains duplicates`);
      };
      dup("displays", displays);
      dup("executors", executors);
      dup("sequences", sequences);
      if (errors.length) return validationError(errors);
      const nothingNamed = !readers?.length && !executors?.length && !sequences?.length;
      const args: Record<string, unknown> = {};
      if (nothingNamed) args.all = true;
      if (readers?.length) args.readers = readers;
      if (displays?.length) args.displays = displays;
      if (executors?.length) args.executors = executors;
      if (sequences?.length) args.sequences = sequences;
      if (fader_tokens?.length) args.tokens = fader_tokens;
      try {
        const raw = await bridge.request("feedback.read", args);
        return json(normaliseResult(raw));
      } catch (err) {
        return bridgeFailure(err);
      }
    },
  );
};
