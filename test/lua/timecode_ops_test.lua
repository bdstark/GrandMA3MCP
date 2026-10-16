-- Regression harness for the bridge's SB-08 timecode ops (timecode.read, timecode.edit) under stock Lua (5.4 or newer).
--
-- A timecode show is modelled as onPC 2.5.1 builds it: Append("TrackGroup") brings a MarkerTrack and one Track,
-- Append("Track") one TimeRange; a TimeRange's Append("CmdSubTrack") returns nil until a request after the one that
-- set the track's Target (the console's frame rule); events carry RawTime, Token (by name), Status, CueDestination.
--
-- Run from the repository root:   lua test/lua/timecode_ops_test.lua

local here = (arg and arg[0] or ""):match("^(.*)[/\\]") or "."
package.path = here .. "/?.lua;" .. package.path
local pluginPath = here .. "/../../plugin/gma3_mcp_bridge.lua"

package.preload["socket"] = function()
  return { gettime = function() return os.clock() end, bind = function() return nil, "stub: no bind" end }
end
Echo = function() end
ErrEcho = Echo; Printf = Echo; ErrPrintf = Echo
GetPath = function() return nil end
Enums = { PathType = { Temp = 1 }, Roles = { Display = 1, Edit = 2 }, VirtualKeyCode = {}, KeyboardCodes = {} }
Keyboard = function() end
CurrentProfile = function() return { name = "Default", KeyboardShortCuts = { Get = function() return "true" end, Count = function() return 0 end } } end
GetDisplayByIndex = function() return nil end
BuildDetails = function() return {} end
Root = function() return { Get = function() return false end, VirtualKeys = { Count = function() return 0 end }, MANetSocket = { Get = function() return nil end }, maNetSocket = {} } end
CurrentUser = function() return nil end

-------------------------------------------------------------------------------
-- Fake handles
-------------------------------------------------------------------------------

local registry = setmetatable({}, { __mode = "k" })
local fileMeta = getmetatable(io.stdout)
local handleMeta = { __gc = fileMeta and fileMeta.__gc, __close = fileMeta and fileMeta.__close, __name = "FakeHandle" }
local methods = {}
handleMeta.__index = function(u, key)
  local def = registry[u]
  if not def then return nil end
  if methods[key] then return methods[key] end
  if key == "name" then return def.name end
  if key == "no" then return def.no end
  return def.props[tostring(key):lower()]
end
function methods.Get(u, name, role)
  local v = registry[u].props[tostring(name):lower()]
  if type(v) == "function" then return v(role) end
  return v
end
function methods.GetClass(u) return registry[u].class end
function methods.Addr(u) return registry[u].addr or ("addr:" .. tostring(registry[u].name)) end
function methods.Parent(u) return registry[u].parent end
function methods.Children(u) return registry[u].children or {} end
function methods.AddrNative(u) return "native:" .. tostring(registry[u].name) end

local function H(def)
  local u = io.tmpfile()
  debug.setmetatable(u, handleMeta)
  local lowered = {}
  for k, v in pairs(def.props or {}) do lowered[tostring(k):lower()] = v end
  def.props = lowered
  registry[u] = def
  return u
end



local frame = 0
local TOKENS = { ["Go+"] = 3, ["Go-"] = 4, Goto = 16, Load = 17, On = 7, Off = 8, Toggle = 14, Top = 15, Pause = 18, Kill = 29, Flash = 1, Temp = 13, Swap = 2, Select = 24 }
local function node(class, name, extra)
  local def = { name = name, class = class, kids = {}, props = {} }
  for k, v in pairs(extra or {}) do def[k] = v end
  return def
end
local function handle(def)
  local u = H(def)
  def.self = u
  return u
end
function methods.Count(u) return #registry[u].kids end
function methods.Ptr(u, i) return registry[u].kids[i] end
function methods.HasActivePlayback(u) return registry[u].playing == true end
function methods.Set(u, name, v)
  local def = registry[u]
  local k = tostring(name):lower()
  if k == "token" then
    if TOKENS[v] then def.props.token = TOKENS[v]; def.name = v; def.tokenName = v end
  elseif k == "status" then
    def.props.status = v
    if v == "Off" then def.name = def.tokenName .. "(Release)" end
  elseif k == "target" then
    def.props.target = v; def.targetFrame = frame
  else
    def.props[k] = v
  end
end
local function add(parentU, class, name, extra)
  local def = node(class, name, extra)
  def.parent = parentU
  local u = handle(def)
  table.insert(registry[parentU].kids, u)
  return u
end
function methods.Append(u, class)
  local def = registry[u]
  if def.class == "Timecode" and class == "TrackGroup" then
    local g = add(u, "TrackGroup", "TrackGroup " .. (#def.kids + 1))
    add(g, "MarkerTrack", "Marker")
    local t = add(g, "Track", "Track 1")
    add(t, "TimeRange", "TimeRange 1", { props = { rawstart = 0 } })
    return g
  elseif def.class == "TrackGroup" and class == "Track" then
    local t = add(u, "Track", "Track " .. #def.kids)
    add(t, "TimeRange", "TimeRange 1", { props = { rawstart = 0 } })
    return t
  elseif def.class == "TimeRange" and class == "CmdSubTrack" then
    local track = registry[def.parent]
    if not track.props.target or track.targetFrame >= frame then return nil end
    return add(u, "CmdSubTrack", "CmdSubTrack " .. (#def.kids + 1))
  elseif def.class == "CmdSubTrack" and class == "CmdEvent" then
    return add(u, "CmdEvent", "Go+", { props = { token = 3, rawtime = 0, executecommand = "Yes" }, tokenName = "Go+" })
  end
  return nil
end

local tc = handle(node("Timecode", "Show", { no = 901, addr = "14.14.1.15.901", props = { Cursor = "0.00", Duration = "0.00", LoopMode = "Off", TCSlot = "-1", RawDuration = 0 } }))
local seqDef = node("Sequence", "Chase", { no = 908, addr = "14.14.1.7.908" })
local seq = handle(seqDef)
local cue2 = handle(node("Cue", "Cue 2", { no = 2000, addr = "14.14.1.7.908.3000", parent = seq }))
local preset = handle(node("Preset", "Red", { no = 4 }))
local objects = { ["Timecode 901"] = tc, ["Sequence 908"] = seq, ["Sequence 908 Cue 2"] = cue2, ["Preset 4.4"] = preset }
local nativeCalls = {}
ObjectList = function(ref) nativeCalls[#nativeCalls + 1] = ref; local h = objects[ref]; return h and { h } or nil end
IsObjectValid = function() return true end
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
  frame = frame + 1
  local line = json.encode({ id = "t", op = op, args = args or {} })
  local co = coroutine.create(function() return state._handleLine({ id = 1 }, line) end)
  local ok, res = coroutine.resume(co)
  while ok and coroutine.status(co) == "suspended" do ok, res = coroutine.resume(co) end
  assert(ok, res)
  return json.decode(res)
end


local r = request("ping")
check("ping reports bridge 0.30.0", r.ok and r.result.bridgeVersion == "0.33.0", J(r))

r = request("timecode.read", { timecode = 902 })
check("a missing show is not found", not r.ok and r.code == "not-found", J(r))
r = request("timecode.read", { timecode = 901 })
check("an empty show reads with no groups", r.ok and #r.result.groups == 0 and #r.result.events == 0 and r.result.settings.TCSlot == "-1" and r.result.truncated == false, J(r))

r = request("timecode.edit", { timecode = 901, action = "add_group" })
check("add_group appends a track group", r.ok and r.result.groups == 1, J(r))
r = request("timecode.edit", { timecode = 901, action = "add_track", group = 1 })
check("add_track appends a second track", r.ok and r.result.tracks == 2, J(r))
r = request("timecode.edit", { timecode = 901, action = "set_target", group = 1, track = 1, target = "Preset 4.4" })
check("only sequences are targets", not r.ok and r.code == "unsupported", J(r))
r = request("timecode.edit", { timecode = 901, action = "set_target", group = 1, track = 3, target = "Sequence 908" })
check("a missing track is refused", not r.ok and r.code == "not-found" and r.error:find("there are 2", 1, true), J(r))
r = request("timecode.edit", { timecode = 901, action = "add_events", group = 1, track = 1, events = { { raw = 16777216, token = "Go+" } } })
check("events need a target", not r.ok and r.code == "no-target", J(r))
r = request("timecode.edit", { timecode = 901, action = "set_target", group = 1, track = 1, target = "Sequence 908" })
check("set_target reads the target back", r.ok and r.result.target.addr == "14.14.1.7.908" and r.result.target.class == "Sequence", J(r))

local bad = {
  { { raw = -1, token = "Go+" }, "raw must be a non-negative integer" },
  { { raw = 1.5, token = "Go+" }, "raw must be a non-negative integer" },
  { { raw = 1, token = "Record" }, "token Record is not supported" },
  { { raw = 1, token = "Go+", status = "On" }, "status is On or Off" },
  { { raw = 1, token = "Goto", cue = "Sequence 908 Cue 9" }, "is not a cue" },
}
for _, b in ipairs(bad) do
  r = request("timecode.edit", { timecode = 901, action = "add_events", group = 1, track = 1, events = { { raw = 0, token = "Go+" }, b[1] } })
  check("refused before anything is appended: " .. b[2], not r.ok and r.error:find(b[2], 1, true), J(r))
end
r = request("timecode.read", { timecode = 901 })
check("nothing was appended by the refused calls", r.ok and #r.result.subtracks == 0 and #r.result.events == 0 and #r.result.tracks == 2 and #r.result.ranges == 2, J(r))

local events = { { raw = 33554432, token = "Go+" }, { raw = 16777216, token = "Go+" }, { raw = 50331648, token = "Goto", cue = "Sequence 908 Cue 2" },
  { raw = 8388608, token = "Flash", status = "On" }, { raw = 25165824, token = "Flash", status = "Off" } }
r = request("timecode.edit", { timecode = 901, action = "add_events", group = 1, track = 1, events = events })
check("add_events appends in the given order and reads each back", r.ok and #r.result.added == 5 and r.result.added[2].raw == 16777216 and r.result.added[3].cue.addr == "14.14.1.7.908.3000" and r.result.added[5].name == "Flash(Release)", J(r))
r = request("timecode.edit", { timecode = 901, action = "add_events", group = 1, track = 1, events = { { raw = 0, token = "Top" } } })
check("a second call reuses the command subtrack", r.ok, J(r))

r = request("timecode.read", { timecode = 901 })
local res = r.ok and r.result
local ev = res and res.events or {}
check("read: the target, one subtrack and six events in storage order with their paths", res and res.tracks[1].target.name == "Chase" and #res.subtracks == 1 and res.subtracks[1].class == "CmdSubTrack" and #ev == 6 and ev[1].raw == 33554432 and ev[6].group == 1 and ev[6].track == 1 and ev[6].range == 1 and ev[6].subtrack == 1 and ev[6].index == 6, J(r))
check("read: the Goto's cue with its sequence", ev[3] and ev[3].cue.sequence == 908 and ev[3].cue.no == 2000, J(ev[3]))
check("read: Flash press and release", ev[4] and ev[4].status == "On" and ev[5].status == "Off" and ev[5].name == "Flash(Release)", J(ev[5]))
check("read: the empty second track", res and res.tracks[2].target == nil and res.ranges[2].track == 2, J(res and res.tracks[2]))
r = request("timecode.read", { timecode = 901, maxEvents = 4 })
check("the event read is bounded and says so", r.ok and r.result.truncated == true and #r.result.events == 4 and r.result.eventCount == 6, J(r))

-- A target set in the same request as the subtrack: the console's frame rule.
r = request("timecode.edit", { timecode = 901, action = "set_target", group = 1, track = 2, target = "Sequence 908" })
local t2 = registry[registry[registry[tc].kids[1]].kids[3]]
t2.targetFrame = frame + 1 -- as if the next request ran in the same frame
r = request("timecode.edit", { timecode = 901, action = "add_events", group = 1, track = 2, events = { { raw = 0, token = "Go+" } } })
check("a subtrack that cannot be created yet is not-ready", not r.ok and r.code == "not-ready", J(r))

-- Executor ranges never reach ObjectList: the guarded helper expands or refuses them (the onPC hang).
nativeCalls = {}
r = request("timecode.edit", { timecode = 901, action = "set_target", group = 1, track = 1, target = "Page 1.180 Thru 1.181" })
local rangeCalled = false
for _, c in ipairs(nativeCalls) do if c:find("Thru", 1, true) then rangeCalled = true end end
check("an executor-range target never reaches ObjectList", not r.ok and not rangeCalled, J({ r = r, calls = nativeCalls }))
nativeCalls = {}
r = request("timecode.edit", { timecode = 901, action = "add_events", group = 1, track = 1, events = { { raw = 0, token = "Goto", cue = "Page 1.180 Thru 1.181" } } })
rangeCalled = false
for _, c in ipairs(nativeCalls) do if c:find("Thru", 1, true) then rangeCalled = true end end
check("an executor-range cue never reaches ObjectList", not r.ok and not rangeCalled and r.error:find("is not a cue", 1, true), J({ r = r, calls = nativeCalls }))
nativeCalls = {}
r = request("timecode.edit", { timecode = 901, action = "set_target", group = 1, track = 1, target = "Page 1.* " })
check("a wildcard executor target is refused unsafe-range", not r.ok and r.code == "unsafe-range" and #nativeCalls <= 1, J({ r = r, calls = nativeCalls }))

r = request("timecode.edit", { timecode = 901, action = "play" })
check("there is no play action", not r.ok and r.code == "bad-args", J(r))

print(string.format("\n%d passed, %d failed", passes, failures))
if failures > 0 then os.exit(1) end
print("ALL PASSED")
