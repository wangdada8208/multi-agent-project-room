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

  it("labels denial reasons in Chinese and survives garbage", () => {
    expect(describeEnvelope("MAPR1 " + JSON.stringify({ kind: "denial", request_id: "r", to: TO, reason: "out_of_scope" }))).toBe("【拒绝】超出授权范围");
    expect(describeEnvelope("MAPR1 {bad")).toBe("【无法识别的结构化消息】");
  });
});
