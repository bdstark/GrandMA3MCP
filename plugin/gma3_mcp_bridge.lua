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

local VERSION      = "0.1.0"
local DEFAULT_PORT = 9800
local BIND_HOST    = "127.0.0.1"
local MAX_DEPTH    = 6

-- State survives repeated Plugin calls (file-level locals are re-created on ReloadAllPlugins only).
_G.__gma3_mcp_bridge = _G.__gma3_mcp_bridge or { running = false, port = DEFAULT_PORT, server = nil, clients = {}, requests = 0 }
local state = _G.__gma3_mcp_bridge

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
    port          = state.port,
    luaVersion    = _VERSION,
    requests      = state.requests,
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
  local code = args.code
  if type(code) ~= "string" then error("args.code (string) is required") end
  local fn, err = load("return " .. code, "=mcp", "t")
  if not fn then
    fn, err = load(code, "=mcp", "t")
  end
  if not fn then error("Lua compile error: " .. tostring(err)) end
  local results = table.pack(fn())
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
  local server, err = socket.bind(BIND_HOST, state.port)
  if not server then
    logerr("could not bind %s:%d (%s)", BIND_HOST, state.port, tostring(err))
    state.running = false
    return
  end
  server:settimeout(0)
  state.server = server
  log("listening on %s:%d (v%s)", BIND_HOST, state.port, VERSION)

  while state.running and not state.stopRequested do
    -- accept new clients
    local c = server:accept()
    if c then
      c:settimeout(0)
      pcall(function() c:setoption("tcp-nodelay", true) end)
      table.insert(state.clients, { sock = c, buf = "" })
      log("client connected (%d total)", #state.clients)
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

local function MainImpl(display_handle, argument)
  local arg = argument and tostring(argument):lower() or ""

  if arg == "stop" then
    if state.running then
      state.stopRequested = true
      log("stop requested")
    else
      log("not running")
    end
    return
  end

  if arg == "status" then
    log("running=%s port=%d clients=%d requests=%d", tostring(state.running), state.port, #state.clients, state.requests)
    return
  end

  if state.running then
    log("already running on port %d (use argument \"stop\" to stop)", state.port)
    return
  end

  local port = tonumber(argument) or DEFAULT_PORT
  state.port = port
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
end

local function Cleanup()
  state.stopRequested = true
  for i = #state.clients, 1, -1 do closeClient(i) end
  if state.server then pcall(function() state.server:close() end) end
  state.server = nil
  state.running = false
end

return Main, Cleanup
