-- Regression harness for plugin/gma3_mcp_control.lua (KB-18) under stock Lua.
--
-- The module is loaded the way the bridge loads it (a plain chunk returning a module table) with no
-- console API at all. The binding source is a hand-built gma3_mcp_feedback contextSnapshot() shape
-- the test mutates between calls; the backend is the module's fake backend.
--
-- Run from the repository root:   lua test/lua/control_admission_test.lua

local here = (arg and arg[0] or ""):match("^(.*)[/\\]") or "."
package.path = here .. "/?.lua;" .. package.path
local json = require("json")

local failures, passes = 0, 0
local function check(name, cond, detail)
  if cond then passes = passes + 1; print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end
local function J(t) return json.encode(t) end

local strict = setmetatable({}, { __index = function(_, k) error("module touched global '" .. tostring(k) .. "' while loading") end })
local file = here .. "/../../plugin/gma3_mcp_control.lua"
local f = assert(io.open(file, "rb")); local src = f:read("a"); f:close()
local env = setmetatable({}, { __index = function(_, k) local v = _G[k]; if v ~= nil then return v end; return strict[k] end })
local signals = {}
local CTL = assert(load(src, "=gma3_mcp_control.lua", "t", env))("test_plugin", "gma3_mcp_control", signals, nil)

-------------------------------------------------------------------------------
-- Loading contract
-------------------------------------------------------------------------------
check("module loads without console API", type(CTL) == "table" and CTL.VERSION == "0.5.0" and CTL.API_VERSION == 1 and type(CTL.new) == "function")
check("module table is read-only", not pcall(function() CTL.x = 1 end) and CTL.x == nil)
check("module registers in the signal table", signals.__gma3_mcp_modules.gma3_mcp_control == CTL)
check("publishes nothing globally", package.loaded.gma3_mcp_control == nil and _G.gma3_mcp_control == nil)
check("new() needs an owner", not pcall(CTL.new, {}) and pcall(CTL.new, { owner = "t" }))
check("new() refuses unknown and non-positive config, and a non-boolean flag", not pcall(CTL.new, { owner = "t", config = { nope = 1 } }) and not pcall(CTL.new, { owner = "t", config = { maxQueue = 0 } }) and not pcall(CTL.new, { owner = "t", config = { requireBindingRevision = 1 } }) and CTL.DEFAULT_CONFIG.requireBindingRevision == true)

-------------------------------------------------------------------------------
-- Fake binding: a feedback contextSnapshot() shape
-------------------------------------------------------------------------------
local binding = {
  generation = 1,
  encoder = { available = true, value = { context = "Default", attributeEditing = true } },
  slots = { available = true, value = { selection = { count = 2, fixtures = { 401, 402 }, identityComplete = true }, slots = {
    { slot = 1, kind = "attribute", ref = "Attribute 1 'Dimmer'", name = "Dimmer", layer = "Absolute", resolution = "Coarse", readout = "Percent", channelFunction = "Dimmer", availability = "available" },
    { slot = 2, kind = "attribute", ref = "Attribute 3 'Pan'", name = "Pan", layer = "Absolute", resolution = "Fine", readout = "Physical", channelFunction = "Pan", availability = "mixed", physicalRange = 450, physicalFrom = -225, physicalTo = 225, physicalMixed = true },
    { slot = 3, kind = "attribute", ref = "Attribute 7 'Gobo1'", name = "Gobo1", layer = "Absolute", resolution = "Coarse", readout = "Percent", channelFunction = "Gobo1", availability = "unavailable" },
    { slot = 4, kind = "other", ref = "Phaser 1", unsupported = true },
    { slot = 5, kind = "empty" } } } },
  executors = {
    { available = true, value = { executor = 201, page = { no = 1, name = "Page 1" }, pool = { name = "Default", no = 1 }, mode = "current", width = 1, empty = false, playbackTarget = true, assigned = { addr = "Sequence 1", class = "Sequence" }, functions = { keyPress = "Go+", fader = "Master" }, level = { token = "FaderMaster", value = 50 } } },
    { available = true, value = { executor = 202, page = 1, empty = false, playbackTarget = true, assigned = { addr = "Sequence 2" }, functions = { keyPress = "Toggle", fader = "X" }, level = { token = "FaderX", value = 0 } } },
    { available = true, value = { executor = 203, page = 1, empty = true } },
    { available = true, value = { executor = 204, page = 1, empty = false, playbackTarget = false, reserved = true, assigned = { addr = "Quickey 1" }, functions = { keyPress = "Toggle" } } },
    { available = false, params = { executor = 205 }, reason = "not observed yet" },
    -- KB-21: executors bound to an explicit page (params.page), read whatever page the user is on.
    { available = true, params = { executor = 201, page = 2 }, value = { executor = 201, page = { no = 2, name = "Page 2" }, pool = { name = "Default", no = 1 }, mode = "page", width = 1, empty = false, playbackTarget = true, assigned = { addr = "Sequence 9", class = "Sequence" }, functions = { keyPress = "Toggle", fader = "Master" }, level = { token = "FaderMaster", value = 10 } } },
    { available = true, params = { executor = 211, page = 2 }, value = { executor = 211, page = { no = 2, name = "Page 2" }, pool = { name = "Default", no = 1 }, mode = "page", width = 2, expanded = true, empty = false, playbackTarget = true, assigned = { addr = "Sequence 11", class = "Sequence" }, functions = { keyPress = "Go+", fader = "Master" }, level = { token = "FaderMaster", value = 0 } } },
    { available = true, params = { executor = 212, page = 2 }, value = { executor = 212, page = { no = 2, name = "Page 2" }, pool = { name = "Default", no = 1 }, mode = "page", empty = true, coveredBy = 211, coveredWidth = 2, playbackTarget = false, reason = "covered by executor 211 (width 2)" } },
    { available = true, params = { executor = 201, page = 7 }, value = { executor = 201, page = { no = 7 }, mode = "page", pageMissing = true, empty = true, playbackTarget = false, reason = "page 7 does not exist (nothing is created)" } },
  },
}
local busyOwner = nil
local function fresh(config)
  config = config or {}
  if config.requireBindingRevision == nil then config.requireBindingRevision = false end  -- a fixed binding, as the surface plugin declares
  local inst = CTL.new({ owner = "test", config = config, deps = { binding = function() return binding end, busy = function() return busyOwner end } }):init()
  local b = CTL.fakeBackend()
  inst:enableInput(b)
  return inst, b
end
local function rel(seq, slot, delta, extra)
  local e = { type = "relative", device = "nxk", control = "Rotary" .. tostring(slot), seq = seq, generation = binding.generation, target = { slot = slot }, delta = delta, gesture = 1 }
  for k, v in pairs(extra or {}) do e[k] = v end
  return e
end
local function abs(seq, exec, value, extra)
  local e = { type = "absolute", device = "mtouch", control = "Strip" .. tostring(exec), seq = seq, generation = binding.generation, target = { executor = exec, element = "fader" }, value = value, gesture = 1 }
  for k, v in pairs(extra or {}) do e[k] = v end
  return e
end
local function touch(seq, exec, down, extra)
  local e = { type = "touch", device = "mtouch", control = "Strip" .. tostring(exec), seq = seq, generation = binding.generation, target = { executor = exec, element = "fader" }, down = down, gesture = 1 }
  for k, v in pairs(extra or {}) do e[k] = v end
  return e
end
local function button(seq, slot, down)
  return { type = "button", device = "nxk", control = "Rotary" .. tostring(slot), seq = seq, generation = binding.generation, target = { slot = slot }, down = down }
end
local function code(_, err) return err and err.code end

-------------------------------------------------------------------------------
-- Lifecycle, sessions and admission
-------------------------------------------------------------------------------
do
  local inst = CTL.new({ owner = "test", config = { requireBindingRevision = false }, deps = { binding = function() return binding end } }):init()
  check("input is disabled on a new instance", inst:status().inputEnabled == false and inst:status().backend == nil)
  check("submit before enableInput is input-disabled", code(inst:submit("s", 1, rel(1, 1, 1))) == "input-disabled")
  check("enableInput needs a backend", not pcall(inst.enableInput, inst))
  inst:attachBackend(CTL.fakeBackend())
  check("attached but not enabled still refuses", code(inst:submit("s", 1, rel(1, 1, 1))) == "input-disabled")
  inst:enableInput()
  check("no session is refused", code(inst:submit("s", 1, rel(1, 1, 1))) == "no-session")
  local s = inst:openSession({ id = "s", leaseMs = 1000 }, 10)
  check("openSession returns the view", s and s.id == "s" and s.remainingMs == 1000 and s.state == "active", J(s))
  check("a second open of the same id is refused while active", code(inst:openSession({ id = "s" }, 10.5)) == "session-exists")
  check("bad lease is refused", code(inst:openSession({ id = "t", leaseMs = 10 ^ 9 }, 10)) == "bad-args")
  local r = inst:submit("s", 10.1, rel(1, 1, 2))
  check("a valid relative event is admitted and queued", r and r.accepted and r.queued == 1 and r.target:find("^slot1") and r.generation == 1, J(r))
  check("renew moves the lease", inst:renewSession("s", 10.5, 2000).remainingMs == 2000)
  check("lease expiry refuses and drops the queue", code(inst:submit("s", 13, rel(2, 1, 1))) == "lease-expired" and inst:status(13).sessions.s == nil and inst:status().counters.dropped == 1)
  check("expired session can be reopened", inst:openSession({ id = "s" }, 13) ~= nil)
  check("closeSession reports the dropped queue", (function() inst:submit("s", 13.1, rel(1, 1, 1)); local c = inst:closeSession("s", 13.2); return c and c.dropped == 1 and c.session == "s" end)())
  check("close of an unknown session is no-session", code(inst:closeSession("zz", 14)) == "no-session")
  check("dispose ends input", inst:dispose(15).dropped == 0 and not pcall(inst.status, inst) and not pcall(inst.submit, inst, "s", 16, rel(1, 1, 1)))
end

-------------------------------------------------------------------------------
-- Event validation
-------------------------------------------------------------------------------
do
  local inst = fresh()
  inst:openSession({ id = "s" }, 1)
  local bad = {
    { "no type", { device = "d", control = "c", seq = 1 } },
    { "unknown type", { type = "wheel", device = "d", control = "c", seq = 1 } },
    { "no device", rel(1, 1, 1, { device = "" }) },
    { "seq 0", rel(0, 1, 1) },
    { "zero delta", rel(1, 1, 0) },
    { "huge delta", rel(1, 1, 5000) },
    { "value > 1", abs(1, 201, 1.5) },
    { "touch without down", touch(1, 201, nil) },
    { "bad target", rel(1, 1, 1, { target = { slot = 0 } }) },
    { "bad element", abs(1, 201, 0.5, { target = { executor = 201, element = "led" } }) },
    { "non-integer generation", rel(1, 1, 1, { generation = 1.5 }) },
  }
  local allBad = true
  for _, b in ipairs(bad) do
    local c = code(inst:submit("s", 1, b[2]))
    if c ~= "bad-event" then allBad = false; print("  " .. b[1] .. " -> " .. tostring(c)) end
  end
  check("every malformed event is bad-event and nothing is queued", allBad and inst:status().sessions.s.queued == 0 and inst:status().counters.refused == #bad)
end

-------------------------------------------------------------------------------
-- Per-device ordering: duplicates, reordering, loss
-------------------------------------------------------------------------------
do
  local inst, b = fresh()
  inst:openSession({ id = "s" }, 1)
  check("first event sets the origin (no loss)", inst:submit("s", 1, rel(5, 1, 1)).lost == 0)
  check("a repeated seq is a duplicate", code(inst:submit("s", 1, rel(5, 1, 1))) == "duplicate")
  check("a gap is accepted and reported as loss", inst:submit("s", 1.01, rel(8, 1, 1)).lost == 2)
  local _, err = inst:submit("s", 1.02, rel(7, 1, 1))
  check("an older seq after a newer one is out-of-order (never applied late)", err and err.code == "out-of-order" and err.last == 8, J(err))
  check("far behind the window counts as duplicate", (function()
    inst:submit("s", 1.03, rel(200, 1, 1, { device = "far" })); inst:submit("s", 1.03, rel(300, 1, 1, { device = "far" }))
    return code(inst:submit("s", 1.03, rel(100, 1, 1, { device = "far" }))) == "duplicate" end)())
  check("another device has its own order", inst:submit("s", 1.04, rel(1, 2, 1, { device = "other" })).lost == 0)
  local st = inst:status(1.05).sessions.s
  check("device counters: lost, duplicates, reordered", st.devices.nxk.lost == 2 and st.devices.nxk.duplicates == 1 and st.devices.nxk.reordered == 1 and st.devices.far.duplicates == 1 and st.counters.lost == 101 and st.queued == 3, J(st.devices))
  inst:service(1.1)
  check("loss travels with the applied intent; devices never merge", b.intents[1].lost == 2 and b.intents[1].events == 2 and b.intents[1].delta == 2 and b.intents[2].device == "far" and b.intents[2].lost == 99, J(b.intents))
  -- Touch/button releases also obey the order: a stale press after its release is dropped.
  check("release then stale press: press is out-of-order", inst:submit("s", 2, touch(20, 201, false)).noop and code(inst:submit("s", 2, touch(19, 201, true))) == "out-of-order")
  check("sessions keep their own device order", (function() inst:openSession({ id = "t" }, 2); return inst:submit("t", 2, rel(1, 1, 1)).lost == 0 end)())
end

-------------------------------------------------------------------------------
-- Binding: unknown, stale generation, target resolution
-------------------------------------------------------------------------------
do
  local inst = fresh()
  inst:openSession({ id = "s" }, 1)
  local saved = binding.generation
  binding.generation = nil; binding.generationNote = "no generation: 2 item(s) not observed"
  local _, err = inst:submit("s", 1, rel(1, 1, 1, { generation = 1 }))
  check("no claimed generation refuses motion as binding-unknown", err and err.code == "binding-unknown" and err.message:find("not observed"), J(err))
  binding.generation, binding.generationNote = saved, nil
  _, err = inst:submit("s", 1, rel(2, 1, 1, { generation = 7 }))
  check("a stale generation is refused with the current one", err and err.code == "stale-generation" and err.generation == 1 and err.eventGeneration == 7, J(err))
  check("missing generation is stale too", (function() local e = rel(3, 1, 1); e.generation = nil; return code(inst:submit("s", 1, e)) == "stale-generation" end)())
  check("slot 2 (mixed) is admitted and flagged", (function() local r = inst:submit("s", 1, rel(4, 2, 1)); return r and r.mixed == true end)())
  check("slot 3 (unavailable) is refused with the availability", (function() local _, e = inst:submit("s", 1, rel(5, 3, 1)); return e.code == "target-unavailable" and e.availability == "unavailable" end)())
  check("slot 4 (phaser) is unsupported", code(inst:submit("s", 1, rel(6, 4, 1))) == "unsupported")
  check("slot 5 (empty) is unavailable", code(inst:submit("s", 1, rel(7, 5, 1))) == "target-unavailable")
  check("slot 9 (off the page) is unavailable", code(inst:submit("s", 1, rel(8, 9, 1))) == "target-unavailable")
  check("executor fader 201 resolves with the Master token", (function() local r = inst:submit("s", 1, abs(1, 201, 0.5)); return r and r.accepted and r.target:find("^exec[^/]*/1%.201%.fader") and r.stateful == nil end)())
  check("executor 202 crossfade is stateful", inst:submit("s", 1, abs(2, 202, 0.5, { control = "Strip202" })).stateful == true)
  check("executor key element needs keyPress", inst:submit("s", 1, abs(3, 201, 0.5, { target = { executor = 201, element = "key" } })).accepted == true and
        code(inst:submit("s", 1, abs(4, 201, 0.5, { target = { executor = 201, element = "encoder" } }))) == "target-unavailable")
  check("empty executor 203 is unavailable", code(inst:submit("s", 1, abs(5, 203, 0.5, { control = "Strip203" }))) == "target-unavailable")
  check("reserved/Quickey executor 204 is never a target", (function() local _, e = inst:submit("s", 1, abs(6, 204, 0.5, { control = "Strip204" })); return e.code == "target-unavailable" and e.message:find("not a playback target") end)())
  check("unobserved executor 205 carries the reason", (function() local _, e = inst:submit("s", 1, abs(7, 205, 0.5, { control = "Strip205" })); return e.code == "target-unavailable" and e.message:find("not observed") end)())
  check("an executor outside the binding says bind first", (function() local _, e = inst:submit("s", 1, abs(8, 299, 0.5, { control = "Strip299" })); return e.code == "target-unavailable" and e.message:find("bind it first") end)())
  check("no selection on a slot is explicit", (function()
    local a = binding.slots.value.slots[1].availability; binding.slots.value.slots[1].availability = "no-selection"
    local _, e = inst:submit("s", 1, rel(9, 1, 1)); binding.slots.value.slots[1].availability = a
    return e.code == "target-unavailable" and e.message:find("no fixture is selected") end)())
  check("slots unavailable as a whole carries the reason", (function()
    local s = binding.slots; binding.slots = { available = false, reason = "display 2 has an encoder bar without EncoderBankSelector/PresetBar" }
    local _, e = inst:submit("s", 1, rel(10, 1, 1)); binding.slots = s
    return e.code == "target-unavailable" and e.message:find("EncoderBankSelector") end)())
  check("a raising binding source is binding-unknown", (function()
    local i2 = CTL.new({ owner = "t", deps = { binding = function() error("boom") end } }):init(); i2:enableInput(CTL.fakeBackend()); i2:openSession({ id = "s" }, 1)
    local _, e = i2:submit("s", 1, rel(1, 1, 1)); return e.code == "binding-unknown" and e.message:find("boom") end)())
  check("no binding source at all is binding-unknown", (function()
    local i2 = CTL.new({ owner = "t" }):init(); i2:enableInput(CTL.fakeBackend()); i2:openSession({ id = "s" }, 1)
    return code(i2:submit("s", 1, rel(1, 1, 1))) == "binding-unknown" end)())
end

-------------------------------------------------------------------------------
-- Coalescing
-------------------------------------------------------------------------------
do
  local inst, b = fresh()
  inst:openSession({ id = "s" }, 1)
  inst:submit("s", 1.000, rel(1, 1, 1)); inst:submit("s", 1.005, rel(2, 1, 2)); local r = inst:submit("s", 1.010, rel(3, 1, -1))
  check("same target/generation/resolution/gesture merges into one intent", r.coalesced == true and r.queued == 1 and inst:status().sessions.s.queued == 1 and inst:status().counters.coalesced == 2, J(r))
  inst:submit("s", 1.015, rel(4, 2, 1))
  check("another target is a new intent", inst:status().sessions.s.queued == 2)
  inst:submit("s", 1.020, rel(5, 2, 1, { gesture = 2 }))
  check("a new gesture id never merges", inst:status().sessions.s.queued == 3)
  inst:submit("s", 1.025, rel(6, 2, 1, { gesture = 2, fine = true }))
  check("the fine flag splits intents", inst:status().sessions.s.queued == 4)
  inst:submit("s", 1.030, button(7, 2, true))
  inst:submit("s", 1.035, rel(8, 2, 1, { gesture = 2, fine = true }))
  check("a button is a boundary: motion after it is a new intent", inst:status().sessions.s.queued == 6)
  inst:submit("s", 1.040, rel(9, 2, 1, { gesture = 2, fine = true }))
  check("motion after the boundary merges again among itself", inst:status().sessions.s.queued == 6)
  local out = inst:service(1.05)
  check("service applies at most maxWorkPerService (4) in order", out.applied == 4 and out.pending == 2 and out.work == 4, J(out))
  check("the first applied intent is the merged delta 2 over 3 events", b.intents[1].delta == 2 and b.intents[1].events == 3 and b.intents[1].kind == "relative", J(b.intents[1]))
  check("fine flag and gesture travel with the intent", b.intents[4].fine == true and b.intents[4].gesture == 2, J(b.intents[4]))
  out = inst:service(1.06)
  check("the rest follows: button then the post-boundary delta", out.applied == 2 and b.intents[5].kind == "button" and b.intents[5].down == true and b.intents[6].delta == 2, J(b.intents))
  -- A changed resolution in the binding changes the generation upstream; locally, a different resolution never merges.
  inst:submit("s", 1.07, rel(10, 1, 1))
  local saved = binding.slots.value.slots[1].resolution
  binding.slots.value.slots[1].resolution = "Fine"
  inst:submit("s", 1.071, rel(11, 1, 1))
  binding.slots.value.slots[1].resolution = saved
  check("a different resolution never merges", inst:status().sessions.s.queued == 2)
  -- Applying intents while the binding generation is the same still works after a boundary from another device.
  inst:service(1.08)
  check("counters: admitted/applied/coalesced", (function() local c = inst:status().counters; return c.admitted == 11 and c.applied == 8 and c.coalesced == 3 end)(), J(inst:status().counters))
end

-------------------------------------------------------------------------------
-- Absolute supersession, stateful functions, endpoints
-------------------------------------------------------------------------------
do
  local inst, b = fresh()
  inst:openSession({ id = "s" }, 1)
  inst:submit("s", 1, abs(1, 201, 0.1)); inst:submit("s", 1, abs(2, 201, 0.2)); local r = inst:submit("s", 1, abs(3, 201, 0.3))
  check("a Master fader position supersedes the queued one", r.superseded == 2 and inst:status().sessions.s.queued == 1, J(r))
  inst:service(1.01)
  check("only the newest value is applied", #b.intents == 1 and b.intents[1].value == 0.3 and b.intents[1].superseded == 2, J(b.intents))
  inst:submit("s", 1.02, abs(4, 202, 0, { control = "Strip202" })); inst:submit("s", 1.02, abs(5, 202, 0.5, { control = "Strip202" })); r = inst:submit("s", 1.02, abs(6, 202, 1, { control = "Strip202" }))
  check("a crossfade keeps every position in order", r.superseded == nil and inst:status().sessions.s.queued == 3)
  inst:service(1.03)
  check("endpoints 0 and 1 of the crossfade are both applied", b.intents[2].value == 0 and b.intents[3].value == 0.5 and b.intents[4].value == 1)
  inst:submit("s", 1.04, abs(7, 201, 0.4)); inst:submit("s", 1.04, touch(8, 201, true)); r = inst:submit("s", 1.04, abs(9, 201, 0.6))
  check("a touch boundary stops supersession", r.superseded == nil and inst:status().sessions.s.queued == 3)
  check("a release with nothing down is a noop, not a boundary", (function() inst:submit("s", 1.05, touch(10, 201, false)); local rr = inst:submit("s", 1.05, touch(11, 201, false)); return rr.noop == true and inst:status().sessions.s.queued == 4 end)())
  check("a different generation is not superseded", (function()
    local i2, b2 = fresh(); i2:openSession({ id = "s" }, 1); i2:submit("s", 1, abs(1, 201, 0.1)); binding.generation = 2; i2:submit("s", 1, abs(2, 201, 0.2, { generation = 2 }))
    local q = i2:status().sessions.s.queued; local out = i2:service(1.01); binding.generation = 1
    return q == 2 and out.dropped.staleGeneration == 1 and out.applied == 1 and b2.intents[1].value == 0.2 end)())
end

-------------------------------------------------------------------------------
-- Bounds: queue, eviction, age, rate, holds, gesture duration
-------------------------------------------------------------------------------
do
  local inst, b = fresh({ maxQueue = 4, maxEventAgeMs = 100, maxEventsPerSecond = 5, maxHolds = 2, maxGestureMs = 1000, maxWorkPerService = 10 })
  inst:openSession({ id = "s" }, 1)
  inst:submit("s", 1, touch(1, 201, true))
  inst:submit("s", 1, rel(1, 1, 1, { gesture = 1 })); inst:submit("s", 1, rel(2, 1, 1, { gesture = 2 })); inst:submit("s", 1, rel(3, 1, 1, { gesture = 3 }))
  local _, e = inst:submit("s", 1, rel(4, 1, 1, { gesture = 4 }))
  check("a full queue refuses motion (queue-full), never defers", e and e.code == "queue-full" and e.queued == 4, J(e))
  check("a touch down is bounded like motion (its release is then a noop, never a stuck hold)", code(inst:submit("s", 1, touch(2, 202, true, { control = "Strip202" }))) == "queue-full" and inst:submit("s", 1, touch(3, 202, false, { control = "Strip202" })).noop == true)
  local r = inst:submit("s", 1, touch(4, 201, false))
  check("a release always gets in, evicting the session's oldest motion", r.accepted and r.evicted == 1 and r.boundary and inst:status().sessions.s.queued == 4 and inst:status().counters.evicted == 1, J(r))
  check("the evicted intent was the oldest motion, the touch down stays first", inst:service(1.01).applied == 4 and b.intents[1].kind == "touch" and b.intents[2].gesture == 2 and b.intents[4].down == false)
  check("the rate bound drops the 6th motion event in a second", (function()
    local i2 = fresh({ maxEventsPerSecond = 5 }); i2:openSession({ id = "s" }, 1)
    local last
    for i = 1, 6 do last = select(2, i2:submit("s", 1 + i * 0.01, rel(i, 1, 1))) end
    local st = i2:status().sessions.s
    local later = i2:submit("s", 2.5, rel(7, 1, 1))
    return last and last.code == "rate" and st.devices.nxk.rateDropped == 1 and st.devices.nxk.last == 6 and later.accepted end)())
  check("releases are never rate-refused", (function()
    local i2 = fresh({ maxEventsPerSecond = 1 }); i2:openSession({ id = "s" }, 1)
    i2:submit("s", 1, touch(1, 201, true)); i2:submit("s", 1.01, abs(2, 201, 0.5)); i2:submit("s", 1.02, abs(3, 201, 0.6))
    local rr = i2:submit("s", 1.03, touch(4, 201, false)); return rr.accepted and rr.boundary end)())
  check("old motion is dropped as expired when applied, not applied late", (function()
    local i2, b2 = fresh({ maxEventAgeMs = 100 }); i2:openSession({ id = "s" }, 1)
    i2:submit("s", 1, rel(1, 1, 1)); i2:submit("s", 1.05, rel(2, 1, 1))
    local out = i2:service(1.2)
    return out.dropped.expired == 1 and #b2.intents == 0 and i2:status().counters.expired == 1 end)())
  check("releases never expire", (function()
    local i2, b2 = fresh({ maxEventAgeMs = 10 }); i2:openSession({ id = "s" }, 1)
    i2:submit("s", 1, touch(1, 201, true)); i2:submit("s", 1, touch(2, 201, false))
    local out = i2:service(5); return out.applied == 2 and b2.intents[2].down == false end)())
  check("maxHolds caps touches and buttons down", (function()
    local i2 = fresh({ maxHolds = 2 }); i2:openSession({ id = "s" }, 1)
    i2:submit("s", 1, touch(1, 201, true)); i2:submit("s", 1, touch(2, 202, true, { control = "Strip202" }))
    return code(i2:submit("s", 1, button(1, 1, true))) == "capacity" end)())
  check("a touch down beyond maxGestureMs is force-ended through the backend", (function()
    local i2, b2 = fresh({ maxGestureMs = 1000 }); i2:openSession({ id = "s", leaseMs = 60000 }, 1)
    i2:submit("s", 1, touch(1, 201, true)); i2:service(1.01)
    local out = i2:service(2.5)
    return #out.ended == 1 and out.ended[1].reason == "max-gesture" and b2.intents[2].down == false and b2.intents[2].forced == true and i2:status().sessions.s.gestures == 0 end)())
  check("the work bound is per service(), the rest stays pending in order", (function()
    local i2, b2 = fresh({ maxWorkPerService = 2 }); i2:openSession({ id = "s" }, 1)
    for i = 1, 5 do i2:submit("s", 1, rel(i, 1, 1, { gesture = i })) end
    local o1 = i2:service(1.01); local o2 = i2:service(1.02); local o3 = i2:service(1.03)
    return o1.applied == 2 and o1.pending == 3 and o2.applied == 2 and o3.applied == 1 and o3.pending == 0 and b2.intents[5].gesture == 5 end)())
  local _ = b
end

-------------------------------------------------------------------------------
-- Generation changes while queued or touched; gesture rebound
-------------------------------------------------------------------------------
do
  local inst, b = fresh()
  inst:openSession({ id = "s" }, 1)
  inst:submit("s", 1, rel(1, 1, 3))
  binding.generation = 2
  local out = inst:service(1.01)
  check("queued motion is dropped when the generation moved before it was applied", out.dropped.staleGeneration == 1 and out.applied == 0 and #b.intents == 0 and inst:status().counters.staleDropped == 1, J(out))
  check("a fresh gesture against the new generation is admitted", inst:submit("s", 1.02, rel(2, 1, 1, { generation = 2, gesture = 2 })).accepted and inst:service(1.03).applied == 1)
  -- A touch that stays down across a generation change must be lifted first.
  inst:submit("s", 1.1, touch(1, 201, true, { generation = 2 }))
  inst:submit("s", 1.1, abs(2, 201, 0.5, { generation = 2 }))
  binding.generation = 3
  out = inst:service(1.11)
  check("the position queued under the old generation is dropped", out.dropped.staleGeneration == 1 and inst:status().sessions.s.gestureList[1].rebound == true, J(inst:status().sessions.s.gestureList))
  local _, e = inst:submit("s", 1.12, abs(3, 201, 0.6, { generation = 3 }))
  check("motion while the rebound touch is down is refused (gesture-rebound)", e and e.code == "gesture-rebound", J(e))
  check("the release is still admitted and applied", inst:submit("s", 1.13, touch(4, 201, false)).accepted and inst:service(1.14).applied == 1 and b:last().down == false)
  check("after re-touching the new target is controlled", inst:submit("s", 1.15, touch(5, 201, true, { generation = 3 })).accepted and inst:submit("s", 1.15, abs(6, 201, 0.6, { generation = 3 })).accepted)
  binding.generation = 1
end

-------------------------------------------------------------------------------
-- Serialisation: conflicts between sessions, other owners, the busy descriptor
-------------------------------------------------------------------------------
do
  local inst, b = fresh({ gestureIdleMs = 200 })
  inst:openSession({ id = "a" }, 1); inst:openSession({ id = "b" }, 1)
  inst:submit("a", 1, touch(1, 201, true))
  local _, e = inst:submit("b", 1, abs(1, 201, 0.5))
  check("a touched target is refused to another session (conflict with owner)", e and e.code == "conflict" and e.owner == "a", J(e))
  check("another target is fine for the other session", inst:submit("b", 1, abs(2, 202, 0.5, { control = "Strip202" })).accepted)
  check("admission reports the touch as busy", (function() local bz = inst:admission(1); return bz and bz.reason == "touch-down" and bz.owner == "a" end)())
  inst:submit("a", 1.01, touch(2, 201, false))
  check("after the release the other session may take the target", inst:submit("b", 1.02, abs(3, 201, 0.5)).accepted)
  inst:service(1.03)
  check("relative motion keeps the target for gestureIdleMs", (function()
    inst:submit("a", 2, rel(1, 1, 1)); inst:service(2.01)
    local _, c1 = inst:submit("b", 2.1, rel(1, 1, 1, { device = "nxk2" }))
    local bz = inst:admission(2.1)
    local ok2 = inst:submit("b", 2.3, rel(2, 1, 1, { device = "nxk2" }))
    return c1 and c1.code == "conflict" and bz and bz.reason == "motion" and bz.remainingMs > 0 and ok2.accepted end)())
  inst:service(2.31)
  check("admission reports queued work", (function() inst:submit("a", 3, rel(2, 2, 1)); local bz = inst:admission(3.6); return bz and bz.reason == "queued" and bz.owner == "a" end)())
  inst:service(3.61)
  check("idle instance is not busy", inst:admission(4.5) == nil)
  busyOwner = { code = "busy", reason = "interaction", owner = "conn-9", description = "interaction i1 of session conn-9" }
  _, e = inst:submit("a", 5, rel(3, 1, 1))
  check("another input owner (hardkeys) refuses motion as busy", e and e.code == "busy" and e.owner == "conn-9", J(e))
  busyOwner.owner = "a"
  check("the same owner is allowed", inst:submit("a", 5.01, rel(4, 1, 1)).accepted)
  busyOwner = nil
  check("a release is admitted even while another owner is busy", (function()
    inst:submit("a", 5.1, button(5, 1, true)); busyOwner = { code = "busy", owner = "x", description = "x" }
    local r = inst:submit("a", 5.2, button(6, 1, false)); busyOwner = nil; return r.accepted end)())
  local _ = b
end

-------------------------------------------------------------------------------
-- Lease expiry, close, disable and dispose end gestures; backend faults
-------------------------------------------------------------------------------
do
  local inst, b = fresh()
  inst:openSession({ id = "s", leaseMs = 1000 }, 1)
  inst:submit("s", 1, touch(1, 201, true)); inst:submit("s", 1, button(1, 1, true)); inst:submit("s", 1, abs(2, 201, 0.5))
  local out = inst:service(2.5)
  check("lease expiry ends every gesture through the backend and drops the queue", #out.expired == 1 and #out.ended == 2 and b.intents[#b.intents].forced == true and b.intents[#b.intents].reason == "lease-expired" and inst:status().sessions.s == nil and inst:status().counters.dropped == 3, J(out))
  check("the dropped position was never applied", (function() for _, i in ipairs(b.intents) do if i.kind == "absolute" then return false end end return true end)())
  inst:openSession({ id = "s" }, 3)
  inst:submit("s", 3, touch(1, 201, true, { device = "m2" }))
  local c = inst:closeSession("s", 3.1, "disconnect")
  check("closeSession ends the touch with the reason", #c.ended == 1 and c.ended[1].reason == "disconnect" and c.ended[1].outcome == "applied")
  inst:openSession({ id = "s" }, 4)
  inst:submit("s", 4, touch(1, 201, true, { device = "m3" }))
  local d = inst:disableInput(4.1, "operator")
  check("disableInput ends gestures and refuses new input", #d.ended == 1 and code(inst:submit("s", 4.2, rel(1, 1, 1))) == "input-disabled")
  inst:enableInput()
  inst:submit("s", 4.3, touch(2, 201, true, { device = "m3" }))
  b:raiseNext("touch", "Keyboard raised")
  c = inst:closeSession("s", 4.4)
  check("a release the backend raises on is unresolved and kept", #c.unresolved == 1 and c.ended[1].outcome == "unresolved" and #inst:status().unresolved == 1 and inst:status().unresolved[1].error:find("raised"), J(c))
  b:raiseNext("touch", "still raising")
  local rc = inst:recover(4.5)
  check("recover re-attempts and keeps what still fails", #rc.unresolved == 1 and rc.unresolved[1].attempts == 2)
  rc = inst:recover(4.6)
  check("recover resolves once the backend applies", #rc.resolved == 1 and #inst:status().unresolved == 0 and b:last().reason == "recover")
  inst:openSession({ id = "s" }, 5)
  b:failNext("relative", "not now")
  inst:submit("s", 5, rel(1, 1, 1))
  out = inst:service(5.01)
  check("a backend refusal drops the intent and is counted", out.dropped.refused == 1 and inst:status().counters.backendRefused == 1 and inst:status().lastApplied.outcome == "refused")
  b:raiseNext("relative", "raise on motion")
  inst:submit("s", 5.02, rel(2, 1, 1))
  out = inst:service(5.03)
  check("a raise on motion is reported unresolved but kept as no record (nothing to release)", #out.unresolved == 1 and #inst:status().unresolved == 0 and inst:status().counters.unresolved == 3)
  inst:submit("s", 5.1, button(3, 1, true))
  local dsp = inst:dispose(5.2)
  check("dispose ends the button and hands back records", #dsp.ended == 1 and dsp.ended[1].reason == "dispose" and #dsp.records == 0)
  local i2 = fresh()
  check("adopt takes release records from a previous instance", i2:adopt({ { kind = "touch", session = "old", device = "m", control = "S1", target = { executor = 201, element = "fader" } }, { kind = "relative" } }, 6).adopted == 1 and #i2:status().unresolved == 1)
  check("recover applies adopted records through the new backend", #i2:recover(6.1).resolved == 1)
end

-------------------------------------------------------------------------------
-- Review findings (PR #22): late releases, release capacity, recovery batches, rebound holds, stale
-- and replaced bindings
-------------------------------------------------------------------------------
do
  -- (1) a delayed release after another control advanced the device sequence still ends its hold.
  local inst, b = fresh()
  inst:openSession({ id = "s" }, 1)
  local function holds(i, t) local n = 0; for _, g in ipairs(i:status(t).sessions.s.gestureList) do if g.kind == "touch" or g.kind == "button" then n = n + 1 end end return n end
  check("review 1: button down (seq 1), another control's motion (seq 3), the delayed release (seq 2) is admitted late and ends the hold",
    inst:submit("s", 1, button(1, 1, true)).accepted and inst:submit("s", 1.01, rel(3, 2, 1)).lost == 1 and (function()
      local r = inst:submit("s", 1.02, button(2, 1, false)); return r and r.accepted and r.late == true and r.boundary end)()
    and holds(inst, 1.03) == 0 and inst:status(1.03).sessions.s.devices.nxk.late == 1 and inst:status(1.03).sessions.s.devices.nxk.lost == 0, J(inst:status(1.03).sessions.s.devices))
  check("review 1: the late release is remembered (a repeat is a duplicate) and the device's newest sequence did not move back", code(inst:submit("s", 1.04, button(2, 1, false))) == "duplicate" and inst:status().sessions.s.devices.nxk.last == 3)
  check("review 1: a late release older than the hold's own press is still out-of-order (it would end a newer hold)", (function()
    inst:submit("s", 1.1, button(5, 1, true)); inst:submit("s", 1.1, rel(7, 2, 1))
    return code(inst:submit("s", 1.11, button(4, 1, false))) == "out-of-order" and holds(inst, 1.11) == 1 end)())
  check("review 1: a late release with no hold to end stays out-of-order (nothing to act on, nothing applied late)", (function()
    inst:submit("s", 1.2, button(8, 1, false)); inst:service(1.21)
    local e = button(6, 3, false); e.control = "Rotary3"
    return code(inst:submit("s", 1.22, e)) == "out-of-order" end)())
  -- (2) a queue holding only boundaries cannot lose a release; ownership survives a refused release.
  local i2, b2 = fresh({ maxQueue = 1, maxHolds = 2 })
  i2:openSession({ id = "s" }, 1)
  i2:submit("s", 1, touch(1, 201, true)); i2:service(1.01)
  i2:submit("s", 1.02, touch(2, 202, true, { control = "Strip202" })); i2:service(1.03)
  i2:submit("s", 1.04, rel(1, 1, 1))  -- the queue is full of motion
  check("review 2: two holds, a full queue: the first release evicts the motion, the second uses the reserve; neither raises and both holds end", (function()
    local okc, r1 = pcall(i2.submit, i2, "s", 1.05, touch(3, 201, false)); local okd, r2 = pcall(i2.submit, i2, "s", 1.05, touch(4, 202, false, { control = "Strip202" }))
    return okc and okd and r1 and r1.accepted and r1.evicted == 1 and r2 and r2.accepted and r2.evicted == nil and i2:status().sessions.s.queued == 2 and holds(i2, 1.06) == 0 end)())
  check("review 2: when even the reserve is used the release is refused queue-full, the hold stays owned and nothing raises", (function()
    local i3 = fresh({ maxQueue = 1, maxHolds = 1 }); i3:openSession({ id = "s" }, 1)
    i3:submit("s", 1, button(1, 1, true)); i3:service(1.01)
    local sess = i3._sessions.s
    for i = 1, 2 do sess.queue[#sess.queue + 1] = { kind = "touch", down = false, session = "s", id = "x" .. i } end  -- only boundaries, maxQueue + maxHolds of them
    local okc, r, e = pcall(i3.submit, i3, "s", 1.02, button(2, 1, false))
    local kept = holds(i3, 1.03) == 1
    sess.queue = {}
    local again = i3:submit("s", 1.04, button(2, 1, false))
    return okc and r == nil and e and e.code == "queue-full" and kept and again and again.accepted and again.boundary end)())
  -- (3) recovery iterates a detached batch: a persistent raise is retried once per recover(), never looped.
  local i5, b5 = fresh()
  i5:openSession({ id = "s" }, 1)
  i5:submit("s", 1, touch(1, 201, true)); i5:service(1.01)
  b5:raiseNext("touch", "raise 1"); i5:closeSession("s", 1.02)
  check("review 3: one unresolved record after the close", #i5:status().unresolved == 1 and b5.counters.touch == 1)
  local calls = 0
  local realApply = getmetatable(b5).__index.apply
  b5.apply = function(self, intent, now) calls = calls + 1; error("always", 0) end
  local rc = i5:recover(1.1)
  check("review 3: a backend that always raises is called once per record per recover(), the record retained once", calls == 1 and #rc.unresolved == 1 and #i5:status().unresolved == 1 and rc.unresolved[1].attempts == 2 and rc.unresolved[1].error == "always", J(rc))
  rc = i5:recover(1.2)
  check("review 3: the next recover() tries once more", calls == 2 and #i5:status().unresolved == 1 and rc.unresolved[1].attempts == 3)
  b5.apply = realApply
  check("review 3: it resolves once the backend applies", #i5:recover(1.3).resolved == 1 and #i5:status().unresolved == 0)
  -- (4) a held touch is rebound by the generation change itself, whether or not motion was queued.
  local i6 = fresh()
  i6:openSession({ id = "s" }, 1)
  i6:submit("s", 1, touch(1, 201, true)); i6:service(1.01)
  binding.generation = 2
  local _, e4 = i6:submit("s", 1.02, abs(2, 201, 0.5, { generation = 2 }))
  check("review 4: motion with the new generation under a touch held from the old one is gesture-rebound (empty queue)", e4 and e4.code == "gesture-rebound" and e4.heldGeneration == 1 and e4.generation == 2, J(e4))
  check("review 4: the hold is marked rebound and release + re-touch is the way back", i6:status(1.03).sessions.s.gestureList[1].rebound == true and i6:submit("s", 1.04, touch(3, 201, false)).accepted and i6:submit("s", 1.05, touch(4, 201, true, { generation = 2 })).accepted and i6:submit("s", 1.05, abs(5, 201, 0.5, { generation = 2 })).accepted)
  binding.generation = 1
  -- (5) stale snapshots are not a binding.
  local i7, b7 = fresh()
  i7:openSession({ id = "s" }, 1)
  binding.stale = true
  local _, e5 = i7:submit("s", 1, rel(1, 1, 1))
  check("review 5: a stale snapshot refuses motion as binding-unknown with the reason", e5 and e5.code == "binding-unknown" and e5.stale == true and e5.message:find("stale"), J(e5))
  binding.stale = nil
  i7:submit("s", 1.01, rel(2, 1, 1))
  binding.stale = true
  local out5 = i7:service(1.02)
  check("review 5: motion queued before the snapshot went stale is dropped at apply time, not applied", out5.dropped.staleGeneration == 1 and #b7.intents == 0, J(out5))
  binding.stale = nil
  -- (6) a replaced binding with the same generation number is a new revision: old events and queued work are refused/dropped.
  local i8, b8 = fresh()
  i8:openSession({ id = "s" }, 1)
  binding.bindingKey = "display=1;executors=201"
  local info = i8:bindingInfo(1)
  check("review 6: bindingInfo reports revision 1 for the first key", info.revision == 1 and info.key == "display=1;executors=201" and info.generation == 1, J(info))
  i8:submit("s", 1, rel(1, 1, 1, { binding = 1 })); i8:submit("s", 1, touch(1, 201, true, { binding = 1 }))
  binding.bindingKey = "display=1;executors=202"   -- a different spec whose generation is also 1
  local _, e6 = i8:submit("s", 1.01, rel(2, 1, 1, { binding = 1 }))
  check("review 6: an event carrying the old revision is stale-binding with the new revision; the queue was dropped and the hold rebound", e6 and e6.code == "stale-binding" and e6.binding == 2 and i8:status(1.02).sessions.s.queued == 0 and i8:status(1.02).counters.staleDropped == 2 and i8:status(1.02).sessions.s.gestureList[1].rebound == true, J(e6))
  check("review 6: an event without a revision but the right generation is admitted (consumers with a fixed spec); the record carries revision 2", (function() local r = i8:submit("s", 1.03, rel(3, 1, 1)); i8:service(1.04); return r and r.accepted and b8.intents[1].binding == 2 end)())
  check("review 6: the revision is monotonic and an unknown binding reports it with the reason", (function()
    binding.bindingKey = "display=1;executors=201"; i8:bindingInfo(1.05); binding.generation = nil
    local bi = i8:bindingInfo(1.06); binding.generation = 1; binding.bindingKey = nil
    return bi.revision == 3 and bi.unknown and bi.unknown.code == "binding-unknown" end)())
  -- Second review round.
  -- (R2-1) a queued release survives a rebind and ends its hold against the captured target.
  local i9, b9 = fresh()
  i9:openSession({ id = "s" }, 1)
  binding.bindingKey = "A"
  i9:submit("s", 1, button(1, 1, true)); i9:service(1.01)
  i9:submit("s", 1.02, button(2, 1, false)); i9:submit("s", 1.02, rel(3, 2, 1))
  binding.bindingKey = "B"
  i9:bindingInfo(1.03)
  local out9 = i9:service(1.04)
  check("review R2-1: rebinding keeps the queued release (applied against its captured target) and drops only the motion", out9.applied == 1 and b9:last().kind == "button" and b9:last().down == false and b9:last().targetKey == "slot1|Attribute 1 'Dimmer'|Absolute|Coarse" and i9:status(1.05).counters.staleDropped == 1 and holds(i9, 1.05) == 0, J(out9))
  binding.bindingKey = nil
  -- (R2-2) the revision is required unless the consumer declares a fixed binding.
  local i10 = CTL.new({ owner = "t", deps = { binding = function() return binding end } }):init(); i10:enableInput(CTL.fakeBackend()); i10:openSession({ id = "s" }, 1)
  binding.bindingKey = "A"
  local _, e10 = i10:submit("s", 1, rel(1, 1, 1))
  check("review R2-2: by default an event without a binding revision is refused binding-required with the current one", e10 and e10.code == "binding-required" and e10.binding == 1, J(e10))
  binding.bindingKey = "B"
  check("review R2-2: after replacing the binding at the same generation, an event without a revision is still refused, the old revision is stale-binding, the current one is admitted",
    code(i10:submit("s", 1.01, rel(1, 1, 1))) == "binding-required" and code(i10:submit("s", 1.01, rel(1, 1, 1, { binding = 1 }))) == "stale-binding" and i10:submit("s", 1.01, rel(1, 1, 1, { binding = 2 })).accepted == true)
  check("review R2-2: a malformed or unresolvable target is reported before the revision check; a release never needs the revision", code(i10:submit("s", 1.02, rel(2, 9, 1))) == "target-unavailable" and code(i10:submit("s", 1.02, rel(2, 1, 1, { target = { slot = 0 } }))) == "bad-event" and (function()
    local d = button(2, 1, true); d.binding = 2; i10:submit("s", 1.03, d); return i10:submit("s", 1.04, button(3, 1, false)).accepted == true end)())
  binding.bindingKey = nil
  -- (R2-3) a delayed release beyond the sequence window still ends its hold.
  local i11 = fresh()
  i11:openSession({ id = "s" }, 1)
  i11:submit("s", 1, button(1, 1, true))
  for q = 3, 67 do i11:submit("s", 1 + q * 0.001, rel(q, 2, 1, { gesture = q })) end
  local r11 = i11:submit("s", 1.1, button(2, 1, false))
  check("review R2-3: down 1, motion 3-67, the delayed release 2 is admitted late beyond the window and ends the hold", r11 and r11.accepted and r11.late == true and holds(i11, 1.11) == 0, J(r11))
  check("review R2-3: a release older than the hold's press stays refused beyond the window too", (function()
    local i12 = fresh({ maxQueue = 200 }); i12:openSession({ id = "s" }, 1)
    i12:submit("s", 1.2, button(70, 1, true)); for q = 71, 140 do i12:submit("s", 1.2 + q * 0.0001, rel(q, 2, 1, { gesture = q })) end
    return code(i12:submit("s", 1.3, button(69, 1, false))) == "duplicate" and holds(i12, 1.31) == 1 end)())
  check("review R2 (live): the revision is assigned when the snapshot exists, even while its generation is still unknown, so a consumer bound before the loop observed every part reads the right one", (function()
    local i13 = CTL.new({ owner = "t", deps = { binding = function() return binding end } }):init(); i13:enableInput(CTL.fakeBackend()); i13:openSession({ id = "s" }, 1)
    binding.bindingKey = "K"; binding.generation = nil; binding.generationNote = "no generation: 3 item(s) not observed"
    local early = i13:bindingInfo(1)
    binding.generation = 1; binding.generationNote = nil
    local later = i13:bindingInfo(1.1)
    local r = i13:submit("s", 1.2, rel(1, 1, 1, { binding = early.revision }))
    binding.bindingKey = nil
    return early.revision == 1 and early.unknown and early.unknown.code == "binding-unknown" and later.revision == 1 and later.generation == 1 and r and r.accepted end)())
  check("review 6: a bad binding revision is bad-event", code(i8:submit("s", 1.07, rel(4, 1, 1, { binding = 1.5 }))) == "bad-event")
  local _ = b, b2
end


-------------------------------------------------------------------------------
-- KB-19: the console adjustment backend (consoleBackend over a stub Cmd)
-------------------------------------------------------------------------------
do
  local cmds, feedback, raise = {}, "OK", nil
  local deps = { cmd = function(text) cmds[#cmds + 1] = text; if raise then local r = raise; raise = nil; error(r, 0) end; return feedback end }
  check("kb19: consoleBackend needs deps.cmd; consoleDeps needs an env and raises on a missing Cmd at call time", not pcall(CTL.consoleBackend, {}) and not pcall(CTL.consoleDeps, nil) and not pcall(CTL.consoleDeps({}).cmd, "x") and CTL.consoleDeps({ Cmd = function() return "OK" end }).cmd("x") == "OK")
  local function freshConsole(config)
    config = config or {}
    if config.requireBindingRevision == nil then config.requireBindingRevision = false end
    local inst = CTL.new({ owner = "test", config = config, deps = { binding = function() return binding end, busy = function() return busyOwner end } }):init()
    local b = CTL.consoleBackend(deps)
    inst:enableInput(b)
    inst:openSession({ id = "s" }, 1)
    cmds = {}; feedback = "OK"; raise = nil
    return inst, b
  end
  -- Calibration
  local slot = { kind = "slot", slot = 1, name = "Dimmer", readout = "Percent", resolution = "Coarse", layer = "Absolute", channelFunction = "" }
  check("kb19: Coarse at Percent is 1 per detent, Fine 0.1, PercentFine like Percent", CTL.calibrate(slot) == 1 and CTL.calibrate({ kind = "slot", slot = 1, name = "Pan", readout = "Percent", resolution = "Fine", layer = "Absolute" }) == 0.1
    and CTL.calibrate({ kind = "slot", slot = 1, name = "Pan", readout = "PercentFine", resolution = "Coarse", layer = "Absolute" }) == 1)
  check("kb19: a fine gesture divides the step by fineDivisor (10 by default, configurable)", CTL.calibrate(slot, true) == 0.1 and CTL.calibrate(slot, true, { fineDivisor = 5 }) == 0.2)
  check("kb19: Physical readout: one Coarse detent is the attribute's range / 120 in physical units, Fine a tenth, a fine gesture a tenth again",
    CTL.calibrate({ kind = "slot", slot = 1, name = "Pan", readout = "Physical", resolution = "Coarse", layer = "Absolute", physicalRange = 450 }) == 3.75
    and CTL.calibrate({ kind = "slot", slot = 1, name = "Pan", readout = "Physical", resolution = "Fine", layer = "Absolute", physicalRange = 450 }) == 0.375
    and math.abs(CTL.calibrate({ kind = "slot", slot = 1, name = "Pan", readout = "Physical", resolution = "Coarse", layer = "Absolute", physicalRange = 450 }, true) - 0.375) < 1e-9)
  local _, rP = CTL.calibrate({ kind = "slot", slot = 1, name = "Pan", readout = "Physical", resolution = "Coarse", layer = "Absolute", physicalUnavailable = "deps.logicalChannel missing" })
  local _, rZ = CTL.calibrate({ kind = "slot", slot = 1, name = "Shutter1", readout = "Physical", resolution = "Coarse", layer = "Absolute", physicalRange = 0, physicalFrom = 1, physicalTo = 1 })
  check("kb19: Physical readout without a range in the binding, or with an empty range, is refused with the reason", rP:find("deps.logicalChannel missing") and rP:find("range / 120") and rZ:find("1..1 is empty"), J({ rP, rZ }))
  local _, r1 = CTL.calibrate({ kind = "slot", slot = 1, name = "Pan", readout = "Dec8", resolution = "Coarse", layer = "Absolute" })
  local _, r2 = CTL.calibrate({ kind = "slot", slot = 1, name = "Pan", readout = "Percent", resolution = "Native", layer = "Absolute" })
  local _, r3 = CTL.calibrate({ kind = "slot", slot = 1, name = "Pan", readout = "Percent", resolution = "Coarse", layer = "Relative" })
  local _, r4 = CTL.calibrate({ kind = "slot", slot = 1, name = "Gobo1", readout = "Percent", resolution = "Coarse", layer = "Absolute", channelFunction = "Gobo1 Shake" })
  local _, r5 = CTL.calibrate({ kind = "executor", executor = 201 })
  local _, r6 = CTL.calibrate({ kind = "slot", slot = 1, name = 'Bad"Name', readout = "Percent", resolution = "Coarse", layer = "Absolute" })
  check("kb19: unqualified readout, resolution, layer, named channel function, executor and a quoted name are refused with the reason",
    r1:find("readout Dec8") and r2:find("resolution Native") and r3:find("layer Relative") and r4:find("Gobo1 Shake") and r5:find("only encoder slots") and r6:find("quote"), J({ r1, r2, r3, r4, r5, r6 }))
  -- Admission: what the backend does not serve is refused before a gesture or queue entry exists.
  local inst, b = freshConsole()
  check("kb19: the backend declares its capabilities and calibration", b.name == "console" and b.capabilities.relative == true and b.capabilities.button == true and b.capabilities.targets.slot == true and b.calibration.fineDivisor == 10 and b.calibration.note:find("one physical detent"))
  local okB, eB = inst:submit("s", 1, button(1, 1, true))
  check("kb19: an encoder press is refused unsupported at admission (calculator/open/select not qualified) and owns nothing", okB == nil and eB.code == "unsupported" and eB.reason:find("not qualified") and eB.backend == "console" and inst:status(1).sessions.s.gestures == 0 and inst:admission(1) == nil, J(eB))
  local okT, eT = inst:submit("s", 1, { type = "relative", device = "mtouch", control = "Strip201", seq = 1, generation = binding.generation, target = { executor = 201, element = "fader" }, delta = 1, gesture = 1 })
  local okA, eA = inst:submit("s", 1, abs(2, 202, 0.5))
  check("kb19/22: relative motion on an executor fader and a position on an unqualified fader function (X) are refused unsupported", okT == nil and eT.code == "unsupported" and eT.reason:find("positioned by absolute") and okA == nil and eA.code == "unsupported" and eA.reason:find("X is not qualified yet") and eA.message:find("absolute on exec[^/]*/1%.202%.fader"), J({ eT, eA }))
  binding.executors[1].value.functions.encoder = "Master"
  local okE, eE = inst:submit("s", 1, { type = "relative", device = "nxk", control = "Enc201", seq = 3, generation = binding.generation, target = { executor = 201, element = "encoder" }, delta = 1, gesture = 1 })
  binding.executors[1].value.functions.encoder = nil
  check("kb19/22: relative motion on an executor encoder element is refused unsupported (not qualified)", okE == nil and eE.code == "unsupported" and eE.reason:find("executor encoders"), J(eE))
  local okF, eF = inst:submit("s", 1, rel(2, 2, 1))  -- slot 2: Pan, Fine, mixed availability
  check("kb19: a mixed-availability slot with a calibrated resolution is admitted (the console leaves fixtures without the attribute untouched)", okF and okF.accepted and okF.mixed == true, J(eF))
  binding.slots.value.slots[3].availability = "available"; binding.slots.value.slots[3].channelFunction = "Gobo1 Shake"
  local okG, eG = inst:submit("s", 1, rel(3, 3, 1))
  check("kb19: a slot whose channel-function selector names a function other than the attribute's own is refused unsupported with the reason (the attribute's own name or an empty selector is qualified)", okG == nil and eG.code == "unsupported" and eG.reason:find("Gobo1 Shake"), J(eG))
  binding.slots.value.slots[3].availability = "unavailable"; binding.slots.value.slots[3].channelFunction = "Gobo1"
  check("kb19: a refused event is counted and logged, nothing queued", inst:status(1).sessions.s.queued == 1 and inst:status(1).counters.refused >= 5)
  -- Review (PR #23): the encoder bar's context decides whether a slot is served at all.
  inst, b = freshConsole()
  binding.encoder = { available = true, value = { context = "Editor", attributeEditing = false } }
  local okC1, eC1 = inst:submit("s", 1, rel(1, 1, 1))
  binding.encoder = { available = true, value = { context = nil, attributeEditing = nil } }
  local okC2, eC2 = inst:submit("s", 1, rel(2, 1, 1))
  binding.encoder = { available = false, reason = "display 1 has no encoder bar" }
  local okC3, eC3 = inst:submit("s", 1, rel(3, 1, 1))
  binding.encoder = { available = true, value = { context = "Default", attributeEditing = true } }
  local okC4 = inst:submit("s", 1, rel(4, 1, 1))
  check("kb19 review: an Editor context and an unreadable context refuse slot motion unsupported, an unavailable encoder bar target-unavailable; Default is served (the fake backend too: this is resolution, not the backend)",
    okC1 == nil and eC1.code == "unsupported" and eC1.message:find("'Editor'") and okC2 == nil and eC2.code == "unsupported" and eC2.message:find("unreadable") and okC3 == nil and eC3.code == "target-unavailable" and eC3.message:find("no encoder bar") and okC4 and okC4.accepted, J({ eC1, eC2, eC3 }))
  check("kb19 review: the refusals issued no command", #cmds == 0)
  local iF = fresh(); iF:openSession({ id = "s" }, 1)
  binding.encoder = { available = true, value = { context = "Phaser", attributeEditing = false } }
  local okC5, eC5 = iF:submit("s", 1, rel(1, 1, 1))
  binding.encoder = { available = true, value = { context = "Default", attributeEditing = true } }
  check("kb19 review: resolveTarget refuses the context on the fake backend as well", okC5 == nil and eC5.code == "unsupported", J(eC5))
  -- Review (PR #23): a calibration change is a binding change; queued motion against the old range is dropped.
  inst, b = freshConsole()
  inst:submit("s", 1, rel(1, 2, 4))  -- Pan, range 450
  binding.slots.value.slots[2].physicalRange = 112.5
  binding.generation = binding.generation + 1  -- what the feedback digest does when a range field changes
  local svR = inst:service(1.01)
  binding.slots.value.slots[2].physicalRange = 450
  check("kb19 review: queued motion is dropped (staleGeneration), not applied with the old step, when the range changed", svR.dropped.staleGeneration == 1 and svR.applied == 0 and #cmds == 0, J(svR))
  local okR, eR = inst:submit("s", 1.02, rel(2, 2, 4, { generation = binding.generation - 1 }))
  check("kb19 review: an event still carrying the pre-change generation is stale-generation", okR == nil and eR.code == "stale-generation", J(eR))
  local okN = inst:submit("s", 1.03, rel(3, 2, 4, { gesture = 2 }))
  inst:service(1.04)
  check("kb19 review: a fresh gesture uses the new binding (slot 2 is Fine: 4 x 450 / 120 / 10 = At + 1.5)", okN and okN.accepted and cmds[1] == 'Attribute "Pan" At + 1.5', J(cmds))
  -- Apply: the command text, sign, coalesced deltas, fine, feedback verdicts.
  inst, b = freshConsole()
  for i = 1, 3 do inst:submit("s", 1, rel(i, 1, 1)) end
  inst:submit("s", 1, rel(4, 1, -5, { gesture = 2 }))
  inst:submit("s", 1, rel(5, 1, 2, { fine = true, gesture = 3 }))
  inst:submit("s", 1, rel(6, 2, 4, { gesture = 4 }))  -- Pan: Physical readout, range 450, Fine resolution -> 0.375 per detent
  local sv = inst:service(1.01)
  check("kb19: three coalesced detents become Attribute \"Dimmer\" At + 3; a negative delta At - 5; fine 2 detents At + 0.2; 4 detents of a Fine Physical slot (450 / 120 / 10 each) At + 1.5",
    sv.applied == 4 and cmds[1] == 'Attribute "Dimmer" At + 3' and cmds[2] == 'Attribute "Dimmer" At - 5' and cmds[3] == 'Attribute "Dimmer" At + 0.2' and cmds[4] == 'Attribute "Pan" At + 1.5', J(cmds))
  local st = inst:status(1.02)
  check("kb19: lastApplied carries the backend's result (command, amount, step, slot, attribute, physical range) and status carries the backend's counters and last command",
    st.lastApplied.outcome == "applied" and st.lastApplied.result.command == 'Attribute "Pan" At + 1.5' and st.lastApplied.result.slot == 2 and st.lastApplied.result.mixed == true and st.lastApplied.result.physicalRange == 450 and st.lastApplied.result.physicalMixed == true and st.backendStatus.counters.applied == 4 and st.backendStatus.lastCommand.outcome == "applied" and b.counters.applied == 4, J(st.lastApplied))
  feedback = "Illegal command"
  inst:submit("s", 2, rel(7, 1, 1, { gesture = 5 }))
  sv = inst:service(2.01)
  check("kb19: feedback other than OK is a backend refusal (nothing changed), counted and recorded", sv.dropped.refused == 1 and inst:status(2.02).lastApplied.outcome == "refused" and inst:status(2.02).lastApplied.error.feedback == "Illegal command" and b.counters.refused == 1 and b.lastCommand.outcome == "refused", J(inst:status(2.02).lastApplied))
  feedback = "OK"; raise = "Cmd raised"
  inst:submit("s", 3, rel(8, 1, 1, { gesture = 6 }))
  sv = inst:service(3.01)
  check("kb19: a raising Cmd leaves relative motion unresolved (no record kept: a delta is never re-attempted) and is counted", #sv.unresolved == 1 and #inst:status(3.02).unresolved == 0 and b.counters.raised == 1 and inst:status(3.02).lastApplied.outcome == "unresolved", J(sv.unresolved))
  -- A hold admitted under the fake backend is ended as a noop by the console backend (never pressed there).
  local i2, fake = fresh()
  i2:openSession({ id = "s" }, 1)
  i2:submit("s", 1, button(1, 1, true))
  i2:attachBackend(CTL.consoleBackend(deps))
  local r = i2:closeSession("s", 2, "switch")
  check("kb19: a release reaching the console backend is a noop end (nothing was pressed on the console)", r.ended[1].outcome == "applied" and i2:status(2).backendStatus.counters.noop == 1, J(r))
  -- Switching backends: a consumer re-enables input with the console adapter; the fake still records.
  local i3 = fresh()
  i3:enableInput(CTL.consoleBackend(deps))
  check("kb19: enableInput with the console backend replaces the fake", i3:status(1).backend == "console" and i3:backendAvailable())
  -- Amount formatting: no exponent, at most 4 decimals, trailing zeros stripped.
  inst, b = freshConsole()
  inst:submit("s", 1, rel(1, 1, 4096, { fine = true }))
  inst:submit("s", 1, rel(2, 1, 1, { fine = true, gesture = 2 }))
  inst:service(1.01)
  check("kb19: amounts are plain decimals", cmds[1] == 'Attribute "Dimmer" At + 409.6' and cmds[2] == 'Attribute "Dimmer" At + 0.1', J(cmds))
end

-------------------------------------------------------------------------------
-- KB-20: parameter strips on the console backend (touch holds, absolute positions, mixed values)
-------------------------------------------------------------------------------
do
  local cmds, feedback = {}, "OK"
  local deps = { cmd = function(text) cmds[#cmds + 1] = text; return feedback end }
  local function freshConsole(config)
    config = config or {}
    if config.requireBindingRevision == nil then config.requireBindingRevision = false end
    local inst = CTL.new({ owner = "test", config = config, deps = { binding = function() return binding end, busy = function() return busyOwner end } }):init()
    local b = CTL.consoleBackend(deps)
    inst:enableInput(b)
    inst:openSession({ id = "s" }, 1)
    cmds = {}; feedback = "OK"
    return inst, b
  end
  local function stouch(seq, slot, down, extra)
    local e = { type = "touch", device = "mtouch", control = "Strip" .. tostring(slot), seq = seq, generation = binding.generation, target = { slot = slot }, down = down, gesture = 7 }
    for k, v in pairs(extra or {}) do e[k] = v end
    return e
  end
  local function sabs(seq, slot, value, extra)
    local e = { type = "absolute", device = "mtouch", control = "Strip" .. tostring(slot), seq = seq, generation = binding.generation, target = { slot = slot }, value = value, gesture = 7 }
    for k, v in pairs(extra or {}) do e[k] = v end
    return e
  end
  local function srel(seq, slot, delta, extra)
    local e = { type = "relative", device = "mtouch", control = "Strip" .. tostring(slot), seq = seq, generation = binding.generation, target = { slot = slot }, delta = delta, gesture = 7 }
    for k, v in pairs(extra or {}) do e[k] = v end
    return e
  end
  -- position(): the travel's verified range per readout.
  local dimmer = { kind = "slot", slot = 1, name = "Dimmer", readout = "Percent", resolution = "Coarse", layer = "Absolute", channelFunction = "" }
  local pan = { kind = "slot", slot = 2, name = "Pan", readout = "Physical", resolution = "Fine", layer = "Absolute", physicalRange = 450, physicalFrom = -225, physicalTo = 225 }
  local p0, _, pinfo = CTL.position(dimmer, 0.5)
  check("kb20: a position at the Percent readout spans 0..100 (0.5 = At 50) and reports the travel", p0 == 50 and pinfo.from == 0 and pinfo.to == 100 and CTL.position(dimmer, 0) == 0 and CTL.position(dimmer, 1) == 100
    and CTL.position({ kind = "slot", slot = 1, name = "Pan", readout = "PercentFine", resolution = "Coarse", layer = "Absolute" }, 0.25) == 25)
  check("kb20: a position at the Physical readout spans PhysicalFrom..PhysicalTo in physical units (Pan -225..225: 0.5 = At 0, 0.1 = At -180, 1 = At 225)", CTL.position(pan, 0.5) == 0 and CTL.position(pan, 0.1) == -180 and CTL.position(pan, 1) == 225 and select(3, CTL.position(pan, 1)).physicalRange == 450)
  local _, rM = CTL.position({ kind = "slot", slot = 2, name = "Pan", readout = "Physical", resolution = "Fine", layer = "Absolute", physicalRange = 450, physicalFrom = -225, physicalTo = 225, physicalMixed = true }, 0.5)
  local _, rF = CTL.position({ kind = "slot", slot = 2, name = "Pan", readout = "Physical", resolution = "Fine", layer = "Absolute", physicalRange = 450 }, 0.5)
  local _, rD = CTL.position({ kind = "slot", slot = 1, name = "Pan", readout = "Dec8", resolution = "Coarse", layer = "Absolute" }, 0.5)
  local _, rV = CTL.position(dimmer, 1.5)
  local _, rX = CTL.position({ kind = "executor", executor = 201 }, 0.5)
  check("kb20: a mixed physical range, missing PhysicalFrom/To, an uncalibrated readout, a value outside 0..1 and an executor are refused with the reason",
    rM:find("different physical ranges") and rF:find("PhysicalFrom/PhysicalTo") and rD:find("readout Dec8") and rV:find("0..1") and rX:find("only encoder slots"), J({ rM, rF, rD, rV, rX }))
  -- Admission: touches and positions are served on slots, still refused on executors; capabilities say so.
  local inst, b = freshConsole()
  check("kb20: the console backend declares touch and absolute on slots, no encoder presses; executors since KB-22", b.capabilities.touch == true and b.capabilities.absolute == true and b.capabilities.button == true and b.capabilities.targets.executor == true and b.capabilities.executorElements.encoder == false and b.description:find("KB%-20"))
  local okTX, eTX = inst:submit("s", 1, { type = "relative", device = "mtouch", control = "Strip201", seq = 1, generation = binding.generation, target = { executor = 201, element = "fader" }, delta = 1, gesture = 1 })
  local okAX, eAX = inst:submit("s", 1, abs(2, 202, 0.5))
  check("kb20/22: relative motion on an executor fader and a position on an unqualified fader function stay unsupported", okTX == nil and eTX.code == "unsupported" and okAX == nil and eAX.code == "unsupported" and eAX.reason:find("not qualified yet"), J({ eTX, eAX }))
  -- A strip touch is a hold: busy, owned, applied as a noop, nothing issued.
  local okT, eT = inst:submit("s", 1, stouch(1, 1, true))
  local adm = inst:admission(1.001)
  check("kb20: a strip touch on a slot is admitted as a hold: the instance is busy with it and the slot is this session's", okT and okT.accepted and adm and adm.reason == "touch-down" and inst:status(1.001).sessions.s.gestures == 1, J(adm))
  local sv = inst:service(1.01)
  check("kb20: the touch is applied as a noop (nothing moves on the console, no command issued) and counted", sv.applied == 1 and #cmds == 0 and b.counters.noop == 1 and inst:status(1.02).lastApplied.result.note:find("reserved its slot"), J(sv))
  local okC, eC = inst:submit("other", 1.02, rel(1, 1, 1))
  inst:openSession({ id = "other" }, 1.02)
  okC, eC = inst:submit("other", 1.02, rel(1, 1, 1))
  check("kb20: another session's motion on the touched slot is refused conflict with the owner", okC == nil and eC.code == "conflict" and eC.owner == "s", J(eC))
  -- The drag: relative motion inside the touch coalesces and applies as the KB-19 adjustment.
  for i = 2, 4 do inst:submit("s", 1.03, srel(i, 1, 1)) end
  inst:submit("s", 1.03, srel(5, 1, -1))
  sv = inst:service(1.04)
  check("kb20: a touch-anchored drag is the KB-19 adjustment: three detents and one back coalesce into Attribute \"Dimmer\" At + 2", sv.applied == 1 and cmds[1] == 'Attribute "Dimmer" At + 2', J(cmds))
  -- The binding moves while the strip is touched: the old gesture is stopped until release and re-touch.
  binding.generation = binding.generation + 1
  local okR, eR = inst:submit("s", 1.05, srel(6, 1, 1))
  check("kb20: motion inside a touch after the binding changed is refused gesture-rebound (release and touch again)", okR == nil and eR.code == "gesture-rebound" and eR.heldGeneration == binding.generation - 1, J(eR))
  local okU = inst:submit("s", 1.06, stouch(7, 1, false))
  sv = inst:service(1.07)
  local okT2 = inst:submit("s", 1.08, stouch(8, 1, true, { gesture = 8 }))
  local okR2 = inst:submit("s", 1.08, srel(9, 1, 2, { gesture = 8 }))
  sv = inst:service(1.09)
  check("kb20: the release is a boundary (noop end), a new touch and its motion are served against the new binding", okU and okU.boundary and okT2 and okT2.accepted and okR2 and okR2.accepted and cmds[2] == 'Attribute "Dimmer" At + 2' and b.counters.noop == 3, J(cmds))
  inst:submit("s", 1.1, stouch(10, 1, false)); inst:service(1.11)
  check("kb20: after the release the instance is idle again", inst:admission(1.5) == nil and inst:status(1.5).sessions.s.gestures == 0)
  -- Absolute positions: Attribute "<name>" At <value>, the newest queued position supersedes (slots). The binding's
  -- values are complete here (review: a position is placed only on completely read values).
  binding.slots.value.slots[1].valueState = "value"; binding.slots.value.slots[1].valueComplete = true
  binding.slots.value.slots[2].valueState = "empty"; binding.slots.value.slots[2].valueComplete = true
  inst, b = freshConsole()
  inst:submit("s", 2, stouch(1, 1, true))
  inst:submit("s", 2, sabs(2, 1, 0.1))
  local okA2 = inst:submit("s", 2, sabs(3, 1, 0.25))
  sv = inst:service(2.01)
  check("kb20: a position on a Percent slot is Attribute \"Dimmer\" At 25; the newer queued position superseded the older (one command)", okA2 and okA2.superseded and sv.applied == 2 and #cmds == 1 and cmds[1] == 'Attribute "Dimmer" At 25', J(cmds))
  local st = inst:status(2.02)
  check("kb20: lastApplied carries the placement (command, value, amount, travel, readout, attribute, slot)", st.lastApplied.result.value == 0.25 and st.lastApplied.result.amount == 25 and st.lastApplied.result.from == 0 and st.lastApplied.result.to == 100 and st.lastApplied.result.readout == "Percent" and st.lastApplied.result.slot == 1 and st.lastApplied.result.attribute == "Dimmer", J(st.lastApplied.result))
  local okP, eP = inst:submit("s", 2.03, sabs(4, 2, 0.5))
  check("kb20: a position on a slot whose selection has mixed physical ranges is refused unsupported at admission (relative stays available)", okP == nil and eP.code == "unsupported" and eP.reason:find("different physical ranges") and inst:submit("s", 2.03, srel(5, 2, 1)).accepted, J(eP))
  binding.slots.value.slots[2].physicalMixed = nil
  inst:submit("s", 2.04, sabs(6, 2, 0.1, { gesture = 9 }))
  sv = inst:service(2.05)
  inst:submit("s", 2.06, sabs(7, 2, 0.5, { gesture = 10 }))
  sv = inst:service(2.07)
  binding.slots.value.slots[2].physicalMixed = true
  check("kb20: positions on a Physical slot are placed in physical units (Pan 0.1 = At -180, 0.5 = At 0)", cmds[#cmds - 1] == 'Attribute "Pan" At -180' and cmds[#cmds] == 'Attribute "Pan" At 0', J(cmds))
  check("kb20: a stale position is dropped like motion, never placed late", (function()
    inst:submit("s", 3, sabs(8, 1, 0.9, { gesture = 11 }))
    local r = inst:service(3.5)
    return r.dropped.expired == 1 and cmds[#cmds] == 'Attribute "Pan" At 0'
  end)())
  binding.slots.value.slots[2].valueState = nil; binding.slots.value.slots[2].valueComplete = nil
  -- Mixed values stay mixed unless the operator takes over.
  inst, b = freshConsole()
  binding.slots.value.slots[1].valueState = "mixed"; binding.slots.value.slots[1].absolute = 30; binding.slots.value.slots[1].valueComplete = true
  local resolved = CTL.resolveTarget(binding, { slot = 1 })
  check("kb20: the resolved slot forwards the binding's value state, completeness and last read value", resolved.valueState == "mixed" and resolved.absolute == 30 and resolved.valueComplete == true)
  local okM, eM = inst:submit("s", 4, sabs(1, 1, 0.5))
  check("kb20: a position on a slot with mixed values is refused mixed-values, nothing queued", okM == nil and eM.code == "mixed-values" and eM.message:find("takeover = true") and inst:status(4).sessions.s.queued == 0, J(eM))
  check("kb20: relative motion on the same slot is served (the relationship is preserved)", inst:submit("s", 4, srel(2, 1, 1)).accepted)
  local okK = inst:submit("s", 4, sabs(3, 1, 0.5, { takeover = true, gesture = 12 }))
  sv = inst:service(4.01)
  check("kb20: with takeover = true the position is placed and the record says so", okK and okK.accepted and cmds[#cmds] == 'Attribute "Dimmer" At 50' and inst:status(4.02).lastApplied.result.takeover == true and inst:status(4.02).lastApplied.result.valueState == "mixed", J(cmds))
  local okB, eB = inst:submit("s", 4.03, srel(4, 1, 1, { takeover = true, gesture = 13 }))
  local okB2, eB2 = inst:submit("s", 4.03, sabs(5, 1, 0.5, { takeover = 1, gesture = 13 }))
  check("kb20: takeover on a relative event, or a non-boolean takeover, is a bad event", okB == nil and eB.code == "bad-event" and okB2 == nil and eB2.code == "bad-event", J({ eB, eB2 }))
  -- Review (PR #24): "value" from a bounded scan or a failed read is not the selection's value.
  binding.slots.value.slots[1].valueState = "value"; binding.slots.value.slots[1].absolute = 50; binding.slots.value.slots[1].valueComplete = false
  binding.slots.value.slots[1].valueIncomplete = "the selection scan is bounded (8 of 9 fixtures); the values of the fixtures outside the scan are unknown"
  local okI, eI = inst:submit("s", 4.1, sabs(6, 1, 0.5, { gesture = 14 }))
  check("kb20 review: a position on a slot whose values were not completely read (bounded scan) is refused values-incomplete with the binding's reason, nothing queued", okI == nil and eI.code == "values-incomplete" and eI.message:find("8 of 9 fixtures") and eI.message:find("takeover = true") and inst:status(4.1).sessions.s.queued == 0, J(eI))
  check("kb20 review: relative motion on it is served", inst:submit("s", 4.1, srel(7, 1, 1, { gesture = 14 })).accepted)
  local okI2 = inst:submit("s", 4.1, sabs(8, 1, 0.5, { gesture = 15, takeover = true }))
  inst:service(4.11)
  check("kb20 review: takeover places it", okI2 and okI2.accepted and cmds[#cmds] == 'Attribute "Dimmer" At 50', J(cmds))
  binding.slots.value.slots[1].valueIncomplete = "some fixtures with the channel could not be read: GetProgPhaser exploded"
  local okI3, eI3 = inst:submit("s", 4.12, sabs(9, 1, 0.5, { gesture = 16 }))
  check("kb20 review: a failed programmer read on another fixture refuses the position the same way", okI3 == nil and eI3.code == "values-incomplete" and eI3.valueIncomplete:find("exploded"), J(eI3))
  binding.slots.value.slots[1].valueComplete = nil; binding.slots.value.slots[1].valueIncomplete = nil
  local okI4, eI4 = inst:submit("s", 4.13, sabs(10, 1, 0.5, { gesture = 17 }))
  check("kb20 review: a binding that reports no completeness at all (an older feedback) is refused too, never assumed complete", okI4 == nil and eI4.code == "values-incomplete" and eI4.message:find("no value completeness"), J(eI4))
  binding.slots.value.slots[1].valueState = nil; binding.slots.value.slots[1].absolute = nil
  -- The fake backend serves strips too; the mixed-values rule is resolution, not the backend.
  local iF = fresh(); iF:openSession({ id = "s" }, 5)
  binding.slots.value.slots[1].valueState = "mixed"; binding.slots.value.slots[1].valueComplete = true
  local okFM, eFM = iF:submit("s", 5, sabs(1, 1, 0.5))
  binding.slots.value.slots[1].valueState = "value"
  local okFV = iF:submit("s", 5, sabs(2, 1, 0.5))
  binding.slots.value.slots[1].valueState = nil; binding.slots.value.slots[1].valueComplete = nil
  check("kb20: the mixed-values refusal applies on the fake backend as well; a complete single value is served", okFM == nil and eFM.code == "mixed-values" and okFV and okFV.accepted, J(eFM))
  check("kb20: the limitations name strips, positions, the mixed-values and the values-incomplete rule", CTL.LIMITATIONS[1]:find("KB%-20") and CTL.LIMITATIONS[1]:find("mixed%-values") and CTL.LIMITATIONS[1]:find("values%-incomplete"))
end

-------------------------------------------------------------------------------
-- Status and the event log
-------------------------------------------------------------------------------
do
  local inst = fresh({ eventLog = 3 })
  inst:openSession({ id = "s", label = "surface" }, 1)
  for i = 1, 5 do inst:submit("s", 1, rel(i, 1, 1, { gesture = i })) end
  inst:submit("s", 1, rel(5, 1, 1))
  local st = inst:status(1.5)
  check("status: backend, capabilities, session view, bounded event log", st.backend == "fake" and st.capabilities.relative == true and st.sessions.s.label == "surface" and st.sessions.s.queued == 5 and #st.events == 3 and st.events[3].refused == "duplicate", J(st.events))
  check("status is read-only (no service side effects)", st.serviced == 0 and inst:status().sessions.s.queued == 5)
  check("limitations and lists are published", #CTL.LIMITATIONS == 5 and #CTL.EVENT_TYPES == 4 and CTL.STATEFUL_FUNCTIONS.x == true and CTL.backends.fake == "fake" and CTL.backends.console == "console" and CTL.CALIBRATION.readouts.Percent == 1)
  check("resolveTarget is exported for consumers", CTL.resolveTarget(binding, { slot = 1 }).key:find("^slot1") ~= nil)
end

-------------------------------------------------------------------------------
-- KB-21: explicit executor targets, page-bound resolution, frozen holds
-------------------------------------------------------------------------------
do
  local inst, b = fresh()
  inst:openSession({ id = "s" }, 1)
  local r = inst:submit("s", 1, abs(1, 201, 0.5))
  check("kb21: a current-page target resolves with pool, page, mode and a key naming both", r.accepted and r.target == "execDefault#1/1.201.fader|Sequence 1|Master", J(r))
  inst:service(1.01)
  local it = b:last()
  check("kb21: the applied intent carries the explicit identity", it.resolved.pool == "Default#1" and it.resolved.pageNo == 1 and it.resolved.page.name == "Page 1" and it.resolved.mode == "current" and it.resolved.width == 1 and it.resolved.level == 50, J(it.resolved))
  r = inst:submit("s", 1.02, abs(2, 201, 0.5, { target = { executor = 201, element = "fader", page = 2 }, control = "StripP2" }))
  check("kb21: the same number on an explicit page is a different target (page in the key, mode=page)", r.accepted and r.target == "execDefault#1/2.201.fader|Sequence 9|Master", J(r))
  inst:service(1.03)
  check("kb21: its intent says page 2 and mode page", b:last().resolved.pageNo == 2 and b:last().resolved.mode == "page" and b:last().resolved.assigned == "Sequence 9", J(b:last().resolved))
  local _, e = inst:submit("s", 1.04, abs(3, 202, 0.5, { target = { executor = 202, element = "fader", page = 2 }, control = "StripX" }))
  check("kb21: a page-bound number the binding does not hold says bind first", e and e.code == "target-unavailable" and e.message:find("executor 202 of page 2 is not in the binding"), J(e))
  _, e = inst:submit("s", 1.04, abs(4, 211, 0.5, { target = { executor = 211, element = "fader" }, control = "StripY" }))
  check("kb21: a page-bound executor is not reached without target.page (never silently the current page)", e and e.code == "target-unavailable" and e.message:find("needs target.page"), J(e))
  r = inst:submit("s", 1.05, abs(5, 211, 0.5, { target = { executor = 211, element = "fader", page = 2 }, control = "StripW" }))
  check("kb21: an expanded assignment resolves with its width", r.accepted and (function() inst:service(1.06); return b:last().resolved.width == 2 and b:last().resolved.expanded == true end)(), J(r))
  _, e = inst:submit("s", 1.07, abs(6, 212, 0.5, { target = { executor = 212, element = "fader", page = 2 }, control = "StripC" }))
  check("kb21: a covered number is refused with the covering executor, not treated as empty", e and e.code == "target-unavailable" and e.coveredBy == 211 and e.message:find("covered by executor 211 %(width 2%)"), J(e))
  _, e = inst:submit("s", 1.08, abs(7, 201, 0.5, { target = { executor = 201, element = "fader", page = 7 }, control = "StripM" }))
  check("kb21: a missing page is refused as such and nothing is created", e and e.code == "target-unavailable" and e.pageMissing == true and e.message:find("page 7 does not exist"), J(e))
  _, e = inst:submit("s", 1.09, abs(8, 201, 0.5, { target = { executor = 201, element = "fader", page = 0 }, control = "StripZ" }))
  check("kb21: a bad page is a bad event", e and e.code == "bad-event" and e.message:find("target.page"), J(e))

  -- Frozen holds: a button down on page 1's 201, then the binding is replaced (a bank change) and the
  -- console's page changes (the following item now reads page 2's object). The release goes to what was pressed.
  local i2, b2 = fresh()
  i2:openSession({ id = "s" }, 1)
  binding.bindingKey = "display=1;executors=201"
  local d, derr = i2:submit("s", 1, { type = "button", device = "mtouch", control = "PFA1", seq = 1, generation = binding.generation, target = { executor = 201, element = "key" }, down = true })
  check("kb21: the down resolved and recorded its target", d.accepted and i2:service(1.01).applied == 1 and b2:last().resolved.assigned == "Sequence 1" and b2:last().frozen == nil, J(b2:last()))
  local st = i2:status(1.02)
  check("kb21: status shows what the hold is frozen to", st.sessions.s.gestureList[1].frozen.executor == 201 and st.sessions.s.gestureList[1].frozen.page == 1 and st.sessions.s.gestureList[1].frozen.assigned == "Sequence 1" and st.sessions.s.gestureList[1].targetKey:find("^execDefault#1/1%.201%.key"), J(st.sessions.s.gestureList))
  -- The bank moves (a replaced spec) and the console page changes: 201 now means Sequence 99 on page 2.
  local saved = binding.executors[1].value
  binding.executors[1].value = { executor = 201, page = { no = 2, name = "Page 2" }, pool = { name = "Default", no = 1 }, mode = "current", empty = false, playbackTarget = true, assigned = { addr = "Sequence 99", class = "Sequence" }, functions = { keyPress = "Go+", fader = "Master" }, level = { token = "FaderMaster", value = 0 } }
  binding.bindingKey = "display=1;executors=201,202"
  binding.generation = 5
  local rel_ = i2:submit("s", 1.1, { type = "button", device = "mtouch", control = "PFA1", seq = 2, target = { executor = 201, element = "key" }, down = false })
  check("kb21: the release is admitted without a binding and marked a boundary", rel_.accepted and rel_.boundary == true, J(rel_))
  i2:service(1.11)
  local up = b2:last()
  check("kb21: the release went to the frozen target (page 1, Sequence 1), not to the newly mapped Sequence 99", up.down == false and up.frozen == true and up.resolved.assigned == "Sequence 1" and up.resolved.pageNo == 1 and up.targetKey:find("^execDefault#1/1%.201%.key|Sequence 1"), J(up))
  check("kb21: the gesture is gone and the hold was marked rebound by the rebind", st.sessions.s.gestureList[1] ~= nil and i2:status(1.12).sessions.s.gestureList[1] == nil and i2:status(1.12).counters.staleDropped == 0)
  -- A new down after the change reaches the new mapping only through its own resolution.
  local d2 = i2:submit("s", 1.13, { type = "button", device = "mtouch", control = "PFA1", seq = 3, generation = 5, target = { executor = 201, element = "key" }, down = true })
  i2:service(1.14)
  check("kb21: a fresh down resolves the new mapping (Sequence 99 on page 2)", d2.accepted and b2:last().down == true and b2:last().resolved.assigned == "Sequence 99" and b2:last().resolved.pageNo == 2, J(b2:last().resolved))
  -- A forced end (lease expiry) carries the frozen target too.
  local i3, b3 = fresh({ defaultLeaseMs = 100 })
  i3:openSession({ id = "s" }, 2)
  i3:submit("s", 2, { type = "button", device = "mtouch", control = "PFA2", seq = 1, generation = 5, target = { executor = 201, element = "key" }, down = true }); i3:service(2.01)
  binding.executors[1].value = saved
  binding.generation = 1; binding.bindingKey = nil
  i3:service(2.5)
  check("kb21: a forced end (lease expired) releases the frozen target with the down's identity", b3:last().down == false and b3:last().forced == true and b3:last().frozen == true and b3:last().resolved.assigned == "Sequence 99" and b3:last().resolved.pageNo == 2, J(b3:last()))
  -- A held touch on a strip is rebound by a replaced binding: its motion is refused until lift and re-touch.
  local i4 = fresh()
  i4:openSession({ id = "s" }, 3)
  binding.bindingKey = "display=1;executors=201"
  i4:submit("s", 3, touch(1, 201, true)); i4:service(3.01)
  binding.bindingKey = "display=1;executors=211;page=2"
  local _, e7 = i4:submit("s", 3.02, abs(2, 201, 0.4))
  check("kb21: rebinding (a bank change) cancels the strip gesture: motion inside the held touch is gesture-rebound", e7 and e7.code == "gesture-rebound", J(e7))
  check("kb21: the lift is admitted and a new touch starts over", i4:submit("s", 3.03, touch(3, 201, false)).accepted and i4:submit("s", 3.04, touch(4, 201, true)).accepted)
  binding.bindingKey = nil
  -- Review (PR #25): the frozen record survives the gesture-bound force-end, a release the backend raised on, recover() and adoption.
  local saved2 = binding.executors[1].value
  local function remap() binding.executors[1].value = { executor = 201, page = { no = 4, name = "Page 4" }, pool = { name = "Default", no = 1 }, mode = "current", empty = false, playbackTarget = true, assigned = { addr = "Sequence 77", class = "Sequence" }, functions = { keyPress = "Go+", fader = "Master" }, level = { token = "FaderMaster", value = 0 } } end
  local i5, b5 = fresh({ maxGestureMs = 100 })
  i5:openSession({ id = "s" }, 4)
  i5:submit("s", 4, { type = "button", device = "mtouch", control = "PFA1", seq = 1, generation = 1, target = { executor = 201, element = "key" }, down = true }); i5:service(4.01)
  remap(); binding.generation = 9
  local out5 = i5:service(4.2)
  check("review: the gesture-bound force-end releases the frozen target (page 1, Sequence 1), not the remapped Sequence 77", out5.ended[1] and out5.ended[1].reason == "max-gesture" and b5:last().down == false and b5:last().frozen == true and b5:last().resolved.assigned == "Sequence 1" and b5:last().resolved.pageNo == 1, J(b5:last()))
  binding.executors[1].value = saved2; binding.generation = 1
  local i6, b6 = fresh()
  i6:openSession({ id = "s" }, 5)
  i6:submit("s", 5, { type = "button", device = "mtouch", control = "PFA1", seq = 1, generation = 1, target = { executor = 201, element = "key" }, down = true }); i6:service(5.01)
  remap(); binding.generation = 9
  b6:raiseNext("button", "host blocked")
  i6:submit("s", 5.1, { type = "button", device = "mtouch", control = "PFA1", seq = 2, target = { executor = 201, element = "key" }, down = false })
  local out6 = i6:service(5.11)
  local rec6 = i6:status(5.12).unresolved[1]
  check("review: a release the backend raised on keeps the frozen record (resolved, targetKey) in the unresolved record", out6.unresolved and #out6.unresolved == 1 and rec6 and rec6.frozen == true and rec6.resolved.assigned == "Sequence 1" and rec6.resolved.pageNo == 1 and rec6.targetKey:find("^execDefault#1/1%.201%.key|Sequence 1"), J(rec6))
  local rc6 = i6:recover(5.2)
  check("review: recover() re-attempts the release against the frozen record, not the current mapping", #rc6.resolved == 1 and b6:last().down == false and b6:last().reason == "recover" and b6:last().frozen == true and b6:last().resolved.assigned == "Sequence 1", J(b6:last()))
  -- Adoption: the record handed back by dispose() carries the frozen identity into the next instance.
  local i7, b7 = fresh()
  i7:openSession({ id = "s" }, 6)
  i7:submit("s", 6, { type = "button", device = "mtouch", control = "PFA2", seq = 1, generation = 9, target = { executor = 201, element = "key" }, down = true }); i7:service(6.01)
  b7:raiseNext("button", "host blocked")
  i7:submit("s", 6.1, { type = "button", device = "mtouch", control = "PFA2", seq = 2, target = { executor = 201, element = "key" }, down = false }); i7:service(6.11)
  local handed = i7:dispose(6.2)
  local i8, b8 = fresh()
  local ad = i8:adopt(handed.records, 7)
  binding.executors[1].value = saved2; binding.generation = 1
  local rc8 = i8:recover(7.1)
  check("review: an adopted record releases the executor it was pressed on (Sequence 77 on page 4) although the binding now maps 201 to Sequence 1 on page 1", ad.adopted == 1 and #rc8.resolved == 1 and b8:last().resolved.assigned == "Sequence 77" and b8:last().resolved.pageNo == 4 and b8:last().frozen == true, J(b8:last()))
end

-------------------------------------------------------------------------------
-- KB-22: executor operations on the console backend (Press/Unpress Page P.E, Fader<Fn> Page P.E At)
-------------------------------------------------------------------------------
do
  local cmds, feedback, raise = {}, "OK", nil
  local deps = { cmd = function(text) cmds[#cmds + 1] = text; if raise then local r = raise; raise = nil; error(r, 0) end; return feedback end }
  local function freshConsole()
    local inst = CTL.new({ owner = "test", config = { requireBindingRevision = false }, deps = { binding = function() return binding end, busy = function() return busyOwner end } }):init()
    local b = CTL.consoleBackend(deps)
    inst:enableInput(b)
    inst:openSession({ id = "s" }, 1)
    cmds = {}; feedback = "OK"; raise = nil
    return inst, b
  end
  local function key(seq, exec, down, extra)
    local e = { type = "button", device = "mtouch", control = "PFA" .. tostring(exec), seq = seq, generation = binding.generation, target = { executor = exec, element = "key" }, down = down }
    for k, v in pairs(extra or {}) do e[k] = v end
    return e
  end
  -- The plan
  local ex201 = CTL.resolveTarget(binding, { executor = 201, element = "key" })
  local plan = CTL.executorOperation("button", ex201)
  check("kb22: a key on a qualified function (Go+) plans Press/Unpress Page <p>.<e> and carries the configured release function", plan and plan.address == "Page 1.201" and plan.entry.name == "Go+" and plan.entry.momentary == false and ex201.keyUnpress == nil, J(plan))
  local fx = CTL.resolveTarget(binding, { executor = 201, element = "fader" })
  local fplan = CTL.executorOperation("absolute", fx, 0.25)
  check("kb22: a Master fader plans FaderMaster Page <p>.<e> At over 0..100 with neutral 100", fplan and fplan.keyword == "FaderMaster" and fplan.level == 25 and fplan.from == 0 and fplan.to == 100 and fplan.neutral == 100, J(fplan))
  local _, rX = CTL.executorOperation("absolute", CTL.resolveTarget(binding, { executor = 202, element = "fader" }), 0.5)
  local _, rR = CTL.executorOperation("absolute", { kind = "executor", executor = 1, pageNo = 1, element = "fader", ["function"] = "Rate" }, 0.5)
  local _, rU = CTL.executorOperation("absolute", { kind = "executor", executor = 1, pageNo = 1, element = "fader", ["function"] = "Bogus" }, 0.5)
  local _, rN = CTL.executorOperation("absolute", { kind = "executor", executor = 1, pageNo = 1, element = "fader", ["function"] = "" }, 0.5)
  local _, rK = CTL.executorOperation("button", { kind = "executor", executor = 1, pageNo = 1, element = "key", ["function"] = "LearnSpeed" })
  local _, rE = CTL.executorOperation("button", { kind = "executor", executor = 1, pageNo = 1, element = "key", ["function"] = "" })
  local _, rB = CTL.executorOperation("button", { kind = "executor", executor = 1, pageNo = 1, element = "fader", ["function"] = "Master" })
  local _, rP = CTL.executorOperation("button", { kind = "executor", executor = 1, element = "key", ["function"] = "Temp" })
  local _, rV = CTL.executorOperation("absolute", fx, 1.5)
  check("kb22: X, Rate (unqualified, with their recorded range and neutral), an unknown or empty fader function, LearnSpeed, an empty key function, a button on a fader, a target without a page and a value outside 0..1 are refused with the reason",
    rX:find("X is not qualified yet") and rR:find("Rate is not qualified yet") and rR:find("neutral 50") and rU:find("'Bogus' is not qualified") and rN:find("no configured fader function") and rK:find("LearnSpeed is not qualified yet")
    and rE:find("no configured key function") and rB:find("not an operation of an executor fader") and rP:find("no page number") and rV:find("0..1"), J({ rX, rR, rU, rN, rK, rE, rB, rP, rV }))
  local tplan = CTL.executorOperation("touch", fx)
  check("kb22: a fader touch is a hold (no command); the qualification tables are exported with their evidence", tplan and tplan.touch == true and CTL.KEY_FUNCTIONS.temp.momentary == true and CTL.KEY_FUNCTIONS.flash.qualified and CTL.FADER_FUNCTIONS.master.qualified and CTL.FADER_FUNCTIONS.rate.qualified == false and CTL.FADER_FUNCTIONS.temp.stateful == true)
  -- Press / release through the backend
  local inst, b = freshConsole()
  check("kb22: the console backend declares executor keys and faders, not encoders, and lists the qualified functions", b.capabilities.targets.executor == true and b.capabilities.executorElements.key == true and b.capabilities.executorElements.encoder == false and table.concat(b.capabilities.keyFunctions, ",") == "Flash,Go+,Temp,Toggle,Top" and table.concat(b.capabilities.faderFunctions, ",") == "Master,Temp")
  local okD, eD = inst:submit("s", 1, key(1, 201, true))
  local adm = inst:admission(1.001)
  check("kb22: a key down on executor 201 is admitted as a hold; the instance is busy with it", okD and okD.accepted and adm and adm.reason == "button-down" and adm.target.executor == 201, J(adm or eD))
  local sv = inst:service(1.01)
  local la = inst:status(1.02).lastApplied
  check("kb22: the down is Press Page 1.201 (the console runs the configured Go+); the record names the key function", sv.applied == 1 and cmds[1] == "Press Page 1.201" and la.outcome == "applied" and la.result.keyFunction == "Go+" and la.result.command == "Press Page 1.201" and b.counters.applied == 1, J({ cmds, la }))
  inst:submit("s", 1.03, key(2, 201, false))
  sv = inst:service(1.04)
  check("kb22: the release is Unpress Page 1.201 and the instance is idle again", sv.applied == 1 and cmds[2] == "Unpress Page 1.201" and inst:admission(1.05) == nil and inst:status(1.05).lastApplied.down == false, J(cmds))
  -- A refused Press keeps the hold owned; its release still issues the Unpress.
  cmds = {}; feedback = "Error: no"
  inst:submit("s", 1.1, key(3, 201, true))
  sv = inst:service(1.11)
  feedback = "OK"
  check("kb22: a Press the console refused is backend-refused and the hold stays owned", sv.dropped.refused == 1 and inst:status(1.12).lastApplied.outcome == "refused" and inst:admission(1.12) ~= nil and b.counters.refused == 1, J(sv))
  inst:submit("s", 1.13, key(4, 201, false))
  sv = inst:service(1.14)
  check("kb22: its release still issues Unpress Page 1.201 (harmless when not pressed, never a stuck press)", sv.applied == 1 and cmds[2] == "Unpress Page 1.201" and inst:admission(1.15) == nil, J(cmds))
  -- An unqualified key function is refused at admission; nothing pressed, nothing owned.
  binding.executors[1].value.functions.keyPress = "LearnSpeed"
  local okL, eL = inst:submit("s", 1.2, key(5, 201, true))
  binding.executors[1].value.functions.keyPress = "Go+"
  check("kb22: a key whose configured function is not qualified (LearnSpeed) is refused unsupported at admission and owns nothing", okL == nil and eL.code == "unsupported" and eL.reason:find("LearnSpeed") and inst:admission(1.21) == nil and inst:status(1.21).sessions.s.gestures == 0, J(eL))
  binding.executors[1].value.functions.keyPress = ""
  local okN, eN = inst:submit("s", 1.22, key(6, 201, true))
  binding.executors[1].value.functions.keyPress = "Go+"
  check("kb22: an executor with an empty KeyPress is refused unsupported (no configured key function)", okN == nil and eN.code == "unsupported" and eN.reason:find("no configured key function"), J(eN))
  binding.executors[1].value.functions.encoder = "Master"
  local okEn, eEn = inst:submit("s", 1.23, { type = "button", device = "nxk", control = "Enc201", seq = 7, generation = binding.generation, target = { executor = 201, element = "encoder" }, down = true })
  binding.executors[1].value.functions.encoder = nil
  check("kb22: an executor encoder element stays unsupported", okEn == nil and eEn.code == "unsupported" and eEn.reason:find("executor encoders"), J(eEn))
  -- Momentary function + reassignment while held: the release is NOT issued on the replacement; it is an
  -- assignment-changed record until the original object is back (recover) - the acceptance's recovery rule.
  cmds = {}
  binding.executors[1].value.functions.keyPress = "Temp"
  inst:submit("s", 1.3, key(8, 201, true))
  inst:service(1.31)
  binding.executors[1].value.assigned = { addr = "Sequence 99", class = "Sequence" }; binding.generation = binding.generation + 1
  local r2 = inst:submit("s", 1.32, key(9, 201, false))
  sv = inst:service(1.33)
  st = inst:status(1.34)
  check("kb22: a Temp held across a reassignment (Sequence 1 -> 99) is not released on the replacement: no Unpress, an assignment-changed record naming both objects, the instance idle", cmds[1] == "Press Page 1.201" and #cmds == 1 and r2.accepted and #sv.unresolved == 1 and sv.unresolved[1].reassigned == true and sv.unresolved[1].resolved.assigned == "Sequence 1" and sv.unresolved[1].nowAssigned == "Sequence 99" and st.lastApplied.outcome == "unresolved" and st.lastApplied.reassigned == true and #st.unresolved == 1 and inst:admission(1.34) == nil, J({ cmds, sv.unresolved, st.lastApplied }))
  local rec0 = inst:recover(1.35)
  check("kb22: recover() keeps it unresolved while the replacement is still assigned (nothing issued)", #rec0.unresolved == 1 and #rec0.resolved == 0 and #cmds == 1 and rec0.unresolved[1].attempts == 2, J(rec0))
  binding.executors[1].value.assigned = { addr = "Sequence 1", class = "Sequence" }
  local rec1 = inst:recover(1.36)
  binding.executors[1].value.functions.keyPress = "Go+"
  check("kb22: once Sequence 1 is back on 201, recover() issues Unpress Page 1.201 and resolves the record", #rec1.resolved == 1 and cmds[2] == "Unpress Page 1.201" and #inst:status(1.37).unresolved == 0, J({ rec1, cmds }))
  -- An emptied executor is the same rule; a following record on another page cannot be judged and is released.
  cmds = {}
  inst:submit("s", 1.4, key(10, 201, true)); inst:service(1.41)
  local savedV = binding.executors[1].value
  binding.executors[1].value = { executor = 201, page = { no = 1, name = "Page 1" }, pool = { name = "Default", no = 1 }, mode = "current", empty = true, playbackTarget = false }
  local outE = inst:closeSession("s", 1.42, "disconnect")
  binding.executors[1].value = savedV
  check("kb22: a disconnect while the executor was emptied keeps the release as an assignment-changed record (not issued)", #outE.unresolved == 1 and outE.unresolved[1].nowEmpty == true and #cmds == 1, J({ outE, cmds }))
  check("kb22: recover() with the object back issues the Unpress", #inst:recover(1.43).resolved == 1 and cmds[2] == "Unpress Page 1.201", J(cmds))
  inst:openSession({ id = "s" }, 1.44)
  cmds = {}
  inst:submit("s", 1.45, key(11, 201, true)); inst:service(1.46)
  binding.executors[1].value = { executor = 201, page = { no = 2, name = "Page 2" }, pool = { name = "Default", no = 1 }, mode = "current", empty = false, playbackTarget = true, assigned = { addr = "Sequence 77", class = "Sequence" }, functions = { keyPress = "Go+", fader = "Master" } }
  inst:submit("s", 1.47, key(12, 201, false)); sv = inst:service(1.48)
  binding.executors[1].value = savedV
  check("kb22: a following record whose item now reads another page (a console page change) is released on its frozen page: Unpress Page 1.201", sv.applied == 1 and cmds[2] == "Unpress Page 1.201" and #sv.unresolved == 0, J({ cmds, sv }))
  -- A forced end (lease expiry) and recover() issue the Unpress too; a raise is unresolved until recover.
  cmds = {}
  inst:submit("s", 1.5, key(13, 201, true))
  inst:service(1.51)
  raise = "Cmd exploded"
  local out = inst:closeSession("s", 1.52, "disconnect")
  check("kb22: a forced end whose Unpress raised is unresolved with the frozen executor", #out.unresolved == 1 and out.unresolved[1].resolved.executor == 201 and out.unresolved[1].frozen == true and cmds[2] == "Unpress Page 1.201" and b.counters.raised == 1, J(out))
  local rec = inst:recover(1.6)
  check("kb22: recover() re-issues Unpress Page 1.201 and resolves it", #rec.resolved == 1 and cmds[3] == "Unpress Page 1.201" and #inst:status(1.6).unresolved == 0, J({ rec, cmds }))
  -- Faders: touch hold (noop), Master placed, Temp stateful (never superseded), X refused.
  inst, b = freshConsole()
  local okT = inst:submit("s", 2, touch(1, 201, true))
  sv = inst:service(2.01)
  check("kb22: a touch on a Master fader is a hold applied as a noop (no command) and the instance is busy", okT and okT.accepted and sv.applied == 1 and #cmds == 0 and b.counters.noop == 1 and inst:admission(2.02).reason == "touch-down" and inst:status(2.02).lastApplied.result.note:find("executor's fader"), J(sv))
  inst:submit("s", 2.03, abs(2, 201, 0.3))
  inst:submit("s", 2.03, abs(3, 201, 0.5))
  sv = inst:service(2.04)
  la = inst:status(2.05).lastApplied
  check("kb22: two positions on a Master fader supersede (stateless) and place FaderMaster Page 1.201 At 50; the record carries the function, travel and neutral", sv.applied == 1 and cmds[1] == "FaderMaster Page 1.201 At 50" and la.result.faderFunction == "Master" and la.result.level == 50 and la.result.neutral == 100 and la.result.stateful == nil, J({ cmds, la }))
  inst:submit("s", 2.06, touch(4, 201, false))
  inst:service(2.07)
  cmds = {}
  binding.executors[2].value.functions.fader = "Temp"; binding.executors[2].value.level = { token = "FaderTemp", value = 0 }
  inst:submit("s", 2.1, abs(5, 202, 0.6))
  inst:submit("s", 2.1, abs(6, 202, 0))
  sv = inst:service(2.11)
  binding.executors[2].value.functions.fader = "X"; binding.executors[2].value.level = { token = "FaderX", value = 0 }
  check("kb22: positions on a Temp fader are stateful (both kept, in order): FaderTemp Page 1.202 At 60 then At 0", sv.applied == 2 and cmds[1] == "FaderTemp Page 1.202 At 60" and cmds[2] == "FaderTemp Page 1.202 At 0" and b.counters.applied == 3, J(cmds))
  local okP, eP = inst:submit("s", 2.2, abs(7, 201, 0.5, { page = nil }))
  local okQ, eQ = inst:submit("s", 2.2, { type = "absolute", device = "mtouch", control = "Strip211", seq = 8, generation = binding.generation, target = { executor = 211, element = "fader", page = 2 }, value = 0.5, gesture = 1 })
  sv = inst:service(2.21)
  check("kb22: a page-bound target is addressed on its page: FaderMaster Page 2.211 At 50", okP and okQ and cmds[3] == "FaderMaster Page 1.201 At 50" and cmds[4] == "FaderMaster Page 2.211 At 50", J({ eP or okP, eQ or okQ, cmds }))
  check("kb22: the backend status lists the qualified functions", b:status().executorFunctions.keys[1] == "Flash" and b:status().executorFunctions.faders[2] == "Temp")
end

print(string.format("%d passed, %d failed", passes, failures))
print(failures == 0 and "ALL PASSED" or "FAILED")
os.exit(failures == 0 and 0 or 1)
