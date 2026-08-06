/**
 * FounderOS — bounded parallelism
 * ===============================
 * One helper, because "run these independent async calls, but not all at once"
 * came up twice in the job pipeline and both copies would have drifted.
 *
 * Bounded rather than unbounded is the whole point. The calls this runs are HTTP
 * requests to third-party hosts, and a burst of dozens against one host reads as
 * abuse to that host's rate limiter — which turns a live job posting into an
 * unverifiable one and defeats the reason for making the call at all.
 */

/**
 * Run `fn` over `items` with at most `limit` calls in flight, returning results
 * in INPUT order regardless of which call finishes first.
 *
 * A small fixed pool of workers each pull the next unclaimed index off a shared
 * cursor and write their result to that index, so completion order never reaches
 * the output. Callers depend on position — a liveness verdict is matched to its
 * posting by index — and an order that varies with network timing would be a bug
 * that only appears under load.
 *
 * `fn` is expected to handle its own failures and return a value. A rejection
 * propagates and abandons the remaining work, which is correct for a programming
 * error and wrong for an expected network failure: callers turn those into
 * result values instead.
 *
 * A limit below 1 THROWS rather than being clamped. Clamping looks kinder and is
 * worse: zero workers would resolve `Promise.all([])` immediately and hand back
 * an array of holes that every caller would read as real results — a shortlist
 * nobody verified, or a sweep that polled nothing, reported as success. It is
 * unreachable while every caller passes a constant, and it is exactly the kind of
 * silent wrong answer that surfaces the day one of them becomes configurable.
 */
export async function mapWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) {
    throw new Error(`mapWithConcurrencyLimit needs a limit of at least 1, got ${limit}.`);
  }

  const results: R[] = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index] as T);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
