import { describe, expect, it } from "vitest";

import type { QuizItem } from "@/lib/quiz";
import {
  dropRepeats,
  fingerprint,
  isRepeat,
  looseSkeleton,
  SAME_FRAME,
  similarity,
  skeleton,
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
