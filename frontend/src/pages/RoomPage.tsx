import { useEffect, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { MessageInput } from "../components/chat/MessageInput";
import { MessageList } from "../components/chat/MessageList";
import { useWebSocket } from "../hooks/useWebSocket";
import { fetchMessages } from "../lib/api";
import { useAuthStore } from "../stores/authStore";
import { useChatStore } from "../stores/chatStore";
import { useRoomStore } from "../stores/roomStore";
import type { SenderType } from "../types/chat";

const SENDER_ID_KEY = "mapr-sender-id";

function getOrCreateSenderId(): string {
  let id = localStorage.getItem(SENDER_ID_KEY);
  if (!id) {
    id = `user-${Math.random().toString(16).slice(2, 8)}`;
    localStorage.setItem(SENDER_ID_KEY, id);
  }
  return id;
}

const statusLabel: Record<string, string> = {
  connecting: "Connecting...",
  open: "Connected",
  closed: "Disconnected",
  error: "Error",
  idle: "Idle",
};

export function RoomPage() {
  const params = useParams();
  const roomId = params.roomId ?? "demo-room";
  const senderId = useMemo(getOrCreateSenderId, []);

  const { sendMessage } = useWebSocket(roomId);
  const messages = useChatStore((state) => state.messages);
  const connectionStatus = useChatStore((state) => state.connectionStatus);
  const setMessages = useChatStore((state) => state.setMessages);
  const displayName = useAuthStore((state) => state.displayName);
  const setActiveRoomId = useRoomStore((state) => state.setActiveRoomId);
  const activeRoomId = useRoomStore((state) => state.activeRoomId);

  const messagesQuery = useQuery({
    queryKey: ["rooms", roomId, "messages"],
    queryFn: () => fetchMessages(roomId),
    enabled: !!roomId,
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

  const statusClass =
    connectionStatus === "open"
      ? "open"
      : connectionStatus === "connecting"
      ? "connecting"
      : "closed";

  return (
    <section className="room-page">
      <header className="room-header">
        <div>
          <Link
            to="/rooms"
            style={{ color: "#93c5fd", fontSize: 13, marginBottom: 4, display: "inline-block" }}
          >
            ← Back to rooms
          </Link>
          <h2 style={{ margin: 0, fontSize: 20 }}>{roomId.slice(0, 16)}...</h2>
          <p className="room-subtitle">Signed in as {displayName}</p>
        </div>
        <span className={`connection-pill ${statusClass}`}>
          <span
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              borderRadius: "50%",
              marginRight: 6,
              background:
                connectionStatus === "open"
                  ? "#22c55e"
                  : connectionStatus === "connecting"
                  ? "#eab308"
                  : "#ef4444",
            }}
          />
          {statusLabel[connectionStatus] || connectionStatus}
        </span>
      </header>

      {messagesQuery.isError && (
        <div className="message-list" style={{ justifyContent: "center", textAlign: "center" }}>
          <p style={{ color: "#f87171" }}>Failed to load messages.</p>
          <p style={{ color: "#64748b", fontSize: 13 }}>Make sure the backend server is running.</p>
        </div>
      )}

      <MessageList messages={messages} />
      <MessageInput disabled={connectionStatus !== "open"} onSend={handleSend} />
    </section>
  );
}
