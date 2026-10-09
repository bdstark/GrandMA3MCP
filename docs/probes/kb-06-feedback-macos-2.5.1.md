# KB-06 console feedback readers — macOS, onPC 2.5.1.0

Date: 2026-10-09. Evidence for [KEYBOARD.md](../../KEYBOARD.md) "KB-06 results". Script report:
[kb-06-feedback-macos-2.5.1.json](kb-06-feedback-macos-2.5.1.json) (`run`, 47/47; a `verify` pass of 38/39 preceded
it, the one failure being a probe-script mistake that read the interaction report instead of its id, fixed before
`run`). `run` changed console state three times on the disposable show (Blind, one fader, one Go+/Off) and restored each.

| Item | Value |
| --- | --- |
| Host | macOS, onPC 2.5.1.0 Release, hostname `bdsmbpm401`, show `mcp-test-disposable`, user Admin, profile `Default`, one physical display |
| Bridge | gma3_mcp_bridge **0.8.0**, updated and started with `lua input=keyboard` from Macro 100 (stop → Delete Plugin 1 → Import → ReloadAllPlugins → start) |
| Modules | gma3_mcp_feedback **0.2.0**, gma3_mcp_hardkeys 0.4.0 |
| Ops | `feedback.describe`, `feedback.read` (never guarded; no input session opened) |
| Driver | `node scripts/kb06-probe.mjs run --out docs/probes/kb-06-feedback-macos-2.5.1.json` over two real TCP connections (A reads, B owns an interaction for one step) |

## `run` (47/47)

| # | Check | Observed |
| --- | --- | --- |
| 1 | `feedback.describe` | module 0.2.0, 16 entries: 15 readers plus the `executorActive` alias |
| 2 | `feedback.read {all, displays [1,2,9]}` | 14 items in 19 ms, `atomic=false`, epoch 1, identity `{mcp-test-disposable, Admin, Default}`; every item with `observedAt`, `epoch`, `scope`, `available`; the two unavailable items (`freeze`, `previewBar[display=9]`) carry a reason and no value |
| 3 | booleans | `blind=true` (the show had Blind on), `highlight=false`, `solo=false`, `shortcutsActive=true`, `maState=false` |
| 4 | strings and objects | `commandText=""`, `lastCommand` = the macro's start line feedback (shared history), `previewMode="Normal"`, `page={Page 1, 1}`, `selectedSequence={selected:true, Default, no 1, addr 14.14.1.7.1}` |
| 5 | displays | `previewBar[display=1]=false`, `previewBar[display=2]=false` (onPC exposes display 2 to `GetDisplayByIndex` with one monitor), `previewBar[display=9]` unavailable "display 9 does not exist on this console" |
| 6 | executors 191–196 (assigned sequences 5527–5532) + 190 | assignment with `page`, `assigned {name, class Sequence, addr, no}`; fader `value=100`, `text="100%"`, `target`; executor 190 `empty=true` and its fader unavailable "executor 190 is empty on the current page" |
| 7 | sequences | `sequenceActive[sequence=1]=false`; `sequenceActive[sequence=999999]` unavailable "not found" |
| 8 | bounds | 40 executors → 64 items (32 executors × assignment + fader) in 52–60 ms, limitation "executors truncated to 32 of 40"; `readers:["sequenceActive"]` alone refused `[no-items]`; the `executorActive` alias answers with `alias=sequenceActive` and a deprecation note |
| 9 | no side effects | command line identical before and after every read; `ping.input`: 0 sessions, nothing busy |
| 10 | busy independence | B `input.begin` (nothing pressed): A's `cmd` and `lua` `[busy]`, A's `feedback.read` answered 3/3 available; B `input.end` released nothing (`attempted 0`) |
| 11 | Blind | initial `true`; `Blind Off` → reader `false` (`lastCommand = "OK: Blind Off"`); `Blind On` → `true` |
| 12 | fader | executor 191 at 100 → `setfader 25` → reader `value=25`, `text="25%"` 150 ms later → restored to 100 and read back (`setfader`'s own same-frame read-back still reported 100: effects land a frame later, which is why the reader is polled after the change) |
| 13 | playback | `Go+ Sequence 5527` → `sequenceActive=true`; `Off Sequence 5527` → `false` |
| 14 | final | command line still empty |

## Observations worth keeping

- `GetDisplayByIndex(2)` returns a handle on a one-monitor onPC: "display exists" does not mean a visible display.
  The reader reports what the console reports and identifies the display in the result.
- `GetFader` returns the level as a number (100, 25) with `GetFaderText` `"100%"`; the reader keeps both.
- The show had Blind on when the probe started; nothing in the probe assumes an initial value.

## Not exercised

- Show load, user switch and profile switch while the bridge runs (the epoch bump is covered by the Lua harness;
  `LoadShow` through the bridge stalls it and needs the operator).
- A second physical display, Windows, other users' scopes (cross-user behaviour remains unverified).
- The module's cached `watch()`/`snapshot()` path (surface consumers; harness only).
