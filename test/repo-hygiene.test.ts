import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

/** Tracked files, or null outside a git checkout (an unpacked tarball), where the check does not apply. */
function tracked(...paths: string[]): string[] | null {
  try {
    return execFileSync("git", ["ls-files", "--", ...paths], { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

test("no local dependency setup is tracked: node_modules (directory or symlink) is never committed", (t) => {
  const files = tracked("node_modules");
  if (files === null) return t.skip("not a git checkout");
  assert.deepEqual(files, [], "node_modules is a local artifact: install from package-lock.json in each checkout");
});

test("the ignore rule covers node_modules as a symlink, not only as a directory", (t) => {
  let ignored: boolean;
  try {
    execFileSync("git", ["check-ignore", "-q", "--no-index", "node_modules"]);
    ignored = true;
  } catch (err) {
    if ((err as { status?: number }).status === 1) ignored = false;
    else return t.skip("git check-ignore unavailable");
  }
  assert.equal(ignored, true, ".gitignore must say node_modules (no trailing slash): node_modules/ does not match a symlink");
});
