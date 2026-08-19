import { nanoid } from "nanoid";
import { storagePut } from "./storage";
import { resolveProvider, type ProviderId } from "./providerRouting";

export type TtsProvider = ProviderId;

export function validateNarrationRequest(input: { provider: TtsProvider; projectId?: string; text: string; voiceId?: string; model?: string; language?: string }) {
  const text = input.text.trim();
  if (!text) throw new Error("Narration text is required");
  if (text.length > 4_000) throw new Error("Narration requests are limited to 4,000 characters per clip");
  return { ...input, text, voiceId: input.voiceId?.trim() || undefined };
}

export async function synthesizeNarration(input: { provider: TtsProvider; projectId: string; text: string; voiceId?: string; model?: string; language?: string }): Promise<{ clipId: string; storageKey: string; audioUrl: string; provider: TtsProvider; fallback: boolean }> {
  const request = validateNarrationRequest(input);
  if (!request.projectId) throw new Error("A project is required to store generated narration");
  const resolved = resolveProvider(request.provider, "text-to-speech");
  const provider = resolved.provider;
  const response = provider === "ElevenLabs"
    ? await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${request.voiceId || "21m00Tcm4TlvDq8ikWAM"}`, {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY || "", "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text: request.text, model_id: request.model || "eleven_multilingual_v2", voice_settings: { stability: 0.45, similarity_boost: 0.75 } }),
    })
    : provider === "Deepgram"
      ? await fetch(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(request.model || "aura-2-thalia-en")}`, {
        method: "POST",
        headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY || ""}`, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text: request.text }),
      })
      : provider === "Cloudflare"
        ? await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID || ""}/ai/run/${request.model || "@cf/myshell-ai/melotts"}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN || ""}`, "content-type": "application/json" },
          body: JSON.stringify({ prompt: request.text, lang: request.language || "en" }),
        })
        : await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY || ""}`, "content-type": "application/json" },
      body: JSON.stringify({ model: request.model || "gpt-4o-mini-tts", voice: request.voiceId || "alloy", input: request.text, response_format: "mp3" }),
    });

  if (!response.ok) {
    const candidates: TtsProvider[] = ["ElevenLabs", "Deepgram", "OpenAI", "Cloudflare"];
    for (const candidate of candidates) {
      if (candidate === provider) continue;
      try {
        const fallbackResult = await synthesizeNarration({ ...request, projectId: request.projectId!, provider: candidate });
        return { ...fallbackResult, fallback: true };
      } catch {
        // Continue to the next configured route; the final error keeps the original provider context.
      }
    }
    throw new Error(`${provider} narration failed with HTTP ${response.status}; no configured runtime fallback completed`);
  }

  const contentType = response.headers.get("content-type") || "";
  const responseBody = contentType.includes("application/json") ? await response.json() as { result?: { audio?: string } | string } : null;
  const base64Audio = typeof responseBody?.result === "string" ? responseBody.result : responseBody?.result?.audio;
  const buffer = base64Audio ? Buffer.from(base64Audio, "base64") : Buffer.from(await response.arrayBuffer());
  const clipId = nanoid();
  const stored = await storagePut(`bookx/${request.projectId}/narration/${clipId}.mp3`, buffer, "audio/mpeg");
  return { clipId, storageKey: stored.key, audioUrl: stored.url, provider, fallback: resolved.fallback };
}
