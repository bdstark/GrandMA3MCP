# SU-04 probe: fixture position, rotation and mirroring (macOS, onPC 2.5.1)

Evidence for [SU-04 in SETUP.md](../../SETUP.md#su-04--place-fixtures-in-3d).

- **Date:** 2026-10-15
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, the throwaway show `NewShow_2026.10.15_04.21.01UTC`,
  bridge 0.26.0 with Lua on for the reads
- **Method:** writes through the bridge's existing `set` op (no Lua) and `gma3_lua`, read back in the same and in a
  later request; fixtures 201–204 (Oppsk wall washers) were reset to 0 afterwards.

## Axes and units (the manual)

`patch_position_fixtures.html`: positions in metres, rotations in degrees, "the grandMA3 software currently only works
with meters and degrees". New fixtures sit at 0 with 0 rotation.

| Axis | Positive direction |
| --- | --- |
| X | stage left |
| Y | upstage |
| Z | up (above the stage) |
| Rotation X | about the fixture's own X axis: the top tilts downstage |
| Rotation Y | about its own Y axis: the top tilts stage left |
| Rotation Z | about its own Z axis: counter-clockwise seen from above |

## Properties

| Property | Raw | Display role | Writable |
| --- | --- | --- | --- |
| `POSX`, `POSY`, `POSZ` | number, metres | `1.500` (3 decimals: millimetres) | yes, through `set` (no Lua) |
| `ROTX`, `ROTY`, `ROTZ` | number, degrees | `-45.00` (2 decimals) | yes, through `set` |
| `ROTDIRECT` | nil | quaternion `x,y,z,w` (6 decimals) | not tried |
| `SCALEX`, `SCALEY`, `SCALEZ` | 1.0 | `1.00` | **ignored**: −1 and 2 both read back 1.00, with no error |
| `MESHMIRRORX` | boolean | `""` off, `Yes` on | yes, through `set` with the text `1` / `0`; `false`, `No` and `On` do not change it |

A sub-fixture (cell, class `SubFixture`) has none of these properties: cells cannot be placed individually (SU-08).

## Rotation: convention and normalization

- The quaternion matches **q = qZ · qY · qX** (R = Rz · Ry · Rx; intrinsic Z, Y′, X″) for three rotations
  ((−45, 0, 30), (30, 100, 20), (10, −95, 170)); no other order or sign combination does.
- **The console renormalizes the angles a frame later** and keeps the quaternion. Read in the same request the angles
  are as written; in the next request Y is within ±90°:

  | Written (X, Y, Z) | Read the next request | Quaternion (unchanged) |
  | --- | --- | --- |
  | 0, 180, 0 | 180, 0, 180 | 0, 1, 0, 0 |
  | 30, 100, 20 | −150, 80, −160 | 0.035349, 0.757590, −0.087439, 0.645881 |
  | 10, −95, 170 | −170, −85, −10 | 0.736809, −0.005356, 0.676059, −0.005356 |

  This explains the field test's `ROTY = 180` reading back as (180, ~0, 180). A tool compares quaternions, and a
  rotation given as one axis cannot safely be combined with the other two axes as the console reports them.

## The patch copy and undo

- Positions are properties of the live patch's fixtures; `ObjectList("Fixture N")` returns the live fixture.
- **An open patch copy overwrites position writes when it is committed.** With the copy open, fixture 203's `POSX` was
  set to 4.0 in the live patch (the copy still held 0); `ChangeDestination Root` committed the copy and `POSX` read 0
  again. A tool must refuse while the copy is open.
- **No undo:** `Oops` after a `set` of `POSX` answered `Failed` and the value stayed.

## Not established

- Fixtures inside a grouping fixture: whether their position is relative to the parent.
- More than one stage: whether positions are relative to the stage.
- What `MESHMIRRORX` changes in the 3D view (the flag sticks; the effect was not looked at).
- Writing `ROTDIRECT` directly.
