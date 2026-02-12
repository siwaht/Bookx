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
import { PronunciationPage } from './pages/PronunciationPage';
import { UsagePage } from './pages/UsagePage';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30000 } },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
          <Routes>
            <Route path="/" element={<Dashboard />} />
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
      </BrowserRouter>
    </QueryClientProvider>
  );
}
