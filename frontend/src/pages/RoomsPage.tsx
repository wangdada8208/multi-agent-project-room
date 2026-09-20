import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoom, fetchRooms, fetchTemplates } from "../lib/api";
import { useAnalytics } from "../hooks/useAnalytics";
import { useAuthStore } from "../stores/authStore";
import type { Room } from "../types/chat";

export function RoomsPage() {
  const navigate = useNavigate();
  const { track } = useAnalytics();
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [roomName, setRoomName] = useState("");
  const [creating, setCreating] = useState(false);
  const [joinRoomId, setJoinRoomId] = useState("");
  const [showJoin, setShowJoin] = useState(false);
  const [error, setError] = useState("");
  const [templates, setTemplates] = useState<Array<{key:string,name:string,description:string|null,icon:string}>>([]);
  const [showTemplates, setShowTemplates] = useState(false);

  const roomsQuery = useQuery({
    queryKey: ["rooms"],
    queryFn: fetchRooms,
    refetchInterval: 10000,
  });

  const rooms: Room[] = roomsQuery.data ?? [];

  useState(() => {
    fetchTemplates().then(setTemplates).catch(() => {});
    return null;
  });

  async function handleCreate() {
    if (!roomName.trim()) return;
    setCreating(true);
    setError("");
    try {
      const room = await createRoom(roomName.trim());
      track("room_create", room.id);
      await queryClient.invalidateQueries({ queryKey: ["rooms"] });
      navigate(`/rooms/${room.id}`);
    } catch {
      setError("创建失败，请重试。");
    } finally {
      setCreating(false);
    }
  }

  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const displayName = user?.display_name ?? "";

  return (
    <div className="rooms-page">
      <header className="rooms-topbar">
        <span className="brand-mini">🤖 协作空间</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {displayName && <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{displayName}</span>}
          {user && (
            <button type="button" onClick={logout} className="btn-ghost" style={{ padding: '4px 10px' }}>
              退出
            </button>
          )}
        </div>
      </header>
      <div className="rooms-header">
        <h1>房间列表</h1>
        <div style={{ display: "flex", gap: 8 }}>
          {templates.length > 0 && (
            <button type="button" className="btn-ghost" style={{ padding: "8px 16px" }} onClick={() => setShowTemplates(!showTemplates)}>
              📋 模板
            </button>
          )}
          <button type="button" className="btn-ghost" style={{ padding: "8px 16px" }} onClick={() => setShowJoin(!showJoin)}>
            🔑 加入房间
          </button>
          <button type="button" className="btn-primary" style={{ width: "auto", padding: "8px 20px" }} onClick={() => setShowCreate(!showCreate)}>
            + 新建房间
          </button>
        </div>
      </div>

      
      {showJoin && (
        <div className="create-room-card">
          <input
            value={joinRoomId}
            onChange={(e) => setJoinRoomId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && joinRoomId.trim()) {
                navigate(`/rooms/${joinRoomId.trim()}`);
              }
            }}
            placeholder="输入或粘贴房间 ID..."
            autoFocus
          />
          <button
            type="button"
            className="btn-primary"
            style={{ width: "auto", padding: "8px 16px" }}
            onClick={() => {
              if (joinRoomId.trim()) {
                navigate(`/rooms/${joinRoomId.trim()}`);
              }
            }}
            disabled={!joinRoomId.trim()}
          >
            进入
          </button>
        </div>
      )}

      {showCreate && (
        <div className="create-room-card">
          <input
            value={roomName}
            onChange={(e) => setRoomName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            placeholder="输入房间名称..."
            autoFocus
          />
          <button type="button" className="btn-primary" style={{ width: "auto", padding: "8px 16px" }} onClick={handleCreate} disabled={creating || !roomName.trim()}>
            {creating ? "创建中..." : "创建"}
          </button>
        </div>
      )}

      {showTemplates && templates.length > 0 && (
        <div className="create-room-card" style={{ flexDirection: "column", alignItems: "stretch" }}>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 8 }}>从模板创建：</p>
          <div className="onboarding-template-grid">
            {templates.map((t) => (
              <button key={t.key} type="button"
                className="room-card"
                onClick={async () => {
                  try {
                    const token = localStorage.getItem("mapr-auth-token") ?? "";
                    const res = await fetch("/api/v1/templates/create-room", {
                      method: "POST",
                      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                      body: JSON.stringify({ template_key: t.key, name: `${t.name} - ${new Date().toLocaleDateString("zh-CN")}` }),
                    });
                    const data = await res.json();
                    if (data.room) {
                      await queryClient.invalidateQueries({ queryKey: ["rooms"] });
                      navigate(`/rooms/${data.room.id}`);
                    }
                  } catch { /* silent */ }
                }}>
                <span className="room-card__icon">{t.icon}</span>
                <div className="room-card__info">
                  <strong>{t.name}</strong>
                  <small>{t.description}</small>
                </div>
                <span className="room-card__arrow">→</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <p style={{ color: "var(--red)", fontSize: 13 }}>{error}</p>}

      {roomsQuery.isError && (
        <div className="chat-error">
          <p>加载房间失败，请刷新重试。</p>
          <button type="button" onClick={() => roomsQuery.refetch()}>重试</button>
        </div>
      )}
      {!roomsQuery.isError && roomsQuery.isLoading && <p className="panel-empty">加载中...</p>}
      {!roomsQuery.isLoading && !roomsQuery.isError && rooms.length === 0 && (
        <div className="chat-empty">
          <p>还没有房间</p>
          <small>点击「+ 新建房间」开始协作。</small>
        </div>
      )}

      <div className="rooms-grid">
        {rooms.map((room) => (
          <button key={room.id} type="button" className="room-card" onClick={() => navigate(`/rooms/${room.id}`)}>
            <span className="room-card__icon">🏠</span>
            <div className="room-card__info">
              <strong>{room.name}</strong>
              {room.description && <small>{room.description}</small>}
              <small>{new Date(room.created_at).toLocaleDateString("zh-CN")}</small>
            </div>
            <span className="room-card__arrow">→</span>
          </button>
        ))}
      </div>
    </div>
  );
}
