/**
 * Live, READ-ONLY checks for the inspection ops (FR-07 .. FR-10): fixtureAttributes, programmer,
 * fixtureOutput, dmx, cueContents.
 *
 * Show objects used (read only, nothing is created, changed or deleted, no command is sent):
 *   - Fixtures (the first ones in patch order, via ObjectList("Fixture Thru"); the first with attributes is inspected,
 *     grouping fixtures without a DMX mode are skipped; nothing is hard-coded)
 *   - Sequence 900 Cue 1 (inspected only if it exists; a missing cue skips that case)
 *   - DMX universe 1, addresses 1-16
 *
 * Requires the bridge plugin version 0.3.0 or later running in onPC (the ops answer "unknown op"
 * on an older plugin; see docs/tools/inspection.md "Updating the plugin"). Every case also reads
 * Selection.CountTotalSelected before and after and asserts it did not change.
 *
 * Run:  GMA3_LIVE=1 npm run test:live
 */
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { Gma3Bridge } from "../../src/bridge.ts";
import { liveTest } from "./live.ts";

type Row = Record<string, any>;

async function bridgeVersion(bridge: Gma3Bridge): Promise<string> {
  const ping = (await bridge.request("ping", {}, 4000)) as { bridgeVersion?: string };
  return ping.bridgeVersion ?? "0";
}

function atLeast030(v: string): boolean {
  const [a = 0, b = 0] = v.split(".").map(Number);
  return a > 0 || b >= 3;
}

async function selectionCount(bridge: Gma3Bridge): Promise<string | null> {
  const res = (await bridge.request("objects", { ref: "Selection", fields: ["CountTotalSelected"], limit: 1 })) as Row;
  return res?.items?.[0]?.fields?.CountTotalSelected ?? null;
}

/** Fixture IDs present in the show, in patch order (first `max`), via ObjectList("Fixture Thru"); falls back to 1..10. */
async function fixtureIds(bridge: Gma3Bridge, max = 40): Promise<string[]> {
  try {
    const res = (await bridge.request("objects", { ref: "Fixture Thru", fields: ["FID"], limit: max })) as Row;
    const ids = (res?.items ?? []).map((it: Row) => String(it.fields?.FID ?? "")).filter((f: string) => /^\d+$/.test(f));
    if (ids.length) return ids;
  } catch {
    /* fall through */
  }
  const out: string[] = [];
  for (let n = 1; n <= 10; n++) {
    try {
      const res = (await bridge.request("objects", { ref: `Fixture ${n}`, fields: [], limit: 1 })) as Row;
      if (res?.total >= 1) out.push(String(n));
    } catch {
      /* not found */
    }
  }
  return out;
}

/**
 * The first fixture that actually has attributes (grouping fixtures have none) together with its
 * fixtureAttributes result; null when no candidate qualifies.
 */
async function firstAttributeFixture(bridge: Gma3Bridge): Promise<{ fid: string; attributes: Row } | null> {
  for (const fid of await fixtureIds(bridge)) {
    try {
      const res = (await bridge.request("fixtureAttributes", { ref: `Fixture ${fid}`, limit: 50, offset: 0, includeChannelSets: true })) as Row;
      if (res.total > 0) return { fid, attributes: res };
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/** Shared preamble: skip on an old plugin, remember the selection count, run, assert the selection is untouched. */
function readOnlyCase(name: string, fn: (t: TestContext, bridge: Gma3Bridge) => Promise<void>) {
  liveTest(name, async (t, bridge) => {
    const version = await bridgeVersion(bridge);
    if (!atLeast030(version)) {
      t.skip(`bridge plugin ${version} predates the inspection ops; re-import plugin/gma3_mcp_bridge.lua (0.3.0+)`);
      return;
    }
    const before = await selectionCount(bridge);
    await fn(t, bridge);
    const after = await selectionCount(bridge);
    assert.equal(after, before, "the selection count must not change");
  });
}

readOnlyCase("fixtureAttributes: a patched fixture lists attributes with stable identifiers", async (t, bridge) => {
  const found = await firstAttributeFixture(bridge);
  if (!found) {
    t.skip("no fixture in the show has attributes (only grouping or unpatched fixtures found); patch a fixture with a DMX mode");
    return;
  }
  const { fid, attributes: res } = found;
  assert.equal(res.fid, String(fid), "resolved by fixture ID");
  assert.ok(Number.isInteger(res.subfixtureIndex), "patch index reported separately");
  assert.ok(["uiChannels", "fixtureTypeWalk"].includes(res.source), `source ${res.source}`);
  assert.ok(Array.isArray(res.limitations));
  assert.ok(Array.isArray(res.subfixtures));
  assert.ok(Array.isArray(res.channels));
  assert.ok(res.total >= 1, "at least one attribute");
  for (const row of res.attributes as Row[]) {
    assert.equal(typeof row.attribute, "string", JSON.stringify(row));
    if (res.source === "uiChannels") assert.ok(Number.isInteger(row.uiChannel), "uiChannel index present on the UI channel path");
    if (row.dmx) assert.match(String(row.dmx.coarse), /^\d+\.\d+$/, "coarse address is universe.address");
    if (row.channelSets) assert.ok(Array.isArray(row.channelSets));
  }
  t.diagnostic(`Fixture ${fid}: ${res.total} attributes via ${res.source}, ${res.channels.length} RT channels, ${res.subfixtureCount} subfixtures; limitations: ${JSON.stringify(res.limitations)}`);
  // Any compound fixture in the show: its first subfixture resolves and names where its DMX addresses live.
  const compound = (await Promise.all(
    (await fixtureIds(bridge)).slice(0, 20).map(async (id) => {
      try {
        const r = (await bridge.request("fixtureAttributes", { ref: `Fixture ${id}`, limit: 1 })) as Row;
        return r.subfixtureCount > 0 ? id : null;
      } catch {
        return null;
      }
    }),
  )).find((id) => id !== null);
  if (compound) {
    const sub = (await bridge.request("fixtureAttributes", { ref: `Fixture ${compound}.1`, limit: 20 })) as Row;
    assert.equal(sub.class, "SubFixture");
    assert.equal(sub.isSubfixture, true);
    assert.equal(sub.fid, String(compound));
    assert.ok(["own", "parent", undefined].includes(sub.channelsSource));
    if (sub.channels.length === 0) assert.ok(sub.limitations.some((l: string) => /parent fixture/.test(l)), "a subfixture without own RT channels must point at its parent");
    assert.ok(!sub.limitations.some((l: string) => /unpatched/.test(l)), "a subfixture is never reported as unpatched");
    t.diagnostic(`Fixture ${compound}.1: ${sub.total} attributes, channelsSource=${sub.channelsSource}, limitations=${JSON.stringify(sub.limitations)}`);
  }
  // Pagination: offset past the end gives an empty page with the same total.
  const page = (await bridge.request("fixtureAttributes", { ref: `Fixture ${fid}`, limit: 5, offset: res.total })) as Row;
  assert.equal(page.total, res.total);
  assert.equal(page.count, 0);
});

readOnlyCase("programmer: every scope answers with coverage and never claims emptiness when incomplete", async (t, bridge) => {
  const all = (await bridge.request("programmer", { scope: "all", limit: 100, offset: 0, maxChannels: 20000 }, 30000)) as Row;
  assert.equal(all.source, "programmer");
  assert.equal(typeof all.coverage.complete, "boolean");
  assert.ok(Array.isArray(all.rows));
  assert.ok(Array.isArray(all.limitations));
  if (!all.coverage.complete) assert.ok(all.limitations.length > 0, "incomplete coverage must come with a reason");
  for (const row of all.rows as Row[]) {
    assert.equal(row.present, true);
    assert.ok(Number.isInteger(row.uiChannel));
    assert.ok(Number.isInteger(row.subfixtureIndex));
    assert.equal(typeof row.masks.activeValue, "number");
    assert.equal(typeof row.phaser.supported, "boolean");
    if (row.stepCount === 1) assert.equal(typeof row.value, "number", "single-step rows carry value");
    else assert.equal(row.value, undefined, "multi-step rows do not collapse to one value");
  }
  t.diagnostic(`programmer all: ${all.total} rows, coverage ${JSON.stringify(all.coverage)}, stats ${JSON.stringify(all.stats)}`);
  const sel = (await bridge.request("programmer", { scope: "selection", limit: 100, offset: 0 })) as Row;
  assert.equal(typeof sel.coverage.complete, "boolean");
  assert.ok(Number.isInteger(sel.selectionCount));
  const ids = await fixtureIds(bridge, 5);
  const range = ids.length ? `Fixture ${ids.join(" + ")}` : "Fixture 1 Thru 10";
  const fx = (await bridge.request("programmer", { scope: "fixtures", fixtures: range, limit: 100, offset: 0 })) as Row;
  assert.equal(typeof fx.coverage.complete, "boolean");
  assert.ok(fx.coverage.totalFixtures >= ids.length, "every existing fixture contributes at least its own patch index");
  t.diagnostic(`programmer fixtures (${range}): ${fx.total} rows, coverage ${JSON.stringify(fx.coverage)}`);
});

readOnlyCase("fixtureOutput: values are raw per RT channel or explicitly null when the universe is not granted", async (t, bridge) => {
  const found = await firstAttributeFixture(bridge);
  if (!found) {
    t.skip("no fixture in the show has attributes (only grouping or unpatched fixtures found)");
    return;
  }
  const { fid } = found;
  const res = (await bridge.request("fixtureOutput", { ref: `Fixture ${fid}`, nonzeroOnly: false, limit: 100, offset: 0 })) as Row;
  assert.equal(res.source, "dmx output");
  assert.ok(Array.isArray(res.channels));
  assert.ok(res.limitations.some((l: string) => /cooked output/.test(l)), "cooked-output limitation always stated");
  assert.ok(res.total > 0, "a fixture with attributes has RT channels");
  assert.ok(typeof res.metaSource === "string", `attribute metadata must come from the UI channel API or the type walk (limitations: ${JSON.stringify(res.limitations)})`);
  assert.ok(res.channels.some((row: Row) => typeof row.attribute === "string"), "output rows carry the attribute name");
  assert.ok(!res.limitations.some((l: string) => /could not be walked/.test(l)) || res.metaSource, "walk limitation only when no path worked");
  for (const row of res.channels as Row[]) {
    assert.ok([8, 16, 24].includes(row.bits), JSON.stringify(row));
    if (row.value === undefined || row.value === null) {
      if (row.patched) assert.ok(res.limitations.some((l: string) => /not granted/.test(l)), "null output on a patched channel needs a not-granted limitation");
    } else {
      assert.ok(Number.isInteger(row.value) && row.value >= 0 && row.value <= 2 ** row.bits - 1, JSON.stringify(row));
      assert.equal(row.unit, `raw${row.bits}`);
      if (row.physical !== undefined) assert.equal(row.conversion, "linear from channel function");
    }
  }
  t.diagnostic(`Fixture ${fid}: ${res.total} RT channels; limitations: ${JSON.stringify(res.limitations)}`);
  const nz = (await bridge.request("fixtureOutput", { ref: `Fixture ${fid}`, nonzeroOnly: true, limit: 100, offset: 0 })) as Row;
  assert.ok(nz.total <= res.total);
  for (const row of nz.channels as Row[]) assert.notEqual(row.value, 0);
});

readOnlyCase("dmx: universe 1 addresses 1-16 in raw and percent units", async (t, bridge) => {
  const raw = (await bridge.request("dmx", { universe: 1, from: 1, to: 16, nonzeroOnly: false, percent: false, patched: true })) as Row;
  assert.equal(raw.source, "dmx output");
  assert.equal(raw.unit, "raw8");
  assert.ok(raw.granted === true || raw.granted === false || raw.granted === undefined);
  if (raw.granted === true) {
    assert.equal(raw.count, 16);
    for (const v of raw.values as Row[]) assert.ok(Number.isInteger(v.value) && v.value >= 0 && v.value <= 255, JSON.stringify(v));
  } else {
    assert.equal(raw.count, 0, "a universe that is not granted yields no values, never zeros");
    assert.ok(raw.limitations.some((l: string) => /not granted|unavailable/.test(l)));
  }
  t.diagnostic(`universe 1: granted=${raw.granted} via ${raw.readVia}, patched=${raw.patched}, info=${JSON.stringify(raw.universeInfo)}, limitations=${JSON.stringify(raw.limitations)}`);
  const pct = (await bridge.request("dmx", { universe: 1, from: 1, to: 16, nonzeroOnly: false, percent: true })) as Row;
  assert.equal(pct.unit, "percent");
  for (const v of pct.values as Row[]) assert.ok(v.value >= 0 && v.value <= 100, JSON.stringify(v));
  await assert.rejects(bridge.request("dmx", { universe: 1, from: 0, to: 1 }), /between 1 and 512/);
  await assert.rejects(bridge.request("dmx", { universe: 0, from: 1, to: 1 }), /between 1 and/);
});

readOnlyCase("cueContents: Sequence 900 Cue 1 (if present) exposes parts, recipes and explicit limitations without playback", async (t, bridge) => {
  let exists = false;
  try {
    const res = (await bridge.request("objects", { ref: "Sequence 900 Cue 1", fields: [], limit: 1 })) as Row;
    exists = res?.total >= 1;
  } catch {
    exists = false;
  }
  if (!exists) {
    t.skip("Sequence 900 Cue 1 does not exist in the show");
    return;
  }
  const res = (await bridge.request("cueContents", { sequence: 900, cue: 1, expandPresets: true })) as Row;
  assert.equal(res.trackedValues, "not_reconstructed");
  assert.equal(typeof res.cue.no, "string");
  assert.ok(Array.isArray(res.parts) && res.parts.length >= 1);
  assert.ok(res.limitations.some((l: string) => /tracked values are not reconstructed/.test(l)));
  for (const part of res.parts as Row[]) {
    assert.ok(Number.isInteger(part.part));
    assert.ok(Array.isArray(part.recipes));
    assert.equal(part.storedValues, undefined, "hard values are never fabricated");
    if (part.ownDataPresent === true) assert.ok(res.limitations.some((l: string) => /hard \(non-recipe\)/.test(l)));
    for (const r of part.recipes as Row[]) {
      if (r.preset !== undefined) assert.equal(typeof r.presetResolved, "boolean", "preset reference resolution is explicit");
      if (r.presetResolved && r.presetDataKey) assert.ok(res.presets[r.presetDataKey], "expanded preset data keyed by the recipe's presetDataKey");
    }
  }
  t.diagnostic(`Sequence 900 Cue 1: ${res.parts.length} part(s), presets ${JSON.stringify(Object.keys(res.presets ?? {}))}, limitations ${JSON.stringify(res.limitations)}`);
  const part0 = (await bridge.request("cueContents", { sequence: 900, cue: 1, part: 0 })) as Row;
  assert.equal(part0.parts.length, 1);
  assert.equal(part0.presets, undefined, "presets omitted unless expandPresets");
});
