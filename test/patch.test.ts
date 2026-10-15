import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.js";
import { BridgeReplyError, SILENT } from "./helpers/fake-bridge.js";
import { registerPatchTools, blockAddress, dmxAddress } from "../src/tools/patch.js";

/**
 * KB-26 patch tools against a fake bridge whose patch.* ops behave like the bridge's: the copy opens and
 * commits on the next patch.state poll (a console frame), patch.add/set/remove act on the copy only,
 * fingerprints derive from the fixtures minus the excluded FIDs. The bridge ops themselves are covered by
 * test/lua/patch_ops_test.lua; the console behaviour by the KB-25 record and the KB-26 live test.
 */

interface Fx {
  fid: number;
  name: string;
  patch: string;
  mode: string;
  subfixtures?: number;
  type?: string;
  cells?: number;
}

const FP = 8;
const abs = (a: string) => {
  const [u, d] = a.split(".").map(Number);
  return (u - 1) * 512 + d - 1;
};

class PatchWorld {
  live: Fx[] = [
    { fid: 4, name: "Group 4", patch: "", mode: "Default", subfixtures: 2 },
    { fid: 401, name: "Par 1", patch: "1.001", mode: "Ch08" },
    { fid: 402, name: "Par 2", patch: "1.009", mode: "Ch08" },
  ];
  copy: Fx[] | null = null;
  dest = "Root";
  pending: string[] = [];
  modal: false | { name: string } = false;
  foreignInCopy = false;
  /** Frames the copy takes to open (patch.state polls before pending applies). */
  delay = 0;
  neverOpen = false;
  addError: BridgeReplyError | null = null;
  commitSilent = false;
  /** Rows patch.list claims beyond what it serves (an incomplete listing). */
  listTotalExtra = 0;
  /** patch.check reports these fixtures' occupancy as unknown. */
  occupancyUnknown: Array<{ fid: number; reason: string }> = [];
  /** Extra fields of the fixtures patch.add creates (type and cells, SU-08). */
  addExtra: Partial<Fx> = {};

  frame() {
    if (this.delay > 0) {
      this.delay -= 1;
      return;
    }
    for (const cmd of this.pending) {
      if (cmd === "enter") {
        if (this.neverOpen) continue;
        this.copy = this.live.map((f) => ({ ...f }));
        this.dest = "Stage 1.Fixtures";
      } else if (cmd === "root") {
        if (this.copy) this.live = this.copy;
        this.copy = null;
        this.dest = "Root";
        this.foreignInCopy = false;
      }
    }
    this.pending = [];
  }

  occupied(list: Fx[], ignore: Set<number>) {
    return list.filter((f) => f.patch !== "" && !ignore.has(f.fid)).map((f) => [abs(f.patch), abs(f.patch) + FP - 1, f.fid]);
  }

  fingerprint(list: Fx[], exclude: number[], foreign: boolean) {
    const kept = list.filter((f) => !exclude.includes(f.fid));
    return { objects: kept.length, hash: JSON.stringify(kept) + (foreign ? "+foreign" : ""), complete: true };
  }

  install(h: Harness) {
    const f = h.fake;
    f.on("patch.state", () => {
      this.frame();
      const copyOpen = this.copy !== null;
      return { destination: this.dest, copyOpen, atRoot: this.dest === "Root" && !copyOpen, modal: this.modal, stages: ["Stage 1"] };
    });
    f.on("patch.check", (args) => {
      if (args.add) {
        const a = args.add as Record<string, any>;
        const count = a.count ?? 1;
        const fids = Array.from({ length: count }, (_, i) => a.fid + i);
        const res: Record<string, unknown> = {
          type: { no: 6, name: "Mega Hex Par" },
          mode: { no: 3, name: "Ch08", footprint: FP, breaks: 1, breakChannels: [FP] },
          singleBreak: a.mode !== "TwoBreak",
          fidFree: !this.live.some((x) => fids.includes(x.fid)),
        };
        if (a.address) {
          const s = abs(a.address);
          const e = s + FP * count - 1;
          const conflicts = this.occupied(this.live, new Set()).filter(([x, y]) => s <= y && x <= e);
          res.dmxFree = conflicts.length === 0;
          res.conflicts = conflicts;
        }
        if (a.findFreeFrom) {
          res.suggested = "1.017";
          res.suggestedFree = this.occupancyUnknown.length === 0;
        }
        if (this.occupancyUnknown.length) {
          res.occupancyUnknown = this.occupancyUnknown;
          if (a.address) res.dmxFree = false;
        }
        return res;
      }
      if (args.edits) {
        const edits = args.edits as Array<{ fid: number; address?: string }>;
        const moving = new Set(edits.filter((e) => e.address !== undefined).map((e) => e.fid));
        const rows = edits.map((e) => {
          const cur = this.live.find((x) => x.fid === e.fid);
          return cur ? { fid: e.fid, exists: true, singleBreak: true, current: cur } : { fid: e.fid, exists: false };
        });
        const occ = this.occupied(this.live, moving);
        const conflicts: unknown[] = [];
        for (const e of edits) {
          if (!e.address) continue;
          const s = abs(e.address);
          for (const [x, y, fid] of occ) if (s <= y && x <= s + FP - 1) conflicts.push({ fid: e.fid, with: fid });
        }
        return { edits: rows, conflicts, occupancyUnknown: this.occupancyUnknown };
      }
      const fids = args.fids as number[];
      return { fixtures: fids.map((fid) => { const cur = this.live.find((x) => x.fid === fid); return cur ? { fid, exists: true, current: { ...cur, subfixtures: cur.subfixtures ?? 0 } } : { fid, exists: false }; }) };
    });
    f.on("patch.enter", (args) => {
      if (args.exclusive !== true) throw new BridgeReplyError("[not-exclusive] needs exclusive", "not-exclusive");
      if (this.copy) throw new BridgeReplyError("[copy-open] the patch copy is already open", "copy-open");
      this.pending.push("enter");
      return { queued: true, stage: "Stage 1", expectDestination: "Stage 1.Fixtures" };
    });
    f.on("patch.add", (args) => {
      if (!this.copy || this.dest !== `${args.stage}.Fixtures`) throw new BridgeReplyError("[wrong-destination] not at the stage", "wrong-destination");
      if (this.addError) throw this.addError;
      const count = (args.count as number) ?? 1;
      const created: Fx[] = [];
      for (let i = 0; i < count; i++) {
        const addr = args.address ? blockAddress(args.address as string, FP, i) : "";
        const fx = { fid: (args.fid as number) + i, name: (args.name as string) ?? `MHPar06 ${i + 1}`, patch: addr, mode: "Ch08", ...this.addExtra };
        this.copy.push(fx);
        created.push(fx);
      }
      return { added: true, created };
    });
    f.on("patch.set", (args) => {
      if (!this.copy) throw new BridgeReplyError("[copy-closed] not open", "copy-closed");
      const edits = args.edits as Array<{ fid: number; address?: string; name?: string }>;
      for (const e of edits) {
        const fx = this.copy.find((x) => x.fid === e.fid)!;
        if (e.address !== undefined) fx.patch = e.address;
        if (e.name !== undefined) fx.name = e.name;
      }
      return { set: true };
    });
    f.on("patch.remove", (args) => {
      if (!this.copy) throw new BridgeReplyError("[copy-closed] not open", "copy-closed");
      const fids = args.fids as number[];
      this.copy = this.copy.filter((x) => !fids.includes(x.fid));
      return { removed: fids };
    });
    f.on("patch.collections", () => ({ copyOpen: this.copy !== null, live: ["Stages", "FixtureTypes"], copy: this.copy ? ["Stages", "FixtureTypes"] : false }));
    f.on("patch.fingerprint", (args) => {
      const exclude = (args.excludeFids as number[]) ?? [];
      if (args.collection === "FixtureTypes") return { objects: 2, hash: 7, complete: true };
      if (args.side === "copy") return this.fingerprint(this.copy ?? [], exclude, this.foreignInCopy);
      return this.fingerprint(this.live, exclude, false);
    });
    f.on("patch.commit", (args) => {
      if (args.exclusive !== true) throw new BridgeReplyError("[not-exclusive] needs exclusive", "not-exclusive");
      if (this.commitSilent) return SILENT;
      this.pending.push("root");
      return { queued: true };
    });
    f.on("patch.list", (args) => {
      const from = args.fromFid as number | undefined;
      const to = args.toFid as number | undefined;
      const limit = Math.min((args.limit as number) ?? 200, 2000);
      const offset = (args.offset as number) ?? 0;
      const rows = this.live.filter((x) => (from === undefined || x.fid >= from) && (to === undefined || x.fid <= to)).map((x) => ({ ...x, mode: `3 ${x.mode}` }));
      const page = rows.slice(offset, offset + limit);
      return { total: rows.length + this.listTotalExtra, offset, count: page.length, fixtures: page };
    });
    f.on("patch.types", () => ({ count: 2, types: [{ no: 6, name: "Mega Hex Par", manufacturer: "American DJ", shortName: "MHPar06", modes: [] }, { no: 7, name: "Dimmer", manufacturer: "Generic", modes: [] }] }));
  }
}

async function setup() {
  const h = await startHarness(registerPatchTools);
  const w = new PatchWorld();
  w.install(h);
  return { h, w, ops: () => h.fake.requests.map((r) => r.op) };
}

const stepNames = (r: any) => r.steps.map((s: any) => `${s.name}:${s.status}`);

test("patch helpers: DMX addresses and block addressing", () => {
  assert.equal(dmxAddress("a", "2.1"), "2.001");
  assert.equal(dmxAddress("a", " 10.512 "), "10.512");
  assert.throws(() => dmxAddress("a", "0.001"), /universe 1-1024/);
  assert.throws(() => dmxAddress("a", "1.513"), /address 1-512/);
  assert.throws(() => dmxAddress("a", "1:001"), /U\.AAA/);
  assert.equal(dmxAddress("a", undefined, { optional: true }), undefined);
  assert.equal(blockAddress("2.001", 8, 0), "2.001");
  assert.equal(blockAddress("2.001", 8, 2), "2.017");
  assert.equal(blockAddress("1.505", 8, 1), "2.001");
});

test("gma3_patch_add: the whole session in order, committed and read back", async () => {
  const { h, w, ops } = await setup();
  try {
    const { result, isError } = await h.callJson("gma3_patch_add", { type: 6, mode: "Ch08", fid: 901, count: 2, address: "2.1", name: "New Par", exclusive: true });
    assert.equal(isError, false, JSON.stringify(result, null, 2));
    assert.equal(result.outcome, "succeeded");
    assert.equal(result.verification.status, "matched");
    assert.equal(result.committed, true);
    assert.equal(result.copyLeftOpen, false);
    assert.deepEqual(stepNames(result), ["check_state:succeeded", "check_add:succeeded", "enter:succeeded", "wait_copy:succeeded", "add:succeeded", "isolation_check:succeeded", "commit:succeeded", "wait_commit:succeeded", "read_back:succeeded"]);
    const add = h.fake.requests.find((r) => r.op === "patch.add")!;
    assert.deepEqual(add.args, { exclusive: true, stage: "Stage 1", type: 6, mode: "Ch08", fid: 901, count: 2, name: "New Par", address: "2.001" });
    const fp = h.fake.requests.filter((r) => r.op === "patch.fingerprint");
    assert.ok(fp.length === 4 && fp.every((r) => JSON.stringify(r.args.excludeFids) === "[901,902]"), "the isolation check leaves out exactly the touched FIDs, both sides, every collection");
    assert.deepEqual(w.live.filter((x) => x.fid > 900).map((x) => `${x.fid}@${x.patch}`), ["901@2.001", "902@2.009"]);
    assert.ok(ops().indexOf("patch.commit") > ops().indexOf("patch.fingerprint"), "commit only after the isolation check");
  } finally {
    await h.close();
  }
});

test("gma3_patch_add: refused before anything is sent without exclusive, with an open copy, taken FIDs or taken addresses", async () => {
  const { h, w, ops } = await setup();
  try {
    let r = await h.callJson("gma3_patch_add", { type: 6, mode: 3, fid: 901 });
    assert.equal(r.result.outcome, "failed");
    assert.match(r.result.validationErrors.join(" "), /exclusive must be true/);
    assert.equal(ops().length, 0, "nothing at all is sent without exclusive");
    r = await h.callJson("gma3_patch_add", { type: 6, mode: 3, fid: 901, address: "2.001", findFreeFrom: "1.001", exclusive: true });
    assert.match(r.result.validationErrors.join(" "), /address or findFreeFrom, not both/);

    w.copy = w.live.map((x) => ({ ...x }));
    w.dest = "Stage 1.Fixtures";
    r = await h.callJson("gma3_patch_add", { type: 6, mode: 3, fid: 901, exclusive: true });
    assert.equal(r.result.outcome, "failed");
    assert.match(r.result.summary, /nothing was sent.*patch copy is open/);
    assert.deepEqual(ops(), ["patch.state"]);
    w.copy = null;
    w.dest = "Root";

    r = await h.callJson("gma3_patch_add", { type: 6, mode: 3, fid: 402, exclusive: true });
    assert.match(r.result.summary, /FID 402 is not free/);
    r = await h.callJson("gma3_patch_add", { type: 6, mode: 3, fid: 901, address: "1.005", exclusive: true });
    assert.match(r.result.summary, /1\.005 for 1 fixture\(s\) of 8 channels is not free/);
    r = await h.callJson("gma3_patch_add", { type: 6, mode: "TwoBreak", fid: 901, exclusive: true });
    assert.match(r.result.summary, /multi-break modes are not supported/);
    assert.ok(!ops().includes("patch.enter"), "no session was started for any refusal");
  } finally {
    await h.close();
  }
});

test("gma3_patch_add: findFreeFrom patches at the suggested block", async () => {
  const { h } = await setup();
  try {
    const { result } = await h.callJson("gma3_patch_add", { type: 6, mode: 3, fid: 901, findFreeFrom: "1.001", exclusive: true });
    assert.equal(result.outcome, "succeeded", result.summary);
    assert.equal(result.address, "1.017");
    assert.equal(h.fake.requests.find((r) => r.op === "patch.add")!.args.address, "1.017");
  } finally {
    await h.close();
  }
});

test("gma3_patch_add: a refused edit closes the unchanged copy again; nothing is committed", async () => {
  const { h, w } = await setup();
  try {
    w.addError = new BridgeReplyError("[add-failed] AddFixtures did not report success; the 0 fixture(s) it created were deleted from the copy again", "add-failed", { removed: 0 });
    const { result, isError } = await h.callJson("gma3_patch_add", { type: 6, mode: 3, fid: 901, address: "2.001", exclusive: true });
    assert.equal(isError, true);
    assert.equal(result.outcome, "failed");
    assert.equal(result.committed, false);
    assert.equal(result.copyLeftOpen, false);
    assert.match(result.summary, /closed again without changes; the show is unchanged/);
    assert.deepEqual(stepNames(result).slice(4), ["add:failed", "isolation_check:skipped", "commit:skipped", "wait_commit:skipped", "close_check:succeeded", "close:succeeded", "wait_close:succeeded"]);
    assert.equal(w.copy, null);
    const closeFp = h.fake.requests.filter((r) => r.op === "patch.fingerprint").map((r) => r.args.excludeFids);
    assert.ok(closeFp.every((x) => JSON.stringify(x) === "[]"), "closing compares the whole copy, nothing left out");
  } finally {
    await h.close();
  }
});

test("gma3_patch_add: a foreign change found by the isolation check commits nothing and leaves the copy open", async () => {
  const { h, w, ops } = await setup();
  try {
    const orig = h.fake.handlerFor("patch.add")!;
    h.fake.on("patch.add", (args, req) => {
      w.foreignInCopy = true; // someone else edits during the session
      return orig(args, req);
    });
    const { result } = await h.callJson("gma3_patch_add", { type: 6, mode: 3, fid: 901, address: "2.001", exclusive: true });
    assert.equal(result.outcome, "failed");
    assert.equal(result.committed, false);
    assert.equal(result.copyLeftOpen, true);
    assert.match(result.summary, /someone else changed the show.*LEFT OPEN/);
    assert.ok(!ops().includes("patch.commit"), "nothing was committed");
    assert.ok(!w.live.some((x) => x.fid === 901));
  } finally {
    await h.close();
  }
});

test("gma3_patch_add: a commit without a reply is unknown", async () => {
  const { h, w } = await setup();
  try {
    w.commitSilent = true;
    const { result } = await h.callJson("gma3_patch_add", { type: 6, mode: 3, fid: 901, address: "2.001", exclusive: true });
    assert.equal(result.outcome, "unknown");
    assert.equal(result.committed, "unknown");
    assert.match(result.summary, /commit got no reply/);
  } finally {
    await h.close();
  }
});

test("gma3_patch_add: a copy that never opens ends unknown, with nothing left open", async () => {
  const { h, w } = await setup();
  try {
    w.neverOpen = true;
    const { result } = await h.callJson("gma3_patch_add", { type: 6, mode: 3, fid: 901, exclusive: true });
    assert.equal(result.outcome, "unknown");
    assert.equal(result.copyLeftOpen, false);
    assert.ok(stepNames(result).includes("wait_copy:unknown") && stepNames(result).includes("add:skipped"));
    assert.ok(!h.fake.requests.some((r) => r.op === "patch.add"));
  } finally {
    await h.close();
  }
});

test("gma3_patch_add: an older bridge without patch ops is reported as such", async () => {
  const h = await startHarness(registerPatchTools);
  try {
    h.fake.on("patch.state", () => ({ destination: "Root", copyOpen: false, atRoot: true, modal: false, stages: ["Stage 1"] }));
    const { result } = await h.callJson("gma3_patch_add", { type: 6, mode: 3, fid: 901, exclusive: true });
    assert.equal(result.outcome, "failed");
    assert.match(result.summary, /older bridge plugin without the patch ops/);
  } finally {
    await h.close();
  }
});

test("gma3_patch_set: swap two fixtures and rename one, committed and read back", async () => {
  const { h, w } = await setup();
  try {
    const { result, isError } = await h.callJson("gma3_patch_set", { edits: [{ fid: 401, address: "1.009" }, { fid: 402, address: "1.001", name: "Swapped" }], exclusive: true });
    assert.equal(isError, false, result.summary);
    assert.equal(result.verification.status, "matched");
    assert.deepEqual(w.live.filter((x) => x.fid > 400).map((x) => `${x.fid}@${x.patch}:${x.name}`), ["401@1.009:Par 1", "402@1.001:Swapped"]);
    assert.deepEqual(h.fake.requests.find((r) => r.op === "patch.set")!.args.edits, [{ fid: 401, address: "1.009" }, { fid: 402, address: "1.001", name: "Swapped" }]);
    assert.ok(h.fake.requests.filter((r) => r.op === "patch.fingerprint").every((r) => JSON.stringify(r.args.excludeFids) === "[401,402]"));
  } finally {
    await h.close();
  }
});

test("gma3_patch_set: unpatch; refusals for missing FIDs, conflicts and empty edits", async () => {
  const { h, w, ops } = await setup();
  try {
    let r = await h.callJson("gma3_patch_set", { edits: [{ fid: 402, unpatch: true }], exclusive: true });
    assert.equal(r.result.outcome, "succeeded", r.result.summary);
    assert.equal(w.live.find((x) => x.fid === 402)!.patch, "");
    const before = ops().length;
    r = await h.callJson("gma3_patch_set", { edits: [{ fid: 777, address: "3.001" }], exclusive: true });
    assert.match(r.result.summary, /no fixture with FID 777/);
    r = await h.callJson("gma3_patch_set", { edits: [{ fid: 401, address: "1.017" }, { fid: 402, address: "1.001" }], exclusive: true });
    assert.equal(r.result.outcome, "succeeded", r.result.summary);
    r = await h.callJson("gma3_patch_set", { edits: [{ fid: 402, address: "1.017" }], exclusive: true });
    assert.match(r.result.summary, /overlap patched fixtures/);
    r = await h.callJson("gma3_patch_set", { edits: [{ fid: 401 }], exclusive: true });
    assert.match(r.result.validationErrors.join(" "), /changes nothing/);
    r = await h.callJson("gma3_patch_set", { edits: [{ fid: 401, address: "1.001", unpatch: true }], exclusive: true });
    assert.match(r.result.validationErrors.join(" "), /address or unpatch, not both/);
    assert.ok(ops().length > before);
  } finally {
    await h.close();
  }
});

test("gma3_patch_remove: deletes and reads back; refuses fixtures with sub-fixtures and missing FIDs", async () => {
  const { h, w } = await setup();
  try {
    let r = await h.callJson("gma3_patch_remove", { fids: [4], exclusive: true });
    assert.match(r.result.summary, /FID 4 has 2 sub-fixture\(s\)/);
    r = await h.callJson("gma3_patch_remove", { fids: [999], exclusive: true });
    assert.match(r.result.summary, /no fixture with FID 999/);
    r = await h.callJson("gma3_patch_remove", { fids: [401, 401], exclusive: true });
    assert.match(r.result.validationErrors.join(" "), /appears twice/);
    r = await h.callJson("gma3_patch_remove", { fids: [402], exclusive: true });
    assert.equal(r.result.outcome, "succeeded", r.result.summary);
    assert.equal(r.result.verification.status, "matched");
    assert.ok(!w.live.some((x) => x.fid === 402));
    assert.equal(r.result.removed[0].name, "Par 2");
  } finally {
    await h.close();
  }
});

test("gma3_patch_types and gma3_patch_list are plain reads", async () => {
  const { h, ops } = await setup();
  try {
    const t = await h.callJson("gma3_patch_types", { search: "adj" });
    assert.equal(t.isError, false);
    assert.equal(t.result.count, 0);
    const t2 = await h.callJson("gma3_patch_types", { search: "american" });
    assert.equal(t2.result.types[0].name, "Mega Hex Par");
    const l = await h.callJson("gma3_patch_list", { fromFid: 401, toFid: 402 });
    assert.equal(l.result.count, 2);
    assert.deepEqual([...new Set(ops())].sort(), ["patch.list", "patch.types"]);
  } finally {
    await h.close();
  }
});

test("read-back pages through patch.list: FIDs 1 and 2001 are both found (PR #34 review)", async () => {
  const { h, w } = await setup();
  try {
    w.live = [{ fid: 1, name: "First", patch: "", mode: "Ch08" }];
    for (let f = 2; f <= 2000; f++) w.live.push({ fid: f, name: `Filler ${f}`, patch: "", mode: "Ch08" });
    w.live.push({ fid: 2001, name: "Last", patch: "", mode: "Ch08" });
    const { result } = await h.callJson("gma3_patch_set", { edits: [{ fid: 1, name: "First Renamed" }, { fid: 2001, name: "Last Renamed" }], exclusive: true });
    assert.equal(result.outcome, "succeeded", result.summary);
    assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
    const pages = h.fake.requests.filter((r) => r.op === "patch.list").map((r) => r.args.offset);
    assert.deepEqual(pages, [0, 2000], "two pages of 2000 were read");
  } finally {
    await h.close();
  }
});

test("an incomplete listing makes verification unavailable, never a missing fixture", async () => {
  const { h, w } = await setup();
  try {
    w.listTotalExtra = 5; // patch.list claims more rows than it serves
    const { result } = await h.callJson("gma3_patch_set", { edits: [{ fid: 401, name: "Renamed" }], exclusive: true });
    assert.equal(result.outcome, "succeeded", "the change itself was committed");
    assert.equal(result.verification.status, "unavailable");
    assert.match(result.verification.detail, /could not be read back/);
    assert.match(JSON.stringify(result.steps.at(-1)), /read-back is incomplete/);
  } finally {
    await h.close();
  }
});

test("unknown DMX occupancy refuses an add or a readdress before anything is sent, but not a rename (PR #34 review)", async () => {
  const { h, w, ops } = await setup();
  try {
    w.occupancyUnknown = [{ fid: 401, reason: "break 1 is patched at 1.001 but the DMX mode is unavailable" }];
    let r = await h.callJson("gma3_patch_set", { edits: [{ fid: 402, address: "1.001" }], exclusive: true });
    assert.equal(r.result.outcome, "failed");
    assert.match(r.result.summary, /occupancy of 1 patched fixture\(s\) cannot be established \(FID 401/);
    r = await h.callJson("gma3_patch_add", { type: 6, mode: 3, fid: 901, address: "3.001", exclusive: true });
    assert.match(r.result.summary, /cannot be established/);
    r = await h.callJson("gma3_patch_add", { type: 6, mode: 3, fid: 901, findFreeFrom: "3.001", exclusive: true });
    assert.match(r.result.summary, /cannot be established/);
    assert.ok(!ops().includes("patch.enter"), "no session was started");
    r = await h.callJson("gma3_patch_set", { edits: [{ fid: 402, name: "Renamed" }], exclusive: true });
    assert.equal(r.result.outcome, "succeeded", "a rename needs no free space");
  } finally {
    await h.close();
  }
});

test("patch_add: fixtures with cells say their layout is shared, and string lights ask whether each needs its own (SU-08)", async () => {
  const { h, w } = await setup();
  try {
    w.addExtra = { type: "2 Festoon 2 RGB", cells: 40 };
    let r = await h.callJson("gma3_patch_add", { type: 6, mode: 3, fid: 601, address: "3.001", exclusive: true });
    assert.equal(r.result.outcome, "succeeded", JSON.stringify(r.result, null, 2));
    assert.equal(r.result.cellLayout.cells, 40);
    assert.match(r.result.cellLayout.shared, /every fixture of that type and mode shares one cell layout/);
    assert.match(r.result.cellLayout.ask, /Ask the user: should these fixtures share one cell layout/);
    w.addExtra = { type: "1 36PCS 4in1 LED Wall Washer", cells: 12 };
    r = await h.callJson("gma3_patch_add", { type: 6, mode: 3, fid: 611, address: "3.101", exclusive: true });
    assert.equal(r.result.cellLayout.cells, 12);
    assert.equal(r.result.cellLayout.ask, undefined, "a wash with cells is not asked about");
    w.addExtra = {};
    r = await h.callJson("gma3_patch_add", { type: 6, mode: 3, fid: 621, address: "3.201", exclusive: true });
    assert.equal(r.result.cellLayout, undefined);
  } finally {
    await h.close();
  }
});
