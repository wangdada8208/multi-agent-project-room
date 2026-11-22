import { beforeEach, describe, expect, it } from "vitest";
import {
  clearEncryptedDraft,
  draftStorageKey,
  hasDraftSession,
  loadEncryptedDraft,
  saveEncryptedDraft,
  setDraftSessionKeyMaterial,
} from "./encryptedDrafts";

function makeStorage(): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as Storage & { map: Map<string, string> };
}

const scope = { roomId: "room-1", identityAddress: "0xAbCDef0123456789000000000000000000000000" };

beforeEach(() => {
  setDraftSessionKeyMaterial(null);
});

describe("draft session gating", () => {
  it("does not save or load while the identity is locked", async () => {
    const storage = makeStorage();
    expect(hasDraftSession()).toBe(false);
    expect(await saveEncryptedDraft({ ...scope, text: "秘密草稿", storage })).toBe(false);
    expect(await loadEncryptedDraft({ ...scope, storage })).toBeNull();
    expect(storage.map.size).toBe(0);
  });
});

describe("encrypted draft round-trip", () => {
  it("stores ciphertext (never plaintext) and restores the draft", async () => {
    const storage = makeStorage();
    setDraftSessionKeyMaterial("0xpvtsessionmaterial");
    const secret = "给 @agent 的秘密草稿：明早九点发邮件";
    expect(await saveEncryptedDraft({ ...scope, text: secret, storage })).toBe(true);
    const raw = storage.map.get(draftStorageKey(scope));
    expect(raw).toBeTruthy();
    expect(raw).not.toContain("秘密草稿");
    expect(raw).not.toContain(secret);
    expect(await loadEncryptedDraft({ ...scope, storage })).toBe(secret);
  });

  it("isolates drafts per room and identity", async () => {
    const storage = makeStorage();
    setDraftSessionKeyMaterial("session-material");
    await saveEncryptedDraft({ ...scope, text: "房间一草稿", storage });
    await saveEncryptedDraft({ ...scope, roomId: "room-2", text: "房间二草稿", storage });
    const other = { ...scope, identityAddress: "0x1111111111111111111111111111111111111111" };
    await saveEncryptedDraft({ ...other, text: "另一个身份的草稿", storage });
    expect(await loadEncryptedDraft({ ...scope, storage })).toBe("房间一草稿");
    expect(await loadEncryptedDraft({ ...scope, roomId: "room-2", storage })).toBe("房间二草稿");
    expect(await loadEncryptedDraft({ ...other, storage })).toBe("另一个身份的草稿");
  });

  it("normalizes identity address case for the storage key", () => {
    expect(draftStorageKey(scope)).toBe(draftStorageKey({ ...scope, identityAddress: scope.identityAddress.toLowerCase() }));
    expect(draftStorageKey(scope)).toContain("room-1");
  });

  it("clears the stored draft", async () => {
    const storage = makeStorage();
    setDraftSessionKeyMaterial("session-material");
    await saveEncryptedDraft({ ...scope, text: "待清除", storage });
    clearEncryptedDraft({ ...scope, storage });
    expect(await loadEncryptedDraft({ ...scope, storage })).toBeNull();
    expect(storage.map.size).toBe(0);
  });

  it("saving empty text removes the stored draft", async () => {
    const storage = makeStorage();
    setDraftSessionKeyMaterial("session-material");
    await saveEncryptedDraft({ ...scope, text: "x", storage });
    await saveEncryptedDraft({ ...scope, text: "", storage });
    expect(storage.map.size).toBe(0);
  });
});

describe("fail-safe cleanup", () => {
  it("removes corrupted entries instead of throwing", async () => {
    const storage = makeStorage();
    setDraftSessionKeyMaterial("session-material");
    storage.map.set(draftStorageKey(scope), "{not-json");
    expect(await loadEncryptedDraft({ ...scope, storage })).toBeNull();
    expect(storage.map.size).toBe(0);
  });

  it("removes entries written under a different session key", async () => {
    const storage = makeStorage();
    setDraftSessionKeyMaterial("key-material-A");
    await saveEncryptedDraft({ ...scope, text: "用 A 密钥存的草稿", storage });
    setDraftSessionKeyMaterial("key-material-B");
    expect(await loadEncryptedDraft({ ...scope, storage })).toBeNull();
    expect(storage.map.size).toBe(0);
  });

  it("keeps the ciphertext while locked so it can restore after unlock", async () => {
    const storage = makeStorage();
    setDraftSessionKeyMaterial("session-material");
    await saveEncryptedDraft({ ...scope, text: "锁定前的草稿", storage });
    setDraftSessionKeyMaterial(null);
    expect(await loadEncryptedDraft({ ...scope, storage })).toBeNull();
    expect(storage.map.size).toBe(1);
    setDraftSessionKeyMaterial("session-material");
    expect(await loadEncryptedDraft({ ...scope, storage })).toBe("锁定前的草稿");
  });
});
