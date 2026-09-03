import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { generateText } from "ai";
import { z } from "zod";

import { isProviderDead, noteProviderFailure } from "@/lib/providers";
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
  const tiers = [
    { provider: "groq", model: groq(process.env.CHAT_MODEL ?? "llama-3.3-70b-versatile") },
  ];
  if (process.env.DEEPSEEK_API_KEY && !isProviderDead("deepseek")) {
    const deepseek = createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY });
    tiers.push({
      provider: "deepseek",
      model: deepseek(process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash"),
    });
  }
  tiers.push({
    provider: "google",
    model: google(process.env.FALLBACK_MODEL ?? "gemini-3.6-flash"),
  });

  for (const tier of tiers) {
    try {
      const { text } = await generateText({
        model: tier.model,
        system: SYSTEM,
        prompt,
        temperature: 0.5,
      });
      if (!text.trim()) throw new Error("empty feedback");
      return Response.json(
        { feedback: text.trim() },
        { headers: setCookie ? { "Set-Cookie": setCookie } : undefined },
      );
    } catch (error) {
      console.error(
        `quiz feedback failed on ${tier.provider}:`,
        error instanceof Error ? error.message : error,
      );
      noteProviderFailure(tier.provider, error);
    }
  }
  // The client falls back to the deterministic study plan alone — feedback is
  // an enhancement, never the thing standing between a student and a score.
  return Response.json({ error: "all_models_unavailable" }, { status: 502 });
}
