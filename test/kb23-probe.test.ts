import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { slotColour, slotComplete, executorAppearance, appearanceComplete, LUA_DEFINITIONS } from "../scripts/kb23-probe.mjs";

/**
 * scripts/kb23-probe.mjs: `verify` reads feedback.context only and judges the KB-23 metadata (feature names from the
 * definition's path, a parsed Color or an explicit reason per attribute slot; parsed appearance components or a reason
 * per assigned executor); `run` refuses a show whose name does not look disposable, Lua disabled and an old feedback
 * module. The readers themselves are covered by the Lua harness and the live record.
 */

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "kb23-probe.mjs");

type Handler = (op: string, args: any) => unknown;

function startFakeBridge(handler: Handler): Promise<{ port: number; close: () => void; ops: string[] }> {
  const ops: string[] = [];
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf = "";
      sock.setEncoding("utf8");
      sock.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const req = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          ops.push(req.op);
          try {
            sock.write(JSON.stringify({ id: req.id, ok: true, result: handler(req.op, req.args) }) + "\n");
          } catch (e) {
            sock.write(JSON.stringify({ id: req.id, ok: false, error: String((e as Error).message) }) + "\n");
          }
        }
      });
      sock.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close(), ops }));
  });
}

function run(args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, env: { ...process.env, ...env } });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => { stdout += d; });
    child.stderr.setEncoding("utf8").on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const modules = { hardkeys: { loaded: true, version: "0.10.0" }, feedback: { loaded: true, version: "0.6.0" }, control: { loaded: true, version: "0.5.0" } };
const ping = (extra: Record<string, unknown> = {}) => ({ bridgeVersion: "0.18.0", showfile: "mcp-test-disposable", user: "Admin", lua: { enabled: true }, input: { enabled: false, busy: null }, control: { enabled: false }, modules, ...extra });

const slotR = { slot: 1, kind: "attribute", name: "ColorRGB_R", label: "R", feature: "FeatureGroup 4 'Color'.Feature 1 'RGB'", featureGroup: "Color", featureName: "RGB", activationGroup: "ColorRGB", color: "1.0,0.0,0.0,1.0", colorR: 1, colorG: 0, colorB: 0, colorA: 1, colorDefined: true, colorFormat: "floats", availability: "available", valueState: "value" };
const slotDim = { slot: 2, kind: "attribute", name: "Dimmer", label: "Dim", featureGroup: "Dimmer", featureName: "Dimmer", colorR: 0, colorG: 0, colorB: 0, colorA: 1, colorDefined: false, colorFormat: "floats", availability: "available", valueState: "mixed" };
const slotNoColour = { slot: 3, kind: "attribute", name: "Gobo1", featureGroup: "Gobo", featureName: "Gobo1", colorUnavailable: "the attribute definition has no readable Color", availability: "available", valueState: "none" };
const slotOld = { slot: 4, kind: "attribute", name: "Pan", feature: "FeatureGroup 2 'Position'.Feature 1 'PanTilt'", color: "0,0,0,1", availability: "available", valueState: "none" };
const exec = (n: number, appearance: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => ({
  available: true, params: { executor: n }, value: { executor: n, page: { no: 1 }, empty: false, playbackTarget: true, assigned: { name: `Seq ${n}`, class: "Sequence", no: n }, functions: { keyPress: "Go+", fader: "Master" }, level: { token: "FaderMaster", value: 100 }, active: false, ...(appearance ? { appearance } : { appearanceUnavailable: "the object has no Appearance" }), ...extra },
});
const snapshot = (slots: unknown[], executors: unknown[]) => ({
  observedAt: 1, epoch: 1, atomic: false, cached: false, generation: 7, generationChanged: false, bridgeVersion: "0.18.0", module: { component: "gma3_mcp_feedback", version: "0.6.0" },
  identity: { showFile: "mcp-test-disposable", user: "Admin", profile: "Default", dataPool: { name: "Default", no: 1 } }, display: 1,
  encoder: { available: true, value: { bank: { index: 4, name: "Color" }, page: { index: 1, name: "RGB" }, context: "Default" } },
  slots: { available: true, value: { slots, selection: { count: 1, fixtures: [401], identityComplete: true } } },
  executorPage: { name: "Page 1", no: 1 }, executors, limitations: [],
});

test("kb23 helpers: slot and appearance evidence, completeness", () => {
  assert.deepEqual(slotColour(slotR), { slot: 1, name: "ColorRGB_R", label: "R", featureGroup: "Color", featureName: "RGB", activationGroup: "ColorRGB", rgba: [1, 0, 0, 1], defined: true, format: "floats" });
  assert.equal(slotColour(slotDim).defined, false);
  assert.equal(slotColour(slotNoColour).unavailable, "the attribute definition has no readable Color");
  assert.equal(slotColour({ slot: 5, kind: "empty" }).kind, "empty");
  assert.ok(slotComplete(slotR) && slotComplete(slotDim) && slotComplete(slotNoColour) && slotComplete({ slot: 5, kind: "empty" }));
  assert.ok(!slotComplete(slotOld), "a 0.5.0 slot (raw feature and colour text only) is incomplete");
  assert.ok(slotComplete({ slot: 6, kind: "attribute", name: "X", attributeUnavailable: "attribute 'X' is not in the show's attribute definitions" }));
  const hex = exec(201, { name: "Orange", backRGBA: "FF7F00FF", r: 1, g: 127 / 255, b: 0, a: 1, format: "hex" });
  assert.deepEqual(executorAppearance(hex).rgba, [1, 127 / 255, 0, 1]);
  assert.equal(executorAppearance(hex).appearance, "Orange");
  assert.ok(appearanceComplete(hex));
  assert.ok(appearanceComplete(exec(202, null)), "no Appearance with a reason is complete");
  assert.ok(appearanceComplete(exec(203, { name: "Odd", backRGBA: "weird", rgbaUnavailable: "unrecognised colour text weird" })));
  assert.ok(!appearanceComplete(exec(204, { name: "Old", backRGBA: "FF7F00FF" })), "a 0.5.0 appearance without components is incomplete");
  assert.ok(appearanceComplete({ available: true, params: { executor: 205 }, value: { executor: 205, empty: true } }));
  assert.match(LUA_DEFINITIONS(["ColorRGB_R", "Dimmer"]), /\{"ColorRGB_R","Dimmer"\}/);
});

test("kb23 verify passes on a 0.6.0 context with complete metadata and sends only reads", async () => {
  const bridge = await startFakeBridge((op) => {
    if (op === "ping") return ping();
    if (op === "feedback.context") return snapshot([slotR, slotDim, slotNoColour, { slot: 5, kind: "empty" }], [exec(201, { name: "Orange", backRGBA: "FF7F00FF", r: 1, g: 127 / 255, b: 0, a: 1, format: "hex" }), exec(202, null)]);
    throw new Error(`unexpected op ${op}`);
  });
  try {
    const r = await run(["verify"], { GMA3_BRIDGE_PORT: String(bridge.port) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /PASS every attribute slot carries the feature group/);
    assert.match(r.stdout, /PASS every assigned executor carries a parsed appearance/);
    assert.deepEqual([...new Set(bridge.ops)].sort(), ["feedback.context", "ping"]);
  } finally { bridge.close(); }
});

test("kb23 verify fails when a slot lacks the colour metadata or an appearance lacks its components", async () => {
  const bridge = await startFakeBridge((op) => {
    if (op === "ping") return ping();
    if (op === "feedback.context") return snapshot([slotR, slotOld], [exec(204, { name: "Old", backRGBA: "FF7F00FF" })]);
    throw new Error(`unexpected op ${op}`);
  });
  try {
    const r = await run(["verify"], { GMA3_BRIDGE_PORT: String(bridge.port) });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /FAIL every attribute slot carries the feature group/);
    assert.match(r.stdout, /FAIL every assigned executor carries a parsed appearance/);
  } finally { bridge.close(); }
});

test("kb23 refuses an old feedback module, and run refuses a non-disposable show or Lua disabled", async () => {
  let which: "old" | "show" | "lua" = "old";
  const bridge = await startFakeBridge((op) => {
    if (op === "ping") {
      if (which === "old") return ping({ modules: { ...modules, feedback: { loaded: true, version: "0.5.0" } } });
      if (which === "show") return ping({ showfile: "Main Show 2026" });
      return ping({ lua: { enabled: false } });
    }
    return snapshot([slotR], []);
  });
  try {
    let r = await run(["verify"], { GMA3_BRIDGE_PORT: String(bridge.port) });
    assert.equal(r.status, 2); assert.match(r.stderr, /0\.6\.0 or newer/);
    which = "show";
    r = await run(["run"], { GMA3_BRIDGE_PORT: String(bridge.port) });
    assert.equal(r.status, 2); assert.match(r.stderr, /does not look disposable/);
    which = "lua";
    r = await run(["run"], { GMA3_BRIDGE_PORT: String(bridge.port) });
    assert.equal(r.status, 2); assert.match(r.stderr, /Lua enabled/);
    assert.ok(!bridge.ops.includes("cmd") && !bridge.ops.includes("lua"), "nothing was changed");
  } finally { bridge.close(); }
});
