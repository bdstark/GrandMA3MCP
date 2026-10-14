# SB-08 probe: timecode shows, events, playback and sources (macOS, onPC 2.5.1)

Evidence for [SB-08 in SHOWS.md](../../SHOWS.md#sb-08--author-and-inspect-timecode-shows) and
[the timecode tools](../tools/timecode.md).

- **Date:** 2026-10-14
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, show `mcp-test-disposable`, bridge 0.24.0 with Lua on for
  the manual pass, 0.25.0 for the tools
- **Method:** a manual pass through `gma3_lua`, `cmd`, `set`, `objects` and `object`, with playback sampled from Node
  every 40 ms; then the tools through `test/live/timecode.live.ts`. Commands that might open a dialog went through
  `CmdIndirect` with `GetTopModal` afterwards; no dialog appeared. Nothing was recorded.
- **Objects:** Timecodes 901 and 902, Sequences 908 and 909, all checked absent first and deleted afterwards. The show had
  no timecode shows. (A stray `DataPool().Macros:Acquire()` during the pass created an empty Macro 1, which was
  deleted at once.)

## The hierarchy

| Level | Class | Address | Created by |
| --- | --- | --- | --- |
| show | Timecode | `Timecode N` | `Store Timecode N /NoConfirmation` (empty) |
| track group | TrackGroup | `Timecode N.G` | `Store Timecode N.G`, or Lua `Append("TrackGroup")`; brings a **MarkerTrack** (No 0) and **one Track** |
| track | Track | `Timecode N.G.T` | `Store Timecode N.G.T`, or `Append("Track")`; brings **one TimeRange** |
| time range | TimeRange | none (no No) | `Store Timecode N.G.T.R` worked once, a deeper store made another range |
| subtrack | CmdSubTrack / FaderSubTrack | none | Lua `Append("CmdSubTrack")`, **only once the track has a target set in an earlier frame** |
| event | CmdEvent | none | Lua `Append("CmdEvent")` on a CmdSubTrack |

- The defaults a new group or track brings exist only from the next frame: in the creating Lua chunk they are not handles
  (no methods). Every structural step is therefore its own bridge request.
- `Acquire(class)` is get-or-create and made extra tracks and ranges; `Append` always creates at the end. Before the
  track had a target, `Append` / `Acquire` / `Create` / `Insert` of a subtrack returned nil.
- **Track target:** `Assign Sequence 908 At Timecode 901.1.1` or Lua `Set("Target", handle)`; the track is renamed
  "&lt;Sequence 908&gt;". `set` with text ("Sequence 908", "908") is silently ignored (it reads `#FFFFFFFFFFFFFFFF`).
  Valid targets (manual): sequence, sound, timecode, timecode slot, preset, group, master.
- **Show properties:** Cursor, Duration (follows the last event a frame later; RawDuration), LoopMode (Loop default /
  Pause / Off), LoopCount, TCSlot, OffsetTCSlot, AutoStart, AutoStop, SwitchOff (Keep Playbacks default / Playbacks Off),
  Goto, AssertPrevEvents (Yes), PlaybackAndRecord (Manual Events / All Events), RestartOption, FrameReadout,
  TimeDisplayFormat, and the methods StartRecording / StopRecording / IsRecording (not called).
- **Track:** Target, Play, Rec. **TimeRange:** Start / RawStart, Duration, Offset, SpeedFactor, Play, Rec.

## Events

- Properties: Name (the token's name), Note, Time / **RawTime** (seconds × 2^24: 2.5 s = 41943040), Type, RealtimeCmd,
  FadeOverride, **Token**, **CueDestination** (a cue handle), **Status**, ExecuteCommand.
- `Set("Time", "1:00")` is 1 s, not a minute; `RawTime` is written exactly. Resolution 1/16777216 s.
- Token by name: Go+, Go-, Goto, Load, On, Off, Toggle, Top, Pause, Kill, Flash, Temp and the rest of
  Enums.AssignmentButtonFunctionsTimecode (Flash, Temp and Swap are accepted though not listed). **An unknown token
  is silently ignored** (the event keeps its token).
- Status On / Off applies to Flash and Temp: the press and the release, named "Flash" and "Flash(Release)".
- **Events keep their storage (append) order**, not time order.

## Playback

`Go Timecode 901` on a show with events stored at 2.0, 1.0, 3.0 (Goto Cue 1), 3.5 (Off), 2.5 s on a three-cue sequence:

| Cursor | Sequence 908 |
| --- | --- |
| 0.98 | Cue 1, running (Go+ at 1.0) |
| 2.00 | Cue 2 (Go+ at 2.0) |
| 2.52 | Cue 3 (Go+ at 2.5) |
| 3.05 | Cue 1 (Goto) |
| 3.50 | off (Off) |
| … 1.03 | Cue 1 again: LoopMode Loop repeats |

- **The show runs events by time**, regardless of storage order.
- **Events at the same time run in storage order**: Goto 3 then Goto 2 at 4.0 s ended on cue 2; Goto 2 then Goto 3 at
  4.5 s ended on cue 3.
- `Off Timecode 901` stops; with the default SwitchOff (Keep Playbacks) the sequence keeps running.
- `Top Timecode 901` sets the cursor to 0. **Writing Cursor (3.9) while stopped seeks**; `Go` then plays from there.
  The events before the cursor were not replayed (AssertPrevEvents Yes: the state they imply, the sequence off after
  3.5 s, matched).
- LoopMode Off stops at the end (cursor 5.00, not playing).
- Flash press at 0.5 s and release at 1.5 s: Sequence 909 ran from 0.55 to 1.53; Temp press / release (2.0 / 2.6 s) the
  same.
- **Deleting the target** (Sequence 909) leaves the track without a target ("Track 1"). The tools' live run showed that the
  console removes the track's command subtrack and its events with it; the track and its time range stay.
- The show reports `HasActivePlayback`; the cursor reads as text with two decimals ("1.60").

## Sources

- **TCSlot** is a number. Writing "Internal" stores **-1**, which is also what a new show holds. 0–15 are slots 1–16, and
  -2 is accepted (the manual's table names -2 Internal and -1 Link Selected; the console's "Internal" is -1). "Slot1" and
  "Selected" as text are ignored.
- The 16 timecode slots are `Root.TimecodeSlots` (class TCSlot): Time / TimeString, generator settings (start, end,
  looped, frame unit), PreRoll, AfterRoll, SourceIP, user bits. **No property shows whether external timecode (SMPTE,
  MIDI, Art-Net) is being received**; `CreatedBy` is about object creation.
- Recording (`Record Timecode N`, StartRecording) was not tried: the tools never record.

## The tools on the console

`test/live/timecode.live.ts` (bridge 0.25.0), 1/1 in 14 s, twice:
- a build refused for a missing sequence, nothing created;
- the show built from out-of-order events (one at 0:00:02:12 at 25 fps = 2.48 s) and read back exactly in time order;
- play: flash press (seen at 0.45 s), Go (1.05), release, Go (2.07), Goto 1 (2.50), Go (3.07), Off (3.48), each matched
  to the sequences' observed changes; LoopMode off stopped at the end;
- rewind and a second play, matched;
- seek to 2.2 s and play: only Goto, Go, Off crossed, matched;
- stop in the middle: not playing, cursor kept;
- Sequence 909 deleted: track 2 reported without a target, its events gone, track 1 untouched;
- replace: the group rebuilt, the show's name and settings kept.

One run had a press seen at cursor 0.43 for an event at 0.5: each sample reads the cursor before the sequences.
