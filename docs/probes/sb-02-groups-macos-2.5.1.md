# SB-02 probe: selection grids, stored groups and MAtricks (macOS, onPC 2.5.1)

Evidence for [SB-02 in SHOWS.md](../../SHOWS.md#sb-02--build-groups-with-selection-grids-and-matricks) and
[the group and MAtricks tools](../tools/groups.md).

- **Date:** 2026-10-13
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, show `mcp-test-disposable`, bridge 0.20.0 (Lua on) for
  the manual pass, 0.21.0 for the tools
- **Method:** a manual pass through `gma3_lua` (`Cmd`, `SelectionFirst` / `SelectionNext`, `Get("SelectionData")`,
  `GetProgPhaser`, `GetPresetData`), then the tools themselves through `test/live/groups.live.ts` (1/1, 3.0 s), which
  reproduces every behaviour the tools rely on without Lua.
- **Objects:** Groups 900–902 and 905–909, MAtricks 900, 903, 905, 906, Sequence 9050 (one cue); all checked absent
  first and deleted afterwards. Fixtures 401–404 (Mega Hex Par), 701–704 (Thrill Mini Profile), 501 (36PCS LED wall
  washer, 12 cells). The show's own Groups 1–110 have empty SelectionData (their fixtures are not in this patch).

## Where the grid lives

| Read | Result |
| --- | --- |
| `Group n` through the `object` op, display role | `SELECTIONDATA` is a writable Custom property that renders as `""` |
| `group:Get("SelectionData")` (no role) | a Lua table in selection order: `{ sf_index = 63, grid = { x, y, z, inv, x_inv, y_inv, z_inv } }` per item |
| `group:Set("SelectionData", "x")` | no error, ignored (data unchanged) |
| `SelectionFirst()` / `SelectionNext(i)` | `subfixture index, x, y, z` in the order fixtures were selected; synchronous after `Cmd()` in the same chunk |
| `GetSubfixture(i)` of a cell | class `SubFixture`, no FID, `no` = cell number, parent = the fixture (FID 501) → id `501.1` |

The bridge's new `group.read` and `selection.grid` ops (0.21.0) return these tables with a fixture id per item; no
existing op could read them.

## Building a selection on the grid

| Commands | Selection (fixture@x/y/z) |
| --- | --- |
| `Grid 0/0/0`, `Fixture 401`, `Grid 3/0/0`, `Fixture 402`, `Grid 1/2/0`, `Fixture 403`, `Grid 2/1/1`, `Fixture 404` | 401@0/0/0 402@3/0/0 403@1/2/0 404@2/1/1 |
| `Grid 3/0/0`, `Fixture 402`, `Grid 0/0/0`, `Fixture 401` | 402@3/0/0 401@0/0/0 (selection order, not grid order) |
| `Grid 0/0/0`, `Fixture 401`, `Grid 5/0/0`, `Fixture 401` (again) | 401@0/0/0: the second selection is **silently ignored** (feedback OK) |
| 401 and 402 both after `Grid 0/0/0` | both at 0/0/0 (shared cell accepted) |
| `Grid -2/-1/0`, `Fixture 401` | 401@-2/-1/0 |
| `Grid 0/0/0`, `Fixture 401 Thru 404` | 401..404 at x 0..3 (the profile's Move Grid Cursor: Append X) |
| `Grid 2/1/0 Fixture 402` (one line) | nothing selected; `Fixture 402 Grid 2/1/0` puts 402 at 0/0/0 |
| `Fixture 501` / `Fixture 501.1` then `Fixture 501` | the parent is one item (501@0/0/0); parent and cells coexist as separate items |
| `Fixture 9999` (not patched) | "Object not found" |

## Storing and recalling

| Case | Result |
| --- | --- |
| `Store Group 900 /NoConfirmation` of the first selection above | OK; SelectionData holds the four cells; PreserveGridPositions Yes; name "Group 900" |
| `Store` of 402@3/0/0 then 401@0/0/0 (selected in that order) | stored **401 first** (patch order); also 401@3 + 402@0 and 402@0 + 401@1 store as 401, 402 |
| Mirrored row 401–404 at x 0..3, 704–701 at x 7..4 (selected in that order) | stored 701, 702, 703, 704, 401, 402, 403, 404 (patch order, subfixture indices 5–8 before 63–66) with their cells |
| `Group 900` after `ClearSelection`, `Grid 0/0/0` | the stored cells, in stored order |
| `Grid 5/5/0`, `Group 900` | every cell + 5/5/0 (the recall adds the cursor) |
| `Fixture 701` at 0/0/0, then `Group 900` | 701@0/0/0, the group shifted by the cursor that Append X moved to 1/0/0 |
| a group stored at 2/2 and 4/2, PreserveGridPositions set to No, recalled at 0/0/0 | 0/0/0 and 1/0/0 (gaps and offset removed); recalled at 5/5/0: 7/7/0 and 9/7/0 |
| `Store Group 901 /NoConfirmation` on an existing group | overwritten (no merge); its name kept |
| `Store Group 901 /Overwrite /NoConfirmation` | overwritten; name kept |
| `Store Group 901 /Merge /NoConfirmation` (old 704@1/1, new 702@3/0) | 702@2/0/0 and 704@1/1/0: the new cell shifted, order changed. Not used |
| `Set Selection MAtricks "XWings" 2`, then `Store Group 902` | HasAnyMAtricksData No: selection MAtricks not stored into the group |
| locked group: `Store ... /Overwrite`, `Set Name`, `Delete` | "Object locked"; name write silently ignored; "Object locked" |

## Distributions follow the cells

`Attribute "Dimmer" At 0 Thru 100`, values read with `GetProgPhaser`:

| Selection | Dimmer |
| --- | --- |
| 401..404, 701..704 at x 0..7 | 0, 14.3, 28.6, 42.9, 57.1, 71.4, 85.7, 100 along X |
| 401@1, 402@0, 403@2 (selected in that order) | 402 0, 401 50, 403 100: by X, not by selection order |
| two rows (401@0/1, 402@1/0, 403@0/0, 404@1/1) | X 0 → 0, X 1 → 100 in both rows |
| the row with `XWings 2` | 0, 33, 67, 100, 100, 67, 33, 0; `SelectionNext` reports X 0 1 2 3 3 2 1 0 |
| `XBlock 2` / `XGroup 2` | 0 0 33 33 67 67 100 100 / 0 100 0 100 ... |
| `XWings 2` with `XInv`, `XInvW` or `InvertX` Yes | unchanged (the invert flags did not change a value spread) |

A cue stored from the row with `Recall MAtricks` (XWings 2, DelayFromX 1, DelayToX 0) keeps `gridposmatr` 0 1 2 3 3 2
1 0 per channel (`GetPresetData` on the part) but no per-fixture delay; the programmer phaser data has none either.
MAtricks timing can therefore only be verified as the object's settings.

## MAtricks objects

| Write (`Set` on `MAtricks 900`, read in the display role) | Result |
| --- | --- |
| `XWings` 2 / 0 / None / -1 / "abc" / 3 | 2 / None / None / **ignored** / **ignored** / 3 |
| `XBlock` 2, `XGroup` 4, `X` 1, `XWidth` 2, `XShift` 1 and -1, `XShuffle` 3, `YWings` 2, `ZGroup` 2 | applied |
| `PhaseFromX` 0, `PhaseToX` 360 / 720 / -90, `PhaseFromX` None | `0°`, `360°` / `720.00` / `-90.00`, None |
| `FadeFromX` 0, `FadeToX` 2 / 2.5, `DelayToX` 1 / "bogus" | `0.00`, `2.00` / `2.50`, `1.00` / ignored |
| `SpeedFromX` 60 / 120 / 30; "Hz 2", "2Hz", "BPM 90" | `60.00 BPM` (edit role `1.000000`, raw 60.0), 120 → edit `2.000000`, 30 → `0.500000`; the unit forms are not accepted (None) |
| `XInvB` Yes, `InvertStyle` All, `AlignRangeX` Yes | applied |
| `Store MAtricks 903` with selection MAtricks XWings 2, DelayToX 3 | the new object has XWings 2 and DelayToX 3.00: **Store copies the selection MAtricks** |
| `Label MAtricks 904 "probe"` (not existing) | "Illegal object" (Label does not create) |
| `Call MAtricks 900` / `MAtricks 900` / `Recall MAtricks 900` / `Load` / `Select` | "Not implemented" / applied / applied / OK but not applied / "Illegal object" |

Defaults after `Reset Selection MAtricks` (used to reset a new object): every per-axis value None, all invert flags No,
InvertStyle Pan, AlignRange X/Y/Z No, RelativeFade/Delay/Phase Yes, RelativeSpeed No, PhaserTransform None, ShuffleMode
Auto, SpeedMasterOverride "".

## Speed-master override (review round 1)

`SpeedMasterOverride` (enum `SpeedMasterMtxOverride`) is another MAtricks property Store copies from the selection.

| Write on a fresh `MAtricks` (edit role read back) | Result |
| --- | --- |
| fresh object; selection after `Reset Selection MAtricks` | `""` |
| `"1"`, `"2"`, `"15"`, `"16"`, `"255"` | `Beat`, `Position Speed`, `Speed15`, `BPM`, `BPM` (the speed masters' names) |
| `"0"` from each of those | `""`: the clearing form |
| `""`, `"None"`, `"Off"`, `"Speed 2"` | silently ignored |
| `"Speed1"`, `"Speed2"`, `"Speed3"`, `"No Master"`, `"BPM"` (enum names) | inconsistent (`""`, `Beat`, `Position Speed`, `Speed15`, or ignored, depending on the previous value): not used |
| `Set Selection MAtricks "SpeedMasterOverride" 2`, then `Store MAtricks 911` | the new object reads `Position Speed`: copied |
| override 2 with SpeedFromX None | SpeedFromX becomes `1.000000` (60 BPM) |
| SpeedFromX None again, then override `"0"` | SpeedFromX `1.000000` again; also `"0"` on an already clear override fills it |
| SpeedFromX 120, SpeedToX 30, then override 2 and `"0"` | speeds kept |

The tools reset the override with `"0"` first and then write every planned speed. The first live run after adding
the reset wrote it last and verification caught SpeedFromX back at `1.000000`; the order fixes it.

## The tools on the console

`gma3_store_group` live (bridge 0.21.0): the mirrored row (preview, then store) and an explicit grid (402@3/0, 401@0/0,
501.1@-1/2/1, 501.2@0/2, 501@5/5) stored, read back from SelectionData and recalled at 0/0/0 with the same fixtures on
the same cells; the selection was empty afterwards. The first version compared list positions and reported the
patch-order store as a mismatch, which is how the patch-order behaviour was found; the tools now compare fixture by
fixture. `gma3_configure_matricks` created MAtricks 905 (XWings 2, delay 1 → 0, phase 0 → 720, speed 60 → 60) and,
with a dirty selection MAtricks (XGroup 3, YWings 2, FadeToY 2), MAtricks 906 with exactly the request (the copied
values reset). The first speed write failed verification because the edit role reads Hz; the tools now convert.
