// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InviteTab } from "./InviteTab";

async function flush(times = 4) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function buttonByText(host: HTMLElement, text: string) {
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
  if (!button) throw new Error(`Missing button ${text}`);
  return button;
}

describe("InviteTab decluttered encrypted invite flow", () => {
  let host: HTMLDivElement;
  let root: Root;
  const fetcher = vi.fn<typeof fetch>();
  const writeText = vi.fn<(text: string) => Promise<void>>();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    fetcher.mockReset();
    fetcher.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/invites") && init?.method === "POST") {
        return Response.json({ invite: { token: "inv_wave4b" } });
      }
      if (url.includes("/invites")) return Response.json({ invites: [] });
      if (url.includes("/permissions")) return Response.json({ members: [] });
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetcher);
    act(() => {
      root.render(
        <MemoryRouter>
          <InviteTab permissions={{ roomId: "room-1", isEncrypted: true, isOwner: true }} />
        </MemoryRouter>,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows only role, approval, and one invite action before a closed advanced details section", async () => {
    await flush();

    expect(host.textContent).toContain("可以一起聊并带自己的助手");
    expect(host.textContent).toContain("只能看");
    expect(host.textContent).toContain("需要房主批准");
    expect(host.textContent).toContain("生成并复制邀请链接");
    const panel = host.querySelector(".panel-section");
    const details = panel?.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.hasAttribute("open")).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toContain("高级选项");
    expect(details?.textContent).toContain("gmail.send");
    expect(details?.textContent).toContain("可用次数");
    expect(details?.innerHTML).toContain("0x 开头的 42 位加密地址");

    details?.remove();
    const primaryText = panel?.textContent ?? "";
    expect(primaryText).not.toContain("Agent");
    expect(primaryText).not.toContain("gmail.send");
    expect(primaryText).not.toContain("calendar.free_busy");
    expect(primaryText).not.toContain("scope");
    expect(primaryText).not.toContain("0x");
    expect(primaryText).not.toContain("XMTP");
    expect(primaryText).not.toContain("签名");
  });

  it("generates and copies the encrypted invite link in one click", async () => {
    await flush();
    await act(async () => {
      buttonByText(host, "生成并复制邀请链接").click();
    });
    await flush();

    const createCall = fetcher.mock.calls.find(([input, init]) =>
      String(input).includes("/invites") && init?.method === "POST",
    );
    expect(createCall).toBeTruthy();
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      proposed_scopes: [],
      expires_hours: 72,
      max_uses: 1,
      requires_approval: true,
      role: "member",
    });
    const expected = `${window.location.origin}/rooms/room-1?invite=inv_wave4b`;
    expect(writeText).toHaveBeenCalledWith(expected);
    expect(host.textContent).toContain("邀请链接已复制");
  });
});
