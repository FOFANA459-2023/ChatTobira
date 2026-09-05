/** The course's assessment format, read off the papers students actually sat.
 *
 * Everything in this file was derived by reading the 73 transcribed pages of
 * `Found 1 Papers`, `Found 2 Papers` and `Foundation 3 Past Papers` — 40 sat
 * papers across Topics 1–17 — and tabulating every section instruction, its
 * mark allocation, its item shape and its option count. It is a model of the
 * assessment, not a description of one: the generator is handed a section plan
 * from here and told to fill it, rather than being asked to imitate a style.
 *
 * What the survey actually found, because the previous template got most of
 * it wrong:
 *
 *   * There is no fixed four-section paper. Sat papers run to 3–7 sections,
 *     and which sections appear depends on the level and the topic.
 *   * Multiple choice is almost never four lettered options. The commonest
 *     form by far is an INLINE bracket — 「写真部は週 ( は / に / で ) 2かい
 *     かつどうします。」 — with two or three options, circled in place. Where
 *     the paper does list options it labels them a. b. c. and gives three,
 *     or a.–d. and gives four. Nothing in 40 papers uses A) B) C) D).
 *   * The signature item at both levels is a shared WORD BANK whose entries
 *     must be conjugated to fit the gap and may each be used once.
 *   * Reading sections ask open questions more often than ○×, and when they
 *     do use ○× the statements are numbered ① ② ③ ④ with （　） to mark.
 *   * Marks are printed per section — (1×5), (2点×5), (0.5×18=9) — and vary
 *     by item type: F3 grammar items are worth 2 or 3 marks, F2 items 1.
 *   * Instruction language tracks the topic. Foundation 2 papers up to Topic
 *     6 are written in English; from Topic 7 the instruction is Japanese with
 *     an English line under it, and Foundation 3 is Japanese throughout.
 *
 * Not modelled, deliberately: the papers are full of items a machine cannot
 * mark — "introduce yourself", "make four sentences from this schedule",
 * 「教室の外で見つけた新しいごいを2つ書いてください」, and every item that
 * depends on a printed picture or map. They are real and they are excluded,
 * because a practice paper that cannot tell a student whether they were right
 * is worse than one that asks fewer questions.
 */

import type { QuizKind } from "./quiz";

export type Level = "F2" | "F3";

/** How an item is answered, which decides how it renders and how it grades. */
export type ItemForm =
  | "bracket" // inline ( は / に / で ), circled in place
  | "lettered" // a. b. c. listed under the sentence
  | "written" // the student writes the answer into a gap
  | "maru_batsu"; // ○ / ✕ against a statement about a passage

export interface SectionArchetype {
  /** Stable id, used by the blueprint and by the tests. */
  id: string;
  /** The instruction exactly as the papers print it. */
  instructionJa: string;
  /** The English line the papers print under it, where they print one. */
  instructionEn: string;
  form: ItemForm;
  /** Options per item. Only meaningful for bracket and lettered forms. */
  choices?: number;
  /** Marks per item, as printed beside the instruction. */
  marks: number;
  /** Items the real sections carry, as [min, max]. */
  items: [number, number];
  /** The section shares one word list; each entry may be used once. */
  wordBank?: boolean;
  /** The section opens with a passage its items are about. */
  passage?: boolean;
  /** An 例 line showing the expected answer format, as the papers do. */
  example?: boolean;
  /** What the generator is told this section is FOR — the testing objective,
   * which is also what the duplicate check treats as the item's target. */
  objective: string;
  /** Topics this archetype was observed on, so the report and the tests can
   * point at the evidence rather than at an assertion. */
  seenOn: string;
}

/* ------------------------------------------------------------------------ */
/* Foundation 2 — grammar                                                    */
/* ------------------------------------------------------------------------ */

const F2_GRAMMAR: SectionArchetype[] = [
  {
    id: "f2g_bracket",
    instructionJa: "正しいほうを選んで、〇を書いてください。",
    instructionEn: "Choose the appropriate answer from the options given in each bracket.",
    form: "bracket",
    choices: 3,
    marks: 1,
    items: [4, 6],
    objective:
      "particles and question words chosen in place, with two or three options printed inside the sentence",
    seenOn: "T3 I, T4 I, T5 I, T7 I, T11 I",
  },
  {
    id: "f2g_question_word",
    instructionJa: "＿＿に正しい疑問詞《ぎもんし》をひらがなで書いてください。",
    instructionEn: "Fill in each blank with the appropriate Question Word in HIRAGANA.",
    form: "written",
    marks: 1,
    items: [3, 5],
    example: true,
    objective:
      "the question word a sentence needs — なに, どこ, いつ, だれ, どうして, いくら, なんじ",
    seenOn: "T1 III, T3 II, T4 IV, T5 III, T6 II",
  },
  {
    id: "f2g_word_bank",
    instructionJa:
      "下の＿＿からことばを選《えら》んで、正しい形《かたち》に変《か》えて（　）に書いてください。ことばは1回しか使えません。",
    instructionEn:
      "Complete each sentence using the appropriate word from the box below, changing its form. Each word may be used only once.",
    form: "written",
    marks: 1,
    items: [5, 7],
    wordBank: true,
    example: true,
    objective: "conjugating a verb from a shared word bank into the form the sentence needs",
    seenOn: "T4 III, T8 I, T9 III, T10 II, T11 IV",
  },
  {
    id: "f2g_lettered",
    instructionJa: "正しい答《こた》えは a〜c のどれですか。〇を書いてください。",
    instructionEn: "Which of a–c is correct? Circle your answer.",
    form: "lettered",
    choices: 3,
    marks: 1,
    items: [2, 4],
    objective:
      "reading a short statement and choosing the sentence that means the same thing — tests 〜しか〜ない, 〜だけ, counters",
    seenOn: "T8 II, T11 II",
  },
  {
    id: "f2g_dialogue",
    instructionJa: "会話《かいわ》を完成《かんせい》させてください。",
    instructionEn: "Complete the dialogues.",
    form: "written",
    marks: 1,
    items: [3, 4],
    objective: "supplying the missing turn of a two-line exchange",
    seenOn: "T1 II, T7 III, T8 III, T10 III",
  },
  {
    id: "f2g_reading_maru",
    instructionJa:
      "下の文を読んで、正しいものに○を、正しくないものに×を書いてください。",
    instructionEn:
      "Read the following passage and statements. Put ○ if the statement is correct and × if it is not.",
    form: "maru_batsu",
    marks: 1,
    items: [4, 5],
    passage: true,
    objective: "reading comprehension of a short passage",
    seenOn: "T4 V, T5 V",
  },
];

/* ------------------------------------------------------------------------ */
/* Foundation 2 — kanji and vocabulary                                       */
/* ------------------------------------------------------------------------ */

const F2_KANJI: SectionArchetype[] = [
  {
    id: "f2k_read_underlined",
    instructionJa: "例《れい》のように、＿＿の漢字《かんじ》の読み方をひらがなで書いてください。",
    instructionEn: "Write the reading of each underlined kanji in Hiragana as in the example.",
    form: "written",
    marks: 1,
    items: [4, 7],
    example: true,
    objective: "reading a kanji word marked inside a sentence",
    seenOn: "T3 III, T7 III, T8 II, T8 IV",
  },
  {
    id: "f2k_word_bank",
    instructionJa:
      "【　】からことばを選《えら》んで、例《れい》のように書いてください。ひらがなは漢字《かんじ》にしますが、カタカナはそのまま書いてください。ことばは1回しか使えません。",
    instructionEn:
      "Choose a word from the box and write it as in the example. Write hiragana words in kanji; leave katakana as it is. Each word may be used only once.",
    form: "written",
    marks: 1,
    items: [5, 7],
    wordBank: true,
    example: true,
    objective: "writing a vocabulary word in kanji in the sentence that needs it",
    seenOn: "T5 III, T8 III, T9 I, T9 II",
  },
  {
    id: "f2k_lettered",
    instructionJa: "正しい答《こた》えは a〜d のどれですか。",
    instructionEn: "Which of a–d is correct?",
    form: "lettered",
    choices: 4,
    marks: 1,
    items: [3, 4],
    objective:
      "choosing the right word for a situation from four listed candidates — symptoms, verbs, related vocabulary",
    seenOn: "T10 II, T10 III",
  },
  {
    id: "f2k_opposite",
    instructionJa: "例《れい》のように、反対《はんたい》の意味《いみ》のことばを選んでください。",
    instructionEn: "Choose the word with the opposite meaning, as in the example.",
    form: "lettered",
    choices: 4,
    marks: 1,
    items: [4, 6],
    example: true,
    objective: "adjective antonym pairs — 高い/安い, 新しい/古い, ひろい/せまい",
    seenOn: "T5 II",
  },
  {
    id: "f2k_bracket",
    instructionJa: "正しいほうを選《えら》んで、〇を書いてください。",
    instructionEn: "Circle the correct one.",
    form: "bracket",
    choices: 2,
    marks: 1,
    items: [4, 6],
    objective:
      "telling two similar kanji or two readings apart in place — 待つ/持つ, はやい 早い/速い",
    seenOn: "T9 III, and the F3 papers' 正しいほうを選んでください",
  },
];

/* ------------------------------------------------------------------------ */
/* Foundation 3 — grammar                                                    */
/* ------------------------------------------------------------------------ */

const F3_GRAMMAR: SectionArchetype[] = [
  {
    id: "f3g_dialogue_bank",
    instructionJa:
      "下の＿＿からことばを選《えら》んで、必要《ひつよう》な形《かたち》に変《か》えて（　）に書いて、会話《かいわ》を作ってください。ことばは1回しか使えません。",
    instructionEn:
      "Complete the dialogue by choosing a word from the box below and writing it in ( ), changing its form where necessary. Each word may be used only once.",
    form: "written",
    marks: 2,
    items: [5, 8],
    wordBank: true,
    passage: true,
    objective:
      "carrying a conversation across several turns while conjugating each word from the bank to fit — the dominant Foundation 3 grammar item",
    seenOn: "T12 1(1), T13 I, T14 1(1), T15 II, T17 II",
  },
  {
    id: "f3g_cloze_bank",
    instructionJa:
      "下の【　】からことばを選《えら》んで、形《かたち》をかえて書いてください。",
    instructionEn: "Choose a word from the box below and write it in the correct form.",
    form: "written",
    marks: 2,
    items: [4, 5],
    wordBank: true,
    passage: true,
    example: false,
    objective: "filling the gaps in a first-person account with correctly conjugated verbs",
    seenOn: "T16 I(1)",
  },
  {
    id: "f3g_passage_maru",
    instructionJa:
      "上の文について、正しいこたえに〇を、正しくないこたえに✕をしてください。",
    instructionEn:
      "Put ○ if the statement about the passage above is correct, and ✕ if it is not.",
    form: "maru_batsu",
    marks: 1,
    items: [4, 4],
    passage: true,
    objective: "comprehension of the passage the section above is built on",
    seenOn: "T16 I(2), T12 II",
  },
  {
    id: "f3g_bracket",
    instructionJa: "（　）の中で正しいものを選《えら》んで、〇をつけてください。",
    instructionEn: "Circle the correct option in each bracket.",
    form: "bracket",
    choices: 3,
    marks: 2,
    items: [4, 5],
    objective:
      "distinguishing Foundation 3 patterns in place — 〜そうです/〜ようです, 〜ておく/〜てある, transitive against intransitive",
    seenOn: "T13 2(1), T12 2",
  },
];

/* ------------------------------------------------------------------------ */
/* Foundation 3 — kanji and vocabulary                                       */
/* ------------------------------------------------------------------------ */

const F3_KANJI: SectionArchetype[] = [
  {
    id: "f3k_read_in_passage",
    instructionJa: "a〜e の漢字《かんじ》の読み方をひらがなで書いてください。",
    instructionEn: "Write the readings of a–e in hiragana.",
    form: "written",
    marks: 1,
    items: [4, 5],
    passage: true,
    objective:
      "reading marked kanji words inside a continuous passage rather than in isolation",
    seenOn: "T16 IV, T17 I(1), T12 III(1), T13 II(1)",
  },
  {
    id: "f3k_mixed",
    instructionJa:
      "下の(1)から(7)の漢字《かんじ》をひらがなで、ひらがなを漢字《かんじ》で書いてください。",
    instructionEn:
      "Write the kanji in hiragana, and the hiragana in kanji, for (1) to (7) below.",
    form: "written",
    marks: 1,
    items: [6, 8],
    objective:
      "reading and writing drilled together in one numbered run, both directions mixed",
    seenOn: "T14 III, T13 II",
  },
  {
    id: "f3k_word_bank",
    instructionJa:
      "【　】の中から漢字《かんじ》を選《えら》んで＿＿＿に書いてください。読み方は〔　〕に書いてください。漢字は1回しか使えません。",
    instructionEn:
      "Choose a kanji from the box and write it in the blank, with its reading in 〔 〕. Each kanji may be used only once.",
    form: "written",
    marks: 1,
    items: [5, 7],
    wordBank: true,
    objective: "choosing the right kanji for a context and giving its reading",
    seenOn: "T16 II",
  },
  {
    id: "f3k_bracket",
    instructionJa: "正しいほうを選《えら》んでください。",
    instructionEn: "Circle the correct answer.",
    form: "bracket",
    choices: 2,
    marks: 1,
    items: [4, 5],
    objective: "telling apart two similar kanji or two readings of the same character",
    seenOn: "T12 2, T13 2(1)",
  },
];

const CATALOGUE: Record<Level, Record<QuizKind, SectionArchetype[]>> = {
  F2: { grammar: F2_GRAMMAR, kanji: F2_KANJI },
  F3: { grammar: F3_GRAMMAR, kanji: F3_KANJI },
};

export function archetypes(level: Level, kind: QuizKind): SectionArchetype[] {
  return CATALOGUE[level][kind];
}

export function archetypeById(id: string): SectionArchetype | undefined {
  return Object.values(CATALOGUE)
    .flatMap((byKind) => Object.values(byKind))
    .flat()
    .find((a) => a.id === id);
}

/** Which sections a paper is built from, in the order the papers print them.
 *
 * Not a random sample of the catalogue: the real papers open with the quick
 * in-place items, put the word-bank section in the middle where it carries
 * the most marks, and close with the passage. Reproducing that order is most
 * of what makes a generated paper feel like the printed one.
 *
 * `passageSlots` collapses the sections that share a passage: on the real
 * Foundation 3 papers the ○× statements are about the SAME text the cloze
 * above them was built on, printed once and referred to twice.
 */
export function blueprint(level: Level, kind: QuizKind): SectionArchetype[] {
  const all = archetypes(level, kind);
  const pick = (id: string) => all.find((a) => a.id === id)!;

  if (level === "F2" && kind === "grammar") {
    return [pick("f2g_bracket"), pick("f2g_word_bank"), pick("f2g_lettered"), pick("f2g_reading_maru")];
  }
  if (level === "F2" && kind === "kanji") {
    return [pick("f2k_read_underlined"), pick("f2k_word_bank"), pick("f2k_bracket"), pick("f2k_lettered")];
  }
  if (level === "F3" && kind === "grammar") {
    return [pick("f3g_bracket"), pick("f3g_dialogue_bank"), pick("f3g_passage_maru")];
  }
  return [pick("f3k_read_in_passage"), pick("f3k_mixed"), pick("f3k_word_bank"), pick("f3k_bracket")];
}

/** Which language the instruction lines are written in.
 *
 * Read off the papers rather than chosen: Foundation 2 up to Topic 6 prints
 * its instructions in English only, Topic 7 onward prints Japanese with an
 * English line beneath, and Foundation 3 is Japanese throughout. A Topic 3
 * paper headed 「正しいほうを選んで、〇を書いてください。」 would look wrong
 * to the student who sat the real one.
 */
export function instructionLanguage(
  level: Level,
  topic: number | null,
): "en" | "ja+en" | "ja" {
  if (level === "F3") return "ja";
  return topic !== null && topic <= 6 ? "en" : "ja+en";
}

/** The mark line as the papers print it: (1×5), (2点×5). */
export function markLine(marks: number, items: number): string {
  return marks === 1 ? `(1×${items})` : `(${marks}点×${items})`;
}
