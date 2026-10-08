# Remote access over SSH

[README](../README.md) · [macOS setup](setup/macos.md) · [Windows setup](setup/windows.md)

Run the bridge plugin on the **onPC computer** and the Node.js MCP server on the **client computer**.
An SSH tunnel connects them. The bridge remains bound to the onPC computer's loopback address; it has
no authentication of its own. Do not expose port 9800 through a network relay or router forwarding rule.

## 1. Prepare the onPC computer

Copy, import and start the plugin using its [macOS](setup/macos.md) or [Windows](setup/windows.md)
setup guide. Install/build the Node.js server and configure the MCP client on the client computer.
The operating systems do not have to match.

Enable an SSH server on the onPC computer and authorize the client user's public key:

| onPC computer | Host setup |
| --- | --- |
| macOS | Enable Remote Login for the intended account using [Apple's instructions](https://support.apple.com/guide/mac-help/allow-a-remote-computer-to-access-your-mac-mchlp1066/mac). Install the public key in that account's `~/.ssh/authorized_keys`, with directory/file permissions appropriate for OpenSSH. |
| Windows | Install and enable OpenSSH Server using [Microsoft's setup guide](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse), then follow its [key management instructions](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement). With the default configuration, administrator accounts use `%ProgramData%\ssh\administrators_authorized_keys`; other accounts use their own `.ssh\authorized_keys`. Follow the documented permissions for the chosen account. |

Create the key on the client using the matching section below. Copy only its `.pub` file to the host;
the private key stays on the client. Use a passphrase where practical. After verifying key login,
configure the SSH server to disable password authentication if appropriate for your environment;
keep an existing session open while testing the change to avoid locking yourself out.

## 2. Connect from a macOS or Linux client

These commands run in the client's terminal. OpenSSH client tools must be installed.
Replace `user@console-host` with the account and address of the onPC computer.

```bash
mkdir -p ~/.ssh
ssh-keygen -t ed25519 -f ~/.ssh/gma3_console -C "gma3-mcp"
cat ~/.ssh/gma3_console.pub
```

Install the displayed public key on the host as described above. If that key file already exists,
reuse it or choose a new filename rather than overwriting it. Test key authentication:

```bash
ssh -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -i ~/.ssh/gma3_console user@console-host exit
```

A private-key passphrase prompt is normal. Then open the tunnel and leave this terminal running:

```bash
ssh -i ~/.ssh/gma3_console -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -N -L 127.0.0.1:9800:127.0.0.1:9800 user@console-host
```

In another terminal, from the repository directory:

```bash
node scripts/bridge-cli.mjs ping
```

If local port 9800 is occupied, replace the **first** 9800 in the forwarding argument with 19800,
then check and print matching MCP configuration:

```bash
GMA3_BRIDGE_PORT=19800 node scripts/bridge-cli.mjs ping
sh scripts/mcp-config.sh --bridge-port 19800 --print
```

## 3. Connect from a Windows client

Use this section instead of section 2. Install OpenSSH Client if it is not available, then run in
PowerShell. Replace `user@console-host` with the account and address of the onPC computer.

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.ssh" | Out-Null
ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\gma3_console" -C "gma3-mcp"
Get-Content "$env:USERPROFILE\.ssh\gma3_console.pub"
```

Install the displayed public key on the host as described above. If that key file already exists,
reuse it or choose a new filename rather than overwriting it. Test key authentication:

```powershell
ssh -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -i "$env:USERPROFILE\.ssh\gma3_console" user@console-host exit
```

A private-key passphrase prompt is normal. Open the tunnel and leave this window running:

```powershell
ssh -i "$env:USERPROFILE\.ssh\gma3_console" -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -N -L 127.0.0.1:9800:127.0.0.1:9800 user@console-host
```

In another PowerShell window, from the repository directory:

```powershell
node scripts/bridge-cli.mjs ping
```

If local port 9800 is occupied, replace the **first** 9800 in the forwarding argument with 19800,
then check and print matching MCP configuration:

```powershell
$env:GMA3_BRIDGE_PORT = '19800'
node scripts/bridge-cli.mjs ping
.\scripts\mcp-config.ps1 -BridgePort 19800 -Print
```

## 4. Use the remote bridge

With the default tunnel, the MCP server still connects to `127.0.0.1:9800`; no host override is needed.
For an alternate local port, merge the printed `gma3` entry into your client's configuration and restart
the client. Shell environment settings used for the CLI check do not automatically update that configuration.
If the bridge itself uses a custom port, change the **last** port in the forwarding argument too.

Call `gma3_status` through the MCP client to confirm the remote show and user before making changes.

- SSH local forwarding carries TCP, not OSC UDP. Start the bridge on the onPC computer before connecting;
  `gma3_start_bridge` cannot start it through this tunnel.
- Use `gma3_command` with `via: "bridge"` for remote commands. Automatic OSC fallback otherwise targets
  the MCP server's configured OSC destination and may report a send without reaching the remote show.
- The help tool reads files on the MCP server computer. The SSH tunnel does not make the remote manual
  available; configure a local manual location if you need this tool.
- When the tunnel closes, bridge access stops. Reopen it and check status before continuing.
