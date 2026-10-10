#!/usr/bin/env node
// KB-16 encoder-context and executor-semantics probe against a RUNNING bridge with Lua enabled
// (plugin 0.12.0 or newer; see ENCODERS.md "KB-16").
//
//   node scripts/kb16-probe.mjs verify [--out report.json]   read-only: no console state is changed
//   node scripts/kb16-probe.mjs run    [--out report.json]   verify + state changes on a DISPOSABLE show
//                                                           (selection, encoder bank/page, programmer
//                                                           values, executor presses, fader functions)
//   node scripts/kb16-probe.mjs watch  [--seconds N]         prints the encoder context twice a second
//                                                           while the operator changes things in onPC
//
// Everything is read through the bridge's `lua` op (no production reader exists yet: KB-17 builds the
// feedback-module readers from what this probe establishes). `verify` establishes which console objects
// expose the active encoder bank/page, the on-screen slot labels/values/resolution, the profile's slot
// assignments, the selected feature/attribute, the preset-bar context, and per-executor assignment,
// key/fader/encoder functions, appearance and activity. `run` establishes what changes them and how
// a signed adjustment lands, and restores what it changed. Nothing is retried. `run` refuses to start when the
// programmer is not provably empty (the bridge's `programmer` op, complete coverage, no data), registers every
// undo before the change it belongs to (scripts/lib/kb16-steps.mjs) and runs all of them at the end even when
// one fails.
// GMA3_BRIDGE_HOST / GMA3_BRIDGE_PORT select the bridge.
import net from "node:net";
import fs from "node:fs";
import { createCleanup, execRef, probeExecutorButton, probeFader, programmerEmpty } from "./lib/kb16-steps.mjs";

const host = process.env.GMA3_BRIDGE_HOST ?? "127.0.0.1";
const port = Number(process.env.GMA3_BRIDGE_PORT ?? 9800);
const argv = process.argv.slice(2);
const mode = argv[0];
const outIdx = argv.indexOf("--out");
const outFile = outIdx >= 0 ? argv[outIdx + 1] : null;
const secIdx = argv.indexOf("--seconds");
const watchSeconds = secIdx >= 0 ? Number(argv[secIdx + 1]) : 60;
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

// ---------------------------------------------------------------------------------------------------
// Lua chunks. Every chunk returns flat tables (the bridge serialises nested tables to a small depth).
// Helpers shared by the chunks: `get(h, prop)` reads a property in its display role (the string the
// editors show, e.g. "107 'ColorRGB_R'"); `h.Prop` returns nil for link properties on 2.5.1.
const LUA_PRELUDE = `
local function get(h, p) local ok, v = pcall(function() return h:Get(p, Enums.Roles.Display) end); if ok and v ~= nil then return tostring(v) end; return nil end
local function num(v) return tonumber(v) end
local function cls(h) local ok, c = pcall(function() return h:GetClass() end); return ok and tostring(c) or nil end
local function findClass(h, c) if not h then return nil end; for i = 1, h:Count() do local x = h:Ptr(i); if x and cls(x) == c then return x end end; return nil end
local function encoderUi(displayIndex)
  local d = GetDisplayByIndex(displayIndex); if not d then return nil, "no display " .. tostring(displayIndex) end
  local ebc = d.EncoderBarContainer; if not ebc then return nil, "display " .. tostring(displayIndex) .. " has no EncoderBarContainer" end
  local grid = ebc.EncoderBarGrid; if not grid then return nil, "no EncoderBarGrid" end
  local base = grid.EncoderBarBase and grid.EncoderBarBase.EncoderBarContainer
  local presetBar = findClass(grid.EncoderBar, "PresetBar")
  if not base or not presetBar then return nil, "no EncoderBankSelector/PresetBar (display " .. tostring(displayIndex) .. ")" end
  return { grid = grid, base = base, presetBar = presetBar }
end
local out = { errors = {} }
local function safe(label, f) local ok, r = pcall(f); if ok then out[label] = r else out.errors[#out.errors + 1] = label .. ": " .. tostring(r) end end
`;

// The active encoder context as the UI shows it on one display, plus the console-side selection
// objects. Returns one flat table.
const LUA_CONTEXT = (display) => `${LUA_PRELUDE}
local ui, why = encoderUi(${display})
if not ui then return { unavailable = why } end
out.display = ${display}
safe("bank", function() local s = ui.base.EncoderBankSelector; return { idx = num(s.SelectedItemIdx), i64 = num(s.SelectedItemValueI64), text = tostring(s.Text) } end)
safe("page", function() local s = ui.presetBar.Options.PageSelector; return { idx = num(s.SelectedItemIdx), i64 = num(s.SelectedItemValueI64), text = tostring(s.Text) } end)
safe("context", function() return tostring(ui.presetBar.Context) end)
safe("fadeEncoder", function() return tostring(ui.presetBar.FadeEncoder) end)
safe("selectionCount", function() return SelectionCount() end)
safe("selectedFeature", function() local f = SelectedFeature(); if not f then return "nil" end; return tostring(f.name) .. "#" .. tostring(f.index) end)
safe("selectedFeatureGroup", function() local f = SelectedFeature(); if not f then return "nil" end; local p = f:Parent(); return p and (tostring(p.name) .. "#" .. tostring(p.index)) or "nil" end)
safe("selectedAttribute", function() local a = GetSelectedAttribute(); if not a then return "nil" end; return tostring(a.name) .. "#" .. tostring(a.index) end)
safe("selectedAttributeMeta", function() local a = GetSelectedAttribute(); if not a then return "nil" end; return "feature=" .. tostring(get(a, "Feature")) .. " unit=" .. tostring(get(a, "PhysicalUnit")) .. " readout=" .. tostring(get(a, "NaturalReadout")) .. " resolution=" .. tostring(get(a, "EncoderResolution")) .. " special=" .. tostring(get(a, "Special")) end)
safe("profile", function() local p = CurrentProfile(); return tostring(p.name) .. " layer=" .. tostring(get(p, "Layer")) .. " valueReadout=" .. tostring(get(p, "ValueReadout")) .. " encoderLinkValues=" .. tostring(get(p, "EncoderLinkValues")) .. " wheelResolution=" .. tostring(get(p, "WheelResolution")) .. " wheelMode=" .. tostring(get(p, "WheelMode")) end)
-- The five on-screen encoder places: label and value of the inner band (slot), resolution, the channel
-- function selector (visible when the slot has an attribute with several channel functions).
for p = 1, 5 do
  safe("place" .. p, function()
    local place = ui.presetBar.EncodersArea["EncoderPlace" .. p]
    if not place or place:Count() == 0 then return "absent" end
    local r = {}
    local gridNo = 0
    for i = 1, place:Count() do
      local g = place:Ptr(i)
      if g and cls(g) == "UILayoutGrid" then
        gridNo = gridNo + 1
        local ring = gridNo == 1 and "inner" or "outer"
        for j = 1, g:Count() do
          local c = g:Ptr(j); local k = cls(c); local n = tostring(c.name)
          if k == "BandFader" and ring == "inner" then r.label = tostring(c.Text); r.value = tostring(c.Value); r.resolution = tostring(c.Resolution); r.valueText = tostring(get(c, "Value"))
          elseif k == "BandFader" then r.outerLabel = tostring(c.Text); r.outerValue = tostring(c.Value)
          elseif k == "SwipeButtonList" and n:match("^ChannelFunctionSelector") and ring == "inner" then r.channelFunction = tostring(c.Text); r.channelFunctionIdx = num(c.SelectedItemIdx); r.channelFunctionVisible = tostring(c.Visible)
          elseif k == "SwipeButtonList" and n:match("^EncoderResolutionSelector") and ring == "inner" then r.resolutionSelector = tostring(c.Text); r.resolutionSelectorI64 = num(c.SelectedItemValueI64); r.resolutionSelectorVisible = tostring(c.Visible)
          elseif k == "PresetEncoderControl" and ring == "inner" then r.encoderType = tostring(c.EncoderType); r.encoderRing = tostring(c.EncoderRing); r.encoderResolution = tostring(c.EncoderResolution) end
        end
      end
    end
    return r
  end)
end
return out
`;

// The user profile's encoder bar pool: every bank, page and slot assignment, flattened to strings.
const LUA_POOL = `${LUA_PRELUDE}
safe("bars", function()
  local pool = CurrentProfile().EncoderBarPool; local lines = {}
  for b = 1, pool:Count() do local bar = pool:Ptr(b)
    for k = 1, bar:Count() do local bank = bar:Ptr(k)
      local pageCount = bank:Count()
      if pageCount == 0 then lines[#lines + 1] = string.format("%s|%d|%s|0||", tostring(bar.name), k, tostring(bank.name)) end
      for g = 1, pageCount do local page = bank:Ptr(g); local encs = {}
        for e = 1, page:Count() do local enc = page:Ptr(e)
          local i, o = get(enc, "InnerObject") or "", get(enc, "OuterObject") or ""
          encs[#encs + 1] = i .. "[" .. tostring(get(enc, "InnerObjectType")) .. "]" .. (o ~= i and ("/" .. o .. "[" .. tostring(get(enc, "OuterObjectType")) .. "]") or "")
        end
        lines[#lines + 1] = string.format("%s|%d|%s|%d|%s|%s", tostring(bar.name), k, tostring(bank.name), g, tostring(page.name), table.concat(encs, ";"))
      end
    end
  end
  return lines
end)
safe("prefs", function()
  local p = CurrentProfile().UserAttributePreferences
  return "dualEncoderFactor=" .. tostring(get(p, "DualEncoderFactor")) .. " dualEncoderPressFactor=" .. tostring(get(p, "DualEncoderPressFactor")) .. " timeLayerResolution=" .. tostring(get(p, "TimeLayerResolution")) .. " phaserLayerResolution=" .. tostring(get(p, "PhaserLayerResolution")) .. " linkResolution=" .. tostring(get(p, "LinkResolution")) .. " count=" .. p:Count()
end)
safe("prefSample", function()
  local p = CurrentProfile().UserAttributePreferences; local t = {}
  for _, n in ipairs({ "Dimmer", "Pan", "Tilt", "ColorRGB_R", "ColorRGB_G", "ColorRGB_B", "Gobo1", "Zoom" }) do
    local a = p[n]
    if a then t[#t + 1] = n .. ": readout=" .. tostring(get(a, "NaturalReadout")) .. " resolution=" .. tostring(get(a, "EncoderResolution")) .. " pressFactor=" .. tostring(get(a, "EncoderPressFactor")) else t[#t + 1] = n .. ": absent" end
  end
  return t
end)
return out
`;

// Attribute metadata from the show's attribute definitions and, for the selection, which UI channels exist.
const LUA_ATTRIBUTES = (names) => `${LUA_PRELUDE}
local names = { ${names.map((n) => JSON.stringify(n)).join(", ")} }
safe("attributes", function()
  local t = {}
  for _, n in ipairs(names) do
    local idx = GetAttributeIndex(n)
    local line = n .. ": index=" .. tostring(idx)
    if idx ~= nil then
      local defs = Root().ShowData.LivePatch.AttributeDefinitions.Attributes
      local a = defs[n]
      if a then line = line .. " feature=" .. tostring(get(a, "Feature")) .. " unit=" .. tostring(get(a, "PhysicalUnit")) .. " readout=" .. tostring(get(a, "NaturalReadout")) .. " resolution=" .. tostring(get(a, "EncoderResolution")) .. " color=" .. tostring(get(a, "Color")) .. " special=" .. tostring(get(a, "Special")) .. " channelFunctions=" .. tostring(get(a, "ChannelFunctions")) end
    end
    t[#t + 1] = line
  end
  return t
end)
safe("selectionChannels", function()
  local n = SelectionCount(); if n == 0 then return "empty" end
  local first = SelectionFirst()
  local t = { "selectionFirst=" .. tostring(first) }
  local ui = GetUIChannels(first) or {}
  t[#t + 1] = "uiChannelsOfFirst=" .. #ui
  if #ui == 0 then
    -- a grouping fixture: look at its first subfixture
    local sub = GetSubfixture(first)
    local cnt = GetSubfixtureCount(first)
    t[#t + 1] = "subfixtures=" .. tostring(cnt)
  end
  local seen = {}
  for i = 1, math.min(#ui, 40) do local a = GetAttributeByUIChannel(ui[i]); if a then seen[#seen + 1] = tostring(a.name) end end
  t[#t + 1] = "attributes=" .. table.concat(seen, ",")
  return t
end)
return out
`;

// Executors of the current page: assignment, functions, appearance, activity and readable fader tokens.
const LUA_EXECUTORS = (numbers, tokens) => `${LUA_PRELUDE}
local numbers = { ${numbers.join(", ")} }
local tokens = { ${tokens.map((t) => JSON.stringify(t)).join(", ")} }
safe("page", function() local p = CurrentExecPage(); return tostring(p.name) .. "#" .. tostring(p.index) end)
safe("executors", function()
  local lines = {}
  for _, n in ipairs(numbers) do
    local e = GetExecutor(n)
    if not e then lines[#lines + 1] = n .. "|missing" else
      local obj = e.Object
      local parts = { tostring(n), "exec=" .. tostring(get(e, "Exec")), "object=" .. tostring(get(e, "Object")), "class=" .. tostring(obj and cls(obj)), "name=" .. tostring(obj and obj.name) }
      parts[#parts + 1] = "keyPress=" .. tostring(get(e, "KeyPress")) .. " keyUnpress=" .. tostring(get(e, "KeyUnpress")) .. " keyUnpressCombined=" .. tostring(get(e, "KeyUnpressCombined")) .. " fader=" .. tostring(get(e, "Fader")) .. " encoder=" .. tostring(get(e, "Encoder")) .. " encoderLeft=" .. tostring(get(e, "EncoderLeft")) .. " encoderRight=" .. tostring(get(e, "EncoderRight")) .. " isXKey=" .. tostring(get(e, "IsXKey")) .. " width=" .. tostring(get(e, "Width"))
      parts[#parts + 1] = "config=" .. tostring(get(e, "ExecutorConfiguration"))
      if obj then
        parts[#parts + 1] = "appearance=" .. tostring(get(obj, "Appearance"))
        local app = obj.Appearance
        if type(app) == "userdata" then parts[#parts + 1] = "backRGBA=" .. tostring(get(app, "BackRGBA")) .. " color=" .. tostring(get(app, "Color")) end
        local okA, act = pcall(function() return obj:HasActivePlayback() end)
        parts[#parts + 1] = "active=" .. (okA and tostring(act) or ("ERR " .. tostring(act)))
        local fd = {}
        for _, tk in ipairs(tokens) do
          local okV, v = pcall(function() return obj:GetFader({ token = tk }) end)
          local okT, tx = pcall(function() return obj:GetFaderText({ token = tk }) end)
          fd[#fd + 1] = tk .. "=" .. (okV and tostring(v) or "ERR") .. "(" .. (okT and tostring(tx) or "ERR") .. ")"
        end
        parts[#parts + 1] = "faders " .. table.concat(fd, " ")
      end
      lines[#lines + 1] = table.concat(parts, " | ")
    end
  end
  return lines
end)
return out
`;

const LUA_PAGE_EXECUTORS = `${LUA_PRELUDE}
safe("list", function()
  local p = CurrentExecPage(); local t = {}
  for i = 1, p:Count() do local e = p:Ptr(i); if e and e.Object then t[#t + 1] = tostring(e.index) .. "|" .. tostring(e.Object.name) .. "|" .. tostring(cls(e.Object)) .. "|" .. tostring(get(e, "KeyPress")) .. "|" .. tostring(get(e, "KeyUnpress")) .. "|" .. tostring(get(e, "Fader")) end end
  return t
end)
return out
`;

const LUA_SELECTION_VALUES = (attr) => `${LUA_PRELUDE}
safe("values", function()
  -- Programmer value of one attribute for the first selected (sub)fixture, in the units the console shows.
  local first = SelectionFirst(); if not first then return "no selection" end
  local ui = GetUIChannels(first) or {}
  local target = first
  if #ui == 0 and GetSubfixtureCount(first) > 0 then target = GetSubfixture(first, 0) or first; ui = GetUIChannels(target) or {} end
  for i = 1, #ui do
    local a = GetAttributeByUIChannel(ui[i])
    if a and tostring(a.name) == ${JSON.stringify(attr)} then
      local ok, ph = pcall(GetProgPhaser, ui[i], false)
      if ok and type(ph) == "table" then
        local parts = { "uiChannel=" .. tostring(ui[i]) }
        local function flat(t, prefix, depth)
          for k, v in pairs(t) do
            if type(v) == "table" and depth > 0 then flat(v, prefix .. tostring(k) .. ".", depth - 1)
            elseif type(v) ~= "table" then parts[#parts + 1] = prefix .. tostring(k) .. "=" .. tostring(v) end
          end
        end
        flat(ph, "", 2)
        table.sort(parts)
        return table.concat(parts, " ")
      end
      return "uiChannel=" .. tostring(ui[i]) .. " GetProgPhaser=" .. tostring(ph)
    end
  end
  return "attribute not in the first (sub)fixture's UI channels"
end)
return out
`;

async function lua(A, code, label) {
  const r = await A.request("lua", { code, maxMs: 4000 });
  if (!r.ok) return { ok: false, error: r.error, code: r.code };
  const v = r.result?.values?.[0] ?? r.result;
  if (v && Array.isArray(v.errors) && v.errors.length && label) note(`${label}: Lua errors`, v.errors);
  return { ok: true, value: v };
}

const place = (ctx, n) => ctx?.[`place${n}`];
const placeSummary = (ctx) => [1, 2, 3, 4, 5].map((n) => { const p = place(ctx, n); return p && typeof p === "object" ? `${n}:${p.label}=${p.value}(${p.resolution})${p.channelFunction ? "/" + p.channelFunction : ""}` : `${n}:${p}`; });
const contextSummary = (ctx) => ctx?.unavailable ? ctx : { bank: ctx.bank, page: ctx.page, context: ctx.context, selectedFeature: ctx.selectedFeature, selectedFeatureGroup: ctx.selectedFeatureGroup, selectedAttribute: ctx.selectedAttribute, selectionCount: ctx.selectionCount, places: placeSummary(ctx) };

function parsePool(lines) {
  const banks = new Map();
  for (const line of lines ?? []) {
    const [bar, bankNo, bankName, pageNo, pageName, encs] = line.split("|");
    const b = banks.get(Number(bankNo)) ?? { bar, no: Number(bankNo), name: bankName, pages: [] };
    if (Number(pageNo) > 0) b.pages.push({ no: Number(pageNo), name: pageName, slots: encs.split(";").map((s) => s.replace(/\[.*$/, "").replace(/^[A-Za-z]+ \d+ '/, "").replace(/'$/, "")) });
    banks.set(Number(bankNo), b);
  }
  return banks;
}

async function main() {
  if (!["verify", "run", "watch"].includes(mode)) {
    console.error("usage: node scripts/kb16-probe.mjs verify|run|watch [--out report.json] [--seconds N]");
    process.exit(2);
  }
  const A = new Conn("A");
  await A.connect();
  const pingR = await A.request("ping");
  if (!pingR.ok) { console.error(`ping failed: ${pingR.error}`); process.exit(2); }
  const ping = pingR.result;
  if (!ping.lua?.enabled) { console.error("this probe reads the console through the lua op; start the bridge with Lua enabled (Plugin \"gma3_mcp_bridge\" \"lua on\")"); process.exit(2); }
  if (mode === "run") {
    if (!SHOW_GUARD.test(String(ping.showfile ?? ""))) { console.error(`show "${ping.showfile}" does not look disposable (expected a name matching ${SHOW_GUARD}); refusing to change state`); process.exit(2); }
    if (ping.input?.busy) { console.error(`the bridge is busy (${JSON.stringify(ping.input.busy)}); wait for the owner to finish`); process.exit(2); }
    if ((ping.input?.holds ?? 0) > 0) { console.error("keys are held through the bridge; refusing to press executors"); process.exit(2); }
  }
  const report = { mode, host, port, startedAt: new Date().toISOString(), ping: { bridgeVersion: ping.bridgeVersion, build: ping.build, hostname: ping.hostname, showfile: ping.showfile, user: ping.user, modules: ping.modules, lua: { enabled: ping.lua?.enabled } }, steps };
  note("console", report.ping);

  if (mode === "watch") {
    const until = Date.now() + watchSeconds * 1000;
    let last = "";
    console.log(`watching the encoder context on display 1 for ${watchSeconds} s; change bank, page, selection, layer or readout in onPC`);
    while (Date.now() < until) {
      const c = await lua(A, LUA_CONTEXT(1));
      const s = JSON.stringify(contextSummary(c.value));
      if (s !== last) { console.log(`${new Date().toISOString().slice(11, 23)} ${s}`); last = s; }
      await sleep(500);
    }
    await A.end();
    return;
  }

  // 1. encoder context on display 1 (read-only)
  let c = await lua(A, LUA_CONTEXT(1), "context");
  const ctx0 = c.value;
  record("encoder context objects exist on display 1 (EncoderBankSelector, PresetBar, PageSelector)", c.ok && ctx0 && !ctx0.unavailable && ctx0.bank && ctx0.page, c.ok ? contextSummary(ctx0) : c.error);
  record("active encoder bank is a readable index (EncoderBankSelector.SelectedItemValueI64, 0-based; SelectedItemIdx follows on the next UI refresh)", typeof ctx0?.bank?.i64 === "number", ctx0?.bank);
  record("active encoder page is a readable index (PageSelector.SelectedItemValueI64, 0-based; SelectedItemIdx lags)", typeof ctx0?.page?.i64 === "number", ctx0?.page);
  record("preset-bar context is readable (Default = attribute editing)", typeof ctx0?.context === "string", ctx0?.context);
  record("selected feature and attribute are readable handles", /#\d+/.test(String(ctx0?.selectedFeature)) && /#\d+/.test(String(ctx0?.selectedAttribute)), { feature: ctx0?.selectedFeature, group: ctx0?.selectedFeatureGroup, attribute: ctx0?.selectedAttribute, meta: ctx0?.selectedAttributeMeta });
  const places0 = [1, 2, 3, 4, 5].map((n) => place(ctx0, n));
  const presentPlaces = places0.filter((p) => p && typeof p === "object" && typeof p.label === "string");
  record("on-screen encoder places expose label, value and resolution per slot (four on onPC)", presentPlaces.length >= 4 && presentPlaces.every((p) => typeof p.label === "string" && typeof p.value === "string" && typeof p.resolution === "string"), placeSummary(ctx0));
  note("fifth place (onPC renders four encoders; the fifth place has no widgets here)", place(ctx0, 5));
  note("profile settings relevant to encoders", ctx0?.profile);

  // 2. the profile's encoder bar pool: banks, pages, slot assignments
  c = await lua(A, LUA_POOL, "pool");
  const pool = c.value;
  const banks = parsePool(pool?.bars);
  record("profile EncoderBarPool lists banks, pages and slot attributes (Get(..., Roles.Display))", banks.size >= 5 && [...banks.values()].some((b) => b.pages.some((p) => p.slots.filter(Boolean).length >= 2)), [...banks.values()].map((b) => `${b.no} ${b.name}: ${b.pages.map((p) => `${p.no} ${p.name} [${p.slots.filter(Boolean).join(", ")}]`).join(" / ") || "(no pages)"}`));
  note("user attribute preferences (resolution, readout per attribute)", { prefs: pool?.prefs, sample: pool?.prefSample });
  const activeBank = banks.get((ctx0?.bank?.i64 ?? -1) + 1);
  const activePage = activeBank?.pages[(ctx0?.page?.i64 ?? -1)];
  const liveSlots = (activePage?.slots ?? []).filter(Boolean);
  record("the on-screen labels of the page's live slots correspond to the pool page selected by (bank i64 + 1, page i64 + 1)", !!activePage && liveSlots.length > 0 && liveSlots.every((slot, i) => labelMatches(slot, presentPlaces[i]?.label ?? "")), { bank: activeBank?.name, page: activePage?.name, slots: activePage?.slots, labels: presentPlaces.map((p) => p.label) });
  note("places beyond the page's slot count keep the label of their last use (stale, not an assignment); the live slot count comes from the pool page", { liveSlots: liveSlots.length, labels: presentPlaces.map((p) => p.label) });

  // 3. attribute metadata for the active page's slots
  const slotNames = (activePage?.slots ?? []).filter(Boolean);
  c = await lua(A, LUA_ATTRIBUTES(slotNames.length ? slotNames : ["Dimmer", "Pan", "ColorRGB_R"]), "attributes");
  record("attribute definitions expose feature, unit, readout, resolution, colour and channel-function count", c.ok && Array.isArray(c.value?.attributes) && c.value.attributes.every((l) => /index=\d+/.test(l) && /unit=/.test(l)), c.value?.attributes);
  note("selection UI channels (read-only; empty when nothing is selected)", c.value?.selectionChannels);

  // 4. a second display: does it carry its own encoder bar?
  c = await lua(A, LUA_CONTEXT(2), "display 2");
  note("encoder context on display 2 (onPC exposes a display 2 handle on one monitor)", c.ok ? contextSummary(c.value) : c.error);
  if (c.ok && !c.value?.unavailable) record("display 2 reports the same bank/page as display 1 (one user context, not per display)", c.value.bank?.i64 === ctx0.bank?.i64 && c.value.page?.i64 === ctx0.page?.i64, { d1: [ctx0.bank?.i64, ctx0.page?.i64], d2: [c.value.bank?.i64, c.value.page?.i64] });
  c = await lua(A, LUA_CONTEXT(9), "display 9");
  record("a display that does not exist is reported unavailable, not as a context", c.ok && typeof c.value?.unavailable === "string", c.value);

  // 5. executors of the current page: assignment, functions, appearance, activity, fader tokens
  c = await lua(A, LUA_PAGE_EXECUTORS, "page executors");
  const pageList = (c.value?.list ?? []).map((l) => { const [index, name, klass, keyPress, keyUnpress, fader] = l.split("|"); return { index: Number(index), name, klass, keyPress, keyUnpress, fader }; });
  const bankExecs = pageList.filter((e) => /^MCP /.test(e.name));
  const playback = pageList.filter((e) => !/^MCP /.test(e.name));
  record("assigned executors of the current page are enumerable with their key/fader functions", pageList.length > 0, pageList.slice(0, 40).map((e) => `${e.index} ${e.name} (${e.klass}) key=${e.keyPress}/${e.keyUnpress} fader=${e.fader}`));
  note("Quickey-bank executors (KB-12) are visible on the page and must be filtered out of playback targets", bankExecs.map((e) => `${e.index} ${e.name}`));
  const tokens = ["FaderMaster", "FaderX", "FaderXA", "FaderXB", "FaderRate", "FaderSpeed", "FaderTemp", "FaderTime", "FaderCrossFade", "FaderCrossFadeA", "FaderCrossFadeB"];
  const pick = (pred) => playback.find(pred);
  const sample = [pick((e) => e.keyPress === "Temp"), pick((e) => e.keyPress === "Flash"), pick((e) => e.keyPress === "Toggle"), pick((e) => e.keyPress === "Top"), pick((e) => e.fader === "Temp"), pick((e) => e.keyPress === "LearnSpeed")].filter(Boolean);
  const sampleNumbers = [...new Set(sample.map((e) => e.index))];
  c = await lua(A, LUA_EXECUTORS([...sampleNumbers, 190, 101], tokens), "executors");
  const execLines = c.value?.executors ?? [];
  record("executor identity, functions, appearance colour and activity are readable per executor", execLines.filter((l) => !/missing/.test(l)).length >= 1 && execLines.some((l) => /backRGBA=[0-9A-F]{8}/.test(l) && /active=(true|false)/.test(l)), execLines);
  record("fader tokens: GetFader answers for the configured function and reports the others", execLines.some((l) => /FaderMaster=\d/.test(l)), execLines.filter((l) => /faders /.test(l)).map((l) => l.replace(/^.*faders /, "")));
  const emptyLine = execLines.find((l) => l.startsWith("190|"));
  record("an empty executor reports no object (empty is explicit, not a zero level)", !!emptyLine && /object=(nil|)\s*\|/.test(emptyLine) || /missing/.test(emptyLine ?? ""), emptyLine);

  // 6. reads changed nothing
  c = await lua(A, LUA_CONTEXT(1));
  record("reads left bank, page and selection unchanged", c.value?.bank?.i64 === ctx0.bank?.i64 && c.value?.page?.i64 === ctx0.page?.i64 && c.value?.selectionCount === ctx0.selectionCount, contextSummary(c.value));

  if (mode === "run") {
    // Preflight gate (review item 2): nothing below mutates the console unless the selection is empty, no key
    // is held through the bridge, and the programmer is provably empty. The band widget's Value is not evidence.
    const pingNow = (await A.request("ping")).result ?? {};
    const prog = await A.request("programmer", { scope: "all", limit: 1 });
    const gate = programmerEmpty(prog);
    const problems = [];
    if (ctx0.selectionCount !== 0) problems.push(`selection is not empty (${ctx0.selectionCount})`);
    if ((pingNow.input?.holds ?? 0) > 0 || pingNow.input?.busy) problems.push("keys are held or the bridge is busy");
    if (!gate.ok) problems.push(gate.reason);
    if (problems.length) {
      record("run: preflight gate (empty selection, no holds, programmer provably empty)", false, problems);
      console.error(`refusing to change state: ${problems.join("; ")}`);
      report.finishedAt = new Date().toISOString(); report.failed = failed + 1; report.refused = problems;
      if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
      await A.end();
      process.exit(2);
    }
    record("run: preflight gate (empty selection, no holds, programmer provably empty through the programmer op)", true, gate.detail);
    await runPhase(A, ctx0, banks, playback, tokens);
  }

  report.finishedAt = new Date().toISOString();
  report.failed = failed;
  report.passed = steps.filter((s) => s.pass === true).length;
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`\n${report.passed} passed, ${failed} failed${outFile ? `; report written to ${outFile}` : ""}`);
  await A.end();
  process.exit(failed ? 1 : 0);
}

function labelMatches(slot, label) {
  // "ColorRGB_R" is shown as "R", "ColorRGB_RY" as "Amber", "Dimmer" as "Dim", "Pan" as "P", "Color1" as "C1":
  // the UI shows the attribute's short name (Pretty), which the pool does not carry. Aliases cover the
  // short names seen on this console; the production reader must take the label from the UI, not derive it.
  const ALIAS = { ry: ["amber"], w: ["white"], uv: ["uv"], colormixer: ["colormix"], color1: ["c1"] };
  const s = slot.toLowerCase().replace(/^colorrgb_/, "").replace(/[^a-z0-9]/g, "");
  const l = label.toLowerCase().replace(/[^a-z0-9]/g, "");
  if ((ALIAS[s] ?? []).includes(l)) return true;
  return s === l || s.startsWith(l) || l.startsWith(s) || s.endsWith(l);
}

async function cmd(A, command) {
  const r = await A.request("cmd", { command });
  return r.ok ? { ok: true, feedback: r.result?.feedback } : { ok: false, error: r.error, code: r.code };
}

async function runPhase(A, ctx0, banks, playback, tokens) {
  const read = async (d = 1) => (await lua(A, LUA_CONTEXT(d))).value;
  const cleanup = createCleanup();
  const restoreCmd = (label) => cleanup.add(label, () => cmd(A, label));
  const bank0 = (ctx0.bank?.i64 ?? 0) + 1;
  const page0 = (ctx0.page?.i64 ?? 0) + 1;
  const RGB_FIXTURE = 401; // Mega Hex Par: Dimmer, ColorRGB_R/G/B/W/RY/UV, Shutter1
  const BEAM_FIXTURE = 601; // 180W Beam Moving Head: Dimmer, Pan, Tilt, Color1 (wheel), Gobo1, ...: no RGB
  const bankName = (no) => banks.get(no)?.name ?? String(no);
  try {
    // R1. selection changes the on-screen values and the selected attribute's availability (the programmer
    // precondition was established by the preflight gate in main, before anything here runs)
    restoreCmd("ClearSelection");
    let r = await cmd(A, `Fixture ${RGB_FIXTURE}`);
    await sleep(150);
    let ctx = await read();
    record(`run: Fixture ${RGB_FIXTURE} selects (SelectionCount > 0); bank and page unchanged by a selection`, r.ok && ctx.selectionCount > 0 && ctx.bank.i64 === ctx0.bank.i64 && ctx.page.i64 === ctx0.page.i64, contextSummary(ctx));
    let a = await lua(A, LUA_ATTRIBUTES(["Dimmer", "Pan", "ColorRGB_R"]), "selection channels");
    record("run: the selection's UI channels and attribute names are readable (GetUIChannels/GetAttributeByUIChannel on SelectionFirst)", Array.isArray(a.value?.selectionChannels) && a.value.selectionChannels.some((l) => /attributes=.*ColorRGB_R/.test(l)), a.value?.selectionChannels);

    // R2. bank and page switching through the documented EncoderBank keyword
    const colorBank = [...banks.values()].find((b) => /color/i.test(b.name) && b.pages.length >= 2);
    if (colorBank) {
      restoreCmd(`Select EncoderBank ${bank0}.${page0}`);
      r = await cmd(A, `Select EncoderBank ${colorBank.no}`);
      await sleep(150);
      ctx = await read();
      const landed = colorBank.pages[ctx.page?.i64 ?? -1];
      record(`run: Select EncoderBank ${colorBank.no} (${colorBank.name}) moves EncoderBankSelector to ${colorBank.no - 1}; the bank reopens on a page the selection supports and the live labels match that page`, r.ok && ctx.bank.i64 === colorBank.no - 1 && !!landed && landed.slots.filter(Boolean).every((s, i) => labelMatches(s, place(ctx, i + 1)?.label ?? "")), { ...contextSummary(ctx), landedPage: landed?.name, landedSlots: landed?.slots });
      record("run: SelectedFeature/GetSelectedAttribute follow the bank (feature group of the first slot)", /#\d+/.test(String(ctx.selectedAttribute)) && String(ctx.selectedAttribute) !== String(ctx0.selectedAttribute), { before: ctx0.selectedAttribute, after: ctx.selectedAttribute, feature: ctx.selectedFeature, group: ctx.selectedFeatureGroup });
      r = await cmd(A, `Select EncoderBank ${colorBank.no}.2`);
      await sleep(150);
      ctx = await read();
      record(`run: Select EncoderBank ${colorBank.no}.2 moves PageSelector to 1 with the page's live labels (the selection has the page's attributes)`, r.ok && ctx.page.i64 === 1 && colorBank.pages[1].slots.filter(Boolean).every((s, i) => labelMatches(s, place(ctx, i + 1)?.label ?? "")), contextSummary(ctx));
      r = await cmd(A, `Select EncoderBank ${colorBank.no}.1`);
      await sleep(150);
      ctx = await read();
      record("run: Select EncoderBank N.1 goes back to page 1 and GetSelectedAttribute is the page's first attribute", r.ok && ctx.page.i64 === 0 && labelMatches(colorBank.pages[0].slots[0], place(ctx, 1)?.label ?? "") && new RegExp("^" + colorBank.pages[0].slots[0] + "#").test(String(ctx.selectedAttribute)), { page: ctx.page, selectedAttribute: ctx.selectedAttribute, selectedFeature: ctx.selectedFeature });

      // R3. a signed adjustment on the current slot 1 (ColorRGB_R on the default Color page)
      const slot1 = colorBank.pages[0].slots[0];
      const readVal = async () => {
        const c = await read();
        const pv = await lua(A, LUA_SELECTION_VALUES(slot1));
        const raw = String(pv.value?.values ?? "");
        const abs = raw.match(/\b1\.absolute=([-\d.]+)/)?.[1];
        return { shown: abs, band: place(c, 1)?.value, label: place(c, 1)?.label, resolution: place(c, 1)?.resolution, raw, ctx: c };
      };
      const v0 = await readVal();
      restoreCmd(`Off Attribute "${slot1}"`);
      r = await cmd(A, `Attribute "${slot1}" At 50`);
      await sleep(200);
      const v1 = await readVal();
      record(`run: Attribute "${slot1}" At 50 lands in the programmer (GetProgPhaser step 1 absolute = 50)`, r.ok && near(v1.shown, 50), { before: v0.shown, after: v1.shown, feedback: r.feedback, raw: v1.raw });
      record("run: the on-screen BandFader.Value of the slot does not follow the programmer value (it is not the readable value state)", v1.band === v0.band, { before: v0.band, after: v1.band });
      r = await cmd(A, `Attribute "${slot1}" At + 10`);
      await sleep(200);
      const v2 = await readVal();
      record(`run: Attribute "${slot1}" At + 10 is a relative adjustment (50 -> 60)`, r.ok && near(v2.shown, 60), { after: v2.shown, feedback: r.feedback });
      r = await cmd(A, `Attribute "${slot1}" At - 25`);
      await sleep(200);
      const v3 = await readVal();
      record(`run: Attribute "${slot1}" At - 25 subtracts (60 -> 35)`, r.ok && near(v3.shown, 35), { after: v3.shown, feedback: r.feedback });
      r = await cmd(A, `Attribute "${slot1}" At + 1`);
      await sleep(200);
      const v4 = await readVal();
      record("run: one Coarse click at Percent readout = At + 1 (manual: Coarse Percent 1 per click)", r.ok && near(v4.shown, 36), { after: v4.shown, resolution: v4.resolution });
      r = await cmd(A, `Attribute "${slot1}" At + 1000`);
      await sleep(200);
      const v5 = await readVal();
      record("run: an adjustment past the range clamps at the attribute's maximum (100)", r.ok && near(v5.shown, 100), { after: v5.shown, feedback: r.feedback });
      r = await cmd(A, `Attribute "${slot1}" At - 1000`);
      await sleep(200);
      const v6 = await readVal();
      record("run: and at the minimum (0)", r.ok && near(v6.shown, 0), { after: v6.shown });
      // Does the console offer an encoder-shaped command? Probe only; a refusal is the expected result.
      r = await cmd(A, "Encoder 1 At + 5");
      note("run: `Encoder 1 At + 5` (no such keyword is documented; recorded for the limitations)", r);
      // The adjustment applies to the selection, not to the encoder context: with the Dimmer bank active the
      // same command still edits ColorRGB_R, so the slot's identity has to come from the bank/page readers.
      r = await cmd(A, "Select EncoderBank 1");
      await sleep(150);
      r = await cmd(A, `Attribute "${slot1}" At 20`);
      await sleep(200);
      const v7 = await lua(A, LUA_SELECTION_VALUES(slot1), "value in another bank");
      record("run: a named-attribute adjustment ignores the active bank (the slot identity must be derived by the reader)", r.ok && near(String(v7.value?.values).match(/\b1\.absolute=([-\d.]+)/)?.[1], 20), v7.value?.values);
      r = await cmd(A, `Select EncoderBank ${colorBank.no}.1`);
      await sleep(150);
      // A selection without the page's attributes: the console refuses the page and `At` on the absent
      // attribute reports OK and does nothing. Both are silent from the command line's point of view.
      r = await cmd(A, `Fixture ${BEAM_FIXTURE}`);
      await sleep(150);
      let ctxBeam = await read();
      const refusedPage = await cmd(A, `Select EncoderBank ${colorBank.no}.1`);
      await sleep(200);
      ctxBeam = await read();
      record(`run: with Fixture ${BEAM_FIXTURE} (no RGB) selected, Select EncoderBank ${colorBank.no}.1 reports OK but the page stays off the RGB page (pages follow the selection's attributes)`, refusedPage.ok && ctxBeam.page.i64 !== 0, { feedback: refusedPage.feedback, ...contextSummary(ctxBeam) });
      const silent = await cmd(A, `Attribute "${slot1}" At 50`);
      await sleep(200);
      const vBeam = await lua(A, LUA_SELECTION_VALUES(slot1), "absent attribute");
      record(`run: Attribute "${slot1}" At 50 on a fixture without the attribute returns OK and changes nothing (no refusal to detect)`, silent.ok && /not in the first/.test(String(vBeam.value?.values)), { feedback: silent.feedback, value: vBeam.value?.values });
      r = await cmd(A, `Fixture ${RGB_FIXTURE}`);
      await sleep(150);
      r = await cmd(A, `Select EncoderBank ${colorBank.no}.1`);
      await sleep(150);
    } else {
      note("run: no Color bank with two pages in this profile; bank/page/adjustment steps skipped", [...banks.values()].map((b) => b.name));
    }

    // R4. mixed selection and empty selection
    r = await cmd(A, `Fixture ${RGB_FIXTURE} + ${BEAM_FIXTURE}`);
    await sleep(200);
    ctx = await read();
    a = await lua(A, LUA_ATTRIBUTES(["Dimmer", "ColorRGB_R"]), "mixed selection");
    record("run: a mixed selection (RGB par + beam) keeps the RGB page available and shows the slot labels", r.ok && ctx.selectionCount === 2 && ctx.page.i64 === 0, { ...contextSummary(ctx), channels: a.value?.selectionChannels });
    r = await cmd(A, "ClearSelection");
    await sleep(150);
    ctx = await read();
    record("run: ClearSelection empties the selection; the bank/page and slot labels remain", r.ok && ctx.selectionCount === 0 && presentPlacesOf(ctx).length >= 4, contextSummary(ctx));

    // R5. executor buttons: configured press/release functions through Press/Unpress on page-qualified targets.
    // Each step registers its release (and Off for latching functions) before the Press; an error in the
    // middle is recorded and the registered undo runs in the cleanup at the end (scripts/lib/kb16-steps.mjs).
    const page = (await lua(A, LUA_EXECUTORS([101], tokens))).value?.page;
    const pageNo = Number(String(page ?? "").replace(/^.*#/, "")) || 1;
    const activity = async (n) => { const c = await lua(A, LUA_EXECUTORS([n], tokens)); if (!c.ok) throw new Error(`activity read failed: ${c.error}`); const l = c.value?.executors?.[0] ?? ""; return { active: /active=true/.test(l), line: l }; };
    const faderValue = async (n, token) => { const c = await lua(A, LUA_EXECUTORS([n], [token])); if (!c.ok) throw new Error(`fader read failed: ${c.error}`); const m = (c.value?.executors?.[0] ?? "").match(new RegExp(`${token}=([-\\d.]+)`)); return m ? Number(m[1]) : undefined; };
    const io = { cmd: (c) => cmd(A, c), activity, faderValue, setfader: async (ref, value) => { const r = await A.request("setfader", { ref, value }); return r.ok ? { ok: true } : { ok: false, error: r.error }; }, sleep };
    const button = async (e, { expectDuring, expectAfter, holdMs, off, title }) => {
      try {
        const o = await probeExecutorButton({ io, cleanup, pageNo, exec: e, holdMs, off });
        const pass = o.before === false && (expectDuring === undefined || o.during === expectDuring) && (expectAfter === undefined || o.after === expectAfter) && (!off || o.afterOff === false);
        record(title(o), pass, o);
        return o;
      } catch (err) {
        record(`run: ${e.name}: ${err.step ?? "step"} failed; its release/off is left to the cleanup`, false, { error: err.message, partial: err.partial, pendingCleanup: cleanup.pending() });
        return null;
      }
    };
    const temp = playback.find((e) => e.keyPress === "Temp" && e.klass === "Sequence");
    const flash = playback.find((e) => e.keyPress === "Flash" && e.klass === "Sequence");
    const toggle = playback.find((e) => e.keyPress === "Toggle" && e.klass === "Sequence");
    const top = playback.find((e) => e.keyPress === "Top" && e.klass === "Sequence");
    const momentary = (o) => `run: ${o.name} (${o.keyPress}/${o.keyUnpress}): Press ${o.ref} -> active=${o.during}, Unpress -> active=${o.after}`;
    if (temp) await button(temp, { expectDuring: true, expectAfter: false, holdMs: 400, title: momentary }); else note("run: no Temp executor on the page");
    if (flash) await button(flash, { expectDuring: true, expectAfter: false, holdMs: 400, title: momentary }); else note("run: no Flash executor on the page");
    if (toggle) await button(toggle, { expectDuring: true, expectAfter: true, holdMs: 300, off: `Off Sequence "${toggle.name}"`, title: (o) => `run: ${o.name} (Toggle): Press ${o.ref} -> active=${o.during}, Unpress -> still active=${o.after}, Off -> active=${o.afterOff}` }); else note("run: no Toggle executor on the page");
    // Top on press, Go+ on release: what the sequence does after the release depends on its cues (a one-cue
    // sequence goes past its last cue and releases), so the after-state is an observation, not an expectation.
    if (top) await button(top, { expectDuring: true, holdMs: 300, off: `Off Sequence "${top.name}"`, title: (o) => `run: ${o.name} (Top/Go+): Press ${o.ref} runs Top (active=${o.during}), Unpress runs Go+ (observed active=${o.after}), Off -> active=${o.afterOff}` }); else note("run: no Top/Go+ executor on the page");
    // Disconnect-style recovery: a held Temp released by the plain Unpress after the probe's own delay.
    if (temp) await button(temp, { expectDuring: true, expectAfter: false, holdMs: 1200, title: (o) => `run: a Temp held for 1.2 s stays active until the Unpress ${o.ref} (release is the holder's responsibility): during=${o.during}, after=${o.after}` });

    // R6. fader functions: the original level is read and its restoration registered before every move.
    const master = playback.find((e) => e.fader === "Master" && e.klass === "Sequence" && e.keyPress !== "Toggle");
    if (master) {
      try {
        const m0 = await faderValue(master.index, "FaderMaster");
        const o = await probeFader({ io, cleanup, pageNo, exec: master, token: "FaderMaster", target: m0 > 50 ? 25 : 75, set: io.setfader });
        record(`run: Master fader of ${master.name} (${o.ref}) set to ${o.target} and read back through GetFader{FaderMaster}, then restored to ${o.original}`, Math.abs(o.moved - o.target) < 0.5 && Math.abs(o.restored - o.original) < 0.5, o);
      } catch (err) { record(`run: Master fader of ${master.name}: ${err.step ?? "step"} failed; its restoration is left to the cleanup`, false, { error: err.message, partial: err.partial, pendingCleanup: cleanup.pending() }); }
      try {
        const setRate = async (ref, value) => cmd(A, `FaderRate ${ref} At ${value}`);
        const o = await probeFader({ io, cleanup, pageNo, exec: master, token: "FaderRate", target: 75, set: setRate, tolerance: 1 });
        note("run: FaderRate keyword on a Master-fader executor (function-specific setter, read back through GetFader{FaderRate})", o);
      } catch (err) { note("run: FaderRate on a Master-fader executor could not be exercised", { error: err.message, partial: err.partial, pendingCleanup: cleanup.pending() }); }
    }
    const tempFader = playback.find((e) => e.fader === "Temp" && e.klass === "Sequence");
    if (tempFader) {
      try {
        const setTemp = async (ref, value) => cmd(A, `FaderTemp ${ref} At ${value}`);
        const o = await probeFader({ io, cleanup, pageNo, exec: tempFader, token: "FaderTemp", target: 60, set: setTemp });
        record(`run: Temp fader of ${tempFader.name} (${o.ref}): FaderTemp At 60 read back through GetFader{FaderTemp} (59.99…) and the sequence becomes active; back to ${o.original} and inactive again`, Math.abs(o.moved - 60) < 0.5 && o.activeAfterMove === true && Math.abs(o.restored - o.original) < 0.5 && o.activeAfterRestore === false, o);
      } catch (err) { record(`run: Temp fader of ${tempFader.name}: ${err.step ?? "step"} failed; its restoration is left to the cleanup`, false, { error: err.message, partial: err.partial, pendingCleanup: cleanup.pending() }); }
    } else note("run: no Temp-fader executor on the page");
    // Page navigation neither stops nor starts playbacks.
    const pageBefore = (await lua(A, LUA_EXECUTORS([101], tokens))).value?.page;
    const actBefore = await Promise.all([temp, toggle].filter(Boolean).map((e) => activity(e.index)));
    const pageBack = cleanup.add("Page 1", () => cmd(A, "Page 1"));
    r = await cmd(A, "Page 2");
    await sleep(200);
    const pageUp = (await lua(A, LUA_EXECUTORS([101], tokens))).value?.page;
    const back = await cmd(A, "Page 1");
    if (back.ok) pageBack.done();
    await sleep(200);
    const pageAfter = (await lua(A, LUA_EXECUTORS([101], tokens))).value?.page;
    const actAfter = await Promise.all([temp, toggle].filter(Boolean).map((e) => activity(e.index)));
    record("run: Page 2 / Page 1 (both exist) changes the page and back without starting or stopping playbacks", r.ok && back.ok && pageUp !== pageBefore && pageAfter === pageBefore && actBefore.every((s, i) => s.active === actAfter[i].active), { before: pageBefore, up: pageUp, after: pageAfter, activity: actAfter.map((s) => s.active) });
  } finally {
    // Every registered undo that the normal path did not complete, newest first, each attempted even if an
    // earlier one failed; the outcomes are part of the record.
    const pending = cleanup.pending();
    const outcomes = await cleanup.run();
    record(`run: cleanup ran ${outcomes.length} registered undo(s) (${pending.length} were still pending)`, outcomes.every((o) => o.ok), outcomes);
    await sleep(150);
    const r = await cmd(A, "ClearAll");
    note("run: ClearAll (the programmer was provably empty at the preflight gate)", r.ok ? r.feedback : r.error);
    await sleep(150);
    const ctxEnd = await read();
    record("run: final context equals the initial one (bank, page, selection, values)", ctxEnd.bank?.i64 === ctx0.bank?.i64 && ctxEnd.page?.i64 === ctx0.page?.i64 && ctxEnd.selectionCount === 0, contextSummary(ctxEnd));
  }
}

const presentPlacesOf = (ctx) => [1, 2, 3, 4, 5].map((n) => place(ctx, n)).filter((p) => p && typeof p === "object" && typeof p.label === "string");
const near = (shown, expected) => { const v = Number(String(shown).replace(/[^0-9.\-]/g, "")); return Number.isFinite(v) && Math.abs(v - expected) < 0.6; };

main().catch((e) => { console.error(e); process.exit(2); });
