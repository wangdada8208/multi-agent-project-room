import { useCallback, useEffect, useMemo, useRef } from "react";
import { useChatStore } from "../stores/chatStore";
import type { ChatMessage, MessageType, RoomSocketEvent, SenderType } from "../types/chat";

import { useAuthStore } from "../stores/authStore";
import { websocketUrl, apiFetch } from "../lib/api";

interface SendMessageInput {
  content: string;
  senderId: string;
  senderType: SenderType;
  msgType?: MessageType;
}

function getWebSocketUrl(roomId: string): string {
  const token = localStorage.getItem("mapr-auth-token") ?? "";
  return websocketUrl(`/ws/chat/${roomId}?token=${encodeURIComponent(token)}`);
}

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 10000;

function getReconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_BASE_DELAY_MS * 2 ** Math.max(attempt - 1, 0), RECONNECT_MAX_DELAY_MS);
}

async function fetchMissedMessages(roomId: string, afterTimestamp: string | null): Promise<ChatMessage[]> {
  try {
    const params = new URLSearchParams({ limit: "100" });
    if (afterTimestamp) params.set("after", afterTimestamp);
    const res = await apiFetch(`/api/v1/rooms/${roomId}/messages?${params}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.messages ?? [];
  } catch {
    return [];
  }
}

export function useWebSocket(roomId: string) {
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const lastDisconnectRef = useRef<string | null>(null);
  const addMessage = useChatStore((state) => state.addMessage);
  const markTyping = useChatStore((state) => state.markTyping);
  const setParticipants = useChatStore((state) => state.setParticipants);
  const upsertParticipant = useChatStore((state) => state.upsertParticipant);
  const removeParticipant = useChatStore((state) => state.removeParticipant);
  const upsertTask = useChatStore((state) => state.upsertTask);
  const setConnectionStatus = useChatStore((state) => state.setConnectionStatus);

  useEffect(() => {
    let disposed = false;

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const scheduleReconnect = (socket: WebSocket) => {
      if (disposed || reconnectTimerRef.current !== null) return;
      if (socketRef.current === socket) socketRef.current = null;

      // Record when we lost connection so we can catch up later
      lastDisconnectRef.current = new Date().toISOString();

      reconnectAttemptRef.current += 1;
      const delay = getReconnectDelay(reconnectAttemptRef.current);
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        if (!disposed) connect();
      }, delay);
    };

    const catchUpMissedMessages = async () => {
      const since = lastDisconnectRef.current;
      if (!since) return; // First connect, no gap to fill
      const missed = await fetchMissedMessages(roomId, since);
      for (const msg of missed) {
        addMessage(msg); // addMessage already deduplicates by ID
      }
      lastDisconnectRef.current = null; // Reset after successful catch-up
    };

    const connect = () => {
      clearReconnectTimer();
      const token = localStorage.getItem("mapr-auth-token");
      if (!token) {
        setConnectionStatus("idle");
        return;
      }
      setConnectionStatus("connecting");

      const socket = new WebSocket(getWebSocketUrl(roomId));
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        if (disposed || socketRef.current !== socket) return;
        reconnectAttemptRef.current = 0;
        setConnectionStatus("open");
        const auth = useAuthStore.getState();
        if (auth.user) {
          socket.send(JSON.stringify({
            type: "identify",
            sender_id: auth.user.id,
            sender_name: auth.user.display_name,
            sender_type: auth.user.user_type,
          }));
        }
        // Fetch messages sent while disconnected
        catchUpMissedMessages();
      });

      socket.addEventListener("close", (event) => {
        if (disposed || socketRef.current !== socket) return;
        setConnectionStatus("closed");
        if (event.code === 4001) {
          // Authentication required; do not endlessly hammer the server
          return;
        }
        scheduleReconnect(socket);
      });

      socket.addEventListener("error", () => {
        if (disposed || socketRef.current !== socket) return;
        setConnectionStatus("error");
        scheduleReconnect(socket);
        socket.close();
      });

      socket.addEventListener("message", (event) => {
        let payload: RoomSocketEvent;
        try {
          payload = JSON.parse(event.data);
        } catch (error) {
          console.warn("Failed to parse room socket event", error);
          return;
        }

        if (payload.type === "message" && payload.message) {
          addMessage(payload.message);
        }

        if (payload.type === "system" && payload.content) {
          addMessage({
            id: `sys-${Date.now()}`,
            room_id: roomId,
            sender_id: "system",
            sender_type: "system",
            content: payload.content,
            msg_type: "system",
            created_at: new Date().toISOString(),
          });
        }

        if (payload.type === "typing") {
          markTyping(payload.sender_id);
        }

        if (payload.type === "presence_snapshot") {
          setParticipants(payload.participants ?? []);
        }

        if (payload.type === "user_online" && payload.participant) {
          upsertParticipant(payload.participant);
        }

        if (payload.type === "user_offline" && payload.participant) {
          removeParticipant(payload.participant.sender_id);
        }

        if (payload.type === "task_update" && payload.task) {
          upsertTask(payload.task);
        }

        if (payload.type === "agent_dialogue_message" && payload.message) {
          addMessage(payload.message);
        }

        if (payload.type === "agent_dialogue_ended") {
          console.log("Dialogue ended", payload.dialogue);
        }
      });
    };

    connect();

    return () => {
      disposed = true;
      clearReconnectTimer();
      const socket = socketRef.current;
      if (socket) {
        socketRef.current = null;
        socket.close();
      }
    };
  }, [addMessage, markTyping, removeParticipant, roomId, setConnectionStatus, setParticipants, upsertParticipant, upsertTask]);

  const sendMessage = useCallback((input: SendMessageInput) => {
    const socket = socketRef.current;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    const displayName = useAuthStore.getState().displayName;
    const user = useAuthStore.getState().user;

    socket.send(
      JSON.stringify({
        type: "message",
        sender_id: user?.id ?? input.senderId,
        sender_type: input.senderType,
        sender_name: user?.display_name ?? displayName,
        msg_type: input.msgType ?? "text",
        content: input.content,
      }),
    );

    return true;
  }, []);

  return useMemo(() => ({ sendMessage }), [sendMessage]);
}
