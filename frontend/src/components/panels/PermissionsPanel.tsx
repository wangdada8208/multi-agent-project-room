import { useState, useEffect, useCallback } from "react";
import { KeyRound, Link2, Shield, UserPlus, X } from "lucide-react";
import { apiFetch } from "../../lib/api";
import { createRoomInvite } from "../../lib/localHelper";
import { addAddressToXmtpGroup, type XmtpClientLike } from "../../lib/seatGroupSync";
import { CopyButton } from "../CopyButton";
import { useAuthStore } from "../../stores/authStore";

interface RoomMember {
  user_id: string;
  role: "owner" | "member" | "viewer";
  username: string;
  display_name: string;
  avatar_url: string | null;
  user_type: string;
}

const ROLE_LABELS: Record<string, string> = {
  owner: "管理员",
  member: "成员",
  viewer: "观察者",
};

export interface PermissionsPanelProps {
  roomId: string;
  isEncrypted?: boolean;
  isOwner?: boolean;
  xmtpClient?: XmtpClientLike | null;
  xmtpGroupId?: string | null;
  onPermissionsChanged?: () => void;
}

export function PermissionsPanel({
  roomId,
  isEncrypted = true,
  isOwner,
  xmtpClient,
  xmtpGroupId,
  onPermissionsChanged,
}: PermissionsPanelProps) {
  const currentUser = useAuthStore((s) => s.user);
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [inviteUsername, setInviteUsername] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "viewer">("member");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  // 加密群邀请链接状态
  const [inviteLink, setInviteLink] = useState("");
  const [creatingLink, setCreatingLink] = useState(false);
  const [linkError, setLinkError] = useState("");

  // 按 0x 地址直接拉人状态
  const [directAddress, setDirectAddress] = useState("");
  const [addingDirect, setAddingDirect] = useState(false);
  const [directFeedback, setDirectFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const fetchPermissions = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/v1/rooms/${roomId}/permissions`);
      if (res.ok) {
        const data = await res.json();
        setMembers(data.members ?? []);
        setError("");
      } else if (res.status === 403) {
        setError("无权限查看成员列表");
      }
    } catch {
      setError("加载失败");
    } finally {
      setLoading(false);
    }
  }, [roomId]);

  useEffect(() => {
    void fetchPermissions();
  }, [fetchPermissions]);

  const effectiveIsOwner =
    isOwner ?? members.some((m) => m.user_id === currentUser?.id && m.role === "owner");

  async function handleInvite() {
    if (!inviteUsername.trim()) return;
    const targetName = inviteUsername.trim();
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const res = await apiFetch(`/api/v1/rooms/${roomId}/invite`, {
        method: "POST",
        body: JSON.stringify({ username: targetName, role: inviteRole }),
      });
      if (res.ok) {
        setMessage(`已添加 ${targetName} 为${ROLE_LABELS[inviteRole]}`);
        setInviteUsername("");
        void fetchPermissions();
        onPermissionsChanged?.();
      } else {
        const data = await res.json().catch(() => ({ detail: "邀请失败" }));
        setError(data.detail ?? "邀请失败");
      }
    } catch {
      setError("网络错误");
    } finally {
      setLoading(false);
    }
  }

  async function handleRoleChange(userId: string, newRole: string) {
    try {
      const res = await apiFetch(`/api/v1/rooms/${roomId}/role`, {
        method: "PUT",
        body: JSON.stringify({ user_id: userId, role: newRole }),
      });
      if (res.ok) {
        void fetchPermissions();
        onPermissionsChanged?.();
      }
    } catch {
      /* 静默 */
    }
  }

  async function handleRemove(userId: string) {
    try {
      const res = await apiFetch(`/api/v1/rooms/${roomId}/members/${userId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        void fetchPermissions();
        onPermissionsChanged?.();
      }
    } catch {
      /* 静默 */
    }
  }

  async function handleGenerateInviteLink() {
    setCreatingLink(true);
    setLinkError("");
    try {
      const invite = await createRoomInvite(roomId, 72);
      setInviteLink(`${window.location.origin}/rooms/${roomId}?invite=${encodeURIComponent(invite.token)}`);
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : "生成邀请链接失败");
    } finally {
      setCreatingLink(false);
    }
  }

  async function handleDirectAdd() {
    if (!xmtpClient || !xmtpGroupId) {
      setDirectFeedback({ kind: "err", text: "请先在左侧聊天区解锁加密身份并完成建群后再拉人" });
      return;
    }
    setAddingDirect(true);
    setDirectFeedback(null);
    try {
      const result = await addAddressToXmtpGroup(xmtpClient, xmtpGroupId, directAddress);
      if (result === "already-member") {
        setDirectFeedback({ kind: "ok", text: "该加密地址已在当前加密群中" });
      } else {
        setDirectFeedback({ kind: "ok", text: "已成功将该协作者拉入加密群" });
        setDirectAddress("");
      }
    } catch (err) {
      setDirectFeedback({
        kind: "err",
        text: err instanceof Error ? err.message : "拉入加密群失败，请稍后重试",
      });
    } finally {
      setAddingDirect(false);
    }
  }

  return (
    <div className="panel-section" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* ── 一键加密入群邀请链接（加密房间房主首选） ── */}
      {isEncrypted && effectiveIsOwner && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            padding: "12px",
            borderRadius: 12,
            background: "#f5f5f7",
            border: "1px solid rgba(0, 0, 0, 0.08)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Shield size={14} strokeWidth={1.9} style={{ color: "#0071e3" }} />
            <strong style={{ fontSize: 13, color: "#1d1d1f" }}>邀请真人协作者进入加密群</strong>
          </div>
          <p style={{ fontSize: 12, color: "#6e6e73", lineHeight: 1.5 }}>
            生成一次性加密入群链接发给协作者，对方登录并打开链接后将自动获得房间成员权限并加入加密群
          </p>

          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void handleGenerateInviteLink()}
            disabled={creatingLink}
            style={{ width: "100%", justifyContent: "center" }}
          >
            <Link2 size={14} strokeWidth={2} />
            <span>{creatingLink ? "正在生成…" : "一键生成加密入群邀请链接"}</span>
          </button>

          {linkError && <p className="panel-error">{linkError}</p>}

          {inviteLink && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                padding: "9px 10px",
                borderRadius: 9,
                background: "#ffffff",
                border: "1px solid rgba(0, 0, 0, 0.08)",
              }}
            >
              <code
                style={{
                  fontSize: 11.5,
                  color: "#1d1d1f",
                  wordBreak: "break-all",
                  lineHeight: 1.45,
                }}
              >
                {inviteLink}
              </code>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <CopyButton text={inviteLink} label="复制邀请链接" />
              </div>
            </div>
          )}

          <div
            style={{
              paddingTop: 10,
              borderTop: "1px solid rgba(0, 0, 0, 0.08)",
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <label
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "#1d1d1f",
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
              }}
            >
              <KeyRound size={13} strokeWidth={1.8} style={{ color: "#6e6e73" }} />
              <span>按加密地址直接拉人入群</span>
            </label>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                className="input"
                value={directAddress}
                onChange={(e) => setDirectAddress(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && directAddress.trim() && void handleDirectAdd()}
                placeholder="0x 开头的 42 位加密地址"
                style={{ fontSize: 12.5, fontFamily: "var(--mono)" }}
              />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={addingDirect || !directAddress.trim() || !xmtpClient || !xmtpGroupId}
                onClick={() => void handleDirectAdd()}
              >
                {addingDirect ? "拉群中…" : "拉入加密群"}
              </button>
            </div>
            {!xmtpClient && (
              <span style={{ fontSize: 11.5, color: "#6e6e73" }}>
                请先在聊天区解锁你的本机加密身份以启用直接拉群。
              </span>
            )}
            {directFeedback && (
              <p className={directFeedback.kind === "ok" ? "ok-text" : "panel-error"} style={{ fontSize: 12 }}>
                {directFeedback.text}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── 按用户名管理房间角色 ── */}
      <div className="field">
        <label style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "#1d1d1f" }}>
          <UserPlus size={14} strokeWidth={1.8} />
          <span>按用户名添加房间成员权限</span>
        </label>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            className="input"
            value={inviteUsername}
            onChange={(e) => setInviteUsername(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void handleInvite()}
            placeholder="输入对方用户名…"
          />
          <select
            className="role-select"
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as typeof inviteRole)}
          >
            <option value="member">成员</option>
            <option value="viewer">观察者</option>
          </select>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void handleInvite()}
            disabled={!inviteUsername.trim() || loading}
          >
            添加
          </button>
        </div>
      </div>

      {error && <p className="panel-error">{error}</p>}
      {message && <p className="ok-text">{message}</p>}

      {loading && members.length === 0 && <p className="panel-empty">加载中…</p>}
      {!loading && members.length === 0 && !error && <p className="panel-empty">暂无成员</p>}

      <div>
        {members.map((m) => (
          <div key={m.user_id} className="permission-row">
            <span
              className={`msg__avatar ${m.user_type === "agent" ? "msg__avatar--agent" : ""}`}
              style={{ width: 28, height: 28, fontSize: 12 }}
            >
              {(m.display_name || m.username).charAt(0).toUpperCase()}
            </span>
            <div className="permission-row__info">
              <strong>{m.display_name || m.username}</strong>
              <small>@{m.username}</small>
            </div>
            <select
              value={m.role}
              onChange={(e) => void handleRoleChange(m.user_id, e.target.value)}
              className="role-select"
              disabled={!effectiveIsOwner}
            >
              <option value="owner">{ROLE_LABELS.owner}</option>
              <option value="member">{ROLE_LABELS.member}</option>
              <option value="viewer">{ROLE_LABELS.viewer}</option>
            </select>
            {effectiveIsOwner && m.role !== "owner" && (
              <button
                type="button"
                className="icon-btn"
                style={{ width: 26, height: 26 }}
                onClick={() => void handleRemove(m.user_id)}
                title="移除成员"
              >
                <X size={14} strokeWidth={1.9} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
