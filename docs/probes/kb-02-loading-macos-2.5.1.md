# KB-02 module loading evidence — macOS, onPC 2.5.1.0

Date: 2026-10-09. Status: **complete for macOS**: import, update, ReloadAllPlugins, stop/start, two-consumer
isolation, live module behaviour, save/reload and reload without loose files all verified. Windows and a
physically separate machine were not exercised.

## Environment

| Item | Value |
| --- | --- |
| onPC | 2.5.1.0 Release, hostType onPC, Lua 5.5 |
| OS | macOS (Darwin 25.5.0) |
| User / profile | Admin / UserProfile "Default" |
| Show | `mcp-test-disposable` |
| Bridge | gma3_mcp_bridge 0.3.4 → 0.4.0, Lua enabled, luahook=preserve |
| Probe channel | `lua` op through the bridge, `Cmd()` for console commands; desktop control (declined at first, granted later) for the save/load steps |
| Library folder | `~/MALightingTechnology/gma3_library/datapools/plugins` (also on `package.path`) |

## Method

A throwaway two-component plugin `kb02_probe` (entry `kb02_probe.lua`, module `kb02_probe_mod.lua`)
was imported into Plugin slot 2 in three versions, plus a reversed-order copy (`kb02_probe_b`, slot 3),
a renamed copy (`kb02_probe_c`, slot 3) and a consumer plugin `kb02_consumer` (slot 4) that vendors
the real modules. Chunks recorded their arguments into a global table that was read back afterwards.
`scripts/kb02-probe.mjs probe` reproduces the automated part.

## Results

| # | Check | Result |
| --- | --- | --- |
| 1 | `package.path` | library `datapools/plugins/?.lua` and resource `lib_plugins` only; no cpath |
| 2 | `package.loaded` | one shared cache (socket/json from the bridge visible to other plugins) |
| 3 | Component storage | `FullPath = <Showfile>`, `InStream = true`, `FileExists = false`; source is in the show |
| 4 | Import | runs **every** component chunk, XML order, 4 args `(pluginName, componentName, signalTable, handle)`; `handle` prints `<invalid>` during the chunk, valid in Main |
| 5 | `Plugin "x"` | calls the first component's returned function only; reversed order (table first) runs nothing |
| 6 | `require("kb02_probe_mod")` | resolved the **loose file on disk**; after the loose file was removed and the cache evicted: `module not found` |
| 7 | Delete + re-import (no ReloadAllPlugins) | new entry code ran (v2), but `require` still returned the **stale v1** cached table |
| 8 | `Get("FileContent")` | 1016 chars for a 103717-byte component (all roles, all accessor spellings); `FileSize` reports 101 (KB) |
| 9 | `Export(plugin)`, `Export(component)` | returned `false`, no file written |
| 10 | `signalTable` | same table for both components of one plugin; different tables for slots 2 and 3; a module registered there was found by its own plugin's Main with distinct module tables per plugin |
| 11 | ReloadAllPlugins (via macro) | idle show-embedded probe chunks were **not** re-run, `_G` and the bridge state table survived (request counter continued 2976 → 2977) |
| 12 | Bridge update by macro | stop → Delete Plugin 1 → Import → ReloadAllPlugins → `Plugin "gma3_mcp_bridge" "lua"` restarted the bridge as 0.4.0 within ~6 s |
| 13 | Modules at start | `ping.modules` and the `modules` op report hardkeys 0.1.0 and feedback 0.1.0, state `ready`, serviced per frame |
| 14 | Feedback readers live | commandText, lastCommand, blind, highlight, solo, previewMode, previewBar, shortcutsActive, maState, page, executorActive(1) all available; freeze unavailable with reason |
| 15 | Key resolution live | PLEASE→Enter, STORE→S, ESC→Escape, CLEAR→Delete, OOPS→Backspace, NUM5→5, EXEC 101→Ctrl+F1, MA→LeftShift; MA1 and EXEC 999 unsupported with reasons |
| 16 | Second consumer | `kb02_consumer` found both modules in its own signal table, got **different module tables** and instance metatables, read `blind`, resolved PLEASE; a hold recorded on its instance was invisible to the bridge's instance |
| 17 | Stop/start (macro) | bridge back in ~1.5 s with new instances (serviced counter restarted); the consumer's instance stayed `ready` with its own hold |
| 18 | Cleanup | probe plugins (slots 2–4) and macros 100/101 deleted; loose probe files removed |
| 19 | Save | `SaveShow /NoConfirmation` through the bridge opened a *Change show file name to 'NoConfirmation'?* dialog and stalled the plugin thread (bridge silent ~2 min); cancelled on the desktop, then saved from the Backup window; the bridge resumed by itself |
| 20 | Reload without loose files | bridge stopped, all four `gma3_mcp_*` files deleted from `datapools/plugins`, `LoadShow "mcp-test-disposable"`, `Plugin "gma3_mcp_bridge" "lua"` typed via the Edit Command dialog: `verify` passed (both modules 0.1.0 ready, no loose files, readers live) |
| 21 | Fresh load proven | a marker set on the loaded module's instance metatable before a second LoadShow was gone afterwards; new metatable and new bridge handler function, so the chunks re-ran from the show and nothing was reused |
| 22 | Lua state across LoadShow | `_G` and the bridge state table **survive LoadShow** (request counter continued 3025 → 3031) while every plugin chunk re-runs; the bridge's `_G.__gma3_mcp_bridge` guard matters for show loads too |

Observation: Blind was already on in the disposable show during these reads; it was reported, not changed.

## Operator notes

- The `.show` file is MA's own binary container (`GMA3` header, not zlib), so the embedded source cannot
  be checked offline; rows 20–21 are the proof.
- Do not issue `SaveShow` or `LoadShow` through the bridge: `SaveShow` takes the next token as a file name
  and asks on the plugin thread, which stalls the bridge until the dialog is answered in onPC; `LoadShow`
  stops the bridge and it must be started again by the operator.
- Synthetic typing into the onPC command line was ignored; the Edit Command dialog (keyboard icon left of
  the command line) accepts it and executes on **Please**. (The onPC window changed monitor during the
  session because a docking station was connected, not because of `LoadShow`.)
- Procedure to repeat on another machine: copy only the saved show, load it, `Plugin "gma3_mcp_bridge" "lua"`,
  `node scripts/kb02-probe.mjs verify`. Windows was not exercised.
