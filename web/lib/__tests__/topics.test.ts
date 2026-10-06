import { describe, expect, it } from "vitest";

import {
  aspectOf,
  divisionPattern,
  printedForms,
  sectionForAspect,
  wantsEverything,
  topicRefs,
} from "@/lib/topics";
import {
  broadenQuery,
  isThinResult,
  rankTopicPages,
  resolveQuery,
  type RetrievedChunk,
} from "@/lib/retrieval";

describe("topicRefs", () => {
  it("reads a division however the student writes it", () => {
    for (const text of ["topic 14", "Topic14", "T14", "トピック 14", "トピック14", "unit 14"]) {
      expect(topicRefs(text)[0]).toMatchObject({ marker: "T14", number: 14 });
    }
  });

  it("reads a lesson, which is what the Intermediate books call a division", () => {
    expect(topicRefs("lesson 3")[0]).toMatchObject({ number: 3, kind: "lesson" });
    expect(topicRefs("第3課")[0]).toMatchObject({ number: 3, kind: "lesson" });
  });

  it("finds the division inside a whole sentence", () => {
    expect(topicRefs("list all the vocabularies for topic 14")[0].marker).toBe("T14");
  });

  it("does not invent one", () => {
    expect(topicRefs("what does 忘れ物 mean?")).toEqual([]);
    expect(topicRefs("I have 40 minutes to study")).toEqual([]);
  });
});

describe("printedForms", () => {
  // Measured against the corpus: the Foundation 3 book prints 「トピック 14」
  // with a space on pp. 53–57. Searching for the un-spaced form finds nothing.
  it("includes the spelling the books actually print", () => {
    expect(printedForms({ marker: "T14", number: 14, kind: "topic" })).toContain("トピック 14");
  });

  it("uses 第N課 for a lesson", () => {
    expect(printedForms({ marker: "T3", number: 3, kind: "lesson" })).toContain("第3課");
  });
});

describe("aspectOf", () => {
  it("knows which part of a topic was asked for", () => {
    expect(aspectOf("list all the vocabularies for topic 14")?.label).toBe("vocabulary");
    expect(aspectOf("語彙を教えて")?.label).toBe("vocabulary");
    expect(aspectOf("what kanji are in topic 14")?.label).toBe("kanji");
    expect(aspectOf("the grammar points of topic 14")?.label).toBe("grammar");
    expect(aspectOf("tell me about topic 14")).toBeNull();
  });
});

describe("resolveQuery — carrying a division across turns", () => {
  const conversation = [
    { role: "user", text: "list all the vocabularies for topic 14" },
    { role: "assistant", text: "I could not find that." },
    { role: "user", text: "i mean topic 14" },
    { role: "assistant", text: "I still cannot find it." },
    { role: "user", text: "yes i know it is in foundation 3" },
  ];

  it("keeps the division after the student stops repeating it", () => {
    // The final message names no topic at all. Losing it here is what made
    // the app answer "I still can't find it" three times running.
    expect(resolveQuery(conversation).topics[0]).toMatchObject({ marker: "T14" });
  });

  it("resolves against the real question, not the last nudge", () => {
    const query = resolveQuery(conversation);
    expect(query.isFollowUp).toBe(true);
    expect(query.text).toContain("list all the vocabularies for topic 14");
  });

  it("finds the division in the first message too", () => {
    expect(resolveQuery([conversation[0]]).topics[0]).toMatchObject({ marker: "T14" });
  });
});

function chunk(over: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunk_id: 1,
    document_id: 1,
    doc_title: "Foundation 3",
    doc_type: "textbook",
    is_citable: true,
    pdf_page: 10,
    book_page: "55",
    content: "…",
    metadata: {},
    score: 0,
    similarity: 0.8,
    ...over,
  };
}

describe("isThinResult", () => {
  it("is thin when nothing came back", () => {
    expect(isThinResult([])).toBe(true);
  });

  it("is thin when the best candidate is only the best of a bad set", () => {
    expect(isThinResult([chunk({ similarity: 0.5 }), chunk({ similarity: 0.45 })])).toBe(true);
  });

  it("is not thin when something is genuinely close", () => {
    expect(isThinResult([chunk({ similarity: 0.75 })])).toBe(false);
  });

  it("is not thin when a page literally contains what was named", () => {
    expect(isThinResult([chunk({ similarity: 0, exact: true })])).toBe(false);
  });
});

describe("broadenQuery", () => {
  it("asks again in the words the corpus is written in", () => {
    const broadened = broadenQuery(
      "list all the vocabularies for topic 14",
      topicRefs("topic 14"),
      aspectOf("list all the vocabularies for topic 14"),
    );
    expect(broadened).toContain("トピック 14");
    expect(broadened).toContain("語彙");
    // The scaffolding of the sentence is gone.
    expect(broadened).not.toContain("list all");
  });
});

describe("rankTopicPages", () => {
  const ref = { marker: "T14", number: 14, kind: "topic" as const };
  const page = (content: string, is_citable = true) => ({ content, documents: { is_citable } });

  it("puts the page that belongs to the topic above one that mentions it", () => {
    const ranked = rankTopicPages(
      [
        page("see also トピック 14 for related vocabulary".padStart(200, "x")),
        page("トピック 14 新しい語彙 Nouns 形 shape 三角 triangle"),
      ],
      ref,
      aspectOf("vocabulary"),
    );
    expect(ranked[0].content).toContain("新しい語彙");
  });

  it("prefers the part of the topic the student asked for", () => {
    const ranked = rankTopicPages(
      [
        page("トピック 14 漢字 practice writing 短い"),
        page("トピック 14 新しい語彙 vocabulary list"),
      ],
      ref,
      aspectOf("what vocabulary is in topic 14"),
    );
    expect(ranked[0].content).toContain("語彙");
  });

  it("prefers the textbook over a handout when nothing else separates them", () => {
    const ranked = rankTopicPages(
      [page("トピック 14 notes", false), page("トピック 14 notes", true)],
      ref,
      null,
    );
    expect(ranked[0].documents.is_citable).toBe(true);
  });
});

describe("aspectOf — kanji and vocabulary named together", () => {
  // The question that exposed this: "list topic 7 kanji vocab" was read as
  // the aspect "vocabulary", so the pages chosen were the front half's word
  // lists, which carry no kanji table — and the answer said Topic 7 has no
  // kanji list printed on its pages. It has four pages of them.
  it("reads a kanji vocabulary question as kanji", () => {
    for (const text of [
      "list topic 7 kanji vocab",
      "topic 7 kanji vocabulary",
      "topic 7 kanji vocab list",
      "lesson 5 kanji vocabulary",
      "漢字の語彙を教えて",
    ]) {
      expect(aspectOf(text)?.label).toBe("kanji");
    }
  });

  it("still reads a plain vocabulary question as vocabulary", () => {
    expect(aspectOf("list all the vocabularies for topic 14")?.label).toBe("vocabulary");
    expect(aspectOf("topic 7 vocabulary")?.label).toBe("vocabulary");
    expect(aspectOf("語彙を教えて")?.label).toBe("vocabulary");
  });
});

describe("sectionForAspect", () => {
  it("sends a kanji question to the kanji half and grammar to the front", () => {
    expect(sectionForAspect(aspectOf("topic 7 kanji"))).toBe("kanji");
    expect(sectionForAspect(aspectOf("topic 7 grammar"))).toBe("grammar");
    expect(sectionForAspect(aspectOf("topic 7 reading"))).toBe("grammar");
  });

  it("leaves a plain vocabulary question to be decided on the words", () => {
    // Both halves are honestly vocabulary: the front prints 新しい語彙 and the
    // back is titled 漢字・語彙練習.
    expect(sectionForAspect(aspectOf("topic 7 vocabulary"))).toBeNull();
    expect(sectionForAspect(null)).toBeNull();
  });
});

describe("divisionPattern", () => {
  const matches = (ref: Parameters<typeof divisionPattern>[0], text: string) =>
    new RegExp(divisionPattern(ref)).test(text);
  const topic = (number: number) => ({ marker: `T${number}`, number, kind: "topic" as const });

  it("matches every spelling the books print", () => {
    for (const text of ["トピック 7 何が好きですか", "トピック7", "Topic 7 何が好きですか", "Topic7 はじめまして", "T7 G1"]) {
      expect(matches(topic(7), text)).toBe(true);
    }
  });

  it("does not let Topic 1 match Topic 10 through Topic 20", () => {
    // Measured on the live corpus before the guard: 304 chunks matched the
    // Topic 1 forms and 26 were Topic 1. On Foundation 3, which carries
    // topics 11-20, not one chunk matching 「トピック 1」 was Topic 1.
    for (const n of [10, 14, 17, 20]) {
      expect(matches(topic(1), `トピック ${n} バッグを忘れてしまいました`)).toBe(false);
      expect(matches(topic(1), `Topic ${n} どうしましたか`)).toBe(false);
    }
    expect(matches(topic(1), "トピック 1 はじめまして")).toBe(true);
    expect(matches(topic(2), "Topic 20 プレゼンテーション")).toBe(false);
  });

  it("does not let the bare T-number match the tail of another token", () => {
    expect(matches(topic(7), "NT7")).toBe(false);
    expect(matches(topic(7), "〈NT〉で活動します")).toBe(false);
  });

  it("matches a lesson the way the Intermediate books print it", () => {
    const lesson = { marker: "T5", number: 5, kind: "lesson" as const };
    expect(matches(lesson, "第5課 先輩からのメッセージ")).toBe(true);
    expect(matches(lesson, "第 5 課")).toBe(true);
    expect(matches(lesson, "Lesson 5")).toBe(true);
    expect(matches(lesson, "第15課")).toBe(false);
  });
});

describe("rankTopicPages — choosing the half of the book that was asked for", () => {
  const ref = { marker: "T7", number: 7, kind: "topic" as const };
  const page = (content: string, section: "grammar" | "kanji") => ({
    content,
    document_id: 5,
    documents: { is_citable: true },
    section,
  });

  it("puts the kanji half first for a kanji question", () => {
    // Both pages print the same running header and both are citable textbook
    // pages, and the front half says "kanji" too — which is why counting the
    // aspect's words alone used to rank them level, and the front half won on
    // being earlier in the book.
    const ranked = rankTopicPages(
      [
        page("Topic 7 何が好きですか\n# New vocabulary\n## Verbs\n…check the following kanji 漢字", "grammar"),
        page("Topic 7 何が好きですか\n## I. Kanji Reading and Writing\n| 5 | 鳥 | とり |", "kanji"),
      ],
      ref,
      aspectOf("list topic 7 kanji vocab"),
      "kanji",
    );
    expect(ranked[0].section).toBe("kanji");
  });

  it("puts the front half first for a grammar question", () => {
    const ranked = rankTopicPages(
      [
        page("Topic 7\n## Ⅱ. Katakana Words\n| チョコレート | chocolate |", "kanji"),
        page("Topic 7 何が好きですか\n6. Noun + にします\nします usually means to do…", "grammar"),
      ],
      ref,
      aspectOf("topic 7 grammar"),
      "grammar",
    );
    expect(ranked[0].section).toBe("grammar");
  });

  it("ranks a contents page below the pages that teach the topic", () => {
    const ranked = rankTopicPages(
      [
        page("# 目次 Contents\n## Topic 7 何が好きですか 94\n**Grammar**: 1. ～ませんか", "grammar"),
        page("Topic 7 何が好きですか\n## I. Kanji Reading and Writing\n| 5 | 鳥 | とり |", "kanji"),
      ],
      ref,
      aspectOf("topic 7 kanji"),
      "kanji",
    );
    expect(ranked[0].section).toBe("kanji");
    expect(ranked[1].content).toContain("目次");
  });

  it("is unchanged when nobody said which half", () => {
    const ranked = rankTopicPages(
      [page("Topic 7 notes", "kanji"), page("Topic 7 新しい語彙 vocabulary", "grammar")],
      ref,
      aspectOf("topic 7 vocabulary"),
      null,
    );
    expect(ranked[0].content).toContain("語彙");
  });
});

describe("topicRefs — a span of topics", () => {
  const markers = (text: string) => topicRefs(text).map((r) => r.marker);

  it("reads a range as every division inside it", () => {
    // "list all topic 11 to 17 verbs" used to search Topic 11 and stop. Six
    // sevenths of the question was never looked up, and the model filled the
    // gap from its own Japanese rather than from the book.
    expect(markers("list all topic 11 to 17 verbs and their te forms")).toEqual([
      "T11", "T12", "T13", "T14", "T15", "T16", "T17",
    ]);
  });

  it("reads every connector the students type", () => {
    for (const text of [
      "topic 11-14",
      "topic 11 – 14",
      "topics 11 through 14",
      "topic 11 to 14",
      "トピック11〜14",
      "トピック11から14",
    ]) {
      expect(markers(text)).toEqual(["T11", "T12", "T13", "T14"]);
    }
  });

  it("keeps a lesson range a lesson range", () => {
    const refs = topicRefs("lesson 3 to 6 kanji");
    expect(refs.map((r) => r.marker)).toEqual(["T3", "T4", "T5", "T6"]);
    expect(refs.every((r) => r.kind === "lesson")).toBe(true);
  });

  it("refuses a span wide enough to be the whole corpus", () => {
    // Ten divisions is every topic in a Foundation book. Past that it is not
    // a revision scope, and sweeping thirty topics into one prompt answers
    // nothing well.
    expect(markers("topic 1 to 30 everything")).toEqual(["T1"]);
  });

  it("still reads separate mentions separately", () => {
    expect(markers("I studied topic 3 and topic 9 last week")).toEqual(["T3", "T9"]);
    expect(markers("topic 14")).toEqual(["T14"]);
  });
});

describe("aspectOf — a request about typesetting is not a request for kanji", () => {
  it("ignores a furigana instruction when choosing the aspect", () => {
    // The word kanji is in this question only to say how to set the answer.
    // Read as the aspect, it sent a verb-list question to the stroke-order
    // tables in the back half of the book.
    expect(aspectOf("list all topic 11 to 17 verbs and their te forms. add furagana to their kanji")).toBeNull();
    expect(aspectOf("topic 7 vocabulary with furigana")?.label).toBe("vocabulary");
    expect(aspectOf("ふりがなをつけてください。トピック7の語彙")?.label).toBe("vocabulary");
  });

  it("still hears an actual kanji question", () => {
    expect(aspectOf("topic 7 kanji")?.label).toBe("kanji");
    expect(aspectOf("list the kanji for lesson 5")?.label).toBe("kanji");
  });
});

describe("wantsEverything", () => {
  it("tells a complete list apart from a couple of examples", () => {
    expect(wantsEverything("list all topic 11 to 17 verbs")).toBe(true);
    expect(wantsEverything("every verb in topic 12")).toBe(true);
    expect(wantsEverything("トピック12の語彙を全部")).toBe(true);
    expect(wantsEverything("give me an example of 〜ておく")).toBe(false);
    expect(wantsEverything("what is the difference between に and で?")).toBe(false);
  });
});
