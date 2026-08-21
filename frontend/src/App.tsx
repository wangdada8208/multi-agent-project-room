import { Navigate, Route, Routes } from "react-router-dom";
import { LoginPage } from "./pages/LoginPage";
import { RoomPage } from "./pages/RoomPage";
import { RoomsPage } from "./pages/RoomsPage";
import { AppLayout } from "./components/shared/AppLayout";
import { useAuthStore } from "./stores/authStore";
import type { ReactNode } from "react";

function RequireAuth({ children }: { children: ReactNode }) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return children;
}

export function App() {
  return (
    <Routes>
      {/* RoomPage uses full-screen layout (no sidebar) */}
      <Route path="/rooms/:roomId" element={<RequireAuth><RoomPage /></RequireAuth>} />

      {/* Other pages use AppLayout with sidebar */}
      <Route element={<AppLayout />}>
        <Route path="/" element={<Navigate to="/rooms" replace />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/rooms" element={<RequireAuth><RoomsPage /></RequireAuth>} />
      </Route>
    </Routes>
  );
}
