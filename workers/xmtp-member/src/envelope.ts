export const ENVELOPE_PREFIX = "MAPR1 ";

export const KNOWN_SCOPES = ["calendar.free_busy"] as const;

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

export type DenialReason = "out_of_scope" | "owner_denied" | "expired";

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
  payload: FreeBusyPayload;
}

export type Envelope =
  | RequestEnvelope
  | PendingEnvelope
  | DenialEnvelope
  | DisclosureEnvelope;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const DENIAL_REASONS: DenialReason[] = ["out_of_scope", "owner_denied", "expired"];

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
  if (!isShortString(raw.request_id, 64) || !isAddress(raw.to)) return null;

  switch (raw.kind) {
    case "request":
      if (!isShortString(raw.scope, 64)) return null;
      if (typeof raw.purpose !== "string" || raw.purpose.length > 280) return null;
      if (!isDateRange(raw.constraints)) return null;
      return {
        kind: "request",
        request_id: raw.request_id,
        to: raw.to,
        scope: raw.scope,
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
    default:
      return null;
  }
}
