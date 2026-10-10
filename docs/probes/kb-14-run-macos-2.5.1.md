# KB-14 probe: scoped shortcut-mode changes and text routes — macOS, onPC 2.5.1.0

Date: 2026-10-09. Evidence for [KEYBOARD.md](../../KEYBOARD.md) "KB-14 — Scoped shortcut-state changes and text
alternatives" (hardkeys 0.9.0, bridge 0.11.0). Question under test: do the `type`, `shortcutOrType` and `shortcut`
methods insert text and press shortcut-table keys on the console with a bounded, verified change of the operator's
keyboard-shortcut mode that is kept through a hold, restored afterwards, and never overwrites a state the operator
changed meanwhile? Companion: [kb-14-timing-macos-2.5.1.md](kb-14-timing-macos-2.5.1.md) (why the restore is delayed).

**Result: qualified on the disposable show, 32/32 automated checks** ([script report](kb-14-run-macos-2.5.1.json),
`node scripts/kb14-probe.mjs run`). With shortcuts on, a `type` tap of NUM5 wrote the mode off, inserted `5`, was
retained, and the loop restored the mode 60 ms later with the record released and `5` read back on the command line;
THRU and a second NUM5 did the same (`5Thru 5`). `shortcutOrType` took the `F` row with shortcuts on and its text
(`Fixture `) with shortcuts off, without a mode change either way. With shortcuts off, `shortcut` STORE enabled them
for the tap and for a 600 ms hold (`Store ` on the line, the operation still active mid-hold, a text route refused as
`mode-conflict`), released, and restored off afterwards. The operator disabling shortcuts during a temporarily enabled
STORE hold (deferred macro, F10 stand-in) resolved the operation to the operator's state without a write, left the hold
held, made the release a route change that stayed unresolved (the console did not lift the key), refused new input, and
after the operator re-enabled shortcuts the owner's `input.recover` released it through the stored tuple; shortcuts were
left in the operator's state. Not exercised live: a profile switch during an operation, an unreadable state or a failed
write at restore time, the kept restoration across a bridge restart, a KB-05 text step during a pending restoration
(all harness-only, `test/lua/hardkeys_mode_test.lua` and the bridge harness), and the NX-K surface path.

| Item | Value |
| --- | --- |
| Host | macOS, onPC 2.5.1.0 Release, hostname `bdsmbpm401` |
| Show / user / profile | `mcp-test-disposable`, Admin, profile `Default` (`UserProfile 1.13` is its `KeyboardShortCuts`); rows `S`→STORE, `5`→NUM5, `F`→FIXTURE present, no row for THRU; show not saved |
| Bridge / modules | gma3_mcp_bridge 0.11.0 (`lua input=keyboard` from Macro 100), gma3_mcp_hardkeys 0.9.0, gma3_mcp_feedback 0.2.0; repo working tree of the KB-14 change |
| Invocation | `node scripts/kb14-probe.mjs run --out docs/probes/kb-14-run-macos-2.5.1.json` over one TCP connection; policy through `input.routing`, routes through `input.route`; readback with `CmdObj().cmdtext`, `Root().MASTATE`, `KEYBOARDSHORTCUTSACTIVE` through `lua` outside interactions, `feedback.read commandText` and `input.status` during them; operator action during the hold through the deferred Macro 116 (`Echo` + Wait 2 s, `Set UserProfile 1.13 Property "KeyboardShortcutsActive" "false"` + Wait 5 s, `... "true"`), claimed empty, verified by contents before every rewrite and before deletion |
| Preconditions | 0 holds, nothing busy, no mode change; command line empty; `MASTATE` false; shortcuts **off** (restored to off at the end) |

## Console facts found before the run

- A macro line's `Wait` is the delay **after** the line (before the next one), as in the KB-13 probe: the first delay
  rides on an `Echo` line. A numeric Wait reads back as `"2.0"`, a missing one as `"Follow"`.
- `Set UserProfile 1.13 Property "KeyboardShortcutsActive" "true"|"false"` (the address from
  `CurrentProfile().KeyboardShortCuts:ToAddr()`) changes the mode synchronously from the command line and from a macro;
  `Lua "..."` from the command line runs on a later frame.
- `ObjectList("Macro N")` of an empty slot returns an empty list; a probe must return `false`, not `nil`, through the
  `lua` op to tell "empty" from "a table".

## Steps

| # | Step | Result |
| --- | --- | --- |
| 1 | `input.routing` (report) | default `shortcut`; `type`, `shortcut`, `shortcutOrType` available on the keyboard backend, `quickkey` not; `capabilities.modeChange = true` |
| 2 | `input.routing` policy NUM5/THRU `type`, FIXTURE `shortcutOrType`, STORE `shortcut` | accepted, 4 overrides |
| 3 | shortcuts set **on**; `input.route NUM5` / `STORE` | NUM5: `effective text`, `modeChange { target false }`, dispatchable; STORE: `shortcut-table`, no mode change |
| 4 | `input.tap NUM5` | `kind text`, `state retained`, `modeOp m26`, `text.typed 1`; `input.status.modeChange`: `active`, profile `Default`, original `true` → target `false`, dependents `[h39 retained]`, `restoreInMs 8` |
| 5 | poll until `modeChange == nil` | `lastModeChange.restoredBy = service`, hold `released`, shortcuts read `true`, `cmdtext "5"`; the record's `text.readback` is `observed` (33 ms after the press) |
| 6 | `input.tap THRU`, `input.tap NUM5` | two operations (`m27`, `m28`, not joined: a TCP round trip is longer than the 60 ms delay); `cmdtext "5Thru 5"`, shortcuts on afterwards; Escape |
| 7 | `input.tap FIXTURE` (shortcuts on, row `F`) | `shortcut-table` route, no `modeOp`; `Fixture ` on the line after 16 ms (`feedback.read` during the tap) |
| 8 | shortcuts set **off**; `input.tap NUM5`; `input.tap FIXTURE` | NUM5 `released` at once, no mode change; FIXTURE `kind text` (`textSelectedBecause: keyboard shortcuts are positively off`), no mode change; `cmdtext "5Fixture "`, shortcuts still off; Escape |
| 9 | `input.tap STORE holdMs 60` | `shortcut-table` route with `modeChange { target true }`, `modeOp m29`; after the deadline release and the restore: hold `released`, shortcuts `false`, `cmdtext "Store "`; Escape |
| 10 | `input.begin`; `input.press STORE` | held, `modeOp m30`; at 600 ms `modeChange.state = active`, hold `held`, `feedback.read commandText = "Store "` |
| 11 | `input.press THRU` during the hold | `[mode-conflict] ... shortcuts on for shortcut hold STORE ...; this route needs them off; wait for the restoration (60 ms after its last event) or release its holds`; nothing typed |
| 12 | `input.release`; `input.end` | `retained`, `releaseOutcome dispatched`; then `released`, shortcuts `false` |
| 13 | Macro 116 fired (off at +2 s, on at +7 s); `input.begin`; `input.press STORE` | held with the mode enabled (`m31`) |
| 14 | at +2.1 s (poll) | `modeChange == nil`, `lastModeChange.restoredBy = operator`, `interference: the mode was changed back by someone else while the operation was active`; the hold stays `held` (nothing written) |
| 15 | `input.release` | `unresolved`: `release was dispatched with the stored tuple, but the route changed during the hold (keyboard shortcuts are now inactive (were active)) and the effect cannot be confirmed` |
| 16 | `input.press NUM5` | `[conflict] text route NUM5 refused: STORE (hold h47) is unresolved ...` |
| 17 | at +7.3 s: `input.recover` | 1 released (`dispatched`) through the stored tuple; the record reports `routeRestored { previous: keyboard shortcuts are now inactive (were active) }` |
| 18 | reads | shortcuts **on** (the operator's state, untouched by the module), `cmdtext "Store "`; Escape; shortcuts set off for the next step |
| 19 | `input.routing { policy = {} }`; `input.releaseAll`; `input.close`; final reads | 0 overrides; `holds 0, unresolved 0, quarantined 0`, no busy, no mode change; shortcuts off as found; command line empty; `MASTATE` false; Macro 116 verified and deleted |

## Observations worth keeping

- The restore delay (60 ms) is shorter than a client round trip, so consecutive text taps from a client each get
  their own operation; they join only inside one `input.sequence` or when a surface presses from the loop.
- A route check (`routeMismatch` / `routeRestored`) runs on presses, releases and recovery, not in `service()`: the
  interference shows up first on the mode operation (`lastModeChange.restoredBy = operator`) and on the next release.
- After an operator interference the module leaves the mode where the operator put it; the stuck record is the only
  thing it recovers, through the stored tuple once the route is back.
