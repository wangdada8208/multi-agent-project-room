import { NavLink, Outlet } from "react-router-dom";

export function AppLayout() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Project Room</p>
          <h1>Multi-Agent</h1>
        </div>

        <nav>
          <NavLink to="/rooms/demo-room">Demo Room</NavLink>
          <NavLink to="/login">Login Mock</NavLink>
        </nav>
      </aside>

      <main className="main-panel">
        <Outlet />
      </main>
    </div>
  );
}
