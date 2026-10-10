-- Regression harness for the KB-14 scoped shortcut-mode changes and text routes of
-- plugin/gma3_mcp_hardkeys.lua (0.9.0) under stock Lua.
--
-- Everything runs against the module's FAKE backend with fake console readers AND the mode writer
-- (deps.setShortcutsActive), so the profile, the shortcut state, the table and every failure of a read or
-- write can be staged per step. The clock is a plain number; nothing sleeps. What the KB-14 timing probe
-- established on the console (docs/probes/kb-14-timing-macos-2.5.1.md) is encoded as the restore delay:
-- the mode is never restored in the call that dispatched the last dependent key event.
--
-- Run from the repository root:   lua test/lua/hardkeys_mode_test.lua

local here = (arg and arg[0] or ""):match("^(.*)[/\\]") or "."
package.path = here .. "/?.lua;" .. package.path
local json = require("json")

local failures, passes = 0, 0
local function check(name, cond, detail)
  if cond then passes = passes + 1; print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end
local function J(v) return json.encode(v) end
local function has(list, needle)
  for _, s in ipairs(list or {}) do if tostring(s):find(needle, 1, true) then return true end end
  return false
end

local chunk = assert(loadfile(here .. "/../../plugin/gma3_mcp_hardkeys.lua"))
local HK = chunk("test_plugin", "gma3_mcp_hardkeys", {}, nil)

local VK = { MA1 = 1, STORE = 66, NUM1 = 68, NUM5 = 72, THRU = 78, PLEASE = 84, OOPS = 86, CLEAR = 87, ESC = 88, FIXTURE = 56 }
-- The fake console: profile name, shortcut state (nil = unreadable), rows, plus write controls.
local console
local function reset()
  console = { name = "Default", shortcutsActive = true, vk = VK, writes = {}, writeRaises = nil, writeIgnored = false, readRaises = nil, profileRaises = nil, cmd = "" }
  console.rows = {
    { shortcut = "S", keyCode = 66 }, { shortcut = "5", keyCode = 72 }, { shortcut = "1", keyCode = 68 },
    { shortcut = "Enter", keyCode = 84 }, { shortcut = "Escape", keyCode = 88 }, { shortcut = "F", keyCode = 56 },
    -- THRU has no row
  }
end
reset()
local backend
local deps = {
  shortcutRows = function() return console.rows end,
  virtualKeyCodes = function() return console.vk end,
  shortcutsActive = function() if console.readRaises then error(console.readRaises, 0) end return console.shortcutsActive end,
  setShortcutsActive = function(v)
    console.writes[#console.writes + 1] = v
    if console.writeRaises then error(console.writeRaises, 0) end
    if not console.writeIgnored then console.shortcutsActive = v end
  end,
  profileName = function() if console.profileRaises then error(console.profileRaises, 0) end return console.name end,
  displayExists = function(n) return n == 1 end,
  -- The command line is what the fake typed (the KB-05 fake appends char events to typed).
  commandText = function() return backend and backend:typedText() or "" end,
}
local DELAY = HK.DEFAULT_CONFIG.modeRestoreDelayMs / 1000

local function fresh(opts)
  opts = opts or {}
  backend = HK.fakeBackend({ capabilities = opts.capabilities })
  backend:setConfirmMode(nil)  -- like Keyboard(): releases are dispatched, never observed per key
  local config = { requireInteraction = false }
  for k, v in pairs(opts.config or {}) do config[k] = v end
  local inst = HK.new({ owner = "surface", deps = deps, config = config, routing = opts.routing }):init()
  if not opts.disabled then
    local ok, err = inst:enableInput(backend)
    assert(ok and ok.enabled, "enableInput failed: " .. J(err))
  end
  inst:openSession({ id = "s" }, 0)
  return inst, backend
end
local function lastEvent(b) return b.events[#b.events] end
local function holdById(inst, id) for _, h in ipairs(inst:status().holds) do if h.id == id then return h end end end
local function noMode(inst) return inst:status().modeChange == nil end
local TEXT_POLICY = { keys = { NUM5 = { method = "type", text = "5" }, THRU = { method = "type", text = "Thru " }, FIXTURE = { method = "shortcutOrType", text = "Fixture " } } }

-------------------------------------------------------------------------------
-- Availability and reporting
-------------------------------------------------------------------------------
do
  reset()
  local inst = fresh({ routing = TEXT_POLICY })
  local rep = inst:routingReport()
  check("type is available on a backend with char + modeChange and the write dep", rep.methods.type.available == true and rep.capabilities.modeChange == true, J(rep.methods))
  local d = inst:describeRoute("THRU")
  check("type with shortcuts on: text route, mode change to off, dispatchable", d.dispatchable and d.effective == "text" and d.modeChange.target == false and #d.unavailable == 0, J(d))
  console.shortcutsActive = false
  d = inst:describeRoute("THRU")
  check("type with shortcuts off: text route without a mode change", d.dispatchable and d.effective == "text" and d.modeChange == nil and d.shortcutsActive == false, J(d))
  d = inst:describeRoute("STORE")
  check("shortcut-table route with shortcuts off: dispatchable with a mode change to on", d.dispatchable and d.effective == "shortcut-table" and d.modeChange.target == true and d.tuple.pcKey == "S", J(d))
  d = inst:describeRoute("PLEASE")
  check("native PLEASE needs no mode change whatever the mode", d.dispatchable and d.effective == "native" and d.modeChange == nil, J(d))
  console.shortcutsActive = true
  d = inst:describeRoute("FIXTURE")
  check("shortcutOrType with a row and shortcuts on: shortcut route, no mode change", d.dispatchable and d.effective == "shortcut-table" and d.modeChange == nil, J(d))
  console.rows = { { shortcut = "S", keyCode = 66 } }
  d = inst:describeRoute("FIXTURE")
  check("shortcutOrType, no row, shortcuts on: text route with a mode change to off", d.dispatchable and d.effective == "text" and d.modeChange.target == false, J(d))
  reset()
  local stub = { name = "stub", dispatches = true, press = function() return true end, release = function() return true end, capabilities = { keyboard = true, modeChange = true } }
  local noChar = HK.new({ owner = "surface", deps = deps, config = { requireInteraction = false } }):init()
  local r, err = noChar:enableInput(stub, { routing = { keys = { STORE = { method = "type", text = "Store " } } } })
  check("type is refused on a backend without char", r == nil and err.code == "policy-unavailable" and has(err.problems[1].missing, "character events"), J(err))
  local noMode = fresh({ capabilities = { keyboard = true, quickkey = false, char = true, modeChange = false } })
  console.shortcutsActive = false
  d = noMode:describeRoute("STORE")
  check("a backend without modeChange keeps the pre-0.9.0 refusal for a shortcut-table route with shortcuts off", not d.supported and d.code == "shortcuts-inactive" and has(d.unavailable, "modeChange"), J(d))
  local kb = HK.keyboardBackend({ Keyboard = function() end, keyboardCodes = function() return { S = 83 } end, setShortcutsActive = function() end })
  check("the Keyboard() backend advertises modeChange only with the write dep", HK.adapterCapabilities(kb).modeChange == true and HK.adapterCapabilities(HK.keyboardBackend({ Keyboard = function() end })).modeChange == false)
end

-------------------------------------------------------------------------------
-- type: insertion with shortcuts already off (no mode change)
-------------------------------------------------------------------------------
do
  reset()
  console.shortcutsActive = false
  local inst, b = fresh({ routing = TEXT_POLICY })
  local h = inst:press("s", 1, { key = "THRU" })
  check("text inserted once on press: 5 char events, record released at once", h and h.kind == "text" and h.state == "released" and h.text.typed == 5 and b:typedText() == "Thru " and b:eventCount("char") == 5 and h.pressOutcome == "dispatched" and h.releaseOutcome == "none", J(h))
  check("no mode operation was needed", noMode(inst) and #console.writes == 0)
  check("the readback is pending until service() sees the command line", h.text.readback.outcome == "pending" and h.text.readback.expected == "Thru ")
  inst:service(1.01)
  check("service() observes the inserted text on the command line", holdById(inst, h.id).text.readback.outcome == "observed", J(holdById(inst, h.id).text))
  local rel = inst:release("s", 2, { hold = h.id })
  check("releasing a text record is harmless: nothing on release", rel.alreadyReleased == true and b:eventCount("release") == 0, J(rel))
  local t = inst:tap("s", 3, { key = "NUM5" }, 50)
  check("a tap of a text route inserts and schedules nothing", t and t.kind == "text" and t.deadline == nil and b:typedText() == "Thru 5", J(t))
  inst:service(3.1)
  check("no release is attempted at a tap deadline for text", b:eventCount("release") == 0)
  -- A standalone text press needs no interaction even with requireInteraction
  local strict = fresh({ routing = TEXT_POLICY, config = { requireInteraction = true } })
  local x = strict:press("s", 4, { key = "THRU" })
  check("text needs no interaction under requireInteraction (it holds nothing)", x and x.kind == "text", J(x))
  -- A text route refuses other records
  local inst2, b2 = fresh({ routing = TEXT_POLICY })
  local held = inst2:press("s", 5, { key = "STORE" })  -- shortcut-table hold needs shortcuts on: mode change to on
  check("a shortcut hold with shortcuts off entered a mode operation (on)", held and held.modeOp ~= nil and console.shortcutsActive == true and #console.writes == 1 and console.writes[1] == true, J(held))
  local y, err = inst2:press("s", 5, { key = "THRU" })
  check("text refuses while a key is held, nothing inserted", y == nil and err.code == "mode-conflict" and b2:eventCount("char") == 0, J(err))
  inst2:release("s", 6, { hold = held.id })
  y, err = inst2:press("s", 6, { key = "THRU" })
  check("text refuses while the released key is retained for the restoration", y == nil and err.code == "mode-conflict" and holdById(inst2, held.id).state == "retained", J(err))
  inst2:service(6 + DELAY + 0.001)
  check("the mode is restored after the delay and the record released", console.shortcutsActive == false and holdById(inst2, held.id).state == "released" and holdById(inst2, held.id).restoration.by == "service", J(holdById(inst2, held.id)))
  y = inst2:press("s", 7, { key = "THRU" })
  check("then text is admitted again", y and y.kind == "text", J(y))
  -- combos and exclusive refuse text
  local c, cerr = inst2:combo("s", 8, { { key = "THRU" }, { key = "NUM5" } }, { holdMs = 50 })
  check("a text route cannot be in a combo", c == nil and cerr.code == "unsupported" and cerr.message:find("combo"), J(cerr))
  c, cerr = inst2:press("s", 8, { key = "THRU", exclusive = true })
  check("a text route cannot be exclusive", c == nil and cerr.code == "unsupported", J(cerr))
  check("a text tuple identity is the logical key", HK.tupleKey({ text = "x", textKey = "THRU" }) == "text:THRU")
end

-------------------------------------------------------------------------------
-- type with shortcuts on: temporary disable, restore after the delay, never in the same call
-------------------------------------------------------------------------------
do
  reset()
  local inst, b = fresh({ routing = TEXT_POLICY })
  local h = inst:press("s", 1, { key = "NUM5" })
  check("shortcuts on: the mode was written off before the chars and the record is retained", h and h.state == "retained" and h.modeOp == "m1" and console.writes[1] == false and console.shortcutsActive == false and b:typedText() == "5", J(h))
  local st = inst:status(1)
  check("status reports the mode operation with its dependents and the restore delay", st.modeChange and st.modeChange.state == "active" and st.modeChange.original == true and st.modeChange.target == false and st.modeChange.profile == "Default" and st.modeChange.dependents[1].hold == h.id and st.retained == 1 and st.busy == nil, J(st.modeChange))
  inst:service(1.0)
  check("the same instant: not restored (the console consumes events on the next frame)", console.shortcutsActive == false and #console.writes == 1)
  inst:service(1 + DELAY / 2)
  check("before the delay elapsed: still not restored", #console.writes == 1)
  local out = inst:service(1 + DELAY + 0.001)
  check("after the delay the original state is written back and verified", console.shortcutsActive == true and #console.writes == 2 and console.writes[2] == true and out.mode and out.mode.state == "restored", J(out.mode))
  st = inst:status(2)
  check("the record is released and the operation reported as last restored", holdById(inst, h.id).state == "released" and st.modeChange == nil and st.lastModeChange.state == "restored" and st.lastModeChange.restoredBy == "service", J(st.lastModeChange))
  -- a second text press joins the active operation; the delay restarts at the last event
  h = inst:press("s", 3, { key = "THRU" })
  local h2 = inst:press("s", 3 + DELAY / 2, { key = "NUM5" })
  check("a second text press joins the same operation", h2 and h2.modeOp == h.modeOp and h.modeOp == "m2" and #console.writes == 3, J(h2))
  inst:service(3 + DELAY + 0.001)
  check("the delay counts from the last dependent event: not yet restored", #console.writes == 3 and console.shortcutsActive == false)
  inst:service(3 + DELAY / 2 + DELAY + 0.001)
  check("restored after the second event's delay; both records released", #console.writes == 4 and console.shortcutsActive == true and holdById(inst, h.id).state == "released" and holdById(inst, h2.id).state == "released")
  -- KB-05 text steps never type under the borrowed mode
  h = inst:press("s", 5, { key = "THRU" })
  local q, qerr = inst:startSequence("s", 5, { { kind = "text", text = "x", context = "command-line", acknowledgeFocus = true } })
  check("a KB-05 text step is refused while a mode operation is pending", (q == nil and qerr.code == "busy") or (q and q.state ~= "running"), J(q or qerr))
  inst:service(5 + DELAY + 0.001)
end

-------------------------------------------------------------------------------
-- shortcut: temporary enable kept through the hold, restored after the release
-------------------------------------------------------------------------------
do
  reset()
  console.shortcutsActive = false
  local inst, b = fresh()
  local ia = inst:beginInteraction("s", 1, {})
  local h = inst:press("s", 1, { key = "STORE", interaction = ia.id })
  check("STORE with shortcuts off: enabled, pressed, held in the enabled mode", h and h.state == "held" and h.route.modeChange.target == true and h.route.shortcutsActive == true and console.shortcutsActive == true and lastEvent(b).pcKey == "S" and lastEvent(b).kind == "press", J(h))
  for i = 1, 5 do inst:service(1 + i * DELAY) end
  check("the mode is kept while the key is held (no restore, no route mismatch)", console.shortcutsActive == true and #console.writes == 1 and holdById(inst, h.id).routeMismatch == nil and holdById(inst, h.id).state == "held")
  local h2 = inst:press("s", 2, { key = "NUM5", interaction = ia.id })
  check("a second shortcut-table press while the mode is temporarily on joins the operation", h2 and h2.modeOp == h.modeOp, J(h2))
  local rel = inst:release("s", 3, { hold = h2.id })
  check("the release is dispatched and the record retained (mode still on)", rel.state == "retained" and rel.releaseOutcome == "dispatched" and rel.restoration.state == "pending" and console.shortcutsActive == true, J(rel))
  inst:service(3 + DELAY + 0.001)
  check("not restored while the first key is still held", console.shortcutsActive == true and holdById(inst, h2.id).state == "retained")
  rel = inst:release("s", 4, { hold = h.id })
  inst:service(4 + DELAY / 2)
  check("not restored in the release's own delay window", console.shortcutsActive == true)
  inst:service(4 + DELAY + 0.001)
  check("restored after the last release; both records released", console.shortcutsActive == false and holdById(inst, h.id).state == "released" and holdById(inst, h2.id).state == "released" and inst:status().modeChange == nil)
  inst:endInteraction("s", ia.id, 5)
  -- a tap: the deadline release moves the window
  local t = inst:tap("s", 6, { key = "STORE" }, 50)
  inst:service(6.05)
  check("tap released at the deadline, record retained", holdById(inst, t.id).state == "retained" and console.shortcutsActive == true)
  inst:service(6.05 + DELAY + 0.001)
  check("restored after the tap release", console.shortcutsActive == false and holdById(inst, t.id).state == "released")
  -- maxHoldMs still bounds a mode-changing hold
  local ia2 = inst:beginInteraction("s", 7, {})
  local hh = inst:press("s", 7, { key = "STORE", interaction = ia2.id, maxHoldMs = 500 })
  inst:service(7.6)
  check("the hold deadline released the key", holdById(inst, hh.id).state == "retained" and lastEvent(b).kind == "release")
  inst:service(7.6 + DELAY + 0.001)
  check("and the mode was restored afterwards", console.shortcutsActive == false)
  inst:endInteraction("s", ia2.id, 8)
  -- a mode-changing hold next to a text route is a conflict, never pre-empted
  local x, err = inst:press("s", 9, { key = "STORE", interaction = inst:beginInteraction("s", 9, {}).id })
  inst:configureRouting(TEXT_POLICY)
  local y, yerr = inst:press("s", 9, { key = "THRU" })
  check("text (needs off) while a hold needs on: mode-conflict, nothing typed", y == nil and yerr.code == "mode-conflict" and b:eventCount("char") == 0, J(yerr))
  inst:releaseAll("s", 10)
  inst:service(10 + DELAY + 0.001)
end

-------------------------------------------------------------------------------
-- Refusals before any change: unreadable state/profile, write failures
-------------------------------------------------------------------------------
do
  reset()
  local inst, b = fresh({ routing = TEXT_POLICY })
  console.readRaises = "boom"
  local x, err = inst:press("s", 1, { key = "NUM5" })
  check("unreadable shortcut state refuses before any write", x == nil and err.code == "unsupported" and err.reason == "unreadable" and #console.writes == 0, J(err))
  console.readRaises = nil
  console.profileRaises = "no profile"
  x, err = inst:press("s", 1, { key = "NUM5" })
  check("unreadable profile refuses before any write", x == nil and err.code == "unreadable" and #console.writes == 0 and b:eventCount("char") == 0, J(err))
  console.profileRaises = nil
  console.writeIgnored = true
  x, err = inst:press("s", 2, { key = "NUM5" })
  check("a write with no effect refuses, nothing typed, nothing to restore", x == nil and err.code == "mode-change-failed" and err.message:find("did not apply") and b:eventCount("char") == 0 and noMode(inst), J(err))
  console.writeIgnored = false
  console.writeRaises = "write blew up"
  x, err = inst:press("s", 3, { key = "NUM5" })
  check("a write that raises refuses and leaves an unresolved restoration", x == nil and err.code == "mode-change-failed" and err.restoration == "unresolved" and inst:status().modeChange.state == "unresolved", J(err))
  check("the instance is busy with the restoration", inst:admission(3).reason == "restoration" and inst:status(3).busy.reason == "restoration")
  console.writeRaises = nil
  local y, yerr = inst:press("s", 4, { key = "STORE" })
  check("every new press is refused until it is resolved", y == nil and yerr.code == "busy" and yerr.reason == "restoration", J(yerr))
  console.shortcutsActive = true  -- the console did not change (the raise happened before)
  local rec = inst:recover("s", 5)
  check("recover re-reads: the state is the original, nothing written, resolved", rec.restoration and rec.restoration.state == "restored" and rec.restoration.restoredBy == "recover" and #console.writes == 2 and noMode(inst), J(rec.restoration))
  -- stale decision: the state changed between resolution and dispatch (simulated by the route reading
  -- "on" while the dispatch reads "off")
  local inst2 = fresh({ routing = TEXT_POLICY })
  local real = deps.shortcutsActive
  local w0 = #console.writes
  local n = 0
  deps.shortcutsActive = function() n = n + 1; if n <= 1 then return true end return false end
  x, err = inst2:press("s", 6, { key = "NUM5" })
  deps.shortcutsActive = real
  check("a decision that is stale at dispatch is refused as route-changed, nothing written", x == nil and err.code == "route-changed" and #console.writes == w0, J(err))
end

-------------------------------------------------------------------------------
-- Interference: profile switch, operator toggles, unreadable at restore time
-------------------------------------------------------------------------------
do
  reset()
  local inst, b = fresh({ routing = TEXT_POLICY })
  local h = inst:press("s", 1, { key = "NUM5" })
  console.name = "Other"
  console.shortcutsActive = true  -- the other profile has its own state
  inst:service(1 + DELAY + 0.001)
  local st = inst:status(2)
  check("a profile switch during the operation: nothing written, restoration unresolved, record quarantined", #console.writes == 1 and st.modeChange.state == "unresolved" and st.modeChange.unresolved.reason:find("Other") and holdById(inst, h.id).state == "quarantined" and st.quarantined == 1, J(st.modeChange))
  local x, err = inst:press("s", 2, { key = "THRU" })
  check("new input blocked while unresolved", x == nil and err.code == "busy" and err.reason == "restoration", J(err))
  local rec = inst:recover("s", 3)
  check("recover with the other profile active does not write and stays unresolved", rec.restoration.state == "unresolved" and #console.writes == 1 and rec.restoration.unresolved.reason:find("replacement profile"), J(rec.restoration))
  console.name = "Default"
  console.shortcutsActive = false  -- back on our profile, still in our temporary state
  rec = inst:recover("s", 4)
  check("recover on the original profile restores and verifies; the quarantined record is released", rec.restoration.state == "restored" and console.shortcutsActive == true and #console.writes == 2 and holdById(inst, h.id).state == "released" and holdById(inst, h.id).restoration.by == "recover", J(rec.restoration))
  -- the operator (F10) sets the mode back while the operation is active
  h, err = inst:press("s", 5, { key = "NUM5" })
  check("a new text press after the recovery is admitted", h ~= nil, J(err))
  console.shortcutsActive = true
  inst:service(5.01)
  st = inst:status(5.01)
  check("the operator's newer state wins: resolved without a write, interference recorded", #console.writes == 3 and st.modeChange == nil and st.lastModeChange.restoredBy == "operator" and st.lastModeChange.interference ~= nil and holdById(inst, h.id).state == "released", J(st.lastModeChange))
  -- the operator disables shortcuts during a temporarily enabled hold: route change as before
  console.shortcutsActive = false
  local ia = inst:beginInteraction("s", 6, {})
  local hs = inst:press("s", 6, { key = "STORE", interaction = ia.id })
  console.shortcutsActive = false  -- F10 while held
  inst:service(6.01)
  local rel = inst:release("s", 6.02, { hold = hs.id })
  check("mode set back by the operator mid-hold: the release is unresolved (route changed), the operation resolved by the operator", rel.state == "unresolved" and rel.routeMismatch.reason:find("inactive") and inst:status().modeChange == nil, J(rel))
  console.shortcutsActive = true
  rec = inst:recover("s", 7)
  check("the stuck record recovers once the operator restores the route", #rec.released == 1 and holdById(inst, hs.id).state == "released", J(rec))
  console.shortcutsActive = false
  inst:endInteraction("s", ia.id, 7)
  inst:service(7 + DELAY + 0.001)
  -- unreadable at restore time
  h = inst:press("s", 8, { key = "STORE" })
  console.readRaises = "flaky"
  inst:service(8.01)
  check("unreadable state while active: unresolved, nothing written blindly", inst:status().modeChange.state == "unresolved" and #console.writes == 5, J(inst:status().modeChange))
  console.readRaises = nil
  rec = inst:recover(nil, 9)
  check("operator-scope recover re-validates it; the restore waits for the held key", rec.restoration.state == "active" and rec.restoration.revalidated ~= nil and console.shortcutsActive == true and holdById(inst, h.id).state == "held", J(rec.restoration))
  inst:release("s", 9.1, { hold = h.id })
  inst:service(9.1 + DELAY + 0.001)
  check("then the mode is restored after the release", console.shortcutsActive == false and inst:status().modeChange == nil)
  -- the restore write itself fails
  inst:releaseAll("s", 10)
  h = inst:press("s", 11, { key = "STORE" })
  inst:release("s", 11.1, { hold = h.id })
  console.writeIgnored = true
  inst:service(11.1 + DELAY + 0.001)
  check("a restore that does not take effect is unresolved with the readback in the reason", inst:status().modeChange.state == "unresolved" and inst:status().modeChange.unresolved.reason:find("reads back"), J(inst:status().modeChange))
  console.writeIgnored = false
  rec = inst:recover("s", 12)
  check("recover restores it", rec.restoration.state == "restored" and console.shortcutsActive == false, J(rec.restoration))
end

-------------------------------------------------------------------------------
-- Partial text: context change and char failures between chunks; nothing replayed
-------------------------------------------------------------------------------
do
  reset()
  console.shortcutsActive = false
  local inst, b = fresh({ routing = { keys = { LONG = { method = "type", text = "abcdefghijklmnop" } } }, config = { textCharsPerService = 4 } })
  VK.LONG = 99
  local real = deps.shortcutsActive
  local reads = 0
  deps.shortcutsActive = function() reads = reads + 1; if reads >= 4 then return true end return false end  -- flips after the second chunk's recheck
  local h = inst:press("s", 1, { key = "LONG" })
  deps.shortcutsActive = real
  check("the mode is rechecked between chunks: partial progress reported, nothing erased or replayed", h and h.text.outcome == "partial" and h.text.typed == 8 and h.text.code == "context-changed" and h.pressOutcome == "partial" and b:typedText() == "abcdefgh" and h.state == "released", J(h.text))
  b:setTypedText("")
  b:failNext("char", { codepoint = string.byte("c") }, "no")
  h = inst:press("s", 2, { key = "LONG" })
  check("a refused character stops typing with the progress", h and h.text.outcome == "partial" and h.text.typed == 2 and h.text.code == "char-refused", J(h.text))
  b:setTypedText("")
  b:failNext("char", { codepoint = string.byte("a") }, "no")
  local x, err = inst:press("s", 3, { key = "LONG" })
  local live = 0
  for _, hh in ipairs(inst:status().holds) do if hh.state ~= "released" then live = live + 1 end end
  check("a first character refused: press-failed, no record", x == nil and err.code == "press-failed" and err.reason == "char-refused" and live == 0, J(err))
  b:raiseNext("char", "console blocked")
  h = inst:press("s", 4, { key = "LONG" })
  check("a raising character: uncertain with the char index, typing stopped", h and h.text.outcome == "uncertain" and h.text.uncertainChar == 1 and h.pressOutcome == "uncertain", J(h.text))
  VK.LONG = nil
  -- with a mode change: a partial insertion still restores the mode afterwards
  console.shortcutsActive = true
  local inst2, b2 = fresh({ routing = { keys = { LONG2 = { method = "type", text = "wxyz" } } }, config = { textCharsPerService = 2 } })
  VK.LONG2 = 98
  b2:failNext("char", { codepoint = string.byte("y") }, "no")
  h = inst2:press("s", 5, { key = "LONG2" })
  check("partial insertion under a mode change is retained", h and h.text.typed == 2 and h.state == "retained", J(h))
  inst2:service(5 + DELAY + 0.001)
  check("and the mode is restored", console.shortcutsActive == true and holdById(inst2, h.id).state == "released")
  VK.LONG2 = nil
end

-------------------------------------------------------------------------------
-- Sequences: a step needing the opposite mode waits for the restoration
-------------------------------------------------------------------------------
do
  reset()
  console.shortcutsActive = false
  local inst, b = fresh({ routing = TEXT_POLICY })
  local q, qerr = inst:startSequence("s", 1, { { kind = "tap", key = "STORE", holdMs = 50 }, { kind = "tap", key = "THRU", holdMs = 50 }, { kind = "tap", key = "NUM1", holdMs = 50 } })
  check("sequence started with a mode-changing tap", q and q.state == "running", J(q or qerr))
  inst:service(1.05)
  check("the STORE tap released; the mode is still on and the THRU text step waits (pending, nothing typed)", console.shortcutsActive == true and inst:sequenceStatus(q.id).events[2].state == "pending" and b:typedText() == "" and inst:sequenceStatus(q.id).state == "running", J(inst:sequenceStatus(q.id)))
  inst:service(1.05 + DELAY + 0.001)
  local s2 = inst:sequenceStatus(q.id)
  check("after the restore the text step ran (shortcuts off, no mode change for it)", s2.events[2].state == "completed" and b:typedText() == "Thru " and holdById(inst, s2.events[2].hold).modeOp == nil, J(s2.events[2]))
  inst:service(1.2)
  inst:service(1.2 + DELAY + 0.001)
  inst:service(1.5)
  s2 = inst:sequenceStatus(q.id)
  check("the NUM1 tap (shortcut, mode on again) completed and the sequence finished", s2.state == "completed", J(s2))
  inst:service(1.5 + DELAY + 0.001)
  check("mode restored at the end", console.shortcutsActive == false and inst:status().modeChange == nil)
end

-------------------------------------------------------------------------------
-- Review fixes: partial text stops a sequence; a refused event never pins the mode
-------------------------------------------------------------------------------
do
  reset()
  console.shortcutsActive = false
  for _, kind in ipairs({ "press", "tap" }) do
    local inst, b = fresh({ routing = TEXT_POLICY })
    b:failNext("char", { codepoint = string.byte("h") }, "no")  -- "Thru " stops after "T"
    local steps = { { kind = kind, key = "THRU", holdMs = kind == "tap" and 50 or nil }, { kind = "tap", key = "PLEASE", holdMs = 50 } }
    local q = inst:startSequence("s", 1, steps)
    inst:service(1.0); inst:service(1.1)
    local s2 = inst:sequenceStatus(q.id)
    check(kind .. " of a partially inserted text route stops the sequence: PLEASE unattempted, progress kept, nothing replayed", s2.state ~= "completed" and s2.state ~= "running" and s2.events[1].state == "uncertain" and s2.events[1].text.typed == 1 and s2.events[2].state == "unattempted" and b:typedText() == "T" and b:eventCount("press") == 0, J(s2))
  end
  -- a refused press after the mode was changed
  console.shortcutsActive = false
  local inst, b = fresh()
  b:failNext("press", { pcKey = "S" }, "refused")
  local x, err = inst:press("s", 2, { key = "STORE" })
  check("the press was refused after the mode change: no ownership record", x == nil and err.code == "press-failed" and inst:status().capacity.used == 0 and console.shortcutsActive == true, J(err))
  inst:service(2 + DELAY + 0.001)
  check("the dropped record does not pin the mode: restored by service()", console.shortcutsActive == false and inst:status().modeChange == nil, J(inst:status().modeChange))
  -- the first character refused after the mode was changed
  console.shortcutsActive = true
  local inst2, b2 = fresh({ routing = TEXT_POLICY })
  b2:failNext("char", { codepoint = string.byte("5") }, "no")
  x, err = inst2:press("s", 3, { key = "NUM5" })
  check("the first character was refused after the mode change: no record, mode still changed", x == nil and err.code == "press-failed" and inst2:status().capacity.used == 0 and console.shortcutsActive == false, J(err))
  inst2:service(3 + DELAY + 0.001)
  check("...and restored by service()", console.shortcutsActive == true and inst2:status().modeChange == nil)
end

-------------------------------------------------------------------------------
-- Dispose / adopt: restoration across a restart, never a replacement profile
-------------------------------------------------------------------------------
do
  reset()
  local inst = fresh({ routing = TEXT_POLICY })
  local h = inst:press("s", 1, { key = "NUM5" })
  local res = inst:dispose(1.01)
  check("dispose within the restore delay does not write; the restoration is handed back as pending", console.shortcutsActive == false and res.mode and res.mode.pending == "delay" and res.mode.unresolved.reason:find("restore delay") and #res.records == 0, J(res))
  console.shortcutsActive = true
  local instD = fresh({ routing = TEXT_POLICY })
  h = instD:press("s", 1.5, { key = "NUM5" })
  res = instD:dispose(1.5 + DELAY + 0.01)
  check("dispose after the delay with every dependent released restores at once (terminal) and hands back no record", console.shortcutsActive == true and res.mode == nil and #res.records == 0, J(res))
  -- a dependent whose release failed keeps the mode: the record and the restoration are both handed back
  console.shortcutsActive = false
  local instU, bU = fresh()
  local hu = instU:press("s", 2, { key = "STORE" })
  bU:failNext("release", { pcKey = "S" }, "console frozen", true)
  res = instU:dispose(2 + DELAY + 0.5)
  check("dispose with an unresolved dependent writes nothing (shortcuts stay on for the stuck key) and hands back the key record and a pending restoration", console.shortcutsActive == true and #res.records == 1 and res.records[1].pcKey == "S" and res.mode and res.mode.pending == "dependents" and res.mode.original == false, J({ sc = console.shortcutsActive, mode = res.mode, records = #res.records }))
  local instA, bA = fresh()
  instA:adopt(res.records, 3)
  instA:adoptMode(res.mode, 3)
  bA:failNext("release", { pcKey = "S" }, "console still frozen", true)
  local recA = instA:recover(nil, 4)
  check("operator recover with the adopted key still unresolved keeps the restoration pending (nothing written)", recA.restoration.state == "unresolved" and recA.restoration.pending == "dependents" and console.shortcutsActive == true, J(recA.restoration))
  bA:clearFailures()
  recA = instA:recover(nil, 5)
  check("once the adopted key is released the restoration is restored on the original profile", #recA.released == 1 and recA.restoration.state == "restored" and console.shortcutsActive == false and instA:status().modeChange == nil, J(recA.restoration))
  console.shortcutsActive = true
  local inst2 = fresh({ routing = TEXT_POLICY })
  h = inst2:press("s", 2, { key = "NUM5" })
  console.name = "Other"
  res = inst2:dispose(2.01)
  check("dispose on another profile writes nothing and hands back the restoration record", console.writes[#console.writes] == false and res.mode and res.mode.state == nil and res.mode.original == true and res.mode.target == false and res.mode.profile == "Default", J(res.mode))
  local inst3 = fresh({ routing = TEXT_POLICY })
  local a = inst3:adoptMode(res.mode, 3)
  check("adopted as an unresolved restoration of a previous run; the instance is busy", a and a.state == "unresolved" and a.owner == "previous-run" and inst3:admission(3).reason == "restoration", J(a))
  local x, err = inst3:press("s", 3, { key = "NUM5" })
  check("new input refused until it is recovered", x == nil and err.code == "busy", J(err))
  local rec = inst3:recover("s", 4)
  check("the owner session cannot recover a previous run's restoration", rec.restoration.skipped ~= nil and inst3:status().modeChange.state == "unresolved", J(rec.restoration))
  rec = inst3:recover(nil, 5)
  check("operator recover on the other profile: still unresolved, nothing written", rec.restoration.state == "unresolved" and console.name == "Other" and console.writes[#console.writes] == false, J(rec.restoration))
  console.name = "Default"
  console.shortcutsActive = false
  rec = inst3:recover(nil, 6)
  check("operator recover on the original profile restores the original state", rec.restoration.state == "restored" and console.shortcutsActive == true and inst3:status().modeChange == nil, J(rec.restoration))
  local bad, berr = inst3:adoptMode({ profile = "x" }, 7)
  check("a malformed record is refused", bad == nil and berr.code == "bad-record")
end

print(string.format("%d passed, %d failed", passes, failures))
print(failures == 0 and "ALL PASSED" or "FAILED")
os.exit(failures == 0 and 0 or 1)
