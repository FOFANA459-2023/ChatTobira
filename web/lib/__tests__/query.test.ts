import { describe, expect, it } from "vitest";

import {
  grammarPatterns,
  isSmallTalk,
  resolveQuery,
  salientTerms,
  selectContext,
  tokensForQuery,
  type RetrievedChunk,
} from "@/lib/retrieval";

function turn(role: "user" | "assistant", text: string) {
  return { role, text };
}

describe("resolveQuery", () => {
  it("leaves a question that stands on its own alone", () => {
    const query = resolveQuery([turn("user", "What is the difference between に and で?")]);
    expect(query).toEqual({
      text: "What is the difference between に and で?",
      asked: "What is the difference between に and で?",
      isFollowUp: false,
      topics: [],
      // No page named, so nothing for the page arm to filter on.
      pageQuery: { pages: [], level: null, textbookOnly: false, sections: [] },
    });
  });

  // The case that made students ask three times: searched on its own, this
  // finds pages about tense in general, not about the pattern under discussion.
  it("folds the conversation into a follow-up so it is searchable", () => {
    const query = resolveQuery([
      turn("user", "How do I use 〜ておく?"),
      turn("assistant", "〜ておく means doing something in preparation. 準備 (junbi)…"),
      turn("user", "what about the past tense?"),
    ]);
    expect(query.isFollowUp).toBe(true);
    expect(query.text).toContain("How do I use 〜ておく?");
    expect(query.text).toContain("what about the past tense?");
    expect(query.asked).toBe("what about the past tense?");
  });

  it("resolves a bare pronoun against the previous turn", () => {
    const query = resolveQuery([
      turn("user", "Explain the て form of 急ぐ"),
      turn("assistant", "急いで is the て form…"),
      turn("user", "why is it like that?"),
    ]);
    expect(query.isFollowUp).toBe(true);
    expect(query.text).toContain("Explain the て form of 急ぐ");
  });

  it("carries the grammar point the last answer was about", () => {
    const query = resolveQuery([
      turn("user", "Explain this pattern"),
      turn("assistant", "〜たら is the conditional. 天気（てんき）がよかったら…"),
      turn("user", "give me another example"),
    ]);
    expect(query.text).toContain("〜たら");
  });

  it("treats a first message as standalone even when it is short", () => {
    const query = resolveQuery([turn("user", "て form?")]);
    expect(query.isFollowUp).toBe(false);
    expect(query.text).toBe("て form?");
  });

  it("does not fold in history for a new, self-contained question", () => {
    const query = resolveQuery([
      turn("user", "How do I use 〜ておく?"),
      turn("assistant", "〜ておく means doing something in preparation…"),
      turn("user", "Explain the difference between 自動詞 and 他動詞 with examples"),
    ]);
    expect(query.isFollowUp).toBe(false);
    expect(query.text).toBe("Explain the difference between 自動詞 and 他動詞 with examples");
  });

  it("has nothing to resolve for an empty conversation", () => {
    expect(resolveQuery([])).toEqual({
      text: "",
      asked: "",
      isFollowUp: false,
      topics: [],
      pageQuery: { pages: [], level: null, textbookOnly: false, sections: [] },
    });
  });
});

describe("salientTerms", () => {
  it("takes the grammar point first and drops the readings", () => {
    const terms = salientTerms("〜ておく is used for preparation. 準備（じゅんび）をしておく。");
    expect(terms[0]).toBe("〜ておく");
    expect(terms).toContain("準備");
    expect(terms.join(" ")).not.toContain("じゅんび");
  });

  it("returns nothing for an answer with no Japanese in it", () => {
    expect(salientTerms("That is correct, well done.")).toEqual([]);
  });
});

describe("isSmallTalk", () => {
  it("knows a greeting", () => {
    expect(isSmallTalk("hello")).toBe(true);
    expect(isSmallTalk("ありがとうございます")).toBe(true);
    expect(isSmallTalk("got it")).toBe(true);
  });

  // These are short, Latin, and real questions. The old length rule sent
  // every one of them to the model with no course material at all.
  it("does not mistake a short question for chit-chat", () => {
    expect(isSmallTalk("why?")).toBe(false);
    expect(isSmallTalk("how?")).toBe(false);
    expect(isSmallTalk("T6?")).toBe(false);
    expect(isSmallTalk("te-form")).toBe(false);
  });
});

describe("tokensForQuery", () => {
  it("drops English function words that match glosses at random", () => {
    const tokens = tokensForQuery("how do I use the て form?");
    expect(tokens).not.toContain("how");
    expect(tokens).not.toContain("do");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("use");
    expect(tokens).toContain("て");
  });

  it("keeps Japanese, content words and course shorthand", () => {
    const tokens = tokensForQuery("particles in T6");
    expect(tokens).toContain("particles");
    expect(tokens).toContain("T6");
  });

  it("still adds a short Japanese label verbatim", () => {
    expect(tokensForQuery("〜ておく")).toContain("〜ておく");
    expect(tokensForQuery("〜ておく")).toContain("ておく");
  });
});

function chunk(over: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunk_id: 1,
    document_id: 1,
    doc_title: "Foundation 3",
    doc_type: "textbook",
    is_citable: true,
    pdf_page: 10,
    book_page: "55",
    content: "…",
    metadata: {},
    score: 0.5,
    similarity: 0.8,
    ...over,
  };
}

describe("selectContext", () => {
  it("drops passages that are not about the question", () => {
    const picked = selectContext([
      chunk({ chunk_id: 1, similarity: 0.81 }),
      chunk({ chunk_id: 2, book_page: "56", similarity: 0.4 }),
    ]);
    expect(picked.map((c) => c.chunk_id)).toEqual([1]);
  });

  it("leads with the closest passage, whatever the fused rank said", () => {
    const picked = selectContext([
      chunk({ chunk_id: 1, book_page: "10", similarity: 0.62 }),
      chunk({ chunk_id: 2, book_page: "11", similarity: 0.88 }),
    ]);
    expect(picked.map((c) => c.chunk_id)).toEqual([2, 1]);
  });

  it("shows a page once", () => {
    const picked = selectContext([
      chunk({ chunk_id: 1, book_page: "55" }),
      chunk({ chunk_id: 2, book_page: "55" }),
      chunk({ chunk_id: 3, book_page: "56" }),
    ]);
    expect(picked).toHaveLength(2);
  });

  it("does not let one book take the whole prompt", () => {
    const picked = selectContext(
      Array.from({ length: 6 }, (_, i) =>
        chunk({ chunk_id: i, book_page: String(i), similarity: 0.9 - i / 100 }),
      ),
      { perDocument: 3 },
    );
    expect(picked).toHaveLength(3);
  });

  it("keeps the best two rather than starving the prompt", () => {
    // Nothing clears the floor: the model still gets something to look at,
    // and the prompt tells it to say the material does not cover this.
    const picked = selectContext([
      chunk({ chunk_id: 1, book_page: "1", similarity: 0.4 }),
      chunk({ chunk_id: 2, book_page: "2", similarity: 0.3 }),
      chunk({ chunk_id: 3, book_page: "3", similarity: 0.2 }),
    ]);
    expect(picked.map((c) => c.chunk_id)).toEqual([1, 2]);
  });

  it("has nothing to select from an empty retrieval", () => {
    expect(selectContext([])).toEqual([]);
  });
});

describe("grammarPatterns", () => {
  // The live failure this exists for: the capture ran past the pattern into
  // the sentence, and a literal search for "ておくの使い方は" found nothing —
  // so the answer told the student their textbook does not cover 〜ておく.
  it("stops where the sentence glues onto the pattern", () => {
    expect(grammarPatterns("日本語で説明してください。〜ておくの使い方は？")).toEqual([
      "ておく",
    ]);
  });

  it("finds both patterns in a comparison", () => {
    expect(grammarPatterns("Compare 〜ておく and 〜てある. When do I use each?")).toEqual([
      "ておく",
      "てある",
    ]);
  });

  it("keeps a pattern that is built from particles", () => {
    expect(grammarPatterns("〜ことにする って何ですか")).toEqual(["ことにする"]);
    expect(grammarPatterns("〜のに の使い方")).toEqual(["のに"]);
  });

  it("reads a quoted pattern", () => {
    expect(grammarPatterns("「てある」はどう使いますか")).toEqual(["てある"]);
  });

  it("finds nothing to look up in a plain English question", () => {
    expect(grammarPatterns("how do I make the te form?")).toEqual([]);
  });
});
