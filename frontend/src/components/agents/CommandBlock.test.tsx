// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { cloudAgentConnectCommand } from "../../lib/agentPresets";
import { CommandBlock } from "./CommandBlock";

it("copies the exact generated command from either display mode", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  const writeText = vi.fn(async () => {});
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const rootElement = document.createElement("div");
  const root = createRoot(rootElement);
  const command = cloudAgentConnectCommand({
    hubOrigin: "https://example.com", inviteUrl: "https://example.com/rooms/room?invite=example%26",
    title: "Grok Bot", env: "dev",
  });

  try {
    act(() => root.render(<CommandBlock command={command} />));
    expect(rootElement.querySelector("code")?.textContent).not.toBe(command);
    const [toggle, copy] = rootElement.querySelectorAll("button");
    await act(async () => { copy.click(); });
    expect(writeText).toHaveBeenNthCalledWith(1, command);
    act(() => toggle.click());
    expect(rootElement.querySelector("code")?.textContent).toBe(command);
    await act(async () => { copy.click(); });
    expect(writeText).toHaveBeenNthCalledWith(2, command);
  } finally {
    act(() => root.unmount());
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
