/**
 * KB-26 patch tools: inspect and change the fixture patch without dialogs (DIALOG.md "KB-26").
 *
 * Reads: gma3_patch_types, gma3_patch_list (the bridge's patch.types / patch.list).
 * Changes: gma3_patch_add, gma3_patch_set, gma3_patch_remove. Each runs one patch session through the
 * patch edit copy (ShowData.Patch), the way KB-25 established live on onPC 2.5.1:
 *
 *   1. read   check_state      the command line is at Root, the copy is closed (nobody is in the Patch
 *                              menu) and no modal is open
 *   2. read   check_*          the tool's pre-flight (patch.check): FIDs and DMX ranges free, fixtures exist
 *   3. mut.   enter            patch.enter queues ChangeDestination into the copy (CmdIndirect)
 *   4. read   wait_copy        poll patch.state until the copy is open at the stage's Fixtures
 *   5. mut.   add|set|remove   the edit, in the copy only (the bridge re-checks and undoes its own change
 *                              on any problem)
 *   6. read   isolation_check  fingerprints of the copy and the live patch, one collection per request,
 *                              leaving out the FIDs this call touches: anything else that differs means
 *                              someone else changed the show, and nothing is committed
 *   7. mut.   commit           patch.commit queues ChangeDestination Root, which commits the copy
 *   8. read   wait_commit      poll patch.state until the destination is Root and the copy closed
 *   then read-back (patch.list) of the touched FIDs.
 *
 * A committed patch edit has no undo. The isolation check is best-effort detection, not exclusion (it is
 * read over several seconds), so every change tool requires exclusive: true: the client confirms that
 * nobody else uses the console while it runs. When a session cannot be finished, it is closed again only
 * when the copy provably holds no change (fingerprints equal with nothing left out); otherwise the copy is
 * left open, the result says so (copyLeftOpen), and the operator decides at the console (Menu > Patch,
 * Save and Exit or Discard and Exit).
 */
import { z } from "zod";
import { BridgeError, type Gma3Bridge } from "../bridge.js";
import {
  asRead,
  buildResult,
  notRequested,
  stepFromError,
  unavailable,
  validationFailure,
  type ExecutionOutcome,
  type OperationResult,
  type StepResult,
  type Verification,
} from "../results.js";
import { Validator, ValidationError, describe, finiteNumber, objectName } from "../validate.js";
import { json, operation, type RegisterTools, type ToolContext } from "./context.js";

// ---------------------------------------------------------------------------
// Shapes the bridge returns
// ---------------------------------------------------------------------------

export interface PatchState {
  destination: string | null;
  copyOpen: boolean;
  atRoot: boolean;
  modal: false | { name?: string; class?: string; display?: number };
  stages: string[];
  lastCommand?: string;
}

export interface FixtureRow {
  fid: number | string;
  cid?: string;
  idType?: string;
  name: string;
  type?: string;
  mode?: string;
  patch?: string;
  breaks?: Array<{ break: number; address: string }>;
  stage?: string;
  depth?: number;
  parentFid?: number | string;
  subfixtures?: number;
}

interface Fingerprint {
  objects: number;
  hash: number | string;
  complete: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const MAX_COUNT = 256;
const MAX_FID = 99_999_999;

/** "U.AAA" (universe 1-1024, address 1-512), normalised to "U.AAA" with three address digits. */
export function dmxAddress(field: string, value: unknown, opts: { optional?: boolean } = {}): string | undefined {
  if (value === undefined || value === null) {
    if (opts.optional) return undefined;
    throw new ValidationError(`${field} is required`, field);
  }
  const m = typeof value === "string" ? value.trim().match(/^(\d+)\.(\d+)$/) : null;
  const u = m ? Number(m[1]) : NaN;
  const a = m ? Number(m[2]) : NaN;
  if (!m || u < 1 || u > 1024 || a < 1 || a > 512) throw new ValidationError(`${field} must be a DMX address "U.AAA" (universe 1-1024, address 1-512; got ${describe(value)})`, field);
  return `${u}.${String(a).padStart(3, "0")}`;
}

function fidNumber(field: string, value: unknown): number | undefined {
  return finiteNumber(field, value, { integer: true, min: 1, max: MAX_FID });
}

/** A fixture type or mode given by number or by name. */
function numberOrName(field: string, value: unknown): number | string | undefined {
  if (typeof value === "number") return finiteNumber(field, value, { integer: true, min: 1 });
  if (typeof value === "string" && value.trim() !== "" && !/["\u0000-\u001f]/.test(value)) return value.trim();
  throw new ValidationError(`${field} must be a number or a name without quotes (got ${describe(value)})`, field);
}

function requireExclusive(v: Validator, exclusive: unknown): void {
  if (exclusive !== true) {
    v.fail(
      "exclusive must be true: patch changes need exclusive use of the console (nobody else editing the show while the tool runs). The tool's isolation check only detects other changes on a best-effort basis and cannot prevent them, and a committed patch change has no undo.",
    );
  }
}

// ---------------------------------------------------------------------------
// Session machinery
// ---------------------------------------------------------------------------

const POLL_TRIES = 30;
const POLL_MS = 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readState(bridge: Gma3Bridge, t: number): Promise<PatchState> {
  return (await bridge.request("patch.state", {}, t)) as PatchState;
}

/** check_state: Root, copy closed, no modal. */
async function checkStateStep(bridge: Gma3Bridge, t: number): Promise<StepResult> {
  try {
    const s = await readState(bridge, t);
    const problems: string[] = [];
    if (s.copyOpen) problems.push("the patch copy is open (someone is in the Patch menu, or an earlier session was not finished): close it at the console first (Menu > Patch, Save and Exit or Discard and Exit)");
    else if (s.destination !== "Root") problems.push(`the command line destination is ${JSON.stringify(s.destination)}, not Root: ChangeDestination Root at the console first`);
    if (s.modal) problems.push(`a modal is open (${s.modal.name ?? s.modal.class ?? "unknown"}): close it at the console first`);
    if (problems.length) return asRead({ name: "check_state", status: "failed", op: "patch.state", error: problems.join("; "), detail: s });
    return asRead({ name: "check_state", status: "succeeded", op: "patch.state", detail: { destination: s.destination, stages: s.stages } });
  } catch (err) {
    return asRead(stepFromError("check_state", err, { op: "patch.state" }));
  }
}

/** Poll patch.state until `pred` holds. */
async function waitStep(bridge: Gma3Bridge, name: string, t: number, pred: (s: PatchState) => boolean, what: string): Promise<StepResult> {
  let last: PatchState | undefined;
  for (let i = 0; i < POLL_TRIES; i++) {
    try {
      last = await readState(bridge, t);
    } catch (err) {
      return asRead(stepFromError(name, err, { op: "patch.state" }));
    }
    if (pred(last)) return asRead({ name, status: "succeeded", op: "patch.state", detail: { destination: last.destination, copyOpen: last.copyOpen, polls: i + 1 } });
    await sleep(POLL_MS);
  }
  return asRead({ name, status: "unknown", op: "patch.state", error: `${what} did not happen within ${(POLL_TRIES * POLL_MS) / 1000} s (CmdIndirect lands on a later frame)`, detail: last });
}

async function fingerprints(bridge: Gma3Bridge, excludeFids: number[], t: number): Promise<{ equal: boolean; complete: boolean; mismatched: string[]; detail: Record<string, unknown> }> {
  const cols = (await bridge.request("patch.collections", {}, t)) as { copyOpen: boolean; live: string[]; copy: string[] | false };
  if (!cols.copyOpen || !Array.isArray(cols.copy)) return { equal: false, complete: false, mismatched: ["the copy is not open"], detail: { collections: cols } };
  const ft = Math.max(t, 15_000);
  const mismatched: string[] = [];
  let complete = true;
  const reasons: string[] = [];
  if (JSON.stringify(cols.live) !== JSON.stringify(cols.copy)) mismatched.push(`collections differ: live ${cols.live.join(", ")} / copy ${cols.copy.join(", ")}`);
  for (const collection of cols.live) {
    const live = (await bridge.request("patch.fingerprint", { side: "live", collection, excludeFids }, ft)) as Fingerprint;
    const copy = (await bridge.request("patch.fingerprint", { side: "copy", collection, excludeFids }, ft)) as Fingerprint;
    if (!live.complete || !copy.complete) {
      complete = false;
      reasons.push(`${collection}: ${live.reason ?? copy.reason ?? "incomplete"}`);
    } else if (live.objects !== copy.objects || live.hash !== copy.hash) mismatched.push(collection);
  }
  return { equal: complete && mismatched.length === 0, complete, mismatched, detail: { collections: cols.live, excludeFids, ...(reasons.length ? { incomplete: reasons } : {}) } };
}

async function isolationStep(bridge: Gma3Bridge, excludeFids: number[], t: number): Promise<StepResult> {
  try {
    const f = await fingerprints(bridge, excludeFids, t);
    if (f.equal) return asRead({ name: "isolation_check", status: "succeeded", op: "patch.fingerprint", detail: f.detail });
    const why = !f.complete
      ? "the copy and the live patch could not be fingerprinted completely, so other changes cannot be ruled out"
      : `the copy differs from the live patch outside the fixtures this call touched (${f.mismatched.join(", ")}): someone else changed the show during the session`;
    return asRead({ name: "isolation_check", status: "failed", op: "patch.fingerprint", error: `${why}; nothing was committed`, detail: { ...f.detail, mismatched: f.mismatched } });
  } catch (err) {
    return asRead(stepFromError("isolation_check", err, { op: "patch.fingerprint" }));
  }
}

/**
 * After a session could not be finished: commit (leave) only when the copy provably equals the live patch
 * with nothing left out, i.e. holds no change at all. Otherwise leave it open for the operator.
 */
async function closeSession(bridge: Gma3Bridge, t: number): Promise<{ steps: StepResult[]; closed: boolean; leftOpen: boolean }> {
  const steps: StepResult[] = [];
  let state: PatchState;
  try {
    state = await readState(bridge, t);
  } catch (err) {
    steps.push(asRead(stepFromError("close_check", err, { op: "patch.state" })));
    return { steps, closed: false, leftOpen: true };
  }
  if (!state.copyOpen) {
    steps.push(asRead({ name: "close_check", status: "succeeded", op: "patch.state", detail: "the copy is not open; nothing to close" }));
    return { steps, closed: true, leftOpen: false };
  }
  let unchanged = false;
  try {
    const f = await fingerprints(bridge, [], t);
    unchanged = f.equal;
    steps.push(asRead({ name: "close_check", status: unchanged ? "succeeded" : "failed", op: "patch.fingerprint", ...(unchanged ? {} : { error: "the copy holds changes (or could not be fingerprinted completely); it is left open for the operator" }), detail: { ...f.detail, mismatched: f.mismatched } }));
  } catch (err) {
    steps.push(asRead(stepFromError("close_check", err, { op: "patch.fingerprint" })));
  }
  if (!unchanged) return { steps, closed: false, leftOpen: true };
  try {
    await bridge.request("patch.commit", { exclusive: true }, t);
    steps.push({ name: "close", status: "succeeded", op: "patch.commit", detail: "the unchanged copy was closed (ChangeDestination Root)" });
  } catch (err) {
    steps.push(stepFromError("close", err, { op: "patch.commit" }));
    return { steps, closed: false, leftOpen: true };
  }
  const w = await waitStep(bridge, "wait_close", t, (s) => s.atRoot, "closing the copy");
  steps.push(w);
  return { steps, closed: w.status === "succeeded", leftOpen: w.status !== "succeeded" };
}

interface SessionSpec {
  operation: string;
  target: Record<string, unknown>;
  /** FIDs the call touches; left out of the isolation check. */
  touchedFids: number[];
  stage?: string;
  /** The tool's read-only pre-flight; a non-succeeded step stops the call before anything is sent. */
  preflight: () => Promise<StepResult>;
  /** Step name of the edit ("add", "set", "remove"). */
  editName: string;
  /** The edit inside the copy (patch.add / patch.set / patch.remove), built once the copy is open; `stage` is the stage patch.enter entered. */
  edit: (stage: string | undefined) => { op: string; args: Record<string, unknown> };
  /** Read-back after a commit. */
  readBack?: () => Promise<{ steps: StepResult[]; verification: Verification; extra?: Record<string, unknown> }>;
  verify: boolean;
  extra?: () => Record<string, unknown>;
}

const SESSION_STEPS = ["enter", "wait_copy", "<edit>", "isolation_check", "commit", "wait_commit"];
const sessionSteps = (editName: string, from: number) => SESSION_STEPS.slice(from).map((n) => (n === "<edit>" ? editName : n));

function skippedSteps(names: string[], because: string): StepResult[] {
  return names.map((name) => ({ name, status: "skipped" as const, error: `not attempted: ${because}` }));
}

async function runSession(ctx: ToolContext, spec: SessionSpec): Promise<OperationResult> {
  const t = ctx.requestTimeoutMs;
  const bridge = ctx.bridge;
  return ctx.mutations.run(async () => {
    const steps: StepResult[] = [];
    const finish = (outcome: ExecutionOutcome, summary: string, verification: Verification, extra: Record<string, unknown> = {}, readBackSteps: StepResult[] = []): OperationResult => {
      const r = buildResult({ operation: spec.operation, target: spec.target, steps, verification, summary, extra: { ...(spec.extra?.() ?? {}), ...extra } });
      r.outcome = outcome;
      r.steps.push(...readBackSteps);
      return r;
    };
    const planned = (from: number) => sessionSteps(spec.editName, from);

    // Phase 1: read-only checks. Nothing is sent if any fails.
    const st = await checkStateStep(bridge, t);
    steps.push(st);
    if (st.status === "succeeded") steps.push(await spec.preflight());
    const badPre = steps.find((s) => s.status !== "succeeded");
    if (badPre) {
      steps.push(...skippedSteps(planned(0), "the request was refused before anything was sent"));
      return finish("failed", `${spec.operation} was not performed; nothing was sent to the console: ${badPre.error ?? badPre.name}.`, spec.verify ? unavailable("the request stopped before anything was sent") : notRequested(), { committed: false, copyLeftOpen: false });
    }

    // Phase 2: the session.
    let enter: StepResult;
    try {
      const res = await bridge.request("patch.enter", { exclusive: true, ...(spec.stage ? { stage: spec.stage } : {}) }, t);
      enter = { name: "enter", status: "succeeded", op: "patch.enter", detail: res };
    } catch (err) {
      enter = stepFromError("enter", err, { op: "patch.enter" });
      if (err instanceof BridgeError && err.code && !err.dispatched) enter.error = `${enter.error} (code ${err.code})`;
    }
    steps.push(enter);
    if (enter.status === "failed") {
      steps.push(...skippedSteps(planned(1), "entering the patch copy was refused"));
      return finish("failed", `${spec.operation} was not performed: entering the patch copy was refused: ${enter.error}. The show is unchanged.`, spec.verify ? unavailable("nothing was changed") : notRequested(), { committed: false, copyLeftOpen: false });
    }
    const entered = enter.detail as { expectDestination?: string; stage?: string } | undefined;
    const expectDest = entered?.expectDestination;
    const wc = enter.status === "succeeded"
      ? await waitStep(bridge, "wait_copy", t, (s) => s.copyOpen && (expectDest === undefined || s.destination === expectDest), "opening the patch copy")
      : asRead({ name: "wait_copy", status: "unknown", op: "patch.state", error: "the enter request got no reply" } as StepResult);
    steps.push(wc);

    // Abort path: close the copy only if it provably holds no change.
    const abort = async (outcome: ExecutionOutcome, reason: string, remaining: string[]): Promise<OperationResult> => {
      steps.push(...skippedSteps(remaining, reason));
      const c = await closeSession(bridge, t);
      steps.push(...c.steps);
      const state = c.closed ? "the patch copy was closed again without changes; the show is unchanged" : "THE PATCH COPY WAS LEFT OPEN (it may hold this call's change and the command line is in the patch): resolve it at the console with Menu > Patch, then Discard and Exit (or Save and Exit to keep it)";
      return finish(outcome, `${spec.operation} was not completed: ${reason}. ${state}.`, spec.verify ? unavailable("nothing was committed") : notRequested(), { committed: false, copyLeftOpen: c.leftOpen });
    };

    if (wc.status !== "succeeded") return abort("unknown", `the patch copy did not open as expected (${wc.error ?? wc.status})`, planned(2));

    const edit = spec.edit(entered?.stage);
    let editStep: StepResult;
    try {
      const res = await bridge.request(edit.op, { exclusive: true, ...edit.args }, t);
      editStep = { name: spec.editName, status: "succeeded", op: edit.op, detail: res };
    } catch (err) {
      editStep = stepFromError(spec.editName, err, { op: edit.op });
      if (err instanceof BridgeError && err.detail !== undefined) editStep.detail = err.detail;
    }
    steps.push(editStep);
    if (editStep.status !== "succeeded") {
      return abort(editStep.status === "unknown" ? "unknown" : "failed", `the ${spec.editName} step ${editStep.status === "unknown" ? "got no reply" : "was refused"}: ${editStep.error}`, planned(3));
    }

    const iso = await isolationStep(bridge, spec.touchedFids, t);
    steps.push(iso);
    if (iso.status !== "succeeded") {
      steps.push(...skippedSteps(["commit", "wait_commit"], "the isolation check did not pass"));
      return finish("failed", `${spec.operation} was not committed: ${iso.error}. THE PATCH COPY WAS LEFT OPEN with this call's change in it: resolve it at the console with Menu > Patch, then Discard and Exit (drops everything in the copy) or Save and Exit (keeps everything in it).`, spec.verify ? unavailable("nothing was committed") : notRequested(), { committed: false, copyLeftOpen: true });
    }

    let commit: StepResult;
    try {
      const res = await bridge.request("patch.commit", { exclusive: true }, t);
      commit = { name: "commit", status: "succeeded", op: "patch.commit", detail: res };
    } catch (err) {
      commit = stepFromError("commit", err, { op: "patch.commit" });
    }
    steps.push(commit);
    if (commit.status !== "succeeded") {
      steps.push(...skippedSteps(["wait_commit"], "the commit was not confirmed"));
      return finish(commit.status === "unknown" ? "unknown" : "failed", `${spec.operation}: the commit ${commit.status === "unknown" ? "got no reply; whether the change is live is unknown" : `was refused: ${commit.error}`}. The patch copy may still be open: check patch.state / the console.`, spec.verify ? unavailable("the commit was not confirmed") : notRequested(), { committed: commit.status === "unknown" ? "unknown" : false, copyLeftOpen: true });
    }
    const wcm = await waitStep(bridge, "wait_commit", t, (s) => s.atRoot, "the commit (ChangeDestination Root)");
    steps.push(wcm);
    if (wcm.status !== "succeeded") {
      return finish("unknown", `${spec.operation}: the commit was queued but the console did not report the copy closed; whether the change is live is unknown. Check gma3_patch_list and the console.`, spec.verify ? unavailable("the commit was not confirmed") : notRequested(), { committed: "unknown", copyLeftOpen: "unknown" });
    }

    // Phase 3: read-back.
    let verification: Verification = notRequested();
    const rbSteps: StepResult[] = [];
    let rbExtra: Record<string, unknown> = {};
    if (spec.verify && spec.readBack) {
      const rb = await spec.readBack();
      rbSteps.push(...rb.steps);
      verification = rb.verification;
      rbExtra = rb.extra ?? {};
    }
    const verified = verification.status === "matched" ? " Read-back matched." : verification.status === "mismatched" ? ` Read-back MISMATCHED: ${verification.detail}` : verification.status === "unavailable" ? ` Read-back unavailable: ${verification.detail}` : "";
    return finish("succeeded", `${spec.operation} succeeded and was committed (a committed patch change has no undo).${verified}`, verification, { committed: true, copyLeftOpen: false, ...rbExtra }, rbSteps);
  });
}

async function listRange(bridge: Gma3Bridge, from: number, to: number, t: number): Promise<FixtureRow[]> {
  const res = (await bridge.request("patch.list", { fromFid: from, toFid: to, limit: 2000 }, t)) as { fixtures: FixtureRow[] };
  return res.fixtures ?? [];
}

// ---------------------------------------------------------------------------
// gma3_patch_add
// ---------------------------------------------------------------------------

interface AddArgs {
  type: number | string;
  mode: number | string;
  fid: number;
  count?: number;
  name?: string;
  address?: string;
  findFreeFrom?: string;
  stage?: string;
  exclusive?: boolean;
  verify?: boolean;
}

/** Address of fixture i of a consecutive block. */
export function blockAddress(start: string, footprint: number, i: number): string {
  const [u, a] = start.split(".").map(Number);
  const abs = (u - 1) * 512 + (a - 1) + i * footprint;
  return `${Math.floor(abs / 512) + 1}.${String((abs % 512) + 1).padStart(3, "0")}`;
}

export async function patchAdd(ctx: ToolContext, raw: AddArgs): Promise<OperationResult> {
  const op = "patch_add";
  const v = new Validator();
  const type = v.check(() => numberOrName("type", raw.type));
  const mode = v.check(() => numberOrName("mode", raw.mode));
  const fid = v.check(() => fidNumber("fid", raw.fid));
  const count = v.check(() => finiteNumber("count", raw.count ?? 1, { integer: true, min: 1, max: MAX_COUNT })) ?? 1;
  const name = v.check(() => objectName("name", raw.name, { optional: true }));
  const address = v.check(() => dmxAddress("address", raw.address, { optional: true }));
  const findFreeFrom = v.check(() => dmxAddress("findFreeFrom", raw.findFreeFrom, { optional: true }));
  if (address !== undefined && findFreeFrom !== undefined) v.fail("give address or findFreeFrom, not both");
  const stage = v.check(() => objectName("stage", raw.stage, { optional: true }));
  requireExclusive(v, raw.exclusive);
  const verify = raw.verify !== false;
  const target: Record<string, unknown> = { type: raw.type, mode: raw.mode, fid: raw.fid, count: raw.count ?? 1 };
  if (!v.ok || type === undefined || mode === undefined || fid === undefined) return validationFailure(op, target, v.errors);
  const t = ctx.requestTimeoutMs;
  let resolvedAddress: string | undefined = address;
  let footprint = 0;
  let modeName: string | undefined;
  let checkDetail: unknown;
  const fids = Array.from({ length: count }, (_, i) => fid + i);

  return runSession(ctx, {
    operation: op,
    target,
    touchedFids: fids,
    stage,
    verify,
    preflight: async () => {
      try {
        const add: Record<string, unknown> = { type, mode, fid, count };
        if (address) add.address = address;
        if (findFreeFrom) add.findFreeFrom = findFreeFrom;
        const c = (await ctx.bridge.request("patch.check", { add }, t)) as {
          fidFree: boolean;
          singleBreak: boolean;
          dmxFree?: boolean;
          conflicts?: unknown[];
          suggested?: string | false;
          suggestedFree?: boolean;
          mode: { name: string; footprint?: number };
          type: { no: number; name: string };
        };
        checkDetail = c;
        footprint = c.mode.footprint ?? 0;
        modeName = c.mode.name;
        const problems: string[] = [];
        if (!c.singleBreak) problems.push(`DMX mode ${c.mode.name} has more than one DMX break; multi-break modes are not supported`);
        if (!c.fidFree) problems.push(`FID ${fid}${count > 1 ? `..${fid + count - 1}` : ""} is not free`);
        if (address && !c.dmxFree) problems.push(`${address} for ${count} fixture(s) of ${footprint} channels is not free: ${JSON.stringify(c.conflicts ?? [])}`);
        if (findFreeFrom) {
          if (!c.suggested || !c.suggestedFree) problems.push(`no free block of ${count} x ${footprint} channels was found from ${findFreeFrom} inside one universe`);
          else resolvedAddress = c.suggested;
        }
        if (problems.length) return asRead({ name: "check_add", status: "failed", op: "patch.check", error: problems.join("; "), detail: c });
        return asRead({ name: "check_add", status: "succeeded", op: "patch.check", detail: { ...c, address: resolvedAddress ?? null } });
      } catch (err) {
        const s = asRead(stepFromError("check_add", err, { op: "patch.check" }));
        if (err instanceof BridgeError && /unknown op/.test(err.message)) s.error = `${s.error}: the console runs an older bridge plugin without the patch ops (bridge 0.19.0); update the plugin`;
        return s;
      }
    },
    editName: "add",
    edit: (entered) => ({ op: "patch.add", args: { stage: entered ?? stage, type, mode, fid, count, ...(name ? { name } : {}), ...(resolvedAddress ? { address: resolvedAddress } : {}) } }),
    extra: () => ({ address: resolvedAddress ?? null, footprint, check: checkDetail }),
    readBack: async () => {
      try {
        const rows = await listRange(ctx.bridge, fid, fid + count - 1, t);
        const step: StepResult = asRead({ name: "read_back", status: "succeeded", op: "patch.list", detail: rows });
        const mismatches: string[] = [];
        const byFid = new Map(rows.map((r) => [r.fid, r]));
        const expected = fids.map((f, i) => ({ fid: f, patch: resolvedAddress ? blockAddress(resolvedAddress, footprint, i) : "", ...(name ? { name } : {}) }));
        for (const e of expected) {
          const r = byFid.get(e.fid);
          if (!r) {
            mismatches.push(`FID ${e.fid} is not in the patch`);
            continue;
          }
          if ((r.patch ?? "") !== e.patch) mismatches.push(`FID ${e.fid}: patch ${JSON.stringify(r.patch ?? "")}, expected ${JSON.stringify(e.patch)}`);
          if (e.name !== undefined && r.name !== e.name) mismatches.push(`FID ${e.fid}: name ${JSON.stringify(r.name)}, expected ${JSON.stringify(e.name)}`);
          if (modeName && r.mode && !String(r.mode).endsWith(modeName)) mismatches.push(`FID ${e.fid}: mode ${JSON.stringify(r.mode)}, expected ${JSON.stringify(modeName)}`);
        }
        const checked = `FIDs ${fid}..${fid + count - 1}: present, patch addresses${name ? ", names" : ""} and mode`;
        return {
          steps: [step],
          verification: mismatches.length ? { status: "mismatched", checked, expected, actual: rows, detail: mismatches.join("; ") } : { status: "matched", checked, expected, actual: rows },
          extra: { fixtures: rows },
        };
      } catch (err) {
        return { steps: [asRead(stepFromError("read_back", err, { op: "patch.list" }))], verification: unavailable("the patch could not be read back") };
      }
    },
  });
}

// ---------------------------------------------------------------------------
// gma3_patch_set
// ---------------------------------------------------------------------------

interface EditArg {
  fid: number;
  address?: string;
  unpatch?: boolean;
  name?: string;
}

interface SetArgs {
  edits: EditArg[];
  exclusive?: boolean;
  verify?: boolean;
}

export async function patchSet(ctx: ToolContext, raw: SetArgs): Promise<OperationResult> {
  const op = "patch_set";
  const v = new Validator();
  const edits: Array<{ fid: number; address?: string; name?: string }> = [];
  if (!Array.isArray(raw.edits) || raw.edits.length === 0) v.fail("edits must be a non-empty list");
  else if (raw.edits.length > MAX_COUNT) v.fail(`at most ${MAX_COUNT} edits per call`);
  else {
    const seen = new Set<number>();
    raw.edits.forEach((e, i) => {
      const fid = v.check(() => fidNumber(`edits[${i}].fid`, e?.fid));
      if (fid !== undefined && seen.has(fid)) v.fail(`FID ${fid} appears twice in edits`);
      if (fid !== undefined) seen.add(fid);
      if (e?.address !== undefined && e?.unpatch === true) v.fail(`edits[${i}]: give address or unpatch, not both`);
      const address = e?.unpatch === true ? "" : v.check(() => dmxAddress(`edits[${i}].address`, e?.address, { optional: true }));
      const name = v.check(() => objectName(`edits[${i}].name`, e?.name, { optional: true }));
      if (address === undefined && name === undefined) v.fail(`edits[${i}] changes nothing: give address, unpatch: true and/or name`);
      if (fid !== undefined) edits.push({ fid, ...(address !== undefined ? { address } : {}), ...(name !== undefined ? { name } : {}) });
    });
  }
  requireExclusive(v, raw.exclusive);
  const verify = raw.verify !== false;
  const target: Record<string, unknown> = { edits: raw.edits };
  if (!v.ok) return validationFailure(op, target, v.errors);
  const t = ctx.requestTimeoutMs;
  let before: unknown;

  return runSession(ctx, {
    operation: op,
    target,
    touchedFids: edits.map((e) => e.fid),
    verify,
    preflight: async () => {
      try {
        const c = (await ctx.bridge.request("patch.check", { edits }, t)) as { edits: Array<{ fid: number; exists: boolean; singleBreak?: boolean; current?: FixtureRow }>; conflicts: unknown[] };
        before = c.edits.map((e) => e.current ?? { fid: e.fid, exists: false });
        const problems: string[] = [];
        for (const e of c.edits) {
          if (!e.exists) problems.push(`no fixture with FID ${e.fid}`);
          else if (e.singleBreak === false) problems.push(`FID ${e.fid} uses a multi-break mode; readdressing it is not supported`);
        }
        if (c.conflicts.length) problems.push(`the new addresses overlap patched fixtures: ${JSON.stringify(c.conflicts)}`);
        if (problems.length) return asRead({ name: "check_edits", status: "failed", op: "patch.check", error: problems.join("; "), detail: c });
        return asRead({ name: "check_edits", status: "succeeded", op: "patch.check", detail: c });
      } catch (err) {
        return asRead(stepFromError("check_edits", err, { op: "patch.check" }));
      }
    },
    editName: "set",
    edit: () => ({ op: "patch.set", args: { edits } }),
    extra: () => ({ before }),
    readBack: async () => {
      try {
        const fids = edits.map((e) => e.fid);
        const rows = await listRange(ctx.bridge, Math.min(...fids), Math.max(...fids), t);
        const byFid = new Map(rows.map((r) => [r.fid, r]));
        const mismatches: string[] = [];
        const actual: FixtureRow[] = [];
        for (const e of edits) {
          const r = byFid.get(e.fid);
          if (!r) {
            mismatches.push(`FID ${e.fid} is not in the patch`);
            continue;
          }
          actual.push(r);
          if (e.address !== undefined && (r.patch ?? "") !== e.address) mismatches.push(`FID ${e.fid}: patch ${JSON.stringify(r.patch ?? "")}, expected ${JSON.stringify(e.address)}`);
          if (e.name !== undefined && r.name !== e.name) mismatches.push(`FID ${e.fid}: name ${JSON.stringify(r.name)}, expected ${JSON.stringify(e.name)}`);
        }
        const checked = "each edited fixture's patch address and/or name";
        return {
          steps: [asRead({ name: "read_back", status: "succeeded", op: "patch.list", detail: actual })],
          verification: mismatches.length ? { status: "mismatched", checked, expected: edits, actual, detail: mismatches.join("; ") } : { status: "matched", checked, expected: edits, actual },
          extra: { after: actual },
        };
      } catch (err) {
        return { steps: [asRead(stepFromError("read_back", err, { op: "patch.list" }))], verification: unavailable("the patch could not be read back") };
      }
    },
  });
}

// ---------------------------------------------------------------------------
// gma3_patch_remove
// ---------------------------------------------------------------------------

interface RemoveArgs {
  fids: number[];
  exclusive?: boolean;
  verify?: boolean;
}

export async function patchRemove(ctx: ToolContext, raw: RemoveArgs): Promise<OperationResult> {
  const op = "patch_remove";
  const v = new Validator();
  const fids: number[] = [];
  if (!Array.isArray(raw.fids) || raw.fids.length === 0) v.fail("fids must be a non-empty list");
  else if (raw.fids.length > MAX_COUNT) v.fail(`at most ${MAX_COUNT} fixtures per call`);
  else
    raw.fids.forEach((f, i) => {
      const fid = v.check(() => fidNumber(`fids[${i}]`, f));
      if (fid !== undefined && fids.includes(fid)) v.fail(`FID ${fid} appears twice`);
      else if (fid !== undefined) fids.push(fid);
    });
  requireExclusive(v, raw.exclusive);
  const verify = raw.verify !== false;
  const target: Record<string, unknown> = { fids: raw.fids };
  if (!v.ok) return validationFailure(op, target, v.errors);
  const t = ctx.requestTimeoutMs;
  let removed: unknown;

  return runSession(ctx, {
    operation: op,
    target,
    touchedFids: fids,
    verify,
    preflight: async () => {
      try {
        const c = (await ctx.bridge.request("patch.check", { fids }, t)) as { fixtures: Array<{ fid: number; exists: boolean; current?: FixtureRow }> };
        removed = c.fixtures.map((f) => f.current ?? { fid: f.fid, exists: false });
        const problems: string[] = [];
        for (const f of c.fixtures) {
          if (!f.exists) problems.push(`no fixture with FID ${f.fid}`);
          else if ((f.current?.subfixtures ?? 0) > 0) problems.push(`FID ${f.fid} has ${f.current?.subfixtures} sub-fixture(s); removing it is not supported`);
        }
        if (problems.length) return asRead({ name: "check_fixtures", status: "failed", op: "patch.check", error: problems.join("; "), detail: c });
        return asRead({ name: "check_fixtures", status: "succeeded", op: "patch.check", detail: c });
      } catch (err) {
        return asRead(stepFromError("check_fixtures", err, { op: "patch.check" }));
      }
    },
    editName: "remove",
    edit: () => ({ op: "patch.remove", args: { fids } }),
    extra: () => ({ removed }),
    readBack: async () => {
      try {
        const rows = await listRange(ctx.bridge, Math.min(...fids), Math.max(...fids), t);
        const still = rows.filter((r) => typeof r.fid === "number" && fids.includes(r.fid));
        const checked = "the removed FIDs are absent from the patch";
        return {
          steps: [asRead({ name: "read_back", status: "succeeded", op: "patch.list", detail: still })],
          verification: still.length ? { status: "mismatched", checked, expected: [], actual: still, detail: `still present: ${still.map((r) => r.fid).join(", ")}` } : { status: "matched", checked, expected: [], actual: [] },
        };
      } catch (err) {
        return { steps: [asRead(stepFromError("read_back", err, { op: "patch.list" }))], verification: unavailable("the patch could not be read back") };
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const SESSION_DESC =
  "Runs one patch session through the patch edit copy, never a dialog: read-only pre-checks (command line at Root, the copy closed, so nobody is in the Patch menu, no modal open, plus the tool's own checks), then enter the copy, apply the change there, an isolation check, commit, and read back. " +
  "Requires exclusive: true. Patch changes need exclusive use of the console: the isolation check compares fingerprints of the copy and the live patch, left out the touched FIDs, over several seconds. It is best-effort detection of someone else's changes, not a guarantee, and on a mismatch nothing is committed and the copy is left open for the operator. " +
  "A committed patch change has NO UNDO (Oops does not revert it). Takes about 10 s (mostly the isolation check). " +
  "When a session cannot be finished, the copy is closed again only if it provably holds no change; otherwise the result says copyLeftOpen: true and the operator resolves it at the console (Menu > Patch, Save and Exit or Discard and Exit). Needs bridge 0.19.0.";
const EXCLUSIVE_DESC = "Required, must be true: confirms nobody else uses the console while this runs (see the description). Without it the call is refused and nothing is sent.";
const VERIFY_DESC = "Read the patch back after the commit and compare (default true).";

export const registerPatchTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_patch_types",
    {
      title: "List fixture types and DMX modes in the show",
      description:
        "Read-only. Lists the fixture types imported into the show with their DMX modes: number, name, manufacturer, short name, source, and per mode the DMX footprint, the number of DMX breaks and the channels per break. " +
        "Use the type and mode numbers or names with gma3_patch_add. Only the show's own types are listed; importing a type from the library is not supported yet.",
      inputSchema: {
        search: z.string().optional().describe("Optional case-insensitive substring filter on type name, short name or manufacturer."),
      },
    },
    async (args) => {
      const res = (await ctx.bridge.request("patch.types", {}, ctx.requestTimeoutMs)) as { types: Array<Record<string, unknown>> };
      const q = typeof args.search === "string" ? args.search.toLowerCase() : "";
      const types = q ? res.types.filter((tp) => ["name", "shortName", "manufacturer"].some((k) => String(tp[k] ?? "").toLowerCase().includes(q))) : res.types;
      return json({ count: types.length, types });
    },
  );

  server.registerTool(
    "gma3_patch_list",
    {
      title: "List patched fixtures",
      description:
        "Read-only. Lists the show's fixtures from the live patch, every stage, sub-fixtures included, in patch order. Each fixture has FID, CID, ID type, name, fixture type, mode, patch address, DMX breaks, stage, depth, parent FID and sub-fixture count. " +
        "Filter by FID range (fromFid/toFid; fixtures without a numeric FID are omitted when a range is given); paginated (limit default 200, max 2000).",
      inputSchema: {
        fromFid: z.number().optional().describe("Lowest FID to include."),
        toFid: z.number().optional().describe("Highest FID to include."),
        limit: z.number().optional().describe("Maximum rows (default 200, max 2000)."),
        offset: z.number().optional().describe("Rows to skip (default 0)."),
      },
    },
    async (args) => json(await ctx.bridge.request("patch.list", { ...args }, ctx.requestTimeoutMs)),
  );

  server.registerTool(
    "gma3_patch_add",
    {
      title: "Add fixtures to the patch",
      description:
        "Add count fixtures of one fixture type and DMX mode at consecutive FIDs from fid, patched consecutively from a DMX address (address, or the first free block found from findFreeFrom), or unpatched when neither is given. " +
        "Pre-checks (nothing sent on failure): the FIDs are free, the whole block is free and fits inside one universe, the mode has a single DMX break. Fixtures are added at the top level of a stage (default: the first stage). " +
        SESSION_DESC +
        " verify reads the new FIDs back: present, patch addresses, name (when given) and mode.",
      inputSchema: {
        type: z.union([z.number(), z.string()]).describe("Fixture type number or name, as gma3_patch_types lists it."),
        mode: z.union([z.number(), z.string()]).describe("DMX mode number or name within that type."),
        fid: z.number().describe("First fixture ID; the block uses fid .. fid+count-1, all of which must be free."),
        count: z.number().optional().describe(`Number of fixtures (1-${MAX_COUNT}, default 1).`),
        name: z.string().optional().describe("Optional name for the new fixtures (default: the console's naming)."),
        address: z.string().optional().describe('DMX start address "U.AAA" (e.g. "2.001"); the block must be free and inside one universe.'),
        findFreeFrom: z.string().optional().describe('Instead of address: use the first free block from this "U.AAA".'),
        stage: z.string().optional().describe("Stage name (default: the first stage)."),
        exclusive: z.boolean().optional().describe(EXCLUSIVE_DESC),
        verify: z.boolean().optional().describe(VERIFY_DESC),
      },
    },
    async (args) => operation(() => patchAdd(ctx, args as AddArgs)),
  );

  server.registerTool(
    "gma3_patch_set",
    {
      title: "Readdress, unpatch or rename fixtures",
      description:
        "Change existing fixtures: per edit, a new DMX address (address), unpatch: true, and/or a new name. Addresses are applied together, so fixtures can swap addresses or move across their own current range. " +
        "Pre-checks (nothing sent on failure): every FID exists, single-break modes only, and the new ranges overlap no other patched fixture. In the copy the bridge re-checks and restores every change of the call on any problem. " +
        SESSION_DESC +
        " verify reads each edited fixture back (address and/or name).",
      inputSchema: {
        edits: z
          .array(
            z.object({
              fid: z.number().describe("Fixture ID to change."),
              address: z.string().optional().describe('New DMX address "U.AAA".'),
              unpatch: z.boolean().optional().describe("Remove the fixture's DMX address (it stays in the show)."),
              name: z.string().optional().describe("New fixture name."),
            }),
          )
          .describe(`Edits (1-${MAX_COUNT}); each FID at most once.`),
        exclusive: z.boolean().optional().describe(EXCLUSIVE_DESC),
        verify: z.boolean().optional().describe(VERIFY_DESC),
      },
    },
    async (args) => operation(() => patchSet(ctx, args as SetArgs)),
  );

  server.registerTool(
    "gma3_patch_remove",
    {
      title: "Delete fixtures from the show",
      description:
        "Delete fixtures by FID from the patch, removing them from the show (with everything that refers to them, e.g. their values in cues and groups: the console handles references). Fixtures with sub-fixtures are refused. " +
        "Pre-check (nothing sent on failure): every FID exists and has no sub-fixtures. " +
        SESSION_DESC +
        " verify reads the FIDs back and checks they are gone.",
      inputSchema: {
        fids: z.array(z.number()).describe(`Fixture IDs to delete (1-${MAX_COUNT}).`),
        exclusive: z.boolean().optional().describe(EXCLUSIVE_DESC),
        verify: z.boolean().optional().describe(VERIFY_DESC),
      },
    },
    async (args) => operation(() => patchRemove(ctx, args as RemoveArgs)),
  );
};
