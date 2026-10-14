# SB-06 probe: speed masters, rate links, tap tempo and sound (macOS, onPC 2.5.1)

Evidence for [SB-06 in SHOWS.md](../../SHOWS.md#sb-06--configure-shared-speed-and-synchronization) and
[the speed tools](../tools/speed.md).

- **Date:** 2026-10-13
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, show `mcp-test-disposable`, bridge 0.24.0 (Lua on for
  the manual pass; the tools need no new op)
- **Method:** a manual pass through `gma3_lua`, `cmd`, `set`, `objects`, `getfader` and `children`, with the playback
  measured by sampling the current cue from Node, then the tools through `test/live/speed.live.ts`.
- **Objects:** Speed master 14 (state saved and restored: 60 BPM, scale One, Learn Ignores Speed Scale), Sequences
  907–909, Page 90 / 90.212, all checked absent first and deleted afterwards. Fixtures 401–403.

## Where the masters are

- `ShowData.Masters` holds five pools: Selected (1), Grand (2), **Speed (3, 16 masters, class MasterSpeed)**,
  Playback (4) and Timing (5). `Master 3.N` (or `Master 3."Name"`) addresses a speed master on the command line and
  through the bridge's `objects`, `set` and `getfader` ops.
- The show's names: 1 "Beat", 2 "Position Speed", 3–15 "Speed3".."Speed15", **16 "BPM"**.
- A speed master's settings are properties: `SpeedScale` (enum SpeedScale: Div256 … Div2, One, Mul2 … Mul256),
  `LearnMode` ("Learn Ignores Speed Scale", "Learn Respects Speed Scale", "Auto Increase Speed Scale"), `FaderEnable`
  (AlwaysOn, Toggle, Disabled), `Lock`, `Name`. `LearnRespectsSpeedScale` and `AutoIncreaseSpeedScale` are Yes/No
  mirrors of LearnMode. `NormedValue` is the fader position with two decimals.
- **Timing masters (pool 5) are not rate masters**: they are 0–10 s values used in place of fade/delay times. A
  sequence's rate master is a *speed* master (below).

## Tempo of a speed master

- The fader (`GetFader`, 0–100) holds the **base** tempo: **BPM = 225 · (fader/100)^log2(3.75)**, so fader 50 =
  60 BPM and 100 = 225 BPM. Nineteen written values from 0.1 to 225 BPM fit the formula to the fourth decimal of the
  fader.
- `GetFaderText` gives the tempo in whole BPM (one decimal below 10): "60 B", "1.0 B", "Stop" at 0, and with a scale
  other than One the *effective* tempo with an asterisk, "200 *B". No precise readout exists (the readout options of
  GetFaderText change nothing).
- **Effective tempo = base · 2^scale.**
- Commands, all answered "OK", each applied on a later frame (a read in the same Lua chunk still shows the old value):

  | Command | Result |
  | --- | --- |
  | `Master 3.14 At BPM 120` | base 120 (fader 71.9174) |
  | `… At Hz 2`, `… At Seconds 0.5` | the same 120 BPM |
  | `… At BPM 240` | **clamped to 225 silently** |
  | `… At BPM 0` | "Stop" (fader 0) |
  | `… At 75` | fader position 75 = 130 BPM (a plain value is the fader, not BPM) |
  | `… At BPM 300` with SpeedScale Mul2 | **effective 300**: base 150 (`At BPM` sets the effective tempo; 0–450 with Mul2, clamped above) |
  | `DoubleSpeed Master 3.14` / `HalfSpeed` | SpeedScale one step up / down; the fader stays (100 BPM → "200 *B", Mul2) |
  | `Speed1 Master 3.14` | fader to 60 BPM **and** SpeedScale One |
  | `set SpeedScale Mul2` | the effective tempo doubles; the base stays |

- An invalid `set` value is silently ignored (SpeedScale "Bogus" keeps the old one), as in SB-01.
- **Lock:** with `Lock Yes`, `set SpeedScale` is silently ignored, but `Master … At BPM` and `DoubleSpeed` still apply.

## Tap tempo (Learn)

- `Learn Master 3.N` is one tap; the console times the taps itself. Four taps 496 ms apart → 120 BPM, three taps
  987 ms apart → 60, four `LearnSpeed` taps 400 ms apart → 149. The tempo comes from when the commands reach the
  console, so taps sent over the network carry its jitter.
- With SpeedScale Mul2 and 60 BPM tapped: **Ignores** → effective 60 (base 30); **Respects** → base 60, effective
  120; **Auto Increase** → effective 60, and taps above 225 BPM raise the scale (200 ms taps → Mul2, "307 *B").
- An executor holding the master with `KeyPress Learn` taps the same way through `Press`/`Unpress Page P.E`
  (4 × 500 ms → 120 BPM).

## Sequences: speed master versus rate master

- A sequence has `SpeedMaster`, `RateMaster`, `SpeedScale`, `RateScale` (enum SpeedScale) and `SpeedFromRate`. Cue
  parts have `PhaserSpeedMaster` and `PhaserSpeedScale`.
- **SpeedMaster and RateMaster are written by the master's name** ("Speed14", "Beat") and read back as the name, also
  with `asText: false`. "14", "3.14", "Master 3.14" and "Speed 14" are silently ignored. RateMaster accepts speed
  masters only ("Timing1" ignored). Names are not unique by rule, so a duplicate name is ambiguous.
- `Assign Master 3.14 At Sequence 907` → "Illegal object".
- **What follows what**, measured on a four-cue chase (TrigType Time, TrigTime 1 s, WrapAround), sampling the
  sequence's `CurrentCue` every 40 ms:

  | Setting | Step interval |
  | --- | --- |
  | no master | 1009 ms |
  | RateMaster Speed14 at 60 BPM | 1002 ms (60 BPM = 1:1) |
  | … at 120 BPM | **495 ms** |
  | … at 30 BPM | **1986 ms** |
  | … at effective 60 (base 30, Mul2) | 991 ms: the rate follows the effective tempo |
  | RateMaster Speed14 at 60 + the sequence's RateScale Mul2 | 498 ms |
  | no master, RateScale Mul2 | 498 ms |
  | **SpeedMaster** Speed14 (no rate master) at 120 BPM | 1010 ms: the speed master drives phasers, not cue timing |

  Sequence rate = (rate master's effective BPM / 60) · 2^RateScale.
- The sequence's own rate fader (`FaderRate Sequence 908 At 75`) is a percent of 1:1: it read 42.998 (the 45 BPM
  position) and stepped at 1327 ms. **While a rate master is linked, the sequence's rate fader is the master**: it read
  the master's 71.89, and `FaderRate Sequence 908 At 25` moved Speed14 to 15 BPM, for every sequence linked to it.
- `SpeedMaster` drives the phasers in the sequence's cues (the manual: a cue part's or attribute's own master wins). On
  this onPC **the phaser output is not observable**: DMX universe 1 is not granted (GetDMXValue nil), and no Lua API
  gives the running phase.
- The StartShow sequences use the model: phaser sequences with SpeedMaster "Beat" / "Position Speed", chases with
  RateMaster "Beat" and RateScale Mul2. Reading all 426 sequences' five properties with `children` took 258 ms.

## Executors

- `Assign Master 3.14 At Page 90.212` (after `Store Page 90`): Object "Speed14", Fader Master, KeyPress Toggle.
- `FaderMaster Page 90.212 At 75` → the master at 75 (130 BPM).
- Key functions the console offers for a speed master (Enums.AssignmentButtonFunctionsSpeed): DoubleSpeed, Empty,
  FastSync, HalfSpeed, Learn, LearnSpeed, Off, On, Pause, ReSync, Speed1, Toggle. `set Fader Rate` on that executor
  was accepted, although the master-only fader functions are Empty and Master.

## Sound

- Master 16 "BPM" follows the sound input: it moved by itself between reads (116 → 85 → 83 → 74 → 135 → 131 → 74 →
  76 BPM, no commands; the MacBook microphone in a quiet room). The manual: a manual move snaps it to a multiple of
  the detected BPM.
- `Root.StationSettings.LocalSettings` `OnPCAudioInDeviceName` names the input ("MacBook Pro Microphone (Apple Inc.)");
  `Root.Temp.AudioInDescriptions` lists the devices (four here); Grand master `SoundIn` (2.14) is the input gain (100).
- **Not readable:** the input level, the beat detection, or whether master 16 is locked to a beat.
  `Root.Temp.SoundChannels` (All, Bass, … InvBand7) carry no value property. Movement of master 16 is evidence of
  activity, not of synchronisation (an operator or a surface moves it too).
- Cue TrigType BPM triggers on the beats of the sound input, not on a speed master (manual).
