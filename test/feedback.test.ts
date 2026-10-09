import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { BridgeReplyError } from "./helpers/fake-bridge.ts";
import { registerFeedbackTools, normaliseItem, normaliseResult, FEEDBACK_READERS } from "../src/tools/feedback.ts";

/**
 * KB-06 feedback tool over a scripted FakeBridge. The Lua harnesses prove the readers, the value
 * contract, displays, bounds and freshness; these tests prove that the TypeScript wrapper sends
 * exactly the documented op and arguments, never fills in a value the console did not supply, keeps
 * partial failures per item and reports the bridge's own refusals.
 */

let h: Harness;
before(async () => {
  h = await startHarness(registerFeedbackTools, { requestTimeoutMs: 400 });
});
after(async () => h.close());
beforeEach(() => {
  h.fake.reset();
  h.bridge.close();
});

const item = (name: string, extra: Record<string, unknown>) => ({ name, key: name, scope: "show", source: "src", observedAt: 12.5, epoch: 1, ...extra });
const reply = (items: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
  observedAt: 12.5,
  epoch: 1,
  atomic: false,
  identity: { showFile: "mcp-test-disposable", user: "Admin", profile: "Default" },
  items,
  count: items.length,
  truncated: 0,
  limitations: [],
  bridgeVersion: "0.8.0",
  module: { component: "gma3_mcp_feedback", version: "0.2.0" },
  ...extra,
});

test("no arguments reads every parameterless reader through feedback.read {all:true}", async () => {
  h.fake.on("feedback.read", () => reply([item("blind", { available: true, value: true }), item("freeze", { available: false, reason: "no readable Freeze state was found in KB-01; this is not a false value" })]));
  const { result, isError } = await h.callJson("gma3_feedback", {});
  assert.equal(isError, false, JSON.stringify(result));
  assert.deepEqual(h.fake.requests.map((r) => r.op), ["feedback.read"]);
  assert.deepEqual(h.fake.requests[0].args, { all: true });
  assert.equal(result.context.atomic, false);
  assert.equal(result.context.epoch, 1);
  assert.equal(result.context.identity.showFile, "mcp-test-disposable");
  assert.equal(result.context.bridgeVersion, "0.8.0");
  assert.equal(result.byKey.blind.value, true);
  assert.equal(result.byKey.freeze.available, false);
  assert.equal(result.byKey.freeze.value, null, "unavailable is an explicit null, never false");
  assert.match(result.byKey.freeze.reason, /KB-01/);
  assert.match(result.note, /not an atomic snapshot/);
});

test("a false observation stays false and available, an unavailable one is null with its reason", async () => {
  h.fake.on("feedback.read", () => reply([item("solo", { available: true, value: false }), item("blind", { available: false, reason: "unrecognised value Maybe (string) is reported as unavailable, not as false" })]));
  const { result } = await h.callJson("gma3_feedback", { readers: ["solo", "blind"] });
  assert.equal(result.byKey.solo.available, true);
  assert.equal(result.byKey.solo.value, false);
  assert.equal(result.byKey.blind.available, false);
  assert.equal(result.byKey.blind.value, null);
  assert.match(result.byKey.blind.reason, /unrecognised value/);
  assert.deepEqual(h.fake.requests[0].args, { readers: ["solo", "blind"] });
});

test("one failing reader is reported per item and does not affect the others", async () => {
  h.fake.on("feedback.read", () =>
    reply([
      item("commandText", { scope: "ui", available: false, error: "CmdObj unavailable in this context" }),
      item("maState", { scope: "console", available: true, value: false, note: "aggregate MA state of every Shift source (observed state, not ownership)" }),
      item("lastCommand", { scope: "ui", available: true, value: "Go+ Sequence 5 : OK", note: "observation of shared command history, not confirmation of a particular request or client" }),
    ]),
  );
  const { result, isError } = await h.callJson("gma3_feedback", { readers: ["commandText", "maState", "lastCommand"] });
  assert.equal(isError, false);
  assert.equal(result.byKey.commandText.available, false);
  assert.match(result.byKey.commandText.error, /CmdObj unavailable/);
  assert.equal(result.byKey.commandText.value, null);
  assert.equal(result.byKey.maState.value, false);
  assert.match(result.byKey.maState.note, /not ownership/);
  assert.match(result.byKey.lastCommand.note, /not confirmation/);
  assert.equal(result.context.count, 3);
});

test("displays, executors, sequences and fader tokens travel to the bridge and come back keyed per target", async () => {
  h.fake.on("feedback.read", () =>
    reply(
      [
        { ...item("previewBar", { available: true, value: false }), key: "previewBar[display=1]", scope: "display", params: { display: 1 } },
        { ...item("previewBar", { available: true, value: true }), key: "previewBar[display=2]", scope: "display", params: { display: 2 } },
        { ...item("previewBar", { available: false, reason: "display 9 does not exist on this console" }), key: "previewBar[display=9]", scope: "display", params: { display: 9 } },
        { ...item("executor", { available: true, value: { executor: 201, empty: false, assigned: { name: "Main", class: "Sequence", no: 5 }, page: { name: "Page 1", no: 1 } } }), key: "executor[executor=201]", scope: "page", params: { executor: 201 } },
        { ...item("fader", { available: true, value: { token: "FaderMaster", value: 100, text: "100", target: { name: "Main" } } }), key: "fader[executor=201]", params: { executor: 201, token: "FaderMaster" } },
        { ...item("fader", { available: false, error: "GetFader failed: unknown token" }), key: "fader[executor=201,token=SpeedMaster]", params: { executor: 201, token: "SpeedMaster" } },
        { ...item("sequenceActive", { available: true, value: false, note: "sequence playback activity; not proof that a particular executor caused it or that a button is held" }), key: "sequenceActive[sequence=5]", params: { sequence: 5 } },
      ],
      { limitations: ["sequences truncated to 32 of 33"] },
    ),
  );
  const { result, isError } = await h.callJson("gma3_feedback", { readers: ["previewBar"], displays: [1, 2, 9], executors: [201], sequences: [5], fader_tokens: ["FaderMaster", "SpeedMaster"] });
  assert.equal(isError, false, JSON.stringify(result));
  assert.deepEqual(h.fake.requests[0].args, { readers: ["previewBar"], displays: [1, 2, 9], executors: [201], sequences: [5], tokens: ["FaderMaster", "SpeedMaster"] });
  assert.equal(result.byKey["previewBar[display=2]"].value, true);
  assert.equal(result.byKey["previewBar[display=9]"].available, false);
  assert.equal(result.byKey["previewBar[display=9]"].params.display, 9);
  assert.equal(result.byKey["executor[executor=201]"].value.assigned.name, "Main");
  assert.equal(result.byKey["fader[executor=201]"].value.value, 100);
  assert.equal(result.byKey["fader[executor=201,token=SpeedMaster]"].value, null);
  assert.equal(result.byKey["sequenceActive[sequence=5]"].value, false);
  assert.match(result.byKey["sequenceActive[sequence=5]"].note, /not proof/);
  assert.deepEqual(result.limitations, ["sequences truncated to 32 of 33"]);
  assert.equal(result.items.length, 7);
});

test("an invalidation reported by the bridge (show change) is surfaced in the context", async () => {
  h.fake.on("feedback.read", () => reply([item("page", { available: true, value: { name: "Page 2", no: 2 } })], { epoch: 3, invalidated: "show-changed", identity: { showFile: "other" } }));
  const { result } = await h.callJson("gma3_feedback", { readers: ["page"] });
  assert.equal(result.context.epoch, 3);
  assert.equal(result.context.invalidated, "show-changed");
  assert.equal(result.context.identity.showFile, "other");
  assert.equal(result.byKey.page.value.no, 2);
});

test("an unreadable identity is surfaced on the invalidating call and on every later call while it stays unverified", async () => {
  const replies = [
    reply([item("blind", { available: true, value: true, epoch: 2 })], { epoch: 2, invalidated: "identity-unreadable", identityUncertain: ["showFile"] }),
    reply([item("blind", { available: true, value: true, epoch: 2 })], { epoch: 2, identityUncertain: ["showFile"] }),
    reply([item("blind", { available: true, value: true, epoch: 3 })], { epoch: 3, invalidated: "show-changed", identity: { showFile: "show-B", user: "Admin", profile: "Default" } }),
  ];
  let i = 0;
  h.fake.on("feedback.read", () => replies[i++]);
  const first = (await h.callJson("gma3_feedback", { readers: ["blind"] })).result;
  assert.equal(first.context.invalidated, "identity-unreadable");
  assert.deepEqual(first.context.identityUncertain, ["showFile"]);
  assert.equal(first.context.identity.showFile, "mcp-test-disposable", "the last known value is still reported");
  assert.match(first.limitations.join("\n"), /identity unverified: showFile/);
  const second = (await h.callJson("gma3_feedback", { readers: ["blind"] })).result;
  assert.equal(second.context.invalidated, null, "no new invalidation on the second call");
  assert.deepEqual(second.context.identityUncertain, ["showFile"], "the continuing uncertainty is still reported");
  assert.match(second.limitations.join("\n"), /may not be current/);
  const third = (await h.callJson("gma3_feedback", { readers: ["blind"] })).result;
  assert.equal(third.context.identityUncertain, null);
  assert.equal(third.context.invalidated, "show-changed");
  assert.equal(third.context.identity.showFile, "show-B");
  assert.deepEqual(third.limitations, []);
});

test("an oversized or duplicated target list is refused before any request", async () => {
  const many = Array.from({ length: 33 }, (_, i) => 101 + i);
  let res = await h.callJson("gma3_feedback", { executors: many });
  assert.equal(res.isError, true);
  assert.match(res.text, /validation failed/);
  res = await h.callJson("gma3_feedback", { sequences: [1, 1] });
  assert.equal(res.isError, true);
  assert.match(res.text, /duplicates/);
  res = await h.callJson("gma3_feedback", { displays: [0] });
  assert.equal(res.isError, true);
  res = await h.callJson("gma3_feedback", { readers: ["executorActive" as any] });
  assert.equal(res.isError, true, "the deprecated alias is not offered by the tool");
  assert.equal(h.fake.requests.length, 0, "nothing was sent");
});

test("an old bridge without the op and a bridge without the module are reported, nothing is read", async () => {
  h.fake.on("feedback.read", () => {
    throw new Error("unknown op 'feedback.read'");
  });
  let res = await h.callJson("gma3_feedback", {});
  assert.equal(res.isError, true);
  assert.match(res.text, /plugin 0\.8\.0 or newer/);
  h.fake.reset();
  h.fake.on("feedback.read", () => {
    throw new BridgeReplyError("[no-feedback] the feedback module is not loaded: simulated", "no-feedback");
  });
  res = await h.callJson("gma3_feedback", {});
  assert.equal(res.isError, true);
  assert.match(res.text, /did not load/);
  h.fake.reset();
  h.fake.on("feedback.read", () => {
    throw new BridgeReplyError("[no-items] nothing to read", "no-items");
  });
  res = await h.callJson("gma3_feedback", {});
  assert.equal(res.isError, true);
  assert.match(res.text, /no-items/);
});

test("the tool never takes the mutation lock and never sends an input op", async () => {
  h.fake.on("feedback.read", () => reply([item("blind", { available: true, value: true })]));
  let release!: () => void;
  const held = h.ctx.mutations.run(() => new Promise<void>((resolve) => { release = resolve; }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.ctx.mutations.busy, true);
  const { isError } = await h.callJson("gma3_feedback", { readers: ["blind"] });
  assert.equal(isError, false, "a read must not wait for the mutation lock");
  release();
  await held;
  assert.deepEqual(h.fake.requests.map((r) => r.op), ["feedback.read"]);
});

test("normalisation never invents values and keeps unknown fields out of the contract", () => {
  const it = normaliseItem({ name: "blind", available: false });
  assert.equal(it.value, null);
  assert.match(it.reason!, /without a reason/);
  const it2 = normaliseItem({ name: "x", key: "x", available: true });
  assert.equal(it2.value, null, "available without a value field is still null, not undefined");
  const res = normaliseResult({ items: "nope" });
  assert.deepEqual(res.items, []);
  assert.equal(res.context.count, 0);
  assert.equal(res.context.truncated, 0);
  assert.equal(res.context.identityUncertain, null);
  assert.equal(normaliseResult({ identityUncertain: [] }).context.identityUncertain, null, "an empty list is not an uncertainty");
  assert.ok(FEEDBACK_READERS.includes("freeze") && !(FEEDBACK_READERS as readonly string[]).includes("executorActive"));
});
