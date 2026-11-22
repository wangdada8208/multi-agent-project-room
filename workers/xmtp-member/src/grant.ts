import { createHash, randomUUID } from "node:crypto";
import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalStringify, normalizeScope } from "./canonical.ts";
import { isAddress, isDateRange, type DateRange, type Grant } from "./envelope.ts";

export const GRANT_TTL_MS = 10 * 60 * 1000;

/** canonical JSON 哈希：键序稳定，跨实现可复现。 */
export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(canonicalStringify(payload)).digest("hex");
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
    scope: normalizeScope(input.scope),
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

/**
 * action_result 的结果签名消息：grant 本身只绑 params_hash，
 * status/receipt/summary 必须由 owner 单独签名，否则转发路径上任何一环
 * 都能把 executed 改成 failed/uncertain 或换掉外部回执号而不被发现。
 */
export function actionResultMessage(input: {
  grant_id: string;
  request_id: string;
  params_hash: string;
  status: "executed" | "failed" | "uncertain";
  receipt?: string;
  summary?: string;
}): string {
  return (
    "MAPR1-RESULT " +
    JSON.stringify([
      input.grant_id,
      input.request_id,
      input.params_hash,
      input.status,
      input.receipt ?? "",
      input.summary ?? "",
    ])
  );
}

export async function signActionResult(
  input: {
    grant_id: string;
    request_id: string;
    params_hash: string;
    status: "executed" | "failed" | "uncertain";
    receipt?: string;
    summary?: string;
  },
  privateKey: string
): Promise<string> {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  return account.signMessage({ message: actionResultMessage(input) });
}

/** 验证 action_result 的结果签名确实是 grant.owner 对「收到的这组值」签的。 */
export async function verifyActionResultSignature(input: {
  owner: string;
  grant_id: string;
  request_id: string;
  params_hash: string;
  status: "executed" | "failed" | "uncertain";
  receipt?: string;
  summary?: string;
  signature?: string;
}): Promise<boolean> {
  if (typeof input.signature !== "string" || input.signature.length === 0) return false;
  try {
    return await verifyMessage({
      address: input.owner as `0x${string}`,
      message: actionResultMessage(input),
      signature: input.signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}

export function isValidAudience(value: unknown): value is string {
  return typeof value === "string" && (isAddress(value) || /^[a-zA-Z0-9_.-]{1,64}$/.test(value));
}

function isEmptyRange(value: any): boolean {
  // 写动作的批准没有时间范围语义，统一用空对占位；数据披露仍是真实 DateRange。
  return !!value && typeof value === "object" && value.date_from === "" && value.date_to === "";
}

export function isGrant(value: any): value is Grant {
  return (
    !!value &&
    typeof value === "object" &&
    typeof value.grant_id === "string" &&
    isAddress(value.owner) &&
    isValidAudience(value.audience) &&
    typeof value.request_id === "string" &&
    typeof value.scope === "string" &&
    (isDateRange(value.constraints) || isEmptyRange(value.constraints)) &&
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
  /** 与 payload 二选一：已知期望哈希时直接比对（如 action_result 只带 params_hash）。 */
  payload?: unknown;
  expectedPayloadHash?: string;
  now: Date;
}): Promise<VerifyResult> {
  if (!isGrant(input.grant)) return { ok: false, reason: "malformed" };
  const grant = input.grant;
  if (grant.owner !== input.expectedOwner.toLowerCase()) return { ok: false, reason: "wrong_owner" };
  if (grant.audience !== input.expectedAudience.toLowerCase()) {
    return { ok: false, reason: "wrong_audience" };
  }
  if (Date.parse(grant.expires_at) <= input.now.getTime()) return { ok: false, reason: "expired" };
  const expectedHash = input.expectedPayloadHash ?? hashPayload(input.payload);
  if (grant.payload_hash !== expectedHash) {
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
