import { describe, expect, it } from "vitest";

import {
  bookHint,
  isPageQuery,
  pageRefs,
  pageSpellings,
  pageWindow,
  parsePageQuery,
  sectionRefs,
  wantsTextbook,
} from "@/lib/pages";
import { rankPageChunks, resolveQuery, tokensForQuery } from "@/lib/retrieval";

describe("the defect this fixes", () => {
  it("shows why the lexical arm never saw a two-digit page", () => {
    // tokensForQuery drops anything under three characters that is not course
    // shorthand, so "page 85" searched the corpus for the word "page" and
    // returned pages 31, 21, 81 and 12 — for a page that is indexed, correct,
    // and numbered 85.
    expect(tokensForQuery("foundation 2 book page 85")).not.toContain("85");
  });

  it("drops a page number of ANY length, not just a short one", () => {
    // Worse than the character-length rule suggests. The segmenter shreds a
    // run of ASCII digits, so even a three-digit page is gone before the
    // length filter is reached — "217" on its own tokenizes to nothing at
    // all. When a query for p.217 did land on p.217, that was the vector arm
    // getting lucky on a page that prints its own number, not the lexical arm
    // working.
    expect(tokensForQuery("217")).toEqual([]);
    expect(tokensForQuery("page 217")).toEqual(["page"]);
    expect(tokensForQuery("p122")).toEqual([]);
    // Which is why the fix is a metadata filter on book_page rather than a
    // change to tokenisation: the number has to stop being a search term and
    // start being a constraint.
  });
});

describe("pageRefs", () => {
  it("reads the ways a student writes a page number", () => {
    for (const [text, page] of [
      ["page 85", 85],
      ["Page 85", 85],
      ["p. 85", 85],
      ["p.85", 85],
      ["p122", 122],
      ["pp. 217", 217],
      ["85ページ", 85],
      ["217 ページ", 217],
      ["ページ122", 122],
      ["85頁", 85],
    ] as const) {
      expect(pageRefs(text)[0]?.page, text).toBe(page);
    }
  });

  it("reads the page out of a whole sentence", () => {
    expect(pageRefs("answer the practice questions foundation 1 and 2 textbook on page 85")[0])
      .toMatchObject({ page: 85 });
    expect(pageRefs("now answer the practice questions on page 122 for topic 8")[0])
      .toMatchObject({ page: 122 });
  });

  it("does not read a topic, a lesson or a counter as a page", () => {
    // The reason the parse is anchored on the word. A bare number in these
    // questions is far more often a division than a page.
    expect(pageRefs("list all the vocabulary for topic 8")).toEqual([]);
    expect(pageRefs("第3課の文法")).toEqual([]);
    expect(pageRefs("(1×10=10)")).toEqual([]);
    expect(pageRefs("Foundation 2")).toEqual([]);
    expect(pageRefs("5人います")).toEqual([]);
  });

  it("rejects a number too large to be a page in these books", () => {
    expect(pageRefs("page 9999")).toEqual([]);
    expect(pageRefs("page 0")).toEqual([]);
  });

  it("keeps both pages when a student names a range of interest", () => {
    const refs = pageRefs("compare page 85 and page 122");
    expect(refs.map((r) => r.page)).toEqual([85, 122]);
  });
});

describe("bookHint", () => {
  it("resolves the Foundation volumes the way the corpus files them", () => {
    // Foundation 1 and Foundation 2 are one book — the course runs Topics
    // 1–10 through a single volume — and the corpus files it as F2.
    expect(bookHint("foundation 1 and 2 textbook")).toBe("F2");
    expect(bookHint("Foundation 2 book page 85")).toBe("F2");
    expect(bookHint("foundation 1 textbook")).toBe("F2");
    expect(bookHint("Foundation 3 textbook")).toBe("F3");
    expect(bookHint("the Tobira intermediate book")).toBe("INT");
  });

  it("does not mistake Foundation 3 for a mention of Foundation 1", () => {
    expect(bookHint("foundation 3 page 40")).toBe("F3");
  });

  it("says nothing when the student named no book", () => {
    expect(bookHint("what is on page 85")).toBeNull();
  });
});

describe("sectionRefs", () => {
  it("reads the subsections the Foundation books print", () => {
    // The books use ASCII and full-width Roman numerals, and space the hyphen
    // inconsistently: "III - 4" and "Ⅲ-3" are the same kind of heading.
    expect(sectionRefs("particularly section III-4")).toEqual(["III-4"]);
    expect(sectionRefs("section III - 4")).toEqual(["III-4"]);
    expect(sectionRefs("Ⅲ-3 の問題")).toEqual(["III-3"]);
    expect(sectionRefs("section IV")).toEqual(["IV"]);
  });

  it("finds nothing where there is no section", () => {
    expect(sectionRefs("page 85 practice questions")).toEqual([]);
  });
});

describe("wantsTextbook", () => {
  it("hears the student rule out the class handouts", () => {
    // "Foundation 2 textbook page 85" is not a request that can be answered
    // from a handout, nor a page that is missing because no handout had it.
    expect(wantsTextbook("foundation 2 textbook page 85")).toBe(true);
    expect(wantsTextbook("foundation 2 book page 85")).toBe(true);
    expect(wantsTextbook("教科書の85ページ")).toBe(true);
    expect(wantsTextbook("what does 〜ておく mean")).toBe(false);
  });
});

describe("pageWindow and pageSpellings", () => {
  it("fetches the page either side, because an exercise runs over", () => {
    // Measured on the corpus: the Topic 6 kanji section a student asks for as
    // "III-4" opens on p.217 under the heading III-3.
    expect(pageWindow(217)).toEqual([217, 216, 218]);
  });

  it("never asks for a page before the first one", () => {
    expect(pageWindow(1)).toEqual([1, 2]);
  });

  it("matches the spellings a page number is stored in", () => {
    expect(pageSpellings(85)).toEqual(["85", "８５"]);
  });
});

describe("rankPageChunks", () => {
  const row = (book_page: string | null, content = "") => ({ book_page, content });

  it("puts the page asked for ahead of its neighbours", () => {
    // The neighbours are fetched because an exercise crosses the page break,
    // not because they answer the question equally well.
    const ranked = rankPageChunks([row("216"), row("218"), row("217")], 217);
    expect(ranked[0].book_page).toBe("217");
  });

  it("puts the named subsection first within the page", () => {
    const ranked = rankPageChunks(
      [
        row("217", "III - 1. Something else"),
        row("217", "III - 4. The exercise the student asked for"),
      ],
      217,
      ["III-4"],
    );
    expect(ranked[0].content).toContain("III - 4");
  });

  it("matches a section however the book spaced its hyphen", () => {
    const ranked = rankPageChunks(
      [row("218", "nothing"), row("217", "Ⅲ-4 exercise")],
      217,
      ["III-4"],
    );
    // The page match alone would put 217 first; this checks the section
    // scoring does not throw on the full-width form.
    expect(ranked[0].book_page).toBe("217");
  });
});

describe("parsePageQuery", () => {
  it("resolves a whole page-specific request", () => {
    const query = parsePageQuery(
      "answer the kanji exercise on page 217 topic 6, particularly section III-4",
    );
    expect(query.pages[0].page).toBe(217);
    expect(query.sections).toEqual(["III-4"]);
    expect(isPageQuery(query)).toBe(true);
  });

  it("resolves the book when the student named one", () => {
    const query = parsePageQuery("answer the practice questions foundation 1 and 2 textbook on page 85");
    expect(query.pages[0].page).toBe(85);
    expect(query.level).toBe("F2");
    expect(query.textbookOnly).toBe(true);
  });

  it("is not a page query when no page was named", () => {
    expect(isPageQuery(parsePageQuery("list all the vocabulary for topic 8"))).toBe(false);
  });
});

describe("carrying the page through the conversation", () => {
  const turn = (role: string, text: string) => ({ role, text });

  it("remembers the page from an earlier turn", () => {
    // "can you read page 85 though" names it; the turns after it are still
    // about page 85.
    const query = resolveQuery([
      turn("user", "foundation 2 book page 85"),
      turn("assistant", "That page covers 〜のほうが…"),
      turn("user", "can you read it though"),
    ]);
    expect(query.pageQuery.pages[0].page).toBe(85);
    expect(query.pageQuery.level).toBe("F2");
  });

  it("lets a newly named page replace the old one", () => {
    const query = resolveQuery([
      turn("user", "page 85 please"),
      turn("assistant", "…"),
      turn("user", "what about topic 7 kanji on page 226"),
    ]);
    expect(query.pageQuery.pages[0].page).toBe(226);
  });

  it("does not adopt a page the tutor mentioned in passing", () => {
    // A page number in an ANSWER is a citation, not a request to open it.
    const query = resolveQuery([
      turn("user", "what does 〜ておく mean"),
      turn("assistant", "It is covered on page 112 of the Foundation 3 book."),
      turn("user", "can you give another example"),
    ]);
    expect(query.pageQuery.pages).toEqual([]);
  });
});
