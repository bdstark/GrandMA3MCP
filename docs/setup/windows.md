# Windows setup

[README](../../README.md) · [macOS setup](macos.md)

This guide runs onPC and the MCP server on the same Windows computer. For two computers, also follow
[remote access](../remote-access.md). Commands below use **PowerShell**.

## 1. Get and build the server

Install grandMA3 onPC, Git and Node.js with npm. Node.js 22 is used by this project's CI and Docker
image; the package requires Node.js 18 or newer. Launch onPC once to create its resource folders.

```powershell
git clone https://github.com/bdstark/GrandMA3MCP.git
Set-Location GrandMA3MCP
npm.cmd ci
npm.cmd run build
```

Keep using this repository directory for the remaining PowerShell commands. The `.cmd` spelling
avoids invoking npm's PowerShell wrapper on systems that restrict script execution.

## 2. Copy the bridge files

The default Windows resource folder is `C:\ProgramData\MALightingTechnology` (see
[MA's folder structure documentation](https://help2.malighting.com/grandMA3/2.4/HTML/fm_folder_structure.html)).
If your installation uses another location, change `$gma3Base` first.

```powershell
$gma3Base = Join-Path $env:ProgramData 'MALightingTechnology'
$gma3Library = Join-Path $gma3Base 'gma3_library'
if (-not (Test-Path $gma3Library)) {
    throw "Library not found: $gma3Library. Launch onPC or set the correct resource path."
}
$pluginDirectory = Join-Path $gma3Library 'datapools\plugins'
New-Item -ItemType Directory -Force -Path $pluginDirectory | Out-Null
Copy-Item .\plugin\gma3_mcp_bridge.lua, .\plugin\gma3_mcp_bridge.xml -Destination $pluginDirectory -Force
```

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

Choose [ChatGPT desktop](#chatgpt-desktop), [ChatGPT web](chatgpt-web.md), or
[Claude Code / Claude Desktop](#claude-code-and-claude-desktop).

### ChatGPT desktop

Use the local desktop app on this Windows computer. From the repository directory, get the
executable and server paths in PowerShell:

```powershell
(Get-Command node.exe).Source
(Resolve-Path .\dist\index.js).Path
```

In ChatGPT, open **Settings → MCP servers → Add server** and select **STDIO**. Enter:

| Field | Value |
| --- | --- |
| Name | `gma3` |
| Command | The absolute `node.exe` path printed above |
| Arguments | The absolute `dist\index.js` path printed above, as one argument |
| Environment | `GMA3_INSTALL_DIR=C:\ProgramData\MALightingTechnology` (use your actual resource folder) |
| Environment (optional) | `GMA3_BRIDGE_PORT=9801` if you started the bridge on port 9801 |

Save, select **Restart**, and use `/mcp` in the composer to check the connection.
See [OpenAI's desktop MCP instructions](https://learn.chatgpt.com/docs/extend/mcp).

For file-based configuration, merge this entry into `%USERPROFILE%\.codex\config.toml`, replacing
the example paths. If a `gma3` entry already exists, edit it rather than adding a duplicate:

```toml
[mcp_servers.gma3]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\Users\yourname\GrandMA3MCP\dist\index.js']

[mcp_servers.gma3.env]
GMA3_INSTALL_DIR = 'C:\ProgramData\MALightingTechnology'
```

Single-quoted TOML strings preserve Windows backslashes. In the desktop form, enter paths without
surrounding quotes; keep the complete server path in one argument, including any spaces.
Run this setup natively on Windows so the default loopback address reaches onPC.

The desktop app shares this configuration with Codex clients on the same host. The repository's
`.mcp.json` generator is for Claude; skip it for this setup. Update the absolute paths if you move
the checkout or Node.js installation. Continue to [check the connection](#5-check-the-connection).
For a browser-based ChatGPT session, follow the separate [ChatGPT web guide](chatgpt-web.md).

### Claude Code and Claude Desktop

For **Claude Code**, generate the repository's `.mcp.json`:

```powershell
.\scripts\mcp-config.ps1
```

**This replaces the entire `.mcp.json` file.** If you already have other MCP servers configured,
print the configuration instead and merge only the `gma3` entry into the existing `mcpServers` object:

```powershell
.\scripts\mcp-config.ps1 -Print
```

If PowerShell blocks the script, review it and follow your computer's script-execution policy, or
create the configuration manually using the example below with your actual checkout path.
For **Claude Desktop**, merge the printed configuration into `claude_desktop_config.json`.
Other MCP clients need a stdio server with command `node` and the absolute path to `dist\index.js`
as its argument.

Add `GMA3_INSTALL_DIR` to the `gma3` server's `env` object so the help tool can find your manual.
Preserve any existing environment entries, such as a custom bridge port. A complete example is:

```json
{
  "mcpServers": {
    "gma3": {
      "command": "node",
      "args": ["C:\\path\\to\\GrandMA3MCP\\dist\\index.js"],
      "env": {
        "GMA3_INSTALL_DIR": "C:\\ProgramData\\MALightingTechnology"
      }
    }
  }
}
```

Use your actual resource path if it differs. If the client cannot find `node`, use its full path
from `(Get-Command node.exe).Source` (escape backslashes in JSON as shown above).
Reload or restart your MCP client after saving its configuration.

Regenerate the server path if you move this checkout. For a custom bridge port, use `-BridgePort 9801`.
The generator does not preserve manual changes, so restore `GMA3_INSTALL_DIR` after regenerating.

## 5. Check the connection

With onPC and the plugin running:

```powershell
node scripts/bridge-cli.mjs ping
```

Then ask your MCP client to call `gma3_status` and list sequences. These are read-only checks.
For updates or connection problems, see the [bridge guide](bridge.md).
