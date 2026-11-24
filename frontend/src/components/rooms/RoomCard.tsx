import { KeyRound, Lock, Trash2 } from "lucide-react";
import type { HubActivityFeed } from "../../lib/activityApi";
import type { HubSeatView } from "../../lib/localHelper";
import { trustTierOf } from "../../lib/localHelper";
import { roomTemplateKey } from "../../lib/roomTemplate";
import type { Room } from "../../types/chat";
import type { AvatarProps } from "../ui/Avatar";
import { AvatarStack } from "../ui/AvatarStack";
import { ConfirmInline } from "../ui/ConfirmInline";
import { Tag } from "../ui/Tag";
import { formatRelativeTime, templateDisplayName, TemplateIcon } from "./templateMeta";

export interface RoomCardProps {
  room: Room;
  currentUserId?: string | null;
  currentUserName: string;
  pendingCount: number;
  seats?: readonly HubSeatView[];
  activity?: HubActivityFeed | null;
  confirmingDelete: boolean;
  deleting: boolean;
  onEnter: () => void;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}

function safeActivitySummary(room: Room, activity?: HubActivityFeed | null): { text: string; at: string } {
  const latest = activity?.items?.[0];
  if (latest) {
    const actor = latest.actor_id || (latest.actor_kind === "agent" ? "Agent" : "成员");
    if (latest.title) {
      return { text: `${actor} · ${latest.title}`, at: latest.created_at ?? room.created_at };
    }
    if (latest.source === "approval") {
      return { text: `${actor} 发起了一项动作审批，等你确认。`, at: latest.created_at ?? room.created_at };
    }
    if (latest.source === "task_event") {
      return { text: `${actor} 更新了协作任务状态。`, at: latest.created_at ?? room.created_at };
    }
    if (latest.kind) {
      return { text: `${actor} 记录了协作动态（${latest.kind}）。`, at: latest.created_at ?? room.created_at };
    }
  }
  if (room.transport === "xmtp" && !room.xmtp_group_id) {
    return {
      text: "还没有消息。进入房间时，你的浏览器会自动创建加密群，然后就可以接入 Agent 了。",
      at: room.created_at,
    };
  }
  if (room.description?.trim()) {
    return { text: room.description.trim(), at: room.created_at };
  }
  return { text: "加密对话已就绪 · 点击进入协作。", at: room.created_at };
}

export function RoomCard({
  room,
  currentUserId,
  currentUserName,
  pendingCount,
  seats = [],
  activity,
  confirmingDelete,
  deleting,
  onEnter,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: RoomCardProps) {
  const isOwner = Boolean(currentUserId && room.created_by === currentUserId);
  const templateKey = roomTemplateKey(room);
  const isEncrypted = (room.transport ?? "xmtp") === "xmtp";
  const isGroupReady = Boolean(room.xmtp_group_id);
  const liveSeats = seats.filter((s) => s.group_status !== "removed");

  // 人类圆形头像在前，Agent 圆角方形头像在后（§5.3）
  const avatars: (AvatarProps & { id: string })[] = [
    { id: `me-${room.id}`, actor: "me", name: currentUserName, size: "sm" },
  ];
  const otherHumanIds = new Set<string>();
  for (const seat of liveSeats) {
    if (seat.owner_user_id && seat.owner_user_id !== currentUserId) {
      otherHumanIds.add(seat.owner_user_id);
    }
  }
  let humanIdx = 0;
  for (const uid of otherHumanIds) {
    humanIdx += 1;
    avatars.push({ id: `human-${uid}`, actor: "human", name: `协作者 ${humanIdx}`, size: "sm" });
  }
  for (const seat of liveSeats) {
    const tier = seat.trust_tier ?? trustTierOf(seat.kind);
    avatars.push({
      id: `seat-${seat.seat_id}`,
      actor: seat.source === "invite" || tier === "cloud-api" ? "cloud" : "local",
      name: seat.agent_display_name,
      size: "sm",
    });
  }

  const humanCount = 1 + otherHumanIds.size;
  const agentCount = liveSeats.length;
  const summary = safeActivitySummary(room, activity);

  return (
    <article
      className="wb-room-card"
      role="button"
      tabIndex={0}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("button, a, input")) return;
        onEnter();
      }}
      onKeyDown={(event) => {
        if (event.currentTarget === event.target && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onEnter();
        }
      }}
    >
      <div className="wb-room-card__top">
        <div className="wb-room-card__title-wrap">
          <h3 className="wb-room-card__title">{room.name}</h3>
          <div className="wb-room-card__sub">
            <TemplateIcon templateKey={templateKey} size={13} />
            <span>{templateDisplayName(templateKey)}</span>
            <span>·</span>
            <span>{isOwner ? "你是房主" : "协作者"}</span>
          </div>
        </div>
        <div className="wb-room-card__badges">
          {pendingCount > 0 ? (
            <Tag tone="warn">
              <span className="wb-room-card__pending-dot" aria-hidden="true" />
              {pendingCount} 待批准
            </Tag>
          ) : isEncrypted && !isGroupReady ? (
            <Tag tone="neutral">
              <KeyRound size={11} strokeWidth={2} className="wb-room-card__tag-icon" aria-hidden="true" />
              进入后启用加密
            </Tag>
          ) : null}
          {isOwner && (
            <button
              type="button"
              className="wb-room-card__delete"
              title="删除房间"
              aria-label={`删除房间 ${room.name}`}
              disabled={deleting}
              onClick={(event) => {
                event.stopPropagation();
                onRequestDelete();
              }}
            >
              <Trash2 size={14} strokeWidth={1.8} />
            </button>
          )}
        </div>
      </div>

      {confirmingDelete && (
        <div className="wb-room-card__confirm" onClick={(event) => event.stopPropagation()}>
          <ConfirmInline
            confirmLabel="删除房间"
            loading={deleting}
            onCancel={onCancelDelete}
            onConfirm={onConfirmDelete}
          >
            删除「{room.name}」后将停用该房间的入口。
          </ConfirmInline>
        </div>
      )}

      <p className="wb-room-card__last">{summary.text}</p>

      <div className="wb-room-card__foot">
        <AvatarStack avatars={avatars} max={5} />
        <span className="wb-room-card__counts">
          <span>{humanCount} 人</span>
          <span>{agentCount} Agent</span>
        </span>
        <span className="wb-room-card__spacer" />
        <span className="wb-room-card__time">{formatRelativeTime(summary.at)}</span>
        {isGroupReady && (
          <Lock
            size={13}
            strokeWidth={2}
            className="wb-room-card__lock"
            aria-label="端到端加密已保护"
          />
        )}
      </div>
    </article>
  );
}
