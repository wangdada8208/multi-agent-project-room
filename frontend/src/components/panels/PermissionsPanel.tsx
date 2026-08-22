import { useState, useEffect } from "react";

interface RoomMember {
  user_id: string;
  role: "owner" | "member" | "viewer";
  username: string;
  display_name: string;
  avatar_url: string | null;
  user_type: string;
}

interface PermissionsPanelProps {
  roomId: string;
}

export function PermissionsPanel({ roomId }: PermissionsPanelProps) {
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [inviteUsername, setInviteUsername] = useState("");
  const [inviteRole, setInviteRole] = useState<"owner" | "member" | "viewer">("member");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function fetchPermissions() {
    try {
      const token = localStorage.getItem("mapr-auth-token") ?? "";
      const res = await fetch(`/api/v1/rooms/${roomId}/permissions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setMembers(data.members ?? []);
      } else if (res.status === 403) {
        setError("无权限查看成员列表");
      }
    } catch {
      setError("加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchPermissions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  async function handleInvite() {
    if (!inviteUsername.trim()) return;
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const token = localStorage.getItem("mapr-auth-token") ?? "";
      const res = await fetch(`/api/v1/rooms/${roomId}/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ username: inviteUsername.trim(), role: inviteRole }),
      });
      if (res.ok) {
        setMessage(`✅ 已邀请 ${inviteUsername} 为 ${inviteRole}`);
        setInviteUsername("");
        fetchPermissions();
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
      const token = localStorage.getItem("mapr-auth-token") ?? "";
      const res = await fetch(`/api/v1/rooms/${roomId}/role`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ user_id: userId, role: newRole }),
      });
      if (res.ok) fetchPermissions();
    } catch { /* silent */ }
  }

  async function handleRemove(userId: string) {
    try {
      const token = localStorage.getItem("mapr-auth-token") ?? "";
      const res = await fetch(`/api/v1/rooms/${roomId}/members/${userId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) fetchPermissions();
    } catch { /* silent */ }
  }

  const ROLE_LABELS: Record<string, string> = { owner: "👑 管理员", member: "👤 成员", viewer: "👁 观察者" };

  return (
    <div className="panel-section">
      <div className="panel-field">
        <label>邀请成员</label>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            value={inviteUsername}
            onChange={(e) => setInviteUsername(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleInvite()}
            placeholder="输入用户名..."
          />
          <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as typeof inviteRole)} style={{ width: "auto", padding: "6px 8px" }}>
            <option value="member">成员</option>
            <option value="viewer">观察者</option>
          </select>
          <button type="button" className="btn-primary" style={{ width: "auto", padding: "6px 12px" }} onClick={handleInvite} disabled={!inviteUsername.trim() || loading}>
            邀请
          </button>
        </div>
      </div>

      {error && <p className="panel-error">{error}</p>}
      {message && <p className="panel-hint" style={{ color: "var(--green)" }}>{message}</p>}

      {!loading && members.length > 0 && (
        <div className="permissions-list">
          {members.map((m) => (
            <div key={m.user_id} className="permission-row">
              <span className={`msg-avatar msg-avatar--${m.user_type === "agent" ? "agent" : ""}`} style={{ width: 28, height: 28, fontSize: 12 }}>
                {(m.display_name || m.username).charAt(0).toUpperCase()}
              </span>
              <div className="permission-row__info">
                <strong>{m.display_name || m.username}</strong>
                <small>@{m.username}</small>
              </div>
              <select
                value={m.role}
                onChange={(e) => handleRoleChange(m.user_id, e.target.value)}
                className="permission-role-select"
              >
                <option value="owner">{ROLE_LABELS.owner}</option>
                <option value="member">{ROLE_LABELS.member}</option>
                <option value="viewer">{ROLE_LABELS.viewer}</option>
              </select>
              {m.role !== "owner" && (
                <button type="button" className="permission-remove" onClick={() => handleRemove(m.user_id)} title="移除">
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
