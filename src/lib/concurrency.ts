/**
 * Bounded parallelism for async work (e.g. several Gemini calls at once).
 */

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.floor(concurrency));
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }

  const pool = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: pool }, () => worker()));
  return results;
}
