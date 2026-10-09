-- gma3_mcp_hardkeys.lua
--
-- Instance-based console input module for grandMA3 onPC plugins.
--
-- What this file is:
--   A ComponentLua of a UserPlugin. The console runs this chunk once when the plugin is imported or
--   reloaded; the chunk only builds and returns a module table. It touches no console API, creates no
--   socket, timer or show object and sends no input when it is loaded or when an instance is created.
--   Consumers ship it as a ComponentLua of their own plugin (see docs/modules.md): the chunk registers
--   the module in the plugin's signal table, the entry component looks it up and calls new(). The
--   source travels inside the show file; no loose file is needed on the console.
--
-- What this version provides (MODULE API 1, module version 0.2.0, KB-03):
--   * explicit instance lifecycle: new() -> init() -> service(now) ... -> dispose(now)
--   * owned input sessions with leases: openSession / renewSession / closeSession. Every held key
--     belongs to a session; the consumer binds sessions to whatever identifies its clients (the bridge
--     binds them to TCP connections) and never accepts a session id from an untrusted caller.
--   * press / release / tap / releaseAll / recover on a backend adapter. The only adapter that
--     dispatches anything in this version is the FAKE backend (fakeBackend()), which records events
--     and simulates aggregate console key state for tests. The "keyboard" adapter remains capability
--     only until KB-04 proves it; a press on it is refused before anything is dispatched.
--   * stored press tuples: each hold keeps the resolved PC key, modifier flags, display, logical key and
--     the shortcut-table route (shortcut text, row, profile, enablement) it was pressed with. Release
--     always uses that stored tuple. Nothing is ever re-resolved to release a hold.
--   * deadline servicing without sleeps: service(now) releases taps and expired leases, a bounded
--     number of attempts per call, and takes an aggregate console-state snapshot for status().
--   * recovery: a release that fails, or that cannot be confirmed after the route changed, leaves the
--     hold in the "unresolved" state. The record is kept (and still blocks conflicting presses) until
--     a recover() attempt succeeds. dispose() hands unresolved records back so a consumer can keep
--     them across a restart and adopt() them into a new instance.
--   * status(now): read-only. It performs no cleanup and calls nothing on the backend; the observed
--     console state it reports is the snapshot taken by the last service().
--
-- Ownership semantics (KB-01/KB-03 findings): the console's key state is shared. A physical release
-- can end a synthetic hold and MASTATE is aggregate, so an ownership record here means "this session is
-- responsible for releasing this tuple", not "the key is down because of us". The module never
-- re-presses a key because the console no longer reports it down.
--
-- Rules every consumer must keep:
--   * One instance per consumer. Instances never share mutable state; the module table is read-only.
--   * Pass console dependencies through opts.deps (consoleDeps(_G) builds them lazily). The module
--     never reads globals, so it can be exercised under a stock Lua interpreter.
--   * Do not store an instance in a global and do not publish this module through package.loaded or
--     require(): that cache is shared by every plugin in the console and survives re-import.
--   * Input is disabled on a new instance. enableInput(adapter) is the operator's explicit decision.

local NAME        = "gma3_mcp_hardkeys"
local VERSION     = "0.2.0"
local API_VERSION = 1

-- Logical keys accepted by describeKey() and press(). Each resolves through the UserProfile
-- KeyboardShortcut table to the row whose KeyCode equals the named Enums.VirtualKeyCode, except MA,
-- which is the PC LeftShift key itself (KB-01 follow-up F2-F4; verified through Root().MASTATE).
local LOGICAL_KEYS = {
  PLEASE = { vk = "PLEASE" }, STORE = { vk = "STORE" }, ESC = { vk = "ESC" },
  CLEAR  = { vk = "CLEAR" },  OOPS  = { vk = "OOPS" },
  NUM0 = { vk = "NUM0" }, NUM1 = { vk = "NUM1" }, NUM2 = { vk = "NUM2" }, NUM3 = { vk = "NUM3" }, NUM4 = { vk = "NUM4" },
  NUM5 = { vk = "NUM5" }, NUM6 = { vk = "NUM6" }, NUM7 = { vk = "NUM7" }, NUM8 = { vk = "NUM8" }, NUM9 = { vk = "NUM9" },
  EXEC = { vk = "EXEC", needsExecutor = true },
  MA   = { pcKey = "LeftShift", verify = "MASTATE" },
}

local UNSUPPORTED_KEYS = {
  MA1 = "both PC Shift keys feed one MA state, so MA1 and MA2 cannot be distinguished; use MA (KB-01)",
  MA2 = "both PC Shift keys feed one MA state, so MA1 and MA2 cannot be distinguished; use MA (KB-01)",
}

local BACKENDS = {
  keyboard = {
    name = "keyboard",
    description = "Keyboard(): PC-key emulation routed through the operator's UserProfile shortcut table (capability only; dispatch is KB-04)",
    requires = { "Keyboard" },
    dispatches = false,
  },
  fake = {
    name = "fake",
    description = "in-memory fake: records events and simulates aggregate console key state; nothing reaches the console",
    requires = {},
    dispatches = true,
  },
}

-- Defaults for new(); every value can be overridden through opts.config.
local DEFAULT_CONFIG = {
  maxHolds           = 8,       -- held + releasing + unresolved records, instance-wide
  defaultLeaseMs     = 15000,   -- session lease when openSession() gives none
  maxLeaseMs         = 120000,  -- longest lease a session may ask for
  maxHoldMs          = 30000,   -- longest a press may stay held before service() releases it
  maxTapMs           = 5000,    -- longest hold a tap() may ask for
  maxWorkPerService  = 4,       -- release attempts one service() call may make
  eventLog           = 64,      -- fake backend event history length
}

-- Pure helpers ---------------------------------------------------------------

-- "Ctrl+Alt+F1" -> key "F1", ctrl=true, alt=true, shift=false. Modifier names as the console prints them.
local function parseShortcut(text)
  if type(text) ~= "string" or text == "" then return nil, "empty shortcut" end
  local r = { key = nil, shift = false, ctrl = false, alt = false }
  for part in text:gmatch("[^+]+") do
    local p = part
    if p == "Shift" then r.shift = true
    elseif p == "Ctrl" then r.ctrl = true
    elseif p == "Alt" then r.alt = true
    else
      if r.key ~= nil then return nil, "shortcut has more than one key: " .. text end
      r.key = p
    end
  end
  if r.key == nil then return nil, "shortcut has no key: " .. text end
  return r
end

local function modifierCount(r) return (r.shift and 1 or 0) + (r.ctrl and 1 or 0) + (r.alt and 1 or 0) end

-- rows: list of { shortcut = "Ctrl+F1", keyCode = <VirtualKeyCode number>, executorIndex = <number|nil> }
-- vkCodes: VirtualKeyCode name -> number (Enums.VirtualKeyCode on the console)
-- opts: { executor = <number> } for EXEC
local function resolve(rows, vkCodes, name, opts)
  local key = type(name) == "string" and name:upper() or nil
  if not key then return { key = tostring(name), supported = false, reason = "key name must be a string" } end
  if UNSUPPORTED_KEYS[key] then return { key = key, supported = false, reason = UNSUPPORTED_KEYS[key] } end
  local def = LOGICAL_KEYS[key]
  if not def then return { key = key, supported = false, reason = "not a logical key of this module" } end
  if def.pcKey then
    return { key = key, supported = true, backend = "keyboard", pcKey = def.pcKey, shift = false, ctrl = false, alt = false,
             verify = def.verify, source = "fixed", note = "MA is the PC Shift key itself; it does not use the shortcut table" }
  end
  if type(rows) ~= "table" or type(vkCodes) ~= "table" then
    return { key = key, supported = false, reason = "shortcut table or VirtualKeyCode enum unavailable" }
  end
  local vk = vkCodes[def.vk]
  if vk == nil then return { key = key, supported = false, reason = "VirtualKeyCode " .. def.vk .. " unknown on this console" } end
  local executor = opts and opts.executor
  if def.needsExecutor then
    if type(executor) ~= "number" then return { key = key, supported = false, reason = "EXEC needs opts.executor (the ExecutorIndex of a mapped executor shortcut)" } end
  end
  local best, bestParsed, bestIndex
  for i, row in ipairs(rows) do
    if row.keyCode == vk and ((not def.needsExecutor) or row.executorIndex == executor) then
      local parsed = parseShortcut(row.shortcut)
      if parsed and (best == nil or modifierCount(parsed) < modifierCount(bestParsed)) then
        best, bestParsed, bestIndex = row, parsed, i
      end
    end
  end
  if not best then
    local what = def.needsExecutor and ("EXEC with ExecutorIndex " .. tostring(executor)) or key
    return { key = key, supported = false, reason = "no keyboard shortcut maps to " .. what .. " in the current user profile" }
  end
  return { key = key, supported = true, backend = "keyboard", pcKey = bestParsed.key, shift = bestParsed.shift, ctrl = bestParsed.ctrl,
           alt = bestParsed.alt, shortcut = best.shortcut, rowIndex = bestIndex, executor = def.needsExecutor and executor or nil, source = "shortcut-table" }
end

-- The identity of an injected key event on this backend: PC key plus modifier flags. Display index is
-- deliberately not part of it (display_index does not route input on 2.5.1, KB-01), nor is the logical
-- name, so MA and a raw LeftShift, or the same key asked for on two displays, are the same tuple.
local function tupleKey(t)
  return string.format("%s|s%dc%da%dn%d", t.pcKey, t.shift and 1 or 0, t.ctrl and 1 or 0, t.alt and 1 or 0, t.numlock and 1 or 0)
end

local function copyTuple(t)
  return { pcKey = t.pcKey, shift = t.shift and true or false, ctrl = t.ctrl and true or false,
           alt = t.alt and true or false, numlock = t.numlock and true or false, display = t.display }
end

local function shallowCopy(t)
  if type(t) ~= "table" then return t end
  local o = {}
  for k, v in pairs(t) do o[k] = v end
  return o
end

local function count(t) local n = 0; for _ in pairs(t) do n = n + 1 end; return n end

-- Console dependency builder -------------------------------------------------

-- Returns closures over the console API. Nothing is called here; every read happens when a consumer
-- calls describeKey(), press() or backendAvailable(). env defaults to the caller's globals.
local function consoleDeps(env)
  env = env or _G
  return {
    Keyboard = env.Keyboard,
    virtualKeyCodes = function() return env.Enums and env.Enums.VirtualKeyCode end,
    shortcutsActive = function()
      local v = env.CurrentProfile().KeyboardShortCuts:Get("KeyboardShortcutsActive")
      if v == "true" then return true elseif v == "false" then return false end
      return v
    end,
    shortcutRows = function()
      local sc = env.CurrentProfile().KeyboardShortCuts
      local rows = {}
      for i = 1, sc:Count() do
        local r = sc:Ptr(i)
        if r then
          rows[#rows + 1] = {
            shortcut = tostring(r:Get("Shortcut")),
            keyCode = tonumber(r:Get("KeyCode")),
            executorIndex = tonumber(r:Get("ExecutorIndex")),
          }
        end
      end
      return rows
    end,
    -- Identity of the profile a route was resolved in. A profile switch during a hold is a route change.
    profileName = function() return tostring(env.CurrentProfile().name) end,
    -- Display validation only: input is not display-scoped on this console (KB-01).
    displayExists = function(n) return env.GetDisplayByIndex(n) ~= nil end,
  }
end

-- Fake backend ----------------------------------------------------------------

-- An adapter that dispatches nothing to the console. It records every press/release it is asked for,
-- keeps a simulated aggregate "down" set the way the console's MASTATE is aggregate, and offers test
-- controls to make a release fail, to make its outcome unconfirmable, or to simulate a physical
-- operator pressing/releasing the same key. Adapter contract (what KB-04 must implement too):
--   press(tuple)   -> ok(boolean), confirmed(true|false|nil), err(string|nil)
--                     ok=false means the event was refused BEFORE anything was dispatched; an adapter
--                     that cannot tell must raise instead, so the record is kept as unresolved
--   release(tuple) -> ok, confirmed, err         confirmed=nil means "not observable on this backend"
--   observe()      -> { available = boolean, down = { [tupleKey] = true } }   aggregate console state
--   supportsKey(pcKey) -> boolean, reason        optional
local FakeBackend = {}
FakeBackend.__index = FakeBackend

local function fakeBackend(opts)
  opts = opts or {}
  return setmetatable({
    name = "fake", dispatches = true, description = BACKENDS.fake.description,
    events = {}, eventLog = tonumber(opts.eventLog) or DEFAULT_CONFIG.eventLog,
    down = {},                 -- simulated aggregate console key state
    confirmMode = true,        -- what release()/press() report as "confirmed": true | false | nil
    failures = {},             -- "press:<tupleKey>" / "release:<tupleKey>" -> error text (one-shot or sticky)
    validKeys = opts.validKeys, -- optional set of accepted PC key names
    counters = { press = 0, release = 0 },
  }, FakeBackend)
end

function FakeBackend:_log(kind, tuple, extra)
  local e = { kind = kind, pcKey = tuple.pcKey, shift = tuple.shift, ctrl = tuple.ctrl, alt = tuple.alt, numlock = tuple.numlock, display = tuple.display }
  if extra then for k, v in pairs(extra) do e[k] = v end end
  self.events[#self.events + 1] = e
  while #self.events > self.eventLog do table.remove(self.events, 1) end
  return e
end

function FakeBackend:_failure(op, tuple)
  local key = op .. ":" .. tupleKey(tuple)
  local f = self.failures[key]
  if f == nil then return nil end
  if not f.sticky then self.failures[key] = nil end
  return f.err
end

function FakeBackend:press(tuple)
  self.counters.press = self.counters.press + 1
  local err = self:_failure("press", tuple)
  if err then self:_log("press", tuple, { failed = err }); return false, nil, err end
  self.down[tupleKey(tuple)] = true
  self:_log("press", tuple)
  return true, self.confirmMode
end

function FakeBackend:release(tuple)
  self.counters.release = self.counters.release + 1
  local err = self:_failure("release", tuple)
  if err then self:_log("release", tuple, { failed = err }); return false, nil, err end
  self.down[tupleKey(tuple)] = nil
  self:_log("release", tuple)
  return true, self.confirmMode
end

function FakeBackend:observe()
  local down = {}
  for k in pairs(self.down) do down[k] = true end
  return { available = true, down = down }
end

function FakeBackend:supportsKey(pcKey)
  if type(pcKey) ~= "string" or pcKey == "" then return false, "PC key must be a non-empty string" end
  if self.validKeys and not self.validKeys[pcKey] then return false, "PC key '" .. pcKey .. "' is not accepted by the fake backend's key set" end
  return true
end

-- Test controls -------------------------------------------------------------
-- Make the next (or every, with sticky=true) press/release of a tuple fail with err.
function FakeBackend:failNext(op, tuple, err, sticky)
  if op ~= "press" and op ~= "release" then error("fakeBackend:failNext: op must be 'press' or 'release'", 2) end
  self.failures[op .. ":" .. tupleKey(copyTuple(tuple))] = { err = err or (op .. " failed (fake)"), sticky = sticky and true or false }
end
function FakeBackend:clearFailures() self.failures = {} end
-- true: releases/presses report confirmed; false: report not confirmed; nil: not observable.
function FakeBackend:setConfirmMode(mode) self.confirmMode = mode end
-- A physical operator (or another plugin) changes the shared console state behind our back.
function FakeBackend:physicalRelease(tuple) self.down[tupleKey(copyTuple(tuple))] = nil; self:_log("physical-release", copyTuple(tuple)) end
function FakeBackend:physicalPress(tuple) self.down[tupleKey(copyTuple(tuple))] = true; self:_log("physical-press", copyTuple(tuple)) end
function FakeBackend:isDown(tuple) return self.down[tupleKey(copyTuple(tuple))] == true end
function FakeBackend:eventCount(kind)
  local n = 0
  for _, e in ipairs(self.events) do if kind == nil or e.kind == kind then n = n + 1 end end
  return n
end

-- Instances -------------------------------------------------------------------

local Instance = {}
Instance.__index = Instance

local function checkLive(self, what)
  if self._state == "disposed" then error(NAME .. ": " .. what .. " on a disposed instance", 3) end
end

local function checkReady(self, what)
  checkLive(self, what)
  if self._state ~= "ready" then error(NAME .. ": " .. what .. " before init()", 3) end
end

local function checkNow(now, what)
  if type(now) ~= "number" then error(NAME .. ": " .. what .. " needs now (seconds, number)", 3) end
  return now
end

local function fail(code, msg, extra)
  local e = { code = code, message = msg }
  if extra then for k, v in pairs(extra) do e[k] = v end end
  return nil, e
end

function Instance:init()
  checkLive(self, "init")
  if self._state == "created" then self._state = "ready" end
  return self
end

-- Operator decision: attach a dispatching adapter and admit presses. Refused while any ownership
-- record exists, so a backend never changes under a partially dispatched interaction.
function Instance:enableInput(adapter)
  checkReady(self, "enableInput")
  if type(adapter) ~= "table" or type(adapter.press) ~= "function" or type(adapter.release) ~= "function" or type(adapter.name) ~= "string" then
    return fail("bad-adapter", "enableInput needs a backend adapter table with name, press() and release()")
  end
  if not adapter.dispatches then
    return fail("backend-no-dispatch", "backend '" .. adapter.name .. "' has no dispatch in module " .. VERSION .. " (the console keyboard backend is KB-04)")
  end
  if self._adapter ~= nil and self._adapter ~= adapter and self:_liveCount() > 0 then
    return fail("holds-exist", "cannot switch the backend while ownership records exist; release or recover them first", { holds = self:_liveCount() })
  end
  self._adapter = adapter
  self._backend = adapter.name
  self._inputEnabled = true
  return { enabled = true, backend = adapter.name }
end

-- Operator decision: stop admitting presses and attempt to release everything held. Records whose
-- release fails or cannot be confirmed stay as unresolved; the adapter stays attached so recover()
-- and releases remain possible while input is disabled.
function Instance:disableInput(now, reason)
  checkReady(self, "disableInput")
  checkNow(now, "disableInput")
  self._inputEnabled = false
  local result = self:_releaseHolds(self:_heldHolds(), now, reason or "input-disabled")
  result.enabled = false
  return result
end

-- Sessions --------------------------------------------------------------------

-- opts: { id = <string, chosen by the consumer>, leaseMs, label, binding = <opaque, e.g. connection id> }
function Instance:openSession(opts, now)
  checkReady(self, "openSession")
  checkNow(now, "openSession")
  opts = opts or {}
  local id = opts.id
  if type(id) ~= "string" or id == "" then return fail("bad-session", "openSession needs opts.id (non-empty string chosen by the consumer)") end
  local existing = self._sessions[id]
  if existing and existing.state ~= "closed" then return fail("session-exists", "session '" .. id .. "' is already open") end
  if existing and existing.state == "closed" and self:_sessionHoldCount(id) > 0 then
    return fail("session-unresolved", "session '" .. id .. "' still owns unresolved holds; recover them before reusing the id", { unresolved = self:_sessionHoldCount(id) })
  end
  local leaseMs, err = self:_leaseMs(opts.leaseMs)
  if not leaseMs then return nil, err end
  local s = { id = id, label = opts.label, binding = opts.binding, state = "active", leaseMs = leaseMs,
              openedAt = now, expiresAt = now + leaseMs / 1000, renewals = 0 }
  self._sessions[id] = s
  return self:_sessionReport(s, now)
end

-- Renewal only moves the lease deadline. It never injects a press (tested) and is the only way to
-- extend a hold past the lease.
function Instance:renewSession(id, now, leaseMs)
  checkReady(self, "renewSession")
  checkNow(now, "renewSession")
  local s = self._sessions[id]
  if not s or s.state == "closed" then return fail("no-session", "session '" .. tostring(id) .. "' is not open") end
  local ms, err = self:_leaseMs(leaseMs or s.leaseMs)
  if not ms then return nil, err end
  -- A lease that ran out before service() noticed is expired now: its holds keep their cleanup
  -- deadline even though the session continues with the new lease.
  if s.state == "active" and now >= s.expiresAt then self:_expireSession(s, now) end
  s.leaseMs = ms
  s.expiresAt = now + ms / 1000
  s.renewals = s.renewals + 1
  if s.state == "expired" then s.state = "active"; s.expiredAt = nil end
  return self:_sessionReport(s, now)
end

-- Closing attempts to release every hold the session owns (reverse press order) and reports each
-- outcome. Unresolved holds keep the session record (state "closed") until recover() clears them.
function Instance:closeSession(id, now, reason)
  checkReady(self, "closeSession")
  checkNow(now, "closeSession")
  local s = self._sessions[id]
  if not s then return fail("no-session", "session '" .. tostring(id) .. "' does not exist") end
  local result = self:_releaseHolds(self:_sessionHolds(id, true), now, reason or "session-closed")
  s.state = "closed"
  s.closedAt = now
  s.closeReason = reason or "closed"
  if self:_sessionHoldCount(id) == 0 then self._sessions[id] = nil end
  result.session = id
  return result
end

-- Holds -------------------------------------------------------------------------

-- spec: { key = "PLEASE" | pcKey = "Enter", shift, ctrl, alt, numlock, display, executor, maxHoldMs }
-- Returns the hold report, or nil, { code, message, ... }. Nothing is dispatched when an error is returned.
function Instance:press(sessionId, now, spec)
  checkReady(self, "press")
  checkNow(now, "press")
  local s, serr = self:_admit(sessionId, now)
  if not s then return nil, serr end
  local tuple, route, terr = self:_resolveSpec(spec)
  if not tuple then return nil, terr end
  -- A route change during an existing hold stops every new interaction event until it is resolved.
  local mismatch = self:_checkRoutes()
  if mismatch then
    return fail("route-changed", "a held key's route changed since it was pressed; release or recover before new input", { mismatches = mismatch })
  end
  local tk = tupleKey(tuple)
  local existing = self._byTuple[tk]
  if existing then
    if existing.session == sessionId and existing.state == "held" then
      -- Duplicate press by the owner: harmless, nothing is injected.
      return self:_holdReport(existing, now, { duplicate = true })
    end
    return fail("conflict", string.format("tuple %s is already owned by session '%s' (state %s)%s", tk, existing.session, existing.state,
      existing.logical and (" as " .. existing.logical) or ""), { owner = existing.session, hold = existing.id, state = existing.state })
  end
  if self:_liveCount() >= self._config.maxHolds then
    return fail("capacity", "no capacity: " .. self._config.maxHolds .. " ownership records exist (held or unresolved)", { maxHolds = self._config.maxHolds })
  end
  local maxHoldMs = spec.maxHoldMs or self._config.maxHoldMs
  if type(maxHoldMs) ~= "number" or maxHoldMs <= 0 or maxHoldMs > self._config.maxHoldMs then
    return fail("bad-argument", "maxHoldMs must be a number in (0, " .. self._config.maxHoldMs .. "]")
  end
  local hold = self:_newHold(s, tuple, route, now, now + maxHoldMs / 1000, "max-hold")
  local ok, aOk, confirmed, err = pcall(self._adapter.press, self._adapter, copyTuple(tuple))
  if not ok then
    -- The adapter raised: whether the key went down is unknown, so the record is kept as unresolved
    -- (it blocks conflicting presses and recover() will try to release it) rather than dropped.
    hold.dispatch.press = { ok = false, at = now, error = tostring(aOk) }
    self:_markUnresolved(hold, now, "press raised an error; whether the key went down is unknown: " .. tostring(aOk))
    return nil, { code = "press-failed", message = "press raised an error: " .. tostring(aOk), hold = hold.id, unresolved = true }
  end
  if aOk == false then
    -- Refused before dispatch (adapter contract): nothing went down, nothing to own.
    hold.dispatch.press = { ok = false, at = now, error = tostring(err or confirmed) }
    self:_dropHold(hold)
    return nil, { code = "press-failed", message = "press was refused by the backend: " .. tostring(err or confirmed) }
  end
  hold.dispatch.press = { ok = true, confirmed = confirmed, at = now }
  self._pressCount = self._pressCount + 1
  return self:_holdReport(hold, now)
end

-- holdMs bounded by config.maxTapMs; the release is serviced by service(now) at the deadline.
function Instance:tap(sessionId, now, spec, holdMs)
  checkReady(self, "tap")
  checkNow(now, "tap")
  holdMs = holdMs or 50
  if type(holdMs) ~= "number" or holdMs <= 0 or holdMs > self._config.maxTapMs then
    return fail("bad-argument", "holdMs must be a number in (0, " .. self._config.maxTapMs .. "]")
  end
  local report, err = self:press(sessionId, now, spec)
  if not report then return nil, err end
  if report.duplicate then return fail("conflict", "tuple is already held by this session; a tap cannot be layered on a hold", { hold = report.id }) end
  local hold = self._holds[report.id]
  hold.kind = "tap"
  self:_setDeadline(hold, now + holdMs / 1000, "tap")
  return self:_holdReport(hold, now)
end

-- selector: { hold = <id> } or a spec (key / pcKey + modifiers) owned by the session. Releasing an
-- already released hold is harmless and reported as such.
function Instance:release(sessionId, now, selector)
  checkReady(self, "release")
  checkNow(now, "release")
  local s = self._sessions[sessionId]
  if not s then return fail("no-session", "session '" .. tostring(sessionId) .. "' does not exist") end
  local hold, herr = self:_findHold(sessionId, selector)
  if not hold then return nil, herr end
  if hold.state == "released" then return self:_holdReport(hold, now, { alreadyReleased = true }) end
  local r = self:_attemptRelease(hold, now, "client-release")
  return self:_holdReport(hold, now, { attempt = r })
end

-- Owner-scoped: only this session's holds, most recent press first.
function Instance:releaseAll(sessionId, now, reason)
  checkReady(self, "releaseAll")
  checkNow(now, "releaseAll")
  local s = self._sessions[sessionId]
  if not s then return fail("no-session", "session '" .. tostring(sessionId) .. "' does not exist") end
  return self:_releaseHolds(self:_sessionHolds(sessionId, true), now, reason or "release-all")
end

-- Re-attempts the release of unresolved holds with their stored tuples. sessionId=nil covers every
-- session (operator scope); the consumer decides who may call it that way.
function Instance:recover(sessionId, now)
  checkReady(self, "recover")
  checkNow(now, "recover")
  local list = {}
  for _, h in ipairs(self:_orderedHolds()) do
    if h.state == "unresolved" and (sessionId == nil or h.session == sessionId) then list[#list + 1] = h end
  end
  local result = self:_releaseHolds(list, now, "recover")
  result.scope = sessionId or "all"
  return result
end

-- Imports unresolved records handed out by a previous instance's dispose(). They become unresolved
-- holds of a synthetic closed session so recover() can act on them. Nothing is dispatched here.
function Instance:adopt(records, now, sessionId)
  checkReady(self, "adopt")
  checkNow(now, "adopt")
  sessionId = sessionId or "previous-run"
  local adopted, rejected = {}, {}
  for _, rec in ipairs(records or {}) do
    if type(rec) ~= "table" or type(rec.pcKey) ~= "string" or rec.pcKey == "" then
      rejected[#rejected + 1] = { record = rec, reason = "no pcKey" }
    else
      local tuple = copyTuple(rec)
      local tk = tupleKey(tuple)
      if self._byTuple[tk] then
        rejected[#rejected + 1] = { record = rec, reason = "tuple " .. tk .. " already has an ownership record" }
      elseif self:_liveCount() >= self._config.maxHolds then
        rejected[#rejected + 1] = { record = rec, reason = "capacity" }
      else
        local s = self._sessions[sessionId]
        if not s then
          s = { id = sessionId, label = "adopted unresolved records", state = "closed", leaseMs = 0, openedAt = now, closedAt = now, closeReason = "adopted", renewals = 0 }
          self._sessions[sessionId] = s
        end
        local hold = self:_newHold(s, tuple, rec.route, now, nil, nil)
        hold.logical = rec.logical
        hold.pressedAt = rec.pressedAt or now
        hold.dispatch = shallowCopy(rec.dispatch) or hold.dispatch
        hold.adopted = true
        self:_markUnresolved(hold, now, rec.unresolved and rec.unresolved.reason or "adopted from a previous run with an unresolved release")
        adopted[#adopted + 1] = self:_holdReport(hold, now)
      end
    end
  end
  return { adopted = adopted, rejected = rejected }
end

-- Servicing -------------------------------------------------------------------

-- Called once per plugin loop iteration by the consumer. Processes due deadlines (tap releases,
-- max-hold releases, lease expiries) with at most config.maxWorkPerService release attempts, then
-- takes the aggregate console-state snapshot that status() reports. Never sleeps or blocks.
function Instance:service(now)
  checkReady(self, "service")
  checkNow(now, "service")
  self._serviced = self._serviced + 1
  self._lastServiced = now
  local out = { released = {}, unresolved = {}, expired = {}, work = 0, pending = 0 }
  local budget = self._config.maxWorkPerService
  -- Lease expiries: mark the session expired, queue its holds for release.
  for _, s in pairs(self._sessions) do
    if s.state == "active" and now >= s.expiresAt then self:_expireSession(s, now) end
  end
  out.expired, self._pendingExpired = self._pendingExpired, {}
  -- Due hold deadlines, oldest deadline first.
  local due = {}
  for _, h in pairs(self._holds) do
    if h.state == "held" and h.deadline and now >= h.deadline then due[#due + 1] = h end
  end
  table.sort(due, function(a, b) if a.deadline == b.deadline then return a.seq > b.seq end return a.deadline < b.deadline end)
  for _, h in ipairs(due) do
    if out.work >= budget then break end
    out.work = out.work + 1
    local r = self:_attemptRelease(h, now, h.deadlineReason or "deadline")
    if h.state == "released" then out.released[#out.released + 1] = r else out.unresolved[#out.unresolved + 1] = r end
  end
  out.pending = math.max(0, #due - out.work)
  -- Aggregate console state (observed, never ownership). A hold whose tuple the console no longer
  -- reports down is annotated, never re-pressed.
  if self._adapter and type(self._adapter.observe) == "function" then
    local ok, obs = pcall(self._adapter.observe, self._adapter)
    if ok and type(obs) == "table" then
      self._observed = { available = obs.available and true or false, down = obs.down or {}, at = now }
      for _, h in pairs(self._holds) do
        if h.state == "held" and obs.available then
          local down = obs.down and obs.down[h.tupleKey] == true
          h.observed = { down = down, at = now }
          if not down and not h.observedReleasedAt then h.observedReleasedAt = now end
        end
      end
    else
      self._observed = { available = false, error = ok and "observe() returned no table" or tostring(obs), at = now }
    end
  end
  return out
end

-- Read-only. Calls nothing on the backend or console and releases nothing; "observed" is the last
-- service() snapshot. now (optional) is only used to compute remaining lease/hold times.
function Instance:status(now)
  local sessions = {}
  for id, s in pairs(self._sessions) do sessions[id] = self:_sessionReport(s, now) end
  local holds = {}
  local unresolved = 0
  for _, h in ipairs(self:_orderedHolds()) do
    holds[#holds + 1] = self:_holdReport(h, now)
    if h.state == "unresolved" then unresolved = unresolved + 1 end
  end
  local observedDown = {}
  if self._observed and self._observed.down then
    for k in pairs(self._observed.down) do observedDown[#observedDown + 1] = k end
    table.sort(observedDown)
  end
  local avail, missing = true, {}
  if self._state ~= "disposed" then avail, missing = self:backendAvailable() end
  return {
    module = NAME, version = VERSION, apiVersion = API_VERSION,
    owner = self._owner, state = self._state,
    inputEnabled = self._inputEnabled and true or false,
    backend = { name = self._backend, dispatches = (self._adapter and self._adapter.dispatches) and true or false,
                available = avail, missing = missing, description = (BACKENDS[self._backend] or self._adapter or {}).description },
    capacity = { maxHolds = self._config.maxHolds, used = self:_liveCount() },
    config = shallowCopy(self._config),
    sessions = sessions, sessionCount = count(sessions),
    holds = holds, holdCount = #holds, unresolved = unresolved,
    observed = { available = self._observed and self._observed.available or false, down = observedDown, at = self._observed and self._observed.at,
                 error = self._observed and self._observed.error,
                 note = "aggregate console key state from the last service(); it is not ownership and is never used to re-press" },
    counters = { presses = self._pressCount, releaseAttempts = self._releaseAttempts, serviced = self._serviced },
    lastServiced = self._lastServiced,
    note = "status() performs no cleanup; releases happen in service(), release(), releaseAll(), closeSession(), disableInput(), recover() and dispose()",
  }
end

-- Attempts to release every held key (most recent first), then disposes. released/unresolved are
-- this call's release attempts; records are the ownership records that remain unresolved (including
-- ones that were already unresolved), so the consumer can keep them across a restart and adopt()
-- them later. Idempotent.
function Instance:dispose(now)
  if self._state == "disposed" then return { holds = 0, released = {}, unresolved = {}, records = {} } end
  local result = { released = {}, unresolved = {}, attempted = 0 }
  if self._state == "ready" and self._adapter and type(now) == "number" then
    result = self:_releaseHolds(self:_heldHolds(), now, "dispose")
  end
  local records = {}
  for _, h in ipairs(self:_orderedHolds()) do
    if h.state ~= "released" then
      local rec = copyTuple(h)
      rec.logical, rec.route, rec.session, rec.pressedAt, rec.dispatch, rec.id = h.logical, h.route, h.session, h.pressedAt, h.dispatch, h.id
      rec.unresolved = h.unresolved or { reason = "instance disposed without a release attempt (no clock or adapter)", since = now }
      rec.tupleKey = h.tupleKey
      records[#records + 1] = rec
    end
  end
  self._state = "disposed"
  self._inputEnabled = false
  self._holds, self._byTuple, self._sessions = {}, {}, {}
  result.holds = #records
  result.records = records
  return result
end

function Instance:backendAvailable()
  checkLive(self, "backendAvailable")
  local b = BACKENDS[self._backend]
  local missing = {}
  if b then
    for _, fn in ipairs(b.requires) do
      if type(self._deps[fn]) ~= "function" then missing[#missing + 1] = fn end
    end
  end
  return #missing == 0, missing
end

-- Read-only: resolves a logical key against the live shortcut table. Reads happen now, not at new().
function Instance:describeKey(name, opts)
  checkLive(self, "describeKey")
  local d = self._deps
  if type(d.shortcutRows) ~= "function" or type(d.virtualKeyCodes) ~= "function" then
    return { key = tostring(name), supported = false, reason = "deps.shortcutRows/deps.virtualKeyCodes not provided" }
  end
  local okR, rows = pcall(d.shortcutRows)
  if not okR then return { key = tostring(name), supported = false, reason = "shortcut table read failed: " .. tostring(rows) } end
  local okV, vk = pcall(d.virtualKeyCodes)
  if not okV then return { key = tostring(name), supported = false, reason = "VirtualKeyCode enum read failed: " .. tostring(vk) } end
  local r = resolve(rows, vk, name, opts)
  if type(d.shortcutsActive) == "function" then
    local okA, active = pcall(d.shortcutsActive)
    if okA then r.shortcutsActive = active end
  end
  if type(d.profileName) == "function" then
    local okP, p = pcall(d.profileName)
    if okP then r.profile = p end
  end
  return r
end

-- Internals ---------------------------------------------------------------------

function Instance:_leaseMs(ms)
  ms = ms or self._config.defaultLeaseMs
  if type(ms) ~= "number" or ms <= 0 or ms > self._config.maxLeaseMs then
    return fail("bad-argument", "leaseMs must be a number in (0, " .. self._config.maxLeaseMs .. "]")
  end
  return ms
end

function Instance:_admit(sessionId, now)
  if not self._inputEnabled then return fail("input-disabled", "input is disabled on this instance; the operator enables it explicitly") end
  if not self._adapter then return fail("no-backend", "no dispatching backend is attached") end
  local s = self._sessions[sessionId]
  if not s or s.state == "closed" then return fail("no-session", "session '" .. tostring(sessionId) .. "' is not open") end
  if s.state == "active" and now >= s.expiresAt then self:_expireSession(s, now) end
  if s.state == "expired" then return fail("lease-expired", "session '" .. sessionId .. "' lease expired; renew it before new input", { expiredAt = s.expiredAt }) end
  return s
end

-- Marks a session expired and gives every key it holds a due cleanup deadline. Called from
-- service(), and from admission/renewal when the lease ran out between service() calls so that
-- enforcement never depends on how recently the loop serviced the instance.
function Instance:_expireSession(s, now)
  s.state = "expired"
  s.expiredAt = now
  self._pendingExpired[#self._pendingExpired + 1] = s.id
  for _, h in ipairs(self:_sessionHolds(s.id, true)) do
    if h.state == "held" then self:_setDeadline(h, now, "lease-expired") end
  end
end

-- Turns a press spec into a stored tuple plus the route it was resolved by. Nothing is dispatched.
function Instance:_resolveSpec(spec)
  if type(spec) ~= "table" then return nil, nil, { code = "bad-argument", message = "press needs a spec table" } end
  local display = spec.display
  if display ~= nil then
    if type(display) ~= "number" then return nil, nil, { code = "bad-argument", message = "display must be a number" } end
    if type(self._deps.displayExists) ~= "function" then
      return nil, nil, { code = "unsupported", message = "a display was given but the console display list cannot be checked (deps.displayExists missing); input is not display-scoped anyway" }
    end
    local ok, exists = pcall(self._deps.displayExists, display)
    if not ok or not exists then return nil, nil, { code = "bad-argument", message = "display " .. display .. " does not exist" } end
  end
  for _, flag in ipairs({ "shift", "ctrl", "alt", "numlock" }) do
    if spec[flag] ~= nil and type(spec[flag]) ~= "boolean" then return nil, nil, { code = "bad-argument", message = flag .. " must be a boolean" } end
  end
  if spec.key ~= nil then
    if spec.pcKey ~= nil then return nil, nil, { code = "bad-argument", message = "give either key (logical) or pcKey (raw), not both" } end
    if spec.shift or spec.ctrl or spec.alt then
      return nil, nil, { code = "bad-argument", message = "modifiers of a logical key come from its shortcut mapping; pass them only with pcKey" }
    end
    local r = self:describeKey(spec.key, { executor = spec.executor })
    if not r.supported then return nil, nil, { code = "unsupported", message = "logical key " .. tostring(spec.key) .. " is unsupported: " .. tostring(r.reason), resolution = r } end
    if r.source == "shortcut-table" and r.shortcutsActive == false then
      return nil, nil, { code = "unsupported", message = "logical key " .. r.key .. " routes through the shortcut table but keyboard shortcuts are inactive; the operator must enable them (never toggled here)", resolution = r }
    end
    local tuple = { pcKey = r.pcKey, shift = r.shift, ctrl = r.ctrl, alt = r.alt, numlock = spec.numlock and true or false, display = display }
    local route = { logical = r.key, source = r.source, shortcut = r.shortcut, rowIndex = r.rowIndex, executor = r.executor, profile = r.profile, shortcutsActive = r.shortcutsActive, verify = r.verify }
    return tuple, route, nil
  end
  if type(spec.pcKey) ~= "string" or spec.pcKey == "" then return nil, nil, { code = "bad-argument", message = "spec needs key (logical name) or pcKey (non-empty PC key name)" } end
  if self._adapter and type(self._adapter.supportsKey) == "function" then
    local ok, supported, reason = pcall(self._adapter.supportsKey, self._adapter, spec.pcKey)
    if not ok then return nil, nil, { code = "unsupported", message = "backend key check failed: " .. tostring(supported) } end
    if not supported then return nil, nil, { code = "unsupported", message = tostring(reason or ("PC key " .. spec.pcKey .. " is not supported")) } end
  end
  local tuple = { pcKey = spec.pcKey, shift = spec.shift and true or false, ctrl = spec.ctrl and true or false, alt = spec.alt and true or false,
                  numlock = spec.numlock and true or false, display = display }
  return tuple, { source = "raw" }, nil
end

-- Re-resolves the logical key of every live hold and compares with the stored route. Returns a list
-- of mismatches (and annotates the holds) or nil. Raw holds have no route to check.
function Instance:_checkRoutes()
  local mismatches
  for _, h in pairs(self._holds) do
    if h.state ~= "released" and h.logical and h.route and h.route.source ~= "raw" then
      local r = self:describeKey(h.logical, { executor = h.route.executor })
      local why
      if not r.supported then why = "no longer resolvable: " .. tostring(r.reason)
      elseif r.pcKey ~= h.pcKey or (r.shift or false) ~= h.shift or (r.ctrl or false) ~= h.ctrl or (r.alt or false) ~= h.alt then
        why = string.format("now maps to %s (was %s)", tupleKey({ pcKey = r.pcKey, shift = r.shift, ctrl = r.ctrl, alt = r.alt, numlock = h.numlock }), h.tupleKey)
      elseif h.route.source == "shortcut-table" and r.shortcutsActive ~= nil and r.shortcutsActive ~= h.route.shortcutsActive then
        why = "keyboard shortcuts are now " .. tostring(r.shortcutsActive and "active" or "inactive") .. " (were " .. tostring(h.route.shortcutsActive and "active" or "inactive") .. ")"
      elseif r.profile ~= nil and h.route.profile ~= nil and r.profile ~= h.route.profile then
        why = "user profile is now '" .. tostring(r.profile) .. "' (was '" .. tostring(h.route.profile) .. "')"
      end
      if why then
        h.routeMismatch = { detected = h.routeMismatch and h.routeMismatch.detected or self._lastServiced, reason = why,
                            current = { pcKey = r.pcKey, shift = r.shift, ctrl = r.ctrl, alt = r.alt, shortcut = r.shortcut, shortcutsActive = r.shortcutsActive, profile = r.profile, supported = r.supported } }
        mismatches = mismatches or {}
        mismatches[#mismatches + 1] = { hold = h.id, logical = h.logical, original = { tupleKey = h.tupleKey, route = h.route }, mismatch = why }
      elseif h.routeMismatch then
        -- The operator restored the original route; the record stays until a release is confirmed.
        h.routeRestored = { previous = h.routeMismatch.reason }
        h.routeMismatch = nil
      end
    end
  end
  return mismatches
end

function Instance:_newHold(s, tuple, route, now, deadline, deadlineReason)
  self._seq = self._seq + 1
  local hold = copyTuple(tuple)
  hold.id = string.format("h%d", self._seq)
  hold.seq = self._seq
  hold.session = s.id
  hold.tupleKey = tupleKey(tuple)
  hold.route = route
  hold.logical = route and route.logical or nil
  hold.pressedAt = now
  hold.state = "held"
  hold.kind = "hold"
  hold.dispatch = { attempts = 0 }
  hold.deadline, hold.deadlineReason = deadline, deadlineReason
  self._holds[hold.id] = hold
  self._byTuple[hold.tupleKey] = hold
  return hold
end

function Instance:_dropHold(hold)
  self._holds[hold.id] = nil
  if self._byTuple[hold.tupleKey] == hold then self._byTuple[hold.tupleKey] = nil end
end

function Instance:_setDeadline(hold, at, reason)
  if hold.deadline == nil or at < hold.deadline or reason == "lease-expired" then
    hold.deadline, hold.deadlineReason = at, reason
  end
end

function Instance:_markUnresolved(hold, now, reason)
  hold.state = "unresolved"
  hold.unresolved = { reason = reason, since = hold.unresolved and hold.unresolved.since or now, lastAttempt = now }
  hold.deadline = nil
end

-- One release attempt with the stored tuple. Outcome rules:
--   adapter error / refusal                 -> unresolved (record kept)
--   ok, confirmed == true                   -> released (verified)
--   ok, confirmed == nil, route unchanged   -> released (dispatched; effect not observable on this backend)
--   ok, confirmed == false, or confirmed == nil with a route mismatch -> unresolved: a return without
--   error is not evidence that the key came up after a remap/disable (KB-01/KB-03 macOS probes).
function Instance:_attemptRelease(hold, now, reason)
  self._releaseAttempts = self._releaseAttempts + 1
  hold.dispatch.attempts = hold.dispatch.attempts + 1
  if hold.logical then self:_checkRoutes() end  -- recheck the route right before using the stored tuple
  hold.state = "releasing"
  local attempt = { hold = hold.id, session = hold.session, tupleKey = hold.tupleKey, logical = hold.logical, reason = reason, at = now }
  local ok, aOk, confirmed, err = pcall(self._adapter.release, self._adapter, copyTuple(hold))
  if not ok then
    attempt.ok, attempt.error = false, "release raised an error: " .. tostring(aOk)
  elseif aOk == false then
    attempt.ok, attempt.error = false, "release refused by the backend: " .. tostring(err or confirmed)
  else
    attempt.ok, attempt.confirmed = true, confirmed
  end
  hold.dispatch.release = { ok = attempt.ok, confirmed = attempt.confirmed, at = now, error = attempt.error, reason = reason }
  if not attempt.ok then
    self:_markUnresolved(hold, now, attempt.error)
    attempt.state = "unresolved"
  elseif attempt.confirmed == true or (attempt.confirmed == nil and not hold.routeMismatch) then
    hold.state = "released"
    hold.releasedAt = now
    hold.deadline = nil
    hold.unresolved = nil
    if self._byTuple[hold.tupleKey] == hold then self._byTuple[hold.tupleKey] = nil end
    attempt.state = "released"
    attempt.verified = attempt.confirmed == true
  else
    local why = attempt.confirmed == false and "release was dispatched but the backend reports the key still down"
      or ("release was dispatched with the stored tuple, but the route changed during the hold (" .. tostring(hold.routeMismatch and hold.routeMismatch.reason) .. ") and the effect cannot be confirmed")
    self:_markUnresolved(hold, now, why)
    attempt.state = "unresolved"
  end
  if hold.state == "released" then
    -- Released records are kept only until their session is reported; they free their tuple now.
    self._released[#self._released + 1] = hold
    while #self._released > 32 do
      local old = table.remove(self._released, 1)
      if self._holds[old.id] == old then self._holds[old.id] = nil end
    end
    self:_maybeForgetSession(hold.session)
  end
  return attempt
end

function Instance:_maybeForgetSession(id)
  local s = self._sessions[id]
  if s and s.state == "closed" and self:_sessionHoldCount(id) == 0 then self._sessions[id] = nil end
end

-- Releases a list of holds (most recent press first). Returns { released = {...}, unresolved = {...}, skipped = n }.
function Instance:_releaseHolds(list, now, reason)
  table.sort(list, function(a, b) return a.seq > b.seq end)
  local out = { released = {}, unresolved = {}, attempted = 0 }
  for _, h in ipairs(list) do
    if h.state == "held" or h.state == "unresolved" then
      out.attempted = out.attempted + 1
      local r = self:_attemptRelease(h, now, reason)
      if h.state == "released" then out.released[#out.released + 1] = r else out.unresolved[#out.unresolved + 1] = r end
    end
  end
  return out
end

-- Ownership records that still matter: held, releasing or unresolved (released ones are history).
function Instance:_liveCount()
  local n = 0
  for _, h in pairs(self._holds) do if h.state ~= "released" then n = n + 1 end end
  return n
end

function Instance:_heldHolds()
  local list = {}
  for _, h in pairs(self._holds) do if h.state == "held" then list[#list + 1] = h end end
  return list
end

function Instance:_sessionHolds(id, includeUnresolved)
  local list = {}
  for _, h in pairs(self._holds) do
    if h.session == id and (h.state == "held" or (includeUnresolved and h.state == "unresolved")) then list[#list + 1] = h end
  end
  return list
end

function Instance:_sessionHoldCount(id)
  local n = 0
  for _, h in pairs(self._holds) do if h.session == id and h.state ~= "released" then n = n + 1 end end
  return n
end

function Instance:_orderedHolds()
  local list = {}
  for _, h in pairs(self._holds) do list[#list + 1] = h end
  table.sort(list, function(a, b) return a.seq < b.seq end)
  return list
end

function Instance:_findHold(sessionId, selector)
  if type(selector) ~= "table" then return fail("bad-argument", "release needs { hold = <id> } or a key spec") end
  if selector.hold ~= nil then
    local h = self._holds[selector.hold]
    if not h then return fail("no-hold", "hold '" .. tostring(selector.hold) .. "' does not exist (released holds are forgotten after a while)") end
    if h.session ~= sessionId then return fail("not-owner", "hold '" .. h.id .. "' belongs to session '" .. h.session .. "'", { owner = h.session }) end
    return h
  end
  local tuple, _, err = self:_resolveSpec(selector)
  if not tuple then
    -- The current mapping may no longer resolve (remap/disable). Fall back to the session's stored
    -- logical names so a client can still name the key it pressed; the stored tuple is what is released.
    if type(selector.key) == "string" then
      for _, h in pairs(self._holds) do
        if h.session == sessionId and h.logical == selector.key:upper() and h.state ~= "released" then return h end
      end
    end
    return nil, err
  end
  local tk = tupleKey(tuple)
  local h = self._byTuple[tk]
  if h and h.session == sessionId then return h end
  -- Not live by the current resolution: look for the stored logical name (route may have changed).
  if type(selector.key) == "string" then
    for _, hh in pairs(self._holds) do
      if hh.session == sessionId and hh.logical == selector.key:upper() and hh.state ~= "released" then return hh end
    end
  end
  for _, hh in ipairs(self._released) do
    if hh.session == sessionId and hh.tupleKey == tk then return hh end
  end
  if h then return fail("not-owner", "tuple " .. tk .. " is owned by session '" .. h.session .. "'", { owner = h.session }) end
  return fail("no-hold", "session '" .. sessionId .. "' holds no key with tuple " .. tk)
end

function Instance:_sessionReport(s, now)
  local remaining
  if now and s.state == "active" then remaining = math.max(0, math.floor((s.expiresAt - now) * 1000 + 0.5)) end
  return { id = s.id, label = s.label, binding = s.binding, state = s.state, leaseMs = s.leaseMs, expiresAt = s.expiresAt,
           remainingMs = remaining, renewals = s.renewals, openedAt = s.openedAt, expiredAt = s.expiredAt, closedAt = s.closedAt,
           closeReason = s.closeReason, holds = self:_sessionHoldCount(s.id) }
end

function Instance:_holdReport(h, now, extra)
  local r = {
    id = h.id, session = h.session, state = h.state, kind = h.kind,
    logical = h.logical, pcKey = h.pcKey, shift = h.shift, ctrl = h.ctrl, alt = h.alt, numlock = h.numlock, display = h.display,
    tupleKey = h.tupleKey, route = h.route, pressedAt = h.pressedAt, releasedAt = h.releasedAt,
    deadline = h.deadline, deadlineReason = h.deadlineReason,
    dispatch = h.dispatch, unresolved = h.unresolved, routeMismatch = h.routeMismatch, observed = h.observed,
    observedReleasedAt = h.observedReleasedAt, adopted = h.adopted, routeRestored = h.routeRestored,
  }
  if now then
    r.heldMs = math.floor(((h.releasedAt or now) - h.pressedAt) * 1000 + 0.5)
    if h.deadline then r.deadlineInMs = math.max(0, math.floor((h.deadline - now) * 1000 + 0.5)) end
  end
  if extra then for k, v in pairs(extra) do r[k] = v end end
  return r
end

local function new(opts)
  opts = opts or {}
  if type(opts.owner) ~= "string" or opts.owner == "" then error(NAME .. ".new: opts.owner (non-empty string) is required", 2) end
  local backend = opts.backend or "keyboard"
  if not BACKENDS[backend] then error(NAME .. ".new: unknown backend '" .. tostring(backend) .. "'", 2) end
  if opts.deps ~= nil and type(opts.deps) ~= "table" then error(NAME .. ".new: opts.deps must be a table", 2) end
  if opts.config ~= nil and type(opts.config) ~= "table" then error(NAME .. ".new: opts.config must be a table", 2) end
  local config = shallowCopy(DEFAULT_CONFIG)
  for k, v in pairs(opts.config or {}) do
    if DEFAULT_CONFIG[k] == nil then error(NAME .. ".new: unknown config key '" .. tostring(k) .. "'", 2) end
    if type(v) ~= "number" or v <= 0 then error(NAME .. ".new: config." .. k .. " must be a positive number", 2) end
    config[k] = v
  end
  local self = setmetatable({
    _owner = opts.owner, _backend = backend, _deps = opts.deps or {}, _config = config,
    _adapter = nil, _inputEnabled = false,
    _state = "created", _holds = {}, _byTuple = {}, _released = {}, _sessions = {}, _pendingExpired = {},
    _seq = 0, _pressCount = 0, _releaseAttempts = 0, _serviced = 0, _lastServiced = nil, _observed = nil,
  }, Instance)
  return self
end

local M = {
  NAME = NAME, VERSION = VERSION, API_VERSION = API_VERSION,
  LOGICAL_KEYS = { "PLEASE", "STORE", "ESC", "CLEAR", "OOPS", "NUM0", "NUM1", "NUM2", "NUM3", "NUM4", "NUM5", "NUM6", "NUM7", "NUM8", "NUM9", "EXEC", "MA" },
  UNSUPPORTED_KEYS = { "MA1", "MA2" },
  new = new, consoleDeps = consoleDeps, resolve = resolve, parseShortcut = parseShortcut, tupleKey = tupleKey,
  fakeBackend = fakeBackend,
  backends = { keyboard = BACKENDS.keyboard.name, fake = BACKENDS.fake.name },
  DEFAULT_CONFIG = shallowCopy(DEFAULT_CONFIG),
}

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
