import { useCallback, useEffect, useRef, useState } from "react";
import { useChatStore } from "../stores/chatStore";

const PERMISSION_KEY = "mapr-notification-enabled";

export function useNotification(roomId: string) {
  const lastMessageCount = useRef(0);
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

    // Only notify for NEW messages since mount
    if (lastMessageCount.current === 0) {
      lastMessageCount.current = messages.length;
      return;
    }

    const newMessages = messages.slice(lastMessageCount.current);
    lastMessageCount.current = messages.length;

    for (const msg of newMessages) {
      // Don't notify for own messages or system
      const user = JSON.parse(localStorage.getItem("mapr-user") ?? "{}");
      if (msg.sender_id === user.id || msg.sender_type === "system") continue;
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
