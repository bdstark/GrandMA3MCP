# Docker deployment

[README](../README.md) · [macOS setup](setup/macos.md) · [Windows setup](setup/windows.md)

Docker runs the Node.js MCP server. The Lua plugin still runs inside grandMA3 onPC and must be copied,
imported and started using the appropriate platform guide. The native setup is the simpler starting point.

## Build and configure

From the repository directory:

```text
docker build -t gma3-mcp .
```

Configure your MCP client to launch the container as a stdio server:

```json
{
  "mcpServers": {
    "gma3": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "--add-host=host.docker.internal:host-gateway", "gma3-mcp"]
    }
  }
}
```

The image defaults `GMA3_BRIDGE_HOST` and `GMA3_OSC_HOST` to `host.docker.internal`.
That hostname alone does not establish that your Docker networking setup can reach a service bound
only to the host's loopback interface. Check `gma3_status` after connecting. If the bridge is unreachable,
use the native setup or a supported host-networking arrangement; do not rebind or publicly relay the bridge.

To enable the manual tool, add a read-only volume mapping to the `args` array before `gma3-mcp`:

```json
["-v", "/absolute/path/to/MALightingTechnology:/gma3:ro"]
```

Use the actual host resource folder (see your platform guide). The image sets `GMA3_INSTALL_DIR=/gma3`.
Without that mount, the remaining tools still work but the local manual is unavailable.

## Linux client with a remote onPC computer

On a Linux Docker host, an [SSH tunnel](remote-access.md) can expose the remote bridge on local
loopback. Keep the tunnel running on that host and use host networking for the container:

```json
{
  "mcpServers": {
    "gma3": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "--network", "host",
               "-e", "GMA3_BRIDGE_HOST=127.0.0.1",
               "-e", "GMA3_OSC_HOST=127.0.0.1", "gma3-mcp"]
    }
  }
}
```

This describes a Linux **MCP client host**, not a native Linux onPC installation. For an alternate
local tunnel port, also pass `-e GMA3_BRIDGE_PORT=19800`. Remote commands should use `via: "bridge"`;
the tunnel does not forward OSC or provide access to the remote manual files.
