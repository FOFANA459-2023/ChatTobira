/** Structure for a chat answer, parsed out of the model's Markdown.
 *
 * The chat used to render answers as one pre-wrapped string, so a vocabulary
 * list arrived on screen as a wall of literal `###`, `*` and 《》 — the raw
 * markup the model wrote, none of it doing anything. Answers are laid out
 * like a page of the textbook instead: ruled section headings, numbered
 * two-column word lists, real tables, furigana above the kanji.
 *
 * A hand-rolled subset rather than a Markdown library because this runs in a
 * Worker on every answer, the model's output is a narrow, prompt-controlled
 * dialect, and one block type here (`terms`) does not exist in Markdown at
 * all: a run of `word: meaning` bullets IS the textbook's word list, and it
 * only reads like one when it is set as a table.
 *
 * Every function must survive PARTIAL input: this parses on every streamed
 * frame, so half a table, an unclosed **bold** and a heading with no body yet
 * are all normal states rather than errors.
 */

export interface TermEntry {
  term: string;
  gloss: string;
}

/** One option of a multiple-choice question, and whether it is the answer. */
export interface QuizChoice {
  text: string;
  correct: boolean;
}

export interface QuizQuestion {
  prompt: string;
  choices: QuizChoice[];
  /** Why that answer is the answer. Shown only after the student has chosen,
   * so it teaches rather than giving the game away. */
  explanation?: string;
}

export type AnswerBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "terms"; items: TermEntry[] }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "quiz"; questions: QuizQuestion[] }
  | { kind: "paragraph"; text: string }
  | { kind: "rule" };

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*$/;
const LIST_RE = /^(\s*)(?:[-*+]|(\d{1,3})[.)])\s+(.*)$/;
const RULE_RE = /^\s{0,3}(?:-\s*-\s*-[-\s]*|\*\s*\*\s*\*[*\s]*|_\s*_\s*_[_\s]*)$/;
/** A fence, with whatever the model labelled it. The label is the only thing
 * that tells a quiz apart from a code block, and the quiz is the one block in
 * an answer that is not prose. */
const FENCE_RE = /^\s*```(.*)$/;
const QUIZ_FENCE_RE = /^quiz\b/i;
/** A table's delimiter row: pipes, dashes and alignment colons only. */
const TABLE_DIVIDER_RE = /^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|?\s*$/;

/** Term and gloss are separated by the first colon of either width. The
 * full-width ：is what a Japanese IME produces and what the transcribed
 * material uses, and it is written tight against the word it follows — so
 * the space after the colon cannot be required. */
const TERM_RE = /^(.+?)\s*[:：]\s*(.+)$/;

/** Longer than a word or a short phrase and the "term" is really a sentence
 * that happens to contain a colon — prose, not a word-list entry. */
const MAX_TERM_CHARS = 28;

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** A bullet reads as a word-list entry when it is `term: gloss` and the term
 * is short enough to be a word rather than a sentence. Prose bullets ("Use
 * this pattern when: …") must stay bullets, so a term ending a sentence is
 * rejected too. */
function termEntry(item: string): TermEntry | null {
  const match = TERM_RE.exec(item);
  if (!match) return null;
  const term = match[1].trim();
  const gloss = match[2].trim();
  if (!term || !gloss) return null;
  if (term.length > MAX_TERM_CHARS) return null;
  if (/[。.!?！？]$/.test(term)) return null;
  return { term, gloss };
}

/** A run of bullets becomes a word list only when EVERY item is one. A mixed
 * run is prose with some definitions in it, and setting half of it as a table
 * loses the half that is not. */
function asTerms(items: string[]): TermEntry[] | null {
  if (items.length < 2) return null;
  const entries = items.map(termEntry);
  return entries.every((entry): entry is TermEntry => entry !== null) ? entries : null;
}

/** Is the break between these two lines a wrap rather than a line break?
 *
 * Models hard-wrap English prose at whatever width they were trained on, and
 * a preserved wrap reads as a paragraph of stubby lines — visible in the
 * study coach, which writes three paragraphs of English. A wrap is assumed
 * only in the case that is unambiguous: a line ending mid-sentence in Latin
 * text, continued by more Latin text. Anything ending in sentence
 * punctuation stays broken, and Japanese is never rejoined — 食べる → 食べます
 * on one line with 飲む → 飲みます on the next is a table, not a wrap.
 */
function joinsOn(previous: string, next: string): boolean {
  return /[A-Za-z,]$/.test(previous.trimEnd()) && /^[A-Za-z]/.test(next.trimStart());
}

/** One option: a task-list bullet, ticked when it is the answer.
 *
 * `- [x]` rather than an invented marker because it is the one "this one is
 * the right one" notation every model already writes without being taught,
 * and a model that improvises here hands the student a quiz with the answers
 * printed beside the questions.
 */
const QUIZ_CHOICE_RE = /^\s*[-*+]\s*\[([ xX])\]\s*(.+?)\s*$/;

/** The line of teaching under a question. */
const QUIZ_WHY_RE = /^\s*(?:E|Why|解説|理由)\s*[:：]\s*(.+?)\s*$/i;

/** A question's own numbering and label, which the renderer supplies
 * itself. Bold markers come off with it: a model asked for `Q:` writes
 * `**Q:**` often enough that leaving it would print the asterisks. */
const QUIZ_NUMBER_RE =
  /^\s*(?:\*\*)?\s*(?:(?:Q|問題?)\s*\d*\s*[.):：]|\d{1,2}\s*[.)、])(?:\*\*)?\s*/i;

/** `**Q:** 1. どちら` carries two of those at once — the label the prompt
 * asked for and the numbering it did not — so one pass is not enough. */
function stripQuestionLabel(text: string): string {
  const once = text.replace(QUIZ_NUMBER_RE, "").trim();
  return once === text ? once : once.replace(QUIZ_NUMBER_RE, "").trim();
}

/** A label the model lettered itself — "a) に", "1. に", "①に". The app
 * prints the letters, and a student should not be offered "a. b) に". */
const QUIZ_LABEL_RE = /^(?:[a-zA-Z\d][.):、]|[①-⑩])\s*/;

/** The questions inside a ```quiz fence.
 *
 * `closed` is whether the closing fence has arrived, and it decides whether
 * the LAST question is shown. That is the whole reason this is not a plain
 * loop: the parser runs on every streamed frame, so the final question is
 * usually half-written — two of its four options on screen and the third
 * still arriving. A student who clicks one of those two is answering a
 * question that does not exist yet. So a question appears once something
 * after it has begun — the next question, or the closing fence — or once it
 * has reached its explanation, which is the last line a question has.
 */
function parseQuiz(body: string[], closed: boolean): QuizQuestion[] {
  const questions: QuizQuestion[] = [];
  let current: QuizQuestion | null = null;

  const finish = () => {
    // Two options is the floor for a choice. A "question" with fewer is the
    // model writing prose inside the fence, and it is dropped rather than
    // shown as an exercise with nothing to pick.
    if (current && current.prompt && current.choices.length >= 2) questions.push(current);
    current = null;
  };

  for (const line of body) {
    if (!line.trim()) continue;

    const choice = QUIZ_CHOICE_RE.exec(line);
    if (choice) {
      if (!current) current = { prompt: "", choices: [] };
      current.choices.push({
        text: choice[2].trim().replace(QUIZ_LABEL_RE, "").trim(),
        correct: choice[1].toLowerCase() === "x",
      });
      continue;
    }

    const why = QUIZ_WHY_RE.exec(line);
    if (why && current) {
      current.explanation = why[1].trim();
      continue;
    }

    // Anything else is question text: a new question when one is already
    // under way, otherwise more of the one being written.
    if (current && current.choices.length > 0) finish();
    const text = stripQuestionLabel(line.trim());
    if (!text) continue;
    if (!current) current = { prompt: text, choices: [] };
    else current.prompt = current.prompt ? `${current.prompt}\n${text}` : text;
  }

  if (closed || current?.explanation) finish();
  return questions;
}

export function parseAnswer(markdown: string): AnswerBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: AnswerBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // Fenced code: models occasionally wrap a conjugation table in one. The
    // fence is not content, and an unclosed fence — every fence, mid-stream —
    // must still show the lines it has so far.
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const isQuiz = QUIZ_FENCE_RE.test(fence[1].trim());
      i += 1;
      const body: string[] = [];
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      const closed = i < lines.length;
      i += 1;
      if (isQuiz) {
        const questions = parseQuiz(body, closed);
        const previous = blocks.at(-1);
        // No complete question yet is normal mid-stream, and it must render
        // as nothing rather than as the markup it currently is.
        if (questions.length === 0) continue;
        // Asked for three questions, models write three fences as often as
        // one. Back to back they are one set — shown as three they repeat
        // the heading, restart the numbering at 1 each time, and score each
        // question out of one. Fences with teaching between them stay apart,
        // which is the case the separation is actually for.
        if (previous?.kind === "quiz") previous.questions.push(...questions);
        else blocks.push({ kind: "quiz", questions });
        continue;
      }
      if (body.join("\n").trim()) blocks.push({ kind: "paragraph", text: body.join("\n") });
      continue;
    }

    if (RULE_RE.test(line)) {
      blocks.push({ kind: "rule" });
      i += 1;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 3) as 1 | 2 | 3;
      blocks.push({ kind: "heading", level, text: heading[2].trim() });
      i += 1;
      continue;
    }

    // Table: a row of cells confirmed by the delimiter row beneath it.
    // Without that confirmation, a line containing a pipe is just a line.
    if (line.includes("|") && i + 1 < lines.length && TABLE_DIVIDER_RE.test(lines[i + 1])) {
      const head = tableCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        rows.push(tableCells(lines[i]));
        i += 1;
      }
      blocks.push({ kind: "table", head, rows });
      continue;
    }

    if (LIST_RE.test(line)) {
      const ordered = LIST_RE.exec(line)![2] !== undefined;
      const items: string[] = [];
      while (i < lines.length) {
        const match = LIST_RE.exec(lines[i]);
        if (match) {
          items.push(match[3].trim());
          i += 1;
          continue;
        }
        // A wrapped continuation line belongs to the item above it; a blank
        // line, or anything else, ends the list.
        if (items.length > 0 && lines[i].trim() && /^\s{2,}\S/.test(lines[i])) {
          items[items.length - 1] = `${items[items.length - 1]} ${lines[i].trim()}`;
          i += 1;
          continue;
        }
        break;
      }
      const terms = asTerms(items);
      blocks.push(terms ? { kind: "terms", items: terms } : { kind: "list", ordered, items });
      continue;
    }

    // Paragraph: runs to the next blank line or block start. Newlines inside
    // are KEPT — the prompt asks for one example sentence per line, and
    // reflowing those into a block of prose is exactly what the book does
    // not do. The exception is a hard-wrapped English sentence (`joinsOn`
    // below), which is one sentence the model happened to break in two.
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim()) {
      const next = lines[i];
      if (
        paragraph.length > 0 &&
        (HEADING_RE.test(next) ||
          RULE_RE.test(next) ||
          LIST_RE.test(next) ||
          FENCE_RE.test(next))
      ) {
        break;
      }
      // Blockquote markers: the model sometimes quotes the book. The quote is
      // the content; the marker is scaffolding.
      paragraph.push(next.replace(/^\s{0,3}>\s?/, ""));
      i += 1;
    }
    const flowed = paragraph.reduce(
      (text, line, at) =>
        at === 0
          ? line
          : `${text}${joinsOn(paragraph[at - 1], line) ? " " : "\n"}${line.trim()}`,
      "",
    );
    if (flowed.trim()) {
      blocks.push({ kind: "paragraph", text: flowed.trim() });
    }
  }

  return blocks;
}

export interface InlineSegment {
  text: string;
  bold: boolean;
}

/** Split **bold** runs. Only completed pairs count, so a half-streamed `**か`
 * renders as the literal characters it currently is instead of flickering the
 * rest of the answer into bold. */
export function splitBold(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  const bold = /\*\*([^*\n]+)\*\*/g;
  let last = 0;
  for (const match of text.matchAll(bold)) {
    if (match.index > last) segments.push({ text: text.slice(last, match.index), bold: false });
    segments.push({ text: match[1], bold: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), bold: false });
  return segments.length > 0 ? segments : [{ text, bold: false }];
}

/** Split a heading into the Japanese label and the English gloss the prompt
 * asks for in parentheses — 「語彙 (Vocabulary)」. The book sets the two at
 * different weights, and so does the renderer. */
export function splitHeading(text: string): { label: string; gloss?: string } {
  const match = /^(.+?)\s*[（(]([^）)]+)[）)]\s*$/.exec(text.trim());
  if (!match) return { label: text.trim() };
  // Furigana, not a gloss: 語彙（ごい） is one word, not a heading plus a
  // translation of it.
  if (/^[ぁ-ゖァ-ヶー]+$/.test(match[2])) return { label: text.trim() };
  return { label: match[1].trim(), gloss: match[2].trim() };
}
