import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { generateObject } from "ai";
import { z } from "zod";

import { isProviderDead, noteProviderFailure } from "@/lib/providers";
import { QuizSchema, rankChunksByFocus } from "@/lib/quiz";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { trialCookie, trialUsed, TRIALS } from "@/lib/trial";

export const maxDuration = 60;

const BodySchema = z.object({
  // The student picks a specific textbook: quizzes from "everything" produced
  // vague drills and slow generation over an unfocused sample.
  documentId: z.number().int().positive(),
  // Free text: which topic / grammar the test should focus on, if any.
  focus: z.string().trim().max(200).optional(),
  kind: z.enum(["grammar", "kanji"]).default("grammar"),
  count: z.number().int().min(9).max(21).default(15),
});

const SYSTEM = `You create Japanese practice tests for university students from
provided course material, in the format of the course's own test papers. Rules:
- Base every item ONLY on the provided material; test the grammar patterns and
  vocabulary that actually appear in it.
- The test is divided into numbered sections. Each section has instruction_ja —
  the polite Japanese instruction line exactly as it would appear on the paper,
  e.g. 「（　）に入る適切なことばを選んでください。」 — and instruction_en, a
  short English translation of that instruction.
- Japanese in Japanese script with furigana as 漢字（かんじ） on first use.
- multiple_choice: exactly 4 choices, one correct, distractors that reflect
  real learner confusions (wrong particle, wrong conjugation, wrong register,
  similar-looking kanji, similar-sounding readings).
- fill_blank: the question shows a sentence with ＿＿ and asks for the missing
  form; the answer is the exact text that fills the blank. When the answer
  contains kanji, ALSO provide answer_kana: the same answer written entirely
  in hiragana — students may answer in either script.
- Spread the questions across as many different grammar points and words from
  the material as possible; never drill the same point twice in one paper.
- explanation: one or two sentences on WHY, in simple English with the
  Japanese pattern or word named.
- review: for EVERY item, where in the course material the student should go
  to study this point — the topic or lesson exactly as the material names it,
  plus the concept, e.g. "Topic 7 — て-form requests". Add the printed book
  page when the material shows one, e.g. "Topic 7 — て-form requests (p. 94)".
  Identical points must use the identical review string so results aggregate.
- When an item asks about ONE specific word in a sentence (the word to
  conjugate, the word to read, the word to write in kanji), wrap exactly that
  word in 【 】 where it occurs — the app renders it underlined, matching the
  printed papers. Use ＿＿ only for a blank the student fills.
- scope_description: 1–2 sentences in English telling the student what this
  test covers — name the specific grammar points or vocabulary drilled, and
  the textbook or lesson area they come from.
- Never reference "the source", file names, or page numbers in questions or
  explanations; page numbers belong in review only.`;

// Section plans mirror the papers students actually sit: the 文法復習シート
// for grammar, the JLPT-style 文字・語彙 sections for kanji.
const KIND_SPEC: Record<"grammar" | "kanji", string> = {
  grammar: `Structure the paper as exactly 3 sections, in this order:
Section 1 — instruction_ja 「（　）に入る適切なことばを選んでください。」:
  multiple_choice. Short sentences or two-line dialogues with （　）; choices
  are particles, question words, or forms drilled in the material.
Section 2 — instruction_ja 「＿＿のことばを正しい形にしてください。」:
  fill_blank. The sentence contains the DICTIONARY form of one word wrapped in
  【 】 at the place it occurs, e.g. きのう、すしを【食べる】。 The student
  rewrites the marked word in the form the sentence needs; the answer is that
  correct form. Do not put a ＿＿ blank in these sentences — the marked word
  itself is what changes.
Section 3 — instruction_ja 「例のように文を完成させてください。」:
  fill_blank. Complete the sentence using the sentence pattern being drilled;
  the question states what to do with the given fragment.`,
  kanji: `Structure the paper as exactly 3 sections, in this order:
Section 1 — instruction_ja 「＿＿のことばの読み方として、いちばんいいものを選んでください。」:
  multiple_choice. A sentence with one kanji word marked 【 】; the choices are
  4 hiragana readings, one correct.
Section 2 — instruction_ja 「＿＿のことばを漢字で書くとき、いちばんいいものを選んでください。」:
  multiple_choice. A sentence with one word written in hiragana marked 【 】;
  the choices are 4 kanji spellings, one correct, distractors visually similar.
Section 3 — instruction_ja 「（　）に入れるのに、いちばんいいことばを選んでください。」:
  multiple_choice. Vocabulary in context: a sentence with （　） and 4 word
  choices from the material.`,
};

async function requireUser() {
  const supabase = await createClient();
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return { supabase, user };
  } catch {
    return { supabase, user: null };
  }
}

/** Textbooks available for quizzing, for the picker UI.
 *
 * Citable textbooks only: class handouts and answer sheets stay retrievable
 * for chat grounding, but tests are always drawn from a book the student can
 * open. When Foundation 1 & 2 is ingested it appears here automatically.
 *
 * Open to trial visitors: they need the picker to sit their one free test, and
 * a list of textbook titles is the same information the marketing copy gives.
 */
export async function GET() {
  const { supabase, user } = await requireUser();
  // Signed-in students read under their own RLS; a trial visitor has no
  // session for RLS to evaluate, so the titles come via the service client.
  const db = user ? supabase : serviceClient();
  if (!db) {
    return Response.json({ books: [] });
  }

  const { data, error } = await db
    .from("documents")
    .select("id, title, is_citable")
    .eq("is_citable", true)
    .order("title");
  if (error) {
    return Response.json({ error: "lookup_failed" }, { status: 500 });
  }

  const books = (data ?? []).map((d) => ({
    id: d.id as number,
    title: d.title as string,
  }));
  return Response.json({ books });
}

export async function POST(request: Request) {
  const { supabase, user } = await requireUser();

  // One free practice test before signing in, metered separately from the
  // chat trial so sampling one does not consume the other.
  let setCookie: string | null = null;
  if (!user) {
    const used = trialUsed(request, "quiz");
    if (used >= TRIALS.quiz.limit) {
      return Response.json({ error: "trial_exhausted" }, { status: 401 });
    }
    setCookie = trialCookie("quiz", used + 1);
  }

  const parsed = BodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const { documentId, focus, kind, count } = parsed.data;

  if (!process.env.GOOGLE_API_KEY || !process.env.GROQ_API_KEY) {
    return Response.json({ error: "model_keys_not_configured" }, { status: 503 });
  }

  // Trial visitors have no session for RLS to evaluate; the cookie above is
  // what limited them, and this only ever reads course material.
  const db = user ? supabase : serviceClient();
  if (!db) {
    return Response.json(
      {
        error: "no_material",
        message: "Practice tests are unavailable on this deployment.",
      },
      { status: 503 },
    );
  }

  // Only textbooks are quizzable — same rule the picker applies, enforced
  // server-side so a crafted request cannot test from a handout.
  const { data: doc } = await db
    .from("documents")
    .select("id, title, is_citable")
    .eq("id", documentId)
    .single();
  if (!doc || !doc.is_citable) {
    return Response.json(
      {
        error: "no_material",
        message: "Tests can only be generated from the textbooks.",
      },
      { status: 404 },
    );
  }

  // A quiz costs one model call, so it spends one quota unit like a question.
  // Trial visitors have no quota row; the cookie is their whole allowance.
  if (user) {
    const { data: remaining, error: quotaError } = await supabase.rpc("consume_quota");
    if (quotaError) {
      return Response.json({ error: "quota_check_failed" }, { status: 500 });
    }
    if (remaining === -1) {
      return Response.json({ error: "quota_exhausted" }, { status: 429 });
    }
  }

  // Fetch wide, then narrow to the student's focus: the focus is free text,
  // so scoping happens by ranking chunk contents, not by a column filter.
  const { data: chunks, error } = await db
    .from("chunks")
    .select("content, metadata")
    .eq("document_id", documentId)
    .limit(200);
  if (error) {
    return Response.json({ error: "retrieval_failed" }, { status: 502 });
  }
  if (!chunks || chunks.length === 0) {
    return Response.json(
      {
        error: "no_material",
        message: "No course material is loaded for that selection yet.",
      },
      { status: 404 },
    );
  }

  // ~10 focused excerpts with tight character caps: quiz latency is dominated
  // by prompt size, and focused excerpts out-drill a loose pile.
  const sample = rankChunksByFocus(
    chunks as { content: string; metadata: Record<string, unknown> | null }[],
    focus ?? "",
    10,
  )
    .map((c, i) => `--- Material ${i + 1} ---\n${c.content.slice(0, 900)}`)
    .join("\n\n");

  const perSection = Math.round(count / 3);
  const prompt = `Create a practice test from the material below, drawn from
the textbook "${doc.title}". Exactly ${count} questions in total — ${perSection} in
each of the 3 sections. Focus on ${
    kind === "kanji"
      ? "the kanji and vocabulary that appear in this material"
      : "the grammar patterns drilled in this material"
  }.${
    focus
      ? `\nThe student asked the test to focus on: "${focus}". Keep every question
inside that scope, and say so in scope_description.`
      : ""
  }\n\n${sample}`;
  const system = `${SYSTEM}\n\n${KIND_SPEC[kind]}`;
  const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });
  const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_API_KEY });

  // Same cascade as the chat route: Groq's free tier first, DeepSeek for the
  // overflow it cannot cover, Gemini last. DeepSeek offers JSON mode rather
  // than strict schema enforcement and its own docs warn it can return empty
  // content, so a malformed paper throws inside generateObject and simply
  // falls through to Gemini — which is exactly why Gemini stays in the chain.
  // NOT the chat model: generateObject needs response_format json_schema,
  // which Groq only implements on the gpt-oss models — llama-3.3 rejects it,
  // which silently sent every quiz to Gemini and its 20-requests/day budget.
  const tiers = [
    { provider: "groq", model: groq(process.env.QUIZ_MODEL ?? "openai/gpt-oss-120b") },
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
      const { object } = await generateObject({
        model: tier.model,
        schema: QuizSchema,
        system,
        prompt,
      });
      return Response.json(object, {
        headers: setCookie ? { "Set-Cookie": setCookie } : undefined,
      });
    } catch (error) {
      // Declined or produced an unusable paper — try the next provider. The
      // reason is logged because a silent cascade turns "every tier failed"
      // into an undiagnosable 502.
      console.error(
        `quiz generation failed on ${tier.provider}:`,
        error instanceof Error ? error.message : error,
      );
      noteProviderFailure(tier.provider, error);
    }
  }
  // No paper was produced, so the trial visitor keeps their free test: the
  // cookie is only spent on a request that actually returned something.
  return Response.json({ error: "all_models_unavailable" }, { status: 502 });
}
