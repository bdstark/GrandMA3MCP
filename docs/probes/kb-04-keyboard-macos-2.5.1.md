# KB-04 keyboard backend — macOS, onPC 2.5.1.0

Date: 2026-10-09. Evidence for [KEYBOARD.md](../../KEYBOARD.md) "KB-04 results". Script reports:
[kb-04-keyboard-macos-2.5.1.json](kb-04-keyboard-macos-2.5.1.json) (`run`, 47/47) and
[kb-04-keyboard-macos-2.5.1-restart.json](kb-04-keyboard-macos-2.5.1-restart.json) (`restart`, 12/12).
**Console keys were really pressed** in these runs (unlike the KB-03 fake-backend record).

| Item | Value |
| --- | --- |
| Host | macOS, onPC 2.5.1.0 Release, hostname `bdsmbpm401`, show `mcp-test-disposable`, user Admin, profile `Default`, US layout, one display |
| Bridge | gma3_mcp_bridge **0.6.0**, started with `lua input=keyboard` from Macro 100 (stop → Delete Plugin 1 → Import → ReloadAllPlugins → start) |
| Modules | gma3_mcp_hardkeys **0.3.0**, gma3_mcp_feedback 0.1.0 |
| Backend | **keyboard**: `Keyboard(display, 'press'|'release', <KeyboardCodes name>, shift, ctrl, alt, numlock)` with explicit modifiers on every event |
| Verification | `CmdObj().cmdtext`, `Root().MASTATE` and `KeyboardShortCuts.KEYBOARDSHORTCUTSACTIVE` read through the `lua` op, polled across frames (effects landed within 18–73 ms); pop-ups are not readable |
| Driver | `node scripts/kb04-probe.mjs run` / `restart` over real TCP connections; operator paths through Macros 106 (`stop` + restart with `lua` only), 102 (`input recover`) and 107 (`input=keyboard`), fired with `Cmd('Go+ Macro N')` |

Pre-checks before the run: VirtualKey `PLEASE` has `KEYCODE = Enter` (readable through `Root().VirtualKeys`,
`Code`/`KeyCode`), `Enums.KeyboardCodes` names resolve (`Enter=257`, `LeftShift=340`, `S=83`, `F1=290`,
`5=53`, `Escape=256`), the default profile has two identical `Enter → PLEASE` rows (rows 141 and 149; one
route, not an ambiguity), `S → STORE` is row 123, shortcuts were active, MASTATE false, command line empty.

## `run` (47/47)

| # | Step | Dispatched | Observed |
| --- | --- | --- | --- |
| 1 | `input.tap NUM5 60 ms` | press `5` via shortcut row `5`; release scheduled | `cmdtext = "5"` after 24 ms; the loop released after 73 ms with `releaseOutcome = dispatched` (no per-key readback exists) |
| 2 | `input.tap ESC` | Escape press/release | command line empty |
| 3 | `input.press PLEASE` / release | `Enter` through the **native** route, `redirectChecked = true`, `pcKeyValidated = true` | empty command line unchanged (nothing to execute) |
| 4 | `input.combo [MA, STORE] 150 ms` | `LeftShift` press, `S` press, one group; at the deadline `S` release then `LeftShift` release | `cmdtext = "Record "` after 18 ms; press readback `MASTATE true` observed; release readback `MASTATE false` observed and reported as aggregate, separately from the dispatch; console MASTATE false afterwards |
| 5 | `input.tap STORE 1200 ms exclusive` | `S` held 1208 ms, released by the loop | B's `MA` press, A's duplicate `STORE` and B's combo all `[exclusive-hold]` naming A's hold; `cmdtext = "Store "`; Store Settings pop-up not readable from Lua (closed with two Escapes, command line empty afterwards) |
| 6 | `STORE` held, operator remaps row 123 `S → T` (via `cmd`) | — | B's raw `Q` press: `[route-changed] STORE now maps to T\|s0c0a0n0 (was S\|s0c0a0n0) ...`; A's release: dispatched with the stored `S`, **unresolved** ("effect cannot be confirmed"); `cmdtext` stayed `"Store "` (the console did not lift the hold, as in KB-01 F12); after restoring `S`, owner `input.recover` released with the stored tuple (`outcome = dispatched`), Escape cleared the line, input admitted again |
| 7 | `STORE` held, raw `F10` tap disables shortcuts | `F10` press/release | `KEYBOARDSHORTCUTSACTIVE = false`; B's `MA` press `[route-changed] ... keyboard shortcuts are now inactive`; A's release unresolved; an injected `F10` to re-enable is **refused** (`route-changed`: new input stops while a mismatch is pending); the operator re-enabled through the profile property; recover released the record; shortcuts active, command line cleared |
| 8 | B holds `MA`, B's socket destroyed | `LeftShift` release on disconnect (backend release counter +1) | MASTATE true while held, false after the disconnect; no holds left |
| 9 | final | — | no holds, nothing unresolved, empty command line, MASTATE false, shortcuts active |

## `restart` (12/12)

`STORE` held, row 123 remapped `S → T`, then Macro 106 (stop, restart with `lua` only). The stop's release
was dispatched with the stored tuple but could not be confirmed (route changed), so the record was kept
and adopted by the new instance: `ping.input = {enabled: false, holds: 1, unresolved: 1}`, hold of session
`previous-run`, `backend = "keyboard"`, tuple `S|s0c0a0n0`. Macro 102 (`input recover`) with the route still
remapped **attached the keyboard backend for cleanup only** (`backend.attached = true`, input still disabled, a
new press `[input-disabled]`) and left the record unresolved. After restoring the row, Macro 102 released it
through `Keyboard()`: `unresolved 0, holds 0`, input still disabled, MASTATE false, shortcuts active. The
command line still showed `Store ` (the console had applied the held key before the remap); one Escape cleared it,
and Macro 107 re-enabled `input=keyboard`.

## Observations worth keeping

- Effects landed 18–73 ms after the call in this run; verification still polls across frames rather than
  trusting one read.
- A release dispatched during a route mismatch did not lift the console key (`Store ` stayed on the command
  line) and the stored-tuple release worked once the route was restored: the unresolved/recover model matches
  the console's behaviour.
- With a route mismatch pending, *every* new press is refused, including an injected `F10`. Re-enabling
  shortcuts is therefore a console-side operator action (physical F10 or the profile property), as designed.
- The long-press pop-up is the one effect this probe cannot read back; `cmdtext = "Store "` only shows the
  key was held, not that Store Settings opened.

## Not exercised

- Windows (KB-01 found the same `Keyboard()` behaviour there, but neither the adapter nor module loading was run on
  Windows), a physically separate machine, non-US layouts, a second display (KB-01 showed `display_index`
  does not route input; the adapter passes it as API context only).
- A `Keyboard()` call that raises or blocks on the real console (only stubbed in the harness).
- A physical key held by the operator at the same time as an injected hold (KB-01 H1–H2 cover the Shift case).
