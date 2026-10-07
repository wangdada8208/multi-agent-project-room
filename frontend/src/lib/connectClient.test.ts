import { describe, expect, it } from "vitest";
import {
  buildConnectUrl,
  parseConnectCallback,
  type ConnectClientRequest,
} from "./connectClient";

describe("connectClient", () => {
  it("buildConnectUrl creates valid authorize URL with parameters", () => {
    const req: ConnectClientRequest = {
      appId: "third-party-store",
      scope: "calendar.free_busy",
      purpose: "预约到店体验",
      redirectUri: "https://store.example.com/callback",
      constraints: { date_from: "2026-10-05", date_to: "2026-10-09" },
    };

    const url = buildConnectUrl("http://127.0.0.1:8787", req);
    expect(url).toContain("http://127.0.0.1:8787/connect/authorize?");
    expect(url).toContain("app_id=third-party-store");
    expect(url).toContain("scope=calendar.free_busy");
    expect(url).toContain("redirect_uri=" + encodeURIComponent("https://store.example.com/callback"));
  });

  it("parseConnectCallback successfully parses grant, signature and data from hash", () => {
    const grant = { grant_id: "g-test" };
    const payload = { busy: [{ start: "2026-10-06T09:00:00.000Z", end: "2026-10-06T10:00:00.000Z" }] };
    const hash = `#grant=${encodeURIComponent(JSON.stringify(grant))}&signature=0xsig&data=${encodeURIComponent(JSON.stringify(payload))}`;

    const parsed = parseConnectCallback(hash);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.grant).toEqual(grant);
    expect(parsed.signature).toBe("0xsig");
    expect(parsed.payload).toEqual(payload);
  });

  it("parseConnectCallback extracts error correctly", () => {
    const hash = "#error=user_denied";
    const parsed = parseConnectCallback(hash);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe("user_denied");
  });
});
