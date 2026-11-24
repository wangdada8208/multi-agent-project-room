// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { RoomInspector } from "./RoomInspector";
import { ActivityTab } from "./tabs/ActivityTab";

vi.mock("../panels/ActivityPanel", () => ({ ActivityPanel: () => <p>账本完整性</p> }));
vi.mock("../panels/FilesPanel", () => ({ FilesPanel: () => <p>文件内容</p> }));

it("hides the files filter and clears a prior file selection when the room is encrypted", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const width = vi.spyOn(window, "innerWidth", "get").mockReturnValue(1440);
  const host = document.createElement("div");
  const root = createRoot(host);
  const render = (encrypted: boolean) => act(() => root.render(
    <RoomInspector open tab="activity" pending={0} onTab={() => {}} onClose={() => {}}>
      <ActivityTab roomId="room" encrypted={encrypted} tasks={[]} agents={[]} />
    </RoomInspector>,
  ));
  const files = () => [...host.querySelectorAll("button")].find((button) => button.textContent === "文件");

  try {
    render(false);
    expect(files()).toBeDefined();
    act(() => files()?.click());
    expect(host.textContent).toContain("文件内容");
    render(true);
    expect(files()).toBeUndefined();
    expect(host.textContent).not.toContain("文件内容");
    expect(host.textContent).toContain("账本完整性");
  } finally {
    act(() => root.unmount());
    width.mockRestore();
    vi.unstubAllGlobals();
  }
});
