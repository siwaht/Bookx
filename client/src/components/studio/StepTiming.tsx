import { useEffect, useState } from "react";
import { formatClock } from "@shared/narration";

/**
 * "Step 3 of 12 · 1m 05s so far · about 4m left" for a background job that
 * reports steps (casting, scene planning, sound preparation). The estimate is
 * the average time per finished step, so it appears after the first step.
 */
export function StepTiming({ run }: { run: { totalSteps?: number; completedSteps?: number; startedAt?: string | null } }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const total = run.totalSteps ?? 0;
  const done = run.completedSteps ?? 0;
  const started = run.startedAt ? new Date(run.startedAt).getTime() : null;
  const elapsed = started ? Math.max(0, now - started) : null;
  const left = elapsed !== null && done > 0 && total > done ? (elapsed / done) * (total - done) : null;
  if (!total && elapsed === null) return null;
  return (
    <span className="mt-0.5 block text-2xs tabular-nums text-ink-500">
      {total > 0 && `Step ${Math.min(total, done + 1)} of ${total}`}
      {elapsed !== null && ` · ${formatClock(elapsed)} so far`}
      {left !== null ? ` · about ${formatClock(left)} left` : total > 0 && done === 0 ? " · estimating…" : ""}
    </span>
  );
}
