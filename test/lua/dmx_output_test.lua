-- Regression harness for the bridge's DMX output ops (SU-09, bridge 0.30.0) under stock Lua (5.4 or newer):
-- dmx.output, dmx.set, dmx.addEntry, dmx.removeEntry.
--
-- Modelled as on onPC 2.5.1 (docs/probes/su-09-dmx-output-macos-2.5.1.md): universes in the live patch with Used
-- (fixtures patched), Granted, Request, PortOut; Art-Net and sACN under Root.DeviceConfigurations.DMXProtocols with an
-- Out switch and data entries mapping LocalUniverse .. +Amount-1 to protocol universes.
--
-- Run from the repository root:   lua test/lua/dmx_output_test.lua

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

local r = request("dmx.output")
check("dmx.output answers", r.ok, J(r))
local u = r.ok and r.result.universes or {}
check("the universes in use (or set to output) are listed, idle ones are not", #u == 2 and u[1].no == 1 and u[2].no == 2, J(u))
check("each with fixtures patched, grant, request and output port", u[1].fixtures == 3 and u[1].granted == true and u[2].granted == false and u[1].request == "Auto" and u[1].portOut == true, J(u[1]))
local o2 = {}
for _, x in ipairs(u[2] and u[2].outputs or {}) do o2[#o2 + 1] = x.protocol .. ":" .. x.entry .. ":" .. tostring(x.as) .. ":" .. tostring(x.enabled) .. ":" .. tostring(x.protocolOut) end
check("the protocol entries covering a universe, and the protocol universe it is sent as", table.concat(o2, ",") == "artnet:1:11:true:true", J(u[2]))
check("totals: universes, used, wanting output, granted among them", r.ok and r.result.totals.universes == 6 and r.result.totals.used == 2 and r.result.totals.outputWanted == 2 and r.result.totals.grantedOfWanted == 1, J(r.result and r.result.totals))
check("protocols with their entries", r.ok and r.result.protocols.artnet.out == true and r.result.protocols.sacn.out == false and r.result.protocols.sacn.entries[1].universe == 7 and r.result.protocols.sacn.entries[1].priority == 100, J(r.result and r.result.protocols))
check("output stations", r.ok and r.result.stations[1].ip == "192.168.2.162", J(r.result and r.result.stations))
r = request("dmx.output", { universes = { 3 } })
check("a universe asked for is listed although idle", r.ok and #r.result.universes == 3 and r.result.universes[3].no == 3 and #r.result.universes[3].outputs == 1, J(r))

local X = function(t) t.exclusive = true return t end
r = request("dmx.set", { target = "entry", protocol = "sacn", index = 1, property = "Priority", value = 150 })
check("dmx.set needs exclusive", r.ok == false, J(r))
r = request("dmx.set", X({ target = "entry", protocol = "sacn", index = 1, property = "TTL", value = 2 }))
check("a property off the whitelist is refused", r.ok == false and r.code == "bad-property" and sacnCol.kids[1].pv.TTL == "8", J(r))
r = request("dmx.set", X({ target = "entry", protocol = "sacn", index = 1, property = "Priority", value = 150 }))
check("a whitelisted entry property is written and read back", r.ok and r.result.before == "100" and r.result.value == "150", J(r))
r = request("dmx.set", X({ target = "protocol", protocol = "sacn", property = "Out", value = "Yes" }))
check("the protocol's Out switch", r.ok and SACN.pv.OUT == "Yes", J(r))
r = request("dmx.set", X({ target = "universe", universe = 2, property = "Request", value = "On" }))
check("a universe's grant request", r.ok and unis[2].pv.REQUEST == "On" and r.result.value == "On", J(r))
r = request("dmx.set", X({ target = "entry", protocol = "artnet", index = 9, property = "Enabled", value = "No" }))
check("a missing entry is refused", r.ok == false and r.code == "no-entry", J(r))
r = request("dmx.addEntry", X({ protocol = "artnet" }))
check("dmx.addEntry appends a disabled entry and reports its number", r.ok and r.result.index == 2 and r.result.entry.enabled == false and #artCol.kids == 2, J(r))
r = request("dmx.removeEntry", X({ protocol = "artnet", index = 2 }))
check("dmx.removeEntry removes it", r.ok and #artCol.kids == 1 and r.result.removed.index == 2, J(r))
r = request("dmx.addEntry", X({ protocol = "nope" }))
check("an unknown protocol is refused", r.ok == false and r.code == "bad-args", J(r))

print(string.format("%d passed, %d failed", passes, failures))
if failures > 0 then print("FAILED"); os.exit(1) end
print("ALL PASSED")
