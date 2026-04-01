import React, { useEffect, useState } from 'react';
import { X, Keyboard } from 'lucide-react';

interface Shortcut {
  keys: string[];
  description: string;
}

interface ShortcutGroup {
  title: string;
  shortcuts: Shortcut[];
}

const TIMELINE_SHORTCUTS: ShortcutGroup[] = [
  {
    title: 'Playback',
    shortcuts: [
      { keys: ['Space'], description: 'Play / Pause' },
      { keys: ['Home'], description: 'Jump to start' },
    ],
  },
  {
    title: 'Editing',
    shortcuts: [
      { keys: ['Ctrl', 'Z'], description: 'Undo' },
      { keys: ['Ctrl', 'Shift', 'Z'], description: 'Redo' },
      { keys: ['Ctrl', 'X'], description: 'Cut clip' },
      { keys: ['Ctrl', 'C'], description: 'Copy clip' },
      { keys: ['Ctrl', 'V'], description: 'Paste clip' },
      { keys: ['Delete'], description: 'Delete selected clip(s)' },
      { keys: ['S'], description: 'Split clip at playhead' },
      { keys: ['D'], description: 'Duplicate clip' },
    ],
  },
  {
    title: 'Selection',
    shortcuts: [
      { keys: ['Shift', 'Click'], description: 'Multi-select clips' },
      { keys: ['Ctrl', 'A'], description: 'Select all clips' },
    ],
  },
  {
    title: 'Advanced',
    shortcuts: [
      { keys: ['G'], description: 'Toggle snap to grid' },
      { keys: ['R'], description: 'Toggle ripple edit mode' },
    ],
  },
  {
    title: 'View',
    shortcuts: [
      { keys: ['Ctrl', '+'], description: 'Zoom in' },
      { keys: ['Ctrl', '-'], description: 'Zoom out' },
    ],
  },
  {
    title: 'File',
    shortcuts: [
      { keys: ['Ctrl', 'S'], description: 'Save project' },
    ],
  },
];

export function KeyboardShortcutsDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.dialog} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
        <div style={styles.header}>
          <div style={styles.titleRow}>
            <Keyboard size={16} color="var(--accent)" />
            <h3 style={styles.title}>Keyboard Shortcuts</h3>
          </div>
          <button onClick={onClose} style={styles.closeBtn} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div style={styles.body}>
          {TIMELINE_SHORTCUTS.map((group) => (
            <div key={group.title} style={styles.group}>
              <h4 style={styles.groupTitle}>{group.title}</h4>
              {group.shortcuts.map((s, i) => (
                <div key={i} style={styles.row}>
                  <span style={styles.desc}>{s.description}</span>
                  <div style={styles.keys}>
                    {s.keys.map((k, j) => (
                      <React.Fragment key={j}>
                        {j > 0 && <span style={styles.plus}>+</span>}
                        <kbd style={styles.kbd}>{k}</kbd>
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div style={styles.footer}>
          Press <kbd style={styles.kbd}>?</kbd> to toggle this dialog
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 1000, backdropFilter: 'blur(4px)',
  },
  dialog: {
    background: 'var(--bg-surface)', borderRadius: 'var(--radius-lg)',
    border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-lg)',
    width: 420, maxHeight: '80vh', display: 'flex', flexDirection: 'column',
    animation: 'fadeInScale 200ms ease both',
  },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '16px 20px', borderBottom: '1px solid var(--border-subtle)',
  },
  titleRow: { display: 'flex', alignItems: 'center', gap: 8 },
  title: { fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' },
  closeBtn: {
    background: 'none', border: 'none', color: 'var(--text-muted)',
    cursor: 'pointer', padding: 4,
  },
  body: { padding: '16px 20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 },
  group: { display: 'flex', flexDirection: 'column', gap: 6 },
  groupTitle: {
    fontSize: 10, fontWeight: 600, color: 'var(--text-muted)',
    letterSpacing: 1, textTransform: 'uppercase', marginBottom: 2,
  },
  row: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '4px 0',
  },
  desc: { fontSize: 13, color: 'var(--text-secondary)' },
  keys: { display: 'flex', alignItems: 'center', gap: 4 },
  kbd: {
    display: 'inline-block', padding: '2px 7px', fontSize: 11, fontWeight: 600,
    background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
    borderRadius: 5, color: 'var(--text-secondary)', fontFamily: 'inherit',
    lineHeight: '18px',
  },
  plus: { fontSize: 10, color: 'var(--text-muted)' },
  footer: {
    padding: '12px 20px', borderTop: '1px solid var(--border-subtle)',
    fontSize: 12, color: 'var(--text-muted)', textAlign: 'center',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  },
};
