# Show setup from scratch

Gaps found by running the MCP server as an end user would: an agent started a new show and set it up from plain
requests, with no knowledge of this repository. The fixes and features below cover what it could not do with
structured tools, and the bugs it hit.

Identifiers SU-01 through SU-10 are provisional. Bugs come first, then features in the order they block show setup.
These are proposals; console API support must be established by the probes described below.

## The field test

**Setup (2026-10-14):** a Claude Code session in an empty folder (`~/gma3-enduser/showtest`) with only a `.mcp.json`
pointing at the end-user build of the server, onPC 2.5.1 on macOS, bridge 0.25.0 and then 0.25.1. The operator
asked in plain language for:

1. 12 ADJ Mega Hex Pars (8 ch), 4 Oppsk 36-LED wall washers (52 ch), 2 SHEHDS 180 W beams, 2 Chauvet Festoon 2
   (40-pixel mode, 36 bulbs used).
2. A physical layout: wall washers in two pairs at 7 ft angled 45° down, the pars in two mirrored V shapes, the
   Festoons strung over the area as square waves of bulbs 2 ft apart, the beams hung either side of the stage.
3. Colours and intensities per fixture group, the beams pointing straight down.
4. 12 movement effects for the beams (in sync, following each other, mirrored), then a 7-second looping chase of
   all 12.

**Outcome:** everything was built and saved. Where a structured tool existed the agent used it, and every one of
those calls succeeded and read back correctly: 17 `gma3_build_phaser`, 9 `gma3_patch_add` after the fixes below,
selection, colour, programmer and cue-content reads, `gma3_store_cue`, `gma3_configure_sequence`, `gma3_playback`.
What it could not do with structured tools, it did through 33 `gma3_lua` calls and 13 raw `gma3_command`s:

| Work | `gma3_lua` calls | Feature |
| --- | --- | --- |
| Import fixture types from the library (after finding the files with shell commands) | 5 | SU-03 |
| Place fixtures in 3D (position, rotation, mirroring) | 6 | SU-04 |
| Read fixture-type structure: cells, mode channels, geometry, model size | 10 | SU-07 |
| Lay out Festoon bulbs by editing the fixture type's geometry | 3 | SU-08 |
| Programmer: several attributes at once, preset recall, attribute off | 4 | SU-05 |
| Build, name and trigger 12 chase cues | 3 | SU-06 |
| Watch a running chase | 2 | SU-10 |

Raw commands covered the same gaps: `At 100`, `Attribute "ColorRGB_W" At Absolute Percent 0`, `ChangeDestination`
into the fixture-type pool, and `SaveShow` after each step. Three of the four failed Lua calls were the agent's own
typos.

## Shared acceptance criteria

The [SHOWS.md shared acceptance criteria](SHOWS.md#shared-acceptance-criteria) apply. In addition:

- A tool has to work for an agent without a shell. Desktop chat has no file access, so nothing may depend on the
  agent reading the onPC install folder itself.
- Physical quantities take explicit units (m, ft, degrees) and read back in the units given.
- A write the console silently ignores (an invalid value, a read-only property) is a failure, not a success. Found
  live: `SCALEX = -1` on a fixture was accepted and read back as `1`.
- Edits to a fixture type say that they affect every fixture of that type.

## SU-01 — Patch isolation check after a fixture-type import (bug)

**Request:** Patch fixtures of a type imported in the same session without a false "someone else changed the show".

**Depends on:** KB-26.

**Repository:** GrandMA3MCP.

**Lua changes:** Yes: the bridge's `patch.fingerprint`.

**Status:** fixed in bridge 0.25.1 (PR GrandMA3MCP#46, merged). After five grandMA2 types were imported, the first
`gma3_patch_add` refused to commit: FixtureTypes and AttributeDefinitions differed between the copy and the live
patch. A property-by-property diff of the open copy (3,765 objects) found only console-derived values:
`ATTRIBUTEINDEXOLD` on the 29 imported attributes (unset `4294967295` live, numbered in the copy) and the
`SubfixtureOverview` rows of each DMX mode, which the copy renumbers. The fingerprint now leaves out that property
and that class. Verified read-only against the same open copy: all nine collections match. Details in
[DIALOG.md](DIALOG.md) (KB-26 record).

### Acceptance criteria

- Patching a type imported earlier in the session passes the isolation check.
- A real change to an attribute or a fixture type is still detected.
- The harness models both derived values.

## SU-02 — onPC crash in a multi-fixture patch add (bug)

**Request:** Add a block of fixtures of any type without risking the console.

**Depends on:** KB-26.

**Repository:** GrandMA3MCP.

**Lua changes:** Yes: the bridge's `patch.add`.

**Status:** done in bridge 0.25.2 (PR GrandMA3MCP#47, merged): `patch.add` calls `AddFixtures` once per fixture,
amount 1, each with its own FID and address. Reproduced without the bridge on an empty show and reported to MA Lighting (2026-10-14); the
reproduction plugin and report are in [docs/probes/addfixtures-crash](docs/probes/addfixtures-crash/README.md).

**What happened:** `gma3_patch_add` for 4 wall washers (52-channel mode, 12 cells each) at 1.097 crashed onPC
during the add step. The crash report (`EXC_BAD_ACCESS` at address `0x4`, then `abort()` from the console's own
signal handler, thread `MainTask`) symbolicates against the onPC 2.5.1 binary's symbol table. That binary's names
are redacted, so the frames were tied to Lua API functions by their runtime addresses, read read-only with
`tostring()` on each function: the ASLR slide `0x24e4000` puts Lua's `print`, `pcall`, `tostring` and `pairs` exactly
on symbol starts. On that basis the crashing thread is the bridge's `pcall` → the Lua VM → **`AddFixtures` +
`0xe64`** → five console functions → the null dereference. The crash is inside onPC's `AddFixtures`, not in the
bridge's `Set("Patch")` fix-up, which runs only after `AddFixtures` returns.

**Was the call wrong?** The arguments were those the manual documents: `{ mode = <DMX mode handle>, amount = 4,
fid = "201", name = "WallWash", patch = { "1.097" } }`. A null dereference on documented input is an onPC bug. The
manual is thin exactly here, though: it defines `patch` as the addresses of one fixture's DMX breaks and `name` as
the name of "the (first) fixture", and says nothing about how addresses step for `amount > 1`. KB-26 had already
found that `amount > 1` addresses only the first fixture of a block.

| Call | Result |
| --- | --- |
| Mega Hex Par (8 ch, no cells), amount 12, with `patch` | worked; the bridge addressed 11 of 12 itself |
| 18-channel mode, amount 2, with `patch` (KB-26) | worked; only the first was addressed |
| Wall washer (52 ch, 12 cells), amount 4, with `patch` | **crashed onPC** |
| Wall washer amount 1 ×4, beam amount 1 ×2, Festoon (40 cells) amount 1 ×2, each with `patch` | all worked |

### Reproduction

[docs/probes/addfixtures-crash](docs/probes/addfixtures-crash/README.md) holds a standalone plugin that needs nothing
from this repository: on a new, empty show it imports the wall washer from the shipped grandMA2 library and calls
`AddFixtures` the way the manual's example does. Variant A (`amount = 4`, with `patch`) crashed onPC with the same 19
innermost frames as the field crash. The report went to MA Lighting on 2026-10-14. The narrower variants (amount 2
with and without `patch`, a mode without cells, amount 1) were not run. The one-call-per-fixture path stays: it is
the only one proven on every type in the field test.

### Acceptance criteria

- `patch.add` never passes `amount > 1` to `AddFixtures`.
- A failing call stops the block; what was created is deleted from the copy.
- Live: a multi-fixture add of a mode with cells completes without a crash. Verified with bridge 0.25.2 on a new show
  (2026-10-15): 4 wall washers (12 cells) at 1.001 as one `gma3_patch_add`, the request that had crashed onPC, then
  2 Festoons (40 cells) at 2.001 and 3 Mega Hex Pars at 1.209. All three committed and read back, every fixture at
  its own address with `patchedByBridge: 0`, the cells present (12 and 40 `SubFixture` children), no crash.

## SU-03 — Find and import fixture types

**Request:** Find a fixture in the onPC library by manufacturer, name, channel count or mode, and import it into the
show.

**Depends on:** KB-26.

**Repository:** GrandMA3MCP.

**Lua changes:** Likely: a read-only library search, and an import op that runs `Import Library "<file>"` in the
fixture-type destination with `CmdIndirect` and claims only the type it created (KB-25: number + name, one new type).

**Status:** implemented in bridge 0.26.0: `gma3_patch_library`, `gma3_patch_import`, `gma3_patch_remove_type`
([docs/tools/patch.md](docs/tools/patch.md), probe record [su-03-import-macos-2.5.1.md](docs/probes/su-03-import-macos-2.5.1.md),
live test `test/live/patch-import.live.ts` 1/1 on macOS onPC 2.5.1). The ownership rule: an import claims exactly one
appended type whose name or manufacturer matches the file; a duplicate is refused unless asked. A grandMA2 file's modes
are known only after the import (the files are encrypted); a grandMA3 or user `.xml` lists them before. Removal is for
unused types only; the types after it are renumbered and its attributes stay in the show. User-library and WorldServer
files import through the same command but are marked unverified: none was available to test.

**Evidence:** the agent located the files with `find` under `gma3_2.5.1/shared/lib_fixture_types` (all four types
were only in the `grandma2/*.pxml` library), read their modes after importing them, and imported through
`gma3_lua` (`Cmd('ChangeDestination …')` + `Cmd('Import Library "…"')`). `gma3_command "ChangeDestination Root
ShowData Patch FixtureTypes"` returned OK but stopped at `ShowData`. It imported an extra type to compare modes and
had to clean up after itself. A Desktop chat agent cannot run `find` at all.

### Acceptance criteria

- Search the shipped libraries (grandMA3, grandMA2, user library) by manufacturer and model text; report source,
  file, and the DMX modes with footprints when the format allows it.
- Import one file; report the created type's number, name and modes; refuse when the type already exists unless
  asked.
- Never leave the command line in the patch or the fixture-type destination.
- Removing an imported type that no fixture uses.
- Work with arbitrary Lua disabled.

## SU-04 — Place fixtures in 3D

**Request:** Position, rotate and mirror fixtures on the stage in metres or feet.

**Depends on:** KB-26.

**Repository:** GrandMA3MCP.

**Lua changes:** Not expected: live fixtures take `Set()` outside patch mode (KB-26 hooks). A probe must establish
which properties are writable and how rotation reads back.

**Status:** implemented without a bridge change: `gma3_fixture_positions`, `gma3_place_fixtures`
([docs/tools/positions.md](docs/tools/positions.md), probe record
[su-04-positions-macos-2.5.1.md](docs/probes/su-04-positions-macos-2.5.1.md), live test `test/live/positions.live.ts`
1/1 on macOS onPC 2.5.1). Positions read raw (exact) and written through `set`; a rotation is written as one
`ROTDIRECT` quaternion, because the console renormalizes the angles between separate writes, and verified by
quaternion. Mirroring is the fixture's `MESHMIRRORX` flag (the console ignores scale); mirror pairs across the stage
centre line, lines and arcs expand into a previewable plan. Refused while the patch copy is open: its commit overwrites
positions. No undo, so the result carries a restore list. Fixtures inside grouping fixtures are refused (not
established).

**Evidence:** six `gma3_lua` calls wrote `POSX/POSY/POSZ/ROTX/ROTY/ROTZ` with hand conversion from feet. Mirroring by
`SCALEX = -1` was accepted and silently read back as `1`; the agent mirrored with `ROTY = 180`, which read back as
`ROTX 180, ROTY ~0, ROTZ 180` (an equivalent Euler triple).

### Acceptance criteria

- Set position (X/Y/Z) and rotation for one or many fixtures, with explicit units; read back and compare with a
  tolerance, treating an equivalent rotation as a match.
- Report the axes' meaning (stage/crowd, up) as the console defines them.
- Helpers for rows, mirrored pairs and arcs that expand into a reviewable list, as SB-02 does for grids.
- Refuse a property the console ignores (mirroring included) instead of reporting success.

## SU-05 — Programmer: several attributes and preset recall

**Request:** Set a whole look in one call and apply stored presets to a selection.

**Depends on:** FR-03, SB-03.

**Repository:** GrandMA3MCP.

**Lua changes:** No (one read-only addition to the programmer op: a recalled preset's link per row).

**Status:** implemented in bridge 0.27.0: `gma3_set_attributes`, `gma3_apply_preset`, `gma3_release_attributes`
([docs/tools/fixtures.md](docs/tools/fixtures.md), probe record
[su-05-programmer-macos-2.5.1.md](docs/probes/su-05-programmer-macos-2.5.1.md), live test
`test/live/programmer-looks.live.ts` 1/1 on macOS onPC 2.5.1). Every command answers `OK` whatever it changed, so the
read-back decides: a recall is verified by the channel's preset link (`abs_preset`, which the programmer op now
reports), and a missing preset or an empty target is refused before sending. `Off Attribute` with nothing selected
releases from every fixture, so release needs an established target and is verified against the whole programmer.

**Evidence:** `gma3_set_attribute` takes one attribute, so the agent zeroed white, amber and UV in a Lua loop, set
the beams' Pan, Tilt, Color1, Gobo1 and Shutter through `Cmd()`, sent `At 100` and `Attribute "…" At Absolute
Percent 0` raw, and recalled `At Preset 2.1` and `Off Attribute "Pan" + "Tilt"` through Lua. No tool applies a preset.

### Acceptance criteria

- Set several attributes (with units) on one target in one call, with the same per-fixture read-back as
  `gma3_set_attribute`.
- Apply a preset to a target; read back that the programmer references it.
- Release attributes from the programmer for a target.
- Intensity as a first-class attribute (`At` on the selection).

## SU-06 — Build cue lists and chases in batches

**Request:** Create a chase from a list of looks or presets, with triggers and names, in one step.

**Depends on:** FR-04, FR-05, SB-01, SU-05.

**Repository:** GrandMA3MCP.

**Lua changes:** No.

**Status:** implemented without a bridge change: `gma3_store_cues`, `gma3_edit_cues`, `gma3_build_chase`
([docs/tools/cuelists.md](docs/tools/cuelists.md), probe record
[su-06-cuelists-macos-2.5.1.md](docs/probes/su-06-cuelists-macos-2.5.1.md), live test `test/live/cuelists.live.ts`
1/1 on macOS onPC 2.5.1). The cues are built in the Preview environment, so nothing is output and the operator's
Normal programmer is untouched. A cue's stored values cannot be read back on 2.5.1, so each look is checked in the
programmer before its store. A chase is verified by playing it and watching one cycle through the wrap.

**Evidence:** `gma3_store_cue` and `gma3_set_cue_trigger` take one cue each, so the 12-cue chase was built in one
`gma3_lua` call (clear, select, `At Preset 2.n`, `Store Sequence 2 Cue n` per cue), its triggers set to Time 7 in
another, and the sequences and cues named through Lua.

### Acceptance criteria

- Store a list of cues, each from explicit content (fixtures + presets or attribute values), with names.
- Set trigger, timing and names on a cue range.
- A chase helper: cues from presets, a time trigger, wrap-around, verified by one observed cycle.
- Partial results are reported per cue; nothing is retried.

## SU-07 — Fixture-type structure readback

**Request:** Know a fixture's cells, channels and physical size before programming or placing it.

**Depends on:** KB-26, FR-07.

**Repository:** GrandMA3MCP.

**Lua changes:** Likely: a read-only op over the type's modes, geometry and models.

**Status:** implemented in bridge 0.28.0: `gma3_patch_type_structure`, and cell counts in `gma3_patch_types` and
`gma3_patch_list` ([docs/tools/patch.md](docs/tools/patch.md), probe record
[su-07-type-structure-macos-2.5.1.md](docs/probes/su-07-type-structure-macos-2.5.1.md), live test
`test/live/type-structure.live.ts` 1/1 on macOS onPC 2.5.1). A mode's DMX channels are templates repeated per cell at
the cell's break offset; the expansion covers every address of every mode of the show's five types. Cells are the
geometry references under a mode's root geometry, which a patched fixture gets as SubFixture children.

**Evidence:** ten `gma3_lua` calls read a mode's DMX channels, the cell count (`SubfixtureOverview`), the geometry tree,
and the wall washer's model size (1.04 m, needed to space a pair 1 ft apart).

### Acceptance criteria

- Per DMX mode: footprint, breaks, channels with attributes, and cell count.
- Geometry tree with instance names and positions; model dimensions in metres.
- `gma3_patch_types` reports cell counts so a caller can see which modes have cells.
- `gma3_patch_list` reports a fixture's cells. Its `subfixtures` field counts child fixtures (a grouping fixture's
  members) and is `0` for a 12-cell wall washer or a 40-cell Festoon, whose cells are `SubFixture` objects.

## SU-08 — Lay out a fixture's cells

**Request:** Position the cells of a multi-cell fixture (a festoon's bulbs, a pixel bar's pixels) in physical space.

**Depends on:** SU-07.

**Repository:** GrandMA3MCP.

**Lua changes:** Likely.

**Status:** proposed; needs a design decision.

**Evidence:** the Festoon bulbs have no position of their own. The agent wrote the 40 `GeometryReference` positions of
the Festoon 2 RGB type's geometry, which moves every Festoon of that type, and mirrored the second Festoon with
`ROTY = 180`. That worked here, but it edits a library fixture type in place with no undo.

### Acceptance criteria

- Decide between editing the shared type, copying it per layout, or another qualified mechanism; the tool states
  which fixtures a change affects.
- Positions along a path (line, square wave, zig-zag) with spacing in explicit units, read back per cell.
- Refuse while the patch copy is open.

## SU-09 — DMX universes and output

**Request:** Configure and check what the console outputs.

**Depends on:** FR-09.

**Repository:** GrandMA3MCP.

**Lua changes:** Possibly, for readback of universe settings.

**Status:** proposed.

**Evidence:** `gma3_fixture_output` could not read DMX: universe 1 is not granted on this onPC, so it sends nothing.
No tool shows or configures universes, protocol output (Art-Net, sACN) or the grant.

### Acceptance criteria

- Read universe configuration, grant state and protocol outputs.
- Explain an unreadable output (not granted, not configured) instead of returning nothing.
- Configuration changes, if offered, preview and read back.

## SU-10 — Tool discovery

**Request:** An agent finds the structured tool for a task instead of writing Lua.

**Depends on:** none.

**Repository:** GrandMA3MCP.

**Lua changes:** No.

**Status:** partly done: PR GrandMA3MCP#45 adds MCP server instructions when the build is stale.

**Evidence:** the first chat session, on a stale build that lacked 30 tools, used Lua for everything. In the field
test the agent wrote a waiting loop to watch the chase and hit the 5 s Lua budget; `gma3_observe_tempo` does that and
was not found. The `gma3_lua` description advertises the whole Lua API and names no structured alternative.

### Acceptance criteria

- Server instructions on every start: a short map from setup tasks to tools, and `gma3_lua` as the fallback.
- The `gma3_lua` description names the structured tools for patch, groups, presets, phasers, cues and playback.
- Descriptions say what a tool observes over time (`gma3_observe_tempo`, `gma3_run_macro`,
  `gma3_timecode_transport`).

## Recommended delivery order

SU-01 and SU-02 first (bridges 0.25.1 and 0.25.2). Then SU-03: without import, a new show cannot be set up without Lua or a
shell. SU-04, SU-05 and SU-06 remove most of the remaining Lua from a typical setup; SU-10 is small and can go with
any of them. SU-07 precedes SU-08, which needs a design decision. SU-09 is independent.

## References

- [AddFixtures Lua function](https://help.malighting.com/grandMA3/2.5/HTML/lua_objectfree_addfixtures.html)
- [Import keyword](https://help.malighting.com/grandMA3/2.5/HTML/keyword_import.html)
- [Position fixtures in the 3D space](https://help.malighting.com/grandMA3/2.5/HTML/patch_position_fixtures.html)
- Field-test transcripts: Claude Code sessions in `~/gma3-enduser/showtest` (2026-10-14)
