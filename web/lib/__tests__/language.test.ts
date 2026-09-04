import { describe, expect, it } from "vitest";

import { detectLanguageMode, isWrittenInJapanese, languageRule } from "@/lib/language";

function turn(role: "user" | "assistant", text: string) {
  return { role, text };
}

describe("detectLanguageMode", () => {
  it("defaults to English carrying the course's Japanese", () => {
    expect(detectLanguageMode([turn("user", "How do I use the te-form?")])).toBe("mixed");
  });

  it("answers in Japanese a question written in Japanese", () => {
    expect(detectLanguageMode([turn("user", "〜ておくの使い方を教えてください")])).toBe("ja");
  });

  it("honours an explicit request", () => {
    expect(detectLanguageMode([turn("user", "explain this in japanese please")])).toBe("ja");
    expect(detectLanguageMode([turn("user", "日本語で説明してください")])).toBe("ja");
    expect(detectLanguageMode([turn("user", "answer in english only")])).toBe("en");
  });

  // "How do you say X in Japanese" is a vocabulary question, and answering it
  // entirely in Japanese is the opposite of what was asked for.
  it("does not read a translation question as a language preference", () => {
    expect(detectLanguageMode([turn("user", 'how do you say "I am busy" in Japanese?')])).toBe(
      "mixed",
    );
  });

  it("keeps a stated preference across later turns", () => {
    const conversation = [
      turn("user", "please answer in japanese from now on"),
      turn("assistant", "わかりました。"),
      turn("user", "why?"),
    ];
    expect(detectLanguageMode(conversation)).toBe("ja");
  });

  it("lets the student switch back", () => {
    const conversation = [
      turn("user", "answer in japanese"),
      turn("assistant", "はい。"),
      turn("user", "actually, explain in english"),
    ];
    expect(detectLanguageMode(conversation)).toBe("en");
  });

  it("does not flip to Japanese because a question quotes a Japanese word", () => {
    expect(detectLanguageMode([turn("user", "what does 食べておく mean here?")])).toBe("mixed");
  });
});

describe("isWrittenInJapanese", () => {
  it("separates a Japanese question from an English one about Japanese", () => {
    expect(isWrittenInJapanese("この文法の使い方を教えてください")).toBe(true);
    expect(isWrittenInJapanese("what does 食べる mean?")).toBe(false);
    expect(isWrittenInJapanese("hello")).toBe(false);
  });
});

describe("languageRule", () => {
  it("tells the model to answer wholly in Japanese", () => {
    expect(languageRule("ja")).toMatch(/entirely in Japanese/);
  });

  it("forbids double-writing every sentence in the default mode", () => {
    expect(languageRule("mixed")).toMatch(/Do NOT translate your whole answer/);
  });
});
