# Executor tools (FR-06)

Two workflow tools assign sequences to executors and label executors without hand-built command
strings. Both run on the existing bridge ops only (`objects` and `cmd`); no Lua was added and
nothing here needs `gma3_lua`.

## The one thing to know first: an executor has no label of its own

On grandMA3 onPC 2.5.1 (verified live) an executor displays the name of the object assigned to
it. `Page 90.201` reads `Name = "Sequence 901"` and `Object = "Sequence 901"` right after
`Assign Sequence 901 At Page 90.201`; writing the executor's `Name` property is silently ignored;
and `Label Page 90.201 "ExecLabel"` returns OK and renames the **assigned sequence**: afterwards
the executor's Name and Object and `Sequence 901`'s Name are all `"ExecLabel"`.

Both "label" features below are therefore defined as **label the object assigned to this
executor**. The new name appears everywhere that object does: in its pool, in cue lists and on
every other executor it is assigned to.

## Shared behaviour

- **Explicit addressing.** Every call names the page and the executor. Objects are addressed as
  `Page <p>.<e>`, which resolves the Executor object on any page, not only the current one. The
  page must already exist (the manual: "the page needs to exist before it can be addressed"); the
  tools check that read-only and refuse before sending anything if it does not. `Store Page <p>
  /NoConfirmation` creates a page (verified).
- **Executor numbers** are `row*100 + column`: 101-190 (keys), 201-290 (faders), 301-390 and
  401-490 (knobs), plus the Xkeys 191-198 and 291-298. Anything else is a validation error.
- **Names.** Labels go through the shared `objectName()` validator: the characters
  `\ " $ & * ? , . ; ^ { } | ~` are refused up front because the console silently strips them from
  names (verified), leading/trailing spaces are trimmed, and control characters, empty names and
  names over 200 characters are refused. A label is therefore never silently altered by the
  console, and it can always be placed in a command line.
- **No playback.** Neither tool ever sends Go, On, Off, Toggle, Flash or any other playback
  keyword. Assigning a sequence does not start it.
- **Selection and programmer.** Neither tool changes the fixture selection or touches the
  programmer. Whether the console changes the *selected sequence* when a sequence is assigned is
  console behaviour the tools do not control; the live test prints it.
- **Serialisation caveat.** All mutations run inside this server's mutation lock, so two tool
  calls from this server never interleave. The lock does not isolate anything from another
  console operator, another MCP server or any other client: an executor can change between the
  inspection step and the Assign command.
- **Result model.** Results follow `src/results.ts`: `outcome` (`succeeded | failed | partial |
  unknown`), `verification` (`matched | mismatched | unavailable | not_requested`) and one step per
  bridge request. Read-only inspection and read-back steps carry `kind: "read"` and never count as
  completed work: a refusal or failure before the first mutation is `failed` (nothing was sent),
  the deliberate no-op "already assigned" is `succeeded`, and a read-back that cannot be
  performed after a mutation makes the outcome `partial` with verification `unavailable`.
- **Uncertainty.** A lost reply or unfamiliar console feedback makes the step `unknown`; the
  command is never resent. The read-back still runs after an `unknown` or `partial` mutation so the
  client can see the resulting state; the outcome stays `unknown`/`partial`.

## gma3_assign_to_executor

Assign a sequence to an executor on an explicit page, optionally labelling (renaming) it in the
same call.

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `sequence` | integer >= 1 | yes | Sequence number. Must exist. |
| `page` | integer 1-9999 | yes | Executor page. Must exist; the tool does not create pages. |
| `executor` | integer | yes | Executor number on that page (see numbering above). |
| `replace` | boolean, default `false` | no | Replace an executor that holds a different object. |
| `label` | string | no | New name for the assigned sequence (see Names above). |
| `verify` | boolean, default `true` | no | Read the executor (and the sequence, when labelled) back and compare. |

Requests, in order (each is one step in the result):

1. `objects` `Sequence <n>` fields `Name` (read-only, `asText=false`). Missing sequence: step
   `check_sequence` fails, nothing else is sent.
2. `objects` `Page <p>` (read-only). Missing page: step `check_page` fails with a hint to create
   the page (`Store Page <p>`), nothing else is sent.
3. `objects` `Page <p>.<e>` fields `Object`, `Name` (read-only). This is the `previous` assignment.
   With `asText=false` the `Object` field is the assigned object's handle summary (`name`, `class`,
   `addr`, `index`), so identity is compared by address, not by name: a different sequence that
   happens to share the name is still "a different object".
   - Executor holds a different object and `replace` is false: step `assign` is recorded as
     `failed` with the message "pass replace: true", outcome `failed`, **no command sent**,
     `previous` in the result.
   - Executor already holds this sequence: the Assign command is skipped, `alreadyAssigned: true`,
     `command: null`; the label step (if any) and the read-back still run. Outcome `succeeded`.
4. `cmd` **`Assign Sequence <n> At Page <p>.<e>`** (manual syntax; returns "OK" on 2.5.1).
5. If `label` is given: `cmd` **`Label Page <p>.<e> "<label>"`**. This renames Sequence `<n>` (see
   above); the result carries a warning saying so. If this fails after the assignment, outcome is
   `partial`.
6. If `verify`: `objects` `Page <p>.<e>` fields `Object`, `Name` again (`resulting`), and, when the
   label step ran, `objects` `Sequence <n>` fields `Name` (`sequenceNameAfter`).

Verification compares the read-back against `{ object: <expected name>, objectClass: "Sequence" }`
where the expected name is the label when the label step ran, else the sequence's name before the
call; with a label it also checks `name` (the executor's displayed name) and `assignedObjectName`
(the sequence's own Name) against the label. **Not verified:** executor configuration, key / fader
/ encoder functions, fader level, playback state, and whether the executor is visible on the
current page.

Result extras: `previous` and `resulting` (`{ empty, name, object: { name, class, addr, index } }`),
`alreadyAssigned`, `replaced`, `command`, `sequenceName` (before), `sequenceNameAfter` (with label).

## gma3_label_executor

Label the object assigned to the executor at `Page <p>.<e>` (renames it; see the top of this page).

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `page` | integer 1-9999 | yes | Executor page. Must exist. |
| `executor` | integer | yes | Executor number on that page. |
| `label` | string | yes | The new name for the assigned object (see Names above). |
| `verify` | boolean, default `true` | no | Read the executor and its assigned object back and compare. |

Requests, in order:

1. `objects` `Page <p>` (read-only). Missing page: failed, nothing sent.
2. `objects` `Page <p>.<e>` fields `Object`, `Name` (read-only). An empty executor (no executor
   object on that page, or one without an assigned object) has nothing to label: failed, nothing
   sent. The result carries `previous`.
3. `cmd` **`Label Page <p>.<e> "<label>"`**.
4. If `verify`: `objects` `Page <p>.<e>` fields `Object`, `Name`, then `objects` on the assigned
   object (`<class> <index>`, e.g. `Sequence 901`, reported as `assignedObjectRef`) fields `Name`.
   Expected: executor Name == label, assigned object's name (as seen from the executor) == label,
   and the object's own Name == label. If the assigned object cannot be addressed, only the
   executor's view is verified and a warning says so.

The result always carries a warning naming the object that was renamed.

## Units

Only identifiers: sequence, page and executor numbers are integers. No times or levels are involved.

## Live test procedure (`test/live/executors.live.ts`)

Not part of `npm test`. On a disposable show (name matching `GMA3_LIVE_SHOW`) with an empty
programmer, run `GMA3_LIVE=1 npm run test:live`. The test:

1. Refuses to run if Sequence 901/902 exist or Page 90.201-90.203 are occupied.
2. Creates Page 90 (`Store Page 90 /NoConfirmation`) if missing, and Sequence 901 and 902 with
   `Store Sequence 90x Cue 1 /NoConfirmation` (creates the sequence with an empty programmer).
3. Assigns 901 to 90.201 with label `MCP Exec A`; checks the read-back matched, that Page 90.201
   shows the label and that Sequence 901 itself is now named `MCP Exec A`; prints whether
   SelectedSequence changed.
4. Re-assigns 901 (expects `alreadyAssigned`, no command), tries 902 without `replace` (expects a
   refusal with nothing sent) and with `replace` (expects success).
5. Assigns 901 to 90.202 and labels it `MCP Exec B` through gma3_label_executor (expects matched
   on both the executor and `Sequence 901`), then tries `MCP "B" v1.0` (expects a validation
   refusal with nothing sent and no change).
6. Tries to label the empty 90.203 (expects a refusal with nothing sent).
7. Cleans up: `Delete Page 90.201 /NoConfirmation`, `Delete Page 90.202 /NoConfirmation`
   (removes the assignment on a non-current page, verified), `Delete Sequence 901 /NoConfirmation`,
   `Delete Sequence 902 /NoConfirmation`, and `Delete Page 90 /NoConfirmation` only if the test
   created the page. Nothing calls SaveShow.

All command syntax used by the tools and this test has been confirmed on onPC 2.5.1.
