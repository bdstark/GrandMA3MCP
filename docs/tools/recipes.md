# Recipes and cooking (SB-05)

Three tools combine groups, presets and MAtricks into programming that adapts to a changed rig:
- `gma3_recipes` reads the recipe lines of a preset or cue part and what the target holds;
- `gma3_edit_recipe` adds, changes, moves or removes one line;
- `gma3_cook_recipes` cooks a preset, a cue part, a cue or a whole sequence with an explicit option, after listing
  every affected target.

Recipe definitions are read and written with the existing object ops (`children`, `objects`, `set`) and `Assign` /
`Move` / `Delete` / `Cook` commands. The cooked state of a target comes from `preset.read`, which bridge **0.24.0**
extends to cue parts (see [the bridge protocol](../reference.md#cue-part-data-plugin-v0240-sb-05)). Evidence:
[the SB-05 probe record](../probes/sb-05-recipes-macos-2.5.1.md).

| Tool | Changes | Programmer |
| --- | --- | --- |
| `gma3_recipes` | nothing (read-only) | untouched |
| `gma3_edit_recipe` | one recipe line of a preset or cue part; **the console cooks the edited line at once** | untouched |
| `gma3_cook_recipes` | the cooked (and, with merge or overwrite, the uncooked) data of the affected targets | untouched |

## The things to know first

- **A recipe line** is a child of a cue part or a preset (class StandardRecipe; phaser lines are PhaserRecipe). It
  has a selection (usually a group), values (usually a preset), optional MAtricks and filter, Enabled, SelectionMode
  and timing columns. It is addressed as `Sequence S Cue C Part P.L` or `Preset Pool.N.L`.
- **The console cooks by itself.**
  - An `Assign` or property write on a line cooks that line into its target at once (merge low priority).
  - Disabling a line removes its output, and deleting a line re-cooks the rest.
  - **A change of an ingredient (group membership, preset content) is re-cooked into the dependent targets a moment
    later**, in the background: an immediate read still shows the old coverage, and 3 s later it is updated.

  Editing a definition and cooking its output cannot be kept apart on the console. The edit tool therefore reports
  the coverage before and after (`autoCooked`), and the cook tool gives an immediate, verified cook with the option of
  your choice.
- **Cook options and uncooked data** (values stored directly in the same cue or preset):

  | Option | Cooked data | Uncooked data on other fixtures/attributes | Uncooked data on the recipe's own fixture and attribute |
  | --- | --- | --- | --- |
  | `merge_low_priority` | replaced by the recipes' output | kept | **kept** (the recipe does not override it) |
  | `merge` | replaced | kept | **replaced** by the cooked value |
  | `overwrite` | replaced | **deleted** | **deleted** |
  | `remove` | removed | kept | kept |

  A cook without an option opens a pop-up on the console; the tools always send one.
- **Dangling references stay as empty fields.** A deleted group or preset leaves the line with an empty selection or
  values; an empty group cooks nothing. `gma3_recipes` lists these as `problems`.
- The cooked output can include the rest of an activation group: a red preset with R, G, B also cooks W, RY and UV of
  an RGBW fixture.

## First-release capabilities

| Capability | Supported |
| --- | --- |
| Standard lines: group selection, preset values, MAtricks reference, Enabled, Name, SelectionMode | read, add, set, move, remove; coverage predicted and verified |
| Standard lines with a filter or world, SelectionFromValue, the per-line timing columns | read and kept; not edited; coverage not predicted (named in the result; a merge treats what they reach as possibly replaced) |
| Phaser recipe lines (PhaserRecipe), shapes | read and kept; not created or edited; coverage not predicted (likewise) |
| Targets | presets and cue parts (edit, read); a preset, cue part, cue or whole sequence (cook) |
| Nested recipe presets (a line's preset embeds others) | noted; their own recipes are not re-cooked by this cook |

## `gma3_recipes`

`{target: {preset: "N.M"} | {sequence, cue, part?}}` (part 0 by default). Returns:

- every line (standard and phaser) with:
  - `selection` (group and its `members`), `values` (`preset` "N.M" and name), `matricks`, `filter`, `enabled`,
    `selectionMode`;
  - the console's last cooking state (`failedCookedPart`, `emptyLastCooking`);
  - `problems`: missing selection, missing or empty group, missing or empty preset, disabled;
  - `notPredicted` where coverage is not modelled;
- `coverage`: per fixture the attributes the target holds `cooked` (from recipes) and `uncooked` (stored directly);
- `expectedPairs`, the number of fixture/attribute pairs the lines should cook;
- `dependencyNotes`.

## `gma3_edit_recipe`

`{target, action, ...}`:

| action | Parameters | Commands |
| --- | --- | --- |
| `add` | `selection` (group), `values` ("N.M"), `matricks?`, `name?`, `enabled?`, `selection_mode?` (strict/normal) | `Assign Group G At <line n+1>`, (`set Enabled No` when `enabled: false`), `Assign Preset N.M At <line>`, `Assign MAtricks M At <line>`, `set` Name / SelectionMode / Enabled |
| `set` | `line` and any of the fields above; `values: null` clears the values | the same, on that line |
| `move` | `line`, `to` | `Move <line a> At <line b>`; only upward moves, which land where asked (moving down by k is k moves of the lines below it) |
| `remove` | `line` | `Delete <line> /NoConfirmation` |

Before anything is sent:
- the target and the line exist, and the line is a standard line (move and remove also take phaser lines);
- the referenced group, preset and MAtricks exist.

`enabled: false` switches a new line off before it gets values, so it never cooks.

Each `set` reply is compared for its property: Enabled by its truth value, SelectionMode, Name and Values as text (an
unchanged SelectionMode is a failure, not a match). Afterwards the lines are read back and checked:
- add and set: every requested field of the line — selection, values (by the preset's address), MAtricks, Enabled,
  Name, SelectionMode; the other lines unchanged (SelectionMode and filter included);
- move and remove: exactly the expected order.

A failed `Assign` can leave an empty line behind on 2.5.1; the line count catches it. The result carries `linesBefore`,
`linesAfter`, `coverage.before`, `coverage.after` and `autoCooked`.

## `gma3_cook_recipes`

`{target: {preset} | {sequence, cue?, part?}, mode, replace_uncooked?, preview?, verify?}`.

1. `find_targets`: the presets or cue parts the scope reaches that hold recipe lines (a sequence: every cue part with
   lines, at most 200). A sequence with more is refused (`check_scope`): the command would reach parts that were not
   inspected. Cook it cue by cue; a preview still lists the first 200 and says `truncated`. For each target:
   - the lines with their members and problems;
   - the coverage before;
   - the predicted cooked coverage: each enabled standard line with a group and a preset gives the group's fixtures
     the preset's attributes, through the fixture's own selective row, the global row of its fixture type, or a
     universal row the fixture has the attribute for (the fixture types are read for each group's members);
   - with merge, the uncooked values it would replace (`replacedUncooked`); with overwrite, the uncooked values it
     would delete (`deletedUncooked`).
   - Unknown coverage never counts as safe. A line that is not predicted (filter, phaser line, SelectionFromValue)
     makes every uncooked value on its group's fixtures a possible replacement under merge, marked `(possibly: …)`;
     without a known group (SelectionFromValue, a phaser line without one), every uncooked value of the target.
2. `check_uncooked`: merge and overwrite are refused while they would replace or delete uncooked values, unless
   `replace_uncooked: true`. `preview: true` stops before this (it returns the plan either way).
3. `cook`: `Cook <scope> /MergeLowPriority | /Merge | /Overwrite | /Remove`.
4. verify (default): every target is read back.
   - Every predicted fixture and attribute is cooked; under merge low priority, an uncooked value on the same pair is
     accepted.
   - No cooked value is on a fixture no line selects.
   - Uncooked values are unchanged on their full content: value, relative value, steps with their layers, phaser
     speed, phase, measure and speed master, fade and delay, and preset references; a missing row is reported as
     disappeared. This holds always under merge low priority and remove, and under merge everywhere except the
     recipes' own pairs and the acknowledged possible replacements; under overwrite they may be gone.
   - Lines that are not predicted are named, and their fixtures are not reported as stray.

## What is and is not verified

- Verified live (onPC 2.5.1, `test/live/recipes.live.ts`, 1/1, 5.4 s):
  - two lines on a cue part next to an unrelated stored Dimmer value;
  - SelectionMode set to Normal and back to Strict, each verified by its reply and the read-back;
  - a group change cooked to the new members with the unrelated value kept;
  - overwrite refused;
  - lines moved and removed;
  - an empty group and a deleted preset reported;
  - a preset recipe added and cooked.
- Not covered:
  - the background cook's exact timing (observed: not yet on an immediate read, done after 3 s);
  - phaser recipe lines;
  - filters and worlds;
  - recipe templates;
  - the programmer's Edit Recipe mode.

## Live test

`GMA3_LIVE=1 node --import tsx --test test/live/recipes.live.ts` on a disposable show with an empty programmer and
bridge 0.24.0. It uses Sequence 906, Groups 910–911, Presets 23.931 and 4.931, the fixtures 401–404
(`GMA3_LIVE_RECIPE_FIXTURES`) and the presets 4.4 and 1.11 (`GMA3_LIVE_RECIPE_COLOR`, `_DIMMER`), refuses to run when
those objects exist, and deletes them at the end.
