# KB-19 live probe: the console adjustment backend (macOS, onPC 2.5.1.0)

Evidence for [ENCODERS.md](../../ENCODERS.md) "KB-19". Script: `node scripts/kb19-probe.mjs run --out
docs/probes/kb-19-adjust-macos-2.5.1.json` ([report](kb-19-adjust-macos-2.5.1.json), 39/39). Bridge 0.15.0,
`gma3_mcp_control` 0.2.0 on the **console backend** (values moved on the console), `gma3_mcp_feedback` 0.4.0,
`gma3_mcp_hardkeys` 0.10.0, show `mcp-test-disposable`, user Admin, profile Default, one physical display, Lua
enabled, bridge started `lua input=keyboard` (Macro 100 after `npm run install-plugin`), control enabled by the
operator with Macro 120 (`Plugin "gma3_mcp_bridge" "control=console"`; 118 is `control=fake`, 119 `control=off`). Run
on 2026-10-10, last with the modules at `e142672` (the PR #23 review fixes in: attribute-editing context required, complete
physical ranges only, calibration in the binding digest), 39/39 again. Test fixtures: 401/402 (Mega Hex Par: Dimmer, ColorRGB_R/G/B/W/RY/UV, Shutter1), 601 (180W Beam Moving
Head: Dimmer, Pan, Tilt, Gobo1, Color1, Focus1 ...). Two earlier runs the same day failed on the probe's own account
(a fresh event factory per rebind replayed sequence numbers, so everything after the first rebind was `duplicate`; a
colour component adjusted from an empty programmer started at its output default 100 and clamped), not on the console's.

## Facts established before the run (`gma3_lua`, this session)

- Attribute definitions on this show: `Dimmer`, `ColorRGB_*`, `Shutter1`, `Focus1` read out in **Percent**; `Pan`,
  `Tilt`, `Gobo1`, `Color1` in **Physical** (`NaturalReadout`), all `EncoderResolution = Coarse`.
- `Attribute "Pan" At 10` on fixture 601 put the programmer at `absolute = 52.22` (percent of the range), `At + 10` at
  `54.44`: for the Physical readout **`At` takes physical units** (degrees here) and `GetProgPhaser().absolute` stays a
  percentage of the range (-225..225 => 10 deg = 2.22 %).
- The range is readable: `GetUIChannel(ui).logical_channel` is the fixture type's logical channel (a handle); its
  children are the `ChannelFunction`s with raw `PhysicalFrom`/`PhysicalTo` and `Attribute` (display role). 601: Pan
  -225..225, Tilt -105..105, Gobo1 0..15 (function 1 of 2, `Gobo1WheelSpin` 3.14..-3.14 is function 2), Color1 0..12
  (of 2), Shutter1 1..1 (of 2), Focus1 0.01..1, Dimmer 0..1; 401: Dimmer 0..1, ColorRGB_R 0..1.
  `GetChannelFunction(ui, k)` answered for one channel only and is not used.
- Encoder bar pool: banks 1 Dimmer, 2 Position, 3 Gobo (2 pages), 4 Color (3 pages), 5 Beam, 6 Focus, 7 Control,
  10 Phaser.
- The grandMA3 manual ("Encoder resolution"): 24 clicks per turn, 5 turns across an attribute's range; Coarse at the
  Percent/PercentFine readouts is 1 per click, at Physical `(max - min) / 120`; Fine is ten times finer; Increment
  and Native are different modes. KB-16 had measured `At + 1` = one Coarse click at Percent.

## What the console answered

- **Read-only (`verify`):** the ping summary names the backend; `control.status` carries the console backend's
  capabilities (`relative` only, `button = false`) and calibration (Percent 1, Physical `range/120`, Fine 0.1, fine
  divisor 10); `control.bind` with four executors; an encoder press on slot 1 with nothing selected is
  `target-unavailable` (the target resolves before the backend's verdict), a strip position and a touch on executor
  191 are `unsupported` naming the console backend; the session had nothing queued and the backend's counter stayed
  at 0; `control.close` dropped nothing.
- **One detent, one click (`run`, `Fixture 401`, Dimmer bank):** slot 1 `Dimmer` Percent/Coarse, programmer empty;
  one detent was applied as `Attribute "Dimmer" At + 1` and the programmer read 1 (the output value plus one); ten
  detents in one request coalesced into `At + 10` (11); `-3` was `At - 3` (8); two **fine** detents were `At + 0.2`
  (8.2); 4096 detents up read 100 and 4096 down 0 (the console clamps).
- **Relationship preserved (`Fixture 401 At 20`, `402 At 50`, both selected):** five detents moved both by 5
  (25 / 55); the slot read `mixed` value state before and after (the fixtures disagree), availability `available`.
- **Colour pages (`Select EncoderBank 4`):** slot 2 was `ColorRGB_G`; from 40, seven detents were
  `Attribute "ColorRGB_G" At + 7` (47); on page 2 slot 1 meant `ColorRGB_W` and three detents made 43. The command
  named the slot's attribute each time (`lastApplied.result.attribute`). Note: a colour component's output default is
  100 on this fixture, so a relative step from an empty programmer clamps at 100; the probe starts from 40.
- **Page change with motion queued:** the motion kept the bridge `[busy]` (reason `motion`), so the probe's
  `Select EncoderBank 4.1` was refused until the gesture lapsed; afterwards the generation moved (29 -> 30) and an event
  still carrying the old one was `stale-generation`.
- **Pan/Tilt (`Fixture 601`, Position bank):** Pan Physical/Coarse with `physicalRange 450`, Tilt 210; four detents on
  Pan were `Attribute "Pan" At + 15` (450 / 120 = 3.75 deg per click; the programmer moved from the centre by
  4 x 0.833 % = 3.33 %), two fine detents subtracted 0.75 deg; three detents on Tilt were `At + 5.25` (210 / 120 per
  click) and moved the programmer by 2.5 %.
- **Gobo bank:** slot 1 `Gobo1` Physical, function `Gobo1 1` of 2 (the selector text is empty), range 15; two detents
  were applied as `At + 0.25` and the programmer followed.
- **Mixed fixtures (`Fixture 401 + 601`):** on the colour bank `ColorRGB_R` was `mixed`; five detents were admitted
  with `mixed = true`, 401 moved 30 -> 35 and 601 has no such channel; on the Dimmer bank six detents moved both
  fixture types by 6.
- **Refusals:** with the selection cleared slot 1 was `target-unavailable` ("no fixture is selected"); for 601 on the
  colour page the console kept (`Color1` / `COLORMIXER`) the `COLORMIXER` slot was `unavailable` and refused with that
  reason; an encoder press with a live target was `unsupported` and issued no command.
- **Cleanup:** `control.close`, `Select EncoderBank 2.1`, `ClearSelection`, `ClearAll` all ran; the selection was
  empty, the programmer provably empty through the `programmer` op, no session, gesture, queued intent or unresolved
  release remained; the backend had applied 38 commands, refused none, raised none.

## Not exercised live

Editor contexts: a preset-bar context other than `Default` was **not** refused by the module as recorded here (review
of PR #23 reproduced an Editor context issuing `Attribute "Dimmer" At + 1`); since the review fix target resolution
requires `attributeEditing == true` from the encoder-bar reading and refuses editors, phasers and an unreadable context
`unsupported` (harness only; no live run in an editor). Likewise the harness-only review fixes: a physical range is
reported only when every fixture with the channel contributed its own function's range and the scan covered the whole
selection with every fixture's channels enumerated and mapped (otherwise the Physical readout is refused; review round 2: a
failed channel discovery is incomplete coverage, not a confirmed missing attribute), and a range or coverage change moves
the binding generation so queued motion is dropped. Fine/Increment/Native as the slot's **configured** resolution (every attribute here
is Coarse; Fine is exercised through the fine gesture only), non-Default layers, mixed fixture types with different
physical ranges on one slot (the smallest range is chosen in the harness only), a second physical display, Windows,
the outer ring and a fifth slot (reported, refused), the NX-K hardware itself (the surface half is mtpnxk's). Nothing
in this record claims native encoder equivalence: the adjustment is the explicitly limited mode KB-16 allowed.
