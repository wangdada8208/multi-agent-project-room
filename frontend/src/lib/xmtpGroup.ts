import { IdentifierKind, type Identifier } from "@xmtp/browser-sdk";

/** 以太坊地址校验。席位地址、成员地址走同一个规则，避免两处正则漂移。 */
export function isEthAddress(address: string | undefined): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address?.trim() ?? "");
}

export function assertWorkerAddress(address: string | undefined): string {
  const value = address?.trim() ?? "";
  if (!isEthAddress(value)) {
    throw new Error("worker address required");
  }
  return value;
}

export function memberIdentifier(address: string): Identifier {
  return {
    identifier: assertWorkerAddress(address),
    identifierKind: IdentifierKind.Ethereum,
  };
}
