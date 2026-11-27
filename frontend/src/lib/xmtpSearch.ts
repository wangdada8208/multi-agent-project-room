/**
 * XMTP 本地搜索索引：
 * - 纯内存索引，数据源只来自 group.messages() 历史与消息流增量；
 *   不调用 Hub 搜索接口，不把明文索引写入磁盘或 localStorage。
 * - 有界：默认最多 2000 条且保留最近 7 天，超限按时间从旧到新淘汰，内存占用有上界。
 */

export interface XmtpSearchEntry {
  id: string;
  senderInboxId: string;
  content: string;
  createdAt: string;
}

export interface XmtpSearchIndexOptions {
  maxEntries?: number;
  maxAgeMs?: number;
  now?: () => number;
}

export const XMTP_SEARCH_MAX_ENTRIES = 2000;
export const XMTP_SEARCH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const XMTP_SEARCH_DEFAULT_LIMIT = 100;

function compareEntries(a: XmtpSearchEntry, b: XmtpSearchEntry): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (ta !== tb) return ta - tb;
  return a.id.localeCompare(b.id);
}

export class XmtpSearchIndex {
  private readonly maxEntries: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private entries = new Map<string, XmtpSearchEntry>();

  constructor(options: XmtpSearchIndexOptions = {}) {
    this.maxEntries = options.maxEntries ?? XMTP_SEARCH_MAX_ENTRIES;
    this.maxAgeMs = options.maxAgeMs ?? XMTP_SEARCH_MAX_AGE_MS;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  upsert(entry: XmtpSearchEntry): void {
    if (this.insert(entry)) {
      this.prune();
    }
  }

  ingest(batch: Iterable<XmtpSearchEntry>): void {
    for (const entry of batch) {
      this.insert(entry);
    }
    this.prune();
  }

  private insert(entry: XmtpSearchEntry): boolean {
    if (!entry?.id || !entry.senderInboxId || typeof entry.content !== "string" || !entry.content) {
      return false;
    }
    this.entries.set(entry.id, entry);
    return true;
  }

  search(
    query: string,
    filter: { senderInboxId?: string; limit?: number } = {},
  ): XmtpSearchEntry[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    this.prune();
    const limit = filter.limit ?? XMTP_SEARCH_DEFAULT_LIMIT;
    const results: XmtpSearchEntry[] = [];
    for (const entry of this.entries.values()) {
      if (filter.senderInboxId && entry.senderInboxId !== filter.senderInboxId) continue;
      if (!entry.content.toLowerCase().includes(needle)) continue;
      results.push(entry);
    }
    results.sort(compareEntries);
    return results.slice(0, limit);
  }

  private prune(): void {
    if (this.entries.size === 0) return;
    const cutoff = this.now() - this.maxAgeMs;
    for (const [id, entry] of this.entries) {
      const t = Date.parse(entry.createdAt);
      if (!Number.isFinite(t) || t < cutoff) this.entries.delete(id);
    }
    if (this.entries.size <= this.maxEntries) return;
    const sorted = [...this.entries.values()].sort(compareEntries);
    for (const entry of sorted) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(entry.id);
    }
  }
}

/**
 * 从 SDK 解码后的消息提取可索引/可展示的文本：
 * - 普通文本消息：content 为 string。
 * - 回复消息（EnrichedReply）：content 为 { referenceId, content } 对象，
 *   内层为 string 时取出正文并返回被引用消息 id；内层非文本时回退到 fallback。
 * - 其余内容类型（附件/回执/群事件等）：返回 null，不进入索引也不该当聊天气泡。
 */
export function extractXmtpMessageText(message: {
  content: unknown;
  fallback?: string;
}): { text: string; replyToId?: string } | null {
  const content = message?.content;
  if (typeof content === "string") {
    return { text: content };
  }
  if (content && typeof content === "object" && typeof (content as { referenceId?: unknown }).referenceId === "string") {
    const reply = content as { referenceId: string; content: unknown };
    const inner = reply.content;
    if (typeof inner === "string") {
      return { text: inner, replyToId: reply.referenceId };
    }
    const fallback = typeof message.fallback === "string" && message.fallback ? message.fallback : "【暂不支持的消息类型】";
    return { text: fallback, replyToId: reply.referenceId };
  }
  return null;
}
