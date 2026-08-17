/**
 * Tiny concurrency-limited task runner. Used by long-running batch jobs
 * (TTS generation, background boost SFX/music generation) so very long
 * books process several items in parallel instead of one-at-a-time,
 * without overwhelming a TTS provider's rate limits.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  onItemDone?: (item: T, index: number, result: R | null, error: Error | null) => void,
): Promise<Array<{ item: T; index: number; result?: R; error?: Error }>> {
  const results: Array<{ item: T; index: number; result?: R; error?: Error }> = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length || 1));

  async function runNext(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index];
      try {
        const result = await worker(item, index);
        results[index] = { item, index, result };
        onItemDone?.(item, index, result, null);
      } catch (err: any) {
        results[index] = { item, index, error: err instanceof Error ? err : new Error(String(err)) };
        onItemDone?.(item, index, null, err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  const workers = Array.from({ length: size }, () => runNext());
  await Promise.all(workers);
  return results;
}
