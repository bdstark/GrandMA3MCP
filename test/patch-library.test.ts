import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.js";
import { BridgeReplyError } from "./helpers/fake-bridge.js";
import { registerPatchTools } from "../src/tools/patch.js";

/**
 * SU-03 tools (gma3_patch_library, gma3_patch_import, gma3_patch_remove_type) against a fake bridge: the copy
 * opens, an import lands and the copy commits on the next poll (a console frame). The bridge ops are covered by
 * test/lua/patch_ops_test.lua; the console behaviour by docs/probes/su-03-import-macos-2.5.1.md.
 */

interface Ty {
  no: number;
  name: string;
  manufacturer: string;
  guid: string;
  modes: Array<{ no: number; name: string; footprint: number }>;
}

const ty = (no: number, name: string, manufacturer: string, guid: string): Ty => ({ no, name, manufacturer, guid, modes: [{ no: 1, name: "Mode 0", footprint: 8 }] });

class LibraryWorld {
  live: Ty[] = [ty(1, "Mega Hex Par", "ADJ", "G-1"), ty(2, "Spare", "Test", "G-2"), ty(3, "Dimmer", "Generic", "G-3")];
  copy: Ty[] | null = null;
  dest = "Root";
  pending: string[] = [];
  usedBy: Record<string, number[]> = { "G-1": [101, 102] };
  /** What an import of a file creates: [manufacturer, name], or "error" (the console answers with an error). */
  creates: Record<string, Array<[string, string]> | "error"> = {
    "oppsk@36pcs 4in1 led wall washer.pxml": [["Oppsk", "36PCS 4in1 LED Wall Washer"]],
    "adj@mega hex par.pxml": [["ADJ", "Mega Hex Par"]],
    "solo@user only@rev2.gdtf": [["Solo", "User Only"]],
    "broken@file.pxml": "error",
    "two@types.pxml": [["Two", "One"], ["Two", "Two"]],
  };
  lastCommand = "";
  attributes = 100;
  attributesBefore = 100;
  library = [
    { source: "grandma2", file: "adj@mega hex par.pxml", format: "pxml", manufacturer: "adj", model: "mega hex par", modesKnown: false, verified: true, set: false },
    { source: "grandma2", file: "oppsk@36pcs 4in1 led wall washer.pxml", format: "pxml", manufacturer: "oppsk", model: "36pcs 4in1 led wall washer", modesKnown: false, verified: true, set: false },
    { source: "grandma2", file: "broken@file.pxml", format: "pxml", manufacturer: "broken", model: "file", modesKnown: false, verified: true, set: false },
    { source: "grandma2", file: "two@types.pxml", format: "pxml", manufacturer: "two", model: "types", modesKnown: false, verified: true, set: false },
    { source: "grandma3", file: "acme@spot.xml", format: "xml", manufacturer: "Acme", model: "spot", name: "Spot", modes: ["Standard"], modesKnown: true, verified: true, set: false },
    { source: "user", file: "acme@spot.xml", format: "xml", manufacturer: "Acme", model: "spot", name: "Spot", modes: ["Standard"], modesKnown: true, verified: false, set: false },
    { source: "user", file: "solo@user only@rev2.gdtf", format: "gdtf", manufacturer: "solo", model: "user only", modesKnown: false, verified: false, set: false },
  ];

  inShow(e: { manufacturer?: string; model?: string; name?: string }) {
    const n = (e.name ?? e.model ?? "").toLowerCase();
    return this.live.filter((t) => t.name.toLowerCase() === n && t.manufacturer.toLowerCase() === (e.manufacturer ?? "").toLowerCase()).map((t) => ({ no: t.no, name: t.name, guid: t.guid }));
  }

  frame() {
    for (const cmd of this.pending) {
      if (cmd === "enter") {
        this.copy = this.live.map((t) => ({ ...t }));
        this.dest = "FixtureTypes";
      } else if (cmd === "root") {
        if (this.copy) this.live = this.copy;
        this.copy = null;
        this.dest = "Root";
      } else if (cmd.startsWith("import:")) {
        const file = cmd.slice(7);
        const what = this.creates[file];
        this.lastCommand = `Import Library "${file}"`;
        if (!this.copy || what === "error" || what === undefined) {
          this.lastCommand = `Error: Object not found (${this.lastCommand})`;
          continue;
        }
        for (const [m, n] of what) this.copy.push(ty(this.copy.length + 1, n, m, `G-new-${n}`));
        this.attributes += 3;
        this.lastCommand = `OK: ${this.lastCommand}`;
      }
    }
    this.pending = [];
  }

  install(h: Harness) {
    const f = h.fake;
    f.on("patch.state", () => {
      this.frame();
      const copyOpen = this.copy !== null;
      return { destination: this.dest, copyOpen, atRoot: this.dest === "Root" && !copyOpen, modal: false, stages: ["Stage 1"] };
    });
    f.on("patch.library", (args) => {
      let rows = this.library;
      if (args.file) rows = rows.filter((e) => e.file === args.file);
      if (Array.isArray(args.sources)) rows = rows.filter((e) => (args.sources as string[]).includes(e.source));
      if (typeof args.query === "string") {
        const words = (args.query as string).toLowerCase().split(/\s+/);
        rows = rows.filter((e) => words.every((w) => `${e.manufacturer} ${e.model} ${e.file}`.toLowerCase().includes(w)));
      }
      const entries = rows.map((e) => ({ ...e, inShow: this.inShow(e) }));
      return { total: entries.length, offset: 0, count: entries.length, entries };
    });
    f.on("patch.enter", (args) => {
      if (args.exclusive !== true) throw new BridgeReplyError("[not-exclusive] needs exclusive", "not-exclusive");
      if (this.copy) throw new BridgeReplyError("[copy-open] open", "copy-open");
      this.pending.push("enter");
      return args.target === "fixturetypes" ? { queued: true, target: "fixturetypes", expectDestination: "FixtureTypes" } : { queued: true, stage: "Stage 1", expectDestination: "FixtureTypes" };
    });
    f.on("patch.import", (args) => {
      if (!this.copy || this.dest !== "FixtureTypes") throw new BridgeReplyError("[wrong-destination] not at FixtureTypes", "wrong-destination");
      this.pending.push(`import:${args.file}`);
      this.attributesBefore = this.attributes;
      return { queued: true, command: `Import Library "${args.file}"`, typesBefore: this.copy.length, attributesBefore: this.attributes };
    });
    f.on("patch.importState", (args) => {
      this.frame();
      if (!this.copy) throw new BridgeReplyError("[copy-closed] not open", "copy-closed");
      const before = args.typesBefore as number;
      return { destination: this.dest, types: this.copy.length, added: this.copy.slice(before), attributes: this.attributes, lastCommand: this.lastCommand };
    });
    f.on("patch.typeInfo", (args) => {
      const t = this.live.find((x) => x.no === args.type || x.name === args.type);
      if (!t) throw new BridgeReplyError(`[no-type] no fixture type ${args.type}`, "no-type");
      return { type: { ...t, usedBy: this.usedBy[t.guid] ?? [], realUsed: (this.usedBy[t.guid] ?? []).length } };
    });
    f.on("patch.removeType", (args) => {
      if (!this.copy) throw new BridgeReplyError("[copy-closed] not open", "copy-closed");
      const i = this.copy.findIndex((x) => x.no === args.type);
      if (i < 0 || this.copy[i].guid !== args.guid) throw new BridgeReplyError("[guid-mismatch] no", "guid-mismatch");
      const [removed] = this.copy.splice(i, 1);
      const renumbered = this.copy.slice(i).map((x) => ({ name: x.name, from: x.no, to: x.no - 1 }));
      for (const x of this.copy.slice(i)) x.no -= 1;
      return { removed, renumbered, types: this.copy.length };
    });
    f.on("patch.collections", () => ({ copyOpen: this.copy !== null, live: ["AttributeDefinitions", "FixtureTypes"], copy: this.copy ? ["AttributeDefinitions", "FixtureTypes"] : false }));
    f.on("patch.fingerprint", (args) => {
      // FixtureTypes hashed by identity (GUIDs) in order; prefixOfLive limits the copy to the live count,
      // excludeGuids leaves types out of the live side; AttributeDefinitions by count, prefix-limited the same way.
      const side = args.side === "copy" ? this.copy ?? [] : this.live;
      const excl = new Set((args.excludeGuids as string[]) ?? []);
      let list = side.filter((x) => !excl.has(x.guid));
      if (args.prefixOfLive) list = list.slice(0, this.live.length);
      if (args.collection === "FixtureTypes") return { objects: list.length, hash: list.map((x) => x.guid).join(","), complete: true };
      const attrs = args.side === "copy" && !args.prefixOfLive && this.copy ? this.attributes : this.attributesBefore;
      return { objects: attrs, hash: String(attrs), complete: true };
    });
    f.on("patch.commit", (args) => {
      if (args.exclusive !== true) throw new BridgeReplyError("[not-exclusive] needs exclusive", "not-exclusive");
      this.pending.push("root");
      return { queued: true };
    });
    f.on("patch.types", () => ({ count: this.live.length, types: this.live }));
  }
}

async function setup() {
  const h = await startHarness(registerPatchTools);
  const w = new LibraryWorld();
  w.install(h);
  return { h, w, ops: () => h.fake.requests.map((r) => r.op) };
}

const stepNames = (r: any) => r.steps.map((s: any) => `${s.name}:${s.status}`);

test("gma3_patch_library passes the search through, include_sets as includeSets", async () => {
  const { h } = await setup();
  try {
    const { result } = await h.callJson("gma3_patch_library", { query: "oppsk wall", sources: ["grandma2"], include_sets: true, limit: 5 });
    assert.equal(result.total, 1);
    assert.equal(result.entries[0].file, "oppsk@36pcs 4in1 led wall washer.pxml");
    const req = h.fake.requests.find((r) => r.op === "patch.library")!;
    assert.deepEqual(req.args, { query: "oppsk wall", sources: ["grandma2"], includeSets: true, limit: 5 });
  } finally {
    await h.close();
  }
});

test("gma3_patch_import: the whole session, committed and read back with the new type's modes", async () => {
  const { h, w } = await setup();
  try {
    const { result, isError } = await h.callJson("gma3_patch_import", { file: "oppsk@36pcs 4in1 led wall washer.pxml", exclusive: true });
    assert.equal(isError, false, JSON.stringify(result, null, 2));
    assert.equal(result.outcome, "succeeded");
    assert.deepEqual(stepNames(result), ["check_state:succeeded", "check_library:succeeded", "enter:succeeded", "wait_copy:succeeded", "import:succeeded", "wait_import:succeeded", "isolation_check:succeeded", "commit:succeeded", "wait_commit:succeeded", "read_back:succeeded"]);
    assert.equal(result.verification.status, "matched");
    assert.equal(result.type.name, "36PCS 4in1 LED Wall Washer");
    assert.equal(result.type.no, 4);
    assert.equal(result.type.modes[0].footprint, 8);
    assert.equal(result.attributesAdded, 3);
    assert.equal(result.committed, true);
    assert.equal(result.warning, undefined, "a verified library gives no warning");
    const enter = h.fake.requests.find((r) => r.op === "patch.enter")!;
    assert.equal(enter.args.target, "fixturetypes");
    const imp = h.fake.requests.find((r) => r.op === "patch.import")!;
    assert.deepEqual(imp.args, { exclusive: true, file: "oppsk@36pcs 4in1 led wall washer.pxml" });
    const fps = h.fake.requests.filter((r) => r.op === "patch.fingerprint");
    const copyFps = fps.filter((r) => r.args.side === "copy");
    assert.ok(copyFps.every((r) => r.args.prefixOfLive === (r.args.collection === "FixtureTypes" || r.args.collection === "AttributeDefinitions")), "prefixOfLive only where an import appends");
    assert.ok(fps.filter((r) => r.args.side === "live").every((r) => r.args.excludeGuids === undefined));
    assert.equal(w.live.length, 4);
  } finally {
    await h.close();
  }
});

test("gma3_patch_import: refused before anything is sent for a duplicate, an ambiguous or an unknown file, or without exclusive", async () => {
  const { h, ops } = await setup();
  try {
    let r = await h.callJson("gma3_patch_import", { file: "adj@mega hex par.pxml", exclusive: true });
    assert.equal(r.result.outcome, "failed");
    assert.match(r.result.summary, /already has type 1 "Mega Hex Par".*allow_duplicate/);
    assert.ok(!ops().includes("patch.enter"));
    r = await h.callJson("gma3_patch_import", { file: "acme@spot.xml", exclusive: true });
    assert.match(r.result.summary, /more than one library \(grandma3, user\)/);
    r = await h.callJson("gma3_patch_import", { file: "acme@spot.xml", source: "grandma3", exclusive: true });
    assert.match(r.result.summary, /more than one library/, "naming the source does not help: Import Library names the file only");
    r = await h.callJson("gma3_patch_import", { file: "nobody@nothing.pxml", exclusive: true });
    assert.match(r.result.summary, /is not in the fixture-type library/);
    assert.ok(!ops().includes("patch.enter"));
    r = await h.callJson("gma3_patch_import", { file: "x.pxml" });
    assert.match(r.result.validationErrors.join(" "), /exclusive must be true/);
    r = await h.callJson("gma3_patch_import", { file: 'bad"name.pxml', exclusive: true });
    assert.match(r.result.validationErrors.join(" "), /quote/);
    r = await h.callJson("gma3_patch_import", { file: "x.pxml", source: "elsewhere", exclusive: true });
    assert.equal(r.isError, true, "an unknown source is rejected by the input schema");
  } finally {
    await h.close();
  }
});

test("gma3_patch_import: allow_duplicate imports a second type with the same name", async () => {
  const { h, w } = await setup();
  try {
    const { result } = await h.callJson("gma3_patch_import", { file: "adj@mega hex par.pxml", allow_duplicate: true, exclusive: true });
    assert.equal(result.outcome, "succeeded", JSON.stringify(result, null, 2));
    assert.equal(w.live.filter((t) => t.name === "Mega Hex Par").length, 2);
  } finally {
    await h.close();
  }
});

test("gma3_patch_import: an import the console refuses closes the unchanged copy", async () => {
  const { h, w } = await setup();
  try {
    const { result } = await h.callJson("gma3_patch_import", { file: "broken@file.pxml", exclusive: true });
    assert.equal(result.outcome, "failed");
    assert.match(result.summary, /answered "Error: Object not found/);
    assert.equal(result.copyLeftOpen, false);
    assert.equal(result.committed, false);
    assert.equal(w.copy, null);
    assert.equal(w.live.length, 3);
  } finally {
    await h.close();
  }
});

test("gma3_patch_import: two new types are not claimed and the copy is left open", async () => {
  const { h, w } = await setup();
  try {
    const { result } = await h.callJson("gma3_patch_import", { file: "two@types.pxml", exclusive: true });
    assert.equal(result.outcome, "failed");
    assert.match(result.summary, /2 types appeared instead of one/);
    assert.equal(result.copyLeftOpen, true);
    assert.equal(w.live.length, 3, "nothing was committed");
  } finally {
    await h.close();
  }
});

test("gma3_patch_import: a user-library file imports with a warning", async () => {
  const { h } = await setup();
  try {
    const { result } = await h.callJson("gma3_patch_import", { file: "solo@user only@rev2.gdtf", exclusive: true });
    assert.equal(result.outcome, "succeeded", JSON.stringify(result, null, 2));
    assert.equal(result.library.verified, false);
    assert.match(result.warning, /not verified on the console/);
  } finally {
    await h.close();
  }
});

test("gma3_patch_remove_type: removes an unused type by GUID, reports the renumbering, leaves the live side's type out of the check", async () => {
  const { h, w } = await setup();
  try {
    const { result, isError } = await h.callJson("gma3_patch_remove_type", { type: "Spare", exclusive: true });
    assert.equal(isError, false, JSON.stringify(result, null, 2));
    assert.deepEqual(stepNames(result), ["check_state:succeeded", "check_type:succeeded", "enter:succeeded", "wait_copy:succeeded", "remove_type:succeeded", "isolation_check:succeeded", "commit:succeeded", "wait_commit:succeeded", "read_back:succeeded"]);
    assert.equal(result.verification.status, "matched");
    assert.deepEqual(result.renumbered, [{ name: "Dimmer", from: 3, to: 2 }]);
    assert.match(result.note, /Attributes the type brought into the show stay/);
    const rm = h.fake.requests.find((r) => r.op === "patch.removeType")!;
    assert.deepEqual(rm.args, { exclusive: true, type: 2, guid: "G-2" });
    const fps = h.fake.requests.filter((r) => r.op === "patch.fingerprint" && r.args.side === "live");
    assert.ok(fps.every((r) => JSON.stringify(r.args.excludeGuids) === '["G-2"]'));
    assert.deepEqual(w.live.map((t) => `${t.no}:${t.name}`), ["1:Mega Hex Par", "2:Dimmer"]);
  } finally {
    await h.close();
  }
});

test("gma3_patch_remove_type: a type fixtures use is refused before anything is sent", async () => {
  const { h, ops } = await setup();
  try {
    const { result } = await h.callJson("gma3_patch_remove_type", { type: 1, exclusive: true });
    assert.equal(result.outcome, "failed");
    assert.match(result.summary, /used by 2 fixture\(s\) \(101, 102\)/);
    assert.ok(!ops().includes("patch.enter"));
    const r = await h.callJson("gma3_patch_remove_type", { type: "Spare" });
    assert.match(r.result.validationErrors.join(" "), /exclusive must be true/);
  } finally {
    await h.close();
  }
});
