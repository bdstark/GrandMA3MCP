# SU-06 probe: storing cues in batches, Preview, chases and their playback (macOS, onPC 2.5.1)

Evidence for [SU-06 in SETUP.md](../../SETUP.md#su-06--build-cue-lists-and-chases-in-batches).

- **Date:** 2026-10-15
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, the throwaway show `NewShow_2026.10.15_04.21.01UTC`,
  bridge 0.27.0
- **Method:** commands through the bridge's `cmd` op, properties with `set`, reads with `objects`, `children`,
  `object`, `programmer` and `cueContents`, from Node scripts. Fixtures 101–102 (Mega Hex Par) and 301 (beam).
  Presets 4.901–4.903 (red, green, blue, stored from 101) and Sequences 950–952 were checked empty first, created
  for the probe and deleted afterwards; the probe ended with `ClearAll`.

## Storing

| Step | Result |
| --- | --- |
| `Fixture 101 + 102`, `At Preset 4.901`, `At 100`, `Store Sequence 950 Cue 1 /NoConfirmation` | the cue and the sequence are created; **the programmer keeps its 14 values** after the store |
| the cue's name without a `Name` write | `[4.901]`: the console names the cue after the preset it holds |
| `cueContents` of the cue | part 0 `ownDataPresent: true`, no recipes; the stored values are not readable (no GetCueData on 2.5.1) |
| `set Name` on `Sequence 950` | writable; reads back |
| a new sequence's `WrapAround` | `Yes` by default |
| `children` of the sequence (`asText: false`) | `OffCue`, `CueZero` (No 0), then the cues with `No` ×1000 (1000, 2000, …) |

So each cue starts from an empty programmer, and its content is checked in the programmer before the store, since it
cannot be read from the cue afterwards.

## Preview

The Preview environment (SB-04) has its own programmer and selection:

| Step | Result |
| --- | --- |
| Normal: 301 at 33 %, then `Preview On` | the programmer op reports `environment: "Preview"`, 0 values |
| `Fixture 101 + 102`, `At Preset 4.902`, `At 80` in Preview | 14 values; `absPreset` names Preset 902 on the colour rows |
| `Store Sequence 950 Cue 4 /NoConfirmation`, `ClearAll`, `Preview Off` | cue 4 exists (`[4.902]`, own data); back in Normal, 301 is still at 33 % and nothing else is in the programmer |

Building in Preview outputs nothing and leaves the operator's Normal programmer alone. `ClearAll` must only be sent
after the console confirms Preview.

## Playback of a chase

Three cues, `TrigType` Time and `TrigTime` 1 s on each, sampled through `CurrentCue` every 30 ms:

| Setup | Cue changes seen (ms: cue ×1000) |
| --- | --- |
| all Time, WrapAround Yes, `Go+ Sequence 950` | 15: 1, 1019: 2, 2040: 3, 3065: 1, 4023: 2, 5033: 3: **loops** |
| cue 1 on Go, others Time | 50: 1, 1039: 2, 2028: 3, then stops: the wrap needs a trigger on cue 1 |
| all Time, WrapAround No | 33: 1, 1033: 2, 2028: 3, then stops |
| cue 2 with CueInFade 0.5 | steps still 1 s: the Time trigger counts from the previous cue's start |
| `Goto Sequence 950 Cue 3` from off | 16: 3, 1014: 1, 2002: 2, 3012: 3: the chase runs on from there, through the wrap |
| TrigTime 0.3 s | steps of 285–320 ms, all seen |

**State.** After `Off Sequence 950`, `CurrentCue` still names the last cue. `HasActivePlayback` (the `object` op)
read false right after a `Goto` and true 0.6 s into a `Go+`, then false after `Off`. The `CUENO` / `CUENAME`
properties are empty while the sequence is off. The sequence's own rate fader (`FaderRate`) is 50 % by default: rate
1 (60 BPM).

## Consequences for the tools

- Cues are built in Preview, one `ClearAll` per cue (in Preview only), and each look is checked in the programmer
  (preset links, values per fixture) before its store.
- The Normal programmer is fingerprinted before and after: it must be unchanged.
- A chase puts a Time trigger on every cue, cue 1 included, and turns Wrap Around on.
- One cycle is verified by `Goto` to the start cue and sampling `CurrentCue`. A long cycle is observed from a late
  cue through the wrap (`Goto` from off runs on). Changes before the start cue appears are ignored, since
  `CurrentCue` keeps the last cue after `Off`.

## The tools, live

`gma3_store_cues` smoke run (Sequence 951): three cues matched, one of them with two looks; the unnamed cue was named
`[4.902]`; the Normal programmer was untouched. `gma3_edit_cues` set Time 3, fade 0.5 and names on all three.
`gma3_build_chase` (Sequence 952, three presets, 1 s): one full cycle 1 → 2 → 3 → 1 → 2 with steps of 934–1023 ms
(predicted 1000). With six 2 s steps and `observe_max_seconds: 7` it observed the tail 5 → 6 → 1 → 2.

`test/live/cuelists.live.ts` 1/1 (12.8 s) on fixtures 101 and 102: three cues from looks with the operator's Normal
value kept; cues 2–3 edited; a 0.5 s chase watched for one full cycle; a six-step chase watched through its wrap.
Presets 4.941–4.943 and Sequences 910–912 were deleted afterwards.
