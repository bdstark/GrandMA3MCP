# ReSync and the tempo-sync plugin (SU-17)

Realign running effects, and see and configure the console's external tempo sync. The sync itself is done by a
separate console plugin, [bdstark/gma3-beat-sync](https://github.com/bdstark/gma3-beat-sync) (GPL, its own
repository), which follows an external tempo source. These tools reach it only through the console: its global
variables `BeatSync.*`. No code crosses the repositories, and no OSC or console network setting is involved.

| Tool | What it does |
| --- | --- |
| `gma3_playback` `action: "resync"` | ReSync for sequences, lists and ranges, each checked first and read back |
| `gma3_tempo_sync_status` | Read-only: whether the plugin is imported and running, and what it publishes |
| `gma3_configure_tempo_sync` | Set or clear the plugin's configuration, read back |

## ReSync

`gma3_playback` with `action: "resync"` and a target:
- `Sequence 1`, a list or range such as `Sequence 1 + 11 Thru 19 + 31` (up to 100 sequences);
- or an executor (`Executor 201`).

Sequence targets:
1. Every sequence is checked first. A missing one refuses the call before anything is sent, because ReSync of a
   range skips it silently.
2. `ReSync <target>` is sent once and never resent.
3. A frame later, each sequence's state is read back: playing or not, and its current cue. The summary names the
   sequences that don't play, since there is nothing to realign in them.

**What ReSync does:**
- **Phasers:** the console's manual says ReSync "gradually synchronizes phasers": it moves the start point of the
  phasers running in the sequence toward the moment of the command, instead of jumping. A phaser's output is not
  observable over the bridge, so the tool reports the command and the playback state, not the realignment itself.
- **Chases (cue steps), measured live:** a running three-cue chase with 1 s Time triggers kept its cue and its step
  timing. The next step came on schedule, followed by 1 s steps. ReSync does not restart a sequence or change its
  cue.

## gma3_tempo_sync_status

- `installed`: whether `gma3_beat_sync` is in the show's plugin pool, with its `slot`.
- `running`:
  - false when `BeatSync.State` is missing or `not running`, or when `BeatSync.Updated` is more than 2 s older than
    the console clock (the plugin writes its status four times a second);
  - null when the clock can't be read (`show.files`, bridge 0.35.0).

  After a show load the plugin is always stopped, and its status variables saved with the show are stale.
- `explanation` says plainly what holds: the plugin is not imported, not running (with how to start it), running
  with no session, or following a session at a tempo with a number of peers.
- **Readings:** `state`, `tempo`, `beat`, `phase`, `peers`, `playing`, `session`, `driftMsPerMin`, `frameMs`,
  `frameJitterMs`, `droppedFrames`, `missedBeats`, `lastAction` (text, and `ok`, `failed` or `uncertain` from its
  suffix), `problems` (a list), `error`, `version`, `updated` and its age. While the plugin isn't running, these are
  the last published values, and `valuesNote` says so.
- `configuration`: every configuration key, with the plugin's default where one is unset.

**Starting the plugin** is left to the operator: `Plugin "gma3_beat_sync"` at the command line or in a macro. Sent
through the bridge's `cmd`, it would block in the plugin's loop.

## gma3_configure_tempo_sync

| Parameter | Variable | Validation |
| --- | --- | --- |
| `master` | `BeatSync.Master` | speed master 1-16 the session tempo is written to |
| `quantum` | `BeatSync.Quantum` | beats per bar, 1-64 |
| `start_stop` | `BeatSync.StartStop` | `on` (beat actions only while the session plays) or `off` |
| `resync` | `BeatSync.Resync` | sequences to ReSync on every bar: `[1, 11]` or `"1 + 11 Thru 19"`; each must exist |
| `on_bar`, `on_beat`, `on_start`, `on_stop`, `on_join`, `on_leave` | `BeatSync.OnBar` ... | a console command, 1-255 characters, no control characters |
| `actions` | `BeatSync.Action1..16` | `{slot, every, phase, command}` (`phase` below `every`), written as `<every> <phase> <command>`; `{slot, clear: true}` clears |
| `tempo_threshold` | `BeatSync.TempoThreshold` | BPM change that rewrites the master, 0-10 |
| `lead_ms` | `BeatSync.LeadMs` | 0-200 ms; about 17 puts the console's effect on the beat |

`null` clears a key, so the plugin falls back to its default. Values are written as text, as the plugin reads them,
and an unchanged value is not written. Every written key is read back: `matched` or `mismatched`, with `previous`
and `now`.

After the writes the tool waits 0.7 s, since the plugin reads its configuration every 0.5 s, and includes the
problems a running plugin reports about the changed keys.

`interfaces` (`BeatSync.Interfaces`, the plugin's multicast memberships) is a console network setting. It is refused
and only shown by the status tool.
