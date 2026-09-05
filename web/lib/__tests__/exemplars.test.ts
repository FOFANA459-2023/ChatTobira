import { describe, expect, it } from "vitest";

import {
  dropCopiedItems,
  exemplarProvenance,
  paperIdentity,
  selectExemplars,
  type Quiz,
  type QuizItem,
  type ExemplarChunk,
} from "@/lib/quiz";

/** A past-paper chunk as the quiz route fetches it. */
function paper(
  content: string,
  meta: { topic?: string; exam_term?: string; paper_title?: string } = {},
): ExemplarChunk {
  return { content, metadata: { is_past_paper: true, ...meta } };
}

// A page that looks like the real thing: a numbered section, the Japanese
// instruction line, its English translation, and the mark allocation.
const GRAMMAR_PAGE = `I. 動詞を選んで、正しい形にかえて、（　）に書いてください。
Fill in the ( ) with the correct verb in the appropriate form. (1×7)
(1) デパートで（　）まえに ATM でお金をおろします。`;

const KANJI_PAGE = `II-(1). a〜e のひらがなを漢字とひらがなで書いてください。(1×10)
| 漢字 | 読み方 |
| 地下鉄 | ちかてつ |`;

describe("paperIdentity", () => {
  it("reads the exam provenance a past-paper chunk carries", () => {
    const id = paperIdentity(
      paper("x", { topic: "T8", exam_term: "24秋", paper_title: "文法クイズ" }),
    );
    expect(id).toEqual({ topic: "T8", examTerm: "24秋", paperTitle: "文法クイズ" });
  });

  it("reports nothing for a chunk that carries nothing", () => {
    expect(paperIdentity({ content: "x", metadata: null })).toEqual({
      topic: null,
      examTerm: null,
      paperTitle: null,
    });
  });

  it("ignores a non-string the database happens to hold", () => {
    const id = paperIdentity({ content: "x", metadata: { topic: 8, exam_term: null } });
    expect(id.topic).toBeNull();
    expect(id.examTerm).toBeNull();
  });
});

describe("selectExemplars", () => {
  it("picks the paper matching the test being written", () => {
    const chunks = [
      paper(KANJI_PAGE, { paper_title: "漢字・語彙クイズ", topic: "T8" }),
      paper(GRAMMAR_PAGE, { paper_title: "文法クイズ", topic: "T8" }),
    ];
    const [first] = selectExemplars(chunks, "grammar", null, 1);
    expect(first.content).toBe(GRAMMAR_PAGE);

    const [firstKanji] = selectExemplars(chunks, "kanji", null, 1);
    expect(firstKanji.content).toBe(KANJI_PAGE);
  });

  it("prefers the paper for the topic the test is scoped to", () => {
    const chunks = [
      paper(GRAMMAR_PAGE, { paper_title: "文法クイズ", topic: "T6", exam_term: "24秋" }),
      paper(GRAMMAR_PAGE, { paper_title: "文法クイズ", topic: "T9", exam_term: "24秋" }),
    ];
    const [first] = selectExemplars(chunks, "grammar", 9, 1);
    expect(paperIdentity(first).topic).toBe("T9");
  });

  it("skips a page with no instruction line", () => {
    // A cover sheet or the overflow of a previous question shows the
    // generator nothing about the form it is imitating.
    const chunks = [
      paper("なまえ ＿＿＿＿＿\nクラス ＿＿＿", { paper_title: "文法クイズ" }),
      paper(GRAMMAR_PAGE, { paper_title: "文法クイズ" }),
    ];
    const [first] = selectExemplars(chunks, "grammar", null, 1);
    expect(first.content).toBe(GRAMMAR_PAGE);
  });

  it("spreads across sittings instead of taking one paper whole", () => {
    // Four pages of a single 文法クイズ teach one paper's habits; four pages
    // from three sittings teach the course's.
    const chunks = [
      paper(GRAMMAR_PAGE, { paper_title: "文法クイズ", topic: "T8", exam_term: "24秋" }),
      paper(GRAMMAR_PAGE, { paper_title: "文法クイズ", topic: "T8", exam_term: "24秋" }),
      paper(GRAMMAR_PAGE, { paper_title: "文法クイズ", topic: "T8", exam_term: "24秋" }),
      paper(GRAMMAR_PAGE, { paper_title: "文法クイズ", topic: "T9", exam_term: "24秋" }),
      paper(GRAMMAR_PAGE, { paper_title: "文法クイズ", topic: "T10", exam_term: "25春" }),
    ];
    const picked = selectExemplars(chunks, "grammar", null, 4);
    const terms = picked.map((c) => paperIdentity(c).topic);
    expect(picked).toHaveLength(4);
    expect(terms.filter((t) => t === "T8")).toHaveLength(2);
    expect(new Set(terms)).toEqual(new Set(["T8", "T9", "T10"]));
  });

  it("returns nothing when no paper is on the right subject", () => {
    // Better an empty style block than a kanji paper shown as the model for a
    // grammar test — the prompt then says nothing about exams at all.
    const chunks = [paper(KANJI_PAGE, { paper_title: "漢字・語彙クイズ" })];
    expect(selectExemplars(chunks, "grammar", null, 4)).toEqual([]);
  });

  it("returns nothing when no papers are indexed at all", () => {
    expect(selectExemplars([], "grammar", null, 4)).toEqual([]);
  });
});

describe("exemplarProvenance", () => {
  it("reports only what the retrieved pages actually printed", () => {
    // This is what the model is permitted to say about the exams. Anything
    // beyond it — a term, a date, "commonly tested" — would be invented.
    const provenance = exemplarProvenance([
      paper(GRAMMAR_PAGE, { exam_term: "24秋", paper_title: "文法クイズ", topic: "T8" }),
      paper(GRAMMAR_PAGE, { exam_term: "24秋", paper_title: "文法クイズ", topic: "T9" }),
      paper(GRAMMAR_PAGE, { exam_term: "25春", paper_title: "文法クイズ", topic: "T10" }),
    ]);
    expect(provenance.terms).toEqual(["24秋", "25春"]);
    expect(provenance.titles).toEqual(["文法クイズ"]);
    expect(provenance.topics).toEqual(["T8", "T9", "T10"]);
  });

  it("is empty when nothing was retrieved, so nothing may be claimed", () => {
    expect(exemplarProvenance([])).toEqual({ terms: [], titles: [], topics: [] });
  });

  it("omits a term no page printed", () => {
    const provenance = exemplarProvenance([paper(GRAMMAR_PAGE, { topic: "T8" })]);
    expect(provenance.terms).toEqual([]);
  });
});

// The real 24秋 Topic 8 文法クイズ, as transcribed into the corpus.
const REAL_PAPER = paper(
  `24秋 トピック8 文法クイズ
I. 動詞を選んで、正しい形にかえて、（　）に書いてください。(1×7)
(1) デパートで（　）まえに ATM でお金をおろします。
(2) 私はピアノを（　）ことができます。
(3) うちに しゅくだいを（　）にかえります。
かえします・見ます・のります・ひきます・とります・かい物します・あります`,
  { paper_title: "文法クイズ", topic: "T8", exam_term: "24秋" },
);

function item(overrides: Partial<QuizItem>): QuizItem {
  return {
    type: "multiple_choice",
    question: "",
    answer: "を",
    explanation: "x",
    review: "Topic 8 — ことができます (p. 119)",
    ...overrides,
  } as QuizItem;
}

function quizOf(...items: QuizItem[]): Quiz {
  return {
    scope_description: "x",
    sections: [{ instruction_ja: "あ", instruction_en: "a", items }],
  };
}

describe("dropCopiedItems", () => {
  it("drops the question that was lifted from the paper verbatim", () => {
    // Observed live on the first Topic 8 run through the UI: the generator
    // returned question 1 of the 24秋 paper word for word. A student sitting
    // that has been handed back the paper they already sat.
    const { quiz, removed } = dropCopiedItems(
      quizOf(item({ question: "デパートで（　）まえに ATM でお金をおろします。" })),
      [REAL_PAPER],
    );
    expect(removed).toBe(1);
    expect(quiz.sections).toEqual([]);
  });

  it("catches a copy whose blank has been moved or filled", () => {
    // The usual shape of a copy: the same sentence with the gap relocated,
    // the target word bracketed, or furigana added.
    for (const question of [
      "デパートで【買い物し】まえにATMでお金をおろします。",
      "デパートで（　）まえに ATM 《えーてぃーえむ》でお金をおろします",
      "私はピアノを（　）ことができます。",
    ]) {
      const { removed } = dropCopiedItems(quizOf(item({ question })), [REAL_PAPER]);
      expect(removed, question).toBe(1);
    }
  });

  it("catches the paper's own sentence with its blank filled in", () => {
    // Seen live on run 2 of the dev test: the generator returned
    // 「私はピアノを【ひく】ことができます。」 — question (2) of the 24秋 paper
    // with the answer written into the gap. The inserted word splits the
    // shared run, so this only fails if the skeleton is compared too.
    const { removed } = dropCopiedItems(
      quizOf(item({ question: "私はピアノを【ひく】ことができます。" })),
      [REAL_PAPER],
    );
    expect(removed).toBe(1);
  });

  it("checks the sentence field as well as the question", () => {
    const { removed } = dropCopiedItems(
      quizOf(item({ question: "正しい形にしてください", sentence: "私はピアノを（　）ことができます。" })),
      [REAL_PAPER],
    );
    expect(removed).toBe(1);
  });

  it("keeps a genuinely new sentence drilling the same grammar", () => {
    // This is the whole point: 〜ことができます may be tested, with a new
    // sentence about something else. A filter that dropped these would make
    // the past papers useless as a model.
    const { quiz, removed } = dropCopiedItems(
      quizOf(
        item({ question: "図書館でロシア語の本を（　）ことができます。" }),
        item({ question: "私は日本語で手紙を（　）ことができます。" }),
      ),
      [REAL_PAPER],
    );
    expect(removed).toBe(0);
    expect(quiz.sections[0].items).toHaveLength(2);
  });

  it("does not collide on the grammar pattern the whole paper is about", () => {
    // 「ことができます」 is 7 characters and legitimately appears in every
    // Topic 8 question. The run threshold has to sit above it.
    const { removed } = dropCopiedItems(
      quizOf(item({ question: "スキーをすることができます。" })),
      [REAL_PAPER],
    );
    expect(removed).toBe(0);
  });

  it("is a no-op when no past paper was retrieved", () => {
    const quiz = quizOf(item({ question: "デパートで（　）まえに ATM でお金をおろします。" }));
    expect(dropCopiedItems(quiz, [])).toEqual({ quiz, removed: 0 });
  });

  it("removes a section left empty, so the paper reports its real length", () => {
    // The route treats a short paper as a failed generation and hands the
    // request to the next provider — which is what makes a wholesale copy
    // repair itself rather than reaching the student.
    const { quiz } = dropCopiedItems(
      quizOf(item({ question: "うちに しゅくだいを（　）にかえります。" })),
      [REAL_PAPER],
    );
    expect(quiz.sections).toHaveLength(0);
  });
});
