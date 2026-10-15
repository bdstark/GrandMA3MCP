# Workflow and inspection tools

Per-area documentation for the tools built on the shared result model (see "Workflow tools" in the top-level
README). Each page lists the tool parameters, the exact bridge requests and console commands sent and their
order, whether the tool changes the selection or programmer, what read-back verifies and what it cannot, and
the live test procedure on a disposable show.

| Area | Tools | Page |
| --- | --- | --- |
| Fixture programming (FR-03) | `gma3_select`, `gma3_set_attribute`, `gma3_set_color`, `gma3_set_position`, `gma3_clear_programmer` | [fixtures.md](fixtures.md) |
| Looks, presets and release (SU-05; preset read-back needs bridge 0.27.0) | `gma3_set_attributes`, `gma3_apply_preset`, `gma3_release_attributes` | [fixtures.md](fixtures.md) |
| Cue storage and editing (FR-04, FR-05) | `gma3_store_cue`, `gma3_store_cue_part`, `gma3_set_cue_timing`, `gma3_set_cue_trigger`, `gma3_goto_cue`, `gma3_delete_cue` | [cues.md](cues.md) |
| Cue lists and chases in batches (SU-06; built in Preview, needs `exclusive: true`; preset read-back needs bridge 0.27.0) | `gma3_store_cues`, `gma3_edit_cues`, `gma3_build_chase` | [cuelists.md](cuelists.md) |
| Executors (FR-06) | `gma3_assign_to_executor`, `gma3_label_executor` | [executors.md](executors.md) |
| Structured inspection (FR-07 .. FR-10) | `gma3_fixture_attributes`, `gma3_programmer`, `gma3_fixture_output`, `gma3_dmx`, `gma3_cue_contents` | [inspection.md](inspection.md) |
| Console input (KB-05, opt-in on the console) | `gma3_input_interaction`, `gma3_hardkey`, `gma3_keyboard`, `gma3_type`, `gma3_input_sequence`, `gma3_hardkeys_status`, `gma3_hardkeys_release_all` | [input.md](input.md) |
| Console feedback (KB-06, read-only) | `gma3_feedback` | [feedback.md](feedback.md) |
| Patch (KB-26, bridge 0.19.0; changes need `exclusive: true`) | `gma3_patch_types`, `gma3_patch_list`, `gma3_patch_add`, `gma3_patch_set`, `gma3_patch_remove` | [patch.md](patch.md) |
| Fixture-type library (SU-03, bridge 0.26.0; changes need `exclusive: true`) | `gma3_patch_library`, `gma3_patch_import`, `gma3_patch_remove_type` | [patch.md](patch.md) |
| Fixture-type structure (SU-07, bridge 0.28.0; read-only) | `gma3_patch_type_structure` (and cell counts in `gma3_patch_types`, `gma3_patch_list`) | [patch.md](patch.md) |
| Fixture positions in 3D (SU-04; no undo, refused while the patch copy is open) | `gma3_fixture_positions`, `gma3_place_fixtures` | [positions.md](positions.md) |
| Cell layouts (SU-08, bridge 0.29.0; no undo, need `exclusive: true`) | `gma3_layout_cells`, `gma3_assign_cell_layout` | [positions.md](positions.md#cell-layouts-su-08) |
| Executor and sequence playback configuration (SB-01) | `gma3_executor_settings`, `gma3_configure_executor`, `gma3_configure_sequence` | [playback.md](playback.md) |
| Groups with selection grids and MAtricks (SB-02, bridge 0.21.0; storing a group needs `exclusive: true`) | `gma3_selection_grid`, `gma3_store_group`, `gma3_matricks`, `gma3_configure_matricks` | [groups.md](groups.md) |
| Presets with explicit storage rules (SB-03, bridge 0.22.0; storing needs `exclusive: true`) | `gma3_preset`, `gma3_store_preset` | [presets.md](presets.md) |
| Phasers and effect distributions (SB-04, bridge 0.23.0; building needs `exclusive: true`) | `gma3_build_phaser`, `gma3_phaser_release` | [phasers.md](phasers.md) |
| Recipes and cooking (SB-05, bridge 0.24.0) | `gma3_recipes`, `gma3_edit_recipe`, `gma3_cook_recipes` | [recipes.md](recipes.md) |
| Shared speed and synchronisation (SB-06; sequence links through `gma3_configure_sequence`) | `gma3_speed_masters`, `gma3_configure_speed_master`, `gma3_speed_master_action`, `gma3_observe_tempo` | [speed.md](speed.md) |
| Macros as show actions (SB-07; authoring never runs a macro) | `gma3_macros`, `gma3_store_macro`, `gma3_edit_macro_line`, `gma3_run_macro` | [macros.md](macros.md) |
| Timecode shows (SB-08, bridge 0.25.0; building never plays or records) | `gma3_timecodes`, `gma3_build_timecode`, `gma3_timecode_transport` | [timecode.md](timecode.md) |

`AGENT-RULES.md` records the implementation rules every area follows (bridge-only, no retries, shared
validation and result helpers, serialised mutations, documentation and test requirements).

## Serialisation caveat (applies to every mutating tool)

Mutations issued by this MCP server run one at a time through a single lock, so a multi-command workflow is
not interleaved with another tool call from the same server. A workflow holds the lock from its first command
through its read-back, and `gma3_lua` requests take the same lock because a script may call `Cmd()` or
`Set()`. The lock orders only this process's requests. It does not stop another console operator, another MCP
server or client, or a macro from changing the selection or programmer between two commands. Treat every
result's `verification` field as the source of truth, not the lock.

The console input tools add a bridge-side guard that does reach every client: while any client owns console input
(an open interaction, a running sequence, a held key), the bridge refuses `cmd`, `set`, `setfader`, `lua` and the mutating `patch.*` ops
(`patch.enter`, `patch.add`, `patch.set`, `patch.remove`, `patch.commit`, `patch.import`, `patch.removeType`) from every connection with `[busy]`, so a mutating tool can fail with that error while someone else types or holds a key. Reads are
never refused, `gma3_feedback` included. See [input.md](input.md#who-owns-an-interaction).
