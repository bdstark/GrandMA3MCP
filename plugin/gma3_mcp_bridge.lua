-- gma3_mcp_bridge.lua
--
-- JSON-lines over TCP bridge between grandMA3 onPC and the gma3-mcp server.
-- Runs inside the console's Lua engine. Uses the LuaSocket and JSON libraries
-- that ship with grandMA3 (shared/resource/lib_plugins/requirements).
--
-- Usage from the command line:
--   Plugin "gma3_mcp_bridge"            start on the default port (9800)
--   Plugin "gma3_mcp_bridge" "9801"     start on a custom port
--   Plugin "gma3_mcp_bridge" "stop"     stop the bridge
--   Plugin "gma3_mcp_bridge" "status"   print status
--
-- Arbitrary Lua execution (the "lua" op behind the gma3_lua tool) is OFF by default and is
-- enabled per start, or toggled while running, by the console operator:
--   Plugin "gma3_mcp_bridge" "lua"              start with Lua execution enabled
--   Plugin "gma3_mcp_bridge" "9801 lua"         custom port and Lua execution enabled
--   Plugin "gma3_mcp_bridge" "lua on"           enable while running
--   Plugin "gma3_mcp_bridge" "lua off"          disable while running
--   Plugin "gma3_mcp_bridge" "lua luatime=2000 luasteps=5000000"
--                                               enable with a 2 s / 5 M VM-instruction budget per request
--   Plugin "gma3_mcp_bridge" "lua luahook=replace"
--                                               enforce the budget even over the console's own hook
--
-- Owned input sessions (KB-03/KB-04) are OFF by default too and enabled per start, or toggled while running:
--   Plugin "gma3_mcp_bridge" "input=keyboard"   admit input.* ops on the KEYBOARD backend: console keys
--                                               are really pressed through Keyboard() (KB-04)
--   Plugin "gma3_mcp_bridge" "input=fake"       admit input.* ops on the FAKE backend (records events,
--                                               touches no key; lifecycle testing only)
--   Plugin "gma3_mcp_bridge" "input=quickey"    admit input.* ops on the owned-QUICKEY backend (KB-13,
--                                               bridge 0.10.0 / hardkeys 0.8.0): logical keys are routed
--                                               with the quickkey method through the KB-12 bank (bank=...
--                                               first or in the same argument); each tap, hold and chord
--                                               is an executor press of the code's owned Quickey. Only
--                                               the KB-10 qualified codes dispatch; no PC keys, no text.
--   Plugin "gma3_mcp_bridge" "input=mixed"      admit input.* ops on the MIXED backend (KB-15, bridge
--                                               0.12.0 / hardkeys 0.10.0): the quickkey default of
--                                               input=quickey plus the Keyboard() part for per-key
--                                               overrides (input.routing: shortcut, shortcutOrType, type)
--                                               on one instance. Each record is released through the part
--                                               that pressed it; both kinds are never down at once and the
--                                               shortcut mode is never changed while a Quickey is down
--                                               (unqualified-mix refusals). An unavailable Quickey route
--                                               never falls back to Keyboard().
--   Plugin "gma3_mcp_bridge" "input=off"        stop admitting input; attempt to release every held key
--   Plugin "gma3_mcp_bridge" "input status"     print sessions, holds and unresolved releases
--   Plugin "gma3_mcp_bridge" "input recover"    operator recovery: re-attempt every unresolved release,
--                                               including records kept from a previous run. With no
--                                               backend attached it attaches the records' own backend
--                                               for cleanup only; input stays disabled.
-- Continuous control (KB-18, bridge 0.14.0 / gma3_mcp_control 0.1.0; KB-19, bridge 0.15.0 / control
-- 0.2.0; KB-20, bridge 0.16.0 / control 0.3.0) is OFF by default and enabled per start, or toggled while running. It admits the control.* ops:
-- encoder motion, strip positions, touches and encoder buttons from a surface, each stamped with the
-- feedback module's binding generation and admitted, ordered, coalesced and bounded by the control
-- module before a backend applies them:
--   Plugin "gma3_mcp_bridge" "control=fake"     admit control.* ops on the FAKE backend (intents are
--                                               recorded, nothing moves on the console)
--   Plugin "gma3_mcp_bridge" "control=console"  admit them on the CONSOLE backend (KB-19): relative
--                                               motion on an attribute slot of the bound display is
--                                               applied as  Attribute "<name>" At +/- <detents x step>
--                                               for the selection (Percent/PercentFine readout, Coarse
--                                               1 / Fine 0.1 per detent, fine gesture /10); a strip touch
--                                               (KB-20) is a hold that reserves the slot and moves
--                                               nothing; a strip position is  Attribute "<name>" At <value>
--                                               over the verified travel (mixed values need takeover);
--                                               presses and executors are refused unsupported
--   Plugin "gma3_mcp_bridge" "control=off"      stop admitting; end every gesture, drop queued motion
--   Plugin "gma3_mcp_bridge" "control status"   print sessions, gestures, queues and unresolved releases
--   Plugin "gma3_mcp_bridge" "control recover"  re-attempt the unresolved touch/button releases
-- Quickey bank (KB-12, bridge 0.9.0 / hardkeys 0.7.0): the operator provisions the owned Quickeys and the
-- reserved executors the Quickey dispatch of KB-13 will use. It is the only path that creates or deletes
-- show objects, and it is a plugin argument, never a client request:
--   Plugin "gma3_mcp_bridge" "bank=900/1.190-197"   one Quickey per command-area hardkey code from
--                                               Quickey 900 upwards, executors 190-197 of page 1 reserved
--                                               (the executor count must cover the hold capacity, 8).
--                                               "bank=900/1.190" reserves 8 executors from 190.
--                                               Add "bankcodes=qualified" to provision only the codes
--                                               with KB-10 evidence (default: every command-area code,
--                                               each reported qualified or discovered).
--   Plugin "gma3_mcp_bridge" "bank status"      print the bank: codes, slots, executors, problems
--   Plugin "gma3_mcp_bridge" "bank verify"      re-read every owned object and report what changed
--   Plugin "gma3_mcp_bridge" "bank teardown"    delete the verified owned Quickeys and clear their
--                                               executors (refused while Quickey records are live)
-- An existing bank of this bridge (same ranges) is verified and reused; another plugin's bank or any
-- unowned object in the range refuses the whole setup and nothing is created. The bank record survives
-- a bridge restart (like unresolved records) and is re-verified at the next start, never trusted blindly.
-- Per-key routing and KB-14 (bridge 0.11.0 / hardkeys 0.9.0): a connection may replace the routing
-- policy for the attached backend with "input.routing" ({ policy = { default, keys = { KEY = { method,
-- quickkey, prefer, text } } } }; no policy = report only) and inspect a key with "input.route" ({ key,
-- prefer, executor }). The methods shortcut (temporary enable of the shortcut table for a hold),
-- shortcutOrType and type (text inserted once on press with shortcuts temporarily disabled) change the
-- operator's keyboard-shortcut mode for a bounded operation and restore it one restore delay after the
-- last dependent key event; status reports it (input.status: status.modeChange, ping.input.modeChange).
-- A restoration that cannot be verified (profile switched, state unreadable, write without effect) is
-- kept as unresolved: every new press is refused and the guarded ops report [busy] (reason
-- "restoration") until the owner's input.recover or the operator's "input recover" re-reads and
-- restores it on the original profile. Like unresolved records, an unresolved restoration survives a
-- bridge restart (state.input.mode) and is adopted at the next start.
-- Every held key belongs to a session bound to the TCP connection that opened it; a client can only
-- act on its own session, and a disconnect, lease expiry, "input=off", stop or Cleanup attempts to
-- release what that session still holds. A release that fails or cannot be confirmed is kept as an
-- unresolved record (visible in input.status / ping.input) until "input recover" succeeds. Records
-- remember the backend that pressed them; a fake record is never released through Keyboard().
-- Structured input (KB-05, bridge 0.7.0 / hardkeys 0.4.0): a connection begins a leased INTERACTION
-- ("input.begin", renewed with "input.extend", ended with "input.end") before it may hold a key
-- ("input.press", "input.combo" without holdMs carry its id); bounded taps and "input.sequence"
-- (taps, presses, releases, combos, text, waits serviced by the loop; "input.sequence.status" polls
-- it) may run without one and own an interaction for their duration. While an interaction is open,
-- a sequence runs or any key is held, the mutating ops "cmd", "set", "setfader" and "lua" from EVERY
-- connection are refused with [busy] instead of being delayed into a changed context; reads,
-- "input.status" and the owner's releases/recovery stay available. Text ("text" steps) is UTF-8
-- iterated by code point, refuses control characters and needs an explicit context (command line
-- with shortcuts disabled by the operator, or an acknowledged text field); it never presses Enter.
-- Errors carry "[code] message" in "error", plus "code" and a structured "detail" (partial progress,
-- owner, remaining lease) when the module reported one.
-- Arguments are whitespace separated tokens; "luatime" is milliseconds of wall-clock time and
-- "luasteps" a count of Lua VM instructions (0 = unlimited). A request that exceeds its budget is
-- aborted with an error so the bridge loop (and the console) regain control. The budget is
-- enforced with a debug hook installed on the plugin thread while the chunk runs (the chunk
-- must run on that thread: grandMA3 binds the plugin context to it and context-bound functions
-- such as ObjectList return nothing from a child coroutine), plus deadline checks after every
-- yield; the script runs in an environment that withholds debug.sethook and hooks coroutines it
-- creates. It is a best-effort guard against runaway scripts, not a sandbox: it cannot interrupt
-- a C function such as Cmd() that blocks, and a script that sets out to escape still can (Lua on
-- the console has os/io anyway). Only Lua submitted through the "lua" op is budgeted; the
-- structured ops are not. The console keeps its own hook on the plugin thread (an external C
-- hook on 2.5.1) whose purpose MA does not document. By default (luahook=preserve) it is left
-- alone and the instruction budget is then NOT enforced: only the deadline is checked when the
-- chunk yields or returns, so a busy loop cannot be stopped. "luahook=replace" installs the
-- budget hook over it for the duration of the chunk; the console's hook cannot be re-created
-- from Lua and is gone until the plugin restarts. ping reports both under lua.consoleHook /
-- lua.hookMode / lua.bounded, and every lua result carries a budget.instructionHookEnforced flag.
--
-- The bridge only ever listens on 127.0.0.1. It has no authentication, so it is never exposed
-- to the network; a "<host>:<port>" argument is rejected. For remote access forward the port
-- over SSH (see README.md, "Remote access over SSH").
--
-- Protocol (one JSON document per line, both directions):
--   request  {"id": "<any>", "op": "<name>", "args": {...}}
--   response {"id": "<any>", "ok": true, "result": ...}
--            {"id": "<any>", "ok": false, "error": "..."}

local pluginName    = select(1, ...)
local componentName = select(2, ...)
local signalTable   = select(3, ...)
local my_handle     = select(4, ...)

local socket = require("socket")
local json   = require("json")

local VERSION      = "0.16.0"
local DEFAULT_PORT = 9800
-- Execution policy defaults for the "lua" op (see header). Changed per start with the
-- "luatime=<ms>" / "luasteps=<n>" tokens, or at runtime with "lua on|off".
local LUA_DEFAULT_ENABLED   = false
local LUA_DEFAULT_MAX_MS    = 5000
local LUA_DEFAULT_MAX_STEPS = 20000000
-- What to do with a hook the console itself keeps on the plugin thread (an external C hook on
-- onPC 2.5.1). "preserve" (default) leaves it alone: a chunk then runs without the instruction
-- hook and only the wall-clock deadline is checked, at yields and at return, so a busy loop cannot
-- be stopped. "replace" installs the budget hook over it for the duration of the chunk; the
-- console's hook cannot be re-created from Lua and is gone until the plugin restarts.
local LUA_DEFAULT_HOOK_MODE = "preserve"
local LUA_HOOK_INTERVAL     = 1000   -- VM instructions between budget checks
local BIND_HOST    = "127.0.0.1"  -- fixed: the bridge is unauthenticated and must never leave loopback
local MAX_DEPTH    = 6

-- State survives repeated Plugin calls (file-level locals are re-created on ReloadAllPlugins only).
_G.__gma3_mcp_bridge = _G.__gma3_mcp_bridge or { running = false, host = BIND_HOST, port = DEFAULT_PORT, server = nil, clients = {}, requests = 0 }
local state = _G.__gma3_mcp_bridge
-- Lua execution policy (older state tables from before 0.2.0 do not have it).
state.lua = state.lua or { enabled = LUA_DEFAULT_ENABLED, maxMs = LUA_DEFAULT_MAX_MS, maxSteps = LUA_DEFAULT_MAX_STEPS, hookMode = LUA_DEFAULT_HOOK_MODE }
state.lua.hookMode = state.lua.hookMode or LUA_DEFAULT_HOOK_MODE
-- Loaded console interaction modules (KB-02); filled in by loadModules() at every start.
state.modules = state.modules or {}
-- Owned input policy (KB-03). enabled/backend reset at every start like the Lua policy; "unresolved"
-- keeps the release records a previous run could not resolve so "input recover" can act on them.
state.input = state.input or { enabled = false, backend = nil, unresolved = {} }
state.input.unresolved = state.input.unresolved or {}
-- Continuous-control policy (KB-18): enabled/backend/spec reset at every start; "unresolved" keeps the
-- touch/button releases a previous run could not resolve for "control recover".
state.control = state.control or { enabled = false, backend = nil, unresolved = {}, spec = nil }
state.control.unresolved = state.control.unresolved or {}
state.nextClientId = state.nextClientId or 0

-- Log to the System Monitor (Echo), the Command Line History (Printf) and a log file in the temp folder.
local function logFile()
  local ok, p = pcall(function() return GetPath(Enums.PathType.Temp) end)
  if ok and type(p) == "string" and p ~= "" then return p .. "/gma3_mcp_bridge.log" end
  return nil
end

local function appendLog(line)
  local path = logFile()
  if not path then return end
  local f = io.open(path, "a")
  if f then
    f:write(os.date("%Y-%m-%d %H:%M:%S "), line, "\n")
    f:close()
  end
end

local function log(fmt, ...)
  local msg = string.format("MCP Bridge: " .. fmt, ...)
  Echo(msg)
  pcall(Printf, msg)
  appendLog(msg)
end

local function logerr(fmt, ...)
  local msg = string.format("MCP Bridge: " .. fmt, ...)
  ErrEcho(msg)
  pcall(ErrPrintf, msg)
  appendLog("ERROR " .. msg)
end

-------------------------------------------------------------------------------
-- Value conversion (Lua -> JSON-safe)
-------------------------------------------------------------------------------

local function isHandle(v)
  return type(v) == "userdata" or type(v) == "lightuserdata"
end

local function safeCall(obj, method, ...)
  local f = obj[method]
  if type(f) ~= "function" then return nil end
  local ok, res = pcall(f, obj, ...)
  if ok then return res end
  return nil
end

local function safeProp(obj, name)
  local ok, res = pcall(function() return obj[name] end)
  if ok then return res end
  return nil
end

-- Short description of an object handle.
local function handleSummary(h)
  if not h then return nil end
  local ok, valid = pcall(IsObjectValid, h)
  if ok and valid == false then return { invalid = true } end
  local s = {}
  s.name       = safeProp(h, "name")
  s.class      = safeCall(h, "GetClass")
  s.addr       = safeCall(h, "Addr")
  s.addrNative = safeCall(h, "AddrNative")
  s.index      = safeCall(h, "Index")
  s.childCount = safeCall(h, "Count")
  return s
end

local toJsonSafe
toJsonSafe = function(v, depth, seen)
  depth = depth or 0
  seen = seen or {}
  local t = type(v)
  if t == "nil" or t == "boolean" or t == "string" then return v end
  if t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return nil end
    return v
  end
  if isHandle(v) then return handleSummary(v) end
  if t == "function" then return "<function>" end
  if t == "thread" then return "<thread>" end
  if t == "table" then
    if seen[v] then return "<cycle>" end
    if depth >= MAX_DEPTH then return "<table: max depth>" end
    seen[v] = true
    -- array-like?
    local n = 0
    for k in pairs(v) do
      n = n + 1
      if type(k) ~= "number" or k < 1 or math.floor(k) ~= k then n = -1; break end
    end
    local out
    if n >= 0 and n == #v then
      out = {}
      for i = 1, #v do out[i] = toJsonSafe(v[i], depth + 1, seen) end
      if #out == 0 then setmetatable(out, { __jsontype = "array" }) end
    else
      out = {}
      for k, val in pairs(v) do
        local key = type(k) == "string" and k or tostring(k)
        out[key] = toJsonSafe(val, depth + 1, seen)
      end
    end
    seen[v] = nil
    return out
  end
  return tostring(v)
end

local function encode(value)
  local ok, res = pcall(json.encode, value)
  if ok then return res end
  -- fallback: encode as string
  return json.encode({ encodeError = tostring(res), text = tostring(value) })
end

-------------------------------------------------------------------------------
-- Object helpers
-------------------------------------------------------------------------------

-- Resolve an object reference to a handle.
--   "14.14.1.6.1"            numeric address (FromAddr)
--   "Sequence 1 Cue 3"       command-line object syntax (ObjectList)
--   "Root"                   root
--   "DataPool"/"ShowData"    convenience names
local function resolve(ref)
  if ref == nil or ref == "" then error("missing object reference") end
  if type(ref) ~= "string" then ref = tostring(ref) end
  local lower = ref:lower()
  if lower == "root" then return Root() end
  if lower == "showdata" then return ShowData() end
  if lower == "datapool" then return DataPool() end
  if lower == "selectedsequence" then return SelectedSequence() end
  if lower == "currentcue" then return GetCurrentCue() end
  if lower == "patch" then return Patch() end
  if lower == "programmer" then return Programmer() end
  if lower == "selection" then return Selection() end
  if lower == "currentexecpage" then return CurrentExecPage() end
  if lower == "showsettings" then return ShowSettings() end
  if lower == "masterpool" then return MasterPool() end
  if lower == "fixturetype" then return FixtureType() end
  if ref:match("^%d+[%d%.]*$") then
    local h = FromAddr(ref)
    if not h then error("no object at address " .. ref) end
    return h
  end
  -- dotted navigation from a known root: "DataPool.Sequences", "Root.ShowData.Patch", "Patch.Fixtures"
  local head, rest = ref:match("^(%a+)%.(.+)$")
  if head then
    local roots = { root = Root, showdata = ShowData, datapool = DataPool, patch = Patch, showsettings = ShowSettings,
                    programmer = Programmer, selectedsequence = SelectedSequence, currentexecpage = CurrentExecPage,
                    masterpool = MasterPool }
    local rootFn = roots[head:lower()]
    if rootFn then
      local h = rootFn()
      for part in rest:gmatch("[^%.]+") do
        if h == nil then break end
        local idx = tonumber(part)
        local nextH
        if idx then
          nextH = h:Ptr(idx)
        else
          local okP, v = pcall(function() return h[part] end)
          nextH = okP and v or nil
          if nextH == nil then
            local okF, f = pcall(h.Find, h, part)
            if okF then nextH = f end
          end
        end
        h = nextH
      end
      if h == nil or not isHandle(h) then error("path not found: " .. ref) end
      return h
    end
  end
  local list = ObjectList(ref)
  if list == nil or list[1] == nil then error("no object found for '" .. ref .. "'") end
  return list[1]
end

local function resolveMany(ref)
  if type(ref) == "string" and ref:match("^%d+[%d%.]*$") then
    return { resolve(ref) }
  end
  if type(ref) == "string" and ref:lower():match("^[a-z]+$") then
    local ok, h = pcall(resolve, ref)
    if ok and h then return { h } end
  end
  local list = ObjectList(ref)
  if list == nil then error("no objects found for '" .. tostring(ref) .. "'") end
  return list
end

local function roleEdit()
  if Enums and Enums.Roles and Enums.Roles.Edit then return Enums.Roles.Edit end
  return nil
end

-- Read a single property as a JSON-safe value.
local function getProp(h, name, asText)
  local role = asText and roleEdit() or nil
  local ok, v
  if role then
    ok, v = pcall(h.Get, h, name, role)
  else
    ok, v = pcall(h.Get, h, name)
  end
  if not ok then return nil, tostring(v) end
  -- A name that is a method rather than a property ("Count", "Delete") comes back as the method
  -- itself. It is never called: a read-only op must not be able to invoke arbitrary methods.
  if type(v) == "function" then return nil, "'" .. tostring(name) .. "' is a method, not a property" end
  if isHandle(v) then return handleSummary(v) end
  if type(v) == "string" then
    -- "#00000B9A" style values are object references: resolve them to a name when possible
    if v:match("^#%x+$") then
      local okH, hv = pcall(h.Get, h, name)
      if okH and isHandle(hv) then
        local nm = safeProp(hv, "name")
        if nm then return nm end
      end
    end
    return (v:gsub("^%s+", ""):gsub("%s+$", ""))
  end
  return v
end

-- Enumerate property names (robust to 0- or 1-based indexing).
local function propertyNames(h)
  local names, seen = {}, {}
  local n = safeCall(h, "PropertyCount") or 0
  for i = 0, n do
    local ok, name = pcall(h.PropertyName, h, i)
    if ok and type(name) == "string" and name ~= "" and not seen[name] then
      seen[name] = true
      local info = { name = name, index = i }
      local okT, ptype = pcall(h.PropertyType, h, i)
      if okT then info.type = ptype end
      local okI, pinfo = pcall(h.PropertyInfo, h, i)
      if okI and type(pinfo) == "table" then
        info.readOnly = pinfo.ReadOnly
        if pinfo.EnumCollection and pinfo.EnumCollection ~= "" then info.enum = pinfo.EnumCollection end
      end
      table.insert(names, info)
    end
  end
  return names
end

local function objectProperties(h, asText)
  local props = {}
  for _, info in ipairs(propertyNames(h)) do
    local v, err = getProp(h, info.name, asText)
    if err then
      props[info.name] = { error = err }
    else
      props[info.name] = v
    end
  end
  return props
end

local function childSummary(c, fields, asText, playback)
  local s = handleSummary(c)
  if playback then
    pcall(function() s.hasActivePlayback = c:HasActivePlayback() end)
  end
  if fields and #fields > 0 then
    s.fields = {}
    for _, f in ipairs(fields) do
      local v = getProp(c, f, asText)
      s.fields[f] = v
    end
  end
  return s
end

local function listChildren(h, fields, limit, offset, asText, playback)
  local children = safeCall(h, "Children") or {}
  local total = #children
  offset = tonumber(offset) or 0
  limit = tonumber(limit) or 200
  local out = {}
  for i = offset + 1, math.min(total, offset + limit) do
    table.insert(out, childSummary(children[i], fields, asText, playback))
  end
  if #out == 0 then setmetatable(out, { __jsontype = "array" }) end
  return { total = total, offset = offset, count = #out, items = out }
end

-------------------------------------------------------------------------------
-- Fixture, channel and cue inspection helpers (FR-07 .. FR-10)
-------------------------------------------------------------------------------
-- Everything here runs on the plugin thread like the other structured ops (the console's
-- context-bound functions return nothing from a child coroutine) and only ever reads. Nothing
-- below changes the selection, the programmer or any playback. The console's JSON library
-- cannot carry nil inside a table, so a metadata item the API did not supply is simply absent
-- from the emitted object; the TypeScript tools turn absent keys into explicit nulls.

-- Call a console function by name if this console version provides it.
-- Returns ok (boolean) and the result or an error text.
local function callApi(name, ...)
  local okG, f = pcall(function() return _G[name] end)
  if not okG or type(f) ~= "function" then return false, "function " .. name .. " is not available in this console version" end
  local ok, res = pcall(f, ...)
  if not ok then return false, tostring(res) end
  return true, res
end

-- Property as display text (nil when unreadable or empty); handle-valued properties give their name.
local function textProp(h, name)
  if not h then return nil end
  local v = getProp(h, name, true)
  if type(v) == "table" then return v.name end
  if v == "" then return nil end
  return v
end

-- Leading number of a numeric property ("-225.0000000000" -> -225), nil when not numeric.
local function numProp(h, name)
  local v = textProp(h, name)
  if v == nil then return nil end
  if type(v) == "number" then return v end
  return tonumber((tostring(v):match("^%s*([-+]?%d*%.?%d+)")))
end

-- Handle-valued property as a handle (nil when the property is not a handle).
local function handleProp(h, name)
  if not h then return nil end
  local ok, v = pcall(h.Get, h, name)
  if ok and isHandle(v) then return v end
  return nil
end

local function yesNo(text)
  if text == nil then return nil end
  local l = tostring(text):lower()
  if l == "yes" or l == "1" or l == "true" or l == "on" then return true end
  if l == "no" or l == "0" or l == "false" or l == "off" then return false end
  return nil
end

local function round4(x) return math.floor(x * 10000 + 0.5) / 10000 end

local function emptyArray(t)
  if #t == 0 then setmetatable(t, { __jsontype = "array" }) end
  return t
end

-- Bounded pagination: limit/offset from args with defaults and a hard ceiling.
local function pageArgs(args, defaultLimit, maxLimit)
  local limit = tonumber(args.limit) or defaultLimit
  if limit < 1 then limit = 1 end
  if maxLimit and limit > maxLimit then limit = maxLimit end
  local offset = tonumber(args.offset) or 0
  if offset < 0 then offset = 0 end
  return math.floor(limit), math.floor(offset)
end

local function paginate(rows, limit, offset)
  local out = {}
  for i = offset + 1, math.min(#rows, offset + limit) do out[#out + 1] = rows[i] end
  return { total = #rows, offset = offset, count = #out, items = emptyArray(out) }
end

-- Compact reference to a preset (or any) handle; nil for an invalid or missing handle.
local function presetRef(h)
  if not isHandle(h) then return nil end
  local ok, valid = pcall(IsObjectValid, h)
  if ok and valid == false then return nil end
  local ref = { name = safeProp(h, "name"), addrNative = safeCall(h, "AddrNative") }
  if ref.name == nil and ref.addrNative == nil then return nil end
  return ref
end

-- Resolve a fixture reference ("Fixture 601", "Fixture 501.3") through ObjectList, i.e. by
-- fixture ID, never by patch index. Returns the handle and the owning Fixture (the handle
-- itself unless it is a SubFixture).
local function resolveFixture(ref)
  local h = resolve(ref)
  local cls = safeCall(h, "GetClass")
  if cls ~= "Fixture" and cls ~= "SubFixture" then
    error(string.format("'%s' resolved to a %s, not a Fixture or SubFixture", tostring(ref), tostring(cls)))
  end
  local main, guard = h, 0
  while safeCall(main, "GetClass") == "SubFixture" and guard < 8 do
    local p = safeCall(main, "Parent")
    if not p then break end
    main, guard = p, guard + 1
  end
  return h, main
end

local function fixtureIdentity(fx, main)
  local id = {
    name = safeProp(fx, "name"), class = safeCall(fx, "GetClass"), addr = safeCall(fx, "Addr"),
    fid = textProp(main, "FID"), cid = textProp(main, "CID"),
    subfixtureIndex = numProp(fx, "SubfixtureIndex"),
    isSubfixture = fx ~= main,
    patch = textProp(main, "Patch"), rtChannelCount = numProp(main, "ChannelRTCount"),
  }
  if fx ~= main then id.fixture = safeProp(main, "name") end
  local ft = handleProp(main, "FixtureType")
  if ft then id.fixtureType = safeProp(ft, "name") else id.fixtureType = textProp(main, "FixtureType") end
  local mode = handleProp(main, "Mode")
  if mode then id.mode = safeProp(mode, "name") else id.mode = textProp(main, "Mode") end
  return id
end

-- Direct SubFixture children of a (sub)fixture, with their patch indices.
local function listSubfixtures(fx)
  local out = {}
  for _, c in ipairs(safeCall(fx, "Children") or {}) do
    if safeCall(c, "GetClass") == "SubFixture" then
      out[#out + 1] = { name = safeProp(c, "name"), index = safeCall(c, "Index"), subfixtureIndex = numProp(c, "SubfixtureIndex"), addr = safeCall(c, "Addr"), childCount = safeCall(c, "Count") }
    end
  end
  return emptyArray(out)
end

-- Patch indices (SubfixtureIndex) of a fixture and everything nested in it (SubFixtures and
-- fixtures inside a grouping fixture), depth-bounded.
local function collectSubfixtureIndices(h, out, seen, depth, limitations)
  if depth > 6 then return end
  local cls = safeCall(h, "GetClass")
  if cls ~= "Fixture" and cls ~= "SubFixture" then
    table.insert(limitations, string.format("'%s' (%s) is not a fixture and was not expanded", tostring(safeProp(h, "name")), tostring(cls)))
    return
  end
  local idx = numProp(h, "SubfixtureIndex")
  if idx and not seen[idx] then seen[idx] = true; out[#out + 1] = idx end
  for _, c in ipairs(safeCall(h, "Children") or {}) do collectSubfixtureIndices(c, out, seen, depth + 1, limitations) end
end

-- UI channel index from a GetUIChannels element (integer, or a UIChannel handle whose INDEX is 1-based).
local function uiIndexOf(v)
  if type(v) == "number" then return math.floor(v) end
  if isHandle(v) then
    local i = tonumber(safeProp(v, "INDEX")) or tonumber(safeProp(v, "Index")) or safeCall(v, "Index")
    if type(i) == "number" then return math.floor(i) - 1 end
  end
  return nil
end

local function attributeMeta(attr)
  if not attr then return {} end
  local m = {
    attribute = safeProp(attr, "name"), attributeIndex = numProp(attr, "AttributeIndex"), pretty = textProp(attr, "Pretty"),
    activationGroup = textProp(attr, "ActivationGroup"), physicalUnit = textProp(attr, "PhysicalUnit"),
    readout = textProp(attr, "NaturalReadout"), color = textProp(attr, "Color"), mainAttribute = textProp(attr, "MainAttribute"),
  }
  local feature = handleProp(attr, "Feature")
  if feature then
    m.feature = safeProp(feature, "name")
    local fg = safeCall(feature, "Parent")
    if fg then m.featureGroup = safeProp(fg, "name") end
  else
    m.feature = textProp(attr, "Feature")
  end
  return m
end

local function channelSetRows(cf)
  local out = {}
  for _, cs in ipairs(safeCall(cf, "Children") or {}) do
    out[#out + 1] = {
      name = safeProp(cs, "name"), dmxFrom = textProp(cs, "DmxFrom"), dmxTo = textProp(cs, "DmxTo"),
      physicalFrom = numProp(cs, "PhysicalFrom"), physicalTo = numProp(cs, "PhysicalTo"), wheelSlotIndex = numProp(cs, "WheelSlotIndex"),
    }
  end
  return emptyArray(out)
end

local function channelFunctionMeta(cf, includeSets)
  if not cf then return {} end
  local m = {
    channelFunction = safeProp(cf, "name"), dmxFrom = textProp(cf, "DmxFrom"), dmxTo = textProp(cf, "DmxTo"), default = textProp(cf, "Default"),
    physicalFrom = numProp(cf, "PhysicalFrom"), physicalTo = numProp(cf, "PhysicalTo"), realFade = numProp(cf, "RealFade"),
    realAcceleration = numProp(cf, "RealAcceleration"), wheel = textProp(cf, "Wheel"), emitter = textProp(cf, "Emitter"), customName = textProp(cf, "CustomName"),
  }
  if includeSets then m.channelSets = channelSetRows(cf) end
  return m
end

local function merge(dst, src)
  for k, v in pairs(src) do dst[k] = v end
  return dst
end

-- "1.007" -> 1, 7
local function parseDmxAddr(text)
  if type(text) ~= "string" then return nil end
  local u, a = text:match("^%s*(%d+)%.(%d+)%s*$")
  if not u then return nil end
  return tonumber(u), tonumber(a)
end

-- 24-bit hex text ("FFFFFF") -> integer
local function hex24(text)
  if type(text) ~= "string" then return nil end
  local h = text:match("^%s*(%x+)%s*$")
  return h and tonumber(h, 16) or nil
end

local function to24bit(raw, bits) return raw * 16777215 / (2 ^ bits - 1) end

-- Linear DMX -> physical conversion over a channel function's DMXFROM..DMXTO / PHYSICALFROM..PHYSICALTO.
local function toPhysical(raw, bits, cf)
  local from24, to24 = hex24(cf.dmxFrom), hex24(cf.dmxTo)
  if not (from24 and to24 and cf.physicalFrom and cf.physicalTo) or to24 == from24 then return nil end
  local t = (to24bit(raw, bits) - from24) / (to24 - from24)
  return round4(cf.physicalFrom + t * (cf.physicalTo - cf.physicalFrom))
end

local function rangeContains(entry, raw24)
  local from24, to24 = hex24(entry.dmxFrom), hex24(entry.dmxTo)
  return from24 ~= nil and to24 ~= nil and raw24 >= from24 and raw24 <= to24
end

-- RT channels of a (sub)fixture as rows with their absolute DMX addresses. nil when the API is unavailable.
local function rtChannelRows(fx, limitations)
  local ok, rts = callApi("GetRTChannels", fx, true)
  if not ok then table.insert(limitations, "DMX channel map unavailable: " .. tostring(rts)); return nil end
  if type(rts) ~= "table" then table.insert(limitations, "GetRTChannels returned no channel list"); return {} end
  local rows = {}
  for _, rt in ipairs(rts) do
    if isHandle(rt) then
      local row = {
        rtIndex = tonumber(safeProp(rt, "INDEX")) or safeCall(rt, "Index"), channel = textProp(rt, "ChannelName"), fid = textProp(rt, "FID"),
        coarse = textProp(rt, "Coarse"), fine = textProp(rt, "Fine"), ultra = textProp(rt, "Ultra"), default = textProp(rt, "Default"),
      }
      row.bits = row.ultra and 24 or (row.fine and 16 or 8)
      rows[#rows + 1] = row
    elseif type(rt) == "number" then
      rows[#rows + 1] = { rtIndex = rt }
    end
  end
  return rows
end

-- Match an attribute to RT channels by channel name ("<Geometry>_<Attribute>" or an exact DMX channel name).
-- Returns the single matching row, or nil and the number of candidates.
local function matchRtChannel(rows, attrName, dmxChannelName)
  local found, count = nil, 0
  for _, r in ipairs(rows or {}) do
    local ch = r.channel
    local hit = false
    if type(ch) == "string" then
      if dmxChannelName then hit = ch == dmxChannelName
      elseif attrName then hit = ch == attrName or ch:sub(-(#attrName + 1)) == "_" .. attrName end
    end
    if hit then count = count + 1; found = found or r end
  end
  if count == 1 then return found, 1 end
  return nil, count
end

local function dmxFromRt(rt)
  if not rt then return nil end
  return { channel = rt.channel, rtIndex = rt.rtIndex, coarse = rt.coarse, fine = rt.fine, ultra = rt.ultra, bits = rt.bits, default = rt.default }
end

-- Static walk of the fixture type: Mode -> DMXChannels -> DMXChannel -> LogicalChannel -> ChannelFunction (-> ChannelSet).
-- Returns a list of DMX channel entries or nil (with a limitation) when the tree is not reachable.
-- The fixture's DMXMode handle. Get("Mode") does not always hand back a handle (live 2.5.1 returned the
-- display text "1 Mode 0" for one fixture), so fall back to the property field and to the FixtureType's
-- DMXModes collection matched by the mode text.
local function resolveMode(main)
  local mode = handleProp(main, "Mode")
  if mode then return mode end
  local direct = safeProp(main, "Mode")
  if isHandle(direct) then return direct end
  local modeText = textProp(main, "Mode")
  local ft = handleProp(main, "FixtureType")
  if not ft then
    local d = safeProp(main, "FixtureType")
    if isHandle(d) then ft = d end
  end
  if not ft then return nil end
  local modesNode
  for _, c in ipairs(safeCall(ft, "Children") or {}) do
    local nm = safeProp(c, "name")
    if type(nm) == "string" and nm:lower() == "dmxmodes" then modesNode = c; break end
  end
  if not modesNode then return nil end
  local modes = safeCall(modesNode, "Children") or {}
  if modeText then
    local lowered = tostring(modeText):lower()
    for _, m in ipairs(modes) do
      local nm = safeProp(m, "name")
      if type(nm) == "string" and nm ~= "" then
        local l = nm:lower()
        if l == lowered or lowered:sub(-#l) == l or lowered:match("^%d+%s+" .. l:gsub("%p", "%%%0") .. "$") then return m end
      end
    end
  end
  if #modes == 1 then return modes[1] end
  return nil
end

local function walkMode(main, includeSets, limitations)
  local mode = resolveMode(main)
  if not mode then table.insert(limitations, "no DMX mode handle could be resolved for the fixture type (Get(\"Mode\"), FixtureType.DMXModes); the fixture type could not be walked"); return nil end
  local channelsNode
  for _, c in ipairs(safeCall(mode, "Children") or {}) do
    local nm, cls = safeProp(c, "name"), safeCall(c, "GetClass")
    if (type(nm) == "string" and nm:lower() == "dmxchannels") or (type(cls) == "string" and cls:lower():find("dmxchannel", 1, true)) then channelsNode = c; break end
  end
  if not channelsNode then table.insert(limitations, "DMX mode has no DMXChannels collection; the fixture type could not be walked"); return nil end
  local out = {}
  for _, dc in ipairs(safeCall(channelsNode, "Children") or {}) do
    local entry = {
      name = safeProp(dc, "name"), dmxBreak = numProp(dc, "DmxBreak"), coarse = textProp(dc, "Coarse"), fine = textProp(dc, "Fine"),
      ultra = textProp(dc, "Ultra"), default = textProp(dc, "Default"), geometry = textProp(dc, "Geometry"), logicalChannels = {},
    }
    local defCf = handleProp(dc, "DefaultChannelFunction")
    if defCf then entry.defaultChannelFunction = safeProp(defCf, "name") end
    for _, lc in ipairs(safeCall(dc, "Children") or {}) do
      local lce = { name = safeProp(lc, "name"), attribute = attributeMeta(handleProp(lc, "Attribute")), functions = {} }
      for _, cf in ipairs(safeCall(lc, "Children") or {}) do lce.functions[#lce.functions + 1] = channelFunctionMeta(cf, includeSets) end
      entry.logicalChannels[#entry.logicalChannels + 1] = lce
    end
    out[#out + 1] = entry
  end
  return out
end

-- The channel function that covers a raw value (else the default, else the first).
local function pickFunction(functions, defaultName, raw, bits)
  if not functions or #functions == 0 then return nil end
  if raw ~= nil then
    local raw24 = to24bit(raw, bits)
    for _, f in ipairs(functions) do if rangeContains(f, raw24) then return f end end
  end
  if defaultName then for _, f in ipairs(functions) do if f.channelFunction == defaultName then return f end end end
  return functions[1]
end

local function pickChannelSet(sets, raw, bits)
  if not sets or raw == nil then return nil end
  local raw24 = to24bit(raw, bits)
  for _, s in ipairs(sets) do if s.name ~= nil and rangeContains(s, raw24) then return s end end
  return nil
end

-- Attribute rows through the UI channel API. nil when the API is unavailable (caller falls back to the type walk).
local function uiChannelAttributes(fx, includeSets, rtRows, limitations)
  local okU, uis = callApi("GetUIChannels", fx, false)
  if not okU then table.insert(limitations, "GetUIChannels unavailable: " .. tostring(uis)); return nil end
  if type(uis) ~= "table" or #uis == 0 then table.insert(limitations, "GetUIChannels returned no UI channels for this fixture"); return nil end
  local attrCache, rows, ambiguous = {}, {}, 0
  for _, u in ipairs(uis) do
    local ui = uiIndexOf(u)
    if ui ~= nil then
      local row = { uiChannel = ui }
      local okA, attr = callApi("GetAttributeByUIChannel", ui)
      if not (okA and isHandle(attr)) then
        attr = nil
        -- Fall back to the UIChannel object's SubAttribute name and the attribute definition of that name.
        local attrName = isHandle(u) and (safeProp(u, "SUBATTRIBUTE") or textProp(u, "SubAttribute")) or nil
        if type(attrName) == "string" and attrName ~= "" and not attrName:find('"', 1, true) then
          if attrCache[attrName] == nil then
            local okL, list = pcall(ObjectList, 'Attribute "' .. attrName .. '"')
            attrCache[attrName] = (okL and type(list) == "table" and isHandle(list[1])) and list[1] or false
          end
          attr = attrCache[attrName] or nil
          if not attr then row.attribute = attrName end
        end
      end
      merge(row, attributeMeta(attr))
      local attrIdx = row.attributeIndex
      if attrIdx == nil and row.attribute then
        local okI, i = callApi("GetAttributeIndex", row.attribute)
        if okI and type(i) == "number" then attrIdx = i; row.attributeIndex = i end
      end
      if attrIdx ~= nil then
        local okC, cf = callApi("GetChannelFunction", ui, attrIdx)
        if okC and isHandle(cf) then
          merge(row, channelFunctionMeta(cf, includeSets))
          local lc = safeCall(cf, "Parent")
          if lc then
            local names = {}
            for _, f in ipairs(safeCall(lc, "Children") or {}) do names[#names + 1] = safeProp(f, "name") end
            if #names > 0 then row.channelFunctions = names end
          end
        end
      end
      if rtRows then
        local rt, count = matchRtChannel(rtRows, row.attribute, nil)
        if rt then row.dmx = dmxFromRt(rt) elseif count > 1 then ambiguous = ambiguous + 1 end
      end
      rows[#rows + 1] = row
    end
  end
  if ambiguous > 0 then
    table.insert(limitations, string.format("%d attribute(s) map to more than one RT channel by name (compound fixture); their dmx field is omitted, see channels[] for the full map", ambiguous))
  end
  return rows
end

-- Attribute rows from the static fixture-type walk (one row per logical channel of the DMX mode).
local function fixtureTypeAttributes(main, includeSets, rtRows, limitations)
  local walk = walkMode(main, includeSets, limitations)
  if not walk then return {} end
  local rows = {}
  for _, entry in ipairs(walk) do
    for _, lc in ipairs(entry.logicalChannels) do
      local row = merge({}, lc.attribute)
      local cf = pickFunction(lc.functions, entry.defaultChannelFunction, nil, 8)
      if cf then merge(row, cf) end
      local names = {}
      for _, f in ipairs(lc.functions) do names[#names + 1] = f.channelFunction end
      if #names > 0 then row.channelFunctions = names end
      row.dmxChannel = { name = entry.name, dmxBreak = entry.dmxBreak, coarseOffset = entry.coarse, fineOffset = entry.fine, ultraOffset = entry.ultra, geometry = entry.geometry, default = entry.default }
      if rtRows then
        local rt = matchRtChannel(rtRows, nil, entry.name)
        if rt then row.dmx = dmxFromRt(rt) end
      end
      rows[#rows + 1] = row
    end
  end
  table.insert(limitations, "attributes come from the fixture type's DMX mode (no UI channel indices); a compound fixture's shared geometry channels are listed once, not per subfixture instance")
  return rows
end

-- Per RT channel name, the attribute and channel function metadata to interpret output values.
-- Tries the UI channel API first (rows matched to RT channels by channel name) and the fixture-type
-- walk second. Returns map, source ("uiChannels" | "fixtureTypeWalk" | nil).
local function channelMetaMap(fx, main, rtRows, limitations)
  local map, scratch, sources = {}, {}, {}
  -- The walk knows every channel function of a logical channel (needed to pick the one covering a value).
  local walkMap = {}
  local walk = walkMode(main, true, scratch)
  if walk then
    for _, e in ipairs(walk) do
      local lc = e.logicalChannels[1]
      if e.name and lc and not walkMap[e.name] then
        walkMap[e.name] = { attribute = lc.attribute.attribute, attributeIndex = lc.attribute.attributeIndex, physicalUnit = lc.attribute.physicalUnit, functions = lc.functions, defaultFunction = e.defaultChannelFunction, logicalCount = #e.logicalChannels }
      end
    end
  end
  -- The UI channel API ties RT channels to the attributes this (sub)fixture actually exposes.
  local rows = uiChannelAttributes(fx, true, rtRows, scratch)
  if rows then
    for _, row in ipairs(rows) do
      if row.dmx and row.dmx.channel and row.channelFunction and not map[row.dmx.channel] then
        local w = walkMap[row.dmx.channel]
        map[row.dmx.channel] = {
          attribute = row.attribute, attributeIndex = row.attributeIndex, physicalUnit = row.physicalUnit,
          functions = (w and #w.functions > 1) and w.functions or { row }, defaultFunction = row.channelFunction, logicalCount = w and w.logicalCount or 1,
        }
      end
    end
    if next(map) ~= nil then sources[#sources + 1] = "uiChannels" end
  end
  local walkUsed = false
  for name, w in pairs(walkMap) do
    if not map[name] then map[name] = w; walkUsed = true end
  end
  if walkUsed or (next(map) ~= nil and next(walkMap) ~= nil) then sources[#sources + 1] = "fixtureTypeWalk" end
  if next(map) == nil then
    table.insert(limitations, "attribute and channel function metadata unavailable for the RT channels (neither the UI channel API nor the fixture type walk produced a mapping): " .. table.concat(scratch, "; "))
    return map, nil
  end
  return map, table.concat(sources, "+")
end

-- RT channels for a (sub)fixture. A SubFixture usually has none of its own: its addresses belong to the
-- parent fixture, so the parent's channels that match exactly one of the subfixture's attributes are used.
-- Returns rows, source ("own" | "parent" | nil).
local function fixtureRtChannels(fx, main, limitations)
  local rows = rtChannelRows(fx, limitations)
  if rows == nil then return nil, nil end
  if #rows > 0 or fx == main then return rows, "own" end
  local parentRows = rtChannelRows(main, limitations) or {}
  local parentName = string.format("'%s' (Fixture %s)", tostring(safeProp(main, "name")), tostring(textProp(main, "FID")))
  if #parentRows == 0 then
    table.insert(limitations, "the subfixture has no RT channels of its own and its parent fixture " .. parentName .. " has none either (unpatched)")
    return {}, nil
  end
  local attrNames, seen = {}, {}
  local okU, uis = callApi("GetUIChannels", fx, false)
  if okU and type(uis) == "table" then
    for _, u in ipairs(uis) do
      local ui = uiIndexOf(u)
      if ui ~= nil then
        local okA, attr = callApi("GetAttributeByUIChannel", ui)
        local nm = (okA and isHandle(attr)) and safeProp(attr, "name") or nil
        if type(nm) == "string" and not seen[nm] then seen[nm] = true; attrNames[#attrNames + 1] = nm end
      end
    end
  end
  local out, ambiguous = {}, 0
  for _, nm in ipairs(attrNames) do
    local rt, count = matchRtChannel(parentRows, nm, nil)
    if rt then out[#out + 1] = rt elseif count > 1 then ambiguous = ambiguous + 1 end
  end
  if #out > 0 then
    table.insert(limitations, string.format("the subfixture has no RT channels of its own; %d channel(s) were taken from its parent fixture %s by unique attribute name%s",
      #out, parentName, ambiguous > 0 and string.format(", %d attribute(s) are shared by several instances and could not be attributed", ambiguous) or ""))
    return out, "parent"
  end
  table.insert(limitations, "the subfixture has no RT channels of its own; its DMX mappings (addresses) are available on the parent fixture " .. parentName ..
    (ambiguous > 0 and " (the instance's channels share their names with other instances and cannot be attributed to this subfixture)" or ""))
  return {}, nil
end

-- One programmer row from a GetProgPhaser table; nil when the masks show no programmer data.
local function programmerRow(p, ui, sfIdx, sf, attrCache, stats)
  local mv, mp, mi = tonumber(p.mask_active_value) or 0, tonumber(p.mask_active_phaser) or 0, tonumber(p.mask_individual) or 0
  local stepCount = #p
  if mv == 0 and mp == 0 and mi == 0 then
    if stepCount > 0 then stats.channelsWithStepsButInactiveMask = stats.channelsWithStepsButInactiveMask + 1 end
    return nil
  end
  stats.channelsWithData = stats.channelsWithData + 1
  local attr = attrCache[ui]
  if attr == nil then
    local ok, a = callApi("GetAttributeByUIChannel", ui)
    attr = (ok and isHandle(a)) and a or false
    attrCache[ui] = attr
  end
  local row = {
    fixture = sf and safeProp(sf, "name") or nil, fid = sf and textProp(sf, "FID") or nil, subfixtureIndex = sfIdx, uiChannel = ui,
    present = true, masks = { activeValue = mv, activePhaser = mp, individual = mi }, stepCount = stepCount, steps = {},
  }
  if attr then
    row.attribute = safeProp(attr, "name"); row.attributeIndex = numProp(attr, "AttributeIndex")
    -- Range and readout of the channel function behind this UI channel, so a client can interpret
    -- `absolute` (percent of the range) in physical units. Absent when the API does not supply them.
    local meta = attrCache.meta and attrCache.meta[ui]
    if meta == nil then
      meta = { physicalUnit = textProp(attr, "PhysicalUnit"), readout = textProp(attr, "NaturalReadout") }
      if row.attributeIndex ~= nil then
        local okC, cf = callApi("GetChannelFunction", ui, row.attributeIndex)
        if okC and isHandle(cf) then
          meta.channelFunction = safeProp(cf, "name")
          meta.physicalFrom = numProp(cf, "PhysicalFrom")
          meta.physicalTo = numProp(cf, "PhysicalTo")
        end
      end
      attrCache.meta = attrCache.meta or {}
      attrCache.meta[ui] = meta
    end
    for k, v in pairs(meta) do row[k] = v end
  end
  for s = 1, stepCount do
    local st = p[s]
    if type(st) == "table" then
      row.steps[#row.steps + 1] = {
        step = s, channelFunction = st.channel_function, absolute = st.absolute, absoluteValue = st.absolute_value, relative = st.relative,
        accel = st.accel, accelType = st.accel_type, decel = st.decel, decelType = st.decel_type, trans = st.trans, width = st.width,
        integratedPreset = presetRef(st.integrated),
      }
    end
  end
  if stepCount == 1 and type(p[1]) == "table" then
    row.value = p[1].absolute
    row.valueRaw = p[1].absolute_value
    row.relative = p[1].relative
  end
  local timing = { fade = p.fade, delay = p.delay, speed = p.speed, phase = p.phase, measure = p.measure, gridPos = p.gridpos }
  if stepCount >= 1 and #row.steps == stepCount then
    row.phaser = merge({ supported = true, multiStep = stepCount > 1 }, timing)
  else
    row.phaser = merge({ supported = false, reason = stepCount == 0 and "GetProgPhaser reported active masks but returned no step table" or "GetProgPhaser step entries were not tables" }, timing)
  end
  row.absPreset = presetRef(p.abs_preset)
  row.relPreset = presetRef(p.rel_preset)
  emptyArray(row.steps)
  return row
end

-- Per-universe metadata from the patch (nil when unreadable).
local function universeInfo(n)
  local info
  pcall(function()
    local pool = Patch().DmxUniverses
    local u = pool:Ptr(n)
    if not u then return end
    info = { name = safeProp(u, "name"), granted = yesNo(textProp(u, "Granted")), request = textProp(u, "Request"), portOut = yesNo(textProp(u, "PortOut")), used = numProp(u, "Used"), coarseParams = numProp(u, "CoarseParams"), mergeMode = textProp(u, "MergeMode") }
  end)
  return info
end

-- "universe.address" -> { fid, channel, part } for every patched RT channel address, built from the fixture list.
local function patchMap(limitations)
  local okN, n = callApi("GetRTChannelCount")
  if okN and type(n) == "number" and n > 6000 then
    table.insert(limitations, string.format("patch lookup skipped: %d RT channels exceed the per-request bound (6000)", n))
    return nil
  end
  local okL, list = pcall(ObjectList, "Fixture Thru")
  if not okL or type(list) ~= "table" then table.insert(limitations, "patch lookup unavailable: ObjectList('Fixture Thru') failed"); return nil end
  local map, any = {}, false
  for _, fx in ipairs(list) do
    local okR, rts = callApi("GetRTChannels", fx, true)
    if okR and type(rts) == "table" then
      for _, rt in ipairs(rts) do
        if isHandle(rt) then
          any = true
          local fid, ch = textProp(rt, "FID"), textProp(rt, "ChannelName")
          for _, part in ipairs({ "Coarse", "Fine", "Ultra" }) do
            local u, a = parseDmxAddr(textProp(rt, part))
            if u then
              local key = string.format("%d.%d", u, a)
              if not map[key] then map[key] = { fid = fid, channel = ch, part = part:lower() } end
            end
          end
        end
      end
    end
  end
  if not any then table.insert(limitations, "patch lookup found no RT channels (GetRTChannels unavailable or nothing patched)") end
  return map
end

local MAX_PRESET_ROWS = 2000

local function presetScalar(v)
  if isHandle(v) then return presetRef(v) or safeCall(v, "AddrNative") end
  if type(v) == "table" then return nil end
  return v
end

-- Best-effort flattening of a GetPresetData entry into rows (one per phaser step); the table's
-- exact shape is undocumented, so nested tables are followed with a dotted `path`.
local function flattenPresetRows(entry, base, out, depth)
  if depth > 4 or #out.rows >= MAX_PRESET_ROWS then out.truncated = true; return end
  local row = merge({}, base)
  local hasSteps, nested = false, {}
  for k, v in pairs(entry) do
    if type(k) == "number" then hasSteps = true
    elseif type(v) == "table" and not isHandle(v) then nested[k] = v
    else row[k] = presetScalar(v) end
  end
  if hasSteps then
    for i, st in ipairs(entry) do
      if #out.rows >= MAX_PRESET_ROWS then out.truncated = true; break end
      local r = merge({}, row)
      r.step = i
      if type(st) == "table" then
        for k, v in pairs(st) do if type(k) == "string" and (type(v) ~= "table" or isHandle(v)) then r[k] = presetScalar(v) end end
      else
        r.value = st
      end
      out.rows[#out.rows + 1] = r
    end
  elseif next(nested) == nil then
    out.rows[#out.rows + 1] = row
  end
  for k, v in pairs(nested) do
    local b = merge({}, row)
    b.path = (base.path and (base.path .. ".") or "") .. tostring(k)
    flattenPresetRows(v, b, out, depth + 1)
  end
end

local function expandPreset(presetH, fidFilter, limitations)
  local ok, data = callApi("GetPresetData", presetH, false, true)
  if not ok then return { available = false, error = tostring(data) } end
  if type(data) ~= "table" then return { available = false, error = "GetPresetData returned " .. type(data) } end
  local out = { available = true, source = "GetPresetData", rows = {}, truncated = false, topLevelKeys = {}, meta = {} }
  out.byFixturesPresent = type(data.by_fixtures) == "table"
  for k, v in pairs(data) do
    if #out.topLevelKeys < 50 then out.topLevelKeys[#out.topLevelKeys + 1] = tostring(k) end
    if k == "by_fixtures" and type(v) == "table" then
      for fid, entry in pairs(v) do
        if type(entry) == "table" and (not fidFilter or fidFilter[tostring(fid)]) then flattenPresetRows(entry, { fid = tostring(fid) }, out, 0) end
      end
    elseif type(k) == "number" and type(v) == "table" then
      if not fidFilter then flattenPresetRows(v, { uiChannel = k }, out, 0) end
    elseif type(v) ~= "table" or isHandle(v) then
      out.meta[tostring(k)] = presetScalar(v)
    end
  end
  if fidFilter then
    out.filterApplied = out.byFixturesPresent and "by_fixtures" or "none"
    if not out.byFixturesPresent then table.insert(limitations, "fixtures filter could not be applied to preset data: GetPresetData returned no by_fixtures table") end
  end
  out.count = #out.rows
  emptyArray(out.rows)
  emptyArray(out.topLevelKeys)
  return out
end

-------------------------------------------------------------------------------
-- Lua execution policy
-------------------------------------------------------------------------------

local hookSupported = type(debug) == "table" and type(debug.sethook) == "function"
local function describeHook(h, mask, count)
  if h == nil then return "none" end
  local kind = type(h) == "string" and h or "Lua function"   -- "external hook" = set from C by the console
  return string.format("%s (mask %q, count %s)", kind, tostring(mask or ""), tostring(count or 0))
end

-- The hook currently on the plugin thread (ping runs on that thread, like every structured op).
-- An external (C) hook is the console's own; Lua can neither call nor re-create it.
local function currentThreadHook()
  if not hookSupported then return nil, false end
  local okH, h, m, c = pcall(debug.gethook)
  if not okH then return nil, false end
  return { hook = h, mask = m, count = c }, (h ~= nil and type(h) ~= "function")
end

local function now()
  local ok, t = pcall(socket.gettime)
  if ok and type(t) == "number" then return t end
  return os.clock()
end

local function luaPolicyInfo()
  local found, consoleHookExternal = currentThreadHook()
  return {
    enabled  = state.lua.enabled and true or false,
    maxMs    = state.lua.maxMs,
    maxSteps = state.lua.maxSteps,
    hookMode = state.lua.hookMode or LUA_DEFAULT_HOOK_MODE,
    -- True when the instruction hook is actually installed for chunks: debug.sethook exists and
    -- either no external console hook is on the plugin thread or hookMode is "replace".
    bounded  = hookSupported and (consoleHookExternal ~= true or state.lua.hookMode == "replace"),
    note     = not hookSupported
      and "debug.sethook is unavailable in this Lua engine: no execution bound can be enforced"
      or (consoleHookExternal == true and state.lua.hookMode ~= "replace")
      and "the console keeps its own hook on the plugin thread and it is preserved (luahook=preserve): the instruction budget is NOT enforced, only the wall-clock deadline is checked when a chunk yields or returns, so a busy loop cannot be stopped; start with luahook=replace to enforce hard quotas at the cost of that console hook"
      or "budget is enforced by a VM instruction hook on the plugin thread while a chunk runs; a blocking C call (e.g. Cmd opening a dialog) cannot be interrupted",
    -- The hook on the plugin thread right now (the console's own, if any; "none" after a replace run
    -- until the plugin restarts). An "external hook" is set from C by onPC.
    consoleHook = found and describeHook(found.hook, found.mask, found.count) or "none",
  }
end

local function describeLuaPolicy()
  if not state.lua.enabled then return "disabled" end
  local function lim(v, unit) if v and v > 0 then return tostring(v) .. unit end return "unlimited" end
  return string.format("enabled (budget %s / %s per request, console hook: %s%s)", lim(state.lua.maxMs, " ms"), lim(state.lua.maxSteps, " VM instructions"),
    state.lua.hookMode or LUA_DEFAULT_HOOK_MODE,
    hookSupported and "" or "; NOT enforced: debug.sethook unavailable")
end

-- Budget state of the request currently executing (requests are handled one at a time).
-- The sandbox's coroutine.create/wrap use it to put the budget hook on threads the script creates,
-- and its coroutine.yield wrapper uses it to re-check the deadline after every resume.
local activeBudget = nil

-- Source of this chunk, as debug.getinfo reports it. The budget hook uses it to tell the plugin's
-- own code from submitted code: once the budget is exceeded it raises the error only while
-- submitted code (or a library it called) is executing, never inside the bridge itself.
local PLUGIN_SOURCE = debug.getinfo(1, "S").source

-- Run fn() under the configured budget and return its results as a packed table.
--
-- The chunk runs on the plugin thread itself. It cannot run in a child coroutine: grandMA3
-- binds the plugin context to the thread it created for the plugin, and a coroutine created
-- from Lua gets the main thread's (empty) context, so ObjectList(), DataPool(), Programmer()
-- and every other context-bound function return nothing there (verified on onPC 2.5.1).
--
-- The budget is enforced with a VM instruction hook installed on the plugin thread for the
-- duration of the chunk. onPC keeps its own hook on that thread (an external C hook, count
-- 50000 on 2.5.1). A C hook cannot be called from or re-created in Lua, so while a chunk runs
-- the console's hook is replaced, and afterwards the thread is left without a hook until the
-- plugin is restarted; ping reports what was found. A Lua hook (none, on the console) is
-- restored exactly. If the chunk yields, the yield passes up to the console like the bridge
-- loop's own per-frame yield; the sandbox's coroutine.yield wrapper re-installs the hook and
-- re-checks the deadline when the chunk is resumed, so a script that mostly yields (and so
-- executes few VM instructions) is still bounded.
local function runBounded(fn, maxMs, maxSteps)
  local budget = { exceeded = nil }
  local timeMsg = maxMs and maxMs > 0 and string.format("Lua execution budget exceeded: ran longer than %d ms", maxMs) or nil
  local deadline = (maxMs and maxMs > 0) and (now() + maxMs / 1000) or nil
  local function overdue() return deadline ~= nil and now() >= deadline end
  local hook = nil
  local prevHook, prevMask, prevCount = nil, nil, nil
  local installed = false

  local preserved = false   -- true when an external console hook was found and left in place
  if hookSupported and ((maxMs and maxMs > 0) or (maxSteps and maxSteps > 0)) then
    local steps = 0
    hook = function()
      if not budget.exceeded then
        steps = steps + LUA_HOOK_INTERVAL
        if maxSteps and maxSteps > 0 and steps >= maxSteps then
          budget.exceeded = string.format("Lua execution budget exceeded: more than %d VM instructions", maxSteps)
        elseif overdue() then
          budget.exceeded = timeMsg
        end
      end
      if budget.exceeded then
        -- Fail on every instruction from now on so that code wrapped in pcall (or a parent
        -- resuming an exhausted child) cannot keep going; but never raise inside the plugin's
        -- own code, which is what runs once the error has unwound out of the chunk.
        local info = debug.getinfo(2, "S")
        if info == nil or info.source ~= PLUGIN_SOURCE then
          debug.sethook(hook, "", 1)
          error(budget.exceeded, 0)
        end
      end
    end
    budget.attach = function(thread) debug.sethook(thread, hook, "", LUA_HOOK_INTERVAL) end
    prevHook, prevMask, prevCount = debug.gethook()
    local external = prevHook ~= nil and type(prevHook) ~= "function"
    if external and state.lua.hookMode ~= "replace" then
      -- The console's own hook stays. Threads the chunk creates are still budgeted (they have no
      -- console hook), but on the plugin thread only the deadline is checked, at yields and return.
      preserved = true
    else
      debug.sethook(hook, "", LUA_HOOK_INTERVAL)
      installed = true
    end
  end
  budget.enforced = installed

  -- Called by the sandbox's coroutine.yield after the chunk is resumed by the console.
  budget.afterResume = function()
    if installed and debug.gethook() ~= hook then debug.sethook(hook, "", LUA_HOOK_INTERVAL) end
    if not budget.exceeded and overdue() then budget.exceeded = timeMsg end
    if budget.exceeded then error(budget.exceeded, 0) end
  end

  local previous = activeBudget
  activeBudget = budget
  local res = table.pack(xpcall(fn, function(msg)
    local okT, tb = pcall(debug.traceback, tostring(msg), 2)
    return okT and tb or tostring(msg)
  end))
  activeBudget = previous

  if installed then
    if prevHook == nil then
      debug.sethook()
    elseif type(prevHook) == "function" then
      debug.sethook(prevHook, prevMask or "", prevCount or 0)
    else
      -- The console's external hook cannot be re-created from Lua. Leave the thread without a hook
      -- rather than with ours (see the comment above).
      debug.sethook()
    end
  end

  if res[1] and not budget.exceeded and overdue() then budget.exceeded = timeMsg end
  if budget.exceeded then
    error(budget.exceeded .. '. Raise the budget when starting the bridge: Plugin "gma3_mcp_bridge" "lua luatime=<ms> luasteps=<n>" (0 = unlimited).', 0)
  end
  if not res[1] then
    error(tostring(res[2]), 0)
  end
  local results = table.pack(table.unpack(res, 2, res.n))
  results.budget = {
    instructionHookEnforced = installed,
    consoleHookPreserved = preserved,
    note = preserved
      and "the console's own hook on the plugin thread was preserved: the instruction budget was not enforced and the wall-clock deadline was only checked at yields and at return (luahook=preserve)"
      or nil,
  }
  return results
end

-- Environment for submitted code. Reads and writes fall through to the real globals (so the
-- whole grandMA3 API is available and globals a script defines persist as before), but the
-- obvious ways around the budget are closed: debug.sethook/gethook are withheld, coroutines
-- the script creates get the budget hook, and load/loadfile/dofile/require/package resolve
-- to the same environment. This is best-effort hardening for trusted scripts, not a
-- security boundary: Lua on the console already has io and os, and a script determined to
-- escape (e.g. via debug.getregistry or upvalue access on wrapped functions) still can.
local function sandboxEnv()
  local env = {}

  local dbg = {}
  if type(debug) == "table" then for k, v in pairs(debug) do dbg[k] = v end end
  dbg.sethook = function() error("debug.sethook is not available to bridge scripts (the execution budget is enforced with it)", 2) end
  dbg.gethook = function() return nil end
  dbg.getregistry = nil
  dbg.getupvalue, dbg.setupvalue, dbg.upvaluejoin = nil, nil, nil

  local co = {}
  for k, v in pairs(coroutine) do co[k] = v end
  co.create = function(f)
    local t = coroutine.create(f)
    if activeBudget and activeBudget.attach then activeBudget.attach(t) end
    return t
  end
  co.wrap = function(f)
    local t = co.create(f)
    return function(...)
      local r = table.pack(coroutine.resume(t, ...))
      if not r[1] then error(r[2], 0) end
      return table.unpack(r, 2, r.n)
    end
  end
  -- A yield from the chunk suspends the plugin thread until the console's next frame. Once
  -- resumed, re-install the budget hook (the console may have touched the thread) and re-check
  -- the wall-clock deadline, so a script that mostly waits is still bounded.
  co.yield = function(...)
    local r = table.pack(coroutine.yield(...))
    if activeBudget and activeBudget.afterResume then activeBudget.afterResume() end
    return table.unpack(r, 1, r.n)
  end

  env._G = env
  env.debug = dbg
  env.coroutine = co
  env.load = function(chunk, name, mode, e) return load(chunk, name, mode, e == nil and env or e) end
  if loadstring then env.loadstring = env.load end
  env.loadfile = function(name, mode, e) return loadfile(name, mode, e == nil and env or e) end
  env.dofile = function(name)
    local f, err = loadfile(name, "bt", env)
    if not f then error(err, 2) end
    return f()
  end
  local shadowed = { debug = dbg, coroutine = co, _G = env }
  env.require = function(name)
    if shadowed[name] then return shadowed[name] end
    return require(name)
  end
  if type(package) == "table" then
    env.package = setmetatable({ loaded = setmetatable(shadowed, { __index = package.loaded }) }, { __index = package })
  end
  return setmetatable(env, { __index = _G, __newindex = _G })
end

-------------------------------------------------------------------------------
-- Operations
-------------------------------------------------------------------------------

-------------------------------------------------------------------------------
-- Console interaction modules (KB-02)
-------------------------------------------------------------------------------
-- The input and feedback modules ship as additional ComponentLua entries of this plugin
-- (gma3_mcp_bridge.xml). The console stores every component's source inside the show file and runs
-- each chunk once at import and at show load, passing (pluginName, componentName, signalTable,
-- handle); signalTable is one table per plugin instance shared by all of its components. Each module
-- chunk registers its module table there under its NAME, and the bridge looks it up when it starts.
-- Nothing goes through require()/package.loaded (shared by every plugin, searches loose library
-- files only, keeps stale copies across re-import) or globals, so a second plugin that ships the same
-- components gets its own copies. Reading the sibling component's FileContent is not an option: the
-- property is capped at about 1 KB on onPC 2.5.1.
-- Probe evidence and the vendoring contract: docs/modules.md, docs/probes/kb-02-loading-macos-2.5.1.md.

local MODULE_API_VERSION  = 1
local MODULE_REGISTRY_KEY = "__gma3_mcp_modules"
local MODULE_COMPONENTS = {
  { key = "hardkeys", component = "gma3_mcp_hardkeys" },
  { key = "feedback", component = "gma3_mcp_feedback" },
  { key = "control",  component = "gma3_mcp_control" },
}

local enableInputOn, adoptKeptRecords, adoptKeptBank, adoptKeptMode  -- defined with the input ops below; used by loadModules()
local detachControl  -- defined with serviceModules() below

-- Best-effort detail for an error message: is the component in the plugin, and did it fail to parse?
local function componentInfo(name)
  if my_handle == nil then return "" end
  local ok, info = pcall(function()
    local parent = my_handle:Parent()
    for i = 1, parent:Count() do
      local c = parent:Ptr(i)
      if c and tostring(c.name) == name then
        local se = c:Get("SyntaxError")
        return (se == true or se == "true") and " (the component is present but has a syntax error)" or " (the component is present; its chunk did not register)"
      end
    end
    return " (no ComponentLua of that name in this plugin; check gma3_mcp_bridge.xml)"
  end)
  return ok and info or ""
end

local function loadModule(entry)
  if type(signalTable) ~= "table" then return nil, "no signal table (the plugin was not loaded by the console)" end
  local reg = rawget(signalTable, MODULE_REGISTRY_KEY)
  if type(reg) ~= "table" then
    return nil, "no module registered: the module components did not run" .. componentInfo(entry.component)
  end
  local mod = reg[entry.component]
  if mod == nil then return nil, "module '" .. entry.component .. "' is not registered" .. componentInfo(entry.component) end
  if type(mod) ~= "table" or type(mod.new) ~= "function" or mod.API_VERSION == nil then
    return nil, "registered value for '" .. entry.component .. "' is not a module table with new() and API_VERSION"
  end
  if mod.API_VERSION ~= MODULE_API_VERSION then
    return nil, string.format("module API version %s, this bridge expects %d", tostring(mod.API_VERSION), MODULE_API_VERSION)
  end
  return mod
end

-- Looks up every module and creates this bridge's own instance of each. Loading creates no socket,
-- timer, show object or input: the chunks only return tables and new()/init() only record state.
-- A module that fails to load is reported (ping / modules op) and the bridge still starts.
local function loadModules()
  state.modules = {}
  local summary = {}
  for _, entry in ipairs(MODULE_COMPONENTS) do
    local rec = { component = entry.component, loaded = false }
    local mod, err = loadModule(entry)
    if mod then
      rec.loaded, rec.version, rec.apiVersion, rec.module = true, mod.VERSION, mod.API_VERSION, mod
      local okI, inst = pcall(function()
        local deps = type(mod.consoleDeps) == "function" and mod.consoleDeps(_G) or nil
        if entry.key == "feedback" and type(deps) == "table" then
          -- KB-17: the executors this bridge's owned Quickey bank (KB-12) reserved are never playback
          -- targets; the feedback readers get them from the hardkeys instance, lazily and read-only.
          deps.reservedExecutors = function()
            local hk = state.modules.hardkeys
            local hinst = hk and hk.instance
            if not hinst or type(hinst.bankStatus) ~= "function" then return nil end
            local b = hinst:bankStatus(now())
            if type(b) ~= "table" or not b.provisioned or type(b.spec) ~= "table" then return nil end
            return b.spec.executors
          end
        end
        if entry.key == "control" and type(deps) == "table" then
          -- KB-18: the binding is this bridge's feedback instance, cached for the spec control.bind
          -- watched; the other input owner is this bridge's hardkeys instance (its KB-05 admission).
          deps.binding = function(t)
            local fb = state.modules.feedback
            local finst = fb and fb.instance
            local spec = state.control.spec
            if not finst or type(finst.contextSnapshot) ~= "function" or type(spec) ~= "table" then return nil end
            return finst:contextSnapshot({ display = spec.display, executors = spec.executors }, t, { cached = true })
          end
          deps.busy = function(_, t)
            local hk = state.modules.hardkeys
            local hinst = hk and hk.instance
            if not hinst or type(hinst.admission) ~= "function" then return nil end
            local ok, busy = pcall(hinst.admission, hinst, t)
            return ok and busy or nil
          end
        end
        return mod.new({ owner = "gma3_mcp_bridge", deps = deps }):init()
      end)
      if okI then rec.instance = inst else rec.loaded, rec.error = false, "instance: " .. tostring(inst) end
      if okI and entry.key == "hardkeys" then
        -- Records a previous run could not release are adopted now, before any input is admitted,
        -- so their tuples are reserved (a new session gets [conflict]). Releasing them stays an
        -- explicit operator action ("input recover"); adopt() dispatches nothing.
        adoptKeptRecords(rec)
        adoptKeptBank(rec)
        adoptKeptMode(rec)
        if state.input.enabled then
          local okE, err = enableInputOn(rec)
          if not okE then
            state.input.enabled = false
            logerr("input: %s; input stays disabled", tostring(err))
          end
        end
      end
    else
      rec.error = err
    end
    state.modules[entry.key] = rec
    summary[#summary + 1] = entry.key .. (rec.loaded and (" " .. tostring(rec.version)) or (" FAILED (" .. tostring(rec.error) .. ")"))
  end
  log("modules: %s", table.concat(summary, ", "))
end

local detachHardkeys  -- defined below (needs logReleaseResult)

local function describeAttempt(a)
  return string.format("%s %s(%s) %s%s", tostring(a.session), tostring(a.logical or "raw"), tostring(a.tupleKey), tostring(a.state),
    a.error and (": " .. tostring(a.error)) or (a.verified == false and " (dispatched, effect not observable)" or ""))
end

local function logReleaseResult(prefix, r)
  if type(r) ~= "table" then return end
  for _, a in ipairs(r.released or {}) do log("%s released %s", prefix, describeAttempt(a)) end
  for _, a in ipairs(r.unresolved or {}) do logerr("%s UNRESOLVED %s", prefix, describeAttempt(a)) end
end

local function serviceModules(now)
  for key, rec in pairs(state.modules) do
    if rec.instance then
      local ok, res = pcall(rec.instance.service, rec.instance, now)
      if not ok then
        rec.error = "service: " .. tostring(res)
        logerr("module %s failed in service(): %s", key, tostring(res))
        if key == "hardkeys" then detachHardkeys(rec, now, "service-error") end
        if key == "control" then detachControl(rec, now, "service-error") end
        rec.instance = nil
        logerr("module %s detached; restart the bridge to load it again", key)
      elseif key == "hardkeys" and type(res) == "table" then
        for _, sid in ipairs(res.expired or {}) do log("input: lease of session %s expired", tostring(sid)) end
        for _, iid in ipairs(res.interactionsExpired or {}) do log("input: interaction %s expired (its holds were released, nothing is resumed)", tostring(iid)) end
        if type(res.sequence) == "table" and res.sequence.state ~= "running" then
          log("input: sequence %s %s (%d of %d steps completed%s)", tostring(res.sequence.id), tostring(res.sequence.state), res.sequence.counts and res.sequence.counts.completed or 0, res.sequence.steps or 0,
            res.sequence.error and ("; " .. tostring(res.sequence.error)) or "")
        end
        logReleaseResult("input: deadline", res)
      elseif key == "control" and type(res) == "table" then
        for _, sid in ipairs(res.expired or {}) do log("control: lease of session %s expired (gestures ended, queued motion dropped)", tostring(sid)) end
        for _, e in ipairs(res.ended or {}) do if e.reason ~= "lease-expired" then log("control: %s on %s/%s ended (%s): %s", tostring(e.kind), tostring(e.device), tostring(e.control), tostring(e.reason), tostring(e.outcome)) end end
        for _, u in ipairs(res.unresolved or {}) do logerr("control: UNRESOLVED %s release on %s/%s: %s", tostring(u.kind), tostring(u.device), tostring(u.control), tostring(u.error)) end
      end
    end
  end
end

-- Takes the control instance out of service: every gesture gets an end attempt through its backend,
-- queued motion is dropped and the releases that stay unresolved are kept in state.control.unresolved.
detachControl = function(rec, t, reason)
  local inst = rec.instance
  if not inst then return end
  local ok, r = pcall(inst.dispose, inst, t)
  if ok and type(r) == "table" then
    for _, e in ipairs(r.ended or {}) do log("control: %s on %s/%s ended on %s: %s", tostring(e.kind), tostring(e.device), tostring(e.control), tostring(reason), tostring(e.outcome)) end
    for _, u in ipairs(r.records or {}) do state.control.unresolved[#state.control.unresolved + 1] = u; logerr("control: UNRESOLVED %s release on %s/%s kept for 'control recover': %s", tostring(u.kind), tostring(u.device), tostring(u.control), tostring(u.error)) end
    if (r.dropped or 0) > 0 then log("control: %d queued intent(s) dropped on %s (never applied late)", r.dropped, tostring(reason)) end
  else
    logerr("control: dispose on %s raised: %s", tostring(reason), tostring(r))
  end
  rec.instance = nil
  state.control.enabled = false
end

-- Takes the hardkeys instance out of service without losing anything it owns: no new input, a release
-- attempt for every held key, and every record that stays unresolved kept in state.input.unresolved
-- (for "input recover" after a restart). Used when service() raised and at every stop.
detachHardkeys = function(rec, t, reason)
  local inst = rec.instance
  if not inst then return end
  local okS, st = pcall(inst.status, inst)
  if not okS or type(st) ~= "table" or st.state == "disposed" then return end
  state.input.enabled = false
  if st.state == "ready" then
    local okD, dis = pcall(inst.disableInput, inst, t, reason)
    if okD then logReleaseResult("input: " .. tostring(reason), dis) else logerr("input: disableInput on %s failed: %s", tostring(reason), tostring(dis)) end
    -- KB-14: a temporary shortcut mode is restored by service() one restore delay after the releases
    -- above, never in the same call. Where this runs inside the loop's coroutine (a stop) the frames are
    -- waited for here; from Cleanup (not yieldable) dispose() hands the pending restoration back instead.
    local okM, stM = pcall(inst.status, inst, t)
    if okM and type(stM) == "table" and stM.modeChange and stM.modeChange.state == "active" and coroutine.isyieldable() then
      local deadline = now() + 1.0
      while now() < deadline do
        coroutine.yield()
        t = now()
        pcall(inst.service, inst, t)
        local okN, stN = pcall(inst.status, inst, t)
        if not (okN and type(stN) == "table" and stN.modeChange and stN.modeChange.state == "active") then break end
      end
      local okL, stL = pcall(inst.status, inst, t)
      if okL and type(stL) == "table" and stL.lastModeChange and stL.lastModeChange.restoredAt then log("input: %s: keyboard-shortcut mode restoration %s restored before dispose", tostring(reason), tostring(stL.lastModeChange.id)) end
    end
  end
  local ok, res = pcall(inst.dispose, inst, t)
  if ok and type(res) == "table" then
    logReleaseResult("input: " .. tostring(reason), res)
    for _, r in ipairs(res.records or {}) do
      r.keptAt, r.keptReason = t, reason
      state.input.unresolved[#state.input.unresolved + 1] = r
      logerr("input: keeping unresolved record %s(%s) of session %s: %s", tostring(r.logical or "raw"), tostring(r.tupleKey), tostring(r.session), tostring(r.unresolved and r.unresolved.reason))
    end
    if #(res.records or {}) > 0 then
      logerr("input: %d unresolved release record(s) kept; run  Plugin \"gma3_mcp_bridge\" \"input recover\"  once the bridge runs again", #res.records)
    end
    -- The Quickey bank record (KB-12) is kept like the unresolved records; the next start re-verifies it.
    if type(res.bank) == "table" then state.input.bank = res.bank; log("input: bank record %s kept for the next start (%d codes); nothing on the console was changed", tostring(res.bank.id), #(res.bank.codes or {})) end
    -- KB-14: a shortcut-mode restoration dispose() could not verify is kept; the next start adopts it as
    -- unresolved and "input recover" restores it on the original profile.
    if type(res.mode) == "table" then
      res.mode.keptAt, res.mode.keptReason = t, reason
      state.input.mode = res.mode
      logerr("input: keeping the unresolved keyboard-shortcut mode restoration %s (profile '%s', shortcuts %s -> %s): %s; run  Plugin \"gma3_mcp_bridge\" \"input recover\"  on that profile once the bridge runs again",
        tostring(res.mode.id), tostring(res.mode.profile), tostring(res.mode.original), tostring(res.mode.target), tostring(res.mode.unresolved and res.mode.unresolved.reason))
    end
  elseif not ok then
    logerr("input: dispose failed: %s", tostring(res))
  end
end

-- Disposes every module instance. The hardkeys instance attempts to release everything it still holds
-- and hands back the records it could not resolve; they are kept in state.input.unresolved (which
-- survives in _G until the plugin is reloaded) so "input recover" can act on them after a restart.
local function disposeModules(reason)
  local t = now()
  for key, rec in pairs(state.modules) do
    if rec.instance then
      if key == "hardkeys" then
        local enabled = state.input.enabled
        detachHardkeys(rec, t, reason or "dispose")
        state.input.enabled = enabled  -- the policy belongs to the next start, which resets it anyway
      elseif key == "control" then
        local enabled = state.control.enabled
        detachControl(rec, t, reason or "dispose")
        state.control.enabled = enabled
      else
        pcall(rec.instance.dispose, rec.instance, t)
      end
    end
  end
end

local function moduleSummary()
  local out = {}
  for key, rec in pairs(state.modules) do
    out[key] = { loaded = rec.loaded, version = rec.version, error = rec.error }
  end
  return out
end

state._loadModules = loadModules  -- exposed for local testing
state._serviceModules = serviceModules

-------------------------------------------------------------------------------
-- Owned input sessions (KB-03)
-------------------------------------------------------------------------------
-- The hardkeys module keeps the ownership records; the bridge binds one session to each TCP client
-- that opens one (session id = the connection's id, never taken from the request) and admits the
-- input.* ops only for the connection's own session. Only the FAKE backend dispatches in this
-- version: "input=fake" is an operator decision made at start or while running, like "lua on".

local function hardkeysRec()
  if not state.running then return nil, "the bridge is not running" end
  local rec = state.modules.hardkeys
  if not rec or not rec.instance then return nil, "the hardkeys module is not loaded" .. (rec and rec.error and (": " .. tostring(rec.error)) or "") end
  local ok, st = pcall(rec.instance.status, rec.instance)
  if not ok or type(st) ~= "table" or st.state ~= "ready" then return nil, "the hardkeys instance is not ready" end
  return rec
end

-- One adapter per backend per module instance record; the keyboard adapter gets the module's own
-- console deps (Keyboard(), Enums.KeyboardCodes, Root().MASTATE, displays).
local function adapterFor(rec, backend)
  local mod = rec.module
  if backend == "fake" then
    if type(mod.fakeBackend) ~= "function" then return nil, "the loaded hardkeys module has no fakeBackend() (module " .. tostring(rec.version) .. ")" end
    if not rec.fakeAdapter then rec.fakeAdapter = mod.fakeBackend() end
    return rec.fakeAdapter
  elseif backend == "keyboard" then
    if type(mod.keyboardBackend) ~= "function" then return nil, "the loaded hardkeys module has no keyboardBackend() (module " .. tostring(rec.version) .. "; KB-04 needs 0.3.0 or newer)" end
    if not rec.keyboardAdapter then rec.keyboardAdapter = mod.keyboardBackend(mod.consoleDeps(_G)) end
    return rec.keyboardAdapter
  elseif backend == "quickey" then
    -- Bound to the bridge's own instance: the bank it provisioned/adopted is the only source of
    -- Quickeys and executors (KB-12); without a bank every press is refused as unavailable.
    if type(mod.quickeyBackend) ~= "function" then return nil, "the loaded hardkeys module has no quickeyBackend() (module " .. tostring(rec.version) .. "; KB-13 needs 0.8.0 or newer)" end
    if not rec.quickeyAdapter then rec.quickeyAdapter = mod.quickeyBackend(rec.instance) end
    return rec.quickeyAdapter
  elseif backend == "mixed" then
    -- KB-15: the two real parts on one instance. The parts are the same cached adapters input=quickey
    -- and input=keyboard use, so records of either are released whichever of the three is attached.
    if type(mod.mixedBackend) ~= "function" then return nil, "the loaded hardkeys module has no mixedBackend() (module " .. tostring(rec.version) .. "; KB-15 needs 0.10.0 or newer)" end
    if not rec.mixedAdapter then
      local q, qerr = adapterFor(rec, "quickey"); if not q then return nil, qerr end
      local k, kerr = adapterFor(rec, "keyboard"); if not k then return nil, kerr end
      rec.mixedAdapter = mod.mixedBackend({ quickey = q, keyboard = k })
    end
    return rec.mixedAdapter
  end
  return nil, "unknown input backend '" .. tostring(backend) .. "'"
end

-- The routing policy goes with the backend (KB-11/KB-13): the Quickey backend serves only the quickkey
-- method, the PC-key backends only the shortcut routes, so the policy is applied in the same step as
-- the adapter (hardkeys 0.8.0 validates it against the new adapter; older modules ignore the argument).
local function routingFor(backend)
  if backend == "quickey" or backend == "mixed" then return { default = "quickkey" } end
  return { default = "shortcut" }
end

enableInputOn = function(rec)
  local adapter, aerr = adapterFor(rec, state.input.backend)
  if not adapter then return false, aerr end
  local ok, err = rec.instance:enableInput(adapter, { routing = routingFor(state.input.backend) })
  if not ok then return false, err and err.message or "enableInput failed" end
  return true
end

local controlSummary  -- defined with the control ops below
local function inputSummary()
  local rec = hardkeysRec()
  local st = rec and rec.instance:status(now()) or nil
  return {
    enabled = state.input.enabled and true or false,
    backend = state.input.backend,
    moduleInputEnabled = st and st.inputEnabled or false,
    sessions = st and st.sessionCount or 0,
    holds = st and st.capacity.used or 0,
    unresolved = st and st.unresolved or 0,
    unresolvedFromPreviousRun = #state.input.unresolved,
    interaction = st and st.activeInteraction or nil,
    sequence = st and st.sequence and st.sequence.state == "running" and st.sequence.id or nil,
    busy = st and st.busy or nil,
    modeChange = st and st.modeChange and { id = st.modeChange.id, state = st.modeChange.state, profile = st.modeChange.profile, original = st.modeChange.original, target = st.modeChange.target, owner = st.modeChange.owner, restoreInMs = st.modeChange.restoreInMs, unresolved = st.modeChange.unresolved and st.modeChange.unresolved.reason or nil } or (type(state.input.mode) == "table" and { state = "kept", id = state.input.mode.id, profile = state.input.mode.profile } or nil),
    retained = st and st.retained or 0,
    quarantined = st and st.quarantined or 0,
    bank = st and st.bank and { provisioned = st.bank.provisioned, id = st.bank.id, state = st.bank.state, codes = st.bank.codeCount, qualified = st.bank.qualifiedCount, problems = st.bank.problemCount } or (type(state.input.bank) == "table" and { provisioned = false, kept = state.input.bank.id } or nil),
    note = "ownership records, not physical key state; see input.status. busy: cmd/set/setfader/lua are refused for every connection while it is set",
  }
end

-- Interaction admission across connections (KB-05): the mutating ops are refused while the hardkeys
-- instance reports itself busy (an open interaction, a running sequence or a held key, of any
-- connection). Returns the module's busy descriptor or nil. Reads and the input recovery ops are
-- never guarded; a bridge without the module (or with it disabled) is never busy.
local GUARDED_OPS = { cmd = "a command", set = "a property change", setfader = "a fader change", lua = "arbitrary Lua" }
local function inputBusy()
  local rec = hardkeysRec()
  if rec and type(rec.instance.admission) == "function" then
    local ok, busy = pcall(rec.instance.admission, rec.instance, now())
    if ok and type(busy) == "table" then return busy end
  end
  -- KB-18: a surface gesture (touch or button down, motion within gestureIdleMs, queued intents) is an
  -- input owner too; a command or fader change from another writer would fight it over one target.
  local crec = state.running and state.modules.control or nil
  if crec and crec.instance and state.control.enabled and type(crec.instance.admission) == "function" then
    local ok, busy = pcall(crec.instance.admission, crec.instance, now())
    if ok and type(busy) == "table" then busy.module = "control"; return busy end
  end
  return nil
end

local function describeInput()
  local s = inputSummary()
  return string.format("input=%s sessions=%d holds=%d unresolved=%d keptFromPreviousRun=%d%s",
    s.enabled and (tostring(s.backend) .. " enabled") or "disabled", s.sessions, s.holds, s.unresolved, s.unresolvedFromPreviousRun,
    s.modeChange and (" modeChange=" .. tostring(s.modeChange.id) .. ":" .. tostring(s.modeChange.state)) or "")
end

-- Hands the records kept from a previous run to the instance as unresolved holds (session
-- "previous-run"), which reserves their tuples. Records the instance cannot take stay kept.
adoptKeptRecords = function(rec)
  if #state.input.unresolved == 0 then return end
  local ok, ad = pcall(rec.instance.adopt, rec.instance, state.input.unresolved, now())
  if not ok then logerr("input: adopting %d kept record(s) failed: %s", #state.input.unresolved, tostring(ad)); return end
  local kept = {}
  for _, rj in ipairs(ad.rejected or {}) do kept[#kept + 1] = rj.record; logerr("input: kept record %s not adopted: %s", tostring(rj.record and rj.record.tupleKey), tostring(rj.reason)) end
  state.input.unresolved = kept
  if #(ad.adopted or {}) > 0 then
    logerr("input: %d unresolved release record(s) from a previous run reserve their keys; run  Plugin \"gma3_mcp_bridge\" \"input recover\"  to release them", #ad.adopted)
  end
end

-- KB-14: the restoration record kept by a previous run becomes an unresolved restoration of session
-- "previous-run"; nothing is written until "input recover" verifies the profile and the state.
adoptKeptMode = function(rec)
  local record = state.input.mode
  if type(record) ~= "table" then return end
  if type(rec.instance.adoptMode) ~= "function" then logerr("input: a keyboard-shortcut mode restoration record is kept but the loaded module has no adoptMode() (module %s)", tostring(rec.version)); return end
  local ok, r, err = pcall(rec.instance.adoptMode, rec.instance, record, now())
  if not ok then logerr("input: adopting the kept mode restoration raised: %s; the record is kept", tostring(r)); return end
  if not r then logerr("input: kept mode restoration not adopted [%s]: %s; the record is dropped", tostring(err and err.code), tostring(err and err.message)); state.input.mode = nil; return end
  state.input.mode = nil
  logerr("input: the keyboard-shortcut mode restoration %s from a previous run is unresolved (profile '%s', shortcuts %s -> %s); every new press is refused until  Plugin \"gma3_mcp_bridge\" \"input recover\"  restores it on that profile",
    tostring(r.id), tostring(r.profile), tostring(r.original), tostring(r.target))
end

-- Operator-only recovery (plugin argument "input recover"): adopt any records still kept from a
-- previous run, then re-attempt every unresolved release of every session. Nothing is retried automatically.
local function inputRecover()
  local rec, err = hardkeysRec()
  if not rec then
    log("input recover: %s; %d record(s) from a previous run are kept", tostring(err), #state.input.unresolved)
    return
  end
  adoptKeptRecords(rec)
  adoptKeptMode(rec)
  -- "input=off" keeps the attached backend, so releases still work then. An instance that never had a
  -- backend attached (the default after a restart) gets the records' OWN backend attached for cleanup
  -- only: input stays disabled, and a record is only ever released through the backend that pressed it.
  local st = rec.instance:status(now())
  if not (st.backend and st.backend.dispatches) then
    -- Records name the part that pressed them (KB-15): keyboard and quickey records together need the
    -- mixed adapter, one kind its own backend, fake records the fake.
    local wanted, kinds = nil, {}
    for _, h in ipairs(st.holds) do
      if h.state ~= "released" and type(h.backend) == "string" then kinds[h.backend] = true end
    end
    if kinds.keyboard and kinds.quickey then wanted = "mixed"
    elseif kinds.keyboard then wanted = "keyboard"
    elseif kinds.quickey then wanted = "quickey"
    elseif kinds.fake then wanted = "fake" end
    if wanted == nil then
      log("input recover: nothing to recover and no backend attached")
    elseif type(rec.instance.attachBackend) ~= "function" then
      logerr("input recover: the loaded hardkeys module cannot attach a backend for cleanup (module %s); enable input first", tostring(rec.version))
    else
      local adapter, aerr = adapterFor(rec, wanted)
      if not adapter then
        logerr("input recover: cannot attach the %s backend for cleanup: %s; the records stay reserved", wanted, tostring(aerr))
      else
        local ok, err = rec.instance:attachBackend(adapter)
        if ok then log("input recover: attached the %s backend for cleanup only (input stays disabled)", wanted)
        else logerr("input recover: attaching the %s backend failed: %s; the records stay reserved", wanted, tostring(err and err.message or err)) end
      end
    end
  end
  local r = rec.instance:recover(nil, now())
  logReleaseResult("input recover", r)
  log("input recover: %d released, %d still unresolved", #(r.released or {}), #(r.unresolved or {}))
  if type(r.restoration) == "table" then
    if r.restoration.state == "restored" then
      log("input recover: keyboard-shortcut mode restoration %s restored (profile '%s', shortcuts back to %s, by %s%s)", tostring(r.restoration.id), tostring(r.restoration.profile), tostring(r.restoration.original), tostring(r.restoration.restoredBy), r.restoration.restoreNote and ("; " .. r.restoration.restoreNote) or "")
    elseif r.restoration.state == "active" then
      log("input recover: keyboard-shortcut mode restoration %s re-validated; the loop restores it %d ms after the last key event (%s)", tostring(r.restoration.id), tonumber(r.restoration.restoreInMs) or 0, tostring(r.restoration.revalidated and r.restoration.revalidated.note))
    else
      logerr("input recover: keyboard-shortcut mode restoration %s still unresolved: %s", tostring(r.restoration.id), tostring(r.restoration.unresolved and r.restoration.unresolved.reason))
    end
  end
end

-- Module errors are tables { code, message, ... }; they travel to handleLine unchanged so the reply can
-- carry the code and the structured detail (partial progress of a combo, the owner of a busy lock, ...).
local function raise(err)
  if type(err) == "table" then error(err, 0) end
  error(tostring(err), 0)
end

local function wantClient(ctx)
  if type(ctx) ~= "table" or type(ctx.client) ~= "table" or ctx.client.id == nil then
    error("[no-connection] input ops need a connection context; sessions are bound to the TCP connection", 0)
  end
  return ctx.client
end

local function inputInstance()
  local rec, err = hardkeysRec()
  if not rec then error("[no-module] " .. tostring(err), 0) end
  return rec
end

local function requireInputEnabled()
  if not state.input.enabled then
    error('[input-disabled] input is disabled on the console. The console operator can enable it with:  Plugin "gma3_mcp_bridge" "input=keyboard"  (real console keys through Keyboard()), ' ..
          '"input=quickey"  (real console keys through the owned Quickey bank, KB-13),  "input=mixed"  (both, KB-15) or  "input=fake"  (lifecycle only), or start the bridge with that argument. input.status, input.sequence.status, input.release, input.releaseAll, input.recover, input.end and input.close remain available.', 0)
  end
  if state.stopRequested then error("[stopping] the bridge is stopping; new input is refused while it releases held keys", 0) end
end

local function ownSession(ctx, mustExist)
  local client = wantClient(ctx)
  if client.session == nil and mustExist then error("[no-session] this connection has no input session; call input.open first", 0) end
  return client, client.session
end

local ops = {}

-- Opens this connection's session. args: leaseMs, label. The session id is derived from the connection.
ops["input.open"] = function(args, ctx)
  local client = wantClient(ctx)
  local rec = inputInstance()
  if client.session ~= nil then
    local st = rec.instance:status(now()).sessions[client.session]
    if st and st.state ~= "closed" then error("[session-exists] this connection already has session '" .. client.session .. "'", 0) end
  end
  local id = "conn-" .. tostring(client.id)
  local s, err = rec.instance:openSession({ id = id, leaseMs = args.leaseMs, label = args.label, binding = "client " .. tostring(client.id) }, now())
  if not s then raise(err) end
  client.session = id
  return { session = s, inputEnabled = state.input.enabled and true or false, backend = state.input.backend }
end

ops["input.renew"] = function(args, ctx)
  local _, sid = ownSession(ctx, true)
  local s, err = inputInstance().instance:renewSession(sid, now(), args.leaseMs)
  if not s then raise(err) end
  return { session = s }
end

ops["input.close"] = function(args, ctx)
  local client, sid = ownSession(ctx, true)
  local r, err = inputInstance().instance:closeSession(sid, now(), "client-close")
  if not r then raise(err) end
  client.session = nil
  logReleaseResult("input: close " .. sid, r)
  return r
end

local function pressSpec(args)
  return { key = args.key, pcKey = args.pcKey, shift = args.shift, ctrl = args.ctrl, alt = args.alt, numlock = args.numlock,
           display = args.display, executor = args.executor, maxHoldMs = args.maxHoldMs, exclusive = args.exclusive, interaction = args.interaction,
           prefer = args.prefer }
end

-- Opens the connection's session on demand (the KB-05 entry points do this so one call suffices).
local function ensureSession(client, rec, args)
  if client.session ~= nil then
    local st = rec.instance:status(now()).sessions[client.session]
    if st and st.state ~= "closed" then return client.session end
  end
  local id = "conn-" .. tostring(client.id)
  local s, err = rec.instance:openSession({ id = id, leaseMs = args.leaseMs, label = args.label, binding = "client " .. tostring(client.id) }, now())
  if not s then raise(err) end
  client.session = id
  return id
end

-- KB-05: a leased interaction for standalone holds across calls. The session is opened on demand.
ops["input.begin"] = function(args, ctx)
  requireInputEnabled()
  local client = wantClient(ctx)
  local rec = inputInstance()
  if type(rec.instance.beginInteraction) ~= "function" then error("[no-module] the loaded hardkeys module has no interactions (KB-05 needs 0.4.0 or newer)", 0) end
  local sid = ensureSession(client, rec, args)
  local ia, err = rec.instance:beginInteraction(sid, now(), { leaseMs = args.leaseMs, label = args.label })
  if not ia then raise(err) end
  log("input: interaction %s begun by %s (%d ms)", ia.id, sid, ia.leaseMs)
  return { interaction = ia, session = sid, inputEnabled = state.input.enabled and true or false, backend = state.input.backend }
end

ops["input.extend"] = function(args, ctx)
  local _, sid = ownSession(ctx, true)
  local ia, err = inputInstance().instance:renewInteraction(sid, args.interaction, now(), args.leaseMs)
  if not ia then raise(err) end
  return { interaction = ia }
end

-- Allowed while input is disabled: ending releases what the interaction holds (recovery path).
ops["input.end"] = function(args, ctx)
  local _, sid = ownSession(ctx, true)
  local r, err = inputInstance().instance:endInteraction(sid, args.interaction, now(), "client-end")
  if not r then raise(err) end
  logReleaseResult("input: end " .. tostring(args.interaction), r)
  return r
end

-- KB-05: a bounded sequence (steps: tap, press, release, combo, text, wait) validated as a whole and then
-- serviced by the loop; the reply reports the sequence running (or already finished when every step was
-- immediate). args.interaction uses an open interaction, otherwise one is begun for the sequence.
ops["input.sequence"] = function(args, ctx)
  requireInputEnabled()
  local client = wantClient(ctx)
  local rec = inputInstance()
  if type(rec.instance.startSequence) ~= "function" then error("[no-module] the loaded hardkeys module has no sequences (KB-05 needs 0.4.0 or newer)", 0) end
  if type(args.steps) ~= "table" then error("[bad-argument] args.steps (list of step tables) is required", 0) end
  local sid = ensureSession(client, rec, args)
  local r, err = rec.instance:startSequence(sid, now(), args.steps, { interaction = args.interaction, leaseMs = args.leaseMs, label = args.label })
  if not r then raise(err) end
  log("input: sequence %s started by %s (%d step(s), ~%d ms)", r.id, sid, r.steps, r.estimateMs or 0)
  return r
end

-- Read-only, readable by anyone: the running sequence or a recently finished one.
ops["input.sequence.status"] = function(args, ctx)
  local inst = inputInstance().instance
  if type(inst.sequenceStatus) ~= "function" then error("[no-module] the loaded hardkeys module has no sequences (KB-05 needs 0.4.0 or newer)", 0) end
  local r, err = inst:sequenceStatus(args.sequence, now())
  if not r then raise(err) end
  return r
end

ops["input.sequence.abort"] = function(args, ctx)
  local _, sid = ownSession(ctx, true)
  local r, err = inputInstance().instance:abortSequence(sid, args.sequence, now(), "client-abort")
  if not r then raise(err) end
  return r
end

ops["input.press"] = function(args, ctx)
  requireInputEnabled()
  local _, sid = ownSession(ctx, true)
  local h, err = inputInstance().instance:press(sid, now(), pressSpec(args))
  if not h then raise(err) end
  return { hold = h }
end

ops["input.tap"] = function(args, ctx)
  requireInputEnabled()
  local _, sid = ownSession(ctx, true)
  local h, err = inputInstance().instance:tap(sid, now(), pressSpec(args), args.holdMs)
  if not h then raise(err) end
  return { hold = h }
end

-- A combination: args.keys = list of press specs pressed in order after every key passed preflight;
-- args.holdMs schedules the release of all of them (newest first) at one deadline. Nothing is
-- dispatched when any key fails validation.
ops["input.combo"] = function(args, ctx)
  requireInputEnabled()
  local _, sid = ownSession(ctx, true)
  local inst = inputInstance().instance
  if type(inst.combo) ~= "function" then error("[no-module] the loaded hardkeys module has no combo() (KB-04 needs 0.3.0 or newer)", 0) end
  if type(args.keys) ~= "table" then error("[bad-argument] args.keys (list of key specs) is required", 0) end
  local specs = {}
  for i, k in ipairs(args.keys) do
    if type(k) ~= "table" then error("[bad-argument] args.keys[" .. i .. "] must be a key spec table", 0) end
    specs[i] = pressSpec(k)
  end
  local r, err = inst:combo(sid, now(), specs, { holdMs = args.holdMs, interaction = args.interaction })
  if not r then raise(err) end
  return r
end

-- Allowed while input is disabled: releasing is part of the recovery path.
ops["input.release"] = function(args, ctx)
  local _, sid = ownSession(ctx, true)
  local selector = args.hold ~= nil and { hold = args.hold } or pressSpec(args)
  local h, err = inputInstance().instance:release(sid, now(), selector)
  if not h then raise(err) end
  if h.attempt then
    local a = h.attempt
    logReleaseResult("input: release " .. sid, { released = a.state == "released" and { a } or {}, unresolved = a.state ~= "released" and { a } or {} })
  end
  return { hold = h }
end

ops["input.releaseAll"] = function(args, ctx)
  local _, sid = ownSession(ctx, true)
  local r, err = inputInstance().instance:releaseAll(sid, now(), "release-all")
  if not r then raise(err) end
  logReleaseResult("input: releaseAll " .. sid, r)
  return r
end

-- Owner-scoped: only this connection's unresolved records. The administrative all-sessions recovery
-- is the console-side plugin argument "input recover".
ops["input.recover"] = function(args, ctx)
  local _, sid = ownSession(ctx, true)
  local r = inputInstance().instance:recover(sid, now())
  logReleaseResult("input: recover " .. sid, r)
  if type(r.restoration) == "table" then log("input: recover %s: keyboard-shortcut mode restoration %s %s", sid, tostring(r.restoration.id), tostring(r.restoration.state)) end
  return r
end

-- KB-11/KB-14: the routing policy of the attached backend. args.policy replaces it (validated against
-- the backend; a refused policy changes nothing); without args.policy the current report is returned.
-- The policy is instance-wide (every connection presses through it), so it needs this connection's
-- session and is refused while any input ownership is active (holds keep their route anyway).
ops["input.routing"] = function(args, ctx)
  local _, sid = ownSession(ctx, true)
  local rec = inputInstance()
  if args.policy == nil then return { routing = rec.instance:routingReport(), session = sid } end
  if type(args.policy) ~= "table" then error("[bad-argument] policy must be an object { default, keys }", 0) end
  if type(rec.instance.configureRouting) ~= "function" then error("[unsupported] the loaded hardkeys module has no configureRouting() (module " .. tostring(rec.version) .. ")", 0) end
  local busy = rec.instance:admission(now())
  if busy and busy.owner ~= sid then error(string.format("[busy] the routing policy is not changed while input ownership is active elsewhere: %s", tostring(busy.description)), 0) end
  local r, err = rec.instance:configureRouting(args.policy)
  if not r then raise(err) end
  log("input: routing policy replaced by %s (default %s, %d override(s))", sid, tostring(r.default), r.overrideCount or 0)
  return { routing = r, session = sid }
end

-- Read-only: how a logical key would be dispatched now (method, effective route, mode change, requirements).
ops["input.route"] = function(args, ctx)
  wantClient(ctx)
  local rec = inputInstance()
  if type(args.key) ~= "string" or args.key == "" then error("[bad-argument] key (logical key name) is required", 0) end
  if type(rec.instance.describeRoute) ~= "function" then error("[unsupported] the loaded hardkeys module has no describeRoute() (module " .. tostring(rec.version) .. ")", 0) end
  return { route = rec.instance:describeRoute(args.key, { prefer = args.prefer, executor = args.executor }) }
end

-- Read-only: never releases anything (the module's status() performs no cleanup).
ops["input.status"] = function(args, ctx)
  local rec, err = hardkeysRec()
  local out = { policy = inputSummary(), session = nil }
  if type(ctx) == "table" and type(ctx.client) == "table" then out.session = ctx.client.session end
  if not rec then out.error = err; return out end
  out.status = rec.instance:status(now())
  out.unresolvedFromPreviousRun = state.input.unresolved
  return out
end

-- Test controls of the fake backend (only while it is the active backend): make the console "fail"
-- or an operator "touch" a key so recovery paths can be exercised live without a real key.
ops["input.fake"] = function(args, ctx)
  wantClient(ctx)
  local rec = inputInstance()
  if state.input.backend ~= "fake" or not rec.fakeAdapter then error("[not-fake] the fake backend is not active", 0) end
  local b = rec.fakeAdapter
  local tuple = { pcKey = args.pcKey, shift = args.shift, ctrl = args.ctrl, alt = args.alt, numlock = args.numlock }
  local action = args.action
  if action == "failRelease" or action == "failPress" then
    if type(args.pcKey) ~= "string" then error("args.pcKey (string) is required", 0) end
    b:failNext(action == "failRelease" and "release" or "press", tuple, args.error or (action .. " (fake)"), args.sticky and true or false)
  elseif action == "clearFailures" then b:clearFailures()
  elseif action == "confirm" then
    if args.mode == "true" or args.mode == true then b:setConfirmMode(true)
    elseif args.mode == "false" or args.mode == false then b:setConfirmMode(false)
    elseif args.mode == "nil" or args.mode == nil then b:setConfirmMode(nil)
    else error("args.mode must be true, false or nil", 0) end
  elseif action == "physicalRelease" then if type(args.pcKey) ~= "string" then error("args.pcKey (string) is required", 0) end; b:physicalRelease(tuple)
  elseif action == "physicalPress" then if type(args.pcKey) ~= "string" then error("args.pcKey (string) is required", 0) end; b:physicalPress(tuple)
  elseif action == "events" or action == nil then -- read-only
  else error("unknown action '" .. tostring(action) .. "' (failRelease, failPress, clearFailures, confirm, physicalRelease, physicalPress, events)", 0) end
  local down = {}
  for k in pairs(b.down) do down[#down + 1] = k end
  table.sort(down)
  return { backend = "fake", events = b.events, down = down, counters = b.counters, confirmMode = b.confirmMode == nil and "nil" or b.confirmMode }
end

ops.ping = function(args)
  local build = {}
  local ok, b = pcall(BuildDetails)
  if ok and type(b) == "table" then
    build.version   = b.BigVersion or b.Version
    build.hostType  = b.HostType
    build.codeType  = b.CodeType
  end
  local showfile
  pcall(function() showfile = Root().MANetSocket:Get("ShowFile") end)
  local hostname
  pcall(function() hostname = Root().maNetSocket.hostname end)
  return {
    bridgeVersion = VERSION,
    host          = state.host,
    port          = state.port,
    luaVersion    = _VERSION,
    requests      = state.requests,
    lua           = luaPolicyInfo(),
    build         = build,
    hostname      = hostname,
    showfile      = showfile,
    user          = (pcall(CurrentUser) and CurrentUser() and CurrentUser().name) or nil,
    modules       = moduleSummary(),
    input         = inputSummary(),
    control       = controlSummary(),
  }
end

-- Read-only report of the console interaction modules this bridge loaded (KB-02). Usable with Lua
-- execution disabled; it performs no input and no show change.
ops.modules = function(args)
  local out = { apiVersion = MODULE_API_VERSION, modules = {} }
  for key, rec in pairs(state.modules) do
    local status
    if rec.instance then
      local ok, st = pcall(rec.instance.status, rec.instance)
      status = ok and st or { error = tostring(st) }
    end
    out.modules[key] = { component = rec.component, loaded = rec.loaded, version = rec.version, apiVersion = rec.apiVersion, error = rec.error, status = status }
  end
  return out
end

-- Read-only console feedback (KB-06): the feedback module's readers through one structured op.
-- Never guarded by the input admission, usable with Lua execution disabled, acquires no interaction
-- and changes no console state. Items are read one after another (not an atomic snapshot); every
-- observation carries observedAt (bridge clock, seconds) and the instance epoch (bumped when the
-- show file, user or profile changed since the previous read, or at every bridge start).
--   args: { all?, items?: [name | {name, params}], readers?: [name], display?, displays?, executors?, sequences?, tokens? }
local function feedbackRec()
  if not state.running then error("[not-running] the bridge is not running", 0) end
  local rec = state.modules.feedback
  if not rec or not rec.instance then error("[no-feedback] the feedback module is not loaded" .. (rec and rec.error and (": " .. tostring(rec.error)) or ""), 0) end
  return rec
end

ops["feedback.describe"] = function(args)
  local rec = feedbackRec()
  local inst = rec.instance
  return { module = rec.component, version = rec.version, apiVersion = rec.apiVersion, readers = inst:describe(), status = inst:status(),
           note = "read-only observations; multiple items are not an atomic snapshot; lastCommand and maState are shared observations, not confirmation of a request or key owner" }
end

ops["feedback.read"] = function(args)
  local rec = feedbackRec()
  local inst, mod = rec.instance, rec.module
  if type(mod.itemsFor) ~= "function" or type(inst.readMany) ~= "function" then error("[no-feedback] the loaded feedback module has no readMany() (module " .. tostring(rec.version) .. "; KB-06 needs 0.2.0 or newer)", 0) end
  local items, limitations = mod.itemsFor(args or {}, inst:status().config)
  if #items == 0 then error("[no-items] nothing to read: pass items, readers, display(s), executors or sequences (feedback.describe lists the readers)", 0) end
  local res = inst:readMany(items, now())
  if res.truncated and res.truncated > 0 then limitations[#limitations + 1] = string.format("%d item(s) beyond the per-request bound were not read", res.truncated) end
  res.limitations = emptyArray(limitations)
  res.items = emptyArray(res.items)
  res.bridgeVersion = VERSION
  res.module = { component = rec.component, version = rec.version }
  res.note = "read-only observations; items are read one after another (not atomic); unavailable items carry reason or error and never a substituted value"
  return res
end

-- KB-17: one bounded snapshot of what each surface control would operate (identity, the authoritative
-- display's encoder bank/page and ordered slots, explicit executor targets) with a binding generation.
-- Read-only, never guarded by the input admission, usable with Lua disabled.
--   args: { display?, executors?: [n], allExecutors?, cached? }
-- cached = true assembles the snapshot from the observations the plugin loop keeps for the watched
-- spec (feedback.watch), so a client can follow console changes at the loop's pace without reading.
local function feedbackContextRec()
  local rec = feedbackRec()
  if type(rec.instance.contextSnapshot) ~= "function" or type(rec.instance.watchContext) ~= "function" then
    error("[no-feedback] the loaded feedback module has no contextSnapshot() (module " .. tostring(rec.version) .. "; KB-17 needs 0.3.0 or newer)", 0)
  end
  return rec
end

local function checkContextArgs(args)
  args = args or {}
  if args.display ~= nil and (type(args.display) ~= "number" or args.display < 1 or args.display ~= math.floor(args.display)) then error("[bad-args] args.display must be a positive integer", 0) end
  if args.executors ~= nil then
    if type(args.executors) ~= "table" then error("[bad-args] args.executors must be a list of executor numbers", 0) end
    for i, n in ipairs(args.executors) do if type(n) ~= "number" then error(string.format("[bad-args] args.executors[%d] is not a number", i), 0) end end
  end
  return args
end

ops["feedback.context"] = function(args)
  local rec = feedbackContextRec()
  args = checkContextArgs(args)
  local snap = rec.instance:contextSnapshot({ display = args.display, executors = args.executors, allExecutors = args.allExecutors == true }, now(), { cached = args.cached == true })
  snap.limitations = emptyArray(snap.limitations)
  snap.executors = emptyArray(snap.executors)
  snap.bridgeVersion = VERSION
  snap.module = { component = rec.component, version = rec.version }
  snap.note = "read-only; items are read one after another (not atomic); the generation changes when an input's meaning changed (bank/page/context, slot objects, resolution/readout/channel function/availability, executor assignment/functions, identity), never for a value or level alone"
  return snap
end

ops["feedback.watch"] = function(args)
  local rec = feedbackContextRec()
  args = checkContextArgs(args)
  local r = rec.instance:watchContext({ display = args.display, executors = args.executors }, now())
  r.limitations = emptyArray(r.limitations)
  r.note = "the plugin loop now keeps these observations (bounded per iteration); feedback.context {cached=true} assembles them without reading; feedback.unwatch stops it"
  return r
end

ops["feedback.unwatch"] = function(args)
  local rec = feedbackRec()
  if type(rec.instance.unwatch) ~= "function" then error("[no-feedback] the loaded feedback module has no unwatch()", 0) end
  rec.instance:unwatch()
  return { watched = 0 }
end

-------------------------------------------------------------------------------
-- Continuous control (KB-18): control.* ops over the gma3_mcp_control module.
-- A client binds the display and executors its controls mean (control.bind, which watches the same
-- context the feedback.context op serves cached), opens a session bound to its connection and submits
-- events stamped with the generation it read. The module admits, orders, coalesces and bounds them and
-- the plugin loop applies at most maxWorkPerService per iteration through the enabled backend.
-------------------------------------------------------------------------------
local CONTROL_MAX_EVENTS_PER_REQUEST = 32

local function controlRec()
  if not state.running then error("[not-running] the bridge is not running", 0) end
  local rec = state.modules.control
  if not rec or not rec.instance then error("[no-module] the control module is not loaded" .. (rec and rec.error and (": " .. tostring(rec.error)) or ""), 0) end
  return rec
end

local function requireControlEnabled()
  if state.stopRequested then error("[stopping] the bridge is stopping", 0) end
  if not state.control.enabled then
    error('[control-disabled] continuous control is disabled on the console. The console operator can enable it with:  Plugin "gma3_mcp_bridge" "control=fake"  (intents recorded, nothing moves; KB-18) or  Plugin "gma3_mcp_bridge" "control=console"  (attribute adjustments for encoder slots; KB-19), or start the bridge with that argument. control.bind, control.status, control.close and control.recover remain available.', 0)
  end
end

local function controlSession(ctx, mustExist)
  local client = wantClient(ctx)
  if client.controlSession == nil then
    if mustExist then error("[no-session] this connection has no control session (control.open first)", 0) end
    return client, nil
  end
  return client, client.controlSession
end

local function ensureControlSession(client, rec, args)
  if client.controlSession ~= nil then
    local st = rec.instance:status(now()).sessions[client.controlSession]
    if st and st.state == "active" then return client.controlSession end
  end
  local id = "conn-" .. tostring(client.id)
  local s, err = rec.instance:openSession({ id = id, leaseMs = args.leaseMs, label = args.label, binding = "client " .. tostring(client.id) }, now())
  if not s then raise(err) end
  client.controlSession = id
  return id
end

controlSummary = function()
  local rec = state.running and state.modules.control or nil
  local inst = rec and rec.instance
  local st
  if inst then local ok, v = pcall(inst.status, inst, now()); st = ok and v or nil end
  local sessions, gestures, queued = 0, 0, 0
  for _, sv in pairs(st and st.sessions or {}) do sessions = sessions + 1; gestures = gestures + (sv.gestures or 0); queued = queued + (sv.queued or 0) end
  return {
    enabled = state.control.enabled and true or false, backend = state.control.backend,
    moduleInputEnabled = st and st.inputEnabled or false, sessions = sessions, gestures = gestures, queued = queued,
    unresolved = st and #st.unresolved or 0, unresolvedFromPreviousRun = #state.control.unresolved,
    spec = state.control.spec, counters = st and st.counters or nil,
    note = state.control.backend == "console" and "KB-19: relative motion on attribute slots is applied as Attribute \"<name>\" At +/- <amount> for the selection; KB-20: a strip touch holds the slot and moves nothing, a position is Attribute \"<name>\" At <value> over the verified travel (mixed values need takeover); presses and executors are refused unsupported" or "KB-18: admission, ordering, coalescing and bounds; the fake backend records intents and moves nothing on the console (control=console applies attribute adjustments, KB-19)",
    backendStatus = st and st.backendStatus or nil,
  }
end

-- Binds what this bridge's control events mean: the authoritative display and the executors. The
-- feedback instance watches that context so the plugin loop keeps it observed; the module compares
-- every event's generation with the cached snapshot's. Never guarded, usable with Lua disabled.
--   args: { display?, executors?: [n] }
ops["control.bind"] = function(args)
  controlRec()
  local frec = feedbackContextRec()
  args = checkContextArgs(args)
  local spec = { display = args.display, executors = args.executors }
  local w = frec.instance:watchContext(spec, now())
  state.control.spec = spec
  local snap = frec.instance:contextSnapshot(spec, now(), { cached = true })
  -- Binding identity (review): generations are per spec, so a replaced spec can carry the same number.
  -- The module turns a changed spec into a new binding revision (queued motion dropped, holds rebound)
  -- and events should carry it as `binding`; an old revision is refused stale-binding.
  local crec = controlRec()
  local info = type(crec.instance.bindingInfo) == "function" and crec.instance:bindingInfo(now()) or nil
  return { bound = spec, watched = w.watched, limitations = emptyArray(w.limitations), generation = snap.generation, generationUnknown = snap.generationUnknown or nil,
           generationNote = snap.generationNote, notObserved = snap.notObserved, stale = snap.stale or nil,
           binding = info and info.revision or nil, bindingKey = snap.bindingKey,
           note = "events carry this generation (and binding revision); feedback.context {cached=true} follows it; a stale, unknown or replaced binding refuses motion until the client rebinds" }
end

ops["control.open"] = function(args, ctx)
  local client = wantClient(ctx)
  local rec = controlRec()
  if client.controlSession ~= nil then
    local st = rec.instance:status(now()).sessions[client.controlSession]
    if st and st.state == "active" then error("[session-exists] this connection already has control session '" .. client.controlSession .. "'", 0) end
  end
  local id = "conn-" .. tostring(client.id)
  local s, err = rec.instance:openSession({ id = id, leaseMs = args.leaseMs, label = args.label, binding = "client " .. tostring(client.id) }, now())
  if not s then raise(err) end
  client.controlSession = id
  return { session = s, controlEnabled = state.control.enabled and true or false, backend = state.control.backend, spec = state.control.spec }
end

ops["control.renew"] = function(args, ctx)
  local _, sid = controlSession(ctx, true)
  local s, err = controlRec().instance:renewSession(sid, now(), args.leaseMs)
  if not s then raise(err) end
  return { session = s }
end

ops["control.close"] = function(args, ctx)
  local client, sid = controlSession(ctx, true)
  local r, err = controlRec().instance:closeSession(sid, now(), "client-close")
  if not r then raise(err) end
  client.controlSession = nil
  return r
end

-- Submits one event or a batch (args.events, at most CONTROL_MAX_EVENTS_PER_REQUEST) in order. Each
-- outcome is reported in place: { accepted, queued, coalesced, lost, ... } or { refused = code, ... }.
-- The session is opened on demand. A refusal never stops the batch: a surface's later events (a
-- release above all) are admitted on their own merits.
ops["control.submit"] = function(args, ctx)
  requireControlEnabled()
  local client = wantClient(ctx)
  local rec = controlRec()
  local sid = ensureControlSession(client, rec, args)
  local events = args.events
  if events == nil and args.event ~= nil then events = { args.event } end
  if type(events) ~= "table" or #events == 0 then error("[bad-args] args.events (a list of events) or args.event is required", 0) end
  if #events > CONTROL_MAX_EVENTS_PER_REQUEST then error(string.format("[bad-args] at most %d events per request (got %d)", CONTROL_MAX_EVENTS_PER_REQUEST, #events), 0) end
  local t = now()
  local out = { session = sid, outcomes = {}, accepted = 0, refused = 0, lost = 0 }
  for i, ev in ipairs(events) do
    local r, err = rec.instance:submit(sid, t, ev)
    if r then
      out.accepted = out.accepted + 1
      out.lost = out.lost + (r.lost or 0)
      out.outcomes[i] = r
    else
      out.refused = out.refused + 1
      local o = { refused = err.code, message = err.message }
      for k, v in pairs(err) do if k ~= "code" and k ~= "message" then o[k] = v end end
      out.outcomes[i] = o
    end
  end
  out.outcomes = emptyArray(out.outcomes)
  return out
end

ops["control.status"] = function(args, ctx)
  local rec = controlRec()
  local st = rec.instance:status(now())
  st.sessions = st.sessions or {}
  st.events = emptyArray(st.events)
  st.unresolved = emptyArray(st.unresolved)
  st.unresolvedFromPreviousRun = emptyArray(state.control.unresolved)
  st.controlEnabled = state.control.enabled and true or false
  st.policyBackend = state.control.backend
  st.spec = state.control.spec
  st.binding = type(rec.instance.bindingInfo) == "function" and rec.instance:bindingInfo(now()) or nil
  st.busy = rec.instance:admission(now())
  st.limitations = emptyArray(rec.module.LIMITATIONS)
  local client = ctx and ctx.client
  st.yourSession = client and client.controlSession or nil
  st.bridgeVersion = VERSION
  return st
end

ops["control.recover"] = function(args)
  local rec = controlRec()
  local adopted = 0
  if #state.control.unresolved > 0 then
    local a = rec.instance:adopt(state.control.unresolved, now())
    adopted = a.adopted
    state.control.unresolved = {}
  end
  local r = rec.instance:recover(now())
  r.adopted = adopted
  r.resolved = emptyArray(r.resolved)
  r.unresolved = emptyArray(r.unresolved)
  return r
end

ops.cmd = function(args)
  local command = args.command or args.cmd
  if type(command) ~= "string" or command == "" then error("args.command (string) is required") end
  local feedback = Cmd(command)
  return { command = command, feedback = feedback }
end

ops.lua = function(args)
  if not state.lua.enabled then
    error('Lua execution is disabled on the console. The console operator can enable it with:  Plugin "gma3_mcp_bridge" "lua on"  ' ..
          '(or start the bridge with  Plugin "gma3_mcp_bridge" "lua"). The structured ops (cmd, object, children, set, ...) remain available.', 0)
  end
  local code = args.code
  if type(code) ~= "string" then error("args.code (string) is required") end
  local env = sandboxEnv()
  local fn, err = load("return " .. code, "=mcp", "t", env)
  if not fn then
    fn, err = load(code, "=mcp", "t", env)
  end
  if not fn then error("Lua compile error: " .. tostring(err)) end
  -- A request may tighten the console budget, never loosen it.
  local maxMs, maxSteps = state.lua.maxMs, state.lua.maxSteps
  local reqMs = tonumber(args.maxMs)
  if reqMs and reqMs > 0 and (not maxMs or maxMs <= 0 or reqMs < maxMs) then maxMs = reqMs end
  local reqSteps = tonumber(args.maxSteps)
  if reqSteps and reqSteps > 0 and (not maxSteps or maxSteps <= 0 or reqSteps < maxSteps) then maxSteps = reqSteps end
  local results = runBounded(fn, maxMs, maxSteps)
  local out = {}
  for i = 1, results.n do
    local v = toJsonSafe(results[i])
    if v == nil then v = "<nil>" end
    out[i] = v
  end
  if #out == 0 then setmetatable(out, { __jsontype = "array" }) end
  return { values = out, budget = results.budget }
end

ops.object = function(args)
  local h = resolve(args.ref)
  local res = handleSummary(h)
  res.parent = (function()
    local p = safeCall(h, "Parent")
    if p then return { name = safeProp(p, "name"), class = safeCall(p, "GetClass"), addr = safeCall(p, "Addr") } end
    return nil
  end)()
  if args.properties ~= false then
    res.properties = objectProperties(h, args.asText ~= false)
  end
  if args.schema then
    res.schema = propertyNames(h)
  end
  if args.children then
    res.children = listChildren(h, args.childFields, args.childLimit or 100, args.childOffset or 0, args.asText ~= false)
  end
  pcall(function() res.hasActivePlayback = h:HasActivePlayback() end)
  return res
end

ops.children = function(args)
  local h = resolve(args.ref)
  return listChildren(h, args.fields, args.limit, args.offset, args.asText ~= false, args.playback == true)
end

ops.objects = function(args)
  -- Resolve a command-line range (e.g. "Fixture 1 Thru 10") to summaries with optional fields.
  local list = resolveMany(args.ref)
  local out = {}
  local limit = tonumber(args.limit) or 500
  local offset = tonumber(args.offset) or 0
  for i = offset + 1, math.min(#list, offset + limit) do
    table.insert(out, childSummary(list[i], args.fields, args.asText ~= false))
  end
  if #out == 0 then setmetatable(out, { __jsontype = "array" }) end
  return { total = #list, offset = offset, count = #out, items = out }
end

ops.dump = function(args)
  local h = resolve(args.ref)
  local ok, text = pcall(h.Dump, h)
  if not ok then error("Dump failed: " .. tostring(text)) end
  return { dump = text }
end

ops.set = function(args)
  local h = resolve(args.ref)
  if type(args.property) ~= "string" then error("args.property (string) is required") end
  local value = args.value
  if value == nil then error("args.value is required") end
  if type(value) ~= "string" then value = tostring(value) end
  local ok, err = pcall(h.Set, h, args.property, value)
  if not ok then error("Set failed: " .. tostring(err)) end
  local newValue = getProp(h, args.property, true)
  return { ref = args.ref, property = args.property, value = newValue }
end

ops.setfader = function(args)
  local h = resolve(args.ref)
  local t = { value = tonumber(args.value) }
  if t.value == nil then error("args.value (number 0..100) is required") end
  if args.token then t.token = args.token end
  if args.enabled ~= nil then t.faderEnabled = args.enabled and true or false end
  local ok, err = pcall(h.SetFader, h, t)
  if not ok then error("SetFader failed: " .. tostring(err)) end
  local okG, v = pcall(h.GetFader, h, { token = args.token })
  return { ref = args.ref, token = args.token or "FaderMaster", value = okG and v or nil }
end

ops.getfader = function(args)
  local h = resolve(args.ref)
  local tokens = args.tokens or { "FaderMaster" }
  local out = {}
  for _, tok in ipairs(tokens) do
    local ok, v = pcall(h.GetFader, h, { token = tok })
    local okT, txt = pcall(h.GetFaderText, h, { token = tok })
    out[tok] = { value = ok and v or nil, text = okT and txt or nil }
  end
  return { ref = args.ref, faders = out }
end

ops.executor = function(args)
  local n = tonumber(args.number)
  if not n then error("args.number is required") end
  local exec, page = GetExecutor(n)
  if not exec then return { number = n, empty = true } end
  local res = { number = n, executor = handleSummary(exec), page = page and handleSummary(page) or nil }
  res.properties = objectProperties(exec, true)
  local assigned = safeProp(exec, "Object")
  if isHandle(assigned) then
    res.assigned = handleSummary(assigned)
    pcall(function() res.assigned.hasActivePlayback = assigned:HasActivePlayback() end)
    local okF, fv = pcall(assigned.GetFader, assigned, {})
    if okF then res.assigned.faderMaster = fv end
  end
  return res
end

local function executorInfo(n)
  local exec, page = GetExecutor(n)
  if not exec then return nil end
  local res = { number = n, name = safeProp(exec, "name"), addr = safeCall(exec, "Addr") }
  local assigned = safeProp(exec, "Object")
  if isHandle(assigned) then
    res.assigned = handleSummary(assigned)
    pcall(function() res.assigned.hasActivePlayback = assigned:HasActivePlayback() end)
    local okF, fv = pcall(assigned.GetFader, assigned, {})
    if okF then res.faderMaster = fv end
    local okT, ft = pcall(assigned.GetFaderText, assigned, {})
    if okT then res.faderText = ft end
  end
  for _, prop in ipairs({ "Key", "Fader", "Encoder", "EncoderLeft", "EncoderRight", "Width", "Height" }) do
    local v = getProp(exec, prop, true)
    if v ~= nil and v ~= "" then res[prop] = v end
  end
  return res, page
end

ops.executors = function(args)
  local from = tonumber(args.from) or 101
  local to = tonumber(args.to) or 315
  local onlyAssigned = args.onlyAssigned ~= false
  local out = {}
  local pageInfo
  for n = from, to do
    local info, page = executorInfo(n)
    if page and not pageInfo then pageInfo = handleSummary(page) end
    if info and (info.assigned or not onlyAssigned) then table.insert(out, info) end
  end
  if #out == 0 then setmetatable(out, { __jsontype = "array" }) end
  local cur
  pcall(function() cur = handleSummary(CurrentExecPage()) end)
  return { page = pageInfo or cur, from = from, to = to, count = #out, executors = out }
end

ops.api = function(args)
  local out = { free = {}, object = {} }
  local ok, t = pcall(GetApiDescriptor)
  if ok and type(t) == "table" then out.free = toJsonSafe(t) end
  local ok2, t2 = pcall(GetObjApiDescriptor)
  if ok2 and type(t2) == "table" then out.object = toJsonSafe(t2) end
  return out
end

-------------------------------------------------------------------------------
-- Structured inspection ops (FR-07 .. FR-10). Read-only; not gated by state.lua.enabled.
-------------------------------------------------------------------------------

-- FR-07: attribute discovery for one (sub)fixture.
--   args: { ref = "Fixture 601" | "Fixture 501.3", limit, offset, includeChannelSets }
ops.fixtureAttributes = function(args)
  local fx, main = resolveFixture(args.ref)
  local limit, offset = pageArgs(args, 100, 500)
  local includeSets = args.includeChannelSets == true
  local limitations = {}
  local res = fixtureIdentity(fx, main)
  res.subfixtures = listSubfixtures(fx)
  res.subfixtureCount = #res.subfixtures
  local rtRows, rtSource = fixtureRtChannels(fx, main, limitations)
  local rows = uiChannelAttributes(fx, includeSets, rtRows, limitations)
  if rows then
    res.source = "uiChannels"
  else
    rows = fixtureTypeAttributes(main, includeSets, rtRows, limitations)
    res.source = "fixtureTypeWalk"
  end
  res.channels = emptyArray(rtRows or {})
  res.channelsSource = rtSource
  if rtRows and #rtRows == 0 and fx == main then table.insert(limitations, "no RT channels: the fixture has no DMX addresses (unpatched) so dmx mappings are omitted") end
  local page = paginate(rows, limit, offset)
  res.total, res.offset, res.count, res.attributes = page.total, page.offset, page.count, page.items
  res.includeChannelSets = includeSets
  res.limitations = emptyArray(limitations)
  return res
end

-- FR-08: programmer content per UI channel.
--   args: { scope = "all" | "selection" | "fixtures", fixtures = "Fixture 1 Thru 5", limit, offset, maxChannels }
ops.programmer = function(args)
  local scope = args.scope or "all"
  local limit, offset = pageArgs(args, 200, 5000)
  local maxChannels = math.floor(tonumber(args.maxChannels) or 5000)
  if maxChannels < 1 then maxChannels = 1 elseif maxChannels > 50000 then maxChannels = 50000 end
  local limitations, indices = {}, {}
  local rootFidOf = {}
  local enumerated = true
  if scope == "selection" then
    local ok, t = callApi("SelectionTable")
    if ok and type(t) == "table" then
      for _, v in ipairs(t) do if type(v) == "number" then indices[#indices + 1] = math.floor(v) end end
    else
      enumerated = false
      table.insert(limitations, "the current selection could not be enumerated: " .. (ok and ("SelectionTable returned " .. type(t)) or tostring(t)))
    end
  elseif scope == "fixtures" then
    if type(args.fixtures) ~= "string" or args.fixtures == "" then error("args.fixtures (string) is required for scope 'fixtures'") end
    local list = resolveMany(args.fixtures)
    local seen = {}
    for _, h in ipairs(list) do
      -- Remember which top-level fixture each expanded index belongs to (compound fixtures put
      -- their values on the cells, whose own FID is "None").
      local before = #indices
      collectSubfixtureIndices(h, indices, seen, 0, limitations)
      local rootFid = textProp(h, "FID")
      for i = before + 1, #indices do rootFidOf[indices[i]] = rootFid end
    end
    if #indices == 0 then
      enumerated = false
      table.insert(limitations, string.format("no (sub)fixture patch indices could be read for '%s'", args.fixtures))
    end
  elseif scope == "all" then
    local ok, n = callApi("GetSubfixtureCount")
    if ok and type(n) == "number" then
      for i = 1, math.floor(n) - 1 do indices[#indices + 1] = i end
    else
      enumerated = false
      table.insert(limitations, "the patch could not be enumerated: " .. (ok and ("GetSubfixtureCount returned " .. type(n)) or tostring(n)))
    end
  else
    error("args.scope must be one of all, selection, fixtures")
  end

  local coverage = { complete = false, scannedFixtures = 0, totalFixtures = #indices, scannedChannels = 0 }
  local stats = { channelsWithData = 0, channelsWithStepsButInactiveMask = 0, channelErrors = 0 }
  local rows, attrCache = {}, {}
  local stopped, firstError = nil, nil
  -- The scanned (sub)fixtures themselves, so a client can tell "no programmer value" from
  -- "not scanned" per fixture. Bounded; `fixturesTruncated` says when the list was cut.
  local FIXTURE_LIST_MAX = 1000
  local fixtureList, fixturesTruncated = {}, false
  for i, idx in ipairs(indices) do
    if coverage.scannedChannels >= maxChannels then
      stopped = string.format("channel budget (%d) reached before (sub)fixture index %d", maxChannels, idx)
      break
    end
    local okS, sf = callApi("GetSubfixture", idx)
    if not (okS and isHandle(sf)) then sf = nil end
    local entry = nil
    if #fixtureList < FIXTURE_LIST_MAX then
      local fid = sf and textProp(sf, "FID") or nil
      entry = { subfixtureIndex = idx, fid = fid, name = sf and safeProp(sf, "name") or nil, rootFid = rootFidOf[idx] or fid, attributes = {} }
      fixtureList[#fixtureList + 1] = entry
    else
      fixturesTruncated = true
    end
    local okU, uis = callApi("GetUIChannels", idx, false)
    if okU and type(uis) == "table" then
      local seenAttr = {}
      for _, u in ipairs(uis) do
        local ui = uiIndexOf(u)
        if ui ~= nil then
          coverage.scannedChannels = coverage.scannedChannels + 1
          -- The attributes this (sub)fixture has, so a client can tell "no value" from "no such
          -- attribute here" per cell. Same cache as programmerRow.
          if entry then
            local attr = attrCache[ui]
            if attr == nil then
              local okA, a = callApi("GetAttributeByUIChannel", ui)
              attr = (okA and isHandle(a)) and a or false
              attrCache[ui] = attr
            end
            local an = attr and safeProp(attr, "name") or nil
            if an and not seenAttr[an] then seenAttr[an] = true; entry.attributes[#entry.attributes + 1] = an end
          end
          local okP, p = callApi("GetProgPhaser", ui, false)
          if not okP then
            stats.channelErrors = stats.channelErrors + 1
            firstError = firstError or tostring(p)
          elseif type(p) == "table" then
            local row = programmerRow(p, ui, idx, sf, attrCache, stats)
            if row then rows[#rows + 1] = row end
          end
        end
      end
    else
      stats.channelErrors = stats.channelErrors + 1
      firstError = firstError or (okU and ("GetUIChannels returned " .. type(uis)) or tostring(uis))
    end
    coverage.scannedFixtures = i
  end
  coverage.complete = enumerated and stopped == nil and coverage.scannedFixtures == #indices and stats.channelErrors == 0
  if stopped then table.insert(limitations, stopped .. "; raise maxChannels or narrow the scope") end
  if firstError then table.insert(limitations, string.format("%d channel/fixture read(s) failed, first error: %s", stats.channelErrors, firstError)) end
  if stats.channelsWithStepsButInactiveMask > 0 then
    table.insert(limitations, string.format("%d channel(s) returned step data with all activity masks zero and were treated as empty", stats.channelsWithStepsButInactiveMask))
  end
  local page = paginate(rows, limit, offset)
  return {
    scope = scope, fixtures = args.fixtures, source = "programmer",
    note = "rows are programmer content read with GetProgPhaser; they are not output values (use fixtureOutput or dmx for output)",
    coverage = coverage, stats = stats, maxChannels = maxChannels,
    selectionCount = scope == "selection" and #indices or nil,
    scannedFixtures = (function() for _, e in ipairs(fixtureList) do emptyArray(e.attributes) end return emptyArray(fixtureList) end)(),
    fixturesTruncated = fixturesTruncated,
    total = page.total, offset = page.offset, count = page.count, rows = page.items,
    limitations = emptyArray(limitations),
  }
end

-- FR-09: DMX output per RT channel of one (sub)fixture.
--   args: { ref, nonzeroOnly, limit, offset }
ops.fixtureOutput = function(args)
  local fx, main = resolveFixture(args.ref)
  local limit, offset = pageArgs(args, 200, 2000)
  local nonzeroOnly = args.nonzeroOnly == true
  local limitations = {}
  local res = fixtureIdentity(fx, main)
  local rts, rtSource = fixtureRtChannels(fx, main, limitations)
  rts = rts or {}
  local metaMap, metaSource = {}, nil
  if #rts > 0 then metaMap, metaSource = channelMetaMap(fx, main, rts, limitations) end
  local notGranted, rows = {}, {}
  for _, rt in ipairs(rts) do
    local row = { rtIndex = rt.rtIndex, channel = rt.channel, coarse = rt.coarse, fine = rt.fine, ultra = rt.ultra, bits = rt.bits, default = rt.default }
    local raw, complete, anyAddr = 0, true, false
    for _, part in ipairs({ "coarse", "fine", "ultra" }) do
      local u, a = parseDmxAddr(rt[part])
      if u then
        anyAddr = true
        if part == "coarse" then row.universe, row.address = u, a end
        local ok, v = callApi("GetDMXValue", a, u, false)
        if ok and type(v) == "number" then
          v = math.floor(v)
          raw = raw * 256 + v
          row[part .. "Value"] = v
        else
          complete = false
          if not notGranted[u] then
            notGranted[u] = true
            table.insert(limitations, string.format("universe %d not granted: GetDMXValue returned %s", u, ok and "nil" or ("an error (" .. tostring(v) .. ")")))
          end
        end
      end
    end
    if not anyAddr then
      row.patched = false
    else
      row.patched = true
      if complete then
        row.value = raw
        row.unit = "raw" .. tostring(rt.bits)
        row.percent = round4(raw / (2 ^ rt.bits - 1) * 100)
      end
    end
    local e = rt.channel and metaMap[rt.channel] or nil
    if e then
      row.attribute = e.attribute
      row.attributeIndex = e.attributeIndex
      row.physicalUnit = e.physicalUnit
      local cf = pickFunction(e.functions, e.defaultFunction, row.value, rt.bits)
      if cf then
        row.channelFunction = cf.channelFunction
        if row.value ~= nil then
          local ph = toPhysical(row.value, rt.bits, cf)
          if ph ~= nil then
            row.physical, row.physicalFrom, row.physicalTo = ph, cf.physicalFrom, cf.physicalTo
            row.conversion = "linear from channel function"
          end
          local cs = pickChannelSet(cf.channelSets, row.value, rt.bits)
          if cs then row.channelSet = cs.name end
        end
      end
      if (e.logicalCount or 1) > 1 then row.note = "DMX channel has several logical channels; the first is shown" end
    end
    if not (nonzeroOnly and row.value == 0) then rows[#rows + 1] = row end
  end
  if #rts == 0 and fx == main then table.insert(limitations, "the fixture has no RT channels (unpatched or no DMX mode); there is no output to read") end
  res.channelsSource = rtSource
  res.metaSource = metaSource
  table.insert(limitations, "per-attribute cooked output is not exposed by the 2.5.1 Lua API; values are raw DMX output per RT channel, physical is derived linearly from the channel function range")
  local page = paginate(rows, limit, offset)
  res.source = "dmx output"
  res.note = "DMX output as the console sends it (8-bit per address, combined to 16/24-bit per RT channel); programmer values are not included"
  res.unit = "raw per row (see bits: raw8, raw16 or raw24) plus derived percent"
  res.nonzeroOnly = nonzeroOnly
  res.total, res.offset, res.count, res.channels = page.total, page.offset, page.count, page.items
  res.limitations = emptyArray(limitations)
  return res
end

-- FR-09: raw universe read.
--   args: { universe, from, to, nonzeroOnly, percent, patched }
ops.dmx = function(args)
  local universe = tonumber(args.universe)
  if not universe or universe ~= math.floor(universe) then error("args.universe must be an integer") end
  local maxU = 1024
  pcall(function()
    local c = Patch().DmxUniverses:Count()
    if type(c) == "number" and c > 0 then maxU = c end
  end)
  if universe < 1 or universe > maxU then error(string.format("args.universe must be between 1 and %d", maxU)) end
  local from = tonumber(args.from) or 1
  local to = tonumber(args.to) or from
  if from ~= math.floor(from) or to ~= math.floor(to) then error("args.from and args.to must be integers") end
  if from < 1 or from > 512 or to < 1 or to > 512 then error("args.from and args.to must be between 1 and 512") end
  if from > to then error("args.from must be <= args.to") end
  local percent = args.percent == true
  local nonzeroOnly = args.nonzeroOnly == true
  local limitations, values = {}, {}
  local info = universeInfo(universe)
  local granted, readVia
  local okU, tbl = callApi("GetDMXUniverse", universe, percent)
  if okU and type(tbl) == "table" then
    granted, readVia = true, "GetDMXUniverse"
    for ch = from, to do
      local v = tbl[ch]
      if type(v) == "number" and (not nonzeroOnly or v ~= 0) then values[#values + 1] = { channel = ch, value = v } end
    end
  else
    readVia = "GetDMXValue"
    local anyValue, okAny = false, false
    for ch = from, to do
      local ok, v = callApi("GetDMXValue", ch, universe, percent)
      if ok then okAny = true end
      if ok and type(v) == "number" then
        anyValue = true
        if not nonzeroOnly or v ~= 0 then values[#values + 1] = { channel = ch, value = v } end
      end
    end
    if anyValue then
      granted = true
    elseif okAny then
      granted = false
      table.insert(limitations, string.format("universe %d not granted: the console returned nil for every address (DmxUniverse Granted = %s)", universe, tostring(info and info.granted)))
    else
      table.insert(limitations, "GetDMXUniverse and GetDMXValue are unavailable: " .. tostring(tbl))
    end
  end
  if info and info.granted ~= nil and granted ~= nil and info.granted ~= granted then
    table.insert(limitations, "the DmxUniverse Granted property disagrees with the read result; the read result is reported")
  end
  local patched
  if args.patched == true then
    local map = patchMap(limitations)
    if map then
      patched = "rtChannels"
      for _, v in ipairs(values) do
        local hit = map[string.format("%d.%d", universe, v.channel)]
        if hit then v.patched = hit else v.patched = false end
      end
    end
  else
    table.insert(limitations, "patch lookup not performed (set patched: true to map addresses to fixtures through the RT channels)")
  end
  return {
    universe = universe, granted = granted, universeInfo = info, from = from, to = to,
    unit = percent and "percent" or "raw8", nonzeroOnly = nonzeroOnly, readVia = readVia, patched = patched,
    count = #values, values = emptyArray(values), source = "dmx output",
    note = "DMX output per address as the console sends it; programmer values are not included",
    limitations = emptyArray(limitations),
  }
end

-- FR-10: stored cue content that the 2.5.1 API exposes (cue/part properties, recipes, preset references).
--   args: { ref = "Sequence 1 Cue 2" } or { sequence, cue }, plus part, fixtures, expandPresets
ops.cueContents = function(args)
  local ref = args.ref
  if ref == nil then
    if args.sequence == nil or args.cue == nil then error("args.ref, or args.sequence and args.cue, are required") end
    local seq = tostring(args.sequence)
    local seqRef = seq:match("^%d+$") and ("Sequence " .. seq) or ('Sequence "' .. seq .. '"')
    ref = seqRef .. " Cue " .. tostring(args.cue)
  end
  local cue = resolve(ref)
  local cls = safeCall(cue, "GetClass")
  if cls ~= "Cue" then error(string.format("'%s' resolved to a %s, not a Cue", ref, tostring(cls))) end
  local limitations = {}
  local seq = safeCall(cue, "Parent")
  local children = safeCall(cue, "Children") or {}
  local res = {
    ref = ref, source = "cue object tree (recipes and preset references only)", trackedValues = "not_reconstructed",
    sequence = seq and { name = safeProp(seq, "name"), tracking = textProp(seq, "Tracking"), priority = textProp(seq, "Priority") } or nil,
    cue = {
      no = textProp(cue, "No"), name = safeProp(cue, "name"), trigType = textProp(cue, "TrigType"), trigTime = textProp(cue, "TrigTime"),
      trigSound = textProp(cue, "TrigSound"), release = textProp(cue, "Release"), assert = textProp(cue, "Assert"),
      allowDuplicates = textProp(cue, "AllowDuplicates"), mibPreference = textProp(cue, "MibPreference"), ["break"] = textProp(cue, "Break"),
      note = textProp(cue, "Note"), partCount = #children,
    },
    parts = {}, presets = {},
  }
  local wantPart = tonumber(args.part)
  local fidFilter
  if args.fixtures ~= nil and args.fixtures ~= "" then
    fidFilter = {}
    for _, h in ipairs(resolveMany(args.fixtures)) do
      local f = textProp(h, "FID")
      if f then fidFilter[tostring(f)] = true end
    end
  end
  local expand = args.expandPresets == true
  local anyOwnData = false
  for _, part in ipairs(children) do
    local pno = numProp(part, "Part")
    if wantPart == nil or pno == wantPart then
      local p = {
        part = pno, name = safeProp(part, "name"), cuePart = textProp(part, "CuePart"),
        timing = {
          cueFade = textProp(part, "CueFade"), cueDelay = textProp(part, "CueDelay"), cueInFade = textProp(part, "CueInFade"), cueInDelay = textProp(part, "CueInDelay"),
          cueOutFade = textProp(part, "CueOutFade"), cueOutDelay = textProp(part, "CueOutDelay"), snapDelay = textProp(part, "SnapDelay"),
          duration = textProp(part, "Duration"), indivFade = textProp(part, "IndivFade"), indivDelay = textProp(part, "IndivDelay"),
          transition = textProp(part, "Transition"), trackingDistance = textProp(part, "TrackingDistance"),
        },
        command = { text = textProp(part, "Command"), delay = textProp(part, "CommandDelay"), enabled = yesNo(textProp(part, "CommandEnabled")) },
        mib = { mode = textProp(part, "MibMode"), target = textProp(part, "MibTarget"), fade = textProp(part, "MibFade"), delay = textProp(part, "MibDelay") },
        ownDataPresent = yesNo(textProp(part, "OwnDataPresent")), ownNonCookedDataPresent = yesNo(textProp(part, "OwnNonCookedDataPresent")),
        memoryType = textProp(part, "MemoryType"), recipes = {}, otherChildren = {},
      }
      for _, r in ipairs(safeCall(part, "Children") or {}) do
        if safeCall(r, "GetClass") == "StandardRecipe" then
          local presetH = handleProp(r, "Preset")
          local rec = {
            index = safeCall(r, "Index"), name = safeProp(r, "name"), enabled = yesNo(textProp(r, "Enabled")),
            selection = textProp(r, "Selection"), selectionMode = textProp(r, "SelectionMode"), preset = textProp(r, "Preset"), values = textProp(r, "Values"),
            fadeX = textProp(r, "FadeX"), delayX = textProp(r, "DelayX"), speedX = textProp(r, "SpeedX"), phaseX = textProp(r, "PhaseX"),
            matricks = textProp(r, "MAtricks"), filter = textProp(r, "Filter"), generator = textProp(r, "Generator"),
          }
          if presetH then
            rec.presetRef = { name = safeProp(presetH, "name"), addrNative = safeCall(presetH, "AddrNative"), addr = safeCall(presetH, "Addr"), class = safeCall(presetH, "GetClass") }
            rec.presetResolved = true
            if expand then
              local key = rec.presetRef.addrNative or rec.presetRef.addr or rec.presetRef.name or tostring(rec.preset)
              rec.presetDataKey = key
              if res.presets[key] == nil then res.presets[key] = merge({ preset = rec.presetRef }, expandPreset(presetH, fidFilter, limitations)) end
            end
          elseif rec.preset ~= nil then
            rec.presetResolved = false
            table.insert(limitations, string.format("part %s recipe %s references preset %s which did not resolve to an object", tostring(pno), tostring(rec.index), tostring(rec.preset)))
          end
          p.recipes[#p.recipes + 1] = rec
        else
          p.otherChildren[#p.otherChildren + 1] = { name = safeProp(r, "name"), class = safeCall(r, "GetClass") }
        end
      end
      emptyArray(p.recipes)
      emptyArray(p.otherChildren)
      if p.ownDataPresent == true then anyOwnData = true end
      res.parts[#res.parts + 1] = p
    end
  end
  if wantPart ~= nil and #res.parts == 0 then error(string.format("'%s' has no Part %s", ref, tostring(wantPart))) end
  emptyArray(res.parts)
  if anyOwnData then
    table.insert(limitations, "hard (non-recipe) fixture values stored in a cue part are not exposed by the 2.5.1 Lua API (no GetCueData); only recipe and preset references are readable")
  end
  table.insert(limitations, "tracked values are not reconstructed: a part lists only what is stored in it; attributes tracked from earlier cues are absent")
  if fidFilter then
    if expand then
      table.insert(limitations, "fixtures filter applied to expanded preset data (by_fixtures) only; recipe selections (groups/ranges) were not expanded")
    else
      table.insert(limitations, "fixtures filter not applied: recipe selections are not expanded and presets were not expanded (set expandPresets)")
    end
  end
  if not expand then res.presets = nil end
  res.expandPresets = expand
  res.limitations = emptyArray(limitations)
  return res
end

ops.stop = function(args)
  state.stopRequested = true
  return { stopping = true }
end

-------------------------------------------------------------------------------
-- Server loop
-------------------------------------------------------------------------------

local function sendAll(sock, data)
  local index = 1
  local tries = 0
  while index <= #data do
    local sent, err, last = sock:send(data, index)
    if sent then
      index = sent + 1
    elseif err == "timeout" then
      index = (last or (index - 1)) + 1
      tries = tries + 1
      if tries > 2000 then return false end
      coroutine.yield()
    else
      return false
    end
  end
  return true
end

-- Error replies: "error" is always "[code] message" (first line only), "code" the bracketed code when
-- there is one, and "detail" the module's structured error table (partial progress, owner, lease) when
-- the op raised one. A string error keeps its text; a "[code]" prefix in it is reported as the code.
local function errorReply(id, opName, err)
  local msg, code, detail
  if type(err) == "table" then
    code = err.code
    msg = tostring(err.message or code or "error")
    if code then msg = "[" .. tostring(code) .. "] " .. msg end
    detail = toJsonSafe(err)
  else
    msg = tostring(err)
    code = msg:match("^%[([%w%-%.]+)%]")
  end
  local firstLine = msg:match("^([^\n]*)") or msg
  appendLog(string.format("request %s failed: %s", tostring(opName), firstLine))
  return encode({ id = id, ok = false, error = firstLine, code = code, detail = detail })
end

local function handleLine(client, line)
  state.requests = state.requests + 1
  local okD, req = pcall(json.decode, line)
  if not okD or type(req) ~= "table" then
    return encode({ ok = false, error = "invalid JSON request" })
  end
  local id = req.id
  local op = ops[req.op or ""]
  if not op then
    return encode({ id = id, ok = false, error = "unknown op '" .. tostring(req.op) .. "'" })
  end
  local args = req.args or {}
  local ctx = { client = client, now = now() }
  -- Interaction admission (KB-05): a mutating op is refused while input ownership is active anywhere.
  local guard = GUARDED_OPS[req.op]
  if guard then
    local busy = inputBusy()
    if busy then
      local e = { code = "busy", message = string.format("%s is refused while input ownership is active: %s. Reads stay available; the owner ends its interaction (input.end), releases its keys, or the sequence finishes first",
                                                         guard, tostring(busy.description)), reason = busy.reason, owner = busy.owner, interaction = busy.interaction, sequence = busy.sequence, hold = busy.hold, remainingMs = busy.remainingMs,
                  module = busy.module, device = busy.device, control = busy.control }
      return errorReply(id, req.op, e)
    end
  end
  local okR, result = xpcall(function() return op(args, ctx) end, debug.traceback)
  if okR then
    return encode({ id = id, ok = true, result = toJsonSafe(result) })
  end
  return errorReply(id, req.op, result)
end

state._handleLine = handleLine  -- exposed for local testing

-- Closing a connection ends its input session: every key it still holds gets a release attempt and
-- the outcome is logged. A failed or unconfirmed release stays as an unresolved record.
local function releaseClientSession(c, reason)
  if not c then return end
  if c.controlSession ~= nil then
    local crec = state.modules.control
    if crec and crec.instance then
      local ok, r = pcall(crec.instance.closeSession, crec.instance, c.controlSession, now(), reason)
      if ok and type(r) == "table" then
        for _, e in ipairs(r.ended or {}) do log("control: %s %s: %s on %s/%s ended (%s)", tostring(reason), tostring(c.controlSession), tostring(e.kind), tostring(e.device), tostring(e.control), tostring(e.outcome)) end
        for _, u in ipairs(r.unresolved or {}) do logerr("control: %s %s: UNRESOLVED %s release on %s/%s: %s", tostring(reason), tostring(c.controlSession), tostring(u.kind), tostring(u.device), tostring(u.control), tostring(u.error)) end
      elseif not ok then logerr("control: closing session %s on %s failed: %s", tostring(c.controlSession), tostring(reason), tostring(r)) end
    end
    c.controlSession = nil
  end
  if c.session == nil then return end
  local rec = hardkeysRec()
  if rec then
    local ok, r = pcall(rec.instance.closeSession, rec.instance, c.session, now(), reason)
    if ok and type(r) == "table" then logReleaseResult("input: " .. tostring(reason) .. " " .. tostring(c.session), r)
    else logerr("input: closing session %s on %s failed: %s", tostring(c.session), tostring(reason), tostring(r)) end
  end
  c.session = nil
end

local function closeClient(i, reason)
  local c = state.clients[i]
  if c then
    releaseClientSession(c, reason or "disconnect")
    pcall(function() c.sock:close() end)
  end
  table.remove(state.clients, i)
end
state._closeClient = closeClient  -- exposed for local testing

local function serverMain()
  local server, err = socket.bind(state.host, state.port)
  if not server then
    logerr("could not bind %s:%d (%s)", state.host, state.port, tostring(err))
    state.running = false
    disposeModules("bind-failed")
    return
  end
  server:settimeout(0)
  state.server = server
  log("listening on %s:%d (v%s); Lua execution %s; %s", state.host, state.port, VERSION, describeLuaPolicy(), describeInput())
  if not state.lua.enabled then
    log('Lua execution (gma3_lua) is off; enable it with  Plugin "gma3_mcp_bridge" "lua on"')
  end

  while state.running and not state.stopRequested do
    serviceModules(socket.gettime())
    -- accept new clients
    local c = server:accept()
    if c then
      -- Belt and braces: the socket is bound to loopback, so a non-loopback peer should be
      -- impossible. Refuse it anyway rather than hand out console control.
      local peer = nil
      pcall(function() peer = c:getpeername() end)
      if peer ~= nil and peer ~= "127.0.0.1" then
        logerr("rejected connection from %s: the bridge only accepts loopback clients", tostring(peer))
        pcall(function() c:close() end)
      else
        c:settimeout(0)
        pcall(function() c:setoption("tcp-nodelay", true) end)
        state.nextClientId = state.nextClientId + 1
        table.insert(state.clients, { sock = c, buf = "", id = state.nextClientId })
        log("client %d connected (%d total)", state.nextClientId, #state.clients)
      end
    end

    -- service existing clients
    for i = #state.clients, 1, -1 do
      local cl = state.clients[i]
      local closed = false
      for _ = 1, 64 do
        local line, rerr, partial = cl.sock:receive("*l")
        if line then
          local full = cl.buf .. line
          cl.buf = ""
          if full ~= "" then
            local response = handleLine(cl, full)
            if not sendAll(cl.sock, response .. "\n") then closed = true; break end
          end
        else
          if partial and partial ~= "" then cl.buf = cl.buf .. partial end
          if rerr == "closed" then closed = true end
          break
        end
      end
      if closed then
        closeClient(i)
        log("client disconnected (%d total)", #state.clients)
      end
    end

    coroutine.yield()
  end

  for i = #state.clients, 1, -1 do closeClient(i, "shutdown") end
  pcall(function() server:close() end)
  state.server = nil
  state.running = false
  state.stopRequested = false
  disposeModules("shutdown")
  log("stopped")
end

-------------------------------------------------------------------------------
-- Entry point
-------------------------------------------------------------------------------

-- Parse the plugin argument into tokens. Returns a table or nil, err.
--   stop | status            commands
--   <port>                   listen port (bind address is always 127.0.0.1)
--   lua | lua=on|off | lua on | lua off | nolua
--   luatime=<ms>  luasteps=<n>   Lua execution budget (0 = unlimited)
--   luahook=preserve|replace  keep the console's own hook on the plugin thread (default; no hard
--                             quota while it is present) or replace it with the budget hook
--   input=keyboard | input=fake | input=quickey | input=mixed | input=off | noinput
--                            owned input sessions on the console keyboard backend (KB-04), the owned
--                            Quickey backend (KB-13), both on one instance (KB-15), the fake backend
--                            (KB-03 lifecycle only) or disabled
--   input status | input recover       print input state / operator recovery of unresolved releases
--   bank=<quickey>/<page>.<first>[-<last>]  provision the Quickey bank (KB-12); bankcodes=hardkeys|qualified
--   bank status | bank verify | bank teardown
local function parseArgument(argument)
  local opts = {}
  local text = argument and tostring(argument) or ""
  local prev = nil
  for tok in text:gmatch("[^%s,]+") do
    local l = tok:lower()
    local key, val = l:match("^(%a+)=(.*)$")
    if (l == "status" or l == "recover") and prev == "input" then
      opts.command = "input-" .. l
    elseif (l == "status" or l == "recover") and prev == "control" then
      opts.command = "control-" .. l
    elseif (l == "status" or l == "verify" or l == "teardown") and prev == "bank" then
      opts.command = "bank-" .. l
    elseif l == "bank" then
      opts.bankToken = true  -- followed by "status", "verify" or "teardown"
    elseif key == "bank" then
      local q, page, first, last = val:match("^(%d+)/(%d+)%.(%d+)%-(%d+)$")
      if not q then q, page, first = val:match("^(%d+)/(%d+)%.(%d+)$") end
      if not q then return nil, string.format("\"%s\": expected bank=<quickey>/<page>.<first>[-<last>], e.g. bank=900/1.190-197", tok) end
      local count = last and (tonumber(last) - tonumber(first) + 1) or nil
      if last and count < 1 then return nil, string.format("\"%s\": the executor range is empty", tok) end
      opts.bank = { quickeyFirst = tonumber(q), page = tonumber(page), executorFirst = tonumber(first), executorCount = count }
    elseif key == "bankcodes" then
      if val == "hardkeys" or val == "qualified" then opts.bankCodes = val
      else return nil, string.format("\"%s\": expected bankcodes=hardkeys or bankcodes=qualified", tok) end
    elseif l == "stop" or l == "status" then
      opts.command = l
    elseif l == "control" then
      opts.controlToken = true  -- followed by "status" or "recover"
    elseif l == "nocontrol" then
      opts.control = false
    elseif key == "control" then
      if val == "fake" or val == "console" then opts.control, opts.controlBackend = true, val
      elseif val == "off" or val == "0" or val == "no" or val == "false" or val == "none" then opts.control = false
      else return nil, string.format("\"%s\": expected control=fake, control=console or control=off", tok) end
    elseif l == "input" then
      opts.inputToken = true  -- followed by "status" or "recover"; alone it is an error (no default backend)
    elseif l == "noinput" then
      opts.input = false
    elseif key == "input" then
      if val == "fake" then opts.input, opts.inputBackend = true, "fake"
      elseif val == "keyboard" or val == "kb" then opts.input, opts.inputBackend = true, "keyboard"
      elseif val == "quickey" or val == "quickkey" or val == "qk" then opts.input, opts.inputBackend = true, "quickey"
      elseif val == "mixed" or val == "quickey+keyboard" or val == "keyboard+quickey" or val == "qk+kb" or val == "kb+qk" then opts.input, opts.inputBackend = true, "mixed"
      elseif val == "off" or val == "0" or val == "no" or val == "false" or val == "none" then opts.input = false
      else return nil, string.format("\"%s\": expected input=keyboard, input=fake, input=quickey, input=mixed or input=off", tok) end
    elseif l == "lua" then
      opts.lua = true
    elseif l == "nolua" then
      opts.lua = false
    elseif (l == "on" or l == "off") and prev == "lua" then
      opts.lua = (l == "on")
    elseif key == "lua" then
      if val == "on" or val == "1" or val == "yes" or val == "true" then opts.lua = true
      elseif val == "off" or val == "0" or val == "no" or val == "false" then opts.lua = false
      else return nil, string.format("\"%s\": expected lua=on or lua=off", tok) end
    elseif key == "luahook" then
      if val == "preserve" or val == "replace" then opts.hookMode = val
      else return nil, string.format("\"%s\": expected luahook=preserve or luahook=replace", tok) end
    elseif key == "luatime" or key == "luasteps" then
      local n = tonumber(val)
      if not n or n < 0 or n ~= math.floor(n) then return nil, string.format("\"%s\": expected a non-negative integer", tok) end
      if key == "luatime" then opts.maxMs = n else opts.maxSteps = n end
    elseif tok:find(":", 1, true) then
      return nil, string.format("\"%s\" looks like a bind address, but the bridge only listens on 127.0.0.1. " ..
        "Pass just a port number; for remote access use an SSH tunnel (ssh -L 9800:127.0.0.1:9800 ...).", tok)
    elseif l:match("^%d+$") then
      local port = tonumber(l)
      if not port or port < 1 or port > 65535 then return nil, string.format("\"%s\" is not a valid port number (expected 1-65535)", tok) end
      opts.port = port
    else
      return nil, string.format("\"%s\" is not a recognised argument (expected a port number, \"stop\", \"status\", \"lua\", \"lua on|off\", \"luatime=<ms>\", \"luasteps=<n>\", \"luahook=preserve|replace\", \"input=keyboard|fake|quickey|mixed|off\", \"input status\", \"input recover\", \"bank=<quickey>/<page>.<first>-<last>\", \"bankcodes=hardkeys|qualified\", \"bank status\", \"bank verify\", \"bank teardown\", \"control=fake|console|off\", \"control status\" or \"control recover\")", tok)
    end
    prev = l
  end
  if opts.inputToken and opts.command == nil and opts.input == nil then
    return nil, "\"input\": expected input=keyboard, input=fake, input=quickey, input=mixed, input=off, \"input status\" or \"input recover\" (there is no default input backend)"
  end
  if opts.bankToken and not (opts.command and opts.command:match("^bank%-")) and opts.bank == nil then
    return nil, "\"bank\": expected bank=<quickey>/<page>.<first>[-<last>], \"bank status\", \"bank verify\" or \"bank teardown\" (there is no default range)"
  end
  if opts.bankCodes and not opts.bank then return nil, "\"bankcodes\" needs a bank=... range in the same argument" end
  if opts.controlToken and opts.command == nil and opts.control == nil then
    return nil, "\"control\": expected control=fake, control=console, control=off, \"control status\" or \"control recover\" (there is no default backend)"
  end
  return opts
end

local function applyLuaPolicy(opts)
  if opts.lua ~= nil then state.lua.enabled = opts.lua end
  if opts.maxMs ~= nil then state.lua.maxMs = opts.maxMs end
  if opts.maxSteps ~= nil then state.lua.maxSteps = opts.maxSteps end
  if opts.hookMode ~= nil then state.lua.hookMode = opts.hookMode end
end

-- Enabling attaches the fake adapter to the running hardkeys instance; disabling asks it to release
-- every held key and keeps whatever could not be released as unresolved records.
local function applyInputPolicy(opts)
  if opts.input == nil then return end
  local rec = hardkeysRec()
  if opts.input then
    -- A refused switch (e.g. records of the other backend still exist) leaves the previous policy intact.
    local prevBackend, prevEnabled = state.input.backend, state.input.enabled
    state.input.backend = opts.inputBackend or "fake"
    if rec then
      local ok, err = enableInputOn(rec)
      if not ok then
        state.input.backend, state.input.enabled = prevBackend, prevEnabled
        logerr("input: %s; input stays %s", tostring(err), prevEnabled and (tostring(prevBackend) .. " enabled") or "disabled")
        return
      end
    end
    state.input.enabled = true
    log("input now enabled on the %s backend (%s)", state.input.backend, state.input.backend == "fake" and "nothing reaches the console"
      or (state.input.backend == "quickey" and "console keys are really pressed through the owned Quickey bank on its reserved executors; logical keys use the quickkey method"
      or state.input.backend == "mixed" and "console keys are really pressed: Quickeys through the owned bank on its reserved executors (the quickkey default), PC keys and text through Keyboard() for per-key overrides; never both kinds down at once"
      or "console keys are really pressed through Keyboard()"))
  else
    state.input.enabled = false
    if rec then
      local ok, r = pcall(rec.instance.disableInput, rec.instance, now(), "input-disabled")
      if ok then logReleaseResult("input: disable", r) else logerr("input: disableInput failed: %s", tostring(r)) end
    end
    log("input now disabled (%s)", describeInput())
  end
end

-- Continuous control (KB-18/KB-19): the chosen backend is attached to the running control instance
-- (fake: intents recorded; console: attribute adjustments through Cmd()); switching backends or
-- disabling ends every gesture through the previous backend and drops queued motion.
local function applyControlPolicy(opts)
  if opts.control == nil then return end
  local rec = state.running and state.modules.control or nil
  if rec and not rec.instance then rec = nil end
  if opts.control then
    local backend = opts.controlBackend or "fake"
    if rec then
      if state.control.enabled and state.control.backend ~= backend then
        local okD, r = pcall(rec.instance.disableInput, rec.instance, now(), "backend-switch")
        if okD and type(r) == "table" then
          for _, e in ipairs(r.ended or {}) do log("control: switching to %s: %s on %s/%s ended on %s: %s", backend, tostring(e.kind), tostring(e.device), tostring(e.control), tostring(state.control.backend), tostring(e.outcome)) end
          if (r.dropped or 0) > 0 then log("control: switching to %s: %d queued intent(s) dropped", backend, r.dropped) end
        end
      end
      local okA, err = pcall(function()
        if backend == "console" then
          if type(rec.module.consoleBackend) ~= "function" then error("the loaded control module " .. tostring(rec.version) .. " has no console backend (0.2.0 or newer is needed)", 0) end
          rec.instance:enableInput(rec.module.consoleBackend(rec.module.consoleDeps(_G)))
        else
          rec.instance:enableInput(rec.module.fakeBackend())
        end
      end)
      if not okA then logerr("control: %s; control stays %s", tostring(err), state.control.enabled and "enabled" or "disabled"); return end
      if #state.control.unresolved > 0 then
        local a = rec.instance:adopt(state.control.unresolved, now())
        state.control.unresolved = {}
        log("control: adopted %d unresolved release(s) from a previous run ('control recover' re-attempts them)", a.adopted)
      end
    else
      logerr("control: the module is not loaded; the policy is recorded for the next start")
    end
    state.control.enabled, state.control.backend = true, backend
    if backend == "console" then
      log("control now enabled on the console backend: relative motion on attribute slots is applied as Attribute \"<name>\" At +/- <amount> for the selection (KB-19); strip touches hold the slot and positions are Attribute \"<name>\" At <value> (KB-20); presses and executors are refused unsupported")
    else
      log("control now enabled on the fake backend (intents are recorded; nothing moves on the console)")
    end
  else
    state.control.enabled = false
    if rec then
      local ok, r = pcall(rec.instance.disableInput, rec.instance, now(), "control-disabled")
      if ok and type(r) == "table" then
        for _, e in ipairs(r.ended or {}) do log("control: disable: %s on %s/%s ended: %s", tostring(e.kind), tostring(e.device), tostring(e.control), tostring(e.outcome)) end
        if (r.dropped or 0) > 0 then log("control: disable: %d queued intent(s) dropped", r.dropped) end
      else logerr("control: disableInput failed: %s", tostring(r)) end
    end
    log("control now disabled")
  end
end

-- Quickey bank (KB-12): operator-only provisioning through the plugin argument. The module does the
-- preflight, creation, verification and rollback; the bridge logs the outcome and keeps the record.
local function logBankSummary(prefix, b)
  if type(b) ~= "table" then return end
  if not b.provisioned then log("%s: no bank (%s)", prefix, tostring(b.note)); return end
  log("%s: bank %s state=%s codes=%d (qualified %d, discovered %d) problems=%d quickeys from %d, executors page %d %d-%d show='%s'",
    prefix, tostring(b.id), tostring(b.state), b.codeCount or 0, b.qualifiedCount or 0, b.discoveredCount or 0, b.problemCount or 0,
    b.spec.quickeys.first, b.spec.executors.page, b.spec.executors.first, b.spec.executors.first + b.spec.executors.count - 1, tostring(b.show))
  for _, p in ipairs(b.problems or {}) do logerr("%s: problem %s %s: %s", prefix, tostring(p.kind), tostring(p.index or p.executor or ""), tostring(p.detail)) end
end

local function bankInstance(what)
  local rec, err = hardkeysRec()
  if not rec then logerr("bank %s: %s", what, tostring(err)); return nil end
  if type(rec.instance.provisionBank) ~= "function" then logerr("bank %s: the loaded hardkeys module has no Quickey bank (module %s; KB-12 needs 0.7.0 or newer)", what, tostring(rec.version)); return nil end
  return rec
end

local function applyBankPolicy(opts)
  if not opts.bank then return end
  local rec = bankInstance("provision")
  if not rec then return end
  local spec = { authorized = true, quickeys = { first = opts.bank.quickeyFirst },
                 executors = { page = opts.bank.page, first = opts.bank.executorFirst, count = opts.bank.executorCount }, codes = opts.bankCodes }
  local ok, r, err = pcall(rec.instance.provisionBank, rec.instance, spec, now())
  if not ok then logerr("bank provision: raised: %s", tostring(r)); return end
  if not r then
    logerr("bank provision refused [%s]: %s", tostring(err and err.code), tostring(err and err.message))
    for _, rf in ipairs(err and err.refusals or {}) do logerr("bank provision: %s %s: %s", tostring(rf.reason), tostring(rf.index or rf.executor or ""), tostring(rf.detail)) end
    for _, k in ipairs(err and err.kept or {}) do logerr("bank provision: Quickey %d (%s) created in this call was KEPT: %s", k.index, tostring(k.code), tostring(k.reason)) end
    return
  end
  state.input.bank = r.record
  log("bank provision: %d Quickey(s) created, %d reused", r.created or 0, r.reused or 0)
  logBankSummary("bank provision", r)
end

-- At start: a record kept from the previous run is adopted (every object re-verified; nothing created).
adoptKeptBank = function(rec)
  local record = state.input.bank
  if type(record) ~= "table" then return end
  if type(rec.instance.adoptBank) ~= "function" then logerr("bank: a record is kept but the loaded module has no adoptBank() (module %s)", tostring(rec.version)); return end
  local ok, r, err = pcall(rec.instance.adoptBank, rec.instance, record, now())
  if not ok then logerr("bank adopt: raised: %s; the record is kept", tostring(r)); return end
  if not r then logerr("bank adopt refused [%s]: %s; the record is dropped (provision again with bank=...)", tostring(err and err.code), tostring(err and err.message)); state.input.bank = nil; return end
  logBankSummary("bank adopt", r)
end

local function MainImpl(display_handle, argument)
  local opts, perr = parseArgument(argument)
  if not opts then
    logerr("refusing argument: %s", perr)
    return
  end

  if opts.command == "stop" then
    if state.running then
      state.stopRequested = true
      log("stop requested")
    else
      log("not running")
    end
    return
  end

  -- Control invocations: they read and print, they never release keys (the running bridge owns them).
  if opts.command == "status" then
    log("running=%s bind=%s:%d clients=%d requests=%d lua=%s %s", tostring(state.running), state.host, state.port, #state.clients, state.requests, describeLuaPolicy(), describeInput())
    return
  end
  if opts.command == "input-status" then
    log("%s", describeInput())
    local rec = hardkeysRec()
    if rec then
      local st = rec.instance:status(now())
      for id, sess in pairs(st.sessions) do log("input session %s: %s lease %s ms remaining=%s holds=%d (%s)", id, sess.state, tostring(sess.leaseMs), tostring(sess.remainingMs), sess.holds, tostring(sess.binding)) end
      for id, ia in pairs(st.interactions or {}) do if ia.state == "open" then log("input interaction %s: session %s, %s ms left, holds=%d%s", id, ia.session, tostring(ia.remainingMs), ia.holds, ia.sequence and (" sequence " .. ia.sequence) or "") end end
      if st.sequence and st.sequence.state == "running" then log("input sequence %s: session %s step %d of %d", st.sequence.id, st.sequence.session, st.sequence.index, st.sequence.steps) end
      if st.busy then log("input busy: %s (%s); cmd/set/setfader/lua are refused for every connection", tostring(st.busy.reason), tostring(st.busy.owner)) end
      for _, h in ipairs(st.holds) do
        if h.state ~= "released" then
          log("input hold %s: %s %s(%s) session %s held %s ms%s%s", h.id, h.state, tostring(h.logical or "raw"), h.tupleKey, h.session, tostring(h.heldMs),
            h.unresolved and (" UNRESOLVED: " .. tostring(h.unresolved.reason)) or "", h.routeMismatch and (" ROUTE CHANGED: " .. tostring(h.routeMismatch.reason)) or "")
        end
      end
    end
    for _, r in ipairs(state.input.unresolved) do log("input kept from previous run: %s(%s) session %s: %s", tostring(r.logical or "raw"), tostring(r.tupleKey), tostring(r.session), tostring(r.unresolved and r.unresolved.reason)) end
    return
  end
  if opts.command == "input-recover" then
    inputRecover()
    return
  end
  if opts.command == "control-status" then
    local c = controlSummary()
    log("control=%s sessions=%d gestures=%d queued=%d unresolved=%d keptFromPreviousRun=%d spec=%s", c.enabled and (tostring(c.backend) .. " enabled") or "disabled", c.sessions, c.gestures, c.queued, c.unresolved, c.unresolvedFromPreviousRun,
      c.spec and json.encode(c.spec) or "none")
    local rec = state.running and state.modules.control or nil
    if rec and rec.instance then
      local st = rec.instance:status(now())
      for id, sv in pairs(st.sessions) do
        log("control session %s: %s lease %s ms remaining=%s queued=%d gestures=%d admitted=%d applied=%d refused=%d lost=%d coalesced=%d", id, sv.state, tostring(sv.leaseMs), tostring(sv.remainingMs), sv.queued, sv.gestures,
          sv.counters.admitted, sv.counters.applied, sv.counters.refused, sv.counters.lost, sv.counters.coalesced)
        for _, g in ipairs(sv.gestureList or {}) do log("control gesture: %s on %s/%s target=%s generation=%s%s", g.kind, g.device, g.control, json.encode(g.target), tostring(g.generation), g.rebound and " REBOUND (release and re-touch)" or "") end
      end
      for _, u in ipairs(st.unresolved) do logerr("control UNRESOLVED: %s release on %s/%s session %s: %s", tostring(u.kind), tostring(u.device), tostring(u.control), tostring(u.session), tostring(u.error)) end
      local busy = rec.instance:admission(now())
      if busy then log("control busy: %s; cmd/set/setfader/lua are refused for every connection", tostring(busy.description)) end
    end
    for _, u in ipairs(state.control.unresolved) do log("control kept from previous run: %s release on %s/%s: %s", tostring(u.kind), tostring(u.device), tostring(u.control), tostring(u.error)) end
    return
  end
  if opts.command == "control-recover" then
    local rec = state.running and state.modules.control or nil
    if not rec or not rec.instance then logerr("control recover: the bridge is not running or the module is not loaded"); return end
    if not rec.instance:backendAvailable() then rec.instance:attachBackend(rec.module.fakeBackend()) end
    if #state.control.unresolved > 0 then
      local a = rec.instance:adopt(state.control.unresolved, now()); state.control.unresolved = {}
      log("control recover: adopted %d record(s) from a previous run", a.adopted)
    end
    local r = rec.instance:recover(now())
    log("control recover: %d resolved, %d still unresolved", #r.resolved, #r.unresolved)
    for _, u in ipairs(r.unresolved) do logerr("control recover: still UNRESOLVED %s release on %s/%s: %s", tostring(u.kind), tostring(u.device), tostring(u.control), tostring(u.error)) end
    return
  end
  if opts.command == "bank-status" or opts.command == "bank-verify" or opts.command == "bank-teardown" then
    local rec = bankInstance(opts.command:sub(6))
    if not rec then
      if type(state.input) == "table" and type(state.input.bank) == "table" then log("bank: a record from a previous run is kept (%s, %d codes); it is re-verified at the next start", tostring(state.input.bank.id), #(state.input.bank.codes or {})) end
      return
    end
    local inst = rec.instance
    if opts.command == "bank-status" then
      local b = inst:bankStatus(now())
      logBankSummary("bank status", b)
      for _, c in ipairs(b.codes or {}) do
        if c.state ~= "ok" or c.qualified then
          log("bank code %s: Quickey %d value %d %s%s%s", c.name, c.index, c.value or -1, c.qualified and ("qualified tap=" .. tostring(c.qualified.tap) .. " hold=" .. tostring(c.qualified.hold) .. " chord=" .. tostring(c.qualified.chord)) or "discovered",
            c.state ~= "ok" and (" " .. string.upper(tostring(c.state)) .. ": " .. tostring(c.problem)) or "", c.note and (" (" .. c.note .. ")") or "")
        end
      end
      for _, x in ipairs(b.executors or {}) do if x.state ~= "reserved" then log("bank executor %d.%d: %s%s%s", x.page, x.index, x.state, x.assigned and (" " .. x.assigned) or "", x.problem and (": " .. x.problem) or "") end end
      for _, e in ipairs(b.exclusions or {}) do log("bank excluded %s (%s): %s", tostring(e.name), tostring(e.value), tostring(e.reason)) end
    elseif opts.command == "bank-verify" then
      local ok, r, err = pcall(inst.verifyBank, inst, now())
      if not ok then logerr("bank verify: raised: %s", tostring(r))
      elseif not r then logerr("bank verify refused [%s]: %s", tostring(err and err.code), tostring(err and err.message))
      else state.input.bank = r.record; logBankSummary("bank verify", r) end
    else
      local ok, r, err = pcall(inst.teardownBank, inst, now(), { authorized = true })
      if not ok then logerr("bank teardown: raised: %s", tostring(r))
      elseif not r then logerr("bank teardown refused [%s]: %s", tostring(err and err.code), tostring(err and err.message))
      else
        log("bank teardown: %d Quickey(s) removed, %d executor(s) cleared, %d object(s) skipped%s", #(r.removed or {}), #(r.cleared or {}), #(r.skipped or {}), r.complete and "; the bank is gone" or "; the bank is PARTIAL (skipped objects are left alone, not ours as they stand)")
        for _, s in ipairs(r.skipped or {}) do logerr("bank teardown: skipped %s: %s", tostring(s.index and ("Quickey " .. s.index) or s.executor), tostring(s.reason)) end
        if r.complete then state.input.bank = nil else state.input.bank = r.record end
      end
    end
    return
  end

  if state.running then
    if opts.port then
      log("already running on port %d (use argument \"stop\" to stop)", state.port)
      return
    end
    local changed = false
    if opts.lua ~= nil or opts.maxMs ~= nil or opts.maxSteps ~= nil or opts.hookMode ~= nil then
      applyLuaPolicy(opts)
      log("Lua execution now %s", describeLuaPolicy())
      changed = true
    end
    if opts.input ~= nil then
      applyInputPolicy(opts)
      changed = true
    end
    if opts.control ~= nil then
      applyControlPolicy(opts)
      changed = true
    end
    if opts.bank then
      applyBankPolicy(opts)
      changed = true
    end
    if not changed then
      log("already running on port %d (use argument \"stop\" to stop)", state.port)
    end
    return
  end

  -- The bind address is always 127.0.0.1: the bridge has no authentication, so it must never be
  -- reachable from the network. Remote clients forward the port over SSH instead (README.md,
  -- "Remote access over SSH").
  state.host = BIND_HOST
  state.port = opts.port or DEFAULT_PORT
  -- Each start establishes the Lua execution policy explicitly; it never carries over from an
  -- earlier run, so enabling Lua is always a visible decision in the start command.
  state.lua = { enabled = LUA_DEFAULT_ENABLED, maxMs = LUA_DEFAULT_MAX_MS, maxSteps = LUA_DEFAULT_MAX_STEPS, hookMode = LUA_DEFAULT_HOOK_MODE }
  applyLuaPolicy(opts)
  -- Input is likewise an explicit per-start decision; only the unresolved records carry over.
  state.input = { enabled = opts.input == true, backend = opts.input == true and (opts.inputBackend or "fake") or nil, unresolved = state.input.unresolved or {}, bank = state.input.bank, mode = state.input.mode }
  -- Continuous control (KB-18) is an explicit per-start decision as well; only unresolved releases carry over.
  state.control = { enabled = false, backend = nil, unresolved = state.control.unresolved or {}, spec = nil }
  state.running = true
  state.stopRequested = false
  state.clients = {}
  loadModules()
  if opts.bank then applyBankPolicy(opts) end
  if opts.control then applyControlPolicy(opts) end
  -- Run the server loop inside this plugin call. The loop yields every frame so the console stays
  -- responsive, and the plugin stays "running" until it is stopped (onPC calls Cleanup when the
  -- plugin call ends, so the loop must not be handed off to a Timer).
  serverMain()
end

local function Main(display_handle, argument)
  local ok, err = xpcall(MainImpl, debug.traceback, display_handle, argument)
  if not ok then logerr("start failed: %s", tostring(err)) end
  -- onPC calls Cleanup every time a plugin invocation returns. The invocation that owns the server
  -- loop only returns once the loop has ended, so if the loop is still running here this was a
  -- control call ("status", "lua on|off", a rejected argument) and its Cleanup must leave the
  -- running bridge alone.
  if state.running then state.ignoreNextCleanup = true end
end

local function Cleanup()
  if state.ignoreNextCleanup then
    state.ignoreNextCleanup = false
    return
  end
  state.stopRequested = true
  for i = #state.clients, 1, -1 do closeClient(i, "cleanup") end
  if state.server then pcall(function() state.server:close() end) end
  state.server = nil
  state.running = false
  disposeModules("cleanup")
end

return Main, Cleanup
