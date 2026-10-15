# SU-03 probe: fixture-type library, import and removal (macOS, onPC 2.5.1)

Evidence for [SU-03 in SETUP.md](../../SETUP.md#su-03--find-and-import-fixture-types).

- **Date:** 2026-10-15
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, a new throwaway show (`NewShow_2026.10.15_04.21.01UTC`,
  3 fixture types, 9 fixtures), bridge 0.25.2 with Lua on
- **Method:** a manual pass through `gma3_lua`: reads first, then each change queued with `CmdIndirect` and read
  back in a later request (a queued command lands a frame later), with `GetTopModal` after each step: no dialog
  appeared. Copy-against-live comparisons through the bridge's own `patch.fingerprint` and a property-by-property
  diff. The show ended with 5 types, 395 attributes and 10 fixtures (one beam patched for the renumbering check), the
  command line at Root and the copy closed.

## Where the libraries are

`GetPath(Enums.PathType.<name>)` names every library folder; nothing needs to be hard-coded.

| Path type | Folder (this machine) | Content |
| --- | --- | --- |
| `GrandMA3Library` | `gma3_2.5.1/shared/lib_fixture_types/grandma3` | 171 `.xml`: 5 fixtures (Ayrton, 2 MA Lighting, 2 Generic) and 166 `set@` scenery pieces (trusses, buildings, markers) |
| `GrandMA2Library` | `gma3_2.5.1/shared/lib_fixture_types/grandma2` | 11 535 `.pxml`, named `manufacturer@model.pxml` in lower case; encrypted |
| `UserFixtures` | `gma3_library/fixturetypes` | the user library: empty here (only the console's cache) |
| `WorldServerLibrary` | `gma3_2.5.1/shared/lib_fixture_types/worldserver` | empty here |
| `UserGdtfResources` | `gma3_library/fixturetyperesources/gdtfresources` | GDTF resources |

- `DirList(path, filter)` returns `{name, size, time}` per file: 171 grandMA3 files in 2 ms, all 11 535 grandMA2
  files in 68 ms.
- A grandMA3 `.xml` is readable text: `<FixtureType Name=… Manufacturer=… ShortName=… Description=…>` and one
  `<DMXMode Name=…>` per mode.
- A grandMA2 `.pxml` is encrypted (`file` reports data). Its manufacturer and model are known only from the file
  name, and its modes only after an import.
- The console's own library index (`lib_fixture_types/libcache.dat2.dat`, 8 MB, `GMA3` header) holds names and
  modes for both libraries, but compressed in an undocumented format. Not used.
- The object-free `Import(file)` returns nil for both a grandMA3 `.xml` and a `.pxml`: it is not a reader for
  fixture types.
- No library object exists in the object tree outside the Patch UI (a scan of `Root()`, `Temp` and `ShowData`).
  `Temp.ConvertTask` is MVR and show conversion.

## Importing

| Step | Result |
| --- | --- |
| `CmdIndirect('ChangeDestination "ShowData"."Patch"')`, then `CmdIndirect('ChangeDestination "FixtureTypes"')` | the copy opens and the destination is `FixtureTypes`; no dialog |
| `CmdIndirect('Import Library "generic@dimmer.pxml"')` | `OK: Import Library …`; a new type at the end of the copy's `FixtureTypes` (No 4, "Dimmer", Manufacturer Generic, Source grandMA2, 2 modes with footprints); the live patch unchanged; no dialog |
| The same import again | **a second "Dimmer"** (No 5, same name and short name, a new GUID); no dialog, no warning |
| `Import Library "shehds@180w beam moving head.pxml"` and `Import Library "ayrton@alienpix-rs.xml"` in one request | both imported in order (grandMA2 and grandMA3 sources by the same command); 12 attributes added (363 → 375) |
| `CmdIndirect('ChangeDestination Root')` | commits silently; the types are live, the fixtures untouched |

- A combined `ChangeDestination "ShowData"."Patch"."FixtureTypes"` lands elsewhere, and an import there answers
  "Object not found" (the standalone crash reproduction, 2026-10-14). One level per `ChangeDestination`.
- An imported type does not record its file: `ORIGINALFILENAME` is empty. Its `Name` and `Manufacturer` match the
  `.pxml` file name's model and manufacturer apart from case (`generic@dimmer` is "Dimmer" by "Generic",
  `oppsk@36pcs 4in1 led wall washer` is "36PCS 4in1 LED Wall Washer" by "Oppsk"), so a duplicate can be detected
  before importing by manufacturer and name.
- `USED` and `REALUSED` on a type are 0 while no fixture uses it.

### What an import changes in the copy

`patch.fingerprint` per collection, copy against live, with one type imported and nothing else done:

| Collection | Copy against live |
| --- | --- |
| FixtureTypes | different: 2 376 objects against 2 321, the new type's 55 |
| AttributeDefinitions | different with the same 420 objects: `LOGCHANNELS` and `CHANNELFUNCTIONS` on the Dimmer attribute and feature, 19 → 21 |
| DmxCurves, Layers, Classes, PsrExtraData, Stages, IDTypes, DmxUniverses | equal |

`LOGCHANNELS` and `CHANNELFUNCTIONS` count the fixture-type channels using an attribute: console-derived, like the
counters the fingerprint already skips.

**New attributes and features are appended.** Importing the Martin Mac Aura XB (a type with attributes the show
lacked) grew `Attributes` from 375 to 395, the first 375 unchanged and in order, and gave the `Control` feature group a
second feature (`Control`, then `FIXTURE`). `DeactivationGroups` (2), `ActivationGroups` (20) and the other feature
groups were unchanged. The live objects are therefore a prefix of the copy's in those lists, which is what an import
session's isolation check compares there; every other container is compared in full (review of PR #48: truncating
every container would have let an unrelated fixture added to the copy through). An import that brings attributes also raises `ATTRIBCOUNT`, a feature's attribute count (Clay Paky Sharpy: Beam 72 → 74,
Control 103 → 113); the fingerprint skips it with the other counters. With that, the Ayrton Ghibli import (14 new
attributes) passed the narrowed check, committed and read back, and was removed again.

## Removing

- `FixtureTypes:Delete(index)` in the copy removes a type, with no dialog. Committed, an unused type is gone and the
  counters return (`LOGCHANNELS` 21 → 19).
- **Attributes a type brought stay.** After the beam and the Alienpix were imported (+12 attributes) and deleted
  again, the commit left 375 attributes: the 12 remain, unused (`LogChannels = 0`), at the end of the list.
  The console's own unused attributes also read 0 (362 and 363 here), so a later removal cannot tell which
  attributes an import added. They are harmless but stay in the show.
- **Deleting a type renumbers the ones after it.** With types 1–5 and fixture 301 of type 5 (the beam), deleting
  type 4 in the copy made the beam No 4. Fixture 301 then reads `FixtureType` "4 180W Beam Moving Head" in the copy
  against "5 180W Beam Moving Head" live, its mode and address unchanged. After the commit the fixture is intact
  (1.300) under the new number.
- `Get("FixtureType")` without the display role returns the type's handle, so a fixture's type can be compared by
  name and GUID instead of by number.
- Deleting a type that fixtures use was not tried: the tool refuses it, and trying would commit a destructive change.

## The tools, live (bridge 0.26.0)

`test/live/patch-import.live.ts`, 1/1 in about 100 s: search, import Fog, refuse a second Fog, import Fan, patch FID
994 as a Fan, remove Fog (Fan renumbered while in use), refuse removing Fan, remove 994 and Fan. The KB-26 patch live
test passes on the same bridge (64 s; the show's larger fixture-type tree makes the fingerprints slower).

The first run found that the type's own `Name` and a fixture's `ModeDirect` also carry the type's number in the display
role (`FixtureType 7 'Fan'`, `FixtureType 7 'Fan'.DMXModes.DMXMode 1 'Mode 0'`): removing Fog left those as the only
differences, and the isolation check refused the commit, leaving the copy open. The fingerprint now hashes a type's
name, `ModeDirect` by the mode's type GUID and name, and strips the number from any other `FixtureType N '` text.

## Not established

- GDTF (`.gdtf`) and user-library `.xml` imports: no such files on this machine.
- Importing from a USB drive (`Import Library … Drive N`).
- What the console does when a type in use is deleted.
- The import dialog of the Patch menu was not opened; the command path needs no dialog.
