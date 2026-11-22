import type { AgentKind } from "../engines/types.ts";

/**
 * 本机助手（mapr helper）的领域模型。
 *
 * LocalAgent：这台电脑上能用的一个 Agent（探测到的命令行工具，或主人手动添加的云端 Agent）。
 * Seat（席位）：某个 LocalAgent 在某个房间里的一个身份。一个席位 = 一把独立 XMTP 私钥
 *   + 一个独立数据目录 + 一个独立的成员进程。同一 Agent 进 3 个房间就是 3 个席位。
 *
 * 落盘位置（全部 0600 / 0700，不进 git，不上报 Hub）：
 *   ~/.mapr/helper.json             HelperConfig
 *   ~/.mapr/agents/<key>.secret     手动添加的云端 Agent 的密钥
 *   ~/.mapr/seats/<seatId>/seat.json  SeatRecord（含私钥）
 *   ~/.mapr/seats/<seatId>/xmtp/      XMTP_DB_DIRECTORY
 *   ~/.mapr/seats/<seatId>/state/     成员进程 .state（账本、任务、主人记录）
 *   ~/.mapr/sandbox/<seatId>/         命令行 Agent 的空白工作目录
 */

export type AgentSource = "detected" | "manual";

/** 只根据文件是否存在判断，不读取任何登录文件的内容。 */
export type LoginState = "likely-ready" | "needs-login" | "unknown";

export interface LocalAgent {
  /** 稳定键：探测类用种类名（如 "claude-code"）；手动类用 "manual:<uuid>"。 */
  key: string;
  kind: AgentKind;
  displayName: string;
  source: AgentSource;
  binaryPath?: string;
  version?: string;
  baseUrl?: string;
  /** openai-compatible 探测项（如 Magpie 托管 Agent）的模型 id。 */
  model?: string;
  loginState: LoginState;
}

export interface KnownCliAgent {
  /** LocalAgent.key 稳定键；cli-agent 类用规格键（"opencode" 等），旧三种与 kind 同名。 */
  key?: string;
  kind: Extract<AgentKind, "claude-code" | "codex" | "gemini-cli" | "cli-agent">;
  displayName: string;
  /** 在 PATH 里查找的命令名，按顺序尝试。 */
  binaries: string[];
  versionArgs: string[];
  /** 相对家目录的路径；任一存在即视为 likely-ready。带 minBytes 时文件还需达到最小字节数。 */
  loginMarkers: (string | { path: string; minBytes?: number })[];
}

export interface ManualAgent {
  key: string;
  kind: Extract<AgentKind, "openai-compatible" | "webhook">;
  displayName: string;
  /** openai-compatible 用 baseUrl+model；webhook 用 url。 */
  baseUrl?: string;
  model?: string;
  url?: string;
}

export interface HelperConfig {
  hubOrigin: string;
  helperId: string;
  helperToken: string;
  deviceName: string;
  ownerUserId: string;
  ownerDisplayName: string;
  manualAgents: ManualAgent[];
}

export type SeatStatus = "starting" | "running" | "crashed" | "stopped" | "revoked";

export interface SeatRecord {
  seatId: string;
  agentKey: string;
  roomId: string;
  roomName: string;
  agentUsername: string;
  xmtpWalletKey: string;
  xmtpDbEncryptionKey: string;
  xmtpAddress: string;
  xmtpGroupId: string | null;
  allowedSenders: string[];
  agentToken: string;
  consolePort: number;
  createdAt: string;
  /**
   * WP5 暂停标记（ISO 时间戳）。非空时成员进程必须处于停止态，
   * helper 重启恢复席位时跳过它；数据与私钥一律保留（绝不走 seats_to_stop 语义）。
   */
  pausedAt?: string | null;
  /**
   * 暂停来源："hub" = 由心跳 seats_to_pause 对账维护（Hub 端恢复时自动清除并重启）；
   * "local" = 本机接口手动暂停（只有本机 resume 才解除）。
   */
  pausedSource?: "hub" | "local" | null;
}

/** 本机接口对外返回的席位视图：不含任何私钥或登录信息。 */
export interface SeatView {
  seatId: string;
  agentKey: string;
  roomId: string;
  roomName: string;
  xmtpAddress: string;
  consolePort: number;
  status: SeatStatus;
  lastError: string | null;
  pausedAt: string | null;
}

// ── 与 Hub 的接口（字段名与 backend/app/helper/schemas.py 一一对应） ──

export interface PairResponse {
  helper_id: string;
  helper_token: string;
  owner_user_id: string;
  owner_display_name: string;
}

export interface HubRoom {
  id: string;
  name: string;
  xmtp_group_id: string | null;
  role: "owner" | "member" | "viewer";
}

export interface SeatGrant {
  seat_id: string;
  room_id: string;
  room_name: string;
  agent_user_id: string;
  agent_username: string;
  agent_token: string;
  xmtp_group_id: string | null;
  allowed_senders: string[];
}

/** 心跳顺带下发的房间安全元数据；本机规则永远优先，这些只作建议。 */
export interface HeartbeatRoom {
  id: string;
  settings_version: number;
  settings_json: Record<string, unknown> | null;
}

export interface HeartbeatResponse {
  revoked: boolean;
  seats_to_stop: string[];
  /** WP5：暂停列表与 seats_to_stop 严格分离——暂停只停进程不删数据。旧 Hub 可能不下发。 */
  seats_to_pause?: string[];
  /** WP9：主人可见房间的 settings_version/settings_json，版本前进时才重写本机副本。 */
  rooms?: HeartbeatRoom[];
}

export type CreateSeatRequest =
  | { via: "ticket"; ticket: string; agent_key: string; kind: AgentKind; display_name: string; xmtp_address: string }
  | { via: "local"; room_id: string; agent_key: string; kind: AgentKind; display_name: string; xmtp_address: string };
