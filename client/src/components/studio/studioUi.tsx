import type { ReactNode } from "react";

/**
 * Shared look for the production studio panels, built on the Prosecast
 * design tokens in index.css (paper, stone, ink, brand, gold, clay, sky).
 * Kept in one place so a theme pass can restyle every studio panel here.
 */
export const ui = {
  card: "rounded-card border border-stone-150 bg-paper p-6 shadow-hairline",
  /** A card that sits above the page, such as the chapter player. */
  cardRaised: "rounded-card border border-stone-150 bg-paper p-6 shadow-soft",
  cardQuiet: "rounded-card border border-stone-150 bg-paper-50 p-4",
  /** Card title, the same size as the other cards in the app. */
  title: "text-[15px] font-semibold text-ink-900",
  /** Weight and colour only; the caller picks the size. */
  heading: "font-semibold text-ink-900",
  eyebrow: "eyebrow text-brand-600",
  muted: "text-ink-500",
  faint: "text-ink-500",
  strong: "text-ink-800",
  label: "mb-1.5 block text-xs font-semibold text-ink-700",
  divider: "border-t border-stone-150",
  dialog: "rounded-panel bg-paper",
  chip: "inline-flex min-h-[28px] items-center gap-1 rounded-full border border-stone-200 bg-paper px-2.5 py-1 text-ink-600 transition-colors hover:border-brand-300 hover:text-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600",
  chipOn: "inline-flex min-h-[28px] items-center gap-1 rounded-full border border-brand-500 bg-brand-50 px-2.5 py-1 text-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600",
  chipText: "text-2xs font-semibold",
  linkButton: "inline-flex min-h-[24px] items-center gap-1 rounded-lg px-1.5 text-brand-700 transition-colors hover:bg-brand-50 disabled:opacity-40",
  linkText: "text-2xs font-semibold",
  iconButton: "grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-stone-200 bg-paper text-brand-700 transition-colors hover:border-brand-300 hover:bg-brand-50 disabled:opacity-40",
  /** Progress track; the caller sets the height (h-2, h-1.5). */
  bar: "overflow-hidden rounded-full bg-brand-100",
  barFill: "h-full rounded-full bg-brand-500 transition-[width] duration-500 ease-out motion-reduce:transition-none",
  numbers: "tabular-nums",
} as const;

export type Tone = "neutral" | "info" | "good" | "warn" | "bad";

const TONES: Record<Tone, string> = {
  neutral: "bg-stone-50 text-ink-600 ring-stone-150",
  info: "bg-sky-50 text-sky-700 ring-sky-100",
  good: "bg-brand-50 text-brand-700 ring-brand-100",
  warn: "bg-gold-50 text-gold-700 ring-gold-200",
  bad: "bg-clay-50 text-clay-700 ring-clay-100",
};

/** A small status label. The text always carries the meaning; colour only repeats it. */
export function Badge({ tone = "neutral", children, className = "" }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-3xs font-semibold ring-1 ${TONES[tone]} ${className}`}>{children}</span>;
}

export function Notice({ tone = "info", title, children, action }: { tone?: Exclude<Tone, "neutral">; title?: string; children: ReactNode; action?: ReactNode }) {
  const styles: Record<Exclude<Tone, "neutral">, string> = {
    info: "border-brand-100 bg-brand-50/60 text-brand-800",
    good: "border-brand-200 bg-brand-50 text-brand-800",
    warn: "border-gold-200 bg-gold-50 text-gold-700",
    bad: "border-clay-200 bg-clay-50 text-clay-700",
  };
  return (
    <div className={`rounded-card border p-4 text-xs leading-5 ${styles[tone]}`} role={tone === "bad" ? "alert" : undefined}>
      {title && <strong className="mb-1 block text-sm font-semibold">{title}</strong>}
      <div>{children}</div>
      {action && <div className="mt-2.5">{action}</div>}
    </div>
  );
}

/** "1:04:05" or "4:05" for a player clock. */
export function playerClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** "12,400" with the locale's grouping. */
export const count = (value: number | null | undefined) => (value == null ? "—" : Math.round(value).toLocaleString());

/** A range input with a visible label and value, for settings sliders. */
export function RangeField({ id, label, value, min, max, step, onChange, format, hint, disabled }: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
  hint?: string;
  disabled?: boolean;
}) {
  const shown = format ? format(value) : String(value);
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs font-semibold text-ink-700">{label}</label>
        <span className={`text-2xs font-semibold text-ink-700 ${ui.numbers}`} aria-hidden="true">{shown}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-valuetext={shown}
        onChange={event => onChange(Number(event.target.value))}
        className="mt-1.5 h-6 w-full cursor-pointer accent-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
      />
      {hint && <p className={`mt-0.5 text-3xs leading-4 ${ui.faint}`}>{hint}</p>}
    </div>
  );
}
