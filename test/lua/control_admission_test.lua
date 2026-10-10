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
check("module loads without console API", type(CTL) == "table" and CTL.VERSION == "0.2.0" and CTL.API_VERSION == 1 and type(CTL.new) == "function")
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
    { available = true, value = { executor = 201, page = 1, empty = false, playbackTarget = true, assigned = { addr = "Sequence 1", class = "Sequence" }, functions = { keyPress = "Go+", fader = "Master" }, level = { token = "FaderMaster", value = 50 } } },
    { available = true, value = { executor = 202, page = 1, empty = false, playbackTarget = true, assigned = { addr = "Sequence 2" }, functions = { keyPress = "Toggle", fader = "X" }, level = { token = "FaderX", value = 0 } } },
    { available = true, value = { executor = 203, page = 1, empty = true } },
    { available = true, value = { executor = 204, page = 1, empty = false, playbackTarget = false, reserved = true, assigned = { addr = "Quickey 1" }, functions = { keyPress = "Toggle" } } },
    { available = false, params = { executor = 205 }, reason = "not observed yet" },
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
  check("executor fader 201 resolves with the Master token", (function() local r = inst:submit("s", 1, abs(1, 201, 0.5)); return r and r.accepted and r.target:find("^exec201%.fader") and r.stateful == nil end)())
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
  check("kb19: the backend declares its capabilities and calibration", b.name == "console" and b.capabilities.relative == true and b.capabilities.button == false and b.capabilities.targets.slot == true and b.calibration.fineDivisor == 10 and b.calibration.note:find("one physical detent"))
  local okB, eB = inst:submit("s", 1, button(1, 1, true))
  check("kb19: an encoder press is refused unsupported at admission (calculator/open/select not qualified) and owns nothing", okB == nil and eB.code == "unsupported" and eB.reason:find("not qualified") and eB.backend == "console" and inst:status(1).sessions.s.gestures == 0 and inst:admission(1) == nil, J(eB))
  local okT, eT = inst:submit("s", 1, touch(1, 201, true))
  local okA, eA = inst:submit("s", 1, abs(2, 201, 0.5))
  check("kb19: touches and positions are refused unsupported (KB-20/22)", okT == nil and eT.code == "unsupported" and okA == nil and eA.code == "unsupported" and eA.message:find("absolute on exec201.fader"), J({ eT, eA }))
  binding.executors[1].value.functions.encoder = "Master"
  local okE, eE = inst:submit("s", 1, { type = "relative", device = "nxk", control = "Enc201", seq = 3, generation = binding.generation, target = { executor = 201, element = "encoder" }, delta = 1, gesture = 1 })
  binding.executors[1].value.functions.encoder = nil
  check("kb19: relative motion on an executor encoder element is refused unsupported (KB-21/22)", okE == nil and eE.code == "unsupported" and eE.reason:find("executor elements"), J(eE))
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
    sv.applied == 4 and cmds[1] == 'Attribute "Dimmer" At + 3' and cmds[2] == 'Attribute "Dimmer" At - 5' and cmds[3] == 'Attribute "Dimmer" At + 0.2' and cmds[4] == 'Attribute "Pan" At + 1.5', J({ sv, cmds }))
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
  check("limitations and lists are published", #CTL.LIMITATIONS == 3 and #CTL.EVENT_TYPES == 4 and CTL.STATEFUL_FUNCTIONS.x == true and CTL.backends.fake == "fake" and CTL.backends.console == "console" and CTL.CALIBRATION.readouts.Percent == 1)
  check("resolveTarget is exported for consumers", CTL.resolveTarget(binding, { slot = 1 }).key:find("^slot1") ~= nil)
end

print(string.format("%d passed, %d failed", passes, failures))
print(failures == 0 and "ALL PASSED" or "FAILED")
os.exit(failures == 0 and 0 or 1)
