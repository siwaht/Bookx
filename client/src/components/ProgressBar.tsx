import React from 'react';

interface ProgressBarProps {
  current: number;
  total: number;
  label?: string;
  showCount?: boolean;
  variant?: 'default' | 'gradient';
}

export function ProgressBar({ current, total, label, showCount = true, variant = 'default' }: ProgressBarProps) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;

  return (
    <div style={styles.wrap}>
      {(label || showCount) && (
        <div style={styles.header}>
          {label && <span style={styles.label}>{label}</span>}
          {showCount && <span style={styles.count}>{current}/{total}</span>}
        </div>
      )}
      <div style={styles.track}>
        <div
          style={{
            ...styles.fill,
            width: `${pct}%`,
            background: variant === 'gradient'
              ? 'var(--accent-gradient)'
              : 'linear-gradient(90deg, var(--accent), #7ba4f7)',
          }}
          role="progressbar"
          aria-valuenow={current}
          aria-valuemin={0}
          aria-valuemax={total}
        />
      </div>
      <span style={styles.pct}>{pct}%</span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 4 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  label: { fontSize: 11, color: 'var(--text-secondary)', fontWeight: 500 },
  count: { fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 500 },
  track: {
    width: '100%', height: 5, background: 'var(--bg-elevated)',
    borderRadius: 4, overflow: 'hidden',
  },
  fill: {
    height: '100%', borderRadius: 4,
    transition: 'width 0.6s cubic-bezier(0.16, 1, 0.3, 1)',
  },
  pct: { fontSize: 10, color: 'var(--text-muted)', alignSelf: 'flex-end' },
};
