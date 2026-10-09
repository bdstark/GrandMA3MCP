#!/usr/bin/env node
// KB-06 feedback probe against a RUNNING bridge (plugin 0.8.0 or newer; see KEYBOARD.md "KB-06",
// docs/tools/feedback.md).
//
//   node scripts/kb06-probe.mjs verify [--out report.json]   read-only: no console state is changed
//   node scripts/kb06-probe.mjs run    [--out report.json]   verify + state changes on a DISPOSABLE show
//                                                           (Blind on/off, one fader move, one Go+/Off)
//
// `verify` exercises the contract of feedback.describe / feedback.read over real TCP connections: every
// parameterless reader, several displays (a missing one is unavailable, not false), executor assignment
// and fader level per executor, sequence activity, the per-request executor bound, the per-item
// observedAt/epoch fields, that a read changes neither the command line nor the selection, and, when
// input is enabled, that feedback.read answers from a second connection while the first one owns an
// interaction (where cmd and lua are [busy]). `run` additionally checks that the observations follow
// real changes (Blind, a fader, playback) and restores what it changed. Nothing is retried.
// GMA3_BRIDGE_HOST / GMA3_BRIDGE_PORT select the bridge.
import net from "node:net";
import fs from "node:fs";

const host = process.env.GMA3_BRIDGE_HOST ?? "127.0.0.1";
const port = Number(process.env.GMA3_BRIDGE_PORT ?? 9800);
const argv = process.argv.slice(2);
const mode = argv[0];
const outIdx = argv.indexOf("--out");
const outFile = outIdx >= 0 ? argv[outIdx + 1] : null;
const SHOW_GUARD = /disposable|mcp-test|scratch/i;

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
const byKey = (res) => Object.fromEntries((res.result?.items ?? []).map((it) => [it.key, it]));
const brief = (it) => it && { available: it.available, value: it.value, reason: it.reason, error: it.error, epoch: it.epoch };

async function main() {
  if (mode !== "verify" && mode !== "run") {
    console.error("usage: node scripts/kb06-probe.mjs verify|run [--out report.json]");
    process.exit(2);
  }
  const A = new Conn("A");
  await A.connect();
  const pingR = await A.request("ping");
  if (!pingR.ok) { console.error(`ping failed: ${pingR.error}`); process.exit(2); }
  const ping = pingR.result;
  const [maj, min] = String(ping.bridgeVersion ?? "0.0").split(".").map(Number);
  if (maj < 0 || (maj === 0 && min < 8)) { console.error(`bridge ${ping.bridgeVersion} has no feedback ops; update the plugin to 0.8.0 or newer (docs/setup/bridge.md)`); process.exit(2); }
  if (!ping.modules?.feedback?.loaded) { console.error(`the feedback module is not loaded: ${ping.modules?.feedback?.error ?? "no module summary"}`); process.exit(2); }
  if (mode === "run") {
    if (!SHOW_GUARD.test(String(ping.showfile ?? ""))) { console.error(`show "${ping.showfile}" does not look disposable (expected a name matching ${SHOW_GUARD}); refusing to change state`); process.exit(2); }
    if (!ping.lua?.enabled) { console.error("run needs Lua enabled on the bridge (Plugin \"gma3_mcp_bridge\" \"lua on\") to restore state"); process.exit(2); }
    if (ping.input?.busy) { console.error(`the bridge is busy (${JSON.stringify(ping.input.busy)}); wait for the owner to finish`); process.exit(2); }
  }
  const report = { mode, host, port, startedAt: new Date().toISOString(), ping: { bridgeVersion: ping.bridgeVersion, build: ping.build, hostname: ping.hostname, showfile: ping.showfile, user: ping.user, modules: ping.modules, input: ping.input, lua: { enabled: ping.lua?.enabled } }, steps };
  note("console", report.ping);

  // 1. describe
  let r = await A.request("feedback.describe");
  record("feedback.describe answers (module 0.2.0+)", r.ok && r.result.version && Array.isArray(r.result.readers) && r.result.readers.length >= 15, r.ok ? { version: r.result.version, readers: r.result.readers.map((x) => x.name) } : r.error);

  // 2. every parameterless reader, three displays (9 should not exist), with timing
  let t0 = Date.now();
  r = await A.request("feedback.read", { all: true, displays: [1, 2, 9] });
  const dt = Date.now() - t0;
  record("feedback.read all + displays answers", r.ok && r.result.atomic === false && typeof r.result.epoch === "number", r.ok ? { count: r.result.count, ms: dt, epoch: r.result.epoch, identity: r.result.identity, limitations: r.result.limitations } : r.error);
  let items = byKey(r);
  const allItems = r.result?.items ?? [];
  record("every item carries observedAt, epoch, scope and available", allItems.length > 0 && allItems.every((it) => typeof it.observedAt === "number" && typeof it.epoch === "number" && typeof it.available === "boolean" && (it.scope || it.available === false)), allItems.filter((it) => !(typeof it.observedAt === "number" && typeof it.epoch === "number")).map((it) => it.key));
  record("unavailable items carry a reason or error and no value", allItems.filter((it) => !it.available).every((it) => (it.reason || it.error) && it.value === undefined), allItems.filter((it) => !it.available).map((it) => [it.key, it.reason ?? it.error]));
  for (const k of ["blind", "highlight", "solo", "shortcutsActive", "maState"]) record(`${k} is a readable boolean`, items[k]?.available && typeof items[k].value === "boolean", brief(items[k]));
  record("commandText and lastCommand are strings (raw, no keywords inferred)", items.commandText?.available && typeof items.commandText.value === "string" && items.lastCommand?.available && typeof items.lastCommand.value === "string", { commandText: items.commandText?.value, lastCommand: items.lastCommand?.value });
  record("previewMode is a string", items.previewMode?.available && typeof items.previewMode.value === "string", brief(items.previewMode));
  record("page has name and number", items.page?.available && items.page.value?.name && typeof items.page.value.no === "number", brief(items.page));
  record("selectedSequence is an observation (selected flag)", items.selectedSequence?.available && typeof items.selectedSequence.value?.selected === "boolean", brief(items.selectedSequence));
  record("freeze is unavailable with a reason, never false", items.freeze && items.freeze.available === false && /KB-01/.test(items.freeze.reason ?? ""), brief(items.freeze));
  record("previewBar on display 1 is a boolean identified by display", items["previewBar[display=1]"]?.available && typeof items["previewBar[display=1]"].value === "boolean" && items["previewBar[display=1]"].params?.display === 1, brief(items["previewBar[display=1]"]));
  note("previewBar on display 2", brief(items["previewBar[display=2]"]));
  record("previewBar on display 9 is unavailable (not false) because the display does not exist", items["previewBar[display=9]"] && items["previewBar[display=9]"].available === false && /does not exist/.test(items["previewBar[display=9]"].reason ?? ""), brief(items["previewBar[display=9]"]));
  const beforeCmd = items.commandText?.value;

  // 3. executors: assignment and fader per executor, sequence activity per sequence
  r = await A.request("executors", { from: 101, to: 315, onlyAssigned: true });
  const assigned = r.ok ? r.result.executors.slice(0, 6) : [];
  const execNumbers = assigned.map((e) => e.number);
  const seqNumbers = [...new Set(assigned.map((e) => e.assigned?.name).filter(Boolean))];
  note("assigned executors on the current page (first 6)", assigned.map((e) => `${e.number}: ${e.assigned?.class} ${e.assigned?.name}`));
  const probeExecs = execNumbers.length ? [...execNumbers, 190] : [101, 190];
  r = await A.request("feedback.read", { executors: probeExecs, sequences: [1, 999999] });
  items = byKey(r);
  record("feedback.read executors/sequences answers", r.ok, r.ok ? { count: r.result.count, limitations: r.result.limitations } : r.error);
  for (const n of execNumbers) {
    const ex = items[`executor[executor=${n}]`], fd = items[`fader[executor=${n}]`];
    record(`executor ${n}: assignment read (not level, not activity)`, ex?.available && ex.value?.empty === false && ex.value.assigned?.name, brief(ex));
    record(`executor ${n}: fader level is a number with text`, fd?.available && typeof fd.value?.value === "number", brief(fd));
  }
  record("executor 190 (unassigned here) reports empty, fader unavailable with a reason", items["executor[executor=190]"]?.available && items["executor[executor=190]"].value?.empty === true && items["fader[executor=190]"]?.available === false, { exec: brief(items["executor[executor=190]"]), fader: brief(items["fader[executor=190]"]) });
  record("sequence 1 activity is a boolean (playback activity, not a button)", items["sequenceActive[sequence=1]"]?.available && typeof items["sequenceActive[sequence=1]"].value === "boolean", brief(items["sequenceActive[sequence=1]"]));
  record("sequence 999999 is unavailable with a reason", items["sequenceActive[sequence=999999]"]?.available === false && /not found/.test(items["sequenceActive[sequence=999999]"].reason ?? ""), brief(items["sequenceActive[sequence=999999]"]));
  const many = Array.from({ length: 40 }, (_, i) => 101 + i);
  t0 = Date.now();
  r = await A.request("feedback.read", { executors: many });
  record("40 executors are bounded to 32 per request and reported", r.ok && r.result.count === 64 && /truncated to 32 of 40/.test(r.result.limitations?.[0] ?? ""), r.ok ? { count: r.result.count, ms: Date.now() - t0, limitations: r.result.limitations } : r.error);
  r = await A.request("feedback.read", { readers: ["sequenceActive"] });
  record("a parameterised reader named without parameters is refused as nothing to read", !r.ok && r.code === "no-items", r.ok ? r.result : r.error);
  r = await A.request("feedback.read", { items: [{ name: "executorActive", params: { sequence: 1 } }] });
  record("executorActive alias answers with alias=sequenceActive and a deprecation note", r.ok && r.result.items[0].alias === "sequenceActive" && /deprecated/.test(r.result.items[0].note ?? ""), r.ok ? brief(r.result.items[0]) : r.error);

  // 4. reads change nothing observable: command line and selection identical before and after
  r = await A.request("feedback.read", { readers: ["commandText", "selectedSequence", "page"] });
  items = byKey(r);
  record("reads did not change the command line", items.commandText?.value === beforeCmd, { before: beforeCmd, after: items.commandText?.value });
  r = await A.request("ping");
  record("reads opened no input session and left nothing busy", r.ok && r.result.input.sessions === 0 && !r.result.input.busy, r.result?.input);

  // 5. while another connection owns an interaction (input enabled only): reads answer, cmd/lua are [busy]
  if (ping.input?.enabled) {
    const B = new Conn("B");
    await B.connect();
    r = await B.request("input.begin", { leaseMs: 10000, label: "kb06-probe" });
    if (r.ok) {
      const ia = r.result.interaction?.id ?? r.result.interaction;
      const c = await A.request("cmd", { command: "Blind" });
      const l = await A.request("lua", { code: "return 1" });
      const f = await A.request("feedback.read", { readers: ["commandText", "maState", "blind"] });
      record("while B owns an interaction: A's cmd and lua are [busy] but A's feedback.read answers", !c.ok && c.code === "busy" && !l.ok && l.code === "busy" && f.ok && f.result.count === 3 && f.result.items.every((it) => it.available), { cmd: c.code, lua: l.code, feedback: f.ok ? f.result.items.map(brief) : f.error });
      r = await B.request("input.end", { interaction: ia });
      record("B ended its interaction (nothing was pressed)", r.ok, r.ok ? r.result : r.error);
    } else {
      note("could not begin an interaction on B; busy-independence not exercised", r.error);
    }
    await B.end();
  } else {
    note("input disabled on this bridge; busy-independence not exercised (covered by the Lua harness)", ping.input);
  }

  // 6. run: observations follow real changes, then restore
  if (mode === "run") {
    const readBlind = async () => byKey(await A.request("feedback.read", { readers: ["blind", "lastCommand"] }));
    const b0 = await readBlind();
    const initial = b0.blind?.value;
    record("run: initial Blind read", typeof initial === "boolean", brief(b0.blind));
    const c1 = await A.request("cmd", { command: initial ? "Blind Off" : "Blind On" });
    await sleep(100);
    const b1 = await readBlind();
    record(`run: Blind ${initial ? "Off" : "On"} observed by the reader`, c1.ok && b1.blind?.value === !initial, { feedback: c1.result?.feedback, after: brief(b1.blind), lastCommand: b1.lastCommand?.value });
    const c2 = await A.request("cmd", { command: initial ? "Blind On" : "Blind Off" });
    await sleep(100);
    const b2 = await readBlind();
    record("run: Blind restored and observed", c2.ok && b2.blind?.value === initial, { after: brief(b2.blind) });
    if (execNumbers.length) {
      const n = execNumbers[0];
      const key = `fader[executor=${n}]`;
      const f0 = byKey(await A.request("feedback.read", { executors: [n] }))[key];
      const level0 = f0?.value?.value;
      const target = typeof level0 === "number" && level0 > 50 ? 25 : 75;
      const s1 = await A.request("setfader", { ref: `Page ${items.page?.value?.no ?? 1}.${n}`, value: target });
      await sleep(150);
      const f1 = byKey(await A.request("feedback.read", { executors: [n] }))[key];
      record(`run: fader of executor ${n} moved to ${target} and observed`, s1.ok && typeof f1?.value?.value === "number" && Math.abs(f1.value.value - target) < 0.5, { before: level0, setfader: s1.ok ? s1.result : s1.error, after: brief(f1) });
      const s2 = await A.request("setfader", { ref: `Page ${items.page?.value?.no ?? 1}.${n}`, value: typeof level0 === "number" ? level0 : 0 });
      await sleep(150);
      const f2 = byKey(await A.request("feedback.read", { executors: [n] }))[key];
      record(`run: fader of executor ${n} restored`, s2.ok && typeof f2?.value?.value === "number" && Math.abs(f2.value.value - (typeof level0 === "number" ? level0 : 0)) < 0.5, { after: brief(f2) });
      const seqName = assigned[0]?.assigned?.name;
      const seqNo = assigned[0]?.assigned?.no ?? assigned[0]?.assigned?.index;
      const seqRef = typeof seqNo === "number" ? seqNo : null;
      if (seqRef !== null && assigned[0]?.assigned?.class === "Sequence") {
        const a0 = byKey(await A.request("feedback.read", { sequences: [seqRef] }))[`sequenceActive[sequence=${seqRef}]`];
        if (a0?.available && a0.value === false) {
          const g = await A.request("cmd", { command: `Go+ Sequence ${seqRef}` });
          await sleep(200);
          const a1 = byKey(await A.request("feedback.read", { sequences: [seqRef] }))[`sequenceActive[sequence=${seqRef}]`];
          record(`run: Go+ Sequence ${seqRef} (${seqName}) observed as sequence activity`, g.ok && a1?.value === true, { go: g.result?.feedback, after: brief(a1) });
          const o = await A.request("cmd", { command: `Off Sequence ${seqRef}` });
          await sleep(200);
          const a2 = byKey(await A.request("feedback.read", { sequences: [seqRef] }))[`sequenceActive[sequence=${seqRef}]`];
          record(`run: Off Sequence ${seqRef} observed`, o.ok && a2?.value === false, { off: o.result?.feedback, after: brief(a2) });
        } else {
          note(`run: sequence ${seqRef} already active or unreadable; playback change not exercised`, brief(a0));
        }
      } else {
        note("run: first assigned executor is not a sequence; playback change not exercised", assigned[0]?.assigned);
      }
    } else {
      note("run: no assigned executor on the current page; fader and playback changes not exercised");
    }
    r = await A.request("feedback.read", { readers: ["commandText"] });
    record("run: command line unchanged at the end", r.ok && r.result.items[0].value === beforeCmd, { before: beforeCmd, after: r.result?.items?.[0]?.value });
  }

  await A.end();
  report.finishedAt = new Date().toISOString();
  report.passed = steps.filter((s) => s.pass === true).length;
  report.failed = failed;
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`\n${report.passed} passed, ${failed} failed${outFile ? ` (report: ${outFile})` : ""}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
