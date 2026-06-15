import { NavLink, Outlet } from "react-router-dom";
import { useRoomStore } from "../../stores/roomStore";
import { useAuthStore } from "../../stores/authStore";

export function AppLayout() {
  const rooms = useRoomStore((state) => state.rooms);
  const activeRoomId = useRoomStore((state) => state.activeRoomId);
  const displayName = useAuthStore((state) => state.displayName);

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

        {displayName && (
          <div className="user-info">👤 {displayName}</div>
        )}
      </aside>

      <main className="main-panel">
        <Outlet />
      </main>
    </div>
  );
}
