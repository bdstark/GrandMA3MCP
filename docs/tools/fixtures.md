# Fixture programming tools (FR-03)

Module: `src/tools/fixtures.ts`. Tools: `gma3_select`, `gma3_set_attribute`, `gma3_set_color`,
`gma3_set_position`, `gma3_clear_programmer`.

All five use only the existing bridge ops: `cmd` for every mutation, `objects` for read-only checks and
selection read-back, `children` to list selected members. No Lua is generated, so they work with Lua
execution disabled. Results follow the shared model in `src/results.ts` (outcome, verification, one step
per bridge request).

## Facts about the console these tools rely on

Confirmed in the grandMA3 2.5.1 manual (keyword pages Fixture, Group, SelectFixtures, At, Attribute,
Absolute, Percent, PercentFine, Physical, Natural, Decimal8/16/24, ClearSelection, ClearActive, ClearAll;
"Select Fixtures" operate page):

* `Fixture 1 Thru 5` and `Group 3` run the default function **SelectFixtures**. The manual: *if only
  fixtures are selected, SelectFixtures adds fixtures to the selection; if fixtures are selected and
  activated in the programmer, it replaces the selection.* The result of a plain select therefore
  depends on programmer state. Only `ClearSelection` first (`clear_first` / `replace_selection`) makes it
  deterministic. The live test records which behaviour the console shows.
* `Attribute "<name>" At Absolute <ValueType> <value>` applies an absolute value to the **current
  selection** in the programmer. Without a value-type keyword the user profile's readout decides what the
  number means; the tools therefore always send the `Absolute` layer and, when a unit is given, an explicit
  value-type keyword (`Percent`, `PercentFine`, `Physical`, `Natural`, `Decimal8`, `Decimal16`, `Decimal24`).
* RGB mixing uses the attributes `ColorRGB_R`, `ColorRGB_G`, `ColorRGB_B` (2.5.1 attribute definitions;
  there is no `ColorAdd_*`). They use the Percent readout, 0..100.
* Pan/Tilt in degrees is the Physical readout (`Attribute "Pan" At Absolute Physical 75.6`).
* `ClearSelection` deselects only. `ClearActive` deactivates values (selection and values stay).
  `ClearAll` clears the selection and discards every programmer value. Plain `Clear` steps through
  them and is never sent.
* The `Selection` object exposes `CountTotalSelected` and `CountFullySelected` (readable through
  `objects`, ref `Selection`); its children are the selected (sub)fixtures. `Count` is a method and not
  usable as a field.
* `Attribute "<name>"` resolves through `ObjectList` to the show's attribute definition, so the existence
  of an attribute *name* can be checked read-only. Whether a particular fixture has that attribute cannot.
* Programmer values are **not** readable through the structured ops. Every set tool reports verification
  `unavailable` with the detail "programmer values are not readable through the structured ops; use
  gma3_programmer (FR-08) when available".

## Rules common to all five tools

* **Explicit targets.** The set tools require exactly one of `fixtures` (range or group) or
  `use_selection: true`. Nothing defaults to the current selection.
* **Nothing clears the programmer implicitly.** The only `Clear*` commands ever sent are
  `ClearSelection` when the caller passes `clear_first` / `replace_selection: true`, and the command
  chosen by `gma3_clear_programmer`'s mandatory `mode`. `ClearSelection` does not touch programmer values.
* **Serialisation.** Each call runs its whole sequence (pre-checks, commands, read-back) inside the
  server's mutation lock, so two tool calls from this server never interleave their commands. The lock
  orders only this server's own requests: **it does not isolate the sequence from another console
  operator, another MCP server, OSC, or anything else talking to the console at the same time.**
* **Stop at first non-success.** A rejected (`Illegal Command`, `Syntax Error`, ...) or uncertain
  (no/unfamiliar feedback, lost reply) step stops the sequence; later steps are reported `skipped`.
  Nothing is retried. A lost reply after dispatch is `unknown`, not failed.
* **Outcome counts mutations only.** Read-only steps (`resolve_target`, `check_selection`,
  `check_attribute`, `read_selection`, `read_selected`) appear in `steps` but do not make a result
  `partial`: if a pre-check fails nothing was sent and the outcome is `failed`.
* **Zero is a value.** `value: 0`, `red: 0`, `tilt: 0` are sent as `0`.
* Every result carries `selectionChanged` and `programmerValuesChanged` (true only when the
  corresponding command step succeeded) and the serialisation caveat in `warnings`.
* Validation (`src/validate.ts`): `fixtureSelection` allows fixture IDs with sub-IDs, `Thru`, `+`, `-`,
  and the object keywords `Fixture`, `Group`, `Channel`, `Subfixture`; quotes, names and any other token
  are refused. `attributeName` allows `[A-Za-z][A-Za-z0-9_.]*` only. Numbers must be finite.

## gma3_select

Select fixtures by range or group.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `fixtures` | string, required | `"1 Thru 5"`, `"1 + 3 + 5 Thru 8"`, `"Fixture 101.1"`, `"Group 5"`. A bare number list gets the `Fixture` keyword. |
| `clear_first` | boolean, default false | Send `ClearSelection` before selecting. |

Commands, in order:

1. `objects` ref `<fixtures>` (read-only): the expression must resolve to at least one object, otherwise
   the result is `failed` and nothing is sent.
2. `ClearSelection` — only when `clear_first` is true.
3. `<fixtures>` (e.g. `Fixture 1 Thru 5`, `Group 5`).
4. `objects` ref `Selection` fields `CountTotalSelected`, `CountFullySelected` (read-back).
5. `children` ref `Selection` (first 50 members, for information).

Changes the selection: yes (that is its purpose). Clears programmer values: no. Verification: `matched`
when `CountTotalSelected >= 1` after the select, `mismatched` when it is 0, `unavailable` when the count
cannot be read. Exact membership is **not** asserted (subfixture counting and add-vs-replace make an exact
count unreliable); `selected` lists the names read back. Without `clear_first` a warning repeats the
add-vs-replace caveat.

## gma3_set_attribute

Set one attribute to an absolute value.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `fixtures` / `use_selection` | exactly one | Target. |
| `replace_selection` | boolean, default false | With `fixtures`: send `ClearSelection` first so exactly those fixtures are targeted. Invalid with `use_selection`. |
| `attribute` | string, required | `Dimmer`, `Pan`, `Tilt`, `Zoom`, `ColorRGB_R`, `Gobo1`, ... |
| `value` | number, required | Absolute value in `unit`. |
| `unit` | optional enum | `percent` (0..100), `percent_fine` (0..100), `physical` (degrees/Hz/rpm, signed), `natural` (the attribute's natural readout, signed), `decimal8` (0..255 int), `decimal16` (0..65535 int), `decimal24` (0..16777215 int). Omitted: no value-type keyword; the console's current readout applies (a warning says so). |

Negative values are accepted only with `physical` or `natural`: for the other units a leading `-` could be
read as the Minus keyword, so they are refused.

Commands, in order:

1. `objects` ref `Attribute "<attribute>"` (read-only): the name must exist in the show's attribute
   definitions, otherwise `failed` and nothing is sent. This does **not** prove the target fixtures have it.
2. With `use_selection`: `objects` ref `Selection` (read-only): `CountTotalSelected` must be >= 1,
   otherwise `failed` ("nothing is selected"). With `fixtures`: `objects` ref `<fixtures>` must resolve.
3. With `fixtures` and `replace_selection`: `ClearSelection`.
4. With `fixtures`: `<fixtures>` (selects them; see add-vs-replace above; a warning is added when
   `replace_selection` is false).
5. `Attribute "<attribute>" At Absolute [<Unit keyword>] <value>` — e.g.
   `Attribute "Dimmer" At Absolute Percent 75`, `Attribute "Pan" At Absolute Physical -45.5`,
   `Attribute "Zoom" At Absolute 50` (no unit).

Changes the selection: **yes when `fixtures` is given** (the fixtures are selected and remain selected);
no with `use_selection`. Clears programmer values: never. Verification: `unavailable` (programmer values
are not readable). The console's feedback is the only check of the set command, and a fixture that
lacks the attribute is **not** detected: the console may answer `OK` and do nothing. Treat
`outcome: succeeded` + `verification: unavailable` as "the console accepted the command", not as "the
fixture now has that value".

## gma3_set_color

Set RGB colour, 0..100 % per component.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `fixtures` / `use_selection` / `replace_selection` | as above | Target. |
| `red`, `green`, `blue` | number 0..100, all required | Percent of `ColorRGB_R`, `ColorRGB_G`, `ColorRGB_B`. |

Commands: target steps as in `gma3_set_attribute` (2–4), then

5. `Attribute "ColorRGB_R" At Absolute Percent <red>`
6. `Attribute "ColorRGB_G" At Absolute Percent <green>`
7. `Attribute "ColorRGB_B" At Absolute Percent <blue>`

A rejected component stops the sequence: e.g. red accepted, green rejected → `partial`, blue `skipped`.
Selection / programmer impact as for `gma3_set_attribute`. Verification `unavailable`. Only the
documented `ColorRGB_*` attributes are supported (no colour wheels, no CMY, no `ColorAdd_*`). Fixtures
without RGB mixing are **not** pre-checked: if the console rejects the command the result is `failed`
or `partial` with the feedback in the step; if it silently accepts it, the result is `succeeded` with
`verification: unavailable` — never a verified success.

## gma3_set_position

Set Pan and/or Tilt with explicit units.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `fixtures` / `use_selection` / `replace_selection` | as above | Target. |
| `pan`, `tilt` | number, at least one | Values in `unit`. Degrees are limited to -720..720, percent to 0..100. |
| `unit` | `"degrees"` or `"percent"`, required | `degrees` → `Physical` keyword; `percent` → `Percent` keyword. |

Commands: target steps (2–4 above), then `Attribute "Pan" At Absolute Physical <pan>` (or `Percent`),
then `Attribute "Tilt" At Absolute Physical <tilt>`. Pan first; a rejected pan skips tilt. Selection /
programmer impact and verification as for `gma3_set_attribute`. Degrees are the fixture's physical range
as defined in its fixture type (e.g. Pan -225..225); values outside it are left to the console.

## gma3_clear_programmer

| `mode` | Command | Effect (manual) | Verification |
| --- | --- | --- | --- |
| `selection` | `ClearSelection` | deselects all fixtures; programmer values stay | `Selection.CountTotalSelected == 0` |
| `active` | `ClearActive` | deactivates all programmer values; selection and values stay | `unavailable` (values not readable) |
| `all` | `ClearAll` | clears the selection and discards every programmer value | `Selection.CountTotalSelected == 0` |

`mode` is mandatory; the tool never chooses for you and never sends plain `Clear`. One command per call.

## Live test

`test/live/fixtures.live.ts` (run with `GMA3_LIVE=1 npm run test:live` against a disposable show with
fixtures 1 Thru 5 patched, see `test/live/README.md`). It:

1. `ClearAll`, asserts `CountTotalSelected == 0`.
2. `gma3_select "1 Thru 5"` → asserts `succeeded`, `matched`, count 5.
3. `gma3_select "Fixture 1"` without `clear_first` → prints whether the console added (5) or replaced (1).
4. `gma3_set_attribute` Dimmer 50 % with `replace_selection: true` → `succeeded`, every `cmd` feedback `OK`,
   count still 5.
5. `gma3_set_color` 100/0/0 and `gma3_set_position` pan 10°, tilt 20° on `use_selection` → never
   `unknown`; prints the summary when the fixtures lack those attributes.
6. Asserts the selection is still 5 (no set tool clears it); repeats step 3 with active values present.
7. `gma3_clear_programmer mode: "all"` → `succeeded`, `matched`, count 0.

Objects touched: the current user profile's selection and programmer only. Nothing is stored or saved.
