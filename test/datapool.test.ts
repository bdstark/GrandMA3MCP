import { test } from "node:test";
import assert from "node:assert/strict";
import { BridgeError, type Gma3Bridge } from "../src/bridge.ts";
import { currentPoolBridge, scopeText, scopedBridge } from "../src/tools/datapool.ts";
import { registerCueTools } from "../src/tools/cues.ts";
import { checkReferences, references } from "../src/tools/macros.ts";
import { startHarness } from "./helpers/tool-harness.ts";

function stubBridge(answer: (op: string, args: Record<string, unknown>) => unknown = () => ({})) {
  const sent: Array<{ op: string; args: Record<string, unknown> }> = [];
  const bridge = {
    async request(op: string, args: Record<string, unknown> = {}) {
      sent.push({ op, args });
      return answer(op, args);
    },
  } as unknown as Gma3Bridge;
  return { bridge, sent };
}

test("scopeText writes DataPool n before every data-pool object keyword outside quotes", () => {
  assert.equal(scopeText("Sequence 5 Cue 2", 2), "DataPool 2 Sequence 5 Cue 2");
  assert.equal(scopeText("Store Sequence 5 Cue 1 /Merge /NoConfirmation", 3), "Store DataPool 3 Sequence 5 Cue 1 /Merge /NoConfirmation");
  assert.equal(scopeText("Group 3 + Group 4; Preset 4.2 Thru 4.5", 2), "DataPool 2 Group 3 + DataPool 2 Group 4; DataPool 2 Preset 4.2 Thru 4.5", "a reference gets no SelFix/At");
  assert.equal(scopeText("Group 3 + Group 4; Preset 4.2 Thru 4.5", 2, true), "SelFix DataPool 2 Group 3 + DataPool 2 Group 4; At DataPool 2 Preset 4.2 Thru 4.5");
  assert.equal(scopeText('Label Macro 7 "Sequence 1"', 2), 'Label DataPool 2 Macro 7 "Sequence 1"', "quoted text is kept");
  assert.equal(scopeText("DataPool 4 Sequence 1", 2), "DataPool 4 Sequence 1", "an explicit data pool is kept");
  assert.equal(scopeText("Fixture 1 Thru 5 At 50", 2), "Fixture 1 Thru 5 At 50", "fixtures do not live in a data pool");
  // Checked on onPC: a statement may not start with "DataPool n Group m" or "DataPool n Preset p".
  assert.equal(scopeText("Group 9901", 1, true), "SelFix DataPool 1 Group 9901");
  assert.equal(scopeText("Preset 4.1", 1, true), "At DataPool 1 Preset 4.1");
  assert.equal(scopeText("ClearSelection; Group 3; Preset 4.1", 1, true), "ClearSelection; SelFix DataPool 1 Group 3; At DataPool 1 Preset 4.1");
  assert.equal(scopeText("Fixture 1 At Preset 4.1", 1), "Fixture 1 At DataPool 1 Preset 4.1");
  assert.equal(scopeText("Sequence 9901", 1), "DataPool 1 Sequence 9901");
});

test("scopedBridge: no data pool is the bridge itself; refs, commands and DataPool.<Pool> paths are scoped", async () => {
  const { bridge, sent } = stubBridge((op, args) =>
    op === "children" && args.ref === "DataPool 2" ? { items: [{ name: "Groups", addr: "14.14.2.1" }, { name: "Sequences", addr: "14.14.2.3" }] } : { ok: true },
  );
  assert.equal(scopedBridge(bridge, undefined), bridge);
  const b = scopedBridge(bridge, 2);
  assert.equal(currentPoolBridge(b), bridge);
  await b.request("objects", { ref: "Sequence 5 Cue 1", fields: ["Name"] });
  await b.request("cmd", { command: "Delete Sequence 5 Cue 1 /NoConfirmation" });
  await b.request("children", { ref: "DataPool.Sequences", limit: 10 });
  await b.request("children", { ref: "DataPool.sequences" });
  await b.request("object", { ref: "14.14.1.6" });
  assert.deepEqual(
    sent.map((s) => [s.op, s.args.ref ?? s.args.command]),
    [
      ["objects", "DataPool 2 Sequence 5 Cue 1"],
      ["cmd", "Delete DataPool 2 Sequence 5 Cue 1 /NoConfirmation"],
      ["children", "DataPool 2"],
      ["children", "14.14.2.3"],
      ["children", "14.14.2.3"],
      ["object", "14.14.1.6"],
    ],
    "the pool child is looked up once; numeric addresses pass unchanged",
  );
  await assert.rejects(b.request("children", { ref: "DataPool.Timers" }), /DataPool 2 has no Timers/);
  await assert.rejects(b.request("children", { ref: "DataPool.Sequences.Name" }), /only DataPool.<Pool> paths/);
});

test("scopedBridge: preset.context reads the preset pool of the chosen data pool", async () => {
  const { bridge, sent } = stubBridge((op) =>
    op === "preset.context"
      ? { preferencesReadable: true, preferences: { StoreLook: "No" } }
      : { items: [{ class: "Presets", name: "Color", fields: { No: "4 (1000)", Name: "Color", PresetMode: "Selective", InputFilter: "Yes" } }] },
  );
  const res = (await scopedBridge(bridge, 3).request("preset.context", { pool: 4 })) as Record<string, unknown>;
  assert.deepEqual(res.pool, { no: 4, exists: true, name: "Color", presetMode: "Selective", inputFilter: "Yes" });
  assert.deepEqual(sent[0], { op: "preset.context", args: {} }, "the bridge op reads the store preferences only");
  assert.equal(sent[1].args.ref, "DataPool 3 Preset 4");
});

test("macro references: DataPool n Sequence m names the object of that data pool", () => {
  assert.deepEqual(references("Go+ DataPool 2 Sequence 5 Cue 3; Off Sequence 4").refs.map((r) => r.ref), ["DataPool 2 Sequence 5 Cue 3", "Sequence 4"]);
  assert.deepEqual(references("Store DataPool 3 Macro 2").refs.map((r) => [r.ref, r.stores]), [["DataPool 3 Macro 2", true]]);
  assert.deepEqual(references("datapool 2 group 7").refs.map((r) => r.ref), ["DataPool 2 Group 7"]);
});

test("gma3_delete_cue with data_pool addresses that data pool; without it, the current one", async () => {
  const h = await startHarness(registerCueTools);
  try {
    let gone = false;
    h.fake.on("objects", (a) => {
      if (gone) throw new Error(`no objects found for '${String(a.ref)}'`);
      return { total: 1, offset: 0, count: 1, items: [{ name: "Cue 3", class: "Cue", addr: "1.2.3" }] };
    });
    h.fake.on("cmd", () => {
      gone = true;
      return { feedback: "OK" };
    });
    const { isError } = await h.callJson("gma3_delete_cue", { data_pool: 2, sequence: 900, cue: 3 });
    assert.equal(isError, false);
    assert.ok(h.fake.requests.filter((r) => r.op === "objects").every((r) => r.args.ref === "DataPool 2 Sequence 900 Cue 3"));
    assert.equal(h.fake.requests.find((r) => r.op === "cmd")?.args.command, "Delete DataPool 2 Sequence 900 Cue 3 /NoConfirmation");

    h.fake.requests.length = 0;
    gone = false;
    await h.callJson("gma3_delete_cue", { sequence: 900, cue: 3 });
    assert.equal(h.fake.requests.find((r) => r.op === "cmd")?.args.command, "Delete Sequence 900 Cue 3 /NoConfirmation");
  } finally {
    await h.close();
  }
});

// Review of PR #70: a selected sequence is only used with data_pool when it lives in that data pool.
const SELECTED_CUE_TOOLS: Array<[string, Record<string, unknown>]> = [
  ["gma3_delete_cue", {}],
  ["gma3_store_cue", { mode: "overwrite" }],
  ["gma3_store_cue_part", { part: 1, mode: "overwrite" }],
  ["gma3_set_cue_timing", { fade: 1 }],
  ["gma3_set_cue_trigger", { trigger: "go" }],
  ["gma3_goto_cue", {}],
];

test("selected sequence + data_pool: refused before any command when the selection is in another data pool", async () => {
  const h = await startHarness(registerCueTools);
  try {
    h.fake.on("object", (a) =>
      a.ref === "SelectedSequence" ? { class: "Sequence", index: 5, name: "Main", addr: "14.14.1.6.5" } : a.ref === "DataPool 2" ? { addr: "14.14.2" } : { addr: "14.14.1" },
    );
    h.fake.on("*", () => ({ total: 1, offset: 0, count: 1, items: [{ name: "x", class: "Cue", addr: "14.14.2.6.5.2" }] }));
    for (const [tool, extra] of SELECTED_CUE_TOOLS) {
      h.fake.requests.length = 0;
      const { result, isError } = await h.callJson(tool, { data_pool: 2, use_selected_sequence: true, cue: 1, ...extra });
      assert.equal(isError, true, tool);
      assert.match(JSON.stringify(result), /not in DataPool 2/, tool);
      assert.deepEqual(h.fake.requests.filter((r) => !["object"].includes(r.op)).map((r) => r.op), [], `${tool}: nothing but the two reads was sent`);
    }
  } finally {
    await h.close();
  }
});

test("selected sequence + data_pool: used when the selection is in that data pool", async () => {
  const h = await startHarness(registerCueTools);
  try {
    let gone = false;
    h.fake.on("object", (a) => (a.ref === "SelectedSequence" ? { class: "Sequence", index: 5, name: "Main", addr: "14.14.2.6.5" } : { addr: "14.14.2" }));
    h.fake.on("objects", (a) => {
      if (gone) throw new Error(`no objects found for '${String(a.ref)}'`);
      return { total: 1, offset: 0, count: 1, items: [{ name: "Cue 1", class: "Cue", addr: "14.14.2.6.5.2" }] };
    });
    h.fake.on("cmd", () => {
      gone = true;
      return { feedback: "OK" };
    });
    const { isError } = await h.callJson("gma3_delete_cue", { data_pool: 2, use_selected_sequence: true, cue: 1 });
    assert.equal(isError, false);
    assert.equal(h.fake.requests.find((r) => r.op === "cmd")?.args.command, "Delete DataPool 2 Sequence 5 Cue 1 /NoConfirmation");
  } finally {
    await h.close();
  }
});

// Review of PR #70: "Macro n" in a line is the macro itself only when the macro lives in the current data pool.
function poolShow(existing: string[]) {
  return stubBridge((op, args) => {
    if (op === "object") return { addr: args.ref === "DataPool" || args.ref === "DataPool 1" ? "14.14.1" : "14.14.2" };
    if (op === "objects") {
      if (!existing.includes(String(args.ref))) throw new BridgeError(`no objects found for '${String(args.ref)}'`, "objects", false);
      return { total: 1, offset: 0, count: 1, items: [{ name: "m", class: "Macro" }] };
    }
    return { items: [] };
  });
}

test("macro self-reference keeps the macro's data pool", async () => {
  const status = async (bridge: Gma3Bridge, command: string) => (await checkReferences(bridge, 7, [{ command }], 1))[0].refs.map((r) => r.status);
  // Macro 7 created in pool 2 while pool 1 is current: "Go+ Macro 7" runs pool 1's Macro 7, which does not exist.
  assert.deepEqual(await status(scopedBridge(poolShow([]).bridge, 2), "Go+ Macro 7"), ["missing"]);
  assert.deepEqual(await status(scopedBridge(poolShow(["Macro 7"]).bridge, 2), "Go+ Macro 7"), ["exists"]);
  // An explicitly qualified reference to itself in its own pool is the macro itself.
  assert.deepEqual(await status(scopedBridge(poolShow([]).bridge, 2), "Go+ DataPool 2 Macro 7"), ["this_macro"]);
  // data_pool naming the current pool: plain "Macro 7" is the macro itself.
  assert.deepEqual(await status(scopedBridge(poolShow([]).bridge, 1), "Go+ Macro 7"), ["this_macro"]);
  // Without data_pool, as before; "DataPool 2 Macro 7" from a pool-1 macro is another macro.
  assert.deepEqual(await status(poolShow([]).bridge, "Go+ Macro 7"), ["this_macro"]);
  assert.deepEqual(await status(poolShow([]).bridge, "Go+ DataPool 2 Macro 7"), ["missing"]);
});
