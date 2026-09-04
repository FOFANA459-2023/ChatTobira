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
  {
    match: /vocab|vocabular|word list|語彙|ごい|単語|たんご/i,
    aspect: { label: "vocabulary", terms: ["語彙", "新しい語彙", "vocabulary", "単語"] },
  },
  {
    match: /kanji|漢字|reading of|読み方/i,
    aspect: { label: "kanji", terms: ["漢字", "kanji", "読み方"] },
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
