# Phasers and effect distributions (SB-04)

`gma3_build_phaser` builds a repeatable effect from structured steps (or a template), checks it, stores it as a preset
and reads every step back. `gma3_phaser_release` is the stop/release path. They need bridge **0.23.0**, which reports
the programmer's environment and the phaser layers of steps and presets (extensions of the existing `programmer` and
`preset.read` ops, see [the bridge protocol](../reference.md#phaser-layers-plugin-v0230-sb-04)). Storing reuses the
[`gma3_store_preset`](presets.md) rules. Evidence: [the SB-04 probe record](../probes/sb-04-phasers-macos-2.5.1.md).

| Tool | Changes | Programmer / output |
| --- | --- | --- |
| `gma3_build_phaser` | stores one preset | builds in the console's **Preview** environment (own programmer and selection; nothing is output); the Normal programmer is fingerprinted before and after and never touched; with `audition_ms` only, plays the stored preset in the (then required empty) Normal programmer and releases it; requires `exclusive: true` |
| `gma3_phaser_release` | nothing in the show | leaves Preview (clearing its programmer); with `clear_normal`, clears the Normal programmer |

## Three things kept apart

| | Parameters | What it is |
| --- | --- | --- |
| **Step timing** | per step `width`, `transition`, `accel`, `decel` | how one step moves to the next: the width of a step (percent of a beat), the share of it spent moving (0 snaps), the curve (accel/decel −100 is a sine) |
| **Fixture distribution** | `phaser.phase {from, to}`, `phaser.repeat {groups|wings|blocks: n}` | the phase offset of each fixture, spread from → to over the selection grid in X; from > to runs the other way; repeat restarts the spread every n fixtures (groups), mirrors it (wings) or holds n together (blocks) |
| **Playback speed** | `phaser.speed_bpm`, `phaser.measure`, `phaser.speed_master` | how fast the cycle runs: BPM (default 60), the number of beats per cycle, and the speed master (1–16) that scales it |

The plan the tool returns (`plan.steps[].stepTiming`, `plan.distribution`, `plan.playbackSpeed`) has the same split.

## `gma3_build_phaser`

| Parameter | Values |
| --- | --- |
| `preset` | `"<pool>.<number>"`; an All pool (21–25) takes any attributes, a feature-group pool filters (see presets) |
| `fixtures` *or* `group` | fixture ids/ranges, selected in list order on grid X (`Grid k/0/0`), or a stored group (recalled at the origin with its grid) |
| `steps` *or* `template` | 2–16 steps, or one of the templates below |
| step | `values: {Attribute: number | {absolute, relative}}`, `preset: "4.4"` (called into the step, stored as a reference), `width`, `transition`, `accel`, `decel` |
| `unit` | `percent` (default) or `physical` (degrees for Pan/Tilt, as `At Absolute|Relative Physical`) |
| `phaser` | `speed_bpm`, `phase {from, to}`, `measure`, `speed_master`, `repeat` (needs `phase`) |
| `mode` | `selective` (default) or `global`; universal cannot hold a per-fixture phase |
| `existing`, `name` | as for `gma3_store_preset` |
| `audition_ms` | 0 (default: no playback) up to 30000 |
| `exclusive`, `preview`, `verify` | `exclusive` required unless preview; `verify` default true |

### Templates

| `template` | Expands to |
| --- | --- |
| `{type: "dimmer_chase", on?: 100, off?: 0, speed_bpm?: 120, spread?: true}` | two Dimmer steps on/off with transition 0 (snap); phase 0 → 360·(n−1)/n across the fixtures (a running chase), `spread: false` for all together |
| `{type: "alternating_colors", colors: [c1, c2], speed_bpm?: 60, snap?: false}` | two colour steps, each `{red, green, blue}` (percent) or `{preset: "4.n"}`; phase 0 → 180 with `repeat: {groups: 2}`, so neighbours alternate; `snap: true` sets transition 0 |
| `{type: "pan_tilt", pan?: 20, tilt?: 20, speed_bpm?: 20, spread?: false}` | a circle around the current position: four relative steps (Pan +p, 0, −p, 0; Tilt 0, +t, 0, −t, degrees) with accel/decel −100; `spread: true` spreads the phase |

`preview: true` returns the expanded steps and the exact console commands.

### Requests, in order

1. Read checks:
   - `read_context`: the pool exists, StoreLook is off, and the existing-preset policy holds;
   - `resolve_fixtures`: every fixture exists and **has every attribute of the effect**. The console answers OK and
     ignores an attribute a fixture lacks, so a missing one is refused with the fixture named;
   - `check_step_presets`: the step presets exist;
   - `read_normal_programmer`: the console is in the Normal environment, and the Normal programmer is fingerprinted.
     With `audition_ms` it must be empty.
2. `preview_on` (`Preview On`) and `check_preview`: the Preview environment is active and its programmer empty.
3. `select`: `ClearSelection` and `Grid k/0/0` + `Fixture <id>` per fixture, or `Grid 0/0/0` + `Group n`.
4. `build`: the effect's commands, in this order:
   - every step's values (`Step i`, `At Preset`, `Attribute "A" At Absolute|Relative [Physical] v`);
   - then each step's timing (`Step i`, `At Width|Transition|Acceleration|Deceleration`). Step layers set while the
     programmer has one step are ignored, so they come after;
   - then the phaser layers (`At Speed`, `At Phase a Thru b`, `At Measure`, `At SpeedMaster`), wrapped in
     `Set Selection MAtricks` / `Reset Selection MAtricks` for a repeat;
   - finally `Step 1`.
5. `check_build`: the Preview programmer is read and checked before anything is stored.
   - Every fixture has every requested attribute, with the right number of steps.
   - Each step has its value (percent; physical values converted through the attribute's range, relative values
     through its size) and its timing.
   - Each step preset is referenced by every fixture in its step, and no other preset is referenced there.
   - Speed, measure and speed master match, and every fixture has the expected phase for its grid position and the
     repetition.
   - Only activation-group siblings and attributes of step presets may be there in addition, and they are reported.
6. `store`: the `gma3_store_preset` body, run inside this tool's lock, from the Preview programmer. It uses the mode
   and existing policy, layers absolute, relative and phaser, `/Embed "Yes"` when steps reference presets, and
   KeepActivation No. Its verification reads every stored step back: values, relative, width, transition, accel,
   decel, integrated preset, speed, phase, measure and speed master. Layers the preset leaves out are the console
   defaults (60 BPM, phase 0, width/transition 100, accel/decel 0).
7. `release_preview_programmer` (`ClearAll` in Preview) and `preview_off`, **always** once Preview was entered.
8. `check_normal_programmer`: back in Normal, the fingerprint must be unchanged.
9. With `audition_ms`, after a verified store:
   - `ClearSelection`, the selection again, `At Preset <target>`;
   - wait;
   - `audition_release` (`ClearAll`, always);
   - `check_audition_released`: the Normal programmer must be empty.

`verification` is the stored preset's verification, turned to `mismatched` when the Normal programmer changed.

## `gma3_phaser_release`

Reads the environment. In Preview (a build that was interrupted, for instance by a lost connection), it sends `ClearAll`
and `Preview Off`. With `clear_normal: true` (and `exclusive: true`), it also sends `ClearAll` in Normal, which stops an
effect that is playing there. It is idempotent: from Normal without `clear_normal` it sends nothing.

## What is and is not verified

- Verified live (onPC 2.5.1, `test/live/phasers.live.ts`, 1/1, 12.4 s):
  - the three templates;
  - a custom phaser with every layer;
  - steps from presets as valid dependencies;
  - a distribution over a stored group with wings;
  - refusals before anything was sent;
  - an unrelated Normal-programmer value unchanged after every build;
  - an audition released;
  - the release tool.
- Not covered:
  - per-attribute layer overrides (every layer command applies to every attribute of the effect, which keeps an
    activation group in phase);
  - phase over a two-dimensional grid (the check assumes the spread along grid X);
  - MAgic presets and recipes (SB-05);
  - universal phasers (refused).
- The phase check reads each fixture's grid position from the programmer and assumes the console spreads the phase
  over grid X positions, gaps included. A group with gaps or rows may be reported as a mismatch rather than accepted
  silently.

## Live test

`GMA3_LIVE=1 node --import tsx --test test/live/phasers.live.ts` on a disposable show in the Normal environment with an
empty programmer, StoreLook off and bridge 0.23.0. It uses Presets 23.911–23.916 (23.917 must not exist), Group 907, the
Hex Pars 401–404, the movers 601, 602, 701–704, 702's Dimmer as the unrelated value, and the colour presets 4.4 and 4.6
(`GMA3_LIVE_PHASER_PARS`, `_MOVERS`, `_OTHER`, `_COLORS`). Everything it creates is deleted at the end.
