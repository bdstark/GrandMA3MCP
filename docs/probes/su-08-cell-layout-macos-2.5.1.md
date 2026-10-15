# SU-08 probe: where a cell's position lives, type copies and retyping (macOS, onPC 2.5.1)

Evidence for [SU-08 in SETUP.md](../../SETUP.md#su-08--lay-out-a-fixtures-cells).

- **Date:** 2026-10-15
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, the throwaway show `NewShow_2026.10.15_04.21.01UTC`,
  bridge 0.28.0 then 0.29.0
- **Method:** Lua through the bridge's `lua` op, with patch sessions through `patch.enter` / `patch.commit`.
  - Fixtures: Festoon 2 RGB 401 and 402 (Pixel Mode - 2 string, 40 cells) and the wall washers 201–204 (12 cells).
  - Preset 4.951 and Group 951 were checked empty, created for the probe and deleted afterwards.
  - The type copies the probe and smoke runs made were removed again with `gma3_patch_remove_type`, after their
    fixtures were moved back.

## A cell has no position of its own

A Festoon's `SubFixture` children (`[Instance1#3]` …) have no `PosX/Y/Z` or `RotX/Y/Z`: reading them raises. They
carry only `SubfixtureIndex`, `No` and identity. The fixture itself has its position, rotation and scale, plus
`P1X`…`P4Z` points, which were not used here.

A cell's place is its `GeometryReference` in the fixture type, under the DMX mode's root geometry (SU-07). Every
fixture whose mode uses that root shares it. Several modes may share one root: the Mega Hex Par's Ch07, Ch08, Ch11 and
Ch12 all use `Body#2`.

## Copying a type and retyping a fixture

Selective Preset 4.951 was stored from Festoon 402 first: 120 values, R 100 / G 30 / B 100 on 40 cells. Group 951 was
stored holding 402.

| Step (in the patch copy, then committed) | Result |
| --- | --- |
| `FixtureTypes:Append()`, `:Copy(festoon)`, `Set("Name", "Festoon 2 RGB layout B")` | type 6 with all 10 modes and 14 geometries; its GUID reads all zeros and its modes read `TotalFootprint` 0 until the commit |
| `fixture402:Set("ModeDirect", copy.DMXModes[5])` | type "6 Festoon 2 RGB layout B", mode "5 Pixel Mode - 2 string", patch 2.121, 40 cells: unchanged apart from the type |
| commit (`ChangeDestination Root`) | the copy gets its own GUID; `Used` 1 |
| Preset 4.951 after the commit | 120 rows for 402, now of type "layout B", the same values; `At Preset 4.951` on 402 fills all 120 |
| Group 951 | still holds 402 |
| `Fixture 402.1`, `At 50` | the cell is selectable as before |

Cue values cannot be read back on 2.5.1 (SU-06), so the selective preset stands in for programmed data.

**The copy is independent.** Its root and cells are different objects from the original's. `Set("PosX", 0.5)` on the
copy's first cell changed only the copy (live patch, read back at once).

## Writing cell positions

Positions are written in the live patch with `Set("PosX"|"PosY"|"PosZ", metres)` on the GeometryReference, and read
back at once. The field test did the same through `gma3_lua` and saved the show. An open patch copy would overwrite
them when it is committed, as SU-04 found for fixture positions, so the writes are refused while it is open.

## Consequences for the tools

- **Shared:** the type's layout, with every fixture that uses it named (`affects`).
- **Own:** a type copy plus a retype in one patch session. The fixture's FID, address, cells, groups and preset values
  are kept.
- A retype checks that the target mode has the same channels. A fresh copy's footprint is 0 until the commit, so the
  footprints are compared only when both are known.

## The tools, live (bridge 0.29.0)

**Smoke runs:**
- the field test's square wave on a Festoon (2 ft spacing, 10 ft legs): the planned positions match the field test's
  layout exactly, and 40 cells read back within 0.1 mm;
- a shared write on the washers with only one of the four FIDs in `affects`: refused;
- an own layout ("Wall Washer reversed") for washers 203 and 204: the copy's cells read reversed, while 201 and 202
  keep the original;
- 204 assigned back;
- assigning a washer to the Festoon type: refused (no mode of that name), with the copy closed unchanged.

`test/live/cell-layout.live.ts` 1/1 (49 s, mostly the isolation checks of three patch sessions) on washers 201 and
202:
1. a shared line layout, refused without every sharing fixture, then laid out and restored;
2. an own square-wave layout for 202 while 201 keeps its layout;
3. 202 assigned back and the copy removed.

The show was left with its five types and the washers' original layout.
