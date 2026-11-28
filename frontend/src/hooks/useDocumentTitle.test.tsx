// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDocumentTitle } from "./useDocumentTitle";

function TitleHarness({ title }: { title: string }) {
  useDocumentTitle(title);
  return null;
}

describe("useDocumentTitle", () => {
  let host: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    if (root) act(() => root.unmount());
    host?.remove();
    document.title = "Parlor";
    vi.unstubAllGlobals();
  });

  it("updates the browser title as the page or room name changes and restores it on exit", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    document.title = "Parlor";
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    act(() => root.render(<TitleHarness title="房间 · Parlor" />));
    expect(document.title).toBe("房间 · Parlor");

    act(() => root.render(<TitleHarness title="发布冲刺 · Parlor" />));
    expect(document.title).toBe("发布冲刺 · Parlor");

    act(() => root.unmount());
    expect(document.title).toBe("Parlor");
    root = undefined as unknown as Root;
  });

  it("falls back to the product name for an empty title", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<TitleHarness title="  " />));
    expect(document.title).toBe("Parlor");
  });
});
