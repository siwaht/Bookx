/**
 * TTS Provider Abstraction Layer
 * 
 * Supports multiple TTS backends:
 * - elevenlabs: ElevenLabs (default, full-featured)
 * - openai: OpenAI TTS (gpt-4o-mini-tts, tts-1, tts-1-hd)
 * - google: Google Cloud TTS
 * - amazon: Amazon Polly
 * - deepgram: Deepgram Aura
 * - cartesia: Cartesia Sonic
 * 
 * Each provider implements the TTSProvider interface. This is the plug point
 * for adding cheaper/alternative TTS vendors without touching any calling code -
 * everything upstream (characters, segments, generation jobs, casting) only
 * ever talks to `TTSProviderName` + this interface.
 */

export type TTSProviderName = 'elevenlabs' | 'openai' | 'google' | 'amazon' | 'deepgram' | 'cartesia';

export interface TTSGenerateRequest {
  text: string;
  voiceId: string;
  modelId?: string;
  speed?: number;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  speakerBoost?: boolean;
  outputFormat?: string;
  // ElevenLabs-specific stitching
  previousRequestIds?: string[];
  previousText?: string;
  nextText?: string;
  seed?: number;
}

export interface TTSGenerateResult {
  buffer: Buffer;
  requestId: string | null;
  provider: TTSProviderName;
  durationMs?: number;
}

export interface TTSVoice {
  voiceId: string;
  name: string;
  provider: TTSProviderName;
  category?: string;
  language?: string;
  gender?: string;
  previewUrl?: string | null;
  description?: string | null;
  labels?: Record<string, string>;
}

export interface TTSProvider {
  name: TTSProviderName;
  displayName: string;
  isConfigured(): boolean;
  listVoices(): Promise<TTSVoice[]>;
  generate(request: TTSGenerateRequest): Promise<TTSGenerateResult>;
  testConnection(): Promise<{ connected: boolean; error?: string; details?: Record<string, any> }>;
}
