import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthStore } from "../stores/authStore";
import { useChatStore } from "../stores/chatStore";

const PERMISSION_KEY = "mapr-notification-enabled";

export function useNotification(roomId: string) {
  const seenIds = useRef<Set<string> | null>(null);
  const messages = useChatStore((state) => state.messages);
  const [enabled, setEnabledState] = useState(
    () => localStorage.getItem(PERMISSION_KEY) === "true"
        && typeof Notification !== "undefined"
        && Notification.permission === "granted"
  );

  const requestPermission = useCallback(async () => {
    if (typeof Notification === "undefined") return false;
    const result = await Notification.requestPermission();
    const granted = result === "granted";
    setEnabledState(granted);
    localStorage.setItem(PERMISSION_KEY, granted ? "true" : "false");
    return granted;
  }, []);

  useEffect(() => {
    if (!enabled || !roomId) return;

    // First pass marks history as seen; only later arrivals notify.
    if (seenIds.current === null) {
      seenIds.current = new Set(messages.map((msg) => msg.id));
      return;
    }

    const newMessages = messages.filter((msg) => !seenIds.current!.has(msg.id));
    for (const msg of newMessages) seenIds.current!.add(msg.id);
    // Bound memory: keep the newest few thousand IDs.
    if (seenIds.current.size > 5000) {
      seenIds.current = new Set(messages.slice(-2000).map((msg) => msg.id));
    }

    for (const msg of newMessages) {
      // Don't notify for own messages or system
      const user = useAuthStore.getState().user;
      if (msg.sender_id === user?.id || msg.sender_type === "system") continue;
      if (msg.sender_type !== "agent") continue; // Only agent replies

      try {
        new Notification(`🤖 ${msg.sender_name ?? "Agent"} 回复了`, {
          body: msg.content.slice(0, 120),
          tag: msg.id,
          silent: false,
        });
      } catch {
        // Notification API may not be available
      }
    }
  }, [messages, enabled, roomId]);

  return { enabled, requestPermission };
}
