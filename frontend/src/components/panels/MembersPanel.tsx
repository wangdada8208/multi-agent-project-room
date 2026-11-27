import { useSeatActions } from "../../hooks/room/useSeatActions";
import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  Bot,
  Cpu,
  Globe,
  Pause,
  Play,
  Plus,
  Trash2,
  User,
  Webhook,
} from "lucide-react";
import type { PresenceParticipant } from "../../types/chat";
import {
  TRUST_TIER_LABEL,
  trustTierOf,
  type HubSeatView,
  type TrustTier,
} from "../../lib/localHelper";
import type { XmtpClientLike } from "../../lib/seatGroupSync";
import { useAuthStore } from "../../stores/authStore";

const TIER_TITLE: Record<TrustTier, string> = {
  "local-cli": "在成员本机终端运行，聊天内容不出本机",
  "cloud-api": "回话时会将上下文发送至对应云端或兼容模型接口",
  "custom-webhook": "回话时会将消息转发至主人配置的自定义接口",
};

const GROUP_STATUS_TEXT: Record<HubSeatView["group_status"], string> = {
  added: "已入群",
  pending: "待入群",
  removed: "已移除",
};

function SeatKindIcon({ tier }: { tier: TrustTier }) {
  if (tier === "local-cli") return <Cpu size={15} strokeWidth={1.75} />;
  if (tier === "cloud-api") return <Globe size={15} strokeWidth={1.75} />;
  return <Webhook size={15} strokeWidth={1.75} />;
}

export interface MembersPanelProps {
  participants: PresenceParticipant[];
  seats?: HubSeatView[];
  roomId?: string;
  currentUserId?: string;
  isOwner?: boolean;
  xmtpClient?: XmtpClientLike | null;
  xmtpGroupId?: string | null;
  onSeatRemoved?: () => void;
}

export function MembersPanel({
  participants,
  seats,
  roomId,
  currentUserId,
  isOwner,
  xmtpClient,
  xmtpGroupId,
  onSeatRemoved,
}: MembersPanelProps) {
  const storeUserId = useAuthStore((s) => s.user?.id);
  const effectiveUserId = currentUserId ?? storeUserId;

  const { removingId, removeError, pausingId, pauseError, handleRemoveSeat, handleSetPaused } =
    useSeatActions(xmtpClient, xmtpGroupId, onSeatRemoved);

  const activeSeats = (seats ?? []).filter((s) => s.group_status !== "removed");
  const seatNames = new Set(activeSeats.map((s) => s.agent_display_name));
  const legacyAgents = participants.filter(
    (p) => p.sender_type === "agent" && !seatNames.has(p.sender_name || p.sender_id),
  );
  const humans = participants.filter((p) => p.sender_type === "human");

  const agentsTargetUrl = roomId ? `/agents?room=${encodeURIComponent(roomId)}` : "/agents";

  return (
    <div className="panel-section" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* ── 已接入 Agent ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <p className="panel-heading" style={{ color: "#1d1d1f", fontSize: 13, fontWeight: 600 }}>
            已接入 Agent ({activeSeats.length + legacyAgents.length})
          </p>
        </div>

        {activeSeats.length === 0 && legacyAgents.length === 0 && (
          <div className="panel-card" style={{ fontSize: 13, color: "#6e6e73", lineHeight: 1.5 }}>
            房间里还没有 Agent。可以接入 Claude Code、Codex、Grok、Muse。
          </div>
        )}

        {activeSeats.map((s) => {
          const tier = s.trust_tier ?? trustTierOf(s.kind);
          const isCollaboratorSeat = Boolean(
            effectiveUserId && s.owner_user_id && s.owner_user_id !== effectiveUserId,
          );
          const canRemove = Boolean(
            isOwner || (effectiveUserId && s.owner_user_id === effectiveUserId),
          );
          const isPaused = Boolean(s.paused_at);
          const isInviteSeat = s.source === "invite";
          return (
            <div
              key={s.seat_id}
              className="member-row member-row--card"
              style={isPaused ? { opacity: 0.65 } : undefined}
            >
              <span className="agent-row__icon" style={{ width: 28, height: 28, borderRadius: 8 }}>
                <SeatKindIcon tier={tier} />
              </span>
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <strong
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "#1d1d1f",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {s.agent_display_name}
                  </strong>
                  <span
                    className={`trust-badge trust-badge--${tier} tier-badge tier-badge--${tier}`}
                    title={TIER_TITLE[tier]}
                    style={{ marginLeft: 0 }}
                  >
                    {TRUST_TIER_LABEL[tier]}
                  </span>
                  {isInviteSeat && (
                    <span
                      className="trust-badge"
                      title="通过邀请链接入房的云端 Agent，没有本机助手进程"
                      style={{ marginLeft: 0, border: "1px solid rgba(0,0,0,0.12)" }}
                    >
                      云端
                    </span>
                  )}
                  {isPaused && (
                    <span
                      className="trust-badge"
                      title="已暂停：进程已停止，记录保留，随时可恢复"
                      style={{ marginLeft: 0, border: "1px solid rgba(0,0,0,0.12)" }}
                    >
                      已暂停
                    </span>
                  )}
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    flexWrap: "wrap",
                    fontSize: 11,
                    color: "#6e6e73",
                  }}
                >
                  <span
                    style={{
                      color: s.group_status === "added" ? "#1d7a3c" : "#6e6e73",
                      fontWeight: 500,
                    }}
                  >
                    {GROUP_STATUS_TEXT[s.group_status]}
                  </span>
                  <span>·</span>
                  <span style={{ fontFamily: "var(--mono)" }}>
                    {s.xmtp_address.slice(0, 6)}…{s.xmtp_address.slice(-4)}
                  </span>
                  {isCollaboratorSeat && (
                    <span className="collaborator-seat-badge">· 协作者</span>
                  )}
                </div>
              </div>
              {canRemove && (
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={pausingId === s.seat_id || removingId === s.seat_id}
                    onClick={() => void handleSetPaused(s, !isPaused)}
                    title={isPaused ? "恢复（本机助手下次心跳生效）" : "暂停（只停进程，不删记录）"}
                    style={{ width: 28, height: 28 }}
                  >
                    {isPaused ? (
                      <Play size={14} strokeWidth={1.75} />
                    ) : (
                      <Pause size={14} strokeWidth={1.75} />
                    )}
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={removingId === s.seat_id || pausingId === s.seat_id}
                    onClick={() => void handleRemoveSeat(s)}
                    title="移出房间（先退出加密群，再删除记录）"
                    style={{ width: 28, height: 28 }}
                  >
                    <Trash2 size={14} strokeWidth={1.75} />
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {legacyAgents.map((p) => (
          <div key={p.sender_id} className="member-row member-row--card">
            <Bot size={15} strokeWidth={1.75} style={{ color: "#1d1d1f", flexShrink: 0 }} />
            <span style={{ fontSize: 13, fontWeight: 500, color: "#1d1d1f" }}>
              {p.sender_name || p.sender_id}
            </span>
          </div>
        ))}

        {removeError && <p className="panel-error">{removeError}</p>}
        {pauseError && <p className="panel-error">{pauseError}</p>}

        <Link to={agentsTargetUrl} className="btn btn-ghost btn-sm" style={{ marginTop: 4 }}>
          <Plus size={14} strokeWidth={2} />
          <span>一键接入更多 Agent</span>
          <ArrowUpRight size={13} strokeWidth={2} />
        </Link>
      </div>

      {/* ── 在线成员 ── */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          paddingTop: 12,
          borderTop: "1px solid rgba(0, 0, 0, 0.08)",
        }}
      >
        <p className="panel-heading" style={{ color: "#1d1d1f", fontSize: 13, fontWeight: 600 }}>
          在线成员 {humans.length > 0 ? `(${humans.length})` : ""}
        </p>
        {humans.length === 0 ? (
          <p className="panel-hint" style={{ fontSize: 12, color: "#6e6e73", lineHeight: 1.5 }}>
            当前暂无在线成员。如需邀请成员进入加密群，请前往「权限」面板生成入群邀请链接。
          </p>
        ) : (
          humans.map((p) => (
            <div key={p.sender_id} className="member-row member-row--card">
              <User size={14} strokeWidth={1.75} style={{ color: "#6e6e73", flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: "#1d1d1f", flex: 1, minWidth: 0 }}>
                {p.sender_name || p.sender_id.slice(0, 8)}
              </span>
              <span className="member-dot" />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
