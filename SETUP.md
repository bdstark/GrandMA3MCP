# Show setup from scratch

Gaps found by running the MCP server as an end user would: an agent started a new show and set it up from plain
requests, with no knowledge of this repository. The fixes and features below cover what it could not do with
structured tools, and the bugs it hit.

Identifiers SU-01 through SU-20 are provisional. SU-11 to SU-20 come from the second field test. Bugs come first, then features in the order they block show setup.
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

## The second field test

**Setup (2026-10-15):** the same folder and rig, on a new show, with the end-user build at 55f7333 (SU-01 to SU-10
merged) and bridge 0.30.0. The operator asked for:

1. The patch, layout and base colours of the first test, and named groups per fixture type.
2. 18 beam movements, 10 colour patterns on the hex pars, washes and Festoons, and 16 Festoon on/off patterns. Each
   comes in three versions, sync, follow and mirror, and the user can switch between them.
3. Switching after the fourth beat, with four measures between switches, synchronised to an external tempo source.
4. Strobe overlays that leave the looks underneath running.

**Outcome:** the show was built, played and saved: 84 phaser presets, 20 sequences, 26 macros and 30 executor
assignments. The structured tools were used for the patch, the cell layout, groups, presets, cues, the chase,
macros, executors, speed masters and observation (about 90 calls), and the discovery map worked:
`gma3_observe_tempo` found a timing fault. Even so, the agent made 46 `gma3_lua` calls and 13 raw `gma3_command`s.
Most of them followed one pattern: after one or two calls to a tool that handles one object, the agent wrote a Lua
loop for the rest. The loop skipped the tool's checks, its Preview isolation and its read-back. It also generated
data in Python (phaser steps, bulb order) and parsed tool results there.

| Work | `gma3_lua` calls | Feature |
| --- | --- | --- |
| Store groups, presets, macros, executor assignments and sequence settings in batches | 7 | SU-12 |
| Build and check 84 phaser presets: moves, colour patterns, Festoon patterns | 13 | SU-13 |
| Build pattern sequences, command-only clock sequences and strobe cues, and restore cue times | 6 | SU-14 |
| Test and read console variables | 2 | SU-15 |
| Read which sequences run and at which cue; watch the output | 8 | SU-16 |
| Configure and test OSC input for an external tempo-sync helper | 8 | SU-17, SU-18 |
| Read a fixture type's colour-wheel slots | 2 | SU-19 |

The raw commands:
- `Goto Sequence $HexCol Cue 2` and three `SetGlobalVariable`s (SU-15);
- six `On`/`Off Sequence`;
- `ReSync Sequence …` (SU-17);
- `SaveShow` (SU-20).

The agent checked the show file's name with a shell command before saving. One `gma3_set_attributes` verification
reported a false mismatch (SU-11). The agent also wrote an external tempo-sync helper in Python that sends commands over
OSC; it still needs a package installed.

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

**Repository:** gma3-mcp.

**Lua changes:** Yes: the bridge's `patch.fingerprint`.

**Status:** fixed in bridge 0.25.1 (PR gma3-mcp#46, merged). After five grandMA2 types were imported, the first
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

**Repository:** gma3-mcp.

**Lua changes:** Yes: the bridge's `patch.add`.

**Status:** done in bridge 0.25.2 (PR gma3-mcp#47, merged): `patch.add` calls `AddFixtures` once per fixture,
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

**Repository:** gma3-mcp.

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

**Repository:** gma3-mcp.

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

**Repository:** gma3-mcp.

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

**Repository:** gma3-mcp.

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

**Repository:** gma3-mcp.

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

**Repository:** gma3-mcp.

**Lua changes:** Likely.

**Status:** implemented in bridge 0.29.0: `gma3_layout_cells`, `gma3_assign_cell_layout`, and a cell note in
`gma3_patch_add` ([docs/tools/positions.md](docs/tools/positions.md#cell-layouts-su-08), probe record
[su-08-cell-layout-macos-2.5.1.md](docs/probes/su-08-cell-layout-macos-2.5.1.md), live test
`test/live/cell-layout.live.ts` 1/1 on macOS onPC 2.5.1).

**Decision (2026-10-15):** both mechanisms. A cell has no position of its own; its place is in the fixture type. So:
- **shared** edits the type's layout in place, and `affects` must name every fixture that moves;
- **own** copies the type for chosen fixtures and moves them to it (retyping keeps FID, address, cells, groups and
  preset values, checked live), so strands of one fixture can hang differently;
- `gma3_assign_cell_layout` moves fixtures between such layouts.

Most fixtures with cells share their type's layout. At insert time, `gma3_patch_add` says so, and for string-light
style types it asks the agent to ask the user whether each fixture needs its own layout.

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

**Repository:** gma3-mcp.

**Lua changes:** Possibly, for readback of universe settings.

**Status:** implemented in bridge 0.30.0: `gma3_dmx_output`, `gma3_configure_dmx_output`, and `outputState` in
`gma3_fixture_output` / `gma3_dmx` ([docs/tools/dmx-output.md](docs/tools/dmx-output.md), probe record
[su-09-dmx-output-macos-2.5.1.md](docs/probes/su-09-dmx-output-macos-2.5.1.md), live test
`test/live/dmx-output.live.ts` 1/1 on macOS onPC 2.5.1).

On this onPC the two universes in use are not granted (no MA hardware), which is why output could not be read; the
tools now say so. Changes are validated (the console silently ignores or clamps bad values), previewed and read
back. A change that would send DMX onto the network needs `network: true`.

**Evidence:** `gma3_fixture_output` could not read DMX: universe 1 is not granted on this onPC, so it sends nothing.
No tool shows or configures universes, protocol output (Art-Net, sACN) or the grant.

### Acceptance criteria

- Read universe configuration, grant state and protocol outputs.
- Explain an unreadable output (not granted, not configured) instead of returning nothing.
- Configuration changes, if offered, preview and read back.

## SU-10 — Tool discovery

**Request:** An agent finds the structured tool for a task instead of writing Lua.

**Depends on:** none.

**Repository:** gma3-mcp.

**Lua changes:** No.

**Status:** implemented, no bridge change. The server sends instructions on every start (`src/discovery.ts`):
- a map from setup tasks to the structured tools;
- the tools that observe over time;
- `gma3_command` and `gma3_lua` as fallbacks.

A stale build's warning (PR gma3-mcp#45) comes first. The `gma3_lua` and `gma3_command` descriptions start by
naming the structured tools for patch, groups, presets, phasers, looks, cues and playback. `gma3_observe_tempo`,
`gma3_build_chase`, `gma3_run_macro` and `gma3_timecode_transport` say they observe over time with no Lua loop.
`test/discovery.test.ts` fails for an unregistered name in the map or an unmapped new tool
([docs/tools/README.md](docs/tools/README.md#tool-discovery-su-10)).

**Evidence:** the first chat session, on a stale build that lacked 30 tools, used Lua for everything. In the field
test the agent wrote a waiting loop to watch the chase and hit the 5 s Lua budget; `gma3_observe_tempo` does that and
was not found. The `gma3_lua` description advertises the whole Lua API and names no structured alternative.

### Acceptance criteria

- Server instructions on every start: a short map from setup tasks to tools, and `gma3_lua` as the fallback.
- The `gma3_lua` description names the structured tools for patch, groups, presets, phasers, cues and playback.
- Descriptions say what a tool observes over time (`gma3_observe_tempo`, `gma3_run_macro`,
  `gma3_timecode_transport`).

## SU-11 — Decimal read-back on multi-function channels (bug)

**Request:** Verify a raw DMX value on a channel whose functions split the DMX range.

**Depends on:** SU-05, SU-07.

**Repository:** gma3-mcp.

**Lua changes:** Possibly. The programmer op may need each row's channel-function DMX range.

**Evidence:** `gma3_set_attributes` with `Color1 = 104 decimal8` on the 180 W beams. The console selected the right
wheel slot, but the read-back reported a mismatch:
- the programmer reads 81.89 %, the value as a share of the active channel function's range (DMX 0–127,
  104/127);
- the tool expected 104/255 = 40.8 % ([fixtures.ts](src/tools/fixtures.ts), `decimal8` maps to `value / 255`).

The agent recognised it as a unit artifact and carried on. The same mapping is used for decimal16/24 and in
`gma3_set_attribute`.

**Status:** implemented, no bridge change. Decimal values are verified as DMX values against the programmer
row's raw 24-bit value, in `gma3_set_attribute`, `gma3_set_attributes` and the looks of `gma3_store_cues`
([docs/tools/fixtures.md](docs/tools/fixtures.md), probe record
[su-11-decimal-readback-macos-2.5.1.md](docs/probes/su-11-decimal-readback-macos-2.5.1.md), live test
`test/live/decimal-readback.live.ts` 1/1 on macOS onPC 2.5.1).

### Acceptance criteria

- A decimal value on a channel with several functions verifies against the function it falls in (or as a DMX
  value), for decimal8/16/24 in both tools.
- A real mismatch is still detected.
- The harness models a channel with several channel functions.

## SU-12 — Batch forms and compact results

**Request:** Do the same structured operation on many objects in one call, with the single form's checks.

**Depends on:** SB-01, SB-02, SB-03, SB-07, SU-05, SU-06.

**Repository:** gma3-mcp.

**Lua changes:** No.

**Evidence:** every tool that existed was used once or twice and then replaced by a Lua loop:

| Tool | First uses | Then in Lua |
| --- | --- | --- |
| `gma3_store_group` | 2 groups | 7 groups, items generated with x/y |
| `gma3_store_preset` | 1 preset | 6 presets |
| `gma3_store_macro` | 1 macro | 26 macros (20–45) |
| `gma3_assign_to_executor` | — | 30 assignments, `Unassign` then `Assign` with no check |
| `gma3_configure_sequence` | — | Off When Overridden on 17 sequences; Priority and KillProtect on one more |
| `gma3_store_cues` | 1 sequence | 12 sequences, 138 cues |
| `gma3_edit_macro_line` | — | a macro's lines rewritten |

The Lua ran in the Normal programmer with `ClearAll`, so the operator's programmer would have been lost; the tools
build in Preview. It replaced whatever was assigned without checking that the target was empty, and it read
nothing back. The agent's own read-back of the assignments indexed page children by position and showed every
executor empty.

The group item lists were the cost, not the speed:
- reversed ranges (`402.36` down to `.1`);
- mirrored halves;
- the Festoon's physical bulb order;
- rows of different lengths spread over one width.

Large results discouraged further calls: one `gma3_build_chase` result (18 cues) was 66.6 KB. The client saved it
to a file, and the agent read it back with a shell and Python.

**Status:** implemented, no bridge change ([docs/tools/README.md](docs/tools/README.md#batch-forms-su-12), probe
record [su-12-batch-forms-macos-2.5.1.md](docs/probes/su-12-batch-forms-macos-2.5.1.md), live test
`test/live/batch.live.ts` 1/1 on macOS onPC 2.5.1).
- The seven tools take a list (`groups`, `presets`, `macros`, `edits`, `assignments`, `sequences`), run each item
  through the single form, and report one line per item (`src/batch.ts`).
- Presets in a list are built from explicit content in Preview.
- Group specs gain reversed ranges and `rows` spread to a width. Cells in physical order wait for SU-19.
- `gma3_store_cues` and `gma3_build_chase` results are compact by default: an 18-step chase is about 4 KB, against
  66.6 KB in the field test.
- The live run found that the bridge's programmer scan of all fixtures misses subfixture index 0. It is fixed
  separately.

### Acceptance criteria

- Each of these tools takes a list:
  - `gma3_store_group`;
  - `gma3_store_preset` (each preset from explicit content: fixtures with values, intensity or presets, built in
    Preview);
  - `gma3_store_macro`;
  - `gma3_edit_macro_line`;
  - `gma3_assign_to_executor`;
  - `gma3_configure_sequence` (`sequences` with ranges);
  - `gma3_store_cues` (several sequences).
- Each item gets the single form's checks and read-back. Results are partial per item and nothing is retried.
- Group items take compact specs: ranges with a direction, rows spread to a width, and a fixture's cells in physical
  order (SU-19).
- Assignment checks each target is empty, or takes `replace` per item.
- Results are compact by default: outcome, verification, one line per item, and the observed cycle as a summary.
  `detail: true` gives every step. The field test's 18-cue chase result fits in a few KB.

## SU-13 — Phaser builder: whole rig, variants, shapes and phase spread

**Request:** Build a family of effects (sync, follow and mirror versions of a shape or a pattern) on any number of
fixtures and cells.

**Depends on:** SB-04, SU-12.

**Repository:** gma3-mcp.

**Lua changes:** Possibly, for a compact phaser read-back per fixture.

**Evidence:** `gma3_build_phaser` ran once to see which commands it sends. The agent then generated the effects in
Python and built them in Lua:
- 18 moves on the beams;
- 10 colour patterns × 3 modes on group 5 (132 items). The tool refuses more than 128 fixtures, which is the tool's
  own `MAX_FIXTURES`, not a console limit;
- 16 Festoon patterns × 3 modes on 72 cells (48 dimmer phasers).

What the tool could not express:
- the three variants of one effect;
- mirror as a per-fixture inversion (the second beam's Pan negated);
- a phase step per fixture (`At Phase 0 Thru 12780`, 180° between neighbours);
- shuffle (XShuffle);
- circles, figure 8s and cones in physical degrees;
- strand patterns (runner, comet, alternate, thirds, fill, scanner, sparkle).

The agent researched what `measure` means in the help pages: beats per cycle on the speed master. Its hand-written
builder set the step transitions while the steps were still being created, so only the last step kept them, and
30 presets had to be rebuilt. Checking the phase spread took a `gma3_programmer` read of about 21,000 lines, parsed
in Python.

**Status:** implemented, no bridge change ([docs/tools/phasers.md](docs/tools/phasers.md#whole-rig-variants-mirror-and-several-effects-su-13),
probe record [su-13-phaser-builder-macos-2.5.1.md](docs/probes/su-13-phaser-builder-macos-2.5.1.md), live test
`test/live/phaser-builder.live.ts` 1/1 on macOS onPC 2.5.1).
- Up to 1024 fixtures or cells, of several types (`gma3_store_preset`'s scope cap matches).
- `variants` (sync, follow, mirror) into consecutive named presets.
- `mirror` inverts attributes on every second wing.
- Phase as `{from, to}`, `{from, step}` or `"spread"`, and `shuffle`.
- Position shapes (circle, figure8, cone, fan, bounce) and dimmer patterns (runner, comet, alternate, thirds, fill,
  sparkle). A scanner is not expressible as one phaser.
- `effects`: several effects built in one Preview session, one line per preset.
- A compact phase summary per preset, and a compact result by default (140 fixtures: 3.5 KB).
- `measure` explained.
- Steps refuse widths above the console's 3200 %.

The SU-12 dependency ("several effects per call") is met inside the tool; it can move to `src/batch.ts` once SU-12 is
merged.

### Acceptance criteria

- No tool-side cap below what the console handles; a whole-rig effect over several fixture types in one call.
- `variants` (sync, follow, mirror) generate the versions of one effect into consecutive presets with names.
- Mirror inverts chosen attributes for one half of the fixtures (or wings); phase as from/to or a step per fixture;
  shuffle.
- Shape templates for position (circle, figure 8, cone, fan, bounce: size and centre in degrees) and pattern
  templates for cell rows.
- Several effects per call (SU-12), built in Preview, with step timing checked per step.
- The read-back summarises the phase per fixture compactly, without a full programmer read.
- The descriptions say what `measure` means.

## SU-14 — Cue contents: commands, phasers, ranges and overrides

**Request:** Store cues that do more than recall looks, and switch a sequence's triggers without losing its timing.

**Depends on:** SU-06, SU-13.

**Repository:** gma3-mcp.

**Lua changes:** No.

**Evidence:**
- **Command-only cues.** The clock sequences (20, 21 and 30; 10–16 cues each) are empty cues with a cue command
  (`SetGlobalVariable …; Go+ Macro 20`). `gma3_store_cues` needs content per cue and has no command field.
- **Many cues from presets.** 12 sequences of "one cue per preset" (presets 21.11–40 and 1.101–316), each deleted
  first, then 90 cue fades set.
- **Strobe overrides.** Sequences 90–92 each hold a phaser cue, have priority High, and are flashed from executors.
  With the tools that takes `gma3_build_phaser`, `gma3_store_cues` and `gma3_configure_sequence` per sequence.
- **Off When Overridden.** The first strobe flash switched the base look off, because Off When Overridden defaults
  to Yes. The agent set it to No on 17 sequences in Lua.
- **TrigTime wiped.** The sync-on macro switched the clock cues to trigger Go, which sets their TrigTime to 0. The
  sync-off macro then switched back to Time with no times, so the clocks raced. `gma3_observe_tempo` found it, and the agent
  restored the times and rewrote the macro in Lua.

**Status:** implemented, no bridge change ([docs/tools/cuelists.md](docs/tools/cuelists.md), probe record
[su-14-cue-contents-macos-2.5.1.md](docs/probes/su-14-cue-contents-macos-2.5.1.md), live test
`test/live/cue-contents.live.ts` 1/1 on macOS onPC 2.5.1).
- Cue commands in all three tools, and command-only cues.
- `presets: {pool, from, to}` ranges, named after the presets.
- `replace: true`, keeping the executor assignments (checked).
- A phaser in a look, in `gma3_build_phaser`'s step form. Templates and SU-13's forms come with SU-13.
- `sequence_settings` and an override report, with `protect_running`.
- Wiped trigger times reported, and `keep_times` / `restore_times`.

### Acceptance criteria

- A `command` per cue in `gma3_store_cues`, `gma3_edit_cues` and `gma3_build_chase`, read back. Cues with a command
  and no look.
- One cue per preset from a range (`presets: {pool, from, to}`), named after the presets.
- `replace: true` rebuilds an existing sequence and keeps its executor assignment.
- A cue's look can include a phaser definition (built as SU-13 does); sequence settings (priority) in the same call.
- Setting trigger `go` on Time cues reports the TrigTime it wipes and can keep it for a later switch back. Or a
  sequence-level "free-run / step" switch keeps the times.
- Building an override sequence (priority above Normal) says which running sequences it will switch off, and offers
  to set Off When Overridden on them.

## SU-15 — Console variables

**Request:** Read and set the show's global and user variables, and use them in macros and cue commands.

**Depends on:** SB-07.

**Repository:** gma3-mcp.

**Lua changes:** Possibly: a read-only op over `GlobalVars()` and `UserVars()`.

**Evidence:** the show switches modes through global variables. `HexCol` holds the active sequence, and macros run
`Goto Sequence $HexCol Cue $HexCue`. With no tool, the agent tested, read and deleted variables in Lua and through
`SetGlobalVariable` commands.

It concluded that `$variables` do not expand in commands sent through the bridge, and wrote that into its memory.
Its test read `HasActivePlayback` straight after the `Goto`, which reads false for a frame (SU-06), so the
conclusion is unproven.

**Probe (run early, with SU-14):** `$variables` do expand in commands sent through the bridge's `cmd`
(`Label Sequence 940 $mcpprobe` named it after the variable, and `Store Sequence $mcpprobe` created the sequence),
[su-14-cue-contents-macos-2.5.1.md](docs/probes/su-14-cue-contents-macos-2.5.1.md#su-15-variables-in-commands-sent-through-the-bridge).

**Status:** implemented in bridge 0.31.0 ([docs/tools/variables.md](docs/tools/variables.md), probe record
[su-15-console-variables-macos-2.5.1.md](docs/probes/su-15-console-variables-macos-2.5.1.md), live test
`test/live/variables.live.ts` 1/1 on macOS onPC 2.5.1).
- `gma3_variables` reads typed global and user variables by name, plus every `$variable` the macros reference.
  Variables cannot be enumerated on 2.5.1.
- `gma3_set_variable` sets with a type or deletes, reads back, and has a batch form.
- `$variables` are checked in macro lines and cue commands, and the expansion result is documented in `gma3_command`.

### Acceptance criteria

- A probe settles whether the bridge's `cmd` expands `$variables`, with a read-back a frame later. Document the
  result in `gma3_command`.
- List, read, set and delete global and user variables, read back.
- `gma3_store_macro` and the cue command field (SU-14) accept `$variable` references and check that the variable
  exists.

## SU-16 — Live playback and value reads

**Request:** See which sequences are running and where, and watch values change, without Lua.

**Depends on:** SU-06, SU-09.

**Repository:** gma3-mcp.

**Lua changes:** Possibly: a current-cue field in the sequence reads.

**Evidence:** seven Lua reads listed every active sequence with its current cue and the variables. One read the
triggers of every cue of four sequences. `gma3_sequences` reports `hasActivePlayback` but not the current cue, and
`gma3_cues` reads one sequence per call.

To check the strobe, the agent wrote a busy-wait loop in Lua sampling `GetDMXValue`, which the server instructions
forbid. Every sample was nil because the universe is not granted.

**Status:** implemented in bridge 0.32.0 ([docs/tools/live-reads.md](docs/tools/live-reads.md), probe record
[su-16-live-reads-macos-2.5.1.md](docs/probes/su-16-live-reads-macos-2.5.1.md), live test
`test/live/live-reads.live.ts` 8/8 on macOS onPC 2.5.1).
- Sequence reads carry `currentCue {no, name}` while the sequence plays and `lastCue` after Off (`CurrentCue` is
  sticky). This covers `gma3_sequences`, `gma3_executors` and `gma3_cues`, which also reads up to 20 sequences at once.
- `gma3_goto_cue` verifies the cue 100 ms after the command, and `gma3_playback` reports the state of a Sequence
  or Executor target.
- `gma3_programmer` has a compact form: `fields`, and `by_fixture` for one entry per fixture.
- `gma3_observe_values` samples programmer or output values for up to 30 s and reports the timed changes. Output
  that cannot be read is reported before any sampling.

### Acceptance criteria

- The current cue (number and name) per sequence in `gma3_sequences` and `gma3_executors`, read a frame after a
  change. Several sequences per read, with cue fields such as triggers.
- A compact programmer read: chosen fields, a summary per fixture.
- A value observer samples a fixture's programmer or output values for a few seconds and reports the changes. It
  says up front when output cannot be read (not granted).
- `gma3_goto_cue` and `gma3_playback` read the playback state back after the frame delay.

## SU-17 — Resync and the tempo-sync plugin

**Request:** Realign running effects to the beat, and see and configure the console's external tempo sync from the
MCP tools.

**Depends on:** SB-06, and the status and configuration interface of
[bdstark/gma3-beat-sync](https://github.com/bdstark/gma3-beat-sync) (its BS-01 and BS-02).

**Repository:** gma3-mcp for the tools. The sync engine is a console plugin in a separate GPL repository,
bdstark/gma3-beat-sync, which needs nothing from this one.

**Lua changes:** No. The plugin publishes its own state.

**Evidence:** the operator asked for pattern switching synchronised to an external tempo source. grandMA3 2.5 cannot
follow one: speed masters follow tap, learn, a fader or the sound input. So the agent wrote an external Python
helper. It sent commands over OSC (SU-18) and realigned the pattern sequences with a raw
`ReSync Sequence 1 + 11 Thru 19 + 31 Thru 33 + 90 Thru 92`.

A probe on 2026-10-15 showed that the console's own Lua can do the network part (UDP multicast through
`socket.udp4()`, about 16.6 ms per frame). That work moved to the plugin repository.

**Boundary:** this repository stays MIT and takes no code from bdstark/gma3-beat-sync. The tools talk to the plugin only
through the console (its published status and its configuration), as two separate programs.

### Acceptance criteria

- `resync` in `gma3_playback` for sequences and ranges, read back, with a statement of what it does to running
  phasers and chases.
- Once the plugin's interface exists: a status tool (running, peers, tempo, beat, drift) and configuration of its
  actions, read back. Both say plainly when the plugin is not installed or not running.
- No OSC or console network change is involved.

**Status:** implemented with no bridge change ([docs/tools/tempo-sync.md](docs/tools/tempo-sync.md), probe record
[su-17-resync-tempo-sync-macos-2.5.1.md](docs/probes/su-17-resync-tempo-sync-macos-2.5.1.md), live test
`test/live/tempo-sync.live.ts` 4/4 on macOS onPC 2.5.1).
- `gma3_playback` `resync`: sequences, lists and ranges, each checked first. ReSync is sent once, and each
  sequence's state is read back. Phasers are realigned gradually (the manual); a running chase kept its cue and
  step timing (measured).
- `gma3_tempo_sync_status`: whether the plugin is imported and running (by its State and the age of its Updated
  against the console clock), its readings, and its configuration. It says plainly when the plugin is not imported
  or not running, and how to start it.
- `gma3_configure_tempo_sync`: master, quantum, start/stop, resync list, event and beat commands, actions, tempo
  threshold and lead, validated and read back. Interfaces (multicast) is refused as a network setting.

## SU-18 — OSC configuration

**Request:** Read and configure the console's OSC input and output.

**Depends on:** SU-09.

**Repository:** gma3-mcp.

**Lua changes:** Likely: read and write `ShowData().OSCBase` and its data lines, whitelisted like `dmx.set`.

**Evidence:** for its tempo-sync helper the agent read `OSCBase` and the network interfaces in Lua, then set:
- `EnableInput`, and on OSC line 1 `Receive`, `ReceiveCommand` and a name;
- `PreferredIP`.

Commands sent to UDP 8000 were dropped until `PreferredIP` changed from the default `10.0.0.0/8`, which matched no
interface on this Mac, to `127.0.0.0/8`. The agent tested with `gma3_command` over OSC, using variables as markers,
and checked the socket with `lsof`.

### Acceptance criteria

- Read OSC input and output: enabled, interface or preferred IP, port, prefix, receive, receive command, send.
- Configure them with validation and read-back. Accepting commands from beyond loopback needs `network: true` and a
  plain statement that anyone on that network can then run commands.
- Verify that input works by sending a loopback test message that the console provably received. No shell needed.

**Status:** implemented in bridge 0.33.0 ([docs/tools/osc.md](docs/tools/osc.md), probe record
[su-18-osc-config-macos-2.5.1.md](docs/probes/su-18-osc-config-macos-2.5.1.md), live test `test/live/osc.live.ts` 6/6
on macOS onPC 2.5.1).
- `gma3_osc` reads the switches, Interface and PreferredIP, every line and the interfaces. It says who can run
  commands: the console listens on every interface whatever Interface and PreferredIP say.
- `gma3_configure_osc` configures with validation and read-back. It re-binds input after a port change, since a port
  change alone does not take effect. A port that newly runs commands on a networked machine needs `network: true`
  and a plain statement.
- `gma3_test_osc_input` sends a loopback `/cmd` that sets a marker variable and reads it back.
- The field test's drop-until-PreferredIP-changed did not reproduce: PreferredIP only picks Interface.

## SU-19 — Fixture-type data: cell order and wheels

**Request:** Know a string's physical cell order and a wheel's slots from the fixture type.

**Depends on:** SU-07, SU-08.

**Repository:** gma3-mcp.

**Lua changes:** Likely: wheels in `patch.typeStructure`.

**Evidence:**
- **Cell order.** In "Pixel Mode - 2 string" the Festoon's bulbs are not in cell order; the two strings interleave
  as cells 1–9, 19–29, 10–18, 30–40. The agent computed the layout points in Python and passed them explicitly to
  `gma3_layout_cells`, and wrote every group item list in that order by hand.
- **Wheels.** The beam's colour channel sets are unnamed ("colour 1..11"), so the agent read the type's wheels in
  Lua. Every slot of this grandMA2-library type reads white, so the slot colours are not in the type at all.

### Acceptance criteria

- A probe establishes whether the physical order can be derived from the type (geometry names, breaks, positions).
  If not, a cell order can be given once and used by `gma3_layout_cells` and by group item specs (SU-12).
- `gma3_patch_type_structure` lists wheels: wheel name, slots with name, colour and media, and the channel-set DMX
  range that selects each slot. It says when slot colours are unset, so the agent asks instead of guessing.

**Status:** implemented in bridge 0.34.0 ([docs/tools/patch.md](docs/tools/patch.md#cell-order-su-19), probe record
[su-19-fixture-type-data-macos-2.5.1.md](docs/probes/su-19-fixture-type-data-macos-2.5.1.md), live test
`test/live/fixture-type-data.live.ts` on macOS onPC 2.5.1: 4 checks passed, the layout preview skipped while the
console's patch copy was open).
- **The physical order can be derived from the type:** it is the cells' DMX order. The Festoon's 2-string mode reads
  `1-9, 19-29, 10-18, 30-40`, and in that order every step between bulbs is one 2 ft pitch of the type's positions.
  `gma3_patch_type_structure` reports it as `cellOrder`. `gma3_layout_cells` takes `order: "dmx"`, and group lists
  take `{cells_of: <fid>, order: "dmx"}`. No order has to be given by hand.
- `wheels`: slots with name, colour, media and the channel sets (DMX range) that select them; `slotColors: "unset"`
  with a note to ask when every slot of a colour wheel reads white.

## SU-20 — Save the show

**Request:** Save the show file from a chat with no shell.

**Depends on:** KB-25.

**Repository:** gma3-mcp.

**Lua changes:** Possibly: a read of the show files that exist.

**Evidence:** the agent saved with a raw `SaveShow` after checking the shows folder with shell commands, so it would
not overwrite another file. Desktop chat has no shell. In an earlier session `SaveShow` opened a confirmation
dialog (KB-25 handles dialogs). This time it answered `OK`, and the bridge kept running.

### Acceptance criteria

- Save under the current or a new name. Refuse to overwrite a different show's file unless asked.
- Report the file written, its size and time. Handle a confirmation dialog when one opens.
- Read the show files that exist, so no shell is needed.

**Status:** implemented in bridge 0.35.0 ([docs/tools/show.md](docs/tools/show.md), probe record
[su-20-save-show-macos-2.5.1.md](docs/probes/su-20-save-show-macos-2.5.1.md), live test `test/live/save-show.live.ts`
4/4 on macOS onPC 2.5.1).
- `gma3_show_files` lists the shows folder (name, size, time; the bridge corrects DirList's local-time-as-UTC).
- `gma3_save_show` saves under the current name (no dialog) or a new one. It answers SaveShow's own "Change show file
  name?" and, with `overwrite: true`, "... and overwrite existing show file?" dialogs. It refuses another show's file
  without `overwrite`, never answers another dialog, and reports the file written.
- SaveShow is queued with CmdIndirect, so a dialog cannot stall the bridge.

## Recommended delivery order

SU-01 and SU-02 first (bridges 0.25.1 and 0.25.2). Then SU-03: without import, a new show cannot be set up without Lua or a
shell. SU-04, SU-05 and SU-06 remove most of the remaining Lua from a typical setup; SU-10 is small and can go with
any of them. SU-07 precedes SU-08, which needs a design decision. SU-09 is independent.

From the second field test:
- SU-11 first (a bug).
- Then SU-12: the batch forms remove the most Lua and set the result shape the later tickets use.
- SU-13 and SU-14 build on it.
- SU-15's probe (does `cmd` expand `$variables`) is small. Run it early, since SU-14 depends on its answer.
- SU-16, SU-18, SU-19 and SU-20 are independent.
- SU-17's `resync` is independent. Its plugin tools wait for the interface that bdstark/gma3-beat-sync's BS-01 and BS-02
  define.

## References

- [AddFixtures Lua function](https://help.malighting.com/grandMA3/2.5/HTML/lua_objectfree_addfixtures.html)
- [Import keyword](https://help.malighting.com/grandMA3/2.5/HTML/keyword_import.html)
- [Position fixtures in the 3D space](https://help.malighting.com/grandMA3/2.5/HTML/patch_position_fixtures.html)
- Field-test transcripts: Claude Code sessions in `~/gma3-enduser/showtest` (2026-10-14 and 2026-10-15, session
  6626864f)
- [bdstark/gma3-beat-sync](https://github.com/bdstark/gma3-beat-sync): the tempo-sync console plugin (GPL, separate repository)
