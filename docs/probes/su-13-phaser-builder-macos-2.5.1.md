# SU-13 probe: whole-rig phasers, per-fixture values, phase steps, shuffle and step widths (macOS, onPC 2.5.1)

Evidence for [SU-13 in SETUP.md](../../SETUP.md#su-13--phaser-builder-whole-rig-variants-shapes-and-phase-spread).

- **Date:** 2026-10-15
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, the throwaway show `NewShow_2026.10.15_23.16.24UTC`,
  bridge 0.30.1
- **Method:** commands through the bridge's `cmd` op in the Preview environment, read with the `programmer` op; then
  `test/live/phaser-builder.live.ts`.

## Per-fixture step values

Eight Festoon cells (401.1–401.8) with two steps (Dimmer 100 / 0). Then `ClearSelection`, cells 5–8 selected, and in
step 1 and step 2 `Attribute "Dimmer" At Absolute 0` and `100`:

| Cells | Step values read |
| --- | --- |
| 401.1–401.4 | 100 / 0 |
| 401.5–401.8 | 0 / 100 |

A step value written on part of the selection changes only those fixtures. The mirror inversion and the fan's per-fixture
pan use this. The whole selection (with its grid positions) is restored before the step timing and phaser layers, which
apply to the selection.

## A phase step per fixture

`At Phase 0 Thru 1260` on the eight cells (180° between neighbours) read:

| Grid position | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| phase | 0 | 180 | 360 | 540 | 720 | −540 | −360 | −180 |

The console keeps the phase within ±720 (with float noise: −539.99997854233). Phases are therefore compared modulo
360, and the phase summary detects an even run modulo 360.

## Shuffle

`Set Selection MAtricks "XShuffle" 3`, `At Phase 0 Thru 315`, `Reset Selection MAtricks`: the phases were 225, 45,
135, 0, 315, 90, 270, 180 by grid position. That is the set 0..315 in steps of 45, permuted. `gridposmatr` held the
shuffled position, and the raw `gridpos` was unchanged. The check compares the set of phases.

## Wings of one fixture

The mirror variant of a circle on two movers (wings 2, `At Phase 0 Thru 180`) read 180 on both movers: a wing of one
fixture gets the centre end (`to`), not `from`. The expected phase was corrected for one-fixture wings.

## Step widths

| `At Width` sent (step 2) | Read |
| --- | --- |
| 3600, 3900, 3201 | 3200 |
| 3200 | 3200 |
| 355.556 | 355.6 |
| 82.051 | 82.1 |
| 0 | 0.0000059604644775391 |

Above 3200 % the console clamps the width silently, and it keeps widths to 0.1 %. The first comet build (40 cells,
tail 4: widths 400 / 3600) failed its check with "width 3600 expected, 3200 read". Steps now refuse widths over 3200.
The pattern templates scale long rows to fit (the comet: 355.6 / 3200) and round to 0.1.

## Measure

The MA help ("Measure Keyword") defines measure as the number of beats one phaser cycle lasts at the phaser speed. A
step's width is a percentage of a beat, so the widths should add up to measure × 100. The tool's descriptions say so.

## Live test (`test/live/phaser-builder.live.ts`, 1/1, 48 s)

| Case | Result |
| --- | --- |
| circle (size 15, centre 0/20) as variants sync, follow, mirror on 301–302 | 23.951–23.953 named "MCP circle sync/follow/mirror"; phases: none, 0/180, 180/180; mirror's Pan inverted on 302; all matched |
| fan (60°) on 301–302 | matched |
| on 401.1–401.40 in one call: a runner with `phase: {step: 180}`, a comet (tail 4), a sparkle (every 5, seed 3) | all matched; runner {first_phase 0, step 180}, comet step 9, sparkle a shuffled list |
| a dimmer chase on 140 fixtures and cells of three types (Hex Pars, Festoon cells, washer cells) | matched; phases {first_phase 0, step 2.5712}; result 3.5 KB compact (80 KB before the compact default) |
