import { Suspense, lazy, useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { LandingPage } from './pages/LandingPage';
import { LoginPage } from './pages/LoginPage';
import { HomePage } from './pages/HomePage';
import { OnboardingPage } from './pages/OnboardingPage';
import { useAuthStore } from './stores/authStore';
import { useVisualViewport } from './hooks/useVisualViewport';

const AgentsPage = lazy(() =>
  import('./pages/AgentsPage').then((m) => ({ default: m.AgentsPage })),
);
const SetupPage = lazy(() =>
  import('./pages/SetupPage').then((m) => ({ default: m.SetupPage })),
);
const RoomPage = lazy(() =>
  import('./pages/RoomPage').then((m) => ({ default: m.RoomPage })),
);
const SharedRoomPage = lazy(() =>
  import('./pages/SharedRoomPage').then((m) => ({ default: m.SharedRoomPage })),
);
const ConnectDemoPage = lazy(() =>
  import('./pages/ConnectDemoPage').then((m) => ({ default: m.ConnectDemoPage })),
);

function RouteSurfaceSync() {
  const { pathname } = useLocation();
  useEffect(() => {
    const isLanding = pathname === '/';
    const root = document.documentElement;
    root.dataset.surface = isLanding ? 'landing' : 'app';
    if (!isLanding) {
      root.classList.remove('m-enter', 'mo-js');
    }
    document.querySelectorAll<HTMLLinkElement>('link[data-landing-kit="1"]').forEach((link) => {
      link.disabled = !isLanding;
    });
  }, [pathname]);
  return null;
}

function RequireAuth({ children }: { children: ReactNode }) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const location = useLocation();
  if (!isAuthenticated) {
    const target = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={`/login?next=${encodeURIComponent(target)}`} replace />;
  }
  return children;
}

function RoomRoute() {
  const { roomId } = useParams();
  const userId = useAuthStore((state) => state.user?.id);
  return <RoomPage key={`${userId}:${roomId}`} />;
}

export function App() {
  useVisualViewport();
  return (
    <>
      <RouteSurfaceSync />
      <Suspense
        fallback={
          <div className="loading-center loading-center--full">
            <span className="spinner" />
          </div>
        }
      >
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/shared/:token" element={<SharedRoomPage />} />
          <Route path="/connect-demo" element={<ConnectDemoPage />} />

          <Route path="/" element={<LandingPage />} />
          <Route path="/rooms" element={<Navigate to="/home" replace />} />
          <Route path="/home" element={<RequireAuth><HomePage /></RequireAuth>} />
          <Route path="/agents" element={<RequireAuth><AgentsPage /></RequireAuth>} />
          <Route path="/setup" element={<RequireAuth><OnboardingPage /></RequireAuth>} />
          <Route path="/setup/:roomId" element={<RequireAuth><SetupPage /></RequireAuth>} />
          <Route path="/rooms/:roomId" element={<RequireAuth><RoomRoute /></RequireAuth>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </>
  );
}
