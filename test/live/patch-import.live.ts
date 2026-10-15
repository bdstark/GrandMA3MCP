/**
 * Live console test for the SU-03 fixture-type tools (gma3_patch_library, gma3_patch_import,
 * gma3_patch_remove_type).
 *
 * Runs only with GMA3_LIVE=1 against a disposable show (see README.md in this folder), AND with
 * GMA3_LIVE_EXCLUSIVE=1: patch changes are committed with no undo and the tools require exclusive use of the
 * console. Not part of `npm test`. Needs bridge 0.26.0.
 *
 * Show objects used:
 *   - Fixture types "Fog" and "Fan" by Generic, imported from the grandMA2 library (generic@fog.pxml,
 *     generic@fan.pxml). The run refuses to start when the show already has either.
 *   - Fixture FID 994, named "MCP live import", one Fan, patched in the first free block from 3.001.
 *   - Imports Fog, refuses a second Fog import (duplicate), imports Fan, patches FID 994 as a Fan, then removes
 *     Fog: Fan, after it, is renumbered while a fixture uses it, which the isolation check must accept. Removing
 *     Fan is refused while FID 994 uses it; then 994 and Fan are removed.
 *   - The attributes the two types bring stay in the show (the console keeps them).
 *   - The cleanup is armed only after the guard passed and FID 994 was proved free; it removes only FID 994
 *     named "MCP live import" and only the types this run imported (by GUID).
 */
import assert from "node:assert/strict";
import { after } from "node:test";
import { MutationLock } from "../../src/mutations.ts";
import { registerPatchTools } from "../../src/tools/patch.ts";
import type { ToolContext } from "../../src/tools/context.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { liveTest, liveEnabled, bridge } from "./live.ts";

const FID = 994;
const MARK = "MCP live import";
const FOG = "generic@fog.pxml";
const FAN = "generic@fan.pxml";
const exclusive = process.env.GMA3_LIVE_EXCLUSIVE === "1";
const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 15000, luaToolAllowed: false };
const tools = captureTools(registerPatchTools, ctx);

async function call(name: string, args: Record<string, unknown>) {
  const res = await tools.get(name)!.call(args);
  const text = res.content.map((c) => c.text).join("\n");
  let result: any;
  try {
    result = JSON.parse(text);
  } catch {
    result = text;
  }
  return { result, isError: Boolean(res.isError), text };
}

const ok = (r: { result: any; isError: boolean; text: string }, what: string) => {
  assert.equal(r.isError, false, `${what}: ${r.text}`);
  assert.equal(r.result.outcome, "succeeded", what);
  assert.equal(r.result.verification.status, "matched", what);
  return r.result;
};

async function fixture994(): Promise<{ fid: number; name: string; type: string } | undefined> {
  const l = await call("gma3_patch_list", { fromFid: FID, toFid: FID });
  return (l.result.fixtures ?? [])[0];
}

async function typeNoByGuid(guid: string): Promise<number | undefined> {
  const t = await call("gma3_patch_types", {});
  return t.result.types.find((x: any) => x.guid === guid)?.no;
}

const cleanup = { armed: false, guids: [] as string[] };

after(async () => {
  if (!liveEnabled || !exclusive || !cleanup.armed) return;
  try {
    const f = await fixture994();
    if (f && typeof f.name === "string" && f.name.startsWith(MARK)) await call("gma3_patch_remove", { fids: [FID], exclusive: true });
    for (const g of [...cleanup.guids].reverse()) {
      const no = await typeNoByGuid(g);
      if (no !== undefined) await call("gma3_patch_remove_type", { type: no, exclusive: true });
    }
  } catch {
    // best effort; the test itself reports what failed
  }
});

liveTest("SU-03 fixture-type tools: search, import, refuse a duplicate, remove with renumbering, refuse a used type", async (t) => {
  if (!exclusive) {
    t.skip("set GMA3_LIVE_EXCLUSIVE=1 to confirm exclusive console use: patch changes are committed with no undo");
    return;
  }
  const search = await call("gma3_patch_library", { query: "generic fog", sources: ["grandma2"] });
  const fogEntry = search.result.entries.find((e: any) => e.file === FOG);
  assert.ok(fogEntry, `${FOG} is in the grandMA2 library`);
  assert.equal(fogEntry.verified, true);
  assert.equal(fogEntry.modesKnown, false, "a .pxml file's modes are known only after the import");
  const fanEntry = (await call("gma3_patch_library", { query: "generic fan", sources: ["grandma2"] })).result.entries.find((e: any) => e.file === FAN);
  assert.ok(fanEntry, `${FAN} is in the grandMA2 library`);
  assert.deepEqual([fogEntry.inShow, fanEntry.inShow], [[], []], "the disposable show must not have Generic Fog or Fan yet");
  assert.equal(await fixture994(), undefined, `FID ${FID} must be free in the disposable show`);
  cleanup.armed = true;

  const fog = ok(await call("gma3_patch_import", { file: FOG, exclusive: true }), "import Fog");
  cleanup.guids.push(fog.type.guid);
  assert.equal(fog.type.name.toLowerCase(), "fog");
  assert.equal(fog.type.manufacturer, "Generic");
  assert.ok(fog.type.modes.length > 0 && fog.type.modes.every((m: any) => typeof m.footprint === "number"), "the imported type's modes have footprints");
  assert.equal(fog.committed, true);

  const dup = await call("gma3_patch_import", { file: FOG, exclusive: true });
  assert.equal(dup.result.outcome, "failed");
  assert.match(dup.result.summary, /nothing was sent.*already has type/);

  const fan = ok(await call("gma3_patch_import", { file: FAN, exclusive: true }), "import Fan");
  cleanup.guids.push(fan.type.guid);
  assert.equal(fan.type.no, fog.type.no + 1, "Fan is appended after Fog");
  const mode = fan.type.modes.find((m: any) => m.breaks === 1 && (m.footprint ?? 0) > 0);
  assert.ok(mode, "Fan has a single-break mode");

  ok(await call("gma3_patch_add", { type: fan.type.no, mode: mode.no, fid: FID, name: MARK, findFreeFrom: "3.001", exclusive: true }), "patch a Fan");
  assert.match((await fixture994())!.type, new RegExp(`^${fan.type.no} `));

  const rmFog = ok(await call("gma3_patch_remove_type", { type: fog.type.no, exclusive: true }), "remove Fog (Fan after it is in use)");
  assert.deepEqual(rmFog.renumbered.find((x: any) => x.name === fan.type.name), { name: fan.type.name, from: fan.type.no, to: fan.type.no - 1 });
  cleanup.guids = cleanup.guids.filter((g) => g !== fog.type.guid);
  assert.match((await fixture994())!.type, new RegExp(`^${fan.type.no - 1} `), "the fixture follows its renumbered type");

  const used = await call("gma3_patch_remove_type", { type: fan.type.no - 1, exclusive: true });
  assert.equal(used.result.outcome, "failed");
  assert.match(used.result.summary, new RegExp(`used by 1 fixture\\(s\\) \\(${FID}\\)`));

  ok(await call("gma3_patch_remove", { fids: [FID], exclusive: true }), "remove FID 994");
  ok(await call("gma3_patch_remove_type", { type: fan.type.no - 1, exclusive: true }), "remove Fan");
  cleanup.guids = [];
  const types = await call("gma3_patch_types", {});
  assert.ok(!types.result.types.some((x: any) => x.guid === fog.type.guid || x.guid === fan.type.guid), "both types are gone");
  const state = (await bridge.request("patch.state", {})) as { atRoot: boolean };
  assert.equal(state.atRoot, true, "the command line is back at Root and the copy is closed");
});
