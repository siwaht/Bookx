import { eq } from "drizzle-orm";
import { bookxCharacters } from "../drizzle/schema";
import type { Db } from "./db";
import { assignVoices, type CastingSubject } from "./voiceAssignment";
import { voiceCatalogFor, type CatalogVoice } from "./voiceCatalog";

/**
 * Keeps a project's cast usable when the provider or model changes.
 *
 * A voice id belongs to one provider: ElevenLabs' `JBFqnCBsd6RMkjVDRZzb` means
 * nothing to Deepgram or Workers AI. Switching a project's provider therefore
 * left the whole cast pointing at voices the new provider had never heard of, and
 * every line failed with an error that looked like a malformed request — the
 * reason a book could not simply be re-narrated on a different provider.
 *
 * The check is against the provider's own catalog, which is its answer to "which
 * voices can I render?". Characters whose voice is missing from it are recast
 * from that catalog, matched on gender, age and description, while every voice
 * the provider does offer is locked and left exactly as the creator set it. The
 * caller reports each substitution, so a recast voice is never a silent change.
 */

export type CastRow = {
  id: string;
  name: string;
  voiceId: string | null;
  voiceName: string | null;
  gender?: string | null;
  ageGroup?: string | null;
  description?: string | null;
  isNarrator?: number | boolean | null;
  lineCount?: number | null;
};

export type RecastChange = { name: string; from: string | null; to: string };

/**
 * The characters a run cannot voice: no voice chosen yet, or a voice this
 * provider does not offer. An empty catalog judges nothing — it means the
 * provider's voices could not be listed, not that the cast is wrong.
 */
export function charactersNeedingRecast(rows: readonly CastRow[], catalog: readonly CatalogVoice[]): CastRow[] {
  if (!catalog.length) return [];
  const offered = new Set(catalog.map(voice => voice.id));
  return rows.filter(row => !row.voiceId || !offered.has(row.voiceId));
}

/** True when a catalog is the built-in starter list rather than a provider's own. */
export const isPlaceholderCatalog = (catalog: readonly CatalogVoice[]): boolean => catalog.some(voice => voice.starter);

export async function recastForProvider(db: Db, projectId: string, provider: string, ownerId: number): Promise<RecastChange[]> {
  const rows = await db.select().from(bookxCharacters).where(eq(bookxCharacters.projectId, projectId));
  if (!rows.length) return [];

  // The starter list is what the catalog falls back to when no key is configured.
  // It says nothing about what the provider offers, so it must not judge a voice.
  const catalog = await voiceCatalogFor(provider, ownerId).catch(() => [] as CatalogVoice[]);
  if (!catalog.length || isPlaceholderCatalog(catalog)) return [];

  const stale = charactersNeedingRecast(rows, catalog);
  if (!stale.length) return [];

  const offered = new Set(catalog.map(voice => voice.id));
  const subjects: CastingSubject[] = rows.map(row => ({
    key: row.id,
    name: row.name,
    isNarrator: Boolean(row.isNarrator),
    gender: row.gender,
    ageGroup: row.ageGroup,
    description: row.description,
    lineCount: row.lineCount,
    // Locking the voices the provider does offer is what keeps this surgical:
    // assignVoices then only casts the characters that have nothing usable.
    lockedVoiceId: row.voiceId && offered.has(row.voiceId) ? row.voiceId : null,
  }));
  const picks = assignVoices(subjects, catalog);

  const changes: RecastChange[] = [];
  for (const row of stale) {
    const pick = picks.get(row.id);
    if (!pick) continue;
    await db.update(bookxCharacters).set({
      voiceId: pick.voiceId,
      voiceName: pick.voiceName,
      voiceRationale: pick.rationale,
      assignmentConfidence: pick.confidence,
      assignmentSource: "auto",
      updatedAt: new Date(),
    }).where(eq(bookxCharacters.id, row.id));
    changes.push({ name: row.name, from: row.voiceName ?? row.voiceId ?? null, to: pick.voiceName });
  }
  return changes;
}