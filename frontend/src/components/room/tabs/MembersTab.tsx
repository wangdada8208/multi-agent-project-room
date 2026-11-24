import { Cloud, Laptop, Pause, Play, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { HubSeatView } from "../../../lib/localHelper";
import type { PendingRequest } from "../../../lib/domain/pendingRequests";
import type { useSeatActions } from "../../../hooks/room/useSeatActions";
import { PermissionsPanel, type PermissionsPanelProps } from "../../panels/PermissionsPanel";
import { Avatar } from "../../ui/Avatar";
import { ConfirmInline } from "../../ui/ConfirmInline";
import { IconButton } from "../../ui/IconButton";
import { Tag } from "../../ui/Tag";
import { RequestActions, type PendingActions } from "../PendingRequestBanner";

type SeatActions = ReturnType<typeof useSeatActions>;
const isCloud = (seat: HubSeatView) => seat.source === "invite" || seat.kind === "cloud-agent";

function SeatRow({ seat, actions, editable, source }: { seat: HubSeatView; actions: SeatActions; editable: boolean; source?: string }) {
  const [confirming, setConfirming] = useState(false);
  const paused = Boolean(seat.paused_at);
  const pending = seat.group_status === "pending";
  const busy = Boolean(actions.removingId || actions.pausingId);
  return <article className={`wb-seat${paused ? " wb-seat--paused" : ""}`}>
    <Avatar actor={isCloud(seat) ? "cloud" : "local"} name={seat.agent_display_name} size="sm" />
    <div className="wb-seat__info">
      <strong title={seat.agent_display_name}>{seat.agent_display_name}</strong>
      <small><i className={`wb-presence wb-presence--${paused ? "paused" : pending ? "pending" : "online"}`} />{paused ? "已暂停" : pending ? "待入群" : "已入群"}{source ? ` · ${source}` : ""}</small>
    </div>
    {editable && <div className="wb-seat__actions">
      <IconButton label={paused ? "恢复席位" : "暂停席位"} size="sm" disabled={busy}
        onClick={() => void actions.handleSetPaused(seat, !paused)}>{paused ? <Play size={14} /> : <Pause size={14} />}</IconButton>
      <IconButton label="移出席位" size="sm" disabled={busy} onClick={() => setConfirming(true)}><Trash2 size={14} /></IconButton>
    </div>}
    {confirming && <ConfirmInline confirmLabel="移出" loading={actions.removingId === seat.seat_id} onCancel={() => setConfirming(false)}
      onConfirm={() => void actions.handleRemoveSeat(seat)}>
      {pending ? "移除此待入群席位？" : `先把 ${seat.agent_display_name} 移出加密群，再删除席位。移出后无法读取新消息。`}
    </ConfirmInline>}
  </article>;
}

export function MembersTab({ requests, requestActions, seats, seatActions, permissions, currentUserId, online, onInvite }: {
  requests: readonly PendingRequest[];
  requestActions: PendingActions;
  seats: readonly HubSeatView[];
  seatActions: SeatActions;
  permissions: PermissionsPanelProps;
  currentUserId?: string;
  online: ReadonlySet<string>;
  onInvite: () => void;
}) {
  const members = permissions.permissionsQuery?.data?.members?.filter((member) => member.user_type !== "agent") ?? [];
  const activeSeats = seats.filter((seat) => seat.group_status !== "removed");
  return <div className="wb-tab-content">
    {requests.length > 0 && <section>
      <h3>待批准 <span className="workbench-count">{requests.length}</span></h3>
      {requests.map((request) => <article className="wb-seat wb-seat--pending" key={request.id}>
        <Avatar name={request.displayName} actor={request.kind === "agent" ? "cloud" : "human"} size="sm" />
        <div className="wb-seat__info"><strong>{request.displayName} {request.kind === "agent" && <Tag tone="cloud">云端</Tag>}</strong><small>通过你的邀请链接 · 等待批准</small></div>
        <RequestActions request={request} {...requestActions} />
      </article>)}
    </section>}
    <section>
      <h3>人类成员 <span>{members.length}</span></h3>
      {members.length === 0 && <p className="wb-muted">{permissions.permissionsQuery?.isPending ? "正在加载成员…" : "暂无成员信息"}</p>}
      {members.map((member) => {
        const me = member.user_id === currentUserId;
        const name = member.display_name || member.username || member.user_id;
        return <article className="wb-seat" key={member.user_id}>
          <Avatar actor={me ? "me" : "human"} name={name} src={member.avatar_url ?? undefined} size="sm" />
          <div className="wb-seat__info">
            <strong>{name} {member.role === "owner" && <Tag tone="owner">房主</Tag>} {me && <small>你</small>}</strong>
            <small>{(online.has(member.user_id) || me) && <i className="wb-presence wb-presence--online" />}
              {online.has(member.user_id) || me ? "在线" : "离线"}
              {member.role !== "owner" ? member.role === "viewer" ? " · 观察者" : " · 协作者" : ""}
            </small>
          </div>
        </article>;
      })}
    </section>
    {[{ label: "云端 Agent", Icon: Cloud, entries: activeSeats.filter(isCloud) }, { label: "电脑端 Agent", Icon: Laptop, entries: activeSeats.filter((seat) => !isCloud(seat)) }].map(({ label, Icon, entries }) => (
      <section key={label}>
        <h3><Icon size={13} />{label} <span>{entries.length}</span></h3>
        {entries.map((seat) => <SeatRow key={seat.seat_id} seat={seat} actions={seatActions}
          editable={Boolean(permissions.isOwner || seat.owner_user_id === currentUserId)}
          source={seat.owner_user_id === currentUserId ? "由你接入" : members.find((member) => member.user_id === seat.owner_user_id)?.display_name} />)}
        {entries.length === 0 && <p className="wb-muted">暂无席位</p>}
      </section>
    ))}
    {(seatActions.removeError || seatActions.pauseError) && <p className="wb-error" role="alert">{seatActions.removeError || seatActions.pauseError}</p>}
    <button type="button" className="wb-add" onClick={onInvite}><Plus size={16} />邀请成员或接入 Agent</button>
    <details><summary>成员权限与加密身份</summary><PermissionsPanel {...permissions} section="members" /></details>
  </div>;
}
