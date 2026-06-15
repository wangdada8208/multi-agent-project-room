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
  created_at: string;
}

export interface ChatMessage {
  id: string;
  room_id: string;
  sender_id: string;
  sender_type: SenderType;
  content: string;
  msg_type: MessageType;
  created_at: string;
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
  | { type: "pong" };
