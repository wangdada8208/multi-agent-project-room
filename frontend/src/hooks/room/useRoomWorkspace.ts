import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useWebSocket } from "../useWebSocket";
import { useNotification } from "../useNotification";
import { useLocalHelper } from "../useLocalHelper";
import { useAnalytics } from "../useAnalytics";
import { useRoomData } from "./useRoomData";
import { useInviteFlow, useInviteRedemption } from "./useInviteFlow";
import { useXmtpSession } from "./useXmtpSession";
import { useXmtpMessages } from "./useXmtpMessages";
import { useGroupSync } from "./useGroupSync";
import { useMessageSearch } from "./useMessageSearch";
import { usePendingRequests } from "./usePendingRequests";
import { useRoomRequestDecisions } from "./useRoomRequestDecisions";
import { useSeatActions } from "./useSeatActions";
import { deriveDisplayMessages } from "../../lib/domain/displayMessages";
import { mentionCandidatesFrom } from "../../lib/domain/mentions";
import { roomTemplateKey } from "../../lib/roomTemplate";
import { roomStatusView } from "../../lib/domain/roomStatusView";
import { fetchMessages, fetchAgents, fetchTasks, fetchTemplates } from "../../lib/api";
import { sendXmtpMessage, sendXmtpReply } from "../../lib/xmtpSend";
import { listLocalSeats, type HubSeatView } from "../../lib/localHelper";
import { useAuthStore } from "../../stores/authStore";
import { useChatStore } from "../../stores/chatStore";
import type { SenderType } from "../../types/chat";
import type { ReplyTargetInfo } from "../../components/room/Composer";

const emptySeats: HubSeatView[] = [];

export function useRoomWorkspace(roomId: string) {
  const [searchParams, setSearchParams] = useSearchParams();
  const inviteTokenFromUrl = searchParams.get("invite") ?? "";
  const { invite, dispatch: dispatchInvite, accepting: inviteAccepting } = useInviteFlow(inviteTokenFromUrl);
  const inviteAcceptError = invite.kind === "acceptFailed" ? invite.message : null;
  const roomReadyForQueries = Boolean(roomId) && !inviteAccepting;
  const user = useAuthStore((state) => state.user);
  const { roomQuery, permissionsQuery, roomSeatsQuery, myRoomRole, roomError, isObserver } =
    useRoomData(roomId, user?.id, roomReadyForQueries);
  const room = roomQuery.data;
  const isEncrypted = room?.transport === "xmtp";
  const templateKey = roomTemplateKey(room);
  const templates = useQuery({ queryKey: ["templates"], queryFn: fetchTemplates, enabled: Boolean(templateKey), retry: false });
  const template = templates.data?.find((entry) => entry.key === templateKey)?.name ?? templateKey;
  const { sendMessage } = useWebSocket(roomId, room?.transport, roomReadyForQueries && (!inviteAcceptError || Boolean(room)));
  const { track } = useAnalytics();

  const { session, xmtpClient, setUnlockedKey, lock, listenRetry, dispatch, restartListener, reconnect, myXmtpAddress, draftKeyMaterial,
    bindingGroup, bindGroup: handleQuickBindGroup } = useXmtpSession({
      roomId, groupId: room?.xmtp_group_id, enabled: isEncrypted && !permissionsQuery.isPending, refreshRoom: roomQuery.refetch,
      autoBind: myRoomRole === "owner",
    });
  const { rawXmtpMessages, inboxAddresses, updateInboxMap } = useXmtpMessages(xmtpClient, room?.xmtp_group_id, listenRetry, dispatch);
  const { refetch: refetchSeats, data: seats = emptySeats } = roomSeatsQuery;
  const { refetch: refetchPermissions } = permissionsQuery;
  const pendingRequests = usePendingRequests(roomId, myRoomRole === "owner");
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
  const xmtpConnecting = session.kind === "connecting";
  const xmtpLoading = isEncrypted && (session.kind === "locked" || xmtpConnecting);

  const storedMessages = useChatStore((state) => state.messages);
  const setMessages = useChatStore((state) => state.setMessages);
  const connectionStatus = useChatStore((state) => state.connectionStatus);
  const participants = useChatStore((state) => state.participants);
  const tasks = useChatStore((state) => state.tasks);
  const setTasks = useChatStore((state) => state.setTasks);

  const [replyTarget, setReplyTarget] = useState<ReplyTargetInfo | null>(null);
  const [dismissedCrashKey, setDismissedCrashKey] = useState("");

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

  const humanNames = useMemo(() => new Map((permissionsQuery.data?.members ?? [])
    .filter((member) => member.user_type !== "agent" && member.xmtp_address)
    .map((member) => [member.xmtp_address?.toLowerCase() ?? "", member.display_name || member.username])),
    [permissionsQuery.data]);
  const memberNames = useMemo(() => new Map((permissionsQuery.data?.members ?? [])
    .map((member) => [member.user_id, member.display_name || member.username])), [permissionsQuery.data]);

  const displayMessages = useMemo(() => isEncrypted ? deriveDisplayMessages({
    transport: "xmtp", messages: rawXmtpMessages, inboxAddresses, seats, roomId, humanNames, memberNames,
    myInboxId: xmtpClient?.inboxId ?? "", myUsername: user?.display_name || user?.username || "我", userId: user?.id,
  }) : deriveDisplayMessages({
    transport: "hub", messages: storedMessages.filter((message) => message.room_id === roomId), seats, userId: user?.id,
  }), [isEncrypted, rawXmtpMessages, inboxAddresses, seats, roomId, xmtpClient?.inboxId, user, storedMessages, humanNames, memberNames]);
  const displayMessageById = useMemo(() => new Map(displayMessages.map((message) => [message.id, message])), [displayMessages]);
  const statusView = isEncrypted ? roomStatusView(session, invite, myRoomRole, displayMessages.length > 0) : null;

  const { enabled: notifEnabled, toggle: toggleNotifications } = useNotification(
    displayMessages,
    { ready: !isEncrypted ? !messagesQuery.isLoading : !xmtpLoading, scopeKey: roomId },
  );

  const tasksQuery = useQuery({
    queryKey: ["rooms", roomId, "tasks"],
    queryFn: () => fetchTasks(roomId),
    enabled: roomReadyForQueries,
    refetchInterval: 15000,
    refetchIntervalInBackground: false,
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

  const candidates = useMemo(() => {
    const humans = (permissionsQuery.data?.members ?? [])
      .filter((member) => member.user_type !== "agent")
      .map((member) => ({ sender_id: member.user_id, sender_name: member.display_name || member.username,
        sender_type: "human" as const, joined_at: "", last_seen_at: "" }));
    const listed = mentionCandidatesFrom(seats, [...humans, ...participants]);
    if (!isEncrypted && !listed.some((item) => item.actor === "local" && !item.disabled)) {
      for (const agent of agentsQuery.data ?? []) {
        const name = agent.name.trim();
        if (name && !listed.some((item) => item.name === name)) listed.push({ id: name, name, actor: "local", disabled: false });
      }
    }
    return listed.map((candidate) => {
      const seat = seats.find((item) => item.seat_id === candidate.id);
      return seat ? { ...candidate, status: seat.group_status === "added" ? "已入群" as const : "待入群" as const } : candidate;
    });
  }, [seats, participants, permissionsQuery.data, isEncrypted, agentsQuery.data]);
  const onlineAgentNames = useMemo(() => candidates
    .filter((candidate) => !candidate.disabled && (candidate.actor === "cloud" || candidate.actor === "local"))
    .map((candidate) => candidate.name), [candidates]);

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

  const search = useMessageSearch({
      roomId, transport: room ? room.transport ?? "hub" : undefined, groupId: room?.xmtp_group_id,
      rawMessages: rawXmtpMessages, displayById: displayMessageById,
    });

  const canSendNow = !isObserver && (isEncrypted ? xmtpConnected : connectionStatus === "open");
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


  const requests = useRoomRequestDecisions(pendingRequests.decide, inboxAddresses, isEncrypted);
  const seatActions = useSeatActions(xmtpClient, room?.xmtp_group_id, () => void refetchSeats());

  return {
    room, user, template, isEncrypted, roomError, roomLoaded: roomQuery.isSuccess, isObserver, myRoomRole, permissionsQuery,
    invite, inviteAccepting, inviteAcceptError, retryInvite, session, xmtpClient, setUnlockedKey, lock, reconnect,
    myXmtpAddress, draftKeyMaterial, bindingGroup, handleQuickBindGroup, seats, participants, tasks,
    search, displayMessages, displayMessageById, statusView, candidates, onlineAgentNames, starterChips,
    notifEnabled, toggleNotifications,
    requests, pending: pendingRequests.requests, seatActions, replyTarget, setReplyTarget, handleSend, canSendNow,
    messagesQuery, showCrashBanner, crashedLocalSeats, dismissCrash: () => setDismissedCrashKey(crashKey),
  };
}
