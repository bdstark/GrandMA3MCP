-- gma3_mcp_feedback.lua
--
-- Instance-based read-only console feedback module for grandMA3 onPC plugins (KB-02 packaging phase).
--
-- A ComponentLua of a UserPlugin: the console runs this chunk at import/reload and it only returns a
-- module table. Nothing is read from the console until a consumer calls read()/readAll() on an
-- instance. Readers are the state sources confirmed in KB-01; anything not confirmed is reported as
-- unavailable with a reason, never as a guessed false or zero.
--
-- MODULE API 1, module version 0.1.0. Lifecycle: new() -> init() -> read()/service() ... -> dispose().
-- Consumers pass dependencies via opts.deps (consoleDeps(_G) builds lazy closures) and keep one
-- instance each; the module table is read-only and nothing here uses globals or package.loaded.

local NAME        = "gma3_mcp_feedback"
local VERSION     = "0.1.0"
local API_VERSION = 1

local function toBool(v)
  if type(v) == "boolean" then return v end
  if v == "true" or v == "True" or v == 1 then return true end
  if v == "false" or v == "False" or v == 0 then return false end
  return v
end

-- Each reader: fn(deps, params) -> value. Scope says what the value belongs to (KB-01).
local READERS = {
  commandText    = { scope = "ui",      source = "CmdObj().cmdtext",      fn = function(d) return d.cmdObj().cmdtext end },
  lastCommand    = { scope = "ui",      source = "CmdObj().lastcommand",  fn = function(d) return d.cmdObj().lastcommand end },
  blind          = { scope = "show",    source = "ShowData.Masters.Grand.Blind.FADERENABLED",     fn = function(d) return toBool(d.showData().Masters.Grand.Blind:Get("FaderEnabled")) end },
  highlight      = { scope = "show",    source = "ShowData.Masters.Grand.Highlight.FADERENABLED", fn = function(d) return toBool(d.showData().Masters.Grand.Highlight:Get("FaderEnabled")) end },
  solo           = { scope = "show",    source = "ShowData.Masters.Grand.Solo.FADERENABLED",      fn = function(d) return toBool(d.showData().Masters.Grand.Solo:Get("FaderEnabled")) end },
  previewMode    = { scope = "profile", source = "CurrentProfile().Environments.ACTIVEENVIRONMENT", fn = function(d) return d.currentProfile().Environments:Get("ActiveEnvironment") end },
  previewBar     = { scope = "ui",      source = "Display 1 PREVIEWBARACTIVE", fn = function(d) return toBool(d.display():Get("PreviewBarActive")) end },
  shortcutsActive= { scope = "profile", source = "CurrentProfile().KeyboardShortCuts.KEYBOARDSHORTCUTSACTIVE", fn = function(d) return toBool(d.currentProfile().KeyboardShortCuts:Get("KeyboardShortcutsActive")) end },
  maState        = { scope = "console", source = "Root().MASTATE (observed state, not ownership)", fn = function(d) return toBool(d.root():Get("MAState")) end },
  page           = { scope = "user",    source = "CurrentExecPage()", fn = function(d)
                       local p = d.currentExecPage()
                       if p == nil then return nil end
                       return { name = tostring(p.name), no = tonumber(p:Get("No")) or tonumber(p.index) }
                     end },
  executorActive = { scope = "show", source = "Sequence:HasActivePlayback()", params = { "sequence" }, fn = function(d, params)
                       local n = params and params.sequence
                       if type(n) ~= "number" then error("params.sequence (number) is required") end
                       local seq = d.sequence(n)
                       if seq == nil then error("sequence " .. n .. " not found") end
                       return toBool(seq:HasActivePlayback())
                     end },
  freeze         = { scope = "show", source = nil, unavailable = "no readable Freeze state was found in KB-01; this is not a false value" },
}

local READER_NAMES = {}
for k in pairs(READERS) do READER_NAMES[#READER_NAMES + 1] = k end
table.sort(READER_NAMES)

-- Every caller gets its own copy: the internal list is never exposed, so a consumer that edits the
-- table it received cannot change what another instance reads (the outer read-only wrapper only
-- protects the module table itself, not nested tables).
local function readerNames()
  local out = {}
  for i, n in ipairs(READER_NAMES) do out[i] = n end
  return out
end

local function consoleDeps(env)
  env = env or _G
  return {
    cmdObj = function() return env.CmdObj() end,
    showData = function() return env.ShowData() end,
    currentProfile = function() return env.CurrentProfile() end,
    root = function() return env.Root() end,
    currentExecPage = function() return env.CurrentExecPage() end,
    display = function() return env.GetDisplayByIndex(1) end,
    sequence = function(n) local list = env.ObjectList("Sequence " .. tostring(n)); return list and list[1] end,
  }
end

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
  return { module = NAME, version = VERSION, apiVersion = API_VERSION, owner = self._owner, state = self._state,
           reads = self._reads, serviced = self._serviced, readers = readerNames() }
end

function Instance:service(now)
  checkLive(self, "service")
  if self._state ~= "ready" then error(NAME .. ": service() before init()", 2) end
  self._serviced = self._serviced + 1
  self._lastServiced = now
  return {}
end

function Instance:dispose()
  self._state = "disposed"
  return {}
end

function Instance:readers() return readerNames() end

-- Returns { name, scope, source, available, value | error }. A reader that throws reports the error
-- and available=false; it never substitutes a default value.
function Instance:read(name, params)
  checkLive(self, "read")
  if self._state ~= "ready" then error(NAME .. ": read() before init()", 2) end
  local r = READERS[name]
  if not r then return { name = tostring(name), available = false, error = "unknown reader; see readers()" } end
  self._reads = self._reads + 1
  if r.unavailable then return { name = name, scope = r.scope, available = false, reason = r.unavailable } end
  local ok, v = pcall(r.fn, self._deps, params)
  if not ok then return { name = name, scope = r.scope, source = r.source, available = false, error = tostring(v) } end
  return { name = name, scope = r.scope, source = r.source, available = v ~= nil, value = v,
           reason = (v == nil) and "the console returned nothing for this property" or nil }
end

-- Every parameterless reader, keyed by name.
function Instance:readAll()
  checkLive(self, "readAll")
  local out = {}
  for _, name in ipairs(READER_NAMES) do
    if not READERS[name].params then out[name] = self:read(name) end
  end
  return out
end

local function new(opts)
  opts = opts or {}
  if type(opts.owner) ~= "string" or opts.owner == "" then error(NAME .. ".new: opts.owner (non-empty string) is required", 2) end
  if opts.deps ~= nil and type(opts.deps) ~= "table" then error(NAME .. ".new: opts.deps must be a table", 2) end
  return setmetatable({ _owner = opts.owner, _deps = opts.deps or {}, _state = "created", _reads = 0, _serviced = 0 }, Instance)
end

local M = { NAME = NAME, VERSION = VERSION, API_VERSION = API_VERSION, READERS = readerNames(), new = new, consoleDeps = consoleDeps }

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
