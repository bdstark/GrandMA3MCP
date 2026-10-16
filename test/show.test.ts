/**
 * SU-20: gma3_show_files and gma3_save_show against an in-process FakeBridge.
 *
 * `FakeConsole` models SaveShow as probed on onPC 2.5.1: the command is queued (CmdIndirect) and lands on the next
 * read; the current name saves at once; a new name opens "Change show file name?"; another existing file opens
 * "Change show file name and overwrite existing show file?"; OK writes the file and makes its name current.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { OVERWRITE_TITLE, RENAME_TITLE, registerShowTools, showName } from "../src/tools/show.ts";

/** The console's messages as probed live (whitespace collapsed); kept here, independent of the code under test. */
const squash = (t: string) => t.replace(/\s+/g, " ").trim();
const DIALOG_TEXT: Record<string, (n: string) => string> = {
  [RENAME_TITLE]: (n) => `Do you intend to change the show file name to '${n}'?`,
  [OVERWRITE_TITLE]: (n) => `You are going to change the show file name and overwrite the file with the name '${n}' that already exists. Do you want to continue ?`,
};
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { SILENT } from "./helpers/fake-bridge.ts";

type File = { size: number; time: number };

class FakeConsole {
  now = 1792146000;
  current = "Show A";
  files = new Map<string, File>([
    ["Show A", { size: 1000, time: 1792140000 }],
    ["Other", { size: 2000, time: 1792130000 }],
  ]);
  modal: { title: string; text: string; target: string } | null = null;
  foreignModal: string | null = null;
  pending: string | null | undefined;
  /** The console takes SaveShow but writes nothing (a failed save). */
  writeNothing = false;
  /** No dialog ever appears for a new name (and nothing is written). */
  noDialog = false;
  saves: string[] = [];
  modalUnknown = false;

  write(name: string) {
    if (this.writeNothing) return;
    this.now += 1;
    const key = [...this.files.keys()].find((k) => k.toLowerCase() === name.toLowerCase()) ?? name;
    this.files.delete(key);
    this.files.set(name, { size: 1500, time: this.now });
    this.current = name;
  }
  /** A queued SaveShow lands on a later frame (here: the next read). */
  land() {
    if (this.pending === undefined) return;
    const name = this.pending ?? this.current;
    this.pending = undefined;
    if (name.toLowerCase() === this.current.toLowerCase()) return this.write(name);
    if (this.noDialog) return;
    const exists = [...this.files.keys()].some((k) => k.toLowerCase() === name.toLowerCase());
    // The console's own messages (live), line breaks included.
    this.modal = exists
      ? { title: OVERWRITE_TITLE, text: `You are going to change the show file name and overwrite the file with the name\n'${name}' that already exists.\nDo you want to continue ?`, target: name }
      : { title: RENAME_TITLE, text: `Do you intend to change the show file name to\n'${name}'?`, target: name };
  }
  install(h: Harness) {
    h.fake.on("show.files", () => {
      this.land();
      this.now += 0; // time advances only with writes
      const modal = this.foreignModal ? { class: "MessageBox", name: "MsgBox", title: this.foreignModal, buttons: ["Yes", "No"] } : this.modal ? { class: "MessageBox", name: "MsgBox", title: this.modal.title, text: this.modal.text, buttons: ["OK", "Cancel"], display: 1 } : false;
      return {
        current: this.current,
        path: "/shows",
        listed: true,
        files: [...this.files].map(([name, f]) => ({ name, file: `${name}.show`, size: f.size, time: f.time, localTime: `wall ${f.time}` })),
        now: this.now,
        localNow: `wall ${this.now}`,
        modal,
        ...(this.modalUnknown ? { modalKnown: false, modalError: "GetTopModal failed" } : { modalKnown: true }),
      };
    });
    h.fake.on("show.save", (args) => {
      assert.equal(args.exclusive, true);
      if (this.modal || this.foreignModal) throw new Error("[modal-open] a dialog is open on the console; SaveShow was not sent");
      this.pending = (args.name as string | undefined) ?? null;
      const command = args.name ? `SaveShow "${args.name}"` : "SaveShow";
      this.saves.push(command);
      return { queued: true, command, now: this.now };
    });
    h.fake.on("show.answer", (args) => {
      if (!this.modal) throw new Error("[no-modal] no dialog is open");
      if (args.expectTitle !== this.modal.title) throw new Error("[wrong-modal]");
      // As the bridge does: the whole message must be the one for the expected target (not the fake's own field).
      if (squash(this.modal.text) !== DIALOG_TEXT[this.modal.title](String(args.expectTarget))) throw new Error("[wrong-target]");
      const target = this.modal.target;
      this.modal = null;
      if (args.button === "OK") this.write(target);
      return { clicked: args.button, title: args.expectTitle, display: 1 };
    });
  }
}

let h: Harness;
let con: FakeConsole;
before(async () => {
  h = await startHarness(registerShowTools, { requestTimeoutMs: 2000 });
});
after(() => h.close());
beforeEach(() => {
  h.fake.reset();
  con = new FakeConsole();
  con.install(h);
});
const sent = () => h.fake.requests.filter((r) => r.op === "show.save" || r.op === "show.answer").map((r) => `${r.op}${r.args.name ? ` ${r.args.name}` : ""}${r.args.button ? ` ${r.args.button}` : ""}`);

test("gma3_show_files: the current show, newest first, ISO and console wall-clock times", async () => {
  const r = await h.callJson("gma3_show_files", {});
  assert.equal(r.isError, false, r.text);
  assert.equal(r.result.current, "Show A");
  assert.deepEqual(r.result.files.map((f: { name: string }) => f.name), ["Show A", "Other"]);
  assert.equal(r.result.files[0].time, new Date(1792140000 * 1000).toISOString());
  assert.equal(r.result.files[0].localTime, "wall 1792140000");
  assert.equal(r.result.currentFile.size, 1000);
  h.fake.on("show.files", () => {
    throw new Error("unknown op 'show.files'");
  });
  const old = await h.callJson("gma3_show_files", {});
  assert.equal(old.isError, true);
  assert.match(old.text, /bridge 0\.35\.0/);
});

test("save_show under the current name: plain SaveShow, no dialog, the file reported", async () => {
  const r = await h.callJson("gma3_save_show", { exclusive: true });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.result.verification.status, "matched");
  assert.deepEqual(con.saves, ["SaveShow"]);
  assert.equal(r.result.file.size, 1500);
  assert.equal(r.result.file.name, "Show A");
  assert.match(r.result.summary, /^Saved Show A\.show \(1500 bytes/);
  assert.equal(r.result.dialog, "none (the current name saves without a dialog)");
  assert.deepEqual(r.result.warnings ?? [], []);
});

test("save_show under a new name answers 'Change show file name?' and reports the new current show", async () => {
  const r = await h.callJson("gma3_save_show", { name: "Show B.show", exclusive: true });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.result.verification.status, "matched");
  assert.deepEqual(sent(), ["show.save Show B", "show.answer OK"]);
  assert.equal(con.current, "Show B");
  assert.deepEqual(r.result.dialog, { expected: RENAME_TITLE, answered: true });
  assert.ok(r.result.warnings.some((w: string) => /current show is now Show B/.test(w)));
  assert.match(r.result.summary, /current show is now Show B \(was Show A\)/);
});

test("save_show refuses another show's existing file without overwrite (case-insensitive); with it, answers the overwrite dialog", async () => {
  const refused = await h.callJson("gma3_save_show", { name: "other", exclusive: true });
  assert.equal(refused.result.outcome, "failed");
  assert.match(String(refused.result.steps.at(-1).error), /"Other" is another show's file \(2000 bytes.*overwrite: true/);
  assert.deepEqual(sent(), []);
  const r = await h.callJson("gma3_save_show", { name: "Other", overwrite: true, exclusive: true });
  assert.equal(r.result.verification.status, "matched", r.text);
  assert.deepEqual(r.result.dialog, { expected: OVERWRITE_TITLE, answered: true });
  assert.equal(r.result.previous.file.size, 2000);
  assert.match(r.result.summary, /replaced the earlier Other\.show/);
});

test("save_show refuses while a dialog is open, and never answers a dialog it does not expect", async () => {
  con.foreignModal = "Leaving the patch";
  const busy = await h.callJson("gma3_save_show", { exclusive: true });
  assert.equal(busy.result.outcome, "failed");
  assert.match(busy.text, /a dialog is open on the console \(Leaving the patch\)/);
  assert.deepEqual(sent(), []);
  // A foreign dialog that opens after the save is queued.
  con.foreignModal = null;
  h.fake.on("show.save", (args) => {
    con.foreignModal = "Something else";
    return { queued: true, command: `SaveShow "${args.name}"`, now: con.now };
  });
  const r = await h.callJson("gma3_save_show", { name: "New", exclusive: true });
  assert.equal(r.result.verification.status, "unavailable");
  assert.match(r.text, /unexpected dialog \(Something else\) is open; it was not answered: answer it at the console/);
  assert.ok(!h.fake.requests.some((x) => x.op === "show.answer"));
});

test("save_show: no dialog and no file within the timeout is unavailable; a save that writes nothing is mismatched", async () => {
  con.noDialog = true;
  const r = await h.callJson("gma3_save_show", { name: "Never", exclusive: true, timeout_ms: 2000 });
  assert.equal(r.result.verification.status, "unavailable");
  assert.match(r.text, /did not appear within 2000 ms/);
  con.noDialog = false;
  con.writeNothing = true;
  const m = await h.callJson("gma3_save_show", { exclusive: true, timeout_ms: 2000 });
  assert.equal(m.result.verification.status, "mismatched");
  assert.match(m.result.verification.detail, /still carries its earlier time/);
});

test("save_show validation: exclusive, names, overwrite and timeout", async () => {
  for (const [args, re] of [
    [{}, /exclusive must be true/],
    [{ name: 'a"b', exclusive: true }, /without quotes/],
    [{ name: "../x", exclusive: true }, /slashes/],
    [{ name: " x", exclusive: true }, /leading or trailing spaces/],
    [{ timeout_ms: 10, exclusive: true }, /timeout_ms/],
  ] as Array<[Record<string, unknown>, RegExp]>) {
    const r = await h.callJson("gma3_save_show", args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.result.validationErrors.join(" "), re, JSON.stringify(args));
  }
  // A wrong type is refused by the schema before the tool runs.
  const typed = await h.callJson("gma3_save_show", { overwrite: "yes", exclusive: true });
  assert.equal(typed.isError, true);
  assert.match(typed.text, /overwrite/);
  assert.equal(h.fake.requests.length, 0);
  assert.equal(showName("Show C.show"), "Show C");
});

// --- review of PR #66 -----------------------------------------------------------------------------

test("review 1: an unchanged file from the current second is not proof; the tool waits for a later second", async () => {
  con.files.get("Show A")!.time = con.now;
  con.writeNothing = true;
  const r = await h.callJson("gma3_save_show", { exclusive: true, timeout_ms: 2000 });
  assert.notEqual(r.result.verification.status, "matched", r.text);
  assert.equal(r.result.summary.startsWith("Saved"), false);
  con.writeNothing = false;
  const t0 = Date.now();
  const ok = await h.callJson("gma3_save_show", { exclusive: true });
  assert.equal(ok.result.verification.status, "matched", ok.text);
  assert.ok(Date.now() - t0 >= 1000, "it waited for the console's clock to pass the old file's second");
  assert.ok(con.files.get("Show A")!.time > 1792146000);
});

test("review 1: a same-title dialog naming another show is never answered", async () => {
  // A pending save of Show A surfaces as an overwrite dialog while this call saves Other.
  h.fake.on("show.save", () => {
    con.modal = { title: OVERWRITE_TITLE, text: "You are going to change the show file name and overwrite the file with the name\n'Show A' that already exists.\nDo you want to continue ?", target: "Show A" };
    return { queued: true, command: 'SaveShow "Other"', now: con.now };
  });
  const before = { ...con.files.get("Show A")! };
  const r = await h.callJson("gma3_save_show", { name: "Other", overwrite: true, exclusive: true });
  assert.equal(r.result.verification.status, "unavailable");
  assert.match(r.text, /dialog for another show is open; it was not answered/);
  assert.ok(!h.fake.requests.some((x) => x.op === "show.answer"), "nothing was clicked");
  assert.deepEqual(con.files.get("Show A"), before);
  assert.equal(con.files.get("Other")!.size, 2000);
});

test("review 1: a lost reply to SaveShow is watched, never resent, and never called 'not queued'", async () => {
  // The save went out and lands, but its reply is lost.
  h.fake.on("show.save", (args) => {
    con.pending = (args.name as string | undefined) ?? null;
    return SILENT;
  });
  const landed = await h.callJson("gma3_save_show", { exclusive: true });
  assert.equal(landed.result.verification.status, "matched", landed.text);
  assert.ok(landed.result.warnings.some((w: string) => /reply to SaveShow was lost: it was not resent/.test(w)));
  assert.equal(h.fake.requests.filter((x) => x.op === "show.save").length, 1);
  // The reply is lost and nothing is written.
  h.fake.on("show.save", () => SILENT);
  const lost = await h.callJson("gma3_save_show", { exclusive: true, timeout_ms: 2000 });
  assert.equal(lost.result.verification.status, "unavailable");
  assert.match(lost.text, /may have been queued/);
  assert.doesNotMatch(lost.text, /was not queued/);
  assert.equal(h.fake.requests.filter((x) => x.op === "show.save").length, 2, "one request per call, no resend");
});

test("review 1: a failed final read is unavailable, never the stale snapshot's mismatch", async () => {
  let n = 0;
  const real = h.fake.handlerFor("show.files")!;
  h.fake.on("show.files", (args, req) => {
    n++;
    // The preflight and the first poll work (the old file); every later read fails.
    if (n <= 2) return real(args, req);
    throw new Error("busy");
  });
  h.fake.on("show.save", () => ({ queued: true, command: "SaveShow", now: con.now }));
  const r = await h.callJson("gma3_save_show", { exclusive: true, timeout_ms: 2000 });
  assert.equal(r.result.verification.status, "unavailable", r.text);
  assert.match(r.result.verification.detail, /could not be observed/);
  assert.equal(r.result.lastObserved.note, "an earlier read, not the final state");
  assert.notEqual(r.result.outcome, "succeeded");
  // Every poll fails.
  n = 0;
  h.fake.on("show.files", (args, req) => {
    n++;
    if (n === 1) return real(args, req);
    throw new Error("busy");
  });
  const all = await h.callJson("gma3_save_show", { exclusive: true, timeout_ms: 2000 });
  assert.equal(all.result.verification.status, "unavailable");
});

test("review 1: an unreadable dialog state refuses the save", async () => {
  con.modalUnknown = true;
  const r = await h.callJson("gma3_save_show", { exclusive: true });
  assert.equal(r.result.outcome, "failed");
  assert.match(String(r.result.steps.at(-1).error), /whether a dialog is open cannot be read \(GetTopModal failed\)/);
  assert.deepEqual(sent(), []);
});

test("review 2: a dialog for \"Joe's Show\" is not taken for \"s Show\" (the whole message binds the target)", async () => {
  con.files.set("Joe's Show", { size: 3000, time: 1792120000 });
  con.files.set("s Show", { size: 4000, time: 1792120000 });
  h.fake.on("show.save", () => {
    con.modal = { title: OVERWRITE_TITLE, text: "You are going to change the show file name and overwrite the file with the name\n'Joe's Show' that already exists.\nDo you want to continue ?", target: "Joe's Show" };
    return { queued: true, command: 'SaveShow "s Show"', now: con.now };
  });
  const r = await h.callJson("gma3_save_show", { name: "s Show", overwrite: true, exclusive: true });
  assert.equal(r.result.verification.status, "unavailable", r.text);
  assert.ok(!h.fake.requests.some((x) => x.op === "show.answer"), "nothing was clicked");
  assert.equal(con.files.get("Joe's Show")!.size, 3000);
  // The dialog text matches only its own complete name.
  assert.notEqual(squash(con.modal!.text), DIALOG_TEXT[OVERWRITE_TITLE]("s Show"));
  assert.equal(squash(con.modal!.text), DIALOG_TEXT[OVERWRITE_TITLE]("Joe's Show"));
});

test("review 2: a dialog that changes between the poll and the click is refused by the bridge's own check", async () => {
  // The poll sees this save's rename dialog; by the click it has become another show's dialog.
  let swapped = false;
  const realAnswer = h.fake.handlerFor("show.answer")!;
  h.fake.on("show.answer", (args, req) => {
    if (!swapped) {
      swapped = true;
      con.modal = { title: RENAME_TITLE, text: "Do you intend to change the show file name to\n'Another'?", target: "Another" };
    }
    return realAnswer(args, req);
  });
  const r = await h.callJson("gma3_save_show", { name: "Show B", exclusive: true, timeout_ms: 2000 });
  assert.notEqual(r.result.verification.status, "matched");
  assert.ok(r.result.steps.some((x: { name: string; error?: string }) => x.name === "confirm" && /wrong-target/.test(String(x.error))), r.text);
  assert.equal(con.files.has("Another"), false);
});
