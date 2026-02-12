import { create } from 'zustand';
import type { Book, ElevenLabsCapabilities } from '../types';

interface AppState {
  authenticated: boolean;
  currentBook: Book | null;
  capabilities: ElevenLabsCapabilities | null;
  setAuthenticated: (v: boolean) => void;
  setCurrentBook: (book: Book | null) => void;
  setCapabilities: (caps: ElevenLabsCapabilities) => void;
}

export const useAppStore = create<AppState>((set) => ({
  authenticated: !!localStorage.getItem('auth_token'),
  currentBook: null,
  capabilities: null,
  setAuthenticated: (v) => set({ authenticated: v }),
  setCurrentBook: (book) => set({ currentBook: book }),
  setCapabilities: (caps) => set({ capabilities: caps }),
}));
