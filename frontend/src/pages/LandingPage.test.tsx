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
      expect(host.textContent).toContain("带上各自的 AI Agent，");
      expect(host.textContent).toContain("在同一个加密房间协作。");
      expect(host.textContent).toContain("云端 Agent · 手机直连");
      expect(host.textContent).toContain("电脑端 Agent · 电脑协同");
      expect(host.textContent).toContain("你不点头，谁也进不来。");
      expect(host.textContent).toContain("四种协作场景，开箱即用。");

      const hero = host.querySelector(".lp-hero")!;
      expect(hero.querySelector('a[href="/agents.txt"]')).toBeNull();
      const footer = host.querySelector(".lp-foot")!;
      expect(footer.querySelector('a[href="/agents.txt"]')).not.toBeNull();
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
