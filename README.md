# gma3-mcp

An [MCP](https://modelcontextprotocol.io) server for **grandMA3 onPC**. Connect an MCP client to inspect
show data, program fixtures, store and edit cues, control playback and faders, and search the manual
installed with onPC. Arbitrary Lua execution is available as a separate, opt-in capability.

## Get started

Choose the guide for the computer running grandMA3 onPC and your MCP client:

| Platform | Setup guide |
| --- | --- |
| macOS | [Install and connect on macOS](docs/setup/macos.md) |
| Windows | [Install and connect on Windows](docs/setup/windows.md) |

Both guides cover building the server, copying the plugin, importing it into onPC, configuring your
MCP client (ChatGPT desktop, Claude Code or Claude Desktop), and checking the connection.
Start with the native setup for your platform. For ChatGPT in a browser, see [ChatGPT web](docs/setup/chatgpt-web.md).

Running the MCP client on a different computer? See [remote access over SSH](docs/remote-access.md).
For container deployment, see [Docker](docs/docker.md).

The documented live verification baseline is **grandMA3 onPC 2.5.1.0 on macOS**. Windows instructions
are provided, but this does not establish equivalent live validation on Windows or other onPC versions.

## What you can do

| Area | Capabilities |
| --- | --- |
| Show inspection | Sequences, cues, executors, fixtures, pools, object properties and children |
| Fixture programming | Select fixtures, set attributes, RGB color and position, clear the programmer |
| Cue workflows | Create, merge, overwrite, label, time, trigger, go to and delete cues and parts |
| Playback | Sequence and executor actions, faders, executor assignment and labeling |
| Structured inspection | Fixture attributes, programmer values, fixture output, DMX and supported cue contents |
| Reference | Local grandMA3 manual, live Lua API descriptions and the `gma3://cheatsheet` resource |
| Advanced control | Command-line commands and optional Lua execution |

See the [complete tool and configuration reference](docs/reference.md). Workflow tools report command
outcomes and read-back verification separately; an uncertain outcome requires inspecting console state
before trying the command again. Some console data is unavailable through the API and is reported as a
limitation, rather than invented or returned as a misleading zero.

## How it works

```text
MCP client → stdio → Node.js MCP server → local TCP bridge → grandMA3 onPC
```

The [Lua bridge plugin](plugin/gma3_mcp_bridge.lua) runs inside onPC and listens on `127.0.0.1:9800`.
The [MCP server](src/index.ts) translates tool calls into bridge requests. Both parts are required for
show inspection and workflow tools. The plugin also carries two instance-based
[console interaction modules](docs/modules.md) (input lifecycle, read-only feedback) as extra components
of the same XML; they expose no input operation yet.

`gma3_command` also supports write-only OSC when OSC input is configured in onPC. Automatic fallback
happens only if the bridge cannot be reached before dispatch; a command with an uncertain result is
never automatically replayed. `gma3_start_bridge` can start an already-imported plugin over OSC.
OSC is optional for the normal bridge setup and is not forwarded by an SSH tunnel.

## Before using it in a show

- Tools operate on the live show and can change the programmer, playback and stored show data. Start
  with a disposable show and read-only queries. Save your show when you want show changes to persist;
  commands and enabled Lua can also perform file operations.
- The bridge has no authentication. It accepts loopback connections only, so local applications can
  access it. Use the documented SSH setup for remote access.
- Arbitrary Lua is disabled on the bridge by default. Its execution budget is best effort and is not
  a sandbox or a cancellation guarantee. Read [Lua execution and hook policy](docs/lua.md) before enabling it.
- Commands that open a blocking dialog can stall the plugin. Use `/NoConfirmation` where appropriate.

## Documentation

- [Bridge import, startup, updates and troubleshooting](docs/setup/bridge.md)
- [Configuration, tools, workflow results and bridge protocol](docs/reference.md)
- Workflow details: [fixtures](docs/tools/fixtures.md), [cues](docs/tools/cues.md),
  [executors](docs/tools/executors.md), [inspection](docs/tools/inspection.md)
- [Optional Lua execution](docs/lua.md)
- [Remote access over SSH](docs/remote-access.md) and [Docker](docs/docker.md)
- [Development and automated tests](docs/development.md), [live test procedure](test/live/README.md)

## License

[MIT](LICENSE)

grandMA3 and MA Lighting are trademarks of MA Lighting Technology GmbH. This project is independent and is
not affiliated with, endorsed by, or supported by MA Lighting. No MA Lighting documentation, code, or
libraries are redistributed here: the help tool reads the manual from your own onPC installation at runtime,
and the bridge plugin uses the LuaSocket and JSON libraries already shipped inside onPC.
