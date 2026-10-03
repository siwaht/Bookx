import type { ReactNode } from "react";

/**
 * Shared look for the production studio panels. Kept in one place so a
 * future theme pass can restyle every studio panel by editing these strings.
 */
export const ui = {
  card: "rounded-[22px] border border-[#e0e5de] bg-[#fffefa] p-5",
  cardQuiet: "rounded-[18px] border border-[#e3e8e2] bg-[#fbfcf9] p-4",
  heading: "font-bold text-[#2f4346]",
  eyebrow: "mono text-[10px] tracking-[.13em] text-[#678e89]",
  muted: "text-[#748285]",
  faint: "text-[#8b9697]",
  strong: "text-[#304548]",
  label: "mb-1.5 block text-[11px] font-bold text-[#526267]",
  divider: "border-t border-[#edf0eb]",
  // Buttons and form controls inherit their font from the parent (index.css
  // sets `font: inherit` outside Tailwind's layers, so text utilities on a
  // <button> or <select> are ignored). Sizes therefore go on an inner span,
  // or on the element around a form control.
  chip: "inline-flex min-h-[28px] items-center gap-1 rounded-full border border-[#dce4dd] bg-white px-2.5 py-1 text-[#4b5d60] hover:border-[#a9c9c4] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2d7470]",
  chipOn: "inline-flex min-h-[28px] items-center gap-1 rounded-full border border-[#3f817a] bg-[#e7f2ec] px-2.5 py-1 text-[#2f6d68] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2d7470]",
  chipText: "text-[11px] font-semibold leading-4",
  linkButton: "inline-flex min-h-[24px] items-center gap-1 rounded-lg px-1.5 text-[#34736d] hover:bg-[#eef5f1] disabled:opacity-40",
  linkText: "text-[11px] font-bold",
  iconButton: "grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-[#d8e4dd] bg-[#f4faf6] text-[#37746d] hover:bg-[#e5f2eb] disabled:opacity-40",
  bar: "h-2 overflow-hidden rounded-full bg-[#ebeeea]",
  barFill: "h-full rounded-full bg-[#4e9287] transition-[width] duration-500 ease-out motion-reduce:transition-none",
  numbers: "tabular-nums",
} as const;

export type Tone = "neutral" | "info" | "good" | "warn" | "bad";

const TONES: Record<Tone, string> = {
  neutral: "bg-[#eef0ed] text-[#5f6d6f]",
  info: "bg-[#e9f0f5] text-[#3f647a]",
  good: "bg-[#e4f2eb] text-[#2f6d5e]",
  warn: "bg-[#fff1dc] text-[#8a5f1c]",
  bad: "bg-[#fbe9e4] text-[#8f4a36]",
};

/** A small status label. The text always carries the meaning; colour only repeats it. */
export function Badge({ tone = "neutral", children, className = "" }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-bold ${TONES[tone]} ${className}`}>{children}</span>;
}

export function Notice({ tone = "info", title, children, action }: { tone?: Exclude<Tone, "neutral">; title?: string; children: ReactNode; action?: ReactNode }) {
  const styles: Record<Exclude<Tone, "neutral">, string> = {
    info: "border-[#cfe0db] bg-[#f2f9f6] text-[#3d6b66]",
    good: "border-[#c9dfd5] bg-[#f4fbf7] text-[#3d6b5c]",
    warn: "border-[#ecd9b8] bg-[#fff8ea] text-[#7a5a22]",
    bad: "border-[#eddcd4] bg-[#fffaf7] text-[#86493a]",
  };
  return (
    <div className={`rounded-[16px] border p-3.5 text-xs leading-5 ${styles[tone]}`} role={tone === "bad" ? "alert" : undefined}>
      {title && <strong className="mb-1 block text-[13px]">{title}</strong>}
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
        <label htmlFor={id} className="text-[11px] font-bold text-[#526267]">{label}</label>
        <span className={`text-[11px] font-semibold text-[#3f5a5c] ${ui.numbers}`} aria-hidden="true">{shown}</span>
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
        className="mt-1.5 h-6 w-full cursor-pointer accent-[#3f817a] disabled:cursor-not-allowed disabled:opacity-50"
      />
      {hint && <p className={`mt-0.5 text-[10px] leading-4 ${ui.faint}`}>{hint}</p>}
    </div>
  );
}
