# SB-01 probe: executor functions, sequence settings, locks and a looping chase (macOS, onPC 2.5.1)

Evidence for [SB-01 in SHOWS.md](../../SHOWS.md#sb-01--configure-executor-assignments-and-sequence-playback) and
[the playback tools](../tools/playback.md).

- **Date:** 2026-10-13
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, show `mcp-test-disposable`, bridge 0.18.0 (Lua on)
- **Method:** a manual pass of single bridge requests (`cmd`, `set`, `objects`, `object`, `children`, and `lua` only
  to read `CurrentCue` / `HasActivePlayback` quickly), then the tools themselves through
  `test/live/playback.live.ts` (1/1, 12.8 s), which reproduces every behaviour the tools rely on without Lua.
- **Objects:** Sequence 9001 (three empty cues), executors Page 1.280 and 1.281 (checked empty, each in its own
  read, before assigning), a scratch Page 91; all deleted afterwards. The live test uses Sequence 905 and Page
  90.210/90.211.

## Property writes

| Write (through `set`, then read back) | Result |
| --- | --- |
| `Page 1.280 KeyPress` = Temp, Flash, Swap, Black, Toggle, Time, SelectFixtures, Go+ | applied |
| `KeyPress` = Call, LogIn, At | **applied** although none applies to a sequence |
| `KeyPress` = "Bogus" | **silently ignored** (kept the previous value) |
| `KeyUnpress` = Off, Call; = Empty or "" | applied; Empty reads "" |
| `Fader` = Temp, X, Rate, Speed, Time, Master, Empty | applied |
| `Fader` = "Bogus", "Highlight" | silently ignored |
| `EncoderLeft` = Go-; = Flash, Temp | applied; **Flash and Temp silently ignored** (manual: greyed out for encoders) |
| `Sequence 9001 WrapAround` = No / Yes, `Priority` = High / LTP, `RestartMode` = Current Cue / Next Cue / First Cue, `MasterGoMode` = Go / None | applied |
| `WrapAround` = "Off" / "Bogus", `Priority` = "Bogus" | ignored (old value kept) |

`Enums.AssignmentButtonFunctionsSequence` lists neither Flash, Temp, Swap, Black nor Time, but the console accepts
them on keys (executor 201 of the show already used Flash). The console therefore does not tell a valid
function for a sequence from an invalid one; the tools keep their own lists and check every `set` reply.

A fresh `Assign Sequence n At Page 1.280` gave KeyPress Go+, KeyUnpress empty, Fader Master, Encoder Master,
Fix No, ExecutorConfiguration DefaultSequence. Sequence defaults: Wrap Around Yes, Priority LTP, Restart Mode First
Cue, Release First Cue Yes, Auto Start/Stop Yes, Master Go Mode None, Off When Overridden Yes, Kill/Swap Protect No.

## Locks

| Case | Result |
| --- | --- |
| `set Sequence 9001 Lock Yes` | Lock reads `UL` (unlocked reads `""`) |
| locked sequence: `set WrapAround No` | silently ignored |
| locked sequence: `Store Sequence 9001 Cue 4 /NoConfirmation` | "Cannot Create Object" |
| `set Page 1.280 Lock Yes`, then `set KeyPress Temp` | silently ignored |
| locked executor: `Assign Toggle At Page 1.280` | "Illegal object" (unlocked: OK) |
| `set Page 91 Lock Yes` (scratch page), then `set Page 91.201 KeyPress Toggle` | silently ignored (the executor's own Lock still reads "") |
| locked page: `Assign Sequence 9001 At Page 91.202` | "Cannot Create Object" |
| locked page: `set Sequence 9001 Priority High` | applied (a page lock does not protect the sequence) |
| `set ... Lock No` on each | unlocked; writes take effect again |

Page `Lock` is a writable YesNo property, like the executor's and the sequence's. `StructureLocked` and
`SystemLocked` are read-only on all three.

## Playback

- Configuring KeyPress Temp / Flash, Fader, WrapAround and Priority never changed `HasActivePlayback` (false).
- Temp key: `Press Page 1.280` → active (the chase advanced to cue 2 within 0.7 s); `Unpress` → inactive. Flash
  the same.
- Chase: cues 1, 2 and 3 with `TrigType Time`, `TrigTime 0.5` (set on the Cue objects). `Go+ Sequence 9001` with
  Wrap Around Yes: 1 (0.10 s) → 2 (0.62) → 3 (1.03) → 1 (1.54) → 2 → 3 → 1 (3.09) → 2 → 3 (4.10), still running at
  4.5 s. With Wrap Around No: 1 → 2 → 3 and it stays on cue 3, active, until `Off`. The live test repeated both
  through the tools (three cycles in 4.1 s; 1 → 2 → 3 without wrap).
- In Lua, `CurrentCue` `.no` is the cue number × 1000 (1000 = cue 1); through `objects` with `asText: false` it is a
  Cue handle whose `name` is the cue name.

## Executors sharing a sequence

`children DataPool.Pages` (5 pages) plus one `children <page addr>` with fields `No`, `Object` (`asText: false`) per
page found both executors holding Sequence 9001 (1.280, 1.281) by comparing the Object address, in about 0.1 s.
Page `No` reads `"1 (390)"` in the display role; the numeric prefix is the page number.

## Incident: a range read stopped the console

Before this probe, two read-only `objects` requests sent through the MCP tools back to back, `Page 1.180 Thru 1.190`
(fields Object, Key, Fader; all empty executors) and `Sequence 9000 Thru 9999` (no such sequences), never
returned. The bridge stopped answering, the onPC UI ignored clicks, and onPC's watchdog file afterwards read
`DataBase;Graphics;`; onPC had to be relaunched. The cause was isolated afterwards in
[objectlist-hang-macos-2.5.1.md](objectlist-hang-macos-2.5.1.md): `ObjectList` over an executor range never returns
(bridge 0.20.0 no longer sends page/executor ranges to it). The SB-01 tools read single objects and page children
only, never `Thru` ranges.
