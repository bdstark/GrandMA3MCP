# Show-building features

Proposed features for programming beyond cues, playback configuration, and show automation.

Identifiers SB-01 through SB-08 are provisional. Features appear after their dependencies. These are proposals; console API support must be established by the probes described below.

## Scope and architecture

All eight features belong primarily in **GrandMA3MCP**. The control-surface repository needs changes only when exposing new controls or feedback.

These workflows are not necessarily UI-only. grandMA3 documents command support for selection grids and preset storage options. Wrap Around belongs to the sequence, while fader and button functions belong to its executor assignment. Tools must preserve those distinctions.

### Shared acceptance criteria

- Begin each feature with a small live probe establishing supported writes, readback, side effects, and platform/version coverage.
- Prefer existing command and property operations. Add narrowly scoped Lua operations only when existing operations cannot provide reliable access. Do not make arbitrary Lua execution a hidden dependency.
- Structured tools work with arbitrary Lua disabled.
- Provide a preview of targets and intended changes, with explicit overwrite behavior.
- Read back results, stop dependent steps after failure, and report partial or unknown outcomes without automatically retrying mutations.
- Respect existing input ownership. Workflows that change the programmer or shared UI require exclusive use unless preservation or isolation is verified. An exclusive-use acknowledgement is an operator requirement, not a console lock.
- Use KB-27 dialog control only where a probe establishes that it is necessary. Never open blocking dialogs on the plugin thread.
- Reuse existing resolution, validation, serialization, mutation coordination, and inspection facilities. Any required Lua expansion must be documented before implementation.

## SB-01 — Configure executor assignments and sequence playback

**Request:** Configure a playable sequence and its executor completely, including a chase that actually loops.

**Depends on:** Existing executor assignment and cue tools.

**Repository:** GrandMA3MCP.

**Lua changes:** Not expected for configuration through existing commands/property access. Add Lua only if the probe identifies missing structured readback.

**Status:** implemented without Lua changes: `gma3_executor_settings`, `gma3_configure_executor`, `gma3_configure_sequence` ([docs/tools/playback.md](docs/tools/playback.md), probe record [sb-01-playback-macos-2.5.1.md](docs/probes/sb-01-playback-macos-2.5.1.md), live test `test/live/playback.live.ts` 1/1 on macOS onPC 2.5.1). Sequence executors only in the first release.

### Acceptance criteria

- Inspect and configure a page-qualified executor's assignment, fader function, button press/release functions, and supported executor configuration.
- Configure sequence settings separately: Wrap Around, priority, restart/release behavior, and other qualified playback options.
- Identify which object owns each protection setting; refuse locked targets unless unlocking is explicitly requested.
- Validate supported function choices against the assigned object.
- Explain when changing a sequence affects other executors referencing it.
- Demonstrate a three-cue timed chase completing two cycles, plus a non-looping variant.
- Verify Temp/Flash release behavior and that configuration alone does not start playback.

## SB-02 — Build groups with selection grids and MAtricks

**Request:** Describe fixture arrangements and distribution rules numerically instead of arranging everything by hand.

**Depends on:** Existing fixture/group access.

**Repository:** GrandMA3MCP.

**Lua changes:** Likely for structured selection-grid readback if existing object inspection cannot expose coordinates and order. Prefer existing commands for creation.

**Status:** implemented: `gma3_selection_grid`, `gma3_store_group`, `gma3_matricks`, `gma3_configure_matricks` ([docs/tools/groups.md](docs/tools/groups.md), probe record [sb-02-groups-macos-2.5.1.md](docs/probes/sb-02-groups-macos-2.5.1.md), live test `test/live/groups.live.ts` 1/1 on macOS onPC 2.5.1). Lua expansion as expected: two read-only bridge ops (0.21.0), `group.read` (a group's `SelectionData`) and `selection.grid` (`SelectionFirst` / `SelectionNext`); creation uses `Grid`, `Fixture`, `Store` and `set` only. The console keeps a stored group in patch order and distributes along the grid, so the cells define the order. MAtricks timing distributions are verified as object settings only (not readable per fixture).

### Acceptance criteria

- Create or update a group from an ordered fixture/subfixture list with explicit X/Y/Z selection-grid coordinates.
- Offer row, rectangle, and mirrored arrangement helpers that expand into a reviewable coordinate list.
- Distinguish selection-grid coordinates from physical fixture positions.
- Define behavior for duplicate fixtures, shared grid positions, and gaps; never silently discard them.
- Create and read MAtricks objects with supported axis-specific wings, blocks, groups, and phase/fade/delay distributions.
- Recall the stored group and verify its selection order and grid.
- Demonstrate a left-to-right distribution and a symmetrical center-out distribution.

## SB-03 — Create reusable presets with explicit storage rules

**Request:** Build a dependable palette of colors, positions, beams, and combined looks.

**Depends on:** Existing programmer inspection; SB-02 for grid-dependent presets.

**Repository:** GrandMA3MCP.

**Lua changes:** Not expected for storage options. Structured preset-content/reference inspection may require a narrow Lua reader.

**Status:** implemented: `gma3_store_preset`, `gma3_preset` ([docs/tools/presets.md](docs/tools/presets.md), probe record [sb-03-presets-macos-2.5.1.md](docs/probes/sb-03-presets-macos-2.5.1.md), live test `test/live/presets.live.ts` 1/1 on macOS onPC 2.5.1). Storage uses one `Store Preset` command with every content-deciding option explicit; the narrow Lua reader is two read-only bridge ops (0.22.0), `preset.read` (stored rows with mode, layers and embedded sources, dependencies) and `preset.context` (pool defaults and the operator's store preferences). The Look store preference cannot be overridden per store (`/Look "No"` turns it on), so the tool refuses while it is on.

### Acceptance criteria

- Store or update with explicit selective, global, or universal mode; handle forced conversion separately.
- Specify fixture scope, attribute filters, data layers, and merge/overwrite behavior.
- Support qualified input-filter and embedding options without silently changing operator defaults.
- Report actual stored content and references, rather than treating a requested mode as proof of the result.
- Preserve embedded references and detect invalid dependencies; disclose incomplete dependency inspection.
- Test mixed fixture types, selective positions, reusable colors, and an embedded preset whose source is subsequently updated.
- Refuse unrequested programmer content.

## SB-04 — Author phasers and effect distributions

**Request:** Build repeatable effects from structured steps and timing.

**Depends on:** SB-02 and SB-03.

**Repository:** GrandMA3MCP.

**Lua changes:** Likely for detailed phaser inspection or manipulation not covered by qualified commands. Extend existing phaser/programmer readers rather than creating a parallel representation.

### Acceptance criteria

- Describe steps by attribute, absolute/relative values or preset references, and supported timing/transition parameters.
- Configure speed, phase distribution, direction, and supported repetition settings.
- Clearly distinguish step timing, fixture distribution, and playback speed.
- Store the result as a reusable preset and read back every supported step.
- Provide templates for a two-step dimmer chase, alternating colors, and a pan/tilt movement.
- Reject unsupported attributes and incompatible fixture selections before mutation.
- Preview playback only when explicitly requested; provide a reliable stop/release path.
- Verify that creating or editing one effect leaves unrelated programmer data untouched—or require an empty programmer.

## SB-05 — Build and cook recipe-based presets and cues

**Request:** Combine groups, presets, and MAtricks into reusable programming that adapts to a changed rig.

**Depends on:** SB-02 and SB-03; SB-04 for phaser recipes.

**Repository:** GrandMA3MCP.

**Lua changes:** Likely for structured recipe-line creation and inspection. Reuse property operations wherever the probe proves sufficient.

### Acceptance criteria

- List, create, edit, reorder, and remove recipe lines in explicit presets or sequence/cue/part targets.
- Preserve references to selections, values, and MAtricks.
- Separate editing a recipe definition from cooking its output.
- Make cooking scope and replacement/merge behavior explicit.
- Show affected targets before cooking; disclose unavailable dependency information.
- Demonstrate changing group membership, recooking, and verifying the resulting fixture coverage.
- Test missing references, empty selections, multiple recipe lines, and protection of unrelated cue data.
- State explicitly which standard and phaser recipe capabilities are supported by the first release.

## SB-06 — Configure shared speed and synchronization

**Request:** Give related chases and effects a coherent tempo, controllable from MCP or a surface.

**Depends on:** SB-01; SB-04 for phaser integration.

**Repositories:** GrandMA3MCP; optional control-surface integration in the surface repository.

**Lua changes:** Not expected for basic master configuration if existing master/property operations suffice. New live synchronization feedback may require Lua.

### Acceptance criteria

- Inspect and configure supported speed-master assignments, BPM, multipliers, and learn/tap behavior.
- Distinguish speed masters from rate masters and cue timing.
- Report configured tempo separately from any observable effective tempo.
- Treat manual BPM, tap tempo, and sound-derived synchronization as distinct capabilities.
- Probe sound-driven operation separately; do not claim audio synchronization merely because BPM can be written.
- Report unavailable source or synchronization status explicitly.
- Demonstrate two playbacks following one master while an independent playback remains unaffected.
- Optionally map qualified surface controls to tap, speed adjustment, and tempo feedback using the existing control path.

## SB-07 — Author macros as reusable show actions

**Request:** Build inspectable macros for setup, playback, and operator workflows.

**Depends on:** Existing object/property tools. Earlier SB features supply useful macro targets but are not mandatory dependencies.

**Repository:** GrandMA3MCP.

**Lua changes:** Not expected if macro-line creation and properties are accessible through existing operations.

### Acceptance criteria

- Create, read, and edit ordered macro lines, commands, waits, and supported execution properties.
- Preserve exact command text and line order on round-trip inspection.
- Distinguish creating a macro from executing it; creation never runs it.
- Validate known references while allowing explicit raw command lines.
- Support labels and explicit replace/merge behavior.
- Test a setup macro, a playback macro, and a macro containing a manual wait.
- Report execution as dispatched or observed; do not infer completion of every line from launch success.

## SB-08 — Author and inspect timecode shows

**Request:** Build timed cue and control events from structured timestamps, without requiring manual timeline placement.

**Depends on:** SB-01; SB-07 when macro events are supported.

**Repository:** GrandMA3MCP.

**Lua changes:** Likely for structured access to timecode hierarchy and events. Feasibility-gate writes before committing to full timeline editing.

### Acceptance criteria

- Inspect and create timecode shows, track groups, tracks, time ranges, and qualified event types.
- Accept explicit time units and frame rates; define rounding and same-time event ordering.
- Read back event targets, timestamps, actions, and applicable values.
- Support cue events first; add fader automation and recording only after separate probes.
- Distinguish configuring a source, arming recording, starting playback, and receiving external timecode.
- Editing never implicitly plays or records.
- Test seeking, stopping, repeated playback, missing targets, and press/release event pairs.
- Demonstrate a short timed show with several cues and verify event order.

## Recommended delivery order

Start with SB-01 to address the quick-show looping problem directly. Follow with SB-02 through SB-05 to establish reusable programming building blocks. Add SB-06 for shared tempo control. SB-07 can proceed independently once existing object/property access is qualified; SB-08 follows the relevant playback and macro work.

## References

These references establish console concepts and documented functionality. They do not establish that every proposed operation is accessible through the current bridge; live probes remain required.

- [Selection-grid command](https://help.malighting.com/grandMA3/2.5/HTML/keyword_grid.html)
- [Preset command and storage options](https://help.malighting.com/grandMA3/2.5/HTML/keyword_preset.html)
- [Sequence settings](https://help.malighting.com/grandMA3/2.5/HTML/cue_sequence_settings.html)
- [Executor assignment and functions](https://help.malighting.com/grandMA3/2.5/HTML/executor_assign.html)
- [Recipe editor](https://help2.malighting.com/grandMA3/2.5/HTML/recipe-sheet.html)
- [Speed masters](https://help.malighting.com/grandMA3/2.5/HTML/masters_speed.html)
- [Timecode shows](https://help.malighting.com/grandMA3/2.5/HTML/timecode.html)
