import assert from "node:assert/strict";
import test from "node:test";
import type { TaskEnvelope } from "./envelope.ts";
import { buildResult, buildTaskPrompt } from "./executor.ts";

const COORDINATOR = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const EXECUTOR = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

const task: TaskEnvelope = {
  kind: "task",
  request_id: "task-101",
  to: EXECUTOR,
  goal: "推荐三个周末徒步地点",
  acceptance: ["地点数量必须恰好为3个", "每个地点附带一句风景特色"],
  round: 1,
};

test("buildTaskPrompt contains goal, acceptance criteria and round number", () => {
  const prompt = buildTaskPrompt(task);
  assert.equal(prompt.includes("推荐三个周末徒步地点"), true);
  assert.equal(prompt.includes("地点数量必须恰好为3个"), true);
  assert.equal(prompt.includes("每个地点附带一句风景特色"), true);
  assert.equal(prompt.includes("第 1 轮"), true);
});

test("buildTaskPrompt does not leak local calendar secrets", () => {
  const prompt = buildTaskPrompt(task);
  for (const secret of ["绝密", "离婚协议", "房产证", "律师"]) {
    assert.equal(prompt.includes(secret), false, secret);
  }
});

test("buildResult parses structured JSON model text", () => {
  const modelText = JSON.stringify({
    summary: "推荐西湖、莫干山、千岛湖",
    evidence: ["西湖湖景优美", "莫干山竹林清幽", "千岛湖水质清澈"],
  });
  const result = buildResult(task, modelText, COORDINATOR);
  assert.equal(result.kind, "result");
  assert.equal(result.request_id, "task-101");
  assert.equal(result.to, COORDINATOR);
  assert.equal(result.round, 1);
  assert.equal(result.summary, "推荐西湖、莫干山、千岛湖");
  assert.deepEqual(result.evidence, ["西湖湖景优美", "莫干山竹林清幽", "千岛湖水质清澈"]);
});

test("buildResult falls back to plain text when model output is not JSON", () => {
  const plainText = "西湖、莫干山、千岛湖是极佳的徒步选择。";
  const result = buildResult(task, plainText, COORDINATOR);
  assert.equal(result.kind, "result");
  assert.equal(result.request_id, "task-101");
  assert.equal(result.to, COORDINATOR);
  assert.equal(result.round, 1);
  assert.equal(result.summary, plainText);
  assert.deepEqual(result.evidence, []);
});
