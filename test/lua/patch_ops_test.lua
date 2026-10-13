-- Regression harness for the bridge's patch.* ops (KB-26) under stock Lua (5.4 or newer).
--
-- A small console patch is modelled: fixture types with DMX modes, a stage with grouping fixtures and
-- sub-fixtures, and the patch edit copy. ChangeDestination through CmdIndirect lands on the next "frame"
-- (frame() below), as on the console: entering ShowData.Patch copies the live patch, ChangeDestination
-- Root commits the copy. AddFixtures, CheckFIDCollision, CheckDMXCollision, FindBestDMXPatchAddr and
-- GetTopModal follow the behaviour recorded live in KB-25 (AddFixtures only works in the copy at the
-- stage's Fixtures; the collision checks read the committed patch).
--
-- Run from the repository root:   lua test/lua/patch_ops_test.lua

local here = (arg and arg[0] or ""):match("^(.*)[/\\]") or "."
package.path = here .. "/?.lua;" .. package.path
local pluginPath = here .. "/../../plugin/gma3_mcp_bridge.lua"

package.preload["socket"] = function()
  return { gettime = function() return os.clock() end, bind = function() return nil, "stub: no bind" end }
end
Echo = function() end
ErrEcho = Echo; Printf = Echo; ErrPrintf = Echo
GetPath = function() return nil end
Enums = { PathType = { Temp = 1 }, Roles = { Display = 1 }, VirtualKeyCode = {}, KeyboardCodes = {} }
Keyboard = function() end
CurrentProfile = function() return { name = "Default", KeyboardShortCuts = { Get = function() return "true" end, Count = function() return 0 end } } end
GetDisplayByIndex = function() return nil end
BuildDetails = function() return {} end
Root = function() return { Get = function() return false end, VirtualKeys = { Count = function() return 0 end }, MANetSocket = { Get = function() return nil end }, maNetSocket = {} } end
CurrentUser = function() return nil end

-------------------------------------------------------------------------------
-- The mock console
-------------------------------------------------------------------------------

local Obj = {}; Obj.__index = Obj
function Obj:Children() return self.kids end
function Obj:Count() return #self.kids end
function Obj:GetClass() return self.class end
function Obj:Addr() return self.addr or ("obj " .. tostring(self.name)) end
function Obj:PropertyCount() return #self.pn end
function Obj:PropertyName(i) return self.pn[i + 1] end
function Obj:Get(k) local v = self.pv[k:upper()]; if v == nil and k:upper() == "NAME" then return self.name end return v end
function Obj:Set(k, v)
  k = k:upper()
  if k == "PATCH" or k == "BREAK1" then self.pv.PATCH = v; self.pv.BREAK1 = v; return end
  if k == "NAME" then self.name = v end
  if self.pv[k] == nil then self.pn[#self.pn + 1] = k end
  self.pv[k] = v
end
function Obj:Delete(i) table.remove(self.kids, i) end
local function obj(class, name, no, props, kids, extra)
  local o = setmetatable({ class = class, name = name, no = no, pn = { "NAME" }, pv = { NAME = name }, kids = kids or {} }, Obj)
  for _, kv in ipairs(props or {}) do o.pn[#o.pn + 1] = kv[1]; o.pv[kv[1]] = kv[2] end
  for k, v in pairs(extra or {}) do o[k] = v end
  return o
end

local function mode(no, name, footprint, breaks)
  return obj("DMXMode", name, no, { { "TOTALFOOTPRINT", footprint }, { "DMXFOOTPRINT", breaks or ("0," .. (footprint - 1) .. ",-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1") }, { "USED", 0 } })
end
local MODE8 = mode(3, "Ch08", 8)
local MODE1 = mode(1, "Mode 0", 1)
local MODE2B = mode(1, "Two Breaks", 4, "0,1,0,1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1")
local GROUPMODE = mode(1, "Default", 0, "-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1")
local function ftype(no, name, modes) local t = obj("FixtureType", name, no, { { "MANUFACTURER", "Test" }, { "SHORTNAME", name:sub(1, 6) }, { "REALUSED", 0 } }, { obj("DMXModes", "DMXModes", 1, {}, modes) }); t.DMXModes = t.kids[1]; return t end

local function fixture(name, fid, m, patch, kids)
  return obj("Fixture", name, fid, { { "FID", fid }, { "CID", "None" }, { "IDTYPE", "IDs 1 'Fixture'" }, { "FIXTURETYPE", "x" }, { "MODE", m.name }, { "PATCH", patch }, { "BREAK1", patch }, { "SUBFIXTUREINDEX", fid } }, kids, { FID = fid, ModeDirect = m })
end

local function buildLive()
  local types = obj("FixtureTypes", "FixtureTypes", 6, {}, { ftype(1, "Grouping", { GROUPMODE }), ftype(6, "Mega Hex Par", { MODE1, obj("x", "x", 2, {}), MODE8 }), ftype(7, "Dimmer", { MODE1 }), ftype(8, "Two Break", { MODE2B }) })
  -- DMXModes children by No: the fixture type keeps them in order of No (the x placeholder is mode 2).
  local pars = {}
  for i = 1, 3 do pars[i] = fixture("Par " .. i, 400 + i, MODE8, string.format("1.%03d", 1 + (i - 1) * 8)) end
  local group = fixture("Group 4", 4, GROUPMODE, "", pars)
  local dim = fixture("Dim 1", 501, MODE1, "1.100")
  local stage = obj("Stage", "Stage 1", 1, {}, { obj("Fixtures", "Fixtures", 1, {}, { group, dim }) })
  stage.Fixtures = stage.kids[1]
  local stages = obj("Stages", "Stages", 7, {}, { stage })
  local p = obj("Patch", "LivePatch", 9, {}, { obj("DmxCurves", "DmxCurves", 1, {}, {}), types, stages, obj("IDTypes", "IDTypes", 11, {}, { obj("IDs", "Fixture", 1, { { "MAXID", 501 } }) }),
    obj("DmxUniverses", "DmxUniverses", 12, {}, { obj("DmxUniverse", "DmxUniverse 1", 1, { { "USED", 25 } }, { obj("DMX", "DMX 1", 1) }) }), obj("DmxAddresses", "DmxAddresses", 13, {}, {}) })
  p.FixtureTypes = types; p.Stages = stages; p.addr = "14.9"
  return p
end

-- A deep copy that keeps the shared DMX mode objects (immutable here), as the copy's own modes would be equal.
local function deepcopy(o, seen)
  if type(o) ~= "table" then return o end
  if o.class == "DMXMode" then return o end
  seen = seen or {}
  if seen[o] then return seen[o] end
  local c = setmetatable({}, getmetatable(o))
  seen[o] = c
  for k, v in pairs(o) do c[k] = deepcopy(v, seen) end
  return c
end

local console
local function reset()
  console = { live = buildLive(), copyOpen = false, dest = "Root", queue = {}, modal = false, last = "", addMode = "ok" }
  console.copy = obj("Patch", "Patch", 10, {}, {}); console.copy.addr = "14.10"
end
reset()

ShowData = function() return { LivePatch = console.live, Patch = console.copy } end
Patch = function() return console.copyOpen and console.copy or console.live end
CmdObj = function() return { Get = function(_, k) if k == "Destination" then return console.dest elseif k == "LastCommand" then return console.last end end } end
GetTopModal = function() return console.modal or nil end
CmdIndirect = function(cmd) console.queue[#console.queue + 1] = cmd end

local function frame()
  local q = console.queue
  console.queue = {}
  for _, cmd in ipairs(q) do
    if cmd == 'ChangeDestination "ShowData"."Patch"' then
      local c = deepcopy(console.live); c.addr = "14.10"; c.name = "Patch"
      console.copy = c; console.copyOpen = true; console.dest = "ShowData.Patch"
    elseif cmd:match('^ChangeDestination "Stages"%."(.-)"%."Fixtures"$') then
      console.dest = cmd:match('^ChangeDestination "Stages"%."(.-)"%."Fixtures"$') .. ".Fixtures"
    elseif cmd == "ChangeDestination Root" then
      if console.copyOpen then local l = deepcopy(console.copy); l.addr = "14.9"; l.name = "LivePatch"; console.live = l end
      console.copy = obj("Patch", "Patch", 10, {}, {}); console.copy.addr = "14.10"; console.copyOpen = false; console.dest = "Root"
    end
    console.last = "OK: " .. cmd
  end
end

local function allFixtures(p)
  local out = {}
  local function walk(h) for _, c in ipairs(h:Children()) do if c.class == "Fixture" then out[#out + 1] = c; walk(c) end end end
  for _, st in ipairs(p.Stages:Children()) do walk(st.Fixtures) end
  return out
end
local function parse(a) local u, d = a:match("^(%d+)%.(%d+)$"); return (tonumber(u) - 1) * 512 + tonumber(d) - 1 end
local function occupied(p)
  local r = {}
  for _, f in ipairs(allFixtures(p)) do
    local fp = tonumber(f.ModeDirect.pv.TOTALFOOTPRINT) or 0
    if f.pv.PATCH ~= "" and fp > 0 then local s = parse(f.pv.PATCH); r[#r + 1] = { s, s + fp - 1 } end
  end
  return r
end
CheckFIDCollision = function(fid, count)
  for _, f in ipairs(allFixtures(console.live)) do if f.FID >= fid and f.FID < fid + (count or 1) then return false end end
  return true
end
CheckDMXCollision = function(m, addr, count)
  local fp = tonumber(m.pv.TOTALFOOTPRINT); local s = parse(addr); local e = s + fp * (count or 1) - 1
  for _, r in ipairs(occupied(console.live)) do if s <= r[2] and r[1] <= e then return false end end
  return true
end
FindBestDMXPatchAddr = function(p, start, fp)
  local a = start
  while a < 524288 do
    local clash = false
    for _, r in ipairs(occupied(console.live)) do if a <= r[2] and r[1] <= a + fp - 1 then clash = true; a = r[2] + 1; break end end
    if not clash then return a end
  end
  return -1
end
AddFixtures = function(spec)
  if not console.copyOpen or not console.dest:match("%.Fixtures$") then return nil end
  if console.addMode == "nil" then return nil end
  local stageName = console.dest:match("^(.-)%.Fixtures$")
  local stage
  for _, s in ipairs(console.copy.Stages:Children()) do if s.name == stageName then stage = s end end
  local fp = tonumber(spec.mode.pv.TOTALFOOTPRINT)
  local fid = tonumber(spec.fid)
  local start = spec.patch and parse(spec.patch[1]) or nil
  local amount = console.addMode == "short" and spec.amount - 1 or spec.amount
  for i = 0, amount - 1 do
    local addr = start and string.format("%d.%03d", (start + i * fp) // 512 + 1, (start + i * fp) % 512 + 1) or ""
    stage.Fixtures.kids[#stage.Fixtures.kids + 1] = fixture(spec.name or ("Added " .. (fid + i)), fid + i, spec.mode, addr)
  end
  return true
end

-------------------------------------------------------------------------------
-- Load the plugin
-------------------------------------------------------------------------------

local signals = {}
local pluginHandle = { name = "gma3_mcp_bridge", Count = function() return 1 end, Ptr = function(_, i) return i == 1 and { name = "gma3_mcp_bridge", Get = function() return false end } or nil end }
local componentHandle = { name = "gma3_mcp_bridge", Parent = function() return pluginHandle end }
local chunk = assert(loadfile(pluginPath))
chunk("gma3_mcp_bridge", "gma3_mcp_bridge", signals, componentHandle)
local state = _G.__gma3_mcp_bridge
local json = require("json")

local failures, passes = 0, 0
local function check(name, cond, detail)
  if cond then passes = passes + 1; print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end
local function J(v) local ok, s = pcall(json.encode, v); return ok and s or tostring(v) end
local function request(op, args)
  local line = json.encode({ id = "t", op = op, args = args or {} })
  local co = coroutine.create(function() return state._handleLine({ id = 1 }, line) end)
  local ok, res = coroutine.resume(co)
  while ok and coroutine.status(co) == "suspended" do ok, res = coroutine.resume(co) end
  assert(ok, res)
  return json.decode(res)
end
local X = { exclusive = true }
local function with(t) local o = { exclusive = true } for k, v in pairs(t) do o[k] = v end return o end
local function liveFids() local t = {} for _, f in ipairs(allFixtures(console.live)) do t[#t + 1] = f.FID .. "@" .. f.pv.PATCH .. ":" .. f.name end return table.concat(t, ",") end
local function enter() local r = request("patch.enter", X); frame(); return r end
local function fpOf(side, exclude)
  local cols = request("patch.collections", {}).result
  local parts = {}
  for _, c in ipairs(cols[side]) do local r = request("patch.fingerprint", { side = side, collection = c, excludeFids = exclude or {} }); parts[#parts + 1] = c .. ":" .. tostring(r.result.objects) .. ":" .. tostring(r.result.hash) .. ":" .. tostring(r.result.complete) end
  return table.concat(parts, ",")
end

-------------------------------------------------------------------------------
-- Reads
-------------------------------------------------------------------------------

local r = request("ping")
check("ping reports bridge 0.19.0", r.ok and r.result.bridgeVersion == "0.19.0", J(r))

r = request("patch.state")
check("patch.state at Root: copy closed, stages listed", r.ok and r.result.destination == "Root" and r.result.copyOpen == false and r.result.atRoot == true and r.result.stages[1] == "Stage 1" and r.result.modal == false, J(r))

r = request("patch.types")
local mhp
if r.ok then for _, t in ipairs(r.result.types) do if t.name == "Mega Hex Par" then mhp = t end end end
check("patch.types: types with modes, footprint and breaks", mhp and mhp.no == 6 and mhp.modes[3].name == "Ch08" and mhp.modes[3].footprint == 8 and mhp.modes[3].breaks == 1 and mhp.modes[3].breakChannels[1] == 8 and mhp.manufacturer == "Test", J(mhp))
local tb
if r.ok then for _, t in ipairs(r.result.types) do if t.name == "Two Break" then tb = t end end end
check("patch.types: a two-break mode reports both breaks", tb and tb.modes[1].breaks == 2 and tb.modes[1].breakChannels[2] == 2, J(tb))

r = request("patch.list")
check("patch.list: every fixture, sub-fixtures included, in tree order", r.ok and r.result.total == 5 and r.result.fixtures[1].fid == 4 and r.result.fixtures[2].fid == 401 and r.result.fixtures[2].depth == 1 and r.result.fixtures[2].parentFid == 4 and r.result.fixtures[1].subfixtures == 3, J(r))
r = request("patch.list", { fromFid = 402, toFid = 501 })
check("patch.list: FID range filter", r.ok and r.result.total == 3 and r.result.fixtures[1].fid == 402 and r.result.fixtures[3].fid == 501 and r.result.fixtures[3].patch == "1.100", J(r))

r = request("patch.check", { add = { type = 6, mode = "Ch08", fid = 901, count = 2, address = "2.001", findFreeFrom = "1.001" } })
check("patch.check add: free FIDs and address, single break, a suggestion after the patched range", r.ok and r.result.fidFree and r.result.dmxFree and r.result.singleBreak and r.result.suggested == "1.025" and r.result.suggestedFree, J(r))
r = request("patch.check", { add = { type = "Mega Hex Par", mode = 3, fid = 402, count = 1, address = "1.020" } })
check("patch.check add: a taken FID and an overlapping address are reported", r.ok and r.result.fidFree == false and r.result.dmxFree == false and #r.result.conflicts == 1 and r.result.conflicts[1].with == 403, J(r))
r = request("patch.check", { add = { type = 6, mode = 3, fid = 901, count = 2, address = "1.505" } })
check("patch.check add: a block crossing the end of a universe is a conflict", r.ok and r.result.dmxFree == false and r.result.conflicts[1].reason:find("crosses the end of universe 1"), J(r))
r = request("patch.check", { add = { type = 99, mode = 1, fid = 901 } })
check("patch.check add: an unknown type is refused with a code", r.ok == false and r.code == "no-type", J(r))

r = request("patch.check", { edits = { { fid = 403, address = "1.020" } } })
check("patch.check edits: moving a fixture across its own current range is no conflict", r.ok and #r.result.conflicts == 0 and r.result.edits[1].exists, J(r))
r = request("patch.check", { edits = { { fid = 401, address = "1.009" } } })
check("patch.check edits: overlapping another fixture is a conflict", r.ok and #r.result.conflicts == 1 and r.result.conflicts[1].with == 402, J(r))
r = request("patch.check", { edits = { { fid = 401, address = "1.009" }, { fid = 402, address = "1.001" } } })
check("patch.check edits: a swap of two fixtures is no conflict", r.ok and #r.result.conflicts == 0, J(r))
r = request("patch.check", { fids = { 501, 777 } })
check("patch.check fids: existence per FID", r.ok and r.result.fixtures[1].exists and r.result.fixtures[2].exists == false, J(r))

-------------------------------------------------------------------------------
-- Session: refusals, enter, add, set, remove, fingerprint, commit
-------------------------------------------------------------------------------

r = request("patch.enter", {})
check("patch.enter without exclusive is refused", r.ok == false and r.code == "not-exclusive" and #console.queue == 0, J(r))
console.dest = "ShowData.DataPools"
r = request("patch.enter", X)
check("patch.enter away from Root is refused", r.ok == false and r.code == "not-root" and #console.queue == 0, J(r))
console.dest = "Root"; console.modal = { name = "MsgBox", GetClass = function() return "MessageBox" end }
r = request("patch.enter", X)
check("patch.enter with a modal open is refused", r.ok == false and r.code == "modal-open" and #console.queue == 0, J(r))
console.modal = false
r = request("patch.add", with({ stage = "Stage 1", type = 6, mode = 3, fid = 901 }))
check("patch.add outside a session is refused", r.ok == false and r.code == "copy-closed", J(r))
r = request("patch.enter", X)
check("patch.enter queues the two destination changes (CmdIndirect, nothing applied yet)", r.ok and r.result.expectDestination == "Stage 1.Fixtures" and #console.queue == 2 and console.copyOpen == false, J(r))
frame()
r = request("patch.state")
check("after a frame the copy is open at the stage's Fixtures", r.ok and r.result.copyOpen and r.result.destination == "Stage 1.Fixtures" and r.result.patchAddr == "14.10", J(r))
r = request("patch.enter", X)
check("patch.enter while the copy is open is refused", r.ok == false and r.code == "copy-open", J(r))
check("the copy fingerprint equals the live one on entry", fpOf("copy") == fpOf("live"), fpOf("copy") .. " | " .. fpOf("live"))

console.dest = "ShowData.Patch"
r = request("patch.add", with({ stage = "Stage 1", type = 6, mode = 3, fid = 901, count = 2, address = "2.001" }))
check("patch.add at the wrong destination is refused", r.ok == false and r.code == "wrong-destination", J(r))
console.dest = "Stage 1.Fixtures"
r = request("patch.add", with({ stage = "Stage 1", type = 8, mode = 1, fid = 901 }))
check("patch.add refuses a multi-break mode", r.ok == false and r.code == "multi-break", J(r))
r = request("patch.add", with({ stage = "Stage 1", type = 6, mode = 3, fid = 403 }))
check("patch.add refuses a taken FID", r.ok == false and r.code == "fid-taken", J(r))
r = request("patch.add", with({ stage = "Stage 1", type = 6, mode = 3, fid = 901, address = "1.020" }))
check("patch.add refuses an overlapping address", r.ok == false and r.code == "dmx-taken", J(r))
r = request("patch.add", with({ stage = "Stage 1", type = 6, mode = 3, fid = 901, count = 2, address = "1.505" }))
check("patch.add refuses a block crossing the end of a universe", r.ok == false and r.code == "crosses-universe", J(r))
console.addMode = "short"
r = request("patch.add", with({ stage = "Stage 1", type = 6, mode = 3, fid = 901, count = 2, address = "2.001" }))
local copyHas901 = false
for _, f in ipairs(allFixtures(console.copy)) do if f.FID == 901 or f.FID == 902 then copyHas901 = true end end
check("patch.add that creates fewer fixtures than asked fails and deletes what it created", r.ok == false and r.code == "add-failed" and r.detail.removed == 1 and not copyHas901, J(r))
console.addMode = "ok"
r = request("patch.add", with({ stage = "Stage 1", type = 6, mode = 3, fid = 901, count = 2, address = "2.001", name = "New Par" }))
check("patch.add creates the fixtures at consecutive FIDs and addresses", r.ok and #r.result.created == 2 and r.result.created[1].fid == 901 and r.result.created[1].patch == "2.001" and r.result.created[2].patch == "2.009", J(r))
check("the live patch is unchanged until the commit", not liveFids():find("901"), liveFids())
check("fingerprints excluding the touched FIDs match after the add", fpOf("copy", { 901, 902 }) == fpOf("live", { 901, 902 }))
check("fingerprints without the exclusion differ after the add", fpOf("copy") ~= fpOf("live"))

r = request("patch.commit", {})
check("patch.commit without exclusive is refused", r.ok == false and r.code == "not-exclusive", J(r))
r = request("patch.commit", X)
check("patch.commit queues ChangeDestination Root", r.ok and console.queue[1] == "ChangeDestination Root", J(r))
frame()
check("after the commit the fixtures are live and the copy is closed", liveFids():find("901@2.001") and liveFids():find("902@2.009") and console.copyOpen == false and console.dest == "Root", liveFids())

-- set: move across its own range, swap, rename, conflict restore, unpatch
enter()
r = request("patch.set", with({ edits = { { fid = 403, address = "1.020" } } }))
check("patch.set moves a fixture across its own current range", r.ok and r.result.edits[1].after.patch == "1.020" and r.result.edits[1].before.patch == "1.017", J(r))
r = request("patch.set", with({ edits = { { fid = 401, address = "1.009" }, { fid = 402, address = "1.001" } } }))
check("patch.set swaps two fixtures", r.ok and r.result.edits[1].after.patch == "1.009" and r.result.edits[2].after.patch == "1.001", J(r))
r = request("patch.set", with({ edits = { { fid = 403, address = "1.001", name = "Renamed" } } }))
local f403
for _, f in ipairs(allFixtures(console.copy)) do if f.FID == 403 then f403 = f end end
check("patch.set onto another fixture fails and restores every change of the call", r.ok == false and r.code == "set-failed" and f403.pv.PATCH == "1.020" and f403.name == "Par 3" and #r.detail.conflicts >= 1, J(r))
r = request("patch.set", with({ edits = { { fid = 403, address = "", name = "Renamed" } } }))
check("patch.set unpatches and renames", r.ok and r.result.edits[1].after.patch == "" and r.result.edits[1].after.name == "Renamed", J(r))
r = request("patch.set", with({ edits = { { fid = 777, address = "1.300" } } }))
check("patch.set of a missing FID is refused", r.ok == false and r.code == "no-fixture", J(r))
r = request("patch.set", with({ edits = { { fid = 401 } } }))
check("patch.set with nothing to change is refused", r.ok == false and r.code == "bad-args", J(r))
r = request("patch.remove", with({ fids = { 4 } }))
check("patch.remove refuses a fixture with sub-fixtures", r.ok == false and r.code == "has-subfixtures", J(r))
r = request("patch.remove", with({ fids = { 901, 902, 501 } }))
check("patch.remove deletes the fixtures from the copy", r.ok and #r.result.removed == 3, J(r))
check("fingerprints excluding every touched FID match", fpOf("copy", { 401, 402, 403, 901, 902, 501 }) == fpOf("live", { 401, 402, 403, 901, 902, 501 }))
-- a foreign change in the copy (another fixture renamed) is seen
for _, f in ipairs(allFixtures(console.copy)) do if f.FID == 4 then f:Set("CID", "77") end end
check("a foreign change in the copy (CID of an untouched fixture) changes the fingerprint", fpOf("copy", { 401, 402, 403, 901, 902, 501 }) ~= fpOf("live", { 401, 402, 403, 901, 902, 501 }))
for _, f in ipairs(allFixtures(console.copy)) do if f.FID == 4 then f:Set("CID", "None") end end
request("patch.commit", X); frame()
check("the second commit leaves 401/402 swapped, 403 unpatched and renamed, 501/901/902 removed", liveFids() == "4@:Group 4,401@1.009:Par 1,402@1.001:Par 2,403@:Renamed", liveFids())

r = request("patch.fingerprint", { side = "copy", collection = "Stages" })
check("patch.fingerprint of the copy outside a session is refused", r.ok == false and r.code == "copy-closed", J(r))

print(string.format("%d passed, %d failed", passes, failures))
if failures > 0 then print("FAILED"); os.exit(1) end
print("ALL PASSED")
