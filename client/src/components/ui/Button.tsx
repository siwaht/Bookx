import React from 'react';
import { Loader } from 'lucide-react';
import { control, icon, weight } from './tokens';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'subtle';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: React.ReactNode;
  loading?: boolean;
  /** Stretch to the width of the parent. */
  block?: boolean;
}

const VARIANT_STYLES: Record<ButtonVariant, React.CSSProperties> = {
  primary: {
    background: 'var(--accent)',
    color: '#fff',
    border: '1px solid var(--accent)',
  },
  secondary: {
    background: 'var(--bg-elevated)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-default)',
  },
  subtle: {
    background: 'var(--accent-subtle)',
    color: 'var(--accent)',
    border: '1px solid var(--border-accent)',
  },
  ghost: {
    background: 'none',
    color: 'var(--text-secondary)',
    border: '1px solid transparent',
  },
  danger: {
    background: 'var(--danger-subtle)',
    color: 'var(--danger)',
    border: '1px solid rgba(248,113,113,0.22)',
  },
  success: {
    background: 'var(--success-subtle)',
    color: 'var(--success)',
    border: '1px solid rgba(74,222,128,0.22)',
  },
};

export const BUTTON_ICON_SIZE: Record<ButtonSize, number> = {
  sm: icon.xs,
  md: icon.sm,
  lg: icon.md,
};

export function Button({
  variant = 'secondary',
  size = 'md',
  icon: iconNode,
  loading,
  block,
  disabled,
  children,
  style,
  ...props
}: ButtonProps) {
  const sizing = control[size];
  return (
    <button
      disabled={disabled || loading}
      style={{
        display: block ? 'flex' : 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: block ? '100%' : undefined,
        padding: sizing.padding,
        fontSize: sizing.fontSize,
        minHeight: sizing.minHeight,
        gap: sizing.gap,
        borderRadius: 'var(--radius-md)',
        fontWeight: weight.semibold,
        letterSpacing: '-0.01em',
        cursor: disabled || loading ? 'not-allowed' : 'pointer',
        ...(disabled || loading ? { opacity: 0.5 } : {}),
        whiteSpace: 'nowrap',
        ...VARIANT_STYLES[variant],
        ...style,
      }}
      {...props}
    >
      {loading ? (
        <Loader size={BUTTON_ICON_SIZE[size]} className="spin" />
      ) : iconNode ? (
        <span style={{ display: 'flex', flexShrink: 0 }}>{iconNode}</span>
      ) : null}
      {children}
    </button>
  );
}

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  size?: ButtonSize;
  variant?: ButtonVariant;
  /** Required: icon-only buttons have no visible text. */
  label: string;
}

/** Square, icon-only button with a mandatory accessible label. */
export function IconButton({
  size = 'md',
  variant = 'ghost',
  label,
  children,
  style,
  disabled,
  ...props
}: IconButtonProps) {
  const box = size === 'sm' ? 30 : size === 'lg' ? 42 : 36;
  return (
    <button
      aria-label={label}
      title={label}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: box,
        height: box,
        flexShrink: 0,
        borderRadius: 'var(--radius-md)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        // Only set opacity when disabled. Setting it unconditionally would be an
        // inline style that overrides class-based reveal-on-hover behaviour.
        ...(disabled ? { opacity: 0.5 } : {}),
        ...VARIANT_STYLES[variant],
        ...(variant === 'ghost' ? { border: '1px solid var(--border-subtle)' } : {}),
        ...style,
      }}
      {...props}
    >
      {children}
    </button>
  );
}
