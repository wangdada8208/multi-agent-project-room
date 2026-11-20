import { describe, expect, it } from "vitest";
import {
  OWNER_HEADER,
  OwnerConsoleError,
  decideOwnerConsent,
  fetchConsentDetail,
  fetchOwnerConsoleState,
  ownerConsolePageUrl,
  ownerConsoleUrl,
} from "./ownerConsole";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ownerConsole client", () => {
  it("builds loopback URLs on the seat console port", () => {
    expect(ownerConsoleUrl(8791, "/api/state")).toBe("http://127.0.0.1:8791/api/state");
    expect(ownerConsolePageUrl(8791)).toBe("http://127.0.0.1:8791/");
  });

  it("sends the X-MAPR-Owner header on every console call", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, headers: new Headers(init?.headers) });
      if (url.includes("/api/consents/")) {
        return jsonResponse({ ok: true, consent: { request_id: "req-1", params: {} } });
      }
      return jsonResponse({ self: "0xself", consents: [] });
    }) as typeof fetch;

    await fetchOwnerConsoleState(8791, fakeFetch);
    expect(seen[0].url).toBe("http://127.0.0.1:8791/api/state");
    expect(seen[0].headers.get(OWNER_HEADER)).toBe("1");

    await fetchConsentDetail(8791, "req-1", fakeFetch);
    expect(seen[1].headers.get(OWNER_HEADER)).toBe("1");

    await decideOwnerConsent(8791, "req-1", "resend", fakeFetch);
    expect(seen[2].url).toBe("http://127.0.0.1:8791/api/consents/req-1/resend");
    expect(seen[2].headers.get(OWNER_HEADER)).toBe("1");
  });

  it("approve/deny/resend hit the correct console routes", async () => {
    const urls: string[] = [];
    const fakeFetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return jsonResponse({ ok: true });
    }) as typeof fetch;
    await decideOwnerConsent(8791, "r/a b", "approve", fakeFetch);
    await decideOwnerConsent(8791, "r2", "deny", fakeFetch);
    expect(urls[0]).toBe("http://127.0.0.1:8791/api/consents/r%2Fa%20b/approve");
    expect(urls[1]).toBe("http://127.0.0.1:8791/api/consents/r2/deny");
  });

  it("fetchConsentDetail unwraps {consent} and errors on missing item", async () => {
    const ok = (async () =>
      jsonResponse({ ok: true, consent: { request_id: "r1", params: { to: "a@b.c" } } })) as typeof fetch;
    const detail = await fetchConsentDetail(8791, "r1", ok);
    expect(detail.request_id).toBe("r1");
    expect(detail.params).toEqual({ to: "a@b.c" });

    const missing = (async () => jsonResponse({ ok: false, reason: "not_found" }, 404)) as typeof fetch;
    await expect(fetchConsentDetail(8791, "gone", missing)).rejects.toThrowError(
      expect.objectContaining({ status: 404 }),
    );
  });

  it("maps network failures to an honest console-unreachable error", async () => {
    const blocked = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    await expect(fetchOwnerConsoleState(8791, blocked)).rejects.toThrow(OwnerConsoleError);
    await expect(fetchOwnerConsoleState(8791, blocked)).rejects.toThrow(/无法访问本机审批控制台/);
  });
});
