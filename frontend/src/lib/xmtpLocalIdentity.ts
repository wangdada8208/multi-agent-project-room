import { hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Client, IdentifierKind, type Signer } from "@xmtp/browser-sdk";

const STORAGE_KEY = "mapr-xmtp-inbox-key";

export function hubSafeIdentity(input: { privateKey: string; address: string }): {
  address: string;
} {
  return { address: input.address };
}

export function loadOrCreateInboxKey(storage?: Pick<Storage, "getItem" | "setItem">): string {
  const s =
    storage ??
    (typeof localStorage !== "undefined"
      ? localStorage
      : typeof window !== "undefined"
        ? window.localStorage
        : undefined);
  const existing = s?.getItem(STORAGE_KEY);
  if (existing && /^0x[0-9a-fA-F]{64}$/.test(existing)) return existing;
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const created = "0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  s?.setItem(STORAGE_KEY, created);
  return created;
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

export async function createLocalXmtpClient(privateKey: string): Promise<Client<any>> {
  const signer = createBrowserSigner(privateKey);
  return Client.create(signer, { env: "dev" } as any);
}
