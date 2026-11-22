import { randomUUID } from "node:crypto";
import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalStringify } from "./canonical.ts";
import { isAddress } from "./envelope.ts";
import {
  verifyLedgerEntries,
  type LedgerAnchor,
  type LedgerEntry,
  type LedgerKind,
  type LedgerVerifyResult,
} from "./ledger.ts";

/**
 * 签名账本检查点：Hub 只锚定链头（head_seq/head_hash），不接触正文。
 * 校验签名用 verifyLedgerCheckpoint；校验链本身用 verifyLedger。
 */
export interface LedgerCheckpointPayload {
  version: 1;
  room_id: string;
  stream_id: string;
  head_seq: number;
  head_hash: string;
  entry_count: number;
  created_at: string;
}

export interface SignedLedgerCheckpoint extends LedgerCheckpointPayload {
  signer: string;
  signature: string;
}

const CHECKPOINT_PREFIX = "MAPR1-LEDGER-CHECKPOINT ";

export function ledgerCheckpointMessage(payload: LedgerCheckpointPayload): string {
  return CHECKPOINT_PREFIX + canonicalStringify(payload);
}

export async function signLedgerCheckpoint(
  input: {
    room_id: string;
    stream_id: string;
    head_seq: number;
    head_hash: string;
    entry_count: number;
    now?: Date;
  },
  privateKey: string,
): Promise<SignedLedgerCheckpoint> {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const payload: LedgerCheckpointPayload = {
    version: 1,
    room_id: input.room_id,
    stream_id: input.stream_id,
    head_seq: input.head_seq,
    head_hash: input.head_hash,
    entry_count: input.entry_count,
    created_at: (input.now ?? new Date()).toISOString(),
  };
  const signature = await account.signMessage({ message: ledgerCheckpointMessage(payload) });
  return { ...payload, signer: account.address.toLowerCase(), signature };
}

export function isSignedLedgerCheckpoint(value: unknown): value is SignedLedgerCheckpoint {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    typeof v.room_id === "string" &&
    typeof v.stream_id === "string" &&
    Number.isInteger(v.head_seq) &&
    (v.head_seq as number) >= 0 &&
    typeof v.head_hash === "string" &&
    /^[0-9a-f]{64}$/.test(v.head_hash) &&
    Number.isInteger(v.entry_count) &&
    (v.entry_count as number) >= 0 &&
    typeof v.created_at === "string" &&
    isAddress(v.signer) &&
    typeof v.signature === "string" &&
    /^0x[0-9a-fA-F]{130}$/.test(v.signature)
  );
}

export type CheckpointVerifyResult =
  | { ok: true; signer: string }
  | { ok: false; reason: "malformed" | "wrong_signer" | "bad_signature" };

export async function verifyLedgerCheckpoint(
  checkpoint: unknown,
  expectedSigner?: string,
): Promise<CheckpointVerifyResult> {
  if (!isSignedLedgerCheckpoint(checkpoint)) return { ok: false, reason: "malformed" };
  if (expectedSigner && checkpoint.signer !== expectedSigner.toLowerCase()) {
    return { ok: false, reason: "wrong_signer" };
  }
  const payload: LedgerCheckpointPayload = {
    version: checkpoint.version,
    room_id: checkpoint.room_id,
    stream_id: checkpoint.stream_id,
    head_seq: checkpoint.head_seq,
    head_hash: checkpoint.head_hash,
    entry_count: checkpoint.entry_count,
    created_at: checkpoint.created_at,
  };
  let valid = false;
  try {
    valid = await verifyMessage({
      address: checkpoint.signer as `0x${string}`,
      message: ledgerCheckpointMessage(payload),
      signature: checkpoint.signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  return valid ? { ok: true, signer: checkpoint.signer } : { ok: false, reason: "bad_signature" };
}

/** 用 verify 结果生成待签名的 checkpoint 输入（entry_count 取链上+遗留的全部已解析行）。 */
export function checkpointFromVerification(
  result: LedgerVerifyResult,
  ids: { room_id: string; stream_id: string },
): { room_id: string; stream_id: string; head_seq: number; head_hash: string; entry_count: number } {
  return {
    room_id: ids.room_id,
    stream_id: ids.stream_id,
    head_seq: result.head?.seq ?? 0,
    head_hash: result.head?.entry_hash ?? "",
    entry_count: result.chained_entries + result.legacy_unverified_entries,
  };
}

export type ActivityActorKind = "human" | "agent" | "helper" | "system";

/**
 * 可上报 Hub 的安全元数据事件：白名单字段，永远不含正文。
 * Hub 红线：不出现 payload/content/params/params_hash，也不出现邮件正文或收件人。
 */
export interface SafeActivityEvent {
  id: string;
  room_id: string;
  actor_kind: ActivityActorKind;
  actor_id: string;
  kind: string;
  subject_id: string | null;
  status: string;
  created_at: string;
}

/** 输入里出现这些键一律拒绝——宁可报错也不让正文参数混进元数据管道。 */
const FORBIDDEN_ACTIVITY_KEYS = new Set([
  "payload",
  "payload_hash",
  "content",
  "params",
  "params_hash",
  "digest",
  "body",
  "to",
  "from",
  "cc",
  "bcc",
  "subject",
  "text",
  "html",
  "recipients",
  "raw",
  "message",
]);

const ACTOR_KINDS = new Set<ActivityActorKind>(["human", "agent", "helper", "system"]);

function clampString(value: unknown, max: number, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`activity event ${name} must be a non-empty string`);
  }
  if (value.length > max) throw new Error(`activity event ${name} exceeds ${max} chars`);
  return value;
}

export function buildSafeActivityEvent(input: {
  room_id: string;
  actor_kind: ActivityActorKind;
  actor_id: string;
  kind: string;
  status: string;
  subject_id?: string | null;
  id?: string;
  now?: Date;
}): SafeActivityEvent {
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_ACTIVITY_KEYS.has(key)) {
      throw new Error(`activity event field "${key}" is forbidden by Hub metadata redlines`);
    }
  }
  if (!ACTOR_KINDS.has(input.actor_kind)) {
    throw new Error(`activity event actor_kind must be one of ${[...ACTOR_KINDS].join("/")}`);
  }
  const event: SafeActivityEvent = {
    id: input.id ?? randomUUID(),
    room_id: clampString(input.room_id, 64, "room_id"),
    actor_kind: input.actor_kind,
    actor_id: clampString(input.actor_id, 128, "actor_id"),
    kind: clampString(input.kind, 48, "kind"),
    subject_id: input.subject_id == null ? null : clampString(input.subject_id, 64, "subject_id"),
    status: clampString(input.status, 32, "status"),
    created_at: (input.now ?? new Date()).toISOString(),
  };
  return event;
}

/** 本地活动条目的粗粒度状态，仅用于筛选展示；权威细节仍是 kind 本身。 */
export type ActivityStatus = "pending" | "ok" | "denied" | "failed" | "expired" | "uncertain";

const STATUS_BY_KIND: Record<LedgerKind, ActivityStatus> = {
  sender_dropped: "denied",
  request_sent: "ok",
  request_denied: "denied",
  request_queued: "pending",
  consent_approved: "ok",
  consent_denied: "denied",
  consent_expired: "expired",
  send_failed: "failed",
  disclosure_stored: "ok",
  disclosure_rejected: "denied",
  denial_received: "ok",
  pending_received: "pending",
  task_sent: "ok",
  verdict_sent: "ok",
  task_escalated: "pending",
  member_revoked_received: "ok",
  auto_approved: "ok",
  auto_approve_failed: "failed",
  action_queued: "pending",
  action_finished: "ok",
  action_tampered: "failed",
  action_result_received: "ok",
  action_result_rejected: "denied",
  receipt_resent: "ok",
  recovered_uncertain: "uncertain",
  unmatched_response: "uncertain",
};

export function ledgerEntryStatus(entry: LedgerEntry): ActivityStatus {
  return STATUS_BY_KIND[entry.kind];
}

export interface LocalActivityFilter {
  /** 匹配 peer 或 sender（不区分大小写）。 */
  actor?: string;
  kind?: LedgerKind | LedgerKind[];
  status?: ActivityStatus | ActivityStatus[];
  /** ISO 时间，含边界。 */
  since?: string;
  until?: string;
  /** 取最近的 N 条匹配（返回时仍按时间先后排序）。 */
  limit?: number;
}

export interface LocalActivityQueryResult {
  entries: LedgerEntry[];
  /** 过滤前的总条数。 */
  total: number;
  /** 账本完整性摘要；文件级校验（含损坏行）请直接用 verifyLedger。 */
  integrity: LedgerVerifyResult;
}

export function queryLocalActivity(
  entries: LedgerEntry[],
  filter?: LocalActivityFilter,
  opts?: { anchoredCheckpoint?: LedgerAnchor; verification?: LedgerVerifyResult },
): LocalActivityQueryResult {
  const actor = filter?.actor?.toLowerCase();
  const kinds = filter?.kind === undefined ? null : new Set(Array.isArray(filter.kind) ? filter.kind : [filter.kind]);
  const statuses =
    filter?.status === undefined ? null : new Set(Array.isArray(filter.status) ? filter.status : [filter.status]);
  let matched = entries.filter((entry) => {
    if (actor && entry.peer !== actor && entry.sender !== actor) return false;
    if (kinds && !kinds.has(entry.kind)) return false;
    if (statuses && !statuses.has(ledgerEntryStatus(entry))) return false;
    if (filter?.since !== undefined && entry.at < filter.since) return false;
    if (filter?.until !== undefined && entry.at > filter.until) return false;
    return true;
  });
  if (filter?.limit !== undefined && filter.limit >= 0 && matched.length > filter.limit) {
    matched = matched.slice(matched.length - filter.limit);
  }
  const integrity =
    opts?.verification ?? verifyLedgerEntries(entries, { anchoredCheckpoint: opts?.anchoredCheckpoint });
  return { entries: matched, total: entries.length, integrity };
}
