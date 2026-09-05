/** Isolate-scoped cache of a textbook's chunk pool and its derived lesson map.
 *
 * Generating a test reads up to 500 chunks of a book — roughly half a
 * megabyte of Japanese text — and then walks every one of them looking for
 * 第N課 headers to work out which lesson each page belongs to. Both are
 * pure functions of a document that changes only when `ingest push` runs,
 * and both were being paid again on every single generation. A student
 * pressing "New Test" three times in a row paid for them three times.
 *
 * Course material, so there is nothing per-student in here and nothing that
 * RLS would have filtered differently for the next caller — the same rows
 * for everyone, which is what makes a shared cache safe at all. Student
 * uploads never reach it: tests are drawn from citable textbooks only.
 *
 * Scope is the worker isolate, like the provider health in `providers.ts`,
 * so a re-ingest is picked up when isolates recycle or the TTL lapses,
 * whichever comes first. The TTL is what bounds how long a freshly pushed
 * chapter can stay invisible.
 */

const TTL_MS = 10 * 60 * 1000;

/** Two books is the student working set: they sit tests from one textbook,
 * and the second slot covers the one they just switched from. Two more slots
 * cover the past-paper exemplar pools, which are keyed by level rather than
 * by document and are read on every generation for that level — evicting one
 * to make room for a book would mean re-reading it on the next test. */
const MAX_ENTRIES = 4;

interface Entry<T> {
  value: T;
  storedAt: number;
}

/** Keys are a document id for a book's chunk pool, or a string like
 * "papers:F3" for a level's past-paper exemplars. One map rather than two
 * because they share an eviction budget and a staleness rule: both are
 * course material that changes only when `ingest push` runs. */
export type PoolKey = number | string;

const entries = new Map<PoolKey, Entry<unknown>>();

/** The cached pool for a key, or null when it is absent or stale. */
export function cachedPool<T>(key: PoolKey, now = Date.now()): T | null {
  const entry = entries.get(key);
  if (!entry) return null;
  if (now - entry.storedAt > TTL_MS) {
    entries.delete(key);
    return null;
  }
  // Refresh recency: the map's insertion order is what eviction reads.
  entries.delete(key);
  entries.set(key, entry);
  return entry.value as T;
}

export function rememberPool<T>(key: PoolKey, value: T, now = Date.now()): void {
  entries.delete(key);
  entries.set(key, { value, storedAt: now });
  while (entries.size > MAX_ENTRIES) {
    // Least recently used, which insertion order makes the first key.
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}

/** Test seam — no production caller. */
export function clearPoolCache(): void {
  entries.clear();
}
