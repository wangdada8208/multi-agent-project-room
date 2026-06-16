import { useCallback, useEffect, useMemo, useRef } from "react";
import { useChatStore } from "../stores/chatStore";
import type { ChatMessage, MessageType, RoomSocketEvent, SenderType } from "../types/chat";

import { useAuthStore } from "../stores/authStore";

interface SendMessageInput {
  content: string;
  senderId: string;
  senderType: SenderType;
  msgType?: MessageType;
}

function getWebSocketUrl(roomId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}/ws/chat/${roomId}`;
}

export function useWebSocket(roomId: string) {
  const socketRef = useRef<WebSocket | null>(null);
  const addMessage = useChatStore((state) => state.addMessage);
  const markTyping = useChatStore((state) => state.markTyping);
  const setConnectionStatus = useChatStore((state) => state.setConnectionStatus);

  useEffect(() => {
    setConnectionStatus("connecting");

    const socket = new WebSocket(getWebSocketUrl(roomId));
    socketRef.current = socket;

    socket.addEventListener("open", () => setConnectionStatus("open"));
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
    });

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [addMessage, markTyping, roomId, setConnectionStatus]);

  const sendMessage = useCallback((input: SendMessageInput) => {
    const socket = socketRef.current;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    const displayName = useAuthStore.getState().displayName;

    socket.send(
      JSON.stringify({
        type: "message",
        sender_id: input.senderId,
        sender_type: input.senderType,
        sender_name: displayName,
        msg_type: input.msgType ?? "text",
        content: input.content,
      }),
    );

    return true;
  }, []);

  return useMemo(() => ({ sendMessage }), [sendMessage]);
}
