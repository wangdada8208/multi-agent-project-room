import { Navigate, Route, Routes } from "react-router-dom";
import { LoginPage } from "./pages/LoginPage";
import { RoomPage } from "./pages/RoomPage";
import { RoomsPage } from "./pages/RoomsPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { TeamPage } from "./pages/TeamPage";
import { SharedRoomPage } from "./pages/SharedRoomPage";
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
      {/* Login — standalone full-page */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/onboarding" element={<RequireAuth><OnboardingPage /></RequireAuth>} />
      <Route path="/team" element={<RequireAuth><TeamPage /></RequireAuth>} />
      <Route path="/rooms/:roomId/team" element={<RequireAuth><TeamPage /></RequireAuth>} />
      <Route path="/shared/:token" element={<SharedRoomPage />} />

      {/* Room — full-screen (no sidebar) */}
      <Route path="/rooms/:roomId" element={<RequireAuth><RoomPage /></RequireAuth>} />

      {/* Rooms list — with sidebar */}
      <Route path="/" element={<RequireAuth><RoomsPage /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
