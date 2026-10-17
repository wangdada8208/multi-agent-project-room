import { describe, expect, it } from "vitest";

// api.ts 在模块初始化时读取 localStorage（登录状态），测试环境里没有浏览器存储。
// 必须在 import 之前补上一个最小替身，否则模块加载就会报错。
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

const { API_REQUEST_ID_HEADER, apiFetch, withRequestId } = await import("./api");

describe("withRequestId", () => {
  it("adds a request id header when the caller did not supply one", () => {
    const init = withRequestId({});
    const headers = new Headers(init.headers);
    const value = headers.get(API_REQUEST_ID_HEADER);
    expect(value).toBeTruthy();
    // 客户端编号必须能被服务端识别：只含十六进制和短横线。
    expect(value).toMatch(/^[0-9a-f-]{8,}$/i);
  });

  it("keeps a request id that the caller already supplied", () => {
    const init = withRequestId({
      headers: { [API_REQUEST_ID_HEADER]: "caller-chosen-1234" },
    });
    expect(new Headers(init.headers).get(API_REQUEST_ID_HEADER)).toBe("caller-chosen-1234");
  });

  it("does not overwrite unrelated headers", () => {
    const init = withRequestId({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get(API_REQUEST_ID_HEADER)).toBeTruthy();
  });

  it("never puts the request id into the request body", () => {
    const init = withRequestId({ method: "POST", body: '{"content":"正文"}' });
    expect(init.body).toBe('{"content":"正文"}');
  });

  it("gives each request a different id", async () => {
    const seen: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get(API_REQUEST_ID_HEADER) ?? "");
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      await apiFetch("/api/v1/rooms");
      await apiFetch("/api/v1/rooms");
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeTruthy();
    expect(seen[1]).toBeTruthy();
    expect(seen[0]).not.toBe(seen[1]);
  });
});
