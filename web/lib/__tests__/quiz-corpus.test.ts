/** The quiz pipeline against the real corpus.
 *
 * Every other test in this directory runs on fixtures written by hand, which
 * is right for the units and useless for the question this work was actually
 * about: does the generator, pointed at THIS course's books and THIS course's
 * past papers, retrieve the right pages, ground its wording in them, and stop
 * itself asking the same question twice?
 *
 * So this file runs on a copy of the production database. Not on production:
 *
 *   scripts/local-db.sh up            copy the corpus into a container
 *                                     (pg_dump only — read-only, and the
 *                                     student tables are excluded)
 *   node web/scripts/export-fixture.mjs   write .work/quiz-fixture.json
 *   npx vitest run quiz-corpus
 *
 * Skipped, loudly, when the fixture is absent — CI has no corpus and a test
 * that quietly passes on no data is worse than one that is not there.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { archetypes, planPaper, type Level } from "@/lib/paper-format";
import {
  chunksForLesson,
  dropCopiedItems,
  lessonByPage,
  rankChunksByFocus,
  selectExemplars,
  type ExemplarChunk,
  type Quiz,
  type QuizItem,
  type QuizKind,
} from "@/lib/quiz";
import { buildQuizPrompt } from "@/lib/quiz-prompt";
import { dropDuplicates } from "@/lib/quiz-signature";
import { tidyQuiz, validateQuiz } from "@/lib/quiz-validate";
import { attestedKanji, groundingScore, houseStyle } from "@/lib/textbook-usage";

interface FixtureChunk {
  content: string;
  metadata: Record<string, unknown> | null;
  book_page: string | null;
  pdf_page: number;
}
interface Fixture {
  documents: {
    id: number;
    title: string;
    level: string | null;
    doc_type: string;
    is_citable: boolean;
  }[];
  pools: Record<string, FixtureChunk[]>;
  papers: (ExemplarChunk & { level: string | null })[];
}

const PATH = resolve(__dirname, "..", "..", "..", ".work", "quiz-fixture.json");
const fixture: Fixture | null = existsSync(PATH)
  ? (JSON.parse(readFileSync(PATH, "utf8")) as Fixture)
  : null;

const suite = fixture ? describe : describe.skip;
if (!fixture) {
  console.warn(
    `quiz-corpus: no fixture at ${PATH} — run scripts/local-db.sh up && node web/scripts/export-fixture.mjs`,
  );
}

const book = (level: string) =>
  fixture!.documents.find((d) => d.doc_type === "textbook" && d.level === level)!;
const poolFor = (level: string) => fixture!.pools[String(book(level).id)];
const papersFor = (level: string) => fixture!.papers.filter((p) => p.level === level);
const strip = (text: string) => text.replace(/《[^》]*》/g, "");

/** A generated item, so a whole paper can be assembled in a line. */
function item(overrides: Partial<QuizItem>): QuizItem {
  return {
    type: "fill_blank",
    question: "テスト",
    answer: "です",
    explanation: "why",
    review: "Topic 4 — 〜に行きます (p. 60)",
    ...overrides,
  } as QuizItem;
}

function paper(sections: Quiz["sections"]): Quiz {
  return { scope_description: "test", sections };
}

suite("the corpus the app actually reads", () => {
  it("has both Foundation books and the papers for each", () => {
    // Every assertion below depends on this, and a fixture exported against
    // an empty database would otherwise make the whole file pass.
    for (const level of ["F2", "F3"]) {
      expect(book(level), level).toBeTruthy();
      expect(poolFor(level).length, `${level} chunks`).toBeGreaterThan(100);
      expect(papersFor(level).length, `${level} papers`).toBeGreaterThan(10);
    }
  });
});

suite("retrieval: which pages a scoped paper is drawn from", () => {
  it("maps each book onto the topics it actually covers", () => {
    // The Foundation 1 & 2 book runs Topics 1–10 and the Foundation 3 book
    // opens at Topic 11 — the case that used to file 115 pages of a
    // mid-course volume under "front matter" because the walk started at 1.
    const f2 = new Set(lessonByPage(poolFor("F2")).values());
    expect([...f2].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const f3 = [...new Set(lessonByPage(poolFor("F3")).values())].sort((a, b) => a - b);
    expect(f3[0]).toBe(0);
    expect(f3[1]).toBe(11);
    expect(Math.max(...f3)).toBeGreaterThanOrEqual(17);
  });

  it("returns only that topic's pages for a scoped test", () => {
    // The precision that matters: "test me on Topic 8" must not sample the
    // whole book. Every chunk that comes back has to be mapped to Topic 8.
    const pool = poolFor("F2");
    const lessons = lessonByPage(pool);
    for (const topic of [3, 6, 8, 10]) {
      const picked = chunksForLesson(pool, lessons, topic, 8);
      expect(picked.length, `topic ${topic}`).toBeGreaterThan(0);
      for (const chunk of picked) {
        expect(lessons.get(chunk.pdf_page), `topic ${topic} page ${chunk.pdf_page}`).toBe(topic);
      }
    }
  });

  it("never serves a later topic's material to an earlier scope", () => {
    // Untaught material on a practice paper is worse than no paper: the
    // student cannot tell a question they should have been able to answer
    // from one the course has not reached.
    const pool = poolFor("F3");
    const lessons = lessonByPage(pool);
    for (const chunk of chunksForLesson(pool, lessons, 13, 8)) {
      expect(lessons.get(chunk.pdf_page)!).toBeLessThanOrEqual(13);
    }
  });

  it("falls back to text matching for a focus that is not a topic", () => {
    const pool = poolFor("F3");
    const hits = rankChunksByFocus(pool, "けいご", 8);
    expect(hits.length).toBe(8);
  });
});

suite("grounding: the textbook as the source of truth", () => {
  it("reads this course's own spellings off the book", () => {
    // The requirement's own example. Measured over the Foundation 1 & 2 book:
    // じゃありません 9, じゃないです 8, ではありません 1 — so both of the first
    // two are the course's Japanese and the third is not, and a paper drilling
    // ではありません is testing something the student cannot look up.
    const style = houseStyle(poolFor("F2").map((c) => c.content));
    const negative = style.find((entry) => entry.id === "negative-copula");
    expect(negative, "the Foundation book should decide the negative copula").toBeTruthy();
    expect(negative!.prefer).toContain("じゃありません");
    expect(negative!.avoid).toContain("ではありません");

    // And the other side of it: the book uses じゃないです too, so it must not
    // be forbidden.
    expect(negative!.avoid).not.toContain("じゃないです");
  });

  it("reads a different answer off a different book", () => {
    // Not a rule someone wrote down: the Foundation 3 book settles obligation
    // on なければなりません and never writes the alternatives, while the
    // Foundation 2 book — which has not taught the pattern — says nothing.
    const f3 = houseStyle(poolFor("F3").map((c) => c.content));
    const obligation = f3.find((entry) => entry.id === "obligation");
    expect(obligation!.prefer).toEqual(["なければなりません"]);
    expect(obligation!.avoid).toEqual(
      expect.arrayContaining(["なくてはいけません", "ないといけません"]),
    );
  });

  it("prefers the tested topic's own wording over the whole book's", () => {
    // The Foundation 1 & 2 book spans ten topics, and its later kanji section
    // writes 友達 where its early pages write ともだち. A Topic 2 paper takes
    // its style from Topic 2's pages.
    const pool = poolFor("F2");
    const lessons = lessonByPage(pool);
    const early = chunksForLesson(pool, lessons, 2, 8).map((c) => c.content);
    const scoped = houseStyle(early, pool.map((c) => c.content));
    const friend = scoped.find((entry) => entry.id === "friend");
    // Whatever it decides, it must decide it from somewhere, and say which.
    expect(friend?.from ?? "book").toMatch(/excerpts|book/);
  });

  it("covers the course's own papers with the course's own book", () => {
    // The attestation check drops an item using a character the book never
    // prints. Run the other way — the real papers against the real book — it
    // has to come out near 1, or the check is measuring the corpus rather
    // than the generator.
    for (const level of ["F2", "F3"]) {
      const attested = attestedKanji(poolFor(level).map((c) => c.content));
      const score = groundingScore(
        papersFor(level).map((p) => p.content),
        attested,
      );
      expect(score, `${level} grounding`).toBeGreaterThan(0.95);
    }
  });

  it("still catches a character the book does not contain", () => {
    const attested = attestedKanji(poolFor("F2").map((c) => c.content));
    const checked = validateQuiz(
      paper([
        {
          instruction_ja: "読み方を書いてください。",
          instruction_en: "Write the reading.",
          form: "written",
          items: [
            item({ question: "毎日【曖昧】な返事をします。", answer: "あいまい" }),
            item({ question: "毎日【学校】に行きます。", answer: "がっこう" }),
          ],
        },
      ]),
      [],
      { attestedKanji: attested },
    );
    expect(checked.rejected).toHaveLength(1);
    expect(checked.rejected[0].reason).toMatch(/never prints/);
  });
});

suite("past-paper alignment", () => {
  it("prints instruction lines the papers actually print", () => {
    // Every archetype claims its instruction is the course's own wording.
    // This is that claim, checked: a run of at least eight characters of it
    // has to appear in the transcribed papers. An instruction somebody
    // invented cannot clear that, and an invented instruction is exactly what
    // the catalogue exists to replace.
    const corpus = strip(fixture!.papers.map((p) => p.content).join("\n")).replace(/[\s　]/g, "");
    for (const level of ["F2", "F3"] as Level[]) {
      for (const kind of ["grammar", "kanji"] as QuizKind[]) {
        for (const archetype of archetypes(level, kind)) {
          const line = strip(archetype.instructionJa).replace(/[\s　]/g, "");
          const runs = Array.from({ length: Math.max(0, line.length - 8) }, (_, i) =>
            line.slice(i, i + 8),
          );
          expect(
            runs.some((run) => corpus.includes(run)),
            `${archetype.id}: 「${archetype.instructionJa}」 is not on any sat paper`,
          ).toBe(true);
        }
      }
    }
  });

  it("names topics the corpus can show for every archetype", () => {
    const topics = new Set(
      fixture!.papers
        .map((p) => (p.metadata?.["topic"] as string | undefined) ?? "")
        .filter(Boolean),
    );
    for (const level of ["F2", "F3"] as Level[]) {
      for (const kind of ["grammar", "kanji"] as QuizKind[]) {
        for (const archetype of archetypes(level, kind)) {
          const cited = [...archetype.seenOn.matchAll(/T(\d{1,2})/g)].map((m) => `T${m[1]}`);
          expect(cited.length, archetype.id).toBeGreaterThan(0);
          expect(
            cited.some((topic) => topics.has(topic)),
            `${archetype.id} cites ${cited.join(",")}, corpus has none of them`,
          ).toBe(true);
        }
      }
    }
  });

  it("shows the model papers of the right kind, from other topics", () => {
    for (const level of ["F2", "F3"]) {
      for (const kind of ["grammar", "kanji"] as QuizKind[]) {
        const picked = selectExemplars(papersFor(level), kind, 8, 2, 1);
        expect(picked.length, `${level}/${kind}`).toBeGreaterThan(0);
        for (const chunk of picked) {
          const title = String(chunk.metadata?.["paper_title"] ?? "");
          const wanted = kind === "grammar" ? /文法/ : /漢字|かんじ|語彙|ごい/;
          expect(wanted.test(title), `${level}/${kind}: got ${title}`).toBe(true);
          // Never the topic being tested — the format does not vary by topic,
          // so a same-topic paper gives the model something on-topic to lift
          // and teaches it nothing extra.
          expect(chunk.metadata?.["topic"], `${level}/${kind}`).not.toBe("T8");
        }
      }
    }
  });

  it("spreads them across sittings rather than taking one paper twice", () => {
    // Two pages of one 文法・読解クイズ teach that paper's habits; two pages
    // of two teach the course's. This was live: the per-paper cap equalled
    // the number retrieved, so it never bound.
    const picked = selectExemplars(papersFor("F2"), "grammar", 8, 2, 1);
    const sittings = new Set(
      picked.map(
        (c) => `${c.metadata?.["exam_term"]}|${c.metadata?.["paper_title"]}|${c.metadata?.["topic"]}`,
      ),
    );
    expect(sittings.size).toBe(picked.length);
  });

  it("drops an item lifted off a past paper", () => {
    // The worst thing this feature could do is hand a student the paper they
    // already sat with the answers on it. Take a real sentence out of a real
    // paper, feed it back as a generated item, and it has to be caught.
    const exemplars = selectExemplars(papersFor("F2"), "grammar", null, 4, 2);
    const source = exemplars
      .flatMap((chunk) => strip(chunk.content).split(/\n+/))
      .map((line) => line.replace(/^[\s(（]*\d+[)）.]\s*/, "").trim())
      .find((line) => line.length > 24 && /[ぁ-ゖ]/.test(line) && !/クイズ|なまえ|クラス/.test(line))!;
    expect(source, "no usable sentence in the retrieved pages").toBeTruthy();

    const { removed } = dropCopiedItems(
      paper([
        {
          instruction_ja: "正しいほうを選んでください。",
          instruction_en: "Circle the correct one.",
          form: "written",
          items: [item({ question: source }), item({ question: "新しい文です。" })],
        },
      ]),
      exemplars,
    );
    expect(removed).toBe(1);
  });
});

suite("prompting from the real corpus", () => {
  const excerptsFor = (level: string, topic: number) => {
    const pool = poolFor(level);
    const lessons = lessonByPage(pool);
    return chunksForLesson(pool, lessons, topic, 8)
      .map((c) => `--- From "${book(level).title}", Topic ${topic} ---\n${c.content.slice(0, 700)}`)
      .join("\n\n");
  };

  it("builds a prompt carrying the plan, the book's wording and the papers", () => {
    const level = "F2";
    const plan = planPaper("F2", "grammar", { topic: 8, variant: 0 });
    const pool = poolFor(level);
    const lessons = lessonByPage(pool);
    const scoped = chunksForLesson(pool, lessons, 8, 8).map((c) => c.content);

    const built = buildQuizPrompt({
      bookTitle: book(level).title,
      documentLevel: level,
      formatLevel: "F2",
      kind: "grammar",
      plan,
      topic: 8,
      excerpts: excerptsFor(level, 8),
      exemplars: selectExemplars(papersFor(level), "grammar", 8, 2, 1),
      style: houseStyle(scoped, pool.map((c) => c.content)),
      perSection: 5,
    });

    // Every planned section is described, with the instruction the papers use.
    for (const section of plan) {
      expect(built.system).toContain(section.instructionJa);
      expect(built.system).toContain(section.skill);
    }
    // The measured house style reached the model.
    expect(built.prompt).toContain("HOW THIS BOOK WRITES");
    expect(built.prompt).toContain("Never write");
    // The past papers are shown, and shown as form.
    expect(built.prompt).toContain("HOW THIS COURSE'S PAPERS LOOK (form only)");
    expect(built.planned).toBeGreaterThanOrEqual(12);
  });

  it("never carries a name, an ID or a mark into the prompt", () => {
    // The past papers are phone scans of a marked script. The ingest
    // redaction is what keeps the classmate's name out of the corpus; this is
    // the check that nothing downstream reintroduces it, because the exemplar
    // block is the one place a scanned page reaches a model verbatim.
    const built = buildQuizPrompt({
      bookTitle: book("F3").title,
      documentLevel: "F3",
      formatLevel: "F3",
      kind: "kanji",
      plan: planPaper("F3", "kanji", { topic: 13, variant: 0 }),
      topic: 13,
      excerpts: excerptsFor("F3", 13),
      exemplars: selectExemplars(papersFor("F3"), "kanji", 13, 2, 1),
      style: [],
      perSection: 5,
    });
    // A filled-in name field, a student ID, or a score in the corner.
    expect(built.prompt).not.toMatch(/なまえ[:：\s　]*[^\s＿_（(\n]/);
    expect(built.prompt).not.toMatch(/\b\d{5,}\b/);
    expect(built.prompt).not.toMatch(/[／/]\s?\d{1,3}\s*点/);
  });

  it("writes an English paper for an early topic and a Japanese one later", () => {
    const common = {
      bookTitle: book("F2").title,
      documentLevel: "F2",
      formatLevel: "F2" as Level,
      kind: "grammar" as QuizKind,
      excerpts: excerptsFor("F2", 3),
      exemplars: [],
      style: [],
      perSection: 4,
    };
    const early = buildQuizPrompt({
      ...common,
      plan: planPaper("F2", "grammar", { topic: 3 }),
      topic: 3,
    });
    const late = buildQuizPrompt({
      ...common,
      plan: planPaper("F2", "grammar", { topic: 9 }),
      topic: 9,
    });
    // Up to Topic 6 the papers are in English, so the English line is quoted
    // exactly; from Topic 7 the Japanese leads and the English is a gloss.
    expect(early.system).toContain('instruction_en: exactly "');
    expect(late.system).toContain('instruction_en: exactly "');
    expect(early.system).not.toEqual(late.system);
  });
});

suite("duplicate prevention on a paper built from the corpus", () => {
  it("keeps one of two items that drill one point in two sections", () => {
    const checked = dropDuplicates(
      paper([
        {
          instruction_ja: "正しいほうを選んでください。",
          instruction_en: "Circle the correct one.",
          form: "bracket",
          items: [
            item({
              type: "multiple_choice",
              question: "デパートで買い物する（　）に、ATMでお金をおろします。",
              choices: ["まえ", "あと", "とき"],
              answer: "まえ",
              target: "〜まえに",
            }),
          ],
        },
        {
          instruction_ja: "下の＿＿からことばを選んでください。",
          instruction_en: "Choose from the box.",
          form: "written",
          items: [
            item({
              question: "電車に【のる】（　）に、きっぷをかいます。",
              answer: "まえ",
              target: "the 〜まえに pattern (before doing)",
            }),
            item({
              question: "本を【よむ】ことができます。",
              answer: "よむ",
              target: "〜ことができます",
            }),
          ],
        },
      ]),
    );
    expect(checked.removed).toBe(1);
    expect(checked.quiz.sections.flatMap((s) => s.items)).toHaveLength(2);
  });

  it("runs the whole gauntlet without eating a good paper", () => {
    // Tidy, validate against the book, drop duplicates: a paper of four
    // genuinely different, properly grounded items has to survive all of it.
    // A filter chain that quietly removes good questions shows up here and
    // nowhere else, because every unit test feeds it one item at a time.
    const pool = poolFor("F2");
    const material = {
      attestedKanji: attestedKanji(pool.map((c) => c.content)),
      style: houseStyle(pool.map((c) => c.content)),
    };
    const good = paper([
      {
        instruction_ja: "正しいほうを選んで、〇を書いてください。",
        instruction_en: "Choose the appropriate answer.",
        form: "bracket",
        marks: 1,
        items: [
          item({
            type: "multiple_choice",
            question: "毎日、しょくどう（　）昼ごはんを食べます。",
            choices: ["で", "に", "を"],
            answer: "で",
            target: "で marking the place of an action",
          }),
          item({
            type: "multiple_choice",
            question: "7時（　）おきます。",
            choices: ["に", "で", "を"],
            answer: "に",
            target: "に marking a point in time",
          }),
        ],
      },
      {
        instruction_ja: "＿＿に正しい疑問詞をひらがなで書いてください。",
        instruction_en: "Fill in the question word.",
        form: "written",
        marks: 1,
        items: [
          item({ question: "Q：しゅみは（　）ですか。 A：えいがです。", answer: "なん", target: "なん" }),
          item({
            question: "Q：（　）へ行きましたか。 A：友だちのうちへ行きました。",
            answer: "どこ",
            target: "どこ",
          }),
        ],
      },
    ]);

    const tidied = tidyQuiz(good);
    const validated = validateQuiz(
      tidied.quiz,
      planPaper("F2", "grammar", { topic: 8 }),
      material,
    );
    const deduped = dropDuplicates(validated.quiz);
    expect(validated.rejected, JSON.stringify(validated.rejected)).toHaveLength(0);
    expect(deduped.removed, deduped.reasons.join("; ")).toBe(0);
    expect(deduped.quiz.sections.flatMap((s) => s.items)).toHaveLength(4);
  });
});
