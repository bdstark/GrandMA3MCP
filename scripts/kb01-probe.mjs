#!/usr/bin/env node
// KB-01 keyboard/feedback probe for a disposable onPC show (see KEYBOARD.md, docs/probes/).
//
//   node scripts/kb01-probe.mjs auto [--out file.json]   automated checks (presses keys on the console)
//   node scripts/kb01-probe.mjs longpress                 holds S ~1.3 s; confirm the Store Settings pop-up
//   node scripts/kb01-probe.mjs type                      types "aü" into an already open text dialog
//   node scripts/kb01-probe.mjs hw-a                      hardware test A: hold physical Left Shift
//   node scripts/kb01-probe.mjs hw-b                      hardware test B: tap physical Left Shift
//
// Requires the bridge with Lua enabled (Plugin "gma3_mcp_bridge" "lua on") and a show file whose name
// contains "disposable" (override with --force). GMA3_BRIDGE_HOST / GMA3_BRIDGE_PORT select the bridge.
// The automated run toggles Blind, shortcuts and selection and restores them; it does not store or
// assign anything. Manual checks it cannot observe are printed at the end.
import net from "node:net";
import fs from "node:fs";

const host = process.env.GMA3_BRIDGE_HOST ?? "127.0.0.1";
const port = Number(process.env.GMA3_BRIDGE_PORT ?? 9800);
const argv = process.argv.slice(2);
const mode = argv[0];
const force = argv.includes("--force");
const outIdx = argv.indexOf("--out");
const outFile = outIdx >= 0 ? argv[outIdx + 1] : null;

let seq = 0;
function request(op, args) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host, () => sock.write(JSON.stringify({ id: `kb01-${seq++}`, op, args }) + "\n"));
    let buf = "";
    sock.setEncoding("utf8");
    sock.setTimeout(15000, () => { sock.destroy(); reject(new Error("timeout")); });
    sock.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      const m = JSON.parse(buf.slice(0, i));
      sock.end();
      m.ok ? resolve(m.result) : reject(new Error(typeof m.error === "string" ? m.error : JSON.stringify(m.error)));
    });
    sock.on("error", reject);
  });
}

// Helpers prepended to every chunk. wait(n) yields n main-loop frames.
const PRELUDE = `
local function wait(n) for i=1,n do coroutine.yield() end end
local function tap(k, s, c, a) Keyboard(1,'press',k,s or false,c or false,a or false,false) Keyboard(1,'release',k,s or false,c or false,a or false,false) end
local function cmd() return CmdObj().cmdtext end
local function esc(n) for i=1,(n or 1) do tap('Escape') wait(4) end end
local function until_(f, n) for i=1,(n or 20) do if f() then return true, i end wait(1) end return f(), n or 20 end
`;
async function lua(code) {
  const r = await request("lua", { code: PRELUDE + code, timeout_ms: 5000 });
  return r.values?.[0];
}

const results = [];
async function check(id, description, expect, code) {
  let observed, error;
  try { observed = await lua(code); } catch (e) { error = e.message; }
  const pass = error ? false : expect(observed);
  results.push({ id, description, pass, observed, error });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id.padEnd(5)} ${description}${error ? `  (${error})` : ""}`);
  if (!pass && !error) console.log(`        observed: ${JSON.stringify(observed)}`);
}

async function auto() {
  const ping = await request("ping", {});
  const env = await lua(`
    local d={} for i=1,10 do local ok,x=pcall(GetDisplayByIndex,i) if ok and x then d[#d+1]=tostring(x.name) end end
    local m={} local mc=Root().GraphicsRoot.MonitorCollect for i=1,mc:Count() do local x=mc:Ptr(i) if x then m[#m+1]=tostring(x.name)..' '..tostring(x:Get('Width'))..'x'..tostring(x:Get('Height')) end end
    return {hostOS=HostOS(), hostType=HostType(), version=Version(), user=tostring(CurrentUser().name), profile=tostring(CurrentProfile().name),
      displays=d, monitors=m}`);
  const show = ping.showfile ?? "";
  console.log(`onPC ${env.version} ${env.hostType} on ${env.hostOS}; show "${show}"; user ${env.user}; profile ${env.profile}`);
  console.log(`displays: ${env.displays.join(", ")}; monitors: ${env.monitors.join(", ")}`);
  if (!ping.lua?.enabled) throw new Error('Lua is disabled on the bridge; run Plugin "gma3_mcp_bridge" "lua on"');
  if (!/disposable/i.test(show) && !force) throw new Error(`show "${show}" is not marked disposable; use --force to run anyway`);

  const initial = await lua(`local g=ShowData().Masters.Grand return {blind=g.Blind:Get('FaderEnabled'), shcuts=CurrentProfile().KeyboardShortCuts:Get('KeyboardShortcutsActive'), sel=SelectionCount(), env=CurrentProfile().Environments:Get('ActiveEnvironment'), ma=Root():Get('MAState')}`);
  if (!initial.shcuts) throw new Error("keyboard shortcuts are disabled (ShCuts); enable them before running");
  if (initial.ma) throw new Error("MA (Shift) is currently held; release it before running");
  if (initial.env !== "Normal") throw new Error(`environment is ${initial.env}; leave Preview first`);
  await lua(`esc(2) return true`);

  // API surface and mapping data (read-only)
  await check("A1", "Keyboard() descriptor lists press/char/release", (o) => /press/.test(o) && /char/.test(o) && /release/.test(o), `
    for _,f in ipairs(GetApiDescriptor()) do if f[1]=='Keyboard' then return f[2] end end return nil`);
  await check("A2", "default shortcuts: Enter→PLEASE, Escape→ESC, Delete→CLEAR, Backspace→OOPS, S→STORE, Ctrl+F1→EXEC 101", (o) =>
    o.Enter === "84" && o.Escape === "88" && o.Delete === "87" && o.Backspace === "86" && o.S === "66" && o["Ctrl+F1"] === "35/101", `
    local want={Enter=1,Escape=1,Delete=1,Backspace=1,S=1,['Ctrl+F1']=1} local r={}
    for _,s in ipairs(ObjectList('KeyboardShortcut 1 Thru')) do local k=s:Get('Shortcut') if want[k] and not r[k] then local c=tostring(s:Get('KeyCode')) if k=='Ctrl+F1' then c=c..'/'..tostring(s:Get('ExecutorIndex')) end r[k]=c end end return r`);
  await check("A3", "VirtualKeys: PLEASE redirects Enter, MA1 has no PC key", (o) => o.please === "Enter" && o.ma1 === "None", `
    local r={} local vk=Root().VirtualKeys for i=1,vk:Count() do local k=vk:Ptr(i) local c=tostring(k:Get('Code')) if c=='PLEASE' then r.please=tostring(k:Get('KeyCode')) elseif c=='MA1' then r.ma1=tostring(k:Get('KeyCode')) end end return r`);
  await check("A4", "MAINLOOPCOUNT advances one per yield", (o) => o >= 4 && o <= 6, `
    local p=Root().GraphicsRoot.PultCollect:Ptr(1) local a=p:Get('MainLoopCount') wait(5) return p:Get('MainLoopCount')-a`);

  // Basic keys through shortcuts
  await check("K1", "digit key 5 types into the command line", (o) => o === "5", `tap('5') until_(function() return cmd()=='5' end) return cmd()`);
  await check("K2", "Backspace acts as OOPS (removes 5)", (o) => o === "", `tap('Backspace') until_(function() return cmd()=='' end) return cmd()`);
  await check("K3", "key names are case-sensitive ('backspace' ignored)", (o) => o === "5", `tap('5') wait(2) tap('backspace') wait(10) return cmd()`);
  await check("K4", "Escape clears the command line", (o) => o === "", `esc(1) until_(function() return cmd()=='' end) return cmd()`);
  await check("K5", "S tap gives Store", (o) => o === "Store ", `tap('S') until_(function() return cmd()~='' end) local c=cmd() esc(1) return c`);
  await check("K6", "Ctrl+Z (ctrl flag) acts as OOPS; plain Z does nothing", (o) => o.plain === "55" && o.ctrl === "5", `
    tap('5') tap('5') wait(3) tap('Z') wait(10) local p=cmd() tap('Z',false,true) until_(function() return cmd()=='5' end) local c=cmd() esc(1) return {plain=p, ctrl=c}`);
  await check("K7", "held LeftCtrl is not combined with Z", (o) => o === "55", `
    tap('5') tap('5') wait(3) Keyboard(1,'press','LeftCtrl') tap('Z') wait(10) Keyboard(1,'release','LeftCtrl') local c=cmd() esc(1) return c`);
  await check("K8", "5 + Enter executes (selects one fixture); Delete clears it", (o) => o.after === 1 && o.cleared === 0, `
    tap('5') wait(2) tap('Enter') until_(function() return SelectionCount()>0 end) local a=SelectionCount() tap('Delete') until_(function() return SelectionCount()==0 end) return {after=a, cleared=SelectionCount()}`);
  await check("K9", "overlap: S held + 5 gives Store Cue 5", (o) => o === "Store Cue 5", `
    Keyboard(1,'press','S') wait(2) tap('5') wait(3) Keyboard(1,'release','S') until_(function() return cmd()=='Store Cue 5' end) local c=cmd() esc(1) return c`);
  await check("K10", "invalid event type and key name are accepted silently (no error)", (o) => o === true, `
    Keyboard(1,'bogus','5') Keyboard(1,'press','NotAKey') Keyboard(1,'release','NotAKey') return true`);
  await check("K11", "display_index does not route input (indexes 2, 99, 0 all type 5)", (o) => o.every((v) => v === "5"), `
    local r={} for _,d in ipairs({2,99,0}) do Keyboard(d,'press','5') Keyboard(d,'release','5') until_(function() return cmd()=='5' end) r[#r+1]=cmd() esc(1) until_(function() return cmd()=='' end) end return r`);

  // MA via Shift keys
  await check("M1", "shift flag + S is plain Store (flag is not MA)", (o) => o === "Store ", `tap('S',true) until_(function() return cmd()~='' end) local c=cmd() esc(1) return c`);
  await check("M2", "LeftShift key held sets MASTATE and turns S into Record", (o) => o.held && o.cmd === "Record " && !o.after, `
    Keyboard(1,'press','LeftShift') until_(function() return Root():Get('MAState') end) local h=Root():Get('MAState') tap('S') until_(function() return cmd()~='' end) local c=cmd()
    Keyboard(1,'release','LeftShift') until_(function() return not Root():Get('MAState') end) local a=Root():Get('MAState') esc(1) return {held=h, cmd=c, after=a}`);
  await check("M3", "RightShift behaves the same", (o) => o.held && o.cmd === "Record " && !o.after, `
    Keyboard(1,'press','RightShift') until_(function() return Root():Get('MAState') end) local h=Root():Get('MAState') tap('S') until_(function() return cmd()~='' end) local c=cmd()
    Keyboard(1,'release','RightShift') until_(function() return not Root():Get('MAState') end) local a=Root():Get('MAState') esc(1) return {held=h, cmd=c, after=a}`);
  await check("M4", "MA stays held until both Shift keys are released", (o) => o.oneUp === true && o.bothUp === false, `
    Keyboard(1,'press','LeftShift') Keyboard(1,'press','RightShift') wait(3) Keyboard(1,'release','LeftShift') wait(3) local one=Root():Get('MAState')
    Keyboard(1,'release','RightShift') until_(function() return not Root():Get('MAState') end) return {oneUp=one, bothUp=Root():Get('MAState')}`);

  // Feedback readers (each toggled and restored)
  for (const [id, mode, key, s, c, a] of [["F1", "Blind", "B"], ["F2", "Highlight", "H"], ["F3", "Solo", "S", false, true, true]]) {
    await check(id, `${mode} toggles Masters.Grand.${mode}.FADERENABLED and back`, (o) => o.toggled !== o.before && o.restored === o.before, `
      local m=ShowData().Masters.Grand.${mode} local b=m:Get('FaderEnabled')
      tap('${key}',${!!s},${!!c},${!!a}) until_(function() return m:Get('FaderEnabled')~=b end) local t=m:Get('FaderEnabled')
      tap('${key}',${!!s},${!!c},${!!a}) until_(function() return m:Get('FaderEnabled')==b end) return {before=b, toggled=t, restored=m:Get('FaderEnabled')}`);
  }
  await check("F4", "Preview key sets PREVIEWBARACTIVE; Please enters Preview; Preview Off leaves", (o) => o.bar === true && o.env === "Preview" && o.back === "Normal", `
    local e=CurrentProfile().Environments local d=GetDisplayByIndex(1)
    tap('P',false,true,true) until_(function() return d:Get('PreviewBarActive') end) local bar=d:Get('PreviewBarActive')
    tap('Enter') until_(function() return e:Get('ActiveEnvironment')=='Preview' end) local env=e:Get('ActiveEnvironment')
    Cmd('Preview Off') until_(function() return e:Get('ActiveEnvironment')=='Normal' end) return {bar=bar, env=env, back=e:Get('ActiveEnvironment')}`);

  // Shortcuts disabled
  await check("S1", "F10 disables shortcuts: S does nothing, char types, Enter executes, Delete does not clear; F10 re-enables", (o) =>
    o.off === false && o.s === "" && o.char === "5" && o.sel === 1 && o.selAfterDelete === 1 && o.on === true, `
    local k=CurrentProfile().KeyboardShortCuts tap('F10') until_(function() return not k:Get('KeyboardShortcutsActive') end) local off=k:Get('KeyboardShortcutsActive')
    tap('S') wait(10) local s=cmd() Keyboard(1,'char','5') until_(function() return cmd()=='5' end) local ch=cmd()
    tap('Enter') until_(function() return SelectionCount()>0 end) local sel=SelectionCount() tap('Delete') wait(10) local sad=SelectionCount()
    tap('F10') until_(function() return k:Get('KeyboardShortcutsActive') end) local on=k:Get('KeyboardShortcutsActive')
    tap('Delete') until_(function() return SelectionCount()==0 end) return {off=off, s=s, char=ch, sel=sel, selAfterDelete=sad, on=on}`);
  await check("S2", "char without a focused text input types nothing (shortcuts on)", (o) => o === "", `Keyboard(1,'char','x') wait(10) local c=cmd() esc(1) return c`);

  // Double-press (expected unsupported)
  await check("D1", "Help double tap (8-frame gap) is a single Help, not the overlay", (o) => o === "Help ", `
    tap('H',false,true,true) wait(8) tap('H',false,true,true) wait(10) local c=cmd() esc(1) return c`);

  const final = await lua(`esc(2) local g=ShowData().Masters.Grand return {blind=g.Blind:Get('FaderEnabled'), shcuts=CurrentProfile().KeyboardShortCuts:Get('KeyboardShortcutsActive'), sel=SelectionCount(), env=CurrentProfile().Environments:Get('ActiveEnvironment'), ma=Root():Get('MAState'), cmd=cmd()}`);
  const restored = final.blind === initial.blind && final.shcuts && final.env === "Normal" && !final.ma && final.cmd === "";
  console.log(`\nstate restored: ${restored ? "yes" : "NO"} ${JSON.stringify(final)}`);
  const passed = results.filter((r) => r.pass).length;
  console.log(`${passed}/${results.length} checks passed`);
  console.log(`
Manual checks (record results in the evidence file):
  1. node scripts/kb01-probe.mjs longpress -- confirm the Store Settings pop-up opens, then press Esc twice.
  2. Open the Edit Command dialog (keyboard icon left of the command line), then
     node scripts/kb01-probe.mjs type -- confirm "aü" appears; press Esc twice.
  3. node scripts/kb01-probe.mjs hw-a -- hold physical Left Shift ~6 s on the focused onPC window.
  4. node scripts/kb01-probe.mjs hw-b -- tap physical Left Shift once on the focused onPC window.
  5. Note keyboard layout, displays/monitors and whether onPC was in the OS foreground.`);
  const report = { when: new Date().toISOString(), env: { ...env, show }, initial, final, restored, results };
  if (outFile) { fs.writeFileSync(outFile, JSON.stringify(report, null, 2)); console.log(`report written to ${outFile}`); }
  process.exitCode = passed === results.length && restored ? 0 : 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function hardware(which) {
  const t0 = Date.now();
  const log = (ev, v) => console.log(((Date.now() - t0) / 1000).toFixed(2).padStart(6), ev, v);
  const ma = () => lua(`return Root():Get('MAState')`);
  if (which === "a") {
    console.log("Focus the onPC window and hold the physical Left Shift for about 6 seconds (waiting up to 4 min).");
    let since = null;
    while (Date.now() - t0 < 240000) {
      const v = await ma();
      if (v && since === null) { since = Date.now(); log("physical-hold-seen", v); }
      if (!v && since !== null) { log("hold-ended-early", v); since = null; }
      if (since !== null && Date.now() - since > 1500) break;
      await sleep(100);
    }
    if (since === null) { log("timeout", false); process.exitCode = 1; return; }
    log("inject-release", await lua(`Keyboard(1,'release','LeftShift') return Root():Get('MAState')`));
    const polls = [];
    for (let i = 0; i < 20; i++) { polls.push(await ma()); await sleep(150); }
    log("polls-after-release", polls.join(","));
    console.log(polls.every((v) => !v) ? "RESULT: injected release ended the physical hold" : "RESULT: MA stayed or returned while held");
  } else {
    log("inject-press", await lua(`Keyboard(1,'press','LeftShift') wait(3) return Root():Get('MAState')`));
    console.log("Focus the onPC window and tap the physical Left Shift once (waiting up to 4 min).");
    let dropped = false;
    while (Date.now() - t0 < 240000) { if (!(await ma())) { log("MASTATE-dropped", false); dropped = true; break; } await sleep(100); }
    if (!dropped) log("timeout-still-held", true);
    await sleep(500);
    log("cleanup-release", await lua(`Keyboard(1,'release','LeftShift') wait(3) return Root():Get('MAState')`));
    console.log(dropped ? "RESULT: physical tap ended the injected hold" : "RESULT: no drop observed");
    process.exitCode = dropped ? 0 : 1;
  }
}

try {
  if (mode === "auto") await auto();
  else if (mode === "longpress") console.log(JSON.stringify(await lua(`esc(2) Keyboard(1,'press','S') wait(110) Keyboard(1,'release','S') wait(3) return {cmd=cmd()}`)), "-- is the Store Settings pop-up open?");
  else if (mode === "type") console.log(JSON.stringify(await lua(`Keyboard(1,'char','a') Keyboard(1,'char','ü') wait(3) return {cmd=cmd()}`)), "-- expected text ending in aü");
  else if (mode === "hw-a") await hardware("a");
  else if (mode === "hw-b") await hardware("b");
  else { console.error("usage: kb01-probe.mjs auto [--out file.json] [--force] | longpress | type | hw-a | hw-b"); process.exitCode = 2; }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exitCode = 1;
}
