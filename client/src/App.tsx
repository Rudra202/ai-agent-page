import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { AppShell } from './components/layout/AppShell';
import { Button } from './components/ui/Button';
import { LoadingState } from './components/ui/StateViews';
import { ActivityPage } from './pages/ActivityPage';
import { ApplicationDetailPage } from './pages/ApplicationDetailPage';
import { ApplicationsPage } from './pages/ApplicationsPage';
import { LoginPage, RegisterPage } from './pages/AuthPages';
import { ChatPage } from './pages/ChatPage';
import { CompanySetupPage } from './pages/CompanySetupPage';
import { DesignSystemPage } from './pages/DesignSystemPage';
import { DocumentDetailPage } from './pages/DocumentDetailPage';
import { DocumentsPage } from './pages/DocumentsPage';
import { HomePage } from './pages/HomePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ProfilePage } from './pages/ProfilePage';
import { ReviewPage } from './pages/ReviewPage';
import { safeDestination } from './lib/redirect';
import { useApi } from './state/context';
import { AppProvider } from './state/AppStore';
import { useAuth } from './state/authContext';

function Splash({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <span className="flex size-12 items-center justify-center rounded-control bg-navy-900 text-white">
        <Sparkles className="size-6" aria-hidden />
      </span>
      {children}
    </div>
  );
}

/**
 * Everything behind sign-in. The data provider is created per user (keyed by the user id),
 * so one person's data can never be shown to the next person who signs in on the same browser.
 */
function Protected({ pollMs, activePollMs }: { pollMs?: number; activePollMs?: number }) {
  const auth = useAuth();
  const api = useApi();
  const location = useLocation();

  if (auth.status === 'loading') {
    return (
      <Splash>
        <LoadingState label="Checking your session..." />
      </Splash>
    );
  }
  if (auth.status === 'unavailable') {
    return (
      <Splash>
        <h1 className="text-xl font-bold text-navy-900">Cannot reach Tajir</h1>
        <p className="max-w-md text-sm text-muted">{auth.unavailableMessage || 'The server did not answer. Check that it is running and try again.'}</p>
        <p className="text-xs text-muted">This page checks again every few seconds.</p>
        <Button onClick={() => void auth.retry()}>Try again</Button>
      </Splash>
    );
  }
  if (auth.status === 'anonymous' || !auth.user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return (
    <AppProvider key={auth.user.id} api={api} user={auth.user} pollMs={pollMs} activePollMs={activePollMs}>
      <AppShell />
    </AppProvider>
  );
}

/** Sign-in and sign-up are only for people who are not signed in. */
function PublicOnly({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const destination = safeDestination(useLocation().state);
  if (auth.status === 'loading') {
    return (
      <Splash>
        <LoadingState label="Checking your session..." />
      </Splash>
    );
  }
  if (auth.status === 'authenticated') return <Navigate to={destination} replace />;
  return <>{children}</>;
}

export default function App({ pollMs, activePollMs }: { pollMs?: number; activePollMs?: number }) {
  return (
    <Routes>
      <Route path="/login" element={<PublicOnly><LoginPage /></PublicOnly>} />
      <Route path="/register" element={<PublicOnly><RegisterPage /></PublicOnly>} />
      <Route element={<Protected pollMs={pollMs} activePollMs={activePollMs} />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<HomePage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/company-setup" element={<CompanySetupPage />} />
        <Route path="/company-setup/review" element={<ReviewPage />} />
        <Route path="/applications" element={<ApplicationsPage />} />
        <Route path="/applications/:id" element={<ApplicationDetailPage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/documents" element={<DocumentsPage />} />
        <Route path="/documents/:id" element={<DocumentDetailPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/design" element={<DesignSystemPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
