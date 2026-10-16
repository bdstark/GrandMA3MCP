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
| DMX universes and output (SU-09, bridge 0.30.0; changes need `exclusive: true`, network output `network: true`) | `gma3_dmx_output`, `gma3_configure_dmx_output` | [dmx-output.md](dmx-output.md) |
| Executor and sequence playback configuration (SB-01) | `gma3_executor_settings`, `gma3_configure_executor`, `gma3_configure_sequence` | [playback.md](playback.md) |
| Groups with selection grids and MAtricks (SB-02, bridge 0.21.0; storing a group needs `exclusive: true`) | `gma3_selection_grid`, `gma3_store_group`, `gma3_matricks`, `gma3_configure_matricks` | [groups.md](groups.md) |
| Presets with explicit storage rules (SB-03, bridge 0.22.0; storing needs `exclusive: true`) | `gma3_preset`, `gma3_store_preset` | [presets.md](presets.md) |
| Phasers and effect distributions (SB-04, bridge 0.23.0; building needs `exclusive: true`) | `gma3_build_phaser`, `gma3_phaser_release` | [phasers.md](phasers.md) |
| Recipes and cooking (SB-05, bridge 0.24.0) | `gma3_recipes`, `gma3_edit_recipe`, `gma3_cook_recipes` | [recipes.md](recipes.md) |
| Shared speed and synchronisation (SB-06; sequence links through `gma3_configure_sequence`) | `gma3_speed_masters`, `gma3_configure_speed_master`, `gma3_speed_master_action`, `gma3_observe_tempo` | [speed.md](speed.md) |
| Macros as show actions (SB-07; authoring never runs a macro) | `gma3_macros`, `gma3_store_macro`, `gma3_edit_macro_line`, `gma3_run_macro` | [macros.md](macros.md) |
| Timecode shows (SB-08, bridge 0.25.0; building never plays or records) | `gma3_timecodes`, `gma3_build_timecode`, `gma3_timecode_transport` | [timecode.md](timecode.md) |

Console variables (SU-15, bridge 0.31.0): `gma3_variables`, `gma3_set_variable` ([variables.md](variables.md)).

Live playback and value reads (SU-16, bridge 0.32.0): the current cue in `gma3_sequences`, `gma3_cues` (several
sequences) and `gma3_executors`; read-back in `gma3_goto_cue` and `gma3_playback`; the compact `gma3_programmer`;
`gma3_observe_values` ([live-reads.md](live-reads.md)).

Saving the show (SU-20, bridge 0.35.0; `exclusive: true`, another show's file needs `overwrite: true`):
`gma3_show_files`, `gma3_save_show` ([show.md](show.md)).

Fixture-type data (SU-19, bridge 0.34.0): `cellOrder` and `wheels` in `gma3_patch_type_structure`
([patch.md](patch.md#cell-order-su-19)); `order: "dmx"` in `gma3_layout_cells`; `{cells_of, order}` in group lists.

OSC input and output (SU-18, bridge 0.33.0; changes need `exclusive: true`, a newly opened command port on a
networked machine `network: true`): `gma3_osc`, `gma3_configure_osc`, `gma3_test_osc_input` ([osc.md](osc.md)).

`AGENT-RULES.md` records the implementation rules every area follows (bridge-only, no retries, shared
validation and result helpers, serialised mutations, documentation and test requirements).

## Tool discovery (SU-10)

The server sends instructions on every start (`src/discovery.ts`). They give:
- a short map from setup and show tasks to these tools;
- the tools that watch the console over time on the server side (`gma3_observe_tempo`, `gma3_observe_values`, `gma3_build_chase`,
  `gma3_run_macro`, `gma3_timecode_transport`), so no Lua waiting loop is written against the 5 s Lua budget;
- `gma3_command` and `gma3_lua` as fallbacks only.

A stale build's warning (PR #45) comes first. The descriptions of `gma3_lua` and `gma3_command` start with the same
pointer to the structured tools. `test/discovery.test.ts` keeps the map and the registered tools in step.

## Batch forms (SU-12)

Seven authoring tools take a list in one call. Give the list instead of the single object's fields; every other argument
is a default for each item, and an item's own fields win.

| Tool | List | Items |
| --- | --- | --- |
| `gma3_store_group` | `groups` | `{group, name, items \| arrangement, overwrite, ...}` |
| `gma3_store_preset` | `presets` | `{preset, name, mode, existing, fixtures, presets, intensity, values \| looks, ...}`, built in Preview |
| `gma3_store_macro` | `macros` | `{macro, mode, lines, name, note, cli}` |
| `gma3_edit_macro_line` | `edits` | `{macro, action, line, ...}`, in order |
| `gma3_assign_to_executor` | `assignments` | `{sequence, page, executor, replace, label}` |
| `gma3_configure_sequence` | `sequences` | numbers and `"a Thru b"` ranges; the same settings on each |
| `gma3_store_cues` | `sequences` | `{sequence, sequence_name, mode, fixtures, cues}` |
| `gma3_set_variable` | `variables` | `{scope, name, value, type}` or `{scope, name, delete: true}` (SU-15) |

The rules (`src/batch.ts`):
- Each item runs through the single form, so it gets that form's checks before anything is sent and its own
  read-back. Cross-item problems (an object listed twice, an identity field given for the whole call, more than 100
  items) refuse the whole call before anything is sent.
- Items run in order and nothing is retried. An item that fails does not stop independent items. Once an item on an
  object did not succeed, the later items on the same object are not attempted, because they were planned against a
  state that did not happen (edits on one macro). `stop_on_failure: true` stops at the first item that does not
  succeed. An item with an uncertain step stops the batch, because the console's state is not known: an outcome
  `unknown`, or a mutation step without a reply inside a `partial` item (an assignment whose label got no answer). Its
  line keeps the uncertainty (`unknown` step), and the remaining items are `not_attempted`.
- The result has one line per item in `items` (outcome, verification, summary) and one step per item. The batch is
  `succeeded` only when every item succeeded, `partial` when some work was done; `matched` only when every item
  matched, `mismatched` when any did. `detail: true` adds each item's full result.
- The whole batch call holds this server's mutation lock once: no other mutation from this server runs between two
  items (each item's single form runs with a held view of the lock, which is not reentrant). Edits planned against
  shifted macro lines therefore stay on the planned lines.

`gma3_store_cues` and `gma3_build_chase` results are compact by default: one line per cue (look details only for a cue
that did not match), the observed cycle as its cue order and step intervals, and only the steps that did not succeed
(with `stepCounts`). `detail: true` returns everything. The field test's 18-cue chase result was 66.6 KB; the compact
one is about 4 KB (`test/live/batch.live.ts`).

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
