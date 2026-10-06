import { describe, expect, it } from "vitest";

import {
  buildCitations,
  isSmallTalk,
  retrieveByTopic,
  tokensForQuery,
  type RetrievedChunk,
  selectContext,
} from "../retrieval";
import { clearPoolCache } from "@/lib/corpus-cache";
import { aspectOf, divisionPattern, topicRefs } from "@/lib/topics";

function chunk(overrides: Partial<RetrievedChunk>): RetrievedChunk {
  return {
    chunk_id: 1,
    document_id: 1,
    doc_title: "Tobira Intermediate Japanese",
    doc_type: "textbook",
    is_citable: true,
    pdf_page: 10,
    book_page: "4",
    content: "文法の説明です。",
    metadata: {},
    score: 0.5,
    similarity: 0.8,
    ...overrides,
  };
}

describe("tokensForQuery", () => {
  it("segments Japanese text", () => {
    const tokens = tokensForQuery("窓から海が見える");
    expect(tokens.length).toBeGreaterThan(1);
    expect(tokens.join("")).toContain("見える");
  });

  it("keeps short grammar-point queries verbatim for exact index hits", () => {
    expect(tokensForQuery("たいです")).toContain("たいです");
    const tokens = tokensForQuery("～ておく");
    expect(tokens).toContain("～ておく");
    expect(tokens).toContain("ておく");
  });

  it("returns empty for empty input", () => {
    expect(tokensForQuery("   ")).toEqual([]);
  });
});

describe("isSmallTalk", () => {
  it("greetings and thanks are small talk in both languages", () => {
    for (const text of ["hello", "Hi!", "thanks", "こんにちは", "ありがとうございます", "おはよう"]) {
      expect(isSmallTalk(text), text).toBe(true);
    }
  });

  it("real questions are not small talk", () => {
    for (const text of [
      "「〜がち」はどういう意味ですか",
      "how do I use ておく?",
      "たい", // short but Japanese — could be a grammar point
    ]) {
      expect(isSmallTalk(text), text).toBe(false);
    }
  });
});

describe("buildCitations", () => {
  it("drops chunks below the similarity floor — 'hello' cites nothing", () => {
    // Live measurements: on-topic ~0.78, small talk ~0.59.
    expect(buildCitations([chunk({ similarity: 0.59 })])).toEqual([]);
    expect(buildCitations([chunk({ similarity: 0.78 })])).toHaveLength(1);
  });

  it("never cites a class handout, even a top-scoring one", () => {
    const citations = buildCitations([
      chunk({ is_citable: false, doc_title: "T12 answer key", score: 0.99 }),
      chunk({ is_citable: true, score: 0.1 }),
    ]);
    expect(citations).toHaveLength(1);
    expect(citations[0].title).toBe("Tobira Intermediate Japanese");
  });

  it("returns empty when only handouts matched", () => {
    expect(buildCitations([chunk({ is_citable: false })])).toEqual([]);
  });

  it("dedupes by document and page", () => {
    const citations = buildCitations([
      chunk({ chunk_id: 1, book_page: "4" }),
      chunk({ chunk_id: 2, book_page: "4" }),
      chunk({ chunk_id: 3, book_page: "5" }),
    ]);
    expect(citations).toHaveLength(2);
  });

  it("caps quotes and strips markup and furigana", () => {
    const citations = buildCitations([
      chunk({
        content: `## 見出し\n| 形 | 例 |\n明日《あした》${"あ".repeat(500)}`,
      }),
    ]);
    expect(citations[0].quote.length).toBeLessThanOrEqual(200);
    expect(citations[0].quote).not.toContain("《");
    expect(citations[0].quote).not.toContain("#");
    expect(citations[0].quote).not.toContain("|");
  });

  it("caps the citation list at four sources", () => {
    const citations = buildCitations(
      Array.from({ length: 10 }, (_, i) =>
        chunk({ chunk_id: i, document_id: i, book_page: String(i) }),
      ),
    );
    expect(citations).toHaveLength(4);
  });
});

describe("retrieveByTopic — which arms a division question reaches for", () => {
  /** Records every filter each arm applies, and serves no rows. */
  function recorder() {
    const queries: Record<string, unknown>[] = [];
    const from = (table: string) => {
      const ops: Record<string, unknown> = { table };
      queries.push(ops);
      const chain: Record<string, unknown> = {};
      const record = (name: string) => (...args: unknown[]) => {
        ops[name] = args.length === 1 ? args[0] : args;
        return chain;
      };
      for (const method of ["select", "eq", "filter", "order", "contains", "in", "limit"]) {
        chain[method] = record(method);
      }
      chain.then = (resolve: (value: { data: unknown[] }) => unknown) => resolve({ data: [] });
      return chain;
    };
    return { queries, db: { from } as unknown as Parameters<typeof retrieveByTopic>[0] };
  }

  const arm = (queries: Record<string, unknown>[], key: string) =>
    queries.find((q) => q.table === "chunks" && key in q);

  it("asks for a topic's handouts from the Foundation course only", async () => {
    clearPoolCache();
    const { queries, db } = recorder();
    await retrieveByTopic(db, topicRefs("topic 7 kanji"), aspectOf("topic 7 kanji"));
    expect(arm(queries, "contains")?.in).toEqual(["documents.level", ["F2", "F3"]]);
  });

  it("asks for a lesson's handouts from the Intermediate course only", async () => {
    // "Topic 7" and "Lesson 7" both reduce to the marker T7, and every
    // handout in the corpus is Foundation — so an Intermediate student asking
    // for Lesson 7 was handed Foundation Topic 7's grammar sheets.
    clearPoolCache();
    const { queries, db } = recorder();
    await retrieveByTopic(db, topicRefs("lesson 7 kanji"), aspectOf("lesson 7 kanji"));
    expect(arm(queries, "contains")?.in).toEqual(["documents.level", ["INT"]]);
  });

  it("looks for the division by what is printed, with both guards", async () => {
    clearPoolCache();
    const { queries, db } = recorder();
    await retrieveByTopic(db, topicRefs("topic 1 kanji"), aspectOf("topic 1 kanji"));
    // Both this arm and the section map filter on content; only this one
    // takes a row budget.
    const pages = queries.find(
      (q) => q.table === "chunks" && "filter" in q && "limit" in q,
    ) as { filter: unknown[]; limit: number } | undefined;
    expect(pages?.filter[1]).toBe("imatch");
    expect(pages?.filter[2]).toBe(divisionPattern({ marker: "T1", number: 1, kind: "topic" }));
    // Above the 36 chunks the widest division in the corpus matches, so both
    // halves of a book are read before anything is ranked away.
    expect(pages?.limit).toBeGreaterThanOrEqual(80);
  });
});

describe("selectContext — a page the chunker split is still one page", () => {
  const page = (id: number, pdf_page: number, content: string, wholePage = true) =>
    chunk({ chunk_id: id, document_id: 30, pdf_page, book_page: String(pdf_page), content, wholePage, similarity: 0.8 });

  it("keeps every chunk of a page a division owns", () => {
    // Topic 12's vocabulary page is three chunks: 33 characters of the
    // heading 「## 新しい語彙」, then 1,571 of the actual word list, then 48
    // more. Only the first carries the running header, so only the first was
    // ever matched — and the one-chunk-per-page rule then threw the other two
    // away. The student asking for the topic's vocabulary got a heading.
    const picked = selectContext(
      [
        page(1206, 32, "トピック 12 旅行します\n\n## 新しい語彙"),
        page(1207, 32, "| Nouns | ウエイトレス | waitress | 旅館 | Japanese inn |"),
        page(1208, 32, "| ～泊する | to stay ~ number of nights |"),
      ],
      { limit: 6, perDocument: 6 },
    );
    expect(picked).toHaveLength(3);
    expect(picked.map((c) => c.content).join(" ")).toContain("ウエイトレス");
  });

  it("still shows an ordinary page once", () => {
    const picked = selectContext(
      [
        chunk({ chunk_id: 1, document_id: 30, pdf_page: 40, book_page: "40", content: "a", similarity: 0.8 }),
        chunk({ chunk_id: 2, document_id: 30, pdf_page: 40, book_page: "40", content: "b", similarity: 0.8 }),
      ],
      { limit: 6, perDocument: 6 },
    );
    expect(picked).toHaveLength(1);
  });

  it("counts pages rather than pieces, so one long table cannot crowd out the rest", () => {
    const split = [
      page(1, 10, "heading"), page(2, 10, "table part one"), page(3, 10, "table part two"),
    ];
    const others = [4, 5, 6].map((n) => page(n + 10, 20 + n, "another page " + n));
    const picked = selectContext([...split, ...others], { limit: 4, perDocument: 9 });
    const pages = new Set(picked.map((c) => c.pdf_page));
    expect(pages.size).toBe(4);
    expect(picked.filter((c) => c.pdf_page === 10)).toHaveLength(3);
  });
});
