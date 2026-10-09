# GrandMA3MCP hardkey, keyboard and feedback feature requests

Updated: 2026-10-09 after review of commit `8a3782d` and its recorded live probe results.
Status: macOS single-display input/feedback observations recorded; production implementation proposed.
KB-01 still has qualification gaps listed below. No production keyboard operations were added by that commit.

This document expands the initial request from `mtpnxk-client-pico` into dependency-ordered features
and acceptance criteria, following the format of [FEATURES.md](FEATURES.md). The originating project's
`docs/handoff.md` and `docs/ma3-feedback.md` describe its consumer context and feedback schema; those
files are external references, not files supplied or independently reviewed as part of this document.

## Why

The bridge executes complete commands through `Cmd()`. Interactive console operation also needs
key-down/key-up sequences: holding Store or MA while pressing another key, pressing Please, Clear,
Oops or Esc, and typing into a focused dialog. These capabilities have two consumers:

1. MCP clients testing or demonstrating interactive console behavior, including pending keywords,
   store pop-ups and dialogs.
2. mtpnxk surfaces: initially a Pico hosting an NX-K keypad, later potentially M-Touch and M-Play.
   A separate Lua plugin receives surface input over UDP and reads console state for LED feedback.

Both consumers should reuse console interaction code. They do not share a transport or plugin loop.
The surface integration is a separate consumer, not a new network listener inside the MCP bridge.

## Architecture requirements applying to every request

- Retain MCP → TypeScript → JSON-lines TCP → Lua bridge, bound to loopback only. Keep the existing
  cooperative plugin-thread execution model; do not move context-bound API calls into child coroutines.
- Implement reusable console input and feedback modules with separate responsibilities. Keep transport,
  MCP result formatting, surface message formats and bridge globals outside those modules.
- Each consumer creates an instance with its own ownership records, configuration and resources.
  Do not keep mutable key state in a shared module singleton or rely on `require` cache isolation.
- No OSC backend or fallback is added by this work. Existing OSC features remain compatible.
- New structured input capabilities are disabled by default and enabled explicitly by the console
  operator for each plugin run. They work without enabling arbitrary Lua execution.
- Read-only capability/status and feedback queries remain usable with input disabled. Report unsupported
  capabilities explicitly; do not guess a key mapping, state property or backend behavior.
- Validate before dispatch. Distinguish execution outcome from verified console/UI effect. Do not retry
  input after an uncertain dispatch, silently change backends mid-interaction, or fall back to `Cmd()`
  when the requested semantics require an actual held key.
- Key ownership and interaction admission are enforced in the Lua bridge, not solely by a TypeScript
  mutation lock. That lock only coordinates one MCP server process.
- Separate plugins do not establish a security boundary inside onPC or guarantee latency isolation.
  Both affect the same console. State the supported coexistence policy explicitly.
- A watchdog can release keys only while execution can progress. A blocked host call, plugin crash or
  process termination may prevent release; neither a timeout nor cleanup is an unconditional guarantee.
- A feature marked **Lua changes: No** must reuse the structured operations established by earlier
  features. Do not introduce generated `gma3_lua` calls to bypass that boundary.
- Tests involving real console behavior require a disposable show and explicit opt-in. Mock coverage
  is necessary but does not prove an undocumented API works in onPC.

## KB-01 — Establish an input and feedback capability matrix

**Request:** As a maintainer, I want reproducible probes before committing to an input backend.

**Depends on:** None.

**Lua changes: No production changes.** Use a separate probe plugin and live-test fixtures.

**Original probe order (retained for context; use the confirmed contracts below for implementation):**

1. Inspect the installed version's `HelpLua` output and live API descriptor. The proposed, undocumented
   signature is `Keyboard(display_index, type, char_or_keycode, shift, ctrl, alt, numlock)`, with
   `type` proposed as `press`, `char` or `release`. Verify it rather than assuming compatibility.
2. Try `Keyboard(1, 'char', '5')`; record where the character appears. Discover and test the actual
   Please key code with paired press/release. Test Store held for approximately one second, then
   release; observe whether its expected pop-up opens. Test dialog text entry and Esc.
3. Test MA combinations, overlapping holds, release order, duplicate events, long presses, physical
   keyboard interaction and physical keys already held. Validate actual codes; display labels such as
   `Please` or `MA` need not be the accepted identifiers.
4. If hardkeys are incomplete, investigate the Quickey executor approach. Prove a non-OSC Lua method
   for both down and up; invoking a button function is not proof of equivalent hold/release behavior.
5. Probe feedback properties and module loading needed by later features.

**Acceptance criteria:**

- Record onPC version, operating system, user/profile, display, keyboard layout, focus, key mapping,
  expected effect, observed effect and cleanup for every test.
- Run separately on macOS and Windows before claiming support on both. Untested combinations remain
  unverified; unavailable functions produce an explicit unsupported result.
- Test application foreground/background state, multiple displays, command-line focus, focused input
  fields and modal dialogs. OS-focus independence is a hypothesis, not an initial guarantee.
- Successful digit/Please tests establish only basic input. Backend capabilities separately identify
  text, hardkeys, simultaneous holds, modifiers and long-press behavior.
- Identify whether displayed command text and focused-dialog state can be read back. Do not infer
  verified input from a function returning without error.
- Quickey executor actuation is a go/no-go gate. If no non-OSC mechanism works, leave that backend
  unsupported; do not expand the transport scope to make the fallback work.
- Include manual recovery instructions for every hold test and for an unresponsive plugin.
- Save probe evidence and update this design with the confirmed API contracts before KB-02–KB-04.

### KB-01 results — confirmed contracts (macOS, onPC 2.5.1.0, single display)

Evidence: [docs/probes/kb-01-macos-2.5.1.md](docs/probes/kb-01-macos-2.5.1.md), reviewed as a written
live-run record, not independently rerun here. The push adds that record and this design, not an automated
keyboard regression harness. Two displays were tested in run 3. Windows 11 (onPC 2.5.1.0, one display, US layout)
was run with the probe script and its manual checks, with matching results
([docs/probes/kb-01-windows-2.5.1.md](docs/probes/kb-01-windows-2.5.1.md)). Non-US layouts and Windows
multi-display are **unverified**.
The evidence page's “complete” status applies to its recorded run, not every KB-01 acceptance criterion.

**Input backend (`Keyboard()`):**

- `Keyboard()` emulates a **PC keyboard**, not MA hardkeys. `keycode` is a case-sensitive `Enums.KeyboardCodes`
  name (`Enter`, `Escape`, `S`, `F1`, `5`). No direct `Enums.VirtualKeyCode` (MA key) input function
  was found in the inspected live descriptor.
- PC keys become MA keys through the operator-editable **UserProfile KeyboardShortcut table** (default: Enter→PLEASE,
  Escape→ESC, Delete→CLEAR, Backspace/Ctrl+Z→OOPS, S→STORE, digits→NUM, Ctrl/Alt+F-keys→EXEC with `ExecutorIndex`)
  and the system `Root().VirtualKeys` definitions. MA1/MA2 have no shortcut entry; the PC **Shift keys are the
  MA key** natively (follow-up F2–F4), observable as `Root().MASTATE`.
- When a text input has focus, keycodes act as text editing (Backspace deletes a character) and shortcuts do not
  apply; `type='char'` inserts one Unicode character per call and works **only** in a focused text input.
- Modifiers apply only as per-event arguments; a held `LeftCtrl` key is not combined. **A release must repeat the
  press's modifier arguments**, otherwise it targets a different shortcut and the hold persists.
- Invalid display index, event type and keycode are **accepted silently**. All validation is the bridge's job.
- `display_index` had **no observed effect** (run 3, two displays): keys, `char`, Escape and pop-up placement
  behaved identically for every index, including nonexistent ones. Input is not display-specific.
- Effects land in the same call or one frame later, non-deterministically. The return value proves nothing;
  verification polls bounded across frames (`MAINLOOPCOUNT`).
- Holds and long-press work (Store held → Store Settings pop-up) while onPC is in the OS background. A second key
  or a duplicate press during a hold cancels the long-press. The tested pair of presses in one call did not form a double-press.
- In the tested cases, duplicate presses collapsed and stray releases had no visible effect. Duplicate
  presses still suppressed long-press behavior, so they must not be forwarded as lease renewals.
- Injected and OS-delivered input interacted in one syntax and key state. Internal ownership cannot isolate that
  interaction. A release from either source ends a Shift (MA) hold made by the other — confirmed with a
  hardware key in both directions (run 3, H1–H2).
- Executor down/up via an executor shortcut (Ctrl+F1 → exec 101) is a working **non-OSC** hold mechanism for
  executors mapped in the profile table.

**Design decisions taken from these results (2026-10-09):**

- `hardkey` accepts MA key names (PLEASE, STORE, …). The bridge resolves each to a PC key + modifiers from the live
  shortcut table when admitting a new press/interaction and reports an unmapped key as unsupported. A
  release uses the stored press tuple, never a newly resolved mapping. Raw `KeyboardCodes` have a separate
  proposed operation, labeled as profile- and focus-dependent; they are not yet implemented.
- **MA (decided 2026-10-09 after follow-up F2–F4):** `hardkey` supports one logical key `MA`, dispatched as a
  `LeftShift` key press/release (never the shift flag) and verified through `Root().MASTATE`. It does not depend
  on the shortcut table or `KEYBOARDSHORTCUTSACTIVE`. MA1 and MA2 are reported separately as **unsupported**:
  both Shift keys feed one MA state, so Lua cannot distinguish them. MA combinations (MA held + another key)
  are supported only when every other key in the combination resolves; an unsupported combination is rejected
  before any part is sent. Because MA state is shared with the physical keyboard, `MASTATE` confirms the MA
  state, not ownership; status reports it as observed console state.
- Shortcut mappings are revalidated after configuration changes; another key is never substituted silently.
  The bridge makes no automatic shortcut or show changes.
- The Quickey path remains a separate follow-up. Bridge-owned shortcuts are a possible later opt-in feature.

**Feedback readers:** command text `CmdObj().cmdtext`; last command and result `CmdObj().lastcommand`; Blind, Highlight
and Solo = `ShowData.Masters.Grand.{Blind,Highlight,Solo}.FADERENABLED` (show scope); Preview mode =
`CurrentProfile().Environments.ACTIVEENVIRONMENT` (user-profile scope); pending Preview key = `Display.PREVIEWBARACTIVE`;
page `CurrentExecPage()`; executor activity `Sequence:HasActivePlayback()`. **Freeze: no readable state found**,
so it is reported unavailable.

**Recovery:** attempt release using the original display, case-sensitive key name and all modifier flags.
Escape can dismiss a pop-up and then clear pending text; it changes UI/command state and must not be an
implicit cleanup step. Starting an already-running bridge is not a proven restart or key reset. Follow
[bridge stop/start instructions](docs/setup/bridge.md) when the plugin is responsive; restart onPC only
as a last-resort operator action. A restart is not evidence that an uncertain release succeeded.

### Remaining qualification and scope decisions

- **First backend:** `Keyboard()` through existing, operator-owned shortcuts. It creates no shortcut,
  VirtualKey, Quickey, page or executor objects. Capability is conditional on profile, display and focus.
- **MA:** decided — logical `MA` via the `LeftShift` key with `MASTATE` verification; MA1/MA2 individually
  unsupported (see design decisions above). Evidence: the PC Shift keys are the MA key natively (MA manual;
  holding `LeftShift` or `RightShift` sets `Root().MASTATE` and turns `S` into `Record`); both feed one MA
  state; the shift *flag* argument does not produce MA.
- **Quickeys:** mapped executor Flash down/up is proven in this run; a Quickey assigned to that executor
  and used to hold/release an MA key is not. Keep that investigation separate and non-blocking for the
  shortcut backend. Bridge-owned shortcuts require a separate opt-in design and are outside this phase.
- **Follow-up results (macOS):**
  - *Shortcuts disabled* (F10; readable as `UserProfile.KeyboardShortCuts.KEYBOARDSHORTCUTSACTIVE`):
    shortcut keys do nothing, `char` types into the ordinary command line, Enter still executes (PLEASE is a
    `VirtualKey.KEYCODE` redirect, not a shortcut), Delete does not CLEAR, F10 still toggles.
  - *Remap or disable during a hold:* the stored tuple **does not release** the hold after the shortcut is
    remapped or shortcuts are disabled; it releases once the mapping/enablement is restored. Admission must
    observe `KEYBOARDSHORTCUTSACTIVE` and the mapping; a change during a hold is an unresolved-release state.
  - *Same-key cross-source release:* physical and injected events share one key state in both directions,
    confirmed with synthetic OS events (F14–F15) and a hardware Shift key (H1–H2).
  - *Multiple displays (run 3):* `display_index` does not route input; a pop-up triggered via index 2 opened
    on Display 1. The bridge must not claim display targeting.
  - *Double-press:* not produced through keyboard shortcuts at 0–16 frame gaps, injected or OS-delivered.
    Keep it unsupported.
- **Windows (script subset):** 26/26 automated checks, long-press, text entry (`aü`) and hardware Shift release
  in both directions match macOS; injected input reached onPC with another app in the OS foreground. The
  exploratory follow-ups above were not repeated on Windows.
- **Open probes:** module loading/show portability (KB-02), non-US keyboard layouts, Windows multi-display.
  Do not infer these from basic shortcut success.
- **Side effect resolved:** `PRESERVEGRIDPOSITIONS` false→true was reproduced as a result of the cleanup
  command `Unassign Page 1.101` (parsed as `Fixture "Unassign" Page 1.101`), not keyboard input; restored.
- **Freeze:** unavailable after empty-selection, with-selection and `Freeze On` probes plus a deep property
  search. This does not prove no getter exists. No false/zero fallback is permitted.
- **Evidence limits:** retain operator/profile/display identity, mapping and focus preconditions with
  test results. Add reproducible regression fixtures as implementation proceeds; a prose probe record
  is not automated regression coverage.

## KB-02 — Package reusable console interaction modules

**Request:** As a plugin author, I want reusable console adapters without shared transport or key state.

**Depends on:** KB-01.

**Lua changes: Yes.** Add instance-based input and feedback modules and a verified loading mechanism.
No production input operation is exposed in this feature.

**Proposed organization:** `hardkeys.lua` for input lifecycle and backend adapters; a separate feedback
module for read-only state. Filenames and loader details are finalized by the packaging probe.

**Acceptance criteria:**

- Module instances receive console dependencies/configuration and expose explicit initialization,
  status, periodic servicing and disposal interfaces. Loading a module alone does not allocate show
  objects, press keys, start timers or create sockets.
- Validate whether an additional `ComponentLua` can be used through the intended loader. Adding it
  to XML does not by itself establish that `require('hardkeys')` resolves it.
- Test initial import, stop/start, `ReloadAllPlugins`, save/reload, and transfer of the saved show to
  a machine without the original loose source files. Document any required external installation.
- Two plugin instances can load the modules without sharing mutable state or taking each other's slots.
  Verify module cache behavior and avoid generic global/module-name collisions.
- Update the XML, platform install instructions, copy/install scripts and packaging where required so
  every needed module is included. Preserve the existing bridge's import and startup behavior.
- Define a module API/version and a reproducible way for mtpnxk to vendor the same source and license.
  Surface-specific changes must not create an undocumented fork of console semantics.

## KB-03 — Add owned input sessions and recovery

**Request:** As an operator, I want held input to have a known owner, bounded lifetime and recovery path.

**Depends on:** KB-02.

**Lua changes: Yes.** Add lifecycle helpers and bridge-side session/admission handling. Use a fake backend
for automated tests until KB-04 supplies a proven console implementation.

**Acceptance criteria:**

- Associate every held key with an owner/session and a lease or maximum duration. Bind bridge sessions
  to their originating connection; another connection cannot release or renew them by guessing an ID.
- Store each press's resolved display, case-sensitive PC key, shift/ctrl/alt/numlock flags, logical
  key and profile/mapping identity until its release is resolved. Release with that exact tuple even
  after configuration changes; never re-resolve the logical key for cleanup. Recheck effects where
  observable: the saved tuple alone cannot guarantee release after a host profile/remapping change.
- Deduplicate ownership by resolved input tuple as well as logical key, so aliases cannot create two
  owners of the same injected key. Lease renewal must not inject another press.
- On profile/display/mapping changes during a hold, stop new interaction events, attempt stored-tuple
  releases and retain uncertainty if release cannot be established. Test this transition explicitly.
- Define duplicate presses/releases, unsupported codes, exhausted capacity and release ordering.
  Releasing an already released owned key is harmless. Reject conflicting ownership explicitly.
- Service deadlines without blocking sleeps. Bound operations and work per frame; ensure a busy client
  cannot indefinitely starve deadline processing while the event loop remains runnable.
- Attempt owner-key release on disconnect, lease expiry, shutdown, disabling input, and errors.
  Reject new input during disposal and report any failed or unconfirmed release.
- Preserve the existing cleanup distinction: control invocations such as `status` must not release
  keys belonging to the still-running bridge. Test this regression explicitly.
- Provide an operator recovery action. Ordinary client release-all affects only that client's owned
  keys; any administrative broader reset is separately scoped and documented.
- Define how synthetic release interacts with physically held keys, using KB-01 evidence. Do not claim
  ownership isolation at the console if the injection API cannot provide it.
- Status distinguishes owned/tracked state, dispatched releases and observed console state. It includes
  owner, remaining lease, backend and unresolved cleanup failures without claiming physical key state.
- Document recovery limitations when onPC or a host API blocks; do not describe expiry as guaranteed
  cancellation of a host call.

## KB-04 — Implement shortcut input; investigate Quickeys separately

**Request:** As a consumer, I want consistent key semantics using only mechanisms proven on the target console.

**Depends on:** KB-01, KB-02, KB-03.

**Lua changes: Yes.** Implement the validated shortcut-based `Keyboard()` adapter. Quickey production
support is conditional on a separate successful probe and explicit opt-in resource allocation; it is
not required to ship this backend and must not become an automatic fallback.

**Acceptance criteria:**

- Support instance operations equivalent to `press(code)`, `release(code)`, `tap(code, hold_ms)` and
  owner-scoped `release_all()`. Ownership comes from the instance/session, not an untrusted free-form ID.
- Select a backend explicitly or from a documented capability policy at initialization. Do not switch
  it after a partially dispatched interaction. Status explains the selected mechanism and limitations.
- Resolve MA key names through live profile shortcuts and validate the actual `Enums.KeyboardCodes`
  name, modifier tuple, display and mapping scope before a new press. Distinguish executors by
  `ExecutorIndex`/`SpecialExec`; `EXEC` alone is not a unique target. Define deterministic handling of
  multiple mappings and reject ambiguity rather than guessing.
- Inspect mapping data without modifying it. Revalidate on profile/configuration changes. Preflight every
  requested key in a combination before dispatching its first event.
- Implement logical `MA` as a `LeftShift` key event pair (not the shift flag), independent of the shortcut
  table, and verify with bounded `MASTATE` readback. Report MA1 and MA2 as unsupported. Track MA ownership
  like any other held key; on release, a still-true `MASTATE` (e.g. physical Shift held) is reported as
  observed state, not as a failed release.
- Pass PC modifiers explicitly on every press and release. Pressing `LeftCtrl` and then a plain key
  is not an implementation of Ctrl+key. The shift flag is a PC modifier, not MA.
- Validate configured display and key codes. Invalid arguments can be silently ignored by onPC, so
  a no-error return is not validation. Because `display_index` does not route input on 2.5.1, accept only an
  existing display, report input as not display-scoped, and never promise per-display focus or pop-up placement. Do not use an input event as a capability-detection side effect.
- Timed taps schedule their release through periodic servicing. Define whether the response means
  scheduled, dispatched or completed; do not report completion before the release is attempted.
- An intended long-press is uninterrupted: reject conflicting events during it and do not forward
  duplicate presses. A sequence that intentionally adds another key has different semantics and
  cannot promise the long-press pop-up. External operator activity remains outside these guarantees.
- Keep double-press unsupported until its inter-event timing and effect are proven; two taps in one
  handler are not established as a double-press. Make any later timing policy bounded and explicit.
- For the optional Quickey follow-up, first test a Quickey assigned to a mapped executor with matching
  down/up modifier tuples, including an MA hold. Do not extrapolate from Sequence Flash behavior.
- For Quickeys, accept explicit ranges corresponding to `quickey_from`, `count`, `exec_page` and
  `exec_from`. Verify the page and all slot addresses and prove non-OSC down/up actuation first.
- Preflight the entire reservation before mutation. Refuse occupied or overlapping ranges and preserve
  unrelated page/executor configuration. Track ownership of created objects and partial initialization.
- Revalidate ownership before reuse or deletion. Do not overwrite or delete resources edited/reassigned
  by an operator. Define restart recovery for objects owned by a previous run.
- Release before reassigning a slot. If release is uncertain, quarantine the slot rather than freeing
  it for another key. Capacity errors must leave existing holds intact.
- Validate same-key repetition, modifier combinations, exhaustion, cleanup failures and user-edited
  reservations with automated tests and live disposable-show tests.

## KB-05 — Expose gated structured input operations

**Request:** As an MCP client, I want explicit interactive input without enabling arbitrary Lua or constructing scripts.

**Depends on:** KB-03, KB-04.

**Lua changes: Yes.** Add only the structured operations and interaction admission needed below.
TypeScript tools wrap these operations; they do not implement a second key dispatcher.

**Proposed protocol surface (names provisional):**

| Operation | Purpose |
| --- | --- |
| `hardkey` | Logical MA key resolved through a validated existing shortcut (or `MA` via `LeftShift`); `press`, `release` or bounded `tap` |
| `keyboard` | Explicit PC key plus per-event modifiers; profile/focus-dependent, with the same gate, ownership and validation |
| `type` | Unicode character events into a focused text input; not general command-line entry |
| `hardkeys_status` | Capability, enablement, backend, owners, held records, capacity and cleanup status |
| `hardkeys_release_all` | Release keys owned by the caller; recovery remains available while input is disabled |
| `input_sequence` | Bounded ordered presses, releases, taps and text under one interaction owner |

**Acceptance criteria:**

- Bridge-side opt-in is separate from arbitrary Lua and resets each run. Disabled mutation requests
  fail before dispatch; capability/status reads and required release/recovery remain available.
- Finalize session acquisition/renewal/release contracts before exposing standalone holds. Either use
  a bounded sequence for an entire interaction or an explicit lease across calls.
- Serialize each complete interaction against conflicting mutations from every bridge connection.
  Enumerate affected existing operations, including commands, property changes, playback, faders and
  Lua execution. Prefer explicit busy rejection to silently delaying a command into a changed context.
- Document that these guards cannot isolate a physical operator or a separate surface plugin. Initially
  require exclusive interactive use unless a tested cross-plugin arbitration mechanism is specified.
- Preserve normal read-only status access and a path for owner releases while an interaction is active.
- Treat `type` as focused-field text entry: the probe did not insert characters into the ordinary
  command line, and numeric keycodes did not type digits into the tested editor. Do not silently
  focus a field, open an editor, replace `type` with shortcuts or execute text via `Cmd()`.
- Specify a focus precondition. Reject a known mismatch; if focus cannot be observed reliably,
  require explicit caller acknowledgment and report UI verification as unavailable. A mapped key
  may edit a field instead of performing its named hardkey action.
- Define supported text encoding and iterate Unicode characters correctly rather than UTF-8 bytes.
  Set length limits, explicit newline/control-character rules and focus behavior; do not silently
  execute a line or close a dialog as a side effect of text normalization.
- Perform bounded readback across frames when a suitable observable exists; the effect may appear
  synchronously or on a later frame. The recorded `MAINLOOPCOUNT` can identify frame progress, but
  neither one fixed delay nor one immediate read establishes failure or success. Deadline expiry
  never triggers input replay, and verification must leave release/deadline servicing runnable.
- Report completed and unattempted events, text progress where knowable, and any uncertain final event.
  Never equate API acceptance with confirmed UI effect. Retain existing workflow outcome conventions.
- Do not automatically replay taps, text or sequences after timeouts/disconnects. Session reconciliation
  and release recovery are distinct from retrying an uncertain input mutation.
- Add MCP registration/schema tests, Lua dispatch tests and live interaction tests. Existing tools and
  default startup continue working with input disabled and with arbitrary Lua disabled.

## KB-06 — Add console feedback readers

**Request:** As a surface or MCP consumer, I want read-only console state for feedback without enabling input injection.

**Depends on:** KB-01, KB-02. This can proceed independently of KB-03–KB-05 once those dependencies are complete.

**Lua changes: Yes for new state readers and their structured bridge operation.** Reuse existing programmer,
executor and fader queries where their semantics already fit; do not duplicate those implementations.

**Acceptance criteria:**

- Implement the recorded sources with capability checks and version-specific tests: command text
  `CmdObj().cmdtext`, raw last-command feedback `CmdObj().lastcommand`, Blind/Highlight/Solo via
  `ShowData.Masters.Grand.<mode>.FADERENABLED`, profile Preview via
  `CurrentProfile().Environments.ACTIVEENVIRONMENT`, and display-local `PREVIEWBARACTIVE` separately.
- Keep raw command text separate from inferred keywords, and raw last-command feedback separate from
  confirmation of a particular request. Shared command history alone cannot correlate concurrent UI input.
- Preserve the observed scopes: show masters, current user profile, display, and user current page.
  Verify cross-user behavior before making stronger scope guarantees than the single-user probe supports.
- Use `CurrentExecPage()` for page identity and the existing fader queries for levels. Report
  `Sequence:HasActivePlayback()` as sequence activity; it is not proof that a particular executor
  caused that playback or that its button remains held. Do not conflate assignment, selection, level
  and activity. Freeze stays unavailable unless a new probe establishes readable state.
- Unknown or unsupported values are `null`/unavailable with a reason, never guessed `false` or zero.
  Include snapshot freshness and scope; cached state becomes stale after disconnect or show change.
- Reads do not change selection, command text, programmer, playback or UI focus and work with both
  interactive input and arbitrary Lua disabled.
- Bound polling rate, response size and per-frame work. Document that multiple reads are not an atomic
  snapshot against other console activity.
- Before surface integration, review `mtpnxk-client-pico/docs/ma3-feedback.md` and document the mapping
  from reusable reader results to that schema. Keep device LED/message formatting in the consumer.

## KB-07 — Integrate the independent mtpnxk surface consumer

**Request:** As a surface user, I want responsive keypad input and trustworthy LED state across network interruptions.

**Depends on:** KB-03, KB-04, KB-06. KB-05 is needed only for MCP-driven integration tests.

**Lua changes: No additional MCP bridge changes expected.** Surface-plugin Lua changes are required.
Any newly necessary bridge operation must be justified as a separate dependency, not added implicitly.

**Acceptance criteria:**

- Vendor the versioned console modules into the surface package; do not connect to or depend on the
  bridge process. Preserve its independent release cadence.
- Use a nonblocking LuaSocket UDP loop with cooperative yields and bounded packets/work per frame.
  Do not add an OSC path or move a LAN listener into the MCP bridge.
- Define sender authorization/pairing and replay handling before deployment. A sender/session ID alone
  is not authentication. Reject malformed, unauthorized and oversized messages before console calls.
- Include session epochs, sequence handling, expiry and held-key reconciliation so duplicate, lost,
  reordered and delayed packets cannot revive expired holds or leave a key held indefinitely while
  the loop is healthy. Specify reconnect behavior and do not replay old taps.
- Test dropped releases, repeated presses, sender restart, plugin restart, stalled feedback, capacity
  exhaustion and overlapping resource reservations by two consumers.
- Enforce or clearly document the exclusive-use policy for simultaneous surface/MCP input. Independent
  module instances do not themselves arbitrate the shared console keyboard state.
- Measure input latency and feedback freshness on the target hardware under load. Choose and publish
  acceptance thresholds before declaring the surface integration complete.

## KB-08 — Document and qualify supported deployments

**Request:** As a user, I want an accurate setup and compatibility statement for the delivered capabilities.

**Depends on:** KB-05 and KB-06; KB-07 before claiming surface support.

**Lua changes: No.** Use the completed structured API and module interfaces. New defects are fixed in the
owning feature rather than bypassed with ad hoc Lua in documentation or tests.

**Acceptance criteria:**

- Document opt-in startup, supported codes/displays, backend selection, reserved show resources, leases,
  recovery, result semantics and limitations separately from ordinary command execution.
- Publish tested OS/onPC combinations and retained probe evidence. Clearly label unsupported and
  untested combinations; testing one platform/version does not establish another.
- Provide regression coverage for disconnect/expiry cleanup, control-call Cleanup, conflicting clients,
  partial sequences, Unicode, resource ownership, and saved-show module loading.
- Keep automated mock checks separate from opt-in live tests and explain what neither can guarantee.
- Include installation/update instructions for every new module and a documented operator recovery path.
- Preserve existing default behavior, loopback binding and the absence of automatic input replay.

## Evidence and open questions

- [MA: Plugins](https://help.malighting.com/grandMA3/2.4/HTML/plugins.html) describes `HelpLua`, multiple
  components, component invocation, import files, and show-file versus library storage. It does not
  establish that an added component becomes a standard `require` module.
- [MA: CmdObj()](https://help.malighting.com/grandMA3/2.1/HTML/lua_objectfree_cmdobj.html) includes a
  `cmdtext` example. This supports the initial probe target, not a complete pending-keyword API.
- [RBOSCKeys author's description](https://git.riksolo.com/RikSolo/eleventy-riksolo-com/commit/8ec798f93fc873ef7c9ac485f8b5423a33999d69)
  describes dynamic Quickey allocation and executor holds. It is evidence for the pattern, not proof
  of a non-OSC implementation or compatibility with every onPC version.
- The originating proposal cites a community v2.3 `Keyboard()` API dump and MA forum thread 9022.
  The recorded live descriptor and observations above now supersede those references for the tested
  macOS configuration; they do not establish compatibility on other versions or platforms.
- Claims that no other external hardkey mechanism exists, or that OSC executor keys fail on a particular
  release, are not prerequisites for this design and should not be published as universal facts.
