import { randomUUID } from "node:crypto";
import { isAddress, isDateRange, KNOWN_SCOPES, type RequestEnvelope } from "./envelope.ts";

export type BuildRequestResult =
  | { ok: true; envelope: RequestEnvelope }
  | { ok: false; reason: "bad_address" | "unknown_scope" | "bad_range" | "purpose_too_long" | "self_request" };

export function buildRequestEnvelope(
  input: { to: unknown; scope: unknown; purpose: unknown; date_from: unknown; date_to: unknown },
  selfAddress: string
): BuildRequestResult {
  const to = typeof input.to === "string" ? input.to.trim().toLowerCase() : "";
  if (!isAddress(to)) return { ok: false, reason: "bad_address" };
  if (to === selfAddress.toLowerCase()) return { ok: false, reason: "self_request" };
  const scope = typeof input.scope === "string" ? input.scope : "";
  if (!(KNOWN_SCOPES as readonly string[]).includes(scope)) return { ok: false, reason: "unknown_scope" };
  const constraints = { date_from: input.date_from, date_to: input.date_to };
  if (!isDateRange(constraints)) return { ok: false, reason: "bad_range" };
  const purpose = typeof input.purpose === "string" ? input.purpose.trim() : "";
  if (purpose.length > 280) return { ok: false, reason: "purpose_too_long" };
  return {
    ok: true,
    envelope: {
      kind: "request",
      request_id: randomUUID(),
      to,
      scope,
      purpose,
      constraints: { date_from: constraints.date_from, date_to: constraints.date_to },
    },
  };
}
