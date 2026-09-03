import { describe, expect, it } from "vitest";

import { splitRuby } from "@/lib/ruby";

describe("splitRuby", () => {
  it("puts a reading over the kanji it spells", () => {
    expect(splitRuby("大学（だいがく）へ行きます")).toEqual([
      { base: "大学", reading: "だいがく" },
      { base: "へ行きます" },
    ]);
  });

  it("reads both bracket styles", () => {
    expect(splitRuby("将来《しょうらい》の進路")).toEqual([
      { base: "将来", reading: "しょうらい" },
      { base: "の進路" },
    ]);
  });

  // The prompt asks for the reading of the WHOLE word — 急ぐ（いそぐ） — because
  // that is how a student would say it. The okurigana then has to come back
  // out from under the ruby, or ぐ appears twice.
  it("keeps okurigana beside the kanji, not above it", () => {
    expect(splitRuby("急ぐ（いそぐ）")).toEqual([
      { base: "急", reading: "いそ" },
      { base: "ぐ" },
    ]);
    expect(splitRuby("乗り遅れる（のりおくれる）")).toEqual([
      { base: "乗り遅", reading: "のりおく" },
      { base: "れる" },
    ]);
  });

  it("keeps kana the word opens with beside the kanji too", () => {
    expect(splitRuby("き色（きいろ）")).toEqual([
      { base: "き" },
      { base: "色", reading: "いろ" },
    ]);
    expect(splitRuby("みどり色（みどりいろ）")).toEqual([
      { base: "みどり" },
      { base: "色", reading: "いろ" },
    ]);
  });

  it("annotates the word, not the particle in front of it", () => {
    // を is nowhere in よむ, so the word being read is 読む.
    expect(splitRuby("本を読む（よむ）")).toEqual([
      { base: "本を" },
      { base: "読", reading: "よ" },
      { base: "む" },
    ]);
  });

  it("does not reach back across a word it has already annotated", () => {
    expect(splitRuby("卒業（そつぎょう）して就職（しゅうしょく）する")).toEqual([
      { base: "卒業", reading: "そつぎょう" },
      { base: "して" },
      { base: "就職", reading: "しゅうしょく" },
      { base: "する" },
    ]);
  });

  it("leaves an answer blank alone", () => {
    expect(splitRuby("部屋（　）勉強します")).toEqual([{ base: "部屋（　）勉強します" }]);
  });

  it("leaves a bracketed kanji alone — that is content, not a reading", () => {
    expect(splitRuby("食べます（食べる）")).toEqual([{ base: "食べます（食べる）" }]);
  });

  it("leaves a bracket with no word in front of it alone", () => {
    expect(splitRuby("（ぜんぶ）")).toEqual([{ base: "（ぜんぶ）" }]);
  });

  it("passes plain kana through untouched", () => {
    expect(splitRuby("まいにち べんきょうします")).toEqual([
      { base: "まいにち べんきょうします" },
    ]);
  });

  it("drops the brackets when the reading just respells the word", () => {
    expect(splitRuby("ネコ（ねこ）")).toEqual([{ base: "ネコ（ねこ）" }]);
  });
});

describe("splitRuby — readings that annotate nothing", () => {
  it("drops a reading that repeats the kana word in front of it", () => {
    expect(splitRuby("〜ておく（ておく）を使います")).toEqual([
      { base: "〜ておくを使います" },
    ]);
  });

  it("keeps a bracketed kana that is not the same word", () => {
    // A dictionary form beside a conjugated one is a gloss, not a repeat.
    expect(splitRuby("あります（ある）")).toEqual([{ base: "あります（ある）" }]);
  });
});
