import assert from "node:assert/strict";
import test from "node:test";
import { buildVerdictPrompt, nextStep, parseVerdict } from "./coordinator.ts";
import type { ResultEnvelope, TaskEnvelope } from "./envelope.ts";

const task: TaskEnvelope = {
  kind: "task",
  request_id: "t-1",
  to: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  goal: "推荐三个周末徒步地点",
  acceptance: ["地点数量必须恰好为3个", "每个地点附带一句风景特色"],
  round: 1,
};

const result: ResultEnvelope = {
  kind: "result",
  request_id: "t-1",
  to: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  round: 1,
  summary: "推荐西湖、莫干山两个地点。",
  evidence: ["西湖湖景优美", "莫干山竹林清幽"],
};

test("buildVerdictPrompt combines task goal, acceptance criteria and executor result", () => {
  const prompt = buildVerdictPrompt(task, result);
  assert.equal(prompt.includes("推荐三个周末徒步地点"), true);
  assert.equal(prompt.includes("地点数量必须恰好为3个"), true);
  assert.equal(prompt.includes("推荐西湖、莫干山两个地点。"), true);
  assert.equal(prompt.includes('{"accepted": true|false, "challenge": "..."}'), true);
});

test("parseVerdict accepts valid json and rejects malformed fields", () => {
  assert.deepEqual(parseVerdict('{"accepted": true, "challenge": ""}'), {
    accepted: true,
    challenge: "",
  });
  assert.deepEqual(parseVerdict('{"accepted": false, "challenge": "地点数量不足三个"}'), {
    accepted: false,
    challenge: "地点数量不足三个",
  });
  // 拒绝 accepted 为字符串的情况
  assert.equal(parseVerdict('{"accepted": "true", "challenge": ""}'), null);
  // 拒绝缺少 accepted 字段
  assert.equal(parseVerdict('{"challenge": "理由"}'), null);
  // 拒绝非 JSON 字符串
  assert.equal(parseVerdict("not a json"), null);
  // 拒绝 accepted 为 false 时 challenge 为空
  assert.equal(parseVerdict('{"accepted": false, "challenge": ""}'), null);
});

test("nextStep returns done on accept, retry on round < 3 rejection, escalate on round 3", () => {
  // round 1 接受 -> done
  assert.equal(nextStep(task, { accepted: true, challenge: "" }), "done");

  // round 1 被拒 -> retry
  assert.equal(nextStep(task, { accepted: false, challenge: "数量不足" }), "retry");

  // round 2 被拒 -> retry
  assert.equal(nextStep({ ...task, round: 2 }, { accepted: false, challenge: "数量不足" }), "retry");

  // round 3 被拒 -> escalate
  assert.equal(nextStep({ ...task, round: 3 }, { accepted: false, challenge: "数量不足" }), "escalate");

  // round 3 接受 -> done
  assert.equal(nextStep({ ...task, round: 3 }, { accepted: true, challenge: "" }), "done");
});
