#!/usr/bin/env node
// KB-21 playback-bank probe against a RUNNING bridge (plugin 0.17.0 or newer with gma3_mcp_control 0.4.0
// and gma3_mcp_feedback 0.5.0; see ENCODERS.md "KB-21", docs/modules.md "Explicit executor targets").
//
//   node scripts/kb21-probe.mjs verify [--out report.json]   read-only: nothing is queued, assigned or applied
//   node scripts/kb21-probe.mjs run    [--out report.json]   verify + executor bindings exercised on the FAKE
//                                                           control backend of a DISPOSABLE show: assignments
//                                                           are created in the free range and deleted again
//
// Surface banks (which physical controls map to which executor numbers) belong to the surface service; what the
// console half serves is what this probe checks: an executor target is EXPLICIT (pool, page, executor, element,
// mode current|page), a binding either FOLLOWS the user's page (its generation moves with `Page n`) or is bound to an
// INDEPENDENT page (read through ObjectList("Page P.E") while the console shows another page; its generation does not
// move with `Page n`), a page that does not exist is `pageMissing` and nothing creates it, a wider neighbour (an
// expanded assignment, Width > 1) COVERS the following numbers (not separate playbacks), a held button's target is
// FROZEN until its release (a page change, a reassignment or a deletion while it is held neither redirects the release
// nor reaches the new object), a second surface on the same executor is a `conflict`, and the owned Quickey bank's
// executors are never targets. `verify` submits only refusals by construction on the console backend (executor
// elements are unsupported there until KB-22; the refusal names the explicit target) and nothing at all on the fake
// backend. `run` needs a show whose name matches "disposable", "mcp-test" or "scratch", Lua enabled (page
// existence reads) and `Plugin "gma3_mcp_bridge" "control=fake"` (holds are recorded, nothing is pressed on the
// console; an operator decision this probe never makes). Every change registers its undo before dispatch; the
// cleanup runs them all. GMA3_BRIDGE_HOST / GMA3_BRIDGE_PORT select the bridge; KB21_PAGE (1) the page,
// KB21_FREE_EXECUTORS ("180,181,182,183") four EMPTY executors of that page (the KB-12 free range), KB21_SEQUENCES
// ("auto") two sequences to assign (auto picks two distinct Sequence objects already assigned on the page).
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
const PAGE = Number(process.env.KB21_PAGE ?? 1);
const FREE = (process.env.KB21_FREE_EXECUTORS ?? "180,181,182,183").split(",").map(Number);
const SEQUENCES = process.env.KB21_SEQUENCES ?? "auto";
const GESTURE_LAPSE_MS = 650;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lua returning which of pages 1..max exist (ObjectList("Page P") is the existence check, KB-12): a list of 0/1. */
export const LUA_PAGES = (max) => `local t = {}; for p = 1, ${max} do local l = ObjectList("Page " .. p); t[#t + 1] = (l and l[1]) and 1 or 0 end; return t`;
/** Lua reading what the console itself answers for executor E of page P: GetExecutor (user page) and ObjectList (paged). */
export const LUA_EXEC = (page, exec) => `local l = ObjectList("Page ${page}.${exec}"); local h = l and l[1]; local g = GetExecutor(${exec}); local function d(x) if x == nil then return "nil" end; local o = x.Object; return string.format("%s|width=%s|object=%s", tostring(x:GetClass()), tostring(x:Get("Width", Enums.Roles.Display)), o and tostring(o:Addr()) or "nil") end; return d(h), d(g)`;

/** The first page number (2..) the console reports as missing, from the LUA_PAGES list; undefined when every probed page exists. */
export function firstMissingPage(list) {
  if (!Array.isArray(list)) return undefined;
  for (let i = 1; i < list.length; i += 1) if (list[i] === 0) return i + 1;
  return undefined;
}

/** Summarises an executor target of a snapshot for the report. */
export function targetSummary(x) {
  if (!x) return undefined;
  if (!x.available) return { executor: x.params?.executor, page: x.params?.page, unavailable: x.reason ?? x.error };
  const v = x.value;
  return { executor: v.executor, page: v.page?.no, mode: v.mode, pool: v.pool?.name, empty: v.empty, assigned: v.assigned?.addr ?? v.assigned?.name, class: v.assigned?.class, width: v.width, expanded: v.expanded, coveredBy: v.coveredBy, pageMissing: v.pageMissing, reserved: v.reserved, playbackTarget: v.playbackTarget, reason: v.reason, keyPress: v.functions?.keyPress, fader: v.functions?.fader };
}

/** Picks two distinct Sequence objects assigned on the page (never a Quickey, never a reserved executor). */
export function pickSequences(executors, want = 2) {
  const out = [];
  for (const x of executors ?? []) {
    const v = x.available && x.value;
    const addr = v && v.playbackTarget && v.assigned?.class === "Sequence" && v.assigned.addr;
    if (addr && !out.includes(addr)) out.push(addr);
    if (out.length >= want) break;
  }
  return out;
}

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
    console.error("usage: node scripts/kb21-probe.mjs verify|run [--out report.json]");
    process.exit(2);
  }
  const A = new Conn("a");
  await A.connect();
  const pingR = await A.request("ping");
  if (!pingR.ok) { console.error(`ping failed: ${pingR.error}`); process.exit(2); }
  const ping = pingR.result;
  const [maj, min] = String(ping.bridgeVersion ?? "0.0").split(".").map(Number);
  if (maj < 0 || (maj === 0 && min < 17)) { console.error(`bridge ${ping.bridgeVersion} has no explicit executor pages; update the plugin to 0.17.0 or newer (docs/setup/bridge.md)`); process.exit(2); }
  if (!ping.modules?.control?.loaded) { console.error(`the control module is not loaded: ${ping.modules?.control?.error ?? "no module summary"}`); process.exit(2); }
  const [cmaj, cmin] = String(ping.modules.control.version ?? "0.0").split(".").map(Number);
  if (cmaj === 0 && cmin < 4) { console.error(`control module ${ping.modules.control.version} resolves executors by number only; 0.4.0 or newer is needed`); process.exit(2); }
  if (!ping.modules?.feedback?.loaded) { console.error(`the feedback module is not loaded: ${ping.modules?.feedback?.error ?? "no module summary"}`); process.exit(2); }
  const [fmaj, fmin] = String(ping.modules.feedback.version ?? "0.0").split(".").map(Number);
  if (fmaj === 0 && fmin < 5) { console.error(`feedback module ${ping.modules.feedback.version} reads the user's page only; 0.5.0 or newer is needed`); process.exit(2); }
  if (mode === "run") {
    if (!SHOW_GUARD.test(String(ping.showfile ?? ""))) { console.error(`show "${ping.showfile}" does not look disposable (expected a name matching ${SHOW_GUARD}); refusing to change state`); process.exit(2); }
    if (!ping.control?.enabled || ping.control.backend !== "fake") { console.error('run needs continuous control enabled on the FAKE backend by the operator (holds are recorded, nothing is pressed):  Plugin "gma3_mcp_bridge" "control=fake"'); process.exit(2); }
    if (!ping.lua?.enabled) { console.error('run needs Lua enabled on the bridge (Plugin "gma3_mcp_bridge" "lua on") for the page-existence reads'); process.exit(2); }
    if (ping.input?.busy) { console.error(`the bridge is busy (${JSON.stringify(ping.input.busy)}); wait for the owner to finish`); process.exit(2); }
  }
  const report = { mode, host, port, startedAt: new Date().toISOString(), ping: { bridgeVersion: ping.bridgeVersion, build: ping.build, hostname: ping.hostname, showfile: ping.showfile, user: ping.user, modules: ping.modules, input: ping.input, control: ping.control, lua: { enabled: ping.lua?.enabled } }, steps };
  note("console", report.ping);

  // ---- verify: read-only ----
  const st0 = await A.request("control.status");
  record("control.status answers with the module version and a limitation naming explicit targets and frozen holds (KB-21)", st0.ok && st0.result.version === ping.modules.control.version && Array.isArray(st0.result.limitations) && st0.result.limitations.some((l) => /KB-21/.test(l) && /frozen/.test(l)), st0.ok ? { version: st0.result.version, limitations: st0.result.limitations } : st0);
  const ctxAll = await A.request("feedback.context", { allExecutors: true });
  record("feedback.context lists the executors of the user's current page with an explicit identity on each (pool, page, mode=current)", ctxAll.ok && ctxAll.result.executorMode === "current" && Array.isArray(ctxAll.result.executors) && ctxAll.result.executors.filter((x) => x.available).every((x) => x.value.mode === "current" && x.value.pool?.name !== undefined && x.value.page?.no === ctxAll.result.executorPage?.no), ctxAll.ok ? { page: ctxAll.result.executorPage, count: ctxAll.result.executors?.length, first: targetSummary(ctxAll.result.executors?.[0]) } : ctxAll);
  const pageNo = ctxAll.ok ? ctxAll.result.executorPage?.no : undefined;
  const assigned = ctxAll.ok ? ctxAll.result.executors.filter((x) => x.available && !x.value.empty) : [];
  const widths = assigned.map((x) => x.value.width);
  note("widths of the assigned executors as the console reports them (an expanded assignment would be > 1)", { widths, expanded: assigned.filter((x) => x.value.expanded).map((x) => targetSummary(x)) });
  const covered = ctxAll.ok ? ctxAll.result.executors.filter((x) => x.available && x.value.coveredBy != null).map((x) => targetSummary(x)) : [];
  if (covered.length) note("executors the reader reports covered by a wider neighbour", covered);
  const quickeys = assigned.filter((x) => x.value.assigned?.class === "Quickey" || x.value.reserved);
  if (quickeys.length) record("Quickey objects and reserved executors are never playback targets", quickeys.every((x) => x.value.playbackTarget === false), quickeys.map(targetSummary));
  else note("no Quickey or reserved executor on the page (the owned bank is not provisioned); the exclusion is harness evidence");
  const execNumbers = assigned.filter((x) => x.value.playbackTarget).map((x) => x.value.executor).slice(0, 4);
  if (typeof pageNo === "number" && execNumbers.length) {
    const ctxP = await A.request("feedback.context", { executors: execNumbers, executorPage: pageNo });
    record(`feedback.context bound to page ${pageNo} explicitly reads the same executors through ObjectList (mode=page) with the same assignments`, ctxP.ok && ctxP.result.executorMode === "page" && ctxP.result.executorSpecPage === pageNo && ctxP.result.executors.every((x, i) => x.available && x.value.mode === "page" && x.value.page?.no === pageNo && (x.value.assigned?.addr ?? x.value.assigned?.name) === (assigned.find((a) => a.value.executor === x.value.executor)?.value.assigned?.addr ?? assigned.find((a) => a.value.executor === x.value.executor)?.value.assigned?.name)), ctxP.ok ? ctxP.result.executors.map(targetSummary) : ctxP);
  } else note("verify: no playback executor on the page; the explicit-page read is not exercised");
  const ctxM = await A.request("feedback.context", { executors: [execNumbers[0] ?? 1], executorPage: 9999 });
  record("feedback.context bound to page 9999 reports every target pageMissing (and the console still has no such page: nothing is created)", ctxM.ok && ctxM.result.executors[0]?.available && ctxM.result.executors[0].value.pageMissing === true && ctxM.result.executors[0].value.playbackTarget === false, ctxM.ok ? targetSummary(ctxM.result.executors[0]) : ctxM);
  // Bind and submit refusals only.
  let brev;
  let gen;
  let seq = 0;
  const ev = {
    down: (executor, extra = {}) => ({ type: "button", device: "probe-mtouch", control: `PFA${executor}`, seq: ++seq, generation: gen, binding: brev, target: { executor, element: "key" }, down: true, ...extra }),
    up: (executor, extra = {}) => ({ type: "button", device: "probe-mtouch", control: `PFA${executor}`, seq: ++seq, target: { executor, element: "key" }, down: false, ...extra }),
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
  const backend = ping.control?.enabled ? ping.control.backend : null;
  if (execNumbers.length && typeof pageNo === "number") {
    const s0 = await bindTo({ executors: execNumbers, executorPage: pageNo });
    record("control.bind with executorPage: the binding key names the page and the cached snapshot claims a generation", s0.bindingKey?.includes(`page=${pageNo}`) && s0.executorMode === "page" && typeof gen === "number", { bindingKey: s0.bindingKey, generation: gen, binding: brev });
    if (backend === "console") {
      const r = await A.request("control.submit", { events: [ev.down(execNumbers[0], { target: { executor: execNumbers[0], element: "key", page: pageNo } }), ev.down(execNumbers[0], { control: "PFAnopage" })] });
      const o = r.ok ? r.result.outcomes : [];
      record("verify (console backend): a down on the page-bound executor resolves to its explicit target and is refused unsupported there (executor elements are KB-22; the refusal names pool and page); the same number without target.page is target-unavailable (never silently the current page): nothing is queued, nothing owned", r.ok && o[0]?.refused === "unsupported" && new RegExp(`exec[^/]*/${pageNo}\\.${execNumbers[0]}\\.key`).test(o[0].message ?? "") && o[1]?.refused === "target-unavailable" && /needs target\.page/.test(o[1].message ?? "") && r.result.accepted === 0, outcomesOf(r));
    } else if (backend === "fake") {
      const r = await A.request("control.submit", { events: [ev.down(execNumbers[0], { control: "PFAnopage" }), ev.down(execNumbers[0], { target: { executor: execNumbers[0], element: "key", page: 9999 } })] });
      const o = r.ok ? r.result.outcomes : [];
      record("verify (fake backend): a page-bound executor without target.page and a target on page 9999 are both target-unavailable (bind first / not in the binding): nothing is queued, nothing owned", r.ok && o[0]?.refused === "target-unavailable" && /needs target\.page/.test(o[0].message ?? "") && o[1]?.refused === "target-unavailable" && r.result.accepted === 0, outcomesOf(r));
    } else {
      const off = await A.request("control.submit", { events: [ev.down(execNumbers[0])] });
      record("verify: control.submit is [control-disabled] until the operator enables control", !off.ok && off.code === "control-disabled", off);
    }
    const st1 = await A.request("control.status");
    record("verify: nothing queued, no gesture, not busy", st1.ok && st1.result.busy == null && Object.values(st1.result.sessions).every((s) => s.queued === 0 && s.gestures === 0), st1.ok ? st1.result.sessions : st1);
    if (mode !== "run") { await A.request("control.close"); }
  } else note("verify: no playback executor on the page; binding checks are not exercised");

  // ---- run: executor bindings on the fake backend of a disposable show ----
  if (mode === "run") {
    const cleanup = createCleanup();
    let mutationError = null;
    const need = (r, what) => { if (!r.ok) throw new Error(`${what}: ${r.error}`); return r; };
    const cmd = async (c) => need(await A.request("cmd", { command: c }), c);
    const lua = async (code) => need(await A.request("lua", { code, maxMs: 2000 }), "lua").result?.values;
    const submit = async (events, what) => need(await A.request("control.submit", { events }), what);
    const status = async () => need(await A.request("control.status"), "control.status").result;
    const context = async (spec) => need(await A.request("feedback.context", spec), "feedback.context").result;
    const lastApplied = async () => (await status()).lastApplied;
    const settle = () => sleep(GESTURE_LAPSE_MS);
    const B = new Conn("b");
    const [e0, e1, e2, e3] = FREE;
    try {
      if (pageNo !== PAGE) throw new Error(`the console is on page ${pageNo}, the probe expects page ${PAGE} (KB21_PAGE)`);
      const free = await context({ executors: FREE });
      record(`run: preflight: executors ${FREE.join(",")} of page ${PAGE} are empty (nothing of the operator's is touched)`, free.executors.every((x) => x.available && x.value.empty === true && !x.value.reserved && x.value.coveredBy == null), free.executors.map(targetSummary));
      if (!free.executors.every((x) => x.available && x.value.empty === true && !x.value.reserved && x.value.coveredBy == null)) throw new Error("the free range is not free");
      const seqs = SEQUENCES === "auto" ? pickSequences(ctxAll.result.executors) : SEQUENCES.split(",");
      if (seqs.length < 2) throw new Error(`need two sequences to assign (found ${JSON.stringify(seqs)}; set KB21_SEQUENCES)`);
      const [S1, S2] = seqs;
      const pagesBefore = await lua(LUA_PAGES(32));
      const missing = firstMissingPage(pagesBefore?.[0]);
      note("pages that exist (1..32) before the run", { pages: pagesBefore?.[0], firstMissing: missing });
      cleanup.add(`Page ${PAGE}`, () => A.request("cmd", { command: `Page ${PAGE}` }));
      cleanup.add("control.close A", () => A.request("control.close"));
      cleanup.add("control.close B", () => B.request("control.close").catch(() => ({ ok: true })));
      cleanup.add("release held buttons", async () => { for (const e of FREE) { await A.request("control.submit", { events: [ev.up(e)] }); } await sleep(200); });

      // 1. Assignments in the free range: S1 at e0 (to be widened), S1 at e2 (to be deleted while held), S2 at e3 (to be reassigned while held).
      for (const [e, s] of [[e0, S1], [e2, S1], [e3, S2]]) {
        cleanup.add(`Delete Page ${PAGE}.${e} /NoConfirmation`, () => A.request("cmd", { command: `Delete Page ${PAGE}.${e} /NoConfirmation` }));
        await cmd(`Assign ${s} At Page ${PAGE}.${e}`);
      }
      let c = await context({ executors: FREE });
      record(`run: ${S1} assigned at ${e0} and ${e2}, ${S2} at ${e3}; ${e1} stays empty; each a playback target with width 1`, [e0, e2].every((e) => c.executors.find((x) => x.value.executor === e)?.value.assigned?.addr === S1) && c.executors.find((x) => x.value.executor === e3)?.value.assigned?.addr === S2 && c.executors.find((x) => x.value.executor === e1)?.value.empty && c.executors.filter((x) => !x.value.empty).every((x) => x.value.playbackTarget && x.value.width === 1), c.executors.map(targetSummary));

      // 2. An expanded assignment: widen e0 to 2 and read what the console says about e1.
      let widened = false;
      for (const form of [`Set Page ${PAGE}.${e0} Property "Width" "2"`, `Set Page ${PAGE}.${e0} Property Width 2`]) {
        const r = await A.request("cmd", { command: form });
        c = await context({ executors: [e0, e1] });
        if (r.ok && c.executors[0].value.width === 2) { widened = form; break; }
      }
      const rawE1 = await lua(LUA_EXEC(PAGE, e1));
      if (widened) {
        record(`run: ${widened} makes ${e0} an expanded assignment (width 2, expanded) and the reader reports ${e1} covered by ${e0}: not a separate playback`, c.executors[0].value.expanded === true && c.executors[1].value.coveredBy === e0 && c.executors[1].value.playbackTarget === false, { targets: c.executors.map(targetSummary), consoleSays: { [`Page ${PAGE}.${e1}`]: rawE1?.[0], [`GetExecutor(${e1})`]: rawE1?.[1] } });
        note(`what the console itself answers for the covered number ${e1}`, { paged: rawE1?.[0], getExecutor: rawE1?.[1] });
      } else {
        note("run: neither Set form changed the executor's Width; expanded assignments stay harness evidence (the Width readback is what the reader uses)", { widthRead: c.executors[0].value.width, consoleSays: rawE1 });
      }

      // 3. A following binding: a held button survives a page change frozen to page 1's object.
      let snap = await bindTo({ executors: [e0, e1, e2, e3] });
      const genFollow = gen;
      const r1 = await submit([ev.down(e0)], "down e0 (follow)");
      await sleep(150);
      let st = await status();
      const held = st.sessions[st.yourSession]?.gestureList?.[0];
      record(`run: a down on ${e0} (following binding) is admitted on the fake backend and the status shows what it is frozen to (page ${PAGE}, ${S1})`, r1.result.outcomes[0].accepted && held?.frozen?.executor === e0 && held.frozen.page === PAGE && held.frozen.assigned === S1 && held.frozen.pool != null, { outcome: outcomesOf(r1), held });
      const otherPage = PAGE === 1 ? 2 : 1;
      const pageExists = pagesBefore?.[0]?.[otherPage - 1] === 1;
      if (!pageExists) throw new Error(`page ${otherPage} does not exist on this show; the probe needs it for the page-change checks (it never creates pages)`);
      await cmd(`Page ${otherPage}`);
      await sleep(500);
      const cF = await context({ executors: [e0, e1, e2, e3], cached: true });
      record(`run: Page ${otherPage} moves the following binding's generation; its targets are now page ${otherPage}'s (${e0} ${cF.executors[0].value.empty ? "empty" : "assigned"} there)`, cF.executorPage?.no === otherPage && cF.generation !== genFollow && cF.executors[0].value.page?.no === otherPage, { generation: [genFollow, cF.generation], target: targetSummary(cF.executors[0]) });
      st = await status();
      record("run: the hold is still owned, now marked rebound; its frozen target is unchanged", st.sessions[st.yourSession]?.gestureList?.[0]?.rebound === true && st.sessions[st.yourSession].gestureList[0].frozen.page === PAGE && st.sessions[st.yourSession].gestureList[0].frozen.assigned === S1, st.sessions[st.yourSession]?.gestureList);
      const rU = await submit([ev.up(e0)], "up e0 after the page change");
      await settle();
      const la = await lastApplied();
      record(`run: the release is admitted without a binding and applied to the FROZEN target (page ${PAGE}.${e0} ${S1}), not to page ${otherPage}'s ${e0}`, rU.result.outcomes[0].accepted && rU.result.outcomes[0].boundary === true && la?.outcome === "applied" && la.kind === "button" && la.down === false && new RegExp(`/${PAGE}\\.${e0}\\.key\\|${S1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(la.target ?? ""), { outcome: outcomesOf(rU), lastApplied: la });
      gen = cF.generation;
      const rN = await submit([ev.down(e0, { generation: gen })], "down e0 on the other page");
      record(`run: a fresh down on ${e0} while the console shows page ${otherPage} resolves against page ${otherPage}'s executor (${cF.executors[0].value.empty ? "empty: target-unavailable" : "its own assignment"}), never the frozen one`, cF.executors[0].value.empty ? rN.result.outcomes[0].refused === "target-unavailable" : rN.result.outcomes[0].accepted, outcomesOf(rN));
      if (!cF.executors[0].value.empty) { await submit([ev.up(e0)], "up"); await settle(); }
      await cmd(`Page ${PAGE}`);
      await sleep(500);

      // 4. An independent-page binding: the generation ignores the console's page; a page-bound down works from another page.
      snap = await bindTo({ executors: [e0, e2, e3], executorPage: PAGE });
      const genIndep = gen;
      await cmd(`Page ${otherPage}`);
      await sleep(600);
      const cI = await context({ executors: [e0, e2, e3], executorPage: PAGE, cached: true });
      record(`run: with the binding bound to page ${PAGE} explicitly, Page ${otherPage} does not move its generation and the targets still read page ${PAGE}'s assignments through ObjectList`, cI.generation === genIndep && cI.executorPage?.no === otherPage && cI.executors.every((x) => x.value.page?.no === PAGE) && cI.executors[0].value.assigned?.addr === S1, { generation: [genIndep, cI.generation], userPage: cI.executorPage, targets: cI.executors.map(targetSummary) });
      const rI = await submit([ev.down(e2, { target: { executor: e2, element: "key", page: PAGE } })], "page-bound down");
      await sleep(100);
      st = await status();
      record(`run: a down naming page ${PAGE} is admitted while the console shows page ${otherPage}; the hold is frozen to page ${PAGE}.${e2}`, rI.result.outcomes[0].accepted && st.sessions[st.yourSession]?.gestureList?.[0]?.frozen?.page === PAGE, { outcome: outcomesOf(rI), held: st.sessions[st.yourSession]?.gestureList });
      const rI2 = await submit([ev.down(e2, { control: "PFAcur" })], "down without page");
      record("run: the same number without target.page is target-unavailable on an independent binding (never silently the current page)", rI2.result.outcomes[0].refused === "target-unavailable" && /needs target\.page/.test(rI2.result.outcomes[0].message ?? ""), outcomesOf(rI2));
      await cmd(`Page ${PAGE}`);
      await sleep(400);

      // 5. Deletion while held: the release goes to the recorded target; the next down finds it empty.
      await cmd(`Delete Page ${PAGE}.${e2} /NoConfirmation`);
      await sleep(600);
      const cD = await context({ executors: [e0, e2, e3], executorPage: PAGE, cached: true });
      const rD = await submit([ev.up(e2)], "up e2 after deletion");
      await settle();
      const laD = await lastApplied();
      record(`run: deleting the assignment of ${e2} while it is held moves the generation and empties the target; the release still goes to the recorded ${S1} on page ${PAGE}.${e2}`, cD.generation !== genIndep && cD.executors[1].value.empty === true && rD.result.outcomes[0].accepted && laD?.down === false && new RegExp(`/${PAGE}\\.${e2}\\.key\\|${S1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(laD.target ?? ""), { generation: [genIndep, cD.generation], target: targetSummary(cD.executors[1]), lastApplied: laD });
      gen = cD.generation;
      const rD2 = await submit([ev.down(e2, { generation: gen, target: { executor: e2, element: "key", page: PAGE } })], "down on the deleted executor");
      record(`run: a new down on ${e2} is target-unavailable (empty)`, rD2.result.outcomes[0].refused === "target-unavailable" && /is empty/.test(rD2.result.outcomes[0].message ?? ""), outcomesOf(rD2));

      // 6. Reassignment while held: same rule, the release names the OLD object.
      const rR = await submit([ev.down(e3, { generation: gen, target: { executor: e3, element: "key", page: PAGE } })], "down e3");
      await cmd(`Assign ${S1} At Page ${PAGE}.${e3}`);
      await sleep(600);
      const cR = await context({ executors: [e0, e2, e3], executorPage: PAGE, cached: true });
      const rR2 = await submit([ev.up(e3)], "up e3 after reassignment");
      await settle();
      const laR = await lastApplied();
      record(`run: reassigning ${e3} (${S2} -> ${S1}) while held moves the generation; the release names ${S2}, the object that was pressed`, rR.result.outcomes[0].accepted && cR.generation !== gen && cR.executors[2].value.assigned?.addr === S1 && laR?.down === false && new RegExp(`\\.${e3}\\.key\\|${S2.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(laR.target ?? ""), { generation: [gen, cR.generation], target: targetSummary(cR.executors[2]), lastApplied: laR });
      gen = cR.generation;

      // 7. A missing page is refused and never created.
      if (missing) {
        const rM = await submit([ev.down(e0, { generation: gen, target: { executor: e0, element: "key", page: missing }, control: "PFAmissing" })], "down on a missing page");
        const cM = await context({ executors: [e0], executorPage: missing });
        const pagesAfter = await lua(LUA_PAGES(32));
        record(`run: page ${missing} does not exist: the target is pageMissing, a down on it is target-unavailable (not in the binding), and the page still does not exist afterwards`, cM.executors[0].value.pageMissing === true && rM.result.outcomes[0].refused === "target-unavailable" && pagesAfter?.[0]?.[missing - 1] === 0, { target: targetSummary(cM.executors[0]), outcome: outcomesOf(rM), pages: pagesAfter?.[0] });
      } else note("run: every page 1..32 exists on this show; the missing-page refusal is harness evidence");

      // 8. Two surfaces on one executor: the second is a conflict while the first holds.
      await B.connect();
      const rA = await submit([ev.down(e0, { generation: gen, target: { executor: e0, element: "key", page: PAGE } })], "A holds e0");
      const rB = await B.request("control.submit", { events: [{ type: "button", device: "probe-mplay", control: "PFD1", seq: 1, generation: gen, binding: brev, target: { executor: e0, element: "key", page: PAGE }, down: true }] });
      record(`run: a second session pressing page ${PAGE}.${e0} while the first holds it is refused conflict naming the owner`, rA.result.outcomes[0].accepted && rB.ok && rB.result.outcomes[0].refused === "conflict" && rB.result.outcomes[0].owner === st.yourSession, { a: outcomesOf(rA), b: outcomesOf(rB) });
      await submit([ev.up(e0)], "A releases"); await settle();
      const rB2 = await B.request("control.submit", { events: [{ type: "button", device: "probe-mplay", control: "PFD1", seq: 2, generation: gen, binding: brev, target: { executor: e0, element: "key", page: PAGE }, down: true }] });
      record("run: after the release the second surface's down is admitted", rB2.ok && rB2.result.outcomes[0].accepted, outcomesOf(rB2));
      await B.request("control.submit", { events: [{ type: "button", device: "probe-mplay", control: "PFD1", seq: 3, target: { executor: e0, element: "key", page: PAGE }, down: false }] });
      await settle();
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
    const fin = await A.request("feedback.context", { executors: FREE });
    record(`run: executors ${FREE.join(",")} are empty again and the console is back on page ${PAGE}`, fin.ok && fin.result.executorPage?.no === PAGE && fin.result.executors.every((x) => x.available && x.value.empty === true), fin.ok ? { page: fin.result.executorPage, targets: fin.result.executors.map(targetSummary) } : fin);
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

if (process.argv[1] && /kb21-probe\.mjs$/.test(process.argv[1])) main().catch((e) => { console.error(e); process.exit(2); });
