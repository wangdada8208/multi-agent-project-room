import { projectHubActivityEvent, projectHubCheckpoint, type SignedLedgerCheckpoint } from "../activity.ts";
import type { HubActivityIngestResult, HubSafeActivityEvent } from "../hubContracts.generated.ts";
import type {
  CreateSeatRequest,
  HeartbeatResponse,
  HubRoom,
  PairResponse,
  SeatGrant,
  SeatStatus,
} from "./types.ts";

/**
 * 本机助手访问 Hub 的唯一出口。除 pair 外，全部带 `Authorization: Bearer <helperToken>`。
 * 端点定义见 backend/app/helper/routes.py。
 * 失败时抛 HubError(status)，错误信息不得包含令牌、配对码或响应原文：
 * FastAPI 的 422 详情会照抄请求字段，直接回显可能带出敏感值。
 */
export class HubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface HubClient {
  /** POST /api/v1/helpers/pair（无登录，配对码本身就是授权） */
  pair(code: string, deviceName: string, platform: string): Promise<PairResponse>;
  /** GET /api/v1/helpers/me/rooms：主人能看到的房间，供本机页面选择 */
  listRooms(): Promise<HubRoom[]>;
  /** POST /api/v1/helpers/me/seats */
  createSeat(req: CreateSeatRequest): Promise<SeatGrant>;
  /** GET /api/v1/helpers/me/seats/{seatId}：刷新 xmtp_group_id（房主晚于入座才建群时） */
  getSeat(seatId: string): Promise<{ xmtp_group_id: string | null; group_status: "pending" | "added" | "removed" }>;
  /** POST /api/v1/helpers/me/seats/{seatId}/token：换一张新的 Agent 访问令牌 */
  refreshAgentToken(seatId: string): Promise<{ agent_token: string }>;
  /** DELETE /api/v1/helpers/me/seats/{seatId} */
  deleteSeat(seatId: string): Promise<void>;
  /** POST /api/v1/helpers/me/heartbeat，每 30 秒一次 */
  heartbeat(body: {
    agents: { key: string; kind: string; version?: string }[];
    seats: { seat_id: string; status: SeatStatus }[];
  }): Promise<HeartbeatResponse>;
  /** POST /api/v1/helpers/me/activity：批量上报仅元数据活动事件（WP4） */
  reportActivity(events: HubSafeActivityEvent[]): Promise<HubActivityIngestResult>;
  /** POST /api/v1/helpers/me/activity/checkpoints：上报 EIP-191 签名账本锚点（WP4） */
  reportCheckpoints(checkpoints: SignedLedgerCheckpoint[]): Promise<HubActivityIngestResult>;
}

/** 所有 Hub 调用共用的超时；本机助手不能被一个卡住的 Hub 拖死。 */
const REQUEST_TIMEOUT_MS = 15_000;

export function createHubClient(hubOrigin: string, helperToken: string | null, fetchImpl: typeof fetch = fetch): HubClient {
  const base = hubOrigin.replace(/\/+$/, "");

  async function call<T>(method: string, apiPath: string, body?: unknown, authed = true): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (authed) {
      if (!helperToken) throw new HubError(401, `hub request failed: ${method} ${apiPath} not paired`);
      headers.Authorization = `Bearer ${helperToken}`;
    }
    let res: Response;
    try {
      res = await fetchImpl(`${base}${apiPath}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // 网络层错误统一收敛成 HubError(0)，不把底层异常文本（可能含 URL/代理细节）带出去。
      throw new HubError(0, `hub request failed: ${method} ${apiPath} network error`);
    }
    if (!res.ok) {
      // 只带状态码与路径：响应原文可能照抄请求内容（422），令牌与票据不外泄。
      throw new HubError(res.status, `hub request failed: ${method} ${apiPath} -> ${res.status}`);
    }
    if (res.status === 204) return undefined as T;
    try {
      return (await res.json()) as T;
    } catch {
      throw new HubError(res.status, `hub request failed: ${method} ${apiPath} bad response`);
    }
  }

  return {
    pair: (code, deviceName, platform) =>
      call<PairResponse>("POST", "/api/v1/helpers/pair", { code, device_name: deviceName, platform }, false),
    listRooms: () => call<HubRoom[]>("GET", "/api/v1/helpers/me/rooms"),
    createSeat: (req) => call<SeatGrant>("POST", "/api/v1/helpers/me/seats", req),
    getSeat: (seatId) =>
      call<{ xmtp_group_id: string | null; group_status: "pending" | "added" | "removed" }>(
        "GET",
        `/api/v1/helpers/me/seats/${encodeURIComponent(seatId)}`
      ),
    refreshAgentToken: (seatId) =>
      call<{ agent_token: string }>("POST", `/api/v1/helpers/me/seats/${encodeURIComponent(seatId)}/token`),
    deleteSeat: (seatId) => call<void>("DELETE", `/api/v1/helpers/me/seats/${encodeURIComponent(seatId)}`),
    heartbeat: (body) => call<HeartbeatResponse>("POST", "/api/v1/helpers/me/heartbeat", body),
    reportActivity: (events) =>
      call<HubActivityIngestResult>("POST", "/api/v1/helpers/me/activity", {
        events: events.map(projectHubActivityEvent),
      }),
    reportCheckpoints: (checkpoints) =>
      call<HubActivityIngestResult>("POST", "/api/v1/helpers/me/activity/checkpoints", {
        checkpoints: checkpoints.map(projectHubCheckpoint),
      }),
  };
}
