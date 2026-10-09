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
-- What this version provides (MODULE API 1, module version 0.3.0, KB-03 + KB-04):
--   * explicit instance lifecycle: new() -> init() -> service(now) ... -> dispose(now)
--   * owned input sessions with leases: openSession / renewSession / closeSession. Every held key
--     belongs to a session; the consumer binds sessions to whatever identifies its clients (the bridge
--     binds them to TCP connections) and never accepts a session id from an untrusted caller.
--   * press / tap / combo / release / releaseAll / recover on a backend adapter. Two adapters dispatch:
--     the FAKE backend (fakeBackend(); records events, simulates aggregate key state, touches no key)
--     and, since KB-04, the KEYBOARD backend (keyboardBackend(deps); the console's Keyboard() PC-key
--     emulation with explicit per-event modifiers, routed through the operator's shortcut table or a
--     verified native route). The adapter only dispatches validated events and observes; ownership,
--     leases, deadlines and recovery stay in this lifecycle.
--   * stored press tuples: each hold keeps the resolved PC key, modifier flags, display, logical key,
--     the route it was pressed with (shortcut text, row, profile, enablement, or the native route) and
--     the name of the backend that pressed it. Release always uses that stored tuple on that backend.
--     Nothing is ever re-resolved to release a hold, and a record from one backend is never released
--     through another.
--   * release-result semantics: an attempt is CONFIRMED (the backend observed the key up), DISPATCHED
--     (the call returned; the effect is not observable per key on this backend) or UNRESOLVED (refused,
--     raised, route changed, or the backend reports the key still down). Keyboard() releases are
--     "dispatched"; the aggregate MASTATE readback is reported separately and never turned into a
--     per-key confirmation or failure.
--   * deadline servicing without sleeps: service(now) releases taps and expired leases, a bounded
--     number of attempts per call, takes the backend's console-state snapshot and completes bounded
--     readbacks (MASTATE after an MA press/release) for status().
--   * recovery: a release that fails, or that cannot be confirmed after the route changed, leaves the
--     hold in the "unresolved" state. The record is kept (and still blocks conflicting presses) until
--     a recover() attempt succeeds. dispose() hands unresolved records back so a consumer can keep
--     them across a restart and adopt() them into a new instance. attachBackend() attaches an adapter
--     for cleanup without admitting new presses.
--   * status(now): read-only. It performs no cleanup and calls nothing on the backend; the observed
--     console state it reports is the snapshot taken by the last service().
--
-- Ownership semantics (KB-01/KB-03 findings): the console's key state is shared. A physical release
-- can end a synthetic hold and MASTATE is aggregate, so an ownership record here means "this session is
-- responsible for releasing this tuple", not "the key is down because of us". The module never
-- re-presses a key because the console no longer reports it down.
--
-- Interaction semantics (KB-04): an EXCLUSIVE hold (spec.exclusive, the intended long-press) rejects
-- every new press from every session, including the owner's duplicate, until it is released, and is
-- itself refused while any other ownership record exists; releases stay allowed. A COMBO presses several
-- keys in order after every constituent key passed resolution, admission and the backend preflight;
-- nothing is dispatched if one fails, and a press that fails midway releases what was pressed. A
-- double-press is unsupported. Input is not display-scoped: the display argument is validated to exist
-- and passed to Keyboard() as API context only.
--
-- Rules every consumer must keep:
--   * One instance per consumer. Instances never share mutable state; the module table is read-only.
--   * Pass console dependencies through opts.deps (consoleDeps(_G) builds them lazily). The module
--     never reads globals, so it can be exercised under a stock Lua interpreter.
--   * Do not store an instance in a global and do not publish this module through package.loaded or
--     require(): that cache is shared by every plugin in the console and survives re-import.
--   * Input is disabled on a new instance. enableInput(adapter) is the operator's explicit decision.

local NAME        = "gma3_mcp_hardkeys"
local VERSION     = "0.3.0"
local API_VERSION = 1

-- Logical keys accepted by describeKey() and press(). Each resolves through the UserProfile
-- KeyboardShortcut table to the row whose KeyCode equals the named Enums.VirtualKeyCode, except:
--   * MA, which is the PC LeftShift key itself (KB-01 follow-up F2-F4; verified through Root().MASTATE);
--   * PLEASE, which has a NATIVE route: the system VirtualKey PLEASE redirects the PC key Enter
--     (Root().VirtualKeys, KEYCODE = Enter) and executes with keyboard shortcuts disabled too (KB-01
--     follow-up F7). The native route is admitted only while the shortcut table does not map the plain
--     Enter key to another MA key, and while the redirect (when readable) still names Enter.
local LOGICAL_KEYS = {
  PLEASE = { vk = "PLEASE", native = "Enter" }, STORE = { vk = "STORE" }, ESC = { vk = "ESC" },
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

-- What the Keyboard() backend can and cannot promise (KB-01 evidence, onPC 2.5.1.0, US layout).
local KEYBOARD_LIMITATIONS = {
  "Keyboard() emulates a PC keyboard: MA keys are reached through the operator's shortcut table or a verified native route (MA = LeftShift, PLEASE = Enter redirect); unresolved routes are unsupported",
  "input is not display-scoped on 2.5.1: the display argument must exist but does not route input, focus or pop-up placement",
  "no per-key readback exists; Root().MASTATE is aggregate (any Shift source), so a release is reported as dispatched, never confirmed, and MASTATE is reported separately",
  "injected and physical input share one key state: a physical release ends an injected hold and vice versa; ownership records responsibility, not console state",
  "a remapped or disabled shortcut during a hold prevents the stored-tuple release until the operator restores the route; the module never changes mappings or toggles F10",
  "invalid arguments are accepted silently by onPC; validation happens here before dispatch and a no-error return is not evidence of effect",
  "double-press is unsupported; a long-press is promised only as an exclusive hold with no other key down",
}

local BACKENDS = {
  keyboard = {
    name = "keyboard",
    description = "Keyboard(): PC-key emulation with explicit per-event modifiers, routed through the operator's UserProfile shortcut table or a verified native route; console keys are really pressed",
    requires = { "Keyboard" },
    dispatches = true,
    limitations = KEYBOARD_LIMITATIONS,
  },
  fake = {
    name = "fake",
    description = "in-memory fake: records events and simulates aggregate console key state; nothing reaches the console",
    requires = {},
    dispatches = true,
    limitations = { "nothing reaches a console key; lifecycle behaviour only" },
  },
}

-- Defaults for new(); every value can be overridden through opts.config.
local DEFAULT_CONFIG = {
  maxHolds           = 8,       -- held + releasing + unresolved records, instance-wide
  defaultLeaseMs     = 15000,   -- session lease when openSession() gives none
  maxLeaseMs         = 120000,  -- longest lease a session may ask for
  maxHoldMs          = 30000,   -- longest a press may stay held before service() releases it
  maxTapMs           = 5000,    -- longest hold a tap() or combo() may ask for
  maxWorkPerService  = 4,       -- release attempts one service() call may make
  eventLog           = 64,      -- fake backend event history length
  readbackMs         = 1000,    -- how long service() waits for an aggregate readback (MASTATE) before calling it inconclusive
  maxComboKeys       = 4,       -- keys one combo() may press
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

local function sameTuple(a, b) return a.key == b.key and a.shift == b.shift and a.ctrl == b.ctrl and a.alt == b.alt end

-- Every shortcut row whose PC key + modifiers equal `parsed` but whose target differs from the one being
-- resolved (another VirtualKeyCode, or the same EXEC/SpecialExec key with another executor identity). The
-- console's behaviour with colliding rows is unverified, so a collision makes the route unsupported rather
-- than dispatching an action that may not be the requested one. `target` = { keyCode, executorIndex,
-- specialExec } or nil for the fixed/native routes (any row claiming the tuple collides).
local function collisions(rows, parsed, target)
  local out = {}
  for i, row in ipairs(rows or {}) do
    local p = parseShortcut(row.shortcut)
    if p and sameTuple(p, parsed) then
      local same = target ~= nil and row.keyCode == target.keyCode
        and (target.executorIndex == nil or row.executorIndex == target.executorIndex)
        and ((row.specialExec == nil and target.specialExec == nil) or row.specialExec == target.specialExec)
      if not same then
        out[#out + 1] = string.format("row %d (%s -> VirtualKeyCode %s%s%s)", i, tostring(row.shortcut), tostring(row.keyCode),
          row.executorIndex and (" executor " .. tostring(row.executorIndex)) or "", row.specialExec and (" special " .. tostring(row.specialExec)) or "")
      end
    end
  end
  return #out > 0 and out or nil
end

-- rows: list of { shortcut = "Ctrl+F1", keyCode = <VirtualKeyCode number>, executorIndex = <number|nil> }
-- vkCodes: VirtualKeyCode name -> number (Enums.VirtualKeyCode on the console)
-- opts: { executor = <number> } for EXEC;
--       { keyboardCodes = <KeyboardCodes name -> number> } validates the resolved PC key name (optional);
--       { redirects = <VirtualKeyCode name -> PC key name> } the Root().VirtualKeys KEYCODE redirects (optional)
-- Route kinds: "fixed" (MA = LeftShift), "native" (PLEASE = Enter redirect, independent of shortcut
-- enablement) and "shortcut-table" (every other logical key; needs KEYBOARDSHORTCUTSACTIVE). The caller
-- decides on enablement; resolve() only reports the route and its validity.
local function resolve(rows, vkCodes, name, opts)
  local key = type(name) == "string" and name:upper() or nil
  if not key then return { key = tostring(name), supported = false, reason = "key name must be a string" } end
  if UNSUPPORTED_KEYS[key] then return { key = key, supported = false, reason = UNSUPPORTED_KEYS[key] } end
  local def = LOGICAL_KEYS[key]
  if not def then return { key = key, supported = false, reason = "not a logical key of this module" } end
  local codes = opts and opts.keyboardCodes
  local function checkPcKey(r)
    if type(codes) == "table" then
      if codes[r.pcKey] == nil then
        return { key = key, supported = false, reason = "route names PC key '" .. tostring(r.pcKey) .. "', which is not an Enums.KeyboardCodes name on this console", route = r.source, shortcut = r.shortcut }
      end
      r.pcKeyValidated = true
    else
      r.pcKeyValidated = false
    end
    return r
  end
  if def.pcKey then
    -- The fixed route is native console behaviour; a shortcut row claiming the same PC key is a collision
    -- whose precedence is unverified.
    local c = type(rows) == "table" and collisions(rows, { key = def.pcKey, shift = false, ctrl = false, alt = false }, nil) or nil
    if c then return { key = key, supported = false, source = "fixed", pcKey = def.pcKey, reason = "shortcut collision: " .. table.concat(c, ", ") .. " also claims the plain " .. def.pcKey .. " key", collisions = c } end
    return checkPcKey({ key = key, supported = true, backend = "keyboard", pcKey = def.pcKey, shift = false, ctrl = false, alt = false,
             verify = def.verify, source = "fixed", note = "MA is the PC Shift key itself; it does not use the shortcut table" })
  end
  if type(rows) ~= "table" or type(vkCodes) ~= "table" then
    return { key = key, supported = false, reason = "shortcut table or VirtualKeyCode enum unavailable" }
  end
  local vk = vkCodes[def.vk]
  if vk == nil then return { key = key, supported = false, reason = "VirtualKeyCode " .. def.vk .. " unknown on this console" } end
  if def.native then
    -- Native route: the PC key must not be claimed by the shortcut table for another MA key (which
    -- one would win is unverified), and the system redirect, when readable, must still name it.
    local c = collisions(rows, { key = def.native, shift = false, ctrl = false, alt = false }, { keyCode = vk })
    if c then
      return { key = key, supported = false, source = "native", pcKey = def.native, collisions = c,
               reason = string.format("ambiguous: %s maps the plain %s key to another target than %s; the native %s redirect cannot be relied on", table.concat(c, ", "), def.native, def.vk, def.native) }
    end
    local redirects = opts and opts.redirects
    local redirect, redirectChecked = nil, false
    if type(redirects) == "table" then
      redirect = redirects[def.vk]
      if redirect ~= nil then
        redirectChecked = true
        if tostring(redirect) ~= def.native then
          return { key = key, supported = false, source = "native", pcKey = def.native,
                   reason = string.format("the VirtualKey %s redirect is '%s' on this console, not '%s'", def.vk, tostring(redirect), def.native) }
        end
      end
    end
    return checkPcKey({ key = key, supported = true, backend = "keyboard", pcKey = def.native, shift = false, ctrl = false, alt = false, source = "native",
             redirectChecked = redirectChecked,
             note = "PLEASE uses the system VirtualKey redirect of the Enter key (KB-01 F7); it works with shortcuts disabled and does not depend on a shortcut row" })
  end
  local executor = opts and opts.executor
  if def.needsExecutor then
    if type(executor) ~= "number" then return { key = key, supported = false, reason = "EXEC needs opts.executor (the ExecutorIndex of a mapped executor shortcut)" } end
  end
  local best, bestParsed, bestIndex, ties
  for i, row in ipairs(rows) do
    if row.keyCode == vk and ((not def.needsExecutor) or row.executorIndex == executor) then
      local parsed = parseShortcut(row.shortcut)
      if parsed then
        if best == nil or modifierCount(parsed) < modifierCount(bestParsed) then
          best, bestParsed, bestIndex, ties = row, parsed, i, nil
        elseif modifierCount(parsed) == modifierCount(bestParsed) and row.shortcut ~= best.shortcut then
          ties = ties or { best.shortcut }
          ties[#ties + 1] = row.shortcut
        end
      end
    end
  end
  if not best then
    local what = def.needsExecutor and ("EXEC with ExecutorIndex " .. tostring(executor)) or key
    return { key = key, supported = false, reason = "no keyboard shortcut maps to " .. what .. " in the current user profile" }
  end
  -- Several rows with the same key text (the default profile has two "Enter" rows) are one route;
  -- different shortcuts with the same modifier count are ambiguous and are rejected, never guessed.
  if ties then
    return { key = key, supported = false, reason = "ambiguous: several shortcuts with the same modifier count map to " .. key .. " (" .. table.concat(ties, ", ") .. "); edit the profile or pick one with pcKey", candidates = ties }
  end
  -- The chosen tuple must not also be claimed for another target anywhere in the table.
  local c = collisions(rows, bestParsed, { keyCode = vk, executorIndex = def.needsExecutor and executor or nil, specialExec = best.specialExec })
  if c then
    return { key = key, supported = false, reason = string.format("shortcut collision: %s is mapped to %s by row %d but also to another target by %s; the console's precedence is unverified, so the route is refused", best.shortcut, key, bestIndex, table.concat(c, ", ")), collisions = c, shortcut = best.shortcut }
  end
  return checkPcKey({ key = key, supported = true, backend = "keyboard", pcKey = bestParsed.key, shift = bestParsed.shift, ctrl = bestParsed.ctrl,
           alt = bestParsed.alt, shortcut = best.shortcut, rowIndex = bestIndex, executor = def.needsExecutor and executor or nil, source = "shortcut-table" })
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
            specialExec = tonumber(r:Get("SpecialExec")),
          }
        end
      end
      return rows
    end,
    -- Identity of the profile a route was resolved in. A profile switch during a hold is a route change.
    profileName = function() return tostring(env.CurrentProfile().name) end,
    -- Display validation only: input is not display-scoped on this console (KB-01).
    displayExists = function(n) return env.GetDisplayByIndex(n) ~= nil end,
    -- PC key names Keyboard() accepts (GLFW-style Enums.KeyboardCodes). onPC ignores unknown names
    -- silently, so this is the only validation there is.
    keyboardCodes = function() return env.Enums and env.Enums.KeyboardCodes end,
    -- Aggregate MA state (any Shift source). true/false, or nil when the property is not readable.
    maState = function()
      local v = env.Root():Get("MAState")
      if v == true or v == "true" or v == "True" or v == 1 then return true end
      if v == false or v == "false" or v == "False" or v == 0 then return false end
      return nil
    end,
    -- System VirtualKey redirects (Root().VirtualKeys: CODE -> KEYCODE), e.g. PLEASE -> "Enter".
    virtualKeyRedirects = function()
      local vks = env.Root().VirtualKeys
      local out = {}
      for i = 1, vks:Count() do
        local v = vks:Ptr(i)
        if v then
          local code = tostring(v:Get("Code"))
          if code ~= "" and code ~= "nil" then out[code] = tostring(v:Get("KeyCode")) end
        end
      end
      return out
    end,
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

-- Per-tuple state plus the aggregate MA state the way the console reports it: true while any Shift
-- key (either side, any flags) is down. The aggregate is what the readback logic is tested against.
function FakeBackend:observe()
  local down, ma = {}, false
  for k in pairs(self.down) do
    down[k] = true
    if k:match("^LeftShift|") or k:match("^RightShift|") then ma = true end
  end
  return { available = true, down = down, aggregate = { maState = ma } }
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

-- Keyboard backend (KB-04) ----------------------------------------------------

-- The console adapter: Keyboard(display, 'press'|'release', <KeyboardCodes name>, shift, ctrl, alt,
-- numlock). It is deliberately small. It validates what onPC would accept silently (function present,
-- key name in Enums.KeyboardCodes, display exists, MASTATE readable when a route is verified by it),
-- passes every modifier explicitly on every event, and observes aggregate state. It owns nothing:
-- ownership, leases, deadlines and recovery live in the instance.
--   press/release(tuple) -> true, nil          dispatched; the effect is not observable per key
--                        -> false, nil, err    refused before anything was sent
--                        -> raises             Keyboard() itself raised: delivery unknown, the caller
--                                              keeps the record as unresolved
--   observe() -> { available = false (no per-key state), aggregate = { maState = bool|nil, error } }
--   supportsKey(pcKey), preflight(tuple, route)
local KeyboardBackend = {}
KeyboardBackend.__index = KeyboardBackend

local function keyboardBackend(deps, opts)
  if type(deps) ~= "table" then error(NAME .. ".keyboardBackend: deps table required (consoleDeps(_G))", 2) end
  opts = opts or {}
  return setmetatable({
    name = "keyboard", dispatches = true, description = BACKENDS.keyboard.description, limitations = KEYBOARD_LIMITATIONS,
    deps = deps, defaultDisplay = tonumber(opts.defaultDisplay) or 1,
    counters = { press = 0, release = 0, refused = 0, raised = 0, observe = 0 },
    lastEvent = nil,
  }, KeyboardBackend)
end

function KeyboardBackend:supportsKey(pcKey)
  if type(pcKey) ~= "string" or pcKey == "" then return false, "PC key must be a non-empty Enums.KeyboardCodes name" end
  if type(self.deps.keyboardCodes) ~= "function" then return false, "Enums.KeyboardCodes cannot be read (deps.keyboardCodes missing); key names cannot be validated" end
  local ok, codes = pcall(self.deps.keyboardCodes)
  if not ok or type(codes) ~= "table" then return false, "Enums.KeyboardCodes unavailable: " .. tostring(ok and "not a table" or codes) end
  if codes[pcKey] == nil then return false, "'" .. pcKey .. "' is not an Enums.KeyboardCodes name (names are case-sensitive, e.g. Enter, Escape, LeftShift, F1, 5)" end
  return true
end

-- Everything that must hold before the first event of a press or combo goes out. Nothing is sent.
function KeyboardBackend:preflight(tuple, route)
  if type(self.deps.Keyboard) ~= "function" then return false, "Keyboard() is not available in this Lua environment" end
  local ok, reason = self:supportsKey(tuple.pcKey)
  if not ok then return false, reason end
  local display = tuple.display or self.defaultDisplay
  if type(self.deps.displayExists) == "function" then
    local okD, exists = pcall(self.deps.displayExists, display)
    if not okD or not exists then return false, "display " .. tostring(display) .. " does not exist (input is not display-scoped; the index is API context only)" end
  end
  if route and route.verify == "MASTATE" then
    if type(self.deps.maState) ~= "function" then return false, "MASTATE cannot be read (deps.maState missing); MA cannot be verified" end
    local okM, v = pcall(self.deps.maState)
    if not okM or type(v) ~= "boolean" then return false, "Root().MASTATE is not readable (" .. tostring(okM and ("value " .. tostring(v)) or v) .. "); MA cannot be verified" end
  end
  return true
end

function KeyboardBackend:_send(kind, tuple)
  self.counters[kind] = self.counters[kind] + 1
  if type(self.deps.Keyboard) ~= "function" then
    self.counters.refused = self.counters.refused + 1
    return false, nil, "Keyboard() is not available in this Lua environment"
  end
  local display = tuple.display or self.defaultDisplay
  local args = { display, kind, tuple.pcKey, tuple.shift and true or false, tuple.ctrl and true or false, tuple.alt and true or false, tuple.numlock and true or false }
  self.lastEvent = { kind = kind, args = args }
  local ok, err = pcall(self.deps.Keyboard, table.unpack(args, 1, 7))
  if not ok then
    self.counters.raised = self.counters.raised + 1
    error(string.format("Keyboard(%d, '%s', '%s', %s, %s, %s, %s) raised: %s (whether the event was delivered is unknown)",
      display, kind, tuple.pcKey, tostring(args[4]), tostring(args[5]), tostring(args[6]), tostring(args[7]), tostring(err)), 0)
  end
  return true, nil  -- dispatched; no per-key confirmation exists on this backend
end

-- press() validates again right before sending (the preflight may have run for a whole combo a moment
-- earlier); release() does not revalidate the key name: the stored tuple is what was pressed.
function KeyboardBackend:press(tuple)
  local ok, reason = self:preflight(tuple, nil)
  if not ok then self.counters.press = self.counters.press + 1; self.counters.refused = self.counters.refused + 1; return false, nil, reason end
  return self:_send("press", tuple)
end

function KeyboardBackend:release(tuple)
  return self:_send("release", tuple)
end

function KeyboardBackend:observe()
  self.counters.observe = self.counters.observe + 1
  local out = { available = false, reason = "Keyboard() exposes no per-key state; only the aggregate MASTATE is readable", aggregate = {} }
  if type(self.deps.maState) == "function" then
    local ok, v = pcall(self.deps.maState)
    if ok and type(v) == "boolean" then out.aggregate.maState = v
    else out.aggregate.error = ok and ("MASTATE value " .. tostring(v)) or tostring(v) end
  else
    out.aggregate.error = "deps.maState missing"
  end
  return out
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

-- Attaches a dispatching adapter WITHOUT admitting presses: the cleanup path (recover(), release())
-- can then dispatch while input stays disabled. Refused while ownership records exist and the adapter
-- would change, so a backend never changes under a partially dispatched interaction. Records that
-- originate from another backend are never released through this one (see _attemptRelease), so
-- attaching the keyboard adapter cannot turn a fake record into a real key event.
function Instance:attachBackend(adapter)
  checkReady(self, "attachBackend")
  if type(adapter) ~= "table" or type(adapter.press) ~= "function" or type(adapter.release) ~= "function" or type(adapter.name) ~= "string" then
    return fail("bad-adapter", "attachBackend needs a backend adapter table with name, press() and release()")
  end
  if not adapter.dispatches then
    return fail("backend-no-dispatch", "backend '" .. adapter.name .. "' has no dispatch")
  end
  if self._adapter ~= nil and self._adapter ~= adapter and self:_liveCount() > 0 then
    return fail("holds-exist", "cannot switch the backend while ownership records exist; release or recover them first", { holds = self:_liveCount() })
  end
  self._adapter = adapter
  self._backend = adapter.name
  return { attached = true, backend = adapter.name, enabled = self._inputEnabled and true or false }
end

-- Operator decision: attach a dispatching adapter and admit presses.
function Instance:enableInput(adapter)
  checkReady(self, "enableInput")
  local r, err = self:attachBackend(adapter)
  if not r then return nil, err end
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

-- spec: { key = "PLEASE" | pcKey = "Enter", shift, ctrl, alt, numlock, display, executor, maxHoldMs,
--         exclusive }. exclusive=true is the intended long-press: while it is held no new press from any
-- session is admitted (a second key or a duplicate press cancels the console's long-press, KB-01), and
-- it is refused while any other ownership record exists.
-- Returns the hold report, or nil, { code, message, ... }. Nothing is dispatched when an error is returned.
function Instance:press(sessionId, now, spec)
  checkReady(self, "press")
  checkNow(now, "press")
  local s, serr = self:_admit(sessionId, now)
  if not s then return nil, serr end
  local plan, perr = self:_planPress(sessionId, now, spec)
  if not plan then return nil, perr end
  if plan.duplicate then return self:_holdReport(plan.duplicate, now, { duplicate = true }) end
  local hold, derr = self:_dispatchPress(s, plan, now)
  if not hold then return nil, derr end
  return self:_holdReport(hold, now)
end

-- holdMs bounded by config.maxTapMs; the release is serviced by service(now) at the deadline. The
-- response means: press dispatched, release SCHEDULED (releaseOutcome = "scheduled"); completion is
-- visible later through status() / the service() result, never claimed here.
function Instance:tap(sessionId, now, spec, holdMs)
  checkReady(self, "tap")
  checkNow(now, "tap")
  holdMs = holdMs or 50
  if type(holdMs) ~= "number" or holdMs <= 0 or holdMs > self._config.maxTapMs then
    return fail("bad-argument", "holdMs must be a number in (0, " .. self._config.maxTapMs .. "]")
  end
  local s, serr = self:_admit(sessionId, now)
  if not s then return nil, serr end
  local plan, perr = self:_planPress(sessionId, now, spec)
  if not plan then return nil, perr end
  if plan.duplicate then return fail("conflict", "tuple is already held by this session; a tap cannot be layered on a hold", { hold = plan.duplicate.id }) end
  local hold, derr = self:_dispatchPress(s, plan, now)
  if not hold then return nil, derr end
  hold.kind = "tap"
  self:_setDeadline(hold, now + holdMs / 1000, "tap")
  return self:_holdReport(hold, now)
end

-- A combination: several keys pressed in order (e.g. { {key="MA"}, {key="STORE"} }). Every constituent
-- key is resolved, admitted and preflighted by the backend BEFORE the first event goes out; one failure
-- means nothing is dispatched. A press that fails midway releases what was already pressed (newest
-- first) and reports the partial outcome. opts.holdMs schedules the release of every key at the same
-- deadline, newest first (a chord tap). A combo is never exclusive: adding a key is not a long-press.
function Instance:combo(sessionId, now, specs, opts)
  checkReady(self, "combo")
  checkNow(now, "combo")
  opts = opts or {}
  if type(specs) ~= "table" or #specs < 2 then return fail("bad-argument", "combo needs a list of at least two key specs") end
  if #specs > self._config.maxComboKeys then return fail("bad-argument", "combo accepts at most " .. self._config.maxComboKeys .. " keys") end
  local holdMs = opts.holdMs
  if holdMs ~= nil and (type(holdMs) ~= "number" or holdMs <= 0 or holdMs > self._config.maxTapMs) then
    return fail("bad-argument", "holdMs must be a number in (0, " .. self._config.maxTapMs .. "]")
  end
  local s, serr = self:_admit(sessionId, now)
  if not s then return nil, serr end
  -- Preflight every key: resolution, routes, ownership, capacity, exclusivity, backend checks.
  local plans, seen = {}, {}
  for i, spec in ipairs(specs) do
    if type(spec) == "table" and spec.exclusive then return fail("bad-argument", "key " .. i .. ": a combo cannot be exclusive; a long-press is a single exclusive press/tap") end
    local plan, perr = self:_planPress(sessionId, now, spec, { comboIndex = i, reserved = seen, extra = #plans })
    if not plan then
      perr.key = i
      perr.message = "key " .. i .. " of the combo: " .. tostring(perr.message) .. " (nothing was dispatched)"
      return nil, perr
    end
    if plan.duplicate then
      return fail("conflict", "key " .. i .. " of the combo is already held by this session; a combo presses every key itself (nothing was dispatched)", { hold = plan.duplicate.id, key = i })
    end
    seen[plan.tupleKey] = i
    plans[#plans + 1] = plan
  end
  -- Dispatch in order. A failure releases what went down and reports everything.
  self._seq = self._seq + 1
  local group = string.format("g%d", self._seq)
  local holds = {}
  for i, plan in ipairs(plans) do
    local hold, derr = self:_dispatchPress(s, plan, now)
    if not hold then
      local rollback = self:_releaseHolds(holds, now, "combo-aborted")
      derr.message = "key " .. i .. " of the combo: " .. tostring(derr.message) .. string.format("; %d key(s) pressed before it were released (%d released, %d unresolved)", #holds, #rollback.released, #rollback.unresolved)
      derr.key = i
      derr.pressed = {}
      for _, h in ipairs(holds) do derr.pressed[#derr.pressed + 1] = self:_holdReport(h, now) end
      derr.rollback = rollback
      return nil, derr
    end
    hold.group = group
    hold.groupIndex = i
    if holdMs then
      hold.kind = "combo-tap"
      self:_setDeadline(hold, now + holdMs / 1000, "combo")
    else
      hold.kind = "combo"
    end
    holds[#holds + 1] = hold
  end
  local reports = {}
  for _, h in ipairs(holds) do reports[#reports + 1] = self:_holdReport(h, now) end
  return { group = group, holds = reports, count = #reports,
           releaseOrder = "newest first" .. (holdMs and (" at the deadline in " .. holdMs .. " ms") or " on release/releaseAll") }
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
    if (h.state == "unresolved" or h.state == "releasing") and (sessionId == nil or h.session == sessionId) then list[#list + 1] = h end
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
        -- The originating backend travels with the record; "unknown" is never released through any adapter.
        hold.backend = type(rec.backend) == "string" and rec.backend or "unknown"
        hold.exclusive = rec.exclusive and true or false
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
  -- Console state (observed, never ownership). A hold whose tuple the console no longer reports down
  -- is annotated, never re-pressed. Per-key state exists only on the fake backend; the aggregate
  -- MASTATE (any Shift source) is reported for MA holds: false rules out every Shift key, so the key is
  -- not down; true says nothing about which source holds it.
  if self._adapter and type(self._adapter.observe) == "function" then
    local ok, obs = pcall(self._adapter.observe, self._adapter)
    if ok and type(obs) == "table" then
      local agg = type(obs.aggregate) == "table" and obs.aggregate or nil
      self._observed = { available = obs.available and true or false, down = obs.down or {}, at = now, reason = obs.reason,
                         aggregate = agg and { maState = agg.maState, error = agg.error } or nil }
      local ma = agg and agg.maState
      for _, h in pairs(self._holds) do
        if h.state == "held" then
          if obs.available then
            local down = obs.down and obs.down[h.tupleKey] == true
            h.observed = { down = down, at = now }
            if not down and not h.observedReleasedAt then h.observedReleasedAt = now end
          elseif h.route and h.route.verify == "MASTATE" and type(ma) == "boolean" then
            h.observed = { aggregate = { source = "MASTATE", value = ma }, at = now,
                           note = ma and "MASTATE true: some Shift source is down; this does not identify ours" or "MASTATE false: no Shift key is down, so this key is up (not re-pressed)" }
            if ma == false then
              h.observed.down = false
              if not h.observedReleasedAt then h.observedReleasedAt = now end
            end
          end
        end
        -- Bounded readback after an MA press/release.
        local rb = h.readback
        if rb and rb.outcome == "pending" then
          if type(ma) == "boolean" and ma == rb.expect then
            rb.outcome, rb.value, rb.at = "observed", ma, now
            rb.note = rb.phase == "release" and "MASTATE false after the release: no Shift key is down (aggregate; consistent with the release, not a per-key confirmation)"
              or "MASTATE true after the press (aggregate: another Shift source could also set it)"
          elseif now >= rb.until_ then
            rb.outcome, rb.value, rb.at = "inconclusive", ma, now
            if type(ma) ~= "boolean" then
              rb.reason = "MASTATE was not readable during the readback window" .. (agg and agg.error and (": " .. tostring(agg.error)) or "")
            elseif rb.phase == "release" then
              rb.reason = string.format("MASTATE stayed true for %d ms after the release was dispatched; another Shift source may be held, so this is neither a confirmed release nor a definite failure", math.floor((now - rb.since) * 1000 + 0.5))
            else
              rb.reason = string.format("MASTATE stayed false for %d ms after the press was dispatched: no Shift key is down, so the press had no observable effect (the record stays owned; its release is harmless)", math.floor((now - rb.since) * 1000 + 0.5))
            end
          end
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
  local bdef = BACKENDS[self._backend] or self._adapter or {}
  local ex = self._state ~= "disposed" and self:_exclusiveHold() or nil
  return {
    module = NAME, version = VERSION, apiVersion = API_VERSION,
    owner = self._owner, state = self._state,
    inputEnabled = self._inputEnabled and true or false,
    backend = { name = self._backend, attached = self._adapter ~= nil, dispatches = (self._adapter and self._adapter.dispatches) and true or false,
                available = avail, missing = missing, description = bdef.description, limitations = bdef.limitations,
                displayScoped = false, perKeyObservation = self._observed and self._observed.available or false,
                counters = self._adapter and self._adapter.counters or nil },
    capacity = { maxHolds = self._config.maxHolds, used = self:_liveCount() },
    config = shallowCopy(self._config),
    sessions = sessions, sessionCount = count(sessions),
    holds = holds, holdCount = #holds, unresolved = unresolved,
    exclusiveHold = ex and ex.id or nil,
    observed = { available = self._observed and self._observed.available or false, down = observedDown, at = self._observed and self._observed.at,
                 error = self._observed and self._observed.error, reason = self._observed and self._observed.reason,
                 aggregate = self._observed and self._observed.aggregate or nil,
                 note = "console key state from the last service(); it is not ownership and is never used to re-press. aggregate.maState is any Shift source, not a per-key state" },
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
      rec.backend = h.backend or "unknown"
      rec.exclusive = h.exclusive or nil
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
  local ropts = { executor = opts and opts.executor }
  if type(d.keyboardCodes) == "function" then
    local okK, codes = pcall(d.keyboardCodes)
    if okK and type(codes) == "table" then ropts.keyboardCodes = codes end
  end
  -- The system redirect table is read only for the native route and only if the console offers it;
  -- an unreadable table leaves the route on the KB-01 evidence and is reported as redirectChecked=false.
  local key = type(name) == "string" and LOGICAL_KEYS[name:upper()] or nil
  if key and key.native and type(d.virtualKeyRedirects) == "function" then
    local okR, redirects = pcall(d.virtualKeyRedirects)
    if okR and type(redirects) == "table" then ropts.redirects = redirects end
  end
  local r = resolve(rows, vk, name, ropts)
  -- Enablement and profile identity are reported as read; a failed or non-boolean read leaves the value
  -- nil with the error, and the caller treats "not established" as not admissible for shortcut routes.
  if type(d.shortcutsActive) == "function" then
    local okA, active = pcall(d.shortcutsActive)
    if okA and type(active) == "boolean" then r.shortcutsActive = active
    else r.shortcutsActiveError = okA and ("value " .. tostring(active)) or tostring(active) end
  else
    r.shortcutsActiveError = "deps.shortcutsActive missing"
  end
  if type(d.profileName) == "function" then
    local okP, p = pcall(d.profileName)
    if okP then r.profile = p else r.profileError = tostring(p) end
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

-- Everything press()/tap()/combo() check before an event goes out, as a plan: { tuple, route, tupleKey,
-- maxHoldMs, exclusive } or { duplicate = <hold> } for the owner's harmless duplicate. ctx (combo):
-- reserved = tuples already planned in this combo, extra = how many records the combo will add before
-- this one (capacity). Nothing is dispatched here.
function Instance:_planPress(sessionId, now, spec, ctx)
  ctx = ctx or {}
  local tuple, route, terr = self:_resolveSpec(spec, true)
  if not tuple then return nil, terr end
  -- A route change during an existing hold stops every new interaction event until it is resolved.
  local mismatch = self:_checkRoutes()
  if mismatch then
    local m = mismatch[1]
    return fail("route-changed", string.format("a held key's route changed since it was pressed: %s %s (hold %s, session '%s', original %s); release or recover before new input (the operator restores the route; nothing is toggled here)",
      tostring(m.logical), tostring(m.mismatch), tostring(m.hold), tostring(self._holds[m.hold] and self._holds[m.hold].session), tostring(m.original.tupleKey)), { mismatches = mismatch })
  end
  local tk = tupleKey(tuple)
  if ctx.reserved and ctx.reserved[tk] then
    return fail("bad-argument", "tuple " .. tk .. " appears twice in the combo (key " .. ctx.reserved[tk] .. ")")
  end
  -- An exclusive hold (intended long-press) admits no new press from anyone, the owner included: a
  -- second key or a duplicate press cancels the console's long-press (KB-01).
  local ex = self:_exclusiveHold()
  if ex then
    return fail("exclusive-hold", string.format("hold %s (%s, session '%s', state %s) is an exclusive long-press; no new press is admitted until its release is resolved%s", ex.id, tostring(ex.logical or ex.tupleKey), ex.session, ex.state,
        ex.state == "unresolved" and (" (release unresolved: " .. tostring(ex.unresolved and ex.unresolved.reason) .. "; recover it)") or ""),
      { owner = ex.session, hold = ex.id, logical = ex.logical, tupleKey = ex.tupleKey, state = ex.state, deadlineInMs = ex.deadline and math.max(0, math.floor((ex.deadline - now) * 1000 + 0.5)) or nil })
  end
  local existing = self._byTuple[tk]
  if existing then
    if existing.session == sessionId and existing.state == "held" and not spec.exclusive then
      return { duplicate = existing }
    end
    if existing.session == sessionId and existing.state == "held" then
      return fail("exclusive-refused", "tuple " .. tk .. " is already held by this session; an exclusive long-press must start from a released key", { hold = existing.id })
    end
    return fail("conflict", string.format("tuple %s is already owned by session '%s' (state %s)%s", tk, existing.session, existing.state,
      existing.logical and (" as " .. existing.logical) or ""), { owner = existing.session, hold = existing.id, state = existing.state })
  end
  if spec.exclusive then
    if type(spec.exclusive) ~= "boolean" then return fail("bad-argument", "exclusive must be a boolean") end
    local live = self:_liveCount()
    if live > 0 or (ctx.extra or 0) > 0 then
      return fail("exclusive-refused", "cannot promise an uninterrupted long-press while " .. live .. " other ownership record(s) exist (held or unresolved); release or recover them first", { holds = live })
    end
  end
  if self:_liveCount() + (ctx.extra or 0) >= self._config.maxHolds then
    return fail("capacity", "no capacity: " .. self._config.maxHolds .. " ownership records exist or would exist (held or unresolved)", { maxHolds = self._config.maxHolds })
  end
  local maxHoldMs = spec.maxHoldMs or self._config.maxHoldMs
  if type(maxHoldMs) ~= "number" or maxHoldMs <= 0 or maxHoldMs > self._config.maxHoldMs then
    return fail("bad-argument", "maxHoldMs must be a number in (0, " .. self._config.maxHoldMs .. "]")
  end
  -- Backend preflight (Keyboard() present, key name valid, display exists, MASTATE readable for MA).
  if type(self._adapter.preflight) == "function" then
    local ok, accepted, reason = pcall(self._adapter.preflight, self._adapter, copyTuple(tuple), route)
    if not ok then return fail("unsupported", "backend preflight failed: " .. tostring(accepted)) end
    if not accepted then return fail("unsupported", "backend refuses " .. tk .. ": " .. tostring(reason)) end
  end
  return { tuple = tuple, route = route, tupleKey = tk, maxHoldMs = maxHoldMs, exclusive = spec.exclusive and true or false }
end

-- Creates the record and sends the press. The adapter contract decides the record's fate:
--   refused (ok=false)  -> nothing went down, the record is dropped
--   raised              -> delivery unknown, the record stays as unresolved (blocks the tuple, recover() releases)
--   ok                  -> held; confirmed is what the backend could observe (nil = not observable)
function Instance:_dispatchPress(s, plan, now)
  local hold = self:_newHold(s, plan.tuple, plan.route, now, now + plan.maxHoldMs / 1000, "max-hold")
  hold.exclusive = plan.exclusive
  local ok, aOk, confirmed, err = pcall(self._adapter.press, self._adapter, copyTuple(plan.tuple))
  if not ok then
    hold.dispatch.press = { ok = false, at = now, error = tostring(aOk) }
    self:_markUnresolved(hold, now, "press raised an error; whether the key went down is unknown: " .. tostring(aOk))
    return nil, { code = "press-failed", message = "press raised an error: " .. tostring(aOk), hold = hold.id, unresolved = true }
  end
  if aOk == false then
    hold.dispatch.press = { ok = false, at = now, error = tostring(err or confirmed) }
    self:_dropHold(hold)
    return nil, { code = "press-failed", message = "press was refused by the backend: " .. tostring(err or confirmed) }
  end
  hold.dispatch.press = { ok = true, confirmed = confirmed, at = now, outcome = confirmed == true and "confirmed" or "dispatched" }
  self:_scheduleReadback(hold, "press", true, now)
  self._pressCount = self._pressCount + 1
  return hold
end

-- Bounded aggregate readback for routes verified through MASTATE: service() watches the backend's
-- aggregate state for config.readbackMs and records what it saw next to the dispatch, separately from
-- the hold state. It never confirms a per-key release and never marks a release failed.
function Instance:_scheduleReadback(hold, phase, expect, now)
  if not (hold.route and hold.route.verify == "MASTATE") then return end
  local rb = { source = "MASTATE", phase = phase, expect = expect, since = now, until_ = now + self._config.readbackMs / 1000 }
  if not (self._adapter and type(self._adapter.observe) == "function") then
    rb.outcome, rb.reason = "unavailable", "the backend has no observe()"
  else
    rb.outcome = "pending"
  end
  hold.readback = rb
  hold.dispatch[phase].readback = rb
end

-- An exclusive record keeps the interaction lock until its release is RESOLVED: a refused or raised
-- release leaves the key possibly down, so the long-press is still in effect for everyone.
function Instance:_exclusiveHold()
  for _, h in pairs(self._holds) do
    if h.exclusive and h.state ~= "released" then return h end
  end
  return nil
end

-- Turns a press spec into a stored tuple plus the route it was resolved by. Nothing is dispatched.
-- forPress adds the backend's key check; release selectors skip it (the stored tuple is released).
function Instance:_resolveSpec(spec, forPress)
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
    -- Shortcut-backed keys need the table active; the fixed (MA) and native (PLEASE) routes do not.
    if r.source == "shortcut-table" and r.shortcutsActive == false then
      return nil, nil, { code = "unsupported", message = "logical key " .. r.key .. " routes through the shortcut table but keyboard shortcuts are inactive; the operator must enable them (never toggled here)", resolution = r }
    end
    if r.source == "shortcut-table" and r.shortcutsActive ~= true then
      return nil, nil, { code = "unsupported", message = "logical key " .. r.key .. " routes through the shortcut table but shortcut enablement cannot be established (" .. tostring(r.shortcutsActiveError or "unreadable") .. "); refused rather than guessed", resolution = r }
    end
    if forPress then
      local ok, err = self:_backendKeyCheck(r.pcKey)
      if not ok then return nil, nil, err end
    end
    local tuple = { pcKey = r.pcKey, shift = r.shift, ctrl = r.ctrl, alt = r.alt, numlock = spec.numlock and true or false, display = display }
    local route = { logical = r.key, source = r.source, shortcut = r.shortcut, rowIndex = r.rowIndex, executor = r.executor, profile = r.profile,
                    shortcutsActive = r.shortcutsActive, verify = r.verify, redirectChecked = r.redirectChecked, pcKeyValidated = r.pcKeyValidated }
    return tuple, route, nil
  end
  if type(spec.pcKey) ~= "string" or spec.pcKey == "" then return nil, nil, { code = "bad-argument", message = "spec needs key (logical name) or pcKey (non-empty PC key name)" } end
  if forPress then
    local ok, err = self:_backendKeyCheck(spec.pcKey)
    if not ok then return nil, nil, err end
  end
  local tuple = { pcKey = spec.pcKey, shift = spec.shift and true or false, ctrl = spec.ctrl and true or false, alt = spec.alt and true or false,
                  numlock = spec.numlock and true or false, display = display }
  return tuple, { source = "raw" }, nil
end

function Instance:_backendKeyCheck(pcKey)
  if self._adapter and type(self._adapter.supportsKey) == "function" then
    local ok, supported, reason = pcall(self._adapter.supportsKey, self._adapter, pcKey)
    if not ok then return nil, { code = "unsupported", message = "backend key check failed: " .. tostring(supported) } end
    if not supported then return nil, { code = "unsupported", message = tostring(reason or ("PC key " .. tostring(pcKey) .. " is not supported")) } end
  end
  return true
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
      elseif h.route.source == "shortcut-table" and r.shortcutsActive == nil then
        -- Unreadable enablement is not "unchanged": the route's validity cannot be established, so the
        -- hold stays unresolved rather than being reported released.
        why = "keyboard shortcut enablement cannot be established (" .. tostring(r.shortcutsActiveError or "unreadable") .. ")"
      elseif h.route.source == "shortcut-table" and r.shortcutsActive ~= h.route.shortcutsActive then
        why = "keyboard shortcuts are now " .. tostring(r.shortcutsActive and "active" or "inactive") .. " (were " .. tostring(h.route.shortcutsActive and "active" or "inactive") .. ")"
      elseif h.route.source == "shortcut-table" and h.route.profile ~= nil and r.profile == nil then
        why = "user profile identity cannot be established (" .. tostring(r.profileError or "unreadable") .. ")"
      elseif h.route.source == "shortcut-table" and r.profile ~= nil and h.route.profile ~= nil and r.profile ~= h.route.profile then
        -- Native and fixed routes do not depend on the profile's table; a shortcut-table route does.
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
  hold.backend = self._adapter and self._adapter.name or "none"
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
  local attempt = { hold = hold.id, session = hold.session, tupleKey = hold.tupleKey, logical = hold.logical, reason = reason, at = now }
  if not self._adapter or type(self._adapter.release) ~= "function" then
    -- No backend to dispatch through (input never enabled on this instance): the record stays
    -- unresolved and a later recover() with a backend attached picks it up.
    attempt.ok, attempt.error = false, "no backend attached; enable input and recover again"
    hold.dispatch.release = { ok = false, at = now, error = attempt.error, reason = reason }
    self:_markUnresolved(hold, now, attempt.error)
    attempt.state = "unresolved"
    return attempt
  end
  -- A record is only ever released through the backend that pressed it: a fake record must never
  -- become a real Keyboard() event, and a real hold cannot be "released" by the fake.
  local origin = hold.backend or "unknown"
  if origin ~= self._adapter.name then
    attempt.ok, attempt.error = false, string.format("record originates from backend '%s' but the attached backend is '%s'; not dispatched (attach the originating backend to release it)", origin, self._adapter.name)
    hold.dispatch.release = { ok = false, at = now, error = attempt.error, reason = reason }
    self:_markUnresolved(hold, now, attempt.error)
    attempt.state, attempt.outcome = "unresolved", "unresolved"
    return attempt
  end
  hold.state = "releasing"
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
    attempt.state, attempt.outcome = "unresolved", "unresolved"
  elseif attempt.confirmed == true or (attempt.confirmed == nil and not hold.routeMismatch) then
    hold.state = "released"
    hold.releasedAt = now
    hold.deadline = nil
    hold.unresolved = nil
    if self._byTuple[hold.tupleKey] == hold then self._byTuple[hold.tupleKey] = nil end
    attempt.state = "released"
    attempt.verified = attempt.confirmed == true
    -- "confirmed": the backend observed the key up. "dispatched": the call returned and nothing on this
    -- backend can observe the single key (Keyboard(); the aggregate MASTATE readback is separate).
    attempt.outcome = attempt.verified and "confirmed" or "dispatched"
    self:_scheduleReadback(hold, "release", false, now)
    attempt.readback = hold.readback
  else
    local why = attempt.confirmed == false and "release was dispatched but the backend reports the key still down"
      or ("release was dispatched with the stored tuple, but the route changed during the hold (" .. tostring(hold.routeMismatch and hold.routeMismatch.reason) .. ") and the effect cannot be confirmed")
    self:_markUnresolved(hold, now, why)
    attempt.state, attempt.outcome = "unresolved", "unresolved"
  end
  hold.dispatch.release.outcome = attempt.outcome
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
    if h.state == "held" or h.state == "unresolved" or h.state == "releasing" then
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
    tupleKey = h.tupleKey, route = h.route, backend = h.backend, pressedAt = h.pressedAt, releasedAt = h.releasedAt,
    deadline = h.deadline, deadlineReason = h.deadlineReason,
    exclusive = h.exclusive or nil, group = h.group, groupIndex = h.groupIndex,
    dispatch = h.dispatch, unresolved = h.unresolved, routeMismatch = h.routeMismatch, observed = h.observed,
    observedReleasedAt = h.observedReleasedAt, adopted = h.adopted, routeRestored = h.routeRestored,
    readback = h.readback,
    -- Flat copies for consumers with a bounded JSON depth (the bridge caps nesting).
    pressReadback = h.dispatch and h.dispatch.press and h.dispatch.press.readback or nil,
    releaseReadback = h.dispatch and h.dispatch.release and h.dispatch.release.readback or nil,
  }
  -- Result semantics spelled out: what the press did, and where the release stands.
  local dp, dr = h.dispatch and h.dispatch.press, h.dispatch and h.dispatch.release
  r.pressOutcome = dp and (dp.ok and (dp.outcome or (dp.confirmed == true and "confirmed" or "dispatched")) or "failed") or (h.adopted and "adopted" or "none")
  if h.state == "released" then r.releaseOutcome = dr and dr.outcome or (dr and dr.confirmed == true and "confirmed" or "dispatched")
  elseif h.state == "unresolved" then r.releaseOutcome = "unresolved"
  elseif h.state == "releasing" then r.releaseOutcome = "in-progress"
  elseif h.deadline then r.releaseOutcome = "scheduled"
  else r.releaseOutcome = "pending" end
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
  fakeBackend = fakeBackend, keyboardBackend = keyboardBackend,
  backends = { keyboard = BACKENDS.keyboard.name, fake = BACKENDS.fake.name },
  KEYBOARD_LIMITATIONS = KEYBOARD_LIMITATIONS,
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
