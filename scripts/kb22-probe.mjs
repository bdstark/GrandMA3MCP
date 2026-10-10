#!/usr/bin/env node
// KB-22 executor-operation probe against a RUNNING bridge (plugin 0.18.0 or newer with gma3_mcp_control 0.5.0
// and gma3_mcp_feedback 0.5.0; see ENCODERS.md "KB-22", docs/modules.md "Executor operations on the console backend").
//
//   node scripts/kb22-probe.mjs verify [--out report.json]   read-only: nothing is pressed, placed, assigned or applied
//   node scripts/kb22-probe.mjs run    [--out report.json]   verify + executor operations exercised on the CONSOLE
//                                                           control backend of a DISPOSABLE show: the probe assigns
//                                                           sequences in the free range (deleted again), presses and
//                                                           releases executors (released again), places faders (restored)
//
// What the console half serves and this probe checks: a button on an executor KEY is the console's own dispatch of
// the CONFIGURED button function (Press Page <p>.<e> on the down, Unpress Page <p>.<e> on the release; nothing is
// translated into Go+), a momentary function (Temp, Flash) is active exactly while held and released by a disconnect,
// a latching one (Toggle) stays, a fader is placed through the CONFIGURED fader function (FaderMaster / FaderTemp
// Page <p>.<e> At <level>; a Temp fader above 0 is a playback start and its positions are never superseded), an
// unqualified function (LearnSpeed keys; Rate, Speed, X faders) is refused `unsupported` naming the function, an
// executor encoder is refused, a reassignment while a button is held turns its release into an assignment-changed
// RECORD (nothing is issued on the replacement; recover() releases it once the original object is back), and a page
// change neither stops a running playback nor starts the newly visible ones. `verify` submits only refusals by
// construction and nothing that queues. `run` needs a show whose name matches "disposable", "mcp-test" or "scratch",
// control enabled on the CONSOLE backend, Lua enabled and the free range empty; the operator's own executors are
// used for the functions the probe cannot configure itself (Temp/Flash/Toggle keys, a Temp fader), each pressed only
// while inactive, with its release (or Off) registered before the press. Every change registers its undo first; the
// undos run even when a step fails. Operator actions during a hold run from the probe-owned deferred macro (KB-21).
import net from "node:net";
import fs from "node:fs";
import { createCleanup } from "./lib/kb16-steps.mjs";
import { outcomesOf } from "./kb18-probe.mjs";

const host = process.env.GMA3_BRIDGE_HOST ?? "127.0.0.1";
const port = Number(process.env.GMA3_BRIDGE_PORT ?? 9800);
const argv = process.argv.slice(2);
const mode = argv[0];
const outIdx = argv.indexOf("--out");
const outFile = outIdx >= 0 ? argv[outIdx + 1] : null;
const SHOW_GUARD = /disposable|mcp-test|scratch/i;
const PAGE = Number(process.env.KB22_PAGE ?? 1);
const FREE = (process.env.KB22_FREE_EXECUTORS ?? "180,181").split(",").map(Number);
const SEQUENCES = process.env.KB22_SEQUENCES ?? "auto";
const DEFERRED_MACRO = Number(process.env.KB22_DEFERRED_MACRO ?? 116);
const DEFERRED_NAME = "MCP kb22 deferred";
const DEFERRED_WAIT_S = 1.5;
const GESTURE_LAPSE_MS = 650;
const SETTLE_MS = 350;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The key and fader functions the module qualifies (names as the backend lists them). */
export const QUALIFIED = { keys: ["Flash", "Go+", "Temp", "Toggle", "Top"], faders: ["Master", "Temp"] };

/** Summarises an executor target of a snapshot for the report (functions, level and activity included). */
export function targetSummary(x) {
  if (!x) return undefined;
  if (!x.available) return { executor: x.params?.executor, page: x.params?.page, unavailable: x.reason ?? x.error };
  const v = x.value;
  return { executor: v.executor, page: v.page?.no, mode: v.mode, empty: v.empty, assigned: v.assigned?.addr ?? v.assigned?.name, class: v.assigned?.class, playbackTarget: v.playbackTarget, reason: v.reason,
           keyPress: v.functions?.keyPress, keyUnpress: v.functions?.keyUnpress, fader: v.functions?.fader, encoder: v.functions?.encoder, level: v.level?.value, token: v.level?.token, active: v.active };
}

const norm = (fn) => String(fn ?? "").replace(/\s+/g, "").replace(/^[Ff]ader/, "").toLowerCase();
/** Whether a configured function name is in a qualified list (case-insensitive, spaces removed). */
export const isQualified = (fn, list) => fn != null && fn !== "" && list.some((q) => norm(q) === norm(fn));

/** Playback executors of a snapshot whose configured key (or fader) function matches `fn`, inactive first. */
export function pickByFunction(executors, element, fn, { exclude = [], inactive = true } = {}) {
  return (executors ?? []).filter((x) => {
    const v = x.available && x.value;
    if (!v || !v.playbackTarget || exclude.includes(v.executor)) return false;
    const have = element === "key" ? v.functions?.keyPress : v.functions?.fader;
    if (norm(have) !== norm(fn)) return false;
    return !inactive || v.active === false;
  });
}

/** Picks two distinct Sequence objects assigned on the page that are inactive (never a Quickey, never a reserved executor). */
export function pickSequences(executors, want = 2) {
  const out = [];
  for (const x of executors ?? []) {
    const v = x.available && x.value;
    const addr = v && v.playbackTarget && v.active === false && v.assigned?.class === "Sequence" && v.assigned.addr;
    if (addr && !out.includes(addr)) out.push(addr);
    if (out.length >= want) break;
  }
  return out;
}

export const LUA_MACRO_READ = (n) => `local m = ObjectList("Macro ${n}")[1]; if not m then return false end; local t = { name = tostring(m.name), lines = {} }; for i = 1, m:Count() do local l = m:Ptr(i); t.lines[#t.lines + 1] = { cmd = tostring(l:Get("Command")), wait = tostring(l:Get("Wait")) } end; return t`;
export const LUA_MACRO_WRITE = (n, name, cmd, waitS) => `local m = ObjectList("Macro ${n}")[1]; if not m or tostring(m.name) ~= ${JSON.stringify(name)} then error("Macro ${n} is not the probe's deferred macro", 0) end; for i = m:Count() + 1, 2 do Cmd(string.format("Store Macro %d.%d /NoConfirmation", ${n}, i)) end; local a, b = m:Ptr(1), m:Ptr(2); a:Set("Command", "Echo kb22 deferred"); a:Set("Wait", ${JSON.stringify(String(waitS))}); b:Set("Command", ${JSON.stringify(cmd)}); b:Set("Wait", "Follow"); return m:Count()`;
/** Lua: tries to set the executor's fader function property and reads it back (exploration: whether a function can be configured per executor). */
export const LUA_SET_FADER_FN = (page, exec, fn) => `local h = ObjectList("Page ${page}.${exec}")[1]; if not h then return "no-handle" end; local ok, err = pcall(function() h:Set("Fader", ${JSON.stringify(fn)}) end); return ok and "set" or ("raised: " .. tostring(err)), tostring(h:Get("Fader", Enums.Roles.Display))`;
/** Lua: the assigned object's level for a fader token (what the console reports for a function the binding does not read). */
export const LUA_OBJ_FADER = (page, exec, token) => `local h = ObjectList("Page ${page}.${exec}")[1]; if not h or h.Object == nil then return nil end; return h.Object:GetFader({ token = ${JSON.stringify(token)} })`;

class Conn {
  constructor(name) { this.name = name; this.seq = 0; this.pending = new Map(); this.buf = ""; this.sock = null; }
  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host, port }, () => resolve());
      sock.setEncoding("utf8");
      sock.on("error", (e) => { for (const p of this.pending.values()) p.reject(e); this.pending.clear(); reject(e); });
      sock.on("data", (chunk) => {
        this.buf += chunk;
        let idx;
        while ((idx = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, idx); this.buf = this.buf.slice(idx + 1);
          if (!line.trim()) continue;
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          const p = this.pending.get(msg.id);
          if (p) { this.pending.delete(msg.id); p.resolve(msg); }
        }
      });
      sock.on("close", () => { for (const p of this.pending.values()) p.reject(new Error("socket closed")); this.pending.clear(); });
      this.sock = sock;
    });
  }
  request(op, args = {}, timeoutMs = 8000) {
    const id = `${this.name}${++this.seq}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout: ${op}`)); }, timeoutMs);
      this.pending.set(id, { resolve: (m) => { clearTimeout(t); resolve(m); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.sock.write(JSON.stringify({ id, op, args }) + "\n");
    });
  }
  end() { return new Promise((r) => { if (!this.sock || this.sock.destroyed) return r(); this.sock.once("close", () => r()); this.sock.end(); }); }
}

const steps = [];
let failed = 0;
function record(name, pass, detail) {
  steps.push({ name, pass: !!pass, detail });
  if (!pass) failed += 1;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail !== undefined && !pass ? ` ${JSON.stringify(detail)}` : ""}`);
}
function note(name, detail) { steps.push({ name, note: true, detail }); console.log(`NOTE ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`); }

async function main() {
  if (mode !== "verify" && mode !== "run") {
    console.error("usage: node scripts/kb22-probe.mjs verify|run [--out report.json]");
    process.exit(2);
  }
  const A = new Conn("a");
  await A.connect();
  const pingR = await A.request("ping");
  if (!pingR.ok) { console.error(`ping failed: ${pingR.error}`); process.exit(2); }
  const ping = pingR.result;
  const [maj, min] = String(ping.bridgeVersion ?? "0.0").split(".").map(Number);
  if (maj < 0 || (maj === 0 && min < 18)) { console.error(`bridge ${ping.bridgeVersion} has no executor operations; update the plugin to 0.18.0 or newer (docs/setup/bridge.md)`); process.exit(2); }
  if (!ping.modules?.control?.loaded) { console.error(`the control module is not loaded: ${ping.modules?.control?.error ?? "no module summary"}`); process.exit(2); }
  const [cmaj, cmin] = String(ping.modules.control.version ?? "0.0").split(".").map(Number);
  if (cmaj === 0 && cmin < 5) { console.error(`control module ${ping.modules.control.version} refuses executor elements; 0.5.0 or newer is needed`); process.exit(2); }
  if (!ping.modules?.feedback?.loaded) { console.error(`the feedback module is not loaded: ${ping.modules?.feedback?.error ?? "no module summary"}`); process.exit(2); }
  const [fmaj, fmin] = String(ping.modules.feedback.version ?? "0.0").split(".").map(Number);
  if (fmaj === 0 && fmin < 5) { console.error(`feedback module ${ping.modules.feedback.version} reads the user's page only; 0.5.0 or newer is needed`); process.exit(2); }
  if (mode === "run") {
    if (!SHOW_GUARD.test(String(ping.showfile ?? ""))) { console.error(`show "${ping.showfile}" does not look disposable (expected a name matching ${SHOW_GUARD}); refusing to change state`); process.exit(2); }
    if (!ping.control?.enabled || ping.control.backend !== "console") { console.error('run needs continuous control enabled on the CONSOLE backend by the operator (executors are pressed and faders placed):  Plugin "gma3_mcp_bridge" "control=console"'); process.exit(2); }
    if (!ping.lua?.enabled) { console.error('run needs Lua enabled on the bridge (Plugin "gma3_mcp_bridge" "lua on") for the deferred macro and the object reads'); process.exit(2); }
    if (ping.input?.busy) { console.error(`the bridge is busy (${JSON.stringify(ping.input.busy)}); wait for the owner to finish`); process.exit(2); }
  }
  const report = { mode, host, port, startedAt: new Date().toISOString(), ping: { bridgeVersion: ping.bridgeVersion, build: ping.build, hostname: ping.hostname, showfile: ping.showfile, user: ping.user, modules: ping.modules, input: ping.input, control: ping.control, lua: { enabled: ping.lua?.enabled } }, steps };
  note("console", report.ping);

  // ---- verify: read-only ----
  const st0 = await A.request("control.status");
  record("control.status answers with the module version and a limitation naming the executor operations (KB-22)", st0.ok && st0.result.version === ping.modules.control.version && Array.isArray(st0.result.limitations) && st0.result.limitations.some((l) => /KB-22/.test(l) && /Press\/Unpress/.test(l)), st0.ok ? { version: st0.result.version, limitations: st0.result.limitations } : st0);
  const backend = ping.control?.enabled ? ping.control.backend : null;
  if (backend === "console") {
    const caps = st0.ok ? st0.result.capabilities : null;
    const fns = st0.ok ? st0.result.backendStatus?.executorFunctions : null;
    record("the console backend declares executor keys and faders (not encoders) and lists the qualified functions", caps?.targets?.executor === true && caps.executorElements?.key === true && caps.executorElements?.fader === true && caps.executorElements?.encoder === false && JSON.stringify(fns?.keys) === JSON.stringify(QUALIFIED.keys) && JSON.stringify(fns?.faders) === JSON.stringify(QUALIFIED.faders), { capabilities: caps, functions: fns });
  } else note("control is not on the console backend; the capability check is harness evidence", { backend });
  const ctxAll = await A.request("feedback.context", { allExecutors: true });
  const execs = ctxAll.ok ? ctxAll.result.executors.filter((x) => x.available && x.value.playbackTarget) : [];
  const pageNo = ctxAll.ok ? ctxAll.result.executorPage?.no : undefined;
  record("feedback.context lists the playback executors of the user's page with their configured key and fader functions, the configured function's level and the activity", ctxAll.ok && execs.length > 0 && execs.every((x) => x.value.functions && typeof x.value.active === "boolean"), ctxAll.ok ? { page: pageNo, count: execs.length } : ctxAll);
  const inventory = execs.map((x) => ({ ...targetSummary(x), keyQualified: isQualified(x.value.functions?.keyPress, QUALIFIED.keys), faderQualified: isQualified(x.value.functions?.fader, QUALIFIED.faders) }));
  note("inventory: which executors the console backend would serve (qualified key / fader functions) and which it would refuse", inventory);
  const unqualifiedKey = execs.find((x) => !isQualified(x.value.functions?.keyPress, QUALIFIED.keys));
  let brev; let gen; let seq = 0;
  const ev = {
    down: (executor, element = "key", extra = {}) => ({ type: "button", device: "probe-mtouch", control: `${element === "key" ? "PFA" : "ENC"}${executor}`, seq: ++seq, generation: gen, binding: brev, target: { executor, element, page: PAGE }, down: true, ...extra }),
    up: (executor, element = "key", extra = {}) => ({ type: "button", device: "probe-mtouch", control: `${element === "key" ? "PFA" : "ENC"}${executor}`, seq: ++seq, target: { executor, element, page: PAGE }, down: false, ...extra }),
    touch: (executor, down, extra = {}) => ({ type: "touch", device: "probe-mtouch", control: `PB${executor}`, seq: ++seq, generation: gen, binding: brev, target: { executor, element: "fader", page: PAGE }, down, gesture: 7, ...extra }),
    abs: (executor, value, extra = {}) => ({ type: "absolute", device: "probe-mtouch", control: `PB${executor}`, seq: ++seq, generation: gen, binding: brev, target: { executor, element: "fader", page: PAGE }, value, gesture: 7, ...extra }),
  };
  const bindTo = async (spec) => {
    const b = await A.request("control.bind", spec);
    if (!b.ok) throw new Error(`control.bind: ${b.error}`);
    brev = b.result.binding;
    await sleep(400);
    const c = await A.request("feedback.context", { ...spec, cached: true });
    if (!c.ok) throw new Error(`feedback.context: ${c.error}`);
    if (typeof c.result.generation !== "number") throw new Error(`no generation claimed: ${c.result.generationNote}`);
    gen = c.result.generation;
    return c.result;
  };
  if (backend === "console" && pageNo === PAGE && execs.length) {
    const probeExec = execs.find((x) => x.value.functions?.encoder) ?? execs[0];
    const n = probeExec.value.executor;
    await bindTo({ executors: [n, ...(unqualifiedKey ? [unqualifiedKey.value.executor] : [])], executorPage: PAGE });
    const events = [ev.down(n, "encoder")];
    if (unqualifiedKey) events.push(ev.down(unqualifiedKey.value.executor));
    const r = await A.request("control.submit", { events });
    const o = r.ok ? r.result.outcomes : [];
    record(`verify (console backend): an executor ENCODER element is refused unsupported${unqualifiedKey ? ` and a key whose configured function (${unqualifiedKey.value.functions?.keyPress || "empty"}) is not qualified is refused unsupported naming it` : ""}: nothing is pressed, nothing owned`,
      r.ok && r.result.accepted === 0 && (probeExec.value.functions?.encoder ? (o[0]?.refused === "unsupported" && /executor encoders/.test(o[0].reason ?? "")) : o[0]?.refused === "target-unavailable") && (!unqualifiedKey || (o[1]?.refused === "unsupported" && /not qualified|no configured key function/.test(o[1].reason ?? ""))), outcomesOf(r));
    const st1 = await A.request("control.status");
    record("verify: nothing queued, no gesture, not busy", st1.ok && st1.result.busy == null && Object.values(st1.result.sessions).every((s) => s.queued === 0 && s.gestures === 0), st1.ok ? st1.result.sessions : st1);
    if (mode !== "run") await A.request("control.close");
  } else if (backend === "fake" && execs.length) {
    const r = await A.request("control.submit", { events: [{ type: "button", device: "probe-mtouch", control: "PFAx", seq: ++seq, target: { executor: execs[0].value.executor, element: "key", page: 9999 }, down: true }] });
    record("verify (fake backend): a target on page 9999 is target-unavailable (not in the binding): nothing is queued, nothing owned", r.ok && r.result.outcomes[0]?.refused === "target-unavailable" && r.result.accepted === 0, outcomesOf(r));
    await A.request("control.close");
  } else note("verify: control disabled or no playback executor on the page; the submit refusals are not exercised", { backend, page: pageNo });

  // ---- run: executor operations on the console backend of a disposable show ----
  if (mode === "run") {
    const cleanup = createCleanup();
    let mutationError = null;
    const need = (r, what) => { if (!r.ok) throw new Error(`${what}: ${r.error}`); return r; };
    const cmd = async (c) => need(await A.request("cmd", { command: c }), c);
    const lua = async (code) => need(await A.request("lua", { code, maxMs: 2000 }), "lua").result?.values;
    const submit = async (events, what) => need(await A.request("control.submit", { events }), what);
    const status = async () => need(await A.request("control.status"), "control.status").result;
    const context = async (spec) => need(await A.request("feedback.context", spec), "feedback.context").result;
    const target = async (e) => (await context({ executors: [e], executorPage: PAGE })).executors[0]?.value ?? {};
    const active = async (e) => (await target(e)).active;
    const level = async (e) => (await target(e)).level?.value;
    const lastApplied = async () => (await status()).lastApplied;
    const backendCounters = async () => (await status()).backendStatus?.counters ?? {};
    const settle = () => sleep(SETTLE_MS);
    const lapse = () => sleep(GESTURE_LAPSE_MS);
    const B = new Conn("b");
    const [e0, e1] = FREE;
    let deferredOwned = false;
    const macroRead = async () => (await lua(LUA_MACRO_READ(DEFERRED_MACRO)))?.[0];
    const claimDeferred = async () => {
      const existing = await macroRead();
      if (existing !== false) throw new Error(`Macro ${DEFERRED_MACRO} is occupied by "${existing?.name}"; the probe needs an EMPTY slot it creates and removes itself (KB22_DEFERRED_MACRO)`);
      await lua(`Cmd("Store Macro ${DEFERRED_MACRO} /NoConfirmation"); local m = ObjectList("Macro ${DEFERRED_MACRO}")[1]; if not m then return false end; m:Set("Name", ${JSON.stringify(DEFERRED_NAME)}); return true`);
      const read = await macroRead();
      if (!read || read.name !== DEFERRED_NAME) throw new Error(`could not create the deferred Macro ${DEFERRED_MACRO} (read back ${JSON.stringify(read)})`);
      deferredOwned = true;
      cleanup.add(`Delete Macro ${DEFERRED_MACRO} (the probe's deferred macro)`, async () => {
        const now = await macroRead();
        if (!now || now.name !== DEFERRED_NAME) return { ok: false, error: `Macro ${DEFERRED_MACRO} is not the probe's any more (${JSON.stringify(now)}); left in place` };
        await lua(`Cmd("Delete Macro ${DEFERRED_MACRO} /NoConfirmation"); return true`);
        return { ok: (await macroRead()) === false };
      });
    };
    const deferredFire = async (command) => {
      const now = await macroRead();
      if (!deferredOwned || !now || now.name !== DEFERRED_NAME) throw new Error(`Macro ${DEFERRED_MACRO} is not the probe's deferred macro (${JSON.stringify(now)}); not rewritten`);
      await lua(LUA_MACRO_WRITE(DEFERRED_MACRO, DEFERRED_NAME, command, DEFERRED_WAIT_S));
      const read = await macroRead();
      if (read?.lines?.[1]?.cmd !== command) throw new Error(`the deferred macro did not read back the command (${JSON.stringify(read)})`);
      await cmd(`Go+ Macro ${DEFERRED_MACRO}`);
    };
    const deferredLapse = () => sleep(DEFERRED_WAIT_S * 1000 + 900);
    /** Registers the release of an executor key before a down, and `off` (for latching functions) before that. */
    const guardKey = (e, off) => {
      const offUndo = off ? cleanup.add(`${off}`, () => A.request("cmd", { command: off })) : null;
      const unpress = cleanup.add(`Unpress Page ${PAGE}.${e}`, () => A.request("cmd", { command: `Unpress Page ${PAGE}.${e}` }));
      return { done: () => { unpress.done(); }, offDone: () => offUndo?.done() };
    };
    const releaseAll = async () => {
      for (const ctl of [...FREE, ...execs.map((x) => x.value.executor)]) {
        await A.request("control.submit", { events: [{ type: "button", device: "probe-mtouch", control: `PFA${ctl}`, seq: ++seq, target: { executor: ctl, element: "key", page: PAGE }, down: false }, { type: "touch", device: "probe-mtouch", control: `PB${ctl}`, seq: ++seq, target: { executor: ctl, element: "fader", page: PAGE }, down: false }] });
      }
      await lapse();
    };
    try {
      if (pageNo !== PAGE) throw new Error(`the console is on page ${pageNo}, the probe expects page ${PAGE} (KB22_PAGE)`);
      const free = await context({ executors: FREE, executorPage: PAGE });
      const freeOk = free.executors.every((x) => x.available && x.value.empty === true && !x.value.reserved && x.value.coveredBy == null);
      record(`run: preflight: executors ${FREE.join(",")} of page ${PAGE} are empty (nothing of the operator's is touched there)`, freeOk, free.executors.map(targetSummary));
      if (!freeOk) throw new Error("the free range is not free");
      const seqs = SEQUENCES === "auto" ? pickSequences(ctxAll.result.executors) : SEQUENCES.split(",");
      if (seqs.length < 2) throw new Error(`need two inactive sequences to assign (found ${JSON.stringify(seqs)}; set KB22_SEQUENCES)`);
      const [S1, S2] = seqs;
      const otherPage = PAGE === 1 ? 2 : 1;
      cleanup.add(`Page ${PAGE}`, () => A.request("cmd", { command: `Page ${PAGE}` }));
      cleanup.add("control.close A", () => A.request("control.close"));
      cleanup.add("control.close B", () => B.request("control.close").catch(() => ({ ok: true })));
      cleanup.add("release held keys and touches", releaseAll);
      await claimDeferred();

      // 1. The probe's own assignments: S1 at e0, S2 at e1 (defaults: what the console configures on a fresh assignment).
      for (const [e, s] of [[e0, S1], [e1, S2]]) {
        cleanup.add(`Delete Page ${PAGE}.${e} /NoConfirmation`, () => A.request("cmd", { command: `Delete Page ${PAGE}.${e} /NoConfirmation` }));
        await cmd(`Assign ${s} At Page ${PAGE}.${e}`);
      }
      const t0 = await target(e0); const t1 = await target(e1);
      note("run: the functions the console configured on the fresh assignments", { [e0]: targetSummary({ available: true, value: t0 }), [e1]: targetSummary({ available: true, value: t1 }) });
      record(`run: ${S1} at ${e0} and ${S2} at ${e1} are playback targets with a qualified key function and the Master fader function, both inactive`, t0.playbackTarget && t1.playbackTarget && isQualified(t0.functions?.keyPress, QUALIFIED.keys) && isQualified(t1.functions?.keyPress, QUALIFIED.keys) && norm(t0.functions?.fader) === "master" && t0.active === false && t1.active === false, { t0: targetSummary({ available: true, value: t0 }), t1: targetSummary({ available: true, value: t1 }) });
      const keyFn0 = t0.functions.keyPress;
      await bindTo({ executors: [e0, e1], executorPage: PAGE });

      // 2. A key down/up on e0 is Press/Unpress Page P.e0: the console runs the configured function (Go+ starts S1).
      const g0 = guardKey(e0, `Off ${S1}`);
      const c0 = await backendCounters();
      const rD = await submit([ev.down(e0)], "down e0");
      await settle();
      const laD = await lastApplied();
      const actDuring = await active(e0);
      record(`run: a down on ${e0} (${keyFn0}) is admitted and applied as "Press Page ${PAGE}.${e0}"; the record names the configured key function; ${S1} is active afterwards (the console ran ${keyFn0})`, rD.result.outcomes[0].accepted && laD?.outcome === "applied" && laD.result?.command === `Press Page ${PAGE}.${e0}` && laD.result.keyFunction === keyFn0 && actDuring === true, { outcome: outcomesOf(rD), lastApplied: laD, active: actDuring });
      const busyCmd = await A.request("cmd", { command: `Page ${PAGE}` });
      record("run: a console command while the key is held is refused [busy] by the bridge", !busyCmd.ok && busyCmd.code === "busy", busyCmd);
      const rU = await submit([ev.up(e0)], "up e0");
      await settle();
      const laU = await lastApplied();
      record(`run: the release is applied as "Unpress Page ${PAGE}.${e0}" and the instance is idle`, rU.result.outcomes[0].accepted && laU?.result?.command === `Unpress Page ${PAGE}.${e0}` && laU.down === false && (await status()).busy == null, { outcome: outcomesOf(rU), lastApplied: laU });
      g0.done();
      record("run: the backend counted the two commands as applied", ((await backendCounters()).applied ?? 0) - (c0.applied ?? 0) === 2, await backendCounters());
      // Page navigation neither stops the running S1 nor starts page `otherPage`'s executors.
      const beforeNav = (await context({ allExecutors: true, executorPage: otherPage })).executors.filter((x) => x.available && x.value.active === true).map((x) => x.value.executor);
      await cmd(`Page ${otherPage}`); await sleep(500);
      const afterNav = (await context({ allExecutors: true, executorPage: otherPage })).executors.filter((x) => x.available && x.value.active === true).map((x) => x.value.executor);
      const stillActive = await active(e0);
      await cmd(`Page ${PAGE}`); await sleep(500);
      record(`run: Page ${otherPage} / Page ${PAGE} neither stops the running ${S1} nor starts page ${otherPage}'s executors (active there before: ${beforeNav.length}, after: ${afterNav.length})`, stillActive === true && JSON.stringify(beforeNav) === JSON.stringify(afterNav) && (await active(e0)) === true, { beforeNav, afterNav, stillActive });
      await cmd(`Off ${S1}`); await settle();
      record(`run: Off ${S1} ends it (the probe's cleanup for a latching key function)`, (await active(e0)) === false);
      g0.offDone();

      // 3. The Master fader on e0: placed through the configured function, read back, restored.
      const orig0 = await level(e0);
      if (typeof orig0 !== "number") throw new Error(`the Master level of ${e0} is unreadable (${JSON.stringify(t0.level)})`);
      const restore0 = cleanup.add(`FaderMaster Page ${PAGE}.${e0} At ${orig0}`, () => A.request("cmd", { command: `FaderMaster Page ${PAGE}.${e0} At ${orig0}` }));
      const want = orig0 >= 50 ? 0.25 : 0.75;
      const rT = await submit([ev.touch(e0, true), ev.abs(e0, want)], "touch + position e0");
      await settle();
      const lvl = await level(e0);
      const laF = await lastApplied();
      record(`run: a touch on the ${e0} fader is a hold (busy) and a position ${want} is applied as "FaderMaster Page ${PAGE}.${e0} At ${want * 100}"; the Master level reads ${want * 100}`, rT.result.outcomes.every((o) => o.accepted) && laF?.result?.command === `FaderMaster Page ${PAGE}.${e0} At ${want * 100}` && laF.result.faderFunction === "Master" && typeof lvl === "number" && Math.abs(lvl - want * 100) <= 0.5 && (await status()).busy?.reason === "touch-down", { outcome: outcomesOf(rT), lastApplied: laF, level: lvl });
      const rS = await submit([ev.abs(e0, 0.3), ev.abs(e0, 0.5)], "two positions");
      await settle();
      const lvl2 = await level(e0);
      note("run: two Master positions in one request: the second supersedes the first while queued (stateless function); the level afterwards", { outcomes: outcomesOf(rS), level: lvl2, lastCommand: (await lastApplied())?.result?.command });
      record("run: the Master level is 50 after the pair (At 50 was applied last)", typeof lvl2 === "number" && Math.abs(lvl2 - 50) <= 0.5, { level: lvl2 });
      await submit([ev.touch(e0, false)], "lift"); await lapse();
      await cmd(`FaderMaster Page ${PAGE}.${e0} At ${orig0}`); await settle();
      const back = await level(e0);
      record(`run: the Master level is restored to ${orig0}`, typeof back === "number" && Math.abs(back - orig0) <= 0.5, { back });
      if (typeof back === "number" && Math.abs(back - orig0) <= 0.5) restore0.done();

      // 4. Momentary keys on the operator's executors: Temp and Flash active while held, released by the up and by a disconnect.
      for (const fn of ["Temp", "Flash"]) {
        const cands = pickByFunction(ctxAll.result.executors, "key", fn, { exclude: FREE });
        if (!cands.length) { note(`run: no inactive executor with key function ${fn} on page ${PAGE}; ${fn} stays qualified by KB-16 only`); continue; }
        const e = cands[0].value.executor; const obj = cands[0].value.assigned?.addr;
        await bindTo({ executors: [e0, e1, e], executorPage: PAGE });
        const g = guardKey(e);
        const rd = await submit([ev.down(e)], `down ${fn}`); await settle();
        const during = await active(e);
        const ru = await submit([ev.up(e)], `up ${fn}`); await settle();
        const after = await active(e);
        record(`run: ${fn} on ${e} (${obj}): active while held through "Press Page ${PAGE}.${e}", inactive after "Unpress Page ${PAGE}.${e}"`, rd.result.outcomes[0].accepted && during === true && ru.result.outcomes[0].accepted && after === false && (await lastApplied())?.result?.momentary === true, { down: outcomesOf(rd), during, up: outcomesOf(ru), after });
        if (after === false) g.done();
        if (fn === "Temp") {
          // Disconnect recovery: a second connection holds Temp and drops; the bridge ends its session and the Unpress is issued.
          await B.connect();
          const gB = guardKey(e);
          const rB = await B.request("control.submit", { events: [{ type: "button", device: "probe-mplay", control: "PFD1", seq: 1, generation: gen, binding: brev, target: { executor: e, element: "key", page: PAGE }, down: true }] });
          await settle();
          const heldB = await active(e);
          await B.end(); await sleep(900);
          const afterB = await active(e);
          record(`run: a surface that disconnects while holding Temp on ${e}: active while held, released by the bridge on the disconnect (Unpress issued, nothing left unresolved)`, rB.ok && rB.result.outcomes[0].accepted && heldB === true && afterB === false && (await status()).unresolved.length === 0, { b: rB.ok ? outcomesOf(rB) : rB, heldB, afterB });
          if (afterB === false) gB.done();
        }
      }
      // Toggle latches: a tap starts, a second tap stops.
      {
        const cands = pickByFunction(ctxAll.result.executors, "key", "Toggle", { exclude: FREE });
        if (!cands.length) note(`run: no inactive executor with key function Toggle on page ${PAGE}; Toggle stays qualified by KB-16 only`);
        else {
          const e = cands[0].value.executor; const obj = cands[0].value.assigned?.addr;
          await bindTo({ executors: [e0, e1, e], executorPage: PAGE });
          const g = guardKey(e, `Off ${obj}`);
          await submit([ev.down(e)], "tap toggle"); await sleep(120); await submit([ev.up(e)], "tap toggle up"); await settle();
          const on = await active(e);
          await submit([ev.down(e)], "tap toggle 2"); await sleep(120); await submit([ev.up(e)], "tap toggle 2 up"); await settle();
          const off = await active(e);
          record(`run: Toggle on ${e} (${obj}): a tap (Press, Unpress) starts it, a second tap stops it; nothing is translated into Go+`, on === true && off === false, { on, off });
          g.done(); if (off === false) g.offDone();
        }
      }

      // 5. A Temp fader (the operator's executor with fader function Temp, level 0): positions are stateful and a level above 0 starts the playback.
      {
        const cands = pickByFunction(ctxAll.result.executors, "fader", "Temp", { exclude: FREE }).filter((x) => x.value.level?.value === 0);
        if (!cands.length) note(`run: no inactive executor with fader function Temp at level 0 on page ${PAGE}; FaderTemp stays qualified by KB-16 only`);
        else {
          const e = cands[0].value.executor; const obj = cands[0].value.assigned?.addr;
          await bindTo({ executors: [e0, e1, e], executorPage: PAGE });
          const restoreT = cleanup.add(`FaderTemp Page ${PAGE}.${e} At 0`, () => A.request("cmd", { command: `FaderTemp Page ${PAGE}.${e} At 0` }));
          const cT = await backendCounters();
          const r1 = await submit([ev.touch(e, true), ev.abs(e, 0.6)], "temp up"); await settle();
          const lvlT = await level(e); const actT = await active(e);
          const r2 = await submit([ev.abs(e, 0.2), ev.abs(e, 0)], "temp down (two positions)"); await settle();
          const lvl0 = await level(e); const act0 = await active(e);
          await submit([ev.touch(e, false)], "lift"); await lapse();
          record(`run: the Temp fader of ${e} (${obj}): "FaderTemp Page ${PAGE}.${e} At 60" reads 60 and starts the playback; the pair At 20, At 0 is applied in order (stateful: not superseded) and At 0 ends it`, r1.result.outcomes.every((o) => o.accepted) && Math.abs((lvlT ?? -1) - 60) <= 0.5 && actT === true && r2.result.outcomes.every((o) => o.accepted && !o.superseded) && Math.abs(lvl0 ?? -1) <= 0.5 && act0 === false && ((await backendCounters()).applied ?? 0) - (cT.applied ?? 0) === 3, { r1: outcomesOf(r1), lvlT, actT, r2: outcomesOf(r2), lvl0, act0 });
          if (Math.abs(lvl0 ?? -1) <= 0.5 && act0 === false) restoreT.done();
        }
      }

      // 6. Unqualified functions are refused at admission; the Rate exploration on the probe's own executor.
      await bindTo({ executors: [e0, e1], executorPage: PAGE });
      const rEnc = await submit([ev.down(e0, "encoder")], "encoder element");
      record(`run: the ENCODER element of ${e0} is refused unsupported (not qualified)`, rEnc.result.outcomes[0].refused === (t0.functions?.encoder ? "unsupported" : "target-unavailable"), outcomesOf(rEnc));
      const setFn = await lua(LUA_SET_FADER_FN(PAGE, e1, "Rate"));
      note(`run: exploration: can the fader function of ${e1} be set to Rate through the executor's property? (set result, read-back)`, setFn);
      const t1b = await target(e1);
      if (norm(t1b.functions?.fader) === "rate") {
        cleanup.add(`fader function of Page ${PAGE}.${e1} back to ${t1.functions?.fader}`, () => A.request("lua", { code: LUA_SET_FADER_FN(PAGE, e1, t1.functions?.fader ?? "Master"), maxMs: 2000 }));
        await sleep(600);
        const cR = await context({ executors: [e0, e1], executorPage: PAGE, cached: true }); gen = cR.generation;
        const rR = await submit([ev.touch(e1, true), ev.abs(e1, 0.75)], "rate position");
        await submit([ev.touch(e1, false)], "lift"); await lapse();
        record(`run: with Rate configured on ${e1} a position is refused unsupported naming Rate (qualified separately; not yet)`, rR.result.outcomes[1]?.refused === "unsupported" && /Rate is not qualified yet/.test(rR.result.outcomes[1].reason ?? ""), outcomesOf(rR));
        const rateBefore = (await lua(LUA_OBJ_FADER(PAGE, e1, "FaderRate")))?.[0];
        const restoreR = cleanup.add(`FaderRate Page ${PAGE}.${e1} At ${rateBefore}`, () => A.request("cmd", { command: `FaderRate Page ${PAGE}.${e1} At ${rateBefore}` }));
        const fr = await A.request("cmd", { command: `FaderRate Page ${PAGE}.${e1} At 75` }); await settle();
        const rateAfter = (await lua(LUA_OBJ_FADER(PAGE, e1, "FaderRate")))?.[0];
        const lvlR = await level(e1);
        note(`run: exploration: "FaderRate Page ${PAGE}.${e1} At 75" on a Rate-configured executor (feedback, object FaderRate before/after, binding level)`, { feedback: fr.ok ? fr.result?.feedback : fr.error, rateBefore, rateAfter, bindingLevel: lvlR });
        await cmd(`FaderRate Page ${PAGE}.${e1} At ${rateBefore}`); await settle();
        if (Math.abs(((await lua(LUA_OBJ_FADER(PAGE, e1, "FaderRate")))?.[0] ?? -1) - rateBefore) <= 0.5) restoreR.done();
        await lua(LUA_SET_FADER_FN(PAGE, e1, t1.functions?.fader ?? "Master")); await sleep(600);
      } else note("run: the fader function is not settable per executor through the property; Rate/Speed/X stay unqualified (an executor configuration with that function would be needed)");

      // 7. Reassignment while held: the release becomes an assignment-changed record; recover() releases once the object is back.
      const cR0 = await context({ executors: [e0, e1], executorPage: PAGE, cached: true }); gen = cR0.generation; brev = (await status()).binding?.revision ?? brev;
      const gR = guardKey(e1, `Off ${S2}`);
      cleanup.add(`Assign ${S2} At Page ${PAGE}.${e1} (the original object back)`, () => A.request("cmd", { command: `Assign ${S2} At Page ${PAGE}.${e1}` }));
      await deferredFire(`Assign ${S1} At Page ${PAGE}.${e1}`);
      const rH = await submit([ev.down(e1)], "down e1 (to be reassigned)");
      await deferredLapse();
      const cRe = await context({ executors: [e0, e1], executorPage: PAGE, cached: true });
      const rRel = await submit([ev.up(e1)], "up e1 after the reassignment"); await settle();
      let stR = await status();
      record(`run: ${e1} reassigned (${S2} -> ${S1}) while held: the release is admitted but NOT issued on the replacement; it is an assignment-changed record naming ${S2}, nothing unresolved from a raise`, rH.result.outcomes[0].accepted && cRe.executors[1].value.assigned?.addr === S1 && rRel.result.outcomes[0].accepted && stR.lastApplied?.outcome === "unresolved" && stR.lastApplied.reassigned === true && stR.unresolved.length === 1 && stR.unresolved[0].resolved?.assigned === S2 && stR.unresolved[0].nowAssigned === S1, { held: outcomesOf(rH), target: targetSummary(cRe.executors[1]), release: outcomesOf(rRel), lastApplied: stR.lastApplied, unresolved: stR.unresolved });
      const rec0 = await A.request("control.recover");
      record("run: control.recover keeps it unresolved while the replacement is assigned (nothing issued)", rec0.ok && (rec0.result.unresolved?.length ?? 0) === 1 && (rec0.result.resolved?.length ?? 0) === 0, rec0);
      await cmd(`Assign ${S2} At Page ${PAGE}.${e1}`); await sleep(700);
      const rec1 = await A.request("control.recover"); await settle();
      stR = await status();
      record(`run: with ${S2} back on ${e1}, control.recover issues "Unpress Page ${PAGE}.${e1}" and resolves the record`, rec1.ok && (rec1.result.resolved?.length ?? 0) === 1 && stR.unresolved.length === 0 && stR.backendStatus?.lastCommand?.command === `Unpress Page ${PAGE}.${e1}`, { rec1, lastCommand: stR.backendStatus?.lastCommand });
      gR.done();
      const actS2 = await active(e1);
      if (actS2) { await cmd(`Off ${S2}`); await settle(); }
      gR.offDone();
    } catch (e) {
      mutationError = e;
      record("run: the mutation phase failed; running the registered undos", false, { error: String(e?.message ?? e), pending: cleanup.pending() });
    } finally {
      await sleep(GESTURE_LAPSE_MS);
      const outcomes = await cleanup.run();
      record("run: cleanup ran every registered undo", outcomes.every((o) => o.ok), outcomes);
      await B.end().catch(() => {});
    }
    await sleep(400);
    const fin = await A.request("feedback.context", { executors: FREE, executorPage: PAGE });
    record(`run: executors ${FREE.join(",")} are empty again and the console is back on page ${PAGE}`, fin.ok && fin.result.executorPage?.no === PAGE && fin.result.executors.every((x) => x.available && x.value.empty === true), fin.ok ? { page: fin.result.executorPage, targets: fin.result.executors.map(targetSummary) } : fin);
    const finAll = await A.request("feedback.context", { allExecutors: true });
    const stillOn = finAll.ok ? finAll.result.executors.filter((x) => x.available && x.value.active === true && !(ctxAll.result.executors.find((y) => y.available && y.value.executor === x.value.executor)?.value.active)).map(targetSummary) : [];
    record("run: no playback the probe touched is left active", finAll.ok && stillOn.length === 0, stillOn);
    const stF = await A.request("control.status");
    record("run: no session, gesture or queued intent is left; nothing is unresolved", stF.ok && Object.keys(stF.result.sessions).length === 0 && stF.result.unresolved.length === 0 && stF.result.busy == null, stF.ok ? { sessions: Object.keys(stF.result.sessions), unresolved: stF.result.unresolved } : stF);
    if (mutationError) failed = Math.max(failed, 1);
  }
  await A.request("feedback.unwatch").catch(() => {});
  await A.end();
  report.finishedAt = new Date().toISOString();
  report.passed = steps.filter((s) => s.pass === true).length;
  report.failed = failed;
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`\n${report.passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

if (process.argv[1] && /kb22-probe\.mjs$/.test(process.argv[1])) main().catch((e) => { console.error(e); process.exit(2); });
