/** What the conversation is, as opposed to what the last message said.
 *
 * Every piece of this app used to decide its business from the message in
 * front of it. Retrieval was given the last line, the language was read off
 * the last line, and the intent was classified from the last line. That works
 * for a question typed at midnight and fails for a conversation, because the
 * defining property of a conversation is that its turns are not independent.
 *
 * Two failures made it worth a module rather than another regex:
 *
 *   Student (spoken, English):  "I've been studying Japanese for six months."
 *   Tutor:                      "That's great. What do you find hardest?"
 *   Student:                    "Probably listening."
 *
 * — where "listening" was classified, retrieved and answered as a standalone
 * query about listening practice, and the reply arrived as a textbook section
 * on listening comprehension rather than as the next line of the exchange.
 *
 *   Student (spoken, English):  "...and I went to 京都 last weekend."
 *
 * — where one Japanese place name in an English sentence flipped the whole
 * reply into Japanese, because the language was re-decided every turn from
 * the characters in the newest utterance.
 *
 * So the conversation gets state. It is derived rather than stored: the turns
 * are the source of truth and this is a pure function of them, which keeps it
 * correct across a page reload, a modality switch, and the trial visitor who
 * has no conversation row at all. Nothing here calls a model — a classifier
 * round-trip would cost more latency than the retrieval it is deciding about.
 */

import { isWrittenInJapanese, type LanguageMode, type Turn } from "./language";
import { classifyTurn, type IntentVerdict } from "./intent";
import { isSmallTalk, salientTerms } from "./retrieval";

/* ------------------------------------------------------------------------ */
/* Language                                                                   */
/* ------------------------------------------------------------------------ */

/** The language a conversation is being held in. Distinct from LanguageMode,
 * which is how an ANSWER is written — "mixed" is a way of writing an English
 * answer, not a language anybody speaks. */
export type ConversationLanguage = "ja" | "en";

export interface LanguageState {
  /** The active language of the conversation. */
  language: ConversationLanguage;
  /** True when the student asked for this language out loud. A locked
   * language is never revised by anything except another explicit request. */
  locked: boolean;
  /** True when THIS turn is the one that asked to switch, so the reply can
   * acknowledge it rather than silently changing. */
  switchRequested: boolean;
  /** What decided it, for the diagnostics line. */
  source: "default" | "first_utterance" | "sustained" | "explicit";
}

/** An explicit request about the language of the REPLY.
 *
 * Deliberately the same patterns `language.ts` has always used, imported
 * rather than re-declared would be better still — they are not exported, and
 * copying a regex is how two of them drift apart. Re-exported from there
 * instead: see `explicitLanguageRequest`.
 */
export type LanguageRequest = ConversationLanguage | null;

/** "Answer in Japanese" is a preference. "How do you say this in Japanese?"
 * is a vocabulary question, and switching the whole conversation because of
 * it would be the opposite of helpful — so the verb matters, not just the
 * language name. Shared with `language.ts`, which applies the same rule to a
 * single turn; this file applies it across the conversation. */
const WANTS_JAPANESE =
  /((answer|reply|respond|explain|write|speak|talk|say it|put it|switch|continue|carry on|go)\b[^.?!]{0,24}\b(in|into|to)\s+japanese)|(japanese\s+only)|(only\s+in\s+japanese)|(all\s+in\s+japanese)|(let'?s\s+(speak|talk|try|continue)\s+(in\s+)?japanese)|(日本語(だけ|のみ)で?)|((全部|すべて|ぜんぶ)日本語)|(日本語で(話|はな|答え|こたえ|説明|せつめい|お願い|おねがい))|(日本語に(して|切り替え))/i;

const WANTS_ENGLISH =
  /((answer|reply|respond|explain|write|speak|talk|say it|put it|switch|continue|carry on|go)\b[^.?!]{0,24}\b(in|into|to)\s+english)|(english\s+only)|(only\s+in\s+english)|(all\s+in\s+english)|(let'?s\s+(speak|talk|try|continue)\s+(in\s+)?english)|(英語(だけ|のみ)で?)|(英語で(話|はな|答え|こたえ|説明|せつめい|お願い|おねがい))|(英語に(して|切り替え))/i;

/** The language this turn explicitly asked for, or null if it asked for
 * nothing. Exported because the intent classifier needs the same answer and
 * two copies of this question would eventually disagree. */
export function explicitLanguageRequest(text: string): LanguageRequest {
  // Japanese tested first only because a bilingual sentence naming both
  // ("English please, not 日本語") is vanishingly rare next to the common
  // case; when both match, the later one in the string wins.
  const ja = WANTS_JAPANESE.exec(text);
  const en = WANTS_ENGLISH.exec(text);
  if (ja && en) return ja.index > en.index ? "ja" : "en";
  if (ja) return "ja";
  if (en) return "en";
  return null;
}

/** An utterance substantial enough to set the language of a conversation.
 *
 * "Hello", "うん", "ok" are not: they are the same in every language a
 * student might be about to speak, and letting one of them decide would mean
 * a conversation opening with 「こんにちは」 followed by five English
 * sentences is conducted in Japanese on the strength of the greeting.
 */
function isMeaningful(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 4) return false;
  return !isSmallTalk(trimmed);
}

/** How many consecutive whole-language turns count as changing languages
 * without saying so.
 *
 * The rule is that incidental code-switching must NOT move the conversation:
 * one Japanese place name in an English sentence, or one English loanword in
 * a Japanese one, is not a request for anything. But a student who writes two
 * complete Japanese turns in a row has stopped code-switching and started
 * speaking Japanese, and refusing to notice that until they say so out loud
 * is its own kind of deaf.
 *
 * Two, because one is the incidental case this exists to ignore. Raise it to
 * disable the behaviour entirely — an explicit request still switches at any
 * point, which is the guarantee that matters.
 */
const SUSTAINED_SWITCH_TURNS = 2;

/** The language of the conversation, and how firmly it is held.
 *
 * Read in order rather than backwards, because the first meaningful utterance
 * is what establishes the language and everything after it is either an
 * explicit change or noise. An explicit request outranks everything and holds
 * until the next one.
 */
export function conversationLanguage(turns: Turn[]): LanguageState {
  const asked = turns.filter((t) => t.role === "user").map((t) => t.text.trim());

  let language: ConversationLanguage | null = null;
  let source: LanguageState["source"] = "default";
  let locked = false;
  let run = 0;
  let runLanguage: ConversationLanguage | null = null;

  for (const text of asked) {
    const requested = explicitLanguageRequest(text);
    if (requested) {
      language = requested;
      locked = true;
      source = "explicit";
      run = 0;
      runLanguage = null;
      continue;
    }

    if (!isMeaningful(text)) continue;

    const written: ConversationLanguage = isWrittenInJapanese(text) ? "ja" : "en";

    // The first meaningful thing said sets the language.
    if (language === null) {
      language = written;
      source = "first_utterance";
      runLanguage = written;
      run = 1;
      continue;
    }

    // A locked language ignores the script entirely. This is the whole
    // point: a student who asked for English gets English even while
    // quoting whole Japanese sentences at the tutor, which is exactly what
    // a student practising translation does all day.
    if (locked) continue;

    // A run is consecutive turns written wholly in one language. It breaks
    // the moment the student writes a turn in the other one.
    if (written === runLanguage) {
      run += 1;
    } else {
      runLanguage = written;
      run = 1;
    }

    if (written !== language && run >= SUSTAINED_SWITCH_TURNS) {
      language = written;
      source = "sustained";
      run = 0;
    }
  }

  const last = asked.at(-1) ?? "";
  return {
    language: language ?? "en",
    locked,
    switchRequested: explicitLanguageRequest(last) !== null,
    source: language === null ? "default" : source,
  };
}

/** How the answer should be WRITTEN, given the conversation's language.
 *
 * The two are not the same question. A spoken turn has to come back in one
 * language — a listener cannot follow an English explanation carrying
 * Japanese terms, and the voice would read the glosses aloud — so voice maps
 * straight onto the conversation language. A typed answer in an English
 * conversation is better as the bilingual register the course itself uses:
 * English explanation, Japanese terms kept in Japanese, which is what
 * `mixed` means and what this app has always done well.
 *
 * An explicit request is honoured literally in both modalities. A student who
 * says "answer in English" and gets an answer sprinkled with unglossed
 * Japanese has been ignored.
 */
export function languageModeFor(state: LanguageState, spoken: boolean): LanguageMode {
  if (state.language === "ja") return "ja";
  if (state.locked) return "en";
  return spoken ? "en" : "mixed";
}

/* ------------------------------------------------------------------------ */
/* What the student is doing                                                  */
/* ------------------------------------------------------------------------ */

/** The move a turn makes in the conversation.
 *
 * Finer than `TurnIntent`, which answers only "does this need the corpus".
 * This answers "what is being done", because several of these want different
 * REPLIES from an identical retrieval verdict: an acknowledgement and a
 * request to slow down both skip the corpus, and answering them the same way
 * is how a tutor ends up explaining a grammar point to someone who said "hm".
 */
export type SpeechAct =
  | "greeting"
  | "acknowledge"
  | "statement"
  | "follow_up"
  | "clarify"
  | "repeat"
  | "slow_down"
  | "language_switch"
  | "farewell"
  | "question";

/** Asking for the last turn again, or more slowly. */
const ASKS_REPEAT =
  /\b(say (?:that|it) again|again please|repeat that|repeat it|come again|one more time|pardon|sorry,? what)\b|もう一度|もういちど|もっかい|なんて言いました|何て言いました|聞こえませんでした/i;

const ASKS_SLOWER =
  /\b(slow(?:er|ly)?|more slowly|not so fast|speak up|louder)\b|ゆっくり|はやすぎ|速すぎ|もっとゆっくり/i;

/** Ending the conversation, in the words people actually use to end one. */
const SAYS_GOODBYE =
  /^(bye|goodbye|good ?night|see you|that'?s all|that'?s enough|i'?m done|we'?re done|thanks,? bye|stop|end (?:the )?conversation)\b[\s!.]*$|^(じゃあ|じゃ|それでは|では)?\s*(また(ね|あした|明日|来週|今度)?|さようなら|さよなら|バイバイ|おやすみ(なさい)?|終わり(ます|ましょう)?|終わろう|ありがとうございました)[\s!。！]*$/i;

/** Asking what the tutor meant, rather than asking about the language. */
const ASKS_CLARIFY =
  /\b(what do you mean|i don'?t (?:get|understand)|didn'?t (?:get|understand)|not sure what you|can you (?:explain|clarify) (?:that|what you)|huh\??)\b|どういう意味|わかりません|分かりません|よくわからない|どういうこと/i;

/** A reference to a numbered thing that only the previous turn can supply. */
const ORDINAL_REFERENCE =
  /\b(the )?(first|second|third|fourth|fifth|last|next|other|latter|former) one\b|\b(the )?(first|second|third|fourth|fifth|last|next) (example|sentence|word|item|question|point|rule)\b|(一|二|三|四|1|2|3|4)つ目|最初の(方|やつ)?|次の(例|やつ|文)/i;

export interface SpeechActVerdict {
  act: SpeechAct;
  /** The signal that decided it, for the log line. */
  because: string;
}

/** What move this turn is making.
 *
 * Ordered by how specific the signal is, and checked before the retrieval
 * classifier rather than after it, because "もう一度、〜ておくの意味を教えて"
 * is BOTH a repeat request and a course question — the act is `repeat`, and
 * the retrieval verdict is still `course_question`. The two answers are
 * independent and the code keeps them that way.
 */
export function speechAct(text: string, previousAssistant = ""): SpeechActVerdict {
  const asked = text.trim();
  if (!asked) return { act: "statement", because: "empty" };

  if (SAYS_GOODBYE.test(asked)) return { act: "farewell", because: "said goodbye" };
  if (explicitLanguageRequest(asked)) {
    return { act: "language_switch", because: "asked for a language" };
  }
  if (ASKS_REPEAT.test(asked)) return { act: "repeat", because: "asked to repeat" };
  if (ASKS_SLOWER.test(asked)) return { act: "slow_down", because: "asked to slow down" };
  if (ASKS_CLARIFY.test(asked)) return { act: "clarify", because: "asked what was meant" };
  if (isSmallTalk(asked)) {
    // A greeting opens a conversation; an acknowledgement continues one. The
    // difference is whether anything has been said yet, and it matters: a
    // greeting deserves a greeting back, while "なるほど" deserves the
    // conversation moving on rather than "こんにちは".
    return previousAssistant
      ? { act: "acknowledge", because: "acknowledged the last turn" }
      : { act: "greeting", because: "greeting" };
  }
  if (ORDINAL_REFERENCE.test(asked)) {
    return { act: "follow_up", because: "referred to something numbered" };
  }
  if (/\?|？|ですか|ますか|でしょうか/.test(asked)) {
    return { act: "question", because: "asked a question" };
  }
  return { act: "statement", because: "said something" };
}

/* ------------------------------------------------------------------------ */
/* The state                                                                  */
/* ------------------------------------------------------------------------ */

export interface ConversationState {
  language: LanguageState;
  /** What the student is doing this turn. */
  act: SpeechAct;
  /** Whether the corpus is needed, and how much of it. Delegated to the
   * existing classifier, which is the thing that measured its own tradeoff. */
  intent: IntentVerdict;
  /** Terms the conversation has been about, newest first. Not a topic model:
   * the grammar points and kanji compounds the last few turns actually used,
   * which is what a follow-up is nearly always about. */
  entities: string[];
  /** True when the turn cannot be understood without the turns before it. */
  dependsOnHistory: boolean;
  /** True when the turn points at one of several things and the conversation
   * does not say which. The prompt turns this into a one-line question rather
   * than letting the model pick one and sound certain. */
  ambiguousReference: boolean;
  /** How the turn arrived. */
  modality: "voice" | "text";
  /** One line, for the worker log. */
  because: string;
}

/** How many turns back "the conversation" means for entity carry-over.
 *
 * Four rather than the eight the prompt keeps, because these are terms fed
 * into a search and an entity from eight turns ago is usually the subject of
 * a question that has already been answered. The prompt still sees the
 * history; this is only what gets treated as CURRENT. */
const ENTITY_WINDOW = 4;

/** Everything the route needs to know about the conversation, in one pass. */
export function conversationState(
  turns: Turn[],
  options: { spoken?: boolean } = {},
): ConversationState {
  const spoken = options.spoken ?? false;
  const lastUserAt = turns.map((t) => t.role).lastIndexOf("user");
  const asked = lastUserAt < 0 ? "" : turns[lastUserAt].text.trim();
  const earlier = lastUserAt < 0 ? [] : turns.slice(0, lastUserAt);
  const previousAssistant =
    [...earlier].reverse().find((t) => t.role === "assistant")?.text.trim() ?? "";

  const language = conversationLanguage(turns);
  const { act, because } = speechAct(asked, previousAssistant);
  const intent = classifyTurn(asked, spoken);

  // Terms from the recent turns, the tutor's own answers included: the
  // pattern a follow-up is about was usually named by the ANSWER, not by the
  // student, who said "why?".
  const recent = turns.slice(-ENTITY_WINDOW * 2);
  const entities = [
    ...new Set(recent.flatMap((turn) => salientTerms(turn.text, 3))),
  ].slice(0, 6);

  const dependsOnHistory =
    earlier.length > 0 &&
    (act === "acknowledge" ||
      act === "follow_up" ||
      act === "clarify" ||
      act === "repeat" ||
      asked.length <= 24);

  // An ordinal that the previous answer cannot supply. A list in the last
  // answer makes "the second one" perfectly clear; without one it is a guess,
  // and a confident guess is the failure this flags.
  const ambiguousReference =
    ORDINAL_REFERENCE.test(asked) && !hasEnumerableList(previousAssistant);

  return {
    language,
    act,
    intent,
    entities,
    dependsOnHistory,
    ambiguousReference,
    modality: spoken ? "voice" : "text",
    because: `${because}; ${intent.because}; lang ${language.language}/${language.source}`,
  };
}

/** Did the last answer contain something an ordinal could be pointing at?
 *
 * Two items, not one: "the second one" needs a second one to exist. Numbered
 * lines, bulleted lines and numbered Japanese items all count, because the
 * tutor writes all three. */
export function hasEnumerableList(answer: string): boolean {
  const numbered = answer.match(/^\s*(?:\d+[.)、]|[-*•]|[①-⑳])\s+/gm)?.length ?? 0;
  return numbered >= 2;
}

/* ------------------------------------------------------------------------ */
/* What the model is told                                                     */
/* ------------------------------------------------------------------------ */

/** The conversation, stated to the model as fact.
 *
 * Everything here is something the model would otherwise have to infer from
 * the transcript, and infer freshly on every turn — which is the same job
 * done worse and paid for in tokens. Stating it costs about forty tokens and
 * removes the two failures this module exists for: a reply that treats a
 * follow-up as a new question, and a reply that changes language because the
 * student quoted a word.
 *
 * Written as short declaratives rather than instructions where possible. A
 * model follows "The student is speaking English" more reliably than "Reply
 * in English" precisely because it is not a rule to be weighed against the
 * other rules — it is a fact about the room.
 */
export function conversationBrief(state: ConversationState): string {
  const lines: string[] = [];

  lines.push(
    state.modality === "voice"
      ? "This is a live spoken conversation. The student is talking to you and will hear your reply read aloud."
      : "This is a written conversation.",
  );

  const languageName = state.language.language === "ja" ? "Japanese" : "English";
  if (state.language.switchRequested) {
    lines.push(
      `The student has just asked to continue in ${languageName}. Switch now, acknowledge it in one short clause at most, and stay in ${languageName} from here.`,
    );
  } else if (state.language.locked) {
    lines.push(
      `This conversation is being held in ${languageName} because the student asked for it. Stay in ${languageName} even when they quote or use the other language — quoting is not a request to switch.`,
    );
  } else {
    lines.push(
      `This conversation is being held in ${languageName}. Stay in ${languageName} unless the student asks you to change; a stray word or name from another language is not a request to change.`,
    );
  }

  if (state.entities.length > 0) {
    lines.push(`Recently discussed: ${state.entities.join("、")}.`);
  }

  if (state.dependsOnHistory) {
    lines.push(
      "The student's message continues the exchange above rather than starting a new subject. Work out what it refers to from the turns before it and reply to THAT. Do not restate what you have already said.",
    );
  }

  const act = ACT_GUIDANCE[state.act];
  if (act) lines.push(act);

  if (state.ambiguousReference) {
    lines.push(
      "They have pointed at one of several things and the conversation does not say which. Ask one short question to find out. Do not pick one and answer as though you knew.",
    );
  }

  return `THE CONVERSATION SO FAR\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

/** What each move asks of the reply. Only the moves that change it appear:
 * a plain question or statement wants the ordinary answer, and a line here
 * saying so would be a token spent to change nothing. */
const ACT_GUIDANCE: Partial<Record<SpeechAct, string>> = {
  acknowledge:
    "They are acknowledging what you said, not asking a new question. Carry the conversation forward in a sentence — do not re-explain what they just agreed with.",
  repeat:
    "They did not catch your last turn. Say the same thing again, shorter and more plainly. Do not treat it as a new question or look anything new up.",
  slow_down:
    "They asked you to slow down. Keep this reply short and simple, and use easier words than you just did.",
  clarify:
    "They did not follow your last turn. Explain the same point again in different, simpler words — a fresh angle on what you already said, not more of it.",
  farewell:
    "They are ending the conversation. Say a short, warm goodbye. Do not start a new subject or ask a new question.",
  greeting: "Greet them back in one line and invite them to start. Nothing else.",
  follow_up:
    "They are pointing back at something from the turns above. Resolve what it is and answer that.",
};
