# Configuration and tool reference

[README](../README.md) · [macOS setup](setup/macos.md) · [Windows setup](setup/windows.md)

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `GMA3_BRIDGE_HOST` / `GMA3_BRIDGE_PORT` | `127.0.0.1` / `9800` | Where the Lua bridge listens |
| `GMA3_BRIDGE_TIMEOUT_MS` | `15000` | Per-request timeout; also the default wall-clock budget sent with `gma3_lua` requests |
| `GMA3_ALLOW_LUA` | `1` | Set to `0` to not register the `gma3_lua` tool at all. The console-side switch (`Plugin "gma3_mcp_bridge" "lua"`, off by default) is the enforcement point; this one lets a deployment rule the tool out regardless of console state |
| `GMA3_OSC_HOST` / `GMA3_OSC_PORT` | `127.0.0.1` / `8000` | OSC fallback target (onPC: Menu > In & Out > OSC) |
| `GMA3_OSC_PREFIX` | *(none)* | OSC prefix configured in onPC, without slashes |
| `GMA3_INSTALL_DIR` | `~/MALightingTechnology` | Base folder containing versioned `gma3_<version>` directories; set explicitly on Windows |
| `GMA3_HELP_DIR` | *(auto-detected)* | Override with the exact manual HTML directory (`gma3_<version>/shared/language/HTML`) |

## Tools

| Tool | What it does |
| --- | --- |
| `gma3_status` | Bridge reachability, software version, show file, user; whether this server build matches its source checkout (`server.build`, [below](#build-staleness)) |
| `gma3_command` | Execute a command line command, returns OK / Syntax Error / Illegal Command |
| `gma3_lua` | Evaluate Lua inside onPC and return the result as JSON. Off until the operator [enables it on the console](lua.md); uses a best-effort execution budget |
| `gma3_lua_api` | Search the live Lua API descriptor (names, arguments, returns) |
| `gma3_get_object` | Properties (and optionally children and schema) of any object |
| `gma3_list_children` | Children of an object with selected property values, paginated |
| `gma3_objects` | Resolve a range like `Fixture 1 Thru 20` to objects with property values. Page and executor lists are expanded by the bridge (v0.20.0, [below](#page-and-executor-ranges-plugin-v0200)) |
| `gma3_dump` | Raw `Dump()` text of an object |
| `gma3_set_property` | `Set()` a property |
| `gma3_playback` | Go+, Go-, Pause, Off, Top, Flash, Load, ... on a sequence or executor |
| `gma3_set_fader` / `gma3_get_fader` | Fader levels via `SetFader` / `GetFader` |
| `gma3_sequences`, `gma3_cues`, `gma3_executors`, `gma3_fixtures`, `gma3_pool` | Convenience views |
| `gma3_help` | Read a page of the grandMA3 manual shipped with onPC |
| `gma3_start_bridge` | Start the plugin over OSC when the bridge is down |

Workflow tools (shared result model, see [below](#workflow-tools); details in [`tools/`](tools/)):

| Tool | What it does |
| --- | --- |
| `gma3_select` | Select fixtures by range or group; optional `ClearSelection` first ([docs](tools/fixtures.md)) |
| `gma3_set_attribute`, `gma3_set_color`, `gma3_set_position` | `Attribute "<name>" At ...` on an explicit target or, on request, the current selection; RGB 0–100, pan/tilt with explicit units. Small explicit targets are pre-checked against the fixture type's attributes, and the programmer is read back and compared per fixture in the unit sent ([docs](tools/fixtures.md)) |
| `gma3_clear_programmer` | `ClearSelection`, `ClearActive` or `ClearAll`, chosen explicitly ([docs](tools/fixtures.md)) |
| `gma3_store_cue`, `gma3_store_cue_part` | `Store ... /NoConfirmation` with explicit create / merge / overwrite mode, name and timing set as separate verified steps ([docs](tools/cues.md)) |
| `gma3_set_cue_timing`, `gma3_set_cue_trigger` | Edit part timing (fade, delay, out fade, out delay, snap delay) and trigger (Go, Time, Follow, Sound, BPM) with read-back ([docs](tools/cues.md)) |
| `gma3_goto_cue`, `gma3_delete_cue` | `Goto` (a playback mutation) and single-cue `Delete ... /NoConfirmation` with existence checks ([docs](tools/cues.md)) |
| `gma3_assign_to_executor`, `gma3_label_executor` | Inspect, then `Assign Sequence n At Page p.e` (replacing only with `replace`), label, read back ([docs](tools/executors.md)) |

Structured inspection tools (read-only; work with Lua execution disabled; need plugin v0.3.0 or newer, see
[Updating the plugin](tools/inspection.md#updating-the-plugin-required-once-for-these-tools)):

| Tool | What it does |
| --- | --- |
| `gma3_fixture_attributes` | Attributes of one fixture or subfixture with stable identifiers, units, ranges, defaults and DMX channel mapping; unknown metadata is `null`, never inferred ([docs](tools/inspection.md)) |
| `gma3_programmer` | Active programmer values (all fixtures, current selection, or given fixtures) with masks, timing and every phaser step; reports incomplete coverage instead of claiming an empty programmer ([docs](tools/inspection.md)) |
| `gma3_fixture_output` | DMX output per channel of a fixture: raw 8/16-bit values, percent, and a physical value where the channel function allows a conversion ([docs](tools/inspection.md)) |
| `gma3_dmx` | Raw or percent DMX values of a universe and channel range, with `granted` and optional patch lookup ([docs](tools/inspection.md)) |
| `gma3_cue_contents` | Stored cue and part data without Goto or Load: timing, command, recipes and preset references (optionally expanded); hard fixture values are reported as a documented limitation on 2.5.1 ([docs](tools/inspection.md)) |

Structured input tools (KB-05; need plugin v0.7.0 and the operator's `Plugin "gma3_mcp_bridge" "input=keyboard"`;
real console keys are pressed; details in [`tools/input.md`](tools/input.md)):

| Tool | What it does |
| --- | --- |
| `gma3_input_interaction` | `acquire`/`renew`/`end` a leased interaction: explicit ownership for holds across calls; commands from every bridge client are `[busy]` while it is open |
| `gma3_hardkey` | Tap, press or release a logical MA key (PLEASE, STORE, ESC, CLEAR, OOPS, NUM0–9, EXEC, MA) or a 2–4 key combination through validated shortcut/native routes; press needs an interaction |
| `gma3_keyboard` | The same for a raw `Enums.KeyboardCodes` key with explicit shift/ctrl/alt/numlock on press and release |
| `gma3_type` | Unicode text, one character event per code point, into `command-line` (shortcuts disabled by the operator, read back) or an acknowledged `text-field`; control characters refused; never presses Enter |
| `gma3_input_sequence` | Up to 16 ordered taps, presses, releases, combos, text and waits validated as a whole and serviced by the bridge loop; failures stop it, release what it holds and are never replayed |
| `gma3_hardkeys_status` | Read-only: enablement, backend and limitations, ownership records, interactions, sequence, busy descriptor; works with input disabled |
| `gma3_hardkeys_release_all` | Release this server's keys newest first with the stored tuples; `recover: true` re-attempts unresolved releases; works with input disabled |

Patch tools (KB-26; need plugin v0.19.0; no dialogs: one session through the patch edit copy per change; changes
require `exclusive: true` and have no undo; details in [`tools/patch.md`](tools/patch.md)):

| Tool | What it does |
| --- | --- |
| `gma3_patch_types` | Read-only: the show's fixture types and DMX modes with footprint and breaks |
| `gma3_patch_list` | Read-only: fixtures of the live patch (all stages, sub-fixtures) with FID, CID, type, mode, address, breaks, stage; FID range filter |
| `gma3_patch_add` | Add fixtures of one type/mode at consecutive FIDs, patched from an address or the first free block; pre-checked, committed, read back |
| `gma3_patch_set` | Readdress (swaps and moves across a fixture's own range work), unpatch or rename fixtures |
| `gma3_patch_remove` | Delete fixtures (not ones with sub-fixtures) |

Console feedback (KB-06; needs plugin v0.8.0; read-only, works with Lua and input disabled and while another client
owns input; details in [`tools/feedback.md`](tools/feedback.md)):

| Tool | What it does |
| --- | --- |
| `gma3_feedback` | Observe command text, last command, Blind/Highlight/Solo, Preview mode, a display's Preview bar, shortcut enablement, aggregate MA state, page, selected sequence, executor assignment, fader level and sequence activity; every item has `available`, `value` (null when unavailable, with a reason), `scope`, `source`, `observedAt` and `epoch`; not an atomic snapshot |

Resource `gma3://cheatsheet` holds a command syntax and object model reference.

Object references accept command syntax (`Sequence 1 Cue 3`, `Page 1.201`), dotted paths from a root
(`DataPool.Sequences`, `Patch.Fixtures`), numeric addresses (`14.14.1.7.1`) and the shortcuts `Root`,
`ShowData`, `ShowSettings`, `DataPool`, `MasterPool`, `SelectedSequence`, `CurrentCue`, `Patch`, `Programmer`,
`Selection`, `CurrentExecPage`. Property names are case-insensitive (`Name`, `TrigType`, `FID`); values come back
as the display text the editor shows, and object references are resolved to the referenced object's name.

### Build staleness

`npm run build` writes `dist/build-info.json` with a hash of `src/**`, `package-lock.json` and
`tsconfig.json` (plus the git commit, when available). The server compares that hash with the checkout's
current source at startup and on every `gma3_status` call, and reports the result as `server.build`:

| `state` | Meaning | `action` |
| --- | --- | --- |
| `current` | The running build matches the source, or the server runs from TypeScript source (`npm run dev`) | *(none)* |
| `stale` | The source changed after the build (for example a `git pull` without a rebuild), so tools added or changed since then are missing or out of date | `npm ci && npm run build` in the checkout, then restart the MCP client |
| `stale` | `dist` was rebuilt from the current source but the running process still has the old build | Restart the MCP client |
| `unverified` | `dist/build-info.json` is missing (built with plain `tsc`), or no `src/` sits next to the build (package or container install) | `npm run build` when the stamp is missing; otherwise nothing |

When the build is stale at startup, the server's MCP instructions tell the agent so, and to tell the user
instead of working around missing tools with `gma3_lua` or `gma3_command`. The startup log line on stderr
says the same. Changes outside the hashed inputs (docs, the Lua plugin) do not make the build stale. A
build made before this check existed has no stamp and no check, so it cannot report itself.

## Workflow tools

The tools above are thin wrappers over single bridge requests and keep their original responses. The
workflow tools added for fixture programming, cue storage and editing, executor assignment are built on a shared result model (`src/results.ts`) so a client can tell, after every call,
whether to continue, inspect console state, or stop:

```jsonc
{
  "operation": "store_cue",
  "target": { "sequence": 1, "cue": "2.5" },
  "outcome": "succeeded",              // succeeded | failed | partial | unknown
  "verification": { "status": "matched" },  // matched | mismatched | unavailable | not_requested
  "steps": [ { "name": "store", "status": "succeeded", "op": "cmd", "command": "Store Sequence 1 Cue 2.5 /NoConfirmation", "feedback": "OK" } ],
  "summary": "store_cue succeeded. read-back matched."
}
```

* Recognised negative command-line feedback (`Syntax Error`, `Illegal Command`, `... does not exist`, ...) is a
  failure. Feedback the server does not recognise makes the step `unknown`; it is never assumed to be success.
* A transport error after a request was dispatched (timeout, dropped connection) makes the step `unknown`. The
  command may have executed, so nothing is retried and nothing falls back to OSC.
* Multi-step operations stop at the first failed or unknown step; the remaining steps are reported as
  `skipped`. An operation with some steps done and one not is `partial`.
* Any outcome other than `succeeded`, and any `mismatched` read-back, is returned as an MCP tool error with the
  full result in the error text.
* Inputs are validated before anything is sent (finite numbers, zero accepted as a deliberate value, cue numbers
  with up to three decimals, mutually exclusive options). Object names may not contain any of
  `\ " $ & * ? , . ; ^ { } | ~`: onPC 2.5.1 silently removes those characters from a name whether it arrives
  through `Label` or through the Lua `Set("Name")` API (verified live; "Look 2.5" becomes "Look 25"), so the tools
  refuse such names rather than store something different from what was asked.
* Mutations issued by this server, including the existing `gma3_command`, `gma3_set_property`, `gma3_playback`,
  `gma3_set_fader` and `gma3_lua` (a script may call `Cmd()` or `Set()`, so it is never treated as read-only),
  are serialised by one lock so a multi-command workflow is not interleaved with another tool call. Each
  workflow holds the lock from its first command through its read-back. This orders only this process's own
  requests: it does not isolate anything from another console operator or another MCP server or client.

Per-tool documentation (commands sent, selection and programmer impact, what is and is not verified, live test
procedure) is in [`tools/`](tools/).

Console behaviour the tools were adjusted to after the live run on onPC 2.5.1.0 (plugin v0.3.0, Lua execution
disabled, disposable show):

* A cue's name is the name of its Part 0. `Set("Name")` on the cue object is ignored; the tools set it on the part.
* `CueFade` and `CueDelay` are composite display properties ("3.00 / 1.50"). Writes go to `CueInFade`,
  `CueOutFade`, `CueInDelay` and `CueOutDelay`, and read-back compares those.
* An executor has no label of its own: `Label Page 90.201 "x"` renames the assigned sequence, and the executor
  shows that name. `gma3_label_executor` is documented accordingly.
* Entering `Fixture 1 Thru 5` adds to the selection while no values are active and replaces it once values are
  active, as the manual says; `gma3_select` has `clear_first` for a deterministic result.
* DMX output reads return `null` with a `granted: false` limitation while the universe is not granted to this
  onPC (no output license), rather than zeros.
* Programmer values read through the `programmer` op are percent of the attribute range (Pan 10° on a
  −225..225° fixture reads 52.22 %); the fixture setters convert the value they sent through each fixture's
  own range before comparing. A fixture without the attribute simply has no row, which the setters report as
  a mismatch. A selected compound fixture is listed only as its parent while its values sit on the cells.

Verified against grandMA3 onPC 2.5.1.0 on macOS (its Lua engine reports Lua 5.5).

## Bridge protocol

One JSON document per line over TCP.

```
→ {"id":"1","op":"cmd","args":{"command":"Go+ Sequence 1"}}
← {"id":"1","ok":true,"result":{"command":"Go+ Sequence 1","feedback":"OK"}}
```

Ops: `ping`, `cmd`, `lua`, `object`, `children`, `objects`, `dump`, `set`, `setfader`, `getfader`,
`executor`, `executors`, `api`, `stop`, and since plugin v0.3.0 the read-only inspection ops `fixtureAttributes`,
`programmer`, `fixtureOutput`, `dmx`, `cueContents` (arguments and result shapes in
[docs/tools/inspection.md](tools/inspection.md#bridge-protocol-additions)), and since v0.4.0 the read-only
`modules` op (loaded [console interaction modules](modules.md), their versions, errors and instance status;
`ping` carries the same summary under `modules`), and since v0.5.0 the owned input session ops `input.open`,
`input.renew`, `input.close`, `input.press`, `input.tap`, `input.release`, `input.releaseAll`, `input.recover`,
`input.status` and the fake-backend test control `input.fake` (below), since v0.6.0 `input.combo` (below), and since
v0.7.0 the interaction and sequence ops `input.begin`, `input.extend`, `input.end`, `input.sequence`,
`input.sequence.status`, `input.sequence.abort` ([below](#interactions-admission-text-and-sequences-plugin-v070-kb-05)), and since
v0.8.0 the read-only feedback ops `feedback.describe` and `feedback.read` ([below](#console-feedback-plugin-v080-kb-06)), v0.13.0 `feedback.context`, `feedback.watch` and `feedback.unwatch` ([below](#control-context-plugin-v0130-kb-17)), and v0.14.0 the continuous-control ops `control.bind`, `control.open`, `control.renew`, `control.close`, `control.submit`, `control.status` and `control.recover` ([below](#continuous-control-plugin-v0140-kb-18)), and v0.19.0 the patch ops: reads `patch.state`, `patch.types`, `patch.list`, `patch.check`, `patch.collections` and `patch.fingerprint`, and the guarded, `exclusive`-only `patch.enter`, `patch.add`, `patch.set`, `patch.remove` and `patch.commit` ([tools/patch.md](tools/patch.md)), and since v0.20.0 the page/executor range guard on every op that takes an object reference ([below](#page-and-executor-ranges-plugin-v0200)), and since v0.21.0 the read-only selection-grid ops `group.read` and `selection.grid` ([below](#selection-grid-reads-plugin-v0210-sb-02)), and since v0.22.0 the read-only preset ops `preset.read` and `preset.context` ([below](#preset-reads-plugin-v0220-sb-03)), and since v0.23.0 the programmer's environment and the phaser layers of programmer and preset steps ([below](#phaser-layers-plugin-v0230-sb-04)), and since v0.24.0 cue-part data with cooked flags in `preset.read` ([below](#cue-part-data-plugin-v0240-sb-05)). See
[`plugin/gma3_mcp_bridge.lua`](../plugin/gma3_mcp_bridge.lua).

Error replies are `{"id", "ok": false, "error": "[code] message"}`; since v0.7.0 they also carry `code` (the bracketed
code, when there is one) and, for errors the input module reported as tables, `detail` (the structured error: owner
and remaining lease of a busy lock, the keys a combo pressed before it failed and their rollback, the unresolved hold
of a press that raised). The TypeScript `BridgeError` keeps both as `code` and `detail`.

`ping` reports the Lua execution policy as `lua: {enabled, maxMs, maxSteps, bounded}`. The `lua` op is
refused with an error while `enabled` is false; its optional `maxMs` / `maxSteps` args can only tighten the
console's budget, never loosen it.

### Page and executor ranges (plugin v0.20.0)

On onPC 2.5.1, `ObjectList` over an executor range (`Page 1.180 Thru 1.181`, empty or assigned executors alike) never returns: the console's DataBase
task hangs (`onpc/temp/watchdog_status` reads `DataBase;Graphics;`), the UI stops reacting and onPC has to be quit and
relaunched, losing unsaved show changes. The bridge cannot interrupt a C call. Since v0.20.0 every op that takes an
object reference (`object`, `children`, `objects`, `dump`, `set`, `setfader`, `getfader` and the inspection ops) checks
the reference first:

* No `Page`/`Executor` keyword (shortcuts `P`, `Ex` and longer prefixes count), or no list operator (`Thru`/`T`, `+`,
  `-`): sent to `ObjectList` unchanged. `Page 1.180` (one empty executor reads nil, "no object found") and
  `Sequence 9000 Thru 9001` are verified safe.
* `Page P.E Thru P.E2`, `Page P Thru P2` and `+` lists of those terms (pages and executors not mixed, an executor
  range on one page, every number 1–9999): expanded into single `Page P` / `Page P.E` lookups, in the given order,
  duplicates once, at most 1000 objects. Empty executors and missing pages are skipped, so the result matches what the range names that exists;
  a covered executor comes back as its `Proxy` handle like the single lookup returns it.
* Any other form with a Page/Executor keyword and a list operator is refused with `[unsafe-range]` before any console
  call: open ranges (`Page Thru`, `Page 1.180 Thru`), ranges across pages, `Executor`/`Exec` lists (they follow the
  user's current page), `-`, names, deeper addresses, numbers outside 1–9999, more than 1000 objects, and the `*`
  wildcard in any form (`Page 1.*`, `Executor *`, `Page "LOS*"`), even without a list operator. Read a page's executors with
  `gma3_list_children` on `Page P` instead.

The guard does not cover `gma3_lua`: a script that calls `ObjectList` with an executor range still hangs the console.
Evidence: [probes/objectlist-hang-macos-2.5.1.md](probes/objectlist-hang-macos-2.5.1.md).

### Selection-grid reads (plugin v0.21.0, SB-02)

A group keeps its fixtures and their selection-grid cells in `SelectionData`, a Lua table the `object` / `objects` ops
render as `""`. Two read-only ops (not guarded, usable with Lua disabled) expose it and the live selection:

* `group.read {ref}` (a group, e.g. `"Group 5"`): `{ref, addr, no, name, lock, preserveGridPositions, count,
  truncated, unreadable, items}`; `lock` and `preserveGridPositions` in the edit role (`""` = unlocked). Each item is
  `{sfIndex, fixture, fid, path, addr, name, x, y, z}` in the stored order (patch order on 2.5.1). `fixture` is the
  item's own FID, otherwise `path`; `path` is the dotted id from the nearest ancestor with a FID (`"501.1"`; also for a
  cell with its own FID, and `"4.1"` for fixture 401 inside grouping fixture 4); `addr` is the console address, the
  stable identity. `fixture` is `null` when neither exists. An entry that
  is not an item is `{unreadable: true}`, never dropped. A non-group is `[not-group]`; SelectionData that is not a
  table is `[unreadable]`. Nothing is selected.
* `selection.grid {}`: `{count, truncated, items}` for the current selection in selection order, with the cells
  `SelectionFirst` / `SelectionNext` report (MAtricks-transformed while MAtricks is active). A failing
  `SelectionFirst` / `SelectionNext` is `[unreadable]`, never an empty selection.

Both stop at 10000 items (`truncated: true`). Tools: [tools/groups.md](tools/groups.md).

### Preset reads (plugin v0.22.0, SB-03)

Two read-only ops (not guarded, usable with Lua disabled):

* `preset.read {ref, typesFor?}` (a preset, e.g. `"Preset 4.12"`, or its numeric address): `{ref, addr, addrNative,
  no, name, pool: {no, name}, presetMode, storedData, featureGroup, lock, maxDepth, hasMAtricks, magic, inputFilter,
  referencedBy, dependencies, dependenciesReadable, rows, count, truncated, types?}`. Each row comes from
  `GetPresetData(..).by_fixtures`: `{fixture (the FID or dotted cell key), attribute, sfIndex, uiChannel, fixtureType,
  mode (selective | global | universal), hasAbsolute, hasRelative, value, valueRaw, relative, fade, delay, speed,
  phase, stepCount, steps?, absPreset?, relPreset?}`, sorted by subfixture index; `absPreset` / `relPreset` and each
  dependency are `{valid, addr, addrNative, name, no, pool, poolName}`, or `{valid: false}` for a deleted source;
  dependencies also carry `contentCrc`. `typesFor: [subfixture index, ...]` returns `types` with the fixture type each
  of those subfixtures gets in the rows (a cell takes its fixture's). A non-preset is `[not-preset]`; unreadable preset
  data is `[unreadable]`, never an empty preset. At most 5000 rows.
* `preset.context {pool?}`: `{preferences, preferencesReadable, pool?}`: the operator's StorePreferences (StoreMode,
  StoreSource, ChannelFilter, StoreLook, PresetMode, PresetInputFilter, StoreEmbedded, StoreMAtricks, KeepActivation,
  UpdateModePresets, UpdatePresetMode, UpdateInputFilter, GridMergeMode, RecipeStoreMode, CueOnly, TrackingShield) in
  the edit role and, with `pool`, `{no, exists, name, presetMode, inputFilter}`.

Tools: [tools/presets.md](tools/presets.md).

### Phaser layers (plugin v0.23.0, SB-04)

Extensions of existing read ops (no new op):

* `programmer`: the result carries `environment`, the user environment the programmer belongs to (`"Normal"`, or
  `"Preview"` with its own programmer). Each row's `phaser` adds `speedMaster` (0-based) and `gridPosMatricks` (the
  MAtricks-transformed grid position) to `fade`, `delay`, `speed` (Hz), `phase` (degrees), `measure` (×100) and
  `gridPos`.
* `preset.read`: rows add `measure` and `speedMaster`; every step of a multi-step row lists `accel`, `decel`,
  `accelType`, `decelType`, `trans`, `width` (absent = console default: width/trans 100, accel/decel 0) and
  `integrated`, the preset the step calls (`{valid, addr, addrNative, name, no, pool}`).

Tools: [tools/phasers.md](tools/phasers.md).

### Cue part data (plugin v0.24.0, SB-05)

`preset.read` also accepts a cue part (`"Sequence S Cue C Part P"`): `GetPresetData` reads it like a preset. The result
carries `class` (`"Preset"` or `"Part"`), and every row has `cooked` (true when the value came from a recipe,
`mask_cooked` non-zero; 511 on 2.5.1). Recipe lines themselves are read and written with `children` / `objects`
(`asText: false` for their Selection, Values, MAtricks and Filter handles) and `set`. Tools:
[tools/recipes.md](tools/recipes.md).

### Timecode shows (plugin v0.25.0, SB-08)

Timecode events have no command-line address, so two ops reach them (evidence:
[sb-08-timecode-macos-2.5.1.md](probes/sb-08-timecode-macos-2.5.1.md)):

- `timecode.read` `{timecode, maxEvents?}` (read-only): `settings` (Name, Cursor, Duration, RawDuration, LoopMode, LoopCount,
  TCSlot, OffsetTCSlot, AutoStart, AutoStop, SwitchOff, Goto, AssertPrevEvents, PlaybackAndRecord, RestartOption,
  FrameReadout, TimeDisplayFormat, Lock), `playing`, and flat lists:
  - `groups`;
  - `tracks` with `target` (class, addr, name, no);
  - `ranges`;
  - `subtracks` with their class;
  - `events`, each with `group`, `track`, `range`, `subtrack` and `index` (storage order), `raw` (seconds × 2^24),
    `time`, `token`, `status`, `cue` (addr, no ×1000, sequence) and `executeCommand`.

  `eventCount` and `truncated` (more than `maxEvents`, default and maximum 5000) report completeness. The lists are
  flat because replies nest at most six levels.
- `timecode.edit` `{timecode, action, ...}` (mutating, refused with `[busy]` like `cmd`). Each structural step is its
  own request, because the console creates a group's track and a track's range on the next frame:
  - `add_group`;
  - `add_track {group}`;
  - `set_target {group, track, target: "Sequence N"}` (sequences only in this release);
  - `add_events {group, track, range?, events: [{raw, token, status?, cue?: "Sequence S Cue C"}]}`. It appends in
    the given order to the range's command subtrack, created on first use. That needs the target to be set in an
    earlier request (`[not-ready]` otherwise). Every event is validated before the first is appended.

  Target and cue references go through the bridge's guarded object lookup, so an executor range is expanded or refused
  (`[unsafe-range]`) and never reaches `ObjectList`.

  Nothing plays, records or selects. Tools: [tools/timecode.md](tools/timecode.md).

### Owned input sessions (plugin v0.5.0, KB-03)

Owned input is a separate per-start opt-in (`Plugin "gma3_mcp_bridge" "input=keyboard"`, `input=quickey` (v0.10.0,
KB-13: the owned-Quickey backend through the KB-12 bank; holds report `target = {page, executor, quickeyIndex, code}`),
`input=mixed` (v0.12.0, KB-15: the Quickey and keyboard parts on one instance; holds report the part as `backend`, `input.route` reports `dispatchBackend`, and a press that would put a Quickey and a PC key down at once or change the shortcut mode while a Quickey is down is refused `unqualified-mix`),
`input=fake`, or `input=off`); `ping` reports it as `input: {enabled, backend, sessions, holds, unresolved, unresolvedFromPreviousRun, bank, modeChange, retained, quarantined}` (the last three since v0.11.0, KB-14: a temporary keyboard-shortcut mode change in progress or unresolved, see [modules.md](modules.md))
(`bank` since v0.9.0: `{provisioned, id, state, codes, qualified, problems}` of the KB-12 Quickey bank, or `{provisioned: false, kept}` for a record awaiting re-verification; `input.status.status.bank` has the full report).
The **keyboard backend** (v0.6.0, KB-04) presses real console keys through `Keyboard()`; the **fake backend**
records events and simulates aggregate key state, and nothing reaches a console key. A switch between them is
refused while ownership records exist and leaves the previous policy intact.

A session belongs to the TCP connection that opened it (`input.open {leaseMs?, label?}`; the id is derived
from the connection and never taken from a request), so another connection cannot release or renew it.
`input.press {key | pcKey, shift?, ctrl?, alt?, numlock?, display?, executor?, maxHoldMs?, exclusive?}`,
`input.tap {..., holdMs?}` and `input.combo {keys: [spec, ...], holdMs?}` need input enabled; `input.release {hold | key | pcKey...}`, `input.releaseAll`,
`input.recover` (own session only), `input.close` and the read-only `input.status` stay available while input
is disabled, because they are the recovery path. Errors carry a bracketed code: `[no-session]`, `[conflict]`
(with the owning session), `[not-owner]`, `[lease-expired]`, `[route-changed]` (naming the key, the original tuple and
the mismatch), `[unsupported]`, `[capacity]`, `[exclusive-hold]`, `[exclusive-refused]`, `[press-failed]`,
`[input-disabled]`, `[stopping]`. Hold reports carry `backend`, `pressOutcome` and `releaseOutcome`
(`scheduled`/`dispatched`/`confirmed`/`unresolved`; a `Keyboard()` release is `dispatched`, never `confirmed`) and,
for MA, `pressReadback`/`releaseReadback` with the bounded aggregate MASTATE readback (`observed`/`inconclusive`).
A tap's response means press dispatched and release scheduled. `exclusive: true` is the long-press: while it is
held every new press from every connection is `[exclusive-hold]`; it is `[exclusive-refused]` while any other record
exists. `input.combo` preflights every key before the first event, presses in order and releases newest first. A disconnect, lease expiry, `input=off`, `stop` and `Cleanup` attempt to
release what a session holds; a release that fails or cannot be confirmed is kept as an unresolved record,
survives a bridge restart and is cleared only by the operator's console-side
`Plugin "gma3_mcp_bridge" "input recover"` (or the owner's `input.recover`). At the next start the kept
records are adopted before any input is admitted, so their keys are reserved (`[conflict]` naming the
`previous-run` session) until the operator recovers them; `ping.input.unresolvedFromPreviousRun` counts only
records the instance could not take. A module that raises in `service()` is detached only after input is
disabled, every held key got a release attempt and the unresolved records were kept. `input=off` keeps the
attached backend, so `input recover` still releases then; only on an instance that never had a backend
attached (the default after a restart) can it dispatch nothing: it says so, the records stay reserved and
unresolved, and a later `input recover` after `input=fake` releases them. `input.status` never releases
anything. Since v0.6.0 the records carry their backend: `input recover` on an instance without a backend attaches the
records' own backend (keyboard or fake) for cleanup only, input stays disabled, and a record is never released through
another backend. `input.fake {action}` (fake backend only) stages `failRelease`/`failPress` (`pcKey`, `sticky`,
`error`), `clearFailures`, `confirm` (`mode`), `physicalRelease`/`physicalPress` (`pcKey`) and returns the
event log; see [docs/modules.md](modules.md) for the ownership and release semantics.

### Interactions, admission, text and sequences (plugin v0.7.0, KB-05)

An **interaction** is a leased ownership token of one session. `input.begin {leaseMs?, label?}` opens the
connection's session on demand and returns `{interaction: {id, session, leaseMs, expiresAt, remainingMs, state},
session}`; it is refused `[busy]` while another interaction is open, a sequence runs or any key is held, and
`[input-disabled]` while input is off. `input.extend {interaction, leaseMs?}` moves the deadline (the session lease
is extended to cover it; nothing is injected). `input.end {interaction}` aborts the interaction's sequence, releases
its holds newest first and reports `released`/`unresolved`; ending twice is harmless (`alreadyEnded`). An
interaction is never resumed: an id that ended, expired or belonged to a closed connection is `[no-interaction]`,
another connection's id `[not-owner]`.

`input.press`, `input.tap` and `input.combo` accept `interaction`. A standalone hold (`input.press`, `input.combo`
without `holdMs`) needs it (`[interaction-required]`); a bounded tap or chord tap may run without one while the
instance is quiet. While an interaction is open, every call of its session must carry its id (otherwise `[busy]`,
"pass its id"), so callers sharing one connection cannot act on each other's holds; a running sequence refuses
every other input (`[busy]`, reason `sequence`), and a key held by another session refuses new input from everyone
else (`[busy]`, reason `hold`). Exclusive long-press and route-change refusals keep their precedence.

**Admission across connections.** While the module reports itself busy (an open interaction, a running sequence, a
held key or an unresolved release record, of any connection), the bridge refuses `cmd`, `set`, `setfader` and `lua` from **every** connection with
`[busy]` (`detail.reason`, `owner`, `interaction`/`sequence`/`hold`, `remainingMs`) instead of running them into a
changed context. `ping.input` reports `busy`, `interaction` and `sequence`. Reads, `input.status`,
`input.sequence.status`, `stop` and the owner's `input.release`, `input.releaseAll`, `input.recover`, `input.end`
and `input.close` are never guarded. An unresolved record (reason `unresolved`) keeps the bridge busy until a
recover resolves it, because the key may still be down.

`input.sequence {steps, interaction?, leaseMs?, label?}` validates every step before the first event and returns
the sequence report (`id`, `state` `running`/`completed`/`failed`/`aborted`, `index`, `counts`, `events`,
`cleanup`, `estimateMs`); the loop then runs it. Steps: `{kind: "tap", key|pcKey+modifiers, holdMs?, exclusive?,
executor?, display?}`, `{kind: "press", ...}`, `{kind: "release", key|pcKey...}` (a key an earlier step pressed or
the session holds), `{kind: "combo", keys: [...], holdMs?}`, `{kind: "text", text, context: "command-line"|
"text-field", acknowledgeFocus?, display?}`, `{kind: "wait", ms}`; at most 16 steps, about 30 s of holds, waits
and typing; hold durations, `exclusive` flags and `maxHoldMs` of every key (combo constituents included) are checked in
this preflight, and a `text-field` text step may not be followed by a PLEASE/Enter step. Each event ends `completed`, `failed`, `uncertain` (a dispatch raised or a release stayed unresolved),
`unattempted` or `aborted`, with `pressOutcome`/`releaseOutcome`, `typed`/`remaining` and `readback`
(`observed`/`inconclusive`/`unavailable`/`pending`) where applicable. A failure stops the sequence, releases what it
pressed (newest first; `cleanup`) and ends an interaction begun for it; nothing is replayed. `input.sequence.status
{sequence}` is read-only for anyone (the last 8 finished reports are kept); `input.sequence.abort {sequence}` is the
owner's abort. Without `interaction` a sequence begins and ends its own interaction (`autoInteraction`); with one, the
remaining lease must cover the estimate (`[lease-too-short]`).

**Text** is UTF-8 iterated by code point (`utf8.codes`), at most 256 characters, with newline, carriage return,
tab, other C0/C1 controls, DEL and the line/paragraph separators refused (`[bad-argument]`); nothing is normalised
and nothing ever presses Enter. Every text step needs `acknowledgeFocus: true` (`[focus-unverified]`: the receiving
element is not observable). `command-line` additionally needs `KEYBOARDSHORTCUTSACTIVE` read as `false`
(`[unsupported]` otherwise, never toggled) and a readable `CmdObj().cmdtext` (`[unsupported]` otherwise, rechecked
before every chunk), and is read back from `CmdObj().cmdtext` within `readbackMs`: `observed`
completes the step, an inconclusive readback leaves it `uncertain` (`text-unverified`) and stops the sequence;
`text-field` has readback `unavailable`. Text is refused while an exclusive hold or a route mismatch exists
(`[exclusive-hold]`, `[route-changed]`). Characters go out as `Keyboard(display, 'char', <character>)`, 8 per loop
iteration, with the enablement, exclusive hold and held-key routes rechecked between chunks: a change stops typing
(`uncertain` with `context-changed`/`exclusive-hold`/`route-changed`, `typed`/`remaining` reported); a `char` call
that raises leaves the event `uncertain` at `uncertainChar`.

### Console feedback (plugin v0.8.0, KB-06)

`feedback.describe` lists the feedback module's readers (name, scope, source, parameters, notes, the `executorActive`
alias) with the instance status. `feedback.read {items?, readers?, display?, displays?, executors?, sequences?,
tokens?, all?}` expands the request in the module (`items` are reader names or `{name, params}`; `readers` names
parameterless readers, `previewBar` once per display; `executors` become one `executor` and one `fader` item per token
each, `sequences` one `sequenceActive` item each; `all` adds every parameterless reader) and reads the items one after
another, at most 64 per request and 32 executors/sequences (the rest is a `limitations` entry, never read). The reply
is `{observedAt, epoch, atomic:false, identity {showFile, user, profile}, invalidated?, items[], count, truncated,
limitations[], bridgeVersion, module}`; each item `{name, key, scope, source, params?, available, value?, reason? |
error?, observedAt, epoch, note?, alias?}`. The epoch starts at 1 at every bridge start and increments when the
identity changed since the previous check (at most once per second; `invalidated` names the change on that reply).
Neither op is guarded by the input admission, needs Lua, opens an input session or changes console state; an
empty request is `[no-items]`, a bridge without the module `[no-feedback]`.

### Control context (plugin v0.13.0, KB-17)

`feedback.context {display?, executors?, allExecutors?, cached?}` returns the feedback module's
`contextSnapshot()` ([modules](modules.md#control-context-and-binding-snapshots-gma3_mcp_feedback-030-kb-17)): identity (show
file, user, profile, data pool), the authoritative display (`display` requested, else the configured display 1; a
display without an encoder bar is unavailable and never replaced), the encoder bank/page/context, the ordered slots
with attribute identity, label, unit, readout, resolution, layer, availability and programmer value state, one target
per listed executor (`allExecutors` adds every assigned executor of the current page, bounded) with its configured
functions, the configured fader function's level, activity, appearance and `playbackTarget` (a Quickey or an executor
reserved by this bridge's KB-12 bank is never one), plus `generation`/`generationChanged`: the generation moves when an
input's meaning changed, never for a value or level alone. `cached = true` serves the snapshot from the observations the
plugin loop keeps for the spec given to `feedback.watch {display?, executors?}` (no read happens; items not yet observed
are unavailable and no generation is claimed), `feedback.unwatch {}` stops that. Read-only, never guarded by the input
admission, usable with Lua disabled; malformed arguments are `[bad-args]`, a feedback module older than 0.3.0 `[no-feedback]`.
Since v0.17.0 (KB-21, feedback 0.5.0) `executorPage` binds the listed executors to that page explicitly (read through
`ObjectList("Page P.E")` whatever page the console shows; `executorMode = "page"`, `executorSpecPage`; a page that does
not exist is `pageMissing` and nothing creates it) and every target carries `pool`, `page`, `mode`, `width`,
`expanded`/`coveredBy` (an expanded assignment covers the following numbers of its row: not separate playbacks); without
`executorPage` the executors follow the user's page as before. `[no-feedback]` on a module without explicit pages.
With feedback 0.6.0 (KB-23) every attribute slot also carries `featureGroup`, `featureName`, `activationGroup` (names
from the definition's own path text) and the definition's `Color` as `colorR/G/B/A` with `colorDefined` (or
`colorUnavailable`), and every assigned executor's `appearance` carries `r, g, b, a, format` (or `rgbaUnavailable`):
the verified metadata a surface lights its controls from ([modules](modules.md#parameter-colours-and-playback-feedback-gma3_mcp_feedback-060-kb-23)). Neither is part of the generation.

### Continuous control (plugin v0.14.0, KB-18)

The `gma3_mcp_control` module ([modules](modules.md#continuous-control-admission-gma3_mcp_control-010-kb-18)) behind
the `control.*` ops is OFF until the operator enables it (`Plugin "gma3_mcp_bridge" "control=fake"` or, since v0.15.0,
`"control=console"`; `control=off`, `control status`, `control recover` as for input). On the fake backend intents are
recorded and nothing moves on the console; on the console backend (KB-19, control 0.2.0, feedback 0.4.0) relative
motion on an attribute slot is applied as `Attribute "<name>" At +/- <detents x step>` for the selection (Percent /
PercentFine readout: 1 per Coarse detent; Physical: the attribute's range / 120 in physical units; Fine a tenth; a
`fine` event a tenth again); since v0.16.0 (KB-20, control 0.3.0) a strip **touch** on an attribute slot is a hold
(the bridge is `[busy]` with it, the slot is the session's, nothing is issued) and a strip **position** is
`Attribute "<name>" At <value>` over the verified travel (Percent 0..100, Physical `physicalFrom..physicalTo` in physical
units), refused `mixed-values` while the selection's values disagree and `values-incomplete` while they were not completely read (a bounded scan or a failed read) unless the event carries `takeover: true`; presses
and executor elements stay refused `unsupported` (with `backend` and `reason`); switching backends while running ends the
gestures through the previous one. `control.status`
then also carries `capabilities` and `backendStatus` (counters, the last command, the calibration table), `lastApplied.result`
the command issued, and the ping summary the backend name. `control.bind {display?, executors?, executorPage?}` names what this bridge's events mean (the same spec
`feedback.watch` takes; the loop keeps it observed and the cached generation is what events are checked against) and
returns the current `generation` or why none is claimed, plus the `binding` revision: generations are per spec, so a
replaced spec is a new revision (queued motion dropped, holds rebound) and events must carry `binding` as well as
`generation` (`binding-required` without it, `stale-binding` with an old one, each naming the current revision; releases
need neither). A snapshot built from stale observations is no binding
(`binding-unknown`). Since v0.17.0 (KB-21, control 0.4.0) an executor target is `{executor, element, page?}` and resolves
by (page, executor) against the binding: a page-bound executor needs `page`, a following one must not carry it; a covered
number, a missing page, an empty, reserved or Quickey executor are `target-unavailable` with the reason; the resolved
target (and `lastApplied.target`) names pool and page (`exec<pool>/<page>.<n>.<element>|<assigned>|<function>`); a held
button's or touch's target is **frozen** until its release (the release, a forced end and the unresolved record carry it,
whatever a bank or page change mapped to the control since; `control.status` lists it under `gestureList[].frozen`).
Since v0.18.0 (KB-22, control 0.5.0) the console backend serves executor **keys** as `Press`/`Unpress Page <p>.<e>` (the
configured button function; only the qualified functions Temp, Flash, Toggle, Top, Go+, others `unsupported`) and
executor **faders** as `Fader<Function> Page <p>.<e> At <level>` for the configured fader function (Master and Temp
qualified; Rate, Speed, X, CrossFade, Time `unsupported` until qualified); a fader touch is a hold; a release whose
executor was reassigned or emptied while held is kept as an `assignment-changed` record under `control.status`
`unresolved` (nothing issued on the replacement) until `control.recover` finds the original object back; after the PR #26
review a frozen release is issued only on a current observation of its executor in the same data pool (else kept
`unverified` / `poolChanged`), a refused release is kept too, a hold stays owned until its release applied, a stale
queued down presses nothing, and a held target is `conflict` for every other control; round 2: the verification is a
live read at release time (never the cached binding), a hold whose down never applied is discarded at the session's end
without a release, and an unresolved release reserves its target (`conflict`, `holder: "unresolved"`) until
`control.recover` applies it; round 3: reservations are by the executor's stable address (not its object or function)
and the gesture bound cancels an expired gesture's queued intents. `control.open {leaseMs?, label?}` / `control.renew` /
`control.close` are this connection's session (`conn-<id>`, opened on demand by `control.submit`). `control.submit
{events: [...]}` (at most 32 per request, or `event` for one) admits each event in order and reports every outcome in
place: `{accepted, queued, coalesced?, superseded?, lost, target, generation}` or `{refused: code, message, ...}` with
the module's codes (`bad-event`, `duplicate`, `out-of-order`, `rate`, `binding-unknown`, `stale-generation` with the
current `generation`, `stale-binding` and `binding-required` with the current `binding`, `target-unavailable`, `unsupported`, `mixed-values` and `values-incomplete` (KB-20), `gesture-rebound`, `busy` with the other owner,
`conflict` with the owning session, `capacity`, `queue-full`); a refusal never stops the batch. `control.status {}` is
read-only (sessions with per-device order counters and gestures, counters, the bounded event log, unresolved releases,
`busy`, `yourSession`); `control.recover {}` adopts the releases kept from a previous run and re-attempts every
unresolved one. While a surface gesture is active (a touch or button down, motion within 500 ms, queued intents) the
`[busy]` guard refuses `cmd`/`set`/`setfader`/`lua` for every connection with `detail.module = "control"`; motion is
refused `busy` while the hardkeys instance reports another owner. A disconnect, `control=off`, a lease expiry or a
stop ends the connection's gestures through the backend and drops its queued motion. `[control-disabled]` while the
operator has not enabled control; `[no-module]` without the module; `[bad-args]` for malformed arguments.
