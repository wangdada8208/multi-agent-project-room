// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

function BrokenComponent(): never {
  throw new Error("测试渲染错误");
}

describe("ErrorBoundary", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("catches a rendering error and shows a recoverable Chinese card instead of a blank page", async () => {
    await act(async () => {
      root.render(<ErrorBoundary><BrokenComponent /></ErrorBoundary>);
      await Promise.resolve();
    });

    expect(host.textContent).toContain("页面刚才出错了");
    expect(host.textContent).toContain("你的房间数据没有丢");
    expect(host.textContent).toContain("刷新页面");
    expect(host.textContent).toContain("返回房间列表");
    expect(host.textContent).toContain("复制错误详情");
    expect(host.querySelector('a[href="/home"]')).not.toBeNull();
    expect(host.textContent).toContain("测试渲染错误");
  });

  it("copies error details when the user asks for them", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await act(async () => {
      root.render(<ErrorBoundary><BrokenComponent /></ErrorBoundary>);
      await Promise.resolve();
    });
    const copy = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("复制错误详情"));
    expect(copy).toBeDefined();

    await act(async () => {
      copy?.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toContain("测试渲染错误");
    expect(copy?.textContent).toContain("已复制");
  });

  it("renders children normally when nothing throws", () => {
    act(() => root.render(<ErrorBoundary><p>正常内容</p></ErrorBoundary>));
    expect(host.textContent).toContain("正常内容");
    expect(host.textContent).not.toContain("页面刚才出错了");
  });
});
