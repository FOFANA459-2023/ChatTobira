import { describe, expect, it } from "vitest";

import {
  chunksForLesson,
  flattenItems,
  focusTokens,
  isCorrect,
  lessonByPage,
  normalizeAnswer,
  rankChunksByFocus,
  romajiToHiragana,
  scoreQuiz,
  splitRuby,
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

  it("grades ○× statements across Unicode spellings of the marks", () => {
    const statement: QuizItem = {
      type: "true_false",
      question: "リサさんは まいにち としょかんへ 行きます。",
      answer: "○",
      explanation: "e",
      review: "Topic 4 — daily routines (p. 45)",
    };
    expect(isCorrect(statement, "○")).toBe(true);
    // The model sometimes answers with the large circle or a different cross.
    expect(isCorrect({ ...statement, answer: "◯" }, "○")).toBe(true);
    expect(isCorrect({ ...statement, answer: "×" }, "✕")).toBe(true);
    expect(isCorrect(statement, "×")).toBe(false);
    expect(isCorrect(statement, "")).toBe(false);
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

describe("lessonByPage", () => {
  const page = (pdf_page: number, content: string) => ({ pdf_page, content });

  it("maps pages to lessons from running 第N課 headers, full-width digits included", () => {
    const lessons = lessonByPage([
      page(30, "はじめに"),
      page(37, "第１課 わたしのこと。本文…"),
      page(38, "練習問題"),
      page(42, "第2課 まいにちの生活。"),
      page(43, "会話練習"),
    ]);
    expect(lessons.get(30)).toBe(0); // front matter
    expect(lessons.get(37)).toBe(1);
    expect(lessons.get(38)).toBe(1); // carried forward between headers
    expect(lessons.get(42)).toBe(2);
    expect(lessons.get(43)).toBe(2);
  });

  it("ignores contents pages that list every lesson at once", () => {
    const lessons = lessonByPage([
      page(5, "目次 第1課… 第2課… 第3課… 第4課… 第5課…"),
      page(33, "第1課 スタート"),
    ]);
    expect(lessons.get(5)).toBe(0);
    expect(lessons.get(33)).toBe(1);
  });

  it("ignores appendix cross-references to earlier lessons", () => {
    // Seen in the real book: answer pages around p.152 cite 第３課 long after
    // Lesson 6 started. The lesson number only steps forward.
    const lessons = lessonByPage([
      page(33, "第1課"),
      page(39, "第2課"),
      page(63, "第3課"),
      page(93, "第4課"),
      page(111, "第5課"),
      page(143, "第6課 ほんぶん"),
      page(152, "解答 第3課の答え"),
      page(167, "第7課 ほんぶん"),
    ]);
    expect(lessons.get(152)).toBe(6);
    expect(lessons.get(167)).toBe(7);
  });

  it("tolerates one skipped header but not a wild jump", () => {
    const lessons = lessonByPage([
      page(10, "第1課 スタート"),
      page(20, "第3課 ほんぶん"), // 2's header page was blank-skipped: allowed
      page(30, "第9課 これは目次の残骸"), // +6: not believable, ignored
    ]);
    expect(lessons.get(20)).toBe(3);
    expect(lessons.get(30)).toBe(3);
  });

  it("maps the Foundation book's 'Topic N' running headers", () => {
    // The Foundation 1 & 2 volume prints an English "Topic N" header on
    // nearly every content page; the contents pages list every topic at once
    // and the index glues the word to the number ("Topic1 Topic2 …").
    const lessons = lessonByPage([
      page(7, "Contents … Topic 1 … Topic 2 … Topic 3 … Topic 4 … Topic 5"),
      page(19, "Topic 1 はじめまして"),
      page(25, "れんしゅう"), // carried forward between headers
      page(33, "Topic 2 かいもの"),
      page(51, "Topic 3 今何時ですか"),
      page(193, "Index: Topic1 Topic2 Topic3 Topic4 Topic5"), // multi: ignored
    ]);
    expect(lessons.get(7)).toBe(0); // contents page is front matter
    expect(lessons.get(19)).toBe(1);
    expect(lessons.get(25)).toBe(1);
    expect(lessons.get(33)).toBe(2);
    expect(lessons.get(51)).toBe(3);
    expect(lessons.get(193)).toBe(3); // index keeps the last real division
  });

  it("reads a glued TopicN header when it is the page's only marker", () => {
    const lessons = lessonByPage([
      page(19, "Topic 1 はじめまして"),
      page(30, "Topic2 かいもの"),
    ]);
    expect(lessons.get(30)).toBe(2);
  });

  it("accepts a numbering restart when the following pages confirm it", () => {
    // The Foundation 1 & 2 book runs Topics 1–10 twice: main text, then the
    // kanji/vocabulary section starts over at Topic 1. Both passes of a topic
    // must map to the same number.
    const lessons = lessonByPage([
      page(19, "Topic 1"),
      page(51, "Topic 3"),
      page(78, "Topic 5"),
      page(112, "Topic 7"),
      page(146, "Topic 9"),
      page(164, "Topic 10 りょこう"),
      page(183, "Topic 10 まとめ"),
      page(195, "Topic 1 かんじ"),
      page(196, "Topic 1 れんしゅう"),
      page(201, "Topic 2 かんじ"),
      page(208, "Topic 3 かんじ"),
    ]);
    expect(lessons.get(183)).toBe(10);
    expect(lessons.get(195)).toBe(1);
    expect(lessons.get(201)).toBe(2);
    expect(lessons.get(208)).toBe(3);
  });

  it("still ignores a lone low cross-reference with no follow-through", () => {
    // An answer page citing Topic 1 late in the book is noise, not a restart:
    // nothing after it continues the sequence.
    const lessons = lessonByPage([
      page(19, "Topic 1"),
      page(51, "Topic 3"),
      page(78, "Topic 5"),
      page(112, "Topic 7"),
      page(146, "Topic 9"),
      page(164, "Topic 10 りょこう"),
      page(189, "Topic 1 の答え"),
      page(200, "ふろく"),
    ]);
    expect(lessons.get(189)).toBe(10);
    expect(lessons.get(200)).toBe(10);
  });

  it("keeps a cross-reference as noise when later marks fit the old sequence", () => {
    // Seen in Tobira Intermediate: p.53 cites 第1課 in passing, and the next
    // header (第3課, p.63) continues the original walk — so no restart.
    const lessons = lessonByPage([
      page(17, "第1課"),
      page(39, "第2課"),
      page(53, "第1課で勉強したこと"),
      page(63, "第3課"),
      page(93, "第4課"),
    ]);
    expect(lessons.get(53)).toBe(2);
    expect(lessons.get(63)).toBe(3);
  });
});

describe("chunksForLesson", () => {
  const chunk = (pdf_page: number) => ({ pdf_page });
  const lessons = new Map([
    [1, 0],
    [10, 1],
    [11, 1],
    [20, 2],
    [21, 2],
    [30, 3],
  ]);
  const chunks = [chunk(1), chunk(10), chunk(11), chunk(20), chunk(21), chunk(30)];

  it("draws only from the scoped lesson when it can fill the sample", () => {
    const picked = chunksForLesson(chunks, lessons, 2, 2);
    expect(picked.map((c) => lessons.get(c.pdf_page))).toEqual([2, 2]);
  });

  it("pads a thin lesson from earlier lessons only — never later, never front matter", () => {
    const picked = chunksForLesson(chunks, lessons, 2, 5);
    const drawn = picked.map((c) => lessons.get(c.pdf_page));
    expect(drawn.filter((l) => l === 2)).toHaveLength(2);
    expect(drawn).not.toContain(3); // untaught material never appears
    expect(drawn).not.toContain(0); // front matter never appears
    expect(drawn.filter((l) => l === 1)).toHaveLength(2);
  });

  it("returns empty when the mapping has nothing for that lesson, so the caller can fall back", () => {
    expect(chunksForLesson(chunks, lessons, 9, 5)).toEqual([]);
  });
});

describe("splitRuby", () => {
  it("pairs kanji with the kana reading that follows in full-width parens", () => {
    expect(splitRuby("大学（だいがく）へ行きます")).toEqual([
      { base: "大学", reading: "だいがく" },
      { base: "へ行きます" },
    ]);
  });

  it("leaves the （　） answer blank and other parens untouched", () => {
    // A reading annotation is kanji + kana parens ONLY; the multiple-choice
    // blank and parenthesised kanji are content.
    expect(splitRuby("部屋（　）勉強します")).toEqual([
      { base: "部屋（　）勉強します" },
    ]);
    expect(splitRuby("食べます（食べる）")).toEqual([{ base: "食べます（食べる）" }]);
  });

  it("handles several annotated words in one sentence", () => {
    const segments = splitRuby("卒業（そつぎょう）して就職（しゅうしょく）する");
    expect(segments.filter((s) => s.reading)).toEqual([
      { base: "卒業", reading: "そつぎょう" },
      { base: "就職", reading: "しゅうしょく" },
    ]);
  });

  it("passes plain text through as one segment", () => {
    expect(splitRuby("まいにち べんきょうします")).toEqual([
      { base: "まいにち べんきょうします" },
    ]);
  });

  it("reads the transcription corpus's 《 》 style too", () => {
    // The prompt asks for （ ）, but the excerpts write 漢字《かんじ》 and
    // models imitate what they read — both must render as ruby.
    expect(splitRuby("将来《しょうらい》の進路")).toEqual([
      { base: "将来", reading: "しょうらい" },
      { base: "の進路" },
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

  it("normalises the Intermediate books' Lesson naming to the same marker", () => {
    // Foundation prints "Topic N", Intermediate prints "Lesson N"; the chunk
    // metadata uses one t-marker for both.
    expect(focusTokens("Lesson 5")).toEqual(["t5"]);
    expect(focusTokens("L7")).toEqual(["t7"]);
    expect(focusTokens("lesson 12、〜ておく")).toEqual(["t12", "ておく"]);
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
