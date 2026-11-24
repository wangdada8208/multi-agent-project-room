// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "../stores/authStore";
import { LoginPage } from "./LoginPage";

function LocationEcho() {
  const loc = useLocation();
  return <div data-testid="location">{`${loc.pathname}${loc.search}`}</div>;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

function setInputValue(el: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  descriptor?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("LoginPage", () => {
  const fetcher = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    useAuthStore.getState().logout();
    fetcher.mockReset();
    vi.stubGlobal("fetch", fetcher);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function mountLogin(initialEntry: string) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="*" element={<LocationEcho />} />
          </Routes>
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

  it("does not render Google sign-in button when google_enabled is false", async () => {
    fetcher.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/auth/providers") {
        return Response.json({
          email_enabled: true,
          google_enabled: false,
          google_client_id: "",
        });
      }
      return Response.json({});
    });

    const { host, unmount } = mountLogin("/login");
    try {
      await flush();
      expect(host.textContent).not.toContain("使用 Google 继续");
      expect(host.textContent).not.toContain("或使用邮箱");
      expect(host.querySelectorAll(".wb-otp-cell").length).toBe(6);
    } finally {
      unmount();
    }
  });

  it("renders Google section when google_enabled is true with client_id", async () => {
    fetcher.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/auth/providers") {
        return Response.json({
          email_enabled: true,
          google_enabled: true,
          google_client_id: "google-test-client-id",
        });
      }
      return Response.json({});
    });

    const { host, unmount } = mountLogin("/login");
    try {
      await flush();
      expect(host.textContent).toContain("或使用邮箱");
      expect(host.querySelector(".wb-auth-google")).not.toBeNull();
    } finally {
      unmount();
    }
  });

  it("preserves ?next= redirect after email code login and splits pasted 6-digit OTP", async () => {
    fetcher.mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/auth/providers") {
        return Response.json({
          email_enabled: true,
          google_enabled: false,
          google_client_id: "",
        });
      }
      if (url === "/api/v1/auth/email/login" && init?.method === "POST") {
        return Response.json({
          user: {
            id: "user-1",
            username: "wangda",
            display_name: "王达",
            user_type: "human",
            email: "wangda@studio.cn",
          },
          access_token: "tok-123",
        });
      }
      return Response.json({});
    });

    const targetNext = "/rooms/room-42?invite=k9Qx";
    const { host, unmount } = mountLogin(`/login?next=${encodeURIComponent(targetNext)}`);
    try {
      await flush();
      expect(host.textContent).toContain("登录后将自动回到邀请房间");

      const emailInput = host.querySelector<HTMLInputElement>("#auth-email")!;
      await act(async () => {
        setInputValue(emailInput, "wangda@studio.cn");
      });

      const otpCells = host.querySelectorAll<HTMLInputElement>(".wb-otp-cell");
      await act(async () => {
        setInputValue(otpCells[0], "482913");
      });
      expect(Array.from(otpCells).map((c) => c.value).join("")).toBe("482913");

      const submitBtn = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      expect(submitBtn.disabled).toBe(false);
      await act(async () => {
        submitBtn.click();
      });
      await flush();

      const loginCall = fetcher.mock.calls.find(
        ([u]) => typeof u === "string" && u === "/api/v1/auth/email/login",
      );
      expect(loginCall).toBeTruthy();
      expect(JSON.parse(String(loginCall?.[1]?.body))).toEqual({
        email: "wangda@studio.cn",
        code: "482913",
      });
      expect(host.querySelector('[data-testid="location"]')?.textContent).toBe(targetNext);
    } finally {
      unmount();
    }
  });
});
