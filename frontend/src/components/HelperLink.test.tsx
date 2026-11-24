// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HelperLink, openHelperLink } from "./HelperLink";

const sources = import.meta.glob("../**/*.{ts,tsx}", {
  eager: true, query: "?raw", import: "default",
});

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ["iPhone", 5], ["iPad", 5], ["Android Mobile", 5], ["Macintosh", 5],
])("does not render or open a loopback target on %s", (ua, touchPoints) => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: touchPoints });
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const element = document.createElement("div");
  const root = createRoot(element);
  try {
    act(() => root.render(<>
      <HelperLink action="console">console</HelperLink>
      <HelperLink action={{ pair: "sample" }}>pair</HelperLink>
      <HelperLink action={{ preset: "grok", roomId: "room" }}>preset</HelperLink>
      <HelperLink action={{ approvalPort: 8791 }}>approval</HelperLink>
    </>));
    expect(element.querySelector('a[href^="http://127.0.0.1"]')).toBeNull();
    expect(openHelperLink({ ticket: "sample", agentKey: "codex" })).toBeNull();
    expect(open).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    Reflect.deleteProperty(navigator, "maxTouchPoints");
  }
});

it("keeps desktop links in a separate tab and preserves the handoff fragment", () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Desktop");
  const element = document.createElement("div");
  const root = createRoot(element);
  try {
    act(() => root.render(<HelperLink action={{ pair: "sample code" }}>pair</HelperLink>));
    const anchor = element.querySelector("a");
    expect(anchor?.href).toBe("http://127.0.0.1:8790/#pair=sample%20code");
    expect(anchor?.target).toBe("_blank");
    expect(anchor?.rel).toBe("noopener noreferrer");
  } finally {
    act(() => root.unmount());
  }
});

it("requires application code to use HelperLink for helper navigation", () => {
  const offenders = Object.entries(sources)
    .filter(([path, source]) => !/\/localHelper\.ts$|\/HelperLink\.tsx$|\.test\.[jt]sx?$/.test(path)
      && typeof source === "string" && /\b(?:HELPER_ORIGIN|helperHandoffUrl)\b/.test(source))
    .map(([path]) => path);
  expect(offenders, "Use <HelperLink> or openHelperLink for helper handoffs").toEqual([]);
});
