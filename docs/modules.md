# Console interaction modules

[README](../README.md) · [KEYBOARD.md](../KEYBOARD.md) · [bridge setup](setup/bridge.md)

The bridge plugin ships two reusable, instance-based Lua modules as extra components of
`gma3_mcp_bridge.xml`:

| Component | File | Purpose |
| --- | --- | --- |
| `gma3_mcp_hardkeys` | [plugin/gma3_mcp_hardkeys.lua](../plugin/gma3_mcp_hardkeys.lua) | Owned input sessions, leases, deadline servicing and recovery over a backend adapter; read-only logical-key resolution |
| `gma3_mcp_feedback` | [plugin/gma3_mcp_feedback.lua](../plugin/gma3_mcp_feedback.lua) | Read-only console state readers confirmed in KB-01, with freshness and bounded polling (KB-06) |

Module API version **1**; `gma3_mcp_hardkeys` **0.7.0** (KB-03 to KB-05; 0.5.0 resolves any `Enums.VirtualKeyCode` name, KB-07; 0.6.0 adds the per-key routing policy, KB-11; 0.7.0 adds the owned Quickey bank, KB-12), `gma3_mcp_feedback` **0.2.0** (KB-02 + KB-06).
Two backend adapters dispatch: the **fake backend** (records events, simulates aggregate console key state,
nothing reaches a console key) and the **keyboard backend** (`keyboardBackend(deps)`, KB-04: the console's
`Keyboard()` PC-key emulation; console keys are really pressed).

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
-- The consumer owns `retained`: keep it across stop/start and persist it across reloads
-- if those can replace the entry component's Lua state. Never recreate it on each start.
local function startModules(pluginName, signalTable, retained, now)
  assert(type(now) == "number", "supply the consumer clock in seconds")
  local reg = rawget(signalTable, "__gma3_mcp_modules") or {}
  local HK, FB = reg.gma3_mcp_hardkeys, reg.gma3_mcp_feedback
  assert(HK and HK.API_VERSION == 1 and HK.VERSION == "0.4.0", "wrong hardkeys module")
  assert(FB and FB.API_VERSION == 1 and FB.VERSION == "0.2.0", "wrong feedback module")
  local hardkeys = HK.new({ owner = pluginName, deps = HK.consoleDeps(_G) }):init()
  local feedback = FB.new({ owner = pluginName, deps = FB.consoleDeps(_G) }):init()
  local adopted = hardkeys:adopt(retained, now) -- reserves old tuples; dispatches nothing
  local rejected = {}
  for _, item in ipairs(adopted.rejected) do rejected[#rejected + 1] = item.record end
  -- Input is still disabled. Do not enable it if any record could not be adopted.
  return hardkeys, feedback, rejected
end

local function stopModules(hardkeys, feedback, retained, now)
  assert(type(now) == "number", "cleanup needs the consumer clock in seconds")
  local result = hardkeys:dispose(now) -- attempts releases using the stored tuples
  for _, record in ipairs(result.records) do retained[#retained + 1] = record end
  feedback:dispose()
  return result -- report unresolved releases; retain their records for the next start
end

-- Main assigns all three results:
-- hardkeys, feedback, retained = startModules(pluginName, signalTable, retained, now)
-- Each loop: hardkeys:service(now); feedback:service(now), using a fresh clock value.
-- Stop/Cleanup: stopModules(hardkeys, feedback, retained, now), then persist retained.
```

Calling `hardkeys:dispose()` without a numeric clock does **not** dispatch releases. Do not discard its
returned records. If cleanup raises, preserve the instance and report the failure instead of dropping
ownership state. Adopt retained records before admitting input; retain and report any rejected records.
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
| `quickkey` | Press/release the Quickey tuple `{ quickkey = <name>, quickkeyCode = <value> }` (`tupleKey = "quickkey:#<value>"`: ownership is the validated code value, so aliases such as `OOPS`/`UNDO` are one tuple; the requested name is kept for reporting). Needs an adapter advertising `capabilities.quickkey = { tap, hold, chord }`, and each flag is enforced per operation before dispatch on every path (a tap needs `tap`, a hold needs `hold`, a combo or a press next to another live Quickey needs `chord`; refusals are `unsupported` with `reason = "capability"` and `missing[]`); the fake backend simulates it, the `Keyboard()` backend refuses it, the owned-Quickey backend is KB-12/KB-13. `MA1` is a valid code here. |
| `shortcut` | The shortcut-table / fixed (`MA`) / native (`PLEASE`) PC-key route as before. A shortcut-table route while shortcuts are off is refused as before and additionally lists the KB-14 requirement (temporary enable); nothing is toggled. |
| `shortcutOrType` | Fixed/native routes whatever the mode. Otherwise the shortcut route only when enablement reads `true` and resolution succeeds; the key's explicit `text` when the table was read and has no row for the key, or when enablement reads `false` (no row needed). Unreadable enablement, ambiguity, collisions, unknown keys and a missing `text` are refusals, never permission to type. The text branch is selected but refused `unavailable` until KB-14 implements text-route dispatch. |
| `type` | The key's explicit `text`, inserted once on press (KB-14). Resolved and reported; refused at `enableInput()`/`configureRouting()` as `policy-unavailable` against every current backend. |

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
| `describeRoute(name, { prefer, executor })` | Read-only: `key`, `method`, `methodSource` (`key`, `default`, `module-default`), `effective` (`quickkey`, `shortcut-table`, `fixed`, `native`, `text`), `supported`, `code`, `reason`, `dispatchable`, `unavailable[]` (named requirements, e.g. "no backend attached", the KB-13/KB-14 items), `capabilities` of the attached adapter, `resolution` (the `describeKey()` result), `quickkey`/`codeValue`, `text`. |
| `routingReport()` / `status().routing` | `default`, `defaultSource`, `keys` (effective method and fields per override), `overrideCount`, `methods[<m>] = { available, missing[] }` for the attached backend, `capabilities`. |
| `enableInput(adapter)` | Additionally checks every method the policy names against the adapter (`policy-unavailable`, nothing attaches). `attachBackend()` (cleanup-only) does not. |

Adapters advertise `capabilities = { keyboard = bool, quickkey = { tap, hold, chord } \| false, char = bool }`;
an adapter without the field is a PC-key adapter (`keyboard = true`). Holds report `method` and, for Quickey
tuples, `quickkey`; `route.routing` is the stored decision a Quickey hold's route recheck uses (never the current
policy). Press-time refusals: `unsupported` (with `reason` = the resolution code: `unknown-key`, `no-row`,
`ambiguous`, `collision`, `unreadable`, `no-mapping`, `shortcuts-inactive`, …) and `unavailable` (the route is
selected but a named requirement is missing; `effective` and `unavailable[]` are attached). Neither dispatches
anything, and a refused press is never queued for a later mode or table change. Regressions:
`test/lua/hardkeys_routing_test.lua`.

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
| `adoptBank(record, now)` / `dispose().bank` | The record is the consumer's to keep across a restart (the bridge keeps it beside the unresolved records); adoption re-verifies everything and creates nothing; another owner's record is `bank-foreign-owner`; a record without the placeholder entry or a show identity is refused; on another show the adopted bank is `stale`. |
| `bankStatus(now)` / `status().bank` | Read-only: `id`, `state` (`ready`, `degraded`, `stale`, `partial`), `codes[]` with `index`/`value`/`qualified`/`state`/`problem`, `executors[]`, `exclusions[]`, `aliases[]`, `counters`, `record`. |

Console deps (`consoleDeps(_G)`): `showIdentity()` = show name plus data pool name; `quickeys.read/create/set/delete`
over `ObjectList("Quickey N")` and `Store`/`Delete Quickey N /NoConfirmation`; `executors.read/assign/clear` over
`ObjectList("Page P.N")` (the assigned object's pool index, Note and Code are read), `Assign Quickey N At Page P.N` and
`Delete Page P.N /NoConfirmation`. Every write is verified by a readback, never by the
command's return text. On 2.5.1 an empty executor has no object under `Page P.N` (the deps report `empty` when the page
exists), and the show identity is `Root().MANetSocket:Get("ShowFile")` plus the data pool name. Qualified live on the
disposable show ([record](probes/kb-12-bank-macos-2.5.1.md)); regressions: `test/lua/hardkeys_bank_test.lua`.

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

## Vendoring into another plugin (mtpnxk)

Use the immutable upstream revision **`9da14544155f921c5dd4fd1cbb9a1ea4bd6f6e78`** for this
reviewed module pair. The machine-readable [modules.lock.json](../plugin/modules.lock.json) records the
repository, full revision, module versions, API versions and SHA-256 of each file. This is a vendoring
manifest, not an automatic updater or a runtime dependency on GitHub.

| File | Module version | API version |
| --- | --- | --- |
| `plugin/gma3_mcp_hardkeys.lua` | 0.4.0 | 1 |
| `plugin/gma3_mcp_feedback.lua` | 0.2.0 | 1 |

1. Obtain both Lua files from that exact revision of `bdstark/GrandMA3MCP`, rather than a moving branch.
   Copy them unchanged with [LICENSE](../LICENSE) and the manifest into the surface package. The manifest
   is introduced by this documentation change; its `revision` identifies the existing upstream Lua bytes.
2. Verify each file against its manifest SHA-256 before packaging (for example, `shasum -a 256` on macOS,
   `sha256sum` on Linux, or `Get-FileHash -Algorithm SHA256` in PowerShell). Relative paths in the manifest
   are upstream paths; record the destination paths if your consumer uses a different layout.
3. Add both as `ComponentLua` entries after your entry component in the plugin XML, and copy the
   `.lua` files next to the XML for import. After import the show carries them. Include the manifest with
   the distributed source/package; it does not need to be a console component.
4. Validate both modules' `API_VERSION` and expected `VERSION` at startup, as in the example above.
   Pinning the bytes matters because fixes have shipped without changing those version strings.
5. Upgrade deliberately: review the upstream changes, replace both files from one selected revision,
   update the manifest and startup checks, then run lifecycle/recovery tests and the relevant live probes
   in the consumer. Submit shared console-semantic fixes upstream and re-vendor them rather than keeping
   a surface-only fork. The pin is reproducible; it does not imply every platform is qualified.

See the [tested platform/version matrix](compatibility.md) for the evidence and remaining gaps.

## Verification

`npm test` runs [test/lua/modules_test.lua](../test/lua/modules_test.lua) (modules alone, no console
API, route resolution including the native/ambiguous cases), [test/lua/hardkeys_sessions_test.lua](../test/lua/hardkeys_sessions_test.lua)
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
answered while another connection owns an interaction; and since 0.9.0 the `bank=` argument: provisioning at start, the record kept across a dispose and adopted at the next load, `bank status`/`verify`/`teardown`, the in-use and preflight refusals) and [test/lua/hardkeys_bank_test.lua](../test/lua/hardkeys_bank_test.lua) (the KB-12 bank against a fake pool: spec validation, discovery, preflight refusals, creation with readback, reuse, partial-failure rollback, verification, dispatch-time target checks, staleness, teardown, dispose/adopt). `node scripts/kb03-probe.mjs run` exercises the lifecycle against a live bridge
started with `input=fake` over real TCP connections ([record](probes/kb-03-fake-macos-2.5.1.md));
`node scripts/kb04-probe.mjs run|restart` presses real keys through a bridge started with `lua input=keyboard` on a
disposable show ([record](probes/kb-04-keyboard-macos-2.5.1.md)); `node scripts/kb05-probe.mjs run` exercises the
interactions, the busy guard over two connections, sequences, command-line text and a disconnect mid-sequence the same
way ([record](probes/kb-05-input-macos-2.5.1.md)).
`node scripts/kb06-probe.mjs verify|run` exercises the feedback readers, displays, executor expansion, bounds, side-effect
freedom and reads while another connection owns input against a live bridge ([record](probes/kb-06-feedback-macos-2.5.1.md)).
`node scripts/kb02-probe.mjs verify` checks a live bridge: `ping.modules`, the `modules` op, and that the
readers and key resolution return successful values (Blind readable, PLEASE resolved, Freeze and MA1
reported unavailable/unsupported). It lists loose module files in the local library folder for information
only; that proves nothing about a remote console. Portability is shown by loading the show on a console that
never had the loose files and running `verify` there. `node scripts/kb02-probe.mjs probe` reproduces
the loader experiments with a throwaway plugin.
