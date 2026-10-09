# GrandMA3MCP hardkey, keyboard and feedback feature requests

Draft: 2026-10-09. Status: proposed; implementation depends on live feasibility probes.

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

**Probe order:**

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

Evidence: [docs/probes/kb-01-macos-2.5.1.md](docs/probes/kb-01-macos-2.5.1.md). Windows, multiple displays and
non-US layouts are **unverified**.

**Input backend (`Keyboard()`):**

- `Keyboard()` emulates a **PC keyboard**, not MA hardkeys. `keycode` is a case-sensitive `Enums.KeyboardCodes`
  name (`Enter`, `Escape`, `S`, `F1`, `5`). No Lua function accepts an `Enums.VirtualKeyCode` (MA key).
- PC keys become MA keys through the operator-editable **UserProfile KeyboardShortcut table** (default: Enter→PLEASE,
  Escape→ESC, Delete→CLEAR, Backspace/Ctrl+Z→OOPS, S→STORE, digits→NUM, Ctrl/Alt+F-keys→EXEC with `ExecutorIndex`)
  and the system `Root().VirtualKeys` definitions. **MA1/MA2 have no default mapping.**
- When a text input has focus, keycodes act as text editing (Backspace deletes a character) and shortcuts do not
  apply; `type='char'` inserts one Unicode character per call and works **only** in a focused text input.
- Modifiers apply only as per-event arguments; a held `LeftCtrl` key is not combined. **A release must repeat the
  press's modifier arguments**, otherwise it targets a different shortcut and the hold persists.
- Invalid display index, event type and keycode are **accepted silently**. All validation is the bridge's job.
- Effects land in the same call or one frame later, non-deterministically. The return value proves nothing;
  verification polls bounded across frames (`MAINLOOPCOUNT`).
- Holds and long-press work (Store held → Store Settings pop-up) while onPC is in the OS background. A second key
  or a duplicate press during a hold cancels the long-press. Two presses in one call never form a double-press.
- Duplicate presses collapse; stray releases are harmless.
- Injected and physical keys share **one** input and syntax state. No ownership isolation is possible at the console.
- Executor down/up via an executor shortcut (Ctrl+F1 → exec 101) is a working **non-OSC** hold mechanism for
  executors mapped in the profile table.

**Design decisions taken from these results (2026-10-09):**

- `hardkey` accepts MA key names (PLEASE, STORE, …). The bridge resolves each to a PC key + modifiers from the live
  shortcut table at request time and reports an unmapped key as unsupported. Raw `KeyboardCodes` are exposed
  separately, labeled as profile- and focus-dependent.
- MA1 and MA2 capabilities are reported individually and stay unsupported unless an operator-provided mapping has been
  validated. An unsupported combination is rejected before any part is sent. Mappings are revalidated after
  configuration changes; another key is never substituted silently. The bridge makes no automatic shortcut or show changes.
- The Quickey path remains a separate follow-up. Bridge-owned shortcuts are a possible later opt-in feature.

**Feedback readers:** command text `CmdObj().cmdtext`; last command and result `CmdObj().lastcommand`; Blind, Highlight
and Solo = `ShowData.Masters.Grand.{Blind,Highlight,Solo}.FADERENABLED` (show scope); Preview mode =
`CurrentProfile().Environments.ACTIVEENVIRONMENT` (user-profile scope); pending Preview key = `Display.PREVIEWBARACTIVE`;
page `CurrentExecPage()`; executor activity `Sequence:HasActivePlayback()`. **Freeze: no readable state found**,
so it is reported unavailable.

**Recovery:** release with the same name *and* modifiers; Escape (repeat) closes pop-ups and clears the command line;
restart the plugin with `Plugin "gma3_mcp_bridge"`; restart onPC as the last resort.

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

## KB-04 — Implement the proven input backend and conditional Quickey fallback

**Request:** As a consumer, I want consistent key semantics using only mechanisms proven on the target console.

**Depends on:** KB-01, KB-02, KB-03.

**Lua changes: Yes.** Implement the validated `Keyboard()` adapter and, only if feasible, the Quickey adapter.

**Acceptance criteria:**

- Support instance operations equivalent to `press(code)`, `release(code)`, `tap(code, hold_ms)` and
  owner-scoped `release_all()`. Ownership comes from the instance/session, not an untrusted free-form ID.
- Select a backend explicitly or from a documented capability policy at initialization. Do not switch
  it after a partially dispatched interaction. Status explains the selected mechanism and limitations.
- Validate configured display and key codes. Fail before dispatch if the requested semantics are unsupported.
- Timed taps schedule their release through periodic servicing. Define whether the response means
  scheduled, dispatched or completed; do not report completion before the release is attempted.
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
| `hardkey` | Validated code and `press`, `release` or `tap`; bounded `hold_ms` for taps |
| `type` | Bounded text injection into the configured display's focused input |
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
- Define supported text encoding and iterate Unicode characters correctly rather than UTF-8 bytes.
  Set length limits, explicit newline/control-character rules and focus behavior; do not silently
  execute a line or close a dialog as a side effect of text normalization.
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

- Probe command-line text using `CmdObj().cmdtext`, which appears in MA's official example; verify its
  behavior on target versions. Keep raw text separate from any inferred pending keyword.
- Probe Blind, Highlight, Preview, Freeze and Solo individually. Define whether each value describes
  the current user/profile, local station, programmer, playback or another scope.
- Define current-page and executor activity/level semantics and map only verified console properties.
  Do not equate assigned, selected, active and nonzero-level states.
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
  Their signature and hardkey semantics remain probe inputs, not confirmed contracts here.
- Claims that no other external hardkey mechanism exists, or that OSC executor keys fail on a particular
  release, are not prerequisites for this design and should not be published as universal facts.
