# Encoders, parameter strips, and playback surfaces

## Intended behavior

The NX-K’s four rotary encoders and M-Touch’s four parameter strips control the same four grandMA3 encoder slots. Changing the active feature, encoder page, or supported editor updates both surfaces.

For example, a Color page might expose Red, Green, Blue, and Amber, followed by White and UV on another page. Position might expose Pan and Tilt. These are examples: actual assignments, order, availability, and units come from the console.

M-Touch’s remaining strips and M-Play’s playback controls operate assigned grandMA3 executors. Banks let the operator access additional controls without rewriting the show’s executor assignments.

M-Play defaults to playback duties. An optional profile may dedicate selected M-Play strips to parameter control; this is explicit and visibly indicated.

## Shared architectural requirements

- Keep grandMA3 interpretation, validation, control operations, and feedback in reusable Lua modules in the MCP repository.
- Keep USB decoding, hardware profiles, surface configuration, and LED rendering in the surface repository.
- Extend the feedback module for read-only state. Add continuous-control operations through a defined shared input interface; do not force encoder motion through hardkey or Quickey presses.
- Preserve existing MCP APIs. New MCP tools are optional consumers of the shared interface, not prerequisites for surface support.
- Continue the existing cooperative plugin loop, bounded work, authentication, ownership, and recovery model. No new OSC dependency.
- Provisioned Quickey-bank executors must never appear as ordinary playback targets.
- Do not create or alter playback assignments, fixture definitions, or encoder layouts automatically.
- Qualify capabilities independently: an API accepting a call is not proof of the intended console effect.

## KB-16 — Qualify existing hardware protocols and probe grandMA3 control semantics

**Request:** Reuse the documented NX-K, M-Touch, and M-Play protocols, and establish how Lua can operate grandMA3’s active encoder context and assigned executors.

**Depends on:** Existing surface transport and feedback infrastructure. Can proceed alongside KB-13–KB-15.

**Lua changes: Yes — console probe scripts.** No production dispatch changes initially. Hardware integration and protocol regression tests belong in the surface repository; TypeScript changes should not be needed.

### Existing hardware evidence

M-Touch and M-Play protocols are documented in bdstark/MTouchPlay:
- docs/protocol.md: M-Touch USB transport, control addresses, input reports, LED colors, fader bars, and bank displays. Marked phase-one complete and confirmed against hardware.
- docs/mplay-notes.md: M-Play identification, physical layout, control mapping, and bank differences. Hardware-confirmed; shares the underlying M-Touch protocol.
- docs/capture-playbook.md: Capture procedures for investigating remaining questions or device differences.
These documents and their referenced captures are the starting evidence. Do not repeat completed protocol reverse engineering. Hardware protocol qualification does not establish grandMA3 integration behavior.

### Acceptance criteria

- Record the MTouchPlay revision used and link the applicable documentation and captures from the surface repository.
- Reuse documented transport, input formats, control addresses, LED encodings, and bank-display behavior. Preserve device-specific differences.
- Add decoder and output-encoding regressions using representative documented reports and captures.
- Verify the integrated service on each device, including direction, resolution, touch/release, pressure, idle behavior, reconnect reports, and LED output.
- Investigate only undocumented behavior, firmware differences, or discrepancies found during integration.
- Determine whether Lua can read the active encoder bank/page, ordered slot assignments, selected layer, resolution, units, and available channel functions.
- Probe how to apply a signed adjustment to the current encoder slot while preserving console semantics.
- Distinguish attribute editing from other encoder contexts, such as editors, timing, and phasers. Record unsupported contexts.
- Verify executor assignment identity, configured button/fader functions, readable levels, activity, labels, and appearance colors.
- Probe executor button down/up, including momentary actions, and each initially supported fader function.
- Test selection changes, mixed fixture types, empty selection, multiple displays, and changes made directly in onPC.
- Publish successful calls and limitations by console version, platform, device, and firmware, distinguishing reused protocol evidence from new integration results.
Completion gate: No production operation may claim native encoder or executor equivalence without evidence. Direct attribute writes may be offered only as an explicitly limited mode if they cannot reproduce native behavior.

### KB-16 results (console half, 2026-10-10; surface half in mtpnxk)

Live on macOS, onPC 2.5.1.0, bridge 0.12.0 with Lua: [record](docs/probes/kb-16-encoders-macos-2.5.1.md),
[script report](docs/probes/kb-16-encoders-macos-2.5.1.json) (`scripts/kb16-probe.mjs run`, 44/44; the run refuses to start unless the programmer is provably empty through the `programmer` op and registers every undo before the change it belongs to). No production
dispatch or reader changed; the probe reads through the `lua` op. The hardware half (M-Touch/M-Play decoders, output
encoders, regression tests from the MTouchPlay captures at revision `e48eb2c`, the `mtouch-listen`/`mtouch-led-test`
operator commands and the live-qualification procedure) is in mtpnxk `docs/mtouch-protocol-reuse.md`, and both devices were qualified live on
macOS the same day (`docs/probes/kb-16-hardware-mtouch-macos.md`, `docs/probes/kb-16-hardware-mplay-macos.md`:
every documented control and report type, LED/bar/display output confirmed by eye, 8 ms idle polls, queued
reports delivered at open, clean unplug detection and replug). Windows/Linux hosts remain unqualified.

**Readable (and from where):**

- Active bank and page: `GetDisplayByIndex(1).EncoderBarContainer.EncoderBarGrid` → `EncoderBankSelector.SelectedItemValueI64`
  and the `PresetBar`'s `Options.PageSelector.SelectedItemValueI64` (0-based; `SelectedItemIdx` lags one UI refresh).
  `PresetBar.Context` = `Default` for attribute editing. Display 1 only on this onPC (display 2 has no encoder bar).
- Ordered slot assignments: `CurrentProfile().EncoderBarPool` → bar → bank → page → `Encoder n` with `InnerObject`/`OuterObject`
  read as `Get("InnerObject", Enums.Roles.Display)`; Phaser slots are `InnerObjectType=2` (not attributes).
- Labels, resolution per slot: each `EncoderPlace`'s inner `BandFader` (`Text` = short name such as `Amber`, `Resolution`);
  places beyond the page's slot count keep stale labels, so the live slot count is the pool page's.
- Selected feature/attribute: `SelectedFeature()` (the page's feature, parent = feature group) and `GetSelectedAttribute()`
  (slot 1's attribute) with `Feature`, `PhysicalUnit`, `NaturalReadout`, `EncoderResolution`, `Special`; units, readout,
  resolution, colour and channel-function count from `AttributeDefinitions.Attributes[name]`; user overrides from
  `UserAttributePreferences` (`DualEncoderFactor`, per-attribute `NaturalReadout`/`EncoderResolution`/`EncoderPressFactor`).
- Value state: `GetProgPhaser(uiChannel, false)` per selected (sub)fixture (`absolute`, `absolute_value`, masks). The band's
  on-screen `Value` is not the programmer value. Channel functions: `ChannelFunctionSelector` per place (text/index).
- Executors: `CurrentExecPage()` children with `Object`; `KeyPress`/`KeyUnpress`/`KeyUnpressCombined`, `Fader`, `Encoder`,
  `EncoderLeft/Right`, `Exec`, `ExecutorConfiguration`; appearance via the object's `Appearance` → `BackRGBA`; activity via
  `obj:HasActivePlayback()`; levels via `obj:GetFader({token})` for every token regardless of the configured function.
  `GetExecutor(n)` is nil for an empty executor. The KB-12 bank executors (`MCP …`, class Quickey) are listed like any other.

**Operations that reproduce console semantics:**

- `Select EncoderBank <n>` / `<n>.<page>` switches bank and page; a bank reopens on a page the current selection supports,
  and `.page` to a page whose attributes the selection lacks is accepted and ignored.
- `Attribute "<name>" At <v>` and `At + <d>` / `At - <d>` set and adjust the programmer for the selection in the attribute's
  readout (Percent here); one Coarse click = `+ 1` at Percent readout (manual); clamped at the range ends. The command is
  selection-scoped and ignores the active bank, and on a selection without the attribute it answers OK and does nothing,
  so the slot identity and the availability check are the reader's job, not the command's.
- `Press Page <p>.<e>` / `Unpress Page <p>.<e>` run the executor's configured press/release functions (Temp and Flash active
  while held, Toggle latches, Top on press then Go+ on release); the state after the release is the sequence's.
- `setfader` / `FaderMaster … At` for Master faders; `FaderTemp … At` for Temp faders (raising it starts the playback).
  `FaderRate … At` on a Master-fader executor did not change the readable rate: function-specific setters are qualified one
  by one, not inferred.
- `Page n` changes the executor page without starting or stopping playbacks.

**Limitations and unsupported contexts:**

- No encoder keyword and no `ENCODER*` virtual key: an encoder turn can only be reproduced as a selection-scoped attribute
  adjustment on the slot's attribute, with the step derived from readout and resolution. That is the "explicitly limited
  mode" the completion gate allows, never native equivalence; outer ring, encoder press, Fine/Increment/Native resolutions,
  non-Percent readouts, timing and phaser layers and every non-`Default` preset-bar context remain unverified.
- Mixed selections: the console keeps a page available when any selected fixture has its attributes; a per-fixture
  availability read needs the selection's UI channels (grouping fixtures expose channels on their subfixtures only).
- Not run: hand changes in onPC (`kb16-probe.mjs watch` exists for the operator), a second physical display, Windows,
  other users/profiles, executor encoders, `LearnSpeed`, `FaderX`/`FaderSpeed` as configured functions.

## KB-17 — Shared control-context and binding snapshots

**Request:** Expose an authoritative description of what each surface control would operate.

**Depends on:** KB-16 reader probes.

**Lua changes: Yes — feedback module and shared binding interface.** No surface-side reconstruction of grandMA3 semantics. Existing MCP tools remain unchanged.

### Acceptance criteria

- Publish a bounded snapshot containing:
  - Show, data pool, user/profile, and relevant display/context identity.
  - Active encoder bank/page and ordered slot assignments.
  - Attribute identifiers, labels, units, layer, resolution, availability, and readable value state.
  - Explicit executor targets, assigned-object identity, functions, level/state, and appearance metadata.
- Represent unavailable, stale, mixed-selection, and unsupported values explicitly.
- Include a context generation that changes whenever an input’s meaning changes.
- Define which encoder bar/context is authoritative when multiple windows or displays exist. Do not choose arbitrarily.
- Follow console changes without requiring a surface keypress.
- Keep all readers usable with input disabled.
- Test snapshot consistency, missing properties, deleted assignments, and context changes during polling.

### KB-17 results (console half, 2026-10-10; surface half in mtpnxk)

`gma3_mcp_feedback` 0.3.0 and bridge 0.13.0 ([modules](docs/modules.md#control-context-and-binding-snapshots-gma3_mcp_feedback-030-kb-17),
[reference](docs/reference.md#control-context-plugin-v0130-kb-17)); live on macOS, onPC 2.5.1.0:
[record](docs/probes/kb-17-context-macos-2.5.1.md), [script report](docs/probes/kb-17-context-macos-2.5.1.json)
(`scripts/kb17-probe.mjs run`, 31/31). Existing MCP tools and ops are unchanged.

- **Snapshot** (`feedback.context` / `contextSnapshot()`): identity (show, data pool, user, profile) and the
  authoritative display; bank/page/context of that display's encoder bar; the ordered pool slots with attribute
  identity, label, unit, readout, resolution (user preference over definition over band), layer, availability
  (`no-selection | available | unavailable | mixed`) and programmer value state (`none | value | empty | mixed |
  unavailable`); one target per executor with assigned-object identity, key/fader/encoder functions, the configured
  fader function's level, activity, appearance colour and `playbackTarget` (Quickey objects and the bridge's reserved
  bank executors never are). Every unavailable, stale, mixed or unsupported part is an explicit field with a reason.
- **Generation:** moves on identity, epoch, bank/page/context, the selection's fixtures (all of them, walked apart from
  the bounded attribute scan; no generation is claimed while that identity is incomplete), slot object/resolution/
  readout/channel function/layer/availability, executor page, assignment, every configured function and target status,
  or on any of these becoming unreadable;
  stays on values, levels, activity and labels (verified live: selection, bank, page and executor page moved it,
  `Attribute … At` did not).
- **Authoritative display:** configured (`config.encoderDisplay`, 1) or requested per call; a display without an
  encoder bar is unavailable and never replaced (display 2 and 9 live).
- **Following the console:** `feedback.watch` + `feedback.context {cached=true}` serve the snapshot from the plugin
  loop's bounded reads (8 per iteration by default); no generation is claimed while any part is unobserved. All of it
  is usable with Lua and input disabled and is never `[busy]`.
- **Harness:** `test/lua/feedback_context_test.lua` (85 checks: missing properties, deleted assignments, mixed and
  empty selections, bounded scans, phaser/empty slots, every generation rule, context changes during polling) and the
  bridge harness block (16 checks).

**Limitations:** values are the programmer's (`GetProgPhaser`), not output; the selection scan is bounded
(`maxSelectionScan` 8 fixtures, `maxUIChannels` 64) and says `partial`; non-`Default` preset-bar contexts, phaser slots and
the outer ring are reported but unsupported; a second physical display, Windows, a data-pool switch and a provisioned bank
were not exercised live (harness only). The encoder bar's bank/page selectors are per display and only display 1 carries
them on this onPC; if a console shows an encoder bar on several displays, the consumer configures which one it follows.

## KB-18 — Continuous-control transport and admission

**Request:** Carry encoder motion and strip gestures without stale input affecting a new target.

**Depends on:** KB-17.

**Lua changes: Yes — shared input admission and surface plugin.** Rust/service and protocol changes required. No MCP/TypeScript changes required initially.

### Acceptance criteria

- Define distinct events for relative motion, absolute position, touch begin/end, and button down/up.
- Each event identifies its device, control, session, event sequence, binding generation, and gesture where applicable.
- Reject events for an expired session or obsolete binding. Never reinterpret queued movement against a newly selected attribute or executor.
- Preserve existing duplicate suppression and no-replay rules.
- Coalesce relative deltas only within the same target, context, resolution, and gesture. Never coalesce across a button or context-change boundary.
- For absolute updates, newer values may supersede older ones only where the function permits it. Do not skip meaningful endpoint transitions for crossfade or other stateful controls.
- Specify packet-loss behavior for relative motion: either accept and report loss or implement deduplicated acknowledgment; never replay uncertain deltas blindly.
- Bound queue length, event age, per-device rate, and work per service iteration.
- Keep button releases and recovery responsive during continuous-input floods.
- Serialize conflicting edits from multiple surfaces or MCP operations; do not let simultaneous writers silently fight over one target.
- Test loss, duplicates, reordering, bursts, reconnects, stale generations, and context changes.

### KB-18 results (console half, 2026-10-10; surface half in mtpnxk)

`gma3_mcp_control` 0.1.0 and bridge 0.14.0 ([modules](docs/modules.md#continuous-control-admission-gma3_mcp_control-010-kb-18),
[reference](docs/reference.md#continuous-control-plugin-v0140-kb-18)); live on macOS, onPC 2.5.1.0:
[record](docs/probes/kb-18-control-macos-2.5.1.md), [script report](docs/probes/kb-18-control-macos-2.5.1.json)
(`scripts/kb18-probe.mjs run`, 30/30). Existing MCP tools and ops are unchanged; no TypeScript changed.

- **Events:** `relative` (delta in detents), `absolute` (0..1), `touch` and `button` (down/up), each with device,
  control, per-device sequence, the feedback module's binding generation, a gesture id (motion, touches) and a target
  (`{slot}` or `{executor, element}`); a surface's intent is resolved against the binding, never against attribute names.
- **Admission (`submit`):** expired/unknown sessions, malformed events, duplicates (`duplicate`), older unseen
  sequence numbers (`out-of-order`, never applied late; a delayed release newer than its own press is admitted late
  and ends only that hold) and gaps (accepted, `lost` reported: loss is reported, never replayed) are decided per
  device before the binding; motion needs the binding's current generation and revision (`stale-generation` and
  `stale-binding` carry the current ones, `binding-unknown` while none is claimed or the snapshot is stale) and a
  resolvable target with the binding's reason otherwise; a touch held under another generation or binding is
  `gesture-rebound` until released; queued motion is re-checked at apply time and dropped when the generation,
  revision or freshness moved.
- **Coalescing:** relative deltas merge only within one session, device, control, target, generation, resolution,
  fine flag and gesture, and never across a touch/button or generation boundary; absolute positions supersede a queued
  one only for stateless functions (attribute slots, `Master`, `Rate`, ...); `X`/`XA`/`XB`/crossfade/`Temp` keep every
  position in order, so endpoint transitions are never skipped.
- **Bounds:** queue 64 per session (motion refused `queue-full`; a release evicts the oldest motion and has reserved
  capacity, and when even that is used it is refused with the hold kept owned for its retransmission), event age 250 ms at apply time (`expired`), 400 motion events/s per device (`rate`, dropped not deferred;
  releases are never rate-refused or expired), 4 intents applied per loop iteration, 30 s gesture ceiling, 16 holds.
- **Serialisation:** a touched/pressed target belongs to its session (motion keeps it 500 ms); another session gets
  `conflict`; the bridge's `[busy]` guard refuses `cmd`/`set`/`setfader`/`lua` from every connection while a surface
  gesture is active (`detail.module = "control"`), and motion is refused `busy` while the hardkeys instance reports
  another owner. A disconnect, lease expiry, `control=off` or stop ends gestures through the backend, drops queued
  motion and keeps a release the backend raised on for `control recover` (adopted across restarts).
- **Bridge:** `control=fake|off`, `control status`, `control recover` arguments (Macros 118/119 on the test show);
  `control.bind/open/renew/close/submit/status/recover` ops (32 events per request), binding = the bridge's feedback
  instance cached for the bound spec.
- **Harness:** `test/lua/control_admission_test.lua` (139 checks, including the PR review's late releases (beyond the
  sequence window too), release capacity, recovery batches, rebound holds, stale and replaced bindings, releases kept
  across a rebind, the required binding revision: loss, duplicates, reordering, bursts, reconnect/
  expiry/close/dispose, stale generations and rebound touches, context changes while queued, every bound, conflicts,
  backend faults, recover/adopt) and the bridge harness block (44 checks); `test/kb18-probe.test.ts` (5).

**Limitations:** KB-18 ships the fake backend only (intents are admitted, ordered, coalesced, bounded and recorded;
nothing moves on the console; KB-19 adds the adjustment backend and calibration); generations are those of one
feedback instance and spec (a surface bound elsewhere is refused as stale); packet loss is reported, not repaired;
stateful fader functions, rate limiting, eviction, the gesture ceiling, a loop-dropped delta and a raising backend
were exercised in the harness only; surface-side transport (event ids, retransmission policy, per-device queues in
the service) is the mtpnxk half.

## KB-19 — NX-K encoders follow the active encoder context

**Request:** Turn an NX-K encoder to adjust the corresponding current grandMA3 encoder slot.

**Depends on:** KB-16–KB-18.

**Lua changes: Yes — shared continuous-control implementation and surface integration.** No new MCP tools required.

### Acceptance criteria

- Map the four physical encoders to four reported slots, not hard-coded attribute names.
- Respect qualified console resolution, value layer, readout, channel function, and link behavior.
- Calibrate one physical detent against the console. Avoid applying both device acceleration and service acceleration unintentionally.
- Support an explicit fine-adjustment gesture where qualified.
- Treat encoder presses separately from rotation. Enable calculator/open/select behavior only when independently verified.
- Make unavailable slots inactive and report why.
- Support access to additional slots or dual-encoder functions through an explicit, documented mode. Do not silently discard a fifth slot or outer-ring function.
- Stop queued motion when the selection, feature, page, layer, or editor changes. A subsequent fresh gesture uses the new binding.
- Test Pan/Tilt, multiple color pages, non-color attributes, mixed fixtures, empty selection, and unsupported editors.
- Verify that adjustment preserves the intended relationship between selected fixtures rather than flattening them to one value.

### KB-19 results (console half, 2026-10-10; surface half in mtpnxk)

`gma3_mcp_control` 0.2.0 (the console backend), `gma3_mcp_feedback` 0.4.0 (physical ranges per slot) and bridge 0.15.0
(`control=console`) ([modules](docs/modules.md#console-adjustment-backend-gma3_mcp_control-020-kb-19),
[reference](docs/reference.md#continuous-control-plugin-v0140-kb-18)); live on macOS, onPC 2.5.1.0:
[record](docs/probes/kb-19-adjust-macos-2.5.1.md), [script report](docs/probes/kb-19-adjust-macos-2.5.1.json)
(`scripts/kb19-probe.mjs run`, 39/39). Existing MCP tools and ops are unchanged; no TypeScript changed.

- **Slots, not names:** a relative event names `{ slot = n }`; the backend applies `Attribute "<name>" At +/- <amount>`
  with the name, layer, resolution, readout, channel function and physical range of that slot in the binding
  (feedback snapshot). Live: slot 2 of the colour bank was `ColorRGB_G`, slot 1 of its page 2 `ColorRGB_W`, slot 1 of
  the position bank `Pan`; the command named each one.
- **Calibration (one detent = one console click):** the manual's rule (24 clicks per turn, 5 turns per range): Percent
  and PercentFine readouts 1 per Coarse click (KB-16 measured), Physical readout `(PhysicalTo - PhysicalFrom) / 120`
  in physical units (KB-19 measured `At 10` = 10 degrees of Pan; the range comes from `GetUIChannel(ui).logical_channel`'s
  channel function that names the attribute, the smallest over the selection, now in every slot as `physicalRange`),
  Fine a tenth. No acceleration is applied in the module or the bridge: n detents are n steps; the surface documents
  its own. Live: Dimmer `At + 1`, Pan `At + 15` for four detents (450 / 120 each), Tilt `At + 5.25` for three (210 / 120),
  Gobo1 `At + 0.25` for two (15 / 120).
- **Fine gesture:** `fine = true` (Bank held on the NX-K) divides the step by 10 (the manual's Coarse-to-Fine ratio):
  two fine detents were `At + 0.2` on Dimmer and `At - 0.75` on Pan. It is an explicitly smaller adjustment, not the
  console's resolution toggle.
- **Qualified only:** readouts other than Percent/PercentFine/Physical, resolutions other than Coarse/Fine, layers
  other than Absolute, a channel-function selector naming a function other than the attribute's own, phaser/editor
  slots and an unreadable range are refused `unsupported` with the reason at admission, before any gesture or queue
  entry exists (`adapter.supports()`), so nothing is owned or applied for them. Review (PR #23): a slot is served only
  while the encoder bar is in attribute editing (`attributeEditing == true`, preset-bar context `Default`); an editor,
  phaser or unreadable context refuses every slot event in target resolution, whatever the slot record says.
- **Calibration coverage (review):** a physical range is reported only when it is complete and verified: every
  scanned fixture with the channel contributed the range of the channel function that names the attribute (no
  fallback to another function), the bounded scan covered the whole selection and every scanned fixture's channels
  were enumerated and mapped (review rounds 2 and 3: a raising `GetUIChannels` or subfixture discovery, and an
  enumerated channel that cannot be mapped to a readable attribute name, whether `GetAttributeByUIChannel` raises,
  returns nil or the name is unreadable, mark the scan partial and the slot `discoveryIncomplete`; that fixture is not a confirmed "lacks the
  attribute"); otherwise `physicalUnavailable` carries the reason and the Physical readout is refused. The range, its
  availability and the discovery state are part of the binding digest, so a range or coverage change moves the
  generation and queued motion calibrated against the old range is dropped.
- **Presses separate from rotation:** a `button` event is refused `unsupported` on the console backend (calculator /
  open / select behaviour is not qualified; nothing is pressed); touches, positions and executor elements likewise
  (KB-20/21/22). The target still resolves first: a press on a slot with nothing selected is `target-unavailable`.
- **Unavailable slots:** `target-unavailable` with the binding's reason (no selection, unavailable for the selection,
  empty slot); a `mixed` slot (some fixtures lack the attribute) is admitted and reported `mixed`: the console applies
  the adjustment to the fixtures that have it and leaves the others untouched (live: 401's `ColorRGB_R` 30 -> 35, 601
  no channel).
- **Additional slots / dual-encoder functions:** a fifth pool slot and the outer ring are reported by the feedback
  module and refused here; the surface's explicit slot-window mode (mtpnxk `--rotary-slots`) is how a 4-encoder surface
  reaches slot 5; nothing is discarded silently.
- **Context changes:** queued motion is dropped by the loop when the generation moves (KB-18); live, motion keeps the
  bridge `[busy]` so the page change waited for the gesture to lapse, after which the old-generation event was
  `stale-generation` and a fresh gesture used the new binding.
- **Relationship preserved:** `At +` is relative per fixture: 401 at 20 and 402 at 50 became 25 and 55 after five
  detents on the shared Dimmer slot; the same six detents moved two fixture types by 6.
- **Bridge:** `control=console` (Macro 120 on the test show) next to `control=fake|off`; switching backends ends the
  gestures through the previous one; `control.status` carries the backend's capabilities, calibration, counters and
  last command; `lastApplied.result` carries the command issued.
- **Harness:** `test/lua/control_admission_test.lua` (165 checks; 25 new, including the review's context refusals and the
  range-change drop: calibration per readout/resolution/layer/
  channel function/range, admission refusals for presses, touches, positions, executor elements and unqualified slots,
  the command text, coalesced and negative deltas, fine, Physical steps, feedback verdicts, a raising `Cmd`, a hold
  ended as a noop, backend switching, amount formatting), `test/lua/feedback_context_test.lua` (116; physical ranges:
  smallest over the selection, mixed ranges, the function that names the attribute, a raising `GetUIChannel`, a function
  that does not name the attribute, a bounded scan, channel-discovery failures and a range change each refusing or moving the generation), the bridge harness block (`control=console`, the commands through
  `Cmd()`, status, switching) and `test/kb19-probe.test.ts` (4).

**Limitations:** the adjustment is the explicitly limited mode KB-16 allowed (a selection-scoped relative `At`), not native
encoder equivalence: the console's own encoder modifiers (press factor, dual-encoder factor, link resolution) are read
but not reproduced; editor contexts, Increment/Native, non-Absolute layers, Dec8/Dec16/Hex readouts and multi-function
selection are refused, not served; a relative step from an empty programmer starts at the output value (a colour
component's default is 100 on the test fixture, so it clamps at once); mixed physical ranges on one slot, Fine as the
configured resolution, editor contexts (refused since the PR review) and partial range coverage were exercised in the harness only; the NX-K hardware and the surface's
`--rotary-slots` mode are the mtpnxk half.

## KB-20 — M-Touch parameter strips act as encoders

**Request:** Use the four right-hand M-Touch strips for the same parameter assignments as the NX-K encoders.

**Depends on:** KB-19 and the M-Touch hardware qualification in KB-16.

**Lua changes: Yes — reuse the shared adjustment operations; extend only for separately qualified absolute-setting semantics.** Gesture conversion belongs in the surface service. No TypeScript changes required.

### Acceptance criteria

- Default to **relative touch-drag adjustment**: touching a strip establishes an anchor; movement changes the value without jumping to the touched position.
- Lifting and retouching re-anchors the gesture, allowing repeated travel across a large range.
- Map direction, sensitivity, and fine mode consistently with the rotary controls.
- Ignore pressure as a value input unless explicitly configured and qualified.
- On binding changes while touched, stop the old gesture and require release/re-touch before controlling the new parameter.
- Offer absolute mode only for attributes/layers with a verified range and meaningful absolute semantics.
- Absolute mode requires pickup or another explicit takeover policy; reconnects, page changes, and touch-down must not cause unexpected jumps.
- Mixed-selection values remain mixed unless the operator deliberately chooses an absolute operation.
- Optional M-Play parameter strips reuse this behavior and clearly indicate their changed role.
- Test touch jitter, endpoint travel, repeated gestures, missed touch-up, reconnect, and external console edits.

### KB-20 results (console half, 2026-10-10; surface half in mtpnxk)

`gma3_mcp_control` 0.3.0 and bridge 0.16.0 ([modules](docs/modules.md#parameter-strips-on-the-console-backend-gma3_mcp_control-030-kb-20),
[reference](docs/reference.md#continuous-control-plugin-v0140-kb-18)); the live record is
[kb-20-strips-macos-2.5.1.md](docs/probes/kb-20-strips-macos-2.5.1.md) with the
[script report](docs/probes/kb-20-strips-macos-2.5.1.json) (`node scripts/kb20-probe.mjs run`, **28/28** on 2026-10-10). The feedback module is
unchanged (0.4.0); no TypeScript changed. The gesture conversion (anchor on touch, re-anchor on retouch, sensitivity,
fine, pressure ignored, pickup/takeover) is the surface service's half (mtpnxk `KEYBOARD.md` "KB-20"); what the console
half serves:

- **Relative touch-drag is the default:** a strip's drag travels as the KB-19 relative adjustment inside a served
  **touch**: the touch is a hold (the bridge is `[busy]` with it, the slot is the session's, another session's motion on
  it is `conflict`), applied as a noop (nothing is issued, the value does not move), and the lift is a noop boundary.
- **Lifting and retouching re-anchors:** a new gesture on the same slot after the release is served against the
  current binding; the anchor itself is the surface's.
- **Direction, sensitivity, fine:** the same calibration as the rotaries (one detent = one console click, `fine` a
  tenth); nothing is added here.
- **Binding changes while touched:** motion inside a touch after the generation moved is refused `gesture-rebound`
  until the release and a new touch (the KB-18 rule, which a served touch now engages on the console backend).
- **Absolute mode only with a verified range:** `Attribute "<name>" At <value>` for the Percent/PercentFine readouts
  (0..100) and the Physical readout (`physicalFrom..physicalTo` in physical units, `At -180` for 0.1 of Pan -225..225);
  a mixed physical range, a missing range, other readouts, layers and channel functions are refused `unsupported`.
  The newest queued position supersedes; a stale one is dropped, never placed late.
- **Mixed values stay mixed:** a position on a slot whose fixtures hold different values is refused `mixed-values`
  (for every backend) unless the event carries `takeover = true`; relative motion keeps the relationship. The resolved
  slot forwards the binding's `valueState` and last read `absolute` as a pickup hint (values are not in the digest).
- **Pressure:** no event type carries it; nothing to ignore here (the surface drops the M-Touch pressure keys).
- **Live (28/28):** the touch hold made the bridge `[busy]` (reason `touch-down`) and refused a console command; the
  drag inside it read 40 -> 42, the re-touch 42 -> 37; `At 25`, the ends 100 and 0; a two-fixture selection at 20/50
  reported `valueState mixed`, the position was refused `mixed-values`, five detents kept 25/55, `takeover` placed
  60/60; Pan (-225..225) placed `At 0` (50 percent) and `At -180` (10 percent); the empty selection and a press refused.
- **Bridge:** `control=console` serves the three kinds on slots; `control.status` capabilities say
  `{ relative, absolute, touch = true, button = false }`; `lastApplied.result` carries the placement (`value, amount,
  from, to, readout, takeover`).
- **Harness:** `test/lua/control_admission_test.lua` (189 checks; 24 new: `position()` per readout and its refusals,
  capabilities, executor refusals kept, the touch hold (busy, ownership, noop, conflict), the drag inside it, rebound
  after a binding change and the release/re-touch recovery, positions at Percent and Physical, supersession, a stale
  position dropped, the mixed-values refusal and takeover, bad `takeover`, the fake backend), the bridge harness (487,
  version only) and `test/kb20-probe.test.ts` (4).

**Limitations:** the console half places and adjusts; it does not know where the finger is. Missed touch-ups are bounded
by the module's `maxGestureMs` (30 s force-end) and by the surface's own release on disconnect; a binding change cannot
be driven through the bridge while a strip is touched (the hold keeps it `[busy]`), so the rebound rule is harness
evidence live, as in KB-18. Absolute positions are an explicitly limited mode (the selection-scoped `At <value>`), not
native fader equivalence; whether a fixture's value is "current" is the binding's last read.

## KB-21 — Playback banks and stable executor bindings

**Request:** Select which live-show executors each playback section controls.

**Depends on:** KB-17 and KB-18.

**Lua changes: Yes — shared target resolution and surface integration.** Device bank navigation and profile configuration belong in the service. No MCP/TypeScript changes required initially.

### Acceptance criteria

- Represent each target explicitly by data pool, page, executor, and control element.
- Distinguish an **executor page** from a **surface bank**, which selects a window of controls on that page.
- Default to following the console’s current executor page with a local surface-bank offset.
- Provide an explicit independent-page mode. Local banking must not silently change the console page or create pages.
- Support M-Play’s separate bank sections and M-Touch’s bank navigation.
- Show the active page/bank and follow/independent mode in service status and available hardware indicators.
- Resolve executor layouts, including expanded assignments, from verified console information. Do not assume every adjacent number is a separate playback.
- Freeze a pressed button’s target until release. A bank change must never release or activate the newly mapped executor instead.
- Cancel active strip gestures on rebinding and require takeover again.
- Exclude internal Quickey-bank reservations.
- Test page changes, missing pages, reassignment, deleted objects, expanded executors, and simultaneous surfaces.

## KB-22 — Playback faders and buttons follow executor configuration

**Request:** Operate playback strips and button banks as close to their assigned grandMA3 executor controls as qualified.

**Depends on:** KB-21 and KB-16 executor probes.

**Lua changes: Yes — shared executor control interface and surface integration.** Reuse existing fader readers/operations where their contracts fit. Do not assume a master-level setter implements every fader function.

### Acceptance criteria

- Dispatch the executor’s configured button action with separate down/up events; do not translate every press into Go+.
- Support verified momentary behavior such as Flash or Temp, including disconnect/release recovery.
- Buttons may operate sequences or other supported assigned objects. Empty or unsupported assignments produce a clear refusal.
- Map each physical strip button to an explicit grandMA3 control element; never invent extra buttons on an executor.
- Honor the configured fader function. Qualify intensity master, rate, speed, and crossfade separately.
- Preserve function-specific ranges, neutral positions, endpoints, and scaling.
- Default playback touch faders to pickup: movement does not take over until it reaches the current console position within a defined tolerance.
- Display pickup direction where hardware permits, and reset pickup after bank changes, reconnects, or relevant external edits.
- Never initialize show levels from device startup reports.
- Revalidate assigned-object identity before new input. If an assignment changes while held, retain the original release record and enter recovery rather than operating the replacement.
- Test that page/bank navigation neither stops existing playbacks nor starts newly visible ones.
- Map dedicated Go, Pause, Select, and other device buttons only through explicit, documented profiles. Ambiguous functions remain unassigned.

## KB-23 — Parameter colors and playback feedback

**Request:** Make surface lighting explain what each control affects and whether feedback is current.

**Depends on:** KB-17, KB-20, and KB-22.

**Lua changes: Yes if additional semantic/color readers are required; otherwise no.** LED translation belongs exclusively in the surface service. No MCP/TypeScript changes required.

### Acceptance criteria

- The four parameter strips show the color component they control: for example red, green, blue, amber, white, or a documented violet representation of UV.
- Derive colors from verified attribute/fixture metadata where available, with explicit overrides and a neutral fallback. Do not infer solely from a translated display label.
- These colors identify the parameter; they do not claim to reproduce emitted fixture color or UV light.
- Non-color parameters use a documented feature/category scheme.
- Value indicators show readable console state. Mixed or unknown values must not appear as a fabricated single level.
- Playback controls use available executor appearance, activity, and fader feedback. Keep assignment color distinct from running, pressed, pickup, and stale indications.
- Update bindings and their colors together; no old color may identify a newly mapped control.
- On stale feedback, show a distinct unavailable state rather than retaining apparently current levels.
- Rate-limit and coalesce LED updates without delaying input or release processing.
- Expose textual labels, values, and state in the service UI/status so color is not the sole cue.
- Qualify actual color capabilities per device; document approximations for limited palettes.

## KB-24 — Device profiles and end-to-end qualification

**Request:** Deliver usable default layouts for NX-K, M-Touch, and M-Play.

**Depends on:** KB-19–KB-23.

**Lua changes: No new behavior expected.** Fix shared-module defects only when qualification identifies them. Device profiles, documentation, integration tests, and vendoring updates belong in the surface repository.

### Acceptance criteria

- Ship documented defaults:
  - NX-K: four current-context encoders plus existing hardkeys.
  - M-Touch: four parameter strips and the remaining playback strips/buttons.
  - M-Play: playback faders and button banks, with optional explicitly selected parameter-strip assignments.
- Provide diagrams or tables showing every physical control, its default role, and how to change banks.
- Verify NX-K and M-Touch parameter controls follow the same console assignments.
- Exercise RGB/extended-color pages, Pan/Tilt, mixed fixtures, cue playback, momentary buttons, pickup, and supported fader functions.
- Test two connected surfaces, USB removal, plugin restart, console context changes, and stale feedback.
- Measure input latency, feedback latency, missed events, ordering, and plugin-loop performance under realistic simultaneous use. Publish results and agreed thresholds.
- Confirm that continuous-control traffic does not regress key releases or existing flood protections.
- Publish a platform/device/firmware matrix separating automated tests from live hardware qualification.
- Update shared-module versions, API documentation, protocol versions, and vendoring hashes.
- Keep unsupported contexts and functions explicit. Do not advertise complete grandMA3 hardware equivalence.