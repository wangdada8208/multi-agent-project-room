import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthStore } from "../stores/authStore";
import { useChatStore } from "../stores/chatStore";
import type { ChatMessage } from "../types/chat";

const PERMISSION_KEY = "mapr-notification-enabled";

export interface UseNotificationOptions {
  ready?: boolean;
  scopeKey?: string;
}

export interface NotificationTrackerState {
  scopeKey?: string;
  initialized: boolean;
  seenIds: Set<string>;
}

export interface NotificationPayload {
  title: string;
  body: string;
  tag: string;
}

export function createNotificationTrackerState(): NotificationTrackerState {
  return {
    scopeKey: undefined,
    initialized: false,
    seenIds: new Set(),
  };
}

export function evaluateNotificationPayloads(
  tracker: NotificationTrackerState,
  params: {
    messages: ChatMessage[];
    scopeKey: string;
    ready: boolean;
    enabled: boolean;
    currentUserId?: string;
  },
): NotificationPayload[] {
  const { messages, scopeKey, ready, enabled, currentUserId } = params;

  if (tracker.scopeKey !== scopeKey) {
    tracker.scopeKey = scopeKey;
    tracker.initialized = false;
    tracker.seenIds = new Set();
  }

  if (!scopeKey) return [];

  // While history is still loading (ready === false), keep syncing IDs without notifying.
  if (!ready) {
    for (const msg of messages) {
      tracker.seenIds.add(msg.id);
    }
    tracker.initialized = false;
    return [];
  }

  // First ready pass marks all existing history as seen without firing notifications.
  if (!tracker.initialized) {
    for (const msg of messages) {
      tracker.seenIds.add(msg.id);
    }
    tracker.initialized = true;
    return [];
  }

  const newMessages = messages.filter((msg) => !tracker.seenIds.has(msg.id));
  for (const msg of newMessages) {
    tracker.seenIds.add(msg.id);
  }
  if (tracker.seenIds.size > 5000) {
    tracker.seenIds = new Set(messages.slice(-2000).map((msg) => msg.id));
  }

  if (!enabled) return [];

  const payloads: NotificationPayload[] = [];
  for (const msg of newMessages) {
    if (msg.sender_id === currentUserId || msg.sender_type === "system") continue;
    if (msg.sender_type !== "agent") continue;

    payloads.push({
      title: `${msg.sender_name ?? "Agent"} 回复了`,
      body: msg.content.slice(0, 120),
      tag: msg.id,
    });
  }
  return payloads;
}

export function useNotification(
  messagesOrRoomId: ChatMessage[] | string,
  options?: UseNotificationOptions,
) {
  const storeMessages = useChatStore((state) => state.messages);
  const messages = Array.isArray(messagesOrRoomId)
    ? messagesOrRoomId
    : storeMessages.filter((m) => m.room_id === messagesOrRoomId);
  const scopeKey =
    options?.scopeKey ?? (typeof messagesOrRoomId === "string" ? messagesOrRoomId : "");
  const ready = options?.ready ?? true;

  const trackerRef = useRef<NotificationTrackerState>(createNotificationTrackerState());

  const [enabled, setEnabledState] = useState(
    () =>
      typeof localStorage !== "undefined" &&
      typeof localStorage?.getItem === "function" &&
      localStorage.getItem(PERMISSION_KEY) === "true" &&
      typeof Notification !== "undefined" &&
      Notification.permission === "granted",
  );

  const requestPermission = useCallback(async () => {
    if (typeof Notification === "undefined") return false;
    const result = await Notification.requestPermission();
    const granted = result === "granted";
    setEnabledState(granted);
    if (typeof localStorage !== "undefined" && typeof localStorage?.setItem === "function") {
      localStorage.setItem(PERMISSION_KEY, granted ? "true" : "false");
    }
    return granted;
  }, []);

  useEffect(() => {
    const payloads = evaluateNotificationPayloads(trackerRef.current, {
      messages,
      scopeKey,
      ready,
      enabled,
      currentUserId: useAuthStore.getState().user?.id,
    });

    for (const payload of payloads) {
      try {
        new Notification(payload.title, {
          body: payload.body,
          tag: payload.tag,
          silent: false,
        });
      } catch {
        // Notification API may not be available
      }
    }
  }, [messages, enabled, scopeKey, ready]);

  return { enabled, requestPermission };
}
