import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { Client } from "@xmtp/browser-sdk";
import { useWebSocket } from "../hooks/useWebSocket";
import { useNotification } from "../hooks/useNotification";
import { useAnalytics } from "../hooks/useAnalytics";
import { ChatMessageItem } from "../components/ChatMessage";
import { ChatInput } from "../components/ChatInput";
import { XmtpUnlock } from "../components/XmtpUnlock";
import { MembersPanel } from "../components/panels/MembersPanel";
import { TasksPanel } from "../components/panels/TasksPanel";
import { DialoguePanel } from "../components/panels/DialoguePanel";
import { FilesPanel } from "../components/panels/FilesPanel";
import { PermissionsPanel } from "../components/panels/PermissionsPanel";
import {
  fetchMessages, fetchAgents, fetchTasks, searchMessages, apiFetch,
} from "../lib/api";
import { createLocalXmtpClient, inboxAddress } from "../lib/xmtpLocalIdentity";
import { sendXmtpMessage, toLocalChatMessage } from "../lib/xmtpSend";
import { listRoomSeats, markSeatGroupAdded } from "../lib/localHelper";
import { syncPendingSeatsToGroup } from "../lib/seatGroupSync";
import { describeEnvelope } from "../lib/envelopeView";
import { formatOwnerNoteAction, visibleOwnerNotes } from "../lib/ownerNotes";
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

type TabId = "members" | "tasks" | "dialogue" | "files" | "permissions";
const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: "members", label: "成员", icon: "👥" },
  { id: "tasks", label: "任务", icon: "📋" },
  { id: "dialogue", label: "对话", icon: "💬" },
  { id: "files", label: "文件", icon: "📎" },
  { id: "permissions", label: "权限", icon: "🔒" },
];

export function RoomPage() {
  const params = useParams();
  const navigate = useNavigate();
  const roomId = params.roomId ?? "";

  const roomQuery = useQuery({
    queryKey: ["rooms", roomId],
    queryFn: async () => {
      const res = await apiFetch(`/api/v1/rooms/${roomId}`);
      if (!res.ok) return null;
      return (await res.json()).room as Room;
    },
    enabled: !!roomId,
  });

  const room = roomQuery.data;
  const isEncrypted = room?.transport === "xmtp";

  const { sendMessage } = useWebSocket(roomId, room?.transport);
  const { enabled: notifEnabled, requestPermission: requestNotifPermission } = useNotification(roomId);
  const { track } = useAnalytics();
  const user = useAuthStore((state) => state.user);

  const storedMessages = useChatStore((state) => state.messages);
  const messages = storedMessages.filter((m) => m.room_id === roomId);
  const setMessages = useChatStore((state) => state.setMessages);
  const addMessage = useChatStore((state) => state.addMessage);
  const connectionStatus = useChatStore((state) => state.connectionStatus);
  const participants = useChatStore((state) => state.participants);
  const tasks = useChatStore((state) => state.tasks);
  const setTasks = useChatStore((state) => state.setTasks);

  const [xmtpClient, setXmtpClient] = useState<Client<any> | null>(null);
  const [unlockedKey, setUnlockedKey] = useState<string | null>(null);
  const [xmtpError, setXmtpError] = useState("");
  const [xmtpConnected, setXmtpConnected] = useState(false);
  const [retryConnection, setRetryConnection] = useState(0);
  const [myXmtpAddress, setMyXmtpAddress] = useState("");
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth > 860);
  const [activeTab, setActiveTab] = useState<TabId>("members");

  const permissionsQuery = useQuery({
    queryKey: ["rooms", roomId, "permissions"],
    queryFn: async () => {
      const res = await apiFetch(`/api/v1/rooms/${roomId}/permissions`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!roomId,
  });

  const myRoomRole = permissionsQuery.data?.members?.find(
    (m: any) => m.user_id === user?.id
  )?.role;

  const isObserver = useMemo(() => {
    if (!permissionsQuery.data?.members || !user?.id) return false;
    const myPerm = permissionsQuery.data.members.find((m: any) => m.user_id === user.id);
    return myPerm?.role === "viewer" || myPerm?.role === "observer";
  }, [permissionsQuery.data, user]);

  useEffect(() => {
    track("room_enter", roomId);
  }, [roomId, track]);

  const messagesQuery = useQuery({
    queryKey: ["rooms", roomId, "messages"],
    queryFn: () => fetchMessages(roomId),
    enabled: !!room && !isEncrypted,
  });
  useEffect(() => {
    if (messagesQuery.data) setMessages(messagesQuery.data, roomId);
  }, [messagesQuery.data, setMessages, roomId]);

  const ownerNotesQuery = useQuery({
    queryKey: ["ownerNotes"],
    queryFn: async () => {
      const res = await fetch("http://127.0.0.1:8787/owner-notes");
      if (!res.ok) throw new Error("fail");
      const data = await res.json();
      return visibleOwnerNotes(data.notes || []);
    },
    enabled: isEncrypted,
    refetchInterval: 5000,
    retry: false,
  });

  // XMTP 客户端：解锁后建立；群绑定交给一键配置向导，这里只负责连接已绑定的群。
  useEffect(() => {
    if (!isEncrypted || !unlockedKey || permissionsQuery.isPending) return;
    let cancelled = false;
    let activeClient: Client<any> | null = null;
    setXmtpError("");

    async function initXmtp() {
      try {
        const key = unlockedKey!;
        setMyXmtpAddress(inboxAddress(key));
        const client = await createLocalXmtpClient(key);
        if (cancelled) {
          client.close();
          return;
        }
        activeClient = client;
        setXmtpClient(client);
      } catch (err) {
        if (!cancelled) setXmtpError(err instanceof Error ? err.message : "无法连接加密房间");
      }
    }

    void initXmtp();
    return () => {
      cancelled = true;
      activeClient?.close();
      setXmtpClient(null);
    };
  }, [isEncrypted, unlockedKey, roomId, retryConnection, permissionsQuery.isPending]);

  // 订阅加密群消息
  useEffect(() => {
    const targetGroupId = room?.xmtp_group_id;
    if (!xmtpClient || !isEncrypted || !targetGroupId) return;
    let cancelled = false;
    let stop: (() => Promise<unknown>) | undefined;
    const client = xmtpClient;

    function ingest(message: any) {
      if (cancelled || message.conversationId !== targetGroupId || typeof message.content !== "string") return;
      addMessage(toLocalChatMessage({
        id: message.id, roomId,
        content: describeEnvelope(message.content) ?? message.content,
        senderId: message.senderInboxId === client.inboxId ? (user?.id ?? message.senderInboxId) : message.senderInboxId,
        senderName: message.senderInboxId === client.inboxId ? user?.display_name ?? "我" : `Member (${message.senderInboxId.slice(0, 6)}...)`,
        senderType: message.senderInboxId === client.inboxId ? "human" : "agent",
        createdAt: message.sentAt?.toISOString(),
      }));
    }

    async function listen() {
      try {
        const stream = await client.conversations.streamAllMessages();
        stop = async () => { await stream.return(); };
        if (cancelled) { await stop(); return; }
        await client.conversations.syncAll();
        const group = await client.conversations.getConversationById(targetGroupId!);
        if (!group) throw new Error("当前身份尚未加入加密群，请房主完成邀请入群");
        await group.sync();
        for (const message of await group.messages()) ingest(message);
        if (!cancelled) { setXmtpConnected(true); setXmtpError(""); }
        for await (const message of stream) ingest(message);
        if (!cancelled) { setXmtpConnected(false); setXmtpError("加密连接已断开，请重新连接"); }
      } catch (err) {
        if (!cancelled) { setXmtpConnected(false); setXmtpError(err instanceof Error ? err.message : "加密连接失败"); }
      }
    }
    void listen();
    return () => { cancelled = true; setXmtpConnected(false); void stop?.(); };
  }, [xmtpClient, isEncrypted, room?.xmtp_group_id, roomId, addMessage]);

  // 席位入群同步：本机助手创建的席位在 Hub 里是 pending，要由「已经在群里的成员」
  // 拉进 XMTP 群。打开这个页面的用户如果是群成员，就用 TA 的客户端完成拉人；
  // 只处理 owner 是自己的席位（见 seatGroupSync.ts）。10 秒一轮，失败下一轮重试。
  useEffect(() => {
    const targetGroupId = room?.xmtp_group_id;
    if (!xmtpClient || !isEncrypted || !targetGroupId || !user?.id) return;
    const currentUserId = user.id;
    let cancelled = false;
    let running = false;
    const tick = async () => {
      if (cancelled || running) return; // 上一轮还没结束时跳过，避免并发写 XMTP 群
      running = true;
      try {
        await syncPendingSeatsToGroup({
          client: xmtpClient,
          roomId,
          groupId: targetGroupId,
          currentUserId,
          deps: { listSeats: listRoomSeats, markAdded: markSeatGroupAdded },
        });
      } catch { /* 整轮失败（Hub 不可达等）留给下一轮重试 */ }
      finally { running = false; }
    };
    void tick();
    const timer = window.setInterval(tick, 10000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [xmtpClient, isEncrypted, room?.xmtp_group_id, roomId, user?.id]);

  const tasksQuery = useQuery({
    queryKey: ["rooms", roomId, "tasks"],
    queryFn: () => fetchTasks(roomId),
    enabled: !!roomId,
    refetchInterval: 15000,
  });
  useEffect(() => {
    if (tasksQuery.data) setTasks(tasksQuery.data);
  }, [tasksQuery.data, setTasks]);

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
      transport: room?.transport,
      xmtpGroupId: room?.xmtp_group_id,
      sendToXmtp: xmtpClient
        ? (groupId, text) => sendXmtpMessage({ groupId, content: text, client: xmtpClient })
        : undefined,
    });
  };

  async function handleShare() {
    try {
      const res = await apiFetch(`/api/v1/rooms/${roomId}/share`, {
        method: "POST",
        body: JSON.stringify({ expires_hours: 72 }),
      });
      if (res.ok) {
        const data = await res.json();
        const url = `${window.location.origin}${data.share_url}`;
        await navigator.clipboard.writeText(url);
        alert(`分享链接已复制：\n${url}\n\n有效期 72 小时`);
      }
    } catch { /* 静默 */ }
  }

  async function handleSearch() {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    try {
      const results = await searchMessages(roomId, searchQuery.trim());
      setSearchResults(results);
    } catch {
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }

  if (roomQuery.isError || (roomQuery.isSuccess && !room)) {
    return (
      <div className="page-error card">
        <p>房间不存在或没有访问权限。</p>
        <Link to="/" className="btn btn-ghost" style={{ marginTop: 12, display: "inline-flex" }}>回首页</Link>
      </div>
    );
  }

  const notes = ownerNotesQuery.data ?? [];

  return (
    <div className="room-shell">
      <section className="chat-main">
        <header className="chat-head">
          <Link to="/" className="chat-head__back">←</Link>
          <div className="chat-head__title">
            <span>{room?.name ?? "加载中..."}</span>
            <span
              className="hint"
              style={{ fontFamily: "var(--mono)", fontSize: 11, cursor: "pointer" }}
              title="点击复制房间 ID"
              onClick={() => navigator.clipboard.writeText(roomId).catch(() => {})}
            >
              ID: {roomId} 📋
            </span>
            {isEncrypted && myXmtpAddress && (
              <span
                className="hint"
                style={{ fontFamily: "var(--mono)", fontSize: 11, cursor: "pointer" }}
                title="点击复制我的加密地址（对方白名单要用）"
                onClick={() => navigator.clipboard.writeText(myXmtpAddress).catch(() => {})}
              >
                我的加密地址: {myXmtpAddress.slice(0, 10)}...{myXmtpAddress.slice(-6)} 📋
              </span>
            )}
          </div>
          <div className="chat-head__actions">
            {!notifEnabled && (
              <button type="button" className="icon-btn" onClick={requestNotifPermission} title="开启 Agent 回复通知">🔔</button>
            )}
            <button type="button" className="icon-btn" onClick={() => setShowSearch(!showSearch)} title="搜索消息" disabled={isEncrypted}>🔍</button>
            <button type="button" className="icon-btn" onClick={handleShare} title="分享只读链接" disabled={isEncrypted}>🔗</button>
            <button type="button" className="icon-btn" onClick={() => navigate(`/setup/${roomId}`)} title="一键配置 / 接入 Agent">⚡</button>
            <button type="button" className="icon-btn" onClick={() => setPanelOpen(!panelOpen)} title="侧栏">☰</button>
            <span className={`conn-status conn-status--${isEncrypted ? (xmtpConnected ? "open" : "closed") : connectionStatus}`}>
              <span className="dot" />
              <span>{isEncrypted ? (xmtpConnected ? "加密消息已连接" : "未连接") : CONNECTION_LABEL[connectionStatus]}</span>
            </span>
          </div>
        </header>

        {showSearch && (
          <div className="search-bar">
            <input
              className="input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              placeholder="搜索消息..."
              autoFocus
            />
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleSearch} disabled={isSearching || !searchQuery.trim()}>
              {isSearching ? "搜索中..." : "搜索"}
            </button>
            <button type="button" className="icon-btn" onClick={() => { setShowSearch(false); setSearchResults([]); setSearchQuery(""); }}>✕</button>
          </div>
        )}
        {showSearch && searchResults.length > 0 && (
          <div className="search-results">
            <p className="hint" style={{ marginBottom: 6 }}>找到 {searchResults.length} 条结果：</p>
            {searchResults.map((msg) => (
              <div key={msg.id} className="search-result">
                <strong>{msg.sender_name ?? msg.sender_id}</strong>
                <span>{msg.content}</span>
                <small>{new Date(msg.created_at).toLocaleString("zh-CN")}</small>
              </div>
            ))}
          </div>
        )}

        <div className="chat-messages" ref={listRef}>
          {isEncrypted && !unlockedKey && <XmtpUnlock onUnlock={setUnlockedKey} />}

          {isEncrypted && unlockedKey && !room?.xmtp_group_id && (
            <div className="setup-note" style={{ alignSelf: "center", maxWidth: 460 }}>
              这个房间还没完成加密配置。
              {myRoomRole === "owner"
                ? <> 点右上角 <strong>⚡</strong> 或 <Link to={`/setup/${roomId}`}>打开一键配置向导</Link> 完成建群与 Agent 接入。</>
                : " 请房主先运行「一键配置」。"}
            </div>
          )}

          {isEncrypted && xmtpError && (
            <div className="auth-error" role="alert" style={{ alignSelf: "center" }}>
              {xmtpError}
              <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }} onClick={() => setRetryConnection(n => n + 1)}>重新连接</button>
            </div>
          )}

          {isEncrypted && ownerNotesQuery.isError && (
            <div className="owner-note">本机成员进程未启动（你的 Agent 暂时不会自动回复）</div>
          )}
          {notes.map((note, idx) => (
            <div key={idx} className="owner-note">
              <span>轮次: {note.turns_seen}</span>
              <span>动作: {formatOwnerNoteAction(note.action)}</span>
              <span>原因: {note.block_reason || "-"}</span>
            </div>
          ))}

          {messagesQuery.isLoading && !isEncrypted && <p className="loading-center">加载消息...</p>}
          {messagesQuery.isError && !isEncrypted && <p className="error-text" style={{ textAlign: "center" }}>加载失败，请刷新重试。</p>}

          {!messagesQuery.isLoading && messages.length === 0 && !isEncrypted && (
            <div className="home-empty" style={{ alignSelf: "center", marginTop: 40, width: "100%", maxWidth: 420 }}>
              <p>暂无消息</p>
              <p className="hint" style={{ marginTop: 4 }}>发送第一条消息，或 @Agent 开始协作。</p>
            </div>
          )}

          {messages.map((msg) => (
            <ChatMessageItem
              key={msg.id}
              message={msg}
              isOwn={msg.sender_type !== "agent" && msg.sender_id === (user?.id ?? "")}
            />
          ))}
        </div>

        {isObserver ? (
          <div className="chat-notice">当前为只读观察者模式，仅可旁听协作过程。</div>
        ) : (
          <ChatInput
            disabled={isEncrypted ? !xmtpConnected : connectionStatus !== "open"}
            onlineAgents={onlineAgentNames}
            onSend={handleSend}
          />
        )}
      </section>

      {panelOpen && (
      <aside className="side-panel open">
        <nav className="side-panel__tabs">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`side-panel__tab ${activeTab === tab.id ? "side-panel__tab--active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span>{tab.icon}</span>
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>
        <div className="side-panel__body">
          {activeTab === "members" && <MembersPanel participants={participants} />}
          {activeTab === "tasks" && <TasksPanel tasks={tasks.filter((t) => !t.room_id || t.room_id === roomId)} />}
          {activeTab === "dialogue" && <DialoguePanel roomId={roomId} onlineAgents={onlineAgentNames} />}
          {activeTab === "files" && <FilesPanel roomId={roomId} />}
          {activeTab === "permissions" && <PermissionsPanel roomId={roomId} />}
        </div>
      </aside>
      )}
    </div>
  );
}
