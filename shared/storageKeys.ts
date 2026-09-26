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
