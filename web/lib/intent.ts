/** Whether this turn needs the knowledge base, and what it is trying to do.
 *
 * Retrieval was unconditional, and for a conversation that is the wrong
 * default in both directions at once. Measured on the live route:
 *
 *   「こんにちは」                      645ms   (small talk — retrieval skipped)
 *   「京都のお寺について話したいです。」  10,100ms (~5,938 tokens of prompt)
 *
 * The second is a casual sentence about temples. It searched every book in
 * the corpus, poured 8,000 characters of textbook into the prompt, and pushed
 * the turn past the fast model's ceiling — so the request was refused after
 * seven seconds and answered by the slow tier instead. The retrieval was not
 * merely wasted; it was the reason the turn was slow.
 *
 * So the question is asked per turn. Not by a model — a classifier call would
 * cost the latency this exists to save — but from what the student actually
 * wrote. The signals are specific and few, because the cost of being wrong is
 * asymmetric: a missed retrieval gives a vaguer answer to one turn, while an
 * unnecessary one costs every conversational turn ten seconds.
 */

import { isSmallTalk } from "./retrieval";
import { pageRefs } from "./pages";
import { topicRefs } from "./topics";

export type TurnIntent =
  /** A greeting or acknowledgement. Nothing to look up. */
  | "small_talk"
  /** Conversation: telling, asking, reacting. Answerable from context. */
  | "conversation"
  /** A question about the language or the course. Needs the corpus. */
  | "course_question";

export interface IntentVerdict {
  intent: TurnIntent;
  needsRetrieval: boolean;
  /** Which signal decided it, for the diagnostics line. */
  because: string;
}

/** Asking about the language itself, in either language the students use. */
const ASKS_ABOUT_LANGUAGE =
  /\b(what does|what is|whats|what'?s|how do (?:i|you)|how is|when do (?:i|you)|difference between|meaning of|translate|means?\b|explain|example of|conjugat|grammar|vocab|kanji|reading of|how to say|can you say)\b|意味|使い方|どういう|どうやって|なんて言|何て言|訳し|文法|単語|語彙|漢字|読み方|例文|説明して|教えて(?:ください)?/i;

/** Naming a piece of the course: a pattern in quotes or tildes, an exercise,
 * a section, a book. These are requests for material even without a verb. */
const NAMES_MATERIAL =
  /[～〜][ぁ-ゖァ-ヶー一-鿿]{1,10}|[「『][^」』]{1,16}[」』]|\b(exercise|practice question|question \d|textbook|past paper|section)\b|練習|問題|教科書|復習/i;

/** Asking the tutor to change how it is talking, not what about. Cheap to
 * answer from the conversation, and a retrieval here returns noise. */
const ABOUT_THE_TALKING =
  /\b(say (?:that|it) again|repeat|slower|more slowly|speak up|louder|in english|in japanese|一回|もう一度|ゆっくり|英語で|日本語で)\b/i;

/**
 * @param text        the student's own words for this turn
 * @param speaking    true when the turn arrived by voice, which changes the
 *                    default: a spoken turn is a conversation until it shows
 *                    otherwise, a typed one is usually a question.
 */
export function classifyTurn(text: string, speaking = false): IntentVerdict {
  const asked = text.trim();

  if (!asked || isSmallTalk(asked)) {
    return { intent: "small_talk", needsRetrieval: false, because: "greeting" };
  }

  // A page or a division is the least ambiguous request in the app. It always
  // retrieves, spoken or typed.
  if (pageRefs(asked).length > 0) {
    return { intent: "course_question", needsRetrieval: true, because: "page named" };
  }
  if (topicRefs(asked).length > 0) {
    return { intent: "course_question", needsRetrieval: true, because: "topic named" };
  }
  if (NAMES_MATERIAL.test(asked)) {
    return { intent: "course_question", needsRetrieval: true, because: "material named" };
  }
  if (ASKS_ABOUT_LANGUAGE.test(asked)) {
    return { intent: "course_question", needsRetrieval: true, because: "asks about the language" };
  }
  // Checked after the above so 「もう一度、〜ておくの意味を教えて」 still
  // retrieves: a request to repeat something about the course is still about
  // the course.
  if (ABOUT_THE_TALKING.test(asked)) {
    return { intent: "conversation", needsRetrieval: false, because: "about the talking" };
  }

  if (speaking) {
    // The default that matters. Almost every spoken turn in a practice
    // conversation — 「昨日、友達と京都に行きました。」, 「お寺を見たいです。」
    // — is a sentence, not a query, and answering it well needs the
    // conversation rather than the corpus.
    return { intent: "conversation", needsRetrieval: false, because: "spoken conversation" };
  }

  // A typed turn with no signal is still usually a question: the student went
  // to the trouble of writing it.
  return { intent: "course_question", needsRetrieval: true, because: "typed, unclassified" };
}

/** How much course material a turn of this kind should carry.
 *
 * A spoken reply is two or three sentences, so the six passages a written
 * explanation is built from are both unnecessary and expensive: they are what
 * pushed the prompt past the fast model's ceiling. Two is enough to keep the
 * vocabulary and grammar in range of what the student has been taught, which
 * is all the grounding a conversation needs.
 */
export function contextSizeFor(intent: TurnIntent, speaking: boolean): number {
  if (intent === "small_talk") return 0;
  if (speaking) return 2;
  return 6;
}
