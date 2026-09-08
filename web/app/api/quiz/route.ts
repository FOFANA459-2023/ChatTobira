import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { generateObject } from "ai";
import { z } from "zod";

import { cachedPool, rememberPool } from "@/lib/corpus-cache";
import {
  ACCEPT_BUDGET_MS,
  estimateTokens,
  noteProviderFailure,
  withDeadline,
} from "@/lib/providers";
import { routeModels } from "@/lib/router";
import {
  chunksForLesson,
  dedupeQuiz,
  dropCopiedItems,
  focusTokens,
  lessonByPage,
  QuizSchema,
  rankChunksByFocus,
  selectExemplars,
  type ExemplarChunk,
  type Quiz,
} from "@/lib/quiz";
import { planPaper, type Level } from "@/lib/paper-format";
import { buildQuizPrompt, itemsForPlan, MIN_PASSAGE_CHARS } from "@/lib/quiz-prompt";
import { dropDuplicates, dropRepeats, fingerprint, type Fingerprint } from "@/lib/quiz-signature";
import { tidyQuiz, validateQuiz, type MaterialContext } from "@/lib/quiz-validate";
import { attestedKanji, houseStyle } from "@/lib/textbook-usage";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { trialCookie, trialUsed, TRIALS } from "@/lib/trial";

export const maxDuration = 60;

/** How much room a paper is given to be written in, and on which prompt.
 *
 * Both numbers below are measurements taken against the local copy of the
 * corpus (scripts/local-db.sh), not estimates, because every previous version
 * of this constant was an estimate and every one of them was wrong in a way
 * that surfaced as a different error.
 *
 * Google is first for a structured job (lib/router.ts) and gets the whole
 * budget, because it meters nothing of the sort and because how much of that
 * budget it spends depends entirely on which Gemini a deployment names.
 * Measured on the corpus copy with the same prompt:
 *
 *   gemini-3.5-flash-lite   8.7s   18 items, 4 sections   what this app runs
 *   gemini-3.6-flash        38-50s 17 items, 4 sections   input 6,239,
 *                                                         output 2,352,
 *                                                         REASONING 5,735
 *
 * The paper itself is 2,400 tokens of JSON either way. What made the previous
 * 4,800 too small was the second row: a thinking model bills its reasoning to
 * the same allowance, so the symptom was never a short paper, it was invalid
 * JSON — "could not parse the response" — from a tier that looked like it had
 * failed for no reason. 16,000 covers both.
 *
 * Groq's free tier meters PROMPT PLUS RESERVED OUTPUT against 8,000 tokens a
 * minute, and the full prompt is ~6,300 tokens by the provider's own count.
 * There is no output budget that fits beside it: 6,300 + 3,000 is over the
 * ceiling before the model writes a character, and Groq answers 413 —
 *
 *   "Request too large ... on tokens per minute (TPM): Limit 8000"
 *
 * So the free tier gets a SHORTER PROMPT rather than a smaller allowance:
 * fewer excerpts, capped tighter, no past-paper pages, and the plan without
 * the prose that coaches it (see buildQuizPrompt's `compact`). It is a worse
 * prompt and it writes a worse paper, and that is the right trade for a
 * backstop — the alternative is a tier that can only ever be refused, which
 * is what the cascade had become.
 *
 * What it buys, measured on the corpus copy: a Foundation 2 paper of two
 * sections where the plan asked for four. Usable, and the route treats it as
 * the failed generation it is — a near miss, served only if nothing better
 * arrives.
 *
 * What it does NOT buy is a Foundation 3 paper. Those carry two passages and
 * their items are worth two marks each, so the JSON is half as long again,
 * and 3,800 output tokens truncates it however small the prompt gets. The
 * free tier is a Foundation 2 backstop and nothing more; a Foundation 3
 * student's paper is written by Gemini or not at all. That is a property of
 * an 8,000-token-a-minute ceiling, not something a prompt can be tuned
 * around, and it is written down here so the next person does not spend an
 * afternoon rediscovering it.
 */
const OUTPUT_BUDGET = { groq: 3_800, deepseek: 8_000, google: 16_000 } as const;

/** Excerpts for the free tier's prompt: fewer, shorter. */
const COMPACT_EXCERPTS = 4;
const COMPACT_EXCERPT_CHARS = 320;

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
      // The whole book, not most of it. 500 was a round number and the
      // Foundation 1 & 2 book is 516 chunks, so the last sixteen pages were
      // outside the pool — invisible to the excerpt sample, and (worse)
      // outside the attested-kanji set, where a missing page turns into a
      // rejected question about a character the book does print.
      .limit(800);
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
  const excerptBlock = (chunks: QuizChunk[], chars: number) =>
    chunks
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
        return [`--- From ${header} ---`, c.content.slice(0, chars)].join("\n");
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

  // What this student has already been asked at this level. The paper they
  // just sat still rides in on `avoid`, but that dies with the page; this is
  // what makes the third test of the week different from the first.
  let history: Fingerprint[] = [];
  let sat = 0;
  if (user) {
    const { data: prior } = await supabase
      .from("quiz_items")
      .select("question, answer, target, pattern, frame, archetype")
      .eq("kind", kind)
      .eq("level", level ?? "")
      .order("created_at", { ascending: false })
      .limit(120);
    const rows = (prior ?? []) as {
      pattern: string | null;
      frame: string | null;
      question: string;
      archetype: string | null;
    }[];
    history = rows
      .map((row) => ({
        exact: row.question ?? "",
        pattern: row.pattern ?? "",
        frame: row.frame ?? "",
        skill: "",
        comprehension: false,
      }))
      .filter((print) => print.pattern || print.frame);
    // Distinct section types this student has already met, which is what
    // moves the plan on. Counting PAPERS would need a paper id the history
    // table does not carry; counting the archetypes they have seen does the
    // same job — a student who has met four section types gets the fifth.
    sat = new Set(rows.map((row) => row.archetype).filter(Boolean)).size;
  }

  // The paper's plan, from the format catalogue. Intermediate has no sat
  // papers in the corpus, so it falls back to the Foundation 3 shapes —
  // closest in level, and better than a template nobody's course uses.
  //
  // `variant` is what stops a student meeting the same four 問題 every time.
  // The catalogue holds fifteen section types across the two levels and the
  // old fixed blueprint used four of them; rotating on what this student has
  // already been shown means their second Topic 8 paper has a section their
  // first did not. A trial visitor has no history and always gets variant 0,
  // which is the most typical paper — the right one to be shown first.
  const plan = planPaper(formatLevel, kind, { topic: contentScope, variant: sat });

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
    // Two pages, capped at roughly one page of text each. The ceiling here
    // is Groq's free tier at 12k tokens/minute, and Japanese spends close to
    // a token per character — the textbook sample already costs ~9,000
    // characters, so this block has to buy its place. Two pages from two
    // sittings is enough to show the section order, the instruction wording
    // and the distractor style; a third mostly repeats them.
    //
    // One page per paper, which is the whole reason the cap exists and was
    // not being reached: with two of two allowed from one sitting, both
    // retrieved pages came off the same 文法・読解クイズ, and two pages of one
    // paper teach that paper's habits where two pages of two teach the
    // course's.
    exemplars = selectExemplars(papers, kind, contentScope, 2, 1);
  }

  // What this book's own Japanese looks like, measured rather than assumed:
  // which of several correct spellings it uses, and which characters it
  // contains at all. Counted over the excerpts the paper is drawn from, with
  // the whole book behind them for the alternations the excerpts are too thin
  // to settle. See lib/textbook-usage.ts.
  //
  // Cached with the pool, because both are pure functions of the book and
  // "New Test" should not re-scan half a megabyte of Japanese to ask the same
  // question of it twice.
  let material = cachedPool<MaterialContext>(`material:${documentId}`);
  if (!material) {
    material = {
      style: houseStyle(
        picked.map((c) => c.content),
        allChunks.map((c) => c.content),
      ),
      attestedKanji: attestedKanji(allChunks.map((c) => c.content)),
    };
    rememberPool(`material:${documentId}`, material);
  }

  // How many items the plan asks for, which is what the length gate below
  // measures against. Each archetype carries its own range — the papers'
  // word-bank sections run to seven items and their a~c sections to two — so
  // the total is the plan's, not a division of the requested count, and it is
  // capped at what a provider will actually finish writing. See
  // lib/quiz-prompt.ts: asking for a paper that does not fit does not get a
  // shorter paper back, it gets a truncated one.
  const perSection = itemsForPlan(plan, count);

  const promptFor = (chunks: typeof picked, withExemplars: boolean, chars: number) =>
    buildQuizPrompt({
      compact: !withExemplars,
      bookTitle: doc.title,
      documentLevel: level,
      formatLevel,
      kind,
      plan,
      topic: contentScope,
      excerpts: excerptBlock(chunks, chars),
      exemplars: withExemplars ? exemplars : [],
      style: material.style ?? [],
      focus,
      avoid,
      perSection,
    });

  const { system, prompt, planned } = promptFor(picked, true, 700);
  // The free tier's version of the same request — see OUTPUT_BUDGET.
  const compact = promptFor(picked.slice(0, COMPACT_EXCERPTS), false, COMPACT_EXCERPT_CHARS);


  const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });
  const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_API_KEY });

  // Ordered by lib/router.ts, which is the one place the policy lives now —
  // the chat route and this one used to keep two hand-written cascades that
  // had already drifted apart.
  //
  // Groq builds papers, on the gpt-oss models rather than the chat model:
  // generateObject needs response_format json_schema, which Groq implements
  // only on those — llama-3.3 rejected it, which silently sent every quiz to
  // Gemini and its 20-requests-a-day budget.
  //
  // DeepSeek was briefly first here and must not be again; lib/router.ts
  // carries the measurements. Short version: it reasons for over two minutes
  // on a fifteen-item schema, which is longer than this route is allowed to
  // run, and that is what "Could not generate a test" was.
  const promptTokens = estimateTokens(system) + estimateTokens(prompt);
  const route = routeModels("structured", {
    // A paper's prompt is a system prompt plus ~10 short excerpts, well
    // inside every tier's ceiling; the size gate is not what decides here.
    promptTokens,
    hasDeepSeek: Boolean(process.env.DEEPSEEK_API_KEY),
    // Named per provider, which is the shape this router takes. The Groq
    // entry must be a gpt-oss model and not the chat model: generateObject
    // needs response_format json_schema, and Groq implements it only on
    // those — qwen rejects it, which silently sent every paper to Gemini.
    models: {
      groq: process.env.QUIZ_MODEL ?? "openai/gpt-oss-120b",
      deepseek: process.env.DEEPSEEK_MODEL,
      google: process.env.FALLBACK_MODEL,
    },
  });

  const clientFor = {
    groq: (model: string) => groq(model),
    deepseek: (model: string) => {
      const deepseek = createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY! });
      return deepseek(model);
    },
    google: (model: string) => google(model),
  } as const;

  // One line per paper, so the size that decides everything below is visible.
  // Groq's free tier meters PROMPT PLUS RESERVED OUTPUT against 8,000 tokens a
  // minute, so what fits is a property of this number and nothing else.
  console.info(
    `quiz ${kind} doc=${documentId} ~${promptTokens}tok → ${route
      .map((t) => t.model)
      .join(",")}`,
  );
  // Opt-in, because it is the only way to see what the model was actually
  // asked. Set QUIZ_DEBUG_PROMPT=1 locally: a requirement that lives in the
  // validator but never reached the prompt is invisible from the outside, and
  // that was the whole of the "Could not generate a test" bug.
  if (process.env.QUIZ_DEBUG_PROMPT === "1") {
    console.info(`---- QUIZ SYSTEM ----`);
    console.info(system);
    console.info(`---- END QUIZ SYSTEM ----`);
  }

  // The label is the model id. Two tiers now share the provider "groq", so a
  // log line naming only the provider cannot say which of them failed.
  const tiers = route.map(({ provider, model }) => ({
    provider,
    label: model,
    model: clientFor[provider](model),
    outputBudget: OUTPUT_BUDGET[provider],
    // Groq is metered on prompt plus reserved output together, so it gets the
    // compact prompt or it gets a 413. Everything else gets the real one.
    ask: provider === "groq" ? compact : { system, prompt },
  }));

  /** Remember what was asked, so the next paper is a different one.
   *
   * Fire-and-forget: a history write must never cost a student their test.
   * Shared by the clean path and the near miss below, because a paper that
   * was served is a paper the student has now seen — whether or not it
   * cleared the bar. Recording only the perfect ones would ask them the same
   * questions again next week. */
  function recordHistory(written: Quiz, prints: Fingerprint[]): void {
    if (!user || prints.length === 0) return;
    void supabase
      .from("quiz_items")
      .insert(
        written.sections.flatMap((section, sectionIndex) =>
          section.items.map((item) => {
            const print = fingerprint(item);
            return {
              user_id: user.id,
              level,
              kind,
              topic: contentScope !== null ? `T${contentScope}` : null,
              archetype: plan[sectionIndex]?.id ?? null,
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

  /** The best paper produced so far that fell short of the bar.
   *
   * The section check above is strict on purpose — a paper missing its
   * reading section is not the paper the course sets — but strict gates and a
   * three-tier cascade produce a new way to fail: every tier writes something
   * usable, each is rejected for the same missing section, and the student
   * gets "Could not generate a test" instead of a slightly short paper. That
   * trade is wrong. A paper with three of four sections is worth far more to
   * someone revising than no paper at all, so the best near-miss is kept and
   * served if nothing better arrives. */
  let nearMiss: { paper: Quiz; kept: Fingerprint[]; why: string } | null = null;

  // The route may run for `maxDuration`; a tier may have whatever is left of
  // it. A fixed per-tier budget cannot be right for both the first tier and
  // the third — 45 seconds each is 135 seconds of a 60-second request — and
  // the failure it produces is the worst kind: the request dies mid-generation
  // and the student is told nothing at all.
  const deadline = Date.now() + (maxDuration - 5) * 1_000;

  for (const tier of tiers) {
    // Same reason as the chat route: a tier that neither accepts nor refuses
    // would otherwise hold the whole request until the route's own ceiling.
    // The budget is far longer here because a paper is a big structured
    // generation and nobody is listening in silence for it.
    const remaining = deadline - Date.now();
    // Below this there is not enough time left to write a paper, and starting
    // one guarantees a timeout instead of the near miss already in hand.
    if (remaining < 10_000) {
      console.warn(`quiz: skipping ${tier.label}, ${Math.round(remaining / 1000)}s left`);
      break;
    }
    const controller = new AbortController();
    try {
      const { object } = await withDeadline(
        generateObject({
          model: tier.model,
          schema: QuizSchema,
          system: tier.ask.system,
          prompt: tier.ask.prompt,
          // Test papers should vary between sittings; greedy decoding regrows
          // the same questions from the same excerpts.
          temperature: 0.8,
          // The paper is the largest thing this app generates and nothing was
          // reserving room for it. Left unset, the provider's default output
          // budget truncates the JSON part way through, and every symptom
          // students actually saw comes from that one omission:
          //
          //   unset            7.2s   11 items for a 17-item plan, 116-char passage
          //   maxOutputTokens  14.0s  17 items, 4 sections, passage intact
          //
          // Truncated JSON does not arrive as short JSON — it arrives as
          // INVALID JSON, so the validity gates below reported "paper too
          // short: 4 items for a 17-item plan" and "passage is missing or too
          // short", and on the gpt-oss reasoning models it came back as no
          // content at all: Groq answers json_validate_failed with an empty
          // failed_generation. Three different-looking failures, one cause.
          //
          // The size is bounded from BOTH ends, which is why it is a constant
          // and not simply "large". Groq's free tier meters prompt plus
          // RESERVED output against 8,000 tokens a minute, and reserving 16,000
          // put every request over it — "Request too large ... on tokens per
          // minute (TPM): Limit 8000, Requested 8216" — so a generous ceiling
          // fails just as surely as a small one, only with a different error.
          //
          // 4,800 sits above the 3,852 a full seventeen-item paper actually
          // used, and leaves a ~3,000-token prompt inside the minute's budget.
          maxOutputTokens: tier.outputBudget,
          abortSignal: controller.signal,
        }),
        Math.min(ACCEPT_BUDGET_MS.structured, remaining),
        "tier_timeout",
      );
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
      // Judged against the plan AND against the book: an item can be perfectly
      // answerable and still be one this course could not have set, because
      // it spells a word a way the book never spells it or uses a character
      // the book does not contain. Both are measurements of the student's own
      // textbook — see lib/textbook-usage.ts.
      const { quiz: checked, rejected } = validateQuiz(tidied, plan, material);
      if (rejected.length > 0) {
        console.warn(
          `quiz on ${tier.provider}: rejected ${rejected.length} invalid item(s): ` +
            rejected.map((r) => `[${r.section}.${r.item}] ${r.reason}`).join("; "),
        );
      }
      // Then: no two questions on this paper may be the same question. This
      // runs ACROSS sections, which is where the repeats actually hide — the
      // generator drills 〜まえに in section I and again in section III with
      // the shop changed to a station, and calls them different because it
      // wrote a different label on each.
      const near = dropDuplicates(checked);
      if (near.removed > 0) {
        console.warn(
          `quiz on ${tier.provider}: dropped ${near.removed} duplicate item(s): ` +
            near.reasons.join("; "),
        );
      }
      // Finally: no question the student has already been asked. This is the
      // check that makes "New Test" mean something across sittings rather than
      // only within one page load.
      const dropped = dropRepeats(near.quiz, history);
      let paper = dropped.quiz;
      const { removed: repeats, kept } = dropped;
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
      // A missing SECTION is a different failure from a short one, and the
      // item count cannot see it. dropRepeats removes a section once its last
      // item is filtered away, so a paper could lose a whole 問題 — the
      // reading passage, the word bank — and still clear a 60% item bar. That
      // is exactly what stopped these looking like the papers they copy:
      // the format is the sections, not the number of questions.
      const shortOf =
        paper.sections.length < plan.length
          ? `missing a section: ${paper.sections.length} of ${plan.length} survived`
          : produced < Math.ceil(planned * 0.6)
            ? `too short: ${produced} items for a ${planned}-item plan`
            : null;
      if (shortOf) {
        // Keep it in case nothing better comes back. More sections first,
        // then more items: a paper that covers the format matters more than
        // one with a couple of extra questions in the sections it kept.
        const better =
          !nearMiss ||
          paper.sections.length > nearMiss.paper.sections.length ||
          (paper.sections.length === nearMiss.paper.sections.length &&
            produced >
              nearMiss.paper.sections.reduce(
                (n: number, x: { items: unknown[] }) => n + x.items.length,
                0,
              ));
        if (better && paper.sections.length > 0 && produced > 0) {
          nearMiss = { paper, kept, why: shortOf };
        }
        throw new Error(`paper ${shortOf}`);
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
      // A ○× section without its passage asks about a text the student cannot
      // see, so those questions have to go. What used to happen is that the
      // whole paper went with them — and when the prompt is large enough that
      // Groq is out of range on size, Google is the only tier left, so one
      // missing passage was the difference between a practice test and
      // "Could not generate a test".
      //
      // Dropping the section instead leaves three usable 問題 and lets the
      // section-count gate below decide whether that is worth serving. A
      // student revising tonight is better off with three sections than with
      // an error, and the gate still prefers a complete paper from the next
      // tier if one arrives.
      const needsPassage = plan.some((a) => a.passage && a.form === "maru_batsu");
      const unanswerable = (section: Quiz["sections"][number]) =>
        section.form === "maru_batsu" &&
        !(section.passage && section.passage.length >= MIN_PASSAGE_CHARS);

      if (needsPassage && paper.sections.some(unanswerable)) {
        const kept = paper.sections.filter((section) => !unanswerable(section));
        console.warn(
          `quiz on ${tier.provider}: dropped ${paper.sections.length - kept.length} section(s) whose passage was missing or too short`,
        );
        paper = { ...paper, sections: kept };
      }

      recordHistory(paper, kept);

      return Response.json(paper, {
        headers: setCookie ? { "Set-Cookie": setCookie } : undefined,
      });
    } catch (error) {
      // Abort a timed-out generation rather than leaving it running: on a
      // metered provider an abandoned paper is still a paid one.
      controller.abort();
      // Declined or produced an unusable paper — try the next provider. The
      // reason is logged because a silent cascade turns "every tier failed"
      // into an undiagnosable 502.
      //
      // The message alone is not the reason. Groq's structured-output failure
      // reads "Failed to validate JSON. Please adjust your prompt. See
      // 'failed_generation' for more details" — and 'failed_generation' is in
      // the response body, which was being thrown away, so the one line that
      // says WHICH field the model got wrong never reached the log. That is
      // the difference between diagnosing this in a minute and guessing at it.
      const detail =
        (error as { responseBody?: string; cause?: unknown } | null)?.responseBody ??
        (error as { cause?: { responseBody?: string } } | null)?.cause?.responseBody;
      console.error(
        `quiz generation failed on ${tier.provider} (${tier.label}):`,
        error instanceof Error ? error.message : error,
        detail ? `\n  response: ${String(detail).slice(0, 1200)}` : "",
      );
      noteProviderFailure(tier.provider, error);
    }
  }
  // Nothing cleared the bar, but something was written. A slightly short
  // paper beats no paper for a student revising tonight.
  if (nearMiss) {
    console.warn(`quiz served a near miss (${nearMiss.why})`);
    recordHistory(nearMiss.paper, nearMiss.kept);
    return Response.json(nearMiss.paper, {
      headers: setCookie ? { "Set-Cookie": setCookie } : undefined,
    });
  }

  // No paper was produced at all, so the trial visitor keeps their free test:
  // the cookie is only spent on a request that actually returned something.
  return Response.json({ error: "all_models_unavailable" }, { status: 502 });
}
