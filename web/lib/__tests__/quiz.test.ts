import { describe, expect, it } from "vitest";

import {
  flattenItems,
  focusTokens,
  isCorrect,
  normalizeAnswer,
  rankChunksByFocus,
  romajiToHiragana,
  scoreQuiz,
  splitUnderline,
  studyPlan,
  type Quiz,
  type QuizItem,
} from "../quiz";

function item(answer: string, answer_kana?: string, review = "Topic 1"): QuizItem {
  return {
    type: "fill_blank",
    question: "q",
    answer,
    answer_kana,
    explanation: "e",
    review,
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

  it("accepts romaji typed on an English keyboard", () => {
    expect(isCorrect(item("食べました", "たべました"), "tabemashita")).toBe(true);
    expect(isCorrect(item("で"), "de")).toBe(true);
    expect(isCorrect(item("読んでおきます", "よんでおきます"), "yondeokimasu")).toBe(
      true,
    );
  });

  it("rejects romaji for the wrong word", () => {
    expect(isCorrect(item("見える", "みえる"), "kikoeru")).toBe(false);
  });
});

describe("romajiToHiragana", () => {
  it("converts plain syllables", () => {
    expect(romajiToHiragana("tabemasu")).toBe("たべます");
    expect(romajiToHiragana("neko")).toBe("ねこ");
  });

  it("accepts Hepburn and kunrei spellings alike", () => {
    // IMEs train students on both: shi/si, chi/ti, tsu/tu, fu/hu, ji/zi.
    expect(romajiToHiragana("shashin")).toBe("しゃしん");
    expect(romajiToHiragana("syasin")).toBe("しゃしん");
    expect(romajiToHiragana("tsukue")).toBe("つくえ");
    expect(romajiToHiragana("tukue")).toBe("つくえ");
  });

  it("handles ん in all its spellings", () => {
    expect(romajiToHiragana("nihon")).toBe("にほん");
    // Mid-word nn is Hepburn's ん + syllable n…
    expect(romajiToHiragana("konnichiwa")).toBe("こんにちわ");
    expect(romajiToHiragana("onna")).toBe("おんな");
    // …while a trailing nn is the IME habit for final ん.
    expect(romajiToHiragana("tabemasenn")).toBe("たべません");
    expect(romajiToHiragana("gen'in")).toBe("げんいん");
    // Hepburn writes ん as m before b/m/p.
    expect(romajiToHiragana("shimbun")).toBe("しんぶん");
    expect(romajiToHiragana("shinbun")).toBe("しんぶん");
  });

  it("handles small っ from doubled consonants", () => {
    expect(romajiToHiragana("kitte")).toBe("きって");
    expect(romajiToHiragana("matcha")).toBe("まっちゃ");
    expect(romajiToHiragana("itta")).toBe("いった");
  });

  it("ignores spaces and hyphens", () => {
    expect(romajiToHiragana("tabe masu")).toBe("たべます");
  });

  it("returns null for text it cannot fully convert", () => {
    // Grading falls back to the raw comparison — null must never mean wrong.
    expect(romajiToHiragana("xyzq")).toBeNull();
    expect(romajiToHiragana("たべます")).toBeNull();
    expect(romajiToHiragana("")).toBeNull();
  });
});

describe("splitUnderline", () => {
  it("marks 【 】 segments for underlining and drops the brackets", () => {
    expect(splitUnderline("きのう、すしを【食べる】。")).toEqual([
      { text: "きのう、すしを", underline: false },
      { text: "食べる", underline: true },
      { text: "。", underline: false },
    ]);
  });

  it("passes unmarked text through untouched", () => {
    expect(splitUnderline("毎日、勉強します。")).toEqual([
      { text: "毎日、勉強します。", underline: false },
    ]);
  });

  it("handles multiple marked words", () => {
    const segments = splitUnderline("【外国】から来た【学生】です。");
    expect(segments.filter((s) => s.underline).map((s) => s.text)).toEqual([
      "外国",
      "学生",
    ]);
  });
});

describe("studyPlan", () => {
  const paper: Quiz = {
    scope_description: "s",
    sections: [
      {
        instruction_ja: "j",
        instruction_en: "e",
        items: [
          item("が", undefined, "Topic 3 — particles (p. 33)"),
          item("を", undefined, "Topic 3 — particles (p. 33)"),
          item("食べた", "たべた", "Topic 6 — past tense (p. 76)"),
        ],
      },
    ],
  };

  it("groups misses by review reference, most missed first", () => {
    // Both particle questions wrong, past tense right.
    expect(studyPlan(paper, { 0: "に", 1: "で", 2: "食べた" })).toEqual([
      { review: "Topic 3 — particles (p. 33)", questions: [1, 2] },
    ]);
  });

  it("orders multiple weak areas by miss count", () => {
    const plan = studyPlan(paper, { 0: "に", 1: "で", 2: "wrong" });
    expect(plan.map((p) => p.review)).toEqual([
      "Topic 3 — particles (p. 33)",
      "Topic 6 — past tense (p. 76)",
    ]);
    expect(plan[1].questions).toEqual([3]);
  });

  it("returns an empty plan for a perfect paper", () => {
    expect(studyPlan(paper, { 0: "が", 1: "を", 2: "たべた" })).toEqual([]);
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
