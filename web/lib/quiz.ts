import { z } from "zod";

/** One generated test item. answer is authoritative; the client grades.
 * true_false is the reading section's ○×: question is a statement about the
 * section's passage and answer is exactly ○ or ×. */
export const QuizItemSchema = z.object({
  type: z.enum(["multiple_choice", "fill_blank", "true_false"]),
  question: z.string().min(1),
  // Japanese text of the sentence being drilled, when distinct from question.
  sentence: z.string().optional(),
  choices: z.array(z.string()).length(4).optional(),
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
});

/** One 問題 (numbered section) of the paper, mirroring the course review
 * sheets: a Japanese instruction line like 適切なことばを選んでください,
 * its English translation, and the items drilled under it. */
export const QuizSectionSchema = z.object({
  instruction_ja: z.string().min(1),
  instruction_en: z.string().min(1),
  // Reading sections carry the short passage their ○× statements are about,
  // rendered above the items in the style of the printed papers.
  passage: z.string().optional(),
  items: z.array(QuizItemSchema).min(1).max(8),
});

export const QuizSchema = z.object({
  // 1–2 sentences telling the student what the test covers — the grammar
  // points or vocabulary drilled and where they sit in the course.
  scope_description: z.string().min(1),
  sections: z.array(QuizSectionSchema).min(1).max(4),
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

/** Split text into ruby segments: kanji followed immediately by a kana
 * reading in 漢字（かんじ） or 漢字《かんじ》 style becomes a base+reading
 * pair for <ruby> rendering, which puts the hiragana on top of the kanji the
 * way the textbook prints it. Both bracket styles occur in the wild — the
 * prompt asks for （ ）, but the transcribed corpus writes 《 》 and models
 * imitate what they read. Brackets holding anything but kana (the （　）
 * answer blank, bracketed kanji) pass through untouched. */
export function splitRuby(text: string): { base: string; reading?: string }[] {
  const segments: { base: string; reading?: string }[] = [];
  const annotated = /([一-鿿々〆ヶ]+)(?:（([ぁ-ゖァ-ヶー]+)）|《([ぁ-ゖァ-ヶー]+)》)/g;
  let last = 0;
  for (const match of text.matchAll(annotated)) {
    if (match.index > last) segments.push({ base: text.slice(last, match.index) });
    segments.push({ base: match[1], reading: match[2] ?? match[3] });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ base: text.slice(last) });
  return segments.length > 0 ? segments : [{ base: text }];
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
