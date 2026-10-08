# GrandMA3MCP feature requests and acceptance criteria

## Architecture requirements applying to every request

- Retain the existing MCP → TypeScript → JSON-lines TCP → Lua bridge architecture.
- Reuse existing bridge operations wherever possible.
- Do not add another transport, shared-file communication, or a second command dispatcher.
- Features marked **Lua changes: No** must work with arbitrary Lua execution disabled. Do not implement them by generating code for `gma3_lua`.
- Features marked **Lua changes: Yes** may add only the specified structured operations and supporting helpers.
- New workflow tools use the bridge directly. They must not silently fall back to OSC or retry a mutation after an uncertain outcome.
- Distinguish confirmed success, confirmed failure, partial completion, and unknown outcome.
- Keep all existing public tools compatible unless a breaking change is explicitly approved.
- A timeout does not prove a command failed to execute.
- Validation against mocks must be supplemented with a documented test on a disposable onPC show where console behavior matters.

## FR-01 — Establish automated regression coverage

**Request:** As a maintainer, I want repeatable automated checks so new workflow features do not regress bridge reliability or execution controls.

**Depends on:** None.

**Lua changes: No production behavior changes required.** Use a mock console environment around the existing plugin. Any testability refactor must preserve its protocol and behavior.

**Acceptance criteria:**

- One documented command runs the automated suite without a live console.
- CI runs compilation and automated tests.
- Tests cover:
  - Correct UTF-8 decoding across fragmented TCP packets.
  - Correlation of concurrent replies with their request IDs.
  - Disconnects and timeouts after dispatch without OSC resend.
  - Permitted fallback after pre-dispatch connection failure.
  - Manual lookup traversal and external symlink rejection.
  - Normal manual lookup.
  - Loopback-only binding.
  - Lua disabled by default, hook-removal rejection, child-coroutine budgets, and deadlines across yields.
- Test cases exercise production code rather than duplicate its implementation.
- Live-console tests are separate, explicitly invoked, and document the show objects they modify.

## FR-02 — Standardize workflow validation and operation results

**Request:** As an MCP client, I want consistent results so I can determine whether to continue, inspect state, or stop after an operation.

**Depends on:** FR-01.

**Lua changes: No.** Normalize existing bridge results in TypeScript.

**Acceptance criteria:**

- New tools share validation and result helpers.
- Results identify the target, requested operation, execution outcome, and any verification performed.
- Execution outcome distinguishes `succeeded`, `failed`, `partial`, and `unknown`.
- Verification distinguishes `matched`, `mismatched`, `unavailable`, and `not_requested`.
- Recognized negative console feedback is treated as failure; unfamiliar feedback is not automatically treated as success.
- Transport errors after dispatch produce an unknown outcome and never trigger automatic replay.
- Multi-step operations stop after the first failed or uncertain step and report completed, failed/uncertain, and unattempted steps.
- Failed, partial, and unknown operations are clearly surfaced as MCP tool errors, with their details retained.
- Shared validation covers finite numeric values, valid identifiers, mutually exclusive options, and safe handling of quoted names.
- Existing tools retain their response compatibility unless separately migrated.

## FR-03 — Add dedicated fixture programming tools

**Request:** As a lighting programmer, I want dedicated tools for fixture selection, attributes, RGB color, and position so routine programming does not require constructing console commands.

**Depends on:** FR-02.

**Lua changes: No.** Use existing `cmd` and object-query operations.

**Proposed tools:**

- `gma3_select`
- `gma3_set_attribute`
- `gma3_set_color`
- `gma3_set_position`
- `gma3_clear_programmer`

**Acceptance criteria:**

- Selection accepts documented fixture ranges and group references.
- Attribute, color, and position tools accept an explicit target; use of the current selection requires an explicit option.
- Attribute names and values are validated. RGB uses a documented 0–100 scale; pan/tilt units are explicit.
- Color support initially covers documented RGB attributes. Unsupported fixtures produce a clear result rather than a success claim.
- Tools document whether they change the selection and whether they clear existing programmer values.
- No tool implicitly clears the programmer.
- Clear-selection and clear-programmer behavior are distinct and explicit.
- Multi-command workflows are serialized against other mutations from the same MCP server and report intermediate failures.
- Documentation states that this serialization does not isolate operations from another console operator or another client.
- Tests cover ranges, groups, invalid values, unsupported attributes, and failure between steps.
- A live test confirms the resulting programmer state on representative fixtures.

## FR-04 — Add cue storage and cue-part tools

**Request:** As a lighting programmer, I want explicit cue-storage tools with validated options and timing parameters.

**Depends on:** FR-02 and FR-03.

**Lua changes: No.** Use existing `cmd`, `object`, and `children` operations.

**Proposed tools:**

- `gma3_store_cue`
- `gma3_store_cue_part`

**Acceptance criteria:**

- Tools accept an explicit sequence and cue identifier, including supported fractional cue numbers.
- Reliance on the selected sequence requires an explicit option.
- Storage mode is explicit: create, merge, or overwrite.
- Create mode checks for an existing target and refuses an unintended overwrite. It documents that this check is not a transaction lock.
- Merge and overwrite cannot be requested together.
- Cue names containing quotes or other reserved characters are handled safely.
- Fade and delay parameters accept zero as an intentional value and reject negative or non-finite values.
- Cue-part storage accepts a validated part identifier and documents part-zero behavior.
- Commands avoid unattended confirmation dialogs.
- Results distinguish storing the cue from verifying its existence, name, and timing.
- Tools do not claim to verify stored fixture values; that requires FR-10.
- Tests cover existing cues, merge/overwrite behavior, split timing, fractional cue identifiers, and uncertain outcomes.

## FR-05 — Add cue editing, trigger, navigation, and deletion tools

**Request:** As a lighting programmer, I want dedicated tools to edit cue timing and triggers, navigate to a cue, and delete an explicitly identified cue.

**Depends on:** FR-04.

**Lua changes: No.** Use existing `cmd`, `set`, `object`, and `children` operations.

**Proposed tools:**

- `gma3_set_cue_timing`
- `gma3_set_cue_trigger`
- `gma3_goto_cue`
- `gma3_delete_cue`

**Acceptance criteria:**

- Every operation resolves an explicit sequence and cue, or an explicitly requested selected-sequence context.
- Timing editing supports applicable cue/part timing, including explicit zero values.
- Trigger modes use a documented enumeration and validate their associated timing parameters.
- Editing changes only the supplied fields.
- Timing and trigger edits perform read-back verification where supported.
- Goto is documented as a playback mutation and does not imply that a fade has completed when its command returns.
- Deletion targets one explicit cue; range deletion is outside the initial scope.
- Missing targets and uncertain deletion outcomes are reported accurately.
- No failed or uncertain operation is retried automatically.
- Live tests verify timing, trigger behavior, navigation, and deletion using disposable cues.

## FR-06 — Add executor assignment and labeling tools

**Request:** As a programmer, I want to assign sequences to executors and label executors without assembling command strings.

**Depends on:** FR-02 and FR-04.

**Lua changes: No.** Use existing `cmd` and object inspection.

**Proposed tools:**

- `gma3_assign_to_executor`
- `gma3_label_executor`

**Acceptance criteria:**

- Assignment requires explicit sequence, page, and executor identifiers.
- The tool inspects the existing assignment before replacing it.
- Replacing a different assignment requires an explicit `replace` option.
- The result identifies the previous and resulting assignment where available.
- Labeling handles quoted names safely.
- Assignment and labeling do not trigger playback.
- A combined assign-and-label request reports partial completion if labeling fails after assignment.
- Read-back verifies the assigned object and label where supported.
- Tests cover occupied executors, missing sequences, non-current pages, invalid identifiers, and partial failure.

## FR-07 — Add structured fixture-attribute discovery

**Request:** As an MCP client, I want to discover a fixture’s available attributes and value conventions before programming it.

**Depends on:** FR-02 and FR-03.

**Lua changes: Yes.** Add one read-only attribute-discovery operation and reusable fixture/channel-resolution helpers. Existing generic property inspection does not guarantee this information.

**Proposed tool:** `gma3_fixture_attributes`

**Acceptance criteria:**

- Discovery works with arbitrary Lua execution disabled.
- Results include stable attribute identifiers and available names, units, ranges, and channel/subfixture identifiers.
- Unknown metadata is explicitly unavailable rather than inferred.
- Fixture identifiers are resolved through console APIs; code does not assume fixture ID equals patch index.
- Compound fixtures and subfixtures are represented without silently collapsing them.
- Large results are bounded or paginated.
- Discovery does not change selection or programmer state.
- FR-03 can optionally use these results for validation without requiring discovery for every call.
- Tests cover dimmer-only fixtures, RGB fixtures, moving lights, and a compound fixture.

## FR-08 — Add structured programmer inspection

**Request:** As a programmer, I want a structured view of active programmer values so I can verify a look before storing it.

**Depends on:** FR-02 and FR-07.

**Lua changes: Yes.** Add a read-only programmer-inspection operation, reusing FR-07’s fixture/channel-resolution helpers.

**Proposed tool:** `gma3_programmer`

**Acceptance criteria:**

- Inspection works with arbitrary Lua execution disabled.
- Scope is explicit: all programmer fixtures, current selection, or specified fixtures.
- “All” includes active programmer values on unselected fixtures.
- If the console API cannot enumerate the requested scope completely, the result reports incomplete coverage rather than claiming the programmer is empty.
- Results distinguish active programmer data from playback/output values.
- Results identify fixture, subfixture, attribute, value, and available timing.
- Multi-step phaser data is represented or explicitly marked as unsupported; it is not silently reduced to a single static value.
- Zero values are preserved and distinguishable from missing values.
- Results are bounded or paginated.
- Inspection does not alter selection, programmer values, or playback.
- Tests include selected and unselected fixtures, zero-valued attributes, an empty programmer, and a phaser.

## FR-09 — Add structured output and DMX inspection

**Request:** As an operator, I want to inspect actual output and DMX levels to troubleshoot the difference between programmer intent and console output.

**Depends on:** FR-02 and FR-07.

**Lua changes: Yes.** Add narrowly scoped read-only output and DMX operations, sharing existing resolution and serialization helpers.

**Proposed tools:**

- `gma3_fixture_output`
- `gma3_dmx`

**Acceptance criteria:**

- Both tools work with arbitrary Lua execution disabled.
- Fixture output identifies the attribute/channel and the units returned by the console API.
- DMX inspection accepts an explicit universe and channel range.
- Channel addresses are validated against the DMX range of 1–512; universe validation follows the supported console version.
- Raw and percentage values are explicitly distinguished. Conversion or unavailable precision is disclosed.
- “Nonzero only” is an explicit filtering option.
- Results identify their data source and do not present programmer values as output.
- Unsupported APIs, missing patch information, and unavailable output return explicit limitations.
- Requests cannot change selection, programmer, or playback.
- Tests cover zero output, multiple universes, patched and unpatched fixtures, and programmer/output differences.

## FR-10 — Add stored cue-content inspection

**Request:** As a programmer, I want to inspect stored fixture values in a cue without playing it back or loading it into the programmer.

**Depends on:** FR-04, FR-07, and FR-08.

**Lua changes: Yes.** Add a read-only cue-data inspection operation. Validate console API feasibility before committing to complete coverage.

**Proposed tool:** `gma3_cue_contents`

**Acceptance criteria:**

- An initial feasibility check identifies the supported onPC versions and which stored data can be read reliably.
- The tool accepts explicit sequence, cue, optional part, and optional fixture filters.
- Results distinguish values explicitly stored in the cue from tracked/effective values.
- The initial supported mode is clearly documented; unsupported tracked-value reconstruction is not implied.
- Returned values identify fixture, subfixture, attribute, part, and available timing or phaser information.
- Preset references are preserved where available; unresolved references are marked explicitly.
- Partial coverage is disclosed with reasons.
- The tool does not execute Goto, load the cue into the programmer, or change playback.
- FR-04 may use this tool for optional stored-value verification once supported.
- Live tests cover cue parts, tracked values, preset references, and phasers. Unsupported cases must return limitations rather than fabricated completeness.

## Delivery boundary

FR-01 through FR-06 close the principal workflow-convenience gaps without expanding the Lua protocol.

FR-07 through FR-09 add structured inspection that remains available when arbitrary Lua is disabled.

FR-10 goes beyond and should be treated as a separate, feasibility-gated enhancement.