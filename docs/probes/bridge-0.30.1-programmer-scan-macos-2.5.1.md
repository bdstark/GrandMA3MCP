# Bridge 0.30.1 probe: the programmer scan of all fixtures and patch index 0 (macOS, onPC 2.5.1)

- **Date:** 2026-10-15
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, the throwaway show `NewShow_2026.10.15_23.16.24UTC`
  (148 subfixtures, no Universal fixture), bridge 0.30.0, then 0.30.1
- **Found by:** the SU-12 live test ([su-12-batch-forms-macos-2.5.1.md](su-12-batch-forms-macos-2.5.1.md)).
  `gma3_store_preset` refused a preset on fixtures 101–104 with "fixture 101 has no programmer value", right after the
  look check had read 101's value.

## Patch indices

| Call | Result |
| --- | --- |
| `GetSubfixtureCount()` | 148 |
| `GetSubfixture(0)` | fixture 101 (HexPar) |
| `GetSubfixture(1)` | fixture 102 |
| `GetSubfixture(147)` | the last Festoon cell |
| `GetSubfixture(148)` | nil |

The indices run 0..count−1. The `programmer` op's scope `all` looped 1..count−1, written for a show whose index 0 is
MA's Universal fixture (the SB-03 probe names it). In a show without one, index 0 is the first patched fixture, and
its values were never read.

## Programmer reads (Normal, `Fixture 101 + 102`, `At 50`)

| Read | 0.30.0 | 0.30.1 |
| --- | --- | --- |
| scope `selection` | 101/0, 102/1 | 101/0, 102/1 |
| scope `all` | 102/1 only | 101/0, 102/1 |

## Affected readers

These read the programmer with scope `all`, so on 0.30.0 they missed the first patched fixture:
- `gma3_store_preset`: its content check refused a scope that included the fixture, and did not see an unexpected
  value on it;
- the Normal-programmer snapshots of `gma3_store_cues`, `gma3_build_chase`, `gma3_build_phaser` and the SU-12 preset
  batch, which would not have noticed a change on it;
- `gma3_programmer` with scope `all`.

## Result

Bridge 0.30.1 scans 0..count−1. With it, the SU-12 live test passed on fixtures 101–104
(`test/live/batch.live.ts`, `GMA3_LIVE_BATCH_FIDS=101,102,103,104`).
