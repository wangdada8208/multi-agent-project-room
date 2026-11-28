// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HELPER_ORIGIN,
  approveRedemption,
  createJoinTicket,
  createPairingCode,
  createRoomInvite,
  denyRedemption,
  joinViaTicket,
  listLocalAgents,
  listLocalSeats,
  listMyHelpers,
  listRoomRedemptions,
  listRoomSeats,
  probeHelper,
  type HelperProbe,
  type RedemptionView,
} from "../lib/localHelper";
import { createRoom, fetchRooms } from "../lib/api";
import { AgentJoinSection, AgentsPage } from "./AgentsPage";

vi.mock("../lib/localHelper", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/localHelper")>(),
  approveRedemption: vi.fn(),
  createJoinTicket: vi.fn(),
  createPairingCode: vi.fn(),
  createRoomInvite: vi.fn(),
  denyRedemption: vi.fn(),
  joinViaTicket: vi.fn(),
  listLocalAgents: vi.fn(),
  listLocalSeats: vi.fn(),
  listMyHelpers: vi.fn(),
  listRoomRedemptions: vi.fn(),
  listRoomSeats: vi.fn(),
  probeHelper: vi.fn(),
}));
vi.mock("../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/api")>(),
  createRoom: vi.fn(),
  fetchRooms: vi.fn(),
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
const modelPresets = [
  ["xAI Grok API（模型接口）", "grok"],
  ["Ollama 本机模型", "ollama"],
  ["自定义 Agent / Webhook", "webhook"],
] as const;
const invite = {
  token: "cloud+invite&token",
  room_id: "room-42",
  created_by: "owner-1",
  proposed_scopes: [],
  used_at: null,
  redeemed_by_address: null,
  created_at: "2026-11-24T00:00:00Z",
  expires_at: "2099-01-01T00:00:00Z",
};
const pendingRedemption: RedemptionView = {
  id: "redemption-1",
  token: invite.token,
  kind: "agent",
  status: "pending",
  redeemer_user_id: null,
  redeemer_address: "test-cloud-address",
  agent_user_id: null,
  seat_id: null,
  approved_scopes: null,
  decided_by: null,
  decided_at: null,
  deny_reason: null,
  expires_at: null,
  created_at: null,
};
const scrollIntoView = vi.fn();
const openWindow = vi.fn<typeof window.open>();
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value: scrollIntoView,
});

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubEnv("VITE_XMTP_ENV", "local");
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
    expires_at: new Date(Date.now() + 600_000).toISOString(),
  });
  vi.mocked(listLocalAgents).mockResolvedValue([]);
  vi.mocked(listLocalSeats).mockResolvedValue([]);
  vi.mocked(listMyHelpers).mockResolvedValue([]);
  vi.mocked(createRoomInvite).mockResolvedValue(invite);
  vi.mocked(listRoomRedemptions).mockResolvedValue([]);
  vi.mocked(listRoomSeats).mockResolvedValue([]);
  vi.mocked(fetchRooms).mockResolvedValue([]);
  queryClient = new QueryClient();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function renderSection({ ownerXmtpAddress, fixedRoom = true }: {
  ownerXmtpAddress?: string;
  fixedRoom?: boolean;
} = {}) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <AgentJoinSection roomId={fixedRoom ? "room-42" : undefined} ownerXmtpAddress={ownerXmtpAddress} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  // React Query delivers the initial probe through its scheduled observer notification.
  await advanceTime(1);
}

async function clickButton(scope: ParentNode, label: string) {
  const button = [...scope.querySelectorAll("button")].find((el) => el.textContent?.trim() === label);
  if (!button) throw new Error(`找不到按钮「${label}」`);
  await act(async () => button.click());
}

async function clickPreset(name: string, label = "一键配置并接入") {
  const title = [...container.querySelectorAll("strong")].find((el) => el.textContent === name);
  const card = title?.closest(".agents-preset-card");
  if (!card) throw new Error(`找不到「${name}」预设卡片`);
  await clickButton(card, label);
}

async function openCloudPanel(name: "Grok Bot" | "Muse") {
  const card = [...container.querySelectorAll<HTMLButtonElement>(".wb-cloud-card")].find((button) => button.querySelector("strong")?.textContent === name);
  if (!card) throw new Error(`找不到「${name}」预设卡片`);
  await act(async () => card.click());
  const panel = container.querySelector(`section[aria-label="${name} 云端接入"]`);
  if (!panel) throw new Error(`找不到「${name}」云端接入面板`);
  return panel;
}

async function advanceTime(milliseconds: number) {
  await act(async () => vi.advanceTimersByTimeAsync(milliseconds));
}

function helperLink(label: string) {
  const link = [...container.querySelectorAll("a")].find((el) => el.textContent?.includes(label));
  expect(link?.target).toBe("_blank");
  expect(link?.rel).toBe("noopener noreferrer");
  return link?.href;
}

describe("AgentJoinSection preset configuration", () => {
  it.each(modelPresets)("guides desktop users to step one for %s with a blocked probe", async (name, id) => {
    await renderSection();
    const url = window.location.href;
    await clickPreset(name);
    await act(async () => vi.advanceTimersByTime(16));

    expect(openWindow).not.toHaveBeenCalled();
    expect(window.location.href).toBe(url);
    const guide = container.querySelector("#install-pair-section");
    expect(guide?.textContent).toContain(`要配置「${name}」，请先完成第 1 步`);
    expect(guide?.querySelector(".step-one-highlight")).not.toBeNull();
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(helperLink("点此直接打开本机控制台")).toBe(
      `${HELPER_ORIGIN}/#pair=mpc_test.code&preset=${id}&room=room-42`,
    );
  });

  it.each(modelPresets)("guides mobile Safari to a computer without any loopback links for %s", async (name) => {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(mobileUA);
      await renderSection();
      const url = window.location.href;
      await clickPreset(name);

      expect(probeHelper).not.toHaveBeenCalled();
      expect(openWindow).not.toHaveBeenCalled();
      expect(window.location.href).toBe(url);
      expect(container.textContent).toContain("当前为手机或平板浏览器");
      expect(container.textContent).toContain("复制下方命令到电脑「终端」");
      expect(container.textContent).toContain("--pair 'mpc_test.code'");
      expect(container.querySelector('a[href*="127.0.0.1:8790"]')).toBeNull();
    },
  );

  it.each(modelPresets)("opens %s in a new tab when the desktop helper is paired", async (name, id) => {
    vi.mocked(probeHelper).mockResolvedValue(runningProbe);
    openWindow.mockReturnValue(window);
    await renderSection();
    await clickPreset(name);

    expect(openWindow).toHaveBeenCalledExactlyOnceWith(
      `${HELPER_ORIGIN}/#preset=${id}&room=room-42`,
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("offers a safe continuation link when window.open returns null", async () => {
    vi.mocked(probeHelper).mockResolvedValue(runningProbe);
    await renderSection();
    const url = window.location.href;
    await clickPreset(modelPresets[0][0]);

    expect(window.location.href).toBe(url);
    expect(helperLink("继续一键配置")).toBe(`${HELPER_ORIGIN}/#preset=grok&room=room-42`);
  });

  it("shows the pairing command immediately if the first probe is still pending", async () => {
    vi.mocked(probeHelper).mockReturnValue(new Promise(() => {}));
    await renderSection();
    await clickPreset(modelPresets[0][0]);

    expect(openWindow).not.toHaveBeenCalled();
    expect(container.querySelector("#install-pair-section")?.textContent).toContain(
      "--pair 'mpc_test.code'",
    );
  });

  it("preserves the Webhook preset when a later probe detects a paired helper", async () => {
    await renderSection();
    await clickPreset("自定义 Agent / Webhook");
    expect(helperLink("点此直接打开本机控制台")).toBe(
      `${HELPER_ORIGIN}/#pair=mpc_test.code&preset=webhook&room=room-42`,
    );

    vi.mocked(probeHelper).mockResolvedValue(runningProbe);
    await act(async () => vi.advanceTimersByTimeAsync(3000));

    expect(openWindow).not.toHaveBeenCalled();
    expect(container.textContent).toContain("本机助手已就绪，可以继续配置「自定义 Agent / Webhook」");
    expect(helperLink("继续一键配置")).toBe(`${HELPER_ORIGIN}/#preset=webhook&room=room-42`);
    await clickButton(container, "关闭提示");
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});

describe("AgentJoinSection cloud invitations", () => {
  it.each([
    ["Grok Bot", desktopUA],
    ["Grok Bot", mobileUA],
    ["Muse", desktopUA],
    ["Muse", mobileUA],
  ] as const)("generates an in-page bridge command for %s on %s", async (name, ua) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
    await renderSection();
    const currentUrl = window.location.href;
    const panel = await openCloudPanel(name);
    const approval = panel.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(approval?.checked).toBe(false);
    await clickButton(panel, "生成接入指令");
    await advanceTime(1);

    expect(createRoomInvite).toHaveBeenCalledExactlyOnceWith("room-42", {
      expires_hours: 72,
      max_uses: 1,
      requires_approval: false,
      role: "member",
      proposed_scopes: [],
    });
    expect(panel.querySelector(".code-block code")?.textContent).toContain(
      `cli.ts bridge --invite "${window.location.origin}/rooms/room-42?invite=cloud%2Binvite%26token" --name "${name}" --env "local"`,
    );
    expect(panel.textContent).toContain("~/.mapr-bot/mailbox/inbound.jsonl");
    expect(panel.textContent).toContain(name === "Muse" ? "Muse Secure VM" : "--wake-key-env GROK_WEBHOOK_KEY");
    expect(panel.querySelector('a[href*="127.0.0.1:8790"]')).toBeNull();
    expect(openWindow).not.toHaveBeenCalled();
    expect(window.location.href).toBe(currentUrl);
  });

  it("polls for the issued invite, approves its applicant, and shows its cloud seat", async () => {
    let pending: RedemptionView[] = [];
    vi.mocked(listRoomRedemptions).mockImplementation(async (_roomId, status) =>
      status === "pending" ? pending : [{
        ...pendingRedemption, status: "approved", seat_id: "new-cloud-seat",
      }],
    );
    vi.mocked(approveRedemption).mockImplementation(async () => {
      pending = [];
      vi.mocked(listRoomSeats).mockResolvedValue([{
        seat_id: "new-cloud-seat",
        room_id: "room-42",
        agent_display_name: "Grok Bot",
        agent_user_id: "agent-1",
        owner_user_id: "owner-1",
        xmtp_address: "test-cloud-address",
        kind: "cloud-agent",
        source: "invite",
        group_status: "pending",
      }]);
      return { ...pendingRedemption, status: "approved", seat_id: "new-cloud-seat" };
    });
    await renderSection();
    const panel = await openCloudPanel("Grok Bot");
    const approval = panel.querySelector<HTMLInputElement>('input[type="checkbox"]');
    await act(async () => approval?.click());
    await clickButton(panel, "生成接入指令");
    await advanceTime(1);
    expect(createRoomInvite).toHaveBeenCalledWith(
      "room-42", expect.objectContaining({ requires_approval: true }),
    );
    expect(panel.textContent).not.toContain("批准入房");

    pending = [
      pendingRedemption,
      { ...pendingRedemption, id: "other-request", token: "other-invite", redeemer_address: "other-address" },
    ];
    await advanceTime(4000);

    expect(listRoomRedemptions).toHaveBeenCalledTimes(2);
    expect(listRoomRedemptions).toHaveBeenLastCalledWith("room-42", "pending");
    expect(listRoomSeats).toHaveBeenCalledTimes(2);
    expect(panel.textContent).toContain("test-cloud-address");
    expect(panel.textContent).not.toContain("other-address");

    await clickButton(panel, "批准入房");
    await advanceTime(2);

    expect(approveRedemption).toHaveBeenCalledExactlyOnceWith("room-42", "redemption-1");
    expect(panel.textContent).toContain("Grok Bot 已入驻当前房间");
    expect(panel.querySelector('a[href="/rooms/room-42"]')?.textContent).toContain("进入房间自动拉入加密群");

    await clickButton(panel, "关闭云端接入");
    const calls = vi.mocked(listRoomSeats).mock.calls.length;
    await advanceTime(8000);
    expect(listRoomSeats).toHaveBeenCalledTimes(calls);
  });

  it("lets the owner reject the matching cloud request", async () => {
    vi.mocked(listRoomRedemptions).mockResolvedValue([pendingRedemption]);
    vi.mocked(denyRedemption).mockImplementation(async () => {
      vi.mocked(listRoomRedemptions).mockResolvedValue([]);
      return { ...pendingRedemption, status: "denied" };
    });
    await renderSection();
    const panel = await openCloudPanel("Muse");
    await clickButton(panel, "生成接入指令");
    await advanceTime(1);
    await clickButton(panel, "拒绝");
    await advanceTime(1);

    expect(denyRedemption).toHaveBeenCalledExactlyOnceWith("room-42", "redemption-1");
    expect(panel.textContent).not.toContain("批准入房");
  });

  it("links to the room creation form if there is no room yet", async () => {
    vi.mocked(createRoom).mockResolvedValue({
      id: "new-room",
      name: "新房间",
      description: "",
      created_at: "2026-11-24T00:00:00Z",
    });
    await renderSection({ fixedRoom: false });
    const panel = await openCloudPanel("Muse");
    const target = panel.querySelector("a")?.getAttribute("href");
    const createForm = target ? container.querySelector(target) : null;
    const input = createForm?.querySelector("input");
    if (!createForm || !input) throw new Error("找不到新建房间表单");
    expect(panel.textContent).not.toContain("生成接入指令");
    expect(listRoomSeats).not.toHaveBeenCalled();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "新房间");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickButton(createForm, "先创建一个房间");
    await clickButton(panel, "生成接入指令");
    expect(createRoomInvite).toHaveBeenCalledWith("new-room", expect.any(Object));
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
  await renderSection({ ownerXmtpAddress: "test-owner-address" });
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

async function renderAgents(path = "/agents?room=room-42") {
  vi.mocked(fetchRooms).mockResolvedValue([{ id: "room-42", name: "目标房间", description: "", created_at: "" }]);
  await act(async () => root.render(<QueryClientProvider client={queryClient}>
    <MemoryRouter initialEntries={[path]}><AgentsPage /></MemoryRouter>
  </QueryClientProvider>));
  await advanceTime(2);
}

it("defaults to a copyable cloud prompt on iPhone and shows computer guidance only for local clients", async () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(mobileUA);
  await renderAgents("/agents?room=room-42&agent=muse");
  const panel = container.querySelector('section[aria-label="Muse 云端接入"]');
  expect(panel?.querySelector<HTMLInputElement>('[role="switch"]')?.checked).toBe(true);
  expect(container.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain("Grok Bot");
  const prompt = container.querySelector('[data-testid="agent-prompt-preview"]');
  expect(prompt?.textContent).toContain("目标房间：目标房间（room-42）");
  expect(prompt?.textContent).not.toContain("配对码：");
  expect(container.textContent).not.toContain("本机终端工具需在电脑上运行");
  expect(container.querySelector(".wb-local")).toBeNull();
  expect(container.querySelector('a[href*="127.0.0.1:8790"]')).toBeNull();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  try {
    await clickButton(container, "复制专属提示词");
    expect(writeText).toHaveBeenCalledExactlyOnceWith(prompt?.textContent);
    await act(async () => container.querySelector<HTMLButtonElement>('[role="radio"]:nth-child(2)')?.click());
    expect(container.textContent).toContain("本机终端工具需在电脑上运行");
    await advanceTime(1600);
    await clickButton(container, "复制专属提示词");
    expect(writeText).toHaveBeenLastCalledWith(prompt?.textContent);
    expect(prompt?.textContent).toContain("Claude Code");
  } finally {
    Reflect.deleteProperty(navigator, "clipboard");
  }
  expect(probeHelper).not.toHaveBeenCalled();
  expect(createPairingCode).not.toHaveBeenCalled();
  expect(openWindow).not.toHaveBeenCalled();
});

it("shares pairing, refresh and expiry between the desktop prompt, both commands and helper handoff", async () => {
  vi.mocked(createPairingCode).mockResolvedValueOnce({
    code: "mpc_first.code", expires_at: new Date(Date.now() + 2000).toISOString(),
  }).mockResolvedValueOnce({
    code: "mpc_second.code", expires_at: new Date(Date.now() + 600_000).toISOString(),
  });
  await renderAgents();
  const preview = () => container.querySelector('[data-testid="agent-prompt-preview"]')?.textContent;
  const fallback = () => container.querySelector(".agent-prompt-setup__fallback pre")?.textContent;
  const guide = container.querySelector("#install-pair-section");
  if (!guide) throw new Error("missing pairing guide");
  const command = () => guide.querySelector(".wb-pairing__command")?.textContent;
  const handoff = () => helperLink("点此直接打开本机控制台");
  expect(createPairingCode).toHaveBeenCalledTimes(1);
  expect(preview()).toContain("目标房间：目标房间（room-42）");
  expect(preview()).toContain("配对码：mpc_first.code");
  expect(fallback()).toContain("mpc_first.code");
  expect(command()).toContain("mpc_first.code");
  expect(handoff()).toContain("#pair=mpc_first.code");
  expect([...container.querySelectorAll('[role="timer"]')].map((el) => el.textContent))
    .toEqual(["有效期剩余 00:02", "有效期剩余 00:02"]);

  await advanceTime(2000);
  expect(container.textContent?.match(/当前配对码已过期，请重新生成/gu)).toHaveLength(2);
  expect(handoff()).toBe(`${HELPER_ORIGIN}/`);
  const disabled = [...container.querySelectorAll("button:disabled")].map((el) => el.textContent?.trim());
  expect(disabled).toEqual(expect.arrayContaining(["复制专属提示词", "复制备用命令", "一键复制终端配对命令"]));

  await clickButton(guide, "重新生成配对码");
  expect(createPairingCode).toHaveBeenCalledTimes(2);
  expect(preview()).toContain("配对码：mpc_second.code");
  expect(fallback()).toContain("mpc_second.code");
  expect(command()).toContain("mpc_second.code");
  expect(handoff()).toContain("#pair=mpc_second.code");
  expect(container.textContent).not.toContain("mpc_first.code");
});

it("explains that a paired desktop helper can join directly", async () => {
  vi.mocked(probeHelper).mockResolvedValue(runningProbe);
  await renderAgents();
  const prompt = container.querySelector('[data-testid="agent-prompt-preview"]')?.textContent;
  expect(prompt).toContain("本机助手已配对，可直接加入目标房间");
  expect(prompt).not.toContain("<未提供");
  expect(createPairingCode).not.toHaveBeenCalled();
});
