import { describe, expect, it } from "vitest";

import { classifyTurn, contextSizeFor } from "@/lib/intent";

/** The turns a student actually takes in a spoken conversation. Measured: a
 * turn that retrieves costs about ten seconds, one that does not costs under
 * one, so these are the two seconds of a student's life this file decides. */
describe("conversation needs no retrieval", () => {
  const spoken = [
    "昨日、友達と京都に行きました。",
    "お寺を見たいです。",
    "静かなところがいいです。",
    "今日はいい天気ですね。",
    "アクション映画です。",
    "I went to Kyoto yesterday with my friend.",
  ];

  it("recognises a sentence as a sentence", () => {
    for (const text of spoken) {
      const verdict = classifyTurn(text, true);
      expect(verdict.needsRetrieval, text).toBe(false);
      expect(verdict.intent, text).toBe("conversation");
    }
  });

  it("still skips retrieval for a greeting, spoken or typed", () => {
    for (const speaking of [true, false]) {
      expect(classifyTurn("こんにちは", speaking).intent).toBe("small_talk");
      expect(classifyTurn("thanks!", speaking).needsRetrieval).toBe(false);
    }
  });

  it("does not look anything up to be asked to repeat itself", () => {
    for (const text of ["もう一度お願いします", "say that again", "ゆっくり話してください"]) {
      expect(classifyTurn(text, true).needsRetrieval, text).toBe(false);
    }
  });
});

describe("a question about the course does need retrieval", () => {
  const questions = [
    "〜しか〜ないはどう使いますか？",
    "What does 〜ておく mean?",
    "Foundation 2 textbook page 85",
    "Topic 6の文法を使って会話しましょう。",
    "list all the vocabulary for topic 8",
    "この漢字の読み方を教えてください",
    "「ところ」の意味は？",
    "answer the practice questions on page 122",
  ];

  it("recognises one however it is asked", () => {
    for (const text of questions) {
      const verdict = classifyTurn(text, true);
      expect(verdict.needsRetrieval, `${text} (${verdict.because})`).toBe(true);
      expect(verdict.intent, text).toBe("course_question");
    }
  });

  it("names the signal that decided it, for the log", () => {
    expect(classifyTurn("page 85 please", true).because).toBe("page named");
    expect(classifyTurn("topic 8 vocabulary", true).because).toBe("topic named");
    expect(classifyTurn("what does this mean", true).because).toBe("asks about the language");
  });

  it("retrieves for a course question even when it opens with a repeat", () => {
    // 「もう一度、〜ておくの意味を教えて」 is still a question about the course;
    // the request to repeat is not what it is about.
    const verdict = classifyTurn("もう一度、〜ておくの意味を教えてください", true);
    expect(verdict.needsRetrieval).toBe(true);
  });
});

describe("typing and speaking default differently", () => {
  it("assumes a typed turn with no signal is a question", () => {
    // A student who went to the trouble of writing it usually wants an
    // answer, not a chat.
    const typed = classifyTurn("the difference in nuance here", false);
    expect(typed.needsRetrieval).toBe(true);
    expect(typed.because).toBe("typed, unclassified");
  });

  it("assumes a spoken turn with no signal is conversation", () => {
    const said = classifyTurn("それはおもしろいですね", true);
    expect(said.needsRetrieval).toBe(false);
    expect(said.because).toBe("spoken conversation");
  });
});

describe("how much course material a turn carries", () => {
  it("gives a spoken reply less, because it is two sentences long", () => {
    // Six passages is what a written explanation is built from. In a spoken
    // turn they are both unnecessary and expensive: the context block is what
    // pushed the prompt past the fast model's ceiling and cost ten seconds.
    expect(contextSizeFor("course_question", true)).toBeLessThan(
      contextSizeFor("course_question", false),
    );
  });

  it("gives small talk none at all", () => {
    expect(contextSizeFor("small_talk", true)).toBe(0);
    expect(contextSizeFor("small_talk", false)).toBe(0);
  });
});
