/** Anonymous trial metering.
 *
 * A visitor may sample the platform before signing in. The count lives in a
 * cookie, so a determined visitor can clear it — this is a taster, not a
 * security boundary. The real gate stays the invite: everything that persists
 * anything (history, quotas, feedback) requires a session.
 *
 * Chat and quizzes are metered separately because they are different tastes of
 * the product and one should not consume the other. A visitor who asks three
 * questions can still sit one practice test.
 */

export const TRIALS = {
  chat: { cookie: "tobira_trial", limit: 3 },
  quiz: { cookie: "tobira_quiz_trial", limit: 1 },
} as const;

export type TrialKind = keyof typeof TRIALS;

/** How much of this trial the caller has already spent. */
export function trialUsed(request: Request, kind: TrialKind): number {
  const { cookie } = TRIALS[kind];
  const match = request.headers
    .get("cookie")
    ?.match(new RegExp(`(?:^|;\\s*)${cookie}=(\\d+)`));
  const used = match ? Number(match[1]) : 0;
  return Number.isFinite(used) && used > 0 ? used : 0;
}

export function trialExhausted(request: Request, kind: TrialKind): boolean {
  return trialUsed(request, kind) >= TRIALS[kind].limit;
}

/** Set-Cookie recording one more use. HttpOnly so page scripts cannot reset
 * it casually; a year matches "you have already tried this". */
export function trialCookie(kind: TrialKind, used: number): string {
  return `${TRIALS[kind].cookie}=${used}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`;
}
