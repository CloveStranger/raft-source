/**
 * Promise.all over `items` with at most `limit` calls in flight; results keep
 * the input order and the first rejection rejects the whole call (like
 * Promise.all). For per-item work that borrows pool connections: an unbounded
 * Promise.all over a long list can take every connection of the instance's
 * pool at once and queue every other request behind it.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workerCount = Math.max(1, Math.min(Math.trunc(limit), items.length));
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

/**
 * A gate that runs at most `limit` of the calls passed to it at once; the
 * rest wait their turn in call order. For work started from many places (one
 * per row of a page) that should share one bound.
 */
export function createConcurrencyLimiter(limit: number): <R>(fn: () => Promise<R>) => Promise<R> {
  const max = Math.max(1, Math.trunc(limit));
  let active = 0;
  const waiting: Array<() => void> = [];
  // A finishing call hands its slot straight to the next waiter (active stays
  // put), so no new caller can take the slot between the release and the
  // waiter resuming.
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
  return async <R>(fn: () => Promise<R>): Promise<R> => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    else active += 1;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}
