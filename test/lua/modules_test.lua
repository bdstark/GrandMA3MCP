-- Regression harness for plugin/gma3_mcp_hardkeys.lua and plugin/gma3_mcp_feedback.lua under stock Lua.
--
-- The modules are loaded the way the bridge's KB-02 loader loads them (a plain chunk returning a
-- module table) with no console API present at all, which proves loading and instance creation touch
-- nothing. Readers and the key resolver are exercised against fake dependencies.
--
-- Run from the repository root:   lua test/lua/modules_test.lua

local here = (arg and arg[0] or ""):match("^(.*)[/\\]") or "."
package.path = here .. "/?.lua;" .. package.path
local json = require("json")

local failures, passes = 0, 0
local function check(name, cond, detail)
  if cond then passes = passes + 1; print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end

-- Any access to a console global while loading is a failure: _G has none of them, so a strict
-- metatable turns a stray read into an error.
local strict = setmetatable({}, { __index = function(_, k) error("module touched global '" .. tostring(k) .. "' while loading") end })
local function loadChunk(file)
  local f = assert(io.open(here .. "/../../plugin/" .. file, "rb")); local src = f:read("a"); f:close()
  local env = setmetatable({}, { __index = function(_, k)
    local v = _G[k]
    if v ~= nil then return v end
    return strict[k]
  end })
  local chunk = assert(load(src, "=" .. file, "t", env))
  return chunk, src
end
local signals = {}
local function loadModule(file)
  local chunk = loadChunk(file)
  return chunk("test_plugin", (file:gsub("%.lua$", "")), signals, nil)
end

local HK = loadModule("gma3_mcp_hardkeys.lua")
local FB = loadModule("gma3_mcp_feedback.lua")
check("hardkeys loads without console API", type(HK) == "table" and HK.API_VERSION == 1 and HK.VERSION == "0.3.0" and type(HK.new) == "function")
check("feedback loads without console API", type(FB) == "table" and FB.API_VERSION == 1 and FB.VERSION == "0.1.0" and type(FB.new) == "function")
check("module tables are read-only", not pcall(function() HK.state = {} end) and not pcall(function() FB.cache = {} end) and HK.state == nil)
check("modules publish nothing globally", package.loaded["gma3_mcp_hardkeys"] == nil and _G.gma3_mcp_hardkeys == nil and _G.gma3_mcp_feedback == nil)
check("modules register in the plugin signal table under their NAME", signals.__gma3_mcp_modules.gma3_mcp_hardkeys == HK and signals.__gma3_mcp_modules.gma3_mcp_feedback == FB)
-- A second plugin instance (another signal table) gets its own module tables, as on the console.
local signals2 = {}
local HK2 = loadChunk("gma3_mcp_hardkeys.lua")("other_plugin", "gma3_mcp_hardkeys", signals2, nil)
check("another plugin instance gets a distinct module table", HK2 ~= HK and signals2.__gma3_mcp_modules.gma3_mcp_hardkeys == HK2 and signals.__gma3_mcp_modules.gma3_mcp_hardkeys == HK)
check("chunk without a signal table still returns the module", type(loadChunk("gma3_mcp_feedback.lua")("x", "y", nil, nil).new) == "function")

-------------------------------------------------------------------------------
-- Lifecycle and isolation
-------------------------------------------------------------------------------
-- Dependencies that count every call: new()/init()/status() must not call any of them.
local function countingDeps(impl)
  local calls = {}
  local d = {}
  for k, fn in pairs(impl) do d[k] = function(...) calls[k] = (calls[k] or 0) + 1; return fn(...) end end
  return d, calls
end

local hkDeps, hkCalls = countingDeps({ shortcutRows = function() return {} end, virtualKeyCodes = function() return {} end, Keyboard = function() error("input sent") end })
local a = HK.new({ owner = "consumer-a", deps = hkDeps })
local b = HK.new({ owner = "consumer-b", deps = hkDeps })
check("new() requires an owner", not pcall(HK.new, {}) and not pcall(HK.new, { owner = "" }))
check("unknown backend refused", not pcall(HK.new, { owner = "x", backend = "osc" }))
check("instances are distinct objects", a ~= b and a:status().owner == "consumer-a" and b:status().owner == "consumer-b")
check("service() before init() is an error", not pcall(a.service, a, 0))
a:init(); b:init()
check("status after init", a:status().state == "ready" and a:status().holdCount == 0 and a:status().inputEnabled == false and a:status().backend.dispatches == false)
a:service(1.0); a:service(2.0)
check("servicing is per instance", a:status().counters.serviced == 2 and b:status().counters.serviced == 0)
a._holds["h1"] = { id = "h1", seq = 1, state = "held", session = "s", pcKey = "Enter", tupleKey = "Enter|s0c0a0n0", pressedAt = 1, dispatch = { attempts = 0 } }
check("mutable state is not shared between instances", b:status().holdCount == 0 and a:status().holdCount == 1 and a:status().capacity.used == 1)
check("no dependency was called by new/init/status/service", next(hkCalls) == nil, json.encode(hkCalls))
local disposed = a:dispose()
check("dispose without a clock hands the record back unresolved and is idempotent", a:status().state == "disposed" and a:status().holdCount == 0 and disposed.holds == 1 and disposed.records[1].pcKey == "Enter" and a:dispose().holds == 0, json.encode(disposed))
check("disposed instance refuses service and describeKey", not pcall(a.service, a, 3) and not pcall(a.describeKey, a, "PLEASE"))
check("disposing one instance leaves the other usable", b:service(3.0).released ~= nil and b:status().state == "ready")
local ok, missing = b:backendAvailable()
check("backend availability only inspects deps", ok == true and #missing == 0 and (hkCalls.Keyboard or 0) == 0)
local c = HK.new({ owner = "c" }):init()
local okB, missingB = c:backendAvailable()
check("missing Keyboard reported, not called", okB == false and missingB[1] == "Keyboard")
check("describeKey without readers is unsupported, not an error", c:describeKey("PLEASE").supported == false and c:describeKey("PLEASE").reason:find("not provided"))

-------------------------------------------------------------------------------
-- Key resolution against the KB-01 default profile (row shapes as read live on onPC 2.5.1)
-------------------------------------------------------------------------------
local VK = { PLEASE = 84, STORE = 66, ESC = 88, CLEAR = 87, OOPS = 86, EXEC = 35, NUM0 = 67, NUM5 = 72, NUM9 = 76, MA1 = 1, MA2 = 2 }
local rows = {
  { shortcut = "Ctrl+Alt+S", keyCode = 11 },
  { shortcut = "Ctrl+F1", keyCode = 35, executorIndex = 101 },
  { shortcut = "Alt+F1", keyCode = 35, executorIndex = 201 },
  { shortcut = "Ctrl+Alt+F1", keyCode = 35, executorIndex = 301 },
  { shortcut = "S", keyCode = 66 },
  { shortcut = "5", keyCode = 72 },
  { shortcut = "Enter", keyCode = 84 },
  { shortcut = "Ctrl+Z", keyCode = 86 },
  { shortcut = "Delete", keyCode = 87 },
  { shortcut = "Escape", keyCode = 88 },
  { shortcut = "Enter", keyCode = 84 },
  { shortcut = "Backspace", keyCode = 86 },
}
local function res(name, opts) return HK.resolve(rows, VK, name, opts) end
local r = res("PLEASE")
check("PLEASE -> Enter via the native redirect route, no modifiers", r.supported and r.pcKey == "Enter" and not r.shift and not r.ctrl and not r.alt and r.source == "native" and r.redirectChecked == false, json.encode(r))
r = HK.resolve(rows, VK, "PLEASE", { redirects = { PLEASE = "Enter" } })
check("PLEASE native route checks the VirtualKey redirect when readable", r.supported and r.redirectChecked == true, json.encode(r))
r = HK.resolve(rows, VK, "PLEASE", { redirects = { PLEASE = "None" } })
check("PLEASE unsupported when the redirect no longer names Enter", r.supported == false and r.reason:find("redirect"), json.encode(r))
r = HK.resolve({ { shortcut = "Enter", keyCode = 66 } }, VK, "PLEASE")
check("PLEASE unsupported (ambiguous) when the table maps plain Enter to another MA key", r.supported == false and r.reason:find("ambiguous"), json.encode(r))
r = HK.resolve({ { shortcut = "S", keyCode = 66 }, { shortcut = "T", keyCode = 66 } }, VK, "STORE")
check("two different shortcuts with equal modifier count are ambiguous, never guessed", r.supported == false and r.reason:find("ambiguous") and #r.candidates == 2, json.encode(r))
r = HK.resolve({ { shortcut = "S", keyCode = 66 }, { shortcut = "S", keyCode = 66 } }, VK, "STORE")
check("duplicate rows with the same shortcut text are one route", r.supported and r.pcKey == "S", json.encode(r))
r = HK.resolve(rows, VK, "STORE", { keyboardCodes = { Enter = 257 } })
check("a shortcut naming a PC key outside Enums.KeyboardCodes is unsupported", r.supported == false and r.reason:find("KeyboardCodes"), json.encode(r))
r = HK.resolve(rows, VK, "STORE", { keyboardCodes = { S = 83 } })
check("PC key validated against Enums.KeyboardCodes when given", r.supported and r.pcKeyValidated == true, json.encode(r))
r = res("store")
check("case-insensitive STORE -> S", r.supported and r.pcKey == "S" and r.key == "STORE", json.encode(r))
r = res("OOPS")
check("OOPS prefers the unmodified row (Backspace over Ctrl+Z)", r.supported and r.pcKey == "Backspace" and r.ctrl == false, json.encode(r))
r = res("NUM5")
check("NUM5 -> 5", r.supported and r.pcKey == "5", json.encode(r))
r = res("EXEC", { executor = 101 })
check("EXEC 101 -> Ctrl+F1 with ctrl flag", r.supported and r.pcKey == "F1" and r.ctrl == true and r.alt == false and r.executor == 101, json.encode(r))
r = res("EXEC", { executor = 301 })
check("EXEC 301 -> Ctrl+Alt+F1", r.supported and r.ctrl and r.alt and r.pcKey == "F1", json.encode(r))
r = res("EXEC")
check("EXEC without executor is unsupported", r.supported == false and r.reason:find("opts.executor"), json.encode(r))
r = res("EXEC", { executor = 999 })
check("EXEC for an unmapped executor is unsupported", r.supported == false and r.reason:find("999"), json.encode(r))
r = res("MA")
check("MA -> LeftShift without the shift flag, verified via MASTATE", r.supported and r.pcKey == "LeftShift" and r.shift == false and r.verify == "MASTATE" and r.source == "fixed", json.encode(r))
r = res("MA1")
check("MA1 unsupported with reason", r.supported == false and r.reason:find("one MA state"), json.encode(r))
r = res("MA2")
check("MA2 unsupported", r.supported == false)
r = res("FREEZE")
check("unknown key unsupported", r.supported == false and r.reason:find("not a logical key"), json.encode(r))
r = HK.resolve({ { shortcut = "Enter", keyCode = 84 } }, VK, "CLEAR")
check("remapped-away key is unsupported, never substituted", r.supported == false and r.reason:find("no keyboard shortcut maps to CLEAR"), json.encode(r))
r = HK.resolve(nil, VK, "CLEAR")
check("missing table is unsupported, not an error", r.supported == false)
r = HK.resolve(rows, {}, "CLEAR")
check("missing VirtualKeyCode is unsupported", r.supported == false and r.reason:find("unknown on this console"))
r = res(42)
check("non-string key name handled", r.supported == false)
local p = HK.parseShortcut("Ctrl+Alt+F1")
check("parseShortcut splits modifiers", p.key == "F1" and p.ctrl and p.alt and not p.shift)
check("parseShortcut rejects two keys", select(1, HK.parseShortcut("A+B")) == nil)

-- An instance reads the table only when asked, and reports shortcut enablement alongside.
local liveDeps, liveCalls = countingDeps({ shortcutRows = function() return rows end, virtualKeyCodes = function() return VK end, shortcutsActive = function() return false end })
local d = HK.new({ owner = "d", deps = liveDeps }):init()
check("no table read before describeKey", (liveCalls.shortcutRows or 0) == 0)
r = d:describeKey("PLEASE")
check("describeKey reads live table and reports shortcutsActive", r.supported and r.shortcutsActive == false and liveCalls.shortcutRows == 1, json.encode(r))
local failing = HK.new({ owner = "e", deps = { shortcutRows = function() error("boom") end, virtualKeyCodes = function() return VK end } }):init()
r = failing:describeKey("PLEASE")
check("reader failure reported as unsupported", r.supported == false and r.reason:find("boom"), json.encode(r))

-- consoleDeps builds closures only; nothing is called until used.
local touched = {}
local fakeEnv = setmetatable({}, { __index = function(_, k) touched[#touched + 1] = k; return nil end })
local cd = HK.consoleDeps(fakeEnv)
check("hardkeys consoleDeps touches nothing but reads the Keyboard field", type(cd.shortcutRows) == "function" and type(cd.profileName) == "function" and type(cd.displayExists) == "function" and #touched == 1 and touched[1] == "Keyboard", json.encode(touched))

-------------------------------------------------------------------------------
-- Feedback readers
-------------------------------------------------------------------------------
local function fakeHandle(props, extra)
  local h = { name = props.name }
  function h:Get(k) return props[k] end
  if extra then for k, v in pairs(extra) do h[k] = v end end
  return h
end
local grand = { Blind = fakeHandle({ FaderEnabled = "true" }), Highlight = fakeHandle({ FaderEnabled = false }), Solo = fakeHandle({ FaderEnabled = "false" }) }
local fbDeps, fbCalls = countingDeps({
  cmdObj = function() return { cmdtext = "Store Cue 1", lastcommand = "Please : OK" } end,
  showData = function() return { Masters = { Grand = grand } } end,
  currentProfile = function() return { Environments = fakeHandle({ ActiveEnvironment = "Preview" }), KeyboardShortCuts = fakeHandle({ KeyboardShortcutsActive = true }) } end,
  root = function() return fakeHandle({ MAState = "false" }) end,
  currentExecPage = function() return fakeHandle({ name = "Page 1", No = "1" }) end,
  display = function() error("no display handle") end,
  sequence = function(n) if n == 10 then return { HasActivePlayback = function() return true end } end end,
})
local f1 = FB.new({ owner = "f1", deps = fbDeps })
local f2 = FB.new({ owner = "f2", deps = fbDeps })
check("feedback new() requires owner", not pcall(FB.new, {}))
check("feedback read() before init() is an error", not pcall(f1.read, f1, "blind"))
f1:init(); f2:init()
check("nothing read before a read() call", next(fbCalls) == nil)
r = f1:read("blind")
check("blind read normalises 'true'", r.available and r.value == true and r.scope == "show", json.encode(r))
r = f1:read("solo")
check("solo 'false' string is false and available", r.available and r.value == false, json.encode(r))
r = f1:read("highlight")
check("boolean false is kept", r.available and r.value == false)
r = f1:read("commandText")
check("command text", r.value == "Store Cue 1" and r.scope == "ui")
r = f1:read("previewMode")
check("preview environment", r.value == "Preview" and r.scope == "profile")
r = f1:read("maState")
check("MA state read as observed state", r.value == false and r.source:find("not ownership"))
r = f1:read("page")
check("page reader", r.value.name == "Page 1" and r.value.no == 1, json.encode(r))
r = f1:read("freeze")
check("freeze is unavailable with a reason, never false", r.available == false and r.value == nil and r.reason:find("KB%-01"), json.encode(r))
r = f1:read("previewBar")
check("reader error reported, not substituted", r.available == false and r.error:find("no display handle") and r.value == nil, json.encode(r))
r = f1:read("executorActive", { sequence = 10 })
check("executorActive with parameter", r.available and r.value == true, json.encode(r))
r = f1:read("executorActive", { sequence = 11 })
check("executorActive unknown sequence reported", r.available == false and r.error:find("not found"), json.encode(r))
r = f1:read("executorActive")
check("executorActive without parameter reported", r.available == false and r.error:find("params.sequence"), json.encode(r))
r = f1:read("nope")
check("unknown reader reported", r.available == false and r.error:find("unknown reader"))
local all = f1:readAll()
check("readAll covers every parameterless reader", all.blind and all.freeze and all.previewBar and all.executorActive == nil and all.maState, json.encode(all))
check("read counts are per instance", f1:status().reads > 10 and f2:status().reads == 0)
f1:dispose()
check("disposed feedback instance refuses reads, other instance unaffected", not pcall(f1.read, f1, "blind") and f2:read("blind").value == true)
check("feedback status lists readers", #f2:status().readers == #FB.READERS and f2:status().module == "gma3_mcp_feedback")
-- Reader lists handed out are copies: editing one must not reach another instance.
local f3 = FB.new({ owner = "f3", deps = fbDeps }):init()
local list = f2:readers(); list[1] = "bogus"; table.remove(list, #list)
local st = f2:status(); st.readers[2] = "bogus2"
FB.READERS[1] = "bogus3"
local okAll, allAfter = pcall(f3.readAll, f3)
check("mutating a returned reader list does not affect other instances", okAll and allAfter.blind ~= nil and allAfter.bogus == nil and f3:readers()[1] == "blind" and #f3:readers() == 12, json.encode({ okAll, allAfter and allAfter.blind and allAfter.blind.value }))
touched = {}
local fcd = FB.consoleDeps(fakeEnv)
check("feedback consoleDeps touches no console function at build time", type(fcd.cmdObj) == "function" and #touched == 0, json.encode(touched))

print(string.format("%d passed, %d failed", passes, failures))
print(failures == 0 and "ALL PASSED" or "FAILED")
os.exit(failures == 0 and 0 or 1)
