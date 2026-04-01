import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAppStore } from './stores/appStore';
import { auth } from './services/api';
import { LoginPage } from './components/LoginPage';
import { ErrorBoundary } from './components/ErrorBoundary';
import { TopNav } from './components/TopNav';
import { ToastContainer } from './components/Toast';
import { Dashboard } from './pages/Dashboard';
import { BookEditor } from './pages/BookEditor';
import { ManuscriptPage } from './pages/ManuscriptPage';
import { VoicesPage } from './pages/VoicesPage';
import { TimelinePage } from './pages/TimelinePage';
import { QCPage } from './pages/QCPage';
import { ExportPage } from './pages/ExportPage';
import { AudioStudioPage } from './pages/AudioStudioPage';
import { SettingsPage } from './pages/SettingsPage';
import { PronunciationPage } from './pages/PronunciationPage';
import { UsagePage } from './pages/UsagePage';
import { LibraryPage } from './pages/LibraryPage';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30000 } },
});

function AuthGate({ children }: { children: React.ReactNode }) {
  const authenticated = useAppStore((s) => s.authenticated);
  const setAuthenticated = useAppStore((s) => s.setAuthenticated);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const verifyAuth = async () => {
      if (!authenticated) {
        setChecking(false);
        return;
      }
      try {
        await auth.verify();
        setAuthenticated(true);
      } catch {
        setAuthenticated(false);
      } finally {
        setChecking(false);
      }
    };
    verifyAuth();
  }, [authenticated, setAuthenticated]);

  if (checking) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: 'var(--bg-deep)', color: 'var(--text-tertiary)' }}>
        Loading...
      </div>
    );
  }

  if (!authenticated) return <LoginPage />;
  return <>{children}</>;
}

function AppLayout() {
  const location = useLocation();
  const isBookEditor = location.pathname.startsWith('/book/');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {!isBookEditor && <TopNav />}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/book/:bookId" element={<BookEditor />}>
            <Route index element={<ManuscriptPage />} />
            <Route path="voices" element={<VoicesPage />} />
            <Route path="pronunciation" element={<PronunciationPage />} />
            <Route path="studio" element={<AudioStudioPage />} />
            <Route path="timeline" element={<TimelinePage />} />
            <Route path="qc" element={<QCPage />} />
            <Route path="export" element={<ExportPage />} />
            <Route path="usage" element={<UsagePage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthGate>
            <ErrorBoundary>
              <AppLayout />
            </ErrorBoundary>
          </AuthGate>
          <ToastContainer />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
