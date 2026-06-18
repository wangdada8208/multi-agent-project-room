import { useCallback, useEffect, useMemo, useRef } from "react";
import { useChatStore } from "../stores/chatStore";
import type { ChatMessage, MessageType, RoomSocketEvent, SenderType } from "../types/chat";

import { useAuthStore } from "../stores/authStore";
import { websocketUrl } from "../lib/api";

interface SendMessageInput {
  content: string;
  senderId: string;
  senderType: SenderType;
  msgType?: MessageType;
}

function getWebSocketUrl(roomId: string): string {
  return websocketUrl(`/ws/chat/${roomId}`);
}

export function useWebSocket(roomId: string) {
  const socketRef = useRef<WebSocket | null>(null);
  const addMessage = useChatStore((state) => state.addMessage);
  const markTyping = useChatStore((state) => state.markTyping);
  const setParticipants = useChatStore((state) => state.setParticipants);
  const upsertParticipant = useChatStore((state) => state.upsertParticipant);
  const removeParticipant = useChatStore((state) => state.removeParticipant);
  const upsertTask = useChatStore((state) => state.upsertTask);
  const setConnectionStatus = useChatStore((state) => state.setConnectionStatus);

  useEffect(() => {
    setConnectionStatus("connecting");

    const socket = new WebSocket(getWebSocketUrl(roomId));
    socketRef.current = socket;

    socket.addEventListener("open", () => {
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
    });
    socket.addEventListener("close", () => setConnectionStatus("closed"));
    socket.addEventListener("error", () => setConnectionStatus("error"));
    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data);

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
    });

    return () => {
      socket.close();
      socketRef.current = null;
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
