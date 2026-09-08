import { describe, expect, it } from "vitest";

import { archetypes, blueprint } from "@/lib/paper-format";
import type { Quiz, QuizItem, QuizSection } from "@/lib/quiz";
import { itemFault, tidyQuiz, validateQuiz } from "@/lib/quiz-validate";

function item(overrides: Partial<QuizItem> = {}): QuizItem {
  return {
    type: "multiple_choice",
    question: "学校（　）行きます。",
    choices: ["に", "を", "が"],
    answer: "に",
    explanation: "Direction takes に.",
    review: "Topic 4 — particles (p. 60)",
    ...overrides,
  } as QuizItem;
}

function section(overrides: Partial<QuizSection> = {}): QuizSection {
  return {
    instruction_ja: "正しいほうを選んでください。",
    instruction_en: "Choose the correct one.",
    form: "lettered",
    items: [],
    ...overrides,
  } as QuizSection;
}

describe("content validity", () => {
  it("rejects an answer that is not among its own options", () => {
    // The commonest way a schema-valid paper becomes unanswerable: the
    // student is shown three options and none of them is right.
    const fault = itemFault(item({ answer: "へ" }), section());
    expect(fault).toMatch(/not among the options/);
  });

  it("rejects duplicated options", () => {
    expect(itemFault(item({ choices: ["に", "に", "が"] }), section())).toMatch(/duplicate/);
  });

  it("rejects an option that matches the answer twice over", () => {
    // 「食べます」 listed beside 「食べます（たべます）」 is one option printed
    // twice, and both would mark correct.
    const fault = itemFault(
      item({ choices: ["に", "に（に）", "が"], answer: "に" }),
      section(),
    );
    expect(fault).not.toBeNull();
  });

  it("accepts a well-formed choice item", () => {
    expect(itemFault(item(), section())).toBeNull();
  });

  it("rejects empty required text", () => {
    expect(itemFault(item({ explanation: "  " }), section())).toMatch(/explanation/);
    expect(itemFault(item({ review: "" }), section())).toMatch(/review/);
  });

  it("rejects a review that points at the machinery", () => {
    // A student owns the textbook and nothing else; "see the past paper" is
    // not a place they can go.
    for (const review of ["see the past paper", "Material 3", "the excerpt above"]) {
      expect(itemFault(item({ review }), section()), review).toMatch(/machinery/);
    }
  });

  it("does not mistake a real topic for a reference to the machinery", () => {
    // "resources" contains "source". Seen on a live paper: a good item
    // rejected for a review reading 「Topic 8 — library resources and
    // location」, which is precisely what Topic 8 is about.
    // Note the standalone word still fails, and should: "the source" is what
    // the rule is for. What must not fail is a word that merely contains it.
    for (const review of [
      "Topic 8 — library resources and location (p. 112)",
      "Topic 3 — course materials 12 (p. 30)",
      "Topic 6 — resourceful vocabulary (p. 70)",
    ]) {
      expect(itemFault(item({ review }), section()), review).toBeNull();
    }
  });
});

describe("format validity", () => {
  it("rejects an option count the paper does not print", () => {
    // The a〜c sections print three. Four options is a different section of
    // a different paper.
    const archetype = blueprint("F2", "grammar").find((a) => a.id === "f2g_bracket")!;
    const fault = itemFault(
      item({ choices: ["に", "を", "が", "で"], answer: "に" }),
      section(),
      archetype,
    );
    expect(fault).toMatch(/4 options where the paper prints 2 or 3/);
  });

  it("accepts the count the paper does print", () => {
    const archetype = blueprint("F2", "grammar").find((a) => a.id === "f2g_bracket")!;
    expect(itemFault(item(), section(), archetype)).toBeNull();
  });

  it("accepts either count where the papers print both", () => {
    // The in-place bracket runs to two options on the Topic 9 paper and three
    // on the Topic 11 one. Insisting on the plan's count rejected an item for
    // a fault the course itself commits, and those were good questions.
    const archetype = blueprint("F2", "grammar").find((a) => a.id === "f2g_bracket")!;
    expect(archetype.choiceCounts).toEqual([2, 3]);
    const two = item({ choices: ["まで", "までに"], answer: "までに" });
    expect(itemFault(two, section(), archetype)).toBeNull();
  });

  it("requires a question word in the question-word section", () => {
    // Seen on a paper generated in development: a 〜てもいいですか item filed
    // under 「正しい疑問詞をひらがなで書いてください」. It is a good question and
    // it is not this section's question, so the instruction above it asks the
    // student for something the sentence does not want.
    const archetype = archetypes("F2", "grammar").find((a) => a.id === "f2g_question_word")!;
    const written = section({ form: "written" });
    const wrong = item({
      type: "fill_blank",
      choices: undefined,
      question: "Q：部屋でたばこを（　）てもいいですか。 A：はい、いいですよ。",
      answer: "すっ",
    });
    expect(itemFault(wrong, written, archetype)).toMatch(/question-word item answered/);
    expect(itemFault({ ...wrong, answer: "どこ" }, written, archetype)).toBeNull();
  });

  it("requires kanji in the write-it-in-kanji section", () => {
    // Seen on a paper generated in the Docker image: 「このまちはとても
    // （ しずか ）です。」 answered しずか, under an instruction that says to
    // write the hiragana in kanji. It gives the answer away AND marks 静か —
    // the answer the section asked for — wrong.
    const archetype = archetypes("F2", "kanji").find((a) => a.id === "f2k_word_bank")!;
    const written = section({ form: "written", word_bank: ["しずか", "ノート"] });
    const base = item({ type: "fill_blank", choices: undefined });
    expect(itemFault({ ...base, answer: "しずか" }, written, archetype)).toMatch(/answered in kana/);
    // With the reading supplied, the answer can be matched to its bank entry
    // across the script change the section is built on.
    expect(
      itemFault({ ...base, answer: "静か", answer_kana: "しずか" }, written, archetype),
    ).toBeNull();
    // Without one there is nothing to compare, so the bank rule stands down
    // and the kanji rule carries the section.
    expect(itemFault({ ...base, answer: "静か" }, written, archetype)).toBeNull();
    // The instruction says katakana is written as it is, so a loanword answer
    // is correct exactly as the bank prints it.
    expect(itemFault({ ...base, answer: "ノート" }, written, archetype)).toBeNull();
    // And so does a Latin acronym: the course writes DVD, CD and ATM the way
    // everyone else does, and a live paper's bank held DVD.
    const latin = section({ form: "written", word_bank: ["DVD", "しずか"] });
    expect(itemFault({ ...base, answer: "DVD" }, latin, archetype)).toBeNull();
  });

  it("requires ○ or × for a mark-the-statement item", () => {
    const maru = section({ form: "maru_batsu" });
    const statement = item({ type: "true_false", choices: undefined, answer: "はい" });
    expect(itemFault(statement, maru)).toMatch(/○×/);
    expect(itemFault({ ...statement, answer: "○" }, maru)).toBeNull();
    expect(itemFault({ ...statement, answer: "×" }, maru)).toBeNull();
  });

  it("rejects a ○× item that also carries options", () => {
    const fault = itemFault(
      item({ type: "true_false", answer: "○", choices: ["○", "×"] }),
      section({ form: "maru_batsu" }),
    );
    expect(fault).toMatch(/carries choices/);
  });

  it("rejects a written item that carries options", () => {
    const fault = itemFault(
      item({ type: "fill_blank", answer: "行きます", choices: ["行きます", "来ます"] }),
      section({ form: "written" }),
    );
    expect(fault).toMatch(/carries choices/);
  });
});

describe("word-bank sections", () => {
  const bank = section({
    form: "written",
    word_bank: ["行きます", "食べます", "帰ります", "見ます"],
  });

  it("accepts an answer that is a conjugated bank word", () => {
    // The bank prints dictionary forms and the answer is whatever form the
    // sentence needs, so they share a stem and little else.
    for (const answer of ["行った", "行って", "食べたい", "帰る"]) {
      expect(
        itemFault(item({ type: "fill_blank", choices: undefined, answer }), bank),
        answer,
      ).toBeNull();
    }
  });

  it("rejects an answer from no word in the bank", () => {
    const fault = itemFault(
      item({ type: "fill_blank", choices: undefined, answer: "およぎます" }),
      bank,
    );
    expect(fault).toMatch(/not a form of any word in the bank/);
  });

  it("enforces the paper's rule that a bank word is used once", () => {
    // 「ことばは1回しか使えません」 is printed on the section, and a paper that
    // answers two items with 行きます has broken its own instruction.
    const quiz: Quiz = {
      scope_description: "x",
      sections: [
        {
          ...bank,
          items: [
            item({ type: "fill_blank", choices: undefined, answer: "行きます" }),
            item({ type: "fill_blank", choices: undefined, answer: "行った" }),
            item({ type: "fill_blank", choices: undefined, answer: "食べます" }),
          ],
        },
      ],
    };
    const { quiz: checked, rejected } = validateQuiz(quiz);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatch(/used once was used twice/);
    expect(checked.sections[0].items).toHaveLength(2);
  });
});

describe("validateQuiz", () => {
  it("keeps a good paper untouched", () => {
    const quiz: Quiz = {
      scope_description: "x",
      sections: [{ ...section(), items: [item(), item({ question: "本（　）読みます。" })] }],
    };
    const { quiz: checked, rejected } = validateQuiz(quiz);
    expect(rejected).toEqual([]);
    expect(checked.sections[0].items).toHaveLength(2);
  });

  it("drops a section left empty, so the route sees a short paper", () => {
    // A wholly invalid section must make the paper read as short, because
    // that is what sends the request to the next provider.
    const quiz: Quiz = {
      scope_description: "x",
      sections: [{ ...section(), items: [item({ answer: "へ" })] }],
    };
    expect(validateQuiz(quiz).quiz.sections).toHaveLength(0);
  });

  it("reports where each rejection came from", () => {
    const quiz: Quiz = {
      scope_description: "x",
      sections: [{ ...section(), items: [item(), item({ answer: "へ" })] }],
    };
    const { rejected } = validateQuiz(quiz);
    expect(rejected[0]).toMatchObject({ section: 0, item: 1 });
    expect(rejected[0].reason).toBeTruthy();
  });
});

describe("tidyQuiz", () => {
  // Every case here was produced by a live generation, not imagined.
  const bracket = section({ form: "bracket" });

  it("removes the options the model inlined into its own sentence", () => {
    // Seen live: 「きょうは テスト（ が / を / に ） あります。」 with the same
    // three options also supplied in `choices`, so the app printed the bracket
    // twice — once from the text and once from its own renderer.
    const quiz: Quiz = {
      scope_description: "x",
      sections: [
        {
          ...bracket,
          items: [
            item({
              question: "きょうは テスト（ が / を / に ） あります。",
              choices: ["が", "を", "に"],
              answer: "が",
            }),
          ],
        },
      ],
    };
    const { quiz: fixed, tidied } = tidyQuiz(quiz);
    expect(tidied).toBeGreaterThan(0);
    expect(fixed.sections[0].items[0].question).toBe("きょうは テスト（　） あります。");
    // The options themselves survive — the app still needs them to render.
    expect(fixed.sections[0].items[0].choices).toEqual(["が", "を", "に"]);
  });

  it("strips a label the model wrote onto its own option", () => {
    // Seen live: choices came back as "a. りんごを…", and the renderer adds
    // its own letter, so the student read "a. a. りんごを…".
    const quiz: Quiz = {
      scope_description: "x",
      sections: [
        {
          ...section(),
          items: [
            item({
              choices: ["a. りんごを食べました", "b. たくさん食べました", "c. 何も食べません"],
              answer: "a. りんごを食べました",
            }),
          ],
        },
      ],
    };
    const fixed = tidyQuiz(quiz).quiz.sections[0].items[0];
    expect(fixed.choices).toEqual([
      "りんごを食べました",
      "たくさん食べました",
      "何も食べません",
    ]);
    // The answer is re-pointed at the stripped option, or the item would fail
    // validation for an answer that is no longer among its choices.
    expect(fixed.answer).toBe("りんごを食べました");
    expect(itemFault(fixed, section())).toBeNull();
  });

  it("drops the worked example, which is not a question", () => {
    // Seen live: 「例）まいにち 日本語を（　）ます。 → はなします」 arrived as
    // item (1) of the word-bank section, answer and all.
    const quiz: Quiz = {
      scope_description: "x",
      sections: [
        {
          ...section({ form: "written" }),
          items: [
            item({ question: "例）日本語を（　）ます。→ はなします", choices: undefined }),
            item({ question: "こうじょうで（　）ます。", choices: undefined, answer: "はたらいて" }),
          ],
        },
      ],
    };
    const { quiz: fixed } = tidyQuiz(quiz);
    expect(fixed.sections[0].items).toHaveLength(1);
    expect(fixed.sections[0].items[0].question).toBe("こうじょうで（　）ます。");
  });

  it("leaves a clean paper exactly as it was", () => {
    const quiz: Quiz = {
      scope_description: "x",
      sections: [{ ...section(), items: [item()] }],
    };
    const { quiz: fixed, tidied } = tidyQuiz(quiz);
    expect(tidied).toBe(0);
    expect(fixed.sections[0].items[0]).toMatchObject({ question: item().question });
  });

  it("does not strip a bracket that is not the item's own options", () => {
    // 「(reason) を 2つ書いてください」 — a bracket that happens to be in the
    // sentence but has nothing to do with the choices.
    const quiz: Quiz = {
      scope_description: "x",
      sections: [
        {
          ...bracket,
          items: [
            item({ question: "りゆう (reason) を書いてください。", choices: ["が", "を", "に"] }),
          ],
        },
      ],
    };
    expect(tidyQuiz(quiz).quiz.sections[0].items[0].question).toBe(
      "りゆう (reason) を書いてください。",
    );
  });
});

describe("tidyQuiz: numbering the app already prints", () => {
  it("strips a number the model wrote in front of its own question", () => {
    // Seen live: 「(1) 1. 毎日【部屋】をそうじします。」 — the app's number and
    // the model's, one after the other.
    const quiz: Quiz = {
      scope_description: "x",
      sections: [
        {
          ...section({ form: "written" }),
          items: [
            item({ question: "1. 毎日【部屋】をそうじします。", choices: undefined, answer: "へや" }),
            item({ question: "(2) でんきを消します。", choices: undefined, answer: "けします" }),
          ],
        },
      ],
    };
    const fixed = tidyQuiz(quiz).quiz.sections[0].items.map((i) => i.question);
    expect(fixed).toEqual(["毎日【部屋】をそうじします。", "でんきを消します。"]);
  });

  it("collapses a gap the model bracketed twice", () => {
    // Seen live: 「（ （　） ）」, the model's own answer bracket around the
    // blank the sentence already had.
    const quiz: Quiz = {
      scope_description: "x",
      sections: [
        {
          ...section({ form: "written" }),
          items: [item({ question: "部屋の【中】はあついです。（ （　） ）", choices: undefined, answer: "なか" })],
        },
      ],
    };
    expect(tidyQuiz(quiz).quiz.sections[0].items[0].question).toBe(
      "部屋の【中】はあついです。（　）",
    );
  });

  it("does not strip a number that is part of the sentence", () => {
    // 「10時までにごみを出してください」 opens with a number that belongs to
    // the question, not to its numbering.
    const quiz: Quiz = {
      scope_description: "x",
      sections: [
        {
          ...section({ form: "written" }),
          items: [item({ question: "10時までにごみを出してください。", choices: undefined, answer: "までに" })],
        },
      ],
    };
    expect(tidyQuiz(quiz).quiz.sections[0].items[0].question).toBe(
      "10時までにごみを出してください。",
    );
  });
});
