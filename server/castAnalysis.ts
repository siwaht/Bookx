import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { bookxChapters, bookxCharacters, bookxProjects, bookxSegments, type SegmentDelivery } from "../drizzle/schema";
import { forEachChunk, getDb, projectChapterIds, runBatched } from "./db";
import { AnalysisReporter, claimAnalysisJob, runWithConcurrency } from "./analysisJobs";
import { extractJson, languageModelText, resolveLanguageModel } from "./languageModel";
import { ensureChapterSegments, includedChapters } from "./narrationWorker";
import { SPEECH_VERBS, attributeSpeakersHeuristically, buildNameIndex, mentionedCharacterIds, type AttributableUnit, type CastMember } from "./speakerAttribution";
import { hashUnitTexts } from "./textSegmentation";
import { assignVoices, type CastingSubject } from "./voiceAssignment";
import { voiceCatalogFor } from "./voiceCatalog";

/**
 * "Analyze the book": find who speaks, decide who says each line, and give
 * everyone a voice.
 *
 *  1. Split every included chapter so that quoted speech has its own segments.
 *  2. Find the cast across the *whole* book: speech-tag statistics from every
 *     chapter, then one language-model pass over dialogue samples from every
 *     chapter to merge aliases and describe each speaker (gender, age, manner).
 *  3. Attribute every quote to a speaker, chapter by chapter. The model sees
 *     numbered quotes and returns only ids -> names, so it never rewrites the
 *     text. Rules take over when no model is available or a call fails.
 *  4. Give every character without a creator-chosen voice a distinct default
 *     from the provider's real catalog.
 *
 * Every step is idempotent: chapters whose text has not changed since they were
 * attributed are skipped, and nothing the creator chose by hand is overwritten.
 */

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type CharacterRow = typeof bookxCharacters.$inferSelect;
type SegmentRow = typeof bookxSegments.$inferSelect;
type Llm = NonNullable<Awaited<ReturnType<typeof resolveLanguageModel>>>;

const DISCOVERY_EXCERPT_CHARS = 36_000;
const ATTRIBUTION_CHUNK_CHARS = 9_000;
const ATTRIBUTION_CONCURRENCY = 3;
const MAX_CAST = 60;

async function requireDb(): Promise<Db> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return db;
}

// ---------------------------------------------------------------------------
// Candidate names from speech tags
// ---------------------------------------------------------------------------

const NAME = "(?:(?:Mr|Mrs|Ms|Miss|Dr|Sir|Lady|Lord|Captain|Professor|Aunt|Uncle|Father|Mother)\\.?\\s+)?\\p{Lu}[\\p{L}'’-]+(?:\\s+\\p{Lu}[\\p{L}'’-]+)?";
const VERBS = SPEECH_VERBS.map(verb => verb.replace(/ /g, "\\s+")).join("|");
const NOT_NAMES = new Set([
  "he", "she", "they", "it", "i", "we", "you", "the", "a", "an", "then", "but", "and", "when", "as", "so", "what", "why", "how",
  "who", "where", "yes", "no", "oh", "well", "now", "there", "here", "this", "that", "his", "her", "its", "our", "their", "my",
  "your", "someone", "somebody", "everyone", "nobody", "one", "both", "all", "each", "mr", "mrs", "ms", "miss", "dr", "sir",
  "lady", "lord", "chapter", "part", "okay", "ok", "hello", "please", "thank", "thanks", "sorry", "god", "if", "not", "just",
]);

export type NameCandidate = { name: string; tagCount: number; mentions: number };

/** Names that appear next to speech verbs anywhere in the book, most frequent first. */
export function extractNameCandidates(texts: string[], limit = 80): NameCandidate[] {
  const tagAfter = new RegExp(`\\b(?:${VERBS})\\s+(${NAME})`, "gu");
  const tagBefore = new RegExp(`(${NAME})\\s+(?:\\p{L}+ly\\s+)?(?:${VERBS})\\b`, "gu");
  const counts = new Map<string, NameCandidate>();
  const bump = (raw: string, field: "tagCount" | "mentions") => {
    const name = raw.replace(/\s+/g, " ").trim();
    const first = name.split(" ")[0]!.replace(/\.$/, "").toLowerCase();
    if (NOT_NAMES.has(first) && name.split(" ").length === 1) return;
    if (NOT_NAMES.has(name.toLowerCase())) return;
    const entry = counts.get(name) ?? { name, tagCount: 0, mentions: 0 };
    entry[field]++;
    counts.set(name, entry);
  };
  for (const text of texts) {
    for (const match of text.matchAll(tagAfter)) bump(match[1]!, "tagCount");
    for (const match of text.matchAll(tagBefore)) bump(match[1]!, "tagCount");
  }
  // Mentions only for names already seen in a tag, so ordinary capitalised
  // words (sentence starts, places) never become characters on their own.
  for (const entry of counts.values()) {
    const pattern = new RegExp(`(?<![\\p{L}])${entry.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}(?![\\p{L}])`, "gu");
    for (const text of texts) entry.mentions += (text.match(pattern) ?? []).length;
  }
  return [...counts.values()]
    .sort((left, right) => right.tagCount - left.tagCount || right.mentions - left.mentions || left.name.localeCompare(right.name))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Cast discovery with a language model
// ---------------------------------------------------------------------------

const discoveredCastSchema = z.object({
  narrator: z.object({
    pointOfView: z.string().max(40).nullish(),
    name: z.string().max(160).nullish(),
    gender: z.string().max(24).nullish(),
    description: z.string().max(400).nullish(),
  }).partial().nullish(),
  characters: z.array(z.object({
    name: z.string().min(1).max(160),
    aliases: z.array(z.string().max(160)).max(12).nullish(),
    gender: z.string().max(24).nullish(),
    age: z.string().max(40).nullish(),
    description: z.string().max(400).nullish(),
    importance: z.string().max(20).nullish(),
  })).max(120),
});

export type DiscoveredCast = z.infer<typeof discoveredCastSchema>;

type ChapterText = { id: string; title: string; body: string };

/** Dialogue-bearing paragraphs from every chapter, so late arrivals are not missed. */
export function buildDiscoveryExcerpt(chapters: ChapterText[], budget = DISCOVERY_EXCERPT_CHARS): string {
  if (!chapters.length) return "";
  const opening = chapters[0]!.body.slice(0, 1_500);
  const perChapter = Math.max(600, Math.floor((budget - opening.length) / chapters.length));
  const parts = [`[Opening of the book]\n${opening}`];
  for (const chapter of chapters) {
    const paragraphs = chapter.body.split(/\n\s*\n+/).filter(paragraph => /[“”"«»„]|(^|\s)['‘]\p{Lu}/u.test(paragraph));
    let taken = "";
    for (const paragraph of paragraphs) {
      if (taken.length + paragraph.length > perChapter) break;
      taken += `${paragraph}\n`;
    }
    if (taken) parts.push(`[${chapter.title}]\n${taken.trim()}`);
  }
  return parts.join("\n\n").slice(0, budget);
}

export async function discoverCastWithModel(llm: Llm, input: { title: string; candidates: NameCandidate[]; excerpt: string; ownerId: number }): Promise<DiscoveredCast> {
  const candidateLines = input.candidates.map(candidate => `- ${candidate.name} (tagged as a speaker ${candidate.tagCount}x, named ${candidate.mentions}x)`).join("\n");
  const system = [
    "You are the casting director for a full-cast audiobook. From the dialogue excerpts and speaker statistics, list every character who SPEAKS in the book.",
    "Merge different names for the same person into one entry, with the other proper names as aliases. Use the name the book uses most as the main name.",
    "If a speaker is never named in the excerpts, give them the most specific name the text supports (for example \"Mrs. Bennet\" for Mr. Bennet's wife, or \"the innkeeper\"). Never use a phrase like \"his wife\" or \"she\" as a name or an alias, and never merge two different people.",
    "For each character give: gender (male, female or unknown), age (child, teen, young adult, adult, middle-aged or elderly), a one-line description of how they sound and behave (temperament, manner, any accent the text states), and importance (major or minor).",
    "Also describe the narrator: pointOfView is \"first\" if the story is told as \"I\", else \"third\"; for a first-person narrator give their name if the text reveals it, and their gender.",
    "Only include people who speak at least once; leave out people who are only mentioned.",
    'Return ONLY one JSON object: {"narrator":{"pointOfView":"third","name":"","gender":"unknown","description":""},"characters":[{"name":"","aliases":[],"gender":"","age":"","description":"","importance":"major"}]}',
  ].join("\n");
  const text = `Book: ${input.title}\n\nSpeaker statistics from the whole book:\n${candidateLines || "(none found)"}\n\nDialogue excerpts from across the book:\n${input.excerpt}`;
  const reply = await languageModelText({ provider: llm.provider, model: llm.model, system, text, ownerId: input.ownerId, reasoningEffort: "medium" });
  const parsed = discoveredCastSchema.parse(extractJson(reply, "cast list"));
  return { ...parsed, characters: parsed.characters.slice(0, MAX_CAST) };
}

/** Without a model: every name tagged as a speaker at least twice. */
export function castFromCandidates(candidates: NameCandidate[]): DiscoveredCast {
  return {
    narrator: { pointOfView: "third" },
    characters: candidates
      .filter(candidate => candidate.tagCount >= 2)
      .slice(0, MAX_CAST)
      .map(candidate => ({ name: candidate.name, aliases: [], importance: candidate.tagCount >= 10 ? "major" : "minor" })),
  };
}

// ---------------------------------------------------------------------------
// Persisting the cast
// ---------------------------------------------------------------------------

// Titles are kept when normalising: "Mr. Bennet" and "Mrs. Bennet" are different people.
const normalizeName = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();

/**
 * A model sometimes echoes the cast-list line ("Mr. Bennet (also: Bennet), male")
 * instead of the bare name. Keep just the name.
 */
export function cleanSpeakerName(raw: string): string {
  return raw
    .replace(/\s*\([^)]*\)/g, "")
    .split(/[,;|]/)[0]!
    .replace(/^["“”'‘’\s-]+|["“”'‘’\s.-]+$/g, "")
    .trim();
}

/** Aliases like "his wife" describe a relationship, not a name, and would merge two people. */
function isUsableAlias(alias: string): boolean {
  const trimmed = alias.trim();
  return trimmed.length >= 2 && trimmed.length <= 60 && !/^(his|her|their|its|my|your|our|he|she|they|him|them|i|me|you)\b/i.test(trimmed);
}

function namesOf(character: { name: string; aliases?: string[] | null }): Set<string> {
  return new Set([character.name, ...(character.aliases ?? [])].map(normalizeName).filter(Boolean));
}

const cleanGender = (value?: string | null) => {
  const lower = (value ?? "").toLowerCase();
  return lower.startsWith("f") ? "female" : lower.startsWith("m") ? "male" : null;
};

/**
 * Merges a discovered cast into the project's characters.
 *
 * Existing characters are matched by name or alias and only have their
 * descriptive fields filled in; their ids (which segments point at) and any
 * voice the creator chose are kept. Nobody is deleted.
 */
export async function upsertCast(db: Db, projectId: string, discovered: DiscoveredCast): Promise<CharacterRow[]> {
  const existing = await db.select().from(bookxCharacters).where(eq(bookxCharacters.projectId, projectId));
  const narratorInfo = discovered.narrator ?? {};
  const firstPerson = /^first/i.test(narratorInfo.pointOfView ?? "");

  let narrator = existing.find(character => character.isNarrator) ?? existing.find(character => /^narrator$/i.test(character.role) || /^narrator$/i.test(character.name));
  const narratorAliases = firstPerson && narratorInfo.name ? [narratorInfo.name] : [];
  if (!narrator) {
    const id = nanoid();
    await db.insert(bookxCharacters).values({
      id,
      projectId,
      name: "Narrator",
      role: "Narrator",
      isNarrator: 1,
      gender: cleanGender(narratorInfo.gender),
      aliases: narratorAliases,
      description: narratorInfo.description?.slice(0, 500) || (firstPerson ? "First-person narrator" : "Third-person narrator"),
      assignmentSource: "auto",
    });
  } else {
    await db.update(bookxCharacters).set({
      isNarrator: 1,
      gender: narrator.gender ?? cleanGender(narratorInfo.gender),
      aliases: [...new Set([...(narrator.aliases ?? []), ...narratorAliases])],
      description: narrator.description ?? (narratorInfo.description?.slice(0, 500) || null),
      updatedAt: new Date(),
    }).where(eq(bookxCharacters.id, narrator.id));
  }

  const refreshed = await db.select().from(bookxCharacters).where(eq(bookxCharacters.projectId, projectId));
  narrator = refreshed.find(character => character.isNarrator)!;
  const narratorNames = namesOf({ name: narrator.name, aliases: narrator.aliases });

  for (const discoveredCharacter of discovered.characters) {
    const cleanedName = cleanSpeakerName(discoveredCharacter.name);
    if (!cleanedName || !isUsableAlias(cleanedName)) continue;
    const character = { ...discoveredCharacter, name: cleanedName, aliases: (discoveredCharacter.aliases ?? []).map(cleanSpeakerName).filter(isUsableAlias) };
    const names = namesOf({ name: character.name, aliases: character.aliases ?? [] });
    // A first-person narrator is not a separate part: their lines are the narrator's.
    if ([...names].some(name => narratorNames.has(name))) continue;
    const match = refreshed.find(row => !row.isNarrator && [...namesOf(row)].some(name => names.has(name)));
    const aliases = [...new Set([...(character.aliases ?? []), character.name])].filter(alias => alias.trim()).slice(0, 12);
    if (match) {
      await db.update(bookxCharacters).set({
        gender: match.gender ?? cleanGender(character.gender),
        ageGroup: match.ageGroup ?? (character.age?.slice(0, 24) || null),
        aliases: [...new Set([...(match.aliases ?? []), ...aliases.filter(alias => normalizeName(alias) !== normalizeName(match.name))])].slice(0, 16),
        description: match.description ?? (character.description?.slice(0, 500) || null),
        updatedAt: new Date(),
      }).where(eq(bookxCharacters.id, match.id));
      continue;
    }
    const row = {
      id: nanoid(),
      projectId,
      name: character.name.slice(0, 160),
      role: /^major/i.test(character.importance ?? "") ? "Main character" : "Supporting character",
      gender: cleanGender(character.gender),
      ageGroup: character.age?.slice(0, 24) || null,
      aliases: aliases.filter(alias => normalizeName(alias) !== normalizeName(character.name)),
      description: character.description?.slice(0, 500) || null,
      assignmentSource: "auto" as const,
    };
    await db.insert(bookxCharacters).values(row);
    refreshed.push({ ...row, voiceId: null, voiceName: null, accent: null, voiceRationale: null, sampleLine: null, previewStorageKey: null, assignmentConfidence: null, isNarrator: 0, lineCount: 0, createdAt: new Date(), updatedAt: new Date() });
  }

  return db.select().from(bookxCharacters).where(eq(bookxCharacters.projectId, projectId));
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

/** The chapter as the model sees it: numbered quotes, plain narration. */
export function renderForAttribution(segments: SegmentRow[]): { chunks: Array<{ text: string; quoteIds: string[] }>; quoteToSegment: Map<string, string> } {
  const quoteToSegment = new Map<string, string>();
  type Paragraph = { marked: string; plain: string; quoteIds: string[] };
  const paragraphs: Paragraph[] = [];
  let current: Paragraph | null = null;
  let currentIndex: number | null = null;
  let quoteNumber = 0;

  for (const segment of segments) {
    const paragraph = segment.delivery?.paragraph ?? -1;
    if (!current || paragraph !== currentIndex || paragraph < 0) {
      current = { marked: "", plain: "", quoteIds: [] };
      paragraphs.push(current);
      currentIndex = paragraph;
    }
    if (segment.delivery?.kind === "dialogue") {
      const id = `Q${++quoteNumber}`;
      quoteToSegment.set(id, segment.id);
      current.quoteIds.push(id);
      current.marked += `${current.marked ? " " : ""}[${id}] ${segment.text}`;
    } else {
      current.marked += `${current.marked ? " " : ""}${segment.text}`;
    }
    current.plain += `${current.plain ? " " : ""}${segment.text}`;
  }

  // Chunks of whole paragraphs. Each chunk after the first opens with the last
  // two paragraphs before it, unmarked, so a conversation that straddles the
  // boundary keeps its turn-taking.
  const chunks: Array<{ text: string; quoteIds: string[] }> = [];
  let currentChunk: Paragraph[] = [];
  let size = 0;
  let context: Paragraph[] = [];
  const emit = () => {
    if (currentChunk.some(paragraph => paragraph.quoteIds.length)) {
      const lead = context.length
        ? `(Earlier text, for context only; do not label it:)\n${context.map(paragraph => paragraph.plain).join("\n\n")}\n\n(Label the quotes below:)\n`
        : "";
      chunks.push({ text: `${lead}${currentChunk.map(paragraph => paragraph.marked).join("\n\n")}`, quoteIds: currentChunk.flatMap(paragraph => paragraph.quoteIds) });
    }
    context = currentChunk.slice(-2);
    currentChunk = [];
    size = 0;
  };
  for (const paragraph of paragraphs) {
    if (currentChunk.length && size + paragraph.marked.length > ATTRIBUTION_CHUNK_CHARS) emit();
    currentChunk.push(paragraph);
    size += paragraph.marked.length + 2;
  }
  if (currentChunk.length) emit();
  return { chunks, quoteToSegment };
}

const attributionSchema = z.object({ speakers: z.record(z.string(), z.string().max(160)) });

async function attributeChunkWithModel(llm: Llm, input: { chunk: string; castList: string; narratorLine: string; ownerId: number }): Promise<Record<string, string>> {
  const system = [
    "You identify who speaks each quotation in an excerpt of a novel. Quotes are marked [Q1], [Q2], …",
    `Characters:\n${input.castList}`,
    input.narratorLine,
    "Rules:",
    "1. Return ONLY JSON: {\"speakers\":{\"Q1\":\"Name\",\"Q2\":\"Name\"}} with an entry for EVERY quote id in the excerpt.",
    "2. Reply with the bare name exactly as listed above (without the alias list or gender).",
    "3. All quotations in one paragraph are spoken by the same person, even when a dialogue tag sits between them (\"“Yes,” said Ann, “now.”\" is two quotes by Ann).",
    "4. Use \"Narrator\" when the narrator speaks, or when the quoted words are not speech (a sign, a title, a remembered phrase).",
    "5. If the speaker is someone not in the list, give the most specific name the text supports (for example \"the innkeeper\"), never a pronoun.",
    "6. Use \"Unknown\" only when the speaker cannot be worked out. Dialogue tags, action beats and turn-taking are the clues; in an untagged exchange speakers alternate.",
  ].join("\n");
  const reply = await languageModelText({ provider: llm.provider, model: llm.model, system, text: input.chunk, ownerId: input.ownerId, reasoningEffort: "low" });
  return attributionSchema.parse(extractJson(reply, "speaker list")).speakers;
}

function toUnits(segments: SegmentRow[]): AttributableUnit[] {
  return segments.map((segment, index) => ({
    text: segment.text,
    kind: segment.delivery?.kind === "dialogue" ? "dialogue" : "narration",
    // Segments from before dialogue splitting carry no paragraph index; each is
    // then its own paragraph, in order.
    paragraph: segment.delivery?.paragraph ?? index,
    continuesQuote: segment.delivery?.continuesQuote,
  }));
}

/**
 * One paragraph, one speaker. When the model splits a paragraph's quotes
 * between people but the paragraph's own narration names exactly one of them
 * ("…,” said Mira Solen, crouching beside him. “…”), every quote goes to them.
 */
export function applyParagraphConsensus(
  segments: SegmentRow[],
  assignments: Map<string, string | null>,
  index: ReturnType<typeof buildNameIndex>,
): void {
  const paragraphs = new Map<number, SegmentRow[]>();
  for (const segment of segments) {
    const paragraph = segment.delivery?.paragraph;
    if (paragraph === undefined || paragraph < 0) continue;
    const list = paragraphs.get(paragraph) ?? [];
    list.push(segment);
    paragraphs.set(paragraph, list);
  }
  for (const members of paragraphs.values()) {
    const quotes = members.filter(segment => segment.delivery?.kind === "dialogue" && assignments.has(segment.id));
    const speakers = new Set(quotes.map(segment => assignments.get(segment.id) ?? null));
    if (quotes.length < 2 || speakers.size < 2) continue;
    const named = new Set<string>();
    for (const segment of members) {
      if (segment.delivery?.kind === "dialogue") continue;
      for (const id of mentionedCharacterIds(segment.text, index)) named.add(id);
    }
    const candidates = [...speakers].filter((speaker): speaker is string => Boolean(speaker) && named.has(speaker!));
    if (candidates.length === 1) for (const quote of quotes) assignments.set(quote.id, candidates[0]!);
  }
}

function castMembers(characters: CharacterRow[]): CastMember[] {
  return characters.map(character => ({ id: character.id, name: character.name, aliases: character.aliases, gender: character.gender, isNarrator: character.isNarrator }));
}

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

/**
 * Gives every character without a creator-chosen voice a distinct default from
 * the project's provider catalog. Returns how many were (re)assigned.
 */
export async function assignProjectVoices(db: Db, projectId: string, ownerId: number): Promise<number> {
  const [project] = await db.select().from(bookxProjects).where(eq(bookxProjects.id, projectId)).limit(1);
  if (!project) throw new Error("Project not found");
  const characters = await db.select().from(bookxCharacters).where(eq(bookxCharacters.projectId, projectId));
  if (!characters.length) return 0;

  const catalog = await voiceCatalogFor(project.voiceProvider, ownerId);
  const subjects: CastingSubject[] = characters.map(character => ({
    key: character.id,
    name: character.name,
    isNarrator: Boolean(character.isNarrator),
    gender: character.gender,
    ageGroup: character.ageGroup,
    description: character.description,
    lineCount: character.lineCount,
    lockedVoiceId: character.assignmentSource === "manual" && character.voiceId ? character.voiceId : null,
  }));
  const picks = assignVoices(subjects, catalog);

  let changed = 0;
  for (const character of characters) {
    const pick = picks.get(character.id);
    if (!pick || pick.locked) continue;
    const voice = catalog.find(candidate => candidate.id === pick.voiceId);
    await db.update(bookxCharacters).set({
      voiceId: pick.voiceId,
      voiceName: pick.voiceName,
      voiceRationale: pick.rationale,
      assignmentConfidence: pick.confidence,
      accent: voice?.accent ?? voice?.description.split("·")[0]?.trim() ?? null,
      assignmentSource: "auto",
      updatedAt: new Date(),
    }).where(eq(bookxCharacters.id, character.id));
    changed++;
  }
  return changed;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export async function startCastAnalysis(input: { projectId: string; ownerId: number; force?: boolean }): Promise<{ jobId: string; reused: boolean }> {
  const claimed = await claimAnalysisJob(input.projectId, "cast", "Queued: reading the book to find the cast");
  if (!claimed.reused) {
    void runCastAnalysis(claimed.jobId, input).catch(error => console.error("[Cast] Analysis crashed:", error));
  }
  return claimed;
}

async function runCastAnalysis(jobId: string, input: { projectId: string; ownerId: number; force?: boolean }): Promise<void> {
  const db = await requireDb();
  const reporter = await AnalysisReporter.open(jobId);
  try {
    const [project] = await db.select().from(bookxProjects).where(and(eq(bookxProjects.id, input.projectId), eq(bookxProjects.ownerId, input.ownerId))).limit(1);
    if (!project) throw new Error("Project not found");
    const multiVoice = project.narrationStyle !== "single";

    await reporter.start(3, "Splitting chapters into narration and dialogue");
    await ensureChapterSegments({ projectId: input.projectId, model: project.voiceModel });

    const chapters = (await includedChapters(db, input.projectId)).filter(chapter => chapter.body?.trim());
    if (!chapters.length) {
      await reporter.finish("failed", "No chapters are selected for the audiobook yet. Import or write the manuscript first.");
      return;
    }
    const withText = new Set(chapters.map(chapter => chapter.id));
    const loadSegments = async () => (await db.select().from(bookxSegments)
      .where(inArray(bookxSegments.chapterId, projectChapterIds(db, input.projectId, { includedOnly: true })))
      .orderBy(bookxSegments.orderIndex))
      .filter(segment => withText.has(segment.chapterId));
    const segments = await loadSegments();
    const byChapter = new Map<string, SegmentRow[]>();
    for (const segment of segments) {
      const list = byChapter.get(segment.chapterId) ?? [];
      list.push(segment);
      byChapter.set(segment.chapterId, list);
    }

    const toAttribute = multiVoice
      ? chapters.filter(chapter => {
          const own = byChapter.get(chapter.id) ?? [];
          return own.some(segment => segment.delivery?.kind === "dialogue") &&
            (input.force || chapter.attributionHash !== hashUnitTexts(own.map(segment => segment.text)));
        })
      : [];
    const totalSteps = 2 + toAttribute.length;
    await reporter.setTotal(totalSteps);

    // ---- 1. Who is in the book --------------------------------------------
    await reporter.progress(0, `Finding the speaking characters across ${chapters.length} chapter${chapters.length === 1 ? "" : "s"}`);
    const texts = chapters.map(chapter => chapter.body ?? "");
    const candidates = extractNameCandidates(texts);
    const llm = await resolveLanguageModel({ ownerId: input.ownerId, provider: project.languageModelProvider, model: project.languageModel });

    let discovered: DiscoveredCast;
    if (llm) {
      try {
        discovered = await discoverCastWithModel(llm, {
          title: project.title,
          candidates,
          excerpt: buildDiscoveryExcerpt(chapters.map(chapter => ({ id: chapter.id, title: chapter.title, body: chapter.body ?? "" }))),
          ownerId: input.ownerId,
        });
        await reporter.event("cast", `${llm.model} found ${discovered.characters.length} speaking character(s).`);
      } catch (error) {
        discovered = castFromCandidates(candidates);
        await reporter.event("warning", `The language model could not list the cast (${error instanceof Error ? error.message : "unknown error"}); used speech-tag statistics instead.`);
      }
    } else {
      discovered = castFromCandidates(candidates);
      await reporter.event("warning", "No language model is connected, so the cast comes from speech-tag statistics and speakers from rules.");
    }
    let characters = await upsertCast(db, input.projectId, discovered);
    reporter.setSummary({ characters: characters.filter(character => !character.isNarrator).length });
    await reporter.progress(1, `Cast of ${characters.length - 1} found. Deciding who says each line…`);

    // ---- 2. Who says each line ---------------------------------------------
    if (multiVoice && toAttribute.length) {
      let completed = 0;
      let attributedLines = 0;
      let lock: Promise<unknown> = Promise.resolve();
      const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
        const run = lock.then(fn, fn);
        lock = run.catch(() => undefined);
        return run;
      };

      await runWithConcurrency(toAttribute, llm ? ATTRIBUTION_CONCURRENCY : 1, async chapter => {
        if (await reporter.cancelled()) return;
        const own = byChapter.get(chapter.id) ?? [];
        const narrator = characters.find(character => character.isNarrator);
        const assignments = new Map<string, string | null>(); // segmentId -> characterId (null = narrator)
        let source: SegmentDelivery["speakerSource"] = "heuristic";

        if (llm) {
          try {
            const { chunks, quoteToSegment } = renderForAttribution(own);
            const people = characters.filter(character => !character.isNarrator);
            const castList = people.map(character => `- ${character.name}${character.aliases?.length ? ` (also: ${character.aliases.join(", ")})` : ""}${character.gender ? `, ${character.gender}` : ""}`).join("\n") || "- (no named characters yet)";
            const narratorLine = narrator?.aliases?.length
              ? `The narrator speaks in the first person and is called ${narrator.aliases.join(" / ")}; their own lines are "Narrator".`
              : "The narrator tells the story; quotes are spoken by characters.";
            for (const chunk of chunks) {
              const speakers = await attributeChunkWithModel(llm, { chunk: chunk.text, castList, narratorLine, ownerId: input.ownerId });
              let index = buildNameIndex(castMembers(characters));
              for (const quoteId of chunk.quoteIds) {
                const name = cleanSpeakerName(speakers[quoteId] ?? "");
                const segmentId = quoteToSegment.get(quoteId);
                if (!segmentId || !name || /^unknown$/i.test(name)) continue;
                if (/^narrator$/i.test(name) || (narrator && namesOf(narrator).has(normalizeName(name)))) {
                  assignments.set(segmentId, narrator?.id ?? null);
                  continue;
                }
                let id = index.lookup.get(name.toLowerCase()) ?? characters.find(character => namesOf(character).has(normalizeName(name)))?.id;
                if (!id && isUsableAlias(name)) {
                  // Someone the cast list missed: add them as a minor part.
                  id = await withLock(async () => {
                    const again = characters.find(character => namesOf(character).has(normalizeName(name)));
                    if (again) return again.id;
                    const newId = nanoid();
                    await db.insert(bookxCharacters).values({ id: newId, projectId: input.projectId, name: name.slice(0, 160), role: "Minor character", assignmentSource: "auto" });
                    characters = await db.select().from(bookxCharacters).where(eq(bookxCharacters.projectId, input.projectId));
                    return newId;
                  });
                  index = buildNameIndex(castMembers(characters));
                }
                if (id) assignments.set(segmentId, id);
              }
            }
            applyParagraphConsensus(own, assignments, buildNameIndex(castMembers(characters)));
            source = "llm";
          } catch (error) {
            assignments.clear();
            await reporter.event("warning", `${chapter.title}: model attribution failed (${error instanceof Error ? error.message.slice(0, 120) : "unknown error"}); used rules instead.`);
          }
        }

        if (source === "heuristic") {
          const guesses = attributeSpeakersHeuristically(toUnits(own), castMembers(characters));
          own.forEach((segment, index) => {
            if (segment.delivery?.kind === "dialogue") assignments.set(segment.id, guesses[index] ?? null);
          });
        }

        // One round trip per few dozen lines rather than one per line.
        const writes = [];
        for (const segment of own) {
          if (segment.delivery?.kind !== "dialogue") continue;
          if (segment.delivery?.speakerSource === "manual") continue; // the creator decided
          if (!assignments.has(segment.id)) continue;
          const characterId = assignments.get(segment.id) ?? null;
          if (segment.characterId === characterId && segment.delivery?.speakerSource === source) continue;
          writes.push(db.update(bookxSegments).set({ characterId, delivery: { ...(segment.delivery ?? {}), speakerSource: source }, updatedAt: new Date() }).where(eq(bookxSegments.id, segment.id)));
          if (characterId) attributedLines++;
        }
        writes.push(db.update(bookxChapters).set({ attributionHash: hashUnitTexts(own.map(segment => segment.text)), updatedAt: new Date() }).where(eq(bookxChapters.id, chapter.id)));
        await runBatched(db, writes);

        completed++;
        await reporter.progress(1 + completed, `Attributed dialogue in ${completed} of ${toAttribute.length} chapter${toAttribute.length === 1 ? "" : "s"} (${chapter.title})`);
      });
      reporter.setSummary({ attributedLines, chaptersAttributed: completed });

      if (await reporter.cancelled()) {
        await reporter.finish("cancelled", `Stopped after ${completed} chapter(s). Finished chapters keep their speakers.`);
        return;
      }
    }

    // ---- 3. Line counts, sample lines and voices ------------------------------
    await reporter.progress(totalSteps - 1, "Choosing a distinct voice for every character");
    const allSegments = await loadSegments();
    const chapterOrder = new Map(chapters.map(chapter => [chapter.id, chapter.orderIndex]));
    allSegments.sort((left, right) => (chapterOrder.get(left.chapterId) ?? 0) - (chapterOrder.get(right.chapterId) ?? 0) || left.orderIndex - right.orderIndex);
    characters = await db.select().from(bookxCharacters).where(eq(bookxCharacters.projectId, input.projectId));
    if (multiVoice) {
      // People the discovery listed who never actually speak (only mentioned)
      // are removed again, unless the creator added or cast them by hand.
      const speaking = new Set(allSegments.map(segment => segment.characterId).filter(Boolean));
      const silent = characters.filter(character => !character.isNarrator && character.assignmentSource === "auto" && !speaking.has(character.id));
      if (silent.length) {
        await forEachChunk(silent.map(character => character.id), part => db.delete(bookxCharacters).where(inArray(bookxCharacters.id, part)));
        characters = characters.filter(character => !silent.includes(character));
      }
    }
    await runBatched(db, characters.map(character => {
      const lines = allSegments.filter(segment => segment.delivery?.kind === "dialogue" && segment.characterId === character.id);
      const sample = character.isNarrator
        ? allSegments.find(segment => segment.delivery?.kind !== "dialogue" && segment.text.length >= 60)?.text
        : lines.find(segment => segment.text.length >= 20)?.text ?? lines[0]?.text;
      return db.update(bookxCharacters).set({
        lineCount: character.isNarrator ? allSegments.filter(segment => segment.delivery?.kind !== "dialogue" || !segment.characterId).length : lines.length,
        sampleLine: character.sampleLine || (sample ? sample.slice(0, 280) : null),
        updatedAt: new Date(),
      }).where(eq(bookxCharacters.id, character.id));
    }));

    const voiced = await assignProjectVoices(db, input.projectId, input.ownerId);
    reporter.setSummary({ voicesAssigned: voiced });
    const speaking = characters.filter(character => !character.isNarrator).length;
    await reporter.progress(totalSteps, "Done");
    await reporter.finish(
      "completed",
      multiVoice
        ? `Found ${speaking} character${speaking === 1 ? "" : "s"}, attributed the dialogue and assigned ${voiced} voice${voiced === 1 ? "" : "s"}.`
        : `Found ${speaking} character${speaking === 1 ? "" : "s"} and chose the narrator's voice. Switch to "Narrator + cast" for characters to speak in their own voices.`,
    );
  } catch (error) {
    console.error("[Cast] Analysis failed:", error);
    await reporter.finish("failed", error instanceof Error ? error.message : "Cast analysis failed").catch(() => reporter.release());
  }
}
