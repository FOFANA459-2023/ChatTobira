import { describe, expect, it } from "vitest";

import {
  levelGuidance,
  SPEAKABLE_LIMIT,
  SPEAKING_MODES,
  speakableText,
  speakingPrompt,
  speechSegments,
} from "@/lib/speech";

describe("speakableText", () => {
  it("drops furigana so a word is not read twice", () => {
    // 「漢字（かんじ）」 read aloud verbatim is the word, then the same word
    // again, with "bracket" and "close bracket" around it.
    expect(speakableText("漢字（かんじ）をべんきょうします。")).toBe(
      "漢字をべんきょうします。",
    );
    expect(speakableText("図書館《としょかん》へ行きます。")).toBe("図書館へ行きます。");
  });

  it("keeps kana that is not a reading", () => {
    // A bracket around kana is only furigana when it follows the word it
    // annotates; the app also prints ordinary parenthetical Japanese.
    expect(speakableText("テスト")).toBe("テスト");
    expect(speakableText("ひらがなで書いてください。")).toBe("ひらがなで書いてください。");
  });

  it("turns a Markdown table into something sayable", () => {
    const spoken = speakableText("| 食べる | たべる |\n| --- | --- |\n| 飲む | のむ |");
    expect(spoken).not.toContain("|");
    expect(spoken).not.toContain("---");
    expect(spoken).toContain("食べる");
    expect(spoken).toContain("飲む");
  });

  it("removes headings, bullets and emphasis", () => {
    const spoken = speakableText("## 語彙\n- **食べる** — to eat\n- 飲む — to drink");
    expect(spoken).not.toMatch(/[#*]/);
    expect(spoken).toContain("語彙");
    expect(spoken).toContain("食べる");
  });

  it("drops page references, which a listener cannot act on", () => {
    const spoken = speakableText("これはトピック14です。(see p. 55)");
    expect(spoken).not.toMatch(/p\.\s*55/);
    expect(spoken).toContain("トピック14です。");
  });

  it("strips the underline markers and answer rules", () => {
    expect(speakableText("きのう、すしを【食べる】＿＿＿。")).toBe("きのう、すしを食べる。");
  });

  it("cuts a long answer at a sentence end, never mid-clause", () => {
    const long = "これはテストです。".repeat(200);
    const spoken = speakableText(long);
    expect(spoken.length).toBeLessThanOrEqual(SPEAKABLE_LIMIT);
    expect(spoken.endsWith("。")).toBe(true);
  });

  it("returns nothing for text that was only layout", () => {
    expect(speakableText("| --- | --- |")).toBe("");
    expect(speakableText("   ")).toBe("");
  });
});

describe("speechSegments", () => {
  it("splits a bilingual answer so each half gets its own voice", () => {
    // The default answer in this app is English carrying Japanese terms. One
    // voice reading both mangles whichever it was not built for.
    const segments = speechSegments("The te-form is 食べて and it means eating.");
    expect(segments.map((s) => s.lang)).toContain("ja");
    expect(segments.map((s) => s.lang)).toContain("en");
    expect(segments.find((s) => s.lang === "ja")?.text).toContain("食べて");
  });

  it("keeps a whole Japanese sentence in one segment", () => {
    const segments = speechSegments("いいですね！京都では何をしましたか？");
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({
      text: "いいですね！京都では何をしましたか？",
      lang: "ja",
    });
  });

  it("does not start a new segment for a comma or a digit", () => {
    // Punctuation and numbers belong to the run they sit inside; splitting on
    // them would chop every sentence into fragments.
    const segments = speechSegments("毎日、7時に起きます。");
    expect(segments).toHaveLength(1);
  });

  it("drops empty runs", () => {
    expect(speechSegments("   ")).toEqual([]);
    expect(speechSegments("")).toEqual([]);
  });
});

describe("speaking modes", () => {
  it("offers every mode the architecture supports", () => {
    // All four exist so a new one is a prompt fragment, not a rewrite of the
    // voice pipeline.
    expect(Object.keys(SPEAKING_MODES)).toEqual(["free", "topic", "roleplay", "grammar"]);
  });

  it("says which modes are meaningless without a subject", () => {
    expect(SPEAKING_MODES.free.needsSubject).toBe(false);
    expect(SPEAKING_MODES.roleplay.needsSubject).toBe(true);
    expect(SPEAKING_MODES.grammar.needsSubject).toBe(true);
  });

  it("puts the subject into the instruction", () => {
    expect(SPEAKING_MODES.roleplay.instruction("レストランで")).toContain("レストランで");
    expect(SPEAKING_MODES.grammar.instruction("〜ながら")).toContain("〜ながら");
  });

  it("still reads sensibly with no subject given", () => {
    for (const mode of Object.values(SPEAKING_MODES)) {
      expect(mode.instruction(undefined)).not.toContain("undefined");
    }
  });
});

describe("levelGuidance", () => {
  it("holds Foundation 2 to what Foundation 2 teaches", () => {
    // A Foundation 2 student asked 「もう終わっておいたはずですよね？」 hears
    // noise, however natural the sentence is.
    const f2 = levelGuidance("F2");
    expect(f2).toContain("Foundation 2");
    expect(f2).toMatch(/ておく|てある|honorific/i);
    expect(f2).toMatch(/Do not reach for/i);
  });

  it("lets Foundation 3 use what Foundation 3 teaches", () => {
    const f3 = levelGuidance("F3");
    expect(f3).toContain("Foundation 3");
    expect(f3).toContain("〜かどうか");
  });

  it("has a sensible default when the profile records no level", () => {
    const none = levelGuidance(null);
    expect(none).toMatch(/not recorded/i);
    expect(none).not.toContain("undefined");
  });
});

describe("speakingPrompt", () => {
  it("makes the tutor a partner rather than an explainer", () => {
    const prompt = speakingPrompt("free", "F2");
    expect(prompt).toMatch(/CONVERSATION PARTNER/i);
    expect(prompt).toMatch(/Reply in Japanese/);
    expect(prompt).toMatch(/end with a question/);
  });

  it("bans the things a listener cannot follow", () => {
    const prompt = speakingPrompt("free", "F3");
    // Headings, bullets and tables are the written answer's whole shape, and
    // all of it is noise when read aloud.
    expect(prompt).toMatch(/No headings, no bullet lists, no tables/);
    expect(prompt).toMatch(/no page references/);
  });

  it("keeps the grounding invisible rather than cited", () => {
    // Requirement: the knowledge base influences the conversation naturally
    // instead of every reply naming a textbook.
    const prompt = speakingPrompt("free", "F2");
    expect(prompt).toMatch(/Do not quote the material, name a textbook, or cite a page/);
  });

  it("carries the level and the mode into the instruction", () => {
    const prompt = speakingPrompt("roleplay", "F3", "レストランで");
    expect(prompt).toContain("Foundation 3");
    expect(prompt).toContain("レストランで");
    expect(prompt).toMatch(/Stay in character/);
  });

  it("asks for correction without turning the conversation into a test", () => {
    const prompt = speakingPrompt("free", "F2");
    expect(prompt).toMatch(/Do not correct every sentence/);
    expect(prompt).toMatch(/Say nothing at all when they were fine/);
  });
});

describe("the speaking prompt inside the system prompt", () => {
  it("appears only when the turn arrived by voice", async () => {
    const { systemPrompt } = await import("@/lib/prompt");
    expect(systemPrompt({}, {})).not.toMatch(/CONVERSATION PARTNER/i);
    expect(
      systemPrompt({}, { speaking: { mode: "free", level: "F2" } }),
    ).toMatch(/CONVERSATION PARTNER/i);
  });

  it("comes last, so it wins where it contradicts the written rules", async () => {
    // The written tutor is told to lead with the answer and close by pointing
    // at a page; the partner is told to say two sentences and ask something
    // back. Both are in the prompt, and the closing instruction is the one a
    // model follows.
    const { systemPrompt } = await import("@/lib/prompt");
    const prompt = systemPrompt({}, { speaking: { mode: "free", level: "F3" } });
    expect(prompt.indexOf("SPEAKING PRACTICE")).toBeGreaterThan(prompt.indexOf("ANSWER THE QUESTION"));
    expect(prompt.trimEnd().endsWith("stops speaking.")).toBe(true);
  });

  it("keeps the grounding rules that still apply", async () => {
    // Nothing above is deleted: a student mid-conversation still asks real
    // questions, and those answers still have to come from the corpus.
    const { systemPrompt } = await import("@/lib/prompt");
    const prompt = systemPrompt({}, { speaking: { mode: "topic", level: "F2", subject: "買い物" } });
    expect(prompt).toMatch(/GROUNDING/);
    expect(prompt).toContain("買い物");
  });
});
