import type { ConsentQueue } from "./consentQueue.ts";
import { buildVerdictPrompt, nextStep, parseVerdict } from "./coordinator.ts";
import {
  encodeEnvelope,
  type DisclosureEnvelope,
  type Envelope,
  type ResultEnvelope,
  type TaskEnvelope,
  type VerdictEnvelope,
} from "./envelope.ts";
import { buildResult, buildTaskPrompt } from "./executor.ts";
import { verifyGrant } from "./grant.ts";
import { buildLedgerEntry, type LedgerEntry } from "./ledger.ts";
import { checkRequest, type Policy } from "./policy.ts";
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
  now: () => Date;
}

export type HandleOutcome =
  | "ignored"
  | "denied"
  | "queued"
  | "duplicate"
  | "stored"
  | "rejected"
  | "noted"
  | "task_executed"
  | "verdict_processed";

export async function handleEnvelope(
  input: { envelope: Envelope; sender: string; conversationId: string },
  deps: HandleEnvelopeDeps
): Promise<HandleOutcome> {
  const self = deps.selfAddress.toLowerCase();
  const sender = input.sender.toLowerCase();
  const env = input.envelope;
  if (env.to !== self) return "ignored";
  const now = deps.now();

  if (env.kind === "request") {
    const check = checkRequest(deps.policy, sender, env);
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
    });
    if (!added) return "duplicate";
    await deps.send(
      input.conversationId,
      encodeEnvelope({ kind: "consent_pending", request_id: env.request_id, to: sender })
    );
    await deps.appendLedger(
      buildLedgerEntry({ now, kind: "request_queued", requestId: env.request_id, peer: sender, scope: env.scope })
    );
    return "queued";
  }

  if (env.kind === "disclosure") {
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
        : null;
    if (reason) {
      await deps.appendLedger(
        buildLedgerEntry({ now, kind: "disclosure_rejected", requestId: env.request_id, peer: sender, reason })
      );
      return "rejected";
    }
    const stored = await deps.storeDisclosure(env, sender);
    if (!stored) return "duplicate";
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

  if (env.kind === "denial") {
    await deps.appendLedger(
      buildLedgerEntry({ now, kind: "denial_received", requestId: env.request_id, peer: sender, reason: env.reason })
    );
    return "noted";
  }

  if (env.kind === "task") {
    const check = checkRequest(deps.policy, sender, { scope: "task.run" });
    if (!check.ok) {
      await deps.send(
        input.conversationId,
        encodeEnvelope({ kind: "denial", request_id: env.request_id, to: sender, reason: "out_of_scope" })
      );
      await deps.appendLedger(
        buildLedgerEntry({
          now,
          kind: "request_denied",
          requestId: env.request_id,
          peer: sender,
          scope: "task.run",
          reason: "out_of_scope",
        })
      );
      return "denied";
    }
    if (deps.completeModel) {
      const prompt = buildTaskPrompt(env);
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

      const prompt = buildVerdictPrompt(record.task, env);
      const modelText = await deps.completeModel(prompt);
      let outcome = parseVerdict(modelText);
      if (!outcome) {
        outcome = { accepted: false, challenge: "解析模型验收结果失败" };
      }

      const step = parseVerdict(modelText) ? nextStep({ ...record.task, round: env.round }, outcome) : "escalate";
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

  await deps.appendLedger(
    buildLedgerEntry({ now, kind: "pending_received", requestId: env.request_id, peer: sender })
  );
  return "noted";
}
