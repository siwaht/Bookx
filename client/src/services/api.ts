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
  update: (bookId: string, id: string, data: any) =>
    request<any>(`/books/${bookId}/chapters/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  reorder: (bookId: string, ids: string[]) =>
    request<void>(`/books/${bookId}/chapters/reorder`, { method: 'POST', body: JSON.stringify({ ids }) }),
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
  tts: (data: any) => request<any>('/elevenlabs/tts', { method: 'POST', body: JSON.stringify(data) }),
  sfx: (data: any) => request<any>('/elevenlabs/sfx', { method: 'POST', body: JSON.stringify(data) }),
  music: (data: any) => request<any>('/elevenlabs/music', { method: 'POST', body: JSON.stringify(data) }),
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
