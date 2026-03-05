import type { TTSProvider, TTSGenerateRequest, TTSGenerateResult, TTSVoice } from './provider.js';

const API_BASE = 'https://texttospeech.googleapis.com/v1';

// Popular Google Cloud TTS voices
const GOOGLE_VOICES: TTSVoice[] = [
  { voiceId: 'en-US-Journey-D', name: 'Journey D (Male)', provider: 'google', gender: 'male', language: 'en-US', category: 'journey', description: 'Natural male voice' },
  { voiceId: 'en-US-Journey-F', name: 'Journey F (Female)', provider: 'google', gender: 'female', language: 'en-US', category: 'journey', description: 'Natural female voice' },
  { voiceId: 'en-US-Studio-M', name: 'Studio M (Male)', provider: 'google', gender: 'male', language: 'en-US', category: 'studio', description: 'Studio quality male' },
  { voiceId: 'en-US-Studio-O', name: 'Studio O (Female)', provider: 'google', gender: 'female', language: 'en-US', category: 'studio', description: 'Studio quality female' },
  { voiceId: 'en-US-Neural2-A', name: 'Neural2 A (Male)', provider: 'google', gender: 'male', language: 'en-US', category: 'neural2' },
  { voiceId: 'en-US-Neural2-C', name: 'Neural2 C (Female)', provider: 'google', gender: 'female', language: 'en-US', category: 'neural2' },
  { voiceId: 'en-US-Neural2-D', name: 'Neural2 D (Male)', provider: 'google', gender: 'male', language: 'en-US', category: 'neural2' },
  { voiceId: 'en-US-Neural2-F', name: 'Neural2 F (Female)', provider: 'google', gender: 'female', language: 'en-US', category: 'neural2' },
  { voiceId: 'en-GB-Neural2-A', name: 'Neural2 A British (Female)', provider: 'google', gender: 'female', language: 'en-GB', category: 'neural2' },
  { voiceId: 'en-GB-Neural2-B', name: 'Neural2 B British (Male)', provider: 'google', gender: 'male', language: 'en-GB', category: 'neural2' },
];

export class GoogleTTSProvider implements TTSProvider {
  name = 'google' as const;
  displayName = 'Google Cloud TTS';

  private getApiKey(): string {
    const key = process.env.GOOGLE_TTS_API_KEY;
    if (!key) throw new Error('GOOGLE_TTS_API_KEY not set. Go to Settings and add your Google Cloud TTS API key.');
    return key;
  }

  isConfigured(): boolean {
    return !!process.env.GOOGLE_TTS_API_KEY;
  }

  async listVoices(): Promise<TTSVoice[]> {
    try {
      const res = await fetch(`${API_BASE}/voices?key=${this.getApiKey()}`);
      if (!res.ok) return GOOGLE_VOICES;
      const data = await res.json() as any;
      const voices: TTSVoice[] = (data.voices || [])
        .filter((v: any) => v.languageCodes?.some((l: string) => l.startsWith('en')))
        .slice(0, 50)
        .map((v: any) => ({
          voiceId: v.name,
          name: v.name,
          provider: 'google' as const,
          gender: v.ssmlGender?.toLowerCase() || 'neutral',
          language: v.languageCodes?.[0] || 'en-US',
          category: v.name.includes('Studio') ? 'studio' : v.name.includes('Neural2') ? 'neural2' : 'standard',
        }));
      return voices.length > 0 ? voices : GOOGLE_VOICES;
    } catch {
      return GOOGLE_VOICES;
    }
  }

  async generate(request: TTSGenerateRequest): Promise<TTSGenerateResult> {
    const voiceId = request.voiceId;
    const langCode = voiceId.match(/^([a-z]{2}-[A-Z]{2})/)?.[1] || 'en-US';

    const body = {
      input: { text: request.text },
      voice: { languageCode: langCode, name: voiceId },
      audioConfig: {
        audioEncoding: 'MP3',
        sampleRateHertz: 44100,
        speakingRate: request.speed || 1.0,
      },
    };

    const res = await fetch(`${API_BASE}/text:synthesize?key=${this.getApiKey()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => 'Unknown error');
      throw new Error(`Google TTS error ${res.status}: ${errText}`);
    }

    const data = await res.json() as any;
    const buffer = Buffer.from(data.audioContent, 'base64');
    const durationMs = Math.round((buffer.length / 24000) * 1000);

    return { buffer, requestId: null, provider: 'google', durationMs };
  }

  async testConnection(): Promise<{ connected: boolean; error?: string; details?: Record<string, any> }> {
    try {
      const res = await fetch(`${API_BASE}/voices?key=${this.getApiKey()}&languageCode=en-US`);
      if (res.ok) {
        return { connected: true, details: { key_last4: '••••' + this.getApiKey().slice(-4) } };
      }
      return { connected: false, error: `API returned ${res.status}` };
    } catch (err: any) {
      return { connected: false, error: err.message };
    }
  }
}
