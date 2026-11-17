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

  constructor(ttlMs = 60_000) {
    this.ttlMs = ttlMs;
  }

  async allows(sender: string, group: GroupLike): Promise<boolean> {
    if (typeof group?.members !== "function") return false;
    const key = group.id ?? "";
    const entry = this.cache.get(key);
    if (entry && Date.now() - entry.at < this.ttlMs) {
      if (entry.members.has(sender)) return true;
    }
    const fresh = await this.refresh(key, group);
    return fresh.has(sender);
  }

  invalidate(groupId: string): void {
    this.cache.delete(groupId);
  }

  private async refresh(key: string, group: GroupLike): Promise<Set<string>> {
    const members = new Set<string>();
    try {
      const list = (await group.members?.()) ?? [];
      for (const member of list as any[]) {
        for (const identifier of member?.accountIdentifiers ?? []) {
          const address = identifier?.identifier;
          if (typeof address === "string") members.add(address.toLowerCase());
        }
      }
    } catch {
      return members;
    }
    this.cache.set(key, { at: Date.now(), members });
    return members;
  }
}
