# Bridge operation and troubleshooting

[README](../../README.md) · [macOS setup](macos.md) · [Windows setup](windows.md)

## Import and start the bridge in onPC

In the **onPC command line**, log in with Admin or Setup rights. Choose a free Plugin pool slot;
this example uses slot 1. Replace `1` if it is occupied.

```text
Import Plugin Library "gma3_mcp_bridge.xml" At Plugin 1
Plugin "gma3_mcp_bridge"
```

Look for `MCP Bridge: listening on 127.0.0.1:9800` in command history or System Monitor, preceded by
`MCP Bridge: modules: hardkeys 0.4.0, feedback 0.2.0` (the [console interaction modules](../modules.md)
shipped as extra components of the same XML; a `FAILED` entry there means the XML was imported without
all of its components).
The target slot is required. Save the show to retain the imported plugin, then start the plugin again
each time you load the show. Arbitrary Lua stays disabled; normal tools work without enabling it.

## Stop, inspect or change the port

Run these in the onPC command line:

```text
Plugin "gma3_mcp_bridge" "status"
Plugin "gma3_mcp_bridge" "stop"
Plugin "gma3_mcp_bridge" "9801"
```

The last command starts a stopped bridge on port 9801. Set `GMA3_BRIDGE_PORT` in the MCP configuration
to match. The bridge always binds to `127.0.0.1`; a host address is not an accepted argument.
Other control arguments configure [optional Lua execution](../lua.md) and, since v0.5.0, owned input
sessions (off by default and reset at every start):

```text
Plugin "gma3_mcp_bridge" "input=keyboard"
Plugin "gma3_mcp_bridge" "input=fake"
Plugin "gma3_mcp_bridge" "input=off"
Plugin "gma3_mcp_bridge" "input status"
Plugin "gma3_mcp_bridge" "input recover"
```

`input=keyboard` (v0.6.0, KB-04) admits the `input.*` bridge ops on the console keyboard backend: **console
keys are really pressed** through `Keyboard()`, routed through the current user profile's keyboard shortcuts
(or the native MA/PLEASE routes), so use it on a show you are prepared to have operated. `input=fake` admits
them on the fake backend (events are recorded, nothing reaches a console key). `input=off` stops admitting
input and attempts to release every held key. `input status` prints sessions, holds and unresolved releases;
`input recover` is the operator's recovery action: it re-attempts every unresolved release, including records
kept from a previous run, attaching the records' own backend for cleanup only when none is attached (input
stays disabled). A switch between backends is refused while held or unresolved records exist. `status`,
`input status` and other control arguments never release keys of the running bridge. If a held shortcut was
remapped or shortcuts were disabled (F10) during the hold, restore the mapping or enablement on the console
first, then run `input recover`: the bridge never changes mappings or toggles F10, and while such a mismatch
is pending it refuses every new press, including an injected F10. See
[docs/reference.md](../reference.md#owned-input-sessions-plugin-v050-kb-03).

Since v0.9.0 (KB-12) the operator can provision the **Quickey bank** the Quickey dispatch of KB-13 will use. This is the
only path that creates or deletes show objects, and it is a plugin argument, never a client request:

```text
Plugin "gma3_mcp_bridge" "bank=900/1.190-197"
Plugin "gma3_mcp_bridge" "bank=900/1.190 bankcodes=qualified"
Plugin "gma3_mcp_bridge" "bank status"
Plugin "gma3_mcp_bridge" "bank verify"
Plugin "gma3_mcp_bridge" "bank teardown"
```

`bank=<quickey>/<page>.<first>[-<last>]` creates one Quickey per command-area hardkey code from the given pool index
upwards (named `MCP <CODE>`, with an ownership marker in the Note) and reserves the executor range for holds (the range
must cover the hold capacity of 8; without `-<last>` it reserves 8). Every slot and executor is checked before anything
is written: an unowned object in the range, another plugin's bank or an occupied executor refuses the whole setup and
nothing is created. A bank of this bridge with the same ranges is verified and reused. `bank status` prints the codes
(qualified by the KB-10 evidence, or discovered only), problems and exclusions; `bank verify` re-reads every object;
`bank teardown` deletes only Quickeys that still verify as the bridge's and clears only executors holding one of them,
and is refused while a Quickey hold or unresolved record exists. The bank record survives a restart like the unresolved
records and is re-verified at the next start. Use a show you are prepared to have objects created in.

Since v0.7.0 (KB-05) the MCP server exposes input through the [structured input tools](../tools/input.md). While
any client owns console input (an interaction, a running sequence or a held key), the bridge refuses commands,
property changes, faders and Lua from **every** client with `[busy]`; `input status` prints the open interactions,
the running sequence and the busy owner. `input=off` ends every interaction and aborts a running sequence before
releasing the held keys.

The plugin logs to `gma3_<version>/onpc/temp/gma3_mcp_bridge.log` under the onPC resource folder.

## Update an existing plugin

1. Copy the updated `.lua` files (bridge, hardkeys, feedback) and the `.xml` using your platform setup guide.
2. Confirm the pool slot that contains **this bridge**. The example below uses slot 1; change both
   occurrences if your bridge is in another slot. Do not delete a slot containing another plugin.
3. Run these commands in onPC:

```text
Plugin "gma3_mcp_bridge" "stop"
Delete Plugin 1 /NoConfirmation
Import Plugin Library "gma3_mcp_bridge.xml" At Plugin 1
ReloadAllPlugins
Plugin "gma3_mcp_bridge"
```

`ReloadAllPlugins` reloads all plugins, so choose a suitable time to run it. On onPC 2.5.1, deleting
and re-importing alone can leave the cached Lua code running. The whole sequence can also be stored as
a Macro (one command per line, a 1–2 s Wait after each) and run with `Go+ Macro <n>`; this restarts the
bridge without typing while it is stopped, which is how the KB-02 update was verified. Check the version in the new startup
message, then save the show if you want to retain the update. Reapply any custom port, Lua or input policy
in your start command; those settings do not carry over from the previous run (only unresolved input
release records do, so `input recover` can act on them).

After updating server source, also run `npm ci` and `npm run build` (`npm.cmd` in PowerShell), then
restart the MCP client to load the new server code.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Import reports `Failed` | Both files are in the library's `datapools/plugins/` folder; use an explicit free target slot and an Admin or Setup user. The web remote's `Remote` user cannot import. |
| Bridge cannot be reached | Start the plugin, check its startup message, and match the MCP port to the plugin port. For remote use, check the SSH tunnel too. |
| Old behavior after an update | Re-import and run `ReloadAllPlugins`; confirm the startup version. |
| `modules: ... FAILED` at start | The XML was imported without its module components, or a component has a syntax error. Copy all plugin files, delete the slot and re-import. `node scripts/bridge-cli.mjs modules` shows the error. |
| Bridge stops answering after `SaveShow` or another dialog | A confirmation pop-up on the plugin thread stalls the bridge until it is dismissed in onPC (`SaveShow /NoConfirmation` asks to rename the show to "NoConfirmation"). Save and load shows from the console, not through the bridge. |
| Tools do not appear | Build `dist/index.js`, check its absolute path and the `node` executable in the client configuration, then restart the client. |
| Manual pages unavailable | Point `GMA3_INSTALL_DIR` at the resource folder, or `GMA3_HELP_DIR` at the manual's exact HTML directory. See the [configuration reference](../reference.md#environment-variables). |
| Lua tool is present but refuses execution | Lua is disabled on the console by default. See [Lua policy](../lua.md). |
| A command timed out | Inspect console state before resending: it may already have executed. A timeout is not cancellation. |

For local connections, `node scripts/bridge-cli.mjs ping` is a read-only connection check independent
of your MCP client. The CLI reads environment variables from its shell, not from `.mcp.json`.
