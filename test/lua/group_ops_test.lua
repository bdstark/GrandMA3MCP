-- Regression harness for the bridge's SB-02 selection-grid reads (group.read, selection.grid) under stock
-- Lua (5.4 or newer).
--
-- A small console is modelled with userdata handles (the plugin treats userdata as object handles): fixtures
-- 401/402 and fixture 501 with two cells, a group whose SelectionData is the Lua table onPC 2.5.1 returns
-- ({ sf_index, grid = { x, y, z, ... } } in selection order), and a live selection walked with
-- SelectionFirst / SelectionNext.
--
-- Run from the repository root:   lua test/lua/group_ops_test.lua

local here = (arg and arg[0] or ""):match("^(.*)[/\\]") or "."
package.path = here .. "/?.lua;" .. package.path
local pluginPath = here .. "/../../plugin/gma3_mcp_bridge.lua"

package.preload["socket"] = function()
  return { gettime = function() return os.clock() end, bind = function() return nil, "stub: no bind" end }
end
Echo = function() end
ErrEcho = Echo; Printf = Echo; ErrPrintf = Echo
GetPath = function() return nil end
Enums = { PathType = { Temp = 1 }, Roles = { Display = 1, Edit = 2 }, VirtualKeyCode = {}, KeyboardCodes = {} }
Keyboard = function() end
CurrentProfile = function() return { name = "Default", KeyboardShortCuts = { Get = function() return "true" end, Count = function() return 0 end } } end
GetDisplayByIndex = function() return nil end
BuildDetails = function() return {} end
Root = function() return { Get = function() return false end, VirtualKeys = { Count = function() return 0 end }, MANetSocket = { Get = function() return nil end }, maNetSocket = {} } end
CurrentUser = function() return nil end

-------------------------------------------------------------------------------
-- Fake handles
-------------------------------------------------------------------------------

local registry = setmetatable({}, { __mode = "k" })
local fileMeta = getmetatable(io.stdout)
local handleMeta = { __gc = fileMeta and fileMeta.__gc, __close = fileMeta and fileMeta.__close, __name = "FakeHandle" }
local methods = {}
handleMeta.__index = function(u, key)
  local def = registry[u]
  if not def then return nil end
  if methods[key] then return methods[key] end
  if key == "name" then return def.name end
  if key == "no" then return def.no end
  return def.props[tostring(key):lower()]
end
function methods.Get(u, name, role)
  local v = registry[u].props[tostring(name):lower()]
  if type(v) == "function" then return v(role) end
  return v
end
function methods.GetClass(u) return registry[u].class end
function methods.Addr(u) return registry[u].addr or ("addr:" .. tostring(registry[u].name)) end
function methods.Parent(u) return registry[u].parent end
function methods.Children(u) return registry[u].children or {} end

local function H(def)
  local u = io.tmpfile()
  debug.setmetatable(u, handleMeta)
  local lowered = {}
  for k, v in pairs(def.props or {}) do lowered[tostring(k):lower()] = v end
  def.props = lowered
  registry[u] = def
  return u
end

local fixtures = H({ name = "Fixtures", class = "Fixtures" })
local f401 = H({ name = "Par 1", class = "Fixture", no = 1, parent = fixtures, props = { FID = 401 } })
local f402 = H({ name = "Par 2", class = "Fixture", no = 2, parent = fixtures, props = { FID = 402 } })
local f501 = H({ name = "Wash 1", class = "Fixture", no = 3, parent = fixtures, props = { FID = 501 } })
local c1 = H({ name = "[Instance2]", class = "SubFixture", no = 1, parent = f501, props = {} })
local c2 = H({ name = "[Instance3]", class = "SubFixture", no = 2, parent = f501, props = {} })
-- A cell with its own FID, and an orphan whose parent chain has no FID.
local c3 = H({ name = "[Instance4]", class = "SubFixture", no = 3, parent = f501, props = { FID = 9001 } })
local orphan = H({ name = "[Orphan]", class = "SubFixture", no = 7, parent = fixtures, props = {} })
local bySf = { [63] = f401, [64] = f402, [11] = c1, [12] = c2, [13] = c3, [99] = orphan }
GetSubfixture = function(i) return bySf[i] end

local function grid(x, y, z) return { x = x, y = y, z = z, inv = 0, x_inv = 0, y_inv = 0, z_inv = 0 } end
local groupData = {
  { sf_index = 64, grid = grid(3, 0, 0) },
  { sf_index = 63, grid = grid(0, 0, 0) },
  { sf_index = 11, grid = grid(-1, 2, 1) },
  { sf_index = 12, grid = grid(0, 0, 0) },
  { sf_index = 13, grid = grid(5, 5, 5) },
  { sf_index = 99, grid = grid(1, 1, 0) },
  "garbage",
}
local group = H({ name = "Mixed", class = "Group", no = 900, addr = "14.14.1.6.900", props = {
  SelectionData = groupData, Lock = function(role) return role and "" or 0 end, PreserveGridPositions = function(role) return role and "Yes" or 1 end,
} })
local empty = H({ name = "Empty", class = "Group", no = 901, addr = "14.14.1.6.901", props = { SelectionData = {}, Lock = "UL", PreserveGridPositions = "No" } })
local broken = H({ name = "Broken", class = "Group", no = 902, props = { SelectionData = "", Lock = "" } })
local seq = H({ name = "Seq", class = "Sequence", no = 1, props = {} })
local objects = { ["Group 900"] = group, ["Group 901"] = empty, ["Group 902"] = broken, ["Sequence 1"] = seq }
ObjectList = function(ref) local h = objects[ref]; return h and { h } or nil end
IsObjectValid = function() return true end

local selection = {}
SelectionCount = function() return #selection end
SelectionFirst = function() local e = selection[1]; if not e then return nil end return e[1], e[2], e[3], e[4] end
SelectionNext = function(cur)
  for i, e in ipairs(selection) do
    if e[1] == cur then local n = selection[i + 1]; if not n then return nil end return n[1], n[2], n[3], n[4] end
  end
  return nil
end

-------------------------------------------------------------------------------
-- Load the plugin
-------------------------------------------------------------------------------

local signals = {}
local pluginHandle = { name = "gma3_mcp_bridge", Count = function() return 1 end, Ptr = function(_, i) return i == 1 and { name = "gma3_mcp_bridge", Get = function() return false end } or nil end }
local componentHandle = { name = "gma3_mcp_bridge", Parent = function() return pluginHandle end }
local chunk = assert(loadfile(pluginPath))
chunk("gma3_mcp_bridge", "gma3_mcp_bridge", signals, componentHandle)
local state = _G.__gma3_mcp_bridge
local json = require("json")

local failures, passes = 0, 0
local function check(name, cond, detail)
  if cond then passes = passes + 1; print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end
local function J(v) local ok, s = pcall(json.encode, v); return ok and s or tostring(v) end
local function request(op, args)
  local line = json.encode({ id = "t", op = op, args = args or {} })
  local co = coroutine.create(function() return state._handleLine({ id = 1 }, line) end)
  local ok, res = coroutine.resume(co)
  while ok and coroutine.status(co) == "suspended" do ok, res = coroutine.resume(co) end
  assert(ok, res)
  return json.decode(res)
end

-------------------------------------------------------------------------------
-- group.read
-------------------------------------------------------------------------------

local r = request("ping")
check("ping reports bridge 0.30.0", r.ok and r.result.bridgeVersion == "0.32.0", J(r))

r = request("group.read", { ref = "Group 900" })
local it = r.ok and r.result.items or {}
check("group.read: selection order kept, not sorted by grid or number", r.ok and r.result.count == 7 and it[1].fixture == "402" and it[2].fixture == "401", J(r))
check("group.read: grid coordinates as stored, negative and z included", it[1] and it[1].x == 3 and it[1].y == 0 and it[1].z == 0 and it[3].x == -1 and it[3].y == 2 and it[3].z == 1, J(it))
check("group.read: a cell without FID is named by its parent's FID and its number", it[3] and it[3].fixture == "501.1" and it[3].fid == nil and it[4].fixture == "501.2" and it[3].sfIndex == 11, J(it))
check("group.read: shared cells are both reported", it[2] and it[4] and it[2].x == 0 and it[4].x == 0 and it[2].y == 0 and it[4].y == 0, J(it))
check("group.read: a cell with its own FID reports it and its dotted path", it[5] and it[5].fid == 9001 and it[5].fixture == "9001" and it[5].path == "501.3", J(it[5]))
check("group.read: every item carries the console address", it[1] and it[1].addr == "addr:Par 2" and it[3].addr == "addr:[Instance2]", J(it))
check("group.read: a top-level fixture has no path, a cell's path is its fixture id", it[1] and it[1].path == nil and it[3].path == "501.1", J(it))
check("group.read: a parent chain without FID gives no fixture id", it[6] and it[6].fixture == nil and it[6].sfIndex == 99 and it[6].x == 1, J(it[6]))
check("group.read: an entry that is not an item is reported unreadable, never dropped", r.ok and r.result.unreadable == 1 and it[7] and it[7].unreadable == true, J(r))
check("group.read: lock and PreserveGridPositions in the edit role, an unlocked group reads \"\"", r.ok and r.result.lock == "" and r.result.preserveGridPositions == "Yes" and r.result.no == 900 and r.result.name == "Mixed", J(r))

r = request("group.read", { ref = "Group 901" })
check("group.read: an empty group is an empty array", r.ok and r.result.count == 0 and type(r.result.items) == "table" and #r.result.items == 0 and r.result.lock == "UL", J(r))
check("group.read: an empty group encodes items as a JSON array", J(r):find('"items":%[%]') ~= nil, J(r))

r = request("group.read", { ref = "Group 902" })
check("group.read: SelectionData that is not a table is an error, not an empty group", r.ok == false and r.code == "unreadable", J(r))
r = request("group.read", { ref = "Sequence 1" })
check("group.read: a non-group is refused", r.ok == false and r.code == "not-group", J(r))
r = request("group.read", { ref = "Group 999" })
check("group.read: a missing group is an error", r.ok == false and r.error:find("no object found"), J(r))

-------------------------------------------------------------------------------
-- selection.grid
-------------------------------------------------------------------------------

r = request("selection.grid")
check("selection.grid: an empty selection", r.ok and r.result.count == 0 and #r.result.items == 0, J(r))

selection = { { 64, 3, 0, 0 }, { 63, 0, 0, 0 }, { 11, 2, 1, 1 } }
r = request("selection.grid")
it = r.ok and r.result.items or {}
check("selection.grid: order, ids and grid positions", r.ok and r.result.count == 3 and #it == 3 and it[1].fixture == "402" and it[1].x == 3 and it[2].fixture == "401" and it[3].fixture == "501.1" and it[3].z == 1, J(r))

local realFirst = SelectionFirst
SelectionFirst = function() error("boom") end
r = request("selection.grid")
check("selection.grid: a failing SelectionFirst is an error, never an empty selection", r.ok == false and r.code == "unreadable", J(r))
SelectionFirst = realFirst

print(string.format("%d passed, %d failed", passes, failures))
if failures > 0 then print("FAILED"); os.exit(1) end
print("ALL PASSED")
