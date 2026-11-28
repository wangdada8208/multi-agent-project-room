// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { recoverMessageAddress } from "viem";
import {
  clearUnlockedXmtpKey,
  createBrowserSigner,
  decryptPrivateKey,
  encryptPrivateKey,
  hasUnlockedXmtpKey,
  hubSafeIdentity,
  inboxAddress,
  setUnlockedXmtpKey,
  signXmtpMessage,
  unlockOrCreateInboxKey,
  lockXmtpIdentity,
  rememberUnlockedXmtpKey,
  resetLocalXmtpIdentity,
  SESSION_UNLOCK_STORAGE_KEY,
  XmtpIdentityError,
  unlockedXmtpAddress,
  LEGACY_STORAGE_KEY,
  storeEncryptedKey,
  unlockPrivateKey,
  VAULT_STORAGE_KEY,
  DEFAULT_PBKDF2_ITERATIONS,
} from "./xmtpLocalIdentity";

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

  it("creates and reloads an identity without persisting plaintext", async () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => {
        mem.set(k, v);
      },
      removeItem: (k: string) => { mem.delete(k); },
    };
    const key = await unlockOrCreateInboxKey("long test password", storage, 1000);
    expect(key).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(mem.has(LEGACY_STORAGE_KEY)).toBe(false);
    expect([...mem.values()].join("")).not.toContain(key);
    const loaded = await unlockOrCreateInboxKey("long test password", storage, 1000);
    expect(loaded).toBe(key);
  });

  it("migrates the same legacy identity only after verifying persisted ciphertext", async () => {
    const oldKey = "0x" + "11".repeat(32);
    const mem = new Map([[LEGACY_STORAGE_KEY, oldKey]]);
    const storage = { getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => { mem.set(k, v); },
      removeItem: (k: string) => { mem.delete(k); } };
    expect(await unlockOrCreateInboxKey("long test password", storage, 1000)).toBe(oldKey);
    expect(mem.has(LEGACY_STORAGE_KEY)).toBe(false);
    await expect(unlockOrCreateInboxKey("incorrect password", storage, 1000)).rejects.toThrow();
    expect(await unlockOrCreateInboxKey("long test password", storage, 1000)).toBe(oldKey);
  });

  it("preserves legacy identity when encrypted storage fails", async () => {
    const oldKey = "0x" + "11".repeat(32);
    const mem = new Map([[LEGACY_STORAGE_KEY, oldKey]]);
    const storage = { getItem: (k: string) => mem.get(k) ?? null,
      setItem: () => { throw new Error("storage full"); },
      removeItem: (k: string) => { mem.delete(k); } };
    await expect(unlockOrCreateInboxKey("long test password", storage, 1000)).rejects.toMatchObject({
      name: "XmtpIdentityError",
      code: "identity-save-failed",
    });
    expect(mem.get(LEGACY_STORAGE_KEY)).toBe(oldKey);
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

describe("inboxAddress", () => {
  it("derives the lowercase address of a public test key", () => {
    expect(
      inboxAddress("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"),
    ).toBe("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
  });
});

describe("WebCrypto Vault Password Protection (Task E-4)", () => {
  const sampleKey = "0x" + "cafe".repeat(16);
  const password = "correct-horse-battery-staple";

  it("encrypts with at least 310,000 PBKDF2 iterations and stores no plaintext", async () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => {
        mem.set(k, v);
      },
    };

    await storeEncryptedKey(sampleKey, password, storage, 1000); // 1000 for fast unit test
    const rawStored = mem.get(VAULT_STORAGE_KEY)!;
    expect(rawStored).toBeDefined();

    // 存储中绝无明文私钥
    expect(rawStored).not.toContain(sampleKey);
    expect(rawStored).not.toContain(sampleKey.slice(2));

    const parsed = JSON.parse(rawStored);
    expect(parsed.version).toBe(1);
    expect(parsed.salt).toMatch(/^0x[0-9a-f]{32}$/);
    expect(parsed.iv).toMatch(/^0x[0-9a-f]{24}$/);
    expect(parsed.ciphertext).toMatch(/^0x/);
  });

  it("verifies DEFAULT_PBKDF2_ITERATIONS satisfies security guideline (>=310000)", () => {
    expect(DEFAULT_PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(310000);
  });

  it("fails decryption with a structured incorrect-password error", async () => {
    const vault = await encryptPrivateKey(sampleKey, password, 1000);
    await expect(decryptPrivateKey(vault, "wrong-password")).rejects.toMatchObject({
      name: "XmtpIdentityError",
      code: "incorrect-password",
    });
  });

  it("successfully unlocks repeatedly with the same password", async () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => {
        mem.set(k, v);
      },
    };

    await storeEncryptedKey(sampleKey, password, storage, 1000);

    const key1 = await unlockPrivateKey(password, storage);
    expect(key1).toBe(sampleKey);

    const key2 = await unlockPrivateKey(password, storage);
    expect(key2).toBe(sampleKey);
  });
});

describe("browser-session unlock state", () => {
  const key = "0x" + "ef".repeat(32);

  it("keeps the key out of localStorage and remembers it only in sessionStorage when requested", () => {
    rememberUnlockedXmtpKey(key, true);
    expect(sessionStorage.getItem(SESSION_UNLOCK_STORAGE_KEY)).toBe(key);
    expect(localStorage.getItem(SESSION_UNLOCK_STORAGE_KEY)).toBeNull();
    lockXmtpIdentity();
    expect(sessionStorage.getItem(SESSION_UNLOCK_STORAGE_KEY)).toBeNull();
  });

  it("resetLocalXmtpIdentity removes vault, legacy plaintext and session unlock state", async () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => { mem.set(k, v); },
      removeItem: (k: string) => { mem.delete(k); },
    };
    await storeEncryptedKey(key, "long test password", storage, 1000);
    mem.set(LEGACY_STORAGE_KEY, key);
    rememberUnlockedXmtpKey(key, true);

    resetLocalXmtpIdentity(storage);

    expect(mem.has(VAULT_STORAGE_KEY)).toBe(false);
    expect(mem.has(LEGACY_STORAGE_KEY)).toBe(false);
    expect(sessionStorage.getItem(SESSION_UNLOCK_STORAGE_KEY)).toBeNull();
    expect(hasUnlockedXmtpKey()).toBe(false);
  });

  it("logout clears the remembered browser-session unlock state", async () => {
    const { useAuthStore } = await import("../stores/authStore");
    rememberUnlockedXmtpKey(key, true);
    useAuthStore.getState().logout();
    expect(sessionStorage.getItem(SESSION_UNLOCK_STORAGE_KEY)).toBeNull();
    expect(hasUnlockedXmtpKey()).toBe(false);
  });
});


describe("signXmtpMessage (unlocked-session signing)", () => {
  const key = "0x" + "cd".repeat(32);

  it("throws a friendly error when the local identity is locked", async () => {
    clearUnlockedXmtpKey();
    await expect(signXmtpMessage("MAPR 签名测试")).rejects.toThrow(/未解锁/);
    expect(hasUnlockedXmtpKey()).toBe(false);
    expect(unlockedXmtpAddress()).toBeNull();
  });

  it("signs a verifiable EIP-191 message and derives the matching address", async () => {
    setUnlockedXmtpKey(key);
    try {
      expect(hasUnlockedXmtpKey()).toBe(true);
      expect(unlockedXmtpAddress()).toBe(inboxAddress(key));
      const message = "MAPR bind-address\nnonce: abc";
      const signature = await signXmtpMessage(message);
      expect(signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
      const recovered = await recoverMessageAddress({
        message,
        signature: signature as `0x${string}`,
      });
      expect(recovered.toLowerCase()).toBe(inboxAddress(key));
    } finally {
      clearUnlockedXmtpKey();
    }
  });

  it("clearUnlockedXmtpKey revokes signing without touching storage", async () => {
    setUnlockedXmtpKey(key);
    clearUnlockedXmtpKey();
    await expect(signXmtpMessage("again")).rejects.toThrow(/未解锁/);
    expect(unlockedXmtpAddress()).toBeNull();
  });
});
