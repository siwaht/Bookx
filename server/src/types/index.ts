// ── Domain Types ──

export interface Book {
  id: string;
  title: string;
  author: string | null;
  narrator: string | null;
  isbn: string | null;
  cover_art_path: string | null;
  default_model: string;
  created_at: string;
  updated_at: string;
}

export interface Chapter {
  id: string;
  book_id: string;
  title: string;
  sort_order: number;
  raw_text: string;
  cleaned_text: string | null;
  created_at: string;
  updated_at: string;
}

export interface Character {
  id: string;
  book_id: string;
  name: string;
  role: 'narrator' | 'character';
  voice_id: string | null;
  voice_name: string | null;
  model_id: string;
  stability: number;
  similarity_boost: number;
  style: number;
  speed: number;
  speaker_boost: number;
  created_at: string;
}

export interface Segment {
  id: string;
  chapter_id: string;
  character_id: string | null;
  sort_order: number;
  text: string;
  audio_asset_id: string | null;
  generation_seed: number | null;
  previous_request_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AudioAsset {
  id: string;
  book_id: string;
  type: 'tts' | 'dialogue' | 'sfx' | 'music' | 'imported';
  file_path: string;
  duration_ms: number | null;
  sample_rate: number | null;
  channels: number;
  prompt_hash: string | null;
  elevenlabs_request_id: string | null;
  generation_params: string | null;
  file_size_bytes: number | null;
  created_at: string;
}

export interface Track {
  id: string;
  book_id: string;
  name: string;
  type: 'narration' | 'dialogue' | 'sfx' | 'music' | 'imported';
  sort_order: number;
  gain: number;
  pan: number;
  muted: number;
  solo: number;
  locked: number;
  color: string;
  created_at: string;
}

export interface Clip {
  id: string;
  track_id: string;
  audio_asset_id: string;
  segment_id: string | null;
  position_ms: number;
  trim_start_ms: number;
  trim_end_ms: number;
  gain: number;
  fade_in_ms: number;
  fade_out_ms: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChapterMarker {
  id: string;
  book_id: string;
  chapter_id: string | null;
  position_ms: number;
  label: string;
  created_at: string;
}

export interface AutomationPoint {
  id: string;
  track_id: string;
  time_ms: number;
  value: number;
  curve: 'linear' | 'exponential';
  created_at: string;
}

export interface PronunciationRule {
  id: string;
  book_id: string;
  character_id: string | null;
  word: string;
  phoneme: string | null;
  alias: string | null;
  created_at: string;
}

export interface RenderJob {
  id: string;
  book_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  type: 'full' | 'chapter' | 'preview';
  chapter_id: string | null;
  output_path: string | null;
  progress: number;
  error_message: string | null;
  qc_report: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface Export {
  id: string;
  book_id: string;
  target: string;
  status: string;
  output_path: string | null;
  validation_report: string | null;
  created_at: string;
}

// ── ElevenLabs Types ──

export interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  category: string;
  labels: Record<string, string>;
  preview_url: string | null;
  description: string | null;
}

export interface ElevenLabsModel {
  model_id: string;
  name: string;
  can_do_text_to_speech: boolean;
  can_do_voice_conversion: boolean;
  description: string;
  languages: Array<{ language_id: string; name: string }>;
  max_characters_request_free_user: number;
  max_characters_request_subscribed_user: number;
}

export interface ElevenLabsCapabilities {
  models: ElevenLabsModel[];
  hasV3: boolean;
  hasDialogue: boolean;
  hasSFX: boolean;
  hasMusic: boolean;
  preferredModel: string;
  maxCharacters: Record<string, number>;
}

export interface VoiceSettings {
  stability: number;
  similarity_boost: number;
  style?: number;
  use_speaker_boost?: boolean;
  speed?: number;
}

export interface TTSRequest {
  text: string;
  voice_id: string;
  model_id?: string;
  voice_settings?: VoiceSettings;
  seed?: number;
  previous_text?: string;
  next_text?: string;
  previous_request_ids?: string[];
  next_request_ids?: string[];
  output_format?: string;
  apply_text_normalization?: 'auto' | 'on' | 'off';
}

export interface SFXRequest {
  text: string;
  duration_seconds?: number;
  prompt_influence?: number;
}

export interface MusicRequest {
  prompt: string;
  duration_seconds?: number;
}

// ── QC Types ──

export interface QCReport {
  chapters: QCChapterReport[];
  overall_pass: boolean;
}

export interface QCChapterReport {
  chapter_id: string;
  chapter_title: string;
  duration_seconds: number;
  rms_db: number;
  true_peak_db: number;
  lufs: number;
  noise_floor_db: number;
  clipping_detected: boolean;
  acx_pass: boolean;
  issues: string[];
}

// ── ACX Spec ──

export interface ACXSpec {
  format: 'mp3';
  bitrate: 192;
  sample_rate: 44100;
  cbr: true;
  rms_min_db: -23;
  rms_max_db: -18;
  peak_max_db: -3;
  noise_floor_max_db: -60;
  min_duration_seconds: 0;
  max_file_size_mb: null;
  cover_min_px: 2400;
  cover_aspect: '1:1';
}
