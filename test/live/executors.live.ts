/**
 * Live console test for FR-06 (gma3_assign_to_executor, gma3_label_executor).
 *
 * NOT run by `npm test`. Run on purpose against a disposable show:  GMA3_LIVE=1 npm run test:live
 *
 * Show objects this file creates, changes and deletes (reserved ranges, see README.md):
 *   - Page 90                      created with `Store Page 90 /NoConfirmation` if it does not exist;
 *                                  deleted at the end ONLY if this test created it.
 *   - Page 90.201 and 90.202       executors assigned and labelled by the tools; their assignments are
 *                                  removed at the end with `Delete Page 90.20x /NoConfirmation`
 *                                  (confirmed to remove the assignment on a non-current page).
 *   - Page 90.203                  must be empty (the label-on-empty-executor check); never written.
 *   - Sequence 901 and 902         created with `Store Sequence 90x Cue 1 /NoConfirmation` (confirmed to
 *                                  create the sequence with an EMPTY programmer; run it with the programmer
 *                                  cleared, otherwise cue 1 stores whatever is in it). The label step
 *                                  RENAMES these sequences (an executor shows its assigned object's name).
 *                                  Both are deleted at the end with `Delete Sequence 90x /NoConfirmation`.
 *   The test refuses to run when Sequence 901/902 already exist or Page 90.201-90.203 are not empty,
 *   so it never deletes anything it did not create. Nothing calls SaveShow.
 *
 * Console behaviour this run relies on (settled on onPC 2.5.1):
 *   - `Assign Sequence n At Page 90.e` returns OK and Page 90.e then reads Name/Object = the sequence name.
 *   - An executor has no label of its own: `Label Page 90.201 "x"` renames the ASSIGNED SEQUENCE
 *     (Page 90.201 Name, Object and Sequence 901 Name all become "x").
 *   - Names containing \ " $ & * ? , . ; ^ { } | ~ are refused by validation (the console would strip them).
 *   Still only observed, not controlled: whether assigning changes SelectedSequence (printed).
 */
import assert from "node:assert/strict";
import { liveTest, cmd } from "./live.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { MutationLock } from "../../src/mutations.ts";
import type { ToolContext } from "../../src/tools/context.ts";
import { registerExecutorTools } from "../../src/tools/executors.ts";
import { exists, readFields } from "../../src/tools/common.ts";

const PAGE = 90;
const EXEC_A = 201;
const EXEC_B = 202;
const EXEC_EMPTY = 203;
const SEQ_A = 901;
const SEQ_B = 902;

liveTest("executor assignment and labelling on Page 90 (Sequence 901/902, executors 90.201-90.203)", async (t, bridge) => {
  const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 15000, luaToolAllowed: false };
  const tools = captureTools(registerExecutorTools, ctx);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await tools.get(name)!.call(args);
    const text = res.content.map((c) => c.text).join("\n");
    let result: any;
    try {
      result = JSON.parse(text);
    } catch {
      result = text;
    }
    return { result, isError: Boolean(res.isError) };
  };
  const selectedSequence = async () => (await readFields(bridge, "SelectedSequence", ["Name", "No"]).catch(() => null)) ?? null;
  const sequenceName = async (n: number) => String((await readFields(bridge, `Sequence ${n}`, ["Name"]))?.Name);

  // Preconditions: refuse to touch anything that already exists in the reserved range.
  for (const n of [SEQ_A, SEQ_B]) {
    const e = await exists(bridge, `Sequence ${n}`);
    assert.equal(e.exists, false, `Sequence ${n} already exists; this test only works on a disposable show without it`);
  }
  const pageExisted = (await exists(bridge, `Page ${PAGE}`)).exists === true;
  if (pageExisted) {
    for (const e of [EXEC_A, EXEC_B, EXEC_EMPTY]) {
      assert.equal((await exists(bridge, `Page ${PAGE}.${e}`)).exists, false, `Page ${PAGE}.${e} is not empty; refusing to run`);
    }
  }

  let createdPage = false;
  const createdSequences: number[] = [];
  try {
    if (!pageExisted) {
      await cmd(`Store Page ${PAGE} /NoConfirmation`);
      assert.equal((await exists(bridge, `Page ${PAGE}`)).exists, true, `Store Page ${PAGE} did not create the page`);
      createdPage = true;
    }
    for (const n of [SEQ_A, SEQ_B]) {
      const fb = await cmd(`Store Sequence ${n} Cue 1 /NoConfirmation`);
      assert.equal((await exists(bridge, `Sequence ${n}`)).exists, true, `could not create Sequence ${n} (feedback: ${fb})`);
      createdSequences.push(n);
    }
    const seqAName = await sequenceName(SEQ_A);
    const selectedBefore = await selectedSequence();

    // 1. Assign to an empty executor on a non-current page, with a label: the label renames the sequence.
    let r = await call("gma3_assign_to_executor", { sequence: SEQ_A, page: PAGE, executor: EXEC_A, label: "MCP Exec A" });
    t.diagnostic(`assign+label: ${r.result.summary}`);
    assert.equal(r.result.outcome, "succeeded", JSON.stringify(r.result, null, 1));
    assert.equal(r.result.verification.status, "matched", JSON.stringify(r.result.verification));
    assert.deepEqual(r.result.previous, { empty: true });
    assert.equal(r.result.sequenceName, seqAName);
    assert.equal(r.result.resulting.object.class, "Sequence");
    assert.equal(r.result.resulting.object.name, "MCP Exec A");
    assert.equal(r.result.resulting.name, "MCP Exec A");
    assert.equal(r.result.sequenceNameAfter, "MCP Exec A");
    assert.equal(await sequenceName(SEQ_A), "MCP Exec A", "the label must have renamed Sequence 901 itself");
    const selectedAfter = await selectedSequence();
    t.diagnostic(`SelectedSequence before: ${JSON.stringify(selectedBefore)} after: ${JSON.stringify(selectedAfter)}`);

    // 2. Same sequence again: no command is sent.
    r = await call("gma3_assign_to_executor", { sequence: SEQ_A, page: PAGE, executor: EXEC_A });
    assert.equal(r.result.outcome, "succeeded", r.result.summary);
    assert.equal(r.result.alreadyAssigned, true);
    assert.equal(r.result.command, null);
    assert.equal(r.result.verification.status, "matched");

    // 3. A different sequence without replace is refused; with replace it is assigned.
    r = await call("gma3_assign_to_executor", { sequence: SEQ_B, page: PAGE, executor: EXEC_A });
    assert.equal(r.isError, true);
    assert.equal(r.result.outcome, "failed");
    assert.equal(r.result.previous.object.class, "Sequence");
    assert.equal(r.result.previous.object.name, "MCP Exec A");
    assert.equal(r.result.steps.filter((s: any) => s.op === "cmd").length, 0, "nothing may be sent without replace");
    r = await call("gma3_assign_to_executor", { sequence: SEQ_B, page: PAGE, executor: EXEC_A, replace: true });
    assert.equal(r.result.outcome, "succeeded", r.result.summary);
    assert.equal(r.result.verification.status, "matched", JSON.stringify(r.result.verification));
    assert.equal(r.result.replaced, true);
    assert.equal(r.result.resulting.object.name, await sequenceName(SEQ_B));

    // 4. Label through gma3_label_executor: renames the assigned sequence, read back on both sides.
    r = await call("gma3_assign_to_executor", { sequence: SEQ_A, page: PAGE, executor: EXEC_B });
    assert.equal(r.result.outcome, "succeeded", r.result.summary);
    r = await call("gma3_label_executor", { page: PAGE, executor: EXEC_B, label: "MCP Exec B" });
    t.diagnostic(`label: ${r.result.summary}`);
    assert.equal(r.result.outcome, "succeeded", r.result.summary);
    assert.equal(r.result.verification.status, "matched", JSON.stringify(r.result.verification));
    assert.equal(r.result.assignedObjectRef, `Sequence ${SEQ_A}`);
    assert.equal(r.result.assignedObjectName, "MCP Exec B");
    assert.equal(await sequenceName(SEQ_A), "MCP Exec B");

    // 5. A name the console would strip characters from is refused before anything is sent.
    r = await call("gma3_label_executor", { page: PAGE, executor: EXEC_B, label: 'MCP "B" v1.0' });
    assert.equal(r.isError, true);
    assert.equal(r.result.outcome, "failed");
    assert.ok(r.result.validationErrors?.some((e: string) => /removes from names/.test(e)), JSON.stringify(r.result));
    assert.equal(await sequenceName(SEQ_A), "MCP Exec B", "a refused label must change nothing");

    // 6. Labelling an empty executor is refused before anything is sent.
    r = await call("gma3_label_executor", { page: PAGE, executor: EXEC_EMPTY, label: "nope" });
    assert.equal(r.isError, true);
    assert.equal(r.result.outcome, "failed");
    assert.equal(r.result.steps.filter((s: any) => s.op === "cmd").length, 0);
    assert.equal((await exists(bridge, `Page ${PAGE}.${EXEC_EMPTY}`)).exists, false);
  } finally {
    // Cleanup, most dependent first: executor assignments, then sequences, then the page if we made it.
    for (const e of [EXEC_A, EXEC_B]) await cmd(`Delete Page ${PAGE}.${e} /NoConfirmation`).catch(() => {});
    for (const n of createdSequences) await cmd(`Delete Sequence ${n} /NoConfirmation`).catch(() => {});
    if (createdPage) await cmd(`Delete Page ${PAGE} /NoConfirmation`).catch(() => {});
    for (const e of [EXEC_A, EXEC_B]) assert.equal((await exists(bridge, `Page ${PAGE}.${e}`)).exists, false, `Page ${PAGE}.${e} was not cleaned up`);
    for (const n of createdSequences) assert.equal((await exists(bridge, `Sequence ${n}`)).exists, false, `Sequence ${n} was not cleaned up`);
  }
});
