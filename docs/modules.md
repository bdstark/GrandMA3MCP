# Console interaction modules

[README](../README.md) · [KEYBOARD.md](../KEYBOARD.md) · [bridge setup](setup/bridge.md)

The bridge plugin ships two reusable, instance-based Lua modules as extra components of
`gma3_mcp_bridge.xml`:

| Component | File | Purpose |
| --- | --- | --- |
| `gma3_mcp_hardkeys` | [plugin/gma3_mcp_hardkeys.lua](../plugin/gma3_mcp_hardkeys.lua) | Owned input sessions, leases, deadline servicing and recovery over a backend adapter; read-only logical-key resolution |
| `gma3_mcp_feedback` | [plugin/gma3_mcp_feedback.lua](../plugin/gma3_mcp_feedback.lua) | Read-only console state readers confirmed in KB-01, with freshness and bounded polling (KB-06) |

Module API version **1**; `gma3_mcp_hardkeys` **0.4.0** (KB-03 to KB-05), `gma3_mcp_feedback` **0.2.0** (KB-02 + KB-06).
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
-- in the entry component's Main, after the console has run every component chunk
local pluginName, componentName, signalTable, my_handle = ...
local reg = rawget(signalTable, "__gma3_mcp_modules") or {}
local HK, FB = reg.gma3_mcp_hardkeys, reg.gma3_mcp_feedback
if not (HK and HK.API_VERSION == 1) then error("gma3_mcp_hardkeys is not registered; import the plugin with all components") end
local hardkeys = HK.new({ owner = pluginName, deps = HK.consoleDeps(_G) }):init()
local feedback = FB.new({ owner = pluginName, deps = FB.consoleDeps(_G) }):init()
-- every loop iteration:    hardkeys:service(now); feedback:service(now)
-- on stop/Cleanup:          hardkeys:dispose();    feedback:dispose()
```

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
`CLEAR`, `OOPS`, `NUM0`–`NUM9`, `EXEC` with `opts.executor`, and `MA`; `MA1`/`MA2` are reported
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
reads a clock and never sleeps. Calls that fail return `nil, { code, message, ... }`; nothing is
dispatched when an error is returned. Programming errors (wrong state, missing clock) raise.

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
a change of any readable one invalidates with `show-changed`, `user-changed` or `profile-changed`. An unreadable identity
value is reported as nil and is never treated as a change by itself. `status()` reports `epoch`, `lastInvalidation`,
`identity`, `watched`, `cached` and the config. The bridge creates a fresh instance (epoch 1) at every start and exposes
`readMany` through `feedback.read` ([reference](reference.md#console-feedback-plugin-v080-kb-06)); the cached
`watch()`/`snapshot()` path is for surface consumers that poll between input deadlines. Multiple reads are never an
atomic snapshot against other console activity.

## Vendoring into another plugin (mtpnxk)

1. Copy `plugin/gma3_mcp_hardkeys.lua` and `plugin/gma3_mcp_feedback.lua` unchanged, with
   [LICENSE](../LICENSE) (MIT). Record the module version and the commit you copied from.
2. Add both as `ComponentLua` entries after your entry component in your plugin XML, and copy the
   `.lua` files next to the XML for import. After import the show carries them.
3. Look them up as shown above. Do not fork console semantics: changes to key resolution or readers go
   into this repository and are re-vendored.
4. Check `API_VERSION`; a bridge or consumer refuses a module with another API version.

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
answered while another connection owns an interaction). `node scripts/kb03-probe.mjs run` exercises the lifecycle against a live bridge
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
