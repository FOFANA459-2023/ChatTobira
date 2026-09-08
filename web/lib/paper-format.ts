/** The course's assessment format, read off the papers students actually sat.
 *
 * Everything in this file was derived by reading the 73 transcribed pages of
 * `Found 1 Papers` (Topics 1–7), `Found 2 Papers` (Topics 8–11) and
 * `Foundation 3 Past Papers` (Topics 12–17) — 40 sat papers — and tabulating
 * every section instruction, its mark allocation, its item shape and its
 * option count. It is a model of the assessment, not a description of one: the
 * generator is handed a section plan from here and told to fill it, rather
 * than being asked to imitate a style.
 *
 * What the survey found, because the template that preceded it got most of it
 * wrong:
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
 * The second pass over the same 73 pages — the one this file's current shape
 * comes from — was about COVERAGE. The first read modelled the sections a
 * paper is most likely to open with and stopped there, so four archetypes
 * carried every generated paper and eleven real section types had no
 * representation at all: the question-word fill that runs through Topics 1–6,
 * the plain-form conversion that IS the Topic 10 paper, the て-form/ない-form
 * table, the kanji-radical composition items that head four separate kanji
 * papers, the English→katakana transcription that closes most of them, the
 * a〜c comprehension questions the Foundation 3 papers ask about their own
 * passages. A student sitting a generated paper met four of the course's
 * fifteen question types. They now meet a plan drawn from all of them, chosen
 * for the topic and rotated between sittings — see `planPaper`.
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
  /** Stable id, used by the plan, by the history table and by the tests. */
  id: string;
  /** The instruction exactly as the papers print it. */
  instructionJa: string;
  /** The English line the papers print under it, where they print one. */
  instructionEn: string;
  form: ItemForm;
  /** Options per item, as the plan asks for them. Only meaningful for bracket
   * and lettered forms. */
  choices?: number;
  /** Option counts the real sections print, when more than one is attested.
   * The validator accepts any of these; the plan asks for `choices`. Papers
   * are not consistent here — the Topic 9 bracket prints two options and the
   * Topic 11 bracket three — and rejecting an item for picking the other
   * attested count threw away good questions. */
  choiceCounts?: number[];
  /** Marks per item, as printed beside the instruction. */
  marks: number;
  /** Items the real sections carry, as [min, max]. */
  items: [number, number];
  /** The section shares one word list; each entry may be used once. */
  wordBank?: boolean;
  /** The section opens with a passage its items are about. */
  passage?: boolean;
  /** This section's passage is the one the section ABOVE already printed —
   * 「上の文について」, which is how the papers write it. The generator repeats
   * the text so the section can be graded on its own, and the app prints it
   * once and refers to it the second time. A sharing section is only ever
   * planned directly after a section that owns a passage. */
  sharesPassage?: boolean;
  /** An 例 line showing the expected answer format, as the papers do. */
  example?: boolean;
  /** What the generator is told this section is FOR — the testing objective,
   * which is also what the duplicate check treats as the item's target. */
  objective: string;
  /** The knowledge axis this section tests, in one hyphenated word. Printed
   * into the plan so the generator can be told, concretely, that no two
   * sections may drill the same thing; also stored on the history row. */
  skill: string;
  /** How the real papers build this section's items, and — for the choice
   * forms — how they build the WRONG ones. Generic distractor advice produces
   * generically bad distractors: the particle sections and the kanji-lookalike
   * sections fail a student in completely different ways. */
  guidance: string;
  /** Sections of this type counted across the 73 transcribed pages. Drives
   * which sections a paper is planned from — the commonest first. */
  weight: number;
  /** Where this section sits on the printed paper: the quick in-place items
   * open, the word bank sits in the middle carrying the marks, the passage
   * closes. Reproducing that order is most of what makes a generated paper
   * feel like the printed one. */
  order: number;
  /** On nearly every paper of this level and kind, so every plan carries it. */
  always?: boolean;
  /** The earliest topic whose paper could ask this — the point in the course
   * where the material exists. A Topic 3 paper cannot test plain form. */
  fromTopic?: number;
  /** The last topic that still asks it. The question-word sections run out
   * once the course moves past 〜は何ですか. */
  toTopic?: number;
  /** Topics this archetype was observed on, so the report and the tests can
   * point at the evidence rather than at an assertion. */
  seenOn: string;
}

/* ------------------------------------------------------------------------ */
/* Foundation 2 — grammar                                                    */
/*                                                                           */
/* Level F2 in the corpus is the "Foundation 1 & 2" book, Topics 1–10, and    */
/* the papers filed under it run Topics 1–11.                                */
/* ------------------------------------------------------------------------ */

const F2_GRAMMAR: SectionArchetype[] = [
  {
    id: "f2g_bracket",
    instructionJa: "正しいほうを選んで、〇を書いてください。",
    instructionEn: "Choose the appropriate answer from the options given in each bracket.",
    form: "bracket",
    choices: 3,
    choiceCounts: [2, 3],
    marks: 1,
    items: [4, 6],
    skill: "particle-choice",
    objective:
      "particles and question words chosen in place, with two or three options printed inside the sentence",
    guidance:
      "The sentence is one line of ordinary student life — a class, a bus, a shop, a dormitory. Wrong options are the particle a student of this topic would actually reach for: に against で against を in a frame where both are grammatical Japanese, は against が, から against まで, ぐらい against ごろ. Never an option ruled out by shape alone.",
    weight: 8,
    order: 10,
    always: true,
    seenOn: "T1 I, T3 I, T4 I, T5 I, T6 I, T7 I, T9 I, T11 I",
  },
  {
    id: "f2g_question_word",
    instructionJa: "＿＿に正しい疑問詞《ぎもんし》をひらがなで書いてください。",
    instructionEn: "Fill in each blank with the appropriate Question Word in HIRAGANA.",
    form: "written",
    marks: 1,
    items: [3, 5],
    example: true,
    skill: "question-word",
    objective:
      "the question word a sentence needs — なに, どこ, いつ, だれ, どうして, いくら, なんじ, どんな, どちら",
    guidance:
      "Every item is a two-line Q&A: the question carries the gap and the ANSWER LINE below it is what decides which question word fits. Write both — 「Q：しゅみは（　）ですか。 A：えいがです。」 — or the item has several right answers. The answer is the question word alone, in hiragana.",
    weight: 5,
    order: 20,
    toTopic: 8,
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
    skill: "verb-conjugation",
    objective: "conjugating a verb from a shared word bank into the form the sentence needs",
    guidance:
      "Each sentence must FORCE one form and one word: 〜まえに wants the dictionary form, 〜てください the て-form, 〜ないでください the ない-form, 〜たいです the stem. Two sentences that would accept the same bank word are one question asked twice. The bank prints polite dictionary forms (ききます, のみます) and the answer is the conjugated form the gap needs.",
    weight: 5,
    order: 40,
    always: true,
    fromTopic: 4,
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
    skill: "meaning-equivalence",
    objective:
      "reading a short statement and choosing the sentence that means the same thing — tests 〜しか〜ない, 〜だけ, counters",
    guidance:
      "The question is a statement of fact — a count, a quantity, a restriction — and the options are three sentences about it, only one of which follows. The wrong two are the arithmetic a student gets wrong when they misread 〜しか〜ない as 〜だけ, or subtract when they should not. All three options are grammatical; only one is true.",
    weight: 3,
    order: 30,
    fromTopic: 8,
    seenOn: "T8 II, T11 II",
  },
  {
    id: "f2g_dialogue",
    instructionJa: "会話《かいわ》を完成《かんせい》させてください。",
    instructionEn: "Complete the dialogues.",
    form: "written",
    marks: 1,
    items: [3, 4],
    example: true,
    skill: "dialogue-response",
    objective: "supplying the missing turn of a two-line exchange",
    guidance:
      "Print A's line in full and leave B's answer as the gap, with the opening word given so exactly one answer fits: 「A：カレーはからかったですか。 B：いいえ、ぜんぜん（　）。」 wants からくなかったです and nothing else. An exchange that could be answered ten ways cannot be marked — the cue word (いいえ / とても / ぜんぜん / あまり) is what makes it one.",
    weight: 5,
    order: 50,
    seenOn: "T1 II, T2 II, T7 III, T8 III, T10 III",
  },
  {
    id: "f2g_plain_form",
    instructionJa: "下の文を plain フォームに変《か》えてください。",
    instructionEn: "Change the underlined words into the plain form.",
    form: "written",
    marks: 1,
    items: [4, 6],
    example: true,
    skill: "plain-form",
    objective:
      "rewriting a polite predicate in the plain form — verbs, い-adjectives, な-adjectives and nouns, present and past, affirmative and negative",
    guidance:
      "One short polite sentence an item, with the predicate wrapped in 【 】; the answer is that predicate alone in plain form. Spread the items over the four predicate types and both tenses — 「うんどうします → うんどうする」, 「ねました → ねた」, 「ありません → ない」, 「いたかったです → いたかった」, 「静かでした → 静かだった」, 「先生です → 先生だ」 — because the whole difficulty of this section is that nouns and な-adjectives do not behave like verbs.",
    weight: 2,
    order: 15,
    fromTopic: 10,
    seenOn: "T10 I (on both sat Topic 10 papers)",
  },
  {
    id: "f2g_form_table",
    instructionJa: "例《れい》のように、＿＿の動詞《どうし》の形《かたち》をひらがなで書いてください。",
    instructionEn: "Write the form of each underlined verb in Hiragana as in the example.",
    form: "written",
    marks: 1,
    items: [5, 8],
    example: true,
    skill: "verb-form-drill",
    objective:
      "the て-form and the ない-form of a listed verb, drilled straight rather than inside a sentence",
    guidance:
      "The item is the verb and the form asked for, nothing else: 「【たちます】の て form」 → たって. Cover all three verb groups and the irregulars — う/つ/る → って, む/ぶ/ぬ → んで, く → いて, ぐ → いで, す → して, plus きます and します — because this section exists to catch the student who learned one group's rule and applied it to every verb.",
    weight: 2,
    order: 25,
    fromTopic: 9,
    seenOn: "T9 II (0.5×18=9, a nine-verb て/ない table)",
  },
  {
    id: "f2g_restate",
    instructionJa: "例《れい》のように、二つの文が同《おな》じ意味《いみ》になるように書いてください。",
    instructionEn: "Complete the sentence so that the two sentences keep the same meaning.",
    form: "written",
    marks: 1,
    items: [3, 4],
    example: true,
    skill: "perspective-swap",
    objective:
      "rewriting a sentence from the other participant's side — あげます/もらいます, かします/かります, おしえます/ならいます",
    guidance:
      "Give the first sentence in full and the second with its verb missing, subjects already swapped: 「石田さんはボブさんに本をかりました。⇒ ボブさんは石田さんに本を（　）。」 The answer is the paired verb in the same tense and politeness. The pairs come from the giving-and-receiving topic; the trap is the direction, so never use the same pair twice.",
    weight: 2,
    order: 35,
    fromTopic: 6,
    seenOn: "T6 IV (あげます/もらいます, かします/かります, おしえます/ならいます)",
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
    skill: "reading-comprehension",
    objective: "reading comprehension of a short passage",
    guidance:
      "The passage is a first-person day: where the writer goes, how, how long it takes, what it costs, who with. The × statements change ONE fact the passage states — the transport, the place, the number, the direction — so the student has to have read the sentence that contradicts it. A statement the passage simply does not mention cannot be marked ×.",
    weight: 5,
    order: 90,
    always: true,
    fromTopic: 4,
    seenOn: "T4 V, T5 V, T7 VII, T9 V, T10 V",
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
    skill: "kanji-reading",
    objective: "reading a kanji word marked inside a sentence",
    guidance:
      "The word sits in a sentence, not on its own, and the sentence is what fixes the reading: 今日 is きょう here and こんにち nowhere in this course. Mark exactly the word asked about with 【 】 and give no furigana on it. Prefer words whose reading a learner gets wrong — compounds, counters, dates, 一日/一人/今日.",
    weight: 6,
    order: 20,
    always: true,
    seenOn: "T3 III, T7 III, T8 II, T8 IV, T10 IV-1",
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
    skill: "kanji-writing",
    objective: "writing a vocabulary word in kanji in the sentence that needs it",
    guidance:
      "The bank prints the words in hiragana (and the loanwords in katakana); the answer is the same word written in kanji. Each sentence must admit exactly one of them. The katakana entries are answered unchanged — the papers say so explicitly, and they are there to check the student knows which words are NOT written in kanji.",
    weight: 4,
    order: 40,
    always: true,
    fromTopic: 5,
    seenOn: "T5 III, T8 III, T9 I, T9 II",
  },
  // NOT MODELLED: the kanji-radical composition section.
  //
  // It is real and it is common — 「【言】＋【売】→【読】( よみます )」 heads
  // the Topic 4, 6, 7 and 8 kanji papers — and it was in this catalogue until
  // a live run against the corpus copy produced 「【木】＋【本】→ 本」, which is
  // not a decomposition of anything. Asked for five of these, the model wrote
  // five items and got the composition wrong in every one, because it is not
  // reading a radical table, it is guessing at a character's parts from its
  // shape.
  //
  // A wrong item here is worse than an absent one in a way the other faults
  // are not: it is not unanswerable, it is answerable and wrong, and the
  // student has no way to know. Marking a student down for writing the right
  // character is the one thing a practice paper must never do. It belongs
  // with the picture items in the exclusion list at the top of this file
  // until there is a decomposition table to check an answer against.
  {
    id: "f2k_katakana",
    instructionJa: "つぎの英語《えいご》をカタカナで書いてください。",
    instructionEn: "Write the following English words in Katakana.",
    form: "written",
    marks: 1,
    items: [3, 6],
    skill: "katakana-transcription",
    objective:
      "writing an English loanword the course teaches in katakana — クイズ, パーティー, カレンダー, クリニック",
    guidance:
      "The item is the English word alone. Choose only loanwords that appear in the excerpts, and prefer the ones whose katakana a learner gets wrong: long vowels (パーティー, コーヒー), small kana (キャンパス, シャツ), ッ (クッキー), and the ラ/リ/ル row. The answer is the katakana; give no answer_kana.",
    weight: 5,
    order: 60,
    seenOn: "T3 IV, T5 I, T7 V, T10 IV-3, T11 III-1",
  },
  {
    id: "f2k_katakana_spelling",
    instructionJa: "正しい答《こた》えに〇を書いてください。",
    instructionEn: "Circle the correctly spelled word.",
    form: "lettered",
    choices: 4,
    marks: 1,
    items: [3, 4],
    skill: "katakana-spelling",
    objective:
      "telling a correctly spelled katakana word from three near-misses — ランドリー against ランドーリ, ラントリー, ラントーリ",
    guidance:
      "All four options are the same word; three of them are wrong in exactly one way — the long mark in the wrong place or missing, ッ dropped, a voiced consonant unvoiced, ラ against ロ. That is the whole point of the section, so options that differ in more than one feature make it too easy.",
    weight: 1,
    order: 65,
    fromTopic: 5,
    seenOn: "T9 III (ランドリー, キッチン, アイロン)",
  },
  {
    id: "f2k_lettered",
    instructionJa: "正しい答《こた》えは a〜d のどれですか。",
    instructionEn: "Which of a–d is correct?",
    form: "lettered",
    choices: 4,
    choiceCounts: [4, 5],
    marks: 1,
    items: [3, 4],
    skill: "word-choice",
    objective:
      "choosing the right word for a situation from four listed candidates — symptoms, verbs, related vocabulary",
    guidance:
      "The question is the situation and the options are the words: 「ぼうしを（　）」 against きます・はきます・かけます・かぶります. The wrong options are the other members of the same set — the verbs for wearing, the words for symptoms — so the student has to know which one goes with THIS noun, which is exactly what the course drills.",
    weight: 2,
    order: 50,
    fromTopic: 10,
    seenOn: "T10 II, T10 III",
  },
  {
    id: "f2k_opposite",
    instructionJa: "例《れい》のように、反対《はんたい》の意味《いみ》のことばを選んでください。",
    instructionEn: "Choose the word with the opposite meaning, as in the example.",
    form: "lettered",
    // Three, not four. The Topic 5 paper prints (a しずか(な) b ふるい c ちいさい)
    // under every item; the four-option version of this section does not exist
    // in the corpus and asking for one produced a section nobody sat.
    choices: 3,
    marks: 1,
    items: [4, 6],
    example: true,
    skill: "antonym",
    objective: "adjective antonym pairs — 高い/安い, 新しい/古い, ひろい/せまい",
    guidance:
      "The question is one adjective and the three options are adjectives too: the true opposite, one from the same semantic field that is not its opposite (おいしい against つまらない), and one that is merely negative (よくない). Keep な-adjectives marked (な) as the papers do.",
    weight: 1,
    order: 55,
    fromTopic: 5,
    seenOn: "T5 II",
  },
  {
    id: "f2k_association",
    instructionJa:
      "【　】から (1)〜(4) に関係《かんけい》することばを選《えら》んで書いてください。",
    instructionEn:
      "Choose the word related to each of (1)–(4) from the list below, as in the example.",
    form: "written",
    marks: 1,
    items: [4, 5],
    wordBank: true,
    example: true,
    skill: "word-category",
    objective:
      "naming the category a word belongs to — しお→ちょうみりょう, りんご→くだもの, にんじん→やさい",
    guidance:
      "The item is one everyday word and the answer is its category from the bank. Include one bank word that fits nothing, as the papers do. Every item must belong to a different category, or two items are the same question.",
    weight: 2,
    order: 45,
    fromTopic: 7,
    seenOn: "T7 IV, T7 II",
  },
  {
    id: "f2k_bracket",
    instructionJa: "正しいほうを選《えら》んで、〇を書いてください。",
    instructionEn: "Circle the correct one.",
    form: "bracket",
    choices: 2,
    choiceCounts: [2, 3],
    marks: 1,
    items: [4, 6],
    skill: "kanji-discrimination",
    objective:
      "telling two similar kanji or two readings apart in place — 待つ/持つ, はやい 早い/速い",
    guidance:
      "The two options are the pair a learner confuses, printed inside the sentence, and the sentence is what decides: 早い is time and 速い is speed, 待つ waits and 持つ holds. Pairs that look alike (待/持, 分/今, 休/体) or sound alike but are written differently are what this section is for.",
    weight: 2,
    order: 30,
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
    skill: "conversation-conjugation",
    objective:
      "carrying a conversation across several turns while conjugating each word from the bank to fit — the dominant Foundation 3 grammar item",
    guidance:
      "Write the dialogue as the passage, with each gap numbered, and let the two speakers carry a real situation to its end — a lost student card, a job interview, a move to Tokyo. Each gap must be forced by the grammar around it: 〜たところです wants the past, 〜ておきます the て-form, 〜そうです the stem, 〜ば the conditional. The bank mixes verbs and adjectives, and one or two of its entries fit nothing.",
    weight: 5,
    order: 20,
    always: true,
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
    skill: "narrative-conjugation",
    objective: "filling the gaps in a first-person account with correctly conjugated verbs",
    guidance:
      "The passage is one person telling a short story — a part-time job, a winter, a move — and the gaps are its verbs and adjectives. Unlike the dialogue section the pressure here comes from the narrative tense: what is finished takes the past, what is still true takes 〜ています, what nearly happened takes 〜ところでした.",
    weight: 4,
    order: 30,
    seenOn: "T15 II, T15 III, T16 I(1), T17 II",
  },
  {
    id: "f3g_bracket",
    instructionJa: "（　）の中で正しいものを1つ選《えら》んで、〇をつけてください。",
    instructionEn: "Choose the correct option in each bracket in the passage below.",
    form: "bracket",
    choices: 3,
    choiceCounts: [2, 3],
    marks: 2,
    items: [3, 5],
    // The Foundation 3 brackets are printed INSIDE a passage, not under
    // standalone sentences: 「日本ではくつを（ ぬいで・ぬがなくて・ぬがないで ）
    // 入ってはいけません」 sits in the middle of an account of a first visit to
    // a Japanese home. Modelling them as loose sentences was the single
    // biggest remaining difference between a generated F3 paper and a sat one.
    passage: true,
    skill: "pattern-discrimination",
    objective:
      "distinguishing Foundation 3 patterns in place inside a passage — 〜そうです/〜ようです, 〜ておく/〜てある, transitive against intransitive, 〜ないで/〜なくて",
    guidance:
      "Write the passage first, then site each bracket where the surrounding sentence makes exactly one option right. The three options are always the same pattern in competing forms — 入れて/入って, 並べて/並んで, 消して/消えて, 見えて/見て — which is the transitive-intransitive pair the topic teaches, or the two evidentials, or the three negatives. Never mix an option in from another point.",
    weight: 4,
    order: 10,
    // Not part of the spine, though it is on four of the six Foundation 3
    // grammar papers. It writes its own passage, and with the dialogue cloze
    // — which also writes one, and which every F3 paper has — it filled both
    // of a paper's two passage slots, so `f3g_cloze_bank` could never be
    // planned at all. The rotation reaches this section on two variants in
    // three; the narrative cloze it was crowding out is on the other.
    seenOn: "T12 2, T13 2(1), T14 2, T17 3-(1)",
  },
  {
    id: "f3g_passage_choice",
    instructionJa:
      "上の文について、次《つぎ》の質問《しつもん》に答《こた》えてください。答えを a、b、c から選《えら》んでください。",
    instructionEn:
      "Answer the following questions about the passage above. Choose one answer from a, b, c.",
    form: "lettered",
    choices: 3,
    marks: 2,
    items: [2, 3],
    passage: true,
    sharesPassage: true,
    skill: "passage-inference",
    objective:
      "answering a why- or which- question about the passage above from three candidate answers",
    guidance:
      "The question asks what happened, who did it, or why — 「だれがさいふを見つけましたか」, 「どうしてレンタカーをすすめましたか」 — and the three options are all things the passage mentions. The wrong two are true statements about the passage that do not answer THIS question, which is what makes it a reading test rather than a matching exercise.",
    weight: 3,
    order: 80,
    seenOn: "T12 1(2), T12 2(2) Q1–Q3, T13 2(2)",
  },
  {
    id: "f3g_passage_maru",
    instructionJa:
      "上の文について、正しいこたえに〇を、正しくないこたえに✕をしてください。",
    instructionEn:
      "Put ○ if the statement about the passage above is correct, and ✕ if it is not.",
    form: "maru_batsu",
    marks: 1,
    // Four is the commonest, but the Topic 15 earthquake paper runs to seven
    // and the Topic 17 housing one to four; the range is the papers'.
    items: [4, 7],
    passage: true,
    sharesPassage: true,
    skill: "reading-comprehension",
    objective: "comprehension of the passage the section above is built on",
    guidance:
      "Every statement must be decidable from the passage alone. A × statement contradicts a sentence that is actually there — it reverses an instruction, swaps two of the writer's preferences, or turns a 〜たほうがいい into a 〜てはいけません. Quote the deciding phrase in the explanation.",
    weight: 3,
    order: 90,
    always: true,
    seenOn: "T12 II, T15 V, T16 I(2), T17 Ⅳ",
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
    skill: "kanji-reading",
    objective:
      "reading marked kanji words inside a continuous passage rather than in isolation",
    guidance:
      "Write the passage first — a visit, a family, a weekend that went wrong — and mark the words inside it with 【 】. Compounds and honorific family words are what this section is for (ご夫婦, ご主人, 家族, 祖父), and the passage must be the thing that fixes the reading.",
    weight: 5,
    order: 20,
    always: true,
    seenOn: "T12 III(1), T13 I(1), T13 II(1), T16 IV, T17 I(1)",
  },
  {
    id: "f3k_mixed",
    instructionJa:
      "下の(1)から(7)の漢字《かんじ》をひらがなで、ひらがなを漢字《かんじ》で、英語《えいご》をカタカナで書いてください。",
    instructionEn:
      "Write the kanji in hiragana, the hiragana in kanji, and the English in katakana.",
    form: "written",
    marks: 1,
    items: [6, 8],
    skill: "kanji-both-directions",
    objective:
      "reading, writing and transcription drilled together in one numbered run, all directions mixed",
    guidance:
      "One numbered list with the three directions interleaved, exactly as the papers print it: a kanji word to read (海 → うみ), a hiragana word to write in kanji (にもつ → 荷物), and an English word to transcribe (apartment → アパート). Say which direction each item wants in its question, and never ask the same word twice in two directions.",
    weight: 3,
    order: 40,
    seenOn: "T13 II, T14 III, T17 II(1)",
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
    skill: "kanji-writing",
    objective: "choosing the right kanji for a context and giving its reading",
    guidance:
      "The bank holds single characters and short compounds; the answer is the word the sentence needs written with one of them, and answer_kana its reading. The bank must contain characters that would fit the sentence's shape but not its meaning — 店/店員, 回/目 — because choosing between them is the section.",
    weight: 3,
    order: 50,
    always: true,
    seenOn: "T12 I, T16 II",
  },
  {
    id: "f3k_passage_bank",
    instructionJa:
      "下の文の（　）に、＿＿からことばを選《えら》んで入れてください。ことばは1回しか使えません。",
    instructionEn:
      "Fill each ( ) in the passage below with a word from the box. Each word may be used only once.",
    form: "written",
    marks: 1,
    items: [4, 6],
    wordBank: true,
    passage: true,
    skill: "vocabulary-in-context",
    objective:
      "placing the right vocabulary word into a continuous text — the second half of the Foundation 3 kanji paper, where the words listed above are put to work",
    guidance:
      "The passage is a letter or a diary entry; each gap takes one word from the bank and the sentence around it is what chooses. This is a vocabulary section, not a conjugation one: the words go in as they are printed. Gaps must be far enough apart that no two are decided by the same sentence.",
    weight: 3,
    order: 60,
    seenOn: "T13 II-(2), T15 II, T17 II(2)",
  },
  {
    id: "f3k_pair_verbs",
    instructionJa:
      "例《れい》のように、動詞《どうし》を漢字で書いて、読み方をひらがなで書いてください。",
    instructionEn:
      "Write the verb in Kanji and its reading in Hiragana, as in the example.",
    form: "written",
    marks: 1,
    items: [4, 6],
    example: true,
    skill: "verb-pairs",
    objective:
      "the paired transitive and intransitive verbs written in kanji with their readings — 開けます/閉めます, 始まります/終わります, 入ります/出ます",
    guidance:
      "Items come in opposed pairs and the sentence names which side: 「ドアを（　）けます」 against 「ドアを（　）めます」. The answer is the kanji, answer_kana the whole reading. The pairs are the ones the topic teaches; ask both halves of a pair or neither, because half a pair is not what the section tests.",
    weight: 1,
    order: 45,
    seenOn: "T14 II",
  },
  {
    id: "f3k_definition",
    instructionJa: "例《れい》のように正しいことばを選《えら》んで、（　）に書いてください。",
    instructionEn: "Choose the correct word for each description and write it in ( ).",
    form: "written",
    marks: 1,
    items: [4, 5],
    wordBank: true,
    example: true,
    skill: "definition-to-word",
    objective:
      "naming the thing a Japanese description defines — 「食事をする所」→ レストラン, 「空港で見せる物」→ パスポート",
    guidance:
      "The question is a one-line definition in Japanese, written with vocabulary earlier than the word it defines, and the answer is the word from the bank. Definitions must not share a give-away noun: two items both ending 〜を入れる物 are one question. Include one bank word that fits no definition.",
    weight: 1,
    order: 15,
    seenOn: "T14 I",
  },
  {
    id: "f3k_bracket",
    instructionJa: "正しいほうを選《えら》んでください。",
    instructionEn: "Circle the correct answer.",
    form: "bracket",
    choices: 2,
    marks: 1,
    items: [4, 5],
    skill: "kanji-discrimination",
    objective: "telling apart two similar kanji or two readings of the same character",
    guidance:
      "The pair is what a learner confuses on the page: two characters that differ by one stroke or one component (待/持, 貸/借, 開/閉), or the on- and kun-readings of one character in two contexts. The sentence must make exactly one of them possible.",
    weight: 2,
    order: 30,
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

/** The option counts this section's items may legitimately print. */
export function allowedChoiceCounts(archetype: SectionArchetype): number[] {
  if (archetype.choiceCounts?.length) return archetype.choiceCounts;
  return archetype.choices ? [archetype.choices] : [];
}

/** Could a paper on this topic have carried this section?
 *
 * A Topic 3 paper cannot ask for the plain form, because the course has not
 * taught it — and a generated paper that does is not a practice paper, it is a
 * paper the student is entitled to get wrong. A whole-book test (topic null)
 * is scoped to the book, so everything in the catalogue is fair game.
 */
export function fitsTopic(archetype: SectionArchetype, topic: number | null): boolean {
  if (topic === null) return true;
  if (archetype.fromTopic !== undefined && topic < archetype.fromTopic) return false;
  if (archetype.toTopic !== undefined && topic > archetype.toTopic) return false;
  return true;
}

/** How many 問題 a paper of this level and kind carries.
 *
 * Four. The sat papers run to between three and seven, but the ones with six
 * and seven get there with picture tasks and open writing this app cannot
 * mark, and the schema caps a paper at five sections. Four machine-markable
 * 問題 is the most paper that can honestly be built.
 */
const SECTIONS_PER_PAPER = 4;

/** Which sections a paper is built from, in the order the papers print them.
 *
 * Not a random sample of the catalogue and not a fixed list either. The fixed
 * list was the previous version's mistake: four archetypes were hard-coded per
 * level and kind, so a student could sit ten generated Foundation 2 grammar
 * papers and never once meet the question-word section that runs through
 * Topics 1–6, or the plain-form conversion that is the whole of the Topic 10
 * paper. The other eleven section types in this file existed and were never
 * used.
 *
 * So a plan is built in three parts:
 *
 *   the spine   the sections that are on nearly every paper of this level and
 *               kind (`always`), minus any the topic rules out;
 *   rotation    the remaining eligible archetypes, heaviest first, offset by
 *               `variant` so consecutive papers draw different ones;
 *   order       the whole plan sorted into the position the papers print
 *               these sections in.
 *
 * `variant` is what makes the rotation move. The route derives it from the
 * number of papers the student has already sat, so their second paper on a
 * topic is a different paper and not a reshuffle of the first.
 */
export function planPaper(
  level: Level,
  kind: QuizKind,
  options: { topic?: number | null; variant?: number } = {},
): SectionArchetype[] {
  const { topic = null, variant = 0 } = options;
  const eligible = archetypes(level, kind).filter((a) => fitsTopic(a, topic));

  const spine = eligible.filter((a) => a.always);
  const rest = eligible
    .filter((a) => !a.always)
    .sort((a, b) => b.weight - a.weight || a.order - b.order);

  const plan = [...spine];
  const slots = Math.max(0, SECTIONS_PER_PAPER - plan.length);
  // Rotate rather than shuffle: rotation is deterministic given the variant,
  // which is what lets a test say "the second paper differs from the first"
  // and lets a bug be reproduced from the row in quiz_items.
  const offset = rest.length > 0 ? ((variant % rest.length) + rest.length) % rest.length : 0;
  for (let i = 0; i < slots && i < rest.length; i++) {
    plan.push(rest[(offset + i) % rest.length]);
  }

  return orderPlan(finishPassages(plan, rest));
}

/** Sort a plan into the order the papers print these sections in, keeping a
 * passage-sharing section immediately after the section whose text it refers
 * to. The sharers carry high `order` values because 「上の文について」 always
 * closes the block it belongs to. */
function orderPlan(plan: SectionArchetype[]): SectionArchetype[] {
  return [...plan].sort((a, b) => a.order - b.order);
}

/** Keep a plan's passages to what one paper can carry, and its references
 * honest.
 *
 * Two rules, both from the printed papers:
 *
 *   at most two sections write their own text. Three would be a reading exam,
 *   and the model has a fixed output budget — a third 220-character passage
 *   is bought out of the questions.
 *
 *   a section that says 「上の文について」 must have a section above it that
 *   wrote a text. Planned alone it asks about a passage nobody printed, which
 *   is the exact fault the route's passage gate throws whole papers away for.
 */
function finishPassages(
  plan: SectionArchetype[],
  rest: SectionArchetype[],
): SectionArchetype[] {
  const owns = (a: SectionArchetype) => Boolean(a.passage) && !a.sharesPassage;
  let kept = [...plan];

  const owners = kept.filter(owns);
  if (owners.length > 2) {
    const allowed = new Set(orderPlan(owners).slice(0, 2).map((a) => a.id));
    kept = kept.filter((a) => !owns(a) || allowed.has(a.id));
  }

  if (!kept.some(owns)) {
    kept = kept.filter((a) => !a.sharesPassage);
  }

  // Anything dropped above leaves the paper a section short; refill from the
  // archetypes the rotation did not reach, cheapest first — a section without
  // a passage, because the passages are why we are here.
  const inPlan = new Set(kept.map((a) => a.id));
  for (const candidate of rest) {
    if (kept.length >= SECTIONS_PER_PAPER) break;
    if (inPlan.has(candidate.id)) continue;
    // A section that writes its own text is what we were over budget on. One
    // that only refers to the text above it costs nothing extra and is how
    // the papers close a passage block, so it is a legitimate refill.
    if (owns(candidate)) continue;
    if (candidate.sharesPassage && !kept.some(owns)) continue;
    kept.push(candidate);
    inPlan.add(candidate.id);
  }
  return kept;
}

/** The plan for a paper, with no topic and no rotation.
 *
 * Kept because the format catalogue is read in places that have neither — the
 * tests, the admin view — and because `planPaper(level, kind)` with default
 * options is exactly this.
 */
export function blueprint(level: Level, kind: QuizKind): SectionArchetype[] {
  return planPaper(level, kind);
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

/** How long a sentence on this course's papers actually runs.
 *
 * Measured over the transcribed papers, counting the Japanese characters of
 * an item's sentence with furigana and answer brackets removed. It is in the
 * prompt because difficulty in a Japanese paper is mostly length: a Foundation
 * 2 item is one clause and a Foundation 3 item is two joined by a connective,
 * and a generator left to its own devices writes the same middling sentence
 * for both.
 */
export const SENTENCE_LENGTH: Record<Level, { min: number; max: number; note: string }> = {
  F2: {
    min: 10,
    max: 30,
    note: "one clause, occasionally two joined by ですが or から; no relative clauses",
  },
  F3: {
    min: 20,
    max: 55,
    note: "two or three clauses joined by ので, のに, たら, ば, とき, or a relative clause before the noun",
  },
};
