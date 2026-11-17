import { Navigate, Route, Routes, useParams } from "react-router-dom";
import type { ReactNode } from "react";
import { LoginPage } from "./pages/LoginPage";
import { HomePage } from "./pages/HomePage";
import { SetupPage } from "./pages/SetupPage";
import { RoomPage } from "./pages/RoomPage";
import { SharedRoomPage } from "./pages/SharedRoomPage";
import { ConnectDemoPage } from "./pages/ConnectDemoPage";
import { useAuthStore } from "./stores/authStore";

function RequireAuth({ children }: { children: ReactNode }) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return children;
}

function RoomRoute() {
  const { roomId } = useParams();
  const userId = useAuthStore((state) => state.user?.id);
  return <RoomPage key={`${userId}:${roomId}`} />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/shared/:token" element={<SharedRoomPage />} />
      <Route path="/connect-demo" element={<ConnectDemoPage />} />

      <Route path="/" element={<RequireAuth><HomePage /></RequireAuth>} />
      <Route path="/setup" element={<RequireAuth><SetupPage /></RequireAuth>} />
      <Route path="/setup/:roomId" element={<RequireAuth><SetupPage /></RequireAuth>} />
      <Route path="/rooms/:roomId" element={<RequireAuth><RoomRoute /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
