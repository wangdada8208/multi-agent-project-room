// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "../stores/authStore";
import { LandingPage } from "./LandingPage";

describe("LandingPage", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    useAuthStore.getState().logout();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function mountLanding() {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <MemoryRouter initialEntries={["/"]}>
          <LandingPage />
        </MemoryRouter>,
      );
    });
    return {
      host,
      unmount: () => {
        act(() => root.unmount());
        host.remove();
      },
    };
  }

  it("renders hero, both Agent kinds, safety grid, templates, and keeps agents.txt in footer", () => {
    const { host, unmount } = mountLanding();
    try {
      expect(host.textContent).toContain("一个人先把 Agent 带进房间，");
      expect(host.textContent).toContain("随时拉人变成团队项目房。");
      expect(host.textContent).toContain("单人工作台");
      expect(host.textContent).toContain("团队项目房");
      expect(host.textContent).toContain("手机上也能直接拉起云端 Agent");
      expect(host.textContent).toContain("电脑端 Agent 在你电脑上运行");
      expect(host.textContent).toContain("谁能进房，你说了算");
      expect(host.textContent).toContain("常用场景模板");

      const hero = host.querySelector(".lp-hero")!;
      expect(hero.querySelector('a[href="/agents.txt"]')).toBeNull();
      const footer = host.querySelector(".lp-foot")!;
      expect(footer.querySelector('a[href="/agents.txt"]')).not.toBeNull();
    } finally {
      unmount();
    }
  });

  it("switches between solo multi-agent and team room previews", () => {
    const { host, unmount } = mountLanding();
    try {
      expect(host.textContent).toContain("个人发布冲刺");
      expect(host.textContent).toContain("一个人的多个 Agent 也在同一个加密房间里分工。");
      expect(host.textContent).not.toContain("支付回调评审");

      const teamTab = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("团队项目房"))!;
      act(() => {
        teamTab.click();
      });

      expect(host.textContent).toContain("支付回调评审");
      expect(host.textContent).toContain("私密代码留在本机，密文不进 Hub 日志。");
      expect(host.textContent).toContain("Muse 申请加入房间");

      const soloTab = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("单人工作台"))!;
      act(() => {
        soloTab.click();
      });
      expect(host.textContent).toContain("个人发布冲刺");
    } finally {
      unmount();
    }
  });

  it("approves Muse interactively inside ScenePreview and updates sidebar status", () => {
    const { host, unmount } = mountLanding();
    try {
      const teamTab = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("团队项目房"))!;
      act(() => {
        teamTab.click();
      });
      const museRow = host.querySelector('[data-testid="preview-member-muse"]')!;
      expect(museRow.textContent).toContain("待审批");
      expect(host.textContent).toContain("Muse 申请加入房间");

      const approveBtn = Array.from(host.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "批准入房",
      )!;
      act(() => {
        approveBtn.click();
      });

      expect(host.textContent).toContain("Muse 已加入房间");
      expect(museRow.textContent).not.toContain("待审批");
      expect(museRow.querySelector(".lp-dot--online")).not.toBeNull();
    } finally {
      unmount();
    }
  });

  it("links primary CTA to /login?next=%2Fhome when logged out and /home when logged in", () => {
    const first = mountLanding();
    try {
      const heroCta = first.host.querySelector<HTMLAnchorElement>(".lp-hero .lp-cta a.ui-button--primary")!;
      expect(heroCta.getAttribute("href")).toBe("/login?next=%2Fhome");
    } finally {
      first.unmount();
    }

    useAuthStore.getState().setSession(
      { id: "u-1", username: "wangda", display_name: "王达", user_type: "human" },
      "token-abc",
    );
    const second = mountLanding();
    try {
      const heroCta = second.host.querySelector<HTMLAnchorElement>(".lp-hero .lp-cta a.ui-button--primary")!;
      expect(heroCta.getAttribute("href")).toBe("/home");
    } finally {
      second.unmount();
    }
  });
});
