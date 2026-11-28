// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EncryptionDetails } from "./E2eeBadge";

describe("EncryptionDetails", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("exposes immediate manual locking in the identity area", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onLock = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(
      <EncryptionDetails ready groupId="group" address="0x1111111111111111111111111111111111111111" onLock={onLock} />,
    ));

    expect(host.textContent).toContain("本机加密身份已解锁");
    const lock = [...host.querySelectorAll("button")].find((button) => button.textContent === "立即锁定");
    expect(lock).toBeDefined();
    await act(async () => lock?.click());
    expect(onLock).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });
});
