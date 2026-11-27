import { apiFetch } from "./api";
import type { ActivityItem, CheckpointView } from "../hubContracts.generated";
import { localErrorMessage } from "./localHelper";
import { OWNER_HEADER, ownerConsoleUrl } from "./ownerConsole";

export interface HubActivityFeed {
  room_id: string;
  items: ActivityItem[];
  checkpoints: CheckpointView[];
  count: number;
}

export interface LocalLedgerEntry {
  at: string;
  kind: string;
  request_id: string | null;
  peer: string | null;
  sender?: string | null;
  scope: string | null;
  reason: string | null;
  payload_hash: string | null;
  seq?: number;
  prev_hash?: string;
  entry_hash?: string;
  activity_event_id?: string;
  activity_status?: string;
}

export interface LedgerIntegrityIssue {
  code: string;
  line: number;
  detail?: string;
}

export interface LedgerVerifyResult {
  ok: boolean;
  total_lines: number;
  chained_entries: number;
  legacy_unverified_entries: number;
  malformed_lines: number;
  head: { seq: number; entry_hash: string } | null;
  issues: LedgerIntegrityIssue[];
}

export interface LocalActivityResponse {
  ok: boolean;
  total: number;
  entries: LocalLedgerEntry[];
  integrity: LedgerVerifyResult;
}

export type LocalActivityResult =
  | { available: true; port: number; seatId?: string; data: LocalActivityResponse }
  | { available: false; port: number; seatId?: string; error: string };

export interface ActivityFilterParams {
  actor?: string;
  app?: string;
  kind?: string;
  status?: string;
  since?: string;
  until?: string;
  limit?: number;
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    const text = String(v).trim();
    if (!text) continue;
    sp.set(k, text);
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

/** GET /api/v1/rooms/{room_id}/activity：读取 Hub 合并的安全元数据活动流与检查点。 */
export async function fetchHubActivity(
  roomId: string,
  filters: ActivityFilterParams = {},
  fetchImpl: typeof apiFetch = apiFetch,
): Promise<HubActivityFeed> {
  const qs = buildQuery({
    actor: filters.actor,
    app: filters.app,
    kind: filters.kind,
    status: filters.status,
    since: filters.since,
    until: filters.until,
    limit: filters.limit,
  });
  const res = await fetchImpl(`/api/v1/rooms/${encodeURIComponent(roomId)}/activity${qs}`);
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* ignore non-JSON error body */
    }
    throw new Error(localErrorMessage(body, `读取房间活动流失败（HTTP ${res.status}）`));
  }
  return (await res.json()) as HubActivityFeed;
}

/**
 * GET http://127.0.0.1:{port}/api/activity：读取本机成员进程账本与防篡改校验结果。
 * 远程浏览器或未运行控制台时不抛异常，返回 available=false。
 */
export async function fetchLocalActivity(
  port: number,
  filters: ActivityFilterParams = {},
  options: { fetchImpl?: typeof fetch; seatId?: string } = {},
): Promise<LocalActivityResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  // 本机 /api/activity 按 ledger 字段过滤，不传 app（合并层会按 app 再滤）。
  const qs = buildQuery({
    actor: filters.actor,
    kind: filters.kind,
    status: filters.status,
    since: filters.since,
    until: filters.until,
    limit: filters.limit,
  });
  try {
    const res = await fetchImpl(ownerConsoleUrl(port, `/api/activity${qs}`), {
      method: "GET",
      headers: { [OWNER_HEADER]: "1" },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        /* ignore */
      }
      return {
        available: false,
        port,
        seatId: options.seatId,
        error: localErrorMessage(body, `本机控制台拒绝或不可用（HTTP ${res.status}）`),
      };
    }
    const data = (await res.json()) as LocalActivityResponse;
    return { available: true, port, seatId: options.seatId, data };
  } catch (err) {
    const error =
      err instanceof Error && err.name === "TimeoutError"
        ? "本机活动接口响应超时"
        : "无法连接本机成员账本（若助手运行在其他电脑，仅显示 Hub 安全摘要）";
    return { available: false, port, seatId: options.seatId, error };
  }
}

const LOCAL_STATUS_BY_KIND: Record<string, string> = {
  sender_dropped: "denied",
  request_sent: "ok",
  request_denied: "denied",
  request_queued: "pending",
  consent_approved: "ok",
  consent_denied: "denied",
  consent_expired: "expired",
  send_failed: "failed",
  disclosure_stored: "ok",
  disclosure_rejected: "denied",
  denial_received: "ok",
  pending_received: "pending",
  task_sent: "ok",
  verdict_sent: "ok",
  task_escalated: "pending",
  member_revoked_received: "ok",
  auto_approved: "ok",
  auto_approve_failed: "failed",
  action_queued: "pending",
  action_finished: "ok",
  action_tampered: "failed",
  action_result_received: "ok",
  action_result_rejected: "denied",
  receipt_resent: "ok",
  recovered_uncertain: "uncertain",
  unmatched_response: "uncertain",
};

export function inferAppFromScope(scope: string | null | undefined): string | null {
  if (!scope) return null;
  const s = scope.toLowerCase();
  if (s.startsWith("gmail.") || s.startsWith("email.")) return "gmail";
  if (s.includes("calendar")) return "calendar";
  if (s === "task.run" || s.startsWith("xmtp")) return "xmtp";
  return null;
}

export interface MergedActivityEntry {
  id: string;
  source: "local_ledger" | "activity" | "task_event" | "approval" | string;
  actor_kind: string | null;
  actor_id: string | null;
  kind: string;
  app: string | null;
  status: string | null;
  subject_id: string | null;
  stream_seq: number | null;
  created_at: string | null;
  scope?: string | null;
  reason?: string | null;
  title?: string | null;
}

export interface MergedActivityIntegrity {
  checkedPorts: number;
  unreachablePorts: number;
  ok: boolean;
  issues: Array<LedgerIntegrityIssue & { port: number }>;
  legacyUnverifiedCount: number;
  chainedCount: number;
  hubCheckpoints: CheckpointView[];
}

export interface MergedActivityResult {
  items: MergedActivityEntry[];
  integrity: MergedActivityIntegrity;
}

/**
 * 合并 Hub 安全元数据流（m2 + 任务 + 审批）与本机成员账本。
 * - 本机账本用上传时的活动元数据 ID 匹配 Hub 事件，匹配时保留本机摘要。
 * - 汇总本地账本校验结果，任一链损坏/截断/缺口直接拉红报警。
 */
export function mergeActivityFeeds(
  hubFeed: HubActivityFeed | null,
  localResults: LocalActivityResult[],
  options: { appFilter?: string } = {},
): MergedActivityResult {
  const items: MergedActivityEntry[] = [];
  const seenLocalEventIds = new Set<string>();
  const appFilter = options.appFilter?.trim().toLowerCase() || "";

  let checkedPorts = 0;
  let unreachablePorts = 0;
  let allLocalOk = true;
  const issues: Array<LedgerIntegrityIssue & { port: number }> = [];
  let legacyUnverifiedCount = 0;
  let chainedCount = 0;

  for (const res of localResults) {
    if (!res.available) {
      unreachablePorts += 1;
      continue;
    }
    checkedPorts += 1;
    const integrity = res.data.integrity;
    if (!integrity.ok) allLocalOk = false;
    legacyUnverifiedCount += integrity.legacy_unverified_entries ?? 0;
    chainedCount += integrity.chained_entries ?? 0;
    for (const issue of integrity.issues ?? []) {
      issues.push({ ...issue, port: res.port });
    }

    for (let idx = 0; idx < res.data.entries.length; idx += 1) {
      const entry = res.data.entries[idx];
      const app = inferAppFromScope(entry.scope);
      if (appFilter && app !== appFilter) continue;
      const status = entry.activity_status ?? LOCAL_STATUS_BY_KIND[entry.kind] ?? null;
      if (entry.activity_event_id) seenLocalEventIds.add(`evt:${entry.activity_event_id}`);
      items.push({
        id: `local-${res.port}-${entry.seq ?? idx}-${entry.at}`,
        source: "local_ledger",
        actor_kind: "agent",
        actor_id: entry.peer ?? entry.sender ?? null,
        kind: entry.kind,
        app,
        status,
        subject_id: entry.request_id ?? null,
        stream_seq: entry.seq ?? null,
        created_at: entry.at,
        scope: entry.scope,
        reason: entry.reason,
      });
    }
  }

  for (const hubItem of hubFeed?.items ?? []) {
    if (hubItem.source === "activity" && seenLocalEventIds.has(hubItem.id)) continue;
    const resolvedApp = hubItem.app ?? (hubItem.source === "task_event" || hubItem.source === "approval" ? "hub" : null);
    if (appFilter && (resolvedApp ?? "").toLowerCase() !== appFilter) continue;
    items.push({
      id: `${hubItem.source}-${hubItem.id}`,
      source: hubItem.source,
      actor_kind: hubItem.actor_kind,
      actor_id: hubItem.actor_id,
      kind: hubItem.kind,
      app: resolvedApp,
      status: hubItem.status ?? null,
      subject_id: hubItem.subject_id ?? null,
      stream_seq: hubItem.stream_seq ?? null,
      created_at: hubItem.created_at ?? null,
      title: hubItem.title ?? null,
    });
  }

  items.sort((a, b) => {
    const ta = a.created_at ? Date.parse(a.created_at) : 0;
    const tb = b.created_at ? Date.parse(b.created_at) : 0;
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });

  return {
    items,
    integrity: {
      checkedPorts,
      unreachablePorts,
      ok: allLocalOk,
      issues,
      legacyUnverifiedCount,
      chainedCount,
      hubCheckpoints: hubFeed?.checkpoints ?? [],
    },
  };
}
