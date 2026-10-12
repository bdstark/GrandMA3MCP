#!/usr/bin/env node
// KB-25 dialog-free patching / dialog control probe against a RUNNING bridge with Lua enabled (see DIALOG.md "KB-25",
// docs/probes/kb-25-dialogs-macos-2.5.1.md).
//
//   node scripts/kb25-probe.mjs verify [--out report.json]   read-only: the Lua API surface, the live patch structure,
//                                                           CheckFIDCollision / CheckDMXCollision against an existing
//                                                           fixture, FindBestDMXPatchAddr; nothing is entered or changed
//   node scripts/kb25-probe.mjs run    [--out report.json]   verify + on a DISPOSABLE show: patch edits through the
//                                                           ShowData.Patch edit copy (add, readdress, unpatch, collisions,
//                                                           delete, a library type import that is never committed) and a
//                                                           scratch sequence's Store / Label dialogs answered by Mouse
//                                                           clicks, Escape / Enter and the text field's Content
//
// Rules the run keeps (the manual pass established why):
// - Every command that changes the command-line destination or may open a dialog goes through CmdIndirect, never Cmd():
//   a dialog opened by Cmd() on the plugin thread stalls the bridge. CmdIndirect lands on a later frame, so every step
//   that acts on the edit copy first checks the destination it expects and does nothing otherwise.
// - A committed patch edit has no undo (Oops fails), so the cleanup deletes by identity: top-level fixtures whose name
//   starts with "KB25 " and fixture types that were not in the show at the start. The preflight refuses a show that
//   already has such fixtures, a taken FID range or DMX range, a taken sequence, an open modal, an open patch copy
//   (someone is in the Patch menu) or a command line away from Root.
// - Oops itself is not sent: if anything else were undoable it would undo the operator's work.
// - A dialog is answered only when it is the probe's own (title "Store to Cue 1" / TextInput targeting the scratch
//   sequence); the cleanup never touches any other modal.
import net from "node:net";
import fs from "node:fs";
import { createCleanup } from "./lib/kb16-steps.mjs";

const host = process.env.GMA3_BRIDGE_HOST ?? "127.0.0.1";
const port = Number(process.env.GMA3_BRIDGE_PORT ?? 9800);
const argv = process.argv.slice(2);
const mode = argv[0];
const outIdx = argv.indexOf("--out");
const outFile = outIdx >= 0 ? argv[outIdx + 1] : null;
const SHOW_GUARD = /disposable|mcp-test|scratch/i;
const FID = Number(process.env.KB25_FID ?? 901);
const UNIVERSE = Number(process.env.KB25_UNIVERSE ?? 2);
const SEQ = Number(process.env.KB25_SEQ ?? 951);
// Fixture type and DMX mode as child indexes of LivePatch.FixtureTypes / .DMXModes ("6.3" = Mega Hex Par Ch08 in the test show).
const [TYPE_IDX, MODE_IDX] = String(process.env.KB25_MODE ?? "6.3").split(".").map(Number);
const IMPORT_FILE = process.env.KB25_IMPORT ?? "generic@dimmer.pxml";
const PREFIX = "KB25 ";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A Lua literal for a JS string / number / boolean / array (ASCII strings only; JSON escapes are valid Lua escapes). */
export function lua(v) {
  if (Array.isArray(v)) return `{${v.map(lua).join(",")}}`;
  if (typeof v === "string") {
    if (/[^\x20-\x7e]/.test(v)) throw new Error(`non-ASCII text cannot be embedded: ${JSON.stringify(v)}`);
    return JSON.stringify(v);
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return String(v);
  throw new Error(`cannot embed ${typeof v} in Lua`);
}

/** "U.AAA" for a universe and a 1-based address in it. */
export function dmx(universe, address) {
  return `${universe}.${String(address).padStart(3, "0")}`;
}

/** The 0-based absolute address FindBestDMXPatchAddr takes and returns, for a universe and a 1-based address. */
export function absolute0(universe, address) {
  return (universe - 1) * 512 + (address - 1);
}

/** The DMX footprint implied by two consecutive AddFixtures fixtures ("2.001", "2.009" -> 8), or null. */
export function footprintOf(first, second) {
  const a = /^(\d+)\.(\d+)$/.exec(String(first ?? "")), b = /^(\d+)\.(\d+)$/.exec(String(second ?? ""));
  if (!a || !b || a[1] !== b[1]) return null;
  const fp = Number(b[2]) - Number(a[2]);
  return fp > 0 ? fp : null;
}

/** The visible, enabled button (class Button, as LUA_CLICK requires) with this exact text in an inspection, or null. */
export function findButton(nodes, text) {
  return (nodes ?? []).find((n) => n.class === "Button" && n.text === text && n.vis !== false && n.en !== false && n.rect) ?? null;
}

/** The centre of an AbsRect, in whole pixels. */
export function centre(rect) {
  return { x: Math.floor(rect.x + rect.w / 2), y: Math.floor(rect.y + rect.h / 2) };
}

/** The dialog's title (the node named "Title") and message text (the node named "Text") from an inspection. */
export function dialogText(nodes) {
  const title = (nodes ?? []).find((n) => n.name === "Title")?.text ?? null;
  const message = (nodes ?? []).find((n) => n.name === "Text")?.text ?? null;
  return { title, message };
}

/** Whether the inspected modal is one of the probe's own dialogs (so the probe may answer or close it). */
export function isOwnDialog(modal, seq = SEQ) {
  if (!modal) return false;
  if (modal.class === "MessageBox") return modal.title === "Store to Cue 1";
  if (modal.class === "TextInput") return modal.target === `Sequence ${seq}`;
  return false;
}

// ---- Lua snippets (exported for the unit test) ----

const PRELUDE = `
local sd = ShowData(); local lp = sd.LivePatch
local function dest() return tostring(CmdObj():Get("Destination", Enums.Roles.Display)) end
local function inCopy() return Patch():Addr() == sd.Patch:Addr() and sd.Patch:Count() > 0 end
local function modeOf(p) local t = p.FixtureTypes and p.FixtureTypes[${TYPE_IDX}]; return t and t.DMXModes and t.DMXModes[${MODE_IDX}] end
local function fixtures(p)
  local out = { count = 0, kb25 = {} }
  if not p.Stages or p.Stages:Count() == 0 then return out end
  local function walk(h, depth)
    for _, c in ipairs(h:Children()) do
      if c:GetClass() == "Fixture" then
        out.count = out.count + 1
        local n = tostring(c.name)
        if n:sub(1, ${PREFIX.length}) == ${lua(PREFIX)} then out.kb25[#out.kb25 + 1] = { name = n, fid = tostring(c.FID), patch = tostring(c:Get("Patch")), conflict = tostring(c:Get("ConflitedPatch", Enums.Roles.Display)), depth = depth } end
        walk(c, depth + 1)
      end
    end
  end
  walk(p.Stages[1].Fixtures, 0)
  return out
end
local function typeNames(p) local t = {} if p.FixtureTypes then for _, c in ipairs(p.FixtureTypes:Children()) do t[#t + 1] = tostring(c.name) end end return t end
local function modal()
  local m = GetTopModal()
  if not m then return false end
  local r = { name = m.name, class = m:GetClass(), display = m:GetDisplayIndex() }
  pcall(function() r.target = tostring(m:Get("Target")) end)
  local function find(h) for _, c in ipairs(h:UIChildren() or {}) do if c.name == "Title" then r.title = c.Text return end find(c) if r.title then return end end end
  pcall(find, m)
  return r
end
local function seqName() local s = DataPool().Sequences[${SEQ}]; return s and s.name or false end
`;

/** A snapshot of everything the probe judges: destination, copy, live and copy fixtures/types, modal, scratch sequence. */
export const LUA_SNAPSHOT = () => `${PRELUDE}
local live = fixtures(lp)
local copy = inCopy() and fixtures(sd.Patch) or { count = 0, kb25 = {} }
return { dest = dest(), last = tostring(CmdObj():Get("LastCommand")), inCopy = inCopy(), patchAddr = Patch():Addr(), liveAddr = lp:Addr(), copyAddr = sd.Patch:Addr(), copyCount = sd.Patch:Count(),
  stage = lp.Stages[1].name, liveFixtures = live.count, liveKb25 = live.kb25, copyFixtures = copy.count, copyKb25 = copy.kb25,
  liveTypes = typeNames(lp), copyTypes = inCopy() and typeNames(sd.Patch) or {}, modal = modal(), seq = seqName() }`;

/** The Lua API the probe relies on, and its arity as the console reports it (read-only). */
export const API_NAMES = ["AddFixtures", "CheckFIDCollision", "CheckDMXCollision", "FindBestDMXPatchAddr", "CmdIndirect", "GetTopModal", "WaitModal", "GetTopOverlay", "Mouse", "Keyboard"];
export const LUA_API = () => `return { ${API_NAMES.map((n) => `${n} = type(${n}) == "function"`).join(", ")} }`;

/** Read-only checks against an existing patched fixture and the probe's target ranges. */
export const LUA_COLLISIONS_READONLY = () => `${PRELUDE}
local ref
local function walk(h) for _, c in ipairs(h:Children()) do if c:GetClass() == "Fixture" then if not ref and type(c.FID) == "number" and tostring(c:Get("Patch")) ~= "" and c.ModeDirect then ref = c end walk(c) end end end
walk(lp.Stages[1].Fixtures)
local out = { mode = modeOf(lp) and modeOf(lp):Addr() or false }
if ref then out.ref = { fid = ref.FID, patch = tostring(ref:Get("Patch")), mode = ref.ModeDirect:Addr(), fidFree = CheckFIDCollision(ref.FID), dmxFree = CheckDMXCollision(ref.ModeDirect, tostring(ref:Get("Patch"))) } end
if modeOf(lp) then
  out.targetFidFree = CheckFIDCollision(${FID}, 3)
  out.targetDmxFree = CheckDMXCollision(modeOf(lp), ${lua(dmx(UNIVERSE, 1))}, 32)
end
out.best0 = FindBestDMXPatchAddr(lp, ${absolute0(UNIVERSE, 1)}, 1)
return out`;

/** AddFixtures with the command line at Root, on the live patch (the manual pass: returns nil, creates nothing). */
export const LUA_ADD_LIVE = () => `${PRELUDE}
if inCopy() or dest() ~= "Root" then return { skipped = "not at Root on the live patch: " .. dest() } end
local r = { pcall(AddFixtures, { mode = modeOf(lp), amount = 1, fid = ${lua(String(FID))}, name = ${lua(PREFIX + "LiveAttempt")}, patch = { ${lua(dmx(UNIVERSE, 1))} } }) }
return { ok = r[1], ret = tostring(r[2]), liveKb25 = fixtures(lp).kb25 }`;

/** One CmdIndirect, nothing else (the effect is read in a later request). */
export const LUA_INDIRECT = (command) => `CmdIndirect(${lua(command)}) return true`;

/** AddFixtures on the copy, only when the destination is the stage's fixtures. */
export const LUA_ADD_COPY = (stage, entries) => `${PRELUDE}
if not inCopy() or dest() ~= ${lua(stage + ".Fixtures")} then return { skipped = "destination is " .. dest() } end
local res = {}
for _, e in ipairs(${luaEntries(entries)}) do
  local r = { pcall(AddFixtures, { mode = modeOf(sd.Patch), amount = e[1], fid = e[2], name = e[3], patch = { e[4] } }) }
  res[#res + 1] = { ok = r[1], ret = tostring(r[2]) }
end
return { results = res, copyKb25 = fixtures(sd.Patch).kb25, liveKb25 = fixtures(lp).kb25 }`;

function luaEntries(entries) {
  return `{${entries.map((e) => `{${lua(e.amount)},${lua(String(e.fid))},${lua(e.name)},${lua(e.patch)}}`).join(",")}}`;
}

/** Set("Patch", …) on KB25 fixtures of the copy by FID: [{ fid, patch }]. */
export const LUA_SET_PATCH = (edits) => `${PRELUDE}
if not inCopy() then return { skipped = "not in the patch copy" } end
local want = {} for _, e in ipairs({${edits.map((e) => `{${lua(e.fid)},${lua(e.patch)}}`).join(",")}}) do want[e[1]] = e[2] end
local done = {}
local function walk(h) for _, c in ipairs(h:Children()) do if c:GetClass() == "Fixture" then
  if tostring(c.name):sub(1, ${PREFIX.length}) == ${lua(PREFIX)} and want[c.FID] then local ok, err = pcall(function() c:Set("Patch", want[c.FID]) end); done[#done + 1] = { fid = c.FID, ok = ok, err = err and tostring(err) or nil } end
  walk(c) end end end
walk(sd.Patch.Stages[1].Fixtures)
return { done = done, copyKb25 = fixtures(sd.Patch).kb25 }`;

/** Live-patch collision checks after the readdress / unpatch step (fp = footprint). */
export const LUA_COLLISIONS_AFTER_EDIT = (fp) => `${PRELUDE}
local m = modeOf(lp)
return { fidTaken = CheckFIDCollision(${FID}), fidAfterFree = CheckFIDCollision(${FID + 2}, 3),
  dmxTaken = CheckDMXCollision(m, ${lua(dmx(UNIVERSE, 101))}), dmxOverlap = CheckDMXCollision(m, ${lua(dmx(UNIVERSE, 101 - fp + 1))}),
  dmxBefore = CheckDMXCollision(m, ${lua(dmx(UNIVERSE, 101 - fp))}), dmxFirstFree = CheckDMXCollision(m, ${lua(dmx(UNIVERSE, 1))}, 2),
  best = FindBestDMXPatchAddr(lp, ${absolute0(UNIVERSE, 1)}, ${lua(fp)}) }`;

/** Delete the copy's top-level KB25 fixtures and every fixture type not in `keepTypes`; returns what is left. */
export const LUA_DELETE_KB25 = (keepTypes) => `${PRELUDE}
if not inCopy() then return { skipped = "not in the patch copy" } end
local fx = sd.Patch.Stages[1].Fixtures
local pos = {} for i, c in ipairs(fx:Children()) do if tostring(c.name):sub(1, ${PREFIX.length}) == ${lua(PREFIX)} then pos[#pos + 1] = i end end
for k = #pos, 1, -1 do fx:Delete(pos[k]) end
local keep = {} for _, n in ipairs(${lua(keepTypes)}) do keep[n] = (keep[n] or 0) + 1 end
local ft = sd.Patch.FixtureTypes
local seen, drop = {}, {}
for i, t in ipairs(ft:Children()) do local n = tostring(t.name); seen[n] = (seen[n] or 0) + 1; if seen[n] > (keep[n] or 0) then drop[#drop + 1] = i end end
for k = #drop, 1, -1 do ft:Delete(drop[k]) end
return { deletedFixtures = #pos, deletedTypes = #drop, copyKb25 = fixtures(sd.Patch).kb25, copyTypes = typeNames(sd.Patch) }`;

/** Create the scratch sequence with one cue and name it (Store with /NoConfirmation opens no dialog). */
export const LUA_CREATE_SEQ = () => `if DataPool().Sequences[${SEQ}] then return { skipped = "sequence exists" } end
Cmd(${lua(`Store Sequence ${SEQ} Cue 1 /NoConfirmation`)})
local s = DataPool().Sequences[${SEQ}]
if s then s:Set("Name", ${lua(PREFIX + "Dialog Probe")}) end
return { name = s and s.name or false, last = tostring(CmdObj():Get("LastCommand")) }`;

/** Delete the scratch sequence, only when it carries the probe's name prefix. */
export const LUA_DELETE_SEQ = () => `local s = DataPool().Sequences[${SEQ}]
if not s then return { deleted = true, already = true } end
if tostring(s.name):sub(1, ${PREFIX.length}) ~= ${lua(PREFIX)} then return { refused = "sequence ${SEQ} is not the probe's: " .. tostring(s.name) } end
Cmd(${lua(`Delete Sequence ${SEQ} /NoConfirmation`)})
return { deleted = DataPool().Sequences[${SEQ}] == nil, last = tostring(CmdObj():Get("LastCommand")) }`;

/** Inspect the top modal (waiting up to `secs`): identity plus a bounded list of visible nodes. */
export const LUA_INSPECT = (secs = 1) => `${PRELUDE}
local m = ${secs > 0 ? `WaitModal(${secs})` : "GetTopModal()"}
if not m then return { modal = false } end
pcall(function() m:WaitInit(1) end)
local nodes, n = {}, 0
local function walk(h, d)
  if n >= 120 or d > 8 then return end
  n = n + 1
  if h:IsVisible() then
    local e = { d = d, class = h:GetClass(), name = h.name, en = h:IsEnabled() }
    pcall(function() local t = h.Text; if t ~= nil and t ~= "" then e.text = t end end)
    pcall(function() e.rect = h:Get("AbsRect") end)
    pcall(function() local c = h:Get("Content"); if c ~= nil then e.content = tostring(c) end end)
    if e.class ~= "VirtualKeyboardButton" then nodes[#nodes + 1] = e end
  end
  for _, c in ipairs(h:UIChildren() or {}) do walk(c, d + 1) end
end
walk(m, 0)
return { modal = modal(), nodes = nodes }`;

/** Click the visible button with this text in the probe's own dialog via Mouse move/press/release at its centre. */
export const LUA_CLICK = (text) => `${PRELUDE}
local md = modal()
if not md then return { skipped = "no modal" } end
local m = GetTopModal()
local target
local function find(h) for _, c in ipairs(h:UIChildren() or {}) do if c:GetClass() == "Button" and c.Text == ${lua(text)} and c:IsVisible() and c:IsEnabled() then target = c return end find(c) if target then return end end end
find(m)
if not target then return { skipped = "no visible enabled button " .. ${lua(text)}, modal = md } end
local r = target:Get("AbsRect")
local x, y = math.floor(r.x + r.w / 2), math.floor(r.y + r.h / 2)
Mouse(md.display, "move", x, y) Mouse(md.display, "press", "Left") Mouse(md.display, "release", "Left")
return { clicked = ${lua(text)}, display = md.display, x = x, y = y, modal = md }`;

/** Press and release one key on the modal's display. */
export const LUA_KEY = (key) => `${PRELUDE}
local md = modal()
if not md then return { skipped = "no modal" } end
Keyboard(md.display, "press", ${lua(key)}) Keyboard(md.display, "release", ${lua(key)})
return { key = ${lua(key)}, display = md.display, modal = md }`;

/** One character event on the modal's display. */
export const LUA_CHAR = (ch) => `${PRELUDE}
local md = modal()
if not md then return { skipped = "no modal" } end
Keyboard(md.display, "char", ${lua(ch)})
return { char = ${lua(ch)}, display = md.display }`;

/** Read (and optionally write) the TextInput's InputField Content; only on the TextInput targeting the scratch sequence. */
export const LUA_FIELD = (write) => `${PRELUDE}
local md = modal()
if not md or md.class ~= "TextInput" or md.target ~= ${lua(`Sequence ${SEQ}`)} then return { skipped = "not the probe's TextInput", modal = md } end
local m = GetTopModal()
pcall(function() m:WaitInit(1) end)
local field
local function find(h) for _, c in ipairs(h:UIChildren() or {}) do if c.name == "InputField" then field = c return end find(c) if field then return end end end
find(m)
if not field then return { skipped = "no InputField" } end
local before = tostring(field:Get("Content"))
${write === undefined ? "return { before = before, value = tostring(m:Get(\"Value\")) }" : `local ok, err = pcall(function() field:Set("Content", ${lua(write)}) end)
return { before = before, setOk = ok, setErr = err and tostring(err) or nil, after = tostring(field:Get("Content")), value = tostring(m:Get("Value")) }`}`;

class Conn {
  constructor(name) { this.name = name; this.seq = 0; this.pending = new Map(); this.buf = ""; this.sock = null; }
  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host, port }, () => resolve());
      sock.setEncoding("utf8");
      sock.on("error", (e) => { for (const p of this.pending.values()) p.reject(e); this.pending.clear(); reject(e); });
      sock.on("data", (chunk) => {
        this.buf += chunk;
        let idx;
        while ((idx = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, idx); this.buf = this.buf.slice(idx + 1);
          if (!line.trim()) continue;
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          const p = this.pending.get(msg.id);
          if (p) { this.pending.delete(msg.id); p.resolve(msg); }
        }
      });
      sock.on("close", () => { for (const p of this.pending.values()) p.reject(new Error("socket closed")); this.pending.clear(); });
      this.sock = sock;
    });
  }
  request(op, args = {}, timeoutMs = 8000) {
    const id = `${this.name}${++this.seq}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout: ${op}`)); }, timeoutMs);
      this.pending.set(id, { resolve: (m) => { clearTimeout(t); resolve(m); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.sock.write(JSON.stringify({ id, op, args }) + "\n");
    });
  }
  end() { return new Promise((r) => { if (!this.sock || this.sock.destroyed) return r(); this.sock.once("close", () => r()); this.sock.end(); }); }
}

const steps = [];
let failed = 0;
function record(name, pass, detail) {
  steps.push({ name, pass: !!pass, detail });
  if (!pass) failed += 1;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail !== undefined && !pass ? ` ${JSON.stringify(detail)}` : ""}`);
}
function note(name, detail) { steps.push({ name, note: true, detail }); console.log(`NOTE ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`); }

async function main() {
  if (mode !== "verify" && mode !== "run") {
    console.error("usage: node scripts/kb25-probe.mjs verify|run [--out report.json]");
    process.exit(2);
  }
  const A = new Conn("a");
  await A.connect();
  const pingR = await A.request("ping");
  if (!pingR.ok) { console.error(`ping failed: ${pingR.error}`); process.exit(2); }
  const ping = pingR.result;
  if (!ping.lua?.enabled) { console.error('the probe reads and acts through Lua: start the bridge with Lua enabled (Plugin "gma3_mcp_bridge" "lua on")'); process.exit(2); }
  if (mode === "run") {
    if (!SHOW_GUARD.test(String(ping.showfile ?? ""))) { console.error(`show "${ping.showfile}" does not look disposable (expected a name matching ${SHOW_GUARD}); refusing to change state`); process.exit(2); }
    if (ping.input?.busy) { console.error(`the bridge is busy (${JSON.stringify(ping.input.busy)}); wait for the owner to finish`); process.exit(2); }
  }
  const report = { mode, host, port, startedAt: new Date().toISOString(), config: { fid: FID, universe: UNIVERSE, seq: SEQ, mode: `${TYPE_IDX}.${MODE_IDX}`, importFile: IMPORT_FILE }, ping: { bridgeVersion: ping.bridgeVersion, build: ping.build, hostname: ping.hostname, showfile: ping.showfile, user: ping.user, modules: ping.modules, lua: { enabled: ping.lua?.enabled, hookMode: ping.lua?.hookMode } }, steps };
  note("console", report.ping);

  const L = async (code, timeoutMs = 8000) => {
    const r = await A.request("lua", { code, maxMs: 3000 }, timeoutMs);
    if (!r.ok) throw new Error(`lua failed: ${r.error}`);
    return r.result?.values?.[0];
  };
  const snap = () => L(LUA_SNAPSHOT());
  /** Re-reads until `pred` holds (CmdIndirect and UI events land on later frames); returns the last read. */
  const waitFor = async (read, pred, tries = 15, ms = 100) => {
    let v;
    for (let i = 0; i < tries; i++) { v = await read(); if (pred(v)) return v; await sleep(ms); }
    return v;
  };

  // ---- verify: read-only ----
  const api = await L(LUA_API());
  record("the Lua API has AddFixtures, Check*Collision, FindBestDMXPatchAddr, CmdIndirect, GetTopModal, WaitModal, GetTopOverlay, Mouse, Keyboard", api && Object.values(api).every((v) => v === true), api);
  const s0 = await snap();
  note("starting state", { dest: s0.dest, inCopy: s0.inCopy, copyCount: s0.copyCount, liveFixtures: s0.liveFixtures, liveTypes: s0.liveTypes, modal: s0.modal, seq: s0.seq });
  record("with the command line outside the patch, Patch() is LivePatch and the ShowData.Patch copy is empty", !s0.inCopy && s0.patchAddr === s0.liveAddr && s0.copyCount === 0, { patchAddr: s0.patchAddr, liveAddr: s0.liveAddr, copyCount: s0.copyCount, dest: s0.dest });
  const ro = await L(LUA_COLLISIONS_READONLY());
  if (ro?.ref) record("CheckFIDCollision / CheckDMXCollision report an existing patched fixture's FID and address as taken (false)", ro.ref.fidFree === false && ro.ref.dmxFree === false, ro.ref);
  else note("no patched fixture with a numeric FID to check collisions against", ro);
  record("FindBestDMXPatchAddr answers a 0-based absolute address at or after the start", typeof ro?.best0 === "number" && ro.best0 >= absolute0(UNIVERSE, 1), { start: absolute0(UNIVERSE, 1), best: ro?.best0 });
  note("target ranges (run): FID and DMX free?", { fid: `${FID}..${FID + 2}`, fidFree: ro?.targetFidFree, dmx: `${dmx(UNIVERSE, 1)} x32`, dmxFree: ro?.targetDmxFree, mode: ro?.mode });

  // ---- run: patch through the edit copy, then the scratch sequence's dialogs ----
  if (mode === "run") {
    const pre = [];
    if (s0.dest !== "Root") pre.push(`the command line destination is ${s0.dest}, not Root`);
    if (s0.inCopy || s0.copyCount !== 0) pre.push("the patch copy is open (someone is in the Patch menu or a previous run was interrupted)");
    if (s0.modal) pre.push(`a modal is open: ${JSON.stringify(s0.modal)}`);
    if ((s0.liveKb25 ?? []).length) pre.push(`the live patch already holds fixtures named "${PREFIX}…": ${JSON.stringify(s0.liveKb25)}`);
    if (s0.seq !== false) pre.push(`Sequence ${SEQ} exists (${s0.seq})`);
    if (!ro?.mode) pre.push(`no DMX mode at FixtureTypes[${TYPE_IDX}].DMXModes[${MODE_IDX}] (KB25_MODE)`);
    if (ro?.targetFidFree !== true) pre.push(`FID ${FID}..${FID + 2} is not free`);
    if (ro?.targetDmxFree !== true) pre.push(`${dmx(UNIVERSE, 1)} x32 is not free`);
    record("run: preflight (Root, no patch copy, no modal, no KB25 fixtures, free FIDs / DMX / sequence, the DMX mode exists)", pre.length === 0, pre);
    if (pre.length === 0) await runMutations(L, snap, waitFor, s0);
  }

  await A.end();
  report.finishedAt = new Date().toISOString();
  report.failed = failed;
  report.passed = steps.filter((s) => s.pass === true).length;
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + "\n");
  console.log(`${report.passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

async function runMutations(L, snap, waitFor, s0) {
  const cleanup = createCleanup();
  const stage = s0.stage;
  const baseTypes = s0.liveTypes;
  const atRoot = (s) => s.dest === "Root" && !s.inCopy;
  const indirect = (command) => L(LUA_INDIRECT(command));
  const enterStage = async () => {
    await indirect('ChangeDestination "ShowData"."Patch"');
    const a = await waitFor(snap, (s) => s.inCopy && s.dest === "ShowData.Patch");
    await indirect(`ChangeDestination "Stages"."${stage}"."Fixtures"`);
    const b = await waitFor(snap, (s) => s.inCopy && s.dest === `${stage}.Fixtures`);
    return { entered: a, stage: b };
  };
  const commit = async () => { await indirect("ChangeDestination Root"); return waitFor(snap, atRoot); };
  // Restores the patch by identity: in the copy, delete KB25 fixtures and new types and commit; if the live patch still
  // holds any, enter, delete, commit again. Never sends Oops.
  const restorePatch = async () => {
    for (let i = 0; i < 4; i++) {
      const s = await snap();
      if (s.inCopy) { const d = await L(LUA_DELETE_KB25(baseTypes)); if (d?.skipped) return { ok: false, error: d.skipped }; await commit(); continue; }
      if (s.dest !== "Root") { await commit(); continue; }
      const extraTypes = s.liveTypes.length !== baseTypes.length || s.liveTypes.some((t, k) => t !== baseTypes[k]);
      if ((s.liveKb25 ?? []).length || extraTypes) { await indirect('ChangeDestination "ShowData"."Patch"'); await waitFor(snap, (x) => x.inCopy); continue; }
      return { ok: true, detail: { liveFixtures: s.liveFixtures, liveTypes: s.liveTypes } };
    }
    return { ok: false, error: "the patch was not restored after 4 passes" };
  };
  // Escapes the probe's own dialog only; any other modal is left alone and reported.
  const closeOwnDialog = async () => {
    const s = await snap();
    if (!s.modal) return { ok: true, detail: "no modal" };
    if (!isOwnDialog(s.modal)) return { ok: false, error: `a modal that is not the probe's is open: ${JSON.stringify(s.modal)}` };
    await L(LUA_KEY("Escape"));
    const t = await waitFor(snap, (x) => !x.modal);
    return t.modal ? { ok: false, error: `the dialog stayed open: ${JSON.stringify(t.modal)}` } : { ok: true };
  };

  let mutationError = null;
  try {
    // P1: AddFixtures on the live patch with the command line at Root.
    cleanup.add("restore the patch (KB25 fixtures, new types, destination Root)", restorePatch);
    const live = await L(LUA_ADD_LIVE());
    record("run: AddFixtures with the command line at Root (live patch) returns nil and creates nothing", live && live.ok === true && live.ret === "nil" && (live.liveKb25 ?? []).length === 0, live);

    // P2: enter the copy and add two fixtures.
    const e1 = await enterStage();
    record("run: CmdIndirect ChangeDestination \"ShowData\".\"Patch\" fills the ShowData.Patch copy and points Patch() at it (no modal)", e1.entered.inCopy && e1.entered.patchAddr === e1.entered.copyAddr && e1.entered.copyCount > 0 && !e1.entered.modal, { dest: e1.entered.dest, patchAddr: e1.entered.patchAddr, copyCount: e1.entered.copyCount, modal: e1.entered.modal });
    record(`run: the destination reads "${stage}.Fixtures" after ChangeDestination "Stages"."${stage}"."Fixtures"`, e1.stage.dest === `${stage}.Fixtures`, { dest: e1.stage.dest });
    const add = await L(LUA_ADD_COPY(stage, [{ amount: 2, fid: FID, name: PREFIX + "Probe", patch: dmx(UNIVERSE, 1) }]));
    const copy2 = add?.copyKb25 ?? [];
    const fp = footprintOf(copy2.find((f) => f.fid === String(FID))?.patch, copy2.find((f) => f.fid === String(FID + 1))?.patch);
    record(`run: AddFixtures on the copy returns true and creates FID ${FID} at ${dmx(UNIVERSE, 1)} and ${FID + 1} one footprint later; the live patch is unchanged`, add?.results?.[0]?.ret === "true" && copy2.length === 2 && copy2[0].patch === dmx(UNIVERSE, 1) && fp !== null && (add.liveKb25 ?? []).length === 0, add);
    note("run: DMX footprint of the mode (from the two addresses)", { footprint: fp, names: copy2.map((f) => f.name) });
    const c1 = await commit();
    record("run: CmdIndirect ChangeDestination Root commits the copy with no dialog: both fixtures live, the copy empty", atRoot(c1) && !c1.modal && c1.copyCount === 0 && (c1.liveKb25 ?? []).length === 2 && c1.liveFixtures === s0.liveFixtures + 2, { dest: c1.dest, last: c1.last, modal: c1.modal, copyCount: c1.copyCount, liveKb25: c1.liveKb25 });

    // P3: readdress FID+1, unpatch FID.
    await enterStage();
    const ed = await L(LUA_SET_PATCH([{ fid: FID + 1, patch: dmx(UNIVERSE, 101) }, { fid: FID, patch: "" }]));
    record("run: Set(\"Patch\") on the copy readdresses one fixture and unpatches the other", (ed?.done ?? []).length === 2 && ed.done.every((d) => d.ok), ed);
    const c2 = await commit();
    const byFid = Object.fromEntries((c2.liveKb25 ?? []).map((f) => [f.fid, f.patch]));
    record(`run: after the commit the live patch has ${FID} unpatched and ${FID + 1} at ${dmx(UNIVERSE, 101)} (no dialog)`, atRoot(c2) && !c2.modal && byFid[String(FID)] === "" && byFid[String(FID + 1)] === dmx(UNIVERSE, 101), { dest: c2.dest, modal: c2.modal, liveKb25: c2.liveKb25 });

    // P4: collision checks against the committed patch, menu closed.
    if (fp) {
      const cc = await L(LUA_COLLISIONS_AFTER_EDIT(fp));
      record("run: CheckFIDCollision: the probe's FID taken, the next three free", cc.fidTaken === false && cc.fidAfterFree === true, cc);
      record(`run: CheckDMXCollision: ${dmx(UNIVERSE, 101)} taken, an overlap one channel before taken, the footprint before it free, ${dmx(UNIVERSE, 1)} x2 free`, cc.dmxTaken === false && cc.dmxOverlap === false && cc.dmxBefore === true && cc.dmxFirstFree === true, cc);
      record(`run: FindBestDMXPatchAddr(${absolute0(UNIVERSE, 1)}, ${fp}) answers ${absolute0(UNIVERSE, 1)}: 0-based absolute addresses in and out`, cc.best === absolute0(UNIVERSE, 1), cc);
    }

    // P5: what AddFixtures does on a collision, then delete everything in the copy.
    await enterStage();
    const clash = await L(LUA_ADD_COPY(stage, [{ amount: 1, fid: FID, name: PREFIX + "FidClash", patch: dmx(UNIVERSE, 201) }, { amount: 1, fid: FID + 2, name: PREFIX + "DmxClash", patch: dmx(UNIVERSE, 101) }]));
    const ck = clash?.copyKb25 ?? [];
    const original = ck.find((f) => f.name === PREFIX + "Probe" && f.patch === "");
    record(`run: AddFixtures with a taken FID succeeds and takes it: the new fixture is ${FID}, the old one is left with FID "None"`, clash?.results?.[0]?.ret === "true" && ck.find((f) => f.name === PREFIX + "FidClash")?.fid === String(FID) && original?.fid === "None", ck);
    // ConflitedPatch is computed on a later frame: it reads "No" in the chunk that added the fixture.
    const onAddr = (list) => (list ?? []).filter((f) => f.patch === dmx(UNIVERSE, 101));
    note("run: ConflitedPatch read in the same chunk as AddFixtures", onAddr(ck).map((f) => ({ fid: f.fid, conflict: f.conflict })));
    const later = await waitFor(snap, (s) => onAddr(s.copyKb25).length === 2 && onAddr(s.copyKb25).every((f) => f.conflict === "Yes"), 10);
    record("run: AddFixtures on a taken address succeeds and double-patches: both fixtures are flagged ConflitedPatch (on a later frame)", clash?.results?.[1]?.ret === "true" && onAddr(later.copyKb25).length === 2 && onAddr(later.copyKb25).every((f) => f.conflict === "Yes"), later.copyKb25);
    const del = await L(LUA_DELETE_KB25(baseTypes));
    record("run: Fixtures:Delete(position) removes every KB25 fixture from the copy", del?.deletedFixtures === 4 && (del.copyKb25 ?? []).length === 0, del);
    const c3 = await commit();
    record("run: the commit leaves the live patch as it started (fixture count, no KB25 fixtures, FIDs and DMX free again)", atRoot(c3) && !c3.modal && c3.liveFixtures === s0.liveFixtures && (c3.liveKb25 ?? []).length === 0, { dest: c3.dest, liveFixtures: c3.liveFixtures, liveKb25: c3.liveKb25 });

    // P6: import a library type into the copy, delete it again before committing.
    await indirect('ChangeDestination "ShowData"."Patch"');
    await waitFor(snap, (s) => s.inCopy && s.dest === "ShowData.Patch");
    await indirect('ChangeDestination "FixtureTypes"');
    const ft = await waitFor(snap, (s) => s.inCopy && s.dest === "FixtureTypes");
    if (ft.dest === "FixtureTypes" && ft.inCopy) {
      await indirect(`Import Library "${IMPORT_FILE}"`);
      const im = await waitFor(snap, (s) => s.copyTypes.length > baseTypes.length || /Import/.test(s.last));
      record(`run: Import Library "${IMPORT_FILE}" in the copy's FixtureTypes adds one type with no dialog`, im.copyTypes.length === baseTypes.length + 1 && !im.modal && /^OK: Import Library/.test(im.last), { last: im.last, added: im.copyTypes.slice(baseTypes.length), modal: im.modal });
      const d2 = await L(LUA_DELETE_KB25(baseTypes));
      const c4 = await commit();
      record("run: the imported type is deleted in the copy; after the commit the live types are unchanged", d2?.deletedTypes === 1 && atRoot(c4) && JSON.stringify(c4.liveTypes) === JSON.stringify(baseTypes), { deleted: d2, liveTypes: c4.liveTypes });
    } else record("run: ChangeDestination \"FixtureTypes\" inside the copy", false, { dest: ft.dest, inCopy: ft.inCopy });

    // D1: the scratch sequence and its Store dialog.
    cleanup.add(`delete Sequence ${SEQ} (probe-named only)`, () => L(LUA_DELETE_SEQ()).then((r) => (r?.refused ? { ok: false, error: r.refused } : { ok: true, detail: r })));
    const sq = await L(LUA_CREATE_SEQ());
    record(`run: Sequence ${SEQ} created with one cue and named (Store /NoConfirmation, no dialog)`, sq?.name === PREFIX + "Dialog Probe", sq);
    cleanup.add("close the probe's own dialog (Escape)", closeOwnDialog);
    const storeCmd = `Store Sequence ${SEQ} Cue 1`;
    const t0 = Date.now();
    await indirect(storeCmd);
    const answerMs = Date.now() - t0;
    const pong = await A_ping(L);
    const ins = await L(LUA_INSPECT(1));
    const { title, message } = dialogText(ins?.nodes);
    const buttons = (ins?.nodes ?? []).filter((n) => n.class === "Button" && n.text).map((n) => n.text);
    record("run: CmdIndirect of a Store over an existing cue returns at once and the bridge keeps answering while the dialog is open", answerMs < 2000 && pong === true, { answerMs, pong });
    record("run: GetTopModal/WaitModal return a MessageBox titled \"Store to Cue 1\" with its message and the Overwrite / Merge / Remove / Release / Cancel buttons (text and rect)", ins?.modal?.class === "MessageBox" && title === "Store to Cue 1" && typeof message === "string" && ["Overwrite", "Merge", "Remove", "Release", "Cancel"].every((b) => findButton(ins.nodes, b)), { modal: ins?.modal, title, message, buttons });
    note("run: Store dialog inspection", { modal: ins?.modal, title, message, buttons: (ins?.nodes ?? []).filter((n) => n.class === "Button").map((n) => ({ name: n.name, text: n.text, rect: n.rect, en: n.en })) });

    const answer = async (text) => { const r = await L(LUA_CLICK(text)); const s = await waitFor(snap, (x) => !x.modal); return { r, s }; };
    const cancel1 = await answer("Cancel");
    record("run: a Mouse move/press/release at Cancel's centre closes the dialog: LastCommand \"User Canceled Command: …\"", cancel1.r?.clicked === "Cancel" && !cancel1.s.modal && cancel1.s.last === `User Canceled Command: ${storeCmd}`, { click: cancel1.r, last: cancel1.s.last, modal: cancel1.s.modal });
    await indirect(storeCmd);
    await L(LUA_INSPECT(1));
    const over = await answer("Overwrite");
    record("run: clicking Overwrite stores: LastCommand \"OK: …\" (it does not name the chosen answer)", over.r?.clicked === "Overwrite" && !over.s.modal && over.s.last === `OK: ${storeCmd}`, { click: over.r, last: over.s.last });
    await indirect(storeCmd);
    await L(LUA_INSPECT(1));
    await L(LUA_KEY("Escape"));
    const esc = await waitFor(snap, (x) => !x.modal);
    record("run: Keyboard Escape cancels the Store dialog", !esc.modal && esc.last === `User Canceled Command: ${storeCmd}`, { last: esc.last, modal: esc.modal });

    // D2: the Label text input.
    const labelCmd = `Label Sequence ${SEQ}`;
    await indirect(labelCmd);
    // The TextInput is built over several frames (the first scripted run inspected it before its InputField existed
    // and a character sent then was lost): wait for the field, then give it a moment to take focus.
    const fieldOf = (r) => (r?.nodes ?? []).find((n) => n.name === "InputField");
    let inspections = 0;
    const ti = await waitFor(async () => { inspections += 1; return L(LUA_INSPECT(1)); }, (r) => fieldOf(r)?.content !== undefined, 15, 100);
    const field = fieldOf(ti);
    record("run: Label opens a TextInput targeting the sequence; its InputField Content is the current name", ti?.modal?.class === "TextInput" && ti.modal.target === `Sequence ${SEQ}` && field?.content === PREFIX + "Dialog Probe", { modal: ti?.modal, field, inspections });
    await sleep(300);
    await L(LUA_CHAR("Z"));
    const afterChar = await waitFor(() => L(LUA_FIELD()), (f) => f?.before === "Z", 10);
    record("run: a typed character replaces the whole field (it opens fully selected)", afterChar?.before === "Z", afterChar);
    const setC = await L(LUA_FIELD(PREFIX + "SetContent"));
    const setNext = await L(LUA_FIELD());
    record("run: the field's Content is writable from Lua and keeps the value on the next frame", setC?.setOk === true && setC.after === PREFIX + "SetContent" && setNext?.before === PREFIX + "SetContent", { setC, setNext });
    await L(LUA_KEY("Escape"));
    const tiEsc = await waitFor(snap, (x) => !x.modal);
    record("run: Escape cancels the TextInput: LastCommand \"Failed: Label …\", the name unchanged", !tiEsc.modal && tiEsc.last === `Failed: ${labelCmd}` && tiEsc.seq === PREFIX + "Dialog Probe", { last: tiEsc.last, seq: tiEsc.seq });
    await indirect(labelCmd);
    await L(LUA_INSPECT(1));
    await L(LUA_FIELD(PREFIX + "Renamed"));
    await L(LUA_KEY("Return"));
    await sleep(300);
    const ret = await snap();
    record("run: \"Return\" is not a key code: the TextInput stays open", ret.modal && ret.modal.class === "TextInput", { modal: ret.modal, last: ret.last });
    await L(LUA_KEY("Enter"));
    const ent = await waitFor(snap, (x) => !x.modal);
    record("run: Enter commits the written Content: LastCommand \"OK: Label …\" and the sequence is renamed", !ent.modal && ent.last === `OK: ${labelCmd}` && ent.seq === PREFIX + "Renamed", { last: ent.last, seq: ent.seq });
  } catch (e) { mutationError = e; }
  const undo = await cleanup.run();
  record("run: every registered cleanup ran", undo.every((u) => u.ok), undo);
  if (mutationError) record("run: the mutation phase completed without an exception", false, String(mutationError?.stack ?? mutationError));
  const end = await snap();
  record("run: the end state matches the start (Root, no copy, no modal, fixtures and types as before, no KB25 fixtures, no scratch sequence)", atRoot(end) && end.copyCount === 0 && !end.modal && end.liveFixtures === s0.liveFixtures && JSON.stringify(end.liveTypes) === JSON.stringify(baseTypes) && (end.liveKb25 ?? []).length === 0 && end.seq === false, { dest: end.dest, copyCount: end.copyCount, modal: end.modal, liveFixtures: end.liveFixtures, liveTypes: end.liveTypes, liveKb25: end.liveKb25, seq: end.seq });
}

/** A trivial Lua round trip: true when the bridge answers (used while a dialog is open). */
async function A_ping(L) {
  try { return (await L("return true", 3000)) === true; } catch { return false; }
}

if (process.argv[1] && /kb25-probe\.mjs$/.test(process.argv[1])) main().catch((e) => { console.error(e); process.exit(2); });
