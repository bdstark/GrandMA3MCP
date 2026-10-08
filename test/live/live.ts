/**
 * Shared guard for live console tests (see README.md in this folder).
 *
 * `liveTest()` registers a node:test case that is skipped unless GMA3_LIVE=1 and the show file
 * loaded in onPC matches GMA3_LIVE_SHOW. It hands the test a connected Gma3Bridge.
 */
import { test, after, type TestContext } from "node:test";
import { Gma3Bridge } from "../../src/bridge.ts";

const env = process.env;
export const liveEnabled = env.GMA3_LIVE === "1";
export const showPattern = new RegExp(env.GMA3_LIVE_SHOW ?? "disposable|mcp[-_ ]?test|scratch", "i");

export const bridge = new Gma3Bridge({
  host: env.GMA3_BRIDGE_HOST ?? "127.0.0.1",
  port: Number(env.GMA3_BRIDGE_PORT ?? 9800),
  requestTimeoutMs: Number(env.GMA3_BRIDGE_TIMEOUT_MS ?? 15000),
  // The socket must not keep the test process alive: a file's own cleanup hook may reconnect after
  // the shared hook below has closed the connection.
  unref: true,
});

let showCheck: Promise<{ ok: boolean; reason?: string; showfile?: string }> | null = null;

export function checkShow(): Promise<{ ok: boolean; reason?: string; showfile?: string }> {
  if (!showCheck) {
    showCheck = (async () => {
      try {
        const ping = (await bridge.request("ping", {}, 4000)) as { showfile?: string };
        const showfile = ping.showfile ?? "";
        if (!showPattern.test(showfile)) {
          return { ok: false, showfile, reason: `loaded show "${showfile}" does not match GMA3_LIVE_SHOW (${showPattern}); load a disposable show first` };
        }
        return { ok: true, showfile };
      } catch (err) {
        return { ok: false, reason: `bridge not reachable: ${err instanceof Error ? err.message : String(err)}` };
      }
    })();
  }
  return showCheck;
}

export function liveTest(name: string, fn: (t: TestContext, bridge: Gma3Bridge) => Promise<void>): void {
  test(name, { skip: liveEnabled ? false : "set GMA3_LIVE=1 to run live console tests" }, async (t) => {
    const check = await checkShow();
    if (!check.ok) {
      t.skip(check.reason);
      return;
    }
    await fn(t, bridge);
  });
}

/** Run a command and return its feedback text; throws on transport errors. */
export async function cmd(command: string): Promise<string | null> {
  const res = (await bridge.request("cmd", { command })) as { feedback?: unknown };
  return res.feedback === undefined || res.feedback === null ? null : String(res.feedback);
}

// An open socket keeps the event loop alive, so close it once the file's tests are done.
after(() => bridge.close());
