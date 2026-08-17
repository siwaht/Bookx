import type React from 'react';

/**
 * Shared size scale.
 *
 * The app was built with 9–13px text and 5–8px control padding, which read as
 * cramped and made small targets hard to hit. These tokens define one
 * deliberately larger scale so surfaces grow together instead of each screen
 * picking its own numbers.
 *
 * Colour, radius, and shadow still come from the CSS custom properties in
 * styles.css — this file only covers size, spacing, and weight.
 */

/** Font sizes. `body` is the default for readable copy. */
export const text = {
  /** Timestamps, counts, tiny tags. */
  micro: 11,
  /** Secondary metadata under a title. */
  meta: 12.5,
  /** Field labels and compact controls. */
  label: 13,
  /** Default body copy and list rows. */
  body: 14,
  /** Emphasised row titles. */
  strong: 15,
  /** Card and section headings. */
  title: 17,
  /** Page headings. */
  heading: 22,
  /** Hero numbers. */
  display: 28,
} as const;

export const weight = {
  normal: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;

/** Icon pixel sizes, paired with the text scale. */
export const icon = {
  xs: 13,
  sm: 15,
  md: 17,
  lg: 20,
  xl: 24,
} as const;

/** Control padding and minimum heights. Minimum heights keep tap targets usable. */
export const control = {
  sm: { padding: '7px 13px', fontSize: text.label, minHeight: 32, gap: 6 },
  md: { padding: '10px 18px', fontSize: text.body, minHeight: 40, gap: 8 },
  lg: { padding: '13px 24px', fontSize: text.strong, minHeight: 48, gap: 9 },
} as const;

/** Square icon-only buttons. */
export const iconButton = {
  sm: 30,
  md: 36,
  lg: 42,
} as const;

export const space = {
  xs: 6,
  sm: 10,
  md: 14,
  lg: 20,
  xl: 28,
  xxl: 40,
} as const;

/** Text input / select / textarea baseline, shared so fields match buttons. */
export const field: React.CSSProperties = {
  padding: '10px 14px',
  fontSize: text.body,
  minHeight: 40,
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--border-default)',
  background: 'var(--bg-deep)',
  color: 'var(--text-primary)',
  outline: 'none',
  fontFamily: 'inherit',
};

/** Truncate to a single line. */
export const ellipsis: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
};

/** Clamp to `lines` lines. Used for sample dialogue in the cast list. */
export function clampLines(lines: number): React.CSSProperties {
  return {
    display: '-webkit-box',
    WebkitLineClamp: lines,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  };
}
