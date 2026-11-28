// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearUnlockedXmtpKey,
  hasUnlockedXmtpKey,
  lockXmtpIdentity,
  rememberUnlockedXmtpKey,
  SESSION_UNLOCK_STORAGE_KEY,
} from "../../lib/xmtpLocalIdentity";
import { useXmtpSession } from "./useXmtpSession";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  bindGroup: vi.fn(),
}));

vi.mock("../../lib/xmtpLocalIdentity", async (getOriginal) => ({
  ...await getOriginal<typeof import("../../lib/xmtpLocalIdentity")>(),
  createLocalXmtpClient: mocks.createClient,
}));

vi.mock("../../lib/api", async (getOriginal) => ({
  ...await getOriginal<typeof import("../../lib/api")>(),
  bindXmtpGroup: mocks.bindGroup,
}));

const key = `0x${"cd".repeat(32)}`;
type HookProps = Parameters<typeof useXmtpSession>[0];
type HookResult = ReturnType<typeof useXmtpSession>;

let latest: HookResult;
function Probe(props: HookProps) {
  latest = useXmtpSession(props);
  return null;
}

async function flush(times = 6) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function clientWithGroup(createGroup: ReturnType<typeof vi.fn>) {
  return {
    close: vi.fn(),
    conversations: { createGroup },
  };
}

describe("useXmtpSession", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    sessionStorage.clear();
    lockXmtpIdentity();
    mocks.createClient.mockReset();
    mocks.bindGroup.mockReset().mockResolvedValue(undefined);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
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

  async function renderSession(props: Partial<HookProps> = {}) {
    const finalProps: HookProps = {
      roomId: "room",
      groupId: null,
      enabled: true,
      refreshRoom: vi.fn(async () => undefined),
      ...props,
    };
    await act(async () => root.render(<Probe {...finalProps} />));
    await flush();
    return finalProps;
  }

  it("restores the remembered session after a simulated refresh and manual lock clears it immediately", async () => {
    mocks.createClient.mockImplementation(async () => clientWithGroup(vi.fn()));
    rememberUnlockedXmtpKey(key, true);

    await renderSession({ groupId: "group" });
    expect(mocks.createClient).toHaveBeenCalledTimes(1);
    expect(latest.draftKeyMaterial).toBe(key);

    act(() => root.unmount());
    clearUnlockedXmtpKey();
    root = createRoot(host);
    await renderSession({ groupId: "group" });

    expect(mocks.createClient).toHaveBeenCalledTimes(2);
    expect(latest.draftKeyMaterial).toBe(key);

    await act(async () => latest.lock());
    await flush();
    expect(sessionStorage.getItem(SESSION_UNLOCK_STORAGE_KEY)).toBeNull();
    expect(hasUnlockedXmtpKey()).toBe(false);
    expect(latest.draftKeyMaterial).toBeNull();
    expect(latest.session.kind).toBe("locked");
  });

  it("automatically creates and binds the missing XMTP group once for an owner", async () => {
    const createGroup = vi.fn(async () => ({ id: "created-group" }));
    const refreshRoom = vi.fn(async () => undefined);
    mocks.createClient.mockImplementation(async () => clientWithGroup(createGroup));

    await renderSession({ groupId: null, autoBind: true, refreshRoom });
    expect(createGroup).not.toHaveBeenCalled();
    await act(async () => latest.setUnlockedKey(key));
    await flush(8);

    expect(createGroup).toHaveBeenCalledTimes(1);
    expect(mocks.bindGroup).toHaveBeenCalledTimes(1);
    expect(mocks.bindGroup).toHaveBeenCalledWith("room", "created-group");
    expect(refreshRoom).toHaveBeenCalledTimes(2);
    await flush(4);
    expect(createGroup).toHaveBeenCalledTimes(1);
  });

  it("does not create a second group when a refresh shows another owner already bound the room", async () => {
    const createGroup = vi.fn(async () => ({ id: "created-group" }));
    const refreshRoom = vi.fn(async () => ({ data: { xmtp_group_id: "already-bound-group" } }));
    mocks.createClient.mockImplementation(async () => clientWithGroup(createGroup));
    rememberUnlockedXmtpKey(key, true);

    await renderSession({ groupId: null, autoBind: true, refreshRoom });
    await flush(8);

    expect(refreshRoom).toHaveBeenCalled();
    expect(createGroup).not.toHaveBeenCalled();
    expect(mocks.bindGroup).not.toHaveBeenCalled();
    expect(latest.session.kind).not.toBe("error");
  });

  it("does not auto-create the group when the member cannot bind it", async () => {
    const createGroup = vi.fn(async () => ({ id: "created-group" }));
    mocks.createClient.mockImplementation(async () => clientWithGroup(createGroup));
    rememberUnlockedXmtpKey(key, true);

    await renderSession({ groupId: null, autoBind: false });
    await flush(8);

    expect(createGroup).not.toHaveBeenCalled();
    expect(mocks.bindGroup).not.toHaveBeenCalled();
    expect(latest.session.kind).toBe("noGroup");
  });

  it("surfaces a retryable Chinese bind failure without exposing the raw network exception", async () => {
    const createGroup = vi.fn(async () => {
      throw new Error("network exploded upstream");
    });
    mocks.createClient.mockImplementation(async () => clientWithGroup(createGroup));
    rememberUnlockedXmtpKey(key, true);

    await renderSession({ groupId: null, autoBind: true });
    await flush(8);

    expect(latest.session).toMatchObject({
      kind: "error",
      reason: "bind",
      message: "暂时无法开启端到端加密，请稍后重试。",
    });
    expect(latest.session.kind === "error" && latest.session.message).not.toContain("network exploded");
  });
});
