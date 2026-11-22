import { bytesToHex, hexToBytes } from "viem";

/**
 * 聊天草稿加密存储：
 * - 草稿按 (roomId, identityAddress) 隔离，localStorage 中只存 AES-GCM 密文。
 * - 加密密钥由 HKDF 派生：密钥材料 = 已解锁会话秘密（XMTP 私钥或 Hub 会话令牌），
 *   salt = 身份地址，info = 房间 ID。密钥材料只存于内存，身份锁定即不可用。
 * - 身份未解锁时读取返回 null 但保留密文（解锁后仍可恢复）；
 *   密文损坏或密钥不匹配时读取返回 null 并清除该条残损数据。
 */

const DRAFT_KEY_PREFIX = "mapr-draft-v1";

export interface DraftScope {
  roomId: string;
  identityAddress: string;
}

interface StoredDraft {
  v: 1;
  iv: string;
  ct: string;
}

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

let sessionKeyMaterial: string | null = null;

export function setDraftSessionKeyMaterial(material: string | null): void {
  sessionKeyMaterial = material || null;
}

export function hasDraftSession(): boolean {
  return sessionKeyMaterial !== null;
}

export function draftStorageKey(scope: DraftScope): string {
  return `${DRAFT_KEY_PREFIX}:${scope.roomId}:${scope.identityAddress.toLowerCase()}`;
}

function resolveStorage(storage?: DraftStorage): DraftStorage | undefined {
  return storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
}

async function deriveDraftKey(scope: DraftScope, material: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(material), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode(`mapr-draft:${scope.identityAddress.toLowerCase()}`) as unknown as BufferSource,
      info: enc.encode(`room:${scope.roomId}`) as unknown as BufferSource,
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function saveEncryptedDraft(input: DraftScope & {
  text: string;
  storage?: DraftStorage;
}): Promise<boolean> {
  const storage = resolveStorage(input.storage);
  if (!storage) return false;
  if (!input.text) {
    clearEncryptedDraft(input);
    return true;
  }
  if (!sessionKeyMaterial) return false;
  const key = await deriveDraftKey(input, sessionKeyMaterial);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    new TextEncoder().encode(input.text),
  );
  const record: StoredDraft = { v: 1, iv: bytesToHex(iv), ct: bytesToHex(new Uint8Array(ciphertext)) };
  storage.setItem(draftStorageKey(input), JSON.stringify(record));
  return true;
}

export async function loadEncryptedDraft(input: DraftScope & {
  storage?: DraftStorage;
}): Promise<string | null> {
  const storage = resolveStorage(input.storage);
  if (!storage || !sessionKeyMaterial) return null;
  const raw = storage.getItem(draftStorageKey(input));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredDraft;
    if (parsed?.v !== 1 || !parsed.iv || !parsed.ct) throw new Error("bad draft record");
    const key = await deriveDraftKey(input, sessionKeyMaterial);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: hexToBytes(parsed.iv as `0x${string}`) as unknown as BufferSource },
      key,
      hexToBytes(parsed.ct as `0x${string}`) as unknown as BufferSource,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    // 密文损坏或密钥不匹配：清除残损条目，绝不让坏数据反复触发。
    storage.removeItem(draftStorageKey(input));
    return null;
  }
}

export function clearEncryptedDraft(input: DraftScope & { storage?: DraftStorage }): void {
  resolveStorage(input.storage)?.removeItem(draftStorageKey(input));
}
