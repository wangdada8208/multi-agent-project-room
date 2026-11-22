import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { planMemberRemoval, PermissionsPanel } from "./PermissionsPanel";
import { sanitizeScopes, scopeIsForbidden } from "../../lib/api";

const ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("scopeIsForbidden / sanitizeScopes", () => {
  it("rejects every hard-forbidden prefix and the data.export_all scope", () => {
    for (const s of [
      "payment.charge",
      "banking.transfer",
      "credentials.read",
      "password.manager",
      "card.charge",
      "wallet.send",
      "data.export_all",
      "PAYMENT.CHARGE",
      " Data.Export_All ",
    ]) {
      expect(scopeIsForbidden(s), s).toBe(true);
    }
    for (const s of ["gmail.send", "calendar.free_busy", "data.read_own"]) {
      expect(scopeIsForbidden(s), s).toBe(false);
    }
  });

  it("keeps valid scopes, drops forbidden and malformed ones, dedupes", () => {
    const { kept, dropped } = sanitizeScopes([
      "gmail.send",
      "payment.charge",
      "GMAIL.SEND",
      "not a scope",
      "data.export_all",
      "",
      "task.run",
    ]);
    expect(kept).toEqual(["gmail.send", "task.run"]);
    expect(dropped).toEqual(["payment.charge", "not a scope", "data.export_all"]);
  });
});

describe("planMemberRemoval (S2 invariant)", () => {
  it("requires XMTP-first removal for encrypted members with a bound address", () => {
    expect(planMemberRemoval({ xmtp_address: ADDR }, true)).toBe("must-leave-group");
  });

  it("needs an honest confirm for encrypted members without a bound address", () => {
    expect(planMemberRemoval({ xmtp_address: null }, true)).toBe("needs-confirm");
    expect(planMemberRemoval({ xmtp_address: "not-an-address" }, true)).toBe("needs-confirm");
  });

  it("plain rooms skip the group step entirely", () => {
    expect(planMemberRemoval({ xmtp_address: ADDR }, false)).toBe("direct");
    expect(planMemberRemoval({ xmtp_address: null }, false)).toBe("direct");
  });
});

describe("PermissionsPanel markup", () => {
  it("renders the member list shell without crashing", () => {
    const html = renderToStaticMarkup(
      <PermissionsPanel roomId="room-1" isEncrypted={true} isOwner={false} />,
    );
    expect(html).toContain("按用户名添加房间成员权限");
  });
});
