/** Course divisions named in a question, and how the books print them.
 *
 * "Topic 14" is the single most useful thing a student can say, and it was
 * the one thing retrieval threw away: the segmenter splits it into "topic"
 * and "14", the number is too short to survive the token filter, and "topic"
 * on its own matches the running header of every page in every book. So a
 * question naming an exact division searched the corpus for nothing in
 * particular, and the answer came back "that is in Foundation 3, go and look
 * it up" — about a book the app has read.
 *
 * The books do print the division on the page. Measured on the live corpus:
 * the Foundation 3 book prints 「トピック 14」 with a space (pp. 53–57 for
 * Topic 14, including its vocabulary page), the Latin "Topic 14" appears
 * only on the contents page, and the Intermediate volumes use 第N課. Looking
 * for what is actually printed is what turns "Topic 14" into pages.
 */

export interface TopicRef {
  /** Canonical marker, matching how discover.py files handouts: T14. */
  marker: string;
  number: number;
  kind: "topic" | "lesson";
}

const TOPIC_RE =
  /(?:topics?|トピック|unit)\s*[#:]?\s*([0-9０-９]{1,2})|(?<![A-Za-z0-9])[Tt]\s?([0-9]{1,2})(?![0-9])/gi;
const LESSON_RE =
  /(?:lessons?|レッスン)\s*[#:]?\s*([0-9０-９]{1,2})|第\s*([0-9０-９]{1,2})\s*課|(?<![A-Za-z0-9])[Ll]\s?([0-9]{1,2})(?![0-9])/gi;

function toNumber(digits: string): number {
  return Number(digits.replace(/[０-９]/g, (d) => String("０１２３４５６７８９".indexOf(d))));
}

/** Every division the text names, newest mention first. */
export function topicRefs(text: string, limit = 3): TopicRef[] {
  const found: TopicRef[] = [];

  for (const match of text.matchAll(TOPIC_RE)) {
    const digits = match[1] ?? match[2];
    if (digits) found.push({ marker: `T${toNumber(digits)}`, number: toNumber(digits), kind: "topic" });
  }
  for (const match of text.matchAll(LESSON_RE)) {
    const digits = match[1] ?? match[2] ?? match[3];
    if (digits) found.push({ marker: `T${toNumber(digits)}`, number: toNumber(digits), kind: "lesson" });
  }

  const seen = new Set<string>();
  return found
    .filter((ref) => ref.number >= 1 && ref.number <= 30)
    .filter((ref) => {
      const key = `${ref.kind}:${ref.number}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

/** How that division appears on a page, in every spelling the corpus uses. */
export function printedForms(ref: TopicRef): string[] {
  const { number } = ref;
  return ref.kind === "lesson"
    ? [`第${number}課`, `第 ${number} 課`, `Lesson ${number}`, `レッスン ${number}`]
    : [`トピック ${number}`, `トピック${number}`, `Topic ${number}`, `T${number}`];
}

/** What the student wants FROM that division: the vocabulary, the kanji, the
 * grammar. A topic spans a dozen pages, and this is what decides which of
 * them is worth handing to the model. */
export interface Aspect {
  /** Words whose presence in a chunk means it is the part they asked for. */
  terms: string[];
  label: string;
}

const ASPECTS: { match: RegExp; aspect: Aspect }[] = [
  // Kanji is tested BEFORE vocabulary, and the order is the whole point.
  // "list the Topic 7 kanji vocab" names both, and the first pattern to match
  // used to be the vocabulary one — so the student asking for the kanji got
  // the aspect "vocabulary", whose terms (語彙, 新しい語彙) are printed over
  // the front half's word lists. The answer came back built from the pages
  // that have no kanji list on them, reporting that the topic has none.
  //
  // Kanji wins because it is the more specific ask and because the books
  // agree: the section that teaches a topic's kanji is itself titled
  // 「漢字・語彙練習」 — Kanji AND Vocabulary. A student who says both means
  // that section. "vocabulary" alone still lands on vocabulary, which is the
  // front half's 新しい語彙 and the right answer for it.
  {
    match: /kanji|漢字|reading of|読み方/i,
    aspect: { label: "kanji", terms: ["漢字", "kanji", "読み方"] },
  },
  {
    match: /vocab|vocabular|word list|語彙|ごい|単語|たんご/i,
    aspect: { label: "vocabulary", terms: ["語彙", "新しい語彙", "vocabulary", "単語"] },
  },
  {
    match: /grammar|文法|pattern|conjugat|活用/i,
    aspect: { label: "grammar", terms: ["文法", "grammar", "活用"] },
  },
  {
    match: /reading|読み物|passage|本文/i,
    aspect: { label: "reading", terms: ["読み物", "本文", "reading"] },
  },
];

export function aspectOf(text: string): Aspect | null {
  return ASPECTS.find(({ match }) => match.test(text))?.aspect ?? null;
}

/** Which half of the book the student is asking for, when they said.
 *
 * Only kanji names a half unambiguously. "vocabulary" does not: the front
 * half prints 新しい語彙 for every topic and the back half is titled
 * 漢字・語彙練習, so both are honestly vocabulary and the ranking is left to
 * decide on the words themselves. Grammar and reading are front-half asks —
 * the back half has no grammar explanations and no 読み物.
 */
export function sectionForAspect(aspect: Aspect | null): "grammar" | "kanji" | null {
  if (!aspect) return null;
  if (aspect.label === "kanji") return "kanji";
  if (aspect.label === "grammar" || aspect.label === "reading") return "grammar";
  return null;
}

/** One POSIX pattern matching every spelling of a division, and nothing else.
 *
 * `printedForms` above is the list of spellings, and searching for each of
 * them with ILIKE is what retrieval used to do. ILIKE has no word boundary,
 * and the books number their topics past nine, so `%Topic 1%` also matched
 * Topic 10 through Topic 20. Measured on the live corpus: 304 chunks matched
 * the Topic 1 forms and 26 of them were Topic 1 — and on Foundation 3, which
 * carries topics 11-20, every single chunk matching 「トピック 1」 belonged to
 * a different topic. A student asking about Topic 1 was shown Topic 14.
 *
 * It also starved the kanji half twice over: the wrong-topic rows filled the
 * row budget before the right ones were read. With the guards below the worst
 * case across every division in the corpus is 36 candidate chunks, so the
 * budget now holds all of them and the choice is made by ranking rather than
 * by which page the database happened to reach first.
 *
 * Guards on both sides, written as character classes because Postgres
 * regexes have no lookaround: a trailing non-digit so Topic 1 is not Topic
 * 10, and a leading non-alphanumeric so the bare `T7` form is not the tail of
 * some other token. The ` ?` also picks up the un-spaced 「Topic7」 and
 * 「トピック7」 that the books use on their contents pages, which the spaced
 * forms missed.
 */
export function divisionPattern(ref: TopicRef): string {
  const { number } = ref;
  const forms =
    ref.kind === "lesson"
      ? [`第 ?${number} ?課`, `Lesson ?${number}`, `レッスン ?${number}`]
      : [`トピック ?${number}`, `Topic ?${number}`, `T${number}`];
  return `(^|[^A-Za-z0-9])(${forms.join("|")})([^0-9]|$)`;
}
