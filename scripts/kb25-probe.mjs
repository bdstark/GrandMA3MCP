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
// KB25_PHASES=patch,import,dialogs (default all three) limits `run` to some of its phases.
//
// Rules the run keeps (the manual pass and the review of PR #31 established why):
// - Every command that changes the command-line destination or may open a dialog goes through CmdIndirect, never Cmd():
//   a dialog opened by Cmd() on the plugin thread stalls the bridge. CmdIndirect lands on a later frame, so every step
//   that acts on the edit copy first checks the destination it expects and does nothing otherwise.
// - A step later steps depend on is a `must`: when it fails the run stops there and goes straight to the cleanup, so a
//   refused prerequisite (a sequence that already exists, a destination that never changed) never leads to the next
//   mutation.
// - The patch copy is shared with the operator (the Patch menu fills the same ShowData.Patch and moves the same command
//   line). Before every commit a fingerprint of the copy is compared with the live patch's: every object of every
//   patch collection (all stages, fixture types, attribute definitions, ID types, layers, classes, curves, the
//   universes' own settings) with every property, except the probe's own fixtures (named "KB25 …") and data the
//   console derives from the patch. Anything else that differs, or a fingerprint that could not be completed, means
//   nothing is committed and the run stops. The cleanup deletes the probe's fixtures and only a fixture type the run
//   provably imported (the import reported success for its file and added exactly one type of the expected name;
//   tracked by number and name, an ambiguous match deletes nothing), and refuses to commit a copy that holds
//   anything else.
// - A committed patch edit has no undo (Oops fails), and Oops itself is never sent: if anything else were undoable it
//   would undo the operator's work.
// - A dialog is acted on only through a binding made when it was inspected: the exact UI object, a HookDelete callback
//   that marks it closed, and its expected class/title/target. Every click, key, character and field write re-checks
//   all three immediately before dispatch and is refused otherwise, so a dialog that replaced the probe's (even one with
//   the same title) never receives input. The cleanup closes only the bound dialog.
// - The preflight checks every DMX destination the run writes (2.001 for two fixtures, 2.101 and 2.201 for one) with
//   the mode's own footprint, the three FIDs, the scratch sequence, and that nothing is open.
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
// The fixture type name the import file creates (generic@dimmer.pxml -> "Dimmer"): part of proving the new type is ours.
const IMPORT_NAME = process.env.KB25_IMPORT_NAME ?? "Dimmer";
export const ALL_PHASES = ["patch", "import", "dialogs"];
const PHASES = new Set(String(process.env.KB25_PHASES ?? ALL_PHASES.join(",")).split(",").map((s) => s.trim()).filter(Boolean));
const PREFIX = "KB25 ";
/** The DMX writes of the patch phase: [start address in UNIVERSE, fixtures]. 2.101 and 2.201 hold one fixture each. */
export const DMX_PLAN = [[1, 2], [101, 1], [201, 1]];
/** The largest footprint the plan fits: two fixtures from .001 must end before .101 (and .201 + fp - 1 <= 512). */
export const MAX_FOOTPRINT = 50;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Thrown by `must`: a prerequisite failed, so the run stops and goes to the cleanup. */
class Abort extends Error {}

/** A Lua literal for a JS string / number / boolean / array / plain object (ASCII strings only; JSON escapes are valid Lua escapes). */
export function lua(v) {
  if (Array.isArray(v)) return `{${v.map(lua).join(",")}}`;
  if (typeof v === "string") {
    if (/[^\x20-\x7e]/.test(v)) throw new Error(`non-ASCII text cannot be embedded: ${JSON.stringify(v)}`);
    return JSON.stringify(v);
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return String(v);
  if (v === null) return "nil";
  if (typeof v === "object") {
    return `{${Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`cannot embed key ${JSON.stringify(k)} in Lua`);
      return `${k} = ${lua(x)}`;
    }).join(", ")}}`;
  }
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

/** The probe's KB25 fixtures as comparable keys ("name|fid|patch"), sorted. */
export function kb25Keys(list) {
  return (list ?? []).map((f) => `${f.name}|${f.fid}|${f.patch}`).sort();
}

/** Whether two patch fingerprints (LUA fingerprint(): objects / hash / complete) are equal; an incomplete one never is. */
export function sameFingerprint(a, b) {
  return !!a && !!b && a.complete === true && b.complete === true && a.objects === b.objects && a.hash === b.hash;
}

/**
 * The fixture type the run may claim after its import: only when the import reported success for this file, exactly
 * one type is new, and it carries the expected name. Anything else (a failed import, a type someone else added at the
 * same time, a different name) claims nothing, so the cleanup leaves the copy unresolved instead of deleting a type
 * that may not be the probe's. Returns { tracked, reason }.
 */
export function importOwnership({ before, after, last, file = IMPORT_FILE, expectName = IMPORT_NAME }) {
  if (last !== `OK: Import Library "${file}"`) return { tracked: null, reason: `the import did not report success for ${file}: ${JSON.stringify(last)}` };
  const added = addedTypes(before, after);
  if (added.length !== 1) return { tracked: null, reason: `${added.length} fixture types are new; ownership cannot be attributed`, added };
  if (added[0].name !== expectName) return { tracked: null, reason: `the new type ${added[0].no} ${JSON.stringify(added[0].name)} is not the expected ${JSON.stringify(expectName)}`, added };
  return { tracked: added[0], reason: null, added };
}

/** The entries of `after` that are not in `before` (fixture type lists of { no, name }). */
export function addedTypes(before, after) {
  const seen = new Set((before ?? []).map((t) => `${t.no}|${t.name}`));
  return (after ?? []).filter((t) => !seen.has(`${t.no}|${t.name}`));
}

/** The dialogs the run binds: what each must look like whenever the probe acts on it. */
export const STORE_DIALOG = { class: "MessageBox", title: "Store to Cue 1" };
export const LABEL_DIALOG = { class: "TextInput", target: `Sequence ${SEQ}` };

// ---- Lua snippets (exported for the unit test) ----

const PRELUDE = `
local sd = ShowData(); local lp = sd.LivePatch
local function dest() return tostring(CmdObj():Get("Destination", Enums.Roles.Display)) end
local function inCopy() return Patch():Addr() == sd.Patch:Addr() and sd.Patch:Count() > 0 end
local function modeOf(p) local t = p.FixtureTypes and p.FixtureTypes[${TYPE_IDX}]; return t and t.DMXModes and t.DMXModes[${MODE_IDX}] end
local function isProbe(c) return tostring(c.name):sub(1, ${PREFIX.length}) == ${lua(PREFIX)} end
local function fixtures(p)
  local out = { count = 0, kb25 = {} }
  if not p.Stages or p.Stages:Count() == 0 then return out end
  local function walk(h, depth)
    for _, c in ipairs(h:Children()) do
      if c:GetClass() == "Fixture" then
        out.count = out.count + 1
        if isProbe(c) then out.kb25[#out.kb25 + 1] = { name = tostring(c.name), fid = tostring(c.FID), patch = tostring(c:Get("Patch")), conflict = tostring(c:Get("ConflitedPatch", Enums.Roles.Display)), depth = depth } end
        walk(c, depth + 1)
      end
    end
  end
  walk(p.Stages[1].Fixtures, 0)
  return out
end
local function typeNames(p) local t = {} if p.FixtureTypes then for _, c in ipairs(p.FixtureTypes:Children()) do t[#t + 1] = tostring(c.name) end end return t end
local function typeList(p) local t = {} if p.FixtureTypes then for _, c in ipairs(p.FixtureTypes:Children()) do t[#t + 1] = { no = c.no, name = tostring(c.name) } end end return t end
-- Fingerprint of a patch: FNV-1a over every object of every collection, in tree order (depth, class, number and every
-- property in the display role), so the copy and the live patch fingerprint equal exactly when nothing but the
-- probe's own fixtures differs. Left out, because the console derives them from the patch: the DMX address map, UI and
-- RT channels, the fixture-type overview, the universes' per-address children, and properties that count children or
-- describe derived use (COUNT, MEMORYFOOTPRINT, USED, REALUSED, MAXID, GRANTED, PATCHINFO, COARSEPARAMS, PARKEDCOUNT,
-- TESTERCOUNT), the copy's
-- edit-state flags (STRUCTURELOCKED, IGNORENETWORK), and the Patch menu's filter state (PatchFilter). A read that fails or more than FP_LIMIT objects mark it incomplete, and an
-- incomplete fingerprint never equals another.
local FP_SKIP = { DmxAddresses = true, UIChannels = true, RTChannels = true, FixtureTypesOverview = true, PatchFilter = true }
local FP_SHALLOW = { DmxUniverses = true }
-- The console renumbers objects inside DmxCurves whenever a copy is made (DmxCurve 1's internal "Max" point: number and
-- INDEX 18 live, 19 in the fresh copy, and the live number moved between runs; live 2026-10-12), so their numbers are
-- not compared there. Every other property, the curve values included, still is.
local FP_RENUMBERED = { DmxCurves = true }
-- STRUCTURELOCKED / IGNORENETWORK are the edit state the console sets on the copy (every object of an untouched copy
-- differs from the live patch in exactly these two, live 2026-10-12), not patch data. REALUSED (a fixture type's use
-- count), MAXID (an ID type's highest ID in use) and GRANTED (a universe's output grant) follow from the fixtures,
-- which are fingerprinted themselves: adding one fixture changed exactly these three (live 2026-10-12).
local FP_PROP_SKIP = { COUNT = true, NO = true, MEMORYFOOTPRINT = true, USED = true, PATCHINFO = true, COARSEPARAMS = true, PARKEDCOUNT = true, TESTERCOUNT = true,
  STRUCTURELOCKED = true, IGNORENETWORK = true, REALUSED = true, MAXID = true, GRANTED = true }
local FP_LIMIT = KB25_FP_LIMIT or 200000
local function fnv(h, s) for i = 1, #s do h = ((h ~ s:byte(i)) * 16777619) & 0xffffffff end return h end
-- Property names per class and count, read once per request (PropertyName is half of the cost).
local FP_NAMES = {}
local function propNames(h, n)
  local key = tostring(h:GetClass()) .. "#" .. n
  local names = FP_NAMES[key]
  if not names then names = {}; for i = 0, n - 1 do names[i + 1] = h:PropertyName(i) end; FP_NAMES[key] = names end
  return names
end
-- The whole patch, or (with \`only\`) one top-level collection of it: the probe asks per collection to stay inside
-- the bridge's per-request budget.
local function fingerprint(p, only)
  local r = { objects = 0, hash = 2166136261, complete = true }
  local function add(h, depth, renumbered)
    if r.objects >= FP_LIMIT then r.complete = false; r.reason = "more than " .. FP_LIMIT .. " objects"; return false end
    local okc, n = pcall(function() return h:PropertyCount() end)
    if not okc or type(n) ~= "number" then r.complete = false; r.reason = "PropertyCount failed on " .. tostring(h.name); return false end
    local parts = { tostring(depth), tostring(h:GetClass()), renumbered and "" or tostring(h.no) }
    local okn, names = pcall(propNames, h, n)
    if not okn then r.complete = false; r.reason = "PropertyName failed on " .. tostring(h.name); return false end
    for _, pn in ipairs(names) do
      if not FP_PROP_SKIP[pn] and not (renumbered and pn == "INDEX") then
        local okv, v = pcall(function() return h:Get(pn, Enums.Roles.Display) end)
        if not okv then r.complete = false; r.reason = "property " .. tostring(pn) .. " of " .. tostring(h.name) .. " could not be read"; return false end
        parts[#parts + 1] = pn .. "=" .. tostring(v)
      end
    end
    r.objects = r.objects + 1
    r.hash = fnv(r.hash, table.concat(parts, "\\31") .. "\\n")
    return true
  end
  local function walk(h, depth, renumbered)
    for _, c in ipairs(h:Children()) do
      if not r.complete then return end
      if not (c:GetClass() == "Fixture" and isProbe(c)) then
        if not add(c, depth, renumbered) then return end
        walk(c, depth + 1, renumbered)
      end
    end
  end
  for _, c in ipairs(p:Children()) do
    if not r.complete then break end
    if (only == nil or tostring(c.name) == only) and not FP_SKIP[tostring(c.name)] and add(c, 0) then
      if FP_SHALLOW[tostring(c.name)] then
        for _, u in ipairs(c:Children()) do if not add(u, 1) then break end end
      else walk(c, 1, FP_RENUMBERED[tostring(c.name)]) end
    end
  end
  return r
end
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
-- Dialog bindings persist across requests (globals survive in the bridge's Lua environment).
KB25_DIALOGS = KB25_DIALOGS or { n = 0 }
local function matches(md, expect)
  if not md or md.class ~= expect.class then return false end
  if expect.title and md.title ~= expect.title then return false end
  if expect.target and md.target ~= expect.target then return false end
  return true
end
-- The bound dialog, only while it is the top modal, has not been deleted and still matches; else nil and why.
local function bound(token, expect)
  local e = KB25_DIALOGS[token]
  if not e then return nil, nil, "no dialog is bound to token " .. tostring(token) end
  if not e.alive then return nil, modal(), "the bound dialog was closed (its delete hook fired)" end
  local m = GetTopModal()
  if m ~= e.handle then return nil, modal(), "the top modal is not the bound dialog" end
  local md = modal()
  if not matches(md, expect) then return nil, md, "the bound dialog no longer matches the expected identity" end
  return m, md
end
`;

/** A snapshot of everything the probe judges: destination, copy, live and copy fixtures/types, modal, scratch sequence. */
export const LUA_SNAPSHOT = () => `${PRELUDE}
local live = fixtures(lp)
local copy = inCopy() and fixtures(sd.Patch) or { count = 0, kb25 = {} }
return { dest = dest(), last = tostring(CmdObj():Get("LastCommand")), inCopy = inCopy(), patchAddr = Patch():Addr(), liveAddr = lp:Addr(), copyAddr = sd.Patch:Addr(), copyCount = sd.Patch:Count(),
  stage = lp.Stages[1].name, liveFixtures = live.count, liveKb25 = live.kb25, copyFixtures = copy.count, copyKb25 = copy.kb25,
  liveTypes = typeNames(lp), liveTypeList = typeList(lp), copyTypeList = inCopy() and typeList(sd.Patch) or {},
  modal = modal(), seq = seqName() }`;

/** The fingerprints of the whole live patch and (when it is open) the whole copy, in one request (small patches, tests). */
export const LUA_FINGERPRINTS = () => `${PRELUDE}
return { inCopy = inCopy(), live = fingerprint(lp), copy = inCopy() and fingerprint(sd.Patch) or false }`;

/** The names of the top-level collections the fingerprint covers, for the live patch and (when it is open) the copy. */
export const LUA_FP_COLLECTIONS = () => `${PRELUDE}
local function names(p) local t = {} for _, c in ipairs(p:Children()) do if not FP_SKIP[tostring(c.name)] then t[#t + 1] = tostring(c.name) end end return t end
return { inCopy = inCopy(), live = names(lp), copy = inCopy() and names(sd.Patch) or false }`;

/** The fingerprint of one top-level collection of the live patch or the copy ("live" | "copy"). */
export const LUA_FP_PART = (which, collection) => `${PRELUDE}
if ${lua(which)} == "copy" and not inCopy() then return { complete = false, reason = "the copy is not open" } end
return fingerprint(${which === "copy" ? "sd.Patch" : "lp"}, ${lua(collection)})`;

/**
 * Combines per-collection fingerprints into one: equal only when the collection names match and every part is
 * complete and equal. `parts` is [{ name, fp }].
 */
export function combineFingerprints(names, parts) {
  if (!Array.isArray(names) || parts.length !== names.length) return { complete: false, reason: "collections missing", objects: 0, hash: "" };
  const bad = parts.find((x) => x.fp?.complete !== true);
  if (bad) return { complete: false, reason: `${bad.name}: ${bad.fp?.reason ?? "incomplete"}`, objects: 0, hash: "" };
  return { complete: true, objects: parts.reduce((n, x) => n + x.fp.objects, 0), hash: parts.map((x) => `${x.name}:${x.fp.objects}:${x.fp.hash}`).join(",") };
}

/** The Lua API the probe relies on (read-only). */
export const API_NAMES = ["AddFixtures", "CheckFIDCollision", "CheckDMXCollision", "FindBestDMXPatchAddr", "CmdIndirect", "GetTopModal", "WaitModal", "GetTopOverlay", "Mouse", "Keyboard"];
export const LUA_API = () => `return { ${API_NAMES.map((n) => `${n} = type(${n}) == "function"`).join(", ")} }`;

/** Read-only checks against an existing patched fixture and every FID / DMX destination the run writes. */
export const LUA_COLLISIONS_READONLY = () => `${PRELUDE}
local ref
local function walk(h) for _, c in ipairs(h:Children()) do if c:GetClass() == "Fixture" then if not ref and type(c.FID) == "number" and tostring(c:Get("Patch")) ~= "" and c.ModeDirect then ref = c end walk(c) end end end
walk(lp.Stages[1].Fixtures)
local out = { mode = modeOf(lp) and modeOf(lp):Addr() or false }
if ref then out.ref = { fid = ref.FID, patch = tostring(ref:Get("Patch")), mode = ref.ModeDirect:Addr(), fidFree = CheckFIDCollision(ref.FID), dmxFree = CheckDMXCollision(ref.ModeDirect, tostring(ref:Get("Patch"))) } end
if modeOf(lp) then
  out.targetFidFree = CheckFIDCollision(${FID}, 3)
  out.targetDmx = {}
${DMX_PLAN.map(([a, n]) => `  out.targetDmx[#out.targetDmx + 1] = { at = ${lua(dmx(UNIVERSE, a))}, count = ${n}, free = CheckDMXCollision(modeOf(lp), ${lua(dmx(UNIVERSE, a))}, ${n}) }`).join("\n")}
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
  if isProbe(c) and want[c.FID] then local ok, err = pcall(function() c:Set("Patch", want[c.FID]) end); done[#done + 1] = { fid = c.FID, ok = ok, err = err and tostring(err) or nil } end
  walk(c) end end end
walk(sd.Patch.Stages[1].Fixtures)
return { done = done, copyKb25 = fixtures(sd.Patch).kb25 }`;

/** Live-patch collision checks after the readdress / unpatch step (fp = footprint, at most MAX_FOOTPRINT). */
export const LUA_COLLISIONS_AFTER_EDIT = (fp) => `${PRELUDE}
local m = modeOf(lp)
return { fidTaken = CheckFIDCollision(${FID}), fidAfterFree = CheckFIDCollision(${FID + 2}, 3),
  dmxTaken = CheckDMXCollision(m, ${lua(dmx(UNIVERSE, 101))}), dmxOverlap = CheckDMXCollision(m, ${lua(dmx(UNIVERSE, 101 - fp + 1))}),
  dmxBefore = CheckDMXCollision(m, ${lua(dmx(UNIVERSE, 101 - fp))}), dmxFirstFree = CheckDMXCollision(m, ${lua(dmx(UNIVERSE, 1))}, 2),
  best = FindBestDMXPatchAddr(lp, ${absolute0(UNIVERSE, 1)}, ${lua(fp)}) }`;

/**
 * Delete the copy's top-level KB25 fixtures and the one fixture type the run imported (`tracked` = { no, name } or
 * null); a tracked type matching more than one entry is ambiguous and nothing is deleted for it.
 */
export const LUA_DELETE_KB25 = (tracked) => `${PRELUDE}
if not inCopy() then return { skipped = "not in the patch copy" } end
local fx = sd.Patch.Stages[1].Fixtures
local pos = {} for i, c in ipairs(fx:Children()) do if isProbe(c) then pos[#pos + 1] = i end end
for k = #pos, 1, -1 do fx:Delete(pos[k]) end
local tracked = ${lua(tracked ?? null)}
local deletedTypes, ambiguous = 0, nil
if tracked then
  local ft, hits = sd.Patch.FixtureTypes, {}
  for i, t in ipairs(ft:Children()) do if t.no == tracked.no and tostring(t.name) == tracked.name then hits[#hits + 1] = i end end
  if #hits == 1 then ft:Delete(hits[1]); deletedTypes = 1
  elseif #hits > 1 then ambiguous = #hits .. " fixture types match the tracked import " .. tracked.no .. " " .. tracked.name .. "; none deleted" end
end
return { deletedFixtures = #pos, deletedTypes = deletedTypes, ambiguous = ambiguous, copyKb25 = fixtures(sd.Patch).kb25, copyTypeList = typeList(sd.Patch) }`;

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

/**
 * Inspect the top modal (waiting up to `secs`): identity plus a bounded list of visible nodes. With `expect`, a modal
 * that matches it is bound: the result carries a token for LUA_CLICK / LUA_KEY / LUA_CHAR / LUA_FIELD (false when it
 * does not match, or when HookDelete cannot be registered, since a closed dialog could then not be told from a reused one).
 */
export const LUA_INSPECT = (secs = 1, expect = null) => `${PRELUDE}
local m = ${secs > 0 ? `WaitModal(${secs})` : "GetTopModal()"}
if not m then return { modal = false, token = false } end
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
local md = modal()
local expect = ${lua(expect)}
local token, bindNote = false, nil
if expect then
  if GetTopModal() == m and matches(md, expect) then
    local entry = { handle = m, alive = true }
    local okHook, hooked = pcall(function() return m:HookDelete(function() entry.alive = false end) end)
    if okHook and hooked then KB25_DIALOGS.n = KB25_DIALOGS.n + 1; token = KB25_DIALOGS.n; KB25_DIALOGS[token] = entry
    else bindNote = "HookDelete could not be registered: a closed dialog could not be told from a reused one, so nothing is bound" end
  else bindNote = "the top modal does not match the expected dialog" end
end
return { modal = md, nodes = nodes, token = token, bindNote = bindNote }`;

/** Click the visible button with this text in the BOUND dialog via Mouse move/press/release at its centre. */
export const LUA_CLICK = (token, expect, text) => `${PRELUDE}
local m, md, why = bound(${lua(token)}, ${lua(expect)})
if not m then return { refused = why, modal = md } end
local target
local function find(h) for _, c in ipairs(h:UIChildren() or {}) do if c:GetClass() == "Button" and c.Text == ${lua(text)} and c:IsVisible() and c:IsEnabled() then target = c return end find(c) if target then return end end end
find(m)
if not target then return { refused = "no visible enabled button " .. ${lua(text)}, modal = md } end
local r = target:Get("AbsRect")
local x, y = math.floor(r.x + r.w / 2), math.floor(r.y + r.h / 2)
Mouse(md.display, "move", x, y) Mouse(md.display, "press", "Left") Mouse(md.display, "release", "Left")
return { clicked = ${lua(text)}, display = md.display, x = x, y = y, modal = md }`;

/** Press and release one key on the BOUND dialog's display. */
export const LUA_KEY = (token, expect, key) => `${PRELUDE}
local m, md, why = bound(${lua(token)}, ${lua(expect)})
if not m then return { refused = why, modal = md } end
Keyboard(md.display, "press", ${lua(key)}) Keyboard(md.display, "release", ${lua(key)})
return { key = ${lua(key)}, display = md.display, modal = md }`;

/** One character event on the BOUND dialog's display. */
export const LUA_CHAR = (token, expect, ch) => `${PRELUDE}
local m, md, why = bound(${lua(token)}, ${lua(expect)})
if not m then return { refused = why, modal = md } end
Keyboard(md.display, "char", ${lua(ch)})
return { char = ${lua(ch)}, display = md.display }`;

/** Read (and optionally write) the InputField Content of the BOUND TextInput. */
export const LUA_FIELD = (token, expect, write) => `${PRELUDE}
local m, md, why = bound(${lua(token)}, ${lua(expect)})
if not m then return { refused = why, modal = md } end
pcall(function() m:WaitInit(1) end)
local field
local function find(h) for _, c in ipairs(h:UIChildren() or {}) do if c.name == "InputField" then field = c return end find(c) if field then return end end end
find(m)
if not field then return { refused = "no InputField" } end
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
/** A prerequisite: recorded like any check, and when it fails the run stops and goes to the cleanup. */
function must(name, pass, detail) {
  record(name, pass, detail);
  if (!pass) throw new Abort(name);
}
function note(name, detail) { steps.push({ name, note: true, detail }); console.log(`NOTE ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`); }

async function main() {
  if (mode !== "verify" && mode !== "run") {
    console.error("usage: node scripts/kb25-probe.mjs verify|run [--out report.json]");
    process.exit(2);
  }
  if (![...PHASES].every((p) => ALL_PHASES.includes(p)) || PHASES.size === 0) {
    console.error(`KB25_PHASES must name some of ${ALL_PHASES.join(", ")} (got ${JSON.stringify(process.env.KB25_PHASES)})`);
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
  const report = { mode, host, port, startedAt: new Date().toISOString(), config: { fid: FID, universe: UNIVERSE, seq: SEQ, mode: `${TYPE_IDX}.${MODE_IDX}`, importFile: IMPORT_FILE, importName: IMPORT_NAME, phases: [...PHASES] }, ping: { bridgeVersion: ping.bridgeVersion, build: ping.build, hostname: ping.hostname, showfile: ping.showfile, user: ping.user, modules: ping.modules, lua: { enabled: ping.lua?.enabled, hookMode: ping.lua?.hookMode } }, steps };
  note("console", report.ping);

  const L = async (code, timeoutMs = 8000) => {
    const r = await A.request("lua", { code, maxMs: 3000 }, timeoutMs);
    if (!r.ok) throw new Error(`lua failed: ${r.error}`);
    return r.result?.values?.[0];
  };
  const snap = () => L(LUA_SNAPSHOT());
  // The fingerprints of the live patch and (when it is open) the copy, one collection per request (budget).
  const fps = async () => {
    const cols = await L(LUA_FP_COLLECTIONS());
    const side = async (which, names) => {
      const parts = [];
      for (const name of names) parts.push({ name, fp: await L(LUA_FP_PART(which, name), 15000) });
      return combineFingerprints(names, parts);
    };
    const live = await side("live", cols.live);
    const copy = cols.inCopy ? await side("copy", cols.copy) : false;
    // A different set of collections is a difference in itself.
    if (copy && JSON.stringify(cols.copy) !== JSON.stringify(cols.live)) return { inCopy: cols.inCopy, live, copy: { ...copy, hash: `collections ${cols.copy.join("|")};${copy.hash}` } };
    return { inCopy: cols.inCopy, live, copy };
  };
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
  const fp0 = await fps();
  note("starting state", { dest: s0.dest, inCopy: s0.inCopy, copyCount: s0.copyCount, liveFixtures: s0.liveFixtures, liveTypes: s0.liveTypes, liveFp: fp0?.live, modal: s0.modal, seq: s0.seq });
  record("the live patch's fingerprint is complete (every collection and property read, under the object limit)", fp0?.live?.complete === true && fp0.live.objects > 0, fp0?.live);
  record("with the command line outside the patch, Patch() is LivePatch and the ShowData.Patch copy is empty", !s0.inCopy && s0.patchAddr === s0.liveAddr && s0.copyCount === 0, { patchAddr: s0.patchAddr, liveAddr: s0.liveAddr, copyCount: s0.copyCount, dest: s0.dest });
  const ro = await L(LUA_COLLISIONS_READONLY());
  if (ro?.ref) record("CheckFIDCollision / CheckDMXCollision report an existing patched fixture's FID and address as taken (false)", ro.ref.fidFree === false && ro.ref.dmxFree === false, ro.ref);
  else note("no patched fixture with a numeric FID to check collisions against", ro);
  record("FindBestDMXPatchAddr answers a 0-based absolute address at or after the start", typeof ro?.best0 === "number" && ro.best0 >= absolute0(UNIVERSE, 1), { start: absolute0(UNIVERSE, 1), best: ro?.best0 });
  note("target FIDs and DMX destinations (run): free?", { fid: `${FID}..${FID + 2}`, fidFree: ro?.targetFidFree, dmx: ro?.targetDmx, mode: ro?.mode });

  // ---- run: patch through the edit copy, then the scratch sequence's dialogs ----
  if (mode === "run") {
    const pre = [];
    if (s0.dest !== "Root") pre.push(`the command line destination is ${s0.dest}, not Root`);
    if (s0.inCopy || s0.copyCount !== 0) pre.push("the patch copy is open (someone is in the Patch menu or a previous run was interrupted)");
    if (s0.modal) pre.push(`a modal is open: ${JSON.stringify(s0.modal)}`);
    if ((s0.liveKb25 ?? []).length) pre.push(`the live patch already holds fixtures named "${PREFIX}…": ${JSON.stringify(s0.liveKb25)}`);
    if (PHASES.has("dialogs") && s0.seq !== false) pre.push(`Sequence ${SEQ} exists (${s0.seq})`);
    if (PHASES.has("patch")) {
      if (!ro?.mode) pre.push(`no DMX mode at FixtureTypes[${TYPE_IDX}].DMXModes[${MODE_IDX}] (KB25_MODE)`);
      if (ro?.targetFidFree !== true) pre.push(`FID ${FID}..${FID + 2} is not free`);
      const planned = Array.isArray(ro?.targetDmx) ? ro.targetDmx : [];
      if (planned.length !== DMX_PLAN.length) pre.push("the DMX destinations could not be checked");
      for (const d of planned) if (d.free !== true) pre.push(`${d.at} x${d.count} (the mode's footprint) is not free`);
    }
    record("run: preflight (Root, no patch copy, no modal, no KB25 fixtures, free FIDs / every DMX destination / sequence, the DMX mode exists)", pre.length === 0, pre);
    if ((PHASES.has("patch") || PHASES.has("import")) && fp0?.live?.complete !== true) pre.push(`the live patch's fingerprint is incomplete (${fp0?.live?.reason ?? "no fingerprint"}): an unchanged copy could not be established`);
    if (pre.length === 0) await runMutations({ L, snap, fps, waitFor, s0, fp0 });
  }

  await A.end();
  report.finishedAt = new Date().toISOString();
  report.failed = failed;
  report.passed = steps.filter((s) => s.pass === true).length;
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + "\n");
  console.log(`${report.passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

async function runMutations({ L, snap, fps, waitFor, s0, fp0 }) {
  const cleanup = createCleanup();
  const stage = s0.stage;
  let trackedType = null;
  let currentDialog = null; // { token, expect } of the dialog the probe may act on
  const atRoot = (s) => s.dest === "Root" && !s.inCopy;
  const indirect = (command) => L(LUA_INDIRECT(command));
  const enterStage = async () => {
    await indirect('ChangeDestination "ShowData"."Patch"');
    const a = await waitFor(snap, (s) => s.inCopy && s.dest === "ShowData.Patch");
    must('run: CmdIndirect ChangeDestination "ShowData"."Patch" fills the ShowData.Patch copy and points Patch() at it (no modal)', a.inCopy && a.patchAddr === a.copyAddr && a.copyCount > 0 && a.dest === "ShowData.Patch" && !a.modal, { dest: a.dest, patchAddr: a.patchAddr, copyCount: a.copyCount, modal: a.modal });
    const f = await fps();
    must("run: the copy holds nothing but the live patch and the probe's own fixtures on entry (complete fingerprints equal)", sameFingerprint(f?.copy, f?.live), { copy: f?.copy, live: f?.live });
    await indirect(`ChangeDestination "Stages"."${stage}"."Fixtures"`);
    const b = await waitFor(snap, (s) => s.inCopy && s.dest === `${stage}.Fixtures`);
    must(`run: the destination reads "${stage}.Fixtures" after ChangeDestination "Stages"."${stage}"."Fixtures"`, b.inCopy && b.dest === `${stage}.Fixtures`, { dest: b.dest, inCopy: b.inCopy });
    return b;
  };
  const commit = async () => { await indirect("ChangeDestination Root"); return waitFor(snap, atRoot); };
  // Commits only when the shared copy differs from the live patch by exactly the probe's expected fixtures.
  const safeCommit = async (label, expectKb25) => {
    const s = await snap();
    const f = await fps();
    must(`run: ${label}: the shared copy holds only the probe's expected changes (checked before committing)`, s.inCopy && f?.inCopy && sameFingerprint(f.copy, f.live) && JSON.stringify(kb25Keys(s.copyKb25)) === JSON.stringify(kb25Keys(expectKb25)), { inCopy: s.inCopy, copy: f?.copy, live: f?.live, copyKb25: kb25Keys(s.copyKb25), expected: kb25Keys(expectKb25) });
    return commit();
  };
  // Restores the patch by identity: in the copy, delete the probe's fixtures and its tracked import, then commit only
  // when nothing else differs from the live patch. Never sends Oops; never commits someone else's change.
  const restorePatch = async () => {
    for (let i = 0; i < 4; i++) {
      const s = await snap();
      if (s.inCopy) {
        const d = await L(LUA_DELETE_KB25(trackedType));
        if (d?.skipped) return { ok: false, error: d.skipped };
        const t = await snap();
        const f = await fps();
        if (d?.ambiguous || !sameFingerprint(f?.copy, f?.live) || (t.copyKb25 ?? []).length) {
          return { ok: false, error: "NOT committed: the shared patch copy holds changes the probe did not make or could not remove (or its fingerprint is incomplete); the command line is left in the patch. Resolve at the console: Menu > Patch, then Discard and Exit (or Save and Exit to keep them)", detail: { ambiguous: d?.ambiguous, copy: f?.copy, live: f?.live, copyKb25: t.copyKb25 } };
        }
        await commit();
        continue;
      }
      if (s.dest !== "Root") { await commit(); continue; }
      const trackedLive = trackedType && (s.liveTypeList ?? []).some((x) => x.no === trackedType.no && x.name === trackedType.name);
      if ((s.liveKb25 ?? []).length || trackedLive) { await indirect('ChangeDestination "ShowData"."Patch"'); await waitFor(snap, (x) => x.inCopy); continue; }
      return { ok: true, detail: { liveFixtures: s.liveFixtures, liveTypes: s.liveTypes } };
    }
    return { ok: false, error: "the patch was not restored after 4 passes" };
  };
  // Escapes the bound dialog only; any other modal is left alone and reported.
  const closeOwnDialog = async () => {
    const s = await snap();
    if (!s.modal) return { ok: true, detail: "no modal" };
    if (!currentDialog) return { ok: false, error: `a modal is open and the probe has no dialog bound: ${JSON.stringify(s.modal)}` };
    const k = await L(LUA_KEY(currentDialog.token, currentDialog.expect, "Escape"));
    if (k?.refused) return { ok: false, error: `a modal that is not the probe's bound dialog is open (${k.refused}): ${JSON.stringify(s.modal)}` };
    const t = await waitFor(snap, (x) => !x.modal);
    return t.modal ? { ok: false, error: `the dialog stayed open: ${JSON.stringify(t.modal)}` } : { ok: true };
  };
  /** Inspects until a dialog matching `expect` is bound (and `ready` holds), or returns the last inspection. */
  const bindDialog = async (expect, ready = () => true, tries = 15) => {
    let inspections = 0;
    const r = await waitFor(async () => { inspections += 1; return L(LUA_INSPECT(1, expect)); }, (x) => x?.token && ready(x), tries, 100);
    if (r?.token) currentDialog = { token: r.token, expect };
    return { ...r, inspections };
  };

  let mutationError = null;
  try {
    if (PHASES.has("patch") || PHASES.has("import")) cleanup.add("restore the patch (KB25 fixtures, the tracked import, destination Root; never commits foreign changes)", restorePatch);
    if (PHASES.has("patch")) {
      // P1: AddFixtures on the live patch with the command line at Root.
      const live = await L(LUA_ADD_LIVE());
      must("run: AddFixtures with the command line at Root (live patch) returns nil and creates nothing", live && live.ok === true && live.ret === "nil" && (live.liveKb25 ?? []).length === 0, live);

      // P2: enter the copy and add two fixtures.
      await enterStage();
      const add = await L(LUA_ADD_COPY(stage, [{ amount: 2, fid: FID, name: PREFIX + "Probe", patch: dmx(UNIVERSE, 1) }]));
      const copy2 = add?.copyKb25 ?? [];
      const fp = footprintOf(copy2.find((f) => f.fid === String(FID))?.patch, copy2.find((f) => f.fid === String(FID + 1))?.patch);
      must(`run: AddFixtures on the copy returns true and creates FID ${FID} at ${dmx(UNIVERSE, 1)} and ${FID + 1} one footprint later; the live patch is unchanged`, add?.results?.[0]?.ret === "true" && copy2.length === 2 && copy2[0].patch === dmx(UNIVERSE, 1) && fp !== null && (add.liveKb25 ?? []).length === 0, add);
      note("run: DMX footprint of the mode (from the two addresses)", { footprint: fp, names: copy2.map((f) => f.name) });
      must(`run: the footprint (${fp}) fits the plan (at most ${MAX_FOOTPRINT}: two fixtures from .001 end before .101)`, fp <= MAX_FOOTPRINT, { footprint: fp });
      const c1 = await safeCommit("first commit", [{ name: PREFIX + "Probe", fid: String(FID), patch: dmx(UNIVERSE, 1) }, { name: PREFIX + "Probe", fid: String(FID + 1), patch: dmx(UNIVERSE, 1 + fp) }]);
      must("run: CmdIndirect ChangeDestination Root commits the copy with no dialog: both fixtures live, the copy empty", atRoot(c1) && !c1.modal && c1.copyCount === 0 && (c1.liveKb25 ?? []).length === 2 && c1.liveFixtures === s0.liveFixtures + 2, { dest: c1.dest, last: c1.last, modal: c1.modal, copyCount: c1.copyCount, liveKb25: c1.liveKb25 });

      // P3: readdress FID+1, unpatch FID.
      await enterStage();
      const ed = await L(LUA_SET_PATCH([{ fid: FID + 1, patch: dmx(UNIVERSE, 101) }, { fid: FID, patch: "" }]));
      must("run: Set(\"Patch\") on the copy readdresses one fixture and unpatches the other", (ed?.done ?? []).length === 2 && ed.done.every((d) => d.ok), ed);
      const c2 = await safeCommit("second commit", [{ name: PREFIX + "Probe", fid: String(FID), patch: "" }, { name: PREFIX + "Probe", fid: String(FID + 1), patch: dmx(UNIVERSE, 101) }]);
      const byFid = Object.fromEntries((c2.liveKb25 ?? []).map((f) => [f.fid, f.patch]));
      must(`run: after the commit the live patch has ${FID} unpatched and ${FID + 1} at ${dmx(UNIVERSE, 101)} (no dialog)`, atRoot(c2) && !c2.modal && byFid[String(FID)] === "" && byFid[String(FID + 1)] === dmx(UNIVERSE, 101), { dest: c2.dest, modal: c2.modal, liveKb25: c2.liveKb25 });

      // P4: collision checks against the committed patch, menu closed.
      const cc = await L(LUA_COLLISIONS_AFTER_EDIT(fp));
      record("run: CheckFIDCollision: the probe's FID taken, the next three free", cc.fidTaken === false && cc.fidAfterFree === true, cc);
      record(`run: CheckDMXCollision: ${dmx(UNIVERSE, 101)} taken, an overlap one channel before taken, the footprint before it free, ${dmx(UNIVERSE, 1)} x2 free`, cc.dmxTaken === false && cc.dmxOverlap === false && cc.dmxBefore === true && cc.dmxFirstFree === true, cc);
      record(`run: FindBestDMXPatchAddr(${absolute0(UNIVERSE, 1)}, ${fp}) answers ${absolute0(UNIVERSE, 1)}: 0-based absolute addresses in and out`, cc.best === absolute0(UNIVERSE, 1), cc);

      // P5: what AddFixtures does on a collision (only with the probe's own fixtures), then delete everything in the copy.
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
      const del = await L(LUA_DELETE_KB25(null));
      must("run: Fixtures:Delete(position) removes every KB25 fixture from the copy", del?.deletedFixtures === 4 && (del.copyKb25 ?? []).length === 0, del);
      const c3 = await safeCommit("third commit", []);
      const f3 = await fps();
      must("run: the commit leaves the live patch as it started (fixture count, no KB25 fixtures, the starting fingerprint)", atRoot(c3) && !c3.modal && c3.liveFixtures === s0.liveFixtures && (c3.liveKb25 ?? []).length === 0 && sameFingerprint(f3?.live, fp0.live), { dest: c3.dest, liveFixtures: c3.liveFixtures, liveKb25: c3.liveKb25, live: f3?.live, start: fp0.live });
    }

    if (PHASES.has("import")) {
      // I1: import a library type into the copy and claim it only when the import is provably the probe's; delete exactly
      // that type again before committing.
      await indirect('ChangeDestination "ShowData"."Patch"');
      await waitFor(snap, (s) => s.inCopy && s.dest === "ShowData.Patch");
      await indirect('ChangeDestination "FixtureTypes"');
      const ft = await waitFor(snap, (s) => s.inCopy && s.dest === "FixtureTypes");
      const ff = await fps();
      must('run: ChangeDestination "FixtureTypes" inside the copy (complete fingerprints equal)', ft.dest === "FixtureTypes" && ft.inCopy && sameFingerprint(ff?.copy, ff?.live), { dest: ft.dest, inCopy: ft.inCopy, copy: ff?.copy, live: ff?.live });
      await indirect(`Import Library "${IMPORT_FILE}"`);
      const im = await waitFor(snap, (s) => addedTypes(ft.copyTypeList, s.copyTypeList).length > 0 || /Import/.test(s.last));
      // Ownership only once the import is attributable: success reported for this file, exactly one new type, the
      // expected name. Otherwise nothing is claimed and the cleanup leaves the copy unresolved.
      const own = importOwnership({ before: ft.copyTypeList, after: im.copyTypeList, last: im.last });
      trackedType = own.tracked;
      must(`run: Import Library "${IMPORT_FILE}" in the copy's FixtureTypes reports success and adds exactly one type named ${JSON.stringify(IMPORT_NAME)} with no dialog (claimed by number and name)`, own.tracked !== null && !im.modal, { last: im.last, added: own.added, reason: own.reason, modal: im.modal });
      const d2 = await L(LUA_DELETE_KB25(trackedType));
      must("run: exactly the tracked type is deleted in the copy", d2?.deletedTypes === 1 && !d2.ambiguous && addedTypes(ft.copyTypeList, d2.copyTypeList).length === 0, d2);
      trackedType = null;
      const c4 = await safeCommit("fourth commit", []);
      const f4 = await fps();
      must("run: after the commit the live types are unchanged and the live patch has its starting fingerprint", atRoot(c4) && JSON.stringify(c4.liveTypes) === JSON.stringify(s0.liveTypes) && sameFingerprint(f4?.live, fp0.live), { liveTypes: c4.liveTypes, live: f4?.live, start: fp0.live });
    }

    if (PHASES.has("dialogs")) {
      // D1: the scratch sequence and its Store dialog.
      cleanup.add(`delete Sequence ${SEQ} (probe-named only)`, () => L(LUA_DELETE_SEQ()).then((r) => (r?.refused ? { ok: false, error: r.refused } : { ok: true, detail: r })));
      const sq = await L(LUA_CREATE_SEQ());
      must(`run: Sequence ${SEQ} created with one cue and named (Store /NoConfirmation, no dialog)`, sq?.name === PREFIX + "Dialog Probe", sq);
      cleanup.add("close the probe's bound dialog (Escape; never another modal)", closeOwnDialog);
      const storeCmd = `Store Sequence ${SEQ} Cue 1`;
      const t0 = Date.now();
      await indirect(storeCmd);
      const answerMs = Date.now() - t0;
      const pong = await luaPing(L);
      record("run: CmdIndirect of a Store over an existing cue returns at once and the bridge keeps answering while the dialog is open", answerMs < 2000 && pong === true, { answerMs, pong });
      const ins = await bindDialog(STORE_DIALOG);
      const { title, message } = dialogText(ins?.nodes);
      const buttons = (ins?.nodes ?? []).filter((n) => n.class === "Button" && n.text).map((n) => n.text);
      must("run: GetTopModal/WaitModal return a MessageBox titled \"Store to Cue 1\" with its message and the Overwrite / Merge / Remove / Release / Cancel buttons (text and rect), bound with a delete hook", !!ins?.token && ins.modal?.class === "MessageBox" && title === "Store to Cue 1" && typeof message === "string" && ["Overwrite", "Merge", "Remove", "Release", "Cancel"].every((b) => findButton(ins.nodes, b)), { modal: ins?.modal, title, message, buttons, token: ins?.token, bindNote: ins?.bindNote });
      note("run: Store dialog inspection", { modal: ins?.modal, title, message, buttons: (ins?.nodes ?? []).filter((n) => n.class === "Button").map((n) => ({ name: n.name, text: n.text, rect: n.rect, en: n.en })) });
      const firstToken = ins.token;

      const answer = async (text) => { const r = await L(LUA_CLICK(currentDialog.token, currentDialog.expect, text)); const s = await waitFor(snap, (x) => !x.modal); return { r, s }; };
      const cancel1 = await answer("Cancel");
      must("run: a Mouse move/press/release at Cancel's centre closes the dialog: LastCommand \"User Canceled Command: …\"", cancel1.r?.clicked === "Cancel" && !cancel1.s.modal && cancel1.s.last === `User Canceled Command: ${storeCmd}`, { click: cancel1.r, last: cancel1.s.last, modal: cancel1.s.modal });

      // A binding never follows a dialog that replaced the bound one, even with the same title.
      await indirect(storeCmd);
      const ins2 = await bindDialog(STORE_DIALOG);
      must("run: the reopened Store dialog is inspected and bound under a new token", !!ins2?.token && ins2.token !== firstToken, { token: ins2?.token, firstToken, bindNote: ins2?.bindNote });
      const stale = await L(LUA_CLICK(firstToken, STORE_DIALOG, "Cancel"));
      const stillOpen = await snap();
      must("run: the first token is refused on the reopened dialog with the same title (nothing clicked; the dialog stays open)", typeof stale?.refused === "string" && stale.clicked === undefined && stillOpen.modal?.class === "MessageBox", { stale, modal: stillOpen.modal });
      const over = await answer("Overwrite");
      must("run: clicking Overwrite through the new token stores: LastCommand \"OK: …\" (it does not name the chosen answer)", over.r?.clicked === "Overwrite" && !over.s.modal && over.s.last === `OK: ${storeCmd}`, { click: over.r, last: over.s.last });
      await indirect(storeCmd);
      must("run: the Store dialog is bound again", !!(await bindDialog(STORE_DIALOG))?.token);
      const k = await L(LUA_KEY(currentDialog.token, currentDialog.expect, "Escape"));
      const esc = await waitFor(snap, (x) => !x.modal);
      must("run: Keyboard Escape on the bound dialog cancels it", k?.key === "Escape" && !esc.modal && esc.last === `User Canceled Command: ${storeCmd}`, { key: k, last: esc.last, modal: esc.modal });

      // D2: the Label text input. It is built over a few frames: bind it once its InputField exists.
      const labelCmd = `Label Sequence ${SEQ}`;
      await indirect(labelCmd);
      const fieldOf = (r) => (r?.nodes ?? []).find((n) => n.name === "InputField");
      const ti = await bindDialog(LABEL_DIALOG, (r) => fieldOf(r)?.content !== undefined);
      const field = fieldOf(ti);
      must("run: Label opens a TextInput targeting the sequence; its InputField Content is the current name (bound)", !!ti?.token && ti.modal?.class === "TextInput" && ti.modal.target === `Sequence ${SEQ}` && field?.content === PREFIX + "Dialog Probe", { modal: ti?.modal, field, inspections: ti?.inspections, bindNote: ti?.bindNote });
      await sleep(300);
      const chr = await L(LUA_CHAR(currentDialog.token, currentDialog.expect, "Z"));
      const afterChar = await waitFor(() => L(LUA_FIELD(currentDialog.token, currentDialog.expect)), (f) => f?.before === "Z", 10);
      record("run: a typed character replaces the whole field (it opens fully selected)", chr?.char === "Z" && afterChar?.before === "Z", { chr, afterChar });
      const setC = await L(LUA_FIELD(currentDialog.token, currentDialog.expect, PREFIX + "SetContent"));
      const setNext = await L(LUA_FIELD(currentDialog.token, currentDialog.expect));
      record("run: the field's Content is writable from Lua and keeps the value on the next frame", setC?.setOk === true && setC.after === PREFIX + "SetContent" && setNext?.before === PREFIX + "SetContent", { setC, setNext });
      const k2 = await L(LUA_KEY(currentDialog.token, currentDialog.expect, "Escape"));
      const tiEsc = await waitFor(snap, (x) => !x.modal);
      must("run: Escape cancels the TextInput: LastCommand \"Failed: Label …\", the name unchanged", k2?.key === "Escape" && !tiEsc.modal && tiEsc.last === `Failed: ${labelCmd}` && tiEsc.seq === PREFIX + "Dialog Probe", { last: tiEsc.last, seq: tiEsc.seq });
      await indirect(labelCmd);
      must("run: the reopened TextInput is bound once its field exists", !!(await bindDialog(LABEL_DIALOG, (r) => fieldOf(r)?.content !== undefined))?.token);
      const w = await L(LUA_FIELD(currentDialog.token, currentDialog.expect, PREFIX + "Renamed"));
      must("run: the reopened field takes the written Content", w?.setOk === true && w.after === PREFIX + "Renamed", w);
      await L(LUA_KEY(currentDialog.token, currentDialog.expect, "Return"));
      await sleep(300);
      const ret = await snap();
      record("run: \"Return\" is not a key code: the TextInput stays open", ret.modal && ret.modal.class === "TextInput", { modal: ret.modal, last: ret.last });
      const k3 = await L(LUA_KEY(currentDialog.token, currentDialog.expect, "Enter"));
      const ent = await waitFor(snap, (x) => !x.modal);
      record("run: Enter commits the written Content: LastCommand \"OK: Label …\" and the sequence is renamed", k3?.key === "Enter" && !ent.modal && ent.last === `OK: ${labelCmd}` && ent.seq === PREFIX + "Renamed", { last: ent.last, seq: ent.seq });
    }
  } catch (e) { mutationError = e; }
  if (mutationError instanceof Abort) note("run: stopped after a failed prerequisite; nothing after it was sent", { step: mutationError.message });
  const undo = await cleanup.run();
  record("run: every registered cleanup ran", undo.every((u) => u.ok), undo);
  if (mutationError && !(mutationError instanceof Abort)) record("run: the mutation phase completed without an exception", false, String(mutationError?.stack ?? mutationError));
  const end = await snap();
  const fEnd = await fps();
  record("run: the end state matches the start (Root, no copy, no modal, the live patch's starting fingerprint, no KB25 fixtures, no scratch sequence)", atRoot(end) && end.copyCount === 0 && !end.modal && end.liveFixtures === s0.liveFixtures && sameFingerprint(fEnd?.live, fp0.live) && (end.liveKb25 ?? []).length === 0 && end.seq === false, { live: fEnd?.live, start: fp0.live, dest: end.dest, copyCount: end.copyCount, modal: end.modal, liveFixtures: end.liveFixtures, liveTypes: end.liveTypes, liveKb25: end.liveKb25, seq: end.seq });
}

/** A trivial Lua round trip: true when the bridge answers (used while a dialog is open). */
async function luaPing(L) {
  try { return (await L("return true", 3000)) === true; } catch { return false; }
}

if (process.argv[1] && /kb25-probe\.mjs$/.test(process.argv[1])) main().catch((e) => { console.error(e); process.exit(2); });
