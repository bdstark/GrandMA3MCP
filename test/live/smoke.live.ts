/**
 * Live smoke test: the bridge answers, the show is disposable, and a harmless command gives feedback.
 * Objects used: none are created or changed.
 */
import assert from "node:assert/strict";
import { liveTest, cmd } from "./live.ts";

liveTest("bridge answers ping and a no-op command returns feedback", async (_t, bridge) => {
  const ping = (await bridge.request("ping", {}, 4000)) as { bridgeVersion: string; showfile?: string };
  assert.ok(ping.bridgeVersion);
  // "Echo" prints to the console and has no effect on show data.
  const fb = await cmd('Echo "gma3-mcp live smoke test"');
  assert.ok(fb === null || typeof fb === "string");
});
