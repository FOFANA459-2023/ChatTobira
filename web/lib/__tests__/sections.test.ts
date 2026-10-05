import { beforeEach, describe, expect, it } from "vitest";

import { clearPoolCache } from "@/lib/corpus-cache";
import { loadSectionMap, sectionOf, type SectionMap } from "@/lib/sections";

/** A Supabase stand-in for the two queries loadSectionMap makes.
 *
 * Shaped by table rather than by call order, so the test reads as the corpus
 * it describes: these books, and the chunks that look like a divider.
 */
function db(
  books: { id: number; title: string }[],
  dividers: { document_id: number; pdf_page: number; content: string }[],
) {
  const builder = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "filter", "order"]) {
      chain[method] = () => chain;
    }
    chain.then = (resolve: (value: { data: unknown[] }) => unknown) => resolve({ data: rows });
    return chain;
  };
  return {
    from: (table: string) => builder(table === "documents" ? books : dividers),
  } as unknown as Parameters<typeof loadSectionMap>[0];
}

const FOUNDATION = { id: 5, title: "Foundation 1 & 2" };
const FOUNDATION_3 = { id: 30, title: "Foundation 3 Textbook" };
const INT_TEXT = { id: 3, title: "Tobira Intermediate Japanese" };
const INT_KANJI = { id: 4, title: "Tobira Kanji and Vocabulary Intermediate Japanese" };

describe("loadSectionMap", () => {
  beforeEach(clearPoolCache);

  it("divides a book at the page that carries only the part title", async () => {
    const map = await loadSectionMap(
      db([FOUNDATION, FOUNDATION_3], [
        { document_id: 5, pdf_page: 185, content: "# Kanji and Vocabulary" },
        { document_id: 30, pdf_page: 171, content: "# Kanji and Vocabulary\n\nかんじ・ごいれんしゅう" },
      ]),
    );
    expect(map.kanjiFrom.get(5)).toBe(185);
    expect(map.kanjiFrom.get(30)).toBe(171);
  });

  it("reads a book whose title says kanji as kanji cover to cover", async () => {
    // Its own contents page opens with 「# 漢字・語彙練習」 nine pages in, and
    // taking that for a divider would file its first nine pages as grammar.
    const map = await loadSectionMap(
      db([INT_KANJI], [{ document_id: 4, pdf_page: 11, content: "# 漢字・語彙練習" }]),
    );
    expect(map.allKanji.has(4)).toBe(true);
    expect(map.kanjiFrom.has(4)).toBe(false);
    expect(sectionOf(4, 3, map)).toBe("kanji");
    expect(sectionOf(4, 200, map)).toBe("kanji");
  });

  it("does not divide a book that merely mentions the companion volume", async () => {
    // The Intermediate textbook explains the Kanji & Vocabulary book under a
    // ### subheading of "How to Use This Textbook", p. 14 of 216. Reading
    // that as a divider made pages 14-216 of a grammar book read as kanji.
    const map = await loadSectionMap(
      db([INT_TEXT], [
        {
          document_id: 3,
          pdf_page: 14,
          content: "### Kanji and Vocabulary\nEach of the eight lessons contains a kanji list…",
        },
      ]),
    );
    expect(map.kanjiFrom.has(3)).toBe(false);
    expect(sectionOf(3, 200, map)).toBe("grammar");
  });

  it("ignores the contents page that repeats the divider's heading", async () => {
    const map = await loadSectionMap(
      db([FOUNDATION], [
        {
          document_id: 5,
          pdf_page: 193,
          content: "# 漢字・語彙練習\n\n# 目次\n\n| Topic1 はじめまして |\n| 勉強する漢字 | 山 川 木 林 森 田 石 竹 人 私 177 |",
        },
        { document_id: 5, pdf_page: 185, content: "# Kanji and Vocabulary" },
      ]),
    );
    expect(map.kanjiFrom.get(5)).toBe(185);
  });
});

describe("sectionOf", () => {
  const map: SectionMap = {
    kanjiFrom: new Map([[5, 185]]),
    allKanji: new Set([4]),
  };

  it("splits a divided book at its divider", () => {
    // Topic 7 is taught twice in this book: the text runs from p. 94 and the
    // kanji from p. 221, both printing the same 「Topic 7」 header.
    expect(sectionOf(5, 114, map)).toBe("grammar");
    expect(sectionOf(5, 184, map)).toBe("grammar");
    expect(sectionOf(5, 185, map)).toBe("kanji");
    expect(sectionOf(5, 240, map)).toBe("kanji");
  });

  it("treats an undivided document as grammar, handouts included", () => {
    expect(sectionOf(3, 200, map)).toBe("grammar");
    expect(sectionOf(15, 1, map)).toBe("grammar");
  });

  it("does not guess when a chunk has no page", () => {
    expect(sectionOf(5, null, map)).toBe("grammar");
  });
});
