# Development

[README](../README.md) · [macOS setup](setup/macos.md) · [Windows setup](setup/windows.md)



```bash
npm run dev        # run from source with tsx
npm run build      # compile to dist/
npm test           # run the automated suite (no console needed)
npm run coverage   # tests plus a line/branch/function coverage table for src/
npm run test:live  # live console tests; see test/live/README.md (opt-in, modifies a disposable show)
```

`npm test` is the one command that runs every automated check without a live console; `.github/workflows/ci.yml`
runs the build and the same suite on every push and pull request (Node 20 and 22, with Lua 5.4 installed so
the plugin harness is not skipped).

The suite in `test/` has no extra dependencies:

* `bridge.test.ts`: the TCP client (`bridge.ts`), including UTF-8 sequences split across packets, replies
  matched to concurrent requests by id, and the `dispatched` flag that stops a timed-out or disconnected
  request from ever being resent.
* `help*.test.ts`: manual lookup (`help.ts`), including path traversal and symlink rejection.
* `results.test.ts`, `validate.test.ts`, `mutations.test.ts`: the shared workflow result model, input
  validation and the mutation lock (see [Workflow tools](reference.md#workflow-tools)).
* `server.test.ts`, `registration.test.ts`: the MCP server started over stdio against a fake bridge and a UDP
  listener standing in for OSC input (transport decisions, tool registration, serialised mutations).
* Per-area tool tests (`fixtures.test.ts`, `cues.test.ts`, ...) run the tool modules in-process against a
  scripted fake bridge (`test/helpers/`).
* `test/lua/modules_test.lua` loads `plugin/gma3_mcp_hardkeys.lua` and `plugin/gma3_mcp_feedback.lua` with no
  console API at all (any global read while loading fails the test), then checks lifecycle, instance isolation,
  signal-table registration, key resolution against the KB-01 default profile and the feedback readers.
* `test/lua/bridge_plugin_test.lua` exercises the console plugin under a stock Lua 5.4+ interpreter with the
  grandMA3 API and LuaSocket stubbed: Lua execution off by default, budget behavior and execution-environment restrictions (hook removal,
  child coroutines, deadlines across yields), argument parsing, loopback-only binding and rejection of a
  non-loopback peer. `npm test` runs it when `lua` is on PATH and skips it otherwise (`brew install lua`).

Live tests live in `test/live/*.live.ts`, are never picked up by `npm test`, and refuse to run unless
`GMA3_LIVE=1` is set and the loaded show file name matches `GMA3_LIVE_SHOW` (default: a name containing
"disposable", "mcp-test" or "scratch"). Each file documents the show objects it creates and deletes;
`test/live/README.md` lists the reserved ranges. Nothing in the tests calls `SaveShow`.

`npm run coverage:lcov` additionally writes `coverage/lcov.info` for editor and CI integrations. Lua coverage
is not measured.

Help pages, OSC and Lua API details were taken from the manual bundled with onPC 2.5.1
(`~/MALightingTechnology/gma3_2.5.1/shared/language/HTML`).


See the [live test guide](../test/live/README.md) for prerequisites and reserved show objects.
