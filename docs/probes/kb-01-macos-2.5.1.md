# KB-01 probe evidence — macOS, onPC 2.5.1.0

Date: 2026-10-09. Status: **complete for macOS**: runs 1–2 on one display, run 3 on two displays with hardware-key
checks. Non-US layouts not run. Windows: see [kb-01-windows-2.5.1.md](kb-01-windows-2.5.1.md).

## Environment

| Item | Value |
| --- | --- |
| onPC | 2.5.1.0 Release, hostType onPC |
| OS | macOS (Darwin 25.5.0), single monitor; onPC window partly off-screen left |
| User / profile | Admin (User 2) / UserProfile 1 "Default" |
| Display | runs 1–2: Display 1 only (built-in screen). Run 3: Display 1 on LG HDR 4K (1), Display 2 on LG HDR 4K (2), built-in screen also attached |
| Show | `mcp-test-disposable` |
| Bridge | gma3_mcp_bridge 0.3.4, Lua enabled, luahook=preserve |
| Probe channel | `gma3_lua` (diagnostic only; no production change) + screenshots |
| OS focus | Claude app frontmost, onPC in background, for all `Keyboard()` tests; onPC frontmost only for OS-keystroke tests 25–27 |
| Keyboard layout | US (system default), not varied |

## API surface

- Live descriptor: `Keyboard(integer:display_index, string:type('press','char','release')[, string:char|keycode, boolean:shift, boolean:ctrl, boolean:alt, boolean:numlock])` → nothing. `KeyboardObj()` → `Root 19.4.1.1.2` "Keyboard 2" (no useful state properties).
- `Enums.KeyboardCodes` (94 entries) are GLFW-style PC key names (`Enter=257`, `Escape=256`, `Backspace=259`, `A=65`, `5=53`, `F1=290`, ...).
- `Enums.VirtualKeyCode` (149 entries) are the MA hardkeys (`PLEASE=84`, `STORE=66`, `ESC=88`, `CLEAR=87`, `OOPS=86`, `MA1=1`, `MA2=2`, `EXEC=35`, ...). **No Lua function accepts a VirtualKeyCode** in the descriptor.

## Key finding: `Keyboard()` is a PC-keyboard emulator, not a hardkey injector

PC keys reach MA keys only through the **per-user-profile KeyboardShortcut table** (`UserProfile 1.13`,
157 entries, editable by the operator; properties `Shortcut`, `KeyCode` (VirtualKeyCode), `ExecutorIndex`, `SpecialExec`).
Relevant default mappings observed:

| PC key | VirtualKeyCode | MA key |
| --- | --- | --- |
| Enter (2 entries) | 84 | PLEASE |
| Escape | 88 | ESC |
| Delete | 87 | CLEAR |
| Backspace, Ctrl+Z | 86 | OOPS/UNDO |
| S | 66 | STORE |
| 0–9 | 67–76 | NUM0–NUM9 |
| Ctrl+F1…F12, Alt+F1…, Ctrl+Alt+F1… | 35 | EXEC with ExecutorIndex 101–112, … |
| (none) | 1, 2 | **MA1, MA2 — unmapped** |

Consequences: hardkey semantics depend on operator-editable profile data and on UI focus; MA combinations are
not reachable by default; "Please"/"MA" are not accepted identifiers — keycodes are `KeyboardCodes` *names*.

## Observations

| # | Action | Expected | Observed | Cleanup |
| --- | --- | --- | --- | --- |
| 1 | `Keyboard(1,'char','5')`, no text field focused | `5` in cmdline | nothing (cmdtext empty, re-read later too) | none |
| 2 | press+release `'5'` | `5` in cmdline | `cmdtext="5"` **synchronously** | — |
| 3 | press+release `'Backspace'` | delete | effect visible only on the **next** request (async); acted as OOPS | — |
| 4 | press+release `'backspace'` (lowercase) | error | silently ignored; names are case-sensitive | — |
| 5 | `Escape` with In&Out menu open | close menu | menu closed, cmdline kept `5`; 2nd Escape cleared cmdline (async) | — |
| 6 | press `'S'`, ~1.5 s, release | Store pop-up | cmdline `Store `, **Store Settings pop-up opened**; stays open after release | Escape ×2 |
| 7 | press+release `'S'` (tap) | `Store` only | `Store ` and no pop-up → long-press distinction works | Escape |
| 8 | `5`, `Enter` | select fixture 5 | SelectionCount 0→1 (PLEASE works) | — |
| 9 | `Delete` | CLEAR | SelectionCount 1→0 | — |
| 10 | click cmdline, then `char 'a'` | text | nothing | — |
| 11 | open Edit Command dialog (keyboard icon), `char a,b,ü` | text | `abü` — Unicode char per call works | — |
| 12 | in dialog: press `'5'`; press `'Backspace'` | — | `5` keycode typed nothing; Backspace deleted `ü` (text edit, not OOPS) | — |
| 13 | Escape in dialog | close | dialog closed; text `ab` left in cmdline, **not executed** | Escape |
| 14 | display 0/2/7/99 with `Q`, type `'bogus'`, code `'NotAKey'` | error | **all accepted silently**. *Correction (run 3, M1):* `Q` maps to SET, which adds no command-line text, so this test could not show an effect; other indexes do deliver keys | — |
| 15 | `555`, plain `Z` (unmapped) | nothing | nothing (checked after a frame) | — |
| 16 | `Z` with ctrl arg (`Keyboard(1,'press','Z',false,true,false,false)`) | OOPS | `555`→`55`, one frame late — **modifier args work** | — |
| 17 | press `LeftCtrl`, tap `Z`, release `LeftCtrl` | OOPS? | nothing — held modifier keys are **not** combined; pass modifiers per event | — |
| 18 | press `S`, tap `5`, (calls later) release `S` | — | `Store Cue 5`; **no** Store pop-up although S was held for seconds (second key cancels long-press) | Escape |
| 19 | stray release `S` (never pressed) | harmless | no effect | — |
| 20 | press `S` twice, release once (held for seconds) | — | single `Store `, no pop-up (duplicate press neither repeats nor long-presses) | Escape |
| 21 | Fixture: `Assign Sequence 2 At Page 1.101`, Key=Flash. Press `F1` with ctrl arg, hold across calls | playback on while held | Sequence 2 active (same call once, next frame once), stays active across calls | — |
| 22 | release `F1` **without** ctrl arg | release | **ignored**, playback stays active (plain F1 is a different shortcut, X1) | — |
| 23 | release `F1` with ctrl arg | release | playback off one frame later — **release must repeat the press's modifiers** | — |
| 24 | 2× press/release Ctrl+Alt+P in one call | double-press (Preview Toggle) | registered as a single press; double-press needs real time between presses | Escape |
| 25 | OS-level Ctrl+F1 tap / 2 s hold to focused onPC (synthetic CGEvent) | exec on | never reached onPC — macOS consumes F1 as a media key; same-key physical/injected test **not possible** with default mappings | — |
| 26 | OS-level `5` to focused onPC | `5` | `5` in cmdline — OS keys reach onPC | Escape |
| 27 | inject press `S` (held), then OS-level `5` | — | `Store Cue 5`, no pop-up — injected and physical events share **one** input/syntax state | release S, Escape |
| — | Cleanup | — | `Unassign Page 1.101` → "OK" but no effect; `Unassign Executor 1.101` → "Cannot Create Object"; `Delete Page 1.101 /NoConfirmation` emptied the executor; Sequence 2 intact | done |

Summary of confirmed capabilities (macOS only): basic keys ✔, PLEASE/ESC/CLEAR/OOPS/STORE via default shortcuts ✔,
held key/long-press ✔, text into focused input ✔ (`char`), background OS focus ✔ (for these tests).
modifier args ✔ (per event only), overlapping holds compose like sequential input ✔, duplicate/stray events harmless ✔.
executor down/up via profile shortcut (`ExecutorIndex`) ✔ — a non-OSC executor hold mechanism, limited to executors
mapped in the profile table. Physical and injected input share one state ✔ (so there is **no ownership isolation**
at the console).
**Not established:** MA1/MA2 or any MA combination; same-key physical-vs-injected release (blocked by macOS F-keys);
double-press; multi-display; Windows; other layouts.

Timing: the same press sometimes lands in the same call and sometimes one frame later (tests 2/3/21); timing is
not deterministic per key, so verification must poll across frames with a bound.

Long-press caveat: the Store hold pop-up appears only for an uninterrupted single hold; another key press or a
duplicate press during the hold suppresses it. A `tap(hold_ms)` must not interleave other events if long-press matters.

Readback: `CmdObj().cmdtext` (= `CMDTEXT`) and `CmdObj().LASTCOMMAND` are readable. Effects may land in the same
call or one frame later, so verification must poll across frames. `Keyboard()` returning is not evidence of effect.

## Second mapping layer: `Root().VirtualKeys`

146 system-level (`IGNORENETWORK`) `VirtualKey` objects, one per MA key: `CODE` (VirtualKeyCode name), `KEYCODE`
(PC key redirect; PLEASE=`Enter`, MA1=`None`), `TOGGLE`, `CANBEPROCESSEDWHILEMODAL`, `USEKEYSTATUSFORLED`, `LEDTOKEN`,
and `VKValue` children holding the action per event (`PRESS`, `RELEASE`, `HOLD`, `DOUBLEPRESS`, `MODIFIER`,
`EXECUTION`). MA combinations are defined here as `MODIFIER=MA1` rows (e.g. STORE+MA1 → `Record`,
HIGHLIGHT+MA1 → `Lowlight`). BLIND/FREEZE/SOLO/PREVIEW are keyword keys (`Blind`, `Freeze`, `Solo`, `Preview`)
with no state on the key object. An operator-provided MA1 mapping could therefore live either in the profile
KeyboardShortcut table or in `VirtualKey.KEYCODE`; neither has been tested.

## Feedback

Method: snapshot of ~160k properties under Root (excluding pools/patch), toggle via `Keyboard()`, diff, toggle back,
diff again. Baseline noise: clocks, `ELAPSEDTIME`, `REALTIMEITERATION`, `Masters.Speed.BPM.NORMEDVALUE`.

| State | Readable source | Scope | Verified |
| --- | --- | --- | --- |
| Command text | `CmdObj().cmdtext` | command line of the plugin's user | ✔ |
| Last command + result | `CmdObj().lastcommand` (`OK: Blind`, …) | command line | ✔ |
| Blind | `ShowData.Masters.Grand.Blind.FADERENABLED` (true = Blind on; red crossed-eye icon) | show-wide grand master | ✔ on/off/on |
| Highlight | `ShowData.Masters.Grand.Highlight.FADERENABLED` (mirrored in profile SpecialExecutors 1–6) | show master | ✔ on/off |
| Solo | `ShowData.Masters.Grand.Solo.FADERENABLED` (mirrored in profile SpecialExecutors 1–6) | show master | ✔ on/off |
| Preview mode | `CurrentProfile().Environments.ACTIVEENVIRONMENT` = `Preview`/`Normal` | user profile | ✔ (entered via Preview+Please, left via `Preview Off`) |
| Preview pending/bar | `Display 1.PREVIEWBARACTIVE` | display | ✔ (set by the Preview key before Please) |
| Freeze | none found — `Freeze` with empty selection changed no property; `Environment.FREEZE` stayed false | — | ✘ unavailable |
| Page | `CurrentExecPage()` | user | ✔ read |
| Executor activity | `Sequence:HasActivePlayback()` | sequence | ✔ |
| Frame counter | `Root().GraphicsRoot.PultCollect[1].MAINLOOPCOUNT` | station | ✔ advances |

Blind was **on** at the start of the session; it was restored to on at the end.

Side effect (explained in follow-up F16): `UserProfile 1.Environments.Normal.Selection.PRESERVEGRIDPOSITIONS` changed false → true
during the final test window (Ctrl+F1 inject/release, OS clicks on the onPC title bar, OS keystrokes, injected S/Escape/B,
`Unassign Page 1.101`). Caused by `Unassign Page 1.101` (see F16); restored to false.


## Recovery

- Stuck injected key: `Keyboard(1,'release','<Name>', shift, ctrl, alt, numlock)` with the same name **and** modifier
  flags as the press; or press and release that physical key (confirmed for Shift, H1–H2).
- Stuck after a shortcut remap or with shortcuts disabled (F12–F13): restore the mapping or press F10, then release
  with the stored tuple.
- Open pop-up/dialog: Escape (physical or injected); repeat to clear the command line.
- Unresponsive plugin: stop and start the bridge per [bridge setup](../setup/bridge.md); worst case restart onPC.
  A restart does not prove an uncertain release succeeded.

## Follow-up run (same day, after KEYBOARD.md review `3983a4f`)

Same environment. Diff helper as above, additionally excluding undo history. Frame waits use `coroutine.yield()`
inside the probe chunk (1 yield = 1 main-loop pass ≈ 12 ms on this host).

| # | Action | Observed |
| --- | --- | --- |
| F1 | `S` with **shift flag** (`Keyboard(1,'press','S',true,…)`) | plain `Store` — the shift *flag* is not MA |
| F2 | press `LeftShift` key (held), tap `S`, release `LeftShift` | `Root().MASTATE` false→true on press; cmdline `Record`; MASTATE true→false on release. **The Shift keys are the MA key** (manual, `do_shortcuts_keyboard.html`: "The Shift keys on the keyboard correspond with the MA keys on the console") |
| F3 | same with `RightShift` | identical (MASTATE, `Record`); no separate MA2 signal observed |
| F4 | press LeftShift + RightShift, release Left, then Right | MASTATE stays true until both are up (per-key counting) |
| F5 | `F10` | toggles `UserProfile.KeyboardShortCuts.KEYBOARDSHORTCUTSACTIVE` (true↔false); F10 works in both states |
| F6 | shortcuts off: `S` keycode; `char 'x'` | `S` does nothing; `x` **typed into the ordinary command line** |
| F7 | shortcuts off: Backspace; `char '5'` + `Enter` | Backspace edits text; Enter executed `Fixture 5` (PLEASE via `VirtualKey.KEYCODE=Enter`, not the shortcut table) |
| F8 | shortcuts off: `Delete` | no CLEAR (selection unchanged) |
| F9 | Freeze (Alt+F) with fixture 5 selected; `Freeze On` command | `lastcommand` `OK: Freeze` / `OK: Freeze On Executor`; deep search (13k objects, any `*FREEZE*` property) found no change. Freeze state remains **unavailable** |
| F10 | Preview (Ctrl+Alt+P) double tap with gaps 0, 4, 8, 10, 16 frames, press held 3 frames | always a single `Preview`; ACTIVEENVIRONMENT unchanged |
| F11 | Help (Ctrl+Alt+H, DOUBLEPRESS = `Menu HelpOverlay`) double tap, 8-frame gap; and OS-level double Ctrl+Alt+H | single `Help` both ways — double-press is **not reachable through keyboard shortcuts** at these timings, injected or OS-delivered |
| F12 | Fixture 1.101 = Seq 2 Flash. Hold Ctrl+F1, then `Set KeyboardShortcut 33 Property "ExecutorIndex" 102`, release stored tuple | **hold not released** (20 frames). Restoring ExecutorIndex 101 and releasing again → released after 1 frame |
| F13 | Hold Ctrl+F1, F10 (shortcuts off), release stored tuple | **hold not released**. F10 on, release again → released |
| F14 | inject `LeftShift` press, OS-level Shift tap | MASTATE true→false — OS release ends injected hold |
| F15 | OS-level Shift held 3.5 s; injected `LeftShift` release mid-hold | MASTATE true→false immediately while the OS key was still down — injected release ends OS hold |
| F16 | `PRESERVEGRIDPOSITIONS` isolation: set false, run `Unassign Page 1.101` | parsed as `OK: Fixture "Unassign" Page 1.101` and set PRESERVEGRIDPOSITIONS true. **Cause reproduced: the cleanup command.** No keyboard step in the follow-up run changed it. Restored to false |

Watcher: none of F1–F15 changed PRESERVEGRIDPOSITIONS (diff watched throughout).

Consequences:

- MA hold/combination is natively available via the Shift *keys* and observable via `Root().MASTATE`. MA1 vs MA2
  are not distinguishable from Lua (one MA state; both Shifts behave identically).
- A hold made through a shortcut cannot be released by its stored tuple after the shortcut is remapped or shortcuts
  are disabled; it is released only once the mapping/enablement is restored. Plain `Enter` (PLEASE) and Shift (MA)
  are not affected by the shortcut table.
- Key state is shared between injected and OS input in both directions (synthetic CGEvents; a hardware-key hold
  was not performed).

Cleanup after follow-up: executor 1.101 deleted; KeyboardShortcut 33 ExecutorIndex 101; shortcuts active;
environment Normal; Blind on (initial state); Highlight/Solo off; selection empty; MASTATE false;
PRESERVEGRIDPOSITIONS false.

## Run 3 — multiple displays and hardware keys (same day)

Three monitors (built-in Retina, LG HDR 4K ×2); onPC shows Display 1 and Display 2 (`GetDisplayByIndex(1..2)`;
`MonitorCollect` lists all three monitors).

| # | Action | Observed |
| --- | --- | --- |
| M1 | `Keyboard(d,'press'/'release','5')` for d = 2, 3, 4, 7, 15, 16, 99, 0, -1 | `5` in the command line for **every** index, including indexes with no display |
| M2 | Edit Command dialog opened on Display 2; `char` via index 1, 2, 9 | `a`, `b`, `c` all typed into the Display 2 dialog |
| M3 | Escape via index 1 with the dialog open on Display 2 | dialog on Display 2 closed |
| M4 | Store long-press (`S` held 110 frames) via index 2 | Store Settings pop-up opened on **Display 1** |
| H1 | Operator held the physical Left Shift (onPC focused); injected `LeftShift` release 1.5 s into the hold | MASTATE true→false at the injected release and stayed false for the rest of the ~6 s physical hold (no auto-repeat re-press) |
| H2 | Injected `LeftShift` press (MASTATE true); operator tapped the physical Left Shift | MASTATE dropped at the physical tap; cleanup release harmless |

Consequences:

- On onPC 2.5.1 `display_index` had **no observed effect** on key routing, text focus, Escape, or pop-up placement.
  Input is not display-specific; the index cannot target a display. Validation can only require an existing
  display (or index 1) and must report that routing is not display-scoped.
- Same-key release across sources is confirmed with a **hardware key** in both directions (H1, H2): a physical
  release ends an injected hold and an injected release ends a physical hold.

Cleanup: command line empty, pop-ups closed, MASTATE false.

## Reproducible script

`scripts/kb01-probe.mjs auto` re-runs the automated subset (26 checks: mapping data, basic keys, modifiers,
overlap, silent acceptance, display index, MA via Shift, Blind/Highlight/Solo/Preview readers, shortcuts
disabled, double-press). Run on this host with two displays: 26/26 passed, state restored
([kb-01-macos-2.5.1.json](kb-01-macos-2.5.1.json)). `longpress`, `type`, `hw-a` and `hw-b` cover the manual checks.
