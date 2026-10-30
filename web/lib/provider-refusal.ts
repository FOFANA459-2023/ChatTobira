/** When the AI provider is refusing everything, and what to tell the student.
 *
 * Every feature here reaches the same Google key, and every one of them can be
 * told "no" for the same two reasons: the account cannot pay, or the key is
 * not valid. Each feature used to recognise that for itself, so the same
 * outage read as a different fault in each place — a live session that
 * "dropped", a chat answer that "went wrong" — and a student was invited to
 * retry a thing no amount of retrying fixes.
 *
 * This is the one place that recognises it and the one sentence that says so.
 * It carries no provider client and no server-only code, so a browser hook
 * imports it as freely as a route handler does.
 */

/** Text that means the provider will refuse the NEXT attempt too.
 *
 * The live features mint a token and then open a socket. Minting is an auth
 * call and keeps working when the account cannot pay; the socket opens, says
 * setupComplete, and only dies when the model is actually asked to produce
 * something — with the real reason in the close frame:
 *
 *   1011 Your prepayment credits are depleted. Please go to AI Studio ...
 *
 * Reconnecting from there mints another token, and minting is what SPENDS a
 * student's allowance. A lecture could therefore burn fifty minutes in a few
 * seconds on an account with no credit, and tell the student their network had
 * dropped. So a close that matches this is final: do not reconnect, and say
 * what actually happened.
 *
 * Chat meets the same refusal through a plain HTTP status, since the question
 * has to be embedded before the corpus can be searched:
 *
 *   402 RESOURCE_EXHAUSTED Your prepayment credits are depleted. ...
 *
 * Matched on the reason text rather than the code, because neither code is
 * diagnostic on its own. 1011 is "internal error" and is also what a transient
 * server hiccup sends — those SHOULD reconnect, and treating them as final
 * would break the recovery that keeps a lecture alive through a blip.
 */
const PERMANENT_REFUSAL =
  /prepayment credits|credits are depleted|billing|quota|RESOURCE_EXHAUSTED|PERMISSION_DENIED|API key not valid|API_KEY_INVALID|exceeded your current/i;

export function isPermanentRefusal(reason: string | undefined | null): boolean {
  return Boolean(reason && PERMANENT_REFUSAL.test(reason));
}

/** What to tell the student when that happens.
 *
 * It is the server's bill, not their mistake and not their connection, and
 * there is nothing for them to retry — so the sentence says so and names who
 * can fix it. Deliberately free of "credits" arithmetic a student might read
 * as their own allowance running out.
 */
export const PROVIDER_REFUSED_TEXT =
  "The server's AI service is unavailable — this is not your connection and not your allowance. Please tell the course administrator at fvarlee@gmail.com.";
