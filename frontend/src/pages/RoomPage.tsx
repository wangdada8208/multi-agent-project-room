import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useWebSocket } from "../hooks/useWebSocket";
import { useAuthStore } from "../stores/authStore";
import { useChatStore } from "../stores/chatStore";
import { useRoomStore } from "../stores/roomStore";
import type { ChatMessage, SenderType } from "../types/chat";

const SENDER_ID_KEY = "mapr-sender-id";

function getOrCreateSenderId(): string {
  let id = localStorage.getItem(SENDER_ID_KEY);
  if (!id) {
    id = `user-${Math.random().toString(16).slice(2, 8)}`;
    localStorage.setItem(SENDER_ID_KEY, id);
  }
  return id;
}

async function fetchMessages(roomId: string): Promise<ChatMessage[]> {
  const res = await fetch(`/api/v1/rooms/${roomId}/messages`);
  const data = await res.json();
  return data.messages ?? data.data ?? [];
}

const statusLabel: Record<string, string> = {
  connecting: "连接中...",
  open: "已连接",
  closed: "已断开",
  error: "连接错误",
  idle: "等待中",
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

  const messagesQuery = useQuery({
    queryKey: ["rooms", roomId, "messages"],
    queryFn: () => fetchMessages(roomId),
    enabled: !!roomId,
  });

  useEffect(() => {
    if (messagesQuery.data) setMessages(messagesQuery.data);
  }, [messagesQuery.data, setMessages]);

  useEffect(() => {
    setActiveRoomId(roomId);
  }, [roomId, setActiveRoomId]);

  function handleSend(content: string, senderType: SenderType) {
    return sendMessage({ content, senderId, senderType });
  }

  return (
    <section className="chat-page">
      <header className="chat-header">
        <div>
          <Link to="/rooms" className="back-link">← 返回房间列表</Link>
          <div className="room-name">房间 {roomId.slice(0, 12)}</div>
          <div className="room-sub">{displayName}</div>
        </div>
        <span className={`status-badge ${connectionStatus}`}>
          <span className="dot" />
          {statusLabel[connectionStatus] || connectionStatus}
        </span>
      </header>

      {messagesQuery.isError && (
        <div className="empty-state">
          <p style={{ color: "#dc2626" }}>加载消息失败，请检查连接。</p>
        </div>
      )}

      <MessageList messages={messages} userId={senderId} />
      <MessageInputArea
        disabled={connectionStatus !== "open"}
        onSend={handleSend}
      />
    </section>
  );
}

/* ── 消息列表 ── */

function MessageList({ messages, userId }: { messages: ChatMessage[]; userId: string }) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div className="message-list" ref={listRef}>
      {messages.length === 0 && (
        <div className="empty-state">
          <p>暂无消息，发送第一条消息开始对话。</p>
        </div>
      )}
      {messages.map((msg) => {
        const isOwn = msg.sender_id === userId;
        const isAgent = msg.sender_type === "agent";
        const isSystem = msg.msg_type === "system";
        return (
          <div key={msg.id} className={`message-row${isOwn ? " own" : ""}`}>
            <div className={`message-bubble${isAgent ? " agent" : ""}${isSystem ? " system" : ""}`}>
              {!isSystem && (
                <div className="message-meta">
                  <span className="sender">
                    {isAgent ? "🤖 " : ""}
                    {msg.sender_id === userId ? "我" : msg.sender_id.slice(0, 8)}
                  </span>
                  <span>
                    {msg.created_at
                      ? new Date(msg.created_at).toLocaleTimeString("zh-CN", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : ""}
                  </span>
                </div>
              )}
              <p>{msg.content}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── 输入区域 ── */

function MessageInputArea({
  disabled,
  onSend,
}: {
  disabled: boolean;
  onSend: (content: string, senderType: SenderType) => boolean;
}) {
  const [text, setText] = useState("");
  const [senderType, setSenderType] = useState<SenderType>("human");

  function handleSubmit() {
    if (!text.trim() || disabled) return;
    onSend(text.trim(), senderType);
    setText("");
  }

  return (
    <div className="message-input-area">
      <select value={senderType} onChange={(e) => setSenderType(e.target.value as SenderType)}>
        <option value="human">人类</option>
        <option value="agent">智能体</option>
      </select>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }}
        placeholder={disabled ? "等待连接..." : "输入消息... @Claude 或 @Codex 触发 AI"}
        disabled={disabled}
      />
      <button onClick={handleSubmit} disabled={disabled || !text.trim()}>
        发送
      </button>
    </div>
  );
}
