/** Reading a page reference out of a question, and finding that page.
 *
 * A student who says "Foundation 2 textbook page 85" has told the app exactly
 * where to look, and until now that was the one thing retrieval could not use.
 * Measured on the live corpus, against pages that are indexed and correct:
 *
 *   "foundation 2 book page 85"                    -> pages 128, 111, 94, 76
 *   "answer the practice questions on page 122"    -> pages 124, 121, 231
 *   "…page 85" (Foundation 1 & 2, which HAS p.85)  -> pages 31, 21, 81, 12
 *
 * The pages themselves were never the problem. Every one of those is indexed,
 * with the right content under the right book_page: p.85 holds the れんしゅう
 * practice, p.122 holds どうして and 〜しか〜ません, p.217 holds the Topic 6
 * kanji section. Three faults in retrieval, none in ingestion:
 *
 *   1. No page number reaches the lexical index — of any length. The
 *      segmenter shreds a run of ASCII digits before the token filter is
 *      reached, so "217" on its own tokenizes to nothing at all and "page 85"
 *      searches the corpus for the word "page". Where a query for p.217 did
 *      land on p.217, that was the vector arm getting lucky on a page that
 *      happens to print its own number.
 *   2. Nothing filtered on book_page. Retrieval had a vector arm, a lexical
 *      arm, a literal-pattern arm and a topic arm, and no arm at all for the
 *      column that holds the answer.
 *   3. book_page is not unique. Page 85 exists in Foundation 1 & 2, in
 *      Foundation 3, in both Intermediate volumes and in a class handout, so
 *      even a working page filter answers the wrong page without a book.
 *
 * Hence a parse into constraints rather than search terms: the number has to
 * stop being something a ranker might notice and start being something the
 * query filters on.
 *
 * So a page reference is parsed here into something retrieval can filter on,
 * rather than hoping a ranker stumbles onto it.
 */

/** A page the student named, and where they said to look for it. */
export interface PageRef {
  page: number;
  /** How the student wrote it, for the diagnostics log. */
  raw: string;
}

/** Which book. book_page collides across documents — page 85 exists in
 * Foundation 1 & 2, in Foundation 3, in both Intermediate volumes and in a
 * class handout — so a page number on its own is five different pages, and
 * the level is what makes the reference mean one of them. */
export type BookHint = "F2" | "F3" | "INT" | null;

export interface PageQuery {
  pages: PageRef[];
  level: BookHint;
  /** The student said "textbook", so a class handout is not what they meant. */
  textbookOnly: boolean;
  /** "III-4", "section III", "Ⅲ－4" — a subsection within the page. */
  sections: string[];
}

/** A page number, and only when it is marked as one.
 *
 * Anchored on the word deliberately. A bare number in a Japanese question is
 * far more often a topic, a lesson, a mark allocation or a counter than a
 * page: "Topic 6", "第3課", "(1×10)", "5人". Requiring page/p./ページ costs
 * nothing — a student asking about a page says so — and it is what keeps
 * "Topic 8" from being read as page 8.
 */
const PAGE_RE =
  /\b(?:p\.?|pp\.?|page|pages)\s*(\d{1,3})(?!\d)|(\d{1,3})\s*(?:ページ|頁)|(?:ページ|頁)\s*(\d{1,3})/gi;

/** Textbook page numbers in this corpus run to the high 200s; anything else
 * marked as a page is a misparse. */
const MAX_PAGE = 400;

export function pageRefs(text: string, limit = 3): PageRef[] {
  const found: PageRef[] = [];
  for (const match of text.matchAll(PAGE_RE)) {
    const digits = match[1] ?? match[2] ?? match[3];
    const page = Number(digits);
    if (!digits || page < 1 || page > MAX_PAGE) continue;
    if (found.some((ref) => ref.page === page)) continue;
    found.push({ page, raw: match[0].trim() });
  }
  return found.slice(0, limit);
}

/** Which book the student named.
 *
 * "Foundation 1 and 2" and "Foundation 2" are the same volume — the course
 * runs Topics 1–10 through one book — so both resolve to F2, which is how the
 * corpus files it. Checked longest-first so "Foundation 3" is not read as a
 * mention of Foundation 1.
 */
export function bookHint(text: string): BookHint {
  const low = text.toLowerCase();
  if (/\bfoundation\s*3\b|\bf\s*3\b|ファンデーション\s*3/.test(low)) return "F3";
  if (/\bfoundation\s*(?:1\s*(?:and|&|＆|,)\s*)?[12]\b|\bf\s*2\b|\bfoundation\s*1\b/.test(low)) {
    return "F2";
  }
  if (/\btobira\b|\bintermediate\b|中級/.test(low)) return "INT";
  return null;
}

/** Did the student say "textbook"?
 *
 * It matters because the corpus holds both. A student who says "Foundation 2
 * textbook page 85" has ruled out the class handouts, and answering from a
 * handout — or worse, reporting the page missing because no handout had it —
 * is not what they asked for.
 */
export function wantsTextbook(text: string): boolean {
  return /\btext\s?book\b|\bbook\b|教科書|きょうかしょ/i.test(text);
}

/** Subsections as the Foundation books print them: 「III - 4」, 「Ⅲ-3」,
 * 「section III」. The books use both ASCII and full-width Roman numerals and
 * space the hyphen inconsistently, so the parse normalises to "III-4". */
const SECTION_RE =
  /(?:section\s*)?(?<![A-Za-z])([IVXivx]{1,4}|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ])\s*[-‐–—ー－]\s*(\d{1,2})(?!\d)|section\s+([IVXivx]{1,4})\b/g;

const FULLWIDTH_ROMAN: Record<string, string> = {
  Ⅰ: "I", Ⅱ: "II", Ⅲ: "III", Ⅳ: "IV", Ⅴ: "V",
  Ⅵ: "VI", Ⅶ: "VII", Ⅷ: "VIII", Ⅸ: "IX", Ⅹ: "X",
};

export function sectionRefs(text: string, limit = 2): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(SECTION_RE)) {
    const roman = (match[1] ?? match[3] ?? "").toUpperCase();
    const normalised = FULLWIDTH_ROMAN[match[1] ?? ""] ?? roman;
    if (!normalised) continue;
    const label = match[2] ? `${normalised}-${match[2]}` : normalised;
    if (!found.includes(label)) found.push(label);
  }
  return found.slice(0, limit);
}

/** Everything a page-specific question said about where to look. */
export function parsePageQuery(text: string): PageQuery {
  return {
    pages: pageRefs(text),
    level: bookHint(text),
    textbookOnly: wantsTextbook(text),
    sections: sectionRefs(text),
  };
}

/** The spellings a page number takes in the books' own text.
 *
 * book_page is stored as the model read it off the page, which is usually
 * "85" but is sometimes full-width and sometimes carries the folio's own
 * decoration. Matching a small set of spellings is cheaper and safer than
 * casting the column to an integer, which would throw on the front matter —
 * this corpus has pages numbered "ii", "x" and "xi".
 */
export function pageSpellings(page: number): string[] {
  const ascii = String(page);
  const fullWidth = ascii.replace(/\d/g, (d) => "０１２３４５６７８９"[Number(d)]);
  return ascii === fullWidth ? [ascii] : [ascii, fullWidth];
}

/** The pages worth reading to answer a question about one page.
 *
 * An exercise does not respect the page break. Measured on the corpus: the
 * Topic 6 kanji section a student would ask for as "III-4" starts on p.217
 * under the heading III-3, and the questions run over. So the page either
 * side is fetched too, ranked below the page actually asked for, and dropped
 * again if it turns out to have nothing to do with the question.
 */
export function pageWindow(page: number, spread = 1): number[] {
  const pages: number[] = [page];
  for (let step = 1; step <= spread; step++) {
    if (page - step >= 1) pages.push(page - step);
    pages.push(page + step);
  }
  return pages;
}

/** Does this question point at a specific page?
 *
 * The gate for the whole page-retrieval path, and for the prompt rule that
 * stops the tutor writing its own exercise when the real one was asked for.
 */
export function isPageQuery(query: PageQuery): boolean {
  return query.pages.length > 0;
}
