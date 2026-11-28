// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasEncryptedVault,
  LEGACY_STORAGE_KEY,
  lockXmtpIdentity,
  SESSION_UNLOCK_STORAGE_KEY,
  storeEncryptedKey,
  VAULT_STORAGE_KEY,
} from "../lib/xmtpLocalIdentity";
import { XmtpUnlock } from "./XmtpUnlock";

const sampleKey = `0x${"ab".repeat(32)}`;
const goodPassword = "correct horse battery";

async function flush(times = 5) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function setNativeValue(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function inputByLabel(host: HTMLElement, label: string) {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`Missing input ${label}`);
  return input;
}

function buttonByText(host: HTMLElement, text: string) {
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
  if (!button) throw new Error(`Missing button ${text}`);
  return button;
}

function buttonByLabel(host: HTMLElement, label: string) {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`Missing button ${label}`);
  return button;
}

describe("XmtpUnlock", () => {
  let host: HTMLDivElement;
  let root: Root;
  let onUnlock: ReturnType<typeof vi.fn<(key: string) => void>>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    sessionStorage.clear();
    lockXmtpIdentity();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    onUnlock = vi.fn<(key: string) => void>();
    act(() => {
      root.render(<XmtpUnlock onUnlock={onUnlock} />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    localStorage.clear();
    sessionStorage.clear();
    lockXmtpIdentity();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("blocks mismatched creation passwords, explains the local-only passphrase, and toggles visibility", async () => {
    expect(host.textContent).toContain("口令只留在当前浏览器，用于保护你的加密房间钥匙");
    const password = inputByLabel(host, "设置口令");
    const confirmation = inputByLabel(host, "确认口令");
    expect(password.type).toBe("password");
    expect(confirmation.type).toBe("password");

    await act(async () => buttonByLabel(host, "显示口令").click());
    expect(inputByLabel(host, "设置口令").type).toBe("text");
    expect(inputByLabel(host, "确认口令").type).toBe("text");

    await act(async () => {
      setNativeValue(password, goodPassword);
      setNativeValue(confirmation, `${goodPassword} different`);
    });
    await act(async () => buttonByText(host, "保存并进入").click());
    await flush();

    expect(host.textContent).toContain("两次输入的口令不一致，请重新输入");
    expect(hasEncryptedVault()).toBe(false);
    expect(onUnlock).not.toHaveBeenCalled();
  });

  it("creates the vault only after matching confirmation and remembers this browser session after explicit opt-in", async () => {
    await act(async () => {
      setNativeValue(inputByLabel(host, "设置口令"), goodPassword);
      setNativeValue(inputByLabel(host, "确认口令"), goodPassword);
    });
    const keepUnlocked = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(keepUnlocked?.checked).toBe(false);
    expect(host.textContent).toContain("本次浏览器会话保持解锁");
    await act(async () => keepUnlocked?.click());

    await act(async () => buttonByText(host, "保存并进入").click());
    await act(async () => {
      await vi.waitFor(() => expect(onUnlock).toHaveBeenCalledTimes(1), { timeout: 5000, interval: 20 });
    });

    expect(onUnlock).toHaveBeenCalledTimes(1);
    const key = onUnlock.mock.calls[0][0];
    expect(key).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(hasEncryptedVault()).toBe(true);
    expect(sessionStorage.getItem(SESSION_UNLOCK_STORAGE_KEY)).toBe(key);
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(VAULT_STORAGE_KEY)).not.toContain(key);
  });

  it("keeps the unlock memory-only when the session option is unchecked", async () => {
    const keepUnlocked = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(keepUnlocked).not.toBeNull();
    expect(keepUnlocked?.checked).toBe(false);
    await act(async () => {
      setNativeValue(inputByLabel(host, "设置口令"), goodPassword);
      setNativeValue(inputByLabel(host, "确认口令"), goodPassword);
    });
    await act(async () => buttonByText(host, "保存并进入").click());
    await act(async () => {
      await vi.waitFor(() => expect(onUnlock).toHaveBeenCalledTimes(1), { timeout: 5000, interval: 20 });
    });

    expect(onUnlock).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(SESSION_UNLOCK_STORAGE_KEY)).toBeNull();
  });

  it("shows an actionable Chinese error for a wrong password without leaking the English exception", async () => {
    act(() => root.unmount());
    await storeEncryptedKey(sampleKey, goodPassword, localStorage, 1000);
    act(() => {
      root = createRoot(host);
      root.render(<XmtpUnlock onUnlock={onUnlock} />);
    });

    await act(async () => setNativeValue(inputByLabel(host, "加密口令"), "wrong password"));
    await act(async () => buttonByText(host, "解锁").click());
    await flush(8);

    expect(host.textContent).toContain("口令不对，请检查大小写后重试，或点下方重设本机加密身份");
    expect(host.textContent).not.toContain("Decryption failed");
    expect(onUnlock).not.toHaveBeenCalled();
  });

  it("requires a second confirmation before resetting the local identity and returns to creation", async () => {
    act(() => root.unmount());
    await storeEncryptedKey(sampleKey, goodPassword, localStorage, 1000);
    sessionStorage.setItem(SESSION_UNLOCK_STORAGE_KEY, sampleKey);
    act(() => {
      root = createRoot(host);
      root.render(<XmtpUnlock onUnlock={onUnlock} />);
    });

    await act(async () => buttonByText(host, "忘记口令？重设本机加密身份").click());
    expect(host.textContent).toContain("旧房间历史消息将无法解密");
    expect(host.textContent).toContain("不会影响账号登录");

    await act(async () => buttonByText(host, "确认重设").click());
    await flush();

    expect(hasEncryptedVault()).toBe(false);
    expect(sessionStorage.getItem(SESSION_UNLOCK_STORAGE_KEY)).toBeNull();
    expect(host.textContent).toContain("设置本机加密口令");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="确认口令"]')).not.toBeNull();
  });
});
