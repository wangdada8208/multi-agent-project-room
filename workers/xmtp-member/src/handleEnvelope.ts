import { consentTtl } from "./consentActions.ts";
import type { ConsentQueue } from "./consentQueue.ts";
import { validateActionParams } from "./connectors/actionSchemas.ts";
import { buildVerdictPrompt, nextStep, parseVerdict } from "./coordinator.ts";
import {
  encodeEnvelope,
  type ActionResultEnvelope,
  type DisclosureEnvelope,
  type Envelope,
  type ResultEnvelope,
  type TaskEnvelope,
  type VerdictEnvelope,
} from "./envelope.ts";
import { buildResult, buildTaskPrompt } from "./executor.ts";
import { hashPayload, verifyActionResultSignature, verifyGrant } from "./grant.ts";
import { buildLedgerEntry, type LedgerEntry } from "./ledger.ts";
import type { MemberRevokedOutcome } from "./revocations.ts";
import type { OutgoingRequests, OutgoingRequestRecord } from "./outgoingRequests.ts";
import { checkScopeConstraints, type Policy } from "./policy.ts";
import { decide, mergeHubHouseRules, type HubRoomSettings } from "./rulesEngine.ts";
import type { TaskStore } from "./taskStore.ts";

export interface HandleEnvelopeDeps {
  selfAddress: string;
  policy: Policy;
  queue: ConsentQueue;
  taskStore?: TaskStore;
  completeModel?: (prompt: string) => Promise<string>;
  send: (conversationId: string, text: string) => Promise<void>;
  appendLedger: (entry: LedgerEntry) => Promise<void>;
  storeDisclosure: (disclosure: DisclosureEnvelope, from: string) => Promise<boolean>;
  /**
   * member_revoked 广播只是不可信提示：实现方先校验会话确实是本房 active group，
   * 再 sync+members() 核实目标缺席，最后才清授权并持久化。
   * 返回值说明处理结果（applied/already_revoked/duplicate/rate_limited/unconfirmed/no_revocable_state/ignored_context）。
   */
  onMemberRevoked?: (
    address: string,
    conversationId: string,
    sender: string,
    requestId: string
  ) => Promise<MemberRevokedOutcome>;
  /** 该 action 是否有连接器可执行——没有就直接拒（服务不了不是审批问题）。 */
  canExecuteAction?: (action: string) => boolean;
  /** 规则判 allow 时走与人工批准完全相同的执行路径；缺省则留在 pending 等人工。 */
  autoApprove?: (requestId: string) => Promise<{ ok: boolean; reason?: string }>;
  storeActionResult?: (env: ActionResultEnvelope, from: string) => Promise<boolean>;
  /** 出站请求登记：响应必须匹配本机真正发过的请求，否则一律拒。 */
  outgoing?: OutgoingRequests;
  /** Hub 下发的房间安全元数据（只作建议：allow 降格 ask、cannot 收紧、本机优先）。 */
  hubRoomSettings?: () => HubRoomSettings | null;
  now: () => Date;
}

export type HandleOutcome =
  | "ignored"
  | "denied"
  | "queued"
  | "auto_approved"
  | "auto_failed"
  | "duplicate"
  | "stored"
  | "rejected"
  | "noted"
  | "task_executed"
  | "verdict_processed";

/** 出站登记匹配失败的原因，写账本便于审计伪造尝试。 */
type MatchFail =
  | "unknown_request"
  | "wrong_responder"
  | "kind_mismatch"
  | "scope_mismatch"
  | "hash_mismatch"
  | "request_expired";

function matchOutgoing(
  deps: HandleEnvelopeDeps,
  req: OutgoingRequestRecord | null,
  sender: string,
  now: Date,
  expected?: { kind?: string; scope?: string; paramsHash?: string }
): MatchFail | null {
  if (!deps.outgoing) return "unknown_request";
  if (!req) return "unknown_request";
  if (req.to !== sender) return "wrong_responder";
  if (expected?.kind && req.kind !== expected.kind) return "kind_mismatch";
  if (expected?.scope && req.scope !== expected.scope) return "scope_mismatch";
  if (expected?.paramsHash && req.params_hash !== expected.paramsHash) return "hash_mismatch";
  if (deps.outgoing.isExpired(req, now)) return "request_expired";
  return null;
}

async function settleResponse(
  deps: HandleEnvelopeDeps,
  req: OutgoingRequestRecord | null,
  responseGrantId: string | null,
  now: Date,
  store?: () => Promise<boolean>
): Promise<"stored" | "duplicate"> {
  if (!req || !deps.outgoing?.claimResponse(req.request_id)) return "duplicate";
  try {
    const stored = store ? await store() : true;
    const marked = await deps.outgoing.markResponded(req.request_id, responseGrantId, now);
    return marked && stored ? "stored" : "duplicate";
  } finally {
    deps.outgoing.releaseResponse(req.request_id);
  }
}

export async function handleEnvelope(
  input: { envelope: Envelope; sender: string; conversationId: string },
  deps: HandleEnvelopeDeps
): Promise<HandleOutcome> {
  const self = deps.selfAddress.toLowerCase();
  const sender = input.sender.toLowerCase();
  const env = input.envelope;
  // "*" 只可能是 member_revoked 的群广播（解码层只允许这一个 kind 带 "*"）。
  if (env.to !== self && env.to !== "*") return "ignored";
  const now = deps.now();

  if (env.kind === "request") {
    // 先规则（能不能要），再可服务性（scope 认不认识、约束合不合法）。
    const rules = mergeHubHouseRules(deps.policy, deps.hubRoomSettings?.() ?? null);
    const hit = decide(rules, deps.policy, { actor: sender, kind: "data", scope: env.scope });
    if (hit.decision === "cannot") {
      await deps.send(
        input.conversationId,
        encodeEnvelope({ kind: "denial", request_id: env.request_id, to: sender, reason: "cannot" })
      );
      await deps.appendLedger(
        buildLedgerEntry({
          now, kind: "request_denied", requestId: env.request_id, peer: sender, scope: env.scope, reason: hit.rule,
        })
      );
      return "denied";
    }
    const check = checkScopeConstraints(deps.policy, env);
    if (!check.ok) {
      await deps.send(
        input.conversationId,
        encodeEnvelope({ kind: "denial", request_id: env.request_id, to: sender, reason: "out_of_scope" })
      );
      await deps.appendLedger(
        buildLedgerEntry({
          now, kind: "request_denied", requestId: env.request_id, peer: sender, scope: env.scope, reason: "out_of_scope",
        })
      );
      return "denied";
    }
    const added = await deps.queue.add({
      request_id: env.request_id,
      requester: sender,
      conversation_id: input.conversationId,
      scope: env.scope,
      purpose: env.purpose,
      constraints: env.constraints,
      created_at: now.toISOString(),
      kind: "data",
      rule_hit: hit.rule,
      expires_at: new Date(now.getTime() + consentTtl("data")).toISOString(),
    });
    if (added === "duplicate") return "duplicate";
    if (added === "full") {
      await deps.send(
        input.conversationId,
        encodeEnvelope({ kind: "denial", request_id: env.request_id, to: sender, reason: "busy" })
      );
      await deps.appendLedger(
        buildLedgerEntry({ now, kind: "request_denied", requestId: env.request_id, peer: sender, scope: env.scope, reason: "queue_full" })
      );
      return "denied";
    }
    if (hit.decision === "allow") {
      const res = await deps.autoApprove?.(env.request_id);
      if (res?.ok) {
        await deps.appendLedger(
          buildLedgerEntry({ now, kind: "auto_approved", requestId: env.request_id, peer: sender, scope: env.scope, reason: hit.rule })
        );
        return "auto_approved";
      }
      // 自动批准失败后按真实状态回执：只有仍停在 pending（如 no_connector 释放回待批）
      // 才发 consent_pending；已进入终态/中途态的一律记账，不谎称等待批准。
      const item = deps.queue.get(env.request_id);
      if (item && item.status !== "pending") {
        await deps.appendLedger(
          buildLedgerEntry({
            now, kind: "auto_approve_failed", requestId: env.request_id, peer: sender, scope: env.scope,
            reason: res?.reason ?? item.status,
          })
        );
        return "auto_failed";
      }
      // 自动执行不了（如连接器缺失）就落回人工待批，不丢请求。
    }
    await deps.send(
      input.conversationId,
      encodeEnvelope({ kind: "consent_pending", request_id: env.request_id, to: sender })
    );
    await deps.appendLedger(
      buildLedgerEntry({ now, kind: "request_queued", requestId: env.request_id, peer: sender, scope: env.scope, reason: hit.rule })
    );
    return "queued";
  }

  if (env.kind === "action_request") {
    const rules = mergeHubHouseRules(deps.policy, deps.hubRoomSettings?.() ?? null);
    const hit = decide(rules, deps.policy, { actor: sender, kind: "action", scope: env.action });
    if (hit.decision === "cannot") {
      await deps.send(
        input.conversationId,
        encodeEnvelope({ kind: "denial", request_id: env.request_id, to: sender, reason: "cannot" })
      );
      await deps.appendLedger(
        buildLedgerEntry({ now, kind: "request_denied", requestId: env.request_id, peer: sender, scope: env.action, reason: hit.rule })
      );
      return "denied";
    }
    if (deps.canExecuteAction && !deps.canExecuteAction(env.action)) {
      await deps.send(
        input.conversationId,
        encodeEnvelope({ kind: "denial", request_id: env.request_id, to: sender, reason: "out_of_scope" })
      );
      await deps.appendLedger(
        buildLedgerEntry({ now, kind: "request_denied", requestId: env.request_id, peer: sender, scope: env.action, reason: "no_connector" })
      );
      return "denied";
    }
    // 入队前过动作参数 schema：畸形/超界/头部注入一律拒，排队的东西必须本身合法。
    const paramCheck = validateActionParams(env.action, env.params);
    if (!paramCheck.ok) {
      await deps.send(
        input.conversationId,
        encodeEnvelope({ kind: "denial", request_id: env.request_id, to: sender, reason: "out_of_scope" })
      );
      await deps.appendLedger(
        buildLedgerEntry({ now, kind: "request_denied", requestId: env.request_id, peer: sender, scope: env.action, reason: `invalid_params:${paramCheck.reason}` })
      );
      return "denied";
    }
    const added = await deps.queue.add({
      request_id: env.request_id,
      requester: sender,
      conversation_id: input.conversationId,
      scope: env.action,
      purpose: env.purpose,
      constraints: { date_from: "", date_to: "" },
      created_at: now.toISOString(),
      kind: "action",
      params: env.params,
      params_hash: hashPayload(env.params),
      rule_hit: hit.rule,
      source: "envelope",
      account_id: typeof env.params.account === "string" ? env.params.account : undefined,
      expires_at: new Date(now.getTime() + consentTtl("action")).toISOString(),
    });
    if (added === "duplicate") return "duplicate";
    if (added === "full") {
      await deps.send(
        input.conversationId,
        encodeEnvelope({ kind: "denial", request_id: env.request_id, to: sender, reason: "busy" })
      );
      await deps.appendLedger(
        buildLedgerEntry({ now, kind: "request_denied", requestId: env.request_id, peer: sender, scope: env.action, reason: "queue_full" })
      );
      return "denied";
    }
    if (hit.decision === "allow") {
      const res = await deps.autoApprove?.(env.request_id);
      if (res?.ok) {
        await deps.appendLedger(
          buildLedgerEntry({ now, kind: "auto_approved", requestId: env.request_id, peer: sender, scope: env.action, reason: hit.rule })
        );
        return "auto_approved";
      }
      const item = deps.queue.get(env.request_id);
      if (item && item.status !== "pending") {
        await deps.appendLedger(
          buildLedgerEntry({
            now, kind: "auto_approve_failed", requestId: env.request_id, peer: sender, scope: env.action,
            reason: res?.reason ?? item.status,
          })
        );
        return "auto_failed";
      }
    }
    await deps.send(
      input.conversationId,
      encodeEnvelope({ kind: "consent_pending", request_id: env.request_id, to: sender })
    );
    await deps.appendLedger(
      buildLedgerEntry({ now, kind: "action_queued", requestId: env.request_id, peer: sender, scope: env.action, reason: hit.rule })
    );
    return "queued";
  }

  if (env.kind === "action_result") {
    // 先查出站登记：没发过的 request、不是预期响应者、scope/参数哈希不符、已过期，全拒。
    const req = deps.outgoing?.get(env.request_id) ?? null;
    const earlyReason = matchOutgoing(deps, req, sender, now, {
      kind: "action", scope: env.grant?.scope, paramsHash: env.params_hash,
    });
    if (earlyReason === "unknown_request") {
      await deps.appendLedger(
        buildLedgerEntry({ now, kind: "action_result_rejected", requestId: env.request_id, peer: sender, reason: "unknown_request" })
      );
      return "rejected";
    }
    const result = await verifyGrant({
      grant: env.grant,
      signature: env.signature,
      expectedOwner: sender,
      expectedAudience: self,
      expectedPayloadHash: env.params_hash,
      now,
    });
    let reason: string | null = !result.ok
      ? result.reason
      : env.grant.request_id !== env.request_id
        ? "request_mismatch"
        : earlyReason;
    if (!reason) {
      // grant 只绑 params_hash——status/receipt/summary 必须由 owner 单独签名，
      // 否则转发路径上的攻击者可改写执行结果（如 executed↔uncertain 对调）。
      const resultSigned = await verifyActionResultSignature({
        owner: env.grant.owner,
        grant_id: env.grant.grant_id,
        request_id: env.request_id,
        params_hash: env.params_hash,
        status: env.status,
        receipt: env.receipt,
        summary: env.summary,
        signature: env.result_signature,
      });
      if (!resultSigned) reason = "bad_result_signature";
    }
    if (reason) {
      await deps.appendLedger(
        buildLedgerEntry({
          now, kind: "action_result_rejected", requestId: env.request_id, peer: sender, scope: env.grant?.scope, reason,
        })
      );
      return "rejected";
    }
    const settled = await settleResponse(deps, req, env.grant.grant_id, now, async () =>
      (await deps.storeActionResult?.(env, sender)) ?? true
    );
    if (settled === "duplicate") return "duplicate";
    await deps.appendLedger(
      buildLedgerEntry({
        now,
        kind: "action_result_received",
        requestId: env.request_id,
        peer: sender,
        scope: env.grant.scope,
        reason: env.status,
        payloadHash: env.params_hash,
      })
    );
    return "stored";
  }

  if (env.kind === "disclosure") {
    const req = deps.outgoing?.get(env.request_id) ?? null;
    const earlyReason = matchOutgoing(deps, req, sender, now, {
      kind: "data", scope: env.grant?.scope,
    });
    if (earlyReason === "unknown_request") {
      await deps.appendLedger(
        buildLedgerEntry({ now, kind: "disclosure_rejected", requestId: env.request_id, peer: sender, reason: "unknown_request" })
      );
      return "rejected";
    }
    const result = await verifyGrant({
      grant: env.grant,
      signature: env.signature,
      expectedOwner: sender,
      expectedAudience: self,
      payload: env.payload,
      now,
    });
    const reason = !result.ok
      ? result.reason
      : env.grant.request_id !== env.request_id
        ? "request_mismatch"
        : earlyReason;
    if (reason) {
      await deps.appendLedger(
        buildLedgerEntry({ now, kind: "disclosure_rejected", requestId: env.request_id, peer: sender, reason })
      );
      return "rejected";
    }
    const settled = await settleResponse(deps, req, env.grant.grant_id, now, () =>
      deps.storeDisclosure(env, sender)
    );
    if (settled === "duplicate") return "duplicate";
    await deps.appendLedger(
      buildLedgerEntry({
        now,
        kind: "disclosure_stored",
        requestId: env.request_id,
        peer: sender,
        scope: env.grant.scope,
        payloadHash: env.grant.payload_hash,
      })
    );
    return "stored";
  }

  if (env.kind === "consent_pending") {
    // 只对预期响应者有效——别人伪造的 pending 不改变本机对请求状态的认识。
    const req = deps.outgoing?.get(env.request_id) ?? null;
    const fail = matchOutgoing(deps, req, sender, now);
    if (fail) {
      await deps.appendLedger(
        buildLedgerEntry({ now, kind: "unmatched_response", requestId: env.request_id, peer: sender, reason: `consent_pending:${fail}` })
      );
      return "rejected";
    }
    await deps.appendLedger(
      buildLedgerEntry({ now, kind: "pending_received", requestId: env.request_id, peer: sender })
    );
    return "noted";
  }

  if (env.kind === "denial") {
    const req = deps.outgoing?.get(env.request_id) ?? null;
    const fail = matchOutgoing(deps, req, sender, now);
    if (fail) {
      await deps.appendLedger(
        buildLedgerEntry({ now, kind: "unmatched_response", requestId: env.request_id, peer: sender, reason: `denial:${fail}` })
      );
      return "rejected";
    }
    // denial 是终态响应：登记后同 request 的后续响应幂等丢弃（重复 denial 不报错）。
    const settled = await settleResponse(deps, req, null, now);
    if (settled === "duplicate") return "duplicate";
    await deps.appendLedger(
      buildLedgerEntry({ now, kind: "denial_received", requestId: env.request_id, peer: sender, reason: env.reason })
    );
    return "noted";
  }

  if (env.kind === "task") {
    // task.run 统一过规则引擎：cannot/ask 可拦截，legacy 白名单保留旧「允许跑任务」语义。
    const rules = mergeHubHouseRules(deps.policy, deps.hubRoomSettings?.() ?? null);
    const hit = decide(rules, deps.policy, { actor: sender, kind: "data", scope: "task.run" });
    const permitted =
      hit.decision === "allow" || (hit.decision === "ask" && hit.rule.startsWith("legacy_allow:"));
    if (!permitted) {
      const reason = hit.decision === "cannot" ? "cannot" : "out_of_scope";
      await deps.send(
        input.conversationId,
        encodeEnvelope({ kind: "denial", request_id: env.request_id, to: sender, reason })
      );
      await deps.appendLedger(
        buildLedgerEntry({
          now,
          kind: "request_denied",
          requestId: env.request_id,
          peer: sender,
          scope: "task.run",
          reason: hit.rule,
        })
      );
      return "denied";
    }
    if (deps.completeModel) {
      const prompt = buildTaskPrompt(env, {
        teamConfigMarkdown: deps.hubRoomSettings?.()?.teamConfigMarkdown,
      });
      const modelText = await deps.completeModel(prompt);
      const res = buildResult(env, modelText, sender);
      await deps.send(input.conversationId, encodeEnvelope(res));
      return "task_executed";
    }
    return "noted";
  }

  if (env.kind === "result") {
    if (deps.taskStore && deps.completeModel) {
      const record = deps.taskStore.get(env.request_id);
      if (!record || record.task.to !== sender ||
          !["pending", "retrying"].includes(record.status) ||
          env.round !== record.task.round + record.results.length) return "ignored";
      await deps.taskStore.recordResult(env.request_id, env);

      const settings = deps.hubRoomSettings?.() ?? null;
      const prompt = buildVerdictPrompt(record.task, env, {
        teamConfigMarkdown: settings?.teamConfigMarkdown,
      });
      const modelText = await deps.completeModel(prompt);
      let outcome = parseVerdict(modelText);
      if (!outcome) {
        outcome = { accepted: false, challenge: "解析模型验收结果失败" };
      }

      const step = parseVerdict(modelText)
        ? nextStep({ ...record.task, round: env.round }, outcome, settings?.defaultMaxRounds)
        : "escalate";
      const verdict: VerdictEnvelope = {
        kind: "verdict",
        request_id: env.request_id,
        to: sender,
        round: env.round,
        accepted: outcome.accepted,
        challenge: outcome.challenge,
      };

      await deps.send(input.conversationId, encodeEnvelope(verdict));
      await deps.appendLedger(
        buildLedgerEntry({
          now,
          kind: "verdict_sent",
          requestId: env.request_id,
          peer: sender,
          scope: "task.run",
          reason: outcome.accepted ? "accepted" : "rejected",
        })
      );

      if (step === "done") {
        await deps.taskStore.recordVerdict(env.request_id, verdict, "completed");
      } else if (step === "retry") {
        await deps.taskStore.recordVerdict(env.request_id, verdict, "retrying");
        const nextTask: TaskEnvelope = {
          ...record.task,
          round: env.round + 1,
        };
        await deps.send(input.conversationId, encodeEnvelope(nextTask));
        await deps.appendLedger(
          buildLedgerEntry({
            now,
            kind: "task_sent",
            requestId: env.request_id,
            peer: sender,
            scope: "task.run",
          })
        );
      } else if (step === "escalate") {
        await deps.taskStore.recordVerdict(env.request_id, verdict, "escalated");
        await deps.appendLedger(
          buildLedgerEntry({
            now,
            kind: "task_escalated",
            requestId: env.request_id,
            peer: sender,
            scope: "task.run",
          })
        );
      }
      return "verdict_processed";
    }
    return "noted";
  }

  if (env.kind === "verdict") {
    return "noted";
  }

  if (env.kind === "member_revoked") {
    const outcome =
      (await deps.onMemberRevoked?.(env.address, input.conversationId, sender, env.request_id)) ??
      "unconfirmed";
    if (outcome !== "no_revocable_state") {
      await deps.appendLedger(
        buildLedgerEntry({
          now,
          kind: "member_revoked_received",
          requestId: env.request_id,
          peer: env.address,
          sender,
          reason: outcome,
        })
      );
    }
    return "noted";
  }

  await deps.appendLedger(
    buildLedgerEntry({ now, kind: "pending_received", requestId: (env as Envelope).request_id, peer: sender })
  );
  return "noted";
}
