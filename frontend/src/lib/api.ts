import type { ChatMessage, Room } from "../types/chat";

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
