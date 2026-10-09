# Configuration and tool reference

[README](../README.md) · [macOS setup](setup/macos.md) · [Windows setup](setup/windows.md)

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `GMA3_BRIDGE_HOST` / `GMA3_BRIDGE_PORT` | `127.0.0.1` / `9800` | Where the Lua bridge listens |
| `GMA3_BRIDGE_TIMEOUT_MS` | `15000` | Per-request timeout; also the default wall-clock budget sent with `gma3_lua` requests |
| `GMA3_ALLOW_LUA` | `1` | Set to `0` to not register the `gma3_lua` tool at all. The console-side switch (`Plugin "gma3_mcp_bridge" "lua"`, off by default) is the enforcement point; this one lets a deployment rule the tool out regardless of console state |
| `GMA3_OSC_HOST` / `GMA3_OSC_PORT` | `127.0.0.1` / `8000` | OSC fallback target (onPC: Menu > In & Out > OSC) |
| `GMA3_OSC_PREFIX` | *(none)* | OSC prefix configured in onPC, without slashes |
| `GMA3_INSTALL_DIR` | `~/MALightingTechnology` | Base folder containing versioned `gma3_<version>` directories; set explicitly on Windows |
| `GMA3_HELP_DIR` | *(auto-detected)* | Override with the exact manual HTML directory (`gma3_<version>/shared/language/HTML`) |

## Tools

| Tool | What it does |
| --- | --- |
| `gma3_status` | Bridge reachability, software version, show file, user |
| `gma3_command` | Execute a command line command, returns OK / Syntax Error / Illegal Command |
| `gma3_lua` | Evaluate Lua inside onPC and return the result as JSON. Off until the operator [enables it on the console](lua.md); uses a best-effort execution budget |
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

Workflow tools (shared result model, see [below](#workflow-tools); details in [`tools/`](tools/)):

| Tool | What it does |
| --- | --- |
| `gma3_select` | Select fixtures by range or group; optional `ClearSelection` first ([docs](tools/fixtures.md)) |
| `gma3_set_attribute`, `gma3_set_color`, `gma3_set_position` | `Attribute "<name>" At ...` on an explicit target or, on request, the current selection; RGB 0–100, pan/tilt with explicit units. Small explicit targets are pre-checked against the fixture type's attributes, and the programmer is read back and compared per fixture in the unit sent ([docs](tools/fixtures.md)) |
| `gma3_clear_programmer` | `ClearSelection`, `ClearActive` or `ClearAll`, chosen explicitly ([docs](tools/fixtures.md)) |
| `gma3_store_cue`, `gma3_store_cue_part` | `Store ... /NoConfirmation` with explicit create / merge / overwrite mode, name and timing set as separate verified steps ([docs](tools/cues.md)) |
| `gma3_set_cue_timing`, `gma3_set_cue_trigger` | Edit part timing (fade, delay, out fade, out delay, snap delay) and trigger (Go, Time, Follow, Sound, BPM) with read-back ([docs](tools/cues.md)) |
| `gma3_goto_cue`, `gma3_delete_cue` | `Goto` (a playback mutation) and single-cue `Delete ... /NoConfirmation` with existence checks ([docs](tools/cues.md)) |
| `gma3_assign_to_executor`, `gma3_label_executor` | Inspect, then `Assign Sequence n At Page p.e` (replacing only with `replace`), label, read back ([docs](tools/executors.md)) |

Structured inspection tools (read-only; work with Lua execution disabled; need plugin v0.3.0 or newer, see
[Updating the plugin](tools/inspection.md#updating-the-plugin-required-once-for-these-tools)):

| Tool | What it does |
| --- | --- |
| `gma3_fixture_attributes` | Attributes of one fixture or subfixture with stable identifiers, units, ranges, defaults and DMX channel mapping; unknown metadata is `null`, never inferred ([docs](tools/inspection.md)) |
| `gma3_programmer` | Active programmer values (all fixtures, current selection, or given fixtures) with masks, timing and every phaser step; reports incomplete coverage instead of claiming an empty programmer ([docs](tools/inspection.md)) |
| `gma3_fixture_output` | DMX output per channel of a fixture: raw 8/16-bit values, percent, and a physical value where the channel function allows a conversion ([docs](tools/inspection.md)) |
| `gma3_dmx` | Raw or percent DMX values of a universe and channel range, with `granted` and optional patch lookup ([docs](tools/inspection.md)) |
| `gma3_cue_contents` | Stored cue and part data without Goto or Load: timing, command, recipes and preset references (optionally expanded); hard fixture values are reported as a documented limitation on 2.5.1 ([docs](tools/inspection.md)) |

Resource `gma3://cheatsheet` holds a command syntax and object model reference.

Object references accept command syntax (`Sequence 1 Cue 3`, `Page 1.201`), dotted paths from a root
(`DataPool.Sequences`, `Patch.Fixtures`), numeric addresses (`14.14.1.7.1`) and the shortcuts `Root`,
`ShowData`, `ShowSettings`, `DataPool`, `MasterPool`, `SelectedSequence`, `CurrentCue`, `Patch`, `Programmer`,
`Selection`, `CurrentExecPage`. Property names are case-insensitive (`Name`, `TrigType`, `FID`); values come back
as the display text the editor shows, and object references are resolved to the referenced object's name.

## Workflow tools

The tools above are thin wrappers over single bridge requests and keep their original responses. The
workflow tools added for fixture programming, cue storage and editing, executor assignment are built on a shared result model (`src/results.ts`) so a client can tell, after every call,
whether to continue, inspect console state, or stop:

```jsonc
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
procedure) is in [`tools/`](tools/).

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
[docs/tools/inspection.md](tools/inspection.md#bridge-protocol-additions)), and since v0.4.0 the read-only
`modules` op (loaded [console interaction modules](modules.md), their versions, errors and instance status;
`ping` carries the same summary under `modules`), and since v0.5.0 the owned input session ops `input.open`,
`input.renew`, `input.close`, `input.press`, `input.tap`, `input.release`, `input.releaseAll`, `input.recover`,
`input.status` and the fake-backend test control `input.fake` (below). See
[`plugin/gma3_mcp_bridge.lua`](../plugin/gma3_mcp_bridge.lua).

`ping` reports the Lua execution policy as `lua: {enabled, maxMs, maxSteps, bounded}`. The `lua` op is
refused with an error while `enabled` is false; its optional `maxMs` / `maxSteps` args can only tighten the
console's budget, never loosen it.

### Owned input sessions (plugin v0.5.0, KB-03)

Owned input is a separate per-start opt-in (`Plugin "gma3_mcp_bridge" "input=fake"`, or `input=off`); `ping`
reports it as `input: {enabled, backend, sessions, holds, unresolved, unresolvedFromPreviousRun}`. Only the
**fake backend** exists in this version: it records events and simulates aggregate key state, and nothing
reaches a console key. `input=keyboard` is refused until KB-04.

A session belongs to the TCP connection that opened it (`input.open {leaseMs?, label?}`; the id is derived
from the connection and never taken from a request), so another connection cannot release or renew it.
`input.press {key | pcKey, shift?, ctrl?, alt?, numlock?, display?, executor?, maxHoldMs?}` and
`input.tap {..., holdMs?}` need input enabled; `input.release {hold | key | pcKey...}`, `input.releaseAll`,
`input.recover` (own session only), `input.close` and the read-only `input.status` stay available while input
is disabled, because they are the recovery path. Errors carry a bracketed code: `[no-session]`, `[conflict]`
(with the owning session), `[not-owner]`, `[lease-expired]`, `[route-changed]`, `[unsupported]`, `[capacity]`,
`[input-disabled]`, `[stopping]`. A disconnect, lease expiry, `input=off`, `stop` and `Cleanup` attempt to
release what a session holds; a release that fails or cannot be confirmed is kept as an unresolved record,
survives a bridge restart and is cleared only by the operator's console-side
`Plugin "gma3_mcp_bridge" "input recover"` (or the owner's `input.recover`). At the next start the kept
records are adopted before any input is admitted, so their keys are reserved (`[conflict]` naming the
`previous-run` session) until the operator recovers them; `ping.input.unresolvedFromPreviousRun` counts only
records the instance could not take. A module that raises in `service()` is detached only after input is
disabled, every held key got a release attempt and the unresolved records were kept. `input=off` keeps the
attached backend, so `input recover` still releases then; only on an instance that never had a backend
attached (the default after a restart) can it dispatch nothing: it says so, the records stay reserved and
unresolved, and a later `input recover` after `input=fake` releases them. `input.status` never releases
anything. `input.fake {action}` (fake backend only) stages `failRelease`/`failPress` (`pcKey`, `sticky`,
`error`), `clearFailures`, `confirm` (`mode`), `physicalRelease`/`physicalPress` (`pcKey`) and returns the
event log; see [docs/modules.md](modules.md) for the ownership and release semantics.
