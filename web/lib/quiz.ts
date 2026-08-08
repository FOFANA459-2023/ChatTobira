import { z } from "zod";

/** One generated test item. answer is authoritative; the client grades. */
export const QuizItemSchema = z.object({
  type: z.enum(["multiple_choice", "fill_blank"]),
  question: z.string().min(1),
  // Japanese text of the sentence being drilled, when distinct from question.
  sentence: z.string().optional(),
  choices: z.array(z.string()).length(4).optional(),
  answer: z.string().min(1),
  // The answer written entirely in hiragana, when answer contains kanji.
  // Grading accepts either script — see isCorrect.
  answer_kana: z.string().optional(),
  explanation: z.string().min(1),
  grammar_point: z.string().optional(),
});

/** One 問題 (numbered section) of the paper, mirroring the course review
 * sheets: a Japanese instruction line like 適切なことばを選んでください,
 * its English translation, and the items drilled under it. */
export const QuizSectionSchema = z.object({
  instruction_ja: z.string().min(1),
  instruction_en: z.string().min(1),
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

/** A written answer is correct in any script the student knows it in:
 * the kanji form, the all-hiragana reading (answer_kana, supplied by the
 * generator), or kanji with furigana attached. Without answer_kana the exact
 * form is required — the reading of a kanji answer cannot be inferred client-
 * side, and the UI shows the expected answer on mismatch. */
export function isCorrect(item: QuizItem, given: string): boolean {
  const accepted = new Set(
    [item.answer, item.answer_kana]
      .filter((form): form is string => Boolean(form))
      .map((form) => normalizeAnswer(stripReadings(form))),
  );
  return accepted.has(normalizeAnswer(stripReadings(given)));
}

/** A chunk as fetched for quiz generation. */
export interface FocusableChunk {
  content: string;
  metadata: Record<string, unknown> | null;
}

/** Search tokens from the student's free-text focus ("〜ておく、Topic 13").
 *
 * "Topic 13" / "T13" normalise to a t13 marker matched against chunk topic
 * metadata; everything else is matched as a literal substring of the chunk
 * text. Bare digits and the word "topic" are dropped — "13" alone would match
 * unrelated page numbers, not the topic.
 */
export function focusTokens(focus: string): string[] {
  const topics = [...focus.matchAll(/(?:topic|t)\s*(\d{1,2})/gi)].map(
    (m) => `t${m[1]}`,
  );
  const words = focus
    .split(/[\s、。，,．.／/;；・&()（）「」【】]+/)
    .map((t) => t.replace(/^[～〜~]+/, "").trim().toLowerCase())
    .filter(
      (t) =>
        t.length > 0 &&
        !/^\d+$/.test(t) &&
        !/^(topic|t\d{1,2})$/.test(t) &&
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
