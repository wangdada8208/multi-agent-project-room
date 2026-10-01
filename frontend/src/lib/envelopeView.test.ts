import { describe, expect, it } from "vitest";
import { describeEnvelope } from "./envelopeView";

const TO = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

describe("describeEnvelope", () => {
  it("leaves normal chat alone", () => {
    expect(describeEnvelope("你好")).toBeNull();
  });

  it("summarises a request", () => {
    const text = "MAPR1 " + JSON.stringify({
      kind: "request", request_id: "r", to: TO, scope: "calendar.free_busy", purpose: "",
      constraints: { date_from: "2026-10-05", date_to: "2026-10-09" },
    });
    expect(describeEnvelope(text)).toBe("【请求】向 0x7099…79c8 申请 calendar.free_busy（2026-10-05 到 2026-10-09）");
  });

  it("summarises a disclosure without printing the slots", () => {
    const text = "MAPR1 " + JSON.stringify({
      kind: "disclosure", request_id: "r", to: TO, grant: {}, signature: "0x",
      payload: { scope: "calendar.free_busy", date_from: "2026-10-05", date_to: "2026-10-09",
        busy: [{ start: "2026-10-06T09:00:00.000Z", end: "2026-10-06T10:00:00.000Z" }] },
    });
    const view = describeEnvelope(text)!;
    expect(view).toContain("共 1 个忙碌时段");
    expect(view).not.toContain("09:00");
  });

  it("summarises email.receipt disclosure", () => {
    const text = "MAPR1 " + JSON.stringify({
      kind: "disclosure", request_id: "r", to: TO, grant: {}, signature: "0x",
      payload: { scope: "email.receipt", subject: "12306 购票成功通知" },
    });
    const view = describeEnvelope(text)!;
    expect(view).toBe("【已披露收据】发给 0x7099…79c8：12306 购票成功通知");
  });

  it("summarises task, result and verdict", () => {
    const taskText = "MAPR1 " + JSON.stringify({
      kind: "task", request_id: "t", to: TO, goal: "查找出游地点", round: 1,
    });
    expect(describeEnvelope(taskText)).toContain("【派单】向 0x7099…79c8 派发任务：查找出游地点（第 1 轮）");

    const resultText = "MAPR1 " + JSON.stringify({
      kind: "result", request_id: "t", to: TO, round: 1, summary: "推荐三个地点",
    });
    expect(describeEnvelope(resultText)).toContain("【成果】向 0x7099…79c8 提交第 1 轮成果：推荐三个地点");

    const verdictPass = "MAPR1 " + JSON.stringify({
      kind: "verdict", request_id: "t", to: TO, round: 1, accepted: true,
    });
    expect(describeEnvelope(verdictPass)).toContain("【裁决】向 0x7099…79c8 裁决：验收通过");

    const verdictFail = "MAPR1 " + JSON.stringify({
      kind: "verdict", request_id: "t", to: TO, round: 1, accepted: false, challenge: "数量不够",
    });
    expect(describeEnvelope(verdictFail)).toContain("【裁决】向 0x7099…79c8 裁决：质疑 - 数量不够");
  });

  it("labels denial reasons in Chinese and survives garbage", () => {
    expect(describeEnvelope("MAPR1 " + JSON.stringify({ kind: "denial", request_id: "r", to: TO, reason: "out_of_scope" }))).toBe("【拒绝】超出授权范围");
    expect(describeEnvelope("MAPR1 {bad")).toBe("【无法识别的结构化消息】");
  });
});
