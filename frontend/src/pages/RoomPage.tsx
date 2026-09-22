import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { Client } from "@xmtp/browser-sdk";
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
import { useAnalytics } from "../hooks/useAnalytics";
import { fetchMessages, fetchAgents, fetchTasks, searchMessages, apiFetch } from "../lib/api";
import { loadOrCreateInboxKey, createLocalXmtpClient } from "../lib/xmtpLocalIdentity";
import { sendXmtpMessage, toLocalChatMessage } from "../lib/xmtpSend";
import { useAuthStore } from "../stores/authStore";
import { useChatStore } from "../stores/chatStore";
import type { Room, SenderType } from "../types/chat";

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

  // Fetch room info
  const roomQuery = useQuery({
    queryKey: ["rooms", roomId],
    queryFn: async () => {
      const res = await apiFetch(`/api/v1/rooms/${roomId}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.room as Room;
    },
    enabled: !!roomId,
  });

  const { sendMessage } = useWebSocket(roomId, roomQuery.data?.transport);
  const { enabled: notifEnabled, requestPermission: requestNotifPermission } = useNotification(roomId);
  const { track } = useAnalytics();
  const user = useAuthStore((state) => state.user);
  const messages = useChatStore((state) => state.messages);
  const setMessages = useChatStore((state) => state.setMessages);
  const addMessage = useChatStore((state) => state.addMessage);
  const connectionStatus = useChatStore((state) => state.connectionStatus);
  const participants = useChatStore((state) => state.participants);
  const tasks = useChatStore((state) => state.tasks);
  const setTasks = useChatStore((state) => state.setTasks);

  const [xmtpClient, setXmtpClient] = useState<Client<any> | null>(null);
  const isEncrypted = roomQuery.data?.transport === "xmtp";

  useEffect(() => {
    track("room_enter", roomId);
  }, [roomId, track]);

  // Fetch messages (only for non-xmtp rooms)
  const messagesQuery = useQuery({
    queryKey: ["rooms", roomId, "messages"],
    queryFn: () => fetchMessages(roomId),
    enabled: !!roomId && !isEncrypted,
  });
  useEffect(() => {
    if (messagesQuery.data) setMessages(messagesQuery.data);
  }, [messagesQuery.data, setMessages]);

  // Initialize XMTP client for encrypted rooms and bind group if needed
  useEffect(() => {
    if (!isEncrypted) return;
    let cancelled = false;

    async function initXmtp() {
      try {
        const key = loadOrCreateInboxKey();
        const client = await createLocalXmtpClient(key);
        if (cancelled) {
          client.close();
          return;
        }
        setXmtpClient(client);

        if (!roomQuery.data?.xmtp_group_id) {
          const group = await client.conversations.createGroup([]);
          if (cancelled) return;
          const token = useAuthStore.getState().token ?? "";
          const res = await apiFetch(`/api/v1/rooms/${roomId}/xmtp-binding`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ xmtp_group_id: group.id }),
          });
          if (res.ok) {
            void roomQuery.refetch();
          }
        }
      } catch (err) {
        console.error("Failed to initialize XMTP:", err instanceof Error ? err.message : "unknown");
      }
    }

    void initXmtp();
    return () => {
      cancelled = true;
    };
  }, [isEncrypted, roomQuery.data?.xmtp_group_id, roomId]);

  // Stream messages from XMTP group
  useEffect(() => {
    if (!xmtpClient || !isEncrypted) return;
    const targetGroupId = roomQuery.data?.xmtp_group_id;
    let cancelled = false;

    async function listenStream() {
      try {
        const stream = await xmtpClient!.conversations.streamAllMessages();
        for await (const message of stream) {
          if (cancelled) break;
          if (targetGroupId && message.conversationId !== targetGroupId) continue;
          if (xmtpClient?.inboxId && message.senderInboxId === xmtpClient.inboxId) {
            continue;
          }
          if (typeof message.content === "string") {
            addMessage(
              toLocalChatMessage({
                id: message.id,
                roomId,
                content: message.content,
                senderId: message.senderInboxId,
                senderName: `Member (${message.senderInboxId.slice(0, 6)}...)`,
                senderType: "agent",
                createdAt: message.sentAt ? message.sentAt.toISOString() : undefined,
              }),
            );
          }
        }
      } catch {
        // Stream aborted or network closed
      }
    }

    void listenStream();
    return () => {
      cancelled = true;
    };
  }, [xmtpClient, isEncrypted, roomQuery.data?.xmtp_group_id, roomId, addMessage]);

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

    const [searchQuery, setSearchQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [searchResults, setSearchResults] = useState<typeof messages>([]);
  const [isSearching, setIsSearching] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages.length]);

  const handleSend = (content: string, senderType: SenderType) => {
    track("message_send", roomId, { sender_type: senderType });
    return sendMessage({
      content,
      senderId: user?.id ?? "anon",
      senderType,
      transport: roomQuery.data?.transport,
      xmtpGroupId: roomQuery.data?.xmtp_group_id,
      sendToXmtp: xmtpClient
        ? (groupId, text) => sendXmtpMessage({ groupId, content: text, client: xmtpClient })
        : undefined,
    });
  };

  async function handleShare() {
    try {
      const token = useAuthStore.getState().token ?? "";
      const res = await fetch(`/api/v1/rooms/${roomId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ expires_hours: 72 }),
      });
      if (res.ok) {
        const data = await res.json();
        const url = `${window.location.origin}${data.share_url}`;
        await navigator.clipboard.writeText(url);
        alert(`分享链接已复制到剪贴板：\n${url}\n\n有效期 72 小时`);
      }
    } catch { /* silent */ }
  }

  async function handleSearch() {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    try {
      const results = await searchMessages(roomId, searchQuery.trim());
      setSearchResults(results);
      setShowSearch(true);
    } catch {
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }

  return (
    <div className="room-layout">
      {/* ── 聊天区 ── */}
      <section className="chat-area">
        <header className="chat-area__header">
          <Link to="/rooms" className="chat-area__back">←</Link>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span className="chat-area__title">
              {roomQuery.data?.name || "房间"}
              {roomQuery.data?.transport === "hub" && (
                <span style={{ fontSize: 12, fontWeight: "normal", marginLeft: 8, color: "#f59e0b" }}>
                  历史明文房间
                </span>
              )}
            </span>
            <span
              style={{
                fontSize: 11,
                color: "var(--text-secondary)",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontFamily: "monospace",
              }}
              title="点击复制完整房间 ID"
              onClick={async () => {
                await navigator.clipboard.writeText(roomId);
                alert(`房间 ID 已复制到剪贴板：\n${roomId}\n\n可直接粘贴至 Agent 启动命令中的 --room-id 参数`);
              }}
            >
              ID: {roomId} 📋
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
            {!notifEnabled && (
              <button type="button" onClick={requestNotifPermission} title="开启 Agent 回复通知" style={{ fontSize: 16, background: "none", border: "none", cursor: "pointer" }}>
                🔔
              </button>
            )}
            <button type="button" className="chat-search-toggle" onClick={() => setShowSearch(!showSearch)} title="搜索消息">
              🔍
            </button>
            <button type="button" className="chat-search-toggle" onClick={handleShare} title="分享房间链接">🔗</button>
            <span className={`chat-area__status chat-area__status--${connectionStatus}`}>
              <span className="dot" />
              {CONNECTION_LABEL[connectionStatus]}
            </span>
          </div>
        </header>

        {showSearch && (
          <div className="chat-search-bar">
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              placeholder="搜索消息..."
              autoFocus
            />
            <button type="button" onClick={handleSearch} disabled={isSearching || !searchQuery.trim()}>
              {isSearching ? "搜索中..." : "搜索"}
            </button>
            <button type="button" className="btn-ghost" onClick={() => { setShowSearch(false); setSearchResults([]); setSearchQuery(""); }}>
              ✕
            </button>
          </div>
        )}
        {showSearch && searchResults.length > 0 && (
          <div className="chat-search-results">
            <p className="chat-search-results__header">找到 {searchResults.length} 条结果：</p>
            {searchResults.map((msg) => (
              <div key={msg.id} className="chat-search-result-row">
                <strong>{msg.sender_name ?? msg.sender_id}</strong>
                <span>{msg.content}</span>
                <small>{new Date(msg.created_at).toLocaleString("zh-CN")}</small>
              </div>
            ))}
          </div>
        )}
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
            <MessageItem key={msg.id} message={msg} isOwn={msg.sender_type !== "agent" && msg.sender_id === (user?.id ?? "")} />
          ))}
        </div>

        <ChatInput disabled={connectionStatus !== "open"} onlineAgents={onlineAgentNames} onSend={handleSend} />
      </section>

      {/* ── 右侧面板 ── */}
      <SidePanel
        roomId={roomId}
        members={<MembersPanel participants={participants} />}
        tasks={<TasksPanel tasks={tasks} />}
        dialogue={<DialoguePanel roomId={roomId} onlineAgents={onlineAgentNames} />}
        files={<FilesPanel roomId={roomId} authToken={useAuthStore.getState().token ?? undefined} />}
        team={<TeamPanel />}
      />
    </div>
  );
}
