# Shared speed and synchronisation (SB-06)

Four tools give related chases and effects one tempo:
- `gma3_speed_masters` reads the 16 speed masters, what follows each one, and the sound input;
- `gma3_configure_speed_master` sets a master's tempo, scale and learn mode;
- `gma3_speed_master_action` taps (Learn), doubles, halves or resets a master;
- `gma3_observe_tempo` measures how fast running sequences advance and compares that with their configuration.

Sequences are linked to a master with `gma3_configure_sequence` (`rate_master`, `speed_master`, `rate_scale`,
`speed_scale`, `speed_from_rate`; see [playback.md](playback.md)).

No new bridge op: the tools use `children`, `objects`, `object`, `getfader`, `set` and `cmd`. Evidence:
[the SB-06 probe record](../probes/sb-06-speed-macos-2.5.1.md).

| Tool | Changes | Programmer |
| --- | --- | --- |
| `gma3_speed_masters` | nothing (read-only) | untouched |
| `gma3_configure_speed_master` | one master's SpeedScale, LearnMode and tempo, and so everything that follows it | untouched |
| `gma3_speed_master_action` | one master's tempo or scale | untouched |
| `gma3_observe_tempo` | nothing (read-only; it starts nothing) | untouched |

## The things to know first

- **Three different things are called speed, rate or timing:**

  | | What it is | What follows it |
  | --- | --- | --- |
  | Speed master (`Master 3.N`, 16 of them) | a tempo, 0–225 BPM times its scale | a sequence's **speed** link: the phasers in its cues; a sequence's **rate** link: its cue timing |
  | Rate (a sequence's own rate fader, or its rate master) | a multiplier of the sequence's fade, delay and trigger times | that sequence (and, with Speed from Rate, its stored speeds) |
  | Timing master (`Master 5.N`) | a fixed time, 0–10 s, used in place of a fade or delay value | not a tempo; not covered here |
  | Cue timing | each cue's fade, delay and trigger time | scaled by the sequence's rate |

  A sequence's rate master is a **speed** master: its effective BPM / 60 is the rate, so 60 BPM is 1:1 and 120 BPM
  halves every time. The sequence's RateScale multiplies that again.
- **Tempo of a master:** the fader holds the base tempo (BPM = 225 · (fader/100)^log2(3.75): fader 50 = 60 BPM, 100 =
  225 BPM). The SpeedScale multiplies it: **effective = base · factor**, which is what followers use. The console
  shows the effective tempo in whole BPM ("200 *B" when scaled); the tools compute it from the fader and report both.
- **Configured and observed tempo are separate.** Every master value above is configured. What actually plays is
  observed by `gma3_observe_tempo` for timed chases (cue changes over time). Phaser output is not observable over the
  bridge on onPC (no DMX output, no Lua readout of a running phaser), so a speed link is reported as configured only.
- **Three ways to set a tempo, kept apart:**
  - manual: `gma3_configure_speed_master` with `bpm`, `hz` or `seconds`;
  - tap tempo: `gma3_speed_master_action` `learn`, or an executor key with the Learn function (the console times the
    taps itself);
  - sound: only **master 16** ("BPM") follows the audio input. The console exposes the input device, the available
    devices and the SoundIn level, but **no input level, beat detection or beat lock**. The tools therefore never say
    a master is synchronised to music; movement of master 16 is reported as activity only.
- **Linked sequences share the master.** While a rate master is linked, moving the sequence's own rate fader moves the
  master, and so every sequence linked to it. Every change through these tools lists the followers in `warnings`.
- **Sequences refer to masters by name.** A master without a name, or two masters with the same name, cannot be
  linked unambiguously; the tools refuse such a link and `gma3_speed_masters` reports it.

## `gma3_speed_masters`

`{masters?: [1..16], usage?: true, sound?: true, observe_seconds?: 0..10}`. Reads:
- `children ShowData.Masters.Speed` (names, SpeedScale, LearnMode, FaderEnable, Lock);
- `getfader Master 3.N` for each master (fader and text);
- with `usage`, `children DataPool.Sequences` (SpeedMaster, RateMaster, the scales, SpeedFromRate) and every page's
  executors;
- with `sound`, `object Root.StationSettings.LocalSettings` (OnPCAudioInDeviceName), `children
  Root.Temp.AudioInDescriptions` and `getfader Master 2.SoundIn`.

Returns:
- per master: `fader`, `baseBpm`, `speedScale` (name and factor), `effectiveBpm`, `consoleText`, `learnMode`
  (ignore_scale, respect_scale, auto_increase_scale), `locked`, `problems` and `capabilities`;
- `usage`: per master `speedOf` (sequences whose phasers follow it), `rateOf` (sequences whose cue timing follows it,
  with the resulting rate) and `executors`;
- `sound`: `inputDevice`, `deviceListed`, `devices`, `soundInLevel`, `bpmMaster`, `beatDetection: "unavailable"`,
  `notes`;
- `observed` (with `observe_seconds`): per sampled master (master 16 unless `masters` is given) the first, last, min
  and max base tempo and how often it moved.

## `gma3_configure_speed_master`

`{master, bpm? | hz? | seconds?, speed_scale?, learn_mode?, preview?, verify?}`.

1. `read_master` refuses a locked master and a tempo above 225 × the final scale factor (the console would clamp it
   silently).
2. `set LearnMode`, `set SpeedScale` (each reply compared: the console silently ignores an invalid value), then
   `Master 3.N At BPM <x>`. The tempo is the **effective** tempo under the final scale, so the scale goes first. Hz is
   × 60, seconds is 60 / s. 0 stops the master.
3. verify (default): the master is read back until the scale, the learn mode and the effective tempo (from the fader)
   match, for up to about a second (commands land a frame later). The expectation is computed at full precision
   (1.004 BPM at Mul256 is 257.024); only the reported values are rounded.

A read-back that contradicts itself is never a match: when the console's tempo text disagrees with the fader and scale
(by more than 1 BPM or 1 %), or a part could not be read, the verification is `mismatched` and the contradiction is kept
in `after.problems`. The same holds for `gma3_speed_master_action`.

`speed_scale` takes One, Mul2..Mul256, Div2..Div256 or a power-of-two factor (2, 0.5). Changing only the scale keeps
the fader, so the effective tempo changes with it. Master 16 carries a warning: the sound input moves it again.

## `gma3_speed_master_action`

`{master, action: "learn" | "double" | "half" | "reset", taps?, interval_ms?, preview?, verify?}`.

| Action | Command | Verified |
| --- | --- | --- |
| `double` / `half` | `DoubleSpeed` / `HalfSpeed Master 3.N` | the scale one step up / down, the fader unchanged (refused at Mul256 / Div256) |
| `reset` | `Speed1 Master 3.N` | 60 BPM, scale One |
| `learn` | `Learn Master 3.N`, `taps` times `interval_ms` apart | with two or more taps: the tempo within 5 % of the taps' rate (the effective tempo under ignore_scale and auto_increase_scale, the base under respect_scale); one tap: `unavailable` |

The console measures the taps on arrival, so taps sent over the network carry its jitter (`tapped` reports the
interval as sent). A live tap belongs on a surface or an executor key: an executor holding the master with KeyPress
Learn takes taps through `Press` / `Unpress Page P.E`, and its fader (`FaderMaster Page P.E At <0-100>`) sets the base
tempo, both through the existing control path.

## `gma3_observe_tempo`

`{sequences: [1-8 numbers], seconds?: 1..30 (6), interval_ms?: 20..1000 (40)}`. Run the sequences first; the tool
starts nothing.

- Configured, per sequence: the rate (rate master's effective BPM / 60 × RateScale, or the sequence's own rate fader),
  its source, the speed link (phasers, `observable: false`), and `predictedStepMs` when every cue is Time-triggered
  with the same trigger time (otherwise `notPredicted` says why).
- Observed: the sequence's `CurrentCue` is read every `interval_ms`; each change is listed with its time and cue, with
  `meanStepMs`, `stepsPerMinute` and `deviationFromPredicted`. `resolutionMs` is the sampling granularity.
- A failed read is a gap, never a state: it is counted in `unreadSamples` and leaves the last known cue in place. A
  change seen after a gap is listed with `afterGap: true`, and every interval that touches one (`intervalsExcluded`) is
  left out of the mean, so only intervals between two precisely timed changes (`intervalsUsed`) measure the step. A
  read that succeeds without a current cue (a sequence that never ran) is a state of its own.

## What is and is not verified

- Verified live (onPC 2.5.1, `test/live/speed.live.ts`, 1/1, 16 s):
  - three four-cue chases (0.5 s per cue); two linked to master 14 by rate, one not;
  - at 60 BPM all three step at about 491 ms (predicted 500);
  - at 120 BPM (set as 2 Hz) the linked two step at 246 and 253 ms (predicted 250), the independent one at 500 ms;
  - double (240 BPM effective), half and reset verified; four taps 500 ms apart learned 118.7 BPM;
  - the executor holding the master moved it to 130 BPM with its fader; usage named both followers and the executor;
  - the sound input reported (device listed, SoundIn 100, beat detection unavailable).
- Not covered:
  - phaser tempo in operation (configured only; not observable on onPC);
  - cue-part and attribute speed masters (`PhaserSpeedMaster`), which override the sequence's link;
  - Speed from Rate in operation;
  - Pause, FastSync and ReSync on a master;
  - whether master 16 locks to the music (not readable).

## Live test

`GMA3_LIVE=1 node --import tsx --test test/live/speed.live.ts` on a disposable show with an empty programmer. It uses
Sequences 907–909, Page 90.212 (Page 90 is created when missing), fixtures 401–403 (`GMA3_LIVE_SPEED_FIXTURES`) and
speed master 14 (`GMA3_LIVE_SPEED_MASTER`), which must be unlocked and followed by no sequence. It refuses to run when
those sequences or the executor exist, restores the master's scale, tempo and learn mode, and deletes the rest.
