# KB-10 probe: appending text through `CmdObj().CmdText` — macOS, onPC 2.5.1.0

Date: 2026-10-09. Evidence for [KEYBOARD.md](../../KEYBOARD.md) "KB-10". Question under test: does writing
`CmdObj().CmdText` from Lua change the live, editable command-line buffer without executing it, so that keyboard
entry can continue at the expected caret position?

**Result: the property is not writable.** Plain assignment, `Set("CmdText", ...)` and every spelling variant return
without error and change nothing: the buffer read back immediately, one console frame later and after several seconds
is the text that was there before, and the visible command line never changed either. Because no write ever reached
the buffer, there is no scripted text to continue from; the caret, focus and editing checks below therefore show that
the write is a complete no-op (it does not move the caret, clear a selection, steal focus from a pop-up or disturb
the operator's text) rather than a working append. The probe never executed the line (`lastcommand` unchanged until
the operator-style Please in step 9).

| Item | Value |
| --- | --- |
| Host | macOS 26.5.1 (25F80), onPC 2.5.1.0 Release, hostname `bdsmbpm401`, Apple M4 Pro |
| Show / user / profile | `mcp-test-disposable`, Admin, profile `Default`, Blind on (show default) |
| Keyboard layout | U.S. |
| Displays | built-in 3024×1964 (main) plus two LG HDR 4K 3840×2160; the onPC window sits on `LG HDR 4K (1)`, windowed, not full screen |
| ShCuts at start | **off** (`KEYBOARDSHORTCUTSACTIVE=false`); unchanged by the probe; off at the end |
| Bridge / modules | gma3_mcp_bridge 0.8.0 (`lua input=keyboard`), gma3_mcp_hardkeys 0.4.0, gma3_mcp_feedback 0.2.0; repo `df46aef` |
| Invocation | Lua chunks sent through the bridge `lua` op (`gma3_lua`), running on the plugin thread; no plugin pool button, no pop-up; the invocation never changed focus (typing continued in the same element every time) |
| Keyboard | pass A: console key injection (`gma3_type`, the KB-05 text path); pass B: macOS keyboard events delivered to the focused onPC window through desktop control (screenshots of the command line after every step). No NX-K was connected |
| Preconditions | `ping.input`: 0 holds, 0 unresolved, nothing busy; command line empty; `MASTATE=false` |

## Property surface

`CmdObj()` lists `CMDTEXT`, `LASTCOMMAND`, `LASTCOMMANDEXECUTIONTIME`, `LASTCOMMANDSENDTIME` and `CLEARCMD` among
its 30 property names. `CmdText`, `cmdtext` and `Get("CmdText")` all return the same string. `PropertyInfo` and
`PropertyType` are not available on the handle (nil), so read-only status cannot be queried; it is established by
the write attempts below.

## Pass A: console key injection, readback only

Desktop control was declined at first, so pass A used the console's own key injection (`Keyboard()` text events
through the hardkeys module, `gma3_type` with `context=command-line`), the path KB-05 verified live.

| # | Step | Observed |
| --- | --- | --- |
| 1 | Type `Fixture 1` (ShCuts off), read back | `cmdtext == "Fixture 1"`, not executed |
| 2 | Candidate operation verbatim: `cmdLine.CmdText = "Fixture 1 Thru "` inside `pcall` | `pcall` ok, error nil; **immediate readback `"Fixture 1"`**; `Get("CmdText")` `"Fixture 1"` |
| 3 | Read after a console frame (next request, ~1 s later) | `"Fixture 1"`: nothing persisted because nothing changed |
| 4 | Alternative setters on the same buffer: `Set("CmdText", ...)`, `Set("CMDTEXT", ...)`, `.cmdtext = ...`, `.CMDTEXT = ...` | all accepted (ok, nil error, `Set` returns nothing); readback `"Fixture 1"` after each |
| 5 | Continuation check: inject `5` | `"Fixture 15"`: the buffer was untouched and the caret was still at the end of the operator's text; the scripted `Thru ` never existed |
| 6 | Escape; write `Thru ` into the **empty** buffer (assignment and `Set`) | readback `""` both times |
| 7 | Type `Fixture 1 ` (trailing space); append `Thru `; then assign an unrelated value `Group 7` | readback `"Fixture 1 "` after both writes (rules out a same-prefix masking effect) |
| 8 | Escape; state | `cmdtext == ""`, `lastcommand` unchanged, ShCuts off, `MASTATE=false`, 0 holds |

## Pass B: real keyboard events and screenshots

Desktop control was granted afterwards. onPC exposes no accessibility windows, so the window was driven full-screen:
a click on the command line, macOS keyboard events, and a zoomed screenshot of the command line after each step.
"Visible" below means read from the screenshot; "readback" means `CmdObj().cmdtext` through the bridge.

| # | Step | Visible | Readback |
| --- | --- | --- | --- |
| 1 | ShCuts off (grey). Click the command line, type `Fixture 1` | `Admin[Fixture]>Fixture 1` with the caret after the `1` | `Fixture 1` |
| 2 | Candidate operation (assignment + `Set`) with the caret at the end | **unchanged**: `Fixture 1`, caret still after the `1` | `Fixture 1` |
| 3 | Type `5` without touching the mouse | `Fixture 15`, the digit appended at the caret, not at the start | `Fixture 15` |
| 4 | Backspace, Left ×2, type `X` | `FixtureX 1`, caret after the `X`: Backspace, arrows and insertion behave normally | `FixtureX 1` |
| 5 | Candidate operation with the **caret in the middle** | unchanged, caret stays after the `X` | `FixtureX 1` |
| 6 | Shift+Home (selects `FixtureX`), candidate operation | selection highlight still present, text unchanged | `FixtureX 1` |
| 7 | Type `Q` into the selection | `Q 1`: the selection was replaced as the console normally does; the write had not touched it | — |
| 8 | Escape, type `Fixture 1 Thru 5` physically, Please | line executes and clears | `lastcommand = "OK: Fixture 1 Thru 5"`, 5 fixtures selected (the parser accepted the physically typed range; nothing scripted was involved) |
| 9 | F10 → ShCuts **on** (yellow). Active digit rows on profile `Default`: 124–133 map `0`–`9` to `NUM0`–`NUM9` (KeyCode 67–76), no `T`/`Thru` row | a macOS text-insert event for `1` did nothing; a key event for `1` put `1` on the line (via the NUM1 shortcut) | `1` |
| 10 | Candidate operation with ShCuts on | unchanged `1` | `1` |
| 11 | Key `5` | `15` | — |
| 12 | Escape, F10 → ShCuts **off** again (restored to the starting state) | grey ShCuts, empty line | `""`, `KEYBOARDSHORTCUTSACTIVE=false` |
| 13 | Click the keyboard icon left of the command line → **Edit Command pop-up**; type `Group 2` | the pop-up field shows `Admin[Fixture]>Group 2` with the caret; the command line mirrors it (`Group 2`) | `Group 2` |
| 14 | Candidate operation with the pop-up focused | pop-up and command line unchanged; focus stayed in the pop-up | `Group 2` |
| 15 | Type `3` | `Group 23` in the pop-up, mirrored on the command line: subsequent typing still went to the pop-up field | — |
| 16 | Escape (closes the pop-up; the text stays on the command line), Escape again | empty line | `""` |
| 17 | Alternating: type `1`, write, type `2`, write, type `3` | `1`, `12`, `123` in order: no missing, duplicated or reordered characters | `1`, `12`, `123` |
| 18 | Escape, `ClearSelection` | empty line; 0 selected; ShCuts off; `MASTATE=false`; nothing saved | `""` |

NX-K continuation (step 5 of the written procedure) was not possible: no NX-K is attached to this machine. The
Edit Command pop-up is the only pop-up text field exercised; it is bound to the command line, so an independent
text field (for example a label editor) remains unexercised.

## Acceptance report

| Question | Answer |
| --- | --- |
| Is the property writable? | **No.** Writes are silently ignored (no error, no change) on onPC 2.5.1.0 |
| Does the visible/editable buffer change? | **No**, by readback and on screen: the command line, the caret, an active selection and the Edit Command pop-up are all exactly as before the write |
| Does the command stay unexecuted? | Yes: `lastcommand` unchanged throughout; nothing was executed by the probe |
| Does manual typing continue correctly? | Typing continues normally, but on the operator's own text: the caret stays where it was (end, middle or on a selection), focus stays where it was (command line or pop-up). There is no scripted text to continue from, so this is not a pass for seamless continuation of an append; it is evidence that the write is inert |

## Consequences for KB-10

- `CmdObj().CmdText` is a **read-only feedback source** (as KB-06 uses it). It cannot be used to insert `Thru` or any
  other token into the command line. Key/character injection remains available as in KB-05; the separate
  [macro probe](kb-10-macro-append-macos-2.5.1.md) also demonstrated non-executing insertion. Neither result
  establishes programmatic Quickey press/release, which is the revised KB-10 probe target.
- No caret-restoration or focus API was proposed or tested here; nothing in this record supports one.
- Clearing a line programmatically still requires an Escape key event (verified) or the `CLEARCMD` property, which was
  not exercised because the probe needed the line preserved.

## Side observations (not the question under test)

- With ShCuts on, a macOS text-insertion event for `1` did nothing while a key-down/up event for `1` reached the
  NUM1 shortcut and put `1` on the line. With ShCuts off both forms typed the character. Relevant to how a surface or
  automation delivers "typing" to onPC; not investigated further.
- The Edit Command pop-up is a view of the command-line buffer: typing in it updates the command line live, and Escape
  closes the pop-up without clearing the line.

## Limitations

- "Physical keyboard" means macOS keyboard events delivered by desktop control to the focused onPC window, not key
  presses on a hardware keyboard; no NX-K was available. The screenshots were viewed during the run and are not stored
  in the repo (the probe records keep text evidence only).
- One pop-up field (Edit Command, bound to the command line); no independent text field.
- Single user, single profile, US layout, one onPC version, windowed onPC on an external 4K display. Nothing here was
  saved to the show.
