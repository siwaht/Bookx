import type { TTSProvider, TTSGenerateRequest, TTSGenerateResult, TTSVoice } from './provider.js';

const API_BASE = 'https://api.deepgram.com/v1';

// Aura-2 voices (latest generation) + popular Aura-1 voices
const DEEPGRAM_VOICES: TTSVoice[] = [
  // Aura-2 English
  { voiceId: 'aura-2-thalia-en', name: 'Thalia', provider: 'deepgram', gender: 'female', language: 'en', category: 'aura-2', description: 'Warm, expressive female voice' },
  { voiceId: 'aura-2-andromeda-en', name: 'Andromeda', provider: 'deepgram', gender: 'female', language: 'en', category: 'aura-2', description: 'Clear, professional female voice' },
  { voiceId: 'aura-2-asteria-en', name: 'Asteria', provider: 'deepgram', gender: 'female', language: 'en', category: 'aura-2', description: 'Bright, friendly female voice' },
  { voiceId: 'aura-2-athena-en', name: 'Athena', provider: 'deepgram', gender: 'female', language: 'en', category: 'aura-2', description: 'Confident, authoritative female voice' },
  { voiceId: 'aura-2-aurora-en', name: 'Aurora', provider: 'deepgram', gender: 'female', language: 'en', category: 'aura-2', description: 'Soft, soothing female voice' },
  { voiceId: 'aura-2-callista-en', name: 'Callista', provider: 'deepgram', gender: 'female', language: 'en', category: 'aura-2', description: 'Elegant female voice' },
  { voiceId: 'aura-2-luna-en', name: 'Luna', provider: 'deepgram', gender: 'female', language: 'en', category: 'aura-2', description: 'Calm, gentle female voice' },
  { voiceId: 'aura-2-hera-en', name: 'Hera', provider: 'deepgram', gender: 'female', language: 'en', category: 'aura-2', description: 'Strong, commanding female voice' },
  { voiceId: 'aura-2-iris-en', name: 'Iris', provider: 'deepgram', gender: 'female', language: 'en', category: 'aura-2', description: 'Lively female voice' },
  { voiceId: 'aura-2-selene-en', name: 'Selene', provider: 'deepgram', gender: 'female', language: 'en', category: 'aura-2', description: 'Serene female voice' },
  { voiceId: 'aura-2-apollo-en', name: 'Apollo', provider: 'deepgram', gender: 'male', language: 'en', category: 'aura-2', description: 'Rich, resonant male voice' },
  { voiceId: 'aura-2-arcas-en', name: 'Arcas', provider: 'deepgram', gender: 'male', language: 'en', category: 'aura-2', description: 'Deep, warm male voice' },
  { voiceId: 'aura-2-atlas-en', name: 'Atlas', provider: 'deepgram', gender: 'male', language: 'en', category: 'aura-2', description: 'Strong male voice' },
  { voiceId: 'aura-2-draco-en', name: 'Draco', provider: 'deepgram', gender: 'male', language: 'en', category: 'aura-2', description: 'Dynamic male voice' },
  { voiceId: 'aura-2-hermes-en', name: 'Hermes', provider: 'deepgram', gender: 'male', language: 'en', category: 'aura-2', description: 'Energetic male voice' },
  { voiceId: 'aura-2-hyperion-en', name: 'Hyperion', provider: 'deepgram', gender: 'male', language: 'en', category: 'aura-2', description: 'Powerful male voice' },
  { voiceId: 'aura-2-orion-en', name: 'Orion', provider: 'deepgram', gender: 'male', language: 'en', category: 'aura-2', description: 'Smooth, deep male voice' },
  { voiceId: 'aura-2-orpheus-en', name: 'Orpheus', provider: 'deepgram', gender: 'male', language: 'en', category: 'aura-2', description: 'Melodic male voice' },
  { voiceId: 'aura-2-zeus-en', name: 'Zeus', provider: 'deepgram', gender: 'male', language: 'en', category: 'aura-2', description: 'Commanding male voice' },
  // Aura-2 Spanish
  { voiceId: 'aura-2-sirio-es', name: 'Sirio (ES)', provider: 'deepgram', gender: 'male', language: 'es', category: 'aura-2', description: 'Spanish male voice' },
  { voiceId: 'aura-2-carina-es', name: 'Carina (ES)', provider: 'deepgram', gender: 'female', language: 'es', category: 'aura-2', description: 'Spanish female voice' },
  // Aura-1 English (legacy, still available)
  { voiceId: 'aura-asteria-en', name: 'Asteria (v1)', provider: 'deepgram', gender: 'female', language: 'en', category: 'aura-1', description: 'Classic Aura female voice' },
  { voiceId: 'aura-orion-en', name: 'Orion (v1)', provider: 'deepgram', gender: 'male', language: 'en', category: 'aura-1', description: 'Classic Aura male voice' },
  { voiceId: 'aura-luna-en', name: 'Luna (v1)', provider: 'deepgram', gender: 'female', language: 'en', category: 'aura-1', description: 'Classic Aura female voice' },
  { voiceId: 'aura-zeus-en', name: 'Zeus (v1)', provider: 'deepgram', gender: 'male', language: 'en', category: 'aura-1', description: 'Classic Aura male voice' },
];

export class DeepgramTTSProvider implements TTSProvider {
  name = 'deepgram' as const;
  displayName = 'Deepgram Aura';

  private getApiKey(): string {
    const key = process.env.DEEPGRAM_API_KEY;
    if (!key) throw new Error('DEEPGRAM_API_KEY not set. Go to Settings and add your Deepgram API key.');
    return key;
  }

  isConfigured(): boolean {
    return !!process.env.DEEPGRAM_API_KEY;
  }

  async listVoices(): Promise<TTSVoice[]> {
    return DEEPGRAM_VOICES;
  }

  async generate(request: TTSGenerateRequest): Promise<TTSGenerateResult> {
    const model = request.voiceId || 'aura-2-thalia-en';

    const url = new URL(`${API_BASE}/speak`);
    url.searchParams.set('model', model);
    url.searchParams.set('encoding', 'mp3');

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Authorization': `Token ${this.getApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: request.text }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => 'Unknown error');
      throw new Error(`Deepgram TTS error ${res.status}: ${errText}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const requestId = res.headers.get('dg-request-id');
    const charCount = res.headers.get('dg-char-count');

    // Estimate duration from MP3 buffer size (rough: ~16kB/s at 128kbps)
    const durationMs = Math.round((buffer.length / 16000) * 1000);

    return { buffer, requestId, provider: 'deepgram', durationMs };
  }

  async testConnection(): Promise<{ connected: boolean; error?: string; details?: Record<string, any> }> {
    try {
      const key = this.getApiKey();
      // Make a minimal TTS request to verify the key works
      const url = `${API_BASE}/speak?model=aura-2-thalia-en&encoding=mp3`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: 'test' }),
      });

      if (res.ok) {
        // Consume the body to avoid leaking
        await res.arrayBuffer();
        return { connected: true, details: { key_last4: '••••' + key.slice(-4) } };
      }
      return { connected: false, error: `API returned ${res.status}` };
    } catch (err: any) {
      return { connected: false, error: err.message };
    }
  }
}
