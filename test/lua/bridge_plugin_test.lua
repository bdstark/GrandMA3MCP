-- Regression harness for plugin/gma3_mcp_bridge.lua under stock Lua (5.4 or newer).
--
-- The grandMA3 console API and LuaSocket are stubbed, the plugin is loaded the way onPC loads
-- it, and requests are pushed straight into its line handler. The socket stub's gettime can be
-- shifted with the FAKE_CLOCK_OFFSET global so wall-clock checks are tested without sleeping.
--
-- Run from the repository root:   lua test/lua/bridge_plugin_test.lua
-- `npm test` runs it through test/plugin.test.ts when a lua interpreter is on PATH.

local here = (arg and arg[0] or ""):match("^(.*)[/\\]") or "."
package.path = here .. "/?.lua;" .. package.path
local pluginPath = here .. "/../../plugin/gma3_mcp_bridge.lua"

package.preload["socket"] = function()
  return {
    gettime = function() return os.clock() + (_G.FAKE_CLOCK_OFFSET or 0) end,
    bind = function() return nil, "stub: no bind" end,
  }
end

local logs = {}
Echo = function(m) logs[#logs + 1] = m end
ErrEcho = Echo; Printf = Echo; ErrPrintf = Echo
GetPath = function() return nil end
Enums = { PathType = { Temp = 1 } }
BuildDetails = function() return {} end
Root = function() error("no console") end
CurrentUser = function() return nil end

local chunk = assert(loadfile(pluginPath))
local Main, Cleanup = chunk("gma3_mcp_bridge", "gma3_mcp_bridge", {}, nil)
local state = _G.__gma3_mcp_bridge
local json = require("json")

local failures, passes = 0, 0
local function check(name, cond, detail)
  if cond then
    passes = passes + 1
    print("PASS " .. name)
  else
    failures = failures + 1
    print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or ""))
  end
end
local function lastLog() return logs[#logs] or "" end

-- Run a request inside a coroutine (the plugin loop is itself a coroutine), resuming on yields.
-- secondsPerFrame advances the fake clock on every resume, simulating slow console frames.
local function request(op, args, secondsPerFrame)
  local line = json.encode({ id = "t", op = op, args = args })
  local co = coroutine.create(function() return state._handleLine(nil, line) end)
  local ok, res = coroutine.resume(co)
  local frames = 0
  while ok and coroutine.status(co) == "suspended" do
    frames = frames + 1
    if secondsPerFrame then _G.FAKE_CLOCK_OFFSET = (_G.FAKE_CLOCK_OFFSET or 0) + secondsPerFrame end
    ok, res = coroutine.resume(co)
  end
  assert(ok, res)
  return json.decode(res), frames
end

local function resetBudget()
  state.lua.maxMs = 5000
  state.lua.maxSteps = 20000000
  _G.FAKE_CLOCK_OFFSET = 0
end

-------------------------------------------------------------------------------
-- Gate: Lua execution is off until the operator enables it
-------------------------------------------------------------------------------
local r = request("lua", { code = "1+1" })
check("lua op disabled by default", r.ok == false and r.error:find("Lua execution is disabled"), r.error)
r = request("ping", {})
check("ping reports policy", r.ok and r.result.lua.enabled == false and r.result.lua.maxMs == 5000 and r.result.lua.bounded == true, json.encode(r))
r = request("cmd", { command = "" })
check("other ops unaffected by the gate", r.ok == false and r.error:find("args.command"), r.error)

state.running = true
Main(nil, "lua on")
check("'lua on' enables while running", state.lua.enabled == true and lastLog():find("Lua execution now enabled"), lastLog())
r = request("lua", { code = "1+1" })
check("expression evaluates", r.ok and r.result.values[1] == 2, json.encode(r))
r = request("lua", { code = "return 1, nil, 'x', {a=1}" })
check("multiple values with nil placeholder", r.ok and r.result.values[2] == "<nil>" and r.result.values[3] == "x" and r.result.values[4].a == 1, json.encode(r))
r = request("lua", { code = "local x = 5 return x * 2" })
check("statement block evaluates", r.ok and r.result.values[1] == 10, json.encode(r))
r = request("lua", { code = "this is not lua" })
check("compile error reported", r.ok == false and r.error:find("compile error"), r.error)

-------------------------------------------------------------------------------
-- Budget: wall clock and instruction caps
-------------------------------------------------------------------------------
state.lua.maxSteps = 0
local t0 = os.clock()
r = request("lua", { code = "while true do end", maxMs = 200 })
local dt = os.clock() - t0
check("busy loop aborted by time budget", r.ok == false and r.error:find("ran longer than 200 ms"), r.error)
check("time budget error carries the raise hint", r.ok == false and r.error:find("Raise the budget"), r.error)
check("aborted promptly", dt < 1.5, dt)

t0 = os.clock()
r = request("lua", { code = "while true do pcall(function() while true do end end) end", maxMs = 200 })
dt = os.clock() - t0
check("pcall cannot swallow the budget error", r.ok == false and r.error:find("budget exceeded"), r.error)
check("pcall loop aborted promptly", dt < 1.5, dt)
resetBudget()

r = request("lua", { code = "local n=0 for i=1,1e9 do n=n+i end return n", maxSteps = 50000 })
check("instruction budget enforced", r.ok == false and r.error:find("more than 50000 VM instructions"), r.error)

state.lua.maxMs = 100
state.lua.maxSteps = 0
r = request("lua", { code = "while true do end", maxMs = 60000 })
check("request cannot raise the console time budget", r.ok == false and r.error:find("longer than 100 ms"), r.error)
resetBudget()
state.lua.maxSteps = 50000
r = request("lua", { code = "local n=0 for i=1,1e9 do n=n+i end return n", maxSteps = 1e9 })
check("request cannot raise the console step budget", r.ok == false and r.error:find("more than 50000 VM instructions"), r.error)
resetBudget()

r = request("lua", { code = "error('boom')" })
check("user error reported", r.ok == false and r.error:find("boom"), r.error)
r = request("lua", { code = "return 'still alive'" })
check("bridge keeps working after errors", r.ok and r.result.values[1] == "still alive", json.encode(r))

local frames
r, frames = request("lua", { code = "coroutine.yield() coroutine.yield() return 7" })
check("yield passes through to the console loop", r.ok and r.result.values[1] == 7 and frames == 2, json.encode(r) .. " frames=" .. tostring(frames))
check("no hook on the bridge thread", debug.gethook() == nil)

-------------------------------------------------------------------------------
-- Hardening: hook removal, child threads, yield-heavy scripts
-------------------------------------------------------------------------------
local function aborted(res)
  return res.ok == false and (res.error:find("not available") or res.error:find("budget exceeded"))
end
state.lua.maxSteps = 0
r = request("lua", { code = "debug.sethook() while true do end", maxMs = 200 })
check("script cannot remove the hook", aborted(r), r.error)
r = request("lua", { code = "require('debug').sethook() while true do end", maxMs = 200 })
check("require('debug') is the restricted copy", aborted(r), r.error)
r = request("lua", { code = "package.loaded.debug.sethook() while true do end", maxMs = 200 })
check("package.loaded.debug is the restricted copy", aborted(r), r.error)
r = request("lua", { code = "_G.debug.sethook() while true do end", maxMs = 200 })
check("_G.debug is the restricted copy", aborted(r), r.error)
r = request("lua", { code = "local f = load('debug.sethook() while true do end') f()", maxMs = 200 })
check("load() inherits the restricted environment", aborted(r), r.error)

local tmpf = os.tmpname()
local fh = assert(io.open(tmpf, "w"))
fh:write("debug.sethook() while true do end")
fh:close()
r = request("lua", { code = string.format("dofile(%q)", tmpf), maxMs = 200 })
check("dofile() inherits the restricted environment", aborted(r), r.error)
r = request("lua", { code = string.format("local f = assert(loadfile(%q)) f()", tmpf), maxMs = 200 })
check("loadfile() inherits the restricted environment", aborted(r), r.error)
os.remove(tmpf)
resetBudget()

r = request("lua", { code = "return debug.gethook(), debug.getregistry, debug.getupvalue, debug.setupvalue, debug.upvaluejoin" })
check("debug introspection that could reach the hook is withheld",
  r.ok and r.result.values[1] == "<nil>" and r.result.values[2] == "<nil>" and r.result.values[3] == "<nil>"
    and r.result.values[4] == "<nil>" and r.result.values[5] == "<nil>", json.encode(r))

r = request("lua", { code = "local co = coroutine.create(function() while true do end end) local ok, e = coroutine.resume(co) return ok, e", maxSteps = 50000 })
check("child coroutine is budgeted", r.ok == false and r.error:find("budget exceeded"), json.encode(r))
r = request("lua", { code = "local f = coroutine.wrap(function() while true do end end) f()", maxSteps = 50000 })
check("coroutine.wrap is budgeted", r.ok == false and r.error:find("budget exceeded"), json.encode(r))
r = request("lua", { code = "while true do local co = coroutine.create(function() while true do end end) pcall(coroutine.resume, co) end", maxSteps = 50000 })
check("parent resuming exhausted children in pcall still aborts", r.ok == false and r.error:find("budget exceeded"), json.encode(r))
r = request("lua", { code = "local f = coroutine.wrap(function(a) local b = coroutine.yield(a + 1) return b * 2 end) return f(1), f(10)" })
check("wrapped coroutines still pass values in and out", r.ok and r.result.values[1] == 2 and r.result.values[2] == 20, json.encode(r))

-- A script that mostly yields executes few VM instructions; the deadline is checked between resumes.
_G.FAKE_CLOCK_OFFSET = 0
r = request("lua", { code = "for i = 1, 4 do coroutine.yield() end return 'done'", maxMs = 1200 }, 0.5)
check("yield-heavy script hits the wall-clock budget between resumes", r.ok == false and r.error:find("ran longer than 1200 ms"), json.encode(r))
_G.FAKE_CLOCK_OFFSET = 0
r = request("lua", { code = "coroutine.yield() return 'done'", maxMs = 1200 }, 0.5)
check("yield-heavy script within budget succeeds", r.ok and r.result.values[1] == "done", json.encode(r))
-- The deadline is also checked before a result is returned (the hook fires only every 1000 instructions).
_G.FAKE_CLOCK_OFFSET = 0
r = request("lua", { code = "FAKE_CLOCK_OFFSET = 10 return 'late'", maxMs = 1000 })
check("a script that finishes past its deadline is reported as exceeded", r.ok == false and r.error:find("ran longer than 1000 ms"), json.encode(r))
_G.FAKE_CLOCK_OFFSET = 0

r = request("lua", { code = "my_bridge_test_global = 42 return 1" })
r = request("lua", { code = "return my_bridge_test_global" })
check("globals defined by scripts still persist", r.ok and r.result.values[1] == 42, json.encode(r))
r = request("lua", { code = "return type(debug.traceback), type(coroutine.yield), type(Echo), type(string.rep)" })
check("normal libraries and console API remain available", r.ok and r.result.values[1] == "function" and r.result.values[3] == "function", json.encode(r))
check("no hook on the bridge thread after hardening tests", debug.gethook() == nil)

-------------------------------------------------------------------------------
-- Plugin-thread execution: console context, hook swap and restore
-------------------------------------------------------------------------------
-- grandMA3 binds the plugin context to the plugin's own thread; a chunk run in a child coroutine
-- cannot see it. This stub returns a value only when called on the thread that handles the request.
do
  local requestThread = nil
  _G.ContextBoundStub = function()
    if coroutine.running() == requestThread then return 42 end
    return nil
  end
  local function requestOn(op, args, beforeResume)
    local line = json.encode({ id = "t", op = op, args = args })
    local co = coroutine.create(function()
      requestThread = coroutine.running()
      return state._handleLine(nil, line)
    end)
    if beforeResume then beforeResume(co) end
    local ok, res = coroutine.resume(co)
    local frames = 0
    while ok and coroutine.status(co) == "suspended" do
      frames = frames + 1
      ok, res = coroutine.resume(co)
    end
    assert(ok, res)
    return json.decode(res), co, frames
  end

  local r = requestOn("lua", { code = "return ContextBoundStub()" })
  check("chunk runs on the request thread (context-bound API reachable)", r.ok and r.result.values[1] == 42, json.encode(r))
  r = requestOn("lua", { code = "coroutine.yield() return ContextBoundStub()" })
  check("still on the request thread after a yield", r.ok and r.result.values[1] == 42, json.encode(r))
  r = requestOn("lua", { code = "local co = coroutine.wrap(function() return ContextBoundStub() end) return co()" })
  check("a child coroutine the chunk creates has no context (documented limitation)", r.ok and r.result.values[1] == "<nil>", json.encode(r))

  -- A hook already present on the thread (the console's, on onPC) is replaced while the chunk runs
  -- and put back afterwards when it is a Lua hook. The budget is still enforced meanwhile.
  local fires = 0
  local function consoleHook() fires = fires + 1 end
  state.lua.maxSteps = 0
  local co
  r, co = requestOn("lua", { code = "while true do end", maxMs = 200 }, function(thread) debug.sethook(thread, consoleHook, "", 50000) end)
  check("budget enforced with a pre-existing hook on the thread", r.ok == false and r.error:find("ran longer than 200 ms"), r.error)
  local h, mask, count = debug.gethook(co)
  check("pre-existing Lua hook restored after the chunk", h == consoleHook and count == 50000, tostring(h) .. "/" .. tostring(count))
  resetBudget()
  r, co = requestOn("lua", { code = "local n = 0 for i = 1, 10 do n = n + i end return n" }, function(thread) debug.sethook(thread, consoleHook, "", 50000) end)
  h = debug.gethook(co)
  check("pre-existing hook restored after a successful chunk", r.ok and r.result.values[1] == 55 and h == consoleHook, json.encode(r))
  r, co = requestOn("lua", { code = "return 1" })
  check("no hook left on a thread that had none", r.ok and debug.gethook(co) == nil)

  -- Once exceeded, the hook raises only in submitted code: the bridge's own handling after the
  -- error completes normally and the thread is clean.
  state.lua.maxSteps = 0
  r, co = requestOn("lua", { code = "while true do pcall(function() while true do end end) end", maxMs = 200 })
  check("exceeded budget never raises inside the bridge", r.ok == false and r.error:find("budget exceeded") and debug.gethook(co) == nil, r.error)
  resetBudget()

  r = requestOn("ping", {})
  check("ping reports the hook found on the plugin thread", r.ok and type(r.result.lua.consoleHook) == "string" and r.result.lua.consoleHook:find("none"), json.encode(r.result.lua))
  _G.ContextBoundStub = nil
end

-------------------------------------------------------------------------------
-- Runtime toggles and Cleanup semantics
-------------------------------------------------------------------------------
Main(nil, "lua off")
r = request("lua", { code = "1" })
check("'lua off' disables while running", r.ok == false and r.error:find("disabled"), r.error)
r = request("ping", {})
check("ping reflects the toggle", r.ok and r.result.lua.enabled == false, json.encode(r))

-- onPC calls Cleanup after every plugin invocation; control calls must not stop a running bridge.
state.running = true
Main(nil, "status")
Cleanup()
check("Cleanup after 'status' leaves the bridge running", state.running == true and state.stopRequested ~= true)
Main(nil, "lua on")
Cleanup()
check("Cleanup after 'lua on' leaves the bridge running", state.running == true and state.stopRequested ~= true)
Main(nil, "bogus")
Cleanup()
check("Cleanup after a rejected argument leaves the bridge running", state.running == true and state.stopRequested ~= true)
Main(nil, "9802")
check("port change refused while running", lastLog():find("already running"), lastLog())
Cleanup()
check("Cleanup after a refused port change leaves the bridge running", state.running == true and state.stopRequested ~= true)
state.running = false
Cleanup()
check("Cleanup after the owning call still tears down", state.stopRequested == true and state.running == false)
state.stopRequested = false
state.running = true

Main(nil, "lua on luatime=0 luasteps=0")
r = request("lua", { code = "local n=0 for i=1,2e6 do n=n+1 end return n" })
check("0 means unlimited", r.ok and r.result.values[1] == 2000000, json.encode(r))

-------------------------------------------------------------------------------
-- Start-argument parsing (bind is stubbed to fail, so serverMain returns at once)
-------------------------------------------------------------------------------
local function start(argument)
  state.running = false
  Main(nil, argument)
end
start("9801 lua luatime=2000 luasteps=5000000")
check("start tokens parsed", state.port == 9801 and state.lua.enabled == true and state.lua.maxMs == 2000 and state.lua.maxSteps == 5000000, json.encode(state.lua))
start("")
check("plain start resets policy to disabled", state.port == 9800 and state.lua.enabled == false and state.lua.maxMs == 5000, json.encode(state.lua))
start("lua=on")
check("lua=on accepted", state.lua.enabled == true)
start("lua off")
check("'lua off' at start keeps Lua disabled", state.lua.enabled == false)
start("nolua")
check("nolua accepted", state.lua.enabled == false)
start("lua=maybe")
check("lua=maybe refused", lastLog():find("expected lua=on or lua=off") and state.running == false, lastLog())
start("0.0.0.0:9800")
check("bind address refused", lastLog():find("looks like a bind address") and state.running == false, lastLog())
start("70000")
check("out-of-range port refused", lastLog():find("not a valid port"), lastLog())
start("bogus")
check("unknown token refused", lastLog():find("not a recognised argument"), lastLog())
start("luatime=abc")
check("bad budget refused", lastLog():find("non%-negative integer"), lastLog())
start("luasteps=1.5")
check("fractional budget refused", lastLog():find("non%-negative integer"), lastLog())
Main(nil, "status")
check("status shows policy", lastLog():find("lua=disabled"), lastLog())
Main(nil, "stop")
check("stop when not running is reported", lastLog():find("not running"), lastLog())

-------------------------------------------------------------------------------
-- Loopback-only binding and peer rejection
-------------------------------------------------------------------------------
-- socket.bind is stubbed to hand back a fake listening socket that produces one non-loopback
-- client and then asks the loop to stop, so serverMain runs a full accept/reject cycle.
do
  local bindCalls = {}
  local fakeClientClosed = false
  local fakeClient = {
    settimeout = function() end,
    setoption = function() end,
    getpeername = function() return "10.1.2.3", 51000 end,
    receive = function() return nil, "timeout", "" end,
    send = function(_, data) return #data end,
    close = function() fakeClientClosed = true end,
  }
  local accepts = 0
  local fakeServer = {
    settimeout = function() end,
    accept = function()
      accepts = accepts + 1
      if accepts == 1 then return fakeClient end
      state.stopRequested = true
      return nil
    end,
    close = function() end,
  }
  local realBind = require("socket").bind
  require("socket").bind = function(host, port)
    bindCalls[#bindCalls + 1] = { host = host, port = port }
    return fakeServer
  end
  state.running = false
  local co = coroutine.create(function() Main(nil, "9803") end)
  local ok, err = coroutine.resume(co)
  local frames = 0
  while ok and coroutine.status(co) == "suspended" and frames < 100 do
    frames = frames + 1
    ok, err = coroutine.resume(co)
  end
  assert(ok, err)
  check("bridge binds to 127.0.0.1 only", #bindCalls == 1 and bindCalls[1].host == "127.0.0.1" and bindCalls[1].port == 9803, json.encode(bindCalls))
  local rejected = false
  for _, l in ipairs(logs) do if l:find("rejected connection from 10.1.2.3") then rejected = true end end
  check("non-loopback peer is rejected and logged", rejected and fakeClientClosed, lastLog())
  check("rejected peer is not kept as a client", #state.clients == 0, #state.clients)
  check("server loop stopped cleanly", state.running == false and state.stopRequested == false)
  require("socket").bind = realBind
end

do
  -- A bind address argument is refused before any bind is attempted.
  local bindCalls = 0
  local realBind = require("socket").bind
  require("socket").bind = function() bindCalls = bindCalls + 1; return nil, "stub" end
  state.running = false
  Main(nil, "192.168.1.10:9800")
  check("host:port argument never reaches bind", bindCalls == 0 and lastLog():find("looks like a bind address"), lastLog())
  require("socket").bind = realBind
end

-------------------------------------------------------------------------------
-- Structured inspection ops (FR-07 .. FR-10) against a small fake show
-------------------------------------------------------------------------------
-- The plugin treats userdata as object handles, so fake handles are userdata (temporary file
-- objects re-metatabled per object) whose metatable dispatches to a table of properties and methods.
do
  local registry = setmetatable({}, { __mode = "k" })
  local fileMeta = getmetatable(io.stdout)
  local handleMeta = {}
  handleMeta.__gc = fileMeta and fileMeta.__gc
  handleMeta.__close = fileMeta and fileMeta.__close
  handleMeta.__name = "FakeHandle"
  handleMeta.__tostring = function(u) return "FakeHandle(" .. tostring(registry[u] and registry[u].name) .. ")" end
  local methods = {}
  handleMeta.__index = function(u, key)
    local def = registry[u]
    if not def then return nil end
    if methods[key] then return methods[key] end
    if key == "name" then return def.name end
    local v = def.props[tostring(key):lower()]
    return v
  end
  function methods.Get(u, name, role)
    local def = registry[u]
    local v = def.props[tostring(name):lower()]
    if v == nil and methods[name] then return methods[name] end  -- the console hands back a method for a method name
    return v
  end
  function methods.Children(u) return registry[u].children end
  function methods.GetClass(u) return registry[u].class end
  function methods.Addr(u) return registry[u].addr end
  function methods.AddrNative(u) return registry[u].addrNative or ("Fake." .. tostring(registry[u].name)) end
  function methods.Index(u) return registry[u].index or 1 end
  function methods.Parent(u) return registry[u].parent end
  function methods.Count(u) return #registry[u].children end
  function methods.PropertyCount(u) return 0 end
  function methods.Dump(u) return "fake dump" end

  local function H(def)
    local u = io.tmpfile()
    debug.setmetatable(u, handleMeta)
    def.props = def.props or {}
    local lowered = {}
    for k, v in pairs(def.props) do lowered[tostring(k):lower()] = v end
    def.props = lowered
    def.children = def.children or {}
    for i, c in ipairs(def.children) do
      local cd = registry[c]
      cd.parent = u
      if cd.index == nil then cd.index = i end
    end
    registry[u] = def
    return u
  end

  -- Attribute definitions -------------------------------------------------
  local fgDimmer = H({ name = "Dimmer", class = "FeatureGroup" })
  local fgPosition = H({ name = "Position", class = "FeatureGroup" })
  local fgColor = H({ name = "Color", class = "FeatureGroup" })
  local fgGobo = H({ name = "Gobo", class = "FeatureGroup" })
  local fgBeam = H({ name = "Beam", class = "FeatureGroup" })
  local function feature(name, group) local f = H({ name = name, class = "Feature" }); registry[f].parent = group; return f end
  local featDimmer, featPanTilt, featRGB, featGobo, featShutter = feature("Dimmer", fgDimmer), feature("PanTilt", fgPosition), feature("RGB", fgColor), feature("Gobo", fgGobo), feature("Shutter", fgBeam)
  local agPanTilt = H({ name = "PanTilt", class = "ActivationGroup" })
  local agRGB = H({ name = "ColorRGB", class = "ActivationGroup" })
  local attrs = {}
  local function attr(name, idx, pretty, feat, ag, unit, readout, color)
    attrs[name] = H({ name = name, class = "Attribute", props = { AttributeIndex = tostring(idx), Pretty = pretty, Feature = feat, ActivationGroup = ag, PhysicalUnit = unit, NaturalReadout = readout, Color = color } })
    return attrs[name]
  end
  attr("Dimmer", 0, "Dim", featDimmer, nil, "LuminousIntensity", "Percent")
  attr("Pan", 1, "P", featPanTilt, agPanTilt, "Angle", "Physical")
  attr("Tilt", 2, "T", featPanTilt, agPanTilt, "Angle", "Physical")
  attr("Gobo1", 20, "G1", featGobo, nil, "None", "Percent")
  attr("ColorRGB_R", 106, "R", featRGB, agRGB, "ColorComponent", "Percent", "1,0,0,1")
  attr("ColorRGB_G", 107, "G", featRGB, agRGB, "ColorComponent", "Percent", "0,1,0,1")
  attr("ColorRGB_B", 108, "B", featRGB, agRGB, "ColorComponent", "Percent", "0,0,1,1")
  attr("Shutter1", 149, "Sh1", featShutter, nil, "None", "Percent")

  -- Fixture types: DMXMode -> DMXChannels -> DMXChannel -> LogicalChannel -> ChannelFunction -> ChannelSet
  local function cf(name, attrName, dmxFrom, dmxTo, physFrom, physTo, sets)
    local children = {}
    for _, s in ipairs(sets or {}) do
      children[#children + 1] = H({ name = s[1], class = "ChannelSet", props = { DmxFrom = s[2], DmxTo = s[3], PhysicalFrom = s[4], PhysicalTo = s[5], WheelSlotIndex = s[6] } })
    end
    return H({ name = name, class = "ChannelFunction", children = children, props = { Attribute = attrs[attrName], DmxFrom = dmxFrom, DmxTo = dmxTo, Default = "000000", PhysicalFrom = physFrom, PhysicalTo = physTo, RealFade = "1.000" } })
  end
  local function dmxChannel(geometry, attrName, coarse, fine, functions)
    local logical = H({ name = attrName, class = "LogicalChannel", children = functions, props = { Attribute = attrs[attrName] } })
    return H({ name = geometry .. "_" .. attrName, class = "DMXChannel", children = { logical }, props = { DmxBreak = "1", Coarse = tostring(coarse), Fine = fine and tostring(fine) or "None", Ultra = "None", Default = "000000", Geometry = geometry, DefaultChannelFunction = functions[1] } })
  end
  local function mode(name, channels)
    local coll = H({ name = "DMXChannels", class = "DMXChannelCollect", children = channels })
    return H({ name = name, class = "DMXMode", children = { coll, H({ name = "Relations", class = "Collect" }) } })
  end
  local dimmerMode = mode("Mode 1", { dmxChannel("Main Module", "Dimmer", 1, nil, { cf("Dimmer 1", "Dimmer", "000000", "FFFFFF", "0.0", "1.0") }) })
  local rgbMode = mode("RGB", {
    dmxChannel("Main Module", "ColorRGB_R", 1, nil, { cf("ColorRGB_R 1", "ColorRGB_R", "000000", "FFFFFF", "0.0", "1.0") }),
    dmxChannel("Main Module", "ColorRGB_G", 2, nil, { cf("ColorRGB_G 1", "ColorRGB_G", "000000", "FFFFFF", "0.0", "1.0") }),
    dmxChannel("Main Module", "ColorRGB_B", 3, nil, { cf("ColorRGB_B 1", "ColorRGB_B", "000000", "FFFFFF", "0.0", "1.0") }),
  })
  local goboSets = { { "open", "000000", "0A0A0A", "0.0", "0.0", "1" }, { "gobo 1", "0B0B0B", "151515", "0.0", "0.0", "2" }, { "gobo 2", "161616", "FFFFFF", "0.0", "0.0", "3" } }
  local moverMode = mode("Standard", {
    dmxChannel("Main Module", "Pan", 1, 2, { cf("Pan 1", "Pan", "000000", "FFFFFF", "-270.0000000000", "270.0000000000") }),
    dmxChannel("Main Module", "Tilt", 3, 4, { cf("Tilt 1", "Tilt", "000000", "FFFFFF", "-135.0000000000", "135.0000000000") }),
    dmxChannel("Main Module", "Dimmer", 5, nil, { cf("Dimmer 1", "Dimmer", "000000", "FFFFFF", "0.0", "1.0") }),
    dmxChannel("Main Module", "Gobo1", 6, nil, { cf("Gobo1 1", "Gobo1", "000000", "FFFFFF", "0.0", "1.0", goboSets) }),
    dmxChannel("Main Module", "Shutter1", 7, nil, { cf("Shutter1 1", "Shutter1", "000000", "0F0F0F", "0.0", "0.0"), cf("Shutter1 Strobe", "Shutter1", "101010", "FFFFFF", "1.0", "20.0") }),
  })
  local washMode = mode("Pixel", {
    dmxChannel("Main Module", "Dimmer", 1, nil, { cf("Dimmer 1", "Dimmer", "000000", "FFFFFF", "0.0", "1.0") }),
    dmxChannel("Pixel", "ColorRGB_R", 2, nil, { cf("ColorRGB_R 1", "ColorRGB_R", "000000", "FFFFFF", "0.0", "1.0") }),
    dmxChannel("Pixel", "ColorRGB_G", 3, nil, { cf("ColorRGB_G 1", "ColorRGB_G", "000000", "FFFFFF", "0.0", "1.0") }),
    dmxChannel("Pixel", "ColorRGB_B", 4, nil, { cf("ColorRGB_B 1", "ColorRGB_B", "000000", "FFFFFF", "0.0", "1.0") }),
  })
  local function ftype(name, m) return H({ name = name, class = "FixtureType", children = { m } }) end
  local ftDimmer, ftRGB, ftMover, ftWash = ftype("Generic Dimmer", dimmerMode), ftype("LED Par", rgbMode), ftype("Spot 250", moverMode), ftype("Pixel Wash", washMode)
  -- A fixture type whose modes sit in a DMXModes collection (as on the console); its fixture's Mode property is text.
  local moverMode2 = mode("Standard", {
    dmxChannel("Main Module", "Pan", 1, 2, { cf("Pan 1", "Pan", "000000", "FFFFFF", "-270.0000000000", "270.0000000000") }),
    dmxChannel("Main Module", "Dimmer", 3, nil, { cf("Dimmer 1", "Dimmer", "000000", "FFFFFF", "0.0", "1.0") }),
  })
  local ftMover2 = H({ name = "Spot 250 B", class = "FixtureType", children = { H({ name = "DMXModes", class = "Collect", children = { H({ name = "Basic", class = "DMXMode" }), moverMode2 } }) } })
  local stripMode = mode("Cells", {
    dmxChannel("Main Module", "Shutter1", 1, nil, { cf("Shutter1 1", "Shutter1", "000000", "FFFFFF", "0.0", "0.0") }),
    dmxChannel("Cell", "Dimmer", 2, nil, { cf("Dimmer 1", "Dimmer", "000000", "FFFFFF", "0.0", "1.0") }),
  })
  local ftStrip = ftype("Strip", stripMode)

  -- Fixtures (FID deliberately differs from the patch index SubfixtureIndex) ----
  local function rt(index, fid, channel, coarse, fine)
    return H({ name = channel, class = "RTChannel", index = index, props = { INDEX = tostring(index), FID = tostring(fid), ChannelName = channel, Coarse = coarse, Fine = fine or "", Ultra = "", Default = "0" } })
  end
  local rtRows = {
    rt(0, 1, "Main Module_Dimmer", "1.001"),
    rt(1, 2, "Main Module_ColorRGB_R", "1.011"), rt(2, 2, "Main Module_ColorRGB_G", "1.012"), rt(3, 2, "Main Module_ColorRGB_B", "1.013"),
    rt(4, 3, "Main Module_Pan", "2.001", "2.002"), rt(5, 3, "Main Module_Tilt", "2.003", "2.004"), rt(6, 3, "Main Module_Dimmer", "2.005"), rt(7, 3, "Main Module_Gobo1", "2.006"), rt(8, 3, "Main Module_Shutter1", "2.007"),
    rt(9, 4, "Main Module_Dimmer", "3.001"),
    rt(10, 4, "Pixel_ColorRGB_R", "3.002"), rt(11, 4, "Pixel_ColorRGB_G", "3.003"), rt(12, 4, "Pixel_ColorRGB_B", "3.004"),
    rt(13, 4, "Pixel_ColorRGB_R", "3.005"), rt(14, 4, "Pixel_ColorRGB_G", "3.006"), rt(15, 4, "Pixel_ColorRGB_B", "3.007"),
    rt(16, 6, "Main Module_Pan", "2.011", "2.012"), rt(17, 6, "Main Module_Dimmer", "2.013"),
    rt(18, 7, "Main Module_Shutter1", "4.001"), rt(19, 7, "Cell_Dimmer", "4.002"),
  }
  local function fixture(def) return H(def) end
  local fxDimmer = fixture({ name = "Dimmer 1", class = "Fixture", addr = "14.9.7.1.2.1", props = { FID = "1", CID = "None", SubfixtureIndex = "1", FixtureType = ftDimmer, Mode = dimmerMode, Patch = "1.001", ChannelRTCount = "1" } })
  local fxRGB = fixture({ name = "Par 1", class = "Fixture", addr = "14.9.7.1.2.2", props = { FID = "2", CID = "None", SubfixtureIndex = "2", FixtureType = ftRGB, Mode = rgbMode, Patch = "1.011", ChannelRTCount = "3" } })
  local fxMover = fixture({ name = "Spot 1", class = "Fixture", addr = "14.9.7.1.2.3", props = { FID = "3", CID = "None", SubfixtureIndex = "3", FixtureType = ftMover, Mode = moverMode, Patch = "2.001", ChannelRTCount = "7" } })
  local sub1 = H({ name = "Wash 1.1", class = "SubFixture", addr = "14.9.7.1.2.4.1", props = { SubfixtureIndex = "5" } })
  local sub2 = H({ name = "Wash 1.2", class = "SubFixture", addr = "14.9.7.1.2.4.2", props = { SubfixtureIndex = "6" } })
  local fxWash = fixture({ name = "Wash 1", class = "Fixture", addr = "14.9.7.1.2.4", children = { sub1, sub2 }, props = { FID = "4", CID = "None", SubfixtureIndex = "4", FixtureType = ftWash, Mode = washMode, Patch = "3.001", ChannelRTCount = "7" } })
  local fxUnpatched = fixture({ name = "Spare", class = "Fixture", addr = "14.9.7.1.2.5", props = { FID = "5", CID = "None", SubfixtureIndex = "7", FixtureType = ftDimmer, Mode = dimmerMode, Patch = "", ChannelRTCount = "0" } })
  -- Mode is display text here (seen live on 2.5.1), FixtureType holds the DMXModes collection.
  local fxMover2 = fixture({ name = "Spot 2", class = "Fixture", addr = "14.9.7.1.2.6", props = { FID = "6", CID = "None", SubfixtureIndex = "8", FixtureType = ftMover2, Mode = "2 Standard", Patch = "2.011", ChannelRTCount = "2" } })
  local stripSub = H({ name = "Strip 1.1", class = "SubFixture", addr = "14.9.7.1.2.7.1", props = { SubfixtureIndex = "10" } })
  local fxStrip = fixture({ name = "Strip 1", class = "Fixture", addr = "14.9.7.1.2.7", children = { stripSub }, props = { FID = "7", CID = "None", SubfixtureIndex = "9", FixtureType = ftStrip, Mode = stripMode, Patch = "4.001", ChannelRTCount = "2" } })

  -- Patch index -> handle, UI channels (0-based) and RT channels per (sub)fixture
  -- Indices 8..10 exist for direct lookups only; GetSubfixtureCount stays 8 so the "all" scan covers 1..7.
  local bySfIndex = { [1] = fxDimmer, [2] = fxRGB, [3] = fxMover, [4] = fxWash, [5] = sub1, [6] = sub2, [7] = fxUnpatched, [8] = fxMover2, [9] = fxStrip, [10] = stripSub }
  local uiOf = { [1] = { 0 }, [2] = { 1, 2, 3 }, [3] = { 4, 5, 6, 7, 8 }, [4] = { 9 }, [5] = { 10, 11, 12 }, [6] = { 13, 14, 15 }, [7] = { 16 }, [8] = { 17, 18 }, [9] = { 19 }, [10] = { 20 } }
  local uiAttr = { [0] = "Dimmer", "ColorRGB_R", "ColorRGB_G", "ColorRGB_B", "Pan", "Tilt", "Dimmer", "Gobo1", "Shutter1", "Dimmer", "ColorRGB_R", "ColorRGB_G", "ColorRGB_B", "ColorRGB_R", "ColorRGB_G", "ColorRGB_B", "Dimmer", "Pan", "Dimmer", "Shutter1", "Dimmer" }
  local uiCf = { [0] = "Dimmer 1", "ColorRGB_R 1", "ColorRGB_G 1", "ColorRGB_B 1", "Pan 1", "Tilt 1", "Dimmer 1", "Gobo1 1", "Shutter1 1", "Dimmer 1", "ColorRGB_R 1", "ColorRGB_G 1", "ColorRGB_B 1", "ColorRGB_R 1", "ColorRGB_G 1", "ColorRGB_B 1", "Dimmer 1", "Pan 1", "Dimmer 1", "Shutter1 1", "Dimmer 1" }
  local function findCf(modeH, name)
    for _, dc in ipairs(registry[modeH].children[1] and registry[registry[modeH].children[1]].children or {}) do
      for _, lc in ipairs(registry[dc].children) do
        for _, f in ipairs(registry[lc].children) do if registry[f].name == name then return f end end
      end
    end
  end
  local uiMode = { [0] = dimmerMode, rgbMode, rgbMode, rgbMode, moverMode, moverMode, moverMode, moverMode, moverMode, washMode, washMode, washMode, washMode, washMode, washMode, washMode, dimmerMode, moverMode2, moverMode2, stripMode, stripMode }
  -- Subfixture 4.1 and Strip 1.1 have no RT channels of their own (as seen live); 4.2 keeps its own for the "own" path.
  local rtOf = { [1] = { rtRows[1] }, [2] = { rtRows[2], rtRows[3], rtRows[4] }, [3] = { rtRows[5], rtRows[6], rtRows[7], rtRows[8], rtRows[9] },
                 [4] = { rtRows[10], rtRows[11], rtRows[12], rtRows[13], rtRows[14], rtRows[15], rtRows[16] }, [5] = {}, [6] = { rtRows[14], rtRows[15], rtRows[16] }, [7] = {},
                 [8] = { rtRows[17], rtRows[18] }, [9] = { rtRows[19], rtRows[20] }, [10] = {} }
  local function sfIndexOf(x)
    if type(x) == "number" then return x end
    for i, h in pairs(bySfIndex) do if h == x then return i end end
    return nil
  end

  -- Sequence 10 with Cue 1 (two parts) and recipes -------------------------
  local presetRed = H({ name = "Red", class = "Preset", addr = "14.14.1.5.4.1", addrNative = "ShowData.DataPools.Default.PresetPools.Color.Red", props = { OwnDataPresent = "Yes" } })
  local recipe1 = H({ name = "[Group 1/Red]", class = "StandardRecipe", props = { Enabled = "Yes", Selection = "1 'All'", SelectionMode = "Strict", Preset = presetRed, Values = "", FadeX = "2.00", DelayX = "0.00", SpeedX = "60.00 BPM", PhaseX = "0 Thru 360" } })
  local recipe2 = H({ name = "[Group 2/missing]", class = "StandardRecipe", props = { Enabled = "No", Selection = "2 'Odd'", Preset = "4 'Color'.99", Values = "At Full " } })
  local part0 = H({ name = "0 'Look'", class = "Part", addr = "14.14.1.7.10.-1.0", children = { recipe1, recipe2 }, props = { Part = "0", CuePart = "1 P 0", CueFade = "3.00", CueDelay = "0.00", CueInFade = "3.00", CueInDelay = "0.00", CueOutFade = "CueTiming", CueOutDelay = "CueTiming", SnapDelay = "0.00", Command = "", CommandDelay = "0.00", CommandEnabled = "Yes", MibMode = "None", MibTarget = "", MibFade = "", MibDelay = "", OwnDataPresent = "No", OwnNonCookedDataPresent = "No", MemoryType = "Compressed", Transition = "Linear" } })
  local part1 = H({ name = "1 'Hard'", class = "Part", addr = "14.14.1.7.10.-1.1", props = { Part = "1", CuePart = "1 P 1", CueFade = "0.00", CueDelay = "1.50", OwnDataPresent = "Yes", OwnNonCookedDataPresent = "No", MemoryType = "Compressed", Command = "Go+ Sequence 11", CommandDelay = "2.00", CommandEnabled = "Yes" } })
  local cue1 = H({ name = "Look", class = "Cue", addr = "14.14.1.7.10.-1", children = { part0, part1 }, props = { No = "1", TrigType = "Go", TrigTime = "0.00", TrigSound = "None", Release = "Yes", Assert = "None", AllowDuplicates = "No", MibPreference = "Normal", Break = "", Note = "opening look" } })
  local seq10 = H({ name = "Show", class = "Sequence", addr = "14.14.1.7.10", children = { cue1 }, props = { Tracking = "Yes", Priority = "LTP" } })
  registry[part0].index = 0
  registry[part1].index = 1
  registry[recipe1].index = 1
  registry[recipe2].index = 2

  -- Universes --------------------------------------------------------------
  local universes = {}
  for i = 1, 8 do universes[i] = H({ name = "DmxUniverse " .. i, class = "DmxUniverse", index = i, props = { Granted = (i == 3) and "No" or "Yes", Request = "Auto", PortOut = "Yes", Used = tostring(i <= 3 and 1 or 0), CoarseParams = tostring(i <= 3 and 5 or 0), MergeMode = "Prio" } }) end
  local universePool = H({ name = "DmxUniverses", class = "DmxUniverseCollect", children = universes })
  methods.Ptr = function(u, n) return registry[u].children[n] end
  local patchH = H({ name = "LivePatch", class = "Patch", children = { universePool }, props = { DmxUniverses = universePool } })
  local dmx = { [1] = {}, [2] = {}, [3] = nil }
  for u = 1, 2 do for a = 1, 512 do dmx[u][a] = 0 end end
  dmx[1][1] = 255           -- Dimmer 1 full
  dmx[1][11], dmx[1][12], dmx[1][13] = 128, 0, 64
  dmx[2][1], dmx[2][2] = 0x80, 0x00   -- Pan 16-bit centre
  dmx[2][7] = 0x20          -- Shutter1 strobe range
  dmx[2][6] = 0x10          -- Gobo1 "gobo 1" set
  dmx[2][11], dmx[2][12], dmx[2][13] = 0xFF, 0xFF, 0x80   -- Spot 2: pan max, dimmer ~50 %
  dmx[4] = {}
  for a = 1, 512 do dmx[4][a] = 0 end
  dmx[4][2] = 200           -- Strip cell dimmer

  -- Programmer -------------------------------------------------------------
  local prog = {
    [0] = { fade = 0, delay = 0, speed = 0, phase = 0, mask_active_value = 1, mask_active_phaser = 0, mask_individual = 0, { channel_function = 0, absolute = 50, absolute_value = 8388607, relative = 0 } },
    [1] = { fade = 0, delay = 0, mask_active_value = 1, mask_active_phaser = 0, mask_individual = 0, { channel_function = 0, absolute = 0, absolute_value = 0, relative = 0 } },
    [6] = { fade = 1.5, delay = 0.25, speed = 60, phase = 0, measure = 0, gridpos = 0, mask_active_value = 1, mask_active_phaser = 2, mask_individual = 0,
            { channel_function = 0, absolute = 0, absolute_value = 0, relative = 0, accel = 0, decel = 0, trans = 100, width = 50 },
            { channel_function = 0, absolute = 100, absolute_value = 16777215, relative = 0, accel = 0, decel = 0, trans = 100, width = 50, integrated = presetRed } },
    [12] = { mask_active_value = 0, mask_active_phaser = 0, mask_individual = 0, { absolute = 33 } },   -- step data but inactive masks
  }
  local emptyPhaser = { mask_active_value = 0, mask_active_phaser = 0, mask_individual = 0 }

  -- Console API stubs -------------------------------------------------------
  local objectLists = {
    ["fixture 1"] = { fxDimmer }, ["fixture 2"] = { fxRGB }, ["fixture 3"] = { fxMover }, ["fixture 4"] = { fxWash }, ["fixture 4.1"] = { sub1 }, ["fixture 4.2"] = { sub2 }, ["fixture 5"] = { fxUnpatched },
    ["fixture 6"] = { fxMover2 }, ["fixture 7"] = { fxStrip }, ["fixture 7.1"] = { stripSub },
    ["fixture 1 thru 3"] = { fxDimmer, fxRGB, fxMover }, ["fixture 2 + 4"] = { fxRGB, fxWash }, ["fixture thru"] = { fxDimmer, fxRGB, fxMover, fxWash, fxUnpatched, fxMover2, fxStrip },
    ["group 1"] = { H({ name = "All", class = "Group" }) },
    ["sequence 10 cue 1"] = { cue1 }, ["sequence 10"] = { seq10 }, ["sequence 10 cue 1 part 0"] = { part0 },
  }
  for name, h in pairs(attrs) do objectLists['attribute "' .. name:lower() .. '"'] = { h } end
  local apiCalls = {}
  local function count(name) apiCalls[name] = (apiCalls[name] or 0) + 1 end
  ObjectList = function(ref) count("ObjectList"); return objectLists[tostring(ref):lower()] or {} end
  Patch = function() return patchH end
  GetSubfixtureCount = function() return 8 end
  GetSubfixture = function(i) count("GetSubfixture"); return bySfIndex[i] end
  GetUIChannels = function(x, asHandles) count("GetUIChannels"); local i = sfIndexOf(x); if not i then return nil end; local t = {}; for _, v in ipairs(uiOf[i] or {}) do t[#t + 1] = v end; return t end
  GetRTChannels = function(x, asHandles) count("GetRTChannels"); local i = sfIndexOf(x); if not i then return nil end; local t = {}; for _, v in ipairs(rtOf[i] or {}) do t[#t + 1] = v end; return t end
  GetAttributeIndex = function(name) local a = attrs[name]; return a and tonumber(registry[a].props.attributeindex) or nil end
  GetAttributeByUIChannel = function(ui) count("GetAttributeByUIChannel"); local n = uiAttr[ui]; return n and attrs[n] or nil end
  GetChannelFunction = function(ui, attrIdx) count("GetChannelFunction"); if uiAttr[ui] and GetAttributeIndex(uiAttr[ui]) ~= attrIdx then return nil end; return uiMode[ui] and findCf(uiMode[ui], uiCf[ui]) or nil end
  GetProgPhaser = function(ui, phaserOnly) count("GetProgPhaser"); return prog[ui] or emptyPhaser end
  SelectionTable = function() return { 1 } end
  GetDMXValue = function(addr, universe, percent) count("GetDMXValue"); local u = dmx[universe]; if not u then return nil end; local v = u[addr]; if v == nil then return nil end; return percent and math.floor(v / 255 * 100 + 0.5) or v end
  GetDMXUniverse = function(universe, percent) count("GetDMXUniverse"); local u = dmx[universe]; if not u then return nil end; local t = {}; for a = 1, 512 do t[a] = percent and math.floor(u[a] / 255 * 100 + 0.5) or u[a] end; return t end
  GetRTChannelCount = function() return #rtRows end
  GetPresetData = function(h, phasersOnly, byFixtures)
    count("GetPresetData")
    if h ~= presetRed then return nil end
    return { [1] = { fade = 0, { absolute = 100, absolute_value = 16777215 } }, [2] = { fade = 0, { absolute = 0 } }, [3] = { fade = 0, { absolute = 0 } },
             by_fixtures = { [2] = { fade = 0, { absolute = 100 }, { absolute = 50 } }, [4] = { fade = 0, { absolute = 20 } } } }
  end

  local savedGetUIChannels = GetUIChannels

  -- These ops must not be gated by the Lua execution policy.
  Main(nil, "lua off")
  check("inspection: Lua execution is off for this section", state.lua.enabled == false)

  local function has(list, pattern) for _, l in ipairs(list or {}) do if tostring(l):find(pattern) then return true end end return false end
  local function byAttr(rows, name) for _, r in ipairs(rows or {}) do if r.attribute == name then return r end end return nil end

  -- FR-07 fixtureAttributes ------------------------------------------------
  r = request("fixtureAttributes", { ref = "Fixture 1" })
  check("fixtureAttributes: dimmer-only fixture", r.ok and r.result.total == 1 and r.result.attributes[1].attribute == "Dimmer" and r.result.attributes[1].uiChannel == 0, json.encode(r))
  check("fixtureAttributes: source is the UI channel API", r.ok and r.result.source == "uiChannels", json.encode(r.result and r.result.source))
  check("fixtureAttributes: identity resolved by FID with separate patch index", r.ok and r.result.fid == "1" and r.result.subfixtureIndex == 1 and r.result.fixtureType == "Generic Dimmer" and r.result.mode == "Mode 1" and r.result.isSubfixture == false, json.encode(r))
  local dim = r.ok and r.result.attributes[1]
  check("fixtureAttributes: attribute metadata", dim and dim.attributeIndex == 0 and dim.pretty == "Dim" and dim.feature == "Dimmer" and dim.featureGroup == "Dimmer" and dim.physicalUnit == "LuminousIntensity" and dim.readout == "Percent", json.encode(dim))
  check("fixtureAttributes: channel function ranges", dim and dim.channelFunction == "Dimmer 1" and dim.dmxFrom == "000000" and dim.dmxTo == "FFFFFF" and dim.physicalFrom == 0 and dim.physicalTo == 1, json.encode(dim))
  check("fixtureAttributes: dmx mapping from RT channels", dim and dim.dmx and dim.dmx.coarse == "1.001" and dim.dmx.bits == 8 and dim.dmx.channel == "Main Module_Dimmer", json.encode(dim))
  check("fixtureAttributes: unavailable metadata is absent, never invented", dim and dim.activationGroup == nil and dim.channelSets == nil, json.encode(dim))
  check("fixtureAttributes: limitations array present", r.ok and type(r.result.limitations) == "table", json.encode(r))

  r = request("fixtureAttributes", { ref = "Fixture 2", includeChannelSets = true })
  check("fixtureAttributes: RGB fixture lists the three colour attributes", r.ok and r.result.total == 3 and byAttr(r.result.attributes, "ColorRGB_R") and byAttr(r.result.attributes, "ColorRGB_G") and byAttr(r.result.attributes, "ColorRGB_B"), json.encode(r))
  local red = r.ok and byAttr(r.result.attributes, "ColorRGB_R")
  check("fixtureAttributes: RGB metadata (activation group, emitter colour, 8-bit address)", red and red.activationGroup == "ColorRGB" and red.color == "1,0,0,1" and red.dmx.coarse == "1.011" and red.attributeIndex == 106, json.encode(red))
  check("fixtureAttributes: channel sets requested but none defined gives an empty array", red and type(red.channelSets) == "table" and #red.channelSets == 0, json.encode(red))

  r = request("fixtureAttributes", { ref = "Fixture 3", includeChannelSets = true })
  check("fixtureAttributes: moving light has five attributes", r.ok and r.result.total == 5, json.encode(r))
  local pan = r.ok and byAttr(r.result.attributes, "Pan")
  check("fixtureAttributes: 16-bit pan with physical range", pan and pan.physicalFrom == -270 and pan.physicalTo == 270 and pan.dmx.fine == "2.002" and pan.dmx.bits == 16 and pan.physicalUnit == "Angle", json.encode(pan))
  local gobo = r.ok and byAttr(r.result.attributes, "Gobo1")
  check("fixtureAttributes: channel sets with wheel slots", gobo and #gobo.channelSets == 3 and gobo.channelSets[2].name == "gobo 1" and gobo.channelSets[2].dmxFrom == "0B0B0B" and gobo.channelSets[2].wheelSlotIndex == 2, json.encode(gobo))
  local shutter = r.ok and byAttr(r.result.attributes, "Shutter1")
  check("fixtureAttributes: all channel functions of the logical channel are named", shutter and #shutter.channelFunctions == 2 and shutter.channelFunctions[2] == "Shutter1 Strobe", json.encode(shutter))
  r = request("fixtureAttributes", { ref = "Fixture 3", limit = 2, offset = 3 })
  check("fixtureAttributes: pagination", r.ok and r.result.total == 5 and r.result.count == 2 and r.result.offset == 3 and r.result.attributes[1].attribute == "Gobo1", json.encode(r))

  r = request("fixtureAttributes", { ref = "Fixture 4" })
  check("fixtureAttributes: compound fixture lists subfixtures explicitly", r.ok and r.result.subfixtureCount == 2 and r.result.subfixtures[1].name == "Wash 1.1" and r.result.subfixtures[1].subfixtureIndex == 5 and r.result.subfixtures[2].subfixtureIndex == 6, json.encode(r))
  check("fixtureAttributes: compound main fixture has only its own UI channel", r.ok and r.result.total == 1 and r.result.attributes[1].attribute == "Dimmer" and r.result.attributes[1].dmx.coarse == "3.001", json.encode(r))
  check("fixtureAttributes: full RT channel map includes the instance channels", r.ok and #r.result.channels == 7, json.encode(r.result and r.result.channels))
  r = request("fixtureAttributes", { ref = "Fixture 4.2" })
  check("fixtureAttributes: subfixture resolves through ObjectList", r.ok and r.result.class == "SubFixture" and r.result.isSubfixture == true and r.result.fixture == "Wash 1" and r.result.fid == "4" and r.result.subfixtureIndex == 6 and r.result.fixtureType == "Pixel Wash", json.encode(r))
  check("fixtureAttributes: subfixture attributes and addresses", r.ok and r.result.total == 3 and byAttr(r.result.attributes, "ColorRGB_B").dmx.coarse == "3.007" and byAttr(r.result.attributes, "ColorRGB_B").uiChannel == 15, json.encode(r))

  r = request("fixtureAttributes", { ref = "Fixture 5" })
  check("fixtureAttributes: unpatched fixture has attributes but no dmx mapping", r.ok and r.result.total == 1 and r.result.attributes[1].dmx == nil and #r.result.channels == 0 and has(r.result.limitations, "no RT channels"), json.encode(r))
  check("fixtureAttributes: own RT channels are labelled as such", r.ok and r.result.channelsSource == "own", json.encode(r.result and r.result.channelsSource))

  r = request("fixtureAttributes", { ref = "Fixture 4.1" })
  check("fixtureAttributes: subfixture without own RT channels points at the parent, not 'unpatched'",
    r.ok and r.result.total == 3 and #r.result.channels == 0 and r.result.channelsSource == nil and has(r.result.limitations, "available on the parent fixture 'Wash 1' %(Fixture 4%)")
      and has(r.result.limitations, "cannot be attributed") and not has(r.result.limitations, "unpatched"), json.encode(r))
  r = request("fixtureAttributes", { ref = "Fixture 7.1" })
  check("fixtureAttributes: subfixture channels taken from the parent when the attribute name is unique",
    r.ok and r.result.channelsSource == "parent" and #r.result.channels == 1 and r.result.channels[1].channel == "Cell_Dimmer" and r.result.attributes[1].dmx.coarse == "4.002"
      and has(r.result.limitations, "taken from its parent fixture 'Strip 1' %(Fixture 7%)"), json.encode(r))

  -- Mode given as display text: the DMXMode is found through FixtureType.DMXModes.
  r = request("fixtureAttributes", { ref = "Fixture 6" })
  check("fixtureAttributes: mode text resolved to the DMXMode name", r.ok and r.result.mode == "2 Standard" and r.result.total == 2 and r.result.source == "uiChannels", json.encode(r))
  GetUIChannels = nil
  r = request("fixtureAttributes", { ref = "Fixture 6" })
  GetUIChannels = savedGetUIChannels or GetUIChannels
  check("fixtureAttributes: walk fallback resolves the mode through FixtureType.DMXModes", r.ok and r.result.source == "fixtureTypeWalk" and r.result.total == 2 and byAttr(r.result.attributes, "Pan") ~= nil
    and byAttr(r.result.attributes, "Pan").dmx.coarse == "2.011" and not has(r.result.limitations, "no DMX mode handle"), json.encode(r))

  -- Fallback: without the UI channel API the fixture type is walked.
  GetUIChannels = nil
  r = request("fixtureAttributes", { ref = "Fixture 3", includeChannelSets = true })
  GetUIChannels = savedGetUIChannels
  check("fixtureAttributes: fixture-type walk fallback", r.ok and r.result.source == "fixtureTypeWalk" and r.result.total == 5 and has(r.result.limitations, "GetUIChannels unavailable"), json.encode(r))
  pan = r.ok and byAttr(r.result.attributes, "Pan")
  check("fixtureAttributes: walk rows carry mode offsets, no UI channel, and matched addresses", pan and pan.uiChannel == nil and pan.dmxChannel.name == "Main Module_Pan" and pan.dmxChannel.coarseOffset == "1" and pan.dmxChannel.fineOffset == "2" and pan.dmx.coarse == "2.001" and pan.physicalFrom == -270, json.encode(pan))
  gobo = r.ok and byAttr(r.result.attributes, "Gobo1")
  check("fixtureAttributes: walk rows include channel sets", gobo and gobo.channelSets and #gobo.channelSets == 3, json.encode(gobo))

  r = request("fixtureAttributes", { ref = "Group 1" })
  check("fixtureAttributes: non-fixture reference rejected", r.ok == false and r.error:find("not a Fixture"), json.encode(r))
  r = request("fixtureAttributes", { ref = "Fixture 99" })
  check("fixtureAttributes: unknown fixture rejected", r.ok == false and r.error:find("no object found"), json.encode(r))
  check("fixtureAttributes: nothing but reads were called", apiCalls.Cmd == nil)

  -- FR-08 programmer ---------------------------------------------------------
  r = request("programmer", { scope = "all" })
  check("programmer: scans every patch index with complete coverage", r.ok and r.result.coverage.complete == true and r.result.coverage.totalFixtures == 7 and r.result.coverage.scannedFixtures == 7 and r.result.coverage.scannedChannels == 17, json.encode(r.result and r.result.coverage))
  check("programmer: rows for selected and unselected fixtures", r.ok and r.result.total == 3 and r.result.rows[1].fid == "1" and r.result.rows[2].fid == "2" and r.result.rows[3].fid == "3", json.encode(r))
  local row1 = r.ok and r.result.rows[1]
  check("programmer: single value row", row1 and row1.attribute == "Dimmer" and row1.value == 50 and row1.valueRaw == 8388607 and row1.present == true and row1.stepCount == 1 and row1.phaser.supported == true and row1.phaser.multiStep == false, json.encode(row1))
  local row2 = r.ok and r.result.rows[2]
  check("programmer: zero value is present, not absent", row2 and row2.value == 0 and row2.present == true and row2.masks.activeValue == 1 and row2.attribute == "ColorRGB_R" and row2.subfixtureIndex == 2, json.encode(row2))
  local row3 = r.ok and r.result.rows[3]
  check("programmer: two-step phaser keeps every step", row3 and row3.stepCount == 2 and #row3.steps == 2 and row3.steps[1].absolute == 0 and row3.steps[2].absolute == 100 and row3.steps[2].width == 50 and row3.value == nil, json.encode(row3))
  check("programmer: phaser-level timing and integrated preset", row3 and row3.phaser.supported == true and row3.phaser.multiStep == true and row3.phaser.speed == 60 and row3.phaser.fade == 1.5 and row3.phaser.delay == 0.25 and row3.steps[2].integratedPreset.name == "Red", json.encode(row3))
  check("programmer: inactive masks with step data are not reported as values", r.ok and r.result.stats.channelsWithStepsButInactiveMask == 1 and has(r.result.limitations, "activity masks zero"), json.encode(r))
  check("programmer: source and note distinguish programmer from output", r.ok and r.result.source == "programmer" and r.result.note:find("not output"), json.encode(r))
  check("programmer: rows carry the channel function range and readout for unit-aware comparison",
    row1 and row1.physicalFrom == 0 and row1.physicalTo == 1 and row1.readout == "Percent" and row1.physicalUnit == "LuminousIntensity" and row1.channelFunction == "Dimmer 1", json.encode(row1))
  check("programmer: the scanned (sub)fixtures are listed with fid and name",
    r.ok and #r.result.scannedFixtures == 7 and r.result.scannedFixtures[1].fid == "1" and r.result.scannedFixtures[1].subfixtureIndex == 1 and r.result.scannedFixtures[1].name ~= nil and r.result.fixturesTruncated == false, json.encode(r.result and r.result.scannedFixtures))

  r = request("programmer", { scope = "selection" })
  check("programmer: selection scope only covers selected fixtures", r.ok and r.result.total == 1 and r.result.rows[1].fid == "1" and r.result.selectionCount == 1 and r.result.coverage.complete == true, json.encode(r))
  r = request("programmer", { scope = "fixtures", fixtures = "Fixture 2 + 4" })
  check("programmer: fixtures scope expands compound fixtures into subfixture indices", r.ok and r.result.coverage.totalFixtures == 4 and r.result.total == 1 and r.result.rows[1].fid == "2", json.encode(r))
  check("programmer: expanded cells carry the root fixture's FID", r.ok and #r.result.scannedFixtures == 4 and r.result.scannedFixtures[2].rootFid == "4" and r.result.scannedFixtures[3].rootFid == "4" and r.result.scannedFixtures[1].rootFid == "2", json.encode(r.result and r.result.scannedFixtures))
  r = request("programmer", { scope = "fixtures" })
  check("programmer: fixtures scope requires fixtures", r.ok == false and r.error:find("args.fixtures"), json.encode(r))
  r = request("programmer", { scope = "bogus" })
  check("programmer: unknown scope rejected", r.ok == false and r.error:find("scope"), json.encode(r))
  r = request("programmer", { scope = "all", limit = 1, offset = 1 })
  check("programmer: pagination", r.ok and r.result.total == 3 and r.result.count == 1 and r.result.rows[1].fid == "2", json.encode(r))
  r = request("programmer", { scope = "all", maxChannels = 2 })
  check("programmer: channel budget cuts the scan and reports incomplete coverage", r.ok and r.result.coverage.complete == false and r.result.coverage.scannedFixtures == 2 and r.result.coverage.scannedChannels == 4 and has(r.result.limitations, "channel budget"), json.encode(r))
  check("programmer: the fixture list only covers what was scanned", r.ok and #r.result.scannedFixtures == 2, json.encode(r.result and r.result.scannedFixtures))

  local savedProg = GetProgPhaser
  GetProgPhaser = function() return emptyPhaser end
  r = request("programmer", { scope = "all" })
  GetProgPhaser = savedProg
  check("programmer: empty programmer gives no rows with complete coverage", r.ok and r.result.total == 0 and #r.result.rows == 0 and r.result.coverage.complete == true, json.encode(r))
  local savedCount = GetSubfixtureCount
  GetSubfixtureCount = nil
  r = request("programmer", { scope = "all" })
  GetSubfixtureCount = savedCount
  check("programmer: scope that cannot be enumerated is incomplete, not empty", r.ok and r.result.coverage.complete == false and r.result.total == 0 and has(r.result.limitations, "could not be enumerated"), json.encode(r))
  local savedSel = SelectionTable
  SelectionTable = function() error("no context") end
  r = request("programmer", { scope = "selection" })
  SelectionTable = savedSel
  check("programmer: failing SelectionTable reports incomplete coverage", r.ok and r.result.coverage.complete == false and has(r.result.limitations, "selection could not be enumerated"), json.encode(r))

  -- FR-09 fixtureOutput ------------------------------------------------------
  r = request("fixtureOutput", { ref = "Fixture 1" })
  check("fixtureOutput: 8-bit dimmer output with physical conversion", r.ok and r.result.total == 1 and r.result.channels[1].value == 255 and r.result.channels[1].unit == "raw8" and r.result.channels[1].percent == 100 and r.result.channels[1].physical == 1 and r.result.channels[1].conversion == "linear from channel function" and r.result.channels[1].attribute == "Dimmer", json.encode(r))
  check("fixtureOutput: source and universe/address", r.ok and r.result.source == "dmx output" and r.result.channels[1].universe == 1 and r.result.channels[1].address == 1 and r.result.channels[1].patched == true, json.encode(r))
  check("fixtureOutput: programmer and output differ and are labelled", r.ok and r.result.channels[1].value == 255 and row1.value == 50 and r.result.source ~= "programmer", "programmer 50 % vs output 255")
  r = request("fixtureOutput", { ref = "Fixture 2" })
  check("fixtureOutput: zero output is a value", r.ok and r.result.total == 3 and r.result.channels[2].value == 0 and r.result.channels[2].percent == 0, json.encode(r))
  r = request("fixtureOutput", { ref = "Fixture 2", nonzeroOnly = true })
  check("fixtureOutput: nonzeroOnly drops zero rows", r.ok and r.result.total == 2 and r.result.channels[1].value == 128 and r.result.channels[2].value == 64 and r.result.nonzeroOnly == true, json.encode(r))
  r = request("fixtureOutput", { ref = "Fixture 3" })
  check("fixtureOutput: second universe and 16-bit combination", r.ok and r.result.channels[1].universe == 2 and r.result.channels[1].value == 32768 and r.result.channels[1].bits == 16 and r.result.channels[1].unit == "raw16" and r.result.channels[1].coarseValue == 128 and r.result.channels[1].fineValue == 0, json.encode(r.result and r.result.channels[1]))
  check("fixtureOutput: 16-bit physical conversion is near centre", r.ok and math.abs(r.result.channels[1].physical) < 0.01, json.encode(r.result and r.result.channels[1].physical))
  local shutterRow = r.ok and r.result.channels[5]
  check("fixtureOutput: channel function chosen by DMX range", shutterRow and shutterRow.value == 32 and shutterRow.channelFunction == "Shutter1 Strobe" and shutterRow.physicalFrom == 1 and shutterRow.physicalTo == 20, json.encode(shutterRow))
  local goboRow = r.ok and r.result.channels[4]
  check("fixtureOutput: channel set named for the value", goboRow and goboRow.value == 16 and goboRow.channelSet == "gobo 1", json.encode(goboRow))
  r = request("fixtureOutput", { ref = "Fixture 4" })
  check("fixtureOutput: universe not granted gives null values and a limitation", r.ok and r.result.total == 7 and r.result.channels[1].value == nil and r.result.channels[1].patched == true and has(r.result.limitations, "universe 3 not granted"), json.encode(r))
  r = request("fixtureOutput", { ref = "Fixture 5" })
  check("fixtureOutput: unpatched fixture reports no RT channels", r.ok and r.result.total == 0 and has(r.result.limitations, "no RT channels"), json.encode(r))
  r = request("fixtureOutput", { ref = "Fixture 6" })
  check("fixtureOutput: attribute and physical conversion through the UI channel path when the mode is text",
    r.ok and r.result.metaSource == "uiChannels+fixtureTypeWalk" and r.result.channels[1].attribute == "Pan" and r.result.channels[1].value == 65535 and r.result.channels[1].physical == 270
      and r.result.channels[2].attribute == "Dimmer" and r.result.channels[2].conversion == "linear from channel function" and not has(r.result.limitations, "could not be walked"), json.encode(r))
  GetUIChannels = nil
  r = request("fixtureOutput", { ref = "Fixture 6" })
  GetUIChannels = savedGetUIChannels
  check("fixtureOutput: walk-only metadata when the UI channel API is missing", r.ok and r.result.metaSource == "fixtureTypeWalk" and r.result.channels[1].attribute == "Pan" and r.result.channels[1].physical == 270, json.encode(r))
  local savedFT = registry[fxMover2].props.fixturetype
  registry[fxMover2].props.fixturetype = nil
  GetUIChannels = nil
  r = request("fixtureOutput", { ref = "Fixture 6" })
  GetUIChannels = savedGetUIChannels
  registry[fxMover2].props.fixturetype = savedFT
  check("fixtureOutput: limitation only when neither path works", r.ok and r.result.metaSource == nil and r.result.channels[1].attribute == nil and r.result.channels[1].value == 65535 and has(r.result.limitations, "neither the UI channel API nor the fixture type walk"), json.encode(r))
  r = request("fixtureOutput", { ref = "Fixture 7.1" })
  check("fixtureOutput: subfixture output read through the parent's uniquely matched channel", r.ok and r.result.channelsSource == "parent" and r.result.total == 1 and r.result.channels[1].channel == "Cell_Dimmer" and r.result.channels[1].value == 200 and r.result.channels[1].attribute == "Dimmer" and has(r.result.limitations, "taken from its parent"), json.encode(r))
  r = request("fixtureOutput", { ref = "Fixture 4.1" })
  check("fixtureOutput: subfixture with ambiguous parent channels reports where the addresses are", r.ok and r.result.total == 0 and has(r.result.limitations, "available on the parent fixture") and not has(r.result.limitations, "unpatched"), json.encode(r))
  r = request("fixtureOutput", { ref = "Fixture 3", limit = 2, offset = 2 })
  check("fixtureOutput: pagination", r.ok and r.result.total == 5 and r.result.count == 2 and r.result.channels[1].channel == "Main Module_Dimmer", json.encode(r))
  check("fixtureOutput: cooked-output limitation always stated", r.ok and has(r.result.limitations, "cooked output"), json.encode(r))

  -- FR-09 dmx ----------------------------------------------------------------
  r = request("dmx", { universe = 1, from = 1, to = 16 })
  check("dmx: raw universe read through GetDMXUniverse", r.ok and r.result.granted == true and r.result.readVia == "GetDMXUniverse" and r.result.unit == "raw8" and r.result.count == 16 and r.result.values[1].value == 255 and r.result.values[2].value == 0 and r.result.values[11].value == 128, json.encode(r))
  check("dmx: universe metadata and source", r.ok and r.result.universeInfo.granted == true and r.result.source == "dmx output" and has(r.result.limitations, "patch lookup not performed"), json.encode(r))
  r = request("dmx", { universe = 1, from = 1, to = 16, nonzeroOnly = true })
  check("dmx: nonzeroOnly", r.ok and r.result.count == 3 and r.result.values[2].channel == 11 and r.result.values[3].channel == 13, json.encode(r))
  r = request("dmx", { universe = 2, from = 1, to = 2, percent = true })
  check("dmx: percent unit on a second universe", r.ok and r.result.unit == "percent" and r.result.values[1].value == 50 and r.result.universe == 2, json.encode(r))
  r = request("dmx", { universe = 3, from = 1, to = 4 })
  check("dmx: not granted universe gives no values and granted=false", r.ok and r.result.granted == false and r.result.count == 0 and has(r.result.limitations, "universe 3 not granted"), json.encode(r))
  r = request("dmx", { universe = 1, from = 1, to = 13, patched = true })
  check("dmx: patch lookup maps addresses to fixtures", r.ok and r.result.patched == "rtChannels" and r.result.values[1].patched.fid == "1" and r.result.values[1].patched.channel == "Main Module_Dimmer" and r.result.values[1].patched.part == "coarse" and r.result.values[2].patched == false and r.result.values[11].patched.fid == "2", json.encode(r))
  r = request("dmx", { universe = 2, from = 2, to = 2, patched = true })
  check("dmx: fine address identified", r.ok and r.result.values[1].patched.part == "fine" and r.result.values[1].patched.fid == "3", json.encode(r))
  r = request("dmx", { universe = 0, from = 1, to = 1 })
  check("dmx: universe below range rejected", r.ok == false and r.error:find("between 1 and 8"), json.encode(r))
  r = request("dmx", { universe = 1, from = 0, to = 1 })
  check("dmx: channel below range rejected", r.ok == false and r.error:find("between 1 and 512"), json.encode(r))
  r = request("dmx", { universe = 1, from = 10, to = 513 })
  check("dmx: channel above range rejected", r.ok == false and r.error:find("between 1 and 512"), json.encode(r))
  r = request("dmx", { universe = 1, from = 10, to = 5 })
  check("dmx: from > to rejected", r.ok == false and r.error:find("from must be <= "), json.encode(r))
  local savedUniverse = GetDMXUniverse
  GetDMXUniverse = nil
  r = request("dmx", { universe = 1, from = 11, to = 13 })
  GetDMXUniverse = savedUniverse
  check("dmx: per-address fallback when GetDMXUniverse is missing", r.ok and r.result.readVia == "GetDMXValue" and r.result.granted == true and r.result.count == 3 and r.result.values[1].value == 128, json.encode(r))

  -- FR-10 cueContents --------------------------------------------------------
  r = request("cueContents", { sequence = 10, cue = 1 })
  check("cueContents: cue properties", r.ok and r.result.cue.no == "1" and r.result.cue.name == "Look" and r.result.cue.trigType == "Go" and r.result.cue.trigTime == "0.00" and r.result.cue.release == "Yes" and r.result.cue.note == "opening look" and r.result.cue.partCount == 2, json.encode(r))
  check("cueContents: sequence context and tracking flag", r.ok and r.result.sequence.name == "Show" and r.result.sequence.tracking == "Yes" and r.result.trackedValues == "not_reconstructed", json.encode(r))
  local p0 = r.ok and r.result.parts[1]
  check("cueContents: part timing", p0 and p0.part == 0 and p0.timing.cueFade == "3.00" and p0.timing.cueOutFade == "CueTiming" and p0.timing.snapDelay == "0.00" and p0.command.enabled == true and p0.mib.mode == "None", json.encode(p0))
  check("cueContents: recipe with a resolved preset reference", p0 and #p0.recipes == 2 and p0.recipes[1].selection == "1 'All'" and p0.recipes[1].presetResolved == true and p0.recipes[1].presetRef.addrNative == "ShowData.DataPools.Default.PresetPools.Color.Red" and p0.recipes[1].fadeX == "2.00" and p0.recipes[1].speedX == "60.00 BPM" and p0.recipes[1].enabled == true, json.encode(p0))
  check("cueContents: unresolved preset reference marked explicitly", p0 and p0.recipes[2].presetResolved == false and p0.recipes[2].preset == "4 'Color'.99" and p0.recipes[2].presetRef == nil and has(r.result.limitations, "did not resolve"), json.encode(p0))
  check("cueContents: own data flag without stored values", p0 and p0.ownDataPresent == false and p0.storedValues == nil, json.encode(p0))
  local p1 = r.ok and r.result.parts[2]
  check("cueContents: second part with hard values yields the limitation", p1 and p1.part == 1 and p1.ownDataPresent == true and p1.timing.cueDelay == "1.50" and p1.command.text == "Go+ Sequence 11" and has(r.result.limitations, "hard %(non%-recipe%) fixture values"), json.encode(r))
  check("cueContents: presets not expanded by default", r.ok and r.result.presets == nil and r.result.expandPresets == false, json.encode(r))
  check("cueContents: tracked value limitation stated", r.ok and has(r.result.limitations, "tracked values are not reconstructed"), json.encode(r))

  r = request("cueContents", { sequence = 10, cue = 1, part = 1 })
  check("cueContents: part filter", r.ok and #r.result.parts == 1 and r.result.parts[1].part == 1, json.encode(r))
  r = request("cueContents", { sequence = 10, cue = 1, part = 7 })
  check("cueContents: missing part rejected", r.ok == false and r.error:find("has no Part 7"), json.encode(r))
  r = request("cueContents", { ref = "Sequence 10 Cue 1 Part 0" })
  check("cueContents: a part reference is not a cue", r.ok == false and r.error:find("not a Cue"), json.encode(r))
  r = request("cueContents", { sequence = 10, cue = 99 })
  check("cueContents: unknown cue rejected", r.ok == false and r.error:find("no object found"), json.encode(r))

  r = request("cueContents", { sequence = 10, cue = 1, expandPresets = true })
  local pd = r.ok and r.result.presets and r.result.presets["ShowData.DataPools.Default.PresetPools.Color.Red"]
  check("cueContents: expanded preset data keyed by preset address", pd and pd.available == true and pd.source == "GetPresetData" and pd.preset.name == "Red" and pd.byFixturesPresent == true, json.encode(r.result and r.result.presets))
  check("cueContents: preset rows flattened per step with fid and ui channel keys", pd and pd.count == 6 and (function()
    local byFid, byUi = 0, 0
    for _, row in ipairs(pd.rows) do if row.fid then byFid = byFid + 1 end if row.uiChannel then byUi = byUi + 1 end end
    return byFid == 3 and byUi == 3
  end)(), json.encode(pd))
  check("cueContents: recipe points at its preset data", r.ok and r.result.parts[1].recipes[1].presetDataKey == "ShowData.DataPools.Default.PresetPools.Color.Red", json.encode(r.result.parts[1].recipes[1]))
  r = request("cueContents", { sequence = 10, cue = 1, expandPresets = true, fixtures = "Fixture 2" })
  pd = r.ok and r.result.presets and r.result.presets["ShowData.DataPools.Default.PresetPools.Color.Red"]
  check("cueContents: fixtures filter applies to by_fixtures rows", pd and pd.filterApplied == "by_fixtures" and pd.count == 2 and pd.rows[1].fid == "2" and pd.rows[2].fid == "2" and pd.rows[2].step == 2 and pd.rows[2].absolute == 50, json.encode(pd))
  check("cueContents: fixtures filter scope is stated", r.ok and has(r.result.limitations, "fixtures filter applied to expanded preset data"), json.encode(r.result.limitations))
  r = request("cueContents", { sequence = 10, cue = 1, fixtures = "Fixture 2" })
  check("cueContents: fixtures filter without expansion is reported as not applied", r.ok and has(r.result.limitations, "fixtures filter not applied"), json.encode(r.result.limitations))
  check("cueContents: no mutating API was called", apiCalls.Cmd == nil and apiCalls.Set == nil)

  -- The probe's childSummary bug: a field naming a method must not come back as "<function>".
  r = request("objects", { ref = "Sequence 10 Cue 1", fields = { "Count", "No" } })
  check("objects: a field that names a method is refused, not called", r.ok and r.result.items[1].fields.Count == nil and r.result.items[1].fields.No == "1", json.encode(r))

  check("inspection ops never touched Lua execution policy", state.lua.enabled == false)
end

-------------------------------------------------------------------------------
-- Line handler robustness
-------------------------------------------------------------------------------
local raw = json.decode(state._handleLine(nil, "not json"))
check("invalid JSON rejected", raw.ok == false and raw.error:find("invalid JSON"), json.encode(raw))
raw = json.decode(state._handleLine(nil, '{"id":"x","op":"nope"}'))
check("unknown op rejected with id echoed", raw.ok == false and raw.id == "x" and raw.error:find("unknown op"), json.encode(raw))

print(string.format("%d passed, %d failed", passes, failures))
print(failures == 0 and "ALL PASSED" or "FAILED")
os.exit(failures == 0 and 0 or 1)
