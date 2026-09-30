import { createHash, randomUUID } from "node:crypto";
import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { isAddress, isDateRange, type DateRange, type Grant } from "./envelope.ts";

export const GRANT_TTL_MS = 10 * 60 * 1000;

export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function buildGrant(input: {
  owner: string;
  audience: string;
  requestId: string;
  scope: string;
  constraints: DateRange;
  payload: unknown;
  now: Date;
}): Grant {
  return {
    grant_id: randomUUID(),
    owner: input.owner.toLowerCase(),
    audience: input.audience.toLowerCase(),
    request_id: input.requestId,
    scope: input.scope,
    constraints: {
      date_from: input.constraints.date_from,
      date_to: input.constraints.date_to,
    },
    payload_hash: hashPayload(input.payload),
    expires_at: new Date(input.now.getTime() + GRANT_TTL_MS).toISOString(),
    max_uses: 1,
  };
}

export function grantMessage(grant: Grant): string {
  return (
    "MAPR1-GRANT " +
    JSON.stringify([
      grant.grant_id,
      grant.owner,
      grant.audience,
      grant.request_id,
      grant.scope,
      grant.constraints.date_from,
      grant.constraints.date_to,
      grant.payload_hash,
      grant.expires_at,
      grant.max_uses,
    ])
  );
}

export async function signGrant(grant: Grant, privateKey: string): Promise<string> {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  if (account.address.toLowerCase() !== grant.owner) {
    throw new Error("grant owner does not match signing key");
  }
  return account.signMessage({ message: grantMessage(grant) });
}

export function isGrant(value: any): value is Grant {
  return (
    !!value &&
    typeof value === "object" &&
    typeof value.grant_id === "string" &&
    isAddress(value.owner) &&
    isAddress(value.audience) &&
    typeof value.request_id === "string" &&
    typeof value.scope === "string" &&
    isDateRange(value.constraints) &&
    typeof value.payload_hash === "string" &&
    typeof value.expires_at === "string" &&
    value.max_uses === 1
  );
}

export type VerifyResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "malformed"
        | "wrong_owner"
        | "wrong_audience"
        | "expired"
        | "payload_mismatch"
        | "bad_signature";
    };

export async function verifyGrant(input: {
  grant: unknown;
  signature: string;
  expectedOwner: string;
  expectedAudience: string;
  payload: unknown;
  now: Date;
}): Promise<VerifyResult> {
  if (!isGrant(input.grant)) return { ok: false, reason: "malformed" };
  const grant = input.grant;
  if (grant.owner !== input.expectedOwner.toLowerCase()) return { ok: false, reason: "wrong_owner" };
  if (grant.audience !== input.expectedAudience.toLowerCase()) {
    return { ok: false, reason: "wrong_audience" };
  }
  if (Date.parse(grant.expires_at) <= input.now.getTime()) return { ok: false, reason: "expired" };
  if (grant.payload_hash !== hashPayload(input.payload)) {
    return { ok: false, reason: "payload_mismatch" };
  }
  let valid = false;
  try {
    valid = await verifyMessage({
      address: grant.owner as `0x${string}`,
      message: grantMessage(grant),
      signature: input.signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  return valid ? { ok: true } : { ok: false, reason: "bad_signature" };
}
