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
  /** Model ids, so a deploy can move a tier without a code change. */
  models?: Partial<Record<Provider, string>>;
}

/** Defaults matching the environment variables the routes already read. */
const DEFAULT_MODELS: Record<Provider, string> = {
  groq: "qwen/qwen3.8-27b",
  deepseek: "deepseek-v4-flash",
  google: "gemini-3.6-flash",
};

/** The preference order per task, before health and size are considered.
 *
 * Google is last in all three and is never filtered out: it is the tier that
 * has to answer when the others cannot, and a health check that could empty
 * the list is worse than a call that might fail. */
const PREFERENCE: Record<ModelTask, Provider[]> = {
  // Groq first purely on the clock: 0.42s against 1.35s, on a turn where the
  // student is waiting in silence for a reply they will hear rather than read.
  // A spoken turn's prompt is small by design, so this is also the one job
  // that reliably fits inside the free tier's budget.
  voice_turn: ["groq", "deepseek", "google"],
  // DeepSeek first because this is the job Groq cannot hold: a typed question
  // carries six passages, and at 8,300 tokens Groq answers 413 rather than
  // answering. Groq stays in the chain below it for the short typed turns
  // that do fit, where it is still three times faster and free.
  chat_answer: ["deepseek", "groq", "google"],
  // DeepSeek led this list because a paper is high-volume, non-interactive and
  // validated after the fact — exactly the shape of work worth moving off a
  // metered free tier. The reasoning was right and both of its premises turned
  // out to be wrong.
  //
  // It cannot finish a paper. generateObject returns a whole object or
  // nothing, and a real paper is a 17-item schema with an explanation and a
  // review reference on every item. Measured twice, on two days, against the
  // real corpus (scripts/local-db.sh):
  //
  //   google   gemini-3.5-flash-lite    10.1s   17 items, 4 sections
  //   groq     openai/gpt-oss-120b      9-45s   on the free tier's smaller prompt
  //   deepseek deepseek-v4-flash       138.5s   returned nothing at all
  //
  // This route's ceiling is 60 seconds. A tier that needs 138 of them is not
  // a slow first choice, it is a guaranteed timeout in front of every student
  // — which is exactly what "Could not generate a test" was. A reasoning model
  // is the wrong tool for filling a large schema: it spent 15,490 of its
  // 17,493 output tokens thinking.
  //
  // And the free tier it was moving work off is not the one this app uses.
  // "20 requests a day" is gemini-3.6-flash's budget; wrangler.jsonc sets
  // FALLBACK_MODEL to gemini-3.5-flash-lite for that exact reason, and its
  // budget is a real one. Groq behind it is free too and answers in nine
  // seconds when the prompt fits its 8,000-token-a-minute ceiling.
  //
  // So DeepSeek is not here. It keeps every job it is genuinely good at —
  // chat_answer and voice_turn above, where it is paid, uncapped, and the only
  // tier that can hold a prompt over Groq's input limit. It is not asked to do
  // the one thing it cannot.
  structured: ["google", "groq"],
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
    .filter((provider) => {
      if (provider === "google") return true; // never filtered: the last resort
      if (provider === "deepseek" && !hasDeepSeek) return false;
      if (isProviderDead(provider)) return false;
      return canTakePrompt(provider, promptTokens);
    })
    .map((provider) => ({
      provider,
      model: models[provider] ?? DEFAULT_MODELS[provider],
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
