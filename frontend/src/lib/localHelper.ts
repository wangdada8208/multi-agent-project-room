/**
 * 网站与「本机助手」（用户电脑上的 mapr helper，127.0.0.1:8790）之间的客户端，
 * 以及网站调用 Hub helper 接口的封装。
 *
 * 浏览器限制：
 * - Chrome 会对「公网页面访问 127.0.0.1」弹出本地网络访问权限提示，用户点允许后 fetch 才能成功。
 * - Safari 等浏览器可能直接拦截。桌面端可在新标签页打开本机助手，携带配对码或加入票据。
 *
 * 权限边界（见 workers/xmtp-member/src/helper/server.ts 的 guardHelperRequest）：
 * 网站来源只能做 public-read、owner-read 与 ticket-write 三类请求；
 * 配对、手动加 Agent、删席位属于 owner-write，一律引导用户去本机页面完成。
 */

import { apiFetch } from "./api";
import type { AgentKind, TrustTier } from "./seatIdentity";
export { trustTierOf, TRUST_TIER_LABEL, type AgentKind, type TrustTier } from "./seatIdentity";

export const HELPER_ORIGIN = "http://127.0.0.1:8790";

/** /api/hello 探测超时：本机回环，1.5 秒足够。 */
const PROBE_TIMEOUT_MS = 1500;
/** 普通本机读写超时。 */
const LOCAL_CALL_TIMEOUT_MS = 5000;
/** POST /api/seats 要生成密钥、调 Hub、起进程，放宽到 30 秒。 */
const JOIN_TIMEOUT_MS = 30000;

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

export function isMobileBrowser(
  ua = typeof navigator === "undefined" ? "" : navigator.userAgent,
  maxTouchPoints = typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints,
): boolean {
  return /iPhone|iPad|iPod|Android|Mobile/i.test(ua)
    || (/Macintosh/i.test(ua) && maxTouchPoints > 1);
}

export function resolvePresetOpenDecision(
  probe: HelperProbe | null,
  isMobile: boolean,
): "open-helper" | "guide-mobile" | "guide-install" {
  if (isMobile) return "guide-mobile";
  return probe?.state === "running" ? "open-helper" : "guide-install";
}

export interface LocalAgentView {
  key: string;
  kind: AgentKind;
  displayName: string;
  source: "detected" | "manual";
  version?: string;
  model?: string;
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
  /** helper=本机助手席位；invite=云端邀请入房席位。旧版 Hub 无此字段时视为 helper。 */
  source?: "helper" | "invite";
  /** 被显式暂停的时间；null/缺省 = 未暂停。 */
  paused_at?: string | null;
}

export interface HelperDevice {
  id: string;
  device_name: string;
  platform: string;
  created_at: string;
  last_seen_at: string | null;
  revoked: boolean;
}

export interface RoomInviteView {
  token: string;
  room_id: string;
  created_by: string;
  proposed_scopes: string[];
  expires_at: string;
  is_expired?: boolean;
  is_used?: boolean;
  used_at: string | null;
  redeemed_by_address: string | null;
  created_at: string;
  max_uses?: number;
  use_count?: number;
  requires_approval?: boolean;
  role?: "member" | "viewer";
  revoked_at?: string | null;
}

export type RedemptionStatus =
  | "pending"
  | "approved"
  | "consumed"
  | "denied"
  | "expired"
  | "revoked";

export interface RedemptionView {
  id: string;
  token: string;
  kind: "human" | "agent" | string;
  status: RedemptionStatus | string;
  redeemer_user_id: string | null;
  redeemer_address: string | null;
  agent_user_id: string | null;
  seat_id: string | null;
  approved_scopes: string[] | null;
  decided_by: string | null;
  decided_at: string | null;
  deny_reason: string | null;
  expires_at: string | null;
  created_at: string | null;
}

/** POST /api/v1/invites/nonce 支持的签名动作域。 */
export type SignatureNonceAction = "invite-redeem" | "invite-agent-register" | "bind-address";

export interface SignatureNonce {
  nonce: string;
  message: string;
  expires_at: string;
}

// ── 本机助手（127.0.0.1:8790） ──

function isHelperHello(value: unknown): value is HelperHello {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { app?: unknown }).app === "mapr-helper"
  );
}

/** 本机接口的错误回包可能是 {reason}、{detail} 或 {error}；长度截断，防刷屏。 */
export function localErrorMessage(body: unknown, fallback: string): string {
  const detail =
    typeof body === "object" && body !== null
      ? (body as { reason?: unknown; detail?: unknown; error?: unknown }).reason ??
        (body as { detail?: unknown; error?: unknown }).detail ??
        (body as { error?: unknown }).error
      : undefined;
  const text = typeof detail === "string" && detail.trim() ? detail : fallback;
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

export type HelperHandoffAction =
  | { pair: string }
  | { ticket: string; agentKey: string }
  | { preset: string; roomId?: string; pairCode?: string };

/** 浏览器拦截时的后备：本机页面读取地址里 # 后面的内容并自己完成配对、预设展开或加入。 */
export function helperHandoffUrl(action: HelperHandoffAction): string {
  if ("pair" in action) {
    return `${HELPER_ORIGIN}/#pair=${encodeURIComponent(action.pair)}`;
  }
  if ("preset" in action) {
    const params = new URLSearchParams();
    if (action.pairCode && action.pairCode.trim()) {
      params.set("pair", action.pairCode.trim());
    }
    params.set("preset", action.preset);
    if (action.roomId && action.roomId.trim()) {
      params.set("room", action.roomId.trim());
    }
    return `${HELPER_ORIGIN}/#${params.toString()}`;
  }
  const params = new URLSearchParams({ ticket: action.ticket, agent: action.agentKey });
  return `${HELPER_ORIGIN}/#${params.toString()}`;
}

/** 生成 Windows PowerShell 一键安装并配对本机助手命令。 */
export function powershellInstallCommand(code: string, hubOrigin?: string): string {
  const origin = (hubOrigin ?? window.location.origin).replace(/\/+$/, "");
  return `iex "& { $(irm ${origin}/install.ps1 -UseBasicParsing) } -Pair ${code} -Hub ${origin}"`;
}

// ── Hub（需要人类登录态，走 apiFetch 统一带令牌与请求编号） ──

function hubFetch(input: string, init?: RequestInit): Promise<Response> {
  return apiFetch(input, init);
}

export class HubHttpError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "HubHttpError";
    this.status = status;
  }
}

async function readHubJson(res: Response, fallback: string): Promise<unknown> {
  if (!res.ok) {
    let detail: unknown;
    try {
      const body = (await res.json()) as { detail?: unknown; reason?: unknown };
      detail = body?.detail ?? body?.reason;
    } catch { /* 忽略非 JSON 回包 */ }
    throw new HubHttpError(typeof detail === "string" ? detail.slice(0, 200) : fallback, res.status);
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

/** DELETE /api/v1/helpers/{helper_id}：吊销一台本机助手（它的全部席位同时移出）。 */
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
    await readHubJson(res, "移出席位失败，请重试");
  }
}

/** POST .../seats/{seat_id}/pause：暂停席位（停本机进程，不删席位；房主或席位主人，204）。 */
export async function pauseRoomSeat(roomId: string, seatId: string): Promise<void> {
  const res = await hubFetch(
    `/api/v1/rooms/${encodeURIComponent(roomId)}/seats/${encodeURIComponent(seatId)}/pause`,
    { method: "POST" },
  );
  if (!res.ok) {
    await readHubJson(res, "暂停席位失败，请重试");
  }
}

/** POST .../seats/{seat_id}/resume：恢复被显式暂停的席位（204）。 */
export async function resumeRoomSeat(roomId: string, seatId: string): Promise<void> {
  const res = await hubFetch(
    `/api/v1/rooms/${encodeURIComponent(roomId)}/seats/${encodeURIComponent(seatId)}/resume`,
    { method: "POST" },
  );
  if (!res.ok) {
    await readHubJson(res, "恢复席位失败，请重试");
  }
}

export interface CreateInviteOptions {
  /** 有效期（小时），默认 72，后端上限 720。 */
  expires_hours?: number;
  /** 可核销次数上限，1..32，默认 1。 */
  max_uses?: number;
  /** true = 每次核销都需房主批准后生效。 */
  requires_approval?: boolean;
  /** 受邀人入房角色；invites 不能创建 owner。 */
  role?: "member" | "viewer";
  /** 建议授权范围（仅元数据，后端对硬禁 scope 强制过滤）。 */
  proposed_scopes?: string[];
}

/** POST /api/v1/rooms/{room_id}/invites：房主生成可复用加密入群邀请令牌。 */
export async function createRoomInvite(
  roomId: string,
  options: CreateInviteOptions = {},
): Promise<RoomInviteView> {
  const res = await hubFetch(`/api/v1/rooms/${encodeURIComponent(roomId)}/invites`, {
    method: "POST",
    body: JSON.stringify({
      proposed_scopes: options.proposed_scopes ?? [],
      expires_hours: options.expires_hours ?? 72,
      max_uses: options.max_uses ?? 1,
      requires_approval: options.requires_approval ?? false,
      role: options.role ?? "member",
    }),
  });
  const body = (await readHubJson(res, "生成加密入群邀请链接失败，请重试")) as { invite: RoomInviteView };
  return body.invite;
}

/** DELETE /api/v1/rooms/{room_id}/invites/{token}：软吊销邀请（pending 核销级联 revoked）。 */
export async function revokeRoomInvite(roomId: string, token: string): Promise<void> {
  const res = await hubFetch(
    `/api/v1/rooms/${encodeURIComponent(roomId)}/invites/${encodeURIComponent(token)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    await readHubJson(res, "吊销邀请失败，请重试");
  }
}

/** GET /api/v1/rooms/{room_id}/invites：房主读取房间内邀请记录（含已核销地址）。 */
export async function listRoomInvites(roomId: string): Promise<RoomInviteView[]> {
  const res = await hubFetch(`/api/v1/rooms/${encodeURIComponent(roomId)}/invites`);
  const body = (await readHubJson(res, "读取房间邀请记录失败")) as { invites?: RoomInviteView[] };
  return body.invites ?? [];
}

/** POST /api/v1/invites/{token}/accept：协作者登录后凭邀请令牌自动获得房间成员权限（幂等）。 */
export async function acceptRoomInvite(
  token: string,
): Promise<{ room_id: string; role: string }> {
  const res = await hubFetch(`/api/v1/invites/${encodeURIComponent(token)}/accept`, {
    method: "POST",
  });
  return (await readHubJson(res, "接受房间入群邀请失败")) as {
    room_id: string;
    role: string;
  };
}

/** 将 acceptRoomInvite 抛出的状态码与后端错误文案转换为清晰的中文提示。 */
export function formatInviteAcceptError(err: unknown): string {
  const status = (err as { status?: number } | null)?.status;
  const rawMessage = err instanceof Error ? err.message : "";
  const lower = rawMessage.toLowerCase();
  if (status === 409 || lower.includes("already redeemed")) {
    return "该入群邀请链接已被使用，请向房主索取新的邀请链接。";
  }
  if (status === 410 || lower.includes("expired")) {
    return "该入群邀请链接已过期，请向房主索取新的邀请链接。";
  }
  if (status === 404 || lower.includes("not found")) {
    return "入群邀请链接无效或不存在。";
  }
  return rawMessage.trim() || "接受房间入群邀请失败";
}

/** POST /api/v1/invites/nonce：领取一次性 EIP-191 挑战，服务端按 action+resource+address 重建待签名文本。 */
export async function issueSignatureNonce(input: {
  action: SignatureNonceAction;
  resource: string;
  address: string;
}): Promise<SignatureNonce> {
  const res = await hubFetch("/api/v1/invites/nonce", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return (await readHubJson(res, "获取签名挑战失败，请重试")) as SignatureNonce;
}

export interface RedeemInviteResult {
  /** consumed=已生效；pending=等待房主批准；approved=已批准待生效。 */
  status?: "consumed" | "pending" | "approved" | string;
  redemption_id?: string;
  room_id?: string;
  xmtp_group_id?: string | null;
  proposed_scopes?: string[];
}

/** POST /api/v1/invites/{token}/redeem：提交本机 XMTP 地址 + EIP-191 签名核销邀请。 */
export async function redeemRoomInvite(
  token: string,
  input: { xmtp_address: string; nonce: string; signature: string },
): Promise<RedeemInviteResult> {
  const res = await hubFetch(`/api/v1/invites/${encodeURIComponent(token)}/redeem`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return (await readHubJson(res, "核销加密入群邀请失败")) as RedeemInviteResult;
}

/** PUT /api/v1/rooms/{room_id}/members/me/xmtp-address：把本人已验证的 XMTP 地址绑定到成员行。 */
export async function bindMyXmtpAddress(
  roomId: string,
  input: { xmtp_address: string; nonce: string; signature: string },
): Promise<{ ok: boolean; xmtp_address: string }> {
  const res = await hubFetch(
    `/api/v1/rooms/${encodeURIComponent(roomId)}/members/me/xmtp-address`,
    {
      method: "PUT",
      body: JSON.stringify(input),
    },
  );
  return (await readHubJson(res, "绑定加密地址失败，请重试")) as {
    ok: boolean;
    xmtp_address: string;
  };
}

/** GET /api/v1/rooms/{room_id}/redemptions：房主查看核销队列；默认全部，可传 status=pending。 */
export async function listRoomRedemptions(
  roomId: string,
  status?: RedemptionStatus,
): Promise<RedemptionView[]> {
  const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
  const res = await hubFetch(
    `/api/v1/rooms/${encodeURIComponent(roomId)}/redemptions${suffix}`,
  );
  const body = (await readHubJson(res, "读取入群申请失败")) as {
    redemptions?: RedemptionView[];
  };
  return body.redemptions ?? [];
}

/** POST .../redemptions/{id}/approve：房主批准一条 pending 核销（approved_scopes ⊆ proposed_scopes）。 */
export async function approveRedemption(
  roomId: string,
  redemptionId: string,
  options: { approved_scopes?: string[]; display_name?: string } = {},
): Promise<RedemptionView> {
  const res = await hubFetch(
    `/api/v1/rooms/${encodeURIComponent(roomId)}/redemptions/${encodeURIComponent(redemptionId)}/approve`,
    {
      method: "POST",
      body: JSON.stringify(options),
    },
  );
  const body = (await readHubJson(res, "批准入群申请失败，请重试")) as {
    redemption: RedemptionView;
  };
  return body.redemption;
}

/** POST .../redemptions/{id}/deny：房主拒绝一条 pending 核销。 */
export async function denyRedemption(
  roomId: string,
  redemptionId: string,
  reason?: string,
): Promise<RedemptionView> {
  const res = await hubFetch(
    `/api/v1/rooms/${encodeURIComponent(roomId)}/redemptions/${encodeURIComponent(redemptionId)}/deny`,
    {
      method: "POST",
      body: JSON.stringify(reason ? { reason } : {}),
    },
  );
  const body = (await readHubJson(res, "拒绝入群申请失败，请重试")) as {
    redemption: RedemptionView;
  };
  return body.redemption;
}
