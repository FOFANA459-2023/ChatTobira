import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { generateObject } from "ai";
import { z } from "zod";

import { QuizSchema, rankChunksByFocus } from "@/lib/quiz";
import { createClient } from "@/lib/supabase/server";

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
  form; the answer is the exact text that fills the blank.
- explanation: one or two sentences on WHY, in simple English with the
  Japanese pattern or word named.
- scope_description: 1–2 sentences in English telling the student what this
  test covers — name the specific grammar points or vocabulary drilled, and
  the textbook or lesson area they come from.
- Never reference "the source", file names, or page numbers in questions.`;

// Section plans mirror the papers students actually sit: the 文法復習シート
// for grammar, the JLPT-style 文字・語彙 sections for kanji.
const KIND_SPEC: Record<"grammar" | "kanji", string> = {
  grammar: `Structure the paper as exactly 3 sections, in this order:
Section 1 — instruction_ja 「（　）に入る適切なことばを選んでください。」:
  multiple_choice. Short sentences or two-line dialogues with （　）; choices
  are particles, question words, or forms drilled in the material.
Section 2 — instruction_ja 「＿＿のことばを正しい形にしてください。」:
  fill_blank. The sentence shows ＿＿ and the question names the dictionary
  form to conjugate, e.g. 「食べる」を正しい形にしてください.
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
 */
export async function GET() {
  const { supabase, user } = await requireUser();
  if (!user) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }

  const { data, error } = await supabase
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
  if (!user) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }

  const parsed = BodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const { documentId, focus, kind, count } = parsed.data;

  if (!process.env.GOOGLE_API_KEY || !process.env.GROQ_API_KEY) {
    return Response.json({ error: "model_keys_not_configured" }, { status: 503 });
  }

  // Only textbooks are quizzable — same rule the picker applies, enforced
  // server-side so a crafted request cannot test from a handout.
  const { data: doc } = await supabase
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
  const { data: remaining, error: quotaError } = await supabase.rpc("consume_quota");
  if (quotaError) {
    return Response.json({ error: "quota_check_failed" }, { status: 500 });
  }
  if (remaining === -1) {
    return Response.json({ error: "quota_exhausted" }, { status: 429 });
  }

  // Fetch wide, then narrow to the student's focus: the focus is free text,
  // so scoping happens by ranking chunk contents, not by a column filter.
  const { data: chunks, error } = await supabase
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

  // Groq first: sub-second token rates make it the fast path, and its daily
  // budget is healthier than gemini-3.6-flash's 20 requests/day. Gemini only
  // catches the failure case.
  try {
    const { object } = await generateObject({
      model: groq(process.env.CHAT_MODEL ?? "llama-3.3-70b-versatile"),
      schema: QuizSchema,
      system,
      prompt,
    });
    return Response.json(object);
  } catch {
    const { object } = await generateObject({
      model: google(process.env.FALLBACK_MODEL ?? "gemini-3.6-flash"),
      schema: QuizSchema,
      system,
      prompt,
    });
    return Response.json(object);
  }
}
