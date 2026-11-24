// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HELPER_ORIGIN,
  createJoinTicket,
  createPairingCode,
  joinViaTicket,
  listLocalAgents,
  listLocalSeats,
  listMyHelpers,
  probeHelper,
  type HelperProbe,
} from "../lib/localHelper";
import { AgentJoinSection } from "./AgentsPage";

vi.mock("../lib/localHelper", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/localHelper")>(),
  createJoinTicket: vi.fn(),
  createPairingCode: vi.fn(),
  joinViaTicket: vi.fn(),
  listLocalAgents: vi.fn(),
  listLocalSeats: vi.fn(),
  listMyHelpers: vi.fn(),
  probeHelper: vi.fn(),
}));
vi.mock("../components/HelperIntroDemo", () => ({ HelperIntroDemo: () => null }));

const runningProbe: HelperProbe = {
  state: "running",
  hello: {
    app: "mapr-helper",
    version: "0.1.0",
    paired: true,
    hub_origin: null,
    owner_display_name: null,
  },
};
const desktopUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15";
const mobileUA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1";
const scrollIntoView = vi.fn();
const openWindow = vi.fn<typeof window.open>();
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value: scrollIntoView,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(desktopUA);
  vi.spyOn(window, "open").mockImplementation(openWindow.mockReset().mockReturnValue(null));
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) =>
    window.setTimeout(() => callback(0), 16),
  );
  scrollIntoView.mockClear();
  vi.mocked(probeHelper).mockReset().mockResolvedValue({ state: "blocked" });
  vi.mocked(createPairingCode).mockResolvedValue({
    code: "mpc_test.code",
    expires_at: "2099-01-01T00:00:00Z",
    install_command: "test pairing command for the terminal",
  });
  vi.mocked(listLocalAgents).mockResolvedValue([]);
  vi.mocked(listLocalSeats).mockResolvedValue([]);
  vi.mocked(listMyHelpers).mockResolvedValue([]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderSection(ownerXmtpAddress?: string) {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <AgentJoinSection roomId="room-42" ownerXmtpAddress={ownerXmtpAddress} />
      </MemoryRouter>,
    );
  });
}

async function clickButton(scope: ParentNode, label: string) {
  const button = [...scope.querySelectorAll("button")].find((el) => el.textContent === label);
  if (!button) throw new Error(`找不到按钮「${label}」`);
  await act(async () => button.click());
}

async function clickGrokPreset(label = "一键配置并接入") {
  const title = [...container.querySelectorAll("strong")].find((el) => el.textContent === "Grok / Grokbot");
  const card = title?.closest(".agents-preset-card");
  if (!card) throw new Error("找不到 Grok / Grokbot 预设卡片");
  await clickButton(card, label);
}

function helperLink(label: string) {
  const link = [...container.querySelectorAll("a")].find((el) => el.textContent?.includes(label));
  expect(link?.target).toBe("_blank");
  expect(link?.rel).toBe("noopener noreferrer");
  return link?.href;
}

describe("AgentJoinSection preset configuration", () => {
  it("guides desktop users to step one when the probe is blocked", async () => {
    await renderSection();
    const url = window.location.href;
    await clickGrokPreset();
    await act(async () => vi.advanceTimersByTime(16));

    expect(openWindow).not.toHaveBeenCalled();
    expect(window.location.href).toBe(url);
    const guide = container.querySelector("#install-pair-section");
    expect(guide?.textContent).toContain("要配置「Grok / Grokbot」，请先完成第 1 步");
    expect(guide?.querySelector(".step-one-highlight")).not.toBeNull();
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(helperLink("点此直接打开本机控制台")).toBe(
      `${HELPER_ORIGIN}/#pair=mpc_test.code&preset=grok&room=room-42`,
    );
  });

  it.each(["一键配置并接入", "使用 Grokbot Webhook 桥接接入"])(
    "guides mobile Safari to a computer without any loopback links for %s",
    async (label) => {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(mobileUA);
      await renderSection();
      const url = window.location.href;
      await clickGrokPreset(label);

      expect(probeHelper).not.toHaveBeenCalled();
      expect(openWindow).not.toHaveBeenCalled();
      expect(window.location.href).toBe(url);
      expect(container.textContent).toContain("当前为手机或平板浏览器");
      expect(container.textContent).toContain("复制下方命令到电脑「终端」");
      expect(container.textContent).toContain("test pairing command for the terminal");
      expect(container.querySelector('a[href*="127.0.0.1:8790"]')).toBeNull();
    },
  );

  it("opens the Grok preset in a new tab when the desktop helper is paired", async () => {
    vi.mocked(probeHelper).mockResolvedValue(runningProbe);
    openWindow.mockReturnValue(window);
    await renderSection();
    await clickGrokPreset();

    expect(openWindow).toHaveBeenCalledExactlyOnceWith(
      `${HELPER_ORIGIN}/#preset=grok&room=room-42`,
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("offers a safe continuation link when window.open returns null", async () => {
    vi.mocked(probeHelper).mockResolvedValue(runningProbe);
    await renderSection();
    const url = window.location.href;
    await clickGrokPreset();

    expect(window.location.href).toBe(url);
    expect(helperLink("继续一键配置")).toBe(`${HELPER_ORIGIN}/#preset=grok&room=room-42`);
  });

  it("shows the pairing command immediately if the first probe is still pending", async () => {
    vi.mocked(probeHelper).mockReturnValue(new Promise(() => {}));
    await renderSection();
    await clickGrokPreset();

    expect(openWindow).not.toHaveBeenCalled();
    expect(container.querySelector("#install-pair-section")?.textContent).toContain(
      "test pairing command for the terminal",
    );
  });

  it("preserves the Webhook preset when a later probe detects a paired helper", async () => {
    await renderSection();
    await clickGrokPreset("使用 Grokbot Webhook 桥接接入");
    expect(helperLink("点此直接打开本机控制台")).toBe(
      `${HELPER_ORIGIN}/#pair=mpc_test.code&preset=grokbot-webhook&room=room-42`,
    );

    vi.mocked(probeHelper).mockResolvedValue(runningProbe);
    await act(async () => vi.advanceTimersByTimeAsync(3000));

    expect(openWindow).not.toHaveBeenCalled();
    expect(container.textContent).toContain("本机助手已就绪，可以继续配置「Grok / Grokbot（Grokbot Webhook）」");
    expect(helperLink("继续一键配置")).toBe(`${HELPER_ORIGIN}/#preset=grokbot-webhook&room=room-42`);
    await clickButton(container, "关闭提示");
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});

it("keeps the Hub open and shows recovery instructions if a seat join cannot reach the helper", async () => {
  vi.mocked(probeHelper).mockResolvedValue(runningProbe);
  vi.mocked(listLocalAgents).mockResolvedValue([
    { key: "codex", kind: "codex", displayName: "Codex", source: "detected", loginState: "likely-ready" },
  ]);
  vi.mocked(listMyHelpers).mockResolvedValue([{
    id: "helper-1",
    device_name: "Test computer",
    platform: "linux",
    revoked: false,
    created_at: "2026-11-24T00:00:00Z",
    last_seen_at: null,
  }]);
  vi.mocked(createJoinTicket).mockResolvedValue({
    ticket: "mjt_test.ticket",
    expires_at: "2099-01-01T00:00:00Z",
  });
  vi.mocked(joinViaTicket).mockRejectedValue(new TypeError("Failed to fetch"));
  await renderSection("test-owner-address");
  const url = window.location.href;
  await clickButton(container, "加入房间");

  expect(openWindow).toHaveBeenCalledExactlyOnceWith(
    `${HELPER_ORIGIN}/#ticket=mjt_test.ticket&agent=codex`,
    "_blank",
    "noopener,noreferrer",
  );
  expect(window.location.href).toBe(url);
  expect(container.textContent).toContain("请确认电脑上的本机助手已启动，并在浏览器中允许本地网络访问");
});
