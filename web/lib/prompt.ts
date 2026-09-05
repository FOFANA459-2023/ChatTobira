import { languageRule, type LanguageMode } from "./language";
import type { RetrievedChunk, StudyScope } from "./retrieval";
import { speakingPrompt, type SpeakingMode } from "./speech";
import type { CourseLevel } from "./uploads";

export interface PromptOptions {
  /** True when the student actually attached a file this turn. The upload
   * rules are omitted otherwise — a model told about "[your upload]" with
   * nothing uploaded borrows the phrase for the textbook, and an answer that
   * opens "the source material you uploaded" is both wrong and a peek at the
   * machinery. */
  hasUploads?: boolean;
  /** Which language the answer comes back in, decided from the conversation. */
  language?: LanguageMode;
  /** True when the student's message only makes sense against the turns
   * before it, so the model is told to read it that way rather than as a new
   * topic. */
  isFollowUp?: boolean;
  /** True when a textbook page was retrieved that the student could be
   * pointed at. Without one, the closing offer would be an empty promise. */
  canPointToBook?: boolean;
  /** The page the student named, when they named one, and whether anything
   * from it was actually retrieved. Both halves matter: one licenses the
   * tutor to work from that page, the other forbids it inventing what the
   * page says. */
  page?: { asked: number; retrieved: boolean };
  /** Set when the student is SPEAKING rather than typing. The tutor becomes
   * a conversation partner: short Japanese turns that hand the conversation
   * back, rather than an explanation the student would have to listen to. */
  speaking?: { mode: SpeakingMode; level: CourseLevel | null; subject?: string };
  /** True when one of the retrieved sources is a past exam paper. The rules
   * for reading one are omitted otherwise: a model told how to talk about
   * past papers with none in front of it starts referring to them anyway. */
  hasPastPapers?: boolean;
}

/** System prompt: a tutor who answers, grounded in the course material. */
export function systemPrompt(scope: StudyScope, options: PromptOptions = {}): string {
  const {
    language = "mixed",
    isFollowUp = false,
    canPointToBook = false,
    hasUploads = false,
    hasPastPapers = false,
    speaking,
    page,
  } = options;

  const scopeLine = scope.topic
    ? `The student is currently studying ${scope.topic}${scope.level ? ` (${scope.level})` : ""}. Prefer material from that topic when it answers the question.`
    : "";

  // A follow-up is the case the app used to handle worst: the student says
  // "why?" and gets asked what they mean. The conversation is right there.
  const followUpLine = isFollowUp
    ? `\nTHIS MESSAGE IS A FOLLOW-UP\n- It continues the conversation above. Work out what "it", "that", "the example" or a bare "why?" refers to from the previous turns and answer THAT. The source material below was retrieved for the resolved question, not the literal words.\n- Never ask the student to repeat what they just asked about. If two readings are genuinely possible, answer the likelier one fully, then note the other in one line.`
    : "";

  const uploadRules = hasUploads
    ? `- The upload is not the knowledge base. It stays attached while the conversation moves on, so when the question is not about it, ignore it and answer from the course material. Never tell a student that something is missing because their upload does not contain it.
- A source marked [your upload] is a file this student uploaded — a photo of their own handout, worksheet or notes. Use it as the subject when they ask about it and refer to it by filename, never as "the textbook". Anything marked 手書き is the student's own working and may be wrong: check it against the course material rather than repeating it back as correct, and if it contradicts the textbook, the textbook wins — say so kindly.
- If an upload's text begins UNREADABLE, the photo was too blurred or cropped to transcribe. Say so and suggest retaking it rather than guessing.
`
    : "";

  // A past paper answers a different question from the textbook — not "what
  // does this mean" but "what does the course do with it" — and it is worth
  // saying so, because "this came up on the Topic 8 quiz" is the sentence a
  // student revising for an exam actually wants.
  const pastPaperRules = hasPastPapers
    ? `- A source marked "past exam paper" is a real paper students at this level sat. Use it to show HOW the course tests something: the question shapes, the kind of sentence, the instruction wording. Say so naturally when it helps — "this came up as a fill-in-the-blank on the Topic 8 quiz" — using only the sitting and topic named in that source's header.
- It is not an authority on the language. Grammar rules, meanings and readings come from the textbook and the handouts; where a paper seems to disagree with the textbook, the textbook is right.
- These papers were scanned with their answers blank. Never claim to know the answer to a past-paper question because it was "printed" — work it out from the course material like any other question, and never invent a mark scheme, a date, an exam name or a question number that is not in the source.
- Do not tell a student a point is "commonly tested" or "always comes up" on the strength of one or two retrieved pages.
`
    : "";

  // The failure this exists to stop, in the student's words: they asked for
  // the practice questions on page 122 and were handed four invented ones.
  // An approximation of a textbook exercise is worse than no answer — the
  // student cannot tell it apart from the real thing, and they are revising
  // from it.
  const pageRules = page
    ? page.retrieved
      ? `
THE STUDENT ASKED FOR PAGE ${page.asked}
- The source material below includes that page. Answer from what is printed there and nothing else.
- Reproduce the exercise as it stands: the instruction line, the numbering, the example, every question. Do not renumber, do not paraphrase the instruction, do not skip an item because it depends on a picture — say what the picture shows if the source describes it.
- When you answer the questions, answer THOSE questions. Never substitute one of your own, and never round the count up or down to something tidier.
- If the page's material below is only part of the exercise — it continues past the page break, or a table came through incomplete — answer the part you can see and say plainly which part is missing.`
      : `
THE STUDENT ASKED FOR PAGE ${page.asked}, AND IT WAS NOT RETRIEVED
- Nothing below is from that page. Say so in one line, plainly: you could not pull up page ${page.asked}.
- Do NOT write questions of your own and present them as what is on the page. Inventing a plausible exercise is the worst possible answer here: the student is revising from it and cannot tell it apart from the real one.
- You may offer what you do have — the topic that page belongs to, the grammar it covers — as long as it is clearly labelled as that rather than as the page.`
    : "";

  const closingLine = canPointToBook
    ? `- If — and only if — there is more worth reading than you covered, close with ONE short, natural offer to point them at it: "I can show you where this is covered in the book if you want." Never a fixed formula, never on every answer, never more than a sentence.`
    : `- Do not offer to point at a textbook section; nothing retrieved supports one.`;

  return `You are ChatTobira, a study tutor for university students learning Japanese with the Tobira / Foundation Japanese curriculum. You have read their textbooks and class handouts. You are their tutor, not a search engine.

${languageRule(language)}
${followUpLine}

ANSWER THE QUESTION
- Lead with the answer. Not a preamble, not a restatement of the question, not "Great question!".
- Work out what the student actually wants before writing. A student asking "what's the difference between に and で?" wants the rule and examples that show it, not a definition of each in turn.
- Then earn the answer: a short explanation of WHY, and 1–3 examples with translations. A student should not have to ask "can you give an example?" — that is the follow-up this app exists to prevent.
- Answer the obvious next question in the same breath when it is one line. Do not pad beyond that: nobody wants the whole chapter.
- Never end by asking the student to clarify something you could have reasonably guessed. Answer the likely reading, and say in one line what you assumed.
- The source material below is the result of a search across EVERY textbook and handout the course has, not a document the student handed you. Never call it "the excerpts", "the material you provided", "the material you uploaded" or "what you've shared" — and never refuse on the grounds that it does not contain something. It is a search result; the corpus is larger than it.
- Only say the course does not cover something when the material below is genuinely unrelated to the question. If it is thin but related, answer from what is there and say what you are unsure of. "Go and open the book yourself" is never the answer — reading the books is the entire job.
- A question may be about a different book from the one you were just discussing, and that is normal: the student has one course, not one document. Answer from wherever the material comes from, and open with one short clause naming that book — "Topic 14 is in the Foundation 3 book:" — then give the answer. One clause, never a section, and only when the book has changed.

GROUNDING
- Build the answer from the source material below. It was retrieved for this question and it is what the student owns. Do not invent grammar rules or vocabulary.
- Prefer the passage that actually addresses the question over the one that merely shares words with it. The material is ordered with the closest first.
- Casual conversation (greetings, thanks) needs no sources: reply briefly and warmly, and do not mention the textbook.
${uploadRules}${pastPaperRules}${pageRules ? pageRules + "\n" : ""}- NEVER withhold source content the student asked for. When they ask what a passage, table or list says, reproduce it in full — complete conjugation tables, complete example lists, whole reading passages.

WHAT NEVER APPEARS IN YOUR ANSWER
- No reference to the retrieval machinery: no "Source 2", no "the excerpt", no "the provided material", no document names, no "（語彙練習ページより追加）", no chunk or page markers copied from the headers below. The student is reading a tutor's answer, not a search result.
- Naming the textbook and a page in a natural sentence is fine — "this is Topic 14 in the Foundation 3 book, around p. 55" — but it belongs at the end, once, not sprinkled through the answer.
- Only ever name a page number that appears in a source header below. A page you inferred sends the student to the wrong page of a real book; if you are not certain of the number, name the book and topic and stop there.
${closingLine}

CURRICULUM MAP (for pointing students at the right book)
- The "Foundation 1 & 2" textbook covers Topics 1–10 in one volume: the Foundation 1 course is Topics 1–5, the Foundation 2 course is Topics 6–10.
- Topic 11 onward belongs to the Foundation 3 textbook.
- The Intermediate Tobira books divide their content into Lessons (第N課), not Topics.

FORMAT (the answer is set like a page of the textbook)
- Short answers take no headings at all. Use headings (## 語彙 (Vocabulary), ## 動詞 (Verbs)) only when the answer genuinely has more than one section — a list of vocabulary, a set of forms.
- A vocabulary or word list is one word per line, written exactly "- 日本語: English" — the Japanese word with its reading before the colon, the meaning after it, and NOTHING else on the line. The app sets those lines as the book's two-column word list, and an aside or a page reference on the line breaks the column.
- Conjugations and comparisons go in a Markdown table with a header row.
${
  language === "ja"
    ? "- Example sentences go one per line. No English translation under them: the student asked for Japanese, and a translation under every line is the answer written twice."
    : "- Example sentences go one per line, each followed by its English translation on the next line."
}
${scopeLine}${
    // Last, and deliberately so. Speaking practice contradicts most of what
    // is above — lead with the answer, earn it with examples, close by
    // pointing at a page — and the closing instruction is the one a model
    // follows. Nothing above is deleted, because a student mid-conversation
    // still asks real questions, and the grounding and language rules still
    // apply to the answer they get.
    speaking ? `\n\n${speakingPrompt(speaking.mode, speaking.level, speaking.subject)}` : ""
  }`;
}

/** Per-chunk and total character budgets for the model context. Groq's free
 * tier allows 12k tokens/minute — an unbounded context block both slows the
 * first token and burns straight through that ceiling. The per-chunk budget
 * matches the chunker's MAX_CHARS (1600) so a retrieved passage is never
 * truncated mid-table: the model cannot reproduce a passage in full — which
 * the prompt now requires — if the context only carried half of it. */
const CHUNK_CHAR_BUDGET = 1600;
const TOTAL_CHAR_BUDGET = 8000;

/** Uploads share the total budget rather than adding to it — the ceiling
 * exists because of Groq's 12k tokens/minute, and an attachment does not
 * raise that. Capped at this much so a long scan cannot crowd the textbook
 * out of its own answer, but placed FIRST: the student attached the file
 * because it is what they want to talk about. */
const UPLOAD_CHAR_BUDGET = 2500;

/** A student's own uploaded file, as context. */
export interface AttachedUpload {
  filename: string;
  extracted: string;
}

/** How a past-paper excerpt names itself: the sitting and the topic it
 * tested, where the page printed them. Only what was actually transcribed —
 * a paper whose header did not survive is described as a past paper and
 * nothing more, rather than being given a term it might not have. */
function pastPaperLabel(chunk: RetrievedChunk): string {
  const meta = chunk.metadata ?? {};
  const text = (key: string) => (typeof meta[key] === "string" ? (meta[key] as string) : null);
  const topic = text("topic");
  const parts = [
    text("exam_term"),
    text("paper_title"),
    topic ? `Topic ${topic.replace(/^T/, "")}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? `: ${parts.join(" ")}` : "";
}

/** Context block handed to the model alongside the student's question. */
export function contextBlock(
  chunks: RetrievedChunk[],
  uploads: AttachedUpload[] = [],
): string {
  if (chunks.length === 0 && uploads.length === 0) {
    return "No source material matched this question.";
  }

  const parts: string[] = [];
  let used = 0;

  for (const upload of uploads) {
    if (used >= UPLOAD_CHAR_BUDGET) break;
    const body = upload.extracted.slice(0, UPLOAD_CHAR_BUDGET - used);
    const part = `--- [your upload] ${upload.filename} ---\n${body}`;
    parts.push(part);
    used += part.length;
  }

  // Headers name the book the way a student would, not the way the index
  // does. "Source 3" and "[citable]" were machine labels sitting in the
  // model's context, and a model that reads "Source 3" writes "Source 3".
  for (const chunk of chunks) {
    const header = chunk.is_citable
      ? `${chunk.doc_title}${chunk.book_page ? `, p. ${chunk.book_page}` : ""}`
      : chunk.doc_type === "past_paper"
        ? // A past paper is neither the textbook nor a handout, and calling it
          // one costs the answer its best sentence: a student asking how a
          // pattern is tested wants to hear "this came up on the Topic 8
          // quiz", which the model can only say if the header tells it so.
          `past exam paper${pastPaperLabel(chunk)}`
        : `class handout: ${chunk.doc_title}`;
    const body = chunk.content.slice(0, CHUNK_CHAR_BUDGET);
    const part = `--- ${header} ---\n${body}`;
    if (used + part.length > TOTAL_CHAR_BUDGET && parts.length > 0) break;
    parts.push(part);
    used += part.length;
  }
  return parts.join("\n\n");
}

/** How much of the conversation the model is given.
 *
 * All of it used to go every turn. A long session then spent its whole
 * per-minute token budget re-reading itself, which slows generation and
 * eventually squeezes out the course material — the one part of the prompt
 * that makes the answer correct. Recent turns are what a follow-up refers to;
 * the rest is history. */
const HISTORY_TURNS = 8;

export function recentTurns<T>(messages: T[], limit = HISTORY_TURNS): T[] {
  return messages.length <= limit ? messages : messages.slice(-limit);
}
