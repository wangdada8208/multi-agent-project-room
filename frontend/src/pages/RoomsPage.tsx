import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoom, fetchRooms } from "../lib/api";
import { useAuthStore } from "../stores/authStore";
import type { Room } from "../types/chat";

export function RoomsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [roomName, setRoomName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const roomsQuery = useQuery({
    queryKey: ["rooms"],
    queryFn: fetchRooms,
    refetchInterval: 10000,
  });

  const rooms: Room[] = roomsQuery.data ?? [];

  async function handleCreate() {
    if (!roomName.trim()) return;
    setCreating(true);
    setError("");
    try {
      const room = await createRoom(roomName.trim());
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
        <button
          type="button"
          className="btn-primary"
          style={{ width: "auto", padding: "8px 20px" }}
          onClick={() => setShowCreate(!showCreate)}
        >
          + 新建房间
        </button>
      </div>

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
