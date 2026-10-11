export type SenderType = "human" | "agent" | "system";

export type MessageType =
  | "text"
  | "system"
  | "task"
  | "proposal"
  | "report"
  | "approval_request"
  | "consensus"
  | "conflict"
  | "loop_update";

export interface Room {
  id: string;
  name: string;
  description: string;
  created_by?: string | null;
  created_at: string;
  transport?: string;
  xmtp_group_id?: string | null;
}

export interface ChatMessage {
  room_seq?: number;
  id: string;
  room_id: string;
  sender_id: string;
  sender_type: SenderType;
  sender_name?: string | null;
  content: string;
  msg_type: MessageType;
  parent_id?: string | null;
  created_at: string;
}

export interface PresenceParticipant {
  sender_id: string;
  sender_name: string;
  sender_type: SenderType;
  joined_at: string;
  last_seen_at: string;
  connection_count?: number;
}

export interface TaskProgress {
  phase: "queued" | "running" | "waiting" | "finishing";
  percent: number;
  event_seq?: number;
}

export interface TaskProgressEvent extends TaskProgress {
  type: "task_progress";
  task_id: string;
  room_id?: string;
  v?: number;
}

export interface RoomTask {
  event_seq?: number;
  progress?: TaskProgress;
  id: string;
  source_agent: string;
  target_agent?: string | null;
  query: string;
  status: "submitted" | "working" | "completed" | "failed" | "canceled" | "input_required" | string;
  result?: unknown;
  room_id?: string | null;
  source_message_id?: string | null;
  approval_id?: string | null;
  created_at: string;
  completed_at?: string | null;
}

// Reconciliation may send state alone; missing fields are not deletions.
export type RoomTaskPatch = Pick<RoomTask, "id"> & Partial<Omit<RoomTask, "id" | "progress">>;

/** 消息循环协作的轮次记录 */
export interface LoopTurn {
  agent_name: string;
  content: string;
  turn_number: number;
  signals_consensus: boolean;
  conflicts: string[];
  timestamp: string;
}

export interface MessageLoopState {
  loop_id: string;
  room_id: string;
  topic: string;
  status: "pending" | "active" | "consensus" | "max_turns" | "canceled" | "timeout";
  current_round: number;
  max_turns: number;
  turns: LoopTurn[];
  consensus_summary?: string | null;
}

export interface WebSocketMessageEvent {
  type: "message";
  message: ChatMessage;
}

export interface WebSocketSystemEvent {
  type: "system" | "error";
  content?: string;
  message?: string;
}

export interface WebSocketTypingEvent {
  type: "typing";
  sender_id: string;
}

export interface WebSocketLoopEvent {
  type: "agent_dialogue_message";
  dialogue: Record<string, unknown>;
  message: ChatMessage;
}

export interface WebSocketLoopEndEvent {
  type: "agent_dialogue_ended";
  dialogue: Record<string, unknown>;
}

export type RoomSocketEvent =
  | WebSocketMessageEvent
  | WebSocketSystemEvent
  | WebSocketTypingEvent
  | WebSocketLoopEvent
  | WebSocketLoopEndEvent
  | { type: "presence_snapshot"; room_id?: string; participants: PresenceParticipant[] }
  | { type: "user_online" | "user_offline"; room_id?: string; participant: PresenceParticipant }
  | { type: "task_update"; task: RoomTaskPatch }
  | TaskProgressEvent
  | { type: "pong" };

// ── 团队配置 ────────────────────────────────────────────

export interface TeamRoleConfig {
  name: string;
  agent_name: string;
  responsibilities: string[];
  focus_areas: string[];
  ignore_areas: string[];
}

export interface TeamConfig {
  title: string;
  roles: TeamRoleConfig[];
  rules: string[];
}
