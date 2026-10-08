# macOS setup

[README](../../README.md) · [Windows setup](windows.md)

This guide runs onPC and the MCP server on the same Mac. For two computers, also follow
[remote access](../remote-access.md).

## 1. Get and build the server

Install grandMA3 onPC, Git and Node.js with npm. Node.js 22 is used by this project's CI and Docker
image; the package requires Node.js 18 or newer. Launch onPC once to create its resource folders.
Run these commands in Terminal:

```bash
git clone https://github.com/bdstark/GrandMA3MCP.git
cd GrandMA3MCP
npm ci
npm run build
```

Keep using this repository directory for the remaining Terminal commands.

## 2. Copy the bridge files

```bash
npm run install-plugin
```

The installer copies both plugin files into
`~/MALightingTechnology/gma3_library/datapools/plugins/`. If you use a custom library location, copy
`plugin/gma3_mcp_bridge.lua` and `plugin/gma3_mcp_bridge.xml` into its `datapools/plugins/` folder manually.

## 3. Import and start the bridge in onPC

In the **onPC command line**, log in with Admin or Setup rights. Choose a free Plugin pool slot;
this example uses slot 1. Replace `1` if it is occupied.

```text
Import Plugin Library "gma3_mcp_bridge.xml" At Plugin 1
Plugin "gma3_mcp_bridge"
```

Look for `MCP Bridge: listening on 127.0.0.1:9800` in command history or System Monitor.
The target slot is required. Save the show to retain the imported plugin, then start the plugin again
each time you load the show. Arbitrary Lua stays disabled; normal tools work without enabling it.

## 4. Configure your MCP client

For **Claude Code**, generate the repository's `.mcp.json`:

```bash
sh scripts/mcp-config.sh
```

**This replaces the entire `.mcp.json` file.** If you already have other MCP servers configured,
print the configuration instead and merge only the `gma3` entry into the existing `mcpServers` object:

```bash
sh scripts/mcp-config.sh --print
```

For **Claude Desktop**, merge the printed configuration into `claude_desktop_config.json`.
Other MCP clients need a stdio server with command `node` and the absolute path to `dist/index.js`
as its argument. The generated configuration supplies that path. If your client cannot find `node`,
use the absolute executable path reported by `command -v node`.

Reload or restart your MCP client after saving its configuration. Regenerate the path if you move
this checkout. For a custom bridge port, add `--bridge-port 9801` when generating the configuration.

## 5. Check the connection

With onPC and the plugin running:

```bash
node scripts/bridge-cli.mjs ping
```

Then ask your MCP client to call `gma3_status` and list sequences. These are read-only checks.
For updates or connection problems, see the [bridge guide](bridge.md).
