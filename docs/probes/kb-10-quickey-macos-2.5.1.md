# KB-10 probe: programmatic Quickey dispatch (`Press`/`Unpress`) — macOS, onPC 2.5.1.0

Date: 2026-10-09. Evidence for [KEYBOARD.md](../../KEYBOARD.md) "KB-10 — Qualify programmatic Quickey dispatch".
Question under test: can Lua activate and release Quickeys repeatably, and which of tap, press/hold, release and
chord are actually available? Companions: [kb-10-cmdtext-write-macos-2.5.1.md](kb-10-cmdtext-write-macos-2.5.1.md)
(`CmdText` is read-only) and [kb-10-macro-append-macos-2.5.1.md](kb-10-macro-append-macos-2.5.1.md) (macro insertion).

**Result: qualified for tap, press/hold, release and chords, through an executor.** A Quickey addressed directly
(`Press Quickey N`, `Unpress Quickey N`, `Go+ Quickey N`, `Quickey N`) is always a **tap**: every one of those verbs
performs one complete activation, so a direct `Unpress` is a second tap and MA1 never holds. A Quickey **assigned to an
executor** and driven with `Press Executor N` / `Unpress Executor N` gives a real key-down that persists until the
`Unpress` (verified across requests and over a 1-minute hold), so MA1 held this way turns STORE into `Record`. Effects
are **synchronous** in the same Lua chunk (no frame delay, unlike the macro path), with one exception: while the Edit
Command pop-up or any other text field has focus, digit Quickeys are delivered a frame late while keyword Quickeys
land immediately, so `1 Thru 5` arrives as `5 Thru 15`. Text-producing Quickeys follow the **focused input** exactly
like real keys (digits and `Thru` went into a Label pop-up's Name field). Release after interruption needs care:
reassigning, clearing or deleting the executor or its Quickey during a hold leaves the key down. For **MA1** a direct
`Unpress Quickey N` on an object carrying the MA1 code (a recreated one included) released it; for **NUM5** the same
direct `Unpress` inserted a second `5`, so a direct `Unpress` is a tap that re-activates non-latching keys and recovery
must be qualified per code. `Oops` on an empty command line
is **Undo** and reverted an executor assignment and probe-object property writes; `ESC` as a Quickey never touched the
command line; a 2 s executor hold of STORE did **not** open the Store Settings pop-up.

| Item | Value |
| --- | --- |
| Host | macOS 26.5.1 (25F80), onPC 2.5.1.0 Release, hostname `bdsmbpm401`, Apple M4 Pro |
| Show / user / profile | `mcp-test-disposable`, Admin, profile `Default` |
| Displays | onPC windowed on the display captured by desktop control (the "Display 1" window); Quickey pool window open in the layout |
| ShCuts at start | **off**; switched on for one pass from Lua and restored to off |
| Bridge / modules | gma3_mcp_bridge 0.8.0 (`lua input=keyboard`), gma3_mcp_hardkeys 0.4.0 (sha256 `6634bab8…7415`), gma3_mcp_feedback 0.2.0 (sha256 `349bb2ed…2cf9`), modules.lock revision `9da1454`; repo `fc9bd21` |
| Invocation | Lua chunks through the bridge `lua` op on the plugin thread; `Cmd("Press Quickey N")`, `Cmd("Press Executor N")` etc. Readback: `CmdObj().cmdtext` / `lastcommand`, `Root().MASTATE`, `SelectionCount()` |
| Keyboard | no physical key and no NX-K was used; the only desktop input was mouse clicks to open pop-ups and `Keyboard(1,'press','Escape')` injections to clear the line. Screenshots through desktop control (full-screen tools; onPC exposes no accessibility windows) |
| Preconditions | `ping.input`: 0 holds, 0 unresolved, nothing busy; `MASTATE=false`; the command line held an operator leftover `1 Thru ` (cleared with an injected Escape before step 1); Quickeys 1–4 existed (1 = `THRU`, 2–4 empty) and were left untouched; executors 190 and 199 on Page 1 were empty and were used for the executor path |

## Quickey codes on this console

- `Enums.VirtualKeyCode` has **149** entries: values 1–146 are the 146 entries of `Root().VirtualKeys` (one object per
  code, names `VirtualKey N`, index = value), plus value 0 twice (`""` and `UNKNOWN`) and one alias, `UNDO = 86 = OOPS`.
  So the **discovered** code set is **146 names**, not 110; discovery is not qualification (see "Tested codes" below). Full list (value:name): 1 MA1, 2 MA2, 3 PREV, 4 NEXT, 5 SET,
  6 UP, 7 SELFIX, 8 DOWN, 9 MENU, 10 HIGHLIGHT, 11 SOLO, 12 FREEZE, 13 PREVIEW, 14 BLIND, 15 XKEYS, 16 PAGE_UP,
  17 PAGE_DOWN, 18 LIST, 19–34 X1–X16, 35 EXEC, 36 FADER, 37 DEF_GO, 38 DEF_PAUSE, 39 DEF_GOBACK, 40 PAUSE,
  41 GOBACK, 42 GO, 43 LEARN, 44 GOBACKFAST, 45 GOFAST, 46 ON, 47 OFF, 48 MOVE, 49 COPY, 50 DELETE, 51 ALIGN,
  52 STOMP, 53 HELP, 54 SELECT, 55 GOTO, 56 FIXTURE, 57 CHANNEL, 58 GROUP, 59 SEQUENCE, 60 CUE, 61 PRESET, 62 EDIT,
  63 ASSIGN, 64 TIME, 65 UPDATE, 66 STORE, 67–76 NUM0–NUM9, 77 PLUS, 78 THRU, 79 MINUS, 80 DOT, 81 IF, 82 AT,
  83 SLASH, 84 PLEASE, 85 FULL, 86 OOPS (alias UNDO), 87 CLEAR, 88 ESC, 89–98 ENCODER_INSIDE1/OUTSIDE1 … 5,
  99 USER1, 100 USER2, 101 FLASH, 102 BLACK, 103 KILL, 104 RATE1, 105 TEMP, 106 TOGGLE, 107 TOP, 108 LOAD,
  109 LOWLIGHT, 110 GOSTEP, 111 SWAP, 112 HALF_SPEED, 113 DOUBLE_SPEED, 114 RECORD, 115 PREV_X, 116 PREV_Y,
  117 PREV_Z, 118 PREV_STEP, 119 NEXT_X, 120 NEXT_Y, 121 NEXT_Z, 122 NEXT_STEP, 123 STEP, 124 TOGGLE_STEP,
  125 TOGGLE_MATRICKS, 126 RESET_MATRICKS, 127–132 ONPC_SCREEN2–7, 133 ASTERISK, 134 FIX, 135 CLONE, 136 GRID,
  137 LAYOUT, 138 TIMECODE, 139 VIEW, 140 DMX, 141 PHASER, 142 MACRO, 143 PAGE, 144 EXECUTOR, 145 FLIP, 146 LOCATE.
- Tested codes: NUM1, NUM5, THRU, FIXTURE, PLEASE, CLEAR (taps and executor press/release); STORE and MA1 (executor holds);
  OOPS and ESC (taps, with the behaviours noted below). Every other code is discovered only, and a provisioned bank must
  not advertise it as functional until it has its own evidence.
- Exclusions to decide at provisioning time (not tested here): the encoder codes (89–98), `ONPC_SCREEN2–7`, `XKEYS`,
  `X1–X16`, `EXEC`/`FADER`/`DEF_*` and the executor-button functions (101–114) are not command-area hardkeys. `UNDO` must
  be deduplicated against `OOPS`.
- The `Quickey` object: property `CODE` (enum `VirtualKeyCode`, Int32, writable), plus `NAME`, `NOTE`, `LOCK`, `SCRIBBLE`,
  `APPEARANCE`, `TAGS` and the usual read-only pool fields. **No property reports the pressed/LED state.** The executor
  object has no readable press state either (its property set was identical while STORE was held and after release); it
  does carry `KEYPRESS` / `KEYUNPRESS` / `MAKEYPRESS` / `MAKEYUNPRESS` configuration, which is how the executor path maps
  button down/up to Quickey press/unpress.
- `Enums.AssignmentButtonFunctionsQuickey` = `{Empty=0, Go+=3}`: an executor button holding a Quickey only offers `Go+`.
- Creation from Lua works: `Cmd('Store Quickey N /NoConfirmation')`, then `handle:Set('Code','NUM5')` and `Set('Name',…)`
  (both read back correctly). `Edit Quickey 4 Property 'Code'` from the command line is the operator's failed attempt in
  the history; it was not retried here.

## Probe objects

Quickeys **900–909** (all empty before) with codes NUM5, THRU, PLEASE, STORE, MA1, CLEAR, OOPS, ESC, NUM1, FIXTURE,
named `KB10 <code>`; executors **190** (MA1) and **199** (reassigned between NUM5, STORE and ESC). Everything was
deleted at the end (`Delete Quickey N /NoConfirmation`, `Delete Executor 190/199`), slots verified empty, Quickeys 1–4
unchanged, show not saved.

## Steps

"Imm." is the readback inside the same Lua chunk right after the `Cmd`; "next" is the next bridge request. ShCuts off
unless stated. `ma` = `Root().MASTATE`.

### Direct addressing

| # | Step | Imm. readback |
| --- | --- | --- |
| 1 | `Press Quickey 900` (NUM5) on an empty line | `5` (synchronous), `lastcommand = OK: Press Quickey 900`, ma false |
| 2 | `Unpress Quickey 900` | `55` — Unpress is itself a tap |
| 3 | `Press` / `Unpress` again | `555`, `5555` |
| 4 | `Go+ Quickey 900` | `55555` |
| 5 | `Quickey 900` (bare) | `555555` |
| 6 | `Press` then `Unpress Quickey 907` (ESC) | `555555` unchanged: ESC as a Quickey does not clear the line |
| 7 | injected Escape; `Press Quickey 904` (MA1) | ma false immediately and on the next request (feedback.read) |
| 8 | `Press Quickey 903` (STORE) with 904 "pressed" | `Store ` (no `Record`: direct MA1 is not held); `Unpress 903` added nothing; `Unpress`/`Press`/`Unpress 904` ma false throughout |
| 9 | `Press Quickey 906` (OOPS) with `Store ` on the line | line empty: Oops removes the last token synchronously |
| 10 | `Unpress Quickey 900` alone on an empty line | `5` — a lone Unpress is a tap |
| 11 | `Press 909, 908, 901, 900` (Fixture 1 Thru 5) in one chunk | `1 Thru 5` (default keyword Fixture is implicit on screen); `Press 902` (PLEASE) → line empty, `SelectionCount() 22 → 5`, all in the same chunk with no delay |
| 12 | `Press Quickey 905` (CLEAR) | selection 5 → 0 synchronously; second press no change |
| 13 | ShCuts **on** via Lua; same Fixture 1 Thru 5 Please | identical: selection 5; `ClearSelection`; ShCuts restored off |
| 14 | `Press 908`; `Press` + `Unpress Quickey 907` (ESC) | `1` unchanged |
| 15 | `Press Quickey 906` (OOPS) twice on `1` then on an **empty** line | `1` → empty, then the second Oops **undid `ClearSelection`** (selection back to 5): Oops on an empty line is Undo |

### Executor path (Quickey assigned to an executor)

| # | Step | Readback |
| --- | --- | --- |
| 16 | `Assign Quickey 904 At Executor 190`, `Assign Quickey 903 At Executor 199` | `GetExecutor(190):Get('Object') = Quickey 904`, 199 = Quickey 903 |
| 17 | `Press Executor 190` (MA1) | **ma true** immediately |
| 18 | `Press Executor 199` (STORE) while 190 held | **`Record `** on the line, ma true — a real MA+STORE chord |
| 19 | `Unpress Executor 199`; `Unpress Executor 190` | `Record ` stays; ma true → **false** after the MA release |
| 20 | `Press Executor 190`, chunk ends; next request | ma still **true** (hold persists across requests); `Unpress` → false |
| 21 | 199 = NUM5: `Press Executor 199` / `Unpress` | `5` on press, **nothing on release**; a second `Press` without release inserts again (`55`, `555`): no debounce |
| 22 | `Go+ Executor 190` (MA1) | ma true; `Go+` again: true; `Off Executor 190`: **still true**; `Press`/`Unpress 190`: false. `Go+` is a press without release; only `Unpress` releases |
| 23 | `Press Executor 190`, then `Unpress Quickey 904` directly | ma **false**: a direct `Unpress` releases an executor-held key; a direct `Press Quickey 904` afterwards stays a tap (false) |
| 24 | `Press Executor 190`, reassign `Quickey 903` to 190 during the hold, `Unpress Executor 190` | ma stays **true** (stuck); reassigning 904 back: still true; `Unpress Executor 190` with 904 reassigned: **false** (recovered) |
| 25 | `Press Executor 190`, `Delete Quickey 904` during the hold | ma true; executor 190 became empty; `Unpress Executor 190` → `Object not found`, ma true; recreate Quickey 904 with code MA1, `Unpress Quickey 904` → **false** (release is keyed by code, not object identity) |
| 26 | `Press Executor 190`, `Delete Executor 190` during the hold | ma true; `Unpress Executor 190` → `Object not found`; `Unpress Quickey 904` → **false** |
| 26a | 199 = NUM5: `Press Executor 199` (`5`), `Delete Executor 199` during the hold, `Unpress Executor 199` → `Object not found`; `Unpress Quickey 900` directly | **`55`**: the direct Unpress re-activated the non-latching key instead of only releasing it |
| 27 | 199 = NUM5 held for about one minute across requests | `5` only, no auto-repeat, nothing executed; `Unpress` → `5` stays |
| 28 | `Press Executor 190` (MA1) then `Press Executor 199` (NUM5), both held across a request | **no text** (MA+5 is a different function), nothing executed; released in either order, ma false at the end |
| 29 | `Go+ Executor 199` (NUM5), `Off Executor 199` | `5`, then `55`: Off is also a tap on a non-latching key |
| 30 | 199 = ESC: `Press`/`Unpress Executor 199` with `5` on the line | `5` unchanged |
| 31 | 199 = STORE: `Press Executor 199`, screenshot after ≥ 2 s, `Unpress` | `Store ` on the line, **no Store Settings pop-up**; executor property dump identical held vs released |

### Executor press/release pairs for sequences

Steps 11–15 and 32–36 use direct addressing (taps). The following repeats the ordering cases through executor press/release
pairs, alternating executors 190 and 199 and reassigning the Quickey before each pair, which is the dispatch shape the
proposed backend would use.

| # | Step | Result |
| --- | --- | --- |
| 11a | No pop-up: `Assign` + `Press` + `Unpress Executor` for FIXTURE, NUM1, THRU, NUM5, PLEASE in one chunk | `SelectionCount()` 0 → **5** inside the chunk, command line empty: ordered and synchronous, immediate Please accepted |
| 35a | Edit Command pop-up open, empty: same pairs for NUM1, THRU, NUM5 | imm. ` Thru `, next request and on screen **` Thru 15`**: the digit-after-keyword reordering applies to the executor path as well |

### Focus and pop-ups (desktop control, onPC frontmost)

| # | Step | Result |
| --- | --- | --- |
| 32 | Keyboard icon → Edit Command pop-up open, empty; `Press 900` then `Press 901` in one chunk | imm. ` Thru ` (digit missing); next request and on screen (pop-up and command line) **` Thru 5`**: the digit was delivered a frame late and after the keyword |
| 33 | Pop-up closed (injected Escape), `Press 900` with onPC frontmost | imm. `5`: synchronous again; `908, 901, 900` → imm. `51 Thru 5` in order |
| 34 | Pop-up reopened, empty; `Press 900` | imm. empty, next request `5` |
| 35 | Pop-up open; `Press 908, 901, 900` | imm. `5 Thru `, next request and on screen **`5 Thru 15`**: digits keep their own order but all land after the keywords |
| 36 | `Edit Quickey 909` → editor → Name → Label pop-up with the Name field focused; `Press 900`, then `Press 901` | Name field **`5 Thru`**, command line empty both times: text-producing Quickeys go to the focused input, keyword included; cancelled with Esc, name unchanged |

Undo side effect observed during the run: after the Oops/Undo presses, executor 190's assignment and Quickey 909's
name and code (set from Lua) had been reverted; 909 showed `Quickey 909` with an empty Code in its editor.

## Acceptance report

| Criterion | Answer |
| --- | --- |
| Codes enumerated | 149 enum entries = 146 real codes (`Root().VirtualKeys`) + two zero entries + alias `UNDO`→`OOPS`; recorded above |
| Exact Lua invocation for tap / press / release | Tap: `Cmd('Press Quickey N')` (or `Unpress`/`Go+`/bare, all equivalent). Press and release: assign the Quickey to an executor, then `Cmd('Press Executor E')` / `Cmd('Unpress Executor E')`. `Go+ Executor E` presses without releasing. Executors are required for holds; the button function available is only `Go+` |
| Digits / Thru with ShCuts on and off | identical, synchronous, no shortcut row involved |
| Store hold/release, MA combos, simultaneous keys | Store hold works (`Store ` stays, no pop-up); MA1+STORE on two executors gives `Record `; MA1+NUM5 produces nothing (console's own MA+digit meaning); release order does not matter |
| Release after interruption | reassign/clear/delete during a hold leaves the key down; `Unpress Executor` fails with `Object not found` once the executor is empty. For MA1 a direct `Unpress Quickey N` on an object carrying that code (recreated included) released it; for NUM5 it inserted a second `5`. Recovery is qualified for MA1 only; every other code needs its own evidence, and an uncertain release must never be retried through a direct `Unpress` |
| Clear / Oops / Esc / Please separately | CLEAR and PLEASE act synchronously; OOPS removes the last token and is **Undo** on an empty line (reverted show data in this run); ESC never affected the command line, directly or through an executor |
| Rapid digits + Please without delay | works in one chunk outside a pop-up, both as direct taps and as executor press/release pairs (`1 Thru 5` + PLEASE → selection 5). Dispatch is synchronous and ordered; with a text pop-up focused digits are queued one frame behind keywords on both paths |
| Command line, Edit Command, independent pop-up field | command line and pop-up show the same buffer; the independent Name field received both digits and `Thru`; caret at end in every case (no mid-line test was possible without typing) |
| Held/latched state at the end | 0 holds, ma false, selection 0, command line empty, ShCuts off; probe objects removed; show not saved |

Qualification: **tap, press, release and chord qualified through the executor path for the tested codes**; direct
`Press Quickey` qualified as tap only. Not qualified: long-press pop-ups, any readback of key/LED state, Esc as a Quickey,
recovery of stuck keys other than MA1, and every discovered code without a tested row above.

## Consequences for KB-11/12/13

- The production backend needs **one executor per concurrently held key** (or per key, for simplicity) in addition to the
  Quickey bank; provisioning must reserve executors (KB-12 "if dispatch requires executors").
- Release must be attempted on the recorded executor. A direct `Unpress Quickey N` is a tap on this console: it released
  a stuck MA1 but re-activated NUM5, so it is not a generic fallback. Recovery for any code other than MA1 has to be
  qualified separately, and an uncertain release must be retained for the operator rather than retried this way. A
  replacement object at the same index with a different code must never be unpressed.
- Oops is Undo on an empty command line and can revert the module's own show-data changes; never use it as a "clear".
- Text keys follow focus; a text pop-up reorders digits behind keywords within one chunk, on the direct and on the executor
  path. Dispatching one key per console frame is an untested idea for avoiding this, not a demonstrated mitigation; until
  it is probed, a backend must document the limitation.
- No readback exists for a Quickey's pressed state; `MASTATE` remains the only aggregate observable.

## Limitations

- One onPC, one user/profile, one show; no NX-K, no physical keys; the Store Settings pop-up was only checked by eye
  after ≥ 2 s. Screenshots were viewed during the run and not stored. Latching MA1/MA2 from the pool (hint in the manual)
  and X-keys/layout assignment were not exercised. Twice during the run a lone `5` on the command line executed as
  `Fixture 5` between two bridge requests. The cause is **unexplained**: operator keyboard input is suspected because both
  events coincided with desktop-control approval dialogs, but a 1-minute hold and a hold with MA stuck did not reproduce
  it, and failure to reproduce does not establish the cause.
