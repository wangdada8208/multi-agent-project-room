/**
 * 房主审批控制台（workers/xmtp-member/src/ownerConsole.ts）的本机回环客户端。
 *
 * 边界：
 * - 控制台只监听 127.0.0.1，且只接受回环来源的请求；写操作与动作详情必须带
 *   X-MAPR-Owner: 1。敏感动作参数只在本机流转，绝不经过 Hub。
 * - 从公网托管的网页访问通常会被浏览器/守卫拦下（TypeError 或 403），
 *   面板必须如实降级为「到运行助手的电脑上打开控制台页面」。
 */

import { localErrorMessage } from "./localHelper";

export const OWNER_HEADER = "X-MAPR-Owner";

export function ownerConsoleUrl(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

/** /api/state 里每条 consent 的脱敏视图（无 params/outbox，只有键清单+截断预览）。 */
export interface OwnerConsentSummary {
  request_id: string;
  requester: string;
  conversation_id: string;
  scope: string;
  purpose: string;
  constraints?: Record<string, unknown>;
  created_at: string;
  status:
    | "pending"
    | "approved"
    | "executing"
    | "awaiting_receipt"
    | "completed"
    | "denied"
    | "expired"
    | "uncertain"
    | string;
  kind?: "data" | "action" | string;
  params_hash?: string;
  params_meta?: { keys: string[]; preview: Record<string, string> };
  rule_hit?: string;
  expires_at: string;
  decided_at?: string;
  attempt_at?: string;
  outbox_at?: string;
  resend_count?: number;
  result_status?: "executed" | "failed" | "uncertain" | string;
  result_receipt?: string;
  result_summary?: string;
  /** trigger=本机触发器发起的候选；envelope/缺省=群内请示。 */
  source?: "envelope" | "trigger";
  account_id?: string;
}

/** owner 头详情视图：含完整执行参数（收件人/主题/正文）与待发回执。 */
export interface OwnerConsentDetail extends OwnerConsentSummary {
  params?: Record<string, unknown>;
  outbox?: string;
}

export interface OwnerConsoleState {
  self?: string;
  role?: string;
  consents?: OwnerConsentSummary[];
}

export class OwnerConsoleError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "OwnerConsoleError";
    this.status = status;
  }
}

async function ownerFetch(
  port: number,
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const headers = new Headers(init.headers);
  // 写操作与详情都要求显式 owner 头；GET 带它也无害（同源/开发场景生效）。
  headers.set(OWNER_HEADER, "1");
  try {
    return await fetchImpl(ownerConsoleUrl(port, path), {
      ...init,
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new OwnerConsoleError("本机审批控制台响应超时");
    }
    throw new OwnerConsoleError("无法访问本机审批控制台（控制台仅允许运行助手的电脑访问）");
  }
}

async function readOwnerJson(res: Response, fallback: string): Promise<unknown> {
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch { /* 非 JSON 回包用兜底文案 */ }
    throw new OwnerConsoleError(localErrorMessage(body, fallback), res.status);
  }
  return res.json();
}

/** GET /api/state：脱敏的 consent 列表视图（群视图最小化，键清单+截断预览）。 */
export async function fetchOwnerConsoleState(
  port: number,
  fetchImpl: typeof fetch = fetch,
): Promise<OwnerConsoleState> {
  const res = await ownerFetch(port, "/api/state", { method: "GET" }, fetchImpl);
  return (await readOwnerJson(res, "读取本机审批状态失败")) as OwnerConsoleState;
}

/** GET /api/consents/{id}：owner 头保护的完整动作参数。 */
export async function fetchConsentDetail(
  port: number,
  requestId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OwnerConsentDetail> {
  const res = await ownerFetch(
    port,
    `/api/consents/${encodeURIComponent(requestId)}`,
    { method: "GET" },
    fetchImpl,
  );
  const body = (await readOwnerJson(res, "读取动作详情失败")) as {
    ok?: boolean;
    consent?: OwnerConsentDetail;
  };
  if (!body.consent) throw new OwnerConsoleError("该审批请求不存在");
  return body.consent;
}

export type OwnerDecisionAction = "approve" | "deny" | "resend";

/**
 * POST /api/consents/{id}/{approve|deny|resend}。
 * resend 只重发已落盘的回执信封，绝不重新执行外部动作。
 */
export async function decideOwnerConsent(
  port: number,
  requestId: string,
  action: OwnerDecisionAction,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; reason?: string }> {
  const res = await ownerFetch(
    port,
    `/api/consents/${encodeURIComponent(requestId)}/${action}`,
    { method: "POST" },
    fetchImpl,
  );
  return (await readOwnerJson(res, "操作失败，请重试")) as {
    ok: boolean;
    reason?: string;
  };
}

/** 控制台自管页面的地址（顶层跳转到本机页面不受跨源限制）。 */
export function ownerConsolePageUrl(port: number): string {
  return ownerConsoleUrl(port, "/");
}
