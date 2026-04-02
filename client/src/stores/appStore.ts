import { create } from 'zustand';
import type { Book, ElevenLabsCapabilities } from '../types';

type Theme = 'dark' | 'light';

interface AppState {
  authenticated: boolean;
  currentBook: Book | null;
  capabilities: ElevenLabsCapabilities | null;
  theme: Theme;
  setAuthenticated: (v: boolean) => void;
  setCurrentBook: (book: Book | null) => void;
  setCapabilities: (caps: ElevenLabsCapabilities) => void;
  toggleTheme: () => void;
}

function getInitialTheme(): Theme {
  const stored = localStorage.getItem('theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return 'dark';
}

export const useAppStore = create<AppState>((set) => ({
  authenticated: !!localStorage.getItem('auth_token'),
  currentBook: null,
  capabilities: null,
  theme: getInitialTheme(),
  setAuthenticated: (v) => {
    if (!v) localStorage.removeItem('auth_token');
    set({ authenticated: v });
  },
  setCurrentBook: (book) => set({ currentBook: book }),
  setCapabilities: (caps) => set({ capabilities: caps }),
  toggleTheme: () =>
    set((state) => {
      const next = state.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem('theme', next);
      document.documentElement.setAttribute('data-theme', next);
      return { theme: next };
    }),
}));
