import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type {
  ElevenLabsCapabilities,
  ElevenLabsModel,
  ElevenLabsVoice,
  TTSRequest,
  SFXRequest,
  VoiceSettings,
} from '../types/index.js';

const API_BASE = 'https://api.elevenlabs.io/v1';
const DATA_DIR = process.env.DATA_DIR || './data';

function getApiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY not set');
  return key;
}

function headers(): Record<string, string> {
  return {
    'xi-api-key': getApiKey(),
    'Content-Type': 'application/json',
  };
}

// ── Retry with backoff ──

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);

    if (res.ok) return res;

    if (res.status === 429 || res.status >= 500) {
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
        console.log(`[ElevenLabs] Retry ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms (status ${res.status})`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
    }

    const errorBody = await res.text().catch(() => 'Unknown error');
    throw new Error(`ElevenLabs API error ${res.status}: ${errorBody}`);
  }

  throw new Error('Max retries exceeded');
}

// ── Capability Detection ──

let cachedCapabilities: ElevenLabsCapabilities | null = null;
let capabilitiesCachedAt = 0;
const CAPABILITIES_TTL = 30 * 60 * 1000; // 30 min

export async function getCapabilities(): Promise<ElevenLabsCapabilities> {
  if (cachedCapabilities && Date.now() - capabilitiesCachedAt < CAPABILITIES_TTL) {
    return cachedCapabilities;
  }

  const res = await fetchWithRetry(`${API_BASE}/models`, { headers: headers() });
  const models: ElevenLabsModel[] = await res.json() as ElevenLabsModel[];

  const ttsModels = models.filter((m) => m.can_do_text_to_speech);
  const modelIds = ttsModels.map((m) => m.model_id);

  const hasV3 = modelIds.includes('eleven_v3');
  const hasDialogue = hasV3; // Text-to-Dialogue requires v3
  const hasSFX = true; // Available on all paid tiers; we'll handle 403 gracefully
  const hasMusic = true; // Available on paid tiers

  const preferredModel = hasV3
    ? 'eleven_v3'
    : modelIds.includes('eleven_multilingual_v2')
      ? 'eleven_multilingual_v2'
      : modelIds.includes('eleven_flash_v2_5')
        ? 'eleven_flash_v2_5'
        : ttsModels[0]?.model_id || 'eleven_multilingual_v2';

  const maxCharacters: Record<string, number> = {};
  for (const m of ttsModels) {
    maxCharacters[m.model_id] = m.max_characters_request_subscribed_user || 5000;
  }

  cachedCapabilities = { models: ttsModels, hasV3, hasDialogue, hasSFX, hasMusic, preferredModel, maxCharacters };
  capabilitiesCachedAt = Date.now();

  return cachedCapabilities;
}

// ── Voices ──

let voiceCache: ElevenLabsVoice[] | null = null;
let voiceCachedAt = 0;
const VOICE_TTL = 5 * 60 * 1000;

export async function getVoices(): Promise<ElevenLabsVoice[]> {
  if (voiceCache && Date.now() - voiceCachedAt < VOICE_TTL) {
    return voiceCache;
  }

  const res = await fetchWithRetry(`${API_BASE}/voices`, { headers: headers() });
  const data = (await res.json()) as { voices: ElevenLabsVoice[] };
  voiceCache = data.voices;
  voiceCachedAt = Date.now();
  return voiceCache;
}

export async function searchVoices(query: string): Promise<ElevenLabsVoice[]> {
  const voices = await getVoices();
  const q = query.toLowerCase();
  return voices.filter(
    (v) =>
      v.name.toLowerCase().includes(q) ||
      v.category?.toLowerCase().includes(q) ||
      Object.values(v.labels || {}).some((l) => l.toLowerCase().includes(q))
  );
}

// ── Prompt Hash (for caching/dedup) ──

export function computePromptHash(params: Record<string, unknown>): string {
  const normalized = JSON.stringify(params, Object.keys(params).sort());
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

// ── TTS Generation ──

export async function generateTTS(
  request: TTSRequest
): Promise<{ buffer: Buffer; requestId: string | null }> {
  const caps = await getCapabilities();
  const modelId = request.model_id || caps.preferredModel;

  const body: Record<string, unknown> = {
    text: request.text,
    model_id: modelId,
    voice_settings: request.voice_settings || {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0.0,
      use_speaker_boost: true,
    },
  };

  if (request.seed !== undefined) body.seed = request.seed;
  if (request.previous_text) body.previous_text = request.previous_text;
  if (request.next_text) body.next_text = request.next_text;
  if (request.previous_request_ids?.length) body.previous_request_ids = request.previous_request_ids;
  if (request.next_request_ids?.length) body.next_request_ids = request.next_request_ids;
  if (request.apply_text_normalization) body.apply_text_normalization = request.apply_text_normalization;

  const outputFormat = request.output_format || 'mp3_44100_192';
  const url = `${API_BASE}/text-to-speech/${request.voice_id}?output_format=${outputFormat}`;

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });

  const requestId = res.headers.get('request-id');
  const buffer = Buffer.from(await res.arrayBuffer());

  return { buffer, requestId };
}

// ── TTS Streaming ──

export async function streamTTS(
  request: TTSRequest
): Promise<{ stream: ReadableStream<Uint8Array>; requestId: string | null }> {
  const caps = await getCapabilities();
  const modelId = request.model_id || caps.preferredModel;

  const body: Record<string, unknown> = {
    text: request.text,
    model_id: modelId,
    voice_settings: request.voice_settings,
  };

  const outputFormat = request.output_format || 'mp3_44100_128';
  const url = `${API_BASE}/text-to-speech/${request.voice_id}/stream?output_format=${outputFormat}`;

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });

  const requestId = res.headers.get('request-id');

  if (!res.body) throw new Error('No response body for streaming');

  return { stream: res.body as ReadableStream<Uint8Array>, requestId };
}

// ── Sound Effects ──

export async function generateSFX(
  request: SFXRequest
): Promise<{ buffer: Buffer }> {
  const body: Record<string, unknown> = {
    text: request.text,
  };

  if (request.duration_seconds) body.duration_seconds = request.duration_seconds;
  if (request.prompt_influence !== undefined) body.prompt_influence = request.prompt_influence;

  const res = await fetchWithRetry(`${API_BASE}/sound-generation`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });

  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer };
}

// ── Music Generation ──

export async function generateMusic(
  prompt: string,
  durationSeconds?: number
): Promise<{ buffer: Buffer }> {
  const body: Record<string, unknown> = { prompt };
  if (durationSeconds) body.duration_seconds = durationSeconds;

  const res = await fetchWithRetry(`${API_BASE}/music/generate`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });

  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer };
}

// ── Usage Info ──

export async function getUsage(): Promise<Record<string, unknown>> {
  const res = await fetchWithRetry(`${API_BASE}/user/subscription`, { headers: headers() });
  return (await res.json()) as Record<string, unknown>;
}
