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
check("hardkeys loads without console API", type(HK) == "table" and HK.API_VERSION == 1 and HK.VERSION == "0.4.0" and type(HK.new) == "function")
check("feedback loads without console API", type(FB) == "table" and FB.API_VERSION == 1 and FB.VERSION == "0.2.0" and type(FB.new) == "function")
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
-- Collisions (review of PR #9): the chosen tuple must not be claimed for another target anywhere.
r = HK.resolve({ { shortcut = "S", keyCode = 66 }, { shortcut = "S", keyCode = 87 } }, VK, "STORE")
check("S mapped to STORE and to CLEAR is a collision: STORE refused, nothing guessed", r.supported == false and r.reason:find("collision") and #r.collisions == 1, json.encode(r))
r = HK.resolve({ { shortcut = "S", keyCode = 66 }, { shortcut = "S", keyCode = 87 } }, VK, "CLEAR")
check("the colliding CLEAR is refused too", r.supported == false and r.reason:find("collision"), json.encode(r))
r = HK.resolve({ { shortcut = "Ctrl+F1", keyCode = 35, executorIndex = 101 }, { shortcut = "Ctrl+F1", keyCode = 35, executorIndex = 102 } }, VK, "EXEC", { executor = 101 })
check("the same EXEC shortcut with two executor identities is a collision", r.supported == false and r.reason:find("executor 102"), json.encode(r))
r = HK.resolve({ { shortcut = "Ctrl+F1", keyCode = 35, executorIndex = 101 }, { shortcut = "Ctrl+F1", keyCode = 35, executorIndex = 101, specialExec = 3 } }, VK, "EXEC", { executor = 101 })
check("a SpecialExec row on the same tuple is a collision", r.supported == false and r.reason:find("special 3"), json.encode(r))
r = HK.resolve({ { shortcut = "Ctrl+F1", keyCode = 35, executorIndex = 101 }, { shortcut = "Alt+F1", keyCode = 35, executorIndex = 102 } }, VK, "EXEC", { executor = 101 })
check("different modifier tuples do not collide", r.supported and r.pcKey == "F1" and r.ctrl == true, json.encode(r))
r = HK.resolve({ { shortcut = "LeftShift", keyCode = 66 } }, VK, "MA")
check("a shortcut row claiming LeftShift collides with the fixed MA route", r.supported == false and r.reason:find("collision"), json.encode(r))
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
-- Feedback readers (KB-06: value meaning, partial failures, displays, freshness, bounded polling)
-------------------------------------------------------------------------------
local function fakeHandle(props, extra)
  local h = { name = props.name }
  function h:Get(k) return props[k] end
  if extra then for k, v in pairs(extra) do h[k] = v end end
  return h
end
local grand = { Blind = fakeHandle({ FaderEnabled = "true" }), Highlight = fakeHandle({ FaderEnabled = false }), Solo = fakeHandle({ FaderEnabled = "false" }) }
local console = { showFile = "show-a", user = "Admin", profile = "Default", cmdtext = "Store Cue 1", maState = "false", pageNo = "1" }
local seq10 = fakeHandle({ name = "Main", No = "10" }, { HasActivePlayback = function() return true end, GetClass = function() return "Sequence" end, Addr = function() return "Sequence 10" end,
  GetFader = function(_, t) if t.token == "FaderMaster" then return 42.5 end error("no token " .. tostring(t.token)) end, GetFaderText = function() return "42.5" end })
local seq11 = fakeHandle({ name = "Odd", No = "11" }, { HasActivePlayback = function() return "maybe" end, GetFader = function() return "n/a" end })
local execs = { [101] = { Object = seq10 }, [102] = {}, [103] = { Object = seq11 } }
local pageH = fakeHandle({ name = "Page 1", No = "1" })
local fbDeps, fbCalls = countingDeps({
  cmdObj = function() return { cmdtext = console.cmdtext, lastcommand = "Please : OK" } end,
  showData = function() return { Masters = { Grand = grand } } end,
  currentProfile = function() return { name = console.profile, Environments = fakeHandle({ ActiveEnvironment = "Preview" }), KeyboardShortCuts = fakeHandle({ KeyboardShortcutsActive = true }) } end,
  root = function() return fakeHandle({ MAState = console.maState }) end,
  currentExecPage = function() return fakeHandle({ name = "Page 1", No = console.pageNo }) end,
  display = function(n) if n == 1 then return fakeHandle({ PreviewBarActive = "false" }) elseif n == 2 then return fakeHandle({ PreviewBarActive = "true" }) elseif n == 3 then error("display 3 exploded") end return nil end,
  sequence = function(n) if n == 10 then return seq10 elseif n == 11 then return seq11 end end,
  executor = function(n) local e = execs[n]; if e then return e, pageH end return nil, pageH end,
  selectedSequence = function() return seq10 end,
  showFile = function() return console.showFile end,
  userName = function() return console.user end,
  profileName = function() return console.profile end,
})
local f1 = FB.new({ owner = "f1", deps = fbDeps })
local f2 = FB.new({ owner = "f2", deps = fbDeps })
check("feedback new() requires owner", not pcall(FB.new, {}))
check("feedback new() refuses unknown config keys", not pcall(FB.new, { owner = "x", config = { bogus = 1 } }) and not pcall(FB.new, { owner = "x", config = { maxItems = -1 } }))
check("feedback read() before init() is an error", not pcall(f1.read, f1, "blind"))
f1:init(); f2:init()
check("nothing read before a read() call", next(fbCalls) == nil)
r = f1:read("blind", nil, 10)
check("blind read normalises 'true' and carries observedAt/epoch", r.available and r.value == true and r.scope == "show" and r.observedAt == 10 and r.epoch == 1 and r.key == "blind", json.encode(r))
r = f1:read("solo")
check("solo 'false' string is false and available", r.available and r.value == false, json.encode(r))
r = f1:read("highlight")
check("boolean false is kept", r.available and r.value == false)
grand.Blind = fakeHandle({ FaderEnabled = "Maybe" })
r = f1:read("blind")
check("unrecognised value is unavailable with a reason, never false", r.available == false and r.value == nil and r.reason:find("unrecognised value Maybe") and r.reason:find("not as false"), json.encode(r))
grand.Blind = fakeHandle({ FaderEnabled = 2 })
r = f1:read("blind")
check("numbers other than 0/1 are unavailable", r.available == false and r.reason:find("unrecognised"), json.encode(r))
grand.Blind = fakeHandle({})
r = f1:read("blind")
check("nil property is unavailable with the nothing-returned reason", r.available == false and r.reason:find("returned nothing"), json.encode(r))
grand.Blind = fakeHandle({ FaderEnabled = "true" })
check("toBool exported: strict", FB.toBool("True") == true and FB.toBool(0) == false and FB.toBool("yes") == nil and select(2, FB.toBool("yes")):find("unrecognised"))
r = f1:read("commandText")
check("command text is raw text", r.value == "Store Cue 1" and r.scope == "ui" and r.note:find("not inferred"))
r = f1:read("lastCommand")
check("last command is an observation, not confirmation", r.value == "Please : OK" and r.note:find("not confirmation"))
r = f1:read("previewMode")
check("preview environment", r.value == "Preview" and r.scope == "profile")
r = f1:read("maState")
check("MA state read as observed aggregate state", r.value == false and r.note:find("not ownership") and r.scope == "console")
r = f1:read("page")
check("page reader", r.value.name == "Page 1" and r.value.no == 1, json.encode(r))
r = f1:read("selectedSequence")
check("selected sequence identified", r.available and r.value.selected == true and r.value.name == "Main" and r.value.no == 10 and r.scope == "user", json.encode(r))
r = f1:read("freeze")
check("freeze is unavailable with a reason, never false", r.available == false and r.value == nil and r.reason:find("KB%-01"), json.encode(r))

-- Displays: the default display is identified, other displays are validated, failures are per display.
r = f1:read("previewBar")
check("previewBar defaults to display 1 and identifies it", r.available and r.value == false and r.params.display == 1 and r.key == "previewBar[display=1]" and r.scope == "display", json.encode(r))
r = f1:read("previewBar", { display = 2 })
check("previewBar on display 2", r.available and r.value == true and r.params.display == 2 and r.key == "previewBar[display=2]", json.encode(r))
r = f1:read("previewBar", { display = 7 })
check("missing display is unavailable with a reason", r.available == false and r.reason:find("display 7 does not exist") and r.params.display == 7, json.encode(r))
r = f1:read("previewBar", { display = 3 })
check("reader error reported per display, not substituted", r.available == false and r.error:find("display 3 exploded") and r.value == nil, json.encode(r))
r = f1:read("previewBar", { display = 0 })
check("display 0 refused", r.available == false and r.error:find("positive integer"), json.encode(r))
r = f1:read("previewBar", { display = "2" })
check("display as text refused (no coercion)", r.available == false and r.error:find("positive integer"), json.encode(r))
r = f1:read("previewBar", 1)
check("params that are not a table are reported per item, not raised", r.available == false and r.error:find("params must be a table") and r.key == "previewBar[invalid-params]", json.encode(r))

-- Sequence activity, executor assignment and fader level stay separate readers.
r = f1:read("sequenceActive", { sequence = 10 })
check("sequenceActive with parameter", r.available and r.value == true and r.key == "sequenceActive[sequence=10]" and r.note:find("not proof"), json.encode(r))
r = f1:read("sequenceActive", { sequence = 11 })
check("sequenceActive with an unrecognised HasActivePlayback is unavailable", r.available == false and r.reason:find("unrecognised"), json.encode(r))
r = f1:read("sequenceActive", { sequence = 12 })
check("sequenceActive unknown sequence is unavailable with a reason", r.available == false and r.reason:find("not found"), json.encode(r))
r = f1:read("sequenceActive")
check("sequenceActive without parameter reported as an error", r.available == false and r.error:find("params.sequence"), json.encode(r))
r = f1:read("executorActive", { sequence = 10 })
check("executorActive is a compatibility alias of sequenceActive and says so", r.available and r.value == true and r.name == "executorActive" and r.alias == "sequenceActive" and r.note:find("deprecated") and r.note:find("not executor button state"), json.encode(r))
r = f1:read("executor", { executor = 101 })
check("executor assignment", r.available and r.value.assigned.name == "Main" and r.value.assigned.class == "Sequence" and r.value.empty == false and r.value.page.name == "Page 1" and r.scope == "page" and r.key == "executor[executor=101]", json.encode(r))
r = f1:read("executor", { executor = 102 })
check("empty executor is an available value", r.available and r.value.empty == true and r.value.assigned == nil, json.encode(r))
r = f1:read("executor", { executor = 199 })
check("unknown executor is an available empty value with the page", r.available and r.value.empty == true and r.value.page.name == "Page 1", json.encode(r))
r = f1:read("executor")
check("executor without parameter is an error", r.available == false and r.error:find("params.executor"), json.encode(r))
execs[104] = setmetatable({}, { __index = function(_, k) if k == "Object" then error("Object read exploded") end end })
r = f1:read("executor", { executor = 104 })
check("a raising Object read is unavailable with the error, never an empty executor", r.available == false and r.error:find("Object read exploded") and r.value == nil, json.encode(r))
r = f1:read("fader", { executor = 104 })
check("fader of an executor whose Object read raises is an error, not 'no assigned object'", r.available == false and r.error:find("Object read exploded"), json.encode(r))
execs[104] = nil
r = f1:read("fader", { executor = 101 })
check("fader level via executor", r.available and r.value.value == 42.5 and r.value.text == "42.5" and r.value.token == "FaderMaster" and r.value.target.name == "Main" and r.key == "fader[executor=101]", json.encode(r))
r = f1:read("fader", { sequence = 10, token = "FaderMaster" })
check("fader level via sequence", r.available and r.value.value == 42.5 and r.key == "fader[sequence=10]", json.encode(r))
r = f1:read("fader", { executor = 101, token = "FaderX" })
check("unknown token is an error, not zero", r.available == false and r.error:find("no token FaderX") and r.key == "fader[executor=101,token=FaderX]", json.encode(r))
r = f1:read("fader", { executor = 102 })
check("fader of an empty executor is unavailable", r.available == false and r.reason:find("no assigned object"), json.encode(r))
r = f1:read("fader", { executor = 103 })
check("non-numeric fader is unavailable, not zero", r.available == false and r.reason:find("not a level"), json.encode(r))
r = f1:read("fader")
check("fader without target is an error", r.available == false and r.error:find("params.executor or params.sequence"), json.encode(r))
r = f1:read("nope")
check("unknown reader reported", r.available == false and r.reason:find("unknown reader"))
local all = f1:readAll(20)
check("readAll covers every parameterless reader incl. previewBar on display 1", all.blind and all.freeze and all.previewBar and all.previewBar.params.display == 1 and all.selectedSequence and all.sequenceActive == nil and all.executor == nil and all.fader == nil and all.executorActive == nil and all.maState and all.maState.observedAt == 20, json.encode(all))
check("read counts are per instance", f1:status().reads > 10 and f2:status().reads == 0)

-- Partial failures: one failing reader never invalidates the others; items are read in order.
local brokenDeps = {}
for k, v in pairs(fbDeps) do brokenDeps[k] = v end
brokenDeps.cmdObj = function() error("CmdObj is gone") end
local fb = FB.new({ owner = "fb", deps = brokenDeps }):init()
local many = fb:readMany({ { name = "commandText" }, { name = "blind" }, { name = "previewBar", params = { display = 2 } }, { name = "bogus" }, { name = "fader", params = { executor = 101 } } }, 30)
check("readMany reports partial failures per item", many.count == 5 and many.items[1].available == false and many.items[1].error:find("CmdObj is gone") and many.items[2].available and many.items[2].value == true and many.items[3].value == true and many.items[4].available == false and many.items[5].value.value == 42.5, json.encode(many))
check("readMany is not atomic and says so, with identity and epoch", many.atomic == false and many.observedAt == 30 and many.epoch == 1 and many.identity.showFile == "show-a" and many.identity.profile == "Default" and many.identity.user == "Admin", json.encode(many))
many = fb:readMany({ { name = "previewBar", params = 1 }, { name = "sequenceActive", params = { sequence = "x" } }, { name = "commandText" }, { name = "blind" } }, 32)
check("a malformed item does not abort the batch: the following items are still read", many.count == 4 and many.items[1].available == false and many.items[1].error:find("params must be a table") and many.items[2].available == false and many.items[2].error:find("params.sequence") and many.items[3].error:find("CmdObj is gone") and many.items[4].value == true, json.encode(many))
local wb = FB.new({ owner = "wb", deps = fbDeps }):init()
local wbs = wb:watch({ { name = "previewBar", params = 1 }, { name = "blind" }, "solo" }, 1)
wb:service(1)
snap = wb:snapshot(1)
check("watch() tolerates a malformed item and a bare name; service reports the bad one unavailable and reads the rest", wbs.watched == 3 and #snap.items == 3 and snap.items[1].key == "previewBar[invalid-params]" and snap.items[1].available == false and snap.items[2].value == true and snap.items[3].value == false, json.encode(snap.items))
local small = FB.new({ owner = "small", deps = fbDeps, config = { maxItems = 2 } }):init()
many = small:readMany({ { name = "blind" }, { name = "solo" }, { name = "highlight" } }, 31)
check("readMany is bounded by maxItems and reports the truncation", many.count == 2 and many.truncated == 1, json.encode(many))

-- Request expansion (shared with the bridge op): subsets, displays, bounded executors.
local items, lim = FB.itemsFor({ readers = { "blind", "previewBar", "sequenceActive" }, displays = { 1, 2 }, executors = { 101, 102 }, sequences = { 10 }, tokens = { "FaderMaster", "SpeedMaster" } })
local keys = {}
for _, it in ipairs(items) do keys[#keys + 1] = FB.keyOf(it.name, it.params) end
check("itemsFor expands displays, executors with tokens and sequences", table.concat(keys, " ") == "blind previewBar[display=1] previewBar[display=2] executor[executor=101] fader[executor=101] fader[executor=101,token=SpeedMaster] executor[executor=102] fader[executor=102] fader[executor=102,token=SpeedMaster] sequenceActive[sequence=10]", table.concat(keys, " "))
check("itemsFor refuses parameterised readers without parameters", #lim == 1 and lim[1]:find("sequenceActive needs parameters"), json.encode(lim))
items, lim = FB.itemsFor({ executors = { 101, 102, 103 } }, { maxExecutors = 2 })
check("itemsFor bounds executors", #items == 4 and lim[1]:find("executors truncated to 2 of 3"), json.encode(lim))
items, lim = FB.itemsFor({ items = { "blind", { name = "previewBar", params = { display = 2 } }, 5 } })
check("itemsFor accepts names and {name, params}", #items == 2 and items[2].params.display == 2 and lim[1]:find("ignored"), json.encode(lim))
items = FB.itemsFor({ readers = { "previewBar" }, display = 2 })
check("single display shorthand", #items == 1 and items[1].params.display == 2)
items, lim = FB.itemsFor({ all = true, displays = { 1, 2 }, sequences = { 10 } })
keys = {}
for _, it in ipairs(items) do keys[#keys + 1] = FB.keyOf(it.name, it.params) end
check("itemsFor all=true expands every parameterless reader once per display plus the explicit targets", table.concat(keys, " ") == "blind commandText freeze highlight lastCommand maState page previewBar[display=1] previewBar[display=2] previewMode selectedSequence shortcutsActive solo sequenceActive[sequence=10]" and #lim == 0, table.concat(keys, " "))
check("describe lists readers with scope, source, params and the alias", (function()
  local d = FB.describe(); local byName = {}
  for _, e in ipairs(d) do byName[e.name] = e end
  return byName.fader and byName.fader.params[1] == "executor" and byName.freeze.unavailable and byName.executorActive.alias == "sequenceActive" and byName.previewBar.paramless == true and byName.sequenceActive.paramless == false
end)())

-- Freshness: watch a subset, service() does bounded work, snapshot() reports age and staleness, an
-- invalidation (consumer or observed show/profile change) drops cached observations.
local w = FB.new({ owner = "w", deps = fbDeps, config = { maxReadsPerService = 2, pollIntervalMs = 100, staleMs = 500, identityCheckMs = 1000 } }):init()
local ws = w:watch(FB.itemsFor({ readers = { "blind", "maState", "commandText", "previewBar" }, displays = { 1 }, executors = { 101 } }), 100)
check("watch records the bounded subset", ws.watched == 6 and ws.truncated == 0 and w:status().watched == 6, json.encode(ws))
local snap = w:snapshot(100)
check("snapshot before any service lists everything as not observed", #snap.items == 0 and #snap.notObserved == 6 and snap.notObserved[1].reason == "not observed yet", json.encode(snap))
local sv = w:service(100)
check("service reads at most maxReadsPerService items", sv.reads == 2 and sv.due == 4 and sv.watched == 6, json.encode(sv))
local readsBefore = w:status().reads
sv = w:service(100.01); sv = w:service(100.02)
check("round robin covers the rest over later calls", sv.reads == 2 and sv.due == 0 and w:status().reads == readsBefore + 4, json.encode(sv))
sv = w:service(100.03)
check("nothing is re-read before pollIntervalMs", sv.reads == 0 and sv.due == 0, json.encode(sv))
snap = w:snapshot(100.05)
check("snapshot carries the observations with ageMs and not stale", #snap.items == 6 and #snap.notObserved == 0 and snap.items[1].key == "blind" and snap.items[1].value == true and snap.items[1].ageMs == 50 and snap.items[1].stale == false and snap.atomic == false, json.encode(snap))
console.cmdtext = "Changed"
snap = w:snapshot(100.9)
local ct
for _, it in ipairs(snap.items) do if it.key == "commandText" then ct = it end end
check("a cached observation older than staleMs is reported stale and keeps its old observedAt", ct.stale == true and ct.value == "Store Cue 1" and ct.observedAt == 100.01 and ct.ageMs == 890, json.encode(ct))
sv = w:service(100.9)
check("due items are re-read after the interval", sv.reads == 2 and sv.due == 4, json.encode(sv))
w:service(100.91); w:service(100.92)
snap = w:snapshot(100.93)
for _, it in ipairs(snap.items) do if it.key == "commandText" then ct = it end end
check("re-read observation is current", ct.value == "Changed" and ct.stale == false and ct.observedAt == 100.91, json.encode(ct))
local e = w:invalidate("disconnect", 101)
snap = w:snapshot(101)
check("invalidate drops every cached observation and bumps the epoch", e == 2 and #snap.items == 0 and #snap.notObserved == 6 and snap.notObserved[1].reason:find("not observed since disconnect") and snap.epoch == 2 and w:status().lastInvalidation.reason == "disconnect", json.encode(snap))
w:service(101); w:service(101.01); w:service(101.02)
snap = w:snapshot(101.02)
check("observations after the invalidation carry the new epoch", #snap.items == 6 and snap.items[1].epoch == 2, json.encode(snap.items[1]))
console.showFile = "show-b"
sv = w:service(101.5)
check("show change is not noticed before identityCheckMs", sv.invalidated == nil and w:status().epoch == 2, json.encode(sv))
sv = w:service(102.1)
snap = w:snapshot(102.1)
check("a changed show file invalidates the cache (epoch 3)", sv.invalidated == "show-changed" and snap.epoch == 3 and #snap.notObserved == 6 - sv.reads and snap.notObserved[1].reason:find("show%-changed") and w:status().identity.showFile == "show-b", json.encode({ sv, snap.notObserved }))
console.profile = "Operator"
sv = w:service(103.2)
check("a profile change invalidates the cache", sv.invalidated == "profile-changed" and w:status().epoch == 4 and w:status().identity.profile == "Operator", json.encode(sv))
console.user = "Guest"
many = w:readMany({ { name = "blind" } }, 104.3)
check("readMany also notices an identity change and reports it", many.invalidated == "user-changed" and many.epoch == 5 and many.items[1].epoch == 5, json.encode(many))
local idDeps = {}
for k, v in pairs(fbDeps) do idDeps[k] = v end
idDeps.showFile = function() error("no socket") end
local w2 = FB.new({ owner = "w2", deps = idDeps }):init()
w2:service(1); w2:service(3)
check("an identity that was never readable is reported nil and is never a change by itself", w2:status().identity.showFile == nil and w2:status().identity.user == "Guest" and w2:status().epoch == 1 and w2:status().identityUncertain == nil, json.encode(w2:status()))
-- Review finding: A -> unreadable -> B must not hide the change nor serve A's values as current.
local flaky = { showFile = "show-A", fail = false }
local fDeps = {}
for k, v in pairs(fbDeps) do fDeps[k] = v end
fDeps.showFile = function() if flaky.fail then error("socket gone") end return flaky.showFile end
local w3 = FB.new({ owner = "w3", deps = fDeps, config = { maxReadsPerService = 8, identityCheckMs = 1000, staleMs = 5000 } }):init()
w3:watch(FB.itemsFor({ readers = { "blind" } }), 10); w3:service(10)
check("identity A observed and cached value fresh", w3:status().identity.showFile == "show-A" and w3:snapshot(10.1).items[1].stale == false)
flaky.fail = true
sv = w3:service(11.5)
snap = w3:snapshot(11.5)
check("identity becoming unreadable keeps the last known value, invalidates once and marks the snapshot uncertain", sv.invalidated == "identity-unreadable" and w3:status().identity.showFile == "show-A" and w3:status().identityUncertain[1] == "showFile" and #snap.items == 1 and snap.items[1].epoch == 2 and snap.items[1].stale == true and snap.identityUncertain[1] == "showFile", json.encode({ sv, w3:status().identity, snap.items }))
sv = w3:service(11.6); w3:service(13)
snap = w3:snapshot(13)
check("while uncertain, re-read observations are reported stale and no second invalidation happens", sv.invalidated == nil and #snap.items == 1 and snap.items[1].stale == true and snap.items[1].identityUncertain[1] == "showFile" and w3:status().epoch == 2, json.encode(snap.items[1]))
many = w3:readMany({ { name = "blind" } }, 13.1)
check("readMany reports the uncertain identity", many.identityUncertain[1] == "showFile" and many.identity.showFile == "show-A", json.encode(many))
flaky.fail = false; flaky.showFile = "show-B"
sv = w3:service(14.5)
snap = w3:snapshot(14.5)
check("A -> unreadable -> B invalidates as show-changed once readable again, nothing of A is served", sv.invalidated == "show-changed" and w3:status().epoch == 3 and w3:status().identity.showFile == "show-B" and w3:status().identityUncertain == nil and (#snap.items == 0 or snap.items[1].epoch == 3) and (#snap.items == 0 or snap.items[1].stale == false), json.encode({ sv, snap }))
flaky.fail = true; w3:service(16)
flaky.fail = false; sv = w3:service(17.5)
check("unreadable then the same value again clears the uncertainty without a show-changed", sv.invalidated == nil and w3:status().identityUncertain == nil and w3:status().epoch == 4, json.encode({ sv, w3:status() }))
w:watch(FB.itemsFor({ readers = { "blind" } }), 105)
check("a new watch drops observations of items no longer watched", w:status().watched == 1 and w:status().cached == 0)
w:service(105); w:unwatch()
check("unwatch clears", w:status().watched == 0 and w:status().cached == 0 and #w:snapshot(105).items == 0)
check("service() needs the clock", not pcall(w.service, w))
check("watch/readMany need a list", not pcall(w.watch, w, "blind") and not pcall(w.readMany, w, "blind"))

f1:dispose()
check("disposed feedback instance refuses reads, other instance unaffected", not pcall(f1.read, f1, "blind") and f2:read("blind").value == true)
check("feedback status lists readers", #f2:status().readers == #FB.READERS and f2:status().module == "gma3_mcp_feedback" and f2:status().config.maxItems == 64)
-- Reader lists handed out are copies: editing one must not reach another instance.
local f3 = FB.new({ owner = "f3", deps = fbDeps }):init()
local list = f2:readers(); list[1] = "bogus"; table.remove(list, #list)
local st = f2:status(); st.readers[2] = "bogus2"
FB.READERS[1] = "bogus3"
local okAll, allAfter = pcall(f3.readAll, f3)
check("mutating a returned reader list does not affect other instances", okAll and allAfter.blind ~= nil and allAfter.bogus == nil and f3:readers()[1] == "blind" and #f3:readers() == 15, json.encode({ okAll, allAfter and allAfter.blind and allAfter.blind.value }))
touched = {}
local fcd = FB.consoleDeps(fakeEnv)
check("feedback consoleDeps touches no console function at build time", type(fcd.cmdObj) == "function" and type(fcd.executor) == "function" and type(fcd.showFile) == "function" and #touched == 0, json.encode(touched))

print(string.format("%d passed, %d failed", passes, failures))
print(failures == 0 and "ALL PASSED" or "FAILED")
os.exit(failures == 0 and 0 or 1)
