import { describe, expect, it } from "vitest";
import { IdentifierKind } from "@xmtp/browser-sdk";
import { memberIdentifier, assertWorkerAddress } from "./xmtpGroup";

describe("memberIdentifier", () => {
  it("rejects a missing worker address", () => {
    expect(() => assertWorkerAddress("")).toThrow(/worker address required/);
  });

  it("builds an ethereum identifier and hides nothing else", () => {
    const identifier = memberIdentifier("0x1111111111111111111111111111111111111111");
    expect(identifier).toEqual({
      identifier: "0x1111111111111111111111111111111111111111",
      identifierKind: IdentifierKind.Ethereum,
    });
  });
});
