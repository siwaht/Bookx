/**
 * TTS Provider Registry
 * Central place to get provider instances and route TTS requests.
 */

import type { TTSProvider, TTSProviderName, TTSGenerateRequest, TTSGenerateResult, TTSVoice } from './provider.js';
import { OpenAITTSProvider } from './openai-provider.js';
import { GoogleTTSProvider } from './google-provider.js';
import { AmazonPollyProvider } from './amazon-provider.js';
import { DeepgramTTSProvider } from './deepgram-provider.js';

// ElevenLabs is handled separately since it has richer features (SFX, music, etc.)
// but we wrap it here for the unified voice/generate interface
import { generateTTS as elGenerateTTS, getVoices as elGetVoices } from '../elevenlabs/client.js';

class ElevenLabsProviderWrapper implements TTSProvider {
  name = 'elevenlabs' as const;
  displayName = 'ElevenLabs';

  isConfigured(): boolean {
    return !!process.env.ELEVENLABS_API_KEY;
  }

  async listVoices(): Promise<TTSVoice[]> {
    const voices = await elGetVoices();
    return voices.map((v) => ({
      voiceId: v.voice_id,
      name: v.name,
      provider: 'elevenlabs' as const,
      category: v.category,
      labels: v.labels,
      previewUrl: v.preview_url,
      description: v.description,
    }));
  }

  async generate(request: TTSGenerateRequest): Promise<TTSGenerateResult> {
    const { buffer, requestId } = await elGenerateTTS({
      text: request.text,
      voice_id: request.voiceId,
      model_id: request.modelId,
      voice_settings: {
        stability: request.stability ?? 0.5,
        similarity_boost: request.similarityBoost ?? 0.75,
        style: request.style ?? 0.0,
        use_speaker_boost: request.speakerBoost ?? true,
        speed: request.speed,
      },
      seed: request.seed,
      previous_request_ids: request.previousRequestIds,
      previous_text: request.previousText,
      next_text: request.nextText,
      output_format: request.outputFormat || 'mp3_44100_192',
    });
    const durationMs = Math.round((buffer.length / 24000) * 1000);
    return { buffer, requestId, provider: 'elevenlabs', durationMs };
  }

  async testConnection(): Promise<{ connected: boolean; error?: string; details?: Record<string, any> }> {
    try {
      const key = process.env.ELEVENLABS_API_KEY;
      if (!key) return { connected: false, error: 'No API key configured' };
      const res = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
        headers: { 'xi-api-key': key },
      });
      if (res.ok) {
        const data = await res.json() as any;
        return { connected: true, details: { tier: data.tier, key_last4: '••••' + key.slice(-4) } };
      }
      return { connected: false, error: `API returned ${res.status}` };
    } catch (err: any) {
      return { connected: false, error: err.message };
    }
  }
}

// Singleton registry
const providers: Map<TTSProviderName, TTSProvider> = new Map();

function initProviders() {
  if (providers.size > 0) return;
  providers.set('elevenlabs', new ElevenLabsProviderWrapper());
  providers.set('openai', new OpenAITTSProvider());
  providers.set('google', new GoogleTTSProvider());
  providers.set('amazon', new AmazonPollyProvider());
  providers.set('deepgram', new DeepgramTTSProvider());
}

export function getProvider(name: TTSProviderName): TTSProvider {
  initProviders();
  const p = providers.get(name);
  if (!p) throw new Error(`Unknown TTS provider: ${name}`);
  return p;
}

export function getAllProviders(): TTSProvider[] {
  initProviders();
  return Array.from(providers.values());
}

export function getConfiguredProviders(): TTSProvider[] {
  return getAllProviders().filter((p) => p.isConfigured());
}

export async function listAllVoices(): Promise<TTSVoice[]> {
  const configured = getConfiguredProviders();
  const results: TTSVoice[] = [];
  for (const p of configured) {
    try {
      const voices = await p.listVoices();
      results.push(...voices);
    } catch (err) {
      console.warn(`[TTS Registry] Failed to list voices for ${p.name}:`, err);
    }
  }
  return results;
}

export async function generateWithProvider(
  providerName: TTSProviderName,
  request: TTSGenerateRequest
): Promise<TTSGenerateResult> {
  const provider = getProvider(providerName);
  if (!provider.isConfigured()) {
    throw new Error(`TTS provider "${providerName}" is not configured. Add the required API key in Settings.`);
  }
  return provider.generate(request);
}
