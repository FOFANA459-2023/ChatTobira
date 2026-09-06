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
 * Groq's free tier meters INPUT TOKENS PER MINUTE, and a single oversized
 * request is refused rather than queued. Measured against the live key on
 * 2026-09-06 with a 7,790-token prompt, the refusal is explicit:
 *
 *   HTTP 413 — "Request too large for model `qwen/qwen3.8-27b` … on input
 *   tokens per minute (ITPM): Limit 7000, Requested 7790"
 *
 * So the real number is 7,000, not the 8,000 this comment used to claim, and
 * it is a budget shared by every request in the deployment for that minute
 * rather than a per-request ceiling. 6,500 keeps a margin under it: a prompt
 * that only just fits on its own will still be refused when a classmate is
 * mid-question, and that refusal costs seconds of a student's turn to learn
 * nothing. Predicted here instead of discovered on every turn.
 *
 * The others have no ceiling worth modelling: deepseek-v4-flash took an
 * 8,300-token prompt in 1.3s to first token, and the Gemini context is far
 * larger than anything this app builds.
 */
const TOKEN_CEILING: Record<string, number> = { groq: 6500 };

export function canTakePrompt(name: string, tokens: number): boolean {
  const ceiling = TOKEN_CEILING[name];
  return ceiling === undefined || tokens <= ceiling;
}

/** How long a tier gets to ACCEPT a request before the next one is tried.
 *
 * The cascade used to fall through on rejection and only on rejection, which
 * quietly assumed that a provider either answers or says no. Measured on this
 * app on 2026-09-06, that is not what happens: an ordinary typed question
 * (~8,900 prompt tokens) sat on deepseek-v4-flash for 97 SECONDS before it
 * streamed, on an account and a model that answered an identical prompt in
 * 1.3s a minute earlier and a minute later. Nothing was wrong that the code
 * could see — the request had been accepted, and the promise the cascade
 * waits on simply never settled.
 *
 * In production that is worse than a failure. The route's own maxDuration is
 * 60s, so the student waits a minute and gets nothing at all — where a
 * fallback at ten seconds would have had Gemini answer them at twelve.
 *
 * The budgets are generous against what acceptance actually costs, because
 * the cost of being wrong is asymmetric: too short spends a fallback on a
 * tier that was about to answer, too long spends the student's whole turn.
 * Measured acceptance through the AI SDK is ~1.9s for DeepSeek and under a
 * second for Groq, both including the reasoning models' first thinking token.
 *
 * `typed` came down from 12s once Groq led the chain again: 12 seconds of
 * silence was being spent discovering that DeepSeek had stalled, on a turn
 * Groq then answered in under a second. 8s is still three times the healthy
 * DeepSeek acceptance, and it is only ever paid on the large prompts where
 * DeepSeek leads because Groq cannot take them.
 *
 * `structured` is a whole generation rather than an acceptance — generateObject
 * returns a finished paper or nothing — so it is measured against 6.2s for
 * gpt-oss-120b on a real fifteen-item paper. 25s rather than the 45s it was
 * first given, because the budget has to leave room for the REST of the chain:
 * the route's ceiling is 60s, and a first tier allowed to burn 45 of them
 * leaves no time to fall back, which turns one slow provider into a failed
 * request. Three tiers at 25s still fit.
 */
export const ACCEPT_BUDGET_MS = { spoken: 6_000, typed: 8_000, structured: 25_000 } as const;

/** Reject if `work` has not settled within `ms`.
 *
 * The loser of the race is not cancelled by this — cancelling is the caller's
 * job, because only the caller holds the AbortController that can stop the
 * stream it started. Leaving that here would abort a stream that a later
 * `await` still holds a reference to.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, label = "timeout"): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
    }),
    // Clearing the timer matters in a Worker: a pending timer keeps the
    // isolate's event loop alive after the response has been returned.
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Test seam — no production caller. */
export function resetProviderHealth(): void {
  dead.clear();
  consecutiveFailures.clear();
}
