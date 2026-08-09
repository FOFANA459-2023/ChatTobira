/** Shared health tracking for the model provider cascade.
 *
 * Some provider failures are permanent for the life of a deployment rather
 * than transient: an unfunded prepaid account (402), a revoked key (401), a
 * disabled project (403). Retrying those on every request buys nothing and
 * spends a round-trip of the student's latency budget to learn what the last
 * request already knew. Recording them here lets a cascade skip a tier that
 * has proven dead while leaving genuinely transient failures — rate limits,
 * outages — free to recover on the next request.
 *
 * Scope is the worker isolate, so this self-heals on deploy or restart. That
 * is deliberate: topping up a DeepSeek balance should not require a code
 * change, just enough time for isolates to recycle.
 */

const dead = new Set<string>();

/** HTTP statuses that will still be true a second from now. */
const PERMANENT = new Set([401, 402, 403]);

export function isProviderDead(name: string): boolean {
  return dead.has(name);
}

/** Record a failure, returning true when the provider was marked dead. */
export function noteProviderFailure(name: string, error: unknown): boolean {
  const status = (error as { statusCode?: number } | null)?.statusCode;
  if (status !== undefined && PERMANENT.has(status)) {
    dead.add(name);
    return true;
  }
  return false;
}

/** Test seam — no production caller. */
export function resetProviderHealth(): void {
  dead.clear();
}
