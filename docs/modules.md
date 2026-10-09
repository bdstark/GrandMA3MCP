# Console interaction modules

[README](../README.md) · [KEYBOARD.md](../KEYBOARD.md) · [bridge setup](setup/bridge.md)

The bridge plugin ships two reusable, instance-based Lua modules as extra components of
`gma3_mcp_bridge.xml`:

| Component | File | Purpose |
| --- | --- | --- |
| `gma3_mcp_hardkeys` | [plugin/gma3_mcp_hardkeys.lua](../plugin/gma3_mcp_hardkeys.lua) | Owned input sessions, leases, deadline servicing and recovery over a backend adapter; read-only logical-key resolution |
| `gma3_mcp_feedback` | [plugin/gma3_mcp_feedback.lua](../plugin/gma3_mcp_feedback.lua) | Read-only console state readers confirmed in KB-01 |

Module API version **1**; `gma3_mcp_hardkeys` **0.2.0** (KB-03), `gma3_mcp_feedback` **0.1.0** (KB-02).
The only backend adapter that dispatches anything in this version is the **fake backend**: it records
events and simulates aggregate console key state, and nothing reaches a console key. The `keyboard`
adapter is still capability-only; a press on it is refused before dispatch until KB-04 proves it.

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
| `status(now?)` | Read-only report: module, version, apiVersion, owner, state, counters. Performs no cleanup and calls nothing on the backend. |
| `service(now)` | Per-iteration hook; errors before `init()`. `now` is seconds (a number); the consumer supplies the clock. |
| `dispose(now?)` | `→ disposed`, idempotent; later calls other than `status()`/`dispose()` raise. |

`gma3_mcp_hardkeys` additionally offers `describeKey(name, opts)` (resolves `PLEASE`, `STORE`, `ESC`,
`CLEAR`, `OOPS`, `NUM0`–`NUM9`, `EXEC` with `opts.executor`, and `MA`; `MA1`/`MA2` are reported
unsupported; the result carries `shortcutsActive` and the current `profile` name) and `backendAvailable()`.
The pure functions `resolve(rows, vkCodes, name, opts)`, `parseShortcut(text)` and `tupleKey(t)` are
exported for tests. Resolution prefers the row with the fewest modifiers and never substitutes another key.

## Owned input sessions (`gma3_mcp_hardkeys` 0.2.0, KB-03)

Every call that can change state takes `now` (seconds, number) from the consumer; the module never
reads a clock and never sleeps. Calls that fail return `nil, { code, message, ... }`; nothing is
dispatched when an error is returned. Programming errors (wrong state, missing clock) raise.

| Method | Effect |
| --- | --- |
| `enableInput(adapter)` | Operator decision: attach a dispatching backend adapter and admit presses. Refused for an adapter without dispatch (`keyboard` in this version) and refused while ownership records exist and the adapter would change. |
| `disableInput(now, reason)` | Stop admitting presses and attempt to release every held key. Failures stay as unresolved records; releases and `recover()` keep working while disabled. |
| `openSession({ id, leaseMs, label, binding }, now)` | Open a session under a consumer-chosen id (the bridge uses the connection id). Refused while the id is open or still owns unresolved holds. |
| `renewSession(id, now, leaseMs)` | Move the lease deadline; reactivates an expired session. A lease that ran out before `service()` noticed is expired first, so its holds keep their cleanup deadline. Never injects a press. |
| `closeSession(id, now, reason)` | Attempt to release the session's holds, newest first; report each outcome. A session with unresolved holds stays visible as `closed` until `recover()` clears them. |
| `press(session, now, spec)` | Admission compares `now` with the lease expiry itself (an overdue lease is `lease-expired` even if `service()` has not run). `spec = { key = "PLEASE" }` (logical, modifiers come from the mapping) or `{ pcKey = "Enter", shift, ctrl, alt, numlock }` (raw), plus optional `display` (validated to exist, never a routing promise), `executor` (for `EXEC`) and `maxHoldMs`. |
| `tap(session, now, spec, holdMs)` | `press()` plus a release deadline (≤ `maxTapMs`) that `service()` honours. Cannot be layered on a hold. |
| `release(session, now, { hold = id } \| spec)` | Release with the **stored** tuple. Releasing an already released hold is harmless; another session's hold is `not-owner`. |
| `releaseAll(session, now)` | Owner-scoped, newest first. |
| `recover(session \| nil, now)` | Re-attempt the release of unresolved holds; `nil` covers every session (the consumer decides who may call it that way). |
| `adopt(records, now)` | Import the records a previous instance's `dispose()` returned, as unresolved holds of a closed `previous-run` session. Their tuples are reserved from then on (`conflict` for anyone else); releasing them is a separate `recover()`. Dispatches nothing. |
| `service(now)` | Expire leases, release due taps/max-hold/expired-lease holds (at most `maxWorkPerService` attempts per call, the rest next call), snapshot the backend's aggregate key state. Returns `{ released, unresolved, expired, work, pending }`. |

**Ownership records.** A hold stores the resolved PC key, the shift/ctrl/alt/numlock flags, the
display argument, the logical key and the route it was resolved by (shortcut text, row index,
executor, user profile name, shortcut enablement). The ownership identity is the *tuple* of PC key
plus modifier flags: display is not part of it (input is not display-scoped on 2.5.1), and neither is
the logical name, so `MA` and a raw `LeftShift`, or the same key on two displays, are one tuple. A
second press of a held tuple by its owner is a harmless duplicate (nothing injected); by another
session it is a `conflict`. Capacity (`maxHolds`, default 8) counts held and unresolved records.

**Release outcomes.** Release always uses the stored tuple; nothing is ever re-resolved for cleanup.
Before each release the route is rechecked: a remap, a disabled shortcut table or a profile switch
during a hold marks the hold with `routeMismatch`, stops new interaction events for every session
(`route-changed`, reporting the original route and the mismatch) and makes an unconfirmable release
**unresolved** instead of released, because a call that returns without error is not evidence that
the key came up after the route changed (KB-01 macOS probes). A release the adapter refuses or that
raises is unresolved too. Unresolved records are kept, keep blocking their tuple, are not retried by
`service()`, and are cleared only by a successful `recover()`. The operator may restore the original
route; the module never restores mappings or toggles shortcuts itself.

**Shared console state.** `service()` records what the backend observes (`observed`, aggregate, "not
ownership"). A hold whose tuple the console no longer reports down is annotated
(`observed.down = false`, `observedReleasedAt`) and stays owned; the module never re-presses to
compensate. The owner's eventual release is still dispatched (harmless) and resolves the record.

**Adapter contract** (what KB-04's console adapter must implement; `fakeBackend()` implements it):
`press(tuple) -> ok, confirmed, err` where `ok=false` means refused *before* anything was dispatched
(an adapter that cannot tell must raise, which keeps the record as unresolved); `release(tuple) -> ok,
confirmed, err` where `confirmed` is `true`, `false` or `nil` (not observable); optional `observe() ->
{ available, down = { [tupleKey] = true } }` and `supportsKey(pcKey) -> boolean, reason`. The fake
adapter adds test controls: `failNext(op, tuple, err, sticky)`, `clearFailures()`, `setConfirmMode(mode)`,
`physicalPress/physicalRelease(tuple)`, `isDown(tuple)`, `events`, `counters`.

**Limits of recovery.** Deadlines are serviced only while the plugin loop runs. A host call that
blocks the plugin thread, a plugin crash or process termination prevents release; lease expiry is a
cleanup *attempt*, not a guaranteed cancellation of a held key or of a blocked host call.

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
API), [test/lua/hardkeys_sessions_test.lua](../test/lua/hardkeys_sessions_test.lua) (the KB-03 session
lifecycle on the fake backend: ownership, aliases, leases, taps, bounded deadline servicing, route
changes, failed releases, disconnect, disable, dispose/adopt) and the bridge harness (registry lookup,
failure reporting, connection-bound `input.*` ops, control invocations that never release, cleanup on
disconnect/stop, kept records across a restart, a flooding client that cannot starve deadline servicing).
`node scripts/kb03-probe.mjs run` exercises the lifecycle against a live bridge started with `input=fake`
over real TCP connections ([record](probes/kb-03-fake-macos-2.5.1.md)).
`node scripts/kb02-probe.mjs verify` checks a live bridge: `ping.modules`, the `modules` op, and that the
readers and key resolution return successful values (Blind readable, PLEASE resolved, Freeze and MA1
reported unavailable/unsupported). It lists loose module files in the local library folder for information
only; that proves nothing about a remote console. Portability is shown by loading the show on a console that
never had the loose files and running `verify` there. `node scripts/kb02-probe.mjs probe` reproduces
the loader experiments with a throwaway plugin.
