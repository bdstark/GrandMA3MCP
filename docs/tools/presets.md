# Presets with explicit storage rules (SB-03)

Two tools build a dependable palette: `gma3_store_preset` stores the current programmer content into a preset with
every storage option explicit, after proving the programmer holds only the requested content, and reads back what was
actually stored; `gma3_preset` reads a preset's stored content and references, or a pool's defaults and the
operator's store preferences. They need bridge **0.22.0**, which adds two read-only ops (`preset.read`,
`preset.context`, see [the bridge protocol](../reference.md#preset-reads-plugin-v0220-sb-03)); the store itself is one
`Store Preset` command. Nothing needs `gma3_lua`. Evidence: [the SB-03 probe record](../probes/sb-03-presets-macos-2.5.1.md).

| Tool | Changes | Programmer / selection |
| --- | --- | --- |
| `gma3_preset` | nothing (read-only) | untouched |
| `gma3_store_preset` | creates, merges into, overwrites or converts one preset | reads the whole programmer; stores it; stored values become inactive unless `keep_activation`; the selection is not touched; requires `exclusive: true` |

The tool only stores. Prepare the programmer first with the fixture tools (`gma3_select`, `gma3_set_attribute`,
`gma3_set_color`, `gma3_set_position`) or `At Preset ...` for embedding, and clear what should not be stored.

## The things to know first

- **A store takes every active programmer value, not the selection** (CHANNELFILTER Active). Values on fixture 402
  are stored although only 401 is selected, and an empty programmer stores an empty preset with feedback "OK". The tool
  therefore scans the programmer first and refuses anything outside the requested scope.
- **Without an explicit mode the console decides, silently.** A store without a mode uses the pool's default; when the
  programmer data does not fit it, `/NoConfirmation` resolves the conflict without asking. Divergent per-fixture values
  stored into a Universal pool keep **one fixture's values** (feedback "OK"). Without `/NoConfirmation` a blocking
  "Preset Mode Conflict" message box opens. The tool always sends a mode and `/NoConfirmation`, and never treats the
  requested mode as proof: it reads the stored rows back.
- **What each mode stores** (per channel, `preset_store_mode` in `GetPresetData`):
  - *selective*: one row per fixture;
  - *global*: one row per **fixture type**, held by its lowest FID (a cell type's by a cell), plus selective rows for
    fixtures whose values differ (`StoredData` then reads `Selective/Global`);
  - *universal*: one row per attribute, valid for every fixture that has it (held by one fixture or the Universal
    fixture). Values that differ between fixtures cannot survive, so the tool refuses them. Multi-step (phaser) values
    are refused in universal mode too, also for a forced conversion: their equivalence (every step and step parameter)
    cannot be compared yet, and a wrong guess would discard a fixture's phaser.
- **Feature-group pools filter silently.** With the input filter on (store preference `PresetInputFilter`, or
  `/InputFilter`), pools 1–20 keep only their feature group: Dimmer stored into the Color pool is dropped, the value
  stays active in the programmer, the feedback is "OK". The All pools 21–25 have no filter. The tool predicts the drop
  from each attribute's feature group and refuses it.
- **The operator's store preferences are defaults, and the tool overrides the ones that decide content per store.** It
  never changes them, and checks this by reading them before and after (they are in `CurrentProfile().StorePreferences`
  and shown by `gma3_preset {pool}`). `/Programmer` overrides StoreSource (Output), `/Active` overrides ChannelFilter
  (All), `/Merge` / `/Overwrite` override StoreMode (Ask), and `/Embed`, `/MAtricks` and `/KeepActivation` with "Yes" or
  "No" override StoreEmbedded, StoreMAtricks and KeepActivation. All of these were checked against a preference set the
  other way.
- **Look cannot be overridden.** Every `/Look` form, `/Look "No"` included, turns Look on and stores all fixtures. The
  tool never sends `/Look` and refuses while the operator's StoreLook preference is on.
- **Embedding keeps a reference, and the reference follows its source.** With `/Embed` the stored channels name the
  preset that was active in the programmer (`abs_preset`), and the preset lists it as a dependency. When the source is
  updated, the embedded preset follows **one frame later**; a copied (not embedded) preset keeps its values. Deleting
  a source leaves an invalid dependency; the embedded preset keeps its last values.
- **An activation group is stored as a whole.** Setting ColorRGB_R activates ColorRGB_G, _B, _W, ... too; they are
  active programmer values. With `attributes`, list all of them.

## `gma3_store_preset`

Parameters:

| Parameter | Values | Default |
| --- | --- | --- |
| `preset` | `"<pool>.<number>"` (`"4.12"`, `"23.1"`) | required |
| `fixtures` | fixture ids or `"a Thru b"` ranges; a fixture includes its cells | required |
| `mode` | `selective`, `global`, `universal` | exactly one of `mode` / `force` |
| `force` | `global`, `universal`: forced conversion of an existing preset (`/ForceGlobal` or `/ForceUniversal` with `/Merge`), which removes its selective, or selective and global, data | needs `existing: "merge"` |
| `existing` | `refuse`, `merge`, `overwrite` | `refuse` |
| `attributes` | exact attribute filter; each must be present | none (any attribute) |
| `layers` | `absolute`, `relative`, `fade`, `delay`, `phaser` (multi-step) | `["absolute"]` |
| `embed` | store references to the presets active in the programmer | false (plain values) |
| `input_filter` | override the input-filter preference for this store | the operator's default |
| `matricks` | store the selection MAtricks | false |
| `keep_activation` | keep the stored values active | false |
| `name`, `preview`, `verify`, `exclusive` | as usual | `verify` true; `exclusive` required unless preview |

Requests, in order:

1. read `read_context` (`preset.context`): the pool exists; the store preferences are readable and StoreLook is off.
2. read `check_preset` (`preset.read`): a missing preset is new (a forced conversion needs an existing one); an
   existing one needs `existing: merge|overwrite`; a locked one is refused.
3. read `resolve_fixtures` (`fixtureAttributes` per scope fixture, and per cell with cells of its own): subfixture
   indices of the scope and each attribute's feature group. Unknown fixtures are refused.
4. read `read_programmer` (`programmer`, all fixtures): must be complete (inactive leftovers of an earlier store are
   fine: `/Active` does not store them).
5. `check_content`, refused with every reason when anything holds:
   - a value outside the scope;
   - a scope fixture without a value, or no values at all;
   - an attribute outside `attributes`, or a requested attribute without a value;
   - a layer outside `layers`;
   - universal mode (or a forced universal conversion) with values that differ between fixtures (value, relative,
     fade, delay, step count, references) or with any multi-step value;
   - `embed` without a preset reference in the programmer;
   - an attribute the pool's input filter would drop.

   `preview: true` stops here and returns the planned command (`intended.command`).
6. `store`: `Store Preset P.N /Programmer /Active /<Mode> [/Merge|/Overwrite] /Embed "…" /MAtricks "…"
   /KeepActivation "…" [/InputFilter "…"] /NoConfirmation`, then `set_name` when `name` is given.
7. verify (default):
   - `preset.read` (with the fixture types the read uses) checks every programmer value:
     - selective: a selective row of the same fixture;
     - global: the fixture's own row, or the global row of its fixture type;
     - universal: the universal row of the attribute;
     - in every mode the same value (±0.05 %), fade/delay and step count; the absolute and the relative reference are
       checked separately: with `embed`, each reference the programmer value had must be stored, valid and to the same
       source, and none it did not have; without `embed`, no reference of either kind. Phaser steps are checked the
       same way per step: a stored step reference must match the programmer step's, and a step that had none must not
       have one.
   - A new or overwritten preset must not hold anything else (`unexpected stored content`): only the fixtures'
     own rows, and in global mode a global holder only for an attribute and fixture type a programmer value has; merge
     keeps other rows.
   - A forced conversion must leave only Global (or Universal) data.
   - A new preset's mode, the name, dependencies (recursively, see below) and `check_preferences` (the store
     preferences unchanged) are checked too.

   Any difference makes `verification` `mismatched`.

Warnings name what is not an error: preset references stored as plain values (each source listed as absolute or
relative), a forced conversion's removal, an
attribute whose feature group is unknown (decided by the read-back), a pool with its own input filter, an incomplete
dependency inspection.

### Batch form: presets from explicit content (SU-12)

`presets: [{preset, name, mode, existing, fixtures, presets, intensity, values | looks, attributes, layers, embed,
input_filter}]` stores several presets, each from its own content instead of the programmer. `fixtures` (ids or
`"a Thru b"` ranges) is the content's target and the preset's scope; `looks: [{fixtures, presets, intensity,
values}]` gives several targets, and the scope is every fixture they name. Call-level `mode`, `existing`, `fixtures`
and the other options are defaults for every preset. `exclusive: true` is required; `force`, `keep_activation` and
`preview` are single-form only.

The presets are built one by one in the console's Preview environment, as `gma3_store_cues` builds cues
([cuelists.md](cuelists.md#how-a-batch-is-built)): the read-only checks first (presets, attributes, fixtures, the
Normal programmer), Preview On and an empty Preview programmer, then per preset ClearAll (only in Preview), its looks
with a programmer check after each, and this tool's own store, checks and read-back with `environment: Preview`.
Preview is left at the end and the Normal programmer must be unchanged. A preset that is refused or does not match
does not stop the others unless `stop_on_failure: true`; a step without a reply (an unanswered name write after the
store, say) stops the build, with the remaining presets `not_attempted` and Preview still left. The result has one line per preset (`items`), the build's
own steps (`build`) and `normalProgrammer`. See [Batch forms](README.md#batch-forms-su-12).

On bridge 0.30.0 the programmer scan of all fixtures misses subfixture index 0 (the first patched fixture when the
show has no Universal fixture), so a scope that includes it is refused with "has no programmer value". The bridge fix
is a separate change.

## `gma3_preset`

- `{ preset: "4.12" }`:
  - **Summary:** `name`, `pool`, `featureGroup`, `presetMode`, `storedData`, `locked`, `hasMAtricks`, `referencedBy`
    (how many objects use the preset).
  - **Rows:** one per fixture and attribute, with `mode`, `value` (percent) or `steps`, `fade`, `delay`, `relative`,
    `fixtureType`, and `embeddedFrom` / `relativeFrom` for an embedded absolute / relative value.
  - **Phaser data** (bridge 0.23.0): `steps` with each step's `absolute`/`relative`, `width`, `trans`, `accel`,
    `decel` and the preset it integrates, and the phaser layers `speedBpm`, `phase`, `measure` (beats) and
    `speedMaster` (absent = console default: 60 BPM, phase 0). The store's read-back compares all of them.
  - **Dependencies:** the direct dependencies with validity, and `dependencyInspection`. The inspection follows embedded
    sources recursively (four levels) by address. `complete: false` says why (a source not found, dependencies not
    readable, beyond depth), and `invalid` lists deleted sources.
- `{ pool: 4 }`: the pool's name, default preset mode and input filter, whether it is an All pool, and the operator's
  store preferences.

## What is and is not verified

- Verified live (onPC 2.5.1, `test/live/presets.live.ts`, 1/1, 6.1 s):
  - global colour across two fixture types (one global row per type);
  - selective positions on two mover types;
  - every refusal (unrequested content, divergent universal values, an input-filter drop, an existing preset, an empty
    programmer, an unrequested fade layer), then `input_filter: false` and `layers: [absolute, fade]` stored and
    verified;
  - an embedded preset following its source's update while a copy keeps the old values;
  - a forced conversion from `Selective/Global` to `Global`;
  - the store preferences unchanged after every store.
- Not covered:
  - relative values are compared by value; multi-step phaser data step by step with bridge 0.23.0 (see
    [phasers](phasers.md));
    relative embedding is verified by the unit tests, not on the console (the live test embeds absolute values);
  - MAgic presets and recipe content are not modelled;
  - a pool's own input filter (a filter or world assigned to the pool) is not predicted; only the read-back catches it.
- The embedded preset's update is asynchronous; a read in the same frame as the source's change shows the old values.

## Live test

`GMA3_LIVE=1 node --import tsx --test test/live/presets.live.ts` on a disposable show with an empty programmer, the
operator's StoreLook off and bridge 0.22.0. It uses Presets 2.901, 4.901–4.904 and 23.901–23.903, Hex Pars 401–404,
the wall-washer cells 501.1/501.2 and the movers 601, 602, 701–704 (`GMA3_LIVE_PRESET_PARS`, `_CELLS`, `_MOVERS`),
refuses to run when those presets exist, and deletes them and clears the programmer at the end.
