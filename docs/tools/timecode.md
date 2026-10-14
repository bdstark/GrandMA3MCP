# Timecode shows (SB-08)

Three tools author and run timecode shows from structured timestamps, with no manual timeline placement:
- `gma3_timecodes` reads the timecode pool, one show, and optionally the timecode slots;
- `gma3_build_timecode` creates a show, replaces its tracks or appends tracks: sequence tracks of cue events at
  explicit times;
- `gma3_timecode_transport` plays, stops, rewinds or seeks a show, then observes it and checks the events it crossed.

**Building never plays or records.** Only `gma3_timecode_transport` sends `Go`, `Off`, `Top` or writes the cursor. No
tool records.

Bridge **0.25.0** adds `timecode.read` and `timecode.edit` (see [the bridge protocol](../reference.md#timecode-shows-plugin-v0250-sb-08)).
Evidence: [the SB-08 probe record](../probes/sb-08-timecode-macos-2.5.1.md).

| Tool | Changes | Programmer |
| --- | --- | --- |
| `gma3_timecodes` | nothing (read-only) | untouched |
| `gma3_build_timecode` | one timecode show: its name, settings, and one track group with its tracks and events | untouched |
| `gma3_timecode_transport` | **plays, stops, rewinds or moves the cursor**: whatever the events do | untouched |

## The things to know first

- **Structure:** show → track group → track (with a **target**, a sequence in this release) → time range →
  command subtrack → events.
  - Each event has a time, a **token** (the action) and, for Goto, a cue.
  - Flash and Temp events also have a status: press (On) or release (Off).
- **Time:**
  - The console stores seconds × 2^24, so every time is rounded to 1/16777216 s.
  - You can give a time as seconds, `"H:MM:SS.sss"` (fractions after a dot), `"H:MM:SS:FF"` with `fps` 24, 25, 30 or 60,
    or `{frames, fps}`.
  - Times are read back exactly and shown in seconds and as timecode.
- **Order:**
  - The console runs events by time, not by how they are stored.
  - Events at the same time run in storage order.
  - The build stores each track's events sorted by time, keeping the order you gave for events at the same time.
  - Events of different tracks at the same time are reported in `warnings`: their mutual order is not defined.
- **Source, recording, playback and reception are distinct:**
  - `settings.tc_slot` **configures** the time source: `"internal"` or a timecode slot 1–16. It does not start
    anything.
  - **Recording** is not offered. Its armed state is not readable: it is a console method the bridge does not call.
  - **Playback** is the transport tool's `play`.
  - **Receiving** external timecode (SMPTE, MIDI, Art-Net) is not readable on 2.5.1. A slot shows its time only.
- **Building is several requests.** The console creates a group's first track and a track's time range one frame later,
  and a track takes events only once its target was set in an earlier frame. The build therefore runs step by step and
  waits until each step shows on the console.
- **A deleted target takes its events with it.** The track stays, without a target or events, and `gma3_timecodes`
  lists it in `problems`.

## `gma3_timecodes`

`{timecode?, fps?, slots?}`.

- Without `timecode`: the pool (`timecode`, `name`, `groups`).
- With `timecode`:
  - `name`, `playing`, `cursorSeconds`, `durationSeconds`;
  - `source`: `tcSlot` as internal or slot N, the slot offset, auto start/stop;
  - `playback`: loop mode and count, switch off, assert previous events, restart option;
  - `recording`: the record setting, and the armed state as unavailable;
  - `groups`, and `tracks` with `target`, `sequence` and `events`. Each event has `seconds`, `time`, `raw`, `action`
    (go, goto, off, flash_press, ...), `token`, `status`, `cue` and the storage position (`subtrack`, `index`);
  - `problems`: tracks without a target, Goto events without a cue, tokens these tools do not model, truncated reads.
- `slots: true` adds the 16 timecode slots with their time.

## `gma3_build_timecode`

`{timecode, mode, name?, fps?, settings?, tracks, allow_unpaired?, preview?, verify?}`.

| `mode` | Requires | Does |
| --- | --- | --- |
| `create` | the show does not exist | `Store Timecode N /NoConfirmation`, then the group |
| `replace` | the show exists, is not playing or locked | `Delete Timecode N.G /NoConfirmation` for every group (last first), then the group; the show's name and settings are kept |
| `append` | the same | a new track group after the existing ones, which are verified unchanged |

- `tracks: [{sequence, events: [{at, action, cue?}]}]`. Each `action` maps to a token:

  | `action` | Token |
  | --- | --- |
  | `go` | Go+ |
  | `go_back` | Go- |
  | `goto` (needs `cue`) | Goto + cue |
  | `on`, `off`, `toggle`, `top`, `pause`, `kill` | the same |
  | `flash_press` / `flash_release` | Flash On / Off |
  | `temp_press` / `temp_release` | Temp On / Off |

- Press and release must pair up per track (a release after its press, every press released) unless
  `allow_unpaired: true`.
- `settings`: `loop_mode` (`loop`, the console's default, repeats; `pause`; `off` stops at the end), `loop_count`,
  `tc_slot`, `switch_off` (`keep`: the playbacks the show started keep running when it stops; `off`), and
  `assert_previous_events`.
- Before anything is sent:
  - every sequence and cue must exist;
  - an existing show must have been read as unlocked and as not playing: a lock or playback state that could not be
    read refuses the change, as do a locked or playing show and one that was not read completely.
- The steps, in order:
  1. `Store`, or the group deletions;
  2. `set` Name and each setting, each compared;
  3. `timecode.edit add_group`, waiting for its track;
  4. `add_track` per further track, waiting for its time range;
  5. `set_target` per track;
  6. `add_events` per track, retried briefly while the console reports `[not-ready]`.
- Verification reads the show back and compares:
  - every track's target;
  - every event's exact time, action, press/release status and cue, in order;
  - for `append`, the earlier groups.

  `played: false` and `recorded: false` are part of every result.

## `gma3_timecode_transport`

`{timecode, action: "play" | "stop" | "rewind" | "seek", to?, fps?, observe_seconds?, interval_ms?}`.

| `action` | Sends | Verified |
| --- | --- | --- |
| `play` | `Go Timecode N` (from the cursor) | each event the cursor crossed against the target sequences' observed changes, in order |
| `stop` | `Off Timecode N` | the show is not playing (a warning when its playbacks keep running) |
| `rewind` | `Top Timecode N` | the cursor is at 0 |
| `seek` | `set Cursor` (`to`, a time as above) | the cursor is at `to` |

- The tool samples the cursor, the show's playback state, and every target sequence's current cue and playback state,
  every `interval_ms` (40) for `observe_seconds` (5 for play). A play stops observing when the show stops.
- For `play`, each crossed event gets an `expected` state where it is predictable:
  - `goto` → that cue, running;
  - `go` → the next cue, or the first when the sequence was off;
  - `off` → off;
  - a press → running.

  Releases and other actions are listed with `expected: null`, since what they do depends on the state before the
  press.
- Each sequence is matched on its own, in order. An event's expected state must appear in a change of its own sequence,
  inside the event's window: from its time minus the read skew, up to the next event on that sequence (plus the skew).
  The read skew is the slowest sample's full duration, timed from before its cursor request to after its last sequence
  read, plus 0.05 s: each sample reads the cursor first, so a change can carry a cursor up to that much early. So an
  earlier, unrelated change never verifies a later event. Each event gets a `result`:
  - `matched`: seen in its window;
  - `missed`: not seen;
  - `unchanged`: the sequence was already in that state, so nothing could be seen;
  - `unpredictable`: no predicted effect;
  - `superseded`: the next event on the sequence followed within the skew.
- Across sequences, only the order the samples can resolve is checked. Two events seen in the same sample, or less
  than the skew apart, are reported as unresolved in the detail, never as wrong. An order the samples do resolve, but
  observed the wrong way round, is a mismatch.
- Verification:
  - `mismatched` when an event was missed or an order is inverted;
  - `matched` when at least one event matched and nothing was missed;
  - `unavailable` when nothing was crossed or nothing was observable.
- `execution` keeps `dispatched` separate from what was `observed`: the samples, the cursor range and the sequences'
  changes.

## What is and is not verified

- Verified live (onPC 2.5.1, `test/live/timecode.live.ts`, 1/1, 14 s, run twice):
  - a build refused for a missing sequence;
  - a show built from out-of-order events (one at `0:00:02:12` at 25 fps) and read back exactly in time order;
  - play, matched event by event: a Flash press at 0.5 s and release at 1.5 s, Go, Go, Goto, Go, Off;
  - rewind and a second play, matched;
  - a seek to 2.2 s, then play, which crossed only the later events;
  - a stop in the middle;
  - a deleted target reported, with that track's events gone and the other track untouched;
  - replace, keeping the show's name and settings.
- Not covered:
  - fader automation (FaderSubTrack) and recording;
  - targets other than sequences;
  - several time ranges per track;
  - markers;
  - external timecode sources;
  - 29.97 fps and drop-frame timecode.

## Live test

`GMA3_LIVE=1 node --import tsx --test test/live/timecode.live.ts` on a disposable show with an empty programmer and
bridge 0.25.0. It uses Timecode 901 and Sequences 908–909, refuses to run when any of them exists, and deletes them at
the end.
