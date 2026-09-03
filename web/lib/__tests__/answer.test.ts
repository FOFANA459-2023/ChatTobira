import { describe, expect, it } from "vitest";

import { parseAnswer, splitBold, splitHeading } from "@/lib/answer";

describe("parseAnswer", () => {
  it("reads a heading", () => {
    expect(parseAnswer("### 色 (Color)")).toEqual([
      { kind: "heading", level: 3, text: "色 (Color)" },
    ]);
  });

  it("turns a run of word: meaning bullets into the book's word list", () => {
    const blocks = parseAnswer("* 形（かたち）: shape\n* 三角（さんかく）: triangle");
    expect(blocks).toEqual([
      {
        kind: "terms",
        items: [
          { term: "形（かたち）", gloss: "shape" },
          { term: "三角（さんかく）", gloss: "triangle" },
        ],
      },
    ]);
  });

  it("accepts the full-width colon a Japanese IME produces, spaced or not", () => {
    expect(parseAnswer("- 紙（かみ）： paper\n- 布（ぬの）： cloth")[0]).toMatchObject({
      kind: "terms",
    });
    expect(parseAnswer("- 紙（かみ）：paper\n- 布（ぬの）：cloth")[0]).toEqual({
      kind: "terms",
      items: [
        { term: "紙（かみ）", gloss: "paper" },
        { term: "布（ぬの）", gloss: "cloth" },
      ],
    });
  });

  it("keeps prose bullets as a list rather than forcing them into columns", () => {
    const blocks = parseAnswer(
      "- Use ～ておく when you prepare something in advance.\n- 三角（さんかく）: triangle",
    );
    expect(blocks).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [
          "Use ～ておく when you prepare something in advance.",
          "三角（さんかく）: triangle",
        ],
      },
    ]);
  });

  it("does not read a sentence with a colon in it as a word", () => {
    // The term is far past a word's length, so this is prose.
    const blocks = parseAnswer(
      "- Remember this rule about the particle に: it marks the destination.\n" +
        "- And this one about で: it marks the location of an action.",
    );
    expect(blocks[0].kind).toBe("list");
  });

  it("keeps a single definition as a list — one row is not a table", () => {
    expect(parseAnswer("- 形（かたち）: shape")).toEqual([
      { kind: "list", ordered: false, items: ["形（かたち）: shape"] },
    ]);
  });

  it("reads a numbered list", () => {
    expect(parseAnswer("1. まず\n2. つぎに")).toEqual([
      { kind: "list", ordered: true, items: ["まず", "つぎに"] },
    ]);
  });

  it("joins a wrapped continuation line onto its item", () => {
    const blocks = parseAnswer("- 急ぐ means to hurry,\n  and it is a う-verb.");
    expect(blocks).toEqual([
      {
        kind: "list",
        ordered: false,
        items: ["急ぐ means to hurry, and it is a う-verb."],
      },
    ]);
  });

  it("reads a table", () => {
    const blocks = parseAnswer(
      "| 形 | 意味 |\n| --- | --- |\n| 食べる | to eat |\n| 飲む | to drink |",
    );
    expect(blocks).toEqual([
      {
        kind: "table",
        head: ["形", "意味"],
        rows: [
          ["食べる", "to eat"],
          ["飲む", "to drink"],
        ],
      },
    ]);
  });

  it("needs the delimiter row before it calls something a table", () => {
    const blocks = parseAnswer("The pattern is A | B, either one works.");
    expect(blocks[0].kind).toBe("paragraph");
  });

  it("keeps example sentences on their own lines inside a paragraph", () => {
    const blocks = parseAnswer("きょうは いそがしいです。\nI am busy today.");
    expect(blocks).toEqual([
      { kind: "paragraph", text: "きょうは いそがしいです。\nI am busy today." },
    ]);
  });

  it("strips blockquote and fence scaffolding but keeps the text", () => {
    expect(parseAnswer("> 教科書のp.55を見てください。")).toEqual([
      { kind: "paragraph", text: "教科書のp.55を見てください。" },
    ]);
    expect(parseAnswer("```\n食べる → 食べます\n```")).toEqual([
      { kind: "paragraph", text: "食べる → 食べます" },
    ]);
  });

  it("reads a rule, and does not mistake a table divider for one", () => {
    expect(parseAnswer("---")).toEqual([{ kind: "rule" }]);
    const table = parseAnswer("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(table).toHaveLength(1);
    expect(table[0].kind).toBe("table");
  });

  it("lays out a whole answer in book order", () => {
    const blocks = parseAnswer(
      [
        "トピック 14 の新しい語彙です。",
        "",
        "## 形 (Shape)",
        "",
        "- 三角（さんかく）: triangle",
        "- 四角（しかく）: square",
        "",
        "## 動詞 (Verbs)",
        "",
        "- 急ぐ（いそぐ）: to hurry",
        "- 泣く（なく）: to cry",
        "",
        "教科書のp.55〜57を見てください。",
      ].join("\n"),
    );
    expect(blocks.map((b) => b.kind)).toEqual([
      "paragraph",
      "heading",
      "terms",
      "heading",
      "terms",
      "paragraph",
    ]);
  });

  // Every frame of a streamed answer is partial input; none of them may throw
  // or drop the text that has arrived.
  it("renders every prefix of a streaming answer", () => {
    const answer = "## 色 (Color)\n\n- き色（きいろ）: yellow\n\n| a | b |\n| --- | --- |\n| 1 | 2 |";
    for (let i = 1; i <= answer.length; i++) {
      expect(() => parseAnswer(answer.slice(0, i))).not.toThrow();
    }
    expect(parseAnswer("## 色 (Col")).toEqual([
      { kind: "heading", level: 2, text: "## 色 (Col".replace("## ", "") },
    ]);
    expect(parseAnswer("| 形 | 意味 |\n| --- | --- |")).toEqual([
      { kind: "table", head: ["形", "意味"], rows: [] },
    ]);
  });

  it("has nothing to render for empty or blank input", () => {
    expect(parseAnswer("")).toEqual([]);
    expect(parseAnswer("\n\n   \n")).toEqual([]);
  });
});

describe("splitBold", () => {
  it("splits a completed pair", () => {
    expect(splitBold("使い方は**〜ておく**です")).toEqual([
      { text: "使い方は", bold: false },
      { text: "〜ておく", bold: true },
      { text: "です", bold: false },
    ]);
  });

  it("leaves a half-streamed marker as the characters it currently is", () => {
    expect(splitBold("使い方は**〜てお")).toEqual([
      { text: "使い方は**〜てお", bold: false },
    ]);
  });
});

describe("splitHeading", () => {
  it("separates the Japanese label from its English gloss", () => {
    expect(splitHeading("形 (Shape)")).toEqual({ label: "形", gloss: "Shape" });
    expect(splitHeading("動詞（Verbs）")).toEqual({ label: "動詞", gloss: "Verbs" });
  });

  it("leaves furigana attached — 語彙（ごい） is one word, not a translation", () => {
    expect(splitHeading("語彙（ごい）")).toEqual({ label: "語彙（ごい）" });
  });

  it("passes a heading with no gloss through", () => {
    expect(splitHeading("新しい語彙")).toEqual({ label: "新しい語彙" });
  });
});

describe("parseAnswer — hard-wrapped prose", () => {
  it("rejoins an English sentence the model wrapped mid-way", () => {
    const blocks = parseAnswer(
      "You handled the pattern well — that is the\npoint this topic is built around.",
    );
    expect(blocks).toEqual([
      {
        kind: "paragraph",
        text: "You handled the pattern well — that is the point this topic is built around.",
      },
    ]);
  });

  it("keeps the break after a finished sentence", () => {
    const blocks = parseAnswer("Read p. 56 again.\nThen write out five verbs.");
    expect(blocks[0]).toEqual({
      kind: "paragraph",
      text: "Read p. 56 again.\nThen write out five verbs.",
    });
  });

  it("never rejoins Japanese lines — a two-line table is not a wrap", () => {
    const blocks = parseAnswer("食べる → 食べます\n飲む → 飲みます");
    expect(blocks[0]).toEqual({
      kind: "paragraph",
      text: "食べる → 食べます\n飲む → 飲みます",
    });
  });

  it("keeps an example sentence and its translation on separate lines", () => {
    const blocks = parseAnswer("きょうは いそがしいです。\nI am busy today.");
    expect(blocks[0]).toEqual({
      kind: "paragraph",
      text: "きょうは いそがしいです。\nI am busy today.",
    });
  });
});
