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

-- The KB-03/KB-04 sections exercise per-session ownership, routes and recovery with the KB-05 interaction
-- admission switched off (config.requireInteraction = false, the policy a single-caller consumer such as a
-- surface plugin uses); the KB-05 sections below use the bridge's default (true).
local function legacyNew(opts)
  local config = { requireInteraction = false }
  for k, v in pairs(opts.config or {}) do config[k] = v end
  opts.config = config
  return HK.new(opts)
end

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
  local inst = legacyNew({ owner = "bridge", deps = deps, config = config }):init()
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
  local inst = legacyNew({ owner = "bridge", deps = deps }):init()
  check("backends list the fake and the keyboard adapter", HK.backends.fake == "fake" and HK.backends.keyboard == "keyboard")
  local st = inst:status(0)
  check("new instance: input disabled, keyboard backend capability only", st.inputEnabled == false and st.backend.name == "keyboard" and st.backend.dispatches == false and st.holdCount == 0, J(st.backend))
  local s, err = inst:openSession({ id = "c1" }, 0)
  check("sessions can be opened while input is disabled (status/recovery path)", s and s.state == "active", J(err))
  local h; h, err = inst:press("c1", 0, { key = "PLEASE" })
  check("press refused while input disabled; nothing dispatched", h == nil and err.code == "input-disabled" and #backend.events == 0, J(err))
  local r; r, err = inst:enableInput({ name = "keyboard", dispatches = false, press = function() end, release = function() end })
  check("an adapter without dispatch is refused", r == nil and err.code == "backend-no-dispatch", J(err))
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
  check("logical press stores the resolved tuple and route (PLEASE: native Enter route)", h.logical == "PLEASE" and h.pcKey == "Enter" and h.shift == false and h.display == 1
    and h.route.source == "native" and h.route.shortcut == nil and h.route.profile == "Default" and h.route.shortcutsActive == true and h.tupleKey == "Enter|s0c0a0n0" and h.backend == "fake", J(h))
  check("press report spells out the outcomes", h.pressOutcome == "confirmed" and h.releaseOutcome == "scheduled" and h.dispatch.press.outcome == "confirmed", J(h))
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
  local inst2 = legacyNew({ owner = "x", deps = deps }):init(); inst2:enableInput(restricted); inst2:openSession({ id = "s" }, 0)
  c, err = inst2:press("s", 0, { pcKey = "Bogus" })
  check("unsupported raw code reported by the backend's key check", c == nil and err.code == "unsupported" and err.message:find("Bogus"))
  -- Display validation without a dependency is reported as unsupported, not guessed.
  local inst3 = legacyNew({ owner = "x", deps = { shortcutRows = deps.shortcutRows, virtualKeyCodes = deps.virtualKeyCodes } }):init(); inst3:enableInput(HK.fakeBackend()); inst3:openSession({ id = "s" }, 0)
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
  local h = inst:press("a", 1, { key = "STORE" })
  -- Operator remaps STORE from S to T while it is held.
  profile.rows = { { shortcut = "Enter", keyCode = 84 }, { shortcut = "T", keyCode = 66 } }
  local c, err = inst:press("a", 2, { key = "PLEASE" })
  check("new interaction events stop after a remap, reporting original route and mismatch",
    c == nil and err.code == "route-changed" and err.mismatches[1].hold == h.id and err.mismatches[1].original.tupleKey == "S|s0c0a0n0" and err.mismatches[1].mismatch:find("T|s0c0a0n0"), J(err))
  check("nothing was dispatched for the refused press", backend.counters.press == 1)
  c, err = inst:press("b", 2, { pcKey = "T" })
  check("other sessions are blocked too while a route mismatch is unresolved", c == nil and err.code == "route-changed")
  local st = inst:status(2)
  check("status shows the mismatch on the hold", st.holds[1].routeMismatch and st.holds[1].routeMismatch.reason:find("T|s0c0a0n0") and st.holds[1].state == "held", J(st.holds[1]))
  -- Release goes out with the STORED tuple (S), never the re-resolved T.
  backend:setConfirmMode(nil)  -- this backend cannot observe the effect
  local r = inst:release("a", 3, { key = "STORE" })
  check("release uses the stored tuple after the remap", lastEvent(backend).kind == "release" and lastEvent(backend).pcKey == "S", J(lastEvent(backend)))
  check("unconfirmed release after a route change stays unresolved; the record is kept", r.state == "unresolved" and r.unresolved.reason:find("route changed") and r.releaseOutcome == "unresolved" and inst:status().unresolved == 1 and inst:status().capacity.used == 1, J(r))
  c, err = inst:press("b", 4, { pcKey = "S" })
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
  check("new input admitted again after resolution", inst:press("b", 8, { pcKey = "S" }) ~= nil)
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
  local cold = legacyNew({ owner = "bridge", deps = deps }):init()
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

-------------------------------------------------------------------------------
-- KB-04: the Keyboard() adapter over stubbed console deps
-------------------------------------------------------------------------------
-- The stub records every Keyboard() call, can raise on demand, and exposes a mutable aggregate MASTATE
-- the way Root():Get("MAState") does. Nothing here infers per-key state from it.
local kb = { calls = {}, raise = nil, ma = false, codes = { Enter = 257, Escape = 256, S = 83, T = 84, F1 = 290, LeftShift = 340, RightShift = 344, Delete = 261, Backspace = 259, ["5"] = 53, Z = 90, Q = 81, A = 65, W = 87 } }
local kdeps = {
  shortcutRows = deps.shortcutRows, virtualKeyCodes = deps.virtualKeyCodes, shortcutsActive = deps.shortcutsActive, profileName = deps.profileName,
  displayExists = function(n) return n == 1 or n == 2 end,
  Keyboard = function(display, kind, key, shift, ctrl, alt, numlock)
    if kb.raise then local e = kb.raise; kb.raise = nil; error(e) end
    kb.calls[#kb.calls + 1] = { display = display, kind = kind, key = key, shift = shift, ctrl = ctrl, alt = alt, numlock = numlock }
    if key == "LeftShift" or key == "RightShift" then kb.ma = (kind == "press") end
  end,
  keyboardCodes = function() return kb.codes end,
  maState = function() return kb.ma end,
  virtualKeyRedirects = function() return { PLEASE = "Enter", MA1 = "None" } end,
}
local function lastCall() return kb.calls[#kb.calls] end
local function freshKb(config, depsOverride)
  kb.calls = {}; kb.ma = false; kb.raise = nil
  local adapter = HK.keyboardBackend(depsOverride or kdeps)
  local inst = legacyNew({ owner = "bridge", deps = depsOverride or kdeps, config = config }):init()
  local ok, err = inst:enableInput(adapter)
  assert(ok and ok.enabled, "enableInput(keyboard) failed: " .. J(err))
  inst:openSession({ id = "a", leaseMs = 120000 }, 0); inst:openSession({ id = "b", leaseMs = 120000 }, 0)
  return inst, adapter
end
do
  check("keyboardBackend needs deps", not pcall(HK.keyboardBackend))
  local inst, adapter = freshKb()
  local st = inst:status(0)
  check("keyboard backend attached, dispatches, lists its limitations and is not display-scoped", st.inputEnabled and st.backend.name == "keyboard" and st.backend.dispatches and st.backend.available and type(st.backend.limitations) == "table" and #st.backend.limitations >= 5 and st.backend.displayScoped == false, J(st.backend))
  -- Explicit modifiers on every event; the display argument is passed as API context only.
  local h = inst:press("a", 1, { key = "STORE", display = 2 })
  check("press sends Keyboard(display,'press',key,shift,ctrl,alt,numlock) with explicit booleans", h and lastCall().kind == "press" and lastCall().key == "S" and lastCall().display == 2
    and lastCall().shift == false and lastCall().ctrl == false and lastCall().alt == false and lastCall().numlock == false and #kb.calls == 1, J(lastCall()))
  check("keyboard press is dispatched, not confirmed; backend recorded on the hold", h.pressOutcome == "dispatched" and h.dispatch.press.confirmed == nil and h.backend == "keyboard" and h.route.pcKeyValidated == true, J(h))
  local r = inst:release("a", 2, { key = "STORE" })
  check("release repeats the stored tuple with the same modifiers and display", lastCall().kind == "release" and lastCall().key == "S" and lastCall().display == 2 and lastCall().shift == false, J(lastCall()))
  check("keyboard release is 'dispatched': released state, verified=false, no readback for a non-MA key", r.state == "released" and r.releaseOutcome == "dispatched" and r.attempt.outcome == "dispatched" and r.attempt.verified == false and r.readback == nil, J(r))
  -- Raw keys with modifiers: the tuple's flags travel on both events; no LeftCtrl press is synthesised.
  h = inst:press("a", 3, { pcKey = "F1", ctrl = true })
  check("Ctrl+F1 is one event with ctrl=true", #kb.calls == 3 and lastCall().key == "F1" and lastCall().ctrl == true and lastCall().shift == false, J(lastCall()))
  inst:release("a", 4, { hold = h.id })
  check("Ctrl+F1 release carries ctrl=true", lastCall().kind == "release" and lastCall().key == "F1" and lastCall().ctrl == true, J(lastCall()))
  -- EXEC through the mapped executor shortcut.
  h = inst:press("a", 5, { key = "EXEC", executor = 101 })
  check("EXEC 101 dispatches Ctrl+F1 from the shortcut row", h and lastCall().key == "F1" and lastCall().ctrl == true and h.route.shortcut == "Ctrl+F1", J(h))
  inst:release("a", 5, { hold = h.id })
  -- Validation before dispatch: unknown KeyboardCodes name, missing display, logical key whose row names an unknown PC key.
  local n = #kb.calls
  local c, err = inst:press("a", 6, { pcKey = "Bogus" })
  check("unknown Enums.KeyboardCodes name refused before dispatch", c == nil and err.code == "unsupported" and err.message:find("KeyboardCodes") and #kb.calls == n, J(err))
  c, err = inst:press("a", 6, { pcKey = "S", display = 9 })
  check("non-existent display refused before dispatch", c == nil and err.code == "bad-argument" and #kb.calls == n, J(err))
  profile.rows = { { shortcut = "Weird", keyCode = 66 }, { shortcut = "Enter", keyCode = 84 } }
  c, err = inst:press("a", 6, { key = "STORE" })
  check("logical key whose shortcut names a non-KeyboardCodes key is unsupported, nothing sent", c == nil and err.code == "unsupported" and err.message:find("KeyboardCodes") and #kb.calls == n, J(err))
  profile.rows = defaultRows()
  -- Native PLEASE route: admitted with shortcuts disabled; shortcut-table keys are not.
  profile.shortcutsActive = false
  h = inst:press("a", 7, { key = "PLEASE" })
  check("PLEASE admitted through the native Enter route while shortcuts are inactive", h and h.route.source == "native" and h.route.redirectChecked == true and lastCall().key == "Enter", J(h))
  c, err = inst:press("a", 7, { key = "STORE" })
  check("STORE still refused while shortcuts are inactive", c == nil and err.code == "unsupported" and err.message:find("inactive"), J(err))
  profile.shortcutsActive = true
  c, err = inst:press("a", 8, { key = "MA" })
  check("re-enabling shortcuts during a native PLEASE hold is not a route change", c ~= nil and c.pcKey == "LeftShift", J(err))
  inst:release("a", 8, { hold = c.id })
  profile.rows = { { shortcut = "Enter", keyCode = 66 }, { shortcut = "S", keyCode = 66 } }
  c, err = inst:press("a", 9, { key = "MA" })
  check("a shortcut row claiming plain Enter for another key makes the native PLEASE route ambiguous (route-changed during the hold)", c == nil and err.code == "route-changed" and err.mismatches[1].mismatch:find("ambiguous"), J(err))
  profile.rows = defaultRows()
  r = inst:release("a", 10, { key = "PLEASE" })
  check("PLEASE released with the stored Enter tuple once the table is restored", r.state == "released" and lastCall().key == "Enter" and lastCall().kind == "release", J(r))
  -- Keyboard() raising: delivery unknown, record kept as unresolved and its tuple reserved.
  kb.raise = "host exploded"
  c, err = inst:press("a", 11, { pcKey = "Z" })
  check("Keyboard() raising on press keeps an unresolved record", c == nil and err.code == "press-failed" and err.unresolved == true and inst:status().unresolved == 1 and inst:status().holds[#inst:status().holds].unresolved.reason:find("unknown"), J(err))
  c, err = inst:press("b", 11, { pcKey = "Z" })
  check("the unresolved tuple is reserved", c == nil and err.code == "conflict", J(err))
  local rec = inst:recover("a", 12)
  check("recover releases it with the stored tuple through Keyboard()", #rec.released == 1 and rec.released[1].outcome == "dispatched" and lastCall().kind == "release" and lastCall().key == "Z", J(rec))
  h = inst:press("a", 13, { pcKey = "Q" })
  kb.raise = "host exploded again"
  r = inst:release("a", 14, { hold = h.id })
  check("Keyboard() raising on release is unresolved, never silently released", r.state == "unresolved" and r.releaseOutcome == "unresolved" and r.unresolved.reason:find("raised"), J(r))
  rec = inst:recover("a", 15)
  check("recover after the fault dispatches the stored release", #rec.released == 1 and lastCall().key == "Q", J(rec))
  -- Keyboard() missing: refused before dispatch; the instance reports the backend unavailable.
  local noKb = {}
  for k, v in pairs(kdeps) do noKb[k] = v end
  noKb.Keyboard = nil
  local inst2 = legacyNew({ owner = "x", deps = noKb }):init()
  inst2:enableInput(HK.keyboardBackend(noKb)); inst2:openSession({ id = "s" }, 0)
  c, err = inst2:press("s", 0, { pcKey = "S" })
  check("without Keyboard() the press is refused before dispatch and the backend reported unavailable", c == nil and err.code == "unsupported" and err.message:find("Keyboard%(%)") and inst2:status().backend.available == false and inst2:status().backend.missing[1] == "Keyboard", J(err))
  -- MASTATE unreadable: MA is refused (verification unavailable), other keys are not.
  local noMa = {}
  for k, v in pairs(kdeps) do noMa[k] = v end
  noMa.maState = function() return "weird" end
  local inst3 = legacyNew({ owner = "x", deps = noMa }):init()
  inst3:enableInput(HK.keyboardBackend(noMa)); inst3:openSession({ id = "s" }, 0)
  c, err = inst3:press("s", 0, { key = "MA" })
  check("MA refused when MASTATE is not readable", c == nil and err.code == "unsupported" and err.message:find("MASTATE"), J(err))
  check("a shortcut key is still admitted without MASTATE", inst3:press("s", 0, { key = "STORE" }) ~= nil)
  inst3:releaseAll("s", 1)
  inst:releaseAll("a", 16)
end

-------------------------------------------------------------------------------
-- KB-04: MA through LeftShift with bounded aggregate MASTATE readback
-------------------------------------------------------------------------------
do
  local inst = freshKb({ readbackMs = 500 })
  local h = inst:press("a", 1, { key = "MA" })
  check("MA dispatches a LeftShift press without the shift flag", lastCall().key == "LeftShift" and lastCall().shift == false and h.route.verify == "MASTATE", J(lastCall()))
  check("press readback pending until service() observes", h.readback.outcome == "pending" and h.readback.phase == "press" and h.pressOutcome == "dispatched", J(h.readback))
  inst:service(1.1)
  local st = inst:status(1.1)
  check("service observes MASTATE true: press readback 'observed' (aggregate), hold stays held", st.holds[1].readback.outcome == "observed" and st.holds[1].readback.value == true and st.holds[1].state == "held" and st.holds[1].observed.aggregate.value == true and st.holds[1].observed.down == nil, J(st.holds[1]))
  check("status reports aggregate MASTATE separately and no per-key observation", st.observed.available == false and st.observed.aggregate.maState == true and st.backend.perKeyObservation == false, J(st.observed))
  -- Physical Shift release behind our back: MASTATE false rules out every Shift key -> observed up, never re-pressed.
  kb.ma = false
  local calls = #kb.calls
  inst:service(1.2)
  st = inst:status(1.2)
  check("MASTATE false while held: observed.down=false, observedReleasedAt set, no re-press", st.holds[1].observed.down == false and st.holds[1].observedReleasedAt == 1.2 and st.holds[1].state == "held" and #kb.calls == calls, J(st.holds[1]))
  -- Release: dispatched; the readback then sees MASTATE false (consistent, not a per-key confirmation).
  kb.ma = true
  local r = inst:release("a", 2, { key = "MA" })
  check("MA release is dispatched, not confirmed, with a pending readback", r.state == "released" and r.releaseOutcome == "dispatched" and r.attempt.verified == false and r.readback.outcome == "pending" and r.readback.phase == "release", J(r))
  inst:service(2.1)
  st = inst:status(2.1)
  check("release readback observed when MASTATE drops, worded as aggregate", st.holds[1].readback.outcome == "observed" and st.holds[1].readback.value == false and st.holds[1].readback.note:find("aggregate") and st.holds[1].state == "released", J(st.holds[1].readback))
  -- Another Shift source keeps MASTATE true after our release: inconclusive, neither confirmed nor failed.
  h = inst:press("a", 3, { key = "MA" })
  inst:service(3.1)
  local keepTrue = function() return true end
  kdeps.maState = keepTrue
  r = inst:release("a", 4, { key = "MA" })
  inst:service(4.2); inst:service(4.4)
  st = inst:status(4.4)
  check("readback stays pending inside the window", st.holds[2].readback.outcome == "pending", J(st.holds[2].readback))
  inst:service(4.6)
  st = inst:status(4.6)
  check("MASTATE still true after the window: inconclusive, hold remains released (dispatched), not unresolved", st.holds[2].readback.outcome == "inconclusive" and st.holds[2].readback.reason:find("another Shift source") and st.holds[2].state == "released" and st.unresolved == 0, J(st.holds[2].readback))
  kdeps.maState = function() return kb.ma end
  -- Press with no effect: MASTATE stays false -> inconclusive with the honest reason; record stays owned.
  kb.ma = false
  kdeps.Keyboard = function() end  -- a Keyboard() that does nothing
  h = inst:press("a", 5, { key = "MA" })
  inst:service(5.6)
  st = inst:status(5.6)
  check("press readback: MASTATE stayed false -> no observable effect, record stays owned", st.holds[3].readback.outcome == "inconclusive" and st.holds[3].readback.reason:find("no observable effect") and st.holds[3].state == "held", J(st.holds[3].readback))
  kdeps.Keyboard = (function() local f = kdeps.Keyboard; return function(display, kind, key, shift, ctrl, alt, numlock)
    if kb.raise then local e = kb.raise; kb.raise = nil; error(e) end
    kb.calls[#kb.calls + 1] = { display = display, kind = kind, key = key, shift = shift, ctrl = ctrl, alt = alt, numlock = numlock }
    if key == "LeftShift" or key == "RightShift" then kb.ma = (kind == "press") end
  end end)()
  inst:releaseAll("a", 6)
  -- The fake backend offers the same aggregate, so the readback logic is exercised without a console.
  local finst, fb = fresh()
  finst:openSession({ id = "a" }, 0)
  h = finst:press("a", 1, { key = "MA" })
  finst:service(1.1)
  check("fake backend aggregate: MA press readback observed", finst:status().holds[1].readback.outcome == "observed" and finst:status().observed.aggregate.maState == true, J(finst:status().holds[1].readback))
  fb:physicalPress({ pcKey = "RightShift" })
  finst:release("a", 2, { key = "MA" })
  finst:service(3.5)
  check("fake backend: RightShift keeps the aggregate true -> release readback inconclusive while the per-key state confirmed it", finst:status().holds[1].readback.outcome == "inconclusive" and finst:status().holds[1].releaseOutcome == "confirmed", J(finst:status().holds[1]))
  fb:physicalRelease({ pcKey = "RightShift" })
end

-------------------------------------------------------------------------------
-- KB-04: exclusive long-press and combinations
-------------------------------------------------------------------------------
do
  local inst = freshKb()
  local h = inst:tap("a", 1, { key = "STORE", exclusive = true }, 1500)
  check("exclusive tap admitted when nothing else is held", h and h.exclusive == true and h.kind == "tap" and inst:status().exclusiveHold == h.id, J(h))
  local n = #kb.calls
  local c, err = inst:press("a", 1.1, { key = "STORE" })
  check("owner's duplicate press rejected during the long-press (it would cancel it)", c == nil and err.code == "exclusive-hold" and err.hold == h.id and #kb.calls == n, J(err))
  c, err = inst:press("b", 1.2, { key = "MA" })
  check("another session's press rejected during the long-press, naming the owner and remaining time", c == nil and err.code == "exclusive-hold" and err.owner == "a" and err.deadlineInMs ~= nil and #kb.calls == n, J(err))
  c, err = inst:combo("b", 1.2, { { key = "MA" }, { key = "PLEASE" } })
  check("a combo is rejected during the long-press", c == nil and err.code == "exclusive-hold" and #kb.calls == n, J(err))
  c, err = inst:tap("b", 1.3, { pcKey = "Z" }, 20)
  check("a tap is rejected during the long-press", c == nil and err.code == "exclusive-hold", J(err))
  check("releases stay allowed: the owner can end the long-press early", inst:release("a", 1.4, { hold = h.id }).state == "released" and lastCall().kind == "release" and lastCall().key == "S")
  check("exclusive hold cleared", inst:status().exclusiveHold == nil)
  inst:press("b", 2, { pcKey = "Z" })
  c, err = inst:press("a", 2.1, { key = "STORE", exclusive = true })
  check("an exclusive press is refused while another key is held", c == nil and err.code == "exclusive-refused" and err.holds == 1, J(err))
  inst:releaseAll("b", 2.2)
  c, err = inst:press("a", 2.3, { key = "STORE", exclusive = "yes" })
  check("exclusive must be a boolean", c == nil and err.code == "bad-argument", J(err))
  local sv = inst:tap("a", 3, { key = "STORE", exclusive = true }, 100)
  local res = inst:service(3.2)
  check("the loop releases the exclusive tap at its deadline", #res.released == 1 and res.released[1].hold == sv.id and inst:status().exclusiveHold == nil, J(res))
  -- Combinations: every key preflighted first.
  n = #kb.calls
  c, err = inst:combo("a", 4, { { key = "MA" }, { key = "MA1" } })
  check("a combo with an unsupported key dispatches nothing", c == nil and err.code == "unsupported" and err.key == 2 and err.message:find("nothing was dispatched") and #kb.calls == n, J(err))
  c, err = inst:combo("a", 4, { { key = "MA" }, { pcKey = "Bogus" } })
  check("a combo with an invalid KeyboardCodes name dispatches nothing", c == nil and err.code == "unsupported" and err.key == 2 and #kb.calls == n, J(err))
  c, err = inst:combo("a", 4, { { key = "MA" }, { pcKey = "LeftShift" } })
  check("the same tuple twice in a combo is rejected", c == nil and err.code == "bad-argument" and err.message:find("twice") and #kb.calls == n, J(err))
  c, err = inst:combo("a", 4, { { key = "MA" } })
  check("a combo needs at least two keys", c == nil and err.code == "bad-argument")
  c, err = inst:combo("a", 4, { { key = "MA" }, { key = "STORE", exclusive = true } })
  check("a combo cannot be exclusive", c == nil and err.code == "bad-argument" and err.message:find("exclusive"))
  inst:press("b", 4, { pcKey = "S" })
  c, err = inst:combo("a", 4.1, { { key = "MA" }, { key = "STORE" } })
  check("a combo whose key another session holds is a conflict before dispatch", c == nil and err.code == "conflict" and err.key == 2 and #kb.calls == n + 1, J(err))
  inst:releaseAll("b", 4.2)
  n = #kb.calls
  c = inst:combo("a", 5, { { key = "MA" }, { key = "STORE" } }, { holdMs = 200 })
  check("MA+STORE combo presses LeftShift then S, both in one group with a shared deadline", c and c.count == 2 and c.holds[1].pcKey == "LeftShift" and c.holds[2].pcKey == "S" and c.holds[1].group == c.holds[2].group and c.holds[2].kind == "combo-tap"
    and kb.calls[n + 1].key == "LeftShift" and kb.calls[n + 1].kind == "press" and kb.calls[n + 2].key == "S" and #kb.calls == n + 2, J(c))
  res = inst:service(5.25)
  check("combo deadline releases newest first: S then LeftShift", #res.released == 2 and res.released[1].tupleKey == "S|s0c0a0n0" and res.released[2].tupleKey == "LeftShift|s0c0a0n0" and kb.calls[n + 3].key == "S" and kb.calls[n + 4].key == "LeftShift" and kb.calls[n + 4].kind == "release", J(res))
  -- A press failing midway rolls back what was pressed.
  n = #kb.calls
  local pressCount = 0
  local origKeyboard = kdeps.Keyboard
  kdeps.Keyboard = function(...) pressCount = pressCount + 1; if pressCount == 2 then error("second key exploded") end; return origKeyboard(...) end
  c, err = inst:combo("a", 6, { { key = "MA" }, { key = "STORE" } })
  kdeps.Keyboard = origKeyboard
  check("a press raising midway releases the keys already pressed and reports the partial outcome", c == nil and err.code == "press-failed" and err.key == 2 and #err.pressed == 1 and err.pressed[1].pcKey == "LeftShift" and #err.rollback.released == 1 and lastCall().kind == "release" and lastCall().key == "LeftShift", J(err))
  check("the raising key stays as an unresolved record (delivery unknown)", inst:status().unresolved == 1 and inst:status().holds[#inst:status().holds].pcKey == "S", J(inst:status().holds))
  inst:recover("a", 7)
  check("recover clears it", inst:status().unresolved == 0)
  c, err = inst:combo("a", 8, { { key = "MA" }, { key = "STORE" } }, { holdMs = 99999 })
  check("combo holdMs is bounded by maxTapMs", c == nil and err.code == "bad-argument")
  -- Capacity counts the whole combo.
  local small = freshKb({ maxHolds = 2 })
  small:press("a", 1, { pcKey = "Z" })
  c, err = small:combo("a", 1, { { key = "MA" }, { key = "STORE" } })
  check("a combo that would exceed capacity dispatches nothing", c == nil and err.code == "capacity" and #kb.calls == 1, J(err))
end

-------------------------------------------------------------------------------
-- KB-04: records carry their backend; attachBackend() for cleanup without admitting input
-------------------------------------------------------------------------------
do
  -- Fake records must never become real key events.
  local finst, fb = fresh()
  finst:openSession({ id = "a" }, 0)
  finst:press("a", 1, { pcKey = "Z" })
  fb:failNext("release", { pcKey = "Z" }, "stuck", true)
  local d = finst:dispose(2)
  check("dispose records carry the originating backend", d.records[1].backend == "fake", J(d.records[1]))
  kb.calls = {}
  local inst = legacyNew({ owner = "bridge", deps = kdeps }):init()
  local ad = inst:adopt(d.records, 3)
  check("adopted record keeps its backend", #ad.adopted == 1 and ad.adopted[1].backend == "fake", J(ad))
  local att = inst:attachBackend(HK.keyboardBackend(kdeps))
  check("attachBackend attaches without enabling input", att and att.attached and att.enabled == false and inst:status().inputEnabled == false and inst:status().backend.attached == true and inst:status().backend.dispatches == true, J(att))
  inst:openSession({ id = "s" }, 3)
  local c, err = inst:press("s", 3, { pcKey = "A" })
  check("input stays disabled after attachBackend", c == nil and err.code == "input-disabled", J(err))
  local rec = inst:recover(nil, 4)
  check("a fake record is not released through the keyboard backend: unresolved, nothing sent", #rec.unresolved == 1 and rec.unresolved[1].error:find("originates from backend 'fake'") and #kb.calls == 0, J(rec))
  check("the record stays reserved", inst:status().unresolved == 1 and inst:status().holds[1].backend == "fake")
  -- Switching to the originating backend is refused while the record exists? No: attach is allowed when
  -- the adapter changes only if no live records exist, so the operator must use the fake to clear it.
  local sw, swerr = inst:attachBackend(HK.fakeBackend())
  check("switching backends with a live record is refused", sw == nil and swerr.code == "holds-exist", J(swerr))
  -- A fresh instance with the fake attached for cleanup clears the fake record.
  local inst2 = legacyNew({ owner = "bridge", deps = kdeps }):init()
  inst2:adopt(d.records, 5)
  inst2:attachBackend(HK.fakeBackend())
  rec = inst2:recover(nil, 6)
  check("the originating (fake) backend releases the adopted fake record", #rec.released == 1 and inst2:status().unresolved == 0, J(rec))
  -- Records without a backend name are never dispatched anywhere.
  local inst3 = legacyNew({ owner = "bridge", deps = kdeps }):init()
  inst3:adopt({ { pcKey = "Q", ctrl = true } }, 7)
  inst3:attachBackend(HK.keyboardBackend(kdeps))
  rec = inst3:recover(nil, 8)
  check("a record of unknown origin is never dispatched", #rec.unresolved == 1 and rec.unresolved[1].error:find("'unknown'") and #kb.calls == 0, J(rec))
  -- Keyboard records released by a keyboard adapter after a "restart".
  local k1 = freshKb()
  k1:press("a", 1, { key = "MA" })
  kb.raise = "console wedged"
  local dk = k1:dispose(2)
  check("keyboard dispose keeps the failed MA release as a keyboard record", #dk.records == 1 and dk.records[1].backend == "keyboard" and dk.records[1].pcKey == "LeftShift", J(dk.records))
  local k2 = legacyNew({ owner = "bridge", deps = kdeps }):init()
  k2:adopt(dk.records, 3)
  k2:attachBackend(HK.keyboardBackend(kdeps))
  kb.calls = {}
  rec = k2:recover(nil, 4)
  check("recover through the keyboard adapter sends the stored LeftShift release with input still disabled", #rec.released == 1 and lastCall().kind == "release" and lastCall().key == "LeftShift" and k2:status().inputEnabled == false, J(rec))
end

-------------------------------------------------------------------------------
-- Review of PR #9: collisions, unestablished enablement, exclusivity across failed releases
-------------------------------------------------------------------------------
do
  -- 1. A colliding row is detected at press time and as a route change during a hold.
  local inst, backend = fresh()
  inst:openSession({ id = "a", leaseMs = 120000 }, 0)
  profile.rows = { { shortcut = "Enter", keyCode = 84 }, { shortcut = "S", keyCode = 66 }, { shortcut = "S", keyCode = 87 } }
  local c, err = inst:press("a", 1, { key = "STORE" })
  check("STORE refused when S is also mapped to CLEAR; nothing dispatched", c == nil and err.code == "unsupported" and err.message:find("collision") and backend.counters.press == 0, J(err))
  profile.rows = defaultRows()
  local h = inst:press("a", 2, { key = "STORE" })
  profile.rows = { { shortcut = "Enter", keyCode = 84 }, { shortcut = "S", keyCode = 66 }, { shortcut = "S", keyCode = 87 } }
  c, err = inst:press("a", 3, { key = "MA" })
  check("a collision appearing during a hold is a route change", c == nil and err.code == "route-changed" and err.message:find("collision"), J(err))
  backend:setConfirmMode(nil)
  local r = inst:release("a", 4, { key = "STORE" })
  check("the unconfirmable release stays unresolved while the collision exists", r.state == "unresolved", J(r))
  profile.rows = defaultRows()
  r = inst:recover("a", 5)
  check("recover releases once the table is clean again", #r.released == 1, J(r))
  backend:setConfirmMode(true)

  -- 2. Shortcut enablement must be positively established.
  local savedActive = deps.shortcutsActive
  deps.shortcutsActive = function() error("profile unreadable") end
  c, err = inst:press("a", 6, { key = "STORE" })
  check("shortcut-backed press refused when enablement cannot be read", c == nil and err.code == "unsupported" and err.message:find("cannot be established") and err.message:find("profile unreadable"), J(err))
  deps.shortcutsActive = function() return nil end
  c, err = inst:press("a", 6, { key = "STORE" })
  check("shortcut-backed press refused when enablement reads as nil", c == nil and err.code == "unsupported" and err.message:find("cannot be established"), J(err))
  c = inst:press("a", 6, { key = "MA" })
  check("the fixed MA route does not need enablement", c and c.pcKey == "LeftShift", J(c))
  inst:release("a", 6, { key = "MA" })
  c = inst:press("a", 6, { key = "PLEASE" })
  check("the native PLEASE route does not need enablement", c and c.route.source == "native", J(c))
  inst:release("a", 6, { key = "PLEASE" })
  deps.shortcutsActive = savedActive
  h = inst:press("a", 7, { key = "STORE" })
  deps.shortcutsActive = function() error("profile unreadable") end
  backend:setConfirmMode(nil)
  r = inst:release("a", 8, { key = "STORE" })
  check("release with unreadable enablement is unresolved, not released; the record is kept", r.state == "unresolved" and r.unresolved.reason:find("cannot be established") and inst:status().unresolved == 1, J(r))
  c, err = inst:press("a", 8, { pcKey = "Z" })
  check("new input stops while enablement cannot be established", c == nil and err.code == "route-changed", J(err))
  deps.shortcutsActive = savedActive
  r = inst:recover("a", 9)
  check("recover resolves it once enablement is readable again", #r.released == 1 and inst:status().unresolved == 0, J(r))
  -- Profile identity unreadable during a hold is a mismatch too.
  h = inst:press("a", 10, { key = "STORE" })
  local savedProfile = deps.profileName
  deps.profileName = function() error("no profile") end
  r = inst:release("a", 11, { key = "STORE" })
  check("release with unreadable profile identity is unresolved", r.state == "unresolved" and r.unresolved.reason:find("profile identity"), J(r))
  deps.profileName = savedProfile
  inst:recover("a", 12)
  backend:setConfirmMode(true)
  check("clean again", inst:status().unresolved == 0 and inst:status().capacity.used == 0)

  -- 3. Exclusivity survives a failed release, disposal and adoption.
  inst:openSession({ id = "b", leaseMs = 120000 }, 0)
  h = inst:press("a", 20, { key = "STORE", exclusive = true })
  backend:failNext("release", { pcKey = "S" }, "wedged", true)
  r = inst:release("a", 21, { key = "STORE" })
  check("exclusive release fails -> unresolved", r.state == "unresolved", J(r))
  c, err = inst:press("b", 22, { pcKey = "Q" })
  check("another session is still locked out while the exclusive release is unresolved", c == nil and err.code == "exclusive-hold" and err.state == "unresolved" and err.message:find("recover"), J(err))
  c, err = inst:press("a", 22, { pcKey = "Q" })
  check("the owner is locked out too", c == nil and err.code == "exclusive-hold", J(err))
  check("status still names the exclusive hold", inst:status().exclusiveHold == h.id)
  local d = inst:dispose(23)
  check("the disposed record carries exclusive", d.records[1] and d.records[1].exclusive == true and d.records[1].pcKey == "S", J(d.records))
  local inst2 = legacyNew({ owner = "bridge", deps = deps }):init()
  local b2 = HK.fakeBackend()
  inst2:adopt(d.records, 24)
  inst2:enableInput(b2)
  inst2:openSession({ id = "c" }, 24)
  c, err = inst2:press("c", 25, { pcKey = "Q" })
  check("an adopted exclusive record keeps the lock in the new instance", c == nil and err.code == "exclusive-hold" and err.owner == "previous-run", J(err))
  r = inst2:recover(nil, 26)
  check("recover resolves the adopted exclusive record", #r.released == 1 and inst2:status().exclusiveHold == nil, J(r))
  check("input admitted again", inst2:press("c", 27, { pcKey = "Q" }) ~= nil)
  inst2:releaseAll("c", 28)
end

-------------------------------------------------------------------------------
-- KB-05: interactions, admission, text and sequences (fake backend, strict policy = the bridge's)
-------------------------------------------------------------------------------
local currentFake
deps.commandText = function() return currentFake.typed end
local function freshStrict(config)
  local backend = HK.fakeBackend()
  currentFake = backend
  local inst = HK.new({ owner = "bridge", deps = deps, config = config }):init()
  local ok = inst:enableInput(backend)
  assert(ok and ok.enabled, "enableInput failed")
  inst:openSession({ id = "a", leaseMs = 120000 }, 0); inst:openSession({ id = "b", leaseMs = 120000 }, 0)
  return inst, backend
end
local function kinds(b, from)
  local t = {}
  for i = from or 1, #b.events do t[#t + 1] = b.events[i].kind .. ":" .. tostring(b.events[i].pcKey) end
  return table.concat(t, " ")
end

-- Text policy: UTF-8 by code point, control characters refused, nothing normalised.
do
  local cps = HK.validateText("ab")
  check("validateText returns code points", cps and #cps == 2 and cps[1] == 97, J(cps))
  cps = HK.validateText("abü€😀")
  check("Unicode text is iterated by code point, not byte", cps and #cps == 5 and cps[3] == 0xFC and cps[4] == 0x20AC and cps[5] == 0x1F600, J(cps))
  local _, why, pos = HK.validateText("ab\xffc")
  check("invalid UTF-8 refused with the byte position", why:find("not valid UTF%-8") and pos == 3, why)
  _, why, pos = HK.validateText("Fixture 5\n")
  check("newline refused with the character index and the PLEASE hint", why:find("newline") and why:find("PLEASE") and pos == 10, why)
  _, why = HK.validateText("a\tb")
  check("tab refused", why:find("tab"), why)
  _, why = HK.validateText("a\127")
  check("DEL refused", why:find("control"), why)
  _, why = HK.validateText("a\u{85}b")
  check("C1 control refused", why:find("control"), why)
  _, why = HK.validateText("a\u{2028}b")
  check("line separator refused", why:find("separator"), why)
  _, why = HK.validateText("\r")
  check("carriage return refused", why:find("newline"), why)
  _, why = HK.validateText("")
  check("empty text refused", why:find("empty"), why)
  _, why = HK.validateText(string.rep("x", 300), 256)
  check("length cap by characters", why:find("300 characters"), why)
  check("exports list the step kinds and text contexts", #HK.SEQUENCE_STEP_KINDS == 6 and HK.TEXT_CONTEXTS[1] == "command-line")
  check("boolean config is accepted and validated", HK.new({ owner = "x", config = { requireInteraction = false } }):status().config.requireInteraction == false
    and not pcall(HK.new, { owner = "x", config = { requireInteraction = 1 } }))
end

-- Interactions: explicit lease, ownership, busy for everyone else, never resumed.
do
  local inst, backend = freshStrict()
  check("quiet instance is not busy", inst:admission(0) == nil and inst:status(0).busy == nil)
  local h, err = inst:press("a", 1, { key = "STORE" })
  check("a standalone hold without an interaction is refused before dispatch", h == nil and err.code == "interaction-required" and #backend.events == 0, J(err))
  local ia; ia, err = inst:beginInteraction("a", 1, { leaseMs = 5000, label = "store" })
  check("beginInteraction returns a leased token bound to the session", ia and ia.id == "i1" and ia.session == "a" and ia.leaseMs == 5000 and ia.remainingMs == 5000 and ia.state == "open", J(err))
  check("the session lease was extended to cover the interaction", inst:status(1).sessions.a.expiresAt >= 6)
  local b2; b2, err = inst:beginInteraction("b", 1, {})
  check("another session cannot begin while an interaction is open (busy, naming the owner)", b2 == nil and err.code == "busy" and err.reason == "interaction" and err.owner == "a" and err.interaction == "i1", J(err))
  b2, err = inst:beginInteraction("a", 1, {})
  check("the owner cannot stack a second interaction either", b2 == nil and err.code == "busy", J(err))
  h, err = inst:press("a", 2, { key = "STORE" })
  check("the owner's press without the id is busy (callers sharing a connection must name the interaction)", h == nil and err.code == "busy" and err.reason == "interaction", J(err))
  h, err = inst:press("a", 2, { key = "STORE", interaction = "i9" })
  check("an unknown interaction id is refused", h == nil and err.code == "no-interaction", J(err))
  h, err = inst:press("b", 2, { key = "STORE", interaction = "i1" })
  check("another session cannot use the id (not-owner)", h == nil and err.code == "not-owner" and err.owner == "a", J(err))
  h, err = inst:tap("b", 2, { key = "PLEASE" }, 50)
  check("another session's tap is busy while the interaction is open", h == nil and err.code == "busy" and #backend.events == 0, J(err))
  h, err = inst:press("a", 2, { key = "STORE", interaction = "i1" })
  check("the owner's press with the id is admitted and tagged", h and h.state == "held" and h.interaction == "i1" and #backend.events == 1, J(err))
  local busy = inst:admission(2)
  check("admission reports the open interaction first", busy and busy.reason == "interaction" and busy.owner == "a" and busy.interaction == "i1" and busy.remainingMs == 4000, J(busy))
  local st = inst:status(2)
  check("status lists the interaction, the active one and the busy descriptor", st.interactions.i1.holds == 1 and st.activeInteraction == "i1" and st.busy.reason == "interaction", J(st.interactions))
  local r; r, err = inst:renewInteraction("a", "i1", 3, 10000)
  check("renewal moves the deadline and injects nothing", r and r.expiresAt == 13 and r.renewals == 1 and #backend.events == 1, J(err))
  r, err = inst:renewInteraction("b", "i1", 3)
  check("another session cannot renew it", r == nil and err.code == "not-owner", J(err))
  r, err = inst:endInteraction("b", "i1", 4)
  check("another session cannot end it", r == nil and err.code == "not-owner", J(err))
  r, err = inst:endInteraction("a", "i1", 4)
  check("ending releases the interaction's holds newest first and reports them", r and r.state == "ended" and #r.released == 1 and r.released[1].hold == h.id and backend.events[#backend.events].kind == "release", J(err))
  check("instance quiet again", inst:admission(4) == nil and inst:status(4).activeInteraction == nil and inst:status(4).interactions.i1.state == "ended")
  h, err = inst:press("a", 5, { key = "STORE", interaction = "i1" })
  check("an ended interaction is never resumed", h == nil and err.code == "no-interaction" and err.state == "ended", J(err))
  r = inst:endInteraction("a", "i1", 5)
  check("ending twice is harmless", r.alreadyEnded == true and r.attempted == 0, J(r))
  h, err = inst:tap("b", 5, { key = "PLEASE" }, 50)
  check("a bounded tap needs no interaction once the instance is quiet", h and h.kind == "tap" and h.interaction == nil, J(err))
  local h2; h2, err = inst:tap("a", 5, { key = "STORE" }, 50)
  check("another session's tap is busy while a tap of someone else is in flight", h2 == nil and err.code == "busy" and err.reason == "hold" and err.owner == "b", J(err))
  h2, err = inst:tap("b", 5, { key = "STORE" }, 50)
  check("the same session may layer its own taps", h2 and h2.session == "b", J(err))
  b2, err = inst:beginInteraction("a", 5, {})
  check("beginning while taps are in flight is busy (hold)", b2 == nil and err.code == "busy" and err.reason == "hold", J(err))
  inst:service(6)
  check("taps released by service; quiet again", inst:admission(6) == nil)
  -- Expiry: an expired interaction ends on service() (holds released) and cannot be renewed.
  ia = inst:beginInteraction("a", 10, { leaseMs = 1000 })
  inst:press("a", 10, { key = "STORE", interaction = ia.id })
  local out = inst:service(12)
  check("an expired interaction is ended by service(), its hold released", out.interactionsExpired and out.interactionsExpired[1] == ia.id and #out.released == 1 and inst:status(12).interactions[ia.id].state == "expired", J(out))
  r, err = inst:renewInteraction("a", ia.id, 12)
  check("an expired interaction is not resumed by a late renewal", r == nil and err.code == "no-interaction" and err.state == "expired", J(err))
  -- Lazy expiry: admission between service() calls sees it too.
  ia = inst:beginInteraction("a", 20, { leaseMs = 1000 })
  check("admission reports the lapsed interaction as expired without waiting for service()", inst:admission(25) == nil and inst:status(25).interactions[ia.id].state == "expired")
  -- Session close ends interactions and reports their releases through the close.
  ia = inst:beginInteraction("a", 30, { leaseMs = 5000 })
  inst:press("a", 30, { key = "STORE", interaction = ia.id })
  r = inst:closeSession("a", 31, "disconnect")
  check("closing the session ends its interaction and releases its holds in the close report", #r.released == 1 and inst:status(31).interactions[ia.id] and inst:status(31).interactions[ia.id].state == "ended" and inst:status(31).interactions[ia.id].endReason == "disconnect", J(r))
  inst:openSession({ id = "a", leaseMs = 120000 }, 31)
  -- Disable while an interaction is open: it ends, releases run, recovery stays available.
  ia = inst:beginInteraction("a", 40, { leaseMs = 5000 })
  inst:press("a", 40, { key = "STORE", interaction = ia.id })
  r = inst:disableInput(41, "input-disabled")
  check("disableInput ends the interaction and releases its hold", #r.released == 1 and inst:status(41).interactions[ia.id].state == "ended" and inst:admission(41) == nil, J(r))
  b2, err = inst:beginInteraction("a", 42, {})
  check("no interaction can begin while input is disabled", b2 == nil and err.code == "input-disabled", J(err))
  r = inst:endInteraction("a", ia.id, 42)
  check("ending while disabled is harmless (already ended)", r.alreadyEnded == true, J(r))
  check("releaseAll and recover stay available while disabled", inst:releaseAll("a", 42).attempted == 0 and inst:recover("a", 42).attempted == 0)
end

-- Sequences: validated as a whole, serviced step by step, reported precisely.
do
  local inst, backend = freshStrict()
  local q, err = inst:startSequence("a", 0, { { kind = "tap", key = "STORE", holdMs = 100 }, { kind = "wait", ms = 50 }, { kind = "press", key = "MA" },
                                              { kind = "tap", key = "NUM5", holdMs = 50 }, { kind = "release", key = "MA" } }, { label = "store 5" })
  check("startSequence validates, begins an interaction and starts the first step", q and q.id == "q1" and q.state == "running" and q.index == 1 and q.autoInteraction == true and q.interaction == "i1" and q.steps == 5
    and q.events[1].state == "waiting" and q.events[1].hold == "h1" and q.events[2].state == "pending" and #backend.events == 1, J(err or q))
  check("estimate covers holds and waits", q.estimateMs == 100 + 50 + 20 + 50 + 20, q.estimateMs)
  local h; h, err = inst:tap("a", 0.01, { key = "PLEASE" }, 50)
  check("the owner's direct input is busy while its sequence runs", h == nil and err.code == "busy" and err.reason == "sequence" and err.sequence == "q1", J(err))
  h, err = inst:tap("b", 0.01, { key = "PLEASE" }, 50)
  check("another session's input is busy too", h == nil and err.code == "busy", J(err))
  local q2; q2, err = inst:startSequence("b", 0.01, { { kind = "tap", key = "PLEASE" } })
  check("only one sequence runs at a time", q2 == nil and err.code == "busy" and err.reason == "sequence", J(err))
  check("admission names the interaction and its sequence", inst:admission(0.01).sequence == "q1")
  local out = inst:service(0.05)
  check("before the tap deadline the sequence waits", out.sequence.state == "running" and out.sequence.index == 1 and #backend.events == 1, J(out.sequence))
  out = inst:service(0.15)
  local rep = inst:sequenceStatus("q1", 0.15)
  check("tap released at its deadline, step completed, wait started", rep.events[1].state == "completed" and rep.events[1].releaseOutcome == "confirmed" and rep.events[2].state == "waiting" and rep.index == 2, J(rep.events))
  out = inst:service(0.21)
  rep = inst:sequenceStatus("q1", 0.21)
  check("wait completed, MA pressed, NUM5 tap in flight in the same iteration", rep.events[2].state == "completed" and rep.events[3].state == "completed" and rep.events[3].pressOutcome == "confirmed" and rep.events[4].state == "waiting" and rep.index == 4, J(rep.events))
  check("the sequence's holds are tagged with it and the interaction", inst:status(0.21).holds[2].sequence == "q1" and inst:status(0.21).holds[2].interaction == "i1")
  out = inst:service(0.27)
  rep = inst:sequenceStatus("q1", 0.27)
  check("NUM5 released, MA released by the release step, sequence completed, interaction ended", rep.state == "completed" and rep.events[4].state == "completed" and rep.events[5].state == "completed" and rep.events[5].releaseOutcome == "confirmed"
    and rep.counts.completed == 5 and rep.cleanup.attempted == 0 and inst:status(0.27).interactions.i1.state == "ended" and inst:admission(0.27) == nil, J(rep))
  check("events in order: S down/up, LeftShift down, 5 down/up, LeftShift up", kinds(backend) == "press:S release:S press:LeftShift press:5 release:5 release:LeftShift", kinds(backend))
  check("the finished report says what completed means", rep.note:find("not that a UI effect was verified") and rep.elapsedMs == 270, rep.note)
  local _, nerr = inst:sequenceStatus("q9", 1)
  check("unknown sequence ids are reported", nerr.code == "no-sequence", J(nerr))
  -- Validation refuses the whole request; nothing is dispatched.
  local n = #backend.events
  q, err = inst:startSequence("a", 1, {})
  check("empty steps refused", q == nil and err.code == "bad-argument", J(err))
  q, err = inst:startSequence("a", 1, { { kind = "tap", key = "STORE" }, { kind = "dance" } })
  check("unknown kind refused naming the step", q == nil and err.code == "bad-argument" and err.step == 2 and err.message:find("nothing was dispatched"), J(err))
  q, err = inst:startSequence("a", 1, { { kind = "tap", key = "STORE" }, { kind = "release", key = "PLEASE" } })
  check("a release of a key the sequence never presses is refused", q == nil and err.code == "bad-argument" and err.step == 2, J(err))
  q, err = inst:startSequence("a", 1, { { kind = "tap", key = "MA1" } })
  check("an unsupported key fails validation", q == nil and err.code == "unsupported" and err.step == 1, J(err))
  q, err = inst:startSequence("a", 1, { { kind = "text", text = "Fixture 5\n", context = "command-line" } })
  check("text with a newline fails validation", q == nil and err.code == "bad-argument" and err.message:find("newline"), J(err))
  q, err = inst:startSequence("a", 1, { { kind = "wait", ms = 9000 } })
  check("a wait beyond maxWaitMs is refused", q == nil and err.code == "bad-argument", J(err))
  local many = {}
  for i = 1, 7 do many[i] = { kind = "tap", key = "STORE", holdMs = 5000 } end
  q, err = inst:startSequence("a", 1, many)
  check("a sequence longer than maxSequenceMs is refused with its estimate", q == nil and err.code == "bad-argument" and err.estimateMs == 35000, J(err))
  q, err = inst:startSequence("a", 1, { { kind = "combo", keys = { { key = "MA" }, { key = "STORE", exclusive = true } }, holdMs = 50 } })
  check("an exclusive key inside a combo step is refused", q == nil and err.code == "bad-argument", J(err))
  q, err = inst:startSequence("a", 1, { { kind = "press", key = "STORE", holdMs = 50 } })
  check("a press with holdMs is refused (use a tap)", q == nil and err.code == "bad-argument", J(err))
  check("nothing was dispatched by refused sequences", #backend.events == n and inst:admission(1) == nil and inst:status(1).activeInteraction == nil)
  -- Failure midway: a refused press fails the step, later steps are unattempted, earlier holds are released.
  backend:failNext("press", { pcKey = "Enter" }, "console refused")
  q = inst:startSequence("a", 2, { { kind = "press", key = "MA" }, { kind = "tap", key = "PLEASE" }, { kind = "tap", key = "STORE" } })
  check("a refused press fails the sequence at that step", q.state == "failed" and q.failedStep == 2 and q.events[1].state == "completed" and q.events[2].state == "failed" and q.events[2].code == "press-failed"
    and q.events[3].state == "unattempted" and q.counts.unattempted == 1, J(q))
  check("what the sequence pressed before the failure was released (MA), never replayed", q.cleanup.released == 1 and kinds(backend, n + 1) == "press:LeftShift press:Enter release:LeftShift" and inst:admission(2) == nil, kinds(backend, n + 1))
  -- Uncertain: a press that raises leaves an unresolved record; the step is uncertain, not failed.
  n = #backend.events
  backend:raiseNext("press", "host blocked")
  q = inst:startSequence("a", 3, { { kind = "tap", key = "STORE" }, { kind = "tap", key = "PLEASE" } })
  check("a raised press is an uncertain step and stops the sequence", q.state == "failed" and q.events[1].state == "uncertain" and q.events[1].hold == inst:status(3).holds[#inst:status(3).holds].id and q.events[2].state == "unattempted", J(q))
  check("the unresolved record is kept for recovery and blocks its tuple", inst:status(3).unresolved == 1)
  local rec = inst:recover("a", 4)
  check("recover clears it", #rec.released == 1 and inst:status(4).unresolved == 0, J(rec))
  -- Uncertain at the end: a tap whose release stays unresolved.
  backend:failNext("release", { pcKey = "S" }, "wedged", true)
  q = inst:startSequence("a", 5, { { kind = "tap", key = "STORE", holdMs = 50 }, { kind = "tap", key = "PLEASE" } })
  inst:service(5.1)
  rep = inst:sequenceStatus(q.id, 5.1)
  check("an unresolved tap release makes the step uncertain and fails the sequence", rep.state == "failed" and rep.events[1].state == "uncertain" and rep.events[1].releaseOutcome == "unresolved" and rep.events[2].state == "unattempted", J(rep))
  backend:clearFailures()
  inst:recover("a", 5.2)
  -- Owner abort releases what is held; a sequence under an explicit interaction leaves it open.
  local ia = inst:beginInteraction("a", 6, { leaseMs = 60000 })
  q, err = inst:startSequence("a", 6, { { kind = "press", key = "MA" }, { kind = "tap", key = "STORE", holdMs = 2000 } }, { interaction = ia.id })
  check("a sequence may run under an explicit interaction", q and q.autoInteraction == false and q.interaction == ia.id, J(err))
  local ab; ab, err = inst:abortSequence("b", q.id, 6.5)
  check("another session cannot abort it", ab == nil and err.code == "not-owner", J(err))
  ab = inst:abortSequence("a", q.id, 6.5, "operator")
  check("the owner's abort stops the sequence, releases its holds and keeps the explicit interaction open", ab.state == "aborted" and ab.events[2].state == "aborted" and ab.cleanup.released == 2 and inst:status(6.5).interactions[ia.id].state == "open", J(ab))
  q, err = inst:startSequence("b", 6.6, { { kind = "tap", key = "STORE" } })
  check("the explicit interaction keeps others busy after the sequence", q == nil and err.code == "busy" and err.reason == "interaction", J(err))
  q = inst:startSequence("a", 7, { { kind = "press", key = "MA" } }, { interaction = ia.id })
  check("a press left held at the end of a sequence is released by its completion", q.state == "completed" and q.cleanup.released == 1 and backend.events[#backend.events].kind == "release", J(q))
  inst:endInteraction("a", ia.id, 8)
  ia = inst:beginInteraction("a", 9, { leaseMs = 300 })
  q, err = inst:startSequence("a", 9, { { kind = "tap", key = "STORE", holdMs = 1000 } }, { interaction = ia.id })
  check("an interaction whose lease is shorter than the sequence is refused (renew first)", q == nil and err.code == "lease-too-short", J(err))
  inst:endInteraction("a", ia.id, 9)
  -- Disconnect mid-sequence: the session closes, the sequence is aborted, its hold released, nothing resumed.
  n = #backend.events
  q = inst:startSequence("b", 10, { { kind = "tap", key = "STORE", holdMs = 1000 }, { kind = "text", text = "abc", context = "text-field", acknowledgeFocus = true } })
  local closed = inst:closeSession("b", 10.2, "disconnect")
  rep = inst:sequenceStatus(q.id, 10.2)
  check("closing the session mid-sequence aborts it with the in-flight step marked and the rest unattempted", rep.state == "aborted" and rep.events[1].state == "aborted" and rep.events[2].state == "unattempted" and rep.cleanup.deferred == 1, J(rep))
  check("the disconnect released the in-flight tap through the session close", #closed.released == 1 and kinds(backend, n + 1) == "press:S release:S", kinds(backend, n + 1))
  inst:service(12)
  check("nothing is replayed afterwards", #backend.events == n + 2 and inst:admission(12) == nil)
  inst:openSession({ id = "b", leaseMs = 120000 }, 12)
end

-- Text: explicit context, chunked typing, context recheck, readback, Unicode, uncertainty.
do
  local inst, backend = freshStrict()
  profile.shortcutsActive = true
  local q, err = inst:startSequence("a", 0, { { kind = "text", text = "Fixture 5", context = "command-line" } })
  check("command-line text with shortcuts enabled is unsupported (never toggled)", q == nil and err.code == "unsupported" and err.message:find("F10") and #backend.events == 0, J(err))
  q, err = inst:startSequence("a", 0, { { kind = "text", text = "abc", context = "text-field" } })
  check("text-field text needs the focus acknowledgment", q == nil and err.code == "focus-unverified", J(err))
  q, err = inst:startSequence("a", 0, { { kind = "text", text = "abc", context = "nowhere" } })
  check("an unknown context is refused", q == nil and err.code == "bad-argument", J(err))
  profile.shortcutsActive = false
  q = inst:startSequence("a", 1, { { kind = "text", text = "Fixture 5", context = "command-line" } })
  check("command-line text starts typing in chunks of textCharsPerService", q.state == "running" and q.events[1].state == "typing" and q.events[1].typed == 8 and q.events[1].remaining == 1 and backend.typed == "Fixture ", J(q.events[1]))
  local out = inst:service(1.05)
  local rep = inst:sequenceStatus(q.id, 1.05)
  check("the last chunk typed and the command line read back as expected", rep.state == "completed" and rep.events[1].typed == 9 and rep.events[1].readback.outcome == "observed" and rep.events[1].readback.actual == "Fixture 5" and backend.typed == "Fixture 5", J(rep.events[1]))
  check("characters were char events, no key press, no Enter", backend.counters.char == 9 and backend.counters.press == 0, J(backend.counters))
  -- Context change between chunks stops typing with its progress.
  backend:setTypedText("")
  q = inst:startSequence("a", 2, { { kind = "text", text = "abcdefghijklmnopqrst", context = "command-line" } })
  check("first chunk typed", q.events[1].typed == 8)
  profile.shortcutsActive = true
  inst:service(2.05)
  rep = inst:sequenceStatus(q.id, 2.05)
  check("shortcuts re-enabled between chunks: the step fails with partial progress and typing stops", rep.state == "failed" and rep.events[1].state == "failed" and rep.events[1].code == "context-changed" and rep.events[1].typed == 8 and rep.events[1].remaining == 12 and backend.typed == "abcdefgh", J(rep.events[1]))
  profile.shortcutsActive = false
  -- A char that raises leaves the text uncertain at that character.
  backend:setTypedText("")
  q = inst:startSequence("a", 3, { { kind = "text", text = "0123456789", context = "command-line" } })
  backend:raiseNext("char", "host blocked")
  inst:service(3.05)
  rep = inst:sequenceStatus(q.id, 3.05)
  check("a raised char event is uncertain at that character; nothing more is typed", rep.state == "failed" and rep.events[1].state == "uncertain" and rep.events[1].uncertainChar == 9 and rep.events[1].typed == 8 and backend.typed == "01234567", J(rep.events[1]))
  -- Unicode goes out one code point per event and reads back.
  backend:setTypedText("")
  q = inst:startSequence("a", 4, { { kind = "text", text = "abü€😀", context = "command-line" } })
  inst:service(4.05)
  rep = inst:sequenceStatus(q.id, 4.05)
  check("Unicode text is typed as one char event per code point and read back", rep.state == "completed" and rep.events[1].chars == 5 and backend.typed == "abü€😀" and backend.events[#backend.events].codepoint == 0x1F600 and rep.events[1].readback.outcome == "observed", J(rep.events[1]))
  -- Inconclusive readback: the command line shows something else; no retry, no failure claimed.
  backend:setTypedText("")
  q = inst:startSequence("a", 5, { { kind = "text", text = "0123456789", context = "command-line" } })
  backend:setTypedText("zz")  -- the operator edits the line between chunks
  inst:service(5.1)
  rep = inst:sequenceStatus(q.id, 5.1)
  check("readback stays pending inside the window", rep.state == "running" and rep.events[1].state == "readback" and rep.events[1].typed == 10 and rep.events[1].readback.outcome == "pending", J(rep.events[1]))
  inst:service(6.2)
  rep = inst:sequenceStatus(q.id, 6.2)
  check("after the window the readback is inconclusive and the step completed (dispatched), never retried", rep.state == "completed" and rep.events[1].readback.outcome == "inconclusive" and rep.events[1].readback.actual == "zz89" and backend.counters.char == 9 + 8 + 9 + 5 + 10, J(rep.events[1]))
  -- Text field: acknowledged focus, verification unavailable, shortcut enablement change still stops it.
  profile.shortcutsActive = true
  backend:setTypedText("")
  q = inst:startSequence("a", 7, { { kind = "text", text = "name", context = "text-field", acknowledgeFocus = true, display = 1 } })
  check("text-field text runs with focus acknowledged and reports verification unavailable", q.state == "completed" and q.events[1].readback.outcome == "unavailable" and backend.typed == "name" and backend.events[#backend.events].display == 1, J(q.events[1]))
  q = inst:startSequence("a", 8, { { kind = "text", text = "0123456789", context = "text-field", acknowledgeFocus = true } })
  profile.shortcutsActive = false
  inst:service(8.05)
  rep = inst:sequenceStatus(q.id, 8.05)
  check("a shortcut enablement change during text-field typing stops it too", rep.state == "failed" and rep.events[1].code == "context-changed" and rep.events[1].typed == 8, J(rep.events[1]))
  profile.shortcutsActive = true
  -- Text never commits: a following PLEASE is a separate, explicit step.
  profile.shortcutsActive = false
  backend:setTypedText("")
  q = inst:startSequence("a", 9, { { kind = "text", text = "Clear", context = "command-line" }, { kind = "tap", key = "PLEASE", holdMs = 50 } })
  inst:service(9.05); inst:service(9.2)
  rep = inst:sequenceStatus(q.id, 9.2)
  check("text then an explicit PLEASE tap: text completed, Enter pressed and released as its own step", rep.state == "completed" and rep.events[2].kind == "tap" and rep.events[2].key == "PLEASE" and backend.events[#backend.events].pcKey == "Enter" and backend.events[#backend.events].kind == "release", J(rep.events))
  profile.shortcutsActive = true
  -- No char events on an adapter without them.
  local bare = { name = "fake", dispatches = true, press = function() return true, true end, release = function() return true, true end }
  local inst2 = HK.new({ owner = "x", deps = deps }):init(); inst2:enableInput(bare); inst2:openSession({ id = "s" }, 0)
  profile.shortcutsActive = false
  q, err = inst2:startSequence("s", 0, { { kind = "text", text = "a", context = "command-line" } })
  check("a backend without char events refuses text", q == nil and err.code == "unsupported" and err.message:find("character events"), J(err))
  profile.shortcutsActive = true
end

print(string.format("%d passed, %d failed", passes, failures))
print(failures == 0 and "ALL PASSED" or "FAILED")
os.exit(failures == 0 and 0 or 1)
