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
   running, `gma3_command` can still fire commands over OSC (no feedback; only when the bridge cannot be reached
   before the command is sent, never as a retry after the bridge accepted it), and `gma3_start_bridge` can start
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
`Plugin "gma3_mcp_bridge" "9801"` starts it on another port. The port number is the only accepted
argument: the bridge always binds to `127.0.0.1` and refuses a `<host>:<port>` argument, because it has no
authentication. To use it from another machine, see [Remote access over SSH](#remote-access-over-ssh).

#### Enabling Lua execution

Arbitrary Lua (the `gma3_lua` tool) is **off by default**. Everything else keeps working without it. The
console operator turns it on per start, or toggles it while the bridge is running:

```
Plugin "gma3_mcp_bridge" "lua"              start with Lua execution enabled
Plugin "gma3_mcp_bridge" "9801 lua"         custom port and Lua execution enabled
Plugin "gma3_mcp_bridge" "lua on"           enable while running
Plugin "gma3_mcp_bridge" "lua off"          disable while running
Plugin "gma3_mcp_bridge" "lua luatime=2000 luasteps=5000000"
Plugin "gma3_mcp_bridge" "lua luahook=replace"    enforce the budget over the console's own hook (see below)
```

`status`, `lua on|off`, `luahook=...` and the budget tokens are control calls: they talk to the running bridge and leave it
running. Arguments are whitespace-separated tokens. Every start establishes the policy afresh, so enabling Lua is
always a visible decision in the start command (or macro); it never carries over from a previous run.
`status` and `gma3_status` show the current policy.

Each `gma3_lua` request runs under an execution budget: by default 5 s of wall-clock time and 20 million
Lua VM instructions. `luatime=<ms>` and `luasteps=<n>` change the limits (`0` = unlimited). A request that
exceeds its budget is aborted with an error and the bridge loop continues; the MCP server also passes the
client's request timeout down as the time budget, so a script stops when nobody is waiting for it any
more.

The script runs on the plugin's own thread. It has to: grandMA3 binds the plugin context to the thread it
created for the plugin, and a coroutine created from Lua gets no context, so `ObjectList()`, `DataPool()`,
`Programmer()` and every other context-bound function return nothing there (plugin 0.2.0 ran scripts in a
coroutine and had exactly that problem; fixed in 0.3.1). The instruction count is enforced with a Lua debug
hook installed on that thread for the duration of the script; the wall-clock deadline is checked by the
hook, after every yield, and before a result is returned, so a script that mostly waits is bounded too.
Once the budget is exceeded the hook raises on every instruction of submitted code (so `pcall` cannot
swallow it) but never inside the bridge's own code.

onPC keeps a hook of its own on the plugin thread (an external C hook with count 50000 on 2.5.1) whose purpose
MA does not document. A C hook cannot be called from or re-created in Lua, so the bridge has to choose:

* `luahook=preserve` (default): the console's hook is left alone. A script then runs **without the instruction
  hook**; the wall-clock deadline is still checked whenever the script yields and when it returns, but a script
  that neither yields nor returns cannot be stopped by the bridge. `gma3_status` reports `lua.bounded: false`
  with the reason, and every `gma3_lua` result carries `budget.instructionHookEnforced: false` and
  `budget.consoleHookPreserved: true`. Coroutines the script creates are still budgeted (they carry no console
  hook).
* `luahook=replace`: the budget hook is installed over the console's hook for the duration of the script, so
  the instruction and time budgets are enforced as described above. Afterwards the thread is left without the
  console's hook until the plugin is restarted. No behaviour change was observed with it gone on 2.5.1, but
  that observation is not a guarantee: enable this only when you need hard quotas and accept the unknown.

`gma3_status` shows what was found under `lua.consoleHook` and the mode under `lua.hookMode`. The automated
harness can only simulate a Lua hook, not the console's C hook; the preserve/replace decision itself is covered
by stubbing `debug.gethook`.

The script runs in an environment that closes the obvious ways around the budget: `debug.sethook` and
`debug.gethook` are withheld, coroutines the script creates (`coroutine.create` / `coroutine.wrap`) get the
budget hook as well, and `load`, `loadfile`, `dofile`, `require` and `package.loaded` resolve to that same
environment. Everything else, including the whole grandMA3 API, `io` and `os`, is the real thing, and
globals a script defines persist across requests as before.

Treat the budget as a **best-effort limit for trusted scripts**, not a security boundary:

* The hook only fires between Lua VM instructions. It cannot interrupt a C function that blocks, such as
  `Cmd()` opening a confirmation dialog or a blocking socket call.
* A script that sets out to escape still can, for example through `debug.getregistry` style introspection
  of the real libraries. Enabling Lua already hands the client `os` and `io`, so the trust decision is made
  when the operator turns the capability on; the budget protects against runaway scripts, not hostile ones.
* The hook runs only for code submitted through `gma3_lua`; the structured ops are not budgeted.

The plugin is stored in the show file, so after the first import you only need `Plugin "gma3_mcp_bridge"`
(for example from a macro) each time the show is loaded. Remember to save the show if you want to keep it.

To update the Lua code after editing it, run `npm run install-plugin` again and re-import:

```
Plugin "gma3_mcp_bridge" "stop"
Delete Plugin 1 /NoConfirmation
Import Plugin Library "gma3_mcp_bridge.xml" At Plugin 1
ReloadAllPlugins
Plugin "gma3_mcp_bridge"
```

`ReloadAllPlugins` is required: onPC keeps the Lua chunk it already loaded for a plugin name, so a delete and
re-import alone leaves the old code running (verified on 2.5.1). The start line in the command line history
shows the plugin version, e.g. `listening on 127.0.0.1:9800 (v0.3.4)`.

Quick check from a terminal without an MCP client:

```bash
node scripts/bridge-cli.mjs ping
node scripts/bridge-cli.mjs children '{"ref":"DataPool.Sequences","fields":["Name"]}'
```

### 3. Register the server with your MCP client

Claude Code reads a project-scope `.mcp.json` from the repository root. That file has to hold the absolute
path of `dist/index.js`, so it is git-ignored rather than committed; generate it once per clone (and again
if you move the directory):

```bash
sh scripts/mcp-config.sh
```

```powershell
.\scripts\mcp-config.ps1
```

Both scripts take `--bridge-port <n>` / `-BridgePort <n>` to add `GMA3_BRIDGE_PORT` to the config (used
with [an SSH tunnel on another local port](#remote-access-over-ssh)) and `--print` / `-Print` to print the
JSON instead of writing it. If you prefer the `claude` CLI's own user-scope config, run this from the
repository root instead; it needs no `.mcp.json`:

```bash
claude mcp add gma3 -- node "$PWD/dist/index.js"
```

Claude Desktop has no project config. Paste the output of `sh scripts/mcp-config.sh --print` (or
`.\scripts\mcp-config.ps1 -Print`) into its `claude_desktop_config.json`, merging the `gma3` entry into an
existing `mcpServers` object if there is one. The result looks like this, with the path of your checkout:

```json
{
  "mcpServers": {
    "gma3": {
      "command": "node",
      "args": ["/path/to/gma3-mcp/dist/index.js"]
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
               "-v", "/path/to/MALightingTechnology:/gma3:ro", "gma3-mcp"]
    }
  }
}
```

The image defaults `GMA3_BRIDGE_HOST` and `GMA3_OSC_HOST` to `host.docker.internal`. On Docker Desktop
(macOS/Windows) that reaches the plugin even though it binds to `127.0.0.1`. On Linux there is no
`host.docker.internal` route to the host's loopback, so run the container with `--network host` and point
both variables at `127.0.0.1`:

```json
"args": ["run", "-i", "--rm", "--network", "host",
         "-e", "GMA3_BRIDGE_HOST=127.0.0.1", "-e", "GMA3_OSC_HOST=127.0.0.1", "gma3-mcp"]
```

The volume mount is optional; it only enables `gma3_help`. Point it at the grandMA3 user folder
(`~/MALightingTechnology` on macOS), the one that contains `gma3_<version>/shared/language/HTML`.

### Remote access over SSH

The bridge never listens on anything but `127.0.0.1`, so the only way to reach it from another machine
is a tunnel that terminates on the console host and authenticates the client. SSH does exactly that and
is already available on every platform onPC runs on: the `ssh` and `ssh-keygen` clients ship with macOS,
Linux and Windows 10/11, and each has a built-in SSH server.

The steps are: make a key pair on the machine that runs the MCP client, install its public key on the
console host, turn password login off, and open the tunnel. Below, `user@console-host` is the account and
address of the grandMA3 host.

#### 1. Make a key pair on the machine running the MCP client

```bash
ssh-keygen -t ed25519 -f ~/.ssh/gma3_console -C "gma3-mcp"
```

```powershell
ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\gma3_console -C "gma3-mcp"
```

This writes the private key `gma3_console`, which never leaves the client, and the one-line public key
`gma3_console.pub`, which is safe to copy anywhere. A passphrase is optional; without one a script can
open the tunnel unattended.

#### 2. Enable the SSH server on the grandMA3 host and install the public key

**macOS host:** System Settings > General > Sharing > Remote Login, and limit access to your user (the
command-line equivalent is `sudo systemsetup -setremotelogin on`). Then, from the client:

```bash
ssh-copy-id -i ~/.ssh/gma3_console.pub user@console-host
```

From a Windows client, which has no `ssh-copy-id`:

```powershell
type $env:USERPROFILE\.ssh\gma3_console.pub | ssh user@console-host "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

**Windows 10/11 host:** in an *administrator* PowerShell on the console host:

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP'   # added by the install; should show Enabled : True
```

Windows keeps the keys of administrator accounts in one shared, permission-restricted file instead of
`~/.ssh/authorized_keys` (the default `sshd_config` has a `Match Group administrators` block for this).
If the account you log in with is an administrator, which is the usual case on a show computer, paste the
single line from `gma3_console.pub` into that file and fix its permissions:

```powershell
Add-Content -Force -Path "$env:ProgramData\ssh\administrators_authorized_keys" -Value 'ssh-ed25519 AAAA...your key... gma3-mcp'
icacls.exe "$env:ProgramData\ssh\administrators_authorized_keys" /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"
```

For a non-administrator account, append the line to `$env:USERPROFILE\.ssh\authorized_keys` instead
(create the `.ssh` folder if needed); no `icacls` step is required there.

**Linux host:** `sudo apt install openssh-server && sudo systemctl enable --now ssh` (Debian/Ubuntu),
then `ssh-copy-id -i ~/.ssh/gma3_console.pub user@console-host` from the client as for macOS.

Check the key before going on. This must log in and exit without asking for a password:

```bash
ssh -i ~/.ssh/gma3_console user@console-host exit
```

#### 3. Turn password login off

Once key login works, stop sshd from accepting passwords, so a guessed account password on a venue network
is not enough to reach the bridge.

* macOS (Ventura or newer, whose `sshd_config` includes `sshd_config.d/*`):

  ```bash
  sudo sh -c 'printf "PasswordAuthentication no\nKbdInteractiveAuthentication no\n" > /etc/ssh/sshd_config.d/100-keys-only.conf'
  sudo sshd -T | grep -i -e passwordauthentication -e kbdinteractiveauthentication   # both print "no"
  ```

  launchd starts sshd per connection, so the next connection already uses the new setting.
* Windows: in `C:\ProgramData\ssh\sshd_config` change `#PasswordAuthentication yes` to
  `PasswordAuthentication no`, then `Restart-Service sshd`.
* Linux: the same drop-in file as macOS, then `sudo systemctl restart ssh`.

#### 4. Open the tunnel from the client

Forward a local port to the bridge on the console host's loopback interface:

```bash
ssh -i ~/.ssh/gma3_console -N -L 9800:127.0.0.1:9800 user@console-host
```

Leave it running (or use `-f` to background it, and `autossh` if you want it to reconnect). The MCP server
runs on the client machine as usual and connects to `127.0.0.1:9800`, which is the near end of the tunnel,
so no configuration change is needed.

A host entry in `~/.ssh/config` (`%USERPROFILE%\.ssh\config` on Windows) keeps the command short, fails
fast if the port cannot be forwarded, and notices a dropped link:

```
Host gma3-console
    HostName console-host
    User user
    IdentityFile ~/.ssh/gma3_console
    LocalForward 9800 127.0.0.1:9800
    ExitOnForwardFailure yes
    ServerAliveInterval 30
```

With that in place, `ssh -N gma3-console` opens the tunnel. If port 9800 is taken locally, forward a
different local port and generate the MCP config with the matching `GMA3_BRIDGE_PORT`:

```bash
ssh -N -L 19800:127.0.0.1:9800 gma3-console
sh scripts/mcp-config.sh --bridge-port 19800
```

Check the tunnel with `node scripts/bridge-cli.mjs ping` (with `GMA3_BRIDGE_PORT` set if you changed it).

Background reading, none of it required:

* [SSH tunneling: client command and server configuration](https://www.ssh.com/academy/ssh/tunneling-example)
  (ssh.com academy) explains local, remote and dynamic forwarding.
* [SSH Tunneling - Local & Remote Port Forwarding (by Example)](https://www.youtube.com/watch?v=N8f5zv9UUMI)
  is a short video walkthrough of the same.
* Microsoft: [Get started with OpenSSH for Windows](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse)
  and [OpenSSH key management](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement),
  which covers the `administrators_authorized_keys` rule above.
* Apple: [Allow a remote computer to access your Mac](https://support.apple.com/guide/mac-help/allow-a-remote-computer-to-access-your-mac-mchlp1066/mac).

Limits of the tunnel:

* The OSC fallback and `gma3_start_bridge` use UDP, which `ssh -L` does not forward. Over a tunnel the
  bridge is the only transport; start the plugin on the console (from the command line or a show macro)
  before connecting. Do not point `GMA3_OSC_HOST` at the console's network address, since onPC's OSC input
  is equally unauthenticated.
* Never substitute a port-forwarding rule on a router, a VPN without per-host authentication, or a
  `socat`/`ncat` relay for the SSH tunnel: each of those republishes the unauthenticated bridge. The
  plugin rejects a bind address on purpose, and nothing in this project will help you work around that.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `GMA3_BRIDGE_HOST` / `GMA3_BRIDGE_PORT` | `127.0.0.1` / `9800` | Where the Lua bridge listens |
| `GMA3_BRIDGE_TIMEOUT_MS` | `15000` | Per-request timeout; also the default wall-clock budget sent with `gma3_lua` requests |
| `GMA3_ALLOW_LUA` | `1` | Set to `0` to not register the `gma3_lua` tool at all. The console-side switch (`Plugin "gma3_mcp_bridge" "lua"`, off by default) is the enforcement point; this one lets a deployment rule the tool out regardless of console state |
| `GMA3_OSC_HOST` / `GMA3_OSC_PORT` | `127.0.0.1` / `8000` | OSC fallback target (onPC: Menu > In & Out > OSC) |
| `GMA3_OSC_PREFIX` | *(none)* | OSC prefix configured in onPC, without slashes |
| `GMA3_INSTALL_DIR` / `GMA3_HELP_DIR` | `~/MALightingTechnology` | Where the bundled manual HTML is found |

## Tools

| Tool | What it does |
| --- | --- |
| `gma3_status` | Bridge reachability, software version, show file, user |
| `gma3_command` | Execute a command line command, returns OK / Syntax Error / Illegal Command |
| `gma3_lua` | Evaluate Lua inside onPC and return the result as JSON. Off until the operator [enables it on the console](#enabling-lua-execution); runs under a time/instruction budget |
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

Workflow tools (shared result model, see [below](#workflow-tools); details in [`docs/tools/`](docs/tools/)):

| Tool | What it does |
| --- | --- |
| `gma3_select` | Select fixtures by range or group; optional `ClearSelection` first ([docs](docs/tools/fixtures.md)) |
| `gma3_set_attribute`, `gma3_set_color`, `gma3_set_position` | `Attribute "<name>" At ...` on an explicit target or, on request, the current selection; RGB 0–100, pan/tilt with explicit units. Small explicit targets are pre-checked against the fixture type's attributes, and the programmer is read back and compared per fixture in the unit sent ([docs](docs/tools/fixtures.md)) |
| `gma3_clear_programmer` | `ClearSelection`, `ClearActive` or `ClearAll`, chosen explicitly ([docs](docs/tools/fixtures.md)) |
| `gma3_store_cue`, `gma3_store_cue_part` | `Store ... /NoConfirmation` with explicit create / merge / overwrite mode, name and timing set as separate verified steps ([docs](docs/tools/cues.md)) |
| `gma3_set_cue_timing`, `gma3_set_cue_trigger` | Edit part timing (fade, delay, out fade, out delay, snap delay) and trigger (Go, Time, Follow, Sound, BPM) with read-back ([docs](docs/tools/cues.md)) |
| `gma3_goto_cue`, `gma3_delete_cue` | `Goto` (a playback mutation) and single-cue `Delete ... /NoConfirmation` with existence checks ([docs](docs/tools/cues.md)) |
| `gma3_assign_to_executor`, `gma3_label_executor` | Inspect, then `Assign Sequence n At Page p.e` (replacing only with `replace`), label, read back ([docs](docs/tools/executors.md)) |

Structured inspection tools (read-only; work with Lua execution disabled; need plugin v0.3.0 or newer, see
[Updating the plugin](docs/tools/inspection.md#updating-the-plugin-required-once-for-these-tools)):

| Tool | What it does |
| --- | --- |
| `gma3_fixture_attributes` | Attributes of one fixture or subfixture with stable identifiers, units, ranges, defaults and DMX channel mapping; unknown metadata is `null`, never inferred ([docs](docs/tools/inspection.md)) |
| `gma3_programmer` | Active programmer values (all fixtures, current selection, or given fixtures) with masks, timing and every phaser step; reports incomplete coverage instead of claiming an empty programmer ([docs](docs/tools/inspection.md)) |
| `gma3_fixture_output` | DMX output per channel of a fixture: raw 8/16-bit values, percent, and a physical value where the channel function allows a conversion ([docs](docs/tools/inspection.md)) |
| `gma3_dmx` | Raw or percent DMX values of a universe and channel range, with `granted` and optional patch lookup ([docs](docs/tools/inspection.md)) |
| `gma3_cue_contents` | Stored cue and part data without Goto or Load: timing, command, recipes and preset references (optionally expanded); hard fixture values are reported as a documented limitation on 2.5.1 ([docs](docs/tools/inspection.md)) |

Resource `gma3://cheatsheet` holds a command syntax and object model reference.

Object references accept command syntax (`Sequence 1 Cue 3`, `Page 1.201`), dotted paths from a root
(`DataPool.Sequences`, `Patch.Fixtures`), numeric addresses (`14.14.1.7.1`) and the shortcuts `Root`,
`ShowData`, `ShowSettings`, `DataPool`, `MasterPool`, `SelectedSequence`, `CurrentCue`, `Patch`, `Programmer`,
`Selection`, `CurrentExecPage`. Property names are case-insensitive (`Name`, `TrigType`, `FID`); values come back
as the display text the editor shows, and object references are resolved to the referenced object's name.

## Workflow tools

The tools above are thin wrappers over single bridge requests and keep their original responses. The
workflow tools added for fixture programming, cue storage and editing, executor assignment and structured
inspection are built on a shared result model (`src/results.ts`) so a client can tell, after every call,
whether to continue, inspect console state, or stop:

```json
{
  "operation": "store_cue",
  "target": { "sequence": 1, "cue": "2.5" },
  "outcome": "succeeded",              // succeeded | failed | partial | unknown
  "verification": { "status": "matched" },  // matched | mismatched | unavailable | not_requested
  "steps": [ { "name": "store", "status": "succeeded", "op": "cmd", "command": "Store Sequence 1 Cue 2.5 /NoConfirmation", "feedback": "OK" } ],
  "summary": "store_cue succeeded. read-back matched."
}
```

* Recognised negative command-line feedback (`Syntax Error`, `Illegal Command`, `... does not exist`, ...) is a
  failure. Feedback the server does not recognise makes the step `unknown`; it is never assumed to be success.
* A transport error after a request was dispatched (timeout, dropped connection) makes the step `unknown`. The
  command may have executed, so nothing is retried and nothing falls back to OSC.
* Multi-step operations stop at the first failed or unknown step; the remaining steps are reported as
  `skipped`. An operation with some steps done and one not is `partial`.
* Any outcome other than `succeeded`, and any `mismatched` read-back, is returned as an MCP tool error with the
  full result in the error text.
* Inputs are validated before anything is sent (finite numbers, zero accepted as a deliberate value, cue numbers
  with up to three decimals, mutually exclusive options). Object names may not contain any of
  `\ " $ & * ? , . ; ^ { } | ~`: onPC 2.5.1 silently removes those characters from a name whether it arrives
  through `Label` or through the Lua `Set("Name")` API (verified live; "Look 2.5" becomes "Look 25"), so the tools
  refuse such names rather than store something different from what was asked.
* Mutations issued by this server, including the existing `gma3_command`, `gma3_set_property`, `gma3_playback`,
  `gma3_set_fader` and `gma3_lua` (a script may call `Cmd()` or `Set()`, so it is never treated as read-only),
  are serialised by one lock so a multi-command workflow is not interleaved with another tool call. Each
  workflow holds the lock from its first command through its read-back. This orders only this process's own
  requests: it does not isolate anything from another console operator or another MCP server or client.

Per-tool documentation (commands sent, selection and programmer impact, what is and is not verified, live test
procedure) is in [`docs/tools/`](docs/tools/).

Console behaviour the tools were adjusted to after the live run on onPC 2.5.1.0 (plugin v0.3.0, Lua execution
disabled, disposable show):

* A cue's name is the name of its Part 0. `Set("Name")` on the cue object is ignored; the tools set it on the part.
* `CueFade` and `CueDelay` are composite display properties ("3.00 / 1.50"). Writes go to `CueInFade`,
  `CueOutFade`, `CueInDelay` and `CueOutDelay`, and read-back compares those.
* An executor has no label of its own: `Label Page 90.201 "x"` renames the assigned sequence, and the executor
  shows that name. `gma3_label_executor` is documented accordingly.
* Entering `Fixture 1 Thru 5` adds to the selection while no values are active and replaces it once values are
  active, as the manual says; `gma3_select` has `clear_first` for a deterministic result.
* DMX output reads return `null` with a `granted: false` limitation while the universe is not granted to this
  onPC (no output license), rather than zeros.
* Programmer values read through the `programmer` op are percent of the attribute range (Pan 10° on a
  −225..225° fixture reads 52.22 %); the fixture setters convert the value they sent through each fixture's
  own range before comparing. A fixture without the attribute simply has no row, which the setters report as
  a mismatch. A selected compound fixture is listed only as its parent while its values sit on the cells.

Verified against grandMA3 onPC 2.5.1.0 on macOS (its Lua engine reports Lua 5.5).

## Bridge protocol

One JSON document per line over TCP.

```
→ {"id":"1","op":"cmd","args":{"command":"Go+ Sequence 1"}}
← {"id":"1","ok":true,"result":{"command":"Go+ Sequence 1","feedback":"OK"}}
```

Ops: `ping`, `cmd`, `lua`, `object`, `children`, `objects`, `dump`, `set`, `setfader`, `getfader`,
`executor`, `executors`, `api`, `stop`, and since plugin v0.3.0 the read-only inspection ops `fixtureAttributes`,
`programmer`, `fixtureOutput`, `dmx`, `cueContents` (arguments and result shapes in
[docs/tools/inspection.md](docs/tools/inspection.md#bridge-protocol-additions)). See `plugin/gma3_mcp_bridge.lua`.

`ping` reports the Lua execution policy as `lua: {enabled, maxMs, maxSteps, bounded}`. The `lua` op is
refused with an error while `enabled` is false; its optional `maxMs` / `maxSteps` args can only tighten the
console's budget, never loosen it.

## Safety notes

* Everything the server does happens in the live show. `gma3_set_property`, `Store`, `Delete` and similar
  commands change show data; nothing is written to disk unless `SaveShow` is executed.
* The bridge binds to `127.0.0.1` only and cannot be told to bind elsewhere; it also drops any accepted
  connection whose peer is not loopback. There is no authentication, so anything running on the console
  host can run commands in the console. Remote use goes through [an SSH tunnel](#remote-access-over-ssh).
* Arbitrary Lua is a separately enabled capability: `gma3_lua` is refused until the operator starts the
  bridge with the `lua` argument, and each request is aborted when it exceeds the configured time or
  instruction budget (see [Enabling Lua execution](#enabling-lua-execution)). The budget is a best-effort
  guard against runaway scripts, not a sandbox. Once enabled, Lua has the same reach as the console's own
  plugins, including `os` and `io`; enable it only for clients you trust.
* `Cmd()` runs synchronously in the Lua task; a command that opens a blocking dialog can stall the plugin,
  and the Lua budget cannot interrupt it because the hook only fires between Lua VM instructions.
  Prefer `/NoConfirmation` options.

## Development

```bash
npm run dev        # run from source with tsx
npm run build      # compile to dist/
npm test           # run the automated suite (no console needed)
npm run coverage   # tests plus a line/branch/function coverage table for src/
npm run test:live  # live console tests; see test/live/README.md (opt-in, modifies a disposable show)
```

`npm test` is the one command that runs every automated check without a live console; `.github/workflows/ci.yml`
runs the build and the same suite on every push and pull request (Node 20 and 22, with Lua 5.4 installed so
the plugin harness is not skipped).

The suite in `test/` has no extra dependencies:

* `bridge.test.ts`: the TCP client (`bridge.ts`), including UTF-8 sequences split across packets, replies
  matched to concurrent requests by id, and the `dispatched` flag that stops a timed-out or disconnected
  request from ever being resent.
* `help*.test.ts`: manual lookup (`help.ts`), including path traversal and symlink rejection.
* `results.test.ts`, `validate.test.ts`, `mutations.test.ts`: the shared workflow result model, input
  validation and the mutation lock (see [Workflow tools](#workflow-tools)).
* `server.test.ts`, `registration.test.ts`: the MCP server started over stdio against a fake bridge and a UDP
  listener standing in for OSC input (transport decisions, tool registration, serialised mutations).
* Per-area tool tests (`fixtures.test.ts`, `cues.test.ts`, ...) run the tool modules in-process against a
  scripted fake bridge (`test/helpers/`).
* `test/lua/bridge_plugin_test.lua` exercises the console plugin under a stock Lua 5.4+ interpreter with the
  grandMA3 API and LuaSocket stubbed: Lua execution off by default, budget and sandbox hardening (hook removal,
  child coroutines, deadlines across yields), argument parsing, loopback-only binding and rejection of a
  non-loopback peer. `npm test` runs it when `lua` is on PATH and skips it otherwise (`brew install lua`).

Live tests live in `test/live/*.live.ts`, are never picked up by `npm test`, and refuse to run unless
`GMA3_LIVE=1` is set and the loaded show file name matches `GMA3_LIVE_SHOW` (default: a name containing
"disposable", "mcp-test" or "scratch"). Each file documents the show objects it creates and deletes;
`test/live/README.md` lists the reserved ranges. Nothing in the tests calls `SaveShow`.

`npm run coverage:lcov` additionally writes `coverage/lcov.info` for editor and CI integrations. Lua coverage
is not measured.

Help pages, OSC and Lua API details were taken from the manual bundled with onPC 2.5.1
(`~/MALightingTechnology/gma3_2.5.1/shared/language/HTML`).

## License

[MIT](LICENSE)

grandMA3 and MA Lighting are trademarks of MA Lighting Technology GmbH. This project is independent and is
not affiliated with, endorsed by, or supported by MA Lighting. No MA Lighting documentation, code, or
libraries are redistributed here: the help tool reads the manual from your own onPC installation at runtime,
and the bridge plugin uses the LuaSocket and JSON libraries already shipped inside onPC.
