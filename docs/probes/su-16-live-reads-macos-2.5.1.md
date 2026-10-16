# SU-16 probe: live playback and value reads (macOS, onPC 2.5.1)

Evidence for [SU-16 in SETUP.md](../../SETUP.md#su-16--live-playback-and-value-reads).

- **Date:** 2026-10-16
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, the throwaway show `NewShow_2026.10.15_23.16.24UTC`,
  bridge 0.31.0, then 0.32.0
- **Method:** the bridge's `objects` and `lua` ops, read-only, on Sequence 1 ("MH Moves"). Then
  `test/live/live-reads.live.ts`.

## The current cue

| Read | Result |
| --- | --- |
| `objects Sequence 1` with field `CurrentCue` (as text) | `"[M07 Cone Mirror]"`: the cue's name only, no number |
| Lua `s.CurrentCue` | a Cue handle: class `Cue`, parent "MH Moves", index 7 |
| its `no` | `7000`: the cue number times 1000 |
| its displayed `No` | `"  7"` (padded text) |
| `s:HasActivePlayback()` with the sequence off | `false`, while `CurrentCue` still names cue 7 |

`CurrentCue` is sticky after Off, as SU-06 found. So bridge 0.32.0 reports `currentCue {no = Cue.no / 1000, name}`
next to `hasActivePlayback`, never alone. The server shows it as `currentCue` while the sequence plays and as
`lastCue` after Off.

## A frame after a command

`test/live/live-reads.live.ts` builds Sequence 945 with two cues and names cue 2 "Blue":

- `Goto Sequence 945 Cue 2`, read 100 ms later: `hasActivePlayback` true, `currentCue {no: 2, name: "Blue"}`.
- `Off Sequence 945`, read 100 ms later: `hasActivePlayback` false. `CurrentCue` still names cue 2, so the server
  reports it as `lastCue`.
- `Go+ Sequence 945`, read 100 ms later: active, with a numbered current cue.

SU-06 recorded that `HasActivePlayback` reads false straight after a Go. A 100 ms wait was enough in every run.

## Output

On this onPC no universe is granted. `fixtureOutput` on fixture 101 returns `value: nil` for all 8 channels, and
`gma3_observe_values` with `source: "output"` stops before sampling, saying universe 1 cannot be read (see
[SU-09](su-09-dmx-output-macos-2.5.1.md)). Programmer sampling works: a `Fixture 101 At 20` sent 700 ms into a
2 s watch shows as one change, from 70 to 20.

## Live test

`test/live/live-reads.live.ts`, 8/8 with bridge 0.32.0. `test/live/cues.live.ts` (goto now matched),
`playback.live.ts` and `inspection.live.ts` also pass.
