import { IdentifierKind, type Identifier } from "@xmtp/browser-sdk";

export function assertWorkerAddress(address: string | undefined): string {
  const value = address?.trim() ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
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
