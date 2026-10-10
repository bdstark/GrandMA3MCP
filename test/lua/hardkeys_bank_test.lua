-- Regression harness for the KB-12 Quickey bank of plugin/gma3_mcp_hardkeys.lua under stock Lua.
--
-- A fake console holds a Quickey pool and executor pages; every deps call is counted so the tests can
-- prove what was read and written (nothing is written before the preflight passes, every mutation is
-- preceded by a re-read, rollback removes only what this call created). The clock is a plain number.
--
-- Run from the repository root:   lua test/lua/hardkeys_bank_test.lua

local here = (arg and arg[0] or ""):match("^(.*)[/\\]") or "."
package.path = here .. "/?.lua;" .. package.path
local json = require("json")

local failures, passes = 0, 0
local function check(name, cond, detail)
  if cond then passes = passes + 1; print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end
local function J(v) return json.encode(v) end
local function findReason(list, needle, field)
  for _, r in ipairs(list or {}) do if tostring(r[field or "reason"]):find(needle, 1, true) then return r end end
  return nil
end

local chunk = assert(loadfile(here .. "/../../plugin/gma3_mcp_hardkeys.lua"))
local HK = chunk("test_plugin", "gma3_mcp_hardkeys", {}, nil)

-- The KB-10 enum (subset with every category represented): values 1-146 plus the zero placeholders and
-- the UNDO alias.
local VK = { [""] = 0, UNKNOWN = 0, MA1 = 1, MA2 = 2, PREV = 3, XKEYS = 15, X1 = 19, X16 = 34, EXEC = 35, FADER = 36, DEF_GO = 37,
             GO = 42, FIXTURE = 56, EDIT = 62, STORE = 66, NUM0 = 67, NUM1 = 68, NUM5 = 72, NUM9 = 76, PLUS = 77, THRU = 78,
             PLEASE = 84, FULL = 85, OOPS = 86, UNDO = 86, CLEAR = 87, ESC = 88, ENCODER_INSIDE1 = 89, FLASH = 101, RECORD = 114,
             ONPC_SCREEN2 = 127, LOCATE = 146 }

-- Fake console -------------------------------------------------------------------
local console
local function newConsole()
  console = { quickeys = {}, executors = {}, show = "disposable|Default", calls = {}, fail = {}, raise = {} }
  return console
end
local function tally(op) console.calls[op] = (console.calls[op] or 0) + 1 end
local function maybeFail(op, ...)
  local key = op
  if console.raise[key] then local e = console.raise[key]; console.raise[key] = nil; error(e, 0) end
  if console.fail[key] then
    local f = console.fail[key]
    if f.count then f.count = f.count - 1; if f.count <= 0 then console.fail[key] = nil end end
    return false, f.err
  end
  return nil
end
local function execKey(page, index) return page .. "." .. index end
local deps = {
  virtualKeyCodes = function() return VK end,
  showIdentity = function() tally("showIdentity"); return console.show end,
  quickeys = {
    read = function(index)
      tally("quickeys.read")
      local f, e = maybeFail("read"); if f == false then error(e, 0) end
      local q = console.quickeys[index]
      if not q then return nil end
      return { name = q.name, code = q.code, note = q.note, lock = q.lock, class = q.class or "Quickey" }
    end,
    create = function(index)
      tally("quickeys.create")
      local f, e = maybeFail("create"); if f == false then return false, e end
      if console.quickeys[index] then return false, "exists" end
      console.quickeys[index] = { name = "Quickey " .. index, code = "", note = "" }
      return true
    end,
    set = function(index, props)
      tally("quickeys.set")
      local q = console.quickeys[index]
      if not q then return false, "no object" end
      for k, v in pairs(props) do
        local f, e = maybeFail("set." .. k); if f == false then return false, e end
        if k == "Code" then q.code = v elseif k == "Name" then q.name = v elseif k == "Note" then q.note = v end
      end
      return true
    end,
    delete = function(index)
      tally("quickeys.delete")
      local f, e = maybeFail("delete"); if f == false then return false, e end
      console.quickeys[index] = nil
      return true
    end,
  },
  executors = {
    read = function(page, index)
      tally("executors.read")
      local x = console.executors[execKey(page, index)]
      if x == nil then return { exists = false } end
      if x == "empty" then return { exists = true, class = "Executor", empty = true } end
      return { exists = true, class = "Executor", empty = false, object = { class = x.class, name = x.name } }
    end,
    clear = function(page, index)
      tally("executors.clear")
      local f, e = maybeFail("clear"); if f == false then return false, e end
      console.executors[execKey(page, index)] = "empty"
      return true
    end,
  },
}
local function pageWithExecutors(page, first, count)
  for i = 0, count - 1 do console.executors[execKey(page, first + i)] = "empty" end
end
local function fresh(opts)
  opts = opts or {}
  newConsole()
  pageWithExecutors(1, 190, 8)
  local inst = HK.new({ owner = opts.owner or "bridge", deps = deps, config = { requireInteraction = false } }):init()
  if not opts.noBackend then inst:enableInput(HK.fakeBackend()) end
  inst:openSession({ id = "s" }, 0)
  return inst
end
local SPEC = { authorized = true, quickeys = { first = 900 }, executors = { page = 1, first = 190, count = 8 } }
local function spec(over)
  local s = { authorized = true, quickeys = { first = 900 }, executors = { page = 1, first = 190, count = 8 } }
  for k, v in pairs(over or {}) do s[k] = v end
  return s
end
local function countQuickeys() local n = 0; for _ in pairs(console.quickeys) do n = n + 1 end; return n end

-------------------------------------------------------------------------------
-- Spec validation and authorization
-------------------------------------------------------------------------------
do
  local inst = fresh()
  local r, err = inst:provisionBank({ quickeys = { first = 900 }, executors = { page = 1, first = 190 } }, 1)
  check("provisioning without authorized=true is refused before anything is read", r == nil and err.code == "bank-unauthorized" and (console.calls["quickeys.read"] or 0) == 0, J(err))
  r, err = inst:provisionBank(spec({ quickeys = { first = 0 } }), 1)
  check("quickeys.first must be a positive integer", r == nil and err.code == "bank-invalid" and err.message:find("quickeys.first"), J(err))
  r, err = inst:provisionBank(spec({ executors = { page = 1, first = 190, count = 3 } }), 1)
  check("executor count below maxHolds is refused", r == nil and err.code == "bank-invalid" and err.message:find("maxHolds"), J(err))
  r, err = inst:provisionBank({ authorized = true, quickeys = { first = 900 } }, 1)
  check("executors range is required", r == nil and err.code == "bank-invalid" and err.message:find("executors ="), J(err))
  r, err = inst:provisionBank(spec({ codes = "everything" }), 1)
  check("unknown codes selection refused", r == nil and err.code == "bank-invalid", J(err))
  r, err = inst:provisionBank(spec({ codes = { "NUM5", "BOGUS" } }), 1)
  check("unknown code name refused", r == nil and err.code == "bank-invalid" and err.message:find("BOGUS"), J(err))
  r, err = inst:provisionBank(spec({ codes = { "UNDO" } }), 1)
  check("an alias in the list must be named by its canonical code", r == nil and err.message:find("alias of OOPS"), J(err))
  r, err = inst:provisionBank(spec({ codes = { "X1" } }), 1)
  check("an excluded code cannot be forced into a bank", r == nil and err.message:find("excluded"), J(err))
  r, err = inst:provisionBank(spec({ extra = 1 }), 1)
  check("unknown spec field refused", r == nil and err.code == "bank-invalid", J(err))
  check("nothing was created by refused specs", countQuickeys() == 0 and (console.calls["quickeys.create"] or 0) == 0)
  local v = HK.validateBankSpec(spec({ executors = { page = 1, first = 190 } }), HK.DEFAULT_CONFIG)
  check("executors.count defaults to maxHolds", v and v.executors.count == HK.DEFAULT_CONFIG.maxHolds, J(v))
end

-------------------------------------------------------------------------------
-- Discovery: dedup, exclusions, qualification, selection
-------------------------------------------------------------------------------
do
  local d = HK.discoverBankCodes(VK, "hardkeys")
  local names = {}
  for _, c in ipairs(d.codes) do names[c.name] = c end
  check("aliases fold onto the canonical code", names.OOPS and not names.UNDO and d.aliases[1].alias == "UNDO" and d.aliases[1].canonical == "OOPS", J(d.aliases))
  check("zero placeholders, X-keys, encoders, screens, EXEC/FADER/DEF_ and executor functions are excluded with reasons",
    not names[""] and not names.UNKNOWN and not names.X1 and not names.XKEYS and not names.ENCODER_INSIDE1 and not names.ONPC_SCREEN2 and not names.EXEC and not names.FADER and not names.DEF_GO and not names.FLASH and not names.RECORD
    and findReason(d.exclusions, "X-key") and findReason(d.exclusions, "executor button function") and findReason(d.exclusions, "value 0"), J(d.exclusions))
  check("command-area codes are kept, MA1/MA2 included", names.MA1 and names.MA2 and names.GO and names.LOCATE and names.NUM0 and names.FULL, J(names))
  check("codes are ordered by value and carry KB-10 qualification", d.codes[1].name == "MA1" and names.NUM5.qualified.hold == true and names.MA1.qualified.tap == false and names.OOPS.qualified.hold == false and names.GO.qualified == false and names.ESC.qualified == false and names.ESC.note:find("never touched"), J({ names.NUM5, names.ESC }))
  local q = HK.discoverBankCodes(VK, "qualified")
  check("\"qualified\" keeps only codes with evidence and reports the rest as exclusions", #q.codes == 9 and findReason(q.exclusions, "no KB-10 evidence") and findReason(q.exclusions, "no KB-10 evidence").name ~= nil, J(q.codes))
  local l = HK.discoverBankCodes(VK, { "NUM5", "THRU", "PLEASE" })
  check("an explicit list provisions exactly those codes", #l.codes == 3 and l.codes[1].name == "NUM5" and l.codes[2].name == "THRU", J(l.codes))
  local m = HK.parseBankMarker(HK.bankMarkerText("bridge", "bridge@q900.e1.190-197", "NUM5", { page = 1, first = 190, count = 8 }))
  check("marker round-trips", m and m.owner == "bridge" and m.bank == "bridge@q900.e1.190-197" and m.code == "NUM5" and m.execPage == 1 and m.execFirst == 190 and m.execLast == 197 and m.version == 1, J(m))
  check("a label is not a marker", HK.parseBankMarker("MCP NUM5") == nil and HK.parseBankMarker("gma3_mcp_hardkeys-bank v1 owner=x") == nil)
end

-------------------------------------------------------------------------------
-- Provisioning: preflight refusals leave the console untouched
-------------------------------------------------------------------------------
do
  local inst = fresh()
  console.quickeys[903] = { name = "Operator thing", code = "GO", note = "" }
  local r, err = inst:provisionBank(spec(), 1)
  check("an unowned object in the range refuses the whole bank", r == nil and err.code == "bank-preflight" and findReason(err.refusals, "slot-occupied") and findReason(err.refusals, "slot-occupied").index == 903, J(err.refusals))
  check("nothing created on a preflight refusal", countQuickeys() == 1 and (console.calls["quickeys.create"] or 0) == 0 and (console.calls["quickeys.set"] or 0) == 0 and inst:bankStatus().provisioned == false)
  console.quickeys[903] = nil
  console.quickeys[905] = { name = "MCP STORE", code = "STORE", note = HK.bankMarkerText("other_plugin", "other_plugin@q900.e1.190-197", "STORE", { page = 1, first = 190, count = 8 }) }
  r, err = inst:provisionBank(spec(), 1)
  check("another owner's bank on the slots is refused (no shared arbitration)", r == nil and findReason(err.refusals, "bank-foreign-owner"), J(err.refusals))
  console.quickeys[905] = nil
  console.executors[execKey(1, 193)] = { class = "Sequence", name = "Main" }
  r, err = inst:provisionBank(spec(), 1)
  check("an occupied executor refuses the reservation", r == nil and findReason(err.refusals, "executor-occupied") and findReason(err.refusals, "executor-occupied").executor == "1.193", J(err.refusals))
  console.executors[execKey(1, 193)] = nil
  r, err = inst:provisionBank(spec(), 1)
  check("a missing executor refuses the reservation", r == nil and findReason(err.refusals, "executor-missing"), J(err.refusals))
  console.executors[execKey(1, 193)] = "empty"
  console.raise.read = "console busy"
  r, err = inst:provisionBank(spec(), 1)
  check("a raising read is a refusal, not a guess", r == nil and findReason(err.refusals, "unreadable"), J(err.refusals))
  console.show = nil
  r, err = inst:provisionBank(spec(), 1)
  check("an unreadable show identity refuses provisioning", r == nil and err.code == "unreadable" and err.message:find("show identity"), J(err))
  console.show = "disposable|Default"
  check("still nothing created", countQuickeys() == 0)
end

-------------------------------------------------------------------------------
-- Provisioning: creation, verification by readback, reuse
-------------------------------------------------------------------------------
do
  local inst = fresh()
  local before = console.calls["quickeys.read"] or 0
  local r, err = inst:provisionBank(spec(), 1)
  check("the bank is created", r and r.provisioned and r.state == "ready" and r.created == r.codeCount and r.reused == 0 and r.id == "bridge@q900.e1.190-197", J(err or r))
  local q = console.quickeys[900]
  check("slot = first + rank by value: MA1 at 900 with marker, code and name", q and q.code == "MA1" and q.name == "MCP MA1" and HK.parseBankMarker(q.note).code == "MA1" and HK.parseBankMarker(q.note).owner == "bridge", J(q))
  local e5
  for _, c in ipairs(r.codes) do if c.name == "NUM5" then e5 = c end end
  check("each code reports its slot and qualification", e5 and console.quickeys[e5.index].code == "NUM5" and e5.qualified.hold == true and e5.created == true and e5.state == "ok", J(e5))
  check("every slot was re-read before creation and after the writes", (console.calls["quickeys.read"] or 0) - before >= 3 * r.codeCount and console.calls["quickeys.create"] == r.codeCount)
  check("executors reserved, none assigned", #r.executors == 8 and r.executors[1].state == "reserved" and r.executors[1].page == 1 and r.executors[8].index == 197, J(r.executors))
  check("exclusions and aliases reported with the bank", #r.exclusions > 0 and r.aliases[1].alias == "UNDO" and r.enumEntries > 0)
  check("qualified and discovered counts", r.qualifiedCount == 9 and r.discoveredCount == r.codeCount - 9 and r.problemCount == 0, J({ r.qualifiedCount, r.discoveredCount }))
  local st = inst:status(1)
  check("status carries the bank summary and a record for adoption", st.bank.provisioned and st.bank.id == r.id and st.bank.record.codes[1].name == "MA1" and st.bank.record.spec.executors.count == 8, J(st.bank.record.spec))
  local r2, err2 = inst:provisionBank(spec(), 2)
  check("a second provisioning on the same instance is refused", r2 == nil and err2.code == "bank-exists", J(err2))
  -- Reuse: a new instance (restart without a record) finds its own bank and verifies it instead of creating.
  local inst2 = HK.new({ owner = "bridge", deps = deps, config = { requireInteraction = false } }):init()
  local creates = console.calls["quickeys.create"]
  local r3, err3 = inst2:provisionBank(spec(), 3)
  check("the same owner and spec reuse the bank after verification, creating nothing", r3 and r3.reused == r3.codeCount and r3.created == 0 and console.calls["quickeys.create"] == creates, J(err3 or r3))
  -- A different spec on the same slots is a mismatch, never a merge.
  local inst3 = HK.new({ owner = "bridge", deps = deps, config = { requireInteraction = false } }):init()
  local r4, err4 = inst3:provisionBank(spec({ executors = { page = 2, first = 190, count = 8 } }), 4)
  check("another bank id of the same owner on the slots is refused", r4 == nil and findReason(err4.refusals, "bank-mismatch") and findReason(err4.refusals, "bank-mismatch").detail:find("another bank"), J(err4 and err4.refusals))
  -- An operator edit on an owned object refuses reuse and is not repaired.
  console.quickeys[900].code = "MA2"
  local inst4 = HK.new({ owner = "bridge", deps = deps, config = { requireInteraction = false } }):init()
  local r5, err5 = inst4:provisionBank(spec(), 5)
  check("a modified owned Quickey refuses reuse (not repaired)", r5 == nil and findReason(err5.refusals, "bank-mismatch").detail:find("Code is MA2") and console.quickeys[900].code == "MA2", J(err5 and err5.refusals))
  console.quickeys[900].code = "MA1"
  -- Executors already holding a bank Quickey are reused as "assigned".
  console.executors[execKey(1, 190)] = { class = "Quickey", name = "MCP NUM5" }
  local inst5 = HK.new({ owner = "bridge", deps = deps, config = { requireInteraction = false } }):init()
  local r6 = inst5:provisionBank(spec(), 6)
  check("an executor holding a bank Quickey is reused as assigned", r6 and r6.executors[1].state == "assigned" and r6.executors[1].assigned == "NUM5", J(r6 and r6.executors[1]))
  console.executors[execKey(1, 190)] = "empty"
  -- An explicit list and the qualified selection.
  newConsole(); pageWithExecutors(1, 190, 8)
  local inst6 = HK.new({ owner = "bridge", deps = deps, config = { requireInteraction = false } }):init()
  local r7 = inst6:provisionBank(spec({ codes = "qualified" }), 7)
  check("codes=qualified provisions the nine evidenced codes", r7 and r7.codeCount == 9 and r7.discoveredCount == 0 and console.quickeys[908] ~= nil and console.quickeys[909] == nil, J(r7 and r7.codeCount))
end

-------------------------------------------------------------------------------
-- Partial failure: rollback removes only what this call created and still owns
-------------------------------------------------------------------------------
do
  local inst = fresh()
  console.fail.create = { err = "pool full (fake)", count = 1 }
  -- make the 4th create fail: let three succeed first
  console.fail.create = nil
  local n = 0
  local origCreate = deps.quickeys.create
  deps.quickeys.create = function(index)
    n = n + 1
    if n == 4 then return false, "pool full (fake)" end
    return origCreate(index)
  end
  local r, err = inst:provisionBank(spec(), 1)
  deps.quickeys.create = origCreate
  check("a failed create stops provisioning with bank-partial", r == nil and err.code == "bank-partial" and err.failed.error:find("pool full"), J(err and err.message))
  check("the three created objects were rolled back, nothing kept", #err.removed == 3 and #err.kept == 0 and countQuickeys() == 0 and inst:bankStatus().provisioned == false, J({ err.removed, err.kept, countQuickeys() }))
  -- A set failure after Note was written: the object reads back as ours and is removed.
  newConsole(); pageWithExecutors(1, 190, 8)
  console.fail["set.Code"] = { err = "property locked (fake)", count = 1 }
  r, err = inst:provisionBank(spec(), 2)
  check("a failed property write rolls back the half-written object", r == nil and err.code == "bank-partial" and err.failed.error:find("set Code") and #err.removed == 1 and countQuickeys() == 0, J(err and { err.failed, err.removed, err.kept }))
  -- An object changed by someone else between our writes and the rollback is kept, not deleted.
  newConsole(); pageWithExecutors(1, 190, 8)
  local origSet = deps.quickeys.set
  local sets = 0
  deps.quickeys.set = function(index, props)
    sets = sets + 1
    if props.Name and index == 901 then
      console.quickeys[900].note = "operator wrote here"   -- the first created object is no longer ours
      return false, "name refused (fake)"
    end
    return origSet(index, props)
  end
  r, err = inst:provisionBank(spec(), 3)
  deps.quickeys.set = origSet
  check("an object that no longer reads back as written is kept and reported", r == nil and err.code == "bank-partial" and #err.kept == 1 and err.kept[1].index == 900 and err.kept[1].reason:find("kept") and console.quickeys[900] ~= nil and console.quickeys[901] == nil, J(err and { err.kept, err.removed }))
  -- A slot that becomes occupied between preflight and creation is a failure, not an overwrite.
  newConsole(); pageWithExecutors(1, 190, 8)
  local origRead = deps.quickeys.read
  local reads = 0
  deps.quickeys.read = function(index)
    reads = reads + 1
    if index == 902 and console.quickeys[902] == nil and console.quickeys[901] ~= nil then
      console.quickeys[902] = { name = "Racer", code = "GO", note = "" }
    end
    return origRead(index)
  end
  r, err = inst:provisionBank(spec(), 4)
  deps.quickeys.read = origRead
  check("a slot occupied at the recheck is never overwritten", r == nil and err.code == "bank-partial" and err.failed.index == 902 and err.failed.error:find("recheck") and console.quickeys[902].name == "Racer" and console.quickeys[900] == nil, J(err and err.failed))
end

-------------------------------------------------------------------------------
-- Verification, dispatch-time target checks, staleness
-------------------------------------------------------------------------------
do
  local inst = fresh()
  local r = inst:provisionBank(spec(), 1)
  local t, err = inst:bankTarget("NUM5", 2)
  check("bankTarget re-reads and returns the owned Quickey", t and t.index == console and false or (t and console.quickeys[t.index].code == "NUM5" and t.value == 72 and t.qualified.hold == true and t.executors.first == 190), J(err or t))
  t = inst:bankTarget("undo", 2)
  check("an alias resolves to the canonical bank entry", t and t.name == "OOPS" and t.alias == "UNDO", J(t))
  t, err = inst:bankTarget("X1", 2)
  check("a code outside the bank is refused", t == nil and err.code == "code-not-in-bank", J(err))
  local idx5 = inst:bankTarget("NUM5", 2).index
  console.quickeys[idx5].code = "NUM6"
  t, err = inst:bankTarget("NUM5", 3)
  check("a modified Quickey refuses dispatch and is not repaired", t == nil and err.code == "bank-object-changed" and console.quickeys[idx5].code == "NUM6" and inst:bankStatus().state == "degraded", J(err))
  console.quickeys[idx5].code = "NUM5"
  t = inst:bankTarget("NUM5", 4)
  local v = inst:verifyBank(4)
  check("restoring the object and verifying brings the bank back to ready", t and v.state == "ready" and v.problemCount == 0, J(v and v.problems))
  console.quickeys[idx5] = nil
  t, err = inst:bankTarget("NUM5", 5)
  check("a deleted Quickey refuses dispatch", t == nil and err.code == "bank-object-missing", J(err))
  v = inst:verifyBank(5)
  check("verifyBank reports the missing object", v.state == "degraded" and v.problemCount == 1 and v.problems[1].kind == "quickey" and v.problems[1].state == "missing", J(v.problems))
  console.quickeys[idx5] = { name = "Something", code = "GO", note = "" }
  v = inst:verifyBank(6)
  check("a replaced object is reported as replaced", v.problems[1].state == "replaced", J(v.problems))
  console.quickeys[idx5] = { name = "MCP NUM5", code = "NUM5", note = HK.bankMarkerText("bridge", r.id, "NUM5", { page = 1, first = 190, count = 8 }) }
  console.executors[execKey(1, 191)] = { class = "Sequence", name = "Main" }
  v = inst:verifyBank(7)
  check("an executor taken by someone else degrades the bank", v.state == "degraded" and v.problems[1].kind == "executor" and v.problems[1].executor == "1.191", J(v.problems))
  local x, xerr = inst:bankExecutor(191, 7)
  check("bankExecutor refuses the occupied executor", x == nil and xerr.code == "bank-executor-occupied", J(xerr))
  x = inst:bankExecutor(190, 7)
  check("bankExecutor returns a reserved empty executor", x and x.state == "reserved" and x.page == 1, J(x))
  console.executors[execKey(1, 191)] = "empty"
  v = inst:verifyBank(8)
  check("ready again once restored", v.state == "ready", J(v.problems))
  -- Staleness: a show change seen by service() marks the bank stale; dispatch refuses until verified.
  local s = inst:service(8.1)
  check("service() does not re-read the show identity within bankCheckMs", s.bank and s.bank.state == "ready" and (console.calls.showIdentity or 0) < 20)
  console.show = "other show|Default"
  s = inst:service(11)
  check("service() marks the bank stale on a show change", s.bank.state == "stale" and inst:bankStatus().staleReason:find("other show"), J(s.bank))
  t, err = inst:bankTarget("NUM5", 11)
  check("a stale bank refuses dispatch", t == nil and err.code == "bank-stale", J(err))
  v = inst:verifyBank(12)
  check("verifyBank against the new show reports it", v.state == "degraded" and v.problems[1].kind == "show", J(v.problems))
  console.show = "disposable|Default"
  v = inst:verifyBank(13)
  check("back on the original show the bank is ready", v.state == "ready" and inst:bankTarget("NUM5", 13) ~= nil, J(v.problems))
end

-------------------------------------------------------------------------------
-- Teardown: separate from release-all, only verified owned objects
-------------------------------------------------------------------------------
do
  local inst = fresh()
  inst:configureRouting({ default = "quickkey" })
  local r = inst:provisionBank(spec(), 1)
  local td, err = inst:teardownBank(2, {})
  check("teardown needs authorization", td == nil and err.code == "bank-unauthorized", J(err))
  local ia = inst:beginInteraction("s", 2)
  local h = inst:press("s", 2, { key = "NUM5", interaction = ia.id })
  td, err = inst:teardownBank(3, { authorized = true })
  check("teardown is refused while a Quickey record is live", h and td == nil and err.code == "bank-in-use" and countQuickeys() == r.codeCount, J(err))
  inst:releaseAll("s", 4, "test")
  console.quickeys[900].name = "Operator renamed"             -- owned but changed: skipped
  console.quickeys[901] = { name = "Operator thing", code = "GO", note = "" }  -- replaced: skipped
  console.executors[execKey(1, 190)] = { class = "Quickey", name = "MCP STORE" }   -- ours: cleared
  console.executors[execKey(1, 191)] = { class = "Sequence", name = "Main" }       -- not ours: left alone
  td, err = inst:teardownBank(5, { authorized = true })
  check("teardown removes verified objects, skips changed/replaced ones, clears only our executors",
    td and td.complete == false and #td.removed == r.codeCount - 2 and #td.skipped == 3 and #td.cleared == 1 and td.cleared[1].hadCode == "STORE"
    and console.quickeys[900].name == "Operator renamed" and console.quickeys[901].name == "Operator thing" and console.executors[execKey(1, 190)] == "empty" and console.executors[execKey(1, 191)].name == "Main"
    and countQuickeys() == 2, J(err or { td.removed and #td.removed, td.skipped, td.cleared }))
  check("a partial teardown keeps a partial bank listing the remaining objects", inst:bankStatus().state == "partial" and inst:bankStatus().codeCount == 2, J(inst:bankStatus().codes))
  console.quickeys[900].name = "MCP MA1"
  console.quickeys[901] = nil
  td = inst:teardownBank(6, { authorized = true })
  check("the second teardown finishes and the instance has no bank", td and td.complete and inst:bankStatus().provisioned == false and countQuickeys() == 0, J(td))
  td, err = inst:teardownBank(7, { authorized = true })
  check("teardown without a bank is no-bank", td == nil and err.code == "no-bank")
end

-------------------------------------------------------------------------------
-- Dispose hands the record back; adoptBank verifies before trusting it
-------------------------------------------------------------------------------
do
  local inst = fresh()
  local r = inst:provisionBank(spec({ label = "main" }), 1)
  local dis = inst:dispose(2)
  check("dispose returns the bank record and touches no object", dis.bank and dis.bank.id == r.id and #dis.bank.codes == r.codeCount and dis.bank.spec.label == "main" and countQuickeys() == r.codeCount and (console.calls["quickeys.delete"] or 0) == 0, J(dis.bank and dis.bank.spec))
  local inst2 = HK.new({ owner = "bridge", deps = deps, config = { requireInteraction = false } }):init()
  local creates = console.calls["quickeys.create"]
  local a, err = inst2:adoptBank(dis.bank, 3)
  check("adoptBank verifies and reuses the objects without creating", a and a.adopted and a.state == "ready" and a.codeCount == r.codeCount and console.calls["quickeys.create"] == creates, J(err or a.problems))
  check("adopted bank serves targets", inst2:bankTarget("STORE", 3) ~= nil)
  local inst3 = HK.new({ owner = "surface", deps = deps, config = { requireInteraction = false } }):init()
  a, err = inst3:adoptBank(dis.bank, 4)
  check("a record of another owner is not adopted", a == nil and err.code == "bank-foreign-owner", J(err))
  console.quickeys[900].note = ""
  local inst4 = HK.new({ owner = "bridge", deps = deps, config = { requireInteraction = false } }):init()
  a, err = inst4:adoptBank(dis.bank, 5)
  check("adoption of a record whose object lost its marker is degraded, not repaired", a and a.state == "degraded" and a.problems[1].index == 900 and a.problems[1].state == "replaced" and console.quickeys[900].note == "", J(err or a.problems))
  local t, terr = inst4:bankTarget("MA1", 5)
  check("the degraded entry refuses dispatch", t == nil and terr.code == "bank-object-changed", J(terr))
  -- adopt() of hold records: Quickey records are accepted since 0.7.0 (they have no pcKey).
  local inst5 = HK.new({ owner = "bridge", deps = deps, config = { requireInteraction = false } }):init()
  local ad = inst5:adopt({ { quickkey = "NUM5", quickkeyCode = 72, tupleKey = "quickkey:#72", backend = "fake", logical = "NUM5", unresolved = { reason = "test" } } }, 6)
  check("adopt() accepts an unresolved Quickey record", #ad.adopted == 1 and ad.adopted[1].tupleKey == "quickkey:#72" and ad.adopted[1].state == "unresolved", J(ad))
end

-------------------------------------------------------------------------------
-- Missing deps and disposed instances
-------------------------------------------------------------------------------
do
  newConsole()
  local inst = HK.new({ owner = "bridge", deps = { virtualKeyCodes = function() return VK end }, config = { requireInteraction = false } }):init()
  local r, err = inst:provisionBank(spec(), 1)
  check("missing console deps are reported, not guessed", r == nil and err.code == "unavailable" and err.message:find("quickeys.read"), J(err))
  check("bankStatus without a bank", inst:bankStatus().provisioned == false)
  local v, verr = inst:verifyBank(1)
  check("verifyBank without a bank", v == nil and verr.code == "no-bank")
  inst:dispose(2)
  check("bank calls on a disposed instance raise", not pcall(function() inst:provisionBank(spec(), 3) end))
end

print(string.format("\n%d passed, %d failed", passes, failures))
os.exit(failures == 0 and 0 or 1)
