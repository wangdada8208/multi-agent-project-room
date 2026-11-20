import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  isAccountId,
  readAccountCredentials,
  type AccountStore,
} from "./accounts.ts";
import { MAX_PARAM_BYTES, normalizeScope, paramsShapeOk } from "./canonical.ts";
import { validateActionParams } from "./connectors/actionSchemas.ts";
import { consentTtl, type ConsentQueue } from "./consentQueue.ts";
import { hashPayload } from "./grant.ts";
import type { InboxEntry } from "./inbox.ts";
import { buildLedgerEntry, type LedgerEntry } from "./ledger.ts";
import type { Policy } from "./policy.ts";
import { decide, effectiveRules } from "./rulesEngine.ts";
import { writeJsonSecure } from "./secureFile.ts";

/**
 * Gmail 增量事件触发器（WP7）：
 *   messages.list/history.list 拉新事件 → (account_id, external_event_id) 去重
 *   → decide() 裁决 → actionSchemas 参数校验 → ConsentQueue.add(source:"trigger")
 *   → allow 时走与人工批准完全相同的 approveConsent 执行路径。
 * 触发器永远不产生隐式 allow：默认 ask，硬禁区与 house cannot 一律拒绝，
 * 也不绕过审批队列直接执行。
 */

export const TRIGGER_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;

export interface TriggerConfig {
  id: string;
  enabled: boolean;
  /** 轮询与执行都绑定到这一个账户；渲染后 params.account 被强制覆盖为它。 */
  account_id: string;
  /** Gmail 搜索 query（messages.list?q=），可为空串。 */
  query: string;
  action: string;
  action_params_template: Record<string, unknown>;
  max_per_hour: number;
  poll_interval_ms: number;
}

export interface TriggerState extends TriggerConfig {
  /** 有界去重游标：元素为 `${account_id}:${external_event_id}`，最多保留 MAX_SEEN_IDS。 */
  seen_ids: string[];
  /** Gmail history.list 游标；messages.list 首轮从 messages.get 取回。 */
  last_history_id?: string;
  last_poll_at?: string;
  /** 小时限频窗口起点与窗口内已入队数。 */
  window_start?: string;
  window_count?: number;
  consecutive_failures?: number;
  /** 失败退避/正常间隔后的下一次允许轮询时间。 */
  next_poll_at?: string;
}

const MAX_SEEN_IDS = 500;
const MAX_PER_HOUR_LIMIT = 1000;
const MIN_POLL_MS = 5_000;
const MAX_POLL_MS = 3_600_000;
const MAX_HISTORY_PAGES = 3;
const MAX_BACKOFF_MS = 3_600_000;
const HOUR_MS = 3_600_000;
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const FETCH_TIMEOUT_MS = 15_000;

export type TriggerValidation =
  | { ok: true; config: TriggerConfig }
  | { ok: false; reason: string };

function fail(reason: string): TriggerValidation {
  return { ok: false, reason };
}

/** 触发器配置形状校验（不查账户存在性与规则——那属于 checkTriggerCreation）。 */
export function validateTriggerConfig(raw: any): TriggerValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("not_object");
  if (typeof raw.id !== "string" || !TRIGGER_ID_RE.test(raw.id)) return fail("invalid_id");
  if (typeof raw.enabled !== "boolean") return fail("invalid_enabled");
  if (!isAccountId(raw.account_id)) return fail("invalid_account_id");
  if (typeof raw.query !== "string" || raw.query.length > 200 || /[\x00-\x1F\x7F]/.test(raw.query)) {
    return fail("invalid_query");
  }
  if (typeof raw.action !== "string") return fail("invalid_action");
  const action = normalizeScope(raw.action);
  const template = raw.action_params_template;
  if (!template || typeof template !== "object" || Array.isArray(template)) {
    return fail("invalid_template");
  }
  if (JSON.stringify(template).length > MAX_PARAM_BYTES || !paramsShapeOk(template)) {
    return fail("invalid_template");
  }
  const maxPerHour = raw.max_per_hour;
  if (!Number.isInteger(maxPerHour) || maxPerHour < 1 || maxPerHour > MAX_PER_HOUR_LIMIT) {
    return fail("invalid_max_per_hour");
  }
  const pollMs = raw.poll_interval_ms;
  if (!Number.isInteger(pollMs) || pollMs < MIN_POLL_MS || pollMs > MAX_POLL_MS) {
    return fail("invalid_poll_interval");
  }
  return {
    ok: true,
    config: {
      id: raw.id,
      enabled: raw.enabled,
      account_id: raw.account_id,
      query: raw.query,
      action,
      action_params_template: template as Record<string, unknown>,
      max_per_hour: maxPerHour,
      poll_interval_ms: pollMs,
    },
  };
}

const TEMPLATE_SLOTS: Record<string, (ctx: { external_event_id: string; trigger_id: string; account_id: string }) => string> = {
  "{{external_event_id}}": (c) => c.external_event_id,
  "{{trigger_id}}": (c) => c.trigger_id,
  "{{account_id}}": (c) => c.account_id,
};

function renderTemplate(
  value: unknown,
  ctx: { external_event_id: string; trigger_id: string; account_id: string },
  depth = 0
): unknown {
  if (depth > 8) return value;
  if (typeof value === "string") {
    let out = value;
    for (const [slot, resolve] of Object.entries(TEMPLATE_SLOTS)) {
      if (out.includes(slot)) out = out.split(slot).join(resolve(ctx));
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => renderTemplate(v, ctx, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = renderTemplate(v, ctx, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * 事件 → 动作参数：模板占位符渲染后，params.account 被强制写回触发器自己的
 * account_id——模板不能替别的账户发起绑定请求（账户路由不被模板劫持）。
 */
export function renderTriggerParams(
  config: TriggerConfig,
  externalEventId: string
): Record<string, unknown> {
  const rendered = renderTemplate(config.action_params_template, {
    external_event_id: externalEventId,
    trigger_id: config.id,
    account_id: config.account_id,
  }) as Record<string, unknown>;
  rendered.account = config.account_id;
  return rendered;
}

/**
 * 创建/入库前的语义检查：账户存在且是 gmail、渲染模板过动作 schema、
 * 动作 scope 不在硬禁区或 cannot 规则里。三项都过才允许登记。
 */
export function checkTriggerCreation(
  config: TriggerConfig,
  deps: { accounts?: AccountStore; policy?: Policy; selfAddress?: string }
): { ok: true } | { ok: false; reason: string } {
  if (deps.accounts) {
    const account = deps.accounts.get(config.account_id);
    if (!account) return { ok: false, reason: "unknown_account" };
    if (account.service !== "gmail") return { ok: false, reason: "account_not_gmail" };
  }
  // 先裁决再探模板：硬禁区/cannot 的动作不值得再看参数形状。
  if (deps.policy && deps.selfAddress) {
    const hit = decide(effectiveRules(deps.policy), deps.policy, {
      actor: deps.selfAddress,
      kind: "action",
      scope: config.action,
    });
    if (hit.decision === "cannot") return { ok: false, reason: `cannot:${hit.rule}` };
  }
  const rendered = renderTriggerParams(config, "event-probe");
  const check = validateActionParams(config.action, rendered);
  if (!check.ok) return { ok: false, reason: `invalid_template:${check.reason}` };
  return { ok: true };
}

function normalizeState(raw: any): TriggerState | null {
  const v = validateTriggerConfig(raw);
  if (!v.ok) return null;
  const seen = Array.isArray(raw.seen_ids)
    ? raw.seen_ids.filter((s: any) => typeof s === "string").slice(-MAX_SEEN_IDS)
    : [];
  return {
    ...v.config,
    seen_ids: seen,
    last_history_id: typeof raw.last_history_id === "string" ? raw.last_history_id : undefined,
    last_poll_at: typeof raw.last_poll_at === "string" ? raw.last_poll_at : undefined,
    window_start: typeof raw.window_start === "string" ? raw.window_start : undefined,
    window_count: Number.isInteger(raw.window_count) ? raw.window_count : 0,
    consecutive_failures: Number.isInteger(raw.consecutive_failures) ? raw.consecutive_failures : 0,
    next_poll_at: typeof raw.next_poll_at === "string" ? raw.next_poll_at : undefined,
  };
}

export class TriggerStore {
  private items: TriggerState[] = [];
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
      throw new Error("Triggers store is corrupt; refusing to load");
    }
    if (!Array.isArray(raw)) throw new Error("Triggers store is corrupt; refusing to load");
    const items = raw.flatMap((t) => {
      const n = normalizeState(t);
      return n ? [n] : [];
    });
    if (items.length !== raw.length) throw new Error("Triggers store is corrupt; refusing to load");
    this.items = items;
  }

  list(): TriggerState[] {
    return this.items.map((t) => ({ ...t, seen_ids: [...t.seen_ids], action_params_template: structuredClone(t.action_params_template) }));
  }

  get(id: string): TriggerState | null {
    const found = this.items.find((t) => t.id === id);
    return found
      ? { ...found, seen_ids: [...found.seen_ids], action_params_template: structuredClone(found.action_params_template) }
      : null;
  }

  async add(config: TriggerConfig): Promise<"added" | "duplicate" | "invalid"> {
    const v = validateTriggerConfig(config);
    if (!v.ok) return "invalid";
    if (this.items.some((t) => t.id === v.config.id)) return "duplicate";
    this.items.push({ ...v.config, seen_ids: [] });
    await writeJsonSecure(this.file, this.items);
    return "added";
  }

  async remove(id: string): Promise<boolean> {
    const idx = this.items.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    this.items.splice(idx, 1);
    await writeJsonSecure(this.file, this.items);
    return true;
  }

  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const found = this.items.find((t) => t.id === id);
    if (!found) return false;
    found.enabled = enabled;
    await writeJsonSecure(this.file, this.items);
    return true;
  }

  /** 游标/限频/退避字段的整体更新（引擎每轮结束后调用）。 */
  async updateState(id: string, patch: Partial<TriggerState>): Promise<void> {
    const found = this.items.find((t) => t.id === id);
    if (!found) return;
    Object.assign(found, patch);
    await writeJsonSecure(this.file, this.items);
  }

  anyEnabled(): boolean {
    return this.items.some((t) => t.enabled);
  }
}

// ── Gmail 轮询 ──────────────────────────────────────────────────

class HistoryStaleError extends Error {}

interface GmailListResult {
  ids: string[];
  historyId?: string;
}

async function gmailGet(fetchImpl: typeof fetch, url: string, token: string): Promise<any> {
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    if (res.status === 404) throw new HistoryStaleError("history cursor stale");
    throw new Error(`gmail_${res.status}`);
  }
  return res.json();
}

/** history.list 增量：startHistoryId 过期（404）由调用方回退到 messages.list。 */
async function listNewFromHistory(
  fetchImpl: typeof fetch,
  token: string,
  startHistoryId: string
): Promise<GmailListResult> {
  const ids: string[] = [];
  let historyId: string | undefined;
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    const url =
      `${GMAIL_BASE}/history?startHistoryId=${encodeURIComponent(startHistoryId)}` +
      `&historyTypes=messageAdded&maxResults=100` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const data = await gmailGet(fetchImpl, url, token);
    historyId = typeof data?.historyId === "string" ? data.historyId : historyId;
    for (const h of data?.history ?? []) {
      for (const added of h?.messagesAdded ?? []) {
        const id = added?.message?.id;
        if (typeof id === "string" && id.length > 0 && id.length <= 128) ids.push(id);
      }
    }
    pageToken = typeof data?.nextPageToken === "string" ? data.nextPageToken : undefined;
    if (!pageToken) break;
  }
  return { ids, historyId };
}

/** messages.list 首轮/回退：q 过滤后的最新消息 id，再取一条拿 historyId 当新游标。 */
async function listNewFromMessages(
  fetchImpl: typeof fetch,
  token: string,
  query: string
): Promise<GmailListResult> {
  const url = `${GMAIL_BASE}/messages?q=${encodeURIComponent(query)}&maxResults=50`;
  const data = await gmailGet(fetchImpl, url, token);
  const ids: string[] = (data?.messages ?? [])
    .map((m: any) => m?.id)
    .filter((id: any) => typeof id === "string" && id.length > 0 && id.length <= 128);
  let historyId: string | undefined = typeof data?.historyId === "string" ? data.historyId : undefined;
  if (!historyId && ids.length > 0) {
    try {
      const meta = await gmailGet(
        fetchImpl,
        `${GMAIL_BASE}/messages/${encodeURIComponent(ids[0])}?format=metadata`,
        token
      );
      if (typeof meta?.historyId === "string") historyId = meta.historyId;
    } catch {
      // 拿不到游标不致命——去重集合仍兜底；下一轮继续 messages.list。
    }
  }
  return { ids, historyId };
}

// ── 引擎 ────────────────────────────────────────────────────────

export interface TriggerEngineDeps {
  store: TriggerStore;
  accounts: AccountStore;
  credDir: string;
  selfAddress: string;
  policy: Policy;
  queue: ConsentQueue;
  appendLedger: (entry: LedgerEntry) => Promise<void>;
  /** 与人工批准完全相同的执行入口（approveConsent）。 */
  approve: (requestId: string) => Promise<{ ok: boolean; reason?: string }>;
  /** 触发执行落地后把 ActionResultRecord 写进本机 inbox（无群回执路径）。 */
  appendInbox?: (entry: InboxEntry) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** 巡检 tick 间隔；poll_interval_ms 控制的是每个触发器自己的节奏。 */
  tickMs?: number;
}

export interface PollSummary {
  polled: number;
  candidates: number;
  enqueued: number;
  autoApproved: number;
  denied: number;
  rateLimited: number;
  failures: number;
}

export class TriggerEngine {
  private readonly deps: TriggerEngineDeps;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly tickMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(deps: TriggerEngineDeps) {
    this.deps = deps;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => new Date());
    this.tickMs = deps.tickMs ?? 15_000;
  }

  /** 只有存在启用中的触发器才值得起定时器；重复调用幂等。 */
  start(): void {
    if (this.timer || !this.deps.store.anyEnabled()) return;
    this.timer = setInterval(() => {
      this.pollDue().catch((err) =>
        console.error("Trigger poll error:", err instanceof Error ? err.message : "unknown")
      );
    }, this.tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 配置变更后调用：有启用的就确保巡检在跑，全禁用就停表。 */
  refresh(): void {
    if (this.deps.store.anyEnabled()) this.start();
    else this.stop();
  }

  async pollDue(): Promise<PollSummary> {
    const summary: PollSummary = {
      polled: 0,
      candidates: 0,
      enqueued: 0,
      autoApproved: 0,
      denied: 0,
      rateLimited: 0,
      failures: 0,
    };
    if (this.running) return summary; // 上一轮没跑完，不并发重入
    this.running = true;
    try {
      const now = this.now();
      for (const state of this.deps.store.list()) {
        if (!state.enabled) continue;
        if (state.next_poll_at && Date.parse(state.next_poll_at) > now.getTime()) continue;
        summary.polled += 1;
        try {
          await this.pollOne(state, now, summary);
        } catch (err) {
          summary.failures += 1;
          await this.recordFailure(state, err);
        }
      }
    } finally {
      this.running = false;
    }
    return summary;
  }

  private async recordFailure(state: TriggerState, err: unknown): Promise<void> {
    const now = this.now();
    const failures = (state.consecutive_failures ?? 0) + 1;
    const backoff = Math.min(state.poll_interval_ms * 2 ** Math.min(failures - 1, 6), MAX_BACKOFF_MS);
    const reason =
      err instanceof HistoryStaleError
        ? "history_stale"
        : err instanceof Error
          ? err.message.slice(0, 64)
          : "unknown";
    await this.deps.store.updateState(state.id, {
      consecutive_failures: failures,
      last_poll_at: now.toISOString(),
      next_poll_at: new Date(now.getTime() + backoff).toISOString(),
    });
    await this.deps.appendLedger(
      buildLedgerEntry({
        now,
        kind: "send_failed",
        peer: state.account_id,
        scope: state.action,
        reason: `trigger_poll_failed:${reason}`,
      })
    ).catch(() => {});
    // 游标陈旧不是故障——清掉 last_history_id，下轮回退到 messages.list 全量列。
    if (err instanceof HistoryStaleError) {
      await this.deps.store.updateState(state.id, { last_history_id: undefined });
    }
  }

  private async pollOne(state: TriggerState, now: Date, summary: PollSummary): Promise<void> {
    const account = this.deps.accounts.get(state.account_id);
    if (!account) throw new Error("unknown_account");
    // 凭据路径校验（含符号链接/0600）在 readAccountCredentials 内部完成。
    const creds = await readAccountCredentials(
      this.deps.credDir,
      account.cred_path
    ).catch(() => null);
    const token = typeof creds?.access_token === "string" ? creds.access_token : null;
    if (!token) throw new Error("auth_required");

    // L6：新建触发器（从未轮过且无游标）首轮只建基线——把当前收件箱列一遍，
    // 全部标已见并拿 historyId 当游标；轮询前已存在的历史邮件绝不触发动作。
    // 已有 last_history_id 的触发器即使没轮过也走增量路径：游标本身就编码了基线。
    if (!state.last_poll_at && !state.last_history_id) {
      const baseline = await listNewFromMessages(this.fetchImpl, token, state.query);
      const seeded = new Set(state.seen_ids);
      for (const id of baseline.ids) seeded.add(`${state.account_id}:${id}`);
      await this.deps.store.updateState(state.id, {
        seen_ids: [...seeded].slice(-MAX_SEEN_IDS),
        last_history_id: baseline.historyId ?? state.last_history_id,
        consecutive_failures: 0,
        last_poll_at: now.toISOString(),
        next_poll_at: new Date(now.getTime() + state.poll_interval_ms).toISOString(),
      });
      return;
    }

    let listed: GmailListResult;
    if (state.last_history_id) {
      listed = await listNewFromHistory(this.fetchImpl, token, state.last_history_id);
    } else {
      listed = await listNewFromMessages(this.fetchImpl, token, state.query);
    }
    const ids = [...new Set(listed.ids)];
    const seen = new Set(state.seen_ids);

    let windowStart = state.window_start ? Date.parse(state.window_start) : NaN;
    let windowCount = state.window_count ?? 0;
    if (!Number.isFinite(windowStart) || now.getTime() - windowStart >= HOUR_MS) {
      windowStart = now.getTime();
      windowCount = 0;
    }

    const seenIds = [...state.seen_ids];
    let exhaustedBudget = false;
    for (const eventId of ids) {
      const dedupKey = `${state.account_id}:${eventId}`;
      if (seen.has(dedupKey)) continue;
      summary.candidates += 1;
      if (windowCount >= state.max_per_hour) {
        // 限频：不标已见——下个窗口重新评估这些事件。
        exhaustedBudget = true;
        summary.rateLimited += 1;
        break;
      }
      const outcome = await this.enqueueCandidate(state, eventId, now, summary);
      if (outcome === "queued" || outcome === "denied") {
        seen.add(dedupKey);
        seenIds.push(dedupKey);
      }
      if (outcome === "queued") {
        windowCount += 1;
      } else if (outcome === "full") {
        // 审批队列满：保留未处理事件到下轮，不丢不重复。
        break;
      }
    }

    await this.deps.store.updateState(state.id, {
      seen_ids: seenIds.slice(-MAX_SEEN_IDS),
      // 限频截断时不推进 history 游标——剩余事件下一轮还会被列出。
      ...(exhaustedBudget ? {} : { last_history_id: listed.historyId ?? state.last_history_id }),
      window_start: new Date(windowStart).toISOString(),
      window_count: windowCount,
      consecutive_failures: 0,
      last_poll_at: now.toISOString(),
      next_poll_at: new Date(now.getTime() + state.poll_interval_ms).toISOString(),
    });
  }

  /**
   * 单个事件 → 审批队列。裁决/参数校验/入队三段任何一步不过都如实记账，
   * 事件标已见（不反复骚扰审批队列）；allow 立刻走批准执行路径。
   */
  private async enqueueCandidate(
    state: TriggerState,
    eventId: string,
    now: Date,
    summary: PollSummary
  ): Promise<"queued" | "denied" | "full"> {
    const hit = decide(effectiveRules(this.deps.policy), this.deps.policy, {
      actor: this.deps.selfAddress,
      kind: "action",
      scope: state.action,
    });
    const ledgerBase = {
      now,
      requestId: `trig-${state.id}-${eventId}`.slice(0, 160),
      peer: this.deps.selfAddress,
      scope: state.action,
    };
    if (hit.decision === "cannot") {
      summary.denied += 1;
      await this.deps.appendLedger(
        buildLedgerEntry({ ...ledgerBase, kind: "request_denied", reason: `trigger:${hit.rule}` })
      );
      return "denied";
    }
    const params = renderTriggerParams(state, eventId);
    const check = validateActionParams(state.action, params);
    if (!check.ok) {
      summary.denied += 1;
      await this.deps.appendLedger(
        buildLedgerEntry({
          ...ledgerBase,
          kind: "request_denied",
          reason: `trigger_invalid_template:${check.reason}`,
        })
      );
      return "denied";
    }
    const added = await this.deps.queue.add({
      request_id: ledgerBase.requestId,
      requester: this.deps.selfAddress,
      conversation_id: "",
      scope: state.action,
      purpose: `触发器 ${state.id} 命中外部事件 ${eventId}`,
      constraints: { date_from: "", date_to: "" },
      created_at: now.toISOString(),
      kind: "action",
      params,
      params_hash: hashPayload(params),
      rule_hit: hit.rule,
      source: "trigger",
      account_id: state.account_id,
      expires_at: new Date(now.getTime() + consentTtl("action")).toISOString(),
    });
    if (added === "duplicate") return "denied"; // 已在队列——按已见收口
    if (added === "full") return "full";
    summary.enqueued += 1;
    await this.deps.appendLedger(
      buildLedgerEntry({ ...ledgerBase, kind: "action_queued", reason: `trigger:${hit.rule}` })
    );

    if (hit.decision === "allow") {
      // 与群内 action_request 的 autoApprove 完全同一条执行路径，无特权。
      const res = await this.deps.approve(ledgerBase.requestId);
      if (res.ok) {
        summary.autoApproved += 1;
        await this.deps.appendLedger(
          buildLedgerEntry({ ...ledgerBase, kind: "auto_approved", reason: `trigger:${hit.rule}` })
        );
        const item = this.deps.queue.get(ledgerBase.requestId);
        if (item && this.deps.appendInbox) {
          await this.deps.appendInbox({
            received_at: now.toISOString(),
            from: this.deps.selfAddress,
            request_id: item.request_id,
            grant_id: `trigger:${state.id}:${eventId}`,
            payload: {
              kind: "action_result",
              status: item.result_status ?? "uncertain",
              receipt: item.result_receipt,
              summary: `trigger:${state.id} ${item.result_summary ?? item.status}`,
            },
          }).catch(() => {});
        }
      } else {
        await this.deps.appendLedger(
          buildLedgerEntry({
            ...ledgerBase,
            kind: "auto_approve_failed",
            reason: res.reason ?? "unknown",
          })
        );
      }
    }
    return "queued";
  }
}

/** POST /api/triggers 用的组合校验入口。 */
export function validateAndCheckTrigger(
  raw: any,
  deps: { accounts?: AccountStore; policy?: Policy; selfAddress?: string }
): { ok: true; config: TriggerConfig } | { ok: false; reason: string } {
  const v = validateTriggerConfig(raw);
  if (!v.ok) return v;
  const check = checkTriggerCreation(v.config, deps);
  if (!check.ok) return check;
  return { ok: true, config: v.config };
}
