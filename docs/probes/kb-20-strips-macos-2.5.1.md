# KB-20 live probe: parameter strips on the console backend (macOS, onPC 2.5.1.0)

`node scripts/kb20-probe.mjs run --out docs/probes/kb-20-strips-macos-2.5.1.json` on 2026-10-10 (20:34 UTC): **28/28**
([script report](kb-20-strips-macos-2.5.1.json)). Bridge 0.16.0 with `gma3_mcp_control` 0.3.0, `gma3_mcp_feedback` 0.4.0
and `gma3_mcp_hardkeys` 0.10.0 (the set pinned at `01e1561`), started by the operator path
`Plugin 1 "lua input=keyboard control=console"` on show `mcp-test-disposable` (the show as loaded had none of the
KB-03..KB-19 macros any more, so the plugin was re-imported from the library as `bridge.xml` and started from the
command line; the probe makes no operator decision itself). Verify ran first (8/8, nothing queued). A first `run` of
the same revision passed 25/28 with three probe-side checks reading `lastApplied` after a request that bundled touch,
position and lift (the lift's noop); the checks were pointed at the backend's last command and the run repeated 28/28.

## Facts established before the run

- The console backend's capabilities read `{ relative, absolute, touch = true, button = false, targets = { slot, executor = false } }`;
  its limitations name strips (KB-20) and the `mixed-values` rule.
- With nothing selected a touch and a position on slot 1 are `target-unavailable` (the target resolves before the
  backend); a touch and a position on an executor fader are `unsupported` ("executor faders ... KB-21/KB-22"); an
  encoder press is `unsupported`. Nothing was queued or owned by verify.
- The busy guard refuses `lua` as well as `cmd` while a strip is touched, so every value read in the run follows a lift.

## What the console answered

- **Touch as a hold:** `Fixture 401`, Dimmer bank, `Attribute "Dimmer" At 40`. A touch down on slot 1 was admitted
  (`queued`), the bridge reported `busy` with reason `touch-down` (owner `conn-4`, `probe-mtouch/Strip1`), a `ClearSelection`
  through `cmd` was refused `[busy]`, the touch was applied as a noop ("the hold reserved its slot for the gesture"), the
  backend issued no command and its `applied` counter did not move.
- **The drag inside the touch:** three detents up and one back in one request coalesced into `Attribute "Dimmer" At + 2`
  (step 1 at Percent/Coarse); the programmer read 40 -> 42 after the lift. The lift was a boundary; the bridge was free
  again (`cmd` and `lua` accepted), the session had no gesture left.
- **Lift and re-touch:** a new gesture on the same slot with touch, five detents down and lift in one request read 42 -> 37.
- **Positions:** touch + `0.1` + `0.25` in one request: the second position superseded the first, `Attribute "Dimmer" At 25`
  was placed, the programmer read 25, `lastApplied.result` carried `value 0.25, amount 25, from 0, to 100, readout Percent`.
  Positions `1` and `0` placed 100 and 0.
- **Mixed values stay mixed:** `Fixture 401 At 20`, `402 At 50`, both selected: the binding reported slot 1 `valueState
  "mixed"` (absolute 20, the first fixture's). A position `0.5` was refused `mixed-values` (the message names
  `takeover = true`), both fixtures kept 20/50 (the ack also counted the refusal's sequence gap as `lost 1`: KB-18/19
  behaviour of admission refusals, not transport loss). Five relative detents moved them to 25/55. A position `0.6` with
  `takeover = true` placed `Attribute "Dimmer" At 60` on both (60/60); the backend's record says `takeover true,
  valueState mixed`.
- **Physical readout:** `Fixture 601`, position bank: Pan `Physical`, PhysicalFrom/To -225..225 (range 450), Tilt range 210.
  Position `0.5` placed `Attribute "Pan" At 0` (`from -225, to 225, amount 0`) and the programmer read 50 percent;
  position `0.1` placed `Attribute "Pan" At -180` and read 10 percent.
- **Empty selection:** a touch on slot 1 was `target-unavailable` (no fixture is selected), no hold, the bridge not busy.
- **Press:** with a live target an encoder press stayed `unsupported`.
- **Cleanup:** the registered undos ran (strips released, session closed, `Select EncoderBank 1.1`, `ClearSelection`,
  `ClearAll`); the selection was empty, the bank back, the programmer provably empty (70 of 70 fixtures scanned), no
  session, gesture, queued intent or unresolved release left. Backend counters at the end: applied 18, noop 40,
  refused 0, raised 0.

## Not exercised live

A binding change while a strip is touched (the hold keeps the bridge `[busy]`, so no page change can be driven through
it; the `gesture-rebound` refusal is harness evidence, as in KB-18); a mixed physical range (one mover on the show);
the surface's gesture conversion (mtpnxk's record); physical M-Touch hardware (KB-24).
