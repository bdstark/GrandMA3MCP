# Cue lists and chases in batches (SU-06)

`gma3_store_cues`, `gma3_edit_cues`, `gma3_build_chase` in `src/tools/cuelists.ts`. No bridge change: the looks use
the SU-05 commands and programmer read-back (preset links need bridge 0.27.0), and the cue properties the FR-04 /
FR-05 `set` writes. Evidence: [SETUP.md](../../SETUP.md) SU-06 and the
[SU-06 record](../probes/su-06-cuelists-macos-2.5.1.md).

## Content: looks

A cue's content is one look or several. A look is a target and what to give it:

| Field | Meaning |
| --- | --- |
| `fixtures` | the target (`"101 Thru 112"`, `"Group 3"`); defaults to the call's `fixtures` |
| `presets` | presets applied in order, each `{pool, preset}` (number or name), `At Preset P.N` |
| `intensity` | 0–100 %, `At <value>` |
| `values` | attribute values as in `gma3_set_attributes` (`attribute`, `value`, `unit`), applied after the presets |

A cue gives either the shorthand fields (`fixtures`, `presets`, `intensity`, `values`: one look) or `looks` (up to
16). Looks are applied in order, so a later look wins on fixtures they share. Setting one colour attribute
activates the fixture's whole colour group (KB-17), so a cue can hold more values than were given.

## How a batch is built

1. **Inspection** (read-only; nothing is sent when it fails):
   - the sequence and its cues; mode `create` refuses when any of the cues exists;
   - every preset, which must exist exactly once;
   - every attribute name, which must exist in the show;
   - every fixture expression, which must match something;
   - the Normal programmer, which must be readable, with the console in Normal.
2. **`Preview On`.** The Preview programmer must then be empty, shown by a complete scan with a value count (an
   incomplete scan proves nothing). If it is not, or cannot be shown to be, only `Preview Off` is sent, because that
   content may belong to someone else.
3. **Per cue, in order:**
   - confirm the console is still in Preview, then `ClearAll` (the programmer keeps the previous cue's values after
     a store);
   - for each look: `ClearSelection`, the select, each preset followed by its check, then the intensity and the
     values followed by theirs (below);
   - `Store Sequence N Cue C [/Merge|/Overwrite] /NoConfirmation`;
   - `Name` and the timing on Part 0, `TrigType` / `TrigTime` on the cue.
4. **Leaving Preview.** The console is confirmed in Preview, then `ClearAll` and `Preview Off`, whatever happened.
   The Normal programmer is read again and must equal the snapshot from step 1.
5. **Sequence name** (`sequence_name`, or `name` for a chase), written once a cue was stored.
6. **Read-back** per stored cue: it exists, and its name, timing and trigger as given. A cue stored without a name
   takes the preset's name (`[4.902]`), and the result reports that name.

**The look check.** Each check runs in the Preview programmer right after the command it verifies:
- every preset must be linked on every selected fixture or its cells, as `gma3_apply_preset` checks, right after its
  recall: a later preset of the same look may take over its channels, which is the order asked for;
- the intensity and values are compared per fixture and cell, as `gma3_set_attributes` compares them.

A look that did not apply is a mismatch, and **the batch stops before that cue is stored**. Cues already stored
stay; nothing is undone or retried. A check that cannot be completed is `unavailable`; the cue is stored and its
verification says so.

**Not verified:** the values stored in a cue. 2.5.1 has no GetCueData, so the values cannot be read back from the
cue. The look check is the evidence that the programmer held the right values at the store.

**Results.** `cues` lists every cue with:
- `status`: `stored`, `failed`, `unknown` or `not_attempted`;
- its verification (`looks`, then properties);
- the name it has;
- the first error.

`stored` counts the stored cues. `normalProgrammer` is `untouched`, `changed` (a mismatch), `unknown` or
`not_entered`. `Preview On` is a mutation, so a build that stops after it is `partial` even when nothing was stored.

**exclusive: true** is required: the console is in Preview while the batch runs and nobody else may use it.

## gma3_store_cues

| Param | Notes |
| --- | --- |
| `sequence` | sequence number; the store creates it when it does not exist |
| `sequence_name` | optional |
| `mode` | `create` (refuse existing cues), `merge`, `overwrite` |
| `fixtures` | default target for looks without their own |
| `cues` | 1–100 cues: `cue` (number), `name`, content, `fade`, `delay`, `out_fade`, `out_delay`, `trigger` (`go`, `time` with `time`, `follow` with optional `time`, `sound`, `bpm`) |
| `exclusive`, `verify` | `exclusive` required; `verify` default true (look checks and read-back) |

Tracking is the sequence's own setting: with Tracking on, a cue's stored values track into later cues that do not
store those attributes.

### Batch form and compact results (SU-12)

`sequences: [{sequence, sequence_name, mode, fixtures, cues}]` stores cues in several sequences; each sequence is its
own Preview build with the steps above, and `mode`, `fixtures` and `exclusive` may be given once for all. A sequence
listed twice is refused. See [Batch forms](README.md#batch-forms-su-12).

The results of `gma3_store_cues` and `gma3_build_chase` are compact by default:
- one line per cue: `{cue, status, verification, name}`, with `error`, `detail` and `looks` only for a cue that did
  not match;
- the observed cycle with `observedCues` (the cue order seen) and `intervalsMs` instead of every sample;
- only the steps that did not succeed, with `stepCounts` for the rest.

`detail: true` returns every step, look and sample. An 18-step chase's compact result is about 4 KB.

### Commands, preset ranges, replace, phasers in looks, settings and overrides (SU-14)

- **Commands.** `command` per cue (`gma3_store_cues`, `gma3_build_chase` steps) or `command` / `commands` in
  `gma3_edit_cues`. The command lives on the cue's Part 0 (`Command`) and is read back. A cue with a command needs no
  look: it is stored from the empty Preview programmer, as a clock or a switch cue. Its `$variables` must exist or be
  set by an earlier cue command, checked before anything is sent (SU-15, [variables.md](variables.md)).
- **Preset ranges.** `presets: {pool, from, to}` stores one cue per existing preset of the range on `fixtures`,
  numbered from `first_cue` and named after the preset, with the call's timing and trigger. In `gma3_build_chase`,
  `presets` takes a range too. The console reads the range as `Preset 21.11 Thru 14`.
- **`replace: true`** deletes every existing cue (`Delete Sequence N Cue 1 Thru`, one step per request) once
  everything else has been checked and Preview is confirmed usable and empty, right before the build. A refused build
  keeps the old cues. With `sequence_settings`, an existing sequence first gets `gma3_configure_sequence`'s read-only
  preview. The sequence object, its settings and its executor assignments stay; the assignments are
  compared before and after (`assignments.kept`). `gma3_build_chase` otherwise refuses a sequence that has cues.
- **A phaser in a look.** `phaser: {steps, phaser, unit}`, the step form of `gma3_build_phaser` (`measure` = beats per
  cycle). It is built on the look's fixtures after the look's presets, intensity and values, then checked in the
  programmer per fixture (cells included), step, layer and phase. An attribute is given once: as a static value or in
  the phaser. Templates are built with `gma3_build_phaser` into a preset, which a look can recall.
- **`sequence_settings`** (as `gma3_configure_sequence` takes them) are applied after the build in the same lock span.
  With a priority above LTP, the result's `override` lists the running sequences of lower priority with Off When
  Overridden on. They are switched off where the override plays on the same fixtures; cue contents cannot be read, so
  every playing candidate is listed. `protect_running: true` turns Off When Overridden off on them. The scan must be complete (every sequence's number, priority, Off When
  Overridden and, for a candidate, its playback state readable) and every protection must succeed and read back; otherwise the override's settings are not applied and a chase is not played. Settings are
  only applied after a complete build with no step that went unanswered.

## gma3_edit_cues

Edits existing cues of one sequence in one call:
- the same trigger (`trigger`, `time`);
- the same timing (`fade`, `delay`, `out_fade`, `out_delay`, `snap_delay`, on Part 0);
- one name per cue (`names`, in cue order).

The cues are chosen with exactly one of `cues` (a list), `from` / `to` (a range, either end optional) or
`all: true`. The tool refuses before sending anything when the sequence or a listed cue does not exist, when the
range is empty, or when the number of names differs from the number of cues. It sends one `set` per property, cue by
cue, stops at the first failure, and reads the written properties back per cue. Stored values and the programmer are
not touched.

### Trigger times when switching triggers (SU-14)

A switch from Time to another trigger sets each cue's TrigTime to 0 on the console, and a switch back to Time keeps the
0. `gma3_edit_cues` lists the times it wipes (`wipedTrigTimes`) and warns. With `keep_times: true` they are first
saved in the sequence's Note as `[gma3-mcp trigtimes 1=2.5 2=4]` (the rest of the note stays). `trigger: "time"` with
`restore_times: true` sets each cue's saved time (`time`, if given, is the fallback for cues without one) and removes
those entries from the note. The saved marker is read back before any trigger changes (a write the console
ignores stops the edit), an unreadable Note or trigger is refused, and only entries whose restored time read back are
removed.

## gma3_build_chase

A chase is built into an **empty or new** sequence: one with cues is refused, since stale cues past the last step
would join the loop.

| Param | Notes |
| --- | --- |
| `sequence`, `name` | the sequence and its name |
| `presets` or `steps` | `presets`: one cue per preset on `fixtures`; `steps`: 2–100 steps, each a look (or `looks`) with an optional `name` |
| `step_seconds` or `cycle_seconds` | the time per step (each cue's TrigTime, at least 0.2 s), or the whole loop divided over the steps |
| `fade` | crossfade per cue (CueInFade); it does not lengthen the step |
| `observe` | play the chase and verify one cycle (default: as `verify`, true) |
| `observe_max_seconds` | default 45, at most 120; keep it under the client's request timeout |
| `leave_running` | default false: the chase is switched off after the observation |
| `exclusive`, `verify` | as above |

The cues are built as in `gma3_store_cues` (mode `create`), every cue with trigger Time and the step time (cue 1 too,
so the loop continues after the wrap), then `WrapAround` is set to Yes and read back. Nothing after the build is
sent unless every cue was stored, every Preview cleanup step succeeded and the console then read back in Normal.

**One observed cycle.** This **plays the chase**, which changes the live output.
- **Preconditions:** the sequence must not already be running. Its rate is read: the rate master's effective BPM / 60
  × RateScale, or its own rate fader. The predicted step is `step_seconds / rate`; a rate of 0 is refused.
- **Plan:** when the full cycle (first cue back to the first, plus one step) fits in `observe_max_seconds`, it is
  observed from cue 1. Otherwise the observation starts at a late cue, so that the last cues, the wrap to cue 1 and
  the step after it fit (`mode: "tail"`).
- **Run:** `Goto Sequence N Cue <start>`, then `CurrentCue` is sampled every 40 ms. Changes are counted from the
  start cue on, since `CurrentCue` keeps the last cue after `Off`.
- **Judgement:** the order must be exactly the expected one, through the wrap. Each step must be within ±max(150 ms,
  10 %) + 80 ms of the predicted step. When the rate cannot be read, only the order is judged.
- **End:** `Off Sequence N` unless `leave_running`.

`cycle` in the result reports:
- the mode, the start cue, the expected order and the observed changes (ms, cue);
- the intervals, the predicted step and the tolerance;
- the problems and notes (another rate, a tail observation).

## Live test

`test/live/cuelists.live.ts` (with `GMA3_LIVE=1`, see `test/live/README.md`). It needs:
- two fixtures with colour from `GMA3_LIVE_CUELIST_FIDS`;
- empty Presets 4.941–4.943 and Sequences 910–912.

It:
1. stores red, green and blue presets;
2. puts an operator value in the Normal programmer;
3. stores three cues from looks (one with two looks) and checks the Normal value survived;
4. edits cues 2–3 (Time 3, fade 0.5, names);
5. builds a 0.5 s three-step chase and watches one full cycle;
6. builds a six-step 1 s chase with `observe_max_seconds: 5` and watches its tail through the wrap.

Everything is deleted afterwards. The chases play for a few seconds.
