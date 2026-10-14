import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build staleness check. `npm run build` stamps dist/build-info.json with a hash of the inputs that
 * the compiled server depends on. At startup and in gma3_status the server rehashes the checkout's
 * source and compares, so a `git pull` without a rebuild is reported instead of silently serving an
 * older tool set. Only content is compared: a pull that changes docs or the plugin alone is not stale.
 */

export const BUILD_INFO_FILE = "build-info.json";
/** Files outside src/ whose changes need `npm ci` / `npm run build` before the build matches. */
const EXTRA_INPUTS = ["package-lock.json", "tsconfig.json"];

export interface BuildStamp {
  sourceHash: string;
  builtAt: string;
  /** Git commit the build was made from, when git was available; for display only. */
  commit: string | null;
  /** The build inputs had uncommitted changes at build time. */
  dirty: boolean | null;
}

export type BuildState = "current" | "stale" | "unverified";

export interface BuildCheck {
  state: BuildState;
  reason: string;
  /** What the user has to do, when anything. */
  action?: string;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(abs));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

/** Hash of src/** plus the extra inputs under `root`, or null when there is no src/ to hash. */
export function hashSources(root: string): string | null {
  const srcDir = path.join(root, "src");
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) return null;
  const files = [...listFiles(srcDir), ...EXTRA_INPUTS.map((f) => path.join(root, f)).filter((f) => fs.existsSync(f))]
    .map((abs) => ({ abs, rel: path.relative(root, abs).split(path.sep).join("/") }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const hash = createHash("sha256");
  for (const f of files) {
    hash.update(f.rel);
    hash.update("\0");
    hash.update(fs.readFileSync(f.abs));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

export function createBuildStamp(root: string, now = new Date()): BuildStamp {
  const sourceHash = hashSources(root);
  if (!sourceHash) throw new Error(`no src/ directory under ${root} to stamp`);
  const commit = git(root, ["rev-parse", "HEAD"]);
  const status = commit ? git(root, ["status", "--porcelain", "--", "src", ...EXTRA_INPUTS]) : null;
  return { sourceHash, builtAt: now.toISOString(), commit, dirty: status === null ? null : status.length > 0 };
}

export function writeBuildStamp(root: string, distDir = path.join(root, "dist")): BuildStamp {
  const stamp = createBuildStamp(root);
  fs.writeFileSync(path.join(distDir, BUILD_INFO_FILE), JSON.stringify(stamp, null, 2) + "\n");
  return stamp;
}

export function readBuildStamp(distDir: string): BuildStamp | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(distDir, BUILD_INFO_FILE), "utf8"));
    return raw && typeof raw.sourceHash === "string" ? (raw as BuildStamp) : null;
  } catch {
    return null;
  }
}

export interface BuildCheckInput {
  /** The stamp read when this process started (the build that is actually running). */
  running: BuildStamp | null;
  /** The stamp on disk now; differs from `running` when dist was rebuilt after startup. */
  onDisk: BuildStamp | null;
  /** Hash of the checkout's current source, or null when the source is not next to the build. */
  sourceHash: string | null;
  /** The server runs from TypeScript source (tsx), so there is no build to go stale. */
  fromSource: boolean;
  root: string;
}

export function assessBuild(input: BuildCheckInput): BuildCheck {
  if (input.fromSource) return { state: "current", reason: "running from TypeScript source; there is no build to compare" };
  const rebuild = `run  npm ci && npm run build  in ${input.root}, then restart the MCP client`;
  if (!input.running) {
    return {
      state: "unverified",
      reason: `dist/${BUILD_INFO_FILE} is missing, so this build was not made with  npm run build`,
      action: rebuild,
    };
  }
  if (input.sourceHash === null) {
    return { state: "unverified", reason: "the source is not installed next to this build (package or container install); nothing to compare" };
  }
  if (input.sourceHash === input.running.sourceHash) return { state: "current", reason: "the build matches the source checkout" };
  if (input.onDisk && input.onDisk.sourceHash === input.sourceHash) {
    return {
      state: "stale",
      reason: "dist was rebuilt from the current source, but this server process still runs the previous build",
      action: "restart the MCP client to load the new build",
    };
  }
  return {
    state: "stale",
    reason: `the source checkout changed after this build (built ${input.running.builtAt}${input.running.commit ? ` from ${input.running.commit.slice(0, 7)}` : ""}); tools added or changed since then are missing or out of date`,
    action: rebuild,
  };
}

/** The build check for this running server. The stamp is read once, at module load. */
export class ServerBuild {
  readonly root: string;
  readonly distDir: string;
  readonly fromSource: boolean;
  readonly running: BuildStamp | null;

  constructor(moduleUrl: string) {
    const file = fileURLToPath(moduleUrl);
    this.distDir = path.dirname(file);
    this.root = path.dirname(this.distDir);
    this.fromSource = file.endsWith(".ts");
    this.running = this.fromSource ? null : readBuildStamp(this.distDir);
  }

  check(): BuildCheck {
    if (this.fromSource) return assessBuild({ running: null, onDisk: null, sourceHash: null, fromSource: true, root: this.root });
    let sourceHash: string | null;
    try {
      sourceHash = hashSources(this.root);
    } catch {
      sourceHash = null;
    }
    return assessBuild({ running: this.running, onDisk: readBuildStamp(this.distDir), sourceHash, fromSource: false, root: this.root });
  }
}

export const serverBuild = new ServerBuild(import.meta.url);
