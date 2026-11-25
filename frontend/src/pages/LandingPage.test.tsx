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

  it("renders hero, interactive Agent mode switcher, safety split, template tabs, and footer-only agents.txt", () => {
    const { host, unmount } = mountLanding();
    try {
      expect(host.textContent).toContain("带上各自的 AI Agent，在同一间密室协作");
      expect(host.textContent).toContain("云端与电脑端的 Agent，各守边界同房协作");
      expect(host.textContent).toContain("你不点头，谁也进不来");
      expect(host.textContent).toContain("选好协作模板，规则即刻生效");

      const hero = host.querySelector(".lp-hero")!;
      expect(hero.querySelector('a[href="/agents.txt"]')).toBeNull();
      const footer = host.querySelector(".lp-foot")!;
      expect(footer.querySelector('a[href="/agents.txt"]')).not.toBeNull();

      // Switch Agent onboarding mode tab from cloud to local
      const localTab = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
        (tab) => tab.textContent?.includes("电脑端 Agent"),
      )!;
      act(() => {
        localTab.click();
      });
      expect(localTab.getAttribute("aria-selected")).toBe("true");
      expect(host.textContent).toContain("代码与密钥留在本机电脑，仅将加密回复发进房间");
      expect(host.textContent).toContain("Claude Code");

      // Switch collaboration template tab
      const devTeamTab = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
        (tab) => tab.textContent?.trim() === "开发团队",
      )!;
      act(() => {
        devTeamTab.click();
      });
      expect(devTeamTab.getAttribute("aria-selected")).toBe("true");
      expect(host.textContent).toContain("架构师 Architect");
    } finally {
      unmount();
    }
  });

  it("approves Muse interactively inside ScenePreview and updates sidebar status", () => {
    const { host, unmount } = mountLanding();
    try {
      const museRow = host.querySelector('[data-testid="preview-member-muse"]')!;
      expect(museRow.textContent).toContain("待批准");
      expect(host.textContent).toContain("Muse 请求加入房间");

      const approveBtn = Array.from(host.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "批准入房",
      )!;
      act(() => {
        approveBtn.click();
      });

      expect(host.textContent).toContain("Muse 已加入房间");
      expect(museRow.textContent).not.toContain("待批准");
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
