import React from 'react';
import { text, weight } from './tokens';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
  /** Small trailing count, e.g. how many items are in that section. */
  count?: number;
}

interface SegmentedProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  size?: 'sm' | 'md';
  /** Stretch each segment to fill the container evenly. */
  fill?: boolean;
}

/** One tab/toggle style for the whole app. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = 'md',
  fill = false,
}: SegmentedProps<T>) {
  const pad = size === 'sm' ? '8px 14px' : '10px 20px';
  const font = size === 'sm' ? text.label : text.body;

  return (
    <div role="tablist" aria-label={ariaLabel} style={{ ...S.track, width: fill ? '100%' : undefined }}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            style={{
              ...S.segment,
              padding: pad,
              fontSize: font,
              flex: fill ? 1 : undefined,
              ...(active ? S.segmentActive : {}),
            }}
          >
            {opt.icon}
            {opt.label}
            {opt.count !== undefined && (
              <span style={{ ...S.count, ...(active ? S.countActive : {}) }}>{opt.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  track: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    padding: 4,
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-lg)',
  },
  segment: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 38,
    background: 'none',
    border: 'none',
    borderRadius: 'var(--radius-md)',
    color: 'var(--text-tertiary)',
    cursor: 'pointer',
    fontWeight: weight.medium,
    whiteSpace: 'nowrap',
  },
  segmentActive: {
    background: 'var(--bg-elevated)',
    color: 'var(--text-primary)',
    fontWeight: weight.semibold,
    boxShadow: 'var(--shadow-sm)',
  },
  count: {
    fontSize: text.micro,
    fontWeight: weight.semibold,
    padding: '2px 7px',
    borderRadius: 20,
    background: 'var(--bg-elevated)',
    color: 'var(--text-muted)',
  },
  countActive: {
    background: 'var(--accent-subtle)',
    color: 'var(--accent)',
  },
};

interface ChipProps {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  /** Active accent as a 6-digit hex, e.g. a TTS provider brand colour. */
  hexColor?: string;
  title?: string;
}

/** Filter chip. Used for provider / gender filters in the voice picker. */
export function Chip({ active, onClick, children, hexColor, title }: ChipProps) {
  const activeStyle: React.CSSProperties = hexColor
    ? { background: `${hexColor}22`, color: hexColor, borderColor: `${hexColor}55` }
    : { background: 'var(--accent-subtle)', color: 'var(--accent)', borderColor: 'var(--border-accent)' };

  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={!!active}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '7px 14px',
        minHeight: 34,
        fontSize: text.label,
        fontWeight: weight.medium,
        borderRadius: 20,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        background: 'var(--bg-surface)',
        color: 'var(--text-tertiary)',
        border: '1px solid var(--border-subtle)',
        ...(active ? activeStyle : {}),
      }}
    >
      {children}
    </button>
  );
}
