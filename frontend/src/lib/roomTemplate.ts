import type { Room } from "../types/chat";

const storageKey = (id: string) => `mapr-room-template:${id}`;

export function rememberRoomTemplate(room: Room, templateKey: string) {
  try {
    sessionStorage.setItem(storageKey(room.id), templateKey);
  } catch {
    // A template label is optional when storage is unavailable.
  }
}

export function roomTemplateKey(room: Room | undefined): string | undefined {
  if (!room) return undefined;
  const serverKey = room.settings_json?.template_key;
  if (typeof serverKey === "string" && serverKey.length) return serverKey;
  try {
    return sessionStorage.getItem(storageKey(room.id)) ?? undefined;
  } catch {
    return undefined;
  }
}
