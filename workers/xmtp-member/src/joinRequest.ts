import { isAddress, KNOWN_SCOPES } from "./envelope.ts";
import type { Policy } from "./policy.ts";

export interface JoinRequestData {
  candidate: string;
  proposed_scopes: string[];
}

export type BuildJoinResult =
  | { ok: true; request: JoinRequestData }
  | { ok: false; reason: "invalid_candidate" | "invalid_scopes" };

export function buildJoinRequest(
  candidate: string,
  proposedScopes: string[]
): BuildJoinResult {
  const norm = candidate.toLowerCase().trim();
  if (!isAddress(norm)) {
    return { ok: false, reason: "invalid_candidate" };
  }
  const scopes = Array.isArray(proposedScopes)
    ? proposedScopes.filter((s) => (KNOWN_SCOPES as readonly string[]).includes(s))
    : [];

  return {
    ok: true,
    request: {
      candidate: norm,
      proposed_scopes: scopes,
    },
  };
}

export function applyJoinApproval(
  policy: Policy,
  candidate: string,
  approvedScopes: string[]
): Policy {
  const norm = candidate.toLowerCase().trim();
  const validApproved = approvedScopes.filter((s) =>
    (KNOWN_SCOPES as readonly string[]).includes(s)
  );

  const newAllow: Record<string, string[]> = {};
  for (const [addr, scopes] of Object.entries(policy.allow)) {
    newAllow[addr] = [...scopes];
  }

  const existing = newAllow[norm] || [];
  const merged = Array.from(new Set([...existing, ...validApproved]));
  newAllow[norm] = merged;

  return {
    allow: newAllow,
    max_range_days: policy.max_range_days,
  };
}
