import { NavLink, Outlet } from "react-router-dom";
import { useEffect, useState } from "react";
import { useRoomStore } from "../../stores/roomStore";
import { useAuthStore } from "../../stores/authStore";

export function AppLayout() {
  const rooms = useRoomStore((state) => state.rooms);
  const activeRoomId = useRoomStore((state) => state.activeRoomId);
  const displayName = useAuthStore((state) => state.displayName);
  const logout = useAuthStore((state) => state.logout);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem("mapr-theme") === "dark");

  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? "dark" : "light";
    localStorage.setItem("mapr-theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <div className="brand">协作空间</div>
          <div className="brand-sub">Multi-Agent Project Room</div>

          <div className="nav-label">导航</div>
          <nav>
            <NavLink to="/rooms" end>📋 所有房间</NavLink>
            <NavLink to="/login">👤 登录</NavLink>
          </nav>

          {rooms.length > 0 && (
            <>
              <div className="nav-label" style={{ marginTop: 20 }}>房间列表</div>
              <nav>
                {rooms.map((room) => (
                  <NavLink
                    key={room.id}
                    to={`/rooms/${room.id}`}
                    className={activeRoomId === room.id ? "active" : ""}
                  >
                    🏠 {room.name}
                  </NavLink>
                ))}
              </nav>
            </>
          )}
        </div>

        <div className="sidebar-actions">
          <button className="mini-button" onClick={() => setDarkMode((value) => !value)}>
            {darkMode ? "浅色" : "深色"}
          </button>
          {isAuthenticated && (
            <button className="mini-button" onClick={logout}>
              退出
            </button>
          )}
          {displayName && <div className="user-info">👤 {displayName}</div>}
        </div>
      </aside>

      <main className="main-panel">
        <Outlet />
      </main>
    </div>
  );
}
