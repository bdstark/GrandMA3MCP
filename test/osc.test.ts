/**
 * SU-18: OSC input and output against an in-process FakeBridge.
 *
 * `FakeOsc` models ShowData().OSCBase as the bridge 0.33.0 ops answer it (display values "Yes"/"No", numbers as
 * text) and the console facts from the probe: a port change takes effect only when input goes off and on, Receive
 * Command runs /cmd, a prefix makes the address /<prefix>/cmd. The loopback test runs once through an injected sender
 * and once over real UDP with a socket that plays the console.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { configureOsc, explainOsc, registerOscTools, testOscInput, type OscState } from "../src/tools/osc.ts";
import { MutationLock } from "../src/mutations.ts";
import type { ToolContext } from "../src/tools/context.ts";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { SILENT } from "./helpers/fake-bridge.ts";

type Line = Record<string, string>;

class FakeOsc {
  base: Record<string, string> = { EnableInput: "Yes", EnableOutput: "No", Interface: "1.1", PreferredIP: "127.0.0.0/8" };
  lines: Line[] = [this.line({ Name: "Helper", Port: "8000", Receive: "Yes", ReceiveCommand: "Yes" })];
  interfaces = [
    { index: 1, name: "lo0", ips: [{ address: "1.1", ip: "127.0.0.1", mask: "255.0.0.0" }] },
    { index: 2, name: "en0", ips: [{ address: "2.1", ip: "192.168.5.59", mask: "255.255.255.0" }] },
  ];
  /** Ports the input socket is bound to: set when input goes on, not when a line's port changes. */
  bound: number[] = [8000];
  vars = new Map<string, string>();
  /** Every write with the sending state right after it (to check intermediate states). */
  log: string[] = [];
  /** property -> value the console keeps instead of the written one (an ignored write). */
  ignore = new Map<string, string>();
  /** Fail the next write of this "property=value" once (answer the old value). */
  failOnce = new Set<string>();
  /** Lose the reply to this "property=value" (the write takes; the bridge never answers). */
  loseReply = new Set<string>();
  interfacesComplete: boolean | undefined = true;
  /** Remove() is ignored by the console (the bridge answers the unchanged count, as a bridge without the check would). */
  removeIgnored = false;
  /** Fields omitted from line reads (unreadable). */
  hidden = new Set<string>();
  deleteIgnored = false;

  line(over: Line = {}): Line {
    return { Name: `OSCData ${this.lines?.length ?? 0 + 1}`, Mode: "UDP", Port: "8000", Prefix: "", DestinationIP: "127.255.255.255", Receive: "No", ReceiveCommand: "No", Send: "No", SendCommand: "No", EchoInput: "No", EchoOutput: "No", Note: "", ...over };
  }
  row(i: number, l: Line) {
    const y = (k: string) => l[k] === "Yes";
    return { index: i, name: l.Name, mode: l.Mode, port: Number(l.Port), prefix: l.Prefix, destinationIp: l.DestinationIP, receive: y("Receive"), receiveCommand: y("ReceiveCommand"), send: y("Send"), sendCommand: y("SendCommand"), echoInput: y("EchoInput"), echoOutput: y("EchoOutput"), note: l.Note };
  }
  state() {
    const lines = this.lines.map((l, i) => {
      const r: Record<string, unknown> = this.row(i + 1, l);
      for (const k of this.hidden) delete r[k];
      return r;
    });
    return { enableInput: this.base.EnableInput === "Yes", enableOutput: this.base.EnableOutput === "Yes", interface: this.base.Interface, preferredIp: this.base.PreferredIP, lines, interfaces: this.interfaces, ...(this.interfacesComplete === undefined ? {} : { interfacesComplete: this.interfacesComplete }) };
  }
  /** What the console does with an OSC /cmd on a port (live behaviour). */
  receive(port: number, address: string, command: string) {
    if (this.base.EnableInput !== "Yes" || !this.bound.includes(port)) return;
    const line = this.lines.find((l) => Number(l.Port) === port && l.ReceiveCommand === "Yes" && address === `${l.Prefix ? `/${l.Prefix}` : ""}/cmd`);
    if (!line) return;
    const m = command.match(/^SetUserVariable "([^"]+)" "([^"]*)"$/);
    if (m) this.vars.set(m[1], m[2]);
  }
  install(h: Harness) {
    h.fake.on("osc.read", () => this.state());
    h.fake.on("osc.set", ({ target, index, property, value, exclusive }) => {
      assert.equal(exclusive, true);
      const o = target === "base" ? this.base : this.lines[Number(index) - 1];
      if (!o) throw new Error(`[no-line] OSC line ${index} does not exist`);
      const p = String(property);
      const before = o[p];
      const key = `${p}=${value}`;
      if (this.failOnce.has(key)) {
        this.failOnce.delete(key);
        return { property: p, before, value: before };
      }
      o[p] = this.ignore.get(p) ?? String(value);
      if (target === "base" && p === "EnableInput") this.bound = o[p] === "Yes" ? this.lines.map((l) => Number(l.Port)) : [];
      this.log.push(`${target}${index ? ` ${index}` : ""} ${p}=${o[p]} out=${this.base.EnableOutput} send=${this.lines.map((l) => `${l.Send}@${l.DestinationIP}:${l.Port}`).join(",")}`);
      if (this.loseReply.has(key)) {
        this.loseReply.delete(key);
        return SILENT;
      }
      return { property: p, before, value: o[p] };
    });
    h.fake.on("osc.addLine", ({ exclusive }) => {
      assert.equal(exclusive, true);
      this.lines.push(this.line({ Name: `OSCData ${this.lines.length + 1}` }));
      return { index: this.lines.length, line: this.row(this.lines.length, this.lines.at(-1)!) };
    });
    h.fake.on("osc.removeLine", ({ index }) => {
      if (this.removeIgnored) return { removed: this.row(Number(index), this.lines[Number(index) - 1]), count: this.lines.length };
      const removed = this.lines.splice(Number(index) - 1, 1)[0];
      return { removed, count: this.lines.length };
    });
    h.fake.on("vars.get", ({ names }) => ({ items: (names as string[]).map((n) => (this.vars.has(n) ? { name: n, exists: true, value: this.vars.get(n), type: "text" } : { name: n, exists: false })) }));
    h.fake.on("vars.delete", ({ name }) => ({ name, deleted: this.deleteIgnored ? false : this.vars.delete(String(name)) }));
  }
}

let h: Harness;
let osc: FakeOsc;
let ctx: ToolContext;
before(async () => {
  h = await startHarness(registerOscTools);
  ctx = { bridge: h.bridge, mutations: new MutationLock(), requestTimeoutMs: 2000, luaToolAllowed: false, osc: { host: "127.0.0.1", port: 8000 } };
});
after(() => h.close());
beforeEach(() => {
  h.fake.reset();
  osc = new FakeOsc();
  osc.install(h);
});
const writes = () => h.fake.requests.filter((r) => r.op.startsWith("osc.") && r.op !== "osc.read").map((r) => (r.op === "osc.set" ? `${r.args.target}${r.args.index ? ` ${r.args.index}` : ""} ${r.args.property}=${r.args.value}` : `${r.op}${r.args.index ? ` ${r.args.index}` : ""}`));
const fakeSend = (port: number, prefix: string | undefined, command: string) => {
  osc.receive(port, `${prefix ? `/${prefix}` : ""}/cmd`, command);
  return Promise.resolve();
};

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

test("gma3_osc: says who can run commands (every interface), where output goes and whether this server's sender reaches a line", async () => {
  const res = await h.callJson("gma3_osc", {});
  assert.equal(res.isError, false, res.text);
  const m = res.result.meaning;
  assert.equal(m.input.acceptsCommands, true);
  assert.deepEqual(m.input.reachableFrom, ["loopback", "en0 192.168.5.59"]);
  assert.match(m.input.explanation, /listens on every interface whatever Interface and PreferredIP say/);
  assert.match(m.input.explanation, /anyone who can reach en0 192\.168\.5\.59 can run commands/);
  assert.equal(m.output.explanation, "output is off");
  assert.equal(res.result.lines[0].port, 8000);

  const s = osc.state() as OscState;
  assert.equal(explainOsc(s, { host: "127.0.0.1", port: 8000 }).serverSender!.matchingLine, 1);
  assert.equal(explainOsc(s, { host: "127.0.0.1", port: 8000, prefix: "gma" }).serverSender!.matchingLine, null);
  assert.match(explainOsc({ ...s, enableInput: false }).input.explanation, /input is off/);

  h.fake.on("osc.read", () => {
    throw new Error("unknown op 'osc.read'");
  });
  const old = await h.callJson("gma3_osc", {});
  assert.equal(old.isError, true);
  assert.match(old.text, /bridge 0\.33\.0/);
});

// ---------------------------------------------------------------------------
// Configure
// ---------------------------------------------------------------------------

test("configure_osc: validation refuses before anything is read or sent", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ exclusive: true }, /nothing to change/],
    [{ enable_output: true }, /exclusive must be true/],
    [{ preferred_ip: "127.0.0.1", exclusive: true }, /IPv4 network/],
    [{ lines: [{ line: 1, prefix: "/gma" }], exclusive: true }, /prefix/],
    [{ lines: [{ line: 1, port: 70000 }], exclusive: true }, /port/],
    [{ lines: [{ line: 1, destination_ip: "host" }], exclusive: true }, /destination_ip/],
    [{ lines: [{ line: 1, mode: "TCP" }], exclusive: true }, /mode is not configurable/],
    [{ lines: [{ line: 1, port: 9000 }, { line: 1, prefix: "x" }], exclusive: true }, /more than once/],
    [{ lines: [{ add: true, line: 2 }], exclusive: true }, /add or line/],
    [{ lines: [{ line: 1, remove: true, port: 1 }], exclusive: true }, /remove takes only line/],
  ];
  for (const [args, re] of cases) {
    const r = await configureOsc(ctx, args);
    assert.equal(r.outcome, "failed", JSON.stringify(args));
    assert.match((r.validationErrors ?? []).join("; "), re, JSON.stringify(args));
  }
  assert.equal(h.fake.requests.length, 0);
});

test("configure_osc: a new command line is refused without network: true while the machine is on a network; with it, the line is added, input re-binds and everything reads back", async () => {
  const spec = { lines: [{ add: true, name: "Tempo", port: 8010, receive_command: true }], exclusive: true };
  const refused = await configureOsc(ctx, spec);
  assert.equal(refused.outcome, "failed");
  assert.match(String(refused.steps.at(-1)!.error), /anyone who can reach en0 192\.168\.5\.59: .*network: true/);
  assert.deepEqual(writes(), []);

  const r = await configureOsc(ctx, { ...spec, network: true });
  assert.equal(r.outcome, "succeeded", JSON.stringify(r.steps));
  assert.equal(r.verification.status, "matched", JSON.stringify(r.verification));
  assert.deepEqual(writes(), ["osc.addLine", "line 2 Name=Tempo", "line 2 Port=8010", "line 2 ReceiveCommand=Yes", "base EnableInput=No", "base EnableInput=Yes"]);
  assert.deepEqual(osc.bound.sort(), [8000, 8010]);
  assert.ok((r.warnings ?? []).some((w) => /now run OSC commands/.test(w)), JSON.stringify(r.warnings));
  assert.match(String(r.rebindNote), /off and on/);
});

test("configure_osc: a port change re-binds input; a loopback-only machine needs no network: true", async () => {
  osc.interfaces = osc.interfaces.slice(0, 1);
  const r = await configureOsc(ctx, { lines: [{ line: 1, port: 8011 }], exclusive: true });
  assert.equal(r.outcome, "succeeded", JSON.stringify(r.steps));
  assert.deepEqual(writes(), ["line 1 Port=8011", "base EnableInput=No", "base EnableInput=Yes"]);
  assert.deepEqual(osc.bound, [8011]);
  // An unchanged value is not written; a request that changes nothing says so.
  const same = await configureOsc(ctx, { lines: [{ line: 1, port: 8011 }], exclusive: true });
  assert.equal(same.verification.status, "matched");
  assert.match(same.summary, /Nothing to change/);
});

test("configure_osc: a write the console ignores stops the call; a refused re-bind enable is reported, not resent", async () => {
  osc.ignore.set("Prefix", "");
  const r = await configureOsc(ctx, { lines: [{ line: 1, prefix: "gma", port: 8012 }], exclusive: true, network: true });
  assert.equal(r.outcome, "partial");
  assert.equal(r.verification.status, "mismatched");
  assert.ok(r.steps.some((s) => s.status === "failed" && /kept Prefix ""/.test(String(s.error))));
  assert.ok(r.steps.some((s) => s.status === "skipped" && s.name === "EnableInput off (re-bind)"));
  osc.ignore.clear();

  // Review round 1: a refused "on" is not resent; the read-back reports input off with the way back.
  osc.failOnce.add("EnableInput=Yes");
  const r2 = await configureOsc(ctx, { lines: [{ line: 1, port: 8013 }], exclusive: true, network: true });
  assert.notEqual(r2.outcome, "succeeded");
  assert.equal(writes().filter((w) => w === "base EnableInput=Yes").length, 1, "the enable is sent once");
  assert.ok((r2.warnings ?? []).some((w) => /reads off now.*enable_input: true/.test(w)), JSON.stringify(r2.warnings));
});

test("configure_osc: a prefix change on a port that already runs commands needs no network: true; a send-only new line does not re-bind", async () => {
  const r = await configureOsc(ctx, { lines: [{ line: 1, prefix: "gma" }], exclusive: true });
  assert.equal(r.outcome, "succeeded", JSON.stringify(r.steps));
  assert.deepEqual(writes(), ["line 1 Prefix=gma"]);
  const out = await configureOsc(ctx, { lines: [{ add: true, name: "Out", send: true, port: 9100, destination_ip: "127.0.0.1" }], exclusive: true });
  assert.equal(out.outcome, "succeeded", JSON.stringify(out.steps));
  assert.ok(!writes().some((w) => /EnableInput/.test(w)), writes().join(", "));
});

test("configure_osc: output to the network needs network: true, to loopback it does not; preview sends nothing", async () => {
  const net = { enable_output: true, lines: [{ line: 1, send: true, destination_ip: "192.168.5.20", port: 9000 }], exclusive: true };
  const pv = await configureOsc(ctx, { ...net, preview: true, exclusive: undefined });
  assert.equal(pv.verification.status, "not_requested");
  assert.match(String(pv.networkNote), /send OSC onto the network to 192\.168\.5\.20:9000/);
  assert.deepEqual(writes(), []);
  const refused = await configureOsc(ctx, net);
  assert.equal(refused.outcome, "failed");
  assert.deepEqual(writes(), []);
  const lo = await configureOsc(ctx, { enable_output: true, lines: [{ line: 1, send: true, destination_ip: "127.0.0.1" }], exclusive: true });
  assert.equal(lo.outcome, "succeeded", JSON.stringify(lo.steps));
  assert.equal(writes().at(-1), "base EnableOutput=Yes", "output goes on last");
});

test("configure_osc: removes lines from the highest number, input off goes first, and the line count is read back", async () => {
  osc.lines.push(osc.line({ Name: "B", Port: "8001" }), osc.line({ Name: "C", Port: "8002" }));
  const r = await configureOsc(ctx, { enable_input: false, lines: [{ line: 2, remove: true }, { line: 3, remove: true }], exclusive: true });
  assert.equal(r.outcome, "succeeded", JSON.stringify(r.steps));
  assert.equal(r.verification.status, "matched");
  assert.deepEqual(writes(), ["base EnableInput=No", "osc.removeLine 3", "osc.removeLine 2"]);
  assert.equal(osc.lines.length, 1);
  const missing = await configureOsc(ctx, { lines: [{ line: 9, port: 1 }], exclusive: true });
  assert.equal(missing.outcome, "failed");
  assert.match(String(missing.steps.at(-1)!.error), /line 9 does not exist/);
});

// --- review round 1 -----------------------------------------------------------------------------

test("review 1: an active sender's Send goes off before its destination changes, and no intermediate state sends to the new address", async () => {
  osc.base.EnableOutput = "Yes";
  Object.assign(osc.lines[0], { Send: "Yes", DestinationIP: "127.0.0.1", Port: "9000" });
  const r = await configureOsc(ctx, { lines: [{ line: 1, destination_ip: "192.168.5.60", send: false }], exclusive: true });
  assert.equal(r.outcome, "succeeded", JSON.stringify(r.steps));
  assert.deepEqual(writes(), ["line 1 Send=No", "line 1 DestinationIP=192.168.5.60"]);
  assert.ok(!osc.log.some((l) => /out=Yes send=Yes@192\.168/.test(l)), osc.log.join("\n"));
  // Still sending afterwards (to loopback): Send off, endpoint, Send back on.
  osc.log = [];
  Object.assign(osc.lines[0], { Send: "Yes", DestinationIP: "127.0.0.1" });
  h.fake.reset();
  osc.install(h);
  const moved = await configureOsc(ctx, { lines: [{ line: 1, destination_ip: "127.0.0.2", port: 9001 }], exclusive: true, network: true });
  assert.equal(moved.outcome, "succeeded", JSON.stringify(moved.steps));
  assert.deepEqual(writes(), ["line 1 Send=No", "line 1 Port=9001", "line 1 DestinationIP=127.0.0.2", "line 1 Send=Yes", "base EnableInput=No", "base EnableInput=Yes"]);
});

test("review 1: an ignored removal stops the call before input is enabled", async () => {
  osc.base.EnableInput = "No";
  osc.removeIgnored = true;
  const r = await configureOsc(ctx, { enable_input: true, lines: [{ line: 1, remove: true }], exclusive: true });
  assert.notEqual(r.outcome, "succeeded");
  assert.ok(r.steps.some((s) => s.name === "remove line 1" && s.status === "failed" && /not removed/.test(String(s.error))), JSON.stringify(r.steps));
  assert.ok(!writes().includes("base EnableInput=Yes"), writes().join(", "));
  assert.equal(osc.base.EnableInput, "No");
});

test("review 1: an uncertain re-bind enable is not resent; the read-back decides", async () => {
  osc.loseReply.add("EnableInput=Yes");
  const short = { ...ctx, requestTimeoutMs: 300 };
  const r = await configureOsc(short, { lines: [{ line: 1, port: 8014 }], exclusive: true, network: true });
  assert.notEqual(r.outcome, "succeeded");
  assert.equal(writes().filter((w) => w === "base EnableInput=Yes").length, 1, writes().join(", "));
  assert.ok(r.steps.some((s) => s.name === "EnableInput on (re-bind)" && s.status === "unknown"), JSON.stringify(r.steps));
  assert.ok(!r.steps.some((s) => /restore/.test(s.name)));
});

test("review 1: incomplete interface discovery is not loopback-only; unreadable flags are not off", async () => {
  osc.base.EnableInput = "No";
  osc.interfaces = [];
  osc.interfacesComplete = false;
  const r = await configureOsc(ctx, { enable_input: true, exclusive: true });
  assert.equal(r.outcome, "failed");
  assert.match(String(r.steps.at(-1)!.error), /interfaces could not all be read.*network: true/);
  assert.deepEqual(writes(), []);
  osc.interfacesComplete = undefined; // an answer without the field (older bridge) is unknown too
  assert.equal((await configureOsc(ctx, { enable_input: true, exclusive: true })).outcome, "failed");
  assert.match(explainOsc(osc.state() as OscState).input.explanation, /input is off/);

  osc.interfacesComplete = true;
  osc.hidden.add("receiveCommand");
  const flags = await configureOsc(ctx, { enable_input: true, exclusive: true, network: true });
  assert.equal(flags.outcome, "failed");
  assert.match(String(flags.steps.at(-1)!.error), /did not report line 1 ReceiveCommand/);
  assert.deepEqual(writes(), []);
  osc.base.EnableInput = "Yes";
  const m = explainOsc(osc.state() as OscState).input;
  assert.equal(m.acceptsCommands, null);
  assert.match(m.explanation, /could not be read on line 1/);
});

test("review 1: the loopback test needs the marker confirmed absent; an unclear answer sends nothing", async () => {
  osc.vars.set("McpOscTest", "show");
  h.fake.on("vars.get", () => ({ items: [] }));
  const r = await testOscInput(ctx, {}, fakeSend);
  assert.equal(r.verification.status, "unavailable");
  assert.match(String(r.steps.at(-1)!.error), /could not be read; nothing was sent/);
  assert.equal(osc.vars.get("McpOscTest"), "show", "the show's variable is untouched");
  assert.ok(!h.fake.requests.some((x) => x.op === "vars.delete"));
  h.fake.on("vars.get", () => ({ items: [{ name: "McpOscTest" }] }));
  assert.equal((await testOscInput(ctx, {}, fakeSend)).verification.status, "unavailable");
});

test("review 1: an ignored marker delete is reported, not succeeded", async () => {
  osc.deleteIgnored = true;
  const r = await testOscInput(ctx, {}, fakeSend);
  assert.equal(r.verification.status, "matched", "receipt itself was observed");
  assert.notEqual(r.outcome, "succeeded");
  assert.ok(r.steps.some((s) => s.name === "delete_marker" && s.status === "failed" && /still there/.test(String(s.error))));
  assert.ok((r.warnings ?? []).some((w) => /remains.*gma3_set_variable/.test(w)));
  assert.equal(r.markerCleanup, "remains");
});

test("review 1: unreadable observations are unavailable, not 'did not run'", async () => {
  let n = 0;
  h.fake.on("vars.get", ({ names }) => {
    // The preflight works; every later read fails.
    if (n++ === 0) return { items: (names as string[]).map((x) => ({ name: x, exists: false })) };
    throw new Error("busy");
  });
  let ran = false;
  const r = await testOscInput(ctx, { timeout_ms: 300 }, async (port, prefix, command) => {
    await fakeSend(port, prefix, command);
    ran = osc.vars.has("McpOscTest");
  });
  assert.equal(ran, true, "the console did run it");
  assert.equal(r.verification.status, "unavailable", JSON.stringify(r.verification));
  assert.match(String(r.verification.detail), /could not be observed/);
  assert.doesNotMatch(JSON.stringify(r), /did not run/);
  assert.equal((r.results as Array<{ received: unknown; readablePolls: number }>)[0].received, null);
  // Reads that work but never show the nonce: "not observed within the window".
  osc.install(h);
  osc.vars.clear();
  osc.lines[0].Port = "8099";
  const miss = await testOscInput(ctx, { timeout_ms: 300 }, fakeSend);
  assert.equal(miss.verification.status, "mismatched");
  assert.match(String(miss.verification.detail), /not observed within 300 ms/);
});

// ---------------------------------------------------------------------------
// Loopback test
// ---------------------------------------------------------------------------

test("test_osc_input: matched when the console ran the marker command; the marker is deleted", async () => {
  const r = await testOscInput(ctx, {}, fakeSend);
  assert.equal(r.outcome, "succeeded", JSON.stringify(r.steps));
  assert.equal(r.verification.status, "matched");
  assert.equal((r.results as Array<{ received: boolean }>)[0].received, true);
  assert.equal(osc.vars.has("McpOscTest"), false);
  assert.match(r.summary, /line 1 \(port 8000\)/);
});

test("test_osc_input: a port change without a re-bind is caught; the prefix is used", async () => {
  osc.lines[0].Port = "8020"; // changed behind the console's back: the socket is still on 8000
  const r = await testOscInput(ctx, { timeout_ms: 300 }, fakeSend);
  assert.equal(r.verification.status, "mismatched");
  assert.match(String(r.verification.detail), /line 1 \(port 8020\)/);
  osc.lines[0].Port = "8000";
  osc.lines[0].Prefix = "gma";
  const p = await testOscInput(ctx, {}, fakeSend);
  assert.equal(p.verification.status, "matched");
  assert.equal((p.results as Array<{ address: string }>)[0].address, "/gma/cmd");
});

test("test_osc_input: refuses with input off, without a command line, or when the marker already exists", async () => {
  osc.base.EnableInput = "No";
  assert.match(String((await testOscInput(ctx, {}, fakeSend)).steps.at(-1)!.error), /input is off/);
  osc.base.EnableInput = "Yes";
  osc.lines[0].ReceiveCommand = "No";
  assert.match(String((await testOscInput(ctx, {}, fakeSend)).steps.at(-1)!.error), /no OSC line has Receive Command/);
  assert.match(String((await testOscInput(ctx, { line: 1 }, fakeSend)).steps.at(-1)!.error), /does not have Receive Command/);
  osc.lines[0].ReceiveCommand = "Yes";
  osc.vars.set("McpOscTest", "show");
  const busy = await testOscInput(ctx, {}, fakeSend);
  assert.match(String(busy.steps.at(-1)!.error), /already exists/);
  assert.equal(osc.vars.get("McpOscTest"), "show", "a show's variable is left alone");
});

test("gma3_test_osc_input over real UDP: a socket playing the console decodes /cmd and runs it", async () => {
  const sock = dgram.createSocket("udp4");
  await new Promise<void>((r) => sock.bind(0, "127.0.0.1", () => r()));
  const port = sock.address().port;
  osc.lines[0].Port = String(port);
  osc.bound = [port];
  const str = (buf: Buffer, at: number) => {
    const end = buf.indexOf(0, at);
    return { s: buf.toString("utf8", at, end), next: Math.ceil((end + 1) / 4) * 4 };
  };
  sock.on("message", (msg) => {
    const a = str(msg, 0);
    const tags = str(msg, a.next);
    const arg = tags.s === ",s" ? str(msg, tags.next).s : "";
    osc.receive(port, a.s, arg);
  });
  try {
    const res = await h.callJson("gma3_test_osc_input", {});
    assert.equal(res.isError, false, res.text);
    assert.equal(res.result.verification.status, "matched");
  } finally {
    sock.close();
  }
});
