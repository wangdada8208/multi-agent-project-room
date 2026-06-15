import { useEffect, useMemo } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { MessageInput } from "../components/chat/MessageInput";
import { MessageList } from "../components/chat/MessageList";
import { useWebSocket } from "../hooks/useWebSocket";
import { fetchMessages } from "../lib/api";
import { useAuthStore } from "../stores/authStore";
import { useChatStore } from "../stores/chatStore";
import { useRoomStore } from "../stores/roomStore";
import type { SenderType } from "../types/chat";

export function RoomPage() {
  const params = useParams();
  const roomId = params.roomId ?? "demo-room";
  const senderId = useMemo(() => `codex-ui-${Math.random().toString(16).slice(2, 8)}`, []);

  const { sendMessage } = useWebSocket(roomId);
  const messages = useChatStore((state) => state.messages);
  const connectionStatus = useChatStore((state) => state.connectionStatus);
  const setMessages = useChatStore((state) => state.setMessages);
  const displayName = useAuthStore((state) => state.displayName);
  const setActiveRoomId = useRoomStore((state) => state.setActiveRoomId);

  const messagesQuery = useQuery({
    queryKey: ["rooms", roomId, "messages"],
    queryFn: () => fetchMessages(roomId),
  });

  useEffect(() => {
    if (messagesQuery.data) {
      setMessages(messagesQuery.data);
    }
  }, [messagesQuery.data, setMessages]);

  useEffect(() => {
    setActiveRoomId(roomId);
  }, [roomId, setActiveRoomId]);

  function handleSend(content: string, senderType: SenderType) {
    return sendMessage({ content, senderId, senderType });
  }

  return (
    <section className="room-page">
      <header className="room-header">
        <div>
          <p className="eyebrow">Room</p>
          <h2>{roomId}</h2>
          <p className="room-subtitle">Signed in as {displayName}</p>
        </div>
        <span className={`connection-pill ${connectionStatus}`}>{connectionStatus}</span>
      </header>

      {messagesQuery.isError && (
        <div className="error-text">Message history failed to load.</div>
      )}

      <MessageList messages={messages} />
      <MessageInput disabled={connectionStatus !== "open"} onSend={handleSend} />
    </section>
  );
}
