import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConsentCard, OwnerApprovalPanel } from "./OwnerApprovalPanel";
import type { OwnerConsentDetail, OwnerConsentSummary } from "../../lib/ownerConsole";

const baseConsent: OwnerConsentSummary = {
  request_id: "req-1",
  requester: "agent-a",
  conversation_id: "conv-1",
  scope: "gmail.send",
  purpose: "给客户发送会议纪要",
  created_at: "2026-11-20T01:00:00Z",
  expires_at: "2099-01-01T00:00:00Z",
  status: "pending",
  kind: "action",
  rule_hit: "house:gmail.send=ask",
  params_meta: { keys: ["to", "subject"], preview: { to: "a@b.c", subject: "纪要" } },
};

function render(consent: OwnerConsentSummary, detail?: OwnerConsentDetail | "loading" | { error: string }) {
  return renderToStaticMarkup(
    <ConsentCard
      consent={consent}
      detail={detail}
      expanded={Boolean(detail)}
      busy={false}
      onToggleDetail={() => {}}
      onDecide={() => {}}
    />,
  );
}

describe("ConsentCard", () => {
  it("shows scope, kind, rule_hit and purpose with approve/deny for pending", () => {
    const html = render(baseConsent);
    expect(html).toContain("gmail.send");
    expect(html).toContain("外部动作");
    expect(html).toContain("给客户发送会议纪要");
    expect(html).toContain("house:gmail.send=ask");
    expect(html).toContain("批准");
    expect(html).toContain("拒绝");
  });

  it("marks trigger-sourced requests with a source badge", () => {
    const html = render({ ...baseConsent, source: "trigger" });
    expect(html).toContain("触发器发起");
  });

  it("offers Resend Receipt only while awaiting_receipt", () => {
    const html = render({ ...baseConsent, status: "awaiting_receipt", resend_count: 1 });
    expect(html).toContain("重发回执");
    expect(html).toContain("回执待送达");
    expect(html).not.toContain(">批准<");
  });

  it("renders real action params (recipient/subject/body) inside detail view only", () => {
    const detail: OwnerConsentDetail = {
      ...baseConsent,
      params: { to: "boss@corp.example", subject: "周报", body: "正文密文内容", account: "gmail-1" },
      params_hash: "abcdef0123456789deadbeef",
      account_id: "gmail-1",
    };
    const html = render(baseConsent, detail);
    expect(html).toContain("boss@corp.example");
    expect(html).toContain("正文密文内容");
    expect(html).toContain("gmail-1");
  });

  it("shows an honest manual-review note for uncertain outcomes and no retry", () => {
    const html = render({ ...baseConsent, status: "uncertain", result_status: "uncertain" });
    expect(html).toContain("结果不明");
    expect(html).toContain("不会自动重试");
    expect(html).not.toContain("重发回执");
  });

  it("renders an expired pending request as expired without decide buttons", () => {
    const html = render({ ...baseConsent, expires_at: "2000-01-01T00:00:00Z" });
    expect(html).toContain("已过期");
    expect(html).not.toContain(">批准<");
  });

  it("allows denying an approved (not yet executing) request after crash recovery (M6)", () => {
    const html = render({ ...baseConsent, status: "approved" });
    expect(html).toContain(">拒绝<");
    expect(html).not.toContain(">批准<");
  });
});

describe("OwnerApprovalPanel", () => {
  it("renders the shell; data loads async via loopback consoles", () => {
    const html = renderToStaticMarkup(
      <OwnerApprovalPanel roomId="room-1" fetchImpl={fetch} listSeats={async () => []} pollMs={0} />,
    );
    expect(html).toContain("审批只在你本机助手的控制台完成");
    expect(html).toContain("不经过 Hub");
  });
});
