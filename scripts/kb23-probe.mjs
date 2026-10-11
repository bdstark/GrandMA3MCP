#!/usr/bin/env node
// KB-23 parameter-colour / playback-feedback probe against a RUNNING bridge (plugin 0.18.0 or newer with
// gma3_mcp_feedback 0.6.0; see ENCODERS.md "KB-23", docs/modules.md "Parameter colours and playback feedback").
//
//   node scripts/kb23-probe.mjs verify [--out report.json]   read-only: feedback.context only, nothing is selected or changed
//   node scripts/kb23-probe.mjs run    [--out report.json]   verify + on a DISPOSABLE show: Fixture <rgb fixture>, the colour
//                                                           bank and its pages selected (restored), the attribute definitions
//                                                           of the colour components read through Lua
//
// LED translation belongs to the surface service (mtpnxk KEYBOARD.md "KB-23"); what the console half serves and this
// probe records is the VERIFIED metadata a surface lights a control from, never a translated label: per attribute
// slot the feature group / feature names from the definition's own path text, the activation group, the definition's
// Color as numbers (`colorR/G/B/A`, `colorDefined`: a black colour such as Dimmer's defines none) or `colorUnavailable`;
// per executor the assigned object's Appearance BackRGBA as 0..1 components (`appearance.r/g/b/a`, `format`) or
// `appearance.rgbaUnavailable`. `run` records which colour components the show's definitions actually colour (R, G,
// B, RY/Amber, W, UV): that is the evidence the surface's colour scheme rests on. Every change registers its undo
// first; the undos run even when a step fails.
import net from "node:net";
import fs from "node:fs";
import { createCleanup } from "./lib/kb16-steps.mjs";

const host = process.env.GMA3_BRIDGE_HOST ?? "127.0.0.1";
const port = Number(process.env.GMA3_BRIDGE_PORT ?? 9800);
const argv = process.argv.slice(2);
const mode = argv[0];
const outIdx = argv.indexOf("--out");
const outFile = outIdx >= 0 ? argv[outIdx + 1] : null;
const SHOW_GUARD = /disposable|mcp-test|scratch/i;
const RGB_FIXTURE = Number(process.env.KB23_RGB_FIXTURE ?? 401);
const COLOR_BANK = Number(process.env.KB23_COLOR_BANK ?? 4);
const COMPONENTS = (process.env.KB23_COMPONENTS ?? "ColorRGB_R,ColorRGB_G,ColorRGB_B,ColorRGB_RY,ColorRGB_W,ColorRGB_UV,Dimmer,Pan,Gobo1").split(",");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The colour evidence of one attribute slot: identity, the parsed metadata and what is unavailable. */
export function slotColour(s) {
  if (!s || s.kind !== "attribute") return { slot: s?.slot, kind: s?.kind };
  const out = { slot: s.slot, name: s.name, label: s.label, featureGroup: s.featureGroup, featureName: s.featureName, activationGroup: s.activationGroup };
  if (typeof s.colorR === "number") out.rgba = [s.colorR, s.colorG, s.colorB, s.colorA], out.defined = s.colorDefined === true, out.format = s.colorFormat;
  else out.unavailable = s.colorUnavailable ?? s.attributeUnavailable ?? "no colour fields";
  return out;
}

/** Whether a slot carries the KB-23 metadata: feature names from the path (or the definition is unavailable) and a parsed colour or an explicit reason. */
export function slotComplete(s) {
  if (s.kind !== "attribute") return true;
  if (s.attributeUnavailable) return true;
  const names = typeof s.featureGroup === "string" && typeof s.featureName === "string";
  const colour = typeof s.colorR === "number" ? typeof s.colorDefined === "boolean" : typeof s.colorUnavailable === "string";
  return names && colour;
}

/** The appearance evidence of one executor target: the assigned object, the appearance name and its parsed background. */
export function executorAppearance(x) {
  if (!x?.available) return { executor: x?.params?.executor, unavailable: x?.reason ?? x?.error };
  const v = x.value;
  const out = { executor: v.executor, page: v.page?.no, assigned: v.assigned?.name, class: v.assigned?.class, active: v.active, level: v.level?.value };
  if (v.appearance) {
    out.appearance = v.appearance.name;
    if (typeof v.appearance.r === "number") out.rgba = [v.appearance.r, v.appearance.g, v.appearance.b, v.appearance.a], out.format = v.appearance.format;
    else out.rgbaUnavailable = v.appearance.rgbaUnavailable ?? "no components";
    out.backRGBA = v.appearance.backRGBA;
  } else out.appearanceUnavailable = v.appearanceUnavailable;
  return out;
}

/** Whether an assigned executor carries a parsed appearance or says why not. */
export function appearanceComplete(x) {
  if (!x?.available || x.value.empty) return true;
  const v = x.value;
  if (!v.appearance) return typeof v.appearanceUnavailable === "string";
  return typeof v.appearance.r === "number" || typeof v.appearance.rgbaUnavailable === "string";
}

/** Lua: the definition fields of the named attributes (nil entries for attributes the show does not define). */
export const LUA_DEFINITIONS = (names) => `local defs = Root().ShowData.LivePatch.AttributeDefinitions.Attributes; local out = {}; for _, n in ipairs(${JSON.stringify(names).replace(/^\[/, "{").replace(/\]$/, "}")}) do local a = defs[n]; if a then out[n] = { color = tostring(a:Get("Color", Enums.Roles.Display)), feature = tostring(a:Get("Feature", Enums.Roles.Display)), activationGroup = tostring(a:Get("ActivationGroup", Enums.Roles.Display)), special = tostring(a:Get("Special", Enums.Roles.Display)) } else out[n] = false end end; return out`;

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
    console.error("usage: node scripts/kb23-probe.mjs verify|run [--out report.json]");
    process.exit(2);
  }
  const A = new Conn("a");
  await A.connect();
  const pingR = await A.request("ping");
  if (!pingR.ok) { console.error(`ping failed: ${pingR.error}`); process.exit(2); }
  const ping = pingR.result;
  const [maj, min] = String(ping.bridgeVersion ?? "0.0").split(".").map(Number);
  if (maj < 0 || (maj === 0 && min < 13)) { console.error(`bridge ${ping.bridgeVersion} has no feedback.context; update the plugin to 0.13.0 or newer (docs/setup/bridge.md)`); process.exit(2); }
  if (!ping.modules?.feedback?.loaded) { console.error(`the feedback module is not loaded: ${ping.modules?.feedback?.error ?? "no module summary"}`); process.exit(2); }
  const [fmaj, fmin] = String(ping.modules.feedback.version ?? "0.0").split(".").map(Number);
  if (fmaj === 0 && fmin < 6) { console.error(`feedback module ${ping.modules.feedback.version} has no colour metadata; 0.6.0 or newer is needed`); process.exit(2); }
  if (mode === "run") {
    if (!SHOW_GUARD.test(String(ping.showfile ?? ""))) { console.error(`show "${ping.showfile}" does not look disposable (expected a name matching ${SHOW_GUARD}); refusing to change state`); process.exit(2); }
    if (!ping.lua?.enabled) { console.error('run needs Lua enabled on the bridge (Plugin "gma3_mcp_bridge" "lua on") to read the attribute definitions'); process.exit(2); }
    if (ping.input?.busy) { console.error(`the bridge is busy (${JSON.stringify(ping.input.busy)}); wait for the owner to finish`); process.exit(2); }
  }
  const report = { mode, host, port, startedAt: new Date().toISOString(), ping: { bridgeVersion: ping.bridgeVersion, build: ping.build, hostname: ping.hostname, showfile: ping.showfile, user: ping.user, modules: ping.modules, lua: { enabled: ping.lua?.enabled } }, steps };
  note("console", report.ping);
  const context = async (args = {}) => { const r = await A.request("feedback.context", args); return r.ok ? r.result : null; };

  // ---- verify: read-only ----
  const c0 = await context({ allExecutors: true });
  record("feedback.context answers with feedback 0.6.0 or newer", !!c0 && c0.module?.version === ping.modules.feedback.version, c0 ? { module: c0.module, generation: c0.generation } : "no context");
  const slots = c0?.slots?.available ? c0.slots.value.slots : [];
  const attrSlots = slots.filter((s) => s.kind === "attribute");
  record("every attribute slot carries the feature group / feature names from the definition's path and a parsed Color or an explicit reason", !!c0 && attrSlots.every(slotComplete), { slots: slots.map(slotColour), slotsWhy: c0?.slots?.reason ?? c0?.slots?.error });
  note("slot colour evidence (the current encoder page)", { bank: c0?.encoder?.value?.bank, page: c0?.encoder?.value?.page, slots: slots.map(slotColour) });
  const colourSlots = attrSlots.filter((s) => s.featureGroup === "Color");
  if (colourSlots.length) record("a colour-group slot's identity comes from its name and feature group, never from the band label alone", colourSlots.every((s) => typeof s.name === "string" && s.name !== "" && s.featureGroup === "Color"), colourSlots.map(slotColour));
  else note("no colour-group slot on the current page; `run` selects the colour bank");
  const execs = (c0?.executors ?? []).filter((x) => x.available && !x.value.empty);
  record("every assigned executor carries a parsed appearance background (0..1 components) or says why not", !!c0 && execs.every(appearanceComplete), execs.map(executorAppearance));
  const parsed = execs.filter((x) => typeof x.value.appearance?.r === "number");
  record("parsed appearances are 0..1 components (hex BackRGBA live on 2.5.1)", parsed.every((x) => ["r", "g", "b", "a"].every((k) => x.value.appearance[k] >= 0 && x.value.appearance[k] <= 1)), parsed.map(executorAppearance));
  note("executor appearance evidence (the user's page)", { page: c0?.executorPage?.no, executors: execs.map(executorAppearance), formats: [...new Set(parsed.map((x) => x.value.appearance.format))] });
  const c1 = await context({ allExecutors: true });
  record("reading the colour metadata moved nothing (generation unchanged)", !!c1 && c1.generation === c0?.generation, { generation: [c0?.generation, c1?.generation] });

  // ---- run: the colour bank's pages on a disposable show ----
  if (mode === "run") {
    const cleanup = createCleanup();
    let mutationError = null;
    try {
      const sel0 = c0?.slots?.value?.selection?.count;
      if (sel0 !== 0) record("run: preflight: the selection must be empty", false, sel0);
      else {
        const bank0 = c0.encoder.value.bank.index, page0 = c0.encoder.value.page.index;
        cleanup.add("ClearSelection", () => A.request("cmd", { command: "ClearSelection" }));
        const selR = await A.request("cmd", { command: `Fixture ${RGB_FIXTURE}` });
        await sleep(150);
        cleanup.add(`Select EncoderBank ${bank0}.${page0}`, () => A.request("cmd", { command: `Select EncoderBank ${bank0}.${page0}` }));
        const evidence = {};
        for (const page of [1, 2, 3]) {
          const r = await A.request("cmd", { command: `Select EncoderBank ${COLOR_BANK}.${page}` });
          await sleep(250);
          const c = await context({});
          const e = c?.encoder?.value;
          if (!c || !e || e.bank.index !== COLOR_BANK || e.page.index !== page) { if (page === 1) record(`run: Select EncoderBank ${COLOR_BANK}.1 selects the colour bank`, false, { ok: r.ok, encoder: e }); else note(`run: colour bank page ${page} not selectable (the selection lacks its attributes, or no such page)`, { encoder: e }); continue; }
          const ss = c.slots?.available ? c.slots.value.slots : [];
          evidence[`page${page}`] = { name: e.page.name, slots: ss.map(slotColour) };
          record(`run: colour bank page ${page} ('${e.page.name}'): every attribute slot is in feature group Color with parsed metadata`, selR.ok && ss.filter((s) => s.kind === "attribute").length > 0 && ss.filter((s) => s.kind === "attribute").every((s) => s.featureGroup === "Color" && slotComplete(s)), ss.map(slotColour));
        }
        const defined = Object.values(evidence).flatMap((p) => p.slots).filter((s) => s.defined);
        const undefinedOnes = Object.values(evidence).flatMap((p) => p.slots).filter((s) => s.rgba && !s.defined);
        note("run: which colour components the show's definitions colour (defined) and which are black (undefined: the surface falls back to its scheme)", { defined: defined.map((s) => [s.name, s.label, s.rgba]), black: undefinedOnes.map((s) => [s.name, s.label]) });
        const defs = await A.request("lua", { code: LUA_DEFINITIONS(COMPONENTS), maxMs: 2000 });
        record("run: the attribute definitions of the colour components (and Dimmer/Pan/Gobo1 for the category scheme) read through Lua", defs.ok && defs.result?.values?.[0] && typeof defs.result.values[0] === "object", defs.ok ? defs.result.values?.[0] : defs.error);
        note("run: attribute definitions (Color, Feature, ActivationGroup, Special) as the console prints them", defs.ok ? defs.result.values?.[0] : defs.error);
      }
    } catch (e) { mutationError = e; }
    const undo = await cleanup.run();
    record("run: every registered undo ran", undo.every((u) => u.ok), undo);
    if (mutationError) record("run: the mutation phase completed without an exception", false, String(mutationError?.stack ?? mutationError));
    const cEnd = await context({ allExecutors: true });
    record("run: the selection is empty and the encoder bank is back", !!cEnd && cEnd.slots?.value?.selection?.count === 0 && cEnd.encoder?.value?.bank.index === c0.encoder.value.bank.index && cEnd.encoder?.value?.page.index === c0.encoder.value.page.index, { selection: cEnd?.slots?.value?.selection, encoder: cEnd?.encoder?.value });
  }

  await A.end();
  report.finishedAt = new Date().toISOString();
  report.failed = failed;
  report.passed = steps.filter((s) => s.pass === true).length;
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + "\n");
  console.log(`${report.passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && /kb23-probe\.mjs$/.test(process.argv[1])) main().catch((e) => { console.error(e); process.exit(2); });
