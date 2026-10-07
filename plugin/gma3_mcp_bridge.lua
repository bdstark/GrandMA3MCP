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
-- Arguments are whitespace separated tokens; "luatime" is milliseconds of wall-clock time and
-- "luasteps" a count of Lua VM instructions (0 = unlimited). A request that exceeds its budget is
-- aborted with an error so the bridge loop (and the console) regain control. The budget is
-- enforced with a debug hook plus deadline checks around every resume; the script runs in an
-- environment that withholds debug.sethook and hooks coroutines it creates. It is a best-effort
-- guard against runaway scripts, not a sandbox: it cannot interrupt a C function such as Cmd()
-- that blocks, and a script that sets out to escape still can (Lua on the console has os/io
-- anyway). Only Lua submitted through the "lua" op is budgeted; the structured ops are not.
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

local VERSION      = "0.2.0"
local DEFAULT_PORT = 9800
-- Execution policy defaults for the "lua" op (see header). Changed per start with the
-- "luatime=<ms>" / "luasteps=<n>" tokens, or at runtime with "lua on|off".
local LUA_DEFAULT_ENABLED   = false
local LUA_DEFAULT_MAX_MS    = 5000
local LUA_DEFAULT_MAX_STEPS = 20000000
local LUA_HOOK_INTERVAL     = 1000   -- VM instructions between budget checks
local BIND_HOST    = "127.0.0.1"  -- fixed: the bridge is unauthenticated and must never leave loopback
local MAX_DEPTH    = 6

-- State survives repeated Plugin calls (file-level locals are re-created on ReloadAllPlugins only).
_G.__gma3_mcp_bridge = _G.__gma3_mcp_bridge or { running = false, host = BIND_HOST, port = DEFAULT_PORT, server = nil, clients = {}, requests = 0 }
local state = _G.__gma3_mcp_bridge
-- Lua execution policy (older state tables from before 0.2.0 do not have it).
state.lua = state.lua or { enabled = LUA_DEFAULT_ENABLED, maxMs = LUA_DEFAULT_MAX_MS, maxSteps = LUA_DEFAULT_MAX_STEPS }

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
-- Lua execution policy
-------------------------------------------------------------------------------

local hookSupported = type(debug) == "table" and type(debug.sethook) == "function"

local function now()
  local ok, t = pcall(socket.gettime)
  if ok and type(t) == "number" then return t end
  return os.clock()
end

local function luaPolicyInfo()
  return {
    enabled  = state.lua.enabled and true or false,
    maxMs    = state.lua.maxMs,
    maxSteps = state.lua.maxSteps,
    bounded  = hookSupported,
    note     = hookSupported
      and "budget is enforced by a VM instruction hook; a blocking C call (e.g. Cmd opening a dialog) cannot be interrupted"
      or "debug.sethook is unavailable in this Lua engine: no execution bound can be enforced",
  }
end

local function describeLuaPolicy()
  if not state.lua.enabled then return "disabled" end
  local function lim(v, unit) if v and v > 0 then return tostring(v) .. unit end return "unlimited" end
  return string.format("enabled (budget %s / %s per request%s)", lim(state.lua.maxMs, " ms"), lim(state.lua.maxSteps, " VM instructions"),
    hookSupported and "" or ", NOT enforced: debug.sethook unavailable")
end

-- Budget state of the request currently executing (requests are handled one at a time).
-- The sandbox's coroutine.create/wrap use it to put the budget hook on threads the script creates.
local activeBudget = nil

-- Run fn() under the configured budget and return its results as a packed table.
-- The function runs in its own coroutine so the instruction hook is confined to it and
-- never affects the bridge loop. This matters beyond tidiness: onPC installs its own
-- external (C) hook on the plugin thread, and setting or clearing a hook there with
-- debug.sethook would replace or remove it. If the user code yields, the yield is passed
-- up to the console (like the bridge loop's own per-frame yield) and the code is resumed
-- next frame. The wall-clock deadline is checked by the hook, before and after every
-- resume, and before returning success, so a script that mostly yields (and therefore
-- executes few VM instructions) is still bounded.
local function runBounded(fn, maxMs, maxSteps)
  local co = coroutine.create(fn)
  local budget = { exceeded = nil }
  local timeMsg = maxMs and maxMs > 0 and string.format("Lua execution budget exceeded: ran longer than %d ms", maxMs) or nil
  local deadline = (maxMs and maxMs > 0) and (now() + maxMs / 1000) or nil
  local function overdue() return deadline ~= nil and now() >= deadline end

  if hookSupported and ((maxMs and maxMs > 0) or (maxSteps and maxSteps > 0)) then
    local steps = 0
    local function hook()
      if not budget.exceeded then
        steps = steps + LUA_HOOK_INTERVAL
        if maxSteps and maxSteps > 0 and steps >= maxSteps then
          budget.exceeded = string.format("Lua execution budget exceeded: more than %d VM instructions", maxSteps)
        elseif overdue() then
          budget.exceeded = timeMsg
        end
      end
      if budget.exceeded then
        -- From now on fail on every instruction of this thread so that code wrapped in pcall
        -- (or a parent thread resuming an exhausted child) cannot keep going.
        debug.sethook(hook, "", 1)
        error(budget.exceeded, 0)
      end
    end
    budget.attach = function(thread) debug.sethook(thread, hook, "", LUA_HOOK_INTERVAL) end
    budget.attach(co)
  end

  local previous = activeBudget
  activeBudget = budget
  local res = table.pack(coroutine.resume(co))
  while res[1] and coroutine.status(co) == "suspended" and not budget.exceeded do
    if overdue() then budget.exceeded = timeMsg; break end
    coroutine.yield()
    if overdue() then budget.exceeded = timeMsg; break end
    res = table.pack(coroutine.resume(co))
  end
  if res[1] and not budget.exceeded and overdue() then budget.exceeded = timeMsg end
  activeBudget = previous

  if budget.exceeded then
    if coroutine.status(co) == "suspended" and type(coroutine.close) == "function" then pcall(coroutine.close, co) end
    error(budget.exceeded .. '. Raise the budget when starting the bridge: Plugin "gma3_mcp_bridge" "lua luatime=<ms> luasteps=<n>" (0 = unlimited).', 0)
  end
  if not res[1] then
    local msg = tostring(res[2])
    local okT, tb = pcall(debug.traceback, co, msg)
    error(okT and tb or msg, 0)
  end
  return table.pack(table.unpack(res, 2, res.n))
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

local ops = {}

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
  }
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
  return { values = out }
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
  local okR, result = xpcall(function() return op(args) end, debug.traceback)
  if okR then
    return encode({ id = id, ok = true, result = toJsonSafe(result) })
  end
  local msg = tostring(result)
  local firstLine = msg:match("^([^\n]*)") or msg
  appendLog(string.format("request %s failed: %s", tostring(req.op), firstLine))
  return encode({ id = id, ok = false, error = firstLine })
end

state._handleLine = handleLine  -- exposed for local testing

local function closeClient(i)
  local c = state.clients[i]
  if c then pcall(function() c.sock:close() end) end
  table.remove(state.clients, i)
end

local function serverMain()
  local server, err = socket.bind(state.host, state.port)
  if not server then
    logerr("could not bind %s:%d (%s)", state.host, state.port, tostring(err))
    state.running = false
    return
  end
  server:settimeout(0)
  state.server = server
  log("listening on %s:%d (v%s); Lua execution %s", state.host, state.port, VERSION, describeLuaPolicy())
  if not state.lua.enabled then
    log('Lua execution (gma3_lua) is off; enable it with  Plugin "gma3_mcp_bridge" "lua on"')
  end

  while state.running and not state.stopRequested do
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
        table.insert(state.clients, { sock = c, buf = "" })
        log("client connected (%d total)", #state.clients)
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

  for i = #state.clients, 1, -1 do closeClient(i) end
  pcall(function() server:close() end)
  state.server = nil
  state.running = false
  state.stopRequested = false
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
local function parseArgument(argument)
  local opts = {}
  local text = argument and tostring(argument) or ""
  local prev = nil
  for tok in text:gmatch("[^%s,]+") do
    local l = tok:lower()
    local key, val = l:match("^(%a+)=(.*)$")
    if l == "stop" or l == "status" then
      opts.command = l
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
      return nil, string.format("\"%s\" is not a recognised argument (expected a port number, \"stop\", \"status\", \"lua\", \"lua on|off\", \"luatime=<ms>\" or \"luasteps=<n>\")", tok)
    end
    prev = l
  end
  return opts
end

local function applyLuaPolicy(opts)
  if opts.lua ~= nil then state.lua.enabled = opts.lua end
  if opts.maxMs ~= nil then state.lua.maxMs = opts.maxMs end
  if opts.maxSteps ~= nil then state.lua.maxSteps = opts.maxSteps end
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

  if opts.command == "status" then
    log("running=%s bind=%s:%d clients=%d requests=%d lua=%s", tostring(state.running), state.host, state.port, #state.clients, state.requests, describeLuaPolicy())
    return
  end

  if state.running then
    if opts.port then
      log("already running on port %d (use argument \"stop\" to stop)", state.port)
      return
    end
    if opts.lua ~= nil or opts.maxMs ~= nil or opts.maxSteps ~= nil then
      applyLuaPolicy(opts)
      log("Lua execution now %s", describeLuaPolicy())
    else
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
  state.lua = { enabled = LUA_DEFAULT_ENABLED, maxMs = LUA_DEFAULT_MAX_MS, maxSteps = LUA_DEFAULT_MAX_STEPS }
  applyLuaPolicy(opts)
  state.running = true
  state.stopRequested = false
  state.clients = {}
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
  for i = #state.clients, 1, -1 do closeClient(i) end
  if state.server then pcall(function() state.server:close() end) end
  state.server = nil
  state.running = false
end

return Main, Cleanup
