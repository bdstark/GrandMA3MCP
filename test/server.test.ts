import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import dgram from "node:dgram";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * End-to-end: the MCP server is started over stdio exactly as a client would start it, pointed
 * at a fake bridge (TCP) and a UDP listener standing in for grandMA3's OSC input. The tests pin
 * down the gma3_command transport decision: fall back to OSC only when nothing reached the
 * bridge, and never resend a command whose outcome is unknown.
 */

const root = path.resolve(import.meta.dirname, "..");

// --- fake bridge -----------------------------------------------------------
const bridgeSockets = new Set<net.Socket>();
const bridgeRequests: Array<{ id: string; op: string; args: Record<string, unknown> }> = [];
let bridgeMode: "silent" | "reply" = "silent";
const bridgeServer = net.createServer((sock) => {
  bridgeSockets.add(sock);
  sock.on("close", () => bridgeSockets.delete(sock));
  sock.on("error", () => {});
  let buf = "";
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const req = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      bridgeRequests.push(req);
      if (bridgeMode === "reply") sock.write(JSON.stringify({ id: req.id, ok: true, result: `feedback for ${req.args.command}` }) + "\n");
    }
  });
});
let bridgePort = 0;

// --- fake OSC input ---------------------------------------------------------
const oscMessages: Array<{ address: string; args: string[] }> = [];
const osc = dgram.createSocket("udp4");
let oscPort = 0;
function decodeOsc(buf: Buffer): { address: string; args: string[] } {
  let off = 0;
  const readStr = () => {
    const end = buf.indexOf(0, off);
    const s = buf.toString("utf8", off, end);
    off = end + 1;
    off += (4 - (off % 4)) % 4;
    return s;
  };
  const address = readStr();
  const tags = readStr();
  const args: string[] = [];
  for (const t of tags.slice(1)) {
    if (t !== "s") throw new Error(`unexpected OSC tag ${t}`);
    args.push(readStr());
  }
  return { address, args };
}
osc.on("message", (msg) => oscMessages.push(decodeOsc(msg)));

// --- server under test --------------------------------------------------------
const clients: Client[] = [];
async function startServer(extraEnv: Record<string, string> = {}): Promise<Client> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, {
    GMA3_BRIDGE_HOST: "127.0.0.1",
    GMA3_BRIDGE_PORT: String(bridgePort),
    GMA3_BRIDGE_TIMEOUT_MS: "300",
    GMA3_OSC_HOST: "127.0.0.1",
    GMA3_OSC_PORT: String(oscPort),
    GMA3_HELP_DIR: path.join(root, "test", "no-such-manual"),
    GMA3_INSTALL_DIR: path.join(root, "test", "no-such-install"),
    ...extraEnv,
  });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/index.ts"], cwd: root, env, stderr: "pipe" });
  const client = new Client({ name: "gma3-mcp-test", version: "0.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

function textOf(result: unknown): string {
  const r = result as { content: Array<{ type: string; text?: string }> };
  return r.content.map((c) => c.text ?? "").join("\n");
}
const isError = (result: unknown) => Boolean((result as { isError?: boolean }).isError);

let client: Client;

before(async () => {
  await new Promise<void>((resolve) => bridgeServer.listen(0, "127.0.0.1", resolve));
  bridgePort = (bridgeServer.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => osc.bind(0, "127.0.0.1", resolve));
  oscPort = osc.address().port;
  client = await startServer();
});

after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  for (const s of bridgeSockets) s.destroy();
  await new Promise<void>((resolve) => bridgeServer.close(() => resolve()));
  await new Promise<void>((resolve) => osc.close(resolve));
});

test("gma3_command returns bridge feedback when the bridge replies", async () => {
  bridgeMode = "reply";
  const res = await client.callTool({ name: "gma3_command", arguments: { command: "Go+ Sequence 1" } });
  assert.equal(isError(res), false, textOf(res));
  assert.equal(textOf(res), "feedback for Go+ Sequence 1");
  assert.deepEqual(bridgeRequests.at(-1)?.args, { command: "Go+ Sequence 1" });
  assert.equal(bridgeRequests.at(-1)?.op, "cmd");
});

test("a command the bridge accepted but never answered is NOT resent over OSC", async () => {
  bridgeMode = "silent";
  oscMessages.length = 0;
  const res = await client.callTool({ name: "gma3_command", arguments: { command: "Go+ Sequence 2" } });
  assert.equal(isError(res), true);
  const text = textOf(res);
  assert.match(text, /timeout after 300ms waiting for 'cmd'/);
  assert.match(text, /outcome is unknown/);
  assert.match(text, /NOT resent over OSC/);
  // The recovery hint must point at read-only tools, never at one that issues playback commands.
  assert.match(text, /gma3_sequences/);
  assert.match(text, /gma3_get_object/);
  assert.doesNotMatch(text, /gma3_playback/);
  assert.doesNotMatch(text, /does not seem to be running/, "the bridge is connected, so no start-the-plugin hint");
  await sleep(100);
  assert.deepEqual(oscMessages, [], "nothing may reach OSC after a dispatched bridge request");
});

test('via "bridge" surfaces the bridge error without OSC advice', async () => {
  bridgeMode = "silent";
  const res = await client.callTool({ name: "gma3_command", arguments: { command: "Go+ Sequence 3", via: "bridge" } });
  assert.equal(isError(res), true);
  assert.match(textOf(res), /timeout after 300ms/);
  assert.doesNotMatch(textOf(res), /NOT resent/);
});

test("gma3_command falls back to OSC only when the bridge is unreachable", async () => {
  // Take the bridge down, including the connection the server already holds.
  for (const s of bridgeSockets) s.destroy();
  await new Promise<void>((resolve) => bridgeServer.close(() => resolve()));
  await sleep(50);
  oscMessages.length = 0;
  const res = await client.callTool({ name: "gma3_command", arguments: { command: "Go+ Sequence 4" } });
  assert.equal(isError(res), false, textOf(res));
  const body = JSON.parse(textOf(res));
  assert.equal(body.command, "Go+ Sequence 4");
  assert.equal(body.sentVia, `osc udp://127.0.0.1:${oscPort}`);
  assert.equal(body.feedback, null);
  assert.match(body.note, /bridge unreachable/);
  await sleep(100);
  assert.deepEqual(oscMessages, [{ address: "/cmd", args: ["Go+ Sequence 4"] }]);
});

test('via "bridge" with the bridge down reports how to start the plugin and sends nothing', async () => {
  oscMessages.length = 0;
  const res = await client.callTool({ name: "gma3_command", arguments: { command: "Go+ Sequence 5", via: "bridge" } });
  assert.equal(isError(res), true);
  assert.match(textOf(res), /cannot connect to bridge at 127\.0\.0\.1:\d+/);
  assert.match(textOf(res), /Plugin "gma3_mcp_bridge"/);
  await sleep(100);
  assert.deepEqual(oscMessages, []);
});

test('via "osc" always goes over OSC', async () => {
  oscMessages.length = 0;
  const res = await client.callTool({ name: "gma3_command", arguments: { command: "ClearAll", via: "osc" } });
  assert.equal(isError(res), false, textOf(res));
  const body = JSON.parse(textOf(res));
  assert.equal(body.sentVia, `osc udp://127.0.0.1:${oscPort}`);
  assert.equal(body.note, undefined);
  await sleep(100);
  assert.deepEqual(oscMessages, [{ address: "/cmd", args: ["ClearAll"] }]);
});

test("gma3_help explains how to configure the manual when it is missing", async () => {
  const res = await client.callTool({ name: "gma3_help", arguments: { topic: "Store" } });
  assert.equal(isError(res), true);
  assert.match(textOf(res), /GMA3_HELP_DIR or GMA3_INSTALL_DIR/);
});

test("gma3_lua is registered by default and hidden by GMA3_ALLOW_LUA=0", async () => {
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("gma3_lua"));
  assert.ok(names.includes("gma3_command"));
  const restricted = await startServer({ GMA3_ALLOW_LUA: "0" });
  const restrictedNames = (await restricted.listTools()).tools.map((t) => t.name);
  assert.ok(!restrictedNames.includes("gma3_lua"));
  assert.ok(restrictedNames.includes("gma3_command"));
});
