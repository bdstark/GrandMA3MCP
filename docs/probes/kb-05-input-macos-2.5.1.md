# KB-05 structured input — macOS, onPC 2.5.1.0

Date: 2026-10-09. Evidence for [KEYBOARD.md](../../KEYBOARD.md) "KB-05 results". Script report:
[kb-05-input-macos-2.5.1.json](kb-05-input-macos-2.5.1.json) (`run`, 44/44; rerun after the review fixes, which
added the focus-acknowledgment and preflight checks below). **Console keys were really pressed
and text was really typed** on the command line.

| Item | Value |
| --- | --- |
| Host | macOS, onPC 2.5.1.0 Release, hostname `bdsmbpm401`, show `mcp-test-disposable`, user Admin, profile `Default`, US layout, one display |
| Bridge | gma3_mcp_bridge **0.7.0**, updated and started with `lua input=keyboard` from Macro 100 (stop → Delete Plugin 1 → Import → ReloadAllPlugins → start) |
| Modules | gma3_mcp_hardkeys **0.4.0**, gma3_mcp_feedback 0.1.0 |
| Backend | **keyboard**: `Keyboard(display, 'press'|'release', <KeyboardCodes name>, shift, ctrl, alt, numlock)` for keys, `Keyboard(display, 'char', <one code point>)` for text |
| Verification | `CmdObj().cmdtext`, `CmdObj().lastcommand`, `Root().MASTATE` and `KEYBOARDSHORTCUTSACTIVE` read through the `lua` op, polled across frames (effects landed within 14–17 ms); every read taken after the interaction or sequence under test ended, because the bridge refuses `lua` while input is owned |
| Driver | `node scripts/kb05-probe.mjs run` over two real TCP connections (A and B) |

A first attempt aborted on two probe-script mistakes (B tapped without opening a session; the probe read `cmdtext`
through `lua` while A's interaction was open and got `[busy]`, as designed). A's held `STORE` was released when the
probe's socket closed (disconnect cleanup), the bridge reported nothing busy, `Store ` was cleared with Escape, and
the corrected script ran clean.

## `run` (44/44)

| # | Step | Dispatched | Observed |
| --- | --- | --- | --- |
| 1 | A `input.begin` (30 s) | nothing | interaction `i2`, A's session opened on demand; B's `cmd`, A's own `cmd`, B's `input.tap` and A's `input.press` without the id: all `[busy]` naming `i2` / `conn-96`; A's `lua` read `[busy]` too |
| 2 | A `input.press STORE interaction=i2` | `S` press | hold tagged `interaction = i2`; `input.status`: `activeInteraction = i2`, `busy.reason = interaction`; `input.extend` accepted (renewals 1); B's `input.end` `[not-owner]` |
| 3 | A `input.end i2` | `S` release (`dispatched`) | `cmdtext = "Store "` read after the end (the hold's effect persists until Escape); commands admitted again; `input.press` with `i2` `[no-interaction]` (ended, never resumed); a press without an interaction `[interaction-required]`; Escape cleared the line |
| 4 | A `input.sequence [tap NUM5 60 ms, tap NUM1 60 ms]` | `5` and `1` press/release, serviced by the loop | state `running` with step 1 waiting, then `completed` (2 of 2, both releases `dispatched`); `cmdtext = "51"` after 17 ms |
| 5 | A `input.sequence [combo MA+STORE 150 ms]` | `LeftShift`, `S`; released `S` then `LeftShift` | `cmdtext = "Record "` after 14 ms (read after completion); the event carries the MASTATE release readback separately from the dispatch (still `pending` at the moment the sequence completed; see note); console MASTATE false afterwards |
| 6 | A `input.sequence [text "Fixture 5" command-line]` with shortcuts enabled | nothing | `[unsupported]` "needs keyboard shortcuts disabled by the operator (F10) ... nothing is toggled here"; shortcuts still enabled, command line still empty; `text "Fixture 5\n"` `[bad-argument]` "character 10 is a newline"; text without `acknowledgeFocus` `[focus-unverified]`; `[tap NUM5, press MA maxHoldMs=-1]` `[bad-argument]` at step 2 with the command line still empty (nothing dispatched) |
| 7 | operator disables shortcuts (profile property through Lua, standing in for F10); A `input.sequence [text "Fixture 5" command-line]` | 9 `char` events in chunks of 8 | `completed`, `typed = 9`, readback `observed`: `cmdtext = "Fixture 5"`; `lastcommand` unchanged (the text was **not** executed) |
| 8 | A `input.sequence [text "abü€😀" command-line]` | 5 `char` events (one per code point, incl. U+1F600) | readback `observed`: `cmdtext = "Fixture 5abü€😀"` |
| 9 | operator re-enables shortcuts; Escape | `Escape` press/release | shortcuts active; `cmdtext = ""` (the typed text was discarded, never committed) |
| 10 | B `input.sequence [tap STORE 3000 ms, tap NUM5]`, then B's socket destroyed | `S` press; `S` release on disconnect | A's `cmd` `[busy]` naming B's interaction `i7` while the sequence ran; after the disconnect: no holds, nothing busy, sequence `aborted` (step 1 `aborted`, step 2 `unattempted`, nothing resumed); `cmdtext = "Store "` from the interrupted tap, cleared with Escape |
| 11 | final | — | no holds, nothing unresolved, not busy, empty command line, MASTATE false, shortcuts active |

## Observations worth keeping

- Effects landed 14–17 ms after the dispatch in this run; reads still poll across frames.
- The busy guard applies to the `lua` op as designed, which means **a probe cannot read the console while it owns
  input**: verification reads must follow the end of the interaction or sequence. What a held key put on the
  command line (`Store `, `Record `, `51`) persists after the release, so reading afterwards is sufficient.
- In the first run the chord event's MASTATE release readback was still `pending` in the report returned at the
  instant the sequence completed; `input.sequence.status` now reports the hold's live readback.
- Text typed with shortcuts disabled stayed on the command line and `lastcommand` did not change: the `char` route
  inserts, it never executes. Commit is a separate PLEASE event (not exercised here; the KB-04 run covers PLEASE).
- A disconnect in the middle of a sequence released the in-flight tap through the session close and left the
  sequence `aborted` with the rest `unattempted`; nothing was retried.

## Not exercised

Text into a focused text field (the Edit Command dialog; acknowledged focus, not readable), an explicit interaction
expiring with a key held on the console (harness only), `exclusive` taps inside a sequence, Windows, a second display,
non-US layouts.
