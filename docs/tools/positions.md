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
the summary names it and what was written.

Read-back, a frame after the writes, of exactly the properties that were written: positions within 0.1 mm, rotations
by quaternion, `mirror_mesh` exactly. A write the console ignores is a mismatch, never a success; a value that cannot be
read back makes the verification `unavailable`, never `matched`.

Not offered: scale. The console ignores `SCALEX/Y/Z` writes without an error.

**No undo.** `Oops` does not revert positions. The result's `restore` is every placed fixture's previous pose in the
same format as `placements`; passing it back restores them.

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
