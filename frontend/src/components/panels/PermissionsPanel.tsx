import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../../lib/api";

interface RoomMember {
  user_id: string;
  role: "owner" | "member" | "viewer";
  username: string;
  display_name: string;
  avatar_url: string | null;
  user_type: string;
}

const ROLE_LABELS: Record<string, string> = {
  owner: "👑 管理员",
  member: "👤 成员",
  viewer: "👁 观察者",
};

export function PermissionsPanel({ roomId }: { roomId: string }) {
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [inviteUsername, setInviteUsername] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "viewer">("member");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

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

  async function handleInvite() {
    if (!inviteUsername.trim()) return;
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const res = await apiFetch(`/api/v1/rooms/${roomId}/invite`, {
        method: "POST",
        body: JSON.stringify({ username: inviteUsername.trim(), role: inviteRole }),
      });
      if (res.ok) {
        setMessage(`✅ 已邀请 ${inviteUsername} 为 ${ROLE_LABELS[inviteRole]}`);
        setInviteUsername("");
        void fetchPermissions();
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
      if (res.ok) void fetchPermissions();
    } catch { /* 静默 */ }
  }

  async function handleRemove(userId: string) {
    try {
      const res = await apiFetch(`/api/v1/rooms/${roomId}/members/${userId}`, {
        method: "DELETE",
      });
      if (res.ok) void fetchPermissions();
    } catch { /* 静默 */ }
  }

  return (
    <div className="panel-section">
      <div className="field">
        <label>邀请成员</label>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            className="input"
            value={inviteUsername}
            onChange={(e) => setInviteUsername(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleInvite()}
            placeholder="输入用户名..."
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
            onClick={handleInvite}
            disabled={!inviteUsername.trim() || loading}
          >
            邀请
          </button>
        </div>
      </div>

      {error && <p className="panel-error">{error}</p>}
      {message && <p className="ok-text">{message}</p>}

      {loading && members.length === 0 && <p className="panel-empty">加载中...</p>}
      {!loading && members.length === 0 && !error && <p className="panel-empty">暂无成员</p>}

      <div>
        {members.map((m) => (
          <div key={m.user_id} className="permission-row">
            <span className={`msg__avatar ${m.user_type === "agent" ? "msg__avatar--agent" : ""}`} style={{ width: 28, height: 28, fontSize: 12 }}>
              {(m.display_name || m.username).charAt(0).toUpperCase()}
            </span>
            <div className="permission-row__info">
              <strong>{m.display_name || m.username}</strong>
              <small>@{m.username}</small>
            </div>
            <select
              value={m.role}
              onChange={(e) => handleRoleChange(m.user_id, e.target.value)}
              className="role-select"
            >
              <option value="owner">{ROLE_LABELS.owner}</option>
              <option value="member">{ROLE_LABELS.member}</option>
              <option value="viewer">{ROLE_LABELS.viewer}</option>
            </select>
            {m.role !== "owner" && (
              <button type="button" className="icon-btn" style={{ width: 26, height: 26, fontSize: 13 }} onClick={() => handleRemove(m.user_id)} title="移除">
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
