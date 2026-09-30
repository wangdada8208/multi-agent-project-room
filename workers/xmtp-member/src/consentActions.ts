import { freeBusy, type CalendarEvent } from "./calendar.ts";
import type { ConsentQueue } from "./consentQueue.ts";
import { encodeEnvelope } from "./envelope.ts";
import { buildGrant, signGrant } from "./grant.ts";
import { buildLedgerEntry, type LedgerEntry } from "./ledger.ts";

export const CONSENT_TTL_MS = 10 * 60 * 1000;

export interface ConsentActionDeps {
  selfAddress: string;
  privateKey: string;
  queue: ConsentQueue;
  loadCalendar: () => Promise<CalendarEvent[]>;
  send: (conversationId: string, text: string) => Promise<void>;
  appendLedger: (entry: LedgerEntry) => Promise<void>;
  now: () => Date;
}

export type ActionResult = { ok: true } | { ok: false; reason: "not_pending" | "send_failed" };

export async function approveConsent(requestId: string, deps: ConsentActionDeps): Promise<ActionResult> {
  const item = await deps.queue.claim(requestId, "approved");
  if (!item) return { ok: false, reason: "not_pending" };
  const now = deps.now();
  const payload = freeBusy(await deps.loadCalendar(), item.constraints);
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
  try {
    await deps.send(
      item.conversation_id,
      encodeEnvelope({ kind: "disclosure", request_id: item.request_id, to: item.requester, grant, signature, payload })
    );
  } catch {
    await deps.appendLedger(
      buildLedgerEntry({ now, kind: "send_failed", requestId: item.request_id, peer: item.requester, scope: item.scope })
    );
    return { ok: false, reason: "send_failed" };
  }
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

export async function denyConsent(
  requestId: string,
  reason: "owner_denied" | "expired",
  deps: ConsentActionDeps
): Promise<ActionResult> {
  const item = await deps.queue.claim(requestId, reason === "expired" ? "expired" : "denied");
  if (!item) return { ok: false, reason: "not_pending" };
  const now = deps.now();
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
  const due = deps.queue.dueForExpiry(deps.now(), CONSENT_TTL_MS);
  let count = 0;
  for (const item of due) {
    const result = await denyConsent(item.request_id, "expired", deps);
    if (result.ok) count += 1;
  }
  return count;
}
