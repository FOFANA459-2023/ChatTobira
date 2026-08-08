import { describe, expect, it } from "vitest";

import {
  flattenItems,
  isCorrect,
  normalizeAnswer,
  scoreQuiz,
  type Quiz,
  type QuizItem,
} from "../quiz";

function item(answer: string): QuizItem {
  return {
    type: "fill_blank",
    question: "q",
    answer,
    explanation: "e",
  };
}

describe("normalizeAnswer", () => {
  it("ignores trailing punctuation", () => {
    expect(normalizeAnswer("食べます。")).toBe(normalizeAnswer("食べます"));
  });

  it("ignores full-width and half-width differences", () => {
    expect(normalizeAnswer("ＡＢＣ１２３")).toBe(normalizeAnswer("abc123"));
  });

  it("ignores all whitespace including full-width spaces", () => {
    expect(normalizeAnswer("食べ ます")).toBe(normalizeAnswer("食べ　ます"));
  });
});

describe("isCorrect", () => {
  it("accepts equivalent student input", () => {
    expect(isCorrect(item("読んでおきます"), " 読んでおきます。 ")).toBe(true);
  });

  it("rejects a genuinely different answer", () => {
    expect(isCorrect(item("読んでおきます"), "読んでいます")).toBe(false);
  });

  it("does not equate kana with kanji — that distinction is the drill", () => {
    expect(isCorrect(item("見える"), "みえる")).toBe(false);
  });
});

describe("scoreQuiz", () => {
  const paper: Quiz = {
    title: "文法もんだい",
    sections: [
      {
        instruction_ja: "適切なことばを選んでください。",
        instruction_en: "Choose the appropriate word.",
        items: [item("が"), item("を")],
      },
      {
        instruction_ja: "正しい形にしてください。",
        instruction_en: "Write the correct form.",
        items: [item("食べた")],
      },
    ],
  };

  it("numbers answers across sections in paper order", () => {
    expect(flattenItems(paper).map((i) => i.answer)).toEqual(["が", "を", "食べた"]);
  });

  it("scores across all sections", () => {
    expect(scoreQuiz(paper, { 0: "が", 1: "に", 2: "食べた" })).toEqual({
      correct: 2,
      total: 3,
    });
  });

  it("treats missing answers as wrong, not as errors", () => {
    expect(scoreQuiz(paper, {})).toEqual({ correct: 0, total: 3 });
  });
});
