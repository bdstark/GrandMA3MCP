# KB-17 live probe: control-context and binding snapshots (macOS, onPC 2.5.1.0)

Evidence for [ENCODERS.md](../../ENCODERS.md) "KB-17". Script: `node scripts/kb17-probe.mjs run --out
docs/probes/kb-17-context-macos-2.5.1.json` ([report](kb-17-context-macos-2.5.1.json), 31/31). Bridge 0.13.0,
`gma3_mcp_feedback` 0.3.0, `gma3_mcp_hardkeys` 0.10.0, show `mcp-test-disposable`, user Admin, profile Default,
one physical display, Lua enabled, bridge started `lua input=keyboard`, KB-12 bank not provisioned (its Quickeys from
earlier sessions still sit on executors 178–189 of page 1). Run on 2026-10-10 after `npm run install-plugin` and Macro 100.

## What the snapshot answered

- **Identity:** show file, user, profile and the data pool (`Default`, no 1, `14.14.1`) in one `identity` table.
- **Authoritative display:** display 1 by configuration (`rule = configured`); `display = 2` (`requested`) is
  unavailable with "display 2 has an encoder bar without EncoderBankSelector/PresetBar" (onPC exposes a display-2
  handle with an `EncoderBarContainer` but no widgets on one monitor); display 9 "does not exist". Nothing was
  substituted in either case.
- **Encoder bank/page/context:** bank 1 `Dimmer` (1 page) / page 1 `Dimmer` (5 pool slots) / `Default`
  (`attributeEditing = true`), names from the profile pool, 10 banks.
- **Slots:** slot 1 `Dimmer` (`Dim`, `LuminousIntensity`, `Percent`, `Coarse`, layer `Absolute`), slots 2–5 `empty`
  (the on-screen bands still read `G`, `B`, `Amber`: stale labels, reported but not an assignment, as KB-16 found).
  With nothing selected every attribute slot is `no-selection` / `none`.
- **Executor targets:** 32 assigned executors on page 1: 178–189 `Quickey` objects, `playbackTarget = false` with the
  KB-12 reason; the sequences with `keyPress`/`keyUnpress`/`fader` as configured, the `FaderMaster` level, activity
  `false`, `backRGBA` where the object has an appearance (`FF7F00FF` on 191/192/291/292) and an explicit
  `appearanceUnavailable` otherwise. Executor 999 is an explicit empty target.
- **Cached path:** `feedback.watch` with four executors subscribed 8 items; after 600 ms the cached snapshot had every
  item observed (ages 54–101 ms), generation 1; `feedback.unwatch` left `watched = 0`.
- **Generation (run phase, one spec with four executors):** 1 at start → 2 after `Fixture 401` (slot 1 `available`,
  value `empty`) → 3 after `Select EncoderBank 4` (Color/RGB, four `ColorRGB_*` slots `available`) → 4 after
  `Select EncoderBank 4.2` (RGB page 2) → 5 back on page 1 → **5 after `Attribute "ColorRGB_R" At 50`** (value state
  `value`, 50; a value change moves nothing) → 6 after `Page 2` (every target empty). The cleanup ran every registered
  undo (`Page 1`, `Off Attribute`, `Select EncoderBank 1.1`, `ClearSelection`, then `ClearAll`) and the final snapshot
  matched the first; the programmer was proven empty again through the `programmer` op.

## Findings worth keeping

- `GetProgPhaser(ui, false)` returns **nil** for a channel the programmer holds nothing for and a table with step 1
  once it has a value; the reader maps nil to `valueState = "empty"` (first run reported it "unavailable").
- `Attribute "ColorRGB_R" At 50` on fixture 401 activated the other colour components (`G`, `B`, `W`, `RY`, `UV`) in
  the programmer as well; `Off Attribute "ColorRGB_R"` removed only R. A probe that writes a colour component must end
  with `ClearAll` (as KB-16 did) or it leaves programmer content behind; the first run of this probe did.
- The `channelFunction` selector text is empty for single-function attributes (`Dimmer`, `ColorRGB_*` here).
- A `feedback.context` with `allExecutors` is its own binding key (its executor list differs), so its generation is
  independent of the probe's four-executor spec.

## Steps

| Step | Result |
| --- | --- |
| feedback.context answers (bridge 0.13.0+, feedback 0.3.0+) | pass |
| identity carries show, user, profile and data pool | pass |
| the authoritative display is the configured one and says so | pass |
| encoder bank/page/context readable on the authoritative display | pass |
| bank and page names come from the profile pool (no poolUnavailable) | pass |
| ordered slots with attribute identity, unit, readout, resolution and layer | pass |
| slot labels match the on-screen bands for the live slots | pass |
| availability and value state are explicit per slot | pass |
| executor targets: every assigned executor of the page, each with functions and a playback-target verdict | pass |
| Quickey-bank executors are never playback targets | pass |
| sequence executors report the configured fader function's level and activity | pass |
| appearance colour readable where the object has an appearance | pass |
| a repeated read keeps the generation (nothing changed) | pass |
| display 2: requested rule; without an encoder bar it is unavailable and not replaced | pass |
| display 9 does not exist: unavailable with the reason | pass |
| malformed executors are refused with bad-args | pass |
| an executor that does not exist is an explicit empty target | pass |
| feedback.watch subscribes the context items | pass |
| a cached snapshot is served from the loop's observations without reading | pass |
| feedback.unwatch stops the loop's reads | pass |
| reads left the context unchanged | pass |
| the command line is untouched | pass |
| run: preflight gate (programmer provably empty through the programmer op) | pass |
| run: Fixture 401 changes slot availability and moves the generation | pass |
| run: Select EncoderBank 4 moves the bank and the generation | pass |
| run: Select EncoderBank 4.2 moves the page and the generation | pass |
| run: Attribute "ColorRGB_R" At 50 is a value change: value state follows, generation stays | pass |
| run: Page 2 changes the executor page and every target, moving the generation | pass |
| run: cleanup ran every registered undo | pass |
| run: the context is back where it started (bank, page, selection, executor page) | pass |
| run: the programmer is empty again (provably, through the programmer op) | pass |

## Not exercised

- Changes made by hand in onPC (`node scripts/kb17-probe.mjs watch` exists for the operator), a second physical
  display, Windows, other users/profiles, a data-pool switch, a preset-bar context other than `Default`, phaser slots
  live (harness only), a provisioned KB-12 bank (the `reservedExecutors` exclusion is harness-covered; the Quickey class
  exclusion was seen live), mixed selections live (harness only), fader functions other than Master live.
