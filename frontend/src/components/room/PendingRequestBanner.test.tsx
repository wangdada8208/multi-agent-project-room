// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PendingRequestBanner } from "./PendingRequestBanner";
import { RoomShell } from "./RoomShell";
import type { PendingRequest } from "../../lib/domain/pendingRequests";

vi.mock("../layout/AppShell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => children }));

const agent: PendingRequest = {
  id: "agent", token: "invite-agent", kind: "agent", status: "pending", displayName: "Muse",
  redeemer_address: "0x1", redeemer_user_id: null, agent_user_id: null, seat_id: null,
  approved_scopes: null, decided_by: null, decided_at: null, deny_reason: null, expires_at: null, created_at: null,
};
const human: PendingRequest = { ...agent, id: "human", kind: "human", displayName: "林溪" };

it("keeps the owner banner before the scroll region through approval, group sync, and completion", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const onDecide = vi.fn();
  const onOpen = vi.fn();

  function render(requests: PendingRequest[], syncing?: string, isOwner = true) {
    act(() => root.render(<RoomShell roomId="room" pendingCount={requests.length} header={null}
      banner={<PendingRequestBanner requests={requests} syncing={syncing} isOwner={isOwner} busy={false} error="" onDecide={onDecide} onOpen={onOpen} />}
      messages={<div className="wb-stream">正文</div>} composer={null} />));
  }

  try {
    render([agent, human], undefined, false);
    expect(container.querySelector(".wb-pending")).toBeNull();
    render([agent, human]);
    const banner = container.querySelector(".wb-pending");
    expect(banner?.nextElementSibling).toBe(container.querySelector(".wb-stream"));
    expect(banner?.textContent).toContain("Muse 等 2 个申请");
    const click = (label: string) => [...container.querySelectorAll("button")].find((button) => button.textContent === label)?.click();
    act(() => click("查看全部申请"));
    expect(onOpen).toHaveBeenCalledOnce();
    act(() => click("批准入房"));
    expect(onDecide).toHaveBeenCalledWith(agent, true);
    render([human], "Muse");
    expect(container.querySelector(".wb-pending--syncing")?.textContent).toContain("正在让 Muse 看到加密聊天");
    expect(container.querySelector(".wb-pending")?.nextElementSibling?.textContent).toBe("正文");
    render([human]);
    act(() => click("拒绝"));
    expect(onDecide).toHaveBeenLastCalledWith(human, false);
    render([]);
    expect(container.querySelector(".wb-pending")).toBeNull();
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
