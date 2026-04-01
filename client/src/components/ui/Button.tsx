import React from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: React.ReactNode;
  loading?: boolean;
}

const VARIANT_STYLES: Record<ButtonVariant, React.CSSProperties> = {
  primary: {
    background: 'var(--accent)', color: '#fff', border: 'none',
    boxShadow: '0 2px 8px rgba(91,141,239,0.2)',
  },
  secondary: {
    background: 'var(--bg-surface)', color: 'var(--text-secondary)',
    border: '1px solid var(--border-default)',
  },
  ghost: {
    background: 'none', color: 'var(--text-tertiary)', border: 'none',
  },
  danger: {
    background: 'var(--danger-subtle)', color: 'var(--danger)',
    border: '1px solid rgba(248,113,113,0.2)',
  },
};

const SIZE_STYLES: Record<ButtonSize, React.CSSProperties> = {
  sm: { padding: '5px 10px', fontSize: 11, borderRadius: 6 },
  md: { padding: '8px 16px', fontSize: 13, borderRadius: 8 },
};

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading,
  disabled,
  children,
  style,
  ...props
}: ButtonProps) {
  return (
    <button
      disabled={disabled || loading}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontWeight: 500, cursor: disabled || loading ? 'not-allowed' : 'pointer',
        opacity: disabled || loading ? 0.5 : 1,
        ...VARIANT_STYLES[variant],
        ...SIZE_STYLES[size],
        ...style,
      }}
      {...props}
    >
      {loading ? (
        <span style={{ animation: 'spin 0.8s linear infinite', display: 'flex' }}>⟳</span>
      ) : icon ? (
        <span style={{ display: 'flex' }}>{icon}</span>
      ) : null}
      {children}
    </button>
  );
}
