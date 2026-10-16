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
| **Playback speed** | `phaser.speed_bpm`, `phaser.measure`, `phaser.speed_master` | how fast the cycle runs: BPM (default 60), `measure` (the number of beats one cycle lasts at that speed; a step's width is a percent of a beat, so the widths should add up to measure × 100, MA help "Measure Keyword"), and the speed master (1–16) that scales it |

The plan the tool returns (`plan.steps[].stepTiming`, `plan.distribution`, `plan.playbackSpeed`) has the same split.

## `gma3_build_phaser`

| Parameter | Values |
| --- | --- |
| `preset` | `"<pool>.<number>"`; an All pool (21–25) takes any attributes, a feature-group pool filters (see presets) |
| `fixtures` *or* `group` | fixture ids/ranges, selected in list order on grid X (`Grid k/0/0`), or a stored group (recalled at the origin with its grid) |
| `steps` *or* `template` | 2–16 steps, or one of the templates below |
| step | `values: {Attribute: number | {absolute, relative}}`, `preset: "4.4"` (called into the step, stored as a reference), `width`, `transition`, `accel`, `decel` |
| `unit` | `percent` (default) or `physical` (degrees for Pan/Tilt, as `At Absolute|Relative Physical`) |
| `phaser` | `speed_bpm`, `phase` (`{from, to}`, `{from?, step}` or `"spread"`), `measure`, `speed_master`, `repeat` and `shuffle` (both need `phase`) |
| `mirror` | `{attributes, wings?: 2}`: invert these attributes on every second wing (SU-13) |
| `variants` | `["sync", "follow", "mirror"]`: build these versions into consecutive presets (SU-13) |
| `effects` | several effects in one call instead of the fields above (SU-13) |
| `detail` | with several presets: every preset's plan, steps and store result |
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

Position shapes (SU-13), absolute physical degrees around `center: {pan, tilt}` (default 0/0), default 20 BPM; they also
take a `group`:

| `template` | Expands to |
| --- | --- |
| `{type: "circle", size?: 20, center?}` | four points (Pan c+r, c, c−r, c; Tilt c, c+r, c, c−r) with accel/decel −100 |
| `{type: "figure8", size?: 20, center?}` | eight points: Pan c + r·sin θ, Tilt c + r/2·sin 2θ |
| `{type: "cone", tilt?, center?}` | tilt held at `tilt`, pan sweeping −180 → 0 → +180 → 0 around the centre (a full turn and back) |
| `{type: "fan", size?: 20, center?}` | step 1 every fixture on the centre, step 2 Pan spread from c − size/2 (first fixture) to c + size/2 (last) |
| `{type: "bounce", size?: 20, center?}` | Tilt c + size, c − size with accel/decel −100 |

Dimmer patterns for a row of fixtures or cells in grid order (SU-13), default 120 BPM, `on?: 100`. Widths are percent of
a beat, so a runner on n cells lasts n beats:

| `template` | Expands to |
| --- | --- |
| `{type: "runner"}` | on (width 100) / off (width 100·(n−1)), snap, phase 0 → 360·(n−1)/n: one on at a time |
| `{type: "comet", tail?: 3}` | on fading out over `tail` cells (width 100·tail, transition 100), off for the rest |
| `{type: "alternate"}` | on/off, phase 0/180 with `repeat: {groups: 2}` |
| `{type: "thirds"}` | on (100) / off (200), phase 0/120/240 with `repeat: {groups: 3}` |
| `{type: "fill"}` | off/on half and half, phase 0 → 180·(n−1)/n: the row fills, then empties in the same direction |
| `{type: "sparkle", every?: 4, seed?: 1}` | on (100) / off (100·(every−1)) spread and shuffled with `seed` |

A scanner (one dot running back and forth) needs a different on-time per cell, which one phaser cannot hold; it is not
a template.

`preview: true` returns the expanded steps and the exact console commands.

### Whole rig, variants, mirror and several effects (SU-13)

- **No tool cap below the console's.** Up to 1024 fixtures or cells per effect, of several fixture types, as long as
  each has the effect's attributes (checked before anything is sent). `gma3_store_preset`'s scope cap rose to match.
- **Phase forms.** `{from, to}` as before; `{from, step}` gives a phase step per fixture (`step: 180` on 72 cells sends
  `At Phase 0 Thru 12780`); `"spread"` is 0 → 360·(n−1)/n. Phases are compared modulo 360. `shuffle: <seed>` sets the
  selection MAtricks XShuffle while the phase is set: the phases are permuted. The check requires every attribute of a
  fixture to share its phase, and the fixtures' phases over the whole selection to be the unshuffled set. A channel
  that only part of a mixed rig has (RGBW's W) is checked against its own fixture's phase.
- **Mirror.** `mirror: {attributes, wings}` cuts the fixtures (grid order) into `wings` parts and inverts the attributes
  on every second part: relative and physical values change sign (Pan −20° for +20°), percent becomes 100 − v. The
  per-fixture values are written once every step exists, on those fixtures, and the whole selection is restored before
  the step timing and phaser layers. The check expects each fixture's own value.
- **Variants.** `variants: ["sync", "follow", "mirror"]` builds the versions of one effect into consecutive presets
  from `preset`, named `"<name> sync"` and so on (name default: the template type, or `Effect`):
  - sync: no phase spread;
  - follow: the request's phase, or `"spread"`;
  - mirror: the spread mirrored about the centre (`repeat: {wings: 2}`), with `mirror.attributes` (default Pan, for a
    position effect) inverted on the second half.
- **Several effects.** `effects: [{preset, fixtures | group, steps | template, phaser, mirror, variants, name, ...}]`,
  at most 64 presets per call. `unit`, `mode`, `existing` and `verify` given for the call are defaults. Every effect is
  inspected first (nothing is sent when one is refused). Then all are built in one Preview session, with a confirmed
  Preview and `ClearAll` between them. An effect whose build check or store fails does not stop the others; a step
  without a reply (also inside the store, such as its name write) does. The result has one line per preset (`items`)
  with its phase summary, the steps that did not succeed and `uncertain: true` after a step without a reply;
  `detail: true` adds each preset's plan, steps and store result. The call is `partial` when any preset was stored,
  even with a later step that failed. `audition_ms` is for a single effect only.
- **Phase summary.** Each built preset reports the phase of every fixture in grid order from the build check's own
  programmer scan: `{fixtures, first, last, first_phase, step}` for an even run, otherwise the list of phases. No
  client-side programmer read is needed.

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
   - Every fixture has a value, and every requested attribute, with the right number of steps.
   - Step timing and the phaser layers are checked on **every** attribute of the effect: the explicit ones, those a
     step preset brought, and activation-group siblings.
   - Each step has its value (percent; physical values converted through the attribute's range, relative values
     through its size) and its timing.
   - Each step preset is referenced by every fixture in its step, and no other preset is referenced there.
   - Speed, measure and speed master match, and every fixture has the expected phase for its grid position and the
     repetition.
   - Only activation-group siblings and attributes of step presets may be there in addition, and they are reported
     (their values come from the preset or the group; their timing and layers are checked as above).
6. `store`: the `gma3_store_preset` body, run inside this tool's lock, from the Preview programmer. It uses the mode
   and existing policy, layers absolute, relative and phaser, `/Embed "Yes"` when steps reference presets, and
   KeepActivation No. Its verification reads every stored step back: values, relative, width, transition, accel,
   decel, integrated preset, speed, phase, measure and speed master. Layers the preset leaves out are the console
   defaults (60 BPM, phase 0, width/transition 100, accel/decel 0).
7. `confirm_preview`, then `release_preview_programmer` (`ClearAll`) and `preview_off`, **always** once `Preview On` was
   sent. The environment is read first and `ClearAll` is sent only when the console confirms Preview: in Normal it
   would discard the operator's programmer. When the environment cannot be read, nothing is cleared and the result says
   to run `gma3_phaser_release`.
8. `check_normal_programmer`: back in Normal, the fingerprint must be unchanged. It covers every row's values, steps
   (value, relative, timing, integrated preset), speed, phase, measure, speed master, fade, delay and absolute/relative
   preset references.
9. With `audition_ms`, only after a store whose read-back **matched** (so `audition_ms` needs `verify`) and an untouched
   Normal programmer:
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
- SU-13, verified live: see the SU-13 probe record and `test/live/phaser-builder.live.ts`.
- Not covered:
  - per-attribute layer overrides (every layer command applies to every attribute of the effect, which keeps an
    activation group in phase);
  - phase over a two-dimensional grid (the check assumes the spread along grid X);
  - MAgic presets and recipes (SB-05);
  - universal phasers (refused).
- The phase check reads each fixture's grid position from the programmer and assumes the console spreads the phase
  over grid X positions, gaps included. On a group with several rows the console packs the position as
  y * 2^18 + x; the check unpacks X, so rows that share an X range share the expected phase. A group with gaps may be
  reported as a mismatch rather than accepted silently.

## Live test

`GMA3_LIVE=1 node --import tsx --test test/live/phasers.live.ts` on a disposable show in the Normal environment with an
empty programmer, StoreLook off and bridge 0.23.0. It uses Presets 23.911–23.916 (23.917 must not exist), Group 907, the
Hex Pars 401–404, the movers 601, 602, 701–704, 702's Dimmer as the unrelated value, and the colour presets 4.4 and 4.6
(`GMA3_LIVE_PHASER_PARS`, `_MOVERS`, `_OTHER`, `_COLORS`). Everything it creates is deleted at the end.
