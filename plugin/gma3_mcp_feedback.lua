-- gma3_mcp_feedback.lua
--
-- Instance-based read-only console feedback module for grandMA3 onPC plugins (KB-02 packaging,
-- KB-06 readers, freshness and bounded polling, KB-17 control-context and binding snapshots).
--
-- A ComponentLua of a UserPlugin: the console runs this chunk at import/reload and it only returns a
-- module table. Nothing is read from the console until a consumer calls read()/readMany()/service()
-- on an instance. Readers are the state sources confirmed in KB-01; anything not confirmed is
-- reported as unavailable with a reason, never as a guessed false or zero.
--
-- Response contract (every observation, KB-06):
--   { name, key, scope, source, params?, available, value?, reason? | error?, observedAt, epoch, note? }
--   * available=false carries `reason` (the console gave nothing usable: nil, an unrecognised value, a
--     missing display/sequence/executor, a reader that is not implemented) or `error` (the reader
--     raised). A `false` value is always available=true. One failing reader never affects another.
--   * observedAt is the consumer's clock (seconds) at the time of that single read. Several items of
--     one readMany() are read one after another, not as an atomic snapshot of the console.
--   * epoch counts invalidations: the instance bumps it when the show file, user or user profile it
--     observes changes (checked in service()/readMany() at most every config.identityCheckMs) and
--     when the consumer calls invalidate() (disconnect, restart). Cached observations of an older
--     epoch are dropped, never reported as current.
--   * lastCommand and maState are observations of shared console state: they do not identify which
--     request, client or key source produced them.
--
-- Control context (KB-17, 0.3.0): the readers dataPool, encoderBank, encoderSlots, executorTarget and
-- pageExecutors describe what a surface control would operate (the KB-16 read paths), and
-- contextSnapshot(spec, now, opts) assembles them into one bounded snapshot with a binding
-- `generation` that changes whenever an input's meaning changed (bank/page/context, the selection's
-- fixtures, slot objects, resolution/readout/channel function/availability, executor assignment and
-- functions, identity, epoch) and never for a value or level alone; no generation is claimed while the
-- selection identity or a watched part is unknown. The encoder bar of config.encoderDisplay (or params.display) is the
-- authoritative one: a display without an encoder bar is reported unavailable, another display is
-- never substituted. The context readers are not part of readAll()/`all` (they cost more than one
-- property read); watch() them for service() polling and build the snapshot from the cache with
-- opts.cached = true.
--
-- Physical ranges (KB-19, 0.4.0): each attribute slot also carries the flat fields physicalFrom,
-- physicalTo, physicalRange, physicalFunction, physicalFunctionIndex, physicalFunctions,
-- physicalFixtures, physicalMixed?, physicalNote?: the range of the channel function that belongs to
-- the slot's attribute, read from GetUIChannel(ui).logical_channel (the fixture type's logical channel:
-- its children are the ChannelFunctions with PhysicalFrom/PhysicalTo) for every scanned fixture that
-- has the channel; with several fixture types the smallest range is reported (the console sizes one
-- encoder click by it, manual "Encoder resolution") and physicalMixed says they differ. The range is
-- reported only when it is complete and verified: every fixture with the channel contributed its own
-- function's range and the bounded scan covered the whole selection; otherwise physicalUnavailable
-- carries the reason. The range and its availability are part of the binding digest (a change moves
-- the generation, so queued motion calibrated against the old range is dropped). The adjustment backend needs it for the Physical readout, where "At" takes
-- physical units (live: Pan "At 10" = 10 degrees).
--
-- Explicit executor targets (KB-21, 0.5.0): executorTarget takes { executor, page? }. Without a page it
-- reads the user's CURRENT page (GetExecutor; the target follows the console's page changes); with a
-- page number it reads that page through ObjectList("Page P.E") whatever page the console shows (an
-- independent page; a page that does not exist is reported pageMissing, never created). Every target
-- carries its identity explicitly: pool (DataPool()), page {no, name}, executor, mode (current | page).
-- LAYOUT: an executor's Width (an expanded assignment) makes it occupy the following executor numbers
-- of its row (the same hundred block): executorTarget reports width and, for a number inside a wider
-- neighbour's span, coveredBy (that executor) with playbackTarget = false: adjacent numbers are not
-- assumed to be separate playbacks. The neighbour scan is bounded by config.maxExecutorWidth. The page
-- number, mode, width, coverage and page existence are part of the binding digest; the user's current
-- page is part of it only while some bound executor follows it, so an independent-page binding does
-- not move when the console's page changes. contextSnapshot({ executors, executorPage? }) binds every
-- listed executor to that page.
-- MODULE API 1, module version 0.5.0. Lifecycle: new() -> init() -> read()/readMany()/watch()/service()
-- ... -> dispose(). Consumers pass dependencies via opts.deps (consoleDeps(_G) builds lazy closures)
-- and keep one instance each; the module table is read-only and nothing here uses globals or
-- package.loaded.

local NAME        = "gma3_mcp_feedback"
local VERSION     = "0.5.0"
local API_VERSION = 1

local DEFAULTS = {
  maxItems           = 64,    -- items per readMany()/watch(); the rest are reported truncated, not read
  maxExecutors       = 32,    -- executors expanded by itemsFor() per request
  maxReadsPerService = 8,     -- watched items read per service() call (bounded per-frame work)
  pollIntervalMs     = 100,   -- a watched item is not re-read before this much time passed
  staleMs            = 2000,  -- a cached observation older than this is reported stale
  identityCheckMs    = 1000,  -- show file / user / profile identity re-read at most this often
  defaultDisplay     = 1,
  -- KB-17 control context
  encoderDisplay     = 1,     -- the display whose encoder bar is authoritative (KB-16: display 1 on onPC)
  encoderBar         = 1,     -- the EncoderBar of CurrentProfile().EncoderBarPool whose banks/pages are read
  maxSlots           = 5,     -- encoder slots read per page (the pool page has five; onPC renders four)
  maxSelectionScan   = 8,     -- selected (sub)fixtures scanned for availability and value state per read
  maxSelectionIdentity = 512, -- selected fixture ids walked for the selection identity (no channel reads)
  maxUIChannels      = 64,    -- UI channels mapped per scanned fixture
  maxGenerations     = 8,     -- binding-generation records kept (one per distinct snapshot spec)
  -- KB-21 executor layout
  maxExecutorWidth   = 5,     -- how far back executorTarget looks for a wider neighbour covering the number
}

-- Strict boolean: the console reports FADERENABLED-style properties as "true"/"false" text or booleans.
-- Anything else is reported as unavailable by the reader, never passed through as a truthy value.
local function toBool(v)
  if v == true or v == "true" or v == "True" or v == 1 then return true end
  if v == false or v == "false" or v == "False" or v == 0 then return false end
  if v == nil then return nil, "the console returned nothing for this property" end
  return nil, string.format("unrecognised value %s (%s) is reported as unavailable, not as false", tostring(v), type(v))
end

local function positiveInt(v, what)
  if type(v) ~= "number" or v ~= math.floor(v) or v < 1 then error(what .. " must be a positive integer", 0) end
  return v
end

local function handleInfo(h)
  if h == nil then return nil end
  local out = { name = tostring(h.name) }
  local ok, c = pcall(function() return h:GetClass() end); if ok and c ~= nil then out.class = tostring(c) end
  local okA, a = pcall(function() return h:Addr() end);   if okA and a ~= nil then out.addr = tostring(a) end
  local okN, n = pcall(function() return h:Get("No") end); if okN and tonumber(n) then out.no = tonumber(n) end
  return out
end

local function faderOf(h, token)
  local okV, v = pcall(h.GetFader, h, { token = token })
  if not okV then error("GetFader failed: " .. tostring(v), 0) end
  if type(v) ~= "number" then return nil, "GetFader returned " .. type(v) .. ", not a level" end
  local okT, text = pcall(h.GetFaderText, h, { token = token })
  return { token = token, value = v, text = (okT and text ~= nil) and tostring(text) or nil }
end

-------------------------------------------------------------------------------
-- KB-17 control context: the read paths KB-16 qualified live on onPC 2.5.1
-- (docs/probes/kb-16-encoders-macos-2.5.1.md), each one under pcall so a missing widget, property or
-- object is an explicit field of the result, never a raise that hides the rest.
-------------------------------------------------------------------------------
local function field(h, k)
  if h == nil then return nil end
  local ok, v = pcall(function() return h[k] end)
  if ok then return v end
  return nil
end
local function classOf(h) local ok, c = pcall(function() return h:GetClass() end); if ok and c ~= nil then return tostring(c) end; return nil end
local function countOf(h) local ok, n = pcall(function() return h:Count() end); if ok then return tonumber(n) or 0 end; return 0 end
local function ptr(h, i) local ok, x = pcall(function() return h:Ptr(i) end); if ok then return x end; return nil end
local function findClass(h, c)
  for i = 1, countOf(h) do local x = ptr(h, i); if x ~= nil and classOf(x) == c then return x end end
  return nil
end
local function str(v) if v == nil then return nil end; return tostring(v) end

-- A property in its display role: the string the editors show ("Attribute 107 'ColorRGB_R'", "Temp",
-- "Coarse"). Plain field access returns nil for link properties on 2.5.1 (KB-16), so this is the one
-- way to read slot objects and executor functions. nil when the property is absent or the read raises.
local function roleDisplay(d)
  if type(d.enums) ~= "function" then return nil end
  local ok, e = pcall(d.enums)
  if ok and type(e) == "table" and type(e.Roles) == "table" then return e.Roles.Display end
  return nil
end
local function dget(d, h, prop)
  if h == nil then return nil end
  local role = roleDisplay(d)
  local ok, v = pcall(function() if role ~= nil then return h:Get(prop, role) end; return h:Get(prop) end)
  if ok and v ~= nil then return tostring(v) end
  return nil
end

-- "Attribute 107 'ColorRGB_R'" -> { ref, class = "Attribute", index = 107, name = "ColorRGB_R" }. nil for
-- an empty reference. A string in another shape is kept as ref/name so nothing is guessed.
local function parseRef(s)
  if s == nil then return nil end
  s = tostring(s)
  if s == "" then return nil end
  local class, idx, name = s:match("^(%a+)%s+(%d+)%s+'(.*)'$")
  if class then return { ref = s, class = class, index = tonumber(idx), name = name } end
  local class2, idx2 = s:match("^(%a+)%s+(%d+)$")
  if class2 then return { ref = s, class = class2, index = tonumber(idx2) } end
  return { ref = s, name = s }
end

-- A user attribute preference value: "<Percent>" is the inherited default, "Fine" an override.
local function prefValue(s)
  if s == nil then return nil, nil end
  local inner = s:match("^<(.*)>$")
  if inner then return inner, true end
  return s, false
end

-- The encoder bar widgets of one display (KB-16): the bank selector, the preset bar with its page
-- selector, context and places. nil plus a reason when that display has no encoder bar; the caller
-- never substitutes another display (the authoritative display is configured or requested, not found).
local function encoderUi(d, displayIndex)
  local disp = d.display(displayIndex)
  if disp == nil then return nil, "display " .. displayIndex .. " does not exist on this console" end
  local ebc = field(disp, "EncoderBarContainer")
  if ebc == nil then return nil, "display " .. displayIndex .. " has no encoder bar (no EncoderBarContainer); no other display is substituted" end
  local grid = field(ebc, "EncoderBarGrid")
  local base = field(field(grid, "EncoderBarBase"), "EncoderBarContainer")
  local selector = field(base, "EncoderBankSelector")
  local presetBar = findClass(field(grid, "EncoderBar"), "PresetBar")
  if selector == nil or presetBar == nil then return nil, "display " .. displayIndex .. " has an encoder bar without EncoderBankSelector/PresetBar" end
  return { display = displayIndex, selector = selector, presetBar = presetBar }
end

-- Bank and page selector values (0-based SelectedItemValueI64, current at the next Lua read; SelectedItemIdx
-- lags one UI refresh) and the preset-bar context ("Default" = attribute editing).
local function readBankPage(ui)
  local bank = tonumber(field(ui.selector, "SelectedItemValueI64"))
  local pageSel = field(field(ui.presetBar, "Options"), "PageSelector")
  local page = pageSel ~= nil and tonumber(field(pageSel, "SelectedItemValueI64")) or nil
  return bank, page, str(field(ui.presetBar, "Context"))
end

-- On-screen places: the inner band's label (short name), resolution and the channel-function selector per
-- slot. Places beyond the page's slot count keep stale labels (KB-16), so the caller trims to the pool page.
local function readPlaces(ui, maxSlots)
  local out = {}
  local area = field(ui.presetBar, "EncodersArea")
  if area == nil then return out end
  for p = 1, maxSlots do
    local place = field(area, "EncoderPlace" .. p)
    if place ~= nil and countOf(place) > 0 then
      local r, gridNo = {}, 0
      for i = 1, countOf(place) do
        local g = ptr(place, i)
        if g ~= nil and classOf(g) == "UILayoutGrid" then
          gridNo = gridNo + 1
          if gridNo == 1 then
            for j = 1, countOf(g) do
              local c = ptr(g, j)
              local k = c ~= nil and classOf(c) or nil
              local n = c ~= nil and str(field(c, "name")) or ""
              if k == "BandFader" then r.label = str(field(c, "Text")); r.resolution = str(field(c, "Resolution"))
              elseif k == "SwipeButtonList" and n:match("^ChannelFunctionSelector") then
                r.channelFunction = str(field(c, "Text")); r.channelFunctionIndex = tonumber(field(c, "SelectedItemIdx"))
              end
            end
          end
        end
      end
      out[p] = r
    end
  end
  return out
end

-- The profile's encoder bar pool: bar -> banks -> pages -> encoders (1-based). nil plus a reason when the
-- bar, bank or page does not exist (a selector value with no pool page is reported, never mapped).
local function poolPage(d, barIndex, bankNo, pageNo)
  local pool = field(d.currentProfile(), "EncoderBarPool")
  if pool == nil then return nil, "CurrentProfile().EncoderBarPool is not readable" end
  local bar = ptr(pool, barIndex)
  if bar == nil then return nil, "encoder bar " .. barIndex .. " does not exist in the profile's EncoderBarPool" end
  local bank = ptr(bar, bankNo)
  if bank == nil then return nil, string.format("bank %d does not exist in encoder bar %d of the profile pool (%d banks)", bankNo, barIndex, countOf(bar)) end
  local page = ptr(bank, pageNo)
  if page == nil then return nil, string.format("page %d does not exist in bank %d '%s' of the profile pool (%d pages)", pageNo, bankNo, str(field(bank, "name")) or "", countOf(bank)) end
  return { bar = bar, bank = bank, page = page, bankName = str(field(bank, "name")), pageName = str(field(page, "name")), bankCount = countOf(bar), pageCount = countOf(bank), slotCount = countOf(page) }
end

local ATTR_FIELDS = { feature = "Feature", unit = "PhysicalUnit", readout = "NaturalReadout", resolution = "EncoderResolution", color = "Color", channelFunctions = "ChannelFunctions", special = "Special" }
local function attributeMeta(d, name)
  if type(d.attributeDefinitions) ~= "function" then return nil, "deps.attributeDefinitions missing" end
  local okD, defs = pcall(d.attributeDefinitions)
  if not okD then return nil, "AttributeDefinitions are not readable: " .. tostring(defs) end
  local a = field(defs, name)
  if a == nil then return nil, "attribute '" .. name .. "' is not in the show's attribute definitions" end
  local out = {}
  for k, p in pairs(ATTR_FIELDS) do out[k] = dget(d, a, p) end
  if out.channelFunctions ~= nil then out.channelFunctions = tonumber(out.channelFunctions) or out.channelFunctions end
  if type(d.attributeIndex) == "function" then local okI, idx = pcall(d.attributeIndex, name); if okI and tonumber(idx) then out.index = tonumber(idx) end end
  return out
end
local function userPreference(d, name)
  local a = field(field(d.currentProfile(), "UserAttributePreferences"), name)
  if a == nil then return nil end
  local out = {}
  out.readout, out.readoutInherited = prefValue(dget(d, a, "NaturalReadout"))
  out.resolution, out.resolutionInherited = prefValue(dget(d, a, "EncoderResolution"))
  out.pressFactor = dget(d, a, "EncoderPressFactor")
  return out
end

-- Selected (sub)fixtures with a map attribute name -> UI channel, bounded by config.maxSelectionScan
-- fixtures and config.maxUIChannels channels each. A grouping fixture without UI channels is read
-- through its first subfixture (KB-16). `partial` says the scan did not cover the whole selection.
local function scanSelection(d, cfg)
  local okC, count = pcall(d.selectionCount)
  if not okC then error("SelectionCount failed: " .. tostring(count), 0) end
  count = tonumber(count) or 0
  -- identityComplete starts false (KB-17 review) and becomes true only after a traversal that ended by itself,
  -- within the bound, and yielded exactly `count` distinct fixture ids.
  -- discoveryFailures (KB-19 review): fixtures whose channels could not be enumerated or mapped (GetUIChannels,
  -- GetAttributeByUIChannel, subfixture discovery raising or answering with the wrong type). Such a fixture is NOT a
  -- confirmed "lacks the attribute": the scan is marked partial and every slot says its coverage is incomplete.
  local scan = { count = count, fixtures = {}, ids = {}, partial = false, identityComplete = false, limitations = {}, discoveryFailures = {} }
  local function discoveryFailed(fixture, why)
    scan.partial = true
    scan.discoveryFailures[#scan.discoveryFailures + 1] = { fixture = fixture, reason = why }
    scan.limitations[#scan.limitations + 1] = string.format("fixture %s: channel discovery failed (%s); it is not confirmed to lack any attribute", tostring(fixture), why)
  end
  if count == 0 then scan.identityComplete = true; return scan end
  local function incomplete(why) scan.identityLimitation = why; scan.limitations[#scan.limitations + 1] = why end
  if type(d.selectionFirst) ~= "function" then scan.partial = true; incomplete("deps.selectionFirst missing: the selection cannot be walked"); return scan end
  local okF, idx = pcall(d.selectionFirst)
  if not okF then scan.partial = true; incomplete("SelectionFirst() failed: " .. tostring(idx)); return scan end
  if idx == nil then scan.partial = true; incomplete("SelectionFirst() gave nothing although the selection is not empty"); return scan end
  local seen, ended, failure = {}, false, nil
  while idx ~= nil do
    if seen[idx] then failure = "SelectionNext() returned fixture " .. tostring(idx) .. " again; the walk is not a traversal"; break end
    if #scan.ids >= cfg.maxSelectionIdentity then failure = string.format("selection identity bounded to %d of %d fixtures", #scan.ids, count); break end
    seen[idx] = true
    scan.ids[#scan.ids + 1] = idx
    if #scan.fixtures < cfg.maxSelectionScan then
      -- bounded attribute scan: UI channels of this (sub)fixture
      local target = idx
      local failed = false
      local okU, ui = pcall(d.uiChannels, idx)
      if not okU then discoveryFailed(idx, "GetUIChannels raised: " .. tostring(ui)); ui = {}; failed = true
      elseif type(ui) ~= "table" then discoveryFailed(idx, "GetUIChannels returned " .. type(ui)); ui = {}; failed = true end
      if not failed and #ui == 0 and type(d.subfixtureCount) == "function" then
        local okS, sc = pcall(d.subfixtureCount, idx)
        if not okS then discoveryFailed(idx, "GetSubfixtureCount raised: " .. tostring(sc)); failed = true
        elseif (tonumber(sc) or 0) > 0 then
          local okSub, sub = pcall(d.subfixture, idx, 0)
          if not okSub then discoveryFailed(idx, "GetSubfixture raised: " .. tostring(sub)); failed = true
          elseif sub == nil then discoveryFailed(idx, "GetSubfixture gave no first subfixture although " .. tostring(sc) .. " were counted"); failed = true
          else
            target = sub
            local okU2, ui2 = pcall(d.uiChannels, sub)
            if not okU2 then discoveryFailed(idx, "GetUIChannels(subfixture) raised: " .. tostring(ui2)); ui = {}; failed = true
            elseif type(ui2) ~= "table" then discoveryFailed(idx, "GetUIChannels(subfixture) returned " .. type(ui2)); ui = {}; failed = true
            else ui = ui2 end
          end
        end
      end
      local channels, truncated = {}, false
      for i = 1, #ui do
        if i > cfg.maxUIChannels then truncated = true; break end
        -- Review round 3: an enumerated channel that cannot be mapped to a readable attribute name (a nil
        -- lookup, a raise, or a handle whose name is unreadable) is incomplete discovery, not a confirmed absence.
        local okA, a = pcall(d.attributeByUIChannel, ui[i])
        local nm = (okA and a ~= nil) and str(field(a, "name")) or nil
        if not okA then
          if not failed then discoveryFailed(idx, "GetAttributeByUIChannel(" .. tostring(ui[i]) .. ") raised: " .. tostring(a)); failed = true end
        elseif a == nil then
          if not failed then discoveryFailed(idx, "GetAttributeByUIChannel(" .. tostring(ui[i]) .. ") gave nothing for an enumerated channel"); failed = true end
        elseif nm == nil or nm == "" then
          if not failed then discoveryFailed(idx, "the attribute of UI channel " .. tostring(ui[i]) .. " has no readable name"); failed = true end
        elseif channels[nm] == nil then channels[nm] = ui[i] end
      end
      scan.fixtures[#scan.fixtures + 1] = { fixture = idx, target = target, channels = channels, channelCount = #ui, discoveryFailed = failed or nil }
      if truncated then scan.partial = true; scan.limitations[#scan.limitations + 1] = string.format("fixture %s: only the first %d of %d UI channels were mapped", tostring(idx), cfg.maxUIChannels, #ui) end
    end
    if type(d.selectionNext) ~= "function" then failure = "deps.selectionNext missing: only the first selected fixture could be walked"; break end
    local okN, nxt = pcall(d.selectionNext, idx)
    if not okN then failure = "SelectionNext() failed after " .. #scan.ids .. " of " .. count .. " fixtures: " .. tostring(nxt); break end
    idx = nxt
    if idx == nil then ended = true end
  end
  if #scan.fixtures < count then scan.partial = true end
  if #scan.fixtures == cfg.maxSelectionScan and count > cfg.maxSelectionScan then scan.limitations[#scan.limitations + 1] = string.format("selection scan bounded to %d of %d fixtures", cfg.maxSelectionScan, count) end
  if failure then incomplete(failure)
  elseif not ended then incomplete("the selection walk did not end")
  elseif #scan.ids ~= count then incomplete(string.format("SelectionNext() ended after %d distinct fixture(s) but the selection count is %d", #scan.ids, count))
  else scan.identityComplete = true end
  return scan
end

-- Availability and programmer value state of one attribute across the scanned selection.
--   availability: no-selection | available (every scanned fixture has the channel) | unavailable (none) | mixed (some)
--   valueState:   none (nothing selected / no fixture has it) | value (every readable fixture agrees) | empty (the
--                 programmer holds nothing for it) | mixed (fixtures disagree) | unavailable (GetProgPhaser gave nothing)
-- The physical range of the channel function belonging to `attrName` on one UI channel (KB-19):
-- GetUIChannel(ui).logical_channel -> ChannelFunctions (PhysicalFrom/PhysicalTo as raw numbers; the
-- function's Attribute in the display role). nil plus a reason when it cannot be read.
local function physicalOf(d, ui, attrName)
  if type(d.logicalChannel) ~= "function" then return nil, "deps.logicalChannel missing" end
  local ok, lc = pcall(d.logicalChannel, ui)
  if not ok then return nil, "GetUIChannel failed: " .. tostring(lc) end
  if lc == nil then return nil, "GetUIChannel gave no logical channel" end
  local n = countOf(lc)
  if n == 0 then return nil, "the logical channel has no channel functions" end
  local fallback
  for k = 1, n do
    local cf = ptr(lc, k)
    if cf ~= nil then
      local okA, attr = pcall(function() return cf:Get("Attribute", d.enums().Roles.Display) end)
      attr = okA and attr ~= nil and tostring(attr) or nil
      local okR, from, to = pcall(function() return tonumber(cf.PhysicalFrom), tonumber(cf.PhysicalTo) end)
      if okR and from ~= nil and to ~= nil then
        local rec = { from = from, to = to, range = math.abs(to - from), ["function"] = str(field(cf, "name")), index = k, functions = n }
        if attr == attrName then return rec end
        if fallback == nil then fallback = rec end
      end
    end
  end
  -- Review (PR #23): a function that does not name the attribute is not this attribute's range; no fallback.
  if fallback then return nil, string.format("no channel function of the logical channel names attribute '%s' (%d function(s), the first is '%s'); its range is not this attribute's", attrName, n, tostring(fallback["function"])) end
  return nil, "no channel function with a readable PhysicalFrom/PhysicalTo"
end

local function slotState(d, scan, attrName)
  local st = { fixtures = #scan.fixtures, with = 0, partial = scan.partial or nil }
  if scan.count == 0 then st.availability, st.valueState, st.valueNote = "no-selection", "none", "nothing is selected"; return st end
  local first, readErr, agree, anyValue, anyEmpty = nil, nil, true, false, false
  local phys, physErr, physMixed = nil, nil, false
  for _, f in ipairs(scan.fixtures) do
    local ui = f.channels[attrName]
    if ui ~= nil then
      st.with = st.with + 1
      -- KB-19: the smallest physical range across the scanned fixtures sizes one encoder click.
      local pr, perr = physicalOf(d, ui, attrName)
      if pr then
        pr.fixtures = 1
        if phys == nil then phys = pr
        else
          phys.fixtures = phys.fixtures + 1
          if pr.from ~= phys.from or pr.to ~= phys.to then physMixed = true end
          if pr.range < phys.range then local nfix = phys.fixtures; phys = pr; phys.fixtures = nfix end
        end
      else physErr = physErr or perr end
      local ok, ph
      if type(d.progPhaser) == "function" then ok, ph = pcall(d.progPhaser, ui) else ok, ph = false, "deps.progPhaser missing" end
      -- KB-17 live: GetProgPhaser(ui, false) returns nil for a channel the programmer holds nothing for and a
      -- table with step 1 for a channel that has a value; nil is therefore "empty", not "unavailable".
      if ok and (ph == nil or type(ph) == "table") then
        local step = type(ph) == "table" and ph[1] or nil
        local abs = type(step) == "table" and tonumber(step.absolute) or nil
        local rec = { fixture = f.fixture, uiChannel = ui, absolute = abs, raw = type(step) == "table" and tonumber(step.absolute_value) or nil,
                      channelFunction = type(step) == "table" and tonumber(step.channel_function) or nil }
        if abs == nil then anyEmpty = true else anyValue = true end
        if first == nil then first = rec
        elseif first.absolute ~= rec.absolute or first.channelFunction ~= rec.channelFunction then agree = false end
      else
        readErr = readErr or (ok and ("GetProgPhaser returned " .. type(ph)) or tostring(ph))
      end
    end
  end
  if st.with == 0 then st.availability = "unavailable"
  elseif st.with == st.fixtures then st.availability = "available"
  else st.availability = "mixed" end
  if st.with == 0 then st.valueState, st.valueNote = "none", "no scanned fixture has this attribute"
  elseif first == nil then st.valueState, st.valueNote = "unavailable", readErr or "GetProgPhaser gave nothing"
  elseif not agree or (anyValue and anyEmpty) then
    st.valueState, st.absolute, st.channelFunction, st.valueFixture = "mixed", first.absolute, first.channelFunction, first.fixture
    st.valueNote = "the scanned fixtures disagree; the first fixture's state is shown"
  elseif not anyValue then st.valueState, st.valueFixture, st.uiChannel = "empty", first.fixture, first.uiChannel; st.valueNote = "the programmer holds no value for this attribute (output values are not read here)"
  else st.valueState, st.absolute, st.raw, st.channelFunction, st.valueFixture, st.uiChannel = "value", first.absolute, first.raw, first.channelFunction, first.fixture, first.uiChannel end
  if readErr and st.valueState ~= "unavailable" then st.valueNote = (st.valueNote and (st.valueNote .. "; ") or "") .. "some fixtures could not be read: " .. readErr end
  if #scan.discoveryFailures > 0 then
    st.discoveryIncomplete = string.format("channel discovery failed for %d fixture(s) (%s): they are not confirmed to lack this attribute", #scan.discoveryFailures, scan.discoveryFailures[1].reason)
  end
  -- KB-20 review: a value state is COMPLETE only when every selected fixture was scanned, every scanned fixture's
  -- channels were discovered and every fixture with the channel was read. Otherwise "value" means "the fixtures that
  -- could be read agree": a consumer must not treat it as the whole selection's value (a position placed on it would
  -- set fixtures whose values were never seen).
  if st.with > 0 then
    if #scan.discoveryFailures > 0 then st.valueIncomplete = "values are not complete while " .. st.discoveryIncomplete
    elseif scan.partial then st.valueIncomplete = string.format("the selection scan is bounded (%d of %d fixtures); the values of the fixtures outside the scan are unknown", #scan.fixtures, scan.count)
    elseif readErr then st.valueIncomplete = "some fixtures with the channel could not be read: " .. readErr end
    st.valueComplete = st.valueIncomplete == nil
  end
  -- Review (PR #23): a range is reported only when it is complete and verified: every scanned fixture with the
  -- channel contributed its own range for this attribute AND the scan covered the whole selection (a fixture
  -- outside the bounded scan could have a smaller range, and the console sizes one click by the smallest).
  if st.with > 0 then
    if #scan.discoveryFailures > 0 then
      st.physicalUnavailable = "the physical range cannot be established while " .. st.discoveryIncomplete
    elseif phys and not physErr and not scan.partial then
      if physMixed then phys.mixed = true; phys.note = "the scanned fixtures have different physical ranges; the smallest is reported (the console sizes one click by it)" end
      st.physical = phys
    elseif physErr then
      st.physicalUnavailable = string.format("the physical range could not be read for every fixture with the channel (%s); no click size is derived from a partial set", physErr)
    elseif scan.partial then
      st.physicalUnavailable = string.format("the selection scan is bounded (%d of %d fixtures); the smallest physical range over the whole selection is unknown", #scan.fixtures, scan.count)
    else
      st.physicalUnavailable = "no physical range readable"
    end
  end
  return st
end

-- Executors the bridge's owned Quickey bank (KB-12) reserved on a page: never playback targets. The
-- dependency is optional; without it only the object class (Quickey) excludes an executor.
local function reservedBy(d, pageNo, index)
  if type(d.reservedExecutors) ~= "function" then return false end
  local ok, r = pcall(d.reservedExecutors)
  if not ok or type(r) ~= "table" then return false end
  if r.first ~= nil then
    return tonumber(r.page) == tonumber(pageNo) and index >= tonumber(r.first) and index < tonumber(r.first) + (tonumber(r.count) or 0)
  end
  for _, x in ipairs(r) do
    if type(x) == "table" and tonumber(x.page) == tonumber(pageNo) and tonumber(x.index) == index then return true end
  end
  return false
end

local function displayParam(p, cfg)
  local n = p and p.display
  if n == nil then n = cfg.encoderDisplay end
  positiveInt(n, "params.display")
  return n
end
local function encoderIdent(p, cfg) return { display = (p and p.display) or cfg.encoderDisplay } end

-- Readers: fn(deps, params) -> value, reason. A reader returns nil plus a reason when the console gave
-- nothing usable; it raises when a dependency fails. `params` lists accepted parameters, `paramless`
-- readers are part of readAll() unless they are `context` readers (KB-17: several console reads each,
-- requested explicitly or through contextSnapshot()). Scope says what the value belongs to (KB-01).
local READERS = {
  commandText = { scope = "ui", source = "CmdObj().cmdtext", note = "raw command-line text of the plugin user; keywords are not inferred from it",
    fn = function(d) local v = d.cmdObj().cmdtext; if v == nil then return nil, "the console returned nothing for cmdtext" end; return tostring(v) end },
  lastCommand = { scope = "ui", source = "CmdObj().lastcommand", note = "observation of shared command history, not confirmation of a particular request or client",
    fn = function(d) local v = d.cmdObj().lastcommand; if v == nil then return nil, "the console returned nothing for lastcommand" end; return tostring(v) end },
  blind     = { scope = "show", source = "ShowData.Masters.Grand.Blind.FADERENABLED",     fn = function(d) return toBool(d.showData().Masters.Grand.Blind:Get("FaderEnabled")) end },
  highlight = { scope = "show", source = "ShowData.Masters.Grand.Highlight.FADERENABLED", fn = function(d) return toBool(d.showData().Masters.Grand.Highlight:Get("FaderEnabled")) end },
  solo      = { scope = "show", source = "ShowData.Masters.Grand.Solo.FADERENABLED",      fn = function(d) return toBool(d.showData().Masters.Grand.Solo:Get("FaderEnabled")) end },
  previewMode = { scope = "profile", source = "CurrentProfile().Environments.ACTIVEENVIRONMENT",
    fn = function(d) local v = d.currentProfile().Environments:Get("ActiveEnvironment"); if v == nil then return nil, "the console returned nothing for ActiveEnvironment" end; return tostring(v) end },
  previewBar = { scope = "display", source = "GetDisplayByIndex(display).PREVIEWBARACTIVE", params = { "display" }, paramless = true,
    note = "display-local pending Preview; it does not say which display injected input will route to",
    fn = function(d, p, cfg)
      local n = p and p.display
      if n == nil then n = cfg.defaultDisplay end
      positiveInt(n, "params.display")
      local disp = d.display(n)
      if disp == nil then return nil, "display " .. n .. " does not exist on this console" end
      return toBool(disp:Get("PreviewBarActive"))
    end,
    identify = function(p, cfg) return { display = (p and p.display) or cfg.defaultDisplay } end },
  shortcutsActive = { scope = "profile", source = "CurrentProfile().KeyboardShortCuts.KEYBOARDSHORTCUTSACTIVE",
    fn = function(d) return toBool(d.currentProfile().KeyboardShortCuts:Get("KeyboardShortcutsActive")) end },
  maState = { scope = "console", source = "Root().MASTATE", note = "aggregate MA state of every Shift source (observed state, not ownership)",
    fn = function(d) return toBool(d.root():Get("MAState")) end },
  page = { scope = "user", source = "CurrentExecPage()", fn = function(d)
    local p = d.currentExecPage()
    if p == nil then return nil, "CurrentExecPage() returned nothing" end
    return { name = tostring(p.name), no = tonumber(p:Get("No")) or tonumber(p.index) }
  end },
  selectedSequence = { scope = "user", source = "SelectedSequence()", note = "the user's selected sequence; nil from the console is reported as selected=false",
    fn = function(d)
      local s = d.selectedSequence()
      if s == nil then return { selected = false } end
      local info = handleInfo(s)
      info.selected = true
      return info
    end },
  sequenceActive = { scope = "show", source = "Sequence:HasActivePlayback()", params = { "sequence" },
    note = "sequence playback activity; not proof that a particular executor caused it or that a button is held",
    fn = function(d, p)
      local n = p and p.sequence
      if type(n) ~= "number" then error("params.sequence (number) is required", 0) end
      local seq = d.sequence(n)
      if seq == nil then return nil, "sequence " .. n .. " not found" end
      return toBool(seq:HasActivePlayback())
    end,
    identify = function(p) return { sequence = p and p.sequence } end },
  executor = { scope = "page", source = "GetExecutor(executor).Object on the user's current page", params = { "executor" },
    note = "assignment only; level is the fader reader, activity is sequenceActive, button ownership is the input module's record",
    fn = function(d, p)
      local n = p and p.executor
      if type(n) ~= "number" then error("params.executor (number) is required", 0) end
      local exec, page = d.executor(n)
      if exec == nil then return { executor = n, empty = true, page = handleInfo(page) } end
      local okO, obj = pcall(function() return exec.Object end)
      if not okO then error("reading the executor's Object failed: " .. tostring(obj), 0) end
      local assigned = obj ~= nil and handleInfo(obj) or nil
      return { executor = n, empty = assigned == nil, assigned = assigned, page = handleInfo(page) }
    end,
    identify = function(p) return { executor = p and p.executor } end },
  fader = { scope = "show", source = "<assigned object>:GetFader({token})", params = { "executor", "sequence", "token" },
    note = "master level of the object assigned to the executor (user page) or of the sequence; not a button state",
    fn = function(d, p)
      local token = (p and p.token) or "FaderMaster"
      if type(token) ~= "string" or token == "" then error("params.token must be a non-empty string", 0) end
      local target
      if p and p.executor ~= nil then
        if type(p.executor) ~= "number" then error("params.executor must be a number", 0) end
        local exec = d.executor(p.executor)
        if exec == nil then return nil, "executor " .. p.executor .. " is empty on the current page" end
        local okO, obj = pcall(function() return exec.Object end)
        if not okO then error("reading the executor's Object failed: " .. tostring(obj), 0) end
        if obj == nil then return nil, "executor " .. p.executor .. " has no assigned object" end
        target = obj
      elseif p and p.sequence ~= nil then
        if type(p.sequence) ~= "number" then error("params.sequence must be a number", 0) end
        target = d.sequence(p.sequence)
        if target == nil then return nil, "sequence " .. p.sequence .. " not found" end
      else
        error("params.executor or params.sequence (number) is required", 0)
      end
      local v, reason = faderOf(target, token)
      if v == nil then return nil, reason end
      v.target = handleInfo(target)
      return v
    end,
    identify = function(p) return { executor = p and p.executor, sequence = p and p.sequence, token = (p and p.token) or "FaderMaster" } end },
  freeze = { scope = "show", source = nil, unavailable = "no readable Freeze state was found in KB-01; this is not a false value" },

  -- KB-17 control context ------------------------------------------------------------------------
  dataPool = { scope = "user", source = "DataPool()", context = true, note = "the user's selected data pool (pages, sequences and macros are addressed inside it)",
    fn = function(d)
      if type(d.dataPool) ~= "function" then return nil, "deps.dataPool missing" end
      local p = d.dataPool()
      if p == nil then return nil, "DataPool() returned nothing" end
      local info = handleInfo(p)
      if info.no == nil then info.no = tonumber(field(p, "index")) end
      return info
    end },
  encoderBank = { scope = "display", context = true, params = { "display" }, paramless = true,
    source = "GetDisplayByIndex(display).EncoderBarContainer … EncoderBankSelector.SelectedItemValueI64, PresetBar.Options.PageSelector.SelectedItemValueI64, PresetBar.Context; names from CurrentProfile().EncoderBarPool",
    note = "the configured or requested display is the authoritative encoder bar: a display without one is unavailable and no other display is substituted; indexes are 1-based (the selectors are 0-based)",
    fn = function(d, p, cfg)
      local n = displayParam(p, cfg)
      local ui, why = encoderUi(d, n)
      if not ui then return nil, why end
      local bank0, page0, context = readBankPage(ui)
      if bank0 == nil then return nil, "EncoderBankSelector.SelectedItemValueI64 is not readable on display " .. n end
      if page0 == nil then return nil, "PageSelector.SelectedItemValueI64 is not readable on display " .. n end
      local out = { display = n, bar = cfg.encoderBar, bank = { index = bank0 + 1 }, page = { index = page0 + 1 }, context = context }
      if context == nil then out.attributeEditing = nil; out.unsupported = "the preset-bar context is not readable; whether this is attribute editing is unknown"
      elseif context == "Default" then out.attributeEditing = true
      else out.attributeEditing = false; out.unsupported = "preset-bar context '" .. context .. "' is not attribute editing; slots are not qualified in this context (KB-16)" end
      local pp, preason = poolPage(d, cfg.encoderBar, bank0 + 1, page0 + 1)
      if pp then
        out.bank.name, out.bank.pages, out.page.name, out.page.slots, out.banks = pp.bankName, pp.pageCount, pp.pageName, pp.slotCount, pp.bankCount
      else
        out.poolUnavailable = preason
      end
      return out
    end,
    identify = encoderIdent },
  encoderSlots = { scope = "display", context = true, params = { "display" }, paramless = true,
    source = "CurrentProfile().EncoderBarPool[bar][bank][page].Encoder n (InnerObject/OuterObject in the display role), AttributeDefinitions, UserAttributePreferences, the display's EncoderPlace bands, GetUIChannels/GetAttributeByUIChannel/GetProgPhaser per selected (sub)fixture",
    note = "ordered slot assignments of the active page with attribute identity, label, unit, readout, resolution, layer, selection availability, programmer value state and the physical range of the attribute's channel function on the selection (KB-19); the outer ring and non-attribute slots are reported but unsupported (KB-16)",
    fn = function(d, p, cfg)
      local n = displayParam(p, cfg)
      local ui, why = encoderUi(d, n)
      if not ui then return nil, why end
      local bank0, page0, context = readBankPage(ui)
      if bank0 == nil or page0 == nil then return nil, "bank/page selectors are not readable on display " .. n end
      local pp, preason = poolPage(d, cfg.encoderBar, bank0 + 1, page0 + 1)
      if not pp then return nil, preason end
      local places = readPlaces(ui, cfg.maxSlots)
      local scan = scanSelection(d, cfg)
      local layer = dget(d, d.currentProfile(), "Layer")
      local count = math.min(pp.slotCount, cfg.maxSlots)
      local slots = {}
      for s = 1, count do
        local enc = ptr(pp.page, s)
        local slot = { slot = s, layer = layer }
        local inner = parseRef(dget(d, enc, "InnerObject"))
        local outer = parseRef(dget(d, enc, "OuterObject"))
        slot.objectType = dget(d, enc, "InnerObjectType")
        if inner == nil then slot.kind = "empty"
        elseif inner.class == "Attribute" then slot.kind = "attribute"
        else slot.kind = "other" end
        if inner then slot.ref, slot.name, slot.index = inner.ref, inner.name, inner.index end
        if outer and (inner == nil or outer.ref ~= inner.ref) then slot.outerRef, slot.outerName = outer.ref, outer.name; slot.outerUnsupported = "the outer ring is not qualified (KB-16)" end
        local place = places[s]
        if place then slot.label, slot.placeResolution, slot.channelFunction, slot.channelFunctionIndex = place.label, place.resolution, place.channelFunction, place.channelFunctionIndex end
        if slot.kind == "attribute" then
          local meta, mreason = attributeMeta(d, inner.name)
          if meta then
            slot.attributeIndex = slot.index or meta.index
            slot.feature, slot.unit, slot.color, slot.channelFunctions, slot.special = meta.feature, meta.unit, meta.color, meta.channelFunctions, meta.special
          else
            slot.attributeIndex = slot.index
            slot.attributeUnavailable = mreason
          end
          local pref = userPreference(d, inner.name)
          if pref and pref.resolution and pref.resolutionInherited == false then slot.resolution, slot.resolutionSource = pref.resolution, "user-preference"
          elseif meta and meta.resolution then slot.resolution, slot.resolutionSource = meta.resolution, "attribute-definition"
          elseif place and place.resolution then slot.resolution, slot.resolutionSource = place.resolution, "encoder-band"
          else slot.resolutionUnavailable = "no resolution readable for this slot" end
          if pref and pref.readout and pref.readoutInherited == false then slot.readout, slot.readoutSource = pref.readout, "user-preference"
          elseif meta and meta.readout then slot.readout, slot.readoutSource = meta.readout, "attribute-definition"
          else slot.readoutUnavailable = "no readout readable for this slot" end
          if pref and pref.pressFactor then slot.pressFactor = pref.pressFactor end
          local st = slotState(d, scan, inner.name)
          slot.availability, slot.fixtures, slot.with, slot.partial, slot.discoveryIncomplete = st.availability, st.fixtures, st.with, st.partial, st.discoveryIncomplete
          slot.valueState, slot.absolute, slot.raw, slot.valueChannelFunction, slot.valueFixture, slot.uiChannel, slot.valueNote = st.valueState, st.absolute, st.raw, st.channelFunction, st.valueFixture, st.uiChannel, st.valueNote
          slot.valueComplete, slot.valueIncomplete = st.valueComplete, st.valueIncomplete
          if st.physical then
            local ph = st.physical
            slot.physicalFrom, slot.physicalTo, slot.physicalRange, slot.physicalFunction, slot.physicalFunctionIndex = ph.from, ph.to, ph.range, ph["function"], ph.index
            slot.physicalFunctions, slot.physicalFixtures, slot.physicalMixed, slot.physicalNote = ph.functions, ph.fixtures, ph.mixed, ph.note
          else slot.physicalUnavailable = st.physicalUnavailable end
        elseif slot.kind == "other" then
          slot.availability, slot.valueState = "unsupported", "unsupported"
          slot.unsupported = "slot object '" .. tostring(inner.ref) .. "' is not an attribute (InnerObjectType " .. tostring(slot.objectType) .. "); phaser/editor slots are not qualified (KB-16)"
        else
          slot.availability, slot.valueState = "empty", "none"
        end
        slots[s] = slot
      end
      return { display = n, bar = cfg.encoderBar, bank = { index = bank0 + 1, name = pp.bankName }, page = { index = page0 + 1, name = pp.pageName }, context = context, attributeEditing = (context == "Default") and true or (context ~= nil and false or nil),
               layer = layer, selection = { count = scan.count, scanned = #scan.fixtures, fixtures = scan.ids, identityComplete = scan.identityComplete, partial = scan.partial, discoveryFailures = #scan.discoveryFailures, limitations = scan.limitations },
               slots = slots, slotCount = pp.slotCount, truncated = pp.slotCount > count }
    end,
    identify = encoderIdent },
  executorTarget = { scope = "page", context = true, params = { "executor", "page" },
    source = "GetExecutor(executor) on the user's current page, or ObjectList(\"Page <page>.<executor>\") for an explicit page: Object, KeyPress/KeyUnpress/KeyUnpressCombined, Fader, Encoder, EncoderLeft/EncoderRight, ExecutorConfiguration, Width (display role); the object's Appearance.BackRGBA, HasActivePlayback(), GetFader({token of the configured fader function}); the Width of the preceding executors of the row (maxExecutorWidth)",
    note = "one executor as a control target with its explicit identity (pool, page, executor, mode current|page): assigned-object identity, configured functions, the configured fader function's level, activity and appearance; a Quickey object (the owned KB-12 bank), an executor the bridge's bank reserved or a number covered by a wider neighbour (an expanded assignment) is never a playback target; a page that does not exist is pageMissing",
    fn = function(d, p, cfg)
      local n = p and p.executor
      if type(n) ~= "number" then error("params.executor (number) is required", 0) end
      local pageNo = p.page
      if pageNo ~= nil and (type(pageNo) ~= "number" or pageNo ~= math.floor(pageNo) or pageNo < 1) then error("params.page must be a positive integer (omit it to follow the user's current page)", 0) end
      local out = { executor = n, mode = pageNo ~= nil and "page" or "current" }
      local okP, pool = pcall(function() return type(d.dataPool) == "function" and d.dataPool() or nil end)
      if okP and pool ~= nil then out.pool = handleInfo(pool); if out.pool and out.pool.no == nil then out.pool.no = tonumber(field(pool, "index")) end
      else out.poolUnavailable = okP and "DataPool() returned nothing" or ("DataPool() raised: " .. tostring(pool)) end
      -- The read path: the user's page through GetExecutor, an explicit page through ObjectList (KB-12/13).
      local page
      local function readExec(m)
        if pageNo == nil then
          local e, pg = d.executor(m)
          if page == nil then page = pg end
          return e
        end
        if type(d.pagedExecutor) ~= "function" then error("explicit pages need the pagedExecutor dependency (ObjectList(\"Page P.E\"))", 0) end
        return d.pagedExecutor(pageNo, m)
      end
      if pageNo ~= nil then
        if type(d.pageByNo) ~= "function" then error("explicit pages need the pageByNo dependency (ObjectList(\"Page P\"))", 0) end
        page = d.pageByNo(pageNo)
        if page == nil then
          out.page = { no = pageNo }
          out.pageMissing, out.empty, out.playbackTarget = true, true, false
          out.reason = string.format("page %d does not exist (nothing is created)", pageNo)
          return out
        end
      end
      local exec = readExec(n)
      -- KB-21 live: GetExecutor(n) returns no page handle for an EMPTY executor; the identity still names the user's page.
      if pageNo == nil and page == nil and type(d.currentExecPage) == "function" then page = d.currentExecPage() end
      local pageInfo = handleInfo(page)
      if pageInfo ~= nil and pageInfo.no == nil then pageInfo.no = tonumber(field(page, "index")) end
      if pageNo ~= nil and pageInfo ~= nil and pageInfo.no == nil then pageInfo.no = pageNo end
      out.page = pageInfo
      local reserved = reservedBy(d, pageInfo and pageInfo.no, n)
      -- Layout (KB-21): a wider neighbour of the same row covers this number. Bounded: the preceding
      -- maxExecutorWidth - 1 numbers of the row are read; a wider span than that is not resolved.
      local row = math.floor(n / 100)
      local maxW = (cfg and cfg.maxExecutorWidth) or DEFAULTS.maxExecutorWidth
      for m = n - 1, math.max(n - maxW + 1, 1), -1 do
        if math.floor(m / 100) ~= row then break end
        local okE, e = pcall(readExec, m)
        if okE and e ~= nil then
          local w = tonumber(dget(d, e, "Width")) or 1
          if m + w > n then out.coveredBy, out.coveredWidth = m, w; break end
        end
      end
      if exec == nil then
        out.empty, out.playbackTarget = true, false
        if out.coveredBy then out.reason = string.format("covered by executor %d (width %d): not a separate playback", out.coveredBy, out.coveredWidth)
        elseif reserved then out.reason = "reserved by the bridge's owned Quickey bank (empty right now)"
        else out.reason = "the executor is empty" end
        if reserved then out.reserved = true end
        return out
      end
      local okO, obj = pcall(function() return exec.Object end)
      if not okO then error("reading the executor's Object failed: " .. tostring(obj), 0) end
      out.empty = obj == nil
      out.functions = { keyPress = dget(d, exec, "KeyPress"), keyUnpress = dget(d, exec, "KeyUnpress"), keyUnpressCombined = dget(d, exec, "KeyUnpressCombined"),
                        fader = dget(d, exec, "Fader"), encoder = dget(d, exec, "Encoder"), encoderLeft = dget(d, exec, "EncoderLeft"), encoderRight = dget(d, exec, "EncoderRight") }
      out.configuration = dget(d, exec, "ExecutorConfiguration")
      out.isXKey = dget(d, exec, "IsXKey")
      out.width = tonumber(dget(d, exec, "Width"))
      if out.width ~= nil and out.width > 1 then out.expanded = true end
      if obj == nil then
        out.playbackTarget = false
        if out.coveredBy then out.reason = string.format("covered by executor %d (width %d): not a separate playback", out.coveredBy, out.coveredWidth)
        elseif reserved then out.reason = "reserved by the bridge's owned Quickey bank (no object right now)"
        else out.reason = "no assigned object" end
        if reserved then out.reserved = true end
        return out
      end
      out.assigned = handleInfo(obj)
      local app = field(obj, "Appearance")
      if app ~= nil and (type(app) == "userdata" or type(app) == "table") then
        out.appearance = { name = str(field(app, "name")), backRGBA = dget(d, app, "BackRGBA"), color = dget(d, app, "Color") }
      else
        out.appearanceUnavailable = "the object has no Appearance"
      end
      local okA, act = pcall(function() return obj:HasActivePlayback() end)
      if okA then
        local b, why = toBool(act)
        if b ~= nil then out.active = b else out.activeUnavailable = why end
      else
        out.activeUnavailable = "HasActivePlayback raised: " .. tostring(act)
      end
      local fn = out.functions.fader
      if fn ~= nil and fn ~= "" then
        local token = "Fader" .. fn:gsub("%s+", "")
        local okV, v = pcall(function() return obj:GetFader({ token = token }) end)
        if okV and type(v) == "number" then
          local okT, tx = pcall(function() return obj:GetFaderText({ token = token }) end)
          out.level = { token = token, value = v, text = (okT and tx ~= nil) and tostring(tx) or nil }
        else
          out.level = { token = token, unavailable = okV and ("GetFader returned " .. type(v) .. ", not a level") or ("GetFader raised: " .. tostring(v)) }
        end
      else
        out.level = { unavailable = "no fader function is configured on this executor" }
      end
      if out.assigned.class == "Quickey" then
        out.playbackTarget, out.reason = false, "a Quickey object is never a playback target (owned Quickey bank, KB-12)"
      elseif reserved then
        out.playbackTarget, out.reserved, out.reason = false, true, "reserved by the bridge's owned Quickey bank"
      elseif out.coveredBy then
        out.playbackTarget, out.reason = false, string.format("covered by executor %d (width %d): its controls belong to that expanded assignment, not to a separate playback", out.coveredBy, out.coveredWidth)
      else
        out.playbackTarget = true
      end
      return out
    end,
    identify = function(p) return { executor = p and p.executor, page = p and p.page } end },
  pageExecutors = { scope = "page", context = true, params = { "page" }, paramless = true, source = "CurrentExecPage() children with an Object, or ObjectList(\"Page <page>\") for an explicit page", note = "index, object name, class and width of every assigned executor on the user's current page or an explicit page (bounded by config.maxExecutors); use executorTarget per executor for functions and levels",
    fn = function(d, p, cfg)
      local pageNo = p and p.page
      if pageNo ~= nil and (type(pageNo) ~= "number" or pageNo ~= math.floor(pageNo) or pageNo < 1) then error("params.page must be a positive integer", 0) end
      local page
      if pageNo ~= nil then
        if type(d.pageByNo) ~= "function" then error("explicit pages need the pageByNo dependency", 0) end
        page = d.pageByNo(pageNo)
        if page == nil then return { page = { no = pageNo }, pageMissing = true, executors = {}, truncated = false } end
      else
        page = d.currentExecPage()
        if page == nil then return nil, "CurrentExecPage() returned nothing" end
      end
      local out = { page = handleInfo(page), executors = {}, truncated = false }
      if out.page and out.page.no == nil then out.page.no = pageNo or tonumber(field(page, "index")) end
      local total = countOf(page)
      for i = 1, total do
        local e = ptr(page, i)
        if e ~= nil then
          local okO, obj = pcall(function() return e.Object end)
          if okO and obj ~= nil then
            if #out.executors >= cfg.maxExecutors then out.truncated = true; break end
            local idx = tonumber(field(e, "index")) or tonumber(dget(d, e, "No"))
            out.executors[#out.executors + 1] = { index = idx, name = str(field(obj, "name")), class = classOf(obj), width = tonumber(dget(d, e, "Width")) }
          end
        end
      end
      return out
    end,
    identify = function(p) return { page = p and p.page } end },
}

-- Compatibility alias (0.1.0 named sequence activity after the executor). The result keeps the
-- requested name and says what was actually read.
local ALIASES = {
  executorActive = { of = "sequenceActive", note = "deprecated alias of sequenceActive: this is sequence playback activity, not executor button state" },
}

local READER_NAMES = {}
for k in pairs(READERS) do READER_NAMES[#READER_NAMES + 1] = k end
table.sort(READER_NAMES)

-- Every caller gets its own copy: the internal list is never exposed.
local function readerNames()
  local out = {}
  for i, n in ipairs(READER_NAMES) do out[i] = n end
  return out
end

local function describeReaders()
  local out = {}
  for _, n in ipairs(READER_NAMES) do
    local r = READERS[n]
    local params = nil
    if r.params then params = {}; for i, p in ipairs(r.params) do params[i] = p end end
    out[#out + 1] = { name = n, scope = r.scope, source = r.source, params = params, paramless = r.params == nil or r.paramless == true, context = r.context, note = r.note, unavailable = r.unavailable }
  end
  for a, al in pairs(ALIASES) do out[#out + 1] = { name = a, alias = al.of, scope = READERS[al.of].scope, source = READERS[al.of].source, note = al.note } end
  return out
end

local function consoleDeps(env)
  env = env or _G
  return {
    cmdObj = function() return env.CmdObj() end,
    showData = function() return env.ShowData() end,
    currentProfile = function() return env.CurrentProfile() end,
    root = function() return env.Root() end,
    currentExecPage = function() return env.CurrentExecPage() end,
    display = function(n) return env.GetDisplayByIndex(n) end,
    sequence = function(n) local list = env.ObjectList("Sequence " .. tostring(n)); return list and list[1] end,
    executor = function(n) return env.GetExecutor(n) end,
    -- KB-21: a page by number and an executor of that page, whatever page the user is on. Both are nil
    -- when the page does not exist; the executor handle is also nil for an EMPTY executor (KB-12: the
    -- paged object exists only once assigned), so pageByNo decides between "missing" and "empty".
    pageByNo = function(p) local list = env.ObjectList(string.format("Page %d", p)); return list and list[1] end,
    pagedExecutor = function(p, n) local list = env.ObjectList(string.format("Page %d.%d", p, n)); return list and list[1] end,
    selectedSequence = function() return env.SelectedSequence() end,
    -- KB-17 control context (the KB-16 read paths). enums gives the display role for Get(prop, role).
    enums = function() return env.Enums end,
    dataPool = function() return env.DataPool() end,
    selectionCount = function() return env.SelectionCount() end,
    selectionFirst = function() return env.SelectionFirst() end,
    selectionNext = function(i) return env.SelectionNext(i) end,
    uiChannels = function(i) return env.GetUIChannels(i) end,
    attributeByUIChannel = function(ui) return env.GetAttributeByUIChannel(ui) end,
    progPhaser = function(ui) return env.GetProgPhaser(ui, false) end,
    -- KB-19: the fixture type's logical channel behind a UI channel (its children are the channel functions)
    logicalChannel = function(ui) local u = env.GetUIChannel(ui); return u and u.logical_channel end,
    subfixtureCount = function(i) return env.GetSubfixtureCount(i) end,
    subfixture = function(i, n) return env.GetSubfixture(i, n) end,
    attributeDefinitions = function() return env.Root().ShowData.LivePatch.AttributeDefinitions.Attributes end,
    attributeIndex = function(n) return env.GetAttributeIndex(n) end,
    -- reservedExecutors is supplied by the consumer that owns a Quickey bank (the bridge): a function
    -- returning { page, first, count } or a list of { page, index }. Optional.
    -- Identity of what the readers observe; a change invalidates cached observations.
    showFile = function() return env.Root().MANetSocket:Get("ShowFile") end,
    userName = function() local u = env.CurrentUser(); return u and tostring(u.name) or nil end,
    profileName = function() return tostring(env.CurrentProfile().name) end,
  }
end

local function keyOf(name, ident)
  if not ident then return name end
  local parts = {}
  for _, k in ipairs({ "display", "executor", "page", "sequence", "token" }) do
    if ident[k] ~= nil and not (k == "token" and ident[k] == "FaderMaster") then parts[#parts + 1] = k .. "=" .. tostring(ident[k]) end
  end
  if #parts == 0 then return name end
  return name .. "[" .. table.concat(parts, ",") .. "]"
end

-- Expand a request spec into read items (shared by the bridge op and surface consumers so nobody
-- re-implements the expansion). Bounded by config.maxExecutors; the rest is reported, not read.
--   spec = { all?, items?, readers?, display?, displays?, executors?, sequences?, tokens? }
--   all = true adds every parameterless reader (previewBar once per requested display).
local function itemsFor(spec, config)
  spec = spec or {}
  config = config or DEFAULTS
  local items, limitations = {}, {}
  local function add(name, params) items[#items + 1] = { name = name, params = params } end
  if spec.all == true then
    local readers = {}
    for _, n in ipairs(READER_NAMES) do
      local r = READERS[n]
      if (not r.params or r.paramless) and not r.context then readers[#readers + 1] = n end
    end
    if type(spec.readers) == "table" then for _, n in ipairs(spec.readers) do readers[#readers + 1] = n end end
    spec = { items = spec.items, readers = readers, display = spec.display, displays = spec.displays, executors = spec.executors, sequences = spec.sequences, tokens = spec.tokens }
  end
  if type(spec.items) == "table" then
    for _, it in ipairs(spec.items) do
      if type(it) == "string" then add(it, nil)
      elseif type(it) == "table" and type(it.name) == "string" then add(it.name, it.params)
      else limitations[#limitations + 1] = "ignored an item that is neither a reader name nor {name, params}" end
    end
  end
  local displays = spec.displays
  if displays == nil and spec.display ~= nil then displays = { spec.display } end
  if type(spec.readers) == "table" then
    for _, name in ipairs(spec.readers) do
      if name == "previewBar" and type(displays) == "table" and #displays > 0 then
        for _, dn in ipairs(displays) do add("previewBar", { display = dn }) end
      elseif READERS[name] and READERS[name].params and not READERS[name].paramless then
        limitations[#limitations + 1] = name .. " needs parameters; use executors/sequences or items"
      else
        add(name, nil)
      end
    end
  end
  if type(spec.executors) == "table" then
    local max = config.maxExecutors or DEFAULTS.maxExecutors
    local tokens = type(spec.tokens) == "table" and spec.tokens or { "FaderMaster" }
    for i, n in ipairs(spec.executors) do
      if i > max then limitations[#limitations + 1] = string.format("executors truncated to %d of %d", max, #spec.executors); break end
      add("executor", { executor = n })
      for _, tok in ipairs(tokens) do add("fader", { executor = n, token = tok }) end
    end
  end
  if type(spec.sequences) == "table" then
    local max = config.maxExecutors or DEFAULTS.maxExecutors
    for i, n in ipairs(spec.sequences) do
      if i > max then limitations[#limitations + 1] = string.format("sequences truncated to %d of %d", max, #spec.sequences); break end
      add("sequenceActive", { sequence = n })
    end
  end
  return items, limitations
end

-- Identifying parameters of an item, computed under protection: a malformed params value (not a table,
-- a wrong type inside) yields nil plus the error, and the caller reports that one item unavailable
-- instead of aborting the batch. The key stays stable so watch() and read() agree on it.
local function identifyItem(r, name, params, config)
  if params ~= nil and type(params) ~= "table" then
    return nil, tostring(name) .. "[invalid-params]", "params must be a table, got " .. type(params)
  end
  if not (r and r.identify) then return nil, tostring(name), nil end
  local ok, ident = pcall(r.identify, params, config)
  if not ok then return nil, tostring(name) .. "[invalid-params]", tostring(ident) end
  return ident, keyOf(tostring(name), ident), nil
end

local Instance = {}
Instance.__index = Instance

local function checkLive(self, what)
  if self._state == "disposed" then error(NAME .. ": " .. what .. " on a disposed instance", 3) end
end

local function requireReady(self, what)
  checkLive(self, what)
  if self._state ~= "ready" then error(NAME .. ": " .. what .. "() before init()", 3) end
end

function Instance:init()
  checkLive(self, "init")
  if self._state == "created" then self._state = "ready" end
  return self
end

function Instance:status()
  local cached = 0
  for _ in pairs(self._cache) do cached = cached + 1 end
  return { module = NAME, version = VERSION, apiVersion = API_VERSION, owner = self._owner, state = self._state,
           reads = self._reads, serviced = self._serviced, readers = readerNames(), epoch = self._epoch,
           lastInvalidation = self._lastInvalidation, identity = self._identity, identityUncertain = self._identityUncertain,
           watched = #self._watch, cached = cached,
           config = { maxItems = self._config.maxItems, maxExecutors = self._config.maxExecutors, maxReadsPerService = self._config.maxReadsPerService,
                      pollIntervalMs = self._config.pollIntervalMs, staleMs = self._config.staleMs, identityCheckMs = self._config.identityCheckMs } }
end

function Instance:dispose()
  self._state = "disposed"
  self._cache, self._watch = {}, {}
  return {}
end

function Instance:readers() return readerNames() end
function Instance:describe() return describeReaders() end
function Instance:epoch() return self._epoch end

-- Drops every cached observation and starts a new epoch. The consumer calls it on disconnect,
-- restart or any event after which old values must not be presented as current.
function Instance:invalidate(reason, now)
  checkLive(self, "invalidate")
  self._epoch = self._epoch + 1
  self._cache = {}
  self._lastInvalidation = { reason = tostring(reason or "consumer"), at = now, epoch = self._epoch }
  return self._epoch
end

-- Show file, user and profile identity. Read at most every identityCheckMs; a difference from the
-- last KNOWN identity invalidates the cache. A value that was never readable is reported as nil and is
-- not a change. A value that was readable and becomes unreadable keeps its last known value, marks the
-- identity uncertain and invalidates once ("identity-unreadable"): while uncertain, snapshot() reports
-- every observation stale and readMany() says so, so an A -> unreadable -> B transition can neither
-- hide the change (B is compared with A once readable again) nor present A's values as current.
local IDENTITY_KEYS = { "showFile", "user", "profile" }
local IDENTITY_REASON = { showFile = "show-changed", user = "user-changed", profile = "profile-changed" }
function Instance:_checkIdentity(now, force)
  if not force and self._identityAt ~= nil and now ~= nil and (now - self._identityAt) * 1000 < self._config.identityCheckMs then return nil end
  self._identityAt = now
  local d = self._deps
  local id = {}
  local function try(k, f) if type(f) == "function" then local ok, v = pcall(f); if ok and v ~= nil then id[k] = tostring(v) end end end
  try("showFile", d.showFile); try("user", d.userName); try("profile", d.profileName)
  local prev = self._identity or {}
  local known, uncertain, reason = {}, {}, nil
  for _, k in ipairs(IDENTITY_KEYS) do
    if id[k] ~= nil then
      known[k] = id[k]
      if prev[k] ~= nil and prev[k] ~= id[k] then reason = reason or IDENTITY_REASON[k] end
    elseif prev[k] ~= nil then
      known[k] = prev[k]           -- last known value, not forgotten
      uncertain[#uncertain + 1] = k
    end
  end
  local wasUncertain = self._identityUncertain ~= nil
  self._identity = known
  self._identityUncertain = #uncertain > 0 and uncertain or nil
  if reason then
    self:invalidate(reason, now)
    return reason
  end
  if #uncertain > 0 and not wasUncertain then
    self:invalidate("identity-unreadable", now)
    return "identity-unreadable"
  end
  return nil
end

-- Returns one observation (see the contract at the top). Never raises for a reader problem.
function Instance:read(name, params, now)
  requireReady(self, "read")
  local requested = tostring(name)
  local alias = ALIASES[name]
  local r = READERS[alias and alias.of or name]
  if not r then return { name = requested, key = requested, available = false, reason = "unknown reader; see readers()", observedAt = now, epoch = self._epoch } end
  self._reads = self._reads + 1
  local ident, key, identErr = identifyItem(r, requested, params, self._config)
  local out = { name = requested, key = key, scope = r.scope, source = r.source, params = ident, observedAt = now, epoch = self._epoch, note = alias and alias.note or r.note }
  if alias then out.alias = alias.of end
  if identErr then out.available = false; out.error = identErr; return out end
  if r.unavailable then out.available = false; out.reason = r.unavailable; return out end
  local ok, v, reason = pcall(r.fn, self._deps, params, self._config)
  if not ok then out.available = false; out.error = tostring(v); return out end
  if v == nil then out.available = false; out.reason = reason or "the console returned nothing for this property"; return out end
  out.available = true; out.value = v
  return out
end

-- Reads up to config.maxItems items one after another (not atomic). items = { {name, params}, ... }.
function Instance:readMany(items, now)
  requireReady(self, "readMany")
  if type(items) ~= "table" then error(NAME .. ": readMany(items) needs a list", 2) end
  local invalidated = self:_checkIdentity(now)
  local out = { observedAt = now, epoch = self._epoch, atomic = false, identity = self._identity, identityUncertain = self._identityUncertain,
                invalidated = invalidated, items = {}, count = 0, truncated = 0 }
  for i, it in ipairs(items) do
    if i > self._config.maxItems then out.truncated = #items - self._config.maxItems; break end
    out.items[#out.items + 1] = self:read(it.name, it.params, now)
  end
  out.count = #out.items
  return out
end

-- Every parameterless reader keyed by name (previewBar on config.defaultDisplay).
function Instance:readAll(now)
  requireReady(self, "readAll")
  local out = {}
  for _, name in ipairs(READER_NAMES) do
    local r = READERS[name]
    if (not r.params or r.paramless) and not r.context then out[name] = self:read(name, nil, now) end
  end
  return out
end

-- Subscribe a bounded item list for service() to keep observed. Replaces the previous list; cached
-- observations of items no longer watched are dropped.
function Instance:watch(items, now)
  requireReady(self, "watch")
  if type(items) ~= "table" then error(NAME .. ": watch(items) needs a list", 2) end
  local watch, keep, truncated = {}, {}, 0
  for i, it in ipairs(items) do
    if i > self._config.maxItems then truncated = #items - self._config.maxItems; break end
    local alias = type(it) == "table" and ALIASES[it.name] or nil
    local r = type(it) == "table" and READERS[alias and alias.of or it.name] or nil
    local name = type(it) == "table" and it.name or it
    local _, key = identifyItem(r, name, type(it) == "table" and it.params or nil, self._config)
    it = type(it) == "table" and it or { name = name }
    if not keep[key] then
      keep[key] = true
      watch[#watch + 1] = { name = it.name, params = it.params, key = key }
    end
  end
  for key in pairs(self._cache) do if not keep[key] then self._cache[key] = nil end end
  self._watch, self._cursor = watch, 0
  return { watched = #watch, truncated = truncated }
end

function Instance:unwatch()
  requireReady(self, "unwatch")
  self._watch, self._cache, self._cursor = {}, {}, 0
  return {}
end

-- Per-iteration hook: identity check (bounded by identityCheckMs), then at most maxReadsPerService
-- watched items whose observation is older than pollIntervalMs, round robin from where the last
-- call stopped. The consumer's other work (input deadlines) is never delayed by more than that.
function Instance:service(now)
  requireReady(self, "service")
  if type(now) ~= "number" then error(NAME .. ": service(now) needs the clock in seconds", 2) end
  self._serviced = self._serviced + 1
  self._lastServiced = now
  local invalidated = self:_checkIdentity(now)
  local reads, due = 0, 0
  local n = #self._watch
  if n > 0 then
    local interval = self._config.pollIntervalMs / 1000
    for _ = 1, n do
      if reads >= self._config.maxReadsPerService then break end
      self._cursor = (self._cursor % n) + 1
      local w = self._watch[self._cursor]
      local c = self._cache[w.key]
      if c == nil or c.epoch ~= self._epoch or (now - c.observedAt) >= interval then
        self._cache[w.key] = self:read(w.name, w.params, now)
        reads = reads + 1
      end
    end
    for _, w in ipairs(self._watch) do
      local c = self._cache[w.key]
      if c == nil or c.epoch ~= self._epoch or (now - c.observedAt) >= interval then due = due + 1 end
    end
  end
  return { reads = reads, due = due, watched = n, invalidated = invalidated }
end

-- The watched observations as last read, each with its age; items not observed since the current
-- epoch are listed in notObserved with the reason. Nothing is read here.
function Instance:snapshot(now)
  requireReady(self, "snapshot")
  local items, notObserved = {}, {}
  for _, w in ipairs(self._watch) do
    local c = self._cache[w.key]
    if c == nil or c.epoch ~= self._epoch then
      notObserved[#notObserved + 1] = { key = w.key, reason = self._lastInvalidation and ("not observed since " .. tostring(self._lastInvalidation.reason)) or "not observed yet" }
    else
      local copy = {}
      for k, v in pairs(c) do copy[k] = v end
      local ageMs = (now ~= nil and c.observedAt ~= nil) and math.floor((now - c.observedAt) * 1000 + 0.5) or nil
      copy.ageMs = ageMs
      copy.stale = (ageMs == nil) or ageMs > self._config.staleMs or self._identityUncertain ~= nil
      if self._identityUncertain ~= nil then copy.identityUncertain = self._identityUncertain end
      items[#items + 1] = copy
    end
  end
  return { observedAt = now, epoch = self._epoch, atomic = false, identity = self._identity, identityUncertain = self._identityUncertain,
           items = items, notObserved = notObserved, watched = #self._watch }
end

-------------------------------------------------------------------------------
-- KB-17 context snapshot: the context readers assembled into one bounded, explicit description of what
-- each control would operate, with a binding generation.
-------------------------------------------------------------------------------
-- Items of a snapshot spec = { display?, executors?, executorPage? }. Shared by contextSnapshot() (live
-- reads) and watchContext() (service() polling), so the cache keys agree. KB-21: executorPage (a page
-- number) binds every listed executor to that page (independent of the user's page); without it the
-- executors are read on the user's current page (they follow the console's page changes).
local function contextItems(spec, config)
  spec = spec or {}
  config = config or DEFAULTS
  local display = spec.display
  if display == nil then display = config.encoderDisplay end
  local items = { { name = "dataPool" }, { name = "page" }, { name = "encoderBank", params = { display = display } }, { name = "encoderSlots", params = { display = display } } }
  local limitations = {}
  if spec.executors ~= nil and type(spec.executors) ~= "table" then limitations[#limitations + 1] = "executors must be a list of executor numbers; ignored" end
  local page = spec.executorPage
  if page ~= nil and (type(page) ~= "number" or page ~= math.floor(page) or page < 1) then
    limitations[#limitations + 1] = "executorPage must be a positive page number; ignored (the executors follow the user's current page)"
    page = nil
  end
  if type(spec.executors) == "table" then
    local max = config.maxExecutors or DEFAULTS.maxExecutors
    for i, n in ipairs(spec.executors) do
      if i > max then limitations[#limitations + 1] = string.format("executors truncated to %d of %d", max, #spec.executors); break end
      items[#items + 1] = { name = "executorTarget", params = { executor = n, page = page } }
    end
  end
  return items, limitations, display, page
end

-- The binding key of a spec: one generation record per distinct (display, executor list), so a consumer
-- polling one spec sees a generation that moves only when that spec's meaning moved.
local function generationKey(spec, display, page)
  local parts = { "display=" .. tostring(display) }
  if type(spec) == "table" and type(spec.executors) == "table" then
    local xs = {}
    for i, n in ipairs(spec.executors) do xs[i] = tostring(n) end
    parts[#parts + 1] = "executors=" .. table.concat(xs, ",")
    if page ~= nil then parts[#parts + 1] = "page=" .. tostring(page) end
  end
  return table.concat(parts, ";")
end

-- What an input would operate, as text: identity, epoch, bank/page/context, the selection's identity
-- (count and the scanned fixtures), each slot's object, resolution, readout, channel function, layer and
-- availability, the executor page, each executor's assignment, every configured function (key press,
-- release, combined release, fader, encoder, encoder left/right), fader token and playback-target status. Values, levels and activity are left
-- out on purpose: they change without changing what a control means. An unavailable part is included
-- with its reason, so losing or regaining a reading is itself a change of meaning.
local function bindingDigest(snap)
  local parts = { "epoch=" .. tostring(snap.epoch) }
  local id = snap.identity or {}
  parts[#parts + 1] = string.format("show=%s;user=%s;profile=%s;pool=%s;display=%s", tostring(id.showFile), tostring(id.user), tostring(id.profile),
    tostring(id.dataPool and (id.dataPool.name .. "#" .. tostring(id.dataPool.no)) or id.dataPoolUnavailable), tostring(snap.display))
  local e = snap.encoder
  if e and e.available then
    parts[#parts + 1] = string.format("bank=%s/%s;page=%s/%s;context=%s", tostring(e.value.bank.index), tostring(e.value.bank.name), tostring(e.value.page.index), tostring(e.value.page.name), tostring(e.value.context))
  else
    parts[#parts + 1] = "bank=unavailable:" .. tostring(e and (e.reason or e.error))
  end
  local s = snap.slots
  if s and s.available then
    -- Selection identity (KB-17 review): the same attributes on different fixtures are a different target.
    local sel = s.value.selection or {}
    local ids = {}
    for i, id in ipairs(sel.fixtures or {}) do ids[i] = tostring(id) end
    parts[#parts + 1] = string.format("selection=%s:%s%s", tostring(sel.count), table.concat(ids, ","), sel.identityComplete == false and ":incomplete" or "")
    for _, sl in ipairs(s.value.slots) do
      -- KB-19 review: the calibration inputs (physical range and its availability) are part of a slot's meaning.
      parts[#parts + 1] = string.format("slot%d=%s|%s|%s|%s|%s|%s|%s|%s|phys=%s..%s/%s/%s/%s", sl.slot, tostring(sl.kind), tostring(sl.ref), tostring(sl.resolution), tostring(sl.readout),
        tostring(sl.channelFunction), tostring(sl.layer), tostring(sl.availability), tostring(sl.outerRef),
        tostring(sl.physicalFrom), tostring(sl.physicalTo), tostring(sl.physicalRange), tostring(sl.physicalMixed), tostring(sl.physicalUnavailable)) .. (sl.discoveryIncomplete and "|discovery-incomplete" or "")
    end
  else
    parts[#parts + 1] = "slots=unavailable:" .. tostring(s and (s.reason or s.error))
  end
  -- KB-21: the user's current page is part of the meaning only while some bound executor follows it
  -- (no executors bound, or any bound on the current page); an independent-page binding does not move
  -- when the console changes pages.
  local follows = true
  if #(snap.executors or {}) > 0 then
    follows = false
    for _, x in ipairs(snap.executors) do if not (x.params and x.params.page ~= nil) then follows = true end end
  end
  if follows then parts[#parts + 1] = "execPage=" .. tostring(snap.executorPage and snap.executorPage.no or snap.executorPageUnavailable) end
  for _, x in ipairs(snap.executors or {}) do
    local pg = x.params and x.params.page
    if x.available then
      local v, f = x.value, x.value.functions or {}
      -- KB-21: the explicit identity (pool, page, mode), width, coverage and page existence are part of it.
      parts[#parts + 1] = string.format("exec%s@%s/%s=%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|w=%s|cov=%s|pm=%s|pool=%s", tostring(v.executor), tostring(pg), tostring(v.page and v.page.no), tostring(v.empty), tostring(v.assigned and (v.assigned.addr or v.assigned.name)),
        tostring(v.assigned and v.assigned.class), tostring(f.keyPress), tostring(f.keyUnpress), tostring(f.keyUnpressCombined), tostring(f.fader), tostring(f.encoder), tostring(f.encoderLeft), tostring(f.encoderRight),
        tostring(v.level and v.level.token), tostring(v.playbackTarget), tostring(v.width), tostring(v.coveredBy), tostring(v.pageMissing), tostring(v.pool and (v.pool.name .. "#" .. tostring(v.pool.no))))
    else
      parts[#parts + 1] = string.format("exec%s@%s=unavailable:%s", tostring(x.params and x.params.executor), tostring(pg), tostring(x.reason or x.error))
    end
  end
  return table.concat(parts, "\n")
end

function Instance:contextItems(spec) return contextItems(spec, self._config) end

-- Subscribes the snapshot's items for service() polling (replaces the watch list, like watch()).
function Instance:watchContext(spec, now)
  requireReady(self, "watchContext")
  local items, limitations = contextItems(spec, self._config)
  local r = self:watch(items, now)
  r.limitations = limitations
  r.items = items
  return r
end

-- One bounded snapshot. opts.cached = true assembles it from the watched observations (nothing is read;
-- items never observed in this epoch are unavailable with that reason and the snapshot is stale); otherwise
-- every item is read now, one after another (not atomic). spec.allExecutors = true (live only) adds every
-- assigned executor of the current page through pageExecutors, bounded by config.maxExecutors.
function Instance:contextSnapshot(spec, now, opts)
  requireReady(self, "contextSnapshot")
  spec = spec or {}
  opts = opts or {}
  if type(spec) ~= "table" then error(NAME .. ": contextSnapshot(spec) needs a table", 2) end
  local cached = opts.cached == true
  local items, limitations, display, execPage = contextItems(spec, self._config)
  local pageList
  if spec.allExecutors == true then
    if cached then
      limitations[#limitations + 1] = "allExecutors is a live-read option; a cached snapshot covers the executors of the watched spec"
    else
      local pe = self:read("pageExecutors", execPage ~= nil and { page = execPage } or nil, now)
      if pe.available then
        pageList = pe.value
        local present = {}
        for _, it in ipairs(items) do if it.name == "executorTarget" then present[it.params.executor] = true end end
        local count = 0
        for _, it in ipairs(items) do if it.name == "executorTarget" then count = count + 1 end end
        for _, x in ipairs(pe.value.executors) do
          if x.index ~= nil and not present[x.index] then
            if count >= self._config.maxExecutors then limitations[#limitations + 1] = string.format("allExecutors bounded to %d executors", self._config.maxExecutors); break end
            items[#items + 1] = { name = "executorTarget", params = { executor = x.index, page = execPage } }
            present[x.index] = true
            count = count + 1
          end
        end
        if pe.value.truncated then limitations[#limitations + 1] = "pageExecutors was truncated; not every assigned executor is listed" end
      else
        limitations[#limitations + 1] = "allExecutors: pageExecutors unavailable (" .. tostring(pe.reason or pe.error) .. ")"
      end
    end
  end
  local invalidated = nil
  if not cached then invalidated = self:_checkIdentity(now) end
  local obs, anyStale, notObserved = {}, false, 0
  for _, it in ipairs(items) do
    local alias = ALIASES[it.name]
    local r = READERS[alias and alias.of or it.name]
    local _, key = identifyItem(r, it.name, it.params, self._config)
    if cached then
      local c = self._cache[key]
      if c ~= nil and c.epoch == self._epoch then
        local copy = {}
        for k, v in pairs(c) do copy[k] = v end
        local ageMs = (now ~= nil and c.observedAt ~= nil) and math.floor((now - c.observedAt) * 1000 + 0.5) or nil
        copy.ageMs = ageMs
        copy.stale = (ageMs == nil) or ageMs > self._config.staleMs or self._identityUncertain ~= nil
        if copy.stale then anyStale = true end
        obs[#obs + 1] = copy
      else
        notObserved = notObserved + 1
        anyStale = true
        obs[#obs + 1] = { name = it.name, key = key, params = it.params, available = false, epoch = self._epoch, stale = true,
                          reason = self._lastInvalidation and ("not observed since " .. tostring(self._lastInvalidation.reason) .. " (watchContext() and service() first)") or "not observed yet (watchContext() and service() first)" }
      end
    else
      obs[#obs + 1] = self:read(it.name, it.params, now)
    end
  end
  local identity = {}
  for k, v in pairs(self._identity or {}) do identity[k] = v end
  local snap = { observedAt = now, epoch = self._epoch, atomic = false, cached = cached or nil, identity = identity, identityUncertain = self._identityUncertain,
                 invalidated = invalidated, display = display,
                 authoritativeDisplay = { display = display, rule = (spec.display ~= nil) and "requested" or "configured",
                                          note = "the encoder bar of this display is the one described; a display without an encoder bar is unavailable and no other display is substituted" },
                 executors = {}, executorSpecPage = execPage, executorMode = execPage ~= nil and "page" or "current",
                 limitations = limitations, stale = cached and anyStale or nil, notObserved = cached and notObserved or nil }
  for _, o in ipairs(obs) do
    if o.name == "dataPool" then
      if o.available then identity.dataPool = o.value else identity.dataPoolUnavailable = o.reason or o.error end
    elseif o.name == "page" then
      if o.available then snap.executorPage = o.value else snap.executorPageUnavailable = o.reason or o.error end
    elseif o.name == "encoderBank" then snap.encoder = o
    elseif o.name == "encoderSlots" then snap.slots = o
    elseif o.name == "executorTarget" then snap.executors[#snap.executors + 1] = o end
  end
  if pageList then snap.pageExecutors = pageList end
  local digest = bindingDigest(snap)
  local gkey = generationKey(spec, display, execPage)
  local g = self._generations[gkey]
  snap.bindingKey = gkey
  local selIncomplete = snap.slots and snap.slots.available and snap.slots.value.selection and snap.slots.value.selection.identityComplete == false
  if selIncomplete then
    -- The scanned attributes are bounded, the identity walk is bounded too: beyond its bound what an encoder
    -- would operate is not fully known, so no generation is recorded or advanced.
    snap.generation = nil
    snap.generationUnknown = true
    snap.lastGeneration = g and g.generation or nil
    snap.generationNote = "no generation: the selection identity is incomplete (" .. tostring(snap.slots.value.selection.limitations[#snap.slots.value.selection.limitations]) .. ")"
    return snap
  end
  if cached and notObserved > 0 then
    -- Not every part has been observed in this epoch: the meaning is unknown, so no generation is
    -- recorded or advanced. The last recorded one (if any) is reported as such, never as current.
    snap.generation = nil
    snap.generationUnknown = true
    snap.lastGeneration = g and g.generation or nil
    snap.generationNote = "no generation: " .. notObserved .. " item(s) not observed in this epoch (service() must observe every watched item first)"
    return snap
  end
  -- KB-21 live: a cached snapshot straddles a page change: the page item already names the new page while
  -- executors that follow the user's page were last read on the old one (service() re-reads them a few per
  -- tick), and every re-read batch would move the generation. Until every following executor was observed
  -- on the page the snapshot names, the binding's meaning is unknown: no generation is claimed or advanced.
  if cached and snap.executorPage and snap.executorPage.no ~= nil then
    local behind = 0
    for _, x in ipairs(snap.executors) do
      local v = x.available and x.value
      if v and v.mode == "current" and type(v.page) == "table" and v.page.no ~= nil and v.page.no ~= snap.executorPage.no then behind = behind + 1 end
    end
    if behind > 0 then
      snap.generation = nil
      snap.generationUnknown = true
      snap.lastGeneration = g and g.generation or nil
      snap.pageChangePending = behind
      snap.generationNote = string.format("no generation: %d executor(s) were observed on another page than the current page %s (a page change is being re-read; service() must observe them again first)", behind, tostring(snap.executorPage.no))
      return snap
    end
  end
  if g == nil then
    g = { generation = 1, digest = digest, since = now }
    self._generations[gkey] = g
    self._generationOrder[#self._generationOrder + 1] = gkey
    while #self._generationOrder > self._config.maxGenerations do
      local old = table.remove(self._generationOrder, 1)
      self._generations[old] = nil
    end
    snap.generationChanged = false
    snap.generationNote = "first snapshot of this spec in this instance; compare generations of one spec within one instance (epoch) only"
  elseif g.digest ~= digest then
    g.generation, g.digest, g.since = g.generation + 1, digest, now
    snap.generationChanged = true
  else
    snap.generationChanged = false
  end
  snap.generation, snap.generationSince = g.generation, g.since
  if cached and anyStale then snap.generationNote = (snap.generationNote and (snap.generationNote .. "; ") or "") .. "built from stale observations: the generation may lag the console" end
  return snap
end

local function new(opts)
  opts = opts or {}
  if type(opts.owner) ~= "string" or opts.owner == "" then error(NAME .. ".new: opts.owner (non-empty string) is required", 2) end
  if opts.deps ~= nil and type(opts.deps) ~= "table" then error(NAME .. ".new: opts.deps must be a table", 2) end
  if opts.config ~= nil and type(opts.config) ~= "table" then error(NAME .. ".new: opts.config must be a table", 2) end
  local config = {}
  for k, v in pairs(DEFAULTS) do config[k] = v end
  for k, v in pairs(opts.config or {}) do
    if DEFAULTS[k] == nil then error(NAME .. ".new: unknown config key '" .. tostring(k) .. "'", 2) end
    if type(v) ~= "number" or v < 0 then error(NAME .. ".new: config." .. k .. " must be a non-negative number", 2) end
    config[k] = v
  end
  return setmetatable({ _owner = opts.owner, _deps = opts.deps or {}, _config = config, _state = "created", _reads = 0, _serviced = 0,
                        _epoch = 1, _cache = {}, _watch = {}, _cursor = 0, _generations = {}, _generationOrder = {} }, Instance)
end

local M = { NAME = NAME, VERSION = VERSION, API_VERSION = API_VERSION, READERS = readerNames(), new = new, consoleDeps = consoleDeps,
            itemsFor = itemsFor, describe = describeReaders, toBool = toBool, keyOf = keyOf,
            contextItems = contextItems, parseRef = parseRef, bindingDigest = bindingDigest }

-- Registration (the KB-02 loading contract). The console runs this chunk once per import or show
-- load with (pluginName, componentName, signalTable, handle). signalTable is one table per plugin
-- instance, shared by all of that plugin's components, so registering here lets the plugin's entry
-- component find the module without globals or package.loaded. Get("FileContent") is capped at
-- about 1 KB, so a source-reading loader cannot work; see docs/modules.md.
local module = setmetatable({}, { __index = M, __newindex = function(_, k) error(NAME .. ": module table is read-only (tried to set '" .. tostring(k) .. "')", 2) end,
                                  __pairs = function() return pairs(M) end, __metatable = "locked" })
do
  local _, _, signalTable = ...
  if type(signalTable) == "table" then
    local reg = rawget(signalTable, "__gma3_mcp_modules")
    if type(reg) ~= "table" then reg = {}; signalTable.__gma3_mcp_modules = reg end
    reg[NAME] = module
  end
end
return module
