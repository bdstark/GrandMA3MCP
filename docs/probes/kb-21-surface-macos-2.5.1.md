# KB-21 live check: playback banks and stable executor bindings (macOS, onPC 2.5.1.0)

mtpnxk_surface 0.7.0 imported as `mtpnxk.xml` into Plugin 2 of show `mcp-test-disposable` on 2026-10-10 and started with
`Plugin 2 "key=<64 hex> input=fake control=fake force"` (`force` because the MCP bridge 0.17.0 ran alongside as Plugin 1
with `input=keyboard control=fake`); vendored set hardkeys 0.10.0 / feedback 0.5.0 / control 0.4.0 from GrandMA3MCP
`ea5bc0d`; the release service at this commit, driven by its `sim` scripts (a simulated M-Touch: the ten playback strips
and the bank keys enter the service after the decoder; no M-Play was simulated, so its sections stayed `absent` and unbound).
The bridge was used for `cmd "Page 2"` / `"Page 1"` (a console page change while the surface followed the page) and, through
its `lua` op, to read the surface plugin's own control status (the two plugins share the console's Lua state). The holds
reached the surface plugin's **fake** control backend (the console backend refuses executor elements until KB-22):
nothing was pressed on the console; what the records show is binding, freezing and resolution.

## Procedure

1. Following mode, rows `201,201,301` (PFA n = executor 200+n key, the executors the show has assigned on page 1):

   ```
   mtpnxk --key-file … --pb-rows 201,201,301 --verbose sim --script "pfa1:down@1500,pbank:up@800,pfa1:up@800,pfa1:tap@600,pbank:down@400" --seconds 8
   ```

2. Independent page 2: `mtpnxk --key-file … --pb-rows 201,201,301 --pb-page 2 --verbose sim --script "pfa1:tap@1500" --seconds 4`
3. Following mode with the console changing page under the surface: `… --pb-rows 201,201,301 --verbose sim --script
   "pfa1:tap@7500" --seconds 9` while the bridge issued `Page 2` at 3.5 s and `Page 1` at 6.5 s.

## What happened

- **Binding:** after pairing the service sent `bind: 20 executor(s) following the console's page` (201-210 and 301-310: the
  keyA and fader rows coincide in this profile, the M-Play absent); the plugin acknowledged it with `binding revision 2`,
  re-watched 20 targets and the next context carried them (`20 executor(s), exec page 1`); the M-Touch page display went
  `-` (page unknown) then `11` (page 1, bank 1).
- **Bank change while held (run 1):** `PFA1` down was admitted against `execDefault#1/1.201.key|14.14.1.7.2|Flash` (page 1's
  201: a Flash button on the show). `PLAYBACK BANK +` moved the section to bank 2 (`executors 211-220 per row; 1 held
  button(s) keep their targets until released`), the bind went out again (revision 3), the display showed `12`. The release
  was sent to the frozen target: the service logged `released executor 201 key (pressed before the bank moved; now executor
  211 key)` (`frozen=1`) and the plugin's `lastApplied` reads `applied button down=false execDefault#1/1.201.key|14.14.1.7.2|Flash`.
  A fresh `PFA1` tap on bank 2 was refused `[target-unavailable] executor 211 is empty` (its release a noop); `PLAYBACK BANK -`
  rebound 201-210 (revision 4), the display back at `11`. Summary: `banks: follow page=1 mtouch=bank1(201-210) … changes=2
  edge=0 downs=2 ups=2 frozen=1`.
- **Independent page (run 2):** `bind: 20 executor(s) on page 2 (independent)`, the display showed `21` at once (the fixed
  page), the context said `exec page 1` (the console stayed on page 1) and the tap was refused `[target-unavailable]
  executor 201 of page 2 is empty`: resolved by (page, executor), never against the current page.
- **Console page change (run 3):** `Page 2` on the console moved the context generation exactly once (1 -> 2, `exec page 2`,
  display `21`) after a short `context unknown` window while the plugin re-read the twenty executors on the new page, and
  `Page 1` moved it once more (3, display `11`). An earlier run of the day, before the feedback fix, had moved it four times
  per page change (one per re-read batch); that was fixed upstream and re-vendored.
- **Revisions:** every bind's ack carried the revision; each new revision was logged once on the service (`held strip gestures
  are rebound`; no parameter strip was touched in these runs) and the events after it carried it (`br`).

## Not covered here

The physical M-Touch and M-Play through `run` (the `sim` path enters after the decoder; the hardware qualification with the
operator at the surfaces is KB-24's); an M-Play section (absent, unbound); a press on an executor the console backend serves
(KB-22); a bank edge on a real device; an explicit takeover on a parameter strip after a bank change (the rebind is logged,
the strip path is KB-20's record).
