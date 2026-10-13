# SB-03 probe: preset modes, storage options, embedding and dependencies (macOS, onPC 2.5.1)

Evidence for [SB-03 in SHOWS.md](../../SHOWS.md#sb-03--create-reusable-presets-with-explicit-storage-rules) and
[the preset tools](../tools/presets.md).

- **Date:** 2026-10-13
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, show `mcp-test-disposable`, bridge 0.21.0 (Lua on) for
  the manual pass, 0.22.0 for the tools
- **Method:** a manual pass through `gma3_lua` (`Cmd`, `CmdIndirect` for anything that could open a dialog,
  `GetPresetData`, `GetProgPhaser`, `Get("Dependencies")`, `GetTopModal`), then the tools through
  `test/live/presets.live.ts`.
- **Objects:** Presets 1.901–905, 2.901, 4.901–912, 23.1–10, 24.1, 25.1–4, all checked absent first and deleted
  afterwards. Fixtures 401–404 (Mega Hex Par, RGBW + RY + UV), 501.1/501.2 (LED wall washer cells, RGBW),
  601–602 (180 W beam moving head) and 701–704 (Thrill Mini Profile).
- **Show defaults:** pools 1 Dimmer (Universal), 2 Position (Selective), 3 Gobo (Universal), 4 Color (Universal), 5 Beam
  (Global), 6 Focus (Universal), 7 Control (Global), 8 Shapers, 9 Video (Selective), 21 "Phaser" (the first All pool,
  renamed), 22–25 All 2–5. Operator store preferences (`CurrentProfile().StorePreferences`): STOREMODE Ask,
  STORESOURCE Programmer, CHANNELFILTER Active, STORELOOK No, PRESETMODE Default, PRESETINPUTFILTER Yes,
  STOREEMBEDDED No, STOREMATRICKS Yes, KEEPACTIVATION No.

## What a preset exposes

| Read | Result |
| --- | --- |
| `PresetMode` | the preset's mode (Selective / Global / Universal), writable |
| `StoredData` | read-only text of the stored layers: `Selective`, `Global`, `Universal`, `Selective/Global`, `""` for an empty preset |
| `FeatureGroup`, `MaxDepth`, `HasAnyMAtricksData`, `InputFilter`, `Lock` | as named |
| `Get("Dependencies")` | a Lua table, one entry per embedded source: `{ key = <source preset handle>, content_crc, name_crc }` |
| `References` | text `"<handle int>:<count>,..."` of the objects that use the preset |
| `GetPresetData(p, false, true)` | per UI channel and under `by_fixtures[<fid or "501.2">][<attribute>]`: steps (`[1].absolute`, percent), `preset_store_mode` (1 selective, 2 global, 3 universal), `selective`, `fade`, `delay`, `dict_flags.has_absolute` / `has_relative`, `abs_preset` / `rel_preset` (source handle of an embedded value), `mask_individual` (0 on an embedded step) |

The object ops render Dependencies / PresetData as `""`; the bridge's `preset.read` op (0.22.0) reads them. The show's
own universal presets keep their data on MA's Universal fixture (`by_fixtures` key "Generic 1", subfixture index 0,
type "Moving Head"); a cell has no FixtureType of its own (its fixture's applies).

## Modes

Four Hex Pars with R 100 / G 0 (the whole RGB activation group is stored: R, G, B, W, RY, UV):

| Store | Stored | Per fixture (G) |
| --- | --- | --- |
| `/Selective` (401 G 0, 402 G 100) | Selective | 401 and 402, mode 1 |
| `/Global`, equal values | Global | **401 only** (lowest FID of the type), mode 2 |
| `/Universal` | Universal | 404 only (the data holder), mode 3 |
| no mode, pool 4 is Universal | Universal | 404, mode 3 |
| `/Global`, 402 diverges (G 50) | `Selective/Global` | 401 G 0 mode 2, 402 G 50 mode 1 |
| **no mode, divergent, `/NoConfirmation`** | **Universal** | **404 G 0 only: 402's G 50 silently lost** |
| no mode, divergent, without `/NoConfirmation` (via `CmdIndirect`) | — | MessageBox "Preset Mode Conflict: The programmer values suggest 'Selective' as preset mode." Universal / Selective / Cancel; the empty preset already exists; Escape cancels and removes it |
| `/Global`, Hex Pars and two washer cells | Global | 401 (Hex Par type) and 501.2 (cell type), mode 2 |
| `/ForceGlobal /Merge` onto the `Selective/Global` preset (uniform G 20) | Global | 401 G 20 only: the selective 402 removed |
| `/ForceUniversal /Merge` onto a Selective preset (401 only) | Universal | 401 mode 3; 402's selective data removed |

## Scope, filters, layers and options

| Case | Result |
| --- | --- |
| values on 401 and 402, only 401 selected, default store | both stored (CHANNELFILTER Active: every active value, not the selection) |
| same with nothing selected | both stored |
| `/ActiveForSelected` with only 401 selected | 401 only |
| empty programmer | **"OK" and an empty preset** (StoredData `""`) |
| a selection expression `Fixture 401 Thru 404 + 501.1 + 501.2` | "Object not found", nothing selected (separate `Fixture 501.1` commands work) |
| Dimmer + colour into the Color pool | colour stored, **Dimmer silently dropped** (input filter); Dimmer stays active in the programmer |
| same with `/InputFilter "No"` | Dimmer stored too |
| same into All 3 (23) | both stored (no feature-group filter) |
| `Attribute "Dimmer" At 50 Fade 3`, `"ColorRGB_R" At 20 Delay 1` | programmer and preset carry `fade=3.0` / `delay=1.0` per channel |
| selection MAtricks XWings 2, `At 0 Thru 100`, default store | MAtricks stored into the preset (HasAnyMAtricksData Yes, XWings 2) |
| same with `/MAtricks "No"` | no MAtricks data |
| default store | stored values become inactive (KEEPACTIVATION No); `/KeepActivation "Yes"` keeps them active, `"No"` deactivates |
| `/Embed "Yes"` / `"No"` with `At Preset 4.902` in the programmer | one dependency / none (values baked in) |
| `/Programmer /Active`, `/InputFilter "Yes"` | accepted |
| **`/Look "No"`** (Look off in the preferences) | **351 rows: every fixture's values. Any `/Look` form turns Look on**; `/Look "Off"` with StoreLook Yes also 351 |
| every option above | the StorePreferences values are unchanged afterwards |
| locked preset, `Store ... /Overwrite` | "Object locked" |

## Options against a preference set the other way

Each preference was set on this disposable show for one chunk and restored afterwards (read back: restored). A single
active value (401 R or Dimmer) was stored.

| Preference | Store | Result |
| --- | --- | --- |
| KeepActivation Yes | `/KeepActivation "No"` | the value is inactive afterwards: honoured |
| StoreEmbedded Yes, `At Preset 4.4` in the programmer | `/Embed "No"` | no dependency: honoured |
| StoreLook Yes | no `/Look` | 351 rows: Look cannot be switched off per store |
| ChannelFilter All | none / `/Active` | 351 rows / 1 row: `/Active` honoured |
| StoreSource Output | none / `/Programmer` | 145 rows / 1 row: `/Programmer` honoured |
| StoreMAtricks Yes (the show's default) | `/MAtricks "No"` | no MAtricks data: honoured |

## Programmer after a store

Stored values become inactive (unless `/KeepActivation "Yes"`): the `programmer` op omits them as rows and reports
"N channel(s) returned step data with all activity masks zero" as a limitation. A value typed on a channel after it
was stored shows the new preset as `absPreset`.

## Existing presets

| Store onto 401 = 100, 402 = 100 (R) with 403 = 50 in the programmer | Result |
| --- | --- |
| `/Merge` | 401 100, 402 100, 403 50; a later `/Merge` of 402 = 30 updates 402 |
| `/Overwrite` | 403 only |
| no option, `/NoConfirmation` (STOREMODE Ask) | 403 only (overwrite); a different STOREMODE would change this, so the tools always send one |
| `/Remove` with 401 in the programmer | 402 only |

## Embedding and dependencies

| Case | Result |
| --- | --- |
| `At Preset 4.902` on 401/402, `Store Preset 23.3 /Embed` | channels `abs_preset` = 4.902, step `mask_individual` 0, Dependencies `[{ key = Preset 4.902, content_crc, name_crc }]`, MaxDepth 0 |
| same without `/Embed` | values copied, no `abs_preset`, no dependencies |
| source 4.902 overwritten (red → green), read **in the same chunk** | embedded still red, content_crc unchanged |
| **one frame later** | embedded green (follows the source), content_crc changed; the copied preset stays red; `At Preset 23.3` puts green into the programmer |
| `Delete Preset 4.904` while embedded in 24.1 (via `CmdIndirect`) | no dialog; 24.1 keeps its cached value, the dependency key and `abs_preset` are **invalid handles** (`IsObjectValid` false) |

## The tools on the console

The first live store (`/Programmer /Active /Look "No" ...`) stored 230 rows into a Color preset from a 12-value
programmer and verification reported the unexpected content; that is how the `/Look` behaviour above was found. The
tool no longer sends `/Look` and refuses while StoreLook is on. The second call of the same run was refused as an
incomplete scan because of the inactive-values limitation; that limitation is now accepted. `test/live/presets.live.ts`
then passed 1/1 in 6.1 s: global blue across Hex Pars and wall-washer cells held by 401 and 501.2; selective positions
on 601, 602, 701–704; the six refusals with nothing sent; the input-filter override and the fade layer stored and
verified; an embedded preset following its source's update to red while a copy stayed blue; a forced conversion from
`Selective/Global` to `Global`; the store preferences unchanged after each store.
