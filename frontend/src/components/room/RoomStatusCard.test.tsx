// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { XMTP_BIND_ERROR_MESSAGE, XMTP_NETWORK_ERROR_MESSAGE } from "../../lib/xmtpLocalIdentity";
import { RoomStatusCard } from "./RoomStatusCard";

describe("RoomStatusCard encryption states", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function renderCard(props: Partial<Parameters<typeof RoomStatusCard>[0]>) {
    const finalProps: Parameters<typeof RoomStatusCard>[0] = {
      view: { kind: "enableGroup" },
      address: "",
      roomId: "room",
      accepted: false,
      binding: false,
      canBind: true,
      onUnlock: vi.fn(),
      onBind: vi.fn(),
      onReconnect: vi.fn(),
      starters: [],
      ...props,
    };
    act(() => root.render(<MemoryRouter><RoomStatusCard {...finalProps} /></MemoryRouter>));
    return finalProps;
  }

  it("shows a smooth automatic enabling state instead of a second manual decision", () => {
    renderCard({ view: { kind: "enableGroup" }, binding: true });

    expect(host.textContent).toContain("正在开启端到端加密…");
    expect(host.textContent).not.toContain("立即启用");
  });

  it("shows retry enabling only after automatic binding fails", async () => {
    const onBind = vi.fn();
    renderCard({
      view: { kind: "error", message: XMTP_BIND_ERROR_MESSAGE, reason: "bind" },
      onBind,
    });

    expect(host.textContent).toContain("端到端加密开启失败");
    const retry = [...host.querySelectorAll("button")].find((button) => button.textContent === "重试开启");
    expect(retry).toBeDefined();
    await act(async () => retry?.click());
    expect(onBind).toHaveBeenCalledTimes(1);
  });

  it("uses the Chinese network failure copy with a retry action", () => {
    renderCard({ view: { kind: "error", message: XMTP_NETWORK_ERROR_MESSAGE, reason: "connect" } });

    expect(host.textContent).toContain("暂时连不上加密网络，请稍后重试");
    expect(host.textContent).toContain("重试连接");
    expect(host.textContent).not.toContain("Decryption failed");
  });
});
