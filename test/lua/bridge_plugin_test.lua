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
Enums = { PathType = { Temp = 1 }, VirtualKeyCode = { PLEASE = 84, STORE = 66 }, KeyboardCodes = { Enter = 257, S = 83, V = 86, W = 87, Q = 81, Z = 90, LeftShift = 340, RightShift = 344, A = 65 } }
-- Console keyboard stub for the KB-04 backend: records every Keyboard() call and keeps an aggregate MASTATE.
keyboardCalls = {}
fakeMaState = false
Keyboard = function(display, kind, key, shift, ctrl, alt, numlock)
  keyboardCalls[#keyboardCalls + 1] = { display = display, kind = kind, key = key, shift = shift, ctrl = ctrl, alt = alt, numlock = numlock }
  if key == "LeftShift" or key == "RightShift" then fakeMaState = (kind == "press") end
end
-- Fake user profile for the KB-03 tests: shortcut rows as the hardkeys consoleDeps read them.
local fakeProfile = { name = "Default", shortcutsActive = "true", rows = { { Shortcut = "Enter", KeyCode = 84 }, { Shortcut = "S", KeyCode = 66 } } }
CurrentProfile = function()
  return { name = fakeProfile.name, KeyboardShortCuts = {
    Get = function(_, k) if k == "KeyboardShortcutsActive" then return fakeProfile.shortcutsActive end end,
    -- KB-14: the one property the hardkeys module writes (strings, as the console reads them back).
    Set = function(_, k, v) if k == "KeyboardShortcutsActive" then fakeProfile.shortcutsActive = v and "true" or "false"; fakeProfile.writes = (fakeProfile.writes or 0) + 1 end end,
    Count = function() return #fakeProfile.rows end,
    Ptr = function(_, i) local row = fakeProfile.rows[i]; return row and { Get = function(_, k) return row[k] end } end } }
end
GetDisplayByIndex = function(n) if n == 1 then return {} end return nil end
BuildDetails = function() return {} end
Root = function() return { Get = function(_, k) if k == "MAState" then return fakeMaState end error("no console property " .. tostring(k)) end,
                           VirtualKeys = { Count = function() return 1 end, Ptr = function(_, i) return i == 1 and { Get = function(_, k) if k == "Code" then return "PLEASE" elseif k == "KeyCode" then return "Enter" end end } or nil end },
                           MANetSocket = { Get = function() return nil end }, maNetSocket = {} } end
CurrentUser = function() return nil end

-- The console runs every ComponentLua of a plugin with (pluginName, componentName, signalTable, handle)
-- and hands all of them the same signalTable; the KB-02 modules register themselves in it and the
-- bridge looks them up at start. The handle is only used for error detail (component present?).
local signals = {}
local function runComponent(name, file)
  local c = assert(loadfile(file))
  return c("gma3_mcp_bridge", name, signals, nil)
end
local hardkeysModule = runComponent("gma3_mcp_hardkeys", here .. "/../../plugin/gma3_mcp_hardkeys.lua")
local feedbackModule = runComponent("gma3_mcp_feedback", here .. "/../../plugin/gma3_mcp_feedback.lua")
local controlModule = runComponent("gma3_mcp_control", here .. "/../../plugin/gma3_mcp_control.lua")
local componentNames = { "gma3_mcp_bridge", "gma3_mcp_hardkeys", "gma3_mcp_feedback", "gma3_mcp_control" }
local pluginHandle = { name = "gma3_mcp_bridge", Count = function() return #componentNames end,
  Ptr = function(_, i) return componentNames[i] and { name = componentNames[i], Get = function(_, p) if p == "SyntaxError" then return false end end } end }
local componentHandle = { name = "gma3_mcp_bridge", Parent = function() return pluginHandle end }

local chunk = assert(loadfile(pluginPath))
local Main, Cleanup = chunk("gma3_mcp_bridge", "gma3_mcp_bridge", signals, componentHandle)
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
local function request(op, args, secondsPerFrame, client)
  local line = json.encode({ id = "t", op = op, args = args })
  local co = coroutine.create(function() return state._handleLine(client, line) end)
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
  check("ping: hookMode defaults to preserve and the budget counts as bounded without a console hook", r.ok and r.result.lua.hookMode == "preserve" and r.result.lua.bounded == true, json.encode(r.result.lua))
  r = requestOn("lua", { code = "return 1" })
  check("lua result reports that the instruction hook was enforced", r.ok and r.result.budget.instructionHookEnforced == true and r.result.budget.consoleHookPreserved == false, json.encode(r.result))

  -- A console that keeps an external (C) hook on the plugin thread. Stock Lua cannot create one, so
  -- debug.gethook is stubbed to report it and debug.sethook records what the plugin does.
  local realGethook, realSethook = debug.gethook, debug.sethook
  local setCalls = {}
  debug.gethook = function(thread) if thread == nil then return "external hook", "", 50000 end return realGethook(thread) end
  debug.sethook = function(a, b, c, d)
    if type(a) == "thread" then setCalls[#setCalls + 1] = { thread = true } return realSethook(a, b, c, d) end
    setCalls[#setCalls + 1] = { hook = a, mask = b, count = c }
    return realSethook(a, b, c, d)
  end
  -- Pretend no chunk has inspected the thread yet (the plugin remembers the first observation).
  -- There is no setter for that, so re-load the policy section's view through a fresh start.
  state.running = false
  Main(nil, "lua on")
  state.running = true
  setCalls = {}
  r = requestOn("lua", { code = "return 2" })
  check("preserve (default): a chunk runs without installing the budget hook over the console's hook",
    r.ok and r.result.values[1] == 2 and #setCalls == 0 and r.result.budget.instructionHookEnforced == false and r.result.budget.consoleHookPreserved == true
      and tostring(r.result.budget.note):find("preserved"), json.encode(r.result) .. " setCalls=" .. json.encode(setCalls))
  r = requestOn("ping", {})
  check("ping: with a preserved console hook the policy is reported as not bounded",
    r.ok and r.result.lua.bounded == false and r.result.lua.hookMode == "preserve" and r.result.lua.note:find("NOT enforced") and r.result.lua.consoleHook:find("external hook"), json.encode(r.result.lua))
  _G.FAKE_CLOCK_OFFSET = 0
  r = requestOn("lua", { code = "for i = 1, 4 do coroutine.yield() end return 'done'", maxMs = 1200 }, nil)
  check("preserve: deadline is still checked after each yield", r.ok and r.result.values[1] == "done", json.encode(r))
  do
    -- Advance the fake clock on every resume so the yield-heavy chunk overruns its deadline.
    local line = json.encode({ id = "t", op = "lua", args = { code = "for i = 1, 4 do coroutine.yield() end return 'late'", maxMs = 1200 } })
    local co = coroutine.create(function() return state._handleLine(nil, line) end)
    local ok, res = coroutine.resume(co)
    while ok and coroutine.status(co) == "suspended" do
      _G.FAKE_CLOCK_OFFSET = (_G.FAKE_CLOCK_OFFSET or 0) + 0.5
      ok, res = coroutine.resume(co)
    end
    assert(ok, res)
    local rr = json.decode(res)
    check("preserve: a yield-heavy chunk still hits the wall-clock budget", rr.ok == false and rr.error:find("ran longer than 1200 ms"), json.encode(rr))
    _G.FAKE_CLOCK_OFFSET = 0
  end
  r = requestOn("lua", { code = "local co = coroutine.create(function() while true do end end) local ok, e = coroutine.resume(co) return ok, e", maxSteps = 50000 })
  check("preserve: coroutines the chunk creates are still budgeted", r.ok == false and r.error:find("budget exceeded"), json.encode(r))
  resetBudget()

  Main(nil, "luahook=replace")
  check("'luahook=replace' accepted while running", state.lua.hookMode == "replace" and lastLog():find("Lua execution now"), lastLog())
  setCalls = {}
  r = requestOn("lua", { code = "return 3" })
  local calls = {}
  for _, c in ipairs(setCalls) do calls[#calls + 1] = c.thread and "thread" or (type(c.hook) .. "/" .. tostring(c.count)) end
  check("replace: the budget hook is installed over the console's hook and cleared afterwards",
    r.ok and r.result.values[1] == 3 and #setCalls == 2 and type(setCalls[1].hook) == "function" and setCalls[1].count == 1000 and setCalls[2].hook == nil
      and r.result.budget.instructionHookEnforced == true, table.concat(calls, ",") .. " " .. json.encode(r.result))
  r = requestOn("ping", {})
  check("ping: replace mode reports bounded", r.ok and r.result.lua.bounded == true and r.result.lua.hookMode == "replace", json.encode(r.result.lua))
  Main(nil, "luahook=preserve")
  check("'luahook=preserve' accepted while running", state.lua.hookMode == "preserve")
  debug.gethook, debug.sethook = realGethook, realSethook
  state.running = false
  Main(nil, "luahook=bogus")
  check("luahook=bogus refused", lastLog():find("expected luahook=preserve or luahook=replace") and state.running == false, lastLog())
  Main(nil, "lua luahook=replace")
  check("luahook parsed at start", state.lua.hookMode == "replace" and state.lua.enabled == true)
  Main(nil, "")
  check("plain start resets the hook mode to preserve", state.lua.hookMode == "preserve")
  state.running = true
  Main(nil, "lua on")
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
  check("programmer: each scanned (sub)fixture lists the attributes it has",
    r.ok and r.result.scannedFixtures[1].attributes[1] == "Dimmer" and #r.result.scannedFixtures[1].attributes == 1 and #r.result.scannedFixtures[2].attributes >= 3, json.encode(r.result and r.result.scannedFixtures))
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

-------------------------------------------------------------------------------
-- Console interaction modules (KB-02): loaded from sibling components at start, reported read-only
-------------------------------------------------------------------------------
do
  start("")  -- bind fails in this harness, so serverMain returns and the instances are disposed again
  local hk, fb = state.modules.hardkeys, state.modules.feedback
  check("modules found through the plugin signal table", hk and hk.loaded and fb and fb.loaded, json.encode({ hk = hk and hk.error, fb = fb and fb.error }))
  check("module versions recorded", hk.version == "0.10.0" and hk.apiVersion == 1 and fb.version == "0.5.0", json.encode({ hk.version, fb.version }))
  check("modules start log line", lastLog():find("stopped") or true)
  local disposed = hk.instance and hk.instance:status().state == "disposed" and fb.instance:status().state == "disposed"
  check("instances disposed when the loop ends", disposed, hk.instance and hk.instance:status().state)
  check("modules did not publish via package.loaded or globals", package.loaded["gma3_mcp_hardkeys"] == nil and _G.gma3_mcp_hardkeys == nil and _G.gma3_mcp_feedback == nil)
  r = request("ping", {})
  check("ping summarises modules", r.ok and r.result.modules.hardkeys.loaded == true and r.result.modules.feedback.version == "0.5.0", json.encode(r.result.modules))
  r = request("modules", {})
  check("modules op reports status without Lua enabled", r.ok and state.lua.enabled == false and r.result.apiVersion == 1 and r.result.modules.hardkeys.status.inputEnabled == false and r.result.modules.feedback.status.module == "gma3_mcp_feedback", json.encode(r))

  -- Two bridge-like consumers loading the same components get distinct module tables.
  local before = state.modules
  state._loadModules()
  check("reload creates fresh instances", state.modules.hardkeys.instance ~= before.hardkeys.instance and state.modules.hardkeys.instance:status().state == "ready")
  disposed = before.hardkeys.instance:status().state == "disposed"
  check("earlier instance stays disposed and separate", disposed and state.modules.hardkeys.instance:status().holdCount == 0)

  check("modules registered in the plugin signal table only", signals.__gma3_mcp_modules.gma3_mcp_hardkeys == hardkeysModule and signals.__gma3_mcp_modules.gma3_mcp_feedback == feedbackModule)
  -- A plugin whose XML lacks a component: the bridge still starts and reports the gap.
  local reg = signals.__gma3_mcp_modules
  reg.gma3_mcp_feedback = nil
  state._loadModules()
  check("missing component reported, bridge keeps going", state.modules.feedback.loaded == false and tostring(state.modules.feedback.error):find("not registered") and tostring(state.modules.feedback.error):find("present") and state.modules.hardkeys.loaded == true, json.encode(state.modules.feedback.error))
  reg.gma3_mcp_feedback = feedbackModule
  -- A registered value that is not a module table is refused.
  reg.gma3_mcp_hardkeys = { VERSION = "x" }
  state._loadModules()
  check("non-module registration refused", state.modules.hardkeys.loaded == false and tostring(state.modules.hardkeys.error):find("not a module table"), state.modules.hardkeys.error)
  -- A module with a different API version is refused.
  reg.gma3_mcp_hardkeys = { API_VERSION = 99, VERSION = "x", new = function() end }
  state._loadModules()
  check("API version mismatch refused", state.modules.hardkeys.loaded == false and tostring(state.modules.hardkeys.error):find("API version 99"), state.modules.hardkeys.error)
  reg.gma3_mcp_hardkeys = hardkeysModule
  -- No registry at all (components never ran).
  signals.__gma3_mcp_modules = nil
  state._loadModules()
  check("absent registry reported", state.modules.hardkeys.loaded == false and tostring(state.modules.hardkeys.error):find("did not run"), state.modules.hardkeys.error)
  signals.__gma3_mcp_modules = reg
  state._loadModules()
  check("registry restored, modules load again", state.modules.hardkeys.loaded and state.modules.feedback.loaded)
  for _, rec in pairs(state.modules) do if rec.instance then rec.instance:dispose() end end
end


-------------------------------------------------------------------------------
-- Owned input sessions (KB-03): connection-bound sessions over the fake backend
-------------------------------------------------------------------------------
local function J(v) return json.encode(v) end
local function logFound(pattern, from)
  for i = from or 1, #logs do if logs[i]:find(pattern) then return logs[i] end end
  return nil
end
do
  start("input=fake")  -- parses and loads the modules with input enabled; bind fails here, so re-create live instances
  check("input=fake parsed at start", state.input.enabled == true and state.input.backend == "fake", J(state.input))
  check("default start keeps input disabled", (function() start(""); return state.input.enabled == false and state.input.backend == nil end)())
  start("9800 input=fake lua")
  state._loadModules(); state.running = true; state.stopRequested = false; state.ignoreNextCleanup = false
  local A, B = { id = 1 }, { id = 2 }
  local hk = state.modules.hardkeys
  local fake = hk.fakeAdapter
  check("hardkeys instance runs with the fake adapter attached", hk.instance:status().inputEnabled == true and hk.instance:status().backend.name == "fake" and fake ~= nil and fake.name == "fake")
  r = request("ping", {})
  check("ping reports the input policy", r.ok and r.result.input.enabled == true and r.result.input.backend == "fake" and r.result.input.holds == 0, J(r.result.input))
  r = request("input.press", { key = "PLEASE" })
  check("input ops need a connection context", r.ok == false and r.error:find("no%-connection"), r.error)
  r = request("input.press", { key = "PLEASE" }, nil, A)
  check("press without a session is refused", r.ok == false and r.error:find("no%-session"), r.error)
  r = request("input.open", { leaseMs = 2000, label = "mcp" }, nil, A)
  check("session opened and bound to the connection", r.ok and r.result.session.id == "conn-1" and A.session == "conn-1" and r.result.session.binding == "client 1" and r.result.session.leaseMs == 2000, J(r))
  r = request("input.open", {}, nil, A)
  check("a second open on the same connection is refused", r.ok == false and r.error:find("session%-exists"), r.error)
  r = request("input.press", { key = "PLEASE", display = 1 }, nil, A)
  check("a standalone hold without an interaction is refused with a structured error (KB-05)", r.ok == false and r.code == "interaction-required" and r.detail.kind == "hold" and #fake.events == 0, J(r))
  r = request("input.begin", { leaseMs = 60000, label = "hold" }, nil, A)
  check("input.begin opens an interaction bound to the connection's session", r.ok and r.result.interaction.id == "i1" and r.result.interaction.session == "conn-1" and r.result.session == "conn-1" and r.result.interaction.remainingMs == 60000, J(r))
  local IA = r.result.interaction.id
  r = request("input.press", { key = "PLEASE", display = 1, interaction = IA }, nil, A)
  check("press through the bridge stores tuple and route", r.ok and r.result.hold.pcKey == "Enter" and r.result.hold.route.source == "native" and r.result.hold.route.profile == "Default" and r.result.hold.session == "conn-1" and #fake.events == 1, J(r))
  r = request("input.press", { key = "PLEASE", display = 7, interaction = IA }, nil, A)
  check("display validated against the console display list", r.ok == false and r.error:find("display 7"), r.error)
  request("input.open", {}, nil, B)
  r = request("input.press", { key = "PLEASE", interaction = IA }, nil, B)
  check("another connection cannot use the interaction id", r.ok == false and r.code == "not-owner" and r.detail.owner == "conn-1", r.error)
  r = request("input.tap", { key = "STORE" }, nil, B)
  check("another connection's input is busy while the interaction is open", r.ok == false and r.code == "busy" and r.detail.reason == "interaction" and r.error:find("conn%-1") and #fake.events == 1, r.error)
  r = request("cmd", { command = "Go+ Sequence 1" }, nil, B)
  check("a command from any connection is refused as busy while the interaction is open", r.ok == false and r.code == "busy" and r.error:find("a command is refused") and r.detail.interaction == IA, r.error)
  r = request("ping", {}, nil, B)
  check("ping reports the busy owner", r.ok and r.result.input.busy.reason == "interaction" and r.result.input.interaction == IA, J(r.result.input))
  r = request("input.release", { key = "PLEASE" }, nil, B)
  check("another connection cannot release it", r.ok == false and r.error:find("not%-owner") and fake.counters.release == 0, r.error)
  r = request("input.renew", { leaseMs = 5000, session = "conn-1" }, nil, B)
  check("a session id in args is ignored: renew acts on the caller's own session", r.ok and r.result.session.id == "conn-2" and r.result.session.leaseMs == 5000, J(r))
  r = request("input.status", {}, nil, B)
  check("status is readable by anyone, shows owner and remaining lease, releases nothing", r.ok and r.result.session == "conn-2" and r.result.status.holds[1].session == "conn-1" and r.result.status.sessions["conn-1"].remainingMs ~= nil and r.result.policy.holds == 1 and fake.counters.release == 0, J(r.result.policy))
  -- Control invocations never release keys of the running bridge.
  Main(nil, "status"); Cleanup()
  check("'status' + Cleanup leave the hold and the bridge alone", state.running == true and fake.counters.release == 0 and hk.instance:status().capacity.used == 1 and lastLog():find("holds=1"), lastLog())
  local before = #logs
  Main(nil, "input status"); Cleanup()
  check("'input status' prints sessions and holds and releases nothing", state.running == true and fake.counters.release == 0 and logFound("input hold h1: held PLEASE", before) and logFound("input session conn%-1: active", before), lastLog())
  Main(nil, "input"); Cleanup()
  check("'input' alone is refused (no default backend)", lastLog():find("no default input backend") and state.running == true, lastLog())
  Main(nil, "input=keyboard"); Cleanup()
  check("input=keyboard while fake records exist is refused and leaves the fake policy intact", lastLog():find("cannot switch the backend") and lastLog():find("fake enabled") and state.input.backend == "fake" and state.input.enabled == true and state.running == true, lastLog())
  Main(nil, "input=maybe"); Cleanup()
  check("input=maybe refused", lastLog():find("expected input=keyboard, input=fake, input=quickey, input=mixed or input=off"), lastLog())
  -- Fake controls and owner-scoped recovery.
  r = request("input.fake", { action = "failRelease", pcKey = "Enter", sticky = true, error = "host blocked" }, nil, A)
  check("fake controls reachable", r.ok and r.result.backend == "fake" and r.result.down[1] == "Enter|s0c0a0n0", J(r))
  r = request("input.release", { key = "PLEASE" }, nil, A)
  check("a failed release is reported as unresolved, record kept", r.ok and r.result.hold.state == "unresolved" and r.result.hold.unresolved.reason:find("host blocked") and logFound("UNRESOLVED conn%-1 PLEASE"), J(r))
  r = request("input.end", { interaction = IA }, nil, A)
  check("ending the interaction leaves the unresolved record to recovery", r.ok and r.result.state == "ended" and r.result.attempted == 0 and hk.instance:status().unresolved == 1, J(r))
  r = request("cmd", { command = "Go+ Sequence 1" }, nil, B)
  check("an unresolved record keeps commands busy until recovery (the key may still be down)", r.ok == false and r.code == "busy" and r.detail.reason == "unresolved" and r.error:find("input recover"), r.error)
  r = request("input.tap", { pcKey = "Enter" }, nil, B)
  check("the unresolved record blocks another connection's input", r.ok == false and r.code == "busy" and r.detail.reason == "unresolved", r.error)
  r = request("input.recover", {}, nil, B)
  check("recover is owner-scoped: B has nothing to recover", r.ok and r.result.attempted == 0 and r.result.scope == "conn-2", J(r))
  request("input.fake", { action = "clearFailures" }, nil, A)
  r = request("input.recover", {}, nil, A)
  check("owner recover releases the record", r.ok and #r.result.released == 1 and hk.instance:status().unresolved == 0, J(r))
  -- Tap through the bridge: the deadline is serviced by the module's service() on the loop.
  r = request("input.tap", { key = "STORE", holdMs = 20 }, nil, A)
  check("tap accepted with a deadline", r.ok and r.result.hold.kind == "tap" and r.result.hold.deadlineInMs == 20, J(r))
  _G.FAKE_CLOCK_OFFSET = 1
  r = request("input.status", {}, nil, A)
  check("status past the deadline does not release (deadline servicing belongs to the loop)", r.ok and hk.instance:status().capacity.used == 1 and fake.events[#fake.events].kind == "press")
  hk.instance:service(require("socket").gettime())
  check("service releases the overdue tap", hk.instance:status().capacity.used == 0 and fake.events[#fake.events].kind == "release" and fake.events[#fake.events].pcKey == "S")
  _G.FAKE_CLOCK_OFFSET = 0
  -- Disable while held: release attempted, new input refused, status/release/recover still work.
  r = request("input.begin", {}, nil, A); IA = r.result.interaction.id
  request("input.press", { key = "STORE", interaction = IA }, nil, A)
  Main(nil, "input=off"); Cleanup()
  check("'input=off' while running releases held keys and keeps the bridge running", state.running == true and state.input.enabled == false and hk.instance:status().capacity.used == 0 and fake.events[#fake.events].kind == "release" and fake.events[#fake.events].pcKey == "S", J(fake.events[#fake.events]))
  check("'input=off' ended the open interaction", hk.instance:status().activeInteraction == nil and hk.instance:status().interactions[IA].state == "ended", J(hk.instance:status().interactions))
  r = request("input.press", { key = "STORE" }, nil, A)
  check("press refused while input is disabled, with the enable hint", r.ok == false and r.error:find("input%-disabled") and r.error:find("input=fake"), r.error)
  r = request("input.status", {}, nil, A)
  check("status, releaseAll and recover remain available while disabled", r.ok and r.result.policy.enabled == false and request("input.releaseAll", {}, nil, A).ok and request("input.recover", {}, nil, A).ok)
  Main(nil, "input=fake"); Cleanup()
  r = request("input.begin", {}, nil, A)
  check("'input=fake' re-enables while running", state.input.enabled == true and state.running == true and r.ok and request("input.press", { key = "STORE", interaction = r.result.interaction.id }, nil, A).ok, lastLog())
  IA = r.result.interaction.id
  state.stopRequested = true
  r = request("input.tap", { key = "PLEASE" }, nil, A)
  check("new input refused while the bridge is stopping", r.ok == false and r.error:find("stopping"), r.error)
  state.stopRequested = false
  -- Disconnect: closeClient releases the connection's holds newest first and logs the outcome.
  request("input.press", { pcKey = "LeftShift", interaction = IA }, nil, A)
  state.clients = { A, B }
  local n = #fake.events
  state._closeClient(1, "disconnect")
  check("disconnect releases the client's holds newest first", #state.clients == 1 and fake.events[n + 1].kind == "release" and fake.events[n + 1].pcKey == "LeftShift" and fake.events[n + 2].pcKey == "S" and A.session == nil and hk.instance:status().capacity.used == 0, J({ fake.events[n + 1], fake.events[n + 2] }))
  check("disconnect outcome logged", logFound("input: disconnect conn%-1 released conn%-1 raw%(LeftShift") ~= nil)
  r = request("input.close", {}, nil, B)
  check("a client can close its own session", r.ok and B.session == nil and r.result.session == "conn-2", J(r))
  -- Shutdown with an unresolved release keeps the record across runs; operator recovery adopts it.
  r = request("input.begin", {}, nil, B)
  check("input.begin opens the connection's session on demand", r.ok and B.session == "conn-2" and r.result.session == "conn-2", J(r))
  request("input.press", { pcKey = "Q", ctrl = true, interaction = r.result.interaction.id }, nil, B)
  request("input.fake", { action = "failRelease", pcKey = "Q", ctrl = true, sticky = true, error = "console frozen" }, nil, B)
  state.clients = { B }
  Cleanup()
  check("owning-call Cleanup attempts the release, keeps the unresolved record and stops", state.running == false and #state.input.unresolved == 1 and state.input.unresolved[1].pcKey == "Q" and state.input.unresolved[1].ctrl == true and state.input.unresolved[1].keptReason == "cleanup" and logFound("1 unresolved release record%(s%) kept"), J(state.input.unresolved))
  Main(nil, "input recover"); Cleanup()
  check("'input recover' while stopped keeps the record", lastLog():find("not running") and #state.input.unresolved == 1, lastLog())
  before = #logs
  start("input=fake")
  check("restart adopts the kept record and says its key is reserved", logFound("1 unresolved release record%(s%) from a previous run reserve their keys", before) ~= nil, lastLog())
  state._loadModules(); state.running = true; state.stopRequested = false; state.ignoreNextCleanup = false
  hk = state.modules.hardkeys
  r = request("ping", {})
  check("ping shows the adopted record as unresolved, nothing left un-adopted", r.ok and r.result.input.unresolved == 1 and r.result.input.unresolvedFromPreviousRun == 0 and r.result.input.holds == 1, J(r.result.input))
  r = request("input.status", {}, nil, A)
  check("input.status lists the adopted hold under the previous-run session", r.ok and r.result.status.holds[1].session == "previous-run" and r.result.status.holds[1].state == "unresolved" and r.result.status.holds[1].tupleKey == "Q|s0c1a0n0", J(r.result.status.holds))
  request("input.open", {}, nil, A)
  r = request("input.tap", { pcKey = "Q", ctrl = true }, nil, A)
  check("the reserved tuple cannot be pressed by a new session before recovery", r.ok == false and r.code == "busy" and r.detail.reason == "unresolved" and r.error:find("previous%-run"), r.error)
  r = request("cmd", { command = "Go+ Sequence 1" }, nil, A)
  check("commands stay busy after a start that adopted an unresolved record", r.ok == false and r.code == "busy" and r.detail.reason == "unresolved", r.error)
  check("nothing was dispatched for the reserved tuple", #hk.fakeAdapter.events == 0)
  before = #logs
  Main(nil, "input recover"); Cleanup()
  check("'input recover' releases the adopted record with the stored tuple", #state.input.unresolved == 0 and hk.instance:status().unresolved == 0 and hk.fakeAdapter.events[#hk.fakeAdapter.events].kind == "release" and hk.fakeAdapter.events[#hk.fakeAdapter.events].ctrl == true and logFound("input recover: 1 released, 0 still unresolved", before), lastLog())
  check("bridge still running after operator recovery", state.running == true)
  check("the tuple is free again", request("input.tap", { pcKey = "Q", ctrl = true, holdMs = 20 }, nil, A).ok)
  request("input.releaseAll", {}, nil, A)
  -- A module that raises in service() must not take its holds with it: input is disabled, every
  -- held key gets a release attempt and whatever stays unresolved is kept for "input recover".
  r = request("input.begin", {}, nil, A)
  request("input.press", { key = "STORE", interaction = r.result.interaction.id }, nil, A)
  request("input.press", { pcKey = "W", interaction = r.result.interaction.id }, nil, A)
  request("input.fake", { action = "failRelease", pcKey = "W", sticky = true, error = "wedged" }, nil, A)
  fake = hk.fakeAdapter
  hk.instance.service = function() error("service exploded") end
  state._serviceModules(require("socket").gettime())
  check("service failure detaches the instance and disables input", hk.instance == nil and state.input.enabled == false and tostring(hk.error):find("service exploded"), hk.error)
  local ev = fake.events
  check("service failure released what it could (newest first; the wedged key stays down)", not fake:isDown({ pcKey = "S" }) and fake:isDown({ pcKey = "W" }) and ev[#ev].kind == "release" and ev[#ev].pcKey == "S" and ev[#ev - 1].pcKey == "W" and ev[#ev - 1].failed == "wedged", J(ev))
  check("service failure kept the unresolved record", #state.input.unresolved == 1 and state.input.unresolved[1].pcKey == "W" and state.input.unresolved[1].keptReason == "service-error", J(state.input.unresolved))
  r = request("input.press", { key = "STORE" }, nil, A)
  check("input refused after the failure", r.ok == false, r.error)
  -- Restart with the default (input disabled), then "input recover": no backend can dispatch, so
  -- the record must stay reserved and unresolved, and recover after enabling must release it.
  start("")
  state._loadModules(); state.running = true; state.stopRequested = false; state.ignoreNextCleanup = false
  hk = state.modules.hardkeys
  check("kept record adopted at a start with input disabled", state.input.enabled == false and hk.instance:status().unresolved == 1 and hk.instance:status().holds[1].tupleKey == "W|s0c0a0n0")
  before = #logs
  Main(nil, "input recover"); Cleanup()
  check("'input recover' without a backend attaches the record's own (fake) backend for cleanup only and releases it", logFound("attached the fake backend for cleanup only", before) and hk.instance:status().unresolved == 0 and hk.instance:status().holds[1].state == "released" and hk.instance:status().holds[1].backend == "fake" and state.input.enabled == false and hk.instance:status().inputEnabled == false, J(hk.instance:status().holds[1]))
  request("input.open", {}, nil, B)
  r = request("input.press", { pcKey = "W" }, nil, B)
  check("input stays disabled after a cleanup-only attach", r.ok == false and r.error:find("input%-disabled"), r.error)
  Main(nil, "input=fake"); Cleanup()
  check("'input=fake' after the cleanup attach enables input on the same adapter", state.input.enabled == true and request("input.tap", { pcKey = "W", holdMs = 20 }, nil, B).ok, lastLog())
  request("input.releaseAll", {}, nil, B)
  -- The same restart path with a KEYBOARD record: the fake adapter must never release it.
  request("input.tap", { pcKey = "V", holdMs = 5000 }, nil, B)
  hk.fakeAdapter:failNext("release", { pcKey = "V" }, "wedged", true)
  state.clients = { B }
  Cleanup()
  check("a fake record is kept with its backend name", #state.input.unresolved == 1 and state.input.unresolved[1].backend == "fake", J(state.input.unresolved))
  state.input.unresolved[1].backend = "keyboard"  -- pretend the previous run pressed it through Keyboard()
  start("")
  state._loadModules(); state.running = true; state.stopRequested = false; state.ignoreNextCleanup = false
  hk = state.modules.hardkeys
  before = #logs
  Main(nil, "input recover"); Cleanup()
  check("'input recover' attaches the keyboard backend for a keyboard record and releases it through Keyboard() with input disabled",
    logFound("attached the keyboard backend for cleanup only", before) and hk.instance:status().unresolved == 0 and #keyboardCalls == 1 and keyboardCalls[1].kind == "release" and keyboardCalls[1].key == "V" and state.input.enabled == false, J(keyboardCalls))
  Main(nil, "input=fake"); Cleanup()
  check("with no live records left, input=fake may switch the backend again", state.input.enabled == true and state.input.backend == "fake", lastLog())
  request("input.open", {}, nil, B)
  -- With input=off the backend stays attached: recover must release without the no-backend warning.
  request("input.tap", { pcKey = "W", holdMs = 5000 }, nil, B)
  request("input.fake", { action = "failRelease", pcKey = "W", sticky = true, error = "wedged again" }, nil, B)
  Main(nil, "input=off"); Cleanup()
  check("input=off left the wedged key unresolved", hk.instance:status().unresolved == 1 and state.input.enabled == false)
  request("input.fake", { action = "clearFailures" }, nil, B)
  before = #logs
  Main(nil, "input recover"); Cleanup()
  check("'input recover' with input off but a backend attached releases without attaching anything", hk.instance:status().unresolved == 0 and logFound("input recover: 1 released, 0 still unresolved", before) and not logFound("attached the", before), lastLog())
  Main(nil, "input=fake"); Cleanup()
  request("input.close", {}, nil, B)
end

-------------------------------------------------------------------------------
-- KB-04: the keyboard backend through the bridge
-------------------------------------------------------------------------------
do
  start("input=keyboard")
  check("input=keyboard parsed at start", state.input.enabled == true and state.input.backend == "keyboard", J(state.input))
  state._loadModules(); state.running = true; state.stopRequested = false; state.ignoreNextCleanup = false
  local hk = state.modules.hardkeys
  check("hardkeys instance runs with the keyboard adapter attached and enabled", hk.instance:status().inputEnabled == true and hk.instance:status().backend.name == "keyboard" and hk.keyboardAdapter ~= nil, J(hk.instance:status().backend))
  local A, B = { id = 21 }, { id = 22 }
  request("input.open", {}, nil, A); request("input.open", {}, nil, B)
  keyboardCalls = {}
  r = request("input.begin", { leaseMs = 60000 }, nil, A)
  local IA = r.result.interaction.id
  r = request("input.press", { key = "STORE", display = 1, interaction = IA }, nil, A)
  check("a press reaches Keyboard() with explicit modifiers", r.ok and #keyboardCalls == 1 and keyboardCalls[1].kind == "press" and keyboardCalls[1].key == "S" and keyboardCalls[1].display == 1 and keyboardCalls[1].shift == false and keyboardCalls[1].ctrl == false, J(keyboardCalls))
  check("the hold reports dispatched, not confirmed, on the keyboard backend", r.result.hold.backend == "keyboard" and r.result.hold.pressOutcome == "dispatched" and r.result.hold.dispatch.press.confirmed == nil, J(r.result.hold))
  r = request("input.release", { key = "STORE" }, nil, A)
  check("the release repeats the stored tuple through Keyboard() and is 'dispatched'", r.ok and #keyboardCalls == 2 and keyboardCalls[2].kind == "release" and keyboardCalls[2].key == "S" and r.result.hold.releaseOutcome == "dispatched" and r.result.hold.attempt.verified == false, J(r))
  check("the dispatched release was logged with its outcome", logFound("input: release conn%-21 released conn%-21 STORE%(S|s0c0a0n0%) released %(dispatched, effect not observable%)") ~= nil)
  r = request("input.fake", { action = "events" }, nil, A)
  check("fake controls are refused on the keyboard backend", r.ok == false and r.error:find("not%-fake"), r.error)
  r = request("input.press", { pcKey = "Bogus" }, nil, A)
  check("an unknown KeyboardCodes name is refused before dispatch", r.ok == false and r.error:find("KeyboardCodes") and #keyboardCalls == 2, r.error)
  -- MA with readback through the loop.
  r = request("input.press", { key = "MA", interaction = IA }, nil, A)
  check("MA presses LeftShift and schedules a MASTATE readback", r.ok and keyboardCalls[3].key == "LeftShift" and r.result.hold.readback.outcome == "pending", J(r.result.hold.readback))
  state._serviceModules(require("socket").gettime())
  r = request("input.status", {}, nil, A)
  check("the loop observed MASTATE true (aggregate) for the MA hold", r.ok and r.result.status.observed.aggregate.maState == true and r.result.status.holds[#r.result.status.holds].readback.outcome == "observed" and r.result.status.observed.available == false, J(r.result.status.observed))
  request("input.release", { key = "MA" }, nil, A)
  request("input.end", { interaction = IA }, nil, A)
  -- Combination and exclusive long-press through the ops.
  keyboardCalls = {}
  r = request("input.combo", { keys = { { key = "MA" }, { key = "STORE" } }, holdMs = 20 }, nil, A)
  check("input.combo presses MA then STORE as one group", r.ok and r.result.count == 2 and keyboardCalls[1].key == "LeftShift" and keyboardCalls[2].key == "S" and r.result.holds[1].group == r.result.holds[2].group, J(r))
  r = request("input.combo", { keys = { { pcKey = "Z" }, { pcKey = "Bogus" } }, holdMs = 20 }, nil, B)
  check("another connection's combo is busy while the chord is in flight", r.ok == false and r.code == "busy" and r.detail.reason == "hold" and r.detail.owner == "conn-21" and #keyboardCalls == 2, r.error)
  r = request("input.combo", { keys = "MA" }, nil, B)
  check("combo validates args.keys", r.ok == false and r.error:find("bad%-argument"), r.error)
  _G.FAKE_CLOCK_OFFSET = 1
  state._serviceModules(require("socket").gettime())
  _G.FAKE_CLOCK_OFFSET = 0
  check("the combo deadline released S then LeftShift", #keyboardCalls == 4 and keyboardCalls[3].kind == "release" and keyboardCalls[3].key == "S" and keyboardCalls[4].key == "LeftShift", J(keyboardCalls))
  r = request("input.combo", { keys = { { pcKey = "Z" }, { pcKey = "Bogus" } }, holdMs = 20 }, nil, B)
  check("a combo with a bad key dispatches nothing and names the key", r.ok == false and r.error:find("key 2") and #keyboardCalls == 4, r.error)
  r = request("input.combo", { keys = { { pcKey = "Z" }, { pcKey = "Q" } } }, nil, B)
  check("a combo without holdMs is a hold and needs an interaction", r.ok == false and r.code == "interaction-required" and #keyboardCalls == 4, r.error)
  r = request("input.tap", { key = "STORE", holdMs = 1000, exclusive = true }, nil, A)
  check("an exclusive tap (long-press) is accepted", r.ok and r.result.hold.exclusive == true, J(r))
  r = request("input.press", { key = "MA" }, nil, B)
  check("another connection's press is rejected during the long-press", r.ok == false and r.error:find("exclusive%-hold") and r.error:find("conn%-21"), r.error)
  r = request("input.press", { key = "STORE" }, nil, A)
  check("the owner's duplicate is rejected during the long-press", r.ok == false and r.error:find("exclusive%-hold"), r.error)
  r = request("input.releaseAll", {}, nil, A)
  check("the owner can still release", r.ok and #r.result.released == 1, J(r))
  -- input=fake while keyboard holds exist is refused and keeps the keyboard policy.
  r = request("input.begin", {}, nil, B)
  request("input.press", { pcKey = "Q", interaction = r.result.interaction.id }, nil, B)
  Main(nil, "input=fake"); Cleanup()
  check("input=fake while a keyboard hold exists is refused, keyboard policy kept", state.input.backend == "keyboard" and state.input.enabled == true and lastLog():find("cannot switch"), lastLog())
  Main(nil, "input=off"); Cleanup()
  check("input=off releases the keyboard hold through Keyboard()", state.input.enabled == false and keyboardCalls[#keyboardCalls].kind == "release" and keyboardCalls[#keyboardCalls].key == "Q" and hk.instance:status().capacity.used == 0, J(keyboardCalls[#keyboardCalls]))
  request("input.close", {}, nil, A); request("input.close", {}, nil, B)
  state.input.unresolved = {}
  for _, rec in pairs(state.modules) do if rec.instance then rec.instance:dispose(0) end end
  state.running = false
end

-------------------------------------------------------------------------------
-- KB-05: interactions, admission across connections, sequences, text and structured errors
-------------------------------------------------------------------------------
do
  start("input=fake lua")
  state._loadModules(); state.running = true; state.stopRequested = false; state.ignoreNextCleanup = false
  local hk = state.modules.hardkeys
  local fake = hk.fakeAdapter
  Cmd = function(c) return "OK" end
  CmdObj = function() return { cmdtext = state.modules.hardkeys.fakeAdapter.typed } end
  fakeProfile.shortcutsActive = "false"
  local A, B = { id = 31 }, { id = 32 }
  -- A sequence from a connection without a session: the session is opened on demand.
  r = request("input.sequence", { steps = { { kind = "tap", key = "PLEASE", holdMs = 20 }, { kind = "text", text = "Fixture 5", context = "command-line", acknowledgeFocus = true } }, label = "demo" }, nil, A)
  check("input.sequence opens the session on demand and starts the sequence", r.ok and A.session == "conn-31" and r.result.id == "q1" and r.result.state == "running" and r.result.events[1].state == "waiting" and r.result.autoInteraction == true, J(r))
  local Q = r.result.id
  r = request("ping", {}, nil, B)
  check("ping reports the running sequence and the busy owner", r.ok and r.result.input.sequence == Q and r.result.input.busy.owner == "conn-31", J(r.result.input))
  r = request("cmd", { command = "Go+ Sequence 1" }, nil, B)
  check("cmd from another connection is [busy] while the sequence runs", r.ok == false and r.code == "busy" and r.detail.owner == "conn-31" and r.error:find("a command is refused"), r.error)
  r = request("cmd", { command = "Go+ Sequence 1" }, nil, A)
  check("cmd from the owning connection is [busy] too (end the interaction first)", r.ok == false and r.code == "busy", r.error)
  r = request("feedback.read", { readers = { "commandText", "maState" } }, nil, B)
  check("feedback.read is never guarded: it reads while another connection owns input", r.ok and r.result.count == 2 and r.result.items[1].name == "commandText" and r.result.items[1].available == true and r.result.items[2].value == false and state.lua.enabled == true, J(r))
  r = request("set", { ref = "Sequence 1", property = "Name", value = "x" }, nil, B)
  check("set is guarded", r.ok == false and r.code == "busy" and r.error:find("a property change"), r.error)
  r = request("setfader", { ref = "Sequence 1", value = 50 }, nil, B)
  check("setfader is guarded", r.ok == false and r.code == "busy" and r.error:find("a fader change"), r.error)
  r = request("lua", { code = "1+1" }, nil, B)
  check("lua is guarded", r.ok == false and r.code == "busy" and r.error:find("arbitrary Lua"), r.error)
  r = request("input.status", {}, nil, B)
  check("input.status stays readable and shows the busy descriptor", r.ok and r.result.policy.busy.reason == "interaction" and r.result.status.sequence.id == Q, J(r.result.policy))
  r = request("input.sequence.status", { sequence = Q }, nil, B)
  check("input.sequence.status is readable by anyone", r.ok and r.result.id == Q and r.result.events[2].state == "pending", J(r))
  r = request("input.sequence", { steps = { { kind = "tap", key = "PLEASE" } } }, nil, B)
  check("another connection cannot start a sequence meanwhile", r.ok == false and r.code == "busy" and r.detail.reason == "sequence" and B.session == "conn-32", r.error)
  r = request("input.tap", { key = "PLEASE" }, nil, B)
  check("nor tap", r.ok == false and r.code == "busy", r.error)
  r = request("input.tap", { key = "PLEASE" }, nil, A)
  check("the owner's direct input is refused while its own sequence runs", r.ok == false and r.code == "busy" and r.detail.reason == "sequence", r.error)
  _G.FAKE_CLOCK_OFFSET = 0.05
  state._serviceModules(require("socket").gettime())
  _G.FAKE_CLOCK_OFFSET = 0.1
  state._serviceModules(require("socket").gettime())
  _G.FAKE_CLOCK_OFFSET = 0
  r = request("input.sequence.status", { sequence = Q }, nil, A)
  check("the loop ran the sequence to completion: tap released, text typed and read back", r.ok and r.result.state == "completed" and r.result.events[1].releaseOutcome == "confirmed" and r.result.events[2].typed == 9 and r.result.events[2].readback.outcome == "observed" and fake.typed == "Fixture 5", J(r))
  check("the loop logged the sequence outcome", logFound("input: sequence q1 completed %(2 of 2 steps completed%)") ~= nil)
  r = request("cmd", { command = "Go+ Sequence 1" }, nil, B)
  check("commands are admitted again once the sequence finished", r.ok and r.result.feedback == "OK", J(r))
  fakeProfile.shortcutsActive = "true"  -- the operator re-enables shortcuts (STORE needs them)
  -- Structured partial progress: a combo whose second key is refused after the first was pressed.
  fake:failNext("press", { pcKey = "Enter" }, "console refused")
  r = request("input.combo", { keys = { { key = "MA" }, { key = "PLEASE" } }, holdMs = 50 }, nil, A)
  check("a combo failing after dispatch reports code, pressed keys and the rollback in detail", r.ok == false and r.code == "press-failed" and r.detail.key == 2 and r.detail.pressed[1].pcKey == "LeftShift" and #r.detail.rollback.released == 1 and r.error:find("key 2 of the combo"), J(r))
  -- Shared-connection ownership: holds need the interaction id even from the owning connection.
  r = request("input.begin", { leaseMs = 60000 }, nil, A)
  local IA = r.result.interaction.id
  r = request("input.press", { key = "STORE" }, nil, A)
  check("a press from the owning connection without the id is busy (pass the interaction)", r.ok == false and r.code == "busy" and r.error:find("pass its id"), r.error)
  r = request("input.press", { key = "STORE", interaction = IA }, nil, A)
  check("with the id the hold is admitted and tagged", r.ok and r.result.hold.interaction == IA, J(r))
  r = request("input.extend", { interaction = IA, leaseMs = 30000 }, nil, A)
  check("input.extend renews the interaction", r.ok and r.result.interaction.renewals == 1 and r.result.interaction.leaseMs == 30000, J(r))
  r = request("input.extend", { interaction = IA }, nil, B)
  check("another connection cannot extend it", r.ok == false and r.code == "no-session" or r.code == "not-owner", r.error)
  r = request("input.sequence", { steps = { { kind = "tap", key = "PLEASE", holdMs = 20 } }, interaction = IA }, nil, A)
  check("a sequence may run inside the explicit interaction", r.ok and r.result.autoInteraction == false and r.result.interaction == IA, J(r))
  _G.FAKE_CLOCK_OFFSET = 0.05
  state._serviceModules(require("socket").gettime())
  _G.FAKE_CLOCK_OFFSET = 0
  r = request("input.end", { interaction = IA }, nil, A)
  check("input.end releases the interaction's holds and reports them", r.ok and r.result.state == "ended" and #r.result.released == 1 and r.result.released[1].logical == "STORE", J(r))
  r = request("input.end", { interaction = IA }, nil, A)
  check("ending twice is harmless", r.ok and r.result.alreadyEnded == true, J(r))
  r = request("input.press", { key = "STORE", interaction = IA }, nil, A)
  check("an ended interaction is never resumed", r.ok == false and r.code == "no-interaction", r.error)
  -- Disconnect mid-sequence: the in-flight tap is released by the session close, the rest unattempted.
  local n = #fake.events
  r = request("input.sequence", { steps = { { kind = "tap", key = "STORE", holdMs = 3000 }, { kind = "tap", key = "PLEASE" } } }, nil, A)
  Q = r.result.id
  state.clients = { A, B }
  state._closeClient(1, "disconnect")
  r = request("input.sequence.status", { sequence = Q }, nil, B)
  check("a disconnect mid-sequence aborts it: step 1 aborted, step 2 unattempted, nothing resumed", r.ok and r.result.state == "aborted" and r.result.events[1].state == "aborted" and r.result.events[2].state == "unattempted" and r.result.error:find("disconnect"), J(r))
  check("the disconnect released the in-flight tap and logged it", fake.events[n + 2].kind == "release" and fake.events[n + 2].pcKey == "S" and #fake.events == n + 2 and logFound("input: disconnect conn%-31 released conn%-31 STORE") ~= nil, J(fake.events[n + 2]))
  check("nothing is busy after the disconnect", hk.instance:admission(0) == nil and request("cmd", { command = "x" }, nil, B).ok)
  -- Cleanup while input is disabled: begin + press, then input=off.
  r = request("input.begin", {}, nil, B)
  IA = r.result.interaction.id
  request("input.press", { key = "STORE", interaction = IA }, nil, B)
  Main(nil, "input=off"); Cleanup()
  check("'input=off' ends the interaction and releases its hold", state.input.enabled == false and hk.instance:status().interactions[IA].state == "ended" and hk.instance:status().capacity.used == 0 and fake.events[#fake.events].kind == "release", J(hk.instance:status().interactions))
  r = request("input.begin", {}, nil, B)
  check("input.begin is refused while input is disabled", r.ok == false and r.code == "input-disabled", r.error)
  r = request("input.sequence", { steps = { { kind = "tap", key = "STORE" } } }, nil, B)
  check("input.sequence is refused while input is disabled, before validation", r.ok == false and r.code == "input-disabled", r.error)
  r = request("input.end", { interaction = IA }, nil, B)
  check("input.end stays available while disabled", r.ok and r.result.alreadyEnded == true, J(r))
  check("input.status, releaseAll and recover stay available while disabled", request("input.status", {}, nil, B).ok and request("input.releaseAll", {}, nil, B).ok and request("input.recover", {}, nil, B).ok)
  -- Error replies: a string error with a bracketed code also reports the code.
  r = request("input.press", { key = "STORE" }, nil, B)
  check("string errors report their bracketed code", r.ok == false and r.code == "input-disabled" and r.detail == nil, J(r))
  Main(nil, "input=fake"); Cleanup()
  request("input.close", {}, nil, B)
  fakeProfile.shortcutsActive = "true"
  Cmd, CmdObj = nil, nil
  state.input.unresolved = {}
  for _, rec in pairs(state.modules) do if rec.instance then rec.instance:dispose(0) end end
  state.running = false
end

-- Full server loop: sessions end on disconnect, and a flooding client cannot starve deadline servicing.
do
  local function queuedClient(lines, opts)
    opts = opts or {}
    local c = { settimeout = function() end, setoption = function() end, getpeername = function() return "127.0.0.1", 50000 end,
                send = function(_, data) return #data end, close = function() end, sent = {} }
    c.send = function(_, data) c.sent[#c.sent + 1] = data; return #data end
    c.receive = function()
      _G.FAKE_CLOCK_OFFSET = (_G.FAKE_CLOCK_OFFSET or 0) + 0.001  -- time passes with every socket read
      if #lines > 0 then return table.remove(lines, 1) end
      if opts.flood then return opts.flood end
      if opts.closeWhenDrained then return nil, "closed", "" end
      return nil, "timeout", ""
    end
    return c
  end
  local tapper = queuedClient({ J({ id = 1, op = "input.open", args = {} }), J({ id = 2, op = "input.tap", args = { key = "PLEASE", holdMs = 10 } }) })
  local flooder = queuedClient({}, { flood = J({ id = 3, op = "ping", args = {} }) })
  local leaver = queuedClient({ J({ id = 4, op = "input.open", args = {} }), J({ id = 5, op = "input.tap", args = { key = "STORE", holdMs = 3000 } }) }, { closeWhenDrained = true })
  local accepts = 0
  local fakeServer = { settimeout = function() end, close = function() end,
    accept = function()
      accepts = accepts + 1
      if accepts == 1 then return tapper elseif accepts == 2 then return flooder elseif accepts == 3 then return leaver end
      if accepts >= 8 then state.stopRequested = true end
      return nil
    end }
  local realBind = require("socket").bind
  require("socket").bind = function() return fakeServer end
  state.running = false
  _G.FAKE_CLOCK_OFFSET = 0
  local requestsBefore = state.requests
  local co = coroutine.create(function() Main(nil, "input=fake") end)
  local ok, err = coroutine.resume(co)
  local frames = 0
  while ok and coroutine.status(co) == "suspended" and frames < 200 do frames = frames + 1; ok, err = coroutine.resume(co) end
  assert(ok, err)
  require("socket").bind = realBind
  local fake = state.modules.hardkeys.fakeAdapter
  local kinds = {}
  for _, e in ipairs(fake.events) do kinds[#kinds + 1] = e.kind .. ":" .. e.pcKey end
  check("flooding client was served in bounded slices while the loop kept running", state.requests - requestsBefore >= 64 * 4 and frames >= 7, tostring(state.requests - requestsBefore) .. " requests in " .. frames .. " frames")
  check("tap deadline serviced during the flood (no starvation)", kinds[1] == "press:Enter" and (kinds[2] == "release:Enter" or kinds[3] == "release:Enter"), J(kinds))
  check("disconnecting client's hold released on disconnect", logFound("input: disconnect conn%-%d+ released conn%-%d+ STORE") ~= nil and not fake:isDown({ pcKey = "S" }), J(kinds))
  check("tapper's reply carried the hold", tapper.sent[2] and tapper.sent[2]:find('"kind":"tap"'), tapper.sent[2])
  check("shutdown closed the remaining sessions and stopped cleanly", state.running == false and state.modules.hardkeys.instance:status().state == "disposed" and #state.input.unresolved == 0 and next(fake.down) == nil, J(state.input.unresolved))
  _G.FAKE_CLOCK_OFFSET = 0
end

-------------------------------------------------------------------------------
-- KB-06: read-only feedback ops with Lua disabled, partial failures, displays, epochs
-------------------------------------------------------------------------------
do
  start("")  -- Lua off, input off: the feedback ops must still work
  state._loadModules(); state.running = true; state.stopRequested = false; state.ignoreNextCleanup = false
  check("kb06 precondition: Lua and input are disabled", state.lua.enabled == false and state.input.enabled == false)
  local fbConsole = { cmdtext = "Store ", blind = "true", pageNo = "3", showFile = "mcp-test-disposable", previewBar = { [1] = "false", [2] = "true" } }
  local function H(props, extra) local h = { name = props.name }; function h:Get(k) return props[k] end; if extra then for k, v in pairs(extra) do h[k] = v end end; return h end
  local seq5 = H({ name = "Main", No = "5" }, { HasActivePlayback = function() return false end, GetClass = function() return "Sequence" end, Addr = function() return "Sequence 5" end,
    GetFader = function(_, t) if t.token == "FaderMaster" then return 100 end error("unknown token") end, GetFaderText = function() return "100" end })
  local savedObjectList, savedRoot = ObjectList, Root
  CmdObj = function() return { cmdtext = fbConsole.cmdtext, lastcommand = "Go+ Sequence 5 : OK" } end
  ShowData = function() return { Masters = { Grand = { Blind = H({ FaderEnabled = fbConsole.blind }), Highlight = H({ FaderEnabled = "false" }), Solo = H({ FaderEnabled = "Unknown" }) } } } end
  CurrentExecPage = function() return H({ name = "Page 3", No = fbConsole.pageNo }) end
  GetExecutor = function(n) if n == 201 then return { Object = seq5 }, H({ name = "Page 3", No = "3" }) elseif n == 202 then return {}, H({ name = "Page 3", No = "3" }) end return nil, H({ name = "Page 3", No = "3" }) end
  SelectedSequence = function() return nil end
  ObjectList = function(ref) if ref == "Sequence 5" then return { seq5 } end return {} end
  GetDisplayByIndex = function(n) local v = fbConsole.previewBar[n]; if v then return H({ PreviewBarActive = v }) end return nil end
  Root = function() return { Get = function(_, k) if k == "MAState" then return fakeMaState end error("no console property " .. tostring(k)) end,
                             VirtualKeys = { Count = function() return 0 end }, MANetSocket = { Get = function(_, k) if k == "ShowFile" then return fbConsole.showFile end end }, maNetSocket = {} } end
  local C = { id = 61 }
  r = request("feedback.describe", {}, nil, C)
  check("feedback.describe lists readers with the module version, without Lua", r.ok and r.result.version == "0.5.0" and #r.result.readers == 21 and r.result.status.epoch == 1 and r.result.note:find("not an atomic snapshot"), J(r))
  r = request("feedback.read", {}, nil, C)
  check("feedback.read without items is refused with a code", r.ok == false and r.code == "no-items", r.error)
  r = request("feedback.read", { readers = { "commandText", "lastCommand", "blind", "solo", "page", "freeze", "selectedSequence", "previewBar", "sequenceActive" }, displays = { 1, 2, 9 }, executors = { 201, 202 }, sequences = { 5, 6 } }, nil, C)
  check("feedback.read answers with Lua disabled", r.ok and r.result.atomic == false and r.result.epoch == 1 and r.result.bridgeVersion == "0.17.0" and r.result.module.version == "0.5.0" and r.result.identity.showFile == "mcp-test-disposable", J(r))
  local by = {}
  if r.ok then for _, it in ipairs(r.result.items) do by[it.key] = it end end
  check("feedback.read: command text and last command are raw observations", by.commandText and by.commandText.value == "Store " and by.lastCommand.value == "Go+ Sequence 5 : OK" and by.lastCommand.note:find("not confirmation"), J(by.lastCommand))
  check("feedback.read: strict booleans, unrecognised value unavailable", by.blind.value == true and by.solo.available == false and by.solo.reason:find("unrecognised") and by.solo.value == nil, J(by.solo))
  check("feedback.read: page and no selected sequence", by.page.value.no == 3 and by.selectedSequence.available and by.selectedSequence.value.selected == false, J(by.selectedSequence))
  check("feedback.read: freeze unavailable with reason", by.freeze.available == false and by.freeze.reason:find("KB%-01"))
  check("feedback.read: one item per display, missing display unavailable", by["previewBar[display=1]"].value == false and by["previewBar[display=2]"].value == true and by["previewBar[display=9]"].available == false and by["previewBar[display=9]"].reason:find("display 9 does not exist"), J(by["previewBar[display=9]"]))
  check("feedback.read: executors expand to assignment and fader", by["executor[executor=201]"].value.assigned.name == "Main" and by["fader[executor=201]"].value.value == 100 and by["executor[executor=202]"].value.empty == true and by["fader[executor=202]"].available == false, J(by["fader[executor=202]"]))
  check("feedback.read: sequences expand to activity, unknown sequence unavailable", by["sequenceActive[sequence=5]"].value == false and by["sequenceActive[sequence=6]"].available == false and by["sequenceActive[sequence=6]"].reason:find("not found"), J(by["sequenceActive[sequence=6]"]))
  check("feedback.read: a parameterised reader named without parameters is a limitation, not a guess", #r.result.limitations == 1 and r.result.limitations[1]:find("sequenceActive needs parameters"), J(r.result.limitations))
  check("feedback.read: every item carries observedAt and epoch", (function() for _, it in ipairs(r.result.items) do if type(it.observedAt) ~= "number" or it.epoch ~= 1 then return false end end return true end)())
  -- Partial failure: one reader raising does not affect the others.
  CmdObj = function() error("CmdObj unavailable in this context") end
  r = request("feedback.read", { readers = { "commandText", "blind" } }, nil, C)
  check("feedback.read: a raising reader is reported per item, the rest succeed", r.ok and r.result.items[1].available == false and r.result.items[1].error:find("CmdObj unavailable") and r.result.items[2].value == true, J(r))
  -- Show change: the next read after identityCheckMs reports the invalidation and a new epoch.
  fbConsole.showFile = "other-show"
  _G.FAKE_CLOCK_OFFSET = (_G.FAKE_CLOCK_OFFSET or 0) + 2
  r = request("feedback.read", { readers = { "blind" } }, nil, C)
  check("feedback.read: a show change bumps the epoch and is reported", r.ok and r.result.invalidated == "show-changed" and r.result.epoch == 2 and r.result.items[1].epoch == 2 and r.result.identity.showFile == "other-show", J(r))
  -- Bounds: more executors than allowed are reported, not read.
  local many = {}
  for i = 1, 40 do many[i] = 100 + i end
  r = request("feedback.read", { executors = many }, nil, C)
  check("feedback.read: executors are bounded per request", r.ok and r.result.count == 64 and r.result.limitations[1]:find("executors truncated to 32 of 40"), J(r.result.limitations))
  r = request("feedback.read", { items = { "blind", { name = "previewBar", params = { display = 2 } }, { name = "executorActive", params = { sequence = 5 } } } }, nil, C)
  check("feedback.read: explicit items and the executorActive alias", r.ok and r.result.items[2].key == "previewBar[display=2]" and r.result.items[3].alias == "sequenceActive" and r.result.items[3].value == false, J(r))
  r = request("ping", {}, nil, C)
  check("feedback ops never touched input or the busy guard", r.ok and r.result.input.busy == nil and r.result.input.sessions == 0 and C.session == nil, J(r.result.input))
  -- A service() of the loop keeps the feedback instance alive and does no work without a watch.
  state._serviceModules(os.clock() + (_G.FAKE_CLOCK_OFFSET or 0))
  check("feedback module serviced by the loop without reads", state.modules.feedback.instance:status().serviced >= 1 and state.modules.feedback.instance:status().watched == 0)
  -- Module missing: the op reports it instead of failing obscurely.
  local fbRec = state.modules.feedback
  state.modules.feedback = { component = "gma3_mcp_feedback", loaded = false, error = "simulated" }
  r = request("feedback.read", { readers = { "blind" } }, nil, C)
  check("feedback.read without the module reports [no-feedback]", r.ok == false and r.code == "no-feedback" and r.error:find("simulated"), r.error)
  state.modules.feedback = fbRec
  ObjectList, Root = savedObjectList, savedRoot
  CmdObj, ShowData, CurrentExecPage, GetExecutor, SelectedSequence = nil, nil, nil, nil, nil
  GetDisplayByIndex = function(n) if n == 1 then return {} end return nil end
  for _, rec in pairs(state.modules) do if rec.instance then rec.instance:dispose(0) end end
  state.running = false
end


-------------------------------------------------------------------------------
-- KB-17: feedback.context / feedback.watch / feedback.unwatch with Lua and input disabled
-------------------------------------------------------------------------------
do
  start("")
  state._loadModules(); state.running = true; state.stopRequested = false; state.ignoreNextCleanup = false
  check("kb17 precondition: Lua and input are disabled", state.lua.enabled == false and state.input.enabled == false)
  local function H(props, items, class)
    local h = {}
    for k, v in pairs(props or {}) do h[k] = v end
    h.Get = function(_, k) return props[k] end
    h.GetClass = function() return class end
    h.Count = function() return items and #items or 0 end
    h.Ptr = function(_, i) return items and items[i] or nil end
    return h
  end
  local con = { bank = 3, page = 0, showFile = "mcp-test-disposable" }
  local presetBar = setmetatable({ Options = { PageSelector = setmetatable({}, { __index = function(_, k) if k == "SelectedItemValueI64" then return con.page end end }) },
                                   EncodersArea = { EncoderPlace1 = H({}, { H({}, { H({ Text = "R", Resolution = "Coarse" }, nil, "BandFader") }, "UILayoutGrid") }) },
                                   GetClass = function() return "PresetBar" end }, { __index = function(_, k) if k == "Context" then return "Default" end end })
  local selector = setmetatable({}, { __index = function(_, k) if k == "SelectedItemValueI64" then return con.bank end end })
  local display1 = { EncoderBarContainer = { EncoderBarGrid = { EncoderBarBase = { EncoderBarContainer = { EncoderBankSelector = selector } }, EncoderBar = H({}, { presetBar }) } } }
  local function enc(inner) return H({ InnerObject = inner, InnerObjectType = "0", OuterObject = inner, OuterObjectType = "0" }) end
  local banks = { H({ name = "Dimmer" }, { H({ name = "Dimmer" }, { enc("Attribute 1 'Dimmer'") }) }), H({ name = "Position" }, {}), H({ name = "Gobo" }, {}),
                  H({ name = "Color" }, { H({ name = "RGB" }, { enc("Attribute 107 'ColorRGB_R'"), enc("Attribute 108 'ColorRGB_G'") }) }) }
  local savedProfile, savedDisplay, savedRoot, savedExecPage, savedExecutor = CurrentProfile, GetDisplayByIndex, Root, CurrentExecPage, GetExecutor
  CurrentProfile = function()
    local p = savedProfile()
    p.EncoderBarPool = H({}, { H({ name = "EncoderBar 1" }, banks) })
    p.UserAttributePreferences = {}
    p.Get = function(_, k) if k == "Layer" then return "Absolute" end end
    return p
  end
  GetDisplayByIndex = function(n) if n == 1 then return display1 end return nil end
  Root = function() return { Get = function(_, k) if k == "MAState" then return fakeMaState end error("no console property " .. tostring(k)) end,
                             VirtualKeys = { Count = function() return 0 end }, MANetSocket = { Get = function(_, k) if k == "ShowFile" then return con.showFile end end }, maNetSocket = {},
                             ShowData = { LivePatch = { AttributeDefinitions = { Attributes = { ColorRGB_R = H({ Feature = "FeatureGroup 4 'Color'.Feature 1 'RGB'", PhysicalUnit = "None", NaturalReadout = "Percent", EncoderResolution = "Coarse", Color = "1,0,0,1", ChannelFunctions = "1" }) } } } } } end
  DataPool = function() return H({ name = "Default", No = "1" }) end
  SelectionCount = function() return 1 end
  SelectionFirst = function() return 63 end
  SelectionNext = function() return nil end
  GetUIChannels = function() return { 320, 321 } end
  GetAttributeByUIChannel = function(ui) return ({ [320] = { name = "ColorRGB_R" }, [321] = { name = "ColorRGB_G" } })[ui] end
  GetProgPhaser = function(ui) return ({ [320] = { { absolute = 50, channel_function = 0 } }, [321] = { {} } })[ui] end
  GetAttributeIndex = function(n) return ({ ColorRGB_R = 107, ColorRGB_G = 108 })[n] end
  local seq = H({ name = "Main", No = "5" }, nil, "Sequence")
  seq.Addr = function() return "Sequence 5" end
  seq.HasActivePlayback = function() return false end
  seq.GetFader = function(_, t) if t.token == "FaderMaster" then return 100 end error("unknown token") end
  seq.GetFaderText = function() return "100" end
  local execs = { [201] = H({ index = 201, KeyPress = "Temp", KeyUnpress = "", Fader = "Master", Encoder = "Master" }), [202] = H({ index = 202 }) }
  execs[201].Object = seq
  local pageH = H({ name = "Page 1", No = "1" }, { execs[201], execs[202] })
  CurrentExecPage = function() return pageH end
  GetExecutor = function(n) return execs[n], pageH end
  -- KB-21: page 2 is reachable through ObjectList only (the user is on page 1); page 9 does not exist.
  local execs2 = { [201] = H({ index = 201, KeyPress = "Go+", KeyUnpress = "", Fader = "Master", Encoder = "Master", Width = "2" }) }
  execs2[201].Object = seq
  local page2 = H({ name = "Page 2", No = "2" }, { execs2[201] })
  local savedObjectList = ObjectList
  ObjectList = function(ref)
    if ref == "Page 2" then return { page2 } elseif ref == "Page 2.201" then return { execs2[201] } elseif ref == "Page 2.202" or ref == "Page 9" or ref:match("^Page 9%.") then return {} end
    return savedObjectList(ref)
  end
  local C = { id = 71 }
  r = request("feedback.context", { executors = { 201, 202 } }, nil, C)
  check("feedback.context answers with Lua and input disabled", r.ok and r.result.bridgeVersion == "0.17.0" and r.result.module.version == "0.5.0" and r.result.atomic == false and r.result.generation == 1 and r.result.generationChanged == false and r.result.identity.showFile == "mcp-test-disposable" and r.result.identity.dataPool.name == "Default", J(r))
  check("feedback.context: authoritative display, bank/page, slots with availability and value", r.ok and r.result.authoritativeDisplay.rule == "configured" and r.result.encoder.value.bank.name == "Color" and r.result.encoder.value.page.name == "RGB" and r.result.slots.value.slots[1].name == "ColorRGB_R" and r.result.slots.value.slots[1].availability == "available" and r.result.slots.value.slots[1].absolute == 50 and r.result.slots.value.slots[1].unit == "None" and r.result.slots.value.slots[2].valueState == "empty" and r.result.executorPage.no == 1, J(r.result.slots))
  check("feedback.context: executor targets with functions, level and playback-target status", r.ok and #r.result.executors == 2 and r.result.executors[1].value.functions.keyPress == "Temp" and r.result.executors[1].value.level.value == 100 and r.result.executors[1].value.playbackTarget == true and r.result.executors[2].value.empty == true and r.result.executors[2].value.reserved == nil, J(r.result.executors))
  check("feedback.context: nested fields survive the serialiser depth bound", r.ok and type(r.result.slots.value.slots[1].feature) == "string" and type(r.result.executors[1].value.assigned.name) == "string")
  r = request("feedback.context", { display = 2 }, nil, C)
  check("feedback.context: a requested display without an encoder bar is unavailable, not replaced", r.ok and r.result.authoritativeDisplay.rule == "requested" and r.result.encoder.available == false and r.result.encoder.reason:find("display 2 does not exist") and r.result.generation == 1, J(r.result.encoder))
  r = request("feedback.context", { executors = "201" }, nil, C)
  check("feedback.context: malformed executors refused with a code", r.ok == false and r.code == "bad-args", r.error)
  r = request("feedback.context", { executors = { 201, 202 }, executorPage = 2 }, nil, C)
  check("kb21: feedback.context with executorPage reads that page through ObjectList while the user is on page 1 (mode page, width, coverage)", r.ok and r.result.executorMode == "page" and r.result.executorSpecPage == 2 and r.result.executorPage.no == 1 and r.result.executors[1].value.page.no == 2 and r.result.executors[1].value.mode == "page" and r.result.executors[1].value.width == 2 and r.result.executors[1].value.pool.name == "Default" and r.result.executors[2].value.coveredBy == 201 and r.result.executors[2].value.playbackTarget == false and r.result.bindingKey:find("page=2"), J(r.result.executors))
  r = request("feedback.context", { executors = { 201 }, executorPage = 9 }, nil, C)
  check("kb21: a page that does not exist is pageMissing, nothing is created", r.ok and r.result.executors[1].value.pageMissing == true and r.result.executors[1].value.playbackTarget == false, J(r.result.executors))
  r = request("feedback.context", { executors = { 201 }, executorPage = 0 }, nil, C)
  check("kb21: a bad executorPage is refused", r.ok == false and r.code == "bad-args", r.error)
  r = request("feedback.context", { executors = { 201, 202 } }, nil, C)
  check("kb21: without executorPage the executors follow the user's page (mode current)", r.ok and r.result.executorMode == "current" and r.result.executors[1].value.mode == "current" and r.result.executors[1].value.page.no == 1, J(r.result.executors))
  r = request("feedback.context", { display = 0 }, nil, C)
  check("feedback.context: display 0 refused", r.ok == false and r.code == "bad-args", r.error)
  con.bank = 0
  r = request("feedback.context", { executors = { 201, 202 } }, nil, C)
  check("feedback.context: a bank change moves the generation", r.ok and r.result.generation == 2 and r.result.generationChanged == true and r.result.encoder.value.bank.name == "Dimmer", J(r.result.encoder))
  r = request("feedback.watch", { executors = { 201 } }, nil, C)
  check("feedback.watch subscribes the snapshot items to the loop", r.ok and r.result.watched == 5 and state.modules.feedback.instance:status().watched == 5, J(r))
  r = request("feedback.context", { executors = { 201 }, cached = true }, nil, C)
  check("feedback.context cached before the loop ran: nothing observed, no generation claimed", r.ok and r.result.cached == true and r.result.notObserved == 5 and r.result.generation == nil and r.result.generationUnknown == true, J(r))
  local t = os.clock() + (_G.FAKE_CLOCK_OFFSET or 0)
  state._serviceModules(t); state._serviceModules(t + 0.2)
  r = request("feedback.context", { executors = { 201 }, cached = true }, nil, C)
  check("feedback.context cached after the loop observed every item", r.ok and r.result.notObserved == 0 and r.result.encoder.available and r.result.encoder.value.bank.name == "Dimmer" and r.result.executors[1].value.level.value == 100 and r.result.generation == 1 and type(r.result.encoder.ageMs) == "number", J(r))
  con.bank = 3
  state._serviceModules(t + 0.5); state._serviceModules(t + 0.7)
  r = request("feedback.context", { executors = { 201 }, cached = true }, nil, C)
  check("the loop follows a console change without any client request; the cached generation moves", r.ok and r.result.encoder.value.bank.name == "Color" and r.result.generation == 2 and r.result.generationChanged == true, J(r.result.encoder))
  r = request("feedback.unwatch", {}, nil, C)
  check("feedback.unwatch clears the watch", r.ok and r.result.watched == 0 and state.modules.feedback.instance:status().watched == 0, J(r))
  r = request("ping", {}, nil, C)
  check("context ops never touched input or the busy guard", r.ok and r.result.input.busy == nil and r.result.input.sessions == 0 and C.session == nil, J(r.result.input))
  local fbRec = state.modules.feedback
  state.modules.feedback = { component = "gma3_mcp_feedback", loaded = true, version = "0.2.0", instance = { readMany = function() end, status = function() return {} end } }
  r = request("feedback.context", {}, nil, C)
  check("an older feedback module reports [no-feedback] for the context op", r.ok == false and r.code == "no-feedback" and r.error:find("0.3.0 or newer"), r.error)
  state.modules.feedback = fbRec
  CurrentProfile, GetDisplayByIndex, Root, CurrentExecPage, GetExecutor = savedProfile, savedDisplay, savedRoot, savedExecPage, savedExecutor
  DataPool, SelectionCount, SelectionFirst, SelectionNext, GetUIChannels, GetAttributeByUIChannel, GetProgPhaser, GetAttributeIndex = nil, nil, nil, nil, nil, nil, nil, nil
  for _, rec in pairs(state.modules) do if rec.instance then rec.instance:dispose(0) end end
  state.running = false
end


-------------------------------------------------------------------------------
-- KB-18: control.* ops (continuous-control admission) over a fake binding
-------------------------------------------------------------------------------
do
  start("")
  state._loadModules(); state.running = true; state.stopRequested = false; state.ignoreNextCleanup = false
  check("kb18: the control module loads with the pair", state.modules.control and state.modules.control.loaded and state.modules.control.version == "0.4.0", state.modules.control and state.modules.control.error)
  check("kb18: control is disabled at a plain start", state.control.enabled == false and state.control.backend == nil)
  -- The binding source is this bridge's feedback instance; replace it with a controllable fake snapshot
  -- (the module's own harness covers the real readers; here the wiring is what is tested).
  local gen = 1
  local bindingKey = "display=1;executors=201"
  local snapshot = function()
    return { generation = gen, bindingKey = bindingKey, encoder = { available = true, value = { context = "Default", attributeEditing = true } }, slots = { available = true, value = { selection = { count = 1, fixtures = { 401 }, identityComplete = true }, slots = {
      { slot = 1, kind = "attribute", ref = "Attribute 1 'Dimmer'", name = "Dimmer", layer = "Absolute", resolution = "Coarse", readout = "Percent", channelFunction = "Dimmer", availability = "available" } } } },
      executors = { { available = true, value = { executor = 201, page = 1, empty = false, playbackTarget = true, assigned = { addr = "Sequence 1" }, functions = { keyPress = "Go+", fader = "Master" }, level = { token = "FaderMaster", value = 0 } } } } }
  end
  local fbRec = state.modules.feedback
  local watched
  state.modules.feedback = { component = "gma3_mcp_feedback", loaded = true, version = "0.3.0", module = fbRec.module,
    instance = { contextSnapshot = function() return snapshot() end, watchContext = function(_, spec) watched = spec; return { watched = 5, limitations = {} } end,
                 status = function() return { config = {} } end, service = function() return {} end, dispose = function() end, unwatch = function() end } }
  local consoleCmds = {}
  Cmd = function(c) consoleCmds[#consoleCmds + 1] = c; return "OK" end
  local C, D = { id = 81 }, { id = 82 }
  local function tnow() return os.clock() + (_G.FAKE_CLOCK_OFFSET or 0) end
  local brev = 1  -- the bridge's binding can be replaced (control.bind), so every motion/down carries the revision
  local ev = function(seq, extra)
    local e = { type = "relative", device = "nxk", control = "Rotary1", seq = seq, generation = gen, binding = brev, target = { slot = 1 }, delta = 1, gesture = 1 }
    for k, v in pairs(extra or {}) do e[k] = v end
    if extra and extra.noBinding then e.binding = nil; e.noBinding = nil end
    return e
  end
  local r = request("control.submit", { events = { ev(1) } }, nil, C)
  check("control.submit is refused while control is disabled", r.ok == false and r.code == "control-disabled" and r.error:find("control=fake"), r.error)
  r = request("control.status", {}, nil, C)
  check("control.status answers while disabled, with the limitations", r.ok and r.result.controlEnabled == false and #r.result.limitations == 4 and r.result.inputEnabled == false, J(r))
  r = request("ping", {}, nil, C)
  check("ping carries the control summary", r.ok and r.result.control.enabled == false and r.result.control.sessions == 0, J(r.result.control))
  Main(nil, "control"); Cleanup()
  check("'control' alone is refused", lastLog():find("refusing argument") and lastLog():find("control=fake"), lastLog())
  Main(nil, "control=keyboard"); Cleanup()
  check("an unknown control backend is refused", lastLog():find("control=fake, control=console or control=off"), lastLog())
  Main(nil, "control=fake"); Cleanup()
  check("'control=fake' while running enables the fake backend", state.control.enabled == true and state.control.backend == "fake" and logFound("control now enabled on the fake backend") ~= nil, lastLog())
  r = request("control.submit", { events = { ev(1) } }, nil, C)
  check("without a binding motion is binding-unknown (bind first)", r.ok and r.result.refused == 1 and r.result.outcomes[1].refused == "binding-unknown" and r.result.outcomes[1].message:find("bind"), J(r))
  r = request("control.bind", { executors = { 201 } }, nil, C)
  check("control.bind watches the context and reports the generation", r.ok and r.result.generation == 1 and r.result.watched == 5 and watched.executors[1] == 201 and state.control.spec.executors[1] == 201, J(r))
  check("control.bind reports the binding revision (review 6)", r.result.binding == 1 and r.result.bindingKey ~= nil, J(r.result))
  r = request("control.bind", { display = 0 }, nil, C)
  check("control.bind validates its arguments", r.ok == false and r.code == "bad-args", r.error)
  r = request("control.bind", { executors = { 201 }, executorPage = 2 }, nil, C)
  check("kb21: control.bind passes executorPage into the watched spec", r.ok and watched.executorPage == 2 and state.control.spec.executorPage == 2, J({ r, watched }))
  check("kb21: the control module's binding source is the same page-bound spec (live bug: the key named no page)", (function()
    local seen
    local fbi = state.modules.feedback.instance
    local saved = fbi.contextSnapshot
    fbi.contextSnapshot = function(self, spec, t, opts) seen = spec; return saved(self, spec, t, opts) end
    state.modules.control.instance:bindingInfo(tnow())
    fbi.contextSnapshot = saved
    return seen and seen.executorPage == 2 and seen.executors[1] == 201 end)())
  r = request("control.bind", { executors = { 201 }, executorPage = -1 }, nil, C)
  check("kb21: control.bind refuses a bad executorPage", r.ok == false and r.code == "bad-args", r.error)
  r = request("control.bind", { executors = { 201 } }, nil, C)
  check("kb21: rebinding without executorPage follows the page again", r.ok and watched.executorPage == nil and state.control.spec.executorPage == nil, J(watched))
  r = request("control.submit", { events = { ev(1), ev(2), ev(3, { delta = -1 }), ev(4, { generation = 9 }), ev(5) } }, nil, C)
  check("a batch is admitted in order: coalesced, a stale generation refused in place, the rest admitted", r.ok and r.result.accepted == 4 and r.result.refused == 1 and r.result.outcomes[2].coalesced == true and r.result.outcomes[4].refused == "stale-generation" and r.result.outcomes[4].generation == 1 and r.result.outcomes[5].coalesced == true and r.result.session == "conn-81", J(r))
  r = request("control.status", {}, nil, C)
  check("the session was opened on demand with one coalesced intent queued", r.ok and r.result.yourSession == "conn-81" and r.result.sessions["conn-81"].queued == 1 and r.result.busy and r.result.busy.reason == "motion", J(r.result.sessions))
  r = request("cmd", { command = "Clear" }, nil, D)
  check("a queued/moving gesture makes cmd [busy] for every connection", r.ok == false and r.code == "busy" and r.error:find("input ownership is active") and r.detail.reason == "motion", J(r))
  r = request("control.submit", { events = { { type = "touch", device = "mtouch", control = "Strip1", seq = 1, generation = gen, binding = brev, target = { executor = 201, element = "fader" }, down = true, gesture = 2 } } }, nil, C)
  check("a touch down is admitted", r.ok and r.result.accepted == 1, J(r))
  state._serviceModules(tnow() + 0.1)
  r = request("control.status", {}, nil, C)
  check("the loop applied the queued intents through the fake backend", r.ok and r.result.counters.applied == 2 and r.result.lastApplied.kind == "touch" and r.result.sessions["conn-81"].queued == 0, J(r.result.counters))
  check("the fake backend recorded the merged delta", state.modules.control.instance._adapter.intents[1].delta == 2 and state.modules.control.instance._adapter.intents[1].events == 4 and state.modules.control.instance._adapter.intents[1].lost == 1, J(state.modules.control.instance._adapter.intents))
  _G.FAKE_CLOCK_OFFSET = (_G.FAKE_CLOCK_OFFSET or 0) + 1
  r = request("cmd", { command = "Clear" }, nil, D)
  check("while the touch is down cmd stays [busy] with the gesture", r.ok == false and r.code == "busy" and r.detail.reason == "touch-down", J(r))
  r = request("control.submit", { events = { { type = "absolute", device = "mtouch", control = "Strip1", seq = 2, generation = gen, binding = brev, target = { executor = 201, element = "fader" }, value = 0.5, gesture = 2 } } }, nil, D)
  check("another connection is refused the touched target (conflict)", r.ok and r.result.outcomes[1].refused == "conflict" and r.result.outcomes[1].owner == "conn-81", J(r))
  -- The hardkeys owner blocks motion from other sessions.
  Main(nil, "input=fake"); Cleanup()
  r = request("input.begin", {}, nil, D)
  check("kb18: an input interaction of another connection is open", r.ok, J(r))
  r = request("control.submit", { events = { ev(6, { device = "nxk2" }) } }, nil, C)
  check("motion is refused while another input owner is busy", r.ok and r.result.outcomes[1].refused == "busy" and r.result.outcomes[1].owner == "conn-82", J(r))
  r = request("control.submit", { events = { { type = "touch", device = "mtouch", control = "Strip1", seq = 3, generation = gen, binding = brev, target = { executor = 201, element = "fader" }, down = false, gesture = 2 } } }, nil, C)
  check("the release is admitted regardless", r.ok and r.result.outcomes[1].accepted and r.result.outcomes[1].boundary, J(r))
  request("input.end", { interaction = r.ok and "i1" or nil }, nil, D); request("input.close", {}, nil, D)
  -- A generation move drops queued motion before it is applied.
  r = request("control.submit", { events = { ev(7, { gesture = 3 }) } }, nil, C)
  gen = 2
  state._serviceModules(tnow() + 0.01)
  r = request("control.status", {}, nil, C)
  check("queued motion from the old generation is dropped by the loop, never applied", r.ok and r.result.counters.staleDropped == 1 and r.result.counters.applied == 3, J(r.result.counters))
  r = request("control.submit", { events = { ev(8, { gesture = 4, generation = 1 }) } }, nil, C)
  check("a stale event is refused with the current generation", r.ok and r.result.outcomes[1].refused == "stale-generation" and r.result.outcomes[1].generation == 2, J(r))
  r = request("control.submit", { events = { ev(9, { gesture = 4, generation = 2 }) } }, nil, C)
  check("the rebound event is admitted", r.ok and r.result.accepted == 1, J(r))
  -- Review 6: a replaced spec is a new binding revision even when its generation number repeats.
  bindingKey = "display=1;executors=202"
  r = request("control.bind", { executors = { 202 } }, nil, C)
  check("rebinding to another spec with the same generation number moves the revision", r.ok and r.result.binding == 2 and r.result.generation == 2, J(r.result))
  r = request("control.submit", { events = { ev(10, { gesture = 5, generation = 2, noBinding = true }) } }, nil, C)
  check("an event without a revision is refused binding-required on the bridge (its binding is mutable)", r.ok and r.result.outcomes[1].refused == "binding-required", J(r))
  brev = 2
  r = request("control.submit", { events = { ev(13, { gesture = 5, generation = 2, binding = 1 }) } }, nil, C)
  check("an event carrying the old revision is refused stale-binding with the new one", r.ok and r.result.outcomes[1].refused == "stale-binding" and r.result.outcomes[1].binding == 2, J(r))
  r = request("control.status", {}, nil, C)
  check("the queued event from the old binding was dropped and status reports the revision", r.ok and r.result.sessions["conn-81"].queued == 0 and r.result.binding.revision == 2 and r.result.counters.staleDropped >= 2, J(r.result.counters))
  r = request("control.submit", { events = { ev(14, { gesture = 6, generation = 2 }) } }, nil, C)
  check("an event carrying the current revision is admitted", r.ok and r.result.accepted == 1, J(r))
  state._serviceModules(tnow() + 0.01)
  -- Disconnect ends the connection's gestures.
  r = request("control.submit", { events = { { type = "button", device = "nxk", control = "Rotary1", seq = 15, generation = 2, binding = brev, binding = 2, target = { slot = 1 }, down = true } } }, nil, C)
  state._serviceModules(tnow() + 0.01)
  state.clients = { C }
  state._closeClient(1, "disconnect")
  r = request("control.status", {}, nil, D)
  check("a disconnect ends the connection's button through the backend and forgets the session", r.ok and r.result.sessions["conn-81"] == nil and state.modules.control.instance._adapter:last().kind == "button" and state.modules.control.instance._adapter:last().down == false and state.modules.control.instance._adapter:last().reason == "disconnect" and logFound("control: disconnect conn%-81: button on nxk/Rotary1 ended") ~= nil, lastLog())
  check("kb18: an idle instance is not busy", request("cmd", { command = "Clear" }, nil, D).ok == true)
  r = request("control.submit", { events = { { type = "x" } } }, nil, D)
  check("a malformed event is refused in place, the request succeeds", r.ok and r.result.outcomes[1].refused == "bad-event", J(r))
  local many = {}
  for i = 1, 33 do many[i] = ev(i, { device = "flood" }) end
  r = request("control.submit", { events = many }, nil, D)
  check("more than 32 events per request is bad-args", r.ok == false and r.code == "bad-args" and r.error:find("at most 32"), r.error)
  r = request("control.open", {}, nil, D)
  check("control.open on a connection with a session is session-exists", r.ok == false and r.code == "session-exists", r.error)
  r = request("control.close", {}, nil, D)
  check("control.close ends the session", r.ok and r.result.session == "conn-82" and request("control.renew", {}, nil, D).code == "no-session", J(r))
  Main(nil, "control status"); Cleanup()
  check("'control status' prints the summary", logFound("control=fake enabled sessions=0") ~= nil, lastLog())
  -- An unresolved release survives a stop and is adopted at the next control=fake start.
  r = request("control.submit", { events = { { type = "touch", device = "mtouch", control = "Strip1", seq = 20, generation = 2, binding = brev, target = { executor = 201, element = "fader" }, down = true, gesture = 9 } } }, nil, D)
  state._serviceModules(tnow() + 0.01)
  state.modules.control.instance._adapter:raiseNext("touch", "Keyboard() raised")
  Main(nil, "control=off"); Cleanup()
  r = request("control.status", {}, nil, D)
  check("'control=off' ends the touch; a release the backend raised on stays unresolved on the instance", state.control.enabled == false and r.ok and #r.result.unresolved == 1 and logFound("control: disable: touch on mtouch/Strip1 ended: unresolved") ~= nil, J(r.result.unresolved))
  check("control.submit after control=off is refused", request("control.submit", { events = { ev(1) } }, nil, D).code == "control-disabled")
  -- KB-19: the console backend applies relative motion on attribute slots through Cmd().
  Main(nil, "control=console"); Cleanup()
  check("kb19: 'control=console' enables the console backend", state.control.enabled == true and state.control.backend == "console" and logFound("control now enabled on the console backend") ~= nil, lastLog())
  r = request("control.status", {}, nil, D)
  check("kb19: control.status reports the console backend, its capabilities and calibration", r.ok and r.result.backend == "console" and r.result.capabilities.button == false and r.result.backendStatus.calibration.resolutions.Coarse == 1, J(r.result.backendStatus))
  consoleCmds = {}
  r = request("control.submit", { events = { ev(30, { gesture = 30, generation = 2, binding = brev }), ev(31, { gesture = 30, generation = 2, binding = brev }), ev(32, { gesture = 31, generation = 2, binding = brev, fine = true, delta = -3 }) } }, nil, D)
  check("kb19: two coalesced detents and a fine negative delta are admitted", r.ok and r.result.accepted == 3 and r.result.outcomes[2].coalesced == true, J(r))
  r = request("control.submit", { events = { { type = "button", device = "nxk", control = "Rotary1", seq = 33, generation = 2, binding = brev, target = { slot = 1 }, down = true } } }, nil, D)
  check("kb19: an encoder press is refused unsupported on the console backend (nothing pressed, nothing owned)", r.ok and r.result.outcomes[1].refused == "unsupported" and r.result.outcomes[1].backend == "console" and (function() local sv = request("control.status", {}, nil, D).result.sessions["conn-82"]; for _, g in ipairs(sv and sv.gestureList or {}) do if g.kind == "button" then return false end end return true end)(), J(r))
  state._serviceModules(tnow() + 0.01)
  check("kb19: the loop issued the selection-scoped adjustments through Cmd()", consoleCmds[1] == 'Attribute "Dimmer" At + 2' and consoleCmds[2] == 'Attribute "Dimmer" At - 0.3' and #consoleCmds == 2, J(consoleCmds))
  r = request("control.status", {}, nil, D)
  check("kb19: lastApplied carries the command and ping's summary names the console backend", r.ok and r.result.lastApplied.result.command == 'Attribute "Dimmer" At - 0.3' and r.result.backendStatus.counters.applied == 2 and request("ping", {}, nil, D).result.control.backend == "console", J(r.result.lastApplied))
  Main(nil, "control status"); Cleanup()
  check("kb19: 'control status' names the console backend", logFound("control=console enabled") ~= nil, lastLog())
  Main(nil, "control=fake"); Cleanup()
  check("kb19: switching back to the fake backend is logged and the module reports it", state.control.backend == "fake" and request("control.status", {}, nil, D).result.backend == "fake")
  Main(nil, "control=off"); Cleanup()
  state.clients = {}
  Cleanup()  -- the owning call's Cleanup: what the loop's end does on the console
  check("the stop keeps the unresolved release for the next run", #state.control.unresolved == 1 and state.control.unresolved[1].kind == "touch", J(state.control.unresolved))
  state.modules.feedback = fbRec
  start("control=fake")
  check("control=fake at start adopts the kept record; the failed bind keeps it again", logFound("adopted 1 unresolved release") ~= nil and #state.control.unresolved == 1 and logFound("kept for 'control recover'") ~= nil, lastLog())
  state._loadModules(); state.running = true; state.stopRequested = false; state.ignoreNextCleanup = false
  Main(nil, "control=fake"); Cleanup()
  check("the kept record is adopted again by the next control=fake", #state.control.unresolved == 0 and #request("control.status", {}, nil, D).result.unresolved == 1)
  r = request("control.recover", {}, nil, D)
  check("control.recover re-attempts adopted releases through the backend", r.ok and #r.result.resolved == 1 and #request("control.status", {}, nil, D).result.unresolved == 0 and state.modules.control.instance._adapter:last().reason == "recover", J(r))
  Cmd = nil
  for _, rec in pairs(state.modules) do if rec.instance then rec.instance:dispose(0) end end
  state.running = false
end

-------------------------------------------------------------------------------
-- Quickey bank (KB-12): operator-only provisioning through the plugin argument
-------------------------------------------------------------------------------
do
  -- Fake show data for the module's consoleDeps: a Quickey pool and one executor page addressed in
  -- command syntax ("Quickey 900", "Page 1.190"), created/deleted through Cmd().
  local pool, execs, cmds = {}, {}, {}
  for i = 190, 197 do execs[i] = { object = nil } end
  Enums.VirtualKeyCode = { [""] = 0, UNKNOWN = 0, MA1 = 1, STORE = 66, NUM5 = 72, THRU = 78, PLEASE = 84, OOPS = 86, UNDO = 86, CLEAR = 87, X1 = 19 }
  local function quickeyHandle(i)
    local q = pool[i]
    return { name = q.name, index = i, GetClass = function() return "Quickey" end,
             Get = function(_, k) if k == "Code" then return q.code elseif k == "Note" then return q.note elseif k == "Lock" then return false end end,
             Set = function(_, k, v) if k == "Code" then q.code = v elseif k == "Name" then q.name = v elseif k == "Note" then q.note = v end end }
  end
  local function execHandle(i)
    local x = execs[i]
    return { GetClass = function() return "Executor" end, Get = function(_, k) if k == "Object" then
      if type(x.object) == "number" then return pool[x.object] and quickeyHandle(x.object) or nil end
      return x.object end end }
  end
  ObjectList = function(ref)
    local qi = tostring(ref):match("^Quickey (%d+)$")
    if qi then return pool[tonumber(qi)] and { quickeyHandle(tonumber(qi)) } or {} end
    local page, ei = tostring(ref):match("^Page (%d+)%.(%d+)$")
    if page then return (page == "1" and execs[tonumber(ei)]) and { execHandle(tonumber(ei)) } or {} end
    return {}
  end
  Cmd = function(c)
    cmds[#cmds + 1] = c
    local si = c:match("^Store Quickey (%d+) /NoConfirmation$")
    if si then pool[tonumber(si)] = { name = "Quickey " .. si, code = "", note = "" }; return "OK" end
    local di = c:match("^Delete Quickey (%d+) /NoConfirmation$")
    if di then pool[tonumber(di)] = nil; return "OK" end
    local dp, de = c:match("^Delete Page (%d+)%.(%d+) /NoConfirmation$")
    if dp then execs[tonumber(de)].object = nil; return "OK" end
    local aq, ap, ae = c:match("^Assign Quickey (%d+) At Page (%d+)%.(%d+)$")
    if aq then execs[tonumber(ae)].object = tonumber(aq); return "OK" end
    return "OK"
  end
  DataPool = function() return { name = "Default" } end
  local prevRoot = Root
  Root = function() local r = prevRoot(); r.MANetSocket = { Get = function(_, k) if k == "ShowFile" then return "mcp-test-disposable" end end }; return r end
  local function countPool() local n = 0; for _ in pairs(pool) do n = n + 1 end; return n end

  Main(nil, "bank"); Cleanup()
  check("'bank' alone is refused", lastLog():find("expected bank=<quickey>/<page>.<first>"), lastLog())
  Main(nil, "bank=900"); Cleanup()
  check("a bank range without executors is refused", lastLog():find("bank=<quickey>/<page>"), lastLog())
  Main(nil, "bankcodes=qualified"); Cleanup()
  check("bankcodes needs a range", lastLog():find("needs a bank="), lastLog())
  state.input.bank = nil
  local before = #logs
  start("9800 input=fake bank=900/1.190-197")
  -- The start provisioned the bank, then the failed bind disposed the modules: the record is kept.
  check("bank provisioned at start from the plugin argument", logFound("bank provision: 8 Quickey%(s%) created, 0 reused", before) and countPool() == 8 and pool[907].code == "" and pool[907].name == "MCP RESERVED" and execs[190].object == 907 and execs[197].object == 907 and pool[900].code == "MA1" and pool[900].name == "MCP MA1" and pool[900].note:find("gma3_mcp_hardkeys%-bank v1 owner=gma3_mcp_bridge"), lastLog())
  check("the bank record is kept across the dispose", type(state.input.bank) == "table" and state.input.bank.id == "gma3_mcp_bridge@q900.e1.190-197" and logFound("bank record .* kept for the next start", before), J(state.input.bank and state.input.bank.id))
  before = #logs
  state._loadModules(); state.running = true; state.stopRequested = false; state.ignoreNextCleanup = false
  local hk = state.modules.hardkeys
  check("the kept record is adopted and re-verified at the next load, creating nothing", logFound("bank adopt: bank gma3_mcp_bridge@q900.e1.190%-197 state=ready codes=7", before) and hk.instance:bankStatus().state == "ready" and countPool() == 8, lastLog())
  local A = { id = 31 }
  local r = request("input.status", {}, nil, A)
  check("input.status reports the bank", r.ok and r.result.status.bank.provisioned == true and r.result.status.bank.codeCount == 7 and r.result.policy.bank.state == "ready" and r.result.policy.bank.qualified == 7, J(r.result.policy.bank))
  r = request("ping", {})
  check("ping.input summarises the bank", r.ok and r.result.input.bank.provisioned == true and r.result.input.bank.codes == 7, J(r.result.input))
  before = #logs
  Main(nil, "bank status"); Cleanup()
  check("'bank status' prints the bank and the qualified codes", logFound("bank status: bank gma3_mcp_bridge@q900", before) and logFound("bank code NUM5: Quickey 902 value 72 qualified tap=true hold=true chord=true", before) and logFound("bank excluded X1", before), lastLog())
  -- An operator edit is reported by verify and refuses the target; nothing is repaired.
  pool[902].code = "NUM6"
  before = #logs
  Main(nil, "bank verify"); Cleanup()
  check("'bank verify' reports the changed object", logFound("bank verify: bank .* state=degraded .* problems=1", before) and logFound("problem quickey 902: Code is NUM6", before) and pool[902].code == "NUM6", lastLog())
  pool[902].code = "NUM5"
  -- Re-provisioning the same range while running reuses the bank: nothing created.
  before = #logs
  Main(nil, "bank=900/1.190-197"); Cleanup()
  check("re-provisioning while a bank exists is refused as bank-exists", logFound("bank provision refused %[bank%-exists%]", before), lastLog())
  -- KB-13: the owned-Quickey backend through the bridge argument "input=quickey".
  before = #logs
  Main(nil, "input=quickey"); Cleanup()
  check("'input=quickey' switches the backend and the routing default together", state.input.backend == "quickey" and state.input.enabled == true and hk.instance:status().backend.name == "quickey" and hk.instance:routingReport().default == "quickkey" and logFound("input now enabled on the quickey backend", before), lastLog())
  r = request("ping", {})
  check("ping reports the quickey backend", r.ok and r.result.input.backend == "quickey" and r.result.input.bank.provisioned == true, J(r.result.input))
  r = request("input.open", {}, nil, A)
  local ncmd = #cmds
  r = request("input.tap", { key = "NUM5", holdMs = 20 }, nil, A)
  check("a tap through the bridge assigns the code's Quickey to the first reserved executor and presses it in the paged form", r.ok and r.result.hold.backend == "quickey" and r.result.hold.target.executor == 190 and r.result.hold.target.quickeyIndex == 902 and cmds[ncmd + 1] == "Assign Quickey 902 At Page 1.190" and cmds[ncmd + 2] == "Press Page 1.190" and #cmds == ncmd + 2, J({ r.result.hold.target, cmds[ncmd + 1], cmds[ncmd + 2] }))
  check("the executor now holds the code's Quickey", execs[190].object == 902)
  local savedOffset = _G.FAKE_CLOCK_OFFSET or 0
  _G.FAKE_CLOCK_OFFSET = savedOffset + 1
  local sv = hk.instance:service(require("socket").gettime())
  _G.FAKE_CLOCK_OFFSET = savedOffset
  check("the loop's service releases the tap on the recorded executor", cmds[#cmds] == "Unpress Page 1.190" and hk.instance:status().capacity.used == 0, J({ cmds[#cmds], sv, hk.instance:status().holds }))
  r = request("input.press", { key = "MA1" }, nil, A)
  check("a standalone hold still needs an interaction on this backend", r.ok == false and r.code == "interaction-required", J(r))
  r = request("input.tap", { key = "X1" }, nil, A)
  check("a code outside the bank is refused through the bridge, nothing issued", r.ok == false and r.code == "unavailable" and r.error:find("not in bank") and cmds[#cmds] == "Unpress Page 1.190", J(r))
  r = request("input.tap", { key = "MA" }, nil, A)
  check("the keyboard-only logical key MA is not a Quickey code", r.ok == false and r.code == "unsupported" and r.error:find("VirtualKeyCode"), J(r))
  r = request("input.status", {}, nil, A)
  check("input.status reports the backend's limitations and capabilities", r.ok and r.result.status.backend.name == "quickey" and r.result.status.backend.capabilities.keyboard == false and #r.result.status.backend.limitations >= 6 and r.result.status.routing.default == "quickkey", J(r.result.status.backend.capabilities))
  -- KB-15: the mixed backend through "input=mixed": the quickkey default plus Keyboard() overrides.
  before = #logs
  Main(nil, "input=mixed"); Cleanup()
  check("'input=mixed' attaches the mixed adapter with the quickkey default and every method available", state.input.backend == "mixed" and state.input.enabled == true and hk.instance:status().backend.name == "mixed" and hk.instance:routingReport().default == "quickkey" and hk.instance:routingReport().methods.shortcut.available == true and hk.instance:routingReport().methods.type.available == true and logFound("input now enabled on the mixed backend", before), lastLog())
  r = request("input.routing", { policy = { default = "quickkey", keys = { STORE = { method = "shortcut" }, THRU = { method = "type", text = "Thru " } } } }, nil, A)
  check("per-key overrides to the Keyboard() part are accepted on the mixed backend", r.ok and r.result.routing.keys.STORE.method == "shortcut" and r.result.routing.keys.THRU.method == "type", J(r))
  r = request("input.route", { key = "NUM5" }, nil, A)
  check("input.route names the part that would press NUM5", r.ok and r.result.route.dispatchBackend == "quickey" and r.result.route.effective == "quickkey", J(r.result))
  r = request("input.route", { key = "STORE" }, nil, A)
  check("...and STORE", r.ok and r.result.route.dispatchBackend == "keyboard" and r.result.route.effective == "shortcut-table", J(r.result))
  fakeProfile.shortcutsActive = "true"; keyboardCalls = {}
  r = request("input.begin", {}, nil, A)
  local IM = r.result.interaction.id
  r = request("input.press", { key = "NUM5", interaction = IM }, nil, A)
  check("a Quickey hold through the mixed backend is an executor press recording backend quickey", r.ok and r.result.hold.backend == "quickey" and cmds[#cmds] == "Press Page 1.190", J(r))
  r = request("input.press", { key = "STORE", interaction = IM }, nil, A)
  check("STORE (Keyboard() part) while the Quickey is held is refused as unqualified-mix; Keyboard() not called", r.ok == false and r.code == "unqualified-mix" and #keyboardCalls == 0, J(r))
  r = request("input.release", { key = "NUM5" }, nil, A)
  check("released on the executor", r.ok and cmds[#cmds] == "Unpress Page 1.190", J(r))
  r = request("input.press", { key = "STORE", interaction = IM }, nil, A)
  check("STORE now presses through Keyboard() and records backend keyboard", r.ok and r.result.hold.backend == "keyboard" and #keyboardCalls == 1 and keyboardCalls[1].kind == "press", J(r))
  r = request("input.press", { key = "NUM5", interaction = IM }, nil, A)
  check("a Quickey while STORE is held is refused, nothing issued", r.ok == false and r.code == "unqualified-mix" and cmds[#cmds] == "Unpress Page 1.190", J(r))
  request("input.release", { key = "STORE" }, nil, A)
  request("input.end", { interaction = IM }, nil, A)
  r = request("input.status", {}, nil, A)
  check("input.status lists the mixed rules and both parts' counters", r.ok and r.result.status.backend.name == "mixed" and r.result.status.backend.counters.quickey and r.result.status.backend.counters.keyboard and #r.result.status.backend.limitations > 10, J(r.result.status.backend.counters))
  before = #logs
  Main(nil, "input=fake"); Cleanup()
  check("switching back to the fake backend restores the shortcut default", state.input.backend == "fake" and hk.instance:routingReport().default == "shortcut", lastLog())
  -- Teardown is refused while a Quickey record is live, then removes only verified objects.
  hk.instance:configureRouting({ default = "quickkey" })
  r = request("input.open", {}, nil, A)
  r = request("input.begin", {}, nil, A)
  local press = request("input.press", { key = "NUM5", interaction = r.result.interaction.id }, nil, A)
  before = #logs
  Main(nil, "bank teardown"); Cleanup()
  check("'bank teardown' is refused while a Quickey hold is live", press.ok and logFound("bank teardown refused %[bank%-in%-use%]", before) and countPool() == 8, lastLog())
  request("input.releaseAll", {}, nil, A)
  pool[906].name = "renamed by operator"
  execs[190].object = { name = "MCP STORE", index = 55, GetClass = function() return "Quickey" end, Get = function() return "" end }  -- a same-named Quickey that is not ours
  before = #logs
  Main(nil, "bank teardown"); Cleanup()
  check("'bank teardown' removes verified Quickeys, clears our reserved executors, skips the edited object and the look-alike", logFound("bank teardown: 7 Quickey%(s%) removed, 7 executor%(s%) cleared, 2 object%(s%) skipped; the bank is PARTIAL", before) and countPool() == 1 and pool[906] ~= nil and execs[190].object ~= nil and execs[191].object == nil and state.input.bank ~= nil, lastLog())
  -- A restart in between: the partial record is adopted for cleanup, not dropped.
  before = #logs
  state._loadModules(); state.running = true; state.stopRequested = false; state.ignoreNextCleanup = false
  hk = state.modules.hardkeys
  check("a partial bank record is adopted at the next load for cleanup", logFound("bank adopt: bank gma3_mcp_bridge@q900.e1.190%-197 state=partial codes=1", before) and state.input.bank ~= nil and hk.instance:bankStatus().partial == true, lastLog())
  pool[906].name = "MCP CLEAR"
  before = #logs
  Main(nil, "bank teardown"); Cleanup()
  check("the second teardown completes and drops the record", logFound("the bank is gone", before) and countPool() == 0 and state.input.bank == nil, lastLog())
  execs[190].object = nil
  -- An unowned object in the range refuses the whole setup; nothing is created.
  pool[903] = { name = "Operator thing", code = "GO", note = "" }
  before = #logs
  Main(nil, "bank=900/1.190-197"); Cleanup()
  check("an unowned object in the range refuses provisioning with nothing created", logFound("bank provision refused %[bank%-preflight%]", before) and logFound("slot%-occupied 903", before) and countPool() == 1, lastLog())
  pool[903] = nil
  Cleanup()
end

-------------------------------------------------------------------------------
-- KB-14: routing ops, text routes and the temporary shortcut mode through the bridge
-------------------------------------------------------------------------------
do
  start("input=keyboard")
  state._loadModules(); state.running = true; state.stopRequested = false; state.ignoreNextCleanup = false
  local hk = state.modules.hardkeys
  local A, B = { id = 41 }, { id = 42 }
  request("input.open", {}, nil, A); request("input.open", {}, nil, B)
  fakeProfile.shortcutsActive = "true"; fakeProfile.writes = 0
  keyboardCalls = {}
  local r = request("input.routing", {}, nil, A)
  check("input.routing without a policy reports the current policy (module default shortcut, type available on the keyboard backend)", r.ok and r.result.routing.default == "shortcut" and r.result.routing.methods.type.available == true and r.result.routing.capabilities.modeChange == true, J(r))
  r = request("input.routing", { policy = { keys = { STORE = { method = "nope" } } } }, nil, A)
  check("an invalid policy is refused with its code and changes nothing", r.ok == false and r.code == "policy-invalid" and hk.instance:routingReport().overrideCount == 0, r.error)
  r = request("input.routing", { policy = { keys = { STORE = { method = "type", text = "Store " } } } }, nil, A)
  check("a policy with a text route is accepted and logged", r.ok and r.result.routing.keys.STORE.method == "type" and logFound("routing policy replaced by conn%-41") ~= nil, J(r))
  r = request("input.route", { key = "STORE" }, nil, B)
  check("input.route reports the text route with the mode change it needs (shortcuts on -> off)", r.ok and r.result.route.effective == "text" and r.result.route.modeChange.target == false and r.result.route.dispatchable == true, J(r))
  r = request("input.route", {}, nil, B)
  check("input.route needs a key", r.ok == false and r.error:find("bad%-argument"), r.error)
  r = request("input.tap", { key = "STORE" }, nil, A)
  check("a text-route tap writes the mode off, sends the characters through Keyboard('char') and is retained", r.ok and r.result.hold.kind == "text" and r.result.hold.state == "retained" and r.result.hold.text.typed == 6 and fakeProfile.shortcutsActive == "false" and fakeProfile.writes == 1 and #keyboardCalls == 6 and keyboardCalls[1].kind == "char" and keyboardCalls[1].key == "S" and keyboardCalls[6].key == " ", J({ hold = r.result and r.result.hold, calls = keyboardCalls }))
  r = request("ping", {}, nil, B)
  check("ping.input reports the active mode change and the retained record", r.ok and r.result.input.modeChange and r.result.input.modeChange.state == "active" and r.result.input.modeChange.target == false and r.result.input.retained == 1, J(r.result.input))
  r = request("cmd", { command = "Go+ Sequence 1" }, nil, B)
  check("a pending restoration does not make the guarded ops busy", r.ok == true, r.error)
  _G.FAKE_CLOCK_OFFSET = (_G.FAKE_CLOCK_OFFSET or 0) + 0.2
  state._serviceModules(require("socket").gettime() + _G.FAKE_CLOCK_OFFSET)
  r = request("input.status", {}, nil, A)
  check("the loop restored the mode after the delay and released the record", fakeProfile.shortcutsActive == "true" and fakeProfile.writes == 2 and r.result.status.modeChange == nil and r.result.status.lastModeChange.restoredBy == "service" and r.result.status.holds[#r.result.status.holds].state == "released", J(r.result.status.lastModeChange))
  check("ping.input shows no mode change afterwards", request("ping", {}, nil, B).result.input.modeChange == nil)
  -- A shortcut-table hold with shortcuts off: temporary enable for the hold through the bridge.
  request("input.routing", { policy = {} }, nil, A)
  fakeProfile.shortcutsActive = "false"
  keyboardCalls = {}
  r = request("input.begin", { leaseMs = 60000 }, nil, A)
  local IA = r.result.interaction.id
  r = request("input.press", { key = "STORE", interaction = IA }, nil, A)
  check("STORE with shortcuts off: enabled for the hold, pressed through Keyboard()", r.ok and r.result.hold.state == "held" and r.result.hold.modeOp ~= nil and fakeProfile.shortcutsActive == "true" and keyboardCalls[1].kind == "press" and keyboardCalls[1].key == "S", J(r))
  r = request("input.routing", { policy = { default = "shortcut" } }, nil, B)
  check("the policy is not changed by another connection while A holds a key", r.ok == false and r.error:find("busy"), r.error)
  r = request("input.release", { key = "STORE" }, nil, A)
  check("released and retained while the mode is still enabled", r.ok and r.result.hold.state == "retained" and fakeProfile.shortcutsActive == "true", J(r.result.hold))
  _G.FAKE_CLOCK_OFFSET = _G.FAKE_CLOCK_OFFSET + 0.2
  state._serviceModules(require("socket").gettime() + _G.FAKE_CLOCK_OFFSET)
  check("the mode is restored to off after the release", fakeProfile.shortcutsActive == "false" and hk.instance:status().modeChange == nil)
  request("input.end", { interaction = IA }, nil, A)
  -- An unresolved restoration (profile switched meanwhile) blocks the guarded ops and survives a restart.
  fakeProfile.shortcutsActive = "true"
  request("input.routing", { policy = { keys = { STORE = { method = "type", text = "Store " } } } }, nil, A)
  r = request("input.tap", { key = "STORE" }, nil, A)
  fakeProfile.name = "Other"
  _G.FAKE_CLOCK_OFFSET = _G.FAKE_CLOCK_OFFSET + 0.2
  state._serviceModules(require("socket").gettime() + _G.FAKE_CLOCK_OFFSET)
  r = request("ping", {}, nil, B)
  check("a profile switch leaves the restoration unresolved; nothing written; busy for everyone", r.ok and r.result.input.modeChange.state == "unresolved" and r.result.input.busy.reason == "restoration" and fakeProfile.shortcutsActive == "false" and fakeProfile.writes == 5, J(r.result.input))
  r = request("lua", { code = "return 1" }, nil, B)
  check("lua is refused while the restoration is unresolved", r.ok == false and r.code == "busy" and r.detail.reason == "restoration", r.error)
  r = request("input.tap", { key = "STORE" }, nil, A)
  check("new input is refused too", r.ok == false and r.code == "busy" and r.detail.reason == "restoration", r.error)
  r = request("input.recover", {}, nil, A)
  check("the owner's recover on the other profile does not write and stays unresolved", r.ok and r.result.restoration.state == "unresolved" and fakeProfile.writes == 5, J(r.result.restoration))
  state.clients = { A, B }
  Cleanup()
  check("the owning-call Cleanup keeps the unresolved restoration for the next start", state.running == false and type(state.input.mode) == "table" and state.input.mode.profile == "Default" and state.input.mode.original == true and state.input.mode.keptReason == "cleanup" and logFound("keeping the unresolved keyboard%-shortcut mode restoration") ~= nil, J(state.input.mode))
  start("input=keyboard")
  state._loadModules(); state.running = true; state.stopRequested = false; state.ignoreNextCleanup = false
  hk = state.modules.hardkeys
  check("the next start adopts it as unresolved (previous-run) and says so", state.input.mode == nil and hk.instance:status().modeChange and hk.instance:status().modeChange.owner == "previous-run" and logFound("from a previous run is unresolved") ~= nil, J(hk.instance:status().modeChange))
  fakeProfile.name = "Default"
  Main(nil, "input recover"); Cleanup()
  check("the operator's input recover restores the original state on the original profile", fakeProfile.shortcutsActive == "true" and hk.instance:status().modeChange == nil and logFound("mode restoration m%d+ restored") ~= nil, lastLog())
  request("input.close", {}, nil, A); request("input.close", {}, nil, B)
  Main(nil, "stop"); Cleanup()
end

print(string.format("%d passed, %d failed", passes, failures))
print(failures == 0 and "ALL PASSED" or "FAILED")
os.exit(failures == 0 and 0 or 1)
