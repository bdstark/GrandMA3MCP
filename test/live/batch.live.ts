/**
 * Live console test for the SU-12 batch forms and compact results.
 *
 * Runs only with GMA3_LIVE=1 against a disposable show (see README.md in this folder). Not part of `npm test`.
 * No bridge change.
 *
 * Show objects used (each must be empty or absent; everything is deleted at the end):
 *   - Four top-level fixtures with Dimmer and ColorRGB_R, FIDs from GMA3_LIVE_BATCH_FIDS (default "1,2,3,4").
 *   - Groups 920-921, Macros 920-921, Sequences 920-922, Presets 23.920-23.921.
 *   - Page 90 (created with `Store Page 90` when missing, and then deleted), executors 90.216-90.217.
 *     The first patched fixture (subfixture index 0) must not be among them until the bridge's programmer scan
 *     covers index 0 (it misses it on bridge 0.30.0, so gma3_store_preset refuses a scope that includes it).
 *   - The Normal programmer: one operator value (the fourth fixture at 33 %) that the Preview builds must leave alone;
 *     cleared (ClearAll) at the end. The 18-step chase PLAYS for about four seconds (live output).
 *
 * What it asserts: each batch form succeeds with every item matched (groups with a reversed range and rows spread to a
 * width, macros and line edits, cues in two sequences, the same settings on a sequence range, assignments to empty
 * executors, presets from explicit content built in Preview); a second assignment of the same targets sends nothing;
 * an occupied target without replace fails alone; the compact 18-step chase result stays under 5 KB.
 */
import assert from "node:assert/strict";
import { after } from "node:test";
import { MutationLock } from "../../src/mutations.ts";
import { registerCueListTools } from "../../src/tools/cuelists.ts";
import { registerExecutorTools } from "../../src/tools/executors.ts";
import { registerGroupTools } from "../../src/tools/groups.ts";
import { registerMacroTools } from "../../src/tools/macros.ts";
import { registerPlaybackTools } from "../../src/tools/playback.ts";
import { registerPresetTools } from "../../src/tools/presets.ts";
import type { RegisterTools, ToolContext } from "../../src/tools/context.ts";
import { captureTools, type CapturedTool } from "../helpers/tool-harness.ts";
import { liveTest, liveEnabled, bridge } from "./live.ts";

const [A, B, C, D] = (process.env.GMA3_LIVE_BATCH_FIDS ?? "1,2,3,4").split(",").map((s) => s.trim());
const GROUPS = [920, 921];
const MACROS = [920, 921];
const SEQS = [920, 921, 922];
const PRESETS = ["23.920", "23.921"];
const PAGE = 90;
const EXECS = [216, 217];
const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 15000, luaToolAllowed: false };
const tools = new Map<string, CapturedTool>();
for (const r of [registerCueListTools, registerExecutorTools, registerGroupTools, registerMacroTools, registerPlaybackTools, registerPresetTools] as RegisterTools[]) for (const [k, v] of captureTools(r, ctx)) tools.set(k, v);

async function call(name: string, args: Record<string, unknown>) {
  const res = await tools.get(name)!.call(args);
  const text = res.content.map((c) => c.text).join("\n");
  return { result: JSON.parse(text), isError: Boolean(res.isError), text };
}
const allMatched = (r: { result: any; isError: boolean; text: string }, what: string) => {
  assert.equal(r.isError, false, `${what}: ${r.text.slice(0, 3000)}`);
  assert.equal(r.result.outcome, "succeeded", what);
  assert.equal(r.result.verification.status, "matched", what);
  for (const i of r.result.items) assert.equal(i.verification, "matched", `${what}: ${i.target}`);
  return r.result;
};
const cmd = async (command: string) => ((await bridge.request("cmd", { command })) as { feedback?: string }).feedback;
const total = async (ref: string) => ((await bridge.request("objects", { ref })) as { total?: number }).total ?? 0;

const cleanup = { started: false, pageCreated: false };
after(async () => {
  if (!liveEnabled || !cleanup.started) return;
  try {
    for (const e of EXECS) await cmd(`Delete Page ${PAGE}.${e} /NoConfirmation`);
    if (cleanup.pageCreated) await cmd(`Delete Page ${PAGE} /NoConfirmation`);
    for (const s of SEQS) {
      await cmd(`Off Sequence ${s}`);
      await cmd(`Delete Sequence ${s} /NoConfirmation`);
    }
    for (const g of GROUPS) await cmd(`Delete Group ${g} /NoConfirmation`);
    for (const m of MACROS) await cmd(`Delete Macro ${m} /NoConfirmation`);
    for (const p of PRESETS) await cmd(`Delete Preset ${p} /NoConfirmation`);
    await cmd("ClearAll");
  } catch {
    // best effort
  }
});

liveTest("SU-12 batch forms: groups, macros, line edits, cues, sequence settings, assignments, presets; a compact chase result", async (t) => {
  for (const ref of [...GROUPS.map((g) => `Group ${g}`), ...MACROS.map((m) => `Macro ${m}`), ...SEQS.map((s) => `Sequence ${s}`), ...PRESETS.map((p) => `Preset ${p}`)]) {
    assert.equal(await total(ref), 0, `${ref} must be empty in the disposable show`);
  }
  const pageExists = (await total(`Page ${PAGE}`)) > 0;
  if (pageExists) for (const e of EXECS) assert.equal(await total(`Page ${PAGE}.${e}`), 0, `Page ${PAGE}.${e} must be empty`);
  cleanup.started = true;
  if (!pageExists) {
    assert.equal(await cmd(`Store Page ${PAGE} /NoConfirmation`), "OK");
    cleanup.pageCreated = true;
  }
  // The operator's own value in Normal, which no Preview build may touch.
  for (const c of ["ClearAll", `Fixture ${D}`, "At 33", "ClearSelection"]) assert.equal(await cmd(c), "OK", c);

  // Groups: a reversed range, and rows of different lengths spread over one width.
  const groups = allMatched(
    await call("gma3_store_group", {
      exclusive: true,
      groups: [
        { group: 920, name: "MCP batch row", arrangement: { type: "row", fixtures: [`${D} Thru ${A}`] } },
        { group: 921, name: "MCP batch rows", arrangement: { type: "rows", rows: [[A, B, C], [D]], width: 3 } },
      ],
    }),
    "store_group batch",
  );
  t.diagnostic(`groups: ${JSON.stringify(groups.items.map((i: any) => i.summary))}`);

  // Macros, then line edits against the shifted lines.
  allMatched(await call("gma3_store_macro", { mode: "create", macros: [{ macro: 920, name: "MCP batch 1", lines: [{ command: 'Echo "one"' }] }, { macro: 921, lines: [{ command: 'Echo "two"' }, { command: 'Echo "three"' }] }] }), "store_macro batch");
  allMatched(await call("gma3_edit_macro_line", { accept_console_form: true, edits: [{ macro: 920, action: "insert", line: 1, command: 'Echo "zero"' }, { macro: 921, action: "remove", line: 1 }, { macro: 921, action: "set", line: 1, name: "kept" }] }), "edit_macro_line batch");

  // Cues in two sequences (each its own Preview build), then the same settings on the range.
  allMatched(
    await call("gma3_store_cues", {
      mode: "create",
      exclusive: true,
      fixtures: `${A} + ${B}`,
      sequences: [
        { sequence: 920, sequence_name: "MCP batch A", cues: [{ cue: 1, intensity: 40 }, { cue: 2, intensity: 80 }] },
        { sequence: 921, sequence_name: "MCP batch B", cues: [{ cue: 1, intensity: 20, values: [{ attribute: "ColorRGB_R", value: 100, unit: "percent" }] }] },
      ],
    }),
    "store_cues batch",
  );
  allMatched(await call("gma3_configure_sequence", { sequences: ["920 Thru 921"], off_when_overridden: true, kill_protect: true }), "configure_sequence batch");

  // Assignments to empty executors; again with the same targets: nothing is sent; an occupied target fails alone.
  allMatched(await call("gma3_assign_to_executor", { page: PAGE, assignments: [{ sequence: 920, executor: 216 }, { sequence: 921, executor: 217 }] }), "assign batch");
  const again = allMatched(await call("gma3_assign_to_executor", { page: PAGE, assignments: [{ sequence: 920, executor: 216 }, { sequence: 921, executor: 217 }] }), "assign batch again");
  t.diagnostic(`assign again: ${JSON.stringify(again.items.map((i: any) => i.summary))}`);
  const occupied = await call("gma3_assign_to_executor", { page: PAGE, assignments: [{ sequence: 921, executor: 216 }] });
  assert.equal(occupied.result.items[0].outcome, "failed", occupied.text);
  assert.match(occupied.result.items[0].summary, /nothing was sent/i);

  // Presets from explicit content, built in Preview; the Normal value survives.
  const presets = allMatched(
    await call("gma3_store_preset", {
      exclusive: true,
      mode: "selective",
      presets: [
        { preset: "23.920", name: "MCP batch red", fixtures: [A, B], values: [{ attribute: "ColorRGB_R", value: 100, unit: "percent" }] },
        { preset: "23.921", looks: [{ fixtures: [C], intensity: 40 }, { fixtures: [A], intensity: 60 }] },
      ],
    }),
    "store_preset batch",
  );
  assert.equal(presets.normalProgrammer, "untouched");
  const normal = (await bridge.request("programmer", { scope: "fixtures", fixtures: `Fixture ${D}`, limit: 50 })) as { environment?: string; rows?: Array<{ attribute?: string; value?: number }> };
  assert.equal(normal.environment, "Normal");
  const kept = normal.rows?.find((r) => r.attribute === "Dimmer")?.value;
  assert.ok(typeof kept === "number" && Math.abs(kept - 33) < 0.01, `the operator's Normal value survives every Preview build (read ${kept})`);

  // An 18-step chase: the compact result stays small.
  const steps = Array.from({ length: 18 }, (_, i) => ({ name: `S${i + 1}`, intensity: (i + 1) * 5 }));
  const chase = await call("gma3_build_chase", { sequence: 922, fixtures: A, steps, step_seconds: 0.2, exclusive: true });
  assert.equal(chase.isError, false, chase.text.slice(0, 3000));
  t.diagnostic(`sizes: ${JSON.stringify(Object.fromEntries(Object.entries(chase.result).map(([k, v]) => [k, JSON.stringify(v, null, 2).length])))}`);
  t.diagnostic(`18-step chase: compact result ${chase.text.length} bytes, cycle ${JSON.stringify(chase.result.cycle?.expected)}`);
  assert.ok(chase.text.length < 5000, `compact chase result is ${chase.text.length} bytes`);
  assert.equal(chase.result.cues.length, 18);
});
