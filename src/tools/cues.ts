/**
 * FR-04 / FR-05: cue storage, cue parts, cue timing, cue trigger, Goto and cue deletion.
 *
 * Everything here uses the existing bridge ops only (`cmd`, `set`, `object`, `objects`); no Lua is
 * generated. Every mutation runs inside the shared mutation lock, stops at the first step that is not
 * a confirmed success, and is never retried. Read-back goes through `readFields` / `exists` in
 * common.ts (the `objects` op) and is reported separately from the mutation steps.
 *
 * Console facts this module relies on (confirmed on grandMA3 onPC 2.5.1, see docs/tools/cues.md):
 *   - `Store Sequence <n> Cue <c> [Part <p>] [/Merge|/Overwrite] /NoConfirmation` is valid Store syntax.
 *     Storing into an existing cue without a mode option opens a "choose store mode" pop-up that blocks
 *     the console's Lua task, so the mode option and /NoConfirmation are always sent.
 *     The manual also shows an inline form (`Store Cue 42 "Name" CueFade 6/3 /Merge`), but the command
 *     line forbids many characters inside labels (\ " $ & * ? , . ; ^ { | } ~) and the combined form is
 *     not confirmed, so name and timing are applied with the `set` op afterwards, one verifiable step each.
 *   - Cue timing lives on the Part object. The WRITABLE properties are CueInFade, CueInDelay, CueOutFade,
 *     CueOutDelay and SnapDelay; CueFade / CueDelay are composite display values ("0.00 / 1.50") and a
 *     Set() on them is silently ignored. Part 0 is the main part every cue has. The trigger lives on the
 *     Cue: TrigType (enum CueTrigger: Go, Time, Follow, Sound, BPM) and TrigTime.
 *   - Set() of Name on a Cue object is silently ignored; Set() of Name on `... Part 0` works and the cue's
 *     Name reflects it. The console strips \ " $ & * ? , . ; ^ { } | ~ from names and trims whitespace, so
 *     `objectName()` refuses such names up front.
 *   - `objects` with a reference to a missing cue, part or sequence returns an empty list (or raises
 *     "no objects found"); both are treated as "does not exist".
 *   - `object` with ref "SelectedSequence" returns the selected sequence; its `index` is the pool number.
 */
import { z } from "zod";
import type { Gma3Bridge } from "../bridge.js";
import { operation, type RegisterTools, type ToolContext } from "./context.js";
import {
  asRead,
  buildResult,
  commandStep,
  compareFields,
  defaultSummary,
  notRequested,
  outcomeOf,
  readStep,
  requestStep,
  runSteps,
  unavailable,
  validationFailure,
  type OperationResult,
  type StepFn,
  type StepResult,
  type Verification,
} from "../results.js";
import {
  Validator,
  ValidationError,
  cueNumber,
  exactlyOne,
  objectName,
  objectNumber,
  oneOf,
  partNumber,
  timeSeconds,
} from "../validate.js";
import { cueRef, exists, readFields } from "./common.js";

// ---------------------------------------------------------------------------
// Console vocabulary
// ---------------------------------------------------------------------------

/** Tool trigger names -> console TrigType enum names (Enums.CueTrigger on 2.5.1). */
const TRIGGERS = { go: "Go", time: "Time", follow: "Follow", sound: "Sound", bpm: "BPM" } as const;
type TriggerKey = keyof typeof TRIGGERS;
const TRIGGER_KEYS = Object.keys(TRIGGERS) as TriggerKey[];

/** Tool timing parameters -> writable Part property names (never the composite CueFade / CueDelay). */
const TIMING_PROPS = {
  fade: "CueInFade",
  delay: "CueInDelay",
  out_fade: "CueOutFade",
  out_delay: "CueOutDelay",
  snap_delay: "SnapDelay",
} as const;
type TimingKey = keyof typeof TIMING_PROPS;

const NOT_VERIFIED_VALUES = "Stored fixture values (attribute data) are NOT verified; that needs gma3_cue_contents (FR-10).";
const LOCK_CAVEAT = "The mutation lock orders only this server's own mutations; it does not isolate the operation from another console operator or another client.";

/** Seconds as the console command line / property editor accepts them. */
const fmtTime = (s: number): string => String(s);

// ---------------------------------------------------------------------------
// Shared input shapes (zod raw shapes, merged into each tool's inputSchema)
// ---------------------------------------------------------------------------

const sequenceShape = {
  sequence: z.number().optional().describe("Sequence number (1..99999). Required unless use_selected_sequence is true; exactly one of the two."),
  use_selected_sequence: z
    .boolean()
    .optional()
    .describe("Act on the console's currently selected sequence. It is resolved to its sequence number first, and the command is sent with that explicit number."),
};
const cueShape = {
  cue: z.union([z.number(), z.string()]).describe('One cue number, fractional allowed (2, 2.5, "10.001"; max three decimals). Ranges (Thru, +) are rejected.'),
};
const verifyShape = {
  verify: z.boolean().optional().describe("Read the result back after the mutation (default true). Verification is reported separately from the mutation steps."),
};
const timingShape = {
  fade: z.number().optional().describe("Cue (in) fade time in seconds; 0 is a value. Part property CueInFade."),
  delay: z.number().optional().describe("Cue (in) delay time in seconds; 0 is a value. Part property CueInDelay."),
  out_fade: z.number().optional().describe("Out fade in seconds (dimmers going down); 0 is a value. Part property CueOutFade."),
  out_delay: z.number().optional().describe("Out delay in seconds; 0 is a value. Part property CueOutDelay."),
};

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

interface TargetArgs {
  sequence?: number;
  use_selected_sequence?: boolean;
  cue: unknown;
  part?: number;
}

interface Target {
  /** Sequence number; undefined until the selected sequence has been resolved. */
  sequence?: number;
  /** True when the number comes from the console's selected sequence. */
  selected: boolean;
  cue: string;
  part?: number;
}

/** Validate sequence/cue(/part) arguments into a Target. Errors are collected on `v`. */
function validateTarget(v: Validator, args: TargetArgs, opts: { part?: "required" | "optional" } = {}): Target {
  const which = v.check(() => exactlyOne({ sequence: args.sequence, use_selected_sequence: args.use_selected_sequence }, "sequence and use_selected_sequence"));
  const sequence = which === "sequence" ? v.check(() => objectNumber("sequence", args.sequence)) : undefined;
  const cue = v.check(() => cueNumber("cue", args.cue)) ?? "";
  let part: number | undefined;
  if (opts.part === "required") part = v.check(() => partNumber("part", args.part));
  else if (opts.part === "optional") part = v.check(() => partNumber("part", args.part, { optional: true }));
  return { sequence, selected: which === "use_selected_sequence", cue, part };
}

/** The target as reported in results (what the tool resolved, not what it was given). */
function describeTarget(t: Target): Record<string, unknown> {
  return {
    sequence: t.sequence ?? (t.selected ? "selected sequence (unresolved)" : undefined),
    sequenceSource: t.selected ? "selected" : "explicit",
    cue: t.cue,
    ...(t.part !== undefined ? { part: t.part } : {}),
  };
}

const refOf = (t: Target, part?: number): string => cueRef(t.sequence as number, t.cue, part);

/**
 * Step that resolves the console's selected sequence to its number via the `object` op and stores it
 * on the target. The remaining steps are built lazily so they see the resolved number.
 */
function resolveSequenceStep(ctx: ToolContext, target: Target): { name: string; run: StepFn } {
  const name = "resolve_sequence";
  return {
    name,
    run: () =>
      readStep(
        ctx.bridge,
        name,
        "object",
        { ref: "SelectedSequence", properties: false, children: false, schema: false },
        (res) => {
          const obj = res as { class?: string; index?: unknown; name?: string; invalid?: boolean } | null;
          const idx = Number(obj?.index);
          if (!obj || obj.invalid || obj.class !== "Sequence" || !Number.isInteger(idx) || idx < 1) {
            return { name, status: "failed", op: "object", error: "no sequence is selected on the console; pass an explicit sequence", detail: res };
          }
          target.sequence = idx;
          return { name, status: "succeeded", op: "object", detail: { sequence: idx, name: obj.name } };
        },
        ctx.requestTimeoutMs,
      ),
  };
}

/**
 * Existence check step (read-only, `objects` op, marked `kind: "read"` so a failure here makes the
 * operation `failed`, never `partial`). `expect: "absent"` is the create-mode guard: it refuses when
 * the object exists. `expect: "present"` refuses when it does not. Either way nothing has been sent
 * to the console when the step fails. This is a point-in-time read, not a lock.
 */
function existenceStep(ctx: ToolContext, name: string, ref: () => string, expect: "present" | "absent", hint: string): { name: string; run: StepFn } {
  const check = async (): Promise<StepResult> => {
    const r = ref();
    const e = await exists(ctx.bridge, r);
    if (e.exists === "unknown") {
      return { name, status: "failed", op: "objects", error: `could not read ${r} (${e.error}); nothing was sent`, detail: { ref: r } };
    }
    if (expect === "absent" && e.exists) {
      return { name, status: "failed", op: "objects", error: `${r} already exists; nothing was sent. ${hint}`, detail: { ref: r, existing: e.object } };
    }
    if (expect === "present" && !e.exists) {
      return { name, status: "failed", op: "objects", error: `${r} does not exist; nothing was sent. ${hint}`, detail: { ref: r } };
    }
    return { name, status: "succeeded", op: "objects", detail: { ref: r, exists: e.exists, ...(e.exists ? { object: e.object } : {}) } };
  };
  return { name, run: async () => asRead(await check()) };
}

/** A `set` step on one property. The console's Set() takes editor text, so numbers are stringified. */
function setStep(ctx: ToolContext, name: string, ref: () => string, property: string, value: string | number): { name: string; run: StepFn } {
  return {
    name,
    run: () => {
      const args = { ref: ref(), property, value: typeof value === "number" ? fmtTime(value) : value };
      return requestStep(ctx.bridge, name, "set", args, (res) => ({ name, status: "succeeded", op: "set", detail: { ...args, result: res } }), ctx.requestTimeoutMs);
    },
  };
}

// ---------------------------------------------------------------------------
// Read-back
// ---------------------------------------------------------------------------

interface ReadBack {
  actual: Record<string, unknown> | null;
  /** Reference that resolved to nothing. */
  missing?: string;
  /** Transport or bridge error while reading. */
  error?: string;
}

/** Read several objects' fields into one record (keys must not collide between objects). */
async function readBack(bridge: Gma3Bridge, reads: Array<{ ref: string; fields: string[] }>): Promise<ReadBack> {
  const actual: Record<string, unknown> = {};
  try {
    for (const r of reads) {
      const fields = await readFields(bridge, r.ref, r.fields);
      if (!fields) return { actual: null, missing: r.ref };
      for (const f of r.fields) actual[f] = fields[f] ?? null;
    }
    return { actual };
  } catch (err) {
    return { actual: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Turn a read-back into a Verification against `expected` (undefined values are existence-only). */
function verifyAgainst(checked: string, expected: Record<string, unknown>, rb: ReadBack, missingMeans: string): Verification {
  if (rb.error) return unavailable(`read-back failed: ${rb.error}`, checked);
  if (rb.missing) return { status: "mismatched", checked, expected, actual: null, detail: `${rb.missing} ${missingMeans}` };
  return compareFields(checked, expected, rb.actual);
}

/** Should read-back run? Only after the primary mutation step was actually sent (succeeded or unknown). */
function primaryWasSent(steps: StepResult[], primary: string): boolean {
  const s = steps.find((x) => x.name === primary);
  return !!s && (s.status === "succeeded" || s.status === "unknown");
}

const skippedVerification = (why: string): Verification => unavailable(`read-back not attempted: ${why}`);

// ---------------------------------------------------------------------------
// Store (cue and cue part)
// ---------------------------------------------------------------------------

type StoreMode = "create" | "merge" | "overwrite";

interface StoreArgs extends TargetArgs {
  mode: StoreMode;
  name?: string;
  fade?: number;
  delay?: number;
  out_fade?: number;
  out_delay?: number;
  verify?: boolean;
}

function buildStoreCommand(t: Target, mode: StoreMode): string {
  let c = `Store ${refOf(t, t.part)}`;
  if (mode === "merge") c += " /Merge";
  else if (mode === "overwrite") c += " /Overwrite";
  return c + " /NoConfirmation";
}

async function storeCue(ctx: ToolContext, args: StoreArgs, kind: "cue" | "part"): Promise<OperationResult> {
  const op = kind === "cue" ? "store_cue" : "store_cue_part";
  const v = new Validator();
  const target = validateTarget(v, args, { part: kind === "part" ? "required" : undefined });
  const mode = v.check(() => oneOf("mode", args.mode, ["create", "merge", "overwrite"] as const)) ?? "create";
  const name = v.check(() => objectName("name", args.name, { optional: true }));
  const fade = v.check(() => timeSeconds("fade", args.fade, { optional: true }));
  const delay = v.check(() => timeSeconds("delay", args.delay, { optional: true }));
  const outFade = v.check(() => timeSeconds("out_fade", args.out_fade, { optional: true }));
  const outDelay = v.check(() => timeSeconds("out_delay", args.out_delay, { optional: true }));
  if (!v.ok) return validationFailure(op, describeTarget(target), v.errors);

  // Timing goes on the part: Part 0 for a plain cue store, the given part for a part store.
  const partRef = () => refOf(target, kind === "part" ? target.part : 0);
  // Names are set on the part as well: Set(Name) on a Cue object is silently ignored by the console, while
  // setting it on Part 0 works and the cue's own Name reflects it.
  const namedRef = partRef;

  const plan: Array<{ name: string; run: StepFn }> = [];
  if (target.selected) plan.push(resolveSequenceStep(ctx, target));
  if (mode === "create") {
    plan.push(
      existenceStep(ctx, "check_existing", () => refOf(target, target.part), "absent", 'Use mode "merge" or "overwrite" to store into an existing target. This check is a point-in-time read, not a transaction lock.'),
    );
  }
  plan.push({ name: "store", run: () => commandStep(ctx.bridge, "store", buildStoreCommand(target, mode), ctx.requestTimeoutMs) });
  // Name and timing are applied as part properties, one step each, so every piece is individually verifiable
  // and no label text ever goes through the command line.
  if (name !== undefined) plan.push(setStep(ctx, "set_name", namedRef, "Name", name));
  if (fade !== undefined) plan.push(setStep(ctx, "set_fade", partRef, TIMING_PROPS.fade, fade));
  if (delay !== undefined) plan.push(setStep(ctx, "set_delay", partRef, TIMING_PROPS.delay, delay));
  if (outFade !== undefined) plan.push(setStep(ctx, "set_out_fade", partRef, TIMING_PROPS.out_fade, outFade));
  if (outDelay !== undefined) plan.push(setStep(ctx, "set_out_delay", partRef, TIMING_PROPS.out_delay, outDelay));

  // One lock span covers the commands AND the read-back: if the lock were released in between,
  // another queued mutation could change the cue first and the read-back would verify its work.
  const { steps, verification } = await ctx.mutations.run(async () => {
    const { steps } = await runSteps(plan);

    // Read-back: existence, Name, and the timing fields that were requested. Fixture values are not read.
    let verification: Verification;
    const expected: Record<string, unknown> = {
      Name: name,
      [TIMING_PROPS.fade]: fade,
      [TIMING_PROPS.delay]: delay,
      [TIMING_PROPS.out_fade]: outFade,
      [TIMING_PROPS.out_delay]: outDelay,
    };
    if (args.verify === false) verification = notRequested();
    else if (!primaryWasSent(steps, "store")) verification = skippedVerification("the store command was not sent");
    else {
      const timingFields = (Object.values(TIMING_PROPS) as string[]).filter((f) => expected[f] !== undefined);
      const reads: Array<{ ref: string; fields: string[] }> = [];
      if (kind === "cue") {
        reads.push({ ref: refOf(target), fields: ["No", "Name"] });
        if (timingFields.length) reads.push({ ref: partRef(), fields: timingFields });
      } else {
        reads.push({ ref: partRef(), fields: ["Part", "Name", ...timingFields] });
      }
      const rb = await readBack(ctx.bridge, reads);
      verification = verifyAgainst(
        kind === "cue" ? "cue exists; Name and part-0 timing fields that were given" : "part exists; Name and timing fields that were given",
        expected,
        rb,
        "does not exist after the store",
      );
    }
    return { steps, verification };
  });

  const outcome = outcomeOf(steps);
  const summary =
    defaultSummary(op, outcome, verification, steps) +
    ` Store step and read-back are reported separately. ${NOT_VERIFIED_VALUES}`;
  return buildResult({
    operation: op,
    target: describeTarget(target),
    steps,
    verification,
    summary,
    extra: {
      mode,
      notVerified: NOT_VERIFIED_VALUES,
      ...(kind === "part" && target.part === 0 ? { partZeroNote: "Part 0 is the main part every cue has; storing to it is the same as storing the cue itself." } : {}),
      ...(name !== undefined ? { nameNote: "Names are set with the Name property of the part (part 0 for a cue) after the store, never inline on the command line." } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

interface TimingArgs extends TargetArgs {
  fade?: number;
  delay?: number;
  out_fade?: number;
  out_delay?: number;
  snap_delay?: number;
  verify?: boolean;
}

async function setCueTiming(ctx: ToolContext, args: TimingArgs): Promise<OperationResult> {
  const op = "set_cue_timing";
  const v = new Validator();
  const target = validateTarget(v, args, { part: "optional" });
  const values: Partial<Record<TimingKey, number>> = {};
  for (const key of Object.keys(TIMING_PROPS) as TimingKey[]) {
    const val = v.check(() => timeSeconds(key, args[key], { optional: true }));
    if (val !== undefined) values[key] = val;
  }
  if (Object.keys(values).length === 0) v.fail("at least one of fade, delay, out_fade, out_delay, snap_delay is required (0 is a value)");
  if (!v.ok) return validationFailure(op, describeTarget(target), v.errors);

  // Timing lives on the part; part 0 is the cue's main part.
  const part = target.part ?? 0;
  const partRef = () => refOf(target, part);
  const plan: Array<{ name: string; run: StepFn }> = [];
  if (target.selected) plan.push(resolveSequenceStep(ctx, target));
  plan.push(existenceStep(ctx, "check_target", partRef, "present", "Store the cue (part) first."));
  const expected: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(values) as Array<[TimingKey, number]>) {
    const prop = TIMING_PROPS[key];
    expected[prop] = val;
    plan.push(setStep(ctx, `set_${key}`, partRef, prop, val));
  }

  const result = await ctx.mutations.run(async () => {
    const run = await runSteps(plan);
    let verification: Verification;
    if (args.verify === false) verification = notRequested();
    else if (!run.steps.some((s) => s.name.startsWith("set_") && (s.status === "succeeded" || s.status === "unknown"))) {
      verification = skippedVerification("no property was sent");
    } else {
      const rb = await readBack(ctx.bridge, [{ ref: partRef(), fields: Object.keys(expected) }]);
      verification = verifyAgainst("the timing fields that were given, read from the part", expected, rb, "does not exist after the edit");
    }
    return { steps: run.steps, verification };
  });

  return buildResult({
    operation: op,
    target: { ...describeTarget(target), part },
    steps: result.steps,
    verification: result.verification,
    extra: { changed: expected, unchanged: "fields that were not given were not touched" },
  });
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

interface TriggerArgs extends TargetArgs {
  trigger: string;
  time?: number;
  verify?: boolean;
}

async function setCueTrigger(ctx: ToolContext, args: TriggerArgs): Promise<OperationResult> {
  const op = "set_cue_trigger";
  const v = new Validator();
  const target = validateTarget(v, args);
  const trigger = v.check(() => oneOf("trigger", args.trigger, TRIGGER_KEYS));
  const time = v.check(() => timeSeconds("time", args.time, { optional: true }));
  if (trigger) {
    v.check(() => {
      if (trigger === "time" && time === undefined) throw new ValidationError('time (seconds) is required for trigger "time"', "time");
      if ((trigger === "go" || trigger === "sound" || trigger === "bpm") && time !== undefined) {
        throw new ValidationError(`time is not applicable to trigger "${trigger}"; omit it`, "time");
      }
    });
  }
  if (!v.ok) return validationFailure(op, describeTarget(target), v.errors);

  const trigType = TRIGGERS[trigger as TriggerKey];
  const ref = () => refOf(target);
  const plan: Array<{ name: string; run: StepFn }> = [];
  if (target.selected) plan.push(resolveSequenceStep(ctx, target));
  plan.push(existenceStep(ctx, "check_target", ref, "present", "Store the cue first."));
  plan.push(setStep(ctx, "set_trig_type", ref, "TrigType", trigType));
  if (time !== undefined) plan.push(setStep(ctx, "set_trig_time", ref, "TrigTime", time));
  const expected: Record<string, unknown> = { TrigType: trigType, TrigTime: time };

  const result = await ctx.mutations.run(async () => {
    const run = await runSteps(plan);
    let verification: Verification;
    if (args.verify === false) verification = notRequested();
    else if (!primaryWasSent(run.steps, "set_trig_type")) verification = skippedVerification("TrigType was not sent");
    else {
      const rb = await readBack(ctx.bridge, [{ ref: ref(), fields: ["TrigType", "TrigTime"] }]);
      verification = verifyAgainst("TrigType (and TrigTime when given) read from the cue", expected, rb, "does not exist after the edit");
    }
    return { steps: run.steps, verification };
  });

  return buildResult({
    operation: op,
    target: describeTarget(target),
    steps: result.steps,
    verification: result.verification,
    extra: { trigger, trigType, ...(time !== undefined ? { trigTime: time } : {}) },
  });
}

// ---------------------------------------------------------------------------
// Goto
// ---------------------------------------------------------------------------

interface GotoArgs extends TargetArgs {
  fade?: number;
}

const GOTO_NOTE =
  "Goto is a playback mutation. A succeeded outcome means the console accepted the command; the crossfade runs asynchronously and its completion is not verified.";

async function gotoCue(ctx: ToolContext, args: GotoArgs): Promise<OperationResult> {
  const op = "goto_cue";
  const v = new Validator();
  const target = validateTarget(v, args);
  const fade = v.check(() => timeSeconds("fade", args.fade, { optional: true }));
  if (!v.ok) return validationFailure(op, describeTarget(target), v.errors);

  const plan: Array<{ name: string; run: StepFn }> = [];
  if (target.selected) plan.push(resolveSequenceStep(ctx, target));
  plan.push(existenceStep(ctx, "check_target", () => refOf(target), "present", "Goto was not sent."));
  plan.push({
    name: "goto",
    run: () => commandStep(ctx.bridge, "goto", `Goto ${refOf(target)}${fade !== undefined ? ` Fade ${fmtTime(fade)}` : ""}`, ctx.requestTimeoutMs),
  });
  const { steps } = await ctx.mutations.run(() => runSteps(plan));
  const outcome = outcomeOf(steps);
  const summary =
    outcome === "succeeded"
      ? `goto_cue: the console accepted Goto for ${refOf(target)}${fade !== undefined ? ` with Fade ${fmtTime(fade)}` : ""}. ${GOTO_NOTE} Read-back not requested.`
      : defaultSummary(op, outcome, notRequested(), steps);
  return buildResult({
    operation: op,
    target: describeTarget(target),
    steps,
    verification: notRequested(),
    summary,
    extra: { ...(fade !== undefined ? { fade } : {}), note: GOTO_NOTE, verificationNote: "The sequence's current cue is not read back; use gma3_cues / gma3_get_object to inspect playback state." },
  });
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

interface DeleteArgs extends TargetArgs {
  verify?: boolean;
}

async function deleteCue(ctx: ToolContext, args: DeleteArgs): Promise<OperationResult> {
  const op = "delete_cue";
  const v = new Validator();
  const target = validateTarget(v, args);
  if (!v.ok) return validationFailure(op, describeTarget(target), v.errors);

  const ref = () => refOf(target);
  const plan: Array<{ name: string; run: StepFn }> = [];
  if (target.selected) plan.push(resolveSequenceStep(ctx, target));
  plan.push(existenceStep(ctx, "check_target", ref, "present", "Nothing was deleted."));
  plan.push({ name: "delete", run: () => commandStep(ctx.bridge, "delete", `Delete ${ref()} /NoConfirmation`, ctx.requestTimeoutMs) });

  const result = await ctx.mutations.run(async () => {
    const run = await runSteps(plan);
    let verification: Verification;
    if (args.verify === false) verification = notRequested();
    else if (!primaryWasSent(run.steps, "delete")) verification = skippedVerification("the delete command was not sent");
    else {
      const e = await exists(ctx.bridge, ref());
      const checked = `${ref()} no longer exists`;
      if (e.exists === "unknown") verification = unavailable(`read-back failed: ${e.error}`, checked);
      else if (e.exists) verification = { status: "mismatched", checked, expected: { exists: false }, actual: { exists: true, object: e.object }, detail: `${ref()} still exists after the delete` };
      else verification = { status: "matched", checked, expected: { exists: false }, actual: { exists: false } };
    }
    return { steps: run.steps, verification };
  });

  return buildResult({ operation: op, target: describeTarget(target), steps: result.steps, verification: result.verification });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const registerCueTools: RegisterTools = (server, ctx) => {
  const storeDescription = (what: string) =>
    `${what} Sends one Store command (/NoConfirmation; /Merge or /Overwrite for those modes), then one Set() per given name/timing field on the part (part 0 for a cue): Name, CueInFade (fade), CueInDelay (delay), CueOutFade, CueOutDelay. ` +
    "Mode create first checks that the target does not exist and refuses (nothing sent) if it does; that check is a point-in-time read, not a transaction lock. " +
    "The current fixture selection is not changed; the programmer is not cleared (no Clear is sent). " +
    "Reads back existence, Name and the timing fields that were given; the store step and the read-back are reported separately. " +
    `${NOT_VERIFIED_VALUES} ${LOCK_CAVEAT}`;

  server.registerTool(
    "gma3_store_cue",
    {
      title: "Store a cue",
      description: storeDescription("Store the programmer content as a cue of a sequence (create, merge or overwrite), optionally with a name and cue timing (seconds)."),
      inputSchema: {
        ...sequenceShape,
        ...cueShape,
        mode: z.enum(["create", "merge", "overwrite"]).describe("create: refuse if the cue exists. merge: /Merge into an existing cue. overwrite: /Overwrite an existing cue. Exactly one mode."),
        name: z.string().optional().describe("Cue name. Names must not contain any of \\ \" $ & * ? , . ; ^ { } | ~ (the console strips them) and are trimmed; they are set via the Name property of the part after the store."),
        ...timingShape,
        ...verifyShape,
      },
    },
    (args) => operation(() => storeCue(ctx, args as StoreArgs, "cue")),
  );

  server.registerTool(
    "gma3_store_cue_part",
    {
      title: "Store a cue part",
      description: storeDescription(
        "Store the programmer content into a part of a cue (Store Sequence n Cue c Part p). Part 0 is the main part that every cue has, so storing to part 0 is the same as storing the cue; parts 1..999 hold values with their own timing.",
      ),
      inputSchema: {
        ...sequenceShape,
        ...cueShape,
        part: z.number().describe("Part number 0..999. 0 is the cue's main part (always exists once the cue exists); mode create therefore refuses part 0 of an existing cue."),
        mode: z.enum(["create", "merge", "overwrite"]).describe("create: refuse if the part exists. merge: /Merge. overwrite: /Overwrite. Exactly one mode."),
        name: z.string().optional().describe("Part name. Names must not contain any of \\ \" $ & * ? , . ; ^ { } | ~ (the console strips them) and are trimmed; they are set via the Name property of the part after the store."),
        ...timingShape,
        ...verifyShape,
      },
    },
    (args) => operation(() => storeCue(ctx, args as StoreArgs, "part")),
  );

  server.registerTool(
    "gma3_set_cue_timing",
    {
      title: "Set cue timing",
      description:
        "Edit the timing of an existing cue part (default part 0, the cue's main part) with one Set() per given field: fade (CueInFade), delay (CueInDelay), out_fade (CueOutFade), out_delay (CueOutDelay), snap_delay (SnapDelay), all in seconds; 0 is a value. " +
        "Only the given fields are changed. Refuses (nothing sent) when the cue part does not exist. No command-line command is sent; selection and programmer are untouched. " +
        `Reads the changed fields back from the part. Stored fixture values are not touched or verified. ${LOCK_CAVEAT}`,
      inputSchema: {
        ...sequenceShape,
        ...cueShape,
        part: z.number().optional().describe("Part number (default 0 = the cue's main part)."),
        ...timingShape,
        snap_delay: z.number().optional().describe("Snap delay in seconds (Part property SnapDelay); 0 is a value."),
        ...verifyShape,
      },
    },
    (args) => operation(() => setCueTiming(ctx, args as TimingArgs)),
  );

  server.registerTool(
    "gma3_set_cue_trigger",
    {
      title: "Set cue trigger",
      description:
        'Set how an existing cue is triggered: trigger "go" (manual), "time" (after `time` seconds; time required), "follow" (when the previous cue completes; optional `time` as extra delay), "sound" or "bpm" (no time). ' +
        "Sets the cue's TrigType and then TrigTime via Set(); no command-line command is sent, selection and programmer are untouched. Refuses (nothing sent) when the cue does not exist. " +
        `Reads TrigType and TrigTime back. ${LOCK_CAVEAT}`,
      inputSchema: {
        ...sequenceShape,
        ...cueShape,
        trigger: z.enum(["go", "time", "follow", "sound", "bpm"]).describe("Trigger type (console TrigType: Go, Time, Follow, Sound, BPM)."),
        time: z.number().optional().describe('Trigger time in seconds (TrigTime). Required for "time", optional for "follow", not allowed for "go", "sound", "bpm". 0 is a value.'),
        ...verifyShape,
      },
    },
    (args) => operation(() => setCueTrigger(ctx, args as TriggerArgs)),
  );

  server.registerTool(
    "gma3_goto_cue",
    {
      title: "Goto a cue (playback)",
      description:
        "PLAYBACK MUTATION: sends `Goto Sequence n Cue c [Fade s]`, which jumps the sequence to that cue and changes live output. " +
        `${GOTO_NOTE} Refuses (nothing sent) when the cue does not exist. Does not change the selection or the programmer. Verification: not_requested (the current cue is not read back). ${LOCK_CAVEAT}`,
      inputSchema: {
        ...sequenceShape,
        ...cueShape,
        fade: z.number().optional().describe("Crossfade time in seconds that overrides the cue's own timing (Goto ... Fade s). 0 is a value."),
      },
    },
    (args) => operation(() => gotoCue(ctx, args as GotoArgs)),
  );

  server.registerTool(
    "gma3_delete_cue",
    {
      title: "Delete one cue",
      description:
        "Delete exactly one explicit cue with `Delete Sequence n Cue c /NoConfirmation`. Ranges (Thru, +) are rejected. Checks the cue exists first and refuses (nothing sent) when it does not. " +
        `Verifies by reading existence back: matched when gone, mismatched when it still exists, unavailable when unreadable. Does not change the selection or the programmer. Never retried. ${LOCK_CAVEAT}`,
      inputSchema: { ...sequenceShape, ...cueShape, ...verifyShape },
    },
    (args) => operation(() => deleteCue(ctx, args as DeleteArgs)),
  );
};
