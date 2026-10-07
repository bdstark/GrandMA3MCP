import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Manual lookup against a fixture directory pointed to by GMA3_HELP_DIR.
 * help.ts caches the directory on first use, so the fixture is built and the
 * environment set before the module is imported.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gma3-help-"));
const manual = path.join(tmp, "manual");
const outside = path.join(tmp, "outside");
fs.mkdirSync(manual);
fs.mkdirSync(outside);

function page(title: string, body: string): string {
  return (
    `<html><head><title>${title} - grandMA3</title><script>var articleTitleText='${title}';</script>` +
    `<style>.x{}</style></head><body><div>nav &gt; links</div><p>grandMA3 User Manual Publication</p>` +
    `<h1>${title}</h1><p>${body}</p></body></html>`
  );
}
const write = (dir: string, name: string, content: string) => fs.writeFileSync(path.join(dir, name), content);

write(manual, "keyword_store.html", page("Store", "Store keyword body &amp; details"));
write(manual, "keyword_atplus.html", page("At+", "At plus body"));
write(manual, "keyword_gominus.html", page("Go-", "Go minus body"));
write(manual, "cue_timing.html", page("Cue Timing", "timing body"));
write(manual, "cue_tracking.html", page("Cue Tracking", "tracking body"));
write(manual, "notes.txt", "not a page");
write(outside, "secret.html", page("Secret", "must never be served"));
// A link inside the manual folder that leads outside it must be ignored...
fs.symlinkSync(path.join(outside, "secret.html"), path.join(manual, "keyword_secret.html"));
// ...while a link that stays inside the folder is fine.
fs.symlinkSync(path.join(manual, "keyword_store.html"), path.join(manual, "keyword_alias.html"));
// A dangling link must not break listing or lookup.
fs.symlinkSync(path.join(manual, "missing.html"), path.join(manual, "dangling.html"));

process.env.GMA3_HELP_DIR = manual;
delete process.env.GMA3_INSTALL_DIR;
const { helpDir, helpVersion, htmlToText, listHelpPages, lookupHelp } = await import("../src/help.ts");

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("helpDir honours GMA3_HELP_DIR and helpVersion is null without a versioned path", () => {
  assert.equal(helpDir(), manual);
  assert.equal(helpVersion(), null);
});

test("path-like topics are refused before touching the file system", () => {
  for (const topic of ["../outside/secret", "..\\outside\\secret", "sub/page", "keyword_store/", "a\0b"]) {
    const res = lookupHelp(topic);
    assert.match(res.error ?? "", /not a path/, `topic ${JSON.stringify(topic)}`);
    assert.equal(res.text, undefined);
    assert.equal(res.matches, undefined);
  }
});

test("keyword page is found and rendered as text without the navigation header", () => {
  const res = lookupHelp("Store");
  assert.equal(res.page, "keyword_store.html");
  assert.match(res.text ?? "", /Store keyword body & details/);
  assert.doesNotMatch(res.text ?? "", /nav > links/);
  assert.doesNotMatch(res.text ?? "", /articleTitleText/);
});

test("topic normalisation: .html suffix, + and trailing -", () => {
  assert.equal(lookupHelp("keyword_store.html").page, "keyword_store.html");
  assert.equal(lookupHelp("At+").page, "keyword_atplus.html");
  assert.equal(lookupHelp("Go-").page, "keyword_gominus.html");
});

test("a symlink that escapes the manual folder is neither served nor listed", () => {
  const res = lookupHelp("secret");
  assert.equal(res.page, undefined);
  assert.equal(res.text, undefined);
  assert.deepEqual(res.matches, []);
  assert.ok(!listHelpPages().some((p) => p.file === "keyword_secret.html"));
});

test("a symlink that stays inside the manual folder is served", () => {
  const res = lookupHelp("alias");
  assert.equal(res.page, "keyword_alias.html");
  assert.match(res.text ?? "", /Store keyword body/);
});

test("a dangling symlink is ignored", () => {
  assert.deepEqual(lookupHelp("dangling").matches, []);
  assert.ok(!listHelpPages().some((p) => p.file === "dangling.html"));
});

test("listHelpPages lists only .html pages with their article titles", () => {
  const pages = listHelpPages();
  const files = pages.map((p) => p.file).sort();
  assert.deepEqual(files, ["cue_timing.html", "cue_tracking.html", "keyword_alias.html", "keyword_atplus.html", "keyword_gominus.html", "keyword_store.html"]);
  assert.equal(pages.find((p) => p.file === "cue_timing.html")?.title, "Cue Timing");
});

test("substring search returns matches, and a single match resolves to the page", () => {
  const many = lookupHelp("cue");
  assert.equal(many.page, undefined);
  assert.deepEqual(many.matches?.map((p) => p.file).sort(), ["cue_timing.html", "cue_tracking.html"]);
  const one = lookupHelp("tracking");
  assert.equal(one.page, "cue_tracking.html");
  assert.match(one.text ?? "", /tracking body/);
  const words = lookupHelp("cue timing");
  assert.equal(words.page, "cue_timing.html");
  assert.deepEqual(lookupHelp("no such thing at all").matches, []);
});

test("long pages are truncated at maxChars", () => {
  const res = lookupHelp("store", 10);
  assert.ok(res.text?.endsWith("\n…(truncated)"));
  assert.equal(res.text?.length, 10 + "\n…(truncated)".length);
});

test("htmlToText strips markup, decodes entities and formats lists", () => {
  const txt = htmlToText("<script>x()</script><style>a{}</style><ul><li>one &amp; two</li><li>three&nbsp;four</li></ul><p>a<br>b</p>");
  assert.equal(txt, "- one & two\n- three four\na\nb");
});
