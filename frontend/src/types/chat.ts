export type SenderType = "human" | "agent" | "system";

export type MessageType =
  | "text"
  | "system"
  | "task"
  | "proposal"
  | "report"
  | "approval_request";

export interface Room {
  id: string;
  name: string;
  description: string;
  created_by?: string | null;
  created_at: string;
}

export interface ChatMessage {
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
}

export interface RoomTask {
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

export type RoomSocketEvent =
  | WebSocketMessageEvent
  | WebSocketSystemEvent
  | WebSocketTypingEvent
  | { type: "presence_snapshot"; participants: PresenceParticipant[] }
  | { type: "user_online" | "user_offline"; participant: PresenceParticipant }
  | { type: "task_update"; task: RoomTask }
  | { type: "pong" };
