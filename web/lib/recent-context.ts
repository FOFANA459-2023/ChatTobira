/** The passages this conversation was just grounded in.
 *
 * A follow-up is the turn this app has always been worst at, and it is worst
 * at it in two opposite ways at once.
 *
 * When the follow-up is conversational — "why?", "なるほど", "really?" — the
 * intent classifier correctly skips retrieval, because searching the corpus
 * for the word "why" returns noise and costs a second. But skipping retrieval
 * used to mean skipping GROUNDING: the model answered "why?" about 〜ておく
 * with no textbook in front of it at all, one turn after having six passages
 * of it. The material had not stopped being relevant; the app had simply
 * thrown it away and had no way to get it back without paying for it again.
 *
 * When the follow-up does need the corpus, re-searching from scratch is a
 * different failure: the student says "what about the next example?" and a
 * fresh global search on those five words goes somewhere else entirely, which
 * is how a conversation about 〜ておく turns into a page about 例文.
 *
 * So the last turn's context is kept. It costs nothing to keep — the chunks
 * were already fetched and paid for — and it is exactly what a follow-up is
 * about, because a follow-up is by definition about what came before it.
 *
 * Scope is the worker isolate, like `corpus-cache.ts`: a miss is not an error,
 * it is the old behaviour, so nothing depends on this surviving anything.
 */

import type { RetrievedChunk } from "./retrieval";

/** How many conversations to remember at once.
 *
 * Small on purpose. This is a latency and coherence aid for the turn
 * immediately after a retrieval, not a session store, and an isolate serving
 * a class of students should not hold half a megabyte of Japanese per
 * conversation for the ones who wandered off. */
const MAX_CONVERSATIONS = 24;

/** How long a turn's context stays relevant.
 *
 * Ten minutes: long enough to cover a student thinking about an answer before
 * asking the obvious next thing, short enough that "why?" typed after lunch
 * gets a fresh search rather than the morning's pages. */
const TTL_MS = 10 * 60 * 1000;

interface Remembered {
  chunks: RetrievedChunk[];
  at: number;
}

const recent = new Map<string, Remembered>();

/** A key for a conversation that exists whether or not it has a database row.
 *
 * Signed-in students have a conversation id. Trial visitors do not — they have
 * no row at all — so their first question stands in for one: it is stable for
 * the life of the conversation and different between conversations, which is
 * the whole requirement. */
export function conversationKey(
  conversationId: number | undefined,
  firstUserTurn: string,
): string | null {
  if (conversationId) return `c${conversationId}`;
  const seed = firstUserTurn.trim().slice(0, 64);
  return seed ? `q${seed}` : null;
}

/** Keep this turn's context for the next one. */
export function rememberContext(key: string | null, chunks: RetrievedChunk[]): void {
  if (!key || chunks.length === 0) return;
  // Re-inserting moves the key to the end of the iteration order, so the
  // eviction below drops the conversation nobody has touched for longest
  // rather than the one that happens to be oldest.
  recent.delete(key);
  recent.set(key, { chunks, at: Date.now() });

  while (recent.size > MAX_CONVERSATIONS) {
    const oldest = recent.keys().next().value;
    if (oldest === undefined) break;
    recent.delete(oldest);
  }
}

/** What this conversation was grounded in a moment ago, if anything. */
export function recallContext(key: string | null): RetrievedChunk[] {
  if (!key) return [];
  const found = recent.get(key);
  if (!found) return [];
  if (Date.now() - found.at > TTL_MS) {
    recent.delete(key);
    return [];
  }
  return found.chunks;
}

/** Test seam — no production caller. */
export function resetRecentContext(): void {
  recent.clear();
}
