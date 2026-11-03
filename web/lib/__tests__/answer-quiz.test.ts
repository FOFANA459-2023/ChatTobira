import { describe, expect, it } from "vitest";

import { parseAnswer, type AnswerBlock, type QuizQuestion } from "@/lib/answer";

/** Questions the student answers on the screen.
 *
 * A separate file from answer.test.ts because almost every case here is
 * about one thing that file never has to think about: the answer key is in
 * the text being parsed, and a parse that gives up halfway prints it. The
 * parser runs on every streamed frame, so "halfway" is the normal state.
 *
 * The fence is written as a constant throughout. A literal ``` inside a
 * template literal needs escaping, and an escaped fence in a test is a test
 * nobody can read against the model output it stands for.
 */
const F = "```";

const quiz = (markdown: string): QuizQuestion[] => {
  const block = parseAnswer(markdown).find(
    (b): b is Extract<AnswerBlock, { kind: "quiz" }> => b.kind === "quiz",
  );
  return block?.questions ?? [];
};

/** What the prompt asks the model for, as it arrives. */
const ONE = [
  `${F}quiz`,
  "Q: 友達に写真を見せて（　）。",
  "- [ ] あげました",
  "- [x] もらいました",
  "- [ ] くれました",
  "E: 「もらう」 takes 〜に for the person you received the favour from.",
  F,
].join("\n");

describe("a question block", () => {
  it("reads the question, the options and which one is the answer", () => {
    expect(quiz(ONE)).toEqual([
      {
        prompt: "友達に写真を見せて（　）。",
        choices: [
          { text: "あげました", correct: false },
          { text: "もらいました", correct: true },
          { text: "くれました", correct: false },
        ],
        explanation: "「もらう」 takes 〜に for the person you received the favour from.",
      },
    ]);
  });

  it("leaves the prose around it alone", () => {
    const blocks = parseAnswer(`Let's check that.\n\n${ONE}\n\nTell me which were hard.`);
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "quiz", "paragraph"]);
  });

  it("never renders the markup as text, whatever else it does", () => {
    // The one guarantee worth stating on its own: nothing in this block may
    // reach the page as characters. "[x]" on screen is the answer, given away.
    for (const block of parseAnswer(ONE)) {
      expect(JSON.stringify(block)).not.toContain("[x]");
      expect(JSON.stringify(block)).not.toContain(F);
    }
  });

  it("takes as many questions in one block as the model writes", () => {
    const five = [
      `${F}quiz`,
      ...[1, 2, 3, 4, 5].flatMap((n) => [
        `Q: question ${n}`,
        "- [x] right",
        "- [ ] wrong",
        `E: because ${n}`,
      ]),
      F,
    ].join("\n");
    expect(quiz(five)).toHaveLength(5);
  });

  it("joins blocks written back to back, which is one set of questions", () => {
    // Asked for three, models write three fences as often as one. Shown
    // apart they repeat the heading, restart the numbering at 1, and score
    // each question out of one.
    const three = [1, 2, 3]
      .flatMap((n) => [`${F}quiz`, `Q: question ${n}`, "- [x] right", "- [ ] wrong", F])
      .join("\n");
    const blocks = parseAnswer(three);
    expect(blocks.filter((b) => b.kind === "quiz")).toHaveLength(1);
    expect(quiz(three)).toHaveLength(3);
  });

  it("takes several blocks in one answer, with teaching between them", () => {
    const taught = [
      "First, the rule.",
      `${F}quiz`,
      "Q: one",
      "- [x] a",
      "- [ ] b",
      F,
      "Now the exception.",
      `${F}quiz`,
      "Q: two",
      "- [x] a",
      "- [ ] b",
      F,
    ].join("\n");
    expect(parseAnswer(taught).filter((b) => b.kind === "quiz")).toHaveLength(2);
  });
});

describe("whatever shape the student asked for", () => {
  it("takes two options, which is what true/false is", () => {
    const tf = [`${F}quiz`, "Q: 「見る」は五段動詞です。", "- [ ] ○", "- [x] ×", F].join("\n");
    expect(quiz(tf)[0].choices).toHaveLength(2);
    expect(quiz(tf)[0].choices[1].correct).toBe(true);
  });

  it("takes a question that needs a passage above it", () => {
    const passage = [
      `${F}quiz`,
      "きのう、母に手紙を書きました。",
      "Q: だれが手紙を書きましたか。",
      "- [x] わたし",
      "- [ ] 母",
      F,
    ].join("\n");
    expect(quiz(passage)[0].prompt).toBe("きのう、母に手紙を書きました。\nだれが手紙を書きましたか。");
  });

  it("works without the explanation line, since not every question needs one", () => {
    const bare = [`${F}quiz`, "Q: 日 is read…", "- [x] にち", "- [ ] がつ", F].join("\n");
    expect(quiz(bare)[0].explanation).toBeUndefined();
  });

  it("numbers and letters the options itself, whatever the model wrote", () => {
    // Asked not to, models still letter their options. The app prints the
    // letters, so a label left in the text reads as "a. b) に".
    const laid = [
      `${F}quiz`,
      "**Q:** 1. どちらですか。",
      "- [ ] a) に",
      "- [x] b) で",
      F,
    ].join("\n");
    expect(quiz(laid)[0].prompt).toBe("どちらですか。");
    expect(quiz(laid)[0].choices.map((c) => c.text)).toEqual(["に", "で"]);
  });
});

describe("a block that is still arriving", () => {
  /** Every prefix of a finished answer, which is every frame the student's
   * browser actually renders. */
  const prefixes = (markdown: string) =>
    markdown.split("\n").map((_, i, lines) => lines.slice(0, i + 1).join("\n"));

  it("shows no question until that question is finished", () => {
    // Four options are coming. A student who presses one of the first two is
    // answering a question that does not exist yet, and the app would mark
    // them against an answer key it has not been given.
    const partial = [`${F}quiz`, "Q: どれですか。", "- [ ] に", "- [ ] で"].join("\n");
    expect(quiz(partial)).toEqual([]);
  });

  it("shows the answer key to nobody at any point on the way", () => {
    for (const frame of prefixes(ONE)) {
      const text = parseAnswer(frame)
        .filter((b) => b.kind !== "quiz")
        .map((b) => JSON.stringify(b))
        .join("");
      expect(text).not.toContain("[x]");
      expect(text).not.toContain("もらいました");
    }
  });

  it("releases an earlier question while a later one is still being written", () => {
    const frame = [
      `${F}quiz`,
      "Q: one",
      "- [ ] a",
      "- [x] b",
      "E: because",
      "Q: two",
      "- [ ] a",
    ].join("\n");
    expect(quiz(frame).map((q) => q.prompt)).toEqual(["one"]);
  });

  it("releases the last question when the model forgets the closing fence", () => {
    // Its explanation is the signal: a question that has reached E: has
    // nothing left to arrive, so losing it to a missing fence would drop a
    // finished question for a punctuation slip.
    const unclosed = [`${F}quiz`, "Q: one", "- [x] a", "- [ ] b", "E: because"].join("\n");
    expect(quiz(unclosed)).toHaveLength(1);
  });
});

describe("a block the model wrote badly", () => {
  it("drops a question with nothing to choose between", () => {
    const thin = [`${F}quiz`, "Q: think about it", "- [x] yes", F].join("\n");
    expect(quiz(thin)).toEqual([]);
  });

  it("keeps a question whose answer was never ticked, for the renderer to disarm", () => {
    // Un-markable, not unreadable: the questions are still worth seeing, and
    // the renderer shows them with the buttons disabled rather than marking
    // a student against an answer nobody gave it.
    const untick = [`${F}quiz`, "Q: どれ", "- [ ] に", "- [ ] で", F].join("\n");
    expect(quiz(untick)[0].choices.every((c) => !c.correct)).toBe(true);
  });

  it("is a code block when it is a code block", () => {
    const code = [`${F}ts`, "const x = 1;", F].join("\n");
    expect(parseAnswer(code).map((b) => b.kind)).toEqual(["paragraph"]);
  });
});
