# Live probe records

Prose records of live probes on onPC, plus the script that reproduces the automated part.
They are evidence for [KEYBOARD.md](../../KEYBOARD.md), not automated regression coverage.

| Record | Platform |
| --- | --- |
| [kb-01-macos-2.5.1.md](kb-01-macos-2.5.1.md), [script report](kb-01-macos-2.5.1.json) (26/26) | macOS, onPC 2.5.1.0, one and two displays |
| [kb-01-windows-2.5.1.md](kb-01-windows-2.5.1.md), [script report](kb-01-windows-2.5.1.json) (26/26) | Windows 11, onPC 2.5.1.0, one display |
| [kb-02-loading-macos-2.5.1.md](kb-02-loading-macos-2.5.1.md) (module loading; save/reload pending) | macOS, onPC 2.5.1.0 |

## Running the KB-01 probe on another platform

Prerequisites: onPC with a **disposable** show whose name contains `disposable`, the bridge plugin
imported and started with Lua enabled (`Plugin "gma3_mcp_bridge" "lua on"`, see
[bridge setup](../setup/bridge.md)), keyboard shortcuts on (ShCuts yellow), no key held, and Node.js.

```bash
node scripts/kb01-probe.mjs auto --out docs/probes/kb-01-<os>-<version>.json
```

The automated run presses keys on the console, toggles Blind/Highlight/Solo, Preview and ShCuts and
selects one fixture; it restores all of these and reports `state restored`. It stores and assigns nothing.
Then run the manual checks it prints:

```bash
node scripts/kb01-probe.mjs longpress
```

```bash
node scripts/kb01-probe.mjs type
```

```bash
node scripts/kb01-probe.mjs hw-a
```

```bash
node scripts/kb01-probe.mjs hw-b
```

`type` needs the Edit Command dialog open first (keyboard icon left of the command line). `hw-a` and
`hw-b` need the onPC window focused and a physical Left Shift. Record the JSON report, the manual results,
keyboard layout, displays/monitors and OS foreground state in a new `kb-01-<os>-<version>.md`.
Set `GMA3_BRIDGE_HOST`/`GMA3_BRIDGE_PORT` if the bridge is not on `127.0.0.1:9800`.

## Running the KB-02 loading probe

`node scripts/kb02-probe.mjs probe` imports a throwaway two-component plugin into a free Plugin slot
(`--slot N`, default 2), records how the console runs its chunks, how `require`, `FileContent` and the
signal table behave, then deletes the slot and its files. `node scripts/kb02-probe.mjs verify` checks a
running bridge for loaded modules and loose module files. Both need Lua enabled on the bridge and a
disposable show.
