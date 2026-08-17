import React, { useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { icon as iconSize, text, weight } from './tokens';

interface CollapsibleProps {
  title: string;
  /** Short right-aligned summary shown while collapsed, e.g. "Eleven v3 · 1.0x". */
  summary?: string;
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

/**
 * Progressive disclosure for advanced controls. The point of this component is
 * that power-user options stay available without being on screen by default.
 */
export function Collapsible({ title, summary, icon, defaultOpen = false, children }: CollapsibleProps) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();

  return (
    <div style={S.wrap}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        style={S.trigger}
      >
        <ChevronRight
          size={iconSize.sm}
          style={{
            flexShrink: 0,
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform 150ms var(--ease-out)',
            color: 'var(--text-muted)',
          }}
        />
        {icon}
        <span style={S.title}>{title}</span>
        {summary && !open && <span style={S.summary}>{summary}</span>}
      </button>
      {open && (
        <div id={panelId} style={S.body}>
          {children}
        </div>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: {
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--bg-surface)',
    overflow: 'hidden',
  },
  trigger: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    minHeight: 46,
    padding: '12px 16px',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    textAlign: 'left',
  },
  title: {
    fontSize: text.body,
    fontWeight: weight.semibold,
    color: 'var(--text-secondary)',
  },
  summary: {
    marginLeft: 'auto',
    fontSize: text.meta,
    color: 'var(--text-muted)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  body: {
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    borderTop: '1px solid var(--border-subtle)',
  },
};
