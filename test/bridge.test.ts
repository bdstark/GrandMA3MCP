import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { Gma3Bridge, BridgeError, BridgeUnreachableError } from "../src/bridge.ts";

/**
 * Gma3Bridge against a fake JSON-lines server. The important property is the
 * `dispatched` flag: once a request has been written, a failure must not look
 * like "nothing was sent", because callers use that to decide whether a
 * command may be retried on another transport.
 */

type Handler = (req: { id: string; op: string; args: Record<string, unknown> }, sock: net.Socket) => void;

async function fakeBridge(handler: Handler): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        handler(JSON.parse(line), sock);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

const reply = (sock: net.Socket, msg: unknown) => sock.write(JSON.stringify(msg) + "\n");

test("request round trip resolves with the result", async () => {
  const fake = await fakeBridge((req, sock) => reply(sock, { id: req.id, ok: true, result: { op: req.op, echo: req.args } }));
  const bridge = new Gma3Bridge({ host: "127.0.0.1", port: fake.port });
  try {
    assert.equal(bridge.connected, false);
    const res = await bridge.request("cmd", { command: "Go+ Sequence 1" });
    assert.deepEqual(res, { op: "cmd", echo: { command: "Go+ Sequence 1" } });
    assert.equal(bridge.connected, true);
    assert.equal(bridge.lastErrorMessage, null);
  } finally {
    bridge.close();
    await fake.close();
  }
});

test("an error reply rejects with a non-dispatched BridgeError", async () => {
  const fake = await fakeBridge((req, sock) => reply(sock, { id: req.id, ok: false, error: "unknown op 'nope'" }));
  const bridge = new Gma3Bridge({ host: "127.0.0.1", port: fake.port });
  try {
    await assert.rejects(bridge.request("nope"), (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.ok(!(err instanceof BridgeUnreachableError));
      assert.equal(err.dispatched, false);
      assert.equal(err.message, "unknown op 'nope'");
      return true;
    });
  } finally {
    bridge.close();
    await fake.close();
  }
});

test("a timeout is reported as dispatched: the command may have run", async () => {
  const fake = await fakeBridge(() => {});
  const bridge = new Gma3Bridge({ host: "127.0.0.1", port: fake.port, requestTimeoutMs: 50 });
  try {
    await assert.rejects(bridge.request("cmd", { command: "Go+" }), (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.ok(!(err instanceof BridgeUnreachableError));
      assert.equal(err.dispatched, true);
      assert.equal(err.op, "cmd");
      assert.match(err.message, /timeout after 50ms waiting for 'cmd'/);
      return true;
    });
    assert.equal(bridge.connected, true, "a timeout does not drop the connection");
  } finally {
    bridge.close();
    await fake.close();
  }
});

test("a connection drop while waiting is reported as dispatched", async () => {
  const fake = await fakeBridge((_req, sock) => sock.destroy());
  const bridge = new Gma3Bridge({ host: "127.0.0.1", port: fake.port, requestTimeoutMs: 1000 });
  try {
    await assert.rejects(bridge.request("cmd", { command: "Go+" }), (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.ok(!(err instanceof BridgeUnreachableError));
      assert.equal(err.dispatched, true);
      assert.match(err.message, /while waiting for reply/);
      return true;
    });
    assert.equal(bridge.connected, false);
    assert.equal(typeof bridge.lastErrorMessage, "string");
  } finally {
    bridge.close();
    await fake.close();
  }
});

test("a refused connection is a BridgeUnreachableError and nothing is dispatched", async () => {
  const fake = await fakeBridge(() => {});
  const port = fake.port;
  await fake.close();
  const bridge = new Gma3Bridge({ host: "127.0.0.1", port, requestTimeoutMs: 1000 });
  await assert.rejects(bridge.request("cmd", { command: "Go+" }), (err: unknown) => {
    assert.ok(err instanceof BridgeUnreachableError);
    assert.equal(err.dispatched, false);
    assert.match(err.message, /cannot connect to bridge at 127\.0\.0\.1:\d+/);
    return true;
  });
  assert.equal(bridge.connected, false);
  assert.match(bridge.lastErrorMessage ?? "", /ECONNREFUSED|connect/);
  assert.equal(bridge.description, `127.0.0.1:${port}`);
});

test("replies split across packets, batched, or interleaved with junk are still matched by id", async () => {
  const fake = await fakeBridge((req, sock) => {
    if (req.op === "split") {
      const payload = Buffer.from(JSON.stringify({ id: req.id, ok: true, result: "café" }) + "\n", "utf8");
      const cut = payload.indexOf(Buffer.from("é", "utf8")) + 1; // inside the two-byte sequence
      sock.write(payload.subarray(0, cut));
      setTimeout(() => sock.write(payload.subarray(cut)), 10);
    } else if (req.op === "junk") {
      sock.write("not json\n\n" + JSON.stringify({ id: "does-not-exist", ok: true, result: 1 }) + "\n" + JSON.stringify({ ok: true, result: 2 }) + "\n");
      reply(sock, { id: req.id, ok: true, result: "after junk" });
    } else {
      // Answer "batch" requests together in one write.
      pendingBatch.push(req.id);
      if (pendingBatch.length === 2) {
        sock.write(pendingBatch.map((id) => JSON.stringify({ id, ok: true, result: `batch ${id}` })).join("\n") + "\n");
        pendingBatch = [];
      }
    }
  });
  let pendingBatch: string[] = [];
  const bridge = new Gma3Bridge({ host: "127.0.0.1", port: fake.port, requestTimeoutMs: 1000 });
  try {
    assert.equal(await bridge.request("split"), "café");
    assert.equal(await bridge.request("junk"), "after junk");
    const [a, b] = await Promise.all([bridge.request("batch"), bridge.request("batch")]);
    assert.match(String(a), /^batch \d+$/);
    assert.match(String(b), /^batch \d+$/);
    assert.notEqual(a, b);
  } finally {
    bridge.close();
    await fake.close();
  }
});

test("an error reply keeps the bridge's code and structured detail; a bracketed code in the text is parsed too", async () => {
  const fake = await fakeBridge((req, sock) => {
    if (req.op === "input.press") reply(sock, { id: req.id, ok: false, error: "[busy] interaction i1 of session 'conn-2' is open", code: "busy", detail: { code: "busy", reason: "interaction", owner: "conn-2", interaction: "i1" } });
    else reply(sock, { id: req.id, ok: false, error: "[no-session] this connection has no input session" });
  });
  const bridge = new Gma3Bridge({ host: "127.0.0.1", port: fake.port });
  try {
    await assert.rejects(bridge.request("input.press", { key: "STORE" }), (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.dispatched, false);
      assert.equal(err.code, "busy");
      assert.equal(err.op, "input.press");
      assert.deepEqual(err.detail, { code: "busy", reason: "interaction", owner: "conn-2", interaction: "i1" });
      return true;
    });
    await assert.rejects(bridge.request("input.renew", {}), (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, "no-session");
      assert.equal(err.detail, undefined);
      return true;
    });
  } finally {
    bridge.close();
    await fake.close();
  }
});
