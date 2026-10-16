/**
 * Live console test for SU-18: OSC input and output (gma3_osc, gma3_configure_osc, gma3_test_osc_input).
 *
 * Runs only with GMA3_LIVE=1 and GMA3_LIVE_EXCLUSIVE=1 against a disposable show (see README.md in this folder).
 * Not part of `npm test`. Needs bridge 0.33.0.
 *
 * Show objects used: one OSC line added at the end (name "McpLive OSC", UDP ports 8031 and 8032 on loopback, then a
 * prefix; removed at the end), a send-only line "McpLive OSC out" to 127.0.0.1 on a port this test listens on
 * (removed; EnableOutput restored), and a
 * re-bind of input (EnableInput off for about 0.4 s). Existing lines are not changed. While the line exists, OSC
 * commands to those ports are accepted from any network this machine is on.
 */
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { after } from "node:test";
import { MutationLock } from "../../src/mutations.ts";
import { registerOscTools } from "../../src/tools/osc.ts";
import type { ToolContext } from "../../src/tools/context.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { liveTest, liveEnabled, bridge, cmd } from "./live.ts";

const exclusive = process.env.GMA3_LIVE_EXCLUSIVE === "1";
const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 20000, luaToolAllowed: false, osc: { host: "127.0.0.1", port: 8000 } };
const tools = captureTools(registerOscTools, ctx);
async function call(name: string, args: Record<string, unknown>) {
  const res = await tools.get(name)!.call(args);
  const text = res.content.map((c) => c.text).join("\n");
  return { result: JSON.parse(text) as any, isError: Boolean(res.isError), text };
}
const read = async () => (await call("gma3_osc", {})).result;

let before: any;
let added: number | undefined;
after(async () => {
  if (!liveEnabled || !before) return;
  try {
    const now = await read();
    const ours = now.lines.filter((l: { name: string }) => l.name.startsWith("McpLive OSC")).map((l: { index: number }) => l.index).sort((a: number, b: number) => b - a);
    for (const i of ours) await bridge.request("osc.removeLine", { index: i, exclusive: true });
    await bridge.request("osc.set", { target: "base", property: "EnableOutput", value: before.enableOutput ? "Yes" : "No", exclusive: true });
    await bridge.request("osc.set", { target: "base", property: "EnableInput", value: "No", exclusive: true });
    await new Promise((r) => setTimeout(r, 400));
    await bridge.request("osc.set", { target: "base", property: "EnableInput", value: before.enableInput ? "Yes" : "No", exclusive: true });
  } catch {
    // best effort
  }
});

liveTest("SU-18 OSC: read, add a command line, loopback test, port and prefix changes with re-bind, output, remove", async (t) => {
  if (!exclusive) {
    t.skip("set GMA3_LIVE_EXCLUSIVE=1: the test changes the console's OSC configuration");
    return;
  }
  before = await read();
  assert.ok(Array.isArray(before.lines));
  assert.ok(!before.lines.some((l: { name: string }) => l.name === "McpLive OSC"), "the line McpLive OSC must not exist");
  assert.ok(!before.lines.some((l: { port: number }) => l.port === 8031 || l.port === 8032), "ports 8031 and 8032 must be free");
  t.diagnostic(`before: ${before.meaning.input.explanation}`);

  await t.test("a new command line needs network: true on a networked machine, then reads back and receives", async () => {
    const spec = { enable_input: true, lines: [{ add: true, name: "McpLive OSC", port: 8031, receive_command: true, destination_ip: "127.0.0.1" }], exclusive: true };
    const nets = before.interfaces.some((n: { ips: Array<{ ip?: string }> }) => n.ips.some((ip) => ip.ip && !ip.ip.startsWith("127.")));
    if (nets) {
      const refused = await call("gma3_configure_osc", spec);
      assert.equal(refused.result.outcome, "failed", refused.text);
      assert.match(refused.text, /network: true/);
    }
    const r = await call("gma3_configure_osc", { ...spec, network: true });
    assert.equal(r.result.verification.status, "matched", r.text);
    added = r.result.now.lines.find((l: { name: string }) => l.name === "McpLive OSC").index;
    const test = await call("gma3_test_osc_input", { line: added });
    assert.equal(test.result.verification.status, "matched", test.text);
    t.diagnostic(`loopback latency ${test.result.results[0].latencyMs} ms`);
  });

  await t.test("a port change re-binds input and the new port receives", async () => {
    const r = await call("gma3_configure_osc", { lines: [{ line: added, port: 8032 }], exclusive: true, network: true });
    assert.equal(r.result.verification.status, "matched", r.text);
    assert.ok(r.result.steps.some((s: { name: string }) => s.name === "EnableInput on (re-bind)"), r.text);
    const test = await call("gma3_test_osc_input", { line: added });
    assert.equal(test.result.verification.status, "matched", test.text);
  });

  await t.test("a prefix changes the address to /<prefix>/cmd", async () => {
    const r = await call("gma3_configure_osc", { lines: [{ line: added, prefix: "mcplive" }], exclusive: true });
    assert.equal(r.result.verification.status, "matched", r.text);
    const test = await call("gma3_test_osc_input", { line: added });
    assert.equal(test.result.verification.status, "matched", test.text);
    assert.equal(test.result.results[0].address, "/mcplive/cmd");
  });

  await t.test("output to loopback: a fader change arrives at the destination", async () => {
    const sock = dgram.createSocket("udp4");
    const got: string[] = [];
    sock.on("message", (m) => got.push(m.toString("latin1").split("\0")[0]));
    await new Promise<void>((r) => sock.bind(0, "127.0.0.1", () => r()));
    const port = sock.address().port;
    try {
      // A send-only line of its own (no receive flags, so input is not re-bound onto this test's port).
      const r = await call("gma3_configure_osc", { enable_output: true, lines: [{ add: true, name: "McpLive OSC out", send: true, port, destination_ip: "127.0.0.1" }], exclusive: true });
      assert.equal(r.result.verification.status, "matched", r.text);
      assert.ok(!r.result.steps.some((s: { name: string }) => /re-bind/.test(s.name)), "a send-only line does not re-bind input");
      await cmd("FaderMaster Sequence 1 At 50");
      await new Promise((res) => setTimeout(res, 200));
      await cmd("FaderMaster Sequence 1 At 100");
      await new Promise((res) => setTimeout(res, 800));
      assert.ok(got.length > 0, "no OSC output arrived");
      t.diagnostic(`output: ${got.slice(0, 2).join(", ")}`);
    } finally {
      sock.close();
    }
    const outLine = (await read()).lines.find((l: { name: string }) => l.name === "McpLive OSC out").index;
    const off = await call("gma3_configure_osc", { enable_output: before.enableOutput === true, lines: [{ line: outLine, remove: true }], exclusive: true });
    assert.equal(off.result.verification.status, "matched", off.text);
  });

  await t.test("the line is removed and the configuration is as before", async () => {
    const r = await call("gma3_configure_osc", { lines: [{ line: added, remove: true }], exclusive: true });
    assert.equal(r.result.verification.status, "matched", r.text);
    const now = await read();
    assert.equal(now.lines.length, before.lines.length);
    assert.equal(now.enableInput, before.enableInput);
    assert.equal(now.enableOutput, before.enableOutput);
    assert.deepEqual(now.lines.map((l: { port: number }) => l.port), before.lines.map((l: { port: number }) => l.port));
    if (before.meaning.input.acceptsCommands) {
      const test = await call("gma3_test_osc_input", {});
      assert.equal(test.result.verification.status, "matched", test.text);
    }
  });
});
