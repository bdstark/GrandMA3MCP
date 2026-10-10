# KB-12 probe: owned Quickey bank provisioning — macOS, onPC 2.5.1.0

Date: 2026-10-09. Evidence for [KEYBOARD.md](../../KEYBOARD.md) "KB-12 — Provision and cache the complete Quickey bank"
(hardkeys 0.7.0, bridge 0.9.0). Question under test: does the module's provisioning create exactly the owned objects it
reports, verify them by readback, survive a bridge restart, detect an operator edit, and remove only what it owns?

**Result: qualified for provisioning, verification, restart adoption and teardown on the disposable show.** `bank=900/1.180-187`
created 94 Quickeys (900–993, one per command-area code discovered from `Enums.VirtualKeyCode`, 52 codes excluded with
reasons) with `Name = "MCP <CODE>"`, `Code = <CODE>` and the ownership marker in `Note`, all reading back as written; the
eight reserved executors stayed empty. `bank verify` reported the one operator edit (`Code` changed on Quickey 949) as
`degraded`/`problems=1` and changed nothing. A bridge restart kept the record and `adoptBank` re-verified all 94 objects
(`state=ready`, nothing created). `bank teardown` removed the 94 Quickeys, cleared 0 executors, skipped 0 objects; Quickeys
1–4 (operator objects) and executors 180–187 were untouched. The paged executor addressing the deps rely on is confirmed:
`Assign Quickey 949 At Page 1.180` assigned (object class `Quickey`), `Delete Page 1.180 /NoConfirmation` cleared the
executor and left the page. Not exercised: save/reload of the show (SaveShow stalls the bridge, operator action), a foreign
owner's or an unowned object inside the range on the console (harness only), teardown while a Quickey hold is live (harness
only), and any Quickey dispatch (KB-13).

| Item | Value |
| --- | --- |
| Host | macOS, onPC 2.5.1.0 Release, hostname `bdsmbpm401` |
| Show / user | `mcp-test-disposable`, Admin, data pool `Default`; show not saved |
| Bridge / modules | gma3_mcp_bridge 0.9.0 (`lua input=keyboard`), gma3_mcp_hardkeys 0.7.0, gma3_mcp_feedback 0.2.0; repo working tree of the KB-12 change |
| Invocation | plugin arguments through show macros fired with `Cmd("Go+ Macro N")` over the bridge `lua` op: 100 (update + restart), 108 `bank=900/1.180-187`, 109 `bank status`, 112 `bank verify`, 113 `bank teardown`, 101 (restart); readback with `ObjectList("Quickey N")`, `ObjectList("Page 1.N")`, `Root().MANetSocket:Get("ShowFile")`; bridge log `~/MALightingTechnology/gma3_2.5.1/onpc/temp/gma3_mcp_bridge.log` |
| Preconditions | Quickeys 895–1000 empty (1 = `THRU`, 2–4 empty existed and were left alone); page 1 executors 101–190 and 199 empty, 191–198 hold the operator's `LOS2` sequences; 0 holds |

## Console facts found before the run (they changed the deps)

- `ObjectList("Page 1.190")` is **nil for an empty executor** (like `GetExecutor(190)`); the paged object exists only once
  something is assigned. The deps therefore report a nil result as `empty` when `ObjectList("Page P")` exists and the number
  is 1–999, never as `missing`. `ObjectList("Page 1.191")` on an assigned executor returns class `Executor` with `Object`.
- `ShowData().name` is the literal `"ShowData"`; the show file name is `Root().MANetSocket:Get("ShowFile")`
  (`mcp-test-disposable`). The bank's show identity is `<ShowFile>|<DataPool name>`.
- `DataPool().Pages:Count()` returned 9999 (not the number of existing pages); `ObjectList("Page P")` is the existence check.

## Steps

| # | Step | Result |
| --- | --- | --- |
| 1 | `npm run install-plugin`; `Go+ Macro 100` | bridge back in ~10 s: `modules: hardkeys 0.7.0, feedback 0.2.0`, `bridgeVersion 0.9.0` |
| 2 | `Go+ Macro 108` (`bank=900/1.180-187`) | log `bank provision: 94 Quickey(s) created, 0 reused` and `bank ... state=ready codes=94 (qualified 9, discovered 85) problems=0 ... show='mcp-test-disposable|Default'`. Readback: Quickeys 900–993 present, `MCP MA1`…`MCP LOCATE`, `Code` = the name, `Note` = `gma3_mcp_hardkeys-bank v1 owner=gma3_mcp_bridge bank=gma3_mcp_bridge@q900.e1.180-187 code=<CODE> exec=1.180-187`; executors 180–187 empty |
| 3 | `ping` (gma3_status) | `input.bank = { provisioned true, id gma3_mcp_bridge@q900.e1.180-187, state ready, codes 94, qualified 9, problems 0 }` |
| 4 | `Go+ Macro 109` (`bank status`) | 9 `bank code` lines for the KB-10 codes with their tap/hold/chord flags and notes (MA1 at 900, FIXTURE 933, STORE 943, NUM1 945, NUM5 949, THRU 955, PLEASE 961, OOPS 963, CLEAR 964); 52 `bank excluded` lines (value-0 placeholders, XKEYS, X1–X16, EXEC, FADER, DEF_GO/PAUSE/GOBACK, ENCODER_*, FLASH…RECORD, ONPC_SCREEN2–7; UNDO folded onto OOPS) |
| 5 | Lua: `Assign Quickey 949 At Page 1.180`; read; `Delete Page 1.180 /NoConfirmation`; read | `OK`; executor 180 class `Executor`, `Object` = `MCP NUM5` class `Quickey`; `OK`; executor 180 nil again, `Page 1` still exists, 181 untouched |
| 6 | Lua: `Quickey 949:Set("Code","NUM6")`; `Go+ Macro 112` (`bank verify`) | `bank verify: ... state=degraded ... problems=1`; `ERROR ... problem quickey 949: Code is NUM6 (marker NUM5), expected NUM5`; the object was not changed by the bridge |
| 7 | Lua: `Set("Code","NUM5")`; `Go+ Macro 101` (stop + restart) | at stop: `input: bank record gma3_mcp_bridge@q900.e1.180-187 kept for the next start (94 codes); nothing on the console was changed`; at start (2 s later): `bank adopt: bank ... state=ready codes=94 ... problems=0`, no `Store` issued |
| 8 | `Go+ Macro 113` (`bank teardown`) | `bank teardown: 94 Quickey(s) removed, 0 executor(s) cleared, 0 object(s) skipped; the bank is gone`; readback: Quickeys 895–1000 empty, executors 180–187 empty, Quickeys 1–4 unchanged (`THRU/THRU`, `Quickey 2`–`4` empty); `ping.input.bank = { provisioned false }` |

## Second run (review fixes: show gate, executor identity, visible reservations)

Same day, same show, after the PR review of `1fba8f9`. The bank now carries a code-less placeholder Quickey
(`MCP RESERVED`, marker `code=RESERVED`) assigned to every reserved executor, executor ownership is verified by the assigned
Quickey's pool index, marker and Code, and every target/executor/teardown access re-reads the show identity first.

| # | Step | Result |
| --- | --- | --- |
| 9 | `npm run install-plugin`; `Go+ Macro 100` | `modules: hardkeys 0.7.0`, bridge 0.9.0 |
| 10 | `Go+ Macro 108` | `bank provision: 95 Quickey(s) created, 0 reused`, `state=ready codes=94 ... problems=0`. Readback: Quickey 994 = `MCP RESERVED`, `Code` empty, marker `code=RESERVED exec=1.180-187`; executors 180–187 each hold it (`Object.name = MCP RESERVED`, `Object.index = 994`, `Code` empty): the reservation is an object on the console, and `obj.index` reads the pool index |
| 11 | `Go+ Macro 101` (stop + restart) | `bank record ... kept for the next start (95 codes)`; 2 s later `bank adopt: ... state=ready codes=94 ... problems=0`: the placeholder entry and the eight reservations verified, nothing created or assigned |
| 12 | `Go+ Macro 113` | `bank teardown: 95 Quickey(s) removed, 8 executor(s) cleared, 0 object(s) skipped; the bank is gone`; readback: Quickeys 895–1000 empty, executors 180–187 empty, Quickey 1 (`THRU`) untouched |

The show gate (`bank-stale` on another show for target, executor and teardown access, verify staying `stale`), the
look-alike executors (same name, marker copy at another index, changed Code) and the second-owner refusal
(`executor-foreign-owner`) are harness-covered (`test/lua/hardkeys_bank_test.lua`, 104 checks); loading another show was
not exercised live.

## Acceptance report

| Criterion | Answer |
| --- | --- |
| Explicit authorization and operator-selected range | plugin argument only (`bank=900/1.180-187`); the module refuses without `authorized = true` before reading anything (harness) |
| Complete qualified set, aliases, exclusions | 94 codes from the 149-entry enum; `UNDO` folded onto `OOPS`; 52 exclusions each with a reason; 9 codes carry KB-10 qualification, 85 are discovered only |
| Executors reserved and validated | 180–187 preflighted empty and reserved by assigning the placeholder (step 10), visible to other consumers as a foreign marker; paged assign/clear syntax confirmed (steps 5, 10, 12) |
| Preflight before creating, recheck before mutation, no overwrite | preflight passed on empty slots live; refusals and the recheck-before-create path are harness-covered (`slot-occupied`, `bank-foreign-owner`, `bank-mismatch`, `executor-occupied`, race at the recheck) |
| Ownership beyond labels | marker + Code + Name all verified by readback; an edited Code made the entry `changed` and dispatch would be refused (`bankTarget`, harness); live verify reported it (step 6) |
| Reuse after identity/config verification; cache invalidation | restart adoption re-verified 94 objects, created nothing (step 7); the show-identity staleness check is harness-covered (show not reloaded live) |
| Refuse dispatch through changed objects, no silent repair | the edit stayed in place after verify (step 6); refusal is harness-covered (no Quickey dispatch exists yet, KB-13) |
| Partial setup failure removes only new, owned, unchanged objects | harness only (fake create/set failures, racing writer) |
| Release-all separate from teardown; unsafe deletion refused | harness only (`bank-in-use` while a Quickey hold is live); live teardown ran with 0 holds |
| Bank ownership across consumers | a second owner is refused on the Quickey slots (`bank-foreign-owner`) and on the executors (`executor-foreign-owner`, through the placeholder marker); harness; nothing shared |
| Persistence and ownership recovery on a disposable show | restart: yes (step 7). Save/reload: **not exercised** (SaveShow/LoadShow are operator actions that stall or restart the bridge) |

## Cleanup

Bank removed by its own teardown (step 8). Macros 108, 109, 112, 113 (`MCP bank provision/status/verify/teardown`)
remain in the show as operator tools next to 100–107; they create nothing until fired. Show not saved.
