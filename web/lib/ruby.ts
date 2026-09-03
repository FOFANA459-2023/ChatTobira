/** Furigana splitting, shared by everything that renders Japanese.
 *
 * Lives on its own because both halves of the app need it and neither owns
 * it: the practice paper prints readings above kanji, and so does a chat
 * answer. `lib/quiz.ts` re-exports it for the callers that found it there
 * first.
 */

const KANJI_RE = /[一-鿿々〆ヶ]/;
const KANA_RE = /[ぁ-ゖァ-ヶー]/;
/** A reading in either bracket style. The prompt asks for （ ）, but the
 * transcribed corpus writes 《 》 and models imitate what they read. */
const READING_RE = /（([ぁ-ゖァ-ヶー]+)）|《([ぁ-ゖァ-ヶー]+)》/g;

/** How far left of the bracket a word may reach. Longer than any single word
 * in this corpus, and it keeps a stray bracket from scanning a whole line. */
const MAX_BASE_CHARS = 12;

const isKanji = (char: string) => KANJI_RE.test(char);
const isKana = (char: string) => KANA_RE.test(char);

function kanaOf(text: string): string {
  return [...text].filter(isKana).join("");
}

function leadingKana(text: string): string {
  const match = /^[ぁ-ゖァ-ヶー]+/.exec(text);
  return match ? match[0] : "";
}

/** Are `needle`'s characters found in `hay`, in order? This is what says
 * whether kana sitting between a word's kanji is okurigana the reading
 * accounts for (持って来る against もってくる) or a particle that belongs to
 * the sentence instead (本を読む against よむ — を is nowhere in the
 * reading, so the word being annotated is 読む, not 本を読む). */
function isSubsequence(needle: string, hay: string): boolean {
  let at = 0;
  for (const char of needle) {
    at = hay.indexOf(char, at) + 1;
    if (at === 0) return false;
  }
  return true;
}

/** Where the word carrying `reading` starts, searching left from its bracket.
 *
 * Grows one character at a time and keeps the LONGEST run that could be one
 * word: kanji always extend it, kana only while the reading still explains
 * them. A run is usable once it holds a kanji and either starts with one or
 * opens with kana the reading itself opens with (き色 against きいろ).
 * Returns -1 when nothing to the left is a word, so the brackets stay as the
 * literal text they are.
 */
function baseStart(text: string, bracket: number, floor: number, reading: string): number {
  let best = -1;
  let start = bracket;

  while (start > floor && bracket - start < MAX_BASE_CHARS) {
    const char = text[start - 1];
    if (!isKanji(char) && !isKana(char)) break;
    if (isKana(char) && !isSubsequence(kanaOf(text.slice(start - 1, bracket)), reading)) break;

    start -= 1;
    const candidate = text.slice(start, bracket);
    if (!KANJI_RE.test(candidate)) continue;

    const lead = leadingKana(candidate);
    if (lead === "" || reading.startsWith(lead)) best = start;
  }

  return best;
}

export interface RubySegment {
  base: string;
  reading?: string;
}

/** Split text into ruby segments: a word followed by its kana reading in
 * 漢字（かんじ） or 漢字《かんじ》 style becomes a base+reading pair for
 * <ruby> rendering, which puts the hiragana on top of the kanji the way the
 * textbook prints it.
 *
 * The reading is written for the whole word — 急ぐ（いそぐ）, き色（きいろ）,
 * which is how the prompt asks for it and how a reader would say it — and the
 * kana the word and its reading share are peeled back off both ends, so what
 * ends up above the kanji is the part only the kanji spells: 急（いそ）ぐ.
 *
 * Brackets holding anything but kana (the （　）answer blank, a bracketed
 * kanji) and brackets with no word in front of them pass through untouched.
 */
export function splitRuby(text: string): RubySegment[] {
  const segments: RubySegment[] = [];
  let last = 0;

  const plain = (value: string) => {
    if (!value) return;
    // Keep runs of unannotated text as one segment rather than one per gap.
    const previous = segments.at(-1);
    if (previous && previous.reading === undefined) previous.base += value;
    else segments.push({ base: value });
  };

  for (const match of text.matchAll(READING_RE)) {
    const reading = match[1] ?? match[2];
    const bracket = match.index;

    // A reading that merely repeats the kana word in front of it — 〜ておく
    // （ておく） — annotates nothing. The prompt asks models not to write
    // those, and when one does anyway the brackets are noise on the page
    // rather than a reading, so they come off.
    if (bracket - reading.length >= last && text.slice(bracket - reading.length, bracket) === reading) {
      plain(text.slice(last, bracket));
      last = bracket + match[0].length;
      continue;
    }

    const start = baseStart(text, bracket, last, reading);
    if (start < 0) continue;

    let base = text.slice(start, bracket);
    let above = reading;
    let head = "";
    let tail = "";

    // Kana the word and its reading share read themselves: they belong beside
    // the kanji, not above it.
    while (base && isKana(base[0]) && base[0] === above[0]) {
      head += base[0];
      base = base.slice(1);
      above = above.slice(1);
    }
    while (base && isKana(base.at(-1)!) && base.at(-1) === above.at(-1)) {
      tail = base.at(-1)! + tail;
      base = base.slice(0, -1);
      above = above.slice(0, -1);
    }

    plain(text.slice(last, start));
    if (base && above) {
      plain(head);
      segments.push({ base, reading: above });
      plain(tail);
    } else {
      // The reading turned out to be the word spelled out again; there is
      // nothing left to annotate.
      plain(`${head}${base}${tail}`);
    }
    last = bracket + match[0].length;
  }

  plain(text.slice(last));
  return segments.length > 0 ? segments : [{ base: text }];
}
