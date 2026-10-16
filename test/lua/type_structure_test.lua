-- Regression harness for the bridge's patch.typeStructure op and the cell counts of patch.types / patch.list
-- (SU-07, bridge 0.28.0) under stock Lua (5.4 or newer).
--
-- A fixture type is modelled as on onPC 2.5.1 (docs/probes/su-07-type-structure-macos-2.5.1.md): a DMX mode's root
-- geometry (GeometryDirect); GeometryReference cells under it, each referencing a template geometry
-- (GeometryDirect / Get, not the plain index) with a Break child whose DMXPatch is the cell's offset; DMX channels
-- on the template (repeated per cell) or on a geometry inside the root (absolute), Coarse "None" for a virtual
-- channel; models with Length/Width/Height in metres. A patched fixture's cells are SubFixture children.
--
-- Run from the repository root:   lua test/lua/type_structure_test.lua

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
-- The mock fixture types
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
function Obj:Get(k, role)
  local K = k:upper()
  local hidden = rawget(self, "getRefs")
  if hidden and hidden[K] ~= nil then return hidden[K] end
  local v = self.pv[K]
  if v == nil and K == "NAME" then return self.name end
  if role ~= nil and v ~= nil then return tostring(v) end
  return v
end
local function obj(class, name, props, kids, refs)
  local o = setmetatable({ class = class, name = name, pv = {}, kids = kids or {}, refs = refs }, Obj)
  for k, v in pairs(props or {}) do o.pv[k:upper()] = v end
  for _, c in ipairs(o.kids) do c.parent = o end
  return o
end
local function channel(name, geometry, coarse, attrs, extra)
  local fns = {}
  for i, a in ipairs(attrs) do fns[i] = obj("ChannelFunction", a .. " " .. i, { Attribute = a }) end
  local props = { Coarse = coarse == nil and "None" or coarse, DMXBreak = 1, Default = "<000000>" }
  for k, v in pairs(extra or {}) do if v == false then props[k] = nil else props[k] = v end end
  -- A DMXChannel answers Geometry by plain index.
  return obj("DMXChannel", name, props, { obj("LogicalChannel", name, {}, fns) }, { Geometry = geometry })
end
local function cell(name, template, offset, x)
  -- A GeometryReference does not answer Geometry by plain index; GeometryDirect and Get do.
  local r = obj("GeometryReference", name, { PosX = x, PosY = 0, PosZ = -0.0262, RotX = 0, RotY = 0, RotZ = 0 }, offset and { obj("Break", "Break 1 offset", { DMXBreak = 1, DMXPatch = offset }) } or {}, { GeometryDirect = template })
  r.getRefs = { GEOMETRY = template }
  return r
end
local function model(name, l, w, h) return obj("Model", name, { Length = l, Width = w, Height = h, File = "MESH/cylinder.3ds" }) end

local function washer()
  local mBody, mRef = model("Body", 1.04, 0.16, 0.055), model("ModelRef", 0.08, 0.08, 0.005)
  local rgbw = obj("Beam", "RGBW", { PosX = 0, PosY = 0, PosZ = 0 }, {}, { Model = mRef })
  local main = obj("Beam", "Main Module", { PosX = 0, PosY = 0, PosZ = 0 }, { cell("Instance2", rgbw, 1, -0.44), cell("Instance3", rgbw, 5, -0.36) })
  local body = obj("Geometry", "Body", { PosX = 0, PosY = 0, PosZ = 0 }, { main }, { Model = mBody })
  local geoms = obj("Geometries", "Geometries", {}, { rgbw, body })
  local chans = {
    channel("RGBW_R", rgbw, 1, { "ColorRGB_R" }), channel("RGBW_G", rgbw, 2, { "ColorRGB_G" }), channel("RGBW_B", rgbw, 3, { "ColorRGB_B" }), channel("RGBW_W", rgbw, 4, { "ColorRGB_W" }),
    channel("RGBW_Dimmer", rgbw, nil, { "Dimmer" }),
    channel("Main_Shutter", main, 9, { "Shutter1", "Shutter1Strobe" }), channel("Main_Macro", main, 10, { "ColorMacro" }),
  }
  local m10 = obj("DMXMode", "10 channel", { TotalFootprint = 10, DMXFootprint = "0,9,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1" }, { obj("DMXChannels", "DMXChannels", {}, chans) }, { GeometryDirect = body })
  m10.no = 1
  -- A mode whose second cell has no break offset, and which leaves an address unused.
  local main2 = obj("Beam", "Main Module#2", {}, { cell("Instance2#2", rgbw, 1, -0.44), cell("Instance3#2", rgbw, nil, -0.36) })
  local body2 = obj("Geometry", "Body#2", {}, { main2 })
  geoms.kids[#geoms.kids + 1] = body2; body2.parent = geoms
  local m2 = obj("DMXMode", "Broken", { TotalFootprint = 10, DMXFootprint = "0,9,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1" }, { obj("DMXChannels", "DMXChannels", {}, { channel("RGBW_R2", rgbw, 1, { "ColorRGB_R" }) }) }, { GeometryDirect = body2 })
  m2.no = 2
  local t = obj("FixtureType", "Washer", { Manufacturer = "Test", ShortName = "Wash" }, { obj("DMXModes", "DMXModes", {}, { m10, m2 }), geoms, obj("Models", "Models", {}, { mBody, mRef }) })
  t.no = 1
  t.DMXModes, t.Geometries, t.Models = t.kids[1], t.kids[2], t.kids[3]
  return t
end

local function par()
  local yoke = obj("Axis", "Yoke", { PosX = 0, PosY = 0, PosZ = 0.1 })
  local body = obj("Geometry", "Body", { PosX = 0, PosY = 0, PosZ = 0 }, { yoke }, { Model = model("Body", 0.3, 0.3, 0.4) })
  local m = obj("DMXMode", "Pan 16", { TotalFootprint = 3, DMXFootprint = "0,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1" }, { obj("DMXChannels", "DMXChannels", {}, { channel("Pan", yoke, 1, { "Pan" }, { Fine = 2 }), channel("Dimmer", body, 3, { "Dimmer" }) }) }, { GeometryDirect = body })
  m.no = 1
  local t = obj("FixtureType", "Mover", { Manufacturer = "Test" }, { obj("DMXModes", "DMXModes", {}, { m }), obj("Geometries", "Geometries", {}, { body }), obj("Models", "Models", {}, {}) })
  t.no = 2
  t.DMXModes, t.Geometries, t.Models = t.kids[1], t.kids[2], t.kids[3]
  return t
end

-- Review of PR #52: a mode whose offsets skip an address and run past the footprint, and a channel without a
-- readable break.
local function odd()
  local body = obj("Geometry", "Body", { PosX = 0, PosY = 0, PosZ = 0 }, {})
  local fp3 = "0,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1"
  local gappy = obj("DMXMode", "Gappy", { TotalFootprint = 3, DMXFootprint = fp3 }, { obj("DMXChannels", "DMXChannels", {}, { channel("A", body, 1, { "Dimmer" }), channel("B", body, 2, { "Pan" }), channel("C", body, 4, { "Tilt" }) }) }, { GeometryDirect = body })
  gappy.no = 1
  local nobreak = obj("DMXMode", "No break", { TotalFootprint = 3, DMXFootprint = fp3 }, { obj("DMXChannels", "DMXChannels", {}, { channel("A", body, 1, { "Dimmer" }), channel("B", body, 2, { "Pan" }), channel("C", body, 3, { "Tilt" }, { DMXBreak = false }) }) }, { GeometryDirect = body })
  nobreak.no = 2
  local t = obj("FixtureType", "Odd", { Manufacturer = "Test" }, { obj("DMXModes", "DMXModes", {}, { gappy, nobreak }), obj("Geometries", "Geometries", {}, { body }), obj("Models", "Models", {}, {}) })
  t.no = 3
  t.DMXModes, t.Geometries, t.Models = t.kids[1], t.kids[2], t.kids[3]
  return t
end

-- SU-19 (0.34.0): a beam with wheels. Slot names display with the slot number ("Slot 2 'red'") but the object's name
-- is plain; Color is "r,g,b,a"; a colour wheel converted from a grandMA2 library reads every slot white. The colour
-- channel's function names its wheel (Wheel), its channel sets the slot they select (WheelSlotIndex), 24-bit hex DMX.
local function beam()
  local body = obj("Geometry", "Body", { PosX = 0, PosY = 0, PosZ = 0 }, {})
  local W = "1.0000000000,1.0000000000,1.0000000000,1.0000000000"
  local c1 = obj("Wheel", "C1", {}, { obj("Slot", "open", { Color = W }), obj("Slot", "colour 1", { Color = W }), obj("Slot", "colour 2", { Color = W }) })
  local e = obj("Wheel", "E", {}, { obj("Slot", "open", { Color = W }), obj("Slot", "prism", { Color = W, MediaFileName = "GOBO/SHEHDS/x.png", Appearance = "Gobos.GoboImage 5" }) })
  local cf = obj("ChannelFunction", "Color1 1", { Attribute = "Color1", DMXFrom = "000000", DMXTo = "7F7F7F" },
    { obj("ChannelSet", "open", { DMXFrom = "000000", DMXTo = "0A0A0A", WheelSlotIndex = 1 }), obj("ChannelSet", "colour 1", { DMXFrom = "0B0B0B", DMXTo = "151515", WheelSlotIndex = 2 }) }, { Wheel = c1 })
  local spin = obj("ChannelFunction", "Color1WheelSpin 2", { Attribute = "Color1WheelSpin", DMXFrom = "800000", DMXTo = "FFFFFF" }, { obj("ChannelSet", "stop", { DMXFrom = "C0C0C0", DMXTo = "C0C0C0" }) }, { Wheel = c1 })
  local plain = obj("ChannelFunction", "Dimmer 1", { Attribute = "Dimmer" }, {})
  local color = obj("DMXChannel", "Color1", { Coarse = 1, Fine = "None", Ultra = "None", DMXBreak = 1, Default = "<000000>" }, { obj("LogicalChannel", "Color1", {}, { cf, spin }) }, { Geometry = body })
  local fx = obj("ChannelFunction", "Prism 1", { Attribute = "EFFECTWHEELSELECT", DMXFrom = "000000", DMXTo = "FFFFFF" }, { obj("ChannelSet", "prism", { DMXFrom = "080808", DMXTo = "FFFFFF", WheelSlotIndex = 2 }) }, { Wheel = e })
  local effect = obj("DMXChannel", "Effect", { Coarse = 2, Fine = 3, Ultra = "None", DMXBreak = 1, Default = "<000000>" }, { obj("LogicalChannel", "Effect", {}, { fx }) }, { Geometry = body })
  local dim = obj("DMXChannel", "Dimmer", { Coarse = 4, Fine = "None", Ultra = "None", DMXBreak = 1, Default = "<000000>" }, { obj("LogicalChannel", "Dimmer", {}, { plain }) }, { Geometry = body })
  local m = obj("DMXMode", "Mode 0", { TotalFootprint = 4, DMXFootprint = "0,3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1" }, { obj("DMXChannels", "DMXChannels", {}, { color, effect, dim }) }, { GeometryDirect = body })
  m.no = 1
  local t = obj("FixtureType", "Beam", { Manufacturer = "Test" }, { obj("DMXModes", "DMXModes", {}, { m }), obj("Geometries", "Geometries", {}, { body }), obj("Models", "Models", {}, {}), obj("Wheels", "Wheels", {}, { c1, e }) })
  t.no = 4
  t.DMXModes, t.Geometries, t.Models = t.kids[1], t.kids[2], t.kids[3]
  return t
end

local WASHER, MOVER, ODD, BEAM = washer(), par(), odd(), beam()
local function fixture(fid, t, m, kids)
  local f = obj("Fixture", "Fx " .. fid, { FID = fid, FixtureType = t.no .. " " .. t.name, Mode = m.name, Patch = "1.001", Break1 = "1.001" }, kids, { ModeDirect = m, FID = fid })
  return f
end
local wf = fixture(201, WASHER, WASHER.DMXModes.kids[1], { obj("SubFixture", "[Instance2]", {}), obj("SubFixture", "[Instance3]", {}) })
local mf = fixture(301, MOVER, MOVER.DMXModes.kids[1])
local stage = obj("Stage", "Stage 1", {}, { obj("Fixtures", "Fixtures", {}, { wf, mf }) })
stage.Fixtures = stage.kids[1]
local LIVE = obj("Patch", "LivePatch", {}, { obj("FixtureTypes", "FixtureTypes", {}, { WASHER, MOVER, ODD, BEAM }), obj("Stages", "Stages", {}, { stage }) })
LIVE.FixtureTypes, LIVE.Stages = LIVE.kids[1], LIVE.kids[2]
ShowData = function() return { LivePatch = LIVE, Patch = obj("Patch", "Patch", {}, {}) } end
Patch = function() return LIVE end
CmdObj = function() return { Get = function() return "Root" end } end
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

-------------------------------------------------------------------------------
-- Tests
-------------------------------------------------------------------------------

local r = request("patch.typeStructure", { type = "Washer", mode = 1 })
check("patch.typeStructure answers for a type and mode", r.ok, J(r))
local m = r.ok and r.result.modes[1] or {}
check("the mode's cells are the geometry references under its root, in tree order", m.cells == 2 and m.cellList[1].name == "Instance2" and m.cellList[2].name == "Instance3", J(m.cellList))
check("a cell reports its position (metres), template and break offset", m.cellList and m.cellList[1].posX == -0.44 and m.cellList[1].template == "RGBW" and m.cellList[2].breakOffsets == "1:5", J(m.cellList))
local byKey = {}
for _, c in ipairs(m.channels or {}) do byKey[(c.cell or "-") .. "|" .. c.channel] = c end
check("a template channel repeats per cell at the cell's offset + its own - 1", byKey["Instance2|RGBW_R"] and byKey["Instance2|RGBW_R"].offset == 1 and byKey["Instance3|RGBW_R"].offset == 5 and byKey["Instance3|RGBW_W"].offset == 8, J(m.channels))
check("a channel inside the root is at its own offset, with every attribute of its functions", byKey["-|Main_Shutter"] and byKey["-|Main_Shutter"].offset == 9 and byKey["-|Main_Shutter"].attribute == "Shutter1" and byKey["-|Main_Shutter"].attributes == "Shutter1,Shutter1Strobe", J(byKey["-|Main_Shutter"]))
check("a channel without a coarse offset is virtual, once per cell", byKey["Instance2|RGBW_Dimmer"] and byKey["Instance2|RGBW_Dimmer"].virtual == true and byKey["Instance2|RGBW_Dimmer"].offset == nil and m.virtualChannels == 1, J(m.channels))
check("every address of the footprint is used, so no limitation", m.addressesUsed == 10 and #r.result.limitations == 0, J(r.result.limitations))
check("rows with an address come first, in address order; virtual rows last", m.channels[1].offset == 1 and m.channels[10].offset == 10 and m.channels[11].virtual == true, J(m.channels))
check("the mode's size is its root geometry's model, in metres", m.size and m.size.name == "Body" and m.size.length == 1.04, J(m.size))
check("the geometry tree is flat, with parents, depths and the referenced template", r.result.geometry and #r.result.geometry == 9 and r.result.geometry[4].name == "Instance2" and r.result.geometry[4].parent == "Main Module" and r.result.geometry[4].depth == 2 and r.result.geometry[4].references == "RGBW", J(r.result.geometry))
check("models with their dimensions", r.result.models and r.result.models[1].length == 1.04 and r.result.models[2].width == 0.08, J(r.result.models))

r = request("patch.typeStructure", { type = 1, mode = "Broken", geometry = false })
local lim = r.ok and table.concat(r.result.limitations, " | ") or ""
check("a cell without an offset for the channel's break is a limitation, not a guessed address", lim:find("cell Instance3#2: no offset for break 1", 1, true) ~= nil, lim)
check("channels that do not cover the footprint are a limitation", lim:find("cover 1 of 10 DMX addresses", 1, true) ~= nil, lim)
check("geometry: false leaves the tree out", r.ok and r.result.geometry == nil, J(r))

r = request("patch.typeStructure", { type = "Mover" })
local mv = r.ok and r.result.modes[1] or {}
check("a type without cells: absolute channels with fine offsets, no cells", mv.cells == 0 and mv.channels[1].offset == 1 and mv.channels[1].fine == 2 and mv.addressesUsed == 3, J(mv))
r = request("patch.typeStructure", { type = 1, channelLimit = 3 })
check("channelLimit truncates and says so", r.ok and r.result.modes[1].channelsTruncated == true and #r.result.modes[1].channels == 3, J(r))
r = request("patch.typeStructure", { type = "Nope" })
check("an unknown type is refused", r.ok == false and r.code == "no-type", J(r))
r = request("patch.typeStructure", { type = 1, mode = "Nope" })
check("an unknown mode is refused", r.ok == false and r.code == "no-mode", J(r))

r = request("patch.typeStructure", { type = "Odd", mode = "Gappy", geometry = false })
lim = r.ok and table.concat(r.result.limitations, " | ") or ""
check("an address past its break's range is not counted as coverage: 2 of 3, address 3 unused, address 4 outside", r.ok and r.result.modes[1].addressesUsed == 2 and lim:find("no channel uses break 1: 3", 1, true) ~= nil and lim:find("C at break 1 address 4 (the break has 3)", 1, true) ~= nil, lim)
r = request("patch.typeStructure", { type = "Odd", mode = "No break", geometry = false })
lim = r.ok and table.concat(r.result.limitations, " | ") or ""
local c3
for _, c in ipairs(r.ok and r.result.modes[1].channels or {}) do if c.channel == "C" then c3 = c end end
check("a channel whose break cannot be read keeps no guessed break or address, and says so", c3 and c3["break"] == nil and c3.offset == nil and c3.addressUnknown == true and lim:find("the DMX break of channel C could not be read", 1, true) ~= nil and lim:find("no channel uses break 1: 3", 1, true) ~= nil, J(c3) .. " " .. lim)

r = request("patch.typeStructure", { type = "Beam", mode = 1, geometry = false })
local wh = r.ok and r.result.wheels or {}
check("su19: wheels with slots: plain names, colours parsed, media and appearance", #wh == 2 and wh[1].name == "C1" and #wh[1].slots == 3 and wh[1].slots[2].name == "colour 1" and wh[1].slots[2].color.r == 1 and wh[1].slots[2].color.a == 1 and wh[2].slots[2].media == "GOBO/SHEHDS/x.png" and wh[2].slots[2].appearance == "Gobos.GoboImage 5" and wh[1].slots[1].media == nil, J(wh))
local wfn = r.ok and r.result.wheelFunctions or {}
check("su19: wheel channel functions beside the modes, tagged with the mode, with bits from Fine and each channel set's slot and DMX range", #wfn == 3 and wfn[1].mode == "Mode 0" and wfn[1].wheel == "C1" and wfn[1].attribute == "Color1" and wfn[1].bits == 8 and wfn[1].channelSets[2].slot == 2 and wfn[1].channelSets[2].dmxFrom == "0B0B0B" and wfn[2].channelSets[1].slot == nil and wfn[3].bits == 16 and wfn[3].wheel == "E", J(wfn))
check("su19: no wheel functions are nested in the mode (the serialiser's depth bound)", r.ok and r.result.modes[1]._wheelFunctions == nil and r.result.modes[1].wheelFunctions == nil, J(r.result and r.result.modes))
-- Review of PR #65: an unreadable Fine is an unknown resolution (never 8 bit), and says so.
local effectCh = BEAM.DMXModes.kids[1].kids[1].kids[2]
effectCh.pv.FINE = nil
r = request("patch.typeStructure", { type = "Beam", mode = 1, geometry = false })
local eff
for _, f in ipairs(r.ok and r.result.wheelFunctions or {}) do if f.channel == "Effect" then eff = f end end
check("su19 review: an unreadable Fine leaves the resolution unknown, with a limitation", eff and eff.bits == nil and table.concat(r.result.limitations, " | "):find("Fine / Ultra address could not be read", 1, true) ~= nil, J(eff))
effectCh.pv.FINE = 3
-- Review of PR #65: a cell whose break cannot be read is flagged, not ordered by its other breaks.
local cellRef = WASHER.Geometries.kids[2].kids[1].kids[1]
local brk = cellRef.kids[1]
local savedPatch = brk.pv.DMXPATCH
brk.pv.DMXPATCH = nil
r = request("patch.typeStructure", { type = "Washer", mode = 1, geometry = false })
local c1 = r.ok and r.result.modes[1].cellList[1] or {}
check("su19 review: a cell with an unreadable break is flagged incomplete and named in the limitations", c1.breakOffsetsIncomplete == true and table.concat(r.result.limitations, " | "):find("cell Instance2: a break's DMX offset could not be read", 1, true) ~= nil, J(c1))
brk.pv.DMXPATCH = savedPatch
r = request("patch.typeStructure", { type = "Washer", mode = 1, geometry = false })
check("su19 review: a readable cell carries no incomplete flag", r.ok and r.result.modes[1].cellList[1].breakOffsetsIncomplete == nil, J(r.ok and r.result.modes[1].cellList[1]))

r = request("patch.typeStructure", { type = "Washer", mode = 1, geometry = false })
check("su19: a type without wheels answers empty lists", r.ok and #r.result.wheels == 0 and #r.result.wheelFunctions == 0 and J(r.result):find('"wheels":%[%]') ~= nil, J(r.result and r.result.wheels))

r = request("patch.types")
local cellsOf = {}
if r.ok then for _, t in ipairs(r.result.types) do for _, md in ipairs(t.modes) do cellsOf[t.name .. "/" .. md.name] = md.cells end end end
check("patch.types reports each mode's cell count", cellsOf["Washer/10 channel"] == 2 and cellsOf["Mover/Pan 16"] == 0, J(cellsOf))
r = request("patch.list")
local rows = {}
if r.ok then for _, f in ipairs(r.result.fixtures) do rows[f.fid] = f end end
check("patch.list reports a fixture's cells (SubFixture children), apart from child fixtures", rows[201] and rows[201].cells == 2 and rows[201].subfixtures == 0 and rows[301].cells == 0, J(r))

print(string.format("%d passed, %d failed", passes, failures))
if failures > 0 then print("FAILED"); os.exit(1) end
print("ALL PASSED")
