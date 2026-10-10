-- Regression harness for the KB-17 control-context readers and snapshots of plugin/gma3_mcp_feedback.lua
-- under stock Lua: a fake console with an encoder bar on display 1 (none on display 2), a profile encoder
-- bar pool, attribute definitions and user preferences, a two-fixture selection with programmer values,
-- and a page of executors including Quickey-bank objects. Nothing here touches a console API.
--
-- Run from the repository root:   lua test/lua/feedback_context_test.lua

local here = (arg and arg[0] or ""):match("^(.*)[/\\]") or "."
package.path = here .. "/?.lua;" .. package.path
local json = require("json")

local failures, passes = 0, 0
local function check(name, cond, detail)
  if cond then passes = passes + 1; print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end

local function loadModule(file)
  local f = assert(io.open(here .. "/../../plugin/" .. file, "rb")); local src = f:read("a"); f:close()
  local chunk = assert(load(src, "=" .. file, "t", setmetatable({}, { __index = _G })))
  return chunk("test_plugin", (file:gsub("%.lua$", "")), {}, nil)
end
local FB = loadModule("gma3_mcp_feedback.lua")
check("feedback 0.5.0 loads", FB.VERSION == "0.5.0" and FB.API_VERSION == 1)

-------------------------------------------------------------------------------
-- Fake console
-------------------------------------------------------------------------------
-- A handle: props read through Get(k, role) and as fields; `items` make it a collection (Count/Ptr).
local function H(props, items, class)
  local h = {}
  for k, v in pairs(props or {}) do h[k] = v end
  h.Get = function(_, k) return props[k] end
  h.GetClass = function() return class end
  h.Count = function() return items and #items or 0 end
  h.Ptr = function(_, i) return items and items[i] or nil end
  return h
end

local console = { bank = 3, page = 0, context = "Default", showFile = "show-a", user = "Admin", profile = "Default", layer = "Absolute" }

-- Encoder bar of display 1 (KB-16 widget tree).
local band1 = H({ name = "Band", Text = "R", Resolution = "Coarse" }, nil, "BandFader")
local cf1 = H({ name = "ChannelFunctionSelector1", Text = "RGB", SelectedItemIdx = 0 }, nil, "SwipeButtonList")
local place1 = H({}, { H({}, { band1, cf1 }, "UILayoutGrid"), H({}, { H({ Text = "Dim" }, nil, "BandFader") }, "UILayoutGrid") })
local place2 = H({}, { H({}, { H({ Text = "G", Resolution = "Coarse" }, nil, "BandFader") }, "UILayoutGrid") })
local presetBar = H({ Context = nil }, nil, "PresetBar")
presetBar.Options = { PageSelector = {} }
setmetatable(presetBar.Options.PageSelector, { __index = function(_, k) if k == "SelectedItemValueI64" then return console.page end end })
setmetatable(presetBar, { __index = function(_, k) if k == "Context" then return console.context end end })
presetBar.EncodersArea = { EncoderPlace1 = place1, EncoderPlace2 = place2, EncoderPlace5 = H({}) }
local selector = setmetatable({}, { __index = function(_, k) if k == "SelectedItemValueI64" then return console.bank end end })
local display1 = { EncoderBarContainer = { EncoderBarGrid = { EncoderBarBase = { EncoderBarContainer = { EncoderBankSelector = selector } }, EncoderBar = H({}, { H({}, nil, "Other"), presetBar }) } } }
local displays = { [1] = display1, [2] = H({ PreviewBarActive = "false" }) }

-- Profile encoder bar pool: bar 1 -> banks -> pages -> encoders.
local function enc(inner, innerType, outer)
  return H({ InnerObject = inner, InnerObjectType = innerType, OuterObject = outer or inner, OuterObjectType = innerType })
end
local rgbPage = H({ name = "RGB" }, { enc("Attribute 107 'ColorRGB_R'", "0", "Attribute 1 'Dimmer'"), enc("Attribute 108 'ColorRGB_G'", "0"), enc("Attribute 109 'ColorRGB_B'", "0"), enc("Attribute 110 'ColorRGB_RY'", "0"), enc("", "0") })
local rgb2Page = H({ name = "RGB" }, { enc("Attribute 119 'ColorRGB_W'", "0"), enc("Attribute 120 'ColorRGB_UV'", "0") })
local banks = {
  H({ name = "Dimmer" }, { H({ name = "Dimmer" }, { enc("Attribute 1 'Dimmer'", "0") }) }),
  H({ name = "Position" }, { H({ name = "PanTilt" }, { enc("Attribute 2 'Pan'", "0"), enc("Attribute 3 'Tilt'", "0") }) }),
  H({ name = "Gobo" }, {}),
  H({ name = "Color" }, { rgbPage, rgb2Page, H({ name = "Color" }, { enc("Attribute 87 'Color1'", "0") }) }),
  H({ name = "Phaser" }, { H({ name = "Phaser" }, { enc("PhaserLayer 2 'Speed'", "2"), enc("PhaserLayer 3 'Phase'", "2") }) }),
}
local pool = H({}, { H({ name = "EncoderBar 1" }, banks) })
local prefs = { ColorRGB_R = H({ NaturalReadout = "<Percent>", EncoderResolution = "Fine", EncoderPressFactor = "Mul5" }) }
local profile = { name = console.profile, EncoderBarPool = pool, UserAttributePreferences = prefs, Get = function(_, k) if k == "Layer" then return console.layer end end }
local function attrDef(feature, unit, readout, res, color, cfs)
  return H({ Feature = feature, PhysicalUnit = unit, NaturalReadout = readout, EncoderResolution = res, Color = color, ChannelFunctions = cfs, Special = "None" })
end
local defs = {
  ColorRGB_R = attrDef("FeatureGroup 4 'Color'.Feature 1 'RGB'", "None", "Percent", "Coarse", "1,0,0,1", "1"),
  ColorRGB_G = attrDef("FeatureGroup 4 'Color'.Feature 1 'RGB'", "None", "Percent", "Coarse", "0,1,0,1", "1"),
  ColorRGB_B = attrDef("FeatureGroup 4 'Color'.Feature 1 'RGB'", "None", "Percent", "Coarse", "0,0,1,1", "1"),
  Dimmer = attrDef("FeatureGroup 1 'Dimmer'.Feature 1 'Dimmer'", "LuminousIntensity", "Percent", "Coarse", "0,0,0,1", "9"),
}
local attrIndex = { ColorRGB_R = 107, ColorRGB_G = 108, ColorRGB_B = 109, Dimmer = 1 }

-- Selection: fixture 63 (RGB: R/G/B + Dimmer) and 64 (R/G + Dimmer). UI channel -> attribute name.
local selection = { list = { 63, 64 } }
local uiOf = { [63] = { 320, 321, 322, 1 }, [64] = { 420, 421, 2 }, [65] = { 520, 521, 522, 3 } }
local attrOfUi = { [320] = "ColorRGB_R", [321] = "ColorRGB_G", [322] = "ColorRGB_B", [1] = "Dimmer", [420] = "ColorRGB_R", [421] = "ColorRGB_G", [2] = "Dimmer",
                   [520] = "ColorRGB_R", [521] = "ColorRGB_G", [522] = "ColorRGB_B", [3] = "Dimmer" }
-- KB-19: logical channels (channel functions with physical ranges) per UI channel. Fixture 64's R has a
-- smaller range than 63's; Dimmer on fixture 63 names no function for the attribute (fallback).
local function cf(name, attr, from, to) local h = H({ Attribute = attr }); h.name = name; h.PhysicalFrom = from; h.PhysicalTo = to; return h end
local logical = {
  [320] = H({}, { cf("ColorRGB_R 1", "ColorRGB_R", 0, 1) }), [420] = H({}, { cf("ColorRGB_R 1", "ColorRGB_R", 0, 0.5) }), [520] = H({}, { cf("ColorRGB_R 1", "ColorRGB_R", 0, 1) }),
  [321] = H({}, { cf("ColorRGB_G 1", "ColorRGB_G", 0, 1) }), [421] = H({}, { cf("ColorRGB_G 1", "ColorRGB_G", 0, 1) }), [521] = H({}, { cf("ColorRGB_G 1", "ColorRGB_G", 0, 1) }),
  [322] = H({}, { cf("Gobo 1", "Gobo1", 0, 15), cf("ColorRGB_B 2", "ColorRGB_B", 0, 1) }), [522] = H({}, { cf("ColorRGB_B 1", "ColorRGB_B", 0, 1) }),
  [1] = H({}, { cf("Dimmer 1", "Other", 0, 1) }), [2] = H({}, {}), [3] = H({}, { cf("Dimmer 1", "Dimmer", 0, 1) }),
}
local programmer = { [320] = { { absolute = 50, absolute_value = 8388608, channel_function = 0 } }, [420] = { { absolute = 50, channel_function = 0 } },
                     [321] = { { absolute = 50, channel_function = 0 } }, [421] = { { absolute = 60, channel_function = 0 } },
                     [322] = nil, [1] = { { absolute = 100 } }, [2] = { { absolute = 100 } },
                     [520] = { { absolute = 50, absolute_value = 8388608, channel_function = 0 } }, [521] = { { absolute = 50, channel_function = 0 } }, [3] = { { absolute = 100 } } }

-- Executors on page 1.
local function obj(name, class, no, extra)
  local o = H({ name = name, No = no }, nil, class)
  o.Addr = function() return class .. " " .. no end
  o.HasActivePlayback = function() return extra and extra.active or false end
  o.GetFader = function(_, t) local v = extra and extra.faders and extra.faders[t.token]; if v == nil then error("no token " .. tostring(t.token)) end; return v end
  o.GetFaderText = function(_, t) return tostring(extra and extra.faders and extra.faders[t.token]) .. "%" end
  if extra and extra.appearance then o.Appearance = H({ name = extra.appearance, BackRGBA = "0.5,0.1,0.1,1", Color = "1,1,1,1" }) end
  return o
end
local seqMain = obj("Main", "Sequence", 10, { faders = { FaderMaster = 100, FaderTemp = 0 }, appearance = "Red" })
local seqTemp = obj("Odd", "Sequence", 11, { faders = { FaderTemp = 0 }, active = "maybe" })
local quickey = obj("MCP CLEAR", "Quickey", 901, { faders = { FaderMaster = 100 } })
local function ex(index, object, fns)
  local e = H({ index = index, KeyPress = fns.keyPress, KeyUnpress = fns.keyUnpress or "", KeyUnpressCombined = fns.keyUnpressCombined, Fader = fns.fader, Encoder = fns.encoder or "Master", EncoderLeft = fns.encoderLeft or "", EncoderRight = fns.encoderRight or "", ExecutorConfiguration = "Configuration 1 'Default'", IsXKey = "No", Width = "1" })
  e.Object = object
  return e
end
local execs = {
  [201] = ex(201, seqMain, { keyPress = "Temp", keyUnpressCombined = "<Temp>", fader = "Master" }),
  [202] = ex(202, quickey, { keyPress = "Go+", fader = "Master" }),
  [203] = ex(203, nil, { keyPress = "Go+", fader = "Master" }),
  [205] = ex(205, seqTemp, { keyPress = "Flash", fader = "Temp" }),
  [207] = ex(207, obj("Macro", "Macro", 3, {}), { keyPress = "Go+", fader = "" }),
  [208] = ex(208, obj("Chase", "Sequence", 12, { faders = { FaderMaster = 50 } }), { keyPress = "Toggle", fader = "Rate" }),
}
execs[206] = setmetatable({ index = 206 }, { __index = function(_, k) if k == "Object" then error("Object read exploded") end end })
local pageH = H({ name = "Page 1", No = "1" }, { execs[201], execs[202], execs[203], execs[205], execs[207], execs[208] })
local reserved = { page = 1, first = 203, count = 2 }
-- KB-21: a second page read through ObjectList("Page 2.E"), with an expanded (width 2) assignment on 211
-- covering 212, and an assigned 213 right after it. Page 2 executors never go through GetExecutor.
local seqTwo = obj("Two", "Sequence", 20, { faders = { FaderMaster = 30 } })
local function wide(index, object, width, fns) local e = ex(index, object, fns); e.Width = tostring(width); e.Get = function(_, k) if k == "Width" then return tostring(width) end; return ({ index = index, KeyPress = fns.keyPress, KeyUnpress = "", KeyUnpressCombined = fns.keyUnpressCombined, Fader = fns.fader, Encoder = "Master", EncoderLeft = "", EncoderRight = "", ExecutorConfiguration = "Configuration 2 'Wide'", IsXKey = "No" })[k] end; return e end
local execs2 = {
  [201] = ex(201, seqTwo, { keyPress = "Go+", fader = "Master" }),
  [211] = wide(211, seqTwo, 2, { keyPress = "Go+", fader = "Master" }),
  [213] = ex(213, seqTemp, { keyPress = "Flash", fader = "Temp" }),
  [115] = wide(115, seqTwo, 3, { keyPress = "Go+", fader = "Master" }),
}
local page2 = H({ name = "Page 2", No = "2" }, { execs2[115], execs2[201], execs2[211], execs2[213] })
local pages = { [1] = pageH, [2] = page2 }
local pagedExecs = { [1] = execs, [2] = execs2 }

local calls = {}
local function deps(overrides)
  local d = {
    enums = function() return { Roles = { Display = 1 } } end,
    currentProfile = function() return profile end,
    currentExecPage = function() return pageH end,
    display = function(n) return displays[n] end,
    executor = function(n) return execs[n], pageH end,
    pageByNo = function(p) return pages[p] end,
    pagedExecutor = function(p, n) return pagedExecs[p] and pagedExecs[p][n] end,
    dataPool = function() return H({ name = "Default", No = "1" }) end,
    selectionCount = function() return #selection.list end,
    selectionFirst = function() return selection.list[1] end,
    selectionNext = function(i) for k, v in ipairs(selection.list) do if v == i then return selection.list[k + 1] end end; return nil end,
    uiChannels = function(i) calls.ui = (calls.ui or 0) + 1; return uiOf[i] or {} end,
    attributeByUIChannel = function(ui) local n = attrOfUi[ui]; return n and { name = n } or nil end,
    progPhaser = function(ui) return programmer[ui] end,
    logicalChannel = function(ui) if ui == 421 then error("GetUIChannel exploded") end return logical[ui] end,
    subfixtureCount = function() return 0 end,
    attributeDefinitions = function() return defs end,
    attributeIndex = function(n) return attrIndex[n] end,
    reservedExecutors = function() return reserved end,
    showFile = function() return console.showFile end,
    userName = function() return console.user end,
    profileName = function() return console.profile end,
  }
  for k, v in pairs(overrides or {}) do if v == false then d[k] = nil else d[k] = v end end  -- false removes a dependency
  return d
end

local f = FB.new({ owner = "kb17", deps = deps() }):init()

-------------------------------------------------------------------------------
-- Reader registry
-------------------------------------------------------------------------------
local names = {}
for _, n in ipairs(FB.READERS) do names[n] = true end
check("new readers are registered", names.dataPool and names.encoderBank and names.encoderSlots and names.executorTarget and names.pageExecutors and #FB.READERS == 20)
local desc = {}
for _, r in ipairs(FB.describe()) do desc[r.name] = r end
check("describe flags the context readers", desc.encoderSlots.context == true and desc.blind.context == nil and desc.encoderBank.params[1] == "display")
local all = f:readAll(1)
check("readAll leaves the context readers out", all.blind ~= nil and all.encoderBank == nil and all.encoderSlots == nil and all.dataPool == nil and all.pageExecutors == nil)
local items = FB.itemsFor({ all = true })
local hasCtx = false
for _, it in ipairs(items) do if it.name == "encoderSlots" or it.name == "dataPool" then hasCtx = true end end
check("itemsFor all leaves the context readers out; they are requested explicitly", not hasCtx and #FB.itemsFor({ readers = { "encoderSlots", "dataPool" } }) == 2)
check("parseRef exported", FB.parseRef("Attribute 107 'ColorRGB_R'").name == "ColorRGB_R" and FB.parseRef("Attribute 107 'ColorRGB_R'").index == 107 and FB.parseRef("") == nil and FB.parseRef("odd").name == "odd")

-------------------------------------------------------------------------------
-- dataPool, encoderBank
-------------------------------------------------------------------------------
local r = f:read("dataPool", nil, 1)
check("dataPool identity", r.available and r.value.name == "Default" and r.value.no == 1 and r.scope == "user", json.encode(r))
r = f:read("encoderBank", nil, 1)
check("encoderBank: configured display 1, 1-based bank/page with pool names", r.available and r.value.display == 1 and r.value.bank.index == 4 and r.value.bank.name == "Color" and r.value.bank.pages == 3 and r.value.page.index == 1 and r.value.page.name == "RGB" and r.value.page.slots == 5 and r.value.banks == 5, json.encode(r))
check("encoderBank: Default context is attribute editing; key identifies the display", r.value.context == "Default" and r.value.attributeEditing == true and r.value.unsupported == nil and r.key == "encoderBank[display=1]" and r.params.display == 1, json.encode(r))
r = f:read("encoderBank", { display = 2 }, 1)
check("encoderBank: a display without an encoder bar is unavailable, nothing substituted", r.available == false and r.reason:find("display 2 has no encoder bar") and r.reason:find("no other display is substituted") and r.key == "encoderBank[display=2]", json.encode(r))
r = f:read("encoderBank", { display = 3 }, 1)
check("encoderBank: a missing display is unavailable", r.available == false and r.reason:find("display 3 does not exist"), json.encode(r))
r = f:read("encoderBank", { display = 0 }, 1)
check("encoderBank: display 0 refused per item", r.available == false and r.error:find("positive integer"), json.encode(r))
console.context = "Editor"
r = f:read("encoderBank", nil, 1)
check("encoderBank: a non-Default context is available but marked unsupported", r.available and r.value.attributeEditing == false and r.value.unsupported:find("'Editor' is not attribute editing"), json.encode(r))
console.context = nil
r = f:read("encoderBank", nil, 1)
check("encoderBank: an unreadable context is explicit (attributeEditing unknown)", r.available and r.value.attributeEditing == nil and r.value.context == nil and r.value.unsupported:find("not readable"), json.encode(r))
console.context = "Default"
console.page = 7
r = f:read("encoderBank", nil, 1)
check("encoderBank: a selector beyond the pool reports the pool problem, never maps to another page", r.available and r.value.page.index == 8 and r.value.page.name == nil and r.value.poolUnavailable:find("page 8 does not exist in bank 4 'Color'"), json.encode(r))
console.page = 0
local f2 = FB.new({ owner = "kb17b", deps = deps(), config = { encoderDisplay = 2 } }):init()
r = f2:read("encoderBank", nil, 1)
check("encoderBank: config.encoderDisplay chooses the authoritative display", r.available == false and r.params.display == 2 and r.key == "encoderBank[display=2]", json.encode(r))

-------------------------------------------------------------------------------
-- encoderSlots
-------------------------------------------------------------------------------
r = f:read("encoderSlots", nil, 1)
check("encoderSlots: available with bank/page/context/layer/selection summary", r.available and r.value.bank.name == "Color" and r.value.page.index == 1 and r.value.context == "Default" and r.value.layer == "Absolute" and r.value.selection.count == 2 and r.value.selection.scanned == 2 and r.value.selection.partial == false and #r.value.slots == 5 and r.value.slotCount == 5 and r.value.truncated == false, json.encode(r))
local s = r.value.slots
check("slot 1: attribute identity, label from the band, definition metadata", s[1].slot == 1 and s[1].kind == "attribute" and s[1].name == "ColorRGB_R" and s[1].ref == "Attribute 107 'ColorRGB_R'" and s[1].attributeIndex == 107 and s[1].label == "R" and s[1].feature:find("RGB") and s[1].unit == "None" and s[1].color == "1,0,0,1" and s[1].channelFunctions == 1 and s[1].channelFunction == "RGB" and s[1].channelFunctionIndex == 0 and s[1].layer == "Absolute", json.encode(s[1]))
check("slot 1: user preference overrides resolution, inherited readout comes from the definition", s[1].resolution == "Fine" and s[1].resolutionSource == "user-preference" and s[1].readout == "Percent" and s[1].readoutSource == "attribute-definition" and s[1].pressFactor == "Mul5", json.encode(s[1]))
check("slot 1: available on every scanned fixture, agreeing value, complete", s[1].availability == "available" and s[1].fixtures == 2 and s[1].with == 2 and s[1].valueState == "value" and s[1].absolute == 50 and s[1].raw == 8388608 and s[1].valueChannelFunction == 0 and s[1].valueFixture == 63 and s[1].uiChannel == 320 and s[1].valueComplete == true and s[1].valueIncomplete == nil, json.encode(s[1]))
check("slot 1: a different outer-ring object is reported and unsupported", s[1].outerRef == "Attribute 1 'Dimmer'" and s[1].outerName == "Dimmer" and s[1].outerUnsupported:find("outer ring"), json.encode(s[1]))
check("slot 2: fixtures disagree -> mixed value with the first fixture's", s[2].name == "ColorRGB_G" and s[2].availability == "available" and s[2].valueState == "mixed" and s[2].absolute == 50 and s[2].valueNote:find("disagree") and s[2].label == "G" and s[2].outerRef == nil and s[2].resolution == "Coarse" and s[2].resolutionSource == "attribute-definition", json.encode(s[2]))
check("slot 3: only one fixture has it -> mixed availability; nil from GetProgPhaser (nothing in the programmer, KB-17 live) -> empty value", s[3].name == "ColorRGB_B" and s[3].availability == "mixed" and s[3].with == 1 and s[3].valueState == "empty" and s[3].absolute == nil and s[3].valueNote:find("holds no value") and s[3].label == nil, json.encode(s[3]))
check("slot 4: attribute missing from the definitions and from the selection is explicit", s[4].name == "ColorRGB_RY" and s[4].attributeUnavailable:find("not in the show's attribute definitions") and s[4].availability == "unavailable" and s[4].valueState == "none" and s[4].unit == nil and s[4].readoutUnavailable ~= nil and s[4].attributeIndex == 110, json.encode(s[4]))
check("slot 5: empty slot", s[5].kind == "empty" and s[5].ref == nil and s[5].availability == "empty" and s[5].valueState == "none", json.encode(s[5]))
check("kb19: slot 1 physical range is the smallest across the scanned fixtures and says they differ (flat fields)", s[1].physicalFrom == 0 and s[1].physicalTo == 0.5 and s[1].physicalRange == 0.5 and s[1].physicalFunction == "ColorRGB_R 1" and s[1].physicalFixtures == 2 and s[1].physicalMixed == true and s[1].physicalNote:find("smallest"), json.encode(s[1]))
check("kb19 review: slot 2: one fixture's logical channel raised, so no range is reported (a partial set never sizes a click); the reason names the failure", s[2].physicalRange == nil and s[2].physicalFrom == nil and s[2].physicalUnavailable:find("could not be read for every fixture") and s[2].physicalUnavailable:find("GetUIChannel exploded"), json.encode(s[2].physicalUnavailable))
check("kb19: slot 3 picks the channel function that names the attribute, not the first one", s[3].physicalFunction == "ColorRGB_B 2" and s[3].physicalFunctionIndex == 2 and s[3].physicalFunctions == 2 and s[3].physicalTo == 1, json.encode(s[3]))
check("kb19: slot 4 (no fixture has it) carries no physical range", s[4].physicalRange == nil and s[4].physicalUnavailable == nil)
check("kb19 review: Dimmer bank: a function that does not name the attribute is NOT used as its range (no fallback); the slot is physicalUnavailable with the reason", (function()
  console.bank = 0
  local rd = f:read("encoderSlots", nil, 2).value.slots[1]
  console.bank = 3
  return rd.name == "Dimmer" and rd.physicalRange == nil and rd.physicalFunction == nil and rd.physicalUnavailable:find("no channel function of the logical channel names attribute 'Dimmer'") ~= nil end)(), "see Dimmer slot")
local flat = true
for _, sl in ipairs(s) do for k, v in pairs(sl) do if type(v) == "table" then flat = false end end end
check("slots are flat records (serialisable within the bridge's depth bound)", flat)
console.bank = 4
r = f:read("encoderSlots", nil, 1)
check("phaser bank: non-attribute slots are reported as other/unsupported", r.available and r.value.bank.name == "Phaser" and r.value.slots[1].kind == "other" and r.value.slots[1].ref == "PhaserLayer 2 'Speed'" and r.value.slots[1].objectType == "2" and r.value.slots[1].availability == "unsupported" and r.value.slots[1].unsupported:find("not an attribute"), json.encode(r.value.slots[1]))
console.bank = 3
console.page = 1
r = f:read("encoderSlots", nil, 1)
check("page 2 of the bank: two slots, nobody selected has them", r.available and r.value.page.name == "RGB" and r.value.page.index == 2 and #r.value.slots == 2 and r.value.slots[1].name == "ColorRGB_W" and r.value.slots[1].availability == "unavailable" and r.value.slots[1].label == "R", json.encode(r.value.slots[1]))
console.page = 0
selection.list = {}
r = f:read("encoderSlots", nil, 1)
check("empty selection: no-selection availability, no value, nothing scanned", r.available and r.value.selection.count == 0 and r.value.slots[1].availability == "no-selection" and r.value.slots[1].valueState == "none" and r.value.slots[1].valueNote:find("nothing is selected"), json.encode(r.value.slots[1]))
selection.list = { 63, 64 }
local f3 = FB.new({ owner = "kb17c", deps = deps(), config = { maxSelectionScan = 1 } }):init()
r = f3:read("encoderSlots", nil, 1)
check("selection scan is bounded and says so", r.available and r.value.selection.scanned == 1 and r.value.selection.partial == true and r.value.selection.limitations[1]:find("bounded to 1 of 2") and r.value.slots[3].availability == "available" and r.value.slots[3].partial == true, json.encode(r.value.selection))
check("kb20 review: with a bounded scan a slot's value is not complete (the fixtures outside the scan are unknown), whatever the scanned ones agree on", r.value.slots[1].valueState == "value" and r.value.slots[1].valueComplete == false and r.value.slots[1].valueIncomplete:find("scan is bounded %(1 of 2 fixtures%)"), json.encode({ r.value.slots[1].valueState, r.value.slots[1].valueIncomplete }))
local f3b = FB.new({ owner = "kb20a", deps = deps({ progPhaser = function(ui) if ui == 420 then error("GetProgPhaser exploded") end return programmer[ui] end }) }):init()
r = f3b:read("encoderSlots", nil, 1)
check("kb20 review: one fixture's programmer read failing leaves 'value' (the readable fixture's) marked incomplete with the reason; a fully read slot is complete", r.available and r.value.slots[1].valueState == "value" and r.value.slots[1].absolute == 50 and r.value.slots[1].valueComplete == false and r.value.slots[1].valueIncomplete:find("could not be read") and r.value.slots[1].valueIncomplete:find("exploded") and r.value.slots[2].valueComplete == true and r.value.slots[2].valueIncomplete == nil, json.encode({ r.value.slots[1].valueIncomplete, r.value.slots[2].valueState }))
local f4 = FB.new({ owner = "kb17d", deps = deps({ selectionNext = function() error("no SelectionNext") end }) }):init()
r = f4:read("encoderSlots", nil, 1)
check("a failing SelectionNext leaves a partial scan with the reason", r.available and r.value.selection.scanned == 1 and r.value.selection.partial == true and r.value.selection.limitations[1]:find("SelectionNext%(%) failed"), json.encode(r.value.selection))
local f5 = FB.new({ owner = "kb17e", deps = deps({ selectionCount = function() error("no selection API") end }) }):init()
r = f5:read("encoderSlots", nil, 1)
check("a raising selection read makes the slots reader unavailable with the error, not a guess", r.available == false and r.error:find("SelectionCount failed"), json.encode(r))
local f6 = FB.new({ owner = "kb17f", deps = deps({ progPhaser = function() return "n/a" end, attributeDefinitions = false }) }):init()
r = f6:read("encoderSlots", nil, 1)
check("unreadable programmer and definitions are explicit per slot", r.available and r.value.slots[1].valueState == "unavailable" and r.value.slots[1].valueNote:find("GetProgPhaser returned string") and r.value.slots[1].attributeUnavailable:find("deps.attributeDefinitions missing") and r.value.slots[1].resolution == "Fine" and r.value.slots[1].readoutUnavailable ~= nil and r.value.slots[2].resolution == "Coarse" and r.value.slots[2].resolutionSource == "encoder-band" and r.value.slots[1].unit == nil, json.encode(r.value.slots[1]))
console.page = 7
r = f:read("encoderSlots", nil, 1)
check("no pool page for the selector: slots unavailable with the reason", r.available == false and r.reason:find("page 8 does not exist"), json.encode(r))
console.page = 0
r = f:read("encoderSlots", { display = 2 }, 1)
check("slots on a display without an encoder bar are unavailable", r.available == false and r.reason:find("no encoder bar"), json.encode(r))
local f7 = FB.new({ owner = "kb17g", deps = deps({ uiChannels = function(i) if i == 63 then return {} end return uiOf[i] end, subfixtureCount = function(i) return i == 63 and 2 or 0 end, subfixture = function(i, n) return 630 + n end }) }):init()
uiOf[630] = { 320, 321 }
r = f7:read("encoderSlots", nil, 1)
check("a grouping fixture is read through its first subfixture", r.available and r.value.slots[1].availability == "available" and r.value.slots[1].valueFixture == 63 and r.value.slots[3].availability == "unavailable", json.encode(r.value.slots[1]))

-------------------------------------------------------------------------------
-- executorTarget, pageExecutors
-------------------------------------------------------------------------------
r = f:read("executorTarget", { executor = 201 }, 1)
local v = r.value
check("executorTarget: assignment, functions, configured-function level, activity, appearance", r.available and v.executor == 201 and v.page.no == 1 and v.empty == false and v.assigned.name == "Main" and v.assigned.class == "Sequence" and v.assigned.no == 10 and v.functions.keyPress == "Temp" and v.functions.keyUnpress == "" and v.functions.keyUnpressCombined == "<Temp>" and v.functions.fader == "Master" and v.functions.encoder == "Master" and v.configuration:find("Default") and v.level.token == "FaderMaster" and v.level.value == 100 and v.level.text == "100%" and v.active == false and v.appearance.backRGBA == "0.5,0.1,0.1,1" and v.appearance.name == "Red" and v.playbackTarget == true and v.reserved == nil and r.key == "executorTarget[executor=201]", json.encode(r))
r = f:read("executorTarget", { executor = 202 }, 1)
check("executorTarget: a Quickey object is never a playback target", r.available and r.value.assigned.class == "Quickey" and r.value.playbackTarget == false and r.value.reason:find("Quickey") and r.value.level.value == 100, json.encode(r))
r = f:read("executorTarget", { executor = 203 }, 1)
check("executorTarget: an executor reserved by the bank without an object is reported reserved", r.available and r.value.empty == true and r.value.reserved == true and r.value.playbackTarget == false and r.value.reason:find("reserved") and r.value.functions.keyPress == "Go+", json.encode(r))
r = f:read("executorTarget", { executor = 204 }, 1)
check("executorTarget: a missing executor inside the reserved range", r.available and r.value.empty == true and r.value.reserved == true and r.value.playbackTarget == false, json.encode(r))
r = f:read("executorTarget", { executor = 209 }, 1)
check("executorTarget: a missing executor outside the range is plainly empty", r.available and r.value.empty == true and r.value.reserved == nil and r.value.reason == "the executor is empty", json.encode(r))
r = f:read("executorTarget", { executor = 205 }, 1)
check("executorTarget: the configured fader function picks the token; unrecognised activity is explicit", r.available and r.value.level.token == "FaderTemp" and r.value.level.value == 0 and r.value.active == nil and r.value.activeUnavailable:find("unrecognised") and r.value.appearanceUnavailable ~= nil and r.value.playbackTarget == true, json.encode(r))
r = f:read("executorTarget", { executor = 207 }, 1)
check("executorTarget: no fader function -> level unavailable, still a target", r.available and r.value.level.unavailable:find("no fader function") and r.value.assigned.class == "Macro" and r.value.playbackTarget == true, json.encode(r))
r = f:read("executorTarget", { executor = 208 }, 1)
check("executorTarget: a token the object refuses is unavailable with the raise, never zero", r.available and r.value.level.token == "FaderRate" and r.value.level.value == nil and r.value.level.unavailable:find("no token FaderRate"), json.encode(r))
r = f:read("executorTarget", { executor = 206 }, 1)
check("executorTarget: a raising Object read is an error item", r.available == false and r.error:find("Object read exploded"), json.encode(r))
r = f:read("executorTarget", nil, 1)
check("executorTarget without a parameter is an error", r.available == false and r.error:find("params.executor"), json.encode(r))
local f8 = FB.new({ owner = "kb17h", deps = deps({ reservedExecutors = false }) }):init()
r = f8:read("executorTarget", { executor = 203 }, 1)
check("without a bank dependency nothing is reserved", r.available and r.value.reserved == nil and r.value.reason == "no assigned object", json.encode(r))
r = f:read("pageExecutors", nil, 1)
check("pageExecutors lists the assigned executors", r.available and r.value.page.name == "Page 1" and #r.value.executors == 5 and r.value.executors[1].index == 201 and r.value.executors[1].class == "Sequence" and r.value.executors[2].name == "MCP CLEAR" and r.value.truncated == false, json.encode(r))
local f9 = FB.new({ owner = "kb17i", deps = deps(), config = { maxExecutors = 2 } }):init()
r = f9:read("pageExecutors", nil, 1)
check("pageExecutors is bounded by maxExecutors", r.available and #r.value.executors == 2 and r.value.truncated == true, json.encode(r))

-------------------------------------------------------------------------------
-- contextSnapshot (live) and the binding generation
-------------------------------------------------------------------------------
local spec = { executors = { 201, 202, 203 } }
local snap = f:contextSnapshot(spec, 10)
check("snapshot: identity with data pool, executor page, encoder, slots, executors", snap.identity.showFile == "show-a" and snap.identity.dataPool.name == "Default" and snap.executorPage.no == 1 and snap.encoder.available and snap.encoder.value.bank.name == "Color" and snap.slots.available and #snap.slots.value.slots == 5 and #snap.executors == 3 and snap.executors[1].value.playbackTarget == true and snap.executors[2].value.playbackTarget == false and snap.atomic == false and snap.observedAt == 10 and snap.epoch == 1, json.encode(snap.identity))
check("snapshot: the authoritative display is the configured one and says so", snap.display == 1 and snap.authoritativeDisplay.display == 1 and snap.authoritativeDisplay.rule == "configured" and snap.authoritativeDisplay.note:find("no other display"), json.encode(snap.authoritativeDisplay))
check("snapshot: first generation", snap.generation == 1 and snap.generationChanged == false and snap.generationSince == 10 and snap.generationNote:find("first snapshot") and snap.bindingKey == "display=1;executors=201,202,203", json.encode({ snap.generation, snap.bindingKey }))
snap = f:contextSnapshot(spec, 11)
check("snapshot: unchanged console -> same generation", snap.generation == 1 and snap.generationChanged == false and snap.generationNote == nil)
programmer[320][1].absolute, programmer[420][1].absolute = 70, 70
seqMain.GetFader = function() return 25 end
snap = f:contextSnapshot(spec, 12)
check("a value or level change never moves the generation", snap.generation == 1 and snap.generationChanged == false and snap.slots.value.slots[1].absolute == 70 and snap.executors[1].value.level.value == 25, json.encode(snap.executors[1].value.level))
console.page = 1
snap = f:contextSnapshot(spec, 13)
check("a page change moves the generation", snap.generation == 2 and snap.generationChanged == true and snap.generationSince == 13 and snap.encoder.value.page.index == 2)
console.page = 0
snap = f:contextSnapshot(spec, 14)
check("back on the original page: a new generation again (meaning changed twice)", snap.generation == 3 and snap.generationChanged == true)
selection.list = { 64 }
snap = f:contextSnapshot(spec, 15)
check("a selection change that alters a slot's availability moves the generation", snap.generation == 4 and snap.slots.value.slots[3].availability == "unavailable")
selection.list = { 63, 64 }
snap = f:contextSnapshot(spec, 16)
check("the snapshot carries the selection identity", snap.generation == 5 and snap.slots.value.selection.fixtures[1] == 63 and snap.slots.value.selection.fixtures[2] == 64, json.encode(snap.slots.value.selection))
selection.list = { 65 }
local s65 = f:contextSnapshot(spec, 16.5)
selection.list = { 63 }
local s63 = f:contextSnapshot(spec, 16.6)
check("switching to a fixture with identical availability and value states still moves the generation (review 1)",
  json.encode((function() local t = {}; for i, x in ipairs(s65.slots.value.slots) do t[i] = { x.availability, x.valueState } end; return t end)()) ==
  json.encode((function() local t = {}; for i, x in ipairs(s63.slots.value.slots) do t[i] = { x.availability, x.valueState } end; return t end)())
  and s65.generation == 6 and s65.generationChanged == true and s63.generation == 7 and s63.generationChanged == true, json.encode({ s65.generation, s63.generation }))
selection.list = { 63, 64 }
snap = f:contextSnapshot(spec, 16.7)
check("back to the two-fixture selection: moved again", snap.generation == 8)
-- Review: the identity covers the whole selection, not only the scanned fixtures.
local big = {}
for i = 1, 9 do big[i] = 100 + i end
-- KB-19 review: the nine fixtures all have R (ui 1010+i); the ninth has a ten times smaller physical range than the
-- first eight, so a range taken from the bounded scan alone would be wrong by a factor of ten.
for i = 1, 9 do uiOf[100 + i] = { 1010 + i }; attrOfUi[1010 + i] = "ColorRGB_R"; logical[1010 + i] = H({}, { cf("ColorRGB_R 1", "ColorRGB_R", 0, i == 9 and 0.1 or 1) }) end
selection.list = big
local s9 = f:contextSnapshot(spec, 16.8)
check("kb20 review: the nine-fixture bounded scan leaves slot 1's value incomplete (8 of 9)", s9.slots.value.slots[1].valueComplete == false and s9.slots.value.slots[1].valueIncomplete:find("8 of 9 fixtures") ~= nil, json.encode(s9.slots.value.slots[1].valueIncomplete))
check("kb19 review: with a partial scan no physical range is reported (the ninth fixture's smaller range is outside the scan); the reason says the scan is bounded", s9.slots.value.slots[1].availability == "available" and s9.slots.value.slots[1].physicalRange == nil and s9.slots.value.slots[1].physicalUnavailable:find("scan is bounded %(8 of 9 fixtures%)") ~= nil, json.encode({ range = s9.slots.value.slots[1].physicalRange, why = s9.slots.value.slots[1].physicalUnavailable }))
check("nine fixtures with maxSelectionScan 8: the scan is partial but the identity is complete and the generation moves", s9.slots.value.selection.scanned == 8 and s9.slots.value.selection.partial == true and s9.slots.value.selection.identityComplete == true and #s9.slots.value.selection.fixtures == 9 and s9.slots.value.selection.fixtures[9] == 109 and s9.generation == 9 and s9.generationUnknown == nil, json.encode(s9.slots.value.selection))
big[9] = 999
local s9b = f:contextSnapshot(spec, 16.9)
check("replacing only the ninth fixture (same count, same first eight) moves the generation (review)", s9b.generation == 10 and s9b.generationChanged == true and s9b.slots.value.selection.fixtures[9] == 999, json.encode({ s9b.generation, s9b.slots.value.selection.fixtures }))
-- KB-19 review 2: a fixture whose channels cannot be enumerated or mapped is not a confirmed "lacks the attribute":
-- the scan is partial, every slot says its discovery is incomplete and no physical range is established.
do
  local fx = FB.new({ owner = "kb19x", deps = deps({ uiChannels = function(i) if i == 64 then error("GetUIChannels exploded") end return uiOf[i] or {} end }) }):init()
  selection.list = { 63, 64 }
  local rx = fx:read("encoderSlots", nil, 19)
  local sl = rx.value.slots[1]
  check("kb20 review: a discovery failure leaves the value incomplete with the discovery reason", sl.valueComplete == false and sl.valueIncomplete:find("channel discovery failed") ~= nil, json.encode(sl.valueIncomplete))
  check("kb19 review 2: GetUIChannels raising for one fixture: scan partial, one discovery failure listed, slot 1 has no physical range and says why", rx.value.selection.partial == true and rx.value.selection.discoveryFailures == 1 and rx.value.selection.limitations[1]:find("channel discovery failed") and sl.physicalRange == nil and sl.physicalUnavailable:find("GetUIChannels exploded") and sl.discoveryIncomplete ~= nil and sl.partial == true, json.encode({ sl.physicalUnavailable, rx.value.selection }))
  local fy = FB.new({ owner = "kb19y", deps = deps({ attributeByUIChannel = function(ui) if ui == 420 then error("map exploded") end local n = attrOfUi[ui]; return n and { name = n } or nil end }) }):init()
  local ry = fy:read("encoderSlots", nil, 19.1)
  check("kb19 review 2: GetAttributeByUIChannel raising is a discovery failure too (no range, incomplete)", ry.value.selection.discoveryFailures == 1 and ry.value.slots[1].physicalRange == nil and ry.value.slots[1].physicalUnavailable:find("map exploded"), json.encode(ry.value.slots[1].physicalUnavailable))
  local fn = FB.new({ owner = "kb19n", deps = deps({ attributeByUIChannel = function(ui) if ui == 420 then return nil end local n = attrOfUi[ui]; return n and { name = n } or nil end }) }):init()
  local rn = fn:read("encoderSlots", nil, 19.15)
  check("kb19 review 3: a nil attribute lookup for an enumerated channel is a discovery failure (no range, incomplete), not a confirmed absence", rn.value.selection.discoveryFailures == 1 and rn.value.selection.partial == true and rn.value.slots[1].physicalRange == nil and rn.value.slots[1].physicalUnavailable:find("gave nothing for an enumerated channel") and rn.value.slots[1].discoveryIncomplete ~= nil, json.encode({ rn.value.slots[1].physicalUnavailable, rn.value.selection }))
  local fu = FB.new({ owner = "kb19u", deps = deps({ attributeByUIChannel = function(ui) if ui == 420 then return setmetatable({}, { __index = function(_, k) if k == "name" then error("name unreadable") end end }) end local n = attrOfUi[ui]; return n and { name = n } or nil end }) }):init()
  local ru = fu:read("encoderSlots", nil, 19.16)
  local fe = FB.new({ owner = "kb19e", deps = deps({ attributeByUIChannel = function(ui) if ui == 420 then return { name = "" } end local n = attrOfUi[ui]; return n and { name = n } or nil end }) }):init()
  local re = fe:read("encoderSlots", nil, 19.17)
  check("kb19 review 3: an attribute handle whose name raises or is empty is a discovery failure (no range, incomplete)", ru.value.selection.discoveryFailures == 1 and ru.value.slots[1].physicalRange == nil and ru.value.slots[1].physicalUnavailable:find("no readable name") and re.value.selection.discoveryFailures == 1 and re.value.slots[1].physicalRange == nil and re.value.slots[1].physicalUnavailable:find("no readable name"), json.encode({ ru.value.slots[1].physicalUnavailable, re.value.slots[1].physicalUnavailable }))
  local fz = FB.new({ owner = "kb19z", deps = deps({ uiChannels = function(i) if i == 64 then return {} end return uiOf[i] end, subfixtureCount = function(i) if i == 64 then error("count exploded") end return 0 end }) }):init()
  local rz = fz:read("encoderSlots", nil, 19.2)
  check("kb19 review 2: a raising subfixture discovery is a discovery failure (no range, incomplete)", rz.value.selection.discoveryFailures == 1 and rz.value.slots[1].physicalRange == nil and rz.value.slots[1].physicalUnavailable:find("count exploded"), json.encode(rz.value.slots[1].physicalUnavailable))
  local sOk = f:read("encoderSlots", nil, 19.3).value
  check("kb19 review 2: a confirmed missing attribute (fixture 64 has no B) is not a discovery failure: no limitation, range from the fixture that has it", sOk.selection.discoveryFailures == 0 and sOk.selection.partial == false and sOk.slots[3].availability == "mixed" and sOk.slots[3].physicalRange == 1 and sOk.slots[3].discoveryIncomplete == nil, json.encode(sOk.slots[3]))
  local fail64 = false
  local fw = FB.new({ owner = "kb19w", deps = deps({ uiChannels = function(i) if i == 64 and fail64 then error("GetUIChannels exploded") end return uiOf[i] or {} end }) }):init()
  local w1 = fw:contextSnapshot(spec, 19.4)
  fail64 = true
  local w2 = fw:contextSnapshot(spec, 19.5)
  fail64 = false
  local w3 = fw:contextSnapshot(spec, 19.6)
  check("kb19 review 2: discovery failing and recovering moves the generation each time (incomplete coverage is part of the digest), so queued motion against the earlier calibration is dropped", w1.generation == 1 and w1.slots.value.slots[1].physicalRange == 0.5 and w2.generation == 2 and w2.slots.value.slots[1].physicalRange == nil and w2.slots.value.slots[1].discoveryIncomplete ~= nil and w3.generation == 3 and w3.slots.value.slots[1].physicalRange == 0.5, json.encode({ w1.generation, w2.generation, w3.generation }))
end
-- KB-19 review: the physical range and its availability are calibration inputs, so they are part of the digest.
selection.list = { 63, 64 }
local fD = FB.new({ owner = "kb19d", deps = deps() }):init()
local d1 = fD:contextSnapshot(spec, 18)
logical[420] = H({}, { cf("ColorRGB_R 1", "ColorRGB_R", 0, 0.25) })
local d2 = fD:contextSnapshot(spec, 18.1)
logical[420] = H({}, { cf("ColorRGB_R 1", "ColorRGB_R", 0, 0.5) })
local d3 = fD:contextSnapshot(spec, 18.2)
logical[420] = H({}, {})
local d4 = fD:contextSnapshot(spec, 18.3)
logical[420] = H({}, { cf("ColorRGB_R 1", "ColorRGB_R", 0, 0.5) })
local d5 = fD:contextSnapshot(spec, 18.4)
check("kb19 review: a changed physical range moves the generation (1 -> 0.25 -> back), and so does the range becoming unreadable and readable again", d1.generation == 1 and d1.slots.value.slots[1].physicalRange == 0.5 and d2.generation == 2 and d2.slots.value.slots[1].physicalRange == 0.25 and d3.generation == 3 and d4.generation == 4 and d4.slots.value.slots[1].physicalUnavailable ~= nil and d5.generation == 5 and d5.slots.value.slots[1].physicalRange == 0.5, json.encode({ d1.generation, d2.generation, d3.generation, d4.generation, d5.generation }))
selection.list = big  -- the identity-bound checks below expect the nine-fixture selection
local fBig = FB.new({ owner = "kb17big", deps = deps(), config = { maxSelectionScan = 2, maxSelectionIdentity = 5 } }):init()
local sb = fBig:contextSnapshot(spec, 17)
check("beyond maxSelectionIdentity the identity is incomplete and no generation is claimed", sb.generation == nil and sb.generationUnknown == true and sb.slots.value.selection.identityComplete == false and #sb.slots.value.selection.fixtures == 5 and sb.generationNote:find("selection identity is incomplete") and sb.slots.value.selection.limitations[#sb.slots.value.selection.limitations]:find("bounded to 5 of 9"), tostring(sb.generation) .. " " .. tostring(sb.generationNote))
selection.list = { 101, 102, 103 }
sb = fBig:contextSnapshot(spec, 17.1)
check("a selection within the identity bound gets a generation again (first for this spec)", sb.generation == 1 and sb.generationUnknown == nil and sb.slots.value.selection.identityComplete == true)
local fNoNext = FB.new({ owner = "kb17nn", deps = deps({ selectionNext = false }) }):init()
sb = fNoNext:contextSnapshot(spec, 17.2)
check("without SelectionNext a multi-fixture selection's identity is incomplete: no generation", sb.generation == nil and sb.generationUnknown == true and sb.slots.value.selection.identityComplete == false, json.encode(sb.generationNote))
-- Review: the identity is complete only after a validated traversal (count matched, distinct ids, ended by itself).
selection.list = { 63, 64 }
local fNilFirst = FB.new({ owner = "kb17nf", deps = deps({ selectionFirst = function() return nil end }) }):init()
sb = fNilFirst:contextSnapshot(spec, 17.21)
check("SelectionFirst() nil with a nonempty selection: identity incomplete, no generation", sb.generation == nil and sb.generationUnknown == true and sb.slots.value.selection.identityComplete == false and sb.generationNote:find("gave nothing"), tostring(sb.generation) .. " " .. tostring(sb.generationNote))
local fShort = FB.new({ owner = "kb17sh", deps = deps({ selectionCount = function() return 3 end }) }):init()
sb = fShort:contextSnapshot(spec, 17.22)
check("SelectionNext() ending before the reported count: identity incomplete, no generation", sb.generation == nil and sb.generationUnknown == true and sb.slots.value.selection.identityComplete == false and #sb.slots.value.selection.fixtures == 2 and sb.generationNote:find("ended after 2 distinct fixture%(s%) but the selection count is 3"), tostring(sb.generation) .. " " .. tostring(sb.generationNote))
local fLoop = FB.new({ owner = "kb17lp", deps = deps({ selectionNext = function() return 63 end }) }):init()
sb = fLoop:contextSnapshot(spec, 17.23)
check("SelectionNext() returning the same fixture again: identity incomplete, no generation", sb.generation == nil and sb.generationUnknown == true and sb.slots.value.selection.identityComplete == false and #sb.slots.value.selection.fixtures == 1 and sb.generationNote:find("fixture 63 again"), tostring(sb.generation) .. " " .. tostring(sb.generationNote))
local fRaise = FB.new({ owner = "kb17rs", deps = deps({ selectionFirst = function() error("no first") end }) }):init()
sb = fRaise:contextSnapshot(spec, 17.24)
check("SelectionFirst() raising: identity incomplete, no generation", sb.generation == nil and sb.generationUnknown == true and sb.slots.value.selection.identityComplete == false, tostring(sb.generationNote))
sb = fShort:contextSnapshot(spec, 17.25)
check("a repeated incomplete read still claims nothing and records no generation", sb.generation == nil and sb.lastGeneration == nil)
snap = f:contextSnapshot(spec, 17.3)
check("back to the two-fixture selection (f): moved again", snap.generation == 11)
band1.Text = "Red"
snap = f:contextSnapshot(spec, 17)
check("a label-only change does not move the generation", snap.generation == 11 and snap.generationChanged == false and snap.slots.value.slots[1].label == "Red")
cf1.Text = "Rotate"
snap = f:contextSnapshot(spec, 18)
check("a channel-function change moves the generation", snap.generation == 12 and snap.generationChanged == true)
execs[201].Object = nil
snap = f:contextSnapshot(spec, 19)
check("a deleted assignment moves the generation and is reported empty", snap.generation == 13 and snap.executors[1].value.empty == true and snap.executors[1].value.playbackTarget == false and snap.executors[1].value.reason == "no assigned object")
execs[201].Object = seqMain
snap = f:contextSnapshot(spec, 20)
execs[201] = ex(201, seqMain, { keyPress = "Flash", fader = "Master" })
snap = f:contextSnapshot(spec, 21)
check("a changed key function moves the generation", snap.generation == 15 and snap.executors[1].value.functions.keyPress == "Flash")
execs[201] = ex(201, seqMain, { keyPress = "Flash", fader = "Master", encoderLeft = "Rate" })
snap = f:contextSnapshot(spec, 21.2)
check("a changed EncoderLeft function moves the generation (review 1)", snap.generation == 16 and snap.generationChanged == true and snap.executors[1].value.functions.encoderLeft == "Rate")
execs[201] = ex(201, seqMain, { keyPress = "Flash", fader = "Master", encoderLeft = "Rate", encoderRight = "Speed" })
snap = f:contextSnapshot(spec, 21.4)
check("a changed EncoderRight function moves the generation", snap.generation == 17 and snap.generationChanged == true)
execs[201] = ex(201, seqMain, { keyPress = "Flash", fader = "Master", encoderLeft = "Rate", encoderRight = "Speed", keyUnpressCombined = "<Go+>" })
snap = f:contextSnapshot(spec, 21.6)
check("a changed KeyUnpressCombined function moves the generation", snap.generation == 18 and snap.generationChanged == true)
displays[1] = nil
snap = f:contextSnapshot(spec, 22)
check("losing the encoder bar is a change of meaning: encoder/slots unavailable with reasons", snap.generation == 19 and snap.encoder.available == false and snap.encoder.reason:find("does not exist") and snap.slots.available == false)
displays[1] = display1
snap = f:contextSnapshot(spec, 23)
f:invalidate("test", 24)
snap = f:contextSnapshot(spec, 24)
check("a new epoch moves the generation", snap.epoch == 2 and snap.generation == 21 and snap.generationChanged == true)
console.showFile = "show-b"
snap = f:contextSnapshot(spec, 30)
check("a show change is detected by the snapshot and moves the generation", snap.invalidated == "show-changed" and snap.epoch == 3 and snap.identity.showFile == "show-b" and snap.generation == 22)
local other = f:contextSnapshot({ executors = { 205 }, display = 1 }, 31)
check("another spec has its own generation record and the requested rule", other.generation == 1 and other.bindingKey == "display=1;executors=205" and other.authoritativeDisplay.rule == "requested" and #other.executors == 1)
snap = f:contextSnapshot(spec, 32)
check("the first spec's record is untouched by the other", snap.generation == 22 and snap.generationChanged == false)
snap = f:contextSnapshot({ executors = { 201 }, allExecutors = true }, 33)
local idx = {}
for _, x in ipairs(snap.executors) do idx[#idx + 1] = x.value and x.value.executor or x.params.executor end
check("allExecutors adds the page's assigned executors once each", #snap.executors == 5 and idx[1] == 201 and idx[2] == 202 and idx[5] == 208 and snap.pageExecutors ~= nil, json.encode(idx))
local f10 = FB.new({ owner = "kb17j", deps = deps(), config = { maxExecutors = 2 } }):init()
snap = f10:contextSnapshot({ allExecutors = true }, 34)
check("allExecutors is bounded by maxExecutors", #snap.executors == 2 and snap.limitations[1]:find("truncated"), json.encode(snap.limitations))
snap = f10:contextSnapshot({ executors = { 201, 202, 203 } }, 35)
check("executors are bounded with a limitation", #snap.executors == 2 and snap.limitations[1]:find("truncated to 2 of 3"))
snap = f10:contextSnapshot({ executors = "201" }, 36)
check("a malformed executors list is a limitation, not a raise", #snap.executors == 0 and snap.limitations[1]:find("must be a list"))
for i = 1, 10 do f10:contextSnapshot({ executors = { 300 + i } }, 40 + i) end
local n = 0
for _ in pairs(f10._generations) do n = n + 1 end
check("generation records are bounded by maxGenerations", n == 8)
check("contextSnapshot before init raises", not pcall(FB.new({ owner = "x", deps = deps() }).contextSnapshot, FB.new({ owner = "x", deps = deps() }), {}, 1))
local f11 = FB.new({ owner = "kb17k", deps = { showFile = function() return "s" end } }):init()
snap = f11:contextSnapshot({ executors = { 1 } }, 50)
check("missing dependencies: every part unavailable with a reason or error, the snapshot still answers", snap.identity.dataPoolUnavailable:find("deps.dataPool missing") and snap.executorPageUnavailable ~= nil and snap.encoder.available == false and snap.slots.available == false and snap.executors[1].available == false and snap.generation == 1, json.encode({ identity = snap.identity, page = tostring(snap.executorPageUnavailable), encoder = tostring(snap.encoder.reason or snap.encoder.error), slots = tostring(snap.slots.reason or snap.slots.error), exec = tostring(snap.executors[1].error or snap.executors[1].reason) }))

-------------------------------------------------------------------------------
-- Cached snapshots through watchContext()/service()
-------------------------------------------------------------------------------
local fc = FB.new({ owner = "kb17w", deps = deps(), config = { maxReadsPerService = 2, pollIntervalMs = 100, staleMs = 1000 } }):init()
local w = fc:watchContext({ executors = { 201, 205 } }, 100)
check("watchContext subscribes the snapshot's items", w.watched == 6 and #w.items == 6 and w.items[4].name == "encoderSlots" and w.items[4].params.display == 1, json.encode(w))
snap = fc:contextSnapshot({ executors = { 201, 205 } }, 100, { cached = true })
check("cached before any service: everything not observed, snapshot stale", snap.cached == true and snap.stale == true and snap.notObserved == 6 and snap.encoder.available == false and snap.encoder.reason:find("not observed yet") and snap.executors[1].stale == true and snap.generation == nil and snap.generationUnknown == true and snap.lastGeneration == nil and snap.generationNote:find("no generation"), json.encode(snap.encoder))
local sv = fc:service(100.0)
check("service reads at most maxReadsPerService items", sv.reads == 2 and sv.due == 4)
fc:service(100.01); fc:service(100.02)
snap = fc:contextSnapshot({ executors = { 201, 205 } }, 100.03, { cached = true })
check("cached after a full round: every part observed, not stale, ages reported", snap.stale == nil and snap.notObserved == 0 and snap.encoder.available and snap.slots.available and snap.executors[2].value.level.token == "FaderTemp" and snap.encoder.ageMs ~= nil and snap.encoder.stale == false and snap.generation == 1 and snap.generationChanged == false and snap.generationNote:find("first snapshot"), tostring(snap.stale) .. " notObserved=" .. tostring(snap.notObserved) .. " encoder=" .. tostring(snap.encoder.available) .. " gen=" .. tostring(snap.generation))
check("a cached snapshot reads nothing", fc:status().reads == 6)
console.bank = 1
snap = fc:contextSnapshot({ executors = { 201, 205 } }, 100.05, { cached = true })
check("a console change not yet polled is not visible: generation unchanged", snap.generation == 1 and snap.encoder.value.bank.name == "Color")
fc:service(100.2); fc:service(100.21); fc:service(100.22)
snap = fc:contextSnapshot({ executors = { 201, 205 } }, 100.23, { cached = true })
check("after polling: the bank change is seen and the generation moves without any input", snap.generation == 2 and snap.generationChanged == true and snap.encoder.value.bank.name == "Position" and snap.slots.value.slots[1].name == "Pan")
snap = fc:contextSnapshot({ executors = { 201, 205 } }, 102, { cached = true })
check("old observations are stale by age", snap.stale == true and snap.encoder.stale == true and snap.encoder.ageMs > 1000 and snap.generation == 2)
snap = fc:contextSnapshot({ executors = { 201, 205 }, allExecutors = true }, 102, { cached = true })
check("allExecutors on a cached snapshot is a limitation", snap.limitations[1]:find("live%-read option"))
fc:invalidate("disconnect", 103)
snap = fc:contextSnapshot({ executors = { 201, 205 } }, 103, { cached = true })
check("after an invalidation nothing from the old epoch is presented and no generation is claimed", snap.notObserved == 6 and snap.encoder.reason:find("not observed since disconnect") and snap.generation == nil and snap.generationUnknown == true and snap.lastGeneration == 2)
fc:service(104); fc:service(104.01); fc:service(104.02)
snap = fc:contextSnapshot({ executors = { 201, 205 } }, 104.03, { cached = true })
check("once observed again in the new epoch the generation resumes and has moved", snap.generation == 3 and snap.generationChanged == true and snap.epoch == 2)
fc:unwatch()
check("unwatch clears the watch", fc:status().watched == 0)
console.bank = 3

-------------------------------------------------------------------------------
-- KB-21: explicit targets (pool, page, executor, mode), paged reads, layout, independent pages
-------------------------------------------------------------------------------
do
  local fk = FB.new({ owner = "kb21", deps = deps() }):init()
  local r = fk:read("executorTarget", { executor = 201 }, 1)
  check("kb21: a current-page target carries pool, page, mode=current and width", r.available and r.value.mode == "current" and r.value.pool.name == "Default" and r.value.pool.no == 1 and r.value.page.no == 1 and r.value.width == 1 and r.value.expanded == nil and r.value.coveredBy == nil and r.value.playbackTarget == true and r.key == "executorTarget[executor=201]", json.encode(r))
  r = fk:read("executorTarget", { executor = 201, page = 2 }, 1)
  check("kb21: an explicit page is read through ObjectList, not GetExecutor; key and identity say so", r.available and r.value.mode == "page" and r.value.page.no == 2 and r.value.page.name == "Page 2" and r.value.assigned.name == "Two" and r.value.level.value == 30 and r.value.playbackTarget == true and r.key == "executorTarget[executor=201,page=2]", json.encode(r))
  local fe = FB.new({ owner = "kb21e", deps = deps({ executor = function(n) if execs[n] then return execs[n], pageH end return nil end }) }):init()
  r = fe:read("executorTarget", { executor = 209 }, 1)
  check("kb21 live: an empty executor on the current page (GetExecutor returns no page handle) still carries the user's page", r.available and r.value.empty == true and r.value.page and r.value.page.no == 1 and r.value.mode == "current", json.encode(r.value))
  r = fk:read("executorTarget", { executor = 201, page = 7 }, 1)
  check("kb21: a page that does not exist is pageMissing, empty, never a target, never created", r.available and r.value.pageMissing == true and r.value.page.no == 7 and r.value.empty == true and r.value.playbackTarget == false and r.value.reason:find("does not exist") and pages[7] == nil, json.encode(r))
  r = fk:read("executorTarget", { executor = 211, page = 2 }, 1)
  check("kb21: an expanded assignment reports its width and is a target", r.available and r.value.width == 2 and r.value.expanded == true and r.value.playbackTarget == true and r.value.coveredBy == nil, json.encode(r))
  r = fk:read("executorTarget", { executor = 212, page = 2 }, 1)
  check("kb21: the number inside a wider neighbour's span is covered: not a separate playback", r.available and r.value.empty == true and r.value.coveredBy == 211 and r.value.coveredWidth == 2 and r.value.playbackTarget == false and r.value.reason:find("covered by executor 211"), json.encode(r))
  r = fk:read("executorTarget", { executor = 213, page = 2 }, 1)
  check("kb21: the first number after the span is its own playback", r.available and r.value.coveredBy == nil and r.value.playbackTarget == true and r.value.assigned.name == "Odd", json.encode(r))
  r = fk:read("executorTarget", { executor = 116, page = 2 }, 1)
  local r2 = fk:read("executorTarget", { executor = 117, page = 2 }, 1)
  local r3 = fk:read("executorTarget", { executor = 118, page = 2 }, 1)
  check("kb21: a width of 3 covers the next two numbers and not the third", r.value.coveredBy == 115 and r2.value.coveredBy == 115 and r3.value.coveredBy == nil, json.encode({ r.value, r2.value, r3.value }))
  r = fk:read("executorTarget", { executor = 201, page = 2 }, 1)
  check("kb21: a span never crosses the row (115 width 3 does not cover 201)", r.value.coveredBy == nil, json.encode(r.value))
  local fw = FB.new({ owner = "kb21w", deps = deps(), config = { maxExecutorWidth = 2 } }):init()
  r = fw:read("executorTarget", { executor = 117, page = 2 }, 1)
  check("kb21: the neighbour scan is bounded by maxExecutorWidth (117 is two behind 115; not resolved at width bound 2)", r.available and r.value.coveredBy == nil, json.encode(r.value))
  r = fk:read("executorTarget", { executor = 201, page = 0 }, 1)
  check("kb21: a bad page parameter is an error item", r.available == false and r.error:find("params.page"), json.encode(r))
  local fn = FB.new({ owner = "kb21n", deps = deps({ pageByNo = false, pagedExecutor = false }) }):init()
  r = fn:read("executorTarget", { executor = 201, page = 2 }, 1)
  check("kb21: without the paged dependencies an explicit page is an explicit error, the current page still reads", r.available == false and r.error:find("pageByNo") and fn:read("executorTarget", { executor = 201 }, 1).available, json.encode(r))
  r = fk:read("pageExecutors", { page = 2 }, 1)
  check("kb21: pageExecutors reads an explicit page with widths", r.available and r.value.page.no == 2 and #r.value.executors == 4 and r.value.executors[3].index == 211 and r.value.executors[3].width == 2 and r.key == "pageExecutors[page=2]", json.encode(r))
  r = fk:read("pageExecutors", { page = 9 }, 1)
  check("kb21: pageExecutors on a missing page is pageMissing with no executors", r.available and r.value.pageMissing == true and #r.value.executors == 0, json.encode(r))
  check("kb21: pageExecutors without params keeps its old key", fk:read("pageExecutors", nil, 1).key == "pageExecutors")

  -- Binding: current-page executors follow the console's page; an independent page does not.
  local follow = { executors = { 201, 211 } }
  local indep = { executors = { 201, 211, 212 }, executorPage = 2 }
  local s1 = fk:contextSnapshot(follow, 2)
  local s2 = fk:contextSnapshot(indep, 2)
  check("kb21: the binding key names the page of an independent binding; the snapshot says its mode", s1.bindingKey == "display=1;executors=201,211" and s2.bindingKey == "display=1;executors=201,211,212;page=2" and s1.executorMode == "current" and s2.executorMode == "page" and s2.executorSpecPage == 2 and s2.executors[3].value.coveredBy == 211, s1.bindingKey .. " / " .. s2.bindingKey)
  local items = fk:contextItems(indep)
  check("kb21: contextItems carries the page into every executor item", items[5].params.page == 2 and items[7].params.executor == 212 and items[7].params.page == 2)
  -- The console changes page: the user's page is now page 2.
  local pageWas = pageH
  local dp = deps(); dp.currentExecPage = function() return page2 end; dp.executor = function(n) return execs2[n], page2 end
  local fp = FB.new({ owner = "kb21p", deps = dp }):init()
  -- Same instance semantics are per instance; stage both specs on a fresh instance whose deps switch pages.
  local cur = { page = pageH, execs = execs }
  local d2 = deps(); d2.currentExecPage = function() return cur.page end; d2.executor = function(n) return cur.execs[n], cur.page end
  local fs = FB.new({ owner = "kb21s", deps = d2 }):init()
  local a1 = fs:contextSnapshot(follow, 3); local b1 = fs:contextSnapshot(indep, 3)
  cur.page, cur.execs = page2, execs2
  local a2 = fs:contextSnapshot(follow, 4); local b2 = fs:contextSnapshot(indep, 4)
  check("kb21: a console page change moves the generation of a following binding (its targets are now page 2's)", a2.generation == a1.generation + 1 and a2.generationChanged == true and a2.executors[1].value.page.no == 2 and a2.executors[1].value.assigned.name == "Two", json.encode({ a1.generation, a2.generation }))
  check("kb21: a console page change does not move an independent-page binding", b2.generation == b1.generation and b2.generationChanged == false and b2.executorPage.no == 2 and b2.executors[1].value.page.no == 2, json.encode({ b1.generation, b2.generation, b2.executorPage }))
  cur.page, cur.execs = pageWas, execs
  -- A width change and a page appearing/disappearing move the generation of the independent binding.
  execs2[211] = wide(211, seqTwo, 1, { keyPress = "Go+", fader = "Master" })
  local b3 = fs:contextSnapshot(indep, 5)
  check("kb21: a changed width moves the generation and uncovers the neighbour", b3.generation == b2.generation + 1 and b3.executors[3].value.coveredBy == nil and b3.executors[3].value.empty == true, json.encode(b3.executors[3].value))
  execs2[211] = wide(211, seqTwo, 2, { keyPress = "Go+", fader = "Master" })
  fs:contextSnapshot(indep, 6)
  pages[2] = nil
  local b4 = fs:contextSnapshot(indep, 7)
  check("kb21: a deleted page moves the generation and every target is pageMissing", b4.generationChanged == true and b4.executors[1].value.pageMissing == true and b4.executors[2].value.playbackTarget == false, json.encode(b4.executors[1].value))
  pages[2] = page2
  local b5 = fs:contextSnapshot({ executors = { 201 }, executorPage = "two" }, 8)
  check("kb21: a bad executorPage is reported and the executors follow the current page", b5.limitations[1]:find("executorPage") and b5.executorMode == "current" and b5.executors[1].params.page == nil, json.encode(b5.limitations))
  -- Cached path, a page change (KB-21 live): the page item is re-read before the executors; while any following
  -- executor still shows the old page no generation is claimed, and the full re-read moves it exactly once.
  do
    local cp = { page = pageH, execs = execs }
    local dpc = deps(); dpc.currentExecPage = function() return cp.page end; dpc.executor = function(n) if cp.execs[n] then return cp.execs[n], cp.page end return nil end
    local fpc = FB.new({ owner = "kb21pc", deps = dpc, config = { maxReadsPerService = 2, pollIntervalMs = 0 } }):init()
    local sp = { executors = { 201, 202, 203, 205 } }
    fpc:watchContext(sp, 1)
    for i = 1, 8 do fpc:service(1 + i * 0.01) end
    local c0 = fpc:contextSnapshot(sp, 1.2, { cached = true })
    check("kb21 page change: before the change the cached snapshot claims generation 1", c0.generation == 1 and c0.pageChangePending == nil, tostring(c0.generation) .. " " .. tostring(c0.generationNote))
    cp.page, cp.execs = page2, execs2
    -- The items are re-read in order: dataPool, page first; the executors a few per tick.
    fpc:service(1.3)  -- dataPool, page
    local c1 = fpc:contextSnapshot(sp, 1.31, { cached = true })
    check("kb21 page change: the page item already says page 2 while the executors still show page 1: no generation, the reason names the re-read", c1.generation == nil and c1.generationUnknown == true and c1.pageChangePending == 4 and c1.lastGeneration == 1 and c1.executorPage.no == 2 and c1.generationNote:find("observed on another page"), tostring(c1.generation) .. " " .. tostring(c1.pageChangePending) .. " " .. tostring(c1.generationNote))
    fpc:service(1.4); fpc:service(1.5)  -- encoder bank, slots, then two executors
    local c2 = fpc:contextSnapshot(sp, 1.51, { cached = true })
    check("kb21 page change: half the executors re-read is still no generation", c2.generation == nil and c2.pageChangePending == 2, tostring(c2.generation) .. " " .. tostring(c2.pageChangePending))
    fpc:service(1.6)
    local c3 = fpc:contextSnapshot(sp, 1.61, { cached = true })
    check("kb21 page change: once every executor was observed on page 2 the generation moves exactly once (1 -> 2)", c3.generation == 2 and c3.generationChanged == true and c3.pageChangePending == nil and c3.executors[1].value.page.no == 2, tostring(c3.generation) .. " " .. tostring(c3.generationNote))
    for i = 1, 6 do fpc:service(1.7 + i * 0.01) end
    local c4 = fpc:contextSnapshot(sp, 1.8, { cached = true })
    check("kb21 page change: it stays at 2 afterwards", c4.generation == 2 and c4.generationChanged == false)
    cp.page, cp.execs = pageH, execs
  end
  -- Cached path: watchContext with an independent page observes the paged items.
  local fcch = FB.new({ owner = "kb21c", deps = deps() }):init()
  fcch:watchContext(indep, 1)
  for i = 1, 4 do fcch:service(1 + i * 0.2) end
  local c = fcch:contextSnapshot(indep, 2, { cached = true })
  check("kb21: the cached snapshot of an independent page carries the page and generation", c.generation == 1 and c.executorMode == "page" and c.executors[1].value.page.no == 2 and c.executors[3].value.coveredBy == 211, json.encode({ c.generation, c.notObserved, c.generationNote }))
end

print(string.format("\n%d passed, %d failed", passes, failures))
if failures > 0 then print("FAILED"); os.exit(1) else print("ALL PASSED") end
