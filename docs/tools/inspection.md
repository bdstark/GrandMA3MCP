# Inspection tools (FR-07 .. FR-10)

Structured, read-only views of fixture attributes, the programmer, DMX output and stored cue content.

| Tool | Bridge op | FR |
| --- | --- | --- |
| `gma3_fixture_attributes` | `fixtureAttributes` | FR-07 |
| `gma3_programmer` | `programmer` | FR-08 |
| `gma3_fixture_output` | `fixtureOutput` | FR-09 |
| `gma3_dmx` | `dmx` | FR-09 |
| `gma3_cue_contents` | `cueContents` | FR-10 (feasibility-gated, see "Supported mode") |

All five are **structured ops added to the bridge plugin in version 0.3.0**. They run on the plugin thread like
`object`, `children` and `objects`, so they work with the `lua` op disabled (`Plugin "gma3_mcp_bridge"` without
`lua`), and they are not budgeted or sandboxed. None of them sends a command, none takes the mutation lock, and
none changes the selection, the programmer or any playback. Because they do not take the lock, another operator
or client can change the console between two reads; a result is a snapshot, not a transaction.

Why structured ops: these views work without enabling arbitrary Lua execution. Early bridge versions
ran submitted Lua in a child coroutine, which lost the onPC plugin context. Since v0.3.1, submitted Lua
also runs on the plugin thread; the structured tools remain the supported read-only interface for these
views. See [Lua execution](../lua.md) for current execution and budget behavior.

Source of truth for the API shapes: the onPC 2.5.1 object tree (verified live through the structured tools) and the
2.5.1 manual pages `lua_objectfree_getuichannels`, `getrtchannels`, `getchannelfunction`, `getattributebyuichannel`,
`getsubfixture`, `getdmxvalue`, `getdmxuniverse`, `getpresetdata`, plus the live API descriptor for `GetProgPhaser`
and `SelectionTable`. The function calls themselves could not be executed before the plugin re-import, so the
items listed under "Needs live verification" are unconfirmed until the live test has run.

## Null means "the console did not say"

The console's JSON library (rxi `json.lua`) cannot carry `nil` inside a table, so the bridge omits every metadata
item it could not read. The TypeScript tools fill the documented keys of each row with explicit `null` so a
missing value is visible and never inferred. Zero is always a value: `value: 0` is a real zero; a null or an
absent row is "not available".

---

## gma3_fixture_attributes

Attribute discovery for one fixture or subfixture.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `fixture` | number or string | `101`, `"501.3"`, `"Fixture 501.3"`. Exactly one (sub)fixture; groups and ranges are refused. |
| `include_channel_sets` | boolean | Add each channel function's ChannelSets (gobo slots, colour slots ...). Default false. |
| `limit`, `offset` | integer | Pagination over the attribute rows (default 100, max 500). |

Sends one bridge request: `fixtureAttributes {ref, limit, offset, includeChannelSets}`. The fixture is resolved
with `ObjectList(ref)`, i.e. **by fixture ID**; the patch index is read from `SubfixtureIndex` and reported
separately (`subfixtureIndex`). For a SubFixture the owning Fixture is found through `Parent()` and supplies
FixtureType, Mode, Patch and FID.

Result (top level): identity (`name`, `class`, `addr`, `fid`, `cid`, `subfixtureIndex`, `isSubfixture`, `fixture`
for a subfixture, `fixtureType`, `mode`, `patch`, `rtChannelCount`), `subfixtures[]` (direct SubFixture children
with `subfixtureIndex`), `subfixtureCount`, `channels[]` (RT channels: `rtIndex`, `channel`, `fid`,
`coarse`/`fine`/`ultra` as `"universe.address"`, `bits`, `default`), `channelsSource` (`"own"`, `"parent"` or
null), `source`, paginated `attributes[]`, `limitations[]`, `notes[]`.

Subfixtures: on 2.5.1 `GetRTChannels(subfixture)` returns nothing; the DMX addresses belong to the parent fixture.
The op then takes the parent's RT channels whose name matches exactly one of the subfixture's attributes
(`channelsSource: "parent"`, stated in `limitations`). When the instance's channels share their names with other
instances (a 12-cell washer: twelve `RGBW_ColorRGB_R`), nothing can be attributed to this subfixture:
`channels` is empty and the limitation says the mappings are available on the parent fixture. A subfixture is never
reported as "unpatched".

Attribute row keys (always present, null when unavailable): `uiChannel`, `attribute`, `attributeIndex`, `pretty`,
`feature`, `featureGroup`, `activationGroup`, `physicalUnit`, `readout`, `color`, `channelFunction`,
`channelFunctions`, `dmxFrom`, `dmxTo`, `default` (24-bit hex strings as the console stores them), `physicalFrom`,
`physicalTo`, `realFade`, `dmx` (`{channel, rtIndex, coarse, fine, ultra, bits, default}` when exactly one RT
channel matches the attribute by name), `dmxChannel` (walk path only), and `channelSets` when requested.

`source`:

* `"uiChannels"`: `GetUIChannels(handle)` gives the UI channel indices, `GetAttributeByUIChannel(ui)` the
  attribute definition, `GetChannelFunction(ui, attributeIndex)` the channel function. Stable identifiers are
  `attribute` + `attributeIndex` + `uiChannel`.
* `"fixtureTypeWalk"`: used when the UI channel API is unavailable. Walks
  `DMXMode -> DMXChannels -> DMXChannel -> LogicalChannel -> ChannelFunction -> ChannelSet`; rows have no
  `uiChannel`, carry the mode-relative offsets in `dmxChannel`, and a compound fixture's shared geometry channels
  appear once (stated in `limitations`). The DMXMode handle is resolved from `Get("Mode")`, the `Mode` field, or
  (because the console returned the display text `"1 Mode 0"` instead of a handle for one fixture live) from
  `FixtureType -> DMXModes` matched by that text.

Not available: current values (use `gma3_programmer` / `gma3_fixture_output`), and a per-attribute DMX mapping
when several RT channels share the attribute name (compound fixtures; `channels[]` still has the full map).

## gma3_programmer

Programmer content per UI channel.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `scope` | `all` / `selection` / `fixtures` | Explicit. `all` = patch indices `1 .. GetSubfixtureCount()-1` (unselected fixtures included); `selection` = `SelectionTable()`; `fixtures` = the range below. |
| `fixtures` | string | Required for scope `fixtures`: `"1 Thru 5"`, `"101 + 103"`, `"Fixture 4.1"`. Groups are refused (ObjectList would return the group object). Compound fixtures are expanded into their subfixture indices. |
| `max_channels` | integer | Scan budget in UI channels per request (default 5000, max 50000). |
| `limit`, `offset` | integer | Pagination over the rows (default 200, max 5000). |

Sends one bridge request: `programmer {scope, fixtures, limit, offset, maxChannels}`. Per (sub)fixture index the op
calls `GetSubfixture(idx)`, `GetUIChannels(idx)` and, per UI channel, `pcall(GetProgPhaser, ui, false)`.

A row is emitted only when `mask_active_value`, `mask_active_phaser` or `mask_individual` is non-zero. Rows carry
`fixture`, `fid`, `subfixtureIndex`, `uiChannel`, `attribute`, `attributeIndex`, `present: true`, `masks`
(`activeValue`, `activePhaser`, `individual`), `stepCount`, `steps[]` (per step: `channelFunction`, `absolute` in
percent, `absoluteValue` 24-bit, `relative`, `accel`/`accelType`, `decel`/`decelType`, `trans`, `width`,
`integratedPreset`), `phaser` (`supported`, `multiStep`, `fade`, `delay`, `speed`, `phase`, `measure`,
`gridPos`, or `supported: false` with `reason`), `absPreset`, `relPreset`. Single-step rows also have `value`
(= `steps[1].absolute`), `valueRaw` and `relative`; multi-step rows have `value: null` and are never collapsed.

`coverage` = `{complete, scannedFixtures, totalFixtures, scannedChannels}`; `stats` =
`{channelsWithData, channelsWithStepsButInactiveMask, channelErrors}`. When the scope cannot be enumerated
(`SelectionTable`/`GetSubfixtureCount` unavailable), the channel budget cuts the scan, or reads fail,
`coverage.complete` is false and a limitation says why; **an incomplete result never claims the programmer is
empty**.

Units: `value`/`absolute` percent, `valueRaw`/`absoluteValue` the console's 24-bit integer, `fade`/`delay`
seconds, `speed` Hz, `phase` degrees. `source: "programmer"`: these are programmer values, not output.

Needs live verification: the exact semantics of the masks for an untouched channel (expected: all zero), and
whether `GetProgPhaser` returns step data for inactive channels (`stats.channelsWithStepsButInactiveMask` reports
how often that happened; such channels are treated as empty).

## gma3_fixture_output

DMX output per RT channel of one fixture or subfixture.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `fixture` | number or string | As for `gma3_fixture_attributes`. |
| `nonzero_only` | boolean | Explicit filter, default false. Channels whose value is unknown (null) are kept. |
| `limit`, `offset` | integer | Pagination (default 200, max 2000). |

Sends one bridge request: `fixtureOutput {ref, nonzeroOnly, limit, offset}`. For each RT channel from
`GetRTChannels(handle, true)` the op reads `GetDMXValue(address, universe, false)` for the coarse, fine and ultra
addresses (8-bit each) and combines them (`coarse*256+fine`, `*256+ultra`); `bits` and `unit`
(`raw8`/`raw16`/`raw24`) say which. `percent` is derived (`raw / (2^bits-1) * 100`). Attribute metadata per RT channel uses the same
resolution as `gma3_fixture_attributes`: the UI channel API first (attribute rows matched to RT channels by channel
name), the fixture-type walk for the full channel function list and as fallback; `metaSource` says which
(`"uiChannels+fixtureTypeWalk"`, `"uiChannels"`, `"fixtureTypeWalk"` or null). When a mapping exists the row carries
`attribute`, `attributeIndex`, `physicalUnit`, `channelFunction` (the function whose DMX range contains the value,
else the default), `physical` with `physicalFrom`/`physicalTo` and `conversion: "linear from channel function"`,
and the matching `channelSet`. A limitation about missing metadata appears only when neither path produced a
mapping. For a subfixture the RT channels come from the parent as described under `gma3_fixture_attributes`
(`channelsSource`).

If `GetDMXValue` returns nil (universe not granted on this onPC: `DmxUniverse.Granted = No`), `value` is null and
`limitations` contains `"universe N not granted: ..."`. Never 0.

`source: "dmx output"`. Not available: per-attribute cooked output (no API in 2.5.1); programmer values (use
`gma3_programmer`). An unpatched fixture has no RT channels and says so.

## gma3_dmx

Raw universe read.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `universe` | integer | 1..1024; the op further bounds it by `Patch().DmxUniverses:Count()`. |
| `from`, `to` | integer | 1..512, `from <= to`; `to` defaults to `from`. |
| `nonzero_only` | boolean | Explicit filter, default false. |
| `unit` | `raw8` / `percent` | `raw8` (default): 0..255 per address. `percent`: 0..100 as converted by the console (8-bit precision). |
| `patched` | boolean | Map each returned address to `{fid, channel, part}` via every fixture's RT channels (default false; skipped with a limitation above 6000 RT channels). |

Sends one bridge request: `dmx {universe, from, to, nonzeroOnly, percent, patched}`. The op reads
`GetDMXUniverse(universe, percent)` and slices the range, falling back to `GetDMXValue` per address when the table
form is unavailable (`readVia` says which). Result: `universe`, `granted` (true/false/null), `universeInfo`
(`name`, `granted`, `request`, `portOut`, `used`, `coarseParams`, `mergeMode` from the DmxUniverse object),
`from`, `to`, `unit`, `nonzeroOnly`, `readVia`, `patched` (`"rtChannels"` or null), `count`, `values[]`
(`{channel, value[, patched]}`), `source: "dmx output"`, `limitations[]`. A universe that is not granted returns
no values and `granted: false`. 16-bit attributes appear as two 8-bit addresses.

## gma3_cue_contents

Stored cue content that the 2.5.1 API exposes, without Goto, Load or any playback command.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `sequence` | number or string | Sequence number (or exact name). |
| `cue` | number or string | Cue number (`1`, `2.5`, `"10.001"`). |
| `part` | integer | Only this part (0..999). Default all parts. |
| `fixtures` | string | Fixture range; applied to expanded preset data (`by_fixtures`) only. |
| `expand_presets` | boolean | Read referenced presets with `GetPresetData(handle, false, true)`. Default false. |

Sends one bridge request: `cueContents {sequence, cue, part, fixtures, expandPresets}`. The op resolves
`ObjectList("Sequence N Cue M")`, reads the cue's properties, each Part (children of the cue) and each
StandardRecipe (children of the part), with `Get(name, Enums.Roles.Edit)` for display text.

Result: `sequence` (`name`, `tracking`, `priority`), `cue` (`no`, `name`, `trigType`, `trigTime`, `trigSound`,
`release`, `assert`, `allowDuplicates`, `mibPreference`, `break`, `note`, `partCount`), `parts[]`, `presets`
(object keyed by preset `AddrNative` when expanded, else null), `trackedValues: "not_reconstructed"`,
`supportedMode`, `source`, `limitations[]`.

Each part: `part`, `name`, `cuePart`, `timing` (`cueFade`, `cueDelay`, `cueInFade`, `cueInDelay`, `cueOutFade`,
`cueOutDelay`, `snapDelay`, `duration`, `indivFade`, `indivDelay`, `transition`, `trackingDistance`), `command`
(`text`, `delay`, `enabled`), `mib` (`mode`, `target`, `fade`, `delay`), `ownDataPresent`,
`ownNonCookedDataPresent`, `memoryType`, `recipes[]`, `otherChildren[]`, `storedValues: null` (always).

Each recipe: `index`, `name`, `enabled`, `selection`, `selectionMode`, `preset` (text as the console shows it),
`presetRef` (`{name, addrNative, addr, class}` when the handle resolved), `presetResolved` (true / false / null
when the recipe has no preset), `presetDataKey`, `values`, `fadeX`, `delayX`, `speedX`, `phaseX`, `matricks`,
`filter`, `generator`. An unresolved preset reference is marked `presetResolved: false` and listed in
`limitations`.

Expanded preset data (`presets[key]`): `preset`, `available`, `source: "GetPresetData"`, `rows[]` (one row per
phaser step, flattened: `fid` or `uiChannel`, `step`, the step's fields such as `absolute`, plus the entry's scalar
fields and a dotted `path` for nested tables), `count`, `truncated` (2000 rows per preset), `topLevelKeys`,
`byFixturesPresent`, `filterApplied`, `meta`. The table's exact shape is undocumented; the flattening is best effort
and `topLevelKeys` is there to check it live.

### Supported mode (FR-10 feasibility result for onPC 2.5.1)

Readable without playback: cue properties, part timing/command/MIB, `OwnDataPresent`, recipes (Group/Selection x
Preset with timing), preset references, and preset content via `GetPresetData`.

Not readable: **hard (non-recipe) fixture values stored in a cue part**. There is no `GetCueData` in 2.5.1; the
cooked value storage is binary (`MemoryType Compressed`) and not exposed as children or properties. The tool
reports `storedValues: null` and, when a part has `OwnDataPresent = Yes`, the limitation
`"hard (non-recipe) fixture values stored in a cue part are not exposed by the 2.5.1 Lua API (no GetCueData); only
recipe and preset references are readable"`. Tracked values are not reconstructed either: a part lists only what is
stored in it (`trackedValues: "not_reconstructed"`). The alternatives (`Fixture X At Cue N`, `Cue N` SelFix, the
DMX sheet during playback) all mutate state and are excluded.

---

## Bridge protocol additions

Plugin version 0.3.0. One JSON document per line as before; errors are `{id, ok:false, error}`. Keys that the
console could not supply are absent (see "Null means ..."). `limitations` is always an array.

### `fixtureAttributes`

Request `args`: `{ ref: string, limit?: number (default 100, max 500), offset?: number, includeChannelSets?: boolean }`

Result: `{ name, class, addr, fid, cid, subfixtureIndex, isSubfixture, fixture?, fixtureType, mode, patch,
rtChannelCount, subfixtures: [{name, index, subfixtureIndex, addr, childCount}], subfixtureCount,
channels: [{rtIndex, channel, fid, coarse, fine, ultra, default, bits}], channelsSource?: "own" | "parent",
source: "uiChannels" | "fixtureTypeWalk", total, offset, count, attributes: [row], includeChannelSets,
limitations: [string] }`

Row: `{ uiChannel?, attribute, attributeIndex, pretty, feature, featureGroup, activationGroup, physicalUnit, readout,
color, mainAttribute, channelFunction, channelFunctions: [string], dmxFrom, dmxTo, default, physicalFrom, physicalTo,
realFade, realAcceleration, wheel, emitter, customName, channelSets?: [{name, dmxFrom, dmxTo, physicalFrom,
physicalTo, wheelSlotIndex}], dmx?: {channel, rtIndex, coarse, fine, ultra, bits, default},
dmxChannel?: {name, dmxBreak, coarseOffset, fineOffset, ultraOffset, geometry, default} }`

Errors: `'<ref>' resolved to a <class>, not a Fixture or SubFixture`; `no object found for '<ref>'`.

### `programmer`

Request `args`: `{ scope: "all" | "selection" | "fixtures", fixtures?: string, limit?: number (default 200, max
5000), offset?: number, maxChannels?: number (default 5000, max 50000) }`

Result: `{ scope, fixtures?, source: "programmer", note, coverage: {complete, scannedFixtures, totalFixtures,
scannedChannels}, stats: {channelsWithData, channelsWithStepsButInactiveMask, channelErrors}, maxChannels,
selectionCount?, scannedFixtures: [{subfixtureIndex, fid?, name?, rootFid?, attributes: [string]}], fixturesTruncated: boolean,
total, offset, count, rows: [row], limitations: [string] }`

`scannedFixtures` (since plugin 0.3.2) lists every (sub)fixture index the scan covered, so a client can tell
"no programmer value" from "not scanned" per fixture; it is cut at 1000 entries (`fixturesTruncated`). Since
0.3.4 each entry also lists the `attributes` that (sub)fixture has (from its UI channels), so "no row" can be
told apart from "no such attribute here" per cell. `rows` are paginated by `limit`/`offset` independently of
`coverage`: `coverage.complete` describes the scan, `total` versus `count` whether every row was returned. For
scope `fixtures`, `rootFid` is the FID of the top-level fixture an expanded cell belongs to (cells have FID
"None" themselves). For scope `selection`, a compound fixture appears only as its parent (SelectionTable lists
the parent) while its values live on the cells: re-scan it with scope `fixtures` to see them.

Row: `{ fixture, fid, subfixtureIndex, uiChannel, attribute, attributeIndex, present: true, masks: {activeValue,
activePhaser, individual}, stepCount, steps: [{step, channelFunction, absolute, absoluteValue, relative, accel,
accelType, decel, decelType, trans, width, integratedPreset?: {name, addrNative}}], value?, valueRaw?, relative?,
phaser: {supported: boolean, multiStep?, reason?, fade, delay, speed, phase, measure, gridPos}, absPreset?, relPreset?,
channelFunction?, physicalFrom?, physicalTo?, physicalUnit?, readout? }`

`absolute` / `value` are percent of the attribute range; `absoluteValue` / `valueRaw` are the 24-bit raw value.
Since plugin 0.3.2 a row also carries the channel function behind the UI channel with its `physicalFrom` /
`physicalTo` range, the attribute's `physicalUnit` and natural `readout`, so a client can convert `value` to
physical units (`physicalFrom + value / 100 * (physicalTo - physicalFrom)`); the fixture setters use this for
unit-aware read-back. Keys the API did not supply are absent (null in the tool).

Errors: `args.fixtures (string) is required for scope 'fixtures'`; `args.scope must be one of all, selection,
fixtures`; `no objects found for '<fixtures>'`. An unenumerable scope is not an error: `coverage.complete = false`.

### `fixtureOutput`

Request `args`: `{ ref: string, nonzeroOnly?: boolean, limit?: number (default 200, max 2000), offset?: number }`

Result: identity as in `fixtureAttributes` plus `{ source: "dmx output", note, unit, nonzeroOnly, channelsSource?:
"own" | "parent", metaSource?: "uiChannels+fixtureTypeWalk" | "uiChannels" | "fixtureTypeWalk", total, offset,
count, channels: [row], limitations: [string] }`

Row: `{ rtIndex, channel, coarse, fine, ultra, bits: 8|16|24, default, universe?, address?, patched: boolean,
coarseValue?, fineValue?, ultraValue?, value?, unit?: "raw8"|"raw16"|"raw24", percent?, attribute?, attributeIndex?,
physicalUnit?, channelFunction?, channelSet?, physical?, physicalFrom?, physicalTo?, conversion?: "linear from
channel function", note? }`. `value` absent = unavailable (universe not granted), stated in `limitations`.

### `dmx`

Request `args`: `{ universe: number, from?: number (default 1), to?: number (default from), nonzeroOnly?: boolean,
percent?: boolean, patched?: boolean }`

Result: `{ universe, granted?: boolean, universeInfo?: {name, granted, request, portOut, used, coarseParams,
mergeMode}, from, to, unit: "raw8" | "percent", nonzeroOnly, readVia: "GetDMXUniverse" | "GetDMXValue",
patched?: "rtChannels", count, values: [{channel, value, patched?: {fid, channel, part} | false}], source: "dmx
output", note, limitations: [string] }`

Errors: `args.universe must be between 1 and <count>`; `args.from and args.to must be between 1 and 512`;
`args.from must be <= args.to`; `... must be integers`.

### `cueContents`

Request `args`: `{ ref?: string }` or `{ sequence: number | string, cue: number | string }`, plus `{ part?: number,
fixtures?: string, expandPresets?: boolean }`. A non-numeric `sequence` is quoted (`Sequence "Name"`).

Result: `{ ref, source, trackedValues: "not_reconstructed", sequence?: {name, tracking, priority}, cue: {no, name,
trigType, trigTime, trigSound, release, assert, allowDuplicates, mibPreference, break, note, partCount},
parts: [part], presets?: { [addrNative]: presetData }, expandPresets, limitations: [string] }`

Part: `{ part, name, cuePart, timing: {cueFade, cueDelay, cueInFade, cueInDelay, cueOutFade, cueOutDelay, snapDelay,
duration, indivFade, indivDelay, transition, trackingDistance}, command: {text, delay, enabled}, mib: {mode, target,
fade, delay}, ownDataPresent, ownNonCookedDataPresent, memoryType, recipes: [recipe], otherChildren: [{name, class}] }`

Recipe: `{ index, name, enabled, selection, selectionMode, preset, presetRef?: {name, addrNative, addr, class},
presetResolved?: boolean, presetDataKey?, values, fadeX, delayX, speedX, phaseX, matricks, filter, generator }`

PresetData: `{ preset, available: boolean, error?, source: "GetPresetData", rows: [row], count, truncated,
topLevelKeys, byFixturesPresent, filterApplied?: "by_fixtures" | "none", meta }`

Errors: `'<ref>' resolved to a <class>, not a Cue`; `'<ref>' has no Part <n>`; `no object found for '<ref>'`.

### Incidental change

`getProp` (used by `objects`/`children` `fields`) used to return the text `"<function>"` when a field name
resolved to a method rather than a property (`fields: ["Count"]`). It now returns no value and the per-field
error `'Count' is a method, not a property`. The method is deliberately never called: a read-only op must not be
able to invoke arbitrary object methods (`Delete`, `SetFader`, ...) through a field name. The protocol is unchanged.

---

## Updating the plugin (required once for these tools)

The ops exist only in plugin 0.3.0+. Until the plugin inside onPC is re-imported, the tools answer with an error
that names the problem (`unknown op 'fixtureAttributes' ... needs gma3_mcp_bridge 0.3.0 or later`).

1. From the repository: `npm run install-plugin` (copies `plugin/gma3_mcp_bridge.lua` and `.xml` into the
   grandMA3 user library, `~/MALightingTechnology/gma3_library/datapools/plugins`).
2. In the onPC command line (Admin or a user with plugin rights), with the plugin in pool slot 1:

   ```
   Plugin "gma3_mcp_bridge" "stop"
   Delete Plugin 1 /NoConfirmation
   Import Plugin Library "gma3_mcp_bridge.xml" At Plugin 1
   ReloadAllPlugins
   Plugin "gma3_mcp_bridge"
   ```

   `ReloadAllPlugins` is required: onPC keeps the Lua chunk it already loaded for a plugin name (verified on
   2.5.1). `lua` need not be enabled; the inspection ops do not depend on it.
3. Check the start line in the command line history: `listening on 127.0.0.1:9800 (v0.3.0)`. `gma3_status` /
   `node scripts/bridge-cli.mjs ping` shows `bridgeVersion: "0.3.0"`.

### What to check after the re-import

Run the live test against a disposable show (`GMA3_LIVE=1 npm run test:live`, see `test/live/README.md`) and
look at its diagnostics, or run the tools by hand:

* `gma3_fixture_attributes` on a patched fixture: `source` should be `uiChannels` with integer `uiChannel` values
  and `attributeIndex` matching the Attribute Definitions (Dimmer 0, Pan 1, Tilt 2 ...). If `source` is
  `fixtureTypeWalk`, `limitations` says which function was unavailable (`GetUIChannels`, `GetAttributeByUIChannel`
  or `GetChannelFunction` returned something unexpected). Check that `dmx.coarse` matches the fixture's Patch
  address and that a compound fixture's `subfixtures[]` lists its instances.
* `gma3_programmer` with an empty programmer: `total: 0` **and** `coverage.complete: true`, `stats` all zero. Then
  with one fixture at a value and one at 0 %: both appear with `present: true`; the 0 % row has `value: 0`. A
  two-step phaser appears with `stepCount: 2`, `value: null`, two `steps`. `channelsWithStepsButInactiveMask` should
  stay 0; if it does not, the mask semantics differ from the expectation and the row filter needs adjusting.
* `gma3_fixture_output` / `gma3_dmx` on universe 1: on this onPC `DmxUniverse 1` showed `Granted = No`, so expect
  `granted: false`, no values and the "not granted" limitation until output is granted; afterwards raw values
  0..255 and a 16-bit attribute combined as `raw16`.
* `gma3_cue_contents` on a recipe cue: recipes with `presetResolved: true` and `presetRef.addrNative`; with
  `expand_presets: true` inspect `presets[*].topLevelKeys` and `rows` to confirm the `GetPresetData` flattening.
  On a part with hard values: `ownDataPresent: true`, `storedValues: null` and the hard-values limitation.
* In every case the selection count and the programmer must be unchanged (the live test asserts the selection count).

## Live test

`test/live/inspection.live.ts` (never run by `npm test`). Read-only: it lists the show's fixtures with
`ObjectList("Fixture Thru")`, inspects the first one that has attributes (grouping fixtures without a DMX mode
are skipped, nothing is hard-coded), the first compound fixture's `.1` subfixture, DMX universe 1 addresses 1-16,
and Sequence 900 Cue 1 if present; it creates, changes and deletes nothing and sends no command. It skips itself
on a plugin older than 0.3.0.

## Live run on onPC 2.5.1 (plugin 0.3.0, Lua execution disabled)

Confirmed by the coordinator's live run: `fixtureAttributes` via the `uiChannels` path (Fixture 601 with 16-bit
coarse/fine mapping, subfixture 501.3, Fixture 401); `programmer` rows with masks in all three scopes, unselected
fixtures included after ClearSelection; `dmx`/`fixtureOutput` returning null values with the "universe 1 not
granted" limitation (this onPC has Granted = No); `cueContents` with `ownDataPresent: true` plus the hard-values
limitation, and recipes with `GetPresetData` rows (keys such as `absolute`, `absolute_value`, `mask_active_value`,
`path` "Dimmer", `fid`). Fixes that followed the run: `Get("Mode")` can return display text instead of a handle
(mode now also resolved through `FixtureType.DMXModes`), `fixtureOutput` now shares the attribute resolution of
`fixtureAttributes`, and a subfixture without own RT channels points at its parent instead of "unpatched".

## Acceptance criteria that need the live run

Verified in the Lua harness (fake show) and the TypeScript tests: validation, pagination, null-filling, zero
versus absent, multi-step phasers, coverage reporting, not-granted universes, unresolved presets, the hard-values
limitation, and that no mutating API is called.

Only confirmable live (documented API, never executed on the plugin thread before this change):
`GetUIChannels(handle)` / `GetRTChannels(handle, true)` handle shapes (`INDEX`, `COARSE`, `FINE`, `SUBATTRIBUTE`),
`GetAttributeByUIChannel`, `GetChannelFunction`, `GetProgPhaser` mask semantics for untouched channels,
`SelectionTable`, `GetDMXValue`/`GetDMXUniverse` behaviour on a granted universe, and the `GetPresetData` table
shape (hence the generic flattening and `topLevelKeys`).
