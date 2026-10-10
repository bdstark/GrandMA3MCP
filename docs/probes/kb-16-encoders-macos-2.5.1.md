# KB-16 encoder context and executor semantics — macOS, onPC 2.5.1.0

Date: 2026-10-10. Evidence for [ENCODERS.md](../../ENCODERS.md) "KB-16 results". Script report:
[kb-16-encoders-macos-2.5.1.json](kb-16-encoders-macos-2.5.1.json) (`run`, 44/44 at the reviewed revision; the first run of the day, 47/47, used `Press Executor n` and a weaker precondition, see below). Every observation came through the
bridge's `lua` op (no production reader exists yet; KB-17 builds the feedback-module readers from this record) and its
`cmd`/`setfader` ops. `run` changed console state on the disposable show (selection, encoder bank/page, one programmer
attribute, five executor presses, three fader moves, the executor page) and restored each. It starts with a preflight
gate that refuses before any change unless the selection is empty, nothing is held through the bridge and the
programmer is provably empty through the bridge's `programmer` op (complete coverage of all 70 (sub)fixtures, 342
channels, no data); every undo is registered before the change it belongs to, on a page-qualified target with the
original value read first, and the cleanup runs all of them at the end even if one fails (`scripts/lib/kb16-steps.mjs`,
injected-failure tests in `test/kb16-steps.test.ts`). An executor that is already active or whose activity cannot be
read (only an explicit `active=true`/`active=false` from the reader counts; `ERR`, `nil`, a missing executor or no line are
unreadable) is refused before any dispatch with nothing registered for it, and the next candidate with the same key
function is tried (none was refused in this run: every target read inactive). The closing `ClearAll` was a no-op by
the gate.

| Item | Value |
| --- | --- |
| Host | macOS, onPC 2.5.1.0 Release, hostname `bdsmbpm401`, show `mcp-test-disposable`, user Admin, profile `Default`, one physical display |
| Bridge | gma3_mcp_bridge **0.12.0** with Lua enabled (`luahook=preserve`), hardkeys 0.10.0 and feedback 0.2.0 loaded (neither used) |
| Driver | `node scripts/kb16-probe.mjs run --out docs/probes/kb-16-encoders-macos-2.5.1.json` over one TCP connection |
| Fixtures used | 401 (Mega Hex Par: Dimmer, ColorRGB_R/G/B/W/RY/UV, Shutter1), 601 (180W Beam Moving Head: Dimmer, Pan, Tilt, Color1 wheel, Gobo1, …, no RGB) |
| Executors used | Page 1: 193 `LOS2 Odd` (Temp), 201 `StartShow 1` (Flash), 195 `LOS2 Chase` (Toggle), 191 `LOS2 All DelayA` (Top/Go+, Master fader), 210 `Rotate` (Temp fader); 178–189 are the KB-12 Quickey bank |

## Where the encoder context lives (read-only `verify`, steps 1–15)

| # | What | Observed |
| --- | --- | --- |
| 1 | UI objects | `GetDisplayByIndex(1).EncoderBarContainer.EncoderBarGrid` holds `EncoderBarBase.EncoderBarContainer.EncoderBankSelector` and an `EncoderBar` placeholder whose `PresetBar` child has `Options.PageSelector`, `Options.LinkBlock` and `EncodersArea.EncoderPlace1..5` |
| 2 | active bank | `EncoderBankSelector.SelectedItemValueI64` (0-based; `SelectedItemIdx` carries the same number one UI refresh later, so I64 is the value to read) |
| 3 | active page | `PresetBar.Options.PageSelector.SelectedItemValueI64` (0-based, same lag note) |
| 4 | context | `PresetBar.Context = "Default"` for attribute editing (other contexts were not entered; see "Not exercised") |
| 5 | selected feature / attribute | `SelectedFeature()` and `GetSelectedAttribute()` are handles: with the Dimmer bank `Dimmer#1` / `Dimmer#1`; `GetSelectedAttribute()` is the attribute of **slot 1** of the active page and its properties carry `Feature`, `PhysicalUnit`, `NaturalReadout`, `EncoderResolution`, `Special` (read with `Get(name, Enums.Roles.Display)`) |
| 6 | places | onPC renders four `EncoderPlace`s; each has two `UILayoutGrid`s (inner, outer ring) with a `BandFader` (`Text` = short label such as `Dim`, `R`, `Amber`; `Resolution` = `Coarse`; `Value`), a `ChannelFunctionSelector` and an `EncoderResolutionSelector` (hidden) `SwipeButtonList`, and a `PresetEncoderControl` (`EncoderType` `Inside1`/`Outside1`, `EncoderRing` `Both`). `EncoderPlace5` has no widgets on onPC |
| 7 | slot assignments | `CurrentProfile().EncoderBarPool` → `EncoderBar 1` → ten `EncoderBank`s (`Dimmer, Position, Gobo, Color, Beam, Focus, Control, Shapers, Video, Phaser`) → `EncoderPage`s → five `Encoder`s with `InnerObject`/`OuterObject` (`Attribute 107 'ColorRGB_R'`, read with `Get(..., Enums.Roles.Display)`; plain `.InnerObject` is nil). Color: page 1 `RGB` [ColorRGB_R, G, B, RY], page 2 `RGB` [ColorRGB_W, UV], page 3 `Color` [Color1, COLORMIXER]; Phaser slots carry `InnerObjectType=2` (Speed, Phase, Transition, Width, NShot), not attributes |
| 8 | live slots vs labels | the labels of places beyond the page's slot count keep the text of their last use (`T`, `B`, `Amber` under the one-slot Dimmer page). The live slot count is the pool page's non-empty slots; the label is the attribute's short name (`ColorRGB_RY` → `Amber`, `Color1` → `C1`, `COLORMIXER` → `ColorMix`), which the pool does not carry, so the reader takes labels from the UI and identities from the pool |
| 9 | resolution | `UserAttributePreferences` (415 entries on this profile) carries `DualEncoderFactor=Div5`, `DualEncoderPressFactor=Div25`, `TimeLayerResolution=Fine`, `PhaserLayerResolution=Coarse`, `LinkResolution=Single`; per attribute `NaturalReadout=<Percent>`, `EncoderResolution=<Coarse>`, `EncoderPressFactor=Mul5` (only `Dimmer` has an entry by name here; the others fall back to the attribute definition's `NaturalReadout`/`EncoderResolution`). Profile: `Layer=Absolute`, `ValueReadout=Natural`, `EncoderLinkValues=Single`, `WheelResolution=Normal`, `WheelMode=Additive` |
| 10 | attribute metadata | `Root().ShowData.LivePatch.AttributeDefinitions.Attributes[name]`: `GetAttributeIndex("Dimmer")=0`, `Feature`, `PhysicalUnit=LuminousIntensity`, `NaturalReadout=Percent`, `EncoderResolution=Coarse`, `Color` (RGBA floats), `Special=Dimmer`, `ChannelFunctions=9` |
| 11 | displays | display 2 (a handle exists on one monitor) has no `EncoderBankSelector`/`PresetBar`: the encoder bar is on display 1 only here; display 9 does not exist. One user context, not per display, is what this console shows; a second physical display was not available |
| 12 | executors | `CurrentExecPage()` children with an `Object` enumerate the assigned executors with `KeyPress`/`KeyUnpress`/`KeyUnpressCombined`/`Fader`/`Encoder`/`EncoderLeft`/`EncoderRight`, `IsXKey`, `Width`, `ExecutorConfiguration`, `Exec` (`Page 1.Executor 193 : Sequence 5529 'LOS2 Odd'`). Functions seen: keys `Temp`, `Flash`, `Toggle`, `Top`/`Go+`, `LearnSpeed`, `Go+`; faders `Master`, `Temp` |
| 13 | Quickey bank | executors 178–189 (`MCP CLEAR`, `MCP RESERVED`, class `Quickey`) appear like any other assignment; a playback reader must filter them by the bank record, never offer them as targets |
| 14 | appearance, activity | the assigned object's `Appearance` (`5010 'Orange'`) resolves to `BackRGBA=FF7F00FF` and `Color`; objects without an appearance read empty. `obj:HasActivePlayback()` is the activity flag |
| 15 | fader tokens | `obj:GetFader({token})` / `GetFaderText` answer for every token tried (`FaderMaster=100 (100%)`, `FaderX`, `FaderXA/B`, `FaderRate=50`, `FaderSpeed=50`, `FaderTemp`, `FaderTime`, `FaderCrossFade/A/B`), whatever the executor's configured fader function: the configured function comes from the executor, the levels from the object |
| — | empty executor | `GetExecutor(190)` is nil: empty is explicit, not a zero level. Reads changed nothing (bank, page, selection identical before and after) |

## What changes it (`run`, steps 16–47)

| # | Check | Observed |
| --- | --- | --- |
| 16–18 | `Fixture 401` | selection 1, bank and page unchanged; `GetUIChannels(SelectionFirst())` lists the eight attributes. Grouping fixtures (`MA StartShow n`) have no UI channels of their own; their subfixtures do |
| 19 | `Select EncoderBank 4` | bank I64 3, page I64 0 (page 1 `RGB`), labels `R G B Amber`; `SelectedFeature()=RGB#1`, parent `Color#4`, `GetSelectedAttribute()=ColorRGB_R#107` |
| 21–22 | `Select EncoderBank 4.2` / `4.1` | page I64 1 with `W UV`, `GetSelectedAttribute()=ColorRGB_W#119`; `.1` back to `ColorRGB_R#107` |
| 23 | `Attribute "ColorRGB_R" At 50` | `GetProgPhaser(uiChannel, false)` step 1 `absolute=50.0` (`absolute_value=8388608`, `mask_active_value=2`) |
| 24 | on-screen value | the place's `BandFader.Value` stayed `0.0`: it is the band's own state, not the programmer value. Readable value state = `GetProgPhaser` per UI channel |
| 25–29 | signed adjustments | `At + 10` → 60.000002, `At - 25` → 35.000002, `At + 1` → 36.000001 (one Coarse click at Percent readout, manual: 1 per click), `At + 1000` → 100 (clamped), `At - 1000` → 0 |
| 30 | `Encoder 1 At + 5` | "Nothing to be done": no encoder keyword; `Root().VirtualKeys` has no `ENCODER*` code among its 146, so key injection cannot turn an encoder either |
| 31 | bank ignored | with the Dimmer bank active, `Attribute "ColorRGB_R" At 20` still edits ColorRGB_R (19.999999): a named adjustment is selection-scoped; the slot's identity must come from the bank/page readers, not from the command |
| 32 | selection without the attribute | `Fixture 601`, `Select EncoderBank 4.1` answers OK but the page stays on page 3 `Color` (I64 2): the console offers only the pages whose attributes the selection has, and reopens a bank on such a page |
| 33 | silent no-op | `Attribute "ColorRGB_R" At 50` on fixture 601 answers OK and writes nothing (no UI channel): there is no refusal to detect; the reader must know the selection's channels |
| 34 | mixed selection | `Fixture 401 + 601`: page 1 `RGB` available again, labels `R G B Amber`, selection 2 |
| 35 | `ClearSelection` | selection 0, bank/page/labels remain |
| 36–37 | Temp, Flash | `Press Page 1.193` / `Press Page 1.201` → `HasActivePlayback()=true`, `Unpress Page 1.n` → false (release is the holder's responsibility: a 1.2 s hold stayed active until the Unpress) |
| 38 | Toggle (`Page 1.195`) | Press → true, Unpress → still true; `Off Sequence` → false |
| 39 | Top / Go+ (`Page 1.191`) | Press (Top) → active; Unpress (Go+) → inactive on this sequence (it ran past its last cue); `Off` → false. The after-state depends on the cue list, not on the key function |
| 41 | Master fader | original 100 read first; `setfader Page 1.191 25` → `GetFader{FaderMaster}=25`; restored to 100 and read back |
| — | `FaderRate Page 1.191 At 75` | OK, read back `FaderRate=50` before and after: the rate master of this sequence did not follow (the executor's fader is Master; function-specific setters need their own qualification, not assumed from the Master path) |
| 42 | Temp fader | original 0 read first; `FaderTemp Page 1.210 At 60` → `FaderTemp=59.999996 (60%)` **and the sequence becomes active**; `At 0` → inactive. A Temp fader above zero is a playback start |
| 43 | page navigation | the original page (1, read before any change) is the one restored, by the normal path and by the registered undo; the other page (2) is taken from the data pool's existing pages, nothing is created. `Page 2` then `Page 1`: `CurrentExecPage()` follows and the Temp/Toggle sequences stayed inactive throughout |
| 44 | cleanup | the three undos the normal path had not consumed ran newest first, each OK: `Off Attribute "ColorRGB_R"`, `Select EncoderBank 1.1`, `ClearSelection`; then `ClearAll`; final bank 0, page 0, selection 0 |

## Observations worth keeping

- The console's encoder context is three things read from three places: which bank/page (UI selectors), what each
  slot is (profile pool page), what the value is (programmer per UI channel). None of them is a single object.
- `SelectedItemIdx` of the selectors lags the command by a UI refresh; `SelectedItemValueI64` is current at the next
  Lua read.
- Pages follow the selection: a bank reopens on a page the selection supports, `.n` to an unsupported page is
  accepted and ignored, and an `At` on an attribute the selection lacks is accepted and ignored. A reader has to
  compare the pool page's attributes with the selection's UI channels to say whether a slot is live.
- The on-screen band `Value` is not the programmer value; `GetProgPhaser(ui, false)` is (`absolute`, `absolute_value`,
  masks, `channel_function`).
- Executor press/release through `Press`/`Unpress Page <p>.<e>` runs the configured `KeyPress`/`KeyUnpress`
  function (Temp, Flash, Toggle, Top/Go+ confirmed); what the sequence does afterwards is the sequence's business.
- A Temp fader starts playback when raised; `FaderRate` on a Master-fader executor did not change the readable rate.

## Not exercised

- Editor contexts (preset bar `Context` other than `Default`), timing and phaser layers, the outer ring, encoder
  press (calculator), `Fine`/`Increment`/`Native` resolutions, non-Percent readouts.
- Changes made by hand in onPC (bank buttons, page swipe, Readout/Align): `node scripts/kb16-probe.mjs watch` prints
  the context twice a second for the operator; not run in this record.
- A second physical display, Windows, other users/profiles, physical encoder hardware of any kind.
- `FaderRate`/`FaderSpeed`/`FaderX` as configured fader functions (none on this page), executor encoders
  (`Encoder=Master`), `LearnSpeed` keys, the Quickey bank's executors as targets (excluded by rule).
