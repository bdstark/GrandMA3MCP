# SB-04 probe: phaser steps, layers, distribution and the Preview environment (macOS, onPC 2.5.1)

Evidence for [SB-04 in SHOWS.md](../../SHOWS.md#sb-04--author-phasers-and-effect-distributions) and
[the phaser tools](../tools/phasers.md).

- **Date:** 2026-10-13
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, show `mcp-test-disposable`, bridge 0.22.0 (Lua on) for
  the manual pass, 0.23.0 for the tools
- **Method:** a manual pass through `gma3_lua` (`Cmd`, `GetProgPhaser`, `GetPresetData`, `CurrentEnvironment()`), then
  the tools through `test/live/phasers.live.ts` (1/1, 12.4 s).
- **Objects:** Presets 23.901–23.905 and 23.911–23.917, Group 907, all checked absent first and deleted afterwards.
  Fixtures 401–404 (Mega Hex Par), 601–602 (beam mover, Pan −225..225°), 701–704 (Thrill Mini Profile, Pan range
  reversed).

## Steps and layers

On 401–404, `Attribute "Dimmer" At 100`, `Step 2`, `Attribute "Dimmer" At 0`:

| Command | GetProgPhaser |
| --- | --- |
| `Step 2` then `At ...` | the value goes into step 2 (2 steps) |
| `Step 2`, `At Transition 50`, `At Width 50`, `At Acceleration -100`, `At Deceleration -100` | step 2: `trans` 50, `width` 50, `accel` / `decel` −99.99999 with `accel_type` / `decel_type` 2 |
| `Step 1`, `At Transition 25` (programmer already has two steps) | step 1 `trans` 25 |
| **`At Transition 0` while the programmer has only one step** | **ignored** (step 1 kept `trans` 100): the tools create every step first and set step timing afterwards |
| default layers | absent from the step tables (width 100, transition 100, accel / decel 0) |
| `At Speed 120` | `speed` 2.0 (**Hz**; 120 BPM) on every active attribute, activation-group siblings included |
| `At Phase 0 Thru 270` | `phase` 0 / 90 / 180 / 270 by grid position (`gridpos` 0..3) |
| `At Phase 270 Thru 0` | 270 / 180 / 90 / 0: the direction |
| `At Measure 4` | `measure` 400.0 (×100) |
| `Attribute "Dimmer" At SpeedMaster 1` | `speed_master` 0 (0-based) |
| `Attribute "Dimmer" At Speed 30` | only Dimmer changes (0.5 Hz); an `Attribute` prefix scopes a layer to one attribute |
| `Attribute "ColorRGB_R" At Phase 0 Thru 90` | only R gets a phase; G, B (same activation group) keep none: unscoped layer commands are used |
| `Attribute "ColorRGB_R" At Relative 10` in step 1, `At Preset 4.4` in step 2 | step 1 `relative` 10; step 2 `integrated` = Preset 4.4 "Red" (per step, not `abs_preset`) |
| `At Relative Physical 20` / `At Absolute Physical -45` (Pan, −225..225) | relative 4.44 % (20 / 450), absolute 40 % |
| Thrill Mini Profile (reversed Pan range), `At Relative Physical 30` | +5.56 %: relative values are a share of the range's size |
| `Attribute "Pan" At 50` on a Hex Par (no Pan) | **"OK", nothing set**; `Gobo1` the same |
| `Set Selection MAtricks "XGroup" 2`, `At Phase 0 Thru 180` | 0 / 180 / 0 / 180 (alternating); the phase stays after `Reset Selection MAtricks` |
| two-step RGB phaser at the default 60 BPM, stored | the preset leaves `speed` out (default); at 120 BPM it is stored |

## Blind and Preview

| Case | Result |
| --- | --- |
| profile environments | `Normal`, `Preview` |
| `Blind On` | same environment and programmer (address unchanged); values typed meanwhile land in the Normal programmer; no readable Blind flag found (Programmer, environment, profile, user, selection) |
| **`Preview On`** | `CurrentEnvironment()` "Preview", **its own programmer** (14.19.1.1.2.3, empty) and selection (0); the Normal programmer (14.19.1.1.1.3) keeps its 2-step phaser |
| build a 2-step dimmer phaser there, `Store Preset 23.901 /Programmer /Active /Selective ...` | stored with both steps, phase per fixture (402: 90) and speed (0.5 Hz) |
| `ClearAll` in Preview, `Preview Off` | only the Preview programmer is cleared; back in Normal, its phaser untouched (2 steps, phase 270) |

The environment of the programmer is reported by the bridge's `programmer` op (0.23.0, `environment`).

## Stored phasers

| Store (from Preview) | GetPresetData |
| --- | --- |
| relative circle on 601/602: Pan +20, 0, −20, 0 and Tilt 0, +20, 0, −20, step 1 accel −100 | 4 steps with `relative` and `accel` / `accel_type` on step 1 |
| alternating red/blue with XGroup 2 | phase 0 / 180 / 0 / 180 |
| steps `At Preset 4.4` / `At Preset 4.6`, `/Embed "Yes"` | steps `integrated` Red / Yellow, two dependencies |

## The tools on the console

- **First live run:** `check_build` reported that step 1's transition 0 had not been applied. That is how the one-step
  rule above was found; the tools now set step timing after all steps exist.
- **Next runs:**
  - The stored alternating-colour preset omitted the default 60 BPM, which the read-back now treats as the default.
  - The Thrill's reversed Pan range showed that relative values follow the range's size.
  - `gma3_preset` did not print the phaser layers; it now shows speedBpm, phase, measure and speedMaster.
  - A group's member addresses did not resolve through `FromAddr`; members are now resolved by fixture id.
- **`test/live/phasers.live.ts` then passed 1/1:**
  - dimmer chase phase 0 / 90 / 180 / 270 at 120 BPM with transition 0;
  - alternating colours 0 / 180 / 0 / 180;
  - a 6-mover relative circle (4 steps, accel −100);
  - a custom sine with width 50, reverse phase 270 → 0, measure 2 and speed master 3;
  - steps from presets as valid dependencies;
  - Group 907 with wings 2 (0 / 90 / 90 / 0);
  - both refusals with nothing sent;
  - the unrelated Normal value (702 Dimmer 30) unchanged after every build;
  - a 1.5 s audition released;
  - `gma3_phaser_release` with nothing left to do.
