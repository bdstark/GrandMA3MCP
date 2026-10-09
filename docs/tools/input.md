# Structured input tools (KB-05)

Gated console key input, text and bounded sequences through the bridge's owned input sessions
([KEYBOARD.md](../../KEYBOARD.md), [modules](../modules.md#interactions-text-and-sequences-gma3_mcp_hardkeys-040-kb-05)).
**Real console keys are pressed** on the keyboard backend. Nothing here works until the console operator enables
input for the running bridge, per start:

```text
Plugin "gma3_mcp_bridge" "input=keyboard"
```

| Tool | Bridge ops | What it does |
| --- | --- | --- |
| `gma3_input_interaction` | `input.begin`, `input.extend`, `input.end` | Acquire, renew or end a leased interaction: explicit ownership across calls |
| `gma3_hardkey` | `input.sequence` (tap), `input.press` / `input.combo` (press), `input.release` (release) | Logical MA key (PLEASE, STORE, ESC, CLEAR, OOPS, NUM0–9, EXEC + executor, MA) and 2–4 key combinations |
| `gma3_keyboard` | same | Raw `Enums.KeyboardCodes` key with explicit shift/ctrl/alt/numlock on press and release |
| `gma3_type` | `input.sequence` | Unicode text into an explicit context; never presses Enter |
| `gma3_input_sequence` | `input.sequence`, `input.sequence.status` | Ordered taps, presses, releases, combos, text and waits under one owner |
| `gma3_hardkeys_status` | `input.status` | Read-only capability, enablement, owners, records, interactions, sequence, busy descriptor |
| `gma3_hardkeys_release_all` | `input.releaseAll` (+ `input.recover`) | Release this server's keys; re-attempt unresolved releases |

Every tool is a thin wrapper: resolution, validation, dispatch, ownership, leases, deadlines, admission and recovery
live in the Lua bridge (`plugin/gma3_mcp_hardkeys.lua` 0.4.0 through `plugin/gma3_mcp_bridge.lua` 0.7.0). The
TypeScript side sends the documented ops, waits for a sequence without replaying it, keeps the bridge's structured
error (`code`, `detail`) and reports through the shared [result model](../reference.md#workflow-tools). None of
the tools depends on `gma3_lua`; they register and work with `GMA3_ALLOW_LUA=0` and with Lua disabled on the console.

## Who owns an interaction

The bridge binds one input **session** to this server's TCP connection (opened on demand, renewed before every
call, never taken from a request). Inside it:

- A **bounded tap, chord tap, `gma3_type` call or sequence** owns a bridge-side interaction for its duration
  (begun and ended by the bridge) and needs no id. If this server already has an interaction open, the id must be
  passed: calls that share one connection cannot act on each other's holds by accident.
- A **standalone hold** (`press`, or a combination with action `press`) needs an interaction acquired first with
  `gma3_input_interaction action: acquire` (lease default 15 s, max 120 s, renewable; nothing is pressed) and its
  id on every `press`/`release`/`type`/sequence call. `end` releases everything the interaction holds (newest
  first) and aborts its sequence. Expiry does the same.
- An interaction is **never resumed**: after `end`, a lease expiry, a bridge reconnect or restart, the id is refused
  (`[no-interaction]`) and a new one must be acquired. Nothing that was in flight is replayed.

While an interaction is open, a sequence runs, **any key is held** or **a release stayed unresolved** (the key may
still be down), the bridge refuses `cmd`, `set`, `setfader` and `lua` from **every** connection with `[busy]`
(naming the owner, the interaction, sequence or hold and the remaining lease): `gma3_command`, `gma3_set_property`, `gma3_playback`, `gma3_set_fader`, `gma3_lua` and every
workflow tool that sends a command are affected, from this server and from any other client of the bridge. Reads
(`gma3_get_object`, the inspection tools, `gma3_hardkeys_status`, sequence status), the owner's releases,
`gma3_hardkeys_release_all` and `end` stay available. A refusal is explicit: a command is never queued into a
context that an input interaction may have changed, and never while the keyboard state is uncertain. An unresolved
record keeps the bridge busy for everyone (including a start that adopted records from a previous run) until
`gma3_hardkeys_release_all recover: true` or the operator's `input recover` resolves it.

This guard serialises bridge clients only. It cannot isolate a physical operator, OS-delivered input or another
plugin pressing keys: injected and physical input share one console key state (KB-01). Use the tools on a console
that is not being operated concurrently.

## What a result means

The tools report through the shared outcome model: `outcome` (`succeeded`, `failed`, `partial`, `unknown`),
`verification` (`matched`, `unavailable`, `not_requested`), one step per event, and `warnings`.

- **tap** returns once the release was *attempted*: the step is `succeeded` when the release outcome is
  `dispatched` (every `Keyboard()` release; no per-key readback exists) and `unknown` when it stayed unresolved.
  `completed` never means a UI effect was verified.
- **press** reports the hold (`hold` id, `interaction`); verification is `unavailable`. The key stays down until a
  release, `gma3_hardkeys_release_all`, the end or expiry of the interaction, the session's lease expiry
  (60 s, renewed by every call) or a disconnect.
- **release** uses the stored press tuple (never a newly resolved mapping). `dispatched` is `succeeded`;
  `unresolved` (the shortcut was remapped or disabled during the hold, the backend raised) is `unknown` and the
  record is kept until `gma3_hardkeys_release_all recover: true` succeeds after the operator restored the route, or
  the operator runs `Plugin "gma3_mcp_bridge" "input recover"`. Releasing an already released key is harmless.
- **verification** is `matched` only when a readable observable showed the expected value: the aggregate
  `MASTATE` after an MA press or release (worded as aggregate: another Shift source could keep it true; never a
  per-key confirmation) and the command line (`CmdObj().cmdtext`) after command-line text. Everything else is
  `unavailable` with the reason (no observable, focus not observable, readback inconclusive within its window).
  An inconclusive readback is not a failure: the console may have been edited meanwhile; nothing is retried.
- A step whose dispatch **raised** (delivery unknown) or whose release stayed **unresolved** is `unknown`; a
  combination that pressed keys before a later key was refused is `unknown` with the pressed keys and the
  rollback in `detail`. Later steps of a sequence are `skipped` (reported as "not attempted").
- A sequence still running when the tool stops waiting (its estimate plus 3 s, at most twice the request timeout)
  is reported `unknown` with a warning; it keeps running on the console within its lease and is **never
  resent**. Read it back with `gma3_hardkeys_status` (the `sequence` field) or its id.
- A failed or aborted sequence releases the keys it still held, newest first, and says what could not be released.

## Keys

`gma3_hardkey` resolves a logical key on the console through the operator's live user profile (shortcut table) or
a verified native route: `MA` is the PC `LeftShift` key itself (verified by `MASTATE`), `PLEASE` the system `Enter`
redirect (admitted with shortcuts disabled too). Shortcut-table keys need `KEYBOARDSHORTCUTSACTIVE` read as true and
an unambiguous, collision-free row; `EXEC` needs `executor` (the `ExecutorIndex` of a mapped executor shortcut).
`MA1`/`MA2` are unsupported (both Shift keys feed one MA state). Unresolvable, ambiguous or colliding routes are
refused before dispatch; nothing is substituted. A route that changes during a hold (remap, F10, profile switch)
stops every new press for every client until the record is released or recovered; the bridge never changes
mappings or toggles shortcuts.

`gma3_keyboard` sends a raw `Enums.KeyboardCodes` name (case-sensitive: `Enter`, `Escape`, `F1`, `5`, `A`,
`LeftShift`) with the modifiers passed on the press **and** the release (`Ctrl+F1` is one event with `ctrl: true`;
no modifier key is pressed separately; the shift flag is a PC modifier, not MA). What the key does depends on the
profile, shortcut enablement and the focused UI element: a mapped key may edit a focused field instead of acting as
a hardkey. Prefer `gma3_hardkey` for MA keys.

`exclusive: true` on a single-key tap or press is the intended **long-press**: refused while anything else is
held, and refusing every other input (including the owner's duplicate) until its release is resolved. Combinations
(`keys`, 2–4 logical keys) are pressed in order after every key passed validation and released newest first; a
combination is never a long-press. Double-press is unsupported. `display` must exist but routes nothing: input is
not display-scoped on onPC 2.5.1.

## Text

`gma3_type` (and `text` steps) type UTF-8 text one character event (`Keyboard(display, 'char', <code point>)`) per
Unicode code point, in chunks of 8 per bridge loop iteration. Which element receives characters cannot be observed
from Lua, so `acknowledge_focus: true` is always required: the caller states that the named context is focused.
Text is input like any key: it is refused while an exclusive long-press is held or a held key's route changed. The policy, enforced on the server and again on the
console: at most 256 characters; newline, carriage return, tab, other C0/C1 controls, DEL and the line/paragraph
separators are refused, so text can never execute a line, close a dialog or move focus; nothing is normalised.
Committing text is a separate, explicit `gma3_hardkey` PLEASE tap.

The context is explicit and validated:

- `command-line`: admitted only while the operator has **disabled keyboard shortcuts** (F10; readable as
  `KEYBOARDSHORTCUTSACTIVE = false`). With shortcuts enabled, character events never reach the command line
  (KB-01); the tool refuses instead of substituting key presses or toggling shortcuts. The command line must be
  readable (otherwise the text is refused: it could not be verified); it is read before typing and read back afterwards (bounded window, polled across frames): `matched` when it shows the
  previous content plus the text. When it does not within the window, the step is **`unknown`** (typed but not
  verified) and the sequence stops, so a later PLEASE can never commit text that was not seen.
- `text-field`: a text field (Edit Command dialog, an editor) is focused. It cannot be read back, so verification is
  `unavailable`, and a PLEASE/Enter step after it in the same sequence is refused at validation: check the field and
  commit with a separate explicit call. With shortcuts enabled, text goes to the focused editor; with shortcuts
  disabled, to whatever is focused.

Between chunks the bridge rechecks the context (shortcut enablement, exclusive hold, held-key routes); a change
stops typing with the count of characters typed (`unknown` with code `context-changed`, `exclusive-hold` or
`route-changed`) and the remaining ones unattempted. A character whose dispatch raised is `unknown` at that
position (`uncertainChar`); typing stops. Nothing is retyped.

## Sequences

`gma3_input_sequence` runs at most 16 steps whose holds, waits and typing add up to about 30 s. Step kinds:
`tap` (`hold_ms` ≤ 5000, `exclusive`), `press` (held until a later `release` step or the end of the sequence),
`release` (a key an earlier step pressed, or this server holds), `combo` (`keys`, `hold_ms` for a chord tap),
`text` (as `gma3_type`), `wait` (`ms` ≤ 2000). The bridge validates every step before the first event (routes,
key names, hold durations and flags of every key including combo constituents, text policy, context, ownership of
releases, no commit after text-field text); one invalid step means nothing is dispatched. The steps
are then serviced one after another by the plugin loop, so tap releases, leases and deadlines keep running
meanwhile, and only one sequence runs per bridge at a time. Pass `interaction` to run inside an acquired interaction
(its remaining lease must cover the estimate), otherwise one is begun and ended for the sequence (`lease_ms`
optional).

## Serialisation caveat

Input tools take this server's mutation lock, so they never interleave with `gma3_command` or a workflow tool from
the same server. The bridge-side busy rule covers every other client. Neither isolates a physical operator; treat
`verification` as the source of truth.

## Recovery

`gma3_hardkeys_release_all` releases every key of this server's session newest first and, with `recover: true`,
re-attempts the releases that stayed unresolved. Both work while input is disabled. A disconnect, lease expiry,
`input=off`, `stop` and the console's `Cleanup` attempt to release what the session holds; what cannot be released
is kept as an unresolved record, survives a bridge restart (its key stays reserved) and is cleared only by a
successful recover or the operator's `Plugin "gma3_mcp_bridge" "input recover"`. Expiry and cleanup are release
*attempts*: a blocked host call, a dead plugin thread or a terminated process prevents them.

## Live procedure

`node scripts/kb05-probe.mjs run [--out docs/probes/kb-05-input-<os>-<version>.json]` against a bridge started
with `Plugin "gma3_mcp_bridge" "lua input=keyboard"` on a show whose name contains `disposable`, `mcp-test` or
`scratch`, with an empty command line, MASTATE false and shortcuts active. It exercises the interaction and busy
rules over two connections, a tap sequence, the MA+STORE chord, command-line text (shortcuts disabled through
Lua, standing in for the operator's F10, and re-enabled afterwards) and a disconnect mid-sequence, verifying through
`CmdObj().cmdtext`, `lastcommand`, `MASTATE` and the shortcut enablement. See [docs/probes/README.md](../probes/README.md).
