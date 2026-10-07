# gma3-mcp

An [MCP](https://modelcontextprotocol.io) server for **grandMA3 onPC**. It lets an MCP client (Claude Code,
Claude Desktop, etc.) execute command-line commands, run Lua, read show data (sequences, cues, executors,
patch, pools), control playback and faders, and look things up in the grandMA3 manual.

## How it works

grandMA3 has no public network API for reading show data, but its Lua engine ships with LuaSocket and a JSON
library. This project therefore has two parts:

```
MCP client ──stdio──▶ gma3-mcp (Node/TypeScript) ──TCP 127.0.0.1:9800 (JSON lines)──▶ gma3_mcp_bridge.lua
                                                 ──UDP OSC /cmd (fallback, write-only)──▶ grandMA3 onPC
```

1. **`plugin/gma3_mcp_bridge.lua`** runs *inside* onPC as a plugin. It listens on `127.0.0.1:9800` and
   answers JSON requests using the grandMA3 Lua API (`Cmd`, `ObjectList`, `Get`, `Children`, `SetFader`, ...).
2. **`src/`** is the MCP server. Every tool is a thin wrapper over a bridge request. If the bridge is not
   running, `gma3_command` can still fire commands over OSC (no feedback), and `gma3_start_bridge` can start
   the plugin over OSC if OSC input is enabled in onPC.

## Setup

### 1. Build the server

```bash
npm install && npm run build
```

### 2. Install the bridge plugin into grandMA3

```bash
npm run install-plugin
```

This copies `gma3_mcp_bridge.lua` and `gma3_mcp_bridge.xml` to
`~/MALightingTechnology/gma3_library/datapools/plugins/` (macOS; set `GMA3_LIBRARY` on other platforms).

Then, **in the onPC command line** (logged in as a user with Admin or Setup rights; the web remote's
`Remote` user cannot import plugins), import it into a free slot of the Plugin pool and start it:

```
Import Plugin Library "gma3_mcp_bridge.xml" At Plugin 1
Plugin "gma3_mcp_bridge"
```

The `At Plugin <n>` part is required: without a target slot the import reports `Failed` (tested on 2.5.1).
The command line history and System Monitor show `MCP Bridge: listening on 127.0.0.1:9800`, and the same
messages are appended to `gma3_2.5.1/onpc/temp/gma3_mcp_bridge.log`. The plugin keeps running (it yields
every frame, like MA's own webserver example) until you run `Plugin "gma3_mcp_bridge" "stop"`.
`Plugin "gma3_mcp_bridge" "9801"` starts it on another port.

The plugin is stored in the show file, so after the first import you only need `Plugin "gma3_mcp_bridge"`
(for example from a macro) each time the show is loaded. Remember to save the show if you want to keep it.

To update the Lua code after editing it, run `npm run install-plugin` again and re-import:

```
Plugin "gma3_mcp_bridge" "stop"
Delete Plugin 1 /NoConfirmation
Import Plugin Library "gma3_mcp_bridge.xml" At Plugin 1
Plugin "gma3_mcp_bridge"
```

Quick check from a terminal without an MCP client:

```bash
node scripts/bridge-cli.mjs ping
node scripts/bridge-cli.mjs children '{"ref":"DataPool.Sequences","fields":["Name"]}'
```

### 3. Register the server with your MCP client

Claude Code (project scope, already provided in `.mcp.json`):

```bash
claude mcp add gma3 -- node /Users/bstark/Development/GrandMA3/dist/index.js
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "gma3": {
      "command": "node",
      "args": ["/Users/bstark/Development/GrandMA3/dist/index.js"]
    }
  }
}
```

### Alternative: run the server in Docker

If you would rather not install Node on the grandMA3 host, build the image and let the MCP client launch
the container (the bridge plugin still has to be imported into onPC as described above; the files are in
`plugin/`):

```bash
docker build -t gma3-mcp .
```

Claude Desktop / Claude Code configuration:

```json
{
  "mcpServers": {
    "gma3": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "--add-host=host.docker.internal:host-gateway",
               "-v", "/Users/bstark/MALightingTechnology:/gma3:ro", "gma3-mcp"]
    }
  }
}
```

The image defaults `GMA3_BRIDGE_HOST` and `GMA3_OSC_HOST` to `host.docker.internal`. On Docker Desktop
(macOS/Windows) that reaches the plugin even though it binds to `127.0.0.1`. On Linux either run with
`--network host`, or start the plugin on all interfaces with `Plugin "gma3_mcp_bridge" "0.0.0.0:9800"`
(this exposes unauthenticated console control to the network, so only do it on a trusted network).
The volume mount is optional; it only enables `gma3_help`.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `GMA3_BRIDGE_HOST` / `GMA3_BRIDGE_PORT` | `127.0.0.1` / `9800` | Where the Lua bridge listens |
| `GMA3_BRIDGE_TIMEOUT_MS` | `15000` | Per-request timeout |
| `GMA3_OSC_HOST` / `GMA3_OSC_PORT` | `127.0.0.1` / `8000` | OSC fallback target (onPC: Menu > In & Out > OSC) |
| `GMA3_OSC_PREFIX` | *(none)* | OSC prefix configured in onPC, without slashes |
| `GMA3_INSTALL_DIR` / `GMA3_HELP_DIR` | `~/MALightingTechnology` | Where the bundled manual HTML is found |

## Tools

| Tool | What it does |
| --- | --- |
| `gma3_status` | Bridge reachability, software version, show file, user |
| `gma3_command` | Execute a command line command, returns OK / Syntax Error / Illegal Command |
| `gma3_lua` | Evaluate Lua inside onPC and return the result as JSON |
| `gma3_lua_api` | Search the live Lua API descriptor (names, arguments, returns) |
| `gma3_get_object` | Properties (and optionally children and schema) of any object |
| `gma3_list_children` | Children of an object with selected property values, paginated |
| `gma3_objects` | Resolve a range like `Fixture 1 Thru 20` to objects with property values |
| `gma3_dump` | Raw `Dump()` text of an object |
| `gma3_set_property` | `Set()` a property |
| `gma3_playback` | Go+, Go-, Pause, Off, Top, Flash, Load, ... on a sequence or executor |
| `gma3_set_fader` / `gma3_get_fader` | Fader levels via `SetFader` / `GetFader` |
| `gma3_sequences`, `gma3_cues`, `gma3_executors`, `gma3_fixtures`, `gma3_pool` | Convenience views |
| `gma3_help` | Read a page of the grandMA3 manual shipped with onPC |
| `gma3_start_bridge` | Start the plugin over OSC when the bridge is down |

Resource `gma3://cheatsheet` holds a command syntax and object model reference.

Object references accept command syntax (`Sequence 1 Cue 3`, `Page 1.201`), dotted paths from a root
(`DataPool.Sequences`, `Patch.Fixtures`), numeric addresses (`14.14.1.7.1`) and the shortcuts `Root`,
`ShowData`, `ShowSettings`, `DataPool`, `MasterPool`, `SelectedSequence`, `CurrentCue`, `Patch`, `Programmer`,
`Selection`, `CurrentExecPage`. Property names are case-insensitive (`Name`, `TrigType`, `FID`); values come back
as the display text the editor shows, and object references are resolved to the referenced object's name.

Verified against grandMA3 onPC 2.5.1.0 on macOS (its Lua engine reports Lua 5.5).

## Bridge protocol

One JSON document per line over TCP.

```
→ {"id":"1","op":"cmd","args":{"command":"Go+ Sequence 1"}}
← {"id":"1","ok":true,"result":{"command":"Go+ Sequence 1","feedback":"OK"}}
```

Ops: `ping`, `cmd`, `lua`, `object`, `children`, `objects`, `dump`, `set`, `setfader`, `getfader`,
`executor`, `executors`, `api`, `stop`. See `plugin/gma3_mcp_bridge.lua`.

## Safety notes

* Everything the server does happens in the live show. `gma3_set_property`, `Store`, `Delete` and similar
  commands change show data; nothing is written to disk unless `SaveShow` is executed.
* The bridge binds to localhost only. There is no authentication; anything that can reach the port can run
  commands in the console.
* `Cmd()` runs synchronously in the Lua task; a command that opens a blocking dialog can stall the plugin.
  Prefer `/NoConfirmation` options.

## Development

```bash
npm run dev        # run from source with tsx
npm run build      # compile to dist/
```

Help pages, OSC and Lua API details were taken from the manual bundled with onPC 2.5.1
(`~/MALightingTechnology/gma3_2.5.1/shared/language/HTML`).
