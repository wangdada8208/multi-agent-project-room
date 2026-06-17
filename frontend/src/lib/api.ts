import { useAuthStore, type AuthUser } from "../stores/authStore";
import type { ChatMessage, Room, RoomTask } from "../types/chat";

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

async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const token = useAuthStore.getState().token;
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return fetch(input, { ...init, headers });
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
  if (!response.ok) throw new Error(await response.text());
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
  if (!response.ok) throw new Error("登录失败，请检查用户名和密码");
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
