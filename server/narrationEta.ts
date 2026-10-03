/**
 * Time left on a narration run, from how fast it has actually been going.
 *
 * Every rendered segment records when it finished, so the run's real pace is
 * the time between consecutive finishes over the characters each one voiced.
 * Long gaps (a pause, a stall, a closed laptop) are left out, which keeps a
 * resumed run from looking hours slower than it is.
 */

/** Gaps longer than this are a pause or a stall, not rendering. */
export const ETA_GAP_MS = 3 * 60_000;
/** The pace is taken from the most recent segments only. */
const RECENT_SAMPLES = 30;
/** Fewer samples than this give no estimate yet. */
export const ETA_MIN_SAMPLES = 3;

export type EtaSegment = { rendered: boolean; renderedAt: Date | string | null; characters: number };

export type NarrationEta = {
  remainingMs: number | null;
  msPerCharacter: number | null;
  samples: number;
  /** Time spent actually rendering in this run, pauses excluded. */
  activeElapsedMs: number;
  remainingCharacters: number;
};

export function narrationEta(input: { segments: EtaSegment[]; startedAt: Date | string | null; now: number; active: boolean }): NarrationEta {
  const since = input.startedAt ? new Date(input.startedAt).getTime() : null;
  const remainingCharacters = input.segments.filter(segment => !segment.rendered).reduce((total, segment) => total + Math.max(0, segment.characters), 0);

  const finished = input.segments
    .filter(segment => segment.rendered && segment.renderedAt)
    .map(segment => ({ at: new Date(segment.renderedAt!).getTime(), characters: Math.max(1, segment.characters) }))
    .filter(entry => Number.isFinite(entry.at) && (since === null || entry.at >= since))
    .sort((left, right) => left.at - right.at);

  const samples: Array<{ ms: number; characters: number }> = [];
  let previous = since;
  let activeElapsedMs = 0;
  for (const entry of finished) {
    if (previous !== null) {
      const gap = entry.at - previous;
      if (gap > 0 && gap <= ETA_GAP_MS) {
        samples.push({ ms: gap, characters: entry.characters });
        activeElapsedMs += gap;
      }
    }
    previous = entry.at;
  }
  // The segment in flight counts as rendering time once the run is active.
  if (input.active && previous !== null) {
    const inFlight = input.now - previous;
    if (inFlight > 0 && inFlight <= ETA_GAP_MS) activeElapsedMs += inFlight;
  }

  const recent = samples.slice(-RECENT_SAMPLES);
  const ms = recent.reduce((total, sample) => total + sample.ms, 0);
  const characters = recent.reduce((total, sample) => total + sample.characters, 0);
  const msPerCharacter = recent.length >= ETA_MIN_SAMPLES && characters > 0 ? ms / characters : null;
  return {
    remainingMs: msPerCharacter === null ? null : Math.round(remainingCharacters * msPerCharacter),
    msPerCharacter,
    samples: recent.length,
    activeElapsedMs: Math.round(activeElapsedMs),
    remainingCharacters,
  };
}
