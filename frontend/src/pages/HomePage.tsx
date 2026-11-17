import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { fetchRooms } from "../lib/api";
import { useAuthStore } from "../stores/authStore";
import { useAnalytics } from "../hooks/useAnalytics";
import type { Room } from "../types/chat";

export function HomePage() {
  const navigate = useNavigate();
  const { track } = useAnalytics();
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const [joinId, setJoinId] = useState("");

  const roomsQuery = useQuery({
    queryKey: ["rooms"],
    queryFn: fetchRooms,
    refetchInterval: 15000,
  });
  const rooms: Room[] = roomsQuery.data ?? [];

  function handleJoin() {
    const trimmed = joinId.trim();
    if (!trimmed) return;
    const matched = rooms.find(
      (r) => r.id === trimmed || r.name.toLowerCase() === trimmed.toLowerCase()
    );
    navigate(`/rooms/${matched ? matched.id : trimmed}`);
  }

  return (
    <div>
      <header className="topbar">
        <span className="topbar__brand">🤖 协作空间</span>
        <span className="topbar__spacer" />
        <Link to="/agents" className="btn btn-ghost btn-sm">🤖 我的 Agent</Link>
        {user?.display_name && <span className="topbar__user">{user.display_name}</span>}
        <button type="button" className="btn btn-ghost btn-sm" onClick={logout}>退出</button>
      </header>

      <div className="home">
        <div className="home-hero">
          <h1>让你的 AI Agent 和别人协作</h1>
          <p>选一个场景，剩下的配置由向导自动完成。</p>
          <button
            type="button"
            className="btn btn-primary btn-lg"
            onClick={() => { track("quick_start_click"); navigate("/setup"); }}
          >
            ⚡ 一键开始
          </button>
        </div>

        <div className="home-section-title">我的房间</div>

        {roomsQuery.isError && (
          <div className="page-error card">
            <p>加载房间失败，请刷新重试。</p>
            <button type="button" className="btn btn-ghost" style={{ marginTop: 12 }} onClick={() => roomsQuery.refetch()}>
              重试
            </button>
          </div>
        )}
        {roomsQuery.isLoading && (
          <div className="loading-center"><span className="spinner" />加载中...</div>
        )}
        {!roomsQuery.isLoading && !roomsQuery.isError && rooms.length === 0 && (
          <div className="home-empty">
            <p>还没有房间</p>
            <p className="hint" style={{ marginTop: 4 }}>点上方「一键开始」，三步建好并接入你的 Agent。</p>
          </div>
        )}

        {rooms.length > 0 && (
          <div className="rooms-grid">
            {rooms.map((room) => (
              <button
                key={room.id}
                type="button"
                className="room-card"
                onClick={() => navigate(`/rooms/${room.id}`)}
              >
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
        )}

        <div className="home-section-title">加入别人的房间</div>
        <div className="join-row">
          <input
            className="input"
            value={joinId}
            onChange={(e) => setJoinId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleJoin()}
            placeholder="输入房间 ID 或名称..."
          />
          <button
            type="button"
            className="btn btn-ghost"
            onClick={handleJoin}
            disabled={!joinId.trim()}
          >
            进入
          </button>
        </div>
      </div>
    </div>
  );
}
