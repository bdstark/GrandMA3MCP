# KB-13 probe: owned-Quickey input backend — macOS, onPC 2.5.1.0

Date: 2026-10-09. Evidence for [KEYBOARD.md](../../KEYBOARD.md) "KB-13 — Production Quickey input backend"
(hardkeys 0.8.0, bridge 0.10.0). Question under test: does the `quickey` backend press and release real console keys
through the KB-12 bank on its reserved executors, with the ownership, duplicate, recovery and restart behaviour of the
keyboard backend, and does it refuse everything the KB-10 evidence does not cover?

**Result: qualified on the disposable show, 47/47 automated checks** ([script report](kb-13-quickey-macos-2.5.1.json),
`node scripts/kb13-probe.mjs run`, final run after the review fixes below). A NUM5 tap put `5` on the command line through `Assign Quickey 949 At Page 1.180`
and `Press`/`Unpress Page 1.180`; an OOPS tap on the same executor removed it; an MA1 hold set `MASTATE` true until its
release and a repeated press of the held key was answered with the same record and no second dispatch; the MA1+STORE
chord on executors 180/181 produced `Record`; the `Fixture 1 Thru 5 Please` sequence selected 5 fixtures with the command
line left empty and a CLEAR tap cleared them. ESC and GO (discovered-only codes), a raw PC key, the Keyboard() key MA and a
chord of a non-chord code were refused before anything was issued. An executor reassigned by the operator during an MA1
hold made the release refused (`Page 1.180 holds the bank's THRU, not the recorded Quickey 900 (MA1)`), left the key down
(`MASTATE` true), kept the record unresolved and its executor reserved, and the next press took executor 181; after the
operator restored the assignment, `input.recover` released through executor 180 and `MASTATE` went false. A bridge restart
with such a stuck hold kept the record and its executor target, adopted both with the bank, refused all new input as
`[busy]` until the operator's `input recover` released it through the recorded executor. `bank teardown` was refused
`bank-in-use` while MA1 was held. Not exercised live: save/reload of the show, a `Press` the console rejects or a raise
during dispatch (harness only), the chord and hold evidence for codes other than the nine KB-10 codes (none is dispatched).

| Item | Value |
| --- | --- |
| Host | macOS, onPC 2.5.1.0 Release, hostname `bdsmbpm401` |
| Show / user | `mcp-test-disposable`, Admin, data pool `Default`; show not saved |
| Bridge / modules | gma3_mcp_bridge 0.10.0 (`lua input=keyboard` at install, then `bank=900/1.180-187` and `input=quickey`), gma3_mcp_hardkeys 0.8.0, gma3_mcp_feedback 0.2.0; repo working tree of the KB-13 change |
| Invocation | `node scripts/kb13-probe.mjs run --out docs/probes/kb-13-quickey-macos-2.5.1.json` over one TCP connection (reconnecting after the restart); plugin arguments through show macros fired with `Cmd("Go+ Macro N")` over the bridge `lua` op: 100 (update + restart), 108 `bank=900/1.180-187`, 114 `input=quickey`, 115 (stop + `lua input=quickey`), 113 `bank teardown`, 107 `input=keyboard`; operator actions during holds through the deferred Macro 116 (below); readback with `CmdObj().cmdtext`, `Root().MASTATE` (also through the unguarded `feedback.read` during interactions), `SelectionCount()`, `ObjectList("Page 1.N")`; bridge log `~/MALightingTechnology/gma3_2.5.1/onpc/temp/gma3_mcp_bridge.log` |
| Preconditions | Quickeys 895–1000 empty (1 = `THRU`, operator object, left alone); page 1 executors 180–187 empty; 0 holds; command line empty; `MASTATE` false |

## Console facts found before the run

- **Paged executor press/release works like the KB-10 `Press Executor E`**: with a temporary MA1 Quickey assigned to
  Page 1.180, `Press Page 1.180` set `MASTATE` true and `Unpress Page 1.180` set it false (`Press Executor 180` /
  `Unpress Executor 180` behaved the same). `Unpress Page 1.181` on an empty executor answers `Object not found`. The
  deps therefore issue the paged form (independent of the user's current page) and treat any feedback other than `OK` as
  "not accepted" (nothing changed) and a raise as "unknown".
- **OSC input is not enabled on this onPC** (an OSC `/cmd` left no trace), so an operator action that must happen while
  the bridge is `[busy]` (a hold, an unresolved record) cannot be issued through the bridge or over OSC. The probe writes
  such actions into a deferred macro (Macro 116) with Wait times and fires it through `lua` before the hold starts; the
  console then executes the lines on its own (`Assign Quickey 955 At Page 1.180` after 3 s, the restore after 10 s, or the
  restart/recover chain). The slot is claimed before any key is pressed: an empty slot is created as `MCP kb13 deferred`
  and deleted at the end of the run, a macro of that name from an earlier run is reused and left in place, and any other
  macro in the slot refuses the run (a disposable show name says nothing about who owns a macro); the deferred, restart
  and teardown slots must be distinct.
- `input recover` is the operator's path for a record of a previous run: the bridge's `[busy]` guard refuses `lua`, `cmd`
  and every new press from every connection while that record is unresolved, and the client-side `input.recover` acts on
  the client's own session only.

## Steps

| # | Step | Result |
| --- | --- | --- |
| 1 | `npm run install-plugin`; `Go+ Macro 100` | bridge back in ~10 s: `modules: hardkeys 0.8.0, feedback 0.2.0`, `bridgeVersion 0.10.0` |
| 2 | `Go+ Macro 108`; `Go+ Macro 114` | `bank provision: 95 Quickey(s) created, 0 reused`, `state=ready codes=94 (qualified 9, discovered 85)`; `input now enabled on the quickey backend (console keys are really pressed through the owned Quickey bank on its reserved executors; logical keys use the quickkey method)`; `input.status`: backend `quickey`, `capabilities.keyboard = false`, routing default `quickkey`, 8 limitations |
| 3 | `input.tap NUM5 holdMs 60` | hold `target = { page 1, executor 180, quickeyIndex 949, code NUM5, value 72 }`, `pressOutcome dispatched`; the loop released it (`dispatched`); `cmdtext = "5"` 15 ms later; executor 180 now holds `MCP NUM5` (the assignment stays after the release) |
| 4 | `input.tap UNDO` | routed to the OOPS Quickey (963) on executor 180; command line empty afterwards: the executor tap of OOPS removes the last token like the direct tap (KB-10 row 9) |
| 5 | `input.begin`; `input.press MA1` | target executor 180; `feedback.read maState = true` 13 ms later (read during the interaction) |
| 6 | `input.press MA1` again (same interaction) | `duplicate = true`, same hold id, backend press counter unchanged: a repeated down report does not retrigger |
| 7 | `input.press THRU` next to the held MA1 | `[unsupported] ... does not advertise chord for Quickeys (tap = true, hold = true, chord = false)`; nothing issued |
| 8 | `input.release` (hold id) | `state released`, `releaseOutcome dispatched`, target executor 180; `maState = false`; `input.end` |
| 9 | `input.combo [MA1, STORE] holdMs 200` | two holds on executors 180 and 181 (MA1 900, STORE 943); `cmdtext = "Record "` 12 ms after the release poll; `MASTATE` false afterwards; line cleared with `Keyboard(1,'press','Escape')` |
| 10 | `input.sequence` taps FIXTURE, NUM1, THRU, NUM5, PLEASE | `completed`, counts `{ completed 5 }`; `SelectionCount()` 22 → **5**, command line empty: the digits/keywords/Please ordering is preserved through executor press/release pairs |
| 11 | `input.tap CLEAR` | `SelectionCount()` 5 → 0 |
| 12 | `input.tap ESC`, `input.tap GO` | `[unavailable] ... Quickey code ESC is discovered only (no KB-10 evidence); this backend dispatches only qualified codes (nothing dispatched; no other method is selected)`; same for GO |
| 13 | `input.tap pcKey Enter`; `input.tap MA`; `input.combo [NUM1, NUM5]` | `[unsupported] the owned-Quickey backend dispatches no PC keys`; `[unsupported] Quickey code MA is not an Enums.VirtualKeyCode name`; `[unsupported] key 1 of the combo: Quickey NUM1: the backend does not advertise chord` with `missing = ["chord"]`, command line still empty |
| 14 | Macro 116 fired (`Assign Quickey 955 At Page 1.180` at +3 s, `Assign Quickey 900 At Page 1.180` at +10 s); `input.begin`; `input.press MA1` | target executor 180 |
| 15 | at +3.2 s: `input.release` | `state unresolved`, reason `release refused by the backend: Page 1.180 holds the bank's THRU, not the recorded Quickey 900 (MA1); the key may still be down on the console: restore the assignment and recover (no direct Unpress Quickey is issued)`; `maState` **true** (the key is down and nothing pretended otherwise) |
| 16 | `input.recover` | still unresolved, nothing issued (no re-assignment by the module) |
| 17 | `input.press NUM5` (same interaction) | target executor **181**: the unresolved record keeps 180 reserved; released |
| 18 | at +11 s: `input.recover` | `released` (`dispatched`) through executor 180; `maState` false; `input.end` |
| 19 | Macro 116 fired (reassign at +3 s, `Go+ Macro 115` at +4 s, restore at +18 s, `Plugin "gma3_mcp_bridge" "input recover"` at +19 s); `input.begin`; `input.press MA1` | target executor 180; the connection dropped at the stop |
| 20 | reconnect ~2 s after the restart | `ping.input`: backend `quickey`, `holds 1, unresolved 1, busy = { reason unresolved, owner previous-run, hold h1 }`, bank `ready`; log: `input: 1 unresolved release record(s) kept`, `bank record ... kept for the next start (95 codes)`, `input: 1 unresolved release record(s) from a previous run reserve their keys`, `bank adopt: ... state=ready codes=94 ... problems=0` |
| 21 | `input.status` | the adopted hold: `state unresolved`, `backend quickey`, `quickkey MA1`, `target = { page 1, executor 180, quickeyIndex 900, code MA1, bank gma3_mcp_bridge@q900.e1.180-187 }`, the refusal reason from step 15; `maState` still **true** across the restart |
| 22 | `input.tap NUM5` | `[busy] 1 unresolved release record(s): MA1 (hold h1, session 'previous-run') may still be down (...); recover it (owner recover, or the operator's "input recover") before anything else runs` |
| 23 | at +19 s the macro's `input recover` | log: `input recover released previous-run MA1(quickkey:#1) released (dispatched, effect not observable)`, `input recover: 1 released, 0 still unresolved`; `holds 0, unresolved 0`; `MASTATE` false |
| 24 | Macro 116 fired (`Go+ Macro 113` at +3 s); `input.begin`; `input.press MA1`; wait 4.5 s | log: `ERROR ... bank teardown refused [bank-in-use]: 1 Quickey ownership record(s) are held or unresolved; release or recover them before tearing the bank down (deleting a Quickey during a hold leaves the key down, KB-10)`; bank still `ready`, hold still `held`; `input.end` released it |
| 25 | `input.releaseAll`, `input.close`, final reads | `holds 0, unresolved 0`, not busy, bank `ready`, command line empty, `MASTATE` false; Macro 116 (created by this run) deleted and read back absent |
| 26 | `Go+ Macro 113`; `Go+ Macro 107` | `bank teardown: 95 Quickey(s) removed, 8 executor(s) cleared, 0 object(s) skipped; the bank is gone`; Quickeys 895–1000 empty, executors 180–187 empty, Quickey 1 (`THRU`) untouched; input back on the keyboard backend |

The first run of the script (43/46) failed only on three probe expectations: the `input.release` reply nests the hold
report under `hold`, and new input after the restart is refused `[busy]` (the intended behaviour: conflicting input is
blocked until recovery completes) rather than admitted on another executor. The expectations were corrected and the run
repeated from the same clean state: 46/46. After the PR review of `bfe285b` (chord admission now checks every participating
held key, not only the incoming one; the probe claims and cleans up its deferred macro) the plugin was reinstalled
(Macro 100, bank re-provisioned with 108, `input=quickey` with 114) and the run repeated: 47/47 (the extra check is the
macro cleanup). The held-key chord rule (NUM1 held, then NUM5 refused) is harness-covered; live, the chord steps use
MA1+STORE, both chord-qualified.

## Acceptance report

| Criterion | Answer |
| --- | --- |
| Only qualified tap, press, release and chord; capability limitations advertised | 9 codes dispatch, each with its KB-10 flags (`describeRoute(...).quickkeyCapabilities`, source `code`); ESC, GO and the 83 other discovered codes are `unavailable` before dispatch (step 12); THRU/NUM1 chords refused (steps 7, 13); `status().backend.limitations` lists 8 items; `capabilities.keyboard = false`, `char = false` |
| Duplicate suppression, ordering, press ownership, original-outcome replay | duplicate press answered with the same record and no dispatch (step 6); the sequence preserved digits/keywords/Please order through executor pairs (step 10); ownership and busy rules unchanged from KB-05 (steps 20, 22) |
| Release on the recorded backend and target even after configuration changes; no replacement object released | the release goes to the recorded executor only; a reassigned executor is refused and nothing else is tried (steps 15–16); a Quickey record never goes through another backend and a record without a target is refused (harness) |
| Disconnect, stop and restart attempt releases, retain unresolved failures, block conflicting input | the stop attempted the release (refused, record kept with its target), the restart adopted it, every new input was `[busy]` until recovery (steps 19–23) |
| Existing admission checks; asynchronous ordering; no automatic retry of an uncertain activation | interaction/busy rules applied (steps 5–8, 22); the sequence with an immediate Please was accepted in order (step 10); an unresolved release is only re-attempted by an explicit recover (steps 16, 18, 23) |
| Dispatched vs observed completion; local indication vs console feedback | every press and release is `dispatched`, never `confirmed`; `MASTATE` is reported as an aggregate observation (steps 5, 8, 15, 21); nothing claims a UI effect |
| Simultaneous keys, long holds, rapid sequences, duplicate/reordered packets, interruption, object deletion, backend exceptions | chord (step 9), hold across requests and a restart (steps 5, 19–23), five-step sequence (step 10), duplicate (step 6), interruption by reassignment (steps 14–18); object deletion during a hold, console-rejected `Press`/`Unpress`, raises and the executor-capacity refusal are harness-covered (`test/lua/hardkeys_quickey_test.lua`, 100 checks); reordered packets are a surface concern (KB-07 consumer) |
| Live NX-K qualification for the actual surface path | **not part of this run**: the surface plugin (mtpnxk) has not vendored hardkeys 0.8.0 yet |

## Cleanup

Bank removed by its own teardown (step 26); input back on the keyboard backend. Macros 114 (`MCP input quickey`) and
115 (`MCP bridge restart quickey`) remain in the show as operator tools next to 100–113; they create nothing until fired.
Macro 116 was created and deleted by the probe. Show not saved.
