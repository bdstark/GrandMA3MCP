# SU-12 probe: batch forms and compact results (macOS, onPC 2.5.1)

Evidence for [SU-12 in SETUP.md](../../SETUP.md#su-12--batch-forms-and-compact-results).

- **Date:** 2026-10-15
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, the throwaway show `NewShow_2026.10.15_23.16.24UTC`,
  bridge 0.30.0
- **Method:** `test/live/batch.live.ts` with `GMA3_LIVE_BATCH_FIDS=102,103,104,105` (Mega Hex Pars), then the bridge's
  `programmer` op directly for the scan finding below.

SU-12 needs no new console facts: every item runs through a single form whose behaviour earlier probes established.
The live runs checked the batch rules against the console and measured the result sizes.

## Batch forms on the console

| Call | Result |
| --- | --- |
| `gma3_store_group` with two groups (a reversed range; `rows` [[102, 103, 104], [105]] in width 3) | both stored and matched; recall order follows the cells |
| the same with a second row repeating fixtures of the first | that group refused before anything was sent (duplicate fixtures), the other stored: `partial` |
| `gma3_store_macro` (two macros), then `gma3_edit_macro_line` (insert, remove, set on shifted lines) | all matched |
| `gma3_store_cues` with two sequences | two Preview builds, all cues matched |
| `gma3_configure_sequence` with `["920 Thru 921"]` | both configured and read back |
| `gma3_assign_to_executor` with two assignments to empty executors | matched; the same call again sent no command (`already assigned`) |
| an assignment to an occupied executor without `replace` | that item failed, nothing sent |
| `gma3_store_preset` with two presets from content (one with two looks) | built in Preview, stored, read back; the Normal programmer value (104 at 33 %) unchanged |

## Result sizes

An 18-step `gma3_build_chase` (one cue per step, 0.2 s, one full cycle observed):

| Form | Size |
| --- | --- |
| field test (18 cues, full result) | 66.6 KB |
| compact, first version (every cue with its look checks) | 9.6 KB, of which the cue list was 6.4 KB |
| compact, one line per matched cue, cycle as cue order and intervals | 3.7 KB |

## Finding: the scan of all fixtures misses subfixture index 0

The first preset run on fixtures 101–104 was refused: `fixture 101 has no programmer value`, although the look check
had just read 101's Dimmer at 50 % in the Preview programmer.

| Read (Normal, `Fixture 101 + 102`, `At 50`) | Rows |
| --- | --- |
| `programmer` scope `selection` | `101/0 Dimmer=50`, `102/1 Dimmer=50` |
| `programmer` scope `all` | `102/1 Dimmer=50` only |

`GetSubfixtureCount()` returns 148 on this show. `GetSubfixture(0)` is fixture 101, `GetSubfixture(147)` the last
Festoon cell, and `GetSubfixture(148)` is nil: the indices are 0..count−1. The bridge's scope `all` loop runs from 1 to
count−1, so it skips index 0. The loop dates from a show whose index 0 was MA's Universal fixture (the SB-03 probe
names it). This show has none, so index 0 is a real fixture.

Every scope `all` reader misses that fixture:
- the Normal programmer snapshot of the Preview builds;
- `gma3_store_preset`'s content check, which refuses a scope that includes it (or would not see an unexpected value on
  it).

The live test avoids the first patched fixture until the bridge scans index 0. The fix is a separate bridge change.
