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

/** Two books is the working set: a student sits tests from one textbook, and
 * the second slot covers the one they just switched from. A third would cost
 * another half megabyte of isolate memory to serve a case that does not
 * happen. */
const MAX_DOCUMENTS = 2;

interface Entry<T> {
  value: T;
  storedAt: number;
}

const entries = new Map<number, Entry<unknown>>();

/** The cached pool for a document, or null when it is absent or stale. */
export function cachedPool<T>(documentId: number, now = Date.now()): T | null {
  const entry = entries.get(documentId);
  if (!entry) return null;
  if (now - entry.storedAt > TTL_MS) {
    entries.delete(documentId);
    return null;
  }
  // Refresh recency: the map's insertion order is what eviction reads.
  entries.delete(documentId);
  entries.set(documentId, entry);
  return entry.value as T;
}

export function rememberPool<T>(documentId: number, value: T, now = Date.now()): void {
  entries.delete(documentId);
  entries.set(documentId, { value, storedAt: now });
  while (entries.size > MAX_DOCUMENTS) {
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
