import { eq } from "drizzle-orm";
import { bookxProviderSettings } from "../drizzle/schema";
import { getDb } from "./db";
import { resolveProvider, type ProviderId } from "./providerRouting";
import { availableProviders, cloudflareHeaders, getCloudflareEndpoint, getOpenAiCompatibleBaseUrl, requireProviderApiKey } from "./providerCredentials";

/**
 * Language-model calls shared by casting, speaker attribution and scene analysis.
 *
 * Budget and deadline are sized for reasoning models, which are the norm on
 * Workers AI now: measured on `@cf/zai-org/glm-5.3-flash`, a 240-character
 * manuscript produced 14,000 characters of reasoning and took 56 seconds.
 */
export const LANGUAGE_MODEL_MAX_TOKENS = 16_384;
export const LANGUAGE_MODEL_TIMEOUT_MS = 180_000;

export type LanguageModelProvider = "Cloudflare" | "OpenAI" | "OpenRouter";

export type LanguageModelRequest = {
  provider: ProviderId;
  model: string;
  system: string;
  text: string;
  ownerId?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /**
   * Reasoning effort for models that accept it. Bulk analysis uses "low": on
   * gpt-oss-120b it answered a labelling prompt in 0.6 s instead of 2.6 s with
   * the same result.
   */
  reasoningEffort?: "low" | "medium" | "high";
};

/** Whether a model accepts `reasoning_effort` (gpt-oss on Workers AI). */
export function acceptsReasoningEffort(model: string): boolean {
  return /gpt-oss/i.test(model);
}

/** Pulls the JSON object out of a model reply, tolerating code fences and prose around it. */
export function extractJson(value: string, what = "structured answer"): unknown {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced?.trim().startsWith("{") ? fenced : value.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) throw new Error(`Language model did not return a ${what}`);
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    // Trailing commas are the most common defect in otherwise valid output.
    return JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1")) as unknown;
  }
}

export async function languageModelText(input: LanguageModelRequest): Promise<string> {
  const maxTokens = input.maxTokens ?? LANGUAGE_MODEL_MAX_TOKENS;
  const timeoutMs = input.timeoutMs ?? LANGUAGE_MODEL_TIMEOUT_MS;

  if (input.provider === "Cloudflare") {
    const endpoint = await getCloudflareEndpoint(input.ownerId);
    if (!endpoint) throw new Error("Cloudflare is not configured");
    // Native mode uses the Workers AI OpenAI-compatible chat endpoint; custom
    // endpoints (AI Gateway / proxies) expose `/chat/completions` directly.
    const url = endpoint.mode === "native" ? `${endpoint.apiBaseUrl}/v1/chat/completions` : `${endpoint.apiBaseUrl}/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      headers: cloudflareHeaders(endpoint),
      // Reasoning models (GLM, Kimi) emit a long `reasoning_content` that is billed
      // against the same completion budget as the answer. Measured against the
      // casting prompt, reasoning alone ran to ~3,400 tokens on a 240-character
      // manuscript, so a 4,096 ceiling left nothing for the JSON and returned an
      // empty `content`.
      body: JSON.stringify({
        model: input.model,
        max_tokens: maxTokens,
        messages: [{ role: "system", content: input.system }, { role: "user", content: input.text }],
        ...(input.reasoningEffort && acceptsReasoningEffort(input.model) ? { reasoning_effort: input.reasoningEffort } : {}),
      }),
      // Those same models took 56s for a short prompt, so the old 45s deadline
      // aborted calls that were about to succeed.
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Cloudflare language model request failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    const payload = await response.json() as {
      choices?: Array<{ finish_reason?: string; message?: { content?: string; reasoning_content?: string } }>;
      result?: { response?: string; text?: string };
    };
    const choice = payload.choices?.[0];
    const result = choice?.message?.content || payload.result?.response || payload.result?.text;
    if (!result) {
      // Distinguish "the model thought until it ran out of room" from "the model
      // said nothing", because the fix for the first one is a bigger budget or a
      // shorter excerpt, not a retry.
      if (choice?.finish_reason === "length" && choice.message?.reasoning_content) {
        throw new Error(`${input.model} used its entire ${maxTokens}-token budget on internal reasoning and returned no answer. Try a shorter excerpt or a non-reasoning model.`);
      }
      throw new Error("Cloudflare returned no model text");
    }
    return result;
  }

  if (input.provider === "OpenRouter") {
    return openRouterText(input, maxTokens, timeoutMs);
  }

  const openAiKey = await requireProviderApiKey("OpenAI", input.ownerId);
  const base = (await getOpenAiCompatibleBaseUrl(input.ownerId)) || "https://api.openai.com/v1";
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${openAiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: input.model, messages: [{ role: "system", content: input.system }, { role: "user", content: input.text }], temperature: 0.25, response_format: { type: "json_object" } }),
    signal: AbortSignal.timeout(Math.min(timeoutMs, 120_000)),
  });
  if (!response.ok) throw new Error(`OpenAI language model request failed with HTTP ${response.status}`);
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const result = payload.choices?.[0]?.message?.content;
  if (!result) throw new Error("OpenAI returned no model text");
  return result;
}

/**
 * OpenRouter and any OpenAI-compatible chat endpoint. OpenRouter exposes the
 * standard `/chat/completions` shape, so the same request works for it and for
 * a self-hosted gateway pointed at via the OpenAI base URL preference.
 */
async function openRouterText(input: LanguageModelRequest, maxTokens: number, timeoutMs: number): Promise<string> {
  const key = await requireProviderApiKey("OpenRouter", input.ownerId);
  const base = (await getOpenAiCompatibleBaseUrl(input.ownerId)) || "https://openrouter.ai/api/v1";
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: input.model,
      max_tokens: maxTokens,
      messages: [{ role: "system", content: input.system }, { role: "user", content: input.text }],
      temperature: 0.25,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(Math.min(timeoutMs, 180_000)),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`OpenRouter language model request failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const result = payload.choices?.[0]?.message?.content;
  if (!result) throw new Error("OpenRouter returned no model text");
  return result;
}

/**
 * Picks the language model for a task: the project's own choice when that
 * provider is connected, otherwise the first connected one.
 *
 * Returns `null` when no language model is available at all, so callers can
 * fall back to rule-based analysis instead of failing.
 */
export async function resolveLanguageModel(input: {
  ownerId: number;
  provider?: string | null;
  model?: string | null;
}): Promise<{ provider: LanguageModelProvider; model: string; fallback: boolean } | null> {
  const db = await getDb();
  const preferences = db ? await db.select().from(bookxProviderSettings).where(eq(bookxProviderSettings.ownerId, input.ownerId)) : [];
  const requested = (input.provider || preferences.find(preference => preference.defaultLlmModel)?.provider || "Cloudflare") as ProviderId;

  let routing: { provider: ProviderId; fallback: boolean };
  try {
    routing = resolveProvider(requested, "language-model", await availableProviders(input.ownerId, "language-model"));
  } catch {
    return null;
  }
  const provider: LanguageModelProvider = routing.provider === "OpenAI" ? "OpenAI" : routing.provider === "OpenRouter" ? "OpenRouter" : "Cloudflare";
  const preference = preferences.find(item => item.provider === provider);
  // A model id only makes sense for the provider it was chosen for.
  const model = (!routing.fallback && input.model) || preference?.defaultLlmModel || (provider === "Cloudflare" ? "@cf/openai/gpt-oss-120b" : provider === "OpenRouter" ? "openai/gpt-4o-mini" : "gpt-5");
  return { provider, model, fallback: routing.fallback };
}
