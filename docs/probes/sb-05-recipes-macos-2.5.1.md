# SB-05 probe: recipe lines, auto-cooking, cook options and references (macOS, onPC 2.5.1)

Evidence for [SB-05 in SHOWS.md](../../SHOWS.md#sb-05--build-and-cook-recipe-based-presets-and-cues) and
[the recipe tools](../tools/recipes.md).

- **Date:** 2026-10-13
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, show `mcp-test-disposable`, bridge 0.23.0 (Lua on) for
  the manual pass, 0.24.0 for the tools
- **Method:** a manual pass through `gma3_lua` (`Cmd`, `Get`/`Set` on recipe lines, `GetPresetData` on cue parts and
  presets), then the tools through `test/live/recipes.live.ts`.
- **Objects:** Sequence 9060 (cue 1), Groups 908 and 909, Presets 23.921 and 4.921, all checked absent first and
  deleted afterwards. Fixtures 401–404 (Mega Hex Par); presets 4.4 "Red" (universal) and 1.11 "At Full".

## Recipe lines are objects

- A cue part's (or a preset's) recipe lines are its children of class **StandardRecipe** (the show's StartShow
  sequences carry some). A line has:
  - **references:** `Selection` (a group handle), `Values` / `Preset` (a preset handle), `MAtricks` and `Filter`
    (handles);
  - **settings:** `Enabled`, `SelectionMode` (Strict / Normal), `Name`, `SelectionFromValue`, the full MAtricks
    property set, and per-axis `FadeX`, `DelayX`, `SpeedX`, `PhaseX`;
  - **status:** `FailedCookedPart` ("None", "Group", "Matricks") and `EmptyLastCooking` (Yes / No).
- The existing `objects` op resolves a line as `Sequence S Cue C Part P.L` or `Preset Pool.N.L` (with `asText: false`
  the references come back as handles), and `set` writes its properties. No new op is needed for definitions.
- Cue numbers read ×1000 in Lua (`no` 1000 = cue 1).

## Creating and editing lines

| Command | Result |
| --- | --- |
| `Assign Group 908 At Sequence 9060 Cue 1 Part 0.1` (no line yet) | line 1 created with that selection |
| `Assign Preset 4.4 At Sequence 9060 Cue 1 Part 0.1` | its values |
| `Assign MAtricks 12 At … Part 0.1` | its MAtricks reference (XWings reads `<2>`, inherited) |
| `Assign Group 908 At … Part 0.2` / `… Part 0.9` with 3 lines | a new line 2 / **appended as line 4** (no gap) |
| `Move … Part 0.2 At … Part 0.1` | the two lines swap order |
| `Delete … Part 0.2 /NoConfirmation` | line 2 removed; the remaining lines are re-cooked |
| `Assign Group 908 At Preset 23.921.1` on a missing preset | "Illegal object"; on an existing (empty) preset: line 1 created |
| `Assign Shape 1 At Preset 23.921.2` | "Illegal object", **but an empty line 2 was left behind** |
| `set Name` on a line | applied |

## The console cooks by itself

| Case | Cue part data afterwards |
| --- | --- |
| line 1 assigned group 908 (401, 402) + Red | 401/402 ColorRGB_R 100, `mask_cooked` 511: **the Assign cooked the line** (OwnDataPresent Yes) |
| `Set("Enabled", "No")` on the line | **no data**: disabling removed its cooked output |
| `Set("Enabled", "Yes")` | cooked again: a property write re-cooks too (the manual: MergeLowPriority on edit) |
| group 908 overwritten with 401–403, read **in the same Lua chunk** (and the next) | unchanged (401, 402) |
| the same change read through the bridge **3 s later** (Sequences 9062/9063, one and two lines) | **401, 402, 403**: a group change is re-cooked in the background; shrinking back to 401 likewise (immediately still 401–403, 3 s later 401) |
| the line's values preset changed (R 50 → 20, `Store Preset 4.932 /Overwrite`) | immediately still 50, **3 s later 20** (also after 8 s): preset content changes are re-cooked in the background too |
| `Cook Sequence 9060 Cue 1 /MergeLowPriority` | 401, 402, 403 at once |

The first pass read the change in the same chunk and concluded that group changes are not cooked; the live test showed
the background cook and the follow-up above confirmed it. The tools therefore treat the console's own cooking as
asynchronous and offer an explicit, verified cook.

## Cook options against uncooked data

Cue 1 with a hard (stored, not cooked) value next to the recipe output:

| Option | Hard value on another fixture (404 Dimmer 70) | Hard value on the recipe's own fixture and attribute (401 R 30) |
| --- | --- | --- |
| `/MergeLowPriority` | kept | **kept** (the recipe does not override it) |
| `/Merge` | kept | **replaced** by the cooked value (R 100) |
| `/Remove` | kept; all cooked data removed | — |
| `/Overwrite` | **deleted**; only cooked data left | — |

A shrinking group under `/MergeLowPriority` or `/Merge` drops the cooked data of the removed fixtures. Every cook
above was sent with an option; without one the manual says a pop-up asks for it. No dialog appeared.

## Missing and empty references

| Case | Line afterwards |
| --- | --- |
| an empty group (Store Group with no selection) | Selection "Group 909", FailedCookedPart "Group", EmptyLastCooking Yes, no output |
| the referenced preset deleted | **Values empty** (no invalid handle remains), after a cook EmptyLastCooking Yes |
| the referenced group deleted | **Selection empty**, FailedCookedPart "Group" |
| line disabled | no output |

## Reading cooked coverage

`GetPresetData` works on a cue **Part** as on a preset: `by_fixtures[fid][attribute]` with `mask_cooked` 511 for
cooked values and 0 for hard ones. The bridge's `preset.read` (0.24.0) accepts a Part and reports `cooked` per row.

## The tools on the console

`test/live/recipes.live.ts` (bridge 0.24.0) first failed on its own assumption: it expected the group change to stay
uncooked, and the read after it already showed 401–403. That is how the background cook above was found; the test now
only reports the immediate read. Then 1/1 in 4.9 s:
- two lines (colour + dimmer on Group 910) cooked 401/402 next to the stored 404 Dimmer;
- the cook preview listed Cue 1 Part 0 with the members 401–403;
- overwrite was refused because of the 404 value;
- merge low priority over the whole sequence cooked 401–403 and kept 404;
- the lines were moved and one removed;
- Group 911 (empty) and a deleted preset were reported as problems;
- a preset recipe on 23.931 was added and cooked to 401–403.
