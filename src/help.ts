import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Access to the grandMA3 user manual that ships with onPC
 * (~/MALightingTechnology/gma3_<version>/shared/language/HTML/*.html).
 */

function candidateRoots(): string[] {
  const roots: string[] = [];
  if (process.env.GMA3_HELP_DIR) roots.push(process.env.GMA3_HELP_DIR);
  const base = process.env.GMA3_INSTALL_DIR ?? path.join(os.homedir(), "MALightingTechnology");
  if (fs.existsSync(base)) {
    const versions = fs
      .readdirSync(base)
      .filter((d) => /^gma3_\d/.test(d))
      .sort((a, b) => compareVersions(b, a));
    for (const v of versions) roots.push(path.join(base, v, "shared", "language", "HTML"));
  }
  return roots;
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^gma3_/, "").split(".").map(Number);
  const pb = b.replace(/^gma3_/, "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

let cachedDir: string | null | undefined;

export function helpDir(): string | null {
  if (cachedDir !== undefined) return cachedDir;
  cachedDir = candidateRoots().find((d) => fs.existsSync(d)) ?? null;
  return cachedDir;
}

export function helpVersion(): string | null {
  const dir = helpDir();
  if (!dir) return null;
  const m = dir.match(/gma3_(\d+(?:\.\d+)*)/);
  return m ? m[1] : null;
}

const entities: Record<string, string> = {
  "&nbsp;": " ",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&amp;": "&",
};

export function htmlToText(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|pre|table)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ");
  s = s.replace(/&[a-z#0-9]+;/gi, (e) => entities[e] ?? " ");
  const lines = s
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l) => l.length > 0);
  // Drop the navigation header: everything before the "grandMA3 User Manual Publication" marker.
  const start = lines.findIndex((l) => /User Manual Publication/.test(l));
  const body = start >= 0 ? lines.slice(start + 1) : lines;
  return body.join("\n");
}

export interface HelpPage {
  file: string;
  title: string;
}

export function listHelpPages(): HelpPage[] {
  const dir = helpDir();
  if (!dir) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".html"))
    .flatMap((f) => {
      const file = helpFile(dir, f);
      return file ? [{ file: f, title: titleOf(file) }] : [];
    });
}

function titleOf(file: string): string {
  try {
    const head = fs.readFileSync(file, "utf8").slice(0, 4000);
    const m = head.match(/articleTitleText='([^']*)'/) ?? head.match(/<title>([^<]*)<\/title>/i);
    return m ? m[1].trim() : path.basename(file, ".html");
  } catch {
    return path.basename(file, ".html");
  }
}

/**
 * Resolve a page name inside the manual directory, or null if the result
 * would escape it (defense in depth on top of the separator check above).
 */
function helpFile(dir: string, name: string): string | null {
  const root = path.resolve(dir);
  const file = path.resolve(root, name);
  if (path.dirname(file) !== root || path.basename(file) !== name) return null;
  // Follow symlinks on both sides: a link inside the manual folder must not
  // lead to a file outside it. realpathSync throws if the file is missing.
  try {
    const realRoot = fs.realpathSync(root);
    const realFile = fs.realpathSync(file);
    if (path.dirname(realFile) !== realRoot) return null;
    return realFile;
  } catch {
    return null;
  }
}

/**
 * Look up a help topic. Tries the keyword page first (keyword_<name>.html),
 * then exact file names, then a substring search over file names and titles.
 */
export function lookupHelp(topic: string, maxChars = 12000): { page?: string; text?: string; matches?: HelpPage[]; error?: string } {
  const dir = helpDir();
  if (!dir) return { error: "grandMA3 help files not found; set GMA3_HELP_DIR or GMA3_INSTALL_DIR" };
  // Topics are bare page names, never paths: refuse separators and NUL so the
  // lookup can only ever name a file directly inside the manual directory.
  if (/[\/\\\0]/.test(topic)) return { error: "topic must be a page name or keyword, not a path" };
  const q = topic.trim().toLowerCase().replace(/\.html$/, "").replace(/\+/g, "plus").replace(/(\w)-(?=\s|$)/g, "$1minus");
  const candidates = [`keyword_${q}.html`, `${q}.html`, `keyword_${q.replace(/\s+/g, "")}.html`, `${q.replace(/\s+/g, "_")}.html`];
  for (const c of candidates) {
    const file = helpFile(dir, c);
    if (file) {
      const text = htmlToText(fs.readFileSync(file, "utf8"));
      return { page: c, text: text.length > maxChars ? text.slice(0, maxChars) + "\n…(truncated)" : text };
    }
  }
  const words = q.split(/\s+/).filter(Boolean);
  const matches = listHelpPages().filter((p) => {
    const hay = `${p.file} ${p.title}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  if (matches.length === 1) return lookupHelp(matches[0].file, maxChars);
  return { matches: matches.slice(0, 50) };
}
