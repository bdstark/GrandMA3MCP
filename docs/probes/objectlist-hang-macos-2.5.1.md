# ObjectList over an executor range hangs onPC — macOS, onPC 2.5.1.0

Date: 2026-10-13. Evidence for the bridge 0.20.0 page/executor range guard
([reference.md](../reference.md#page-and-executor-ranges-plugin-v0200)). Question under test: which of the two read-only
`objects` requests that froze onPC on 2026-10-13 never returns, and what is the smallest form that does it?

**Result: `ObjectList` over an executor range never returns, whether the executors are empty (`Page 1.180 Thru 1.181`)
or assigned (`Page 1.191 Thru 1.192`).** The DataBase task hangs
(`onpc/temp/watchdog_status` reads `DataBase;Graphics;`), the bridge stops answering, the UI ignores clicks, and onPC has to
be quit and relaunched. Fields are not needed (the probe sent none). `ObjectList("Sequence 9000 Thru 9001")` (missing
sequences above the highest one) answers at once with nothing. The bridge cannot interrupt the call (it is C code and the
console's own hook is preserved), so 0.20.0 never hands a page/executor list to `ObjectList`: it expands
`Page P.E Thru P.E2`, `Page P Thru P2` and `+` lists into single `Page P` / `Page P.E` lookups and refuses every other
multi-object Page/Executor form with `[unsafe-range]`.

| Item | Value |
| --- | --- |
| Host | macOS, onPC 2.5.1.0 Release, hostname `bdsmbpm401` |
| Show / user | `mcp-test-disposable`, Admin; the operator saved the show before the first attempt |
| Bridge | gma3_mcp_bridge 0.18.0 as stored in the show (`lua`, `luahook=preserve`), later 0.20.0 from this change |
| Invocation | one `gma3_objects` call per attempt, only after the operator agreed (a hang costs an onPC relaunch); the console state between attempts was checked with `gma3_status` and the bridge log `~/MALightingTechnology/gma3_2.5.1/onpc/temp/gma3_mcp_bridge.log` |
| Preconditions | sequences 1–5534 (426 exist, 9000–9999 empty); page 1 has 28 executors, 180–190 empty, 191–198 assigned (the operator's `LOS2` sequences) |

## The original incident

The SB-01 session sent two `gma3_objects` calls in parallel over one connection: `Page 1.180 Thru 1.190` with fields
`Object`, `Key`, `Fader`, and `Sequence 9000 Thru 9999`. Both timed out after 30 s. The bridge serves requests one at a
time, the page request was sent first, and the bridge log was silent from the client connect on (successful reads are not
logged). A thread sample showed onPC mostly waiting (about 17 % CPU), not spinning.

## Steps

| # | Request (`gma3_objects`) | Result |
| --- | --- | --- |
| 1 | `Sequence 9000 Thru 9001` (no fields) | answered at once: `total 0`; bridge still answering |
| 2 | `Page 1.180 Thru 1.181` (no fields) | **hang**: `timeout after 30000ms`, `ping` times out, watchdog `DataBase;Graphics;`, no log line; still hung after several minutes; the operator relaunched onPC |
| 3 | `Page 1.191 Thru 1.192` (no fields; both executors assigned) | **hang**, same signs: an executor range hangs whether or not the executors are empty; the operator relaunched onPC |

## The guard, live (bridge 0.20.0)

`npm run install-plugin`, then `Go+ Macro 100` (stop, `Delete Plugin 1`, `Import Plugin Library`, start with
`lua input=keyboard control=console`); the log read `listening on 127.0.0.1:9800 (v0.20.0)` after 6 s.

| # | Request (`gma3_objects`) | Result |
| --- | --- | --- |
| 4 | `Page 1.180 Thru 1.190`, fields `Object`, `Key`, `Fader` (the incident's request) | answered at once: `total 0` (eleven single lookups, all empty) |
| 5 | `Page 1.189 Thru 1.193`, same fields | `total 3`: executors 191–193 (`LOS2 All DelayA`, `LOS2 All DelayB`, `LOS2 Odd`) with `Object`/`Key`/`Fader`, in range order; note their child `index` reads 91–93, not the executor number |
| 6 | `Page 1 Thru 3` | `total 3`: pages 1–3 |
| 7 | `Executor 180 Thru 181` | refused `[unsafe-range]` before any console call |

The bridge answered `ping` after every step.

## Not established

- Whether `+` lists of executors (`Page 1.180 + 1.181`) or `Executor 180 Thru 181` hang too. The guard treats them as
  unsafe without evidence either way.
- Whether a wide sparse pool range (`Sequence 9000 Thru 9999`) is slow or hangs; ranges without a Page/Executor keyword
  still go to `ObjectList` unchanged.
- Other containers with sparse children (cue ranges such as `Sequence 1 Cue 1 Thru 99`).
