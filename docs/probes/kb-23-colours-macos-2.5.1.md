# KB-23 live record: colour metadata and playback appearance (macOS, onPC 2.5.1.0)

Run on 2026-10-10 (local time; the report's timestamps are UTC, 2026-10-11T02:38) against show `mcp-test-disposable` on
onPC 2.5.1.0 (`hostType onPC`, user Admin), bridge **0.18.0** with `gma3_mcp_feedback` **0.6.0** (the set pinned at
`45945bf`), `gma3_mcp_control` 0.5.0 and `gma3_mcp_hardkeys` 0.10.0, started `lua input=keyboard control=console`.
Script report: [kb-23-colours-macos-2.5.1.json](kb-23-colours-macos-2.5.1.json) (`node scripts/kb23-probe.mjs run`,
**10/10**). Every observation came through the bridge (`feedback.context`, `cmd`, `lua`); nothing was typed on the
console. The plugins were reloaded through a macro written over the bridge's `lua` op (Macro 117, deleted afterwards).

A first run the same evening scored 10/10 with the module before the fix below, but reported `ColorRGB_UV`'s colour
**unavailable** ("component out of range"): its definition colour is out of gamut live (see finding 3). The module now
clamps and flags it; the report file is the re-run on the fixed set.

| Item | Value |
| --- | --- |
| Encoder bank before/after | 1 "Dimmer" page 1 (Dimmer in slot 1, four empty slots) |
| Selection before/after | empty (the operator's 8-fixture selection was cleared with `ClearSelection` before the run; the programmer was not touched) |
| Probe's changes (undone) | `Fixture 401`, `Select EncoderBank 4.1`, `4.2`, `4.3` (page 3 not selectable for the selection), `Select EncoderBank 1.1`, `ClearSelection` |
| Colour bank 4 page 1 "RGB" | ColorRGB_R "R", ColorRGB_G "G", ColorRGB_B "B", ColorRGB_RY "Amber", one empty slot |
| Colour bank 4 page 2 "RGB" | ColorRGB_W "W", ColorRGB_UV "UV", three empty slots |
| Playback page | 1: 27 playback executors (191-198, 201-208, 210, 291-298 Sequences; 401/402 MasterSpeed) |

## What was verified

| # | Check | Result |
| --- | --- | --- |
| 1 | `feedback.context` answers with feedback 0.6.0 (the loaded module) | PASS |
| 2 | every attribute slot of the current page (Dimmer) carries `featureGroup`/`featureName` from the definition's path and a parsed `Color` or an explicit reason | PASS |
| 3 | every assigned executor of page 1 carries parsed appearance components (0..1) or `appearanceUnavailable` | PASS |
| 4 | the parsed appearances are 0..1 components; the live form is **hex** (`FF7F00FF`) | PASS |
| 5 | reading moved no generation | PASS |
| 6 | run: colour bank page 1 "RGB": R, G, B, RY are all `Color/RGB`, activation group `ColorRGB`, colours defined | PASS |
| 7 | run: colour bank page 2 "RGB": W and UV likewise; UV's colour **clamped** (`colorClamped`) | PASS |
| 8 | run: the attribute definitions of R, G, B, RY, W, UV, Dimmer, Pan, Gobo1 read through Lua (Color, Feature, ActivationGroup, Special) | PASS |
| 9 | run: every registered undo ran (`Select EncoderBank 1.1`, `ClearSelection`) | PASS |
| 10 | run: the selection is empty and the encoder bank is back on 1.1 | PASS |

## Findings

1. **The show's definitions colour every RGB component**, as the console prints them (RGBA floats): R `1,0,0`, G `0,1,0`,
   B `0,0,1`, RY (band label "Amber") `1,0.5,0`, W `1,1,1`. The surface's colour scheme can take these from the
   definition (`ColourSource::Definition`); the name-override table is only a fallback for shows without them.
2. **Dimmer, Pan and Gobo1 are black** (`0,0,0,1`): `colorDefined = false`, the category scheme applies. Dimmer's
   `ActivationGroup` is `""` (no field); Pan's is `PanTilt`, Gobo1's `Gobo1`, every RGB component's `ColorRGB`.
3. **UV's definition colour is out of gamut:** `0.1744260043,-0.1443289965,1.0000000000,1.0000000000` (a negative green
   component: the console's representation of UV beyond RGB). The first module refused it ("component out of range");
   0.6.0 at `45945bf` clamps it to `0.1744,0,1,1`, keeps `colorDefined = true` and sets `colorClamped`. The surface
   shows UV as the documented violet stand-in (magenta on a 3-bit bar) by name regardless.
4. **Appearances live are hex `RRGGBBAA`** (`FF7F00FF` -> `1, 0.498, 0, 1`, "Orange" on 191, 192, 291, 292); the other
   sequences have no Appearance (`appearanceUnavailable: "the object has no Appearance"`), the MasterSpeed objects on
   401/402 neither. Executor 291 was running during the run (`active: true`, level 100), left alone.
5. The colour bank's page 3 was not selectable with fixture 401 selected (the selection lacks its attributes; the
   console keeps page 1), as KB-16 recorded for other pages; the probe notes it and moves on.

## Re-run after the PR #27 review round 1 (2026-10-10)

The module set at `9535ded` (feedback 0.6.0 parsing numeric-only six- and eight-digit hex as hex) was reinstalled the
same way and `node scripts/kb23-probe.mjs run` scored **10/10** again (the same steps and evidence; the appearances on
this show are letter-bearing hex, so the fix is exercised by the harness, not by this show). The report file was replaced
by this run.
