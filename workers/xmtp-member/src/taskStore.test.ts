import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ResultEnvelope, TaskEnvelope, VerdictEnvelope } from "./envelope.ts";
import { TaskStore } from "./taskStore.ts";

async function freshStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tasks-"));
  const file = path.join(dir, "tasks.json");
  return { file, store: new TaskStore(file) };
}

const sampleTask: TaskEnvelope = {
  kind: "task",
  request_id: "t-101",
  to: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  goal: "推荐三个地点",
  acceptance: ["数量恰好3个"],
  round: 1,
};

test("TaskStore add is idempotent per request_id and persists across reloads", async () => {
  const { file, store } = await freshStore();
  assert.equal(await store.add(sampleTask), true);
  assert.equal(await store.add(sampleTask), false);

  const reloaded = new TaskStore(file);
  await reloaded.load();
  assert.equal(reloaded.list().length, 1);
  const found = reloaded.get("t-101");
  assert.equal(found?.request_id, "t-101");
  assert.equal(found?.status, "pending");
  assert.equal(found?.results.length, 0);
});

test("recordResult appends result and updates record", async () => {
  const { store } = await freshStore();
  await store.add(sampleTask);

  const result: ResultEnvelope = {
    kind: "result",
    request_id: "t-101",
    to: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    round: 1,
    summary: "西湖、莫干山、千岛湖",
    evidence: ["西湖优美"],
  };

  assert.equal(await store.recordResult("t-101", result), true);
  assert.equal(await store.recordResult("non-existent", result), false);

  const item = store.get("t-101");
  assert.equal(item?.results.length, 1);
  assert.deepEqual(item?.results[0], result);
});

test("recordVerdict appends verdict and transitions status", async () => {
  const { store } = await freshStore();
  await store.add(sampleTask);

  const verdict: VerdictEnvelope = {
    kind: "verdict",
    request_id: "t-101",
    to: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    round: 1,
    accepted: false,
    challenge: "缺少具体推荐理由",
  };

  assert.equal(await store.recordVerdict("t-101", verdict, "retrying"), true);
  let item = store.get("t-101");
  assert.equal(item?.status, "retrying");
  assert.equal(item?.verdicts.length, 1);

  const finalVerdict: VerdictEnvelope = {
    kind: "verdict",
    request_id: "t-101",
    to: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    round: 2,
    accepted: true,
    challenge: "",
  };
  assert.equal(await store.recordVerdict("t-101", finalVerdict, "completed"), true);
  item = store.get("t-101");
  assert.equal(item?.status, "completed");
  assert.equal(item?.verdicts.length, 2);
});

test("list returns immutable copies", async () => {
  const { store } = await freshStore();
  await store.add(sampleTask);
  const copy = store.list()[0];
  copy.status = "completed";
  assert.equal(store.get("t-101")?.status, "pending");
});
