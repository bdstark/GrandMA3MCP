# Console feedback tool (KB-06)

Read-only console state for feedback, through the bridge's feedback module
([KEYBOARD.md](../../KEYBOARD.md#kb-06--add-console-feedback-readers), [modules](../modules.md#feedback-readers-gma3_mcp_feedback-020-kb-06)).
Nothing here needs `gma3_lua`, console input, or a free bridge: the op is never guarded, it acquires no
interaction and it changes no console state.

| Tool | Bridge ops | What it does |
| --- | --- | --- |
| `gma3_feedback` | `feedback.read` | Observe command text, last command feedback, Blind/Highlight/Solo, Preview mode, a display's Preview bar, shortcut enablement, aggregate MA state, current page, selected sequence, and per executor the assignment and fader level, per sequence its playback activity |

The TypeScript side is a wrapper (`src/tools/feedback.ts`): readers, capability checks, value normalisation,
request expansion and bounds live in `plugin/gma3_mcp_feedback.lua` 0.2.0 through `plugin/gma3_mcp_bridge.lua`
0.8.0. The wrapper sends one `feedback.read`, makes unavailable values an explicit `null`, and keys the items.
An older plugin answers `unknown op`, which the tool reports as "update the plugin to 0.8.0".

## Parameters

| Parameter | Meaning |
| --- | --- |
| `readers` | Reader names to include (`commandText`, `lastCommand`, `blind`, `highlight`, `solo`, `previewMode`, `previewBar`, `shortcutsActive`, `maState`, `page`, `selectedSequence`, `freeze`). The parameterised readers `executor`, `fader` and `sequenceActive` come from `executors`/`sequences`; naming them here is reported as a limitation, never guessed. |
| `displays` | Display indexes for `previewBar`, one item per display (at most 8). A display that does not exist is reported unavailable with a reason, not `false`. |
| `executors` | Executor numbers on the user's current page (at most 32, no duplicates): one `executor` item (assignment) and one `fader` item per fader token each. |
| `sequences` | Sequence numbers (at most 32): one `sequenceActive` item each. |
| `fader_tokens` | Fader tokens read per executor (default `FaderMaster`, at most 4). |

With no arguments every parameterless reader is read, `previewBar` on display 1.

## Result

```json
{
  "context": { "observedAt": 1760000000.12, "epoch": 1, "atomic": false, "identity": { "showFile": "mcp-test-disposable", "user": "Admin", "profile": "Default" }, "invalidated": null, "bridgeVersion": "0.8.0", "module": { "component": "gma3_mcp_feedback", "version": "0.2.0" }, "count": 3, "truncated": 0 },
  "items": [ { "name": "blind", "key": "blind", "scope": "show", "source": "ShowData.Masters.Grand.Blind.FADERENABLED", "available": true, "value": true, "observedAt": 1760000000.12, "epoch": 1 } ],
  "byKey": { "blind": { "...": "same item" }, "previewBar[display=2]": { "available": false, "value": null, "reason": "display 2 does not exist on this console", "params": { "display": 2 } } },
  "limitations": [],
  "note": "..."
}
```

Every item carries:

| Field | Meaning |
| --- | --- |
| `available` | `true`: the console supplied a usable value, which is in `value` (a `false` value is an observation). `false`: `value` is `null` and `reason` (nil from the console, an unrecognised value, a missing display/sequence/executor, an unimplemented reader such as `freeze`) or `error` (the reader raised) says why. One failing item never affects the others. |
| `scope` | What the value belongs to (KB-01): `show` (masters, sequence activity, fader level), `profile` (Preview mode, shortcut enablement), `user` (current page, selected sequence), `page` (executor assignment on the user's current page), `display` (Preview bar), `ui` (command line of the plugin user), `console` (aggregate MA state). Cross-user behaviour beyond the single-user probes is not verified; do not read stronger scope guarantees into these values. |
| `source` | The console property or call that was read. |
| `observedAt` | Bridge clock (seconds) at the moment that item was read. Items of one call are read one after another: **a result is not an atomic snapshot** of the console. |
| `epoch` | The feedback instance's invalidation counter. It starts at 1 at every bridge start and increments when the show file, user or user profile changed since the previous read (checked at most once per second); `context.invalidated` names the change (`show-changed`, `user-changed`, `profile-changed`) on the call that noticed it. Compare epochs before combining observations from several calls. |
| `key` | `name` plus the identifying parameters: `previewBar[display=2]`, `executor[executor=201]`, `fader[executor=201,token=SpeedMaster]`, `sequenceActive[sequence=5]`. |
| `note` | What the value does and does not mean, where that matters (below). |

### Value meaning

- **`commandText`** is the raw command-line text of the plugin's user. No keyword is inferred from it.
- **`lastCommand`** is the console's last command feedback, a shared history: it is an observation, not
  confirmation that a particular request, client or key event produced it. Several clients and the operator write
  into the same history.
- **`maState`** is the aggregate MA state of every Shift source (injected or physical). It identifies no owner.
- **`sequenceActive`** is `Sequence:HasActivePlayback()`: playback activity of the sequence, not proof that a given
  executor started it nor that an executor button is held. **`executor`** is the assignment on the user's current
  page (`empty`, `assigned {name, class, addr, no}`, `page`); **`fader`** is the master level of the assigned object
  (`value` 0..100, `text`, `token`, `target`). Assignment, level, activity and selection are separate readers and
  are never combined into one state. Button ownership is not console state at all: it is the input module's
  ownership record (`gma3_hardkeys_status`).
- **`previewBar`** is the display-local pending Preview; it does not say which display injected input routes to
  (input is not display-scoped on onPC 2.5.1).
- **`selectedSequence`** reports `{selected: false}` when the console has no selected sequence; that is an
  observation, not an unavailable value.
- **`freeze`** is always unavailable: KB-01 found no readable Freeze state, and the module never substitutes a
  false value. The reader stays listed so a consumer can tell "unknown" from "off".
- The compatibility alias `executorActive` (module 0.1.0) still answers through the bridge op (`alias:
  "sequenceActive"` plus a deprecation note) but the tool does not offer it.

### What a read does not do

- It does not change selection, command text, programmer, playback or UI focus, and it opens no input session:
  verified live (command line and `ping.input` unchanged across the probe).
- It does not wait for the mutation lock of this server and is never refused `[busy]`: while another client owns an
  input interaction (`cmd` and `lua` are `[busy]`), `gma3_feedback` still answers (live probe, two connections).
- It serves no cached value: every item was read for this call at its `observedAt`. (The module's cached
  `watch()`/`snapshot()` path exists for surface consumers and is not exposed through the bridge.)

### Bounds

Per request the module reads at most 64 items; `executors` and `sequences` are expanded to at most 32 targets each
(the tool refuses longer lists up front, the bridge reports a truncation as a limitation). A read of all parameterless
readers plus three displays took 19 ms on the test host; 32 executors with assignment and fader took 52–60 ms. Poll
at the rate the consumer needs, not faster than it can act on; a surface consumer should use the module's bounded
`watch()`/`service()` instead of hammering `feedback.read`.

## Mapping to the mtpnxk surface feedback schema

`mtpnxk-client-pico/docs/ma3-feedback.md` is the surface project's own schema. **It was not available in this
workspace when KB-06 was implemented** (the file is external to this repository), so the mapping below is written
from the reader results and must be reconciled against that document before KB-07 starts. LED colours, blinking
and device message formats stay in the surface consumer; the module hands over observations only.

| Reader (key) | Scope | Likely surface use | Caveat for the consumer |
| --- | --- | --- | --- |
| `blind`, `highlight`, `solo` | show | Blind / Highlight / Solo key LEDs | `available=false` must render as "unknown", never as off |
| `previewMode` (`"Preview"` / `"Normal"` …) | profile | Preview key LED (mode) | string compare on the environment name; other names are possible |
| `previewBar[display=N]` | display | pending Preview indication | per display; not a routing promise for injected input |
| `shortcutsActive` | profile | ShCuts indicator / text-entry capability | input routes depend on it (KB-04) |
| `maState` | console | MA key LED | aggregate of every Shift source; not the surface's own hold |
| `page` | user | page display | `{name, no}` |
| `selectedSequence` | user | selected-sequence display | `{selected:false}` is a value |
| `executor[executor=N]` | page | executor assigned / empty | assignment only |
| `fader[executor=N]` | show | fader level / motorised fader position | `value` 0..100 plus display `text` |
| `sequenceActive[sequence=N]` | show | executor "running" LED | activity of the sequence, not the button |
| `commandText`, `lastCommand` | ui | status line | raw; shared history |
| `freeze` | show | Freeze key LED | always unknown on 2.5.1 |
| epoch / `invalidated` | — | clear all LEDs to "unknown" | after show/user/profile change, disconnect or restart |

Button ownership (which keys the surface itself holds) comes from the surface's own hardkeys instance, not from feedback.

## Live test procedure

`node scripts/kb06-probe.mjs verify` is read-only (any show); `node scripts/kb06-probe.mjs run` additionally toggles
Blind, moves one fader and runs one Go+/Off on a show whose name looks disposable, restoring each. Record:
[kb-06-feedback-macos-2.5.1.md](../probes/kb-06-feedback-macos-2.5.1.md).
