import type { ConsentQueue } from "./consentQueue.ts";
import { encodeEnvelope, type DisclosureEnvelope, type Envelope } from "./envelope.ts";
import { verifyGrant } from "./grant.ts";
import { buildLedgerEntry, type LedgerEntry } from "./ledger.ts";
import { checkRequest, type Policy } from "./policy.ts";

export interface HandleEnvelopeDeps {
  selfAddress: string;
  policy: Policy;
  queue: ConsentQueue;
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
  | "noted";

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

  await deps.appendLedger(
    buildLedgerEntry({ now, kind: "pending_received", requestId: env.request_id, peer: sender })
  );
  return "noted";
}
