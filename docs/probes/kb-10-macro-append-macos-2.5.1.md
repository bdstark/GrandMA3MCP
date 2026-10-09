# KB-10 probe: appending keywords and digits through non-executing macros — macOS, onPC 2.5.1.0

Date: 2026-10-09. Evidence for [KEYBOARD.md](../../KEYBOARD.md) "KB-10". Question under test: can a macro line with
`AddToCmdline=Yes` and `Execute=No` build the live command line independently of keyboard-shortcut mappings, without
executing it and without disrupting keyboard entry? Companion to
[kb-10-cmdtext-write-macos-2.5.1.md](kb-10-cmdtext-write-macos-2.5.1.md), which showed `CmdObj().CmdText` is read-only.

**Result: the mechanism works, with three console behaviours a consumer must design around.** The macro text lands
in the editable buffer on the next console frame (never in the same request), is not executed, the caret ends at the
end of the buffer, and keyboard entry continues there with ShCuts off and on. But (1) the console **strips the spaces**
from a macro line's command, so `Thru` is appended with no separator (`Fixture 1Thru`); (2) with a non-empty buffer it
also **removes trailing whitespace** of the existing buffer before appending (`Fixture 1 ` + macro → `Fixture 1Thru`);
with an empty buffer or a selection it produces `Thru ` with a trailing space; (3) the macro **inserts at the caret and
replaces a selection**, then moves the caret to the end. The parser normalises the unspaced form: `Fixture 1Thru5`
executes as `OK: Fixture 1 Thru 5`. Digit insertion is contiguous (`55`, `35`, `53`).

| Item | Value |
| --- | --- |
| Host | macOS 26.5.1 (25F80), onPC 2.5.1.0 Release, hostname `bdsmbpm401`, Apple M4 Pro |
| Show / user / profile | `mcp-test-disposable`, Admin, profile `Default`, Blind on (show default) |
| Keyboard layout | U.S. |
| Displays | built-in 3024×1964 (main) plus two LG HDR 4K 3840×2160; onPC windowed on `LG HDR 4K (1)` |
| ShCuts at start | **off**; toggled on for one pass with F10 and restored to off |
| Bridge / modules | gma3_mcp_bridge 0.8.0 (`lua input=keyboard`), gma3_mcp_hardkeys 0.4.0, gma3_mcp_feedback 0.2.0; repo `df46aef` |
| Preconditions | `ping.input`: 0 holds, 0 unresolved, nothing busy; command line empty; `MASTATE=false` |
| Keyboard | macOS keyboard events delivered to the focused onPC window through desktop control; zoomed screenshots of the command line after every step. No NX-K attached |

## Test macros

Slots **900** and **901** were empty (`ObjectList("Macro 900")` / `901` returned nothing; the pool held 100–111,
5001–6434 and 9950). They were created from Lua on the plugin thread (`Store Macro N /NoConfirmation`, `Label`, one
`Append()`ed line with `Command`, `AddToCmdline=true`, `Execute=false`, `Enabled=true`) and then **inspected in the
Macro Editor** (`Edit Macro 900` / `901` typed on the command line, screenshot of the line table):

| Macro | Line | Command | Wait | Enabled | Add To Cmd | Execute |
| --- | --- | --- | --- | --- | --- | --- |
| 900 "KB10 Thru" | 1 | `Thru` | Follow | Yes | Yes | No |
| 901 "KB10 Digit" | 1 | `5` | Follow | Yes | Yes | No |

Creation was programmatic (the Lua property path), inspection was visual; a macro typed into the editor by hand was not
separately tested. Note from the inspection itself: while the editor had a command cell selected, a click meant for its
close button hit the display icon instead and the next typed text (`Edit Macro 901` + Return) went **into Macro 900's
command cell**, which the editor saved as the line's command. It was restored to `Thru` from Lua and re-verified before
any test step ran. Lesson: close the editor (X at the top right) and re-check the line before trusting it.

Spacing variant: setting the line command to `" Thru "` from Lua stored `Thru`: the console trims the command, so a macro
cannot carry its own separators.

Trigger path: every trigger below is `Cmd("Go+ Macro N")` from Lua on the plugin thread (bridge `lua` op), which is also
the intended invocation path of step 10. A pool-button or executor trigger was not exercised (no macro pool in the
layout), so "manual trigger equals Lua trigger" is not established here; `Go+ Macro` from Lua and from a pool button
both run the macro through the console's macro executor.

## Steps (ShCuts off unless stated)

"Visible" is read from the screenshot, "readback" is `CmdObj().cmdtext`. "Immediate" means the read in the same Lua
chunk as the `Cmd("Go+ Macro …")`; "next frame" means the next bridge request (≥ 1 console frame later).

| # | Step | Visible | Readback |
| --- | --- | --- | --- |
| 1 | Click the command line, type `Fixture 1` | `Fixture 1`, caret at end | `Fixture 1` |
| 2 | `Go+ Macro 900` | — | immediate `Fixture 1`; **next frame `Fixture 1Thru`**; `lastcommand = "OK: Go+ Macro 900"` (the macro ran, the line did not) |
| 3 | Screenshot | `Fixture 1Thru` with the caret after `Thru` | — |
| 4 | Type `5` without touching the mouse | `Fixture 1Thru5`, appended at the caret | — |
| 5 | Backspace, Left ×4, space, End, ` 5` | `Fixture 1 Thru 5`: Backspace, arrows and insertion normal | — |
| 6 | Please | line executes and clears | `lastcommand = "OK: Fixture 1 Thru 5"`, 5 selected |
| 7 | Clear; `Go+ Macro 901` twice in one chunk | `55`, caret at end | immediate `""`; next frame **`55`** (one contiguous number) |
| 8 | Escape; type `3`; `Go+ Macro 901` | `35` | `35` |
| 9 | Escape; `Go+ Macro 901`; type `3` | `53` | — |
| 10 | Escape; type `Fixture 1`; `Go+ Macro 900` then `Go+ Macro 901` in one chunk | `Fixture 1Thru5`, caret at end | immediate `Fixture 1`; next frame `Fixture 1Thru5` |
| 11 | Please on the unspaced line | executes and clears | **`lastcommand = "OK: Fixture 1 Thru 5"`**, 5 selected: the parser accepts `1Thru5` and echoes it spaced |
| 12 | F10 → **ShCuts on** (yellow); key `1` (row 125 NUM1) | `1` | `1` |
| 13 | `Go+ Macro 900` | `1Thru`, caret at end | next frame `1Thru` (no Thru shortcut row exists on the profile; the insertion does not depend on one) |
| 14 | key `5` (NUM5); Please | `1Thru5` → executes | `lastcommand = "OK: Fixture 1 Thru 5"`, 5 selected |
| 15 | `Go+ Macro 901` twice (ShCuts on) | `55` | `55` |
| 16 | Escape; F10 → ShCuts **off** | grey ShCuts, empty line | `""` |
| 17 | **Empty buffer**; `Go+ Macro 900` | `Thru` | next frame **`Thru `** (trailing space) |
| 18 | Escape; type `Fixture 1 ` (**trailing space**); `Go+ Macro 900` | `Fixture 1Thru` | immediate `Fixture 1 `; next frame **`Fixture 1Thru`**: the buffer's trailing space was removed |
| 19 | Type `5` | `Fixture 1Thru5` | — |
| 20 | Escape; type `Fixture 1`; Left ×2 (**caret before ` 1`**); `Go+ Macro 900` | `FixtureThru 1` | next frame **`FixtureThru 1`**: inserted at the caret |
| 21 | Type `Z` | `FixtureThru 1Z`: the caret had moved to the **end** of the buffer | — |
| 22 | Escape; type `Fixture 1`; Shift+Home (**all selected**); `Go+ Macro 900` | `Thru ` with the caret at the end, selection gone | next frame **`Thru `**: the selection was replaced |
| 23 | Type `Z` | `Thru Z` | — |
| 24 | Escape; keyboard icon → **Edit Command pop-up**; type `Group 2` | pop-up field `Group 2`, command line mirrors it | `Group 2` |
| 25 | `Go+ Macro 900` with the pop-up focused | pop-up field **and** command line `Group 2Thru`; pop-up still open; focus still in the pop-up | next frame `Group 2Thru` |
| 26 | Type `3` | `Group 2Thru3` in the pop-up and on the command line | — |
| 27 | Escape (closes the pop-up, text stays), Escape (clears) | empty line | `""` |
| 28 | **Alternation**: type `Fixture 1`; 900; type `2`; 901; type ` + 3`; 900 + 901 | `Fixture 1Thru`, `Fixture 1Thru2`, `Fixture 1Thru25`, `Fixture 1Thru25 + 3`, `Fixture 1Thru25 + 3Thru5` in order; nothing missing, duplicated or reordered; no stray spaces beyond the typed ones; caret at the end after every macro | same |
| 29 | Please | executes and clears | `lastcommand = "OK: Fixture 1 Thru 25 + 3 Thru 5"` |
| 30 | Cleanup: `ClearSelection`, `Delete Macro 900 /NoConfirmation`, `Delete Macro 901 /NoConfirmation` | — | both slots empty again, Macro 100 untouched, `cmdtext ""`, ShCuts off, `MASTATE=false`; show not saved |

## Acceptance report

| Question | Answer |
| --- | --- |
| Keyword insertion preserves the existing buffer and produces usable token spacing? | Preserves the text, **but not its trailing whitespace**, and appends with **no separator** (`Fixture 1Thru`). The parser still interprets it correctly (`OK: Fixture 1 Thru 5`), so the result is usable, not pretty. A macro cannot add spaces (the command is trimmed on store); on an empty buffer or over a selection the console itself emits `Thru ` |
| Repeated digit insertion produces one contiguous number? | **Yes**: `55`, and mixed `35` / `53` |
| Works with ShCuts on and off? | **Yes**, identically; no Thru shortcut row is involved |
| Keyboard entry continues at the expected position without focus/caret repair? | **Yes** when the caret was at the end (the common case). The macro always leaves the caret at the end, so after a mid-line insertion typing continues at the end, not at the insertion point |
| Line remains unexecuted until a separate Please? | **Yes**: `lastcommand` only ever showed `OK: Go+ Macro N` until Return was pressed; `Execute=No` behaves as documented |
| Lua-triggered invocation behaves the same as a manual trigger? | Lua `Cmd("Go+ Macro N")` is the path tested throughout; a pool/executor trigger was not exercised |
| Pop-up behaviour predictable and suitable for command-line-only insertion? | The Edit Command pop-up is a view of the same buffer, so the macro changed both and left focus and the dialog alone. **It does not type into the focused field**: this is command-line insertion only, which is the desired property. Other pop-up text fields were not tested |

Qualification: keyword insertion **passes with the spacing caveat**; digit insertion **passes**.

## Consequences for KB-10

- `AddToCmdline=Yes, Execute=No` macros are a working non-executing insertion path that bypasses the shortcut table
  entirely. The consumer must not rely on a macro for separators: build `1 Thru 5` as digit, Thru-macro, digit and
  accept the `1Thru5` display, or insert the spaces as typed characters.
- Insertion is at the caret (replacing a selection) with the caret moved to the end; a consumer that promises "append
  at the end" must document that a mid-line caret gives a mid-line insertion.
- The effect is asynchronous: verification reads must wait a frame (`feedback.read` polled after the trigger), exactly
  as KB-06 found for `setfader`.
- Creating macros from Lua works and the Macro Editor shows the stored flags, but automatic allocation, cached handles,
  save/reload, cleanup and holds are out of scope here.

## Limitations

- Keyboard events came from desktop control, not a hardware keyboard; no NX-K; one pop-up field (Edit Command).
- The macros were created from Lua, not typed in the editor; manual pool triggering was not exercised.
- Single user, profile, layout and onPC version; screenshots viewed during the run and not stored in the repo.
