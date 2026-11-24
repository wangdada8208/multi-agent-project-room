// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { MentionCandidate } from "../../lib/domain/mentions";
import { Composer } from "./Composer";

it("groups mentions, skips paused seats, and leaves composition to the input method", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const send = vi.fn(() => true);
  const items: MentionCandidate[] = [
    { id: "muse", name: "Muse", actor: "cloud", disabled: false, status: "已入群" },
    { id: "codex", name: "Codex", actor: "local", disabled: true },
    { id: "lin", name: "林溪", actor: "human", disabled: false },
  ];
  const key = (input: HTMLTextAreaElement, name: string, isComposing = false) =>
    input.dispatchEvent(new KeyboardEvent("keydown", { key: name, isComposing, bubbles: true, cancelable: true }));

  try {
    act(() => root.render(<Composer disabled={false} onlineAgents={[]} candidates={items} onSend={send} />));
    const input = host.querySelector("textarea");
    if (!input) throw new Error("Missing composer textarea");
    act(() => {
      const trigger = host.querySelector<HTMLButtonElement>(".wb-composer > button");
      trigger?.click();
    });
    expect(input.value).toBe("@");
    expect([...host.querySelectorAll('[role="group"]')].map((group) => group.getAttribute("aria-label"))).toEqual(["Agent", "人类"]);
    expect(host.querySelector('[role="option"][disabled]')?.textContent).toContain("已暂停");
    act(() => { key(input, "Enter", true); });
    expect(input.value).toBe("@");
    expect(send).not.toHaveBeenCalled();
    act(() => { key(input, "ArrowDown"); });
    act(() => { key(input, "Tab"); });
    expect(input.value).toBe("@林溪 ");
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(send).not.toHaveBeenCalled();
    await act(async () => { key(input, "Enter"); });
    expect(send).toHaveBeenCalledWith("@林溪", "human");
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
