# Console interaction modules

[README](../README.md) · [KEYBOARD.md](../KEYBOARD.md) · [bridge setup](setup/bridge.md)

The bridge plugin ships two reusable, instance-based Lua modules as extra components of
`gma3_mcp_bridge.xml`:

| Component | File | Purpose |
| --- | --- | --- |
| `gma3_mcp_hardkeys` | [plugin/gma3_mcp_hardkeys.lua](../plugin/gma3_mcp_hardkeys.lua) | Owned input sessions, leases, deadline servicing and recovery over a backend adapter; read-only logical-key resolution |
| `gma3_mcp_feedback` | [plugin/gma3_mcp_feedback.lua](../plugin/gma3_mcp_feedback.lua) | Read-only console state readers confirmed in KB-01, with freshness and bounded polling (KB-06); control-context readers and binding snapshots (KB-17) |

Module API version **1**; `gma3_mcp_hardkeys` **0.10.0** (KB-03 to KB-05; 0.5.0 resolves any `Enums.VirtualKeyCode` name, KB-07; 0.6.0 adds the per-key routing policy, KB-11; 0.7.0 adds the owned Quickey bank, KB-12; 0.8.0 adds the owned-Quickey backend, KB-13; 0.9.0 adds scoped shortcut-mode changes and text routes, KB-14; 0.10.0 adds the mixed backend and the unqualified-mix refusals, KB-15), `gma3_mcp_feedback` **0.3.0** (KB-02 + KB-06; 0.3.0 adds the control-context readers and `contextSnapshot()`, KB-17).
Four backend adapters dispatch: the **fake backend** (records events, simulates aggregate console key state,
nothing reaches a console key), the **keyboard backend** (`keyboardBackend(deps)`, KB-04: the console's
`Keyboard()` PC-key emulation; console keys are really pressed), the **owned-Quickey backend**
(`quickeyBackend(instance)`, KB-13: Quickey tuples pressed and released through the instance's KB-12 bank on its
reserved executors; console keys are really pressed) and the **mixed backend** (`mixedBackend({ quickey, keyboard })`,
KB-15: both of the above on one instance, each record released through the part that pressed it; console keys are
really pressed).

## Loading contract (what the console does and does not do)

Live probes on onPC 2.5.1.0 ([record](probes/kb-02-loading-macos-2.5.1.md)) established:

- `Import Plugin Library` stores every `ComponentLua` source **inside the show file**
  (`FullPath = <Showfile>`) and runs each component chunk once, in XML order, with the arguments
  `(pluginName, componentName, signalTable, handle)`. The same happens when the show is loaded.
- `Plugin "<name>"` calls the function returned by the **first** component only. A plugin whose first
  component returns a table runs nothing, silently. Other components' return values are discarded.
- `signalTable` is **one table per plugin instance, shared by all of its components**. Two plugins
  that ship the same component get two different tables.
- `require("name")` searches only loose files under the library folder (`datapools/plugins/?.lua`
  and the resource `lib_plugins`), never the show-embedded copy; `package.loaded` is **one cache for
  every plugin in the console** and keeps a stale module across delete/re-import. On a console
  without the loose file, `require` fails.
- `Get("FileContent")` on a component is **capped at about 1 KB**, so a loader that reads a sibling
  component's source cannot carry a real module. `Export(handle, name)` returned false for plugins
  and components.
- The component handle is invalid while the chunk runs and valid once `Main` is called, and
  `ReloadAllPlugins` did not re-run the chunks of idle, show-embedded plugins (global state and the
  bridge's state table survived it). `LoadShow` re-runs every chunk from the show file but keeps the Lua
  state and `_G`; after the loose files were deleted, a reload still produced fresh module copies.

So the modules use the signal table: each module chunk registers its read-only module table in
`signalTable.__gma3_mcp_modules[<module NAME>]` when the console runs it, and the plugin's entry
component looks it up when it starts. The registration is a plain Lua table write; it allocates no
show object, socket or timer and sends no input.

```lua
-- Helpers in the entry component. Call startModules() from Main, after all chunks ran.
-- The consumer owns `retained` = { records = {}, mode = nil, bank = nil }: the unresolved key records,
-- the pending keyboard-shortcut mode restoration (KB-14) and the Quickey bank record (KB-12) a
-- dispose() hands back. Keep it across stop/start and persist it across reloads if those can replace
-- the entry component's Lua state. Never recreate it on each start.
local function startModules(pluginName, signalTable, retained, now)
  assert(type(now) == "number", "supply the consumer clock in seconds")
  local reg = rawget(signalTable, "__gma3_mcp_modules") or {}
  local HK, FB = reg.gma3_mcp_hardkeys, reg.gma3_mcp_feedback
  assert(HK and HK.API_VERSION == 1 and HK.VERSION == "0.10.0", "wrong hardkeys module")
  assert(FB and FB.API_VERSION == 1 and FB.VERSION == "0.2.0", "wrong feedback module")
  local hardkeys = HK.new({ owner = pluginName, deps = HK.consoleDeps(_G) }):init()
  local feedback = FB.new({ owner = pluginName, deps = FB.consoleDeps(_G) }):init()
  local problems = {}
  -- The bank first: Quickey records release through it. A record that is not adopted stays retained.
  if retained.bank then
    local b, err = hardkeys:adoptBank(retained.bank, now) -- re-verified by readback; nothing is created
    if b then retained.bank = nil else problems[#problems + 1] = "bank: " .. tostring(err and err.message) end
  end
  local adopted = hardkeys:adopt(retained.records, now)   -- reserves old tuples; dispatches nothing
  retained.records = {}
  for _, item in ipairs(adopted.rejected) do retained.records[#retained.records + 1] = item.record; problems[#problems + 1] = "record: " .. tostring(item.reason) end
  if retained.mode then
    local m, err = hardkeys:adoptMode(retained.mode, now)   -- unresolved until recover() verifies and restores it
    if m then retained.mode = nil else problems[#problems + 1] = "mode: " .. tostring(err and err.message) end
  end
  -- Input is still disabled. Do not enable it while anything could not be adopted; report `problems`.
  return hardkeys, feedback, problems
end

local function stopModules(hardkeys, feedback, retained, now)
  assert(type(now) == "number", "cleanup needs the consumer clock in seconds")
  local result = hardkeys:dispose(now) -- attempts releases and the mode restore when they are due
  for _, record in ipairs(result.records) do retained.records[#retained.records + 1] = record end
  if result.mode then retained.mode = result.mode end -- a restoration still pending or unresolved: shortcuts may be changed
  if result.bank then retained.bank = result.bank end
  feedback:dispose()
  return result -- report unresolved releases and restoration; retain everything for the next start
end

-- Main assigns all three results:
-- hardkeys, feedback, problems = startModules(pluginName, signalTable, retained, now)
-- Each loop: hardkeys:service(now); feedback:service(now), using a fresh clock value.
-- Stop/Cleanup: stopModules(hardkeys, feedback, retained, now), then persist retained.
```

Calling `hardkeys:dispose()` without a numeric clock does **not** dispatch releases. Do not discard its
returned records, nor `result.mode` (a temporary shortcut-mode change the stop could not restore: without it the
operator's shortcuts stay changed with nothing to recover from) or `result.bank` (the owned Quickeys and reserved
executors; without it the next start cannot verify, use or tear them down). If cleanup raises, preserve the instance
and report the failure instead of dropping ownership state. Adopt retained state before admitting input; retain and
report anything that could not be adopted. The bridge does the same (`state.input.unresolved`, `state.input.mode`,
`state.input.bank`).
Release recovery is an explicit action through the originating backend (`attachBackend()` then `recover()`);
it does not replay presses and does not require enabling new input. The consumer must choose storage that
survives its own restart/reload lifecycle; a local table alone does not survive replacement of that Lua state.

The version checks above match the [vendoring pin](#vendoring-into-another-plugin-mtpnxk). Check file hashes
when packaging: version strings and `API_VERSION` alone do not identify a particular revision.

The bridge's own loader is `loadModule` in [plugin/gma3_mcp_bridge.lua](../plugin/gma3_mcp_bridge.lua);
it validates `API_VERSION`, reports a missing or broken component through the `modules` op and
`ping.modules`, and still starts the bridge.

## Rules for consumers

- One instance per consumer, created with `new({ owner = "<your plugin>", deps = ... })`. Instances
  hold their own ownership records and counters; the module tables are read-only (a write raises an
  error) so no mutable state can be parked on them.
- Never publish a module through `package.loaded`, `require` or a global. The registry key is scoped to
  the plugin's signal table; a second plugin vendoring the same files gets its own copies (verified
  live with a separate `kb02_consumer` plugin next to the bridge).
- Pass console functions through `opts.deps`. `consoleDeps(_G)` builds lazy closures and calls nothing;
  the modules never touch globals, so they run and are tested under stock Lua.
- Keep the entry component first in the XML and do your lookups in `Main`, not at chunk level.

## Instance API (both modules)

| Method | Effect |
| --- | --- |
| `init()` | `created → ready`. Touches no console state. |
| `status(now?)` | Read-only report: module, version, apiVersion, owner, state, counters. Performs no cleanup and calls nothing on the backend. |
| `service(now)` | Per-iteration hook; errors before `init()`. `now` is seconds (a number); the consumer supplies the clock. |
| `dispose(now?)` | `→ disposed`, idempotent; later calls other than `status()`/`dispose()` raise. |

`gma3_mcp_hardkeys` additionally offers `describeKey(name, opts)` (resolves `PLEASE`, `STORE`, `ESC`,
`CLEAR`, `OOPS`, `NUM0`–`NUM9`, `EXEC` with `opts.executor`, `MA` and, since 0.5.0, **any other
`Enums.VirtualKeyCode` name the console knows** (`EDIT`, `COPY`, `HIGHLIGHT`, …) through the shortcut table
under the same rules as `STORE`, for surface consumers whose keys go beyond the fixed list (KB-07); a name that
is neither is unsupported; a tie between rows of equal modifier count (they always target the same key, e.g. `Equal`
and `kpAdd` for `PLUS`) is refused unless the caller names the row with `opts.prefer` / `spec.prefer` (a PC key name),
in which case the chosen row passes the collision check and every later route recheck like any shortcut route;
`MA1`/`MA2` are reported
unsupported; the result carries `source` (`shortcut-table`, `fixed` for MA, `native` for PLEASE),
`shortcutsActive`, the current `profile` name, `pcKeyValidated` against `Enums.KeyboardCodes` and, for the
native route, `redirectChecked`) and `backendAvailable()`. The pure functions `resolve(rows, vkCodes, name,
opts)`, `parseShortcut(text)` and `tupleKey(t)` are exported for tests. Resolution prefers the row with the
fewest modifiers, treats several rows with the same shortcut text and target as one route, rejects different
shortcuts with equal modifier count as ambiguous, refuses a tuple that any other row maps to a different target
(another VirtualKeyCode, or the same EXEC key with another `ExecutorIndex`/`SpecialExec`; a row claiming `LeftShift`
or plain `Enter` collides with the fixed/native routes) and never substitutes another key.

## Owned input sessions (`gma3_mcp_hardkeys` 0.2.0, KB-03)

Every call that can change state takes `now` (seconds, number) from the consumer; the module never
reads a clock and never sleeps. Calls that fail return `nil, { code, message, ... }`, but an error does
**not** prove that nothing was dispatched. Pre-dispatch validation/admission refusals send no input;
a backend exception may occur after delivery, and a combo may fail after earlier keys were pressed.
Inspect `hold`, `unresolved`, `pressed` and `rollback` where supplied, and reconcile ownership/status.
A successful rollback releases keys; it does not undo their earlier effects. Never automatically replay
an uncertain press, tap, text chunk or sequence. Programming errors (wrong state, missing clock) raise;
an unexpected exception is not proof of non-delivery either.

| Method | Effect |
| --- | --- |
| `attachBackend(adapter)` | Attach a dispatching backend adapter **without** admitting presses, so `recover()`/`release()` can dispatch while input stays disabled. Refused while ownership records exist and the adapter would change. |
| `enableInput(adapter)` | Operator decision: `attachBackend()` plus admit presses. |
| `disableInput(now, reason)` | Stop admitting presses and attempt to release every held key. Failures stay as unresolved records; releases and `recover()` keep working while disabled. |
| `openSession({ id, leaseMs, label, binding }, now)` | Open a session under a consumer-chosen id (the bridge uses the connection id). Refused while the id is open or still owns unresolved holds. |
| `renewSession(id, now, leaseMs)` | Move the lease deadline; reactivates an expired session. A lease that ran out before `service()` noticed is expired first, so its holds keep their cleanup deadline. Never injects a press. |
| `closeSession(id, now, reason)` | Attempt to release the session's holds, newest first; report each outcome. A session with unresolved holds stays visible as `closed` until `recover()` clears them. |
| `press(session, now, spec)` | Admission compares `now` with the lease expiry itself (an overdue lease is `lease-expired` even if `service()` has not run). `spec = { key = "PLEASE" }` (logical, modifiers come from the mapping) or `{ pcKey = "Enter", shift, ctrl, alt, numlock }` (raw), plus optional `display` (validated to exist, never a routing promise), `executor` (for `EXEC`), `maxHoldMs` and `exclusive` (the intended long-press, below). Every resolved PC key is checked against the backend (`supportsKey`, `preflight`) before dispatch. |
| `tap(session, now, spec, holdMs)` | `press()` plus a release deadline (≤ `maxTapMs`) that `service()` honours. Cannot be layered on a hold. The response means press dispatched, release **scheduled** (`releaseOutcome = "scheduled"`); completion shows up later in `status()`. |
| `combo(session, now, specs, { holdMs })` | A combination: every key is resolved, admitted and preflighted before the first event; one failure dispatches nothing (`key` names the offender). Presses go out in order; a press failing midway releases what was pressed (newest first) and reports `pressed`/`rollback`. All holds share a `group`; `holdMs` schedules their release at one deadline, newest first. Never exclusive. |
| `release(session, now, { hold = id } \| spec)` | Release with the **stored** tuple. Releasing an already released hold is harmless; another session's hold is `not-owner`. |
| `releaseAll(session, now)` | Owner-scoped, newest first. |
| `recover(session \| nil, now)` | Re-attempt the release of unresolved holds (and any left in `releasing`); `nil` covers every session (the consumer decides who may call it that way). Without a backend attached the attempt is recorded as unresolved ("no backend attached") and the record stays reserved for a later recover. A record whose `backend` differs from the attached adapter is never dispatched (unresolved, "originates from backend ..."). |
| `adopt(records, now)` | Import the records a previous instance's `dispose()` returned, as unresolved holds of a closed `previous-run` session. Their tuples are reserved from then on (`conflict` for anyone else); releasing them is a separate `recover()`. Dispatches nothing. |
| `service(now)` | Expire leases, release due taps/max-hold/expired-lease holds (at most `maxWorkPerService` attempts per call, the rest next call), snapshot the backend's aggregate key state. Returns `{ released, unresolved, expired, work, pending }`. |

**Ownership records.** A hold stores the resolved PC key, the shift/ctrl/alt/numlock flags, the
display argument, the logical key and the route it was resolved by (shortcut text, row index,
executor, user profile name, shortcut enablement). The ownership identity is the *tuple* of PC key
plus modifier flags: display is not part of it (input is not display-scoped on 2.5.1), and neither is
the logical name, so `MA` and a raw `LeftShift`, or the same key on two displays, are one tuple. A
second press of a held tuple by its owner is a harmless duplicate (nothing injected); by another
session it is a `conflict`. Capacity (`maxHolds`, default 8) counts held and unresolved records.

**Release outcomes.** An attempt's `outcome` is `confirmed` (the backend observed the key up: fake backend with
`confirmMode = true`), `dispatched` (the call returned; nothing on this backend observes the single key: every
`Keyboard()` release) or `unresolved`. Hold reports carry `pressOutcome` and `releaseOutcome` (`scheduled`,
`pending`, `in-progress`, `dispatched`, `confirmed`, `unresolved`). Release always uses the stored tuple; nothing is ever re-resolved for cleanup.
Before each release the route is rechecked: a remap, a disabled shortcut table or a profile switch
during a hold marks the hold with `routeMismatch`, stops new interaction events for every session
(`route-changed`, reporting the original route and the mismatch) and makes an unconfirmable release
**unresolved** instead of released, because a call that returns without error is not evidence that
the key came up after the route changed (KB-01 macOS probes). A release the adapter refuses or that
raises is unresolved too. Unresolved records are kept, keep blocking their tuple, are not retried by
`service()`, and are cleared only by a successful `recover()`. The operator may restore the original
route; the module never restores mappings or toggles shortcuts itself.

**Shared console state.** `service()` records what the backend observes (`observed`, "not ownership").
Per-key state exists only on the fake backend; the keyboard backend reports `observed.available = false`
and the aggregate `observed.aggregate.maState`. A hold whose tuple the console no longer reports down is
annotated (`observed.down = false`, `observedReleasedAt`) and stays owned; for an MA hold this happens only
when MASTATE is false (no Shift key is down), because MASTATE true does not identify the source. The module
never re-presses to compensate. The owner's eventual release is still dispatched (harmless) and resolves the record.

**Adapter contract** (`fakeBackend()` and `keyboardBackend()` implement it):
`press(tuple) -> ok, confirmed, err` where `ok=false` means refused *before* anything was dispatched
(an adapter that cannot tell must raise, which keeps the record as unresolved); `release(tuple) -> ok,
confirmed, err` where `confirmed` is `true`, `false` or `nil` (not observable); optional `observe() ->
{ available, down = { [tupleKey] = true }, aggregate = { maState } }`, `supportsKey(pcKey) -> boolean, reason`
and `preflight(tuple, route) -> boolean, reason` (run for every key of a press or combo before the first event);
`name`, `dispatches`, `description`, `limitations`, `counters`. The fake adapter adds test controls:
`failNext(op, tuple, err, sticky)`, `clearFailures()`, `setConfirmMode(mode)`, `physicalPress/physicalRelease(tuple)`,
`isDown(tuple)`, `events`, `counters`; its `observe()` derives `aggregate.maState` from any Shift tuple it holds down.

## Keyboard backend (`gma3_mcp_hardkeys` 0.3.0, KB-04)

`keyboardBackend(deps)` wraps `Keyboard(display, 'press'|'release', <Enums.KeyboardCodes name>, shift, ctrl,
alt, numlock)`. It is deliberately small: it only dispatches validated events and observes; ownership stays in
the instance.

- **Validation before dispatch** (onPC accepts invalid arguments silently): `Keyboard` present, key name in
  `Enums.KeyboardCodes` (`deps.keyboardCodes`), display exists (`deps.displayExists`; the index is API context
  only, input is not display-scoped), and for routes verified by MASTATE (`MA`) a readable boolean
  `deps.maState`. `press()` refuses (`ok=false`) before sending; a `Keyboard()` call that raises is re-raised
  with the full argument list, so the record stays unresolved (delivery unknown).
- **Explicit modifiers** on every event: the tuple's `shift/ctrl/alt/numlock` travel on press and release
  alike. `Ctrl+F1` is one event with `ctrl=true`; no modifier key is pressed separately. The shift flag is
  a PC modifier, never MA.
- **Release = dispatched.** No per-key readback exists, so `release()` returns `confirmed = nil`. For MA
  (`LeftShift`) the instance schedules a bounded **readback** (`config.readbackMs`, default 1000 ms): on the
  following `service()` calls the aggregate MASTATE is compared with the expectation and the result is stored
  next to the dispatch (`dispatch.press.readback` / `dispatch.release.readback`, flattened as
  `pressReadback` / `releaseReadback` in reports): `observed` (value matched; worded as aggregate),
  `inconclusive` (window elapsed: "another Shift source may be held" after a release, "no observable effect"
  after a press) or `unavailable`. The hold's state never changes because of a readback.
- **Routes.** Shortcut-table keys need `KEYBOARDSHORTCUTSACTIVE` read as a positive boolean (an unreadable or nil
  value refuses the press and, during a hold, is a route mismatch that keeps the release unresolved; the same for
  an unreadable profile identity) and are revalidated before every press and release. `MA` is the fixed `LeftShift` route. `PLEASE` is the **native** `Enter` route (the system VirtualKey
  `PLEASE` redirects `Enter`; `deps.virtualKeyRedirects` reads `Root().VirtualKeys` when available): admitted with
  shortcuts disabled, rejected as ambiguous when a shortcut row maps plain `Enter` to another MA key or the
  redirect no longer names `Enter`. Enabling or disabling shortcuts and switching profiles are route changes
  for shortcut-table routes only.
- **Exclusive hold** (`spec.exclusive = true`, the intended long-press): while it is held, every new press,
  tap or combo from every session is refused with `exclusive-hold` (owner, hold, state, remaining time), including the
  owner's duplicate and an injected `F10`; releases stay allowed. The lock holds until the release is *resolved*: a
  refused or raised release leaves an unresolved exclusive record that still blocks everyone (the key may be down),
  and the flag travels through `dispose()`/`adopt()`. It is refused (`exclusive-refused`) while any other ownership
  record exists. Only one exists at a time; `status().exclusiveHold` names it.
- **Backend origin.** Every record stores `backend`; `dispose()` records and `adopt()` keep it; `recover()`
  never releases a record through another backend. The bridge's `input recover` attaches the records' own
  backend for cleanup only (`attachBackend`) when none is attached; enabling input stays a separate decision.
- **Limitations** are listed in `status().backend.limitations` and summarised in
  [KEYBOARD.md](../KEYBOARD.md#kb-04-results-keyboard-backend-macos-onpc-2510-2026-10-09): PC-keyboard emulation
  through operator-editable shortcuts, no display routing, aggregate MASTATE only, shared key state with the
  physical keyboard, remap/disable preventing the stored-tuple release, silent acceptance of invalid arguments,
  no double-press.

## Interactions, text and sequences (`gma3_mcp_hardkeys` 0.4.0, KB-05)

| Method | Effect |
| --- | --- |
| `beginInteraction(session, now, { leaseMs, label })` | A leased ownership token of the session (`i1`, `i2`, ...). Refused `busy` while another interaction is open, a sequence runs or any key is held (of any session), and while input is disabled. The session lease is extended to cover it. |
| `renewInteraction(session, id, now, leaseMs)` | Moves the deadline; an interaction whose lease lapsed is ended first and reported `no-interaction` (never resumed). |
| `endInteraction(session, id, now, reason)` | Aborts its sequence, releases its holds newest first, reports `released`/`unresolved`; harmless twice (`alreadyEnded`). Another session's id is `not-owner`. |
| `admission(now)` | Read-only busy descriptor or nil: `{ reason = "interaction" \| "sequence" \| "hold" \| "unresolved", owner, interaction, sequence, hold, remainingMs, count, description }`. The consumer refuses conflicting mutations with it; an unresolved record counts (the key may still be down) until `recover()` resolves it. |
| `startSequence(session, now, steps, { interaction \| leaseMs, label })` | Validates every step (`tap`, `press`, `release`, `combo`, `text`, `wait`; limits `maxSequenceSteps`, `maxSequenceMs`, `maxWaitMs`, `maxTextChars`) before the first event, begins an interaction for the sequence unless one is given (whose remaining lease must cover the estimate), starts the first step and returns the report. One sequence per instance. |
| `sequenceStatus(id, now)` | Read-only report of the running sequence or one of the last `sequenceHistory` finished ones: `state`, `index`, `counts`, `events` (flat, one per step), `cleanup`. |
| `abortSequence(session, id, now, reason)` | Owner abort: the in-flight step is `aborted`, the rest `unattempted`, the sequence's holds are released, an interaction begun for it is ended. |
| `service(now)` | Additionally expires interactions (`interactionsExpired`, their holds released) and advances the running sequence after the deadlines (`sequence` summary). |

**Admission** (`config.requireInteraction = true`, the bridge's policy): a standalone hold (`press`, `combo`
without `holdMs`) needs `spec.interaction` / `opts.interaction` naming an open interaction of its session
(`interaction-required`); while an interaction is open, every call of its session must carry its id (`busy`,
"pass its id") and every other session is `busy`; a running sequence refuses every other input; a key held by
another session, or an unresolved record of another session, is `busy` for everyone else. Exclusive-hold and route-changed refusals come first. With
`requireInteraction = false` (a single-caller consumer such as a surface plugin) the KB-03 per-session rules apply
unchanged; interactions and sequences still work and still lock the instance. Holds record their `interaction` and
`sequence`. `closeSession`, `_expireSession` and `disableInput` end the session's interactions and abort its
sequence first and release the holds themselves (so the outcomes are reported through that path); `dispose()`
aborts the sequence.

**Sequences** run inside `service()`: a step starts when the previous one is settled, a `tap`/chord waits until
its release is resolved (`completed` with the release outcome, or `uncertain` when it stayed unresolved), a `press`
is `completed` at once (its hold is released at the end of the sequence or by a `release` step), a `wait` elapses,
`text` goes out in chunks of `textCharsPerService`. Events end `completed`, `failed` (nothing of the step
dispatched, or a dispatch refused), `uncertain` (a press or char raised, a release unresolved; the console may have
received it), `unattempted` or `aborted`. A failure stops the sequence and releases what it pressed newest first
(`cleanup`); nothing is ever retried. Reports are flat (one level per event) so the bridge's JSON depth cap keeps
them whole.

**Text** (`validateText(text, maxChars)`, exported): UTF-8 by code point; empty text, invalid UTF-8 (byte position),
more than `maxTextChars`, and newline, carriage return, tab, other C0/C1 controls, DEL and U+2028/U+2029 are refused
(character index); nothing is normalised. Every text step needs `acknowledgeFocus = true` (the receiving element is
not observable) and is refused while an exclusive hold or a route mismatch exists; both are rechecked before every
chunk. Context `command-line` needs `deps.shortcutsActive()` to read `false` (positively) and `deps.commandText()` to be
readable at validation and before every chunk (unreadable: refused up front, `uncertain` mid-text), and reads `deps.commandText()` (`CmdObj().cmdtext`) before typing and back afterwards within
`readbackMs`: `observed` completes the step, `inconclusive` leaves it `uncertain` and stops the sequence (no later
commit of unverified text); `text-field` has readback `unavailable` and may not be followed by a PLEASE/Enter step
in the same sequence. A text step stopped after characters went out is `uncertain`, not `failed`.
A character whose `char()` call refuses is `failed`, one that raises is `uncertain` at that character. The adapter
contract gains `char(codepoint, display) -> ok, confirmed, err` (same outcome rules as `press`): the fake backend
appends to `typed` (`typedText()`, `setTypedText()`, `failNext("char", { codepoint })`, `raiseNext("char")`), the
keyboard backend sends `Keyboard(display, 'char', <one code point as UTF-8>)` (KB-01: one Unicode character per
call reaches the focused editor or, with shortcuts disabled, the command line). `raiseNext("press"|"release")` makes
the fake backend raise once (delivery unknown).

**Limits of recovery.** Deadlines are serviced only while the plugin loop runs. A host call that
blocks the plugin thread, a plugin crash or process termination prevents release; lease expiry is a
cleanup *attempt*, not a guaranteed cancellation of a held key or of a blocked host call.

## Routing policy (`gma3_mcp_hardkeys` 0.6.0, KB-11)

A consumer chooses how its logical keys are dispatched: one default **method** and per-key overrides. The
method is decided and validated before dispatch, stored on the hold and kept for the whole press/release cycle;
an unavailable or refused route never selects another method or backend, and a policy or mode change during a
hold never changes the route its release uses. Callers that configure nothing keep the pre-0.6.0 behaviour
(method `shortcut`).

| Method | Behaviour in 0.6.0 |
| --- | --- |
| `quickkey` | Press/release the Quickey tuple `{ quickkey = <name>, quickkeyCode = <value> }` (`tupleKey = "quickkey:#<value>"`: ownership is the validated code value, so aliases such as `OOPS`/`UNDO` are one tuple; the requested name is kept for reporting). Needs an adapter advertising `capabilities.quickkey = { tap, hold, chord }`, and each flag is enforced per operation before dispatch on every path (a tap needs `tap`, a hold needs `hold`, a combo or a press next to another live Quickey needs `chord`; refusals are `unsupported` with `reason = "capability"` and `missing[]`); the fake backend simulates it, the `Keyboard()` backend refuses it, the owned-Quickey backend (`quickeyBackend()`, KB-13, 0.8.0) dispatches it with per-code flags from the KB-10 evidence. `MA1` is a valid code here. |
| `shortcut` | The shortcut-table / fixed (`MA`) / native (`PLEASE`) PC-key route as before. A shortcut-table route while shortcuts are off temporarily enables them for the hold on a backend with `capabilities.modeChange` (0.9.0, KB-14, below); otherwise it is refused as before and lists the requirement; nothing is toggled. |
| `shortcutOrType` | Fixed/native routes whatever the mode. Otherwise the shortcut route only when enablement reads `true` and resolution succeeds; the key's explicit `text` when the table was read and has no row for the key (shortcuts temporarily disabled for the insertion), or when enablement reads `false` (no row, no mode change). Unreadable enablement, ambiguity, collisions, unknown keys and a missing `text` are refusals, never permission to type. The text branch needs `capabilities.char` (and `modeChange` when shortcuts are on). |
| `type` | The key's explicit `text`, inserted once on press, with shortcuts temporarily disabled when they are on (0.9.0, KB-14). Needs `capabilities.char` and `capabilities.modeChange` (with `deps.setShortcutsActive`); otherwise `policy-unavailable` at `enableInput()`/`configureRouting()`. |

```lua
local inst = HK.new({ owner = "surface", deps = HK.consoleDeps(_G), config = { requireInteraction = false },
  routing = { default = "quickkey",
              keys = { STORE = { method = "shortcut" },             -- per-key override
                       UNDO  = { quickkey = "OOPS" },               -- code distinct from the key name
                       PLUS  = { method = "shortcut", prefer = "kpAdd" },
                       NUM5  = { method = "shortcutOrType", text = "5" },
                       THRU  = { method = "shortcutOrType", text = "Thru " } } } }):init()
local r, err = inst:enableInput(backend)         -- policy-unavailable if the adapter cannot serve a named method
local d = inst:describeRoute("THRU")             -- method, methodSource, effective, dispatchable, unavailable[], capabilities
r, err = inst:configureRouting({ default = "shortcut" })   -- atomic; live holds keep their route
```

| Call | Effect |
| --- | --- |
| `new({ routing })` / `configureRouting(policy)` | `policy = { default = <method>\|nil, keys = { <LOGICAL> = { method, quickkey, prefer, text } } }`. Validation (`policy-invalid`): unknown methods or fields, duplicate names (case-insensitive), `text` empty or with control characters, a digit (`NUM0`–`NUM9`) text that is not exactly one non-space character, and any `text` for `MA`/`MA1`/`MA2`, `PLEASE`, `CLEAR`, `OOPS`/`UNDO`, `ESC`, `EXEC`/`EXECUTOR`/`XKEYS`/`FADER`, `X1`–`X16`, `ENCODER_*`, `DEF_*`. Keyword text is inserted exactly as given, separators included. While a backend is attached, a method it cannot serve is `policy-unavailable`. A refused policy changes nothing; `new()` raises. |
| `describeRoute(name, { prefer, executor })` | Read-only: `key`, `method`, `methodSource` (`key`, `default`, `module-default`), `effective` (`quickkey`, `shortcut-table`, `fixed`, `native`, `text`), `supported`, `code`, `reason`, `dispatchable`, `unavailable[]` (named requirements, e.g. "no backend attached", a missing `char`/`modeChange` capability), `modeChange` (`{ target, reason }` when the route needs a temporary shortcut-mode change), `capabilities` of the attached adapter, `resolution` (the `describeKey()` result), `quickkey`/`codeValue`, `text`. |
| `routingReport()` / `status().routing` | `default`, `defaultSource`, `keys` (effective method and fields per override), `overrideCount`, `methods[<m>] = { available, missing[] }` for the attached backend, `capabilities`. |
| `enableInput(adapter)` | Additionally checks every method the policy names against the adapter (`policy-unavailable`, nothing attaches). `attachBackend()` (cleanup-only) does not. |

Adapters advertise `capabilities = { keyboard = bool, quickkey = { tap, hold, chord } \| false, char = bool, modeChange = bool }`;
an adapter without the field is a PC-key adapter (`keyboard = true`, `modeChange = false`). Holds report `method` and, for Quickey
tuples, `quickkey`; `route.routing` is the stored decision a Quickey hold's route recheck uses (never the current
policy). Press-time refusals: `unsupported` (with `reason` = the resolution code: `unknown-key`, `no-row`,
`ambiguous`, `collision`, `unreadable`, `no-mapping`, `shortcuts-inactive`, …) and `unavailable` (the route is
selected but a named requirement is missing; `effective` and `unavailable[]` are attached). Neither dispatches
anything, and a refused press is never queued for a later mode or table change. Regressions:
`test/lua/hardkeys_routing_test.lua`.

## Scoped shortcut-mode changes and text routes (`gma3_mcp_hardkeys` 0.9.0, KB-14)

The `type` route, the text side of `shortcutOrType` and a `shortcut` route whose table is off run through one bounded
**mode operation** per instance (`status().modeChange`; `lastModeChange` after it ended): the active profile and the
shortcut state are captured (refused `unreadable` if either cannot be read), the state is written through
`deps.setShortcutsActive` only when it differs from what the route needs, verified by readback (`mode-change-failed`
when the console did not apply it: nothing dispatched; a write that raises or cannot be read back leaves the
restoration **unresolved**), kept for every record that depends on it, and restored by `service()` once no dependent
is held/releasing/unresolved and `config.modeRestoreDelayMs` (60 ms) passed since the last dependent event. The timing
probe ([kb-14-timing](probes/kb-14-timing-macos-2.5.1.md)) is the reason it is never restored in the call that
dispatched a key: a modifier may be consumed on the next frame, and a release in the other mode does not lift it.

| Element | Behaviour |
| --- | --- |
| Interference | Before each restore the profile and the state are re-read. A changed profile or an unreadable state → the restoration is `unresolved` (`busy` reason `restoration`; dependents `quarantined`; every new press, KB-05 text step and the bridge's guarded ops are refused) until `recover(sessionId)` by the owner or `recover(nil)` by the operator re-reads it on the original profile and restores it; a replacement profile is never written. A state somebody set back already → resolved as `restoredBy = "operator"` with `interference` recorded, nothing written. The operator disabling shortcuts during a temporarily enabled hold is additionally the KB-04 route change on that hold. |
| Text records | `kind = "text"`, `tupleKey = "text:<KEY>"`, `route.source = "text"`, `text = { text, chars, typed, outcome (typed\|partial\|uncertain), code, error, readback, focus }`. Inserted on press in chunks of `textCharsPerService` with the mode, the profile, exclusivity and routes rechecked between chunks; partial progress is reported and nothing is replayed. `releaseOutcome = "none"`; `release()` is harmless. Needs no interaction; refuses combos, `exclusive`, and any other instance-owned record (consecutive text records of the same operation excepted). Native/fixed routes never become text. |
| Record states | `retained`: the key is up (or the text is in), the restoration is pending; not counted as live for capacity, busy or exclusivity. `quarantined`: retained while the restoration is unresolved. Both become `released` when the operation is restored. |
| Sequences | A step that needs the operator's own mode (a text step) or the opposite temporary mode waits for the pending restoration (bounded by the sequence deadline); a step needing the same mode joins it. A text-route step whose insertion was partial or uncertain ends the sequence (`uncertain`, later steps unattempted, `event.text` carries the progress). |
| `dispose()` / `adoptMode(record, now)` | `dispose()` restores only when no dependent is held/releasing/unresolved and the restore delay elapsed since the last dependent event; otherwise (`pending = dependents` or `delay`, a changed profile, a failed write) it hands the restoration back as `result.mode`. `adoptMode()` makes it an unresolved restoration of session `previous-run`; `recover(nil)` restores it once the instance owns no held or unresolved record (adopted stuck keys first); a release made in that recover call is the last dependent event, so the operation goes back to `active` and `service()` restores it after the delay, never in the recover call. The bridge's stop path services the delay on the loop before disposing. |
| Capabilities | `capabilities.modeChange`: the keyboard backend advertises it only when `deps.setShortcutsActive` exists; the fake backend simulates it; the owned-Quickey backend never has it. `consoleDeps(_G)` provides the write (`CurrentProfile().KeyboardShortCuts:Set("KeyboardShortcutsActive", v)`). |

Bridge 0.11.0: `input.routing` (`{ policy }` replaces the attached backend's policy, refused `[busy]` while another
connection owns input; without a policy it reports `routingReport()`), `input.route` (`{ key, prefer, executor }` →
`describeRoute()`), `prefer` on press specs, `ping.input.modeChange` / `retained` / `quarantined`, `[busy]` reason
`restoration` on the guarded ops, and an unresolved restoration kept in `state.input.mode` across a restart and adopted
at the next start (`input recover` restores it). Regressions: `test/lua/hardkeys_mode_test.lua`, the KB-14 section of
`test/lua/bridge_plugin_test.lua`; live: `node scripts/kb14-probe.mjs timing|run`
([records](probes/kb-14-run-macos-2.5.1.md)).

## Quickey bank (`gma3_mcp_hardkeys` 0.7.0, KB-12)

The Quickey backend of KB-13 needs one owned Quickey per command-area hardkey code and, because a Quickey addressed
directly is always a tap (KB-10), a reserved executor per concurrently held key. The module provisions, verifies and
removes both so no surface writes its own allocator. It never creates, changes or deletes a show object unless the call
carries `authorized = true` (the consumer's explicit operator decision), and it never touches an object it cannot prove
it owns: ownership is the marker written into the Quickey's Note plus the matching `Code` and `Name`, re-read before every
mutation and before every dispatch. Nothing is repaired; a mismatch is reported and refused.

```lua
local inst = HK.new({ owner = "gma3_mcp_bridge", deps = HK.consoleDeps(_G) }):init()
local bank, err = inst:provisionBank({ authorized = true, quickeys = { first = 900 },
                                       executors = { page = 1, first = 190, count = 8 },   -- count >= config.maxHolds
                                       codes = "hardkeys" }, now)                          -- | "qualified" | { "NUM5", ... }
local t = inst:bankTarget("NUM5", now)      -- re-reads Quickey 9xx: { index, value, qualified = { tap, hold, chord }, executors }
local v = inst:verifyBank(now)              -- re-reads everything: state ready | degraded, problems[]
local td = inst:teardownBank(now, { authorized = true })   -- refused while Quickey records are live
local rec = inst:dispose(now).bank          -- keep it; inst2:adoptBank(rec, now) re-verifies, creates nothing
```

| Call | Effect |
| --- | --- |
| `provisionBank(spec, now)` | Validates the spec (`bank-invalid`; `bank-unauthorized` before anything is read), discovers the codes from `Enums.VirtualKeyCode` (one per distinct value, ordered by value, slot = `first` + rank; aliases such as `UNDO` folded onto `OOPS` and reported; value-0 placeholders, `X1`–`X16`, `XKEYS`, `EXEC`, `FADER`, `DEF_*`, `ENCODER_*`, `ONPC_SCREEN*` and the executor button functions excluded with reasons) plus one code-less **placeholder** `MCP RESERVED` in the slot after the codes, preflights every slot and executor without writing, then creates what is missing (each slot re-read right before `create`, Note (marker) → Code → Name written and verified by readback) and **reserves** every empty executor by assigning the placeholder to it (re-read right before, verified after), so the claim is visible to any other consumer. Refusals: `bank-preflight` with `refusals[]` (`slot-occupied`, `bank-foreign-owner`, `bank-mismatch`, `executor-occupied`, `executor-foreign-owner`, `executor-missing`, `unreadable`) and nothing created; `bank-partial` with `removed[]`/`kept[]`/`cleared[]` after a rollback that clears only reservations this call made and deletes only objects it created that still read back as written; `bank-exists`. An existing bank of the same owner and ranges is reused after verification (`reused` count; a reserved executor that reads empty is re-reserved). |
| `bankTarget(code, now)` / `bankExecutor(index, now)` | Dispatch-time revalidation: the **show identity is re-read first** (a mismatch marks the bank `stale` and refuses `bank-stale`), then the one Quickey / executor by readback: `code-not-in-bank`, `bank-object-missing`, `bank-object-changed`, `bank-executor-unreserved|occupied|foreign|missing|unreadable`. Executor ownership is the assigned Quickey's pool index, marker and Code against the bank's entry (a same-named Quickey is `occupied`). Aliases resolve to the canonical entry (`alias` reported). The result carries `qualified` (`{ tap, hold, chord, note }` from KB-10, or `false` = discovered only: a backend must not advertise it). |
| `verifyBank(now)` | Re-reads the show identity, then every object; `state` `ready` or `degraded`, `problems[]` (`kind` = `quickey` / `executor` / `show`, `state` = `missing` / `changed` / `replaced` / `unreserved` / `occupied` / `foreign` / `unreadable`). On another show the bank stays `stale`, no object is inspected and dispatch stays refused. |
| `service(now)` | Every `config.bankCheckMs` (2000 ms) re-reads only the show identity; a change marks the bank `stale` (cached reads dropped, dispatch refused until `verifyBank()`). |
| `teardownBank(now, { authorized = true })` | Separate from release-all: `bank-in-use` while any Quickey ownership record is held or unresolved; `bank-stale` on another show. Clears only executors holding a verified bank Quickey (placeholder or code), deletes only Quickeys that still verify, `skipped[]` for changed/replaced objects and look-alikes (left alone), `complete` or a `partial` bank for the rest. |
| `adoptBank(record, now)` / `dispose().bank` | The record is the consumer's to keep across a restart (the bridge keeps it beside the unresolved records); adoption re-verifies everything and creates nothing; another owner's record is `bank-foreign-owner`; a complete record without the placeholder entry or a show identity is refused; on another show the adopted bank is `stale`. The record of a **partially torn-down** bank (`partial = true`, placeholder gone) is adopted for cleanup only: `bankTarget`/`bankExecutor` refuse `bank-partial`, `teardownBank` finishes once the operator restores or removes the skipped objects. |
| `bankStatus(now)` / `status().bank` | Read-only: `id`, `state` (`ready`, `degraded`, `stale`, `partial`), `codes[]` with `index`/`value`/`qualified`/`state`/`problem`, `executors[]`, `exclusions[]`, `aliases[]`, `counters`, `record`. |

Console deps (`consoleDeps(_G)`): `showIdentity()` = show name plus data pool name; `quickeys.read/create/set/delete`
over `ObjectList("Quickey N")` and `Store`/`Delete Quickey N /NoConfirmation`; `executors.read/assign/clear` over
`ObjectList("Page P.N")` (the assigned object's pool index, Note and Code are read), `Assign Quickey N At Page P.N` and
`Delete Page P.N /NoConfirmation`. Every write is verified by a readback, never by the
command's return text. On 2.5.1 an empty executor has no object under `Page P.N` (the deps report `empty` when the page
exists), and the show identity is `Root().MANetSocket:Get("ShowFile")` plus the data pool name. Qualified live on the
disposable show ([record](probes/kb-12-bank-macos-2.5.1.md)); regressions: `test/lua/hardkeys_bank_test.lua`.

## Owned-Quickey backend (`gma3_mcp_hardkeys` 0.8.0, KB-13)

`quickeyBackend(instance)` is the console adapter for Quickey tuples, bound to the instance that owns the bank. A Quickey
addressed directly is always a complete tap (KB-10), so every tap, hold and key of a chord is an **executor press**: right
before the press the code's Quickey is re-read through `bankTarget()`, a free reserved executor is re-read through
`bankExecutor()`, the Quickey is assigned to it when another one is there (`Assign Quickey N At Page P.E`, verified by
readback) and `Press Page P.E` is issued; the release issues `Unpress Page P.E` on the **recorded** executor only, and only
while it still holds the recorded Quickey. The target travels with the hold record (`hold.target`, `dispose()` records,
`adopt()`), so a record of a previous run is released through the same executor and reserves it meanwhile. Nothing is ever
re-resolved for a release, a direct `Unpress Quickey` is never issued (it re-activates non-latching keys), and nothing is
repaired.

```lua
local inst = HK.new({ owner = "gma3_mcp_bridge", deps = HK.consoleDeps(_G) }):init()
inst:provisionBank({ authorized = true, quickeys = { first = 900 }, executors = { page = 1, first = 180, count = 8 } }, now)
local qk = HK.quickeyBackend(inst)
inst:enableInput(qk, { routing = { default = "quickkey" } })   -- the policy is applied with the backend (no PC keys here)
inst:tap("s", now, { key = "NUM5" }, 50)        -- Assign Quickey 949 At Page 1.180 (if needed), Press Page 1.180; Unpress at the deadline
inst:press("s", now, { key = "MA1" })           -- held on the next free reserved executor; release(...) issues Unpress there
inst:describeRoute("ESC")                       -- dispatchable = false, unavailable = { "... discovered only ..." }
```

| Element | Behaviour |
| --- | --- |
| Capabilities | `capabilities = { keyboard = false, quickkey = { tap, hold, chord }, char = false }`; per code `quickkeyCapabilities(code)` = the KB-10 evidence (`tap` is granted whenever `hold` is, because a tap here is an executor press/release pair; MA1 taps, OOPS does not hold, NUM1/THRU/FIXTURE/PLEASE/CLEAR do not chord), all `false` for a discovered-only code. `describeRoute()` reports them (`quickkeyCapabilitySource = "code"`) and the press/combo/sequence checks refuse before dispatch (`unsupported`, `reason = "capability"`). A chord needs `chord` on **every** participating key: a press next to a live Quickey record, or a sequence step next to a tuple an earlier step leaves down, is refused when any key already down lacks it (`heldKey` names it; the hold's stored flags decide). |
| Admission | `supportsQuickkey(code)` refuses codes outside the bank and the discovered-only codes; `unavailable(code)` lists "no Quickey bank", "partial bank", "not in bank", "discovered only" and missing deps for `describeRoute()`/`unavailable`; `supportsKey()` refuses every PC key; the `shortcut`, `shortcutOrType` and `type` methods are `policy-unavailable` on this backend. |
| `preflight(tuple, route, { kind, combo, extra })` | Qualified code, `bankTarget()` readback, and enough free reserved executors that verify now for this key and the `extra` keys planned with it (a combo never starts without a place for every key). Nothing is sent. |
| `press(tuple)` | `bankTarget()`, the first free executor whose `bankExecutor()` verifies (held, unreserved, foreign and occupied ones are skipped with reasons), `Assign` + readback when needed, `Press Page P.E`. Returns `true, nil, nil, target` (dispatched; never confirmed), `false, nil, err` before anything reached the console, or raises `{ message, target }` when the Press raised (delivery unknown; the record keeps its target). A console feedback other than `OK` (e.g. `Object not found`) is "not accepted", nothing pressed. |
| `release(tuple, target)` | Refuses without a target, with another bank id or page, when the bank's entry for the code is not at the recorded index, when `bankExecutor()` does not verify (show gate, unreserved, foreign, occupied, missing) or holds another bank code; otherwise `Unpress Page P.E` (`dispatched`). A refusal leaves the record unresolved for the operator (restore the assignment) and `recover()`. |
| `observe()` | `available = false` (no per-key state), `aggregate.maState`, `executors = { total, inUse }`. |
| Instance hooks (0.8.0) | `enableInput(adapter, { routing })` validates and applies a policy together with the backend; `_route()` takes `quickkeyCapabilities()`/`unavailable()` from the adapter; `preflight` receives the operation context; `hold.target`, `dispose().records[].target`, `adopt()` keeps it; `_executorsInUse()` is derived from the live records. |

Console deps (`consoleDeps(_G)`): `executors.press(page, index)` / `unpress(page, index)` issue `Press Page P.E` /
`Unpress Page P.E` and return `true, feedback` for an `OK` feedback, `false, feedback` otherwise (the paged form was confirmed
live: it holds MA1 exactly like the KB-10 `Press Executor E`; `Unpress` on an empty executor answers `Object not found`).
Bridge: `Plugin "gma3_mcp_bridge" "input=quickey"` (bank first or in the same argument). Qualified live on the disposable
show ([record](probes/kb-13-quickey-macos-2.5.1.md), 47/47); regressions: `test/lua/hardkeys_quickey_test.lua`.

## Mixed backend (`gma3_mcp_hardkeys` 0.10.0, KB-15)

A surface that defaults to `quickkey` dispatches only the codes with KB-10 evidence; KB-15 asks for per-key overrides
that are not inert. `mixedBackend({ quickey = <adapter>, keyboard = <adapter> })` serves both console mechanisms on one
instance: Quickey tuples go to the Quickey part, PC-key tuples and character events to the Keyboard() part. It owns
nothing and keeps no state; the rules below live in the instance and hold on every adapter that advertises both kinds
(the fake included).

```lua
local inst = HK.new({ owner = "surface", deps = HK.consoleDeps(_G), config = { requireInteraction = false } }):init()
inst:provisionBank({ authorized = true, quickeys = { first = 900 }, executors = { page = 1, first = 180, count = 8 } }, now)
local mixed = HK.mixedBackend({ quickey = HK.quickeyBackend(inst), keyboard = HK.keyboardBackend(HK.consoleDeps(_G)) })
inst:enableInput(mixed, { routing = { default = "quickkey",
  keys = { NUM0 = { method = "shortcut" },                 -- no KB-10 evidence yet: the shortcut row through Keyboard()
           THRU = { method = "type", text = "Thru " } } } }) -- literal text, shortcuts temporarily off while it is typed
inst:openSession({ id = "s", leaseMs = 2000 }, now)
local r5, r0 = inst:describeRoute("NUM5"), inst:describeRoute("NUM0")
-- r5.dispatchBackend == "quickey", r0.dispatchBackend == "keyboard" (THRU too)
local esc = inst:describeRoute("ESC")      -- esc.dispatchable == false, "discovered only": NOT re-routed to Keyboard()
-- One kind at a time: a tap is released by service(), so the second tap is refused (unqualified-mix) while
-- the first is still down. Either service() between them, or let a sequence order them:
local seq = inst:startSequence("s", now, {
  { kind = "tap", key = "NUM5", holdMs = 50 },  -- Assign/Press/Unpress Page P.E; hold.backend = "quickey"
  { kind = "tap", key = "NUM0", holdMs = 50 },  -- Keyboard() press/release; hold.backend = "keyboard"
})
-- each loop iteration: inst:service(now) runs the steps; inst:sequenceStatus(seq.id, now).state ends "completed"
```

| Element | Behaviour |
| --- | --- |
| Construction | Both parts must be adapters; the Quickey part must advertise `capabilities.quickkey`, the keyboard part `capabilities.keyboard`; a part cannot itself be mixed. `capabilities = { keyboard, char, modeChange }` from the keyboard part, `quickkey` from the Quickey part; `limitations` = the mixed rules plus both parts' (prefixed); `counters = { quickey, keyboard }`. |
| Dispatch | `supportsKey` → keyboard part; `supportsQuickkey` / `quickkeyCapabilities` / `unavailable` → Quickey part; `preflight`, `press`, `release(tuple, target)` → the part the tuple selects; `char` → keyboard part; `observe()` → the keyboard part's view plus the Quickey part's under `.quickey`. |
| Records | `recordBackend(tuple)` names the part, so `hold.backend` is `"quickey"` or `"keyboard"` (never `"mixed"`); `serves(name)` accepts either part's records for release, `recover()` and `adopt()`; a record of a backend that is not a part stays unresolved naming its origin. `describeRoute()` adds `dispatchBackend`. |
| No fallback | An unavailable Quickey route (no bank, partial bank, not in bank, discovered-only code) is refused naming the requirement; the keyboard part is never tried for it. A policy naming `type` against a keyboard part without `modeChange` is `policy-unavailable` at `enableInput()`/`configureRouting()`. |
| `unqualified-mix` | Refused before dispatch, on every backend: a PC key while a Quickey record is held/releasing/unresolved and the reverse (`reason = "held"`, `heldKind`, `hold`); a combo mixing the kinds (`reason = "combo"`, `key`); a sequence step putting one kind down next to the other, from live records or earlier steps (`step`); a Quickey while a temporary shortcut-mode change is active or pending restoration (`reason = "mode"`; a sequence step waits for the restoration, `waitingFor`); a route needing a mode change while a Quickey is down (nothing written). Evidence: disabling shortcuts drops a Keyboard()-held MA (KB-14); the effect on an executor-held Quickey and a chord across the mechanisms were never dispatched. |

Bridge 0.12.0: `Plugin "gma3_mcp_bridge" "input=mixed"` (bank first or in the same argument) attaches the mixed adapter
over the same cached Quickey and keyboard adapters, routing default `quickkey`; `input.routing` accepts the overrides,
`input.route` reports `dispatchBackend`, `input recover` attaches the mixed adapter for cleanup when kept records of both
parts exist. Regressions: `test/lua/hardkeys_mixed_test.lua`, the KB-15 section of `test/lua/bridge_plugin_test.lua`.
Not run on the console: the mixed backend has no live record yet, and the surface half of KB-15 (defaults, startup
report, vendoring, NX-K qualification) is done in mtpnxk.

## Feedback readers (`gma3_mcp_feedback` 0.2.0, KB-06)

Every observation is `{ name, key, scope, source, params?, available, value?, reason? | error?, observedAt, epoch,
note? }`. `available = false` carries `reason` (the console gave nothing usable: nil, an unrecognised value such as
`"Maybe"` for a FADERENABLED property, a missing display/sequence/executor, an unimplemented reader) or `error` (the
reader raised); `value` is then absent. A `false` value is always `available = true`. A reader never substitutes a
default, and one failing reader never affects another. `observedAt` is the consumer's clock at that single read.

| Reader | Scope | Source | Parameters / meaning |
| --- | --- | --- | --- |
| `commandText` | ui | `CmdObj().cmdtext` | raw text of the plugin user's command line; no keyword inferred |
| `lastCommand` | ui | `CmdObj().lastcommand` | shared command history; an observation, not confirmation of a request |
| `blind`, `highlight`, `solo` | show | `ShowData.Masters.Grand.<mode>.FADERENABLED` | strict boolean |
| `previewMode` | profile | `CurrentProfile().Environments.ACTIVEENVIRONMENT` | environment name |
| `previewBar` | display | `GetDisplayByIndex(display).PREVIEWBARACTIVE` | `params.display` (default `config.defaultDisplay` = 1, validated, identified in `params`/`key`); a missing display is unavailable; no routing promise |
| `shortcutsActive` | profile | `KEYBOARDSHORTCUTSACTIVE` | strict boolean |
| `maState` | console | `Root().MASTATE` | aggregate of every Shift source; not ownership |
| `page` | user | `CurrentExecPage()` | `{name, no}` |
| `selectedSequence` | user | `SelectedSequence()` | `{selected = false}` when none; otherwise `{selected = true, name, class, addr, no}` |
| `sequenceActive` | show | `Sequence:HasActivePlayback()` | `params.sequence`; playback activity, not an executor button |
| `executor` | page | `GetExecutor(n).Object` | `params.executor`; `{executor, empty, assigned?, page}` (assignment only) |
| `fader` | show | `<object>:GetFader({token})` | `params.executor` or `params.sequence`, `params.token` (default `FaderMaster`); `{value, text, token, target}` |
| `freeze` | show | — | always unavailable: KB-01 found no readable state |

`executorActive` is kept as a compatibility alias of `sequenceActive` (the result says `alias` and carries a
deprecation note). Assignment, level, activity, selection and button ownership are never merged: ownership is the
hardkeys instance's record, not console state.

| Method | Effect |
| --- | --- |
| `read(name, params?, now?)` | One observation; unknown readers are unavailable, never an error. |
| `readMany(items, now)` | `items = { {name, params}, ... }` read one after another (`atomic = false`), at most `config.maxItems` (default 64; the rest is `truncated`). The reply carries `epoch`, `identity` and `invalidated` when the identity check (below) bumped the epoch. |
| `readAll(now?)` | Every parameterless reader keyed by name, `previewBar` on the default display. |
| `itemsFor(spec, config?)` (module function) | Expands `{ all?, items?, readers?, display?, displays?, executors?, sequences?, tokens? }` into items, `previewBar` once per display, each executor into `executor` + one `fader` per token, each sequence into `sequenceActive`; bounded by `config.maxExecutors` (default 32); returns the items and a limitations list (a parameterised reader named in `readers` is a limitation, never guessed). Shared by the bridge op and surface consumers. |
| `watch(items, now)` / `unwatch()` | Subscribe a bounded item list (`maxItems`) for `service()`; replacing the list drops observations of items no longer watched. |
| `service(now)` | Identity check at most every `config.identityCheckMs` (1000), then at most `config.maxReadsPerService` (8) watched items whose observation is older than `config.pollIntervalMs` (100), round robin from where the last call stopped, so feedback never delays the consumer's input deadlines by more than that. Returns `{ reads, due, watched, invalidated }`. |
| `snapshot(now)` | The watched observations as last read with `ageMs` and `stale` (`ageMs > config.staleMs`, default 2000); items not observed since the current epoch are listed in `notObserved` with the reason. Reads nothing. |
| `invalidate(reason, now)` | Drops every cached observation and starts a new epoch (the consumer calls it on disconnect, restart or anything after which old values must not be presented as current). |
| `describe()` | Reader list with scope, source, parameters, notes and the alias. |

**Identity and epochs.** The instance observes `deps.showFile()`, `deps.userName()` and `deps.profileName()`;
a change of any readable one invalidates with `show-changed`, `user-changed` or `profile-changed`. A value that was never
readable is reported as nil and is not a change. A value that was readable and becomes unreadable keeps its **last known**
value, marks the identity uncertain (`identityUncertain` in `status()`, `readMany()` and `snapshot()`) and invalidates
once (`identity-unreadable`); while uncertain every snapshot item is `stale`, and once readable again the new value is
compared with the last known one, so an A → unreadable → B transition still invalidates as `show-changed`. A malformed
item (`params` not a table, a wrong parameter type) is reported unavailable with the error under the key
`<name>[invalid-params]` and never aborts a `readMany()` batch or a `watch()` list; an executor whose `Object` read raises
is unavailable with the error, never reported empty. `status()` reports `epoch`, `lastInvalidation`,
`identity`, `watched`, `cached` and the config. The bridge creates a fresh instance (epoch 1) at every start and exposes
`readMany` through `feedback.read` ([reference](reference.md#console-feedback-plugin-v080-kb-06)); the cached
`watch()`/`snapshot()` path is for surface consumers that poll between input deadlines. Multiple reads are never an
atomic snapshot against other console activity.

## Control context and binding snapshots (`gma3_mcp_feedback` 0.3.0, KB-17)

Five readers describe what a surface control would operate, each through the read paths KB-16 qualified live
([record](probes/kb-16-encoders-macos-2.5.1.md)); they are **not** part of `readAll()`/`all` (each costs several
console reads) and are requested explicitly, through `contextSnapshot()`, or watched for `service()` polling.

| Reader | Scope | Value |
| --- | --- | --- |
| `dataPool` | user | `{name, no}` of `DataPool()` |
| `encoderBank` | display | `params.display` (default `config.encoderDisplay` = 1): `{display, bar, bank {index, name, pages}, page {index, name, slots}, banks, context, attributeEditing, unsupported?, poolUnavailable?}`; indexes are 1-based (the selectors' `SelectedItemValueI64` is 0-based); `context ~= "Default"` is available but `unsupported` (editors, timing, phasers are not qualified); a selector value without a pool page keeps the index and reports `poolUnavailable` |
| `encoderSlots` | display | the pool page's ordered slots (`config.maxSlots` = 5), **flat** records: `slot, kind (attribute | other | empty), ref, name, attributeIndex, objectType, label` (the on-screen band), `feature, unit, readout, readoutSource, resolution, resolutionSource` (`user-preference` > `attribute-definition` > `encoder-band`), `pressFactor, layer` (the profile's), `color, channelFunctions, channelFunction` (the selector's text), `availability` (`no-selection | available | unavailable | mixed`), `fixtures, with, partial`, `valueState` (`none | value | empty | mixed | unavailable`), `absolute, raw, valueChannelFunction, valueFixture, uiChannel, valueNote`, since 0.4.0 (KB-19) `physicalFrom, physicalTo, physicalRange, physicalFunction, physicalFunctionIndex, physicalFunctions, physicalFixtures, physicalMixed?, physicalNote?` (the range of the channel function that names the attribute, read from `GetUIChannel(ui).logical_channel` for every scanned fixture with the channel; the **smallest** range when fixture types differ, `physicalMixed` saying so; reported only when every such fixture contributed, the scan covered the whole selection and every scanned fixture's channels were enumerated and mapped, never from another function) or `physicalUnavailable` with the reason; `discoveryIncomplete` when `GetUIChannels` or the subfixture discovery raised for a fixture, or an enumerated channel could not be mapped to a readable attribute name (`GetAttributeByUIChannel` raising, returning nil, or a handle whose name is unreadable or empty) (that fixture is then not a confirmed "lacks the attribute"; `selection.discoveryFailures` counts them and `limitations` names them); the range, its availability and the discovery state are in the binding digest, `outerRef/outerName/outerUnsupported`, `unsupported`, `attributeUnavailable`; plus `selection {count, scanned, fixtures, identityComplete, partial, limitations}`: the attribute scan is bounded by `config.maxSelectionScan` (8) fixtures and `config.maxUIChannels` (64) channels each (a grouping fixture read through its first subfixture), while `fixtures` is the **whole** selection's ids walked without channel reads up to `config.maxSelectionIdentity` (512); `identityComplete` is true only after a traversal that ended by itself within that bound with exactly `count` distinct ids (a nil or raising `SelectionFirst`, a `SelectionNext` that ends early, repeats a fixture, fails or is missing leave it false) |
| `executorTarget` | page | `params.executor`: `{executor, page, empty, assigned, functions {keyPress, keyUnpress, keyUnpressCombined, fader, encoder, encoderLeft, encoderRight}, configuration, isXKey, width, level {token, value, text} | {unavailable}` (the token of the **configured** fader function, `Fader<fn>`), `active | activeUnavailable, appearance {name, backRGBA, color} | appearanceUnavailable, playbackTarget, reason?, reserved?}`; a `Quickey` object or an executor inside `deps.reservedExecutors()` (the bridge wires its KB-12 bank) is never a playback target |
| `pageExecutors` | page | index, name and class of every assigned executor of the current page, bounded by `config.maxExecutors` |

A display without an encoder bar (or one that does not exist) makes `encoderBank`/`encoderSlots` unavailable with the
reason; **no other display is substituted**: the authoritative encoder bar is the one the consumer configured
(`config.encoderDisplay`) or requested (`params.display`), never one the module found. KB-16 saw an encoder bar on
display 1 only on onPC. Every missing property, deleted assignment, mixed selection or unsupported context is an
explicit field, never a default.

| Method | Effect |
| --- | --- |
| `contextItems(spec)` (also a module function) | The items of `spec = { display?, executors? }`: `dataPool`, `page`, `encoderBank`, `encoderSlots` and one `executorTarget` per executor (bounded by `maxExecutors`, the rest a limitation). |
| `contextSnapshot(spec, now, opts?)` | One bounded snapshot: `{observedAt, epoch, atomic=false, identity {showFile, user, profile, dataPool | dataPoolUnavailable}, identityUncertain, invalidated?, display, authoritativeDisplay {display, rule = configured | requested, note}, executorPage | executorPageUnavailable, encoder, slots, executors[], pageExecutors?, limitations[], generation, generationChanged, generationSince, bindingKey, generationNote?}` where `encoder`, `slots` and each executor are observations (`available`, `value` or `reason`/`error`). `spec.allExecutors = true` adds every assigned executor of the page (live reads only). `opts.cached = true` assembles the snapshot from the watched observations without reading: items not observed in this epoch are unavailable (`notObserved`, `stale`), and while any item is missing **no generation is claimed** (`generationUnknown`, `lastGeneration`). |
| `watchContext(spec, now)` | `watch()` of `contextItems(spec)` (replaces the watch list) so `service()` keeps the snapshot's items observed at the loop's pace; the console is followed without any surface keypress. |

**Binding generation.** `generation` starts at 1 per distinct spec (`bindingKey`: display and executor list; at most
`config.maxGenerations` = 8 records per instance) and increments whenever the snapshot's *meaning* changed: epoch and
identity (show, user, profile, data pool), bank/page/context, the selection's identity (count and every fixture id,
not only the scanned ones), each slot's object, resolution, readout, channel function, layer, availability and outer
object, the executor page, each executor's assignment, class, every configured function (key press, release, combined
release, fader, encoder, encoder left/right), fader token and playback-target status, and the availability (with reason)
of any of these parts. While the selection identity is incomplete (`identityComplete = false`) no generation is
claimed (`generationUnknown`, `lastGeneration`), exactly as for an unobserved part of a cached snapshot. A programmer value, a fader level, activity or a label alone never moves it. Generations are comparable
only for one spec within one instance (a bridge restart is a new instance); the bridge's `feedback.context` op
exposes them ([reference](reference.md#control-context-plugin-v0130-kb-17)).

## Continuous-control admission (`gma3_mcp_control` 0.1.0, KB-18)

A third module carries encoder motion and strip gestures from a surface to the console without stale input
affecting a new target. It is loaded like the other two (a ComponentLua that only returns a table), touches no console
API itself for admission (the binding and the other input owner are injected by the consumer through `deps.binding(now)` and
`deps.busy(sessionId, now)`). 0.1.0 shipped the **fake backend only**: intents are admitted, ordered,
coalesced, bounded and recorded, and nothing moves on the console; 0.2.0 adds the console adjustment backend
([below](#console-adjustment-backend-gma3_mcp_control-020-kb-19)).

| Event | Fields | Meaning |
| --- | --- | --- |
| `relative` | `delta` (non-zero integer, `|delta| <= maxDelta`), `gesture`, `fine?` | encoder motion in detents |
| `absolute` | `value` (0..1 of the control's travel), `gesture` | a strip or fader position |
| `touch` | `down` (boolean), `gesture` | a strip touched or lifted |
| `button` | `down` (boolean) | an encoder pressed or released |

Every event carries `device`, `control`, `seq` (strictly increasing per session and device), `generation` (the
`gma3_mcp_feedback` 0.3.0 `contextSnapshot().generation` the surface produced it against) and `target`: `{ slot = n }`
(an encoder slot of the bound display) or `{ executor = n, element = "fader" | "key" | "encoder" }`.

| Method | Effect |
| --- | --- |
| `openSession(opts, now)` / `renewSession(id, now, leaseMs)` / `closeSession(id, now, reason)` | owned sessions with leases (`defaultLeaseMs` 15000, `maxLeaseMs` 120000); a close or expiry ends the session's gestures through the backend (`forced = true` intents) and drops its queue, never applying anything late |
| `submit(sessionId, now, event)` | admission in this order: session and lease; shape (`bad-event`); per-device order (`duplicate` for a seen `seq`, `out-of-order` for an older unseen one within `seqWindow`, a gap is accepted and reported as `lost`; a **delayed release** newer than its own hold's press is admitted `late` even after another control advanced the device and regardless of `seqWindow`, it ends that hold and never a newer one); per-device rate for motion (`rate`, dropped not deferred; releases are never rate-refused); a **release** (`touch`/`button` with `down = false`) is then admitted without a binding and with reserved queue capacity (`maxQueue + maxHolds`, the session's oldest motion evicted first; `noop` when nothing is down; a release that still cannot be queued is refused `queue-full` and the hold stays owned for its retransmission); everything else needs the binding (`binding-unknown` while no generation is claimed or while the snapshot is `stale`), the event's binding revision (`binding-required` when it carries none and the consumer did not declare a fixed binding with `config.requireBindingRevision = false`; `stale-binding`: the snapshot's `bindingKey` changed, so the module dropped every queued intent except releases, which still end their holds against the captured targets, rebound every hold and reports the new `revision`), the event's generation (`stale-generation`, the current one reported), a resolvable target (`target-unavailable` with the binding's reason: no selection, unavailable, empty slot, empty executor, not a playback target, no such function; `unsupported` for phaser/editor slots), no rebound touch (`gesture-rebound`: the touch was held under another generation or binding, whether or not motion was queued; release and re-touch), no other input owner (`busy` from `deps.busy` unless it is this session), no other session's gesture on the target (`conflict` with the owner), `capacity` (`maxHolds` touches/buttons down) and room in the queue (`queue-full`: motion is refused; a release evicts the session's oldest motion instead). Returns `{ accepted, queued, coalesced?, superseded?, lost, target, generation, mixed?, stateful?, boundary?, noop? }` |
| `service(now)` | lease expiries and `maxGestureMs` force-ends first, idle motion gestures lapse (`gestureIdleMs`), then at most `maxWorkPerService` queued intents in order through `adapter.apply(intent, now)`; motion older than `maxEventAgeMs` is dropped `expired`, motion whose generation is no longer the binding's is dropped `staleGeneration` (and marks the touch that produced it `rebound`); returns `{ applied, dropped {expired, staleGeneration, refused}, unresolved[], expired[], ended[], work, pending }` |
| `admission(now)` | the busy descriptor (`touch-down`, `button-down`, `motion` within `gestureIdleMs`, `queued`) or nil |
| `enableInput(adapter)` / `disableInput(now, reason)` / `attachBackend(adapter)` / `backendAvailable()` | as for hardkeys; `fakeBackend()` records intents and stages refusals (`failNext`) and raises (`raiseNext`); an adapter may declare `supports(kind, resolvedTarget) -> true | false, reason` and `submit` then refuses what it does not serve as `unsupported` (with `backend` and `reason`) right after the target resolves, before any gesture or queue entry (0.2.0) |
| `recover(now)` / `adopt(records, now)` / `dispose(now)` | a release the backend raised on is an **unresolved** record (whether the console saw it is unknown); `dispose()` hands the records back, `adopt()` takes them into a new instance, `recover()` re-attempts each record of a detached batch once per call (a persistent fault is retained once, never retried in a loop) |
| `bindingInfo(now)` | the current binding `revision` (monotonic per instance, moved by a changed `bindingKey`), `key` and `generation`, or `unknown` with the reason; consumers hand the revision to their clients so events can carry `binding` |
| `status(now)` | read-only: sessions (devices with `last/lost/duplicates/reordered/rateDropped`, gestures with `rebound`), counters, the bounded event log, unresolved records, `lastApplied` (with the backend's `result`), `backendStatus` when the adapter has a `status()` (0.2.0) |

**Coalescing.** Relative deltas merge into the queue's tail only when it is motion of the same session, device, control,
target, generation, resolution, fine flag and gesture, and nothing else was queued since; a touch or button event, a
generation change or another target is a boundary. Absolute positions replace a queued position of the same target
only where the function permits: attribute slots and stateless fader functions (`Master`, `Rate`, ...) do; `X`, `XA`,
`XB`, crossfades and `Temp` (`STATEFUL_FUNCTIONS`) never do, so every position, including both endpoints, is applied
in order. Packet loss is reported, never repaired: a lost relative delta is gone, a lost position is superseded by
the next one.

**Serialisation.** A touched or pressed target belongs to its session until the release (motion keeps it for
`gestureIdleMs`); the bridge ORs `admission()` into its `[busy]` guard so `cmd`/`set`/`setfader`/`lua` from every
other writer are refused while a surface gesture is active, and refuses motion while the hardkeys instance reports
another owner (bridge 0.14.0, [reference](reference.md#continuous-control-plugin-v0140-kb-18)).

## Console adjustment backend (`gma3_mcp_control` 0.2.0, KB-19)

`consoleBackend(consoleDeps(_G), opts?)` (`deps.cmd(text)` is `Cmd`; `opts.fineDivisor` 10, `opts.eventLog` 64) applies
**relative motion on attribute slots** as the selection-scoped adjustment KB-16 qualified live:

```
Attribute "<name>" At + <detents x step>      (At - for a negative delta; at most four decimals)
```

The name, layer, resolution, readout, channel function and physical range come from the resolved slot of the binding
(the feedback 0.4.0 snapshot), never from the surface. `calibrate(resolvedSlot, fine?, config?)` (exported) gives the
step of one detent or nil plus the reason, after the grandMA3 manual's "Encoder resolution" rule (24 clicks per turn,
5 turns across the range) and the live measurements (KB-16 `At + 1` = one Coarse click at Percent; KB-19 Pan `At 10` =
10 degrees):

| Readout | Coarse | Fine | Needs |
| --- | --- | --- | --- |
| `Percent`, `PercentFine` | 1 | 0.1 | - |
| `Physical` | `physicalRange / 120` in the attribute's physical unit | a tenth | `physicalRange` in the slot (feedback 0.4.0); an unreadable or empty range is refused |
| anything else (`Dec8`, `Dec16`, `Hex` ...) | refused | refused | not measured |

A slot target resolves only while the encoder bar is in attribute editing (`encoder.value.attributeEditing == true`,
preset-bar context `Default`); an editor, phaser or unreadable context is `unsupported` and an unavailable encoder bar
`target-unavailable`, for every backend. `fine = true` on the event divides the step by `fineDivisor` (an explicitly smaller adjustment, not the console's
resolution toggle); resolutions other than Coarse/Fine (Increment, Native), layers other than Absolute, a
channel-function selector naming a function other than the attribute's own, a quoted attribute name, phaser/editor
slots and executor elements are refused. No acceleration is applied: n detents are n steps.

`supports(kind, resolved)` served `relative` on slots only in 0.2.0; since 0.3.0 (KB-20, below) `touch` and `absolute`
on slots are served too, while `button` (an encoder press: calculator/open/select is not qualified, nothing is pressed)
and executor targets (KB-21/22) are refused `unsupported` at admission. A forced end of a hold reaching this backend (a hold admitted under another backend) is
a noop. The console's feedback is the verdict: `OK` = applied (`lastApplied.result` carries `command, amount, step,
fine, resolution, readout, physicalRange, attribute, slot, mixed, feedback`), anything else = `backend-refused` with the
feedback, a raise = unresolved (a relative intent is never re-attempted). `status()` (in `Instance:status().backendStatus`)
carries the counters (`applied/refused/raised/noop`), the last command and the calibration table; `capabilities` said
`{ relative = true, absolute = false, touch = false, button = false, targets = { slot = true, executor = false } }` in
0.2.0 (`absolute` and `touch` are true since 0.3.0). The module publishes `CALIBRATION` and `backends = { fake, console }`.
The bridge enables it with `control=console` (0.15.0, [reference](reference.md#continuous-control-plugin-v0140-kb-18));
the live evidence is [kb-19-adjust-macos-2.5.1.md](probes/kb-19-adjust-macos-2.5.1.md).

## Parameter strips on the console backend (`gma3_mcp_control` 0.3.0, KB-20)

The gesture itself (anchoring a touch, re-anchoring on a retouch, sensitivity, fine, pickup) belongs to the surface
service; this module serves what a strip produces on an **attribute slot**:

| Event | Served as | Refused when |
| --- | --- | --- |
| `touch` down / up | a hold: `admission(now)` reports the instance busy (`touch-down`) while it is down, the slot is the session's until the release, the backend applies it as a **noop** (`lastApplied.result.noop`, nothing is issued) | the slot is not calibrated (the `calibrate()` rules), an executor fader (KB-21/22) |
| `relative` inside the touch | the KB-19 adjustment `Attribute "<name>" At +/- <detents x step>` | as in KB-19; `gesture-rebound` after the binding changed while the strip stayed touched (release and touch again) |
| `absolute` (`value` 0..1 of the travel) | `Attribute "<name>" At <value>` over the **verified travel**: `Percent`/`PercentFine` span 0..100 (KB-16 live `At 50` = absolute 50), `Physical` spans the binding's `physicalFrom..physicalTo` in physical units (KB-19 live: `At` takes physical units; `At -180` for 0.1 of Pan -225..225) | `physicalMixed` (fixtures with different ranges: one position would mean different values), a missing `physicalFrom/To`, any readout, layer or channel function `calibrate()` refuses, executor faders |

`position(resolvedSlot, value, config?)` (exported) gives the placed value or nil plus the reason, with `{ from, to,
readout, physicalRange }`. The newest queued position of a slot supersedes an older one (slots are stateless targets);
a position older than `maxEventAgeMs` when applied is dropped like motion, never placed late.

**Mixed values stay mixed.** `resolveTarget` forwards the binding's `valueState` (`value | empty | mixed | unavailable`),
`valueComplete`/`valueIncomplete` and last read `absolute` on the resolved slot; an `absolute` event on a slot whose
fixtures hold different values (`valueState == "mixed"`) is refused `mixed-values` at admission, for every backend,
unless the event carries `takeover = true` (the surface's statement that the operator deliberately chose an absolute
operation; `takeover` on a relative event or a non-boolean is `bad-event`). **Incomplete reads are not agreement**
(review of PR #24): feedback reports `valueComplete = true` only when every selected fixture was scanned, every scanned
fixture's channels were discovered and every fixture with the channel was read; otherwise `valueIncomplete` says why
(a bounded scan beyond `maxSelectionScan`, a discovery failure, a failed `GetProgPhaser`) and `"value"` means only
"the fixtures that could be read agree". A position on a slot whose `valueComplete` is not true (including a binding
that reports no completeness) is refused `values-incomplete` with that reason unless `takeover = true`. Relative
motion on such slots keeps the fixtures' relationship.
Values are not in the generation digest (a value change never moves the generation), so `valueState`/`absolute` are the
binding's last read: a hint for the surface's pickup policy, never a guarantee of the console's current value.

`lastApplied.result` for a position carries `command, value, amount, from, to, readout, physicalRange, attribute, slot,
mixed, valueState, takeover, feedback`; for motion the KB-19 fields (and `delta`). `capabilities` on the console backend
are `{ relative = true, absolute = true, touch = true, button = false, targets = { slot = true, executor = false } }`.
The bridge enables it with `control=console` (0.16.0); the live evidence is
[kb-20-strips-macos-2.5.1.md](probes/kb-20-strips-macos-2.5.1.md).

## Vendoring into another plugin (mtpnxk)

Use the immutable upstream revision **`01e1561490fc39ce4e2d510e2d170c9c09e4bc53`** (KB-20, hardkeys 0.10.0 / feedback 0.4.0 /
control 0.3.0) for the current module set; the earlier pins were `107f54804a9f7183e8bbedee2ebbac70e38e06fd` (KB-19, hardkeys
0.10.0 / feedback 0.4.0 / control 0.2.0), `9f08f871f864084afcd670008310b285e8b31bfc` (KB-18, hardkeys
0.10.0 / feedback 0.3.0 / control 0.1.0), `c8dbb3aa6edf352fc977d5196399bb6daf222d2b` (KB-17,
hardkeys 0.10.0 / feedback 0.3.0), `3960334f295aaa2dcd98beb62beeccfcccbef46e` (KB-15, hardkeys 0.10.0 / feedback 0.2.0), `6e0d9c1918dd22e4703a9a36cf0440b20b4014ee`
(`main` after PR #12, hardkeys 0.5.0, the pair mtpnxk qualified in KB-08) and `9da14544155f921c5dd4fd1cbb9a1ea4bd6f6e78`
(the reviewed hardkeys 0.4.0). The machine-readable [modules.lock.json](../plugin/modules.lock.json) records the
repository, full revision, module versions, API versions and SHA-256 of each file. This is a vendoring
manifest, not an automatic updater or a runtime dependency on GitHub.

| File | Module version | API version | SHA-256 |
| --- | --- | --- | --- |
| `plugin/gma3_mcp_hardkeys.lua` | 0.10.0 | 1 | `a57ebd29af3b2c7e9e06ef3dcd8b7059c775db83b0dc61760f49e75973cc7dc3` |
| `plugin/gma3_mcp_feedback.lua` | 0.4.0 | 1 | `bbed1e5432f7f8705829cda6651a62babdde4c05593c141e891b86fd8be14dd6` |
| `plugin/gma3_mcp_control.lua` | 0.3.0 | 1 | `56ffe3e6aa4c492a6c9a6aa01a66e114b41930f1e9178d6ea2c3f8078887a9b8` |

1. Obtain the Lua files from that exact revision of `bdstark/GrandMA3MCP`, rather than a moving branch.
   Copy them unchanged with [LICENSE](../LICENSE) and the manifest into the surface package. The manifest's
   `revision` is the commit whose bytes the hashes name (the lock is updated in the commit after it).
2. Verify each file against its manifest SHA-256 before packaging (for example, `shasum -a 256` on macOS,
   `sha256sum` on Linux, or `Get-FileHash -Algorithm SHA256` in PowerShell). Relative paths in the manifest
   are upstream paths; record the destination paths if your consumer uses a different layout.
3. Add each as a `ComponentLua` entry after your entry component in the plugin XML, and copy the
   `.lua` files next to the XML for import. After import the show carries them. Include the manifest with
   the distributed source/package; it does not need to be a console component.
4. Validate every module's `API_VERSION` and expected `VERSION` at startup, as in the example above.
   Pinning the bytes matters because fixes have shipped without changing those version strings.
5. Upgrade deliberately: review the upstream changes, replace the files from one selected revision,
   update the manifest and startup checks, then run lifecycle/recovery tests and the relevant live probes
   in the consumer. Submit shared console-semantic fixes upstream and re-vendor them rather than keeping
   a surface-only fork. The pin is reproducible; it does not imply every platform is qualified.

See the [tested platform/version matrix](compatibility.md) for the evidence and remaining gaps.
mtpnxk vendored the 0.5.0 pair (its `tools/ma3/VENDOR.md` records those commits and hashes) and qualified the surface
consumer against it on macOS in its KB-08 record, then the 0.10.0/0.2.0 pair for KB-15; the 0.10.0/0.3.0 pair for KB-17 (the context snapshot carried as a `context` message); the 0.10.0/0.3.0/0.1.0 set
above is what its KB-18 surface half vendors (continuous-control events admitted on the console side), to be
qualified there; the 0.10.0/0.4.0/0.2.0 set above is what its KB-19 surface half vendors (the console backend behind
`control=console`).

## Verification

`npm test` runs [test/lua/modules_test.lua](../test/lua/modules_test.lua) (modules alone, no console
API, route resolution including the native/ambiguous cases), [test/lua/control_admission_test.lua](../test/lua/control_admission_test.lua) (KB-18 against a hand-built binding snapshot and the fake backend, KB-19 the console backend over a stub `Cmd`: calibration, admission refusals, command text, feedback verdicts; KB-20 strips: touch holds and their busy/ownership/rebound effects, positions per readout, the mixed-values rule and takeover; loading, sessions and leases, event validation, per-device duplicates/out-of-order/loss, binding-unknown and stale generations, every target refusal, coalescing and its boundaries, absolute supersession and stateful functions, queue/eviction/age/rate/holds/gesture/work bounds, generation moves while queued or touched and the rebound rule, conflicts and the busy descriptor, expiry/close/disable/dispose ending gestures, backend refusals and raises, recover/adopt, status), [test/lua/feedback_context_test.lua](../test/lua/feedback_context_test.lua) (KB-17 against a fake console: the registry, bank/page/context on the configured and requested display, slots with definitions, preferences, bands, mixed and empty selections, bounded scans, phaser and empty slots, executor targets including Quickey and reserved exclusions, page executors, live snapshots and every generation rule, cached snapshots through `watchContext()`/`service()`, missing dependencies), [test/lua/hardkeys_sessions_test.lua](../test/lua/hardkeys_sessions_test.lua)
(the KB-03 session lifecycle on the fake backend: ownership, aliases, leases, taps, bounded deadline servicing, route
changes, failed releases, disconnect, disable, dispose/adopt; the KB-04 keyboard adapter over stubbed console
deps: argument passing, pre-dispatch refusals, raising `Keyboard()`, MASTATE readback, exclusive holds, combos,
backend-origin records, `attachBackend`; and the KB-05 interactions, admission, text policy and sequences under the
strict policy: busy/not-owner/no-interaction/interaction-required, expiry and lazy expiry, session close and disable
ending interactions, sequences stepping through taps/waits/presses/releases, whole-request validation, failure and
uncertainty mid-sequence, owner abort, disconnect mid-sequence, chunked text with context recheck, Unicode, raised
chars, inconclusive readback, text-field acknowledgment) and the bridge harness (registry lookup, failure reporting,
connection-bound `input.*` ops, control invocations that never release, cleanup on disconnect/stop, kept records
across a restart, `input=keyboard`, refused backend switches, `input.combo`, cleanup-only attach in `input recover`,
a flooding client that cannot starve deadline servicing; and since 0.7.0 the `[busy]` guard on `cmd`/`set`/
`setfader`/`lua` across two connections, structured error replies with `code`/`detail`, `input.begin`/`extend`/`end`,
shared-connection ownership, `input.sequence` serviced by the loop, a disconnect mid-sequence and cleanup while
input is disabled; and since 0.8.0 the `feedback.describe`/`feedback.read` ops with Lua and input disabled, partial
failures, displays, executor and sequence expansion, bounds, the show-change epoch bump, `[no-feedback]` and a read
answered while another connection owns an interaction; and since 0.9.0 the `bank=` argument: provisioning at start, the record kept across a dispose and adopted at the next load, `bank status`/`verify`/`teardown`, the in-use and preflight refusals; and since 0.10.0 `input=quickey`: the backend and routing switch, a tap issuing `Assign`/`Press`/`Unpress Page`, refusals through the bridge, the switch back; and since 0.12.0 `input=mixed`: overrides accepted, `dispatchBackend` per key, a Quickey hold and a Keyboard() hold each refusing the other kind as `unqualified-mix`; and since 0.13.0 `feedback.context`/`feedback.watch`/`feedback.unwatch` with Lua and input disabled: identity, the authoritative display, slots, executor targets, refusals, the generation moving on a bank change, cached snapshots served by the loop and `[no-feedback]` on an older module) and [test/lua/hardkeys_bank_test.lua](../test/lua/hardkeys_bank_test.lua) (the KB-12 bank against a fake pool: spec validation, discovery, preflight refusals, creation with readback, reuse, partial-failure rollback, verification, dispatch-time target checks, staleness, teardown, dispose/adopt) and [test/lua/hardkeys_quickey_test.lua](../test/lua/hardkeys_quickey_test.lua) (the KB-13 backend against a fake console with executor key state: capabilities and routing reports, taps through executors, holds, chords, duplicates, per-code and discovered-code refusals in both press orders and in sequence preflight, bank-side refusals right before the press, unreserved/foreign executors, release integrity after reassignment, deletion, show change, console refusals and raises, teardown in use, restart with targets, sequences) and [test/lua/hardkeys_mixed_test.lua](../test/lua/hardkeys_mixed_test.lua) (the KB-15 mixed backend: construction and merged capabilities, overrides validated against the parts, `dispatchBackend`, no fallback for unavailable Quickey routes, dispatch and release through the recorded part, recover and adopt across instances, every `unqualified-mix` refusal for presses, combos, sequences and mode changes, the sequence waiting for a restoration, the rules on the fake backend). `node scripts/kb13-probe.mjs run` exercises it against a live bridge started with `input=quickey` and a provisioned bank ([record](probes/kb-13-quickey-macos-2.5.1.md)). `node scripts/kb03-probe.mjs run` exercises the lifecycle against a live bridge
started with `input=fake` over real TCP connections ([record](probes/kb-03-fake-macos-2.5.1.md));
`node scripts/kb04-probe.mjs run|restart` presses real keys through a bridge started with `lua input=keyboard` on a
disposable show ([record](probes/kb-04-keyboard-macos-2.5.1.md)); `node scripts/kb05-probe.mjs run` exercises the
interactions, the busy guard over two connections, sequences, command-line text and a disconnect mid-sequence the same
way ([record](probes/kb-05-input-macos-2.5.1.md)).
`node scripts/kb06-probe.mjs verify|run` exercises the feedback readers, displays, executor expansion, bounds, side-effect
freedom and reads while another connection owns input against a live bridge ([record](probes/kb-06-feedback-macos-2.5.1.md)).
`node scripts/kb19-probe.mjs verify|run` exercises the console backend live: calibration per readout, coalesced, negative and fine deltas, clamping, a two-fixture relationship, colour pages, Pan/Tilt, a gobo slot, mixed fixtures, the empty selection, a page change with motion queued and the refusals ([record](probes/kb-19-adjust-macos-2.5.1.md)).
`node scripts/kb17-probe.mjs verify|run|watch` exercises `feedback.context` live: identity, the authoritative display, slots, executor targets, cached snapshots through `feedback.watch`, and (`run`) the generation moving on selection, bank, page and executor-page changes but not on a value change ([record](probes/kb-17-context-macos-2.5.1.md)).
`node scripts/kb02-probe.mjs verify` checks a live bridge: `ping.modules`, the `modules` op, and that the
readers and key resolution return successful values (Blind readable, PLEASE resolved, Freeze and MA1
reported unavailable/unsupported). It lists loose module files in the local library folder for information
only; that proves nothing about a remote console. Portability is shown by loading the show on a console that
never had the loose files and running `verify` there. `node scripts/kb02-probe.mjs probe` reproduces
the loader experiments with a throwaway plugin.
