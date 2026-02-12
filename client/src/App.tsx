import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAppStore } from './stores/appStore';
import { auth } from './services/api';
import { LoginPage } from './components/LoginPage';
import { Dashboard } from './pages/Dashboard';
import { BookEditor } from './pages/BookEditor';
import { ManuscriptPage } from './pages/ManuscriptPage';
import { VoicesPage } from './pages/VoicesPage';
import { TimelinePage } from './pages/TimelinePage';
import { QCPage } from './pages/QCPage';
import { ExportPage } from './pages/ExportPage';
import { AudioStudioPage } from './pages/AudioStudioPage';
import { SettingsPage } from './pages/SettingsPage';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30000 } },
});

function AuthGate({ children }: { children: React.ReactNode }) {
  const authenticated = useAppStore((s) => s.authenticated);
  const setAuthenticated = useAppStore((s) => s.setAuthenticated);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!authenticated) { setChecking(false); return; }
    // Verify stored token is still valid
    auth.verify().then(() => {
      setAuthenticated(true);
      setChecking(false);
    }).catch(() => {
      setAuthenticated(false);
      setChecking(false);
    });
  }, []);

  if (checking) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#0f0f0f', color: '#555' }}>
        Loading...
      </div>
    );
  }

  if (!authenticated) return <LoginPage />;
  return <>{children}</>;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthGate>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/book/:bookId" element={<BookEditor />}>
              <Route index element={<ManuscriptPage />} />
              <Route path="voices" element={<VoicesPage />} />
              <Route path="studio" element={<AudioStudioPage />} />
              <Route path="timeline" element={<TimelinePage />} />
              <Route path="qc" element={<QCPage />} />
              <Route path="export" element={<ExportPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthGate>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
