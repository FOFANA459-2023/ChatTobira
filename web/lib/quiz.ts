import { z } from "zod";

/** One generated test item. answer is authoritative; the client grades. */
export const QuizItemSchema = z.object({
  type: z.enum(["multiple_choice", "fill_blank"]),
  question: z.string().min(1),
  // Japanese text of the sentence being drilled, when distinct from question.
  sentence: z.string().optional(),
  choices: z.array(z.string()).length(4).optional(),
  answer: z.string().min(1),
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
  title: z.string(),
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
 * against 食べます. Kanji vs kana variants are NOT normalised — knowing the
 * kanji is often the point of the drill, so that stays a human judgement and
 * the UI shows the expected answer on mismatch.
 */
export function normalizeAnswer(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\s　]+/g, "")
    .replace(/[。、．，.,!?！？]+$/g, "")
    .toLowerCase();
}

export function isCorrect(item: QuizItem, given: string): boolean {
  return normalizeAnswer(given) === normalizeAnswer(item.answer);
}
