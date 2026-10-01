import assert from "node:assert/strict";
import test from "node:test";
import { decodeEnvelope, encodeEnvelope, ENVELOPE_PREFIX, type RequestEnvelope } from "./envelope.ts";

const TO = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

const request: RequestEnvelope = {
  kind: "request",
  request_id: "req-1",
  to: TO,
  scope: "calendar.free_busy",
  purpose: "约下周的会",
  constraints: { date_from: "2026-10-05", date_to: "2026-10-09" },
};

test("request round-trips through encode and decode", () => {
  const text = encodeEnvelope(request);
  assert.equal(text.startsWith(ENVELOPE_PREFIX), true);
  assert.deepEqual(decodeEnvelope(text), request);
});

test("plain chat text is not an envelope", () => {
  assert.equal(decodeEnvelope("@Codex 你好"), null);
  assert.equal(decodeEnvelope("MAPR1 not json"), null);
});

test("uppercase or malformed recipient is rejected", () => {
  const bad = encodeEnvelope({ ...request, to: TO.toUpperCase().replace("0X", "0x") });
  assert.equal(decodeEnvelope(bad), null);
});

test("bad date range is rejected", () => {
  const bad = encodeEnvelope({ ...request, constraints: { date_from: "tomorrow", date_to: "2026-10-09" } });
  assert.equal(decodeEnvelope(bad), null);
});

test("unknown kind and unknown denial reason are rejected", () => {
  assert.equal(decodeEnvelope(`${ENVELOPE_PREFIX}{"kind":"exec","request_id":"r","to":"${TO}"}`), null);
  assert.equal(
    decodeEnvelope(`${ENVELOPE_PREFIX}{"kind":"denial","request_id":"r","to":"${TO}","reason":"because"}`),
    null
  );
});

test("extra fields on a request are dropped", () => {
  const text = `${ENVELOPE_PREFIX}${JSON.stringify({ ...request, run: "rm -rf /" })}`;
  const decoded = decodeEnvelope(text) as any;
  assert.equal(decoded.run, undefined);
});

test("task, result, verdict round-trip through encode and decode", () => {
  const task: any = {
    kind: "task",
    request_id: "task-1",
    to: TO,
    goal: "列出三个周末出游地点，每个附一句理由",
    acceptance: ["必须恰好三个地点", "每个地点附一句推荐理由"],
    round: 1,
  };
  assert.deepEqual(decodeEnvelope(encodeEnvelope(task)), task);

  const result: any = {
    kind: "result",
    request_id: "task-1",
    to: TO,
    round: 1,
    summary: "已找到三个地点：西湖、千岛湖、莫干山。",
    evidence: ["西湖风景优美", "千岛湖水质清澈"],
  };
  assert.deepEqual(decodeEnvelope(encodeEnvelope(result)), result);

  const verdict: any = {
    kind: "verdict",
    request_id: "task-1",
    to: TO,
    round: 1,
    accepted: false,
    challenge: "第一轮缺少具体理由",
  };
  assert.deepEqual(decodeEnvelope(encodeEnvelope(verdict)), verdict);

  const verdictAccepted: any = {
    kind: "verdict",
    request_id: "task-1",
    to: TO,
    round: 2,
    accepted: true,
    challenge: "",
  };
  assert.deepEqual(decodeEnvelope(encodeEnvelope(verdictAccepted)), verdictAccepted);
});

test("task validation enforces length, count and round limits", () => {
  const baseTask = {
    kind: "task",
    request_id: "task-1",
    to: TO,
    goal: "短目标",
    acceptance: ["标准1"],
    round: 1,
  };
  // goal 为 501 字时返回 null
  const longGoal = encodeEnvelope({ ...baseTask, goal: "a".repeat(501) } as any);
  assert.equal(decodeEnvelope(longGoal), null);

  // acceptance 为空数组时返回 null
  const emptyAcceptance = encodeEnvelope({ ...baseTask, acceptance: [] } as any);
  assert.equal(decodeEnvelope(emptyAcceptance), null);

  // round 为 4 时返回 null
  const round4 = encodeEnvelope({ ...baseTask, round: 4 } as any);
  assert.equal(decodeEnvelope(round4), null);

  // round 为 0 时返回 null
  const round0 = encodeEnvelope({ ...baseTask, round: 0 } as any);
  assert.equal(decodeEnvelope(round0), null);
});

test("verdict validation enforces challenge when rejected and round limits", () => {
  const baseVerdict = {
    kind: "verdict",
    request_id: "task-1",
    to: TO,
    round: 1,
    accepted: false,
    challenge: "",
  };
  // accepted 为 false 且 challenge 为空时返回 null
  assert.equal(decodeEnvelope(encodeEnvelope(baseVerdict as any)), null);
});

