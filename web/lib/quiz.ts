import { z } from "zod";

/** One generated drill item. answer is authoritative; the client grades. */
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

export const QuizSchema = z.object({
  title: z.string(),
  items: z.array(QuizItemSchema).min(1).max(10),
});

export type QuizItem = z.infer<typeof QuizItemSchema>;
export type Quiz = z.infer<typeof QuizSchema>;

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
