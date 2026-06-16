import type { ChatMessage, Room } from "../types/chat";

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
  created_at: string;
}

export async function fetchRooms(): Promise<Room[]> {
  const response = await fetch("/api/v1/rooms");

  if (!response.ok) {
    throw new Error("Failed to load rooms");
  }

  const payload = (await response.json()) as { rooms?: Room[]; data?: Room[] };
  return payload.data ?? payload.rooms ?? [];
}

export async function createRoom(name: string, description?: string): Promise<Room> {
  const response = await fetch("/api/v1/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description }),
  });

  if (!response.ok) {
    throw new Error("Failed to create room");
  }

  const payload = (await response.json()) as { room: Room };
  return payload.room;
}

export async function fetchMessages(roomId: string): Promise<ChatMessage[]> {
  const response = await fetch(`/api/v1/rooms/${roomId}/messages?limit=200`);

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
  const response = await fetch("/api/v1/agents");
  if (!response.ok) throw new Error("Failed to load agents");
  const payload = (await response.json()) as { agents?: AgentSummary[]; data?: AgentSummary[] };
  return payload.agents ?? payload.data ?? [];
}

export async function registerAgent(input: {
  name: string;
  url?: string;
  capabilities: string[];
}): Promise<AgentSummary> {
  const response = await fetch("/api/v1/agents/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error("Failed to register agent");
  const payload = (await response.json()) as { agent: AgentSummary };
  return payload.agent;
}

export async function fetchDocs(roomId: string): Promise<KnowledgeDocSummary[]> {
  const response = await fetch(`/api/v1/rooms/${roomId}/docs`);
  if (!response.ok) throw new Error("Failed to load docs");
  const payload = (await response.json()) as { docs?: KnowledgeDocSummary[] };
  return payload.docs ?? [];
}

export async function createDoc(roomId: string, input: { title: string; content: string }): Promise<KnowledgeDoc> {
  const response = await fetch(`/api/v1/rooms/${roomId}/docs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error("Failed to create doc");
  const payload = (await response.json()) as { doc: KnowledgeDoc };
  return payload.doc;
}

export async function fetchDoc(roomId: string, docId: string): Promise<KnowledgeDoc> {
  const response = await fetch(`/api/v1/rooms/${roomId}/docs/${docId}`);
  if (!response.ok) throw new Error("Failed to load doc");
  const payload = (await response.json()) as { doc: KnowledgeDoc };
  return payload.doc;
}

export async function searchDocs(roomId: string, query: string): Promise<KnowledgeSearchResult[]> {
  if (!query.trim()) return [];
  const response = await fetch(`/api/v1/rooms/${roomId}/docs/search?q=${encodeURIComponent(query)}`);
  if (!response.ok) throw new Error("Failed to search docs");
  const payload = (await response.json()) as { results?: KnowledgeSearchResult[] };
  return payload.results ?? [];
}

export async function fetchGitStatus(roomId: string): Promise<GitStatus> {
  const response = await fetch(`/api/v1/rooms/${roomId}/git/status`);
  if (!response.ok) throw new Error("Failed to load git status");
  return response.json() as Promise<GitStatus>;
}

export async function fetchGitLog(roomId: string): Promise<GitCommit[]> {
  const response = await fetch(`/api/v1/rooms/${roomId}/git/log?limit=5`);
  if (!response.ok) throw new Error("Failed to load git log");
  const payload = (await response.json()) as { commits?: GitCommit[] };
  return payload.commits ?? [];
}

export async function fetchApprovals(roomId: string): Promise<Approval[]> {
  const response = await fetch(`/api/v1/rooms/${roomId}/approvals`);
  if (!response.ok) throw new Error("Failed to load approvals");
  const payload = (await response.json()) as { approvals?: Approval[] };
  return payload.approvals ?? [];
}

export async function decideApproval(approvalId: string, decision: "approved" | "rejected"): Promise<Approval> {
  const response = await fetch(`/api/v1/approvals/${approvalId}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  if (!response.ok) throw new Error("Failed to decide approval");
  const payload = (await response.json()) as { approval: Approval };
  return payload.approval;
}
