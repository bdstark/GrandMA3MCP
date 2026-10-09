-- Regression harness for the KB-03 owned input sessions of plugin/gma3_mcp_hardkeys.lua under stock Lua.
--
-- Everything runs against the module's FAKE backend: it dispatches nothing, records every event and
-- simulates the console's aggregate key state. Shortcut-table reads come from fake dependencies so
-- remaps, shortcut disabling and profile switches can be staged mid-hold. The clock is a plain
-- number passed to every call; nothing sleeps.
--
-- Run from the repository root:   lua test/lua/hardkeys_sessions_test.lua

local here = (arg and arg[0] or ""):match("^(.*)[/\\]") or "."
package.path = here .. "/?.lua;" .. package.path
local json = require("json")

local failures, passes = 0, 0
local function check(name, cond, detail)
  if cond then passes = passes + 1; print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end
local function J(v) return json.encode(v) end

local chunk = assert(loadfile(here .. "/../../plugin/gma3_mcp_hardkeys.lua"))
local HK = chunk("test_plugin", "gma3_mcp_hardkeys", {}, nil)

-- Fake console profile (KB-01 default shortcuts) that tests mutate mid-hold.
local VK = { PLEASE = 84, STORE = 66, ESC = 88, CLEAR = 87, OOPS = 86, EXEC = 35, NUM5 = 72 }
local profile = { name = "Default", shortcutsActive = true, rows = nil }
local function defaultRows()
  return {
    { shortcut = "Ctrl+F1", keyCode = 35, executorIndex = 101 },
    { shortcut = "S", keyCode = 66 },
    { shortcut = "5", keyCode = 72 },
    { shortcut = "Enter", keyCode = 84 },
    { shortcut = "Backspace", keyCode = 86 },
    { shortcut = "Delete", keyCode = 87 },
    { shortcut = "Escape", keyCode = 88 },
  }
end
profile.rows = defaultRows()
local deps = {
  shortcutRows = function() return profile.rows end,
  virtualKeyCodes = function() return VK end,
  shortcutsActive = function() return profile.shortcutsActive end,
  profileName = function() return profile.name end,
  displayExists = function(n) return n == 1 or n == 2 end,
}

local function fresh(config)
  local backend = HK.fakeBackend()
  local inst = HK.new({ owner = "bridge", deps = deps, config = config }):init()
  local ok = inst:enableInput(backend)
  assert(ok and ok.enabled, "enableInput failed")
  return inst, backend
end
local function lastEvent(b) return b.events[#b.events] end

-------------------------------------------------------------------------------
-- Admission: disabled by default, explicit enablement, backend without dispatch refused
-------------------------------------------------------------------------------
do
  local backend = HK.fakeBackend()
  local inst = HK.new({ owner = "bridge", deps = deps }):init()
  check("backends list the fake and the keyboard adapter", HK.backends.fake == "fake" and HK.backends.keyboard == "keyboard")
  local st = inst:status(0)
  check("new instance: input disabled, keyboard backend capability only", st.inputEnabled == false and st.backend.name == "keyboard" and st.backend.dispatches == false and st.holdCount == 0, J(st.backend))
  local s, err = inst:openSession({ id = "c1" }, 0)
  check("sessions can be opened while input is disabled (status/recovery path)", s and s.state == "active", J(err))
  local h; h, err = inst:press("c1", 0, { key = "PLEASE" })
  check("press refused while input disabled; nothing dispatched", h == nil and err.code == "input-disabled" and #backend.events == 0, J(err))
  local r; r, err = inst:enableInput({ name = "keyboard", dispatches = false, press = function() end, release = function() end })
  check("an adapter without dispatch (keyboard in this version) is refused", r == nil and err.code == "backend-no-dispatch" and err.message:find("KB%-04"), J(err))
  r, err = inst:enableInput({})
  check("a malformed adapter is refused", r == nil and err.code == "bad-adapter")
  r = inst:enableInput(backend)
  check("fake backend enabled explicitly", r.enabled == true and inst:status().inputEnabled == true and inst:status().backend.name == "fake" and inst:status().backend.dispatches == true)
  check("new/init/status/openSession/enableInput dispatched nothing", #backend.events == 0 and backend.counters.press == 0)
  check("config defaults exposed and copied", HK.DEFAULT_CONFIG.maxHolds == 8 and inst:status().config.maxHolds == 8)
  check("bad config refused", not pcall(HK.new, { owner = "x", config = { maxHolds = 0 } }) and not pcall(HK.new, { owner = "x", config = { bogus = 1 } }))
end

-------------------------------------------------------------------------------
-- Sessions and leases
-------------------------------------------------------------------------------
do
  local inst, backend = fresh()
  local s, err = inst:openSession({}, 0)
  check("openSession requires a consumer-chosen id", s == nil and err.code == "bad-session")
  s = inst:openSession({ id = "c1", label = "mcp", binding = "client-7" }, 10)
  check("session opened with default lease and binding", s.id == "c1" and s.leaseMs == 15000 and s.expiresAt == 25 and s.binding == "client-7" and s.remainingMs == 15000, J(s))
  s, err = inst:openSession({ id = "c1" }, 10)
  check("duplicate session id refused", s == nil and err.code == "session-exists")
  s, err = inst:openSession({ id = "c2", leaseMs = 10 * 60 * 1000 }, 10)
  check("lease above maxLeaseMs refused", s == nil and err.code == "bad-argument", J(err))
  s, err = inst:openSession({ id = "c2", leaseMs = 0 }, 10)
  check("non-positive lease refused", s == nil and err.code == "bad-argument")
  local h = inst:press("c1", 11, { key = "PLEASE" })
  check("press admitted on an active session", h and h.state == "held" and h.pcKey == "Enter" and backend.counters.press == 1, J(h))
  local before = backend.counters.press
  s = inst:renewSession("c1", 20, 30000)
  check("renewal moves the deadline", s.expiresAt == 50 and s.renewals == 1 and s.remainingMs == 30000, J(s))
  check("renewal injects no press", backend.counters.press == before and #backend.events == 1)
  s, err = inst:renewSession("nope", 20)
  check("renewing an unknown session fails", s == nil and err.code == "no-session")
  s, err = inst:renewSession("c1", 20, 999999)
  check("renewal cannot exceed maxLeaseMs", s == nil and err.code == "bad-argument")
  -- A session that another connection guesses cannot be used: the module has no notion of callers,
  -- the consumer binds ids to connections. Status exposes the binding so the consumer can check it.
  check("status exposes the session binding for the consumer's check", inst:status(20).sessions.c1.binding == "client-7")
end

-------------------------------------------------------------------------------
-- Press: stored tuple and route, duplicates, aliases, displays, capacity, unsupported keys
-------------------------------------------------------------------------------
do
  local inst, backend = fresh({ maxHolds = 3 })
  inst:openSession({ id = "a", leaseMs = 120000 }, 0); inst:openSession({ id = "b", leaseMs = 120000 }, 0)
  local h = inst:press("a", 1, { key = "please", display = 1 })
  check("logical press stores the resolved tuple and route", h.logical == "PLEASE" and h.pcKey == "Enter" and h.shift == false and h.display == 1
    and h.route.source == "shortcut-table" and h.route.shortcut == "Enter" and h.route.profile == "Default" and h.route.shortcutsActive == true and h.tupleKey == "Enter|s0c0a0n0", J(h))
  check("fake backend recorded exactly one press event", #backend.events == 1 and lastEvent(backend).kind == "press" and lastEvent(backend).pcKey == "Enter" and backend:isDown({ pcKey = "Enter" }))
  local d = inst:press("a", 2, { key = "PLEASE", display = 2 })
  check("duplicate press by the owner is harmless (no second event), display ignored for identity", d.duplicate == true and d.id == h.id and #backend.events == 1, J(d))
  local c, err = inst:press("b", 2, { key = "PLEASE" })
  check("another session cannot own the same logical key", c == nil and err.code == "conflict" and err.owner == "a" and #backend.events == 1, J(err))
  c, err = inst:press("b", 2, { pcKey = "Enter", display = 2 })
  check("raw alias of a held logical key on another display is rejected", c == nil and err.code == "conflict", J(err))
  local ma = inst:press("a", 3, { key = "MA" })
  check("MA is the fixed LeftShift tuple without the shift flag", ma.pcKey == "LeftShift" and ma.shift == false and ma.route.source == "fixed", J(ma))
  c, err = inst:press("b", 3, { pcKey = "LeftShift" })
  check("raw LeftShift conflicts with the MA hold", c == nil and err.code == "conflict" and err.owner == "a")
  c = inst:press("a", 3, { pcKey = "LeftShift" })
  check("owner pressing raw LeftShift gets the MA hold back as a duplicate", c.duplicate == true and c.id == ma.id and c.logical == "MA")
  c, err = inst:press("b", 3, { pcKey = "LeftShift", shift = true })
  check("a different modifier tuple is a different key", c and c.tupleKey == "LeftShift|s1c0a0n0" and backend.counters.press == 3, J(err))
  c, err = inst:press("b", 3, { pcKey = "A" })
  check("capacity exhausted is rejected before dispatch", c == nil and err.code == "capacity" and backend.counters.press == 3, J(err))
  check("status reports capacity", inst:status().capacity.used == 3 and inst:status().capacity.maxHolds == 3)
  inst:releaseAll("b", 4)
  c, err = inst:press("b", 4, { key = "MA1" })
  check("MA1 unsupported with the KB-01 reason", c == nil and err.code == "unsupported" and err.message:find("one MA state"), J(err))
  c, err = inst:press("b", 4, { key = "EXEC" })
  check("EXEC without executor unsupported", c == nil and err.code == "unsupported" and err.message:find("executor"))
  c, err = inst:press("b", 4, { key = "EXEC", executor = 101 })
  check("EXEC resolved by ExecutorIndex", c and c.pcKey == "F1" and c.ctrl == true and c.route.executor == 101, J(err))
  inst:release("b", 4, { hold = c.id })
  c, err = inst:press("b", 4, { key = "STORE", shift = true })
  check("modifiers on a logical key are rejected (they come from the mapping)", c == nil and err.code == "bad-argument")
  c, err = inst:press("b", 4, { key = "STORE", pcKey = "S" })
  check("key and pcKey together rejected", c == nil and err.code == "bad-argument")
  c, err = inst:press("b", 4, { pcKey = "S", display = 9 })
  check("non-existent display rejected", c == nil and err.code == "bad-argument" and err.message:find("display 9"))
  c, err = inst:press("b", 4, { pcKey = "S", display = "1" })
  check("display must be a number", c == nil and err.code == "bad-argument")
  c, err = inst:press("b", 4, { pcKey = "" })
  check("empty pcKey rejected", c == nil and err.code == "bad-argument")
  c, err = inst:press("b", 4, { pcKey = "S", ctrl = "yes" })
  check("non-boolean modifier rejected", c == nil and err.code == "bad-argument")
  c, err = inst:press("b", 4, "PLEASE")
  check("non-table spec rejected", c == nil and err.code == "bad-argument")
  c, err = inst:press("zz", 4, { pcKey = "S" })
  check("unknown session rejected", c == nil and err.code == "no-session")
  -- Shortcut-table keys need shortcuts active at press time; MA (fixed route) does not.
  profile.shortcutsActive = false
  c, err = inst:press("b", 5, { key = "STORE" })
  check("shortcut-table key refused while shortcuts are inactive, never toggled", c == nil and err.code == "unsupported" and err.message:find("inactive"), J(err))
  profile.shortcutsActive = true
  -- A backend key set makes unknown raw codes unsupported.
  local restricted = HK.fakeBackend({ validKeys = { Enter = true } })
  local inst2 = HK.new({ owner = "x", deps = deps }):init(); inst2:enableInput(restricted); inst2:openSession({ id = "s" }, 0)
  c, err = inst2:press("s", 0, { pcKey = "Bogus" })
  check("unsupported raw code reported by the backend's key check", c == nil and err.code == "unsupported" and err.message:find("Bogus"))
  -- Display validation without a dependency is reported as unsupported, not guessed.
  local inst3 = HK.new({ owner = "x", deps = { shortcutRows = deps.shortcutRows, virtualKeyCodes = deps.virtualKeyCodes } }):init(); inst3:enableInput(HK.fakeBackend()); inst3:openSession({ id = "s" }, 0)
  c, err = inst3:press("s", 0, { pcKey = "S", display = 1 })
  check("display given but not checkable is unsupported", c == nil and err.code == "unsupported" and err.message:find("displayExists"))
  c = inst3:press("s", 0, { pcKey = "S" })
  check("raw press without display works without display dependency", c and c.display == nil)
end

-------------------------------------------------------------------------------
-- Release: by spec, by id, ordering, harmless repeats, ownership
-------------------------------------------------------------------------------
do
  local inst, backend = fresh()
  inst:openSession({ id = "a", leaseMs = 120000 }, 0); inst:openSession({ id = "b", leaseMs = 120000 }, 0)
  local ma = inst:press("a", 1, { key = "MA" })
  local st = inst:press("a", 2, { key = "STORE" })
  local r, err = inst:release("b", 3, { hold = ma.id })
  check("another session cannot release a hold by id", r == nil and err.code == "not-owner" and backend.counters.release == 0, J(err))
  r, err = inst:release("b", 3, { key = "MA" })
  check("another session cannot release by key either", r == nil and err.code == "not-owner" and backend.counters.release == 0, J(err))
  r = inst:release("a", 3, { key = "store" })
  check("release by logical name releases the stored tuple and verifies on this backend", r.state == "released" and r.attempt.verified == true and lastEvent(backend).kind == "release" and lastEvent(backend).pcKey == "S" and not backend:isDown({ pcKey = "S" }), J(r))
  r = inst:release("a", 4, { key = "STORE" })
  check("releasing an already released key is harmless", r.alreadyReleased == true and backend.counters.release == 1, J(r))
  r = inst:release("a", 4, { hold = st.id })
  check("releasing an already released hold by id is harmless", r.alreadyReleased == true and backend.counters.release == 1)
  r, err = inst:release("a", 4, { pcKey = "Q" })
  check("releasing a key never held is reported, not dispatched", r == nil and err.code == "no-hold" and backend.counters.release == 1, J(err))
  r, err = inst:release("a", 4, { hold = "h99" })
  check("unknown hold id reported", r == nil and err.code == "no-hold")
  check("status lists the released record and the live one", inst:status(4).holdCount == 2 and inst:status(4).capacity.used == 1)
  -- Release ordering: most recent press first (modifier pressed first goes up last).
  inst:press("a", 5, { key = "STORE" })
  local n = #backend.events
  local all = inst:releaseAll("a", 6)
  check("releaseAll releases newest first", #all.released == 2 and backend.events[n + 1].pcKey == "S" and backend.events[n + 2].pcKey == "LeftShift", J(all))
  check("releaseAll is owner scoped", inst:releaseAll("b", 6).attempted == 0)
  check("after release the tuple can be owned by another session", inst:press("b", 7, { key = "MA" }) ~= nil)
  r, err = inst:releaseAll("zz", 7)
  check("releaseAll on unknown session fails", r == nil and err.code == "no-session")
end

-------------------------------------------------------------------------------
-- Route changes during a hold: remap, disable shortcuts, profile switch
-------------------------------------------------------------------------------
do
  local inst, backend = fresh()
  inst:openSession({ id = "a", leaseMs = 120000 }, 0); inst:openSession({ id = "b", leaseMs = 120000 }, 0)
  local h = inst:press("a", 1, { key = "PLEASE" })
  -- Operator remaps PLEASE from Enter to Space while it is held.
  profile.rows = { { shortcut = "Space", keyCode = 84 }, { shortcut = "S", keyCode = 66 } }
  local c, err = inst:press("a", 2, { key = "STORE" })
  check("new interaction events stop after a remap, reporting original route and mismatch",
    c == nil and err.code == "route-changed" and err.mismatches[1].hold == h.id and err.mismatches[1].original.tupleKey == "Enter|s0c0a0n0" and err.mismatches[1].mismatch:find("Space"), J(err))
  check("nothing was dispatched for the refused press", backend.counters.press == 1)
  c, err = inst:press("b", 2, { pcKey = "Space" })
  check("other sessions are blocked too while a route mismatch is unresolved", c == nil and err.code == "route-changed")
  local st = inst:status(2)
  check("status shows the mismatch on the hold", st.holds[1].routeMismatch and st.holds[1].routeMismatch.reason:find("Space") and st.holds[1].state == "held", J(st.holds[1]))
  -- Release goes out with the STORED tuple (Enter), never the re-resolved Space.
  backend:setConfirmMode(nil)  -- this backend cannot observe the effect
  local r = inst:release("a", 3, { key = "PLEASE" })
  check("release uses the stored tuple after the remap", lastEvent(backend).kind == "release" and lastEvent(backend).pcKey == "Enter", J(lastEvent(backend)))
  check("unconfirmed release after a route change stays unresolved; the record is kept", r.state == "unresolved" and r.unresolved.reason:find("route changed") and inst:status().unresolved == 1 and inst:status().capacity.used == 1, J(r))
  c, err = inst:press("b", 4, { pcKey = "Enter" })
  check("an unresolved record still blocks the tuple for others", c == nil and (err.code == "conflict" or err.code == "route-changed"), J(err))
  -- A second release attempt is explicit (recover); service() does not retry on its own.
  local sv = inst:service(5)
  check("service does not retry unresolved releases by itself", #sv.released == 0 and #sv.unresolved == 0 and inst:status().holds[1].dispatch.attempts == 1, J(sv))
  local rec = inst:recover("a", 6)
  check("recover with the route still changed and unconfirmable stays unresolved", #rec.unresolved == 1 and #rec.released == 0 and inst:status().holds[1].dispatch.attempts == 2, J(rec))
  -- Operator restores the mapping; owner-scoped recovery now resolves it.
  profile.rows = defaultRows()
  rec = inst:recover("a", 7)
  check("after the route is restored, recover releases with the stored tuple and clears the record", #rec.released == 1 and rec.released[1].verified == false and inst:status().unresolved == 0 and inst:status().holds[1].routeRestored ~= nil, J(rec))
  check("recover reports its scope", rec.scope == "a")
  backend:setConfirmMode(true)
  check("new input admitted again after resolution", inst:press("b", 8, { pcKey = "Enter" }) ~= nil)
  inst:releaseAll("b", 8)

  -- Shortcut disable during a hold.
  h = inst:press("a", 9, { key = "STORE" })
  profile.shortcutsActive = false
  c, err = inst:press("a", 10, { key = "MA" })
  check("disabling shortcuts mid-hold stops new events with an 'inactive' mismatch", c == nil and err.code == "route-changed" and err.mismatches[1].mismatch:find("inactive"), J(err))
  r = inst:release("a", 11, { key = "STORE" })
  check("release still dispatched with the stored tuple and verified by this backend", r.state == "released" and lastEvent(backend).pcKey == "S", J(r))
  profile.shortcutsActive = true
  -- Release by logical name when the key no longer resolves at all (remapped away): the stored record is found.
  h = inst:press("a", 12, { key = "CLEAR" })
  profile.rows = { { shortcut = "Enter", keyCode = 84 } }
  r = inst:release("a", 13, { key = "CLEAR" })
  check("release by name works although the key no longer resolves; stored Delete tuple used", r and r.state == "released" and lastEvent(backend).pcKey == "Delete", J(r))
  profile.rows = defaultRows()

  -- Profile switch during a hold.
  h = inst:press("a", 14, { key = "STORE" })
  profile.name = "Other"
  c, err = inst:press("a", 15, { key = "MA" })
  check("profile switch mid-hold is a route change", c == nil and err.code == "route-changed" and err.mismatches[1].mismatch:find("profile"), J(err))
  profile.name = "Default"
  inst:releaseAll("a", 16)
end

-------------------------------------------------------------------------------
-- Taps, leases and deadline servicing (no sleeps, bounded work per call)
-------------------------------------------------------------------------------
do
  local inst, backend = fresh({ maxHolds = 16, maxWorkPerService = 4 })
  inst:openSession({ id = "a", leaseMs = 1000 }, 0)
  local t, err = inst:tap("a", 0, { key = "PLEASE" }, 100)
  check("tap presses now and schedules the release", t and t.kind == "tap" and t.deadlineReason == "tap" and t.deadlineInMs == 100 and backend.counters.press == 1, J(err))
  local sv = inst:service(0.05)
  check("service before the deadline releases nothing", #sv.released == 0 and backend.counters.release == 0)
  sv = inst:service(0.1)
  check("service at the deadline releases the tap", #sv.released == 1 and sv.released[1].reason == "tap" and backend.counters.release == 1 and not backend:isDown({ pcKey = "Enter" }), J(sv))
  t, err = inst:tap("a", 0.2, { key = "PLEASE" }, 99999)
  check("tap hold above maxTapMs refused", t == nil and err.code == "bad-argument")
  inst:press("a", 0.2, { key = "MA" })
  t, err = inst:tap("a", 0.2, { key = "MA" }, 50)
  check("a tap cannot be layered on an existing hold", t == nil and err.code == "conflict")
  -- Lease expiry releases the session's holds and marks the session expired.
  inst:press("a", 0.3, { key = "STORE" })
  check("status(now) at expiry is pure: no release, session still reported active", inst:status(1.5).sessions.a.state == "active" and backend.counters.release == 1)
  sv = inst:service(1.5)
  check("lease expiry releases the session's holds (newest first) and reports the session", sv.expired[1] == "a" and #sv.released == 2 and sv.released[1].tupleKey == "S|s0c0a0n0" and sv.released[1].reason == "lease-expired" and sv.released[2].tupleKey == "LeftShift|s0c0a0n0", J(sv))
  local c; c, err = inst:press("a", 1.6, { key = "MA" })
  check("press after lease expiry refused until renewal", c == nil and err.code == "lease-expired", J(err))
  local s = inst:renewSession("a", 1.6, 1000)
  check("renewal reactivates an expired session", s.state == "active" and inst:press("a", 1.7, { key = "MA" }) ~= nil)
  -- Max-hold deadline applies to plain presses too.
  local h = inst:press("a", 2, { pcKey = "X", }, nil)
  check("press carries a max-hold deadline", h.deadlineReason == "max-hold" and h.deadlineInMs == 30000)
  inst:renewSession("a", 2, 120000)
  sv = inst:service(32.1)
  check("max-hold deadline releases a forgotten hold", #sv.released >= 1 and inst:status().holds[#inst:status().holds].state == "released", J(sv))
  inst:releaseAll("a", 33)
  -- Deadline servicing under load: 10 taps due at once, 4 release attempts per service call.
  for i = 1, 10 do assert(inst:tap("a", 40, { pcKey = "K" .. i }, 10)) end
  sv = inst:service(40.1)
  check("service is bounded per call and reports pending work", sv.work == 4 and #sv.released == 4 and sv.pending == 6, J({ sv.work, sv.pending }))
  sv = inst:service(40.2)
  check("second service continues", sv.work == 4 and sv.pending == 2)
  sv = inst:service(40.3)
  check("third service drains the queue", sv.work == 2 and sv.pending == 0 and inst:status().capacity.used == 0)
  -- A failing release at lease expiry: the record stays unresolved, the attempt is visible, no success is claimed.
  inst:renewSession("a", 41, 1000)
  inst:press("a", 41, { pcKey = "Y" })
  backend:failNext("release", { pcKey = "Y" }, "console busy", true)
  sv = inst:service(43)
  check("failed cleanup at lease expiry is reported and the record kept", #sv.unresolved == 1 and sv.unresolved[1].error:find("console busy") and inst:status().unresolved == 1 and inst:status().holds[#inst:status().holds].state == "unresolved", J(sv))
  local attempts = inst:status().holds[#inst:status().holds].dispatch.attempts
  inst:service(44); inst:service(45)
  check("later service calls do not hammer the backend with retries", inst:status().holds[#inst:status().holds].dispatch.attempts == attempts)
  check("recover while the fault persists stays unresolved", #inst:recover("a", 46).unresolved == 1)
  backend:clearFailures()
  check("recover after the fault clears releases", #inst:recover("a", 47).released == 1 and inst:status().unresolved == 0)
  check("counters are reported", inst:status().counters.presses >= 15 and inst:status().counters.releaseAttempts >= 15 and inst:status().counters.serviced >= 9)
end


-------------------------------------------------------------------------------
-- Lease enforcement by time, independent of servicing
-------------------------------------------------------------------------------
do
  local inst, backend = fresh()
  inst:openSession({ id = "a", leaseMs = 100 }, 0)
  local h = inst:press("a", 0.05, { key = "STORE" })
  check("press inside the lease admitted", h and h.state == "held")
  -- No service() ran, the lease is long gone: admission must notice on its own.
  local c, err = inst:press("a", 1, { key = "MA" })
  check("press after the lease ran out is refused even though service() never ran", c == nil and err.code == "lease-expired" and err.expiredAt == 1, J(err))
  check("the expired session's hold got its cleanup deadline", inst:status(1).holds[1].deadlineReason == "lease-expired" and inst:status(1).sessions.a.state == "expired")
  -- Renewing before any service() call must not erase the cleanup obligation of the expired lease.
  local inst2, backend2 = fresh()
  inst2:openSession({ id = "a", leaseMs = 100 }, 0)
  inst2:press("a", 0.05, { key = "STORE" })
  local s = inst2:renewSession("a", 1, 5000)
  check("renewal after a missed expiry reactivates the session", s.state == "active" and s.expiresAt == 6, J(s))
  check("...but the hold of the expired lease keeps a due deadline", inst2:status(1).holds[1].deadlineReason == "lease-expired")
  local sv = inst2:service(1.1)
  check("next service releases it and reports the expiry", sv.expired[1] == "a" and #sv.released == 1 and sv.released[1].reason == "lease-expired" and backend2.counters.release == 1, J(sv))
  check("a press under the renewed lease is admitted", inst2:press("a", 1.2, { key = "STORE" }) ~= nil)
  sv = inst2:service(1.3)
  check("the expiry is reported once", #sv.expired == 0 and #sv.released == 0)
end

-------------------------------------------------------------------------------
-- Shared console state: physical release observed, never compensated
-------------------------------------------------------------------------------
do
  local inst, backend = fresh()
  inst:openSession({ id = "a", leaseMs = 120000 }, 0)
  local h = inst:press("a", 1, { key = "MA" })
  inst:service(1.1)
  check("observed state shows the tuple down after service", inst:status().observed.down[1] == "LeftShift|s0c0a0n0" and inst:status().holds[1].observed.down == true)
  backend:physicalRelease({ pcKey = "LeftShift" })  -- the operator lets go of a physical Shift: MASTATE clears
  local presses = backend.counters.press
  inst:service(1.2); inst:service(1.3)
  local st = inst:status(1.3)
  check("a physical release is observed on the hold but ownership remains", st.holds[1].state == "held" and st.holds[1].observed.down == false and st.holds[1].observedReleasedAt == 1.2 and #st.observed.down == 0, J(st.holds[1].observed))
  check("the module never re-presses to compensate", backend.counters.press == presses and backend:eventCount("press") == 1)
  check("observed note says it is not ownership", st.observed.note:find("not ownership"))
  local r = inst:release("a", 2, { key = "MA" })
  check("the owner's release still goes out and resolves the record", r.state == "released" and lastEvent(backend).kind == "release")
  -- Observation failures are reported, not hidden.
  backend.observe = function() error("MASTATE unreadable") end
  inst:service(3)
  check("observe failure reported in status", inst:status().observed.available == false and inst:status().observed.error:find("MASTATE unreadable"))
end

-------------------------------------------------------------------------------
-- Disconnect (closeSession), disabling input, dispose and adopt
-------------------------------------------------------------------------------
do
  local inst, backend = fresh()
  inst:openSession({ id = "a", binding = "conn-1" }, 0); inst:openSession({ id = "b", leaseMs = 120000 }, 0)
  inst:press("a", 1, { key = "MA" }); inst:press("a", 2, { key = "STORE" }); inst:press("b", 3, { key = "PLEASE" })
  local n = #backend.events
  local r = inst:closeSession("a", 4, "disconnect")
  check("disconnect releases the session's holds newest first and reports them", #r.released == 2 and backend.events[n + 1].pcKey == "S" and backend.events[n + 2].pcKey == "LeftShift" and r.session == "a", J(r))
  check("closed session with nothing unresolved is forgotten; other session untouched", inst:status().sessions.a == nil and inst:status().sessions.b.holds == 1 and backend:isDown({ pcKey = "Enter" }))
  local s, err = inst:openSession({ id = "a", leaseMs = 120000 }, 5)
  check("the id can be reused once nothing is unresolved", s and s.state == "active")
  -- A disconnect whose cleanup fails keeps the session and its record visible.
  inst:press("a", 6, { pcKey = "Z" })
  backend:failNext("release", { pcKey = "Z" }, "host blocked", true)
  r = inst:closeSession("a", 7, "disconnect")
  check("failed cleanup on disconnect is reported", #r.unresolved == 1 and r.unresolved[1].error:find("host blocked"), J(r))
  local st = inst:status(7)
  check("closed session with an unresolved hold stays in status", st.sessions.a and st.sessions.a.state == "closed" and st.sessions.a.closeReason == "disconnect" and st.sessions.a.holds == 1 and st.unresolved == 1, J(st.sessions.a))
  s, err = inst:openSession({ id = "a", leaseMs = 120000 }, 8)
  check("reusing the id of a session with unresolved holds is refused", s == nil and err.code == "session-unresolved", J(err))
  local c; c, err = inst:press("b", 8, { pcKey = "Z" })
  check("the unresolved tuple is still blocked for others", c == nil and err.code == "conflict" and err.owner == "a")
  check("owner-scoped recover of a closed session is possible", #inst:recover("a", 9).unresolved == 1)
  backend:clearFailures()
  r = inst:recover(nil, 10)
  check("operator-scoped recover (all sessions) resolves it and forgets the closed session", #r.released == 1 and r.scope == "all" and inst:status().sessions.a == nil and inst:status().unresolved == 0, J(r))

  -- Disabling input: new presses rejected, holds released, releases/recovery still available.
  inst:press("b", 11, { key = "MA" })
  backend:failNext("release", { pcKey = "LeftShift" }, "stuck", true)
  r = inst:disableInput(12, "input-disabled")
  check("disableInput attempts every release and reports failures", r.enabled == false and r.attempted == 2 and #r.released == 1 and #r.unresolved == 1, J(r))
  c, err = inst:press("b", 13, { pcKey = "Q" })
  check("press refused while input is disabled", c == nil and err.code == "input-disabled")
  st = inst:status(13)
  check("status still works while disabled and shows the unresolved hold", st.inputEnabled == false and st.unresolved == 1)
  local other = HK.fakeBackend()
  r, err = inst:enableInput(other)
  check("switching to another backend while records exist is refused", r == nil and err.code == "holds-exist", J(err))
  backend:clearFailures()
  r = inst:recover("b", 14)
  check("recover works while input is disabled", #r.released == 1 and inst:status().unresolved == 0)
  r = inst:enableInput(other)
  check("backend can change once nothing is owned", r.enabled == true and inst:status().backend.name == "fake")

  -- Dispose hands unresolved records back; a new instance adopts them for operator recovery.
  inst:press("b", 15, { key = "STORE" }); inst:press("b", 15, { pcKey = "W", ctrl = true })
  other:failNext("release", { pcKey = "S" }, "console frozen", true)
  r = inst:dispose(16)
  check("dispose releases what it can and returns the unresolved records", #r.released == 1 and #r.unresolved == 1 and r.holds == 1 and r.records[1].pcKey == "S" and r.records[1].logical == "STORE" and r.records[1].route.shortcut == "S" and r.records[1].session == "b", J(r))
  check("disposed instance refuses input but still reports status", not pcall(inst.press, inst, "b", 17, { pcKey = "Q" }) and inst:status().state == "disposed" and inst:status().holdCount == 0)
  check("dispose is idempotent", inst:dispose(17).holds == 0)
  local inst2, backend2 = fresh()
  local ad = inst2:adopt(r.records, 18)
  check("adopt imports the records as unresolved holds of a closed synthetic session", #ad.adopted == 1 and ad.adopted[1].state == "unresolved" and ad.adopted[1].adopted == true and ad.adopted[1].session == "previous-run" and inst2:status().sessions["previous-run"].state == "closed", J(ad))
  check("adopt dispatches nothing", #backend2.events == 0)
  inst2:openSession({ id = "x", leaseMs = 120000 }, 18)
  c, err = inst2:press("x", 18, { key = "STORE" })
  check("an adopted record blocks the tuple", c == nil and err.code == "conflict" and err.owner == "previous-run", J(err))
  ad = inst2:adopt({ "garbage", { pcKey = "" }, { pcKey = "S" } }, 18)
  check("adopt rejects malformed and duplicate records", #ad.rejected == 3 and #ad.adopted == 0, J(ad.rejected))
  r = inst2:recover(nil, 19)
  check("operator recover releases the adopted record with its stored tuple", #r.released == 1 and lastEvent(backend2).kind == "release" and lastEvent(backend2).pcKey == "S" and inst2:status().sessions["previous-run"] == nil, J(r))
  check("tuple free again", inst2:press("x", 20, { key = "STORE" }) ~= nil)
  -- Recovery on an instance whose input was never enabled (the default after a restart) has no
  -- backend: the record must stay unresolved, not get stuck in "releasing", and a later recover
  -- with a backend must still find it.
  local inst4, backend4 = fresh(); inst4:openSession({ id = "s", leaseMs = 120000 }, 0); inst4:press("s", 0, { pcKey = "N" })
  backend4:failNext("release", { pcKey = "N" }, "wedged", true)
  local kept = inst4:dispose(1).records
  local cold = HK.new({ owner = "bridge", deps = deps }):init()
  check("adopt works with input disabled", #cold:adopt(kept, 2).adopted == 1)
  r = cold:recover(nil, 3)
  local h4 = cold:status(3).holds[1]
  check("recover without a backend leaves the record unresolved with a clear reason", #r.unresolved == 1 and r.unresolved[1].error:find("no backend") and h4.state == "unresolved" and h4.unresolved.reason:find("no backend"), J(h4))
  check("the tuple stays reserved", cold:openSession({ id = "t", leaseMs = 120000 }, 3) and select(2, cold:press("t", 3, { pcKey = "N" })).code == "input-disabled")
  cold:enableInput(HK.fakeBackend())
  check("the reserved tuple still conflicts once input is enabled", select(2, cold:press("t", 4, { pcKey = "N" })).code == "conflict")
  r = cold:recover(nil, 5)
  check("recover with a backend attached releases it", #r.released == 1 and cold:status().unresolved == 0, J(r))
  -- A record left in "releasing" (e.g. by a backend that raised mid-call in an older build) is picked up too.
  cold:press("t", 6, { pcKey = "M" })
  cold._holds[cold:status().holds[#cold:status().holds].id].state = "releasing"
  r = cold:recover("t", 7)
  check("recover also covers records stuck in releasing", #r.released == 1 and cold:status().capacity.used == 0, J(r))
  -- Dispose without a clock cannot release: records come back marked so.
  local inst3, backend3 = fresh(); inst3:openSession({ id = "s" }, 0); inst3:press("s", 0, { pcKey = "V" })
  r = inst3:dispose()
  check("dispose without now hands back the held record without claiming a release", r.holds == 1 and #r.unresolved == 0 and r.records[1].unresolved.reason:find("without a release attempt") and backend3.counters.release == 0, J(r))
end

-------------------------------------------------------------------------------
-- Backend faults on press
-------------------------------------------------------------------------------
do
  local inst, backend = fresh()
  inst:openSession({ id = "a", leaseMs = 120000 }, 0)
  backend:failNext("press", { pcKey = "S" }, "refused")
  local h, err = inst:press("a", 1, { key = "STORE" })
  check("a refused press owns nothing", h == nil and err.code == "press-failed" and inst:status().capacity.used == 0, J(err))
  backend.press = function() error("Keyboard() raised") end
  h, err = inst:press("a", 2, { key = "STORE" })
  check("a press that raises leaves an unresolved record (outcome unknown)", h == nil and err.code == "press-failed" and err.unresolved == true and inst:status().unresolved == 1 and inst:status().holds[1].unresolved.reason:find("unknown"), J(err))
  backend.press = nil  -- back to the metatable method
  local c; c, err = inst:press("a", 3, { pcKey = "S" })
  check("the unknown-outcome record blocks the tuple", c == nil and err.code == "conflict")
  local r = inst:recover("a", 4)
  check("recover releases the unknown-outcome record", #r.released == 1 and inst:status().unresolved == 0)
  backend.release = function() error("release raised") end
  inst:press("a", 5, { pcKey = "T" })
  r = inst:release("a", 6, { pcKey = "T" })
  check("a release that raises is unresolved with the error text", r.state == "unresolved" and r.unresolved.reason:find("release raised"), J(r))
  backend.release = nil
  backend:setConfirmMode(false)
  inst:recover("a", 7)
  inst:press("a", 8, { pcKey = "U" })
  r = inst:release("a", 9, { pcKey = "U" })
  check("a release the backend reports as not confirmed stays unresolved", r.state == "unresolved" and r.unresolved.reason:find("still down"), J(r))
  check("service and press need a numeric clock", not pcall(inst.service, inst) and not pcall(inst.press, inst, "a", nil, { pcKey = "Q" }))
end

print(string.format("%d passed, %d failed", passes, failures))
print(failures == 0 and "ALL PASSED" or "FAILED")
os.exit(failures == 0 and 0 or 1)
