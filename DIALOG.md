# Dialogs, patching, and setup operations

## Intended behavior

An MCP client can do the setup work an operator normally does in grandMA3's menus and pop-ups (patching
fixtures above all) without a person at the console. Where the console has a data-model operation, the tools
use it and never show a dialog. Where an operation only exists as a dialog, a client can see what dialog is
open, what it says, which controls it offers, and operate one named control, with the outcome read back.

Examples: patch 12 fixtures of mode "Mega Hex Par / 12ch" at FID 501 from universe 2 address 1; move fixture 505
to 3.101; unpatch 501 Thru 512; see that a "Do you want to overwrite?" pop-up is open and answer it.

## Shared architectural requirements

- **Never open a dialog on the plugin thread.** A `Cmd()` that opens a dialog blocks the bridge until a person
  closes it (the `SaveShow /NoConfirmation` stall, [docs/lua.md](docs/lua.md)). Any command that may show a
  dialog is dispatched off the plugin thread (`CmdIndirect` or a macro) or not at all.
- **Prefer the data model to the UI.** Patching is data: fixtures, modes and DMX addresses are objects under
  `ShowData.LivePatch`. Dialog control is the fallback for operations with no data-model path, not the
  default route.
- **Read back every change.** As with cues and executors: one verifiable step at a time, a lost reply is
  `unknown`, nothing is retried, and a step that fails stops the plan.
- **Name the control, not the coordinate.** A dialog action names the dialog (title / class) and the control
  (name or text) and is refused when they no longer match what is on screen. Coordinates are an
  implementation detail recomputed at dispatch.
- **Destructive answers are explicit.** Buttons that delete, overwrite, load, or start a new show are refused
  unless the call names that button. Unpatch and delete tools refuse ranges they cannot verify first.
- **Check before write.** A patch target (FID range, DMX range) is read and confirmed free in its own step
  before anything is written.
- The patch tools run with the bridge's existing user rights (Admin/Setup); nothing here changes the rights
  model or the Lua opt-in.

## KB-25 — Probe dialog-free patching and dialog observation/control

**Request:** Establish, on the live console, which patch operations work through the Lua data model without a
dialog, and whether a dialog can be opened without blocking the bridge, read, and operated.

**Depends on:** Bridge 0.18.0 with Lua enabled; a disposable show.

**Lua changes: Probe scripts only.** No production op or tool changes.

### Starting evidence (read-only, 2026-10-12)

- The Lua API on 2.5.1 has `AddFixtures{mode, amount, fid, cid, name, layer, class, patch={…}, parent,
  insert_index, idtype, undo}`, `FindBestDMXPatchAddr(patch, start, footprint)`, `CreateMultiPatch(fixtures,
  count[, undo])` and `handle:Import(path, file)`.
- `Patch()` answers `LivePatch` with `FixtureTypes` (6 types in the test show), `Stages`, `DmxUniverses`,
  `DmxAddresses`, `IDTypes`, `Layers`, `Classes`.
- `GetTopModal()`, `WaitModal([secs])`, `GetTopOverlay(display)` return UI objects; a walk over `UIChildren()`
  reads each control's class, name, `Text`, `AbsRect {x,y,w,h}`, `IsVisible()`, `IsEnabled()` (tried on an
  open Executor editor: title "Assign Page 1 Executor 111", `LockBtn`, `CloseButton 16`, the tab buttons).
  Grids read through `GridGetDimensions` / `GridGetCellData`.
- Candidate action paths: `Mouse(display, 'move', x, y)` then `'press'` / `'release'`; the existing
  `Keyboard()` injection (Enter, Escape, text); `CmdIndirect` / `CmdIndirectWait` (async command dispatch).
- `CmdObj().CmdText` is read-only and text fields cannot be read back (KB-10), so typed dialog text stays
  unverified unless the dialog exposes it as a property.

### Acceptance criteria

**Patch through the data model (no dialog):**
- Where fixtures live (`Stages[n].Fixtures`, grouping fixtures, `ShowData.LivePatch` vs `Patch()`), and how a
  fixture's FID, CID, name, mode and DMX address read back.
- `AddFixtures` outside the Patch menu: does it change the live patch immediately (output, Fixture sheet,
  selection by `Fixture n`), with and without `patch`, with `amount > 1`, and what it returns on a FID or address
  collision.
- `FindBestDMXPatchAddr`: argument meaning (absolute address = (universe-1)*512 + address) and result for
  free / occupied ranges.
- Readdress and unpatch an existing fixture: `Set` of the fixture's patch property, and the command-line forms
  (`Fixture n Patch …`, `Set Fixture n Property "Patch" …`) through `Cmd`, each checked for a dialog first.
- Delete fixtures: `Delete Fixture n /NoConfirmation` (or the object API), and that IDs and addresses are free
  afterwards.
- Undo: whether `AddFixtures{undo=…}` and the command forms create an undo step `Oops` reverts.
- Whether the Setup › Patch menu being open changes any of the above (`Patch()` vs the live patch while it
  edits a copy).
- Fixture-type import: whether a type from the library (or a GDTF file) can be added to `FixtureTypes` without
  the import dialog (`handle:Import`, `Import Library` command forms).

**Dialogs:**
- `CmdIndirect` of a command that opens a confirmation dialog returns immediately; the bridge keeps answering
  while the dialog is open.
- `GetTopModal` / `WaitModal` see that dialog; its title, message text and buttons are readable.
- Pressing a named button: `Mouse` move/press/release at the button's `AbsRect` centre on onPC (coordinate
  frame, display index, whether the mouse pointer visibly moves, whether a press needs a preceding move);
  Enter / Escape through the keyboard backend as the alternative for the default / cancel answers.
- The dialog's outcome is observable afterwards (modal gone, object changed).
- A text-entry pop-up: whether its edit field's text is readable as a property.
- Behaviour with two displays and with a dialog the operator opened.

**Completion gate:** no patch or dialog tool is built on a form this probe did not verify live. Unverified
forms are recorded as such.

### KB-25 results (first pass, 2026-10-12)

Live on macOS, onPC 2.5.1.0, bridge 0.18.0 with Lua. The record is
[docs/probes/kb-25-dialogs-macos-2.5.1.md](docs/probes/kb-25-dialogs-macos-2.5.1.md). It was a manual pass through
`gma3_lua`, then reproduced by `node scripts/kb25-probe.mjs run --exclusive`
([script report](docs/probes/kb-25-dialogs-macos-2.5.1.json), 55/55; `verify` is read-only). The show was left as it
was found.

**Patching works without a dialog, through the edit copy:**
- `CmdIndirect('ChangeDestination "ShowData"."Patch"')` copies the live patch into `ShowData.Patch` and points
  `Patch()` at it. Edits there are invisible until `CmdIndirect('ChangeDestination Root')`, which commits silently.
  The "Save and Exit" dialog belongs to the Patch menu, not to the destination.
- `AddFixtures` fails (returns nil) outside the copy and returns `true` inside it. Addresses step by the footprint;
  every fixture gets the same name.
- Readdress and unpatch: `Set("Patch", "U.AAA" | "")` on the copy's fixture. Delete: `Fixtures:Delete(position)`.
- Type import: `ChangeDestination "FixtureTypes"` plus `Import Library "<file>"` resolves against the shipped library
  (11 536 MA2 `.pxml` types, 171 MA3 types).
- **No undo:** `Oops` fails after a committed patch edit, so tools must report that a change is permanent and clean
  up by explicit deletion.
- **No collision protection:** `AddFixtures` takes an FID from the fixture that holds it (which is left with FID
  "None") and double-patches occupied addresses (`ConflitedPatch=Yes`, set one frame later).
  `CheckFIDCollision(fid, count)` and `CheckDMXCollision(mode, "U.AAA", count)` are correct against the committed
  patch with the menu closed, and are a mandatory preflight. `FindBestDMXPatchAddr` takes and returns 0-based absolute addresses and also reads the
  committed patch.
- `CmdIndirect` is asynchronous (the change lands next frame), so each step checks the destination before acting on
  the copy. The command line is the operator's `Cmdline 1`, so the patch session is visible to the operator and
  should be short.

**Dialogs can be read and answered:**
- `CmdIndirect` of a dialog-opening command returns at once and the bridge keeps answering. `GetTopModal` and
  `WaitModal(secs)` return the dialog. A `MessageBox` exposes its title, message text and buttons (text, `AbsRect`,
  enabled). Button names are generic, so buttons are identified by their text.
- `Mouse(display, "move", cx, cy)` followed by `"press"` / `"release"` `"Left"` at a button's centre clicks it;
  verified on Cancel and Overwrite.
- `Keyboard(display, "press"/"release", "Escape" | "Enter")` cancels or confirms. `"Return"` is silently ignored.
- A `TextInput` pop-up exposes `Target` and the field `InputField` (`LineEdit`). Its `Content` is readable **and
  writable**; Enter commits it (a sequence was renamed this way). The pop-up is built over a few frames: wait until
  `InputField` exists before reading or typing (a character sent earlier is lost).
- The outcome is readable afterwards: the modal is gone, and LastCommand reads `OK: …` /
  `User Canceled Command: …` / `Failed: …`. LastCommand does not name the chosen button, so the effect is confirmed
  on the target object.

**Operator session** (same day, operator at the console; see the record):
- The bridge's `Mouse` moves the console's own pointer. No cursor is drawn, but hover highlights follow it. Clicks
  work on Display 1 and Display 2.
- A dialog the operator opened is read and answered exactly like a bridge-opened one.
- **The Patch menu and the bridge share one patch copy and one command-line destination.** Opening the menu fills
  the same `ShowData.Patch` and moves the command line. The bridge's added fixture appeared in the operator's open
  Patch grid. The bridge entering the patch shows the patch path in the operator's prompt, and commands the
  operator types run there. Whoever leaves commits everyone's edits.
- Closing the menu with changes shows "Leaving the patch / Keep changes?" with Save and Exit / Discard and Exit /
  Stay in Patch. **Discard and Exit** (clicked by the bridge) dropped the edit. That is the only discard path found
  so far.

**Consequences for KB-26 / KB-27:**
- The patch tools need no dialog control at all. They must refuse while the copy is open (operator in the Patch
  menu) and keep their session short, because the operator's command line is in it.
- KB-27 can identify a dialog by class and title and a control by text, act through `Mouse` (buttons) or
  `Content` + Enter (text), and report from a re-read.
- **Bind dialogs by object, not by title.** Two dialogs can share a title. The probe binds the inspected UI object
  with a `HookDelete` callback, and re-checks the object, the callback and the identity before every input (live:
  the callback fires when a MessageBox closes). KB-27's `press` / `keys` should use the same binding: an
  inspection returns a token, and an action on a token whose dialog closed or was replaced is refused.
- **Detect foreign changes before committing, best-effort only.** Compare a fingerprint of the whole copy with the
  live patch before leaving the patch. That means every collection, every object and every property, minus what the
  console derives: an untouched copy differs only in `STRUCTURELOCKED` / `IGNORENETWORK` and DmxCurves numbering, and
  an added fixture moves only `REALUSED` / `MAXID` / `GRANTED`. It takes about 4 s per side on a small show, so it is
  computed per collection, and that makes it **not a consistent snapshot**: an edit landing after its collection was
  read is missed. The probe therefore requires exclusive console use (`--exclusive`).
- **KB-26 needs exclusion, not just detection.** Patch tools must either require exclusive use, as the probe does, or
  build on a verified change-tracking or locking mechanism. `HookObjectChange` is the candidate, and is untested.
- **Claim only provably created objects.** Claim a created object only once the creating command reported success
  and exactly one attributable object appeared. With a foreign change present, leave the decision to the operator
  (Menu › Patch › Discard / Save).

**Still open** (see the record): a verified way to exclude or track concurrent patch edits (`HookObjectChange`);
discarding a patch edit without the Patch menu; two physical displays;
`CreateMultiPatch`, sub-fixtures, CIDs, breaks; GDTF and duplicate-type import; `CmdIndirectWait`.

## KB-26 — Patch tools

**Request:** Structured MCP tools to inspect and change the patch without dialogs.

**Depends on:** KB-25.

**Lua changes: Likely a `patch.*` op family in the bridge** (or `lua`-free structured ops), plus TypeScript
tools.

### Acceptance criteria

- `gma3_patch_types`: fixture types and their modes with footprint and channel count.
- `gma3_patch_list`: fixtures with FID, CID, name, type, mode, address (universe.address), footprint; filter by
  range.
- `gma3_patch_add`: type + mode, amount, FID start, name, address (explicit or "next free from U.A"); checks the
  FID range and the DMX range are free first and refuses otherwise; reads every created fixture back.
- `gma3_patch_set`: readdress / rename / re-number one fixture or an explicit list; unpatch (address cleared).
- `gma3_patch_remove`: delete explicit fixtures, verified first; ranges only when each member is read first.
- Type import only if KB-25 found a dialog-free path.
- Live test on the disposable show in a free FID range, cleaning up after itself; docs in `docs/tools/patch.md`.

### KB-26 results (2026-10-13)

Bridge 0.19.0 (`patch.*` ops) and five MCP tools. Details are in [docs/tools/patch.md](docs/tools/patch.md).

| Criterion | Status |
| --- | --- |
| `gma3_patch_types` | done: types and modes with footprint, number of breaks, channels per break |
| `gma3_patch_list` | done: all stages, sub-fixtures, FID / CID / ID type / type / mode / address / breaks; FID range and pagination |
| `gma3_patch_add` | done: type + mode by number or name, count, FID start, name, explicit address or first free block (`findFreeFrom`); FID and DMX ranges pre-checked (block inside one universe); every created fixture read back |
| `gma3_patch_set` | readdress / unpatch / rename done (swaps and moves across a fixture's own range work); **re-numbering not done** (FID changes untested live) |
| `gma3_patch_remove` | done for explicit FIDs, each checked first; fixtures with sub-fixtures refused |
| Type import | **not done**: the dialog-free path exists (KB-25), but claiming the imported type needs the ownership rule; left for a follow-up |
| Live test | done: `test/live/patch.live.ts`, 1/1 in 31 s (four committed sessions) |

**Concurrency, as decided:** every change tool requires `exclusive: true`. The isolation check (whole-patch
fingerprints of copy and live, minus the touched FIDs) is best-effort detection.

`HookObjectChange` was probed as an alternative and is not recursive. It fires for the hooked object's own properties
and for children added directly under it, not for deeper edits, so watching the whole patch would need about 3,200
hooks. Live patch fixtures also accept `Set()` outside patch mode.

**Console findings from the live run (onPC 2.5.1):**
- **`DMXFootprint` read raw is a Lua table.** Only the display role gives the `"first,last"` text per break. The first
  install parsed the table's address text and reported wrong breaks. The harness mock now returns a table too, so
  that regression is covered.
- **`AddFixtures` does not always step the address for every fixture of a block.** Two 18-channel fixtures at 3.001
  patched only the first. In KB-25, two 8-channel fixtures at 2.001 had patched both.
  - The first live run's `patch.add` noticed the unpatched second fixture, deleted both from the copy, and the tool
    closed the unchanged copy. Nothing was committed.
  - `patch.add` now patches any block member that is not at its expected address with `Set("Patch")` (reported as
    `patchedByBridge`), then verifies every address exactly.
  - Since bridge 0.25.2 `patch.add` makes one `AddFixtures` call per fixture instead: an amount-4 add of a mode with
    cells crashed onPC inside `AddFixtures` (2026-10-14, [SETUP.md](SETUP.md) SU-02). The `Set("Patch")` fix-up
    stays as a safety net.
- **Cost:** the bridge fingerprints one side in about 3.7 s (FixtureTypes 1.7 s, DmxUniverses 1.0 s, AttributeDefinitions
  0.7 s). A change session therefore takes about 8 s, and the four sessions of the live test took 31 s.
- **A fresh fixture-type import made the copy differ (bridge 0.25.1).** In a new show with five grandMA2 types
  just imported (2026-10-14), the first `gma3_patch_add` failed its isolation check on FixtureTypes and
  AttributeDefinitions although nobody else touched the show. A property-by-property diff of the open copy against
  the live patch found two console-derived differences, and nothing else in 3,765 objects:
  - 29 imported attributes: `ATTRIBUTEINDEXOLD` unset (`4294967295`) live, numbered (346–374) in the copy.
  - 7 `FTSubfixture` rows in DMX modes' `SubfixtureOverview`: the copy renumbers the geometry they reference.
  - Bridge 0.25.1 leaves out that property and the `SubfixtureOverview` class. The geometries themselves stay in
    the fingerprint.

## KB-27 — Dialog inspection and control

**Request:** Let a client see and operate whatever dialog is open, for operations with no data-model path.

**Depends on:** KB-25.

### Acceptance criteria

- `gma3_dialog inspect`: per display, the top modal / overlay as a bounded tree of visible controls (class,
  name, text, enabled, rect), grid contents where present; read-only and allowed while input is owned.
- `gma3_dialog press`: dialog identity + control name/text; re-read and matched immediately before dispatch;
  refused when the dialog changed, the control is hidden/disabled, or the button is destructive and not named
  explicitly; outcome reported from a re-read (dialog closed / still open / changed), never assumed.
- `gma3_dialog keys`: Enter / Escape / text into the focused dialog through the existing input path, with the
  same identity check.
- Commands that may open a dialog are dispatched off the plugin thread; the result says a dialog opened and
  returns its inspection.
- Respect the input ownership / busy model: a dialog action is an input action.
