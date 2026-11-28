// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Room } from "../types/chat";
import { CommandPalette, ShortcutHelp } from "./CommandPalette";

const rooms: Room[] = [
  { id: "room-1", name: "发布冲刺", description: "周四发布", created_at: "2026-11-28T00:00:00Z" },
  { id: "room-2", name: "官网文案", description: "落地页打磨", created_at: "2026-11-28T00:00:00Z" },
];

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

function setNativeValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("CommandPalette", () => {
  let host: HTMLDivElement;
  let root: Root;
  let onCreateRoom: ReturnType<typeof vi.fn<() => void>>;
  let onShowShortcuts: ReturnType<typeof vi.fn<() => void>>;
  let onClose: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    onCreateRoom = vi.fn<() => void>();
    onShowShortcuts = vi.fn<() => void>();
    onClose = vi.fn<() => void>();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function renderPalette() {
    act(() => root.render(
      <MemoryRouter initialEntries={["/home"]}>
        <CommandPalette open rooms={rooms} pendingRoomId="room-1" onClose={onClose}
          onCreateRoom={onCreateRoom} onShowShortcuts={onShowShortcuts} />
        <LocationProbe />
      </MemoryRouter>,
    ));
  }

  it("filters rooms and opens the selected room with the keyboard", async () => {
    renderPalette();
    const input = host.querySelector<HTMLInputElement>('input[aria-label="搜索房间或命令"]');
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(host.textContent).toContain("新建房间");
    expect(host.textContent).toContain("发布冲刺");

    await act(async () => {
      setNativeValue(input!, "官网");
      await Promise.resolve();
    });
    expect(host.textContent).toContain("官网文案");
    expect(host.textContent).not.toContain("发布冲刺");

    await act(async () => {
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalled();
    expect(host.querySelector('[data-testid="location"]')?.textContent).toBe("/rooms/room-2");
  });

  it("runs the create-room and shortcut-help actions", async () => {
    renderPalette();
    const create = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("新建房间"));
    await act(async () => create?.click());
    expect(onCreateRoom).toHaveBeenCalledTimes(1);

    const shortcuts = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("查看快捷键"));
    await act(async () => shortcuts?.click());
    expect(onShowShortcuts).toHaveBeenCalledTimes(1);
  });

  it("offers agents and approvals navigation", async () => {
    renderPalette();
    const agents = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("去接入助手"));
    await act(async () => agents?.click());
    expect(host.querySelector('[data-testid="location"]')?.textContent).toBe("/agents");

    act(() => root.render(
      <MemoryRouter initialEntries={["/home"]}>
        <CommandPalette open rooms={rooms} pendingRoomId="room-1" onClose={onClose}
          onCreateRoom={onCreateRoom} onShowShortcuts={onShowShortcuts} />
        <LocationProbe />
      </MemoryRouter>,
    ));
    const approvals = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("去待审批"));
    await act(async () => approvals?.click());
    expect(host.querySelector('[data-testid="location"]')?.textContent).toBe("/rooms/room-1?panel=members");
  });
});

describe("ShortcutHelp", () => {
  it("lists exactly the five shortcuts that really work", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<ShortcutHelp open onClose={() => undefined} />));

    const items = [...host.querySelectorAll("li")];
    expect(items).toHaveLength(5);
    expect(host.textContent).toContain("打开命令面板");
    expect(host.textContent).toContain("聚焦房间搜索");
    expect(host.textContent).toContain("新建房间");
    expect(host.textContent).toContain("关闭当前弹层");
    expect(host.textContent).toContain("打开快捷键帮助");
    expect(host.textContent).toContain("输入框聚焦时");

    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
});
