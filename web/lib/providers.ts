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
const consecutiveFailures = new Map<string, number>();

/** HTTP statuses that will still be true a second from now. */
const PERMANENT = new Set([401, 402, 403]);

/** After this many failures in a row with no success between, a provider is
 * treated as dead whatever it claimed the reason was.
 *
 * Needed because the reason is usually unavailable. Measured on the live
 * cascade, both failing tiers surfaced through the AI SDK as "No output
 * generated. Check the stream for errors." — no status code, nothing to
 * classify — and so were retried on every single turn: seven seconds on
 * Groq rejecting an oversized prompt, one on DeepSeek reporting an unfunded
 * balance, before Gemini answered. Eight of a ten-second turn spent learning
 * what the previous turn already knew.
 *
 * Three rather than one, because a genuine rate limit or a blip should cost a
 * fallback and not a whole isolate's worth of exile.
 */
const FAILURES_BEFORE_DEAD = 3;

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
  const failures = (consecutiveFailures.get(name) ?? 0) + 1;
  consecutiveFailures.set(name, failures);
  if (failures >= FAILURES_BEFORE_DEAD) {
    dead.add(name);
    return true;
  }
  return false;
}

/** A provider answered. Whatever was wrong with it is over. */
export function noteProviderSuccess(name: string): void {
  consecutiveFailures.delete(name);
  dead.delete(name);
}

/** Roughly how many tokens this text will cost.
 *
 * Deliberately crude and deliberately pessimistic. Japanese runs close to one
 * token per character where English runs nearer a quarter, so the two are
 * counted separately and the total rounded up. It only has to be good enough
 * to answer one question — will this prompt fit? — and being wrong in the
 * generous direction costs a fallback, while being wrong the other way costs
 * the seven-second rejection this exists to avoid.
 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[぀-ヿ一-鿿ｦ-ﾟ]/g) ?? []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk + rest / 3);
}

/** Can this provider take a prompt this size?
 *
 * Groq's free tier allows 8,000 tokens a minute, and a single oversized
 * request is refused rather than queued — after roughly seven seconds. That
 * refusal is predictable from the prompt, so it is predicted here instead of
 * discovered on every turn. The others have no ceiling worth modelling: the
 * Gemini context is far larger than anything this app builds.
 */
const TOKEN_CEILING: Record<string, number> = { groq: 6500 };

export function canTakePrompt(name: string, tokens: number): boolean {
  const ceiling = TOKEN_CEILING[name];
  return ceiling === undefined || tokens <= ceiling;
}

/** Test seam — no production caller. */
export function resetProviderHealth(): void {
  dead.clear();
  consecutiveFailures.clear();
}
