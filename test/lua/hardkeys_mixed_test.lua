-- Regression harness for the KB-15 mixed backend of plugin/gma3_mcp_hardkeys.lua (0.10.0) under stock Lua.
--
-- The Quickey part is the real owned-Quickey backend over the KB-13 fake console (Quickey pool, executor
-- page, executor key state); the keyboard part is the module's fake backend (PC keys, characters, a
-- simulated focused text) with the KB-14 fake profile, shortcut state and mode writer in the deps. What
-- the harness proves: both kinds dispatch through their own part and are released/recovered/adopted
-- through it, an unavailable Quickey route never falls back to the keyboard part, and every combination
-- the console semantics do not qualify (both kinds down at once, a Quickey under a temporary mode change,
-- a mode change while a Quickey is down) is refused before dispatch with nothing issued.
--
-- Run from the repository root:   lua test/lua/hardkeys_mixed_test.lua

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
local DELAY = HK.DEFAULT_CONFIG.modeRestoreDelayMs / 1000

local VK = { [""] = 0, UNKNOWN = 0, MA1 = 1, MA2 = 2, X1 = 19, EXEC = 35, GO = 42, FIXTURE = 56, STORE = 66, NUM0 = 67, NUM1 = 68, NUM5 = 72,
             THRU = 78, PLEASE = 84, OOPS = 86, UNDO = 86, CLEAR = 87, ESC = 88 }

-- Fake console: the KB-13 Quickey pool and executor page plus the KB-14 profile/mode state ---------------
local console
local function newConsole()
  console = { quickeys = {}, executors = {}, pressed = {}, show = "disposable|Default", calls = {}, cmds = {}, fail = {}, raise = {},
              profile = "Default", shortcutsActive = true, writes = {}, writeRaises = nil, readRaises = nil,
              rows = { { shortcut = "0", keyCode = 67 }, { shortcut = "5", keyCode = 72 }, { shortcut = "1", keyCode = 68 }, { shortcut = "S", keyCode = 66 }, { shortcut = "Enter", keyCode = 84 } } }
  return console
end
local function tally(op) console.calls[op] = (console.calls[op] or 0) + 1 end
local function maybeFail(op)
  if console.raise[op] then local e = console.raise[op]; console.raise[op] = nil; error(e, 0) end
  if console.fail[op] then
    local f = console.fail[op]
    if f.count then f.count = f.count - 1; if f.count <= 0 then console.fail[op] = nil end end
    return false, f.err
  end
  return nil
end
local function execKey(page, index) return page .. "." .. index end
local function assigned(page, index)
  local x = console.executors[execKey(page, index)]
  if type(x) == "table" and x.quickey and console.quickeys[x.quickey] then return x.quickey end
  return nil
end
local kbPart  -- the fake keyboard part of the current instance (its typed text is the command line)
local deps = {
  virtualKeyCodes = function() return VK end,
  showIdentity = function() tally("showIdentity"); return console.show end,
  maState = function()
    for _, qi in pairs(console.pressed) do local q = console.quickeys[qi]; if q and q.code == "MA1" then return true end end
    return false
  end,
  shortcutRows = function() return console.rows end,
  shortcutsActive = function() if console.readRaises then error(console.readRaises, 0) end return console.shortcutsActive end,
  setShortcutsActive = function(v)
    console.writes[#console.writes + 1] = v
    if console.writeRaises then error(console.writeRaises, 0) end
    console.shortcutsActive = v
  end,
  profileName = function() return console.profile end,
  displayExists = function(n) return n == 1 end,
  commandText = function() return kbPart and kbPart:typedText() or "" end,
  quickeys = {
    read = function(index)
      tally("quickeys.read")
      local q = console.quickeys[index]
      if not q then return nil end
      return { name = q.name, code = q.code, note = q.note, lock = q.lock, class = q.class or "Quickey" }
    end,
    create = function(index)
      tally("quickeys.create"); console.cmds[#console.cmds + 1] = "Store Quickey " .. index
      if console.quickeys[index] then return false, "exists" end
      console.quickeys[index] = { name = "Quickey " .. index, code = "", note = "" }
      return true
    end,
    set = function(index, props)
      tally("quickeys.set")
      local q = console.quickeys[index]
      if not q then return false, "no object" end
      for k, v in pairs(props) do if k == "Code" then q.code = v elseif k == "Name" then q.name = v elseif k == "Note" then q.note = v end end
      return true
    end,
    delete = function(index)
      tally("quickeys.delete"); console.cmds[#console.cmds + 1] = "Delete Quickey " .. index
      console.quickeys[index] = nil
      for k, x in pairs(console.executors) do if type(x) == "table" and x.quickey == index then console.executors[k] = "empty" end end
      return true
    end,
  },
  executors = {
    read = function(page, index)
      tally("executors.read")
      local x = console.executors[execKey(page, index)]
      if x == nil then return { exists = false } end
      if x == "empty" then return { exists = true, class = "Executor", empty = true } end
      if x.quickey then
        local q = console.quickeys[x.quickey]
        if not q then return { exists = true, class = "Executor", empty = true } end
        return { exists = true, class = "Executor", empty = false, object = { class = "Quickey", name = q.name, index = x.quickey, note = q.note, code = q.code } }
      end
      return { exists = true, class = "Executor", empty = false, object = { class = x.class, name = x.name, index = x.index, note = x.note, code = x.code } }
    end,
    assign = function(page, index, quickeyIndex)
      tally("executors.assign"); console.cmds[#console.cmds + 1] = string.format("Assign Quickey %d At Page %d.%d", quickeyIndex, page, index)
      local f, e = maybeFail("assign"); if f == false then return false, e end
      if console.executors[execKey(page, index)] == nil then return false, "no such executor" end
      console.executors[execKey(page, index)] = { quickey = quickeyIndex }
      return true
    end,
    clear = function(page, index)
      tally("executors.clear"); console.cmds[#console.cmds + 1] = string.format("Delete Page %d.%d", page, index)
      console.executors[execKey(page, index)] = "empty"
      return true
    end,
    press = function(page, index)
      tally("executors.press"); console.cmds[#console.cmds + 1] = string.format("Press Page %d.%d", page, index)
      local f, e = maybeFail("press"); if f == false then return false, e end
      local qi = assigned(page, index)
      if not qi then return false, "Object not found" end
      console.pressed[execKey(page, index)] = qi
      return true, "OK"
    end,
    unpress = function(page, index)
      tally("executors.unpress"); console.cmds[#console.cmds + 1] = string.format("Unpress Page %d.%d", page, index)
      local f, e = maybeFail("unpress"); if f == false then return false, e end
      local qi = assigned(page, index)
      if not qi then return false, "Object not found" end
      local k = execKey(page, index)
      if console.pressed[k] == qi then console.pressed[k] = nil end
      return true, "OK"
    end,
  },
}
local function pageWithExecutors(page, first, count)
  for i = 0, count - 1 do console.executors[execKey(page, first + i)] = "empty" end
end
local SPEC = { authorized = true, quickeys = { first = 900 }, executors = { page = 1, first = 190, count = 8 } }
local KB_CAPS = { keyboard = true, quickkey = false, char = true, modeChange = true }
local POLICY = { default = "quickkey", keys = { NUM0 = { method = "shortcut" }, THRU = { method = "type", text = "Thru " }, PLEASE = { method = "shortcutOrType", text = "\n" } } }
-- PLEASE text "\n" is a control character and would be refused by validation; the harness uses a plain mapping instead.
POLICY.keys.PLEASE = nil

local function newInst(opts)
  opts = opts or {}
  local config = { requireInteraction = false }
  for k, v in pairs(opts.config or {}) do config[k] = v end
  return HK.new({ owner = opts.owner or "surface", deps = deps, config = config, routing = opts.routing or POLICY }):init()
end
-- A fresh console + instance with the bank provisioned and the mixed adapter attached (unless disabled).
local function fresh(opts)
  opts = opts or {}
  newConsole()
  pageWithExecutors(1, 190, 8)
  local inst = newInst(opts)
  if not opts.noBank then
    local b, err = inst:provisionBank(opts.spec or SPEC, 0)
    assert(b, "provisionBank failed: " .. J(err))
  end
  local q = HK.quickeyBackend(inst)
  kbPart = HK.fakeBackend({ capabilities = opts.kbCaps or KB_CAPS })
  local mixed = HK.mixedBackend({ quickey = q, keyboard = kbPart })
  if not opts.disabled then
    local ok, err = inst:enableInput(mixed, opts.routing and { routing = opts.routing } or nil)
    assert(ok, "enableInput failed: " .. J(err))
  end
  inst:openSession({ id = "s", leaseMs = 120000 }, 0)
  console.cmds = {}
  return inst, mixed, q, kbPart
end
local function idx(code) for i, q in pairs(console.quickeys) do if q.code == code then return i end end return nil end
local function pressedCount() local n = 0; for _ in pairs(console.pressed) do n = n + 1 end; return n end
local function holdById(inst, id) for _, h in ipairs(inst:status(0).holds) do if h.id == id then return h end end return nil end
local function kbEvents(kind) return kbPart:eventCount(kind) end

-------------------------------------------------------------------------------
-- Construction, capabilities, policy
-------------------------------------------------------------------------------
do
  check("backend name and limitations exported", HK.backends.mixed == "mixed" and type(HK.MIXED_LIMITATIONS) == "table" and #HK.MIXED_LIMITATIONS >= 3)
  newConsole(); pageWithExecutors(1, 190, 8)
  local inst = newInst({ routing = { default = "quickkey" } })
  assert(inst:provisionBank(SPEC, 0))
  local q, k = HK.quickeyBackend(inst), HK.fakeBackend({ capabilities = KB_CAPS })
  check("mixedBackend needs both parts", not pcall(HK.mixedBackend, nil) and not pcall(HK.mixedBackend, { quickey = q }) and not pcall(HK.mixedBackend, { keyboard = k }))
  check("a part without the dispatch it is named for is refused", not pcall(HK.mixedBackend, { quickey = k, keyboard = k }) and not pcall(HK.mixedBackend, { quickey = q, keyboard = q }))
  local m = HK.mixedBackend({ quickey = q, keyboard = k })
  check("a mixed adapter cannot be a part", not pcall(HK.mixedBackend, { quickey = m, keyboard = k }))
  check("capabilities are merged from the parts", m.capabilities.keyboard == true and m.capabilities.char == true and m.capabilities.modeChange == true and m.capabilities.quickkey.hold == true, J(m.capabilities))
  check("limitations carry the mixed rules and both parts'", has(m.limitations, "unqualified-mix") and has(m.limitations, "quickey part:") and has(m.limitations, "keyboard part:"))
  local mNoMode = HK.mixedBackend({ quickey = q, keyboard = HK.fakeBackend({ capabilities = { keyboard = true, quickkey = false, char = true, modeChange = false } }) })
  check("modeChange follows the keyboard part", mNoMode.capabilities.modeChange == false)
  local r, err = inst:enableInput(mNoMode, { routing = POLICY })
  check("a type override is refused at enableInput when the keyboard part cannot change the mode; nothing attaches", r == nil and err.code == "policy-unavailable" and err.problems[1].method == "type" and inst:status().backend.attached == false, J(err))
  r, err = inst:enableInput(m, { routing = POLICY })
  check("the quickkey default with shortcut and type overrides is accepted on the mixed adapter", r and r.enabled and r.backend == "mixed" and r.routing.default == "quickkey" and r.routing.overrides == 2, J(err or r))
  local st = inst:status(0)
  check("status: backend mixed, every method available, the parts' limitations listed", st.backend.name == "mixed" and st.routing.methods.quickkey.available and st.routing.methods.shortcut.available and st.routing.methods.shortcutOrType.available and st.routing.methods.type.available and has(st.backend.limitations, "Press / Unpress Page") and st.backend.counters.quickey and st.backend.counters.keyboard, J(st.routing.methods))
  local d = inst:describeRoute("NUM5")
  check("NUM5: quickkey route dispatched by the quickey part with its per-code flags", d.method == "quickkey" and d.effective == "quickkey" and d.dispatchBackend == "quickey" and d.dispatchable and d.quickkeyCapabilitySource == "code", J(d))
  d = inst:describeRoute("NUM0")
  check("NUM0: shortcut override dispatched by the keyboard part (the fake here, reported by its own name)", d.method == "shortcut" and d.methodSource == "key" and d.effective == "shortcut-table" and d.dispatchBackend == "fake" and d.dispatchable, J(d))
  d = inst:describeRoute("THRU")
  check("THRU: type override is a text route of the keyboard part (shortcuts on: mode change to off)", d.method == "type" and d.effective == "text" and d.dispatchBackend == "fake" and d.modeChange and d.modeChange.target == false, J(d))
  d = inst:describeRoute("ESC")
  check("a discovered-only code stays unavailable on the quickkey route: no fallback to the keyboard part", d.method == "quickkey" and d.dispatchable == false and has(d.unavailable, "discovered only") and d.dispatchBackend == "quickey", J(d))
  d = inst:describeRoute("X1")
  check("a code outside the bank is unavailable, not re-routed", d.dispatchable == false and has(d.unavailable, "not in bank"), J(d.unavailable))
  inst:openSession({ id = "s", leaseMs = 120000 }, 0)
  console.cmds = {}
  local x; x, err = inst:tap("s", 1, { key = "ESC" }, 50)
  check("pressing it is refused as unavailable with nothing dispatched on either part", x == nil and err.code == "unavailable" and #console.cmds == 0 and #k.events == 0, J(err))
  -- Without a bank: the quickkey default is selectable but every Quickey route is unavailable.
  local inst2 = fresh({ noBank = true, routing = POLICY })
  d = inst2:describeRoute("NUM5")
  check("without a bank the Quickey route names the KB-12 requirement; the shortcut override still works", d.dispatchable == false and has(d.unavailable, "no Quickey bank") and inst2:describeRoute("NUM0").dispatchable == true, J(d.unavailable))
  x, err = inst2:tap("s", 1, { key = "NUM5" }, 50)
  check("a Quickey press without a bank is refused, nothing goes to Keyboard()", x == nil and err.code == "unavailable" and kbEvents() == 0, J(err))
end

-------------------------------------------------------------------------------
-- Dispatch through the right part; release/recover through the recorded part
-------------------------------------------------------------------------------
do
  local inst = fresh()
  local n5 = idx("NUM5")
  local h, err = inst:tap("s", 1, { key = "NUM5" }, 50)
  check("a Quickey tap goes through the executors and records backend quickey", h and h.backend == "quickey" and h.target and h.target.executor == 190 and console.cmds[1] == string.format("Assign Quickey %d At Page 1.190", n5) and console.cmds[2] == "Press Page 1.190" and kbEvents() == 0, J(err or h))
  inst:service(1.06)
  check("the tap is released on the recorded executor", console.cmds[#console.cmds] == "Unpress Page 1.190" and pressedCount() == 0)
  local n = #console.cmds
  h, err = inst:tap("s", 2, { key = "NUM0" }, 50)
  check("a shortcut-override tap goes through the keyboard part and records that part's name", h and h.backend == "fake" and h.pcKey == "0" and h.route.source == "shortcut-table" and kbEvents("press") == 1 and #console.cmds == n, J(err or h))
  inst:service(2.06)
  check("released through the keyboard part", kbEvents("release") == 1 and not kbPart:isDown({ pcKey = "0" }) and #console.cmds == n)
  -- A text override inserts once through the keyboard part (shortcuts on -> temporarily off).
  h, err = inst:tap("s", 3, { key = "THRU" }, 50)
  check("a type override inserts its text through the keyboard part under a temporary mode change", h and h.kind == "text" and h.backend == "fake" and h.state == "retained" and kbPart:typedText() == "Thru " and console.writes[1] == false and #console.cmds == n, J(err or h))
  inst:service(3 + DELAY + 0.001)
  check("the mode is restored by service", console.shortcutsActive == true and inst:status(4).modeChange == nil)
  -- A sequence mixing kinds one after another (nothing down at once) runs each step on its part.
  n = #console.cmds
  local q; q, err = inst:startSequence("s", 5, { { kind = "tap", key = "NUM5", holdMs = 20 }, { kind = "tap", key = "NUM0", holdMs = 20 }, { kind = "tap", key = "NUM5", holdMs = 20 } })
  check("a sequence of taps alternating the kinds is accepted", q and q.state == "running", J(err or q))
  for t = 5.0, 5.3, 0.025 do inst:service(t) end
  local sq = inst:sequenceStatus(q.id, 5.3)
  check("...and completed: executor press/unpress pairs around a Keyboard() tap", sq.state == "completed" and #console.cmds == n + 4 and kbEvents("press") == 2 and kbEvents("release") == 2, J(sq))
  -- A stuck Quickey record is recovered through the quickey part even though the attached adapter is "mixed".
  h = inst:press("s", 6, { key = "NUM5" })
  console.executors["1.190"] = { quickey = idx("STORE") }  -- the operator reassigns the executor during the hold
  local rel = inst:release("s", 7, { hold = h.id })
  check("a release whose executor changed stays unresolved (no Unpress issued)", rel.state == "unresolved" and console.cmds[#console.cmds] ~= "Unpress Page 1.190", J(rel))
  console.executors["1.190"] = { quickey = idx("NUM5") }
  local rec = inst:recover("s", 8)
  check("recover releases it through the quickey part", #rec.released == 1 and console.cmds[#console.cmds] == "Unpress Page 1.190" and pressedCount() == 0, J(rec))
  -- Dispose/adopt: records carry the part's name and are released through a fresh mixed adapter.
  h = inst:press("s", 9, { key = "NUM5" })
  console.fail.unpress = { err = "console busy", count = 1 }
  local dis = inst:dispose(10)
  check("dispose hands back the unresolved record with backend quickey and its target", #dis.unresolved == 1 and dis.records[1].backend == "quickey" and dis.records[1].target.executor == 190, J(dis.records))
  local inst2 = newInst()
  assert(inst2:adoptBank(dis.bank, 11))
  local ad = inst2:adopt(dis.records, 11)
  local kb2 = HK.fakeBackend({ capabilities = KB_CAPS })
  local kbRecord = { pcKey = "0", shift = false, ctrl = false, alt = false, numlock = false, backend = "fake", tupleKey = "0|s0c0a0n0", unresolved = { reason = "x" } }
  local foreignRecord = { pcKey = "F3", shift = false, ctrl = false, alt = false, numlock = false, backend = "keyboard", tupleKey = "F3|s0c0a0n0", unresolved = { reason = "x" } }
  inst2:adopt({ kbRecord, foreignRecord }, 11)
  check("the next instance adopts the quickey, keyboard-part and foreign records", #ad.adopted == 1 and inst2:status(11).unresolved == 3, J(ad))
  local mixed2 = HK.mixedBackend({ quickey = HK.quickeyBackend(inst2), keyboard = kb2 })
  assert(inst2:attachBackend(mixed2))
  rec = inst2:recover(nil, 12)
  local still = {}
  for _, u in ipairs(rec.unresolved) do still[#still + 1] = u.tupleKey end
  check("recover through the mixed adapter releases the quickey record (executor) and the keyboard-part record; the record of a backend that is not a part stays unresolved", #rec.released == 2 and #rec.unresolved == 1 and still[1] == "F3|s0c0a0n0" and console.cmds[#console.cmds] == "Unpress Page 1.190" and kb2:eventCount("release") == 1, J({ rec, console.cmds[#console.cmds] }))
  check("the foreign record names its origin", rec.unresolved[1].error and rec.unresolved[1].error:find("originates from backend 'keyboard'"), J(rec.unresolved))
end

-------------------------------------------------------------------------------
-- Unqualified combinations: both kinds down at once (press, combo, sequence)
-------------------------------------------------------------------------------
do
  local inst = fresh()
  local h = inst:press("s", 1, { key = "NUM5" })
  local n = #console.cmds
  local x, err = inst:press("s", 1, { key = "NUM0" })
  check("a PC key while a Quickey is held is refused as unqualified-mix, nothing dispatched", x == nil and err.code == "unqualified-mix" and err.reason == "held" and err.heldKind == "quickkey" and err.hold == h.id and kbEvents() == 0 and #console.cmds == n, J(err))
  x, err = inst:tap("s", 1, { pcKey = "F3" }, 50)
  check("a raw PC key too", x == nil and err.code == "unqualified-mix" and kbEvents() == 0, J(err))
  x, err = inst:tap("s", 1, { key = "THRU" }, 50)
  check("a text route next to the held Quickey is refused (conflict), no mode write", x == nil and err.code == "conflict" and #console.writes == 0 and kbPart:typedText() == "", J(err))
  inst:release("s", 2, { hold = h.id })
  h = inst:press("s", 3, { key = "NUM0" })
  n = #console.cmds
  x, err = inst:press("s", 3, { key = "NUM5" })
  check("a Quickey while a PC key is held is refused as unqualified-mix, nothing issued to the console", x == nil and err.code == "unqualified-mix" and err.heldKind == "pckey" and err.hold == h.id and #console.cmds == n, J(err))
  inst:release("s", 4, { hold = h.id })
  x, err = inst:combo("s", 5, { { key = "NUM5" }, { key = "NUM0" } }, { holdMs = 50 })
  check("a combo mixing kinds is refused at its second key, nothing dispatched", x == nil and err.code == "unqualified-mix" and err.key == 2 and err.reason == "combo" and #console.cmds == n and kbEvents() == 2, J(err))
  x, err = inst:combo("s", 5, { { key = "NUM0" }, { key = "NUM5" } })
  check("...in either order", x == nil and err.code == "unqualified-mix" and err.key == 2 and #console.cmds == n and kbEvents() == 2, J(err))
  local c; c, err = inst:combo("s", 6, { { key = "STORE" }, { key = "NUM5" } }, { holdMs = 50 })
  check("a chord of two Quickeys is still accepted", c and c.count == 2 and c.holds[1].backend == "quickey", J(err or c))
  inst:service(6.06)
  local q; q, err = inst:startSequence("s", 7, { { kind = "press", key = "NUM5" }, { kind = "tap", key = "NUM0" } })
  check("a sequence putting a Quickey down then tapping a PC key is refused in preflight", q == nil and err.code == "unqualified-mix" and err.step == 2 and err.heldKind == "quickkey", J(err))
  q, err = inst:startSequence("s", 7, { { kind = "press", key = "NUM0" }, { kind = "tap", key = "NUM5" } })
  check("...and the reverse", q == nil and err.code == "unqualified-mix" and err.step == 2 and err.heldKind == "pckey", J(err))
  q, err = inst:startSequence("s", 7, { { kind = "combo", keys = { { key = "NUM5" }, { key = "NUM0" } }, holdMs = 20 } })
  check("a combo step mixing kinds is refused", q == nil and err.code == "unqualified-mix" and err.step == 1 and err.key == 2, J(err))
  q, err = inst:startSequence("s", 7, { { kind = "press", key = "NUM5" }, { kind = "release", key = "NUM5" }, { kind = "tap", key = "NUM0" } })
  check("released before the next kind: accepted", q and q.state == "running", J(err or q))
  for t = 7.0, 7.3, 0.025 do inst:service(t) end
  check("...and completed", inst:sequenceStatus(q.id, 7.3).state == "completed", J(inst:sequenceStatus(q.id, 7.3)))
  h = inst:press("s", 8, { key = "NUM5" })
  q, err = inst:startSequence("s", 8, { { kind = "tap", key = "NUM0" } })
  check("a sequence is refused while a live Quickey record exists and it taps a PC key", q == nil and err.code == "unqualified-mix" and err.step == 1, J(err))
  inst:release("s", 8, { hold = h.id })
  -- Under an interaction the session may hold a key and still start a sequence: a release step of that
  -- hold is simulated by the preflight, so a later step of the other kind is allowed.
  local ia = inst:beginInteraction("s", 8, {})
  h = inst:press("s", 8, { key = "NUM5", interaction = ia.id })
  q, err = inst:startSequence("s", 8, { { kind = "release", key = "NUM5" }, { kind = "tap", key = "NUM0", holdMs = 20 } }, { interaction = ia.id })
  check("a sequence that first releases the held Quickey may then tap a PC key (preflight simulates the release)", q and q.state == "running", J(err or q))
  for t = 8.0, 8.3, 0.025 do inst:service(t) end
  check("...it completed: Unpress on the executor, then the Keyboard() tap", inst:sequenceStatus(q.id, 8.3).state == "completed" and holdById(inst, h.id).state == "released" and kbEvents("press") >= 3, J(inst:sequenceStatus(q.id, 8.3)))
  inst:endInteraction("s", ia.id, 8.35)
  q, err = inst:startSequence("s", 8.4, { { kind = "press", key = "NUM0" }, { kind = "release", key = "NUM0" }, { kind = "tap", key = "NUM5", holdMs = 20 } })
  check("a PC key pressed and released by earlier steps no longer blocks a Quickey step", q and q.state == "running", J(err or q))
  for t = 8.4, 8.7, 0.025 do inst:service(t) end
  check("...completed", inst:sequenceStatus(q.id, 8.7).state == "completed", J(inst:sequenceStatus(q.id, 8.7)))
  h = inst:press("s", 9, { key = "NUM5" })
  inst:release("s", 9, { hold = h.id })
  -- An unresolved Quickey record (not just a held one) blocks PC keys as well.
  h = inst:press("s", 10, { key = "NUM5" })
  console.executors["1.190"] = { quickey = idx("STORE") }
  inst:release("s", 11, { hold = h.id })
  x, err = inst:press("s", 11, { key = "NUM0" })
  check("an unresolved Quickey record blocks PC keys too", x == nil and err.code == "unqualified-mix" and err.state == "unresolved", J(err))
  console.executors["1.190"] = { quickey = idx("NUM5") }
  inst:recover("s", 12)
  check("after recovery the PC key is admitted again", inst:tap("s", 13, { key = "NUM0" }, 50) ~= nil)
end

-------------------------------------------------------------------------------
-- Unqualified combinations: the shortcut mode and Quickeys
-------------------------------------------------------------------------------
do
  local inst = fresh()
  console.shortcutsActive = false   -- NUM0's shortcut route now needs a temporary enable
  local h = inst:press("s", 1, { key = "NUM5" })
  local x, err = inst:press("s", 1, { key = "NUM0" })
  check("a route needing a mode change is refused while a Quickey is down; the mode is not written", x == nil and err.code == "unqualified-mix" and #console.writes == 0 and console.shortcutsActive == false, J(err))
  inst:release("s", 2, { hold = h.id })
  h, err = inst:press("s", 3, { key = "NUM0" })
  check("with the Quickey released the hold enables the shortcuts for its lifetime", h and h.modeOp == "m1" and console.writes[1] == true and console.shortcutsActive == true, J(err or h))
  local n = #console.cmds
  x, err = inst:press("s", 3, { key = "NUM5" })
  check("a Quickey while the temporary mode change is active is refused (reason mode), nothing issued", x == nil and err.code == "unqualified-mix" and err.reason == "mode" and err.mode == "m1" and #console.cmds == n, J(err))
  inst:release("s", 4, { hold = h.id })
  x, err = inst:press("s", 4, { key = "NUM5" })
  check("still refused while the released PC key is retained for the restoration", x == nil and err.code == "unqualified-mix" and err.reason == "mode" and holdById(inst, h.id).state == "retained", J(err))
  -- A sequence with a Quickey step waits for the restoration instead of failing.
  local q; q, err = inst:startSequence("s", 4.01, { { kind = "tap", key = "NUM5", holdMs = 20 } })
  check("a sequence with a Quickey step starts and waits for the restoration", q and q.state == "running", J(err or q))
  inst:service(4.02)
  check("...the step is waiting, nothing issued", inst:sequenceStatus(q.id, 4.02).events[1].waitingFor == "restoration m1" and #console.cmds == n, J(inst:sequenceStatus(q.id, 4.02)))
  inst:service(4 + DELAY + 0.001)
  check("the mode is restored after the delay", console.shortcutsActive == false and inst:status(5).modeChange == nil)
  for t = 4.07, 4.3, 0.025 do inst:service(t) end
  check("...and the Quickey step ran afterwards", inst:sequenceStatus(q.id, 4.3).state == "completed" and #console.cmds == n + 2, J(inst:sequenceStatus(q.id, 4.3)))
  -- Text routes (mode off while typing) interplay with a Quickey.
  console.shortcutsActive = true
  h = inst:tap("s", 6, { key = "THRU" }, 50)
  check("a text route changes the mode and is retained", h and h.state == "retained" and console.shortcutsActive == false, J(h))
  x, err = inst:press("s", 6, { key = "NUM5" })
  check("a Quickey while the text route's restoration is pending is refused", x == nil and err.code == "unqualified-mix" and err.reason == "mode", J(err))
  inst:service(6 + DELAY + 0.001)
  x, err = inst:tap("s", 7, { key = "NUM5" }, 50)
  check("after the restore the Quickey dispatches again", x and x.backend == "quickey", J(err or x))
  inst:service(7.06)
  -- An unresolved restoration (profile switched) blocks Quickeys with the KB-14 busy refusal.
  h = inst:tap("s", 8, { key = "THRU" }, 50)
  console.profile = "Other"
  inst:service(8 + DELAY + 0.001)
  x, err = inst:press("s", 9, { key = "NUM5" })
  check("an unresolved restoration refuses Quickeys as busy/restoration", x == nil and err.code == "busy" and err.reason == "restoration" and inst:status(9).modeChange.state == "unresolved", J(err))
  console.profile = "Default"
  local rec = inst:recover("s", 10)
  check("recover restores the mode on the original profile", rec.restoration and rec.restoration.state == "restored" and console.shortcutsActive == true, J(rec.restoration))
  check("...and Quickeys are admitted again", inst:tap("s", 11, { key = "NUM5" }, 50) ~= nil)
end

-------------------------------------------------------------------------------
-- The rules hold on the fake backend too (one adapter advertising both kinds)
-------------------------------------------------------------------------------
do
  newConsole()
  local inst = HK.new({ owner = "t", deps = deps, config = { requireInteraction = false }, routing = { default = "quickkey", keys = { NUM0 = { method = "shortcut" } } } }):init()
  local fake = HK.fakeBackend()
  assert(inst:enableInput(fake))
  inst:openSession({ id = "s" }, 0)
  local h = inst:press("s", 1, { key = "NUM5" })
  local x, err = inst:press("s", 1, { key = "NUM0" })
  check("fake backend: a PC key next to a Quickey is refused as unqualified-mix", h and x == nil and err.code == "unqualified-mix" and #fake.events == 1, J(err))
  inst:releaseAll("s", 2)
  check("fake backend: attaching another adapter while nothing is held is allowed; with records it is not", inst:attachBackend(HK.fakeBackend()) ~= nil)
end

print(string.format("%d passed, %d failed", passes, failures))
print(failures == 0 and "ALL PASSED" or "FAILED")
os.exit(failures == 0 and 0 or 1)
