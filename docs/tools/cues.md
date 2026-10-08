# Cue tools (FR-04, FR-05)

Six tools in `src/tools/cues.ts` for storing, editing, navigating and deleting cues. They use only the existing
bridge ops `cmd`, `set`, `object` and `objects`; no Lua is generated. Every tool returns the shared
`OperationResult` (`outcome`, `verification`, one `StepResult` per bridge request) and surfaces anything but a
verified success as an MCP tool error.

## Common behaviour

**Target.** Every tool needs exactly one of `sequence` (number) or `use_selected_sequence: true`, plus `cue` (a
single cue number, fractional allowed, max three decimals: `2`, `2.5`, `"10.001"`). Ranges (`Thru`, `+`) are
rejected by validation before anything is sent. With `use_selected_sequence` the tool first reads
`SelectedSequence` through the `object` op (step `resolve_sequence`) and then uses the explicit
`Sequence <n>` number for every command and read-back; if no sequence is selected the operation fails before
anything is sent. The result's `target` reports the resolved number and `sequenceSource: "explicit" | "selected"`.

**Existence checks.** Tools that need an existing target (`set_cue_timing`, `set_cue_trigger`, `goto_cue`,
`delete_cue`) and `store` in `create` mode read the target with the `objects` op first. A missing target is
`outcome: failed` with the check step failed, the mutation step `skipped`, and nothing sent. If the read itself
fails the operation also stops before sending. The check is a point-in-time read, **not a transaction lock**:
another operator can create or delete the object between the check and the command.

**Steps and stopping.** Steps run in order inside `ctx.mutations.run(...)` and stop at the first step that is not a
confirmed success. Later steps are reported as `skipped`. Nothing is ever retried: a lost reply (timeout or
dropped connection after dispatch) is a `unknown` step and the whole operation is `unknown`.

**Read-back.** Verification is reported separately from the mutation steps and never changes the `outcome`. It
runs whenever `verify` is not `false` and the primary mutation step was actually sent (succeeded *or* unknown, so
after a lost reply the client still learns what the console shows). It reads through the `objects` op
(`readFields` / `exists` in `common.ts`). Status: `matched`, `mismatched` (also an MCP error), `unavailable` (the
read failed, or the mutation was never sent), `not_requested`.

**Units.** All times are seconds (`fade`, `delay`, `out_fade`, `out_delay`, `snap_delay`, `time`), 0..3600, finite;
**0 is a value** and is sent as `0`. Negative or non-finite values are rejected.

**Serialisation caveat.** Each tool holds the mutation lock for its whole sequence, from the first check through
the commands to the read-back, so another tool call from this server (including `gma3_lua`) cannot change the
cue between a store and its verification. The lock orders only this MCP server's own mutations. It does **not**
isolate an operation from another console operator, another MCP server or anything else talking to the console. Treat `matched` as "the console showed this right after the operation".

**Selection and programmer.** None of these tools changes the fixture selection and none clears the programmer
(no `Clear*` command is sent). `Store` stores whatever is active in the programmer into the cue; with an empty
programmer it creates an empty cue. The console's own store preferences still apply.

**Names.** The console strips `\ " $ & * ? , . ; ^ { } | ~` from any name it is given (so `"Look 2.5"` would
become `"Look 25"`) and trims whitespace. `objectName()` therefore **refuses** a name containing any of those
characters (validation error "... removes from names ...") and passes the trimmed name on. Names are never put on
the command line; they are written with the `set` op to the **Part** (part 0 for a cue), because `Set(Name)` on a
Cue object is silently ignored while setting it on part 0 updates the cue's displayed Name.

**Console facts the tools rely on (confirmed live on grandMA3 onPC 2.5.1).** Cue timing lives on the **Part**
(`Sequence n Cue c Part p`). The writable properties are `CueInFade`, `CueInDelay`, `CueOutFade`, `CueOutDelay`
and `SnapDelay`; `CueFade` / `CueDelay` are composite display values (`"0.00 / 1.50"` when in and out differ) and a
`Set()` on them is silently ignored, so the tools never write or compare them. Setting `"0"` reads back `"0.00"`;
an out value that was never set reads `CueTiming` (inherit). Part 0 is the cue's main part and always exists once
the cue exists. The trigger lives on the **Cue**: `TrigType` (enum `CueTrigger` = Go, Time, Follow, Sound, BPM;
there is no timecode trigger type; setting Go resets `TrigTime` to 0.00) and `TrigTime` (`"4"` reads back
`"4.00"`). Store, Goto, Delete and Off answer `OK`. A reference to a missing cue, part or sequence resolves to an
empty object list.

---

## gma3_store_cue

Store the programmer content as a cue.

| Param | Type | Notes |
| --- | --- | --- |
| `sequence` / `use_selected_sequence` | number / boolean | exactly one |
| `cue` | number or string | single cue number, fractional allowed |
| `mode` | `"create"` \| `"merge"` \| `"overwrite"` | required, exactly one value; `merge` and `overwrite` are distinct modes and cannot be combined |
| `name` | string | optional; trimmed; refused if it contains `\ " $ & * ? , . ; ^ { } \| ~` or control characters |
| `fade`, `delay`, `out_fade`, `out_delay` | seconds | optional; 0 is a value |
| `verify` | boolean | default true |

Commands, in order:

1. `resolve_sequence` (`object` op, only with `use_selected_sequence`).
2. `check_existing` (`objects` op, **create mode only**): refuses with `outcome: failed` and sends nothing if
   `Sequence n Cue c` exists. Not a transaction lock (see above).
3. `store` (`cmd`): `Store Sequence <n> Cue <c> /NoConfirmation`, with ` /Merge` or ` /Overwrite` inserted before
   `/NoConfirmation` for those modes. A mode option plus `/NoConfirmation` is always sent so the console never
   opens the "choose store mode" pop-up, which would block its Lua task.
4. `set_name` (`set` op, only when `name` is given): property `Name` on `Sequence n Cue c Part 0` (the cue's
   displayed Name follows part 0; setting Name on the Cue object itself is ignored by the console).
5. `set_fade`, `set_delay`, `set_out_fade`, `set_out_delay` (`set` op, one per given field): properties
   `CueInFade`, `CueInDelay`, `CueOutFade`, `CueOutDelay` on `Sequence n Cue c Part 0`.

Verification reads `No`, `Name` from the cue and the given timing fields (`CueInFade`, `CueInDelay`, `CueOutFade`,
`CueOutDelay`) from Part 0, and compares `Name` and the timing values that were given. A cue that does not exist
after the store is `mismatched`.

**Not verified:** the stored fixture values (attribute data). The result says so in `summary` and
`notVerified`; that needs `gma3_cue_contents` (FR-10).

Programmer: not cleared. Selection: unchanged.

## gma3_store_cue_part

Same as `gma3_store_cue` plus a required `part` (integer 0..999). Command: `Store Sequence <n> Cue <c> Part <p>
[/Merge|/Overwrite] /NoConfirmation`. `name` is set on the part (`Sequence n Cue c Part p`, property `Name`) and
timing on the same part.

**Part 0** is the main part that every cue has, created together with the cue. Storing to part 0 is the same as
storing the cue itself, so `mode: "create"` refuses part 0 of an existing cue (use `merge`/`overwrite`); the
result carries `partZeroNote`. Parts 1..999 hold their own values and timing.

Verification reads `Part`, `Name` and the given timing fields from the part. Fixture values are not verified.

## gma3_set_cue_timing

Edit timing of an existing cue part. Params: target, optional `part` (default 0), and any of `fade` (CueInFade),
`delay` (CueInDelay), `out_fade` (CueOutFade), `out_delay` (CueOutDelay), `snap_delay` (SnapDelay), in seconds; at
least one is required; 0 is a value. The composite `CueFade` / `CueDelay` properties are never written.

Steps: `resolve_sequence` (if selected) -> `check_target` (`objects`, the part must exist; otherwise failed,
nothing sent) -> one `set_<field>` (`set` op) per given field on `Sequence n Cue c Part p`. **Only the given
fields are changed.** No command-line command is used.

Verification reads the given properties back from the part and compares them (`"3.00"` matches `3`).
Result extras: `changed` (property -> value). Selection and programmer: unchanged. Fixture values: untouched.

## gma3_set_cue_trigger

Set how an existing cue is triggered.

| `trigger` | console `TrigType` | `time` (TrigTime, seconds) |
| --- | --- | --- |
| `go` | Go | not allowed |
| `time` | Time | **required** (0 allowed) |
| `follow` | Follow | optional (extra delay after the previous cue completes) |
| `sound` | Sound | not allowed |
| `bpm` | BPM | not allowed |

Steps: `resolve_sequence` (if selected) -> `check_target` (`objects`, cue must exist) -> `set_trig_type` (`set`
op, `TrigType` = enum name) -> `set_trig_time` (`set` op, `TrigTime`, only when `time` is given). No command-line
command. Verification reads `TrigType` and `TrigTime` and compares `TrigType` and, when given, `TrigTime`.
Selection and programmer: unchanged.

## gma3_goto_cue

**Playback mutation.** Params: target, optional `fade` (seconds, overrides the cue's own timing).

Steps: `resolve_sequence` (if selected) -> `check_target` (`objects`, cue must exist, otherwise nothing is sent)
-> `goto` (`cmd`): `Goto Sequence <n> Cue <c>` or `Goto Sequence <n> Cue <c> Fade <s>`.

A `succeeded` outcome means the console **accepted** the command. The crossfade runs asynchronously; the tool
does not claim it completed. Verification is `not_requested` (the sequence's current cue is not read back; use
`gma3_cues` / `gma3_get_object` to inspect playback state). Selection and programmer: unchanged.

## gma3_delete_cue

Delete exactly one explicit cue. Params: target, `verify`.

Steps: `resolve_sequence` (if selected) -> `check_target` (`objects`; a missing cue is `failed` and nothing is
sent) -> `delete` (`cmd`): `Delete Sequence <n> Cue <c> /NoConfirmation`.

Verification re-reads existence: gone -> `matched`; still there -> `mismatched`; unreadable -> `unavailable`. A
lost reply is `outcome: unknown`, never resent; the read-back then tells the client whether the cue is still
there. Range deletion (`Thru`, `+`) is outside scope and rejected by validation. Deleting parts is not offered.
Selection and programmer: unchanged.

---

## Live test procedure

`test/live/cues.live.ts` (run with `GMA3_LIVE=1 npm run test:live` against a disposable show; skipped if
Sequence 900 already exists). It touches **Sequence 900 only**:

1. Stores Cue 1 (named), refuses a second `create` of Cue 1 without sending, refuses the name `"Look 2.5"` by
   validation, stores Cue 2 with `name: "MCP live 2"`, `fade: 3`, `out_fade: 1.5`, `delay: 0` (checks the cue's
   Name and the part's CueInFade/CueOutFade/CueInDelay), stores Cue 2.5, merges into Cue 2, stores Cue 2 Part 1
   with `delay: 0.5`.
2. `set_cue_timing` on Cue 2 Part 0 (`fade: 0`, `out_delay: 2`) and checks that the untouched `CueOutFade` is
   still 1.5; sets `snap_delay` on Part 1.
3. `set_cue_trigger` on Cue 2.5: follow, then time 4 (reads back TrigType/TrigTime), then go.
4. `gma3_goto_cue` Sequence 900 Cue 2 with `fade: 0` (starts the sequence as a playback; the cues are empty if
   the programmer was empty).
5. `delete_cue` of a missing cue (refused), then of Cue 2.5 (verified gone; cues 1 and 2 remain).
6. Cleanup: `Off Sequence 900`, `Delete Sequence 900 /NoConfirmation`.

What the live run confirms that the unit tests cannot: that the console accepts the exact `Store ... /Merge
/NoConfirmation` and `Store ... Part p` forms without a pop-up, that `Set()` of `Name` (on the part), `CueInFade`,
`CueOutFade`, `CueInDelay`, `SnapDelay`, `TrigType`, `TrigTime` accepts the text values the tools send, and the
display format of the read-back values.
