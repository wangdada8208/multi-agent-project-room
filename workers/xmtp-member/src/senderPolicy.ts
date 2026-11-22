import type { RevocationStore } from "./revocations.ts";

export function parseAllowedSenders(raw: string | undefined): string[] {
  return (raw || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-f]{40}$/.test(s));
}

export function isAllowedSender(
  sender: string | undefined | null,
  allowed: string[]
): boolean {
  if (!sender) return false;
  return allowed.includes(sender.toLowerCase());
}

export interface GroupLike {
  id?: string;
  members?: () => Promise<unknown>;
}

/**
 * XMTP_ALLOW_GROUP_MEMBERS=1 时，同一加密群里的成员也算允许的发送者。
 * 成员列表按群缓存 ttlMs；缓存里没有该发送者时再拉一次新列表，
 * 覆盖「新成员刚进群就发消息」与「旧成员退群后继续发消息」两种情况。
 * members() 拉取失败时不缓存空结果，下一条消息会重试。
 */
export class GroupMemberCache {
  private readonly ttlMs: number;
  private readonly cache = new Map<string, { at: number; members: Set<string> }>();
  private readonly invalidations = new Map<string, number>();

  constructor(ttlMs = 60_000) {
    this.ttlMs = ttlMs;
  }

  epoch(groupId: string): number {
    return this.invalidations.get(groupId) ?? 0;
  }

  async allows(sender: string, group: GroupLike, opts: { forceRefresh?: boolean } = {}): Promise<boolean> {
    if (typeof group?.members !== "function" || !group.id) return false;
    const key = group.id;
    const entry = this.cache.get(key);
    if (!opts.forceRefresh && entry && Date.now() - entry.at < this.ttlMs) {
      if (entry.members.has(sender)) return true;
    }
    const fresh = await this.refresh(key, group);
    return fresh.has(sender);
  }

  invalidate(groupId: string): void {
    this.invalidations.set(groupId, this.epoch(groupId) + 1);
    this.cache.delete(groupId);
  }

  private async refresh(key: string, group: GroupLike): Promise<Set<string>> {
    const gen = this.epoch(key);
    const members = new Set<string>();
    try {
      const list = await group.members?.();
      if (!Array.isArray(list) || list.length === 0) return members;
      for (const member of list) {
        if (!member || typeof member !== "object" || !("accountIdentifiers" in member)
          || !Array.isArray(member.accountIdentifiers) || member.accountIdentifiers.length === 0) {
          return new Set<string>();
        }
        for (const identifier of member.accountIdentifiers) {
          if (!identifier || typeof identifier !== "object" || !("identifier" in identifier)
            || typeof identifier.identifier !== "string"
            || !/^0x[0-9a-f]{40}$/.test(identifier.identifier.toLowerCase())) {
            return new Set<string>();
          }
          members.add(identifier.identifier.toLowerCase());
        }
      }
    } catch {
      return members;
    }
    if (this.epoch(key) === gen) {
      this.cache.set(key, { at: Date.now(), members });
    }
    return members;
  }
}

export interface SenderAuthorizationDeps {
  allowedSenders: string[];
  allowGroupMembers: boolean;
  groupMembers: GroupMemberCache;
  revoked: Pick<RevocationStore, "has" | "remove">;
}

/** DM 不查群成员；群发送者必须已授权且当前仍在群内，撤销记录只作用于同一 conversation。 */
export async function isSenderAuthorized(
  input: { sender: string; isGroup: boolean | null | undefined; conversation: GroupLike },
  deps: SenderAuthorizationDeps
): Promise<boolean> {
  if (typeof input.isGroup !== "boolean") return false;
  const sender = input.sender.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(sender)) return false;
  const explicitlyAllowed = isAllowedSender(sender, deps.allowedSenders);
  if (!input.isGroup) return explicitlyAllowed;
  if (!explicitlyAllowed && !deps.allowGroupMembers) return false;
  const conversationId = input.conversation.id;
  if (!conversationId) return false;

  const wasRevoked = deps.revoked.has(sender, conversationId);
  const epochBefore = deps.groupMembers.epoch(conversationId);
  const present = await deps.groupMembers.allows(sender, input.conversation, { forceRefresh: wasRevoked });
  if (!present) return false;
  if (deps.groupMembers.epoch(conversationId) !== epochBefore) return false;
  if (!wasRevoked) return true;
  try {
    await deps.revoked.remove(sender, conversationId);
    return true;
  } catch {
    return false;
  }
}
