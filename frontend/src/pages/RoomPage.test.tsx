// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { isHex, recoverMessageAddress } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "../stores/authStore";
import { hasUnlockedXmtpKey, inboxAddress, lockXmtpIdentity } from "../lib/xmtpLocalIdentity";
import { RoomPage } from "./RoomPage";

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  reload: vi.fn(),
  group: vi.fn(),
  close: vi.fn(),
}));
const undoSession = useAuthStore.getInitialState();
let roomTransport: string;
let roomRole: string;
let roomStatusCode: number;
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const addressKey = generatePrivateKey();
const challenge = "Authenticate this test room invite";
const fetcher = vi.fn<typeof fetch>();

vi.mock("../hooks/useWebSocket", () => ({ useWebSocket: () => ({ sendMessage: vi.fn() }) }));
vi.mock("../components/XmtpUnlock", () => ({
  XmtpUnlock: ({ onUnlock }: { onUnlock: (key: string) => void }) =>
    <button type="button" onClick={() => onUnlock(addressKey)}>Unlock test identity</button>,
}));
vi.mock("../lib/xmtpLocalIdentity", async (getOriginal) => ({
  ...await getOriginal<typeof import("../lib/xmtpLocalIdentity")>(),
  createLocalXmtpClient: sdk.init,
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone");
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  lockXmtpIdentity();
  roomTransport = "xmtp";
  roomRole = "owner";
  roomStatusCode = 200;
  useAuthStore.setState({ user: { id: "owner", username: "owner", display_name: "Owner", user_type: "human" } });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  sdk.group.mockReset().mockResolvedValue(undefined);
  sdk.init.mockReset().mockImplementation(async () => ({
    inboxId: "my-inbox",
    close: sdk.close,
    conversations: {
      syncAll: sdk.reload.mockResolvedValue(undefined),
      getConversationById: sdk.group,
      streamAllMessages: async () => {
        let stop: (() => void) | undefined;
        return {
          [Symbol.asyncIterator]() { return this; },
          next: () => new Promise((resolve) => { stop = () => resolve({ done: true }); }),
          return: async () => { stop?.(); return { done: true }; },
        };
      },
    },
  }));
  fetcher.mockReset().mockImplementation(async (input) => {
    const url = new URL(String(input), window.location.origin);
    switch (url.pathname) {
      case "/api/v1/rooms/room":
        if (roomStatusCode !== 200) return Response.json({}, { status: roomStatusCode });
        return Response.json({ room: { id: "room", name: "Regression room", transport: roomTransport, xmtp_group_id: "group" } });
      case "/api/v1/rooms/room/permissions":
        return Response.json({ members: [{ user_id: "owner", role: roomRole }] });
      case "/api/v1/rooms/room/invites": return Response.json({ invites: [] });
      case "/api/v1/rooms/room/redemptions": return Response.json({ redemptions: [] });
      case "/api/v1/rooms/room/tasks": return Response.json({ tasks: [] });
      case "/api/v1/rooms/room/seats": return Response.json({ seats: [] });
      case "/api/v1/invites/sample-invite/accept": return Response.json({ room_id: "room", role: "member" });
      case "/api/v1/invites/nonce": return Response.json({ nonce: "one-time-nonce", message: challenge });
      case "/api/v1/invites/sample-invite/redeem": return Response.json({ status: "pending" });
      default: return Response.json({});
    }
  });
  vi.stubGlobal("fetch", fetcher);
});

afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  useAuthStore.setState(undoSession);
  lockXmtpIdentity();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function advance(ms = 5) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

async function renderRoom(path = "/rooms/room") {
  await act(async () => root.render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes><Route path="/rooms/:roomId" element={<RoomPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </StrictMode>,
  ));
  await advance();
}

async function unlock() {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === "Unlock test identity");
  expect(button).toBeDefined();
  await act(async () => button?.click());
  await advance();
}

function calls(path: string) {
  return fetcher.mock.calls.filter(([url]) => new URL(String(url), window.location.origin).pathname === path);
}

describe("room security and state integration", () => {
  it.each([
    [403, "你没有这个房间的访问权限"],
    [404, "房间不存在或已删除"],
    [410, "邀请已过期"],
  ] as const)("shows the room-specific message for HTTP %s", async (status, message) => {
    roomStatusCode = status;
    await renderRoom();
    expect(container.querySelector(".page-error")?.textContent).toContain(message);
    expect(container.querySelector('.page-error a[href="/home"]')).not.toBeNull();
    expect(calls("/api/v1/rooms/room")).toHaveLength(1);
  });

  it("sends one signed nonce after acceptance, shows one pending card and keeps the in-memory unlock across room exits", async () => {
    roomRole = "member";
    await renderRoom("/rooms/room?invite=sample-invite");
    expect(calls("/api/v1/invites/sample-invite/accept")).toHaveLength(1);
    await unlock();
    expect(hasUnlockedXmtpKey()).toBe(true);
    const nonce = calls("/api/v1/invites/nonce");
    const redeemed = calls("/api/v1/invites/sample-invite/redeem");
    expect(nonce).toHaveLength(1);
    expect(redeemed).toHaveLength(1);
    expect(fetcher.mock.calls.indexOf(nonce[0])).toBeLessThan(fetcher.mock.calls.indexOf(redeemed[0]));
    expect(JSON.parse(String(nonce[0][1]?.body))).toEqual({ action: "invite-redeem", resource: "sample-invite", address: inboxAddress(addressKey) });
    const payload = JSON.parse(String(redeemed[0][1]?.body));
    expect(payload).toMatchObject({ nonce: "one-time-nonce", xmtp_address: inboxAddress(addressKey) });
    expect(isHex(payload.signature)).toBe(true);
    if (!isHex(payload.signature)) throw new Error("Missing EIP-191 signature");
    expect((await recoverMessageAddress({ message: challenge, signature: payload.signature })).toLowerCase()).toBe(inboxAddress(addressKey));
    expect(container.textContent).toContain("入房申请已提交，等待房主批准");
    expect(container.textContent).not.toContain("这台设备还看不到房间里的加密聊天");
    expect(container.querySelector('a[href^="http://127.0.0.1"]')).toBeNull();
    await act(async () => root.render(null));
    expect(hasUnlockedXmtpKey()).toBe(true);
  });

  it("keeps encrypted messages and search text off the Hub, hides files and share, and pauses mobile helper navigation", async () => {
    sdk.group.mockResolvedValue({
      sync: async () => {},
      members: async () => [],
      messages: async () => [{
        conversationId: "group", senderInboxId: "remote", id: "message", content: "<script>local needle</script>", sentAt: new Date(),
      }],
    });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await renderRoom();
    await unlock();
    expect(container.textContent).toContain("<script>local needle</script>");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector('button[title="分享只读链接"]')).toBeNull();
    const files = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "文件");
    expect(files).toBeUndefined();
    expect(container.querySelector('a[href^="http://127.0.0.1"]')).toBeNull();
    expect(open).not.toHaveBeenCalled();
    const search = container.querySelector<HTMLButtonElement>('button[title="本机搜索加密消息"]');
    expect(search).toBeDefined();
    await act(async () => search?.click());
    const input = container.querySelector<HTMLInputElement>(".search-bar input");
    if (!input) throw new Error("Missing encrypted search input");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "local needle");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector(".search-results")?.textContent).toContain("local needle");
    expect(calls("/api/v1/rooms/room/messages")).toHaveLength(0);
    expect(calls("/api/v1/rooms/room/messages/search")).toHaveLength(0);
    expect(calls("/api/v1/rooms/room/share")).toHaveLength(0);
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith("http://127.0.0.1"))).toBe(false);
  });

  it("uses cached permissions during sync polling and seat query updates", async () => {
    sdk.group.mockResolvedValue({
      sync: async () => {}, members: async () => [], messages: async () => [], addMembersByIdentifiers: vi.fn(),
    });
    await renderRoom();
    await unlock();
    expect(container.textContent).toContain("端到端加密对话已就绪");
    expect(calls("/api/v1/rooms/room/redemptions").filter(([url]) => !String(url).includes("?"))).toHaveLength(1);
    await act(async () => client.setQueryData(["rooms", "room", "seats"], [
      { seat_id: "old-seat", group_status: "removed", xmtp_address: "", agent_display_name: "Old seat" },
    ]));
    await advance();
    expect(calls("/api/v1/rooms/room/redemptions").filter(([url]) => !String(url).includes("?"))).toHaveLength(1);
    await advance(11_000);
    expect(calls("/api/v1/rooms/room/redemptions").filter(([url]) => !String(url).includes("?")).length).toBeGreaterThan(1);
    expect(calls("/api/v1/rooms/room/permissions")).toHaveLength(1);
  });
});
