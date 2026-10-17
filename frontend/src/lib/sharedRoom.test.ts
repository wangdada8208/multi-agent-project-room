import { describe, expect, it, vi } from "vitest";

// 与 requestId.test.ts 相同：api.ts 模块加载时会读 localStorage。
const memoryStorage = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage = {
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
} as Storage;

const { sharedMessagesPath, fetchSharedRoomMessages } = await import("./api");

describe("sharedMessagesPath", () => {
  it("uses the path the backend actually serves", () => {
    // 后端定义在 backend/app/api/rooms.py，路由前缀 /api/v1/rooms，路径 /shared/{token}/messages。
    expect(sharedMessagesPath("abc123")).toBe("/api/v1/rooms/shared/abc123/messages");
  });

  it("encodes the token so it cannot break out of the path segment", () => {
    expect(sharedMessagesPath("a/b?c=d")).toBe("/api/v1/rooms/shared/a%2Fb%3Fc%3Dd/messages");
  });
});

describe("fetchSharedRoomMessages", () => {
  it("requests the corrected path and returns the room name with the messages", async () => {
    const requested: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response(
        JSON.stringify({
          room_name: "发布讨论",
          messages: [
            {
              id: "m1",
              sender_id: "u1",
              sender_type: "agent",
              sender_name: "小助手",
              content: "已完成",
              created_at: "2026-10-17T10:00:00+00:00",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const result = await fetchSharedRoomMessages("abc123");
      expect(requested).toEqual(["/api/v1/rooms/shared/abc123/messages"]);
      expect(result.roomName).toBe("发布讨论");
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].sender_name).toBe("小助手");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("turns 404 into the expired-link message instead of a generic failure", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
    try {
      await expect(fetchSharedRoomMessages("gone")).rejects.toMatchObject({
        status: 404,
        message: "链接已过期或不存在",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
