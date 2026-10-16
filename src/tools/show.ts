/**
 * SU-20: save the show (SETUP.md SU-20, docs/probes/su-20-save-show-macos-2.5.1.md).
 *
 *   gma3_show_files   read-only: the current show, the shows folder and its .show files (size, time)
 *   gma3_save_show    saves under the current name or a new one; refuses to overwrite another show's file unless
 *                     overwrite: true; answers SaveShow's own confirmation; reports the file written (size, time)
 *
 * Bridge ops show.files / show.save / show.answer (0.35.0). Console facts (onPC 2.5.1, live 2026-10-16):
 *   - SaveShow is sent with CmdIndirect: a dialog opened from the plugin thread would stall the bridge.
 *   - Under the current name it writes at once, with no dialog.
 *   - Under a new name it asks "Change show file name?" (OK / Cancel); under the name of another existing file it asks
 *     "Change show file name and overwrite existing show file?". OK writes at once and makes that name current.
 *   - DirList reports the local wall-clock time as if it were UTC; the bridge corrects it (time) and keeps the
 *     wall-clock text (localTime).
 */
import { z } from "zod";
import type { Gma3Bridge } from "../bridge.js";
import { asRead, buildResult, stepFromError, unavailable, validationFailure, type OperationResult, type StepResult, type Verification } from "../results.js";
import { json, operation, type RegisterTools, type ToolContext } from "./context.js";

export interface ShowFile {
  name: string;
  file?: string;
  size?: number | null;
  time?: number | null;
  localTime?: string | null;
}
export interface Modal {
  class?: string;
  name?: string;
  title?: string;
  text?: string;
  buttons?: string[];
  display?: number;
}
export interface ShowFiles {
  current?: string | null;
  path?: string;
  listed?: boolean;
  files: ShowFile[];
  now?: number;
  localNow?: string;
  modal?: Modal | false;
  /** false when the bridge could not read whether a dialog is open (never taken for "no dialog"). */
  modalKnown?: boolean;
  modalError?: string;
}

export const RENAME_TITLE = "Change show file name?";
export const OVERWRITE_TITLE = "Change show file name and overwrite existing show file?";
/**
 * The whole message each SaveShow dialog shows for a show (live, whitespace collapsed). A dialog is ours only when its
 * message is exactly this: a substring check would take "Joe's Show" for "s Show" (review of PR #66).
 */
export const DIALOG_TEXT: Record<string, (name: string) => string> = {
  [RENAME_TITLE]: (n) => `Do you intend to change the show file name to '${n}'?`,
  [OVERWRITE_TITLE]: (n) => `You are going to change the show file name and overwrite the file with the name '${n}' that already exists. Do you want to continue ?`,
};
export const squash = (t: string) => t.replace(/\s+/g, " ").trim();
const NEEDS_BRIDGE = "the console runs an older bridge plugin without the show ops (bridge 0.35.0); update the plugin";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = 150;

export async function readShowFiles(bridge: Gma3Bridge, t: number): Promise<ShowFiles> {
  try {
    const r = (await bridge.request("show.files", {}, t)) as ShowFiles;
    return { ...r, files: Array.isArray(r.files) ? r.files : [] };
  } catch (err) {
    if (err instanceof Error && /unknown op/i.test(err.message)) throw new Error(NEEDS_BRIDGE);
    throw err;
  }
}

/** Show names compare like the file system on macOS and Windows: case-insensitively. */
const same = (a: string | null | undefined, b: string | null | undefined) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const iso = (epoch: number | null | undefined) => (typeof epoch === "number" ? new Date(epoch * 1000).toISOString() : null);
const fileView = (f: ShowFile | undefined) => (f ? { name: f.name, file: f.file, size: f.size ?? null, time: iso(f.time), localTime: f.localTime ?? null } : null);

/** A show name as SaveShow takes it; ".show" is dropped. Throws a readable reason. */
export function showName(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("name must be text");
  const n = raw.replace(/\.show$/i, "");
  if (!n || n.length > 128 || /[\u0000-\u001f"/\\:*?<>|]/.test(n) || n !== n.trim()) {
    throw new Error('name must be 1-128 characters without quotes, slashes, \\ : * ? < > | or control characters, and without leading or trailing spaces');
  }
  return n;
}

export async function saveShow(ctx: ToolContext, raw: Record<string, unknown>): Promise<OperationResult> {
  const op = "save_show";
  const errors: string[] = [];
  let name: string | undefined;
  if (raw.name !== undefined) {
    try {
      name = showName(raw.name);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  if (raw.overwrite !== undefined && typeof raw.overwrite !== "boolean") errors.push("overwrite must be true or false");
  const timeoutMs = raw.timeout_ms === undefined ? 20000 : typeof raw.timeout_ms === "number" && raw.timeout_ms >= 2000 && raw.timeout_ms <= 120000 ? raw.timeout_ms : (errors.push("timeout_ms must be 2000-120000"), 20000);
  if (raw.exclusive !== true) errors.push("exclusive must be true: the show file is written (an existing file is replaced) and the console's current show name may change; nobody else may load or save shows while it runs");
  const target = { name: name ?? "current show", overwrite: raw.overwrite === true };
  if (errors.length) return validationFailure(op, target, errors);

  return ctx.mutations.run(async () => {
    const t = ctx.requestTimeoutMs;
    const steps: StepResult[] = [];
    let before: ShowFiles;
    try {
      before = await readShowFiles(ctx.bridge, t);
      steps.push(asRead({ name: "read_show_files", status: "succeeded", op: "show.files", detail: { current: before.current, files: before.files.length } }));
    } catch (err) {
      steps.push(asRead(stepFromError("read_show_files", err, { op: "show.files" })));
      return buildResult({ operation: op, target, steps, verification: unavailable("nothing was sent") });
    }
    const refuse = (why: string, extra: Record<string, unknown> = {}) => {
      steps.push(asRead({ name: "check", status: "failed", error: `${why}; nothing was saved` }));
      return buildResult({ operation: op, target, steps, verification: unavailable("nothing was saved"), extra: { current: before.current ?? null, ...extra } });
    };
    if (before.modalKnown === false) return refuse(`whether a dialog is open cannot be read (${before.modalError ?? "unknown"})`);
    if (before.modal) return refuse(`a dialog is open on the console (${before.modal.title ?? before.modal.name ?? before.modal.class}); close it first`, { modal: before.modal });
    if (!before.current) return refuse("the console's current show name cannot be read");
    if (!before.listed) return refuse("the shows folder cannot be listed, so an existing file cannot be ruled out");
    const to = name ?? before.current;
    const existing = before.files.find((f) => same(f.name, to));
    const isCurrent = same(to, before.current);
    // The dialog SaveShow will open: none (current name), rename (new file), overwrite (another existing file).
    const expect = isCurrent ? null : existing ? OVERWRITE_TITLE : RENAME_TITLE;
    if (existing && !isCurrent && raw.overwrite !== true) {
      return refuse(`"${existing.name}" is another show's file (${existing.size ?? "?"} bytes, saved ${existing.localTime ?? "?"}); saving would replace it and make it the current show. Pass overwrite: true to replace it, or choose a new name`, { existing: fileView(existing) });
    }

    // A write is proven only by a file this save produced: a new file, or one with a later time than before. File times
    // have whole seconds, so when the existing file is from the console's current second, wait until the clock has
    // passed it (review of PR #66: an unchanged recent file is never proof).
    if (existing && typeof existing.time === "number" && typeof before.now === "number" && existing.time >= before.now - 1) {
      await sleep(Math.min(2500, (existing.time - before.now + 1) * 1000 + 300));
    }
    const proves = (f: ShowFile | undefined) => !!f && typeof f.time === "number" && (!existing || f.time > (existing.time ?? Number.POSITIVE_INFINITY) || (typeof f.size === "number" && f.size !== existing.size && f.time >= (existing.time ?? 0)));

    let queueUncertain = false;
    try {
      const sent = (await ctx.bridge.request("show.save", { ...(isCurrent ? {} : { name: to }), exclusive: true }, t)) as { command?: string };
      steps.push({ name: "save", status: "succeeded", op: "show.save", command: sent.command, detail: { queued: true } });
    } catch (err) {
      const step = stepFromError("save", err, { op: "show.save" });
      steps.push(step);
      if (step.status !== "unknown") return buildResult({ operation: op, target, steps, verification: unavailable("the bridge refused SaveShow: it was not queued") });
      // The request went out and its answer was lost: the save may still run. It is not resent; it is watched.
      queueUncertain = true;
    }

    // Poll: answer only SaveShow's own dialog naming this show, stop at any other dialog, finish when a file this save
    // produced is there and current. Only the latest read counts: a failed read is a gap, never the old snapshot.
    const t0 = Date.now();
    let answered = false;
    let last: ShowFiles | undefined;
    let lastOk = false;
    let foreign: Modal | undefined;
    let unknownModal: string | undefined;
    let unread = 0;
    while (Date.now() - t0 < timeoutMs) {
      await sleep(POLL_MS);
      let now: ShowFiles;
      try {
        now = await readShowFiles(ctx.bridge, t);
      } catch {
        unread++;
        lastOk = false;
        continue;
      }
      last = now;
      lastOk = true;
      if (now.modalKnown === false) {
        unknownModal = now.modalError ?? "unknown";
        continue;
      }
      unknownModal = undefined;
      if (now.modal) {
        const ours = !answered && expect && now.modal.title === expect && typeof now.modal.text === "string" && squash(now.modal.text) === DIALOG_TEXT[expect](to);
        if (ours) {
          try {
            await ctx.bridge.request("show.answer", { expectTitle: expect, expectTarget: to, button: "OK", exclusive: true }, t);
            answered = true;
            steps.push({ name: "confirm", status: "succeeded", op: "show.answer", detail: { title: expect, text: now.modal.text ?? null, clicked: "OK" } });
          } catch (err) {
            steps.push(stepFromError("confirm", err, { op: "show.answer", detail: { title: expect, target: to } }));
            break;
          }
          continue;
        }
        foreign = now.modal;
        break;
      }
      const f = now.files.find((x) => same(x.name, to));
      if (proves(f) && same(now.current, to)) break;
    }
    // A final read when the last attempt failed: completion is judged from a current observation or not at all.
    if (!foreign && !lastOk && last) {
      try {
        last = await readShowFiles(ctx.bridge, t);
        lastOk = true;
      } catch {
        unread++;
      }
    }

    const after = lastOk ? last : undefined;
    const written = after?.files.find((x) => same(x.name, to));
    const fresh = proves(written);
    const checked = `${to}.show written by this save (new, or a later time than ${existing?.localTime ?? "before"}) and current`;
    let verification: Verification;
    if (foreign) {
      const otherTarget = foreign.title === expect;
      steps.push({ name: "wait", status: "unknown", error: `${otherTarget ? `a "${foreign.title}" dialog for another show` : `an unexpected dialog (${foreign.title ?? foreign.name ?? foreign.class})`} is open; it was not answered: answer it at the console`, detail: { modal: foreign } });
      verification = unavailable(`an unexpected dialog is open on the console: ${foreign.title ?? foreign.name}${foreign.text ? ` (${foreign.text})` : ""}`, checked);
    } else if (!after) {
      steps.push({ name: "wait", status: "unknown", error: `the shows folder could not be read at the end${last ? ` (last read: ${same(last.current, to) ? "current" : `current ${last.current}`})` : ""}; whether the save completed is unknown` });
      verification = unavailable("the save's completion could not be observed (the shows folder could not be read)", checked);
    } else if (fresh && same(after.current, to)) {
      verification = { status: "matched", checked, expected: { file: `${to}.show`, current: to }, actual: { ...fileView(written), current: after.current } };
    } else if (unknownModal) {
      steps.push({ name: "wait", status: "unknown", error: `whether a dialog is open cannot be read (${unknownModal}); nothing was answered` });
      verification = unavailable(`the dialog state could not be read (${unknownModal})`, checked);
    } else if (queueUncertain || (expect && !answered)) {
      steps.push({ name: "wait", status: "unknown", error: queueUncertain ? `the reply to SaveShow was lost and no write was seen within ${timeoutMs} ms; SaveShow was not resent and may still run (check gma3_show_files)` : `the expected dialog "${expect}" did not appear within ${timeoutMs} ms` });
      verification = unavailable(queueUncertain ? "SaveShow may have been queued (its reply was lost); no write was seen" : `no confirmation dialog appeared and no write was seen within ${timeoutMs} ms`, checked);
    } else {
      verification = {
        status: "mismatched",
        checked,
        expected: { file: `${to}.show`, current: to, writtenAfter: existing?.localTime ?? null },
        actual: { file: fileView(written), current: after.current ?? null },
        detail: !written ? `${to}.show is not in the shows folder after ${timeoutMs} ms` : !fresh ? `${to}.show still carries its earlier time (${written.localTime}) and size` : `the console's current show is ${after.current}, not ${to}`,
      };
    }
    const renamed = !isCurrent && same(after?.current, to);
    return buildResult({
      operation: op,
      target: { ...target, name: to },
      steps,
      verification,
      summary:
        verification.status === "matched"
          ? `Saved ${to}.show (${written?.size ?? "?"} bytes, ${written?.localTime ?? "?"} console time)${renamed ? `; the current show is now ${to} (was ${before.current})` : ""}${existing && !isCurrent ? `; it replaced the earlier ${to}.show` : ""}.`
          : undefined,
      warnings: [
        ...(renamed ? [`the console's current show is now ${to}: later saves without a name write ${to}.show, not ${before.current}.show`] : []),
        ...(unread ? [`${unread} read(s) of the shows folder failed while waiting`] : []),
        ...(queueUncertain ? ["the reply to SaveShow was lost: it was not resent"] : []),
      ],
      extra: {
        file: fileView(written),
        previous: { current: before.current, file: fileView(existing) },
        current: after?.current ?? null,
        ...(!after && last ? { lastObserved: { current: last.current ?? null, file: fileView(last.files.find((x) => same(x.name, to))), note: "an earlier read, not the final state" } } : {}),
        ...(expect ? { dialog: { expected: expect, answered } } : { dialog: "none (the current name saves without a dialog)" }),
        path: before.path,
      },
    });
  });
}

export const registerShowTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_show_files",
    {
      title: "List the show files",
      description:
        "Read-only. The console's current show, the shows folder and every .show file in it (name, size, time as ISO and as the console's local wall-clock time), newest first, and a dialog when one is open. Use it before gma3_save_show to choose a name that does not replace another show. Needs bridge 0.35.0.",
      inputSchema: {},
    },
    async () => {
      try {
        const s = await readShowFiles(ctx.bridge, ctx.requestTimeoutMs);
        const files = [...s.files].sort((a, b) => (b.time ?? 0) - (a.time ?? 0)).map(fileView);
        return json({ tool: "gma3_show_files", current: s.current ?? null, currentFile: fileView(s.files.find((f) => same(f.name, s.current))), path: s.path, listed: s.listed ?? null, count: files.length, files, consoleTime: s.localNow ?? null, ...(s.modal ? { modal: s.modal } : {}) });
      } catch (err) {
        return { content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    "gma3_save_show",
    {
      title: "Save the show file",
      description:
        "Save the show: under the current name (default) or a new name (which becomes the console's current show). Refuses to replace another show's existing file unless overwrite: true, and refuses while a dialog is open. SaveShow is sent so that it cannot stall the bridge; the tool answers SaveShow's own confirmation (\"Change show file name?\", or \"... and overwrite existing show file?\" with overwrite: true) and nothing else. " +
        "Verification: matched when the file carries a time from this save and the console names it current; the result reports the file (size, time). Requires exclusive: true. Use gma3_show_files to see the files first. Needs bridge 0.35.0.",
      inputSchema: {
        name: z.string().optional().describe("Show name (without .show). Default: the current show."),
        overwrite: z.boolean().optional().describe("Replace an existing file of another show with this name (default false: refuse)."),
        timeout_ms: z.number().optional().describe("How long to wait for the save (2000-120000, default 20000)."),
        exclusive: z.boolean().optional(),
      },
    },
    async (args) => operation(() => saveShow(ctx, args)),
  );
};
