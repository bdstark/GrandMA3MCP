# SU-05 probe: several attributes, preset recall, release and intensity (macOS, onPC 2.5.1)

Evidence for [SU-05 in SETUP.md](../../SETUP.md#su-05--programmer-several-attributes-and-preset-recall).

- **Date:** 2026-10-15
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, the throwaway show `NewShow_2026.10.15_04.21.01UTC`,
  bridge 0.26.0
- **Method:** commands through the bridge's `cmd` op and the programmer through its `programmer` op, from a Node
  script; channel-level reads of `GetProgPhaser` through `gma3_lua`. Fixtures 101–103 (Mega Hex Par, no cells) and 201
  (wall washer, 12 cells). Preset 4.901 was checked empty, stored for the probe and deleted afterwards; the probe
  ended with `ClearAll`.

## Intensity

`At 75` with fixtures 101–103 selected put `Dimmer` at 75 on each: `At` without an attribute is intensity, in
percent.

## Several attributes

One `Attribute "<name>" At Absolute Percent <v>` command per attribute. Setting only `ColorRGB_R` also activates the
rest of the colour group (G and B at 100, W, RY and UV at 0), as KB-17 recorded: the read-back has more rows than
attributes sent.

## Preset recall

| Command (fixtures selected) | Result |
| --- | --- |
| `At Preset 4.901` (stored from 101: R 100, G 0, B 20), 101 + 102 selected | both fixtures get R 100, G 0, B 20 and the rest of the colour group at 0 |
| `At Preset 4."MCP probe red"` (by name), 103 selected | the same values on 103 |
| `At Preset 4.901`, wall washer 201 selected (another fixture type) | all 12 cells get the colour values: 48 rows |
| `At Preset 4.901`, **nothing selected** | `OK`, and nothing in the programmer |
| `At Preset 4.999` (**no such preset**), 101 selected | `OK`, and nothing in the programmer |

`Preset 4.901` without `At` and without a selection was not a recall here (the fixture used did not exist).

**The link to the preset.** The programmer op's per-step `integrated` field stays empty for a recalled preset.
`GetProgPhaser(ui, false)` has the link at the channel level: `abs_preset` is the preset's handle
(`ShowData.DataPools.Default.PresetPools.Color.MCP probe red` for ColorRGB_R and ColorRGB_W of 101), `rel_preset` is
nil. A channel without a programmer value returns nil (Dimmer here).

**The link survives a manual overwrite.** After `Attribute "ColorRGB_R" At Absolute Percent 50` on 101 and 102,
ColorRGB_R read 50 with `abs_preset` still naming the preset. The link shows the preset was applied to the channel,
not that the value still equals it.

## Release

| Command | Result |
| --- | --- |
| `Off Attribute "ColorRGB_R"`, 101 selected (101 and 102 hold values) | ColorRGB_R removed from 101 only |
| `Off Attribute "ColorRGB_G"`, **nothing selected** | ColorRGB_G removed from **every** fixture in the programmer |
| `Off Attribute "ColorRGB_R" + "ColorRGB_G"`, 101 selected | both removed from 101 only |
| `Off Fixture 102` | every value of 102 removed |
| `Off Selection`, 102 selected | every value of 102 removed, and the selection is empty afterwards |

`Off Attribute` is scoped to the selection, so a tool must establish a non-empty selection before sending it.

## Consequences for the tools

- Every command answers `OK` whether or not it changed anything: only the programmer read-back tells.
- The preset must be checked to exist, and the selection to be non-empty, before `At Preset`.
- The programmer op needs the channel-level `abs_preset` / `rel_preset` to verify a recall (a read-only addition).
