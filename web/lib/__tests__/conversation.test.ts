import { describe, expect, it } from "vitest";

import {
  conversationBrief,
  conversationLanguage,
  conversationState,
  explicitLanguageRequest,
  hasEnumerableList,
  languageModeFor,
  speechAct,
} from "@/lib/conversation";

function user(text: string) {
  return { role: "user", text };
}
function bot(text: string) {
  return { role: "assistant", text };
}

/** The failure this file exists for, in the student's words: they held a
 * whole conversation in English, said one Japanese place name, and the tutor
 * answered the rest of the session in Japanese. */
describe("the conversation has a language, and keeps it", () => {
  it("takes its language from the first meaningful thing said", () => {
    expect(conversationLanguage([user("I have been studying Japanese for six months.")]))
      .toMatchObject({ language: "en", source: "first_utterance", locked: false });
    expect(conversationLanguage([user("半年ぐらい日本語を勉強しています。")]))
      .toMatchObject({ language: "ja", source: "first_utterance" });
  });

  it("is not decided by a greeting, which is the same in every language", () => {
    // 「こんにちは」 then five English sentences is an English conversation.
    const state = conversationLanguage([
      user("こんにちは"),
      bot("Hello! What would you like to work on?"),
      user("I want to practise talking about my weekend."),
    ]);
    expect(state.language).toBe("en");
    expect(state.source).toBe("first_utterance");
  });

  it("stays in English when the student drops in a Japanese word", () => {
    const state = conversationLanguage([
      user("I have been studying Japanese for six months."),
      bot("That's great. What do you find hardest?"),
      user("Probably listening. Last weekend I went to 京都 with my friend."),
    ]);
    expect(state.language).toBe("en");
  });

  it("stays in Japanese when the student drops in an English word", () => {
    const state = conversationLanguage([
      user("週末は友達と京都に行きました。"),
      bot("いいですね。何を見ましたか。"),
      user("お寺を見ました。とてもbeautifulでした。"),
    ]);
    expect(state.language).toBe("ja");
  });

  it("switches when the student asks, in either language", () => {
    const toJapanese = conversationLanguage([
      user("I want to practise speaking."),
      bot("Sure — what would you like to talk about?"),
      user("Let's speak Japanese."),
    ]);
    expect(toJapanese).toMatchObject({ language: "ja", locked: true, switchRequested: true });

    const toEnglish = conversationLanguage([
      user("週末は友達と京都に行きました。"),
      bot("いいですね。"),
      user("英語で話してください。"),
    ]);
    expect(toEnglish).toMatchObject({ language: "en", locked: true, switchRequested: true });
  });

  it("survives several switches, and the last one wins", () => {
    const state = conversationLanguage([
      user("I want to practise."),
      user("Let's speak Japanese."),
      user("そうですね。"),
      user("Can we continue in English?"),
      user("Switch to Japanese."),
    ]);
    expect(state).toMatchObject({ language: "ja", locked: true });
  });

  it("holds a requested language against whole quoted sentences", () => {
    // A student practising translation quotes Japanese all day. None of it
    // is a request to be answered in Japanese.
    const state = conversationLanguage([
      user("Please answer in English only."),
      bot("Of course."),
      user("何と言いますか。「明日は雨が降るそうです」"),
    ]);
    expect(state).toMatchObject({ language: "en", locked: true });
    expect(state.switchRequested).toBe(false);
  });

  it("does not read a translation question as a request to switch", () => {
    expect(explicitLanguageRequest('how do you say "I am busy" in Japanese?')).toBeNull();
    expect(explicitLanguageRequest("what does this mean in english")).toBeNull();
  });

  it("follows the student when they genuinely change languages and stay there", () => {
    // Two whole turns in the other language is no longer code-switching.
    const state = conversationLanguage([
      user("I want to practise speaking."),
      bot("Sure."),
      user("じゃあ、今日の天気について話しましょう。"),
      bot("いいですね。"),
      user("今日はとても暑いですね。外に出たくないです。"),
    ]);
    expect(state).toMatchObject({ language: "ja", source: "sustained", locked: false });
  });

  it("does not switch on a single Japanese turn inside an English conversation", () => {
    const state = conversationLanguage([
      user("I want to practise speaking."),
      bot("Sure."),
      user("じゃあ、今日の天気について話しましょう。"),
      bot("Good idea."),
      user("It has been really hot this week."),
    ]);
    expect(state.language).toBe("en");
  });

  it("defaults to English before anything meaningful is said", () => {
    expect(conversationLanguage([])).toMatchObject({ language: "en", source: "default" });
    expect(conversationLanguage([user("hi")])).toMatchObject({ source: "default" });
  });
});

describe("how the answer is written", () => {
  it("gives a spoken English conversation plain English, not the bilingual register", () => {
    // A listener cannot follow "the te-form 「て形」" read aloud with glosses.
    const state = conversationLanguage([user("I want to practise speaking English today.")]);
    expect(languageModeFor(state, true)).toBe("en");
  });

  it("keeps the bilingual register for typed English, which is the course's own", () => {
    const state = conversationLanguage([user("How do I use the te-form?")]);
    expect(languageModeFor(state, false)).toBe("mixed");
  });

  it("honours an explicit English request literally, even when typed", () => {
    const state = conversationLanguage([user("Please answer in english only")]);
    expect(languageModeFor(state, false)).toBe("en");
  });

  it("answers a Japanese conversation in Japanese either way", () => {
    const state = conversationLanguage([user("日本語で話す練習がしたいです。")]);
    expect(languageModeFor(state, true)).toBe("ja");
    expect(languageModeFor(state, false)).toBe("ja");
  });
});

describe("what the student is doing this turn", () => {
  it("tells a greeting from an acknowledgement by whether anything was said", () => {
    expect(speechAct("こんにちは").act).toBe("greeting");
    expect(speechAct("なるほど", "〜ておくは準備の意味です。").act).toBe("acknowledge");
  });

  it("recognises the turns that are about the talking, not the subject", () => {
    expect(speechAct("say that again").act).toBe("repeat");
    expect(speechAct("もう一度お願いします").act).toBe("repeat");
    expect(speechAct("can you speak more slowly").act).toBe("slow_down");
    expect(speechAct("ゆっくり話してください").act).toBe("slow_down");
    expect(speechAct("I don't understand", "…").act).toBe("clarify");
    expect(speechAct("Let's speak Japanese.").act).toBe("language_switch");
  });

  it("recognises the end of a conversation", () => {
    for (const bye of ["bye", "that's all", "また明日", "ありがとうございました"]) {
      expect(speechAct(bye).act, bye).toBe("farewell");
    }
  });

  it("recognises a question and a plain statement", () => {
    expect(speechAct("〜ておくはどう使いますか？").act).toBe("question");
    expect(speechAct("昨日、友達と京都に行きました。").act).toBe("statement");
  });
});

describe("pointing at one of several things", () => {
  it("counts a list only when there is more than one item to point at", () => {
    expect(hasEnumerableList("1. 食べておく\n2. 見ておく")).toBe(true);
    expect(hasEnumerableList("- ひとつ\n- ふたつ")).toBe(true);
    expect(hasEnumerableList("Just the one thing, in prose.")).toBe(false);
    expect(hasEnumerableList("- only one bullet")).toBe(false);
  });

  it("asks rather than guesses when the ordinal has nothing to land on", () => {
    const state = conversationState([
      user("Tell me about that grammar point."),
      bot("〜ておく is used for doing something in advance."),
      user("Can you explain the second one?"),
    ]);
    expect(state.ambiguousReference).toBe(true);
    expect(conversationBrief(state)).toMatch(/Ask one short question/);
  });

  it("does not ask when the previous answer makes it obvious", () => {
    const state = conversationState([
      user("Give me examples."),
      bot("1. 窓が開けてあります。\n2. 明日のために勉強しておきます。"),
      user("Can you explain the second one?"),
    ]);
    expect(state.ambiguousReference).toBe(false);
    expect(conversationBrief(state)).not.toMatch(/Ask one short question/);
  });
});

describe("the brief handed to the model", () => {
  it("states the language as a fact about the room", () => {
    const state = conversationState(
      [user("I have been studying for six months."), bot("Nice."), user("Probably listening.")],
      { spoken: true },
    );
    expect(conversationBrief(state)).toMatch(/held in English/);
    expect(conversationBrief(state)).toMatch(/live spoken conversation/);
  });

  it("tells the model a short follow-up continues the exchange", () => {
    const state = conversationState(
      [user("What is the hardest part of Japanese?"), bot("Many find listening hardest."), user("Probably listening.")],
      { spoken: true },
    );
    expect(state.dependsOnHistory).toBe(true);
    expect(conversationBrief(state)).toMatch(/continues the exchange/);
  });

  it("acknowledges a switch the turn it is asked for", () => {
    const state = conversationState([user("Hi"), bot("Hello!"), user("Let's speak Japanese.")]);
    expect(conversationBrief(state)).toMatch(/just asked to continue in Japanese/);
  });

  it("does not tell the model to re-explain what was just agreed with", () => {
    const state = conversationState([
      user("〜ておくの意味は？"),
      bot("準備の意味です。"),
      user("なるほど"),
    ]);
    expect(state.act).toBe("acknowledge");
    expect(conversationBrief(state)).toMatch(/do not re-explain/i);
  });

  it("carries the terms the conversation has been about", () => {
    const state = conversationState([
      user("〜ておくについて教えてください"),
      bot("〜ておくは準備の意味です。"),
      user("why?"),
    ]);
    expect(state.entities.join(" ")).toMatch(/ておく/);
    expect(conversationBrief(state)).toMatch(/Recently discussed/);
  });
});
