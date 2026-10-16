# SU-17 probe: ReSync and the tempo-sync plugin (macOS, onPC 2.5.1)

Evidence for [SU-17 in SETUP.md](../../SETUP.md#su-17--resync-and-the-tempo-sync-plugin).

- **Date:** 2026-10-16
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, the throwaway show `NewShow_2026.10.15_23.16.24UTC`,
  bridge 0.35.0
- **Method:** the manual's ReSync page, `test/live/tempo-sync.live.ts`, and the plugin's published interface from
  its repository (BS-02).

## ReSync

The manual (`keyword_resync.html`): ReSync is a playback keyword that synchronizes phasers gradually; the phaser's
starting point is adjusted toward the execution of the command. Syntax `ReSync [Object] [Number]`.

On a running chase, a three-cue Sequence 946 on fixture 101 with 1 s Time triggers and WrapAround, the current cue
was sampled every 40 ms:

| | Cue changes (ms into the watch) |
| --- | --- |
| before ReSync | cue 1 at 18, cue 2 at 1060, cue 3 at 2037 |
| a frame after ReSync | still cue 3, playing |
| after ReSync | cue 1 at 281 (on schedule: cue 3 began about 0.8 s before the watch), cue 2 at 1246, cue 3 at 2248 |

ReSync left the chase's cue and its step timing alone; it does not restart a sequence.
`ReSync Sequence 946 + 1` with Sequence 1 off was accepted, and the read-back reported Sequence 1 as not playing.

## The tempo-sync plugin

- In this show the plugin is not imported: `DataPool.Plugins` holds only the bridge. `gma3_tempo_sync_status`
  reported "not imported" with how to import and start it.
- `BeatSync.Quantum` and `BeatSync.Action16` were written as text, read back exactly, and cleared.
- After a show load the plugin is stopped and its saved status is stale (from the plugin's repository, BS-02). The
  tool judges "running" by State and by the age of `BeatSync.Updated` against the console clock (`show.files`
  `now`).

## Not done here

The plugin's own behaviour (following a session, firing actions) is tested in its repository. These tools only read
and write its variables.
