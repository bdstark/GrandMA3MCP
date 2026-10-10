# KB-18 live probe: continuous-control admission (macOS, onPC 2.5.1.0)

Evidence for [ENCODERS.md](../../ENCODERS.md) "KB-18". Script: `node scripts/kb18-probe.mjs run --out
docs/probes/kb-18-control-macos-2.5.1.json` ([report](kb-18-control-macos-2.5.1.json), 30/30). Bridge 0.14.0,
`gma3_mcp_control` 0.1.0 on the **fake backend** (intents recorded, nothing moved on the console), `gma3_mcp_feedback`
0.3.0, `gma3_mcp_hardkeys` 0.10.0, show `mcp-test-disposable`, user Admin, profile Default, one physical display, Lua
enabled, bridge started `lua input=keyboard` (Macro 100 after `npm run install-plugin`), control enabled by the operator
with Macro 118 (`Plugin "gma3_mcp_bridge" "control=fake"`; Macro 119 is `control=off`). Run on 2026-10-10, last with
the module at `9f08f87` (both PR #22 review rounds in). A first run the same day failed 5 of 29 steps because the probe
sent `ClearSelection` while its own motion kept the bridge `[busy]` (the guard working as designed); the probe now waits
for the gesture to lapse and records that refusal as a step. The re-run after review round 2 first failed 17 steps with
`stale-binding`: a `control.bind` issued before the loop had observed every part read revision 0, because the module
assigned the binding revision only once the generation was known; fixed in `9f08f87` (the revision follows the
snapshot's key as soon as a snapshot exists), harness check added, re-run 30/30.

## What the console side answered

- **Read-only (`verify`, control disabled and enabled):** `ping.control` summary; `control.status` with the module
  version and three limitations; `control.bind` with the first eight assigned executors of page 1 (playback targets
  first) subscribed 12 items and, after 400 ms, the cached snapshot claimed generation 1 with nothing unobserved;
  `display = 0` is `[bad-args]`; with control disabled `control.submit` is `[control-disabled]` naming `control=fake`;
  with it enabled a malformed event (`bad-event`), an event one thousand generations ahead (`stale-generation`, current
  generation reported), executor 999999 (`target-unavailable`, "bind it first"), a position for executor 191 without
  a binding revision (`binding-required`, revision 1 reported) and one with revision 101 (`stale-binding`) were refused
  in place in one request,
  and on the empty selection slot 1 (`Dimmer`) was `target-unavailable` "no fixture is selected". The session opened on
  demand had nothing queued and no gesture; `control.close` dropped nothing.
- **Burst and order (`run`, after `Fixture 401`: generation 1 → 2, slot 1 `available`/`Coarse`):** ten relative deltas
  in one request were all admitted, nine coalesced into the first (`queued = 1`); the same event resent was `duplicate`;
  after skipping three sequence numbers the next event was accepted with `lost = 3`; an unseen number inside that gap
  arriving afterwards was `out-of-order`. The loop applied the merged intent (delta 2 over 10 events, `lost` carried) and
  the later one: `counters.applied = 2`, `coalesced = 9`, `lost = 3`.
- **Touch, serialisation and supersession (executor 191, `FaderMaster`):** the touch down was admitted; a `cmd` from a
  second connection was `[busy]` (`detail.module = "control"`, the owning session, reason `motion` for the delta sent
  18–332 ms earlier, then `touch-down`); the second connection's position for the same executor was a `conflict` with
  the owner; three positions from the owner superseded each other (`superseded = 1, 2`; the Master function is
  stateless); the release was admitted as a boundary and after the loop applied it the second connection's command
  went through.
- **Generation change:** a delta sent right before `ClearSelection` made the probe's own command `[busy]` (reason
  `motion`, 500 ms window); 650 ms later `ClearSelection` was admitted and the cached generation moved 2 → 3 (the
  cache followed within 100 ms in a separate timing run: `Fixture 401` and `ClearSelection` each visible at the next
  100 ms poll); an event still carrying generation 2 was refused `stale-generation` with `generation = 3`.
- **Disconnect:** a third connection pressed encoder button 1 (its gesture reported in `control.status`), then its
  socket was destroyed; within 400 ms the bridge logged `control: disconnect conn-455: button on probe-nxk-c/Rotary1
  ended (applied)`, `lastApplied` was the button release and the session was gone. The cleanup's `ClearSelection` left
  the selection empty; no session, gesture, queued intent or unresolved release remained.

## Not exercised live

A delta dropped by the loop because the generation moved while it was queued (the probe cannot change the console
while its own motion holds the `[busy]` guard; harness only), rate limiting (400 events/s per device), queue
eviction, `maxGestureMs`, a stateful fader function (`FaderX`/`FaderTemp`: harness only, no such executor on the test
page), a release the backend raised on (`control recover`: harness only), a second physical display, Windows, and
anything moving on the console: the fake backend records intents and KB-19 is the adjustment backend.
