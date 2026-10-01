import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConsentQueue } from "./consentQueue.ts";

async function freshQueue() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "consents-"));
  return { file: path.join(dir, "consents.json"), queue: new ConsentQueue(path.join(dir, "consents.json")) };
}

const item = {
  request_id: "req-1",
  requester: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  conversation_id: "conv-1",
  scope: "calendar.free_busy",
  purpose: "约会",
  constraints: { date_from: "2026-10-05", date_to: "2026-10-09" },
  created_at: "2026-10-01T08:00:00.000Z",
};

test("add is idempotent per request_id and persists across reloads", async () => {
  const { file, queue } = await freshQueue();
  assert.equal(await queue.add(item), true);
  assert.equal(await queue.add(item), false);
  const reloaded = new ConsentQueue(file);
  await reloaded.load();
  assert.equal(reloaded.list().length, 1);
  assert.equal(reloaded.get("req-1")?.status, "pending");
});

test("claim works once; the second concurrent claim gets null", async () => {
  const { queue } = await freshQueue();
  await queue.add(item);
  const [a, b] = await Promise.all([queue.claim("req-1", "approved"), queue.claim("req-1", "denied")]);
  assert.equal(a?.status, "approved");
  assert.equal(b, null);
  assert.equal(queue.get("req-1")?.status, "approved");
});

test("dueForExpiry lists only old pending items", async () => {
  const { queue } = await freshQueue();
  await queue.add(item);
  await queue.add({ ...item, request_id: "req-2", created_at: "2026-10-01T08:09:00.000Z" });
  const due = queue.dueForExpiry(new Date("2026-10-01T08:10:00.000Z"), 10 * 60 * 1000);
  assert.deepEqual(due.map((d) => d.request_id), ["req-1"]);
});

test("list returns copies that cannot mutate the queue", async () => {
  const { queue } = await freshQueue();
  await queue.add(item);
  queue.list()[0].status = "approved";
  assert.equal(queue.get("req-1")?.status, "pending");
});
