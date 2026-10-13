import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import {
  registerPresetTools,
  presetId,
  analyzeContent,
  verifyStored,
  storeCommand,
  rowLayers,
  type ProgrammerRow,
  type PresetRow,
} from "../src/tools/presets.ts";
import { ValidationError } from "../src/validate.ts";

/**
 * A model of the console objects SB-03 touches, with the onPC 2.5.1 behaviour the probe established
 * (docs/probes/sb-03-presets-macos-2.5.1.md):
 *   - Store Preset takes every active programmer value; /Selective, /Global (lowest subfixture of a type holds the
 *     global row, divergent fixtures get selective rows), /Universal (one holder); /Merge, /Overwrite;
 *     /ForceGlobal /Merge removes the selective rows of the stored types;
 *   - a feature-group pool drops other feature groups while the input filter is on (preference or /InputFilter);
 *   - /Embed "Yes" keeps the programmer's preset reference; /KeepActivation "No" deactivates the stored values;
 *   - a locked preset answers "Object locked".
 */
interface Fx {
  id: string;
  sf: number;
  type: string;
  attrs: string[];
  addr: string;
  cells?: string[];
}
const FIXTURES: Record<string, Fx> = {
  "401": { id: "401", sf: 63, type: "Mega Hex Par", attrs: ["Dimmer", "ColorRGB_R", "ColorRGB_B"], addr: "a.401" },
  "402": { id: "402", sf: 64, type: "Mega Hex Par", attrs: ["Dimmer", "ColorRGB_R", "ColorRGB_B"], addr: "a.402" },
  "403": { id: "403", sf: 65, type: "Mega Hex Par", attrs: ["Dimmer", "ColorRGB_R", "ColorRGB_B"], addr: "a.403" },
  "501": { id: "501", sf: 10, type: "Wall Washer", attrs: ["Shutter1"], addr: "a.501", cells: ["501.1", "501.2"] },
  "501.1": { id: "501.1", sf: 11, type: "Wall Washer", attrs: ["Dimmer", "ColorRGB_R", "ColorRGB_B"], addr: "a.501.1" },
  "501.2": { id: "501.2", sf: 12, type: "Wall Washer", attrs: ["Dimmer", "ColorRGB_R", "ColorRGB_B"], addr: "a.501.2" },
  "601": { id: "601", sf: 2, type: "Beam", attrs: ["Pan", "Tilt"], addr: "a.601" },
};
const GROUP: Record<string, string> = { Dimmer: "Dimmer", ColorRGB_R: "Color", ColorRGB_B: "Color", Shutter1: "Beam", Pan: "Position", Tilt: "Position" };
const bySf = new Map(Object.values(FIXTURES).map((f) => [f.sf, f]));
const POOLS: Record<number, { name: string; presetMode: string }> = { 2: { name: "Position", presetMode: "Selective" }, 4: { name: "Color", presetMode: "Universal" }, 23: { name: "All 3", presetMode: "Selective" } };

interface Stored {
  name: string;
  lock: string;
  presetMode: string;
  rows: PresetRow[];
  deps: Array<{ valid: boolean; addr?: string; pool?: number; no?: number; name?: string }>;
}

class Console {
  prog: Array<ProgrammerRow & { active: boolean }> = [];
  presets = new Map<string, Stored>();
  prefs: Record<string, string> = { StoreMode: "Ask", StoreSource: "Programmer", ChannelFilter: "Active", StoreLook: "No", PresetMode: "Default", PresetInputFilter: "Yes", StoreEmbedded: "No", StoreMAtricks: "Yes", KeepActivation: "No" };
  /** Store everything as universal whatever the mode (a console that does not honour the option). */
  ignoreMode = false;
  /** Change a preference on store (a console that persists an option). */
  persistOption = false;
  oldBridge = false;
  /** Filter feature-group pools whatever the preference says (a filter the tool cannot predict). */
  filterAlways = false;
  scanLimitations: string[] = [];
  scanIncomplete = false;
  commands: string[] = [];

  set(id: string, attr: string, value: number, extra: Partial<ProgrammerRow> = {}): this {
    const f = FIXTURES[id];
    this.prog = this.prog.filter((r) => !(r.subfixtureIndex === f.sf && r.attribute === attr));
    this.prog.push({ fixture: `fx ${id}`, fid: id.includes(".") ? null : id, subfixtureIndex: f.sf, attribute: attr, value, relative: null, stepCount: 1, phaser: {}, absPreset: null, relPreset: null, active: true, ...extra });
    return this;
  }

  private row(f: Fx, r: ProgrammerRow, mode: string, embed: boolean): PresetRow {
    return { fixture: f.id, attribute: String(r.attribute), sfIndex: f.sf, fixtureType: f.type, mode, value: r.value, fade: r.phaser?.fade ?? null, delay: r.phaser?.delay ?? null, stepCount: 1, absPreset: embed && r.absPreset ? { valid: true, addrNative: r.absPreset.addrNative, addr: "src", pool: 4, no: 1, name: r.absPreset.name } : null, hasAbsolute: true };
  }

  store(c: string): string {
    const m = c.match(/^Store Preset (\d+)\.(\d+) (.*)$/)!;
    const pool = Number(m[1]);
    const key = `${m[1]}.${m[2]}`;
    const opts = m[3];
    const old = this.presets.get(key);
    if (old?.lock) return "Object locked";
    if (this.persistOption) this.prefs.KeepActivation = "Yes";
    const embed = /\/Embed "Yes"/.test(opts);
    const filterOpt = opts.match(/\/InputFilter "(Yes|No)"/)?.[1];
    const filterOn = ((filterOpt ?? this.prefs.PresetInputFilter) === "Yes" || this.filterAlways) && pool < 21;
    let rows = this.prog.filter((r) => r.active);
    if (filterOn) rows = rows.filter((r) => GROUP[String(r.attribute)] === POOLS[pool].name);
    let mode = /\/(Force)?Global/.test(opts) ? "global" : /\/(Force)?Universal/.test(opts) ? "universal" : "selective";
    if (this.ignoreMode) mode = "universal";
    const fresh: PresetRow[] = [];
    if (mode === "selective") for (const r of rows) fresh.push(this.row(bySf.get(r.subfixtureIndex)!, r, "selective", embed));
    else if (mode === "universal") {
      const seen = new Set<string>();
      for (const r of rows) if (!seen.has(String(r.attribute))) { seen.add(String(r.attribute)); fresh.push({ ...this.row(bySf.get(r.subfixtureIndex)!, r, "universal", embed), fixture: "Generic 1", sfIndex: 0, fixtureType: "Moving Head" }); }
    } else {
      const holder = new Map<string, ProgrammerRow>();
      for (const r of [...rows].sort((a, b) => a.subfixtureIndex - b.subfixtureIndex)) {
        const f = bySf.get(r.subfixtureIndex)!;
        const k = `${f.type}|${r.attribute}`;
        const h = holder.get(k);
        if (!h) { holder.set(k, r); fresh.push(this.row(f, r, "global", embed)); }
        else if (h.value !== r.value) fresh.push(this.row(f, r, "selective", embed));
      }
    }
    let result = fresh;
    if (old && /\/Merge/.test(opts)) {
      let kept = old.rows.filter((o) => !fresh.some((n) => n.sfIndex === o.sfIndex && n.attribute === o.attribute));
      if (/\/ForceGlobal/.test(opts)) kept = kept.filter((o) => o.mode !== "selective");
      if (/\/ForceUniversal/.test(opts)) kept = [];
      result = [...kept, ...fresh];
    }
    this.presets.set(key, { name: old?.name ?? `Preset ${m[2]}`, lock: "", presetMode: old?.presetMode ?? (mode[0].toUpperCase() + mode.slice(1)), rows: result, deps: embed ? [{ valid: true, addr: "src", pool: 4, no: 1, name: "Src" }] : [] });
    if (!/\/KeepActivation "Yes"/.test(opts)) for (const r of this.prog) if (rows.includes(r)) r.active = false;
    return "OK";
  }

  storedData(p: Stored): string {
    const modes = new Set(p.rows.map((r) => r.mode));
    return ["selective", "global", "universal"].filter((m) => modes.has(m)).map((m) => m[0].toUpperCase() + m.slice(1)).join("/");
  }

  install(h: Harness): void {
    h.fake.on("preset.context", (args) => {
      if (this.oldBridge) throw new Error("unknown op 'preset.context'");
      const pool = args.pool as number | undefined;
      return { preferences: { ...this.prefs }, preferencesReadable: true, ...(pool !== undefined ? { pool: POOLS[pool] ? { no: pool, exists: true, ...POOLS[pool], inputFilter: "" } : { no: pool, exists: false } } : {}) };
    });
    h.fake.on("preset.read", (args) => {
      if (this.oldBridge) throw new Error("unknown op 'preset.read'");
      const ref = String(args.ref);
      const key = ref.replace(/^Preset /, "");
      const p = this.presets.get(key);
      if (!p) throw new Error(`no object found for '${ref}'`);
      const [pool, no] = key.split(".").map(Number);
      const types: Record<string, string> = {};
      for (const sf of (args.typesFor as number[] | undefined) ?? []) if (bySf.get(sf)) types[String(sf)] = bySf.get(sf)!.type;
      return { ref, addr: `addr.${key}`, no, name: p.name, pool: { no: pool, name: POOLS[pool]?.name ?? "?" }, presetMode: p.presetMode, storedData: this.storedData(p), lock: p.lock, rows: p.rows, count: p.rows.length, dependencies: p.deps, dependenciesReadable: true, types };
    });
    h.fake.on("fixtureAttributes", (args) => {
      const ref = String(args.ref);
      const f = Object.values(FIXTURES).find((x) => `Fixture ${x.id}` === ref || x.addr === ref);
      if (!f) throw new Error(`no object found for '${ref}'`);
      return { subfixtureIndex: f.sf, fixtureType: f.type, attributes: f.attrs.map((a) => ({ attribute: a, featureGroup: GROUP[a] })), subfixtures: (f.cells ?? []).map((c) => ({ name: c, addr: FIXTURES[c].addr, subfixtureIndex: FIXTURES[c].sf, childCount: 0 })) };
    });
    h.fake.on("programmer", () => {
      const rows = this.prog.filter((r) => r.active).map(({ active: _a, ...r }) => r);
      return { rows, total: rows.length, count: rows.length, coverage: { complete: !this.scanIncomplete }, stats: { channelErrors: 0 }, limitations: this.scanLimitations };
    });
    h.fake.on("set", (args) => {
      const key = String(args.ref).replace(/^Preset /, "");
      const p = this.presets.get(key)!;
      if (args.property === "Name" && !p.lock) p.name = String(args.value);
      return { ref: args.ref, property: args.property, value: p.name };
    });
    h.fake.on("cmd", (args) => {
      const c = String(args.command);
      this.commands.push(c);
      if (c.startsWith("Store Preset")) return { feedback: this.store(c) };
      throw new Error(`unexpected command ${c}`);
    });
  }
}

let h: Harness;
let con: Console;
before(async () => {
  h = await startHarness(registerPresetTools);
});
after(async () => {
  await h.close();
});
beforeEach(() => {
  h.fake.reset();
  con = new Console();
  con.install(h);
});

const store = (args: Record<string, unknown>) => h.callJson("gma3_store_preset", { exclusive: true, ...args });
const stepError = (r: any, name: string) => r.steps.find((s: { name: string }) => s.name === name)?.error ?? "";
const sent = () => con.commands.length;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("preset ids, the store command and layers", () => {
  assert.deepEqual(presetId("p", "4.12"), { pool: 4, number: 12 });
  for (const bad of ["4", "4.0", "0.1", "4.10000", "a.b", 4.12]) assert.throws(() => presetId("p", bad), ValidationError, String(bad));
  assert.equal(storeCommand({ pool: 4, number: 12, mode: "global", exists: true, existing: "merge", embed: false, matricks: false, keepActivation: false }), 'Store Preset 4.12 /Programmer /Active /Global /Merge /Embed "No" /MAtricks "No" /KeepActivation "No" /NoConfirmation');
  assert.equal(storeCommand({ pool: 23, number: 1, mode: "selective", exists: false, existing: "refuse", embed: true, matricks: true, keepActivation: true, inputFilter: false }), 'Store Preset 23.1 /Programmer /Active /Selective /Embed "Yes" /MAtricks "Yes" /KeepActivation "Yes" /InputFilter "No" /NoConfirmation');
  assert.equal(storeCommand({ pool: 4, number: 1, force: "universal", exists: true, existing: "merge", embed: false, matricks: false, keepActivation: false }), 'Store Preset 4.1 /Programmer /Active /ForceUniversal /Merge /Embed "No" /MAtricks "No" /KeepActivation "No" /NoConfirmation');
  assert.doesNotMatch(storeCommand({ pool: 4, number: 1, mode: "selective", exists: false, existing: "refuse", embed: false, matricks: false, keepActivation: false }), /Look/, "never /Look: every form of it turns Look on");
  const r = (x: Partial<ProgrammerRow>): ProgrammerRow => ({ subfixtureIndex: 1, attribute: "Dimmer", value: 10, stepCount: 1, ...x });
  assert.deepEqual(rowLayers(r({})), ["absolute"]);
  assert.deepEqual(rowLayers(r({ phaser: { fade: 2, delay: 1 }, relative: 5 })), ["absolute", "relative", "fade", "delay"]);
  assert.deepEqual(rowLayers(r({ stepCount: 3, value: null })), ["phaser"]);
});

test("content analysis refuses everything that was not requested", () => {
  const row = (sf: number, attribute: string, value: number, extra: Partial<ProgrammerRow> = {}): ProgrammerRow => ({ subfixtureIndex: sf, fid: String(sf), attribute, value, stepCount: 1, ...extra });
  const scope = new Map([[63, "401"], [64, "402"]]);
  const scopeFixtures = new Map([["401", [63]], ["402", [64]]]);
  const base = { scope, scopeFixtures, layers: ["absolute" as const], embed: false };
  assert.deepEqual(analyzeContent({ ...base, rows: [row(63, "ColorRGB_R", 1), row(64, "ColorRGB_R", 2)], mode: "selective" }).problems, []);
  const p = (rows: ProgrammerRow[], extra: Record<string, unknown> = {}) => analyzeContent({ ...base, rows, mode: "selective", ...extra }).problems.join(" | ");
  assert.match(p([row(63, "Dimmer", 1), row(64, "Dimmer", 1), row(65, "Dimmer", 1)]), /outside the requested fixtures: 65 Dimmer/);
  assert.match(p([row(63, "Dimmer", 1)]), /fixture 402 has no programmer value/);
  assert.match(p([]), /holds no values/);
  assert.match(p([row(63, "Dimmer", 1), row(64, "Pan", 1)], { attributes: ["Dimmer", "Tilt"] }), /not requested: 64 Pan.*activation group.*\| requested attributes without a programmer value: Tilt/);
  assert.match(p([row(63, "Dimmer", 1, { phaser: { fade: 2 } }), row(64, "Dimmer", 1)]), /layers that were not requested \(fade\)/);
  assert.match(analyzeContent({ ...base, rows: [row(63, "Dimmer", 1), row(64, "Dimmer", 2)], mode: "universal" }).problems.join(), /universal data keeps one value per attribute.*Dimmer/);
  assert.deepEqual(analyzeContent({ ...base, rows: [row(63, "Dimmer", 1), row(64, "Dimmer", 1)], mode: "universal" }).problems, []);
  assert.match(analyzeContent({ ...base, rows: [row(63, "Dimmer", 1), row(64, "Dimmer", 1)], mode: "selective", embed: true }).problems.join(), /no programmer value references a preset/);
  const refRows = [row(63, "Dimmer", 1, { absPreset: { addrNative: "P.4.1" } }), row(64, "Dimmer", 1)];
  assert.match(analyzeContent({ ...base, rows: refRows, mode: "selective" }).warnings.join(), /reference P\.4\.1.*plain values/);
  const filter = { pool: "Color", groups: new Map([["Dimmer", "Dimmer"], ["ColorRGB_R", "Color"]]) };
  assert.match(p([row(63, "ColorRGB_R", 1), row(64, "Dimmer", 1)], { filterGroup: filter }), /input filter would silently drop.*64 Dimmer/);
  assert.match(analyzeContent({ ...base, rows: [row(63, "ColorRGB_R", 1), row(64, "Gobo1", 1)], mode: "selective", filterGroup: filter }).warnings.join(), /feature group of Gobo1 is unknown/);
});

test("verification checks the stored rows by mode, value, layers, references and unexpected content", () => {
  const prow = (sf: number, attribute: string, value: number, extra: Partial<ProgrammerRow> = {}): ProgrammerRow => ({ subfixtureIndex: sf, fid: String(sf), attribute, value, stepCount: 1, ...extra });
  const srow = (sf: number, attribute: string, value: number, mode: string, extra: Partial<PresetRow> = {}): PresetRow => ({ fixture: String(sf), sfIndex: sf, attribute, value, mode, fixtureType: sf > 60 ? "Par" : "Wash", ...extra });
  const types = { "63": "Par", "64": "Par", "11": "Wash" };
  const rows = [prow(63, "R", 100), prow(64, "R", 100), prow(11, "R", 100)];
  const v = (stored: PresetRow[], extra: Record<string, unknown> = {}) => verifyStored({ rows, stored, mode: "global", forced: false, merge: false, embed: false, types, ...extra });
  assert.deepEqual(v([srow(63, "R", 100, "global"), srow(11, "R", 100, "global")]), [], "one global row per type covers the others");
  assert.match(v([srow(63, "R", 100, "global")]).join(), /11 R: neither own nor global data of its fixture type \(Wash\)/);
  assert.match(v([srow(63, "R", 100, "global"), srow(11, "R", 90, "global")]).join(), /11 R: value 100 expected, 90 stored/);
  assert.match(verifyStored({ rows, stored: [srow(63, "R", 100, "global"), srow(64, "R", 100, "selective"), srow(11, "R", 100, "selective")], mode: "selective", forced: false, merge: false, embed: false, types }).join(), /63 R: stored as global data, not selective/);
  assert.match(verifyStored({ rows: [prow(63, "R", 100)], stored: [srow(0, "R", 100, "universal"), srow(64, "B", 1, "universal")], mode: "universal", forced: false, merge: false, embed: false, types }).join(), /unexpected stored content: 64 B/);
  assert.deepEqual(verifyStored({ rows: [prow(63, "R", 100)], stored: [srow(63, "R", 100, "selective"), srow(64, "B", 1, "selective")], mode: "selective", forced: false, merge: true, embed: false, types }), [], "merge keeps other content");
  assert.match(verifyStored({ rows: [prow(63, "D", 50, { phaser: { fade: 2 } })], stored: [srow(63, "D", 50, "selective")], mode: "selective", forced: false, merge: false, embed: false, types }).join(), /fade 2 expected, none stored/);
  const ref = { absPreset: { addrNative: "P.4.1" } };
  assert.match(verifyStored({ rows: [prow(63, "R", 1, ref)], stored: [srow(63, "R", 1, "selective")], mode: "selective", forced: false, merge: false, embed: true, types }).join(), /reference to P\.4\.1 expected, a plain value stored/);
  assert.match(verifyStored({ rows: [prow(63, "R", 1, ref)], stored: [srow(63, "R", 1, "selective", { absPreset: { valid: false } })], mode: "selective", forced: false, merge: false, embed: true, types }).join(), /stored absolute reference is invalid/);
  assert.match(verifyStored({ rows: [prow(63, "R", 1)], stored: [srow(63, "R", 1, "selective", { absPreset: { valid: true, addrNative: "x" } })], mode: "selective", forced: false, merge: false, embed: false, types }).join(), /although embed is false/);
  assert.match(verifyStored({ rows: [prow(63, "R", 1)], stored: [srow(63, "R", 1, "global")], mode: "global", forced: true, merge: true, embed: false, types, storedData: "Selective/Global" }).join(), /not only Global data/);
});

// ---------------------------------------------------------------------------
// gma3_store_preset
// ---------------------------------------------------------------------------

test("invalid requests are refused before anything is sent", async () => {
  for (const [args, re] of [
    [{ preset: "4.1", fixtures: [401] }, /exactly one of mode .* or force/],
    [{ preset: "4.1", fixtures: [401], mode: "selective", force: "global" }, /exactly one of mode/],
    [{ preset: "4.1", fixtures: [401], force: "global" }, /forced conversion merges.*existing: "merge"/],
    [{ preset: "4.1", fixtures: [], mode: "selective" }, /fixtures must be a non-empty list/],
    [{ preset: "4", fixtures: [401], mode: "selective" }, /"<pool>\.<number>"/],
    [{ preset: "4.1", fixtures: ["9007199254740992 Thru 9007199254740992"], mode: "selective" }, /fixture id/],
    [{ preset: "4.1", fixtures: [401], mode: "selective", attributes: ["Color RGB"] }, /attribute name/],
    [{ preset: "4.1", fixtures: [401], mode: "selective", exclusive: false }, /exclusive must be true/],
  ] as const) {
    const { result, isError } = await h.callJson("gma3_store_preset", { exclusive: true, ...args } as Record<string, unknown>);
    assert.equal(isError, true, JSON.stringify(args));
    assert.match(String(result.validationErrors?.join("; ") ?? result), re, JSON.stringify(result));
  }
  const badLayer = await h.callJson("gma3_store_preset", { preset: "4.1", fixtures: [401], mode: "selective", layers: ["colour"], exclusive: true });
  assert.equal(badLayer.isError, true);
  assert.equal(h.fake.requests.length, 0, "nothing may reach the bridge");
});

test("a selective store sends every option explicitly, verifies the rows and the unchanged preferences", async () => {
  con.set("401", "ColorRGB_R", 100).set("402", "ColorRGB_R", 0);
  const { result, isError } = await store({ preset: "4.1", fixtures: [401, 402], mode: "selective", name: "Red" });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
  assert.deepEqual(con.commands, ['Store Preset 4.1 /Programmer /Active /Selective /Embed "No" /MAtricks "No" /KeepActivation "No" /NoConfirmation']);
  assert.equal(con.presets.get("4.1")!.name, "Red");
  assert.deepEqual(result.resulting.rows.map((r: any) => `${r.fixture}:${r.mode}:${r.value}`), ["401:selective:100", "402:selective:0"]);
  assert.equal(result.intended.inputFilter.effective, true);
});

test("a global store across two fixture types verifies per type, and a mode the console did not honour is a mismatch", async () => {
  for (const id of ["401", "402", "501.1", "501.2"]) con.set(id, "ColorRGB_B", 100);
  const g = await store({ preset: "4.2", fixtures: [401, 402, "501.1", "501.2"], mode: "global" });
  assert.equal(g.result.verification.status, "matched", JSON.stringify(g.result.verification));
  assert.deepEqual(con.presets.get("4.2")!.rows.map((r) => `${r.fixture}:${r.mode}`), ["501.1:global", "401:global"]);
  for (const id of ["401", "402"]) con.set(id, "ColorRGB_B", 50);
  con.ignoreMode = true;
  const u = await store({ preset: "4.3", fixtures: [401, 402], mode: "selective" });
  assert.equal(u.isError, true);
  assert.equal(u.result.verification.status, "mismatched");
  assert.match(u.result.verification.detail, /401 ColorRGB_B: stored as universal data, not selective|preset's mode/);
});

test("a fixture's cells are in its scope", async () => {
  con.set("501.1", "Dimmer", 40).set("501.2", "Dimmer", 40);
  const { result } = await store({ preset: "23.1", fixtures: [501], mode: "selective" });
  assert.equal(result.verification.status, "matched", JSON.stringify(result));
});

test("unrequested content, divergent universal values, input-filter drops and an empty programmer are refused", async () => {
  con.set("401", "ColorRGB_R", 100).set("403", "Dimmer", 50);
  const outside = await store({ preset: "4.1", fixtures: [401], mode: "selective" });
  assert.match(stepError(outside.result, "check_content"), /outside the requested fixtures: 403 Dimmer/);
  con.prog = [];
  con.set("401", "ColorRGB_R", 100).set("402", "ColorRGB_R", 40);
  const div = await store({ preset: "4.1", fixtures: [401, 402], mode: "universal" });
  assert.match(stepError(div.result, "check_content"), /universal data keeps one value/);
  con.prog = [];
  con.set("401", "ColorRGB_R", 100).set("401", "Dimmer", 80);
  const drop = await store({ preset: "4.1", fixtures: [401], mode: "selective" });
  assert.match(stepError(drop.result, "check_content"), /Color pool's input filter would silently drop.*401 Dimmer/);
  const intoAll = await store({ preset: "23.1", fixtures: [401], mode: "selective", preview: true });
  assert.equal(intoAll.isError, false, "an All pool has no filter");
  con.prog = [];
  const empty = await store({ preset: "4.1", fixtures: [401], mode: "selective" });
  assert.match(stepError(empty.result, "check_content"), /holds no values/);
  assert.equal(sent(), 0);
});

test("input_filter false stores the attribute the filter would drop, and the result proves it", async () => {
  con.set("401", "ColorRGB_R", 100).set("401", "Dimmer", 80);
  const { result } = await store({ preset: "4.1", fixtures: [401], mode: "selective", input_filter: false });
  assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
  assert.match(con.commands[0], /\/InputFilter "No"/);
  // input_filter: true is predicted even when the operator's preference is off.
  con.prefs.PresetInputFilter = "No";
  con.set("402", "ColorRGB_R", 100).set("402", "Dimmer", 80);
  con.prog = con.prog.filter((r) => r.subfixtureIndex === 64);
  const pre = await store({ preset: "4.2", fixtures: [402], mode: "selective", input_filter: true, preview: true });
  assert.match(stepError(pre.result, "check_content"), /would silently drop/);
  // A drop that was not predicted (the console filters although the tool was told it would not) is a mismatch.
  con.filterAlways = true;
  const unpredicted = await store({ preset: "4.2", fixtures: [402], mode: "selective" });
  assert.equal(unpredicted.result.verification.status, "mismatched");
  assert.match(unpredicted.result.verification.detail, /402 Dimmer: not stored/);
});

test("the StoreLook preference, an incomplete scan, a missing pool and a locked preset are refused; inactive leftovers are not", async () => {
  con.set("401", "Dimmer", 50);
  con.prefs.StoreLook = "Yes";
  const look = await store({ preset: "4.1", fixtures: [401], mode: "selective", input_filter: false });
  assert.match(stepError(look.result, "read_context"), /StoreLook.*no store option turns Look off/);
  con.prefs.StoreLook = "No";
  con.scanIncomplete = true;
  const inc = await store({ preset: "23.1", fixtures: [401], mode: "selective" });
  assert.match(stepError(inc.result, "read_programmer"), /scan was incomplete/);
  con.scanIncomplete = false;
  con.scanLimitations = ["3 channel(s) returned step data with all activity masks zero and were treated as empty"];
  const ok = await store({ preset: "23.1", fixtures: [401], mode: "selective", preview: true });
  assert.equal(ok.isError, false, JSON.stringify(ok.result));
  con.scanLimitations = ["the patch could not be enumerated"];
  const lim = await store({ preset: "23.1", fixtures: [401], mode: "selective", preview: true });
  assert.match(stepError(lim.result, "read_programmer"), /incomplete/);
  con.scanLimitations = [];
  const pool = await store({ preset: "99.1", fixtures: [401], mode: "selective" });
  assert.match(stepError(pool.result, "read_context"), /pool 99 does not exist/);
  con.presets.set("23.2", { name: "Locked", lock: "UL", presetMode: "Selective", rows: [], deps: [] });
  const locked = await store({ preset: "23.2", fixtures: [401], mode: "selective", existing: "overwrite" });
  assert.match(stepError(locked.result, "check_preset"), /is locked/);
  const missingFx = await store({ preset: "23.1", fixtures: [999], mode: "selective" });
  assert.match(stepError(missingFx.result, "resolve_fixtures"), /not in the patch: 999/);
  assert.equal(sent(), 0);
});

test("existing presets need an explicit merge or overwrite; merge keeps other content", async () => {
  con.set("401", "Dimmer", 50);
  await store({ preset: "23.1", fixtures: [401], mode: "selective", keep_activation: true });
  con.set("402", "Dimmer", 70);
  con.prog = con.prog.filter((r) => r.subfixtureIndex === 64);
  const refused = await store({ preset: "23.1", fixtures: [402], mode: "selective" });
  assert.match(stepError(refused.result, "check_preset"), /already exists.*existing: "merge" or "overwrite"/);
  const merged = await store({ preset: "23.1", fixtures: [402], mode: "selective", existing: "merge", keep_activation: true });
  assert.equal(merged.result.verification.status, "matched", JSON.stringify(merged.result.verification));
  assert.match(con.commands.at(-1)!, /\/Selective \/Merge/);
  assert.deepEqual(con.presets.get("23.1")!.rows.map((r) => r.fixture).sort(), ["401", "402"]);
  const over = await store({ preset: "23.1", fixtures: [402], mode: "selective", existing: "overwrite" });
  assert.equal(over.result.verification.status, "matched");
  assert.match(con.commands.at(-1)!, /\/Overwrite/);
  assert.deepEqual(con.presets.get("23.1")!.rows.map((r) => r.fixture), ["402"]);
});

test("embed stores and verifies references; a changed store preference is a mismatch", async () => {
  con.set("401", "ColorRGB_R", 100, { absPreset: { name: "Src", addrNative: "P.4.1" } });
  const noRef = await store({ preset: "23.1", fixtures: [401], mode: "selective" });
  assert.ok(noRef.result.warnings.some((w: string) => /stored as plain values/.test(w)));
  con.set("401", "ColorRGB_R", 100, { absPreset: { name: "Src", addrNative: "P.4.1" } });
  const emb = await store({ preset: "23.2", fixtures: [401], mode: "selective", embed: true });
  assert.equal(emb.result.verification.status, "matched", JSON.stringify(emb.result.verification));
  assert.match(con.commands.at(-1)!, /\/Embed "Yes"/);
  assert.deepEqual(emb.result.resulting.dependencies, [{ preset: 'Preset 4.1 "Src"', valid: true }]);
  con.set("402", "Dimmer", 10);
  con.prog = con.prog.filter((r) => r.subfixtureIndex === 64);
  con.persistOption = true;
  const pref = await store({ preset: "23.3", fixtures: [402], mode: "selective" });
  assert.equal(pref.result.verification.status, "mismatched");
  assert.match(pref.result.verification.detail, /operator store preferences changed: KeepActivation "No" -> "Yes"/);
});

test("a forced conversion merges and checks that only the target data remains", async () => {
  con.set("401", "ColorRGB_R", 100).set("402", "ColorRGB_R", 50);
  await store({ preset: "4.5", fixtures: [401, 402], mode: "global" });
  assert.deepEqual(con.presets.get("4.5")!.rows.map((r) => r.mode), ["global", "selective"]);
  con.set("401", "ColorRGB_R", 20).set("402", "ColorRGB_R", 20);
  const missing = await store({ preset: "4.6", fixtures: [401, 402], force: "global", existing: "merge" });
  assert.match(stepError(missing.result, "check_preset"), /does not exist; a forced conversion needs an existing preset/);
  const f = await store({ preset: "4.5", fixtures: [401, 402], force: "global", existing: "merge" });
  assert.equal(f.result.verification.status, "matched", JSON.stringify(f.result.verification));
  assert.match(con.commands.at(-1)!, /\/ForceGlobal \/Merge/);
  assert.deepEqual(con.presets.get("4.5")!.rows.map((r) => `${r.fixture}:${r.mode}:${r.value}`), ["401:global:20"]);
  assert.ok(f.result.warnings.some((w: string) => /force global/.test(w)));
});

test("preview reads only and returns the command; an old bridge stops in the read phase", async () => {
  con.set("401", "Dimmer", 50);
  const pv = await store({ preset: "23.1", fixtures: [401], mode: "selective", preview: true, exclusive: undefined });
  assert.equal(pv.isError, false, JSON.stringify(pv.result));
  assert.match(pv.result.summary, /Preview only.*Store Preset 23\.1/);
  assert.equal(sent(), 0);
  con.oldBridge = true;
  const old = await store({ preset: "23.1", fixtures: [401], mode: "selective" });
  assert.match(stepError(old.result, "read_context"), /bridge 0\.22\.0/);
});

// ---------------------------------------------------------------------------
// gma3_preset
// ---------------------------------------------------------------------------

test("gma3_preset reads content and follows dependencies, reporting invalid and unreadable ones", async () => {
  con.presets.set("23.1", { name: "Look", lock: "", presetMode: "Selective", rows: [{ fixture: "401", sfIndex: 63, attribute: "ColorRGB_R", mode: "selective", value: 100, absPreset: { valid: true, addrNative: "x", pool: 4, no: 1, name: "Src" } }], deps: [{ valid: true, addr: "Preset 4.1", pool: 4, no: 1, name: "Src" }, { valid: false }] });
  con.presets.set("4.1", { name: "Src", lock: "", presetMode: "Global", rows: [], deps: [{ valid: true, addr: "Preset 4.9", pool: 4, no: 9, name: "Gone" }] });
  const { result, isError } = await h.callJson("gma3_preset", { preset: "23.1" });
  assert.equal(isError, false);
  assert.equal(result.rows[0].embeddedFrom, 'Preset 4.1 "Src"');
  assert.deepEqual(result.dependencies, [{ preset: 'Preset 4.1 "Src"', valid: true }, { preset: null, valid: false }]);
  assert.equal(result.dependencyInspection.complete, false, "4.9 could not be read");
  assert.equal(result.dependencyInspection.depthRead, 1);
  assert.deepEqual(result.dependencyInspection.invalid, [{ from: "Preset 23.1", dependency: "a deleted or invalid preset" }]);
  assert.match(result.dependencyInspection.unreadable.join(), /Preset 4\.9 "Gone" \(not found\)/);
  const pool = await h.callJson("gma3_preset", { pool: 4 });
  assert.equal(pool.result.pool.presetMode, "Universal");
  assert.equal(pool.result.storePreferences.StoreMode, "Ask");
  assert.equal((await h.callJson("gma3_preset", { preset: "4.77" })).result.exists, false);
  assert.equal((await h.callJson("gma3_preset", {})).isError, true);
  assert.equal(sent(), 0);
});

// ---------------------------------------------------------------------------
// Review round 1
// ---------------------------------------------------------------------------

test("universal mode refuses multi-step values before the store, also for a forced conversion", () => {
  const row = (sf: number, steps: number): ProgrammerRow => ({ subfixtureIndex: sf, fid: String(sf), attribute: "Dimmer", value: steps > 1 ? null : 50, stepCount: steps });
  const scope = new Map([[63, "401"], [64, "402"]]);
  const scopeFixtures = new Map([["401", [63]], ["402", [64]]]);
  const base = { scope, scopeFixtures, layers: ["absolute" as const, "phaser" as const], embed: false };
  for (const extra of [{ mode: "universal" as const }, { force: "universal" as const }]) {
    const different = analyzeContent({ ...base, ...extra, rows: [row(63, 2), row(64, 3)] }).problems.join();
    assert.match(different, /multi-step \(phaser\) values cannot be compared/);
    assert.match(different, /differ between fixtures: Dimmer/, "step counts count as a difference");
    assert.match(analyzeContent({ ...base, ...extra, rows: [row(63, 2), row(64, 2)] }).problems.join(), /multi-step \(phaser\) values cannot be compared/, "equal step counts prove nothing either");
  }
  assert.deepEqual(analyzeContent({ ...base, mode: "global", rows: [row(63, 2), row(64, 3)] }).problems, [], "selective/global keep each fixture's phaser");
});

test("relative references are verified like absolute ones, and both sources are reported", () => {
  const prow = (extra: Partial<ProgrammerRow>): ProgrammerRow => ({ subfixtureIndex: 63, fid: "401", attribute: "Pan", value: 50, relative: 10, stepCount: 1, ...extra });
  const srow = (extra: Partial<PresetRow>): PresetRow => ({ fixture: "401", sfIndex: 63, attribute: "Pan", value: 50, relative: 10, mode: "selective", ...extra });
  const v = (r: ProgrammerRow, st: PresetRow, embed: boolean) => verifyStored({ rows: [r], stored: [st], mode: "selective", forced: false, merge: false, embed, types: {} }).join();
  const rel = { relPreset: { addrNative: "P.2.5", name: "Fan" } };
  assert.match(v(prow(rel), srow({}), true), /relative reference to P\.2\.5 expected, a plain value stored/);
  assert.match(v(prow(rel), srow({ relPreset: { valid: false } }), true), /stored relative reference is invalid/);
  assert.match(v(prow(rel), srow({ relPreset: { valid: true, addrNative: "P.2.6" } }), true), /relative reference to P\.2\.5 expected, P\.2\.6 stored/);
  assert.equal(v(prow(rel), srow({ relPreset: { valid: true, addrNative: "P.2.5" } }), true), "");
  assert.match(v(prow({}), srow({ relPreset: { valid: true, addrNative: "P.2.5" } }), false), /a relative reference to P\.2\.5 was stored although embed is false/);
  assert.match(v(prow({ absPreset: { addrNative: "P.2.1" } }), srow({ absPreset: { valid: true, addrNative: "P.2.1" }, relPreset: { valid: true, addrNative: "P.2.9" } }), true), /a relative reference to P\.2\.9 was stored although the programmer value had none/);
  const scope = new Map([[63, "401"]]);
  const plan = analyzeContent({ rows: [prow({ absPreset: { addrNative: "P.2.1" }, ...rel })], scope, scopeFixtures: new Map([["401", [63]]]), layers: ["absolute", "relative"], mode: "selective", embed: false });
  assert.deepEqual(plan.embeddedSources, ["P.2.1 (absolute)", "P.2.5 (relative)"]);
  assert.match(plan.warnings.join(), /P\.2\.1 \(absolute\), P\.2\.5 \(relative\)/);
  const relOnly = analyzeContent({ rows: [prow(rel)], scope, scopeFixtures: new Map([["401", [63]]]), layers: ["absolute", "relative"], mode: "selective", embed: true });
  assert.deepEqual(relOnly.problems, [], "a relative reference alone is something to embed");
});

test("a global row for another fixture type or attribute is unexpected content", () => {
  const rows: ProgrammerRow[] = [{ subfixtureIndex: 63, fid: "401", attribute: "ColorRGB_R", value: 100, stepCount: 1 }];
  const types = { "63": "Par" };
  const holder: PresetRow = { fixture: "401", sfIndex: 63, attribute: "ColorRGB_R", value: 100, mode: "global", fixtureType: "Par" };
  const v = (stored: PresetRow[]) => verifyStored({ rows, stored, mode: "global", forced: false, merge: false, embed: false, types }).join();
  assert.equal(v([holder]), "");
  assert.match(v([holder, { fixture: "601", sfIndex: 2, attribute: "Pan", value: 40, mode: "global", fixtureType: "Beam" }]), /unexpected stored content: 601 Pan/);
  assert.match(v([holder, { fixture: "402", sfIndex: 64, attribute: "Pan", value: 40, mode: "global", fixtureType: "Par" }]), /unexpected stored content: 402 Pan/, "same type, other attribute");
  assert.match(v([holder, { fixture: "701", sfIndex: 5, attribute: "ColorRGB_R", value: 100, mode: "global", fixtureType: "Mover" }]), /unexpected stored content: 701 ColorRGB_R/, "same attribute, other type");
  assert.match(v([holder, { fixture: "?", attribute: "ColorRGB_R", value: 100, mode: "global" }]), /unexpected stored content/, "a global row without a known type is not exempt");
});

test("with embed on, a stored step reference where the programmer step had none is a mismatch", () => {
  const prow: ProgrammerRow = { subfixtureIndex: 63, fid: "401", attribute: "ColorRGB_R", stepCount: 2, steps: [{ absolute: 100, integratedPreset: { addrNative: "P.4.4" } }, { absolute: 0 }], phaser: {} };
  const srow = (second?: PresetRow["steps"] extends Array<infer S> | undefined ? S["integrated"] : never): PresetRow => ({ fixture: "401", sfIndex: 63, attribute: "ColorRGB_R", mode: "selective", stepCount: 2, steps: [{ step: 1, absolute: 100, integrated: { valid: true, addrNative: "P.4.4" } }, { step: 2, absolute: 0, integrated: second ?? null }] });
  const v = (st: PresetRow) => verifyStored({ rows: [prow], stored: [st], mode: "selective", forced: false, merge: false, embed: true, types: {} }).join();
  assert.equal(v(srow()), "");
  assert.match(v(srow({ valid: true, addrNative: "P.4.9" })), /step 2: a reference to P\.4\.9 was stored although the programmer step had none/);
});
