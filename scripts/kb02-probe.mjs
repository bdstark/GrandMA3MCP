#!/usr/bin/env node
// KB-02 module-loading probe and verifier (see docs/modules.md, docs/probes/kb-02-loading-macos-2.5.1.md).
//
//   node scripts/kb02-probe.mjs verify              check a running bridge: modules loaded, no loose module files
//   node scripts/kb02-probe.mjs probe [--slot N]    import a throwaway two-component plugin into Plugin slot N
//                                                   (default 2, must be free), record how the console loads it,
//                                                   then delete the slot and its files
//
// Both need the bridge with Lua enabled (Plugin "gma3_mcp_bridge" "lua on"); `probe` also needs a show whose
// name contains "disposable" (override with --force) and write access to the library plugins folder.
// GMA3_BRIDGE_HOST / GMA3_BRIDGE_PORT select the bridge; GMA3_LIBRARY the library folder.
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const host = process.env.GMA3_BRIDGE_HOST ?? "127.0.0.1";
const port = Number(process.env.GMA3_BRIDGE_PORT ?? 9800);
const argv = process.argv.slice(2);
const mode = argv[0];
const force = argv.includes("--force");
const slotIdx = argv.indexOf("--slot");
const slot = slotIdx >= 0 ? Number(argv[slotIdx + 1]) : 2;

let seq = 0;
function request(op, args) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host, () => sock.write(JSON.stringify({ id: `kb02-${seq++}`, op, args }) + "\n"));
    let buf = "";
    sock.setEncoding("utf8");
    sock.setTimeout(20000, () => { sock.destroy(); reject(new Error("timeout")); });
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
async function lua(code) {
  const r = await request("lua", { code, timeout_ms: 8000 });
  return r.values?.[0];
}

function libraryDir() {
  if (process.env.GMA3_LIBRARY) return process.env.GMA3_LIBRARY;
  return path.join(os.homedir(), "MALightingTechnology", "gma3_library");
}

async function verify() {
  const ping = await request("ping", {});
  console.log(`bridge ${ping.bridgeVersion} on ${ping.host}:${ping.port}; show "${ping.showfile ?? ""}"; lua ${ping.lua?.enabled ? "enabled" : "disabled"}`);
  let ok = true;
  const mods = await request("modules", {});
  for (const key of ["hardkeys", "feedback"]) {
    const m = mods.modules?.[key];
    const pass = !!(m && m.loaded && m.status && m.status.state === "ready");
    ok &&= pass;
    console.log(`${pass ? "PASS" : "FAIL"}  module ${key}: ${m ? `loaded=${m.loaded} version=${m.version ?? "-"} state=${m.status?.state ?? "-"}${m.error ? ` error=${m.error}` : ""}` : "not reported"}`);
  }
  const pluginsDir = path.join(libraryDir(), "datapools", "plugins");
  const loose = ["gma3_mcp_hardkeys.lua", "gma3_mcp_feedback.lua", "gma3_mcp_bridge.lua"].filter((f) => fs.existsSync(path.join(pluginsDir, f)));
  console.log(`${loose.length ? "INFO" : "PASS"}  loose plugin files in ${pluginsDir}: ${loose.length ? loose.join(", ") : "none (modules came from the show file)"}`);
  if (ping.lua?.enabled) {
    const inst = await lua(`local st = _G.__gma3_mcp_bridge; local fb = st.modules.feedback.instance; local hk = st.modules.hardkeys.instance
      return { blind = fb:read('blind'), freeze = fb:read('freeze'), please = hk:describeKey('PLEASE'), ma1 = hk:describeKey('MA1') }`);
    const pass = inst?.blind?.available !== undefined && inst?.freeze?.available === false && inst?.ma1?.supported === false;
    ok &&= pass;
    console.log(`${pass ? "PASS" : "FAIL"}  live readers: blind=${JSON.stringify(inst?.blind?.value)} freeze=unavailable PLEASE->${inst?.please?.pcKey ?? inst?.please?.reason} MA1=${inst?.ma1?.supported ? "supported?!" : "unsupported"}`);
  } else {
    console.log("SKIP  live reader check (enable Lua on the bridge to run it)");
  }
  console.log(ok ? "VERIFY PASSED" : "VERIFY FAILED");
  process.exit(ok ? 0 : 1);
}

const ENTRY = `-- kb02_probe.lua : KB-02 loader probe, entry component
local pluginName, componentName, signalTable, my_handle = ...
_G.__kb02 = _G.__kb02 or { chunkRuns = {}, mainRuns = {} }
table.insert(_G.__kb02.chunkRuns, { component = tostring(componentName), plugin = tostring(pluginName), signalTable = tostring(signalTable), handle = tostring(my_handle), nargs = select("#", ...) })
local function Main()
  local parent = my_handle:Parent()
  local r = { plugin = tostring(pluginName), handleClass = tostring(my_handle:GetClass()), parentClass = tostring(parent:GetClass()), signalTable = tostring(signalTable) }
  local reg = type(signalTable) == "table" and signalTable.__kb02_modules or nil
  r.registryHit = reg ~= nil and reg.kb02_probe_mod ~= nil
  r.registryHello = r.registryHit and reg.kb02_probe_mod.hello() or nil
  local ok, m = pcall(require, "kb02_probe_mod")
  r.requireOk, r.requireResult = ok, tostring(m)
  r.searchpath = tostring(package.searchpath("kb02_probe_mod", package.path))
  for i = 1, parent:Count() do local c = parent:Ptr(i) if tostring(c.name) == "kb02_probe_mod" then r.fileContentLen = #(c:Get("FileContent") or "") r.fullPath = tostring(c:Get("FullPath")) end end
  table.insert(_G.__kb02.mainRuns, r)
end
return Main
`;
const MOD = `-- kb02_probe_mod.lua : KB-02 loader probe, module component
local pluginName, componentName, signalTable = ...
_G.__kb02 = _G.__kb02 or { chunkRuns = {}, mainRuns = {} }
table.insert(_G.__kb02.chunkRuns, { component = tostring(componentName), plugin = tostring(pluginName), signalTable = tostring(signalTable), nargs = select("#", ...) })
local M = { padding = string.rep("-", 1200) }  -- longer than the FileContent cap on purpose
function M.hello() return "hello from " .. tostring(pluginName) .. "/" .. tostring(componentName) end
if type(signalTable) == "table" then signalTable.__kb02_modules = signalTable.__kb02_modules or {}; signalTable.__kb02_modules[tostring(componentName)] = M end
return M
`;
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<GMA3 DataVersion="0.8.84.0">
    <UserPlugin Name="kb02_probe" Author="gma3-mcp" Version="0.0.1">
        <ComponentLua Name="kb02_probe" FileName="kb02_probe.lua" />
        <ComponentLua Name="kb02_probe_mod" FileName="kb02_probe_mod.lua" />
    </UserPlugin>
</GMA3>
`;

async function probe() {
  const ping = await request("ping", {});
  if (!ping.lua?.enabled) throw new Error('Lua is disabled on the bridge; run Plugin "gma3_mcp_bridge" "lua on"');
  const show = ping.showfile ?? "";
  if (!/disposable/i.test(show) && !force) throw new Error(`show "${show}" is not marked disposable; use --force to run anyway`);
  const occupied = await lua(`local p = ShowData().DataPools.Default.Plugins:Ptr(${slot}) return p and tostring(p.name) or false`);
  if (occupied) throw new Error(`Plugin slot ${slot} holds "${occupied}"; pick a free slot with --slot`);
  const dir = path.join(libraryDir(), "datapools", "plugins");
  const files = { "kb02_probe.lua": ENTRY, "kb02_probe_mod.lua": MOD, "kb02_probe.xml": XML };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  console.log(`probe files written to ${dir}; importing into Plugin ${slot}`);
  const results = {};
  try {
    results.withLooseFiles = await lua(`_G.__kb02 = { chunkRuns = {}, mainRuns = {} }
      local real = getmetatable(package) and getmetatable(package).__index or package; real.loaded["kb02_probe_mod"] = nil
      Cmd('Import Plugin Library "kb02_probe.xml" At Plugin ${slot}') for i = 1, 3 do coroutine.yield() end
      Cmd('Plugin "kb02_probe"') for i = 1, 4 do coroutine.yield() end
      return _G.__kb02`);
    for (const name of Object.keys(files)) fs.rmSync(path.join(dir, name), { force: true });
    results.withoutLooseFiles = await lua(`_G.__kb02 = { chunkRuns = {}, mainRuns = {} }
      local real = getmetatable(package) and getmetatable(package).__index or package; real.loaded["kb02_probe_mod"] = nil
      Cmd('Plugin "kb02_probe"') for i = 1, 4 do coroutine.yield() end
      return _G.__kb02`);
  } finally {
    await lua(`Cmd('Delete Plugin ${slot} /NoConfirmation') _G.__kb02 = nil
      local real = getmetatable(package) and getmetatable(package).__index or package; real.loaded["kb02_probe_mod"] = nil return true`).catch(() => {});
    for (const name of Object.keys(files)) fs.rmSync(path.join(dir, name), { force: true });
  }
  const a = results.withLooseFiles, b = results.withoutLooseFiles;
  const chunk = a.chunkRuns ?? [];
  const importRuns = chunk.filter((c) => c.nargs === 4);
  const checks = [
    ["import runs every component chunk with 4 args", importRuns.length === 2],
    ["components run in XML order", importRuns[0]?.component === "kb02_probe" && importRuns[1]?.component === "kb02_probe_mod"],
    ["both components share one signal table", importRuns.length === 2 && importRuns[0].signalTable === importRuns[1].signalTable && importRuns[0].signalTable !== "nil"],
    ["handle invalid during chunk, ComponentLua in Main", importRuns[0]?.handle === "<invalid>" && a.mainRuns?.[0]?.handleClass === "ComponentLua"],
    ["module found through the signal table", a.mainRuns?.[0]?.registryHit === true && b.mainRuns?.[0]?.registryHit === true],
    ["source stored in the show file", a.mainRuns?.[0]?.fullPath === "<Showfile>"],
    ["FileContent is capped (~1 KB)", (a.mainRuns?.[0]?.fileContentLen ?? 0) < 1100],
    ["require resolves the loose file when present", a.mainRuns?.[0]?.requireOk === true && /datapools/.test(a.mainRuns?.[0]?.searchpath ?? "")],
    ["require fails without the loose file", b.mainRuns?.[0]?.requireOk === false],
  ];
  let ok = true;
  for (const [name, pass] of checks) { ok &&= !!pass; console.log(`${pass ? "PASS" : "FAIL"}  ${name}`); }
  console.log(JSON.stringify(results, null, 1));
  console.log(ok ? "PROBE PASSED" : "PROBE FAILED");
  process.exit(ok ? 0 : 1);
}

if (mode === "verify") verify().catch((e) => { console.error(e.message); process.exit(1); });
else if (mode === "probe") probe().catch((e) => { console.error(e.message); process.exit(1); });
else { console.error("usage: node scripts/kb02-probe.mjs verify | probe [--slot N] [--force]"); process.exit(2); }
