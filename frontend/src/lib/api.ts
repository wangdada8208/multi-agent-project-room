import type { ChatMessage, Room } from "../types/chat";

export async function fetchRooms(): Promise<Room[]> {
  const response = await fetch("/api/v1/rooms");

  if (!response.ok) {
    throw new Error("Failed to load rooms");
  }

  const payload = (await response.json()) as { rooms?: Room[]; data?: Room[] };
  return payload.data ?? payload.rooms ?? [];
}

export async function fetchMessages(roomId: string): Promise<ChatMessage[]> {
  const response = await fetch(`/api/v1/rooms/${roomId}/messages`);

  if (!response.ok) {
    throw new Error("Failed to load messages");
  }

  const payload = (await response.json()) as {
    messages?: ChatMessage[];
    data?: ChatMessage[];
  };
  return payload.data ?? payload.messages ?? [];
}
