import { describe, expect, it } from "vitest";

import { rankKeywordRows, retrieveByKeywords, selectContext } from "../retrieval";

/** Searching the corpus by its words, for when it cannot be searched by
 * meaning.
 *
 * Only Google can embed a question against this index, and on 2026-11-12 the
 * Google account ran out of credit for the second time in two weeks. Every
 * course question stopped at that first step and told the student the AI
 * service was unavailable — while DeepSeek, which writes the answers, was
 * answering fine. These tests hold the fallback that keeps chat answering.
 */

const row = (
  id: number,
  content: string,
  documents: { is_citable?: boolean; level?: string | null; topic?: string | null } = {},
) => ({
  id,
  document_id: id,
  pdf_page: id,
  book_page: String(id),
  content,
  metadata: {},
  documents: {
    title: `doc ${id}`,
    doc_type: "textbook",
    is_citable: documents.is_citable ?? false,
    level: documents.level ?? null,
    topic: documents.topic ?? null,
  },
});

describe("rankKeywordRows", () => {
  it("puts the page with more of the question's words first", () => {
    const ranked = rankKeywordRows(
      [row(1, "て形 only"), row(2, "て形 と 食べる と 飲む")],
      ["て形", "食べる", "飲む"],
      {},
    );
    expect(ranked.map((r) => r.id)).toEqual([2, 1]);
  });

  it("prefers the book the student is studying when the words tie", () => {
    const ranked = rankKeywordRows(
      [row(1, "て形", { level: "F2" }), row(2, "て形", { level: "F3" })],
      ["て形"],
      { level: "F3" },
    );
    expect(ranked[0].id).toBe(2);
  });

  it("prefers the textbook to a handout when the words tie", () => {
    const ranked = rankKeywordRows(
      [row(1, "て形"), row(2, "て形", { is_citable: true })],
      ["て形"],
      {},
    );
    expect(ranked[0].id).toBe(2);
  });

  it("matches English regardless of case, since half the questions are English", () => {
    const ranked = rankKeywordRows([row(1, "nothing"), row(2, "The Te-Form")], ["te-form"], {});
    expect(ranked[0].id).toBe(2);
  });

  it("keeps the database's order when nothing tells two pages apart", () => {
    const ranked = rankKeywordRows([row(1, "x"), row(2, "x"), row(3, "x")], ["x"], {});
    expect(ranked.map((r) => r.id)).toEqual([1, 2, 3]);
  });
});

/** A fake client that records the one query the keyword arm makes. */
function fakeDb(rows: unknown[]) {
  const calls: Record<string, unknown[]> = {};
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "textSearch", "limit"]) {
    chain[method] = (...args: unknown[]) => {
      calls[method] = args;
      return chain;
    };
  }
  chain.then = (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
    resolve({ data: rows, error: null });
  const db = {
    from: (table: string) => {
      calls.from = [table];
      return chain;
    },
  } as unknown as Parameters<typeof retrieveByKeywords>[0];
  return { db, calls };
}

describe("retrieveByKeywords", () => {
  it("searches the same index the ranked search does, by the same tokens", async () => {
    const { db, calls } = fakeDb([]);
    await retrieveByKeywords(db, ["て形", "食べる"], {});
    expect(calls.from).toEqual(["chunks"]);
    expect(calls.textSearch?.[0]).toBe("tokens");
    expect(calls.textSearch?.[1]).toBe('"て形" or "食べる"');
    expect(calls.textSearch?.[2]).toEqual({ config: "simple", type: "websearch" });
  });

  it("cannot be broken by what a student typed", async () => {
    // Quotes and operators would end the phrase early or change its meaning.
    const { db, calls } = fakeDb([]);
    await retrieveByKeywords(db, ['what"s', "a|b", "(x)"], {});
    expect(calls.textSearch?.[1]).toBe('"whats" or "ab" or "x"');
  });

  it("asks for nothing when there is nothing to ask for", async () => {
    const { db, calls } = fakeDb([]);
    expect(await retrieveByKeywords(db, ['"', "  "], {})).toEqual([]);
    expect(calls.from).toBeUndefined();
  });

  it("hands back pages in the shape every other arm does, ranked", async () => {
    const { db } = fakeDb([row(1, "て形"), row(2, "て形 食べる")]);
    const chunks = await retrieveByKeywords(db, ["て形", "食べる"], {});
    expect(chunks.map((c) => c.chunk_id)).toEqual([2, 1]);
    expect(chunks[0]).toMatchObject({ doc_title: "doc 2", content: "て形 食べる" });
  });

  it("never claims a page as the question's source just for sharing a word", async () => {
    // `exact` is what lets a page be cited without a similarity score. A
    // keyword hit has earned neither.
    const { db } = fakeDb([row(1, "て形", { is_citable: true })]);
    const [chunk] = await retrieveByKeywords(db, ["て形"], {});
    expect(chunk.exact).toBe(false);
    expect(chunk.similarity).toBe(0);
  });

  it("reaches the prompt when the similarity floor is lifted, which the route does", async () => {
    // Below the floor, selectContext keeps only its two-passage safety net —
    // which would answer a keyword question from a third of what was found.
    const { db } = fakeDb([row(1, "て形"), row(2, "て形"), row(3, "て形")]);
    const chunks = await retrieveByKeywords(db, ["て形"], {});
    expect(selectContext(chunks)).toHaveLength(2);
    expect(selectContext(chunks, { minSimilarity: 0 })).toHaveLength(3);
  });
});
