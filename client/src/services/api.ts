const API_BASE = '/api';

let authToken: string | null = localStorage.getItem('auth_token');

export function setToken(token: string) {
  authToken = token;
  localStorage.setItem('auth_token', token);
}

export function clearToken() {
  authToken = null;
  localStorage.removeItem('auth_token');
}

export function getToken(): string | null {
  return authToken;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };

  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 401) {
    clearToken();
    window.location.reload();
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

// ── Auth ──
export const auth = {
  login: (password: string) => request<{ token: string }>('/auth/login', {
    method: 'POST', body: JSON.stringify({ password }),
  }),
  verify: () => request<void>('/auth/verify'),
};

// ── Books ──
export const books = {
  list: () => request<any[]>('/books'),
  get: (id: string) => request<any>(`/books/${id}`),
  create: (data: { title: string; author?: string; narrator?: string }) =>
    request<any>('/books', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: any) =>
    request<any>(`/books/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id: string) => request<void>(`/books/${id}`, { method: 'DELETE' }),
};

// ── Chapters ──
export const chapters = {
  list: (bookId: string) => request<any[]>(`/books/${bookId}/chapters`),
  create: (bookId: string, data: { title?: string; raw_text?: string }) =>
    request<any>(`/books/${bookId}/chapters`, { method: 'POST', body: JSON.stringify(data) }),
  update: (bookId: string, id: string, data: any) =>
    request<any>(`/books/${bookId}/chapters/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  reorder: (bookId: string, ids: string[]) =>
    request<void>(`/books/${bookId}/chapters/reorder`, { method: 'POST', body: JSON.stringify({ ids }) }),
  split: (bookId: string, id: string, splitAt: number, newTitle?: string) =>
    request<{ original: any; new_chapter: any }>(`/books/${bookId}/chapters/${id}/split`, {
      method: 'POST', body: JSON.stringify({ split_at: splitAt, new_title: newTitle }),
    }),
  duplicate: (bookId: string, id: string) =>
    request<any>(`/books/${bookId}/chapters/${id}/duplicate`, { method: 'POST' }),
  delete: (bookId: string, id: string) =>
    request<void>(`/books/${bookId}/chapters/${id}`, { method: 'DELETE' }),
};

// ── Characters ──
export const characters = {
  list: (bookId: string) => request<any[]>(`/books/${bookId}/characters`),
  create: (bookId: string, data: any) =>
    request<any>(`/books/${bookId}/characters`, { method: 'POST', body: JSON.stringify(data) }),
  update: (bookId: string, id: string, data: any) =>
    request<any>(`/books/${bookId}/characters/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (bookId: string, id: string) =>
    request<void>(`/books/${bookId}/characters/${id}`, { method: 'DELETE' }),
  autoAssignByName: (bookId: string) =>
    request<{ assigned: number; total_segments: number; matches: { segment_id: string; character_name: string }[] }>(
      `/books/${bookId}/characters/auto-assign-by-name`, { method: 'POST' }),
};

// ── Segments ──
export const segments = {
  list: (chapterId: string) => request<any[]>(`/chapters/${chapterId}/segments`),
  create: (chapterId: string, data: any) =>
    request<any>(`/chapters/${chapterId}/segments`, { method: 'POST', body: JSON.stringify(data) }),
  update: (chapterId: string, id: string, data: any) =>
    request<any>(`/chapters/${chapterId}/segments/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (chapterId: string, id: string) =>
    request<void>(`/chapters/${chapterId}/segments/${id}`, { method: 'DELETE' }),
  generate: (chapterId: string, id: string) =>
    request<{ audio_asset_id: string; cached: boolean }>(`/chapters/${chapterId}/segments/${id}/generate`, { method: 'POST' }),
  batchGenerate: (chapterId: string) =>
    request<{ results: any[]; summary: { total: number; generated: number; cached: number; failed: number } }>(
      `/chapters/${chapterId}/segments/batch-generate`, { method: 'POST' }),
};

// ── ElevenLabs ──
export const elevenlabs = {
  capabilities: () => request<any>('/elevenlabs/capabilities'),
  voices: () => request<any[]>('/elevenlabs/voices'),
  searchVoices: (q: string) => request<any[]>(`/elevenlabs/voices/search?q=${encodeURIComponent(q)}`),
  getVoice: (voiceId: string) => request<any>(`/elevenlabs/voices/${voiceId}`),
  searchLibrary: (params: { q?: string; gender?: string; language?: string; use_case?: string; page_size?: number }) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.gender) qs.set('gender', params.gender);
    if (params.language) qs.set('language', params.language);
    if (params.use_case) qs.set('use_case', params.use_case);
    if (params.page_size) qs.set('page_size', String(params.page_size));
    return request<{ voices: any[]; has_more: boolean }>(`/elevenlabs/voices/library?${qs.toString()}`);
  },
  tts: (data: any) => request<any>('/elevenlabs/tts', { method: 'POST', body: JSON.stringify(data) }),
  sfx: (data: { prompt: string; duration_seconds?: number; prompt_influence?: number; loop?: boolean; model_id?: string; book_id?: string }) =>
    request<{ audio_asset_id: string; cached: boolean }>('/elevenlabs/sfx', { method: 'POST', body: JSON.stringify(data) }),
  music: (data: { prompt: string; duration_seconds?: number; music_length_ms?: number; force_instrumental?: boolean; model_id?: string; book_id?: string }) =>
    request<{ audio_asset_id: string; cached: boolean }>('/elevenlabs/music', { method: 'POST', body: JSON.stringify(data) }),
  usage: () => request<any>('/elevenlabs/usage'),
};

// ── Timeline ──
export const timeline = {
  tracks: (bookId: string) => request<any[]>(`/books/${bookId}/tracks`),
  createTrack: (bookId: string, data: any) =>
    request<any>(`/books/${bookId}/tracks`, { method: 'POST', body: JSON.stringify(data) }),
  updateTrack: (bookId: string, trackId: string, data: any) =>
    request<any>(`/books/${bookId}/tracks/${trackId}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteTrack: (bookId: string, trackId: string) =>
    request<void>(`/books/${bookId}/tracks/${trackId}`, { method: 'DELETE' }),
  createClip: (bookId: string, trackId: string, data: any) =>
    request<any>(`/books/${bookId}/tracks/${trackId}/clips`, { method: 'POST', body: JSON.stringify(data) }),
  updateClip: (bookId: string, clipId: string, data: any) =>
    request<any>(`/books/${bookId}/clips/${clipId}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteClip: (bookId: string, clipId: string) =>
    request<void>(`/books/${bookId}/clips/${clipId}`, { method: 'DELETE' }),
  chapterMarkers: (bookId: string) => request<any[]>(`/books/${bookId}/chapter-markers`),
  updateChapterMarkers: (bookId: string, markers: any[]) =>
    request<void>(`/books/${bookId}/chapter-markers`, { method: 'PUT', body: JSON.stringify({ markers }) }),
  populate: (bookId: string, chapterIds?: string[]) =>
    request<{ tracks: any[]; clips_created: number; markers_created: number; total_duration_ms: number }>(
      `/books/${bookId}/populate`, { method: 'POST', body: JSON.stringify({ chapter_ids: chapterIds }) }),
  generateAndPopulate: (bookId: string, chapterIds?: string[]) =>
    request<{
      tts: { generated: number; cached: number; skipped: number; failed: number; errors: string[] };
      timeline: { clips_created: number; markers_created: number; total_duration_ms: number };
    }>(`/books/${bookId}/generate-and-populate`, { method: 'POST', body: JSON.stringify({ chapter_ids: chapterIds }) }),
};

// ── Import ──
export const importManuscript = async (bookId: string, file: File) => {
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch(`${API_BASE}/books/${bookId}/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}` },
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Import failed' }));
    throw new Error(err.error);
  }

  return res.json();
};

// ── Render ──
export const render = {
  start: (bookId: string, data?: { type?: string; chapter_id?: string }) =>
    request<{ job_id: string }>(`/books/${bookId}/render`, { method: 'POST', body: JSON.stringify(data || {}) }),
  status: (bookId: string, jobId: string) =>
    request<any>(`/books/${bookId}/render/${jobId}`),
};

// ── Export ──
export const exportBook = {
  start: (bookId: string, target = 'acx') =>
    request<any>(`/books/${bookId}/export`, { method: 'POST', body: JSON.stringify({ target }) }),
  status: (bookId: string, exportId: string) =>
    request<any>(`/books/${bookId}/export/${exportId}`),
  downloadUrl: (bookId: string, exportId: string) =>
    `${API_BASE}/books/${bookId}/export/${exportId}/download`,
};

// ── Audio ──
export const audioUrl = (assetId: string) => `${API_BASE}/audio/${assetId}`;

// ── Settings ──
export const settings = {
  getAll: () => request<Record<string, { value: string; masked: string; updated_at: string }>>('/settings'),
  set: (key: string, value: string) =>
    request<{ ok: boolean }>(`/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) }),
  delete: (key: string) => request<void>(`/settings/${key}`, { method: 'DELETE' }),
};

// ── Save ──
export const saveProject = () => request<{ ok: boolean; saved_at: string }>('/save', { method: 'POST' });

// ── Download Project ──
export const downloadProjectUrl = (bookId: string) => `${API_BASE}/books/${bookId}/download-project`;

// ── AI Parse ──
export const aiParse = {
  parse: (bookId: string, chapterIds?: string[]) =>
    request<{
      characters_created: number; segments_created: number;
      sfx_cues: number; music_cues: number;
      provider: string; format: string; project_type: string;
    }>(`/books/${bookId}/ai-parse`, {
      method: 'POST', body: JSON.stringify({ chapter_ids: chapterIds }),
    }),
  suggestV3Tags: (bookId: string, text: string) =>
    request<{ tagged_text: string; tags_used: string[]; provider: string }>(
      `/books/${bookId}/ai-parse/v3-tags`, {
        method: 'POST', body: JSON.stringify({ text }),
      }),
};

// ── Pronunciation Rules ──
export const pronunciation = {
  list: (bookId: string) => request<any[]>(`/books/${bookId}/pronunciation`),
  create: (bookId: string, data: { word: string; phoneme?: string; alias?: string; character_id?: string }) =>
    request<any>(`/books/${bookId}/pronunciation`, { method: 'POST', body: JSON.stringify(data) }),
  update: (bookId: string, ruleId: string, data: any) =>
    request<any>(`/books/${bookId}/pronunciation/${ruleId}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (bookId: string, ruleId: string) =>
    request<void>(`/books/${bookId}/pronunciation/${ruleId}`, { method: 'DELETE' }),
  apply: (bookId: string, text: string, characterId?: string) =>
    request<{ original: string; processed: string; rules_applied: number }>(
      `/books/${bookId}/pronunciation/apply`, { method: 'POST', body: JSON.stringify({ text, character_id: characterId }) }),
};

// ── Audio Upload ──
export const uploadAudio = async (bookId: string, file: File, name?: string) => {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('book_id', bookId);
  if (name) formData.append('name', name);

  const res = await fetch(`${API_BASE}/audio/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}` },
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Upload failed' }));
    throw new Error(err.error);
  }
  return res.json();
};

// ── Usage Stats ──
export const usageStats = {
  elevenlabs: () => request<any>('/elevenlabs/usage'),
  local: () => request<{
    total_characters_used: number;
    total_generations: number;
    total_assets: number;
    total_size_bytes: number;
    per_book: any[];
    recent_activity: any[];
  }>('/elevenlabs/usage/local'),
};
