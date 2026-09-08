import { describe, expect, it } from "vitest";

import type { QuizItem } from "@/lib/quiz";
import {
  dropDuplicates,
  dropRepeats,
  fingerprint,
  isRepeat,
  looseSkeleton,
  SAME_FRAME,
  similarity,
  skeleton,
  skillKey,
} from "@/lib/quiz-signature";

function item(overrides: Partial<QuizItem>): QuizItem {
  return {
    type: "fill_blank",
    question: "",
    answer: "行きます",
    explanation: "x",
    review: "Topic 4 — 〜に行きます (p. 60)",
    ...overrides,
  } as QuizItem;
}

describe("skeletons", () => {
  it("collapses the parts a generator swaps to fake a new question", () => {
    // A name, a loanword and a number are all interchangeable: swapping them
    // changes nothing about what the question tests.
    expect(skeleton("田中さんは3時にパーティーへ行きます")).toBe(
      skeleton("山田さんは7時にレストランへ行きます"),
    );
  });

  it("keeps the words that carry the meaning", () => {
    expect(skeleton("学校へ行きます")).not.toBe(skeleton("病院へ行きます"));
  });

  it("strips furigana, markers and blanks", () => {
    expect(skeleton("図書館《としょかん》で本を【かりる】（　）")).toBe(
      skeleton("図書館で本をかりる"),
    );
  });

  it("collapses particles in the loose form", () => {
    // The case named in the requirement: に against へ in the same frame.
    expect(looseSkeleton("田中さんは学校に行きます")).toBe(
      looseSkeleton("田中さんは学校へ行きます"),
    );
  });
});

describe("similarity", () => {
  it("is 1 for identical text and 0 for nothing shared", () => {
    expect(similarity("あいうえお", "あいうえお")).toBe(1);
    expect(similarity("あいうえお", "かきくけこ")).toBe(0);
  });

  it("stays high when one noun is swapped", () => {
    // The trivial-noun swap: 学校 for 大学 in an otherwise identical frame.
    const a = looseSkeleton("まいにち学校へ行きます");
    const b = looseSkeleton("まいにち大学へ行きます");
    expect(similarity(a, b)).toBeGreaterThan(SAME_FRAME);
  });
});

describe("isRepeat", () => {
  const asked = fingerprint(
    item({ question: "田中さんは学校に（　）。", answer: "行きます", target: "〜へ行きます" }),
  );

  it("catches the same question asked again word for word", () => {
    expect(isRepeat(asked, [asked])).toBe(true);
  });

  it("catches the same point on the same frame with the name changed", () => {
    // "Do not simply substitute nouns, names, or numbers and call it a new
    // question" — this is that rule, enforced.
    const again = fingerprint(
      item({ question: "山田さんは学校へ（　）。", answer: "行きます", target: "〜へ行きます" }),
    );
    expect(isRepeat(again, [asked])).toBe(true);
  });

  it("lets a genuinely different question through", () => {
    const different = fingerprint(
      item({
        question: "つかれましたから、はやく（　）。",
        answer: "ねます",
        target: "〜から",
      }),
    );
    expect(isRepeat(different, [asked])).toBe(false);
  });

  it("keeps two questions apart when the particle is what is tested", () => {
    // に and へ in one frame are one frame — unless the particle IS the
    // answer, and then they are two questions with two answers.
    // The numbers differ, so the two are not word-for-word identical, but
    // the frame collapses digits and is therefore the same frame. Only the
    // expected answer keeps them apart — which is exactly why the answer is
    // part of the signature and not just the sentence.
    const ni = fingerprint(
      item({ question: "毎朝、7時（　）おきます。", answer: "に", target: "particles" }),
    );
    const de = fingerprint(
      item({ question: "毎朝、8時（　）べんきょうします。", answer: "で", target: "particles" }),
    );
    expect(isRepeat(de, [ni])).toBe(false);
  });

  it("does not treat every item sharing an answer as a repeat", () => {
    // に is the right answer to plenty of genuinely different questions.
    const first = fingerprint(
      item({ question: "7時（　）おきます。", answer: "に", target: "time particle" }),
    );
    const second = fingerprint(
      item({ question: "ともだち（　）あいます。", answer: "に", target: "time particle" }),
    );
    expect(isRepeat(second, [first])).toBe(false);
  });
});

describe("dropRepeats", () => {
  const paper = {
    sections: [
      {
        items: [
          item({ question: "毎日、私は学校へ（　）。", answer: "行きます", target: "〜へ行きます" }),
          item({ question: "毎日、私は大学へ（　）。", answer: "行きます", target: "〜へ行きます" }),
          item({ question: "つかれましたから、はやく（　）。", answer: "ねます", target: "〜から" }),
        ],
      },
    ],
  };

  it("removes the reworded repeat inside one paper", () => {
    const { quiz, removed } = dropRepeats(paper);
    expect(removed).toBe(1);
    expect(quiz.sections[0].items).toHaveLength(2);
  });

  it("removes what the student was asked last time", () => {
    // This is what makes "New Test" mean a new test across sittings, not
    // just within one page load. The history item differs from the paper's
    // first question only by the student's name — which is the whole point.
    const history = [
      fingerprint(
        item({ question: "毎日、リーさんは学校に（　）。", answer: "行きます", target: "〜へ行きます" }),
      ),
    ];
    const { quiz, removed } = dropRepeats(paper, history);
    expect(removed).toBe(1);
    const asked = quiz.sections.flatMap((s) => s.items).map((i) => i.question);
    expect(asked).not.toContain("毎日、私は学校へ（　）。");
    // The question that only shares the pattern is left alone: a different
    // noun in a different frame is a different question.
    expect(asked).toContain("毎日、私は大学へ（　）。");
  });

  it("reports what it kept, so the history can be written", () => {
    const { kept } = dropRepeats(paper);
    expect(kept).toHaveLength(2);
    expect(kept[0].pattern).toContain("行きます");
  });

  it("drops a section left empty, so a repetitive paper reads as short", () => {
    const history = [fingerprint(paper.sections[0].items[2])];
    const { quiz } = dropRepeats(
      { sections: [{ items: [paper.sections[0].items[2]] }] },
      history,
    );
    expect(quiz.sections).toHaveLength(0);
  });

  it("is a no-op on a paper with nothing repeated", () => {
    const fresh = { sections: [{ items: [paper.sections[0].items[2]] }] };
    expect(dropRepeats(fresh).removed).toBe(0);
  });
});

describe("skill keys", () => {
  it("collapses the ways a generator names one point", () => {
    // The target is free text and the model writes it differently every time.
    // 「〜てから」, 「te-form + kara」 and 「sequence: the 〜てから pattern」 are
    // one grammar point under three labels, and a duplicate check that
    // compares them as strings sees three different questions.
    const keys = ["〜てから", "the 〜てから pattern", "grammar point: 〜てから (sequence)"].map(
      (target) => skillKey(item({ target })),
    );
    expect(new Set(keys).size).toBe(1);
  });

  it("keeps genuinely different points apart", () => {
    expect(skillKey(item({ target: "〜てから" }))).not.toBe(
      skillKey(item({ target: "〜たあとで" })),
    );
  });

  it("falls back to the answer when the target says nothing", () => {
    // A target made entirely of scaffolding words reduces to the empty
    // string, and every empty string would collide with every other.
    expect(skillKey(item({ target: "the verb form", answer: "たべます" }))).toBe("たべます");
    expect(skillKey(item({ target: "grammar", answer: "のみます" }))).toBe("のみます");
  });
});

describe("duplicates within one paper", () => {
  const paper = (...items: QuizItem[]) => ({
    sections: [{ items: items.slice(0, 1) }, { items: items.slice(1) }],
  });

  it("catches the same point drilled in two different sections", () => {
    // The repeat that actually happens. Section I drills 〜まえに, section III
    // drills it again with the shop changed to a station, and the generator
    // labels the second one differently and calls it new.
    const { quiz, removed } = dropDuplicates(
      paper(
        item({ question: "デパートで（　）まえに、ATMでお金をおろします。", target: "〜まえに" }),
        item({
          question: "電車に（　）まえに、きっぷをかいます。",
          target: "the 〜まえに pattern",
          answer: "のる",
        }),
      ),
    );
    expect(removed).toBe(1);
    expect(quiz.sections.flatMap((s) => s.items)).toHaveLength(1);
  });

  it("catches a sentence reused with the names and numbers changed", () => {
    // The requirement names this case by hand: changing only names, numbers
    // or minor wording does not make a new question. Note the two items claim
    // to test different things, so nothing but the sentence gives it away.
    const { quiz, removed } = dropDuplicates(
      paper(
        item({ question: "リーさんは7時に【おき】ます。", target: "〜ます form", answer: "おき" }),
        item({ question: "山田さんは9時に【おき】ます。", target: "polite present", answer: "おき" }),
      ),
    );
    expect(removed).toBe(1);
    expect(quiz.sections.flatMap((s) => s.items)).toHaveLength(1);
  });

  it("keeps two genuinely different questions", () => {
    const { removed } = dropDuplicates(
      paper(
        item({ question: "7時（　）おきます。", target: "に with a time", answer: "に" }),
        item({ question: "ともだち（　）あいます。", target: "に with a person", answer: "に" }),
      ),
    );
    expect(removed).toBe(0);
  });

  it("leaves ○× statements about one passage alone", () => {
    // Four statements about one text share a subject, a vocabulary and often
    // a clause. They are supposed to: that is what a reading section is.
    const statements = [
      "亀川駅から大分駅まで電車でいきます。",
      "大学から先生のうちまであるいていきます。",
      "大学から先生のうちまで20分かかります。",
    ].map((question) =>
      item({ type: "true_false", question, answer: "○", target: "reading comprehension" }),
    );
    expect(dropDuplicates({ sections: [{ items: statements }] }).removed).toBe(0);
  });

  it("leaves a one-word section alone", () => {
    // The katakana transcription section asks for one loanword an item, so
    // every frame collapses to the same single placeholder. Seen on a live
    // paper: three of its four items dropped as "the same sentence", and they
    // were report, computer and coffee.
    const words = ["report", "computer", "coffee", "video"].map((english) =>
      item({
        question: `${english} （　）`,
        answer: english,
        target: english,
      }),
    );
    expect(dropDuplicates({ sections: [{ items: words }] }).removed).toBe(0);
  });

  it("says why it dropped each item", () => {
    // A silent filter is one nobody can tune, and this one can shorten a
    // paper enough to fail the length gate.
    const { reasons } = dropDuplicates(
      paper(
        item({ question: "本を【よみ】ます。", target: "〜ます" }),
        item({ question: "本を【よみ】ます。", target: "〜ます" }),
      ),
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/already drilled|same sentence/);
  });

  it("drops a section left empty, so a repetitive paper reads as short", () => {
    const repeated = item({ question: "本を【よみ】ます。", target: "〜ます" });
    const { quiz } = dropDuplicates({
      sections: [{ items: [repeated] }, { items: [{ ...repeated }] }],
    });
    expect(quiz.sections).toHaveLength(1);
  });
});
