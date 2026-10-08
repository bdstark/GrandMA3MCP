# Optional Lua execution

[README](../README.md) · [macOS setup](setup/macos.md) · [Windows setup](setup/windows.md)



Arbitrary Lua (the `gma3_lua` tool) is **off by default**. Everything else keeps working without it. The
console operator turns it on per start, or toggles it while the bridge is running:

```
Plugin "gma3_mcp_bridge" "lua"              start with Lua execution enabled
Plugin "gma3_mcp_bridge" "9801 lua"         custom port and Lua execution enabled
Plugin "gma3_mcp_bridge" "lua on"           enable while running
Plugin "gma3_mcp_bridge" "lua off"          disable while running
Plugin "gma3_mcp_bridge" "lua luatime=2000 luasteps=5000000"
Plugin "gma3_mcp_bridge" "lua luahook=replace"    enforce the budget over the console's own hook (see below)
```

`status`, `lua on|off`, `luahook=...` and the budget tokens are control calls: they talk to the running bridge and leave it
running. Arguments are whitespace-separated tokens. Every start establishes the policy afresh, so enabling Lua is
always a visible decision in the start command (or macro); it never carries over from a previous run.
`status` and `gma3_status` show the current policy.

Each request has configured limits: by default 5 seconds of wall-clock time and 20 million Lua VM
instructions. `luatime=<ms>` and `luasteps=<n>` change them (`0` means unlimited). Request limits can
only tighten the console policy. The MCP server also sends its request timeout as a time limit.
**A client timeout does not cancel a running script.** Enforcement depends on the hook policy below;
in the default preserve mode, a non-yielding script may continue indefinitely.

The script runs on the plugin's own thread. It has to: grandMA3 binds the plugin context to the thread it
created for the plugin, and a coroutine created from Lua gets no context, so `ObjectList()`, `DataPool()`,
`Programmer()` and every other context-bound function return nothing there (plugin 0.2.0 ran scripts in a
coroutine and had exactly that problem; fixed in 0.3.1). When the hook policy permits it, the instruction count is enforced with a Lua debug
hook installed on that thread for the duration of the script; the wall-clock deadline is checked by the
hook, after every yield, and before a result is returned, so yielding scripts are checked when execution resumes.
Once the budget is exceeded the hook raises on every instruction of submitted code (so `pcall` cannot
swallow it) but never inside the bridge's own code.

onPC keeps a hook of its own on the plugin thread (an external C hook with count 50000 on 2.5.1) whose purpose
MA does not document. A C hook cannot be called from or re-created in Lua, so the bridge has to choose:

* `luahook=preserve` (default): the console's hook is left alone. A script then runs **without the instruction
  hook**; the wall-clock deadline is still checked whenever the script yields and when it returns, but a script
  that neither yields nor returns cannot be stopped by the bridge. `gma3_status` reports `lua.bounded: false`
  with the reason, and every `gma3_lua` result carries `budget.instructionHookEnforced: false` and
  `budget.consoleHookPreserved: true`. Coroutines the script creates are still budgeted (they carry no console
  hook).
* `luahook=replace`: the budget hook is installed over the console's hook for the duration of the script, so
  the instruction and time budgets are enforced as described above. Afterwards the thread is left without the
  console's hook until the plugin is restarted. No behaviour change was observed with it gone on 2.5.1, but
  that observation is not a guarantee: enable this only after testing the tradeoff on your console version. Blocking C calls remain uninterruptible.

`gma3_status` shows what was found under `lua.consoleHook` and the mode under `lua.hookMode`. The automated
harness can only simulate a Lua hook, not the console's C hook; the preserve/replace decision itself is covered
by stubbing `debug.gethook`.

The script runs in an environment that closes the obvious ways around the budget: `debug.sethook` and
`debug.gethook` are withheld, coroutines the script creates (`coroutine.create` / `coroutine.wrap`) get the
budget hook as well, and `load`, `loadfile`, `dofile`, `require` and `package.loaded` resolve to that same
environment. Everything else, including the whole grandMA3 API, `io` and `os`, is the real thing, and
globals a script defines persist across requests as before.

Treat the budget as a **best-effort limit for trusted scripts**, not a security boundary:

* The hook only fires between Lua VM instructions. It cannot interrupt a C function that blocks, such as
  `Cmd()` opening a confirmation dialog or a blocking socket call.
* A script that sets out to escape still can, for example through `debug.getregistry` style introspection
  of the real libraries. Enabling Lua already hands the client `os` and `io`, so the trust decision is made
  when the operator turns the capability on; the budget protects against runaway scripts, not hostile ones.
* The hook runs only for code submitted through `gma3_lua`; the structured ops are not budgeted.
