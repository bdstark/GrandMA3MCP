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
Enums = { PathType = { Temp = 1, GrandMA3Library = 2, GrandMA2Library = 3, UserFixtures = 4, WorldServerLibrary = 5 }, Roles = { Display = 1 }, VirtualKeyCode = {}, KeyboardCodes = {} }
-- SU-03: a fixture-type library in a temp folder. The grandMA3 / user .xml files exist on disk (the bridge reads
-- their header); the rest exist only in the DirList listing, like the encrypted .pxml files.
local LIBDIR = os.tmpname(); os.remove(LIBDIR); os.execute('mkdir -p "' .. LIBDIR .. '/ma3" "' .. LIBDIR .. '/ma2" "' .. LIBDIR .. '/user" "' .. LIBDIR .. '/ws"')
local LIBPATHS = { [2] = LIBDIR .. "/ma3", [3] = LIBDIR .. "/ma2", [4] = LIBDIR .. "/user", [5] = LIBDIR .. "/ws" }
local LIBFILES = {
  [2] = { "acme@spot one.xml", "set@truss a.xml", "custom.xml" },
  [3] = { "test@mega hex par.pxml", "generic@dimmer.pxml", "acme@wash two.pxml" },
  [4] = { "acme@spot one.xml", "solo@user only@rev2.gdtf" },
  [5] = {},
}
local SPOT_XML = '<?xml version="1.0" encoding="UTF-8"?>\n<GMA3 DataVersion="1.5.0.0">\n  <FixtureType Name="Spot One" Guid="AA" Manufacturer="Acme" ShortName="Spot1" Description="Acme &amp; Co spot">\n'
  .. '    <DMXModes>\n      <DMXMode Name="Standard" Geometry="Base">\n      </DMXMode>\n      <DMXMode Name="Extended (16 ch)" Geometry="Base">\n      </DMXMode>\n    </DMXModes>\n  </FixtureType>\n</GMA3>\n'
for _, d in ipairs({ "ma3", "user" }) do local f = assert(io.open(LIBDIR .. "/" .. d .. "/acme@spot one.xml", "wb")); f:write(SPOT_XML); f:close() end
local f0 = assert(io.open(LIBDIR .. "/ma3/set@truss a.xml", "wb")); f0:write('<GMA3><FixtureType Name="Truss A" Manufacturer="Set"></FixtureType></GMA3>'); f0:close()
-- A file whose name says nothing about its fixture: only the header names the manufacturer (review of PR #48).
local f1 = assert(io.open(LIBDIR .. "/ma3/custom.xml", "wb")); f1:write('<GMA3><FixtureType Name="Custom Thing" Manufacturer="HeaderOnly" ShortName="CThing"><DMXMode Name="Basic"></DMXMode></FixtureType></GMA3>'); f1:close()
GetPath = function(pt) return LIBPATHS[pt] end
DirList = function(path, filter)
  local ext = filter and filter:match("^%*%.(.+)$")
  for pt, base in pairs(LIBPATHS) do
    if base == path then
      local out = {}
      for _, n in ipairs(LIBFILES[pt]) do if not ext or n:sub(-#ext - 1) == "." .. ext then out[#out + 1] = { name = n, size = 100, time = 0 } end end
      return out
    end
  end
  return {}
end
-- What an Import Library of each file creates (manufacturer, name), as the console names it.
local LIBTYPES = { ["test@mega hex par.pxml"] = { "Test", "Mega Hex Par" }, ["generic@dimmer.pxml"] = { "Generic", "Dimmer" }, ["acme@wash two.pxml"] = { "Acme", "Wash Two" } }
Keyboard = function() end
CurrentProfile = function() return { name = "Default", KeyboardShortCuts = { Get = function() return "true" end, Count = function() return 0 end } } end
GetDisplayByIndex = function() return nil end
BuildDetails = function() return {} end
Root = function() return { Get = function() return false end, VirtualKeys = { Count = function() return 0 end }, MANetSocket = { Get = function() return nil end }, maNetSocket = {} } end
CurrentUser = function() return nil end

-------------------------------------------------------------------------------
-- The mock console
-------------------------------------------------------------------------------

local Obj = {}
-- A child is reachable by name (p.AttributeDefinitions, LivePatch[collection]), as on the console.
Obj.__index = function(t, k)
  local v = Obj[k]
  if v ~= nil then return v end
  for _, c in ipairs(rawget(t, "kids") or {}) do if rawget(c, "name") == k then return c end end
  return nil
end
function Obj:Children() return self.kids end
function Obj:Count() return #self.kids end
function Obj:GetClass() return self.class end
function Obj:Addr() return self.addr or ("obj " .. tostring(self.name)) end
function Obj:PropertyCount() return #self.pn end
function Obj:PropertyName(i) return self.pn[i + 1] end
function Obj:Get(k, role)
  -- A fixture's FixtureType is a reference: the type object raw, "<no> <name>" in the display role (SU-03).
  if k:upper() == "FIXTURETYPE" and rawget(self, "TypeRef") then
    local t = rawget(self, "TypeRef")
    if role == nil then return t end
    return tostring(t.no) .. " " .. tostring(t.name)
  end
  -- Display texts that carry the type's number, as on the console (live 2026-10-15).
  if k:upper() == "MODEDIRECT" and role ~= nil and rawget(self, "TypeRef") and rawget(self, "ModeDirect") then
    local t, m = rawget(self, "TypeRef"), rawget(self, "ModeDirect")
    return "FixtureType " .. tostring(t.no) .. " '" .. tostring(t.name) .. "'.DMXModes.DMXMode " .. tostring(m.no) .. " '" .. tostring(m.name) .. "'"
  end
  if k:upper() == "NAME" and role ~= nil and self.class == "FixtureType" then return "FixtureType " .. tostring(self.no) .. " '" .. tostring(self.name) .. "'" end
  local v = self.pv[k:upper()]
  if v == nil and k:upper() == "NAME" then return self.name end
  -- As on onPC 2.5.1: a DMX mode's DMXFootprint is a table unless read in the display role (live 2026-10-13).
  if k:upper() == "DMXFOOTPRINT" and role == nil and v ~= nil then return { raw = v } end
  return v
end
function Obj:Set(k, v)
  k = k:upper()
  if k == "PATCH" or k == "BREAK1" then self.pv.PATCH = v; self.pv.BREAK1 = v; return end
  if k == "NAME" then self.name = v end
  if self.pv[k] == nil then self.pn[#self.pn + 1] = k end
  self.pv[k] = v
end
function Obj:Delete(i)
  table.remove(self.kids, i)
  -- Deleting a fixture type renumbers the ones after it (live 2026-10-15).
  if self.class == "FixtureTypes" then for j = i, #self.kids do self.kids[j].no = self.kids[j].no - 1 end end
end
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
local function ftype(no, name, modes, manufacturer) local t = obj("FixtureType", name, no, { { "MANUFACTURER", manufacturer or "Test" }, { "SHORTNAME", name:sub(1, 6) }, { "REALUSED", 0 }, { "GUID", "G-" .. name .. "-" .. no } }, { obj("DMXModes", "DMXModes", 1, {}, modes) }); t.DMXModes = t.kids[1]; return t end
-- A console-derived subfixture list (on the console it sits in each DMX mode; the mock's modes are shared
-- between live and copy, so it hangs off the type here). The copy renumbers its geometry references.
local function overview() return obj("SubfixtureOverview", "SubfixtureOverview", 2, {}, { obj("FTSubfixture", "Instance2", 1, { { "INDEX", 2 } }) }) end

local function fixture(name, fid, m, patch, kids)
  return obj("Fixture", name, fid, { { "FID", fid }, { "CID", "None" }, { "IDTYPE", "IDs 1 'Fixture'" }, { "FIXTURETYPE", "x" }, { "MODEDIRECT", "x" }, { "MODE", m.name }, { "PATCH", patch }, { "BREAK1", patch }, { "SUBFIXTUREINDEX", fid } }, kids, { FID = fid, ModeDirect = m })
end

local function buildLive()
  local types = obj("FixtureTypes", "FixtureTypes", 6, {}, { ftype(1, "Grouping", { GROUPMODE }), ftype(2, "Spare", { MODE1 }), ftype(6, "Mega Hex Par", { MODE1, obj("x", "x", 2, {}), MODE8 }), ftype(7, "Dimmer", { MODE1 }), ftype(8, "Two Break", { MODE2B }) })
  local mhpType = types.kids[3]; mhpType.kids[#mhpType.kids + 1] = overview()
  -- An attribute a fixture-type import added: ATTRIBUTEINDEXOLD is unset live and numbered in the copy (live 2026-10-14).
  local attrs = obj("Attributes", "Attributes", 1, {}, { obj("Attribute", "DIM", 1, { { "PRETTY", "Dim" }, { "ATTRIBUTEINDEXOLD", 0 } }), obj("Attribute", "PIXELMASK", 2, { { "PRETTY", "PixelMask" }, { "ATTRIBUTEINDEXOLD", 4294967295 } }) })
  -- A feature counts its attributes (ATTRIBCOUNT), which an import raises (live 2026-10-15).
  local features = obj("FeatureGroups", "FeatureGroups", 2, {}, { obj("FeatureGroup", "Control", 1, {}, { obj("Feature", "Control", 1, { { "ATTRIBCOUNT", 3 } }) }) })
  local attrDefs = obj("AttributeDefinitions", "AttributeDefinitions", 2, {}, { attrs, features })
  -- DMXModes children by No: the fixture type keeps them in order of No (the x placeholder is mode 2).
  local pars = {}
  for i = 1, 3 do pars[i] = fixture("Par " .. i, 400 + i, MODE8, string.format("1.%03d", 1 + (i - 1) * 8)); pars[i].TypeRef = mhpType end
  local group = fixture("Group 4", 4, GROUPMODE, "", pars); group.TypeRef = types.kids[1]
  local dim = fixture("Dim 1", 501, MODE1, "1.100"); dim.TypeRef = types.kids[4]
  local stage = obj("Stage", "Stage 1", 1, {}, { obj("Fixtures", "Fixtures", 1, {}, { group, dim }) })
  stage.Fixtures = stage.kids[1]
  local stages = obj("Stages", "Stages", 7, {}, { stage })
  local p = obj("Patch", "LivePatch", 9, {}, { obj("DmxCurves", "DmxCurves", 1, {}, {}), attrDefs, types, stages, obj("IDTypes", "IDTypes", 11, {}, { obj("IDs", "Fixture", 1, { { "MAXID", 501 } }) }),
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
  console = { live = buildLive(), copyOpen = false, dest = "Root", queue = {}, modal = false, last = "", addMode = "ok", addCalls = {} }
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
    elseif cmd == 'ChangeDestination "FixtureTypes"' and console.copyOpen then
      console.dest = "FixtureTypes"
    elseif cmd:match('^Import Library "(.-)"$') then
      local file = cmd:match('^Import Library "(.-)"$')
      local spec = LIBTYPES[file]
      if console.dest ~= "FixtureTypes" or not spec then console.last = "Error: Object not found"; goto continue end
      local ft = console.copy.FixtureTypes
      local t = ftype(#ft.kids + 1, spec[2], { MODE1 }, spec[1])
      t.pv.GUID = "G-imported-" .. file .. "-" .. (#ft.kids + 1)
      ft.kids[#ft.kids + 1] = t
      -- An import appends the attributes the show lacks (live 2026-10-15).
      local attrs = console.copy.AttributeDefinitions.kids[1]
      attrs.kids[#attrs.kids + 1] = obj("Attribute", "NEW" .. #attrs.kids, #attrs.kids + 1, { { "PRETTY", "New" }, { "ATTRIBUTEINDEXOLD", 4294967295 } })
      -- ... raises an existing feature's attribute count and appends a feature to its group.
      local group = console.copy.AttributeDefinitions.kids[2].kids[1]
      group.kids[1].pv.ATTRIBCOUNT = group.kids[1].pv.ATTRIBCOUNT + 1
      group.kids[#group.kids + 1] = obj("Feature", "FIXTURE", #group.kids + 1, { { "ATTRIBCOUNT", 1 } })
    elseif cmd == "ChangeDestination Root" then
      if console.copyOpen then local l = deepcopy(console.copy); l.addr = "14.9"; l.name = "LivePatch"; console.live = l end
      console.copy = obj("Patch", "Patch", 10, {}, {}); console.copy.addr = "14.10"; console.copyOpen = false; console.dest = "Root"
    end
    console.last = "OK: " .. cmd
    ::continue::
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
    local fp = f.ModeDirect and tonumber(f.ModeDirect.pv.TOTALFOOTPRINT) or 0
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
  console.addCalls[#console.addCalls + 1] = { amount = spec.amount, fid = fid, patch = spec.patch and spec.patch[1] or nil }
  -- "failSecond": the second call of a block fails without creating anything.
  if console.addMode == "failSecond" and #console.addCalls == 2 then return nil end
  local amount = spec.amount
  for i = 0, amount - 1 do
    local addr = start and string.format("%d.%03d", (start + i * fp) // 512 + 1, (start + i * fp) % 512 + 1) or ""
    -- "unpatched": AddFixtures leaves the fixture without an address (amount > 1 did that live for all but the first).
    if console.addMode == "unpatched" and #console.addCalls > 1 then addr = "" end
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
check("ping reports bridge 0.27.0", r.ok and r.result.bridgeVersion == "0.27.0", J(r))

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
-- What the console derives in the copy after a fixture-type import is not a foreign change (bridge 0.25.1).
local copyAttr = console.copy.kids[2].kids[1].kids[2]
local copyOverviewRow = console.copy.FixtureTypes.kids[3].kids[2].kids[1]
copyAttr:Set("ATTRIBUTEINDEXOLD", 351); copyOverviewRow:Set("NAME", "Instance1"); copyOverviewRow:Set("INDEX", 1)
check("a numbered ATTRIBUTEINDEXOLD and a renumbered SubfixtureOverview leave the fingerprint equal", fpOf("copy") == fpOf("live"), fpOf("copy") .. " | " .. fpOf("live"))
copyAttr:Set("PRETTY", "Pixel Mask")
check("a real change to an attribute still changes the fingerprint", fpOf("copy") ~= fpOf("live"))
copyAttr:Set("PRETTY", "PixelMask")
check("(the attribute change is undone again)", fpOf("copy") == fpOf("live"))

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
console.addMode = "failSecond"; console.addCalls = {}
r = request("patch.add", with({ stage = "Stage 1", type = 6, mode = 3, fid = 901, count = 2, address = "2.001" }))
local copyHas901 = false
for _, f in ipairs(allFixtures(console.copy)) do if f.FID == 901 or f.FID == 902 then copyHas901 = true end end
check("patch.add whose second AddFixtures fails stops, fails and deletes what it created", r.ok == false and r.code == "add-failed" and r.detail.removed == 1 and not copyHas901 and #console.addCalls == 2 and tostring(r.error):find("FID 902"), J(r))
console.addMode = "ok"; console.addCalls = {}
r = request("patch.add", with({ stage = "Stage 1", type = 6, mode = 3, fid = 901, count = 2, address = "2.001", name = "New Par" }))
check("patch.add creates the fixtures at consecutive FIDs and addresses", r.ok and #r.result.created == 2 and r.result.created[1].fid == 901 and r.result.created[1].patch == "2.001" and r.result.created[2].patch == "2.009", J(r))
local calls = console.addCalls
check("patch.add calls AddFixtures once per fixture, amount 1, each with its own FID and address (onPC crashed on amount > 1 with cells)",
  #calls == 2 and calls[1].amount == 1 and calls[2].amount == 1 and calls[1].fid == 901 and calls[2].fid == 902 and calls[1].patch == "2.001" and calls[2].patch == "2.009", J(calls))
check("the live patch is unchanged until the commit", not liveFids():find("901"), liveFids())
check("patch.add patched both through AddFixtures (no fix-up needed)", r.ok and r.result.patchedByBridge == 0, J(r))
check("fingerprints excluding the touched FIDs match after the add", fpOf("copy", { 901, 902 }) == fpOf("live", { 901, 902 }))
check("fingerprints without the exclusion differ after the add", fpOf("copy") ~= fpOf("live"))

console.addMode = "unpatched"; console.addCalls = {}
r = request("patch.add", with({ stage = "Stage 1", type = 6, mode = 3, fid = 903, count = 2, address = "2.017" }))
check("patch.add patches a fixture itself when AddFixtures left it without its address", r.ok and r.result.patchedByBridge == 1 and r.result.created[1].patch == "2.017" and r.result.created[2].patch == "2.025", J(r))
console.addMode = "ok"
r = request("patch.remove", with({ fids = { 903, 904 } }))
check("(the fix-up fixtures are removed again before the commit)", r.ok and #r.result.removed == 2, J(r))
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

-- Unreadable occupancy is never free space (PR #34 review): a patched fixture whose mode or break cannot be
-- read makes every range check incomplete, and add / readdress refuse.
reset()
local function liveFx(fid) for _, f in ipairs(allFixtures(console.live)) do if f.FID == fid then return f end end end
liveFx(401).ModeDirect = nil
r = request("patch.check", { edits = { { fid = 403, address = "1.001" } } })
check("patch.check edits: a patched fixture without a readable mode is reported, not treated as free", r.ok and #r.result.conflicts == 0 and #r.result.occupancyUnknown == 1 and r.result.occupancyUnknown[1].fid == 401 and r.result.occupancyUnknown[1].reason:find("mode is unavailable"), J(r))
r = request("patch.check", { add = { type = 6, mode = 3, fid = 905, address = "2.001", findFreeFrom = "2.001" } })
check("patch.check add: unknown occupancy makes the block not free and the suggestion unusable", r.ok and r.result.dmxFree == false and #r.result.occupancyUnknown == 1 and r.result.suggestedFree == false, J(r))
enter()
r = request("patch.set", with({ edits = { { fid = 403, address = "1.001" } } }))
local c403
for _, f in ipairs(allFixtures(console.copy)) do if f.FID == 403 then c403 = f end end
check("patch.set onto the range of a fixture with an unreadable mode fails and restores", r.ok == false and r.code == "set-failed" and r.error:find("cannot be established") and c403.pv.PATCH == "1.017", J(r))
r = request("patch.set", with({ edits = { { fid = 402, name = "Renamed 402" }, { fid = 403, address = "" } } }))
check("a rename and an unpatch need no proven free space and still work", r.ok and r.result.edits[1].after.name == "Renamed 402" and r.result.edits[2].after.patch == "", J(r))
r = request("patch.set", with({ edits = { { fid = 402, name = "Par 2" }, { fid = 403, address = "1.017" } } }))
check("(restored; the restore readdresses onto 403's own former range, which needs proven space and fails)", r.ok == false and r.code == "set-failed", J(r))
for _, f in ipairs(allFixtures(console.copy)) do if f.FID == 402 then f:Set("Name", "Par 2") end if f.FID == 403 then f:Set("Patch", "1.017") end end
r = request("patch.add", with({ stage = "Stage 1", type = 6, mode = 3, fid = 905, address = "2.001" }))
check("patch.add refuses while any occupancy is unknown", r.ok == false and r.code == "occupancy-unknown" and r.detail.occupancyUnknown[1].fid == 401, J(r))
request("patch.commit", X); frame()
liveFx(401).ModeDirect = MODE8
liveFx(402):Set("Patch", "somewhere")
r = request("patch.check", { edits = { { fid = 403, address = "1.030" } } })
check("patch.check edits: a break that is not an address is reported", r.ok and #r.result.occupancyUnknown == 1 and r.result.occupancyUnknown[1].fid == 402 and r.result.occupancyUnknown[1].reason:find("not an address"), J(r))
liveFx(402):Set("Patch", "1.009")
r = request("patch.check", { edits = { { fid = 403, address = "1.030" } } })
check("with every mode readable again the occupancy is complete", r.ok and #r.result.occupancyUnknown == 0 and #r.result.conflicts == 0, J(r))

r = request("patch.fingerprint", { side = "copy", collection = "Stages" })
check("patch.fingerprint of the copy outside a session is refused", r.ok == false and r.code == "copy-closed", J(r))

-------------------------------------------------------------------------------
-- SU-03: library search, import, removal
-------------------------------------------------------------------------------

reset()
local function fpAll(side, extra)
  local cols = request("patch.collections", {}).result
  local parts = {}
  for _, c in ipairs(cols[side]) do
    local a = { side = side, collection = c, excludeFids = {} }
    for k, v in pairs(extra or {}) do a[k] = v end
    local res = request("patch.fingerprint", a)
    parts[#parts + 1] = c .. ":" .. tostring(res.ok and res.result.objects) .. ":" .. tostring(res.ok and res.result.hash) .. ":" .. tostring(res.ok and res.result.complete)
  end
  return table.concat(parts, ",")
end

r = request("patch.library", { query = "mega" })
local e1 = r.ok and r.result.entries[1]
check("patch.library finds a grandMA2 file by a word of its name, with the matching show type", r.ok and r.result.total == 1 and e1.source == "grandma2" and e1.file == "test@mega hex par.pxml"
  and e1.manufacturer == "test" and e1.model == "mega hex par" and e1.modesKnown == false and e1.verified == true and #e1.inShow == 1 and e1.inShow[1].name == "Mega Hex Par" and e1.inShow[1].guid ~= nil, J(r))
r = request("patch.library", { query = "spot" })
local spot = r.ok and r.result.entries[1]
check("patch.library reads a grandMA3 file's header: name, manufacturer, description and mode names",
  r.ok and r.result.total == 2 and spot.source == "grandma3" and spot.name == "Spot One" and spot.manufacturer == "Acme" and spot.description == "Acme & Co spot"
  and spot.modesKnown and spot.modes[1] == "Standard" and spot.modes[2] == "Extended (16 ch)" and #spot.inShow == 0, J(r))
check("a user-library copy of the same file is listed and marked unverified", r.ok and r.result.entries[2].source == "user" and r.result.entries[2].verified == false, J(r))
r = request("patch.library", {})
local hasSet = false
if r.ok then for _, e in ipairs(r.result.entries) do if e.file:find("^set@") then hasSet = true end end end
check("scenery (set@) is left out by default", r.ok and not hasSet and r.result.total == 7, J(r))
r = request("patch.library", { query = "headeronly" })
check("an .xml file is found by a manufacturer only its header names", r.ok and r.result.total == 1 and r.result.entries[1].file == "custom.xml" and r.result.entries[1].manufacturer == "HeaderOnly" and r.result.entries[1].name == "Custom Thing" and r.result.entries[1].modes[1] == "Basic", J(r))
r = request("patch.library", { query = "custom thing" })
check("an .xml file is found by its header name", r.ok and r.result.total == 1 and r.result.entries[1].file == "custom.xml", J(r))
r = request("patch.library", { query = "cthing" })
check("an .xml file is found by its header short name", r.ok and r.result.total == 1, J(r))
r = request("patch.library", { includeSets = true, query = "truss" })
check("includeSets lists scenery", r.ok and r.result.total == 1 and r.result.entries[1].set == true, J(r))
r = request("patch.library", { sources = { "user" } })
local gdtf = r.ok and r.result.entries[2]
check("a GDTF file name gives manufacturer, model and revision", r.ok and r.result.total == 2 and gdtf.format == "gdtf" and gdtf.manufacturer == "solo" and gdtf.model == "user only" and gdtf.revision == "rev2", J(r))
r = request("patch.library", { file = "generic@dimmer.pxml" })
check("patch.library file is an exact lookup", r.ok and r.result.total == 1 and r.result.entries[1].file == "generic@dimmer.pxml", J(r))
r = request("patch.library", { sources = { "nowhere" } })
check("an unknown library source is refused", r.ok == false and r.code == "bad-args", J(r))

r = request("patch.import", with({ file = "generic@dimmer.pxml" }))
check("patch.import outside a session is refused", r.ok == false and r.code == "copy-closed", J(r))
r = request("patch.enter", { exclusive = true, target = "fixturetypes" })
check("patch.enter target fixturetypes queues the copy and its fixture-type pool", r.ok and r.result.expectDestination == "FixtureTypes" and console.queue[1] == 'ChangeDestination "ShowData"."Patch"' and console.queue[2] == 'ChangeDestination "FixtureTypes"', J(r))
frame()
r = request("patch.state")
check("after a frame the copy is open at FixtureTypes", r.ok and r.result.copyOpen and r.result.destination == "FixtureTypes", J(r))
r = request("patch.import", { file = "generic@dimmer.pxml" })
check("patch.import without exclusive is refused", r.ok == false and r.code == "not-exclusive", J(r))
r = request("patch.import", with({ file = "nothing@here.pxml" }))
check("an unknown file is refused", r.ok == false and r.code == "no-file", J(r))
r = request("patch.import", with({ file = 'bad"name.pxml' }))
check("a file name with a quote is refused", r.ok == false and r.code == "bad-file", J(r))
r = request("patch.import", with({ file = "acme@spot one.xml", source = "grandma3" }))
check("a file name in two libraries is refused (Import Library names the file only)", r.ok == false and r.code == "ambiguous-file" and #console.queue == 0, J(r))
r = request("patch.import", with({ file = "generic@dimmer.pxml" }))
check("patch.import queues Import Library and reports the counts before", r.ok and r.result.typesBefore == 5 and r.result.attributesBefore == 2 and console.queue[1] == 'Import Library "generic@dimmer.pxml"' and r.result.source == "grandma2", J(r))
local beforeTypes = r.ok and r.result.typesBefore
r = request("patch.importState", { typesBefore = beforeTypes })
check("before the frame nothing was added", r.ok and #r.result.added == 0 and r.result.types == 5, J(r))
frame()
r = request("patch.importState", { typesBefore = beforeTypes })
local imported = r.ok and r.result.added[1]
check("after the frame the new type is reported with GUID and modes", r.ok and #r.result.added == 1 and imported.name == "Dimmer" and imported.manufacturer == "Generic" and imported.guid ~= nil
  and imported.modes[1].footprint == 1 and r.result.attributes == 3 and r.result.lastCommand:find("Import Library"), J(r))
check("the copy differs from the live patch after the import", fpAll("copy") ~= fpAll("live"))
check("the copy guided by the live patch (prefixOfLive) hashes like the live patch", fpAll("copy", { prefixOfLive = true }) == fpAll("live"), fpAll("copy", { prefixOfLive = true }) .. " | " .. fpAll("live"))
r = request("patch.fingerprint", { side = "live", collection = "FixtureTypes", prefixOfLive = true })
check("prefixOfLive on the live side is refused", r.ok == false and r.code == "bad-args", J(r))
local mhpCopy = console.copy.FixtureTypes.kids[3]
mhpCopy:Set("SHORTNAME", "Changed")
check("a foreign change to a type the live patch has is still seen with prefixOfLive", fpAll("copy", { prefixOfLive = true }) ~= fpAll("live"))
mhpCopy:Set("SHORTNAME", "Mega H")
-- Review of PR #48: only the import's own appends are left out; an unrelated addition is still a difference.
local copyFixtures = console.copy.Stages.kids[1].Fixtures
copyFixtures.kids[#copyFixtures.kids + 1] = fixture("Foreign", 950, MODE1, "3.001")
check("an unrelated fixture appended to the copy is seen with prefixOfLive", fpAll("copy", { prefixOfLive = true }) ~= fpAll("live"))
table.remove(copyFixtures.kids)
local mhpModes = mhpCopy.DMXModes
mhpModes.kids[#mhpModes.kids + 1] = mode(9, "Foreign mode", 4)
check("a mode appended to an existing type in the copy is seen with prefixOfLive", fpAll("copy", { prefixOfLive = true }) ~= fpAll("live"))
table.remove(mhpModes.kids)
check("(back to only the import's appends: equal again)", fpAll("copy", { prefixOfLive = true }) == fpAll("live"))
request("patch.commit", X); frame()
r = request("patch.types")
check("after the commit the imported type is live", r.ok and r.result.count == 6 and r.result.types[6].name == "Dimmer" and r.result.types[6].guid == imported.guid, J(r))

r = request("patch.typeInfo", { type = "Spare" })
local spare = r.ok and r.result.type
check("patch.typeInfo: an unused type, with its GUID and position", r.ok and #spare.usedBy == 0 and spare.index == 2 and spare.guid ~= nil, J(r))
r = request("patch.typeInfo", { type = "Mega Hex Par" })
check("patch.typeInfo: the fixtures using a type", r.ok and #r.result.type.usedBy == 3 and r.result.type.usedBy[1] == 401, J(r))
local mhpGuid = r.ok and r.result.type.guid
enter()
r = request("patch.removeType", with({ type = "Spare", guid = "wrong" }))
check("patch.removeType with another GUID is refused", r.ok == false and r.code == "guid-mismatch" and console.copy.FixtureTypes:Count() == 6, J(r))
r = request("patch.removeType", with({ type = "Mega Hex Par", guid = mhpGuid }))
check("patch.removeType refuses a type fixtures use", r.ok == false and r.code == "type-in-use" and #r.detail.usedBy == 3, J(r))
r = request("patch.removeType", { type = "Spare", guid = spare.guid })
check("patch.removeType without exclusive is refused", r.ok == false and r.code == "not-exclusive", J(r))
r = request("patch.removeType", with({ type = "Spare", guid = spare.guid }))
local ren = {}
if r.ok then for _, x in ipairs(r.result.renumbered) do ren[x.name] = x.from .. ">" .. x.to end end
check("patch.removeType deletes an unused type and reports the renumbered ones", r.ok and r.result.removed.name == "Spare" and r.result.types == 5 and ren["Mega Hex Par"] == "6>5" and ren["Dimmer"] ~= nil, J(r))
local parCopy
for _, f in ipairs(allFixtures(console.copy)) do if f.FID == 401 then parCopy = f end end
check("(the fixtures of a renumbered type display the new number in the copy)", parCopy:Get("FixtureType", 1) == "5 Mega Hex Par")
check("without excluding the removed type the fingerprints differ", fpAll("copy") ~= fpAll("live"))
check("with the removed type left out of the live side the fingerprints match despite the renumbering (types by identity)",
  fpAll("copy") == fpAll("live", { excludeGuids = { spare.guid } }), fpAll("copy") .. " | " .. fpAll("live", { excludeGuids = { spare.guid } }))
request("patch.commit", X); frame()
r = request("patch.types")
local names = {}
if r.ok then for _, t in ipairs(r.result.types) do names[#names + 1] = t.no .. ":" .. t.name end end
local listed = table.concat(names, ",")
check("after the commit the type is gone and the ones after it renumbered", r.ok and r.result.count == 5 and not listed:find("Spare") and listed:find("5:Mega Hex Par"), listed)

print(string.format("%d passed, %d failed", passes, failures))
if failures > 0 then print("FAILED"); os.exit(1) end
print("ALL PASSED")
