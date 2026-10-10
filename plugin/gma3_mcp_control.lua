-- gma3_mcp_control.lua
--
-- Continuous-control transport and admission for grandMA3 onPC plugins (KB-18).
--
-- What this file is:
--   A ComponentLua of a UserPlugin, loaded exactly like gma3_mcp_hardkeys.lua and gma3_mcp_feedback.lua
--   (the KB-02 loading contract): the chunk only builds and returns a module table, touches no console
--   API, creates no socket, timer or show object and applies nothing when it is loaded or when an
--   instance is created. Consumers ship it as a ComponentLua of their own plugin (docs/modules.md).
--
-- What this version provides (MODULE API 1, module version 0.1.0, KB-18):
--   * distinct EVENTS for relative motion ("relative": a signed delta in detents), absolute position
--     ("absolute": a value in 0..1 of the control's travel), touch begin/end ("touch") and button
--     down/up ("button"). Every event names its device, control, per-device event sequence, the
--     BINDING GENERATION it was produced against (gma3_mcp_feedback 0.3.0 contextSnapshot().generation)
--     and the TARGET it means: { slot = n } (an encoder slot of the bound display) or
--     { executor = n, element = "fader" | "key" | "encoder" }. Motion and touches carry a gesture id.
--   * owned sessions with leases (openSession / renewSession / closeSession), bound by the consumer to
--     whatever identifies its clients (the bridge binds them to TCP connections). An event for an
--     expired or unknown session is refused; a session that expires has its gestures ended and its
--     queued motion dropped, never applied late.
--   * ADMISSION before anything is queued: a motion or position event whose generation is not the
--     binding's current generation is refused ("stale-generation", the current one is reported);
--     while the binding claims no generation nothing is admitted ("binding-unknown"); a target the
--     binding reports unavailable, unsupported, mixed-unsupported, empty, not a playback target or
--     without the requested element is refused with the binding's reason. Queued motion is re-checked
--     against the binding when it is applied and dropped if the generation moved in between: a queued
--     delta is never reinterpreted against a newly selected attribute or executor.
--   * per-device event sequence: strictly increasing per (session, device). A repeated sequence number
--     is a duplicate (refused, nothing applied twice); an older one is out of order (refused, never
--     applied late); a gap is PACKET LOSS, accepted and reported (result.lost, counters) - the
--     consumer's transport decides whether to retransmit; this module never replays an uncertain delta.
--   * COALESCING of relative deltas only within one session, target, generation, resolution, fine flag
--     and gesture, and only until a boundary: a touch or button event of the same session, a generation
--     change, or a different target in between. Absolute positions supersede an older queued position
--     of the same target only when the bound function permits it (attribute slots and stateless fader
--     functions do; crossfade, temp and the other STATEFUL fader functions never do, so no endpoint
--     transition is skipped); where they do not, the queue holds every position in order.
--   * bounds: queue length per session (maxQueue; a motion event beyond it is refused "queue-full"
--     while a touch end or button release always gets in, evicting the session's oldest motion),
--     event age (motion older than maxEventAgeMs when it is applied is dropped "expired"), per-device
--     rate (maxEventsPerSecond for motion and position; releases are never rate-refused), work per
--     service() (maxWorkPerService intents applied), gesture duration (maxGestureMs: a touch or button
--     down beyond it is force-ended) and simultaneous holds (maxHolds).
--   * SERIALISATION: a target with an active gesture (touch or button down, or motion within
--     gestureIdleMs) belongs to that session; another session's event for it is refused "conflict"
--     with the owner. admission(now) reports the instance BUSY while any gesture is active so the
--     consumer refuses conflicting mutations (commands, property changes, faders, arbitrary Lua) from
--     every other writer; deps.busy(sessionId, now) lets the consumer refuse motion while another
--     owner (the hardkeys module's interactions and holds) is active.
--   * a BACKEND adapter applies intents: apply(intent, now) returns true (applied), or nil, err
--     (refused: the intent is dropped and reported) or raises (UNRESOLVED: whether the console changed
--     is unknown; a release that raises is kept as a record until recover() or dispose()). This
--     version ships fakeBackend() only (records intents, applies nothing on the console); the console
--     adjustment backend is KB-19.
--   * service(now): lease and gesture expiries first, then at most maxWorkPerService queued intents in
--     order. status(now) is read-only.
--
-- Rules every consumer must keep (as for the other modules):
--   * One instance per consumer; the module table is read-only; nothing is published through
--     package.loaded or globals. Dependencies come through opts.deps: deps.binding(now) returns the
--     current binding snapshot (a gma3_mcp_feedback contextSnapshot() table, cached or live) and
--     deps.busy(sessionId, now) may return another owner's busy descriptor.
--   * Input is disabled on a new instance. enableInput(adapter) is the operator's explicit decision.

local NAME        = "gma3_mcp_control"
local VERSION     = "0.1.0"
local API_VERSION = 1

local EVENT_TYPES = { relative = true, absolute = true, touch = true, button = true }
local ELEMENTS    = { fader = true, key = true, encoder = true }

-- Fader functions whose value path matters: an older position must never be skipped for a newer one
-- (crossfades change which cue is active on the way; Temp starts the playback when it leaves 0).
-- Matched on the configured fader function token (feedback's level.token / functions.fader) without
-- the "Fader" prefix, case-insensitively.
local STATEFUL_FUNCTIONS = { x = true, xa = true, xb = true, crossfade = true, crossfadea = true, crossfadeb = true, temp = true }

local DEFAULT_CONFIG = {
  defaultLeaseMs     = 15000,
  maxLeaseMs         = 120000,
  maxQueue           = 64,     -- queued intents per session
  maxEventAgeMs      = 250,    -- motion older than this when applied is dropped
  maxEventsPerSecond = 400,    -- per device; motion and position only
  maxWorkPerService  = 4,      -- intents applied per service()
  maxGestureMs       = 30000,  -- a touch or button down longer than this is force-ended
  gestureIdleMs      = 500,    -- a relative gesture without touch keeps its target this long after its last event
  maxHolds           = 16,     -- touches and buttons down per instance
  eventLog           = 64,
  seqWindow          = 64,     -- per device: sequence numbers behind the newest that are remembered as seen
  maxDelta           = 4096,   -- |delta| of one relative event (detents)
  requireBindingRevision = true, -- motion and downs must carry `binding`; a consumer whose spec never changes sets false
}

local function shallowCopy(t) local o = {} for k, v in pairs(t or {}) do o[k] = v end return o end
local function fail(code, message, extra)
  local e = { code = code, message = message }
  if extra then for k, v in pairs(extra) do e[k] = v end end
  return nil, e
end
local function errOf(...) return (select(2, fail(...))) end
local function isInt(v) return type(v) == "number" and v == math.floor(v) end
local function ms(seconds) return math.floor(seconds * 1000 + 0.5) end

-------------------------------------------------------------------------------
-- Fake backend: records every intent, applies nothing. Tests stage refusals and raises.
-------------------------------------------------------------------------------
local FakeBackend = {}
FakeBackend.__index = FakeBackend

local function fakeBackend(opts)
  opts = opts or {}
  return setmetatable({
    name = "fake", description = "records intents; applies nothing on the console",
    capabilities = { relative = true, absolute = true, touch = true, button = true },
    intents = {}, log = tonumber(opts.eventLog) or DEFAULT_CONFIG.eventLog,
    failures = {},   -- kind -> error text for the next apply of that kind (one-shot)
    raises = {},     -- kind -> error text raised by the next apply of that kind (one-shot)
    counters = { relative = 0, absolute = 0, touch = 0, button = 0 },
  }, FakeBackend)
end

function FakeBackend:apply(intent, now)
  local kind = intent.kind
  local raise = self.raises[kind]
  if raise ~= nil then self.raises[kind] = nil; error(raise, 0) end
  local failure = self.failures[kind]
  if failure ~= nil then self.failures[kind] = nil; return nil, { code = "backend-refused", message = failure } end
  self.counters[kind] = (self.counters[kind] or 0) + 1
  local rec = shallowCopy(intent)
  rec.appliedAt = now
  self.intents[#self.intents + 1] = rec
  while #self.intents > self.log do table.remove(self.intents, 1) end
  return true, { recorded = true }
end

function FakeBackend:failNext(kind, text) self.failures[kind] = text or "staged refusal" end
function FakeBackend:raiseNext(kind, text) self.raises[kind] = text or "staged raise" end
function FakeBackend:last() return self.intents[#self.intents] end

-------------------------------------------------------------------------------
-- Instance
-------------------------------------------------------------------------------
local Instance = {}
Instance.__index = Instance

local function checkLive(self)
  if self._state == "disposed" then error(NAME .. ": instance is disposed", 3) end
end
local function checkReady(self)
  checkLive(self)
  if self._state ~= "ready" then error(NAME .. ": call init() first", 3) end
end
local function checkNow(now)
  if type(now) ~= "number" then error(NAME .. ": now (seconds, number) is required", 3) end
end

function Instance:init()
  checkLive(self)
  if self._state == "ready" then return self end
  self._state = "ready"
  return self
end

function Instance:attachBackend(adapter)
  checkReady(self)
  if type(adapter) ~= "table" or type(adapter.apply) ~= "function" or type(adapter.name) ~= "string" then
    error(NAME .. ".attachBackend: adapter with name and apply(intent, now) required", 2)
  end
  self._adapter = adapter
  return self
end

function Instance:enableInput(adapter)
  checkReady(self)
  if adapter ~= nil then self:attachBackend(adapter) end
  if self._adapter == nil then error(NAME .. ".enableInput: attach a backend first", 2) end
  self._inputEnabled = true
  return self
end

function Instance:disableInput(now, reason)
  checkReady(self); checkNow(now)
  self._inputEnabled = false
  local out = { ended = {}, dropped = 0, unresolved = {} }
  for id, s in pairs(self._sessions) do
    if s.state == "active" then self:_endSessionWork(s, now, reason or "input-disabled", out) end
    local _ = id
  end
  return out
end

function Instance:backendAvailable() return self._adapter ~= nil end

local function logEvent(self, rec)
  self._events[#self._events + 1] = rec
  while #self._events > self._config.eventLog do table.remove(self._events, 1) end
end

-------------------------------------------------------------------------------
-- Sessions
-------------------------------------------------------------------------------
function Instance:openSession(opts, now)
  checkReady(self); checkNow(now)
  opts = opts or {}
  if type(opts.id) ~= "string" or opts.id == "" then return fail("bad-args", "session id (non-empty string) is required") end
  local existing = self._sessions[opts.id]
  if existing and existing.state == "active" then
    if existing.expiresAt > now then return fail("session-exists", "session '" .. opts.id .. "' is open") end
    self:_expireSession(existing, now)
  end
  local leaseMs = opts.leaseMs or self._config.defaultLeaseMs
  if not isInt(leaseMs) or leaseMs <= 0 or leaseMs > self._config.maxLeaseMs then
    return fail("bad-args", string.format("leaseMs must be an integer in 1..%d", self._config.maxLeaseMs))
  end
  local s = { id = opts.id, label = opts.label, binding = opts.binding, state = "active", leaseMs = leaseMs,
              openedAt = now, expiresAt = now + leaseMs / 1000, renewals = 0,
              queue = {}, devices = {}, gestures = {}, counters = { admitted = 0, refused = 0, applied = 0, dropped = 0, lost = 0, coalesced = 0, evicted = 0 } }
  self._sessions[opts.id] = s
  return self:_sessionView(s, now)
end

function Instance:_sessionView(s, now)
  return { id = s.id, label = s.label, binding = s.binding, state = s.state, leaseMs = s.leaseMs, openedAt = s.openedAt,
           expiresAt = s.expiresAt, remainingMs = math.max(0, ms(s.expiresAt - now)), renewals = s.renewals,
           queued = #s.queue, gestures = self:_gestureCount(s), counters = shallowCopy(s.counters) }
end

function Instance:renewSession(id, now, leaseMs)
  checkReady(self); checkNow(now)
  local s = self._sessions[id]
  if not s or s.state ~= "active" then return fail("no-session", "no open session '" .. tostring(id) .. "'") end
  if s.expiresAt <= now then self:_expireSession(s, now); s.state = "active" end
  leaseMs = leaseMs or s.leaseMs
  if not isInt(leaseMs) or leaseMs <= 0 or leaseMs > self._config.maxLeaseMs then
    return fail("bad-args", string.format("leaseMs must be an integer in 1..%d", self._config.maxLeaseMs))
  end
  s.leaseMs, s.expiresAt, s.renewals = leaseMs, now + leaseMs / 1000, s.renewals + 1
  return self:_sessionView(s, now)
end

function Instance:closeSession(id, now, reason)
  checkReady(self); checkNow(now)
  local s = self._sessions[id]
  if not s or s.state ~= "active" then return fail("no-session", "no open session '" .. tostring(id) .. "'") end
  local out = { ended = {}, dropped = 0, unresolved = {} }
  self:_endSessionWork(s, now, reason or "closed", out)
  s.state = "closed"
  self._sessions[id] = nil
  out.session = id
  return out
end

-- Ends every gesture of a session through the backend and drops its queue. Nothing queued is applied.
function Instance:_endSessionWork(s, now, reason, out)
  out.dropped = out.dropped + #s.queue
  s.counters.dropped = s.counters.dropped + #s.queue
  self._counters.dropped = self._counters.dropped + #s.queue
  s.queue = {}
  local keys = {}
  for key in pairs(s.gestures) do keys[#keys + 1] = key end
  table.sort(keys)
  for _, key in ipairs(keys) do
    local g = s.gestures[key]
    if g.kind == "touch" or g.kind == "button" then
      local r = self:_applyNow(s, { kind = g.kind, down = false, target = g.target, targetKey = g.targetKey, generation = g.generation, device = g.device, control = g.control,
                                    gesture = g.gesture, forced = true, reason = reason, session = s.id, at = now }, now)
      if r.unresolved then out.unresolved[#out.unresolved + 1] = r.unresolved end
      out.ended[#out.ended + 1] = { kind = g.kind, device = g.device, control = g.control, target = g.target, reason = reason, outcome = r.outcome }
    else
      out.ended[#out.ended + 1] = { kind = g.kind, device = g.device, control = g.control, target = g.target, reason = reason, outcome = "idle" }
    end
    s.gestures[key] = nil
  end
end

function Instance:_expireSession(s, now)
  local out = { ended = {}, dropped = 0, unresolved = {} }
  self:_endSessionWork(s, now, "lease-expired", out)
  s.state = "expired"
  self._sessions[s.id] = nil
  self._expired[#self._expired + 1] = { id = s.id, at = now, ended = out.ended, dropped = out.dropped, unresolved = out.unresolved }
  return out
end

function Instance:_gestureCount(s)
  local n = 0
  for _ in pairs(s.gestures) do n = n + 1 end
  return n
end

-------------------------------------------------------------------------------
-- Binding and target resolution
-------------------------------------------------------------------------------
local function fnToken(token)
  if type(token) ~= "string" then return nil end
  return (token:gsub("^[Ff]ader", "")):lower()
end

-- Resolves an event target against the binding snapshot. Returns a target record or nil, err.
local function resolveTarget(snap, target)
  if type(target) ~= "table" then return fail("bad-event", "target must be { slot = n } or { executor = n, element = ... }") end
  if target.slot ~= nil then
    if not isInt(target.slot) or target.slot < 1 then return fail("bad-event", "target.slot must be a positive integer") end
    local s = snap.slots
    if not (s and s.available) then return fail("target-unavailable", "encoder slots are unavailable: " .. tostring(s and (s.reason or s.error) or "not in the binding"), { target = target }) end
    local sl
    for _, rec in ipairs(s.value.slots or {}) do if rec.slot == target.slot then sl = rec end end
    if not sl then return fail("target-unavailable", string.format("slot %d is not on the bound page (%d slots)", target.slot, #(s.value.slots or {})), { target = target }) end
    if sl.kind == "empty" then return fail("target-unavailable", string.format("slot %d is empty", target.slot), { target = target }) end
    if sl.kind ~= "attribute" or sl.unsupported then return fail("unsupported", string.format("slot %d holds %s (%s), not a qualified attribute", target.slot, tostring(sl.ref), tostring(sl.kind)), { target = target }) end
    if sl.availability == "no-selection" then return fail("target-unavailable", string.format("slot %d (%s): no fixture is selected", target.slot, tostring(sl.name)), { target = target, availability = sl.availability }) end
    if sl.availability ~= "available" and sl.availability ~= "mixed" then
      return fail("target-unavailable", string.format("slot %d (%s) is %s for the selection", target.slot, tostring(sl.name), tostring(sl.availability)), { target = target, availability = sl.availability })
    end
    if sl.resolution == nil then return fail("target-unavailable", string.format("slot %d (%s) has no readable resolution", target.slot, tostring(sl.name)), { target = target }) end
    return { kind = "slot", slot = target.slot, ref = sl.ref, name = sl.name, layer = sl.layer, resolution = sl.resolution, readout = sl.readout,
             channelFunction = sl.channelFunction, availability = sl.availability, mixed = sl.availability == "mixed" or nil,
             key = string.format("slot%d|%s|%s|%s", target.slot, tostring(sl.ref), tostring(sl.layer), tostring(sl.resolution)), supersedes = true }
  elseif target.executor ~= nil then
    if not isInt(target.executor) or target.executor < 1 then return fail("bad-event", "target.executor must be a positive integer") end
    if not ELEMENTS[target.element] then return fail("bad-event", "target.element must be fader, key or encoder") end
    local x
    for _, o in ipairs(snap.executors or {}) do
      local n = o.available and o.value and o.value.executor or (o.params and o.params.executor)
      if n == target.executor then x = o end
    end
    if not x then return fail("target-unavailable", string.format("executor %d is not in the binding (bind it first)", target.executor), { target = target }) end
    if not x.available then return fail("target-unavailable", string.format("executor %d is unavailable: %s", target.executor, tostring(x.reason or x.error)), { target = target }) end
    local v = x.value
    if v.empty then return fail("target-unavailable", string.format("executor %d is empty", target.executor), { target = target }) end
    if v.playbackTarget == false then return fail("target-unavailable", string.format("executor %d is not a playback target (%s)", target.executor, tostring(v.reason or (v.reserved and "reserved by an owned Quickey bank") or "Quickey object")), { target = target }) end
    local f = v.functions or {}
    local fn
    if target.element == "fader" then fn = f.fader elseif target.element == "key" then fn = f.keyPress else fn = f.encoder end
    if fn == nil then return fail("target-unavailable", string.format("executor %d has no %s function", target.executor, target.element), { target = target }) end
    local tok = fnToken(target.element == "fader" and (v.level and v.level.token or fn) or fn)
    return { kind = "executor", executor = target.executor, element = target.element, page = v.page, assigned = v.assigned and (v.assigned.addr or v.assigned.name),
             ["function"] = fn, token = tok, stateful = STATEFUL_FUNCTIONS[tok or ""] == true or nil,
             key = string.format("exec%d.%s|%s|%s", target.executor, target.element, tostring(v.assigned and (v.assigned.addr or v.assigned.name)), tostring(fn)),
             supersedes = not STATEFUL_FUNCTIONS[tok or ""] }
  end
  return fail("bad-event", "target must name a slot or an executor")
end

function Instance:_binding(now)
  local b = self._deps.binding
  if type(b) ~= "function" then return nil, errOf("binding-unknown", "no binding source (deps.binding)") end
  local ok, snap = pcall(b, now)
  if not ok then return nil, errOf("binding-unknown", "the binding source raised: " .. tostring(snap)) end
  if type(snap) ~= "table" then return nil, errOf("binding-unknown", "no binding snapshot yet (bind a display and executors first)") end
  if snap.generation == nil then
    return nil, errOf("binding-unknown", "the binding claims no generation: " .. tostring(snap.generationNote or "unknown"), { lastGeneration = snap.lastGeneration })
  end
  if snap.stale == true then
    return nil, errOf("binding-unknown", "the binding is built from stale observations (its generation may lag the console); wait for the loop to observe it again", { generation = snap.generation, stale = true })
  end
  -- Binding identity (review): generations are per spec, so a different spec can carry the same number.
  -- A changed key is a new binding revision: queued motion is dropped and every hold is rebound.
  if snap.bindingKey ~= nil and snap.bindingKey ~= self._bindingKey then
    if self._bindingKey ~= nil then self:_rebindAll(now, "binding changed from " .. tostring(self._bindingKey) .. " to " .. tostring(snap.bindingKey)) end
    self._bindingKey = snap.bindingKey
    self._bindingRevision = self._bindingRevision + 1
  end
  snap.bindingRevision = self._bindingRevision
  return snap
end

-- Drops every queued intent and marks every hold rebound: nothing produced against the previous binding
-- may act on the new one.
function Instance:_rebindAll(now, why)
  for _, s in pairs(self._sessions) do
    -- Queued releases end holds against their captured targets and are kept; only motion is dropped.
    local keep, n = {}, 0
    for _, it in ipairs(s.queue) do
      if (it.kind == "touch" or it.kind == "button") and it.down == false then keep[#keep + 1] = it else n = n + 1 end
    end
    if n > 0 then
      s.queue = keep
      s.counters.dropped = s.counters.dropped + n; self._counters.dropped = self._counters.dropped + n; self._counters.staleDropped = self._counters.staleDropped + n
    end
    for _, g in pairs(s.gestures) do if g.kind == "touch" or g.kind == "button" then g.rebound = true end end
  end
  logEvent(self, { at = now, rebind = why, revision = self._bindingRevision + 1 })
end

-- The current binding revision and generation (what events must carry).
function Instance:bindingInfo(now)
  checkReady(self); checkNow(now)
  local snap, err = self:_binding(now)
  if not snap then return { revision = self._bindingRevision, key = self._bindingKey, unknown = err } end
  return { revision = snap.bindingRevision, key = snap.bindingKey, generation = snap.generation }
end

-------------------------------------------------------------------------------
-- Admission
-------------------------------------------------------------------------------
function Instance:_admit(sessionId, now)
  if not self._inputEnabled then return fail("input-disabled", "continuous input is disabled on this instance") end
  if self._adapter == nil then return fail("no-backend", "no backend adapter") end
  local s = self._sessions[sessionId]
  if not s or s.state ~= "active" then return fail("no-session", "no open session '" .. tostring(sessionId) .. "'") end
  if s.expiresAt <= now then
    self:_expireSession(s, now)
    return fail("lease-expired", "the lease of session '" .. tostring(sessionId) .. "' expired; open a new session")
  end
  return s
end

local function validateEvent(self, ev)
  if type(ev) ~= "table" then return fail("bad-event", "event must be a table") end
  if not EVENT_TYPES[ev.type] then return fail("bad-event", "event.type must be relative, absolute, touch or button") end
  if type(ev.device) ~= "string" or ev.device == "" then return fail("bad-event", "event.device (non-empty string) is required") end
  if type(ev.control) ~= "string" or ev.control == "" then return fail("bad-event", "event.control (non-empty string) is required") end
  if not isInt(ev.seq) or ev.seq < 1 then return fail("bad-event", "event.seq must be a positive integer (per device)") end
  if ev.type == "relative" then
    if not isInt(ev.delta) or ev.delta == 0 or math.abs(ev.delta) > self._config.maxDelta then return fail("bad-event", string.format("event.delta must be a non-zero integer within +-%d", self._config.maxDelta)) end
  elseif ev.type == "absolute" then
    if type(ev.value) ~= "number" or ev.value < 0 or ev.value > 1 then return fail("bad-event", "event.value must be a number in 0..1") end
  else
    if type(ev.down) ~= "boolean" then return fail("bad-event", "event.down (boolean) is required for touch and button") end
  end
  if ev.gesture ~= nil and not (isInt(ev.gesture) and ev.gesture >= 0) and type(ev.gesture) ~= "string" then return fail("bad-event", "event.gesture must be an integer or string id") end
  if ev.fine ~= nil and type(ev.fine) ~= "boolean" then return fail("bad-event", "event.fine must be a boolean") end
  if ev.generation ~= nil and not isInt(ev.generation) then return fail("bad-event", "event.generation must be an integer") end
  if ev.binding ~= nil and not isInt(ev.binding) then return fail("bad-event", "event.binding must be an integer (the binding revision)") end
  return true
end

-- Per-device ordering: duplicate / out-of-order / gap (loss). Returns lost count or nil, err.
-- `release` is the hold a touch end / button release would end (nil when none): a delayed release that is
-- newer than the hold's own press is admitted even after another control advanced the device sequence
-- (it ends an existing hold, never a newer one); it does not move the device's newest sequence.
local function orderEvent(self, s, ev, release)
  local d = s.devices[ev.device]
  if not d then d = { last = 0, seen = {}, times = {}, lost = 0, duplicates = 0, reordered = 0, late = 0 }; s.devices[ev.device] = d end
  if ev.seq <= d.last then
    if d.seen[ev.seq] then d.duplicates = d.duplicates + 1; return fail("duplicate", string.format("event %d of device %s was already admitted", ev.seq, ev.device), { seq = ev.seq, last = d.last }) end
    -- A delayed release is validated against the hold it ends, not the motion history: the hold still
    -- existing proves its release was not processed, and `seq > downSeq` protects a newer hold. The
    -- window does not bound it.
    if release and release.downSeq and ev.seq > release.downSeq then
      d.late = d.late + 1
      return 0, d, true
    end
    if ev.seq > d.last - self._config.seqWindow then
      d.reordered = d.reordered + 1
      return fail("out-of-order", string.format("event %d of device %s arrived after event %d; it is not applied late", ev.seq, ev.device, d.last), { seq = ev.seq, last = d.last })
    end
    d.duplicates = d.duplicates + 1
    return fail("duplicate", string.format("event %d of device %s is behind the remembered window (newest %d)", ev.seq, ev.device, d.last), { seq = ev.seq, last = d.last })
  end
  local lost = ev.seq - d.last - 1
  if d.last == 0 then lost = 0 end  -- a device's first event sets the origin
  return lost, d
end

local function commitOrder(self, d, ev, lost, late)
  if late then
    -- Counted as lost when the gap was seen; it arrived after all.
    d.seen[ev.seq] = true
    if d.lost > 0 then d.lost = d.lost - 1 end
    return
  end
  d.last = ev.seq
  d.seen[ev.seq] = true
  d.seen[ev.seq - self._config.seqWindow] = nil
  d.lost = d.lost + lost
end

local function rateExceeded(self, d, now)
  local t = d.times
  local cutoff = now - 1
  while #t > 0 and t[1] <= cutoff do table.remove(t, 1) end
  if #t >= self._config.maxEventsPerSecond then return true end
  t[#t + 1] = now
  return false
end

local function gestureKey(ev) return ev.device .. "/" .. ev.control end

-- Who owns a target right now (a touch/button down, or a relative gesture within gestureIdleMs).
function Instance:_targetOwner(targetKey, now, exceptSession)
  for id, s in pairs(self._sessions) do
    if s.state == "active" and id ~= exceptSession then
      for _, g in pairs(s.gestures) do
        if g.targetKey == targetKey then
          if g.kind == "touch" or g.kind == "button" then return id, g end
          if g.lastAt + self._config.gestureIdleMs / 1000 > now then return id, g end
        end
      end
    end
  end
  return nil
end

function Instance:_holdCount()
  local n = 0
  for _, s in pairs(self._sessions) do
    for _, g in pairs(s.gestures) do if g.kind == "touch" or g.kind == "button" then n = n + 1 end end
  end
  return n
end

-- submit(sessionId, now, event): admits one event; see the header for the rules.
function Instance:submit(sessionId, now, ev)
  checkReady(self); checkNow(now)
  local s, err = self:_admit(sessionId, now)
  if not s then self._counters.refused = self._counters.refused + 1; return nil, err end
  local okV, verr = validateEvent(self, ev)
  if not okV then s.counters.refused = s.counters.refused + 1; self._counters.refused = self._counters.refused + 1; return nil, verr end
  local release = (ev.type == "touch" or ev.type == "button") and ev.down == false
  local heldFor = release and s.gestures[gestureKey(ev)] or nil
  if heldFor and heldFor.kind ~= ev.type then heldFor = nil end
  local lost, d, late = orderEvent(self, s, ev, heldFor)
  if lost == nil then
    s.counters.refused = s.counters.refused + 1; self._counters.refused = self._counters.refused + 1
    logEvent(self, { at = now, session = sessionId, type = ev.type, device = ev.device, control = ev.control, seq = ev.seq, refused = d.code })
    return nil, d
  end
  local motion = ev.type == "relative" or ev.type == "absolute"
  local function refuse(e)
    s.counters.refused = s.counters.refused + 1; self._counters.refused = self._counters.refused + 1
    logEvent(self, { at = now, session = sessionId, type = ev.type, device = ev.device, control = ev.control, seq = ev.seq, refused = e.code })
    return nil, e
  end
  if motion and rateExceeded(self, d, now) then
    commitOrder(self, d, ev, lost, late)  -- the event was seen; it is dropped, not deferred
    d.rateDropped = (d.rateDropped or 0) + 1
    self._counters.rateDropped = self._counters.rateDropped + 1
    return refuse(errOf("rate", string.format("device %s exceeded %d events/s; the event is dropped, not deferred", ev.device, self._config.maxEventsPerSecond)))
  end
  local gkey = gestureKey(ev)
  local existing = s.gestures[gkey]
  if release then
    -- A touch end or button release only needs the hold it ends. It is admitted without a binding,
    -- never rate-limited, and the queue keeps room for it (maxQueue + maxHolds, evicting the session's
    -- oldest motion first): releases stay responsive during a flood. The hold stays owned until the
    -- release is queued, so a refused release leaves the target reserved for its retransmission.
    if not existing or existing.kind ~= ev.type then
      commitOrder(self, d, ev, lost, late)
      s.counters.admitted = s.counters.admitted + 1
      logEvent(self, { at = now, session = sessionId, type = ev.type, device = ev.device, control = ev.control, seq = ev.seq, noop = true })
      return { accepted = true, noop = true, lost = lost, note = "no " .. ev.type .. " of that control is down for this session" }
    end
    local intent = { kind = ev.type, down = false, target = existing.target, targetKey = existing.targetKey, generation = existing.generation, device = ev.device, control = ev.control,
                     gesture = existing.gesture, seq = ev.seq, session = sessionId, at = now, rebound = existing.rebound }
    local queued, qerr = self:_enqueue(s, intent, true)
    if not queued then return refuse(qerr) end
    commitOrder(self, d, ev, lost, late)
    s.gestures[gkey] = nil
    s.counters.admitted = s.counters.admitted + 1; s.counters.lost = s.counters.lost + lost; self._counters.admitted = self._counters.admitted + 1; self._counters.lost = self._counters.lost + lost
    logEvent(self, { at = now, session = sessionId, type = ev.type, device = ev.device, control = ev.control, seq = ev.seq, admitted = true })
    return { accepted = true, queued = queued.position, evicted = queued.evicted, lost = lost, late = late or nil, boundary = true }
  end
  -- Everything else needs the binding and a resolvable target.
  local snap, berr = self:_binding(now)
  if not snap then return refuse(berr) end
  if ev.binding ~= nil and ev.binding ~= snap.bindingRevision then
    return refuse(errOf("stale-binding", string.format("event binding revision %s is not the current revision %d (the binding was replaced); rebind before sending more", tostring(ev.binding), snap.bindingRevision),
                        { binding = snap.bindingRevision, generation = snap.generation }))
  end
  if ev.generation ~= snap.generation then
    return refuse(errOf("stale-generation", string.format("event generation %s is not the binding's current generation %d; rebind before sending more", tostring(ev.generation), snap.generation),
                                 { generation = snap.generation, eventGeneration = ev.generation }))
  end
  local target, terr = resolveTarget(snap, ev.target)
  if not target then return refuse(terr) end
  if ev.binding == nil and self._config.requireBindingRevision then
    return refuse(errOf("binding-required", string.format("the event carries no binding revision; this consumer's binding can be replaced, so motion and downs must carry binding = %d (bindingInfo())", snap.bindingRevision),
                        { binding = snap.bindingRevision, generation = snap.generation }))
  end
  if existing and existing.kind == "touch" and ev.type ~= "touch" and ev.type ~= "button" and (existing.rebound or existing.generation ~= snap.generation) then
    existing.rebound = true
    return refuse(errOf("gesture-rebound", "the binding changed while this touch was down; release and touch again to control the new target", { target = ev.target, heldGeneration = existing.generation, generation = snap.generation }))
  end
  local busyDep = self._deps.busy
  if type(busyDep) == "function" then
    local okB, busy = pcall(busyDep, sessionId, now)
    if okB and type(busy) == "table" and busy.owner ~= sessionId then
      return refuse(errOf("busy", "another input owner is active: " .. tostring(busy.description or busy.reason), { reason = busy.reason, owner = busy.owner }))
    end
  end
  local owner, og = self:_targetOwner(target.key, now, sessionId)
  if owner then
    return refuse(errOf("conflict", string.format("%s is being operated by session %s (%s on %s/%s)", target.key, owner, og.kind, og.device, og.control), { owner = owner, target = ev.target }))
  end
  local intent = { kind = ev.type, target = ev.target, targetKey = target.key, resolved = target, generation = snap.generation, binding = snap.bindingRevision, device = ev.device, control = ev.control,
                   gesture = ev.gesture, seq = ev.seq, session = sessionId, at = now, firstAt = now, fine = ev.fine or nil }
  if ev.type == "relative" then
    intent.delta, intent.events, intent.lost, intent.resolution = ev.delta, 1, lost, target.resolution
  elseif ev.type == "absolute" then
    intent.value, intent.lost, intent.supersedes = ev.value, lost, target.supersedes
  else
    intent.down = true
    if self:_holdCount() >= self._config.maxHolds then
      return refuse(errOf("capacity", string.format("%d touches/buttons are down (maxHolds)", self._config.maxHolds)))
    end
  end
  commitOrder(self, d, ev, lost, late)
  -- Gesture records: a touch or button down owns its target until the release; motion refreshes an
  -- idle gesture record so the target stays this session's for gestureIdleMs.
  if ev.type == "touch" or ev.type == "button" then
    s.gestures[gkey] = { kind = ev.type, device = ev.device, control = ev.control, target = ev.target, targetKey = target.key, generation = snap.generation,
                         gesture = ev.gesture, since = now, lastAt = now, downSeq = ev.seq }
  else
    local g = s.gestures[gkey]
    if g and (g.kind == "touch" or g.kind == "button") then
      g.lastAt = now
    else
      s.gestures[gkey] = { kind = "motion", device = ev.device, control = ev.control, target = ev.target, targetKey = target.key, generation = snap.generation,
                           gesture = ev.gesture, since = g and g.since or now, lastAt = now }
    end
  end
  local queued, qerr = self:_enqueue(s, intent, false)
  if not queued then
    if ev.type == "touch" or ev.type == "button" then s.gestures[gkey] = nil end
    return refuse(qerr)
  end
  s.counters.admitted = s.counters.admitted + 1; s.counters.lost = s.counters.lost + lost
  self._counters.admitted = self._counters.admitted + 1; self._counters.lost = self._counters.lost + lost
  if queued.coalesced then s.counters.coalesced = s.counters.coalesced + 1; self._counters.coalesced = self._counters.coalesced + 1 end
  logEvent(self, { at = now, session = sessionId, type = ev.type, device = ev.device, control = ev.control, seq = ev.seq, admitted = true, coalesced = queued.coalesced or nil, target = target.key })
  return { accepted = true, queued = queued.position, coalesced = queued.coalesced or nil, superseded = queued.superseded or nil, lost = lost, target = target.key,
           generation = snap.generation, mixed = target.mixed, stateful = target.stateful }
end

-- Queue discipline. Relative deltas merge into the queue's tail when nothing but motion of the same
-- key was queued since; absolute positions replace a queued position of the same key when the target
-- permits; boundaries always get in (evicting the oldest motion of the session when full).
function Instance:_enqueue(s, intent, boundary)
  local q = s.queue
  if intent.kind == "relative" then
    local tail = q[#q]
    if tail and tail.kind == "relative" and tail.session == intent.session and tail.device == intent.device and tail.control == intent.control
       and tail.targetKey == intent.targetKey and tail.generation == intent.generation
       and tail.resolution == intent.resolution and tail.fine == intent.fine and tail.gesture == intent.gesture then
      tail.delta = tail.delta + intent.delta
      tail.events = tail.events + 1
      tail.lost = tail.lost + intent.lost
      tail.at, tail.seq = intent.at, intent.seq
      return { position = #q, coalesced = true }
    end
  elseif intent.kind == "absolute" and intent.supersedes then
    for i = #q, 1, -1 do
      local e = q[i]
      if e.kind == "absolute" and e.session == intent.session and e.device == intent.device and e.control == intent.control and e.targetKey == intent.targetKey and e.generation == intent.generation then
        e.value, e.at, e.seq, e.lost, e.gesture = intent.value, intent.at, intent.seq, e.lost + intent.lost, intent.gesture
        e.superseded = (e.superseded or 0) + 1
        return { position = i, superseded = e.superseded }
      end
      if e.kind == "touch" or e.kind == "button" then break end  -- never across a boundary
    end
  end
  local evicted = 0
  if #q >= self._config.maxQueue then
    if not boundary then return fail("queue-full", string.format("%d intents are queued for this session (maxQueue); the event is dropped, not deferred", self._config.maxQueue), { queued = #q }) end
    for i = 1, #q do
      if q[i].kind == "relative" or q[i].kind == "absolute" then table.remove(q, i); evicted = 1; break end
    end
    if evicted == 0 and #q >= self._config.maxQueue + self._config.maxHolds then
      -- Reserved release capacity (one per possible hold) exhausted too: refuse, the hold stays owned.
      return fail("queue-full", "the queue holds only boundaries and the release reserve is used; the release is refused, the hold stays owned for its retransmission", { queued = #q })
    end
    if evicted > 0 then s.counters.evicted = s.counters.evicted + evicted; self._counters.evicted = self._counters.evicted + evicted end
  end
  self._intentSeq = self._intentSeq + 1
  intent.id = "c" .. self._intentSeq
  q[#q + 1] = intent
  return { position = #q, evicted = evicted > 0 and evicted or nil }
end

-------------------------------------------------------------------------------
-- Applying
-------------------------------------------------------------------------------
-- Applies one intent through the backend. Returns { outcome = applied | refused | unresolved, ... }.
function Instance:_applyNow(s, intent, now)
  local adapter = self._adapter
  if adapter == nil then
    local rec = { kind = intent.kind, session = s.id, device = intent.device, control = intent.control, target = intent.target, error = "no backend", at = now }
    self._unresolved[#self._unresolved + 1] = rec
    return { outcome = "unresolved", unresolved = rec }
  end
  local ok, res, err = pcall(adapter.apply, adapter, intent, now)
  if not ok then
    self._counters.unresolved = self._counters.unresolved + 1
    local rec = { kind = intent.kind, session = s.id, device = intent.device, control = intent.control, target = intent.target, generation = intent.generation,
                  down = intent.down, error = tostring(res), at = now, backend = adapter.name }
    if (intent.kind == "touch" or intent.kind == "button") and not intent.recovering then self._unresolved[#self._unresolved + 1] = rec end
    self._lastApplied = { outcome = "unresolved", kind = intent.kind, at = now, error = tostring(res) }
    return { outcome = "unresolved", unresolved = rec }
  end
  if not res then
    self._counters.backendRefused = self._counters.backendRefused + 1
    self._lastApplied = { outcome = "refused", kind = intent.kind, at = now, error = err }
    return { outcome = "refused", error = err }
  end
  s.counters.applied = s.counters.applied + 1
  self._counters.applied = self._counters.applied + 1
  self._lastApplied = { outcome = "applied", kind = intent.kind, at = now, target = intent.targetKey, delta = intent.delta, value = intent.value, down = intent.down, result = err }
  return { outcome = "applied", result = err }
end

function Instance:service(now)
  checkReady(self); checkNow(now)
  self._serviced = self._serviced + 1
  self._lastServiced = now
  local out = { applied = 0, dropped = { expired = 0, staleGeneration = 0, refused = 0 }, unresolved = {}, expired = {}, ended = {}, work = 0, pending = 0 }
  -- 1. Lease expiries: gestures ended, queues dropped.
  local ids = {}
  for id in pairs(self._sessions) do ids[#ids + 1] = id end
  table.sort(ids)
  for _, id in ipairs(ids) do
    local s = self._sessions[id]
    if s.state == "active" and s.expiresAt <= now then
      local r = self:_expireSession(s, now)
      out.expired[#out.expired + 1] = id
      for _, u in ipairs(r.unresolved) do out.unresolved[#out.unresolved + 1] = u end
      for _, e in ipairs(r.ended) do out.ended[#out.ended + 1] = e end
    end
  end
  -- 2. Gesture bounds: a touch or button down beyond maxGestureMs is force-ended; idle motion gestures lapse.
  for _, id in ipairs(ids) do
    local s = self._sessions[id]
    if s then
      for key, g in pairs(s.gestures) do
        if (g.kind == "touch" or g.kind == "button") and now - g.since > self._config.maxGestureMs / 1000 then
          local r = self:_applyNow(s, { kind = g.kind, down = false, target = g.target, targetKey = g.targetKey, generation = g.generation, device = g.device, control = g.control,
                                        gesture = g.gesture, forced = true, reason = "max-gesture", session = id, at = now }, now)
          if r.unresolved then out.unresolved[#out.unresolved + 1] = r.unresolved end
          out.ended[#out.ended + 1] = { kind = g.kind, device = g.device, control = g.control, target = g.target, reason = "max-gesture", outcome = r.outcome }
          s.gestures[key] = nil
        elseif g.kind == "motion" and g.lastAt + self._config.gestureIdleMs / 1000 <= now then
          s.gestures[key] = nil
        end
      end
    end
  end
  -- 3. Apply queued intents in order, bounded. Motion is re-checked against the binding and age.
  local snap
  local budget = self._config.maxWorkPerService
  for _, id in ipairs(ids) do
    local s = self._sessions[id]
    while s and #s.queue > 0 and budget > 0 do
      local intent = table.remove(s.queue, 1)
      budget = budget - 1
      out.work = out.work + 1
      if intent.kind == "relative" or intent.kind == "absolute" then
        if snap == nil then snap = self:_binding(now) or false end
        if (now - intent.firstAt) * 1000 > self._config.maxEventAgeMs then
          out.dropped.expired = out.dropped.expired + 1; s.counters.dropped = s.counters.dropped + 1; self._counters.dropped = self._counters.dropped + 1
          self._counters.expired = self._counters.expired + 1
        elseif not snap or snap.generation ~= intent.generation or snap.bindingRevision ~= intent.binding then
          out.dropped.staleGeneration = out.dropped.staleGeneration + 1; s.counters.dropped = s.counters.dropped + 1; self._counters.dropped = self._counters.dropped + 1
          self._counters.staleDropped = self._counters.staleDropped + 1
          -- The gesture that produced it is rebound: a touch that stays down must be lifted before
          -- it controls the new target.
          local g = s.gestures[intent.device .. "/" .. intent.control]
          if g then g.rebound = true end
        else
          local r = self:_applyNow(s, intent, now)
          if r.outcome == "applied" then out.applied = out.applied + 1
          elseif r.outcome == "refused" then out.dropped.refused = out.dropped.refused + 1; s.counters.dropped = s.counters.dropped + 1
          elseif r.unresolved then out.unresolved[#out.unresolved + 1] = r.unresolved end
        end
      else
        local r = self:_applyNow(s, intent, now)
        if r.outcome == "applied" then out.applied = out.applied + 1
        elseif r.outcome == "refused" then out.dropped.refused = out.dropped.refused + 1
        elseif r.unresolved then out.unresolved[#out.unresolved + 1] = r.unresolved end
        if intent.down and snap ~= nil and snap and snap.generation ~= intent.generation then
          local g = s.gestures[intent.device .. "/" .. intent.control]
          if g then g.rebound = true end
        end
      end
    end
  end
  for _, s in pairs(self._sessions) do out.pending = out.pending + #s.queue end
  return out
end

-- Re-attempts unresolved releases (a touch end or button release the backend raised on).
function Instance:recover(now)
  checkReady(self); checkNow(now)
  local out = { resolved = {}, unresolved = {} }
  -- A detached batch: a failure during this pass is retained once (below), never retried in the same pass.
  local batch = self._unresolved
  self._unresolved = {}
  local keep = {}
  for _, rec in ipairs(batch) do
    local s = { id = rec.session, counters = { applied = 0 } }
    local r = self:_applyNow(s, { kind = rec.kind, down = false, target = rec.target, generation = rec.generation, device = rec.device, control = rec.control, forced = true, reason = "recover", recovering = true, session = rec.session, at = now }, now)
    if r.outcome == "applied" then out.resolved[#out.resolved + 1] = rec
    else rec.attempts = (rec.attempts or 1) + 1; rec.error = r.unresolved and r.unresolved.error or (r.error and r.error.message) or rec.error; keep[#keep + 1] = rec; out.unresolved[#out.unresolved + 1] = rec end
  end
  for _, rec in ipairs(self._unresolved) do keep[#keep + 1] = rec end  -- anything added meanwhile (none expected)
  self._unresolved = keep
  return out
end

-- Adopts unresolved records handed back by a previous instance's dispose().
function Instance:adopt(records, now)
  checkReady(self); checkNow(now)
  local n = 0
  for _, rec in ipairs(records or {}) do
    if type(rec) == "table" and (rec.kind == "touch" or rec.kind == "button") then
      rec.adoptedAt = now
      self._unresolved[#self._unresolved + 1] = rec
      n = n + 1
    end
  end
  return { adopted = n }
end

-------------------------------------------------------------------------------
-- Admission descriptor, status, dispose
-------------------------------------------------------------------------------
-- The busy descriptor consumers use to refuse conflicting writers: any gesture down, any queued
-- intent or motion within gestureIdleMs.
function Instance:admission(now)
  checkReady(self); checkNow(now)
  local ids = {}
  for id in pairs(self._sessions) do ids[#ids + 1] = id end
  table.sort(ids)
  for _, id in ipairs(ids) do
    local s = self._sessions[id]
    if s.state == "active" and s.expiresAt > now then
      for _, g in pairs(s.gestures) do
        if g.kind == "touch" or g.kind == "button" then
          return { code = "busy", reason = g.kind .. "-down", owner = id, device = g.device, control = g.control, target = g.target,
                   description = string.format("%s is down on %s/%s of session %s", g.kind, g.device, g.control, id) }
        end
        if g.lastAt + self._config.gestureIdleMs / 1000 > now then
          return { code = "busy", reason = "motion", owner = id, device = g.device, control = g.control, target = g.target,
                   remainingMs = ms(g.lastAt + self._config.gestureIdleMs / 1000 - now),
                   description = string.format("%s/%s of session %s moved %d ms ago", g.device, g.control, id, ms(now - g.lastAt)) }
        end
      end
      if #s.queue > 0 then
        return { code = "busy", reason = "queued", owner = id, queued = #s.queue, description = string.format("%d intents of session %s are queued", #s.queue, id) }
      end
    end
  end
  return nil
end

function Instance:status(now)
  checkLive(self)
  local sessions = {}
  for id, s in pairs(self._sessions) do
    local v = self:_sessionView(s, now or s.openedAt)
    v.devices = {}
    for dev, d in pairs(s.devices) do v.devices[dev] = { last = d.last, lost = d.lost, duplicates = d.duplicates, reordered = d.reordered, late = d.late or 0, rateDropped = d.rateDropped or 0 } end
    v.gestureList = {}
    for _, g in pairs(s.gestures) do v.gestureList[#v.gestureList + 1] = { kind = g.kind, device = g.device, control = g.control, target = g.target, generation = g.generation, gesture = g.gesture, since = g.since, rebound = g.rebound } end
    table.sort(v.gestureList, function(a, b) return a.device .. a.control < b.device .. b.control end)
    sessions[id] = v
  end
  local events = {}
  for i, e in ipairs(self._events) do events[i] = shallowCopy(e) end
  local unresolved = {}
  for i, u in ipairs(self._unresolved) do unresolved[i] = shallowCopy(u) end
  return { module = NAME, version = VERSION, apiVersion = API_VERSION, owner = self._owner, state = self._state,
           inputEnabled = self._inputEnabled, backend = self._adapter and self._adapter.name or nil,
           capabilities = self._adapter and shallowCopy(self._adapter.capabilities or {}) or nil,
           sessions = sessions, counters = shallowCopy(self._counters), events = events, unresolved = unresolved,
           lastApplied = self._lastApplied and shallowCopy(self._lastApplied) or nil, serviced = self._serviced, lastServiced = self._lastServiced,
           expiredSessions = #self._expired, config = shallowCopy(self._config), binding = { revision = self._bindingRevision, key = self._bindingKey } }
end

function Instance:dispose(now)
  if self._state == "disposed" then return { ended = {}, dropped = 0, unresolved = {}, records = {}, alreadyDisposed = true } end
  now = now or self._lastServiced or 0  -- a consumer disposing without a clock still gets every gesture ended
  checkNow(now)
  local out = { ended = {}, dropped = 0, unresolved = {} }
  if self._state == "ready" then
    local ids = {}
    for id in pairs(self._sessions) do ids[#ids + 1] = id end
    table.sort(ids)
    for _, id in ipairs(ids) do
      local s = self._sessions[id]
      self:_endSessionWork(s, now, "dispose", out)
      self._sessions[id] = nil
    end
  end
  for _, u in ipairs(self._unresolved) do out.unresolved[#out.unresolved + 1] = u end
  self._unresolved = {}
  self._state = "disposed"
  self._inputEnabled = false
  out.records = out.unresolved
  return out
end

-------------------------------------------------------------------------------
-- Construction
-------------------------------------------------------------------------------
local function new(opts)
  opts = opts or {}
  if type(opts.owner) ~= "string" or opts.owner == "" then error(NAME .. ".new: opts.owner (non-empty string) is required", 2) end
  if opts.deps ~= nil and type(opts.deps) ~= "table" then error(NAME .. ".new: opts.deps must be a table", 2) end
  if opts.config ~= nil and type(opts.config) ~= "table" then error(NAME .. ".new: opts.config must be a table", 2) end
  local config = shallowCopy(DEFAULT_CONFIG)
  for k, v in pairs(opts.config or {}) do
    if DEFAULT_CONFIG[k] == nil then error(NAME .. ".new: unknown config key '" .. tostring(k) .. "'", 2) end
    if type(DEFAULT_CONFIG[k]) == "boolean" then
      if type(v) ~= "boolean" then error(NAME .. ".new: config." .. k .. " must be a boolean", 2) end
    elseif type(v) ~= "number" or v <= 0 then error(NAME .. ".new: config." .. k .. " must be a positive number", 2) end
    config[k] = v
  end
  return setmetatable({
    _owner = opts.owner, _deps = opts.deps or {}, _config = config, _adapter = nil, _inputEnabled = false, _state = "created",
    _sessions = {}, _expired = {}, _events = {}, _unresolved = {}, _intentSeq = 0, _bindingKey = nil, _bindingRevision = 0, _serviced = 0, _lastServiced = nil, _lastApplied = nil,
    _counters = { admitted = 0, refused = 0, applied = 0, dropped = 0, lost = 0, coalesced = 0, evicted = 0, rateDropped = 0, expired = 0, staleDropped = 0, unresolved = 0, backendRefused = 0 },
  }, Instance)
end

-- No console API is needed by this version: the binding and busy sources are injected by the consumer.
local function consoleDeps(_) return {} end

local M = {
  NAME = NAME, VERSION = VERSION, API_VERSION = API_VERSION,
  EVENT_TYPES = { "relative", "absolute", "touch", "button" }, ELEMENTS = { "fader", "key", "encoder" },
  STATEFUL_FUNCTIONS = shallowCopy(STATEFUL_FUNCTIONS),
  new = new, consoleDeps = consoleDeps, fakeBackend = fakeBackend, resolveTarget = resolveTarget,
  backends = { fake = "fake" },
  LIMITATIONS = {
    "KB-18 ships the fake backend only: intents are admitted, ordered, coalesced and bounded, and recorded; nothing moves on the console (the adjustment backend is KB-19)",
    "generations are those of the consumer's binding source (one gma3_mcp_feedback instance and spec); events from a surface bound to another instance are refused as stale",
    "packet loss is reported, never repaired: a lost relative delta is gone, a lost absolute position is superseded by the next one",
  },
  DEFAULT_CONFIG = shallowCopy(DEFAULT_CONFIG),
}

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
