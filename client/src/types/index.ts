// Shared types for the client

export interface Book {
  id: string;
  title: string;
  author: string | null;
  narrator: string | null;
  isbn: string | null;
  cover_art_path: string | null;
  default_model: string;
  project_type: 'audiobook' | 'podcast';
  format: string;
  created_at: string;
  updated_at: string;
  chapters?: Chapter[];
  characters?: Character[];
}

export interface Chapter {
  id: string;
  book_id: string;
  title: string;
  sort_order: number;
  raw_text: string;
  cleaned_text: string | null;
  stats?: {
    total_segments: number;
    assigned: number;
    with_audio: number;
    on_timeline: number;
  };
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
}

export interface Segment {
  id: string;
  chapter_id: string;
  character_id: string | null;
  sort_order: number;
  text: string;
  audio_asset_id: string | null;
  generation_seed: number | null;
}

export interface AudioAsset {
  id: string;
  book_id: string;
  type: 'tts' | 'dialogue' | 'sfx' | 'music' | 'imported';
  file_path: string;
  duration_ms: number | null;
  prompt_hash: string | null;
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
  clips: Clip[];
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
}

export interface ChapterMarker {
  id: string;
  book_id: string;
  chapter_id: string | null;
  position_ms: number;
  label: string;
}

export interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  category: string;
  labels: Record<string, string>;
  preview_url: string | null;
  description: string | null;
}

export interface ElevenLabsCapabilities {
  models: Array<{ model_id: string; name: string; description: string }>;
  hasV3: boolean;
  hasDialogue: boolean;
  hasSFX: boolean;
  hasMusic: boolean;
  preferredModel: string;
  maxCharacters: Record<string, number>;
}

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

export interface RenderJob {
  id: string;
  book_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  type: string;
  progress: number;
  error_message: string | null;
  qc_report: QCReport | null;
}

export interface ValidationResult {
  pass: boolean;
  checks: Array<{ name: string; pass: boolean; message: string }>;
}
