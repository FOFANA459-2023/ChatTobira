import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { generateText } from "ai";
import { z } from "zod";

import { isProviderDead, noteProviderFailure, noteProviderSuccess } from "@/lib/providers";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { trialCookie, trialUsed, TRIALS } from "@/lib/trial";

export const maxDuration = 30;

const BodySchema = z.object({
  kind: z.enum(["grammar", "kanji"]),
  scope_description: z.string().max(500),
  score: z.object({
    correct: z.number().int().min(0),
    total: z.number().int().min(1).max(30),
  }),
  results: z
    .array(
      z.object({
        question: z.string().max(300),
        review: z.string().max(200),
        correct: z.boolean(),
        given: z.string().max(120).optional(),
        answer: z.string().max(120).optional(),
      }),
    )
    .min(1)
    .max(30),
});

const SYSTEM = `You are a supportive Japanese-language study coach for
university students who just checked their practice test. Write feedback that
is constructive and specific, in plain English with Japanese terms where they
help. Rules:
- 3 short paragraphs at most, no headings, no bullet lists, no markdown.
- Any kanji you write carries its reading attached to the whole word once,
  written 漢字（かんじ） — never a reading per character, never on a word
  already in kana. The app sets those readings above the kanji.
- Start with what the student did well, named concretely from the results.
- Then the most important thing to fix: name the pattern behind the misses
  (not just the questions) and, when the wrong answers are given, what the
  confusion seems to be.
- End with 2–3 concrete study actions. Each action must point at the TEXTBOOK
  using the review references provided — topic and page — because the textbook
  is the only material the student owns. Never mention "materials", sources,
  or past papers.
- Warm but honest; no empty praise for a low score, no scolding either.`;

/** Constructive post-test coaching from the model. The deterministic study
 * plan lists WHAT was missed; this explains what the misses have in common
 * and how to attack them, which a tally cannot do. */
export async function POST(request: Request) {
  // Public route: middleware lets the trial through, so its fail-closed
  // guard never runs here and createClient() would throw a bare 500.
  if (!isSupabaseConfigured()) {
    return Response.json({ error: "supabase_not_configured" }, { status: 503 });
  }

  const supabase = await createClient();
  let user = null;
  try {
    ({
      data: { user },
    } = await supabase.auth.getUser());
  } catch {
    /* unreachable auth reads as signed out; the trial path still works */
  }

  // Anonymous coaching rides on the free test but is metered on its own
  // cookie: this endpoint reaches a model, so it must not be free to spam.
  let setCookie: string | null = null;
  if (!user) {
    const used = trialUsed(request, "feedback");
    if (used >= TRIALS.feedback.limit) {
      return Response.json({ error: "trial_exhausted" }, { status: 401 });
    }
    setCookie = trialCookie("feedback", used + 1);
  }

  const parsed = BodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const { kind, scope_description, score, results } = parsed.data;

  if (!process.env.GOOGLE_API_KEY || !process.env.GROQ_API_KEY) {
    return Response.json({ error: "model_keys_not_configured" }, { status: 503 });
  }

  const lines = results.map((r, i) => {
    const outcome = r.correct
      ? "correct"
      : `WRONG${r.given ? ` (answered ${JSON.stringify(r.given)}` : " (unanswered"}${
          r.answer ? `, correct answer ${JSON.stringify(r.answer)})` : ")"
        }`;
    return `${i + 1}. [${outcome}] ${r.question} — textbook reference: ${r.review}`;
  });

  const prompt = `Test type: ${kind === "kanji" ? "kanji & vocabulary" : "grammar"}.
Covered: ${scope_description}
Score: ${score.correct}/${score.total}.

Results:
${lines.join("\n")}`;

  const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });
  const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_API_KEY });

  // Plain text, so the chat model works here — no structured-output caveat.
  //
  // Keyed per TIER and not per provider, for the reason set out against
  // Tier.key in lib/router.ts. These are not the chat route's tiers: coaching
  // is a different job on a different model, and recording its failures under
  // the bare names "groq"/"deepseek"/"google" wrote them into the very slots
  // the chat route tracks its own health in. Three failures here and chat
  // stopped offering gemini-3.5-flash-lite — its primary model, and the
  // largest latency win in the stack — because an optional paragraph of
  // post-test encouragement could not be written.
  const tiers = [
    { key: "feedback-groq", model: groq(process.env.CHAT_MODEL ?? "openai/gpt-oss-120b") },
  ];
  if (process.env.DEEPSEEK_API_KEY) {
    const deepseek = createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY });
    tiers.push({
      key: "feedback-deepseek",
      model: deepseek(process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash"),
    });
  }
  tiers.push({
    key: "feedback-google",
    model: google(process.env.FALLBACK_MODEL ?? "gemini-3.6-flash"),
  });

  // Skip what has proven dead this isolate — all three tiers, where only
  // DeepSeek used to be checked — but never skip every one of them. An empty
  // cascade is a guaranteed 502 for the rest of the isolate's life, and one
  // more attempt costs a single round trip on a request nobody is waiting on.
  // Same guard, same reasoning, as routeModels().
  const live = tiers.filter((tier) => !isProviderDead(tier.key));
  const cascade = live.length > 0 ? live : tiers.slice(-1);

  for (const tier of cascade) {
    try {
      const { text } = await generateText({
        model: tier.model,
        system: SYSTEM,
        prompt,
        temperature: 0.5,
      });
      if (!text.trim()) throw new Error("empty feedback");
      // Clears whatever this tier had accumulated. Without it the count only
      // ever rises and a tier that works is retired on three failures spread
      // across the isolate's entire life.
      noteProviderSuccess(tier.key);
      return Response.json(
        { feedback: text.trim() },
        { headers: setCookie ? { "Set-Cookie": setCookie } : undefined },
      );
    } catch (error) {
      console.error(
        `quiz feedback failed on ${tier.key}:`,
        error instanceof Error ? error.message : error,
      );
      noteProviderFailure(tier.key, error);
    }
  }
  // The client falls back to the deterministic study plan alone — feedback is
  // an enhancement, never the thing standing between a student and a score.
  return Response.json({ error: "all_models_unavailable" }, { status: 502 });
}
