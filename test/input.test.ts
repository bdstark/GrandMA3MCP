import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { BridgeReplyError } from "./helpers/fake-bridge.ts";
import { registerInputTools, textPolicyError } from "../src/tools/input.ts";

/**
 * KB-05 input tools over a scripted FakeBridge. The Lua harnesses prove dispatch, ownership,
 * admission and recovery; these tests prove that the TypeScript wrappers send exactly the
 * documented ops and arguments, wait for a sequence without replaying it, keep the bridge's
 * structured errors and partial progress, and report through the shared outcome model.
 */

let h: Harness;
before(async () => {
  h = await startHarness(registerInputTools, { requestTimeoutMs: 400 });
});
after(async () => h.close());

const sessionOk = { id: "conn-1", state: "active", leaseMs: 60000, remainingMs: 60000 };
function withSession(opts: { open?: boolean } = {}) {
  if (opts.open) {
    let opened = false;
    h.fake.on("input.renew", () => {
      if (!opened) throw new Error("[no-session] this connection has no input session; call input.open first");
      return { session: sessionOk };
    });
    h.fake.on("input.open", () => {
      opened = true;
      return { session: sessionOk, inputEnabled: true, backend: "keyboard" };
    });
  } else {
    h.fake.on("input.renew", () => ({ session: sessionOk }));
  }
}

const report = (events: Array<Record<string, unknown>>, state: string, extra: Record<string, unknown> = {}) => ({
  id: "q1",
  session: "conn-1",
  interaction: "i1",
  autoInteraction: true,
  state,
  steps: events.length,
  index: events.length,
  counts: {},
  events: events.map((e, i) => ({ index: i + 1, ...e })),
  cleanup: { attempted: 0, released: 0, unresolved: 0 },
  estimateMs: 100,
  ...extra,
});

/** Script input.sequence to return `first` and input.sequence.status to walk through `polls`. */
function scriptSequence(first: Record<string, unknown>, polls: Array<Record<string, unknown>> = []) {
  let i = 0;
  h.fake.on("input.sequence", () => first);
  h.fake.on("input.sequence.status", () => polls[Math.min(i++, polls.length - 1)] ?? first);
}

beforeEach(() => {
  h.fake.reset();
  h.bridge.close();
});

// ---------------------------------------------------------------------------
// Taps and sequences
// ---------------------------------------------------------------------------

test("a tap opens the session on demand, runs a one-step sequence and reports after the release was attempted", async () => {
  withSession({ open: true });
  const tap = { kind: "tap", key: "STORE", state: "waiting", hold: "h1", holdMs: 100 };
  scriptSequence(report([tap], "running"), [report([tap], "running"), report([{ ...tap, state: "completed", releaseOutcome: "dispatched" }], "completed", { elapsedMs: 120 })]);
  const { result, isError } = await h.callJson("gma3_hardkey", { action: "tap", key: "STORE", hold_ms: 100 });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.verification.status, "unavailable");
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].status, "succeeded");
  assert.equal(result.steps[0].detail.releaseOutcome, "dispatched");
  assert.equal(result.sequence.state, "completed");
  assert.deepEqual(
    h.fake.requests.map((r) => r.op),
    ["input.renew", "input.open", "input.sequence", "input.sequence.status", "input.sequence.status"],
    "renew (no session) -> open -> start -> poll until no longer running",
  );
  const start = h.fake.requests.find((r) => r.op === "input.sequence")!;
  assert.deepEqual(start.args.steps, [{ kind: "tap", key: "STORE", holdMs: 100 }]);
  assert.equal(start.args.interaction, undefined);
  assert.match(result.summary, /succeeded/);
  assert.match(result.summary, /read-back unavailable/);
});

test("an MA tap whose aggregate MASTATE readback was observed is matched, worded as aggregate", async () => {
  withSession();
  const ev = { kind: "tap", key: "MA", state: "completed", hold: "h1", releaseOutcome: "dispatched", readback: { outcome: "observed", source: "MASTATE", phase: "release", value: false, note: "MASTATE false after the release: no Shift key is down (aggregate; consistent with the release, not a per-key confirmation)" } };
  scriptSequence(report([ev], "completed"));
  const { result, isError } = await h.callJson("gma3_hardkey", { action: "tap", key: "MA" });
  assert.equal(isError, false);
  assert.equal(result.verification.status, "matched");
  assert.match(result.verification.checked, /MASTATE/);
  assert.match(result.verification.detail, /not a per-key confirmation/);
});

test("a chord tap sends a combo step with the keys in order", async () => {
  withSession();
  scriptSequence(report([{ kind: "combo", keys: ["MA", "STORE"], state: "completed", holds: ["h1", "h2"], releaseOutcome: "dispatched,dispatched" }], "completed"));
  const { result, isError } = await h.callJson("gma3_hardkey", { action: "tap", keys: ["MA", "STORE"], hold_ms: 150, interaction: "i7" });
  assert.equal(isError, false, JSON.stringify(result));
  const start = h.fake.requests.find((r) => r.op === "input.sequence")!;
  assert.deepEqual(start.args.steps, [{ kind: "combo", keys: [{ key: "MA" }, { key: "STORE" }], holdMs: 150 }]);
  assert.equal(start.args.interaction, "i7");
  assert.equal(result.steps[0].name, "1:combo MA+STORE");
});

test("a sequence maps every step kind to the bridge's spec and reports completed, failed and skipped steps", async () => {
  withSession();
  scriptSequence(
    report(
      [
        { kind: "combo", keys: ["MA", "STORE"], state: "completed", releaseOutcome: "dispatched,dispatched" },
        { kind: "wait", ms: 100, state: "completed" },
        { kind: "text", chars: 9, typed: 8, remaining: 1, state: "failed", code: "context-changed", error: "context changed after 8 of 9 characters: keyboard shortcuts are now true (were false)" },
        { kind: "press", pcKey: "F1", state: "unattempted", error: "not attempted: the sequence failed earlier" },
        { kind: "release", pcKey: "F1", state: "unattempted", error: "not attempted: the sequence failed earlier" },
      ],
      "failed",
      { failedStep: 3, error: "step 3 (text) failed: context changed", cleanup: { attempted: 0, released: 0, unresolved: 0 } },
    ),
  );
  const { result, isError } = await h.callJson("gma3_input_sequence", {
    steps: [
      { kind: "combo", keys: [{ key: "MA" }, { key: "STORE" }], hold_ms: 150 },
      { kind: "wait", ms: 100 },
      { kind: "text", text: "Fixture 5", context: "command-line", acknowledge_focus: true },
      { kind: "press", pc_key: "F1", ctrl: true },
      { kind: "release", pc_key: "F1", ctrl: true },
    ],
    lease_ms: 20000,
    label: "demo",
  });
  assert.equal(isError, true);
  assert.equal(result.outcome, "partial");
  assert.deepEqual(
    result.steps.map((s: { status: string }) => s.status),
    ["succeeded", "succeeded", "failed", "skipped", "skipped"],
  );
  assert.equal(result.steps[2].detail.typed, 8);
  assert.match(result.steps[2].error, /context changed after 8 of 9/);
  assert.match(result.summary, /not attempted: 4:press F1, 5:release F1/);
  const start = h.fake.requests.find((r) => r.op === "input.sequence")!;
  assert.deepEqual(start.args, {
    steps: [
      { kind: "combo", keys: [{ key: "MA" }, { key: "STORE" }], holdMs: 150 },
      { kind: "wait", ms: 100 },
      { kind: "text", text: "Fixture 5", context: "command-line", acknowledgeFocus: true },
      { kind: "press", pcKey: "F1", ctrl: true },
      { kind: "release", pcKey: "F1", ctrl: true },
    ],
    leaseMs: 20000,
    label: "demo",
  });
});

test("an uncertain step (dispatch raised) is unknown, and the sequence's unresolved cleanup is a warning", async () => {
  withSession();
  scriptSequence(
    report(
      [
        { kind: "press", key: "MA", state: "completed", pressOutcome: "dispatched" },
        { kind: "tap", key: "STORE", state: "uncertain", hold: "h2", code: "press-failed", error: "[press-failed] press raised an error: host blocked" },
      ],
      "failed",
      { failedStep: 2, cleanup: { attempted: 1, released: 0, unresolved: 1, unresolvedHolds: ["h1"] } },
    ),
  );
  const { result } = await h.callJson("gma3_input_sequence", { steps: [{ kind: "press", key: "MA" }, { kind: "tap", key: "STORE" }] });
  assert.equal(result.outcome, "partial");
  assert.equal(result.steps[1].status, "unknown");
  assert.match(result.warnings.join(" "), /1 key\(s\) pressed by the sequence could not be released/);
});

test("a sequence still running when the wait ends is reported unknown with a warning and is neither aborted nor resent", async () => {
  withSession();
  const running = report([{ kind: "tap", key: "STORE", state: "waiting", hold: "h1", holdMs: 10 }], "running");
  scriptSequence(running, [running]);
  const { result, isError } = await h.callJson("gma3_hardkey", { action: "tap", key: "STORE", hold_ms: 10 });
  assert.equal(isError, true);
  assert.equal(result.outcome, "unknown");
  assert.equal(result.steps[0].status, "unknown");
  assert.match(result.steps[0].error, /still waiting on the console/);
  assert.match(result.warnings[0], /never replayed/);
  assert.equal(h.fake.requests.filter((r) => r.op === "input.sequence").length, 1, "started exactly once");
  assert.equal(h.fake.requests.some((r) => r.op === "input.sequence.abort"), false);
  assert.ok(h.fake.requests.filter((r) => r.op === "input.sequence.status").length >= 2, "polled while waiting");
});

test("a sequence the bridge refuses before dispatch is a failed first step with the structured detail", async () => {
  withSession();
  h.fake.on("input.sequence", () => {
    throw new BridgeReplyError("[busy] cannot start a sequence: interaction i3 of session 'conn-9' is open", "busy", { code: "busy", reason: "interaction", owner: "conn-9", interaction: "i3" });
  });
  const { result } = await h.callJson("gma3_input_sequence", { steps: [{ kind: "tap", key: "PLEASE" }] });
  assert.equal(result.outcome, "failed");
  assert.equal(result.steps[0].status, "failed");
  assert.equal(result.steps[0].detail.code, "busy");
  assert.equal(result.steps[0].detail.owner, "conn-9");
});

test("sequence arguments are validated before any request", async () => {
  withSession();
  let r = await h.callJson("gma3_input_sequence", { steps: [{ kind: "tap", key: "EXEC" }] });
  assert.equal(r.result.outcome, "failed");
  assert.match(r.result.validationErrors[0], /EXEC needs executor/);
  r = await h.callJson("gma3_input_sequence", { steps: [{ kind: "tap", key: "STORE", shift: true }] });
  assert.match(r.result.validationErrors[0], /modifiers of a logical key/);
  r = await h.callJson("gma3_input_sequence", { steps: [{ kind: "text", text: "a\tb", context: "command-line", acknowledge_focus: true }] });
  assert.match(r.result.validationErrors[0], /tab/);
  r = await h.callJson("gma3_input_sequence", { steps: [{ kind: "text", text: "ab", context: "text-field" }] });
  assert.match(r.result.validationErrors[0], /acknowledge_focus/);
  r = await h.callJson("gma3_input_sequence", { steps: [{ kind: "text", text: "ab", context: "command-line" }] });
  assert.match(r.result.validationErrors[0], /acknowledge_focus/);
  r = await h.callJson("gma3_input_sequence", { steps: [{ kind: "tap" }] });
  assert.match(r.result.validationErrors[0], /key \(logical\) or pc_key \(raw\) is required/);
  assert.equal(h.fake.requests.length, 0, "nothing was sent");
});

// ---------------------------------------------------------------------------
// Holds: press and release
// ---------------------------------------------------------------------------

test("a standalone press without an interaction is refused before any request", async () => {
  withSession();
  const { result, isError } = await h.callJson("gma3_hardkey", { action: "press", key: "STORE" });
  assert.equal(isError, true);
  assert.equal(result.outcome, "failed");
  assert.match(result.validationErrors[0], /needs an interaction/);
  assert.equal(h.fake.requests.length, 0);
});

test("a press with an interaction sends input.press with the id and reports the hold without claiming an effect", async () => {
  withSession();
  h.fake.on("input.press", (args) => ({ hold: { id: "h4", state: "held", logical: "STORE", pcKey: "S", interaction: args.interaction, pressOutcome: "dispatched", releaseOutcome: "pending" } }));
  const { result, isError } = await h.callJson("gma3_hardkey", { action: "press", key: "STORE", interaction: "i1" });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.verification.status, "unavailable");
  assert.equal(result.hold, "h4");
  assert.match(result.warnings[0], /\[busy\]/);
  const press = h.fake.requests.find((r) => r.op === "input.press")!;
  assert.deepEqual(press.args, { key: "STORE", interaction: "i1" });
});

test("a raw key press passes the modifiers explicitly", async () => {
  withSession();
  h.fake.on("input.press", (args) => ({ hold: { id: "h5", state: "held", pcKey: args.pcKey, ctrl: args.ctrl } }));
  const { isError } = await h.callJson("gma3_keyboard", { action: "press", pc_key: "F1", ctrl: true, interaction: "i1" });
  assert.equal(isError, false);
  assert.deepEqual(h.fake.requests.find((r) => r.op === "input.press")!.args, { pcKey: "F1", ctrl: true, interaction: "i1" });
});

test("a busy refusal is a failed step carrying the owner, and a refused combo that pressed keys is unknown", async () => {
  withSession();
  h.fake.on("input.press", () => {
    throw new BridgeReplyError("[busy] interaction i1 of session 'conn-2' is open (4000 ms left)", "busy", { code: "busy", reason: "interaction", owner: "conn-2", interaction: "i1", remainingMs: 4000 });
  });
  let r = await h.callJson("gma3_hardkey", { action: "press", key: "STORE", interaction: "i9" });
  assert.equal(r.result.outcome, "failed");
  assert.equal(r.result.steps[0].detail.code, "busy");
  assert.equal(r.result.steps[0].detail.owner, "conn-2");

  h.fake.on("input.combo", () => {
    throw new BridgeReplyError("[press-failed] key 2 of the combo: press was refused by the backend: refused; 1 key(s) pressed before it were released (1 released, 0 unresolved)", "press-failed", {
      code: "press-failed",
      key: 2,
      pressed: [{ id: "h1", pcKey: "LeftShift", state: "released" }],
      rollback: { released: [{ hold: "h1" }], unresolved: [] },
    });
  });
  r = await h.callJson("gma3_hardkey", { action: "press", keys: ["MA", "PLEASE"], interaction: "i1" });
  assert.equal(r.result.outcome, "unknown");
  assert.match(r.result.steps[0].error, /1 key\(s\) were pressed before the failure/);
  assert.equal(r.result.steps[0].detail.pressed.length, 1);

  h.fake.on("input.press", () => {
    throw new BridgeReplyError("[press-failed] press raised an error: host blocked", "press-failed", { code: "press-failed", hold: "h3", unresolved: true });
  });
  r = await h.callJson("gma3_keyboard", { action: "press", pc_key: "Z", interaction: "i1" });
  assert.equal(r.result.outcome, "unknown", "a raised press may have reached the console");
  assert.equal(r.result.steps[0].detail.hold, "h3");
});

test("release reports dispatched as succeeded, unresolved as unknown, already released as harmless", async () => {
  withSession();
  h.fake.on("input.release", (args) => ({ hold: { id: "h4", state: "released", logical: args.key, releaseOutcome: "dispatched", attempt: { verified: false } } }));
  let r = await h.callJson("gma3_hardkey", { action: "release", key: "STORE" });
  assert.equal(r.isError, false, JSON.stringify(r.result));
  assert.equal(r.result.verification.status, "unavailable");
  assert.match(r.result.verification.detail, /dispatched, not confirmed/);

  h.fake.on("input.release", () => ({ hold: { id: "h4", state: "unresolved", logical: "STORE", releaseOutcome: "unresolved", unresolved: { reason: "route changed during the hold" } } }));
  r = await h.callJson("gma3_hardkey", { action: "release", key: "STORE" });
  assert.equal(r.isError, true);
  assert.equal(r.result.outcome, "unknown");
  assert.match(r.result.steps[0].error, /route changed/);

  h.fake.on("input.release", () => ({ hold: { id: "h4", state: "released", logical: "STORE", alreadyReleased: true } }));
  r = await h.callJson("gma3_hardkey", { action: "release", key: "STORE" });
  assert.equal(r.result.outcome, "succeeded");
  assert.match(r.result.steps[0].detail.note, /already released/);
});

test("releasing a combination goes newest first and stops at an unresolved key", async () => {
  withSession();
  h.fake.on("input.release", (args) => ({ hold: { id: args.key, state: "released", logical: args.key, releaseOutcome: "dispatched", readback: args.key === "MA" ? { outcome: "observed", value: false, note: "aggregate" } : undefined } }));
  const r = await h.callJson("gma3_hardkey", { action: "release", keys: ["MA", "STORE"] });
  assert.deepEqual(
    h.fake.requests.filter((q) => q.op === "input.release").map((q) => q.args.key),
    ["STORE", "MA"],
  );
  assert.equal(r.result.verification.status, "matched");
  assert.match(r.result.verification.checked, /aggregate MASTATE/);
});

test("after a reconnect a stale interaction id is refused by the bridge and nothing is resumed", async () => {
  withSession({ open: true });
  h.fake.on("input.press", (args) => {
    if (args.interaction === "i1") throw new BridgeReplyError("[no-interaction] interaction 'i1' is not open; an interaction is never resumed", "no-interaction", { code: "no-interaction", interaction: "i1" });
    return { hold: { id: "h1", state: "held" } };
  });
  const r = await h.callJson("gma3_hardkey", { action: "press", key: "STORE", interaction: "i1" });
  assert.equal(r.result.outcome, "failed");
  assert.equal(r.result.steps[0].detail.code, "no-interaction");
  assert.deepEqual(h.fake.requests.map((q) => q.op), ["input.renew", "input.open", "input.press"]);
});

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

test("the text policy refuses control characters and unpaired surrogates without a round trip", () => {
  assert.equal(textPolicyError("Fixture 5"), null);
  assert.equal(textPolicyError("abü€😀"), null);
  assert.match(textPolicyError("Fixture 5\n")!, /character 10 is a newline/);
  assert.match(textPolicyError("a\tb")!, /tab/);
  assert.match(textPolicyError("a\u0085b")!, /control character \(U\+0085\)/);
  assert.match(textPolicyError("a b")!, /separator/);
  assert.match(textPolicyError("a\uD800b")!, /surrogate/);
  assert.match(textPolicyError("x".repeat(257))!, /257 characters/);
});

test("gma3_type sends one text step, requires the focus acknowledgment for a text field and reports the command-line readback", async () => {
  withSession();
  let r = await h.callJson("gma3_type", { text: "Fixture 5\n", context: "command-line", acknowledge_focus: true });
  assert.equal(r.result.outcome, "failed");
  assert.match(r.result.validationErrors[0], /newline/);
  r = await h.callJson("gma3_type", { text: "name", context: "text-field" });
  assert.match(r.result.validationErrors[0], /acknowledge_focus/);
  r = await h.callJson("gma3_type", { text: "Fixture 5", context: "command-line" });
  assert.match(r.result.validationErrors[0], /acknowledge_focus/);
  assert.equal(h.fake.requests.length, 0);

  scriptSequence(report([{ kind: "text", chars: 9, typed: 9, remaining: 0, context: "command-line", state: "completed", readback: { outcome: "observed", source: "CmdObj().cmdtext", expected: "Fixture 5", actual: "Fixture 5", note: "the command line shows the typed text; not executed" } }], "completed"));
  r = await h.callJson("gma3_type", { text: "Fixture 5", context: "command-line", acknowledge_focus: true });
  assert.equal(r.isError, false, JSON.stringify(r.result));
  assert.equal(r.result.verification.status, "matched");
  assert.deepEqual(h.fake.requests.find((q) => q.op === "input.sequence")!.args.steps, [{ kind: "text", text: "Fixture 5", context: "command-line", acknowledgeFocus: true }]);

  scriptSequence(report([{ kind: "text", chars: 4, typed: 4, remaining: 0, context: "text-field", state: "completed", readback: { outcome: "unavailable", reason: "a focused text field's content is not observable from Lua; UI verification unavailable" } }], "completed"));
  r = await h.callJson("gma3_type", { text: "name", context: "text-field", acknowledge_focus: true, display: 1 });
  assert.equal(r.result.outcome, "succeeded");
  assert.equal(r.result.verification.status, "unavailable");
  assert.match(r.result.verification.detail, /not observable/);
  assert.deepEqual(h.fake.requests.filter((q) => q.op === "input.sequence").pop()!.args.steps, [{ kind: "text", text: "name", context: "text-field", acknowledgeFocus: true, display: 1 }]);

  scriptSequence(report([{ kind: "text", chars: 10, typed: 8, remaining: 2, context: "command-line", state: "uncertain", uncertainChar: 9, code: "char-raised", error: "character 9 of 10 (U+0038) raised: host blocked; whether it was delivered is unknown, typing stopped" }], "failed"));
  r = await h.callJson("gma3_type", { text: "0123456789", context: "command-line", acknowledge_focus: true });
  assert.equal(r.result.outcome, "unknown");
  assert.equal(r.result.steps[0].detail.typed, 8);

  scriptSequence(report([{ kind: "text", chars: 2, typed: 2, remaining: 0, context: "command-line", state: "uncertain", code: "text-unverified", error: "2 characters were dispatched but the command line does not show them", readback: { outcome: "inconclusive", source: "CmdObj().cmdtext", expected: "ab", actual: "zz" } }], "failed"));
  r = await h.callJson("gma3_type", { text: "ab", context: "command-line", acknowledge_focus: true });
  assert.equal(r.result.outcome, "unknown", "typed but not seen on the command line is unknown, never a success");
  assert.equal(r.result.verification.status, "unavailable");
});

// ---------------------------------------------------------------------------
// Interaction, status, release all, serialisation
// ---------------------------------------------------------------------------

test("gma3_input_interaction acquires, renews and ends through the bridge ops", async () => {
  h.fake.on("input.begin", (args) => ({ interaction: { id: "i1", session: "conn-1", leaseMs: args.leaseMs ?? 15000, state: "open" }, session: "conn-1", inputEnabled: true, backend: "keyboard" }));
  h.fake.on("input.extend", (args) => ({ interaction: { id: args.interaction, renewals: 1, leaseMs: args.leaseMs } }));
  h.fake.on("input.end", () => ({ interaction: "i1", state: "ended", attempted: 2, released: [{ hold: "h2", logical: "STORE", outcome: "dispatched" }], unresolved: [{ hold: "h1", logical: "MA", error: "release refused by the backend: wedged" }] }));
  let r = await h.callJson("gma3_input_interaction", { action: "acquire", lease_ms: 30000, label: "store" });
  assert.equal(r.isError, false);
  assert.equal(r.result.interaction.id, "i1");
  assert.match(r.result.note, /\[busy\]/);
  assert.deepEqual(h.fake.requests[0].args, { leaseMs: 30000, label: "store" });
  r = await h.callJson("gma3_input_interaction", { action: "renew", interaction: "i1", lease_ms: 5000 });
  assert.equal(r.result.interaction.renewals, 1);
  r = await h.callJson("gma3_input_interaction", { action: "renew" });
  assert.equal(r.isError, true);
  r = await h.callJson("gma3_input_interaction", { action: "end", interaction: "i1" });
  assert.equal(r.isError, true, "an unresolved release is not a success");
  assert.equal(r.result.outcome, "partial");
  assert.deepEqual(r.result.steps.map((s: { name: string; status: string }) => [s.name, s.status]), [["release STORE", "succeeded"], ["release MA", "unknown"]]);
  h.fake.on("input.begin", () => {
    throw new Error('[input-disabled] input is disabled on the console. The console operator can enable it with:  Plugin "gma3_mcp_bridge" "input=keyboard"');
  });
  r = await h.callJson("gma3_input_interaction", { action: "acquire" });
  assert.equal(r.isError, true);
  assert.equal(r.result.code, "input-disabled");
});

test("gma3_hardkeys_status is a plain read of input.status", async () => {
  h.fake.on("input.status", () => ({ policy: { enabled: false, backend: null, holds: 0 }, status: { inputEnabled: false, busy: null } }));
  const r = await h.callJson("gma3_hardkeys_status", {});
  assert.equal(r.isError, false);
  assert.equal(r.result.policy.enabled, false);
  assert.deepEqual(h.fake.requests.map((q) => q.op), ["input.status"]);
});

test("gma3_hardkeys_release_all releases this session's keys and optionally recovers, reporting unresolved ones as unknown", async () => {
  withSession();
  h.fake.on("input.releaseAll", () => ({ attempted: 2, released: [{ hold: "h2", logical: "STORE", outcome: "dispatched" }], unresolved: [{ hold: "h1", tupleKey: "Q|s0c1a0n0", error: "release refused by the backend: wedged" }] }));
  h.fake.on("input.recover", () => ({ attempted: 1, released: [{ hold: "h1", tupleKey: "Q|s0c1a0n0", outcome: "dispatched" }], unresolved: [], scope: "conn-1" }));
  let r = await h.callJson("gma3_hardkeys_release_all", { recover: true });
  assert.deepEqual(h.fake.requests.map((q) => q.op), ["input.renew", "input.releaseAll", "input.recover"]);
  assert.equal(r.result.outcome, "partial");
  assert.deepEqual(r.result.steps.map((s: { status: string }) => s.status), ["succeeded", "unknown", "succeeded"]);
  h.fake.on("input.releaseAll", () => ({ attempted: 0, released: [], unresolved: [] }));
  r = await h.callJson("gma3_hardkeys_release_all", {});
  assert.equal(r.isError, false);
  assert.equal(r.result.outcome, "succeeded");
});

test("input tools take the server's mutation lock: two taps never overlap at the bridge", async () => {
  withSession();
  let inFlight = 0;
  let maxInFlight = 0;
  h.fake.on("input.sequence", async (args) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 40));
    inFlight--;
    return report([{ kind: "tap", key: (args.steps as Array<{ key: string }>)[0].key, state: "completed", releaseOutcome: "dispatched" }], "completed");
  });
  const [a, b] = await Promise.all([h.callJson("gma3_hardkey", { action: "tap", key: "STORE" }), h.callJson("gma3_hardkey", { action: "tap", key: "PLEASE" })]);
  assert.equal(a.isError, false);
  assert.equal(b.isError, false);
  assert.equal(maxInFlight, 1);
  assert.deepEqual(
    h.fake.requests.filter((q) => q.op === "input.sequence").map((q) => (q.args.steps as Array<{ key: string }>)[0].key),
    ["STORE", "PLEASE"],
  );
});

test("tool descriptions carry the gate, the busy rule and the verification scope", () => {
  for (const name of ["gma3_hardkey", "gma3_keyboard", "gma3_type", "gma3_input_sequence"]) {
    const d = h.tools.get(name)!.description!;
    assert.match(d, /input=keyboard/, `${name} names the console-side enable command`);
    assert.match(d, /\[busy\]/, `${name} states the busy rule`);
    assert.match(d, /retr|replay/i, `${name} states that nothing is retried`);
  }
  assert.match(h.tools.get("gma3_hardkey")!.description!, /not display-scoped/);
  assert.match(h.tools.get("gma3_type")!.description!, /NEVER presses Enter/);
  assert.match(h.tools.get("gma3_hardkeys_release_all")!.description!, /input recover/);
});
