# Groups with selection grids, and MAtricks (SB-02)

Four tools describe fixture arrangements and distribution rules numerically: a group is a list of fixtures with
explicit selection-grid cells, and a MAtricks object is a set of per-axis rules (wings, blocks, groups, fade, delay,
phase, speed). They need bridge **0.21.0**, which adds two read-only ops (`group.read`, `selection.grid`, see
[the bridge protocol](../reference.md#selection-grid-reads-plugin-v0210-sb-02)); creation uses only existing command
and property operations, and nothing needs `gma3_lua`. Evidence: [the SB-02 probe record](../probes/sb-02-groups-macos-2.5.1.md).

| Tool | Changes | Selection / programmer |
| --- | --- | --- |
| `gma3_selection_grid` | nothing (read-only) | untouched: a group is read from its stored data, not recalled |
| `gma3_store_group` | creates or overwrites one group (fixtures, cells, PreserveGridPositions, name) | **clears and rebuilds the selection** and moves the grid cursor; programmer values are kept; requires `exclusive: true` |
| `gma3_matricks` | nothing (read-only) | untouched |
| `gma3_configure_matricks` | creates or updates one MAtricks pool object | untouched (the programmer's selection MAtricks is never written) |

## The things to know first

- **Selection-grid cells are not stage positions.** The selection grid is the relative arrangement MAtricks,
  phasers and `At a Thru b` distribute over. It is independent of where the fixtures are in the 3D stage; these
  tools never read or write physical positions.
- **The cells are the order.** The live selection lists fixtures in the order they were selected, but `Store Group`
  keeps a group in **patch order** (subfixture index), and a recall returns that order. Distributions follow the
  cells: `At 0 Thru 100` ramps along grid X whatever order the fixtures were listed or selected in. So the tools
  place every fixture on its own cell and compare results fixture by fixture, never by list position. To change
  which fixture comes first in a distribution, change its cell.
- **Each fixture gets its own `Grid x/y/z` command.** `Grid` moves the grid cursor and the next `Fixture <id>` lands
  on it. A range selected at one cursor follows the user's *Move Grid Cursor* setting (Append X, New Line, None), so
  the tool never relies on it. `Grid` and `Fixture` on one command line place nothing; they are separate commands.
- **Re-selecting a fixture is silently ignored**: it keeps its first cell. Duplicates are therefore refused.
  Two fixtures **may share a cell** (then MAtricks treats them as one position): refused unless
  `allow_shared_cells: true`. **Gaps and negative cells** are kept. A multi-instance fixture (501) and its cells
  (501.1, 501.2) are separate selection items; listing both is allowed and reported as a warning.
- **Recalling a group adds the grid cursor** to its stored cells. The tools recall at `Grid 0/0/0`.
  **PreserveGridPositions** (stored with the group) decides whether gaps and the offset from 0/0/0 survive a recall at
  the origin; with it off they are compacted. `gma3_store_group` sets it explicitly (default on).
- **Store Group on an existing group overwrites it** (with or without `/Overwrite`) and keeps its name. `/Merge`
  shifts and reorders cells, so the tool always stores the complete list. A locked group answers "Object locked" and
  silently ignores a rename; the tools refuse it.
- **`Store MAtricks` copies the programmer's selection MAtricks.** A new MAtricks object would inherit whatever wings,
  groups or fades are active on the selection, so `gma3_configure_matricks` reads the new object right after `Store`
  and writes every property that differs from the request.
- **MAtricks values the console does not accept are silently ignored** (`XWings -1`, `DelayToX "bogus"`); 0 reads as
  None. Every value is one `set` whose reply must read back the requested value.

## `gma3_selection_grid`

`{ group?: number }`. With `group`: one `group.read` request returns the group's stored fixtures (in the console's
stored order, i.e. patch order), each with `fixture` (FID, or the dotted cell id `501.1` for a cell without its own
FID), `path` when it has another dotted id (a cell with its own FID, a fixture inside a grouping fixture), `name`,
`x`, `y`, `z`, plus `name`, `locked`, `preserveGridPositions`, `sharedCells`, `bounds` and `gaps` (empty
cells in the bounding box). Nothing is selected. Without `group`: one `selection.grid` request returns the current
selection in the order it was selected, with the cells `SelectionNext` reports; with MAtricks active on the selection
these are the **transformed** cells (with `XWings 2`, X runs 0 1 2 3 3 2 1 0). Entries the bridge could not read are
listed as `unreadable`, never dropped.

## `gma3_store_group`

Parameters: `group` (1–9999), `name?`, exactly one of `items` / `arrangement`, `overwrite?`,
`preserve_grid_positions?` (default true), `allow_shared_cells?`, `exclusive` (required unless `preview`), `preview?`,
`verify?` (default true).

- **`items`**: `[{fixture, x, y, z?}]`, fixture as `401` or `"501.1"` (a FID 1–99999999, then up to 7 cell numbers
  1–99999), integer cells −9999..9999, z default 0.
- **`arrangement`** helpers, expanded into the same list (see it with `preview: true`). Fixture lists accept ids and
  `"a Thru b"` ranges within one level (`"401 Thru 404"`, `"501.1 Thru 501.12"`):
  - `{type: "row", fixtures, origin?, step? (default 1, negative runs backwards), axis? ("x" | "y" | "z")}`
  - `{type: "rectangle", fixtures, columns, origin?, step_x?, step_y?, serpentine?}`: filled row by row; `serpentine`
    runs every second row backwards.
  - `{type: "mirror", left, right, origin?, center_gap?}`: both halves listed **from the outer edge towards the
    centre**, the same count on each side; `right[i]` mirrors `left[i]` (`left[i]` at `origin.x + i`, `right[i]` at
    `origin.x + width − 1 − i`, width = 2 × count + gap). Use it when the patch numbering does not follow the rig,
    for example stage left numbered outside-in and stage right numbered outside-in too.

Validation (nothing sent): duplicates (with their list positions), shared cells without `allow_shared_cells`, bad ids,
cells or helper parameters, more than 512 fixtures, a name with characters the console strips, missing `exclusive`.

Requests, in order:

1. read `check_group`: `objects Group <n>` (Name, Lock, ...). Missing: new group. Existing without `overwrite: true`,
   locked, or with a Lock that cannot be read: refused.
2. read `check_fixtures`: one `objects Fixture <id>` per fixture; any that is not a Fixture/SubFixture is refused.
   Each id is resolved to its console address, the identity every later comparison uses: two ids for one object
   (a cell's dotted path `501.3` and its own FID `9001`) are refused here, because the console would ignore the
   second selection. A cell requested as `501.3` that reads back as FID `9001` therefore still matches.
3. read `read_selection`: `selection.grid`, reported as `selectionBefore` (what the tool is about to clear). An old
   bridge fails here, before anything is sent.
4. `preview: true` stops here and returns `plan` (`items`, `gaps`, `offsetFromOrigin`, `bounds`, `sharedCells`).
5. `clear_selection`: `ClearSelection` (deselects; programmer values stay).
6. `build_selection`: per fixture `Grid x/y/z` then `Fixture <id>`, each answer must be OK (one aggregated step that
   names the failing command).
7. read `check_selection`: `selection.grid` must hold exactly the planned fixtures on the planned cells. **Otherwise
   nothing is stored.**
8. `store`: `Store Group <n> /NoConfirmation` (`/Overwrite /NoConfirmation` for an existing group).
9. `set_preserve_grid_positions`, then `set_name` when `name` is given: `set` with read-back.
10. verify (default): `group.read` compared fixture by fixture (cells, PreserveGridPositions, name); then
    `ClearSelection`, `Grid 0/0/0`, `Group <n>` and `selection.grid` compared again (fixtures only when
    `preserve_grid_positions` is false). Either difference makes `verification` `mismatched`.
11. cleanup, always once anything was sent: `cleanup_clear_selection` (`ClearSelection`) and `cleanup_cursor`
    (`Grid 0/0/0`). They are ordinary steps: a failed cleanup makes the outcome `partial` (an error) and adds a warning
    that fixtures may still be selected.

The tool holds this server's mutation lock from step 5 to the end. It cannot stop another operator from selecting
fixtures in between; `check_selection` and the recall check detect that.

## `gma3_matricks` and `gma3_configure_matricks`

Per axis (`x`, `y`, `z`):

| Setting | Properties | Values |
| --- | --- | --- |
| `wings`, `blocks`, `groups`, `width`, `shuffle` | `XWings`, `XBlock`, `XGroup`, `XWidth`, `XShuffle`, ... | integers ≥ 1; `null` or 0 = None |
| `shift` | `XShift`, ... | integer (may be negative); `null` or 0 = None |
| `fade`, `delay` | `FadeFromX` / `FadeToX`, `DelayFromX` / `DelayToX`, ... | `{from, to}` in seconds; `null` = None |
| `phase` | `PhaseFromX` / `PhaseToX`, ... | `{from, to}` in degrees (−3600..3600) |
| `speed` | `SpeedFromX` / `SpeedToX`, ... | `{from, to}` in BPM (> 0). Written in BPM; the edit role the bridge reads answers in Hz (60 BPM reads `1.000000`), which the tools convert |

A distribution runs over the selection in grid order. With wings, it runs from the outer edges (`from`) to the
centre (`to`): **a centre-out delay is `{wings: 2, delay: {from: <outer>, to: 0}}`**, a plain left-to-right fade is
`{fade: {from: 0, to: <seconds>}}` without wings.

`gma3_matricks {matricks}` reads every per-axis setting with one `objects` request, plus `otherSettings` that differ
from a fresh MAtricks (inverts, align ranges, relative flags, phaser transform, shuffle mode, speed-master override;
outside the qualified model, which only resets them).

`gma3_configure_matricks {matricks, name?, create?, x?, y?, z?, reset_unspecified?, preview?, verify?}`:

1. read `read_matricks`: missing without `create: true`, locked, or with an unreadable requested value: refused.
2. Existing object: only settings that differ are written (`intended.changes`; equal ones under `unchanged`); with
   `reset_unspecified: true` every other per-axis setting goes to None and the other settings to their defaults
   (`intended.resets`), including **SpeedMasterOverride**, which is cleared with `"0"` (the only form the console
   accepts; it reads `""` when clear and the master's name otherwise). Nothing to change: `noop: true`, nothing sent.
   `preview: true` stops here.
3. New object (`create: true`): `Store MAtricks <n> /NoConfirmation`, `read_new`, then the writes needed to turn the
   copy of the selection MAtricks into exactly the request (`intended.afterStore`).
4. one `set` per property with read-back; the first value the console does not apply stops the rest. The override is
   written first: any override write while `SpeedFromX` is None (even `"0"` on a clear override) sets `SpeedFromX` to
   60 BPM, so after an override write every planned speed is written as well, whatever it read before.
5. verify (default): one `objects` read compared with the request (every property for a new object or
   `reset_unspecified`). A property missing from the read is a mismatch, never taken as its default.

Apply a MAtricks to a selection with `Recall MAtricks <n>` (`Call MAtricks` answers "Not implemented" on 2.5.1).

## What is and is not verified

- Verified live (onPC 2.5.1, `test/live/groups.live.ts`): the stored cells and PreserveGridPositions of a group, the
  same fixtures on the same cells after a recall at the origin, overwrite keeping the name, the MAtricks properties
  read back. Value distributions: without wings the stored row ramps 0 → 100 along grid X; with `XWings 2` the
  transformed X is 0 1 2 3 3 2 1 0 and `At 100 Thru 0` is symmetric with the centre lowest.
- **Not verifiable per fixture: MAtricks timing.** Fade, delay, phase and speed distributions are not baked into
  programmer values or into a stored cue's channel data, so the tools verify the MAtricks object's settings; that a
  delay reaches the centre first follows from the transformed positions, not from a measured fade.
- Not qualified: the invert flags (`XInv`, `XInvW`, `InvertX`, ...) did not change a value distribution in the probe
  and are not modelled; group-level MAtricks (the MAtricks properties a group object also has) are not touched;
  `Width`, `Shift` and `Shuffle` are written and read back but their distribution was not measured.
- Not covered: groups and MAtricks of other data pools (the tools address the current one by number).

## Live test

`GMA3_LIVE=1 node --import tsx --test test/live/groups.live.ts` on a disposable show with an empty programmer and
bridge 0.21.0. It uses Group and MAtricks 905–906, fixtures 401–404 and 701–704 (`GMA3_LIVE_GRID_ROW`) and fixture 501
with its cells (`GMA3_LIVE_GRID_CELLS`), refuses to run when those objects exist, and deletes them, clears the
programmer, resets the selection MAtricks and returns the cursor to 0/0/0 at the end. The dirty selection MAtricks it creates the centre-out object from carries XGroup 3 and
a speed-master override. Last run: 1/1, 3.2 s.
