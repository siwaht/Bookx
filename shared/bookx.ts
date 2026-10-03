import { z } from "zod";

export const projectSetupSchema = z.object({
  title: z.string().trim().min(1, "A project title is required").max(160),
  author: z.string().trim().max(120).optional(),
  kind: z.enum(["audiobook", "podcast"]),
  narrationStyle: z.enum(["single", "cast", "narrator-cast"]),
  voiceProvider: z.string().trim().min(1).max(80).default("ElevenLabs"),
  voiceModel: z.string().trim().min(1).max(160),
  languageModelProvider: z.string().trim().min(1).max(80).default("Cloudflare"),
  languageModel: z.string().trim().min(1).max(160).default("@cf/openai/gpt-oss-120b"),
  language: z.string().min(2).max(40),
  manuscriptName: z.string().max(255).optional(),
});

export type ProjectSetup = z.infer<typeof projectSetupSchema>;

/**
 * A partial project update. Built without the setup schema's defaults: with
 * them, `projectSetupSchema.partial()` filled in every omitted field, so
 * changing only the narration style reset the project's voice provider to
 * ElevenLabs and its language model to the Cloudflare default.
 */
export const projectUpdateSchema = z.object({
  title: z.string().trim().min(1, "A project title is required").max(160),
  author: z.string().trim().max(120),
  kind: z.enum(["audiobook", "podcast"]),
  narrationStyle: z.enum(["single", "cast", "narrator-cast"]),
  voiceProvider: z.string().trim().min(1).max(80),
  voiceModel: z.string().trim().min(1).max(160),
  languageModelProvider: z.string().trim().min(1).max(80),
  languageModel: z.string().trim().min(1).max(160),
  language: z.string().min(2).max(40),
  manuscriptName: z.string().max(255),
}).partial();

export function projectReadiness(input: {
  chapterCount: number;
  generatedChapters: number;
  hasCast: boolean;
  hasTimeline: boolean;
}) {
  const checks = [
    input.chapterCount > 0,
    input.generatedChapters === input.chapterCount && input.chapterCount > 0,
    input.hasCast,
    input.hasTimeline,
  ];
  return { completed: checks.filter(Boolean).length, total: checks.length, readyToExport: checks.every(Boolean) };
}
