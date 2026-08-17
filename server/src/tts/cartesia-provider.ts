import type { TTSProvider, TTSGenerateRequest, TTSGenerateResult, TTSVoice } from './provider.js';

/**
 * Cartesia TTS Provider (Sonic models)
 * Docs: https://docs.cartesia.ai
 *
 * Auth: `X-Api-Key: <key>` (server-side) + a `Cartesia-Version` date header.
 * TTS:  POST /tts/bytes -> raw audio bytes.
 * Voices: GET /voices -> { data: [...], has_more, next_page }
 */

const API_BASE = 'https://api.cartesia.ai';
const CARTESIA_VERSION = '2025-04-16';

// A couple of well-known public sample voices, used only as a fallback if the
// live /voices call fails (e.g. network hiccup) so the picker isn't empty.
const FALLBACK_VOICES: TTSVoice[] = [
  { voiceId: 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4', name: 'Skylar', provider: 'cartesia', gender: 'female', language: 'en', category: 'public', description: 'Approachable American female voice' },
  { voiceId: 'a0e99841-438c-4a64-b679-ae501e7d6091', name: 'Cartesia Default', provider: 'cartesia', language: 'en', category: 'public', description: 'Default sample voice' },
];

let voiceCache: TTSVoice[] | null = null;
let voiceCachedAt = 0;
const VOICE_TTL = 10 * 60 * 1000;

export class CartesiaTTSProvider implements TTSProvider {
  name = 'cartesia' as const;
  displayName = 'Cartesia';

  private getApiKey(): string {
    const key = process.env.CARTESIA_API_KEY;
    if (!key) throw new Error('CARTESIA_API_KEY not set. Go to Settings and add your Cartesia API key.');
    return key;
  }

  isConfigured(): boolean {
    return !!process.env.CARTESIA_API_KEY;
  }

  private headers(): Record<string, string> {
    return {
      'X-Api-Key': this.getApiKey(),
      'Cartesia-Version': CARTESIA_VERSION,
      'Content-Type': 'application/json',
    };
  }

  async listVoices(): Promise<TTSVoice[]> {
    if (voiceCache && Date.now() - voiceCachedAt < VOICE_TTL) return voiceCache;
    try {
      const res = await fetch(`${API_BASE}/voices?limit=100`, { headers: this.headers() });
      if (!res.ok) throw new Error(`Cartesia voices error ${res.status}`);
      const data = await res.json() as { data?: any[] };
      const voices = (data.data || []).map((v: any) => ({
        voiceId: v.id,
        name: v.name || v.id,
        provider: 'cartesia' as const,
        gender: v.gender,
        language: v.language,
        category: v.is_owner ? 'custom' : 'public',
        description: v.description || v.tagline || null,
      }));
      if (voices.length > 0) {
        voiceCache = voices;
        voiceCachedAt = Date.now();
        return voices;
      }
      return FALLBACK_VOICES;
    } catch (err) {
      console.warn('[Cartesia] Failed to list voices, using fallback:', (err as Error).message);
      return FALLBACK_VOICES;
    }
  }

  async generate(request: TTSGenerateRequest): Promise<TTSGenerateResult> {
    const modelId = request.modelId || 'sonic-3.5';
    const body: Record<string, unknown> = {
      model_id: modelId,
      transcript: request.text,
      voice: { mode: 'id', id: request.voiceId },
      output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128 },
    };
    if (request.speed !== undefined) {
      body.generation_config = { speed: Math.max(0.5, Math.min(2.0, request.speed)) };
    }

    const res = await fetch(`${API_BASE}/tts/bytes`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => 'Unknown error');
      throw new Error(`Cartesia TTS error ${res.status}: ${errText}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const requestId = res.headers.get('cartesia-request-id') || res.headers.get('x-request-id');
    // mp3 @128kbps ≈ 16,000 bytes/sec
    const durationMs = Math.round((buffer.length / 16000) * 1000);

    return { buffer, requestId, provider: 'cartesia', durationMs };
  }

  async testConnection(): Promise<{ connected: boolean; error?: string; details?: Record<string, any> }> {
    try {
      const key = this.getApiKey();
      const res = await fetch(`${API_BASE}/voices?limit=1`, { headers: this.headers() });
      if (res.ok) {
        return { connected: true, details: { key_last4: '••••' + key.slice(-4) } };
      }
      return { connected: false, error: `API returned ${res.status}` };
    } catch (err: any) {
      return { connected: false, error: err.message };
    }
  }
}
