# Live console tests

These tests talk to a real grandMA3 onPC through the running bridge plugin and **modify show
data**. They are never part of `npm test`. Run them on purpose, against a disposable show:

```bash
GMA3_LIVE=1 npm run test:live
```

Guard rails, enforced by `test/live/live.ts`:

* `GMA3_LIVE=1` must be set, otherwise every live test is skipped.
* The loaded show file name must match `GMA3_LIVE_SHOW` (a regular expression, default
  `disposable|mcp[-_ ]?test|scratch`). Load a throwaway show (for example `New Show "mcp-test"`)
  before running; the tests refuse to touch a show whose name does not match.
* Tests only create, change and delete objects in the reserved ranges listed below, and delete
  what they created when they finish. Nothing calls `SaveShow`.

## Show objects the live tests use

| Range | Used by |
| --- | --- |
| Sequence 900–909 and their cues | cue storage, editing, navigation and deletion tests (905: SB-01 playback configuration) |
| Group 900–902 | fixture selection tests |
| Sequence 906, Groups 910–911, Presets 23.931 and 4.931 | SB-05 recipe tests (fixtures 401–404, presets 4.4 and 1.11 by default: `GMA3_LIVE_RECIPE_FIXTURES`, `_COLOR`, `_DIMMER`) |
| Presets 23.911–23.917, Group 907 | SB-04 phaser tests (fixtures 401–404, 601, 602, 701–704 and presets 4.4/4.6 by default: `GMA3_LIVE_PHASER_PARS`, `_MOVERS`, `_OTHER`, `_COLORS`) |
| Presets 2.901, 4.901–4.904, 23.901–23.903 | SB-03 preset tests (fixtures 401–404, 501.1/501.2, 601, 602, 701–704 by default: `GMA3_LIVE_PRESET_PARS`, `_CELLS`, `_MOVERS`) |
| Group 905–906, MAtricks 905–906 | SB-02 group and MAtricks tests (fixtures 401–404, 701–704 and 501 with its cells by default: `GMA3_LIVE_GRID_ROW`, `GMA3_LIVE_GRID_CELLS`) |
| Page 90, executors 90.201–90.215 | executor assignment and labelling tests (90.210–90.211: SB-01 playback configuration; 90.212: SB-06 speed master) |
| Sequences 907–909, speed master 14 (state restored) | SB-06 speed tests (fixtures 401–403 by default: `GMA3_LIVE_SPEED_FIXTURES`; `GMA3_LIVE_SPEED_MASTER`) |
| Fixtures 1–10 (must be patched in the disposable show) | programmer, attribute and output tests |
| Macro 900 | reserved |
| Macros 901–903 (and Sequence 907) | SB-07 macro tests |
| Timecode 901, Sequences 908–909 | SB-08 timecode tests (bridge 0.25.0) |
| Fixtures with FID 990–993, DMX from the first free block at 3.001 (also needs `GMA3_LIVE_EXCLUSIVE=1`) | patch tests (committed with no undo) |
| Two fixtures with Dimmer and ColorRGB from `GMA3_LIVE_LOOK_FIDS` (default 1, 2); colour preset slot `GMA3_LIVE_LOOK_PRESET` (default 4.901, must be empty; stored and deleted); optionally a compound fixture with colour cells from `GMA3_LIVE_LOOK_COMPOUND` (skipped when unset); the programmer cleared | SU-05 programmer tests (bridge 0.27.0) |
| Two fixtures with Dimmer and ColorRGB from `GMA3_LIVE_CUELIST_FIDS` (default 1, 2); Presets 4.941–4.943 and Sequences 910–912 (must be empty; built and deleted); one Normal programmer value that must survive, then ClearAll; the chases play for a few seconds | SU-06 cue-list tests |
| A patched fixture from `GMA3_LIVE_DMX_FID` (default 1), read; with `GMA3_LIVE_EXCLUSIVE=1` and Art-Net and sACN output both off: sACN data entry 1 edited, one entry added, universe 1024's grant request set, all restored | SU-09 DMX output test (bridge 0.30.0; nothing reaches the network) |
| Two fixtures with cells sharing a layout from `GMA3_LIVE_CELL_FIDS` (default 1, 2; every fixture sharing it moves and is restored); fixture type "MCP live layout" (must not exist; created and removed; also needs `GMA3_LIVE_EXCLUSIVE=1`) | SU-08 cell-layout test (bridge 0.29.0; patch sessions committed with no undo) |
| Every fixture type and patched fixture, read only; at least one fixture with cells (`GMA3_LIVE_REQUIRE_CELLS=0` skips that) | SU-07 type-structure test (bridge 0.28.0) |
| Two top-level fixtures from `GMA3_LIVE_POSITION_FIDS` (default 1, 2): position, rotation and mesh mirroring changed and restored | SU-04 position tests |
| One fixture with a multi-function channel from `GMA3_LIVE_DECIMAL_TARGET` (`"<fid>:<attribute>"`; default the first patched fixture with one, Pan and Tilt skipped); the programmer cleared | SU-11 decimal read-back test |
| Fixture types Generic Fog and Fan (imported, then removed; their attributes stay), fixture FID 994 from the first free block at 3.001 (also needs `GMA3_LIVE_EXCLUSIVE=1`) | SU-03 fixture-type import tests (bridge 0.26.0; committed with no undo) |

Each live test file documents the exact objects it creates at the top of the file.
