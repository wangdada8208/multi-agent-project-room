import { describe, expect, it } from "vitest";
import {
  HELPER_ORIGIN,
  HubHttpError,
  acceptRoomInvite,
  createRoomInvite,
  formatInviteAcceptError,
  helperHandoffUrl,
  joinViaTicket,
  listRoomInvites,
  localErrorMessage,
  powershellInstallCommand,
  probeHelper,
  redeemRoomInvite,
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

const HELLO = {
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

describe("localErrorMessage", () => {
  it("prefers body.reason from 127.0.0.1:8790 before detail and error", async () => {
    expect(localErrorMessage({ ok: false, reason: "ticket 已过期", detail: "ignored" }, "兜底")).toBe(
      "ticket 已过期",
    );
    expect(localErrorMessage({ detail: "详情错误" }, "兜底")).toBe("详情错误");
    expect(localErrorMessage({ error: "通用错误" }, "兜底")).toBe("通用错误");
    expect(localErrorMessage(null, "兜底")).toBe("兜底");

    await expect(
      joinViaTicket("mjt_1", "codex", async () => jsonResponse({ ok: false, reason: "助手尚未配对" }, 403)),
    ).rejects.toThrow("助手尚未配对");
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

describe("powershellInstallCommand", () => {
  it("builds a PowerShell one-liner with trimmed hub origin and pairing code", () => {
    expect(powershellInstallCommand("mpc_123.abc", "https://hub.wangdada8208.xyz///")).toBe(
      'iex "& { $(irm https://hub.wangdada8208.xyz/install.ps1 -UseBasicParsing) } -Pair mpc_123.abc -Hub https://hub.wangdada8208.xyz"',
    );
  });
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
      const invite = await createRoomInvite("room-a", 48);
      expect(seenUrl).toBe("/api/v1/rooms/room-a/invites");
      expect(seenMethod).toBe("POST");
      expect(JSON.parse(seenBody)).toEqual({ proposed_scopes: [], expires_hours: 48 });
      expect(invite.token).toBe("inv_tok_1");
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

  it("redeemRoomInvite posts xmtp_address to /api/v1/invites/:token/redeem", async () => {
    const originalFetch = globalThis.fetch;
    let seenUrl = "";
    let seenBody = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenBody = String(init?.body ?? "");
      return jsonResponse({
        room_id: "room-a",
        xmtp_group_id: "grp-1",
      });
    }) as typeof fetch;
    try {
      const out = await redeemRoomInvite(
        "tok/with space",
        "0x2222222222222222222222222222222222222222",
      );
      expect(seenUrl).toBe("/api/v1/invites/tok%2Fwith%20space/redeem");
      expect(JSON.parse(seenBody)).toEqual({
        xmtp_address: "0x2222222222222222222222222222222222222222",
      });
      expect(out).toEqual({ room_id: "room-a", xmtp_group_id: "grp-1" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("formatInviteAcceptError maps 409, 410, 404, and fallback error messages accurately", () => {
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
    expect(formatInviteAcceptError(new Error("网络暂时不可用"))).toBe("网络暂时不可用");
  });
});
