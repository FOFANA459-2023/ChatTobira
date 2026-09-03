import { describe, expect, it } from "vitest";

import { dedupeQuiz, flattenItems, itemSignatures, type Quiz, type QuizItem } from "../quiz";

function item(over: Partial<QuizItem> = {}): QuizItem {
  return {
    type: "multiple_choice",
    question: "きのう すしを【食べる】。",
    choices: ["食べた", "食べる", "食べます", "食べて"],
    answer: "食べた",
    explanation: "past tense",
    review: "Topic 3 — plain past (p. 40)",
    ...over,
  };
}

function paper(...sections: QuizItem[][]): Quiz {
  return {
    scope_description: "Topic 3",
    sections: sections.map((items) => ({
      instruction_ja: "えらんでください。",
      instruction_en: "Choose.",
      items,
    })),
  };
}

describe("dedupeQuiz", () => {
  it("keeps a paper whose questions are all different", () => {
    const original = paper([
      item(),
      item({ question: "まいあさ コーヒーを【飲む】。", answer: "飲みます" }),
    ]);
    const { quiz, removed } = dedupeQuiz(original, "grammar");
    expect(removed).toBe(0);
    expect(flattenItems(quiz)).toHaveLength(2);
  });

  it("drops a second question that drills the same marked word", () => {
    const { quiz, removed } = dedupeQuiz(
      paper([
        item(),
        // Same word, reworded sentence — the repeat the prompt alone misses.
        item({ question: "いま ごはんを【食べる】。", answer: "食べています" }),
      ]),
      "grammar",
    );
    expect(removed).toBe(1);
    expect(flattenItems(quiz)).toHaveLength(1);
    expect(flattenItems(quiz)[0].answer).toBe("食べた");
  });

  it("drops a repeat across sections, not just inside one", () => {
    const { quiz, removed } = dedupeQuiz(paper([item()], [item()]), "grammar");
    expect(removed).toBe(1);
    expect(quiz.sections).toHaveLength(1);
  });

  it("removes a section left with nothing in it", () => {
    const { quiz } = dedupeQuiz(paper([item()], [item()]), "grammar");
    expect(quiz.sections).toHaveLength(1);
    expect(quiz.sections[0].items).toHaveLength(1);
  });

  it("treats a question as the same when only the underline moved", () => {
    const { removed } = dedupeQuiz(
      paper([
        item({ question: "きのう すしを【食べる】。" }),
        item({ question: "きのう すしを 食べる。", answer: "食べました" }),
      ]),
      "grammar",
    );
    expect(removed).toBe(1);
  });

  it("treats furigana and full-width spacing as the same question", () => {
    const { removed } = dedupeQuiz(
      paper([
        item({ question: "毎日（まいにち）　学校（がっこう）へ行く。" }),
        item({ question: "毎日 学校へ行く。", answer: "行きます" }),
      ]),
      "grammar",
    );
    expect(removed).toBe(1);
  });

  it("catches a repeat that reuses the sentence under a different question", () => {
    const { removed } = dedupeQuiz(
      paper([
        item({ question: "正しい形は？", sentence: "きのう 京都へ行きました。" }),
        item({ question: "どのことばが入りますか。", sentence: "きのう 京都へ行きました。" }),
      ]),
      "grammar",
    );
    expect(removed).toBe(1);
  });

  // On a kanji paper the reading and the spelling of one word are the same
  // word tested twice, which is exactly what the paper's own rules forbid.
  it("tests a word once per kanji paper, in either script", () => {
    const { removed } = dedupeQuiz(
      paper([
        item({ question: "この本は【短い】です。", answer: "みじかい" }),
        item({ question: "この本は【みじかい】です。", answer: "短い" }),
      ]),
      "kanji",
    );
    expect(removed).toBe(1);
  });

  it("lets a grammar paper answer に more than once", () => {
    // Different points, same particle — legitimate, and the reason answers
    // are not part of a grammar paper's identity.
    const { removed } = dedupeQuiz(
      paper([
        item({ question: "七時（　）おきます。", answer: "に" }),
        item({ question: "教室（　）います。", answer: "に" }),
      ]),
      "grammar",
    );
    expect(removed).toBe(0);
  });

  it("keeps the five ○× statements about one passage", () => {
    const statements = ["朝ごはんを食べた。", "電車で行った。", "雨だった。"].map((question) =>
      item({ type: "true_false", question, choices: undefined, answer: "○" }),
    );
    const { removed, quiz } = dedupeQuiz(paper(statements), "grammar");
    expect(removed).toBe(0);
    expect(flattenItems(quiz)).toHaveLength(3);
  });

  it("still drops an identical ○× statement", () => {
    const statement = item({
      type: "true_false",
      question: "朝ごはんを食べた。",
      choices: undefined,
      answer: "○",
    });
    const { removed } = dedupeQuiz(paper([statement, { ...statement, answer: "×" }]), "grammar");
    expect(removed).toBe(1);
  });

  it("leaves the rest of the paper untouched", () => {
    const original = paper([item()]);
    const { quiz } = dedupeQuiz(original, "grammar");
    expect(quiz.scope_description).toBe(original.scope_description);
    expect(quiz.sections[0].instruction_ja).toBe(original.sections[0].instruction_ja);
    // The input paper is not mutated — the caller may still log it.
    expect(original.sections[0].items).toHaveLength(1);
  });
});

describe("itemSignatures", () => {
  it("names the marked word, the wording, and the sentence", () => {
    expect(
      itemSignatures(item({ sentence: "きょうは いい 天気（てんき）です。" }), "grammar"),
    ).toEqual([
      "target:食べる",
      "asked:きのうすしを食べる",
      "sentence:きょうはいい天気です",
    ]);
  });

  it("adds the answer in both scripts on a kanji paper", () => {
    const signatures = itemSignatures(
      item({ question: "【短い】", answer: "短い", answer_kana: "みじかい" }),
      "kanji",
    );
    expect(signatures).toContain("word:短い");
    expect(signatures).toContain("word:みじかい");
  });
});
