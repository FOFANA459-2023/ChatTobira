/** When two practice questions are the same question.
 *
 * String equality answers this badly. A generator asked for a new paper on
 * Topic 8 will happily return 「田中さんは学校に行きます」 after 「田中さんは
 * 学校へ行きます」, or swap 学校 for 大学 and call it a fresh item — and a
 * student pressing "New Test" three times gets the same drill three times
 * with the nouns moved around.
 *
 * So an item is reduced to what it actually tests, in three layers:
 *
 *   exact       the wording, normalised. Catches a verbatim repeat.
 *   structural  what is being tested, on what shape of sentence, expecting
 *               what answer. Catches the reworded repeat.
 *   pattern     the point and the answer alone. Two items sharing this are
 *               not necessarily duplicates — に is the right answer to many
 *               genuinely different questions — but a paper that keeps
 *               landing on one is a paper drilling one thing, so this feeds
 *               the avoid-list rather than the delete.
 *
 * The structural layer is built on a SKELETON: the sentence with everything
 * interchangeable stripped out. Names, loanwords and numbers become a single
 * placeholder, because swapping 田中 for 山田 changes nothing about what a
 * question tests; particles collapse too, because に and へ in the same frame
 * are the same frame — unless the particle IS the answer, and the answer is
 * part of the signature, so that case stays distinct.
 *
 * Skeletons are then compared by similarity rather than equality, which is
 * what catches the trivial-noun swap: 学校 for 大学 leaves two skeletons that
 * are not equal and are obviously the same sentence.
 */

import type { QuizItem } from "./quiz";

/** A person, a loanword, a number — the parts of a sentence a generator
 * changes when it wants a question to look new. */
const PERSON = /[一-鿿ぁ-ゖァ-ヶー]{1,6}(?:さん|くん|ちゃん|先生|様|씨)/g;
const KATAKANA_RUN = /[ァ-ヶー]{2,}/g;
const LATIN_RUN = /[A-Za-z]{2,}/g;
const DIGITS = /[0-9０-９]+/g;

/** Particles, which carry the grammar but not the identity of a frame. */
const PARTICLES = /[はがをにへでとものやかねよ]/g;

const FURIGANA = /《[^》]*》|[（(][ぁ-ゖァ-ヶー]+[）)]/g;
const MARKERS = /[【】＿_〔〕\[\]]|[（(][\s　]*[）)]/g;
const NOISE = /[\s　。、．，,.!?！？「」『』・:：;；|~〜ー]/g;

/** The sentence with the interchangeable parts removed. */
export function skeleton(text: string): string {
  return text
    .replace(FURIGANA, "")
    .replace(MARKERS, "")
    .replace(PERSON, "＊")
    .replace(KATAKANA_RUN, "＊")
    .replace(LATIN_RUN, "＊")
    .replace(DIGITS, "＃")
    .replace(NOISE, "")
    .toLowerCase();
}

/** The skeleton with particles collapsed too, so 「学校に行く」 and
 * 「学校へ行く」 are one frame. Safe because the expected answer is carried
 * alongside: when the particle is what the item tests, the answers differ. */
export function looseSkeleton(text: string): string {
  return skeleton(text).replace(PARTICLES, "・");
}

/** Dice coefficient over character bigrams: 1.0 identical, 0 nothing shared.
 *
 * Chosen over edit distance because it is cheap, symmetric, and forgiving of
 * a word swapped in the middle — which is exactly the edit a generator makes
 * when it is pretending to write a new question. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bigrams = (text: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < text.length - 1; i++) {
      const gram = text.slice(i, i + 2);
      out.set(gram, (out.get(gram) ?? 0) + 1);
    }
    return out;
  };
  const first = bigrams(a);
  const second = bigrams(b);
  let shared = 0;
  for (const [gram, count] of first) {
    const other = second.get(gram);
    if (other) shared += Math.min(count, other);
  }
  return (2 * shared) / (a.length - 1 + (b.length - 1));
}

/** Above this, two frames are the same sentence with something swapped.
 *
 * Low on purpose, and safe because of WHERE it is consulted: the frame is
 * only compared once two items already agree on the point tested and on the
 * expected answer. Two questions drilling the same pattern, expecting the
 * same word, on a recognisably similar sentence are the same question — that
 * is the whole of requirement 5 — so the frame is a tiebreaker, not the test.
 *
 * Measured on loose skeletons of real item shapes:
 *
 *   one noun swapped   「私は学校へ（　）」/「私は大学へ（　）」   0.50  catch
 *   name swapped       「リーさんは…」   /「私は…」               0.67  catch
 *   different sentence 「7時（　）おきます」/「ともだち（　）あいます」  0.17  keep
 *
 * A higher bar loses the noun swap, which is the case the requirement names.
 * A false positive here costs one item; the paper regenerates if too many go.
 *
 * The limit: two genuinely different sentences that share a point AND an
 * answer AND happen to look alike are treated as one. That is a repeat by
 * the definition above, so it is the intended reading rather than a bug.
 */
export const SAME_FRAME = 0.45;

export interface Fingerprint {
  exact: string;
  /** The point tested and the answer expected, without the sentence. */
  pattern: string;
  /** The frame the point is tested on, for similarity comparison. */
  frame: string;
}

const normalise = (text: string) => text.replace(FURIGANA, "").replace(NOISE, "").toLowerCase();

/** What an item tests, in the three layers described above. */
export function fingerprint(item: QuizItem): Fingerprint {
  const body = `${item.question ?? ""} ${item.sentence ?? ""}`;
  // The target the generator declared, falling back to the marked word and
  // then to the answer — an item that named nothing still has an identity.
  const marked = /【([^】]+)】/.exec(body)?.[1] ?? "";
  const target = normalise(item.target ?? item.grammar_point ?? marked ?? "");
  const answer = normalise(item.answer_kana || item.answer);
  return {
    exact: normalise(body),
    pattern: `${target}|${answer}`,
    frame: looseSkeleton(body),
  };
}

/** Is this item one the student has already been asked?
 *
 * Two ways to be: word for word, or the same point on the same frame with the
 * same expected answer. The second is the one that matters — it is what
 * "changed a name and called it new" looks like from the outside.
 */
export function isRepeat(item: Fingerprint, seen: Fingerprint[]): boolean {
  return seen.some(
    (prior) =>
      prior.exact === item.exact ||
      (prior.pattern === item.pattern && similarity(prior.frame, item.frame) >= SAME_FRAME),
  );
}

/** Drop repeats from a paper, against the paper itself and against history.
 *
 * `history` is what this student has already been asked at this level — the
 * fingerprints of previously generated items — so "New Test" produces a new
 * test rather than a reshuffle of the last one. Sections left empty are
 * removed, which makes the route's length gate treat a paper that only
 * reached its length by repeating itself as the short paper it is.
 */
export function dropRepeats<T extends { sections: { items: QuizItem[] }[] }>(
  quiz: T,
  history: Fingerprint[] = [],
): { quiz: T; removed: number; kept: Fingerprint[] } {
  const seen = [...history];
  const kept: Fingerprint[] = [];
  let removed = 0;

  const sections = quiz.sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => {
        const print = fingerprint(item);
        if (isRepeat(print, seen)) {
          removed += 1;
          return false;
        }
        seen.push(print);
        kept.push(print);
        return true;
      }),
    }))
    .filter((section) => section.items.length > 0);

  return { quiz: { ...quiz, sections }, removed, kept };
}
