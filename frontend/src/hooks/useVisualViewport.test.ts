// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useVisualViewport } from "./useVisualViewport";

function Viewport() {
  useVisualViewport();
  return null;
}

it("tracks keyboard overlap, ignores pinch zoom and cleans up on unmount", () => {
  const viewport = Object.assign(new EventTarget(), { height: 500, offsetTop: 20, scale: 1 });
  const unlisten = vi.spyOn(viewport, "removeEventListener");
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("innerHeight", 800);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  const styles = document.documentElement.style;
  try {
    act(() => root.render(createElement(Viewport)));
    expect(styles.getPropertyValue("--kb")).toBe("280px");
    viewport.height = 350;
    viewport.dispatchEvent(new Event("resize"));
    expect(styles.getPropertyValue("--kb")).toBe("430px");
    viewport.scale = 2;
    viewport.dispatchEvent(new Event("resize"));
    expect(styles.getPropertyValue("--kb")).toBe("0px");
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
  expect(styles.getPropertyValue("--kb")).toBe("");
  expect(unlisten.mock.calls.map(([event]) => event)).toEqual(["resize", "scroll"]);
});
