// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRooms } from "../lib/api";
import { fetchHubActivity } from "../lib/activityApi";
import { listRoomRedemptions, listRoomSeats } from "../lib/localHelper";
import { useAuthStore } from "../stores/authStore";
import { HomePage } from "./HomePage";

vi.mock("../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/api")>(),
  fetchRooms: vi.fn(),
}));
vi.mock("../lib/activityApi", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/activityApi")>(),
  fetchHubActivity: vi.fn(),
}));
vi.mock("../lib/localHelper", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/localHelper")>(),
  listRoomRedemptions: vi.fn(),
  listRoomSeats: vi.fn(),
}));

const room = {
  id: "room-1",
  name: "第一个房间",
  description: "",
  created_by: "user-1",
  created_at: "2026-11-28T00:00:00Z",
  transport: "xmtp",
};

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let undoSession: ReturnType<typeof useAuthStore.getState>;
const fetcher = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  undoSession = useAuthStore.getState();
  useAuthStore.setState({
    user: { id: "user-1", username: "new-user", display_name: "新用户", user_type: "human" },
    token: "test-token",
    displayName: "新用户",
    userType: "human",
    isAuthenticated: true,
  });
  vi.mocked(fetchRooms).mockReset().mockResolvedValue([]);
  vi.mocked(listRoomSeats).mockReset().mockResolvedValue([]);
  vi.mocked(listRoomRedemptions).mockReset().mockResolvedValue([]);
  vi.mocked(fetchHubActivity).mockReset().mockResolvedValue({ room_id: "", items: [], checkpoints: [], count: 0 });
  fetcher.mockReset().mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/permissions")) {
      return Response.json({
        members: [{ user_id: "user-1", role: "owner", user_type: "human" }],
      });
    }
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetcher);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
  useAuthStore.setState(undoSession);
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderHome() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/home"]}>
          <HomePage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function flushQueries(times = 4) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("Q07 homepage onboarding visibility", () => {
  it("ignores the legacy mapr-onboarded click flag for an account with zero rooms", async () => {
    localStorage.setItem("mapr-onboarded", "1");
    await renderHome();
    await flushQueries();

    expect(container.textContent).toContain("用模板开第一个房间");
    expect(container.querySelector(".agent-prompt-setup")).toBeNull();
  });

  it("derives step one from a real room and keeps the later steps incomplete", async () => {
    vi.mocked(fetchRooms).mockResolvedValue([room]);
    await renderHome();
    await flushQueries();

    expect(container.querySelector('[aria-label="第 1 步：开第一个房间，已完成"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="第 2 步：接入一个智能助手，未完成"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="第 3 步：邀请一位同事，未完成"]')).not.toBeNull();
    expect(container.textContent).toContain("去接入智能助手");
  });

  it("hides the guide only after room, agent seat, and second human member are all real", async () => {
    vi.mocked(fetchRooms).mockResolvedValue([room]);
    vi.mocked(listRoomSeats).mockResolvedValue([{
      seat_id: "seat-1",
      room_id: "room-1",
      agent_user_id: "agent-1",
      agent_display_name: "Codex",
      owner_user_id: "user-1",
      kind: "codex",
      trust_tier: "local-cli",
      xmtp_address: "0xabc",
      group_status: "pending",
      source: "helper",
      paused_at: null,
    }]);
    fetcher.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/permissions")) {
        return Response.json({
          members: [
            { user_id: "user-1", role: "owner", user_type: "human" },
            { user_id: "user-2", role: "member", user_type: "human" },
          ],
        });
      }
      return Response.json({});
    });
    await renderHome();
    await flushQueries();

    expect(container.textContent).not.toContain("继续完成新手设置");
    expect(container.textContent).not.toContain("用模板开第一个房间");
    expect(container.textContent).toContain("第一个房间");
  });

  it("hides the guide only through the explicit dismiss action", async () => {
    await renderHome();
    await flushQueries();
    const dismiss = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "我知道了，收起引导");
    if (!dismiss) throw new Error("missing explicit dismiss button");
    await act(async () => dismiss.click());
    await flushQueries(2);

    expect(localStorage.getItem("mapr-onboarding-dismissed")).toBe("1");
    expect(localStorage.getItem("mapr-onboarded")).toBeNull();
    expect(container.textContent).not.toContain("先做一件事就能开始");
  });
});
