import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { MutationLock } from "../src/mutations.ts";

test("MutationLock runs queued mutations one at a time in FIFO order", async () => {
  const lock = new MutationLock();
  const order: string[] = [];
  const job = (name: string, ms: number) =>
    lock.run(async () => {
      order.push(`${name}:start`);
      assert.equal(lock.busy, true);
      await sleep(ms);
      order.push(`${name}:end`);
      return name;
    });
  const results = await Promise.all([job("a", 30), job("b", 5), job("c", 1)]);
  assert.deepEqual(results, ["a", "b", "c"]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  assert.equal(lock.busy, false);
});

test("a failing mutation releases the lock for the next one", async () => {
  const lock = new MutationLock();
  await assert.rejects(
    lock.run(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(await lock.run(async () => 42), 42);
  assert.equal(lock.busy, false);
});
