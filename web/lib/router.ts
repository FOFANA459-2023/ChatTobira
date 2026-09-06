/** Which model answers which turn.
 *
 * This used to be one order — Groq, then DeepSeek, then Gemini — written into
 * the chat route and repeated, differently, in the quiz route. One order
 * cannot be right for every job, because the jobs differ in the only two
 * things that decide: how big the prompt is, and whether anybody is waiting.
 *
 * The order below is measured, not assumed. Every number here came from
 * calling the three providers with this app's own prompts and keys on
 * 2026-09-06, streaming, timing the first CONTENT token rather than the first
 * byte (a reasoning model streams thought before it streams an answer, and
 * the student hears nothing during the thinking):
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
 *    cent a turn against a topped-up balance. It is the right primary for
 *    grounded text answers — which is most of what this app does.
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
}

export interface RouteOptions {
  /** Roughly how many tokens the prompt will cost. Decides whether Groq can
   * be offered at all. */
  promptTokens?: number;
  /** Providers whose keys this deployment actually has. Google is assumed:
   * it is the last resort and the route checks for its key before calling. */
  hasDeepSeek?: boolean;
  /** Model ids by slot, so a deploy can move one tier without a code change
   * and without moving another tier that happens to share its provider. */
  models?: Partial<Record<ModelSlot, string>>;
}

/** A slot is a model a deploy can swap independently, not a provider: Groq
 * serves the chat with one model and builds papers with another, and the two
 * are moved for different reasons. Slot names match the environment variables
 * the routes already read. */
export type ModelSlot = "chat" | "quiz" | "quizSmall" | "deepseek" | "google";

const DEFAULT_MODELS: Record<ModelSlot, string> = {
  chat: "qwen/qwen3.8-27b",
  // generateObject needs response_format json_schema, which Groq implements
  // only on the gpt-oss models.
  quiz: "openai/gpt-oss-120b",
  quizSmall: "openai/gpt-oss-20b",
  deepseek: "deepseek-v4-flash",
  google: "gemini-3.6-flash",
};

interface TierSpec {
  provider: Provider;
  slot: ModelSlot;
}

/** The preference order per task, before health and size are considered.
 *
 * Google is last in all three and is never filtered out: it is the tier that
 * has to answer when the others cannot, and a health check that could empty
 * the list is worse than a call that might fail. */
const PREFERENCE: Record<ModelTask, TierSpec[]> = {
  // Groq first purely on the clock: 0.42s against 1.35s, on a turn where the
  // student is waiting in silence for a reply they will hear rather than read.
  // A spoken turn's prompt is small by design, so this is also the one job
  // that reliably fits inside the free tier's budget.
  voice_turn: [
    { provider: "groq", slot: "chat" },
    { provider: "deepseek", slot: "deepseek" },
    { provider: "google", slot: "google" },
  ],
  // Groq first, and this is a deliberate reversal of the order this file
  // shipped with a day ago. DeepSeek led it because it has no daily cap and
  // holds a large prompt, both of which are still true. What changed is that
  // deepseek-v4-flash turned out not to be reliably fast — it is reliably
  // fast SOMETIMES, which is a different thing. Observed on this app, all on
  // ordinary turns:
  //
  //   1.3–2.3s to first token when healthy
  //   97s on a typed question it had answered in 1.3s a minute earlier
  //   12s (the deadline) on a page lookup, which then fell to Groq anyway
  //   134s on a practice paper
  //
  // Against a measured 0.55s for Groq on the same shape of turn. A tier that
  // is three times slower at its best and occasionally two orders of
  // magnitude slower at its worst does not belong in front of a student who
  // is waiting for a reply.
  //
  // DeepSeek keeps the job it is genuinely needed for and Groq genuinely
  // cannot do: a prompt above Groq's shared 7,000 input tokens a minute,
  // where Groq answers 413 rather than answering. The size filter below drops
  // Groq for exactly those, so a large typed question still goes to DeepSeek
  // first without this list having to say so.
  chat_answer: [
    { provider: "groq", slot: "chat" },
    { provider: "deepseek", slot: "deepseek" },
    { provider: "google", slot: "google" },
  ],
  // Two findings decide this order, and neither was what I expected.
  //
  // DeepSeek is NOT here. It led this list on the strength of a check that
  // took 3.8s — on a two-item schema. A real paper is fifteen to twenty-one
  // items with an explanation and a review reference each, and measured on the
  // actual QuizSchema on 2026-09-06:
  //
  //   groq openai/gpt-oss-120b     6.2s    2,534 output tokens
  //   deepseek-v4-flash          134.2s   17,493, of which 15,490 REASONING
  //
  // The route's ceiling is 60s, so DeepSeek cannot finish a paper inside a
  // request at all: live, a kanji paper took 61.4s and would have been killed
  // on Cloudflare, which is exactly the "Could not generate a test" students
  // saw. A reasoning model is the wrong tool for filling a large schema.
  //
  // Google leads, which the old comment here said was wasteful. Measured on
  // the real prompt, with a real 17-item paper as the bar:
  //
  //   google gemini-3.5-flash-lite   7.5s   17 items, 198-char passage, bank of 8
  //   groq openai/gpt-oss-120b       8.9s   17 items, 113-char passage, bank of 5
  //
  // and Groq's free tier meters PROMPT PLUS RESERVED OUTPUT against 8,000
  // tokens a minute for these models. A paper is ~3,200 prompt and needs ~3,900
  // output, so it only just fits when nothing else is happening and never fits
  // when two students press "New Test" in the same minute:
  //
  //   "Request too large ... on tokens per minute (TPM): Limit 8000, Requested 8034"
  //
  // Groq stays second because it is free and fast when it does fit. It keeps a
  // second model behind it because Gemini is not a reliable backstop for this
  // job either — gemini-3.5-flash and gemini-3.6-flash both failed to return
  // parseable objects for the same schema.
  structured: [
    { provider: "google", slot: "google" },
    { provider: "groq", slot: "quiz" },
    { provider: "groq", slot: "quizSmall" },
  ],
};

/** The models to try, in order, for this task right now.
 *
 * Filtered by three things, in this order: whether the deployment has the
 * key, whether the provider has proven dead this isolate, and whether the
 * prompt fits. The last is the one that earns its place — an oversized
 * request to Groq is not a failure that costs nothing, it is seven seconds
 * of the student's turn spent being told no.
 */
export function routeModels(task: ModelTask, options: RouteOptions = {}): Tier[] {
  const { promptTokens = 0, hasDeepSeek = true, models = {} } = options;

  return PREFERENCE[task]
    .filter(({ provider }) => {
      if (provider === "google") return true; // never filtered: the last resort
      if (provider === "deepseek" && !hasDeepSeek) return false;
      if (isProviderDead(provider)) return false;
      return canTakePrompt(provider, promptTokens);
    })
    .map(({ provider, slot }) => ({
      provider,
      model: models[slot] ?? DEFAULT_MODELS[slot],
    }));
}

/** Why this order, in one line for the worker log.
 *
 * Worth logging because the order is now conditional: "deepseek,google" on a
 * typed turn means Groq was skipped for size, and that is the difference
 * between a tier being slow and a tier never being asked. */
export function routeReason(task: ModelTask, tiers: Tier[], promptTokens: number): string {
  return `route ${task} ~${promptTokens}tok → ${tiers.map((t) => t.provider).join(",")}`;
}
