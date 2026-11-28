import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AlertCircle, X } from "lucide-react";
import { HelperLink } from "../components/HelperLink";
import { toast } from "../components/ui/Toast";
import { IconButton } from "../components/ui/IconButton";
import { Composer } from "../components/room/Composer";
import { MessageList } from "../components/room/MessageList";
import { PendingRequestBanner } from "../components/room/PendingRequestBanner";
import { RoomHeader } from "../components/room/RoomHeader";
import { inspectorTab, RoomInspector, type InspectorTab } from "../components/room/RoomInspector";
import { RoomSearch } from "../components/room/RoomSearch";
import { RoomShell } from "../components/room/RoomShell";
import { RoomStatusCard } from "../components/room/RoomStatusCard";
import { ActivityTab } from "../components/room/tabs/ActivityTab";
import { InviteTab } from "../components/room/tabs/InviteTab";
import { MembersTab } from "../components/room/tabs/MembersTab";
import { RulesTab } from "../components/room/tabs/RulesTab";
import type { AvatarProps } from "../components/ui/Avatar";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useViewportWidth } from "../hooks/useViewportWidth";
import { useRoomWorkspace } from "../hooks/room/useRoomWorkspace";
import { apiJson } from "../lib/apiError";

export function RoomPage() {
  const roomId = useParams().roomId ?? "";
  const width = useViewportWidth();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const workspace = useRoomWorkspace(roomId);
  useDocumentTitle(workspace.room?.name ? `${workspace.room.name} · Parlor` : "房间 · Parlor");
  const { room, user, isEncrypted, myXmtpAddress, seats, pending, requests, search, statusView } = workspace;
  const isOwner = workspace.myRoomRole === "owner";
  const [prefill, setPrefill] = useState<{ text: string }>();
  const tabParam = params.get("panel");
  const panel = inspectorTab(tabParam);
  const tab = panel ?? "members";
  const showInspector = Boolean(panel || (tabParam !== "closed" && width >= 1024));
  function openInspector(next: InspectorTab | "closed") {
    setParams((previous) => {
      const url = new URLSearchParams(previous);
      url.set("panel", next);
      return url;
    }, { replace: true });
  }
  const closeInspector = () => openInspector("closed");

  const deleteRoom = useMutation({
    mutationFn: () => apiJson(`/api/v1/rooms/${encodeURIComponent(roomId)}`, { method: "DELETE" }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["rooms"], exact: true });
      navigate("/home");
    },
  });

  if (workspace.inviteAccepting) return <div className="loading-center" role="status">正在验证入群邀请并开通房间权限…</div>;
  if (workspace.roomError || (workspace.roomLoaded && !room)) return <div className="page-error card">
    <p>{workspace.inviteAcceptError ?? workspace.roomError?.message ?? "房间不存在或没有访问权限。"}</p>
    <Link to="/home">回到房间</Link>
  </div>;

  const members = workspace.permissionsQuery.data?.members ?? [];
  const humans = members.filter((member) => member.user_type !== "agent");
  const agents = seats.filter((seat) => seat.group_status !== "removed");
  const avatars: (AvatarProps & { id: string })[] = [
    ...humans.map((member): AvatarProps & { id: string } => ({
      id: member.user_id, name: member.display_name || member.username || member.user_id,
      actor: member.user_id === user?.id ? "me" : "human", size: "sm",
    })),
    ...agents.map((seat): AvatarProps & { id: string } => ({
      id: seat.seat_id, name: seat.agent_display_name, actor: seat.source === "invite" || seat.kind === "cloud-agent" ? "cloud" : "local", size: "sm",
    })),
  ];
  const encryption = isEncrypted ? {
    ready: workspace.session.kind === "ready", groupId: room?.xmtp_group_id, address: myXmtpAddress, onLock: workspace.lock,
  } : undefined;
  const permissions = {
    roomId, room, isEncrypted, isOwner, myXmtpAddress, xmtpClient: workspace.xmtpClient,
    xmtpGroupId: room?.xmtp_group_id, permissionsQuery: workspace.permissionsQuery,
  };
  const onPrefill = workspace.canSendNow ? (text: string) => setPrefill({ text }) : undefined;
  const approvedMessages = requests.joined.map((request) => ({
    id: `joined-${request.id}`, room_id: roomId, sender_id: "system",
    content: `${request.displayName} 已加入房间`, sender_type: "system" as const, msg_type: "system" as const,
    actor: "human" as const, sourceSubtitle: "", created_at: request.decided_at || new Date().toISOString(),
  }));

  return (
    <RoomShell roomId={roomId} pendingCount={pending.length}
      header={<RoomHeader name={room?.name ?? "加载中…"} template={workspace.template}
        encryption={encryption ? { ...encryption, humans: humans.length, agents: agents.length } : undefined}
        avatars={avatars} pending={pending.length} inspector={showInspector} searchOpen={search.showSearch} notifications={workspace.notifEnabled}
        onSearch={() => search.showSearch ? search.closeSearch() : search.setShowSearch(true)}
        onNotify={() => void workspace.toggleNotifications().catch(() => toast("无法更新通知设置。", "danger"))}
        onInvite={() => openInspector("invite")} onMembers={() => openInspector("members")}
        onInspector={() => showInspector ? closeInspector() : openInspector("members")} />}
      banner={<PendingRequestBanner isOwner={isOwner} requests={pending} {...requests} onOpen={() => openInspector("members")} />}
      search={<RoomSearch search={search} encrypted={isEncrypted} />}
      messages={<MessageList messages={[...workspace.displayMessages, ...approvedMessages]} byId={workspace.displayMessageById} owner={isOwner} candidates={workspace.candidates}
        onPrefill={onPrefill} onReply={isEncrypted && !workspace.isObserver ? (message) => workspace.setReplyTarget({
          id: message.id, senderInboxId: message.xmtpSenderInboxId,
          senderName: message.sender_name || message.sender_id.slice(0, 8),
          excerpt: message.content.replace(/\s+/gu, " ").slice(0, 60),
        }) : undefined}
        notice={<>
          {workspace.showCrashBanner && <div className="wb-notice">
            <AlertCircle size={17} /><span>电脑助手（{workspace.crashedLocalSeats.map((seat) => seat.agentKey).join("、")}）异常退出。</span>
            <HelperLink className="ui-button ui-button--secondary ui-button--sm" action="console">打开本机助手查看</HelperLink>
            <IconButton label="关闭提示" size="sm" onClick={workspace.dismissCrash}><X size={14} /></IconButton>
          </div>}
          {statusView && <RoomStatusCard view={statusView} roomId={roomId} address={myXmtpAddress}
            accepted={workspace.invite.kind === "accepted"} binding={workspace.bindingGroup} canBind={Boolean(workspace.xmtpClient)}
            onUnlock={workspace.setUnlockedKey} onBind={() => void workspace.handleQuickBindGroup()} onReconnect={workspace.reconnect}
            onRetryInvite={workspace.invite.kind === "redeemFailed" && workspace.invite.retryable ? workspace.retryInvite : undefined}
            starters={workspace.starterChips} onStarter={onPrefill} />}
          {!isEncrypted && workspace.messagesQuery.isLoading && <p className="wb-status" role="status">加载消息…</p>}
          {!isEncrypted && workspace.messagesQuery.isError && <p className="wb-status wb-error" role="alert">加载失败，请刷新重试。</p>}
          {!isEncrypted && workspace.messagesQuery.isSuccess && !workspace.displayMessages.length && <p className="wb-status">对话已就绪</p>}
        </>} />}
      composer={workspace.isObserver ? <div className="wb-composer-notice">当前为只读观察者模式，仅可旁听工作过程。</div>
        : <div className="wb-composer-slot">
          {!workspace.canSendNow && <div className="wb-composer-notice">{isEncrypted ? "等待加密连接就绪…" : "正在连接房间…"}</div>}
          <div hidden={!workspace.canSendNow}>
            <Composer disabled={!workspace.canSendNow} candidates={workspace.candidates} onlineAgents={workspace.onlineAgentNames}
              encrypted={isEncrypted} onSend={workspace.handleSend} roomId={roomId} prefill={prefill}
              identityAddress={isEncrypted ? myXmtpAddress || null : user?.id}
              draftKeyMaterial={isEncrypted ? workspace.draftKeyMaterial : localStorage.getItem("mapr-auth-token")}
              replyTarget={workspace.replyTarget} onCancelReply={() => workspace.setReplyTarget(null)} />
          </div>
        </div>}
      inspector={<RoomInspector open={showInspector} tab={tab} pending={pending.length} onTab={openInspector} onClose={closeInspector}>
        {tab === "members" && <MembersTab requests={isOwner ? pending : []} requestActions={requests}
          seats={seats} seatActions={workspace.seatActions} permissions={permissions} currentUserId={user?.id}
          online={new Set(workspace.participants.map((participant) => participant.sender_id))} onInvite={() => openInspector("invite")} />}
        {tab === "invite" && <InviteTab permissions={permissions} />}
        {tab === "rules" && <RulesTab permissions={permissions} encryption={encryption} onLeave={() => navigate("/home")}
          onDelete={() => deleteRoom.mutate()} deleting={deleteRoom.isPending} error={deleteRoom.error?.message ?? ""} />}
        {tab === "activity" && room && <ActivityTab roomId={roomId} encrypted={isEncrypted}
          tasks={workspace.tasks.filter((task) => !task.room_id || task.room_id === roomId)} agents={workspace.onlineAgentNames} />}
      </RoomInspector>}
    />
  );
}
