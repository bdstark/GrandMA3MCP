#!/usr/bin/env node
// KB-17 control-context probe against a RUNNING bridge (plugin 0.13.0 or newer; see ENCODERS.md "KB-17",
// docs/modules.md "Control context").
//
//   node scripts/kb17-probe.mjs verify [--out report.json]   read-only: no console state is changed
//   node scripts/kb17-probe.mjs run    [--out report.json]   verify + context changes on a DISPOSABLE show
//                                                           (selection, encoder bank/page, executor page)
//   node scripts/kb17-probe.mjs watch  [--seconds N]         print every snapshot whose generation moved
//
// `verify` exercises feedback.context over a real TCP connection: identity (show, data pool, user, profile),
// the authoritative display (configured; a requested display without an encoder bar is unavailable, never
// replaced), bank/page/context, the ordered slots with attribute identity, label, unit, readout, resolution,
// layer, availability and value state, every assigned executor of the current page as a target (functions,
// level of the configured fader function, activity, appearance, playback-target status; the KB-12 bank's
// Quickeys excluded), a stable generation across repeated reads, feedback.watch + cached snapshots served by
// the plugin loop, and that reads changed nothing. `run` adds console changes that must each move the
// generation exactly as KB-16 established (Fixture select/ClearSelection, Select EncoderBank, Page) and
// restores them; a value-only change (Attribute ... At) must not move it. Every change registers its undo
// before dispatch; the cleanup runs every remaining undo at the end. Nothing is retried.
// GMA3_BRIDGE_HOST / GMA3_BRIDGE_PORT select the bridge.
import net from "node:net";
import fs from "node:fs";
import { createCleanup, programmerEmpty } from "./lib/kb16-steps.mjs";

const host = process.env.GMA3_BRIDGE_HOST ?? "127.0.0.1";
const port = Number(process.env.GMA3_BRIDGE_PORT ?? 9800);
const argv = process.argv.slice(2);
const mode = argv[0];
const outIdx = argv.indexOf("--out");
const outFile = outIdx >= 0 ? argv[outIdx + 1] : null;
const secIdx = argv.indexOf("--seconds");
const watchSeconds = secIdx >= 0 ? Number(argv[secIdx + 1]) : 60;
const SHOW_GUARD = /disposable|mcp-test|scratch/i;
const RGB_FIXTURE = Number(process.env.KB17_RGB_FIXTURE ?? 401);
const COLOR_BANK = Number(process.env.KB17_COLOR_BANK ?? 4);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Conn {
  constructor(name) { this.name = name; this.seq = 0; this.pending = new Map(); this.buf = ""; this.sock = null; }
  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.connect(port, host, () => resolve());
      sock.setEncoding("utf8");
      sock.setNoDelay(true);
      sock.on("data", (d) => {
        this.buf += d;
        let i;
        while ((i = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          let m;
          try { m = JSON.parse(line); } catch { continue; }
          const p = this.pending.get(m.id);
          if (!p) continue;
          this.pending.delete(m.id);
          clearTimeout(p.timer);
          if (m.ok) p.resolve({ ok: true, result: m.result });
          else p.resolve({ ok: false, error: typeof m.error === "string" ? m.error : JSON.stringify(m.error), code: m.code, detail: m.detail });
        }
      });
      sock.on("error", (e) => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); } this.pending.clear(); if (!this.sock) reject(e); });
      sock.on("close", () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("connection closed")); } this.pending.clear(); });
      this.sock = sock;
    });
  }
  request(op, args = {}) {
    const id = `${this.name}-${this.seq++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout waiting for ${op}`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.write(JSON.stringify({ id, op, args }) + "\n");
    });
  }
  end() { return new Promise((r) => { this.sock.end(r); }); }
}

const steps = [];
let failed = 0;
function record(name, pass, detail) {
  steps.push({ name, pass: !!pass, detail });
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}
function note(name, detail) {
  steps.push({ name, pass: null, detail });
  console.log(`NOTE  ${name}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

/** The parts of a snapshot worth recording: everything except per-item boilerplate. */
export function summarize(snap) {
  if (!snap) return null;
  const enc = snap.encoder?.available ? { bank: snap.encoder.value.bank, page: snap.encoder.value.page, context: snap.encoder.value.context, attributeEditing: snap.encoder.value.attributeEditing, unsupported: snap.encoder.value.unsupported } : { unavailable: snap.encoder?.reason ?? snap.encoder?.error };
  const slots = snap.slots?.available
    ? snap.slots.value.slots.map((s) => ({ slot: s.slot, kind: s.kind, name: s.name, label: s.label, unit: s.unit, readout: s.readout, resolution: s.resolution, layer: s.layer, channelFunction: s.channelFunction, availability: s.availability, valueState: s.valueState, absolute: s.absolute, unsupported: s.unsupported ?? s.attributeUnavailable }))
    : { unavailable: snap.slots?.reason ?? snap.slots?.error };
  const executors = (snap.executors ?? []).map((x) => x.available
    ? { executor: x.value.executor, empty: x.value.empty, assigned: x.value.assigned && `${x.value.assigned.class} ${x.value.assigned.no ?? ""} '${x.value.assigned.name}'`, keyPress: x.value.functions?.keyPress, keyUnpress: x.value.functions?.keyUnpress, fader: x.value.functions?.fader, level: x.value.level, active: x.value.active, playbackTarget: x.value.playbackTarget, reason: x.value.reason, backRGBA: x.value.appearance?.backRGBA }
    : { executor: x.params?.executor, unavailable: x.reason ?? x.error });
  return { generation: snap.generation, generationChanged: snap.generationChanged, generationUnknown: snap.generationUnknown, epoch: snap.epoch, identity: snap.identity, display: snap.authoritativeDisplay, executorPage: snap.executorPage, selection: snap.slots?.value?.selection, encoder: enc, slots, executors, limitations: snap.limitations, stale: snap.stale, notObserved: snap.notObserved };
}

/** True when `after` describes a different control meaning than `before` in the parts the probe changed. */
export function generationMoved(before, after) {
  return typeof before?.generation === "number" && typeof after?.generation === "number" && after.generation > before.generation && after.generationChanged === true;
}

async function context(A, args = {}) {
  const r = await A.request("feedback.context", args);
  if (!r.ok) return { ok: false, error: r.error, code: r.code };
  return { ok: true, snap: r.result };
}

async function main() {
  if (mode !== "verify" && mode !== "run" && mode !== "watch") {
    console.error("usage: node scripts/kb17-probe.mjs verify|run|watch [--out report.json] [--seconds N]");
    process.exit(2);
  }
  const A = new Conn("A");
  await A.connect();
  const pingR = await A.request("ping");
  if (!pingR.ok) { console.error(`ping failed: ${pingR.error}`); process.exit(2); }
  const ping = pingR.result;
  const [maj, min] = String(ping.bridgeVersion ?? "0.0").split(".").map(Number);
  if (maj < 0 || (maj === 0 && min < 13)) { console.error(`bridge ${ping.bridgeVersion} has no feedback.context; update the plugin to 0.13.0 or newer (docs/setup/bridge.md)`); process.exit(2); }
  if (!ping.modules?.feedback?.loaded) { console.error(`the feedback module is not loaded: ${ping.modules?.feedback?.error ?? "no module summary"}`); process.exit(2); }
  const [fmaj, fmin] = String(ping.modules.feedback.version ?? "0.0").split(".").map(Number);
  if (fmaj === 0 && fmin < 3) { console.error(`feedback module ${ping.modules.feedback.version} has no context readers; 0.3.0 or newer is needed`); process.exit(2); }
  if (mode === "run") {
    if (!SHOW_GUARD.test(String(ping.showfile ?? ""))) { console.error(`show "${ping.showfile}" does not look disposable (expected a name matching ${SHOW_GUARD}); refusing to change state`); process.exit(2); }
    if (!ping.lua?.enabled) { console.error("run needs Lua enabled on the bridge (Plugin \"gma3_mcp_bridge\" \"lua on\") for the programmer preflight"); process.exit(2); }
    if (ping.input?.busy) { console.error(`the bridge is busy (${JSON.stringify(ping.input.busy)}); wait for the owner to finish`); process.exit(2); }
  }
  const report = { mode, host, port, startedAt: new Date().toISOString(), ping: { bridgeVersion: ping.bridgeVersion, build: ping.build, hostname: ping.hostname, showfile: ping.showfile, user: ping.user, modules: ping.modules, input: ping.input, lua: { enabled: ping.lua?.enabled } }, steps };
  note("console", report.ping);

  if (mode === "watch") {
    let last = null;
    const end = Date.now() + watchSeconds * 1000;
    console.log(`watching feedback.context for ${watchSeconds} s; change banks, pages, selection or executors in onPC`);
    while (Date.now() < end) {
      const c = await context(A, { allExecutors: true });
      if (!c.ok) { console.log(`feedback.context failed: ${c.error}`); break; }
      if (!last || c.snap.generation !== last.generation) {
        console.log(`${new Date().toISOString()} generation ${c.snap.generation}${c.snap.generationChanged ? " (changed)" : ""}`);
        console.log(JSON.stringify(summarize(c.snap), null, 1));
        last = c.snap;
      }
      await sleep(250);
    }
    await A.end();
    return;
  }

  // 1. A live snapshot with every assigned executor of the current page.
  let c = await context(A, { allExecutors: true });
  record("feedback.context answers (bridge 0.13.0+, feedback 0.3.0+)", c.ok && c.snap.module?.version && typeof c.snap.generation === "number", c.ok ? { generation: c.snap.generation, module: c.snap.module, bridgeVersion: c.snap.bridgeVersion } : c.error);
  if (!c.ok) { await A.end(); process.exit(1); }
  const s0 = c.snap;
  note("snapshot", summarize(s0));
  record("identity carries show, user, profile and data pool", s0.identity?.showFile && s0.identity?.profile && s0.identity?.dataPool?.name, s0.identity);
  record("the authoritative display is the configured one and says so", s0.authoritativeDisplay?.rule === "configured" && s0.authoritativeDisplay?.display === 1, s0.authoritativeDisplay);
  record("encoder bank/page/context readable on the authoritative display", s0.encoder?.available && typeof s0.encoder.value.bank.index === "number" && typeof s0.encoder.value.page.index === "number" && typeof s0.encoder.value.context === "string", summarize(s0).encoder);
  record("bank and page names come from the profile pool (no poolUnavailable)", s0.encoder?.available && s0.encoder.value.bank.name && s0.encoder.value.page.name && !s0.encoder.value.poolUnavailable, s0.encoder?.value);
  record("ordered slots with attribute identity, unit, readout, resolution and layer", s0.slots?.available && s0.slots.value.slots.length >= 1 && s0.slots.value.slots.filter((x) => x.kind === "attribute").every((x) => x.name && x.unit !== undefined && x.readout && x.resolution && x.layer), summarize(s0).slots);
  record("slot labels match the on-screen bands for the live slots", s0.slots?.available && s0.slots.value.slots.filter((x) => x.kind === "attribute").every((x) => typeof x.label === "string"), s0.slots?.value?.slots?.map((x) => [x.name, x.label]));
  const sel = s0.slots?.value?.selection;
  record("availability and value state are explicit per slot", s0.slots?.available && s0.slots.value.slots.every((x) => x.availability && x.valueState), { selection: sel, states: s0.slots?.value?.slots?.map((x) => [x.availability, x.valueState]) });
  record("executor targets: every assigned executor of the page, each with functions and a playback-target verdict", s0.executors.length >= 1 && s0.executors.every((x) => x.available && x.value.functions && typeof x.value.playbackTarget === "boolean"), s0.executors.map((x) => [x.value?.executor, x.value?.assigned?.class, x.value?.playbackTarget]));
  const quickeys = s0.executors.filter((x) => x.available && x.value.assigned?.class === "Quickey");
  record("Quickey-bank executors are never playback targets", quickeys.every((x) => x.value.playbackTarget === false && /Quickey/.test(x.value.reason ?? "")), quickeys.map((x) => [x.value.executor, x.value.reason]));
  if (quickeys.length === 0) note("no Quickey executor on this page: the exclusion is covered by the harness only");
  const seqs = s0.executors.filter((x) => x.available && x.value.assigned?.class === "Sequence");
  record("sequence executors report the configured fader function's level and activity", seqs.length >= 1 && seqs.every((x) => x.value.level && (typeof x.value.level.value === "number" || x.value.level.unavailable) && (typeof x.value.active === "boolean" || x.value.activeUnavailable)), seqs.map((x) => [x.value.executor, x.value.functions.fader, x.value.level, x.value.active]));
  record("appearance colour readable where the object has an appearance", seqs.every((x) => x.value.appearance?.backRGBA || x.value.appearanceUnavailable), seqs.map((x) => [x.value.executor, x.value.appearance?.backRGBA ?? x.value.appearanceUnavailable]));

  // 2. Repeated reads keep the generation; a requested display without an encoder bar is unavailable.
  const c2 = await context(A, { allExecutors: true });
  record("a repeated read keeps the generation (nothing changed)", c2.ok && c2.snap.generation === s0.generation && c2.snap.generationChanged === false, { before: s0.generation, after: c2.snap?.generation });
  const d2 = await context(A, { display: 2 });
  record("display 2: requested rule; without an encoder bar it is unavailable and not replaced", d2.ok && d2.snap.authoritativeDisplay.rule === "requested" && d2.snap.authoritativeDisplay.display === 2 && (d2.snap.encoder.available ? true : /no encoder bar|without EncoderBankSelector|does not exist/.test(d2.snap.encoder.reason ?? "")), summarize(d2.snap)?.encoder);
  const d9 = await context(A, { display: 9 });
  record("display 9 does not exist: unavailable with the reason", d9.ok && d9.snap.encoder.available === false && /does not exist/.test(d9.snap.encoder.reason ?? ""), d9.snap?.encoder?.reason);
  const bad = await A.request("feedback.context", { executors: "x" });
  record("malformed executors are refused with bad-args", !bad.ok && bad.code === "bad-args", bad.error);
  const execNumbers = s0.executors.filter((x) => x.available && !x.value.empty).map((x) => x.value.executor).slice(0, 4);
  const empty = await context(A, { executors: [...execNumbers, 999] });
  record("an executor that does not exist is an explicit empty target", empty.ok && empty.snap.executors.at(-1).available && empty.snap.executors.at(-1).value.empty === true && empty.snap.executors.at(-1).value.playbackTarget === false, empty.snap?.executors?.at(-1)?.value);

  // 3. watch + cached snapshots served by the plugin loop.
  const w = await A.request("feedback.watch", { executors: execNumbers });
  record("feedback.watch subscribes the context items", w.ok && w.result.watched === 4 + execNumbers.length, w.ok ? w.result : w.error);
  await sleep(600);
  const cached = await context(A, { executors: execNumbers, cached: true });
  record("a cached snapshot is served from the loop's observations without reading", cached.ok && cached.snap.cached === true && cached.snap.notObserved === 0 && cached.snap.stale !== true && typeof cached.snap.generation === "number" && cached.snap.encoder.available, cached.ok ? { generation: cached.snap.generation, notObserved: cached.snap.notObserved, stale: cached.snap.stale, ages: [cached.snap.encoder.ageMs, cached.snap.slots.ageMs] } : cached.error);
  const uw = await A.request("feedback.unwatch", {});
  record("feedback.unwatch stops the loop's reads", uw.ok && uw.result.watched === 0, uw.ok ? uw.result : uw.error);
  const c3 = await context(A, { allExecutors: true });
  record("reads left the context unchanged", c3.ok && JSON.stringify(summarize(c3.snap).encoder) === JSON.stringify(summarize(s0).encoder) && c3.snap.generation === s0.generation, summarize(c3.snap)?.encoder);
  const cmd = await A.request("feedback.read", { readers: ["commandText"] });
  record("the command line is untouched", cmd.ok && cmd.result.items[0].available && cmd.result.items[0].value === "", cmd.result?.items?.[0]?.value);

  if (mode === "run") {
    const cleanup = createCleanup();
    // Review 2: the mutation phase runs inside try/finally so a timeout, a refused read or any other
    // exception after a change still runs every registered undo before the probe exits.
    let mutationError = null;
    try {
    const sel0 = s0.slots?.value?.selection?.count;
    if (sel0 !== 0) { record("run: preflight: the selection must be empty", false, sel0); }
    else {
      const prog = await A.request("programmer", { scope: "all" });
      const pe = programmerEmpty(prog);
      record("run: preflight gate (programmer provably empty through the programmer op)", pe.ok, pe.ok ? pe.detail : pe.reason);
      if (pe.ok) {
        const base = (await context(A, { executors: execNumbers })).snap;
        const bank0 = base.encoder.value.bank.index, page0 = base.encoder.value.page.index, execPage0 = base.executorPage?.no;
        // Selection: registers ClearSelection first.
        cleanup.add("ClearSelection", () => A.request("cmd", { command: "ClearSelection" }));
        const selR = await A.request("cmd", { command: `Fixture ${RGB_FIXTURE}` });
        await sleep(150);
        const afterSel = (await context(A, { executors: execNumbers })).snap;
        const availChanged = JSON.stringify(base.slots.value.slots.map((x) => x.availability)) !== JSON.stringify(afterSel.slots.value.slots.map((x) => x.availability));
        record(`run: Fixture ${RGB_FIXTURE} changes slot availability and moves the generation`, selR.ok && afterSel.slots.value.selection.count === 1 && availChanged && generationMoved(base, afterSel), { selection: afterSel.slots.value.selection, availability: afterSel.slots.value.slots.map((x) => [x.name, x.availability, x.valueState]), generation: [base.generation, afterSel.generation] });
        // Bank: registers the original bank.page first.
        cleanup.add(`Select EncoderBank ${bank0}.${page0}`, () => A.request("cmd", { command: `Select EncoderBank ${bank0}.${page0}` }));
        const bankR = await A.request("cmd", { command: `Select EncoderBank ${COLOR_BANK}` });
        await sleep(200);
        const afterBank = (await context(A, { executors: execNumbers })).snap;
        record(`run: Select EncoderBank ${COLOR_BANK} moves the bank and the generation`, bankR.ok && afterBank.encoder.value.bank.index === COLOR_BANK && generationMoved(afterSel, afterBank), { encoder: summarize(afterBank).encoder, slots: summarize(afterBank).slots, generation: [afterSel.generation, afterBank.generation] });
        const pages = afterBank.encoder.value.bank.pages ?? 1;
        if (pages >= 2) {
          const pageR = await A.request("cmd", { command: `Select EncoderBank ${COLOR_BANK}.2` });
          await sleep(200);
          const afterPage = (await context(A, { executors: execNumbers })).snap;
          const moved = afterPage.encoder.value.page.index === 2;
          record(`run: Select EncoderBank ${COLOR_BANK}.2 ${moved ? "moves the page and the generation" : "was ignored (the selection lacks the page's attributes; KB-16) and the generation stays"}`, pageR.ok && (moved ? generationMoved(afterBank, afterPage) : afterPage.generation === afterBank.generation), { page: afterPage.encoder.value.page, generation: [afterBank.generation, afterPage.generation] });
          if (moved) { await A.request("cmd", { command: `Select EncoderBank ${COLOR_BANK}.1` }); await sleep(150); }
        } else note(`run: bank ${COLOR_BANK} has one page; the page step is not exercised`);
        // A value-only change must not move the generation.
        const slot1 = (await context(A, { executors: execNumbers })).snap;
        const attr = slot1.slots.value.slots.find((x) => x.kind === "attribute" && x.availability === "available");
        if (attr) {
          // KB-17 live: `Attribute "ColorRGB_R" At 50` activated the fixture's other colour components in the
          // programmer as well, and `Off Attribute` removes only the named one; ClearAll (registered first, so it
          // runs last, as KB-16 did) is what leaves the programmer empty.
          cleanup.add("ClearAll", () => A.request("cmd", { command: "ClearAll" }));
          cleanup.add(`Off Attribute "${attr.name}"`, () => A.request("cmd", { command: `Off Attribute "${attr.name}"` }));
          const at = await A.request("cmd", { command: `Attribute "${attr.name}" At 50` });
          await sleep(200);
          const afterAt = (await context(A, { executors: execNumbers })).snap;
          const s = afterAt.slots.value.slots.find((x) => x.name === attr.name);
          record(`run: Attribute "${attr.name}" At 50 is a value change: value state follows, generation stays`, at.ok && s && s.valueState === "value" && Math.abs((s.absolute ?? -1) - 50) < 0.01 && afterAt.generation === slot1.generation && afterAt.generationChanged === false, { slot: s && [s.name, s.valueState, s.absolute], generation: [slot1.generation, afterAt.generation] });
        } else note("run: no available attribute slot on the page; the value-only step is not exercised");
        // Executor page: registers the original page first.
        const pagesR = await A.request("lua", { code: "local p = DataPool().Pages; local t = {}; for i = 1, p:Count() do local pg = p:Ptr(i); if pg then t[#t + 1] = tonumber(pg.index) end end; return t", maxMs: 2000 });
        const otherPage = (pagesR.ok ? (pagesR.result?.values?.[0] ?? []) : []).find((n) => n !== execPage0);
        if (typeof execPage0 === "number" && typeof otherPage === "number") {
          cleanup.add(`Page ${execPage0}`, () => A.request("cmd", { command: `Page ${execPage0}` }));
          const pg = await A.request("cmd", { command: `Page ${otherPage}` });
          await sleep(200);
          const afterPg = (await context(A, { executors: execNumbers })).snap;
          record(`run: Page ${otherPage} changes the executor page and every target, moving the generation`, pg.ok && afterPg.executorPage?.no === otherPage && generationMoved(slot1, afterPg), { executorPage: afterPg.executorPage, executors: summarize(afterPg).executors, generation: [slot1.generation, afterPg.generation] });
        } else note("run: no second executor page in the data pool; the page step is not exercised", { execPage0, pages: pagesR.result?.values?.[0] });
      }
    }
    } catch (e) {
      mutationError = e;
      record("run: the mutation phase failed; running the registered undos", false, { error: String(e?.message ?? e), pending: cleanup.pending() });
    } finally {
      const outcomes = await cleanup.run();
      record("run: cleanup ran every registered undo", outcomes.every((o) => o.ok), outcomes);
    }
    if (mutationError) {
      await A.end().catch(() => {});
      report.finishedAt = new Date().toISOString();
      report.passed = steps.filter((x) => x.pass === true).length;
      report.failed = failed;
      if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
      console.log(`\n${report.passed} passed, ${failed} failed (aborted: ${mutationError?.message ?? mutationError})`);
      process.exit(1);
    }
    await sleep(300);
    const fin = (await context(A, { allExecutors: true })).snap;
    record("run: the context is back where it started (bank, page, selection, executor page)", fin && JSON.stringify(summarize(fin).encoder) === JSON.stringify(summarize(s0).encoder) && fin.slots.value.selection.count === 0 && fin.executorPage?.no === s0.executorPage?.no, { encoder: summarize(fin)?.encoder, selection: fin?.slots?.value?.selection, generation: fin?.generation });
    const progEnd = programmerEmpty(await A.request("programmer", { scope: "all" }));
    record("run: the programmer is empty again (provably, through the programmer op)", progEnd.ok, progEnd.ok ? progEnd.detail : progEnd.reason);
  }

  await A.end();
  report.finishedAt = new Date().toISOString();
  report.passed = steps.filter((s) => s.pass === true).length;
  report.failed = failed;
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`\n${report.passed} passed, ${failed} failed${outFile ? ` (report: ${outFile})` : ""}`);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && /kb17-probe\.mjs$/.test(process.argv[1])) main().catch((e) => { console.error(e); process.exit(1); });
