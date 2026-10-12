import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import {
  lua, dmx, absolute0, footprintOf, findButton, centre, dialogText, isOwnDialog, API_NAMES,
  LUA_SNAPSHOT, LUA_API, LUA_COLLISIONS_READONLY, LUA_ADD_LIVE, LUA_INDIRECT, LUA_ADD_COPY, LUA_SET_PATCH, LUA_COLLISIONS_AFTER_EDIT,
  LUA_DELETE_KB25, LUA_CREATE_SEQ, LUA_DELETE_SEQ, LUA_INSPECT, LUA_CLICK, LUA_KEY, LUA_CHAR, LUA_FIELD,
} from "../scripts/kb25-probe.mjs";

/**
 * scripts/kb25-probe.mjs: `verify` reads the Lua API surface, the live patch and the collision helpers only; `run`
 * refuses a show whose name does not look disposable, Lua disabled, a busy bridge, and (through its preflight) any
 * state it could not restore by identity. The console behaviour itself is the live record's
 * (docs/probes/kb-25-dialogs-macos-2.5.1.md).
 */

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "kb25-probe.mjs");

type Handler = (op: string, args: any) => unknown;

function startFakeBridge(handler: Handler): Promise<{ port: number; close: () => void; ops: string[]; codes: string[] }> {
  const ops: string[] = [];
  const codes: string[] = [];
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
          if (req.op === "lua") codes.push(String(req.args.code));
          try {
            sock.write(JSON.stringify({ id: req.id, ok: true, result: handler(req.op, req.args) }) + "\n");
          } catch (e) {
            sock.write(JSON.stringify({ id: req.id, ok: false, error: String((e as Error).message) }) + "\n");
          }
        }
      });
      sock.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close(), ops, codes }));
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

const ping = (extra: Record<string, unknown> = {}) => ({ bridgeVersion: "0.18.0", showfile: "mcp-test-disposable", user: "Admin", lua: { enabled: true }, input: { enabled: false, busy: null }, ...extra });
const types = ["Grouping", "Mega Hex Par"];
const snapshot = (extra: Record<string, unknown> = {}) => ({
  dest: "Root", last: "OK: ClearAll", inCopy: false, patchAddr: "14.9", liveAddr: "14.9", copyAddr: "14.10", copyCount: 0, stage: "Stage 1",
  liveFixtures: 26, liveKb25: [], copyFixtures: 0, copyKb25: [], liveTypes: types, copyTypes: [], modal: false, seq: false, ...extra,
});
const readonly = (extra: Record<string, unknown> = {}) => ({ mode: "14.9.6.6.6.3", ref: { fid: 401, patch: "1.279", mode: "14.9.6.6.6.3", fidFree: false, dmxFree: false }, targetFidFree: true, targetDmxFree: true, best0: 512, ...extra });

/** Answers the probe's read snippets by what they contain; anything else is an error (so a mutation is visible). */
function luaReads(snap: () => unknown, ro: () => unknown = () => readonly()) {
  return (op: string, args: any) => {
    if (op === "ping") return ping();
    if (op !== "lua") throw new Error(`unexpected op ${op}`);
    const code = String(args.code);
    if (code === LUA_API()) return { values: [Object.fromEntries(API_NAMES.map((n: string) => [n, true]))] };
    if (code === LUA_SNAPSHOT()) return { values: [snap()] };
    if (code === LUA_COLLISIONS_READONLY()) return { values: [ro()] };
    throw new Error(`unexpected lua: ${code.slice(0, 80)}`);
  };
}

test("kb25 helpers: Lua literals, DMX addresses, footprint, dialog nodes, own-dialog identity", () => {
  assert.equal(lua("Stage 1"), '"Stage 1"');
  assert.equal(lua('say "hi"\\'), '"say \\"hi\\"\\\\"');
  assert.equal(lua([1, "a", true]), '{1,"a",true}');
  assert.throws(() => lua("café"), /non-ASCII/);
  assert.throws(() => lua(Number.NaN), /cannot embed/);
  assert.equal(dmx(2, 1), "2.001");
  assert.equal(dmx(10, 512), "10.512");
  assert.equal(absolute0(1, 1), 0);
  assert.equal(absolute0(2, 1), 512);
  assert.equal(absolute0(1, 375), 374);
  assert.equal(footprintOf("2.001", "2.009"), 8);
  assert.equal(footprintOf("2.001", "3.001"), null, "different universes give no footprint");
  assert.equal(footprintOf("2.009", "2.001"), null);
  assert.equal(footprintOf("", "2.001"), null);
  const nodes = [
    { name: "Title", class: "TitleButton", text: "Store to Cue 1", vis: true, en: true, rect: { x: 560, y: 442, w: 476, h: 50 } },
    { name: "Text", class: "UIObject", text: "Please choose store mode.", vis: true, en: true },
    { name: "Button 3", class: "Button", text: "Overwrite", vis: true, en: true, rect: { x: 569, y: 577, w: 132, h: 50 } },
    { name: "Button 7", class: "Button", text: "Cancel", vis: true, en: true, rect: { x: 1099, y: 577, w: 132, h: 50 } },
    { name: "Button 8", class: "Button", text: "Hidden", vis: false, en: true, rect: { x: 0, y: 0, w: 10, h: 10 } },
    { name: "Button 9", class: "Button", text: "Disabled", vis: true, en: false, rect: { x: 0, y: 0, w: 10, h: 10 } },
  ];
  assert.equal(findButton(nodes, "Cancel")?.name, "Button 7");
  assert.equal(findButton(nodes, "Hidden"), null);
  assert.equal(findButton(nodes, "Disabled"), null);
  assert.equal(findButton(nodes, "Store to Cue 1"), null, "the title is not a button");
  assert.deepEqual(centre({ x: 1099, y: 577, w: 132, h: 50 }), { x: 1165, y: 602 });
  assert.deepEqual(dialogText(nodes), { title: "Store to Cue 1", message: "Please choose store mode." });
  assert.ok(isOwnDialog({ class: "MessageBox", title: "Store to Cue 1" }, 951));
  assert.ok(!isOwnDialog({ class: "MessageBox", title: "Delete Show?" }, 951));
  assert.ok(isOwnDialog({ class: "TextInput", target: "Sequence 951" }, 951));
  assert.ok(!isOwnDialog({ class: "TextInput", target: "Sequence 1" }, 951));
  assert.ok(!isOwnDialog({ class: "AllExecEditor" }, 951));
  assert.ok(!isOwnDialog(false, 951));
});

test("kb25 snippets: destination changes and dialog commands only through CmdIndirect; no Oops; deletes are scoped", () => {
  const all = [
    LUA_SNAPSHOT(), LUA_API(), LUA_COLLISIONS_READONLY(), LUA_ADD_LIVE(), LUA_INDIRECT("ChangeDestination Root"),
    LUA_ADD_COPY("Stage 1", [{ amount: 2, fid: 901, name: "KB25 Probe", patch: "2.001" }]), LUA_SET_PATCH([{ fid: 902, patch: "2.101" }]),
    LUA_COLLISIONS_AFTER_EDIT(8), LUA_DELETE_KB25(types), LUA_CREATE_SEQ(), LUA_DELETE_SEQ(), LUA_INSPECT(1), LUA_INSPECT(0),
    LUA_CLICK("Cancel"), LUA_KEY("Escape"), LUA_CHAR("Z"), LUA_FIELD(), LUA_FIELD("KB25 X"),
  ];
  for (const code of all) {
    assert.doesNotMatch(code, /Oops/, "Oops would undo the operator's work");
    for (const m of code.matchAll(/\bCmd\(([^)]*)\)/g)) assert.match(m[1], /\/NoConfirmation/, `a blocking Cmd() must not be able to open a dialog: ${m[0]}`);
  }
  assert.equal(LUA_INDIRECT('ChangeDestination "ShowData"."Patch"'), 'CmdIndirect("ChangeDestination \\"ShowData\\".\\"Patch\\"") return true');
  assert.match(LUA_ADD_COPY("Stage 1", []), /dest\(\) ~= "Stage 1\.Fixtures"/, "AddFixtures on the copy is guarded by the destination");
  assert.match(LUA_ADD_LIVE(), /dest\(\) ~= "Root"/);
  assert.match(LUA_DELETE_KB25(types), /if not inCopy\(\)/, "deletes only ever run on the copy");
  assert.match(LUA_DELETE_KB25(types), /\{"Grouping","Mega Hex Par"\}/, "types present at the start are kept");
  assert.match(LUA_DELETE_SEQ(), /is not the probe's/, "the sequence is deleted only when it carries the probe's name");
  assert.match(LUA_COLLISIONS_AFTER_EDIT(8), /FindBestDMXPatchAddr\(lp, 512, 8\)/, "the footprint is interpolated, not a Lua name");
  assert.match(LUA_COLLISIONS_AFTER_EDIT(8), /"2\.094"/, "the overlap check starts one footprint minus one before 2.101");
  assert.match(LUA_FIELD("x"), /md\.target ~= "Sequence 951"/, "the field is written only on the probe's TextInput");
});

test("kb25 verify passes on a consistent console and sends only reads", async () => {
  const bridge = await startFakeBridge(luaReads(() => snapshot()));
  try {
    const r = await run(["verify"], { GMA3_BRIDGE_PORT: String(bridge.port) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /PASS the Lua API has AddFixtures/);
    assert.match(r.stdout, /PASS CheckFIDCollision \/ CheckDMXCollision report an existing patched fixture/);
    assert.match(r.stdout, /4 passed, 0 failed/);
    assert.deepEqual([...new Set(bridge.ops)].sort(), ["lua", "ping"]);
    assert.ok(bridge.codes.every((c) => !/CmdIndirect\(|pcall\(AddFixtures|:Delete\(|Mouse\(|Keyboard\(/.test(c)), "verify sends no mutating Lua");
  } finally { bridge.close(); }
});

test("kb25 verify fails when the collision helpers call a patched fixture free", async () => {
  const bridge = await startFakeBridge(luaReads(() => snapshot(), () => readonly({ ref: { fid: 401, patch: "1.279", mode: "m", fidFree: true, dmxFree: false } })));
  try {
    const r = await run(["verify"], { GMA3_BRIDGE_PORT: String(bridge.port) });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /FAIL CheckFIDCollision \/ CheckDMXCollision report an existing patched fixture/);
  } finally { bridge.close(); }
});

test("kb25 run refuses a non-disposable show, Lua disabled and a busy bridge before any Lua", async () => {
  let which: "show" | "lua" | "busy" = "show";
  const bridge = await startFakeBridge((op) => {
    if (op === "ping") {
      if (which === "show") return ping({ showfile: "Main Show 2026" });
      if (which === "lua") return ping({ lua: { enabled: false } });
      return ping({ input: { enabled: true, busy: { owner: "s1" } } });
    }
    throw new Error(`unexpected op ${op}`);
  });
  try {
    let r = await run(["run"], { GMA3_BRIDGE_PORT: String(bridge.port) });
    assert.equal(r.status, 2); assert.match(r.stderr, /does not look disposable/);
    which = "lua";
    r = await run(["verify"], { GMA3_BRIDGE_PORT: String(bridge.port) });
    assert.equal(r.status, 2); assert.match(r.stderr, /Lua enabled/);
    which = "busy";
    r = await run(["run"], { GMA3_BRIDGE_PORT: String(bridge.port) });
    assert.equal(r.status, 2); assert.match(r.stderr, /busy/);
    assert.deepEqual([...new Set(bridge.ops)], ["ping"]);
  } finally { bridge.close(); }
});

test("kb25 run's preflight refuses an open modal, an open patch copy, existing KB25 fixtures, a taken sequence or taken ranges, and changes nothing", async () => {
  const cases: Array<[Record<string, unknown>, Record<string, unknown>, RegExp]> = [
    [{ modal: { class: "MessageBox", title: "Store to Cue 1" } }, {}, /a modal is open/],
    [{ inCopy: true, dest: "Stage 1.Fixtures", copyCount: 15 }, {}, /patch copy is open/],
    [{ dest: "ShowData.DataPools" }, {}, /destination is ShowData\.DataPools/],
    [{ liveKb25: [{ name: "KB25 Probe", fid: "901", patch: "2.001" }] }, {}, /already holds fixtures named/],
    [{ seq: "Main Cues" }, {}, /Sequence 951 exists/],
    [{}, { targetFidFree: false }, /FID 901\.\.903 is not free/],
    [{}, { targetDmxFree: false }, /2\.001 x32 is not free/],
    [{}, { mode: false }, /no DMX mode at FixtureTypes\[6\]\.DMXModes\[3\]/],
  ];
  for (const [snap, ro, why] of cases) {
    const bridge = await startFakeBridge(luaReads(() => snapshot(snap), () => readonly(ro)));
    try {
      const r = await run(["run"], { GMA3_BRIDGE_PORT: String(bridge.port) });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stdout, /FAIL run: preflight/);
      assert.match(r.stdout, why);
      assert.ok(bridge.codes.every((c) => !/CmdIndirect\(|pcall\(AddFixtures|:Delete\(|Mouse\(|Keyboard\(|Store Sequence/.test(c)), `nothing was changed for ${why}`);
    } finally { bridge.close(); }
  }
});
