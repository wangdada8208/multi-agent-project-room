import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { KNOWN_SCOPES, type DateRange } from "./envelope.ts";

export interface Policy {
  allow: Record<string, string[]>;
  max_range_days: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function defaultPolicy(): Policy {
  return { allow: {}, max_range_days: 14 };
}

export function normalizePolicy(raw: any): Policy {
  const allow: Record<string, string[]> = {};
  if (raw && typeof raw.allow === "object" && raw.allow !== null) {
    for (const [address, scopes] of Object.entries(raw.allow)) {
      if (Array.isArray(scopes)) {
        allow[address.toLowerCase()] = scopes.filter((s): s is string => typeof s === "string");
      }
    }
  }
  const days = Number(raw?.max_range_days);
  const max_range_days = Number.isInteger(days) && days >= 1 && days <= 31 ? days : 14;
  return { allow, max_range_days };
}

export async function loadPolicy(file: string): Promise<Policy> {
  if (!existsSync(file)) return defaultPolicy();
  return normalizePolicy(JSON.parse(await readFile(file, "utf8")));
}

export function checkRequest(
  policy: Policy,
  sender: string,
  request: { scope: string; constraints?: any }
): { ok: true } | { ok: false; reason: "out_of_scope" } {
  const denied = { ok: false as const, reason: "out_of_scope" as const };
  const known = (KNOWN_SCOPES as readonly string[]).includes(request.scope);
  const allowed = policy.allow[sender.toLowerCase()] ?? [];
  if (!known || !allowed.includes(request.scope)) return denied;
  if (request.scope === "task.run") {
    return { ok: true };
  }
  if (!request.constraints) return denied;

  if (request.scope === "email.receipt") {
    if (
      typeof request.constraints.query !== "string" ||
      request.constraints.query.length === 0 ||
      request.constraints.query.length > 200
    ) {
      return denied;
    }
  }

  const from = Date.parse(`${request.constraints.date_from}T00:00:00Z`);
  const to = Date.parse(`${request.constraints.date_to}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return denied;
  const days = (to - from) / DAY_MS + 1;
  if (days > policy.max_range_days) return denied;
  return { ok: true };
}
