import { useAuthStore, type AuthUser } from "../stores/authStore";
import type { ChatMessage, Room, RoomTask } from "../types/chat";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

export function apiUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${API_BASE_URL}${path}`;
}

export function websocketUrl(path: string): string {
  const explicitWsBase = (import.meta.env.VITE_WS_BASE_URL ?? "").replace(/\/$/, "");
  if (explicitWsBase) return `${explicitWsBase}${path}`;
  if (API_BASE_URL) {
    return `${API_BASE_URL.replace(/^http/, "ws")}${path}`;
  }
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}${path}`;
}

export interface AgentSummary {
  id: string;
  name: string;
  status: "online" | "offline" | "busy" | string;
  capabilities: string[];
  last_seen_at?: string | null;
}

export interface KnowledgeDocSummary {
  id: string;
  title: string;
  updated_at: string;
}

export interface KnowledgeDoc extends KnowledgeDocSummary {
  content: string;
}

export interface KnowledgeSearchResult {
  id: string;
  title: string;
  snippet: string;
  updated_at: string;
}

export interface GitStatus {
  branch: string;
  changes: Array<{ path: string; status: string }>;
  last_commit: {
    short_hash: string;
    author: string;
    message: string;
    date: string;
  } | null;
}

export interface GitCommit {
  hash: string;
  short_hash: string;
  author: string;
  email: string;
  date: string;
  message: string;
}

export interface Approval {
  id: string;
  title: string;
  description: string;
  status: "pending" | "approved" | "rejected";
  risk_level: "low" | "medium" | "high";
  metadata?: {
    task_id?: string;
    requested_action?: string;
    risk_summary?: string;
    [key: string]: unknown;
  } | null;
  created_at: string;
}

/**
 * 请求编号头。H4 要求：服务端排查问题时只看编号，不看网址。
 * 编号由浏览器生成，只放请求头，绝不写进网址或请求体。
 */
export const API_REQUEST_ID_HEADER = "X-Request-ID";

/** 生成一个只含十六进制和短横线的编号，服务端可以直接记进日志。 */
export function newRequestId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  // 老浏览器没有 randomUUID 时的退路。
  const random = () => Math.random().toString(16).slice(2, 10).padEnd(8, "0");
  return `${random()}-${random()}-${random()}-${random()}`;
}

/** 调用方没带编号时补一个；带了就不动，保证同一次操作可追踪。 */
export function withRequestId(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (!headers.has(API_REQUEST_ID_HEADER)) {
    headers.set(API_REQUEST_ID_HEADER, newRequestId());
  }
  return { ...init, headers };
}

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const token = useAuthStore.getState().token;
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (!headers.has(API_REQUEST_ID_HEADER)) {
    headers.set(API_REQUEST_ID_HEADER, newRequestId());
  }
  const request = typeof input === "string" ? apiUrl(input) : input;
  const response = await fetch(request, { ...init, headers });

  // Auto-logout on expired/invalid token
  if (response.status === 401 && token) {
    useAuthStore.getState().logout();
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
      const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      window.location.href = `/login?next=${encodeURIComponent(current)}`;
    }
  }

  return response;
}

export interface AuthProviders {
  email_enabled: boolean;
  google_enabled: boolean;
  google_client_id: string;
}

const _AUTH_ERROR_MAP: Record<string, string> = {
  "Invalid username or password": "账号或密码错误，请重试",
  "Inactive account": "该账号已被停用",
  "Username already exists": "该用户名已被注册",
};

async function _parseAuthError(response: Response, fallbackMsg: string): Promise<string> {
  const errorText = await response.text();
  if (!errorText.trim()) return fallbackMsg;
  try {
    const errorJson = JSON.parse(errorText) as { detail?: unknown; error?: unknown };
    if (Array.isArray(errorJson.detail)) {
      const msgs = errorJson.detail.map((d: any) => {
        const loc: string[] = Array.isArray(d?.loc) ? d.loc : [];
        if (loc.includes("password")) return "密码长度至少需要 8 位，请重新输入";
        if (loc.includes("username")) return "用户名格式不符合要求";
        if (loc.includes("email")) return "请输入有效的邮箱地址";
        if (loc.includes("code")) return "请输入 6 位数字验证码";
        return typeof d?.msg === "string" ? d.msg : "输入格式不符合要求";
      });
      return msgs.join("；");
    }
    if (typeof errorJson.detail === "string" && errorJson.detail.trim()) {
      return _AUTH_ERROR_MAP[errorJson.detail] ?? errorJson.detail;
    }
    if (typeof errorJson.error === "string" && errorJson.error.trim()) {
      return errorJson.error;
    }
  } catch {
    // Non-JSON response body
  }
  return errorText;
}

export async function fetchAuthProviders(): Promise<AuthProviders> {
  const response = await apiFetch("/api/v1/auth/providers");
  if (!response.ok) {
    return { email_enabled: false, google_enabled: false, google_client_id: "" };
  }
  return response.json();
}

export async function register(input: {
  username: string;
  password: string;
  display_name: string;
  user_type?: "human" | "agent";
}): Promise<{ user: AuthUser; access_token: string }> {
  const response = await apiFetch("/api/v1/auth/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(await _parseAuthError(response, "注册失败，请重试"));
  }
  return response.json();
}

export async function sendEmailCode(input: {
  email: string;
  purpose: "register" | "login";
}): Promise<{ sent: boolean; expires_in: number; cooldown_seconds: number }> {
  const response = await apiFetch("/api/v1/auth/email/send-code", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(await _parseAuthError(response, "发送验证码失败，请稍后重试"));
  }
  return response.json();
}

export async function registerWithEmail(input: {
  email: string;
  code: string;
  password: string;
  display_name?: string;
  username?: string;
}): Promise<{ user: AuthUser; access_token: string }> {
  const response = await apiFetch("/api/v1/auth/email/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(await _parseAuthError(response, "邮箱注册失败，请重试"));
  }
  return response.json();
}

export async function login(input: {
  username: string;
  password: string;
}): Promise<{ user: AuthUser; access_token: string }> {
  const response = await apiFetch("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(await _parseAuthError(response, "登录失败，请检查账号和密码"));
  }
  return response.json();
}

export async function loginWithEmailCode(input: {
  email: string;
  code: string;
}): Promise<{ user: AuthUser; access_token: string }> {
  const response = await apiFetch("/api/v1/auth/email/login", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(await _parseAuthError(response, "验证码登录失败，请重试"));
  }
  return response.json();
}

export async function loginWithGoogle(
  credential: string,
): Promise<{ user: AuthUser; access_token: string }> {
  const response = await apiFetch("/api/v1/auth/google", {
    method: "POST",
    body: JSON.stringify({ credential }),
  });
  if (!response.ok) {
    throw new Error(await _parseAuthError(response, "Google 登录失败，请重试"));
  }
  return response.json();
}

export async function fetchMe(): Promise<AuthUser> {
  const response = await apiFetch("/api/v1/auth/me");
  if (!response.ok) throw new Error("Failed to load current user");
  const payload = (await response.json()) as { user: AuthUser };
  return payload.user;
}

export async function fetchRooms(): Promise<Room[]> {
  const response = await apiFetch("/api/v1/rooms");

  if (!response.ok) {
    throw new Error("Failed to load rooms");
  }

  const payload = (await response.json()) as { rooms?: Room[]; data?: Room[] };
  return payload.data ?? payload.rooms ?? [];
}

export async function createRoom(name: string, description?: string): Promise<Room> {
  const response = await apiFetch("/api/v1/rooms", {
    method: "POST",
    body: JSON.stringify({ name, description }),
  });

  if (!response.ok) {
    throw new Error("Failed to create room");
  }

  const payload = (await response.json()) as { room: Room };
  return payload.room;
}

export async function fetchMessages(roomId: string): Promise<ChatMessage[]> {
  const response = await apiFetch(`/api/v1/rooms/${roomId}/messages?limit=200`);

  if (!response.ok) {
    throw new Error("Failed to load messages");
  }

  const payload = (await response.json()) as {
    messages?: ChatMessage[];
    data?: ChatMessage[];
  };
  return payload.data ?? payload.messages ?? [];
}

export async function fetchAgents(): Promise<AgentSummary[]> {
  const response = await apiFetch("/api/v1/agents");
  if (!response.ok) throw new Error("Failed to load agents");
  const payload = (await response.json()) as { agents?: AgentSummary[]; data?: AgentSummary[] };
  return payload.agents ?? payload.data ?? [];
}

export async function registerAgent(input: {
  name: string;
  url?: string;
  capabilities: string[];
}): Promise<AgentSummary> {
  const response = await apiFetch("/api/v1/agents/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error("Failed to register agent");
  const payload = (await response.json()) as { agent: AgentSummary };
  return payload.agent;
}

export async function fetchDocs(roomId: string): Promise<KnowledgeDocSummary[]> {
  const response = await apiFetch(`/api/v1/rooms/${roomId}/docs`);
  if (!response.ok) throw new Error("Failed to load docs");
  const payload = (await response.json()) as { docs?: KnowledgeDocSummary[] };
  return payload.docs ?? [];
}

export async function createDoc(roomId: string, input: { title: string; content: string }): Promise<KnowledgeDoc> {
  const response = await apiFetch(`/api/v1/rooms/${roomId}/docs`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error("Failed to create doc");
  const payload = (await response.json()) as { doc: KnowledgeDoc };
  return payload.doc;
}

export async function fetchDoc(roomId: string, docId: string): Promise<KnowledgeDoc> {
  const response = await apiFetch(`/api/v1/rooms/${roomId}/docs/${docId}`);
  if (!response.ok) throw new Error("Failed to load doc");
  const payload = (await response.json()) as { doc: KnowledgeDoc };
  return payload.doc;
}

export async function searchDocs(roomId: string, query: string): Promise<KnowledgeSearchResult[]> {
  if (!query.trim()) return [];
  const response = await apiFetch(`/api/v1/rooms/${roomId}/docs/search?q=${encodeURIComponent(query)}`);
  if (!response.ok) throw new Error("Failed to search docs");
  const payload = (await response.json()) as { results?: KnowledgeSearchResult[] };
  return payload.results ?? [];
}

export async function fetchGitStatus(roomId: string): Promise<GitStatus> {
  const response = await apiFetch(`/api/v1/rooms/${roomId}/git/status`);
  if (!response.ok) throw new Error("Failed to load git status");
  return response.json() as Promise<GitStatus>;
}

export async function fetchGitLog(roomId: string): Promise<GitCommit[]> {
  const response = await apiFetch(`/api/v1/rooms/${roomId}/git/log?limit=5`);
  if (!response.ok) throw new Error("Failed to load git log");
  const payload = (await response.json()) as { commits?: GitCommit[] };
  return payload.commits ?? [];
}

export async function fetchApprovals(roomId: string): Promise<Approval[]> {
  const response = await apiFetch(`/api/v1/rooms/${roomId}/approvals`);
  if (!response.ok) throw new Error("Failed to load approvals");
  const payload = (await response.json()) as { approvals?: Approval[] };
  return payload.approvals ?? [];
}

export async function decideApproval(approvalId: string, decision: "approved" | "rejected"): Promise<Approval> {
  const response = await apiFetch(`/api/v1/approvals/${approvalId}/approve`, {
    method: "POST",
    body: JSON.stringify({ decision }),
  });
  if (!response.ok) throw new Error("Failed to decide approval");
  const payload = (await response.json()) as { approval: Approval };
  return payload.approval;
}

export async function fetchTasks(roomId: string): Promise<RoomTask[]> {
  const response = await apiFetch(`/api/v1/rooms/${roomId}/tasks`);
  if (!response.ok) throw new Error("Failed to load tasks");
  const payload = (await response.json()) as { tasks?: RoomTask[] };
  return payload.tasks ?? [];
}


/** 与 backend/app/api/invites.py 的硬禁 scope 清单保持一致（前端预检，后端仍是权威）。 */
export const FORBIDDEN_SCOPE_PREFIXES = [
  "payment.",
  "banking.",
  "credentials.",
  "password.",
  "card.",
  "wallet.",
] as const;
export const FORBIDDEN_SCOPES = ["data.export_all"] as const;
export const SCOPE_PATTERN = /^[a-z][a-z0-9_.]{0,63}$/;

export function scopeIsForbidden(scope: string): boolean {
  const s = scope.trim().toLowerCase();
  if (!s) return false;
  if ((FORBIDDEN_SCOPES as readonly string[]).includes(s)) return true;
  return FORBIDDEN_SCOPE_PREFIXES.some((prefix) => s.startsWith(prefix));
}

/** 过滤并校验建议 scope 列表：丢弃硬禁项，保留合法项。返回 {kept, dropped}。 */
export function sanitizeScopes(scopes: string[]): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const raw of scopes) {
    const s = raw.trim().toLowerCase();
    if (!s) continue;
    if (scopeIsForbidden(s) || !SCOPE_PATTERN.test(s)) {
      dropped.push(raw.trim());
    } else if (!kept.includes(s)) {
      kept.push(s);
    }
  }
  return { kept, dropped };
}

/** 规则建议：`ask` = 每次都要当场批准；`cannot` = 建议一律禁止。 */
export type HouseRuleDecision = "ask" | "cannot";

export interface HouseRules {
  scopes: Record<string, HouseRuleDecision>;
  notes: string[];
}

/** rooms.settings_json 的已知键；其余键透传。 */
export interface RoomSettings {
  template_key?: string;
  house_rules?: HouseRules;
  team_config_markdown?: string;
  default_max_rounds?: number;
  [key: string]: unknown;
}

export interface RoomTemplateInfo {
  id: string;
  key: string;
  name: string;
  description: string | null;
  icon: string;
  team_config_markdown: string | null;
  house_rules?: HouseRules | null;
  default_max_rounds?: number | null;
}

export async function fetchTemplates(): Promise<RoomTemplateInfo[]> {
  const response = await apiFetch("/api/v1/templates");
  if (!response.ok) throw new Error("Failed to load templates");
  const payload = (await response.json()) as { templates?: RoomTemplateInfo[] };
  return payload.templates ?? [];
}

export async function createRoomFromTemplate(
  templateKey: string,
  name: string,
  overrides?: {
    house_rules?: HouseRules;
    team_config_markdown?: string;
    default_max_rounds?: number;
  },
): Promise<Room> {
  const response = await apiFetch("/api/v1/templates/create-room", {
    method: "POST",
    body: JSON.stringify({ template_key: templateKey, name, ...(overrides ?? {}) }),
  });
  if (!response.ok) throw new Error("Failed to create room from template");
  const payload = (await response.json()) as { room: Room };
  return payload.room;
}

export interface RoomSettingsUpdateResult {
  room_id: string;
  settings_version: number;
  settings_json: Record<string, unknown>;
}

/** PATCH /api/v1/rooms/{room_id}/settings：仅房主；settings 为安全元数据（≤8 KiB，禁 scope 过滤由后端强制执行）。 */
export async function updateRoomSettings(
  roomId: string,
  settings: Record<string, unknown>,
): Promise<RoomSettingsUpdateResult> {
  const response = await apiFetch(`/api/v1/rooms/${encodeURIComponent(roomId)}/settings`, {
    method: "PATCH",
    body: JSON.stringify({ settings }),
  });
  if (response.status === 403) throw new Error("只有房主可以修改房间设置");
  if (response.status === 404) throw new Error("房间不存在");
  if (!response.ok) {
    let detail = "保存房间设置失败";
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (typeof body?.detail === "string") detail = body.detail.slice(0, 200);
    } catch { /* 非 JSON 回包用兜底文案 */ }
    throw new Error(detail);
  }
  return response.json() as Promise<RoomSettingsUpdateResult>;
}

export async function bindXmtpGroup(roomId: string, groupId: string): Promise<void> {
  const response = await apiFetch(`/api/v1/rooms/${roomId}/xmtp-binding`, {
    method: "POST",
    body: JSON.stringify({ xmtp_group_id: groupId }),
  });
  if (response.status === 403) throw new Error("只有房主可以绑定加密群");
  if (response.status === 409) return; // 已绑定，幂等成功
  if (!response.ok) throw new Error("加密群绑定失败，请重试");
}

export async function searchMessages(roomId: string, query: string): Promise<ChatMessage[]> {
  if (!query.trim()) return [];
  const response = await apiFetch(`/api/v1/rooms/${roomId}/messages/search?q=${encodeURIComponent(query)}`);
  if (!response.ok) throw new Error("Failed to search messages");
  const payload = (await response.json()) as { results?: ChatMessage[] };
  return payload.results ?? [];
}

/**
 * 只读分享的数据接口。
 * 地址以后端 `backend/app/api/rooms.py` 的路由为准：前缀 `/api/v1/rooms` 加 `/shared/{凭据}/messages`。
 * 注意：地址栏上的 `/shared/{凭据}` 是前端页面路由，不是数据接口，两者不要混用。
 */
export function sharedMessagesPath(token: string): string {
  return `/api/v1/rooms/shared/${encodeURIComponent(token)}/messages`;
}

export class SharedLinkError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SharedLinkError";
    this.status = status;
  }
}

export interface SharedRoomView {
  roomName: string;
  messages: ChatMessage[];
}

export async function fetchSharedRoomMessages(token: string): Promise<SharedRoomView> {
  const response = await apiFetch(sharedMessagesPath(token));
  if (response.status === 404) {
    throw new SharedLinkError("链接已过期或不存在", 404);
  }
  if (!response.ok) {
    throw new SharedLinkError("加载失败", response.status);
  }
  const payload = (await response.json()) as { room_name?: string; messages?: ChatMessage[] };
  return {
    roomName: payload.room_name ?? "只读分享",
    messages: payload.messages ?? [],
  };
}
