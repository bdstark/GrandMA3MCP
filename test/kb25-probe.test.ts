import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  lua, dmx, absolute0, footprintOf, findButton, centre, dialogText, kb25Keys, sameFingerprint, addedTypes, importOwnership, combineFingerprints,
  API_NAMES, DMX_PLAN, MAX_FOOTPRINT, STORE_DIALOG, LABEL_DIALOG,
  LUA_SNAPSHOT, LUA_FINGERPRINTS, LUA_FP_COLLECTIONS, LUA_FP_PART, LUA_API, LUA_COLLISIONS_READONLY, LUA_ADD_LIVE, LUA_INDIRECT, LUA_ADD_COPY, LUA_SET_PATCH, LUA_COLLISIONS_AFTER_EDIT,
  LUA_DELETE_KB25, LUA_CREATE_SEQ, LUA_DELETE_SEQ, LUA_INSPECT, LUA_CLICK, LUA_KEY, LUA_CHAR, LUA_FIELD,
} from "../scripts/kb25-probe.mjs";

/**
 * scripts/kb25-probe.mjs: `verify` reads the Lua API surface, the live patch and the collision helpers only; `run`
 * refuses a show whose name does not look disposable, Lua disabled, a busy bridge, and (through its preflight) any
 * state it could not restore by identity. A failed prerequisite stops the run before the next mutation; dialog input
 * goes only to the bound dialog; cleanup deletes only what the probe made and never commits a foreign change. The
 * console behaviour itself is the live record's (docs/probes/kb-25-dialogs-macos-2.5.1.md).
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
const fp = (h: number | string = 1) => ({ complete: true, objects: 26, hash: h });
const typeList = [{ no: 1, name: "Grouping" }, { no: 6, name: "Mega Hex Par" }];
const snapshot = (extra: Record<string, unknown> = {}) => ({
  dest: "Root", last: "OK: ClearAll", inCopy: false, patchAddr: "14.9", liveAddr: "14.9", copyAddr: "14.10", copyCount: 0, stage: "Stage 1",
  liveFixtures: 26, liveKb25: [], copyFixtures: 0, copyKb25: [], liveTypes: types, liveTypeList: typeList, copyTypeList: [],
  modal: false, seq: false, ...extra,
});
const readonly = (extra: Record<string, unknown> = {}) => ({
  mode: "14.9.6.6.6.3", ref: { fid: 401, patch: "1.279", mode: "14.9.6.6.6.3", fidFree: false, dmxFree: false }, targetFidFree: true,
  targetDmx: DMX_PLAN.map(([a, n]: number[]) => ({ at: dmx(2, a), count: n, free: true })), best0: 512, ...extra,
});

/**
 * Answers the probe's snippets by what they are; anything unexpected is an error reply (so a mutation is visible). The
 * fingerprint is one collection ("Stages") per side: `part(which)` answers its part (default: equal and complete).
 */
function luaFake(snap: () => any, ro: () => unknown = () => readonly(), more: (code: string) => unknown = () => undefined, part: (which: string) => unknown = () => fp()) {
  return (op: string, args: any) => {
    if (op === "ping") return ping();
    if (op !== "lua") throw new Error(`unexpected op ${op}`);
    const code = String(args.code);
    const extra = more(code);
    if (extra !== undefined) return { values: [extra] };
    if (code === LUA_API()) return { values: [Object.fromEntries(API_NAMES.map((n: string) => [n, true]))] };
    if (code === LUA_SNAPSHOT()) return { values: [snap()] };
    if (code === LUA_COLLISIONS_READONLY()) return { values: [ro()] };
    if (code === LUA_FP_COLLECTIONS()) { const s = snap(); return { values: [{ inCopy: s.inCopy, live: ["Stages"], copy: s.inCopy ? ["Stages"] : false }] }; }
    if (code === LUA_FP_PART("live", "Stages")) return { values: [part("live")] };
    if (code === LUA_FP_PART("copy", "Stages")) return { values: [part("copy")] };
    throw new Error(`unexpected lua: ${code.slice(0, 80)}`);
  };
}

const MUTATING = /CmdIndirect\(|pcall\(AddFixtures|:Delete\(|Mouse\(|Keyboard\(|Store Sequence|:Set\("Content"/;

test("kb25 helpers: Lua literals, DMX addresses, footprint, dialog nodes, fingerprints, added types", () => {
  assert.equal(lua("Stage 1"), '"Stage 1"');
  assert.equal(lua('say "hi"\\'), '"say \\"hi\\"\\\\"');
  assert.equal(lua([1, "a", true]), '{1,"a",true}');
  assert.equal(lua(null), "nil");
  assert.equal(lua({ class: "MessageBox", title: "Store to Cue 1" }), '{class = "MessageBox", title = "Store to Cue 1"}');
  assert.equal(lua({ no: 7, name: "Dimmer", skip: undefined }), '{no = 7, name = "Dimmer"}');
  assert.throws(() => lua({ "bad key": 1 }), /cannot embed key/);
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
  assert.deepEqual(kb25Keys([{ name: "KB25 Probe", fid: "902", patch: "2.009", conflict: "No" }, { name: "KB25 Probe", fid: "901", patch: "2.001" }]), ["KB25 Probe|901|2.001", "KB25 Probe|902|2.009"]);
  assert.ok(sameFingerprint(fp(), fp()));
  assert.ok(!sameFingerprint(fp(1), fp(2)));
  assert.ok(!sameFingerprint(fp(), false as any));
  assert.ok(!sameFingerprint({ ...fp(), complete: false }, { ...fp(), complete: false }), "two incomplete fingerprints are never equal");
  const a = combineFingerprints(["A", "B"], [{ name: "A", fp: { complete: true, objects: 2, hash: 5 } }, { name: "B", fp: { complete: true, objects: 3, hash: 6 } }]);
  assert.deepEqual(a, { complete: true, objects: 5, hash: "A:2:5,B:3:6" });
  assert.equal(combineFingerprints(["A", "B"], [{ name: "A", fp: { complete: true, objects: 2, hash: 5 } }]).complete, false, "a missing part is incomplete");
  assert.match(combineFingerprints(["A"], [{ name: "A", fp: { complete: false, reason: "more than 3 objects" } }]).reason, /A: more than 3 objects/);
  assert.deepEqual(addedTypes([{ no: 1, name: "Grouping" }], [{ no: 1, name: "Grouping" }, { no: 7, name: "Dimmer" }]), [{ no: 7, name: "Dimmer" }]);
  assert.deepEqual(addedTypes([{ no: 1, name: "Grouping" }], [{ no: 1, name: "Grouping" }]), []);
  // Import ownership: claimed only for a successful, attributable import.
  const before = [{ no: 1, name: "Grouping" }];
  const ok = importOwnership({ before, after: [...before, { no: 7, name: "Dimmer" }], last: 'OK: Import Library "generic@dimmer.pxml"', file: "generic@dimmer.pxml", expectName: "Dimmer" });
  assert.deepEqual(ok.tracked, { no: 7, name: "Dimmer" });
  const failedWithForeign = importOwnership({ before, after: [...before, { no: 9, name: "OperatorAdded" }], last: 'Failed: Import Library "generic@dimmer.pxml"', file: "generic@dimmer.pxml", expectName: "Dimmer" });
  assert.equal(failedWithForeign.tracked, null, "a failed import never claims the type someone else added");
  assert.match(failedWithForeign.reason, /did not report success/);
  assert.equal(importOwnership({ before, after: [...before, { no: 7, name: "Dimmer" }, { no: 9, name: "OperatorAdded" }], last: 'OK: Import Library "generic@dimmer.pxml"', file: "generic@dimmer.pxml", expectName: "Dimmer" }).tracked, null, "two new types cannot be attributed");
  assert.equal(importOwnership({ before, after: [...before, { no: 9, name: "OperatorAdded" }], last: 'OK: Import Library "generic@dimmer.pxml"', file: "generic@dimmer.pxml", expectName: "Dimmer" }).tracked, null, "a new type of another name is not the import's");
  assert.equal(importOwnership({ before, after: [...before, { no: 7, name: "Dimmer" }], last: 'OK: Import Library "other.xml"', file: "generic@dimmer.pxml", expectName: "Dimmer" }).tracked, null, "success for another file is not ours");
  assert.ok(MAX_FOOTPRINT * 2 < 101 && 201 + MAX_FOOTPRINT - 1 <= 512, "the plan's addresses never overlap each other or leave the universe");
});

test("kb25 snippets: destination changes and dialog commands only through CmdIndirect; no Oops; scoped deletes; every DMX destination checked", () => {
  const all = [
    LUA_SNAPSHOT(), LUA_API(), LUA_COLLISIONS_READONLY(), LUA_ADD_LIVE(), LUA_INDIRECT("ChangeDestination Root"),
    LUA_ADD_COPY("Stage 1", [{ amount: 2, fid: 901, name: "KB25 Probe", patch: "2.001" }]), LUA_SET_PATCH([{ fid: 902, patch: "2.101" }]),
    LUA_COLLISIONS_AFTER_EDIT(8), LUA_DELETE_KB25(null), LUA_DELETE_KB25({ no: 7, name: "Dimmer" }), LUA_CREATE_SEQ(), LUA_DELETE_SEQ(),
    LUA_INSPECT(1), LUA_INSPECT(1, STORE_DIALOG), LUA_CLICK(1, STORE_DIALOG, "Cancel"), LUA_KEY(1, LABEL_DIALOG, "Escape"),
    LUA_CHAR(1, LABEL_DIALOG, "Z"), LUA_FIELD(1, LABEL_DIALOG), LUA_FIELD(1, LABEL_DIALOG, "KB25 X"),
  ];
  for (const code of all) {
    assert.doesNotMatch(code, /Oops/, "Oops would undo the operator's work");
    for (const m of code.matchAll(/\bCmd\(([^)]*)\)/g)) assert.match(m[1], /\/NoConfirmation/, `a blocking Cmd() must not be able to open a dialog: ${m[0]}`);
  }
  for (const code of [LUA_CLICK(1, STORE_DIALOG, "Cancel"), LUA_KEY(1, STORE_DIALOG, "Enter"), LUA_CHAR(1, LABEL_DIALOG, "Z"), LUA_FIELD(1, LABEL_DIALOG, "x")]) {
    assert.match(code, /local m, md, why = bound\(/, "every dialog action re-checks its binding first");
  }
  assert.equal(LUA_INDIRECT('ChangeDestination "ShowData"."Patch"'), 'CmdIndirect("ChangeDestination \\"ShowData\\".\\"Patch\\"") return true');
  assert.match(LUA_ADD_COPY("Stage 1", []), /dest\(\) ~= "Stage 1\.Fixtures"/, "AddFixtures on the copy is guarded by the destination");
  assert.match(LUA_ADD_LIVE(), /dest\(\) ~= "Root"/);
  assert.match(LUA_DELETE_KB25(null), /if not inCopy\(\)/, "deletes only ever run on the copy");
  assert.match(LUA_DELETE_SEQ(), /is not the probe's/, "the sequence is deleted only when it carries the probe's name");
  assert.match(LUA_COLLISIONS_AFTER_EDIT(8), /FindBestDMXPatchAddr\(lp, 512, 8\)/, "the footprint is interpolated, not a Lua name");
  assert.match(LUA_COLLISIONS_AFTER_EDIT(8), /"2\.094"/, "the overlap check starts one footprint minus one before 2.101");
  const ro = LUA_COLLISIONS_READONLY();
  assert.match(ro, /CheckDMXCollision\(modeOf\(lp\), "2\.001", 2\)/, "two fixtures from 2.001 with the mode's footprint");
  assert.match(ro, /CheckDMXCollision\(modeOf\(lp\), "2\.101", 1\)/, "the readdress destination");
  assert.match(ro, /CheckDMXCollision\(modeOf\(lp\), "2\.201", 1\)/, "the FID-clash fixture's destination");
});

// ---- the generated Lua against a mock console (needs a Lua 5.4+ interpreter; CI installs lua5.4) ----

function findLua(): string | null {
  for (const bin of ["lua5.4", "lua54", "lua"]) {
    const r = spawnSync(bin, ["-e", "print(_VERSION)"], { encoding: "utf8" });
    if (r.status === 0 && /Lua 5\.[4-9]/.test(r.stdout)) return bin;
  }
  return null;
}
const luaBin = findLua();

/** Runs `body` (Lua) after a mock console; `run(code)` executes one generated snippet; `emit(k, v)` prints k=v. */
function runLua(body: string): Record<string, string> {
  const mock = `
Enums = { Roles = { Display = 1 } }
local mouse, keys = 0, 0
function Mouse() mouse = mouse + 1 end
function Keyboard() keys = keys + 1 end
local top
function GetTopModal() return top end
function WaitModal() return top end
local Node = {}; Node.__index = Node
function Node:GetClass() return self.class end
function Node:UIChildren() return self.kids or {} end
function Node:IsVisible() return true end
function Node:IsEnabled() return true end
function Node:Get(k) if k == "AbsRect" then return self.rect elseif k == "Target" then return self.target elseif k == "Content" then return self.content elseif k == "Value" then return self.value end end
function Node:Set(k, v) if k == "Content" then self.content = v end end
function Node:GetDisplayIndex() return 2 end
function Node:WaitInit() return true end
function Node:HookDelete(fn) self.onDelete = fn return true end
local function node(t) return setmetatable(t, Node) end
local function storeBox() return node{ class = "MessageBox", name = "MsgBox", kids = {
  node{ class = "TitleButton", name = "Title", Text = "Store to Cue 1" },
  node{ class = "Button", name = "Button 3", Text = "Overwrite", rect = { x = 569, y = 577, w = 132, h = 50 } },
  node{ class = "Button", name = "Button 7", Text = "Cancel", rect = { x = 1099, y = 577, w = 132, h = 50 } } } } end
local function textInput(target) return node{ class = "TextInput", name = "TextInput 3", target = target, value = "x", kids = {
  node{ class = "TitleButton", name = "Title", Text = "Edit Name" }, node{ class = "LineEdit", name = "InputField", content = "x" } } } end
local function close(m) if m.onDelete then m.onDelete() end end
local Obj = {}; Obj.__index = Obj
function Obj:Children() return self.kids or {} end
function Obj:Count() return #(self.kids or {}) end
function Obj:Delete(i) table.remove(self.kids, i) end
function Obj:Addr() return self.addr or "x" end
function Obj:GetClass() return self.class or "Obj" end
function Obj:Get(k) return self.props and self.props[k] end
local function obj(t) return setmetatable(t, Obj) end
local function patchWith(typeKids, fixtureKids, addr)
  local stage = obj{ Fixtures = obj{ kids = fixtureKids } }
  local p = obj{ addr = addr, Stages = obj{ kids = { stage } }, FixtureTypes = obj{ kids = typeKids } }
  p.Stages[1] = stage
  p.kids = { p.Stages, p.FixtureTypes }
  return p
end
local copy, live
function ShowData() return { LivePatch = live, Patch = copy } end
function Patch() return copy end
function CmdObj() return obj{ props = { Destination = "Stage 1.Fixtures", LastCommand = "" } } end
local function run(code) local f = assert(load(code, "=snippet", "t")); return f() end
local function emit(k, v) print(k .. "=" .. tostring(v)) end
local function counts() return mouse, keys end
copy = patchWith({}, {}, "14.10"); live = patchWith({}, {}, "14.9")
`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kb25-lua-")), "harness.lua");
  fs.writeFileSync(file, mock + body);
  const r = spawnSync(luaBin!, [file], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return Object.fromEntries(r.stdout.trim().split("\n").filter(Boolean).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
}

const L = (s: string) => `[==[${s}]==]`;

test("kb25 Lua: dialog input goes only to the bound dialog (replaced, same-title, closed-and-reused, unrelated TextInput)", { skip: luaBin ? false : "no Lua 5.4+ interpreter on PATH" }, () => {
  const out = runLua(`
local a = storeBox(); top = a
local r = run(${L(LUA_INSPECT(1, STORE_DIALOG))}); local tokA = r.token
emit("boundA", tokA)
-- a different dialog with the same title replaced A
top = storeBox()
r = run(${L(LUA_CLICK(1, STORE_DIALOG, "Overwrite"))}); emit("replacedRefused", r.refused ~= nil); emit("replacedWhy", r.refused)
-- A closed and its object reused as the top modal
close(a); top = a
r = run(${L(LUA_CLICK(1, STORE_DIALOG, "Cancel"))}); emit("closedRefused", r.refused ~= nil); emit("closedWhy", r.refused)
local m1, k1 = counts(); emit("mouseAfterRefusals", m1)
-- an unrelated TextInput: keys, characters and field writes for the probe's TextInput binding are refused
local t = textInput("Sequence 951"); top = t
r = run(${L(LUA_INSPECT(1, LABEL_DIALOG))}); local tokT = r.token; emit("boundT", tokT)
top = textInput("Sequence 1")
r = run(${L(LUA_KEY(2, LABEL_DIALOG, "Enter"))}); emit("enterRefused", r.refused ~= nil)
r = run(${L(LUA_CHAR(2, LABEL_DIALOG, "Z"))}); emit("charRefused", r.refused ~= nil)
r = run(${L(LUA_FIELD(2, LABEL_DIALOG, "KB25 X"))}); emit("fieldRefused", r.refused ~= nil); emit("foreignContent", top.kids[2].content)
local m2, k2 = counts(); emit("keysAfterRefusals", k2)
-- a non-matching modal is not bound at all
r = run(${L(LUA_INSPECT(1, LABEL_DIALOG))}); emit("foreignBound", r.token)
-- the bound dialog still on top receives the click at its button's centre
local c = storeBox(); top = c
r = run(${L(LUA_INSPECT(1, STORE_DIALOG))}); emit("boundC", r.token)
r = run(${L(LUA_CLICK(3, STORE_DIALOG, "Overwrite"))}); emit("clicked", r.clicked); emit("x", r.x); emit("y", r.y)
local m3 = counts(); emit("mouseAfterClick", m3)
-- the bound TextInput on top takes characters and Content
top = t
r = run(${L(LUA_CHAR(2, LABEL_DIALOG, "Z"))}); emit("charSent", r.char)
r = run(${L(LUA_FIELD(2, LABEL_DIALOG, "KB25 Y"))}); emit("fieldAfter", r.after)
`);
  assert.equal(out.boundA, "1");
  assert.equal(out.replacedRefused, "true", "a same-title dialog that replaced the bound one is refused");
  assert.match(out.replacedWhy, /not the bound dialog/);
  assert.equal(out.closedRefused, "true", "a closed dialog whose object is reused is refused");
  assert.match(out.closedWhy, /closed/);
  assert.equal(out.mouseAfterRefusals, "0", "no Mouse event for a refused click");
  assert.equal(out.boundT, "2");
  assert.equal(out.enterRefused, "true");
  assert.equal(out.charRefused, "true");
  assert.equal(out.fieldRefused, "true");
  assert.equal(out.foreignContent, "x", "the unrelated field is not written");
  assert.equal(out.keysAfterRefusals, "0", "no Keyboard event for refused keys and characters");
  assert.equal(out.foreignBound, "false", "a modal that does not match the expected identity is not bound");
  assert.equal(out.boundC, "3");
  assert.equal(out.clicked, "Overwrite");
  assert.equal(out.x, "635");
  assert.equal(out.y, "602");
  assert.equal(out.mouseAfterClick, "3", "move, press, release");
  assert.equal(out.charSent, "Z");
  assert.equal(out.fieldAfter, "KB25 Y");
});

test("kb25 Lua: cleanup deletes the probe's fixtures and only the tracked import; foreign and ambiguous types survive", { skip: luaBin ? false : "no Lua 5.4+ interpreter on PATH" }, () => {
  const out = runLua(`
local function fixture(name, fid) return obj{ class = "Fixture", name = name, FID = fid, props = { Patch = "" } } end
local function types(list) local k = {} for _, t in ipairs(list) do k[#k + 1] = obj{ no = t[1], name = t[2] } end return k end
local function names(p) local t = {} for _, c in ipairs(p.FixtureTypes:Children()) do t[#t + 1] = c.no .. " " .. c.name end return table.concat(t, ",") end
local function fixtureNames(p) local t = {} for _, c in ipairs(p.Stages[1].Fixtures:Children()) do t[#t + 1] = c.name end return table.concat(t, ",") end
copy = patchWith(types{ { 1, "Grouping" }, { 7, "Dimmer" }, { 8, "OperatorAdded" } }, { fixture("MA StartShow 1", 1), fixture("KB25 Probe", 901), fixture("Operator Fixture", 950) }, "14.10")
local r = run(${L(LUA_DELETE_KB25({ no: 7, name: "Dimmer" }))})
emit("tracked.deletedTypes", r.deletedTypes); emit("tracked.deletedFixtures", r.deletedFixtures); emit("tracked.types", names(copy)); emit("tracked.fixtures", fixtureNames(copy))
copy = patchWith(types{ { 1, "Grouping" }, { 8, "OperatorAdded" } }, {}, "14.10")
r = run(${L(LUA_DELETE_KB25(null))})
emit("untracked.deletedTypes", r.deletedTypes); emit("untracked.types", names(copy))
copy = patchWith(types{ { 7, "Dimmer" }, { 7, "Dimmer" } }, {}, "14.10")
r = run(${L(LUA_DELETE_KB25({ no: 7, name: "Dimmer" }))})
emit("ambiguous.deletedTypes", r.deletedTypes); emit("ambiguous.note", r.ambiguous); emit("ambiguous.types", names(copy))
`);
  assert.equal(out["tracked.deletedTypes"], "1");
  assert.equal(out["tracked.deletedFixtures"], "1");
  assert.equal(out["tracked.types"], "1 Grouping,8 OperatorAdded", "a type another actor added is kept");
  assert.equal(out["tracked.fixtures"], "MA StartShow 1,Operator Fixture", "only the KB25 fixture is deleted");
  assert.equal(out["untracked.deletedTypes"], "0", "without a tracked import no type is deleted");
  assert.equal(out["untracked.types"], "1 Grouping,8 OperatorAdded");
  assert.equal(out["ambiguous.deletedTypes"], "0");
  assert.match(out["ambiguous.note"], /2 fixture types match/);
  assert.equal(out["ambiguous.types"], "7 Dimmer,7 Dimmer");
});

// ---- the CLI against a fake bridge ----

test("kb25 verify passes on a consistent console and sends only reads", async () => {
  const bridge = await startFakeBridge(luaFake(() => snapshot()));
  try {
    const r = await run(["verify"], { GMA3_BRIDGE_PORT: String(bridge.port) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /PASS the Lua API has AddFixtures/);
    assert.match(r.stdout, /PASS CheckFIDCollision \/ CheckDMXCollision report an existing patched fixture/);
    assert.match(r.stdout, /PASS the live patch's fingerprint is complete/);
    assert.match(r.stdout, /5 passed, 0 failed/);
    assert.deepEqual([...new Set(bridge.ops)].sort(), ["lua", "ping"]);
    assert.ok(bridge.codes.every((c) => !MUTATING.test(c)), "verify sends no mutating Lua");
  } finally { bridge.close(); }
});

test("kb25 verify fails when the collision helpers call a patched fixture free", async () => {
  const bridge = await startFakeBridge(luaFake(() => snapshot(), () => readonly({ ref: { fid: 401, patch: "1.279", mode: "m", fidFree: true, dmxFree: false } })));
  try {
    const r = await run(["verify"], { GMA3_BRIDGE_PORT: String(bridge.port) });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /FAIL CheckFIDCollision \/ CheckDMXCollision report an existing patched fixture/);
  } finally { bridge.close(); }
});

test("kb25 run refuses a non-disposable show, Lua disabled, a busy bridge and unknown phases before any Lua", async () => {
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
    r = await run(["run"], { GMA3_BRIDGE_PORT: String(bridge.port), KB25_PHASES: "patch,nonsense" });
    assert.equal(r.status, 2); assert.match(r.stderr, /KB25_PHASES/);
    assert.deepEqual([...new Set(bridge.ops)], ["ping"]);
  } finally { bridge.close(); }
});

test("kb25 run's preflight refuses an open modal, an open copy, KB25 fixtures, a taken sequence, FIDs or any planned DMX destination, and changes nothing", async () => {
  const taken = (at: string) => readonly({ targetDmx: DMX_PLAN.map(([a, n]: number[]) => ({ at: dmx(2, a), count: n, free: dmx(2, a) !== at })) });
  const cases: Array<[Record<string, unknown>, unknown, RegExp]> = [
    [{ modal: { class: "MessageBox", title: "Store to Cue 1" } }, readonly(), /a modal is open/],
    [{ inCopy: true, dest: "Stage 1.Fixtures", copyCount: 15 }, readonly(), /patch copy is open/],
    [{ dest: "ShowData.DataPools" }, readonly(), /destination is ShowData\.DataPools/],
    [{ liveKb25: [{ name: "KB25 Probe", fid: "901", patch: "2.001" }] }, readonly(), /already holds fixtures named/],
    [{ seq: "Main Cues" }, readonly(), /Sequence 951 exists/],
    [{}, readonly({ targetFidFree: false }), /FID 901\.\.903 is not free/],
    [{}, taken("2.001"), /2\.001 x2 \(the mode's footprint\) is not free/],
    [{}, taken("2.101"), /2\.101 x1 \(the mode's footprint\) is not free/],
    [{}, taken("2.201"), /2\.201 x1 \(the mode's footprint\) is not free/],
    [{}, readonly({ targetDmx: undefined }), /DMX destinations could not be checked/],
    [{}, readonly({ mode: false }), /no DMX mode at FixtureTypes\[6\]\.DMXModes\[3\]/],
  ];
  for (const [snap, ro, why] of cases) {
    const bridge = await startFakeBridge(luaFake(() => snapshot(snap), () => ro));
    try {
      const r = await run(["run"], { GMA3_BRIDGE_PORT: String(bridge.port) });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stdout, /FAIL run: preflight/);
      assert.match(r.stdout, why);
      assert.ok(bridge.codes.every((c) => !MUTATING.test(c)), `nothing was changed for ${why}`);
    } finally { bridge.close(); }
  }
});

test("kb25 run: a refused sequence creation stops the dialog phase before any Store or Label command", async () => {
  const bridge = await startFakeBridge(luaFake(() => snapshot(), () => readonly(), (code) => {
    if (code === LUA_CREATE_SEQ()) return { skipped: "sequence exists" };
    if (code === LUA_DELETE_SEQ()) return { refused: "sequence 951 is not the probe's: Main Cues" };
    return undefined;
  }));
  try {
    const r = await run(["run"], { GMA3_BRIDGE_PORT: String(bridge.port), KB25_PHASES: "dialogs" });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /FAIL run: Sequence 951 created/);
    assert.match(r.stdout, /NOTE run: stopped after a failed prerequisite/);
    assert.ok(!bridge.codes.some((c) => /CmdIndirect\(.*(Store Sequence|Label Sequence)/.test(c)), "no Store or Label command after the refusal");
    assert.ok(!bridge.codes.some((c) => /Mouse\(|Keyboard\(/.test(c) && !/bound\(/.test(c)), "no unguarded dialog input");
    assert.ok(!bridge.codes.some((c) => c.includes("pcall(AddFixtures")), "the patch phase did not run");
  } finally { bridge.close(); }
});

test("kb25 run: a destination that never changes stops the patch phase before AddFixtures on the copy or a commit", async () => {
  const bridge = await startFakeBridge(luaFake(() => snapshot(), () => readonly(), (code) => {
    if (code === LUA_ADD_LIVE()) return { ok: true, ret: "nil", liveKb25: [] };
    if (code.startsWith("CmdIndirect(")) return true;
    return undefined;
  }));
  try {
    const r = await run(["run"], { GMA3_BRIDGE_PORT: String(bridge.port), KB25_PHASES: "patch" });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /FAIL run: CmdIndirect ChangeDestination "ShowData"\."Patch" fills the ShowData\.Patch copy/);
    assert.ok(!bridge.codes.some((c) => c.includes("modeOf(sd.Patch)")), "no AddFixtures on the copy");
    assert.ok(!bridge.codes.some((c) => c.includes('CmdIndirect("ChangeDestination Root")')), "nothing was committed");
    assert.match(r.stdout, /PASS run: every registered cleanup ran/, "the cleanup found nothing of the probe's to restore");
  } finally { bridge.close(); }
});

test("kb25 run: a foreign change in the shared copy is never committed, by the run or by the cleanup", async () => {
  let entered = false;
  const inCopy = () => snapshot({ inCopy: true, dest: "ShowData.Patch", patchAddr: "14.10", copyCount: 15 });
  const bridge = await startFakeBridge(luaFake(() => (entered ? inCopy() : snapshot()), () => readonly(), (code) => {
    if (code === LUA_ADD_LIVE()) return { ok: true, ret: "nil", liveKb25: [] };
    if (code === LUA_INDIRECT('ChangeDestination "ShowData"."Patch"')) { entered = true; return true; }
    if (code.startsWith("CmdIndirect(")) return true;
    if (code === LUA_DELETE_KB25(null)) return { deletedFixtures: 0, deletedTypes: 0, copyKb25: [], copyTypeList: [] };
    return undefined;
  }, (which) => (which === "copy" ? fp(99) : fp())));
  try {
    const r = await run(["run"], { GMA3_BRIDGE_PORT: String(bridge.port), KB25_PHASES: "patch" });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /FAIL run: the copy holds nothing but the live patch and the probe's own fixtures on entry/);
    assert.match(r.stdout, /NOT committed: the shared patch copy holds changes the probe did not make/);
    assert.ok(!bridge.codes.some((c) => c.includes('CmdIndirect("ChangeDestination Root")')), "neither the run nor the cleanup committed");
    assert.ok(!bridge.codes.some((c) => c.includes("modeOf(sd.Patch)")), "nothing was added to a copy holding a foreign change");
  } finally { bridge.close(); }
});

test("kb25 Lua: the patch fingerprint sees foreign edits anywhere and ignores only the probe's fixtures and derived data", { skip: luaBin ? false : "no Lua 5.4+ interpreter on PATH" }, () => {
  const out = runLua(`
local FP = {}; FP.__index = FP
function FP:GetClass() return self.class end
function FP:Children() return self.kids end
function FP:Count() return #self.kids end
function FP:Addr() return self.addr or "x" end
function FP:PropertyCount() return #self.pn end
function FP:PropertyName(i) return self.pn[i + 1] end
function FP:Get(k) if self.badGet == k then error("unreadable") end return self.pv[k] end
local function mk(class, name, no, props, kids)
  local o = setmetatable({ class = class, name = name, no = no, pn = { "NAME" }, pv = { NAME = name }, kids = kids or {} }, FP)
  for _, kv in ipairs(props or {}) do o.pn[#o.pn + 1] = kv[1]; o.pv[kv[1]] = kv[2] end
  return o
end
local function fixture(name, fid, cid, patch, kids) return mk("Fixture", name, fid, { { "FID", fid }, { "CID", cid }, { "PATCH", patch } }, kids) end
-- A small patch with every rule in play; edit(d) changes one thing in the copy.
local function build(addr, edit)
  local d = { stage2 = {}, cid = "None", sub = "1.010", typeName = "Mega Hex Par", uniName = "DmxUniverse 2", probe = false,
    realused = 12, maxid = 704, granted = "Yes", locked = "Yes", net = "No", curveNo = 18, used = 0, badGet = nil }
  if edit then edit(d) end
  local par = fixture("Par 1", 401, d.cid, "1.001", { fixture("Par 1 cell", 4011, "None", d.sub) })
  par.badGet = d.badGet
  local s1 = { par }
  if d.probe then s1[#s1 + 1] = fixture("KB25 Probe", 901, "None", "2.001") end
  local stages = { mk("Stage", "Stage 1", 1, { { "STRUCTURELOCKED", d.locked }, { "IGNORENETWORK", d.net } }, { mk("Fixtures", "Fixtures", 1, { { "COUNT", #s1 } }, s1) }) }
  if #d.stage2 > 0 then stages[2] = mk("Stage", "Stage 2", 2, {}, { mk("Fixtures", "Fixtures", 1, { { "COUNT", #d.stage2 } }, d.stage2) }) end
  local p = mk("Patch", "Patch", 1, {}, {
    mk("DmxCurves", "DmxCurves", 1, {}, { mk("DmxCurve", "DmxCurve 1", 1, {}, { mk("DmxCurvePoint", "Max", d.curveNo, { { "INDEX", d.curveNo }, { "VALUE", "100" } }) }) }),
    mk("FixtureTypes", "FixtureTypes", 2, {}, { mk("FixtureType", d.typeName, 6, { { "REALUSED", d.realused } }) }),
    mk("Stages", "Stages", 3, {}, stages),
    mk("IDTypes", "IDTypes", 4, {}, { mk("IDs", "Fixture", 1, { { "MAXID", d.maxid } }) }),
    mk("DmxUniverses", "DmxUniverses", 5, {}, { mk("DmxUniverse", d.uniName, 2, { { "GRANTED", d.granted }, { "USED", d.used } }, { mk("DMX", "DMX 1", d.curveNo) }) }),
    mk("DmxAddresses", "DmxAddresses", 6, {}, { mk("DmxAddress", "a", d.curveNo) }),
    mk("PatchFilter", "PatchFilter", 7, { { "FILTER", d.curveNo } }),
  })
  p.addr = addr
  return p
end
local FPS = ${L(LUA_FINGERPRINTS())}
local function compare(label, edit)
  live = build("14.9"); copy = build("14.10", edit)
  local r = run(FPS)
  emit(label, tostring(r.copy.complete and r.live.complete and r.copy.objects == r.live.objects and r.copy.hash == r.live.hash) .. "|" .. tostring(r.copy.complete) .. "|" .. tostring(r.copy.reason))
end
compare("unchanged", nil)
compare("cid", function(d) d.cid = "301" end)
compare("stage2", function(d) d.stage2 = { fixture("Operator Fixture", 950, "None", "3.001") } end)
compare("subfixture", function(d) d.sub = "1.020" end)
compare("typeName", function(d) d.typeName = "Mega Hex Par 2" end)
compare("universeName", function(d) d.uniName = "Front Truss" end)
compare("probeAndDerived", function(d) d.probe = true; d.realused = 13; d.maxid = 901; d.granted = "No"; d.used = 8 end)
compare("editState", function(d) d.locked = "No"; d.net = "Yes" end)
compare("curveRenumbered", function(d) d.curveNo = 19 end)
compare("unreadable", function(d) d.badGet = "CID" end)
KB25_FP_LIMIT = 3
compare("limit", nil)
`);
  const verdict = (k: string) => out[k].split("|");
  assert.deepEqual(verdict("unchanged").slice(0, 2), ["true", "true"]);
  for (const k of ["cid", "stage2", "subfixture", "typeName", "universeName"]) assert.equal(verdict(k)[0], "false", `${k}: a foreign edit must change the fingerprint`);
  for (const k of ["probeAndDerived", "editState", "curveRenumbered"]) assert.equal(verdict(k)[0], "true", `${k}: the probe's fixtures, derived data and the copy's edit state must not`);
  assert.deepEqual(verdict("unreadable").slice(0, 3), ["false", "false", "property CID of Par 1 could not be read"], "an unreadable property makes the fingerprint incomplete");
  assert.deepEqual(verdict("limit").slice(0, 3), ["false", "false", "more than 3 objects"], "the object limit makes it incomplete");
});

test("kb25 run: a failed import while someone else adds a type claims nothing, deletes no type and commits nothing", async () => {
  let stage: "root" | "patch" | "types" | "imported" = "root";
  const before = typeList;
  const after = [...typeList, { no: 9, name: "OperatorAdded" }];
  const snap = () => {
    if (stage === "root") return snapshot();
    return snapshot({ inCopy: true, patchAddr: "14.10", copyCount: 15, dest: stage === "patch" ? "ShowData.Patch" : "FixtureTypes", copyTypeList: stage === "imported" ? after : before, last: stage === "imported" ? 'Failed: Import Library "generic@dimmer.pxml"' : "OK: ChangeDestination" });
  };
  const bridge = await startFakeBridge(luaFake(snap, () => readonly(), (code) => {
    if (code === LUA_INDIRECT('ChangeDestination "ShowData"."Patch"')) { stage = "patch"; return true; }
    if (code === LUA_INDIRECT('ChangeDestination "FixtureTypes"')) { stage = "types"; return true; }
    if (code === LUA_INDIRECT('Import Library "generic@dimmer.pxml"')) { stage = "imported"; return true; }
    if (code.startsWith("CmdIndirect(")) return true;
    if (code === LUA_DELETE_KB25(null)) return { deletedFixtures: 0, deletedTypes: 0, copyKb25: [], copyTypeList: after };
    return undefined;
  }, (which) => (which === "copy" && stage === "imported" ? fp(2) : fp(1))));
  try {
    const r = await run(["run"], { GMA3_BRIDGE_PORT: String(bridge.port), KB25_PHASES: "import" });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /FAIL run: Import Library "generic@dimmer\.pxml" in the copy's FixtureTypes reports success/);
    assert.match(r.stdout, /did not report success/);
    assert.match(r.stdout, /NOT committed: the shared patch copy holds changes the probe did not make/);
    assert.ok(!bridge.codes.some((c) => /local tracked = \{/.test(c)), "no fixture type was claimed for deletion");
    assert.ok(bridge.codes.some((c) => c === LUA_DELETE_KB25(null)), "the cleanup ran with nothing tracked");
    assert.ok(!bridge.codes.some((c) => c.includes('CmdIndirect("ChangeDestination Root")')), "nothing was committed");
  } finally { bridge.close(); }
});
