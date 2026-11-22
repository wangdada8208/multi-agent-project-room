import { randomUUID } from "node:crypto";
import { MAX_PARAM_BYTES, normalizeScope, paramsShapeOk } from "./canonical.ts";

export const ENVELOPE_PREFIX = "MAPR1 ";

export const KNOWN_SCOPES = ["calendar.free_busy", "task.run", "email.receipt"] as const;

export interface DateRange {
  date_from: string;
  date_to: string;
}

export interface BusySlot {
  start: string;
  end: string;
}

export interface FreeBusyPayload {
  scope: "calendar.free_busy";
  date_from: string;
  date_to: string;
  busy: BusySlot[];
}

export interface EmailReceiptPayload {
  scope: "email.receipt";
  subject: string;
  sent_at: string;
  attachment_name: string | null;
  attachment_sha256: string | null;
  body_excerpt: string;
}

export type DisclosurePayload = FreeBusyPayload | EmailReceiptPayload;

export interface Grant {
  grant_id: string;
  owner: string;
  audience: string;
  request_id: string;
  scope: string;
  constraints: DateRange;
  payload_hash: string;
  expires_at: string;
  max_uses: 1;
}

export interface RequestEnvelope {
  kind: "request";
  request_id: string;
  to: string;
  scope: string;
  purpose: string;
  constraints: DateRange;
}

export interface PendingEnvelope {
  kind: "consent_pending";
  request_id: string;
  to: string;
}

/** busy=待批队列已满，提示请求方稍后重试，与 cannot/out_of_scope 区分。 */
export type DenialReason = "out_of_scope" | "owner_denied" | "expired" | "cannot" | "busy";

export interface DenialEnvelope {
  kind: "denial";
  request_id: string;
  to: string;
  reason: DenialReason;
}

export interface DisclosureEnvelope {
  kind: "disclosure";
  request_id: string;
  to: string;
  grant: Grant;
  signature: string;
  payload: DisclosurePayload;
}

export interface TaskEnvelope {
  kind: "task";
  request_id: string;
  to: string;
  goal: string;
  acceptance: string[];
  round: number;
}

export interface ResultEnvelope {
  kind: "result";
  request_id: string;
  to: string;
  round: number;
  summary: string;
  evidence: string[];
}

export interface VerdictEnvelope {
  kind: "verdict";
  request_id: string;
  to: string;
  round: number;
  accepted: boolean;
  challenge: string;
}

/**
 * 写动作请示：请求对方主人的 worker 代为执行一次有外部副作用的动作
 * （如 gmail.send）。params 绑定在审批记录与 Grant 哈希里——参数被改必须重新请示。
 */
export interface ActionRequestEnvelope {
  kind: "action_request";
  request_id: string;
  to: string;
  action: string;
  params: Record<string, unknown>;
  purpose: string;
}

/**
 * 写动作结果回执：携带批准时的签名 Grant 作为「主人批过」的证据。
 * status=uncertain 表示连接器执行结果不明（可能已生效），不得自动重试。
 */
export interface ActionResultEnvelope {
  kind: "action_result";
  request_id: string;
  to: string;
  grant: Grant;
  signature: string;
  params_hash: string;
  status: "executed" | "failed" | "uncertain";
  receipt?: string;
  summary?: string;
  /**
   * status/receipt/summary 的独立签名（MAPR1-RESULT 消息，grant.owner 签署）。
   * 缺省视为无效回执——grant 只绑 params_hash，没有它 MITM 可改写执行结果。
   */
  result_signature?: string;
}

/**
 * 群广播通知：某个地址已被移出加密群。
 * to 固定为 "*"（全体），收到的一方只能把它当作「重新核实群成员」的提示，
 * 不能据此直接信任——伪造者无法扩大任何权限，最坏结果是一次多余的 members() 拉取。
 */
export interface MemberRevokedEnvelope {
  kind: "member_revoked";
  request_id: string;
  to: "*" | string;
  address: string;
  reason?: string;
}

export type Envelope =
  | RequestEnvelope
  | PendingEnvelope
  | DenialEnvelope
  | DisclosureEnvelope
  | TaskEnvelope
  | ResultEnvelope
  | VerdictEnvelope
  | MemberRevokedEnvelope
  | ActionRequestEnvelope
  | ActionResultEnvelope;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const DENIAL_REASONS: DenialReason[] = ["out_of_scope", "owner_denied", "expired", "cannot", "busy"];
const ACTION_RESULT_STATUSES = ["executed", "failed", "uncertain"];

export function isAddress(value: unknown): value is string {
  return typeof value === "string" && ADDRESS_RE.test(value);
}

function isShortString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function isDateRange(value: any): value is DateRange {
  return (
    !!value &&
    typeof value === "object" &&
    typeof value.date_from === "string" &&
    DATE_RE.test(value.date_from) &&
    typeof value.date_to === "string" &&
    DATE_RE.test(value.date_to)
  );
}

export function encodeEnvelope(envelope: Envelope): string {
  return ENVELOPE_PREFIX + JSON.stringify(envelope);
}

export type BuildActionRequestResult =
  | { ok: true; envelope: ActionRequestEnvelope }
  | {
      ok: false;
      reason: "bad_address" | "self_request" | "bad_action" | "bad_params" | "purpose_too_long";
    };

const ACTION_NAME_RE = /^[a-z][a-z0-9_.]{0,63}$/;

/**
 * 主人控制台发起出站 action_request 的构造器：只做形状与地址检查——
 * 参数是否可执行由对方 worker 的 action schema 决定（它会按白名单拒）。
 */
export function buildActionRequestEnvelope(
  input: { to: unknown; action: unknown; params: unknown; purpose: unknown },
  selfAddress: string
): BuildActionRequestResult {
  const to = typeof input.to === "string" ? input.to.trim().toLowerCase() : "";
  if (!isAddress(to)) return { ok: false, reason: "bad_address" };
  if (to === selfAddress.toLowerCase()) return { ok: false, reason: "self_request" };
  const action = typeof input.action === "string" ? normalizeScope(input.action) : "";
  if (!ACTION_NAME_RE.test(action)) return { ok: false, reason: "bad_action" };
  if (!input.params || typeof input.params !== "object" || Array.isArray(input.params)) {
    return { ok: false, reason: "bad_params" };
  }
  if (JSON.stringify(input.params).length > MAX_PARAM_BYTES) return { ok: false, reason: "bad_params" };
  if (!paramsShapeOk(input.params)) return { ok: false, reason: "bad_params" };
  const purpose = typeof input.purpose === "string" ? input.purpose.trim() : "";
  if (purpose.length > 280) return { ok: false, reason: "purpose_too_long" };
  return {
    ok: true,
    envelope: {
      kind: "action_request",
      request_id: randomUUID(),
      to,
      action,
      params: input.params as Record<string, unknown>,
      purpose,
    },
  };
}

export function decodeEnvelope(text: string): Envelope | null {
  if (typeof text !== "string" || !text.startsWith(ENVELOPE_PREFIX)) return null;
  if (text.length > 64 * 1024) return null;
  let raw: any;
  try {
    raw = JSON.parse(text.slice(ENVELOPE_PREFIX.length));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const toOk = isAddress(raw.to) || (raw.kind === "member_revoked" && raw.to === "*");
  if (!isShortString(raw.request_id, 64) || !toOk) return null;

  switch (raw.kind) {
    case "request":
      if (!isShortString(raw.scope, 64)) return null;
      if (typeof raw.purpose !== "string" || raw.purpose.length > 280) return null;
      if (!isDateRange(raw.constraints)) return null;
      return {
        kind: "request",
        request_id: raw.request_id,
        to: raw.to,
        scope: normalizeScope(raw.scope),
        purpose: raw.purpose,
        constraints: {
          date_from: raw.constraints.date_from,
          date_to: raw.constraints.date_to,
        },
      };
    case "consent_pending":
      return { kind: "consent_pending", request_id: raw.request_id, to: raw.to };
    case "denial":
      if (!DENIAL_REASONS.includes(raw.reason)) return null;
      return { kind: "denial", request_id: raw.request_id, to: raw.to, reason: raw.reason };
    case "disclosure":
      if (!raw.grant || typeof raw.grant !== "object") return null;
      if (!isShortString(raw.signature, 200)) return null;
      if (!raw.payload || typeof raw.payload !== "object") return null;
      return {
        kind: "disclosure",
        request_id: raw.request_id,
        to: raw.to,
        grant: raw.grant,
        signature: raw.signature,
        payload: raw.payload,
      };
    case "task": {
      if (!isShortString(raw.goal, 500)) return null;
      if (
        !Array.isArray(raw.acceptance) ||
        raw.acceptance.length < 1 ||
        raw.acceptance.length > 5 ||
        !raw.acceptance.every((s: any) => isShortString(s, 200))
      ) {
        return null;
      }
      if (!Number.isInteger(raw.round) || raw.round < 1 || raw.round > 3) return null;
      return {
        kind: "task",
        request_id: raw.request_id,
        to: raw.to,
        goal: raw.goal,
        acceptance: raw.acceptance.slice(),
        round: raw.round,
      };
    }
    case "result": {
      if (!Number.isInteger(raw.round) || raw.round < 1 || raw.round > 3) return null;
      if (!isShortString(raw.summary, 2000)) return null;
      if (
        !Array.isArray(raw.evidence) ||
        raw.evidence.length > 10 ||
        !raw.evidence.every((s: any) => isShortString(s, 500))
      ) {
        return null;
      }
      return {
        kind: "result",
        request_id: raw.request_id,
        to: raw.to,
        round: raw.round,
        summary: raw.summary,
        evidence: raw.evidence.slice(),
      };
    }
    case "verdict": {
      if (!Number.isInteger(raw.round) || raw.round < 1 || raw.round > 3) return null;
      if (typeof raw.accepted !== "boolean") return null;
      if (raw.accepted) {
        if (typeof raw.challenge !== "string" || raw.challenge !== "") return null;
      } else {
        if (!isShortString(raw.challenge, 500)) return null;
      }
      return {
        kind: "verdict",
        request_id: raw.request_id,
        to: raw.to,
        round: raw.round,
        accepted: raw.accepted,
        challenge: raw.challenge,
      };
    }
    case "action_request": {
      if (!isShortString(raw.action, 64)) return null;
      if (typeof raw.purpose !== "string" || raw.purpose.length > 280) return null;
      if (!raw.params || typeof raw.params !== "object" || Array.isArray(raw.params)) return null;
      if (JSON.stringify(raw.params).length > MAX_PARAM_BYTES) return null;
      if (!paramsShapeOk(raw.params)) return null;
      return {
        kind: "action_request",
        request_id: raw.request_id,
        to: raw.to,
        action: normalizeScope(raw.action),
        params: raw.params,
        purpose: raw.purpose,
      };
    }
    case "action_result": {
      if (!raw.grant || typeof raw.grant !== "object") return null;
      if (!isShortString(raw.signature, 200)) return null;
      if (!isShortString(raw.params_hash, 128)) return null;
      if (!ACTION_RESULT_STATUSES.includes(raw.status)) return null;
      if (raw.receipt !== undefined && !isShortString(raw.receipt, 200)) return null;
      if (raw.summary !== undefined && !isShortString(raw.summary, 500)) return null;
      if (raw.result_signature !== undefined && !isShortString(raw.result_signature, 200)) return null;
      return {
        kind: "action_result",
        request_id: raw.request_id,
        to: raw.to,
        grant: raw.grant,
        signature: raw.signature,
        params_hash: raw.params_hash,
        status: raw.status,
        receipt: raw.receipt,
        summary: raw.summary,
        result_signature: raw.result_signature,
      };
    }
    case "member_revoked": {
      if (!isAddress(raw.address)) return null;
      if (raw.reason !== undefined && !isShortString(raw.reason, 64)) return null;
      return {
        kind: "member_revoked",
        request_id: raw.request_id,
        to: raw.to,
        address: raw.address.toLowerCase(),
        reason: raw.reason,
      };
    }
    default:
      return null;
  }
}
