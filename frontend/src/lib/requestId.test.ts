import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_REQUEST_ID_HEADER, apiFetch } from "./api";

const fetcher = vi.fn<typeof fetch>();

beforeEach(() => {
  fetcher.mockReset().mockImplementation(async () => Response.json({}));
  vi.stubGlobal("fetch", fetcher);
});

afterEach(() => vi.unstubAllGlobals());

describe("apiFetch request IDs", () => {
  const path = "/api/v1/rooms";

  it("gives each request a different supportable id", async () => {
    await apiFetch(path);
    await apiFetch(path);

    const seen = fetcher.mock.calls.map(([, init]) => new Headers(init?.headers).get(API_REQUEST_ID_HEADER));
    expect(seen).toHaveLength(2);
    for (const id of seen) expect(id).toMatch(/^[0-9a-f-]{8,}$/i);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("keeps a request id that the caller already supplied", async () => {
    await apiFetch(path, { headers: { [API_REQUEST_ID_HEADER]: "caller-chosen-1234" } });

    const [, init] = fetcher.mock.calls[0];
    expect(new Headers(init?.headers).get(API_REQUEST_ID_HEADER)).toBe("caller-chosen-1234");
  });

  it("adds the id only to headers and keeps existing headers", async () => {
    const body = '{"content":"正文"}';
    await apiFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    const [url, init] = fetcher.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(url).toBe(path);
    expect(init?.body).toBe(body);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get(API_REQUEST_ID_HEADER)).toBeTruthy();
  });
});
