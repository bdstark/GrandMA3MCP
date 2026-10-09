-- gma3_mcp_feedback.lua
--
-- Instance-based read-only console feedback module for grandMA3 onPC plugins (KB-02 packaging,
-- KB-06 readers, freshness and bounded polling).
--
-- A ComponentLua of a UserPlugin: the console runs this chunk at import/reload and it only returns a
-- module table. Nothing is read from the console until a consumer calls read()/readMany()/service()
-- on an instance. Readers are the state sources confirmed in KB-01; anything not confirmed is
-- reported as unavailable with a reason, never as a guessed false or zero.
--
-- Response contract (every observation, KB-06):
--   { name, key, scope, source, params?, available, value?, reason? | error?, observedAt, epoch, note? }
--   * available=false carries `reason` (the console gave nothing usable: nil, an unrecognised value, a
--     missing display/sequence/executor, a reader that is not implemented) or `error` (the reader
--     raised). A `false` value is always available=true. One failing reader never affects another.
--   * observedAt is the consumer's clock (seconds) at the time of that single read. Several items of
--     one readMany() are read one after another, not as an atomic snapshot of the console.
--   * epoch counts invalidations: the instance bumps it when the show file, user or user profile it
--     observes changes (checked in service()/readMany() at most every config.identityCheckMs) and
--     when the consumer calls invalidate() (disconnect, restart). Cached observations of an older
--     epoch are dropped, never reported as current.
--   * lastCommand and maState are observations of shared console state: they do not identify which
--     request, client or key source produced them.
--
-- MODULE API 1, module version 0.2.0. Lifecycle: new() -> init() -> read()/readMany()/watch()/service()
-- ... -> dispose(). Consumers pass dependencies via opts.deps (consoleDeps(_G) builds lazy closures)
-- and keep one instance each; the module table is read-only and nothing here uses globals or
-- package.loaded.

local NAME        = "gma3_mcp_feedback"
local VERSION     = "0.2.0"
local API_VERSION = 1

local DEFAULTS = {
  maxItems           = 64,    -- items per readMany()/watch(); the rest are reported truncated, not read
  maxExecutors       = 32,    -- executors expanded by itemsFor() per request
  maxReadsPerService = 8,     -- watched items read per service() call (bounded per-frame work)
  pollIntervalMs     = 100,   -- a watched item is not re-read before this much time passed
  staleMs            = 2000,  -- a cached observation older than this is reported stale
  identityCheckMs    = 1000,  -- show file / user / profile identity re-read at most this often
  defaultDisplay     = 1,
}

-- Strict boolean: the console reports FADERENABLED-style properties as "true"/"false" text or booleans.
-- Anything else is reported as unavailable by the reader, never passed through as a truthy value.
local function toBool(v)
  if v == true or v == "true" or v == "True" or v == 1 then return true end
  if v == false or v == "false" or v == "False" or v == 0 then return false end
  if v == nil then return nil, "the console returned nothing for this property" end
  return nil, string.format("unrecognised value %s (%s) is reported as unavailable, not as false", tostring(v), type(v))
end

local function positiveInt(v, what)
  if type(v) ~= "number" or v ~= math.floor(v) or v < 1 then error(what .. " must be a positive integer", 0) end
  return v
end

local function handleInfo(h)
  if h == nil then return nil end
  local out = { name = tostring(h.name) }
  local ok, c = pcall(function() return h:GetClass() end); if ok and c ~= nil then out.class = tostring(c) end
  local okA, a = pcall(function() return h:Addr() end);   if okA and a ~= nil then out.addr = tostring(a) end
  local okN, n = pcall(function() return h:Get("No") end); if okN and tonumber(n) then out.no = tonumber(n) end
  return out
end

local function faderOf(h, token)
  local okV, v = pcall(h.GetFader, h, { token = token })
  if not okV then error("GetFader failed: " .. tostring(v), 0) end
  if type(v) ~= "number" then return nil, "GetFader returned " .. type(v) .. ", not a level" end
  local okT, text = pcall(h.GetFaderText, h, { token = token })
  return { token = token, value = v, text = (okT and text ~= nil) and tostring(text) or nil }
end

-- Readers: fn(deps, params) -> value, reason. A reader returns nil plus a reason when the console gave
-- nothing usable; it raises when a dependency fails. `params` lists accepted parameters, `paramless`
-- readers are part of readAll(). Scope says what the value belongs to (KB-01).
local READERS = {
  commandText = { scope = "ui", source = "CmdObj().cmdtext", note = "raw command-line text of the plugin user; keywords are not inferred from it",
    fn = function(d) local v = d.cmdObj().cmdtext; if v == nil then return nil, "the console returned nothing for cmdtext" end; return tostring(v) end },
  lastCommand = { scope = "ui", source = "CmdObj().lastcommand", note = "observation of shared command history, not confirmation of a particular request or client",
    fn = function(d) local v = d.cmdObj().lastcommand; if v == nil then return nil, "the console returned nothing for lastcommand" end; return tostring(v) end },
  blind     = { scope = "show", source = "ShowData.Masters.Grand.Blind.FADERENABLED",     fn = function(d) return toBool(d.showData().Masters.Grand.Blind:Get("FaderEnabled")) end },
  highlight = { scope = "show", source = "ShowData.Masters.Grand.Highlight.FADERENABLED", fn = function(d) return toBool(d.showData().Masters.Grand.Highlight:Get("FaderEnabled")) end },
  solo      = { scope = "show", source = "ShowData.Masters.Grand.Solo.FADERENABLED",      fn = function(d) return toBool(d.showData().Masters.Grand.Solo:Get("FaderEnabled")) end },
  previewMode = { scope = "profile", source = "CurrentProfile().Environments.ACTIVEENVIRONMENT",
    fn = function(d) local v = d.currentProfile().Environments:Get("ActiveEnvironment"); if v == nil then return nil, "the console returned nothing for ActiveEnvironment" end; return tostring(v) end },
  previewBar = { scope = "display", source = "GetDisplayByIndex(display).PREVIEWBARACTIVE", params = { "display" }, paramless = true,
    note = "display-local pending Preview; it does not say which display injected input will route to",
    fn = function(d, p, cfg)
      local n = p and p.display
      if n == nil then n = cfg.defaultDisplay end
      positiveInt(n, "params.display")
      local disp = d.display(n)
      if disp == nil then return nil, "display " .. n .. " does not exist on this console" end
      return toBool(disp:Get("PreviewBarActive"))
    end,
    identify = function(p, cfg) return { display = (p and p.display) or cfg.defaultDisplay } end },
  shortcutsActive = { scope = "profile", source = "CurrentProfile().KeyboardShortCuts.KEYBOARDSHORTCUTSACTIVE",
    fn = function(d) return toBool(d.currentProfile().KeyboardShortCuts:Get("KeyboardShortcutsActive")) end },
  maState = { scope = "console", source = "Root().MASTATE", note = "aggregate MA state of every Shift source (observed state, not ownership)",
    fn = function(d) return toBool(d.root():Get("MAState")) end },
  page = { scope = "user", source = "CurrentExecPage()", fn = function(d)
    local p = d.currentExecPage()
    if p == nil then return nil, "CurrentExecPage() returned nothing" end
    return { name = tostring(p.name), no = tonumber(p:Get("No")) or tonumber(p.index) }
  end },
  selectedSequence = { scope = "user", source = "SelectedSequence()", note = "the user's selected sequence; nil from the console is reported as selected=false",
    fn = function(d)
      local s = d.selectedSequence()
      if s == nil then return { selected = false } end
      local info = handleInfo(s)
      info.selected = true
      return info
    end },
  sequenceActive = { scope = "show", source = "Sequence:HasActivePlayback()", params = { "sequence" },
    note = "sequence playback activity; not proof that a particular executor caused it or that a button is held",
    fn = function(d, p)
      local n = p and p.sequence
      if type(n) ~= "number" then error("params.sequence (number) is required", 0) end
      local seq = d.sequence(n)
      if seq == nil then return nil, "sequence " .. n .. " not found" end
      return toBool(seq:HasActivePlayback())
    end,
    identify = function(p) return { sequence = p and p.sequence } end },
  executor = { scope = "page", source = "GetExecutor(executor).Object on the user's current page", params = { "executor" },
    note = "assignment only; level is the fader reader, activity is sequenceActive, button ownership is the input module's record",
    fn = function(d, p)
      local n = p and p.executor
      if type(n) ~= "number" then error("params.executor (number) is required", 0) end
      local exec, page = d.executor(n)
      if exec == nil then return { executor = n, empty = true, page = handleInfo(page) } end
      local okO, obj = pcall(function() return exec.Object end)
      if not okO then error("reading the executor's Object failed: " .. tostring(obj), 0) end
      local assigned = obj ~= nil and handleInfo(obj) or nil
      return { executor = n, empty = assigned == nil, assigned = assigned, page = handleInfo(page) }
    end,
    identify = function(p) return { executor = p and p.executor } end },
  fader = { scope = "show", source = "<assigned object>:GetFader({token})", params = { "executor", "sequence", "token" },
    note = "master level of the object assigned to the executor (user page) or of the sequence; not a button state",
    fn = function(d, p)
      local token = (p and p.token) or "FaderMaster"
      if type(token) ~= "string" or token == "" then error("params.token must be a non-empty string", 0) end
      local target
      if p and p.executor ~= nil then
        if type(p.executor) ~= "number" then error("params.executor must be a number", 0) end
        local exec = d.executor(p.executor)
        if exec == nil then return nil, "executor " .. p.executor .. " is empty on the current page" end
        local okO, obj = pcall(function() return exec.Object end)
        if not okO then error("reading the executor's Object failed: " .. tostring(obj), 0) end
        if obj == nil then return nil, "executor " .. p.executor .. " has no assigned object" end
        target = obj
      elseif p and p.sequence ~= nil then
        if type(p.sequence) ~= "number" then error("params.sequence must be a number", 0) end
        target = d.sequence(p.sequence)
        if target == nil then return nil, "sequence " .. p.sequence .. " not found" end
      else
        error("params.executor or params.sequence (number) is required", 0)
      end
      local v, reason = faderOf(target, token)
      if v == nil then return nil, reason end
      v.target = handleInfo(target)
      return v
    end,
    identify = function(p) return { executor = p and p.executor, sequence = p and p.sequence, token = (p and p.token) or "FaderMaster" } end },
  freeze = { scope = "show", source = nil, unavailable = "no readable Freeze state was found in KB-01; this is not a false value" },
}

-- Compatibility alias (0.1.0 named sequence activity after the executor). The result keeps the
-- requested name and says what was actually read.
local ALIASES = {
  executorActive = { of = "sequenceActive", note = "deprecated alias of sequenceActive: this is sequence playback activity, not executor button state" },
}

local READER_NAMES = {}
for k in pairs(READERS) do READER_NAMES[#READER_NAMES + 1] = k end
table.sort(READER_NAMES)

-- Every caller gets its own copy: the internal list is never exposed.
local function readerNames()
  local out = {}
  for i, n in ipairs(READER_NAMES) do out[i] = n end
  return out
end

local function describeReaders()
  local out = {}
  for _, n in ipairs(READER_NAMES) do
    local r = READERS[n]
    local params = nil
    if r.params then params = {}; for i, p in ipairs(r.params) do params[i] = p end end
    out[#out + 1] = { name = n, scope = r.scope, source = r.source, params = params, paramless = r.params == nil or r.paramless == true, note = r.note, unavailable = r.unavailable }
  end
  for a, al in pairs(ALIASES) do out[#out + 1] = { name = a, alias = al.of, scope = READERS[al.of].scope, source = READERS[al.of].source, note = al.note } end
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
    display = function(n) return env.GetDisplayByIndex(n) end,
    sequence = function(n) local list = env.ObjectList("Sequence " .. tostring(n)); return list and list[1] end,
    executor = function(n) return env.GetExecutor(n) end,
    selectedSequence = function() return env.SelectedSequence() end,
    -- Identity of what the readers observe; a change invalidates cached observations.
    showFile = function() return env.Root().MANetSocket:Get("ShowFile") end,
    userName = function() local u = env.CurrentUser(); return u and tostring(u.name) or nil end,
    profileName = function() return tostring(env.CurrentProfile().name) end,
  }
end

local function keyOf(name, ident)
  if not ident then return name end
  local parts = {}
  for _, k in ipairs({ "display", "executor", "sequence", "token" }) do
    if ident[k] ~= nil and not (k == "token" and ident[k] == "FaderMaster") then parts[#parts + 1] = k .. "=" .. tostring(ident[k]) end
  end
  if #parts == 0 then return name end
  return name .. "[" .. table.concat(parts, ",") .. "]"
end

-- Expand a request spec into read items (shared by the bridge op and surface consumers so nobody
-- re-implements the expansion). Bounded by config.maxExecutors; the rest is reported, not read.
--   spec = { all?, items?, readers?, display?, displays?, executors?, sequences?, tokens? }
--   all = true adds every parameterless reader (previewBar once per requested display).
local function itemsFor(spec, config)
  spec = spec or {}
  config = config or DEFAULTS
  local items, limitations = {}, {}
  local function add(name, params) items[#items + 1] = { name = name, params = params } end
  if spec.all == true then
    local readers = {}
    for _, n in ipairs(READER_NAMES) do
      local r = READERS[n]
      if not r.params or r.paramless then readers[#readers + 1] = n end
    end
    if type(spec.readers) == "table" then for _, n in ipairs(spec.readers) do readers[#readers + 1] = n end end
    spec = { items = spec.items, readers = readers, display = spec.display, displays = spec.displays, executors = spec.executors, sequences = spec.sequences, tokens = spec.tokens }
  end
  if type(spec.items) == "table" then
    for _, it in ipairs(spec.items) do
      if type(it) == "string" then add(it, nil)
      elseif type(it) == "table" and type(it.name) == "string" then add(it.name, it.params)
      else limitations[#limitations + 1] = "ignored an item that is neither a reader name nor {name, params}" end
    end
  end
  local displays = spec.displays
  if displays == nil and spec.display ~= nil then displays = { spec.display } end
  if type(spec.readers) == "table" then
    for _, name in ipairs(spec.readers) do
      if name == "previewBar" and type(displays) == "table" and #displays > 0 then
        for _, dn in ipairs(displays) do add("previewBar", { display = dn }) end
      elseif READERS[name] and READERS[name].params and not READERS[name].paramless then
        limitations[#limitations + 1] = name .. " needs parameters; use executors/sequences or items"
      else
        add(name, nil)
      end
    end
  end
  if type(spec.executors) == "table" then
    local max = config.maxExecutors or DEFAULTS.maxExecutors
    local tokens = type(spec.tokens) == "table" and spec.tokens or { "FaderMaster" }
    for i, n in ipairs(spec.executors) do
      if i > max then limitations[#limitations + 1] = string.format("executors truncated to %d of %d", max, #spec.executors); break end
      add("executor", { executor = n })
      for _, tok in ipairs(tokens) do add("fader", { executor = n, token = tok }) end
    end
  end
  if type(spec.sequences) == "table" then
    local max = config.maxExecutors or DEFAULTS.maxExecutors
    for i, n in ipairs(spec.sequences) do
      if i > max then limitations[#limitations + 1] = string.format("sequences truncated to %d of %d", max, #spec.sequences); break end
      add("sequenceActive", { sequence = n })
    end
  end
  return items, limitations
end

-- Identifying parameters of an item, computed under protection: a malformed params value (not a table,
-- a wrong type inside) yields nil plus the error, and the caller reports that one item unavailable
-- instead of aborting the batch. The key stays stable so watch() and read() agree on it.
local function identifyItem(r, name, params, config)
  if params ~= nil and type(params) ~= "table" then
    return nil, tostring(name) .. "[invalid-params]", "params must be a table, got " .. type(params)
  end
  if not (r and r.identify) then return nil, tostring(name), nil end
  local ok, ident = pcall(r.identify, params, config)
  if not ok then return nil, tostring(name) .. "[invalid-params]", tostring(ident) end
  return ident, keyOf(tostring(name), ident), nil
end

local Instance = {}
Instance.__index = Instance

local function checkLive(self, what)
  if self._state == "disposed" then error(NAME .. ": " .. what .. " on a disposed instance", 3) end
end

local function requireReady(self, what)
  checkLive(self, what)
  if self._state ~= "ready" then error(NAME .. ": " .. what .. "() before init()", 3) end
end

function Instance:init()
  checkLive(self, "init")
  if self._state == "created" then self._state = "ready" end
  return self
end

function Instance:status()
  local cached = 0
  for _ in pairs(self._cache) do cached = cached + 1 end
  return { module = NAME, version = VERSION, apiVersion = API_VERSION, owner = self._owner, state = self._state,
           reads = self._reads, serviced = self._serviced, readers = readerNames(), epoch = self._epoch,
           lastInvalidation = self._lastInvalidation, identity = self._identity, identityUncertain = self._identityUncertain,
           watched = #self._watch, cached = cached,
           config = { maxItems = self._config.maxItems, maxExecutors = self._config.maxExecutors, maxReadsPerService = self._config.maxReadsPerService,
                      pollIntervalMs = self._config.pollIntervalMs, staleMs = self._config.staleMs, identityCheckMs = self._config.identityCheckMs } }
end

function Instance:dispose()
  self._state = "disposed"
  self._cache, self._watch = {}, {}
  return {}
end

function Instance:readers() return readerNames() end
function Instance:describe() return describeReaders() end
function Instance:epoch() return self._epoch end

-- Drops every cached observation and starts a new epoch. The consumer calls it on disconnect,
-- restart or any event after which old values must not be presented as current.
function Instance:invalidate(reason, now)
  checkLive(self, "invalidate")
  self._epoch = self._epoch + 1
  self._cache = {}
  self._lastInvalidation = { reason = tostring(reason or "consumer"), at = now, epoch = self._epoch }
  return self._epoch
end

-- Show file, user and profile identity. Read at most every identityCheckMs; a difference from the
-- last KNOWN identity invalidates the cache. A value that was never readable is reported as nil and is
-- not a change. A value that was readable and becomes unreadable keeps its last known value, marks the
-- identity uncertain and invalidates once ("identity-unreadable"): while uncertain, snapshot() reports
-- every observation stale and readMany() says so, so an A -> unreadable -> B transition can neither
-- hide the change (B is compared with A once readable again) nor present A's values as current.
local IDENTITY_KEYS = { "showFile", "user", "profile" }
local IDENTITY_REASON = { showFile = "show-changed", user = "user-changed", profile = "profile-changed" }
function Instance:_checkIdentity(now, force)
  if not force and self._identityAt ~= nil and now ~= nil and (now - self._identityAt) * 1000 < self._config.identityCheckMs then return nil end
  self._identityAt = now
  local d = self._deps
  local id = {}
  local function try(k, f) if type(f) == "function" then local ok, v = pcall(f); if ok and v ~= nil then id[k] = tostring(v) end end end
  try("showFile", d.showFile); try("user", d.userName); try("profile", d.profileName)
  local prev = self._identity or {}
  local known, uncertain, reason = {}, {}, nil
  for _, k in ipairs(IDENTITY_KEYS) do
    if id[k] ~= nil then
      known[k] = id[k]
      if prev[k] ~= nil and prev[k] ~= id[k] then reason = reason or IDENTITY_REASON[k] end
    elseif prev[k] ~= nil then
      known[k] = prev[k]           -- last known value, not forgotten
      uncertain[#uncertain + 1] = k
    end
  end
  local wasUncertain = self._identityUncertain ~= nil
  self._identity = known
  self._identityUncertain = #uncertain > 0 and uncertain or nil
  if reason then
    self:invalidate(reason, now)
    return reason
  end
  if #uncertain > 0 and not wasUncertain then
    self:invalidate("identity-unreadable", now)
    return "identity-unreadable"
  end
  return nil
end

-- Returns one observation (see the contract at the top). Never raises for a reader problem.
function Instance:read(name, params, now)
  requireReady(self, "read")
  local requested = tostring(name)
  local alias = ALIASES[name]
  local r = READERS[alias and alias.of or name]
  if not r then return { name = requested, key = requested, available = false, reason = "unknown reader; see readers()", observedAt = now, epoch = self._epoch } end
  self._reads = self._reads + 1
  local ident, key, identErr = identifyItem(r, requested, params, self._config)
  local out = { name = requested, key = key, scope = r.scope, source = r.source, params = ident, observedAt = now, epoch = self._epoch, note = alias and alias.note or r.note }
  if alias then out.alias = alias.of end
  if identErr then out.available = false; out.error = identErr; return out end
  if r.unavailable then out.available = false; out.reason = r.unavailable; return out end
  local ok, v, reason = pcall(r.fn, self._deps, params, self._config)
  if not ok then out.available = false; out.error = tostring(v); return out end
  if v == nil then out.available = false; out.reason = reason or "the console returned nothing for this property"; return out end
  out.available = true; out.value = v
  return out
end

-- Reads up to config.maxItems items one after another (not atomic). items = { {name, params}, ... }.
function Instance:readMany(items, now)
  requireReady(self, "readMany")
  if type(items) ~= "table" then error(NAME .. ": readMany(items) needs a list", 2) end
  local invalidated = self:_checkIdentity(now)
  local out = { observedAt = now, epoch = self._epoch, atomic = false, identity = self._identity, identityUncertain = self._identityUncertain,
                invalidated = invalidated, items = {}, count = 0, truncated = 0 }
  for i, it in ipairs(items) do
    if i > self._config.maxItems then out.truncated = #items - self._config.maxItems; break end
    out.items[#out.items + 1] = self:read(it.name, it.params, now)
  end
  out.count = #out.items
  return out
end

-- Every parameterless reader keyed by name (previewBar on config.defaultDisplay).
function Instance:readAll(now)
  requireReady(self, "readAll")
  local out = {}
  for _, name in ipairs(READER_NAMES) do
    local r = READERS[name]
    if not r.params or r.paramless then out[name] = self:read(name, nil, now) end
  end
  return out
end

-- Subscribe a bounded item list for service() to keep observed. Replaces the previous list; cached
-- observations of items no longer watched are dropped.
function Instance:watch(items, now)
  requireReady(self, "watch")
  if type(items) ~= "table" then error(NAME .. ": watch(items) needs a list", 2) end
  local watch, keep, truncated = {}, {}, 0
  for i, it in ipairs(items) do
    if i > self._config.maxItems then truncated = #items - self._config.maxItems; break end
    local alias = type(it) == "table" and ALIASES[it.name] or nil
    local r = type(it) == "table" and READERS[alias and alias.of or it.name] or nil
    local name = type(it) == "table" and it.name or it
    local _, key = identifyItem(r, name, type(it) == "table" and it.params or nil, self._config)
    it = type(it) == "table" and it or { name = name }
    if not keep[key] then
      keep[key] = true
      watch[#watch + 1] = { name = it.name, params = it.params, key = key }
    end
  end
  for key in pairs(self._cache) do if not keep[key] then self._cache[key] = nil end end
  self._watch, self._cursor = watch, 0
  return { watched = #watch, truncated = truncated }
end

function Instance:unwatch()
  requireReady(self, "unwatch")
  self._watch, self._cache, self._cursor = {}, {}, 0
  return {}
end

-- Per-iteration hook: identity check (bounded by identityCheckMs), then at most maxReadsPerService
-- watched items whose observation is older than pollIntervalMs, round robin from where the last
-- call stopped. The consumer's other work (input deadlines) is never delayed by more than that.
function Instance:service(now)
  requireReady(self, "service")
  if type(now) ~= "number" then error(NAME .. ": service(now) needs the clock in seconds", 2) end
  self._serviced = self._serviced + 1
  self._lastServiced = now
  local invalidated = self:_checkIdentity(now)
  local reads, due = 0, 0
  local n = #self._watch
  if n > 0 then
    local interval = self._config.pollIntervalMs / 1000
    for _ = 1, n do
      if reads >= self._config.maxReadsPerService then break end
      self._cursor = (self._cursor % n) + 1
      local w = self._watch[self._cursor]
      local c = self._cache[w.key]
      if c == nil or c.epoch ~= self._epoch or (now - c.observedAt) >= interval then
        self._cache[w.key] = self:read(w.name, w.params, now)
        reads = reads + 1
      end
    end
    for _, w in ipairs(self._watch) do
      local c = self._cache[w.key]
      if c == nil or c.epoch ~= self._epoch or (now - c.observedAt) >= interval then due = due + 1 end
    end
  end
  return { reads = reads, due = due, watched = n, invalidated = invalidated }
end

-- The watched observations as last read, each with its age; items not observed since the current
-- epoch are listed in notObserved with the reason. Nothing is read here.
function Instance:snapshot(now)
  requireReady(self, "snapshot")
  local items, notObserved = {}, {}
  for _, w in ipairs(self._watch) do
    local c = self._cache[w.key]
    if c == nil or c.epoch ~= self._epoch then
      notObserved[#notObserved + 1] = { key = w.key, reason = self._lastInvalidation and ("not observed since " .. tostring(self._lastInvalidation.reason)) or "not observed yet" }
    else
      local copy = {}
      for k, v in pairs(c) do copy[k] = v end
      local ageMs = (now ~= nil and c.observedAt ~= nil) and math.floor((now - c.observedAt) * 1000 + 0.5) or nil
      copy.ageMs = ageMs
      copy.stale = (ageMs == nil) or ageMs > self._config.staleMs or self._identityUncertain ~= nil
      if self._identityUncertain ~= nil then copy.identityUncertain = self._identityUncertain end
      items[#items + 1] = copy
    end
  end
  return { observedAt = now, epoch = self._epoch, atomic = false, identity = self._identity, identityUncertain = self._identityUncertain,
           items = items, notObserved = notObserved, watched = #self._watch }
end

local function new(opts)
  opts = opts or {}
  if type(opts.owner) ~= "string" or opts.owner == "" then error(NAME .. ".new: opts.owner (non-empty string) is required", 2) end
  if opts.deps ~= nil and type(opts.deps) ~= "table" then error(NAME .. ".new: opts.deps must be a table", 2) end
  if opts.config ~= nil and type(opts.config) ~= "table" then error(NAME .. ".new: opts.config must be a table", 2) end
  local config = {}
  for k, v in pairs(DEFAULTS) do config[k] = v end
  for k, v in pairs(opts.config or {}) do
    if DEFAULTS[k] == nil then error(NAME .. ".new: unknown config key '" .. tostring(k) .. "'", 2) end
    if type(v) ~= "number" or v < 0 then error(NAME .. ".new: config." .. k .. " must be a non-negative number", 2) end
    config[k] = v
  end
  return setmetatable({ _owner = opts.owner, _deps = opts.deps or {}, _config = config, _state = "created", _reads = 0, _serviced = 0,
                        _epoch = 1, _cache = {}, _watch = {}, _cursor = 0 }, Instance)
end

local M = { NAME = NAME, VERSION = VERSION, API_VERSION = API_VERSION, READERS = readerNames(), new = new, consoleDeps = consoleDeps,
            itemsFor = itemsFor, describe = describeReaders, toBool = toBool, keyOf = keyOf }

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
