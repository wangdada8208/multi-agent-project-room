// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomTemplateInfo } from "../../lib/api";
import { TemplateRulesPreview } from "./TemplateRulesPreview";

const template: RoomTemplateInfo = {
  id: "tpl-1",
  key: "code_review",
  name: "代码评审",
  description: "两个 Agent 互相审查代码",
  icon: "🔍",
  team_config_markdown: "### 审查者 Reviewer\n- 代码审查、安全检查、性能分析\n",
  house_rules: {
    scopes: {
      "calendar.free_busy": "ask",
      "email.receipt": "ask",
      "task.run": "ask",
      "gmail.send": "cannot",
    },
    notes: ["评审房间默认不对外发信。"],
  },
  default_max_rounds: 2,
};

describe("TemplateRulesPreview human summary", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root.render(
        <TemplateRulesPreview
          template={template}
          draft={null}
          customizing={false}
          onToggleCustomizing={() => {}}
          onChangeDraft={() => {}}
        />,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("shows only two or three short human-language summaries by default", () => {
    const items = [...host.querySelectorAll(".wb-preview-summary li")];
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items.length).toBeLessThanOrEqual(3);
    const text = items.map((item) => item.textContent).join("\n");
    expect(text).toContain("两个助手互相审查代码");
    expect(text).toContain("查看或使用你的其他账号前，都会先问你");
    expect(text).toContain("不会替你对外发邮件");
    expect(text).not.toContain("Agent");
    expect(text).not.toContain("calendar.free_busy");
    expect(text).not.toContain("gmail.send");
    expect(text).not.toContain("查看日程空闲");
  });

  it("keeps machine scopes inside a closed advanced details section with separate labels and codes", () => {
    const details = host.querySelector("details.wb-preview-advanced");
    expect(details).not.toBeNull();
    expect(details?.hasAttribute("open")).toBe(false);
    expect(details?.textContent).toContain("calendar.free_busy");
    expect(details?.textContent).toContain("gmail.send");

    const rule = details?.querySelector(".wb-preview-rule__scope");
    expect(rule?.querySelector(".wb-preview-rule__label")?.textContent).toBe("查看日程空闲");
    expect(rule?.querySelector("code")?.textContent).toBe("calendar.free_busy");
  });
});
