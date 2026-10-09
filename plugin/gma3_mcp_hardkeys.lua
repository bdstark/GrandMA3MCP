-- gma3_mcp_hardkeys.lua
--
-- Instance-based console input module for grandMA3 onPC plugins (KB-02 packaging phase).
--
-- What this file is:
--   A ComponentLua of a UserPlugin. The console runs this chunk once when the plugin is imported or
--   reloaded; the chunk only builds and returns a module table. It touches no console API, creates no
--   socket, timer or show object and sends no input when it is loaded or when an instance is created.
--   Consumers ship it as a ComponentLua of their own plugin (see docs/modules.md): the chunk registers
--   the module in the plugin's signal table, the entry component looks it up and calls new(). The
--   source travels inside the show file; no loose file is needed on the console.
--
-- What this version provides (MODULE API 1, module version 0.1.0):
--   * explicit instance lifecycle: new() -> init() -> service(now) ... -> dispose()
--   * status(): read-only instance report
--   * describeKey(name, opts): read-only resolution of a logical MA key to the PC key/modifier tuple the
--     operator's shortcut table currently maps it to (KB-01 contract), or an explicit "unsupported"
--   * backend adapter registry (only "keyboard" = the Keyboard() PC-key emulation; capability only)
--   No press/release/hold operation exists in this version. Owned input sessions, recovery and the
--   shortcut backend implementation are KB-03/KB-04; nothing here dispatches input.
--
-- Rules every consumer must keep:
--   * One instance per consumer. Instances never share mutable state; the module table is read-only.
--   * Pass console dependencies through opts.deps (consoleDeps(_G) builds them lazily). The module
--     never reads globals, so it can be exercised under a stock Lua interpreter.
--   * Do not store an instance in a global and do not publish this module through package.loaded or
--     require(): that cache is shared by every plugin in the console and survives re-import.

local NAME        = "gma3_mcp_hardkeys"
local VERSION     = "0.1.0"
local API_VERSION = 1

-- Logical keys accepted by describeKey(). Each resolves through the UserProfile KeyboardShortcut
-- table to the row whose KeyCode equals the named Enums.VirtualKeyCode, except MA, which is the
-- PC LeftShift key itself (KB-01 follow-up F2-F4; verified through Root().MASTATE).
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
    description = "Keyboard(): PC-key emulation routed through the operator's UserProfile shortcut table",
    requires = { "Keyboard" },
    inputOperations = false,   -- this module version exposes none
  },
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

-- Console dependency builder -------------------------------------------------

-- Returns closures over the console API. Nothing is called here; every read happens when a consumer
-- calls describeKey() or backendAvailable(). env defaults to the caller's globals.
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
  }
end

-- Instances -------------------------------------------------------------------

local Instance = {}
Instance.__index = Instance

local function checkLive(self, what)
  if self._state == "disposed" then error(NAME .. ": " .. what .. " on a disposed instance", 3) end
end

function Instance:init()
  checkLive(self, "init")
  if self._state == "created" then self._state = "ready" end
  return self
end

function Instance:status()
  local n = 0
  for _ in pairs(self._holds) do n = n + 1 end
  return {
    module = NAME, version = VERSION, apiVersion = API_VERSION,
    owner = self._owner, backend = self._backend, state = self._state,
    holds = n, serviced = self._serviced,
    inputOperations = false,
    note = "no input operation is available in this module version; describeKey() is read-only",
  }
end

-- Called once per plugin loop iteration by the consumer. Nothing to release in this version; the
-- return shape is fixed so KB-03 can report watchdog releases here without changing consumers.
function Instance:service(now)
  checkLive(self, "service")
  if self._state ~= "ready" then error(NAME .. ": service() before init()", 2) end
  self._serviced = self._serviced + 1
  self._lastServiced = now
  return { released = {} }
end

function Instance:dispose()
  if self._state == "disposed" then return { holds = 0, released = {} } end
  self._state = "disposed"
  self._holds = {}
  return { holds = 0, released = {} }
end

function Instance:backendAvailable()
  checkLive(self, "backendAvailable")
  local b = BACKENDS[self._backend]
  local missing = {}
  for _, fn in ipairs(b.requires) do
    if type(self._deps[fn]) ~= "function" then missing[#missing + 1] = fn end
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
  return r
end

local function new(opts)
  opts = opts or {}
  if type(opts.owner) ~= "string" or opts.owner == "" then error(NAME .. ".new: opts.owner (non-empty string) is required", 2) end
  local backend = opts.backend or "keyboard"
  if not BACKENDS[backend] then error(NAME .. ".new: unknown backend '" .. tostring(backend) .. "'", 2) end
  if opts.deps ~= nil and type(opts.deps) ~= "table" then error(NAME .. ".new: opts.deps must be a table", 2) end
  local self = setmetatable({
    _owner = opts.owner, _backend = backend, _deps = opts.deps or {},
    _state = "created", _holds = {}, _serviced = 0, _lastServiced = nil,
  }, Instance)
  return self
end

local M = {
  NAME = NAME, VERSION = VERSION, API_VERSION = API_VERSION,
  LOGICAL_KEYS = { "PLEASE", "STORE", "ESC", "CLEAR", "OOPS", "NUM0", "NUM1", "NUM2", "NUM3", "NUM4", "NUM5", "NUM6", "NUM7", "NUM8", "NUM9", "EXEC", "MA" },
  UNSUPPORTED_KEYS = { "MA1", "MA2" },
  new = new, consoleDeps = consoleDeps, resolve = resolve, parseShortcut = parseShortcut,
  backends = { keyboard = BACKENDS.keyboard.name },
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
