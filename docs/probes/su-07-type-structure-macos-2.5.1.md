# SU-07 probe: fixture-type structure, cells, channels and geometry (macOS, onPC 2.5.1)

Evidence for [SU-07 in SETUP.md](../../SETUP.md#su-07--fixture-type-structure-readback).

- **Date:** 2026-10-15
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, the throwaway show `NewShow_2026.10.15_04.21.01UTC`,
  bridge 0.27.0 then 0.28.0
- **Method:** read-only Lua through the bridge's `lua` op: every property of the type's nodes (`PropertyCount` /
  `PropertyName`, display role), handles by index and `Get()`. The field-test transcripts
  (`~/gma3-enduser/showtest`, 2026-10-14) show the ten `gma3_lua` calls this replaces. Types: 1 Oppsk 36-LED wall
  washer (52-channel mode, 12 cells), 2 Chauvet Festoon 2 RGB (10 modes, pixel modes with 20, 40 and 60 cells),
  3 Mega Hex Par, 4 180 W beam, 5 Mac Aura XB. Nothing was changed.

## The tree

```
FixtureType
  DMXModes / DMXMode       TotalFootprint, DMXFootprint, Geometry / GeometryDirect (the mode's root geometry)
    DMXChannels / DMXChannel   Geometry, Coarse, Fine, Ultra, DMXBreak, Default, DefaultChannelFunction
      LogicalChannel / ChannelFunction   Attribute
    SubfixtureOverview     one empty FTSubfixture here: not the cell list
  Geometries               Geometry, Beam, Axis, GeometryReference (PosX/Y/Z, RotX/Y/Z, Model, Geometry = template)
    GeometryReference / Break    DMXBreak, DMXPatch (the cell's offset in that break)
  Models / Model           Length, Width, Height (metres), File
```

Lengths read raw are metres (`PosX` -0.44 on the washer's first cell); angles are degrees. A GeometryReference
answers its template only through `GeometryDirect` or `Get("Geometry")`, not the plain index; a DMXChannel answers
`Geometry` by index. Parents are `:Parent()` (`GetParent` does not exist).

## Cells

A mode's cells are the GeometryReference nodes under its root geometry. A patched fixture of that mode gets them as
SubFixture children of the same names:

| Fixture | Mode, root | References under the root | SubFixture children |
| --- | --- | --- | --- |
| 201 wall washer | 52 channel, Body | 12 (Instance2 … Instance13) | 12 (`[Instance2]` …) |
| 401 Festoon | Pixel Mode - 2 string, Body#4 | 40 (`Instance1#3` …) | 40 (`[Instance1#3]` …) |
| 101 Mega Hex Par | Ch08 | 0 | 0 |

`patch.list`'s `subfixtures` counts Fixture children (grouping fixtures), so it read 0 for both: hence the separate
`cells` count.

## Channels

A mode's DMXChannels are templates. The washer's 52-channel mode has 9:
- `RGBW_ColorRGB_R/G/B/W` (Coarse 1–4) and `RGBW_Dimmer` (Coarse None) on the template geometry `Beam 'RGBW'`;
- four channels on `Body.Main Module` at Coarse 49–52.

Each of the 12 cells references `RGBW` with a Break `DMXPatch` of 1, 5, 9, … So a template channel is at the cell's
offset + its Coarse − 1 in every cell: 12 × 4 + 4 = 52. Coarse None is a virtual channel (no address).

The rule covers every mode of the show's five types (23 modes):
- `addressesUsed` equals the footprint everywhere, with no duplicate address;
- pixel modes: 60, 120 and 180 channels over 20, 40 and 60 cells, plus the Pixel+ modes' global channels;
- the Mac Aura's one-cell modes (the Aura backlight is a referenced geometry);
- 16-bit Pan/Tilt (Fine) on the beam and the Aura.

## Geometry and size

The washer's root geometry `Body` uses the model `Body`: 1.04 m × 0.16 m × 0.055 m, the length the field-test agent
needed to space a pair 1 ft apart. Its cells sit at x = −0.44 … +0.44 m, z = −0.0262 m. The Festoon's full listing
(all modes, every channel and the whole geometry tree of 259 nodes) is 229 KB, so the tool lists channels and
geometry for one mode by default, narrowed to the geometry that mode uses (42 nodes for the two-string mode).

## The tools, live (bridge 0.28.0)

`test/live/type-structure.live.ts` 1/1 (0.7 s):
- every mode of the five types covers its footprint with no limitation, and every addressed channel names its
  attribute;
- `gma3_patch_types` reports the same cell counts;
- every patched fixture's `cells` matches its mode (washers 12, Festoons 40, the rest 0);
- the Festoon's two-string mode, read narrowed in feet, lists its root and 40 references.
