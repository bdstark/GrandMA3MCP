-- Regression harness for the bridge's cell-layout ops (SU-08, bridge 0.29.0) under stock Lua (5.4 or newer):
-- patch.cellLayout, patch.cellLayoutWrite, patch.layoutCopy, patch.retype.
--
-- Modelled as on onPC 2.5.1 (docs/probes/su-08-cell-layout-macos-2.5.1.md): a cell is a GeometryReference under
-- the DMX mode's root geometry (several modes may share a root); a type copied with Append + Copy in the patch copy
-- is independent, has a zero GUID and reads TotalFootprint 0 until the commit; Set("ModeDirect") moves a fixture to
-- another type's mode and keeps its FID, address and cells.
--
-- Run from the repository root:   lua test/lua/cell_layout_test.lua

local here = (arg and arg[0] or ""):match("^(.*)[/\\]") or "."
package.path = here .. "/?.lua;" .. package.path
local pluginPath = here .. "/../../plugin/gma3_mcp_bridge.lua"

package.preload["socket"] = function()
  return { gettime = function() return os.clock() end, bind = function() return nil, "stub: no bind" end }
end
Echo = function() end
ErrEcho = Echo; Printf = Echo; ErrPrintf = Echo
Enums = { PathType = {}, Roles = { Display = 1 }, VirtualKeyCode = {}, KeyboardCodes = {} }
Keyboard = function() end
CurrentProfile = function() return { name = "Default", KeyboardShortCuts = { Get = function() return "true" end, Count = function() return 0 end } } end
GetDisplayByIndex = function() return nil end
BuildDetails = function() return {} end
Root = function() return { Get = function() return false end, VirtualKeys = { Count = function() return 0 end }, MANetSocket = { Get = function() return nil end }, maNetSocket = {} } end
CurrentUser = function() return nil end

-------------------------------------------------------------------------------
-- The mock patch
-------------------------------------------------------------------------------

local Obj = {}
Obj.__index = function(t, k)
  local v = Obj[k]
  if v ~= nil then return v end
  local refs = rawget(t, "refs")
  if refs and refs[k] ~= nil then return refs[k] end
  for _, c in ipairs(rawget(t, "kids") or {}) do if rawget(c, "name") == k then return c end end
  return nil
end
function Obj:Children() return self.kids end
function Obj:Count() return #self.kids end
function Obj:GetClass() return self.class end
function Obj:Parent() return rawget(self, "parent") end
function Obj:Addr() return rawget(self, "addr") or tostring(self.name) end
function Obj:Get(k, role)
  local K = k:upper()
  if K == "FIXTURETYPE" and rawget(self, "refs") and self.refs.TypeRef then
    local t = self.refs.TypeRef
    if role == nil then return t end
    return tostring(t.no) .. " " .. tostring(t.name)
  end
  if K == "GEOMETRY" and rawget(self, "refs") and self.refs.GeometryDirect then return self.refs.GeometryDirect end
  local v = self.pv[K]
  if v == nil and K == "NAME" then return self.name end
  if K == "FID" and rawget(self, "fid") then return self.fid end
  if role ~= nil and v ~= nil then return tostring(v) end
  return v
end
local console = { failRetype = {} }
function Obj:Set(k, v)
  local K = k:upper()
  if K == "MODEDIRECT" then
    if console.failRetype[self.fid] then self.pv.PATCH = "x"; self.refs.ModeDirect = v; return end
    self.refs.ModeDirect = v
    self.refs.TypeRef = v:Parent():Parent()
    return
  end
  if K == "NAME" then self.name = v end
  self.pv[K] = v
end
local function obj(class, name, props, kids, refs)
  local o = setmetatable({ class = class, name = name, pv = {}, kids = kids or {}, refs = refs or {} }, Obj)
  for k, v in pairs(props or {}) do o.pv[k:upper()] = v end
  for _, c in ipairs(o.kids) do c.parent = o end
  return o
end
function Obj:Append()
  local o = obj("FixtureType", "", {}, {})
  o.parent = self
  o.no = #self.kids + 1
  self.kids[#self.kids + 1] = o
  return o
end
function Obj:Remove(i) table.remove(self.kids, i) end
-- Copy(src): a deep copy of src's subtree; references inside the subtree point at the copies. As on the console, the
-- copy's GUID is zero and its modes read TotalFootprint 0 until a commit.
function Obj:Copy(src)
  local map = {}
  local function clone(o)
    local c = setmetatable({ class = o.class, name = o.name, no = o.no, pv = {}, kids = {}, refs = {} }, Obj)
    map[o] = c
    for k, v in pairs(o.pv) do c.pv[k] = v end
    for i, k in ipairs(o.kids) do c.kids[i] = clone(k); c.kids[i].parent = c end
    return c
  end
  local tmp = clone(src)
  local function remap(o, c)
    for k, v in pairs(o.refs) do c.refs[k] = map[v] or v end
    for i, k in ipairs(o.kids) do remap(k, c.kids[i]) end
  end
  remap(src, tmp)
  self.class, self.name, self.pv, self.kids, self.refs = tmp.class, tmp.name, tmp.pv, tmp.kids, tmp.refs
  for _, k in ipairs(self.kids) do k.parent = self end
  self.pv.GUID = "00 00 00 00"
  for _, m in ipairs(self.DMXModes.kids) do m.pv.TOTALFOOTPRINT = 0 end
  self.DMXModes, self.Geometries = self.kids[1], self.kids[2]
end

local function channel(name, coarse, geometry) return obj("DMXChannel", name, { Coarse = coarse, DMXBreak = 1 }, {}, geometry and { Geometry = geometry } or nil) end
-- A cell references its template only through GeometryDirect (as on the console) and carries its break offset.
local function cellRef(name, x, template, offset)
  return obj("GeometryReference", name, { PosX = x, PosY = 0, PosZ = -0.2 }, offset and { obj("Break", "Break 1 offset", { DMXBreak = 1, DMXPatch = offset }) } or {}, template and { GeometryDirect = template } or nil)
end
local function buildPatch(addr)
  -- Festoon: one mode, root BodyP with three cells under Main, each referencing the template RGB at offsets 1, 4, 7.
  local rgb = obj("Beam", "RGB", {}, {})
  local main = obj("Beam", "Main", {}, { cellRef("I1", 0, rgb, 1), cellRef("I2", 0, rgb, 4), cellRef("I3", 0, rgb, 7) })
  local bodyP = obj("Geometry", "BodyP", {}, { main })
  local fest = obj("FixtureType", "Festoon", { Guid = "AA 01" }, { obj("DMXModes", "DMXModes", {}, { obj("DMXMode", "Pixel", { TotalFootprint = 9 }, { obj("DMXChannels", "DMXChannels", {}, { channel("R", 1, rgb), channel("G", 2, rgb), channel("B", 3, rgb) }) }, { GeometryDirect = bodyP }) }), obj("Geometries", "Geometries", {}, { rgb, bodyP }) })
  fest.no = 1
  -- Strip: two modes sharing one root with two cells.
  local bodyS = obj("Geometry", "BodyS", {}, { cellRef("S1", -0.1), cellRef("S2", 0.1) })
  local strip = obj("FixtureType", "Strip", { Guid = "BB 02" }, { obj("DMXModes", "DMXModes", {}, {
    obj("DMXMode", "A", { TotalFootprint = 2 }, { obj("DMXChannels", "DMXChannels", {}, { channel("D", 1), channel("D2", 2) }) }, { GeometryDirect = bodyS }),
    obj("DMXMode", "B", { TotalFootprint = 2 }, { obj("DMXChannels", "DMXChannels", {}, { channel("D", 1), channel("D2", 2) }) }, { GeometryDirect = bodyS }),
  }), obj("Geometries", "Geometries", {}, { bodyS }) })
  strip.no = 2
  -- A type with a "Pixel" mode of other channels (incompatible), for the retype refusal.
  local other = obj("FixtureType", "Other", { Guid = "CC 03" }, { obj("DMXModes", "DMXModes", {}, { obj("DMXMode", "Pixel", { TotalFootprint = 9 }, { obj("DMXChannels", "DMXChannels", {}, { channel("X", 1) }) }, { GeometryDirect = obj("Geometry", "BodyO", {}, {}) }) }), obj("Geometries", "Geometries", {}, {}) })
  other.no = 3
  for _, t in ipairs({ fest, strip, other }) do t.DMXModes, t.Geometries = t.kids[1], t.kids[2] end
  local function fixture(fid, t, m, cells)
    local kids = {}
    for i = 1, cells do kids[i] = obj("SubFixture", "[c" .. i .. "]", {}) end
    local f = obj("Fixture", "Fx " .. fid, { Patch = "1." .. fid, Mode = m.name }, kids, { ModeDirect = m, TypeRef = t })
    f.fid, f.FID = fid, fid
    return f
  end
  local fm, sa, sb = fest.DMXModes.kids[1], strip.DMXModes.kids[1], strip.DMXModes.kids[2]
  local stage = obj("Stage", "Stage 1", {}, { obj("Fixtures", "Fixtures", {}, { fixture(401, fest, fm, 3), fixture(402, fest, fm, 3), fixture(501, strip, sa, 2), fixture(502, strip, sb, 2) }) })
  stage.Fixtures = stage.kids[1]
  local types = obj("FixtureTypes", "FixtureTypes", {}, { fest, strip, other })
  local p = obj("Patch", "Patch", {}, { types, obj("Stages", "Stages", {}, { stage }) })
  p.FixtureTypes, p.Stages, p.addr = types, p.kids[2], addr
  return p
end

local LIVE = buildPatch("live")
local COPY = obj("Patch", "Patch", {}, {}); COPY.addr = "copy"
local copyOpen = false
local function openCopy() COPY = buildPatch("copy"); copyOpen = true end
local function closeCopy() COPY = obj("Patch", "Patch", {}, {}); COPY.addr = "copy"; copyOpen = false end
ShowData = function() return { LivePatch = LIVE, Patch = COPY } end
Patch = function() return copyOpen and COPY or LIVE end
CmdObj = function() return { Get = function() return copyOpen and "Stage 1.Fixtures" or "Root" end } end
GetTopModal = function() return nil end

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
local function fids(list) local t = {} for _, a in ipairs(list or {}) do t[#t + 1] = tostring(a.fid) end return table.concat(t, ",") end
local function fx(p, fid) for _, f in ipairs(p.Stages.kids[1].Fixtures.kids) do if f.fid == fid then return f end end end

-------------------------------------------------------------------------------
-- Tests
-------------------------------------------------------------------------------

local r = request("patch.cellLayout", { fid = 401 })
check("patch.cellLayout lists a fixture's cells in tree order with positions", r.ok and #r.result.cells == 3 and r.result.cells[2].name == "I2" and r.result.cells[1].parent == "Main" and r.result.cells[1].posZ == -0.2, J(r))
check("... and every fixture whose mode uses that layout", r.ok and fids(r.result.affected) == "401,402", J(r.result and r.result.affected))
r = request("patch.cellLayout", { fid = 501 })
check("modes sharing a root geometry share the layout: both strips are affected", r.ok and fids(r.result.affected) == "501,502", J(r))
r = request("patch.cellLayout", { type = "Strip", mode = "B" })
check("a type and mode can be named instead of a fixture", r.ok and #r.result.cells == 2 and fids(r.result.affected) == "501,502", J(r))
r = request("patch.cellLayout", { fid = 999 })
check("an unknown FID is refused", r.ok == false and r.code == "no-fixture", J(r))

local X = { exclusive = true }
local function with(t) local o = { exclusive = true } for k, v in pairs(t) do o[k] = v end return o end
r = request("patch.cellLayoutWrite", with({ fid = 401, cells = { { index = 1, x = 1 } }, expectAffected = { 401 } }))
check("a write whose affected set is not the caller's is refused, and names every fixture that would move", r.ok == false and r.code == "affected-mismatch" and r.error:find("moves fixtures 402", 1, true) ~= nil, J(r))
check("(nothing was written)", LIVE.FixtureTypes.kids[1].Geometries.kids[2].kids[1].kids[1].pv.POSX == 0)
r = request("patch.cellLayoutWrite", with({ fid = 401, cells = { { index = 1, x = 1 }, { index = 9, x = 2 } }, expectAffected = { 401, 402 } }))
check("a bad cell index is refused before anything is written", r.ok == false and r.code == "bad-args" and LIVE.FixtureTypes.kids[1].Geometries.kids[2].kids[1].kids[1].pv.POSX == 0, J(r))
r = request("patch.cellLayoutWrite", { fid = 401, cells = { { index = 1, x = 1 } }, expectAffected = { 401, 402 } })
check("the write needs exclusive", r.ok == false, J(r))
r = request("patch.cellLayoutWrite", with({ fid = 401, cells = { { index = 1, x = 0.5, y = -0.6 }, { index = 3, z = -0.1 } }, expectAffected = { 402, 401 } }))
local cellsL = LIVE.FixtureTypes.kids[1].Geometries.kids[2].kids[1].kids
check("the write sets the given axes of the given cells and returns their previous positions", r.ok and cellsL[1].pv.POSX == 0.5 and cellsL[1].pv.POSY == -0.6 and cellsL[1].pv.POSZ == -0.2 and cellsL[3].pv.POSZ == -0.1 and cellsL[2].pv.POSX == 0 and r.result.previous[1].posX == 0 and r.result.cells[1].posX == 0.5, J(r))
r = request("patch.cellLayoutWrite", with({ fid = 401, cells = { { index = 1, x = 3 } }, expectAffected = { 401, 402 }, expectType = "BB 02" }))
check("a write whose layout now belongs to another type than planned is refused (type-changed)", r.ok == false and r.code == "type-changed" and cellsL[1].pv.POSX == 0.5, J(r))
r = request("patch.cellLayoutWrite", with({ fid = 401, cells = { { index = 1, x = 3 } }, expectAffected = { 401, 402 }, expectType = "AA 01", expectCells = 40 }))
check("... or another number of cells than planned", r.ok == false and r.code == "type-changed" and cellsL[1].pv.POSX == 0.5, J(r))
r = request("patch.cellLayoutWrite", with({ fid = 401, cells = { { index = 2, x = 0.25 } }, expectAffected = { 401, 402 }, expectType = "AA 01", expectCells = 3 }))
check("with the planned type and cells the write goes ahead", r.ok and cellsL[2].pv.POSX == 0.25, J(r))
openCopy()
r = request("patch.cellLayoutWrite", with({ fid = 401, cells = { { index = 1, x = 2 } }, expectAffected = { 401, 402 } }))
check("the write is refused while the patch copy is open (its commit would overwrite it)", r.ok == false and r.code == "copy-open", J(r))

-- In the copy: a layout copy for one Festoon.
r = request("patch.layoutCopy", with({ type = "Festoon", name = "Festoon own", fids = { 402 } }))
local nt = COPY.FixtureTypes.kids[4]
check("patch.layoutCopy appends a copy of the type under the new name", r.ok and nt and nt.name == "Festoon own" and r.result.type.name == "Festoon own" and COPY.FixtureTypes:Count() == 4, J(r))
check("... and moves the fixtures to it: same mode name, address and cells; the others stay", r.ok and fx(COPY, 402).refs.TypeRef == nt and fx(COPY, 402).refs.ModeDirect == nt.DMXModes.kids[1] and fx(COPY, 402).pv.PATCH == "1.402" and fx(COPY, 401).refs.TypeRef == COPY.FixtureTypes.kids[1], J(r))
check("the copy's geometry is its own (a fresh copy reads footprint 0, which is accepted)", nt.Geometries.kids[2] ~= COPY.FixtureTypes.kids[1].Geometries.kids[2] and nt.DMXModes.kids[1].refs.GeometryDirect == nt.Geometries.kids[2])
r = request("patch.layoutCopy", with({ type = "Festoon", name = "Strip", fids = { 401 } }))
check("a taken name is refused, nothing appended", r.ok == false and r.code == "name-taken" and COPY.FixtureTypes:Count() == 4, J(r))
r = request("patch.layoutCopy", with({ type = "Festoon", name = "Mixed", fids = { 401, 501 } }))
check("fixtures of another type are refused before anything is appended", r.ok == false and r.code == "mixed-types" and COPY.FixtureTypes:Count() == 4, J(r))
closeCopy(); openCopy()
console.failRetype[402] = true
r = request("patch.layoutCopy", with({ type = "Festoon", name = "Festoon own", fids = { 401, 402 } }))
check("a fixture that does not take the new type undoes the whole copy: the type is removed and the fixtures set back", r.ok == false and r.code == "retype-failed" and COPY.FixtureTypes:Count() == 3 and fx(COPY, 401).refs.TypeRef == COPY.FixtureTypes.kids[1], J(r))
console.failRetype[402] = nil

r = request("patch.retype", with({ fids = { 401 }, type = "Other" }))
check("patch.retype refuses a type whose mode of that name has other channels", r.ok == false and r.code == "incompatible" and fx(COPY, 401).refs.TypeRef == COPY.FixtureTypes.kids[1], J(r))
-- Review of PR #53: a copy whose cells address the DMX channels differently is not a layout copy.
request("patch.layoutCopy", with({ type = "Festoon", name = "Festoon own", fids = { 402 } }))
local copyCells = COPY.FixtureTypes.kids[4] and COPY.FixtureTypes.kids[4].Geometries.kids[2].kids[1].kids
if copyCells then
  copyCells[1].pv.POSX = 0.7 -- a layout difference: allowed
  r = request("patch.retype", with({ fids = { 401 }, type = "Festoon own" }))
  check("a copy that differs only in cell positions is compatible", r.ok and fx(COPY, 401).refs.TypeRef == COPY.FixtureTypes.kids[4], J(r))
  r = request("patch.retype", with({ fids = { 401 }, type = "Festoon" }))
  copyCells[1].kids[1].pv.DMXPATCH, copyCells[2].kids[1].pv.DMXPATCH = 4, 1 -- the first two cells swap their DMX offsets
  r = request("patch.retype", with({ fids = { 401 }, type = "Festoon own" }))
  check("a copy whose cells swap their DMX offsets is refused: the expanded addressing differs", r.ok == false and r.code == "incompatible" and fx(COPY, 401).refs.TypeRef == COPY.FixtureTypes.kids[1], J(r))
  copyCells[1].kids[1].pv.DMXPATCH, copyCells[2].kids[1].pv.DMXPATCH = 1, 4
else
  check("(the layout copy for the addressing checks exists)", false)
end
r = request("patch.retype", with({ fids = { 501 }, type = "Festoon" }))
check("patch.retype refuses a type without the fixture's mode", r.ok == false and r.code == "incompatible", J(r))
r = request("patch.layoutCopy", with({ type = "Festoon", name = "Festoon own 2", fids = { 401 } }))
r = request("patch.retype", with({ fids = { 401 }, type = "Festoon" }))
check("patch.retype moves a fixture back to the original layout", r.ok and fx(COPY, 401).refs.TypeRef == COPY.FixtureTypes.kids[1] and r.result.retyped[1].fid == 401, J(r))
closeCopy()
r = request("patch.retype", with({ fids = { 401 }, type = "Festoon" }))
check("patch.retype needs the patch copy", r.ok == false and r.code == "copy-closed", J(r))

print(string.format("%d passed, %d failed", passes, failures))
if failures > 0 then print("FAILED"); os.exit(1) end
print("ALL PASSED")
