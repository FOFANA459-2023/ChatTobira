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

export type AnswerBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "terms"; items: TermEntry[] }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "paragraph"; text: string }
  | { kind: "rule" };

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*$/;
const LIST_RE = /^(\s*)(?:[-*+]|(\d{1,3})[.)])\s+(.*)$/;
const RULE_RE = /^\s{0,3}(?:-\s*-\s*-[-\s]*|\*\s*\*\s*\*[*\s]*|_\s*_\s*_[_\s]*)$/;
const FENCE_RE = /^\s*```/;
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
    if (FENCE_RE.test(line)) {
      i += 1;
      const body: string[] = [];
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
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
