import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Manual discovery through GMA3_INSTALL_DIR: the newest gma3_<version> folder wins, and the
 * symlink check in help.ts resolves the manual root itself as well as the pages inside it.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gma3-install-"));
const realHtml = path.join(tmp, "real-html");
const outside = path.join(tmp, "outside");
fs.mkdirSync(realHtml);
fs.mkdirSync(outside);
for (const v of ["gma3_2.4.2", "gma3_2.10.0", "gma3_library"]) fs.mkdirSync(path.join(tmp, v, "shared", "language"), { recursive: true });
fs.mkdirSync(path.join(tmp, "gma3_2.4.2", "shared", "language", "HTML"));
fs.writeFileSync(path.join(tmp, "gma3_2.4.2", "shared", "language", "HTML", "keyword_old.html"), "<html><body>old</body></html>");
// The newest version's manual folder is itself a symlink to a directory elsewhere.
fs.symlinkSync(realHtml, path.join(tmp, "gma3_2.10.0", "shared", "language", "HTML"));
fs.writeFileSync(path.join(realHtml, "keyword_store.html"), "<html><body><p>User Manual Publication</p><p>store via linked root</p></body></html>");
fs.writeFileSync(path.join(outside, "secret.html"), "<html><body>secret</body></html>");
fs.symlinkSync(path.join(outside, "secret.html"), path.join(realHtml, "keyword_secret.html"));

delete process.env.GMA3_HELP_DIR;
process.env.GMA3_INSTALL_DIR = tmp;
const { helpDir, helpVersion, listHelpPages, lookupHelp } = await import("../src/help.ts");

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("the highest numeric version is chosen (2.10 sorts after 2.4)", () => {
  assert.equal(helpDir(), path.join(tmp, "gma3_2.10.0", "shared", "language", "HTML"));
  assert.equal(helpVersion(), "2.10.0");
});

test("pages resolve through a symlinked manual root", () => {
  const res = lookupHelp("store");
  assert.equal(res.page, "keyword_store.html");
  assert.match(res.text ?? "", /store via linked root/);
  assert.deepEqual(listHelpPages().map((p) => p.file), ["keyword_store.html"]);
});

test("an escaping symlink is still rejected under a symlinked root", () => {
  const res = lookupHelp("secret");
  assert.equal(res.text, undefined);
  assert.deepEqual(res.matches, []);
});
