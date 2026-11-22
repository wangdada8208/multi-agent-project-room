import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ConsentQueue } from "./consentQueue.ts";
import type { Policy } from "./policy.ts";
import { writeJsonSecure } from "./secureFile.ts";

/**
 * member_revoked 是不可信输入：只能当「重新核实群成员」的提示。
 * 本模块实现真实的安全判定——
 * 1. 只有本房 active group 会话里的广播才有意义；DM/其它群一律 ignored_context，绝不清授权。
 * 2. 核实前先 sync()，再读 members()；目标仍在 → unconfirmed（不清）。
 * 3. 确认缺席才写该 conversation 的撤销记录，并取消同会话尚未执行的审批；
 *    DM 授权、其它会话审批和全局白名单不受群成员变化影响。
 * 4. 只核实有可撤销状态的目标；全局限速、有界持久队列，重试突发耗尽后转低频复查。
 */

export type MemberRevokedOutcome =
  | "applied"           // 核实缺席且已清理并持久化
  | "already_revoked"   // 早前已确认撤销——幂等，不再拉成员表
  | "duplicate"         // 同一 request_id 重复广播
  | "rate_limited"      // 地址或全局核实过于频繁，交给有界重试
  | "unconfirmed"       // 核实失败或目标仍在群里——不清，排有界重试
  | "no_revocable_state" // 无授权、白名单或未执行审批——不核实、不写撤销
  | "ignored_context";  // 私聊或非本房群的广播——不核实、不清、不重试

export interface RevokedEntry {
  address: string;
  at: string;
  sender: string;
  conversation_id: string;
}

/** 群会话作用域的撤销名单；不会撤销同一地址在 DM 或其它会话里的授权。 */
export class RevocationStore {
  private entries = new Map<string, RevokedEntry>();
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  private key(address: string, conversationId: string): string {
    return `${conversationId}:${address.toLowerCase()}`;
  }

  async load(): Promise<void> {
    if (!existsSync(this.file)) return;
    let raw: any;
    try {
      raw = JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      throw new Error("Revocation store is corrupt; refusing to load");
    }
    if (!Array.isArray(raw)) throw new Error("Revocation store is corrupt; refusing to load");
    const entries = new Map<string, RevokedEntry>();
    for (const e of raw) {
      if (!e || typeof e.address !== "string" || !/^0x[0-9a-f]{40}$/.test(e.address)
        || typeof e.conversation_id !== "string" || e.conversation_id.length === 0) {
        throw new Error("Revocation store is corrupt; refusing to load");
      }
      const entry = {
        address: e.address,
        at: typeof e.at === "string" ? e.at : "",
        sender: typeof e.sender === "string" ? e.sender : "",
        conversation_id: e.conversation_id,
      };
      entries.set(this.key(entry.address, entry.conversation_id), entry);
    }
    this.entries = entries;
  }

  has(address: string, conversationId: string): boolean {
    return this.entries.has(this.key(address, conversationId));
  }

  list(): RevokedEntry[] {
    return [...this.entries.values()];
  }

  async add(entry: RevokedEntry): Promise<void> {
    this.entries.set(this.key(entry.address, entry.conversation_id), entry);
    await writeJsonSecure(this.file, this.list());
  }

  async remove(address: string, conversationId: string): Promise<void> {
    const key = this.key(address, conversationId);
    if (!this.entries.delete(key)) return;
    await writeJsonSecure(this.file, this.list());
  }
}

/** 广播去重（request_id 有界集合）+ 每地址与全局核实限速。 */
export class RevocationDedup {
  private readonly maxSeen: number;
  private readonly verifyIntervalMs: number;
  private readonly globalVerifyIntervalMs: number;
  private seen: string[] = [];
  private seenSet = new Set<string>();
  private lastVerifyAt = new Map<string, number>();
  private lastGlobalVerifyAt: number | null = null;

  constructor(opts: { maxSeen?: number; verifyIntervalMs?: number; globalVerifyIntervalMs?: number } = {}) {
    this.maxSeen = opts.maxSeen ?? 1000;
    this.verifyIntervalMs = opts.verifyIntervalMs ?? 15_000;
    this.globalVerifyIntervalMs = opts.globalVerifyIntervalMs ?? 1_000;
  }

  /** 返回 false = 同 request_id 已见过。 */
  seenOnce(requestId: string): boolean {
    if (this.seenSet.has(requestId)) return false;
    this.seenSet.add(requestId);
    this.seen.push(requestId);
    while (this.seen.length > this.maxSeen) {
      const oldest = this.seen.shift()!;
      this.seenSet.delete(oldest);
    }
    return true;
  }

  verifyAllowed(address: string, now: number, skipAddressWindow = false): boolean {
    if (this.lastGlobalVerifyAt !== null && now - this.lastGlobalVerifyAt < this.globalVerifyIntervalMs) {
      return false;
    }
    if (skipAddressWindow) return true;
    const last = this.lastVerifyAt.get(address);
    return last === undefined || now - last >= this.verifyIntervalMs;
  }

  markVerify(address: string, now: number): void {
    this.lastVerifyAt.set(address, now);
    this.lastGlobalVerifyAt = now;
  }
}

/** 未确认的撤销提示：有界持久队列 + 退避重核；一轮失败后转低频复查。 */
export interface PendingRevocation {
  address: string;
  conversationId: string;
  sender: string;
  requestId: string;
  attempts: number;
  nextAttemptAt: number;
}

export class RevocationRetries {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly stalledDelayMs: number;
  private readonly maxPending: number;
  private readonly file?: string;
  private pending = new Map<string, PendingRevocation>();
  private operations: Promise<void> = Promise.resolve();

  constructor(opts: {
    maxAttempts?: number;
    baseDelayMs?: number;
    stalledDelayMs?: number;
    maxPending?: number;
    file?: string;
  } = {}) {
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.baseDelayMs = opts.baseDelayMs ?? 60_000;
    this.stalledDelayMs = opts.stalledDelayMs ?? 60 * 60_000;
    this.maxPending = opts.maxPending ?? 100;
    this.file = opts.file;
  }

  private key(address: string, conversationId: string): string {
    return `${conversationId}:${address}`;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operations.then(operation);
    this.operations = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async idle(): Promise<void> {
    await this.operations;
  }

  async load(): Promise<void> {
    if (!this.file || !existsSync(this.file)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      throw new Error("Pending revocation store is corrupt; refusing to load");
    }
    if (!Array.isArray(raw) || raw.length > this.maxPending) {
      throw new Error("Pending revocation store is corrupt; refusing to load");
    }
    const restored = new Map<string, PendingRevocation>();
    for (const value of raw) {
      if (!this.isPending(value)) throw new Error("Pending revocation store is corrupt; refusing to load");
      const entry = { ...value, address: value.address.toLowerCase() };
      restored.set(this.key(entry.address, entry.conversationId), entry);
    }
    this.pending = restored;
  }

  private isPending(value: unknown): value is PendingRevocation {
    if (!value || typeof value !== "object") return false;
    if (!("address" in value) || !("conversationId" in value) || !("sender" in value)
      || !("requestId" in value) || !("attempts" in value) || !("nextAttemptAt" in value)) return false;
    return typeof value.address === "string" && /^0x[0-9a-f]{40}$/.test(value.address)
      && typeof value.conversationId === "string" && value.conversationId.length > 0
      && typeof value.sender === "string" && /^0x[0-9a-f]{40}$/.test(value.sender)
      && typeof value.requestId === "string" && value.requestId.length > 0
      && typeof value.attempts === "number" && Number.isInteger(value.attempts)
      && value.attempts >= 0 && value.attempts < this.maxAttempts
      && typeof value.nextAttemptAt === "number" && Number.isFinite(value.nextAttemptAt)
      && value.nextAttemptAt >= 0;
  }

  list(): PendingRevocation[] {
    return [...this.pending.values()].map((entry) => ({ ...entry }));
  }

  private async save(): Promise<void> {
    if (this.file) await writeJsonSecure(this.file, this.list());
  }

  schedule(entry: Omit<PendingRevocation, "attempts" | "nextAttemptAt">, now: number): Promise<boolean> {
    return this.enqueue(async () => {
      const key = this.key(entry.address, entry.conversationId);
      if (this.pending.has(key)) return true;
      if (this.pending.size >= this.maxPending) return false;
      const pending = { ...entry, attempts: 0, nextAttemptAt: now };
      this.pending.set(key, pending);
      try {
        await this.save();
        return true;
      } catch (error) {
        this.pending.delete(key);
        throw error;
      }
    });
  }

  due(now: number): PendingRevocation[] {
    return this.list().filter((entry) => entry.nextAttemptAt <= now);
  }

  /** 每轮重试有界；耗尽后保留待核记录并降低频率，而不是永久失去复查机会。 */
  fail(entry: PendingRevocation, now: number): Promise<boolean> {
    return this.enqueue(async () => {
      const key = this.key(entry.address, entry.conversationId);
      const current = this.pending.get(key);
      if (!current) return false;
      const previous = { ...current };
      current.attempts += 1;
      const stalled = current.attempts >= this.maxAttempts;
      current.nextAttemptAt = stalled
        ? now + this.stalledDelayMs
        : now + this.baseDelayMs * current.attempts;
      if (stalled) current.attempts = 0;
      try {
        await this.save();
        return !stalled;
      } catch (error) {
        this.pending.set(key, previous);
        throw error;
      }
    });
  }

  done(entry: PendingRevocation): Promise<void> {
    return this.enqueue(async () => {
      const key = this.key(entry.address, entry.conversationId);
      const current = this.pending.get(key);
      if (!current) return;
      this.pending.delete(key);
      try {
        await this.save();
      } catch (error) {
        this.pending.set(key, current);
        throw error;
      }
    });
  }

  defer(entry: PendingRevocation, now: number, delayMs = 1_500): Promise<void> {
    return this.enqueue(async () => {
      const key = this.key(entry.address, entry.conversationId);
      const current = this.pending.get(key);
      if (!current) return;
      const previous = { ...current };
      current.nextAttemptAt = Math.max(current.nextAttemptAt, now + delayMs);
      try {
        await this.save();
      } catch (error) {
        this.pending.set(key, previous);
        throw error;
      }
    });
  }

  size(): number {
    return this.pending.size;
  }
}

export interface RevokeConversationLike {
  isGroup?(): boolean;
  conversation?: {
    id?: string;
    sync?(): Promise<unknown>;
    members?(): Promise<{ accountIdentifiers?: { identifier?: string }[] }[]>;
  };
}

export interface ApplyRevokedDeps {
  /** 本房 active group id；非该会话的广播一律 ignored_context。 */
  activeGroupId: () => string | null;
  getConversation: (id: string) => Promise<RevokeConversationLike | null>;
  syncAll: () => Promise<void>;
  policy: Policy;
  allowedSenders: string[];
  revoked: RevocationStore;
  dedup: RevocationDedup;
  queue?: ConsentQueue;
  /** 为 true 时只跳过每地址限速；全局限速仍生效。 */
  fromRetry?: boolean;
  now: () => Date;
}

export interface ApplyRevokedResult {
  outcome: MemberRevokedOutcome;
  /** 已通过 sync+members 确认目标仍在群内；区别于成员表读取失败。 */
  subjectPresent?: boolean;
  /** 被清理的 pending consent request_id 列表（记账本用）。 */
  deniedRequestIds: string[];
}

async function verifyAbsent(
  address: string,
  conversationId: string,
  deps: ApplyRevokedDeps
): Promise<"absent" | "present" | "unknown" | "ignored_context"> {
  let ctx: RevokeConversationLike | null;
  try {
    ctx = await deps.getConversation(conversationId);
    if (!ctx) {
      await deps.syncAll();
      ctx = await deps.getConversation(conversationId);
    }
  } catch {
    return "unknown";
  }
  if (!ctx) return "unknown";
  if (ctx.isGroup?.() !== true) return "ignored_context";
  const conv = ctx.conversation;
  if (conv?.id !== conversationId || typeof conv.members !== "function") return "ignored_context";
  try {
    await conv.sync?.();
  } catch {
    return "unknown";
  }
  let present: Set<string>;
  try {
    const members = await conv.members();
    if (members.length === 0) return "unknown";
    present = new Set<string>();
    for (const member of members) {
      if (!Array.isArray(member.accountIdentifiers) || member.accountIdentifiers.length === 0) {
        return "unknown";
      }
      for (const identifier of member.accountIdentifiers) {
        const address = identifier.identifier?.toLowerCase() ?? "";
        if (!/^0x[0-9a-f]{40}$/.test(address)) return "unknown";
        present.add(address);
      }
    }
  } catch {
    return "unknown";
  }
  return present.has(address) ? "present" : "absent";
}

/**
 * 处理一条 member_revoked 广播：上下文与目标状态校验 → 去重/限速 → sync+members 核实 → 清理并持久化。
 * 返回 outcome；unconfirmed 由调用方决定是否 schedule 进 RevocationRetries。
 */
export async function applyMemberRevoked(
  input: { address: string; conversationId: string; sender: string; requestId: string },
  deps: ApplyRevokedDeps
): Promise<ApplyRevokedResult> {
  const target = input.address.toLowerCase();
  const none = { deniedRequestIds: [] };
  const now = deps.now().getTime();

  // 只有本房 active group 的广播才可能触发核实；DM/其它群到此为止。
  if (!deps.activeGroupId() || input.conversationId !== deps.activeGroupId()) {
    return { outcome: "ignored_context", ...none };
  }
  if (deps.revoked.has(target, input.conversationId)) return { outcome: "already_revoked", ...none };
  const hasRevocableState = deps.policy.allow[target] !== undefined
    || deps.policy.rules?.actors?.[target] !== undefined
    || deps.allowedSenders.includes(target)
    || deps.queue?.hasRevocableWork(target, input.conversationId) === true;
  if (!hasRevocableState) return { outcome: "no_revocable_state", ...none };
  if (!deps.fromRetry && !deps.dedup.seenOnce(input.requestId)) return { outcome: "duplicate", ...none };
  if (!deps.dedup.verifyAllowed(target, now, deps.fromRetry === true)) {
    return { outcome: "rate_limited", ...none };
  }
  deps.dedup.markVerify(target, now);

  const verdict = await verifyAbsent(target, input.conversationId, deps);
  if (verdict === "present") return { outcome: "unconfirmed", subjectPresent: true, ...none };
  if (verdict !== "absent") {
    return { outcome: verdict === "ignored_context" ? "ignored_context" : "unconfirmed", ...none };
  }

  // 两个调用都在首个 await 前置内存状态：撤销名单和未执行审批立即生效，再并行落盘。
  const revokedPersist = deps.revoked.add({
    address: target,
    at: deps.now().toISOString(),
    sender: input.sender.toLowerCase(),
    conversation_id: input.conversationId,
  });
  const deniedPersist = deps.queue
    ? deps.queue.denyAllPendingForRequester(target, input.conversationId, deps.now())
    : Promise.resolve<string[]>([]);
  const [, deniedRequestIds] = await Promise.all([revokedPersist, deniedPersist]);
  return { outcome: "applied", deniedRequestIds };
}

export interface RevocationProbeInput {
  address: string;
  conversationId: string;
  sender: string;
  requestId: string;
}

export interface RevocationReconcilerDeps {
  retries: RevocationRetries;
  probe: (input: RevocationProbeInput) => Promise<ApplyRevokedResult>;
  onApplied?: (pending: PendingRevocation) => Promise<void>;
  onStalled?: (pending: PendingRevocation) => Promise<void>;
  onError: (error: unknown) => void;
}

/** 持久化撤销提示的后台 single-flight 对账；不参与 DM 或全局发送者门禁。 */
export class RevocationReconciler {
  private readonly deps: RevocationReconcilerDeps;
  private inFlight: Promise<void> | null = null;

  constructor(deps: RevocationReconcilerDeps) {
    this.deps = deps;
  }

  start(): void {
    void this.reconcile().catch(this.deps.onError);
  }

  reconcile(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(): Promise<void> {
    await this.deps.retries.idle();
    const now = Date.now();
    for (const pending of this.deps.retries.due(now)) {
      let result: ApplyRevokedResult;
      try {
        result = await this.deps.probe(pending);
      } catch (error) {
        this.deps.onError(error);
        result = { outcome: "unconfirmed", deniedRequestIds: [] };
      }
      const settled = result.subjectPresent === true
        || result.outcome === "applied"
        || result.outcome === "already_revoked"
        || result.outcome === "ignored_context"
        || result.outcome === "no_revocable_state";
      if (settled) {
        await this.deps.retries.done(pending);
        if (result.outcome === "applied") await this.deps.onApplied?.(pending);
        continue;
      }
      if (result.outcome === "rate_limited") {
        await this.deps.retries.defer(pending, now);
        continue;
      }
      if (!(await this.deps.retries.fail(pending, now))) await this.deps.onStalled?.(pending);
    }
  }
}
