import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams, Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { Client } from "@xmtp/browser-sdk";
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
import { useAnalytics } from "../hooks/useAnalytics";
import { ChatMessageItem, type ChatMessageWithTrust } from "../components/ChatMessage";
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
import {
  fetchMessages,
  fetchAgents,
  fetchTasks,
  searchMessages,
  apiFetch,
  bindXmtpGroup,
} from "../lib/api";
import {
  clearUnlockedXmtpKey,
  createLocalXmtpClient,
  inboxAddress,
  setUnlockedXmtpKey,
  signXmtpMessage,
} from "../lib/xmtpLocalIdentity";
import { sendXmtpMessage, sendXmtpReply, toLocalChatMessage } from "../lib/xmtpSend";
import { extractXmtpMessageText, XmtpSearchIndex } from "../lib/xmtpSearch";
import {
  HELPER_ORIGIN,
  acceptRoomInvite,
  formatInviteAcceptError,
  isMobileBrowser,
  issueSignatureNonce,
  listLocalSeats,
  listRoomInvites,
  listRoomRedemptions,
  listRoomSeats,
  markSeatGroupAdded,
  probeHelper,
  redeemRoomInvite,
  type HubSeatView,
} from "../lib/localHelper";
import {
  collectGroupSyncAddresses,
  syncPendingSeatsToGroup,
  syncRedeemedInvitesToGroup,
} from "../lib/seatGroupSync";
import { buildInboxAddressMap, resolveXmtpSender } from "../lib/roomIdentity";
import { describeEnvelope } from "../lib/envelopeView";
import { tabVisibleInRoom, type RoomTabId } from "../lib/roomTabs";
import { useAuthStore } from "../stores/authStore";
import { useChatStore } from "../stores/chatStore";
import type { Room, SenderType } from "../types/chat";

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

interface RawXmtpMessage {
  id: string;
  senderInboxId: string;
  content: string;
  createdAt: string;
  replyToId?: string;
}

type XmtpChatMessage = ChatMessageWithTrust & {
  replyToId?: string;
  xmtpSenderInboxId?: string;
};

function shallowEqualRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export function RoomPage() {
  const params = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const roomId = params.roomId ?? "";

  // 多人受邀入群状态：若 URL 携带 ?invite=<token>，先调 /accept 自动授予房间成员权限再拉取房间数据
  const inviteTokenFromUrl = searchParams.get("invite") ?? "";
  const acceptedInviteTokensRef = useRef<Set<string>>(new Set());
  const [inviteAccepting, setInviteAccepting] = useState(() => Boolean(inviteTokenFromUrl));
  const [inviteAcceptError, setInviteAcceptError] = useState<string | null>(null);
  const [pendingInviteToken, setPendingInviteToken] = useState(inviteTokenFromUrl);
  const [inviteRedeemedWaiting, setInviteRedeemedWaiting] = useState(false);
  const [invitePendingApproval, setInvitePendingApproval] = useState(false);
  const [inviteRedeemError, setInviteRedeemError] = useState("");
  const redeemedTokensRef = useRef<Set<string>>(new Set());

  const roomReadyForQueries = Boolean(roomId) && !inviteAccepting;

  const roomQuery = useQuery({
    queryKey: ["rooms", roomId],
    queryFn: async () => {
      const res = await apiFetch(`/api/v1/rooms/${roomId}`);
      if (!res.ok) return null;
      return (await res.json()).room as Room;
    },
    enabled: roomReadyForQueries,
  });

  useEffect(() => {
    if (!inviteTokenFromUrl) {
      setInviteAcceptError(null);
      setInviteAccepting(false);
      return;
    }
    setPendingInviteToken(inviteTokenFromUrl);
    if (acceptedInviteTokensRef.current.has(inviteTokenFromUrl)) {
      setInviteAccepting(false);
      return;
    }
    let cancelled = false;
    setInviteAcceptError(null);
    setInviteAccepting(true);
    acceptRoomInvite(inviteTokenFromUrl)
      .then(() => {
        if (!cancelled) setInviteAcceptError(null);
      })
      .catch((err) => {
        /* 即使已失效或已是成员，仍继续加载房间；若非成员则在错误卡片展示明确失效原因 */
        if (!cancelled) setInviteAcceptError(formatInviteAcceptError(err));
      })
      .finally(() => {
        acceptedInviteTokensRef.current.add(inviteTokenFromUrl);
        if (!cancelled) {
          setInviteAccepting(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [inviteTokenFromUrl]);

  const room = roomQuery.data;
  const isEncrypted = room?.transport === "xmtp";
  const wsEnabled = roomReadyForQueries && (!inviteAcceptError || Boolean(room));

  const { sendMessage } = useWebSocket(roomId, room?.transport, wsEnabled);
  const { track } = useAnalytics();
  const user = useAuthStore((state) => state.user);

  const storedMessages = useChatStore((state) => state.messages);
  const wsMessages = storedMessages.filter((m) => m.room_id === roomId);
  const setMessages = useChatStore((state) => state.setMessages);
  const connectionStatus = useChatStore((state) => state.connectionStatus);
  const participants = useChatStore((state) => state.participants);
  const tasks = useChatStore((state) => state.tasks);
  const setTasks = useChatStore((state) => state.setTasks);

  const [xmtpClient, setXmtpClient] = useState<Client<any> | null>(null);
  const [unlockedKey, setUnlockedKey] = useState<string | null>(null);
  const [xmtpError, setXmtpError] = useState("");
  const [xmtpConnected, setXmtpConnected] = useState(false);
  const [xmtpNotInGroup, setXmtpNotInGroup] = useState(false);
  const [clientRetry, setClientRetry] = useState(0);
  const [listenRetry, setListenRetry] = useState(0);
  const [myXmtpAddress, setMyXmtpAddress] = useState("");
  const [bindingGroup, setBindingGroup] = useState(false);

  const [rawXmtpMessages, setRawXmtpMessages] = useState<RawXmtpMessage[]>([]);
  const [replyTarget, setReplyTarget] = useState<ReplyTargetInfo | null>(null);
  const [inboxAddresses, setInboxAddresses] = useState<Record<string, string>>({});
  const inboxAddressesRef = useRef<Record<string, string>>({});
  const seatsRef = useRef<HubSeatView[]>([]);

  const [panelOpen, setPanelOpen] = useState(() =>
    typeof window === "undefined" ? true : window.innerWidth > 860,
  );
  const [activeTab, setActiveTab] = useState<TabId>("members");
  const [dismissedCrashKey, setDismissedCrashKey] = useState("");
  const [shareUrl, setShareUrl] = useState("");

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

  const permissionsQuery = useQuery({
    queryKey: ["rooms", roomId, "permissions"],
    queryFn: async () => {
      const res = await apiFetch(`/api/v1/rooms/${roomId}/permissions`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: roomReadyForQueries,
  });

  const myRoomRole = permissionsQuery.data?.members?.find(
    (m: { user_id?: string }) => m.user_id === user?.id,
  )?.role as string | undefined;

  const isObserver = useMemo(() => {
    if (!permissionsQuery.data?.members || !user?.id) return false;
    const myPerm = permissionsQuery.data.members.find(
      (m: { user_id?: string }) => m.user_id === user.id,
    );
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

  const roomSeatsQuery = useQuery({
    queryKey: ["rooms", roomId, "seats"],
    queryFn: () => listRoomSeats(roomId),
    enabled: roomReadyForQueries,
    refetchInterval: 8000,
  });

  useEffect(() => {
    seatsRef.current = roomSeatsQuery.data ?? [];
  }, [roomSeatsQuery.data]);

  const isMobile = isMobileBrowser();
  // 仅当桌面端助手在运行且已配对时，检查当前房间的本机席位。
  const localSeatsQuery = useQuery({
    queryKey: ["local-helper-room-seats", roomId],
    queryFn: async () => {
      const probe = await probeHelper();
      if (probe.state !== "running" || !probe.hello.paired) return [];
      try {
        return await listLocalSeats();
      } catch {
        return [];
      }
    },
    enabled: Boolean(roomReadyForQueries && isEncrypted && !isMobile),
    refetchInterval: 15000,
    retry: false,
  });

  const crashedLocalSeats = useMemo(
    () => (localSeatsQuery.data ?? []).filter((s) => s.roomId === roomId && s.status === "crashed"),
    [localSeatsQuery.data, roomId],
  );
  const crashKey = crashedLocalSeats.map((s) => s.seatId).sort().join(",");
  const showCrashBanner = !isMobile && crashedLocalSeats.length > 0 && dismissedCrashKey !== crashKey;

  const updateInboxMap = useCallback((members: { inboxId?: string; accountIdentifiers?: { identifier?: string }[] }[]) => {
    const next = buildInboxAddressMap(members);
    inboxAddressesRef.current = next;
    setInboxAddresses((prev) => (shallowEqualRecord(prev, next) ? prev : next));
  }, []);

  // 解锁后若有 ?invite=<token>，自动提交 0x 地址核销；仅在核销成功或 404/410 终态后才擦除地址栏参数
  useEffect(() => {
    if (!pendingInviteToken || !myXmtpAddress) return;
    if (redeemedTokensRef.current.has(pendingInviteToken)) return;
    redeemedTokensRef.current.add(pendingInviteToken);

    const tokenToRedeem = pendingInviteToken;
    setInviteRedeemError("");

    const clearInviteParam = () => {
      setPendingInviteToken("");
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("invite");
          return next;
        },
        { replace: true },
      );
    };

    // EIP-191 签名核销：先领一次性 nonce，再用已解锁的本机身份签名提交。
    (async () => {
      const challenge = await issueSignatureNonce({
        action: "invite-redeem",
        resource: tokenToRedeem,
        address: myXmtpAddress,
      });
      const signature = await signXmtpMessage(challenge.message);
      return redeemRoomInvite(tokenToRedeem, {
        xmtp_address: myXmtpAddress,
        nonce: challenge.nonce,
        signature,
      });
    })()
      .then((result) => {
        if (result.status === "pending") {
          // 需房主批准：申请已登记，等房主在「权限」面板批准
          setInvitePendingApproval(true);
        } else {
          setInviteRedeemedWaiting(true);
        }
        clearInviteParam();
        void permissionsQuery.refetch();
      })
      .catch((err) => {
        const status = (err as { status?: number } | null)?.status;
        setInviteRedeemError(err instanceof Error ? err.message : "核销入群邀请失败");
        if (status === 404 || status === 410 || status === 409) {
          clearInviteParam();
        } else {
          // 临时网络波动或签名失败：保留地址栏参数允许重试
          redeemedTokensRef.current.delete(tokenToRedeem);
        }
      });
  }, [pendingInviteToken, myXmtpAddress, permissionsQuery, setSearchParams]);

  // XMTP 客户端：解锁后建立
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
        if (!cancelled) {
          setXmtpError(err instanceof Error ? err.message : "无法连接加密房间");
        }
      }
    }

    void initXmtp();
    return () => {
      cancelled = true;
      activeClient?.close();
      setXmtpClient(null);
    };
  }, [isEncrypted, unlockedKey, roomId, clientRetry, permissionsQuery.isPending]);

  // 已解锁私钥登记到内存会话，供 EIP-191 签名（绑定地址/核销邀请）使用；离开房间即清除。
  useEffect(() => {
    setUnlockedXmtpKey(unlockedKey);
    return () => clearUnlockedXmtpKey();
  }, [unlockedKey]);

  // 订阅加密群消息 + 读取成员映射
  useEffect(() => {
    const targetGroupId = room?.xmtp_group_id;
    if (!xmtpClient || !isEncrypted || !targetGroupId) return;
    let cancelled = false;
    let stop: (() => Promise<unknown>) | undefined;
    const client = xmtpClient;

    function toRawEntry(message: any): RawXmtpMessage | null {
      if (!message || message.conversationId !== targetGroupId) return null;
      const extracted = extractXmtpMessageText(message);
      if (!extracted) return null;
      return {
        id: String(message.id),
        senderInboxId: String(message.senderInboxId ?? ""),
        content: describeEnvelope(extracted.text) ?? extracted.text,
        createdAt: message.sentAt instanceof Date ? message.sentAt.toISOString() : new Date().toISOString(),
        ...(extracted.replyToId ? { replyToId: extracted.replyToId } : {}),
      };
    }

    function upsertRawBatch(entries: RawXmtpMessage[]) {
      if (entries.length === 0) return;
      setRawXmtpMessages((prev) => {
        const byId = new Map(prev.map((m) => [m.id, m]));
        let changed = false;
        for (const item of entries) {
          if (!byId.has(item.id)) {
            byId.set(item.id, item);
            changed = true;
          }
        }
        if (!changed) return prev;
        return [...byId.values()].sort(
          (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id),
        );
      });
    }

    async function listen() {
      try {
        const stream = await client.conversations.streamAllMessages();
        stop = async () => {
          await stream.return();
        };
        if (cancelled) {
          await stop();
          return;
        }
        await client.conversations.syncAll();
        const group = await client.conversations.getConversationById(targetGroupId!);
        if (!group) {
          if (!cancelled) {
            setXmtpNotInGroup(true);
            setXmtpConnected(false);
            setXmtpError("");
          }
          await stop();
          return;
        }
        await group.sync();
        if (typeof (group as { members?: () => Promise<any[]> }).members === "function") {
          const members = await (group as { members: () => Promise<any[]> }).members();
          if (!cancelled) updateInboxMap(members);
        }

        const history = await group.messages();
        const initialBatch: RawXmtpMessage[] = [];
        for (const msg of history) {
          const entry = toRawEntry(msg);
          if (entry) initialBatch.push(entry);
        }
        if (!cancelled) {
          upsertRawBatch(initialBatch);
          setXmtpNotInGroup(false);
          setInviteRedeemedWaiting(false);
          setXmtpConnected(true);
          setXmtpError("");
        }

        for await (const message of stream) {
          if (cancelled) break;
          const entry = toRawEntry(message);
          if (!entry) continue;
          upsertRawBatch([entry]);
          if (entry.senderInboxId !== client.inboxId && !inboxAddressesRef.current[entry.senderInboxId]) {
            void group
              .sync()
              .then(async () => {
                if (typeof (group as { members?: () => Promise<any[]> }).members === "function") {
                  const members = await (group as { members: () => Promise<any[]> }).members();
                  if (!cancelled) updateInboxMap(members);
                }
              })
              .catch(() => {});
          }
        }

        if (!cancelled) {
          setXmtpConnected(false);
          setXmtpError("加密连接已断开，请重新连接");
        }
      } catch (err) {
        if (!cancelled) {
          setXmtpConnected(false);
          setXmtpError(err instanceof Error ? err.message : "加密连接失败");
        }
      }
    }

    void listen();
    return () => {
      cancelled = true;
      setXmtpConnected(false);
      void stop?.();
    };
  }, [xmtpClient, isEncrypted, room?.xmtp_group_id, listenRetry, updateInboxMap]);

  // 5 秒同步循环：
  // 1) 若受邀者尚未入群，探测群是否已被房主拉入并在入群后自动激活监听；
  // 2) 刷新 group.members() 地址映射；
  // 3) 同步当前用户待入群的 Agent 席位；
  // 4) 若当前用户是房主，自动将已核销邀请链接的协作方拉进加密群。
  useEffect(() => {
    const targetGroupId = room?.xmtp_group_id;
    if (!xmtpClient || !isEncrypted || !targetGroupId || !user?.id) return;
    const currentUserId = user.id;
    let cancelled = false;
    let running = false;

    const tick = async () => {
      if (cancelled || running) return;
      running = true;
      try {
        if (xmtpNotInGroup) {
          await xmtpClient.conversations.syncAll();
          const joinedGroup = await xmtpClient.conversations.getConversationById(targetGroupId);
          if (!cancelled && joinedGroup) {
            setXmtpNotInGroup(false);
            setInviteRedeemedWaiting(false);
            setListenRetry((n) => n + 1);
          }
          return;
        }

        const group = await xmtpClient.conversations.getConversationById(targetGroupId);
        if (group) {
          await group.sync();
          if (typeof (group as { members?: () => Promise<any[]> }).members === "function") {
            const members = await (group as { members: () => Promise<any[]> }).members();
            if (!cancelled) updateInboxMap(members);
          }
        }

        const seatOutcome = await syncPendingSeatsToGroup({
          client: xmtpClient,
          roomId,
          groupId: targetGroupId,
          currentUserId,
          isRoomOwner: myRoomRole === "owner",
          deps: { listSeats: listRoomSeats, markAdded: markSeatGroupAdded },
        });

        let addedCollaborators = 0;
        if (myRoomRole === "owner") {
          const inviteOutcome = await syncRedeemedInvitesToGroup({
            client: xmtpClient,
            roomId,
            groupId: targetGroupId,
            // 地址来源：已批准/已核销的 redemptions + 成员行已绑定地址 + 旧版邀请字段。
            // 绝不包含 pending 核销——未批准的申请者不能进加密群。
            listAddresses: async (rid) => {
              const [invites, redemptions, permsRes] = await Promise.all([
                listRoomInvites(rid).catch(() => []),
                listRoomRedemptions(rid).catch(() => []),
                apiFetch(`/api/v1/rooms/${rid}/permissions`)
                  .then((r) => (r.ok ? r.json() : { members: [] }))
                  .catch(() => ({ members: [] })),
              ]);
              return collectGroupSyncAddresses({
                invites,
                redemptions,
                members: permsRes?.members ?? [],
              });
            },
          });
          addedCollaborators = inviteOutcome.addedAddresses.length;
        }

        if (!cancelled && (seatOutcome.added.length > 0 || seatOutcome.reported.length > 0)) {
          void roomSeatsQuery.refetch();
        }
        if (!cancelled && (seatOutcome.added.length > 0 || addedCollaborators > 0) && group) {
          await group.sync();
          if (typeof (group as { members?: () => Promise<any[]> }).members === "function") {
            const members = await (group as { members: () => Promise<any[]> }).members();
            if (!cancelled) updateInboxMap(members);
          }
        }
      } catch {
        /* 单轮同步异常留给下一轮重试 */
      } finally {
        running = false;
      }
    };

    void tick();
    const timer = window.setInterval(tick, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    xmtpClient,
    isEncrypted,
    room?.xmtp_group_id,
    roomId,
    user?.id,
    myRoomRole,
    xmtpNotInGroup,
    updateInboxMap,
    roomSeatsQuery,
  ]);

  // 动态映射加密消息：当 roomSeatsQuery.data 或 inboxAddresses 稍后就绪时立即更新真实名称与信任徽章
  const xmtpMessages: XmtpChatMessage[] = useMemo(() => {
    const myInboxId = xmtpClient?.inboxId ?? "";
    const myUsername = user?.display_name || user?.username || "我";
    const seats = roomSeatsQuery.data ?? [];

    return rawXmtpMessages.map((raw) => {
      const resolved = resolveXmtpSender({
        senderInboxId: raw.senderInboxId,
        myInboxId,
        myUsername,
        inboxAddresses,
        seats,
      });
      const base = toLocalChatMessage({
        id: raw.id,
        roomId,
        content: raw.content,
        senderId: raw.senderInboxId === myInboxId ? (user?.id ?? raw.senderInboxId) : raw.senderInboxId,
        senderName: resolved.senderName,
        senderType: resolved.senderType,
        createdAt: raw.createdAt,
      });
      const extended: XmtpChatMessage = {
        ...base,
        xmtpSenderInboxId: raw.senderInboxId,
        ...(raw.replyToId ? { replyToId: raw.replyToId } : {}),
      };
      return resolved.trustTier ? { ...extended, trustTier: resolved.trustTier } : extended;
    });
  }, [rawXmtpMessages, inboxAddresses, roomSeatsQuery.data, xmtpClient?.inboxId, user, roomId]);

  const displayMessages: XmtpChatMessage[] = isEncrypted ? xmtpMessages : wsMessages;
  const displayMessageById = useMemo(
    () => new Map(displayMessages.map((m) => [m.id, m])),
    [displayMessages],
  );

  // 当加密群尚在建立客户端或拉取初始消息历史时标记为加载中，防止历史消息触发桌面通知风暴
  const xmtpLoading = Boolean(
    isEncrypted && (!xmtpConnected && (!unlockedKey || (room?.xmtp_group_id && !xmtpNotInGroup && !xmtpError))),
  );
  const xmtpConnecting = Boolean(
    isEncrypted && unlockedKey && room?.xmtp_group_id && !xmtpConnected && !xmtpNotInGroup && !xmtpError,
  );

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
    enabled: !isEncrypted && roomReadyForQueries,
    refetchInterval: 30000,
  });

  // 合并活跃加密席位名称与在线 WS Agent，供 @Agent 与 @全体 快捷胶囊使用
  const onlineAgentNames = useMemo(() => {
    const seatNames = (roomSeatsQuery.data ?? [])
      .filter((s) => s.group_status !== "removed")
      .map((s) => s.agent_display_name.trim())
      .filter(Boolean);
    const wsAgents = participants
      .filter((p) => p.sender_type === "agent")
      .map((p) => (p.sender_name || p.sender_id).trim())
      .filter(Boolean);
    const merged = Array.from(new Set([...seatNames, ...wsAgents]));
    if (merged.length > 0 || isEncrypted) return merged;
    return Array.from(
      new Set(
        (agentsQuery.data ?? [])
          .map((a) => a.name.trim())
          .filter(Boolean),
      ),
    ).slice(0, 6);
  }, [roomSeatsQuery.data, participants, isEncrypted, agentsQuery.data]);

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

  const [searchQuery, setSearchQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [searchResults, setSearchResults] = useState<typeof wsMessages>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchSender, setSearchSender] = useState("");

  // XMTP 本机搜索索引：随加密群切换重建，只吃历史+流增量，绝不触 Hub。
  const xmtpSearchIndex = useMemo(() => new XmtpSearchIndex(), [room?.xmtp_group_id]);
  useEffect(() => {
    if (!isEncrypted) return;
    xmtpSearchIndex.ingest(rawXmtpMessages);
  }, [xmtpSearchIndex, isEncrypted, rawXmtpMessages]);

  // 加密房发送者过滤下拉选项：inboxId → 已解析显示名
  const xmtpSenderOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of xmtpMessages) {
      if (m.xmtpSenderInboxId && !map.has(m.xmtpSenderInboxId)) {
        map.set(m.xmtpSenderInboxId, m.sender_name ?? m.sender_id.slice(0, 8));
      }
    }
    return [...map.entries()];
  }, [xmtpMessages]);

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [displayMessages.length]);

  const handleSend = (content: string, senderType: SenderType = "human") => {
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

  async function handleQuickBindGroup() {
    if (!xmtpClient || !room || bindingGroup) return;
    setBindingGroup(true);
    setXmtpError("");
    try {
      const group = await xmtpClient.conversations.createGroup([]);
      await bindXmtpGroup(room.id, group.id);
      await roomQuery.refetch();
    } catch (err) {
      setXmtpError(err instanceof Error ? err.message : "创建并绑定加密群失败");
    } finally {
      setBindingGroup(false);
    }
  }

  async function handleShare() {
    try {
      const res = await apiFetch(`/api/v1/rooms/${roomId}/share`, {
        method: "POST",
        body: JSON.stringify({ expires_hours: 72 }),
      });
      if (res.ok) {
        const data = await res.json();
        const url = `${window.location.origin}${data.share_url}`;
        await navigator.clipboard.writeText(url).catch(() => {});
        setShareUrl(url);
      }
    } catch {
      /* 静默 */
    }
  }

  async function handleSearch() {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    // 加密房：纯本机内存索引检索，绝不请求 Hub 搜索接口、不落盘明文索引。
    if (isEncrypted) {
      const entries = xmtpSearchIndex.search(searchQuery.trim(), {
        senderInboxId: searchSender || undefined,
      });
      setSearchResults(
        entries.map((e) => {
          const display = displayMessageById.get(e.id);
          return toLocalChatMessage({
            id: e.id,
            roomId,
            content: e.content,
            senderId: e.senderInboxId,
            senderName: display?.sender_name ?? `${e.senderInboxId.slice(0, 8)}`,
            senderType: display?.sender_type ?? "human",
            createdAt: e.createdAt,
          });
        }),
      );
      setIsSearching(false);
      return;
    }
    try {
      const results = await searchMessages(roomId, searchQuery.trim());
      setSearchResults(results);
    } catch {
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }

  // 加密房切换发送者过滤时按当前关键词自动重查
  useEffect(() => {
    if (isEncrypted && showSearch && searchQuery.trim()) void handleSearch();
  }, [searchSender, isEncrypted, showSearch, searchQuery]);

  if (inviteAccepting) {
    return (
      <div className="loading-center" style={{ minHeight: "100%" }}>
        <span className="spinner" />
        <span>正在验证入群邀请并开通房间权限…</span>
      </div>
    );
  }

  if (roomQuery.isError || (roomQuery.isSuccess && !room)) {
    return (
      <div className="page-error card">
        <p>{inviteAcceptError ?? "房间不存在或没有访问权限。"}</p>
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
              onClick={() => setShowSearch(!showSearch)}
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

        {shareUrl && (
          <div className="share-toast" role="status">
            <CheckCircle2 size={15} strokeWidth={2} style={{ color: "var(--success)", flexShrink: 0 }} />
            <span className="share-toast__text">只读分享链接已复制（72 小时内有效）</span>
            <div className="share-toast__actions">
              <CopyButton text={shareUrl} label="再次复制" />
              <a
                href={shareUrl}
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
                onClick={() => setShareUrl("")}
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
              onClick={() => {
                setShowSearch(false);
                setSearchResults([]);
                setSearchQuery("");
                setSearchSender("");
              }}
            >
              <X size={16} strokeWidth={1.9} />
            </button>
          </div>
        )}
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
              <a
                className="btn btn-ghost btn-sm"
                href={`${HELPER_ORIGIN}/`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span>打开本机助手查看</span>
                <ExternalLink size={12} strokeWidth={2} />
              </a>
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

          {isEncrypted && !unlockedKey && (
            <div style={{ width: "100%" }}>
              {pendingInviteToken && (
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

          {xmtpConnecting && (
            <div className="loading-center" style={{ padding: "36px 0" }}>
              <span className="spinner" />
              <span>正在连接端到端加密群并同步对话…</span>
            </div>
          )}

          {isEncrypted && unlockedKey && !room?.xmtp_group_id && (
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

          {inviteRedeemError && (
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
              邀请链接核销提示：{inviteRedeemError}。你也可以直接复制下方加密地址发给房主拉你入群。
            </div>
          )}

          {/* 受邀协作者的核销申请已登记，等待房主在「权限」面板批准 */}
          {isEncrypted && xmtpNotInGroup && invitePendingApproval && (
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
          {isEncrypted && xmtpNotInGroup && inviteRedeemedWaiting && (
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
          {isEncrypted && xmtpNotInGroup && !inviteRedeemedWaiting && (
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
                  onClick={() => {
                    if (xmtpClient) {
                      setListenRetry((n) => n + 1);
                    } else {
                      setClientRetry((n) => n + 1);
                    }
                  }}
                >
                  <RefreshCw size={13} strokeWidth={2} />
                  <span>房主已拉我 · 立即重连</span>
                </button>
              </div>
            </div>
          )}

          {isEncrypted && xmtpError && (
            <div className="auth-error" role="alert" style={{ alignSelf: "center" }}>
              {xmtpError}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ marginLeft: 8 }}
                onClick={() => {
                  setXmtpError("");
                  if (xmtpClient) {
                    setListenRetry((n) => n + 1);
                  } else {
                    setClientRetry((n) => n + 1);
                  }
                }}
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

          {((!isEncrypted && !messagesQuery.isLoading && displayMessages.length === 0) ||
            (isEncrypted && xmtpConnected && !xmtpLoading && !xmtpNotInGroup && displayMessages.length === 0)) && (
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
            const isOwn = msg.sender_type !== "agent" && msg.sender_id === (user?.id ?? "");
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
            onSend={handleSend}
            roomId={roomId}
            identityAddress={isEncrypted ? myXmtpAddress || null : user?.id ?? null}
            draftKeyMaterial={
              isEncrypted ? unlockedKey : localStorage.getItem("mapr-auth-token")
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
                  onPermissionsChanged={() => void permissionsQuery.refetch()}
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
