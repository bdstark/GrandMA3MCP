// Steps of the KB-16 probe that change console state (scripts/kb16-probe.mjs `run`), written against a small
// `io` interface so the cleanup discipline can be tested with injected failures (test/kb16-steps.test.ts):
//
//   io.cmd(command)                -> { ok, feedback?, error? }      one console command line
//   io.activity(index)             -> { active: boolean, line }      HasActivePlayback() of the executor's object
//   io.faderValue(index, token)    -> number | undefined            GetFader({token}) of the executor's object
//   io.setfader(ref, value)        -> { ok, error? }                the bridge's setfader op
//   io.programmer()                -> the bridge's `programmer` op result for scope "all" (or { ok:false })
//   io.sleep(ms)
//
// Rules the review asked for and this module enforces:
// - every console change registers its undo BEFORE it is dispatched, with an explicit page-qualified
//   target (`Page <p>.<e>`) and the original value read beforehand;
// - a step that fails half-way still leaves its registered undo in place; the normal path marks an undo
//   done only after the corresponding console call answered OK;
// - `runCleanup` attempts every remaining undo even when one of them fails, and reports each outcome;
// - the programmer precondition is a gate built on the `programmer` op (coverage must be complete and no
//   channel may carry data), never on a UI widget value, and the caller refuses to mutate when it fails.

export const execRef = (pageNo, index) => `Page ${pageNo}.${index}`;

/** A LIFO list of undo actions. `add` returns a handle whose `done()` marks the undo as no longer needed. */
export function createCleanup() {
  const entries = [];
  return {
    add(label, fn) {
      const entry = { label, fn, done: false, outcome: null };
      entries.push(entry);
      return { done: () => { entry.done = true; }, entry };
    },
    pending: () => entries.filter((e) => !e.done).map((e) => e.label),
    /** Runs every undo not marked done, newest first; never throws; returns the outcomes in run order. */
    async run() {
      const outcomes = [];
      for (const entry of [...entries].reverse()) {
        if (entry.done) continue;
        try {
          const r = await entry.fn();
          entry.outcome = r && r.ok === false ? { ok: false, error: r.error ?? r.code ?? "refused" } : { ok: true, detail: r };
        } catch (e) {
          entry.outcome = { ok: false, error: String(e?.message ?? e) };
        }
        entry.done = true;
        outcomes.push({ label: entry.label, ...entry.outcome });
      }
      return outcomes;
    },
  };
}

/**
 * Establishes that the programmer is empty from the bridge's `programmer` op (scope "all"). Returns
 * { ok: true, detail } only when the scan covered every fixture and no channel carries data; anything
 * else (incomplete coverage, data present, op refused, unexpected shape) is { ok: false, reason }.
 */
export function programmerEmpty(result) {
  if (!result || result.ok === false) return { ok: false, reason: `programmer op failed: ${result?.error ?? result?.code ?? "no result"}` };
  const r = result.result ?? result;
  const cov = r.coverage;
  if (!cov || typeof cov.complete !== "boolean" || !r.stats || typeof r.stats.channelsWithData !== "number") return { ok: false, reason: "programmer op answered without coverage/stats: the programmer state cannot be established" };
  if (!cov.complete) return { ok: false, reason: `programmer scan incomplete (${cov.scannedFixtures}/${cov.totalFixtures} fixtures): ${(r.limitations ?? []).join("; ") || "no reason given"}` };
  if (r.stats.channelsWithData > 0 || (typeof r.total === "number" && r.total > 0)) return { ok: false, reason: `the programmer holds values (${r.stats.channelsWithData} channel(s) with data, ${r.total ?? "?"} row(s)); clear it by hand first` };
  if (r.stats.channelErrors > 0) return { ok: false, reason: `${r.stats.channelErrors} channel(s) could not be read; the programmer state cannot be established` };
  return { ok: true, detail: { scannedFixtures: cov.scannedFixtures, totalFixtures: cov.totalFixtures, scannedChannels: cov.scannedChannels } };
}

/**
 * Parses the `active=` field of one executor line of the probe's LUA_EXECUTORS reader. Only an explicit
 * `active=true` or `active=false` is accepted; `active=ERR …` (HasActivePlayback raised), `active=nil`, a
 * `missing` executor, an empty line or no line at all throw, so an unreadable target can never pass for an
 * inactive one.
 */
export function parseActivity(line) {
  if (typeof line !== "string" || line.trim() === "") throw new Error("activity unavailable: the executor reader returned no line");
  if (/^\d+\|missing\b/.test(line)) throw new Error(`activity unavailable: ${line.split("|")[0].trim()} is missing on the page`);
  const m = line.match(/(?:^|\|\s*)active=(\S+)/);
  if (!m) throw new Error("activity unavailable: the executor line carries no active= field");
  if (m[1] === "true") return true;
  if (m[1] === "false") return false;
  throw new Error(`activity unavailable: active=${m[1]}${/^ERR/.test(m[1]) ? " (HasActivePlayback raised)" : ""}`);
}

/** Thrown before any dispatch when a target must not be touched; nothing is registered for it. */
export class TargetRefused extends Error {
  constructor(message, detail) { super(message); this.refused = true; this.detail = detail; }
}

/**
 * Reads the target's activity and refuses (throws TargetRefused, nothing registered) when it is already
 * active or cannot be read: a playback that is running cannot be put back where it was by Unpress/Off,
 * and an unreadable one cannot be verified afterwards.
 */
async function requireInactive(io, exec, ref) {
  let before;
  try { before = await io.activity(exec.index); } catch (e) { throw new TargetRefused(`${exec.name} (${ref}): activity cannot be read before dispatch (${e?.message ?? e}); not touched`, { ref, name: exec.name, reason: "unreadable" }); }
  if (typeof before?.active !== "boolean") throw new TargetRefused(`${exec.name} (${ref}): activity read gave no boolean; not touched`, { ref, name: exec.name, reason: "unreadable" });
  if (before.active) throw new TargetRefused(`${exec.name} (${ref}) is already active; not touched (its playback position could not be restored)`, { ref, name: exec.name, reason: "active" });
  return before.active;
}

/**
 * Press and release an executor through its configured key functions. The target must be readable and
 * inactive first (TargetRefused otherwise, nothing registered). The Unpress is registered before the Press;
 * an optional `off` command (for latching functions) is registered before that, so a failure at any point
 * leaves exactly the undo that is still needed. Throws after an intermediate failure with the observations so
 * far attached (`error.partial`); the registered undo stays for `runCleanup`.
 */
export async function probeExecutorButton({ io, cleanup, pageNo, exec, holdMs = 300, off = null }) {
  const ref = execRef(pageNo, exec.index);
  const before = await requireInactive(io, exec, ref);
  const offUndo = off ? cleanup.add(`${off} (${exec.name})`, () => io.cmd(off)) : null;
  const unpress = cleanup.add(`Unpress ${ref} (${exec.name})`, () => io.cmd(`Unpress ${ref}`));
  const obs = { ref, name: exec.name, keyPress: exec.keyPress, keyUnpress: exec.keyUnpress, before };
  const partial = (step, e) => Object.assign(new Error(`${exec.name}: ${step}: ${e?.message ?? e}`), { partial: obs, step });
  const p = await io.cmd(`Press ${ref}`);
  obs.press = p;
  if (!p.ok) { unpress.done(); offUndo?.done(); throw partial("press refused", p.error); }
  await io.sleep(holdMs);
  try { obs.during = (await io.activity(exec.index)).active; } catch (e) { throw partial("activity during hold", e); }
  const u = await io.cmd(`Unpress ${ref}`);
  obs.unpress = u;
  if (!u.ok) throw partial("unpress refused", u.error);
  unpress.done();
  await io.sleep(250);
  try { obs.after = (await io.activity(exec.index)).active; } catch (e) { throw partial("activity after release", e); }
  if (off) {
    const o = await io.cmd(off);
    obs.off = o;
    if (!o.ok) throw partial("off refused", o.error);
    offUndo.done();
    await io.sleep(200);
    try { obs.afterOff = (await io.activity(exec.index)).active; } catch (e) { throw partial("activity after off", e); }
  }
  return obs;
}

/**
 * Moves a fader function and restores it. The target must be readable and inactive first (TargetRefused
 * otherwise, nothing registered). The original level is read first and its restoration registered
 * before the move; the restoration is marked done only after the restoring call answered OK and the read-back
 * matched. `set(ref, value)` is the setter for the function (setfader for Master, a `Fader<Fn> ... At` command
 * for the others).
 */
export async function probeFader({ io, cleanup, pageNo, exec, token, target, set, settleMs = 200, tolerance = 0.5 }) {
  const ref = execRef(pageNo, exec.index);
  await requireInactive(io, exec, ref);
  const original = await io.faderValue(exec.index, token);
  if (typeof original !== "number" || !Number.isFinite(original)) throw Object.assign(new Error(`${exec.name}: ${token} cannot be read before the move; nothing changed`), { step: "read original" });
  const restore = cleanup.add(`${token} ${ref} back to ${original} (${exec.name})`, () => set(ref, original));
  const obs = { ref, name: exec.name, token, original, target };
  const partial = (step, e) => Object.assign(new Error(`${exec.name}: ${step}: ${e?.message ?? e}`), { partial: obs, step });
  const s1 = await set(ref, target);
  obs.set = s1;
  if (!s1.ok) throw partial("set refused", s1.error);
  await io.sleep(settleMs);
  try { obs.moved = await io.faderValue(exec.index, token); } catch (e) { throw partial("read after move", e); }
  try { obs.activeAfterMove = (await io.activity(exec.index)).active; } catch (e) { throw partial("activity after move", e); }
  const s2 = await set(ref, original);
  obs.restoreCall = s2;
  if (!s2.ok) throw partial("restore refused", s2.error);
  await io.sleep(settleMs);
  try { obs.restored = await io.faderValue(exec.index, token); } catch (e) { throw partial("read after restore", e); }
  if (typeof obs.restored === "number" && Math.abs(obs.restored - original) <= tolerance) restore.done();
  else throw partial("restore did not take", `read back ${obs.restored}, expected ${original}`);
  try { obs.activeAfterRestore = (await io.activity(exec.index)).active; } catch (e) { throw partial("activity after restore", e); }
  return obs;
}
