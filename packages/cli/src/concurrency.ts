/**
 * Run an async function over a list of items with bounded concurrency.
 *
 * - Preserves input order in the result array (result[i] corresponds to items[i]).
 * - Each `fn` invocation is independent. If `fn` rejects, that rejection
 *   propagates — callers that need catch-and-continue semantics MUST wrap `fn`
 *   to convert errors into a result variant.
 * - `limit <= 0` is treated as unbounded (effectively `Promise.all`).
 * - Empty input returns an empty array immediately without starting workers.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  if (items.length === 0) {
    return results
  }
  const effectiveLimit = limit <= 0 ? items.length : Math.min(limit, items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = next++
      if (i >= items.length)
        return
      results[i] = await fn(items[i], i)
    }
  }
  const workers: Promise<void>[] = []
  for (let i = 0; i < effectiveLimit; i++) {
    workers.push(worker())
  }
  await Promise.all(workers)
  return results
}
