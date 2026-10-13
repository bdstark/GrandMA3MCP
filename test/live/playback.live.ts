/**
 * Live console test for SB-01 (gma3_executor_settings, gma3_configure_executor, gma3_configure_sequence).
 *
 * NOT run by `npm test`. Run on purpose against a disposable show with an EMPTY programmer:
 *   GMA3_LIVE=1 node --import tsx --test test/live/playback.live.ts
 *
 * Show objects this file creates, changes and deletes (reserved ranges, see README.md):
 *   - Page 90                      created with `Store Page 90 /NoConfirmation` if it does not exist; deleted at the
 *                                  end ONLY if this test created it.
 *   - Page 90.210 and 90.211       Sequence 905 is assigned to both (to show that sequence settings are shared);
 *                                  removed at the end with `Delete Page 90.21x /NoConfirmation`.
 *   - Sequence 905                 created with three empty cues (`Store Sequence 905 Cue n /NoConfirmation` with an
 *                                  empty programmer), turned into a 0.5 s Time-triggered chase, PLAYED (Go+ / Press /
 *                                  Unpress / Off are sent by this test, never by the tools) and deleted at the end.
 *   The test refuses to run when Sequence 905 exists, Page 90.210/90.211 are not empty or the programmer holds values,
 *   so it never deletes anything it did not create. Locks it sets are removed before cleanup. Nothing calls SaveShow.
 *
 * What it demonstrates (SB-01 acceptance criteria):
 *   1. executor_settings reports the assignment, functions, locks by owner and both executors sharing Sequence 905.
 *   2. Configuring the executor (Temp key, Temp fader) and the sequence never starts playback.
 *   3. A three-cue timed chase with Wrap Around on completes at least two cycles; with Wrap Around off it stops on
 *      the last cue.
 *   4. A Temp key and a Flash key are active only while pressed (Press / Unpress Page 90.210).
 *   5. A locked executor and a locked sequence are refused without unlock: true; unlock: true applies and relocks.
 */
import assert from "node:assert/strict";
import { liveTest, cmd } from "./live.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { MutationLock } from "../../src/mutations.ts";
import type { ToolContext } from "../../src/tools/context.ts";
import { registerPlaybackTools } from "../../src/tools/playback.ts";
import { registerCueTools } from "../../src/tools/cues.ts";
import { exists, readFields } from "../../src/tools/common.ts";

const PAGE = 90;
const EXEC = 210;
const EXEC_SHARED = 211;
const SEQ = 905;
const TRIG_S = 0.5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

liveTest("SB-01: executor functions, sequence playback settings, a looping chase and locks (Sequence 905, Page 90.210/90.211)", async (t, bridge) => {
  const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 15000, luaToolAllowed: false };
  const tools = new Map([...captureTools(registerPlaybackTools, ctx), ...captureTools(registerCueTools, ctx)]);
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
  const seqRef = `Sequence ${SEQ}`;
  const execRef = `Page ${PAGE}.${EXEC}`;
  const active = async () => ((await bridge.request("object", { ref: seqRef, properties: false })) as { hasActivePlayback?: boolean }).hasActivePlayback;
  const currentCue = async () => {
    const f = await readFields(bridge, seqRef, ["CurrentCue"], { asText: false });
    const c = f?.CurrentCue as { name?: string } | string | undefined;
    return typeof c === "object" && c ? c.name ?? null : c || null;
  };
  /** Distinct (cue, active) states over `ms`, sampled every 80 ms. */
  const sample = async (ms: number) => {
    const seen: Array<{ t: number; cue: string | null; active: boolean | undefined }> = [];
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const [cue, act] = [await currentCue(), await active()];
      const last = seen[seen.length - 1];
      if (!last || last.cue !== cue || last.active !== act) seen.push({ t: Date.now() - t0, cue, active: act });
      await sleep(80);
    }
    return seen;
  };

  // Preconditions: never touch anything this test did not create.
  const absent = async (ref: string) => {
    const e = await exists(bridge, ref);
    assert.notEqual(e.exists, "unknown", `could not check ${ref}`);
    return e.exists === false;
  };
  assert.ok(await absent(seqRef), `${seqRef} already exists; remove it or pick another show`);
  const pageExisted = !(await absent(`Page ${PAGE}`));
  if (pageExisted) {
    for (const e of [EXEC, EXEC_SHARED]) assert.ok(await absent(`Page ${PAGE}.${e}`), `Page ${PAGE}.${e} is not empty`);
  }
  const prog = (await bridge.request("programmer", {})) as { rows?: unknown[] };
  if ((prog.rows ?? []).length) {
    t.skip("the programmer holds values; clear it first (Store would record them into the test cues)");
    return;
  }

  let createdPage = false;
  t.after(async () => {
    await bridge.request("set", { ref: execRef, property: "Lock", value: "No" }).catch(() => {});
    await bridge.request("set", { ref: seqRef, property: "Lock", value: "No" }).catch(() => {});
    await cmd(`Off ${seqRef}`).catch(() => {});
    for (const e of [EXEC, EXEC_SHARED]) await cmd(`Delete Page ${PAGE}.${e} /NoConfirmation`).catch(() => {});
    await cmd(`Delete ${seqRef} /NoConfirmation`).catch(() => {});
    if (createdPage) await cmd(`Delete Page ${PAGE} /NoConfirmation`).catch(() => {});
  });

  if (!pageExisted) {
    assert.equal(await cmd(`Store Page ${PAGE} /NoConfirmation`), "OK");
    createdPage = true;
  }
  for (const c of [1, 2, 3]) assert.equal(await cmd(`Store ${seqRef} Cue ${c} /NoConfirmation`), "OK");
  assert.equal(await cmd(`Assign ${seqRef} At ${execRef}`), "OK");
  assert.equal(await cmd(`Assign ${seqRef} At Page ${PAGE}.${EXEC_SHARED}`), "OK");
  for (const c of [1, 2, 3]) {
    const r = await call("gma3_set_cue_trigger", { sequence: SEQ, cue: String(c), trigger: "time", time: TRIG_S });
    assert.equal(r.isError, false, JSON.stringify(r.result));
  }

  // 1. Inspection
  const s0 = await call("gma3_executor_settings", { page: PAGE, executor: EXEC });
  assert.equal(s0.isError, false, JSON.stringify(s0.result));
  t.diagnostic(`fresh executor: ${JSON.stringify(s0.result.executorSettings)}; sequence: ${JSON.stringify(s0.result.sequence.settings)}`);
  assert.equal(s0.result.assigned.class, "Sequence");
  assert.equal(s0.result.sequence.active, false);
  assert.deepEqual(s0.result.references.executors.map((r: { ref: string }) => r.ref).sort(), [execRef, `Page ${PAGE}.${EXEC_SHARED}`].sort());

  // 2. Configuration alone does not start playback.
  const ce = await call("gma3_configure_executor", { page: PAGE, executor: EXEC, key_press: "Temp", fader: "Temp" });
  assert.equal(ce.isError, false, JSON.stringify(ce.result));
  assert.equal(ce.result.verification.status, "matched");
  assert.deepEqual(ce.result.playback, { activeBefore: false, activeAfter: false });
  const cs = await call("gma3_configure_sequence", { sequence: SEQ, wrap_around: true, restart_mode: "first_cue", priority: "ltp", kill_protect: true, swap_protect: true });
  assert.equal(cs.isError, false, JSON.stringify(cs.result));
  assert.equal(cs.result.playback.activeAfter, false);
  assert.deepEqual(cs.result.intended.unchanged.sort(), ["priority", "restart_mode", "wrap_around"]);
  assert.ok(cs.result.warnings?.some((w: string) => w.includes(`Page ${PAGE}.${EXEC_SHARED}`)), JSON.stringify(cs.result.warnings));

  // 3a. Looping chase: at least two complete cycles (two Cue 3 -> Cue 1 wraps).
  assert.equal(await cmd(`Go+ ${seqRef}`), "OK");
  const loop = await sample(4200);
  assert.equal(await cmd(`Off ${seqRef}`), "OK");
  t.diagnostic(`wrap on: ${JSON.stringify(loop)}`);
  const cues = loop.filter((s) => s.active).map((s) => s.cue);
  const wraps = cues.filter((c, i) => i > 0 && c === "Cue 1" && cues[i - 1] === "Cue 3").length;
  assert.ok(wraps >= 2, `expected two wraps from Cue 3 to Cue 1, saw ${JSON.stringify(cues)}`);

  // 3b. Non-looping variant: Wrap Around off stops on the last cue.
  const nw = await call("gma3_configure_sequence", { sequence: SEQ, wrap_around: false });
  assert.equal(nw.isError, false, JSON.stringify(nw.result));
  assert.equal(nw.result.playback.activeAfter, false);
  assert.equal(await cmd(`Go+ ${seqRef}`), "OK");
  const once = await sample(3000);
  t.diagnostic(`wrap off: ${JSON.stringify(once)}`);
  // The first sample may still show the cue the previous run was switched off on; count from the restart (Cue 1).
  const allOnce = once.filter((s) => s.active).map((s) => s.cue);
  const onceCues = allOnce.slice(Math.max(0, allOnce.indexOf("Cue 1")));
  assert.deepEqual(onceCues, ["Cue 1", "Cue 2", "Cue 3"], JSON.stringify(allOnce));
  assert.equal(onceCues[onceCues.length - 1], "Cue 3", JSON.stringify(onceCues));
  assert.ok(!onceCues.some((c, i) => i > 0 && c === "Cue 1" && onceCues[i - 1] === "Cue 3"), "must not wrap");
  assert.equal(await cmd(`Off ${seqRef}`), "OK");
  await sleep(300);
  assert.equal(await active(), false);

  // 4. Temp and Flash keys are active only while pressed.
  for (const fn of ["Temp", "Flash"]) {
    const r = await call("gma3_configure_executor", { page: PAGE, executor: EXEC, key_press: fn });
    assert.equal(r.isError, false, JSON.stringify(r.result));
    // Temp is already set from step 2 (a no-op reports only activeBefore).
    assert.equal(r.result.playback.activeAfter ?? r.result.playback.activeBefore, false, `${fn}: configuring must not start playback`);
    assert.equal(await cmd(`Press ${execRef}`), "OK");
    await sleep(400);
    const held = await active();
    assert.equal(await cmd(`Unpress ${execRef}`), "OK");
    await sleep(400);
    const released = await active();
    t.diagnostic(`${fn}: held=${held} released=${released}`);
    assert.equal(held, true, `${fn} must be active while pressed`);
    assert.equal(released, false, `${fn} must release`);
  }

  // 5. Locks: refused without unlock, applied and relocked with unlock: true.
  const le = await call("gma3_configure_executor", { page: PAGE, executor: EXEC, lock: true });
  assert.equal(le.isError, false, JSON.stringify(le.result));
  const refusedE = await call("gma3_configure_executor", { page: PAGE, executor: EXEC, key_press: "Go+" });
  assert.equal(refusedE.isError, true);
  assert.equal(refusedE.result.outcome, "failed");
  assert.equal(String((await readFields(bridge, execRef, ["KeyPress"]))?.KeyPress), "Flash");
  const unlockedE = await call("gma3_configure_executor", { page: PAGE, executor: EXEC, key_press: "Go+", unlock: true });
  assert.equal(unlockedE.isError, false, JSON.stringify(unlockedE.result));
  assert.equal(unlockedE.result.verification.status, "matched");
  assert.notEqual(String((await readFields(bridge, execRef, ["Lock"]))?.Lock ?? ""), "", "executor relocked");

  const ls = await call("gma3_configure_sequence", { sequence: SEQ, lock: true });
  assert.equal(ls.isError, false, JSON.stringify(ls.result));
  const refusedS = await call("gma3_configure_sequence", { sequence: SEQ, wrap_around: true });
  assert.equal(refusedS.isError, true);
  assert.equal(String((await readFields(bridge, seqRef, ["WrapAround"]))?.WrapAround), "No");
  const unlockedS = await call("gma3_configure_sequence", { sequence: SEQ, wrap_around: true, unlock: true });
  assert.equal(unlockedS.isError, false, JSON.stringify(unlockedS.result));
  assert.notEqual(String((await readFields(bridge, seqRef, ["Lock"]))?.Lock ?? ""), "", "sequence relocked");
  const s1 = await call("gma3_executor_settings", { page: PAGE, executor: EXEC });
  assert.equal(s1.result.protection.executor.locked, true);
  assert.equal(s1.result.protection.sequence.locked, true);
  assert.equal(s1.result.protection.page.locked, false);

  for (const [name, args] of [
    ["gma3_configure_executor", { page: PAGE, executor: EXEC, lock: false }],
    ["gma3_configure_sequence", { sequence: SEQ, lock: false }],
  ] as const) {
    const r = await call(name, args);
    assert.equal(r.isError, false, JSON.stringify(r.result));
  }
  assert.equal(await active(), false);
});
