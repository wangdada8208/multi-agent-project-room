import { afterEach, expect, it, vi } from "vitest";
import { apiJson, ApiError } from "./apiError";

afterEach(() => vi.unstubAllGlobals());

it("returns JSON and leaves the method, endpoint and request body intact", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ value: 7 }));
  vi.stubGlobal("fetch", fetcher);
  await expect(apiJson("/api/v1/example", { method: "POST", body: '{"value":7}' })).resolves.toEqual({ value: 7 });
  expect(fetcher).toHaveBeenCalledWith("/api/v1/example", expect.objectContaining({ method: "POST", body: '{"value":7}' }));
});

it.each([403, 404, 410])("retains status %s and structured backend errors", async (status) => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ detail: { code: "unavailable", message: "无法访问" } }, { status })));
  await expect(apiJson("/api/v1/example")).rejects.toBeInstanceOf(ApiError);
  await expect(apiJson("/api/v1/example")).rejects.toMatchObject({ status, code: "unavailable", message: "无法访问" });
});

it("uses FastAPI string details and falls back for non-JSON responses", async () => {
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(Response.json({ detail: "expired" }, { status: 410 }))
    .mockResolvedValueOnce(new Response("<html>Bad Gateway</html>", { status: 502 })));
  await expect(apiJson("/api/v1/example")).rejects.toMatchObject({ status: 410, message: "expired" });
  await expect(apiJson("/api/v1/example")).rejects.toMatchObject({ status: 502, code: "HTTP_502", message: "HTTP 502" });
});
