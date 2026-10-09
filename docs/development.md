# Development

[README](../README.md) · [Contributing](../CONTRIBUTING.md) · [macOS setup](setup/macos.md) · [Windows setup](setup/windows.md)



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
  signal-table registration, key resolution against the KB-01 default profile and the feedback readers (KB-06: strict
  values, per-display and per-executor items, partial failures, bounded request expansion, the watch/service/snapshot
  cache with staleness, invalidation on consumer request and on show/user/profile change).
* `test/lua/hardkeys_sessions_test.lua` runs the KB-03 owned input sessions of `plugin/gma3_mcp_hardkeys.lua`
  against the module's fake backend with a staged fake user profile: admission, leases, stored tuples and
  routes, duplicates/aliases/displays/capacity, release ordering, remap/disable/profile-switch during a hold,
  taps and bounded deadline servicing, observed physical releases, disconnect, disable, dispose and adopt; and the
  KB-04 keyboard adapter over stubbed console deps (`Keyboard()` argument passing, pre-dispatch refusals, raising
  calls kept as unresolved, bounded MASTATE readback, exclusive long-press, combos, backend-origin records); and the
  KB-05 interactions, admission, text policy and sequences (busy/ownership refusals, expiry, sequences serviced step by
  step, failure and uncertainty mid-sequence, disconnect mid-sequence, chunked text with context recheck, Unicode).
* `test/lua/bridge_plugin_test.lua` exercises the console plugin under a stock Lua 5.4+ interpreter with the
  grandMA3 API and LuaSocket stubbed: Lua execution off by default, budget behavior and execution-environment restrictions (hook removal,
  child coroutines, deadlines across yields), argument parsing, loopback-only binding and rejection of a
  non-loopback peer, and the connection-bound `input.*` ops (control invocations that never release, cleanup
  on disconnect/stop, records kept across a restart, `input=keyboard` through a stubbed `Keyboard()`, refused backend
  switches, `input.combo`, cleanup-only attach in `input recover`, a flooding client that cannot starve deadline servicing,
  and the KB-05 `[busy]` guard on mutating ops across two connections, structured error replies, interactions,
  sequences serviced by the loop, a disconnect mid-sequence and cleanup while input is disabled).
  `npm test` runs them when `lua` is on PATH and skips them otherwise (`brew install lua`).
* `input.test.ts` runs the KB-05 input tools against a scripted fake bridge: the ops and arguments sent, waiting for a
  sequence without resending it, structured errors and partial progress kept, the outcome model, the text policy and the
  mutation lock.
* `kb02-probe.test.ts`, `kb03-probe.test.ts`, `kb04-probe.test.ts` and `kb05-probe.test.ts` run the live probe scripts
  against fake bridges to make sure their checks fail when a bridge misbehaves and that they refuse unsafe preconditions
  (the KB-04 and KB-05 probes press real keys, so their gate — keyboard backend, Lua on, disposable show, idle and not
  busy — is what the tests guard).

Live tests live in `test/live/*.live.ts`, are never picked up by `npm test`, and refuse to run unless
`GMA3_LIVE=1` is set and the loaded show file name matches `GMA3_LIVE_SHOW` (default: a name containing
"disposable", "mcp-test" or "scratch"). Each file documents the show objects it creates and deletes;
`test/live/README.md` lists the reserved ranges. Nothing in the tests calls `SaveShow`.

`npm run coverage:lcov` additionally writes `coverage/lcov.info` for editor and CI integrations. Lua coverage
is not measured.

Help pages, OSC and Lua API details were taken from the manual bundled with onPC 2.5.1
(`~/MALightingTechnology/gma3_2.5.1/shared/language/HTML`).


See the [live test guide](../test/live/README.md) for prerequisites and reserved show objects.
