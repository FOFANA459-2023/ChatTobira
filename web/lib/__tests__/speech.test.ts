import { describe, expect, it } from "vitest";

import {
  levelGuidance,
  listenChunks,
  LISTEN_LIMIT,
  readyClauses,
  SPEAKABLE_LIMIT,
  SPEAKING_MODES,
  speakableText,
  speakingPrompt,
  sentences,
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

describe("sentences", () => {
  it("splits a reply so the first clause can play while the rest is made", () => {
    expect(
      sentences("京都では何をしましたか？わたしも去年、京都へ行きました。"),
    ).toEqual(["京都では何をしましたか？", "わたしも去年、京都へ行きました。"]);
  });

  it("will not send a clause too short for the voice to synthesise", () => {
    // Measured against the live service: 「いいですね！」 alone came back with
    // no audio at all. A clause shorter than a real sentence rides with the
    // next one instead of being sent on its own.
    expect(sentences("いいですね！京都では何をしましたか？")).toEqual([
      "いいですね！ 京都では何をしましたか？",
    ]);
  });

  it("splits English sentences too", () => {
    expect(sentences("That is right. What did you do there?")).toEqual([
      "That is right.",
      "What did you do there?",
    ]);
  });

  it("folds a bare acknowledgement into the sentence after it", () => {
    expect(sentences("はい。京都はとてもきれいな町ですね。")).toEqual([
      "はい。 京都はとてもきれいな町ですね。",
    ]);
  });

  it("keeps a single sentence whole", () => {
    expect(sentences("京都はとてもきれいな町ですね")).toEqual(["京都はとてもきれいな町ですね"]);
  });

  it("never returns nothing for text that had something in it", () => {
    expect(sentences("あ")).toEqual(["あ"]);
  });
});

describe("readyClauses", () => {
  // The rule that lets the voice start talking before the answer is finished.
  const reply = "いいですね！京都はきれいな町ですね。京都では何をしましたか？";

  it("holds back the clause that is still being written", () => {
    // Mid-stream the tail is not a sentence yet, it is the beginning of one.
    // Synthesising it would have the tutor say half a sentence and then say
    // the whole of it.
    expect(readyClauses("いいですね！京都はきれ", false, 0)).toEqual([]);
  });

  it("releases a clause as soon as something is written after it", () => {
    expect(readyClauses("いいですね！京都はきれいな町ですね。京都で", false, 0)).toEqual([
      "いいですね！ 京都はきれいな町ですね。",
    ]);
  });

  it("releases the last clause only when the stream says it is over", () => {
    const streaming = readyClauses(reply, false, 0);
    const finished = readyClauses(reply, true, 0);
    expect(finished.length).toBe(streaming.length + 1);
    expect(finished.at(-1)).toBe("京都では何をしましたか？");
  });

  it("never returns a clause twice, so nothing is paid for or heard twice", () => {
    const first = readyClauses(reply, false, 0);
    // Fed the same answer again with the same count consumed: nothing new.
    expect(readyClauses(reply, false, first.length)).toEqual([]);
    // And the end of the stream yields only what was actually held back.
    expect(readyClauses(reply, true, first.length)).toEqual(["京都では何をしましたか？"]);
  });

  it("says nothing for an answer with nothing speakable in it", () => {
    // A page reference exists only for the eye — a listener cannot act on
    // "see p. 112" — so speakableText leaves nothing behind and there is no
    // clause to send. The caller must not be left waiting for audio that is
    // never coming.
    expect(readyClauses("（see p. 112）", true, 0)).toEqual([]);
  });

  it("strips what is for the eye before deciding where a clause ends", () => {
    // Furigana is removed first, so the clause handed to the voice is the
    // clause it should say — 漢字 read once, not "kanji (kanji)".
    const [clause] = readyClauses(
      "漢字（かんじ）はむずかしいですが、おもしろいですよ。京都",
      false,
      0,
    );
    expect(clause).toBe("漢字はむずかしいですが、おもしろいですよ。");
  });
});

describe("listenChunks", () => {
  // A long bilingual answer of the shape the tutor writes: two dozen sentences.
  const long = Array.from(
    { length: 24 },
    (_, i) => `これは例文${i + 1}番です、とても大切なポイントです。This is note ${i + 1} about it.`,
  ).join(" ");

  it("opens with a short prefetchable piece, then a single sentence", () => {
    // The opening is prefetched while the student reads, and must play long
    // enough to hide the second, which is requested at the click and so is
    // kept to one sentence.
    const pieces = listenChunks(long);
    const all = sentencesOf(long);
    expect(pieces[0].startsWith(all[0])).toBe(true);
    expect(pieces[0].length).toBeLessThanOrEqual(60);
    expect(all).toContain(pieces[1]);
  });

  it("reads a long answer in a handful of requests, not one per sentence", () => {
    // The speech model allows ten requests a minute for the whole project.
    // One per sentence ran a long answer straight into that limit.
    const pieces = listenChunks(long);
    expect(sentencesOf(long).length).toBeGreaterThan(20);
    expect(pieces.length).toBeLessThanOrEqual(8);
  });

  it("never sends a piece the speech route would trim", () => {
    for (const piece of listenChunks(long)) expect(piece.length).toBeLessThanOrEqual(600);
  });

  it("loses no text between the pieces", () => {
    const joined = listenChunks(long).join(" ").replace(/\s+/g, "");
    expect(joined).toBe(sentencesOf(long).join(" ").replace(/\s+/g, ""));
  });

  it("reads well past the 600 characters a spoken reply is capped at", () => {
    // Pressing Listen asks for the answer; stopping at 600 was the voice that
    // "stops playing altogether" part way through.
    const total = listenChunks(long).join("").length;
    expect(long.length).toBeGreaterThan(600);
    expect(total).toBeGreaterThan(600);
    expect(total).toBeLessThanOrEqual(LISTEN_LIMIT);
  });
});

function sentencesOf(text: string): string[] {
  return sentences(speakableText(text, LISTEN_LIMIT));
}
