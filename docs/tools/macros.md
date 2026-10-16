# Macros as reusable show actions (SB-07)

Four tools author and run macros:
- `gma3_macros` reads the macro pool, or one macro with its lines exactly as stored;
- `gma3_store_macro` creates a macro, or replaces or appends its lines, with an explicit mode;
- `gma3_edit_macro_line` inserts, changes, moves or removes one line;
- `gma3_run_macro` runs (`Go+`) or stops (`Off`) a macro and observes it.

**Authoring never runs a macro.** The store and edit tools send only `Store`, `Insert`, `Delete`, `Move` and `set`;
only `gma3_run_macro` sends `Go+` or `Off`.

No new bridge op: the tools use `children`, `objects`, `object`, `set` and `cmd`. Evidence:
[the SB-07 probe record](../probes/sb-07-macros-macos-2.5.1.md).

| Tool | Changes | Programmer |
| --- | --- | --- |
| `gma3_macros` | nothing (read-only) | untouched |
| `gma3_store_macro` | one macro's lines and its name, note and CLI | untouched |
| `gma3_edit_macro_line` | one line (or the order of lines) of one macro | untouched |
| `gma3_run_macro` | **runs the macro**: whatever its lines do | whatever its lines do |

## The things to know first

- **A macro line** (`Macro N.L`) holds one command line. Several commands can share it, separated by `;`. A line also
  has a wait, `enabled`, `add_to_cmdline`, `execute`, a name and a note.
- **Waits** come after the line's command:
  - `"follow"`: the next line runs at once (about one frame later);
  - seconds: the next line runs after that time;
  - `"go"`: a manual wait. The macro pauses after the line until it gets another `Go+`.

  The console silently turns an invalid wait into Follow, so every wait is read back.
- **The console rewrites command text outside quotes.** It trims the ends, collapses runs of spaces, and expands
  abbreviated keywords as the command line would read them:
  - `go+ seq 1` becomes `Go+ Sequence 1`;
  - `store cue 5 /merge /nc` becomes `Store Cue 5 /Merge /NoConfirmation`;
  - `Echo hello world` becomes `Echo hello World`;
  - `fix 1` becomes `Fix 1` (the Fix keyword).

  Quoted text is kept exactly. To round-trip exactly, write full keyword names with single spaces, and put literal
  text in quotes. The tools read every written line back and compare it exactly. A rewritten line is reported in
  `rewritten` (`sent`, `stored`) and fails the verification, unless `accept_console_form: true`.
- **References are checked, raw lines are allowed.** Before anything is sent, each line is scanned for single
  references written with full keywords: Sequence (with Cue and Part), Macro, Group, Preset, MAtricks, Page, Timecode,
  Appearance, Master, Plugin, Quickey and View. Each one must exist.
  - A `Store` earlier in the same macro counts as creating its object; storing a cue also creates its sequence. The
    macro's existing lines count too (for `append` and edits), but only lines that run: a disabled line, or one with
    `execute: false`, creates nothing.
  - An edit that takes such an object away from a later line (removing, moving, disabling or rewriting the line that
    stored it) is refused when the object does not exist in the show, unless `allow_unresolved_dependents: true`. Lines
    keep their identity through the edit (by position before it, never by matching text), and statements count in
    order: a Store earlier in the same line satisfies the line's later statements, one after them does not.
  - References to the macro itself are allowed.
  - Ranges (`Thru`, `+`, `-`) are not checked, and neither are abbreviated keywords or quoted text.
  - A reference that cannot be checked refuses the line (fail closed).
  - `raw: true` stores a line unchecked.
- **A launch is not completion.** A failing line does not stop a macro, and nothing in the console's state shows that
  it failed. `gma3_run_macro` reports what it dispatched and what it observed, never that every line succeeded.
- **Locked or running macros are not edited.** The console silently ignores edits to a locked macro. A running macro
  (it shows a current line) is refused: stop it first. Only a read LineNo of "" counts as idle; a missing or malformed
  one is `runState: "unknown"`, and authoring is refused then too.
- **Waits are verified numerically.** The `set` reply shows a wait as display text ("1h00m00.00"), so every written wait
  is read back with `asText: false`.

## `gma3_macros`

- Without `macro`: the pool, `{offset?, limit? (100, max 1000)}` → `macros: [{macro, name, lines}]`, plus `next` when
  more follow.
- With `macro` you get:
  - the macro's `name`, `note`, `locked` and `cli`;
  - `running`: the line it is on now, or null when idle;
  - `lastUser`;
  - `lines`: `[{line, name, command, wait, enabled, addToCmdline, execute, note}]`.

  `command` is exactly as stored. `name` is null for the default "MacroLine L". `wait` is seconds, `"follow"` or
  `"go"`.
- `check_references: true` adds `references`: per line, each reference and whether it exists.

## `gma3_store_macro`

`{macro, mode: "create" | "replace" | "append", lines: [...], name?, note?, cli?, accept_console_form?, preview?,
verify?}`; each line is `{command, wait?, enabled? (true), add_to_cmdline? (false), execute? (true), name?, note?,
raw?}`.

| Mode | Requires | Sends |
| --- | --- | --- |
| `create` | the macro does not exist | `Store Macro N /NoConfirmation`, then the lines |
| `replace` | the macro exists | `Delete Macro N.L /NoConfirmation` from the last line to the first, then the lines; the macro itself (its appearance, executor assignments) is kept; `lines: []` clears it |
| `append` | the macro exists | the lines after the existing ones, which are verified unchanged |

Each line is created with `Store Macro N.L /NoConfirmation` at the end of the macro and gets one `set` per property
(Command, Wait, Enabled, AddToCmdline, Execute, Name, Note), each compared with the console's reply. Then the macro's
Name, Note and CLI are set. The read-back compares the line count, the order and every field; `executed: false` is
part of every result.

## `gma3_edit_macro_line`

`{macro, action, line, to?, command?, wait?, enabled?, add_to_cmdline?, execute?, name?, note?, raw?,
accept_console_form?, preview?, verify?}`.

| Action | Sends |
| --- | --- |
| `insert` (line 1..count+1, needs `command`) | `Insert Macro N.L` (or `Store Macro N.L` at the end), then the properties |
| `set` | the given properties |
| `move` (`to`) | `Move Macro N.a At Macro N.b`, **upward moves only**: a downward Move lands one place short on 2.5.1, so moving down by k is k upward moves of the lines below |
| `remove` | `Delete Macro N.L /NoConfirmation` |

Every line is read back and compared with the expected result of the action.

### Batch forms (SU-12)

- `gma3_store_macro` with `macros: [{macro, mode, lines, name, note, cli}]`: several macros, each with this tool's
  reference checks and read-back. `mode` and `accept_console_form` may be given once for all. A macro listed twice is
  refused. A macro stored earlier in the batch counts as existing for a later macro's references.
- `gma3_edit_macro_line` with `edits: [{macro, action, line, ...}]`: the edits run in order, each against the macro as
  the earlier edits left it (line numbers shift after an insert, move or remove). Once an edit on a macro does not
  succeed, the later edits on that macro are not attempted; edits on other macros go on.

See [Batch forms](README.md#batch-forms-su-12).

## `gma3_run_macro`

`{macro, action: "go" | "off", observe_seconds? (3, max 60), interval_ms? (100)}`.

- `go` sends `Go+ Macro N`: it starts the macro, or continues it after a Go wait. `off` sends `Off Macro N`.
- Then it samples the macro's running line (LineNo, LineName, LineCommand). The observed `state` is one of:
  - `finished`: seen running (or paused before the command), then idle;
  - `paused_at_go`: on a line whose wait is Go, for half a second (`pausedAt`; send `go` again to continue);
  - `running`: still running when observation ended;
  - `not_observed`: never seen running. It either ended before the first sample or did not start; the two cannot be
    told apart;
  - `stopped`: idle after `off`, read from the console;
  - `unknown`: no sample could be read (a failed read or a missing LineNo is a gap, never "idle"). After `off` this
    makes the verification `unavailable`, not `matched`.
- `execution` has `dispatched` (the command was accepted), `observed` (`state`, `linesSeen` with times,
  `unreadSamples`) and `runningBefore`. A line shorter than the sampling interval may not appear in `linesSeen`.
- `verification` for `go` is always `unavailable`: the run state does not show that the lines succeeded. Check the
  lines' effects separately. For `off` it is `matched` when the macro is idle afterwards.
- Warnings name disabled lines (skipped with their waits) and lines with a `(prompt)`, which ask the operator for a
  value when they run.

## What is and is not verified

- Verified live (onPC 2.5.1, `test/live/macros.live.ts`, 1/1, 5.4 s):
  - a store refused before anything was sent because a line referred to a missing sequence;
  - a setup macro whose first line stores Sequence 907 (so the next lines may use it):
    - created without running (the sequence still absent);
    - read back with exact text, names and notes;
    - run: observed finished, and the test saw the sequence labelled and set to Wrap Around;
  - a playback macro (`Go+ Sequence 907`, 1.5 s wait, `Off Sequence 907`): the sequence ran at 0.7 s, the run finished
    after the wait, and the sequence was off afterwards;
  - a manual-wait macro:
    - observed paused at line 1, its note "before";
    - an edit refused while it was paused;
    - continued to finished, its note "after";
  - insert, move down, move up and remove restored the original order;
  - a rewritten `echo  done` reported (`Echo done`) as a mismatch, then accepted with `accept_console_form`;
  - `off` on an idle macro.
- Not covered:
  - lines with `(prompts)` in operation (they open an input pop-up);
  - `add_to_cmdline` / `execute: false` lines in a run (see the KB-10 probe for their command-line behaviour);
  - macro variables;
  - Call and Toggle on macros;
  - executor assignment of macros.

## Live test

`GMA3_LIVE=1 node --import tsx --test test/live/macros.live.ts` on a disposable show with an empty programmer. It uses
Macros 901–903 and Sequence 907, refuses to run when any of them exists, touches no other macro, and deletes them at
the end.
