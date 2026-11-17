/**
 * 网站与「本机助手」（用户电脑上的 mapr helper，127.0.0.1:8790）之间的客户端，
 * 以及网站调用 Hub helper 接口的封装。
 *
 * 浏览器限制：
 * - Chrome 会对「公网页面访问 127.0.0.1」弹出本地网络访问权限提示，用户点允许后 fetch 才能成功。
 * - Safari 等浏览器可能直接拦截。因此每个需要本机助手的动作都必须有「打开本机页面」的后备：
 *   顶层跳转到 http://127.0.0.1:8790/#ticket=... 不受这些限制。
 *
 * 权限边界（见 workers/xmtp-member/src/helper/server.ts 的 guardHelperRequest）：
 * 网站来源只能做 public-read、owner-read 与 ticket-write 三类请求；
 * 配对、手动加 Agent、删席位属于 owner-write，一律引导用户去本机页面完成。
 */

export const HELPER_ORIGIN = "http://127.0.0.1:8790";

/** /api/hello 探测超时：本机回环，1.5 秒足够。 */
const PROBE_TIMEOUT_MS = 1500;
/** 普通本机读写超时。 */
const LOCAL_CALL_TIMEOUT_MS = 5000;
/** POST /api/seats 要生成密钥、调 Hub、起进程，放宽到 30 秒。 */
const JOIN_TIMEOUT_MS = 30000;

/** 与 workers/xmtp-member/src/engines/types.ts 的 AgentKind 保持一致。 */
export type AgentKind = "claude-code" | "codex" | "gemini-cli" | "openai-compatible" | "webhook" | "http-model";

export interface HelperHello {
  app: "mapr-helper";
  version: string;
  paired: boolean;
  hub_origin: string | null;
  owner_display_name: string | null;
}

export type HelperProbe =
  | { state: "running"; hello: HelperHello }
  | { state: "not-running" }
  /** 请求被浏览器拦截（权限提示被拒、或浏览器不允许）。无法区分「没装」与「被拦」时也归到这里。 */
  | { state: "blocked" };

export interface LocalAgentView {
  key: string;
  kind: AgentKind;
  displayName: string;
  source: "detected" | "manual";
  version?: string;
  loginState: "likely-ready" | "needs-login" | "unknown";
}

export interface SeatViewLocal {
  seatId: string;
  agentKey: string;
  roomId: string;
  roomName: string;
  xmtpAddress: string;
  consolePort: number;
  status: "starting" | "running" | "crashed" | "stopped" | "revoked";
  lastError: string | null;
}

export interface HubSeatView {
  seat_id: string;
  room_id: string;
  agent_user_id: string;
  agent_display_name: string;
  owner_user_id: string;
  kind: AgentKind;
  /** Hub 下发的信任分级；旧版 Hub 没有此字段时前端按 kind 兜底。 */
  trust_tier?: TrustTier;
  xmtp_address: string;
  group_status: "pending" | "added" | "removed";
}

/** 信任分级：席位回话时明文流向的边界（借鉴 agentroom.chat 的诚实分级）。 */
export type TrustTier = "local-cli" | "cloud-api" | "custom-webhook";

const TIER_BY_KIND: Record<AgentKind, TrustTier> = {
  "claude-code": "local-cli",
  codex: "local-cli",
  "gemini-cli": "local-cli",
  "openai-compatible": "cloud-api",
  "http-model": "cloud-api",
  webhook: "custom-webhook",
};

export function trustTierOf(kind: AgentKind | string): TrustTier {
  return TIER_BY_KIND[kind as AgentKind] ?? "custom-webhook";
}

export const TRUST_TIER_LABEL: Record<TrustTier, string> = {
  "local-cli": "本机",
  "cloud-api": "云端接口",
  "custom-webhook": "自定义接口",
};

export interface HelperDevice {
  id: string;
  device_name: string;
  platform: string;
  created_at: string;
  last_seen_at: string | null;
  revoked: boolean;
}

// ── 本机助手（127.0.0.1:8790） ──

function isHelperHello(value: unknown): value is HelperHello {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { app?: unknown }).app === "mapr-helper"
  );
}

/** 本机接口的错误回包可能是 {detail} 或 {error}；长度截断，防刷屏。 */
function localErrorMessage(body: unknown, fallback: string): string {
  const detail =
    typeof body === "object" && body !== null
      ? (body as { detail?: unknown; error?: unknown }).detail ??
        (body as { error?: unknown }).error
      : undefined;
  const text = typeof detail === "string" ? detail : fallback;
  return text.slice(0, 200);
}

async function readLocalJson(res: Response, fallback: string): Promise<unknown> {
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch { /* 回包不是 JSON 时用兜底文案 */ }
    throw new Error(localErrorMessage(body, fallback));
  }
  return res.json();
}

/**
 * GET /api/hello，1.5 秒超时。
 *
 * 结果分类：
 * - 200 且 app="mapr-helper" → running。
 * - 其他状态码、返回别的内容、超时中止 → not-running（没装、没启动或端口上是别的程序）。
 * - fetch 抛 TypeError → blocked。浏览器把连接被拒和「本地网络访问被拦」都报成
 *   TypeError: Failed to fetch，两者无法区分，统一按被拦处理（界面同时给出
 *   「打开本机助手」和安装命令两条路）。
 */
export async function probeHelper(fetchImpl: typeof fetch = fetch): Promise<HelperProbe> {
  let res: Response;
  try {
    res = await fetchImpl(`${HELPER_ORIGIN}/api/hello`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    if (err instanceof TypeError) return { state: "blocked" };
    return { state: "not-running" };
  }
  try {
    if (!res.ok) return { state: "not-running" };
    const body: unknown = await res.json();
    if (!isHelperHello(body)) return { state: "not-running" };
    return { state: "running", hello: body };
  } catch {
    return { state: "not-running" };
  }
}

/** GET /api/agents */
export async function listLocalAgents(fetchImpl: typeof fetch = fetch): Promise<LocalAgentView[]> {
  const res = await fetchImpl(`${HELPER_ORIGIN}/api/agents`, {
    signal: AbortSignal.timeout(LOCAL_CALL_TIMEOUT_MS),
    cache: "no-store",
  });
  const body = await readLocalJson(res, "读取本机 Agent 列表失败");
  return Array.isArray(body) ? (body as LocalAgentView[]) : [];
}

/** GET /api/seats */
export async function listLocalSeats(fetchImpl: typeof fetch = fetch): Promise<SeatViewLocal[]> {
  const res = await fetchImpl(`${HELPER_ORIGIN}/api/seats`, {
    signal: AbortSignal.timeout(LOCAL_CALL_TIMEOUT_MS),
    cache: "no-store",
  });
  const body = await readLocalJson(res, "读取席位列表失败");
  return Array.isArray(body) ? (body as SeatViewLocal[]) : [];
}

/**
 * POST /api/seats，body = {via:"ticket", ticket, agent_key}。
 * 网站只能走票据这条路；room_id 由 Hub 核销票据时取自票据本身，
 * 本机助手不相信网站传来的房间号。
 * 浏览器若拦截请求会抛 TypeError，由调用方决定改用 helperHandoffUrl 跳转。
 */
export async function joinViaTicket(
  ticket: string,
  agentKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SeatViewLocal> {
  const res = await fetchImpl(`${HELPER_ORIGIN}/api/seats`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ via: "ticket", ticket, agent_key: agentKey }),
    signal: AbortSignal.timeout(JOIN_TIMEOUT_MS),
  });
  const body = await readLocalJson(res, "加入失败，请重试");
  return body as SeatViewLocal;
}

/** 浏览器拦截时的后备：本机页面读取地址里 # 后面的内容并自己完成配对或加入。 */
export function helperHandoffUrl(action: { pair: string } | { ticket: string; agentKey: string }): string {
  if ("pair" in action) {
    return `${HELPER_ORIGIN}/#pair=${encodeURIComponent(action.pair)}`;
  }
  const params = new URLSearchParams({ ticket: action.ticket, agent: action.agentKey });
  return `${HELPER_ORIGIN}/#${params.toString()}`;
}

/** 顶层跳转去本机页面。跳转会离开本站，调用前先把必要状态展示给用户。 */
export function openHelperPage(action?: { pair: string } | { ticket: string; agentKey: string }): void {
  window.location.href = action ? helperHandoffUrl(action) : `${HELPER_ORIGIN}/`;
}

// ── Hub（需要人类登录态，走 apiFetch 统一带令牌与请求编号） ──

/**
 * apiFetch 走动态导入：./api 链路会在模块加载期读 localStorage（authStore），
 * 而本文件要在无 DOM 的测试环境也能 import。
 */
async function hubFetch(input: string, init?: RequestInit): Promise<Response> {
  const { apiFetch } = await import("./api");
  return apiFetch(input, init);
}

async function readHubJson(res: Response, fallback: string): Promise<unknown> {
  if (!res.ok) {
    let detail: unknown;
    try {
      const body = (await res.json()) as { detail?: unknown };
      detail = body?.detail;
    } catch { /* 忽略非 JSON 回包 */ }
    throw new Error(typeof detail === "string" ? detail.slice(0, 200) : fallback);
  }
  return res.json();
}

/** POST /api/v1/helpers/pairing-codes：发一次性配对码（10 分钟，10 个上限）。 */
export async function createPairingCode(): Promise<{ code: string; expires_at: string; install_command: string }> {
  const res = await hubFetch("/api/v1/helpers/pairing-codes", { method: "POST" });
  return (await readHubJson(res, "生成配对码失败，请重试")) as {
    code: string;
    expires_at: string;
    install_command: string;
  };
}

/** GET /api/v1/helpers：我的本机助手设备列表（含已吊销）。 */
export async function listMyHelpers(): Promise<HelperDevice[]> {
  const res = await hubFetch("/api/v1/helpers");
  const body = await readHubJson(res, "读取设备列表失败");
  return Array.isArray(body) ? (body as HelperDevice[]) : [];
}

/** DELETE /api/v1/helpers/{helper_id}：吊销一台本机助手（它的全部席位同时移除）。 */
export async function revokeHelper(helperId: string): Promise<void> {
  const res = await hubFetch(`/api/v1/helpers/${encodeURIComponent(helperId)}`, { method: "DELETE" });
  if (!res.ok) {
    await readHubJson(res, "吊销失败，请重试");
  }
}

/**
 * POST /api/v1/helpers/{helper_id}/join-tickets：发一次性加入票据（2 分钟）。
 * helper_id 从 GET /api/v1/helpers 的设备列表里选，不从本机 /api/hello 取。
 */
export async function createJoinTicket(
  helperId: string,
  input: { room_id: string; agent_key: string; owner_xmtp_address: string },
): Promise<{ ticket: string; expires_at: string }> {
  const res = await hubFetch(`/api/v1/helpers/${encodeURIComponent(helperId)}/join-tickets`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return (await readHubJson(res, "生成加入票据失败，请重试")) as { ticket: string; expires_at: string };
}

/** GET /api/v1/rooms/{room_id}/seats：房间内全部席位（房间成员可读）。 */
export async function listRoomSeats(roomId: string): Promise<HubSeatView[]> {
  const res = await hubFetch(`/api/v1/rooms/${encodeURIComponent(roomId)}/seats`);
  const body = await readHubJson(res, "读取席位状态失败");
  return Array.isArray(body) ? (body as HubSeatView[]) : [];
}

/** POST /api/v1/rooms/{room_id}/seats/{seat_id}/group-added：上报席位已加入加密群（幂等）。 */
export async function markSeatGroupAdded(roomId: string, seatId: string): Promise<void> {
  const res = await hubFetch(
    `/api/v1/rooms/${encodeURIComponent(roomId)}/seats/${encodeURIComponent(seatId)}/group-added`,
    { method: "POST" },
  );
  if (!res.ok) {
    await readHubJson(res, "上报入群状态失败");
  }
}

/** DELETE /api/v1/rooms/{room_id}/seats/{seat_id}：把席位移出房间（席位主人或房主）。 */
export async function removeRoomSeat(roomId: string, seatId: string): Promise<void> {
  const res = await hubFetch(
    `/api/v1/rooms/${encodeURIComponent(roomId)}/seats/${encodeURIComponent(seatId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    await readHubJson(res, "移除席位失败，请重试");
  }
}
