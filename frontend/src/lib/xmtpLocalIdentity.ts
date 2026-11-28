import { bytesToHex, hexToBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Client, IdentifierKind, type Signer } from "@xmtp/browser-sdk";
import { xmtpEnvFromVite } from "./xmtpEnv";
import { currentUnlockedXmtpKey, lockXmtpIdentity } from "./xmtpUnlockSession";

export {
  clearUnlockedXmtpKey,
  currentUnlockedXmtpKey,
  hasUnlockedXmtpKey,
  lockXmtpIdentity,
  rememberUnlockedXmtpKey,
  SESSION_UNLOCK_STORAGE_KEY,
  setUnlockedXmtpKey,
} from "./xmtpUnlockSession";

export const LEGACY_STORAGE_KEY = "mapr-xmtp-inbox-key";
export const VAULT_STORAGE_KEY = "mapr-xmtp-vault";
export const DEFAULT_PBKDF2_ITERATIONS = 310000;
export const XMTP_NETWORK_ERROR_MESSAGE = "暂时连不上加密网络，请稍后重试";
export const XMTP_BIND_ERROR_MESSAGE = "暂时无法开启端到端加密，请稍后重试。";

const identityErrorMessages = {
  "incorrect-password": "口令不对，请检查大小写后重试，或点下方重设本机加密身份",
  "missing-vault": "没有找到本机加密身份，请设置新口令",
  "unsupported-vault": "本机加密身份版本不受支持，请重设本机加密身份",
  "password-too-short": "新口令至少需要 10 个字符",
  "invalid-legacy-identity": "原加密身份已损坏，请先恢复备份，不能自动替换身份",
  "identity-save-failed": "无法把加密身份保存到当前浏览器，请检查浏览器存储设置后重试",
} as const;

export type XmtpIdentityErrorCode = keyof typeof identityErrorMessages;

export class XmtpIdentityError extends Error {
  readonly code: XmtpIdentityErrorCode;

  constructor(code: XmtpIdentityErrorCode) {
    super(identityErrorMessages[code]);
    this.name = "XmtpIdentityError";
    this.code = code;
  }
}

export function xmtpIdentityErrorMessage(error: unknown): string {
  if (error instanceof XmtpIdentityError) return error.message;
  return "无法解锁本机加密身份，请稍后重试";
}

export interface EncryptedKeyVault {
  version: 1;
  salt: string;
  iv: string;
  ciphertext: string;
  iterations: number;
}

export function hubSafeIdentity(input: { privateKey: string; address: string }): {
  address: string;
} {
  return { address: input.address };
}

export async function unlockOrCreateInboxKey(
  password: string,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = localStorage,
  iterations = DEFAULT_PBKDF2_ITERATIONS,
): Promise<string> {
  if (loadEncryptedVault(storage)) return unlockPrivateKey(password, storage);
  if (password.length < 10) throw new XmtpIdentityError("password-too-short");
  const legacy = storage.getItem(LEGACY_STORAGE_KEY);
  if (legacy && !/^0x[0-9a-fA-F]{64}$/.test(legacy)) {
    throw new XmtpIdentityError("invalid-legacy-identity");
  }
  const key = legacy || generatePrivateKey();
  // Validate the legacy identity before changing storage.
  try {
    inboxAddress(key);
  } catch {
    throw new XmtpIdentityError("invalid-legacy-identity");
  }
  try {
    await storeEncryptedKey(key, password, storage, iterations);
    const confirmed = await unlockPrivateKey(password, storage);
    if (confirmed !== key) throw new XmtpIdentityError("identity-save-failed");
    storage.removeItem(LEGACY_STORAGE_KEY);
    return confirmed;
  } catch (error) {
    if (error instanceof XmtpIdentityError && error.code !== "incorrect-password") throw error;
    throw new XmtpIdentityError("identity-save-failed");
  }
}

export async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations = DEFAULT_PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as unknown as BufferSource,
      iterations,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptPrivateKey(
  privateKey: string,
  password: string,
  iterations = DEFAULT_PBKDF2_ITERATIONS,
): Promise<EncryptedKeyVault> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);

  const derivedKey = await deriveKey(password, salt, iterations);
  const enc = new TextEncoder();
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    derivedKey,
    enc.encode(privateKey),
  );

  return {
    version: 1,
    salt: bytesToHex(salt),
    iv: bytesToHex(iv),
    ciphertext: bytesToHex(new Uint8Array(ciphertextBuffer)),
    iterations,
  };
}

export async function decryptPrivateKey(
  vault: EncryptedKeyVault,
  password: string,
): Promise<string> {
  if (vault.version !== 1) {
    throw new XmtpIdentityError("unsupported-vault");
  }
  const salt = hexToBytes(vault.salt as `0x${string}`);
  const iv = hexToBytes(vault.iv as `0x${string}`);
  const ciphertext = hexToBytes(vault.ciphertext as `0x${string}`);

  const derivedKey = await deriveKey(password, salt, vault.iterations);
  try {
    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as unknown as BufferSource },
      derivedKey,
      ciphertext as unknown as BufferSource,
    );
    const dec = new TextDecoder();
    return dec.decode(decryptedBuffer);
  } catch {
    throw new XmtpIdentityError("incorrect-password");
  }
}

export function saveEncryptedVault(
  vault: EncryptedKeyVault,
  storage?: Pick<Storage, "setItem">,
): void {
  const s = storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
  s?.setItem(VAULT_STORAGE_KEY, JSON.stringify(vault));
}

export function loadEncryptedVault(
  storage?: Pick<Storage, "getItem">,
): EncryptedKeyVault | null {
  const s = storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
  const raw = s?.getItem(VAULT_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && parsed.ciphertext && parsed.salt && parsed.iv) {
      return parsed as EncryptedKeyVault;
    }
    return null;
  } catch {
    return null;
  }
}

export function hasEncryptedVault(storage?: Pick<Storage, "getItem">): boolean {
  return loadEncryptedVault(storage) !== null;
}

export async function storeEncryptedKey(
  privateKey: string,
  password: string,
  storage?: Pick<Storage, "getItem" | "setItem">,
  iterations = DEFAULT_PBKDF2_ITERATIONS,
): Promise<void> {
  const vault = await encryptPrivateKey(privateKey, password, iterations);
  saveEncryptedVault(vault, storage);
}

export async function unlockPrivateKey(
  password: string,
  storage?: Pick<Storage, "getItem">,
): Promise<string> {
  const vault = loadEncryptedVault(storage);
  if (!vault) {
    throw new XmtpIdentityError("missing-vault");
  }
  return decryptPrivateKey(vault, password);
}

export function createBrowserSigner(privateKey: string): Signer {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  return {
    type: "EOA",
    getIdentifier: () => ({
      identifier: account.address,
      identifierKind: IdentifierKind.Ethereum,
    }),
    signMessage: async (message: string) => {
      const signature = await account.signMessage({ message });
      return hexToBytes(signature);
    },
  };
}

export function inboxAddress(privateKey: string): string {
  return privateKeyToAccount(privateKey as `0x${string}`).address.toLowerCase();
}

export async function createLocalXmtpClient(privateKey: string): Promise<Client<any>> {
  const signer = createBrowserSigner(privateKey);
  const env = xmtpEnvFromVite(import.meta.env.VITE_XMTP_ENV as string | undefined);
  return Client.create(signer, { env } as any);
}

// ── 已解锁身份的会话内持有（内存优先；显式选择后可限 sessionStorage 恢复） ──────────────

/** 破坏性重设本机加密身份：删除加密 vault、旧明文遗留值与所有解锁态。 */
export function resetLocalXmtpIdentity(
  storage: Pick<Storage, "removeItem"> | undefined = typeof localStorage !== "undefined" ? localStorage : undefined,
): void {
  storage?.removeItem(VAULT_STORAGE_KEY);
  storage?.removeItem(LEGACY_STORAGE_KEY);
  lockXmtpIdentity();
}

/** 已解锁身份的以太坊地址；未解锁或密钥损坏时返回 null。 */
export function unlockedXmtpAddress(): string | null {
  const privateKey = currentUnlockedXmtpKey();
  if (!privateKey) return null;
  try {
    return inboxAddress(privateKey);
  } catch {
    return null;
  }
}

/**
 * 使用已解锁的本机身份对消息做 EIP-191 personal_sign 签名。
 * 仅当本机加密身份已解锁时可用；私钥不离开本模块。
 */
export async function signXmtpMessage(message: string): Promise<string> {
  const privateKey = currentUnlockedXmtpKey();
  if (!privateKey) {
    throw new Error("加密身份未解锁：请先在聊天区输入口令解锁本机加密身份");
  }
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  return account.signMessage({ message });
}
