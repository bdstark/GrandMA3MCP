# Tested platforms and versions

[README](../README.md) · [Live probe records](probes/README.md) · [Module integration](modules.md)

This beta's reviewed source baseline is
[`9da14544155f921c5dd4fd1cbb9a1ea4bd6f6e78`](https://github.com/bdstark/GrandMA3MCP/tree/9da14544155f921c5dd4fd1cbb9a1ea4bd6f6e78).
The tables distinguish recorded console behavior from tests using simulated console dependencies.
Earlier probe records identify the component versions they exercised; they are not a claim that every
probe was rerun against this exact revision. An installation guide is not qualification evidence.

## Component baseline

| Component | Version at the reviewed revision | Consumer contract |
| --- | --- | --- |
| Node.js MCP server | 0.1.0 | stdio MCP; tools and results in the [reference](reference.md) |
| Console bridge | 0.18.0 | Local JSON-lines TCP; loopback only, no authentication; `input.routing` / `input.route` since 0.11.0 (KB-14); `input=mixed` since 0.12.0 (KB-15, harness only); `feedback.context`/`watch`/`unwatch` since 0.13.0 (KB-17); `control.*` and `control=fake` since 0.14.0 (KB-18); `control=console` since 0.15.0 (KB-19); strip touches and positions on the console backend since 0.16.0 (KB-20); `executorPage` on `feedback.context`/`control.bind` since 0.17.0 (KB-21); executor keys and faders on `control=console` since 0.18.0 (KB-22) |
| Hardkeys module | 0.10.0 (the reviewed baseline above shipped 0.4.0; `modules.lock.json` pins the 0.10.0 bytes for the KB-15 vendoring) | Module API 1; owned input, interactions, text and sequences; since 0.5.0 any `Enums.VirtualKeyCode` name and `prefer` for same-target ties (KB-07); routing policy (0.6.0), Quickey bank and backend (0.7.0/0.8.0), scoped shortcut-mode changes and text routes (0.9.0, KB-14) |
| Feedback module | 0.5.0 | Module API 1; read-only observations and bounded polling; control context and binding generations since 0.3.0 (KB-17); physical ranges per slot since 0.4.0 (KB-19); explicit executor targets, paged reads and the width/coverage rule since 0.5.0 (KB-21) |
| Control module | 0.5.0 | Module API 1; continuous-control admission, ordering, coalescing and bounds over an injected binding (KB-18); the console adjustment backend for attribute slots since 0.2.0 (KB-19); strip touches as holds, positions over the verified travel and the mixed-values rule since 0.3.0 (KB-20); page-aware executor resolution and frozen holds since 0.4.0 (KB-21); executor keys as Press/Unpress and faders through the configured function on the console backend, the assignment-changed recovery rule since 0.5.0 (KB-22) |

For independent plugins, use the [pinned module set](modules.md#vendoring-into-another-plugin-mtpnxk).
Do not infer exact source compatibility from version strings alone; retain the commit and file hashes.

## Live console evidence

| Environment | Recorded scope | Qualification limits |
| --- | --- | --- |
| macOS, grandMA3 onPC 2.5.1.0, US keyboard layout | [KB-01](probes/kb-01-macos-2.5.1.md) keyboard/feedback exploration, including one and two displays; [KB-02](probes/kb-02-loading-macos-2.5.1.md) module loading, isolation and save/reload; [KB-03](probes/kb-03-fake-macos-2.5.1.md) fake-backend sessions; [KB-04](probes/kb-04-keyboard-macos-2.5.1.md) real keys and recovery; [KB-05](probes/kb-05-input-macos-2.5.1.md) structured input; [KB-06](probes/kb-06-feedback-macos-2.5.1.md) feedback | Primary beta baseline. Later input/feedback probes used one physical display. Text-field behavior, visual long-press confirmation and other gaps remain as listed in each record. |
| Windows 11 Home 10.0.26300, grandMA3 onPC 2.5.1.0, en-US layout | [KB-01](probes/kb-01-windows-2.5.1.md), bridge 0.3.4: exploratory keyboard/feedback probes with one and two onPC displays | Later module loading and KB-03–KB-06 implementations have not been live-qualified on Windows. These probes do not establish parity with the macOS beta baseline. |
| Other onPC versions, non-US layouts and physical grandMA3 consoles | No qualification evidence recorded for this baseline | Treat as unqualified until equivalent tests are recorded. |
| Independent hardware surface (mtpnxk: NX-K keypad, Rust service, `mtpnxk_surface` plugin vendoring hardkeys 0.5.0 and feedback 0.2.0), macOS, onPC 2.5.1.0, same machine, US layout | [mtpnxk KB-07 record](https://github.com/bdstark/mtpnxk-client-pico/blob/main/docs/probes/kb-07-live-macos-2.5.1.md) (first live run with the NX-K, LEDs confirmed by the operator) and [KB-08 qualification](https://github.com/bdstark/mtpnxk-client-pico/blob/main/docs/probes/kb-08-qualification-macos-2.5.1.md) (latency rerun, lifecycle, floods); scope in its [deployments matrix](https://github.com/bdstark/mtpnxk-client-pico/blob/main/docs/deployments.md) | Beta on macOS only. Its press-to-effect p99 and flood limits are recorded as not met (open mtpnxk defects). Surface evidence does not extend the bridge's own qualification, and bridge evidence does not establish surface support. |
| A physically separate console machine, cross-user behavior | Not qualified end to end | Module isolation was probed locally; a user switch invalidating feedback was observed live by the surface (mtpnxk KB-08). |

Input is not display-routed on the probed onPC version. A valid display index is API context, not a
promise about focus or pop-up placement. A physical operator and independently loaded plugins share
console keyboard state; per-instance ownership does not provide cross-plugin arbitration.

## Automated and deployment evidence

| Environment or path | Evidence | What it establishes |
| --- | --- | --- |
| Ubuntu CI, Node.js 20 and 22, Lua 5.4 | [CI configuration](../.github/workflows/ci.yml), [successful run for the reviewed revision](https://github.com/bdstark/GrandMA3MCP/actions/runs/37956866987) | Clean dependency installation, TypeScript build and automated suite with Lua harnesses. This is not a Linux onPC qualification. |
| Local macOS review, Node.js 26.11.0 | Build, 251 automated tests (none skipped), 865 assertions across three Lua harnesses | Review-time checks against fake bridges and stubbed console APIs; no new live console mutations. |
| Node.js 18 | Declared package minimum | Not included in the current CI matrix; prefer the documented Node.js 22 setup until the minimum is separately tested. |
| Windows Node.js server | [Setup instructions](setup/windows.md) | No Windows CI job or current end-to-end qualification recorded. |
| Docker, SSH remote access and individual MCP client setup flows | [Docker guide](docker.md), [SSH guide](remote-access.md), platform setup guides | Documented deployment paths; not equivalent to a recorded end-to-end test of every host/client combination. |

The feedback cache's `watch()`/`snapshot()` behavior and identity-change failure paths are covered by
harness tests. A live user switch invalidating the cached `watch()` path was observed through the surface
consumer (mtpnxk KB-08, epoch bump within 1 s); live show-load and profile-switch invalidation remain outstanding.
A feedback epoch is local to an instance and restarts at 1; consumers must clear cached state on
reconnect/restart and use their own connection or plugin-generation identity when combining observations.

## Recording additional qualification

Record the source revision, component versions, OS, onPC version, keyboard layout, display arrangement,
user/profile and test procedure. Keep automated checks, observed console effects and untested behavior
separate. Run state-changing probes only on a disposable show and record recovery/cleanup outcomes.
Update this matrix and the relevant probe record when new evidence expands the tested scope.
