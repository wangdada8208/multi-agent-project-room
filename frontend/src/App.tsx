import { Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/shared/AppLayout";
import { LoginPage } from "./pages/LoginPage";
import { RoomPage } from "./pages/RoomPage";
import { RoomsPage } from "./pages/RoomsPage";

export function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<Navigate to="/rooms" replace />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/rooms" element={<RoomsPage />} />
        <Route path="/rooms/:roomId" element={<RoomPage />} />
      </Route>
    </Routes>
  );
}
