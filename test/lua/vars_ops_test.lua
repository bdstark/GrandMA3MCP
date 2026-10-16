-- Regression harness for the bridge's console variable ops (SU-15, bridge 0.31.0) under stock Lua (5.4 or newer):
-- vars.get, vars.set, vars.delete.
--
-- Modelled as on onPC 2.5.1 (docs/probes/su-15-console-variables-macos-2.5.1.md): GetVar returns no value at all for a
-- missing variable, SetVar keeps the Lua type (integer, float, string), DelVar returns nil for a missing one, global
-- and user variables are separate sets.
--
-- Run from the repository root:   lua test/lua/vars_ops_test.lua

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
CurrentUser = function() return nil end
CmdObj = function() return { Get = function() return "Root" end } end
GetTopModal = function() return nil end

local Obj = {}
Obj.__index = function(t, k)
  local v = Obj[k]
  if v ~= nil then return v end
  for _, c in ipairs(rawget(t, "kids") or {}) do if rawget(c, "name") == k then return c end end
  return nil
end
function Obj:Children() return self.kids end
function Obj:Count() return #self.kids end
function Obj:GetClass() return self.class end
function Obj:Get(k, role) local v = self.pv[k:upper()]; if v == nil and k:upper() == "NAME" then return self.name end; return v end
function Obj:Set(k, v) self.pv[k:upper()] = v end
function Obj:Remove(i) table.remove(self.kids, i) end
local function obj(class, name, props, kids)
  local o = setmetatable({ class = class, name = name, pv = {}, kids = kids or {} }, Obj)
  for k, v in pairs(props or {}) do o.pv[k:upper()] = v end
  return o
end
local function artEntry(i, lu, amount, abs, enabled) return obj("Art-Net-Data", "Art-Net-Data " .. i, { LocalUniverse = tostring(lu), Amount = tostring(amount), ["Art-NetAbsolute"] = tostring(abs), Mode = "Auto", Enabled = enabled and "Yes" or "No", Net = "0", ["Art-NetSub-Net"] = "0", Universe = tostring(abs) }) end
local function sacnEntry(i, lu, amount, uni, enabled) return obj("sACNData", "sACNData " .. i, { LocalUniverse = tostring(lu), Amount = tostring(amount), sACNUniverse = tostring(uni), Mode = "Output Multicast", Enabled = enabled and "Yes" or "No", Priority = "100", TTL = "8" }) end
local artCol = obj("ArtNetDataCollect", "ArtNetDataCollect", {}, { artEntry(1, 1, 2, 10, true) })
function artCol:Append() local e = artEntry(#self.kids + 1, 1, 1, 0, false); self.kids[#self.kids + 1] = e; return e end
local sacnCol = obj("sACNDataCollect", "sACNDataCollect", {}, { sacnEntry(1, 3, 1, 7, false) })
local ART = obj("ArtNet", "ArtNet", { Out = "Yes", In = "No", Interface = "0.0", PreferredIP = "10.0.0.0/8" }, { artCol })
local SACN = obj("sACN", "sACN", { Out = "No", In = "No" }, { sacnCol })
local PROTO = obj("DMXProtocols", "DMXProtocols", {}, { ART, SACN })
local stations = obj("OutputStations", "OutputStations", {}, { obj("OutputStationCollect", "onPC", {}, { obj("OutputStation", "host", { IP = "192.168.2.162", Type = "DMX-key" }) }) })
Root = function() return { DeviceConfigurations = { DMXProtocols = PROTO, OutputStations = stations }, Get = function() return false end, VirtualKeys = { Count = function() return 0 end }, MANetSocket = { Get = function() return nil end }, maNetSocket = {} } end
local unis = {}
for i = 1, 6 do unis[i] = obj("DmxUniverse", "DmxUniverse " .. i, { Used = (i <= 2) and tostring(4 - i) or "0", Granted = (i == 1) and "Yes" or (i <= 2 and "No" or "Yes"), Request = "Auto", PortOut = (i <= 2) and "Yes" or "No", MergeMode = "Prio" }) end
local LIVE = { DmxUniverses = obj("DmxUniverses", "DmxUniverses", {}, unis), Stages = obj("Stages", "Stages", {}, {}), FixtureTypes = obj("FixtureTypes", "FixtureTypes", {}, {}) }
ShowData = function() return { LivePatch = LIVE, Patch = obj("Patch", "Patch", {}, {}) } end
Patch = function() return LIVE end

-- Variables: two sets, keyed by name; the console API functions take the set handle.
local GV, UV = { kind = "global", vars = {} }, { kind = "user", vars = {} }
GlobalVars = function() return GV end
UserVars = function() return UV end
GetVar = function(h, n) local v = h.vars[n]; if v == nil then return end return v end
SetVar = function(h, n, v) h.vars[n] = v; return true end
DelVar = function(h, n) if h.vars[n] == nil then return nil end h.vars[n] = nil; return true end
CurrentUser = function() return { name = "Admin" } end

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


GV.vars.HexCol = 11
GV.vars.Mode = "clock"
GV.vars.Ratio = 1.5
UV.vars.HexCol = 12

local r = request("vars.get", { scope = "global", names = { "HexCol", "Mode", "Ratio", "Nope" } })
check("vars.get answers", r.ok, J(r))
local it = r.ok and r.result.items or {}
check("an integer reads back as an integer", it[1] and it[1].exists == true and it[1].value == 11 and it[1].type == "integer", J(it[1]))
check("text and double keep their type", it[2] and it[2].type == "text" and it[2].value == "clock" and it[3].type == "double" and it[3].value == 1.5, J(it))
check("a missing variable exists: false, no value invented", it[4] and it[4].exists == false and it[4].value == nil, J(it[4]))
r = request("vars.get", { scope = "user", names = { "HexCol" } })
check("user variables are a separate set, with the plugin user's name", r.ok and r.result.items[1].value == 12 and r.result.user == "Admin", J(r))

r = request("vars.set", { scope = "global", name = "HexCol", value = 21, type = "integer" })
check("vars.set integer: before and after", r.ok and r.result.before.value == 11 and r.result.after.value == 21 and r.result.after.type == "integer" and math.type(GV.vars.HexCol) == "integer", J(r))
r = request("vars.set", { scope = "global", name = "Speed", value = 3, type = "double" })
check("vars.set double keeps a whole number a double", r.ok and r.result.after.type == "double" and math.type(GV.vars.Speed) == "float" and r.result.before.exists == false, J(r))
r = request("vars.set", { scope = "user", name = "Label", value = 'a "b" c', type = "text" })
check("vars.set text keeps quotes as written", r.ok and UV.vars.Label == 'a "b" c' and r.result.after.type == "text", J(r))
r = request("vars.set", { scope = "global", name = "X", value = 1.5, type = "integer" })
check("a non-integer for type integer is refused", r.ok == false and r.code == "bad-args" and GV.vars.X == nil, J(r))
r = request("vars.set", { scope = "global", name = "X", value = 7, type = "text" })
check("a number for type text is refused", r.ok == false and r.code == "bad-args", J(r))
r = request("vars.set", { scope = "world", name = "X", value = "a", type = "text" })
check("an unknown scope is refused", r.ok == false and r.code == "bad-args", J(r))
r = request("vars.get", { scope = "global", names = { "bad\nname" } })
check("a name with a control character is refused", r.ok == false and r.code == "bad-args", J(r))

r = request("vars.delete", { scope = "global", name = "Mode" })
check("vars.delete removes it and reads back missing", r.ok and r.result.before.exists == true and r.result.after.exists == false and GV.vars.Mode == nil, J(r))
r = request("vars.delete", { scope = "global", name = "Never" })
check("deleting a missing variable is not an error and changes nothing", r.ok and r.result.before.exists == false and r.result.after.exists == false, J(r))
r = request("vars.delete", { scope = "user", name = "HexCol" })
check("deleting a user variable leaves the global one", r.ok and UV.vars.HexCol == nil and GV.vars.HexCol == 21, J(r))

print(string.format("%d passed, %d failed", passes, failures))
if failures > 0 then print("FAILED"); os.exit(1) end
print("ALL PASSED")
