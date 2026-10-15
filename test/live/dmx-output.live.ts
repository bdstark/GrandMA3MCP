/**
 * Live console test for SU-09 (gma3_dmx_output, gma3_configure_dmx_output, outputState in gma3_fixture_output /
 * gma3_dmx). Needs bridge 0.30.0.
 *
 * Runs only with GMA3_LIVE=1 against a disposable show (see README.md in this folder).
 *   - Read part: any show with a patched fixture (GMA3_LIVE_DMX_FID, default 1).
 *   - Configuration part, only with GMA3_LIVE_EXCLUSIVE=1 and only while Art-Net and sACN output are both off (so
 *     nothing reaches the network): sACN data entry 1 is edited (mapping, priority, mode), one entry is added, universe
 *     1024's grant request is set, and everything is put back from the values read first; the added entry is removed.
 */
import assert from "node:assert/strict";
import { after } from "node:test";
import { MutationLock } from "../../src/mutations.ts";
import { registerDmxOutputTools } from "../../src/tools/dmxoutput.ts";
import { registerInspectionTools } from "../../src/tools/inspection.ts";
import type { ToolContext } from "../../src/tools/context.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { liveTest, liveEnabled, bridge } from "./live.ts";

const FID = Number(process.env.GMA3_LIVE_DMX_FID ?? "1");
const exclusive = process.env.GMA3_LIVE_EXCLUSIVE === "1";
const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 15000, luaToolAllowed: false };
const tools = new Map([...captureTools(registerDmxOutputTools, ctx), ...captureTools(registerInspectionTools, ctx)]);
async function call(name: string, args: Record<string, unknown>) {
  const res = await tools.get(name)!.call(args);
  const text = res.content.map((c) => c.text).join("\n");
  return { result: JSON.parse(text), isError: Boolean(res.isError), text };
}
const ok = (r: { result: any; isError: boolean; text: string }, what: string) => {
  assert.equal(r.isError, false, `${what}: ${r.text}`);
  assert.equal(r.result.verification.status, "matched", what);
  return r.result;
};

const restore: { entry?: any; count?: number; request?: string } = {};
after(async () => {
  if (!liveEnabled || !restore.entry) return;
  try {
    const now = (await call("gma3_dmx_output", { universes: [1024] })).result;
    const extra = now.protocols.sacn.entries.slice(restore.count).map((e: any) => ({ entry: e.index, remove: true })).reverse();
    const e = restore.entry;
    await call("gma3_configure_dmx_output", { protocol: "sacn", entries: [{ entry: 1, local_universe: e.localUniverse, amount: e.amount, universe: e.universe, priority: e.priority, mode: e.mode }, ...extra], grant_request: { universes: [1024], value: String(restore.request ?? "Auto").toLowerCase() }, exclusive: true });
  } catch {
    // best effort
  }
});

liveTest("SU-09 DMX output: universes explained, unreadable output explained, protocol entries configured and restored", async (t) => {
  const read = (await call("gma3_dmx_output", {})).result;
  assert.ok(read.totals.universes >= 1, "the console lists its universes");
  assert.ok(read.universes.length >= 1, "at least one universe is in use");
  for (const u of read.universes) assert.ok(["idle", "not_granted", "no_protocol_output", "sent"].includes(u.state) && u.explanation.length > 0, `universe ${u.no} is explained`);
  const out = (await call("gma3_fixture_output", { fixture: FID })).result;
  const unreadable = (out.channels ?? []).some((c: any) => c.value === null);
  if (unreadable) {
    assert.ok(Array.isArray(out.outputState) && out.outputState.length > 0, "a fixture whose output cannot be read gets an explanation");
    assert.ok(out.outputState.every((s: any) => s.state === "not_granted" || s.state === "unknown"), JSON.stringify(out.outputState));
  }

  if (!exclusive) {
    t.diagnostic("configuration part skipped: set GMA3_LIVE_EXCLUSIVE=1");
    return;
  }
  if (read.protocols.artnet.out || read.protocols.sacn.out) {
    t.diagnostic("configuration part skipped: Art-Net or sACN output is on, and this test changes nothing that could reach the network");
    return;
  }
  const e1 = read.protocols.sacn.entries[0];
  assert.ok(e1, "sACN has a data entry 1");
  restore.entry = e1;
  restore.count = read.protocols.sacn.entries.length;
  restore.request = (await call("gma3_dmx_output", { universes: [1024] })).result.universes.find((u: any) => u.no === 1024)?.request ?? "Auto";

  const preview = (await call("gma3_configure_dmx_output", { protocol: "sacn", output: true, entries: [{ entry: 1, enabled: true }], preview: true })).result;
  assert.match(preview.summary, /sACN would send DMX onto the network/);
  const refused = await call("gma3_configure_dmx_output", { protocol: "sacn", entries: [{ entry: 1, priority: 250 }], exclusive: true });
  assert.match(refused.text, /priority must be <= 200/);

  const changed = ok(await call("gma3_configure_dmx_output", { protocol: "sacn", entries: [{ entry: 1, local_universe: 3, amount: 2, universe: 300, priority: 120, mode: "Output Unicast" }, { add: true, local_universe: 7, universe: 70 }], grant_request: { universes: [1024], value: "on" }, exclusive: true }), "edit, add, request");
  const s = changed.now.protocols.sacn.entries;
  assert.deepEqual([s[0].localUniverse, s[0].amount, s[0].universe, s[0].priority, s[0].mode, s[0].enabled], [3, 2, 300, 120, "Output Unicast", false]);
  assert.deepEqual([s.at(-1).localUniverse, s.at(-1).universe, s.at(-1).enabled], [7, 70, false]);
  assert.equal(changed.now.protocols.sacn.out, false, "output stayed off");

  ok(await call("gma3_configure_dmx_output", { protocol: "sacn", entries: [{ entry: 1, local_universe: e1.localUniverse, amount: e1.amount, universe: e1.universe, priority: e1.priority, mode: e1.mode }, { entry: s.length, remove: true }], grant_request: { universes: [1024], value: String(restore.request).toLowerCase() }, exclusive: true }), "restore");
  const back = (await call("gma3_dmx_output", {})).result.protocols.sacn.entries;
  assert.deepEqual(back, read.protocols.sacn.entries, "sACN entries as they were");
  restore.entry = undefined;
});
