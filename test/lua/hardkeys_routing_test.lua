-- Regression harness for the KB-11 shared per-key routing policy of plugin/gma3_mcp_hardkeys.lua
-- under stock Lua.
--
-- Everything runs against the module's FAKE backend (which simulates PC-key and Quickey tuples and
-- dispatches nothing) with fake console readers, so the shortcut mode, the table and the profile can be
-- staged per step. The clock is a plain number; nothing sleeps.
--
-- Run from the repository root:   lua test/lua/hardkeys_routing_test.lua

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

-- Fake console: VirtualKeyCode enum (KB-10 values), a profile whose rows and mode tests mutate.
local VK = { MA1 = 1, MA2 = 2, STORE = 66, NUM0 = 67, NUM1 = 68, NUM5 = 72, THRU = 78, PLUS = 77, PLEASE = 84, OOPS = 86, UNDO = 86,
             CLEAR = 87, ESC = 88, FIXTURE = 56, EDIT = 62, COPY = 49, EXEC = 35, X1 = 19, ENCODER_INSIDE1 = 89, DEF_GO = 37 }
local profile = { name = "Default", shortcutsActive = true, rows = nil, vk = VK }
local function defaultRows()
  return {
    { shortcut = "S", keyCode = 66 },
    { shortcut = "5", keyCode = 72 },
    { shortcut = "1", keyCode = 68 },
    { shortcut = "Enter", keyCode = 84 },
    { shortcut = "Backspace", keyCode = 86 },
    { shortcut = "Delete", keyCode = 87 },
    { shortcut = "Escape", keyCode = 88 },
    { shortcut = "F", keyCode = 56 },
    { shortcut = "Equal", keyCode = 77 },   -- PLUS twice with equal modifier count: ambiguous without prefer
    { shortcut = "kpAdd", keyCode = 77 },
    { shortcut = "E", keyCode = 62 },       -- EDIT collides with COPY below
    { shortcut = "E", keyCode = 49 },
    -- THRU has no row: the "confirmed missing mapping" case
  }
end
profile.rows = defaultRows()
local deps = {
  shortcutRows = function() return profile.rows end,
  virtualKeyCodes = function() return profile.vk end,
  shortcutsActive = function() return profile.shortcutsActive end,
  profileName = function() return profile.name end,
  displayExists = function(n) return n == 1 or n == 2 end,
}

local function fresh(opts)
  opts = opts or {}
  local backend = HK.fakeBackend({ capabilities = opts.capabilities })
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
-- A Quickey tuple as the module stores it: name plus validated code value (ownership identity).
local function qk(name) return { quickkey = name, quickkeyCode = VK[name] } end
local function reset() profile.rows = defaultRows(); profile.shortcutsActive = true; profile.vk = VK; profile.name = "Default" end

-------------------------------------------------------------------------------
-- Policy validation: methods, fields, text rules, atomicity
-------------------------------------------------------------------------------
do
  reset()
  check("methods exported in the documented spelling", J(HK.METHODS) == J({ "quickkey", "shortcutOrType", "shortcut", "type" }) and HK.DEFAULT_METHOD == "shortcut")
  local p, err = HK.validateRoutingPolicy({ default = "keyboard" })
  check("unknown default method fails validation", p == nil and err.code == "policy-invalid" and err.message:find("keyboard"), J(err))
  p, err = HK.validateRoutingPolicy({ keys = { STORE = { method = "macro" } } })
  check("unknown per-key method fails validation", p == nil and err.code == "policy-invalid" and err.key == "STORE", J(err))
  p, err = HK.validateRoutingPolicy({ fallback = "type" })
  check("unknown policy field refused", p == nil and err.message:find("fallback"), J(err))
  p, err = HK.validateRoutingPolicy({ keys = { NUM5 = { text = "5", colour = "red" } } })
  check("unknown per-key field refused", p == nil and err.message:find("colour"), J(err))
  p, err = HK.validateRoutingPolicy({ keys = { NUM5 = { text = "5 " } } })
  check("a digit's text must be one character without spaces", p == nil and err.message:find("exactly one character"), J(err))
  p, err = HK.validateRoutingPolicy({ keys = { NUM5 = { text = "55" } } })
  check("a two-character digit mapping is refused", p == nil and err.message:find("got 2"), J(err))
  p = HK.validateRoutingPolicy({ keys = { NUM5 = { text = "5" }, thru = { text = "Thru " } } })
  check("digit and keyword mappings accepted; key names normalised; separators kept exactly", p and p.keys.NUM5.text == "5" and p.keys.THRU.text == "Thru " and p.keys.THRU.textChars == 5, J(p))
  for _, k in ipairs({ "MA", "MA1", "PLEASE", "CLEAR", "OOPS", "UNDO", "ESC", "EXEC", "X1", "ENCODER_INSIDE1", "DEF_GO", "XKEYS" }) do
    p, err = HK.validateRoutingPolicy({ keys = { [k] = { text = "x" } } })
    check("no text mapping for " .. k, p == nil and err.code == "policy-invalid" and err.message:find("actions, not characters"), J(err))
  end
  p, err = HK.validateRoutingPolicy({ keys = { THRU = { text = "Thru\n" } } })
  check("control characters in text refused", p == nil and err.message:find("newline"), J(err))
  p, err = HK.validateRoutingPolicy({ keys = { THRU = { text = "" } } })
  check("empty text refused", p == nil and err.message:find("non%-empty"), J(err))
  p, err = HK.validateRoutingPolicy({ keys = { THRU = { quickkey = 78 } } })
  check("quickkey must be a VirtualKeyCode name string", p == nil and err.message:find("VirtualKeyCode name"), J(err))
  p, err = HK.validateRoutingPolicy({ keys = { PLUS = { prefer = 5 } } })
  check("prefer must be a string", p == nil and err.message:find("PC key name"), J(err))
  p, err = HK.validateRoutingPolicy({ keys = { Store = {}, STORE = {} } })
  check("duplicate names (case-insensitive) refused", p == nil and err.message:find("twice"), J(err))
  p = HK.validateRoutingPolicy({ keys = { UNDO = { method = "quickkey", quickkey = "oops" } } })
  check("quickkey code is normalised to upper case and kept distinct from the key", p and p.keys.UNDO.quickkey == "OOPS", J(p))
  check("new() raises on a bad routing policy", not pcall(HK.new, { owner = "x", deps = deps, routing = { default = "nope" } }))
  -- configureRouting is atomic: a refused policy leaves the previous one in place.
  local inst = fresh({ routing = { keys = { NUM5 = { method = "quickkey" } } } })
  local r; r, err = inst:configureRouting({ default = "quickkey", keys = { NUM5 = { text = "5", method = "bogus" } } })
  check("refused configureRouting changes nothing", r == nil and err.code == "policy-invalid" and inst:routingReport().default == "shortcut" and inst:routingReport().keys.NUM5.method == "quickkey", J(inst:routingReport()))
  r = inst:configureRouting({ default = "quickkey" })
  check("configureRouting reports the new policy", r.default == "quickkey" and r.defaultSource == "consumer" and r.overrideCount == 0, J(r))
  check("text helper exported", HK.textForbidden("ENCODER_OUTSIDE3") == true and HK.textForbidden("THRU") == false)
end

-------------------------------------------------------------------------------
-- Configuration precedence and reporting
-------------------------------------------------------------------------------
do
  reset()
  local inst = fresh({ routing = { default = "quickkey", keys = { STORE = { method = "shortcut" }, UNDO = { quickkey = "OOPS" }, PLUS = { prefer = "kpAdd", method = "shortcut" } } } })
  local d = inst:describeRoute("NUM5")
  check("consumer default applies to a key without an override", d.method == "quickkey" and d.methodSource == "default" and d.effective == "quickkey" and d.quickkey == "NUM5" and d.codeValue == 72 and d.dispatchable == true and #d.unavailable == 0, J(d))
  d = inst:describeRoute("store")
  check("per-key override wins over the consumer default", d.method == "shortcut" and d.methodSource == "key" and d.effective == "shortcut-table" and d.tuple.pcKey == "S" and d.dispatchable, J(d))
  d = inst:describeRoute("UNDO")
  check("quickkey code field is distinct from the logical key", d.key == "UNDO" and d.quickkey == "OOPS" and d.codeValue == 86 and d.dispatchable, J(d))
  d = inst:describeRoute("PLUS")
  check("policy prefer resolves the tie", d.effective == "shortcut-table" and d.tuple.pcKey == "kpAdd" and d.resolution.prefer == "kpAdd", J(d))
  d = inst:describeRoute("PLUS", { prefer = "Equal" })
  check("a call-level prefer overrides the policy prefer", d.tuple.pcKey == "Equal", J(d))
  d = inst:describeRoute("NUM5")
  check("capabilities reported", d.capabilities.quickkey.hold == true and d.capabilities.keyboard == true and d.backend == "fake" and d.quickkeyCapabilities.chord == true, J(d))
  local st = inst:status(0)
  check("status carries the routing summary and backend capabilities", st.routing.default == "quickkey" and st.routing.keys.STORE.method == "shortcut" and st.routing.keys.STORE.methodSource == "key" and st.routing.methods.quickkey.available == true and st.routing.methods.type.available == false and has(st.routing.methods.type.missing, "KB-14") and st.backend.capabilities.quickkey.tap == true, J(st.routing))
  local plain = fresh()
  d = plain:describeRoute("STORE")
  check("no policy: module default is shortcut and reported as such", d.method == "shortcut" and d.methodSource == "module-default" and plain:routingReport().defaultSource == "module", J(d))
  local off = fresh({ disabled = true })
  d = off:describeRoute("STORE")
  check("without a backend the route resolves but is not dispatchable", d.supported and not d.dispatchable and has(d.unavailable, "no backend attached") and d.code == "unavailable", J(d))
  check("routingReport without a backend names it for every method", has(off:routingReport().methods.shortcut.missing, "no backend attached"))
end

-------------------------------------------------------------------------------
-- Existing callers keep their defaults (method shortcut)
-------------------------------------------------------------------------------
do
  reset()
  local inst, backend = fresh()
  local h = inst:press("s", 1, { key = "STORE" })
  check("STORE presses through the shortcut table exactly as before, with the method recorded", h and h.pcKey == "S" and h.route.source == "shortcut-table" and h.method == "shortcut" and h.route.methodSource == "module-default" and lastEvent(backend).pcKey == "S", J(h))
  inst:release("s", 2, { hold = h.id })
  profile.shortcutsActive = false
  local n = #backend.events
  local x, err = inst:press("s", 3, { key = "STORE" })
  check("shortcuts inactive: same refusal code and wording as before, plus the KB-14 requirement", x == nil and err.code == "unsupported" and err.message:find("inactive") and err.message:find("never toggled") and has(err.route.unavailable, "KB-14") and #backend.events == n, J(err))
  local d = inst:describeRoute("STORE")
  check("describeRoute reports the inactive shortcut route as unsupported with the requirement", not d.supported and d.code == "shortcuts-inactive" and has(d.unavailable, "KB-14"), J(d))
  x, err = inst:press("s", 3, { key = "PLEASE" })
  check("native PLEASE still works with shortcuts off under method shortcut", x and x.route.source == "native" and x.method == "shortcut", J(err))
  inst:release("s", 4, { hold = x.id })
  profile.shortcutsActive = nil
  x, err = inst:press("s", 5, { key = "STORE" })
  check("unreadable enablement is still refused rather than guessed", x == nil and err.code == "unsupported" and err.message:find("cannot be established"), J(err))
  reset()
  x, err = inst:press("s", 6, { key = "MA1" })
  check("MA1 stays unsupported on the keyboard route", x == nil and err.code == "unsupported" and err.message:find("MA1"), J(err))
  x, err = inst:press("s", 6, { key = "NOPE" })
  check("an unknown key stays unsupported", x == nil and err.code == "unsupported" and err.reason == "unknown-key", J(err))
  local raw = inst:press("s", 7, { pcKey = "F3" })
  check("raw PC-key specs bypass the policy", raw and raw.route.source == "raw" and raw.method == nil, J(raw))
  inst:releaseAll("s", 8)
end

-------------------------------------------------------------------------------
-- quickkey: dispatch, retention, release, aliases, unknown codes, backend limits
-------------------------------------------------------------------------------
do
  reset()
  local inst, backend = fresh({ routing = { default = "quickkey", keys = { UNDO = { quickkey = "OOPS" } } } })
  local h = inst:press("s", 1, { key = "NUM5" })
  check("a quickkey press dispatches a Quickey tuple", h and h.quickkey == "NUM5" and h.pcKey == nil and h.tupleKey == "quickkey:#72" and h.quickkeyCode == 72 and h.route.source == "quickkey" and h.method == "quickkey" and h.route.codeValue == 72 and lastEvent(backend).kind == "press" and lastEvent(backend).quickkey == "NUM5", J(h))
  check("the fake simulates the key down", backend:isDown(qk("NUM5")))
  -- Route retention: switching the policy mid-hold does not change the stored route or the release.
  local r = inst:configureRouting({ default = "shortcut" })
  check("policy changes while a key is held are accepted (nothing released, nothing re-routed)", r and r.default == "shortcut" and inst:status(1.5).holds[1].state == "held", J(r))
  local st = inst:status(1.5)
  check("the live hold keeps its quickkey route and no mismatch is reported", st.holds[1].route.source == "quickkey" and st.holds[1].routeMismatch == nil, J(st.holds[1]))
  profile.shortcutsActive = false
  local rel = inst:release("s", 2, { hold = h.id })
  check("release uses the stored Quickey tuple on the same backend despite the policy and mode change", rel.state == "released" and lastEvent(backend).kind == "release" and lastEvent(backend).quickkey == "NUM5" and not backend:isDown(qk("NUM5")), J(rel))
  reset()
  inst:configureRouting({ default = "quickkey", keys = { UNDO = { quickkey = "OOPS" } } })
  -- Release by logical name resolves through the policy to the same tuple.
  h = inst:press("s", 3, { key = "UNDO" })
  check("alias override dispatches the configured code", h and h.quickkey == "OOPS" and h.logical == "UNDO" and h.tupleKey == "quickkey:#86", J(h))
  rel = inst:release("s", 4, { key = "undo" })
  check("release by logical name finds the Quickey hold", rel.state == "released" and rel.quickkey == "OOPS", J(rel))
  -- MA1 is a valid Quickey code (KB-10) even though the keyboard route cannot distinguish it.
  h = inst:press("s", 5, { key = "MA1" })
  check("MA1 is dispatchable as a Quickey", h and h.quickkey == "MA1", J(h))
  local c = inst:combo("s", 5, { { key = "STORE" }, { key = "NUM1" } }, { holdMs = 50 })
  check("a chord of Quickeys presses in order", c and c.count == 2 and c.holds[1].quickkey == "STORE" and c.holds[2].quickkey == "NUM1", J(c))
  inst:service(5.1)
  check("chord tap released at the deadline, MA1 still held", not backend:isDown(qk("STORE")) and backend:isDown(qk("MA1")))
  inst:release("s", 6, { hold = h.id })
  local x, err = inst:press("s", 7, { key = "MA" })
  check("MA (a keyboard-only name) is not a Quickey code: refused, nothing guessed", x == nil and err.code == "unsupported" and err.reason == "unknown-key" and err.message:find("MA1") == nil and err.message:find("VirtualKeyCode"), J(err))
  x, err = inst:press("s", 7, { key = "FOO" })
  check("unknown code refused", x == nil and err.reason == "unknown-key", J(err))
  profile.vk = nil
  x, err = inst:press("s", 8, { key = "NUM5" })
  check("an unreadable enum is a refusal", x == nil and err.code == "unsupported" and err.reason == "unreadable", J(err))
  reset()
  -- A tap through the policy.
  local t = inst:tap("s", 9, { key = "NUM5" }, 50)
  check("tap dispatches and schedules the release", t and t.quickkey == "NUM5" and t.releaseOutcome == "scheduled", J(t))
  inst:service(9.1)
  check("tap released", not backend:isDown(qk("NUM5")) and t.releaseOutcome == "scheduled")
  -- No fallback once dispatch begins: a raise leaves the record unresolved and nothing else is tried.
  local n = #backend.events
  backend:raiseNext("press", "wedged")
  x, err = inst:press("s", 10, { key = "NUM5" })
  check("a raising Quickey press is unresolved; no keyboard event is attempted", x == nil and err.code == "press-failed" and err.unresolved and #backend.events == n and inst:status(10).unresolved == 1, J(err))
  backend:failNext("press", qk("NUM1"), "busy")
  x, err = inst:press("s", 10, { key = "NUM1" })
  local noRecord = true
  for _, hh in ipairs(inst:status(10).holds) do if hh.quickkey == "NUM1" and hh.state ~= "released" then noRecord = false end end
  check("a refused Quickey press is press-failed with no record and no other route", x == nil and err.code == "press-failed" and err.message:find("busy") and noRecord and #backend.events == n + 1, J(err))
  inst:recover("s", 11)
  check("recovery releases the unresolved Quickey record through the Quickey tuple", inst:status(11).unresolved == 0 and lastEvent(backend).kind == "release" and lastEvent(backend).quickkey == "NUM5", J(inst:status(11).holds))
  -- Sequences go through the policy too.
  local q; q, err = inst:startSequence("s", 12, { { kind = "tap", key = "FIXTURE" }, { kind = "tap", key = "NUM1" }, { kind = "tap", key = "PLEASE" } })
  check("sequence steps resolve to Quickey tuples", q and q.state == "running", J(err))
  for i = 1, 12 do inst:service(12 + i * 0.1) end
  local rep = inst:sequenceStatus(q.id, 14)
  check("sequence completed through Quickeys", rep.state == "completed" and rep.events[3].tupleKey == "quickkey:#84", J(rep))
  -- Backend limits: a fake without Quickey dispatch cannot host a quickkey policy.
  local bare = HK.fakeBackend({ capabilities = { keyboard = true, quickkey = false, char = true } })
  local inst2 = HK.new({ owner = "x", deps = deps, config = { requireInteraction = false }, routing = { default = "quickkey" } }):init()
  r, err = inst2:enableInput(bare)
  check("enableInput refuses a backend that cannot serve the policy; nothing attaches", r == nil and err.code == "policy-unavailable" and err.problems[1].method == "quickkey" and has(err.problems[1].missing, "KB-13") and inst2:status().backend.attached == false and inst2:status().inputEnabled == false, J(err))
  inst2 = HK.new({ owner = "x", deps = deps, config = { requireInteraction = false } }):init()
  inst2:enableInput(bare)
  r, err = inst2:configureRouting({ keys = { NUM5 = { method = "quickkey" } } })
  check("configureRouting refuses a method the attached backend lacks", r == nil and err.code == "policy-unavailable" and inst2:routingReport().overrideCount == 0, J(err))
  local kb = HK.keyboardBackend({ Keyboard = function() end, keyboardCodes = function() return { S = 1 } end, displayExists = function() return true end })
  check("the Keyboard() backend advertises no Quickey dispatch and refuses Quickey tuples", HK.adapterCapabilities(kb).quickkey == false and select(1, kb:preflight({ quickkey = "NUM5" })) == false and select(1, kb:press({ quickkey = "NUM5" })) == false)
  local legacy = { name = "fake", dispatches = true, press = function() return true, true end, release = function() return true, true end }
  check("an adapter without a capabilities field is a PC-key adapter", HK.adapterCapabilities(legacy).keyboard == true and HK.adapterCapabilities(legacy).quickkey == false and HK.adapterCapabilities(legacy).char == false)
  -- A quickkey hold rechecks its stored decision: losing the enum mid-hold is a route mismatch, and
  -- restoring it clears it; the current policy is never consulted for the live record.
  reset()
  inst:configureRouting({ default = "quickkey" })
  h = inst:press("s", 20, { key = "NUM5" })
  inst:configureRouting({ default = "shortcut", keys = { NUM5 = { method = "shortcut" } } })
  profile.vk = nil
  x, err = inst:press("s", 21, { pcKey = "F3" })
  check("an enum that became unreadable during a Quickey hold blocks new input as a route change", x == nil and err.code == "route-changed" and err.message:find("NUM5"), J(err))
  reset()
  rel = inst:release("s", 22, { hold = h.id })
  check("restored enum: the hold releases through its stored Quickey tuple, ignoring the new shortcut policy for NUM5", rel.state == "released" and rel.route.source == "quickkey" and rel.routeRestored ~= nil and lastEvent(backend).quickkey == "NUM5", J(rel))
end

-------------------------------------------------------------------------------
-- Quickey capability flags: tap / hold / chord are enforced per operation before dispatch
-------------------------------------------------------------------------------
do
  reset()
  local function withCaps(caps)
    local inst, backend = fresh({ capabilities = { keyboard = true, quickkey = caps, char = true }, routing = { default = "quickkey" } })
    inst:openSession({ id = "t" }, 0)
    return inst, backend
  end
  local inst, backend = withCaps({ tap = true, hold = false, chord = false })
  local x, err = inst:press("s", 1, { key = "NUM5" })
  check("tap-only adapter: a standalone hold is refused before dispatch", x == nil and err.code == "unsupported" and err.reason == "capability" and J(err.missing) == J({ "hold" }) and #backend.events == 0, J(err))
  x, err = inst:combo("s", 1, { { key = "NUM5" }, { key = "NUM1" } }, { holdMs = 50 })
  check("tap-only adapter: a chord tap is refused (chord missing), nothing dispatched", x == nil and err.code == "unsupported" and err.key == 1 and J(err.missing) == J({ "chord" }) and #backend.events == 0, J(err))
  x, err = inst:combo("s", 1, { { key = "NUM5" }, { key = "NUM1" } })
  check("tap-only adapter: a combo hold is refused (hold and chord missing)", x == nil and J(err.missing) == J({ "hold", "chord" }) and #backend.events == 0, J(err))
  local q; q, err = inst:startSequence("s", 2, { { kind = "tap", key = "NUM5" }, { kind = "press", key = "NUM1" } })
  check("tap-only adapter: a sequence with a press step is refused in preflight, nothing dispatched", q == nil and err.code == "unsupported" and err.step == 2 and #backend.events == 0, J(err))
  q, err = inst:startSequence("s", 2, { { kind = "tap", key = "NUM5" }, { kind = "combo", keys = { { key = "NUM1" }, { key = "STORE" } }, holdMs = 50 } })
  check("tap-only adapter: a chord-tap step is refused in preflight (chord), nothing dispatched", q == nil and err.step == 2 and J(err.missing) == J({ "chord" }) and #backend.events == 0, J(err))
  local t = inst:tap("s", 3, { key = "NUM5" }, 50)
  check("tap-only adapter: a tap is accepted", t and t.quickkey == "NUM5" and #backend.events == 1, J(t))
  x, err = inst:tap("s", 3, { key = "NUM1" }, 50)
  check("tap-only adapter: a second tap while one Quickey is still down needs chord", x == nil and J(err.missing) == J({ "chord" }) and #backend.events == 1, J(err))
  inst:service(3.1)
  t = inst:tap("s", 4, { key = "NUM1" }, 50)
  check("...and is accepted once the first tap released", t and #backend.events == 3, J(t))
  inst:service(4.1)
  inst, backend = withCaps({ tap = false, hold = false, chord = false })
  x, err = inst:tap("s", 1, { key = "NUM5" }, 50)
  check("all flags false: a tap is refused", x == nil and err.code == "unsupported" and J(err.missing) == J({ "tap" }) and #backend.events == 0, J(err))
  x, err = inst:press("s", 1, { key = "NUM5" })
  check("all flags false: a hold is refused", x == nil and J(err.missing) == J({ "hold" }) and #backend.events == 0, J(err))
  inst, backend = withCaps({ tap = false, hold = true, chord = false })
  x, err = inst:tap("s", 1, { key = "NUM5" }, 50)
  check("hold-only adapter: a tap is refused", x == nil and J(err.missing) == J({ "tap" }) and #backend.events == 0, J(err))
  local q2; q2, err = inst:startSequence("s", 0.5, { { kind = "press", key = "NUM5" }, { kind = "press", key = "NUM1" } })
  check("hold-only adapter: a second press while the first step's Quickey is still held is refused in preflight (chord)", q2 == nil and err.step == 2 and J(err.missing) == J({ "chord" }) and #backend.events == 0, J(err))
  q2, err = inst:startSequence("s", 0.5, { { kind = "press", key = "NUM5" }, { kind = "release", key = "NUM5" }, { kind = "press", key = "NUM1" }, { kind = "release", key = "NUM1" } })
  check("hold-only adapter: press/release pairs in sequence need no chord", q2 ~= nil, J(err))
  for i = 1, 8 do inst:service(0.5 + i * 0.1) end
  check("...and the sequence completed", inst:sequenceStatus(q2.id, 2).state == "completed" and #backend.events == 4, J(inst:sequenceStatus(q2.id, 2)))
  local h = inst:press("s", 1, { key = "NUM5" })
  check("hold-only adapter: a hold is accepted", h and h.quickkey == "NUM5", J(h))
  x, err = inst:press("s", 2, { key = "NUM1" })
  check("hold-only adapter: a second hold next to a held Quickey needs chord", x == nil and J(err.missing) == J({ "chord" }) and #backend.events == 5, J(err))
  local dup = inst:press("s", 2, { key = "NUM5" })
  check("a duplicate press of the held tuple is still the duplicate report, not a chord refusal", dup and dup.duplicate == true and dup.id == h.id and #backend.events == 5, J(dup))
  local kb, kerr = inst:press("s", 2, { pcKey = "F3" })
  check("a PC-key press next to a held Quickey is refused as an unqualified mix (KB-15), not as a Quickey chord", kb == nil and kerr.code == "unqualified-mix" and kerr.reason == "held" and kerr.heldKind == "quickkey" and kerr.hold == h.id and #backend.events == 5, J(kerr))
  inst:releaseAll("s", 3)
  check("describeRoute reports the flags", inst:describeRoute("NUM5").quickkeyCapabilities.chord == false)
end

-------------------------------------------------------------------------------
-- Quickey aliases: ownership is the validated code value, the requested name is reported
-------------------------------------------------------------------------------
do
  reset()
  local inst, backend = fresh({ routing = { default = "quickkey" } })
  inst:openSession({ id = "t" }, 0)
  local h = inst:press("s", 1, { key = "OOPS" })
  check("OOPS held by code value", h and h.quickkey == "OOPS" and h.quickkeyCode == 86 and h.tupleKey == "quickkey:#86" and #backend.events == 1, J(h))
  local dup = inst:press("s", 2, { key = "UNDO" })
  check("UNDO (same code) is the duplicate of the OOPS hold: no second record, no second dispatch", dup and dup.duplicate == true and dup.id == h.id and dup.quickkey == "OOPS" and #backend.events == 1, J(dup))
  local x, err = inst:tap("s", 2, { key = "UNDO" }, 50)
  check("a tap of the alias cannot layer on the hold", x == nil and err.code == "conflict" and #backend.events == 1, J(err))
  x, err = inst:press("t", 2, { key = "UNDO" })
  check("another session's alias press is an ownership conflict", x == nil and err.code == "conflict" and err.owner == "s" and #backend.events == 1, J(err))
  x, err = inst:combo("s", 2, { { key = "NUM5" }, { key = "UNDO" } })
  check("a combo naming the held alias is refused", x == nil and err.code == "conflict" and #backend.events == 1, J(err))
  local rel = inst:release("s", 3, { key = "UNDO" })
  check("release by the alias name releases the OOPS hold through its stored tuple", rel.state == "released" and rel.id == h.id and lastEvent(backend).kind == "release" and lastEvent(backend).quickkey == "OOPS" and lastEvent(backend).quickkeyCode == 86, J(rel))
  x, err = inst:combo("s", 4, { { key = "OOPS" }, { key = "UNDO" } }, { holdMs = 50 })
  check("a combo of two aliases is one tuple twice: refused before dispatch", x == nil and err.code == "bad-argument" and err.message:find("twice") and #backend.events == 2, J(err))
  local q; q, err = inst:startSequence("s", 5, { { kind = "combo", keys = { { key = "OOPS" }, { key = "UNDO" } }, holdMs = 50 } })
  check("the same combo inside a sequence is refused in preflight", q == nil and err.step == 1 and #backend.events == 2, J(err))
  -- Recovery consistency: a failed release keyed by the code is recovered through the same tuple.
  h = inst:press("s", 6, { key = "UNDO" })
  backend:failNext("release", qk("OOPS"), "wedged")
  rel = inst:release("s", 7, { key = "OOPS" })
  check("a failed release of the alias hold is unresolved under the code identity", rel.state == "unresolved" and rel.tupleKey == "quickkey:#86" and rel.quickkey == "UNDO", J(rel))
  x, err = inst:press("s", 8, { key = "OOPS" })
  check("while unresolved, the code stays owned under either name", x == nil and err.code == "conflict" and err.state == "unresolved", J(err))
  local rec = inst:recover("s", 9)
  check("recovery releases it with the stored tuple", #rec.released == 1 and lastEvent(backend).quickkey == "UNDO" and lastEvent(backend).quickkeyCode == 86 and not backend:isDown(qk("OOPS")), J(rec))
  -- Mixed backends: a Quickey tuple and a PC key never share identity (and are never down at once, KB-15).
  h = inst:press("s", 10, { key = "NUM5" })
  local kb, kerr = inst:press("s", 10, { pcKey = "5" })
  check("PC key 5 next to Quickey NUM5 is refused as an unqualified mix", kb == nil and kerr.code == "unqualified-mix" and kerr.heldKind == "quickkey", J(kerr))
  inst:releaseAll("s", 11)
  kb = inst:press("s", 12, { pcKey = "5" })
  check("Quickey NUM5 and PC key 5 are distinct tuples", h and kb and h.tupleKey ~= kb.tupleKey, J({ h.tupleKey, kb and kb.tupleKey }))
  inst:releaseAll("s", 13)
end

-------------------------------------------------------------------------------
-- type: resolvable and reported, never configurable against a current backend (KB-14)
-------------------------------------------------------------------------------
do
  reset()
  local inst = fresh({ disabled = true, routing = { keys = { NUM5 = { method = "type", text = "5" }, THRU = { method = "type", text = "Thru " }, STORE = { method = "type" } } } })
  local d = inst:describeRoute("THRU")
  check("type resolves to the text route with the exact text and a mode change (shortcuts off) while shortcuts are on", d.supported and d.effective == "text" and d.text == "Thru " and d.modeChange and d.modeChange.target == false and has(d.unavailable, "no backend attached") and not d.dispatchable, J(d))
  profile.shortcutsActive = false
  d = inst:describeRoute("THRU")
  check("with shortcuts off no mode change is needed; only the backend is missing", d.effective == "text" and d.modeChange == nil and d.shortcutsActive == false and #d.unavailable == 1 and has(d.unavailable, "no backend attached"), J(d))
  d = inst:describeRoute("STORE")
  check("type without a text mapping is unsupported, not derived from the name", not d.supported and d.code == "no-mapping", J(d))
  d = inst:describeRoute("WHATEVER")
  check("type for an unknown key is unsupported", not d.supported and d.code == "unknown-key", J(d))
  profile.shortcutsActive = nil
  d = inst:describeRoute("THRU")
  check("unreadable mode is a refusal for type", not d.supported and d.code == "unreadable", J(d))
  reset()
  local r, err = inst:enableInput(HK.fakeBackend())
  check("a policy naming type cannot enable input without the mode-write dep (deps.setShortcutsActive)", r == nil and err.code == "policy-unavailable" and err.problems[1].method == "type" and has(err.problems[1].missing, "KB-14") and has(err.problems[1].missing, "setShortcutsActive"), J(err))
  local inst2 = fresh()
  r, err = inst2:configureRouting({ default = "type" })
  check("type as the default is refused while a backend is attached", r == nil and err.code == "policy-unavailable", J(err))
  local inst3 = fresh({ disabled = true })
  r = inst3:configureRouting({ default = "type" })
  check("type is accepted provisionally without a backend (validation happens again at enableInput)", r and r.default == "type" and r.methods.type.available == false, J(r))
  r, err = inst3:enableInput(HK.fakeBackend())
  check("...and refused there", r == nil and err.code == "policy-unavailable", J(err))
end

-------------------------------------------------------------------------------
-- shortcutOrType: every selection branch
-------------------------------------------------------------------------------
do
  reset()
  local inst, backend = fresh({ routing = { default = "shortcutOrType", keys = { NUM5 = { text = "5" }, THRU = { text = "Thru " }, PLUS = { text = "+" }, EDIT = { text = "Edit " } } } })
  -- active + resolves -> shortcut
  local h = inst:press("s", 1, { key = "NUM5" })
  check("shortcuts active and a row resolves: shortcut-table route dispatched", h and h.pcKey == "5" and h.route.source == "shortcut-table" and h.method == "shortcutOrType" and h.route.routing.text == "5", J(h))
  inst:release("s", 2, { hold = h.id })
  -- active + confirmed missing row + text -> text selected, unavailable (both KB-14 requirements), nothing dispatched
  local n = #backend.events
  local x, err = inst:press("s", 3, { key = "THRU" })
  check("active, no row, text mapping: text selected, needs a mode change this harness cannot write: unavailable, nothing dispatched", x == nil and err.code == "unavailable" and err.effective == "text" and has(err.unavailable, "enable/disable") and not has(err.unavailable, "text-route") and err.route.modeChange.target == false and #backend.events == n and err.route.textSelectedBecause:find("no row"), J(err))
  -- active + confirmed missing row + no text -> unsupported
  VK.GROUP = 58
  x, err = inst:press("s", 3, { key = "GROUP" })
  check("active, no row, no text: unsupported", x == nil and err.code == "unsupported" and err.reason == "no-mapping", J(err))
  -- active + ambiguous -> refusal, not text, even with a text mapping
  x, err = inst:press("s", 4, { key = "PLUS" })
  check("ambiguity refuses rather than typing", x == nil and err.code == "unsupported" and err.reason == "ambiguous" and err.message:find("not a fall%-through"), J(err))
  -- active + collision -> refusal
  x, err = inst:press("s", 4, { key = "EDIT" })
  check("a collision refuses rather than typing", x == nil and err.code == "unsupported" and err.reason == "collision", J(err))
  -- unreadable mode -> refusal
  profile.shortcutsActive = nil
  x, err = inst:press("s", 5, { key = "NUM5" })
  check("unreadable mode refuses rather than typing", x == nil and err.code == "unsupported" and err.reason == "unreadable", J(err))
  -- mode positively off + text -> text selected (no row needed), unavailable (text route only)
  profile.shortcutsActive = false
  x, err = inst:press("s", 6, { key = "THRU" })
  check("mode off with a text mapping selects text without a row and inserts it once (KB-14): no mode change, released at once, nothing held", x and x.kind == "text" and x.state == "released" and x.route.source == "text" and x.text.typed == 5 and x.text.outcome == "typed" and x.releaseOutcome == "none" and x.modeOp == nil and backend:typedText() == "Thru " and #backend.events == n + 5, J(x or err))
  x, err = inst:press("s", 6, { key = "PLUS" })
  check("mode off: an ambiguous table is irrelevant to the text route", x and x.kind == "text" and backend:typedText() == "Thru +", J(x or err))
  -- mode off + no text -> unsupported
  x, err = inst:press("s", 6, { key = "STORE" })
  check("mode off without a text mapping is unsupported", x == nil and err.code == "unsupported" and err.reason == "no-mapping", J(err))
  -- fixed/native keys do not depend on the mode
  h = inst:press("s", 7, { key = "PLEASE" })
  check("PLEASE uses its native route under shortcutOrType with shortcuts off", h and h.route.source == "native" and h.method == "shortcutOrType", J(h))
  inst:release("s", 8, { hold = h.id })
  h = inst:press("s", 7, { key = "MA" })
  check("MA uses its fixed route under shortcutOrType", h and h.route.source == "fixed", J(h))
  inst:release("s", 8, { hold = h.id })
  -- unknown key is always a refusal
  x, err = inst:press("s", 9, { key = "NOPE" })
  check("unknown key refused under shortcutOrType", x == nil and err.reason == "unknown-key", J(err))
  check("describeRoute agrees with press for the text branch", inst:describeRoute("THRU").effective == "text" and inst:describeRoute("THRU").dispatchable == true)
  reset()
  -- Retention across a mode change: a shortcut-table hold pressed under shortcutOrType keeps the
  -- keyboard route; turning shortcuts off mid-hold does not turn it into text (the release is the
  -- pre-0.6.0 unresolved outcome, recovered when the operator restores the mode).
  backend:setConfirmMode(nil)  -- like Keyboard(): a release is dispatched, never observed per key
  h = inst:press("s", 10, { key = "NUM5" })
  profile.shortcutsActive = false
  local rel = inst:release("s", 11, { hold = h.id })
  check("mode change mid-hold: the stored keyboard route is used and the release stays unresolved; no text route is substituted", rel.state == "unresolved" and rel.route.source == "shortcut-table" and rel.routeMismatch.reason:find("inactive") and lastEvent(backend).pcKey == "5", J(rel))
  profile.shortcutsActive = true
  local rec = inst:recover("s", 12)
  check("restored mode recovers it", #rec.released == 1, J(rec))
end

-------------------------------------------------------------------------------
-- Admission failures stay refusals; a blocked press is not resurrected
-------------------------------------------------------------------------------
do
  reset()
  local inst, backend = fresh({ routing = { default = "quickkey", keys = { THRU = { method = "shortcutOrType", text = "Thru " } } }, config = { requireInteraction = true } })
  inst:openSession({ id = "t" }, 0)
  local x, err = inst:press("s", 1, { key = "NUM5" })
  check("a standalone Quickey hold still needs an interaction", x == nil and err.code == "interaction-required", J(err))
  local ia = inst:beginInteraction("s", 1, {})
  local h = inst:press("s", 1, { key = "NUM5", interaction = ia.id })
  check("held within an interaction", h and h.quickkey == "NUM5", J(h))
  x, err = inst:tap("t", 2, { key = "NUM1" }, 50)
  check("another session is busy regardless of method", x == nil and err.code == "busy", J(err))
  x, err = inst:press("s", 2, { key = "NUM5", interaction = ia.id, exclusive = true })
  check("exclusive on a held tuple refused as before", x == nil and err.code == "exclusive-refused", J(err))
  inst:release("s", 3, { hold = h.id }); inst:endInteraction("s", ia.id, 3)
  -- A blocked press stays blocked: changing the mode afterwards dispatches nothing by itself, and a
  -- fresh call is a fresh decision (not a replay of the refused one).
  profile.shortcutsActive = true
  profile.rows = {}
  local n = #backend.events
  x, err = inst:tap("s", 4, { key = "THRU" }, 50)
  check("THRU under shortcutOrType with no row and shortcuts on is refused (text route unavailable)", x == nil and err.code == "unavailable", J(err))
  profile.rows = defaultRows()
  profile.rows[#profile.rows + 1] = { shortcut = "T", keyCode = 78 }
  for i = 1, 5 do inst:service(4 + i * 0.1) end
  local live = 0
  for _, hh in ipairs(inst:status(5).holds) do if hh.state ~= "released" then live = live + 1 end end
  check("a later mode/table change does not dispatch the refused press", #backend.events == n and live == 0, J(inst:status(5).holds))
  local t = inst:tap("s", 6, { key = "THRU" }, 50)
  check("a new call is a new decision: now the shortcut row dispatches", t and t.pcKey == "T" and t.route.source == "shortcut-table" and #backend.events == n + 1, J(t))
  inst:service(6.1)
  inst:disableInput(7)
  x, err = inst:press("s", 8, { key = "NUM5" })
  check("input disabled refuses every method", x == nil and err.code == "input-disabled", J(err))
  reset()
end

print(string.format("%d passed, %d failed", passes, failures))
print(failures == 0 and "ALL PASSED" or "FAILED")
os.exit(failures == 0 and 0 or 1)
