# Rules for work items on the gma3-mcp workflow tools

These apply to every FR-03 .. FR-10 work item. Read FEATURES.md (the requirements) first.

## Architecture (from FEATURES.md, non-negotiable)

- MCP -> TypeScript -> JSON-lines TCP -> Lua bridge. No new transport, no shared files, no second dispatcher.
- Tools marked "Lua changes: No" use only the existing bridge ops: `cmd`, `object`, `children`, `objects`, `set`,
  `setfader`, `getfader`, `executor`, `executors`, `dump`, `ping`. Never generate code for the `lua` op.
- Never retry a mutation after an uncertain outcome. Never fall back to OSC. A timeout proves nothing.
- Report through the shared result model in `src/results.ts`:
  outcome `succeeded | failed | partial | unknown`, verification `matched | mismatched | unavailable | not_requested`,
  one `StepResult` per bridge request. Use `commandStep`, `requestStep`, `runSteps`, `buildResult`,
  `validationFailure`, `compareFields`. Wrap the handler body in `operation(async () => ...)` from
  `src/tools/context.ts` so non-success is an MCP tool error with the full result retained.
- Validate with `src/validate.ts` (`Validator`, `timeSeconds`, `cueNumber`, `objectNumber`, `percent`,
  `mutuallyExclusive`, `exactlyOne`, `objectName`, `needsPropertySet`, `quoteName`, `attributeName`,
  `fixtureSelection`, `safeRef`, `oneOf`). Add module-local validators if you need more; do not edit validate.ts.
- Every mutation runs inside `ctx.mutations.run(async () => { ... })` (one lock span per tool call, covering
  all its steps and its read-back). Read-only tools do not take the lock.
- Read-back uses `readFields` / `exists` / `readObjects` from `src/tools/common.ts` (built on the `objects` op).
- Zero is a value. Never treat 0 as "not given".

## Files you may touch

Only the files named in your work item. Do NOT edit: `src/index.ts`, `src/results.ts`, `src/validate.ts`,
`src/mutations.ts`, `src/tools/context.ts`, `src/tools/common.ts`, `README.md`, `package.json`,
`test/helpers/*`, `test/live/live.ts`, `test/live/README.md`, or another work item's files. If a shared helper
is missing, implement it locally in your module and say so in your report.

## Tests

- Unit tests: `test/<area>.test.ts` using `startHarness(registerXTools)` from `test/helpers/tool-harness.ts`
  (in-process, FakeBridge scripted per op, `SILENT` for a lost reply). Cover every acceptance criterion
  that can be checked without a console, including failure between steps and uncertain outcomes.
- Live tests: `test/live/<area>.live.ts` using `liveTest` / `cmd` from `test/live/live.ts`. They are not run by
  `npm test`. Document at the top of the file exactly which show objects they create/modify and clean up
  (see `test/live/README.md` for the reserved ranges). Do NOT run them.
- `npm run build` and `npm test` must pass when you finish.

## The live console

A real bridge is reachable through the `mcp__gma3__*` tools and the loaded show is the user's REAL show.
You may use it READ-ONLY to confirm syntax and property names: `gma3_help` (manual pages, e.g. topics
"Store", "Assign", "Label", "Goto", "Delete", "Attribute", "At", "Fade", "Delay", "Part", "ClearAll"),
`gma3_get_object` with `schema: true` (property names of a cue, sequence, executor, fixture),
`gma3_list_children`, `gma3_objects`, `gma3_cues`, `gma3_sequences`, `gma3_executors`, `gma3_fixtures`,
and `gma3_lua` ONLY with read-only expressions (Get/Children/Count/ObjectList). Never run `gma3_command`,
`gma3_set_property`, `gma3_playback`, `gma3_set_fader`, or Lua that calls Cmd()/Set()/Store/Delete/Assign/
Goto/Select/Clear/At. If you are unsure whether something mutates, do not run it.

## Documentation

Write `docs/tools/<area>.md`: each tool, its parameters, exactly what commands it sends (in order), whether it
changes the selection, whether it clears programmer values, what it verifies, the serialisation caveat (the
lock orders only this server's mutations; it does not isolate from another operator or client), units, and
the live test procedure. Tool `description` strings must carry the same essential facts (selection change,
programmer impact, verification scope, what is NOT verified).

## Report

Finish with: tools implemented, commands used per tool, acceptance criteria met / not met and why, anything
that is not purely additive, console syntax you could not confirm from the manual and that needs the live test.
