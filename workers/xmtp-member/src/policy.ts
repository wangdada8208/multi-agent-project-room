import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { normalizeScope } from "./canonical.ts";
import { KNOWN_SCOPES, type DateRange } from "./envelope.ts";
import { normalizeRules, type RulesConfig } from "./rulesEngine.ts";
import { writeJsonSecure } from "./secureFile.ts";

export interface Policy {
  allow: Record<string, string[]>;
  max_range_days: number;
  /** House Rules + 单成员覆盖；缺省时 rulesEngine 走出厂默认（"*"→ask）。 */
  rules?: RulesConfig;
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
        allow[address.toLowerCase()] = scopes
          .filter((s): s is string => typeof s === "string")
          .map((s) => normalizeScope(s));
      }
    }
  }
  const days = Number(raw?.max_range_days);
  const max_range_days = Number.isInteger(days) && days >= 1 && days <= 31 ? days : 14;
  const rules = raw?.rules ? normalizeRules(raw.rules) : undefined;
  return rules ? { allow, max_range_days, rules } : { allow, max_range_days };
}

export async function loadPolicy(file: string): Promise<Policy> {
  if (!existsSync(file)) return defaultPolicy();
  return normalizePolicy(JSON.parse(await readFile(file, "utf8")));
}

/**
 * 持久化本机授权策略（0600：policy.json 含有发送者授权清单）。
 * 供撤销等会修改 allow 表的运行时路径调用。
 */
export async function savePolicy(file: string, policy: Policy): Promise<void> {
  await writeJsonSecure(file, policy);
}

export function checkRequest(
  policy: Policy,
  sender: string,
  request: { scope: string; constraints?: any }
): { ok: true } | { ok: false; reason: "out_of_scope" } {
  const denied = { ok: false as const, reason: "out_of_scope" as const };
  const allowed = policy.allow[sender.toLowerCase()] ?? [];
  if (!allowed.includes(normalizeScope(request.scope))) return denied;
  return checkScopeConstraints(policy, request);
}

/** scope 可服务性与约束合法性——谁批的不管（规则引擎的事），只管「这个请求本身成不成立」。 */
export function checkScopeConstraints(
  policy: Policy,
  request: { scope: string; constraints?: any }
): { ok: true } | { ok: false; reason: "out_of_scope" } {
  const denied = { ok: false as const, reason: "out_of_scope" as const };
  const scope = normalizeScope(request.scope);
  const known = (KNOWN_SCOPES as readonly string[]).includes(scope);
  if (!known) return denied;
  if (scope === "task.run") {
    return { ok: true };
  }
  if (!request.constraints) return denied;

  if (scope === "email.receipt") {
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
