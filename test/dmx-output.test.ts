import { test } from "node:test";
import assert from "node:assert/strict";
import { registerDmxOutputTools, explainUniverse } from "../src/tools/dmxoutput.ts";
import { registerInspectionTools } from "../src/tools/inspection.ts";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { BridgeReplyError } from "./helpers/fake-bridge.ts";

/**
 * SU-09: gma3_dmx_output, gma3_configure_dmx_output and the explanations in gma3_fixture_output / gma3_dmx against a
 * fake bridge whose dmx.* ops behave like the bridge's 0.30.0 ops (test/lua/dmx_output_test.lua covers the ops).
 * As on onPC 2.5.1: an invalid Mode is ignored and a Priority above 200 clamps to 200.
 */

type Entry = { index: number; enabled: boolean; mode: string; localUniverse: number; amount: number; universe: number; priority?: number };
class World {
  protocols: Record<"artnet" | "sacn", { out: boolean; in: boolean; entries: Entry[] }> = {
    artnet: { out: false, in: false, entries: [{ index: 1, enabled: false, mode: "Auto", localUniverse: 1, amount: 1, universe: 0 }] },
    sacn: { out: false, in: false, entries: [{ index: 1, enabled: false, mode: "Output Multicast", localUniverse: 1, amount: 1, universe: 1, priority: 100 }] },
  };
  universes = [
    { no: 1, fixtures: 8, granted: false, request: "Auto", portOut: true },
    { no: 2, fixtures: 0, granted: true, request: "Auto", portOut: false },
  ];
  sets: Array<Record<string, unknown>> = [];
  /** The console ignores writes of this property (a value it does not take). */
  ignore?: string;
  state(want: number[] = []) {
    const rows = this.universes
      .filter((u) => u.fixtures > 0 || u.portOut || u.request === "On" || want.includes(u.no))
      .map((u) => ({
        ...u,
        name: `DmxUniverse ${u.no}`,
        outputs: (["artnet", "sacn"] as const).flatMap((p) => this.protocols[p].entries.filter((e) => u.no >= e.localUniverse && u.no < e.localUniverse + e.amount).map((e) => ({ protocol: p, entry: e.index, enabled: e.enabled, mode: e.mode, protocolOut: this.protocols[p].out, as: e.universe + u.no - e.localUniverse }))),
      }));
    const wanted = this.universes.filter((u) => u.fixtures > 0 || u.portOut || u.request === "On");
    return {
      protocols: JSON.parse(JSON.stringify(this.protocols)),
      universes: rows,
      totals: { universes: this.universes.length, used: this.universes.filter((u) => u.fixtures > 0).length, outputWanted: wanted.length, grantedOfWanted: wanted.filter((u) => u.granted).length },
      stations: [{ name: "onpc", ip: "192.168.2.162" }],
    };
  }
  install(h: Harness) {
    const f = h.fake;
    f.on("dmx.output", (args) => this.state((args.universes as number[]) ?? []));
    f.on("dmx.set", (args) => {
      this.sets.push(args);
      if (args.exclusive !== true) throw new BridgeReplyError("[not-exclusive] x", "not-exclusive");
      const prop = String(args.property);
      const value = String(args.value);
      const yn = (b: boolean) => (b ? "Yes" : "No");
      // As the bridge: the reply carries the value read back right after the write.
      if (args.target === "protocol") {
        const p = this.protocols[args.protocol as "artnet"];
        if (prop === "Out" && prop !== this.ignore) p.out = value === "Yes";
        return { property: prop, value: yn(p.out) };
      }
      if (args.target === "universe") {
        const u = this.universes.find((x) => x.no === args.universe)!;
        if (prop !== this.ignore) u.request = value;
        return { property: prop, value: u.request };
      }
      const e = this.protocols[args.protocol as "artnet"].entries.find((x) => x.index === args.index);
      if (!e) throw new BridgeReplyError("[no-entry] none", "no-entry");
      if (prop !== this.ignore) {
        if (prop === "Enabled") e.enabled = value === "Yes";
        if (prop === "LocalUniverse") e.localUniverse = Number(value);
        if (prop === "Amount") e.amount = Number(value);
        if (prop === "Art-NetAbsolute" || prop === "sACNUniverse") e.universe = Number(value);
        if (prop === "Mode") e.mode = value;
        if (prop === "Priority") e.priority = Math.min(200, Number(value));
      }
      const now: Record<string, unknown> = { Enabled: yn(e.enabled), LocalUniverse: e.localUniverse, Amount: e.amount, "Art-NetAbsolute": e.universe, sACNUniverse: e.universe, Mode: e.mode, Priority: e.priority };
      return { property: prop, value: String(now[prop]) };
    });
    f.on("dmx.addEntry", (args) => {
      const list = this.protocols[args.protocol as "artnet"].entries;
      list.push({ index: list.length + 1, enabled: false, mode: args.protocol === "sacn" ? "Output Multicast" : "Auto", localUniverse: 1, amount: 1, universe: args.protocol === "sacn" ? 1 : 0, ...(args.protocol === "sacn" ? { priority: 100 } : {}) });
      return { index: list.length };
    });
    f.on("dmx.removeEntry", (args) => {
      const list = this.protocols[args.protocol as "artnet"].entries;
      list.splice((args.index as number) - 1, 1);
      list.forEach((e, i) => (e.index = i + 1));
      return { count: list.length };
    });
  }
}

async function setup() {
  const h = await startHarness((server, ctx) => {
    registerDmxOutputTools(server, ctx);
    registerInspectionTools(server, ctx);
  });
  const w = new World();
  w.install(h);
  return { h, w };
}
const cfg = (h: Harness, args: Record<string, unknown>) => h.callJson("gma3_configure_dmx_output", args);

test("explainUniverse: idle, not granted, granted but not sent, sent as protocol universes", () => {
  assert.equal(explainUniverse({ no: 9, fixtures: 0, granted: true, request: "Auto", portOut: false }).state, "idle");
  const ng = explainUniverse({ no: 1, fixtures: 8, granted: false, request: "Auto", portOut: true });
  assert.equal(ng.state, "not_granted");
  assert.match(ng.explanation, /8 fixture\(s\) patched\) is not granted: .*connected MA hardware/);
  const off = explainUniverse({ no: 1, fixtures: 8, granted: true, portOut: true, outputs: [{ protocol: "artnet", entry: 1, enabled: true, protocolOut: false, as: 0 }] });
  assert.equal(off.state, "no_protocol_output");
  assert.match(off.explanation, /Art-Net entry 1 is enabled but Art-Net output is off/);
  const sent = explainUniverse({ no: 1, fixtures: 8, granted: true, portOut: true, outputs: [{ protocol: "sacn", entry: 2, enabled: true, protocolOut: true, as: 11, mode: "Output Multicast" }] });
  assert.equal(sent.state, "sent");
  assert.deepEqual(sent.sentAs, ["sACN universe 11 (entry 2, Output Multicast)"]);
});

test("gma3_dmx_output: universes in use with their explanation, both protocols, a summary; fixture_output and dmx explain unreadable universes", async () => {
  const { h } = await setup();
  try {
    const { result } = await h.callJson("gma3_dmx_output", {});
    assert.match(result.summary, /1 universe\(s\) want output .* 0 of them granted.*Not granted: 1/);
    assert.deepEqual(result.universes.map((u: any) => [u.no, u.state]), [[1, "not_granted"]]);
    assert.equal(result.protocols.artnet.entries.length, 1);
    h.fake.on("fixtureOutput", () => ({ channels: [{ attribute: "Dimmer", universe: 1, value: null }], limitations: ["universe 1 not granted: GetDMXValue returned nil"] }));
    const fo = await h.callJson("gma3_fixture_output", { fixture: 101 });
    assert.equal(fo.result.outputState[0].state, "not_granted");
    h.fake.on("dmx", () => ({ granted: false, values: [], limitations: ["universe 1 not granted"] }));
    const d = await h.callJson("gma3_dmx", { universe: 1, from: 1 });
    assert.equal(d.result.outputState.state, "not_granted");
  } finally {
    await h.close();
  }
});

test("configure: validation refuses what the console would ignore or clamp, before anything is sent", async () => {
  const { h, w } = await setup();
  try {
    let r = await cfg(h, { protocol: "sacn", entries: [{ entry: 1, priority: 250 }], exclusive: true });
    assert.match(r.result.validationErrors.join(" "), /priority must be <= 200/);
    r = await cfg(h, { protocol: "artnet", entries: [{ entry: 1, mode: "Banana" }], exclusive: true });
    assert.match(r.result.validationErrors.join(" "), /mode must be one of Auto, Broadcast, Unicast, Input/);
    r = await cfg(h, { protocol: "artnet", entries: [{ entry: 1, amount: 0 }], exclusive: true });
    assert.match(r.result.validationErrors.join(" "), /amount must be >= 1/);
    r = await cfg(h, { protocol: "artnet", entries: [{ entry: 1, local_universe: 1000, amount: 50 }], exclusive: true });
    assert.match(r.result.steps.map((s: any) => s.error ?? "").join(" "), /local universes 1000\.\.1049 pass 1024/);
    r = await cfg(h, { protocol: "artnet", entries: [{ entry: 1, priority: 50 }], exclusive: true });
    assert.match(r.result.validationErrors.join(" "), /priority applies to sACN only/);
    r = await cfg(h, { protocol: "artnet", output: false });
    assert.match(r.result.validationErrors.join(" "), /exclusive must be true/);
    r = await cfg(h, { protocol: "artnet", entries: [{ entry: 7, enabled: false }], exclusive: true });
    assert.match(r.result.steps.map((s: any) => s.error ?? "").join(" "), /Art-Net has no entry 7/);
    assert.equal(w.sets.length, 0);
  } finally {
    await h.close();
  }
});

test("configure: turning output on needs network: true; the mapping goes before Enabled, Out last; read back", async () => {
  const { h, w } = await setup();
  try {
    const args = { protocol: "artnet", output: true, entries: [{ entry: 1, local_universe: 1, amount: 2, universe: 300, enabled: true }], exclusive: true };
    let r = await cfg(h, args);
    assert.equal(r.result.outcome, "failed");
    assert.match(r.result.steps.map((s: any) => s.error ?? "").join(" "), /Art-Net would send DMX onto the network .* pass network: true/);
    assert.equal(w.sets.length, 0);
    r = await cfg(h, { ...args, network: true });
    assert.equal(r.isError, false, JSON.stringify(r.result, null, 2));
    assert.equal(r.result.verification.status, "matched");
    assert.deepEqual(w.sets.map((s) => s.property), ["Amount", "Art-NetAbsolute", "Enabled", "Out"], "only what changes; Enabled after the mapping; Out last");
    assert.equal(r.result.now.universes[0].state, "not_granted", "sent by Art-Net now, but universe 1 is still not granted");
    assert.equal(r.result.previous.protocols.artnet.out, false);
    // Turning output off: Out first, no network confirmation needed.
    w.sets = [];
    r = await cfg(h, { protocol: "artnet", output: false, entries: [{ entry: 1, enabled: false }], exclusive: true });
    assert.equal(r.result.verification.status, "matched");
    assert.deepEqual(w.sets.map((s) => s.property), ["Out", "Enabled"]);
  } finally {
    await h.close();
  }
});

test("configure: add and remove entries, grant requests; a value the console ignores is a mismatch", async () => {
  const { h, w } = await setup();
  try {
    let r = await cfg(h, { protocol: "sacn", entries: [{ add: true, local_universe: 5, amount: 2, universe: 50, priority: 120 }, { add: true, local_universe: 9, universe: 90 }], grant_request: { universes: [1], value: "on" }, exclusive: true });
    assert.equal(r.result.verification.status, "matched", JSON.stringify(r.result.verification));
    assert.deepEqual(w.protocols.sacn.entries.map((e) => [e.index, e.localUniverse, e.amount, e.universe, e.priority]), [[1, 1, 1, 1, 100], [2, 5, 2, 50, 120], [3, 9, 1, 90, 100]]);
    assert.equal(w.universes[0].request, "On");
    r = await cfg(h, { protocol: "sacn", entries: [{ entry: 3, priority: 90 }, { entry: 2, remove: true }], exclusive: true });
    assert.equal(r.result.verification.status, "matched", JSON.stringify(r.result.verification));
    assert.deepEqual(w.protocols.sacn.entries.map((e) => [e.index, e.localUniverse, e.priority]), [[1, 1, 100], [2, 9, 90]], "entry 3 was edited before entry 2 was removed");
    w.ignore = "Mode";
    r = await cfg(h, { protocol: "sacn", entries: [{ entry: 1, mode: "Output Unicast" }], exclusive: true });
    assert.equal(r.result.verification.status, "mismatched");
    assert.match(r.result.verification.detail, /entry 1 Mode reads Output Multicast, expected Output Unicast/);
  } finally {
    await h.close();
  }
});

test("configure: preview shows the plan and the network note, sends nothing", async () => {
  const { h, w } = await setup();
  try {
    const { result } = await cfg(h, { protocol: "sacn", output: true, entries: [{ entry: 1, enabled: true }], preview: true });
    assert.match(result.summary, /Preview only; nothing was sent.*sACN would send DMX onto the network/);
    assert.deepEqual(result.plan.map((p: any) => p.step), ["sacn entry 1 Enabled", "sacn Out"]);
    assert.equal(w.sets.length, 0);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Review round 1 (PR #55 at e62f358)
// ---------------------------------------------------------------------------

test("configure: a mapping write the console ignores stops the call before Enabled and Out", async () => {
  const { h, w } = await setup();
  try {
    w.ignore = "LocalUniverse";
    const { result } = await cfg(h, { protocol: "artnet", output: true, entries: [{ entry: 1, local_universe: 5, enabled: true }], network: true, exclusive: true });
    assert.equal(result.outcome, "failed");
    assert.deepEqual(w.sets.map((s) => s.property), ["LocalUniverse"], "nothing after the ignored write was sent");
    assert.match(result.steps.map((s: any) => s.error ?? "").join(" "), /the console kept LocalUniverse 1 \(expected 5\)/);
    assert.equal(w.protocols.artnet.entries[0].enabled, false);
    assert.equal(w.protocols.artnet.out, false);
  } finally {
    await h.close();
  }
});

test("configure: an enabled entry is disabled before it is remapped, and enabled again only after", async () => {
  const { h, w } = await setup();
  try {
    w.protocols.sacn.out = true;
    w.protocols.sacn.entries[0].enabled = true;
    let r = await cfg(h, { protocol: "sacn", entries: [{ entry: 1, universe: 100, enabled: false }], exclusive: true });
    assert.equal(r.result.verification.status, "matched", JSON.stringify(r.result.verification));
    assert.deepEqual(w.sets.map((s) => `${s.property}=${s.value}`), ["Enabled=No", "sACNUniverse=100"], "disabled first, then remapped");
    w.protocols.sacn.entries[0].enabled = true;
    w.sets = [];
    r = await cfg(h, { protocol: "sacn", entries: [{ entry: 1, universe: 200 }], network: true, exclusive: true });
    assert.equal(r.result.verification.status, "matched", JSON.stringify(r.result.verification));
    assert.deepEqual(w.sets.map((s) => `${s.property}=${s.value}`), ["Enabled=No", "sACNUniverse=200", "Enabled=Yes"], "an entry that keeps sending is disabled for its remap");
    w.ignore = "sACNUniverse";
    w.sets = [];
    r = await cfg(h, { protocol: "sacn", entries: [{ entry: 1, universe: 300 }], network: true, exclusive: true });
    assert.deepEqual(w.sets.map((s) => `${s.property}=${s.value}`), ["Enabled=No", "sACNUniverse=300"], "a remap that does not take leaves it disabled");
    assert.match(r.result.warnings.join(" "), /sacn entry 1 was disabled for the change and stays disabled/);
  } finally {
    await h.close();
  }
});

test("configure: duplicate or conflicting specs for one entry are refused before anything is sent", async () => {
  const { h, w } = await setup();
  try {
    w.protocols.artnet.entries.push({ index: 2, enabled: false, mode: "Auto", localUniverse: 2, amount: 1, universe: 1 });
    let r = await cfg(h, { protocol: "artnet", entries: [{ entry: 1, remove: true }, { entry: 1, remove: true }], exclusive: true });
    assert.match(r.result.validationErrors.join(" "), /entry 1 appears more than once/);
    r = await cfg(h, { protocol: "artnet", entries: [{ entry: 1, universe: 4 }, { entry: 1, remove: true }], exclusive: true });
    assert.match(r.result.validationErrors.join(" "), /entry 1 appears more than once/);
    assert.equal(w.protocols.artnet.entries.length, 2);
    assert.equal(w.sets.length, 0);
  } finally {
    await h.close();
  }
});

test("configure and explain: input entries never send; turning one to an output mode needs network: true", async () => {
  const { h, w } = await setup();
  try {
    w.universes[0].granted = true;
    w.protocols.sacn.out = true;
    w.protocols.sacn.entries[0] = { ...w.protocols.sacn.entries[0], enabled: true, mode: "Input Multicast" };
    const read = await h.callJson("gma3_dmx_output", {});
    assert.equal(read.result.universes[0].state, "no_protocol_output");
    assert.match(read.result.universes[0].explanation, /sACN entry 1 receives it \(Input Multicast\)/);
    let r = await cfg(h, { protocol: "sacn", entries: [{ entry: 1, mode: "Output Multicast" }], exclusive: true });
    assert.match(r.result.steps.map((s: any) => s.error ?? "").join(" "), /sACN would send DMX onto the network \(entry 1\).*pass network: true/);
    assert.equal(w.sets.length, 0);
    r = await cfg(h, { protocol: "sacn", entries: [{ entry: 1, mode: "Output Multicast" }], network: true, exclusive: true });
    assert.equal(r.result.verification.status, "matched", JSON.stringify(r.result.verification));
    const after = await h.callJson("gma3_dmx_output", {});
    assert.equal(after.result.universes[0].state, "sent");
  } finally {
    await h.close();
  }
});

test("configure: both complete ranges are validated from the current values plus the requested ones", async () => {
  const { h, w } = await setup();
  try {
    w.protocols.artnet.entries[0].amount = 2;
    let r = await cfg(h, { protocol: "artnet", entries: [{ entry: 1, local_universe: 1024 }], exclusive: true });
    assert.match(r.result.steps.map((s: any) => s.error ?? "").join(" "), /local universes 1024\.\.1025 pass 1024/);
    w.protocols.sacn.entries[0].amount = 2;
    r = await cfg(h, { protocol: "sacn", entries: [{ entry: 1, universe: 63999 }], exclusive: true });
    assert.match(r.result.steps.map((s: any) => s.error ?? "").join(" "), /sACN universes 63999\.\.64000 leave 1\.\.63999/);
    r = await cfg(h, { protocol: "artnet", entries: [{ add: true, local_universe: 1, amount: 2, universe: 32767 }], exclusive: true });
    assert.match(r.result.steps.map((s: any) => s.error ?? "").join(" "), /Art-Net universes 32767\.\.32768 leave 0\.\.32767/);
    r = await cfg(h, { protocol: "artnet", entries: [{ add: true, amount: 2 }], exclusive: true });
    assert.match(r.result.validationErrors.join(" "), /an added entry needs local_universe and universe/);
    assert.equal(w.sets.length, 0);
  } finally {
    await h.close();
  }
});
