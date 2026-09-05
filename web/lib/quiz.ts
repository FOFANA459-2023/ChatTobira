import { z } from "zod";

/** Re-exported: callers found furigana splitting here before the chat
 * renderer needed it too, and the practice paper is still its loudest user. */
export { splitRuby } from "./ruby";

/** One generated test item. answer is authoritative; the client grades.
 * true_false is the reading section's ○×: question is a statement about the
 * section's passage and answer is exactly ○ or ×. */
export const QuizItemSchema = z.object({
  type: z.enum(["multiple_choice", "fill_blank", "true_false"]),
  question: z.string().min(1),
  // Japanese text of the sentence being drilled, when distinct from question.
  sentence: z.string().optional(),
  // 2–5, not a fixed 4. The sat papers print two options inside a bracket
  // (「はやい ( 早い / 速い )」), three under an a〜c list, four under a〜d,
  // and five for the kana-identification items. A schema that demanded four
  // forced every question into a shape the course does not use.
  choices: z.array(z.string()).min(2).max(5).optional(),
  answer: z.string().min(1),
  // The answer written entirely in hiragana, when answer contains kanji.
  // Grading accepts either script — see isCorrect.
  answer_kana: z.string().optional(),
  explanation: z.string().min(1),
  // Where in the course material to study this point: the topic or lesson as
  // printed in the textbook, with the book page when the material shows one.
  // Shown with the explanation and aggregated into the post-test study plan.
  review: z.string().min(1),
  grammar_point: z.string().optional(),
  // What this item is FOR, in the generator's own words: the grammar pattern
  // or the kanji word being tested. It is the axis the duplicate check turns
  // on — two questions drilling 〜ながら with different nouns are the same
  // question — and it is what validation checks the item actually exercises.
  target: z.string().optional(),
});

/** One 問題 (numbered section) of the paper, mirroring the course review
 * sheets: a Japanese instruction line like 適切なことばを選んでください,
 * its English translation, and the items drilled under it. */
export const QuizSectionSchema = z.object({
  instruction_ja: z.string().min(1),
  instruction_en: z.string().min(1),
  /** How this section is answered, from the paper-format catalogue. Decides
   * how the section renders and which validity rules apply to its items. */
  form: z.enum(["bracket", "lettered", "written", "maru_batsu"]).optional(),
  /** The shared list of words a word-bank section draws on, printed in a box
   * under the items exactly as the papers print it. Each may be used once,
   * which is a rule the paper states and the validator enforces. */
  word_bank: z.array(z.string()).max(14).optional(),
  /** Marks per item, printed beside the instruction as (1×5) or (2点×5). */
  marks: z.number().int().min(1).max(3).optional(),
  // Reading sections carry the short passage their ○× statements are about,
  // rendered above the items in the style of the printed papers.
  passage: z.string().optional(),
  items: z.array(QuizItemSchema).min(1).max(8),
});

export const QuizSchema = z.object({
  // 1–2 sentences telling the student what the test covers — the grammar
  // points or vocabulary drilled and where they sit in the course.
  scope_description: z.string().min(1),
  sections: z.array(QuizSectionSchema).min(1).max(5),
});

export type QuizItem = z.infer<typeof QuizItemSchema>;
export type QuizSection = z.infer<typeof QuizSectionSchema>;
export type Quiz = z.infer<typeof QuizSchema>;

/** The two test types students sit: 文法 and 文字・語彙. */
export type QuizKind = "grammar" | "kanji";

/** Items in paper order; answer indices are positions in this list. */
export function flattenItems(quiz: Quiz): QuizItem[] {
  return quiz.sections.flatMap((section) => section.items);
}

/** What an item drills, in the forms two items could collide on.
 *
 * The prompt asks for a different point in every question, and a generator
 * asked for 20 items from 10 excerpts sometimes obliges by drilling 食べる
 * twice with the sentence reworded. Text alone cannot be the whole test for
 * that: the same word arrives as 短い in the section that asks its reading
 * and みじかい in the section that asks it written, so the answer is part of
 * the identity too.
 *
 * Which parts count depends on the paper. On a kanji paper a word may appear
 * once, full stop — its reading and its spelling are the same word being
 * tested twice. On a grammar paper the ANSWER is often a particle, and に is
 * the correct answer to plenty of genuinely different questions, so answers
 * are excluded there or half the paper would collide with itself.
 */
export function itemSignatures(item: QuizItem, kind: QuizKind): string[] {
  const key = (value: string) => normalizeAnswer(stripReadings(value));
  const signatures: string[] = [];

  const question = item.question ?? "";
  const sentence = item.sentence ?? "";

  // The word an item points at, wherever it was marked. On a kanji paper it
  // shares a namespace with the answers below, because a word MARKED in the
  // section that asks its reading and the same word GIVEN as the answer in
  // the section that asks its spelling are one word tested twice — which is
  // the repeat that paper forbids.
  const marked = kind === "kanji" ? "word" : "target";
  for (const source of [question, sentence]) {
    for (const match of source.matchAll(/【([^】]+)】/g)) {
      const target = key(match[1]);
      if (target) signatures.push(`${marked}:${target}`);
    }
  }

  // The wording itself, with the markers stripped so a question is not
  // "different" merely because the underline moved.
  const asked = key(question.replace(/[【】]/g, ""));
  if (asked) signatures.push(`asked:${asked}`);
  const drilled = key(sentence.replace(/[【】]/g, ""));
  if (drilled) signatures.push(`sentence:${drilled}`);

  if (kind === "kanji") {
    for (const form of [item.answer, item.answer_kana]) {
      const word = form ? key(form) : "";
      if (word) signatures.push(`word:${word}`);
    }
  }

  return signatures;
}

/** Drop items that repeat something already drilled earlier in the paper,
 * and any section left empty by that.
 *
 * Enforced here rather than trusted to the prompt: "never ask the same thing
 * twice" is exactly the kind of instruction a model follows nineteen times
 * out of twenty, and the twentieth is a student sitting the same question in
 * sections I and III and losing faith in the paper. Reading-section items are
 * kept as-is beyond exact repeats — five ○× statements about one passage are
 * SUPPOSED to share their subject.
 */
export function dedupeQuiz(quiz: Quiz, kind: QuizKind): { quiz: Quiz; removed: number } {
  const seen = new Set<string>();
  let removed = 0;

  const sections = quiz.sections
    .map((section) => {
      const items = section.items.filter((item) => {
        const signatures = itemSignatures(item, kind);
        if (signatures.some((signature) => seen.has(signature))) {
          removed += 1;
          return false;
        }
        for (const signature of signatures) seen.add(signature);
        return true;
      });
      return { ...section, items };
    })
    .filter((section) => section.items.length > 0);

  return { quiz: { ...quiz, sections }, removed };
}

export function scoreQuiz(
  quiz: Quiz,
  answers: Record<number, string>,
): { correct: number; total: number } {
  const items = flattenItems(quiz);
  const correct = items.filter((item, i) => isCorrect(item, answers[i] ?? "")).length;
  return { correct, total: items.length };
}

/** Normalise a Japanese answer for comparison.

 * Students type the same answer many ways: full-width vs half-width, stray
 * whitespace, trailing punctuation. Grading must not mark 食べます。 wrong
 * against 食べます.
 */
export function normalizeAnswer(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\s　]+/g, "")
    .replace(/[。、．，.,!?！？]+$/g, "")
    .toLowerCase();
}

/** Strip furigana readings from an answer: 食べます（たべます）,
 * 食べます(たべます), or the transcript style 食《た》べます all reduce to
 * 食べます. Only kana inside the brackets is treated as a reading — bracketed
 * kanji is content, not furigana. */
function stripReadings(text: string): string {
  return text.replace(/[（(][ぁ-ゖャ-ンゝゞー]+[）)]/g, "").replace(/《[^》]*》/g, "");
}

// Hepburn and kunrei spellings side by side: students are taught Hepburn but
// type what their keyboard IME trained them to (si, tu, zi …). Longest first.
const ROMAJI: Record<string, string> = {
  kya: "きゃ", kyu: "きゅ", kyo: "きょ", gya: "ぎゃ", gyu: "ぎゅ", gyo: "ぎょ",
  sha: "しゃ", shu: "しゅ", sho: "しょ", sya: "しゃ", syu: "しゅ", syo: "しょ",
  cha: "ちゃ", chu: "ちゅ", cho: "ちょ", tya: "ちゃ", tyu: "ちゅ", tyo: "ちょ",
  nya: "にゃ", nyu: "にゅ", nyo: "にょ", hya: "ひゃ", hyu: "ひゅ", hyo: "ひょ",
  mya: "みゃ", myu: "みゅ", myo: "みょ", rya: "りゃ", ryu: "りゅ", ryo: "りょ",
  bya: "びゃ", byu: "びゅ", byo: "びょ", pya: "ぴゃ", pyu: "ぴゅ", pyo: "ぴょ",
  ja: "じゃ", ju: "じゅ", jo: "じょ", zya: "じゃ", zyu: "じゅ", zyo: "じょ",
  shi: "し", chi: "ち", tsu: "つ",
  ka: "か", ki: "き", ku: "く", ke: "け", ko: "こ",
  ga: "が", gi: "ぎ", gu: "ぐ", ge: "げ", go: "ご",
  sa: "さ", si: "し", su: "す", se: "せ", so: "そ",
  za: "ざ", ji: "じ", zi: "じ", zu: "ず", ze: "ぜ", zo: "ぞ",
  ta: "た", ti: "ち", tu: "つ", te: "て", to: "と",
  da: "だ", di: "ぢ", du: "づ", de: "で", do: "ど",
  na: "な", ni: "に", nu: "ぬ", ne: "ね", no: "の",
  ha: "は", hi: "ひ", fu: "ふ", hu: "ふ", he: "へ", ho: "ほ",
  ba: "ば", bi: "び", bu: "ぶ", be: "べ", bo: "ぼ",
  pa: "ぱ", pi: "ぴ", pu: "ぷ", pe: "ぺ", po: "ぽ",
  ma: "ま", mi: "み", mu: "む", me: "め", mo: "も",
  ya: "や", yu: "ゆ", yo: "よ", ra: "ら", ri: "り", ru: "る", re: "れ", ro: "ろ",
  wa: "わ", wo: "を", a: "あ", i: "い", u: "う", e: "え", o: "お",
};

/** Convert a romaji answer to hiragana, or null when the text is not romaji
 * this converter fully understands. Null means "grade the raw text instead",
 * never "mark it wrong" — an unconvertible answer can still match answer as
 * typed. */
export function romajiToHiragana(input: string): string | null {
  const text = input.toLowerCase().replace(/[\s\-–ー]+/g, "");
  if (text.length === 0 || !/^[a-z']+$/.test(text)) return null;

  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];

    // ん is the ambiguous one. n' is always ん alone. A trailing "nn" is the
    // IME habit for final ん (tabemasenn). A mid-word "nn" is Hepburn's
    // ん + syllable-initial n (konnichiwa = こん+にちわ), so only the first n
    // is consumed. Otherwise n before a non-vowel/non-y or at the end is ん,
    // and Hepburn writes it as m before b/m/p (shimbun).
    if (c === "n" && next === "'") {
      out += "ん";
      i += 2;
      continue;
    }
    if (c === "n" && next === "n" && i + 2 === text.length) {
      out += "ん";
      i += 2;
      continue;
    }
    if (c === "n" && (next === undefined || !"aiueoy".includes(next))) {
      out += "ん";
      i += 1;
      continue;
    }
    if (c === "m" && next !== undefined && "bmp".includes(next)) {
      out += "ん";
      i += 1;
      continue;
    }

    // Small っ: doubled consonant (kitte), or Hepburn's t-before-ch (matcha).
    if (!"aiueon".includes(c) && (next === c || (c === "t" && next === "c"))) {
      out += "っ";
      i += 1;
      continue;
    }

    const three = ROMAJI[text.slice(i, i + 3)];
    const two = ROMAJI[text.slice(i, i + 2)];
    const one = ROMAJI[c];
    if (three) {
      out += three;
      i += 3;
    } else if (two) {
      out += two;
      i += 2;
    } else if (one) {
      out += one;
      i += 1;
    } else {
      return null;
    }
  }
  return out;
}

/** A written answer is correct in any script the student knows it in: the
 * kanji form, the all-hiragana reading (answer_kana, supplied by the
 * generator), kanji with furigana attached, or romaji typed on an English
 * keyboard (converted to hiragana before comparing). Without answer_kana the
 * exact form is required — the reading of a kanji answer cannot be inferred
 * client-side, and the UI shows the expected answer on mismatch. */
/** ○ and × each have several Unicode spellings, and the model does not always
 * pick the one the buttons send. */
function canonicalMark(text: string): string {
  return text.trim().replace(/[○◯〇⭕]/g, "○").replace(/[×✕✖❌]/g, "×");
}

export function isCorrect(item: QuizItem, given: string): boolean {
  if (item.type === "true_false") {
    return canonicalMark(given) !== "" && canonicalMark(given) === canonicalMark(item.answer);
  }

  const accepted = new Set(
    [item.answer, item.answer_kana]
      .filter((form): form is string => Boolean(form))
      .map((form) => normalizeAnswer(stripReadings(form))),
  );
  if (accepted.has(normalizeAnswer(stripReadings(given)))) return true;

  const asKana = romajiToHiragana(given.trim());
  return asKana !== null && accepted.has(normalizeAnswer(asKana));
}

/** Split Japanese text on 【 】 target-word markers for rendering.
 *
 * The generator wraps the one word an item asks about in 【 】 — the printed
 * papers underline that word, and a literal ＿＿ next to it reads as a line
 * beside the word rather than under it. The UI renders marked segments with a
 * real underline and drops the brackets. */
export function splitUnderline(text: string): { text: string; underline: boolean }[] {
  const segments: { text: string; underline: boolean }[] = [];
  const marker = /【([^】]+)】/g;
  let last = 0;
  for (const match of text.matchAll(marker)) {
    if (match.index > last) {
      segments.push({ text: text.slice(last, match.index), underline: false });
    }
    segments.push({ text: match[1], underline: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), underline: false });
  return segments.length > 0 ? segments : [{ text, underline: false }];
}


/** Aggregate missed questions into a study plan: which review references were
 * missed, with 1-based question numbers, most-missed first. Deterministic —
 * no model call (and no quota) stands between a student and their feedback. */
export function studyPlan(
  quiz: Quiz,
  answers: Record<number, string>,
): { review: string; questions: number[] }[] {
  const missed = new Map<string, number[]>();
  flattenItems(quiz).forEach((item, index) => {
    if (isCorrect(item, answers[index] ?? "")) return;
    const list = missed.get(item.review) ?? [];
    list.push(index + 1);
    missed.set(item.review, list);
  });
  return [...missed.entries()]
    .map(([review, questions]) => ({ review, questions }))
    .sort((a, b) => b.questions.length - a.questions.length);
}

/** A chunk as fetched for quiz generation. */
export interface FocusableChunk {
  content: string;
  metadata: Record<string, unknown> | null;
}

/** Search tokens from the student's free-text focus ("〜ておく、Topic 13").
 *
 * "Topic 13" / "T13" / "Lesson 13" / "L13" all normalise to a t13 marker
 * matched against chunk topic metadata — the Foundation books print "Topic",
 * the Intermediate books print "Lesson", and the metadata uses one marker for
 * both. Everything else is matched as a literal substring of the chunk text.
 * Bare digits and the division words alone are dropped — "13" would match
 * unrelated page numbers, not the topic.
 */
export function focusTokens(focus: string): string[] {
  const topics = [...focus.matchAll(/(?:topic|lesson|[tl])\s*(\d{1,2})/gi)].map(
    (m) => `t${m[1]}`,
  );
  const words = focus
    .split(/[\s、。，,．.／/;；・&()（）「」【】]+/)
    .map((t) => t.replace(/^[～〜~]+/, "").trim().toLowerCase())
    .filter(
      (t) =>
        t.length > 0 &&
        !/^\d+$/.test(t) &&
        !/^(topic|lesson|[tl]\d{1,2})$/.test(t) &&
        (t.length >= 2 || /[぀-ヿ一-鿿]/.test(t)),
    );
  return [...new Set([...topics, ...words])];
}

function shuffled<T>(items: T[]): T[] {
  return [...items].sort(() => Math.random() - 0.5);
}

// ---------------------------------------------------------------------------
// Past papers as exam-style reference
//
// The textbooks say what the course TEACHES. The sat papers say what it ASKS,
// and the two do not look alike: the book explains 〜ことができます in a box
// with three example sentences, and the paper tests it by printing a word bank
// of seven verbs and seven sentences with a gap, one mark each, under an
// instruction line that is itself a piece of Japanese the student has to read.
// A paper generated from the textbook alone reproduces the box, not the paper.
//
// So exemplars are retrieved alongside the textbook excerpts and handed to the
// generator as FORM, never as content: the questions still have to come from
// the book. Everything below decides which pages are worth that slot.
// ---------------------------------------------------------------------------

/** A past-paper chunk as the quiz route fetches it. */
export interface ExemplarChunk {
  content: string;
  metadata: Record<string, unknown> | null;
}

/** Words that say which kind of paper a page belongs to. The Foundation
 * papers title themselves 文法クイズ and 漢字・語彙クイズ, and the section
 * instructions repeat the distinction, so both are worth matching. */
const KIND_MARKERS: Record<QuizKind, RegExp> = {
  grammar: /文法|ぶんぽう|grammar|動詞|どうし|正しい形|形にかえて/i,
  kanji: /漢字|かんじ|語彙|ごい|読み方|よみかた|kanji|vocabular/i,
};

/** A page that is mostly a question paper rather than a cover sheet or the
 * blank back of one: it carries a printed instruction line. These are what
 * the generator is being shown the papers FOR. */
const INSTRUCTION_RE = /てください|ましょう|選んで|えらんで|書いて|かいて/;

const MARK_ALLOCATION_RE = /[（(]\s*\d+(?:\.\d+)?\s*[×xX]\s*\d+/;

/** The metadata a past-paper page carries about which paper it came from. */
export interface PaperIdentity {
  topic: string | null;
  examTerm: string | null;
  paperTitle: string | null;
}

export function paperIdentity(chunk: ExemplarChunk): PaperIdentity {
  const meta = chunk.metadata ?? {};
  const str = (key: string) => (typeof meta[key] === "string" ? (meta[key] as string) : null);
  return { topic: str("topic"), examTerm: str("exam_term"), paperTitle: str("paper_title") };
}

/** Choose the past-paper pages a quiz should be modelled on.
 *
 * Ranked by how much they tell the generator about the paper it is imitating,
 * then spread across papers rather than taken from whichever one ranked best:
 * four pages of a single 文法クイズ teach one paper's habits, while four pages
 * from four sittings teach the course's. The cap is per (term, title, topic),
 * which is what identifies one sat paper.
 */
export function selectExemplars<T extends ExemplarChunk>(
  chunks: T[],
  kind: QuizKind,
  topicScope: number | null,
  take = 4,
  perPaper = 2,
): T[] {
  const marker = KIND_MARKERS[kind];
  const other = KIND_MARKERS[kind === "grammar" ? "kanji" : "grammar"];

  const score = (chunk: T) => {
    const { topic, paperTitle } = paperIdentity(chunk);
    const text = `${paperTitle ?? ""}\n${chunk.content}`;
    let value = 0;
    // The title is the reliable signal for which paper this is; the body only
    // says the page mentions grammar somewhere.
    if (paperTitle && marker.test(paperTitle)) value += 6;
    else if (paperTitle && other.test(paperTitle)) value -= 4;
    if (marker.test(text)) value += 2;
    // A paper from a DIFFERENT topic than the one being tested.
    //
    // Counter-intuitive, and measured: showing the generator the Topic 11
    // paper while asking it to write a Topic 11 test produced six copied
    // questions out of sixteen. The format of these papers does not vary by
    // topic — the same four sections, the same instruction lines, the same
    // option counts run from Topic 1 to Topic 17 — so a neighbouring topic's
    // paper teaches the form just as well while giving the model nothing
    // on-topic to lift. The copy filter still runs behind this; the point is
    // to stop manufacturing the temptation.
    if (topicScope !== null && topic && topic !== `T${topicScope}`) value += 4;
    // A page with no instruction line is a cover sheet or an overflow page,
    // and it shows the generator nothing about question form.
    if (INSTRUCTION_RE.test(chunk.content)) value += 3;
    if (MARK_ALLOCATION_RE.test(chunk.content)) value += 1;
    return value;
  };

  const ranked = [...chunks]
    .map((chunk, index) => ({ chunk, index, value: score(chunk) }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value || a.index - b.index);

  const perPaperCount = new Map<string, number>();
  const picked: T[] = [];
  for (const { chunk } of ranked) {
    const { topic, examTerm, paperTitle } = paperIdentity(chunk);
    const paper = `${examTerm ?? "?"}|${paperTitle ?? "?"}|${topic ?? "?"}`;
    const used = perPaperCount.get(paper) ?? 0;
    if (used >= perPaper) continue;
    perPaperCount.set(paper, used + 1);
    picked.push(chunk);
    if (picked.length >= take) break;
  }
  return picked;
}

/** Reduce Japanese text to the characters that decide whether two sentences
 * are the same one: no furigana, no answer rules, no markers, no punctuation,
 * no spacing. 「デパートで（　）まえに ATM でお金をおろします。」 and
 * 「デパートで【買い物し】まえにATMでお金をおろします」 collapse to the same
 * run, which is the point — a copied question is usually copied with its
 * blank moved. */
function comparable(text: string): string {
  return text
    .replace(/《[^》]*》/g, "")
    .replace(/[（(][ぁ-ゖァ-ヶー\s　]*[）)]/g, "")
    .replace(/[【】＿_]/g, "")
    .replace(/[\s　]/g, "")
    .replace(/[。、．，,.!?！？「」『』・:：;；|]/g, "")
    .toLowerCase();
}

/** How much of an item has to be shared with a past paper before it is a copy.
 *
 * A fixed character run cannot do this job at both ends. Japanese packs a
 * clause into very few characters: 「私はピアノを（　）ことができます。」 is a
 * whole copied question and reduces to 13 characters, while
 * 「ことができます」 is 7 and legitimately appears in every Topic 8 sentence
 * ever written. A run long enough to ignore the pattern is longer than the
 * question.
 *
 * So the test is proportional — a copy is an item that is MOSTLY someone
 * else's sentence — with a floor so a very short fragment cannot clear the
 * bar on ratio alone. */
const COPIED_RATIO = 0.6;
const COPIED_MIN_RUN = 10;

function runsInside(needle: string, haystack: string, ratio: number): boolean {
  const run = Math.max(COPIED_MIN_RUN, Math.ceil(needle.length * ratio));
  if (needle.length < run) return false;
  for (let i = 0; i + run <= needle.length; i++) {
    if (haystack.includes(needle.slice(i, i + run))) return true;
  }
  return false;
}

function sharesRun(needleSource: string, haystack: string, ratio: number): boolean {
  // Twice: once as written, and once with the marked answer taken out.
  //
  // The second is what catches the commonest copy. 「私はピアノを（　）こと
  // ができます。」 comes back as 「私はピアノを【ひく】ことができます。」 —
  // the paper's own sentence with its blank filled in — and the inserted word
  // splits the shared run in half, so as-written it looks like two short
  // fragments and slips through. Removing what the student is meant to supply
  // leaves the skeleton, and the skeleton is identical.
  return (
    runsInside(comparable(needleSource), haystack, ratio) ||
    runsInside(comparable(needleSource.replace(/【[^】]*】/g, "")), haystack, ratio)
  );
}

/** Drop items lifted from the past papers they were supposed to be modelled on.
 *
 * The prompt says, at length, never to reuse a past-paper sentence. It mostly
 * works, and "mostly" is the whole problem: on one Topic 8 run the generator
 * came back with 「デパートで（　）まえに ATM でお金をおろします。」, which is
 * question 1 of the 24秋 paper word for word. A student sitting that has been
 * handed back the paper they already sat, with the answers on it — the single
 * worst thing this feature could do, and the reason the past papers are shown
 * as FORM rather than as a question bank.
 *
 * So it is enforced here rather than trusted to the prompt, exactly as
 * dedupeQuiz enforces "never ask the same thing twice". Dropping is the right
 * remedy and not regeneration: it costs no second model call, and the route
 * already treats a paper left too short as a failed generation and hands the
 * request to the next provider — so a wholesale copy repairs itself.
 */
export function dropCopiedItems(
  quiz: Quiz,
  exemplars: ExemplarChunk[],
  ratio = COPIED_RATIO,
): { quiz: Quiz; removed: number } {
  if (exemplars.length === 0) return { quiz, removed: 0 };

  const haystack = exemplars.map((chunk) => comparable(chunk.content)).join("\n");
  let removed = 0;

  const sections = quiz.sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => {
        const copied =
          sharesRun(item.question ?? "", haystack, ratio) ||
          sharesRun(item.sentence ?? "", haystack, ratio);
        if (copied) removed += 1;
        return !copied;
      }),
    }))
    .filter((section) => section.items.length > 0);

  return { quiz: { ...quiz, sections }, removed };
}

/** What can honestly be said about the papers a test was modelled on.
 *
 * Read off the exemplars actually retrieved, and nowhere else. The generator
 * is told to describe the paper's provenance only from this list, because the
 * alternative is a model writing "as commonly tested in the 25春 final" about
 * a term nobody ingested — a claim a student would reasonably act on.
 */
export function exemplarProvenance(chunks: ExemplarChunk[]): {
  terms: string[];
  titles: string[];
  topics: string[];
} {
  const terms = new Set<string>();
  const titles = new Set<string>();
  const topics = new Set<string>();
  for (const chunk of chunks) {
    const { topic, examTerm, paperTitle } = paperIdentity(chunk);
    if (examTerm) terms.add(examTerm);
    if (paperTitle) titles.add(paperTitle);
    if (topic) topics.add(topic);
  }
  return { terms: [...terms], titles: [...titles], topics: [...topics] };
}

// 第３課 / 第3課 / Lesson 3 / Topic 3 — the division headers the textbooks
// actually print: the Intermediate Tobira volumes mark lessons as 第N課, and
// the Foundation 1 & 2 book puts an English "Topic N" running header on nearly
// every page (Foundation 1 is Topics 1–5, Foundation 2 is Topics 6–10 — one
// continuous numbering through the one book).
// トピック is not optional decoration: the Foundation 3 book prints its
// running headers in katakana and uses the Latin word only on its English
// contents pages. Measured on the ingested book: 20–29 katakana headers per
// topic against 2–3 Latin ones, so matching Latin alone found almost nothing
// and mapped three quarters of the book to front matter.
const LESSON_MARK =
  /(?:第\s*([0-9０-９]{1,2})\s*課|トピック\s*([0-9０-９]{1,2})|Lesson\s+(\d{1,2})\b|Topic\s*(\d{1,2})\b)/g;

function markedLesson(match: RegExpMatchArray): number {
  const digits = match[1] ?? match[2] ?? match[3] ?? match[4];
  return Number(digits.replace(/[０-９]/g, (d) => String("０１２３４５６７８９".indexOf(d))));
}

/** Map each pdf page to the lesson it belongs to, from the 第N課 / Topic N
 * headers in the page text. Textbook chunks carry no lesson metadata, so this
 * derived mapping is what makes "test me on Lesson 3" (or "Topic 3") select
 * that division's pages instead of sampling the whole book at random.
 *
 * Two kinds of noise are filtered by the monotonic walk: contents pages list
 * every lesson at once (ignored — only pages naming exactly one lesson count),
 * and appendix/answer pages cross-reference earlier lessons (ignored — the
 * lesson number may only step forward, at most two at a time). Pages before
 * the first header map to 0, front matter.
 *
 * The walk is ANCHORED on the first division the book actually opens with,
 * not on Topic 1. A mid-course volume starts high — the Foundation 3 book
 * opens at Topic 11 — and stepping two at a time from zero can never reach
 * it, which mapped that whole book to front matter. The opening number is
 * accepted on the same follow-through evidence a restart needs.
 *
 * One exception to forward-only: a RESTART. The Foundation 1 & 2 book runs
 * Topics 1–10 twice — main text, then the kanji/vocabulary section, which
 * starts its own Topic 1 partway through the book. A drop back to 1 or 2 is
 * accepted as a new pass only when the next two marked pages continue the NEW
 * numbering and do not fit the old one. Both conditions matter: a lone
 * cross-reference has no follow-through, and a cross-reference right before
 * the old sequence's next header (seen in Tobira: a 第1課 citation on p.53,
 * then 第3課 opens on p.63) is followed by marks the old walk explains, so it
 * stays noise. Both passes of a topic map to the same number, which is
 * exactly right: a Topic 3 test should draw from Topic 3's grammar pages and
 * its kanji pages alike. */
export function lessonByPage(
  chunks: { content: string; pdf_page: number }[],
): Map<number, number> {
  const perPage = new Map<number, Set<number>>();
  for (const chunk of chunks) {
    const seen = perPage.get(chunk.pdf_page) ?? new Set<number>();
    for (const match of chunk.content.matchAll(LESSON_MARK)) {
      const lesson = markedLesson(match);
      if (lesson >= 1 && lesson <= 30) seen.add(lesson);
    }
    perPage.set(chunk.pdf_page, seen);
  }

  // Pages naming exactly one lesson, in page order — the walk's evidence.
  const marked: { page: number; n: number }[] = [];
  for (const page of [...perPage.keys()].sort((a, b) => a - b)) {
    const marks = perPage.get(page)!;
    if (marks.size === 1) marked.push({ page, n: [...marks][0] });
  }

  // Two further marked pages that step forward from `start` by at most two
  // each. This is the evidence that a number opens a real run of divisions
  // rather than being a one-off cross-reference, which has no follow-through.
  const continuesFrom = (index: number, start: number): boolean => {
    const a = marked[index + 1];
    const b = marked[index + 2];
    return (
      a !== undefined &&
      b !== undefined &&
      a.n >= start &&
      a.n <= start + 2 &&
      b.n >= a.n &&
      b.n <= a.n + 2
    );
  };

  const currentAt = new Map<number, number>();
  let current = 0;
  // The division the book opens with. A restart is a drop back to HERE, not
  // to Topic 1: the Foundation 3 book opens at 11 and its kanji section
  // restarts at 11, so a rule written around 1 missed it entirely and filed
  // 115 pages of kanji material under the last topic of the main text.
  let anchor = 0;
  for (const [i, { page, n }] of marked.entries()) {
    if (n > current && n <= current + 2) {
      current = n;
      if (anchor === 0) anchor = n;
    } else if (current === 0) {
      // Nothing anchored yet, and this page opens well above Topic 1 — which
      // is simply how a mid-course volume is numbered: the Foundation 3 book
      // starts at Topic 11, and stepping forward two at a time from zero can
      // never reach it, so every page mapped to front matter and every
      // scoped test fell back to text matching over the whole book.
      // Anchoring needs the same follow-through evidence a restart does, so
      // a stray cross-reference in the front matter cannot claim the book.
      if (continuesFrom(i, n)) {
        current = n;
        anchor = n;
      }
    } else if (n < current && n <= anchor + 1) {
      const a = marked[i + 1];
      const fitsOld =
        a !== undefined && (a.n === current || (a.n > current && a.n <= current + 2));
      if (continuesFrom(i, n) && !fitsOld) current = n;
    }
    currentAt.set(page, current);
  }

  // Every page inherits the lesson of the last marked page at or before it.
  const lessons = new Map<number, number>();
  current = 0;
  for (const page of [...perPage.keys()].sort((a, b) => a - b)) {
    current = currentAt.get(page) ?? current;
    lessons.set(page, current);
  }
  return lessons;
}

/** Chunks for a lesson-scoped test: the scoped lesson's own pages first, then
 * — only if the lesson is too thin to fill the sample — earlier lessons,
 * nearest first. Never later lessons (untaught material) and never front
 * matter. Empty when the mapping found nothing for that lesson, so the caller
 * can fall back to text matching instead of serving the wrong lesson. */
export function chunksForLesson<T extends { pdf_page: number }>(
  chunks: T[],
  lessons: Map<number, number>,
  scope: number,
  take: number,
): T[] {
  const lessonOf = (chunk: T) => lessons.get(chunk.pdf_page) ?? 0;
  const inLesson = chunks.filter((c) => lessonOf(c) === scope);
  if (inLesson.length === 0) return [];

  const picked = shuffled(inLesson).slice(0, take);
  if (picked.length < take) {
    const earlier = shuffled(
      chunks.filter((c) => lessonOf(c) > 0 && lessonOf(c) < scope),
    ).sort((a, b) => lessonOf(b) - lessonOf(a));
    picked.push(...earlier.slice(0, take - picked.length));
  }
  return picked;
}

/** Pick the chunks a focused quiz should be generated from.
 *
 * With no focus (or one that matches nothing) the whole book is fair game and
 * a random sample keeps successive tests varied. With a focus, chunks that
 * mention it are taken first, padded with random material only when the focus
 * is too narrow to fill the sample on its own.
 */
export function rankChunksByFocus<T extends FocusableChunk>(
  chunks: T[],
  focus: string,
  take: number,
): T[] {
  const tokens = focusTokens(focus);
  if (tokens.length === 0) return shuffled(chunks).slice(0, take);

  const scored = chunks.map((chunk) => {
    const content = chunk.content.toLowerCase();
    const topic = String(chunk.metadata?.["topic"] ?? "").toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (/^t\d{1,2}$/.test(token)) {
        // Topic metadata is authoritative for week markers.
        if (topic === token) score += 3;
      } else if (content.includes(token)) {
        score += 1;
      }
    }
    return { chunk, score };
  });

  const hits = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  if (hits.length === 0) return shuffled(chunks).slice(0, take);

  const top = hits.slice(0, take).map((s) => s.chunk);
  if (top.length < take) {
    const rest = scored.filter((s) => s.score === 0).map((s) => s.chunk);
    top.push(...shuffled(rest).slice(0, take - top.length));
  }
  return top;
}
