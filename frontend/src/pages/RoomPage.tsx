import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useWebSocket } from "../hooks/useWebSocket";
import { SidePanel } from "../components/panels/SidePanel";
import { MembersPanel } from "../components/panels/MembersPanel";
import { TasksPanel } from "../components/panels/TasksPanel";
import { DialoguePanel } from "../components/panels/DialoguePanel";
import { FilesPanel } from "../components/panels/FilesPanel";
import { TeamPanel } from "../components/panels/TeamPanel";
import { MessageItem } from "../components/chat/MessageItem";
import { ChatInput } from "../components/chat/ChatInput";
import { useNotification } from "../hooks/useNotification";
import { fetchMessages, fetchAgents, fetchTasks } from "../lib/api";
import { useAuthStore } from "../stores/authStore";
import { useChatStore } from "../stores/chatStore";
import type { SenderType } from "../types/chat";

const CONNECTION_LABEL: Record<string, string> = {
  connecting: "连接中...",
  open: "已连接",
  closed: "已断开",
  error: "连接错误",
  idle: "等待中",
};

export function RoomPage() {
  const params = useParams();
  const roomId = params.roomId ?? "demo-room";

  const { sendMessage } = useWebSocket(roomId);
  const { enabled: notifEnabled, requestPermission: requestNotifPermission } = useNotification(roomId);
  const user = useAuthStore((state) => state.user);
  const messages = useChatStore((state) => state.messages);
  const setMessages = useChatStore((state) => state.setMessages);
  const connectionStatus = useChatStore((state) => state.connectionStatus);
  const participants = useChatStore((state) => state.participants);
  const tasks = useChatStore((state) => state.tasks);
  const setTasks = useChatStore((state) => state.setTasks);

  // Fetch messages
  const messagesQuery = useQuery({
    queryKey: ["rooms", roomId, "messages"],
    queryFn: () => fetchMessages(roomId),
    enabled: !!roomId,
  });
  useEffect(() => {
    if (messagesQuery.data) setMessages(messagesQuery.data);
  }, [messagesQuery.data, setMessages]);

  // Fetch tasks
  const tasksQuery = useQuery({
    queryKey: ["rooms", roomId, "tasks"],
    queryFn: () => fetchTasks(roomId),
    enabled: !!roomId,
    refetchInterval: 15000,
  });
  useEffect(() => {
    if (tasksQuery.data) setTasks(tasksQuery.data);
  }, [tasksQuery.data, setTasks]);

  // Fetch agents for mention buttons
  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: fetchAgents,
    refetchInterval: 30000,
  });

  const onlineAgentNames = useMemo(() => {
    const wsAgents = participants
      .filter((p) => p.sender_type === "agent")
      .map((p) => p.sender_name || p.sender_id);
    if (wsAgents.length > 0) return wsAgents;
    return (agentsQuery.data ?? []).map((a) => a.name).slice(0, 4);
  }, [participants, agentsQuery.data]);

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages.length]);

  const handleSend = (content: string, senderType: SenderType) =>
    sendMessage({ content, senderId: user?.id ?? "anon", senderType });

  return (
    <div className="room-layout">
      {/* ── 聊天区 ── */}
      <section className="chat-area">
        <header className="chat-area__header">
          <Link to="/rooms" className="chat-area__back">←</Link>
          <span className="chat-area__title">房间</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
            {!notifEnabled && (
              <button type="button" onClick={requestNotifPermission} title="开启 Agent 回复通知" style={{ fontSize: 16, background: "none", border: "none", cursor: "pointer" }}>
                🔔
              </button>
            )}
            <span className={`chat-area__status chat-area__status--${connectionStatus}`}>
              <span className="dot" />
              {CONNECTION_LABEL[connectionStatus]}
            </span>
          </div>
        </header>

        <div className="chat-area__messages" ref={listRef}>
          {messagesQuery.isLoading && <p className="chat-loading">加载消息...</p>}
          {messagesQuery.isError && <p className="chat-error">加载失败，请刷新重试。</p>}
          {!messagesQuery.isLoading && messages.length === 0 && (
            <div className="chat-empty">
              <p>暂无消息</p>
              <small>发送第一条消息，或 @Agent 开始协作。</small>
            </div>
          )}
          {messages.map((msg) => (
            <MessageItem key={msg.id} message={msg} isOwn={msg.sender_id === (user?.id ?? "")} />
          ))}
        </div>

        <ChatInput disabled={connectionStatus !== "open"} onlineAgents={onlineAgentNames} onSend={handleSend} />
      </section>

      {/* ── 右侧面板 ── */}
      <SidePanel
        members={<MembersPanel participants={participants} />}
        tasks={<TasksPanel tasks={tasks} />}
        dialogue={<DialoguePanel roomId={roomId} onlineAgents={onlineAgentNames} />}
        files={<FilesPanel roomId={roomId} authToken={useAuthStore.getState().token ?? undefined} />}
        team={<TeamPanel />}
      />
    </div>
  );
}
