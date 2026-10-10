# Live probe records

Prose records of live probes on onPC, plus the script that reproduces the automated part.
They are evidence for [KEYBOARD.md](../../KEYBOARD.md), not automated regression coverage.

| Record | Platform |
| --- | --- |
| [kb-01-macos-2.5.1.md](kb-01-macos-2.5.1.md), [script report](kb-01-macos-2.5.1.json) (26/26) | macOS, onPC 2.5.1.0, one and two displays |
| [kb-01-windows-2.5.1.md](kb-01-windows-2.5.1.md), script reports for [one](kb-01-windows-2.5.1.json) and [two displays](kb-01-windows-2.5.1-2displays.json) (26/26 each) | Windows 11, onPC 2.5.1.0, one and two displays |
| [kb-02-loading-macos-2.5.1.md](kb-02-loading-macos-2.5.1.md) (module loading, save/reload without loose files) | macOS, onPC 2.5.1.0 |
| [kb-03-fake-macos-2.5.1.md](kb-03-fake-macos-2.5.1.md), [script report](kb-03-fake-macos-2.5.1.json) (33/33; owned sessions on the fake backend) | macOS, onPC 2.5.1.0 |
| [kb-04-keyboard-macos-2.5.1.md](kb-04-keyboard-macos-2.5.1.md), script reports for [run](kb-04-keyboard-macos-2.5.1.json) and [restart](kb-04-keyboard-macos-2.5.1-restart.json) (47/47, 12/12; real keys) | macOS, onPC 2.5.1.0 |
| [kb-05-input-macos-2.5.1.md](kb-05-input-macos-2.5.1.md), [script report](kb-05-input-macos-2.5.1.json) (44/44; interactions, busy guard, sequences, command-line text) | macOS, onPC 2.5.1.0 |
| [kb-06-feedback-macos-2.5.1.md](kb-06-feedback-macos-2.5.1.md), [script report](kb-06-feedback-macos-2.5.1.json) (47/47; feedback readers, displays, executors, bounds, reads while input is owned) | macOS, onPC 2.5.1.0 |
| [kb-10-cmdtext-write-macos-2.5.1.md](kb-10-cmdtext-write-macos-2.5.1.md) (`CmdObj().CmdText` is not writable: writes are silently ignored; readback plus on-screen caret/selection/pop-up checks) | macOS, onPC 2.5.1.0 |
| [kb-10-macro-append-macos-2.5.1.md](kb-10-macro-append-macos-2.5.1.md) (`AddToCmdline=Yes, Execute=No` macros insert at the caret on the next frame without executing; spaces stripped, digits contiguous, ShCuts on/off, pop-up) | macOS, onPC 2.5.1.0 |
| [kb-10-quickey-macos-2.5.1.md](kb-10-quickey-macos-2.5.1.md) (direct `Press Quickey` is a tap; press/release/chords through `Press`/`Unpress Executor`; 146 codes; stuck-key recovery by code; Oops is Undo; pop-up focus reorders digits) | macOS, onPC 2.5.1.0 |
| [kb-12-bank-macos-2.5.1.md](kb-12-bank-macos-2.5.1.md) (owned Quickey bank: 94 codes provisioned by plugin argument with readback-verified markers, operator edit detected by `bank verify`, record adopted across a bridge restart, teardown removes exactly the owned objects; paged executor assign/clear confirmed) | macOS, onPC 2.5.1.0 |
| [kb-13-quickey-macos-2.5.1.md](kb-13-quickey-macos-2.5.1.md), [script report](kb-13-quickey-macos-2.5.1.json) (46/46; owned-Quickey backend: taps, MA1 hold with MASTATE, duplicate suppression, MA1+STORE chord, Fixture 1 Thru 5 Please sequence, refusals before dispatch, executor reassigned during a hold, restart with the stuck record, teardown refused in use) | macOS, onPC 2.5.1.0 |

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

## Running the KB-03 session lifecycle probe

`node scripts/kb03-probe.mjs run [--out docs/probes/kb-03-<os>-<version>.json]` drives the owned input
sessions of a running bridge over two real TCP connections: binding, conflicts and aliases, a tap deadline
serviced by the plugin loop, a failed release kept as unresolved and recovered, lease expiry, an observed
"physical" release that is never compensated, and cleanup on an abrupt disconnect. It needs the bridge
started or toggled with `Plugin "gma3_mcp_bridge" "input=fake"` and no existing holds; Lua execution is
not required. Nothing reaches a console key on the fake backend. Operator-side paths (`input=off`,
`input status`, a restart with an unresolved record and `input recover`) are console commands; the record
describes how they were driven from macros.

## Running the KB-04 keyboard backend probe

`node scripts/kb04-probe.mjs run [--out docs/probes/kb-04-keyboard-<os>-<version>.json]` **presses real console
keys**. It needs the bridge started with `Plugin "gma3_mcp_bridge" "lua input=keyboard"` (Lua is used to read
`CmdObj().cmdtext`, `MASTATE` and the shortcut enablement for verification), a show whose name contains
`disposable`, `mcp-test` or `scratch`, no existing holds, an empty command line, MASTATE false and shortcuts
active; it refuses otherwise. Steps, in order: tap `NUM5` and `ESC`, native `PLEASE`, the `MA+STORE` combo
(`Record`), a 1.2 s exclusive `STORE` long-press (the Store Settings pop-up is not readable; the operator
confirms it by eye and the probe closes it with Escape), a remap of the `S` row and an `F10` toggle during a
hold (both reversed by the probe through `cmd`/Lua, standing in for the operator), and a disconnect. `restart`
holds `STORE`, remaps it, fires Macro 106 (stop + restart with `lua` only) and Macro 102 (`input recover`) twice,
restoring the row in between; it leaves the bridge running with input disabled (Macro 107 re-enables
`input=keyboard` on the test console). Record macOS and Windows separately; the fake-backend probe establishes
lifecycle behaviour, this one establishes console effects.

## Running the KB-05 structured input probe

`node scripts/kb05-probe.mjs run [--out docs/probes/kb-05-input-<os>-<version>.json]` **presses real console keys
and types text**. Same preconditions as the KB-04 probe: a bridge started with
`Plugin "gma3_mcp_bridge" "lua input=keyboard"` (plugin 0.7.0 or newer), a show whose name contains `disposable`,
`mcp-test` or `scratch`, no existing holds and nothing busy, an empty command line, MASTATE false and shortcuts
active. Over two connections it checks, in order: an acquired interaction (commands from both connections and the
other connection's tap refused `[busy]`, a hold without the id refused, a hold with it shown as `Store`, extend, end
releasing it, the ended id never resumed); a two-tap sequence (`51`); the `MA+STORE` chord sequence (`Record`, MASTATE
readback); command-line text refused while shortcuts are enabled, then shortcuts disabled through Lua (standing in
for the operator's F10), `Fixture 5` and `abü€😀` typed and read back without executing (`lastcommand` unchanged),
shortcuts re-enabled and Escape clearing the line; and a disconnect in the middle of a 3 s `STORE` tap (hold released,
sequence aborted, bridge not busy). Because the bridge refuses `lua` while input is owned, the probe reads the console
only after the interaction or sequence under test ended. Record: [kb-05-input-macos-2.5.1.md](kb-05-input-macos-2.5.1.md);
record Windows separately.

## Running the KB-06 feedback probe

`node scripts/kb06-probe.mjs verify [--out ...]` is **read-only** and runs against any show on a bridge with plugin
0.8.0 or newer: `feedback.describe`, every parameterless reader with three displays (a missing one must be unavailable,
not false), assignment and fader level of the assigned executors on the current page plus an empty one, sequence
activity, the 32-executor bound, the `executorActive` alias, that reads leave the command line and `ping.input`
untouched, and, when input is enabled, that a second connection's `feedback.read` answers while the first owns an
interaction (nothing is pressed). `node scripts/kb06-probe.mjs run [--out docs/probes/kb-06-feedback-<os>-<version>.json]`
adds three state changes on a show whose name contains `disposable`, `mcp-test` or `scratch` with Lua enabled and
nothing busy: Blind off/on, one fader of the first assigned executor to 25 or 75 and back, and `Go+`/`Off` of its
sequence; each is read back through the feedback op and restored. Record:
[kb-06-feedback-macos-2.5.1.md](kb-06-feedback-macos-2.5.1.md); record Windows separately.
