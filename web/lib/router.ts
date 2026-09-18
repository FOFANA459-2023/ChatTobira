/** Which model answers which turn.
 *
 * This used to be one order — Groq, then DeepSeek, then Gemini — written into
 * the chat route and repeated, differently, in the quiz route. One order
 * cannot be right for every job, because the jobs differ in the only two
 * things that decide: how big the prompt is, and whether anybody is waiting.
 *
 * The order below is measured, not assumed. Every number here came from
 * calling the three providers with this app's own prompts and keys, streaming,
 * timing the first CONTENT token rather than the first byte (a reasoning model
 * streams thought before it streams an answer, and the student hears nothing
 * during the thinking).
 *
 * THIS BLOCK IS THE 2026-09-06 READING, KEPT FOR ITS SHAPE AND NOT FOR ITS
 * ORDER. It was taken against a FREE Google key rationed to twenty requests a
 * day, which is why every conclusion in it puts Gemini last. The key is paid
 * now and the order has been re-measured — see the block above PREFERENCE,
 * which is the one that decides. What survives from this reading is the method
 * and the two facts that did not change: Groq's ceiling is shared across the
 * deployment, and deepseek-v4-pro is not a chat model for this app.
 *
 *   Short conversational turn (~120 prompt tokens, 「昨日、友達と京都に行きました。」)
 *     groq qwen/qwen3.8-27b     0.42s total          free tier
 *     deepseek-v4-flash         1.24s TTFT, 1.35s    66 of 76 output tokens were reasoning
 *     deepseek-v4-pro           1.99s TTFT, 2.15s
 *
 *   RAG-grounded answer (~1,900 prompt tokens, textbook context + question)
 *     groq qwen/qwen3.8-27b     0.55s TTFT, 1.25s
 *     deepseek-v4-flash         2.28s TTFT, 3.76s
 *     deepseek-v4-pro          11.07s TTFT, 13.34s
 *
 *   Large RAG answer (~8,300 prompt tokens — an ordinary typed question with
 *   six passages of context)
 *     groq                      HTTP 413: "Limit 7000, Requested 7790" (ITPM)
 *     deepseek-v4-flash         1.30s TTFT, 2.39s    2,048 tokens served from cache
 *     deepseek-v4-pro          11.76s TTFT, 14.10s
 *
 * Three conclusions, and they are the whole of this file:
 *
 * 1. Groq is the fastest thing in the stack by a factor of three, and free —
 *    but its ceiling is a SHARED 7,000 input tokens per minute across the
 *    whole deployment, not a per-request limit. A single typed question with
 *    a full context block is most of that budget, so at classroom scale Groq
 *    can serve roughly one typed question a minute before it starts refusing.
 *    It is therefore the right tier for small prompts and the wrong tier for
 *    the app's main job.
 *
 * 2. deepseek-v4-flash has no daily cap, holds an 8,300-token prompt without
 *    complaint, gets FASTER on the large prompt than the small one (prompt
 *    caching: 2,048 tokens hit on the second call), and costs a fraction of a
 *    cent a turn against a topped-up balance. It was the right primary for
 *    grounded text answers while Gemini was rationed. It is no longer the
 *    primary and it is still all of those things, which is exactly why it is
 *    still in the cascade: it is the tier that absorbs a prompt nothing else
 *    will take, on a day when the paid key is rate-limited.
 *
 * 3. deepseek-v4-pro is not a chat model for this app at any prompt size.
 *    Eleven seconds to a first word is not a conversation. It is listed
 *    nowhere below.
 *
 * The router returns an ORDER, not a model: the routes own the SDK clients
 * and this file owns the policy, which is what makes the policy testable
 * without a network.
 */

import { canTakePrompt, isProviderDead } from "./providers";

export type Provider = "groq" | "deepseek" | "google";

/** What the model is being asked to do. The task, not the route: the chat
 * route serves two of these and the difference between them is larger than
 * the difference between the routes. */
export type ModelTask =
  /** A spoken turn in a live conversation. Short prompt, two-sentence reply,
   * and a student standing there waiting for it. Latency outranks everything;
   * the context block is two passages, so Groq's ceiling is not in play. */
  | "voice_turn"
  /** A typed, grounded explanation. Six passages of textbook, an answer the
   * student reads rather than hears, and a prompt that routinely exceeds what
   * Groq's free tier will accept. */
  | "chat_answer"
  /** A practice paper, through generateObject. Not interactive — the student
   * pressed "New Test" and expects to wait — and the output is validated
   * before it is shown, so a tier that returns a malformed paper simply falls
   * through to the next one. */
  | "structured";

export interface Tier {
  provider: Provider;
  /** The model id to ask that provider for. */
  model: string;
  /** What health and logging are tracked against, and what `models` overrides
   * are keyed by.
   *
   * Distinct from `provider` because one provider can appear twice in one
   * cascade: the structured task asks Google for Pro and then, if that fails,
   * for the flash model behind it. Keying health on the provider would let a
   * Pro timeout take the flash tier down with it, which is the opposite of
   * what a fallback is for.
   *
   * The cost of the split is one wasted call per isolate on a bad KEY rather
   * than a bad model — a 401 marks `google-pro` dead, the flash tier is tried,
   * it 401s too, and both are dead from then on. One round trip, once, in
   * exchange for the two tiers failing independently the rest of the time.
   */
  key: string;
  /** How many tokens a Gemini model may spend thinking before it answers.
   *
   * Undefined means "whatever the model does by default", which is the right
   * answer for the flash tiers: measured on this app's own prompts they spend
   * 0–97 tokens reasoning and setting a budget changes nothing.
   *
   * It is not the right answer for Pro, and that is the whole reason this
   * field exists — see the structured slot below.
   */
  thinkingBudget?: number;
  /** Whose configuration this tier uses — its model override and its output
   * budget. The same as `key` except for a retry, which is a second attempt
   * at another tier and must be configured exactly as that tier is, while
   * still failing and recovering on its own. */
  config: string;
}

export interface RouteOptions {
  /** Roughly how many tokens the prompt will cost. Decides whether Groq can
   * be offered at all. */
  promptTokens?: number;
  /** Providers whose keys this deployment actually has. Google is assumed:
   * it is the last resort and the route checks for its key before calling. */
  hasDeepSeek?: boolean;
  /** Model ids by tier KEY, so a deploy can move a tier without a code
   * change. Keys are the ones in PREFERENCE below — "google-pro" is its own
   * key, so the paper model and the chat model are set separately. */
  models?: Partial<Record<string, string>>;
}

/** One position in a cascade. */
interface Slot {
  key: string;
  provider: Provider;
  model: string;
  thinkingBudget?: number;
  /** For a retry: the tier it repeats. See Tier.config. */
  retries?: string;
}

/* ---------------------------------------------------------------------- *
 * The 2026-09-18 re-measurement, after the Google key moved to a paid plan
 *
 * Everything below this line changed for one reason: Gemini stopped being the
 * rationed last resort. The old order was built around a Google key metered
 * at twenty requests a day, which made Gemini the tier you reached for when
 * the others had failed and never the tier you asked first. On a paid key it
 * is simply the fastest thing in the stack that can also hold a full prompt,
 * and the order that was right under rationing is now wrong on every axis.
 *
 * Re-measured with this app's own prompts and keys, streaming, timing the
 * first CONTENT token:
 *
 *   Spoken turn (~80 prompt tokens)
 *     groq qwen/qwen3.8-27b          0.62s
 *     google gemini-3.5-flash-lite   0.77s
 *     deepseek-v4-flash              1.33s
 *     google gemini-3.8-flash        3.81s
 *     google gemini-pro-latest       7.46s
 *
 *   Typed RAG answer (~4,600 prompt tokens, six passages of textbook)
 *     google gemini-3.5-flash-lite   0.94s
 *     google gemini-3.8-flash        4.19s   (1.37s with thinking off)
 *     deepseek-v4-flash              5.22s
 *     google gemini-pro-latest      10.12s
 *     groq qwen/qwen3.8-27b          HTTP 429: over the shared ITPM ceiling
 *
 * The typed row is the one that matters, because it is most of what this app
 * does: flash-lite answers it five and a half times faster than the tier that
 * was leading the cascade. That is the single largest latency change in this
 * commit and it costs nothing — the prompt is the same prompt.
 * ---------------------------------------------------------------------- */

/** The preference order per task, before health and size are considered.
 *
 * Nothing here is filtered unconditionally any more. The old rule — "Google is
 * never filtered, it is the last resort" — existed to stop a health check
 * emptying the cascade, and it stopped being true the moment Google moved to
 * the FRONT of two of these three lists: a rule that refuses to skip a dead
 * first tier is not a safety net, it is a guaranteed wasted round trip. The
 * emptiness it guarded against is handled directly in `routeModels` instead.
 */
const PREFERENCE: Record<ModelTask, Slot[]> = {
  // Groq still leads on the clock — 0.62s against flash-lite's 0.77s — and a
  // spoken prompt is small by design, so it is the one job that reliably fits
  // inside the free tier's shared input budget.
  //
  // What changed is second place. DeepSeek sat there at 1.33s and is now
  // behind flash-lite at 0.77s, which is worth having: second place is not a
  // hypothetical on a tier metered per MINUTE across the whole deployment.
  // Two classmates speaking at once is enough to push the second one down a
  // tier, and that student now waits 0.77s instead of 1.33s.
  voice_turn: [
    { key: "groq", provider: "groq", model: "qwen/qwen3.8-27b" },
    { key: "google", provider: "google", model: "gemini-3.5-flash-lite" },
    { key: "deepseek", provider: "deepseek", model: "deepseek-v4-flash" },
  ],

  // Gemini first, and this is the change the app will be judged on.
  //
  // DeepSeek led here because it was the only paid tier that could hold six
  // passages of textbook: Groq answers 413 over its shared 7,000-token input
  // ceiling, and Gemini was rationed to twenty requests a day. Both halves of
  // that reasoning are now false, and on the same prompt flash-lite answers in
  // 0.94s where DeepSeek takes 5.22s. Nothing about the prompt changed; the
  // key did.
  //
  // Groq stays second rather than first. It is marginally faster on the small
  // prompts it can take, but `canTakePrompt` skips it for most real questions
  // anyway, and putting a tier that usually cannot answer ahead of one that
  // always can buys a wasted round trip far more often than a saved 150ms.
  //
  // DeepSeek stays last and stays valuable: uncapped, cheap, and the tier that
  // absorbs an oversized prompt on a day when the Google key is rate-limited.
  // It is demoted from primary, not dropped.
  chat_answer: [
    { key: "google", provider: "google", model: "gemini-3.5-flash-lite" },
    { key: "groq", provider: "groq", model: "qwen/qwen3.8-27b" },
    { key: "deepseek", provider: "deepseek", model: "deepseek-v4-flash" },
  ],

  // A paper is not interactive — the student pressed "New Test" and the app
  // shows a loading state — but it is not unbounded either, and that is the
  // correction this order encodes. Pro led this list on quality and the
  // quality was real: measured across four papers it kept every item the
  // validator looked at where every other tier lost some. What it also did
  // was take 22 to 48 seconds, and on one run 56 — past this route's own
  // 55-second deadline, which is a paper that never arrives at all.
  //
  // Re-measured on six-section papers against the real corpus, two runs of
  // each setting, through the full validate pipeline:
  //
  //   model                     time        six-section papers   failures in 8 runs
  //   gemini-3.8-flash +128     8.2-12.5s   4-6 of 6 sections    0
  //   gemini-3.8-flash +0       8.4-23.1s   3-6 of 6             1 schema failure
  //   gemini-3.8-flash +512     8.7-59.1s   3-6 of 6             2, one of them 59s
  //   gemini-pro-latest +128    22.3-47.8s  always the full plan 0
  //   gemini-3.5-flash-lite     8.2-17.1s   3-6 of 6             0, worst coverage
  //
  // 128 is the only budget at which 3.8-flash did not fail once, and it is
  // three to four times faster than Pro. Neither 0 nor 512 is a safe default:
  // both produced "response did not match schema" — a thinking budget is a
  // target and pushing it to either extreme makes the JSON less reliable, not
  // more.
  //
  // So speed leads and Pro backs it up. A paper that comes back in ten
  // seconds and is missing one of six sections is a better paper than one
  // that takes forty-eight, and the gate below it was relaxed to say so: the
  // sat papers themselves run to between three and seven 問題.
  //
  // flash-lite is not here any more. It is as fast as 3.8-flash and returned
  // three of six sections on a kanji paper, which is the one thing this list
  // is ordered to avoid.
  //
  // The fast tier is asked TWICE before Pro. Its papers vary run to run —
  // measured, the same Foundation 2 kanji prompt came back with six sections,
  // then four, then six — so a short paper from it is usually bad luck rather
  // than a prompt it cannot do, and a second ten-second attempt beats a
  // thirty-to-fifty-second one. Temperature is 0.8, so the retry is a
  // different paper, not the same one again.
  structured: [
    { key: "google-fast", provider: "google", model: "gemini-3.8-flash", thinkingBudget: 128 },
    {
      key: "google-fast-retry",
      provider: "google",
      model: "gemini-3.8-flash",
      thinkingBudget: 128,
      retries: "google-fast",
    },
    { key: "google-pro", provider: "google", model: "gemini-pro-latest", thinkingBudget: 128 },
    { key: "groq", provider: "groq", model: "openai/gpt-oss-120b" },
  ],
};

/** The models to try, in order, for this task right now.
 *
 * Filtered by three things: whether the deployment has the key, whether the
 * tier has proven dead this isolate, and whether the prompt fits. The last is
 * the one that earns its place — an oversized request to Groq is not a failure
 * that costs nothing, it is seven seconds of the student's turn spent being
 * told no.
 *
 * Health is checked per TIER and not per provider, so a Pro that keeps timing
 * out does not take the flash tier behind it down as well. A key-level failure
 * still takes everything on that key down, one tier at a time; see Tier.key.
 */
export function routeModels(task: ModelTask, options: RouteOptions = {}): Tier[] {
  const { promptTokens = 0, hasDeepSeek = true, models = {} } = options;

  const configured = PREFERENCE[task].filter(
    (slot) => slot.provider !== "deepseek" || hasDeepSeek,
  );
  const usable = configured.filter(
    (slot) => !isProviderDead(slot.key) && canTakePrompt(slot.provider, promptTokens),
  );

  // A health check must never empty the cascade. It used to be stopped from
  // doing that by exempting Google, which worked only while Google was last;
  // now that it leads two of the three lists, the guard has to be about
  // emptiness rather than about one provider.
  //
  // Falling back to the LAST configured tier rather than the first is
  // deliberate: if everything is marked dead we are already on a bad day, and
  // the bottom of a cascade is the tier chosen to be the one that still
  // answers on a bad day. The prompt-size filter is honoured even here —
  // handing Groq a prompt it has already said it cannot take is not a
  // last-ditch attempt, it is a guaranteed 413.
  const chosen =
    usable.length > 0
      ? usable
      : configured.filter((slot) => canTakePrompt(slot.provider, promptTokens)).slice(-1);

  return chosen.map((slot) => {
    const config = slot.retries ?? slot.key;
    return {
      provider: slot.provider,
      key: slot.key,
      model: models[config] ?? slot.model,
      thinkingBudget: slot.thinkingBudget,
      config,
    };
  });
}

/** Why this order, in one line for the worker log.
 *
 * Worth logging because the order is conditional: "google,deepseek" on a typed
 * turn means Groq was skipped for size, and that is the difference between a
 * tier being slow and a tier never being asked. Tier keys rather than provider
 * names, because "google,google" would not say which two Gemini models ran.
 */
export function routeReason(task: ModelTask, tiers: Tier[], promptTokens: number): string {
  return `route ${task} ~${promptTokens}tok → ${tiers.map((t) => t.key).join(",")}`;
}
