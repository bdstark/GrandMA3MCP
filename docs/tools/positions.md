# Fixture positions in 3D (SU-04)

`gma3_fixture_positions`, `gma3_place_fixtures`. No bridge change: the tools use the `set` and `objects` ops (no Lua),
and `patch.state` / `patch.list` from bridge 0.19.0. Evidence: [SETUP.md](../../SETUP.md) SU-04 and the
[SU-04 record](../probes/su-04-positions-macos-2.5.1.md).

## Axes and units

The console stores metres and degrees. The tools take and report positions in `unit`: `m` (default), `cm`, `mm`, `ft`
or `in`; rotations are always degrees.

| Axis | Positive direction |
| --- | --- |
| X | stage left |
| Y | upstage (negative: downstage, towards the audience) |
| Z | up |
| rotation X | about the fixture's own X axis: its top tilts downstage |
| rotation Y | about its own Y axis: its top tilts stage left |
| rotation Z | about its own Z axis: counter-clockwise seen from above |

**Rotations.** The console renormalizes the three angles a frame after they are written, keeping the rotation:
(0, 180, 0) reads back as (180, 0, 180), (30, 100, 20) as (−150, 80, −160). So:
- A rotation is always given as all three angles. One axis cannot be changed on its own, because the other two as the
  console reports them may be the renormalized form.
- The rotation is written as one quaternion (`ROTDIRECT`), q = qZ · qY · qX. Writing the angles one by one goes wrong:
  the console renormalizes between the writes.
- Read-back compares quaternions, so a renormalized answer is a match.

## gma3_fixture_positions

Read-only. `fids` (up to 256) or `fixtures` (a command-line range such as `Fixture 101 Thru 112`), and `unit`. Each
fixture has `position`, `rotation` (as the console reports it, renormalized), `quaternion` (`x, y, z, w`) and
`mirror_mesh`. The result includes `axes`.

Positions are read raw (`objects` with `asText: false`): exact, where the display role has only millimetres. The
quaternion is a second, display-role read (`ROTDIRECT` has no raw value).

## gma3_place_fixtures

| Parameter | |
| --- | --- |
| `unit` | `m` (default), `cm`, `mm`, `ft`, `in` |
| `placements` | `[{fid, position?: {x?, y?, z?}, rotation?: {x, y, z}, mirror_mesh?}]`; position axes not given stay |
| `layouts` | Expanded into placements, see below |
| `preview` | Return the expanded plan with every fixture's current values; nothing is sent |
| `verify` | Default `true` |

Layouts:

| Kind | Fields | Result |
| --- | --- | --- |
| `line` | `fids`, `from`, `to`, `rotation?` | Evenly spaced from `from` to `to`, both included; one fixture sits at `from` |
| `arc` | `fids`, `center`, `radius`, `start_deg`, `end_deg`, `rotation?`, `follow?` | Evenly spaced on a horizontal arc at `center.z`. 0° is stage left of the centre, 90° upstage, 180° stage right, 270° downstage. `follow` adds each fixture's angle to its rotation Z |
| `mirror` | `pairs: [[source_fid, target_fid]]` | The target at its source's final pose mirrored across the stage centre line: x negated, rotation (x, −y, −z). The source's pose is the one this call gives it, or its current one. Pairs may chain (A → B, B → C) and resolve in dependency order, whatever order they are given in; a cycle is refused |

A FID may appear only once across placements and layouts.

Everything from the first read to the read-back runs under this server's mutation lock, so another queued operation
cannot open the patch copy or move a fixture between the checks, the `restore` values and the writes.

Pre-flight (read-only; nothing is sent on failure):
- `patch.state`: the patch copy is closed. **Committing an open copy overwrites position writes** (live), so the tool
  refuses while someone is in the Patch menu or a patch session is open.
- `patch.list`: every FID exists and is a top-level fixture. A fixture inside a grouping fixture is refused: whether
  its position is relative to the parent is not established. Cells have no position of their own (see SU-08).
- The current poses, which go into the result as `before` and `restore`. A position or rotation value that is missing
  or not a number refuses the call (it is never read as 0).

Changes: per fixture, one `set` per position axis, one `ROTDIRECT` for the rotation, and `MESHMIRRORX` `1` / `0`
(the console ignores `false` and `No`). Each write is its own step (`101.POSX`, `101.ROTDIRECT`, ...); the first
failure stops the rest, which are reported as skipped. A fixture changed only in part makes the outcome `partial`, and
the summary names it and what was written. A write that got no reply may have executed: the outcome is `unknown`, the summary reports
that fixture's state as unknown (never "not changed"), and the read-back reports what the console now holds for that
property in `uncertainWrites` (`applied` true, false or null when unreadable).

Read-back, a frame after the writes, of exactly the properties that were written: positions within 0.1 mm, rotations
by quaternion, `mirror_mesh` exactly. A write the console ignores is a mismatch, never a success; a value that cannot be
read back makes the verification `unavailable`, never `matched`.

Not offered: scale. The console ignores `SCALEX/Y/Z` writes without an error.

**No undo.** `Oops` does not revert positions. The result's `restore` is every placed fixture's previous pose in the
same format as `placements`; passing it back restores them.

## Cell layouts (SU-08)

`gma3_layout_cells`, `gma3_assign_cell_layout`. Bridge 0.29.0 (`patch.cellLayout`, `patch.cellLayoutWrite`,
`patch.layoutCopy`, `patch.retype`). Evidence: the [SU-08 record](../probes/su-08-cell-layout-macos-2.5.1.md).

A cell (a SubFixture: a festoon's bulb, a pixel bar's pixel) has no position of its own. Its place is its geometry
reference in the fixture type, under the DMX mode's root geometry. So **a cell layout belongs to every fixture whose
mode uses that root**, all modes sharing it included. Each fixture can still be placed, rotated and mirrored as a whole
with `gma3_place_fixtures`; moving the cells of one fixture alone needs a layout of its own.

### gma3_layout_cells

| Param | Notes |
| --- | --- |
| `fixture` | FID of a fixture with cells; its type and mode define the layout |
| `path` | `shape` and its parameters (below), in `unit` |
| `unit` | `m` (default), `cm`, `mm`, `ft`, `in` |
| `count`, `rest` | place only the first `count` cells; the rest `keep` their positions (default) or stack at the `last` placed one |
| `order` | the order the cells take along the path: `index` (cell numbers, default) or `dmx` (DMX address order, the physical order along a string; SU-19, see [cell order](patch.md#cell-order-su-19)). The Festoon's 2-string mode then needs no hand-computed points |
| `scope` | `shared` (default) or `own` |
| `affects` | shared: every FID that uses the layout, exactly (`preview` lists them) |
| `own` | own: `name` of the new type, `fixtures` that get it (default: the fixture) |
| `preview`, `exclusive`, `verify` | `exclusive` required unless `preview` |

**Paths.** Cells are placed every `spacing` along the path, from `origin`:
- `line`: along `direction` (default `+x`).
- `square_wave`: legs of `leg_length` along `leg_direction` (default `-y`), alternating; between legs a step of
  `leg_step` (default `spacing`) along `advance` (default `+x`). With `leg_step` = `spacing` the cells continue along
  the step, which is how a festoon strung back and forth hangs: 2 ft spacing and 10 ft legs give 6 bulbs per leg.
- `zigzag`: diagonal legs, each advancing `leg_step` along `advance` while alternating between the origin line and
  `leg_length` along `leg_direction`.
- `points`: one `{x, y, z}` per cell, in order.

Axes the path does not use keep each cell's own value unless `origin` sets them (a horizontal layout keeps the
bulbs' drop). Positions are relative to the cells' parent geometry in the fixture type; the fixture's position,
rotation and mirroring then apply.

**Shared** writes the type's layout. The tool reads which fixtures use it and refuses, before writing anything,
unless `affects` names exactly those. When it writes, the bridge checks the set again, and checks that the layout
still belongs to the planned type (its GUID) with the planned number of cells.

The whole call, from the first read through an own layout's patch session to the write and its read-back, holds
this server's mutation lock, so no other tool call from this server can retype the fixtures in between.

**Own** first runs one patch session (`exclusive`, isolation-checked like the patch tools):
1. `patch.layoutCopy` appends a copy of the type under `own.name` and moves `own.fixtures` to the copy's mode of
   the same name. Their FID, address, cells, group membership and preset values are kept (checked live).
2. The session is committed, and the console gives the copy its own GUID. The tool checks that GUID: one that is all
   zeros or equal to the source type's stops the call before any cell is moved (the fixtures are then on the copy,
   and the result says how to move them back).

Then the copy's cells are laid out. The other fixtures of the original type keep theirs. Fixtures that already are
the only users of their layout are refused (use `shared`).

Both are **refused while the patch copy is open**, since its commit would overwrite the positions. There is **no
undo**: `previous` holds every planned cell's position before the call, ready to pass back as `points`. Read-back
compares every written cell within 0.1 mm.

A write that stops part-way (a cell the console refuses) is `partial`. `writeState` gives:
- `written`: the cells known to be written;
- `uncertain`: the cell that may be partly written;
- `changedAfter`: the cells the read-back found moved.

A lost reply leaves every planned cell uncertain, and the read-back says which moved.

Positions are computed from each cell's arc length, so the work is one step per cell, whatever the legs.

### gma3_assign_cell_layout

Moves fixtures to another layout type of their fixture, so several fixtures share one layout: a copy made by
`scope: "own"`, or back to the original. The target type must have a DMX mode of the same name with the same expanded
DMX addressing, otherwise it is refused. That means every channel (name, coarse, fine, ultra, break, in order) at the
same address in every cell, with the same cells (names and break offsets). Only the cells' positions may differ. One patch session
(`patch.retype`), committed with no undo, then a read-back of the fixtures' type. An unused copy is removed with
`gma3_patch_remove_type`.

## Live test procedure

`test/live/positions.live.ts`, with `GMA3_LIVE=1`, on a disposable show. It uses the two top-level fixtures in
`GMA3_LIVE_POSITION_FIDS` (default `1,2`), and it:
1. reads their poses;
2. places them on a line in feet with the rotation (30, 100, 20), and checks the renormalized read-back (Y = 80);
3. turns mesh mirroring on for the first, mirrors it onto the second, then places both on an arc;
4. restores both from the starting poses, and checks the read-back equals them.

The after hook restores the starting poses if the run stops early. 1/1 on macOS onPC 2.5.1 (2026-10-15), 2 s.

```bash
GMA3_LIVE=1 GMA3_LIVE_POSITION_FIDS=201,202 node --import tsx --test test/live/positions.live.ts
```

`test/live/cell-layout.live.ts` (SU-08, `GMA3_LIVE=1` and `GMA3_LIVE_EXCLUSIVE=1`, two fixtures with cells sharing a
layout from `GMA3_LIVE_CELL_FIDS`):
1. a shared layout refused without every sharing fixture, then laid out as a line and restored from `previous`;
2. an own layout (a square wave in feet) for the second fixture, while the first keeps its layout;
3. the second fixture assigned back and the copy removed.
