import { bytesToHex, hexToBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Client, IdentifierKind, type Signer } from "@xmtp/browser-sdk";
import { xmtpEnvFromVite } from "./xmtpEnv";

export const LEGACY_STORAGE_KEY = "mapr-xmtp-inbox-key";
export const VAULT_STORAGE_KEY = "mapr-xmtp-vault";
export const DEFAULT_PBKDF2_ITERATIONS = 310000;

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
  if (password.length < 10) throw new Error("新口令至少需要 10 个字符");
  const legacy = storage.getItem(LEGACY_STORAGE_KEY);
  if (legacy && !/^0x[0-9a-fA-F]{64}$/.test(legacy)) {
    throw new Error("原加密身份已损坏，请先恢复备份，不能自动替换身份");
  }
  const key = legacy || generatePrivateKey();
  // Validate the legacy identity before changing storage.
  inboxAddress(key);
  await storeEncryptedKey(key, password, storage, iterations);
  const confirmed = await unlockPrivateKey(password, storage);
  if (confirmed !== key) throw new Error("身份保存校验失败，原身份仍保留");
  storage.removeItem(LEGACY_STORAGE_KEY);
  return confirmed;
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
    throw new Error(`Unsupported vault version: ${vault.version}`);
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
    throw new Error("Decryption failed: incorrect password or corrupted vault");
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
    throw new Error("No encrypted vault found in storage");
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
