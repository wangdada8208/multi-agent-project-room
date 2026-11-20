import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConsentQueue, MAX_PENDING_ITEMS, MAX_PENDING_PER_REQUESTER, MAX_QUEUE_ITEMS } from "./consentQueue.ts";

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
  assert.equal(await queue.add(item), "added");
  assert.equal(await queue.add(item), "duplicate");
  const reloaded = new ConsentQueue(file);
  await reloaded.load();
  assert.equal(reloaded.list().length, 1);
  assert.equal(reloaded.get("req-1")?.status, "pending");
});

test("claim approves once; a concurrent second approve gets null (approved→denied stays legal)", async () => {
  const { queue } = await freshQueue();
  await queue.add(item);
  const [a, b] = await Promise.all([queue.claim("req-1", "approved"), queue.claim("req-1", "approved")]);
  // 两个并发 approve 只有一个赢——approved→approved 不在 TRANSITIONS 里
  assert.equal([a, b].filter((x) => x !== null).length, 1);
  assert.equal(queue.get("req-1")?.status, "approved");
  // 但 approved→denied 是合法后续转移（M6：主人可收回未开始的批准）
  assert.equal((await queue.claim("req-1", "denied"))?.status, "denied");
});

test("state machine rejects illegal transitions", async () => {
  const { queue } = await freshQueue();
  await queue.add(item);
  // 终态不可再迁出；pending 不能直飞 executing/awaiting_receipt
  assert.equal(await queue.transition("req-1", "executing"), null);
  assert.equal((await queue.claim("req-1", "approved"))?.status, "approved");
  assert.equal(await queue.transition("req-1", "executing", new Date(), { attempt_at: "t" }) !== null, true);
  assert.equal(await queue.transition("req-1", "pending"), null); // executing 不能回 pending
  assert.equal((await queue.transition("req-1", "awaiting_receipt", new Date(), { outbox: "MAPR1 x" }))?.status, "awaiting_receipt");
  assert.equal(await queue.transition("req-1", "approved"), null);
  assert.equal((await queue.transition("req-1", "completed"))?.status, "completed");
  assert.equal(await queue.claim("req-1", "denied"), null); // 终态不可再改
});

test("recoverAfterLoad turns stuck executing into uncertain, keeps awaiting_receipt resendable", async () => {
  const { queue } = await freshQueue();
  await queue.add(item);
  await queue.claim("req-1", "approved");
  await queue.transition("req-1", "executing", new Date(), { attempt_at: new Date().toISOString() });
  await queue.add({ ...item, request_id: "req-2" });
  await queue.claim("req-2", "approved");
  await queue.transition("req-2", "awaiting_receipt", new Date(), { outbox: "MAPR1 x", result_status: "executed" });
  const recovered = await queue.recoverAfterLoad();
  assert.deepEqual(recovered.map((r) => r.request_id), ["req-1"]);
  assert.equal(queue.get("req-1")?.status, "uncertain");
  assert.equal(queue.get("req-2")?.status, "awaiting_receipt");
  assert.equal(queue.pendingReceipts().map((p) => p.request_id).join(), "req-2");
});

test("corrupt created_at does not crash load; corrupt status fails safe", async () => {
  const { file, queue } = await freshQueue();
  await writeFile(file, JSON.stringify([
    { ...item, created_at: "not-a-date" },
    { ...item, request_id: "req-bad", kind: "action", status: "garbage" },
    { ...item, request_id: "req-bad2", kind: "data", status: "garbage" },
  ]));
  await queue.load();
  assert.equal(queue.get("req-1")?.created_at, "1970-01-01T00:00:00.000Z");
  assert.equal(queue.get("req-bad")?.status, "uncertain"); // action 不回可重放轨道
  assert.equal(queue.get("req-bad2")?.status, "pending");
});

test("corrupt queue JSON refuses to load instead of erasing action history", async () => {
  const { file, queue } = await freshQueue();
  await writeFile(file, "{not-json");
  await assert.rejects(queue.load(), /corrupt/i);
});

test("queue caps: per-requester and global pending limits return full", async () => {
  const { queue } = await freshQueue();
  for (let i = 0; i < MAX_PENDING_PER_REQUESTER; i++) {
    assert.equal(await queue.add({ ...item, request_id: `r-${i}` }), "added");
  }
  assert.equal(await queue.add({ ...item, request_id: "r-overflow" }), "full"); // 每 requester 50 封顶
  // 全局上限 200：再塞 3 个 requester 各 50 条 → 200，第 201 条拒
  for (let a = 0; a < 3; a++) {
    const requester = `0xaaaaaaaabbbbbbbbccccccccddddddddeeeee${a.toString().padStart(3, "0")}`;
    for (let i = 0; i < MAX_PENDING_PER_REQUESTER; i++) {
      assert.equal(await queue.add({ ...item, request_id: `o-${a}-${i}`, requester }), "added");
    }
  }
  const newGuy = { ...item, request_id: "o-overflow", requester: "0x1111111111111111111111111111111111111111" };
  assert.equal(await queue.add(newGuy), "full");
});

test("queue overflow never evicts approved or executing work", async () => {
  const { file, queue } = await freshQueue();
  await writeFile(file, JSON.stringify(Array.from({ length: MAX_QUEUE_ITEMS }, (_, i) => ({
    ...item,
    request_id: `active-${i}`,
    kind: "action",
    status: i % 2 === 0 ? "approved" : "executing",
    expires_at: "2099-01-01T00:00:00.000Z",
  }))));
  await queue.load();
  assert.equal(await queue.add({ ...item, request_id: "req-new" }), "full");
  assert.equal(queue.get("active-0")?.status, "approved");
  assert.equal(queue.get("active-1")?.status, "executing");
  assert.equal(queue.get("req-new"), null);
});

test("denyAllPendingForRequester cancels only unstarted work in the revoked conversation", async () => {
  const { queue } = await freshQueue();
  await queue.add(item);
  await queue.add({ ...item, request_id: "req-2" });
  await queue.claim("req-2", "approved");
  await queue.add({ ...item, request_id: "req-3" });
  await queue.claim("req-3", "approved");
  await queue.transition("req-3", "executing");
  await queue.add({ ...item, request_id: "req-4", requester: "0x1111111111111111111111111111111111111111" });
  await queue.add({ ...item, request_id: "req-5", conversation_id: "dm-1" });
  await queue.add({ ...item, request_id: "req-6" });
  await queue.claim("req-6", "approved");
  await queue.transition("req-6", "awaiting_receipt", new Date(), { outbox: "MAPR1 receipt" });
  const ids = await queue.denyAllPendingForRequester(item.requester, item.conversation_id, new Date());
  assert.deepEqual(ids.sort(), ["req-1", "req-2"]);
  assert.equal(queue.get("req-1")?.status, "denied");
  assert.equal(queue.get("req-2")?.status, "denied");
  assert.equal(queue.get("req-3")?.status, "executing");
  assert.equal(queue.get("req-4")?.status, "pending");
  assert.equal(queue.get("req-5")?.status, "pending");
  assert.equal(queue.get("req-6")?.status, "awaiting_receipt");
});

test("M6: claim can deny an approved-not-started item, but never executing or later", async () => {
  const { queue } = await freshQueue();
  await queue.add(item);
  await queue.claim("req-1", "approved");
  assert.equal((await queue.claim("req-1", "denied"))?.status, "denied");
  assert.equal(queue.get("req-1")?.status, "denied");

  // 已开始执行（executing 起）与待回执/终态一律不能再拒
  for (const [id, target] of [
    ["req-2", "executing"],
    ["req-3", "awaiting_receipt"],
    ["req-4", "completed"],
    ["req-5", "uncertain"],
  ] as const) {
    await queue.add({ ...item, request_id: id });
    await queue.claim(id, "approved");
    if (target === "executing") {
      await queue.transition(id, "executing");
    } else if (target === "awaiting_receipt") {
      await queue.transition(id, "executing");
      await queue.transition(id, "awaiting_receipt", new Date(), { outbox: "MAPR1 x" });
    } else if (target === "completed") {
      await queue.transition(id, "executing");
      await queue.transition(id, "awaiting_receipt", new Date(), { outbox: "MAPR1 x" });
      await queue.transition(id, "completed");
    } else {
      await queue.transition(id, "executing");
      await queue.transition(id, "uncertain");
    }
    assert.equal(await queue.claim(id, "denied"), null, `${id}@${target}`);
    assert.equal(queue.get(id)?.status, target);
  }
});

test("M1: pendingReceipts covers uncertain+outbox; patchUncertainReceipt writes receipt fields only", async () => {
  const { file, queue } = await freshQueue();
  await writeFile(file, JSON.stringify([
    { ...item, kind: "action", status: "uncertain" },
    { ...item, request_id: "req-2", kind: "action", status: "awaiting_receipt", outbox: "MAPR1 x" },
    { ...item, request_id: "req-3", kind: "action", status: "uncertain", outbox: "MAPR1 y" },
  ]));
  await queue.load();
  // uncertain 无 outbox 的不算；awaiting_receipt 与 uncertain+outbox 都在重发口
  assert.deepEqual(queue.pendingReceipts().map((i) => i.request_id).sort(), ["req-2", "req-3"]);

  const patched = await queue.patchUncertainReceipt("req-3", {
    outbox: "MAPR1 fresh",
    outbox_at: "2026-11-20T00:00:00.000Z",
    resend_count: 0,
    result_status: "uncertain",
    result_summary: "execution_interrupted_verify_manually",
  });
  assert.equal(patched?.status, "uncertain"); // 终态永不被改
  assert.equal(patched?.outbox, "MAPR1 fresh");
  // 非 uncertain 一律 null——不给任何回到可重放轨道的缝
  assert.equal(await queue.patchUncertainReceipt("req-2", { outbox: "MAPR1 z" }), null);
  assert.equal(queue.get("req-2")?.outbox, "MAPR1 x");
  // patch 不碰 status/patch 外字段；送达后清 outbox 即退出重发口
  await queue.patchUncertainReceipt("req-3", { outbox: undefined, outbox_at: undefined });
  assert.equal(queue.get("req-3")?.outbox, undefined);
  assert.equal(queue.get("req-3")?.status, "uncertain");
  assert.deepEqual(queue.pendingReceipts().map((i) => i.request_id), ["req-2"]);
});

test("dueForExpiry covers pending and approved-not-started items", async () => {
  const { queue } = await freshQueue();
  await queue.add(item);
  await queue.add({ ...item, request_id: "req-2", created_at: "2026-10-01T07:59:00.000Z" });
  await queue.claim("req-2", "approved");
  const due = queue.dueForExpiry(new Date("2026-10-01T08:10:00.000Z"));
  assert.deepEqual(due.map((d) => d.request_id).sort(), ["req-1", "req-2"]);
});

test("saved file is 0600 with a parent dir tightened to 0700", async () => {
  const { file, queue } = await freshQueue();
  await queue.add(item);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
});

test("list returns copies that cannot mutate the queue", async () => {
  const { queue } = await freshQueue();
  await queue.add(item);
  queue.list()[0].status = "approved";
  assert.equal(queue.get("req-1")?.status, "pending");
});
