import React, { useState, useCallback } from 'react';
import { create } from 'zustand';
import { CheckCircle, AlertTriangle, XCircle, Info, X } from 'lucide-react';

type ToastType = 'success' | 'error' | 'warning' | 'info';

interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
}

interface ToastStore {
  toasts: Toast[];
  add: (type: ToastType, message: string, duration?: number) => void;
  remove: (id: string) => void;
}

let counter = 0;

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  add: (type, message, duration = 4000) => {
    const id = `toast-${++counter}`;
    set((s) => ({ toasts: [...s.toasts, { id, type, message, duration }] }));
    if (duration > 0) {
      setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), duration);
    }
  },
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
  success: (msg: string, duration?: number) => useToastStore.getState().add('success', msg, duration),
  error: (msg: string, duration?: number) => useToastStore.getState().add('error', msg, duration ?? 6000),
  warning: (msg: string, duration?: number) => useToastStore.getState().add('warning', msg, duration ?? 5000),
  info: (msg: string, duration?: number) => useToastStore.getState().add('info', msg, duration),
};

const ICONS: Record<ToastType, React.ReactNode> = {
  success: <CheckCircle size={16} />,
  error: <XCircle size={16} />,
  warning: <AlertTriangle size={16} />,
  info: <Info size={16} />,
};

const COLORS: Record<ToastType, { bg: string; border: string; text: string; glow: string }> = {
  success: { bg: 'rgba(74, 222, 128, 0.08)', border: 'rgba(74, 222, 128, 0.20)', text: '#4ade80', glow: 'rgba(74, 222, 128, 0.06)' },
  error: { bg: 'rgba(248, 113, 113, 0.08)', border: 'rgba(248, 113, 113, 0.20)', text: '#f87171', glow: 'rgba(248, 113, 113, 0.06)' },
  warning: { bg: 'rgba(251, 191, 36, 0.08)', border: 'rgba(251, 191, 36, 0.20)', text: '#fbbf24', glow: 'rgba(251, 191, 36, 0.06)' },
  info: { bg: 'rgba(91, 141, 239, 0.08)', border: 'rgba(91, 141, 239, 0.20)', text: '#5b8def', glow: 'rgba(91, 141, 239, 0.06)' },
};

function ToastItem({ t, onRemove }: { t: Toast; onRemove: () => void }) {
  const [exiting, setExiting] = useState(false);
  const c = COLORS[t.type];

  const handleRemove = useCallback(() => {
    setExiting(true);
    setTimeout(onRemove, 200);
  }, [onRemove]);

  return (
    <div
      role="alert"
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '11px 14px', borderRadius: 12,
        background: c.bg, border: `1px solid ${c.border}`,
        color: c.text, fontSize: 13, fontWeight: 500,
        backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
        boxShadow: `0 8px 32px rgba(0,0,0,0.3), 0 0 24px ${c.glow}`,
        animation: exiting ? 'toastOut 200ms ease forwards' : 'toastIn 250ms ease both',
        maxWidth: 420, lineHeight: 1.4,
      }}
    >
      <span style={{ flexShrink: 0 }}>{ICONS[t.type]}</span>
      <span style={{ flex: 1 }}>{t.message}</span>
      <button
        onClick={handleRemove}
        style={{
          background: 'none', border: 'none', color: c.text, cursor: 'pointer',
          padding: 2, opacity: 0.5, flexShrink: 0,
        }}
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const remove = useToastStore((s) => s.remove);

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      style={{
        position: 'fixed', bottom: 20, right: 20, zIndex: 9999,
        display: 'flex', flexDirection: 'column', gap: 8,
        pointerEvents: 'none',
      }}
    >
      {toasts.map((t) => (
        <div key={t.id} style={{ pointerEvents: 'auto' }}>
          <ToastItem t={t} onRemove={() => remove(t.id)} />
        </div>
      ))}
    </div>
  );
}
