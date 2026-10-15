-- Reproduction of an onPC 2.5.1 crash in AddFixtures (documented Lua API).
--
-- Run on a NEW, EMPTY show:
--   Import Plugin Library "addfixtures_repro.xml" At Plugin <free slot>
--   Plugin "addfixtures_repro" "<variant>"
--
-- Every variant imports the fixture types it needs from the shipped grandMA2 library, then calls
-- AddFixtures exactly as the manual's example does (lua_objectfree_addfixtures.html): command line in
-- "ShowData"."Patch" / "Stages"."Stage 1"."Fixtures", a mode handle from Patch(), amount, fid, patch.
--
--   A  Oppsk 36PCS 4in1 LED Wall Washer, "52 channel" (12 cells), amount 4, patch 1.001   (the field crash)
--   B  same type and mode, amount 2, patch 1.001
--   C  same type and mode, amount 2, no patch
--   D  ADJ Mega Hex Par, "Ch08" (no cells), amount 2, patch 1.001                         (control)
--   E  same type as A, amount 1, patch 1.001                                              (control)
--
-- Before calling AddFixtures it appends the exact call to <temp>/addfixtures_repro.log and closes the
-- file, so the record survives a crash; the result is appended after the call returns.

local VARIANTS = {
  A = { file = "oppsk@36pcs 4in1 led wall washer.pxml", type = "36PCS 4in1 LED Wall Washer", mode = "52 channel", amount = 4, patch = "1.001" },
  B = { file = "oppsk@36pcs 4in1 led wall washer.pxml", type = "36PCS 4in1 LED Wall Washer", mode = "52 channel", amount = 2, patch = "1.001" },
  C = { file = "oppsk@36pcs 4in1 led wall washer.pxml", type = "36PCS 4in1 LED Wall Washer", mode = "52 channel", amount = 2 },
  D = { file = "adj@mega hex par.pxml", type = "Mega Hex Par", mode = "Ch08", amount = 2, patch = "1.001" },
  E = { file = "oppsk@36pcs 4in1 led wall washer.pxml", type = "36PCS 4in1 LED Wall Washer", mode = "52 channel", amount = 1, patch = "1.001" },
}

local function logPath()
  local ok, dir = pcall(GetPath, Enums.PathType.Temp)
  return ((ok and dir) or ".") .. "/addfixtures_repro.log"
end

local function log(line)
  local f = io.open(logPath(), "a")
  if f then f:write(os.date("%Y-%m-%d %H:%M:%S "), line, "\n"); f:close() end
  Printf("addfixtures_repro: %s", line)
end

local function destination()
  local ok, d = pcall(function() return tostring(CmdObj():Get("Destination", Enums.Roles.Display)) end)
  return ok and d or "unknown"
end

local function main(_, argument)
  local key = (argument and argument ~= "" and argument:upper()) or "A"
  local v = VARIANTS[key]
  if not v then log("unknown variant " .. tostring(argument) .. " (use A, B, C, D or E)"); return end
  local okV, version = pcall(Version)
  log(string.format("repro 1.0.1, variant %s, grandMA3 %s", key, okV and tostring(version) or "unknown"))

  -- Import the fixture type when the show does not have it yet.
  Cmd("ChangeDestination Root")
  if not Patch().FixtureTypes[v.type] then
    -- One level per ChangeDestination (a combined "ShowData"."Patch"."FixtureTypes" path did not land there).
    for _, c in ipairs({ 'ChangeDestination "ShowData"', 'ChangeDestination "Patch"', 'ChangeDestination "FixtureTypes"' }) do Cmd(c) end
    log("destination for the import: " .. destination())
    log("import " .. v.file .. ": " .. tostring(Cmd('Import Library "' .. v.file .. '"')))
    Cmd("ChangeDestination Root")
  end
  if not Patch().FixtureTypes[v.type] then log("fixture type " .. v.type .. " is not in the show after the import; stopping"); return end

  -- As in the manual's example.
  Cmd("ChangeDestination Root")
  Cmd('ChangeDestination "ShowData"."Patch"')
  Cmd('ChangeDestination "Stages"."Stage 1"."Fixtures"')
  log("destination for AddFixtures: " .. destination())
  local mode = Patch().FixtureTypes[v.type].DMXModes[v.mode]
  if not mode then log("DMX mode " .. v.mode .. " not found; stopping"); Cmd("ChangeDestination Root"); return end
  local cells = mode.SubfixtureOverview and mode.SubfixtureOverview:Count() or "?"
  local t = { mode = mode, amount = v.amount, fid = "201", name = "Repro" }
  if v.patch then t.patch = { v.patch } end

  log(string.format("calling AddFixtures{ mode = %s/%s (footprint %s, SubfixtureOverview %s), amount = %d, fid = \"201\", name = \"Repro\", patch = %s }",
    v.type, v.mode, tostring(mode:Get("DMXFootprint", Enums.Roles.Display)), tostring(cells), v.amount, v.patch and ('{ "' .. v.patch .. '" }') or "nil"))
  local ok, ret = pcall(AddFixtures, t)
  log("AddFixtures returned: ok=" .. tostring(ok) .. " ret=" .. tostring(ret))

  -- Leave the patch: ChangeDestination Root commits the patch copy.
  Cmd("ChangeDestination Root")
  local n = 0
  for _, st in ipairs(Patch().Stages:Children()) do n = n + st.Fixtures:Count() end
  log("fixtures in the show now: " .. n)
end

return main
