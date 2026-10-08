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
-- Line handler robustness
-------------------------------------------------------------------------------
local raw = json.decode(state._handleLine(nil, "not json"))
check("invalid JSON rejected", raw.ok == false and raw.error:find("invalid JSON"), json.encode(raw))
raw = json.decode(state._handleLine(nil, '{"id":"x","op":"nope"}'))
check("unknown op rejected with id echoed", raw.ok == false and raw.id == "x" and raw.error:find("unknown op"), json.encode(raw))

print(string.format("%d passed, %d failed", passes, failures))
print(failures == 0 and "ALL PASSED" or "FAILED")
os.exit(failures == 0 and 0 or 1)
