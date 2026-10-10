# KB-14 probe: when key and character events are consumed relative to a mode change — macOS, onPC 2.5.1.0

Date: 2026-10-09. Evidence for [KEYBOARD.md](../../KEYBOARD.md) "KB-14" (first acceptance criterion: probe when
key/character events are consumed relative to mode restoration; a single Lua call is not assumed atomic). Script report:
[kb-14-timing-macos-2.5.1.json](kb-14-timing-macos-2.5.1.json) (`node scripts/kb14-probe.mjs timing`, 11/11 checks plus
three observations). A first manual pass with the same chunks (through `gma3_lua`) preceded the script; where the two
disagree it is said below. **The keyboard-shortcut mode was toggled and keys were pressed** on the disposable show; the
mode was restored to its initial state (off) at the end.

**Result: not atomic, and not the same for every event kind.** Character events and a printable shortcut tap are
consumed inside the `Keyboard()` call (the command line reads the effect in the same chunk), so a mode change written
after them in the same chunk does not undo them. `Escape` with shortcuts on and the `LeftShift` modifier are consumed
on a later frame; for the modifier the outcome of a same-chunk restore differed between runs (never registered in the
manual pass; registered in every scripted pass), and a modifier that registered under the temporary mode was **not
lifted by a release under the restored mode** (MASTATE stayed true) until a press/release pair was sent in the mode of
the press. Disabling shortcuts while MA is held drops MA by itself. The module therefore keeps the mode for the whole
hold, releases in the mode of the press, and restores only from `service()` one restore delay after the last dependent
event, never in the call that dispatched it.

| Item | Value |
| --- | --- |
| Host | macOS, onPC 2.5.1.0 Release, hostname `bdsmbpm401` |
| Show / user / profile | `mcp-test-disposable`, Admin, profile `Default` (`KeyboardShortCuts` at `UserProfile 1.13`); show not saved |
| Bridge / modules | gma3_mcp_bridge 0.10.0 (`lua input=keyboard`), gma3_mcp_hardkeys 0.8.0; the probe used the `lua` op only (no module path) |
| Invocation | `node scripts/kb14-probe.mjs timing --out docs/probes/kb-14-timing-macos-2.5.1.json`; every step is one Lua chunk on the plugin thread followed by reads in later requests; `Keyboard(1, 'char', <string>)`, `Keyboard(1, 'press'/'release', <key>, shift, ctrl, alt, numlock)`, `CurrentProfile().KeyboardShortCuts:Set('KeyboardShortcutsActive', bool)` |
| Preconditions | 0 holds, nothing busy, command line empty, `MASTATE` false, shortcuts **off** |

## Steps

| # | Chunk | In the chunk | Next request(s) |
| --- | --- | --- | --- |
| 1 | shortcuts ON; `char 's'`, `char '5'` | `cmdtext ""` | `""`: character events with shortcuts on reach neither the command line nor the shortcut table (dropped, not substituted) |
| 2 | shortcuts OFF; `char 115` (a number) | `cmdtext "1"` | the argument is stringified (`"115"` → first character): the backend must pass one character, never a code point number (the module's `KeyboardBackend:char` already converts with `utf8.char`) |
| 3 | `char 's'`, `char U+20AC`; then Escape press/release | `"s€"`, then `""` | characters land in the chunk, one per call, UTF-8; Escape with shortcuts off clears in the chunk |
| 4 (T1) | shortcuts ON → `Set false`; `char 'x'`, `char '5'`; `Set true` | `"x5"`, restored `true` | `"x5"` after 80 ms: the characters were consumed before the restore |
| 5 | shortcuts ON; Escape press/release | `"x5"` (unchanged) | `""` after 18 ms: with shortcuts on, Escape is consumed on a later frame |
| 6 (S1) | shortcuts OFF → `Set true`; press/release `S`; `Set false` | `"Store "`, restored | `"Store "` after 80 ms: the shortcut tap was consumed in the chunk and survives the same-chunk restore |
| 7 (H1) | `Set true`; press `LeftShift`; read MASTATE; `Set false` | MASTATE `false`, `false` after the disable | **scripted runs:** `true` after 120 ms (the press registered although the mode was restored in the chunk); **manual pass:** `false` immediately and seconds later (never registered). Observation only; the module relies on neither |
| 7b | release `LeftShift` under the restored OFF mode | MASTATE `true` | still `true` after 800 ms: the release under the other mode did not lift the key |
| 7c | `Set true`; press + release `LeftShift`; `Set false` | `true` | `false` after 18 ms: a press/release pair in the mode of the press lifts it |
| 8 (H0) | `Set true`; press `LeftShift` | MASTATE `false` | `true` after 18 ms (the manual pass saw it on the next request too; one scripted run saw it in the chunk) |
| 9 | `Set false` while MA is held | `true` | `false` after 495 ms: disabling shortcuts drops a held MA by itself |
| 10 | release `LeftShift` under OFF | `false` | `false` |
| 11 | final | shortcuts off, command line empty, MASTATE false | as found |

## What the module takes from this

- A mode change written in the same call as a key event is **not** safe in either direction: a tap or characters are
  already consumed (harmless), a modifier may or may not be, and a release in the other mode may not lift a key that
  registered under the temporary mode. `gma3_mcp_hardkeys` 0.9.0 keeps the temporary mode until every dependent record
  is released and restores it from `service()` after `config.modeRestoreDelayMs` (60 ms; effects landed within 18 ms
  here) following the last dependent event.
- Disabling shortcuts drops a held MA: a mode-changing hold whose mode the operator restores mid-hold is a route change
  (the KB-04 behaviour), and the module never restores while a dependent key is held.
- Character events need shortcuts off; with shortcuts on they vanish without substitution, so the text routes
  temporarily disable shortcuts when they are on and recheck the state between chunks.
- Nothing here is a timing guarantee: the console consumes queued events per frame and the frame phase of a request is
  not observable from Lua. The restore delay is a bound chosen from the observed 14–73 ms, not a proof.
