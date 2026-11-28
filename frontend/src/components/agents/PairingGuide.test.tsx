// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeHelper, type HelperProbe } from "../../lib/localHelper";
import { PairingGuide } from "./PairingGuide";

vi.mock("../../lib/localHelper", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/localHelper")>(),
  probeHelper: vi.fn(),
}));
vi.mock("../HelperIntroDemo", () => ({ HelperIntroDemo: () => null }));

const blockedProbe: HelperProbe = { state: "blocked" };
const runningProbe: HelperProbe = {
  state: "running",
  hello: {
    app: "mapr-helper",
    version: "0.1.0",
    paired: false,
    hub_origin: null,
    owner_display_name: null,
  },
};

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(probeHelper).mockReset().mockResolvedValue(blockedProbe);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderGuide(onGenerate = vi.fn()) {
  const pairing = {
    code: "mpc_test.code",
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    remainingSeconds: 600,
    issuedAtMs: Date.now(),
  };
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <PairingGuide
          mobile={false}
          running={false}
          pairing={pairing}
          error=""
          hubOrigin="http://localhost:8000"
          onGenerate={onGenerate}
        />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function advanceTime(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`找不到按钮「${text}」`);
  return button;
}

describe("Q14 pairing wait feedback", () => {
  it("shows elapsed wait time and the latest local probe state", async () => {
    await renderGuide();
    expect(container.textContent).toContain("已等待 0 秒");

    await advanceTime(15_000);

    expect(container.textContent).toContain("已等待 15 秒");
    expect(container.textContent).toContain("最近探测：浏览器拦截了本机访问");
    expect(buttonByText("立即重新检测")).toBeTruthy();
  });

  it("switches to an actionable troubleshooting card after waiting ninety seconds", async () => {
    await renderGuide();
    await advanceTime(74_000);
    expect(container.textContent).not.toContain("仍未检测到本机助手");

    await advanceTime(16_000);

    expect(container.textContent).toContain("仍未检测到本机助手");
    expect(container.textContent).toContain("命令是否完整运行");
    expect(container.textContent).toContain("是否装有 Node 22+");
    expect(container.textContent).toContain("是否在同一台电脑上运行");
    expect(container.textContent).toContain("点此重新生成配对码");
    expect(container.textContent).not.toContain("正在等待本机助手连接… 终端运行成功后此页面会自动刷新。");
  });

  it("manually retries detection and renders the fresh probe result", async () => {
    await renderGuide();
    await advanceTime(1);
    const callsBefore = vi.mocked(probeHelper).mock.calls.length;
    vi.mocked(probeHelper).mockResolvedValue(runningProbe);

    await act(async () => buttonByText("立即重新检测").click());
    await act(async () => {
      await Promise.resolve();
    });

    expect(vi.mocked(probeHelper).mock.calls.length).toBeGreaterThan(callsBefore);
    expect(container.textContent).toContain("最近探测：已检测到本机助手");
  });
});
