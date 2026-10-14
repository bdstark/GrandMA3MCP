import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BUILD_INFO_FILE, ServerBuild, hashSources, readBuildStamp, writeBuildStamp } from "../src/buildinfo.ts";

/** A checkout with src/, the extra inputs and an empty dist/, plus the module URL of its built server. */
function checkout(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gma3-build-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src", "tools"), { recursive: true });
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(root, "src", "tools", "patch.ts"), "export const b = 2;\n");
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}\n");
  fs.writeFileSync(path.join(root, "tsconfig.json"), "{}\n");
  const moduleUrl = pathToFileURL(path.join(root, "dist", "buildinfo.js")).href;
  return { root, moduleUrl };
}

test("the source hash covers src/** and the build inputs, not other files", (t) => {
  const { root } = checkout(t);
  const base = hashSources(root);
  assert.match(base ?? "", /^[0-9a-f]{64}$/);

  fs.writeFileSync(path.join(root, "README.md"), "docs only\n");
  fs.mkdirSync(path.join(root, "plugin"));
  fs.writeFileSync(path.join(root, "plugin", "bridge.lua"), "-- console side\n");
  assert.equal(hashSources(root), base, "docs and plugin changes do not need a server rebuild");

  fs.writeFileSync(path.join(root, "src", "tools", "groups.ts"), "export const c = 3;\n");
  const withNewTool = hashSources(root);
  assert.notEqual(withNewTool, base, "a new source file changes the hash");

  fs.writeFileSync(path.join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  assert.notEqual(hashSources(root), withNewTool, "a dependency change changes the hash");
});

test("no src/ means nothing to hash", (t) => {
  const { root } = checkout(t);
  fs.rmSync(path.join(root, "src"), { recursive: true });
  assert.equal(hashSources(root), null);
});

test("a build made from the current source is current", (t) => {
  const { root, moduleUrl } = checkout(t);
  const stamp = writeBuildStamp(root);
  assert.deepEqual(readBuildStamp(path.join(root, "dist")), stamp);
  assert.equal(stamp.commit, null, "the temp checkout is not a git repository");
  const check = new ServerBuild(moduleUrl).check();
  assert.equal(check.state, "current");
  assert.equal(check.action, undefined);
});

test("pulling new source without rebuilding is stale and says to rebuild", (t) => {
  const { root, moduleUrl } = checkout(t);
  writeBuildStamp(root);
  const build = new ServerBuild(moduleUrl);
  fs.writeFileSync(path.join(root, "src", "tools", "groups.ts"), "export const c = 3;\n");
  const check = build.check();
  assert.equal(check.state, "stale");
  assert.match(check.reason, /source checkout changed after this build/);
  assert.match(check.action ?? "", /npm ci && npm run build/);
  assert.ok(check.action?.includes(root), "the action names the checkout to rebuild");
});

test("rebuilding without restarting is stale and says to restart", (t) => {
  const { root, moduleUrl } = checkout(t);
  writeBuildStamp(root);
  const build = new ServerBuild(moduleUrl);
  fs.writeFileSync(path.join(root, "src", "tools", "groups.ts"), "export const c = 3;\n");
  writeBuildStamp(root);
  const check = build.check();
  assert.equal(check.state, "stale");
  assert.match(check.reason, /still runs the previous build/);
  assert.match(check.action ?? "", /restart the MCP client/);
  assert.doesNotMatch(check.action ?? "", /npm run build/);
});

test("a build without a stamp is unverified and says to rebuild with npm run build", (t) => {
  const { moduleUrl } = checkout(t);
  const check = new ServerBuild(moduleUrl).check();
  assert.equal(check.state, "unverified");
  assert.match(check.reason, new RegExp(BUILD_INFO_FILE));
  assert.match(check.action ?? "", /npm run build/);
});

test("a package or container install without src/ is unverified and asks for nothing", (t) => {
  const { root, moduleUrl } = checkout(t);
  writeBuildStamp(root);
  fs.rmSync(path.join(root, "src"), { recursive: true });
  const check = new ServerBuild(moduleUrl).check();
  assert.equal(check.state, "unverified");
  assert.equal(check.action, undefined);
});

test("running from TypeScript source has no build to go stale", (t) => {
  const { root } = checkout(t);
  const check = new ServerBuild(pathToFileURL(path.join(root, "src", "buildinfo.ts")).href).check();
  assert.equal(check.state, "current");
});
