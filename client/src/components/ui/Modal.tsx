import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { icon as iconSize, text, weight } from './tokens';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Small line under the title. Keep it to one sentence. */
  subtitle?: string;
  /** Rendered at the right of the header, before the close button. */
  headerAside?: React.ReactNode;
  /** Rendered pinned to the bottom of the panel. */
  footer?: React.ReactNode;
  width?: number;
  children: React.ReactNode;
}

/**
 * A single overlay primitive so option-heavy surfaces (voice browsing, saved
 * casts, tag references) can live one click away instead of crowding a page.
 *
 * Handles: backdrop click, Escape, focus trap entry, scroll lock, and
 * returning focus to whatever was focused before it opened.
 */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  headerAside,
  footer,
  width = 560,
  children,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    restoreFocusRef.current = document.activeElement as HTMLElement | null;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;

      // Keep tabbing inside the panel while it's open.
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Move focus into the panel so keyboard users land in the right place.
    const focusTimer = window.setTimeout(() => {
      const target = panelRef.current?.querySelector<HTMLElement>(
        'input:not([disabled]), button:not([disabled])'
      );
      target?.focus();
    }, 0);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      window.clearTimeout(focusTimer);
      restoreFocusRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  // Rendered through a portal on purpose: several page wrappers keep a
  // persistent `transform` from their entry animation, and a transformed
  // ancestor becomes the containing block for `position: fixed` — which would
  // pin this overlay to the page column and clip it instead of covering the
  // viewport.
  return createPortal(
    <div
      style={S.backdrop}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ ...S.panel, maxWidth: width }}
        className="animate-in-scale"
      >
        <header style={S.header}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 style={S.title}>{title}</h2>
            {subtitle && <p style={S.subtitle}>{subtitle}</p>}
          </div>
          {headerAside}
          <button onClick={onClose} style={S.closeBtn} aria-label="Close">
            <X size={iconSize.md} />
          </button>
        </header>

        <div style={S.body}>{children}</div>

        {footer && <footer style={S.footer}>{footer}</footer>}
      </div>
    </div>,
    document.body
  );
}

const S: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 500,
    background: 'rgba(0, 0, 0, 0.6)',
    backdropFilter: 'blur(4px)',
    WebkitBackdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
  },
  panel: {
    width: '100%',
    maxHeight: 'min(84vh, 820px)',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg-base)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-xl)',
    boxShadow: 'var(--shadow-xl)',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 16,
    padding: '20px 24px',
    borderBottom: '1px solid var(--border-subtle)',
    flexShrink: 0,
  },
  title: {
    fontSize: text.title,
    fontWeight: weight.semibold,
    color: 'var(--text-primary)',
    margin: 0,
    letterSpacing: '-0.02em',
  },
  subtitle: {
    fontSize: text.label,
    color: 'var(--text-tertiary)',
    margin: '5px 0 0',
    lineHeight: 1.5,
  },
  closeBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 34,
    height: 34,
    flexShrink: 0,
    background: 'none',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-md)',
    color: 'var(--text-tertiary)',
    cursor: 'pointer',
  },
  body: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    padding: 24,
  },
  footer: {
    padding: '16px 24px',
    borderTop: '1px solid var(--border-subtle)',
    background: 'var(--bg-surface)',
    flexShrink: 0,
  },
};
