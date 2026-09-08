/** What the textbook actually says, as opposed to what Japanese allows.
 *
 * A generated paper can be grammatical, level-appropriate, drawn from the
 * right topic and still read wrong to the student sitting it, because the
 * course teaches ONE of several correct ways to say a thing and the model
 * reaches for whichever is commonest on the internet. Measured over the
 * ingested corpus, with furigana stripped:
 *
 *   Foundation 1 & 2 book   じゃない 11   じゃありません 9   ではありません 1
 *   Foundation 3 book       ことができます 9   られます 11
 *   both books              友達 52/69   友だち 2/2   ともだち 4/1
 *   Foundation 1 & 2 book   時 185   とき 14
 *   Foundation 3 book       時 147   とき 84
 *
 * ではありません is correct Japanese and appears once in 263,000 characters of
 * the book a Foundation 2 student owns. A paper that drills it is testing
 * something the course does not teach, and the student cannot check it against
 * anything they have. The same goes the other way: a Foundation 3 paper
 * written with ことができます everywhere misses that by Topic 11 the book has
 * moved to the potential form.
 *
 * So the preference is not hard-coded here — only the QUESTIONS are. Each
 * entry below is a set of forms that mean the same thing and compete for the
 * same slot; the counting happens against the chunks actually retrieved for
 * the paper, and what comes out is this book's answer, with its evidence. If
 * a book uses both evenly, nothing is said: an even split is not a house
 * style, and inventing one would be worse than saying nothing.
 *
 * The counts are read off the same chunk pool the questions are drawn from,
 * which is the whole point — this is the textbook grounding the wording, not
 * a style guide somebody wrote down.
 */

/** A set of interchangeable forms, of which this course prefers one. */
export interface VariantSet {
  id: string;
  /** What the choice is, in English, for the prompt line. */
  about: string;
  /** The competing spellings or forms. Order does not matter. */
  forms: string[];
  /** Forms that are substrings of a longer form in the same set and must not
   * be double-counted: じゃない is inside じゃないです, 時 is inside 時々. */
  swallowedBy?: Record<string, string[]>;
  /** Whether an item using the wrong form here is DROPPED, or merely written
   * around by the prompt.
   *
   * Only the grammatical alternations are enforced. Getting one of those
   * wrong puts a construction on the paper that the course has not taught —
   * ではありません on a Foundation 2 paper, なくてはいけません where the book
   * settles on なければなりません — and the student has nothing to check it
   * against.
   *
   * The orthographic ones are not enforced, and the reason is a measurement:
   * the Foundation 1 & 2 book writes 友達 fifty-two times, almost all of them
   * in the kanji lists for its later topics, while the course's own Topic 1–7
   * papers write 友だち. Enforcing the book-wide count would have rejected the
   * spelling the real papers use. A model still gets told which the book
   * prefers — that is worth having — but a spelling a student will read
   * correctly either way is not worth throwing a question away over. */
  enforce?: boolean;
}

/** The alternations worth asking about.
 *
 * Chosen on one test: could a student open the book, look for this, and find
 * the app had written the other one? Orthographic pairs (漢字 against kana)
 * and the polite-negative family account for nearly every case where a
 * generated sentence reads as "not from this course".
 */
export const VARIANTS: VariantSet[] = [
  {
    id: "negative-copula",
    enforce: true,
    about: "the negative of です",
    forms: ["じゃありません", "じゃないです", "じゃない", "ではありません", "ではないです"],
    swallowedBy: {
      じゃない: ["じゃないです"],
      ではない: ["ではないです"],
    },
  },
  {
    id: "negative-past-copula",
    enforce: true,
    about: "the past negative of です",
    forms: ["じゃありませんでした", "じゃなかったです", "ではありませんでした"],
  },
  {
    id: "potential",
    enforce: true,
    about: "expressing ability",
    forms: ["ことができます", "ことができる"],
  },
  {
    id: "obligation",
    enforce: true,
    about: "expressing obligation",
    forms: ["なければなりません", "なくてはいけません", "ないといけません", "なきゃ"],
  },
  {
    id: "friend",
    about: "the word for friend",
    forms: ["友達", "友だち", "ともだち"],
  },
  {
    id: "first-person",
    about: "the first-person pronoun",
    forms: ["私", "わたし"],
  },
  // Deliberately NOT here: とき against 時. Counting them as one alternation
  // measured the wrong thing — 「3時」 and 「行くとき」 are two different words
  // sharing a character, and the Foundation book's 102 instances of 時 are
  // almost all o'clock. A variant set that conflates two words produces a
  // confident instruction to write the wrong one.
  {
    id: "please",
    about: "the ください of a request",
    forms: ["ください", "下さい"],
  },
  {
    id: "a-lot",
    about: "the word for a lot",
    forms: ["たくさん", "沢山"],
  },
  {
    id: "pretty",
    about: "the adjective きれい",
    forms: ["きれい", "綺麗"],
  },
  {
    id: "fine",
    about: "the word for all right",
    forms: ["だいじょうぶ", "大丈夫"],
  },
  {
    id: "can-do",
    about: "the verb できます",
    forms: ["できます", "出来ます"],
  },
  {
    id: "a-little",
    about: "the word for a little",
    forms: ["すこし", "少し", "ちょっと"],
  },
  {
    id: "very",
    about: "the intensifier",
    forms: ["とても", "たいへん", "すごく"],
  },
  {
    id: "prohibition",
    enforce: true,
    about: "expressing prohibition",
    forms: ["てはいけません", "ないでください", "てはだめです"],
  },
];

export interface VariantPreference {
  id: string;
  about: string;
  /** The forms this material actually uses. More than one when the book uses
   * both — the Foundation 1 & 2 book writes じゃありません nine times and
   * じゃないです eight, and picking a winner between those would be inventing
   * a rule rather than reporting one. */
  prefer: string[];
  /** Forms this material has all but no instance of, which a generated paper
   * must therefore not reach for. */
  avoid: string[];
  counts: Record<string, number>;
  /** Whether an item using an `avoid` form here is dropped or merely
   * discouraged — see VariantSet.enforce. */
  enforce: boolean;
  /** Whether the counts come from the excerpts the paper is drawn from, or
   * from the whole book because the excerpts were too thin to say. */
  from: "excerpts" | "book";
}

export type HouseStyle = VariantPreference[];

/** Readings, which are annotation rather than text, and would otherwise let a
 * kanji spelling count as a kana one. */
const FURIGANA = /《[^》]*》|<rt>[^<]*<\/rt>/g;

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

function countForms(corpus: string, variant: VariantSet): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const form of variant.forms) {
    // A shorter form nested inside a longer one in the same set is counted
    // once, for the longer: じゃないです contains じゃない, and counting both
    // would report a preference for the form that never stood alone.
    const swallowers = variant.swallowedBy?.[form] ?? [];
    const nested = swallowers.reduce((n, longer) => n + occurrences(corpus, longer), 0);
    counts[form] = Math.max(0, occurrences(corpus, form) - nested);
  }
  return counts;
}

/** Which form of each alternation this material uses.
 *
 * Counted over the EXCERPTS the paper is being written from, falling back per
 * alternation to the whole book when the excerpts are too thin to say
 * anything. Scope matters more here than sample size: the Foundation 1 & 2
 * book spans Topics 1 to 10 and writes 友達 fifty-two times, almost all of
 * them in the kanji section for the later topics, while a Topic 2 page writes
 * ともだち — so a Topic 2 paper told "this book writes 友達" would be told
 * something true about the book and wrong about the topic.
 *
 * What comes back is deliberately two-sided and asymmetric:
 *
 *   prefer  every form the material genuinely uses. Often more than one, and
 *           saying so is the honest answer — the Foundation book writes
 *           じゃありません nine times and じゃないです eight, and a generator
 *           told to pick one of those would be following a rule this course
 *           does not have.
 *   avoid   forms with all but no instances against a form that has many.
 *           This is the side that does the work. ではありません is correct
 *           Japanese, appears once in 253,000 characters, and is exactly what
 *           a model reaches for when nobody tells it not to.
 *
 * `floor` is why avoid is safe: a form needs to be beaten eight to one before
 * it is called absent, so a form the book uses five times against thirty-three
 * (たいへん against とても) stays allowed. Both numbers were set by running
 * this over all four ingested books and reading what it claimed.
 */
export function houseStyle(
  texts: string[],
  fallbackTexts: string[] = [],
  { minTotal = 6, floor = 8, near = 2 }: { minTotal?: number; floor?: number; near?: number } = {},
): HouseStyle {
  const excerpts = texts.join("\n").replace(FURIGANA, "");
  const book = fallbackTexts.join("\n").replace(FURIGANA, "");
  const style: HouseStyle = [];

  for (const variant of VARIANTS) {
    let counts = countForms(excerpts, variant);
    let from: VariantPreference["from"] = "excerpts";
    let total = Object.values(counts).reduce((n, value) => n + value, 0);
    if (total < minTotal && book) {
      counts = countForms(book, variant);
      from = "book";
      total = Object.values(counts).reduce((n, value) => n + value, 0);
    }

    const ranked = variant.forms
      .map((form) => ({ form, n: counts[form] }))
      .sort((a, b) => b.n - a.n);
    if (total < minTotal || ranked[0].n === 0) continue;

    const leader = ranked[0].n;
    const prefer = ranked.filter((entry) => entry.n * near >= leader).map((entry) => entry.form);
    const avoid = ranked
      .filter((entry) => !prefer.includes(entry.form) && entry.n * floor <= leader)
      .map((entry) => entry.form);
    // Nothing to say: the material uses every form in the set often enough
    // that none of them would look foreign on a paper.
    if (avoid.length === 0) continue;

    style.push({
      id: variant.id,
      about: variant.about,
      prefer,
      avoid,
      counts,
      enforce: Boolean(variant.enforce),
      from,
    });
  }

  return style;
}

/** The house-style block for the prompt, or "" when the material said nothing
 * decisive. Silence is the right output for a thin sample: a rule invented
 * from six chunks is a rule the book does not have. */
export function houseStyleBlock(style: HouseStyle): string {
  if (style.length === 0) return "";
  const lines = style.map((entry) => {
    const used = entry.prefer
      .map((form) => `${form} (${entry.counts[form]}×)`)
      .join(" or ");
    const absent = entry.avoid
      .map((form) => `${form} ${entry.counts[form] === 0 ? "never" : `only ${entry.counts[form]}×`}`)
      .join(", ");
    return `- ${entry.about}: this material writes ${used}. Never write ${absent}.`;
  });
  return `=== HOW THIS BOOK WRITES (counted in the excerpts' own book) ===
These are not style preferences, they are measurements of the book the student
owns. Where two ways of saying something are both correct Japanese, this course
uses one of them, and a paper that uses the other is testing something the
student cannot look up.
${lines.join("\n")}`;
}

/** Forms an item uses that this material does not.
 *
 * `enforcedOnly` is the difference between a rule and a preference. The
 * validator passes it, so only a grammatical form the course has not taught
 * costs an item its place; a report can pass false and see everything,
 * spelling included.
 */
export function offStyleForms(
  text: string,
  style: HouseStyle,
  { enforcedOnly = false }: { enforcedOnly?: boolean } = {},
): string[] {
  const clean = text.replace(FURIGANA, "");
  const found: string[] = [];
  for (const entry of style) {
    if (enforcedOnly && !entry.enforce) continue;
    for (const form of entry.avoid) {
      // 「ではありません」 contains 「ではありません」 and nothing else in the
      // set; the nesting rule that matters at counting time does not apply
      // here, because a hit on the long form is a hit on the long form.
      if (clean.includes(form) && !found.includes(form)) found.push(form);
    }
  }
  return found;
}

/* ------------------------------------------------------------------------ */
/* Attestation: the characters and words the course has actually taught       */
/* ------------------------------------------------------------------------ */

const KANJI = /[一-鿿]/gu;
const KATAKANA_WORD = /[ァ-ヶー]{2,}/gu;

/** Every kanji character the material contains.
 *
 * The cheapest honest grounding check there is. "Never a character the course
 * has not taught" has been in the distractor rules from the start as an
 * instruction, and an instruction is not a guarantee: a Foundation 2 paper
 * came back drilling 徒歩, which is a perfectly ordinary word and is not in
 * the Foundation 1 & 2 book. A student cannot revise from a paper that tests
 * characters their book does not contain, and cannot tell that is what
 * happened — it just looks like something they failed to learn.
 */
export function attestedKanji(texts: string[]): Set<string> {
  const set = new Set<string>();
  for (const text of texts) {
    for (const char of text.replace(FURIGANA, "").matchAll(KANJI)) set.add(char[0]);
  }
  return set;
}

/** Every katakana word of two or more characters the material contains. */
export function attestedKatakana(texts: string[]): Set<string> {
  const set = new Set<string>();
  for (const text of texts) {
    for (const word of text.replace(FURIGANA, "").matchAll(KATAKANA_WORD)) set.add(word[0]);
  }
  return set;
}

export interface Attestation {
  kanji: Set<string>;
  katakana: Set<string>;
}

export function attestation(texts: string[]): Attestation {
  return { kanji: attestedKanji(texts), katakana: attestedKatakana(texts) };
}

/** Kanji in this text that the material never uses.
 *
 * Furigana is stripped first — a reading is annotation. The set is compared
 * character by character rather than word by word on purpose: word-level
 * matching needs a segmenter and would reject 図書館 because the book writes
 * 図書館《としょかん》 with the reading attached, while character matching is
 * exact and cannot be argued with.
 */
export function unattestedKanji(text: string, attested: Set<string>): string[] {
  const clean = text.replace(FURIGANA, "");
  const missing = new Set<string>();
  for (const char of clean.matchAll(KANJI)) {
    if (!attested.has(char[0])) missing.add(char[0]);
  }
  return [...missing];
}

/** How much of a paper's kanji the material accounts for — 1 is fully
 * grounded. Reported by the harness rather than enforced, because a single
 * unattested character is a bad item and a whole paper of them is a bad
 * retrieval, and the two want different fixes. */
export function groundingScore(texts: string[], attested: Set<string>): number {
  let seen = 0;
  let known = 0;
  for (const text of texts) {
    for (const char of text.replace(FURIGANA, "").matchAll(KANJI)) {
      seen += 1;
      if (attested.has(char[0])) known += 1;
    }
  }
  return seen === 0 ? 1 : known / seen;
}
