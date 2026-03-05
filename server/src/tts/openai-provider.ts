import type { TTSProvider, TTSGenerateRequest, TTSGenerateResult, TTSVoice } from './provider.js';

const API_BASE = 'https://api.openai.com/v1';

const OPENAI_VOICES: TTSVoice[] = [
  { voiceId: 'alloy', name: 'Alloy', provider: 'openai', gender: 'neutral', category: 'standard', description: 'Neutral, balanced voice' },
  { voiceId: 'ash', name: 'Ash', provider: 'openai', gender: 'male', category: 'standard', description: 'Warm male voice' },
  { voiceId: 'ballad', name: 'Ballad', provider: 'openai', gender: 'male', category: 'standard', description: 'Expressive male voice' },
  { voiceId: 'coral', name: 'Coral', provider: 'openai', gender: 'female', category: 'standard', description: 'Warm female voice' },
  { voiceId: 'echo', name: 'Echo', provider: 'openai', gender: 'male', category: 'standard', description: 'Clear male voice' },
  { voiceId: 'fable', name: 'Fable', provider: 'openai', gender: 'male', category: 'standard', description: 'Storytelling male voice' },
  { voiceId: 'nova', name: 'Nova', provider: 'openai', gender: 'female', category: 'standard', description: 'Energetic female voice' },
  { voiceId: 'onyx', name: 'Onyx', provider: 'openai', gender: 'male', category: 'standard', description: 'Deep male voice' },
  { voiceId: 'sage', name: 'Sage', provider: 'openai', gender: 'female', category: 'standard', description: 'Calm female voice' },
  { voiceId: 'shimmer', name: 'Shimmer', provider: 'openai', gender: 'female', category: 'standard', description: 'Bright female voice' },
];

export class OpenAITTSProvider implements TTSProvider {
  name = 'openai' as const;
  displayName = 'OpenAI TTS';

  private getApiKey(): string {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY not set. Go to Settings and add your OpenAI API key.');
    return key;
  }

  isConfigured(): boolean {
    return !!process.env.OPENAI_API_KEY;
  }

  async listVoices(): Promise<TTSVoice[]> {
    return OPENAI_VOICES;
  }

  async generate(request: TTSGenerateRequest): Promise<TTSGenerateResult> {
    const model = request.modelId || 'gpt-4o-mini-tts';
    const body: Record<string, unknown> = {
      model,
      input: request.text,
      voice: request.voiceId,
      response_format: 'mp3',
    };
    if (request.speed && request.speed !== 1.0) {
      body.speed = Math.max(0.25, Math.min(4.0, request.speed));
    }

    const res = await fetch(`${API_BASE}/audio/speech`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.getApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => 'Unknown error');
      throw new Error(`OpenAI TTS error ${res.status}: ${errText}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const durationMs = Math.round((buffer.length / 24000) * 1000);

    return { buffer, requestId: res.headers.get('x-request-id'), provider: 'openai', durationMs };
  }

  async testConnection(): Promise<{ connected: boolean; error?: string; details?: Record<string, any> }> {
    try {
      const res = await fetch(`${API_BASE}/models`, {
        headers: { 'Authorization': `Bearer ${this.getApiKey()}` },
      });
      if (res.ok) {
        return { connected: true, details: { key_last4: '••••' + this.getApiKey().slice(-4) } };
      }
      return { connected: false, error: `API returned ${res.status}` };
    } catch (err: any) {
      return { connected: false, error: err.message };
    }
  }
}
