import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { DateRange } from "./envelope.ts";
import { writeJsonSecure } from "./secureFile.ts";

/**
 * 可判别状态机——每个阶段互斥，非法状态不可到达：
 *   pending          待批（唯一可被 claim 的入口）
 *   approved         已批准、未开始执行（重启不自动重放，由人工/过期处理）
 *   executing        执行中（attempt_at 已落盘；重启看到它 ⇒ 结果不明）
 *   awaiting_receipt 已执行/回执已签名持久化，发送未确认（只重发 outbox，绝不重新执行）
 *   completed        回执已送达（终态）
 *   denied           （终态）
 *   expired          （终态）
 *   uncertain        外部副作用结果不明，需人工对账（终态，绝不自动重放）
 */
export type ConsentStatus =
  | "pending"
  | "approved"
  | "executing"
  | "awaiting_receipt"
  | "completed"
  | "denied"
  | "expired"
  | "uncertain";

/** data=私有数据披露（默认），action=写动作执行。 */
export type ConsentKind = "data" | "action";

export const DATA_CONSENT_TTL_MS = 10 * 60 * 1000;
export const ACTION_CONSENT_TTL_MS = 24 * 60 * 60 * 1000;

export function consentTtl(kind: ConsentKind): number {
  return kind === "action" ? ACTION_CONSENT_TTL_MS : DATA_CONSENT_TTL_MS;
}

const STATUSES: readonly ConsentStatus[] = [
  "pending", "approved", "executing", "awaiting_receipt",
  "completed", "denied", "expired", "uncertain",
];

/** 合法迁移表；terminal 状态无出边。 */
const TRANSITIONS: Record<ConsentStatus, readonly ConsentStatus[]> = {
  pending: ["approved", "denied", "expired"],
  approved: ["executing", "awaiting_receipt", "completed", "pending", "denied", "expired", "uncertain"],
  executing: ["awaiting_receipt", "completed", "uncertain"],
  // 自迁移只为 resend_count 补丁落盘（重发计数），不表示状态前进。
  awaiting_receipt: ["awaiting_receipt", "completed", "uncertain"],
  completed: [],
  denied: [],
  expired: [],
  uncertain: [],
};

export const MAX_QUEUE_ITEMS = 1000;
export const MAX_PENDING_ITEMS = 200;
export const MAX_PENDING_PER_REQUESTER = 50;

export interface PendingConsent {
  request_id: string;
  requester: string;
  conversation_id: string;
  scope: string;
  purpose: string;
  constraints: DateRange;
  created_at: string;
  status: ConsentStatus;
  /** 旧文件无此字段，load 时归一化为 data。 */
  kind: ConsentKind;
  /** action 的执行参数与哈希——只存本机，不外发；批准时按哈希校验未被手改。 */
  params?: Record<string, unknown>;
  params_hash?: string;
  /** 命中规则（如 house:gmail.send=ask），审批卡里展示触发原因。 */
  rule_hit?: string;
  /** 到期时间。旧文件没有此字段，load 时按 created_at+TTL 补齐。 */
  expires_at: string;
  decided_at?: string;
  /** connector.execute 被调用前落盘的执行标记；重启见 executing+attempt_at ⇒ uncertain。 */
  attempt_at?: string;
  /** 已签名待/已发送的回执信封原文（disclosure 或 action_result）。重发只发它，不重建。 */
  outbox?: string;
  outbox_at?: string;
  /** outbox 已重发次数（有界，防无限重发）。 */
  resend_count?: number;
  /** 终态时的外部回执状态。 */
  result_status?: "executed" | "failed" | "uncertain";
  /** 终态时的外部回执 id（如 gmail messageId），审批卡/人工对账用。 */
  result_receipt?: string;
  /** 终态时连接器的一行结果说明（如 sent/auth_required），不含敏感正文。 */
  result_summary?: string;
  /**
   * 来源：envelope=群内请示（默认/旧数据）；trigger=本机触发器发起的候选（WP7）。
   * 旧文件无此字段，load 时归一化为 undefined（等价 envelope）。
   */
  source?: "envelope" | "trigger";
  /** 批准时绑定的外部账户 id（如 gmail 账户），路由到对应凭据；须与 params.account 一致。 */
  account_id?: string;
}

export type AddResult = "added" | "duplicate" | "full";

function copy(item: PendingConsent): PendingConsent {
  return {
    ...item,
    constraints: { ...item.constraints },
    params: item.params ? structuredClone(item.params) : undefined,
  };
}

function normalizeStatus(raw: any, kind: ConsentKind): ConsentStatus | null {
  if (typeof raw !== "string") return "pending";
  if ((STATUSES as string[]).includes(raw)) return raw as ConsentStatus;
  // 状态字段损坏：action 绝不悄悄回到可重放轨道；data 无外部副作用可安全回到待批。
  return kind === "action" ? "uncertain" : "pending";
}

function normalize(raw: any): PendingConsent | null {
  if (!raw || typeof raw !== "object" || typeof raw.request_id !== "string") return null;
  const kind: ConsentKind = raw.kind === "action" ? "action" : "data";
  // 损坏的 created_at 不得让启动崩——落 epoch。
  const createdParsed =
    typeof raw.created_at === "string" ? Date.parse(raw.created_at) : NaN;
  const created = Number.isFinite(createdParsed) ? raw.created_at : new Date(0).toISOString();
  const status = normalizeStatus(raw.status, kind);
  if (status === null) return null;
  const expiresParsed = typeof raw.expires_at === "string" ? Date.parse(raw.expires_at) : NaN;
  return {
    ...raw,
    kind,
    status,
    created_at: created,
    expires_at: Number.isFinite(expiresParsed)
      ? raw.expires_at
      : new Date(Date.parse(created) + consentTtl(kind)).toISOString(),
    source: raw.source === "envelope" || raw.source === "trigger" ? raw.source : undefined,
    account_id:
      typeof raw.account_id === "string" && /^[a-zA-Z0-9._-]{1,64}$/.test(raw.account_id)
        ? raw.account_id
        : undefined,
  };
}

export class ConsentQueue {
  private items: PendingConsent[] = [];
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  async load(): Promise<void> {
    if (!existsSync(this.file)) return;
    let raw: any;
    try {
      raw = JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      throw new Error("Consent queue is corrupt; refusing to load");
    }
    if (!Array.isArray(raw)) throw new Error("Consent queue is corrupt; refusing to load");
    const items = raw.flatMap((i) => {
      const n = normalize(i);
      return n ? [n] : [];
    });
    if (items.length !== raw.length) throw new Error("Consent queue is corrupt; refusing to load");
    this.items = items;
  }

  list(): PendingConsent[] {
    return this.items.map(copy);
  }

  get(requestId: string): PendingConsent | null {
    const found = this.items.find((i) => i.request_id === requestId);
    return found ? copy(found) : null;
  }

  pendingCount(requester?: string): number {
    return this.items.filter(
      (i) => i.status === "pending" && (!requester || i.requester === requester)
    ).length;
  }

  hasRevocableWork(requester: string, conversationId: string): boolean {
    return this.items.some(
      (item) => item.requester === requester && item.conversation_id === conversationId
        && (item.status === "pending" || item.status === "approved"
          || item.status === "executing" || item.status === "awaiting_receipt")
    );
  }

  async add(
    item: Omit<PendingConsent, "status" | "kind" | "expires_at"> & { kind?: ConsentKind; expires_at?: string }
  ): Promise<AddResult> {
    if (this.items.some((i) => i.request_id === item.request_id)) return "duplicate";
    if (this.pendingCount() >= MAX_PENDING_ITEMS) return "full";
    if (this.pendingCount(item.requester) >= MAX_PENDING_PER_REQUESTER) return "full";
    if (!this.makeRoom()) return "full";
    const kind = item.kind ?? "data";
    this.items.push({
      ...item,
      kind,
      constraints: { ...item.constraints },
      params: item.params ? structuredClone(item.params) : undefined,
      expires_at: item.expires_at ?? new Date(Date.parse(item.created_at) + consentTtl(kind)).toISOString(),
      status: "pending",
    });
    await this.save();
    return "added";
  }

  /**
   * 受限迁移：目标状态必须在 TRANSITIONS 里可达，否则返回 null。
   * 置位发生在首个 await 之前——两个并发调用方不可能同时 claim 同一条 pending。
   */
  async transition(
    requestId: string,
    to: ConsentStatus,
    now: Date = new Date(),
    patch?: Partial<PendingConsent>
  ): Promise<PendingConsent | null> {
    const found = this.items.find((i) => i.request_id === requestId);
    if (!found || !TRANSITIONS[found.status].includes(to)) return null;
    found.status = to;
    found.decided_at = now.toISOString();
    if (patch) {
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete (found as any)[key];
        else (found as any)[key] = value;
      }
    }
    await this.save();
    return copy(found);
  }

  // Status changes synchronously before the first await, so two concurrent
  // callers can never both claim the same pending item.
  // 目标状态按 TRANSITIONS 判定：pending→approved 之外，还允许把
  // approved（已批准未开始）的条目取消成 denied/expired——主人随时能收回尚未执行的决定。
  async claim(
    requestId: string,
    status: "approved" | "denied" | "expired",
    now: Date = new Date()
  ): Promise<PendingConsent | null> {
    const found = this.items.find((i) => i.request_id === requestId);
    if (!found || !TRANSITIONS[found.status].includes(status)) return null;
    found.status = status;
    found.decided_at = now.toISOString();
    await this.save();
    return copy(found);
  }

  // Only release before transport is attempted: an ambiguous send must not be replayed.
  async releaseApproval(requestId: string): Promise<void> {
    const found = this.items.find(i => i.request_id === requestId);
    if (found?.status !== "approved") return;
    found.status = "pending";
    found.decided_at = undefined;
    await this.save();
  }

  dueForExpiry(now: Date): PendingConsent[] {
    return this.items
      .filter(
        (i) =>
          (i.status === "pending" || i.status === "approved") &&
          Date.parse(i.expires_at) <= now.getTime()
      )
      .map(copy);
  }

  /**
   * 已构建回执但发送未确认的条目——重发口。
   * 不变量：outbox 非空 ⟺ 签名回执已落盘但送达未被确认（送达即清 outbox）。
   * 覆盖两种来源：awaiting_receipt（正常执行路径）与 uncertain+outbox
   * （崩溃恢复补签的 uncertain 回执——状态保持终态，只补发不重回执行轨道）。
   */
  pendingReceipts(): PendingConsent[] {
    return this.items
      .filter(
        (i) =>
          typeof i.outbox === "string" &&
          (i.status === "awaiting_receipt" || i.status === "uncertain")
      )
      .map(copy);
  }

  /**
   * uncertain 终态条目的回执补丁口：只允许写回执相关字段，status 永不被改——
   * 崩溃恢复补签的 action_result 靠它落盘 outbox，送达后靠它清 outbox。
   * 非 uncertain 条目一律返回 null，不给任何回到可重放轨道的缝。
   */
  async patchUncertainReceipt(
    requestId: string,
    patch: Partial<
      Pick<
        PendingConsent,
        "outbox" | "outbox_at" | "resend_count" | "result_status" | "result_receipt" | "result_summary"
      >
    >
  ): Promise<PendingConsent | null> {
    const found = this.items.find((i) => i.request_id === requestId);
    if (!found || found.status !== "uncertain") return null;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (found as any)[key];
      else (found as any)[key] = value;
    }
    await this.save();
    return copy(found);
  }

  /** 群撤销只取消同会话尚未开始执行的审批；执行中与待回执项保留真实状态。 */
  async denyAllPendingForRequester(requester: string, conversationId: string, now: Date): Promise<string[]> {
    const ids: string[] = [];
    for (const item of this.items) {
      if ((item.status === "pending" || item.status === "approved")
        && item.requester === requester && item.conversation_id === conversationId) {
        item.status = "denied";
        item.decided_at = now.toISOString();
        ids.push(item.request_id);
      }
    }
    if (ids.length > 0) await this.save();
    return ids;
  }

  /**
   * 重启对账：executing ⇒ uncertain（执行窗口不明，绝不自动重放）；
   * 返回被改的条目，调用方记账本。awaiting_receipt 保持——由重发路径处理。
   */
  async recoverAfterLoad(): Promise<PendingConsent[]> {
    const changed: PendingConsent[] = [];
    for (const item of this.items) {
      if (item.status === "executing") {
        item.status = "uncertain";
        item.decided_at = new Date().toISOString();
        changed.push(copy(item));
      }
    }
    if (changed.length > 0) await this.save();
    return changed;
  }

  private makeRoom(): boolean {
    const TERMINAL: ConsentStatus[] = ["completed", "denied", "expired", "uncertain"];
    while (this.items.length >= MAX_QUEUE_ITEMS) {
      const idx = this.items.findIndex((i) => TERMINAL.includes(i.status));
      if (idx === -1) return false;
      this.items.splice(idx, 1);
    }
    return true;
  }

  private async save(): Promise<void> {
    await writeJsonSecure(this.file, this.items);
  }
}
