import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConsentQueue } from "./consentQueue.ts";
import { decodeEnvelope, encodeEnvelope, type TaskEnvelope, type ResultEnvelope, type VerdictEnvelope } from "./envelope.ts";
import { handleEnvelope, type HandleEnvelopeDeps } from "./handleEnvelope.ts";
import type { LedgerEntry } from "./ledger.ts";
import { normalizePolicy } from "./policy.ts";
import { TaskStore } from "./taskStore.ts";

const COORDINATOR = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const EXECUTOR = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const NOW = new Date("2026-10-01T08:00:00Z");

async function setupFlow() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "coord-flow-"));
  const taskStore = new TaskStore(path.join(dir, "tasks.json"));
  await taskStore.load();
  const queue = new ConsentQueue(path.join(dir, "consents.json"));
  const sent: { conv: string; text: string }[] = [];
  const ledger: LedgerEntry[] = [];

  const send = async (conv: string, text: string) => {
    sent.push({ conv, text });
  };
  const appendLedger = async (e: LedgerEntry) => {
    ledger.push(e);
  };

  return { dir, taskStore, queue, sent, ledger, send, appendLedger };
}

test("three rejected rounds escalate without dispatching round four", async () => {
  const s = await setupFlow();
  const task: TaskEnvelope = { kind: "task", request_id: "three-rounds", to: EXECUTOR,
    goal: "synthetic", acceptance: ["synthetic"], round: 1 };
  await s.taskStore.add(task);
  const deps: HandleEnvelopeDeps = { selfAddress: COORDINATOR, policy: normalizePolicy({}),
    queue: s.queue, taskStore: s.taskStore, completeModel: async () => '{"accepted":false,"challenge":"retry"}',
    send: s.send, appendLedger: s.appendLedger, storeDisclosure: async () => true, now: () => NOW };
  for (const round of [1, 2, 3]) await handleEnvelope({ sender: EXECUTOR, conversationId: "c1",
    envelope: { kind: "result", request_id: task.request_id, to: COORDINATOR, round,
      summary: "synthetic", evidence: [] } }, deps);
  assert.equal(s.taskStore.get(task.request_id)?.status, "escalated");
  assert.deepEqual(s.sent.map(s => decodeEnvelope(s.text)).filter(e => e?.kind === "task").map(e => e?.round), [2, 3]);
});

test("wrong executor and stale results do not call the verdict model", async () => {
  const s = await setupFlow();
  const task: TaskEnvelope = { kind: "task", request_id: "bound-result", to: EXECUTOR,
    goal: "synthetic", acceptance: ["synthetic"], round: 1 };
  await s.taskStore.add(task);
  let calls = 0;
  const deps: HandleEnvelopeDeps = { selfAddress: COORDINATOR, policy: normalizePolicy({}),
    queue: s.queue, taskStore: s.taskStore, completeModel: async () => { calls++; return '{"accepted":true}'; },
    send: s.send, appendLedger: s.appendLedger, storeDisclosure: async () => true, now: () => NOW };
  const envelope: ResultEnvelope = { kind: "result", request_id: task.request_id, to: COORDINATOR,
    round: 1, summary: "synthetic", evidence: [] };
  assert.equal(await handleEnvelope({ sender: COORDINATOR, conversationId: "c1", envelope }, deps), "ignored");
  await handleEnvelope({ sender: EXECUTOR, conversationId: "c1", envelope }, deps);
  await handleEnvelope({ sender: EXECUTOR, conversationId: "c1", envelope }, deps);
  assert.equal(calls, 1);
});

test("executor denies task when sender has no task.run permission and does not call model", async () => {
  const s = await setupFlow();
  let modelCalls = 0;

  const executorDeps: HandleEnvelopeDeps = {
    selfAddress: EXECUTOR,
    policy: normalizePolicy({ allow: {} }), // 未授权 task.run
    queue: s.queue,
    completeModel: async () => {
      modelCalls += 1;
      return "dummy";
    },
    send: s.send,
    appendLedger: s.appendLedger,
    storeDisclosure: async () => true,
    now: () => NOW,
  };

  const taskEnv: TaskEnvelope = {
    kind: "task",
    request_id: "t-1",
    to: EXECUTOR,
    goal: "推荐三个地点",
    acceptance: ["地点数量恰好为3个"],
    round: 1,
  };

  const outcome = await handleEnvelope(
    { envelope: taskEnv, sender: COORDINATOR, conversationId: "c1" },
    executorDeps
  );

  assert.equal(outcome, "denied");
  assert.equal(modelCalls, 0); // 断言模型调用次数为 0
  assert.equal(s.sent.length, 1);
  assert.deepEqual(decodeEnvelope(s.sent[0].text), {
    kind: "denial",
    request_id: "t-1",
    to: COORDINATOR,
    reason: "out_of_scope",
  });
});

test("executor executes task and replies with result when task.run is allowed", async () => {
  const s = await setupFlow();
  let modelCalls = 0;

  const executorDeps: HandleEnvelopeDeps = {
    selfAddress: EXECUTOR,
    policy: normalizePolicy({
      allow: { [COORDINATOR]: ["task.run"] },
    }),
    queue: s.queue,
    completeModel: async (prompt) => {
      modelCalls += 1;
      return JSON.stringify({
        summary: "推荐西湖、莫干山、千岛湖",
        evidence: ["西湖湖景优美", "莫干山竹林清幽", "千岛湖水质清澈"],
      });
    },
    send: s.send,
    appendLedger: s.appendLedger,
    storeDisclosure: async () => true,
    now: () => NOW,
  };

  const taskEnv: TaskEnvelope = {
    kind: "task",
    request_id: "t-2",
    to: EXECUTOR,
    goal: "推荐三个地点",
    acceptance: ["地点数量恰好为3个"],
    round: 1,
  };

  const outcome = await handleEnvelope(
    { envelope: taskEnv, sender: COORDINATOR, conversationId: "c1" },
    executorDeps
  );

  assert.equal(outcome, "task_executed");
  assert.equal(modelCalls, 1);
  assert.equal(s.sent.length, 1);
  const decoded = decodeEnvelope(s.sent[0].text) as ResultEnvelope;
  assert.equal(decoded.kind, "result");
  assert.equal(decoded.request_id, "t-2");
  assert.equal(decoded.to, COORDINATOR);
  assert.equal(decoded.round, 1);
  assert.equal(decoded.summary, "推荐西湖、莫干山、千岛湖");
});

test("coordinator processes result, rejects round 1, and sends retry task", async () => {
  const s = await setupFlow();
  const taskEnv: TaskEnvelope = {
    kind: "task",
    request_id: "t-3",
    to: EXECUTOR,
    goal: "推荐三个地点",
    acceptance: ["地点数量恰好为3个"],
    round: 1,
  };
  await s.taskStore.add(taskEnv);

  const coordDeps: HandleEnvelopeDeps = {
    selfAddress: COORDINATOR,
    policy: normalizePolicy({}),
    queue: s.queue,
    taskStore: s.taskStore,
    completeModel: async () => JSON.stringify({ accepted: false, challenge: "数量只有两个，不足三个" }),
    send: s.send,
    appendLedger: s.appendLedger,
    storeDisclosure: async () => true,
    now: () => NOW,
  };

  const resultEnv: ResultEnvelope = {
    kind: "result",
    request_id: "t-3",
    to: COORDINATOR,
    round: 1,
    summary: "推荐西湖、莫干山两个地点",
    evidence: [],
  };

  const outcome = await handleEnvelope(
    { envelope: resultEnv, sender: EXECUTOR, conversationId: "c1" },
    coordDeps
  );

  assert.equal(outcome, "verdict_processed");
  // 发出了 verdict 和 round 2 的 task
  assert.equal(s.sent.length, 2);
  const verdict = decodeEnvelope(s.sent[0].text) as VerdictEnvelope;
  assert.equal(verdict.kind, "verdict");
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.challenge, "数量只有两个，不足三个");

  const nextTask = decodeEnvelope(s.sent[1].text) as TaskEnvelope;
  assert.equal(nextTask.kind, "task");
  assert.equal(nextTask.round, 2);

  // 账本包含 verdict_sent (rejected) 和 task_sent
  assert.equal(s.ledger.some((e) => e.kind === "verdict_sent" && e.reason === "rejected"), true);
  assert.equal(s.ledger.some((e) => e.kind === "task_sent"), true);
});

test("coordinator accepts result and marks task completed", async () => {
  const s = await setupFlow();
  const taskEnv: TaskEnvelope = {
    kind: "task",
    request_id: "t-4",
    to: EXECUTOR,
    goal: "推荐三个地点",
    acceptance: ["地点数量恰好为3个"],
    round: 2,
  };
  await s.taskStore.add(taskEnv);

  const coordDeps: HandleEnvelopeDeps = {
    selfAddress: COORDINATOR,
    policy: normalizePolicy({}),
    queue: s.queue,
    taskStore: s.taskStore,
    completeModel: async () => JSON.stringify({ accepted: true, challenge: "" }),
    send: s.send,
    appendLedger: s.appendLedger,
    storeDisclosure: async () => true,
    now: () => NOW,
  };

  const resultEnv: ResultEnvelope = {
    kind: "result",
    request_id: "t-4",
    to: COORDINATOR,
    round: 2,
    summary: "推荐西湖、莫干山、千岛湖",
    evidence: ["三个地点齐全"],
  };

  const outcome = await handleEnvelope(
    { envelope: resultEnv, sender: EXECUTOR, conversationId: "c1" },
    coordDeps
  );

  assert.equal(outcome, "verdict_processed");
  assert.equal(s.sent.length, 1);
  const verdict = decodeEnvelope(s.sent[0].text) as VerdictEnvelope;
  assert.equal(verdict.accepted, true);
  assert.equal(s.taskStore.get("t-4")?.status, "completed");
  assert.equal(s.ledger.some((e) => e.kind === "verdict_sent" && e.reason === "accepted"), true);
});
