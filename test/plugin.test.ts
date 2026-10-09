import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * Runs the Lua harness for plugin/gma3_mcp_bridge.lua (execution budget, sandbox hardening,
 * argument parsing) under a stock Lua interpreter. Skipped when none is installed.
 */

const root = path.resolve(import.meta.dirname, "..");
const harness = path.join("test", "lua", "bridge_plugin_test.lua");
const modulesHarness = path.join("test", "lua", "modules_test.lua");

function findLua(): string | null {
  for (const bin of ["lua5.4", "lua54", "lua"]) {
    const r = spawnSync(bin, ["-v"], { encoding: "utf8" });
    if (r.error) continue;
    const banner = `${r.stdout}${r.stderr}`;
    const m = banner.match(/Lua (\d+)\.(\d+)/);
    if (m && (Number(m[1]) > 5 || (Number(m[1]) === 5 && Number(m[2]) >= 4))) return bin;
  }
  return null;
}

const lua = findLua();

test("bridge plugin Lua harness", { skip: lua ? false : "no Lua 5.4+ interpreter on PATH (install lua to run the plugin tests)" }, () => {
  const r = spawnSync(lua!, [harness], { cwd: root, encoding: "utf8" });
  const output = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, `harness failed:\n${output}`);
  assert.match(output, /ALL PASSED/, output);
  assert.doesNotMatch(output, /^FAIL /m, output);
});

test("console interaction modules Lua harness", { skip: lua ? false : "no Lua 5.4+ interpreter on PATH (install lua to run the module tests)" }, () => {
  const r = spawnSync(lua!, [modulesHarness], { cwd: root, encoding: "utf8" });
  const output = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, `harness failed:\n${output}`);
  assert.match(output, /ALL PASSED/, output);
  assert.doesNotMatch(output, /^FAIL /m, output);
});
