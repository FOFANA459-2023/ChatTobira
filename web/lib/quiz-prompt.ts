/** Everything the model is told before it writes a paper.
 *
 * Lifted out of `app/api/quiz/route.ts`, which had grown to hold the paper
 * plan, the distractor rules, the furigana rule, the provenance rule and the
 * excerpt formatting inline between a quota check and a provider cascade. Two
 * things were wrong with that. The prompt could not be exercised without a
 * request, a session and three API keys — so the only way to see what the
 * model was actually asked was an environment variable that printed it to the
 * server log. And the harness that checks a generated paper against the real
 * corpus could not build the same prompt the app builds, which makes it a
 * harness for something else.
 *
 * Everything here is a pure function of its arguments. The route supplies the
 * corpus, the harness supplies the same corpus out of a fixture, and both get
 * the same prompt.
 */

import {
  allowedChoiceCounts,
  instructionLanguage,
  markLine,
  SENTENCE_LENGTH,
  type Level,
  type SectionArchetype,
} from "./paper-format";
import { exemplarProvenance, paperIdentity, type ExemplarChunk, type QuizKind } from "./quiz";
import { houseStyleBlock, type HouseStyle } from "./textbook-usage";

/** The shortest reading passage a ○× section can be built on, and what the
 * plan asks for.
 *
 * One pair of constants used by BOTH the prompt and the validity gate, for the
 * same reason `ingest/redact.py` keeps its redactor and its detector in one
 * file: a rule enforced in one place and described in another drifts, and the
 * drift is silent. Here it was not even described — the gate rejected papers
 * for a requirement the model was never given.
 */
export const MIN_PASSAGE_CHARS = 150;
export const PASSAGE_TARGET_CHARS = 220;

export const SYSTEM = `You create Japanese practice tests for university students from
provided course material, in the format of the course's own test papers. Rules:
- Base every item ONLY on the provided material; test the grammar patterns and
  vocabulary that actually appear in it. The words, the sentence patterns and
  the spellings all come from the excerpts — where ordinary Japanese and the
  excerpts differ, the excerpts win, because the student can only revise from
  the book they own.
- The test is divided into numbered sections. Each section has instruction_ja —
  the polite Japanese instruction line exactly as it would appear on the paper,
  e.g. 「（　）に入る適切なことばを選んでください。」 — and instruction_en, a
  short English translation of that instruction.
- Japanese in Japanese script. Furigana (written 漢字（かんじ）) follows the
  scope rule in the request: students are expected to READ the kanji they have
  already been taught, so kanji taught at or before the tested scope carry NO
  furigana; only kanji from beyond the scope get furigana. Never put furigana
  on a word whose reading or writing is itself being tested.
- A reading is attached to the WHOLE word, once — 持ち物（もちもの）, 急ぐ（いそぐ）
  — never one reading per character (持《も》ち物《もの》 is wrong), and never on
  a word already written in kana.
- Write plain text everywhere: no Markdown, no asterisks for emphasis, no
  headings, no bullet characters. The app sets the paper; question,
  explanation, review and scope_description are prose and nothing else.
- Every section's shape — its instruction line, how many items it carries, how
  many options each item has, whether it has a word bank or a passage — is
  specified per section below. Follow it exactly; it is read off the papers
  this course sets, not invented.
- If a section's plan asks for a passage, that section MUST carry a "passage"
  field of at least ${PASSAGE_TARGET_CHARS} Japanese characters. This is the single
  commonest way a generated paper is thrown away: ○× statements about a
  passage that was never written refer to a text the student cannot see, so
  the app rejects the whole paper below ${MIN_PASSAGE_CHARS} characters. Write the
  passage first, then write statements about it.
- "type" is how the app grades the item and must match the section's form:
  form "bracket" and "lettered" are type "multiple_choice", form "written" is
  "fill_blank", form "maru_batsu" is "true_false".
- The answer of a choice item must be one of its own choices, character for
  character. An answer that is not on the list is the single commonest way a
  generated paper becomes unusable.
- explanation: one or two sentences on WHY, in simple English with the
  Japanese pattern or word named.
- review: for EVERY item, where in the TEXTBOOK the student should go to study
  this point. Students own the textbook and nothing else, so a review must be
  findable from the book alone: the division as the textbook prints it, the
  concept, and the page number from the excerpt header when one is shown.
  NEVER write "Material", "excerpt", "source", "handout", "past paper", or a
  numbered reference to the prompt. Identical points must use the identical
  review string so results aggregate.
- When an item asks about ONE specific word in a sentence (the word to
  conjugate, the word to read, the word to write in kanji), wrap exactly that
  word in 【 】 where it occurs — the app renders it underlined, matching the
  printed papers. Use ＿＿ only for a blank the student fills.
- scope_description: 1–2 sentences in English telling the student what this
  test covers — name the specific grammar points or vocabulary drilled, and
  the textbook or lesson area they come from.
- Never reference "the source", file names, or page numbers in questions or
  explanations; page numbers belong in review only.`;

/** The uniqueness rule, stated as concretely as it can be stated.
 *
 * Its own block because it is the rule most often broken and least often
 * broken obviously. A generator asked for twenty items from ten excerpts does
 * not usually repeat itself word for word; it drills 〜まえに in section I and
 * again in section III with the shop changed to a station, labels the second
 * one differently, and has — by its own lights — written a new question.
 *
 * The app drops those afterwards (lib/quiz-signature.ts), which costs the
 * paper its length. Asking properly is cheaper than filtering.
 */
function uniquenessRule(plan: SectionArchetype[], compact = false): string {
  const skills = [...new Set(plan.map((a) => a.skill))].join(", ");
  if (compact) {
    return `=== NO QUESTION MAY BE ASKED TWICE ===
The sections test ${skills}, and every item must test something different
again. Name it in "target" and check no earlier item on the paper — in ANY
section — already has it. The same sentence with the names or numbers changed
is the same question. Write a shorter section rather than repeat one.`;
  }
  return `=== NO QUESTION MAY BE ASKED TWICE ===
The sections of this paper test different things (${skills}), and every ITEM
inside them must test a different thing again. Before writing each item, name
the point it tests in "target" and check that no earlier item on the paper has
that target — across sections, not just within one.
Two items are the SAME question, and only one of them may be on the paper, if:
- they drill the same grammar pattern, particle, verb form or kanji word, even
  in different sections and even under different labels;
- one is the other with the names, numbers, places or nouns changed
  (「リーさんは7時に起きます」 and 「山田さんは9時に起きます」 are one question);
- a kanji word is asked for its READING in one section and its WRITING in
  another — that is one word tested twice.
Where you find yourself with nothing new to ask, write a shorter section. A
paper of twelve genuinely different questions is worth more than one of twenty
where six are the same six.`;
}

// How the course writes wrong answers, read off the sat papers.
//
// Distractors are the whole difficulty of a multiple-choice paper: four
// options a student can eliminate at a glance is a question that tests
// nothing. The papers build them from the mistakes their students actually
// make, and the two subjects do it differently. Each SECTION then adds its
// own rule on top of this — see `guidance` in lib/paper-format.ts — because
// the particle bracket and the katakana-spelling bracket fail a student in
// completely different ways.
export const DISTRACTORS: Record<QuizKind, string> = {
  grammar: `DISTRACTORS (how this course writes wrong grammar options)
Every wrong option must be a mistake a real student of this topic would make,
and must be wrong for a reason you could name:
- the wrong particle in a frame where several are plausible — に against で
  against を, は against が;
- the right pattern in the wrong form — dictionary form where the て-form is
  needed, past where present is needed, plain where polite is needed;
- a neighbouring pattern the topic teaches alongside this one — 〜ながら
  against 〜あとで, 〜そうです against 〜ようです, 〜ておく against 〜てある;
- a form that is grammatical Japanese but wrong for THIS sentence's meaning.
Never a nonsense string, never a word from a different part of speech, and
never an option a student could rule out without knowing the point.`,
  kanji: `DISTRACTORS (how this course writes wrong kanji options)
- readings that differ by one feature a learner confuses: voicing (かい/がい),
  long against short vowel (こうこく/こくこく), small kana (きゅ/きゆ),
  gemination (がっこう/がこう);
- the on-reading where the kun-reading is correct, and the reverse;
- kanji that look alike — 待/持, 券/巻, 話/語, 体/休;
- a real word of the right shape that means something else.
Never a made-up reading, and never a character the course has not taught.`,
};

/** The opening sentence of a guidance note — the one that says what the item
 * looks like, as opposed to why. */
function firstSentence(text: string): string {
  const stop = text.search(/[.:] /);
  return stop === -1 ? text : text.slice(0, stop + 1);
}

/** The distractor rules in three lines, for the free tier's prompt. */
const COMPACT_DISTRACTORS: Record<QuizKind, string> = {
  grammar: `DISTRACTORS: every wrong option is a mistake a student of this topic
would make — the wrong particle where several are plausible, the right pattern
in the wrong form, a neighbouring pattern the topic teaches alongside this one.
Never a nonsense string and never one a student could rule out without knowing
the point.`,
  kanji: `DISTRACTORS: every wrong option differs by one feature a learner
confuses — voicing, a long against a short vowel, small kana, gemination, the
on-reading where the kun-reading is right, or a character that looks alike
(待/持, 券/巻, 話/語). Never a made-up reading and never an untaught character.`,
};

/** How many items each planned section should be asked for.
 *
 * One more than the paper needs, because everything downstream takes items
 * AWAY: the duplicate check, the past-paper copy check, the validity gate and
 * the history check that stops "New Test" asking what the student was asked
 * last week. A section planned at exactly its target loses items to those and
 * comes up short — and a section that loses ALL of them disappears from the
 * paper entirely, which is how a four-section paper renders as three.
 *
 * Clamped to the archetype's own range, so this asks for a longer section only
 * where the real papers have one.
 */
export function itemsPerSection(archetype: SectionArchetype, requested: number): number {
  return Math.min(Math.max(requested, archetype.items[0]), archetype.items[1]);
}

/** The largest paper a provider will actually finish writing.
 *
 * Not a preference — a measurement, and the constraint is Groq's. Its free
 * tier meters prompt plus RESERVED output against 8,000 tokens a minute, and
 * with a ~3,200-token prompt that leaves 4,800 for the paper. A seventeen-item
 * paper with a 220-character passage lands at ~3,850 output tokens and fits;
 * a twenty-two-item one does not, and what comes back is not a shorter paper
 * but a truncated string in the middle of question three, which arrives as
 * invalid JSON and reads in the log as "could not parse the response".
 *
 * Seen on the local corpus copy: a 22-item ask returned 9 items in 2 sections
 * of a 4-section plan. The plan was right and the budget was not.
 */
export const MAX_ITEMS = 18;

/** How many items to ask each section for.
 *
 * One more than an even division, because everything downstream takes items
 * away — the duplicate checks, the past-paper copy check, the validity gate,
 * the grounding checks and the history check. Then walked back down until the
 * whole paper fits MAX_ITEMS, because a section's own minimum can push the
 * total past it and a paper that does not fit is not a shorter paper.
 */
export function itemsForPlan(plan: SectionArchetype[], requested: number): number {
  const even = Math.max(2, Math.round(requested / Math.max(1, plan.length)));
  for (let perSection = even + 1; perSection > 2; perSection--) {
    const total = plan.reduce((n, a) => n + itemsPerSection(a, perSection), 0);
    if (total <= MAX_ITEMS) return perSection;
  }
  return 2;
}

/** The paper's shape, section by section.
 *
 * It used to be two hardcoded four-section strings written by reading the
 * course's papers by hand. lib/paper-format.ts holds that reading as data
 * instead — every section archetype the sat papers use, with the instruction
 * line as printed, the marks it carries, how many items it runs to, how many
 * options it prints, and how its wrong answers are built — and a paper is
 * planned from it.
 */
export function sectionPlan(
  plan: SectionArchetype[],
  language: "en" | "ja+en" | "ja",
  perSection: number,
  level: Level,
  compact = false,
): string {
  const numerals = ["I", "II", "III", "IV", "V"];
  const lines = plan.map((archetype, index) => {
    const items = itemsPerSection(archetype, perSection);
    const counts = allowedChoiceCounts(archetype);
    const parts = [
      `Section ${numerals[index]} — ${archetype.objective}.`,
      `  tests: ${archetype.skill}. No other section on this paper may test it.`,
      `  instruction_ja: exactly 「${archetype.instructionJa}」`,
      `  instruction_en: ${
        language === "ja"
          ? "a short English translation of that line"
          : `exactly "${archetype.instructionEn}"`
      }`,
      `  form: "${archetype.form}", marks: ${archetype.marks}, ${items} items ${markLine(
        archetype.marks,
        items,
      )}`,
      // In compact form the guidance keeps its first sentence and loses the
      // rest. Dropping it entirely was tried and cost the sections their
      // shape: without 「print A's line and the answer line」 the free tier
      // wrote 「（　）どこで図書館に行きますか」 — the answer sitting beside its
      // own blank — for every item of the question-word section. The first
      // sentence is the one that says what the item looks like; the rest is
      // why, and the app re-checks the why anyway.
      `  how this course writes this section: ${
        compact ? firstSentence(archetype.guidance) : archetype.guidance
      }`,
    ];

    if (archetype.form === "bracket") {
      parts.push(
        `  Write ${archetype.choices} choices per item${
          counts.length > 1 ? ` (${counts.join(" or ")} are both attested)` : ""
        }. The app prints them inside the sentence as ( A / B / C ) for the student to circle, so the question text must NOT already contain the options — write the sentence with the gap where they go, and put the candidates in "choices" with the right one in "answer".`,
      );
    } else if (archetype.form === "lettered") {
      parts.push(
        `  Exactly ${archetype.choices} choices, listed under the question and labelled a. b. c. by the app. "answer" must be one of them, written identically.`,
      );
    } else if (archetype.form === "maru_batsu") {
      parts.push(
        // The length is stated because it is ENFORCED. The validator rejects a
        // paper whose passage is under MIN_PASSAGE_CHARS, and the plan used to
        // say only "this section's passage" — never that a passage field was
        // required, never how long. Every model guessed, and guessed short:
        // gpt-oss-120b wrote 113 characters and had the whole paper thrown
        // away for it. Asking for a margin above the floor rather than the
        // floor itself, because a model told "at least 150" writes 150.
        `  Set "passage" on this section: ${
          archetype.sharesPassage
            ? `the SAME text as the section above, repeated word for word (the app prints it once and heads this section 「上の文について」)`
            : `a Japanese text of EIGHT OR MORE SENTENCES and at least ${PASSAGE_TARGET_CHARS} characters, written from the course material, that all of this section's statements are about`
        }. The app rejects the paper below ${MIN_PASSAGE_CHARS} characters — count the sentences before you move on, because a four-sentence passage cannot carry ${items} independent statements and the whole section is thrown away.`,
        `  Each item is ONE statement about that passage; "answer" is exactly ○ or ×. Mix them. A × statement must be contradicted by the passage, not merely absent from it, and the explanation must quote the phrase that decides it.`,
      );
    } else {
      parts.push(
        `  The student writes the answer. Put the gap in the sentence as （　）. "answer" is exactly the text that fills it; add "answer_kana" when the answer contains kanji.`,
      );
      if (archetype.skill === "kanji-writing") {
        // Said twice, in both directions, because the model gets it backwards
        // — measured, five items out of five on one Foundation 3 kanji paper.
        // It reads a section whose whole point is 「ひらがなを漢字にします」 and
        // answers in hiragana, which both gives the answer away and marks the
        // student wrong for writing what the section asked for.
        parts.push(
          `  THIS SECTION IS ANSWERED IN KANJI. "answer" is the word WRITTEN IN KANJI (静か, 荷物, 店員) and "answer_kana" is its reading (しずか, にもつ, てんいん). Never the other way round: an answer in hiragana fails this section by definition. The one exception is a katakana word, which the paper says is written as it is.`,
        );
      }
      if (archetype.skill === "kanji-reading") {
        parts.push(
          `  THIS SECTION IS ANSWERED IN HIRAGANA. "answer" is the reading of the marked word and nothing else; do not repeat the kanji.`,
        );
      }
    }

    if (archetype.wordBank) {
      parts.push(
        `  Set "word_bank" on this section: ${items + 1}–${items + 2} words, printed in a box under the items. Every answer must be one of them${
          archetype.form === "written" && archetype.skill.includes("conjugation")
            ? ", conjugated to fit its sentence"
            : ""
        }, and NO word may answer two items — the paper says ことばは1回しか使えません and means it. Include one or two bank words that fit nothing, as the real papers do.`,
        // Script, not just word. The papers print their Foundation 2 banks in
        // hiragana and expect the answer back in hiragana; a model that reads
        // かります and answers 借りて has written an answer the student cannot
        // find in the box, and the validator cannot tell it apart from an
        // answer that came from nowhere. A live run lost all five items of
        // this section to exactly that.
        `  Write each answer in the SAME SCRIPT as its bank entry: if the bank prints かります the answer is かりて, not 借りて. Where the answer does contain kanji, give "answer_kana" as well.`,
      );
    }
    if (archetype.passage && archetype.form !== "maru_batsu") {
      parts.push(
        `  Set "passage" on this section: ${
          archetype.sharesPassage
            ? "the SAME text as the section above, repeated word for word."
            : `the text the items are about, written by you from the excerpts, ${PASSAGE_TARGET_CHARS}–400 characters. ${
                archetype.form === "written"
                  ? "The gaps live inside the passage as （　）, numbered in order; each item names which gap it is and quotes the clause around it so it can be answered on its own."
                  : "Each bracket sits inside the passage; each item quotes the clause its bracket is in."
              }`
        }`,
      );
    }
    if (archetype.example) {
      parts.push(
        `  Open instruction_ja with the paper's own 例 convention: the first item's question may show the worked example inline as 例) …, which is how the printed section teaches its answer format.`,
      );
    }
    parts.push(`  Set "target" on every item to the exact point it tests.`);
    return parts.join("\n");
  });

  const length = SENTENCE_LENGTH[level];
  return `Structure the paper as exactly ${plan.length} sections, in this order:

${lines.join("\n\n")}

SENTENCE CONSTRUCTION — measured on this course's own papers at this level:
a sentence an item is built on runs ${length.min}–${length.max} Japanese
characters: ${length.note}. Write about what the course writes about —
classes, the dormitory, buses and trains, part-time work, the canteen, a
weekend in Beppu — not about abstractions the book never mentions.`;
}

export interface PromptInput {
  bookTitle: string;
  /** 'F2' | 'F3' | 'INT' | null, as stored on the document. */
  documentLevel: string | null;
  /** The format level the paper is planned at; INT falls back to F3. */
  formatLevel: Level;
  kind: QuizKind;
  plan: SectionArchetype[];
  /** The lesson the paper is scoped to, or null for a whole-book paper. */
  topic: number | null;
  /** Formatted textbook excerpts — the only source of content. */
  excerpts: string;
  /** Past-paper pages, shown for form only. */
  exemplars: ExemplarChunk[];
  /** What this book's own wording looks like, measured. */
  style: HouseStyle;
  focus?: string;
  avoid?: string[];
  /** Items to ask for per section before the filters take some away. */
  perSection: number;
  /** Build the free tier's version: the same plan, without the prose that
   * teaches a model how the course writes.
   *
   * Groq's free tier meters prompt plus reserved output against one
   * 8,000-token-a-minute ceiling, and the full prompt does not fit beside a
   * paper — Foundation 3 grammar was refused outright with a 413. What comes
   * out first is the coaching: the per-section guidance on how this course
   * builds its distractors, the sentence-length measurements, the long form of
   * the uniqueness rule. The STRUCTURE stays, because the structure is what
   * makes a generated paper look like a sat one, and the app re-checks
   * everything the prose was asking for anyway. */
  compact?: boolean;
}

export interface BuiltPrompt {
  system: string;
  prompt: string;
  /** How many items the plan asks for, which is what the route's length gate
   * measures a returned paper against. */
  planned: number;
}

export function buildQuizPrompt(input: PromptInput): BuiltPrompt {
  const {
    bookTitle,
    documentLevel,
    formatLevel,
    kind,
    plan,
    topic,
    excerpts,
    exemplars,
    style,
    focus,
    avoid,
    perSection,
    compact = false,
  } = input;

  const language = instructionLanguage(formatLevel, topic);

  // The books name their divisions differently: the Foundation volumes are
  // split into "Topic 1, 2, …", the Intermediate Tobira volumes into
  // "Lesson 1, 2, …". Review references must use the word printed in the
  // student's own book or they cannot follow them.
  const division = /intermediate/i.test(bookTitle) ? "Lesson" : "Topic";

  const styleBlock = exemplars
    .map((chunk) => {
      const { topic: paperTopic, examTerm, paperTitle } = paperIdentity(chunk);
      const header = [examTerm, paperTitle, paperTopic ? `Topic ${paperTopic.slice(1)}` : null]
        .filter(Boolean)
        .join(" ");
      return `--- Past paper${header ? `: ${header}` : ""} ---\n${chunk.content.slice(0, 800)}`;
    })
    .join("\n\n");

  const provenance = exemplarProvenance(exemplars);

  // Furigana boundary: the tested lesson's own kanji are still being learned,
  // so THEY carry readings too — only lessons strictly below the scope go
  // bare. Scoped to Lesson 3: no furigana for Lessons 1–2, furigana on
  // everything from Lesson 3 up. A whole-book test annotates every kanji
  // word, the same rule with the whole book as the current material.
  const furiganaRule = `${
    topic
      ? `Furigana rule: this test is scoped to ${division} ${topic}.${
          topic > 1
            ? ` Write NO furigana
for kanji taught in ${division} 1 through ${division} ${topic - 1} —
students already read them.`
            : ""
        } EVERY kanji word from ${division} ${topic} itself
or beyond MUST carry its reading, written 漢字（かんじ） immediately after the
word — the app displays it as small hiragana above the kanji. This is
required, not optional: a test with no furigana anywhere is wrong.`
      : `Furigana rule: EVERY kanji word MUST carry its reading, written
漢字（かんじ） immediately after the word — the app displays it as small
hiragana above the kanji. This is required, not optional.`
  }
Exception: never annotate a word whose reading or writing is itself being
tested (it would give the answer away). The excerpts show the textbook's own
readings as 漢字《かんじ》 — rewrite them in the （ ） style, subject to the
rule above.`;

  // The two sources do different jobs and the prompt has to say so, or the
  // model treats the papers as a question bank: it lifts a sentence off a
  // past paper, and the student sits a test they have already seen with the
  // answers already marked on it. Content comes from the book; only the SHAPE
  // comes from the papers.
  const styleRules = styleBlock
    ? `
=== HOW THIS COURSE'S PAPERS LOOK (form only) ===
Pages from papers students at this level actually sat, shown for the shape of
the sentences and the pitch of the difficulty. They are deliberately from a
DIFFERENT topic than the one you are writing about — the format does not vary
by topic, so there is nothing here for you to reuse.
- NEVER reuse a sentence, question, word bank or passage from them. Every item
  you write is new, built from the textbook excerpts below.
- They are not a source of grammar or facts. Where a paper and the excerpts
  disagree, the excerpts are right.
- Their blanks are unfilled; yours carry the answer in the answer field.

${styleBlock}
`
    : "";

  // Only what was actually retrieved may be described. Without this the model
  // narrates an exam history it inferred — "as in previous final exams" — and
  // a student has no way to tell that from something the course said.
  const provenanceRule = styleBlock
    ? `\nIn scope_description you MAY note in one short clause that the paper follows
the style of the course's past papers${
        provenance.terms.length > 0 ? ` (${provenance.terms.join(", ")})` : ""
      }. Do not claim anything else about the exams: not that a point is
"commonly tested" or "frequently appears", not a date, not an exam name, not a
question number, not a mark scheme, unless it is printed in the reference
pages above. Never mention past papers in a question, a choice, an explanation
or a review reference.`
    : `\nSay nothing about past papers, previous exams or how the course tests this
material: none was retrieved, so anything you said about it would be invented.`;

  const planned = plan.reduce(
    (total, archetype) => total + itemsPerSection(archetype, perSection),
    0,
  );

  const house = houseStyleBlock(style);

  const prompt = `Create a practice test from the textbook excerpts below, all
from "${bookTitle}" — the book the student owns. Every question must be drawn
from these excerpts. This textbook divides its content into ${division}s: write
every review reference as "${division} N — concept (p. NN)", using the
${division} numbers and page numbers as printed in the excerpts.
${
  documentLevel && documentLevel !== "INT"
    ? `\nThis is a ${
        documentLevel === "F2" ? "Foundation 2" : "Foundation 3"
      } paper. Stay inside that level: test only grammar and vocabulary present
in the excerpts below, and never reach for a pattern from a later course
because it would fit the sentence better.`
    : ""
}
${furiganaRule}
Around ${planned} questions in total, distributed across the sections exactly as
the plan above specifies — each section has its own item count because each
carries its own marks. Focus on ${
    kind === "kanji"
      ? "the kanji and vocabulary that appear in these excerpts"
      : "the grammar patterns drilled in these excerpts"
  }.${
    focus
      ? `\nThe student asked the test to focus on: "${focus}". Keep every question
inside that scope, and say so in scope_description.`
      : ""
  }${
    avoid && avoid.length > 0
      ? `\nThe student just sat a paper with the questions below. Write COMPLETELY
different questions — different sentences, different target words, different
vocabulary — while staying inside the same material:\n${avoid
          .map((q) => `- ${q.slice(0, 200)}`)
          .join("\n")}`
      : ""
  }${provenanceRule}
${house ? `\n${house}\n` : ""}${styleRules}
=== TEXTBOOK EXCERPTS — THE ONLY SOURCE OF CONTENT ===
${excerpts}`;

  // The plan, the uniqueness rule and the distractor rules are all read off
  // the sat papers. The retrieved pages then show the model what that looks
  // like in print: the plan says "three options labelled a〜c", the exemplar
  // shows one.
  const system = `${SYSTEM}

${sectionPlan(plan, language, perSection, formatLevel, compact)}

${uniquenessRule(plan, compact)}

${compact ? COMPACT_DISTRACTORS[kind] : DISTRACTORS[kind]}${
    styleBlock
      ? `\n\nThe request below includes real past-paper pages. Where one prints
the instruction line for a section you are writing, prefer that wording over
the line specified above — it is what the students read on the day.`
      : ""
  }`;

  return { system, prompt, planned };
}
