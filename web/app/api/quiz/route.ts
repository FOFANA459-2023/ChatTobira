import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { generateObject } from "ai";
import { z } from "zod";

import { isProviderDead, noteProviderFailure } from "@/lib/providers";
import {
  chunksForLesson,
  focusTokens,
  lessonByPage,
  QuizSchema,
  rankChunksByFocus,
} from "@/lib/quiz";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
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
  // Question/sentence texts from the student's previous paper, so "New Test"
  // actually produces new questions instead of shuffling the same ones.
  avoid: z.array(z.string().max(300)).max(40).optional(),
});

const SYSTEM = `You create Japanese practice tests for university students from
provided course material, in the format of the course's own test papers. Rules:
- Base every item ONLY on the provided material; test the grammar patterns and
  vocabulary that actually appear in it.
- The test is divided into numbered sections. Each section has instruction_ja —
  the polite Japanese instruction line exactly as it would appear on the paper,
  e.g. 「（　）に入る適切なことばを選んでください。」 — and instruction_en, a
  short English translation of that instruction.
- Japanese in Japanese script. Furigana (written 漢字（かんじ）) follows the
  scope rule in the request: students are expected to READ the kanji they have
  already been taught, so kanji taught at or before the tested scope carry NO
  furigana; only kanji from beyond the scope get furigana. Never put furigana
  on a word whose reading or writing is itself being tested.
- true_false: the question is ONE statement about the section's passage, and
  the answer is exactly ○ (the statement matches the passage) or × (it does
  not). Mix ○ and × answers; × statements must be plausibly wrong, contradicted
  by the passage, not absurd. The explanation MUST point back into the passage:
  quote the short phrase that decides it, then say why in English — e.g.
  「あさごはんを食べてから大学へ行きます」とあるので、×。The passage says
  breakfast comes BEFORE leaving, so the statement contradicts it.
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
- review: for EVERY item, where in the TEXTBOOK the student should go to study
  this point. Students own the textbook and nothing else, so a review must be
  findable from the book alone: the division as the textbook prints it, the
  concept, and the page number from the excerpt header when one is shown.
  NEVER write "Material", "excerpt", "source", "handout", "past paper", or a
  numbered reference to the prompt. Identical points must use the identical
  review string so results aggregate.
- Variety: every item must drill a different point with a different sentence.
  Never underline the same word in two items, and never reuse a sentence the
  paper (or the avoid-list, when one is given) already used.
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
  grammar: `Structure the paper as exactly 4 sections, in this order:
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
  the question states what to do with the given fragment.
Section 4 — instruction_ja 「つぎの文章を読んで、内容と合っていれば○、違っていれば×を選んでください。」:
  READING. Write this section's "passage": an original text of 300–450
  characters (about 8–12 sentences) in the style of the reading passages on
  the course's past papers (a student's diary, a letter, a note about daily
  life or campus life), built from the vocabulary and grammar in the excerpts.
  Then exactly 5 true_false items: each question is one statement about the
  passage, answer ○ or ×. The passage field belongs to the section, not to
  the items.`,
  kanji: `Structure the paper as exactly 4 sections, in this order:
Section 1 — instruction_ja 「＿＿のことばの読み方として、いちばんいいものを選んでください。」:
  multiple_choice. question is ONLY the sentence with one kanji word marked
  【 】 — like the printed papers, where the word is just underlined in the
  sentence. Never repeat the marked word after the sentence and never append
  …の読み方はどれですか — the section instruction already asks that.
  The choices are 4 hiragana readings, one correct.
Section 2 — instruction_ja 「＿＿のことばを漢字で書くとき、いちばんいいものを選んでください。」:
  multiple_choice. question is ONLY the sentence with one word written in
  hiragana marked 【 】 — same rule: no repetition of the word, no appended
  re-ask. The choices are 4 kanji spellings, one correct, distractors
  visually similar.
Section 3 — instruction_ja 「（　）に入れるのに、いちばんいいことばを選んでください。」:
  multiple_choice. Vocabulary in context: a sentence with （　） and 4 word
  choices from the material.
Section 4 — instruction_ja 「つぎの文章を読んで、内容と合っていれば○、違っていれば×を選んでください。」:
  READING. Write this section's "passage": an original text of 300–450
  characters (about 8–12 sentences) in the style of the reading passages on
  the course's past papers, deliberately dense with the kanji and vocabulary
  from the excerpts. Then exactly 5 true_false items: each question is one
  statement about the passage, answer ○ or ×. The passage field belongs to
  the section.
Across the WHOLE paper, never test the same word twice: a word whose reading
is asked in Section 1 must not be the word written in Section 2, the blank in
Section 3, or the point of a Section 4 statement. Every item, a new word.`,
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
  // The catalogue changes only when a book is ingested, and it is identical
  // for every caller — let the edge answer repeat loads instead of a worker
  // and two Supabase round-trips per page view.
  return Response.json(
    { books },
    { headers: { "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=3600" } },
  );
}

export async function POST(request: Request) {
  // Fail closed and name the problem, the way middleware does for every
  // non-public route. createClient() throws on construction without
  // credentials, and that throw is outside any try here.
  if (!isSupabaseConfigured()) {
    return Response.json({ error: "supabase_not_configured" }, { status: 503 });
  }

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
  const { documentId, focus, kind, count, avoid } = parsed.data;

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
  // book_page comes along so review references can name a page the student
  // can actually open.
  const { data: chunks, error } = await db
    .from("chunks")
    .select("content, metadata, book_page, pdf_page")
    .eq("document_id", documentId)
    .order("pdf_page")
    .limit(500);
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

  type QuizChunk = {
    content: string;
    metadata: Record<string, unknown> | null;
    book_page: string | null;
    pdf_page: number;
  };
  const allChunks = chunks as QuizChunk[];

  // Textbook chunks carry no lesson metadata, so the lesson each page belongs
  // to is derived from the 第N課 headers in the text itself. A lesson-scoped
  // test then draws from that lesson's actual pages — never a random sample
  // of the book — with earlier lessons as filler only when the lesson is
  // thin, and a fall back to text matching when the mapping finds nothing.
  const lessons = lessonByPage(allChunks);
  const scopeDivisionForContent = focusTokens(focus ?? "")
    .filter((token) => /^t\d{1,2}$/.test(token))
    .map((token) => Number(token.slice(1)));
  const contentScope =
    scopeDivisionForContent.length > 0 ? Math.max(...scopeDivisionForContent) : null;

  let picked: QuizChunk[] =
    contentScope !== null ? chunksForLesson(allChunks, lessons, contentScope, 10) : [];
  if (picked.length === 0) {
    picked = rankChunksByFocus(allChunks, focus ?? "", 10);
  }

  // ~10 focused excerpts with tight character caps: quiz latency is dominated
  // by prompt size, and focused excerpts out-drill a loose pile. Excerpts are
  // headed by the textbook name, its lesson, and printed page — never
  // "Material N", which the model would echo into review references students
  // cannot follow.
  const sample = picked
    .map((c) => {
      const lesson = lessons.get(c.pdf_page) ?? 0;
      const grammarPoints = Array.isArray(c.metadata?.["grammar_points"])
        ? (c.metadata["grammar_points"] as string[]).filter(Boolean).join("、")
        : "";
      const header = [
        `"${doc.title}"`,
        lesson > 0 ? `${/intermediate/i.test(doc.title) ? "Lesson" : "Topic"} ${lesson}` : null,
        c.book_page ? `page ${c.book_page}` : null,
        grammarPoints ? `teaches: ${grammarPoints}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      return `--- From ${header} ---\n${c.content.slice(0, 900)}`;
    })
    .join("\n\n");

  // The books name their divisions differently: the Foundation volumes are
  // split into "Topic 1, 2, …", the Intermediate Tobira volumes into
  // "Lesson 1, 2, …". Review references must use the word printed in the
  // student's own book or they cannot follow them.
  const division = /intermediate/i.test(doc.title) ? "Lesson" : "Topic";

  // Furigana boundary: the tested lesson's own kanji are still being learned,
  // so THEY carry readings too — only lessons strictly below the scope go
  // bare. Scoped to Lesson 3: no furigana for Lessons 1–2, furigana on
  // everything from Lesson 3 up. A whole-book test annotates every kanji
  // word, the same rule with the whole book as the current material.
  const scopeDivision = contentScope;
  const furiganaRule = `${
    scopeDivision
      ? `Furigana rule: this test is scoped to ${division} ${scopeDivision}.${
          scopeDivision > 1
            ? ` Write NO furigana
for kanji taught in ${division} 1 through ${division} ${scopeDivision - 1} —
students already read them.`
            : ""
        } EVERY kanji word from ${division} ${scopeDivision} itself
or beyond MUST carry its reading, written 漢字（かんじ） immediately after the
word — the app displays it as small hiragana above the kanji. This is
required, not optional: a test with no furigana anywhere is wrong.`
      : `Furigana rule: EVERY kanji word MUST carry its reading, written
漢字（かんじ） immediately after the word — the app displays it as small
hiragana above the kanji. This is required, not optional.`
  }
Exception: never annotate a word whose reading or writing is itself being
tested (it would give the answer away). The excerpts show the textbook's own
readings as 漢字《かんじ》 — rewrite them in the （ ） style, subject to the
rule above.`;

  // Both papers end with the 5-question reading section, like the real ones.
  const reading = 5;
  const perSection = Math.round(count / 3);
  const prompt = `Create a practice test from the textbook excerpts below, all
from "${doc.title}" — the book the student owns. The paper's format is modelled
on the course's past test papers, but every question must be drawn from these
excerpts. This textbook divides its content into ${division}s: write every
review reference as "${division} N — concept (p. NN)", using the ${division}
numbers and page numbers as printed in the excerpts.
${furiganaRule}
Exactly ${count + reading} questions in total — ${perSection} in each of the
3 non-reading sections, plus exactly 5 in the reading section. Focus on ${
    kind === "kanji"
      ? "the kanji and vocabulary that appear in these excerpts"
      : "the grammar patterns drilled in these excerpts"
  }.${
    focus
      ? `\nThe student asked the test to focus on: "${focus}". Keep every question
inside that scope, and say so in scope_description.`
      : ""
  }${
    avoid && avoid.length > 0
      ? `\nThe student just sat a paper with the questions below. Write COMPLETELY
different questions — different sentences, different target words, different
vocabulary — while staying inside the same material:\n${avoid
          .map((q) => `- ${q.slice(0, 200)}`)
          .join("\n")}`
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
        // Test papers should vary between sittings; greedy decoding regrows
        // the same questions from the same excerpts.
        temperature: 0.8,
      });
      // A paper that is schema-valid but far too short is still unusable —
      // seen live: 1 item back from a 9-item request. Let the next tier try.
      const expected = count + reading;
      const produced = object.sections.reduce((n, s) => n + s.items.length, 0);
      if (produced < Math.ceil(expected * 0.6)) {
        throw new Error(`paper too short: ${produced} items for count=${expected}`);
      }
      // A grammar paper without its reading passage is missing a section the
      // real papers always have.
      if (reading > 0 && !object.sections.some((s) => s.passage && s.passage.length >= 50)) {
        throw new Error("paper is missing the reading passage");
      }
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
