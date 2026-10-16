-- Regression harness for the bridge's SB-03 preset reads (preset.read, preset.context) under stock Lua (5.4 or
-- newer).
--
-- Presets are modelled with userdata handles and GetPresetData tables shaped as onPC 2.5.1 returns them
-- (by_fixtures[<fid>][<attribute>] = { [1] = step, preset_store_mode, ui_channel_index, fade, delay, dict_flags,
-- abs_preset }), Get("Dependencies") as { { key = <handle>, content_crc, name_crc } }, and a deleted source as a
-- handle IsObjectValid reports invalid.
--
-- Run from the repository root:   lua test/lua/preset_ops_test.lua

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


local fixtures = H({ name = "Fixtures", class = "Fixtures" })
local f401 = H({ name = "Par 1", class = "Fixture", no = 1, parent = fixtures, props = { FID = 401, FixtureType = "6 Mega Hex Par" } })
local f402 = H({ name = "Par 2", class = "Fixture", no = 2, parent = fixtures, props = { FID = 402, FixtureType = "6 Mega Hex Par" } })
local f501 = H({ name = "Wash 1", class = "Fixture", no = 3, parent = fixtures, props = { FID = 501, FixtureType = "5 Wall Washer" } })
local c2 = H({ name = "[Instance3]", class = "SubFixture", no = 2, parent = f501, props = {} })
local bySf = { [63] = f401, [64] = f402, [12] = c2 }
local uiToSf = { [320] = 63, [321] = 63, [330] = 64, [700] = 12 }
GetSubfixture = function(i) return bySf[i] end
GetUIChannel = function(ui) local sf = uiToSf[ui]; return sf and { sf_index = sf, ui_index = ui } or nil end

local colorPool = H({ name = "Color", class = "Presets", no = 4, props = { PresetMode = "Universal", InputFilter = "" } })
local allPool = H({ name = "All 3", class = "Presets", no = 23, props = { PresetMode = "Selective", InputFilter = "" } })
local source = H({ name = "Red", class = "Preset", no = 902, parent = colorPool, addr = "14.14.1.5.4.902", props = { StoredData = "Global", PresetMode = "Global", FeatureGroup = "Color", Lock = "", MaxDepth = 0, References = "1073744458:1,1073744578:1" } })
local deleted = H({ name = "Gone", class = "Preset", no = 904, parent = colorPool, addr = "14.14.1.5.4.904", props = {} })
local invalid = { [deleted] = true }
IsObjectValid = function(h) return not invalid[h] end

local function step(v) return { absolute = v, absolute_value = math.floor(v / 100 * 16777216), channel_function = 0, mask_individual = 2 } end
local function chan(ui, pm, v, extra)
  local c = { step(v), ui_channel_index = ui, preset_store_mode = pm, selective = pm == 1, mask_cooked = 0, dict_flags = { has_absolute = 1, has_relative = 0 } }
  for k, x in pairs(extra or {}) do c[k] = x end
  return c
end
local embeddedData = { count = 4, by_fixtures = {
  ["401"] = { ColorRGB_R = chan(320, 1, 100, { abs_preset = source }), Dimmer = chan(321, 1, 50, { fade = 3.0 }) },
  ["402"] = { ColorRGB_R = chan(330, 2, 0, { delay = 1.0 }) },
  ["501.2"] = { ColorRGB_R = { { absolute = 10, trans = 0, width = 50 }, { absolute = 90, accel = -100, decel = 20, accel_type = 2, integrated = source }, ui_channel_index = 700, preset_store_mode = 3, speed = 2.0, phase = 90, measure = 400, speed_master = 1, dict_flags = { has_absolute = 1, has_relative = 1 } } },
} }
local embedded = H({ name = "Look", class = "Preset", no = 3, parent = allPool, addr = "14.14.1.5.23.3", props = {
  StoredData = "Selective/Global", PresetMode = "Selective", FeatureGroup = "", Lock = "UL", MaxDepth = 0, HasAnyMAtricksData = "No",
  Dependencies = { { key = source, content_crc = 1920816742600600000, name_crc = -3 }, { key = deleted, content_crc = 7, name_crc = 8 } },
} })
local unreadable = H({ name = "Bad", class = "Preset", no = 5, parent = allPool, props = {} })
local part = H({ name = "Part 0", class = "Part", no = 0, props = {} })
local presetData = { [embedded] = embeddedData, [source] = { by_fixtures = {} }, [part] = { by_fixtures = { ["401"] = { ColorRGB_R = chan(320, 0, 100, { mask_cooked = 511 }), Dimmer = chan(321, 0, 70) } } } }
GetPresetData = function(h) return presetData[h] end
local seq = H({ name = "Seq", class = "Sequence", no = 1, props = {} })
local objects = { ["Preset 23.3"] = embedded, ["Preset 4.902"] = source, ["Preset 23.5"] = unreadable, ["Sequence 9 Cue 1 Part 0"] = part, ["Sequence 1"] = seq, ["Preset 4"] = colorPool, ["Preset 23"] = allPool }
ObjectList = function(ref) local h = objects[ref]; return h and { h } or nil end

local prefs = H({ name = "StorePreferences", class = "StorePreferences", props = { StoreMode = "Ask", StoreSource = "Programmer", ChannelFilter = "Active", StoreLook = "No", PresetMode = "Default", PresetInputFilter = "Yes", StoreEmbedded = "No", StoreMAtricks = "Yes", KeepActivation = "No" } })
local profileWithPrefs = { name = "Default", StorePreferences = prefs, KeyboardShortCuts = { Get = function() return "true" end, Count = function() return 0 end } }

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
CurrentProfile = function() return profileWithPrefs end

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

local r = request("ping")
check("ping reports bridge 0.30.0", r.ok and r.result.bridgeVersion == "0.30.1", J(r))

r = request("preset.read", { ref = "Preset 23.3" })
local res = r.ok and r.result or {}
local rows = res.rows or {}
local function row(fixture, attr) for _, x in ipairs(rows) do if x.fixture == fixture and x.attribute == attr then return x end end end
check("preset.read: summary fields in the edit role", r.ok and res.storedData == "Selective/Global" and res.presetMode == "Selective" and res.lock == "UL" and res.pool.no == 23 and res.pool.name == "All 3" and res.no == 3, J(res))
check("preset.read: one row per fixture and attribute, sorted by subfixture index", #rows == 4 and rows[1].fixture == "501.2" and rows[2].attribute == "ColorRGB_R" and rows[3].attribute == "Dimmer" and rows[4].fixture == "402", J(rows))
local r401 = row("401", "ColorRGB_R")
check("preset.read: mode, value, subfixture and fixture type", r401 and r401.mode == "selective" and r401.value == 100 and r401.sfIndex == 63 and r401.fixtureType == "6 Mega Hex Par" and r401.hasAbsolute == true, J(r401))
check("preset.read: an embedded value names its source preset", r401 and r401.absPreset and r401.absPreset.valid == true and r401.absPreset.addr == "14.14.1.5.4.902" and r401.absPreset.no == 902 and r401.absPreset.pool == 4, J(r401))
check("preset.read: fade and delay layers", row("401", "Dimmer").fade == 3.0 and row("402", "ColorRGB_R").delay == 1.0 and row("402", "ColorRGB_R").mode == "global", J(rows))
local cell = row("501.2", "ColorRGB_R")
check("preset.read: a cell's fixture type comes from its fixture; multi-step rows list steps", cell and cell.fixtureType == "5 Wall Washer" and cell.mode == "universal" and cell.value == nil and #cell.steps == 2 and cell.steps[2].absolute == 90 and cell.hasRelative == true, J(cell))
check("preset.read: phaser steps carry their layers and integrated preset; the row its phaser layers", cell and cell.steps[1].trans == 0 and cell.steps[1].width == 50 and cell.steps[2].accel == -100 and cell.steps[2].decel == 20 and cell.steps[2].accelType == 2 and cell.steps[2].integrated and cell.steps[2].integrated.no == 902 and cell.steps[1].integrated == nil and cell.speed == 2.0 and cell.phase == 90 and cell.measure == 400 and cell.speedMaster == 1, J(cell))
check("preset.read: dependencies with validity and checksum, a deleted source invalid", #res.dependencies == 2 and res.dependencies[1].valid == true and res.dependencies[1].addr == "14.14.1.5.4.902" and res.dependencies[1].contentCrc ~= nil and res.dependencies[2].valid == false and res.dependenciesReadable == true, J(res.dependencies))

r = request("preset.read", { ref = "Preset 23.3", typesFor = { 63, 12, 99 } })
check("preset.read: typesFor gives the fixture type of any subfixture, the same way rows do", r.ok and r.result.types["63"] == "6 Mega Hex Par" and r.result.types["12"] == "5 Wall Washer" and r.result.types["99"] == nil, J(r.result.types))

r = request("preset.read", { ref = "Preset 4.902" })
check("preset.read: references are counted, an empty preset has an empty rows array", r.ok and r.result.referencedBy == 2 and r.result.count == 0 and J(r):find('"rows":%[%]') ~= nil and J(r):find('"dependencies":%[%]') ~= nil, J(r))
r = request("preset.read", { ref = "Preset 23.5" })
check("preset.read: unreadable preset data is an error, never an empty preset", r.ok == false and r.code == "unreadable", J(r))
r = request("preset.read", { ref = "Sequence 9 Cue 1 Part 0" })
local pr = r.ok and r.result.rows or {}
check("preset.read: a cue part is read like a preset, rows say what was cooked", r.ok and r.result.class == "Part" and #pr == 2 and pr[1].attribute == "ColorRGB_R" and pr[1].cooked == true and pr[2].attribute == "Dimmer" and pr[2].cooked == false, J(r))
check("preset.read: a preset's rows are not cooked unless the channel says so", row("401", "ColorRGB_R").cooked == false, J(rows))
r = request("preset.read", { ref = "Sequence 1" })
check("preset.read: a non-preset is refused", r.ok == false and r.code == "not-preset", J(r))

r = request("preset.context", { pool = 4 })
check("preset.context: store preferences and the pool's defaults", r.ok and r.result.preferencesReadable == true and r.result.preferences.StoreMode == "Ask" and r.result.preferences.StoreEmbedded == "No" and r.result.pool.exists == true and r.result.pool.presetMode == "Universal" and r.result.pool.name == "Color", J(r))
r = request("preset.context", { pool = 99 })
check("preset.context: a missing pool", r.ok and r.result.pool.exists == false and r.result.pool.no == 99, J(r))
r = request("preset.context", {})
check("preset.context: no pool, preferences only", r.ok and r.result.pool == nil and r.result.preferences.KeepActivation == "No", J(r))

print(string.format("%d passed, %d failed", passes, failures))
if failures > 0 then print("FAILED"); os.exit(1) end
print("ALL PASSED")
