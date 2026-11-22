import { randomUUID } from "node:crypto";
import { freeBusy, type CalendarEvent } from "./calendar.ts";
import { findConnector } from "./connectors/registry.ts";
import type { ActionReceipt, Connector } from "./connectors/types.ts";
import { consentTtl, DATA_CONSENT_TTL_MS, type ConsentQueue, type PendingConsent } from "./consentQueue.ts";
import { decodeEnvelope, encodeEnvelope, type Grant } from "./envelope.ts";
import { buildGrant, GRANT_TTL_MS, hashPayload, signActionResult, signGrant } from "./grant.ts";
import { buildLedgerEntry, type LedgerEntry } from "./ledger.ts";

export const CONSENT_TTL_MS = DATA_CONSENT_TTL_MS;
export { consentTtl };

/** 回执重发上限——超过后保留 awaiting_receipt 由人工处理，不再每轮硬发。 */
export const MAX_RECEIPT_RESENDS = 10;

export interface ConsentActionDeps {
  selfAddress: string;
  privateKey: string;
  queue: ConsentQueue;
  loadCalendar?: () => Promise<CalendarEvent[]>;
  connectors?: Connector[];
  send: (conversationId: string, text: string) => Promise<void>;
  appendLedger: (entry: LedgerEntry) => Promise<void>;
  isRequesterRevoked?: (requester: string, conversationId: string) => boolean;
  now: () => Date;
}

export type ActionResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "not_pending"
        | "send_failed"
        | "no_connector"
        | "expired"
        | "params_tampered"
        | "no_outbox"
        | "requester_revoked"
        | "resend_cap";
    };

function expiresAt(item: PendingConsent): number {
  const parsed = Date.parse(item.expires_at ?? "");
  return Number.isFinite(parsed) ? parsed : Date.parse(item.created_at) + consentTtl(item.kind ?? "data");
}

export async function approveConsent(requestId: string, deps: ConsentActionDeps): Promise<ActionResult> {
  const pending = deps.queue.get(requestId);
  const checkedAt = deps.now();
  if (pending?.status === "pending" && deps.isRequesterRevoked?.(pending.requester, pending.conversation_id)) {
    return { ok: false, reason: "requester_revoked" };
  }
  if (pending?.status === "pending" && expiresAt(pending) <= checkedAt.getTime()) {
    await denyConsent(requestId, "expired", deps);
    return { ok: false, reason: "expired" };
  }
  // approved → 已批准未开始执行；后续每一步状态都落盘，崩溃后能分清停在哪。
  const item = await deps.queue.claim(requestId, "approved", deps.now());
  if (!item) return { ok: false, reason: "not_pending" };
  if (item.kind === "action") return runApprovedAction(item, deps);
  const now = deps.now();

  let payload: any;
  try {
    if (deps.connectors && deps.connectors.length > 0) {
      const connector = findConnector(deps.connectors, item.scope);
      if (!connector) throw new Error("no connector");
      payload = await connector.fetch(item.scope, item.constraints);
    } else if (item.scope === "calendar.free_busy" && deps.loadCalendar) {
      payload = freeBusy(await deps.loadCalendar(), item.constraints);
    } else {
      throw new Error("no connector");
    }
  } catch {
    await deps.queue.releaseApproval(requestId);
    return { ok: false, reason: "no_connector" };
  }

  const grant = buildGrant({
    owner: deps.selfAddress,
    audience: item.requester,
    requestId: item.request_id,
    scope: item.scope,
    constraints: item.constraints,
    payload,
    now,
  });
  const signature = await signGrant(grant, deps.privateKey);
  const text = encodeEnvelope({
    kind: "disclosure", request_id: item.request_id, to: item.requester, grant, signature, payload,
  });
  // 先持久化回执再发送：发送失败只留 awaiting_receipt，可重发，不丢已构建结果。
  const receiptReady = await deps.queue.transition(requestId, "awaiting_receipt", now, {
    outbox: text, outbox_at: now.toISOString(), result_status: "executed",
  });
  if (!receiptReady) return { ok: false, reason: "not_pending" };
  if (deps.isRequesterRevoked?.(item.requester, item.conversation_id)) return { ok: false, reason: "requester_revoked" };
  try {
    await deps.send(item.conversation_id, text);
  } catch {
    await deps.appendLedger(
      buildLedgerEntry({ now, kind: "send_failed", requestId: item.request_id, peer: item.requester, scope: item.scope })
    );
    return { ok: false, reason: "send_failed" };
  }
  // 送达即清 outbox：outbox 非空 ⟺ 回执尚未确认送达。
  await deps.queue.transition(requestId, "completed", now, { outbox: undefined, outbox_at: undefined });
  await deps.appendLedger(
    buildLedgerEntry({
      now,
      kind: "consent_approved",
      requestId: item.request_id,
      peer: item.requester,
      scope: item.scope,
      payloadHash: grant.payload_hash,
    })
  );
  return { ok: true };
}

/**
 * 批准一个写动作：校验参数哈希 → 记录执行 attempt → 执行 → 回执先落盘再发送。
 * 执行一旦发生就绝不重放：发送失败转 awaiting_receipt（重发不重执行），
 * 执行抛错记 uncertain 终态（外部副作用可能已生效，需人工对账）。
 */
async function runApprovedAction(item: PendingConsent, deps: ConsentActionDeps): Promise<ActionResult> {
  const now = deps.now();
  const params = item.params ?? {};
  const tampered = async (): Promise<ActionResult> => {
    // 队列被手改——不执行也不回到待批，直接终态拒绝并留痕。
    await deps.queue.transition(item.request_id, "denied", now);
    await deps.appendLedger(
      buildLedgerEntry({ now, kind: "action_tampered", requestId: item.request_id, peer: item.requester, scope: item.scope })
    );
    return { ok: false, reason: "params_tampered" };
  };
  if (item.params_hash !== hashPayload(params)) return tampered();
  // 账户绑定一致性：params.account 与批准时记录的 account_id 必须一致——
  // 队列文件里任何一个被换成别的账户，都按篡改拒（批准的账户不可掉包）。
  const boundAccount = typeof params.account === "string" ? params.account : undefined;
  if (boundAccount !== item.account_id) return tampered();
  const connector = findConnector(deps.connectors ?? [], item.scope, item.account_id);
  if (!connector?.execute) {
    await deps.queue.releaseApproval(item.request_id);
    return { ok: false, reason: "no_connector" };
  }
  // 执行前持久化 attempt：此后的崩溃 = 执行窗口不明 ⇒ 重启对账成 uncertain。
  const claimed = await deps.queue.transition(item.request_id, "executing", now, {
    attempt_at: now.toISOString(),
  });
  if (!claimed) return { ok: false, reason: "not_pending" };
  let receipt: ActionReceipt;
  try {
    receipt = await connector.execute(item.scope, params, {
      request_id: item.request_id,
      account_id: item.account_id,
    });
  } catch {
    // 执行抛错不等于失败——外部副作用可能已经生效。标 uncertain，不自动重试。
    receipt = { status: "uncertain" };
  }
  const grant = buildGrant({
    owner: deps.selfAddress,
    audience: item.requester,
    requestId: item.request_id,
    scope: item.scope,
    constraints: item.constraints,
    payload: params,
    now,
  });
  const signature = await signGrant(grant, deps.privateKey);
  // status/receipt/summary 与 params_hash 一起进签名——回执每个可被篡改的字段都被绑定。
  const resultSignature = await signActionResult(
    {
      grant_id: grant.grant_id,
      request_id: item.request_id,
      params_hash: grant.payload_hash,
      status: receipt.status,
      receipt: receipt.external_id,
      summary: receipt.summary,
    },
    deps.privateKey
  );
  const text = encodeEnvelope({
    kind: "action_result",
    request_id: item.request_id,
    to: item.requester,
    grant,
    signature,
    params_hash: grant.payload_hash,
    status: receipt.status,
    receipt: receipt.external_id,
    summary: receipt.summary,
    result_signature: resultSignature,
  });
  // 回执先持久化进 outbox 再发送：回执可重发，绝不重新 execute。
  const receiptReady = await deps.queue.transition(item.request_id, "awaiting_receipt", now, {
    outbox: text,
    outbox_at: now.toISOString(),
    result_status: receipt.status,
    result_receipt: receipt.external_id,
    result_summary: receipt.summary,
    resend_count: 0,
  });
  if (!receiptReady) return { ok: false, reason: "not_pending" };
  if (deps.isRequesterRevoked?.(item.requester, item.conversation_id)) return { ok: false, reason: "requester_revoked" };
  const finishReason = receipt.summary === "auth_required" ? "auth_required" : receipt.status;
  const terminal = receipt.status === "uncertain" ? "uncertain" : "completed";
  if (item.conversation_id !== "") {
    try {
      await deps.send(item.conversation_id, text);
    } catch {
      await deps.appendLedger(
        buildLedgerEntry({ now, kind: "send_failed", requestId: item.request_id, peer: item.requester, scope: item.scope })
      );
      return { ok: false, reason: "send_failed" };
    }
  }
  // conversation_id 为空 = 本机触发来源（无群会话可回执）——状态与账本照常收口。
  // 送达（或本地收口）即清 outbox，让「outbox 非空 ⟺ 未确认送达」成立。
  await deps.queue.transition(item.request_id, terminal, now, { outbox: undefined, outbox_at: undefined });
  await deps.appendLedger(
    buildLedgerEntry({
      now,
      kind: "action_finished",
      requestId: item.request_id,
      peer: item.requester,
      scope: item.scope,
      payloadHash: grant.payload_hash,
      reason: finishReason,
    })
  );
  return { ok: true };
}

/** 回执内嵌 grant 距离到期不足这个余量就重签——陈旧回执发出去对方也只会按 expired 拒。 */
const GRANT_REFRESH_MARGIN_MS = 2 * 60 * 1000;

/**
 * M2：outbox 里的 grant 过期或临期时，按「同一不可变结果」重签一份新 grant 再发。
 * request_id/scope/audience/payload_hash 原样保留，grant_id 与 expires_at 换新的；
 * action_result 的 status/receipt/summary 取队列里持久化的不可变字段重签
 * result_signature——绝不重新跑 connector.execute，也绝不改写已落盘的结果。
 * 发送前先把刷新后的 outbox 落盘，发出去的一定是持久化版本。
 */
async function refreshOutboxGrant(item: PendingConsent, deps: ConsentActionDeps): Promise<string> {
  const env = decodeEnvelope(item.outbox!);
  if (!env || (env.kind !== "action_result" && env.kind !== "disclosure")) {
    return item.outbox!;
  }
  const expiry = Date.parse(env.grant.expires_at);
  if (Number.isFinite(expiry) && expiry - deps.now().getTime() > GRANT_REFRESH_MARGIN_MS) {
    return item.outbox!; // grant 仍在有效期——原样重发
  }
  const now = deps.now();
  const grant: Grant = {
    ...env.grant,
    grant_id: randomUUID(),
    expires_at: new Date(now.getTime() + GRANT_TTL_MS).toISOString(),
  };
  const signature = await signGrant(grant, deps.privateKey);
  let text: string;
  if (env.kind === "disclosure") {
    text = encodeEnvelope({ ...env, grant, signature });
  } else {
    const status = item.result_status ?? env.status;
    const receipt = item.result_receipt ?? env.receipt;
    const summary = item.result_summary ?? env.summary;
    const resultSignature = await signActionResult(
      {
        grant_id: grant.grant_id,
        request_id: env.request_id,
        params_hash: env.params_hash,
        status,
        receipt,
        summary,
      },
      deps.privateKey
    );
    text = encodeEnvelope({ ...env, grant, signature, status, receipt, summary, result_signature: resultSignature });
  }
  const patch = { outbox: text, outbox_at: now.toISOString() };
  if (item.status === "uncertain") {
    await deps.queue.patchUncertainReceipt(item.request_id, patch);
  } else {
    await deps.queue.transition(item.request_id, "awaiting_receipt", now, patch);
  }
  return text;
}

/**
 * 重发已持久化的回执：只发 outbox 原文（必要时按 M2 刷新 grant），绝不重新执行。
 * 覆盖 awaiting_receipt（正常路径）与 uncertain+outbox（崩溃恢复补签）两类；
 * 送达后清 outbox——uncertain 条目只清回执字段，状态永留终态。
 */
export async function resendReceipt(requestId: string, deps: ConsentActionDeps): Promise<ActionResult> {
  const item = deps.queue.get(requestId);
  if (
    !item ||
    typeof item.outbox !== "string" ||
    (item.status !== "awaiting_receipt" && item.status !== "uncertain")
  ) {
    return { ok: false, reason: "no_outbox" };
  }
  if (deps.isRequesterRevoked?.(item.requester, item.conversation_id)) return { ok: false, reason: "requester_revoked" };
  if ((item.resend_count ?? 0) >= MAX_RECEIPT_RESENDS) {
    return { ok: false, reason: "resend_cap" };
  }
  const now = deps.now();
  const markDelivered = async (): Promise<void> => {
    if (item.status === "uncertain") {
      await deps.queue.patchUncertainReceipt(requestId, { outbox: undefined, outbox_at: undefined });
    } else {
      const terminal = item.result_status === "uncertain" ? "uncertain" : "completed";
      await deps.queue.transition(requestId, terminal, now, { outbox: undefined, outbox_at: undefined });
    }
  };
  if (item.conversation_id === "") {
    // 本机触发来源没有接收方：回执只存本机 outbox，标记终态/清 outbox 即可。
    await markDelivered();
    await deps.appendLedger(
      buildLedgerEntry({ now, kind: "receipt_resent", requestId: item.request_id, peer: item.requester, scope: item.scope, reason: "local_only" })
    );
    return { ok: true };
  }
  const outbox = await refreshOutboxGrant(item, deps);
  try {
    await deps.send(item.conversation_id, outbox);
  } catch {
    const retry = { resend_count: (item.resend_count ?? 0) + 1 };
    if (item.status === "uncertain") {
      await deps.queue.patchUncertainReceipt(requestId, retry);
    } else {
      await deps.queue.transition(requestId, "awaiting_receipt", now, retry);
    }
    await deps.appendLedger(
      buildLedgerEntry({ now, kind: "send_failed", requestId: item.request_id, peer: item.requester, scope: item.scope, reason: "resend_failed" })
    );
    return { ok: false, reason: "send_failed" };
  }
  await markDelivered();
  await deps.appendLedger(
    buildLedgerEntry({ now, kind: "receipt_resent", requestId: item.request_id, peer: item.requester, scope: item.scope, reason: item.result_status })
  );
  return { ok: true };
}

/**
 * M1 崩溃恢复补签：recoverAfterLoad() 把 executing 翻成 uncertain（终态，绝不重放）
 * 之后，给请求方补一份签名的 uncertain action_result 进 outbox，由重发路径送达。
 * 无群会话（本机触发来源）或请求方已被撤的条目不补回执，只保留状态与账本。
 */
export async function persistCrashRecoveryReceipts(
  recovered: PendingConsent[],
  deps: ConsentActionDeps
): Promise<number> {
  let persisted = 0;
  for (const item of recovered) {
    if (item.status !== "uncertain" || item.kind !== "action") continue;
    if (typeof item.outbox === "string") continue; // 已有持久化回执——重发路径负责，不重复签
    if (item.conversation_id === "") continue;
    if (deps.isRequesterRevoked?.(item.requester, item.conversation_id)) continue;
    const now = deps.now();
    const base = buildGrant({
      owner: deps.selfAddress,
      audience: item.requester,
      requestId: item.request_id,
      scope: item.scope,
      constraints: item.constraints,
      payload: item.params ?? {},
      now,
    });
    // 回执绑定的是「批准时登记的参数哈希」，不是队列文件里可能被改过的 params。
    const grant: Grant = { ...base, payload_hash: item.params_hash ?? base.payload_hash };
    const signature = await signGrant(grant, deps.privateKey);
    const summary = "execution_interrupted_verify_manually";
    const resultSignature = await signActionResult(
      {
        grant_id: grant.grant_id,
        request_id: item.request_id,
        params_hash: grant.payload_hash,
        status: "uncertain",
        summary,
      },
      deps.privateKey
    );
    const text = encodeEnvelope({
      kind: "action_result",
      request_id: item.request_id,
      to: item.requester,
      grant,
      signature,
      params_hash: grant.payload_hash,
      status: "uncertain",
      summary,
      result_signature: resultSignature,
    });
    const patched = await deps.queue.patchUncertainReceipt(item.request_id, {
      outbox: text,
      outbox_at: now.toISOString(),
      resend_count: 0,
      result_status: "uncertain",
      result_summary: summary,
    });
    if (patched) persisted += 1;
  }
  return persisted;
}

/** 启动/周期对账：把所有待确认回执补发出去；单条故障不拖垮整轮。 */
export async function resendPendingReceipts(deps: ConsentActionDeps): Promise<number> {
  let sent = 0;
  for (const item of deps.queue.pendingReceipts()) {
    try {
      const res = await resendReceipt(item.request_id, deps);
      if (res.ok) sent += 1;
    } catch {
      // 单条回执异常不阻断其余——下一轮重试时再来。
    }
  }
  return sent;
}

export async function denyConsent(
  requestId: string,
  reason: "owner_denied" | "expired",
  deps: ConsentActionDeps
): Promise<ActionResult> {
  const item = await deps.queue.claim(requestId, reason === "expired" ? "expired" : "denied", deps.now());
  if (!item) return { ok: false, reason: "not_pending" };
  const now = deps.now();
  // 本机触发来源没有接收方可通知——状态已落定，只记账本。
  if (item.conversation_id !== "") {
    try {
      await deps.send(
        item.conversation_id,
        encodeEnvelope({ kind: "denial", request_id: item.request_id, to: item.requester, reason })
      );
    } catch {
      await deps.appendLedger(
        buildLedgerEntry({ now, kind: "send_failed", requestId: item.request_id, peer: item.requester, scope: item.scope })
      );
      return { ok: false, reason: "send_failed" };
    }
  }
  await deps.appendLedger(
    buildLedgerEntry({
      now,
      kind: reason === "expired" ? "consent_expired" : "consent_denied",
      requestId: item.request_id,
      peer: item.requester,
      scope: item.scope,
      reason,
    })
  );
  return { ok: true };
}

export async function expireDue(deps: ConsentActionDeps): Promise<number> {
  const due = deps.queue.dueForExpiry(deps.now());
  let count = 0;
  for (const item of due) {
    if (item.status === "approved") {
      // 批准了但一直没开始执行（崩溃窗口）——从未执行，可安全过期。
      const moved = await deps.queue.transition(item.request_id, "expired", deps.now());
      if (!moved) continue;
      if (item.conversation_id !== "") {
        try {
          await deps.send(
            item.conversation_id,
            encodeEnvelope({ kind: "denial", request_id: item.request_id, to: item.requester, reason: "expired" })
          );
        } catch {
          await deps.appendLedger(
            buildLedgerEntry({ now: deps.now(), kind: "send_failed", requestId: item.request_id, peer: item.requester, scope: item.scope })
          );
        }
      }
      await deps.appendLedger(
        buildLedgerEntry({ now: deps.now(), kind: "consent_expired", requestId: item.request_id, peer: item.requester, scope: item.scope, reason: "expired" })
      );
      count += 1;
      continue;
    }
    const result = await denyConsent(item.request_id, "expired", deps);
    if (result.ok) count += 1;
  }
  return count;
}
