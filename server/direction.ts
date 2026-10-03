import { createHash } from "node:crypto";
import type { SegmentDelivery } from "../drizzle/schema";
import { composeDirection, sceneDirection, ttsTraits, type ChapterDirection, type ComposedDirection, type SegmentDirectionSpec } from "../shared/direction";

/**
 * Server side of performance direction: working out each segment's direction
 * from its chapter, and fingerprinting what was sent so changed direction
 * marks exactly the affected audio as outdated.
 */

/**
 * The direction for every segment of one chapter, in order. Scenes are counted
 * from the chapter opening; every scene break starts the next one.
 */
export function chapterDirectionSpecs(
  direction: ChapterDirection | null | undefined,
  segments: Array<{ delivery?: SegmentDelivery | null }>,
): SegmentDirectionSpec[] {
  let scene = 0;
  return segments.map((segment, index) => {
    if (index > 0 && segment.delivery?.sceneBreakBefore) scene++;
    const sceneStart = index === 0 || Boolean(segment.delivery?.sceneBreakBefore);
    const { setting, mood } = sceneDirection(direction, scene);
    const lineTags = segment.delivery?.tags?.filter(tag => typeof tag === "string" && tag.trim()) ?? [];
    return { lineTags, setting, mood, sceneStart };
  });
}

/** Number of scenes in a chapter, for the direction editor. */
export function sceneCount(segments: Array<{ delivery?: SegmentDelivery | null }>): number {
  return 1 + segments.slice(1).filter(segment => segment.delivery?.sceneBreakBefore).length;
}

/** What this model receives for this segment. */
export function directionFor(spec: SegmentDirectionSpec | null | undefined, provider: string, model: string, standingInstructions?: string | null): ComposedDirection {
  return composeDirection(spec, ttsTraits(provider, model), standingInstructions);
}

/**
 * Hash of the direction sent with a segment; "" when nothing was sent, which
 * is also what audio from before direction existed counts as. A model that
 * ignores direction therefore never sees its audio go stale over it.
 */
export function directionHashFor(spec: SegmentDirectionSpec | null | undefined, provider: string, model: string, standingInstructions?: string | null): string {
  const { fingerprint } = directionFor(spec, provider, model, standingInstructions);
  return fingerprint ? createHash("sha256").update(fingerprint).digest("hex").slice(0, 32) : "";
}
