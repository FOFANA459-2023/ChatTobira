import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { generateObject } from "ai";
import { z } from "zod";

import { cachedPool, rememberPool } from "@/lib/corpus-cache";
import { isProviderDead, noteProviderFailure } from "@/lib/providers";
import {
  chunksForLesson,
  dedupeQuiz,
  dropCopiedItems,
  exemplarProvenance,
  focusTokens,
  lessonByPage,
  paperIdentity,
  QuizSchema,
  rankChunksByFocus,
  selectExemplars,
  type ExemplarChunk,
} from "@/lib/quiz";
import {
  blueprint as paperBlueprint,
  instructionLanguage,
  markLine,
  type Level,
  type SectionArchetype,
} from "@/lib/paper-format";
import { dropRepeats, fingerprint, type Fingerprint } from "@/lib/quiz-signature";
import { tidyQuiz, validateQuiz } from "@/lib/quiz-validate";
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
- A reading is attached to the WHOLE word, once — 持ち物（もちもの）, 急ぐ（いそぐ）
  — never one reading per character (持《も》ち物《もの》 is wrong), and never on
  a word already written in kana.
- Write plain text everywhere: no Markdown, no asterisks for emphasis, no
  headings, no bullet characters. The app sets the paper; question,
  explanation, review and scope_description are prose and nothing else.
- Every section's shape — its instruction line, how many items it carries, how
  many options each item has, whether it has a word bank or a passage — is
  specified per section below. Follow it exactly; it is read off the papers
  this course sets, not invented.
- "type" is how the app grades the item and must match the section's form:
  form "bracket" and "lettered" are type "multiple_choice", form "written" is
  "fill_blank", form "maru_batsu" is "true_false".
- The answer of a choice item must be one of its own choices, character for
  character. An answer that is not on the list is the single commonest way a
  generated paper becomes unusable.
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

// The paper's shape comes from the format catalogue, not from a template.
//
// It used to be two hardcoded four-section strings written by reading the
// course's papers by hand. lib/paper-format.ts holds that reading as data
// instead — every section archetype the sat papers actually use, with the
// instruction line as printed, the marks it carries, how many items it runs
// to and how many options it prints — and a paper is planned from it.
//
// Which matters because the hand-written template was wrong about the thing
// it most needed to be right about. It asked for four lettered options on
// every choice question; across 40 sat papers the course never once does
// that. It prints two or three options INSIDE the sentence, or lists three
// under a〜c.
function sectionPlan(
  blueprint: SectionArchetype[],
  language: "en" | "ja+en" | "ja",
  perSection: number,
): string {
  const numerals = ["I", "II", "III", "IV", "V"];
  const lines = blueprint.map((archetype, index) => {
    const items = Math.min(
      Math.max(perSection, archetype.items[0]),
      archetype.items[1],
    );
    const parts = [
      `Section ${numerals[index]} — ${archetype.objective}.`,
      `  instruction_ja: exactly 「${archetype.instructionJa}」`,
      `  instruction_en: ${
        language === "ja"
          ? "a short English translation of that line"
          : `exactly "${archetype.instructionEn}"`
      }`,
      `  form: "${archetype.form}", marks: ${archetype.marks}, ${items} items ${markLine(
        archetype.marks,
        items,
      )}`,
    ];

    if (archetype.form === "bracket") {
      parts.push(
        `  Write ${archetype.choices} choices per item. The app prints them inside the sentence as ( A / B / C ) for the student to circle, so the question text must NOT already contain the options — write the sentence with the gap where they go, and put the candidates in "choices" with the right one in "answer".`,
      );
    } else if (archetype.form === "lettered") {
      parts.push(
        `  Exactly ${archetype.choices} choices, listed under the question and labelled a. b. c. by the app. "answer" must be one of them, written identically.`,
      );
    } else if (archetype.form === "maru_batsu") {
      parts.push(
        `  Each item is ONE statement about this section's passage; "answer" is exactly ○ or ×. Mix them. A × statement must be contradicted by the passage, not merely absent from it, and the explanation must quote the phrase that decides it.`,
      );
    } else {
      parts.push(
        `  The student writes the answer. Put the gap in the sentence as （　）. "answer" is exactly the text that fills it; add "answer_kana" when the answer contains kanji.`,
      );
    }

    if (archetype.wordBank) {
      parts.push(
        `  Set "word_bank" on this section: ${items + 1}–${items + 2} dictionary-form words, printed in a box under the items. Every answer must be one of them, conjugated to fit its sentence, and NO word may answer two items — the paper says ことばは1回しか使えません and means it. Include one or two bank words that fit nothing, as the real papers do.`,
      );
    }
    if (archetype.passage) {
      parts.push(
        `  Set "passage" on this section: the text the items are about, written by you from the excerpts. ${
          archetype.form === "written"
            ? "The gaps live inside the passage; each item names which gap it is."
            : "300–400 characters."
        }`,
      );
    }
    if (archetype.example) {
      parts.push(
        `  Open instruction_ja with the paper's own 例 convention: the first item's question may show the worked example inline as 例) …, which is how the printed section teaches its answer format.`,
      );
    }
    parts.push(`  Set "target" on every item to the exact point it tests.`);
    return parts.join("\n");
  });

  return `Structure the paper as exactly ${blueprint.length} sections, in this order:\n\n${lines.join("\n\n")}`;
}

// How the course writes wrong answers, read off the sat papers.
//
// Distractors are the whole difficulty of a multiple-choice paper: four
// options a student can eliminate at a glance is a question that tests
// nothing. The papers build them from the mistakes their students actually
// make, and the two subjects do it differently.
const DISTRACTORS: Record<"grammar" | "kanji", string> = {
  grammar: `DISTRACTORS (how this course writes wrong grammar options)
Every wrong option must be a mistake a real student of this topic would make,
and must be wrong for a reason you could name:
- the wrong particle in a frame where several are plausible — に against で
  against を, は against が;
- the right pattern in the wrong form — dictionary form where the て-form is
  needed, past where present is needed, plain where polite is needed;
- a neighbouring pattern the topic teaches alongside this one — 〜ながら
  against 〜あとで, 〜そうです against 〜ようです, 〜ておく against 〜てある;
- a form that is grammatical Japanese but wrong for THIS sentence's meaning.
Never a nonsense string, never a word from a different part of speech, and
never an option a student could rule out without knowing the point.`,
  kanji: `DISTRACTORS (how this course writes wrong kanji options)
- readings that differ by one feature a learner confuses: voicing (かい/がい),
  long against short vowel (こうこく/こくこく), small kana (きゅ/きゆ),
  gemination (がっこう/がこう);
- the on-reading where the kun-reading is correct, and the reverse;
- kanji that look alike — 待/持, essential/末, 券/巻, 話/語;
- a real word of the right shape that means something else.
Never a made-up reading, and never a character the course has not taught.`,
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
    .select("id, title, is_citable, level")
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
  //
  // Both the fetch and the lesson mapping below are pure functions of the
  // book, so they are cached per isolate: pressing "New Test" is the common
  // case, and it should not re-read half a megabyte of Japanese and re-scan
  // it for 第N課 headers to write a different paper from the same chapter.
  type QuizChunk = {
    content: string;
    metadata: Record<string, unknown> | null;
    book_page: string | null;
    pdf_page: number;
  };
  interface Pool {
    chunks: QuizChunk[];
    lessons: Map<number, number>;
  }

  let pool = cachedPool<Pool>(documentId);
  if (!pool) {
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
    // Textbook chunks carry no lesson metadata, so the lesson each page
    // belongs to is derived from the 第N課 headers in the text itself. A
    // lesson-scoped test then draws from that lesson's actual pages — never a
    // random sample of the book — with earlier lessons as filler only when
    // the lesson is thin, and a fall back to text matching when the mapping
    // finds nothing.
    pool = { chunks: chunks as QuizChunk[], lessons: lessonByPage(chunks as QuizChunk[]) };
    rememberPool(documentId, pool);
  }

  const allChunks = pool.chunks;
  const lessons = pool.lessons;
  const scopeDivisionForContent = focusTokens(focus ?? "")
    .filter((token) => /^t\d{1,2}$/.test(token))
    .map((token) => Number(token.slice(1)));
  const contentScope =
    scopeDivisionForContent.length > 0 ? Math.max(...scopeDivisionForContent) : null;

  let picked: QuizChunk[] =
    contentScope !== null ? chunksForLesson(allChunks, lessons, contentScope, 8) : [];
  if (picked.length === 0) {
    picked = rankChunksByFocus(allChunks, focus ?? "", 8);
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
      return `--- From ${header} ---\n${c.content.slice(0, 700)}`;
    })
    .join("\n\n");

  // ---------------------------------------------------------------------
  // Exam-style reference: the course's own sat papers, at this book's level.
  //
  // Scoped to the level and never wider. A Foundation 2 test modelled on a
  // Foundation 3 paper would drill the right book in the wrong register —
  // longer sentences, later grammar in the distractors — which is precisely
  // the difficulty mismatch these papers exist to fix. A level with no
  // papers ingested simply gets no block, and the prompt says nothing about
  // exams at all.
  // ---------------------------------------------------------------------
  const level = (doc as { level: string | null }).level;

  // The paper's plan, from the format catalogue. Intermediate has no sat
  // papers in the corpus, so it falls back to the Foundation 3 shapes —
  // closest in level, and better than a template nobody's course uses.
  const formatLevel: Level = level === "F2" ? "F2" : "F3";
  const blueprint = paperBlueprint(formatLevel, kind);
  const language = instructionLanguage(formatLevel, contentScope);

  // What this student has already been asked at this level. The paper they
  // just sat still rides in on `avoid`, but that dies with the page; this is
  // what makes the third test of the week different from the first.
  let history: Fingerprint[] = [];
  if (user) {
    const { data: prior } = await supabase
      .from("quiz_items")
      .select("question, answer, target, pattern, frame")
      .eq("kind", kind)
      .eq("level", level ?? "")
      .order("created_at", { ascending: false })
      .limit(120);
    history = ((prior ?? []) as { pattern: string | null; frame: string | null; question: string }[])
      .map((row) => ({
        exact: row.question ?? "",
        pattern: row.pattern ?? "",
        frame: row.frame ?? "",
      }))
      .filter((print) => print.pattern || print.frame);
  }

  let exemplars: ExemplarChunk[] = [];
  if (level) {
    const paperKey = `papers:${level}`;
    let papers = cachedPool<ExemplarChunk[]>(paperKey);
    if (!papers) {
      const { data: paperChunks } = await db
        .from("chunks")
        .select("content, metadata, documents!inner(doc_type, level)")
        .eq("documents.doc_type", "past_paper")
        .eq("documents.level", level)
        .limit(300);
      papers = (paperChunks ?? []) as unknown as ExemplarChunk[];
      // Remembered even when empty: a level with no past papers should cost
      // one query per TTL, not one per generated test.
      rememberPool(paperKey, papers);
    }
    // Three pages, capped at roughly one page of text each. The ceiling here
    // is Groq's free tier at 12k tokens/minute, and Japanese spends close to
    // a token per character — the textbook sample already costs ~9,000
    // characters, so this block has to buy its place. Three pages from three
    // sittings is enough to show the section order, the instruction wording
    // and the distractor style; a fourth mostly repeats them.
    exemplars = selectExemplars(papers, kind, contentScope, 2);
  }

  const styleBlock = exemplars
    .map((chunk) => {
      const { topic, examTerm, paperTitle } = paperIdentity(chunk);
      const header = [examTerm, paperTitle, topic ? `Topic ${topic.slice(1)}` : null]
        .filter(Boolean)
        .join(" ");
      return `--- Past paper${header ? `: ${header}` : ""} ---\n${chunk.content.slice(0, 800)}`;
    })
    .join("\n\n");

  const provenance = exemplarProvenance(exemplars);

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

  // The two sources do different jobs and the prompt has to say so, or the
  // model treats the papers as a question bank: it lifts a sentence off a
  // past paper, and the student sits a test they have already seen with the
  // answers already marked on it. Content comes from the book; only the SHAPE
  // comes from the papers.
  const styleRules = styleBlock
    ? `
=== HOW THIS COURSE'S PAPERS LOOK (form only) ===
Pages from papers students at this level actually sat, shown for the shape of
the sentences and the pitch of the difficulty. They are deliberately from a
DIFFERENT topic than the one you are writing about — the format does not vary
by topic, so there is nothing here for you to reuse.
- NEVER reuse a sentence, question, word bank or passage from them. Every item
  you write is new, built from the textbook excerpts below.
- They are not a source of grammar or facts. Where a paper and the excerpts
  disagree, the excerpts are right.
- Their blanks are unfilled; yours carry the answer in the answer field.

${styleBlock}
`
    : "";

  // Only what was actually retrieved may be described. Without this the model
  // narrates an exam history it inferred — "as in previous final exams" — and
  // a student has no way to tell that from something the course said.
  const provenanceRule = styleBlock
    ? `\nIn scope_description you MAY note in one short clause that the paper follows
the style of the course's past papers${
        provenance.terms.length > 0 ? ` (${provenance.terms.join(", ")})` : ""
      }. Do not claim anything else about the exams: not that a point is
"commonly tested" or "frequently appears", not a date, not an exam name, not a
question number, not a mark scheme, unless it is printed in the reference
pages above. Never mention past papers in a question, a choice, an explanation
or a review reference.`
    : `\nSay nothing about past papers, previous exams or how the course tests this
material: none was retrieved, so anything you said about it would be invented.`;

  // How many items the plan asks for, which is what the length gate below
  // measures against. Each archetype carries its own range — the papers'
  // word-bank sections run to seven items and their a〜c sections to two — so
  // the total is the plan's, not a division of the requested count.
  const perSection = Math.max(2, Math.round(count / blueprint.length));
  const planned = blueprint.reduce(
    (total, archetype) =>
      total + Math.min(Math.max(perSection, archetype.items[0]), archetype.items[1]),
    0,
  );
  const prompt = `Create a practice test from the textbook excerpts below, all
from "${doc.title}" — the book the student owns. Every question must be drawn
from these excerpts. This textbook divides its content into ${division}s: write
every review reference as "${division} N — concept (p. NN)", using the
${division} numbers and page numbers as printed in the excerpts.
${
  level && level !== "INT"
    ? `\nThis is a ${
        level === "F2" ? "Foundation 2" : "Foundation 3"
      } paper. Stay inside that level: test only grammar and vocabulary present
in the excerpts below, and never reach for a pattern from a later course
because it would fit the sentence better.`
    : ""
}
${furiganaRule}
Around ${planned} questions in total, distributed across the sections exactly as
the plan above specifies — each section has its own item count because each
carries its own marks. Focus on ${
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
  }${provenanceRule}
${styleRules}
=== TEXTBOOK EXCERPTS — THE ONLY SOURCE OF CONTENT ===
${sample}`;
  // The plan and the distractor rules are both read off the sat papers. The
  // retrieved pages below then show the model what that looks like in print:
  // the plan says "three options labelled a〜c", the exemplar shows one.
  const system = `${SYSTEM}\n\n${sectionPlan(blueprint, language, perSection)}\n\n${
    DISTRACTORS[kind]
  }${
    styleBlock
      ? `\n\nThe request below includes real past-paper pages. Where one prints
the instruction line for a section you are writing, prefer that wording over
the line specified above — it is what the students read on the day.`
      : ""
  }`;
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
      // No question may repeat inside one paper. Dropping the repeat is
      // better than re-asking the model: it costs no second call, and a
      // 19-question paper with nothing duplicated beats a 20-question paper
      // that asks 食べる twice.
      const { quiz: deduped, removed } = dedupeQuiz(object, kind);
      if (removed > 0) {
        console.warn(`quiz on ${tier.provider}: dropped ${removed} repeated item(s)`);
      }
      // Then: no question may be a past-paper question. The exemplars are
      // shown as form, and a generator that lifts one has handed the student
      // back the paper they already sat. Enforced here for the same reason
      // the repeat check is — the prompt asks, and mostly gets, compliance.
      const { quiz: uncopied, removed: copied } = dropCopiedItems(deduped, exemplars);
      if (copied > 0) {
        console.warn(`quiz on ${tier.provider}: dropped ${copied} item(s) copied from a past paper`);
      }
      // Then: no question may be one the student cannot answer. Every fault
      // here is schema-valid and unusable — a right answer that is not among
      // its own options, two identical choices, a ○× item answered 「はい」,
      // a word-bank answer from no word in the bank.
      // Tidy first, then judge: an option labelled "a. a." and a sentence
      // carrying its own bracket are layout artefacts, not faults, and
      // rejecting items over them would throw away good questions.
      const { quiz: tidied, tidied: fixes } = tidyQuiz(uncopied);
      if (fixes > 0) {
        console.warn(`quiz on ${tier.provider}: tidied ${fixes} layout artefact(s)`);
      }
      const { quiz: checked, rejected } = validateQuiz(tidied, blueprint);
      if (rejected.length > 0) {
        console.warn(
          `quiz on ${tier.provider}: rejected ${rejected.length} invalid item(s): ` +
            rejected.map((r) => `[${r.section}.${r.item}] ${r.reason}`).join("; "),
        );
      }
      // Finally: no question the student has already been asked. This is the
      // check that makes "New Test" mean something across sittings rather than
      // only within one page load.
      const { quiz: paper, removed: repeats, kept } = dropRepeats(checked, history);
      if (repeats > 0) {
        console.warn(`quiz on ${tier.provider}: dropped ${repeats} item(s) seen before`);
      }

      // A paper that is schema-valid but far too short is still unusable —
      // seen live: 1 item back from a 9-item request. Let the next tier try.
      // Counted AFTER every filter, so a paper that only reached its length by
      // repeating itself, by copying the paper it was modelled on, or by
      // asking questions that cannot be answered, is short — which is what it
      // actually is. That is what makes the filters self-healing: a bad
      // generation fails the gate and the next provider writes the paper.
      const produced = paper.sections.reduce((n, s) => n + s.items.length, 0);
      if (produced < Math.ceil(planned * 0.6)) {
        throw new Error(`paper too short: ${produced} items for a ${planned}-item plan`);
      }
      // A section the plan says carries a passage must have one; without it
      // the ○× items refer to a text the student was never shown.
      // The plan asks for 300–400 characters. 150 is the floor at which a
      // passage can still carry four independent ○× statements — below it
      // the statements start restating one sentence, and seen live at 66
      // characters two of the four could not be decided from the text at all.
      // Only the ○× sections truly need one: their statements are about a
      // text, and without it the questions refer to nothing. A dialogue
      // section carries its own context in the items, so seen live it failed
      // this gate for a passage it never needed.
      const needsPassage = blueprint.some((a) => a.passage && a.form === "maru_batsu");
      if (needsPassage && !paper.sections.some((s) => s.passage && s.passage.length >= 150)) {
        throw new Error("paper's passage is missing or too short to support its questions");
      }

      // Remember what was asked, so the next paper is a different one.
      // Fire-and-forget: a history write must never cost a student their test.
      if (user && kept.length > 0) {
        void supabase
          .from("quiz_items")
          .insert(
            paper.sections.flatMap((section, sectionIndex) =>
              section.items.map((item) => {
                const print = fingerprint(item);
                return {
                  user_id: user.id,
                  level,
                  kind,
                  topic: contentScope !== null ? `T${contentScope}` : null,
                  archetype: blueprint[sectionIndex]?.id ?? null,
                  question_type: item.type,
                  question: item.question.slice(0, 500),
                  answer: item.answer.slice(0, 200),
                  choices: item.choices ?? [],
                  target: (item.target ?? item.grammar_point ?? "").slice(0, 120),
                  pattern: print.pattern.slice(0, 300),
                  frame: print.frame.slice(0, 500),
                  document_id: documentId,
                };
              }),
            ),
          )
          .then(undefined, () => {
            /* history is best-effort */
          });
      }

      return Response.json(paper, {
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
