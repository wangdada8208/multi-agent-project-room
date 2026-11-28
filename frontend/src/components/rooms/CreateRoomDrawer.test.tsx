// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomTemplateInfo } from "../../lib/api";
import { CreateRoomDrawer } from "./CreateRoomDrawer";

const SAMPLE_TEMPLATES: RoomTemplateInfo[] = [
  {
    id: "tpl-1",
    key: "code_review",
    name: "代码评审",
    description: "两个 Agent 互相审查代码，发现问题和改进建议",
    icon: "🔍",
    team_config_markdown:
      "## 团队配置\n### 审查者 Reviewer\n- 代码审查、安全检查、性能分析\n- 不关注需求分析\n",
    house_rules: {
      scopes: {
        "calendar.free_busy": "ask",
        "gmail.send": "cannot",
      },
      notes: ["评审房间默认不对外发信。"],
    },
    default_max_rounds: 2,
  },
  {
    id: "tpl-2",
    key: "brainstorm",
    name: "头脑风暴",
    description: "多个 Agent 从不同角度讨论方案，激发创意",
    icon: "💡",
    team_config_markdown: "### 创意者 Creative\n- 提出大胆想法\n### 分析者 Analyst\n- 评估可行性\n",
    house_rules: {
      scopes: { "task.run": "ask" },
      notes: [],
    },
    default_max_rounds: 3,
  },
];

function LocationEcho() {
  const loc = useLocation();
  return <div data-testid="location">{`${loc.pathname}${loc.search}`}</div>;
}

async function flush(times = 3) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = Object.getPrototypeOf(el);
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  descriptor?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("CreateRoomDrawer", () => {
  const fetcher = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    fetcher.mockReset();
    fetcher.mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/templates") {
        return Response.json({ templates: SAMPLE_TEMPLATES });
      }
      if (url === "/api/v1/templates/create-room" && init?.method === "POST") {
        return Response.json({
          room: {
            id: "room-new-1",
            name: "测试评审房",
            description: "",
            created_at: new Date().toISOString(),
            transport: "xmtp",
          },
        });
      }
      if (url === "/api/v1/rooms" && init?.method === "POST") {
        return Response.json({
          room: {
            id: "room-blank-1",
            name: "空白讨论",
            description: "自由讨论",
            created_at: new Date().toISOString(),
            transport: "xmtp",
          },
        });
      }
      if (url === "/api/v1/analytics/track") {
        return Response.json({ ok: true });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetcher);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function mountDrawer() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const onClose = vi.fn();

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/home"]}>
            <Routes>
              <Route
                path="/home"
                element={<CreateRoomDrawer open onClose={onClose} />}
              />
              <Route path="/rooms/:roomId" element={<LocationEcho />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    return {
      host,
      onClose,
      unmount: () => {
        act(() => root.unmount());
        host.remove();
        queryClient.clear();
      },
    };
  }

  it("renders parsed template preview and submits exact baseline createRoomFromTemplate payload", async () => {
    const { host, onClose, unmount } = mountDrawer();
    try {
      await flush();
      expect(host.textContent).toContain("审查者 Reviewer");
      expect(host.textContent).toContain("查看日程空闲");
      expect(host.textContent).toContain("不允许");
      expect(host.textContent).toContain("创建后自动开启端到端加密");

      const nameInput = host.querySelector<HTMLInputElement>("#wb-create-room-name")!;
      expect(nameInput.value).toMatch(/^代码评审 · \d+月\d+日$/);

      const submitBtn = Array.from(host.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("创建并进入"),
      )!;
      await act(async () => {
        submitBtn.click();
      });
      await flush();

      const createCall = fetcher.mock.calls.find(
        ([u]) => typeof u === "string" && u === "/api/v1/templates/create-room",
      );
      expect(createCall).toBeTruthy();
      expect(createCall?.[1]?.method).toBe("POST");
      expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
        template_key: "code_review",
        name: nameInput.value,
      });
      expect(onClose).toHaveBeenCalled();
      expect(host.querySelector('[data-testid="location"]')?.textContent).toBe("/rooms/room-new-1");
    } finally {
      unmount();
    }
  });

  it("preserves exact overrides request body contract when customized", async () => {
    const { host, unmount } = mountDrawer();
    try {
      await flush();

      const customizeBtn = Array.from(host.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "自定义",
      )!;
      await act(async () => {
        customizeBtn.click();
      });

      const gmailSelect = host.querySelector<HTMLSelectElement>('select[aria-label="gmail.send 规则"]')!;
      await act(async () => {
        setNativeValue(gmailSelect, "ask");
      });

      const mdTextarea = host.querySelector<HTMLTextAreaElement>("#tpl-custom-md")!;
      await act(async () => {
        setNativeValue(mdTextarea, "### 自定义评审员\n- 严格检查接口契约");
      });

      const roundsInput = host.querySelector<HTMLInputElement>('input[type="number"]')!;
      await act(async () => {
        setNativeValue(roundsInput, "4");
      });

      const nameInput = host.querySelector<HTMLInputElement>("#wb-create-room-name")!;
      await act(async () => {
        setNativeValue(nameInput, "发布前评审 · v2.4");
      });

      const submitBtn = Array.from(host.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("创建并进入"),
      )!;
      await act(async () => {
        submitBtn.click();
      });
      await flush();

      const createCall = fetcher.mock.calls.find(
        ([u]) => typeof u === "string" && u === "/api/v1/templates/create-room",
      );
      expect(createCall).toBeTruthy();
      expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
        template_key: "code_review",
        name: "发布前评审 · v2.4",
        house_rules: {
          scopes: {
            "calendar.free_busy": "ask",
            "gmail.send": "ask",
          },
          notes: ["评审房间默认不对外发信。"],
        },
        team_config_markdown: "### 自定义评审员\n- 严格检查接口契约",
        default_max_rounds: 4,
      });
    } finally {
      unmount();
    }
  });

  it("creates a blank room when 空白房间 is selected", async () => {
    const { host, unmount } = mountDrawer();
    try {
      await flush();
      const blankOption = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find(
        (b) => b.textContent?.includes("空白房间"),
      )!;
      await act(async () => {
        blankOption.click();
      });

      const nameInput = host.querySelector<HTMLInputElement>("#wb-create-room-name")!;
      await act(async () => {
        setNativeValue(nameInput, "官网改版");
      });
      const descInput = host.querySelector<HTMLInputElement>("#wb-create-room-desc")!;
      await act(async () => {
        setNativeValue(descInput, "自由讨论");
      });

      const submitBtn = Array.from(host.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("创建并进入"),
      )!;
      await act(async () => {
        submitBtn.click();
      });
      await flush();

      const createCall = fetcher.mock.calls.find(
        ([u, init]) => typeof u === "string" && u === "/api/v1/rooms" && init?.method === "POST",
      );
      expect(createCall).toBeTruthy();
      expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
        name: "官网改版",
        description: "自由讨论",
      });
      expect(host.querySelector('[data-testid="location"]')?.textContent).toBe("/rooms/room-blank-1");
    } finally {
      unmount();
    }
  });
});
