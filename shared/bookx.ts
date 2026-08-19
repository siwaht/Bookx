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
