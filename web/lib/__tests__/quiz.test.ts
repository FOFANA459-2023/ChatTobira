import { describe, expect, it } from "vitest";

import {
  flattenItems,
  focusTokens,
  isCorrect,
  normalizeAnswer,
  rankChunksByFocus,
  scoreQuiz,
  type Quiz,
  type QuizItem,
} from "../quiz";

function item(answer: string, answer_kana?: string): QuizItem {
  return {
    type: "fill_blank",
    question: "q",
    answer,
    answer_kana,
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

  it("accepts the hiragana reading when the generator provides it", () => {
    expect(isCorrect(item("見える", "みえる"), "みえる")).toBe(true);
    expect(isCorrect(item("食べました", "たべました"), "たべました")).toBe(true);
  });

  it("accepts kanji with furigana attached, in either bracket style", () => {
    const target = item("食べました", "たべました");
    expect(isCorrect(target, "食べました（たべました）")).toBe(true);
    expect(isCorrect(target, "食べました(たべました)")).toBe(true);
    expect(isCorrect(target, "食《た》べました")).toBe(true);
  });

  it("still rejects a wrong reading even with answer_kana present", () => {
    expect(isCorrect(item("見える", "みえる"), "きこえる")).toBe(false);
  });

  it("requires the exact form when no reading was provided", () => {
    expect(isCorrect(item("見える"), "みえる")).toBe(false);
  });
});

describe("scoreQuiz", () => {
  const paper: Quiz = {
    scope_description: "Particles and past-tense forms from Topic 6.",
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

describe("focusTokens", () => {
  it("normalises topic markers in either spelling", () => {
    expect(focusTokens("Topic 13")).toEqual(["t13"]);
    expect(focusTokens("T7")).toEqual(["t7"]);
  });

  it("strips the tilde from grammar-pattern labels", () => {
    expect(focusTokens("〜ておく")).toEqual(["ておく"]);
  });

  it("drops bare digits that would match page numbers", () => {
    expect(focusTokens("13")).toEqual([]);
  });

  it("splits mixed focus text into topic and content tokens", () => {
    expect(focusTokens("Topic 13、〜ところ te-form")).toEqual([
      "t13",
      "ところ",
      "te-form",
    ]);
  });
});

describe("rankChunksByFocus", () => {
  const chunks = [
    { content: "〜ておく：前もって何かをする。", metadata: { topic: "T14" } },
    { content: "〜ところ：ちょうど今。", metadata: { topic: "T13" } },
    { content: "た形の練習。", metadata: null },
  ];

  it("puts chunks that mention the focus first", () => {
    const picked = rankChunksByFocus(chunks, "〜ておく", 1);
    expect(picked[0].content).toContain("ておく");
  });

  it("matches topic markers against chunk metadata", () => {
    const picked = rankChunksByFocus(chunks, "Topic 13", 1);
    expect(picked[0].metadata?.topic).toBe("T13");
  });

  it("falls back to the whole book when nothing matches", () => {
    expect(rankChunksByFocus(chunks, "存在しない文法", 2)).toHaveLength(2);
  });

  it("pads a narrow focus with other material to fill the sample", () => {
    expect(rankChunksByFocus(chunks, "〜ておく", 3)).toHaveLength(3);
  });
});
