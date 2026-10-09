# Console interaction modules

[README](../README.md) · [KEYBOARD.md](../KEYBOARD.md) · [bridge setup](setup/bridge.md)

The bridge plugin ships two reusable, instance-based Lua modules as extra components of
`gma3_mcp_bridge.xml`:

| Component | File | Purpose |
| --- | --- | --- |
| `gma3_mcp_hardkeys` | [plugin/gma3_mcp_hardkeys.lua](../plugin/gma3_mcp_hardkeys.lua) | Input lifecycle, backend adapter registry and read-only logical-key resolution |
| `gma3_mcp_feedback` | [plugin/gma3_mcp_feedback.lua](../plugin/gma3_mcp_feedback.lua) | Read-only console state readers confirmed in KB-01 |

Module API version **1**, module version **0.1.0** (KB-02). This version exposes **no input operation**:
nothing in either module presses, holds or releases a key. Owned input sessions and the shortcut
backend are KB-03/KB-04.

## Loading contract (what the console does and does not do)

Live probes on onPC 2.5.1.0 ([record](probes/kb-02-loading-macos-2.5.1.md)) established:

- `Import Plugin Library` stores every `ComponentLua` source **inside the show file**
  (`FullPath = <Showfile>`) and runs each component chunk once, in XML order, with the arguments
  `(pluginName, componentName, signalTable, handle)`. The same happens when the show is loaded.
- `Plugin "<name>"` calls the function returned by the **first** component only. A plugin whose first
  component returns a table runs nothing, silently. Other components' return values are discarded.
- `signalTable` is **one table per plugin instance, shared by all of its components**. Two plugins
  that ship the same component get two different tables.
- `require("name")` searches only loose files under the library folder (`datapools/plugins/?.lua`
  and the resource `lib_plugins`), never the show-embedded copy; `package.loaded` is **one cache for
  every plugin in the console** and keeps a stale module across delete/re-import. On a console
  without the loose file, `require` fails.
- `Get("FileContent")` on a component is **capped at about 1 KB**, so a loader that reads a sibling
  component's source cannot carry a real module. `Export(handle, name)` returned false for plugins
  and components.
- The component handle is invalid while the chunk runs and valid once `Main` is called, and
  `ReloadAllPlugins` did not re-run the chunks of idle, show-embedded plugins (global state and the
  bridge's state table survived it). `LoadShow` re-runs every chunk from the show file but keeps the Lua
  state and `_G`; after the loose files were deleted, a reload still produced fresh module copies.

So the modules use the signal table: each module chunk registers its read-only module table in
`signalTable.__gma3_mcp_modules[<module NAME>]` when the console runs it, and the plugin's entry
component looks it up when it starts. The registration is a plain Lua table write; it allocates no
show object, socket or timer and sends no input.

```lua
-- in the entry component's Main, after the console has run every component chunk
local pluginName, componentName, signalTable, my_handle = ...
local reg = rawget(signalTable, "__gma3_mcp_modules") or {}
local HK, FB = reg.gma3_mcp_hardkeys, reg.gma3_mcp_feedback
if not (HK and HK.API_VERSION == 1) then error("gma3_mcp_hardkeys is not registered; import the plugin with all components") end
local hardkeys = HK.new({ owner = pluginName, deps = HK.consoleDeps(_G) }):init()
local feedback = FB.new({ owner = pluginName, deps = FB.consoleDeps(_G) }):init()
-- every loop iteration:    hardkeys:service(now); feedback:service(now)
-- on stop/Cleanup:          hardkeys:dispose();    feedback:dispose()
```

The bridge's own loader is `loadModule` in [plugin/gma3_mcp_bridge.lua](../plugin/gma3_mcp_bridge.lua);
it validates `API_VERSION`, reports a missing or broken component through the `modules` op and
`ping.modules`, and still starts the bridge.

## Rules for consumers

- One instance per consumer, created with `new({ owner = "<your plugin>", deps = ... })`. Instances
  hold their own ownership records and counters; the module tables are read-only (a write raises an
  error) so no mutable state can be parked on them.
- Never publish a module through `package.loaded`, `require` or a global. The registry key is scoped to
  the plugin's signal table; a second plugin vendoring the same files gets its own copies (verified
  live with a separate `kb02_consumer` plugin next to the bridge).
- Pass console functions through `opts.deps`. `consoleDeps(_G)` builds lazy closures and calls nothing;
  the modules never touch globals, so they run and are tested under stock Lua.
- Keep the entry component first in the XML and do your lookups in `Main`, not at chunk level.

## Instance API (both modules)

| Method | Effect |
| --- | --- |
| `init()` | `created → ready`. Touches no console state. |
| `status()` | Read-only report: module, version, apiVersion, owner, state, counters. |
| `service(now)` | Per-iteration hook; errors before `init()`; returns `{ released = {} }` (hardkeys). |
| `dispose()` | `→ disposed`, idempotent; later calls other than `status()`/`dispose()` raise. |

`gma3_mcp_hardkeys` additionally offers `describeKey(name, opts)` (resolves `PLEASE`, `STORE`, `ESC`,
`CLEAR`, `OOPS`, `NUM0`–`NUM9`, `EXEC` with `opts.executor`, and `MA`; `MA1`/`MA2` are reported
unsupported) and `backendAvailable()`. The pure functions `resolve(rows, vkCodes, name, opts)` and
`parseShortcut(text)` are exported for tests. Resolution prefers the row with the fewest modifiers,
never substitutes another key, and reports `shortcutsActive`.

`gma3_mcp_feedback` offers `read(name, params)` and `readAll()`. Readers: `commandText`, `lastCommand`,
`blind`, `highlight`, `solo`, `previewMode`, `previewBar`, `shortcutsActive`, `maState`, `page`,
`executorActive` (`params.sequence`) and `freeze` (always `available = false` with a reason). A reader
that throws reports `available = false` and the error; no default value is ever substituted.

## Vendoring into another plugin (mtpnxk)

1. Copy `plugin/gma3_mcp_hardkeys.lua` and `plugin/gma3_mcp_feedback.lua` unchanged, with
   [LICENSE](../LICENSE) (MIT). Record the module version and the commit you copied from.
2. Add both as `ComponentLua` entries after your entry component in your plugin XML, and copy the
   `.lua` files next to the XML for import. After import the show carries them.
3. Look them up as shown above. Do not fork console semantics: changes to key resolution or readers go
   into this repository and are re-vendored.
4. Check `API_VERSION`; a bridge or consumer refuses a module with another API version.

## Verification

`npm test` runs [test/lua/modules_test.lua](../test/lua/modules_test.lua) (modules alone, no console
API) and the bridge harness (registry lookup, failure reporting, dispose on stop and on bind failure).
`node scripts/kb02-probe.mjs verify` checks a live bridge: `ping.modules`, the `modules` op, and that the
readers and key resolution return successful values (Blind readable, PLEASE resolved, Freeze and MA1
reported unavailable/unsupported). It lists loose module files in the local library folder for information
only; that proves nothing about a remote console. Portability is shown by loading the show on a console that
never had the loose files and running `verify` there. `node scripts/kb02-probe.mjs probe` reproduces
the loader experiments with a throwaway plugin.
