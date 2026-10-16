# SU-14 probe: cue commands, empty cues, deleting cues, trigger times, preset ranges (macOS, onPC 2.5.1)

Evidence for [SU-14 in SETUP.md](../../SETUP.md#su-14--cue-contents-commands-phasers-ranges-and-overrides). It also settles
[SU-15](../../SETUP.md#su-15--console-variables)'s first question.

- **Date:** 2026-10-15
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, the throwaway show `NewShow_2026.10.15_23.16.24UTC`,
  bridge 0.30.1
- **Method:** the bridge's `cmd`, `set`, `objects` and `children` ops on Sequences 940–941, Page 90.220 and the global
  variable `mcpprobe`, each deleted afterwards. Then `test/live/cue-contents.live.ts`.

## Cue command

| Request | Result |
| --- | --- |
| `Store Sequence 940 Cue 1 /NoConfirmation` with an empty programmer | OK: an empty cue (TrigType Go, TrigTime 0.00) |
| `objects Sequence 940 Cue 1 Part 0` | `Command` "" and `CommandDelay` 0.00 |
| `set` Part 0 `Command` = `Go+ Macro 20; Echo "x"` | read back exactly; `CommandEnabled` Yes |
| `set` on the cue itself, `Command` | the reply carries no value, and the cue has no Command property |

A cue's command lives on Part 0, and a command-only cue is an empty cue with a command.

## Trigger times

| Step | TrigType / TrigTime |
| --- | --- |
| set Time, 2.5 | Time / 2.50 |
| set TrigType Go | Go / **0.00** |
| set TrigType Time again | Time / **0.00** |

The field test's raced clocks are this behaviour: switching away from Time wipes TrigTime, and switching back keeps 0.
`gma3_edit_cues` now reports the wiped times. `keep_times` saves them in the sequence's `Note` (a writable property
that reads back exactly: `[gma3-mcp trigtimes 1=2.5 2=4]`), and `restore_times` sets them back.

## Deleting cues

`Assign Sequence 940 At Page 90.220`, then `Delete Sequence 940 Cue 1 Thru /NoConfirmation`. The sequence keeps only
`OffCue` and `CueZero`, and the executor still holds Sequence 940. `replace: true` uses this, so the sequence object,
its settings and its executor assignments stay. Since review round 1 the delete is sent from inside the Preview
environment, once Preview is confirmed usable and empty. The live rerun showed that it works there too: the assignment
on Page 90.220 was kept.

## Preset ranges

| `objects` ref | Result |
| --- | --- |
| `Preset 21.11 Thru 14` | 11, 12, 13, 14 |
| `Preset 21.11 Thru 21.14` | nothing |
| `Preset 21.11 Thru Preset 21.14` | 30 presets (runs on past 14) |

The range form is `Preset <pool>.<from> Thru <to>`, and the numbers are filtered as well.

## Running sequences

`objects Sequence Thru` lists the pool with `Priority` and `OffWhenOverridden`. Its `No` field reads "1 (20)" (the
number, then the cue count), so the leading number is parsed. `object` gives `hasActivePlayback`. In this show 8
sequences were playing, all with Off When Overridden off, so a High override lists none.

## SU-15: `$variables` in commands sent through the bridge

| Command through the bridge's `cmd` | Result |
| --- | --- |
| `SetGlobalVariable "mcpprobe" "Probe940"`, then `Label Sequence 940 $mcpprobe` | Sequence 940 is named "Probe940" |
| `SetGlobalVariable "mcpprobe" "941"`, then `Store Sequence $mcpprobe Cue 1 /NoConfirmation` | Sequence 941 is created |
| `SetGlobalVariable "mcpprobe"` | the variable is removed |

**`$variables` do expand in commands sent through the bridge.** The field-test agent's conclusion came from reading
`HasActivePlayback` straight after a `Goto`, which reads false for a frame (SU-06). It was wrong.

## Live test (`test/live/cue-contents.live.ts`, 1/1)

| Case | Result |
| --- | --- |
| a command-only clock (cues 1–2, Time 2.5 / 4) and a look with a command | stored; the commands read back |
| a switch to Go with `keep_times`, then Time with `restore_times` | 2.5 / 4 wiped and reported, saved in the Note, set back; the marker removed |
| `presets {21, 11, 14}` on 101 + 102 | 4 cues named "C01 Rainbow Sync" … "C04 Ocean Sync" |
| assign to Page 90.220, then `replace` | assignments `["Page 90.220"]` before and after, kept |
| a Dimmer phaser in a cue look (phase 0 → 180, 120 BPM) | checked in Preview, stored |
| `sequence_settings {priority: high, off_when_overridden: false}` | applied; the override lists no running sequence (all have it off here) |
