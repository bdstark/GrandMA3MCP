# SU-11 probe: decimal values on channels with several channel functions (macOS, onPC 2.5.1)

Evidence for [SU-11 in SETUP.md](../../SETUP.md#su-11--decimal-read-back-on-multi-function-channels-bug).

- **Date:** 2026-10-15
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, the throwaway show `NewShow_2026.10.15_23.16.24UTC`,
  bridge 0.30.0
- **Method:** `Attribute "<name>" At Absolute Decimal8|16|24 <value>` through the bridge's `cmd` op on one selected
  fixture, then the bridge's `programmer` op (scope `selection`). `ClearAll` before and after.

## The channels

From `fixtureAttributes` (DMX ranges are 24-bit hex):

| Fixture | Attribute | Channel functions | First function's DMX range |
| --- | --- | --- | --- |
| 301 (180 W beam) | `Color1` | `Color1 1`, `Color1WheelSpin 2` | 000000..7F7F7F (0..127) |
| 301 | `Shutter1` | `Shutter1 1`, `Shutter1Strobe 2` | 000000..000000 |
| 301 | `FixtureGlobalReset` | `NoFeature 1`, `FixtureGlobalReset 2` | F10000..FFFFFF for the attribute's own function |
| 101 (Mega Hex Par) | `Shutter1` | two functions | 000000..3F3F3F (0..63) |

## Programmer rows

| Command on 301 | `value` (percent) | `valueRaw` | Step `channel_function` | Row `channelFunction` |
| --- | --- | --- | --- | --- |
| `Color1` Decimal8 104 | 81.8898 | 6842472 = 0x686868 | 0 | `Color1 1` |
| `Color1` Decimal8 127 | 100 | 0x7F7F7F | 0 | `Color1 1` |
| `Color1` Decimal8 128 | 100.787 | 0x808080 | 0 | `Color1 1` |
| `Color1` Decimal8 200 | 157.480 | 0xC8C8C8 | 0 | `Color1 1` |
| `Color1` Decimal8 255 | 200.787 | 0xFFFFFF | 0 | `Color1 1` |
| `Color1` Decimal16 26700 | 81.8040 | 6835304 = 0x684C68 | 0 | `Color1 1` |
| `Color1` Decimal24 6842472 | 81.8898 | 6842472 | 0 | `Color1 1` |
| `Shutter1` Decimal8 100 | 0 | 0x646464 | 0 | `Shutter1 1` |
| `FixtureGlobalReset` Decimal8 245 | 33.0718 | 0xF5F5F5 | 1 | `FixtureGlobalReset 2` |
| `Dimmer` Decimal8 77 | 30.1961 | 0x4D4D4D | 0 | `Dimmer 1` |

Findings:

- `value` (the step's `absolute`) is a percent of the **attribute's** channel-function range, not of the whole DMX
  channel. Decimal8 104 on `Color1` reads 104/127 = 81.89 %. Values beyond that function run past 100 % (the
  `Color1WheelSpin` range belongs to a different attribute, so the step stays on function 0). A function with an
  empty range (`Shutter1 1`, 000000..000000) reads 0 % whatever the DMX value. This is the field-test mismatch:
  the tool expected 104/255 = 40.8 %.
- `valueRaw` (the step's `absolute_value`) is the 24-bit DMX value and is exact for all three widths. Decimal8 *v*
  is stored as *v* · 0x010101, and Decimal16 *v* as *v* · 256 + (*v* >> 8): the low byte repeats the high byte. So
  the value in the unit sent is the top 8, 16 or 24 bits of `valueRaw`.
- `valueRaw` has been in every programmer row since the op was added (FR-08), so the fix needs no bridge change.

## Side observation

`Attribute "Pan" At …` on fixture 301 produced an 8-step row. A running playback was outputting a position phaser
(`M16 Circle Sync`) on the beams, and the programmer value took over its first step only. `ClearAll` left the
programmer empty. The live test therefore skips Pan and Tilt when it picks a channel automatically.

## Result

Decimal expectations are compared as DMX values against `valueRaw`, exactly. A row without `valueRaw` makes the
comparison `unavailable`, never a percent-of-255 guess. Live test `test/live/decimal-readback.live.ts` 1/1 on
fixture 101 `Shutter1` (automatic pick) and on 301 `Color1` (`GMA3_LIVE_DECIMAL_TARGET=301:Color1`).
