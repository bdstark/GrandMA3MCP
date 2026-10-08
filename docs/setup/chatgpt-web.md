# ChatGPT web

[README](../../README.md) · [macOS setup](macos.md#chatgpt-desktop) · [Windows setup](windows.md#chatgpt-desktop)

For a local desktop connection, use your platform guide. ChatGPT web does not read local MCP
configuration files. This repository provides a stdio MCP server; the Lua bridge on port 9800 speaks
its own TCP protocol, not HTTP MCP. Neither a local file path nor `http://localhost:9800` is a valid
ChatGPT server URL.

## Connect the existing server through Secure MCP Tunnel

OpenAI's [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
describes a private stdio connection without opening an inbound port. Follow that guide to:

1. Create a tunnel associated with your target ChatGPT workspace. Obtain the required Platform
   tunnel permissions and a runtime API key.
2. Install `tunnel-client` on the computer that runs this repository's Node.js server.
3. Configure a local stdio profile with the tunnel ID. Set its MCP command to your Node.js executable
   followed by the absolute path to this checkout's `dist/index.js`; quote paths containing spaces.
4. Run the profile's diagnostics, then keep the tunnel client running while ChatGPT uses the server.

First complete the build and plugin import in your platform guide. Start the bridge in onPC before
connecting. On Windows, provide `GMA3_INSTALL_DIR` to the server process for manual lookup. If using
an alternate bridge port, provide `GMA3_BRIDGE_PORT` as well. The tunnel setup does not consume Claude's
`.mcp.json` or the desktop app's TOML configuration. Keep credentials outside the repository.

## Add and use the plugin

In ChatGPT web, open **Plugins**, use the plus button to add a custom MCP server, name it `gma3`,
and choose **Tunnel** as the connection. Select the configured tunnel, complete the authentication
and warning prompts, then create and install the plugin. Workspace policies can restrict access.
See [OpenAI's custom MCP setup](https://developers.openai.com/api/docs/guides/custom-mcp-server).

In a conversation, select the installed plugin with `@` and ask:

> Use gma3 to call gma3_status and list the sequences. Do not change the show.

Confirm the expected show and user before requesting mutations. Arbitrary Lua stays disabled unless
you enable it explicitly in onPC; the ChatGPT connection needs no Lua changes.

If discovery fails, check the running tunnel profile, workspace association and permissions, then
check the bridge with `node scripts/bridge-cli.mjs ping` on the server computer. A successful ping
checks the console connection; it does not by itself verify the ChatGPT tunnel.

These instructions follow the linked OpenAI documentation. This project has not yet recorded a live
ChatGPT validation run. If your account lacks the required custom MCP or tunnel access, use an available
local desktop MCP client. Do not expose the raw Lua bridge as a substitute.
