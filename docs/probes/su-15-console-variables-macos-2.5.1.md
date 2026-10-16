# SU-15 probe: console variables (macOS, onPC 2.5.1)

Evidence for [SU-15 in SETUP.md](../../SETUP.md#su-15--console-variables). The `$variable` expansion question was
settled with SU-14 ([su-14-cue-contents-macos-2.5.1.md](su-14-cue-contents-macos-2.5.1.md#su-15-variables-in-commands-sent-through-the-bridge)).

- **Date:** 2026-10-16
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, the throwaway show `NewShow_2026.10.15_23.16.24UTC`,
  bridge 0.30.1, then 0.31.0
- **Method:** the bridge's `lua` and `cmd` ops with variables named `mcpv_*`, all deleted afterwards. Then
  `test/live/variables.live.ts`.

## Reading and writing

| Lua | Result |
| --- | --- |
| `GlobalVars()` | a `Variables` object at `ShowData.ShowSettings.GlobalVariables`, `COUNT` 0, no children |
| `GetVar(GlobalVars(), name)` after `SetGlobalVariable "x" "hello world"`, `42`, `1.5` | `"hello world"`, `42` (integer), `1.5` (float) |
| `GetVar` of a missing name | no value at all (`select("#", …)` is 0) |
| `SetVar(h, name, 7)`, `2.25`, `'a "b" c'`, `3.0` | integer, float, string kept exactly; `3.0` stays a float |
| `DelVar` of an existing / a missing name | `true` / `nil` |
| `SetGlobalVariable "c1" 9` / `"c2" "9"` | integer 9 / text "9" |
| `CurrentUser().name` in the plugin | "Admin" (the bridge's user: its `UserVars()`) |

## Listing

| Attempt | Result |
| --- | --- |
| `GlobalVars():Children()`, `:Count()`, `:Ptr(i)`, `pairs()` | nothing (0 children; the handle is not a table) |
| `GlobalVars():Export(dir, "mcpvars.xml")` | `<Variables Name="GlobalVariables"/>`, with no values |
| `GetGlobalVariable "mcpv*"` through `cmd` | feedback "OK"; the listing goes to the command-line history only |
| Lua functions with "Var" in the name | `GetVar`, `SetVar`, `DelVar`, `GetVarVersion` (nil here), `GlobalVars`, `UserVars`, `PluginVars`, `AddonVars` |

There is no way to enumerate variables, so `gma3_variables` reads names: the ones asked for, and the macros'
`$references`.

## Expansion rules

| Command through the bridge | Result |
| --- | --- |
| `SetGlobalVariable "mcpv_both" "fromGlobal"`, `SetUserVariable "mcpv_both" "fromUser"`, `Label Sequence 940 $mcpv_both` | named "fromUser": a user variable shadows a global one |
| `Label Sequence 940 "q$mcpv_text"` | not expanded inside quotes |
| `Label Sequence 940 $mcpv_missing` | the name is unchanged: the command does nothing |

## Live test (`test/live/variables.live.ts`, 1/1, bridge 0.31.0)

| Case | Result |
| --- | --- |
| `gma3_set_variable` batch: McpLiveA 11, McpLiveB 2.5, McpLiveSeq "944", user McpLiveU `say "hi"` | read back integer, double, text, text |
| `Store Sequence $McpLiveSeq Cue 1` through the bridge's `cmd` | Sequence 944 created |
| `gma3_store_macro` with `$McpLiveNope` / with `$McpLiveSeq` | refused (does not exist) / stored; `gma3_variables` lists Macro 930 line 1 under McpLiveSeq |
| `gma3_store_cues` cue command `Go+ Macro $McpLiveNope` | refused before anything is sent |
| delete McpLiveA | read back missing |
