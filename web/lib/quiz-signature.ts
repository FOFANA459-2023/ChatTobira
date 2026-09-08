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

/** Above this, two items are the same question however they are labelled.
 *
 * A second, higher bar than SAME_FRAME, and consulted without asking whether
 * the two items agree on anything else. That is the point: SAME_FRAME only
 * fires once the point tested and the expected answer already match, so it
 * cannot see the repeat where the generator relabels what it thinks it is
 * testing. Section I calls an item's target 「〜ながら」 and section III calls
 * the same item 「simultaneous actions」, and two questions that were the same
 * sentence with the noun swapped survive as different questions.
 *
 * Measured on loose skeletons of real item shapes:
 *
 *   noun swapped only     「私は学校へ（　）」/「私は大学へ（　）」     0.83
 *   name and number only  「リーさんは7時に…」/「山田さんは9時に…」   0.90
 *   same point, new frame 「まえに」on a shop / on a station            0.38
 *
 * 0.72 sits above what a genuinely rewritten sentence scores and below the
 * name-and-number swap the requirement names by hand. The cost of a false
 * positive is one item; the cost of a false negative is a student meeting
 * question 3 again as question 14.
 */
export const SAME_QUESTION = 0.72;

export interface Fingerprint {
  exact: string;
  /** The point tested and the answer expected, without the sentence. */
  pattern: string;
  /** The frame the point is tested on, for similarity comparison. */
  frame: string;
  /** What the item says it tests, reduced to a comparable key. Two items with
   * the same skill key drill the same knowledge point and only one of them
   * belongs on the paper — whatever section each of them is in. */
  skill: string;
  /** ○× statements about one passage are SUPPOSED to look alike, and are
   * exempted from the frame-similarity test for that reason. */
  comprehension: boolean;
}

const normalise = (text: string) => text.replace(FURIGANA, "").replace(NOISE, "").toLowerCase();

/** The wording a generator wraps around a grammar point when it is naming it
 * rather than writing it: 「〜ながら form」, 「the て-form of 行く」, 「particle
 * usage: に」. Two items whose targets differ only by this are two items
 * testing the same thing. */
const TARGET_NOISE =
  /\b(the|a|an|of|in|for|with|and|or|to|use|usage|using|used|form|forms|pattern|patterns|grammar|point|structure|conjugation|particle|particles|expression|expressions|verb|adjective|noun|counter|reading|writing|kanji|word|vocabulary|meaning|plain|polite|past|present|negative|affirmative)\b/g;

/** What an item claims to test, reduced so two labels for one point collide.
 *
 * The target is free text written by the model, and it writes it differently
 * every time — 「〜てから」, 「te-form + kara」, 「sequence: 〜てから」 are the
 * same point three ways. Stripping the scaffolding words and everything that
 * is not a Japanese character or a letter leaves the point itself, which is
 * what two items may not share.
 */
export function skillKey(item: QuizItem): string {
  const body = `${item.question ?? ""} ${item.sentence ?? ""}`;
  const marked = /【([^】]+)】/.exec(body)?.[1] ?? "";
  const raw = (item.target ?? item.grammar_point ?? marked ?? "").replace(FURIGANA, "");
  // Where the target names the point in Japanese, the Japanese IS the point
  // and every English word around it is commentary — 「grammar point: 〜てから
  // (sequence)」 and 「〜てから」 are one target with a gloss on it. Stripping a
  // fixed list of scaffolding words could never keep up with the glosses a
  // model invents; keeping only the Japanese does not have to.
  const stripped = raw.toLowerCase().replace(TARGET_NOISE, "");
  const japanese = stripped.replace(
    /[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu,
    "",
  );
  const mixed = stripped.replace(
    /[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}a-z0-9]/gu,
    "",
  );
  // Below three characters the Japanese is not a grammar point, it is a
  // PARTICLE — and 「に with a time」 and 「に with a person」 are two genuinely
  // different questions that both reduce to 「に」. There the English gloss is
  // the only thing telling them apart, so it is kept.
  const key = japanese.length >= 3 ? japanese : mixed;
  // A key with no Japanese in it at all is a CATEGORY, not a point: the model
  // wrote 「kanji discrimination」 on three items and the noise filter left
  // 「discrimination」 on all three. Seen live — three good 待/持-style items
  // dropped as one question because the paper labelled them lazily. Where the
  // label says only what KIND of question this is, the answer says which
  // question, so it joins the key.
  if (key && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(key)) {
    return `${key}|${normalise(item.answer_kana || item.answer)}`;
  }
  // A target that reduced to nothing (an English label made entirely of
  // scaffolding words) falls back to the answer, so the item still has an
  // identity to be compared on rather than colliding with every other empty.
  return key || normalise(item.answer_kana || item.answer);
}

/** What an item tests, in the layers described above. */
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
    skill: skillKey(item),
    comprehension: item.type === "true_false",
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

/** Two items on the same paper that are the same question.
 *
 * Deliberately stricter than `isRepeat`, and deliberately blind to which
 * section each item came from. Both of those are the requirement: a paper may
 * not ask one thing twice, and section boundaries are exactly where a
 * generator hides a repeat — it writes 「毎日、学校へ行きます」 for the
 * particle section and 「毎日、大学へ行きます」 for the word-bank section, and
 * calls them different questions because it wrote a different label on each.
 *
 * Three ways to be the same question:
 *
 *   the same knowledge point, whatever each item called it (skill);
 *   the same sentence with the names and numbers changed (frame ≥
 *     SAME_QUESTION), which is a repeat even when the two items are testing
 *     genuinely different points, because the student is reading the same
 *     line twice;
 *   the pattern-and-frame test `isRepeat` already applies.
 *
 * ○× items are exempt from the frame test and from the skill test: four
 * statements about one passage share a subject, a vocabulary and often a
 * clause, and they are supposed to.
 */
function sameQuestion(item: Fingerprint, prior: Fingerprint): boolean {
  if (prior.exact === item.exact) return true;
  if (item.comprehension || prior.comprehension) return false;
  if (item.skill && prior.skill && item.skill === prior.skill) return true;
  if (!comparableFrames(item, prior)) return false;
  if (similarity(prior.frame, item.frame) >= SAME_QUESTION) return true;
  return prior.pattern === item.pattern && similarity(prior.frame, item.frame) >= SAME_FRAME;
}

/** Placeholders: what the skeleton put in place of a name, a loanword or a
 * number, none of which say anything about what a question tests. */
const PLACEHOLDERS = /[＊＃・]/g;

/** Is there enough sentence here for "these two look alike" to mean anything?
 *
 * There is not, on a section whose items ARE one word. The katakana
 * transcription section asks 「report （　）」, 「computer （　）」, 「coffee
 * （　）」 — every loanword is a Latin run, every Latin run collapses to ＊, and
 * every frame is the single character ＊, which is identical to every other.
 * Measured on a live paper: three of the four items in that section were
 * dropped as "the same sentence as an earlier item", and they were three
 * different words.
 *
 * Four characters of actual content is the bar. The repeat this check exists
 * for — 「リーさんは7時に起きます」 against 「山田さんは9時に起きます」 — keeps
 * five (時おきます) after the name and the number collapse, and a one-word
 * prompt keeps none.
 */
function comparableFrames(item: Fingerprint, prior: Fingerprint): boolean {
  const content = (frame: string) => frame.replace(PLACEHOLDERS, "").length;
  return content(item.frame) >= 4 && content(prior.frame) >= 4;
}

/** Drop every item that repeats something already asked on THIS paper.
 *
 * Runs across the whole paper rather than within a section, which is the
 * whole point — see `sameQuestion`. Sections emptied by it are removed, so
 * the route's length gate sees a paper that only reached its length by
 * repeating itself as the short paper it is and lets the next provider write
 * a better one.
 */
export function dropDuplicates<T extends { sections: { items: QuizItem[] }[] }>(
  quiz: T,
): { quiz: T; removed: number; reasons: string[] } {
  const seen: Fingerprint[] = [];
  const reasons: string[] = [];

  const sections = quiz.sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => {
        const print = fingerprint(item);
        const clash = seen.find((prior) => sameQuestion(print, prior));
        if (clash) {
          reasons.push(
            clash.skill && clash.skill === print.skill
              ? `already drilled ${print.skill.slice(0, 24)}`
              : `same sentence as an earlier item (${item.question.slice(0, 24)})`,
          );
          return false;
        }
        seen.push(print);
        return true;
      }),
    }))
    .filter((section) => section.items.length > 0);

  return { quiz: { ...quiz, sections }, removed: reasons.length, reasons };
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
