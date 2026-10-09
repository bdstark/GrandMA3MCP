# KB-03 owned input sessions on the fake backend — macOS, onPC 2.5.1.0

Date: 2026-10-09. Evidence for [KEYBOARD.md](../../KEYBOARD.md) "KB-03 results". Script report:
[kb-03-fake-macos-2.5.1.json](kb-03-fake-macos-2.5.1.json) (33/33).

| Item | Value |
| --- | --- |
| Host | macOS, onPC 2.5.1.0 Release, hostname `bdsmbpm401`, show `mcp-test-disposable` |
| Bridge | gma3_mcp_bridge 0.4.0 → **0.5.0**, started with `lua input=fake` from Macro 100 (stop → Delete Plugin 1 → Import → ReloadAllPlugins → start) |
| Modules | gma3_mcp_hardkeys **0.2.0**, gma3_mcp_feedback 0.1.0 |
| Backend | **fake** only: events recorded, aggregate key state simulated, **no console key pressed** |
| Driver | `node scripts/kb03-probe.mjs run --out docs/probes/kb-03-fake-macos-2.5.1.json` (two TCP connections) plus a one-off script for the operator paths, which were driven from Macros 101–105 (`stop` + restart, `input recover`, `input status`, `input=off`, `input=fake`) through `Cmd('Go+ Macro N')` |

## Session lifecycle over real connections (33/33)

| # | Check | Result |
| --- | --- | --- |
| 1 | `input.press` before `input.open` | `[no-session]` |
| 2–3 | Two connections open sessions | `conn-2` (3 s lease), `conn-3`; ids derived from the connection |
| 4 | B renews with `session = conn-2` in args | acts on `conn-3`: the argument is ignored, sessions cannot be guessed |
| 5 | A presses `PLEASE` on display 1 | `Enter\|s0c0a0n0` via shortcut-table row `Enter`, profile `Default` stored with the hold |
| 6 | A presses `PLEASE` again | harmless duplicate, same hold id, no second event |
| 7–8 | B presses `PLEASE`, then raw `Enter` on display 2 | `[conflict]` naming `conn-2` both times (display is not an ownership domain) |
| 9 | B releases `PLEASE` | `[not-owner]` |
| 10 | B reads `input.status` | shows A as owner with remaining lease; release counter unchanged |
| 11–12 | A taps `STORE` for 200 ms | the plugin loop released it after **201 ms** (`deadline reason tap`) |
| 13–14 | Fake backend set to fail the `Enter` release; A releases | hold **unresolved**, reason `release refused by the backend: probe: host blocked`; logged as `ERROR ... UNRESOLVED` |
| 15 | B presses `Enter` while unresolved | `[conflict]` (state unresolved) |
| 16 | B `input.recover` | owner-scoped: 0 attempted |
| 17 | A `input.recover` with the fault still staged | 0 released, 1 unresolved (no success claimed) |
| 18–19 | Fault cleared, A `input.recover` | released with the stored tuple; no unresolved record remains |
| 20–22 | A presses `MA`; 3 s lease expires on the loop | session `expired`, MA released with reason `lease-expired` |
| 23–24 | A presses after expiry, then renews | `[lease-expired]`, then `active` again; renewal injected no press |
| 25–27 | A presses `MA`; fake backend simulates a physical LeftShift release | hold stays `held` with `observed.down = false`; press counter unchanged (**no re-press**) |
| 28 | A releases `MA` | released |
| 29–30 | B holds `Ctrl+Q`, B's socket is destroyed | within the poll window the session was gone, holds 0, last fake event `release:Q` (log: `input: disconnect conn-3 released ...`) |
| 31–33 | A `releaseAll`, `close`; final ping | 0 holds, 0 unresolved, nothing down on the fake backend |

## Operator paths (console commands via macros)

| Step | Result |
| --- | --- |
| A holds raw `Z` with a sticky release fault; Macro 101 stops and restarts the bridge while A is connected | shutdown closed the client: `input: shutdown conn-5 UNRESOLVED ... release refused by the backend`; dispose kept the record: `1 unresolved release record(s) kept; run Plugin "gma3_mcp_bridge" "input recover" once the bridge runs again` |
| Bridge back (0.5.0, new instances) | the record is adopted at start: `1 unresolved release record(s) from a previous run reserve their keys`; `ping.input.unresolved = 1`, `holds = 1`; `input.status` lists it as an unresolved hold of session `previous-run`; a **new session pressing `Z` before recovery gets `[conflict] ... owned by session 'previous-run' (state unresolved)`** (re-run after the review fix) |
| Macro 102: `input recover` | `input recover released previous-run raw(Z) released`, `1 released, 0 still unresolved`; the new fake adapter's first event is `release:Z` (stored tuple, nothing re-resolved); `Z` can be pressed again afterwards |
| A holds raw `V` with a sticky release fault; Macro 106 restarts the bridge with input **disabled** (the default start); Macro 102: `input recover` | the record is adopted and reserved at start (`unresolved = 1`, `holds = 1`, input off); recover logs `input is disabled, so no backend can dispatch a release; the records stay reserved` and the hold stays `unresolved` with reason `no backend attached; enable input and recover again` (not stuck in `releasing`); after Macro 105 (`input=fake`) a new session's `V` press is still `[conflict] ... previous-run`; Macro 102 again: `1 released, 0 still unresolved`, `V` pressable afterwards |
| New session holds `STORE`; Macro 103: `input status` | prints the session and `input hold h2: held STORE(S\|s0c0a0n0) ... held 47 ms`; holds still 1 afterwards (status releases nothing) |
| Macro 104: `input=off` | `input: disable released conn-11 STORE(...)`, `input now disabled`; a new press returns `[input-disabled]` with the enable hint; `input.status`/`input.close` still answer |
| Macro 105: `input=fake` | `input now enabled on the fake backend (nothing reaches the console)`; the fake down set is empty at the end |

Earlier control calls (`status`, `input status`, rejected arguments) left the running bridge and its holds alone,
as the harness also checks.

## Not exercised

- No console key was pressed: every dispatch went to the fake adapter. Confirming that the stored-tuple
  release actually lifts a console key after a remap is KB-04 work with the keyboard adapter.
- Windows and a physically separate machine (KB-02 qualification gaps) were not used.
- A blocked host call on the plugin thread: the loop does not run, so no deadline is serviced; the record
  survives in the bridge state table for `input recover` once the thread is free again, as documented.
