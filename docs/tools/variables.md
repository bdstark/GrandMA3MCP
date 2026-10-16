# Console variables (SU-15)

`gma3_variables` reads global and user variables; `gma3_set_variable` sets or deletes them and reads them back. Both
need bridge **0.31.0**, which adds the `vars.get`, `vars.set` and `vars.delete` ops (`GetVar`, `SetVar` and `DelVar`
on `GlobalVars()` / `UserVars()`). Evidence:
[the SU-15 probe record](../probes/su-15-console-variables-macos-2.5.1.md).

## Things to know first

- **Variables cannot be listed on 2.5.1.** The Variables objects have no children, an export holds no values, and
  `GetGlobalVariable "*"` only prints into the command-line history. Variables are read by name: the names you ask
  for, and every `$variable` the show's macros reference.
- **Types.** A variable holds an integer, a double or a text, and the type is kept (`SetGlobalVariable "x" 9` is an
  integer, `"9"` is a text). `gma3_set_variable` takes the type from the value, or from `type`.
- **`$name` expands in commands sent through the bridge**, outside quotes. That includes `gma3_command`, macro lines
  and cue commands. A user variable shadows a global one of the same name, and a command with a missing `$variable`
  does nothing.
- **User variables belong to the bridge's user profile** ("Admin" on the dev console). Another user on the console has
  its own.

## `gma3_variables` (read-only)

| Parameter | Values |
| --- | --- |
| `names` | variable names (case-sensitive), up to 500 |
| `scope` | `global`, `user` or `both` (default) |
| `referenced` | also read every `$variable` the macros reference (default: true when no names are given) |

Each variable comes back with `global` and/or `user` (`exists`, `value`, `type`), with `resolvesTo` (which one a
`$reference` uses, for `scope: both`), and with `usedBy` (the macro lines that reference it). The macro scan reads up to
300 macros.

## `gma3_set_variable`

| Parameter | Values |
| --- | --- |
| `scope` | `global` or `user` |
| `name` | the variable name |
| `value` | a number or a string |
| `type` | `integer`, `double` or `text` (default: a whole number is an integer, any other number a double, a string a text) |
| `delete` | `true` deletes the variable (no value) |
| `verify` | read back and compare value and type (default true) |

One `vars.set` or `vars.delete`, then a `vars.get` read-back: the value and type must match, or for a delete the
variable must be gone. A write the console ignores is `mismatched`. Batch form: `variables: [{scope, name, value,
type} | {scope, name, delete: true}]`, see [Batch forms](README.md#batch-forms-su-12).

## `$variables` in macros and cue commands

- `gma3_store_macro` and `gma3_edit_macro_line` check every `$variable` of a line outside quotes, like an object
  reference. It must exist as a user or global variable, or be set by an earlier executable line or statement
  (`SetGlobalVariable` / `SetUserVariable`). A missing one refuses the call before anything is sent; `raw: true` skips
  the check.
- Cue commands (`gma3_store_cues`, `gma3_build_chase`, `gma3_edit_cues`) are checked the same way, in cue order: a
  command setting a variable counts for the cues after it.
- On a bridge older than 0.31.0 the check cannot be made, so a line or command with a `$variable` is refused with a
  hint to update the plugin.

## Live test

`test/live/variables.live.ts`: global variables McpLiveA, McpLiveB and McpLiveSeq, the user variable McpLiveU,
Macro 930 and Sequence 944 (all must be absent; deleted at the end).
