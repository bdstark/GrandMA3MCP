import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { FakeBridge } from "./helpers/fake-bridge.js";

/**
 * The KB-26 live test's cleanup must never delete anything it did not create (PR #34 review): it runs the
 * real test/live/patch.live.ts, with GMA3_LIVE=1 and GMA3_LIVE_EXCLUSIVE=1, against a fake bridge
 *   - whose loaded show is not disposable (the test is skipped), and
 *   - whose disposable show already holds a fixture at FID 990 (the preflight fails),
 * and checks that no patch change (patch.enter, patch.add, patch.set, patch.remove, patch.commit) was sent.
 */

const root = path.resolve(import.meta.dirname, "..");
const liveFile = path.join(root, "test", "live", "patch.live.ts");
const MUTATING = ["patch.enter", "patch.add", "patch.set", "patch.remove", "patch.commit", "cmd", "set", "lua"];

function runLive(port: number): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve) => {
    // The default show guard applies: GMA3_LIVE_SHOW is removed, not emptied (an empty pattern matches every show).
    const env: Record<string, string | undefined> = { ...process.env, GMA3_LIVE: "1", GMA3_LIVE_EXCLUSIVE: "1", GMA3_BRIDGE_PORT: String(port), GMA3_BRIDGE_HOST: "127.0.0.1" };
    delete env.GMA3_LIVE_SHOW;
    // Run the file as its own test run, not as a nested one (node:test skips files when it sees the parent's context).
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ["--import", "tsx", "--test", liveFile], { cwd: root, env });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (output += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (output += d));
    child.on("close", (status) => resolve({ status, output }));
  });
}

function fakeShow(showfile: string): FakeBridge {
  const fake = new FakeBridge();
  fake.on("ping", () => ({ bridgeVersion: "0.19.0", showfile, user: "Admin" }));
  // An operator's fixture sits at FID 990: the one the live test would create (and its cleanup would remove).
  fake.on("patch.list", () => ({ side: "live", total: 1, offset: 0, count: 1, fixtures: [{ fid: 990, name: "Operator Fixture", patch: "1.001", subfixtures: 0 }] }));
  fake.on("patch.state", () => ({ destination: "Root", copyOpen: false, atRoot: true, modal: false, stages: ["Stage 1"] }));
  fake.on("patch.check", () => ({ fixtures: [{ fid: 990, exists: true, current: { fid: 990, name: "Operator Fixture", subfixtures: 0 } }] }));
  return fake;
}

test("live patch test against a non-disposable show: skipped, and its cleanup deletes nothing", async () => {
  const fake = fakeShow("Main Production");
  const port = await fake.listen();
  try {
    const r = await runLive(port);
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /skipped 1/, r.output);
    assert.match(r.output, /does not match GMA3_LIVE_SHOW/, r.output);
    const sent = fake.requests.map((q) => q.op);
    assert.deepEqual(sent.filter((op) => MUTATING.includes(op)), [], `no patch change may be sent: ${sent.join(", ")}`);
  } finally {
    await fake.close();
  }
});

test("live patch test on a disposable show with FID 990 occupied: fails at the preflight, and its cleanup deletes nothing", async () => {
  const fake = fakeShow("mcp-test-disposable");
  const port = await fake.listen();
  try {
    const r = await runLive(port);
    assert.notEqual(r.status, 0, "the occupied FID fails the test");
    assert.match(r.output, /FIDs 990\.\.993 must be free/, r.output);
    const sent = fake.requests.map((q) => q.op);
    assert.deepEqual(sent.filter((op) => MUTATING.includes(op)), [], `no patch change may be sent: ${sent.join(", ")}`);
    assert.ok(sent.includes("patch.list"), "the preflight read the FIDs");
  } finally {
    await fake.close();
  }
});
