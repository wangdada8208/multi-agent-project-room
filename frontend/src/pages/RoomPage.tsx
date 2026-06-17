import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useWebSocket } from "../hooks/useWebSocket";
import { AgentPanel } from "../components/agent/AgentPanel";
import { KnowledgePanel } from "../components/knowledge/KnowledgePanel";
import { RepositoryPanel } from "../components/repository/RepositoryPanel";
import { ApprovalPanel } from "../components/approval/ApprovalPanel";
import { fetchMessages, fetchTasks } from "../lib/api";
import { useAuthStore } from "../stores/authStore";
import { useChatStore } from "../stores/chatStore";
import { useRoomStore } from "../stores/roomStore";
import type { ChatMessage, PresenceParticipant, RoomTask, SenderType } from "../types/chat";

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
  const typingUsers = useChatStore((state) => state.typingUsers);
  const participants = useChatStore((state) => state.participants);
  const tasks = useChatStore((state) => state.tasks);
  const setMessages = useChatStore((state) => state.setMessages);
  const setTasks = useChatStore((state) => state.setTasks);
  const displayName = useAuthStore((state) => state.displayName);
  const user = useAuthStore((state) => state.user);
  const setActiveRoomId = useRoomStore((state) => state.setActiveRoomId);

  const messagesQuery = useQuery({
    queryKey: ["rooms", roomId, "messages"],
    queryFn: () => fetchMessages(roomId),
    enabled: !!roomId,
  });

  useEffect(() => {
    if (messagesQuery.data) setMessages(messagesQuery.data);
  }, [messagesQuery.data, setMessages]);

  const tasksQuery = useQuery({
    queryKey: ["rooms", roomId, "tasks"],
    queryFn: () => fetchTasks(roomId),
    enabled: !!roomId,
    refetchInterval: 15000,
  });

  useEffect(() => {
    if (tasksQuery.data) setTasks(tasksQuery.data);
  }, [tasksQuery.data, setTasks]);

  useEffect(() => {
    setActiveRoomId(roomId);
  }, [roomId, setActiveRoomId]);

  function handleSend(content: string, senderType: SenderType) {
    return sendMessage({ content, senderId: user?.id ?? senderId, senderType });
  }

  return (
    <div className="room-workspace">
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

        {messagesQuery.isLoading && (
          <div className="empty-state">
            <p>加载消息历史中...</p>
          </div>
        )}

        {!messagesQuery.isLoading && (
          <MessageList messages={messages} userId={senderId} />
        )}
        {typingUsers.length > 0 && (
          <div className="typing-line">
            {typingUsers.slice(-3).join("、")} 正在输入...
          </div>
        )}
        <MessageInputArea
          disabled={connectionStatus !== "open"}
          onSend={handleSend}
        />
      </section>

      <aside className="collab-panel">
        <PresencePanel participants={participants} />
        <TaskPanel tasks={tasks} />
        <AgentPanel />
        <KnowledgePanel roomId={roomId} />
        <RepositoryPanel roomId={roomId} />
        <ApprovalPanel roomId={roomId} />
      </aside>
    </div>
  );
}

function PresencePanel({ participants }: { participants: PresenceParticipant[] }) {
  const humans = participants.filter((item) => item.sender_type === "human");
  const agents = participants.filter((item) => item.sender_type === "agent");
  return (
    <section className="side-card">
      <div className="side-title">在线成员</div>
      <div className="presence-grid">
        {[...humans, ...agents].map((participant) => (
          <div className="presence-item" key={participant.sender_id}>
            <span className={`agent-dot ${participant.sender_type === "agent" ? "busy" : "online"}`} />
            <span>{participant.sender_name}</span>
            <small>{participant.sender_type === "agent" ? "Agent" : "Human"}</small>
          </div>
        ))}
        {participants.length === 0 && <p className="muted">等待成员进入房间...</p>}
      </div>
    </section>
  );
}

const taskStatusLabel: Record<string, string> = {
  submitted: "已提交",
  working: "处理中",
  input_required: "待审批",
  completed: "已完成",
  failed: "失败",
  canceled: "已取消",
};

function TaskPanel({ tasks }: { tasks: RoomTask[] }) {
  return (
    <section className="side-card">
      <div className="side-title">任务</div>
      {tasks.slice(0, 6).map((task) => (
        <div className="task-card" key={task.id}>
          <div className="task-top">
            <strong>{task.target_agent || task.source_agent}</strong>
            <span className={`task-status ${task.status}`}>{taskStatusLabel[task.status] || task.status}</span>
          </div>
          <p>{task.query}</p>
          {task.approval_id && <small>审批: {task.approval_id.slice(0, 8)}</small>}
        </div>
      ))}
      {tasks.length === 0 && <p className="muted">暂无任务，@Agent 后会出现在这里。</p>}
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
        const senderDisplay = msg.sender_name || msg.sender_id.slice(0, 8);
        return (
          <div key={msg.id} className={`message-row${isOwn ? " own" : ""}`}>
            <div className={`message-bubble${isAgent ? " agent" : ""}${isSystem ? " system" : ""}`}>
              {!isSystem && (
                <div className="message-meta">
                  <span className="sender">
                    {isAgent ? "🤖 " : ""}
                    {isOwn ? "我" : senderDisplay}
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
              <MessageContent content={msg.content} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MessageContent({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <div className="markdown-content">
      {lines.map((line, index) => {
        if (line.startsWith("### ")) return <h3 key={index}>{line.slice(4)}</h3>;
        if (line.startsWith("## ")) return <h2 key={index}>{line.slice(3)}</h2>;
        if (line.startsWith("# ")) return <h1 key={index}>{line.slice(2)}</h1>;
        if (line.startsWith("- ")) return <li key={index}>{line.slice(2)}</li>;
        if (line.trim() === "") return <br key={index} />;
        return <p key={index}>{line}</p>;
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
  const inputRef = useRef<HTMLInputElement>(null);

  function insertMention(agent: string) {
    setText((prev) => {
      const mention = `@${agent} `;
      if (!prev.trim()) return mention;
      if (prev.includes(`@${agent}`)) return prev;
      return mention + prev;
    });
    inputRef.current?.focus();
  }

  function handleSubmit() {
    if (!text.trim() || disabled) return;
    onSend(text.trim(), "human");
    setText("");
  }

  return (
    <div className="message-input-area">
      <div className="mention-buttons">
        <button
          type="button"
          className="mention-btn claude"
          onClick={() => insertMention("Claude")}
          disabled={disabled}
          title="插入 @Claude"
        >
          🤖 @Claude
        </button>
        <button
          type="button"
          className="mention-btn codex"
          onClick={() => insertMention("Codex")}
          disabled={disabled}
          title="插入 @Codex"
        >
          🤖 @Codex
        </button>
      </div>
      <input
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }}
        placeholder={disabled ? "等待连接..." : "输入消息... 或点 @Claude / @Codex 快速呼叫"}
        disabled={disabled}
      />
      <button onClick={handleSubmit} disabled={disabled || !text.trim()}>
        发送
      </button>
    </div>
  );
}
