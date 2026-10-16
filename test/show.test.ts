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
import { startHarness, type Harness } from "./helpers/tool-harness.ts";

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
    this.modal = exists ? { title: OVERWRITE_TITLE, text: `overwrite '${name}'`, target: name } : { title: RENAME_TITLE, text: `change to '${name}'`, target: name };
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
  assert.match(r.text, /unexpected dialog opened \(Something else\).*answer it at the console/);
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
  assert.match(m.result.verification.detail, /still carries its old time/);
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
