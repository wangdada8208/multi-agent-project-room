import { describe, expect, it, vi } from "vitest";
import {
  HELPER_ORIGIN,
  HubHttpError,
  acceptRoomInvite,
  approveRedemption,
  bindMyXmtpAddress,
  createPairingCode,
  createRoomInvite,
  denyRedemption,
  formatConnectionError,
  formatInviteAcceptError,
  helperHandoffUrl,
  isMobileBrowser,
  issueSignatureNonce,
  joinViaTicket,
  listRoomInvites,
  listRoomRedemptions,
  pauseRoomSeat,
  powershellInstallCommand,
  probeHelper,
  redeemRoomInvite,
  resolvePresetOpenDecision,
  resumeRoomSeat,
  revokeRoomInvite,
  shellInstallCommand,
  type HelperHello,
  type HelperProbe,
} from "./localHelper";

const memoryStorage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  writable: true,
  value: {
    getItem: (key: string) => memoryStorage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memoryStorage.set(key, value);
    },
    removeItem: (key: string) => {
      memoryStorage.delete(key);
    },
    clear: () => memoryStorage.clear(),
    key: (index: number) => Array.from(memoryStorage.keys())[index] ?? null,
    get length() {
      return memoryStorage.size;
    },
  } as Storage,
});

const HELLO: HelperHello = {
  app: "mapr-helper",
  version: "0.1.0",
  paired: true,
  hub_origin: "https://hub.wangdada8208.xyz",
  owner_display_name: "主人",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("joinViaTicket errors", () => {
  it.each([
    [{ reason: "助手尚未配对", detail: "ignored" }, "助手尚未配对"],
    [{ detail: "详情错误" }, "详情错误"],
    [{ error: "通用错误" }, "通用错误"],
    [{ reason: "x".repeat(205) }, "x".repeat(200)],
  ])("uses the bounded error message from the helper response", async (body, expected) => {
    await expect(
      joinViaTicket("mjt_1", "codex", async () => jsonResponse(body, 403)),
    ).rejects.toThrow(expected);
  });
});

describe("formatConnectionError", () => {
  it.each([
    new TypeError("Failed to fetch"),
    new Error("Load failed"),
    new Error("NetworkError when attempting to fetch resource."),
    new DOMException("The operation timed out", "TimeoutError"),
  ])("maps native connectivity errors to plain Chinese for the server", (error) => {
    const message = formatConnectionError(error, "server", "操作失败，请重试。");
    expect(message).toBe("暂时连不上服务器，检查网络连接后再试。");
    expect(message).not.toContain("fetch");
    expect(message).not.toContain("TypeError");
  });

  it("maps local helper connectivity errors to local helper guidance", () => {
    expect(formatConnectionError(new TypeError("Failed to fetch"), "local-helper", "操作失败，请重试。"))
      .toBe("暂时连不上本地助手，确认电脑上的连接程序已经启动后再试。");
  });

  it("keeps an existing human-readable error and uses the fallback for non-errors", () => {
    expect(formatConnectionError(new Error("邀请已过期"), "server", "操作失败，请重试。")).toBe("邀请已过期");
    expect(formatConnectionError(null, "server", "操作失败，请重试。")).toBe("操作失败，请重试。");
  });
});

describe("probeHelper", () => {
  it("returns running when hello answers with app=mapr-helper", async () => {
    const probe = await probeHelper(async () => jsonResponse(HELLO));
    expect(probe).toEqual({ state: "running", hello: HELLO });
  });

  it("requests the helper hello endpoint on 127.0.0.1:8790", async () => {
    let seen = "";
    await probeHelper(async (input) => {
      seen = String(input);
      return jsonResponse(HELLO);
    });
    expect(seen).toBe(`${HELPER_ORIGIN}/api/hello`);
  });

  it("returns not-running when the endpoint answers a non-200 status", async () => {
    const probe = await probeHelper(async () => jsonResponse({ detail: "nope" }, 503));
    expect(probe).toEqual({ state: "not-running" });
  });

  it("returns not-running when a different app occupies the port", async () => {
    const probe = await probeHelper(async () => jsonResponse({ app: "other", hello: true }));
    expect(probe).toEqual({ state: "not-running" });
  });

  it("returns not-running when the response is not valid JSON", async () => {
    const probe = await probeHelper(async () => new Response("<html>hi</html>", { status: 200 }));
    expect(probe).toEqual({ state: "not-running" });
  });

  it("returns not-running on generic network errors (e.g. timeout abort)", async () => {
    const probe = await probeHelper(async () => {
      throw new Error("network error");
    });
    expect(probe).toEqual({ state: "not-running" });
    const aborted = await probeHelper(async () => {
      throw new DOMException("The operation timed out", "TimeoutError");
    });
    expect(aborted).toEqual({ state: "not-running" });
  });

  it("returns blocked when fetch rejects with TypeError (browser block or refused)", async () => {
    const probe = await probeHelper(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(probe).toEqual({ state: "blocked" });
  });
});

describe("isMobileBrowser", () => {
  const desktopMac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
  it.each([
    ["iPhone Safari", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1", 5, true],
    ["Android", "Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/130.0.0.0", 5, true],
    ["iPad Safari", "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Safari/604.1", 5, true],
    ["iPod Safari", "Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X) Safari/604.1", 5, true],
    ["iPadOS desktop mode", `${desktopMac} Version/18.0 Safari/605.1.15`, 5, true],
    ["generic mobile UA", "Mozilla/5.0 Mobile Safari/537.36", 0, true],
    ["desktop Safari", `${desktopMac} Version/18.0 Safari/605.1.15`, 0, false],
    ["desktop Chrome", `${desktopMac} Chrome/130.0.0.0 Safari/537.36`, 1, false],
    ["Windows touchscreen", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0", 10, false],
  ] as const)("classifies %s", (_label, ua, touchPoints, expected) => {
    expect(isMobileBrowser(ua, touchPoints)).toBe(expected);
  });

  it.each([
    [undefined, false],
    [{ userAgent: desktopMac, maxTouchPoints: 5 }, true],
  ] as const)("handles the default navigator value %o", (browserNavigator, expected) => {
    vi.stubGlobal("navigator", browserNavigator);
    try {
      expect(isMobileBrowser()).toBe(expected);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("resolvePresetOpenDecision", () => {
  const cases: Array<{
    description: string;
    probe: HelperProbe | null;
    desktop: "open-helper" | "guide-install";
  }> = [
    { description: "pending probe", probe: null, desktop: "guide-install" },
    { description: "not running", probe: { state: "not-running" }, desktop: "guide-install" },
    { description: "blocked or refused", probe: { state: "blocked" }, desktop: "guide-install" },
    { description: "running and paired", probe: { state: "running", hello: HELLO }, desktop: "open-helper" },
    {
      description: "running and unpaired",
      probe: { state: "running", hello: { ...HELLO, paired: false } },
      desktop: "open-helper",
    },
  ];
  it.each(cases)("uses the device-specific action for $description", ({ probe, desktop }) => {
    expect(resolvePresetOpenDecision(probe, false)).toBe(desktop);
    expect(resolvePresetOpenDecision(probe, true)).toBe("guide-mobile");
  });
});

describe("helperHandoffUrl", () => {
  it("encodes a pairing code into the local page hash", () => {
    expect(helperHandoffUrl({ pair: "mpc_abc.def" })).toBe(
      `${HELPER_ORIGIN}/#pair=mpc_abc.def`,
    );
  });

  it("encodes ticket and agent key for the join fallback", () => {
    expect(helperHandoffUrl({ ticket: "mjt_x.y", agentKey: "codex" })).toBe(
      `${HELPER_ORIGIN}/#ticket=mjt_x.y&agent=codex`,
    );
  });

  it("percent-escapes characters that would break hash parsing", () => {
    const url = helperHandoffUrl({ ticket: "a&b#c%d e", agentKey: "manual:1234" });
    expect(url).not.toContain("#c");
    const hash = new URL(url).hash.slice(1);
    const params = new URLSearchParams(hash);
    expect(params.get("ticket")).toBe("a&b#c%d e");
    expect(params.get("agent")).toBe("manual:1234");
  });

  it("round-trips pair codes containing reserved characters", () => {
    const url = helperHandoffUrl({ pair: "mpc_a+b=c&d" });
    const params = new URLSearchParams(new URL(url).hash.slice(1));
    expect(params.get("pair")).toBe("mpc_a+b=c&d");
  });

  it("encodes preset with optional roomId and pairCode into the local page hash", () => {
    expect(helperHandoffUrl({ preset: "grok" })).toBe(`${HELPER_ORIGIN}/#preset=grok`);
    expect(helperHandoffUrl({ preset: "grok", roomId: "" })).toBe(`${HELPER_ORIGIN}/#preset=grok`);
    expect(helperHandoffUrl({ preset: "muse", roomId: "room-42" })).toBe(
      `${HELPER_ORIGIN}/#preset=muse&room=room-42`,
    );
    expect(helperHandoffUrl({ preset: "grok", roomId: "room-42", pairCode: "mpc_99.zz" })).toBe(
      `${HELPER_ORIGIN}/#pair=mpc_99.zz&preset=grok&room=room-42`,
    );
  });
});

describe("helper install commands", () => {
  it.each([
    { hubOrigin: "https://parlor.example", webOrigin: "https://parlor.example" },
    { hubOrigin: "http://127.0.0.1:8000", webOrigin: "http://127.0.0.1:5173" },
  ])("downloads scripts from $webOrigin and pairs with $hubOrigin", ({ hubOrigin, webOrigin }) => {
    const code = "mpc_123.abc";
    const shell = shellInstallCommand(code, { hubOrigin, webOrigin });
    const powershell = powershellInstallCommand(code, { hubOrigin, webOrigin });
    expect(shell).toContain(`curl -fsSL '${webOrigin}/install.sh'`);
    expect(shell).toContain(`--pair '${code}' --hub '${hubOrigin}'`);
    expect(powershell).toContain(`irm '${webOrigin}/install.ps1' -UseBasicParsing`);
    expect(powershell).toContain(`-Pair '${code}' -Hub '${hubOrigin}'`);
    const packageUrl = `'${webOrigin}/downloads/xmtp-member-latest.tar.gz'`;
    if (hubOrigin === webOrigin) {
      expect(shell).not.toContain("MAPR_PKG_URL");
      expect(powershell).not.toContain("MAPR_PKG_URL");
    } else {
      expect(shell).toContain(`MAPR_PKG_URL=${packageUrl} sh`);
      expect(powershell).toContain(`$env:MAPR_PKG_URL = ${packageUrl}`);
    }
  });
});

it("uses the Hub pairing code and expiry without taking a command from the response", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    const issued = { code: "mpc_123.abc", expires_at: "2099-01-01T00:10:00Z" };
    fetch.mockResolvedValueOnce(Response.json({ ...issued, install_command: "ignore me" }));
    await expect(createPairingCode()).resolves.toEqual(issued);
    fetch.mockResolvedValueOnce(Response.json({ ...issued, expires_at: "invalid" }));
    await expect(createPairingCode()).rejects.toThrow("配对码响应无效");
  } finally {
    fetch.mockRestore();
  }
});

describe("room invite Hub API helpers", () => {
  it("createRoomInvite posts to /api/v1/rooms/:id/invites and returns invite", async () => {
    const originalFetch = globalThis.fetch;
    let seenUrl = "";
    let seenMethod = "";
    let seenBody = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenMethod = init?.method ?? "GET";
      seenBody = String(init?.body ?? "");
      return jsonResponse({
        invite: {
          token: "inv_tok_1",
          room_id: "room-a",
          created_by: "u-owner",
          proposed_scopes: [],
          expires_at: "2026-11-20T00:00:00Z",
          used_at: null,
          redeemed_by_address: null,
          created_at: "2026-11-17T00:00:00Z",
        },
      });
    }) as typeof fetch;
    try {
      const invite = await createRoomInvite("room-a", { expires_hours: 48 });
      expect(seenUrl).toBe("/api/v1/rooms/room-a/invites");
      expect(seenMethod).toBe("POST");
      expect(JSON.parse(seenBody)).toEqual({
        proposed_scopes: [],
        expires_hours: 48,
        max_uses: 1,
        requires_approval: false,
        role: "member",
      });
      expect(invite.token).toBe("inv_tok_1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("createRoomInvite forwards reusable-invite options", async () => {
    const originalFetch = globalThis.fetch;
    let seenBody = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenBody = String(init?.body ?? "");
      return jsonResponse({ invite: { token: "inv_tok_2" } });
    }) as typeof fetch;
    try {
      await createRoomInvite("room-a", {
        max_uses: 8,
        requires_approval: true,
        role: "viewer",
        proposed_scopes: ["gmail.send"],
        expires_hours: 24,
      });
      expect(JSON.parse(seenBody)).toEqual({
        proposed_scopes: ["gmail.send"],
        expires_hours: 24,
        max_uses: 8,
        requires_approval: true,
        role: "viewer",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("revokeRoomInvite issues DELETE and surfaces 409 as HubHttpError", async () => {
    const originalFetch = globalThis.fetch;
    let seenUrl = "";
    let seenMethod = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenMethod = init?.method ?? "GET";
      return jsonResponse({ ok: true });
    }) as typeof fetch;
    try {
      await revokeRoomInvite("room-a", "tok x");
      expect(seenUrl).toBe("/api/v1/rooms/room-a/invites/tok%20x");
      expect(seenMethod).toBe("DELETE");
    } finally {
      globalThis.fetch = originalFetch;
    }

    globalThis.fetch = (async () =>
      jsonResponse({ detail: "Invite already redeemed" }, 409)) as typeof fetch;
    try {
      await expect(revokeRoomInvite("room-a", "tok x")).rejects.toThrowError(
        expect.objectContaining({ status: 409 }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("pauseRoomSeat/resumeRoomSeat POST to the seat lifecycle endpoints", async () => {
    const originalFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${String(input)}`);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
      await pauseRoomSeat("room-a", "seat-1");
      await resumeRoomSeat("room-a", "seat-1");
      expect(seen).toEqual([
        "POST /api/v1/rooms/room-a/seats/seat-1/pause",
        "POST /api/v1/rooms/room-a/seats/seat-1/resume",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("listRoomInvites reads /api/v1/rooms/:id/invites", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonResponse({
        invites: [
          {
            token: "inv_1",
            room_id: "room-a",
            created_by: "u-owner",
            proposed_scopes: [],
            expires_at: "2026-11-20T00:00:00Z",
            used_at: "2026-11-17T10:00:00Z",
            redeemed_by_address: "0x1111111111111111111111111111111111111111",
            created_at: "2026-11-17T00:00:00Z",
          },
        ],
      })) as typeof fetch;
    try {
      const list = await listRoomInvites("room-a");
      expect(list).toHaveLength(1);
      expect(list[0].redeemed_by_address).toBe("0x1111111111111111111111111111111111111111");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("acceptRoomInvite posts to /api/v1/invites/:token/accept and returns room_id + role", async () => {
    const originalFetch = globalThis.fetch;
    let seenUrl = "";
    let seenMethod = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenMethod = init?.method ?? "GET";
      return jsonResponse({
        room_id: "room-a",
        role: "member",
      });
    }) as typeof fetch;
    try {
      const out = await acceptRoomInvite("inv/tok 99");
      expect(seenUrl).toBe("/api/v1/invites/inv%2Ftok%2099/accept");
      expect(seenMethod).toBe("POST");
      expect(out).toEqual({ room_id: "room-a", role: "member" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("redeemRoomInvite posts address + nonce + signature to /api/v1/invites/:token/redeem", async () => {
    const originalFetch = globalThis.fetch;
    let seenUrl = "";
    let seenBody = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenBody = String(init?.body ?? "");
      return jsonResponse({
        room_id: "room-a",
        xmtp_group_id: "grp-1",
        status: "consumed",
        redemption_id: "red-1",
      });
    }) as typeof fetch;
    try {
      const out = await redeemRoomInvite("tok/with space", {
        xmtp_address: "0x2222222222222222222222222222222222222222",
        nonce: "n-1",
        signature: "0xsig",
      });
      expect(seenUrl).toBe("/api/v1/invites/tok%2Fwith%20space/redeem");
      expect(JSON.parse(seenBody)).toEqual({
        xmtp_address: "0x2222222222222222222222222222222222222222",
        nonce: "n-1",
        signature: "0xsig",
      });
      expect(out.status).toBe("consumed");
      expect(out.room_id).toBe("room-a");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("redeemRoomInvite returns pending status for approval-gated invites", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonResponse({ status: "pending", redemption_id: "red-9" })) as typeof fetch;
    try {
      const out = await redeemRoomInvite("tok", {
        xmtp_address: "0x2222222222222222222222222222222222222222",
        nonce: "n-2",
        signature: "0xsig",
      });
      expect(out).toEqual({ status: "pending", redemption_id: "red-9" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("issueSignatureNonce posts action+resource+address to /api/v1/invites/nonce", async () => {
    const originalFetch = globalThis.fetch;
    let seenUrl = "";
    let seenBody = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenBody = String(init?.body ?? "");
      return jsonResponse(
        { nonce: "n-1", message: "MAPR-XP1\naction: bind-address\n...", expires_at: "2026-11-20T01:00:00Z" },
        201,
      );
    }) as typeof fetch;
    try {
      const out = await issueSignatureNonce({
        action: "bind-address",
        resource: "room-a",
        address: "0x2222222222222222222222222222222222222222",
      });
      expect(seenUrl).toBe("/api/v1/invites/nonce");
      expect(JSON.parse(seenBody)).toEqual({
        action: "bind-address",
        resource: "room-a",
        address: "0x2222222222222222222222222222222222222222",
      });
      expect(out.nonce).toBe("n-1");
      expect(out.message).toContain("bind-address");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("bindMyXmtpAddress PUTs the signed payload to members/me/xmtp-address", async () => {
    const originalFetch = globalThis.fetch;
    let seenUrl = "";
    let seenMethod = "";
    let seenBody = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenMethod = init?.method ?? "GET";
      seenBody = String(init?.body ?? "");
      return jsonResponse({ ok: true, xmtp_address: "0x2222222222222222222222222222222222222222" });
    }) as typeof fetch;
    try {
      const out = await bindMyXmtpAddress("room-a", {
        xmtp_address: "0x2222222222222222222222222222222222222222",
        nonce: "n-3",
        signature: "0xsig",
      });
      expect(seenUrl).toBe("/api/v1/rooms/room-a/members/me/xmtp-address");
      expect(seenMethod).toBe("PUT");
      expect(JSON.parse(seenBody)).toEqual({
        xmtp_address: "0x2222222222222222222222222222222222222222",
        nonce: "n-3",
        signature: "0xsig",
      });
      expect(out.ok).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("listRoomRedemptions passes the status filter and unwraps redemptions", async () => {
    const originalFetch = globalThis.fetch;
    let seenUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seenUrl = String(input);
      return jsonResponse({
        redemptions: [
          { id: "red-1", token: "t", kind: "human", status: "pending", redeemer_address: "0xabc" },
        ],
      });
    }) as typeof fetch;
    try {
      const list = await listRoomRedemptions("room-a", "pending");
      expect(seenUrl).toBe("/api/v1/rooms/room-a/redemptions?status=pending");
      expect(list).toHaveLength(1);
      expect(list[0].status).toBe("pending");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("listRoomRedemptions exposes the seat ID for a consumed cloud invite", async () => {
    const redemption = {
      id: "red-cloud",
      token: "invite-cloud",
      kind: "agent",
      status: "consumed",
      seat_id: "seat-cloud",
    };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/v1/rooms/room%2Fcloud/redemptions");
      return jsonResponse({ redemptions: [redemption] });
    });
    try {
      expect(await listRoomRedemptions("room/cloud")).toEqual([redemption]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("approveRedemption and denyRedemption POST to the owner queue endpoints", async () => {
    const originalFetch = globalThis.fetch;
    const seen: { url: string; body: string }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), body: String(init?.body ?? "") });
      return jsonResponse({ redemption: { id: "red-1", status: "consumed" } });
    }) as typeof fetch;
    try {
      const approved = await approveRedemption("room-a", "red-1", {
        approved_scopes: ["gmail.send"],
      });
      expect(seen[0].url).toBe("/api/v1/rooms/room-a/redemptions/red-1/approve");
      expect(JSON.parse(seen[0].body)).toEqual({ approved_scopes: ["gmail.send"] });
      expect(approved.status).toBe("consumed");

      const denied = await denyRedemption("room-a", "red-2", "不认识这位申请人");
      expect(seen[1].url).toBe("/api/v1/rooms/room-a/redemptions/red-2/deny");
      expect(JSON.parse(seen[1].body)).toEqual({ reason: "不认识这位申请人" });
      expect(denied.status).toBe("consumed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("formatInviteAcceptError maps statuses, connectivity failures, and fallback error messages accurately", () => {
    expect(formatInviteAcceptError(new HubHttpError("Invite token already redeemed", 409))).toBe(
      "该入群邀请链接已被使用，请向房主索取新的邀请链接。",
    );
    expect(formatInviteAcceptError(new Error("Invite token already redeemed"))).toBe(
      "该入群邀请链接已被使用，请向房主索取新的邀请链接。",
    );
    expect(formatInviteAcceptError(new HubHttpError("Invite token expired", 410))).toBe(
      "该入群邀请链接已过期，请向房主索取新的邀请链接。",
    );
    expect(formatInviteAcceptError(new Error("token expired"))).toBe(
      "该入群邀请链接已过期，请向房主索取新的邀请链接。",
    );
    expect(formatInviteAcceptError(new HubHttpError("Invite token not found", 404))).toBe(
      "入群邀请链接无效或不存在。",
    );
    expect(formatInviteAcceptError(new TypeError("Failed to fetch"))).toBe(
      "暂时连不上服务器，检查网络连接后再试。",
    );
    expect(formatInviteAcceptError(new Error("网络暂时不可用"))).toBe("网络暂时不可用");
  });
});
