/** Turning a tutor's written answer into something worth listening to.
 *
 * The answers in this app are set like a page of the textbook: furigana in
 * brackets, Markdown tables of conjugations, two-column vocabulary lists,
 * page references. Read aloud verbatim that becomes
 * 「漢字 かっこ かんじ かっこ とじ」 — the reading spoken twice, then the
 * bracket announced — and a table read as a run of vertical bars.
 *
 * So speech gets its own text. Not a different answer: the same answer with
 * the things that exist only for the eye taken out.
 *
 * The other half of this file is the speaking-practice conversation itself —
 * which mode the student is in, and what that asks of the tutor. It lives
 * beside the text cleaning because both are about the difference between a
 * written answer and a spoken one.
 */

import type { ConversationLanguage } from "./conversation";
import type { CourseLevel } from "./uploads";

/* ------------------------------------------------------------------------ */
/* What a voice should say                                                    */
/* ------------------------------------------------------------------------ */

/** Furigana, in both spellings the app produces. The kanji stays and the
 * reading goes: a speech engine reads 漢字 correctly on its own, and reading
 * both gives the word twice. */
const FURIGANA = /《[^》]{0,12}》|[（(][ぁ-ゖァ-ヶー]{1,12}[）)]/g;

/** Markdown that is layout rather than language. */
const TABLE_ROW = /^\s*\|.*\|\s*$/gm;
const TABLE_RULE = /^\s*\|?[\s:|-]{4,}\|?\s*$/gm;
const HEADING = /^#{1,6}\s*/gm;
const BULLET = /^\s*[-*•]\s+/gm;
const EMPHASIS = /[*_`]{1,3}/g;

/** A page reference is for the eye — a student cannot act on "p. 112" while
 * listening, and it interrupts the sentence. */
const PAGE_REF = /[（(]?\s*(?:see\s+)?p+\.?\s*\d+[^）)\n]{0,12}[）)]?/gi;

/** The 【 】 the papers underline with, and the blanks they print. */
const MARKERS = /[【】]/g;
const BLANKS = /[＿_]{2,}/g;

/** How much of an answer is worth speaking.
 *
 * A cap rather than a truncation policy: in speaking practice the replies are
 * short by design, and this only bites when a student asks a grammar question
 * mid-conversation and gets a full explanation back. Reading four paragraphs
 * at a listener who wanted a sentence is worse than reading the first part
 * and letting them read the rest — which is on screen either way. */
export const SPEAKABLE_LIMIT = 600;

/** The answer as it should be heard. */
export function speakableText(markdown: string, limit = SPEAKABLE_LIMIT): string {
  const spoken = markdown
    .replace(TABLE_RULE, "")
    .replace(TABLE_ROW, (row) =>
      // A table still carries words worth hearing; the pipes do not.
      row.replace(/\|/g, "、").replace(/^、|、$/g, ""),
    )
    .replace(FURIGANA, "")
    .replace(HEADING, "")
    .replace(BULLET, "")
    .replace(EMPHASIS, "")
    .replace(PAGE_REF, "")
    .replace(MARKERS, "")
    .replace(BLANKS, "")
    // Collapse the blank lines the stripping leaves behind.
    .replace(/\n{2,}/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  if (spoken.length <= limit) return spoken;
  // Cut at a sentence end so the voice never stops mid-clause.
  const head = spoken.slice(0, limit);
  const lastStop = Math.max(head.lastIndexOf("。"), head.lastIndexOf("."), head.lastIndexOf("？"));
  return lastStop > limit * 0.5 ? head.slice(0, lastStop + 1) : head;
}

/** Split spoken text into clauses that can be synthesised independently.
 *
 * So the first clause can be played while the rest is still being made.
 * Measured against the live voice, the gain is real but smaller than the
 * shape of the idea suggests, because synthesis latency is mostly fixed cost
 * rather than per-character:
 *
 *   48 characters   ~5.4s        12 characters   ~4.3s
 *
 * — roughly a second, not the four the naive reading promises.
 *
 * The floor matters more than it looks. A clause of a few characters is not
 * merely a poor trade: 「いいですね！」 on its own came back from the service
 * with no audio at all. Twelve keeps a clause to something the length of a
 * real sentence, which is both reliable and the natural unit anyway; anything
 * shorter is folded into its neighbour rather than sent alone.
 */
export function sentences(text: string, minLength = 12): string[] {
  const parts = text
    // Japanese stops split on the mark itself; an English full stop only when
    // whitespace follows, so a decimal or an abbreviation stays whole.
    .split(/(?<=[。？！?!])\s*|(?<=\.)\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const clauses: string[] = [];
  for (const part of parts) {
    const previous = clauses[clauses.length - 1];
    if (previous !== undefined && previous.length < minLength) {
      clauses[clauses.length - 1] = `${previous} ${part}`;
    } else {
      clauses.push(part);
    }
  }
  return clauses.length > 0 ? clauses : [text];
}

/** The clauses of a partial answer that are safe to synthesise NOW.
 *
 * The voice used to wait for the whole answer before it said a word, because
 * `speak` was called from the chat transport's onFinish — the one callback
 * that by definition does not run until generation is over. So a spoken turn
 * spent the model's entire generation in silence and THEN spent three more
 * seconds in silence while the first clause was synthesised, and the two costs
 * were paid one after the other for no reason. They overlap perfectly well:
 * the first sentence of an answer is final long before the last one is
 * written, and synthesising it is the slowest thing left in the turn.
 *
 * What makes this safe is the `done` flag rather than any cleverness about
 * sentence boundaries. While an answer is still streaming the LAST clause is
 * still growing, and synthesising a clause that is about to get longer makes
 * the voice say half a sentence and then say the whole of it. So the last
 * clause is held back until the stream says there is no more coming; every
 * clause before it is finished by definition, because something was written
 * after it.
 *
 * `taken` is how many clauses the caller has already sent, so this returns
 * only what is new. Callers must not re-send: a clause synthesised twice is
 * paid for twice and, worse, heard twice.
 */
export function readyClauses(
  textSoFar: string,
  done: boolean,
  taken: number,
  minLength = 12,
): string[] {
  const spoken = speakableText(textSoFar);
  if (!spoken) return [];
  const clauses = sentences(spoken, minLength);
  // Mid-stream the tail is still being written. At the end it is the answer.
  const settled = done ? clauses : clauses.slice(0, -1);
  return settled.slice(taken);
}

/** How much of an answer the Listen button reads.
 *
 * Far more than SPEAKABLE_LIMIT, which is the budget for a reply spoken
 * UNASKED in a conversation. A student who presses Listen under an answer has
 * asked to hear that answer, and cutting it off at 600 characters is a voice
 * that stops half way through for no reason they can see. 2,400 is roughly
 * four minutes of speech: longer than anyone listens, shorter than a reply
 * the tutor would ever write.
 */
export const LISTEN_LIMIT = 2400;

/** Largest piece sent to the voice in one request — the /api/speak route
 * trims anything past SPEAKABLE_LIMIT, so a piece must fit inside it. */
const LISTEN_PIECE_MAX = SPEAKABLE_LIMIT;

/** The measured speed of the voice, at the slow end of what was seen. */
const AUDIO_MS_PER_CHAR = 125;
const SYNTH_BASE_MS = 4000;
const SYNTH_MS_PER_CHAR = 50;
/** The smallest each piece may be, by position: a doubling floor that keeps
 * requests under the project's ten-a-minute quota whatever the sentences. */
const MIN_PIECE = [0, 0, 60, 120, 240, 480, 600];
/** How long the prefetched opening piece may run. */
const OPENING_MAX = 60;

/** A finished answer, cut into the pieces the Listen button synthesises.
 *
 * One request per SENTENCE was the old unit, and it is why long answers
 * broke. The speech model allows ten requests a minute for the whole project
 * — measured, on every TTS model the key can see — so a long answer ran past
 * the limit part way through, the service answered 429, and the player handed
 * the rest of the reply to the browser's own voice: a different person
 * finishing the sentence, or, when that failed too, silence.
 *
 * So the pieces GROW, each sized to the audio already queued ahead of it.
 * Each piece is sized so that the two pieces playing ahead of it can hide its
 * synthesis — and the player actually keeps FOUR in flight, so in practice it
 * has three pieces of lead, one more than its size assumes. That spare piece
 * is deliberate: the live voice varies. Measured on it:
 *
 *   31 chars   synth  4.8s   audio  5.4s
 *   116 chars  synth 11.2s   audio 15.5s
 *   197 chars  synth 12.6s   audio 24.2s   (14.3s on a later run)
 *   314 chars  synth 16.5s   audio 38.1s
 *
 * — about 125ms of audio per character against 4s + 50ms per character of
 * synthesis. Long pieces run nearer 105ms of audio per character, which is
 * what the spare piece of lead is for. A fixed schedule
 * ("then 200, then 600") was tried first and left 6.2 seconds of silence
 * before its third piece, because two short opening sentences are only eight
 * seconds of audio. Sized this way, with a doubling floor under it for the
 * quota, a 700-character answer is six requests (27, 24, 52, 99, 293, 202
 * characters) and a 1,200-character one seven, instead of twenty to fifty.
 *
 * The opening piece is up to ~60 characters — usually two sentences — because
 * it is prefetched while the student reads and so costs no wait, and it has to
 * play long enough to hide the second piece, which is requested at the click
 * and kept to one sentence because nothing is playing yet to hide more.
 *
 * Pieces are whole sentences, never cut mid-clause. The prefetch in
 * useTextToSpeech synthesises `listenChunks(answer)[0]` — the same function,
 * so the prefetched audio is exactly the audio the click asks for.
 */
export function listenChunks(markdown: string): string[] {
  const spoken = speakableText(markdown, LISTEN_LIMIT);
  if (!spoken) return [];
  const clauses = sentences(spoken);

  const pieces: string[] = [];
  const budget = (index: number): number => {
    // The opening is prefetched while the student reads, so its synthesis
    // is free; what matters is that it plays long enough to hide the next
    // piece, which is requested at the click. One short sentence did not:
    // measured, 4.0s of audio against 5.5s to synthesise the sentence after
    // it. Up to ~60 characters (usually two sentences) is ~7s of audio.
    if (index === 0) return OPENING_MAX;
    if (index === 1) return 0; // a single sentence: nothing is playing yet to hide more
    // As long as the audio ahead can hide...
    const lead = AUDIO_MS_PER_CHAR * (pieces[index - 2].length + pieces[index - 1].length);
    const hidden = Math.floor((lead - SYNTH_BASE_MS) / SYNTH_MS_PER_CHAR);
    // ...but never smaller than the quota allows. Sized by lead alone, an
    // answer of short sentences never grows at all — each ~24-character
    // sentence is too little audio to hide two of them behind — and stays at
    // one request per sentence: 48 for a 1,200-character answer, against a
    // limit of ten a minute. The floor doubles regardless, which costs at most
    // a second's pause early on and keeps a long answer to about seven
    // requests.
    const floor = MIN_PIECE[Math.min(index, MIN_PIECE.length - 1)];
    return Math.min(LISTEN_PIECE_MAX, Math.max(hidden, floor));
  };

  for (const clause of clauses) {
    const index = pieces.length - 1;
    const current = pieces[index];
    if (current !== undefined && current.length + 1 + clause.length <= budget(index)) {
      pieces[index] = `${current} ${clause}`;
    } else {
      pieces.push(clause);
    }
  }
  return pieces;
}

/** One run of text in one language. */
export interface SpeechSegment {
  text: string;
  lang: "ja" | "en";
}

const JAPANESE = /[ぁ-ゖァ-ヶー一-鿿々〆〇、。！？「」『』]/;
const LATIN = /[A-Za-z]/;

/** Split spoken text into Japanese and English runs.
 *
 * The default answer in this app is bilingual — English explanation carrying
 * the Japanese the course actually uses — and one voice reading that mangles
 * whichever language it was not built for. A Japanese voice says "particle"
 * as 파티클; an English one reads 「食べます」 as a shrug.
 *
 * Only the browser's own speech engine needs this, because it can be handed a
 * language per utterance. The cloud voice handles mixed text on its own.
 */
export function speechSegments(text: string): SpeechSegment[] {
  const segments: SpeechSegment[] = [];
  let current: SpeechSegment | null = null;

  for (const char of text) {
    // Digits, spaces and shared punctuation belong to whatever run they are
    // inside; starting a new segment for a comma would chop every sentence.
    const lang = JAPANESE.test(char) ? "ja" : LATIN.test(char) ? "en" : null;
    if (current && (lang === null || lang === current.lang)) {
      current.text += char;
      continue;
    }
    if (lang === null) {
      // Leading punctuation with no run yet: hold it for the first one.
      current = { text: char, lang: "ja" };
      segments.push(current);
      continue;
    }
    current = { text: char, lang };
    segments.push(current);
  }

  return segments
    .map((segment) => ({ ...segment, text: segment.text.trim() }))
    .filter((segment) => segment.text.length > 0);
}

/* ------------------------------------------------------------------------ */
/* The conversation                                                           */
/* ------------------------------------------------------------------------ */

/** The speaking-practice modes.
 *
 * All four exist here so the pipeline never has to be rewritten to add one —
 * a mode is a prompt fragment and a label, and the voice loop, the retrieval
 * and the transcription know nothing about which is running. The UI exposes
 * free conversation first; the rest plug in behind a picker.
 */
export type SpeakingMode = "free" | "topic" | "roleplay" | "grammar";

export interface SpeakingModeSpec {
  id: SpeakingMode;
  label: string;
  labelJa: string;
  /** What the tutor is doing in this mode, added to the system prompt. */
  instruction: (subject?: string) => string;
  /** True when the mode is meaningless without a subject to practise. */
  needsSubject: boolean;
}

export const SPEAKING_MODES: Record<SpeakingMode, SpeakingModeSpec> = {
  free: {
    id: "free",
    label: "Free conversation",
    labelJa: "フリー会話",
    needsSubject: false,
    instruction: () =>
      "Talk with the student about whatever they raise. Follow their lead: ask about what they just said rather than changing the subject.",
  },
  topic: {
    id: "topic",
    label: "Topic practice",
    labelJa: "トピック練習",
    needsSubject: true,
    instruction: (subject) =>
      `Keep the conversation inside ${subject ?? "the topic the student named"}, using the vocabulary and grammar the course teaches for it. Bring the talk back gently if it drifts far from that ground.`,
  },
  roleplay: {
    id: "roleplay",
    label: "Role play",
    labelJa: "ロールプレイ",
    needsSubject: true,
    instruction: (subject) =>
      `Play the other person in this situation: ${subject ?? "the scene the student named"}. Stay in character, speak as that person would, and let the student carry their side. Do not narrate the scene or step out of it to explain.`,
  },
  grammar: {
    id: "grammar",
    label: "Grammar practice",
    labelJa: "文法練習",
    needsSubject: true,
    instruction: (subject) =>
      `Steer the conversation so the student has natural reasons to use ${subject ?? "the pattern they named"}. Ask questions that invite it rather than instructing them to use it, and use it yourself so they hear it in context.`,
  },
};

/** The situations the course actually teaches, for the topic and role-play
 * pickers. Taken from what the Foundation papers set their reading passages
 * and dialogues around — a student practising 「レストランで」 is practising
 * something their own book covers. */
export const PRACTICE_SUBJECTS = [
  "自己紹介 — introducing yourself",
  "毎日の生活 — daily routine",
  "大学の生活 — university life",
  "買い物 — shopping",
  "交通 — getting around",
  "旅行 — travel",
  "予定を立てる — making plans",
  "経験を話す — describing an experience",
  "道をきく — asking for information",
  "意見を言う — giving an opinion",
] as const;

/** The longest a practice subject may be. It is a phrase — "Topic 8
 * vocabulary", 「〜ておく」, "ordering at a restaurant" — not an essay. */
export const MAX_SUBJECT = 120;

/** A student's own words, made safe to drop into a system prompt.
 *
 * The subject is the one part of the live tutor's instructions that a student
 * writes, so it is treated as data rather than instruction: newlines and
 * control characters go, because a prompt reads line by line and a subject
 * that can open its own line can pose as a rule; runs of whitespace collapse;
 * and the whole thing is cut to a phrase's length. What survives can still
 * SAY anything, but it says it inside the sentence the mode wrote for it —
 * and the worst a student can do with it is steer their own conversation,
 * which is what the box is for.
 */
export function cleanSubject(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[ -]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SUBJECT);
}

/** How hard the tutor should make the Japanese.
 *
 * Read off the student's own profile level, because the difference between
 * the two courses is real: Foundation 2 is Topics 6–10 and stops at the
 * te-form and plain form, while Foundation 3 runs to honorifics and
 * 〜ておく/〜てある. A Foundation 2 student asked 「もう終わっておいたはずです
 * よね？」 hears noise.
 */
export function levelGuidance(level: CourseLevel | null): string {
  if (level === "F2") {
    return `The student is in Foundation 2 (Topics 6–10). Keep to the grammar that course teaches — polite forms, the te-form, plain form, 〜ことができます, 〜から, 〜まえに — and to everyday vocabulary. Two or three short sentences a turn. Do not reach for Foundation 3 patterns (honorifics, 〜ておく/〜てある, 〜そうです, 〜かどうか) unless the student uses one first.`;
  }
  if (level === "F3") {
    return `The student is in Foundation 3 (Topics 11–17). Use the fuller range that course teaches — 〜ておく/〜てある, 〜そうです/〜ようです, 〜かどうか, noun modification, humble and honorific forms — and expect longer answers from them. Ask questions that need more than one clause to answer.`;
  }
  return `The student's course level is not recorded. Start at an intermediate register — polite forms, everyday vocabulary — and follow their lead: go simpler if they struggle, richer if they do not.`;
}

/** The speaking-practice half of the system prompt.
 *
 * The written tutor and the speaking partner want opposite things. The tutor
 * leads with the answer, earns it with an explanation and 1–3 examples, and
 * closes by pointing at a page — which is right for a question typed at
 * midnight and wrong for someone standing there waiting to reply. A partner
 * says one or two sentences and asks something back.
 */
export function speakingPrompt(
  mode: SpeakingMode,
  level: CourseLevel | null,
  subject?: string,
  /** The language the conversation is being held in, decided once from the
   * student's first meaningful utterance and held until they ask to change.
   *
   * This used to say "Reply in Japanese" and nothing else, which made the
   * app's own answer to "what language is this conversation in?" a constant.
   * A student who opened the microphone and said "Can we practise talking
   * about my weekend?" was answered in Japanese they had not asked for, and
   * there was no sentence they could say to stop it. */
  language: ConversationLanguage = "ja",
  /** Where the course material comes from. A typed-pipeline spoken turn has
   * it pasted below the prompt; a live session has none up front and fetches
   * it by calling a tool, only on the turns that need it. */
  grounding: "sources" | "lookup" = "sources",
): string {
  const groundingRule =
    grounding === "lookup"
      ? `- When the student asks about grammar, a word, a reading, or anything from their course or textbook, call search_course_material FIRST and answer from what it returns — briefly, in the conversation's voice. Never call it for ordinary conversation, and never mention that you looked anything up. Do not name a textbook or cite a page aloud.`
      : `- Use the course material to choose your words: the vocabulary and grammar in the sources below are what this student has been taught, so prefer them. Do not quote the material, name a textbook, or cite a page. The grounding should be invisible.`;
  const replyRule =
    language === "ja"
      ? `- Reply in Japanese. Two or three short sentences, and normally end with a question that gives the student something to say back. 「いいですね！京都では何をしましたか？」 — that is the whole shape of a good turn.`
      : `- Reply in English, because that is the language this conversation is being held in. Two or three short sentences, and normally end with a question that gives the student something to say back. "That sounds great — what did you do while you were there?" is the whole shape of a good turn.
- Speaking English does not make this a lesson. Stay a conversation partner: react to what they said, ask about it, and let them lead.
- You may still quote a Japanese word or sentence when it is the actual subject — they are learning Japanese — but say it once, plainly, and keep the conversation in English around it.`;

  return `SPEAKING PRACTICE — YOU ARE A CONVERSATION PARTNER, NOT A TUTOR ANSWERING A QUESTION
The student is SPEAKING to you and will hear your reply read aloud. Everything below overrides the answer-shaping rules above where they conflict.

${replyRule}
- React first, ask second. Respond to what they actually said before moving the conversation on.
- Never lecture. No headings, no bullet lists, no tables, no vocabulary lists, no page references — this is being read aloud, and a listener cannot follow any of it.
- ${SPEAKING_MODES[mode].instruction(subject)}
- ${levelGuidance(level)}
${groundingRule}
- If the student asks you a real question mid-conversation ("what does this mean?", "how do I say…?"), answer it briefly — one or two sentences — and return to the conversation.
- Write no romaji and no furigana brackets. Any Japanese you write is plain Japanese, as it would be spoken.
- Never read the machinery aloud. No "based on the material", no source names, no stage directions about what you are doing.

CORRECTIONS
- The conversation comes first. Do not correct every sentence, and never interrupt the flow to do it.
- ${
    language === "ja"
      ? "When the student makes a mistake worth naming — a wrong particle, a wrong form, an unnatural phrase — finish your conversational turn first, then add ONE short line at the end. Keep it warm and specific: 「（『京都へ行きました』とも言えますよ。）」"
      : "The student is speaking English, so there is usually nothing to correct. If they try a Japanese word or sentence and get it wrong, finish your conversational turn first, then add ONE short, warm line: (You can also say 京都へ行きました.) Never correct their English."
  }
- Say nothing at all when they were fine. Praise for its own sake teaches nothing, and a student who is corrected every turn stops speaking.`;
}
