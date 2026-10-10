# GrandMA3MCP hardkey, keyboard and feedback feature requests

Updated: 2026-10-09 after review of the KB-01 follow-up evidence and documentation through `e99f23c` (merged in `1069f1d`),
after the KB-02 module packaging work, the KB-03 owned-session implementation on the fake backend, the KB-04 keyboard
backend and the KB-05 structured input tools. Status: **KB-01 complete for the initial onPC 2.5.1.0 / US-layout feasibility scope**: macOS and Windows 11, each with one and two
onPC displays. **KB-02 complete on macOS**: modules packaged and their loading verified live, including save/reload without
loose files; Windows not exercised. **KB-03 implemented on the fake backend** (module 0.2.0, bridge 0.5.0): ownership, leases,
deadline servicing and recovery are covered by harness tests and verified live on macOS. **KB-04 implemented on macOS**
(module 0.3.0, bridge 0.6.0): the `Keyboard()` adapter presses real console keys through validated shortcut and native routes,
with MA combinations, exclusive long-press, remap/disable/disconnect/restart recovery verified live; Windows not exercised.
**KB-05 implemented on macOS** (module 0.4.0, bridge 0.7.0, MCP tools): leased interactions, bridge-side admission across
connections, the text path and bounded sequences are covered by harness tests and verified live (44/44 over two
connections, real keys and command-line text); Windows not exercised.
**KB-06 implemented on macOS** (feedback module 0.2.0, bridge 0.8.0, `gma3_feedback`): the KB-01 readers with a strict
value contract, per-display and per-executor items, freshness epochs and bounded polling, exposed read-only through an
unguarded bridge op; harness-tested and verified live (47/47, including reads while another connection owned input).
Windows module loading and transfer to a separate machine remain qualification gaps.
**KB-07 integrated live on 2026-10-09** in mtpnxk (its `KEYBOARD.md` and `docs/probes/kb-07-live-macos-2.5.1.md`): the
surface plugin vendors hardkeys 0.5.0 and feedback 0.2.0, pairs with a Rust service over authenticated UDP, and drove a
physical NX-K against onPC 2.5.1 on macOS with LEDs confirmed by the operator. Two findings from that run feed KB-09.
**KB-08 closed on 2026-10-09** in mtpnxk (`docs/kb-08-acceptance.md`, `docs/deployments.md`, `docs/operator-guide.md`,
`docs/probes/kb-08-qualification-macos-2.5.1.md`) with a bounded macOS beta scope: lifecycle observed on the console,
two limits (press-to-effect p99 at 10 taps/s, flood resilience) recorded as not met and filed against KB-07. The module
pin here is hardkeys 0.5.0 / feedback 0.2.0 at `main` after PR #12. KB-09 (shortcut-table cache, operator-managed
profile shortcuts) remains.
Completion establishes the contracts and limitations below, not production keyboard support or universal
platform coverage. The keyboard implementation remains available. KB-10–KB-15 now specify Quickey
qualification, owned resource provisioning and explicit per-key dispatch policies. **KB-10 probed live on
2026-10-09** (Quickey tap/hold/release/chord qualified through an executor; see its records). **KB-11 implemented
in the shared module on 2026-10-09** (hardkeys 0.6.0): the per-key routing policy, its validation, reporting and
route retention are harness-tested on the fake backend; `quickkey` dispatch awaits the KB-12/KB-13 backend and the
text routes await KB-14, so no new console path is qualified by it. **KB-12 implemented in the shared module on
2026-10-09** (hardkeys 0.7.0, bridge 0.9.0): operator-authorised provisioning of the owned Quickey bank and the reserved
executor range, marker-based ownership verified by readback before every mutation and dispatch, verify/teardown/adopt and
the bridge's `bank=` arguments are harness-tested against a fake console and **qualified live on the disposable show**
(94 Quickeys provisioned and read back, an operator edit reported by `bank verify`, the record adopted across a bridge
restart, teardown removing exactly the owned objects, paged executor assign/clear confirmed; see its record). Save/reload
of the show was not exercised. **KB-13 implemented on 2026-10-09** (hardkeys 0.8.0, bridge 0.10.0): the owned-Quickey
backend dispatches taps, holds and chords of the nine KB-10 qualified codes as executor presses of the bank's Quickeys,
releases only on the recorded executor, keeps the executor target with every record across recovery and restarts, and
refuses discovered-only codes and unevidenced operations before dispatch; harness-tested (107 checks) and **qualified live
on the disposable show (47/47)**, including an executor reassigned during a hold and a restart with the stuck record. The
NX-K surface path is not qualified (mtpnxk has not vendored 0.8.0). **KB-14 implemented on 2026-10-09** (hardkeys 0.9.0, bridge
0.11.0): the `type` and `shortcutOrType` text routes and the temporary enable of `shortcut` run through a bounded, readback-verified
change of the operator's keyboard-shortcut mode that is kept through the hold, restored by the loop after the last dependent event and
never written over a state the operator changed meanwhile (unresolved restorations block input until recovery); the bridge gained
`input.routing` / `input.route`; harness-tested (98 + 21 bridge checks) and **qualified live on the disposable show (32/32, plus the
11/11 consumption-order probe behind the restore delay)**. Profile switches, failed restores and the kept restoration across a restart
are harness-only. **KB-15 implemented in the shared module and bridge on 2026-10-09** (hardkeys 0.10.0, bridge 0.12.0): the
mixed backend serves the `quickkey` default and per-key `shortcut`/`shortcutOrType`/`type` overrides on one instance, each
record is released and recovered through the part that pressed it, an unavailable Quickey route never falls back to
`Keyboard()`, and every combination whose console semantics are not qualified (both kinds down at once, a Quickey under a
temporary shortcut-mode change, a mode change while a Quickey is down) is refused before dispatch on every backend;
harness-tested (67 + 11 bridge checks). The surface defaults, its startup/status reporting, the vendoring of 0.10.0 and the
live qualification of the surface path are the mtpnxk side of KB-15 and are not done here; no new console path is
qualified by this change (the mixed backend has not run on the console).

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
*Deviation (recorded 2026-10-09):* the probes ran as diagnostic `gma3_lua` chunks through the existing bridge
and as the reproducible `scripts/kb01-probe.mjs`, not as a separate probe plugin. No production code changed;
the script requires Lua to be enabled and a disposable show.

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
5. Probe feedback properties. Validate the chosen module loader and show portability in KB-02.

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
- Quickey actuation is a go/no-go gate only for a future Quickey backend, not KB-01 completion or the
  initial keyboard backend. Defer it without adding OSC or allocating show resources.
- Include manual recovery instructions for every hold test and for an unresponsive plugin.
- Save probe evidence and update this design with the confirmed API contracts before KB-02–KB-04.

### KB-01 results — confirmed contracts and platform scope

Reviewed the checked-in reports and probe script; these live tests were not independently rerun in this
review. The [probe guide](docs/probes/README.md) and [script](scripts/kb01-probe.mjs) reproduce the automated
subset and describe manual checks. This is opt-in live evidence, not console-free CI regression coverage.

| Evidence | Coverage |
| --- | --- |
| [macOS record](docs/probes/kb-01-macos-2.5.1.md), [JSON report](docs/probes/kb-01-macos-2.5.1.json) | 26/26 automated checks; manual long-press/text and hardware Shift checks; two-display routing and exploratory remap/disable probes |
| [Windows record](docs/probes/kb-01-windows-2.5.1.md), JSON reports for [one](docs/probes/kb-01-windows-2.5.1.json) and [two displays](docs/probes/kb-01-windows-2.5.1-2displays.json) | 26/26 automated checks in each run; manual long-press/text and hardware Shift checks; two-display key/text/Escape routing and pop-up placement checks |

Both used onPC 2.5.1.0 and a US layout. Non-US layouts, Windows remap/disable-during-hold behavior, and other releases remain unverified. Apply the conservative release policy on both
platforms; do not describe macOS-only exploratory observations as Windows validation.

**Input backend (`Keyboard()`):**

- `Keyboard()` emulates a **PC keyboard**, not MA hardkeys. `keycode` is a case-sensitive `Enums.KeyboardCodes`
  name (`Enter`, `Escape`, `S`, `F1`, `5`). No direct `Enums.VirtualKeyCode` (MA key) input function
  was found in the inspected live descriptor.
- PC keys become MA keys through the operator-editable **UserProfile KeyboardShortcut table** (default: Enter→PLEASE,
  Escape→ESC, Delete→CLEAR, Backspace/Ctrl+Z→OOPS, S→STORE, digits→NUM, Ctrl/Alt+F-keys→EXEC with `ExecutorIndex`)
  and the system `Root().VirtualKeys` definitions. MA1/MA2 have no shortcut entry; the PC **Shift keys are the
  MA key** natively (follow-up F2–F4), observable as `Root().MASTATE`.
- With shortcuts enabled, `char` inserted text in the focused editor but not the ordinary command line;
  Backspace edited that field instead of acting as OOPS. With shortcuts disabled, `char` also inserted
  command-line text and Enter executed it. Text routing depends on both focus and shortcut enablement.
- Ctrl/Alt shortcut modifiers are per-event arguments; a held `LeftCtrl` key is not combined. MA is the
  distinct held Shift-key behavior below, not the shift flag. **A release must repeat the
  press's modifier arguments**, otherwise it targets a different shortcut and the hold persists.
- Invalid display index, event type and keycode are **accepted silently**. All validation is the bridge's job.
- `display_index` had **no observed routing effect** in the two-display tests on both platforms
  (macOS run 3; Windows run 2, M1–M4). Character events sent with indexes 1, 2 and 9 reached the
  focused Display 2 editor; Escape via index 1 closed it; Store held via index 2 opened its pop-up on
  Display 1. Input must not be advertised as display-targeted on the tested 2.5.1.0 configurations.
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
  executors mapped in the profile table (macOS exploratory test; not repeated on Windows).

**Design decisions taken from these results (2026-10-09):**

- `hardkey` accepts MA key names (PLEASE, STORE, …). The bridge resolves each to a PC key + modifiers from the live
  shortcut table when admitting a new press/interaction, with validated native routes for logical MA
  and PLEASE where applicable. Unresolved routes are unsupported. A
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
A hold made through a shortcut that was then remapped, or held while shortcuts were disabled (F10), is not
released by its stored tuple (follow-up F12–F13): restore the original mapping or re-enable shortcuts, then
release with the stored tuple and confirm the effect. Physical Shift press/release ended an injected
Shift hold in run 3 (H1–H2); this does not establish physical-key recovery for a remapped executor.
Mapping restoration is an explicit operator action, not automatic bridge behavior.

### Remaining qualification and scope decisions

- **First backend:** `Keyboard()` through existing shortcuts and validated native routes (MA/PLEASE).
  No MA mapping is needed for the proven logical `MA` capability. It creates no shortcut,
  VirtualKey, Quickey, page or executor objects. Capability is conditional on profile, display and focus.
- **MA:** decided — logical `MA` via the `LeftShift` key with `MASTATE` verification; MA1/MA2 individually
  unsupported (see design decisions above). Evidence: the PC Shift keys are the MA key natively (MA manual;
  holding `LeftShift` or `RightShift` sets `Root().MASTATE` and turns `S` into `Record`); both feed one MA
  state; the shift *flag* argument does not produce MA.
- **Quickeys (go/no-go verdict: no-go for this phase):** the Quickey backend is **unsupported** until a
  separate probe proves non-OSC down/up of a Quickey assigned to a mapped executor, including an MA hold.
  It is not needed for this phase: MA comes from the Shift keys, and executor down/up through executor
  shortcuts (`ExecutorIndex`) is already a proven non-OSC hold mechanism. Mapped executor Flash down/up is
  proven; a Quickey is not. Bridge-owned shortcuts require a separate opt-in design and are outside this phase.
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
  in both directions match macOS; injected input reached onPC with another app in the OS foreground. With two
  displays `display_index` again had no observed effect (pop-up via index 2 on Display 1). The other
  exploratory follow-ups above were not repeated on Windows.
- **Open probes:** non-US keyboard layouts. Module loading/show portability was closed by KB-02 (macOS; Windows not exercised).
  Do not infer these from basic shortcut success.
- **Side effect resolved:** `PRESERVEGRIDPOSITIONS` false→true was reproduced as a result of the cleanup
  command `Unassign Page 1.101` (parsed as `Fixture "Unassign" Page 1.101`), not keyboard input; restored.
- **Freeze:** unavailable after empty-selection, with-selection and `Freeze On` probes plus a deep property
  search. This does not prove no getter exists. No false/zero fallback is permitted.
- **Evidence limits:** retain operator/profile/display identity, mapping and focus preconditions with
  test results. The live script now supplies a reproducible subset; add console-free implementation
  regressions and failure-path coverage in KB-03–KB-05.
- **Probe harness limits:** the current `restored` flag checks selected final fields, not full state
  equivalence (initial selection is not restored or compared). Only `auto` checks the disposable-show
  name; manual modes do not. There is no guaranteed cleanup after an exception/disconnect. Treat the
  script as an operator-supervised disposable-show probe, not a safe unattended regression runner.
  Before promoting it to release regression coverage, enforce fixture/state preconditions and the
  show guard for every mutating mode, compare claimed restored fields, and exercise failure cleanup.

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

### KB-02 results (macOS, onPC 2.5.1.0, 2026-10-09)

Evidence: [docs/probes/kb-02-loading-macos-2.5.1.md](docs/probes/kb-02-loading-macos-2.5.1.md); contract and
API: [docs/modules.md](docs/modules.md). Modules: `plugin/gma3_mcp_hardkeys.lua` (input lifecycle, backend
registry, read-only key resolution) and `plugin/gma3_mcp_feedback.lua` (read-only readers), module API 1,
version 0.1.0, shipped as extra `ComponentLua` entries of `gma3_mcp_bridge.xml` (bridge 0.4.0; hardkeys is 0.2.0 in bridge 0.5.0, KB-03).

**Loader decision.** The console runs every component chunk at import and show load with
`(pluginName, componentName, signalTable, handle)` and hands all components of one plugin the same
`signalTable`; a module chunk registers its read-only table there and the entry component looks it up in
`Main`. Rejected after live probes: `require` (searches loose library files only, one stale cache for every
plugin, fails without the loose file), reading a sibling component's `FileContent` (capped at ~1 KB) and
`Export` (returns false). The source is stored in the show (`FullPath = <Showfile>`), so no loose file is
needed after import.

**Verified live:** initial import; update by delete/re-import/`ReloadAllPlugins`/start (run from a Macro so
the stopped bridge restarts without typing); stop/start with fresh instances; `ping.modules` and the read-only
`modules` op; every feedback reader (freeze reported unavailable); key resolution for the default profile
(MA1/MA2 and unmapped EXEC reported unsupported); a separate consumer plugin vendoring the same two files got
its own module tables and instances, and a hold recorded on its instance was invisible to the bridge's.
Loading touched no socket, timer, show object or key: the chunks only build tables, and the harnesses load
the modules with no console API present. `ReloadAllPlugins` did not re-run idle show-embedded chunks and
preserved `_G`.

**Save/reload:** the show was saved from the Backup window, the bridge stopped, all four plugin files deleted
from the library folder, the show loaded and the bridge started: `node scripts/kb02-probe.mjs verify` passed,
and a marker placed on the previous module copy was gone after a second load (fresh chunks from the show,
nothing reused). `_G` survives `LoadShow` while chunks re-run. **Not exercised:** Windows and a physically
separate machine; non-US layouts remain unverified (KB-01). `SaveShow`/`LoadShow` must not be sent through
the bridge (`SaveShow` treats the next token as a file name and stalls the plugin thread on its dialog).

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
  observable: macOS probes establish that remapping or disabling shortcuts can prevent stored-tuple
  release. Never discard the ownership record merely because a release call returned without error.
- Deduplicate ownership by resolved input tuple as well as logical key, so aliases cannot create two
  owners of the same injected key. Lease renewal must not inject another press.
- On profile/mapping/shortcut-enable changes during a hold, stop new interaction events and enter an
  unresolved-release state if cleanup cannot be established. Block conflicting new presses and report
  the original route and current mismatch. Do not automatically restore mappings or toggle shortcuts.
  An operator may restore the original route/enablement and request owner-scoped release recovery.
  Test remap, disable, profile switch and disconnect during recovery; do not silently expire the record.
- Display IDs are not separate ownership domains on this backend. Reject conflicting owners across
  display IDs and raw/logical aliases. No per-display lock can isolate these globally routed events.
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
- Document and test the confirmed cross-source behavior: a synthetic Shift release can end a physical
  hold and a physical release can end a synthetic hold. A cleared `MASTATE` must not trigger automatic
  re-press while an ownership record remains; stop/reconcile the interaction instead of fighting input.
  Internal ownership tracks responsibility for recovery, not exclusive console key state.
- Status distinguishes owned/tracked state, dispatched releases and observed console state. It includes
  owner, remaining lease, backend and unresolved cleanup failures without claiming physical key state.
- Document recovery limitations when onPC or a host API blocks; do not describe expiry as guaranteed
  cancellation of a host call.

### KB-03 results (fake backend; macOS, onPC 2.5.1.0, 2026-10-09)

Implementation: `plugin/gma3_mcp_hardkeys.lua` 0.2.0 (sessions, leases, stored tuples/routes, deadline
servicing, recovery, `fakeBackend()`), bridge 0.5.0 (`input=fake|off` per start, connection-bound `input.*`
ops, `input status` / `input recover` operator actions, records kept across runs). Contract:
[docs/modules.md](docs/modules.md#owned-input-sessions-gma3_mcp_hardkeys-020-kb-03); protocol:
[docs/reference.md](docs/reference.md#owned-input-sessions-plugin-v050-kb-03); evidence:
[docs/probes/kb-03-fake-macos-2.5.1.md](docs/probes/kb-03-fake-macos-2.5.1.md).

**Decisions.** The ownership identity is the PC key plus modifier tuple; display and logical name are not
part of it, so `MA`/`LeftShift` and cross-display presses conflict as one key. A duplicate press by the owner
injects nothing; a conflicting owner is rejected before dispatch. Lease renewal only moves the deadline.
Release always uses the stored tuple; the route is rechecked before every release and before every new
press, and a remap, disabled shortcut table or profile switch during a hold stops new events for every
session and turns an unconfirmable release into an **unresolved** record. Unresolved records keep their
tuple blocked, are never retried by `service()`, are handed back by `dispose()`, survive a bridge restart
(the next start adopts them before admitting input, so their keys stay reserved) and are cleared only by
`recover()` (owner scope over the network, all scopes from the console command line). Lease admission and
renewal compare the current time with the expiry themselves, so enforcement does not depend on how recently
the loop serviced the instance, and a lease missed by `service()` still gets its cleanup. A module that
raises in `service()` is detached only after input is disabled, held keys got a release attempt and the
unresolved records were kept. `status` calls perform no cleanup. A physically released key is observed and annotated, never
re-pressed. Deadline servicing is bounded per loop iteration (`maxWorkPerService`) and runs before client
I/O, so a flooding client cannot starve it. The `keyboard` adapter has no dispatch yet: `input=keyboard` is
refused with a KB-04 pointer, and `enableInput()` refuses any adapter without dispatch.

**Verified by harness** (`npm test`, 484 Lua checks across the three harnesses): everything above, plus
capacity, unsupported codes (MA1/MA2, unmapped EXEC, inactive shortcuts, backend key set), release
ordering (newest first), disconnect/stop/disable/dispose paths with failing releases, adopt/recover across
instances, and a server-loop run with a flooding client while a tap deadline is serviced.

**Verified live** (bridge 0.5.0 on the fake backend, 33/33 probe steps over two real connections): session
binding, conflicts and aliases, a 200 ms tap released by the loop after 201 ms, failed release → unresolved →
owner recover, a 3 s lease expiring on the loop, physical release observed without re-press, disconnect
cleanup; and from macros, `input=off`/`input=fake` at runtime, `input status` releasing nothing, and a hold
whose release failed at `stop` kept as a record across the restart and released by `input recover`.

**Not exercised / limitations.** No console key was pressed (fake backend). Windows and a separate machine
remain KB-02 qualification gaps. A blocked host call or a dead plugin thread still prevents any release;
expiry is an attempt, not a cancellation.

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
- Resolve shortcut-backed MA key names through live profile shortcuts and validate the actual `Enums.KeyboardCodes`
  name, modifier tuple, display and mapping scope before a new press. Distinguish executors by
  `ExecutorIndex`/`SpecialExec`; `EXEC` alone is not a unique target. Define deterministic handling of
  multiple mappings and reject ambiguity rather than guessing. Admit shortcut-backed actions only
  while `KEYBOARDSHORTCUTSACTIVE` and their mappings match the validated route; reject otherwise.
- Treat native routes separately: logical MA uses the Shift key; PLEASE may use the verified Enter
  redirect even with shortcuts disabled. Validate the applicable route rather than requiring every
  logical key to appear in the shortcut table. Never toggle F10 automatically to make an action work.
- Inspect mapping data without modifying it. Revalidate on profile/configuration changes. Preflight every
  requested key in a combination before dispatching its first event.
- Implement logical `MA` as a `LeftShift` key event pair (not the shift flag), independent of the shortcut
  table, and verify with bounded `MASTATE` readback. Report MA1 and MA2 as unsupported. Track MA ownership
  like any other held key. `MASTATE` is aggregate: another Shift key can keep it true, so it cannot
  establish which source/key remains held. After release, report dispatch and aggregate readback
  separately; do not infer either confirmed per-key release or definite failure from that bit alone.
- Pass PC modifiers explicitly on every press and release. Pressing `LeftCtrl` and then a plain key
  is not an implementation of Ctrl+key. The shift flag is a PC modifier, not MA.
- Validate configured display and key codes. Invalid arguments can be silently ignored by onPC, so
  a no-error return is not validation. Because `display_index` does not route input on 2.5.1, accept only an
  existing display, report input as not display-scoped, and never promise per-display focus or pop-up
  placement. This requirement applies to both macOS and Windows. A display argument is API context,
  not an input destination; reject requests that require routing to that display rather than silently
  accepting an unmet targeting constraint. Do not use input events to detect capabilities.
- Timed taps schedule their release through periodic servicing. Define whether the response means
  scheduled, dispatched or completed; do not report completion before the release is attempted.
- An intended long-press is uninterrupted: reject conflicting events during it and do not forward
  duplicate presses. A sequence that intentionally adds another key has different semantics and
  cannot promise the long-press pop-up. External operator activity remains outside these guarantees.
- Keep double-press unsupported until its inter-event timing and effect are proven; two taps in one
  handler are not established as a double-press. Make any later timing policy bounded and explicit.
- Validate the initial backend's same-key repetition, MA combinations, raw/logical alias conflicts,
  cross-display ownership, disabled shortcuts and cleanup failures with automated and live tests.

### KB-04 results (keyboard backend; macOS, onPC 2.5.1.0, 2026-10-09)

Implementation: `plugin/gma3_mcp_hardkeys.lua` 0.3.0 (`keyboardBackend(deps)`, native PLEASE route, backend-origin
records, `attachBackend()`, bounded MASTATE readback, exclusive holds, `combo()`), bridge 0.6.0 (`input=keyboard`,
`input.combo`, `exclusive` on `input.press`/`input.tap`, cleanup-only attach in `input recover`). Contract:
[docs/modules.md](docs/modules.md#keyboard-backend-gma3_mcp_hardkeys-030-kb-04); protocol:
[docs/reference.md](docs/reference.md#owned-input-sessions-plugin-v050-kb-03); evidence:
[docs/probes/kb-04-keyboard-macos-2.5.1.md](docs/probes/kb-04-keyboard-macos-2.5.1.md).

**Decisions.** The adapter stays small: it validates what onPC would accept silently (the `Keyboard` function,
the `Enums.KeyboardCodes` name, the display, MASTATE readability for MA), passes every modifier explicitly on every
press and release, and observes aggregate state; ownership, leases, deadlines and recovery remain in the KB-03
lifecycle. **Release results** are `confirmed` (backend observed the key up; fake only), `dispatched` (call returned,
no per-key observation; every `Keyboard()` release) or `unresolved`. Aggregate `MASTATE` is never turned into a per-key
state: after an MA press/release the module performs a bounded readback (`readbackMs`, default 1 s) and reports
`observed` / `inconclusive` next to the dispatch, never changing the hold's state; MASTATE false during a hold is the
one sound inference (no Shift key is down) and is annotated, never re-pressed. **Routes**: shortcut-backed keys need
`KEYBOARDSHORTCUTSACTIVE` and their validated row; `MA` is the fixed `LeftShift` route; `PLEASE` is a native route
(`Enter`, the system VirtualKey redirect, admitted with shortcuts disabled too) that is rejected as ambiguous when a
shortcut row claims plain `Enter` for another key or the readable redirect no longer names `Enter`. Several rows with the
same shortcut text and target are one route; different shortcuts with equal modifier count are ambiguous and rejected; a
tuple that another row maps to a different target (another MA key, or the same EXEC key with another executor identity)
is a collision and rejected, so a requested key never dispatches an action that may be another one. Shortcut names
outside `Enums.KeyboardCodes` are unsupported. Shortcut enablement must read as a positive boolean: unreadable
enablement refuses new shortcut-backed presses and keeps a release unresolved. A profile switch (or an unreadable
profile identity) is a route change for shortcut-table routes only.
**Combinations** (`combo`) preflight every key (resolution, routes, ownership, capacity, exclusivity, backend) before the
first event; a press failing midway releases what was pressed and reports it. **Exclusive** holds (the intended
long-press) refuse every new press from every session, including the owner's duplicate and an injected `F10`, until
their release is resolved (an unresolved exclusive record keeps the lock, also across a restart); they are refused while
any other record exists; releases stay allowed. Double-press stays unsupported.
**Records carry their backend**; a record is only released through the backend that pressed it, so a fake record can
never become a real `Keyboard()` event. `input recover` on an instance without a backend attaches the records' own backend
for cleanup only (`attachBackend`); admitting new presses remains the separate `input=keyboard` decision. A refused
backend switch leaves the previous input policy intact.

**Verified by harness** (`npm test`: 72 + 218 + 296 Lua checks plus the probe guard tests): the adapter's argument passing,
pre-dispatch refusals, raising `Keyboard()` kept as unresolved, missing `Keyboard`/unreadable MASTATE, native PLEASE with
shortcuts off and its ambiguity cases, readback outcomes on both backends, exclusive rejection matrix, combo preflight and
rollback, backend-origin refusals, cleanup-only attach, and the bridge paths (`input=keyboard`, refused switches, `input.combo`,
operator recover attaching keyboard/fake for cleanup).

**Verified live** (macOS, 47/47 + 12/12): tap `NUM5` → `5` on the command line; native PLEASE; `MA+STORE` combo → `Record`
with MASTATE readback true/false; 1.2 s exclusive STORE long-press rejecting the owner's duplicate, another session and a
combo; remap `S→T` and `F10` during a hold → `route-changed`, unresolved stored-tuple release, recovery after the operator
restored the route; disconnect releasing MA; a remapped hold kept across a restart with input disabled, keyboard backend
attached for cleanup only, released by `input recover` after the restore. Effects landed 18–73 ms after the call.

**Not exercised / limitations.** Windows, a separate machine, non-US layouts, a second display. The Store Settings pop-up
cannot be read back (only `cmdtext = "Store "`). A `Keyboard()` call that raises or blocks on the real console was only
stubbed. Injected and physical input still share one key state; expiry remains an attempt, not a cancellation.

### Deferred Quickey research — not an initial-release requirement

Logical MA and the mapped-key backend do not require Quickeys. The criteria below apply only if a future
request establishes a missing capability and explicitly opts into resource allocation. KB-05–KB-08
must not depend on completing this research.

- First test a Quickey assigned to a mapped executor with matching
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

**Protocol surface (implemented as MCP tools `gma3_<name>`; see [docs/tools/input.md](docs/tools/input.md)):**

| Operation | Purpose |
| --- | --- |
| `hardkey` | Logical MA key resolved through a validated existing shortcut (or `MA` via `LeftShift`); `press`, `release` or bounded `tap`; 2–4 key combinations |
| `keyboard` | Explicit PC key plus per-event modifiers; profile/focus-dependent, with the same gate, ownership and validation |
| `type` | Unicode character events with explicit text-field or shortcut-disabled command-line context; never implicit execution |
| `hardkeys_status` | Capability, enablement, backend, owners, held records, interactions, sequence, capacity and cleanup status |
| `hardkeys_release_all` | Release keys owned by the caller; recovery remains available while input is disabled |
| `input_sequence` | Bounded ordered presses, releases, taps, combos, text and waits under one interaction owner |
| `input_interaction` | Acquire, renew or end the explicit lease a standalone hold needs across calls |

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
- Give `type` an explicit intended context: focused text field, or command line with shortcuts already
  disabled by the operator. Command-line text with shortcuts enabled is unsupported by this `char`
  route. Validate/read back shortcut enablement and observable focus; do not silently toggle shortcuts,
  focus a field, open an editor, substitute keycodes or execute the text through `Cmd()`.
- Keep text insertion separate from PLEASE/Enter. Reject embedded execution/control characters under
  the documented text policy; committing input requires a distinct explicit action. Recheck context
  between serviced text chunks and stop with partial/unknown progress when it changes.
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

### KB-05 results (structured input; macOS, onPC 2.5.1.0, 2026-10-09)

Implementation: `plugin/gma3_mcp_hardkeys.lua` 0.4.0 (`beginInteraction`/`renewInteraction`/`endInteraction`,
`admission()`, `char()` on both adapters, `validateText()`, `startSequence`/`sequenceStatus`/`abortSequence`
serviced by `service()`), bridge 0.7.0 (`input.begin`/`extend`/`end`, `input.sequence`/`.status`/`.abort`,
`interaction` on press/tap/combo, the `[busy]` guard on `cmd`/`set`/`setfader`/`lua`, structured error replies with
`code`/`detail`), `src/tools/input.ts` (the seven tools above; `BridgeError.code`/`detail` in `src/bridge.ts`).
Contract: [docs/modules.md](docs/modules.md#interactions-text-and-sequences-gma3_mcp_hardkeys-040-kb-05); protocol:
[docs/reference.md](docs/reference.md#interactions-admission-text-and-sequences-plugin-v070-kb-05); tools:
[docs/tools/input.md](docs/tools/input.md); evidence: [docs/probes/kb-05-input-macos-2.5.1.md](docs/probes/kb-05-input-macos-2.5.1.md).

**Decisions.** *Session contract:* the KB-03 session stays bound to the TCP connection; on top of it an
**interaction** is a leased token (`i1`, default 15 s, max 120 s, renewable) of one session. A standalone hold
(press, combo without `holdMs`) needs one and its id on every call; while one is open every call of its own session
must carry the id, so MCP callers sharing the server's connection cannot act on each other's holds by accident.
Bounded taps, chord taps, text and sequences run without an explicit interaction and own one for their duration.
Interactions are never resumed: after end, expiry, disconnect or restart the id is refused; the server reopens its
session lazily after a reconnect and replays nothing. *Admission:* the module reports itself busy while an interaction
is open, a sequence runs or any key is held (of any session); the bridge then refuses `cmd`, `set`, `setfader` and
`lua` from **every** connection with `[busy]` naming the owner, instead of delaying them into a changed context. Reads,
`input.status`, sequence status, `stop` and the owner's release/recover/end/close are never guarded. An unresolved
record keeps the bridge busy too (the key may still be down, so the keyboard state is uncertain), including after a
start that adopted records from a previous run, until recovery resolves it (review finding, 2026-10-09).
The module keeps a `requireInteraction=false` policy for single-caller consumers (a surface plugin), which restores
the KB-03 per-session rules; the bridge always uses the strict policy. *Text:* UTF-8 by code point, 256 characters,
newline/CR/tab/C0/C1/DEL/U+2028/U+2029 refused, nothing normalised, never an Enter; `command-line` needs
`KEYBOARDSHORTCUTSACTIVE` read as false (refused, never toggled, when true or unreadable) and is read back from
`CmdObj().cmdtext` within the readback window: `observed` completes the step, `inconclusive` leaves it uncertain and
stops the sequence so a later PLEASE never commits unseen text; `text-field` reports verification unavailable and may
not be followed by PLEASE/Enter in the same sequence. Every text step needs the caller's `acknowledgeFocus` (which
element receives characters is not observable). Text is refused while an exclusive hold or a route mismatch exists.
Typing goes out 8 characters per loop iteration with the enablement, exclusive hold and routes rechecked between
chunks; a change stops it with the typed count (uncertain). Hold durations and flags of every key, combo constituents
included, are validated in the sequence preflight, so an invalid request dispatches nothing (review findings, 2026-10-09). *Sequences:* validated as a
whole before the first event, then one step per loop iteration (a tap waits for its release to resolve), events end
`completed`/`failed`/`uncertain`/`unattempted`/`aborted`, a failure releases what the sequence pressed and ends the
interaction begun for it; one sequence per instance; a TypeScript wait that runs out reports `unknown` and never
resends. *Transport:* module errors travel as tables; the reply carries `code` and `detail` (a combo's pressed keys and
rollback, a busy owner, an unresolved hold) and the tools turn "pressed something before failing" into `unknown`.

**Verified by harness** (`npm test`: 78 + 340 + 340 Lua checks, `input.test.ts`, registration, probe guard tests):
two competing connections (`[busy]` for the other connection's taps, sequences and commands, `not-owner` for its
interaction id), shared-connection ownership (`[busy]` "pass its id" for the owner without the id), disconnect
mid-sequence (in-flight tap released by the session close, step aborted, rest unattempted, nothing resumed),
focus/context change during text (shortcuts toggled between chunks: `context-changed` with 8 of 20 typed), Unicode
and control characters (one event per code point incl. U+1F600; newline, tab, DEL, C1, U+2028 refused), cleanup while
input is disabled (`input=off` ends interactions and releases holds; begin/sequence refused, end/status/releaseAll/
recover available), expiry and lazy expiry, raised press/char kept uncertain, inconclusive readback, lease-too-short,
owner abort, the existing tools and default startup unchanged with input disabled and `gma3_lua` hidden. Arbitrary Lua
stays disabled in the normal-path tests (the `lua` op only appears to prove it is guarded).

**Verified live** (macOS, bridge 0.7.0 on the keyboard backend, 44/44 over two real connections, rerun after the review fixes): an acquired
interaction makes `cmd` and `lua` from both connections and the other connection's tap `[busy]` naming the owner, a hold
without the id is `[busy]` ("pass its id"), the hold with it put `Store ` on the command line, `extend` and `end` work and
the ended id is `[no-interaction]`; a two-tap sequence (`51`) and the `MA+STORE` chord sequence (`Record `, MASTATE false
afterwards) serviced by the loop; command-line text refused while shortcuts were enabled, then `Fixture 5` and
`abü€😀` typed one code point per event with shortcuts disabled and read back from `cmdtext` with `lastcommand`
unchanged (inserted, never executed), Escape discarding it; text without the focus acknowledgment and a sequence with an
invalid `maxHoldMs` on a later step refused with nothing dispatched; and a disconnect in the middle of a 3 s `STORE` tap releasing
the key and leaving the sequence `aborted` with the rest unattempted. Effects landed within 14–17 ms. Because the guard
covers `lua`, verification reads must follow the end of the interaction or sequence under test.

**Not exercised / limitations.** Text into a focused text field (acknowledged, not readable), an explicit interaction
expiring with a key down on the console (harness only), Windows, a second display, non-US layouts. Focus is not
observable, pop-ups are not readable, `display` routes nothing, and the busy guard cannot isolate a physical operator or
another plugin.

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
  Add aggregate `Root().MASTATE` and profile `KeyboardShortCuts.KEYBOARDSHORTCUTSACTIVE` for input
  admission/status. Neither aggregate MA state nor a display's Preview bar establishes event ownership
  or guarantees that injected input will route to that display.
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

### KB-06 results (feedback readers; macOS, onPC 2.5.1.0, 2026-10-09)

Implementation: `plugin/gma3_mcp_feedback.lua` 0.2.0 (strict `toBool`, `previewBar` per validated display,
`sequenceActive` with the `executorActive` alias, new `executor`, `fader` and `selectedSequence` readers, `readMany`,
`itemsFor`, `watch`/`service`/`snapshot`, `invalidate`, identity-driven epochs), bridge 0.8.0 (`feedback.describe`,
`feedback.read`, never guarded), `src/tools/feedback.ts` (`gma3_feedback`). Contract:
[docs/modules.md](docs/modules.md#feedback-readers-gma3_mcp_feedback-020-kb-06); protocol:
[docs/reference.md](docs/reference.md#console-feedback-plugin-v080-kb-06); tool and surface mapping:
[docs/tools/feedback.md](docs/tools/feedback.md); evidence: [docs/probes/kb-06-feedback-macos-2.5.1.md](docs/probes/kb-06-feedback-macos-2.5.1.md).

**Decisions.** *Response contract:* every observation carries `available`, `scope`, `source`, `observedAt` (consumer
clock at that read) and `epoch`; `available=false` carries a `reason` (nil, an unrecognised value, a missing
display/sequence/executor, an unimplemented reader) or an `error` (the reader raised) and no value, so `false` and
"unknown" are distinct and one failed reader never invalidates the others. Multiple items are read one after another
and the reply says `atomic=false`. *Readers tightened:* unrecognised property values are unavailable instead of passed
through; `previewBar` takes a validated display (default 1) and identifies it in the result; the 0.1.0 `executorActive`
is renamed `sequenceActive` (sequence playback activity, not a button) with the old name kept as a deprecated alias
that says what it read. *Separation:* `executor` (assignment on the user's current page, via `GetExecutor`),
`fader` (master level of the assigned object or a sequence, via `GetFader`/`GetFaderText`, the same calls as the
`getfader`/`executors` ops), `sequenceActive` (`HasActivePlayback`), `selectedSequence` (`SelectedSequence()`) and
button ownership (the hardkeys record, not console state) are separate readers that are never merged. Freeze stays
unavailable. *Freshness:* the module observes the show file, user and profile identity (at most once per second) and
bumps its epoch on a change (`show-changed`, `user-changed`, `profile-changed`), dropping cached observations; an identity that
becomes unreadable keeps its last known value, invalidates once and marks observations stale until it is readable again
(review finding, 2026-10-09: an A → unreadable → B transition must neither hide the change nor serve A's values); the consumer
can `invalidate()` on disconnect or restart; the bridge starts a fresh instance per run. A malformed item is reported
unavailable without aborting the batch, and a raising executor `Object` read is an error, never an empty executor (review
findings, 2026-10-09). *Bounded polling:* `watch()` a
requested subset, `service()` reads at most 8 due items per loop iteration (round robin, 100 ms interval), `snapshot()`
reports `ageMs`/`stale` and lists items not observed since the current epoch instead of showing old values; `readMany`
is capped at 64 items and 32 executors/sequences per request. *Read-only access:* the bridge op is not in the guarded
set, needs neither Lua nor input, opens no session and touches no console state; `lastcommand` and `MASTATE` are
documented as observations only. *Surface mapping:* written from the reader results in
[docs/tools/feedback.md](docs/tools/feedback.md#mapping-to-the-mtpnxk-surface-feedback-schema); the external
`mtpnxk-client-pico/docs/ma3-feedback.md` was not available in this workspace and the mapping must be reconciled
against it before KB-07. LED colours, blinking and device messages stay in the consumer.

**Verified by harness** (`npm test`: 132 module checks, 362 bridge checks, `feedback.test.ts`, `kb06-probe.test.ts`,
registration): unrecognised/nil/malformed values (unavailable with reasons, never false or zero), per-display results
including a missing display and a raising display, partial failures inside one request, request expansion and the
executor bound, the alias, identity changes (show, user, profile) bumping the epoch with unreadable identity never
counting as a change, stale cache reporting, bounded per-service work with round robin, invalidation dropping cached
values, the bridge ops with Lua and input disabled and while another connection owns an interaction, `[no-items]` and
`[no-feedback]`, and the TypeScript wrapper's null-filling, validation and error wording.

**Verified live** (macOS, bridge 0.8.0, 47/47 over two real connections): all parameterless readers in 19 ms with
display 9 unavailable (display 2 exists to the API on a one-monitor onPC), executors 191–196 with assignment and fader
plus empty executor 190, 40 executors bounded to 32 in 52–60 ms, the command line and `ping.input` unchanged by reads,
`feedback.read` answering while the other connection's interaction made `cmd` and `lua` `[busy]`, and the readers
following real changes: `Blind Off`/`On`, a fader moved to 25 % and back (observed 150 ms later, while `setfader`'s own
same-frame read-back still showed the old value), `Go+`/`Off` of sequence 5527.

**Not exercised / limitations.** Show load, user switch or profile switch on the live console (harness only), a second
physical display, Windows, cross-user scopes, the cached `watch()`/`snapshot()` path live (surface consumers). Reads
are not display-routing evidence, not an atomic snapshot and never confirmation that a particular request or key
source produced an observation.

### Module change for KB-07 (hardkeys 0.5.0, 2026-10-09)

The surface consumer's keys (Edit, Copy, Highlight, …) go beyond the fixed logical-key list. Rather than a
surface-side fork of key resolution, `resolve()`/`describeKey()` now accept **any `Enums.VirtualKeyCode` name
the console knows** and resolve it through the shortcut table under the same rules as `STORE` (fewest
modifiers, duplicate rows are one route, ties and collisions refused, `KEYBOARDSHORTCUTSACTIVE` required). The
fixed `MA` and native `PLEASE` routes are unchanged; `MA1`/`MA2` stay unsupported; a name the enum does not
know is unsupported with a reason. Regressions in `test/lua/modules_test.lua`. No bridge op changed (the
bridge's `hardkey` tool still validates its own key list in TypeScript). Vendored into mtpnxk as 0.5.0.

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

## KB-09 — Shortcut-table cache and operator-managed profile shortcuts

**Request:** As a surface user, I want each key event to cost the console less, and keys the default
profile does not map (Load, Macro, Thru on the NX-K) to become usable without the module guessing a route.

**Depends on:** KB-04, KB-07 (live findings of 2026-10-09, mtpnxk `docs/probes/kb-07-live-macos-2.5.1.md`).

**Lua changes: Yes** (hardkeys module). No new input dispatcher; one read-only report and, only if the
operator opts in per start, one explicitly confirmed shortcut-writing operation (part B).

**Evidence.** On onPC 2.5.1.0 (macOS) `describeKey()` costs about 7 ms: it reads the 157-row
`UserProfile.KeyboardShortCuts` table through `Ptr()`/`Get()` on every call. A press costs two reads
(`_planPress` resolution plus `_checkRoutes` over every live hold) and a release one, so a surface sending
20 taps/s (40 events/s) spends 400 ms of every second in table reads and the plugin loop falls from 58 Hz
to 4 Hz; 10 taps/s runs clean. Human keypad use stays below 5 events/s. Separately, the default profile has
no row for `LOAD`, `MACRO` and `THRU`, and maps `PLUS`, `MINUS`, `DOT` and `SLASH` twice (main row and
keypad), which the resolver refuses as ambiguous; the surface works around the latter by pressing the keypad
row as a raw PC key, which bypasses route rechecks.

### Part A — bounded cache of the shortcut rows

- Cache the parsed rows per instance for the duration of **one service iteration** (same `now` value passed
  to the call) by default, with an optional `routeCacheMs` (0 = per-iteration only; at most 100) for consumers
  whose loop runs faster than their frames. Every press, release and `_checkRoutes()` inside the window reuses
  the cached rows; `KEYBOARDSHORTCUTSACTIVE` and the profile identity are still read fresh on every admission
  and release (single property reads), and any change of either, or `invalidateRoutes()` from the consumer,
  drops the cache at once.
- The cache may only shorten the read, never the validation: resolution, tie, collision and enablement rules
  are unchanged; a remap is noticed no later than the end of the window. Document that a hold released within
  the same iteration as a remap may be released against the pre-remap rows; the following iteration reports the
  mismatch as today.
- Harness: count `shortcutRows` reads per press/release (two and one today → at most one per iteration);
  remap inside and outside the window; profile switch inside the window invalidates; `routeCacheMs` bound and
  validation. Live: the 20 taps/s bench from mtpnxk (`mtpnxk bench --taps 40 --rate 20`) must lose nothing with
  the plugin loop above 25 Hz, recorded in a probe file.
- Also resolve the duplicate-target ambiguity without guessing: when every tied candidate maps to the **same**
  VirtualKeyCode (and the same executor identity), the console's effect is the same whichever row fires, so the
  route is not ambiguous in effect. Prefer the row the consumer names (`opts.prefer = "kpAdd"`), else refuse as
  today. This removes the surface's raw-key workaround and restores route rechecks for `+ - . /`.

### Part B — operator-managed profile shortcuts for unmapped keys

- Read-only first: `describeKey()` of an unmapped key reports `missingRoute = { vk = "LOAD" }`, and a new
  pure helper `freeShortcuts(rows, candidates)` returns the candidate PC key names no row claims (any modifier
  combination), so a consumer can tell the operator "Load has no shortcut; F13, F14 … are free". The bridge
  exposes it through the existing read-only `modules`/status path; the surface plugin logs it at start.
- The module never creates, edits or deletes shortcut rows on its own (architecture rule). Writing is a
  separate, per-start opt-in (`shortcuts=write`) and a bridge op `shortcuts.add { key = "LOAD", pcKey = "F13",
  modifiers }` that: refuses while any hold or unresolved record exists; refuses a PC key any row already
  claims; creates exactly one row with the given tuple; re-resolves the logical key and reports the result;
  records the rows it created (show-scoped list) so `shortcuts.remove` can undo only those; and never touches
  rows it did not create. Row creation needs a live probe first (the console command or object call that adds
  a `KeyboardShortcut` row is unverified; KB-01 only edited an existing row with `Set KeyboardShortcut 33
  Property "ExecutorIndex" 102`).
- Acceptance: unmapped keys reported with free candidates; `shortcuts.add` refused without the opt-in, with
  holds present, for a claimed PC key, for an unknown VirtualKeyCode, and for `MA1`/`MA2`; after `add`, the key
  resolves through the normal shortcut-table route (no special casing) and `remove` restores the table;
  save/load of the show keeps the rows and the record; harness plus a live disposable-show probe. Document
  that a profile is per user and that the rows are show data the operator owns.

## Configurable hardkey dispatch and Quickey migration (KB-10–KB-15)

This sequence replaces the original KB-10 text-fallback proposal. Earlier KB-04/KB-05 restrictions
continue to govern their existing APIs; KB-14 introduces explicit new mode-changing methods rather than
silently changing those contracts. The CmdText and macro probes remain
valid evidence, but do not qualify Quickey dispatch. Implement a shared routing policy with these methods:

| Method | Behavior |
| --- | --- |
| `quickkey` | Activate the owned Quickey assigned to the logical key, without changing shortcut state. |
| `shortcutOrType` | Use an eligible mapped shortcut when shortcuts are enabled; otherwise insert explicitly configured text, temporarily disabling shortcuts if necessary. |
| `shortcut` | Resolve the mapped shortcut, temporarily enable shortcuts if necessary, dispatch it, and restore the original state. |
| `type` | Temporarily disable shortcuts if necessary, insert explicitly configured text, and restore the original state. |

`quickkey` is the public configuration spelling; **Quickey** is grandMA3's object terminology.
Quickeys become the surface default only after qualification and resource setup. Existing MCP tools and
module callers retain their behavior unless they explicitly select the new policy. Text insertion targets
the focused input; it is not equivalent to a hardkey action and never adds an implicit Please/Enter.
Explicit control keys such as Please retain their intended effects.

Provisioning, routing, dispatch and restoration belong in the reusable Lua module. Surfaces own configuration,
transport and physical-event bookkeeping; the MCP bridge owns tool exposure and client-facing validation.
Keep the existing benchmark and flood defects tracked independently: this migration does not close them.

## KB-10 — Qualify programmatic Quickey dispatch

**Request:** Establish a repeatable way to activate and release Quickeys from Lua before implementing the
production backend.

**Depends on:** KB-01–KB-05 input probes and lifecycle; KB-07/KB-08 surface evidence.

**Lua changes: Yes — probe code only initially.** Do not change production defaults. No MCP/TypeScript
changes should be needed for the probe.

### Acceptance criteria

- Enumerate the available Quickey codes on the tested console version. Record names, values, aliases and
  exclusions; do not assume a fixed count of 110.
- Establish exact Lua invocation for tap, press and release. Probe direct activation first. If executors
  are required, document their assignments, button functions and activation mechanism. Do not assume
  `Go+ Quickey` implements press/release merely because `Go+ Macro` worked.
- Test digits and Thru with shortcuts on and off; test Store hold/release, MA combinations, simultaneous
  keys, and release after interruption. Test Clear, Oops, Esc and Please separately.
- Test rapid digits followed immediately by Please without a manual delay. Record whether dispatch is
  synchronous, queued, latched, or dependent on focus/display.
- Exercise the command line, Edit Command and an independent popup field, including caret and selection
  behavior. Macro observations do not establish Quickey behavior.
- Release probe-held keys and clean up only probe-owned objects. Record final held/latched state.
- Publish revision, module hashes, platform, console version, profile, display and tested codes. Preserve
  the distinction between desktop-injected keyboard events and physical NX-K/hardware testing.

**Completion gate:** Implement only demonstrated capabilities. Tap-only success does not qualify holds or
chords. If reliable release is unavailable, do not replace the existing hold-capable backend.

## KB-11 — Shared per-key routing policy

**Request:** Let a consumer choose a default dispatch method and override it for individual logical keys.

**Depends on:** KB-10 for Quickey capabilities. Pure policy validation can proceed independently.

**Lua changes: Yes — shared hardkeys module.** The surface supplies configuration and consumes results;
it must not duplicate routing logic. MCP/TypeScript changes are needed only if exposing new bridge options
or tools; existing tool contracts remain unchanged.

### Acceptance criteria

- Support the four methods above, a consumer-level default and per-key overrides. Unknown or unavailable
  methods fail validation; they do not silently select another backend.
- Keep logical key identity, Quickey code, shortcut preference and literal text as distinct fields.
  Require explicit text mappings rather than deriving text from arbitrary key names.
- Digits map to one character without spaces. Keyword mappings specify exact separators. Do not provide
  automatic text mappings for MA, Please, Clear, Oops, Esc, executors or encoders.
- Report configured method, effective route, capabilities and unavailable requirements.
- Resolve and validate before dispatch; retain the chosen route for the entire press/release cycle.
- `shortcutOrType` uses a shortcut only when shortcut mode is positively enabled and resolution succeeds.
  A confirmed missing mapping may select text. Unreadable state, ambiguity, ownership conflicts,
  quarantine and other admission failures are refusals, not permission to type.
- When shortcut mode is positively off, `shortcutOrType` may select its explicit text mapping without
  requiring a shortcut row. If no text mapping exists, report unsupported.
- Once dispatch begins, exceptions or uncertain outcomes never trigger another backend automatically.
- Preserve input-enable, busy, ownership and recovery checks. A blocked press remains blocked for that
  press/release cycle; mode changes and retries do not resurrect it.
- Test configuration precedence, every selection branch, unsupported mappings, admission failures and
  route retention across configuration/mode changes. Existing callers retain their defaults.

### Module change for KB-11 (hardkeys 0.6.0, 2026-10-09)

Implemented in `plugin/gma3_mcp_hardkeys.lua` 0.6.0 with the regression harness
`test/lua/hardkeys_routing_test.lua` (137 checks on the fake backend; the earlier suites are unchanged and pass).
No bridge op, MCP tool or TypeScript contract changed; the bridge keeps the module default, so every existing
caller behaves as before (its holds now also report `method = "shortcut"`).

- **Policy.** `new({ routing = policy })` or `configureRouting(policy)` with
  `{ default = <method>, keys = { <LOGICAL> = { method, quickkey, prefer, text } } }`. Logical key, Quickey code,
  shortcut preference and literal text are distinct fields; `quickkey` defaults to the key name only at resolution
  time and is never inferred otherwise. Unknown methods, unknown fields, duplicate names, control characters,
  a digit mapping that is not exactly one non-space character, and any text for `MA`/`MA1`/`MA2`, `PLEASE`,
  `CLEAR`, `OOPS`/`UNDO`, `ESC`, `EXEC`/`EXECUTOR`/`XKEYS`/`FADER`, `X1`–`X16`, `ENCODER_*` and `DEF_*` fail
  validation. Keyword text is used exactly as given (`"Thru "` keeps its separator; nothing is trimmed or added).
  A refused policy changes nothing.
- **Precedence.** Per-key `method` > consumer `default` > module default `shortcut`; a call-level `spec.prefer`
  overrides the policy `prefer`. Raw `pcKey` specs bypass the policy.
- **Availability.** Adapters advertise `capabilities = { keyboard, quickkey = { tap, hold, chord }, char }`
  (an adapter without the field is a PC-key adapter). `enableInput()` and `configureRouting()` (while a backend is
  attached) refuse a policy naming a method the adapter cannot serve with `policy-unavailable`; nothing attaches
  and no other backend is selected. The `Keyboard()` backend advertises no Quickey dispatch and refuses Quickey
  tuples outright; the fake backend simulates them (and can be created without, for tests). The Quickey flags are
  enforced per operation before any dispatch, on every path (press, tap, combo, sequence preflight): a tap needs
  `tap`, a hold needs `hold`, and a combo or a press next to another live Quickey record needs `chord`. `type` cannot be
  configured against any current backend, and the text branch of `shortcutOrType` is selected but refused as
  `unavailable`, both naming the KB-14 requirements (text-route dispatch; temporary shortcut enable/disable).
- **Selection.** `shortcut`: the pre-0.6.0 route; a shortcut-table route with shortcuts off keeps the same
  `unsupported` refusal and additionally lists the KB-14 requirement. `shortcutOrType`: the fixed/native routes
  (`MA`, `PLEASE`) whatever the mode; otherwise a shortcut only when enablement reads `true` and resolution
  succeeds; the explicit text when the table was read and has no row for the key, or when enablement reads
  `false` (no row required); unreadable enablement, ambiguity, collisions, unknown keys and a missing text mapping
  are refusals. `quickkey`: the code must be an `Enums.VirtualKeyCode` name on the console (`MA1` is valid here;
  `MA` is not); an unreadable enum refuses.
- **Retention.** The decision (`route.method`, `route.methodSource`, `route.routing` snapshot, `quickkey`,
  `quickkeyCode`, `tupleKey = "quickkey:#<value>"`) is stored on the hold and used for the release. Ownership is
  the validated code value, so aliases (`OOPS`/`UNDO`) are one tuple: the second is the owner's duplicate or another
  session's conflict, a combo naming both is refused, and a release or recovery under either name uses the stored
  tuple; the requested name stays on the record for reporting; a policy change or mode change
  during a hold never re-routes it, and a Quickey hold's route recheck uses the stored snapshot, never the current
  policy. A raised or refused press is `press-failed` with no second backend; a refused press is not queued and
  a later mode/table change dispatches nothing until a new call makes a new decision.
- **Reporting.** `describeRoute(name, opts)` returns `method`, `methodSource`, `effective` (`quickkey`,
  `shortcut-table`, `fixed`, `native`, `text`), `supported`/`code`/`reason`, `dispatchable`, `unavailable[]`,
  `capabilities`, the `describeKey()` resolution and, for Quickeys, `codeValue`. `routingReport()` and
  `status().routing` summarise the policy and per-method availability; `status().backend.capabilities` and each
  hold's `method`/`quickkey` are new fields. `resolve()` results now carry a machine-readable `code`
  (`no-row`, `ambiguous`, `collision`, `unknown-key`, `unreadable`, …) which the text branch depends on.

What is *not* established: no Quickey or text route reached a console through this change. The `modules.lock.json`
pin still names the reviewed 0.4.0 bytes; re-pin deliberately when a consumer vendors 0.6.0.

## KB-12 — Provision and cache the complete Quickey bank

**Request:** Create one owned Quickey for every qualified hardkey code, avoiding per-surface allocation.

**Depends on:** KB-10 and KB-11.

**Lua changes: Yes — shared provisioning/backend code and consumer startup integration.** Do not create
a surface-specific allocator. MCP/TypeScript changes are not required unless provisioning is exposed there.

### Acceptance criteria

- Require explicit setup authorization and an operator-selected resource range. Provision the complete
  qualified code set, deduplicate aliases, and report exclusions.
- If dispatch requires executors, reserve and validate those resources as part of the same setup.
- Preflight the complete reservation before creating objects, and recheck each target before mutation.
  Never overwrite unowned objects; preflight is not an atomic reservation against other plugins.
- Track ownership and expected configuration. Labels alone are insufficient proof of ownership.
- Reuse a bank only after verifying identity, codes and configuration. Cache handles, but invalidate them
  on relevant show/data-pool changes or object replacement. Revalidate targets before dispatch.
- Refuse dispatch through deleted or unexpectedly modified objects. Do not silently repair operator edits.
- On partial setup failure, remove only newly created, still-owned, unchanged objects.
- Separate release-all from bank removal. Shutdown releases active keys; explicit teardown removes only
  verified owned resources and refuses unsafe deletion while holds remain unresolved.
- Define bank ownership across consumers. Initially reject a second owner unless explicit shared arbitration
  is implemented; a common bank does not itself provide cross-plugin press/release ownership.
- Test collisions, partial failure, deletion/replacement, operator edits, cached-handle invalidation,
  save/reload and plugin restart. Qualify persistence and ownership recovery on a disposable show.

### Module change for KB-12 (hardkeys 0.7.0, bridge 0.9.0, 2026-10-09)

Implemented in `plugin/gma3_mcp_hardkeys.lua` 0.7.0 with the regression harness `test/lua/hardkeys_bank_test.lua`
(110 checks against a fake Quickey pool and executor page) and the bridge section of `test/lua/bridge_plugin_test.lua`
(15 checks). No MCP tool or TypeScript contract changed; provisioning is reachable only through the plugin argument.

- **Authorization and ranges.** `provisionBank({ authorized = true, quickeys = { first }, executors = { page, first,
  count }, codes, label }, now)`. `authorized = true` is the consumer's explicit operator decision (the bridge sets it
  only from `Plugin "gma3_mcp_bridge" "bank=900/1.190-197"`, never from a client request); without it nothing is read.
  The executor count must cover `config.maxHolds` (one executor per concurrently held key, KB-10) and defaults to it.
- **Code set.** Discovered from `Enums.VirtualKeyCode` at provisioning time (never a fixed count): one entry per distinct
  value, ordered by value (slot = first + rank), aliases folded (`UNDO` → `OOPS`) and reported, value-0 placeholders,
  `X1`–`X16`, `XKEYS`, `EXEC`, `FADER`, `DEF_*`, `ENCODER_*`, `ONPC_SCREEN*` and the executor button functions
  (`FLASH` … `RECORD`) excluded with reasons. Each code carries its KB-10 qualification (`{ tap, hold, chord, note }` for
  NUM1, NUM5, THRU, FIXTURE, PLEASE, CLEAR, STORE, MA1, OOPS; `false` = discovered only, with ESC's note). `codes =
  "qualified"` provisions only the evidenced codes; an explicit list is accepted; excluded codes cannot be forced in.
- **Ownership.** Each Quickey gets `Name = "MCP <CODE>"` and a Note marker
  `gma3_mcp_hardkeys-bank v1 owner=<owner> bank=<id> code=<CODE> exec=<page>.<first>-<last>`; the bank id is
  deterministic from owner and ranges. An object counts as owned only when marker, `Code` and `Name` all match; a
  label alone proves nothing. Preflight classifies every slot (`empty`, `owned`, `owned-changed`, `foreign`,
  `other-bank`, `occupied`) and every executor (`empty`, `owned`, `occupied`, `missing`) before any write; one refusal
  (`bank-preflight` with `refusals[]`) and nothing is created. Another owner's marker is `bank-foreign-owner` (no
  shared arbitration); the same owner's other bank id is `bank-mismatch`; an owned object with an operator edit is
  `bank-mismatch` and is not repaired. Executors already holding a bank Quickey are reused as `assigned`.
- **Executor reservation (visible across consumers).** The bank has one extra, code-less Quickey `MCP RESERVED`
  (marker `code=RESERVED`, the slot right after the codes). Provisioning assigns it to every empty reserved executor,
  re-reading each right before, so the claim is an object on the console: another consumer's preflight reads a foreign
  marker (`executor-foreign-owner`) and is refused before creating anything, including the same owner's other bank.
  A reserved executor that reads empty later is `unreserved` (a problem, not silently re-assigned); the same spec on a
  fresh instance re-reserves it. Executor ownership is the assigned Quickey's **pool index, marker and Code** against the
  bank's entry, never its name: a same-named Quickey, a marker copy at another index or a changed Code is `occupied`
  and is left alone by teardown.
- **Mutation.** Each slot is re-read right before `Store Quickey N /NoConfirmation`; Note is written first, then Code,
  then Name, and the object must read back as owned. On any failure (`bank-partial`) the rollback re-reads every object
  this call created and deletes only those that still read back exactly as written (or untouched if nothing was written
  yet); anything else is `kept[]` with its reason. A slot that became occupied between preflight and creation is a
  failure, never an overwrite.
- **Cache and revalidation.** `bankTarget(code, now)` (KB-13 calls it before every press), `bankExecutor(index, now)`
  and `teardownBank()` first re-read the **show identity**: a mismatch marks the bank `stale` and refuses (`bank-stale`),
  so matching objects at the same indices in another show are never used or deleted. Then the one Quickey / executor is
  re-read and refused on `bank-object-missing` / `bank-object-changed` / `bank-executor-*`. `verifyBank(now)` on the
  bank's show re-reads everything and marks it `ready` or `degraded` with `problems[]`; on another show it keeps the bank
  `stale`, inspects no object and dispatch stays refused. `service(now)` re-reads only the show identity every
  `config.bankCheckMs` (2000 ms).
- **Teardown and release-all are separate.** `teardownBank(now, { authorized = true })` is refused while any Quickey
  ownership record is held or unresolved (`bank-in-use`). It clears only executors holding a bank Quickey, deletes only
  Quickeys that still verify (placeholder included), skips changed or replaced objects with reasons, and leaves a
  `partial` bank for them.
- **Restart.** `dispose()` returns `bank` (the record); the bridge keeps it in `state.input.bank` like unresolved
  records and `adoptBank(record, now)` re-verifies every object at the next start (nothing created; a lost marker makes
  the entry `replaced` and refuses dispatch). The same spec on a fresh instance also finds and reuses the bank through
  the markers. `status().bank` / `bankStatus()` report everything, including the record; `ping.input.bank` and
  `input.status` carry the summary. A complete record without the placeholder entry (an older format) is refused; the
  record of a partially torn-down bank (`partial = true`, its placeholder already deleted) is adopted for cleanup only:
  dispatch refuses `bank-partial` and teardown completes once the skipped objects are restored or removed. `adopt()` now
  accepts unresolved Quickey hold records (they have no `pcKey`).
- **Bridge.** `bank=<quickey>/<page>.<first>[-<last>]`, `bankcodes=hardkeys|qualified`, `bank status`, `bank verify`,
  `bank teardown`. The console deps address objects in command syntax (`ObjectList("Quickey N")`,
  `ObjectList("Page P.N")`, `Store`/`Delete Quickey N /NoConfirmation`, `Assign Quickey N At Page P.N` and
  `Delete Page P.N /NoConfirmation` for an executor) and verify every write by readback, never by the command's return
  text. The executor read resolves the assigned object's pool index, Note and Code.

Live on 2026-10-09 ([record](docs/probes/kb-12-bank-macos-2.5.1.md)): `bank=900/1.180-187` created 94 Quickeys that
read back as written, `bank status`/`verify` reported the codes and an operator edit, the record survived a bridge restart
and was re-verified without creating anything, and `bank teardown` removed exactly the 94 objects. `Assign Quickey N At
Page 1.180` and `Delete Page 1.180 /NoConfirmation` work as the deps assume. Two console facts shaped the deps: an empty
executor has no object under `Page P.N` (reported `empty`, not `missing`, when the page exists), and the show identity is
`Root().MANetSocket:Get("ShowFile")` plus the data pool name (`ShowData().name` is the literal `"ShowData"`).

What is *not* established: save/reload persistence (SaveShow/LoadShow are operator actions), refusals against a foreign
owner or an unowned object on the console (harness only), teardown while a Quickey hold is live (harness only), the
behaviour of `Store Quickey` on a locked or full pool, and any Quickey dispatch (KB-13). The `modules.lock.json` pin still
names the reviewed 0.4.0 bytes.

## KB-13 — Production Quickey input backend

**Request:** Dispatch surface hardkey events through the owned Quickey bank.

**Depends on:** KB-12.

**Lua changes: Yes — shared hardkeys module and surface integration.** Reuse existing event and recovery
machinery. No MCP/TypeScript changes should be needed for the initial surface backend.

### Acceptance criteria

- Implement only qualified tap, press, release and chord behavior; advertise capability limitations.
- Preserve duplicate suppression, event ordering, press ownership and original-outcome acknowledgment replay.
  Repeated down reports or heartbeat reconciliation must not retrigger an activation.
- Release using the recorded backend and target even if configuration changes while held. Do not resolve
  a replacement object at the same pool index and release it as though it were the original target.
- Disconnect, stop and restart attempt releases and retain unresolved failures for recovery. Block new
  conflicting input until recovery completes; preserve retained-record and quarantine handling.
- Apply existing admission checks. Handle asynchronous ordering, especially digits/keywords followed by
  Please. Never retry an uncertain activation automatically.
- Distinguish dispatched from observed completion and preserve local physical indications versus
  console-derived feedback.
- Test simultaneous keys, long holds, rapid sequences, duplicate/reordered packets, interruption,
  object deletion and backend exceptions. Add live NX-K qualification for the actual surface path.

### Module change for KB-13 (hardkeys 0.8.0, bridge 0.10.0, 2026-10-09)

Implemented in `plugin/gma3_mcp_hardkeys.lua` 0.8.0 (`quickeyBackend(instance)`) with the regression harness
`test/lua/hardkeys_quickey_test.lua` (107 checks against a fake console with executor key state) and the bridge section of
`test/lua/bridge_plugin_test.lua` (`input=quickey`). No MCP tool or TypeScript contract changed; the backend is an
operator decision (`Plugin "gma3_mcp_bridge" "input=quickey"`, with the KB-12 bank provisioned).

- **Everything is an executor press.** A Quickey addressed directly is always a complete tap (KB-10), so a tap, a hold
  and every key of a chord are `Press Page P.E` on a reserved executor and `Unpress Page P.E` at the release (a tap is a
  bounded hold released by `service()`). Confirmed live before the change: the paged form holds exactly like the KB-10
  `Press Executor E`, and `Unpress` on an empty executor answers `Object not found`. The console deps gained
  `executors.press/unpress`; any feedback other than `OK` is "not accepted" (nothing changed), a raise is "unknown".
- **Right before every press** the code's Quickey is re-read through `bankTarget()` (show identity, marker, Code, Name),
  a free reserved executor is re-read through `bankExecutor()` (placeholder or a bank code on it, by index, marker and
  Code), the Quickey is assigned when another one is there (`Assign Quickey N At Page P.E`, verified by readback), then the
  press goes out. `preflight()` does the same reads for every key of a combo before the first event. Executors that lost
  their reservation, hold a foreign object or are held by a live record are skipped and never repaired. The assignment
  stays after the release (the next press of the same code is Press/Unpress only).
- **Qualification per code.** The adapter advertises `capabilities.quickkey = { tap, hold, chord }` and, per code,
  `quickkeyCapabilities(code)` = the KB-10 evidence (`tap` is granted whenever `hold` is, because a tap here is an
  executor pair: MA1 taps, OOPS does not hold, NUM1/THRU/FIXTURE/PLEASE/CLEAR do not chord). `_route()` uses the per-code
  flags, so the existing capability checks (press, combo, sequence preflight) refuse before dispatch. A chord is only as
  qualified as its least qualified key: a press next to a live Quickey record, and a sequence step next to a tuple an
  earlier step leaves down, also require `chord` on every key already down (its stored flags, never the current policy),
  so a held NUM1 refuses a NUM5 just as a held NUM5 refuses a NUM1 (`heldKey` names it); `supportsQuickkey()`
  refuses the 85 discovered-only codes and `unavailable(code)` names "no Quickey bank", "partial bank", "not in bank"
  and "discovered only" in `describeRoute()`. No PC keys (`capabilities.keyboard = false`, `supportsKey()` refuses) and
  no text; the shortcut/shortcutOrType/type methods are unavailable on this backend.
- **The target travels with the record.** `press()` returns a 4th value `target = { page, executor, quickeyIndex, code,
  value, bank }`; the instance stores it on the hold (`hold.target`, reported in `_holdReport`, `dispose()` records,
  `adopt()`), passes it to `release(tuple, target)` and derives the executors in use from the live records
  (`_executorsInUse()`), so a backend keeps no state of its own and an adopted record from a previous run reserves its
  executor exactly like a fresh one. A press that raises may raise `{ message, target }` so the unresolved record keeps
  the executor it was dispatched on.
- **Release integrity.** `release()` issues `Unpress` only when the recorded executor still holds the recorded Quickey
  (bank id, page, entry index and Code checked, then `bankExecutor()`); otherwise nothing is issued and the record stays
  unresolved with the reason (the key may still be down; the operator restores the assignment, then `recover()`). A direct
  `Unpress Quickey N` is never issued (it re-activates non-latching keys, KB-10). A record without a target, a record of
  another backend, another show (`bank-stale`), a missing bank or a bank mismatch are all refusals, never guesses.
- **Instance changes.** `enableInput(adapter, { routing })` applies a routing policy together with the backend, validated
  against the new adapter (the Quickey backend cannot serve the module-default `shortcut` policy, and the old adapter
  cannot serve `quickkey`); `preflight(tuple, route, ctx)` receives `{ kind, combo, extra }`; `_now` is recorded at the
  two dispatch points so the backend can stamp the bank reads.
- **Bridge.** `input=quickey` (also `quickkey`, `qk`); `adapterFor()` builds `quickeyBackend(rec.instance)`;
  `enableInputOn()` passes `{ routing = { default = "quickkey" } }` for it and `{ default = "shortcut" }` for the others;
  messages name the three backends. Without a bank every press is `unavailable` naming the KB-12 requirement; a kept
  Quickey record of a previous run makes the bridge `[busy]` until the operator's `input recover` releases it.

Live on 2026-10-09 ([record](docs/probes/kb-13-quickey-macos-2.5.1.md), 47/47 with `node scripts/kb13-probe.mjs run`,
whose operator-side actions during holds go through a deferred show macro the probe creates in an empty slot and removes):
NUM5 tap → `5`, OOPS tap removed it, MA1 hold with `MASTATE` true/false, duplicate press answered with the same record,
MA1+STORE chord → `Record `, `Fixture 1 Thru 5 Please` sequence selected 5 fixtures and CLEAR cleared them, ESC/GO/raw PC
key/MA/non-chord combos refused before dispatch, an executor reassigned during an MA1 hold left the key down and the
record unresolved until the operator restored the assignment, a bridge restart with that stuck record adopted it with its
executor target and blocked all input until `input recover`, and `bank teardown` was refused `bank-in-use` during a hold.

What is *not* established: the NX-K surface path (mtpnxk must vendor 0.8.0 and bind its own instance; the module-side
behaviour it needs is covered), hold/chord evidence for any code beyond the nine KB-10 codes (none is dispatched), a
`Press` the console rejects or a raise during dispatch (harness only), and save/reload. The `modules.lock.json` pin still
names the reviewed 0.4.0 bytes.

## KB-14 — Scoped shortcut-state changes and text alternatives

**Request:** Implement `shortcutOrType`, `shortcut` and `type` with bounded shortcut-state changes and recovery.

**Depends on:** KB-11. Independent of Quickey provisioning and not a prerequisite for KB-13.

**Lua changes: Yes — shared hardkeys/input module and probe code.** Consumers must not implement their
own toggles. MCP/TypeScript changes are needed only for explicit exposure of the new policy.

### Acceptance criteria

- First probe when key/character events are consumed relative to mode restoration. A single Lua call is
  not assumed atomic. Do not enable an unqualified toggling path in production.
- Capture active profile and shortcut state before mutation; refuse if either is unreadable. Resolve
  shortcuts and validate text before changing state.
- Change mode only when required. Serialize module-owned input for the full temporary-state operation;
  this is not a lock against physical input or other plugins.
- Restore captured state after completion and handled errors when the original profile and ownership of
  the temporary state remain valid. Detect observable profile/mode interference, stop and report it rather
  than blindly overwriting a newer operator state. Do not mutate a replacement profile during cleanup.
- Track unresolved restoration separately from key-release recovery, expose it in status, and block
  conflicting operations until resolved. Document that abrupt termination and undetectable external changes
  prevent an absolute restoration guarantee.
- For `shortcut`, retain the necessary mode through the qualified key lifecycle. Do not restore immediately
  after key-down unless tested release semantics allow it. Bound mode-changing holds with a timeout and
  release/restoration recovery; advertise unsupported hold/chord combinations explicitly.
- Text routes insert once on press and nothing on release. They refuse conflicting instance-owned held,
  releasing, unresolved, retained or quarantined input. Native holds are not converted into text.
- Use bounded text dispatch, rechecking admission and state between chunks. On interruption report partial
  or uncertain progress; do not erase, complete or replay text automatically.
- Type into the focused input without moving focus or adding Enter/Please. Preserve explicit MCP focus
  acknowledgments; represent the surface's best-effort focus policy honestly.
- Test initial mode on/off, missing mappings, profile/mode changes, errors at each stage, cancellation,
  partial text and restoration failure, including interaction with existing held inputs.
- Document that physical keys and other controllers can interfere; instance ownership is not a complete
  inventory of keys held on the console.

### Module change for KB-14 (hardkeys 0.9.0, bridge 0.11.0, 2026-10-09)

Implemented in `plugin/gma3_mcp_hardkeys.lua` 0.9.0 with the regression harness `test/lua/hardkeys_mode_test.lua`
(98 checks on the fake backend with a fake profile, state and mode writer) and a bridge section of
`test/lua/bridge_plugin_test.lua` (21 checks: the ops, a text tap and a mode-changing hold through `Keyboard()`, an
unresolved restoration refusing the guarded ops, kept across a stop and restored by `input recover`). Live evidence:
[kb-14-timing-macos-2.5.1.md](docs/probes/kb-14-timing-macos-2.5.1.md) (the consumption-order probe, 11/11) and
[kb-14-run-macos-2.5.1.md](docs/probes/kb-14-run-macos-2.5.1.md) (the module paths, 32/32). No MCP tool or TypeScript
contract changed; `gma3_type` keeps the KB-05 text step, which is refused while a mode operation is pending.

- **Probe first.** Character events and a printable shortcut tap are consumed inside `Keyboard()`; Escape (shortcuts
  on) and a modifier press are consumed on a later frame, a same-chunk restore after a LeftShift press was dropped in one
  run and registered in others, a release under the other mode did not lift a registered modifier, and disabling
  shortcuts drops a held MA. Hence: the mode is kept through every dependent hold, the release goes out in the mode of
  the press, and the restore happens in `service()` after `config.modeRestoreDelayMs` (60 ms) since the last dependent
  event, never in the call that dispatched it.
- **One mode operation at a time** (`status().modeChange`): the profile name and the state are captured first (refused
  as `unreadable` if either cannot be read; nothing written), the state is written only when it differs from what the
  route needs (`route-changed` when it changed between resolution and dispatch), verified by readback (`mode-change-failed`
  when the write had no effect: nothing dispatched, nothing to restore; a write that raises or cannot be read back leaves
  an unresolved restoration). Routes needing the opposite state while one is active are `mode-conflict`, never
  pre-empted; routes needing the same state join it. The write is `deps.setShortcutsActive` (`consoleDeps`:
  `KeyboardShortCuts:Set("KeyboardShortcutsActive")`); adapters advertise `capabilities.modeChange` (keyboard: only with
  the dep; quickey: false), and without it the pre-0.9.0 refusals stand.
- **Interference, not overwrite.** Before each restore `service()` re-reads the profile and the state: a changed profile
  or an unreadable state makes the restoration **unresolved** (`busy` reason `restoration`, dependents `quarantined`,
  every new press and the bridge's guarded ops refused) until `recover()` (owner, or the operator's `input recover`)
  re-reads it on the original profile and restores it; a replacement profile is never written. A state somebody already
  set back is left alone (`restoredBy = operator`, `interference` recorded). `dispose()` follows the same rules: it
  restores only when no dependent is still held or unresolved and the delay elapsed since the last release, otherwise it
  hands the pending restoration back as a record (`adoptMode()`, kept by the bridge like unresolved key records; the
  operator's `input recover` restores it after the adopted keys are recovered; a release made in that recover call restarts
  the delay and `service()` does the restore). The bridge's stop path waits the delay
  on the loop before disposing; a Cleanup from the console cannot wait and keeps the record instead.
- **Routes.** `shortcut` with a shortcut-table row and shortcuts off enables them for the hold (`route.modeChange`,
  `route.shortcutsActive = true`, so the operator disabling them mid-hold is the KB-04 route change). `type` and the text
  side of `shortcutOrType` insert the key's text once on press through `adapter.char`, in chunks of
  `textCharsPerService`, rechecking the mode, the profile, exclusivity and routes between chunks; partial progress is
  reported (`text.typed`, `outcome partial|uncertain`, nothing erased or replayed; in a sequence a partial or uncertain
  insertion stops the sequence so a following PLEASE never commits it), the command line is read back when
  readable (`text.readback` observed/inconclusive), focus is best-effort and reported as such, no Enter/Please is added.
  A press refused after the mode was changed (or a first character refused) drops its record as terminal, so the
  restoration still completes.
  A text record owns no key (`tupleKey = "text:<KEY>"`, `releaseOutcome = "none"`), needs no interaction, refuses combos,
  exclusivity and every other instance-owned record (held, releasing, unresolved, retained, quarantined; consecutive
  text records of the same operation excepted) and is itself `released` at once or `retained` until the restore. Native
  and fixed routes (PLEASE, MA) never become text.
- **New record states.** `retained` (the key is up, the mode restoration is pending; not live for capacity, busy or
  exclusivity) and `quarantined` (retained when the restoration went unresolved). Sequences wait for a pending
  restoration before a step that needs the operator's own mode (a text step) or the opposite temporary mode.
- **Bridge 0.11.0.** `input.routing` (`{ policy }` replaces the attached backend's policy, refused while another
  connection owns input; without a policy it reports) and `input.route` (`{ key, prefer, executor }` → `describeRoute`);
  `pressSpec` forwards `prefer`; `ping.input` / `input.status` report `modeChange`, `retained`, `quarantined`; the
  guard's `[busy]` names `restoration`; `state.input.mode` keeps an unresolved restoration across a restart.

What is *not* established: a profile switch, an unreadable state or a failed restore write on the console (harness
only); the kept restoration across a real restart; a KB-05 text step racing a 60 ms restore; the NX-K surface path.
Physical keys, other plugins and another console user can change the mode or the profile at any time: the operation is a
property write verified by readback, not a lock, and abrupt termination defeats the restore guarantee (the record is kept
for `input recover`).

## KB-15 — Surface defaults, migration and qualification

**Request:** Make qualified Quickey dispatch the normal surface hardkey path while retaining explicit alternatives.

**Depends on:** KB-13. Alternative methods become available after KB-14; they need not delay Quickey rollout.

**Lua changes: Yes — surface configuration/startup integration.** Further shared-module changes should only
be needed for defects found during qualification. Update documentation, tests and vendoring pins/hashes.
No MCP/TypeScript changes should be needed unless its public options are deliberately extended.

### Acceptance criteria

- Default surface hardkeys to `quickkey` after explicit resource setup. If the bank is unavailable, report
  setup or recovery requirements; do not silently fall back to keyboard dispatch.
- Allow per-key overrides and expose effective routing in startup/status. Until KB-14 is qualified,
  reject unavailable methods rather than accepting inert configuration.
- Preserve the keyboard backend and existing MCP tool contracts. Retain literal text entry separately
  from hardkey dispatch; a complete Quickey bank does not replace arbitrary typing.
- Document method differences, owned show resources, temporary mode changes, focus behavior and physical
  interference. Include setup, opt-out/override, recovery and teardown examples.
- Test mixed-method interactions, including shortcut mode changes while a Quickey is held. Refuse combinations
  whose semantics have not been qualified instead of assuming independent backends cannot interfere.
- Update module versions, vendoring pins/hashes, integration examples, capabilities, key maps and LED guidance.
- Run lifecycle and packet-loss/reordering regressions plus live console qualification. Keep benchmark/flood
  defects separate, and do not grant new platform coverage merely because the implementation is shared.

### Module change for KB-15 (hardkeys 0.10.0, bridge 0.12.0, 2026-10-09)

The shared-module and bridge half of KB-15, implemented in `plugin/gma3_mcp_hardkeys.lua` 0.10.0 with the regression
harness `test/lua/hardkeys_mixed_test.lua` (67 checks: the real owned-Quickey backend over the KB-13 fake console as one
part, the fake backend with the KB-14 fake profile and mode writer as the other) and a section of
`test/lua/bridge_plugin_test.lua` (11 checks, `input=mixed`). No MCP tool or TypeScript contract changed. The surface half
(mtpnxk: vendoring 0.10.0, `quickkey` as its default after the bank setup, its own startup/status report, key maps, LED
guidance and the live NX-K qualification) is done in the surface project against this revision.

- **Why a mixed backend.** A surface that defaults to `quickkey` can dispatch only the codes with KB-10 evidence (nine on
  this console); every other key would be refused until it is qualified. KB-15 asks for per-key overrides that are not
  inert, so the module now serves both console mechanisms on one instance: `mixedBackend({ quickey = quickeyBackend(inst),
  keyboard = keyboardBackend(deps) })`. Quickey tuples go to the Quickey part (executor presses of the KB-12 bank), PC-key
  tuples and character events to the Keyboard() part. Capabilities are merged (`keyboard`, `char`, `modeChange` from the
  keyboard part; `quickkey` from the Quickey part, with the per-code flags and `unavailable()` of the Quickey part), so a
  policy `{ default = "quickkey", keys = { NUM0 = { method = "shortcut" }, THRU = { method = "type", text = "Thru " } } }`
  validates against it, and a keyboard part that cannot change the mode still refuses a `type` override at `enableInput()`
  (`policy-unavailable`) rather than accepting it.
- **No silent fallback.** The method decides the part, never the other way round: a `quickkey` route without a bank,
  with a partial bank, for a code outside the bank or for a discovered-only code is `unavailable` naming the KB-12/KB-10
  requirement, and nothing goes to `Keyboard()`. Literal text stays a separate route (`type`, the text side of
  `shortcutOrType`, the KB-05 text step) through the keyboard part; a complete bank never replaces it.
- **The record remembers its part.** `hold.backend` is the part's own name (`"quickey"` / `"keyboard"`; the fake's when a
  test uses it), not `"mixed"`: a release, `recover()`, `dispose()` records and `adopt()` go through that part, and the mixed
  adapter `serves()` records of either part, while a record of a backend that is not one of its parts stays unresolved with
  its origin named. `describeRoute()` reports `dispatchBackend`, the part that would press the key, for startup and status
  reports; `status().backend` lists the mixed rules plus both parts' limitations and counters.
- **Unqualified combinations are refused, on every backend** (`unqualified-mix`, before any dispatch; the fake backend,
  which advertises both kinds, now refuses them too): a PC key while a Quickey record is held, releasing or unresolved and
  the reverse (`reason = "held"`, `heldKind`, the record named); a combo mixing both kinds (`reason = "combo"`, the key
  index); a sequence step that would put one kind down next to the other, from live records or from earlier steps of the
  sequence (`step`); a Quickey while a temporary shortcut-mode change is active or its restoration is pending
  (`reason = "mode"`; a sequence step waits for the restoration instead, like a text step); and a route needing a mode
  change while a Quickey is down (`_enterMode` refuses, nothing is written). The reason is evidence, not caution for its
  own sake: disabling shortcuts drops a `Keyboard()`-held MA (KB-14) and what it does to an executor-held Quickey is
  unknown, and a chord across the two mechanisms has never been dispatched. An unresolved restoration keeps the KB-14
  `busy` refusal. Text routes already refused every other record; that stands.
- **Bridge 0.12.0.** `input=mixed` (aliases `quickey+keyboard`, `kb+qk`) attaches the mixed adapter built from the same
  cached Quickey and keyboard adapters `input=quickey` / `input=keyboard` use, with the routing default `quickkey`;
  `input.routing` then accepts the overrides, `input.route` reports `dispatchBackend`, and `input recover` attaches the
  mixed adapter for cleanup when kept records of both parts exist (one kind attaches its own backend as before).
- **Operator guide (bridge; the surface documents its own spelling).** Setup: `Plugin "gma3_mcp_bridge" "bank=900/1.180-187"`
  (operator-authorised, creates the owned Quickeys and reserves the executors; KB-12), then `"input=mixed"` (or
  `"input=quickey"` for Quickeys only). Opt-out or override: `input.routing` with `{ default = "quickkey", keys = { <KEY> =
  { method = "shortcut" | "shortcutOrType" | "type", text = ... } } }`, or `"input=keyboard"` to leave Quickeys out
  entirely; a switch is refused while records exist. Recovery: an executor reassigned during a hold leaves the record
  unresolved and the key down until the assignment is restored and `"input recover"` runs; a restoration the module could
  not verify blocks input until `"input recover"` on the original profile (KB-14). Teardown: `"input=off"` (releases what
  it can), then `"bank teardown"` (refused while a Quickey record is live; removes only verified owned objects).
- **Owned show resources, mode changes, focus, interference.** The bank (Quickeys from the chosen pool index, the reserved
  executor range with the placeholder Quickey) is the only show data this path writes, marked and re-read before every
  use. The shortcut mode is changed only by the routes KB-14 describes, for a bounded operation, and never while a Quickey
  is down. Text goes to whatever the console has focused (best effort, reported as such, no Enter/Please added); Quickeys
  and PC keys press the console's own keys, so a physical key, another plugin or another console user can interfere with
  either, and a record is responsibility for a release, not proof of why a key is down.

What is *not* established: the mixed backend on the console (no live run: the bridge section is harness-only), any code
beyond the nine KB-10 codes (still refused on the Quickey part until qualified live), a chord across the two parts or a
mode change while a Quickey is down (refused, so never exercised), the NX-K surface path, save/reload. The
`modules.lock.json` pin names the 0.10.0 bytes of this revision for vendoring; it does not grant platform coverage.


## Evidence and open questions

- [MA: Plugins](https://help.malighting.com/grandMA3/2.4/HTML/plugins.html) describes `HelpLua`, multiple
  components, component invocation, import files, and show-file versus library storage. It does not
  establish that an added component becomes a standard `require` module.
- [MA: CmdObj()](https://help.malighting.com/grandMA3/2.1/HTML/lua_objectfree_cmdobj.html) includes a
  `cmdtext` example. This supports the initial probe target, not a complete pending-keyword API.
  Probed live on 2026-10-09 ([record](docs/probes/kb-10-cmdtext-write-macos-2.5.1.md)): on onPC 2.5.1.0 the
  property is read-only. Assignment and `Set("CmdText", ...)` return without error and leave the buffer unchanged
  (immediately, a frame later and after an unrelated value), so appending `Thru ` through `CmdText` is not a path
  for insertion. Key/character injection and the separately tested macro path can populate the buffer.
  On screen the write is inert: the
  caret, an active selection and a focused Edit Command pop-up are untouched and typing continues where it was, with
  ShCuts off and on (digit rows 124–133 = `NUM0`–`NUM9` on profile `Default`, no `Thru` row).
- Macros with `AddToCmdline=Yes, Execute=No` probed live the same day
  ([record](docs/probes/kb-10-macro-append-macos-2.5.1.md)): `Cmd("Go+ Macro N")` inserts the line's command into the
  editable buffer on the next console frame without executing it, with ShCuts off and on and with no shortcut row
  involved; digits are contiguous (`55`); the caret ends at the end and typing continues there; the Edit Command pop-up
  (a view of the same buffer) keeps focus. Caveats: the console trims the macro command and the buffer's trailing
  whitespace, so `Thru` lands as `Fixture 1Thru` (the parser still executes `OK: Fixture 1 Thru 5`); insertion is at
  the caret and replaces a selection. This establishes a macro insertion path, not Quickey activation
  or release. Preserve it as evidence; the new surface direction requires the separate KB-10 Quickey probe.
- Quickey dispatch probed live the same day ([record](docs/probes/kb-10-quickey-macos-2.5.1.md)): `Enums.VirtualKeyCode`
  resolves to the 146 `Root().VirtualKeys` codes plus `UNDO` as an alias of `OOPS`. A Quickey addressed directly
  (`Press`, `Unpress`, `Go+` or bare `Quickey N`) is always a complete tap, so MA1 never holds that way. A Quickey assigned
  to an executor and driven with `Press Executor N` / `Unpress Executor N` is a real key-down until the `Unpress` (held
  across requests and for a minute; MA1 + STORE on two executors produced `Record`); `Go+ Executor` presses without
  releasing and `Off` does not release. Effects are synchronous in the Lua chunk and ordered, except that with the Edit
  Command pop-up or another text field focused digits land one frame after keywords (`1 Thru 5` → `5 Thru 15`) and all
  text keys go to the focused field. Reassigning, clearing or deleting the executor or Quickey during a hold leaves the
  key down; a direct `Unpress Quickey N` on an object with the MA1 code released MA1 but the same call on NUM5 inserted a
  second `5`, so recovery is qualified for MA1 only. The 146 codes are discovered, not qualified: tested were NUM1, NUM5,
  THRU, FIXTURE, PLEASE, CLEAR, STORE, MA1, OOPS and ESC. `Oops` on an empty command line is Undo and reverted
  show data during the run; `ESC` as a Quickey never touched the command line; no key or LED state is readable. This
  qualifies tap, press, release and chords for the tested codes through executors (sequences with an immediate Please were
  repeated as executor press/release pairs), and makes executor reservation and per-code qualification part of KB-12.
- [RBOSCKeys author's description](https://git.riksolo.com/RikSolo/eleventy-riksolo-com/commit/8ec798f93fc873ef7c9ac485f8b5423a33999d69)
  describes dynamic Quickey allocation and executor holds. It is evidence for the pattern, not proof
  of a non-OSC implementation or compatibility with every onPC version.
- The originating proposal cites a community v2.3 `Keyboard()` API dump and MA forum thread 9022.
  The recorded live descriptor and observations above now supersede those references for the tested
  configurations and explicit coverage above; they do not establish compatibility beyond those tests.
- Claims that no other external hardkey mechanism exists, or that OSC executor keys fail on a particular
  release, are not prerequisites for this design and should not be published as universal facts.
