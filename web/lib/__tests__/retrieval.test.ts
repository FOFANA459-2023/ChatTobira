import { describe, expect, it } from "vitest";

import { buildCitations, tokensForQuery, type RetrievedChunk } from "../retrieval";

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

describe("buildCitations", () => {
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
