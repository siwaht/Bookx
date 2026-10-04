/**
 * Storage keys, shared by the app server and the Cloudflare Worker.
 *
 * Every object Bookx stores lives under `bookx/{projectId}/…`, so the project
 * id in the key is what ownership is checked against before anything is served.
 */
export const PROJECT_KEY = /^bookx\/([^/]+)\//;

/** The project that owns `key`, or null for a key outside the Bookx layout. */
export function projectIdFromKey(key: string): string | null {
  return key.match(PROJECT_KEY)?.[1] ?? null;
}

/**
 * Validates a key before it touches a filesystem or a bucket.
 *
 * Keys are generated server-side, but the storage route receives them from the
 * URL, so anything that could climb out of the storage root is refused.
 */
export function isSafeStorageKey(key: string): boolean {
  if (!key || key.length > 512) return false;
  if (key.includes("\0")) return false;
  const parts = key.split("/");
  return parts.every(part => part.length > 0 && part !== "." && part !== ".." && !/[:*?"<>|\\]/.test(part));
}

/** The path prefix the app serves stored objects from. */
export const STORAGE_URL_PREFIX = "/api/storage";

/**
 * The path a browser fetches an object from.
 *
 * The app serves this itself, under its own `/api/` prefix, rather than reusing
 * `/manus-storage/`. On Manus that path belongs to the platform: it answers a
 * request that carries no credentials straight from the bucket, but hands a
 * request that carries a session to the container under a path the app never
 * sees, so the same URL played in a private window and returned 404 for a
 * signed-in page. `/manus-storage/` is still served for objects the platform or
 * the Cloudflare Worker publishes there.
 */
export function storageUrl(key: string, options: { download?: boolean; name?: string } = {}): string {
  const path = `${STORAGE_URL_PREFIX}/${key}`;
  if (!options.download) return path;
  const name = options.name ? `&name=${encodeURIComponent(options.name)}` : "";
  return `${path}?download=1${name}`;
}
