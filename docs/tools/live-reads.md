# Live playback and value reads (SU-16)

What runs and where, and how values change, without Lua. Needs bridge 0.32.0 for the current cue; with an older
bridge the reads still answer, without the cue.

## The current cue

Bridge 0.32.0 adds `currentCue {no, name}` to a sequence's summary in the `object` op, in `children` with
`playback: true` and in the assigned sequence of `executor` and `executors`. `no` is the cue number: the console's
`Cue.no` is the number times 1000 (cue 7 reads 7000), and the bridge divides it.

`Sequence.CurrentCue` keeps naming the last cue after `Off`. So the server reports a cue as current only while the
sequence has active playback:

| `hasActivePlayback` | `currentCue` | `lastCue` | `observedCue` |
| --- | --- | --- | --- |
| true | the cue it is in | (absent) | (absent) |
| false | `null` | the cue it stopped in, when the console still names one | (absent) |
| missing (the activity read failed) | `null` | (absent) | the cue the console names: current or sticky, unknown |

A sequence is recognised by its class, so it is annotated even when the activity flag is missing.

These reads carry the state:

- `gma3_sequences`: each sequence's `currentCue`, or `lastCue` after Off.
- `gma3_executors`: the same fields on `assigned`, for an assigned sequence.
- `gma3_cues`: `sequence` (one) or `sequences` (1-20 in one read). Each sequence comes with its cues (default
  fields No, Name, TrigType, TrigTime, Command, Note) and `playback {active, currentCue, lastCue}`. With
  `sequences`, a missing sequence is its own row with `error`; it does not fail the whole read. A sequence named
  by name (`"Clock"`, without double quotes inside) is read the same way. When the state cannot be read,
  `playback` is `{notRead}` with the reason.

## Read-back after a playback command

A playback command takes effect on the console's next frame. Read straight after it, `HasActivePlayback` is still
false (SU-06). The tools wait 100 ms (`readAfterMs`) and then read:

- `gma3_goto_cue`: verification is `matched` when the sequence plays the cue that was asked for, and
  `playbackState` has the cue's number and name. It is `mismatched` when the sequence is in another cue (a
  Follow or 0 s Time trigger can move it on within the frame) or is not playing. It is `unavailable` when the
  bridge predates 0.32.0. `verify: false` skips the read.
- `gma3_playback`: for a `Sequence n` or `Executor n` target (current page), the result has `playbackState`
  (`active`, `currentCue`, `lastCue`). Other targets get `playbackState.notRead` with the reason.

A crossfade keeps running after the read. Its completion is not verified.

## Compact programmer read

`gma3_programmer` takes two options:

- `fields`: keep only these row keys. `fid`, `subfixtureIndex` and `attribute` are always kept.
- `by_fixture: true`: `perFixture`, one entry per (sub)fixture, in place of `rows`. Each entry is
  `{fid, fixture, subfixtureIndex, channels, values}`, where `values` maps attribute to value. A multi-step phaser
  reads `"phaser (n steps)"`. With `fields`, each attribute maps to an object of those fields.

The fold covers one page, and `by_fixture` makes the page a whole scan (limit 5000) unless `limit` is given.

## gma3_observe_values

Watches values over time on the server side. It is read-only and starts nothing.

| Parameter | Meaning |
| --- | --- |
| `fixtures` | Programmer: a range (`"101 Thru 112"`), one fixture, or a list. Output: 1-8 fixtures. |
| `source` | `programmer` (default) or `output` (raw DMX per channel, through `fixtureOutput`). |
| `attributes` | Only these attributes (case-insensitive). |
| `seconds` | 1-30, default 5. |
| `interval_ms` | 50-2000, default 200. |

The result lists the `changed` channels. Each has `first`, `last`, `min`/`max`, `changeCount` and up to 20 timed
`changes` (`ms`, `from`, `to`). `unchanged` lists the channels that held their value. `resolutionMs` is the
sampling granularity.

Gaps are never values:
- A sample whose read failed, whose programmer scan was incomplete (`coverage.complete` not true) or whose page
  was truncated (`total` above the rows returned) is a gap: `unreadSamples` counts them and `gapReasons` says why.
  An incomplete first read stops the tool (`observed: false`) instead of calling the programmer empty.
- A programmer channel that leaves the programmer in a complete read reads `null` (released).
- An output channel without a readable value keeps its last level. The channel carries `unreadSamples` and its
  `unreadable` intervals (`fromMs`, `toMs`, null while still unreadable), and `unreadableChannels` lists every such
  channel (`everRead` false when it never had a value) with `outputState`.

Output is checked before sampling. When no channel has a readable value (a universe that is not granted, as on an
onPC without a grant), the tool samples nothing. It returns `observed: false` with the reason and `outputState`,
the explanation per universe from [gma3_dmx_output](dmx-output.md). When only some channels are unreadable, the
rest are watched and the unreadable ones are reported as gaps.

A running phaser in the programmer reads as its steps, not as a moving value: the programmer holds the steps. Its
movement shows only in the output.

Use this tool instead of a Lua polling loop. Each `gma3_lua` request has a budget of about 5 s, and on an onPC
without a grant `GetDMXValue` returns nil for every sample.
