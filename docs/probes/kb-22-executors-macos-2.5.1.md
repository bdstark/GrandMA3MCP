# KB-22 live record: executor operations on the console backend (macOS, onPC 2.5.1.0)

Run on 2026-10-10 (local time; the report's timestamps are UTC) against show `mcp-test-disposable` on onPC 2.5.1.0
(`hostType onPC`, user Admin), bridge **0.18.0** with `gma3_mcp_control` **0.5.0**, `gma3_mcp_feedback` 0.5.0 and
`gma3_mcp_hardkeys` 0.10.0 (the set pinned at `0315e18`), started `lua input=keyboard control=console`. Script report:
[kb-22-executors-macos-2.5.1.json](kb-22-executors-macos-2.5.1.json) (`node scripts/kb22-probe.mjs run`, **30/30**; a
first run the same evening scored 27/30 on three probe defects, see below). Every observation came through the bridge
(`control.*`, `feedback.context`, `cmd`, `lua`); nothing was typed on the console.

| Item | Value |
| --- | --- |
| Page | 1 (27 playback executors; 291 was running before the probe and was left alone) |
| Free range (the probe's own assignments) | 180, 181 (empty before and after) |
| Sequences assigned by the probe | Sequence 5527 (at 180), Sequence 5528 (at 181): the fresh assignments came up with KeyPress `Go+`, KeyUnpress empty, Fader `Master`, Encoder `Master`, Master level 100 |
| Operator's executors used | 193 Temp key (Sequence 5529), 201 Flash key (Sequence 2), 195 Toggle key (Sequence 5531), 210 Temp fader (Sequence 5437, level 0); each inactive before, pressed with its Unpress (or Off) registered first |
| Deferred macro | Macro 116 "MCP kb22 deferred" (created and deleted by the probe; fired before the hold, 1.5 s wait) |
| Unqualified key functions on the page | 401, 402 `LearnSpeed` (their `HasActivePlayback` is unavailable: not sequences) |

## What was verified

| # | Check | Result |
| --- | --- | --- |
| 1 | `control.status`: module 0.5.0, a limitation naming Press/Unpress (KB-22) | PASS |
| 2 | console backend capabilities: `targets.executor`, `executorElements { fader, key }`, encoder false; `executorFunctions` keys Flash, Go+, Temp, Toggle, Top; faders Master, Temp | PASS |
| 3 | `feedback.context` lists every playback executor with its functions and activity (or `activeUnavailable`) | PASS |
| 4 | verify: a down on executor 191's **encoder** element is refused `unsupported` ("executor encoders are not served"); a down on 401 (`LearnSpeed`) is refused `unsupported` naming the function; nothing queued or owned | PASS |
| 5 | run: 180 and 181 empty before; `Assign Sequence 5527 At Page 1.180`, `Assign Sequence 5528 At Page 1.181`; both playback targets with Go+ / Master, inactive | PASS |
| 6 | a `button` down on 180's key is admitted and applied as **`Press Page 1.180`**; `lastApplied.result.keyFunction = "Go+"`; Sequence 5527 is active afterwards (the console ran its configured Go+, nothing was translated) | PASS |
| 7 | a `cmd` while the key is held is refused `[busy]` by the bridge | PASS |
| 8 | the release is applied as **`Unpress Page 1.180`**; the instance is idle; the backend counted two applied commands | PASS |
| 9 | `Page 2` / `Page 1` (through `cmd`) neither stops the running Sequence 5527 nor starts page 2's executors (none active there before or after) | PASS |
| 10 | `Off Sequence 5527` ends it (the probe's cleanup for the latching Go+) | PASS |
| 11 | a `touch` on 180's fader is a hold (`busy: touch-down`); a position 0.25 is applied as **`FaderMaster Page 1.180 At 25`** (`faderFunction = "Master"`); the binding reads level 25 | PASS |
| 12 | two positions 0.3, 0.5 in one request: the second **superseded** the first while queued (Master is stateless); `FaderMaster Page 1.180 At 50` was the only command, the level reads 50 | PASS (note) |
| 13 | `FaderMaster Page 1.180 At 100` restores the original level | PASS |
| 14 | **Temp** on 193: `Press Page 1.193` -> active while held; `Unpress Page 1.193` -> inactive; `lastApplied.result.momentary = true` | PASS |
| 15 | **disconnect recovery**: a second connection holds Temp on 193 and drops its socket; the bridge closes its session, the Unpress is issued, 193 is inactive, nothing unresolved | PASS |
| 16 | **Flash** on 201: active while held, inactive after the Unpress | PASS |
| 17 | **Toggle** on 195: a tap (Press, Unpress) starts it, a second tap stops it | PASS |
| 18 | **Temp fader** on 210: `FaderTemp Page 1.210 At 60` reads 60 and starts the playback; `At 20`, `At 0` submitted together are both applied in order (stateful: not superseded) and `At 0` ends it (three applied commands) | PASS |
| 19 | the **encoder** element of 180 is refused `unsupported` | PASS |
| 20 | exploration: `ObjectList("Page 1.181")[1]:Set("Fader", "Rate")` **takes** (read back `Rate` through the Display role); with Rate configured a position is refused `unsupported` naming Rate ("not qualified yet", range 0..100, neutral 50) | PASS (note) |
| 21 | exploration: `FaderRate Page 1.181 At 75` answered OK and the object's `GetFader{FaderRate}` went from 50 to **42.998** (the binding read the same): `At` does not take the GetFader scale for Rate; restored with `At 50`, the property set back to Master | NOTE |
| 22 | **assignment changed while held**: 181 (Sequence 5528, Go+) held; the deferred macro ran `Assign Sequence 5527 At Page 1.181`; the generation moved; the release was admitted but **not issued**: `lastApplied.outcome = "unresolved"`, `reassigned = true`, one `unresolved` record naming Sequence 5528 with `nowAssigned` Sequence 5527 | PASS |
| 23 | `control.recover` keeps it unresolved while the replacement is assigned (nothing issued) | PASS |
| 24 | `Assign Sequence 5528 At Page 1.181` then `control.recover`: **`Unpress Page 1.181`** issued, the record resolved | PASS |
| 25 | cleanup ran every registered undo (deletes, Off, restores, the macro) | PASS |
| 26 | 180 and 181 empty again, page 1 | PASS |
| 27 | no playback the probe touched is left active | PASS |
| 28 | no session, gesture, queued intent or unresolved record left | PASS |

Counting the verify steps the script prints 30 PASS lines (the two capability/status lines, the inventory and the 26
run checks above with the explorations as notes).

## Findings

- The console backend's commands are exactly what the console runs for its own executors: `Press`/`Unpress Page <p>.<e>`
  dispatch the configured KeyPress/KeyUnpress (Go+, Temp, Flash and Toggle behaved as configured), `FaderMaster` /
  `FaderTemp Page <p>.<e> At <level>` place the configured fader function. A Temp fader above 0 is a playback start.
- A fresh `Assign Sequence n At Page 1.180` configures `Go+` / `Master` / `Master` (key / fader / encoder): the console's
  default executor configuration for a sequence.
- The executor's `Fader` property is writable through Lua (`h:Set("Fader", "Rate")`), so function-specific qualification
  does not need a pre-configured executor; but `FaderRate ... At 75` reading back 42.998 means the Rate keyword's `At`
  scale is not the `GetFader` scale (nor a percentage of the travel). Rate stays unqualified (refused `unsupported`
  with this evidence in the reason) until the mapping is measured; Speed and the crossfades were not tried.
- A release after a reassignment is kept rather than issued: nothing operated Sequence 5527 on 181, and `recover()`
  released Sequence 5528 once it was back. The operator-side alternative is `Off <object>`.
- Probe defects fixed between the runs (not console behaviour): the assigned object's `Addr()` is a numeric path
  (`14.14.1.7.5527`) that the command line does not accept, so the first run's `Off 14.14.1.7.5527` did nothing and left
  Sequence 5527 and 5528 running (ended by hand with `Off Sequence 5527` / `5528` before the second run); commands now
  use `Sequence <no>`. The activity check tolerated `activeUnavailable` (the LearnSpeed executors' objects are not
  sequences).

## Not verified here

Rate, Speed, X/XA/XB, CrossFade and Time as fader functions (unqualified, refused); executor encoders (refused); the
physical surfaces (the surface half's record is in mtpnxk); Windows/Linux hosts.
