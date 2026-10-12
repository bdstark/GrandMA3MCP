# KB-25 probe: dialog-free patching and dialog control — macOS, onPC 2.5.1.0

Date: 2026-10-12. Evidence for [DIALOG.md](../../DIALOG.md) "KB-25". Manual pass through `gma3_lua`, then reproduced
by [`scripts/kb25-probe.mjs`](../../scripts/kb25-probe.mjs) `run` ([script report](kb-25-dialogs-macos-2.5.1.json),
35/35; see "Scripted run" below). Questions under test: can fixtures be added,
readdressed, unpatched and deleted, and fixture types imported, through Lua without a dialog? Can a dialog be opened
without blocking the bridge, then read and answered from Lua?

**Result: yes to both, with conditions.**
- Patch changes go through the patch **edit copy**. `CmdIndirect('ChangeDestination "ShowData"."Patch"')` fills
  `ShowData.Patch`. `AddFixtures`, `Set("Patch", …)`, `FixtureTypes`/`Fixtures:Delete(i)` and `Import Library` then
  work on it. `CmdIndirect('ChangeDestination Root')` commits silently, with no "Save and Exit" dialog. A committed
  patch edit cannot be undone with `Oops`.
- `AddFixtures` **does not refuse collisions**: it takes an FID from the fixture that holds it and patches over
  occupied addresses. `CheckFIDCollision` / `CheckDMXCollision` work against the committed patch with the Patch menu
  closed, and are the preflight.
- A dialog opened through `CmdIndirect` leaves the bridge answering. `GetTopModal` / `WaitModal` return it. Its
  title, message, buttons (text, rectangle, enabled) and text fields (`Content`) are readable.
- `Mouse(display, 'move'|'press'|'release', …)` at a button's `AbsRect` centre clicks it.
- `Keyboard(display, 'press', 'Escape' | 'Enter')` cancels or confirms. A text field's `Content` is writable and is
  committed by Enter.

In the manual pass, only `gma3_lua` chunks were used, and every `ChangeDestination` went through `CmdIndirect`. No `cmd` op that could
open a dialog was sent. The bridge's blocking `Cmd()` path was not tested with a dialog on purpose: the SaveShow
stall already established it.

| Item | Value |
| --- | --- |
| Host | macOS, onPC 2.5.1.0 Release, hostname `bdsmbpm401` |
| Show / user | `mcp-test-disposable`, Admin |
| Bridge | gma3_mcp_bridge 0.18.0, Lua on (`luahook=preserve`), hardkeys 0.10.0 / control 0.7.0 / feedback 0.8.0 |
| Screen state | the Executor editor ("Assign Page 1 Executor 111") open on display 1 throughout, left from earlier work; every probe dialog opened on display index 2 (`GetDisplayIndex()`) |
| Probe targets | FID 901–903 and universe 2 (confirmed free before writing), Sequence 951 (confirmed free); all removed at the end |
| Starting patch | 4 grouping fixtures (FID 1–4) holding 22 fixtures (401–412, 501–504, 601–602, 701–704), universe 1 up to 1.374, 6 fixture types |

## Patch structure (read-only)

- `ShowData()` holds `LivePatch` (14.9), `Patch` (14.10) and `PsrPatch` (14.11). With the Patch menu closed and the
  command line at Root, `Patch()` returns `LivePatch`, and `ShowData.Patch` / `PsrPatch` have no children.
- Fixtures live under `LivePatch.Stages[1].Fixtures`, nested under grouping fixtures (`Fixture` class, FID 1–4,
  type "Grouping"). Per fixture: `FID` (number, or the string `"None"` when unset), `CID`, `Name`, `Patch`
  (`"U.AAA"`, `""` when unpatched), `FixtureType` / `Mode` (display role `"6 Mega Hex Par"` / `"3 Ch08"`),
  `ModeDirect`, `Break1`–`Break8`, `ConflitedPatch` [sic], `IsMultiPatch`, plus the 3D position fields. Every
  fixture has `StructureLocked=Yes`.
- DMX modes: `FixtureTypes[n].DMXModes[m]`.

## Patch operations

| # | Step | Observed |
| --- | --- | --- |
| 1 | `AddFixtures{mode, amount=2, fid="901", name, patch={"2.001"}}` with the command line at Root (on `LivePatch`) | returns nil (= failure), nothing created, no error |
| 2 | `CmdIndirect('ChangeDestination "ShowData"."Patch"')`, read in the next request | destination `ShowData.Patch`; `ShowData.Patch` now has 15 children (a copy of the live patch); `Patch()` returns 14.10; no modal. The command line is the shared `Cmdline 1`, so the operator's prompt changes too |
| 3 | `CmdIndirect('ChangeDestination "Stages"."Stage 1"."Fixtures"')` | destination reads `Stage 1.Fixtures` (display role). A guard on that exact string stopped a chunk once before the destination change had landed |
| 4 | Step 1 again, on the copy's mode handle | returns `true`; the copy holds 901 at 2.001 and 902 at **2.009** (the address steps by the footprint); both are named "KB25 Probe" (not numbered); the live patch is unchanged |
| 5 | `CmdIndirect('ChangeDestination Root')` | `OK: ChangeDestination Root`, **no dialog**; 901/902 are in `LivePatch` at 2.001/2.009; `ShowData.Patch` empty again; `ObjectList("Fixture 901 Thru 902")` resolves both |
| 6 | `CmdIndirect("Oops")` | `Failed: Oops`; 901/902 stay. **A committed patch edit has no undo** |
| 7 | Enter again; on the copy `f902:Set("Patch", "2.101")`, `f901:Set("Patch", "")`; commit | live: 901 unpatched, 902 at 2.101; no dialog |
| 8 | `FindBestDMXPatchAddr(patch, start, footprint)` | 0-based absolute addresses in and out: `(lp, 1, 16)` → 374 (= 1.375, the first free after 1.374); after step 7 `(lp, 512, 8)` → 512 (= 2.001). Called on the copy before committing it answered from the committed addresses (528 = 2.017), not the uncommitted edit |
| 9 | `CheckFIDCollision(fid[, count])`, `CheckDMXCollision(mode, "U.AAA"[, count])` on the live patch, menu closed | `true` = free. FID 901 / 401 false; 903, 899×2, 905×5 true. DMX (8 ch): 2.101 false, 2.096 false (overlaps 2.101), 2.001 true, 2.001×12 true, ×13 false, 1.370 false. All correct |
| 10 | In the copy: `AddFixtures{fid="901", patch={"2.201"}}` (FID taken) | returns true. The new fixture **takes FID 901**; the old 901 is left with FID `"None"` |
| 11 | In the copy: `AddFixtures{fid="903", patch={"2.101"}}` (address taken) | returns true; 903 patched at 2.101 over 902; both flagged `ConflitedPatch=Yes` |
| 12 | `Fixtures:Delete(position)` for the four KB25 fixtures (1-based child position, highest first), commit | live patch back to 26 fixtures, FID 901–910 and 2.001–2.064 free |
| 13 | Enter, `ChangeDestination "FixtureTypes"`, `CmdIndirect('Import Library "generic@dimmer.pxml"')` | `OK: Import Library …`, **no dialog**; the copy gains type 7 "Dimmer". The name resolves against the shipped library (`gma3_2.5.1/shared/lib_fixture_types/grandma2`, 11 536 MA2 types; `grandma3` has 171). The user library `gma3_library/fixturetypes` is empty |
| 14 | `FixtureTypes:Delete(7)` on the copy, commit | live patch back to 6 types; `ShowData.Patch` empty; destination Root |

## Dialogs

| # | Step | Observed |
| --- | --- | --- |
| 1 | `Store Sequence 951 Cue 1 /NoConfirmation` (scratch sequence), then `CmdIndirect('Delete Sequence 951')` | returned in 0.02 ms; `OK: Delete Sequence 951` with **no** confirmation (an unused sequence), so it is not a usable test dialog |
| 2 | Recreate 951; `CmdIndirect('Store Sequence 951 Cue 1')` (existing cue, no option) | modal `MsgBox` (class `MessageBox`) on display 2. Readable: `Title` "Store to Cue 1", text "Please choose store mode.", buttons with `Text` Overwrite / Merge / Remove / Release / Cancel and `AbsRect`; title-bar buttons Load/Save Defaults. Button **names are generic** (`Button 3`…`Button 7`): match on text. The bridge kept answering |
| 3 | `Mouse(2, "move", 1165, 602)`, `Mouse(2, "press", "Left")`, `Mouse(2, "release", "Left")` (Cancel centre) in one chunk | next request: modal gone, LastCommand `User Canceled Command: Store Sequence 951 Cue 1` |
| 4 | Reopen; `WaitModal(1)` returns it; title matched, then the same click on Overwrite | modal gone, `OK: Store Sequence 951 Cue 1` (LastCommand does not name the chosen answer) |
| 5 | Reopen; `Keyboard(2, "press"/"release", "Escape")` | modal gone, `User Canceled Command: …` |
| 6 | `CmdIndirect('Label Sequence 951')` | modal `TextInput 3` (class `TextInput`), `Target` "Sequence 951", `Value` current name. Children are only listed after `WaitInit(1)`. Field `LineEdit "InputField"` `Content` = current name; also a Note `TextEdit` and a virtual keyboard |
| 7 | `Keyboard(2, "char", "Z")` | `Content` "Z": the field starts fully selected, so typing replaces it |
| 8 | `InputField:Set("Content", "KB25 SetContent")` | readback in the same chunk and the next request: "KB25 SetContent" (**writable**, unlike `CmdObj().CmdText`) |
| 9 | Escape | `Failed: Label Sequence 951`; name unchanged |
| 10 | Reopen, `Set("Content", "KB25 Renamed")`, `Keyboard(2, "press"/"release", "Return")` | **ignored**: the modal stays open ("Return" is not a key code) |
| 11 | `Keyboard(2, "press"/"release", "Enter")` | modal gone, `OK: Label Sequence 951`, sequence named "KB25 Renamed" |
| 12 | Cleanup `Delete Sequence 951 /NoConfirmation` | deleted; no modal; destination Root |

## Scripted run

`node scripts/kb25-probe.mjs run --out docs/probes/kb-25-dialogs-macos-2.5.1.json` (35/35, about 3 s) repeats the
patch and dialog steps above, except `Oops`, which is never sent: if anything else were undoable it would undo the
operator's work. `verify` (4 checks) is read-only.

- **Preflight refusals:** a show that does not look disposable, Lua disabled, a busy bridge, a command line away from
  Root, an open patch copy (someone in the Patch menu, or an interrupted run), an open modal, existing fixtures named
  "KB25 …", Sequence 951 taken, FID 901–903 or 2.001×32 taken, or a missing DMX mode.
- **Cleanup by identity:** close the probe's own dialog (never another modal), delete the scratch sequence only if
  probe-named, and restore the patch (delete top-level "KB25 …" fixtures and any fixture type not present at the
  start, in the copy, then commit). The last check compares the end state with the start.
- **Configuration:** `KB25_FID`, `KB25_UNIVERSE`, `KB25_SEQ`, `KB25_MODE` (type.mode child indexes, default `6.3`)
  and `KB25_IMPORT`.

Two timing facts the manual pass hid, because it waited seconds between requests:

- **`ConflitedPatch` is computed on a later frame.** Read in the chunk that ran `AddFixtures`, both double-patched
  fixtures say "No"; one request later they say "Yes". A tool must not judge a collision from the same chunk; it
  must use `CheckDMXCollision` beforehand.
- **A `TextInput` is built over a few frames.** The first inspection right after `CmdIndirect('Label …')` had no
  `InputField` (and once a title node "Edit Name"), and a character sent then was lost. The second inspection about
  100 ms later had the field and the title "Label Sequence 951 'KB25 Dialog Probe'". Wait for the field, then type.

The first scripted run also failed `FindBestDMXPatchAddr`. That was the script's own bug: the footprint was passed as
an undefined Lua name, so the function received nil and answered nil. It was fixed, and the console answered 512 as
in the manual pass.

## Operator session (2026-10-12, operator at the console)

Same console and show, with the operator watching and acting at onPC. Every bridge action went through `gma3_lua`
(clicks sent about 6 s after the operator said they were switching to the display, so they could watch).

| # | Step | Observed |
| --- | --- | --- |
| 1 | Bridge: scratch Sequence 951, `CmdIndirect('Store Sequence 951 Cue 1')` | operator saw "Store to Cue 1" on **Display 2** (onPC has Display 1 and 2, both visible); `GetDisplayIndex()` 2 |
| 2 | `Mouse(2, "move", …)` only, wiggled ±40 px over Cancel, then swept across all five button centres | **no cursor is drawn**, but the hover highlight followed the console pointer from button to button: `Mouse` moves the console's own pointer, not the OS cursor |
| 3 | move/press/release at Cancel | the dialog closed on screen; `User Canceled Command: Store Sequence 951 Cue 1` |
| 4 | Operator: opened Edit Command (keyboard icon) and typed `Store Sequence 951 Cue 1`, Please | while typing, the top modal was a `TextInput` titled "Edit Command" on Display 2. The operator's keystrokes also produced an `OK: Oops` (which restored Sequence 951's name to "KB25 Renamed", its name from an earlier run) and a keyboard-shortcuts toggle (left **off**). Then the same "Store to Cue 1" MessageBox on Display 2 |
| 5 | Bridge: matched the title, clicked Cancel | the operator's dialog closed; `User Canceled Command: …`. A dialog the operator opened is read and answered exactly like one the bridge opened |
| 6 | Operator: Menu › Patch on **Display 1** | **the Patch menu does what `ChangeDestination "ShowData"."Patch"` does**: `ShowData.Patch` filled (15 children, 26 fixtures), `Patch()` = 14.10, the shared command line destination `Stage 1.Fixtures`. The menu is an overlay (`FixturePatch`, class `MainDlgFixtureSetup`), not a modal |
| 7 | Bridge: `AddFixtures` "KB25 Menu Test" FID 901 at 2.001 into that copy (after the collision checks) | `true`; the operator **saw the new row in the open Patch grid**; the live patch did not have it |
| 8 | Operator: closed the Patch menu | MessageBox on **Display 1**: title "Leaving the patch", text "Keep changes?", buttons **Save and Exit / Discard and Exit / Stay in Patch** |
| 9 | Bridge: clicked "Discard and Exit" at (900, 615) on Display 1 | menu and dialog closed; copy empty; destination Root; live patch 26 fixtures, no KB25 fixture, FID 901 free. **Discard exists, through the menu's exit dialog**; `Mouse` works on Display 1 |
| 10 | Bridge: `CmdIndirect` into `ShowData.Patch` → `Stage 1.Fixtures` (no menu) | no menu or dialog appeared; the operator's prompt showed the patch path. The operator typed `List`, Please: nothing popped up, and the listing went to the command history, i.e. the operator's commands run in the bridge's patch destination |
| 11 | Bridge: `ChangeDestination Root`, Sequence 951 deleted | `verify` 4/4; Root, no copy, no modal, 26 fixtures, 6 types |

Consequences:
- **The bridge and the operator share one patch copy and one command-line destination.** The bridge entering the
  patch puts the operator's command line there. The operator opening the Patch menu puts the bridge there. Whoever
  leaves commits (`ChangeDestination Root`, or "Save and Exit") everyone's edits.
- A patch tool must refuse to start while the copy is open, as the script does, keep its session short, and treat
  operator typing during it as possible.
- **"Discard and Exit" abandons an edit, but only when the Patch menu is open.** Whether the bridge can discard
  without the menu is open.

## Not covered (for the record)

- Discarding a patch edit without the Patch menu (the menu's "Discard and Exit" works; no menu-free form is known).
- Two physical displays (Display 1 and Display 2 were both onPC windows on one machine).
- `CreateMultiPatch`, sub-fixtures via `parent`, `idtype`/`cid`, layers/classes, multiple breaks.
- GDTF import and importing a type that is already in the show (name clash).
- Whether `CmdIndirectWait` blocks while a dialog is open.
