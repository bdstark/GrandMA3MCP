# KB-01 probe evidence — macOS, onPC 2.5.1.0

Date: 2026-10-09. Status: **complete for macOS / single display**. Windows, multi-display and other layouts not run.

## Environment

| Item | Value |
| --- | --- |
| onPC | 2.5.1.0 Release, hostType onPC |
| OS | macOS (Darwin 25.5.0), single monitor; onPC window partly off-screen left |
| User / profile | Admin (User 2) / UserProfile 1 "Default" |
| Display | `Keyboard()` display_index 1 = "Display 1" (only display present) |
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
| 14 | display 0/2/7/99, type `'bogus'`, code `'NotAKey'` | error | **all accepted silently**, no visible effect on Display 1 | — |
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

Unexplained side effect: `UserProfile 1.Environments.Normal.Selection.PRESERVEGRIDPOSITIONS` changed false → true
during the final test window (Ctrl+F1 inject/release, OS clicks on the onPC title bar, OS keystrokes, injected S/Escape/B,
`Unassign Page 1.101`). Cause not isolated;
not reverted.

## Recovery

- Stuck injected key: `Keyboard(1,'release','<Name>')` for the same name; or press and release that physical key.
- Open pop-up/dialog: Escape (physical or injected); repeat to clear the command line.
- Unresponsive plugin: `Plugin "gma3_mcp_bridge"` restart from the console; worst case restart onPC.
