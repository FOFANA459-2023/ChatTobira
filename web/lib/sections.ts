/** Which half of a textbook a page belongs to.
 *
 * Every Foundation book in this corpus runs its topics TWICE. Topic 7 has a
 * block of pages in the front half — objectives, dialogue, new vocabulary,
 * grammar explanations, れんしゅう — and a second block in the back half that
 * teaches the same topic's kanji: the stroke-order tables, the katakana word
 * list, 漢字・語彙練習, Real life Kanji. Both blocks print the same running
 * header, 「Topic 7」, so from the outside they are indistinguishable.
 *
 * That cost students the kanji half of the course. A question naming a topic
 * matched both blocks, the front one sorts first by chunk id, and only a
 * handful of rows survive to the prompt — so "list the Topic 7 kanji" was
 * answered from the front half's vocabulary pages, which contain no kanji
 * list, and the model correctly reported that there wasn't one. Measured on
 * the corpus before this file existed: 21 of 54 kanji questions across every
 * topic and lesson retrieved ZERO pages from a kanji section.
 *
 * The split is not guesswork and does not need a per-chunk label. Each book
 * prints a divider page — a page whose entire content is the heading
 * 「# Kanji and Vocabulary」 — and everything from there to the back cover is
 * the kanji half. Measured: Foundation 1 & 2 divides at p. 185 of 290,
 * Foundation 3 at p. 171 of 290. The Intermediate set does not divide at all,
 * because it ships the two halves as two separate books: the main volume is
 * all grammar, and the Kanji & Vocabulary volume is all kanji, which its
 * title says.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { cachedPool, rememberPool } from "./corpus-cache";

export type Section = "grammar" | "kanji";

export interface SectionMap {
  /** Document id -> first page of its kanji half. */
  kanjiFrom: Map<number, number>;
  /** Documents that are a kanji book cover to cover. */
  allKanji: Set<number>;
}

/** The divider page: a part title with nothing else on it.
 *
 * All three conditions are load-bearing, and each one was put here by a book
 * that defeated the version without it.
 *
 * Anchored, because both Foundation books also name "Kanji and Vocabulary" on
 * their contents page and an unanchored match puts the divider on p. 7 and
 * calls the whole book kanji. A top-level heading only (`#` or `##`), because
 * the Intermediate textbook explains the companion volume under a `###`
 * subheading of "How to Use This Textbook" on p. 14 — which made pages 14-216
 * of a book with no kanji half read as kanji, and quietly cost Intermediate
 * students their grammar pages. And short, because the ToC page that follows
 * each real divider opens with the same heading: a divider is a title page
 * carrying a title and nothing else, 22 characters in Foundation 1 & 2 and 34
 * in Foundation 3.
 */
const DIVIDER = "^##? *(Kanji and Vocabulary|漢字・語彙練習)";

/** Longest a chunk can be and still be only a part title. The real dividers
 * measure 22 and 34 characters; the contents pages that share their heading
 * run to hundreds. */
const DIVIDER_MAX_CHARS = 80;

/** The same rule as DIVIDER, re-checked here on what came back.
 *
 * Not redundant: the pattern above narrows the fetch, and this decides. A
 * regex sent to the database is only as good as the database's reading of
 * it — and getting this wrong does not fail loudly, it silently files half a
 * book under the wrong heading and takes a student's grammar pages away. The
 * length rule can only be applied here in any case, so the heading rule may
 * as well be stated where it can be read and tested next to it.
 */
function isDivider(content: string): boolean {
  const text = content.trim();
  return text.length <= DIVIDER_MAX_CHARS && /^##? *(Kanji and Vocabulary|漢字・語彙練習)/i.test(text);
}

const CACHE_KEY = "sections";

/** Where each textbook's kanji half begins.
 *
 * Two small queries, cached for the corpus TTL like the chunk pools next to
 * it — the answer changes only when `ingest push` runs. Callers run this
 * alongside their own query rather than before it, so a cold isolate pays no
 * extra latency for it.
 */
export async function loadSectionMap(supabase: SupabaseClient): Promise<SectionMap> {
  const cached = cachedPool<SectionMap>(CACHE_KEY);
  if (cached) return cached;

  const [books, dividers] = await Promise.all([
    supabase
      .from("documents")
      .select("id, title")
      .eq("doc_type", "textbook")
      .then(({ data }) => data ?? []),
    supabase
      .from("chunks")
      .select("document_id, pdf_page, content")
      .filter("content", "imatch", DIVIDER)
      .order("pdf_page")
      .then(({ data }) => data ?? []),
  ]);

  const map: SectionMap = { kanjiFrom: new Map(), allKanji: new Set() };

  // A book whose own title says Kanji is one from cover to cover. Checked
  // before the divider, because that book prints the heading too — over its
  // own contents page, nine pages in — and reading that as a divider would
  // leave its first nine pages misfiled as grammar.
  for (const book of books as { id: number; title: string }[]) {
    if (/kanji|漢字/i.test(book.title)) map.allKanji.add(book.id);
  }

  const rows = dividers as { document_id: number; pdf_page: number; content: string }[];
  for (const row of rows) {
    if (map.allKanji.has(row.document_id)) continue;
    if (!isDivider(row.content)) continue;
    const seen = map.kanjiFrom.get(row.document_id);
    if (seen === undefined || row.pdf_page < seen) {
      map.kanjiFrom.set(row.document_id, row.pdf_page);
    }
  }

  rememberPool(CACHE_KEY, map);
  return map;
}

/** Which half a page belongs to.
 *
 * Only textbooks have halves. A handout is whatever its folder made it —
 * this corpus has grammar and reading handouts and no kanji ones — so
 * anything that is not a page of a divided book counts as grammar, which is
 * where a handout would be shelved if the books had shelved it.
 */
export function sectionOf(
  documentId: number,
  pdfPage: number | null,
  map: SectionMap,
): Section {
  if (map.allKanji.has(documentId)) return "kanji";
  const from = map.kanjiFrom.get(documentId);
  if (from === undefined || pdfPage === null) return "grammar";
  return pdfPage >= from ? "kanji" : "grammar";
}
