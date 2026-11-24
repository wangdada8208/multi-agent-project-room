import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams, Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  Bell,
  CheckCircle2,
  CheckSquare,
  Copy,
  Cpu,
  ExternalLink,
  KeyRound,
  Link2,
  MessageSquare,
  PanelRight,
  Paperclip,
  RefreshCw,
  Reply,
  Search,
  Shield,
  Users,
  X,
} from "lucide-react";
import { useWebSocket } from "../hooks/useWebSocket";
import { useNotification } from "../hooks/useNotification";
import { useLocalHelper } from "../hooks/useLocalHelper";
import { useRoomData } from "../hooks/room/useRoomData";
import { useInviteFlow, useInviteRedemption } from "../hooks/room/useInviteFlow";
import { useXmtpSession } from "../hooks/room/useXmtpSession";
import { useXmtpMessages } from "../hooks/room/useXmtpMessages";
import { useGroupSync } from "../hooks/room/useGroupSync";
import { useMessageSearch } from "../hooks/room/useMessageSearch";
import { usePendingRequests } from "../hooks/room/usePendingRequests";
import { HelperLink } from "../components/HelperLink";
import { toast } from "../components/ui/Toast";
import { apiJson } from "../lib/apiError";
import { deriveDisplayMessages } from "../lib/domain/displayMessages";
import { mentionCandidatesFrom } from "../lib/domain/mentions";
import { roomStatusView } from "../lib/domain/roomStatusView";
import { useAnalytics } from "../hooks/useAnalytics";
import { ChatMessageItem } from "../components/ChatMessage";
import { ChatInput, type ReplyTargetInfo } from "../components/ChatInput";
import { CopyButton } from "../components/CopyButton";
import { XmtpUnlock } from "../components/XmtpUnlock";
import { MembersPanel } from "../components/panels/MembersPanel";
import { TasksPanel } from "../components/panels/TasksPanel";
import { DialoguePanel } from "../components/panels/DialoguePanel";
import { FilesPanel } from "../components/panels/FilesPanel";
import { PermissionsPanel } from "../components/panels/PermissionsPanel";
import { OwnerApprovalPanel } from "../components/panels/OwnerApprovalPanel";
import { ActivityPanel } from "../components/panels/ActivityPanel";
import { fetchMessages, fetchAgents, fetchTasks } from "../lib/api";
import { sendXmtpMessage, sendXmtpReply } from "../lib/xmtpSend";
import { listLocalSeats, type HubSeatView } from "../lib/localHelper";
import { tabVisibleInRoom, type RoomTabId } from "../lib/roomTabs";
import { useAuthStore } from "../stores/authStore";
import { useChatStore } from "../stores/chatStore";
import type { SenderType } from "../types/chat";

const CONNECTION_LABEL: Record<string, string> = {
  connecting: "连接中…",
  open: "已连接",
  closed: "已断开",
  error: "连接错误",
  idle: "等待中",
};

type TabId = RoomTabId;

const TABS: { id: TabId; label: string; icon: ReactNode }[] = [
  { id: "members", label: "成员", icon: <Users size={15} strokeWidth={1.8} /> },
  { id: "tasks", label: "任务", icon: <CheckSquare size={15} strokeWidth={1.8} /> },
  { id: "dialogue", label: "对话", icon: <MessageSquare size={15} strokeWidth={1.8} /> },
  { id: "files", label: "文件", icon: <Paperclip size={15} strokeWidth={1.8} /> },
  { id: "permissions", label: "权限", icon: <Shield size={15} strokeWidth={1.8} /> },
  { id: "approvals", label: "审批", icon: <CheckCircle2 size={15} strokeWidth={1.8} /> },
  { id: "activity", label: "动态", icon: <Activity size={15} strokeWidth={1.8} /> },
];

const emptySeats: HubSeatView[] = [];

export function RoomPage() {
  const params = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const roomId = params.roomId ?? "";

  const inviteTokenFromUrl = searchParams.get("invite") ?? "";
  const { invite, dispatch: dispatchInvite, accepting: inviteAccepting } = useInviteFlow(inviteTokenFromUrl);
  const inviteAcceptError = invite.kind === "acceptFailed" ? invite.message : null;
  const roomReadyForQueries = Boolean(roomId) && !inviteAccepting;
  const user = useAuthStore((state) => state.user);
  const { roomQuery, permissionsQuery, roomSeatsQuery, myRoomRole, roomError, isObserver } =
    useRoomData(roomId, user?.id, roomReadyForQueries);
  const room = roomQuery.data;
  const isEncrypted = room?.transport === "xmtp";
  const { sendMessage } = useWebSocket(roomId, room?.transport, roomReadyForQueries && (!inviteAcceptError || Boolean(room)));
  const { track } = useAnalytics();

  const { session, xmtpClient, setUnlockedKey, listenRetry, dispatch, restartListener, reconnect, myXmtpAddress, draftKeyMaterial,
    bindingGroup, bindGroup: handleQuickBindGroup } = useXmtpSession({
      roomId, groupId: room?.xmtp_group_id, enabled: isEncrypted && !permissionsQuery.isPending, refreshRoom: roomQuery.refetch,
    });
  const { rawXmtpMessages, inboxAddresses, updateInboxMap } = useXmtpMessages(xmtpClient, room?.xmtp_group_id, listenRetry, dispatch);
  const { refetch: refetchSeats, data: seats = emptySeats } = roomSeatsQuery;
  const { refetch: refetchPermissions } = permissionsQuery;
  const pendingRequests = usePendingRequests(roomId, myRoomRole === "owner" && isEncrypted);
  useGroupSync({
    client: xmtpClient, groupId: room?.xmtp_group_id, roomId, userId: user?.id, role: myRoomRole,
    phase: session.kind === "ready" || session.kind === "notInGroup" ? session.kind : null,
    permissionMembers: permissionsQuery.data?.members, restartListener, updateInboxMap, refetchSeats,
  });
  const finishInvite = useCallback((token: string, refresh: boolean) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (next.get("invite") === token) next.delete("invite");
      return next;
    }, { replace: true });
    if (refresh) void refetchPermissions();
  }, [setSearchParams, refetchPermissions]);
  const retryInvite = useInviteRedemption({
    invite, urlToken: inviteTokenFromUrl, address: myXmtpAddress, dispatch: dispatchInvite, finish: finishInvite,
  });
  const xmtpConnected = session.kind === "ready";
  const xmtpNotInGroup = session.kind === "notInGroup";
  const xmtpConnecting = session.kind === "connecting";
  const xmtpLoading = isEncrypted && (session.kind === "locked" || xmtpConnecting);

  const storedMessages = useChatStore((state) => state.messages);
  const setMessages = useChatStore((state) => state.setMessages);
  const connectionStatus = useChatStore((state) => state.connectionStatus);
  const participants = useChatStore((state) => state.participants);
  const tasks = useChatStore((state) => state.tasks);
  const setTasks = useChatStore((state) => state.setTasks);

  const [replyTarget, setReplyTarget] = useState<ReplyTargetInfo | null>(null);
  const [panelOpen, setPanelOpen] = useState(() =>
    typeof window === "undefined" ? true : window.innerWidth > 860,
  );
  const [activeTab, setActiveTab] = useState<TabId>("members");
  const [dismissedCrashKey, setDismissedCrashKey] = useState("");
  const [share, setShare] = useState<{ url: string; copied: boolean } | null>(null);

  useEffect(() => {
    if (!panelOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && window.innerWidth <= 860) {
        setPanelOpen(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [panelOpen]);

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

  const helper = useLocalHelper(roomReadyForQueries && isEncrypted);
  const localSeatsQuery = useQuery({
    queryKey: ["local-helper-room-seats", roomId],
    queryFn: () => listLocalSeats(),
    enabled: roomReadyForQueries && isEncrypted && helper.probe?.state === "running" && helper.probe.hello.paired,
    refetchInterval: 15000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const crashedLocalSeats = useMemo(
    () => (localSeatsQuery.data ?? []).filter((seat) => seat.roomId === roomId && seat.status === "crashed"),
    [localSeatsQuery.data, roomId],
  );
  const crashKey = crashedLocalSeats.map((seat) => seat.seatId).sort().join(",");
  const showCrashBanner = helper.reason !== "mobile" && crashedLocalSeats.length > 0 && dismissedCrashKey !== crashKey;

  const displayMessages = useMemo(() => isEncrypted ? deriveDisplayMessages({
    transport: "xmtp", messages: rawXmtpMessages, inboxAddresses, seats, roomId,
    myInboxId: xmtpClient?.inboxId ?? "", myUsername: user?.display_name || user?.username || "我", userId: user?.id,
  }) : deriveDisplayMessages({
    transport: "hub", messages: storedMessages.filter((message) => message.room_id === roomId), seats, userId: user?.id,
  }), [isEncrypted, rawXmtpMessages, inboxAddresses, seats, roomId, xmtpClient?.inboxId, user, storedMessages]);
  const displayMessageById = useMemo(() => new Map(displayMessages.map((message) => [message.id, message])), [displayMessages]);
  const statusView = isEncrypted ? roomStatusView(session, invite, myRoomRole, displayMessages.length > 0) : null;

  const { enabled: notifEnabled, requestPermission: requestNotifPermission } = useNotification(
    displayMessages,
    { ready: !isEncrypted ? !messagesQuery.isLoading : !xmtpLoading, scopeKey: roomId },
  );

  const tasksQuery = useQuery({
    queryKey: ["rooms", roomId, "tasks"],
    queryFn: () => fetchTasks(roomId),
    enabled: roomReadyForQueries,
    refetchInterval: 15000,
  });
  useEffect(() => {
    if (tasksQuery.data) setTasks(tasksQuery.data);
  }, [tasksQuery.data, setTasks]);

  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: fetchAgents,
    enabled: !!room && !isEncrypted && roomReadyForQueries,
    refetchInterval: 30000,
  });

  // 合并活跃加密席位名称与在线 WS Agent，供 @Agent 与 @全体 快捷胶囊使用
  const agentMentions = useMemo(() => mentionCandidatesFrom(seats, participants)
    .filter((candidate) => candidate.actor === "cloud" || candidate.actor === "local"), [seats, participants]);
  const pausedAgentNames = agentMentions.filter((candidate) => candidate.disabled).map((candidate) => candidate.name);
  const onlineAgentNames = useMemo(() => {
    const merged = agentMentions.filter((candidate) => !candidate.disabled).map((candidate) => candidate.name);
    if (merged.length > 0 || isEncrypted) return merged;
    return Array.from(
      new Set(
        (agentsQuery.data ?? [])
          .map((a) => a.name.trim())
          .filter((name) => name && !agentMentions.some((candidate) => candidate.name === name)),
      ),
    ).slice(0, 6);
  }, [agentMentions, isEncrypted, agentsQuery.data]);

  const starterChips = useMemo(() => {
    if (onlineAgentNames.length === 0) return [];
    if (onlineAgentNames.length >= 2) {
      return [
        "@全体 请各自用两句话介绍你们擅长的分工",
        `@${onlineAgentNames[0]} 请先梳理当前任务的关键步骤`,
        `@${onlineAgentNames[1]} 请补充需要注意的边界条件与风险`,
      ];
    }
    const agent = onlineAgentNames[0];
    return [
      `@${agent} 你好，请先介绍一下你能协助的工作`,
      `@${agent} 帮我拆解接下来的推进计划`,
    ];
  }, [onlineAgentNames]);

  const { searchQuery, setSearchQuery, showSearch, setShowSearch, searchResults, isSearching, searchSender,
    setSearchSender, xmtpSenderOptions, handleSearch, closeSearch, searchError } = useMessageSearch({
      roomId, transport: room ? room.transport ?? "hub" : undefined, groupId: room?.xmtp_group_id,
      rawMessages: rawXmtpMessages, displayById: displayMessageById,
    });

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [displayMessages.length]);

  const handleSend = (content: string, senderType: SenderType = "human") => {
    if (!room || !canSendNow) return false;
    track("message_send", roomId, { sender_type: senderType });
    const target = isEncrypted ? replyTarget : null;
    const delivered = sendMessage({
      content,
      transport: room?.transport,
      xmtpGroupId: room?.xmtp_group_id,
      sendToXmtp: xmtpClient
        ? (groupId, text) =>
            target
              ? sendXmtpReply({
                  groupId,
                  content: text,
                  referenceId: target.id,
                  referenceInboxId: target.senderInboxId,
                  fallbackQuote: `↩ ${target.senderName}：${target.excerpt}`,
                  client: xmtpClient,
                })
              : sendXmtpMessage({ groupId, content: text, client: xmtpClient })
        : undefined,
    });
    void Promise.resolve(delivered).then((ok) => {
      if (ok && target) setReplyTarget(null);
    });
    return delivered;
  };

  async function handleShare() {
    if (!room || isEncrypted) return;
    try {
      const data = await apiJson<{ share_url: string }>(`/api/v1/rooms/${roomId}/share`, {
        method: "POST",
        body: JSON.stringify({ expires_hours: 72 }),
      });
      const url = `${window.location.origin}${data.share_url}`;
      try {
        await navigator.clipboard.writeText(url);
        setShare({ url, copied: true });
      } catch {
        setShare({ url, copied: false });
        toast("无法访问剪贴板，请手动复制分享链接。", "danger");
      }
    } catch {
      toast("无法创建分享链接，请重试。", "danger");
    }
  }

  if (inviteAccepting) {
    return (
      <div className="loading-center" style={{ minHeight: "100%" }}>
        <span className="spinner" />
        <span>正在验证入群邀请并开通房间权限…</span>
      </div>
    );
  }

  if (roomError || (roomQuery.isSuccess && !room)) {
    return (
      <div className="page-error card">
        <p>{inviteAcceptError ?? roomError?.message ?? "房间不存在或没有访问权限。"}</p>
        <Link to="/home" className="btn btn-ghost" style={{ marginTop: 12, display: "inline-flex" }}>
          回首页
        </Link>
      </div>
    );
  }

  const canSendNow = !isObserver && (isEncrypted ? xmtpConnected : connectionStatus === "open");

  return (
    <div className="room-shell">
      <section className="chat-main">
        <header className="chat-head">
          <Link to="/home" className="chat-head__back" title="返回房间列表">
            <ArrowLeft size={18} strokeWidth={1.9} />
          </Link>
          <div className="chat-head__title">
            <span style={{ color: "#1d1d1f" }}>{room?.name ?? "加载中…"}</span>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 1 }}>
              <span
                className="hint"
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
                title="点击复制房间 ID"
                onClick={() => navigator.clipboard.writeText(roomId).catch(() => {})}
              >
                <span>ID: {roomId.slice(0, 8)}…</span>
                <Copy size={11} strokeWidth={1.8} />
              </span>
              {isEncrypted && myXmtpAddress && (
                <span
                  className="hint"
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 11,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                  title="点击复制我的加密地址"
                  onClick={() => navigator.clipboard.writeText(myXmtpAddress).catch(() => {})}
                >
                  <span>加密身份: {myXmtpAddress.slice(0, 6)}…{myXmtpAddress.slice(-4)}</span>
                  <Copy size={11} strokeWidth={1.8} />
                </span>
              )}
            </div>
          </div>
          <div className="chat-head__actions">
            {!notifEnabled && (
              <button
                type="button"
                className="icon-btn"
                onClick={() => void requestNotifPermission()}
                title="开启 Agent 回复通知"
              >
                <Bell size={17} strokeWidth={1.8} />
              </button>
            )}
            <button
              type="button"
              className="icon-btn"
              onClick={() => showSearch ? closeSearch() : setShowSearch(true)}
              title={isEncrypted ? "本机搜索加密消息" : "搜索消息"}
            >
              <Search size={17} strokeWidth={1.8} />
            </button>
            {!isEncrypted && (
              <button
                type="button"
                className="icon-btn"
                onClick={() => void handleShare()}
                title="分享只读链接"
              >
                <Link2 size={17} strokeWidth={1.8} />
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => navigate(`/agents?room=${encodeURIComponent(roomId)}`)}
              title="一键接入 Agent"
            >
              <Cpu size={14} strokeWidth={1.9} />
              <span className="btn-label">接入 Agent</span>
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setPanelOpen(!panelOpen)}
              title="切换侧栏"
              aria-label="切换侧栏"
            >
              <PanelRight size={17} strokeWidth={1.8} />
            </button>
            <span
              className={`conn-status conn-status--${
                isEncrypted ? (xmtpConnected ? "open" : xmtpNotInGroup || xmtpConnecting ? "connecting" : "closed") : connectionStatus
              }`}
            >
              <span className="dot" />
              <span>
                {isEncrypted
                  ? xmtpConnected
                    ? "端到端加密已连接"
                    : xmtpNotInGroup
                      ? "等待入群"
                      : xmtpConnecting
                        ? "连接加密群中…"
                        : "未解锁"
                  : CONNECTION_LABEL[connectionStatus]}
              </span>
            </span>
          </div>
        </header>

        {share && !isEncrypted && (
          <div className="share-toast" role="status">
            <CheckCircle2 size={15} strokeWidth={2} style={{ color: "var(--success)", flexShrink: 0 }} />
            <span className="share-toast__text">{share.copied ? "只读分享链接已复制（72 小时内有效）" : "只读分享链接已创建（72 小时内有效）"}</span>
            <div className="share-toast__actions">
              <CopyButton text={share.url} label={share.copied ? "再次复制" : "复制链接"} />
              <a
                href={share.url}
                target="_blank"
                rel="noreferrer"
                className="btn btn-ghost btn-sm"
              >
                <span>打开预览</span>
                <ExternalLink size={12} strokeWidth={2} />
              </a>
              <button
                type="button"
                className="icon-btn"
                style={{ width: 26, height: 26 }}
                onClick={() => setShare(null)}
                aria-label="关闭分享提示"
              >
                <X size={14} strokeWidth={1.9} />
              </button>
            </div>
          </div>
        )}

        {showSearch && (
          <div className="search-bar">
            <input
              className="input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleSearch()}
              placeholder={isEncrypted ? "本机搜索加密消息…" : "搜索消息…"}
              autoFocus
            />
            {isEncrypted && xmtpSenderOptions.length > 0 && (
              <select
                className="input"
                style={{ width: "auto", maxWidth: 150, flexShrink: 0 }}
                value={searchSender}
                onChange={(e) => setSearchSender(e.target.value)}
                title="按发送者过滤"
              >
                <option value="">全部发送者</option>
                {xmtpSenderOptions.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void handleSearch()}
              disabled={isSearching || !searchQuery.trim()}
            >
              {isSearching ? "搜索中…" : "搜索"}
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={closeSearch}
            >
              <X size={16} strokeWidth={1.9} />
            </button>
          </div>
        )}
        {showSearch && searchError && <p className="error-text" role="alert">{searchError}</p>}
        {showSearch && searchResults.length > 0 && (
          <div className="search-results">
            <p className="hint" style={{ marginBottom: 6 }}>
              找到 {searchResults.length} 条结果{isEncrypted ? "（本机加密搜索，仅覆盖本端已同步消息）" : ""}：
            </p>
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
          {/* 仅当本机该房间有 crashed 席位时才温和提示，支持关闭 */}
          {showCrashBanner && (
            <div
              style={{
                alignSelf: "center",
                width: "100%",
                maxWidth: 620,
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "9px 14px",
                borderRadius: 12,
                background: "#ffffff",
                border: "1px solid rgba(0, 0, 0, 0.08)",
                boxShadow: "0 2px 10px rgba(0, 0, 0, 0.04)",
                fontSize: 13,
                color: "#1d1d1f",
              }}
            >
              <AlertCircle size={16} strokeWidth={1.9} style={{ color: "#d97706", flexShrink: 0 }} />
              <span style={{ flex: 1 }}>
                检测到本机席位（{crashedLocalSeats.map((s) => s.agentKey).join("、")}）异常退出，可前往本机助手查看原因或重启。
              </span>
              <HelperLink className="btn btn-ghost btn-sm" action="console">
                <span>打开本机助手查看</span>
                <ExternalLink size={12} strokeWidth={2} />
              </HelperLink>
              <button
                type="button"
                className="icon-btn"
                style={{ width: 26, height: 26 }}
                onClick={() => setDismissedCrashKey(crashKey)}
                title="关闭提示"
              >
                <X size={14} strokeWidth={1.9} />
              </button>
            </div>
          )}

          {statusView?.kind === "locked" && (
            <div style={{ width: "100%" }}>
              {invite.kind === "accepted" && (
                <div
                  style={{
                    maxWidth: 460,
                    margin: "12px auto -24px",
                    padding: "10px 14px",
                    borderRadius: 12,
                    background: "rgba(0, 113, 227, 0.06)",
                    border: "1px solid rgba(0, 113, 227, 0.18)",
                    fontSize: 13,
                    color: "#1d1d1f",
                  }}
                >
                  已识别加密入群邀请链接，房间成员权限已自动开通。请解锁或设置本机加密口令，系统将自动为你登记入群。
                </div>
              )}
              <XmtpUnlock onUnlock={setUnlockedKey} />
            </div>
          )}

          {statusView?.kind === "connecting" && (
            <div className="loading-center" style={{ padding: "36px 0" }}>
              <span className="spinner" />
              <span>正在连接端到端加密群并同步对话…</span>
            </div>
          )}

          {(statusView?.kind === "enableGroup" || statusView?.kind === "waitForGroup") && (
            <div
              className="card"
              style={{
                alignSelf: "center",
                maxWidth: 480,
                width: "100%",
                padding: "20px 22px",
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <strong style={{ fontSize: 15, color: "#1d1d1f" }}>该房间尚未激活端到端加密群</strong>
              <p style={{ fontSize: 13.5, color: "#6e6e73", lineHeight: 1.55 }}>
                {myRoomRole === "owner"
                  ? "你是房主，可立即在本机浏览器创建端到端加密群并绑定到此房间，随后你的待入群 Agent 席位也会自动入群。"
                  : "请等待房主先打开房间激活端到端加密群。"}
              </p>
              {myRoomRole === "owner" && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={!xmtpClient || bindingGroup}
                    onClick={() => void handleQuickBindGroup()}
                  >
                    {bindingGroup ? "正在创建加密群…" : "立即创建并绑定加密群"}
                  </button>
                  <Link to={`/setup/${roomId}`} className="btn btn-ghost btn-sm">
                    打开完整配置向导
                  </Link>
                </div>
              )}
            </div>
          )}

          {statusView?.kind === "inviteError" && (
            <div
              className="card"
              style={{
                alignSelf: "center",
                maxWidth: 520,
                padding: "12px 16px",
                borderColor: "rgba(220, 38, 38, 0.25)",
                fontSize: 13,
                color: "#dc2626",
              }}
            >
              邀请链接核销提示：{statusView.message}。你也可以复制加密地址发给房主拉你入群。
              <div className="ui-confirm__actions">
                <CopyButton text={myXmtpAddress} label="复制我的加密地址" />
                {invite.kind === "redeemFailed" && invite.retryable && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={retryInvite}>重试核销</button>
                )}
                <button type="button" className="btn btn-ghost btn-sm" onClick={reconnect}>重新检查入群</button>
              </div>
            </div>
          )}

          {/* 受邀协作者的核销申请已登记，等待房主在「权限」面板批准 */}
          {statusView?.kind === "awaitingApproval" && (
            <div
              className="card"
              style={{
                alignSelf: "center",
                maxWidth: 540,
                width: "100%",
                padding: "18px 20px",
                display: "flex",
                flexDirection: "column",
                gap: 10,
                background: "#ffffff",
                border: "1px solid rgba(217, 119, 6, 0.28)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#d97706", fontWeight: 600, fontSize: 14 }}>
                <Shield size={16} strokeWidth={2} />
                <span>入群申请已提交，等待房主批准</span>
              </div>
              <p style={{ fontSize: 13, color: "#6e6e73", lineHeight: 1.5 }}>
                这条邀请链接要求房主逐一批准。批准后房主页面会自动把你拉进加密群，无需再次打开邀请链接。
              </p>
              {myXmtpAddress && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <code style={{ fontSize: 12, color: "#6e6e73", background: "#f5f5f7", padding: "4px 8px", borderRadius: 6 }}>
                    {myXmtpAddress}
                  </code>
                  <CopyButton text={myXmtpAddress} label="复制我的加密地址" />
                </div>
              )}
            </div>
          )}

          {/* 受邀协作者已核销邀请、等待房主页面自动拉入加密群 */}
          {statusView?.kind === "awaitingAdd" && (
            <div
              className="card"
              style={{
                alignSelf: "center",
                maxWidth: 540,
                width: "100%",
                padding: "18px 20px",
                display: "flex",
                flexDirection: "column",
                gap: 10,
                background: "#ffffff",
                border: "1px solid rgba(0, 113, 227, 0.22)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#0071e3", fontWeight: 600, fontSize: 14 }}>
                <Shield size={16} strokeWidth={2} />
                <span>加密身份已登记，房主页面在线时将自动拉你进入加密群（约 5 秒）</span>
              </div>
              <p style={{ fontSize: 13, color: "#6e6e73", lineHeight: 1.5 }}>
                系统每 5 秒自动检测入群状态，入群后将自动连接并加载加密对话，无需手动刷新。
              </p>
              {myXmtpAddress && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <code style={{ fontSize: 12, color: "#6e6e73", background: "#f5f5f7", padding: "4px 8px", borderRadius: 6 }}>
                    {myXmtpAddress}
                  </code>
                  <CopyButton text={myXmtpAddress} label="复制我的加密地址" />
                </div>
              )}
            </div>
          )}

          {/* 协作者尚未在加密群内，且无待核销邀请时展示复制地址卡片 */}
          {statusView?.kind === "notInGroup" && (
            <div
              className="card"
              style={{
                alignSelf: "center",
                maxWidth: 540,
                width: "100%",
                padding: "20px 22px",
                display: "flex",
                flexDirection: "column",
                gap: 12,
                background: "#ffffff",
                border: "1px solid rgba(0, 0, 0, 0.08)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <KeyRound size={17} strokeWidth={1.9} style={{ color: "#0071e3" }} />
                <strong style={{ fontSize: 15, color: "#1d1d1f" }}>当前加密身份尚未加入此房间加密群</strong>
              </div>
              <p style={{ fontSize: 13, color: "#6e6e73", lineHeight: 1.55 }}>
                请向房主索取「加密入群邀请链接」，或复制下方你的加密地址发给房主，在房间右侧「权限」面板拉你入群：
              </p>
              {myXmtpAddress && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                    flexWrap: "wrap",
                    padding: "10px 12px",
                    borderRadius: 10,
                    background: "#f5f5f7",
                    border: "1px solid rgba(0, 0, 0, 0.06)",
                  }}
                >
                  <code style={{ fontSize: 12, color: "#1d1d1f", wordBreak: "break-all" }}>
                    {myXmtpAddress}
                  </code>
                  <CopyButton text={myXmtpAddress} label="复制我的加密地址" />
                </div>
              )}
              <div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={reconnect}
                >
                  <RefreshCw size={13} strokeWidth={2} />
                  <span>房主已拉我 · 立即重连</span>
                </button>
              </div>
            </div>
          )}

          {statusView?.kind === "error" && (
            <div className="auth-error" role="alert" style={{ alignSelf: "center" }}>
              {statusView.message}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ marginLeft: 8 }}
                onClick={reconnect}
              >
                重新连接
              </button>
            </div>
          )}

          {messagesQuery.isLoading && !isEncrypted && (
            <div className="loading-center">
              <span className="spinner" />
              <span>加载消息…</span>
            </div>
          )}
          {messagesQuery.isError && !isEncrypted && (
            <p className="error-text" style={{ textAlign: "center" }}>加载失败，请刷新重试。</p>
          )}

          {((!isEncrypted && messagesQuery.isSuccess && displayMessages.length === 0) || statusView?.kind === "ready") && (
            <div
              className="home-empty"
              style={{
                alignSelf: "center",
                marginTop: 40,
                width: "100%",
                maxWidth: 480,
                background: "#ffffff",
                border: "1px solid rgba(0, 0, 0, 0.08)",
              }}
            >
              <p style={{ color: "#1d1d1f", fontWeight: 600 }}>
                {isEncrypted ? "端到端加密对话已就绪" : "协作对话已就绪"}
              </p>
              <p className="hint" style={{ marginTop: 6, color: "#6e6e73" }}>
                {onlineAgentNames.length > 0
                  ? "点击下方推荐提问即可直接唤醒智能体协作，或在输入框自由提问："
                  : "发送第一条加密消息，或点右上角「接入 Agent」把 Claude Code / Codex / Grok 拉进房间。"}
              </p>

              {!xmtpLoading && !xmtpNotInGroup && onlineAgentNames.length > 0 && !isObserver && (
                <div className="starter-chips">
                  {starterChips.map((chipText) => (
                    <button
                      key={chipText}
                      type="button"
                      className="starter-chip"
                      disabled={!canSendNow}
                      onClick={() => void handleSend(chipText)}
                    >
                      {chipText}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {displayMessages.map((msg) => {
            const isOwn = msg.sender_type !== "agent" && msg.actor === "me";
            const replyTo = msg.replyToId ? displayMessageById.get(msg.replyToId) : undefined;
            return (
              <div key={msg.id} style={{ display: "flex", flexDirection: "column" }}>
                {msg.replyToId && msg.msg_type !== "system" && (
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--text-muted)",
                      padding: isOwn ? "0 4px 2px" : "0 42px 2px",
                      alignSelf: isOwn ? "flex-end" : "flex-start",
                      textAlign: isOwn ? "right" : "left",
                      maxWidth: "min(76%, 680px)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    ↩ 回复 {replyTo ? (replyTo.sender_name ?? "一条消息") : "一条消息"}
                    {replyTo ? `：${replyTo.content.replace(/\s+/g, " ").slice(0, 60)}` : ""}
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column" }}>
                    <ChatMessageItem message={msg} isOwn={isOwn} />
                  </div>
                  {isEncrypted && !isObserver && msg.msg_type !== "system" && (
                    <button
                      type="button"
                      className="icon-btn"
                      style={{ width: 26, height: 26, opacity: 0.45, flexShrink: 0 }}
                      title="回复此消息"
                      aria-label="回复此消息"
                      onClick={() =>
                        setReplyTarget({
                          id: msg.id,
                          senderInboxId: msg.xmtpSenderInboxId,
                          senderName: msg.sender_name ?? msg.sender_id.slice(0, 8),
                          excerpt: msg.content.replace(/\s+/g, " ").slice(0, 60),
                        })
                      }
                    >
                      <Reply size={13} strokeWidth={1.9} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {isObserver ? (
          <div className="chat-notice">当前为只读观察者模式，仅可旁听协作过程。</div>
        ) : (
          <ChatInput
            disabled={isEncrypted ? !xmtpConnected : connectionStatus !== "open"}
            onlineAgents={onlineAgentNames}
            pausedAgents={pausedAgentNames}
            onSend={handleSend}
            roomId={roomId}
            identityAddress={isEncrypted ? myXmtpAddress || null : user?.id ?? null}
            draftKeyMaterial={
              isEncrypted ? draftKeyMaterial : localStorage.getItem("mapr-auth-token")
            }
            replyTarget={replyTarget}
            onCancelReply={() => setReplyTarget(null)}
          />
        )}
      </section>

      {panelOpen && (
        <>
          <div
            className="side-panel-backdrop"
            onClick={() => setPanelOpen(false)}
            aria-hidden="true"
          />
          <aside className="side-panel open">
            <nav className="side-panel__tabs panel-tabs">
              {TABS.filter((tab) => tabVisibleInRoom(tab.id, isEncrypted)).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={`side-panel__tab ${activeTab === tab.id ? "side-panel__tab--active" : ""}`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  {tab.icon}
                  <span>{tab.label}</span>
                </button>
              ))}
              <button
                type="button"
                className="icon-btn side-panel-close-mobile"
                onClick={() => setPanelOpen(false)}
                aria-label="关闭侧栏"
                title="关闭侧栏"
              >
                <X size={16} strokeWidth={1.9} />
              </button>
            </nav>
            <div className="side-panel__body">
              {activeTab === "members" && (
                <MembersPanel
                  participants={participants}
                  seats={roomSeatsQuery.data}
                  roomId={roomId}
                  currentUserId={user?.id}
                  isOwner={myRoomRole === "owner"}
                  xmtpClient={xmtpClient}
                  xmtpGroupId={room?.xmtp_group_id}
                  onSeatRemoved={() => void roomSeatsQuery.refetch()}
                />
              )}
              {activeTab === "tasks" && (
                <TasksPanel tasks={tasks.filter((t) => !t.room_id || t.room_id === roomId)} />
              )}
              {activeTab === "dialogue" && <DialoguePanel roomId={roomId} onlineAgents={onlineAgentNames} />}
              {activeTab === "files" && !isEncrypted && <FilesPanel roomId={roomId} />}
              {activeTab === "permissions" && (
                <PermissionsPanel
                  roomId={roomId}
                  isEncrypted={Boolean(isEncrypted)}
                  isOwner={myRoomRole === "owner"}
                  xmtpClient={xmtpClient}
                  xmtpGroupId={room?.xmtp_group_id}
                  myXmtpAddress={myXmtpAddress || null}
                  room={room ?? undefined}
                  pendingRequests={pendingRequests}
                  permissionsQuery={permissionsQuery}
                />
              )}
              {activeTab === "approvals" && <OwnerApprovalPanel roomId={roomId} />}
              {activeTab === "activity" && <ActivityPanel roomId={roomId} />}
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
