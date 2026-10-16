# SU-19 probe: fixture-type data, cell order and wheels (macOS, onPC 2.5.1)

Evidence for [SU-19 in SETUP.md](../../SETUP.md#su-19--fixture-type-data-cell-order-and-wheels).

- **Date:** 2026-10-16
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, the throwaway show `NewShow_2026.10.15_23.16.24UTC`,
  bridge 0.33.0, then 0.34.0
- **Method:**
  - `patch.typeStructure` and `patch.cellLayout`, read-only;
  - the `lua` op over `FixtureType.Wheels` and a DMX mode's channel functions and channel sets.
  - Then `test/live/fixture-type-data.live.ts`.

## Cell order

Type 4 "Festoon 2 RGB", mode "Pixel Mode - 2 string": 40 cells (GeometryReferences `Instance1#3` …
`Instance40#2` under `Body#4`), one break, 3 channels per cell.

| Cells (by number) | Break offsets | Positions (ft) |
| --- | --- | --- |
| 1–9 | 1, 4, … 25 | x 1 down to y −10, then x 3 back up to −6 |
| 10–18 | 61, 64, … 85 | x 7 from −6 up to 0, x 9 down to −8 |
| 19–29 | 28, 31, … 58 | x 3 −4 to 0, x 5 down, x 7 −10 to −8 |
| 30–40 | 88, 91, … 118 | x 9 −10, x 11 up to 0, then four bulbs at x 11, y +1 |

- **DMX order:** sorted by offset, the cells run 1–9, 19–29, 10–18, 30–40. That is the interleave the field-test
  agent computed by hand.
- **Positions:** in that order every step between neighbouring cells is 0.6096 m (2 ft), except the last four bulbs,
  which share one position. In cell-number order the path jumps up to 2.20 m (cell 9 to 10, and back).
- So the physical order is the DMX order. Data runs along the string, and the type's positions agree.
- Geometry names and breaks do not give it: the names follow the cell numbers, and the mode has one break.

The type's cell k is the patched fixture's cell k: `patch.cellLayout` on fixture 401 lists the same names at the
same indices (`401.10` is `Instance10#3`).

## Wheels

Type 3 "180W Beam Moving Head" (converted from the grandMA2 library):

| Read | Result |
| --- | --- |
| `FixtureType.Wheels` | 4 wheels: C1 (12 slots), G1 (15), E (2), E2 (3) |
| a slot's Name (display role) | `Slot 2 'colour 1'`; the object's `name` is `colour 1` |
| a slot's Color | `1.0000000000,1.0000000000,1.0000000000,1.0000000000` on every slot of every wheel |
| MediaFileName / Appearance | set on E and E2 (`GOBO/SHEHDS/SHEHDS@000900014.png`, `Gobos.GoboImage 5`), empty on C1 and G1 |
| ChannelFunction `Color1 1` | Attribute Color1, DMXFrom `000000`, DMXTo `7F7F7F`, Wheel → `Wheel 1 'C1'` (a handle) |
| its ChannelSets | `open` 000000–0A0A0A WheelSlotIndex 1, `colour 1` 0B0B0B–151515 slot 2, … (12) |
| `Color1WheelSpin 2` | the same wheel; its channel sets have no WheelSlotIndex |

The channel-set DMX values are 24-bit hex, as displayed. For an 8-bit channel `0B0B0B` is 11, so "colour 1" is
11–21. Every slot reads white, so the type carries no slot colours. The tool says so and has the agent ask.

Bridge 0.34.0 first nested the wheel channel functions inside each mode. Their channel sets came back as
`<table: max depth>`, cut by the serialiser's depth bound, so they now travel beside the modes, tagged with the mode.

## Live test

`test/live/fixture-type-data.live.ts` with bridge 0.34.0:
- the Festoon's `cellOrder` (`1-9, 19-29, 10-18, 30-40`; steps 0.61 m max in DMX order, 2.20 m in cell-number order);
- a group preview with `{cells_of: 401, order: "dmx"}` in that order;
- the beam's colour wheel `unset`, with "colour 1" at 11-21 and the prism's media.

The layout preview with `order: "dmx"` was skipped: the console's patch copy was open (a FixtureTypeImport dialog on
display 1, not opened by this test), and the tool refuses even a preview then. Unit tests cover the ordering.
`test/live/type-structure.live.ts` still passes.
