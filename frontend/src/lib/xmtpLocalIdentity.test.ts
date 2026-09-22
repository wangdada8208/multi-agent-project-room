import { describe, expect, it } from "vitest";
import { createBrowserSigner, hubSafeIdentity, loadOrCreateInboxKey } from "./xmtpLocalIdentity";

describe("xmtpLocalIdentity", () => {
  it("hub payload contains the address and not the private key", () => {
    const key = "0x" + "ab".repeat(32);
    const payload = hubSafeIdentity({
      privateKey: key,
      address: "0x1111111111111111111111111111111111111111",
    });
    expect(payload).toEqual({
      address: "0x1111111111111111111111111111111111111111",
    });
    expect(JSON.stringify(payload)).not.toContain(key);
  });

  it("loads or creates a valid 32-byte hex private key", () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => {
        mem.set(k, v);
      },
    };
    const key = loadOrCreateInboxKey(storage);
    expect(key).toMatch(/^0x[0-9a-fA-F]{64}$/);
    const loaded = loadOrCreateInboxKey(storage);
    expect(loaded).toBe(key);
  });

  it("creates an EOA browser signer with valid signature output", async () => {
    const key = "0x" + "11".repeat(32);
    const signer = createBrowserSigner(key);
    expect(signer.type).toBe("EOA");
    const identifier = await signer.getIdentifier();
    expect(identifier.identifier).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const sig = await signer.signMessage("test-message");
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(65);
  });
});
