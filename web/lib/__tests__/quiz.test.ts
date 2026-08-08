import { describe, expect, it } from "vitest";

import { isCorrect, normalizeAnswer, type QuizItem } from "../quiz";

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
