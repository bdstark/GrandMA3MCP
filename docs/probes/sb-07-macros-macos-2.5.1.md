# SB-07 probe: macro lines, command text, waits and execution (macOS, onPC 2.5.1)

Evidence for [SB-07 in SHOWS.md](../../SHOWS.md#sb-07--author-macros-as-reusable-show-actions) and
[the macro tools](../tools/macros.md).

- **Date:** 2026-10-14
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, show `mcp-test-disposable`, bridge 0.24.0 (Lua on for
  the manual pass; the tools need no new op)
- **Method:** a manual pass through `cmd`, `set`, `objects`, `object`, `children` and `gma3_lua` (`CmdIndirect` for
  any command that might open a dialog, `GetTopModal` afterwards: no dialog appeared), with the run state sampled
  from Node every 100 ms; then the tools through `test/live/macros.live.ts`.
- **Objects:** Macros 901 and 902, checked empty first and deleted afterwards. The show holds 772 macros (StartShow's
  5001–5892 and Macro 100 "bridge reload"), none touched.

## Macros and lines are objects

- A macro (class Macro, `Macro N`) has `Name` (an unnamed macro reads "Macro N"), `Note`, `Lock`, `CLI` (Command Line
  Interaction, Yes by default), Appearance, Scribble, and run-state properties: `LineNo`, `LineName`, `LineCommand`,
  `User` (who last ran it) and `Trigger`.
- Its lines are children of class **MacroLine**, `Macro N.L`, with `Name` (default "MacroLine L"), `Note`, `Command`,
  `Wait` (Enums.MacroLineWait: Follow = 0, Go = -1, or seconds), `Enabled`, `AddToCmdline` and `Execute`.
- StartShow's macros show the range of use: up to 265 lines (5002), several commands per line separated by `;`, and
  `(XFade Position)`, a parenthesised prompt for operator input when the line runs.

## Creating and editing lines

| Command | Result |
| --- | --- |
| `Store Macro 901 /NoConfirmation` | an empty macro (no lines) |
| `Store Macro 901.1 /NoConfirmation` | line 1, empty command, Wait Follow, Enabled Yes, Execute Yes, AddToCmdline No |
| `Store Macro 901.3` with one line | **appended as line 2** (no gap) |
| `Store Macro 901.1` on an existing line | nothing changes |
| `Insert Macro 901.1` | an empty line 1; the others move down |
| `Delete Macro 901.1 /NoConfirmation` | line 1 removed, the rest move up |
| `Move Macro 901.2 At Macro 901.1` | the lines swap (an upward move lands at the target) |
| `Move Macro 901.1 At Macro 901.3` (three lines) | line 1 lands at **2**: a downward move lands one place short, as for recipe lines |
| `set` Command / Wait / Enabled / AddToCmdline / Execute / Name / Note | applied, the reply reads the value back |
| `set Name ""` on a line | the default name "MacroLine L" again |

Default line names follow the position ("MacroLine 1" becomes "MacroLine 2" after an insert above it), so a name equal
to "MacroLine L" is treated as unnamed.

**Lock:** with the macro's `Lock Yes` (reads "UL"), `set` on its lines and on its Name is silently ignored, `Store
Macro 901.9` silently does nothing, and `Delete Macro 901.2` answers "Object locked".

## Command text: what the console stores

The `set` reply, the `objects` read and Lua `Get` agree, and Lua `Set` stores the same as the `set` op.

| Written | Stored |
| --- | --- |
| `Echo "a b"`, `Go+ Sequence 1; Fixture 1 At 50`, `Echo 'single'`, `SetUserVariable "x" "a;b"`, `$myVar At 50` | unchanged |
| `Echo "ümlaut ✓"`, `Label Macro 901 "x\"y"`, a 605-character line, an empty command, `Echo<TAB>tab` | unchanged |
| `Attribute "Dimmer" At (Value)`, `Lua "Printf('hi')"`, `Bogusword 12`, `Echo "a";Echo "b"` | unchanged |
| `  Echo spaced  ` | `Echo spaced`: **leading and trailing spaces are trimmed** |
| `Echo  double  spaces` | `Echo DoubleSpeed spaces`: **runs of spaces collapse and an unquoted word that abbreviates a keyword is expanded** |
| `go+ seq 1`, `fixture 1 thru 5 at 50`, `store cue 5 /merge /nc` | `Go+ Sequence 1`, `Fixture 1 Thru 5 At 50`, `Store Cue 5 /Merge /NoConfirmation` |
| `fix 1 at 50` | `Fix 1 At 50` (the Fix keyword, as the command line would read it) |
| `Echo hello world`, `Echo store the thing`, `Echo a;b` | `Echo hello World`, `Echo Store the thing`, `Echo At;b` |
| `Echo "double  quoted  spaces"` | unchanged: **quoted text is kept exactly** |

So exact text survives a round trip when it is already in the console's form: full keyword names in their spelling,
single spaces, literal text in quotes. Anything else is rewritten into what the command line would execute.

## Waits

| Written | Read (`asText: false`) | Display |
| --- | --- | --- |
| `2`, `2.5`, `0.033`, `1.5s` | 2, 2.5, 0.033, 1.5 | "2.00", "2.50", "0.033", "1.50" |
| `3600`, `100000` | 3600, 100000 | "1h00m00.00", "1d03h46m40.00" |
| `Go`, `go` | "Go" | "Go" |
| `Follow`, `0`, `-1`, `abc` | "Follow" | **an invalid value silently becomes Follow** |
| `0:05` | 0.05 | not minutes:seconds |

The wait comes after the line's command (the manual and KB-14).

## Running

`Go+ Macro 902` on three lines (each `Set Macro 902 Property "Note" "step N"`; line 1 Wait 1.5, line 2 Wait Go):

| Time | Macro state |
| --- | --- |
| 16 ms | `Go+` answered OK (dispatched) |
| 66 ms | LineNo 1, LineName "MacroLine 1", LineCommand = line 1, Note "step 1", User Admin, active |
| 1547 ms | LineNo 2, Note "step 2": the 1.5 s wait, then line 2 |
| … 3548 ms | still LineNo 2: **paused at the Go wait** |
| 3548 ms | a second `Go+ Macro 902` |
| 3582 ms | LineNo "", Note "step 3", not active: finished |

- Each line takes about a frame even with Follow (about 120 ms for three lines).
- **A failing line does not stop the macro**: with line 2 `Bogusword 12`, the run went on to step 3, and nothing in the
  macro's state shows that a line failed.
- A disabled line is skipped, its wait with it.
- `Off Macro 902` stops a paused macro (LineNo ""); the next `Go+` starts at line 1 again.
- `hasActivePlayback` is not reliable mid-run (false while LineNo was 1); LineNo is.
