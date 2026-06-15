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
          <p className="eyebrow" style={{ marginBottom: 2 }}>
            Project Room
          </p>
          <h1 style={{ fontSize: 22, marginBottom: 20 }}>
            Multi-Agent
          </h1>

          <p style={{ fontSize: 12, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>
            Navigation
          </p>
          <nav>
            <NavLink to="/rooms" end>
              📋 All Rooms
            </NavLink>
            <NavLink to="/login" end>
              👤 Profile
            </NavLink>
          </nav>

          {rooms.length > 0 && (
            <>
              <p
                style={{
                  fontSize: 12,
                  color: "#64748b",
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  marginTop: 24,
                  marginBottom: 8,
                }}
              >
                Rooms
              </p>
              <nav>
                {rooms.map((room) => (
                  <NavLink
                    key={room.id}
                    to={`/rooms/${room.id}`}
                    className={activeRoomId === room.id ? "active" : ""}
                    style={{ fontSize: 13 }}
                  >
                    🏠 {room.name}
                  </NavLink>
                ))}
              </nav>
            </>
          )}
        </div>

        <div style={{ fontSize: 12, color: "#64748b" }}>
          {displayName && (
            <span>
              👤 {displayName}
            </span>
          )}
        </div>
      </aside>

      <main className="main-panel">
        <Outlet />
      </main>
    </div>
  );
}
